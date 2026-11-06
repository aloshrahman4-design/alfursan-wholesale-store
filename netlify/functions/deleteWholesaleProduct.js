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

  const id = String(body.id || "").trim();
  if (!id) {
    return jsonResponse(400, { success: false, error: "missing_id" });
  }

  const admin = getAdmin();
  const db = admin.firestore();

  try {
    await db.collection("wholesale_products").doc(id).delete();
    return jsonResponse(200, { success: true });
  } catch (e) {
    return jsonResponse(500, { success: false, error: "delete_failed" });
  }
};
