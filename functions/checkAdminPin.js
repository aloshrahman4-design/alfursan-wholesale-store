/**
 * checkAdminPin — يتحقق من رمز دخول لوحة تحكم الجملة على السيرفر بدل الفرونت اند.
 * يرجع "secret" (نفس قيمة SHARED_SECRET الحالية حق addWholesaleProduct) فقط بعد نجاح الرمز،
 * حتى ما يبقى الرمز ولا السر مكتوبين نص صريح داخل admin.html.
 *
 * قفل مؤقت: بعد 5 محاولات خاطئة من نفس الـ IP، قفل 5 دقائق (يُخزّن بـ Firestore).
 *
 * النشر (مرة وحدة، من هذا المجلد functions/):
 *   npm install
 *   firebase functions:secrets:set WHOLESALE_ADMIN_PIN
 *   firebase functions:secrets:set WHOLESALE_SHARED_SECRET   ← لازم تكتب نفس قيمة SHARED_SECRET الحالية بالضبط: azyaa-secret-2026-x9f
 *   firebase deploy --only functions:checkAdminPin
 */

const { onRequest } = require("firebase-functions/v2/https");
const { defineSecret } = require("firebase-functions/params");
const { initializeApp, getApps } = require("firebase-admin/app");
const { getFirestore, FieldValue } = require("firebase-admin/firestore");

if (!getApps().length) initializeApp();
const db = getFirestore();

const ADMIN_PIN = defineSecret("WHOLESALE_ADMIN_PIN");
const PRODUCT_SECRET = defineSecret("WHOLESALE_SHARED_SECRET");

const MAX_ATTEMPTS = 5;
const LOCK_MS = 5 * 60 * 1000; // 5 دقائق

exports.checkAdminPin = onRequest(
  { region: "europe-west1", secrets: [ADMIN_PIN, PRODUCT_SECRET], cors: true },
  async (req, res) => {
    if (req.method !== "POST") {
      return res.status(405).json({ success: false, error: "method_not_allowed" });
    }

    const pin = String(req.body?.pin || "").trim();
    const ip = (req.headers["x-forwarded-for"] || "").split(",")[0].trim() || req.ip || "unknown";
    const attemptRef = db.collection("admin_login_attempts").doc(ip);

    const snap = await attemptRef.get();
    const data = snap.exists ? snap.data() : { count: 0, lockedUntil: 0 };
    const now = Date.now();

    if (data.lockedUntil && now < data.lockedUntil) {
      return res.status(429).json({
        success: false,
        error: "locked",
        retryAfter: Math.ceil((data.lockedUntil - now) / 1000),
      });
    }

    if (!pin || pin !== ADMIN_PIN.value()) {
      const prevCount = data.lockedUntil && now >= data.lockedUntil ? 0 : (data.count || 0);
      const count = prevCount + 1;
      const locked = count >= MAX_ATTEMPTS;
      await attemptRef.set({
        count: locked ? 0 : count,
        lockedUntil: locked ? now + LOCK_MS : 0,
        updatedAt: FieldValue.serverTimestamp(),
      });
      if (locked) {
        return res.status(429).json({ success: false, error: "locked", retryAfter: LOCK_MS / 1000 });
      }
      return res.status(401).json({
        success: false,
        error: "wrong_pin",
        attemptsLeft: MAX_ATTEMPTS - count,
      });
    }

    await attemptRef.delete().catch(() => {});
    return res.status(200).json({ success: true, secret: PRODUCT_SECRET.value() });
  }
);
