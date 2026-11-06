// ═══════════════════════════════════════════════════════════
//  حذف دفعي لكل منتج قديم بمجموعة wholesale_products — سكربت
//  لمرة وحدة، يشتغل يدوياً عبر GitHub Actions (workflow_dispatch).
//  يبقي بس المنتجات اللي عندها source == "telegram_bot" (منتجات
//  المزامنة الجديدة من تلكرام)، ويحذف كل شي غيرها.
//
//  احتياط: ما يحذف شي إلا بعد ما يطبع عدد المنتجات اللي راح يحذفها
//  ويحتاج DRY_RUN=false صراحة بمتغير بيئة حتى ينفذ الحذف الفعلي —
//  وإلا يطبع بس العدد بدون حذف (وضع آمن افتراضي).
// ═══════════════════════════════════════════════════════════

const { initializeApp, cert } = require("firebase-admin/app");
const { getFirestore } = require("firebase-admin/firestore");

const DRY_RUN = process.env.DRY_RUN !== "false"; // آمن افتراضياً، لازم تحدد DRY_RUN=false صراحة للحذف الفعلي

let serviceAccount;
try {
  serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON);
} catch (err) {
  console.error("❌ ما قدرت أقرا FIREBASE_SERVICE_ACCOUNT_JSON:", err.message);
  process.exit(1);
}

initializeApp({ credential: cert(serviceAccount) });
const db = getFirestore();

async function main() {
  console.log(DRY_RUN ? "🧪 وضع تجريبي (DRY_RUN) — ما راح يصير حذف فعلي." : "⚠️ وضع حذف فعلي — راح يحذف نهائياً.");

  const collectionRef = db.collection("wholesale_products");
  let toDelete = [];
  let kept = 0;
  let lastDoc = null;

  while (true) {
    let query = collectionRef.orderBy("__name__").limit(500);
    if (lastDoc) query = query.startAfter(lastDoc);
    const snap = await query.get();
    if (snap.empty) break;

    for (const doc of snap.docs) {
      const source = doc.data().source;
      if (source === "telegram_bot") kept++;
      else toDelete.push(doc.ref);
    }
    lastDoc = snap.docs[snap.docs.length - 1];
    console.log(`📄 فحصت ${toDelete.length + kept} منتج لحد الحين...`);
  }

  console.log(`\n📊 النتيجة: ${toDelete.length} منتج قديم (راح يُحذف)، ${kept} منتج جديد (راح يبقى).`);

  if (DRY_RUN) {
    console.log("✅ هذا وضع تجريبي بس — ما انحذف شي. لتنفيذ الحذف الفعلي شغّل الـ workflow مع DRY_RUN=false.");
    return;
  }

  let deletedCount = 0;
  while (toDelete.length) {
    const chunk = toDelete.splice(0, 450);
    const batch = db.batch();
    chunk.forEach((ref) => batch.delete(ref));
    await batch.commit();
    deletedCount += chunk.length;
    console.log(`🗑️ حذفت ${deletedCount} منتج لحد الحين...`);
  }

  console.log(`\n✅ انتهى الحذف — انحذف ${deletedCount} منتج قديم، وبقي ${kept} منتج جديد.`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("❌ فشلت العملية:", err);
    process.exit(1);
  });
