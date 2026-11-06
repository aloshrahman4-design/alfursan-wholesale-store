/**
 * publishWholesaleProduct — بديل Netlify Function. الفرق عن النسخة القديمة على
 * Firebase Cloud Functions: الصور والفيديو ما تنرفع هنا — الفرونت اند (admin.html)
 * يرفعها مباشرة لـ Cloudinary (مجاني، بدون بطاقة) قبل ما يستدعي هذا الفنكشن،
 * وهذا الفنكشن بس يسجل روابط Cloudinary الجاهزة بـ Firestore عبر Admin SDK.
 */
const { getAdmin, jsonResponse } = require("./_lib/firebaseAdmin");

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

  if (body.secret !== process.env.WHOLESALE_SHARED_SECRET) {
    return jsonResponse(401, { success: false, error: "unauthorized" });
  }

  const name = String(body.name || "").trim();
  const images = Array.isArray(body.images) ? body.images.filter(Boolean) : [];
  if (!name) {
    return jsonResponse(400, { success: false, error: "missing_name" });
  }
  if (!images.length) {
    return jsonResponse(400, { success: false, error: "missing_images" });
  }

  const admin = getAdmin();
  const db = admin.firestore();

  try {
    const docRef = await db.collection("wholesale_products").add({
      name,
      description: String(body.description || "").trim(),
      category: String(body.category || "منوعات").trim(),
      images,
      video: String(body.video || "").trim(),
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });
    return jsonResponse(200, { success: true, id: docRef.id, name });
  } catch (e) {
    return jsonResponse(500, { success: false, error: "save_failed" });
  }
};
