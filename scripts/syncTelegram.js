// ═══════════════════════════════════════════════════════════
//  مزامنة تليجرام (@akaraqi10) → موقع الجملة — تشغيلة واحدة
//  يجيب فقط المنشورات الجديدة منذ آخر تشغيلة (عبر offset/update_id)
//  ويطلع من البرنامج فوراً — مصمم للتشغيل عبر GitHub Actions cron.
//  نفس فكرة مزامنة موقع الملابس (alfursan-telegram-bot/sync.js) بالضبط،
//  بس مبسّطة: السعر والمقاسات ما تنكتب نص — توضح داخل الصورة نفسها،
//  فما فيه استخراج أسعار هنا، بس اسم + وصف + تصنيف.
//  الصور/الفيديو ترفع لـ Cloudinary (مو Firebase Storage) لتفادي حد
//  التخزين المجاني بخطة Spark.
// ═══════════════════════════════════════════════════════════

const TelegramBot = require("node-telegram-bot-api");
const { initializeApp, cert } = require("firebase-admin/app");
const { getFirestore, FieldValue } = require("firebase-admin/firestore");

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const SOURCE_CHANNEL = process.env.SOURCE_CHANNEL_USERNAME || "akaraqi10"; // بدون @
const CLOUDINARY_CLOUD_NAME = process.env.CLOUDINARY_CLOUD_NAME;
const CLOUDINARY_UPLOAD_PRESET = process.env.CLOUDINARY_UPLOAD_PRESET;
const MAX_VIDEO_MB = 20; // حد تليجرام الرسمي لتحميل الملفات عبر getFile بالـ Bot API العادي

if (!BOT_TOKEN) { console.error("❌ لازم تحدد TELEGRAM_BOT_TOKEN كمتغير بيئة."); process.exit(1); }
if (!CLOUDINARY_CLOUD_NAME || !CLOUDINARY_UPLOAD_PRESET) {
  console.error("❌ لازم تحدد CLOUDINARY_CLOUD_NAME و CLOUDINARY_UPLOAD_PRESET.");
  process.exit(1);
}

let serviceAccount;
try {
  serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON);
} catch (err) {
  console.error("❌ ما قدرت أقرا FIREBASE_SERVICE_ACCOUNT_JSON:", err.message);
  process.exit(1);
}

initializeApp({ credential: cert(serviceAccount) });
const db = getFirestore();
const bot = new TelegramBot(BOT_TOKEN, { polling: false });

const STATE_DOC = db.collection("syncState").doc("wholesaleTelegramChannel");

const CATEGORY_WORDS = {
  "أحذية": ["حذاء", "احذية", "أحذية", "قندرة", "قندره", "بوت", "كعب", "سنيكرز"],
  "شحاطات": ["شحاطة", "شحاطه", "شحاطات", "سليبر", "سليبرات", "خف"],
  "حقائب": ["حقيبة", "حقيبه", "حقائب", "جنطة", "جنطه", "شنطة", "شنطه"],
};

async function main() {
  const stateSnap = await STATE_DOC.get();
  const lastUpdateId = stateSnap.exists ? Number(stateSnap.data().lastUpdateId) || 0 : 0;
  const offset = lastUpdateId + 1;

  console.log(`🔎 جلب التحديثات الجديدة من @${SOURCE_CHANNEL} (offset=${offset})...`);
  const updates = await bot.getUpdates({ offset, timeout: 0, allowed_updates: ["channel_post"] });

  if (!updates.length) {
    console.log("ℹ️ ماكو منشورات جديدة.");
    return;
  }
  console.log(`📥 وصل ${updates.length} تحديث جديد.`);

  const groups = new Map();
  const order = [];

  for (const update of updates) {
    const msg = update.channel_post;
    if (!msg) continue;
    if (msg.chat?.username !== SOURCE_CHANNEL) continue; // قناة غير المصدر، نتجاهلها

    const hasPhoto = Array.isArray(msg.photo) && msg.photo.length > 0;
    const hasVideo = !!msg.video;
    if (!hasPhoto && !hasVideo) continue;

    const groupId = msg.media_group_id || `single_${msg.message_id}`;
    if (!groups.has(groupId)) {
      groups.set(groupId, { photos: [], uniqueIds: [], video: null, caption: null });
      order.push(groupId);
    }
    const group = groups.get(groupId);

    if (hasPhoto) {
      const largest = msg.photo[msg.photo.length - 1];
      if (largest && largest.file_id) {
        const uid = largest.file_unique_id || largest.file_id;
        if (!group.uniqueIds.includes(uid)) {
          group.uniqueIds.push(uid);
          group.photos.push(largest.file_id);
        }
      }
    }

    if (hasVideo && !group.video) {
      const sizeMB = (msg.video.file_size || 0) / (1024 * 1024);
      if (sizeMB > MAX_VIDEO_MB) console.warn(`⚠️ الفيديو كبير جداً (${sizeMB.toFixed(1)}MB) — تم تخطيه.`);
      else group.video = msg.video.file_id;
    }

    if (msg.caption && msg.caption.trim()) group.caption = msg.caption.trim();
  }

  for (const groupId of order) {
    const group = groups.get(groupId);
    const mediaCount = group.photos.length + (group.video ? 1 : 0);
    if (!mediaCount) continue;
    await processGroup(group, mediaCount);
  }

  const highestUpdateId = updates[updates.length - 1].update_id;
  await STATE_DOC.set({ lastUpdateId: highestUpdateId, updatedAt: FieldValue.serverTimestamp() }, { merge: true });
  console.log(`✅ تم تحديث آخر معرف معالَج إلى ${highestUpdateId}.`);
}

