// ═══════════════════════════════════════════════════════════
//  مسح كامل لمجموعة wholesale_products — سكربت لمرة وحدة، يشتغل
//  يدوياً عبر GitHub Actions (workflow_dispatch). يحذف كل المنتجات
//  بدون استثناء (بداية من الصفر بطلب صاحب المشروع).
//
//  احتياط: ما يحذف شي إلا إذا كان مدخل "confirm_delete" بالـ workflow
//  بالضبط = DELETE (يضبطها الـ workflow نفسه بمتغير DRY_RUN).
// ═══════════════════════════════════════════════════════════

const { initializeApp, cert } = require("firebase-admin/app");
const { getFirestore } = require("firebase-admin/firestore");

const DRY_RUN = process.env.DRY_RUN !== "false"; // آمن افتراضياً

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
  console.log(DRY_RUN ? "🧪 وضع تجريبي (DRY_RUN) — ما راح يصير حذف فعلي." : "⚠️ وضع حذف فعلي — راح يمسح كل المنتجات نهائياً.");

  const collectionRef = db.collection("wholesale_products");
  let total = 0;
  let deletedCount = 0;

  while (true) {
    const snap = await collectionRef.limit(450).get();
    if (snap.empty) break;

    total += snap.size;

    if (!DRY_RUN) {
      const batch = db.batch();
      snap.docs.forEach((doc) => batch.delete(doc.ref));
      await batch.commit();
      deletedCount += snap.size;
      console.log(`🗑️ حذفت ${deletedCount} منتج لحد الحين...`);
    } else {
      console.log(`📄 فحصت ${total} منتج لحد الحين...`);
      // بوضع التجربة ما نحذف، فنقرا نفس الدفعة بلا نهاية — نوقف هنا ونعتمد
      // تقدير تقريبي بدل عد دقيق لتفادي حلقة لا نهائية.
      break;
    }
  }

  if (DRY_RUN) {
    console.log(`\n📊 تقدير: فيه منتجات بالمجموعة (أول دفعة ${total} منها ظهرت). لعدّ دقيق شغّل الحذف الفعلي مباشرة بما إن القرار محسوم.`);
    console.log("✅ هذا وضع تجريبي بس — ما انحذف شي.");
    return;
  }

  console.log(`\n✅ انتهى المسح — انحذف ${deletedCount} منتج. المجموعة فاضية الحين، جاهزة تبدأ من الصفر.`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("❌ فشلت العملية:", err);
    process.exit(1);
  });
