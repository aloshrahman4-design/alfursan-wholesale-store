/**
 * finalizePendingProducts — فنكشن مجدولة (كل دقيقة عبر Netlify Scheduled
 * Functions، أوثق بكثير من جدولة GitHub Actions). تاخذ كل مجموعة وصلت
 * عبر telegramWebhook.js وعمرها أكثر من ALBUM_WAIT_MS (يعني الألبوم خلص
 * يوصل)، تحدد تصنيف المنتج (أحذية/شحاطات/حقائب) بقراءة الصورة نفسها عبر
 * Gemini Vision (ما فيه كابشن أصلاً بالقناة، كل المعلومات داخل الصورة)،
 * ترفع الصور/الفيديو لـ Cloudinary، وتنشر المنتج النهائي بـ wholesale_products.
 */
const { schedule } = require("@netlify/functions");
const { getAdmin, jsonResponse } = require("./_lib/firebaseAdmin");

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CLOUDINARY_CLOUD_NAME = process.env.CLOUDINARY_CLOUD_NAME;
const CLOUDINARY_UPLOAD_PRESET = process.env.CLOUDINARY_UPLOAD_PRESET;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || "";
const ALBUM_WAIT_MS = 8000; // لازم نتأكد كل صور الألبوم وصلت قبل لا ننشر

const CATEGORIES = ["أحذية", "شحاطات", "حقائب", "منوعات"];

async function getTelegramFileBuffer(fileId) {
  const infoRes = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/getFile?file_id=${fileId}`);
  const info = await infoRes.json();
  if (!info.ok) throw new Error(info.description || "فشل getFile من تلكرام");

  const fileUrl = `https://api.telegram.org/file/bot${TELEGRAM_BOT_TOKEN}/${info.result.file_path}`;
  const fileRes = await fetch(fileUrl);
  if (!fileRes.ok) throw new Error(`تحميل فاشل من تليجرام: ${fileRes.status}`);
  return Buffer.from(await fileRes.arrayBuffer());
}

async function uploadBufferToCloudinary(buffer, resourceType) {
  const fd = new FormData();
  fd.append("file", new Blob([buffer]), resourceType === "video" ? "video.mp4" : "image.jpg");
  fd.append("upload_preset", CLOUDINARY_UPLOAD_PRESET);

  const uploadRes = await fetch(
    `https://api.cloudinary.com/v1_1/${CLOUDINARY_CLOUD_NAME}/${resourceType}/upload`,
    { method: "POST", body: fd }
  );
  const data = await uploadRes.json();
  if (!uploadRes.ok || !data.secure_url) throw new Error(data?.error?.message || "فشل رفع الملف لـ Cloudinary");
  return data.secure_url;
}

/**
 * يصنّف صورة منتج جملة واحدة (أحذية/شحاطات/حقائب) عن طريق قراءتها مباشرة
 * بـ Gemini Vision — ما فيه نص وصفي أصلاً نعتمد عليه. يرجع null لو ما فيه
 * مفتاح Gemini أو صار خطأ، وبهذي الحالة يبقى التصنيف "منوعات" الافتراضي.
 */
async function classifyCategory(imageBuffer) {
  if (!GEMINI_API_KEY) return null;
  try {
    const base64 = imageBuffer.toString("base64");
    const prompt =
      "هذي صورة منتج بمتجر جملة للأحذية والشحاطات والحقائب. " +
      "صنّف الصورة إلى كلمة واحدة بالضبط من هذي القائمة، بدون أي نص إضافي ولا علامات ترقيم:\n" +
      "أحذية\nشحاطات\nحقائب\nمنوعات";

    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-flash-latest:generateContent?key=${GEMINI_API_KEY}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{
            parts: [
              { text: prompt },
              { inline_data: { mime_type: "image/jpeg", data: base64 } },
            ],
          }],
        }),
      }
    );
    const data = await res.json();
    if (data.error) throw new Error(data.error.message || "Gemini API error");
    const rawText = data?.candidates?.[0]?.content?.parts?.[0]?.text || "";
    console.log(`🔎 Gemini رجع: "${rawText.replace(/\n/g, " ")}"`);

    const match = CATEGORIES.find((c) => rawText.includes(c));
    return match || null;
  } catch (err) {
    console.error("⚠️ فشل تصنيف الصورة بـ Gemini:", err.message);
    return null;
  }
}

const handler = async () => {
  if (!TELEGRAM_BOT_TOKEN || !CLOUDINARY_CLOUD_NAME || !CLOUDINARY_UPLOAD_PRESET) {
    console.error("❌ ناقص TELEGRAM_BOT_TOKEN أو إعدادات Cloudinary.");
    return jsonResponse(500, { success: false, error: "missing_config" });
  }
  if (!GEMINI_API_KEY) {
    console.warn("⚠️ GEMINI_API_KEY غير محدد — كل المنتجات راح تنصنف 'منوعات'.");
  }

  const admin = getAdmin();
  const db = admin.firestore();
  const cutoff = Date.now() - ALBUM_WAIT_MS;

  const pendingSnap = await db.collection("telegram_pending").get();
  let processed = 0;

  for (const doc of pendingSnap.docs) {
    const data = doc.data();
    const firstSeenMs = data.firstSeenAt?.toMillis ? data.firstSeenAt.toMillis() : 0;
    if (!firstSeenMs || firstSeenMs > cutoff) continue; // الألبوم لسا ممكن يوصله أجزاء

    try {
      const imageBuffers = [];
      for (const fileId of data.photoFileIds || []) {
        imageBuffers.push(await getTelegramFileBuffer(fileId));
      }

      const category = imageBuffers.length ? (await classifyCategory(imageBuffers[0])) || "منوعات" : "منوعات";

      const imageUrls = [];
      for (const buf of imageBuffers) {
        imageUrls.push(await uploadBufferToCloudinary(buf, "image"));
      }
      let videoUrl = "";
      if (data.videoFileId) {
        const videoBuffer = await getTelegramFileBuffer(data.videoFileId);
        videoUrl = await uploadBufferToCloudinary(videoBuffer, "video");
      }

      if (imageUrls.length || videoUrl) {
        await db.collection("wholesale_products").add({
          name: "منتج جديد",
          description: "",
          category,
          images: imageUrls,
          video: videoUrl,
          source: "telegram_bot",
          createdAt: admin.firestore.FieldValue.serverTimestamp(),
        });
        console.log(`✅ انضاف المنتج (${category})`);
        processed++;
      }
    } catch (err) {
      console.error(`❌ فشلت معالجة المجموعة ${doc.id}:`, err.message);
      // نسيبها بالـ pending — المحاولة الجاية (بعد دقيقة) تعيد المحاولة.
      continue;
    }

    await doc.ref.delete();
  }

  return jsonResponse(200, { success: true, processed });
};

exports.handler = schedule("* * * * *", handler);
