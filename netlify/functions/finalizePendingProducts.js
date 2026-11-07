/**
 * finalizePendingProducts — فنكشن مجدولة (كل دقيقة عبر Netlify Scheduled
 * Functions، أوثق بكثير من جدولة GitHub Actions). تاخذ كل مجموعة وصلت
 * عبر telegramWebhook.js وعمرها أكثر من ALBUM_WAIT_MS (يعني الألبوم خلص
 * يوصل)، ترفع الصور/الفيديو لـ Cloudinary، وتنشر المنتج النهائي بـ
 * wholesale_products.
 */
const { schedule } = require("@netlify/functions");
const { getAdmin, jsonResponse } = require("./_lib/firebaseAdmin");
const { smartParse } = require("./_lib/parseCaption");

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CLOUDINARY_CLOUD_NAME = process.env.CLOUDINARY_CLOUD_NAME;
const CLOUDINARY_UPLOAD_PRESET = process.env.CLOUDINARY_UPLOAD_PRESET;
const ALBUM_WAIT_MS = 8000; // لازم نتأكد كل صور الألبوم وصلت قبل لا ننشر

async function getTelegramFileUrl(fileId) {
  const res = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/getFile?file_id=${fileId}`);
  const data = await res.json();
  if (!data.ok) throw new Error(data.description || "فشل getFile من تلكرام");
  return `https://api.telegram.org/file/bot${TELEGRAM_BOT_TOKEN}/${data.result.file_path}`;
}

async function uploadToCloudinary(fileUrl, resourceType) {
  const fileRes = await fetch(fileUrl);
  if (!fileRes.ok) throw new Error(`تحميل فاشل من تليجرام: ${fileRes.status}`);
  const buffer = Buffer.from(await fileRes.arrayBuffer());

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

const handler = async () => {
  if (!TELEGRAM_BOT_TOKEN || !CLOUDINARY_CLOUD_NAME || !CLOUDINARY_UPLOAD_PRESET) {
    console.error("❌ ناقص TELEGRAM_BOT_TOKEN أو إعدادات Cloudinary.");
    return jsonResponse(500, { success: false, error: "missing_config" });
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
      const imageUrls = [];
      for (const fileId of data.photoFileIds || []) {
        const fileUrl = await getTelegramFileUrl(fileId);
        imageUrls.push(await uploadToCloudinary(fileUrl, "image"));
      }
      let videoUrl = "";
      if (data.videoFileId) {
        const fileUrl = await getTelegramFileUrl(data.videoFileId);
        videoUrl = await uploadToCloudinary(fileUrl, "video");
      }

      if (imageUrls.length || videoUrl) {
        const fields = smartParse(data.caption);
        await db.collection("wholesale_products").add({
          name: fields.name,
          description: fields.description || "",
          category: fields.category || "منوعات",
          images: imageUrls,
          video: videoUrl,
          source: "telegram_bot",
          createdAt: admin.firestore.FieldValue.serverTimestamp(),
        });
        console.log(`✅ انضاف المنتج: ${fields.name}`);
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
