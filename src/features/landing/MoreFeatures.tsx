import { UnderstandingLab } from "./UnderstandingLab";
import { Bell, Check, FileSpreadsheet, Megaphone } from "lucide-react";

/** Illustrative product previews, deliberately separate from live student data. */
export function MoreFeatures() {
  return <div className="tw-more-features">
    <UnderstandingLab />
    <section className="tw-daily" aria-labelledby="tw-daily-title">
      <div className="tw-daily-heading"><h2 id="tw-daily-title">والتفاصيل الصغيرة؟<br/><span>لها تبويب هي كمان.</span></h2><p>من أول قائمة طلاب، لآخر إعلان للمجموعة.<br/>أدوات عملية لتنظيم اليوم الدراسي.</p></div>
      <div className="tw-daily-grid">
        <article><FileSpreadsheet/><h3>قائمة طلابك، بخطوات واضحة.</h3><p>ارفع ملف الطلاب، راجع المعاينة والأخطاء قبل اعتماد الاستيراد، وارجع لتقرير الدفعة.</p><div className="tw-import-preview" aria-hidden="true"><span>ملف الطلاب <small>CSV</small></span><div><i/> مراجعة البيانات <Check size={16}/></div><div><i/> معاينة قبل الاعتماد <Check size={16}/></div><b>رفع ← مراجعة ← اعتماد</b></div></article>
        <article><Megaphone/><h3>الإعلان في مكانه.</h3><p>انشر إعلاناتك للمجموعات، ونظّم مواعيدها، وارجع لتعديلها أو سحبها عند الحاجة.</p><div className="tw-announcement-preview" aria-hidden="true"><span>إعلانات المجموعة</span><strong>مراجعة قبل الاختبار</strong><p>الموضوعات المطلوبة وتفاصيل المراجعة في إعلان واحد.</p><small>مثال توضيحي</small></div></article>
        <article><Bell/><h3>متابعة من داخل المنصة.</h3><p>مركز للإشعارات داخل الحساب، مع متابعة المقروء وغير المقروء والرجوع للتحديثات.</p><div className="tw-notice-preview" aria-hidden="true"><span><Bell size={16}/> مركز الإشعارات</span><div><i/><b>تحديثاتك في مكان واحد</b></div><div><i/><b>تمييز الإشعارات المقروءة</b></div><small>معاينة توضيحية</small></div></article>
      </div>
    </section>
  </div>;
}
