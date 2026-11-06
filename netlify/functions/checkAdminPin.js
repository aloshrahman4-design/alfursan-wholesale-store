/**
 * checkAdminPin — بديل Netlify Function لنفس الفنكشن اللي كانت على Firebase Cloud
 * Functions (يتطلب خطة Blaze). نفس المنطق بالضبط: يتحقق من رمز الدخول، ويرجع
 * secret النشر بعد نجاح الرمز، مع قفل مؤقت بعد 5 محاولات خاطئة (مخزّن بـ Firestore
 * عبر Admin SDK — ما يحتاج Blaze، Firestore نفسه يشتغل مجاني بخطة Spark).
 */
const { getAdmin, jsonResponse } = require("./_lib/firebaseAdmin");

const MAX_ATTEMPTS = 5;
const LOCK_MS = 5 * 60 * 1000; // 5 دقائق

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") {
    return jsonResponse(405, { success: false, error: "method_not_allowed" });
  }

  let body;
  try {
    body = JSON.parse(event.body || "{}");
  } catch {
    return jsonResponse(400, { success: false, error: "bad_request" });
  }

  const pin = String(body.pin || "").trim();
  const ip =
    (event.headers["x-nf-client-connection-ip"] ||
      (event.headers["x-forwarded-for"] || "").split(",")[0].trim() ||
      "unknown");

  const admin = getAdmin();
  const db = admin.firestore();
  const attemptRef = db.collection("admin_login_attempts").doc(ip);

  const snap = await attemptRef.get();
  const data = snap.exists ? snap.data() : { count: 0, lockedUntil: 0 };
  const now = Date.now();

  if (data.lockedUntil && now < data.lockedUntil) {
    return jsonResponse(429, {
      success: false,
      error: "locked",
      retryAfter: Math.ceil((data.lockedUntil - now) / 1000),
    });
  }

  const ADMIN_PIN = process.env.WHOLESALE_ADMIN_PIN;
  const PRODUCT_SECRET = process.env.WHOLESALE_SHARED_SECRET;

  if (!pin || pin !== ADMIN_PIN) {
    const prevCount = data.lockedUntil && now >= data.lockedUntil ? 0 : (data.count || 0);
    const count = prevCount + 1;
    const locked = count >= MAX_ATTEMPTS;
    await attemptRef.set({
      count: locked ? 0 : count,
      lockedUntil: locked ? now + LOCK_MS : 0,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });
    if (locked) {
      return jsonResponse(429, { success: false, error: "locked", retryAfter: LOCK_MS / 1000 });
    }
    return jsonResponse(401, {
      success: false,
      error: "wrong_pin",
      attemptsLeft: MAX_ATTEMPTS - count,
    });
  }

  await attemptRef.delete().catch(() => {});
  return jsonResponse(200, { success: true, secret: PRODUCT_SECRET });
};