async function processGroup(group, mediaCount) {
  const caption = group.caption || "";
  const fields = smartParse(caption);

  console.log(`⏳ معالجة: "${fields.name}" — ${group.photos.length} صورة${group.video ? " + فيديو" : ""}`);

  try {
    const imageUrls = [];
    for (const fileId of group.photos) {
      const url = await uploadTelegramFileToCloudinary(fileId, "image");
      if (url) imageUrls.push(url);
    }

    let videoUrl = "";
    if (group.video) videoUrl = (await uploadTelegramFileToCloudinary(group.video, "video")) || "";

    if (!imageUrls.length && !videoUrl) {
      console.error("❌ ما انرفع ولا ملف — تم الإلغاء.");
      return;
    }

    await db.collection("wholesale_products").add({
      name: fields.name,
      description: fields.description || "",
      category: fields.category || "منوعات",
      images: imageUrls,
      video: videoUrl,
      source: "telegram_bot",
      createdAt: FieldValue.serverTimestamp(),
    });

    console.log(`✅ انضاف المنتج: ${fields.name} (${imageUrls.length} صورة${videoUrl ? " + فيديو" : ""})`);
  } catch (err) {
    console.error("❌ فشل حفظ المنتج:", err.message);
  }
}

// ═══════════════ استخراج اسم/وصف/تصنيف من الكابشن (بدون أسعار) ═══════════════
function smartParse(caption) {
  const rawLines = caption.split("\n").map((l) => l.trim()).filter(Boolean);
  const result = { name: "منتج جديد", description: "", category: "" };

  if (rawLines[0]) result.name = rawLines[0].slice(0, 90);
  result.description = rawLines.slice(1).join(" · ").slice(0, 400);

  for (const [cat, words] of Object.entries(CATEGORY_WORDS)) {
    if (words.some((w) => caption.includes(w))) { result.category = cat; break; }
  }
  if (!result.category) result.category = "منوعات";

  return result;
}

// ═══════════════ رفع ملف من تليجرام إلى Cloudinary ═══════════════
async function uploadTelegramFileToCloudinary(fileId, resourceType) {
  try {
    const fileLink = await bot.getFileLink(fileId);
    const res = await fetch(fileLink);
    if (!res.ok) throw new Error(`تحميل فاشل من تليجرام: ${res.status}`);
    const buffer = Buffer.from(await res.arrayBuffer());

    const fd = new FormData();
    fd.append("file", new Blob([buffer]), `${fileId}.${resourceType === "video" ? "mp4" : "jpg"}`);
    fd.append("upload_preset", CLOUDINARY_UPLOAD_PRESET);

    const uploadRes = await fetch(
      `https://api.cloudinary.com/v1_1/${CLOUDINARY_CLOUD_NAME}/${resourceType}/upload`,
      { method: "POST", body: fd }
    );
    const data = await uploadRes.json();
    if (!uploadRes.ok || !data.secure_url) {
      throw new Error(data?.error?.message || "فشل رفع الملف لـ Cloudinary");
    }
    return data.secure_url;
  } catch (err) {
    console.error(`❌ فشل رفع الملف (${resourceType}):`, err.message);
    return null;
  }
}

main()
  .then(() => {
    console.log("👋 انتهت المزامنة.");
    process.exit(0);
  })
  .catch((err) => {
    console.error("❌ فشلت المزامنة:", err);
    process.exit(1);
  });
