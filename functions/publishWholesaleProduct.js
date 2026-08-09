/**
 * addWholesaleProduct — ينشر منتج جديد (صور متعددة + فيديو اختياري) لقاعدة الجملة.
 * بديل عن خدمة Cloud Run القديمة (addwholesaleproduct-...run.app) اللي ماكانت
 * ترجع رؤوس CORS، فيصير المتصفح يرفض الاتصال بيها من admin.html (رغم إنها تشتغل عادي عبر curl).
 * نفس منطق التفويض (secret مشترك) ونفس شكل بيانات المنتج بالضبط.
 */

const { onRequest } = require("firebase-functions/v2/https");
const { defineSecret } = require("firebase-functions/params");
const { initializeApp, getApps } = require("firebase-admin/app");
const { getFirestore, FieldValue } = require("firebase-admin/firestore");
const { getStorage } = require("firebase-admin/storage");
const Busboy = require("busboy");

if (!getApps().length) initializeApp();
const db = getFirestore();

const PRODUCT_SECRET = defineSecret("WHOLESALE_SHARED_SECRET");

function parseMultipart(req) {
  return new Promise((resolve, reject) => {
    const busboy = Busboy({ headers: req.headers });
    const fields = {};
    const images = [];
    let video = null;

    busboy.on("field", (name, val) => { fields[name] = val; });
    busboy.on("file", (name, file, info) => {
      const { mimeType } = info || {};
      const chunks = [];
      file.on("data", (d) => chunks.push(d));
      file.on("end", () => {
        const buffer = Buffer.concat(chunks);
        if (!buffer.length) return;
        if (name === "images") images.push({ buffer, mimeType });
        else if (name === "video") video = { buffer, mimeType };
      });
    });
    busboy.on("finish", () => resolve({ fields, images, video }));
    busboy.on("error", reject);
    busboy.end(req.rawBody);
  });
}

function extFromMime(mime) {
  const map = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "video/mp4": "mp4", "video/quicktime": "mov" };
  return (mime && map[mime]) || (mime ? mime.split("/")[1] : "jpg");
}

async function uploadFile(buffer, mimeType, folder) {
  const bucket = getStorage().bucket();
  const ext = extFromMime(mimeType);
  const path = `wholesale/${folder}/${Date.now()}_${Math.random().toString(36).slice(2, 8)}.${ext}`;
  const file = bucket.file(path);
  await file.save(buffer, { contentType: mimeType || "application/octet-stream" });
  try { await file.makePublic(); } catch (e) { /* الباكت غالباً عام أصلاً بمستوى uniform access */ }
  return `https://firebasestorage.googleapis.com/v0/b/${bucket.name}/o/${encodeURIComponent(path)}?alt=media`;
}

exports.publishWholesaleProduct = onRequest(
  { region: "europe-west1", secrets: [PRODUCT_SECRET], cors: true },
  async (req, res) => {
    if (req.method !== "POST") {
      return res.status(405).json({ success: false, error: "method_not_allowed" });
    }

    let parsed;
    try {
      parsed = await parseMultipart(req);
    } catch (e) {
      return res.status(400).json({ success: false, error: "bad_request" });
    }

    const { fields, images, video } = parsed;
    if (fields.secret !== PRODUCT_SECRET.value()) {
      return res.status(401).json({ success: false, error: "unauthorized" });
    }
    const name = (fields.name || "").trim();
    if (!name) {
      return res.status(400).json({ success: false, error: "missing_name" });
    }
    if (!images.length) {
      return res.status(400).json({ success: false, error: "missing_images" });
    }

    try {
      const imageUrls = [];
      for (const img of images) {
        imageUrls.push(await uploadFile(img.buffer, img.mimeType, "images"));
      }
      let videoUrl = "";
      if (video) {
        videoUrl = await uploadFile(video.buffer, video.mimeType, "videos");
      }

      const docRef = await db.collection("wholesale_products").add({
        name,
        description: (fields.description || "").trim(),
        category: (fields.category || "منوعات").trim(),
        images: imageUrls,
        video: videoUrl,
        createdAt: FieldValue.serverTimestamp(),
      });

      return res.status(200).json({ success: true, id: docRef.id, name });
    } catch (e) {
      return res.status(500).json({ success: false, error: "upload_failed" });
    }
  }
);
