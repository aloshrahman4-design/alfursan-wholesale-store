/**
 * updateWholesaleProduct — يعدّل اسم/وصف/تصنيف منتج موجود بقاعدة الجملة.
 * نفس منطق التفويض المستخدم بـ addWholesaleProduct (secret مشترك).
 */

const { onRequest } = require("firebase-functions/v2/https");
const { defineSecret } = require("firebase-functions/params");
const { initializeApp, getApps } = require("firebase-admin/app");
const { getFirestore } = require("firebase-admin/firestore");

if (!getApps().length) initializeApp();
const db = getFirestore();

const PRODUCT_SECRET = defineSecret("WHOLESALE_SHARED_SECRET");

exports.updateWholesaleProduct = onRequest(
  { region: "europe-west1", secrets: [PRODUCT_SECRET], cors: true },
  async (req, res) => {
    if (req.method !== "POST") {
      return res.status(405).json({ success: false, error: "method_not_allowed" });
    }

    const { secret, id, name, description, category } = req.body || {};
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

    const updates = {};
    if (typeof name === "string" && name.trim()) updates.name = name.trim();
    if (typeof description === "string") updates.description = description.trim();
    if (typeof category === "string" && category.trim()) updates.category = category.trim();

    if (!Object.keys(updates).length) {
      return res.status(400).json({ success: false, error: "no_fields" });
    }

    await ref.update(updates);
    return res.status(200).json({ success: true });
  }
);
