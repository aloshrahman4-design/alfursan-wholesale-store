/**
 * deleteWholesaleProduct — يحذف منتج من قاعدة الجملة + صوره/فيديوه من Storage.
 * نفس منطق التفويض المستخدم بـ addWholesaleProduct (secret مشترك).
 */

const { onRequest } = require("firebase-functions/v2/https");
const { defineSecret } = require("firebase-functions/params");
const { initializeApp, getApps } = require("firebase-admin/app");
const { getFirestore } = require("firebase-admin/firestore");
const { getStorage } = require("firebase-admin/storage");

if (!getApps().length) initializeApp();
const db = getFirestore();

const PRODUCT_SECRET = defineSecret("WHOLESALE_SHARED_SECRET");

function storagePathFromUrl(url) {
  const m = String(url || "").match(/\/o\/([^?]+)/);
  return m ? decodeURIComponent(m[1]) : null;
}

exports.deleteWholesaleProduct = onRequest(
  { region: "europe-west1", secrets: [PRODUCT_SECRET], cors: true },
  async (req, res) => {
    if (req.method !== "POST") {
      return res.status(405).json({ success: false, error: "method_not_allowed" });
    }

    const { secret, id } = req.body || {};
    if (secret !== PRODUCT_SECRET.value()) {
      return res.status(401).json({ success: false, error: "unauthorized" });
    }
    if (!id) {
      return res.status(400).json({ success: false, error: "missing_id" });
    }

    const ref = db.collection("wholesale_products").doc(String(id));
    const snap = await ref.get();
    if (!snap.exists) {
      return res.status(404).json({ success: false, error: "not_found" });
    }

    const data = snap.data() || {};
    const files = [...(Array.isArray(data.images) ? data.images : []), data.video].filter(Boolean);
    const bucket = getStorage().bucket();
    await Promise.all(files.map(async (url) => {
      const path = storagePathFromUrl(url);
      if (!path) return;
      try { await bucket.file(path).delete(); } catch (e) { /* الملف يمكن يكون محذوف مسبقاً، تجاهل */ }
    }));

    await ref.delete();
    return res.status(200).json({ success: true });
  }
);
