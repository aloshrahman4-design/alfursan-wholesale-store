/**
 * telegramWebhook — يستقبل منشورات قناة تلكرام فوراً (خلال ثواني، مو دقايق)
 * بدل الانتظار على جدولة GitHub Actions غير الموثوقة. ما يرفع الصور هنا —
 * بس يسجل وصول كل صورة/فيديو/كابشن بمستند Firestore مؤقت (telegram_pending)،
 * حتى يقدر يجمع كل صور الألبوم الواحد قبل لا ينشر (تلكرام يرسل كل صورة
 * بالألبوم كطلب Webhook منفصل تماماً — ما فيه ذاكرة مشتركة بين الطلبات
 * بالفنكشنات الـ serverless، فلازم نخزن المؤقت بقاعدة بيانات).
 *
 * finalizePendingProducts.js (مجدولة كل دقيقة) هي اللي فعلياً تنشر المنتج
 * النهائي بعد ما تتأكد الألبوم اكتمل.
 */
const { getAdmin, jsonResponse } = require("./_lib/firebaseAdmin");

const SOURCE_CHANNEL = process.env.SOURCE_CHANNEL_USERNAME || "akaraqi10";
const WEBHOOK_SECRET = process.env.TELEGRAM_WEBHOOK_SECRET;

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") {
    return jsonResponse(405, { success: false, error: "method_not_allowed" });
  }

  if (WEBHOOK_SECRET) {
    const got = event.headers["x-telegram-bot-api-secret-token"];
    if (got !== WEBHOOK_SECRET) {
      return jsonResponse(401, { success: false, error: "unauthorized" });
    }
  }

  let body;
  try {
    body = JSON.parse(event.body || "{}");
  } catch {
    return jsonResponse(400, { success: false, error: "bad_request" });
  }

  const msg = body.channel_post;
  // دائماً نرد 200 بسرعة حتى لو ما فيه شي نسويه — غير كذا تلكرام يعيد المحاولة
  // ويفكر إن فيه مشكلة بالسيرفر.
  if (!msg || msg.chat?.username !== SOURCE_CHANNEL) {
    return jsonResponse(200, { success: true, skipped: true });
  }

  const hasPhoto = Array.isArray(msg.photo) && msg.photo.length > 0;
  const hasVideo = !!msg.video;
  if (!hasPhoto && !hasVideo) {
    return jsonResponse(200, { success: true, skipped: true });
  }

  const admin = getAdmin();
  const db = admin.firestore();
  const groupId = msg.media_group_id || `single_${msg.message_id}`;
  const ref = db.collection("telegram_pending").doc(groupId);

  try {
    await db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      const data = snap.exists ? snap.data() : { photoFileIds: [], uniqueIds: [], videoFileId: null, caption: null };

      if (hasPhoto) {
        const largest = msg.photo[msg.photo.length - 1];
        const uid = largest?.file_unique_id || largest?.file_id;
        if (uid && !data.uniqueIds.includes(uid)) {
          data.uniqueIds.push(uid);
          data.photoFileIds.push(largest.file_id);
        }
      }
      if (hasVideo && !data.videoFileId) data.videoFileId = msg.video.file_id;
      if (msg.caption && msg.caption.trim()) data.caption = msg.caption.trim();

      tx.set(ref, {
        ...data,
        firstSeenAt: snap.exists ? data.firstSeenAt : admin.firestore.FieldValue.serverTimestamp(),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      });
    });
    return jsonResponse(200, { success: true });
  } catch (e) {
    console.error("telegramWebhook error:", e.message);
    // نرجع 200 برضو حتى لو صار خطأ داخلي — ما نريد تلكرام يعيد نفس المنشور
    // بشكل متكرر بسبب خطأ مؤقت عندنا؛ finalizePendingProducts ممكن تحاول
    // تصلحه لاحقاً لو البيانات انحفظت جزئياً.
    return jsonResponse(200, { success: false, error: "internal_error" });
  }
};
