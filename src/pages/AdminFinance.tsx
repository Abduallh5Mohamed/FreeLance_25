import { useEffect, useMemo, useState } from 'react';
import { Activity, BarChart3, Calculator, CircleAlert, Clock3, CreditCard, Database, Download, FileText, RefreshCw, Save, Trash2, TrendingUp, Users } from 'lucide-react';
import { Area, AreaChart, Bar, BarChart, CartesianGrid, Cell, Legend, Pie, PieChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import Header from '@/components/Header';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import {
  createAnalystCalculation, deleteAnalystCalculation, downloadAdminFinanceReport, getAdminFinance,
  getAnalystCalculations, getVideoCommission, recordAnalystPdfExport, updateVideoCommission,
  type AdminFinanceData, type AnalystCalculation,
} from '@/lib/api';
import tabwebAcademyLogo from '@/assets/Tabweb_Academy_Logo.png';

const money = (value: number) => `${value.toLocaleString('ar-EG', { maximumFractionDigits: 2 })} ج.م`;
const count = (value: number) => value.toLocaleString('ar-EG');
const percent = (value: number | null) => value == null ? 'لا توجد فترة مقارنة' : `${value.toLocaleString('ar-EG')}٪`;
const subscriptionLabels: Record<string, string> = {
  pending: 'معلّق', active: 'نشط', past_due: 'مستحق', grace_period: 'مهلة', expired: 'منتهي', completed: 'فترة مكتملة', suspended: 'موقوف', cancelled: 'ملغي',
};
const methodLabels: Record<string, string> = { bank_transfer: 'تحويل بنكي', instapay: 'InstaPay', mobile_wallet: 'محفظة هاتف', cash: 'نقدي' };
const chartColors = ['#4f46e5', '#10b981', '#f59e0b', '#ef4444', '#0ea5e9', '#8b5cf6', '#64748b'];
type SummaryKey = keyof AdminFinanceData['summary'];
const metricCatalog: Array<{ key: SummaryKey; label: string; format: 'number' | 'money' | 'percent' }> = [
  { key: 'revenue_month', label: 'إيراد هذا الشهر', format: 'money' }, { key: 'revenue_previous_month', label: 'إيراد الشهر السابق', format: 'money' },
  { key: 'revenue_total', label: 'إجمالي الإيراد', format: 'money' }, { key: 'cash_collected_total', label: 'التحصيل النقدي', format: 'money' },
  { key: 'unused_service_credit', label: 'رصيد الخدمات القائم', format: 'money' }, { key: 'pending_amount', label: 'مبالغ قيد المراجعة', format: 'money' },
  { key: 'verified_attempts', label: 'محاولات مؤكدة', format: 'number' }, { key: 'submitted_attempts', label: 'محاولات معلقة', format: 'number' },
  { key: 'rejected_attempts', label: 'محاولات مرفوضة', format: 'number' }, { key: 'payment_approval_rate', label: 'نسبة قبول الدفع', format: 'percent' },
  { key: 'active_subscriptions', label: 'اشتراكات نشطة', format: 'number' }, { key: 'pending_subscriptions', label: 'اشتراكات معلقة', format: 'number' },
  { key: 'expiring_30_days', label: 'تنتهي خلال 30 يومًا', format: 'number' }, { key: 'active_tenants', label: 'حسابات نشاط نشطة', format: 'number' },
  { key: 'new_tenants_month', label: 'حسابات جديدة هذا الشهر', format: 'number' }, { key: 'instructors', label: 'عدد المدرسين', format: 'number' },
  { key: 'students', label: 'عدد الطلاب', format: 'number' }, { key: 'average_students_per_instructor', label: 'متوسط الطلاب لكل مدرس', format: 'number' },
  { key: 'invalid_review_timestamps', label: 'تواريخ مراجعة غير منطقية', format: 'number' },
];
const operatorLabels: Record<AnalystCalculation['operator'], string> = { add: 'جمع', subtract: 'طرح', multiply: 'ضرب', divide: 'قسمة', percent_of: 'نسبة الأول من الثاني', growth: 'معدل تغير عن الثاني' };

const calculate = (calculation: Pick<AnalystCalculation, 'left_metric' | 'operator' | 'right_metric' | 'constant_value'>, summary?: AdminFinanceData['summary']) => {
  if (!summary) return null;
  const left = Number(summary[calculation.left_metric as SummaryKey] ?? 0);
  const right = calculation.right_metric ? Number(summary[calculation.right_metric as SummaryKey] ?? 0) : Number(calculation.constant_value ?? 0);
  if ((calculation.operator === 'divide' || calculation.operator === 'percent_of' || calculation.operator === 'growth') && right === 0) return null;
  if (calculation.operator === 'add') return left + right;
  if (calculation.operator === 'subtract') return left - right;
  if (calculation.operator === 'multiply') return left * right;
  if (calculation.operator === 'divide') return left / right;
  if (calculation.operator === 'percent_of') return (left / right) * 100;
  return ((left - right) / right) * 100;
};

const formatCalculated = (value: number | null, format: AnalystCalculation['result_format']) => {
  if (value == null || !Number.isFinite(value)) return 'غير قابل للحساب';
  if (format === 'money') return money(value);
  if (format === 'percent') return `${value.toLocaleString('ar-EG', { maximumFractionDigits: 2 })}٪`;
  return value.toLocaleString('ar-EG', { maximumFractionDigits: 2 });
};

function MetricCard({ label, value, help, tone = 'indigo' }: { label: string; value: string; help: string; tone?: string }) {
  const colors: Record<string, string> = { indigo: 'bg-indigo-50 text-indigo-700', emerald: 'bg-emerald-50 text-emerald-700', amber: 'bg-amber-50 text-amber-800', rose: 'bg-rose-50 text-rose-700', blue: 'bg-blue-50 text-blue-700' };
  return <Card><CardContent className="p-5"><div className={`mb-3 inline-flex rounded-lg p-2 ${colors[tone] || colors.indigo}`}><Activity className="h-4 w-4" /></div><p className="text-sm text-slate-500">{label}</p><p className="mt-1 text-2xl font-bold text-slate-900">{value}</p><p className="mt-2 text-xs leading-5 text-slate-500">{help}</p></CardContent></Card>;
}

function PdfPage({ page, title, children }: { page: number; title: string; children: React.ReactNode }) {
  return <section data-pdf-page dir="rtl" style={{ width: '210mm', height: '297mm', padding: '14mm', background: '#fff', color: '#0f172a', position: 'relative', overflow: 'hidden', fontFamily: 'Cairo, Tahoma, Arial, sans-serif' }}>
    <header style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', borderBottom: '2px solid #4f46e5', paddingBottom: '5mm', marginBottom: '7mm' }}><div style={{ display: 'flex', alignItems: 'center', gap: '4mm' }}><img src={tabwebAcademyLogo} alt="Tabweb Academy" style={{ width: '14mm', height: '14mm', objectFit: 'contain', borderRadius: '4mm' }} /><div><strong style={{ fontSize: '16px' }}>Tabweb Academy</strong><div style={{ color: '#64748b', fontSize: '10px' }}>تقرير التحليلات الإدارية</div></div></div><div style={{ textAlign: 'left' }}><strong style={{ color: '#4f46e5', fontSize: '15px' }}>{title}</strong><div style={{ color: '#64748b', fontSize: '9px' }}>سري — للاستخدام الإداري</div></div></header>
    {children}
    <footer style={{ position: 'absolute', right: '14mm', left: '14mm', bottom: '7mm', display: 'flex', justifyContent: 'space-between', borderTop: '1px solid #cbd5e1', paddingTop: '3mm', color: '#64748b', fontSize: '9px' }}><span>الأرقام حسب بيانات المنصة وقت إنشاء التقرير</span><span>صفحة {page}</span></footer>
  </section>;
}

function AnalyticsPdfReport({ data, months, calculations, scenario }: { data: AdminFinanceData; months: number; calculations: AnalystCalculation[]; scenario: { newInstructors: number; planPrice: number; pendingConversion: number; churnRisk: number; targetRevenue: number } }) {
  const projectedNewRevenue = scenario.newInstructors * scenario.planPrice;
  const recoverablePending = data.summary.pending_amount * scenario.pendingConversion / 100;
  const projectedRevenue = data.summary.revenue_month + projectedNewRevenue + recoverablePending;
  const maxTrend = Math.max(1, ...data.trend.map(item => item.revenue));
  const compactBox: React.CSSProperties = { border: '1px solid #e2e8f0', borderRadius: '3mm', padding: '4mm', background: '#f8fafc' };
  return <div aria-hidden="true" style={{ position: 'fixed', left: '-30000px', top: 0, zIndex: -1 }}>
    <PdfPage page={1} title="الملخص التنفيذي">
      <div style={{ padding: '8mm', borderRadius: '5mm', background: 'linear-gradient(135deg,#312e81,#4f46e5,#0f766e)', color: '#fff', marginBottom: '7mm' }}><div style={{ fontSize: '25px', fontWeight: 800 }}>أداء المنصة واتجاهات الأعمال</div><p style={{ margin: '3mm 0 0', fontSize: '12px', opacity: .9 }}>فترة التحليل: آخر {months} شهرًا · تاريخ الإنشاء: {new Date(data.generated_at).toLocaleString('ar-EG')}</p></div>
      <h2 style={{ fontSize: '16px', marginBottom: '4mm' }}>مؤشرات الإدارة العليا</h2>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: '3mm' }}>{[
        ['إيراد الشهر', money(data.summary.revenue_month)], ['التحصيل النقدي', money(data.summary.cash_collected_total)], ['رصيد خدمات قائم', money(data.summary.unused_service_credit)], ['الإيراد الكلي', money(data.summary.revenue_total)],
        ['اشتراكات نشطة', count(data.summary.active_subscriptions)], ['تنتهي خلال 30 يومًا', count(data.summary.expiring_30_days)], ['مدرسون', count(data.summary.instructors)], ['طلاب', count(data.summary.students)],
      ].map(([label, value]) => <div key={label} style={compactBox}><div style={{ color: '#64748b', fontSize: '9px' }}>{label}</div><strong style={{ display: 'block', marginTop: '2mm', color: '#312e81', fontSize: '15px' }}>{value}</strong></div>)}</div>
      <div style={{ display: 'grid', gridTemplateColumns: '1.25fr .75fr', gap: '5mm', marginTop: '7mm' }}><div style={compactBox}><h3 style={{ fontSize: '14px', marginBottom: '3mm' }}>قراءة تنفيذية</h3><ul style={{ paddingRight: '5mm', fontSize: '11px', lineHeight: 2.1, margin: 0 }}><li>متوسط الدفعة المؤكدة {money(data.summary.average_verified_payment)} ومتوسط زمن المراجعة {data.summary.avg_review_hours.toLocaleString('ar-EG')} ساعة.</li><li>{count(data.summary.expiring_7_days)} اشتراكًا ينتهي خلال 7 أيام و{count(data.summary.grace_subscriptions)} داخل المهلة.</li><li>متوسط {data.summary.average_students_per_instructor.toLocaleString('ar-EG')} طالب لكل مدرس.</li><li>{count(data.summary.submitted_attempts)} محاولة دفع معلقة بقيمة {money(data.summary.pending_amount)}.</li></ul></div><div style={compactBox}><h3 style={{ fontSize: '14px', marginBottom: '3mm' }}>جودة البيانات</h3>{[['طلاب غير مرتبطين',data.summary.unassigned_students],['حسابات دون اشتراك',data.summary.tenants_without_subscription],['مراجع مكررة',data.summary.duplicate_references],['تواريخ مراجعة غير منطقية',data.summary.invalid_review_timestamps]].map(([label,value]) => <div key={String(label)} style={{ display: 'flex', justifyContent: 'space-between', padding: '3mm 0', borderBottom: '1px solid #e2e8f0', fontSize: '10px' }}><span>{label}</span><strong>{count(Number(value))}</strong></div>)}</div></div>
      <div style={{ marginTop: '7mm', ...compactBox }}><strong style={{ color: '#b45309' }}>نطاق التقرير:</strong><p style={{ fontSize: '10px', lineHeight: 1.9, margin: '2mm 0 0' }}>إيراد المنصة يعني دفعات اشتراكات المدرسين المؤكدة فقط، ولا يشمل أموال الطلاب. النسخة الخاصة بالمحلل مجمعة ولا تحتوي أسماء أو مراجع تحويل.</p></div>
    </PdfPage>
    <PdfPage page={2} title="الاتجاهات والتوزيعات">
      <h2 style={{ fontSize: '16px', marginBottom: '4mm' }}>اتجاه الإيراد</h2><div style={{ ...compactBox, marginBottom: '5mm' }}>{data.trend.map(item => <div key={item.month_key} style={{ display: 'grid', gridTemplateColumns: '22mm 1fr 32mm', alignItems: 'center', gap: '3mm', marginBottom: '2mm', fontSize: '9px' }}><span dir="ltr">{item.month_key}</span><div style={{ height: '5mm', background: '#e2e8f0', borderRadius: '2mm', overflow: 'hidden' }}><div style={{ height: '100%', width: `${Math.max(3, item.revenue / maxTrend * 100)}%`, background: 'linear-gradient(90deg,#4f46e5,#10b981)' }} /></div><strong>{money(item.revenue)}</strong></div>)}</div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '5mm' }}><div style={compactBox}><h3 style={{ fontSize: '13px' }}>حالات الاشتراك</h3><table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '9px' }}><tbody>{data.subscription_breakdown.map(item => <tr key={item.label}><td style={{ padding: '2mm', borderBottom: '1px solid #e2e8f0' }}>{subscriptionLabels[item.label] || item.label}</td><td style={{ padding: '2mm', textAlign: 'center', borderBottom: '1px solid #e2e8f0' }}>{count(item.count)}</td><td style={{ padding: '2mm', textAlign: 'left', borderBottom: '1px solid #e2e8f0' }}>{money(item.amount)}</td></tr>)}</tbody></table></div><div style={compactBox}><h3 style={{ fontSize: '13px' }}>وسائل الدفع</h3><table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '9px' }}><tbody>{data.payment_methods.map(item => <tr key={item.label}><td style={{ padding: '2mm', borderBottom: '1px solid #e2e8f0' }}>{methodLabels[item.label] || item.label}</td><td style={{ padding: '2mm', textAlign: 'center', borderBottom: '1px solid #e2e8f0' }}>{item.verified}/{item.attempts}</td><td style={{ padding: '2mm', textAlign: 'left', borderBottom: '1px solid #e2e8f0' }}>{money(item.revenue)}</td></tr>)}</tbody></table></div></div>
      <div style={{ marginTop: '5mm', ...compactBox }}><h3 style={{ fontSize: '13px' }}>شرائح أحجام المدرسين</h3><div style={{ display: 'grid', gridTemplateColumns: 'repeat(5,1fr)', gap: '2mm', marginTop: '3mm' }}>{data.instructor_portfolio.map(item => <div key={item.bucket} style={{ padding: '3mm', background: '#eef2ff', borderRadius: '2mm', textAlign: 'center' }}><strong dir="ltr">{item.bucket}</strong><div style={{ fontSize: '9px', marginTop: '1mm' }}>{item.instructors} مدرس</div><div style={{ fontSize: '8px', color: '#64748b' }}>{item.students} طالب</div></div>)}</div></div>
      <h2 style={{ fontSize: '16px', margin: '6mm 0 4mm' }}>نسب تشغيلية رئيسية</h2><div style={{ display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: '3mm' }}>{[
        ['قبول الدفع', percent(data.summary.payment_approval_rate)], ['طلاب أونلاين', percent(data.summary.students ? data.summary.online_students/data.summary.students*100 : null)], ['أنشطة نشطة', percent(data.summary.total_tenants ? data.summary.active_tenants/data.summary.total_tenants*100 : null)], ['متوسط الطلاب', data.summary.average_students_per_instructor.toLocaleString('ar-EG')],
      ].map(([label,value]) => <div key={String(label)} style={{ ...compactBox, textAlign: 'center' }}><div style={{ color: '#64748b', fontSize: '9px' }}>{label}</div><strong style={{ display: 'block', color: '#0f766e', fontSize: '15px', marginTop: '2mm' }}>{value}</strong></div>)}</div>
      <div style={{ marginTop: '6mm', padding: '5mm', borderRadius: '3mm', borderRight: '4px solid #4f46e5', background: '#eef2ff' }}><h3 style={{ fontSize: '13px', margin: 0 }}>قراءة التحليل</h3><p style={{ fontSize: '10px', lineHeight: 2, margin: '2mm 0 0' }}>تعتمد المقارنة الزمنية على تاريخ اعتماد الدفعة. الرسم الدائري يعرض الجزء من الكل، بينما تُستخدم الأعمدة عند مقارنة أحجام مختلفة. إذا كانت بعض الفئات غير ظاهرة فهذا يعني أن قاعدة البيانات لا تحتوي سجلات منها خلال الفترة المختارة.</p></div>
    </PdfPage>
    <PdfPage page={3} title="السيناريوهات والحسابات">
      <h2 style={{ fontSize: '16px', marginBottom: '4mm' }}>سيناريو What-if</h2><div style={{ display: 'grid', gridTemplateColumns: 'repeat(3,1fr)', gap: '3mm', marginBottom: '6mm' }}>{[
        ['مدرسون جدد مفترضون', scenario.newInstructors], ['متوسط سعر الخطة', money(scenario.planPrice)], ['تحويل المعلق', `${scenario.pendingConversion}%`], ['مخاطر عدم التجديد', `${scenario.churnRisk}%`], ['إيراد متوقع', money(projectedRevenue)], ['الفارق عن الهدف', money(projectedRevenue-scenario.targetRevenue)],
      ].map(([label,value]) => <div key={String(label)} style={compactBox}><div style={{ color: '#64748b', fontSize: '9px' }}>{label}</div><strong style={{ display: 'block', marginTop: '2mm', fontSize: '14px', color: '#312e81' }}>{value}</strong></div>)}</div>
      <h2 style={{ fontSize: '16px', marginBottom: '4mm' }}>الحسابات المحفوظة</h2><div style={{ ...compactBox, marginBottom: '6mm' }}>{calculations.length === 0 ? <p style={{ fontSize: '10px' }}>لا توجد حسابات مخصصة محفوظة.</p> : calculations.map(item => <div key={item.id} style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 35mm', gap: '3mm', padding: '3mm 0', borderBottom: '1px solid #e2e8f0', fontSize: '9px' }}><strong>{item.name}</strong><span>{metricCatalog.find(metric => metric.key===item.left_metric)?.label} · {operatorLabels[item.operator]}</span><strong style={{ textAlign: 'left' }}>{formatCalculated(calculate(item,data.summary),item.result_format)}</strong></div>)}</div>
      <div style={{ marginBottom: '6mm', ...compactBox }}><div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '10px', marginBottom: '2mm' }}><strong>التقدم نحو هدف الإيراد</strong><span>{percent(scenario.targetRevenue ? projectedRevenue/scenario.targetRevenue*100 : null)}</span></div><div style={{ height: '6mm', borderRadius: '3mm', overflow: 'hidden', background: '#e2e8f0' }}><div style={{ height: '100%', width: `${Math.min(100, scenario.targetRevenue ? projectedRevenue/scenario.targetRevenue*100 : 0)}%`, background: 'linear-gradient(90deg,#4f46e5,#10b981)' }} /></div></div>
      <h2 style={{ fontSize: '16px', marginBottom: '4mm' }}>توصيات المتابعة</h2><div style={{ display: 'grid', gridTemplateColumns: 'repeat(3,1fr)', gap: '3mm', marginBottom: '6mm' }}>{[
        ['التجديد', `${data.summary.expiring_7_days} اشتراكًا خلال 7 أيام`, 'إعداد قائمة متابعة قبل موعد الانتهاء.'],
        ['التحصيل', money(data.summary.pending_amount), 'فحص المحاولات المعلقة حسب الأقدمية.'],
        ['جودة البيانات', `${data.summary.unassigned_students+data.summary.tenants_without_subscription+data.summary.duplicate_references+data.summary.invalid_review_timestamps} ملاحظة`, 'معالجة الاستثناءات قبل اعتماد قرارات الإدارة.'],
      ].map(([title,value,help]) => <div key={String(title)} style={compactBox}><strong style={{ color: '#4f46e5', fontSize: '11px' }}>{title}</strong><div style={{ fontWeight: 700, fontSize: '12px', margin: '2mm 0' }}>{value}</div><p style={{ color: '#64748b', fontSize: '8px', lineHeight: 1.7, margin: 0 }}>{help}</p></div>)}</div>
      <h2 style={{ fontSize: '16px', marginBottom: '4mm' }}>تعريفات وضوابط</h2><div style={{ ...compactBox, fontSize: '10px', lineHeight: 2 }}><p><strong>الحساب المخصص:</strong> عملية بعد تحميل البيانات لأغراض الاستكشاف، ولا تغيّر القيود أو المدفوعات.</p><p><strong>الإيراد المتوقع:</strong> إيراد الشهر الحالي + قيمة المدرسين الجدد المفترضة + الجزء المتوقع تحصيله من المعلّق.</p><p><strong>المخاطر:</strong> عدد الاشتراكات النشطة × نسبة عدم التجديد المفترضة.</p><p><strong>المصدر الرسمي:</strong> المؤشرات الأساسية من الخادم؛ السيناريوهات والحسابات المخصصة موضحة منفصلة حتى لا تختلط بالنتائج الفعلية.</p></div>
    </PdfPage>
  </div>;
}

export type AdminAnalyticsView = 'overview' | 'charts' | 'scenarios' | 'reports' | 'governance';

const analyticsViewCopy: Record<AdminAnalyticsView, { eyebrow: string; title: string; description: string }> = {
  overview: { eyebrow: 'مركز قيادة التحليلات', title: 'النظرة التنفيذية', description: 'أهم مؤشرات الإيراد والاشتراكات والنمو والتحصيل في شاشة سريعة لاتخاذ القرار.' },
  charts: { eyebrow: 'التحليل البصري', title: 'الاتجاهات والتوزيعات', description: 'رسوم زمنية ومقارنات وتوزيعات توضح تغير الإيراد وكفاءة الدفع ومخاطر التجديد.' },
  scenarios: { eyebrow: 'مختبر المحلل', title: 'السيناريوهات والحسابات', description: 'نماذج ماذا لو وحسابات محفوظة تساعد المحلل على قياس أثر الافتراضات قبل اتخاذ القرار.' },
  reports: { eyebrow: 'مركز التقارير', title: 'التقارير والتصدير', description: 'إنشاء ملفات PDF وCSV موثقة، مع عرض تفاصيل الدفعات فقط للأدوار المصرح لها.' },
  governance: { eyebrow: 'حوكمة البيانات', title: 'جودة البيانات وقاموس المؤشرات', description: 'كشف مشاكل البيانات وتوحيد تعريف المؤشرات حتى تبقى التقارير قابلة للمراجعة والمقارنة.' },
};

const financeCache = new Map<number, { data: AdminFinanceData; expiresAt: number }>();
const FINANCE_CACHE_TTL_MS = 30_000;

export default function AdminFinance({ view = 'overview' }: { view?: AdminAnalyticsView }) {
  const [data, setData] = useState<AdminFinanceData | null>(null);
  const [calculations, setCalculations] = useState<AnalystCalculation[]>([]);
  const [months, setMonths] = useState(12);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [exporting, setExporting] = useState(false);
  const [pdfExporting, setPdfExporting] = useState(false);
  const [calculationBusy, setCalculationBusy] = useState(false);
  const [calculationForm, setCalculationForm] = useState({ name: '', left_metric: 'revenue_month', operator: 'add' as AnalystCalculation['operator'], right_source: 'metric', right_metric: 'revenue_previous_month', constant_value: '', result_format: 'money' as AnalystCalculation['result_format'] });
  const [scenario, setScenario] = useState({ newInstructors: '5', planPrice: '350', pendingConversion: '70', churnRisk: '10', targetRevenue: '10000' });
  const [videoCommission, setVideoCommission] = useState({ percent: '2.00', can_manage: false, updated_at: null as string | null });
  const load = async (force = false) => {
    setLoading(true); setError(null);
    try {
      const cached = financeCache.get(months);
      if (!force && cached && cached.expiresAt > Date.now()) {
        setData(cached.data);
        return;
      }
      const freshData = await getAdminFinance(months);
      financeCache.set(months, { data: freshData, expiresAt: Date.now() + FINANCE_CACHE_TTL_MS });
      setData(freshData);
    }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'تعذر تحميل التقرير التحليلي'); }
    finally { setLoading(false); }
  };
  useEffect(() => { void load(); }, [months]);
  useEffect(() => {
    if (view !== 'overview') return;
    getVideoCommission().then(value => setVideoCommission({ percent: String(value.percent), can_manage: value.can_manage, updated_at: value.updated_at })).catch(() => undefined);
  }, [view]);
  useEffect(() => {
    if (!data?.can_calculate || (view !== 'scenarios' && view !== 'reports')) return;
    getAnalystCalculations().then(setCalculations).catch(cause => setError(cause instanceof Error ? cause.message : 'تعذر تحميل الحسابات المحفوظة'));
  }, [data?.can_calculate, view]);
  const exportReport = async () => {
    setExporting(true); setError(null); setNotice(null);
    try { await downloadAdminFinanceReport(months); setNotice('تم إنشاء ملف التحليلات وتنزيله، وسُجل التصدير في سجل التدقيق.'); }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'تعذر تنزيل التقرير'); }
    finally { setExporting(false); }
  };
  const saveCalculation = async () => {
    setCalculationBusy(true); setError(null);
    try {
      await createAnalystCalculation({
        name: calculationForm.name.trim(), left_metric: calculationForm.left_metric,
        operator: calculationForm.operator,
        right_metric: calculationForm.right_source === 'metric' ? calculationForm.right_metric : null,
        constant_value: calculationForm.right_source === 'constant' ? calculationForm.constant_value : null,
        result_format: calculationForm.result_format,
      });
      setCalculations(await getAnalystCalculations());
      setCalculationForm(current => ({ ...current, name: '' }));
      setNotice('تم حفظ الحساب التحليلي على حسابك.');
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'تعذر حفظ الحساب'); }
    finally { setCalculationBusy(false); }
  };
  const removeCalculation = async (id: string) => {
    try { await deleteAnalystCalculation(id); setCalculations(current => current.filter(item => item.id !== id)); }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'تعذر حذف الحساب'); }
  };
  const numericScenario = {
    newInstructors: Math.max(0, Number(scenario.newInstructors) || 0), planPrice: Math.max(0, Number(scenario.planPrice) || 0),
    pendingConversion: Math.min(100, Math.max(0, Number(scenario.pendingConversion) || 0)), churnRisk: Math.min(100, Math.max(0, Number(scenario.churnRisk) || 0)),
    targetRevenue: Math.max(0, Number(scenario.targetRevenue) || 0),
  };
  const scenarioResults = data ? {
    newRevenue: numericScenario.newInstructors * numericScenario.planPrice,
    recoverablePending: data.summary.pending_amount * numericScenario.pendingConversion / 100,
    subscriptionsAtRisk: data.summary.active_subscriptions * numericScenario.churnRisk / 100,
    projectedRevenue: data.summary.revenue_month + numericScenario.newInstructors * numericScenario.planPrice + data.summary.pending_amount * numericScenario.pendingConversion / 100,
  } : null;
  const exportPdf = async () => {
    if (!data) return;
    setPdfExporting(true); setError(null); setNotice(null);
    try {
      await document.fonts?.ready;
      const [{ default: html2canvas }, { jsPDF }] = await Promise.all([import('html2canvas'), import('jspdf')]);
      const pages = Array.from(document.querySelectorAll<HTMLElement>('[data-pdf-page]'));
      if (!pages.length) throw new Error('لم يتم تجهيز صفحات التقرير');
      const pdf = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4', compress: true });
      for (let index = 0; index < pages.length; index += 1) {
        if (index > 0) pdf.addPage('a4', 'portrait');
        const page = pages[index];
        const canvas = await html2canvas(page, { scale: 2, backgroundColor: '#ffffff', useCORS: true, logging: false, width: page.scrollWidth, height: page.scrollHeight, windowWidth: page.scrollWidth, windowHeight: page.scrollHeight });
        pdf.addImage(canvas.toDataURL('image/jpeg', 0.95), 'JPEG', 0, 0, 210, 297, undefined, 'FAST');
      }
      pdf.save(`platform-analytics-${new Date().toISOString().slice(0, 10)}.pdf`);
      await recordAnalystPdfExport(months, calculations.length);
      setNotice('تم إنشاء تقرير PDF منظم في 3 صفحات A4 وتسجيل عملية التصدير.');
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'تعذر إنشاء ملف PDF'); }
    finally { setPdfExporting(false); }
  };
  const maxRevenue = useMemo(() => Math.max(1, ...(data?.trend.map(item => item.revenue) || [1])), [data]);
  const maxSubscriptionCount = useMemo(() => Math.max(1, ...(data?.subscription_breakdown.map(item => item.count) || [1])), [data]);
  const viewCopy = analyticsViewCopy[view];

  return <div className="min-h-screen bg-slate-50" dir="rtl"><Header /><main className="main-content min-h-screen p-4 md:p-8"><div className="mx-auto max-w-7xl space-y-6">
    <header className="overflow-hidden rounded-3xl border border-indigo-100 bg-white p-6 shadow-sm"><div className="flex flex-wrap items-start justify-between gap-4"><div><p className="text-sm font-semibold text-indigo-600">{viewCopy.eyebrow}</p><h1 className="mt-1 text-3xl font-black text-slate-950">{viewCopy.title}</h1><p className="mt-2 max-w-3xl text-slate-600">{viewCopy.description}</p></div><div className="flex flex-wrap gap-2"><select aria-label="الفترة التحليلية" className="rounded-xl border bg-white px-3 py-2 text-sm" value={months} onChange={event => setMonths(Number(event.target.value))}><option value={3}>آخر 3 أشهر</option><option value={6}>آخر 6 أشهر</option><option value={12}>آخر 12 شهرًا</option><option value={24}>آخر 24 شهرًا</option></select><Button variant="outline" onClick={() => void load(true)} disabled={loading}><RefreshCw className={`ml-2 h-4 w-4 ${loading ? 'animate-spin' : ''}`} />تحديث</Button>{view === 'reports' && data?.can_export && <Button variant="outline" onClick={() => void exportReport()} disabled={exporting}><Download className="ml-2 h-4 w-4" />{exporting ? 'جارٍ إنشاء CSV...' : 'تنزيل CSV'}</Button>}{view === 'reports' && data?.can_export_pdf && <Button onClick={() => void exportPdf()} disabled={pdfExporting || !data}><FileText className="ml-2 h-4 w-4" />{pdfExporting ? 'جارٍ تجهيز PDF...' : 'تقرير PDF احترافي'}</Button>}</div></div></header>

    {view === 'overview' && <div className="rounded-xl border border-blue-200 bg-blue-50 p-4 text-sm leading-7 text-blue-950"><strong>مساحة عمل حسب الدور:</strong> الـAnalyst يرى المؤشرات المجمعة والسيناريوهات والتقارير دون أسماء المدرسين أو مراجع التحويل. Billing وSuper Admin يريان التفاصيل المالية المصرح بها، وكل تصدير يُسجل في سجل التدقيق.</div>}
    {error && <div role="alert" className="rounded-lg border border-red-200 bg-red-50 p-4 text-red-800">{error}</div>}
    {notice && <div role="status" className="rounded-lg border border-emerald-200 bg-emerald-50 p-4 text-emerald-800">{notice}</div>}

    {view === 'overview' && <Card><CardHeader><CardTitle>عمولة بيع الفيديوهات بين المدرسين</CardTitle><p className="text-sm text-slate-500">تُحفظ النسبة مع كل عملية شراء؛ تغييرها لا يؤثر على العمليات السابقة.</p></CardHeader><CardContent className="flex flex-wrap items-end gap-3"><label className="space-y-1 text-sm"><span>النسبة المئوية</span><Input className="w-40" type="number" min="0" max="100" step="0.01" value={videoCommission.percent} disabled={!videoCommission.can_manage} onChange={event => setVideoCommission(current => ({ ...current, percent: event.target.value }))} /></label><Button disabled={!videoCommission.can_manage || Number(videoCommission.percent) < 0 || Number(videoCommission.percent) > 100} onClick={() => void (async () => { try { const saved = await updateVideoCommission(Number(videoCommission.percent)); setVideoCommission(current => ({ ...current, percent: saved.percent.toFixed(2) })); setNotice('تم تحديث عمولة الفيديوهات للعمليات الجديدة.'); } catch (cause) { setError(cause instanceof Error ? cause.message : 'تعذر حفظ العمولة'); } })()}><Save className="ml-2 h-4 w-4" />حفظ العمولة</Button>{!videoCommission.can_manage && <p className="text-xs text-slate-500">للقراءة فقط حسب صلاحيتك.</p>}</CardContent></Card>}

    {view === 'overview' && <section><div className="mb-3 flex items-center gap-2"><TrendingUp className="h-5 w-5 text-indigo-600" /><h2 className="text-xl font-bold">الملخص التنفيذي</h2></div><div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
      {data && <><MetricCard label="إيراد هذا الشهر" value={money(data.summary.revenue_month)} help={`الشهر السابق: ${money(data.summary.revenue_previous_month)} · التغير ${percent(data.summary.revenue_growth_percent)}`} tone="emerald" />
      <MetricCard label="إجمالي الإيراد المؤكد" value={money(data.summary.revenue_total)} help="مجموع دفعات اشتراك المدرسين التي اعتمدها مسؤول مخول فقط." tone="emerald" />
      <MetricCard label="التحصيل النقدي المعتمد" value={money(data.summary.cash_collected_total)} help={`يشمل شحن رصيد الخدمات المعتمد (${money(data.summary.topup_cash_collected)}) حتى لو لم يُستخدم كله في التجديد بعد.`} tone="blue" />
      <MetricCard label="رصيد خدمات غير مستخدم" value={money(data.summary.unused_service_credit)} help="التزام خدمات قائم للمدرسين؛ ليس إيراد اشتراك حتى يُخصم عند التجديد أو استخدام خدمة." tone="amber" />
      <MetricCard label="نسبة قبول محاولات الدفع" value={percent(data.summary.payment_approval_rate)} help={`${count(data.summary.verified_attempts)} مؤكدة مقابل ${count(data.summary.rejected_attempts)} مرفوضة؛ المعلّقة لا تدخل في النسبة.`} tone="blue" />
      <MetricCard label="متوسط الدفعة المؤكدة" value={money(data.summary.average_verified_payment)} help="إجمالي الإيراد المؤكد ÷ عدد الدفعات المؤكدة." />
      <MetricCard label="اشتراكات تشغيلية" value={count(data.summary.active_subscriptions)} help={`من أصل ${count(data.summary.total_subscriptions)} فترة اشتراك مسجلة.`} tone="blue" />
      <MetricCard label="تنتهي خلال 7 أيام" value={count(data.summary.expiring_7_days)} help={`${count(data.summary.expiring_30_days)} اشتراكًا ينتهي خلال 30 يومًا ويحتاج تخطيط تجديد.`} tone="amber" />
      <MetricCard label="حسابات مدرسين جديدة" value={count(data.summary.new_tenants_month)} help={`مقارنة بالشهر السابق: ${percent(data.summary.tenant_growth_percent)}.`} tone="indigo" />
      <MetricCard label="زمن مراجعة الدفع" value={`${data.summary.avg_review_hours.toLocaleString('ar-EG')} ساعة`} help="متوسط الوقت من تسجيل محاولة الدفع حتى قبولها أو رفضها." tone="amber" /></>}
    </div></section>}

    {view === 'charts' && <section><div className="mb-3"><h2 className="flex items-center gap-2 text-xl font-bold"><BarChart3 className="h-5 w-5 text-indigo-600" />الرسوم والتحليل البصري</h2><p className="mt-1 text-sm text-slate-500">استُخدم الـPie لعلاقات الجزء من الكل ذات الفئات القليلة، والـBar للمقارنات، والـArea للاتجاه الزمني.</p></div><div className="grid gap-6 xl:grid-cols-2">
      <Card><CardHeader><CardTitle>اتجاه الإيراد والدفعات</CardTitle></CardHeader><CardContent className="h-80" dir="ltr"><ResponsiveContainer width="100%" height="100%"><AreaChart data={data?.trend || []}><defs><linearGradient id="revenueFill" x1="0" y1="0" x2="0" y2="1"><stop offset="5%" stopColor="#4f46e5" stopOpacity={0.45}/><stop offset="95%" stopColor="#4f46e5" stopOpacity={0.04}/></linearGradient></defs><CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0"/><XAxis dataKey="month_key"/><YAxis/><Tooltip formatter={(value: number) => money(Number(value))}/><Area type="monotone" dataKey="revenue" name="الإيراد" stroke="#4f46e5" strokeWidth={3} fill="url(#revenueFill)"/></AreaChart></ResponsiveContainer></CardContent></Card>
      <Card><CardHeader><CardTitle>حالات الاشتراك — Pie</CardTitle></CardHeader><CardContent className="h-80" dir="ltr"><ResponsiveContainer width="100%" height="100%"><PieChart><Pie data={data?.subscription_breakdown || []} dataKey="count" nameKey="label" cx="50%" cy="45%" outerRadius={95} innerRadius={48} paddingAngle={2} label={({ label, percent: slicePercent }) => `${subscriptionLabels[label] || label} ${(slicePercent * 100).toFixed(0)}%`}>{data?.subscription_breakdown.map((item,index)=><Cell key={item.label} fill={chartColors[index%chartColors.length]}/>)}</Pie><Tooltip formatter={(value:number)=>count(Number(value))}/><Legend formatter={value=>subscriptionLabels[String(value)]||String(value)}/></PieChart></ResponsiveContainer></CardContent></Card>
      <Card><CardHeader><CardTitle>كفاءة وسائل الدفع — Bar</CardTitle></CardHeader><CardContent className="h-80" dir="ltr"><ResponsiveContainer width="100%" height="100%"><BarChart data={(data?.payment_methods || []).map(item=>({...item,display:methodLabels[item.label]||item.label}))}><CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0"/><XAxis dataKey="display"/><YAxis/><Tooltip/><Legend/><Bar dataKey="attempts" name="المحاولات" fill="#cbd5e1" radius={[5,5,0,0]}/><Bar dataKey="verified" name="المؤكد" fill="#10b981" radius={[5,5,0,0]}/></BarChart></ResponsiveContainer></CardContent></Card>
      <Card><CardHeader><CardTitle>شرائح أحجام المدرسين — Bar</CardTitle></CardHeader><CardContent className="h-80" dir="ltr"><ResponsiveContainer width="100%" height="100%"><BarChart data={data?.instructor_portfolio || []}><CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0"/><XAxis dataKey="bucket"/><YAxis/><Tooltip/><Legend/><Bar dataKey="instructors" name="المدرسون" fill="#4f46e5" radius={[5,5,0,0]}/><Bar dataKey="students" name="الطلاب" fill="#0ea5e9" radius={[5,5,0,0]}/></BarChart></ResponsiveContainer></CardContent></Card>
    </div></section>}

    {view === 'charts' && <div className="grid gap-6 xl:grid-cols-3"><Card className="xl:col-span-2"><CardHeader><CardTitle className="flex items-center gap-2"><BarChart3 className="h-5 w-5 text-indigo-600" />جدول اتجاه الإيراد خلال {months} شهرًا</CardTitle><p className="text-sm text-slate-500">حسب تاريخ اعتماد الدفعة، وليس تاريخ إرسالها.</p></CardHeader><CardContent className="space-y-3">{!data?.trend.length ? <p className="py-10 text-center text-slate-500">لا توجد دفعات مؤكدة في هذه الفترة.</p> : data.trend.map(item => <div key={item.month_key} className="grid grid-cols-[5rem_1fr_auto] items-center gap-3"><span dir="ltr" className="text-sm text-slate-600">{item.month_key}</span><div className="h-8 overflow-hidden rounded bg-slate-100"><div className="flex h-full items-center justify-end rounded bg-gradient-to-l from-indigo-500 to-emerald-500 px-2 text-xs text-white" style={{ width: `${Math.max(8, (item.revenue / maxRevenue) * 100)}%` }}>{money(item.revenue)}</div></div><span className="w-24 text-left text-xs text-slate-500">{count(item.payments)} دفعة</span></div>)}</CardContent></Card>
      <Card><CardHeader><CardTitle>مخاطر التجديد</CardTitle><p className="text-sm text-slate-500">حالات تحتاج متابعة تشغيلية.</p></CardHeader><CardContent className="space-y-3">{data && [
        ['معلّق', data.summary.pending_subscriptions, 'bg-amber-500'], ['مستحق', data.summary.past_due_subscriptions, 'bg-orange-500'], ['داخل المهلة', data.summary.grace_subscriptions, 'bg-rose-500'], ['منتهي', data.summary.expired_subscriptions, 'bg-slate-500'],
      ].map(([label, value, color]) => <div key={String(label)} className="flex items-center justify-between rounded-lg border p-3"><div className="flex items-center gap-2"><span className={`h-2.5 w-2.5 rounded-full ${color}`} /><span>{label}</span></div><strong>{count(Number(value))}</strong></div>)}</CardContent></Card></div>}

    {view === 'charts' && <div className="grid gap-6 lg:grid-cols-2"><Card><CardHeader><CardTitle>توزيع حالات الاشتراك</CardTitle><p className="text-sm text-slate-500">العدد والقيمة المتعاقد عليها لكل حالة، وليست إيرادًا محققًا.</p></CardHeader><CardContent className="space-y-4">{data?.subscription_breakdown.map(item => <div key={item.label}><div className="mb-1 flex justify-between text-sm"><span>{subscriptionLabels[item.label] || item.label}</span><span>{count(item.count)} · {money(item.amount)}</span></div><div className="h-2 rounded bg-slate-100"><div className="h-2 rounded bg-indigo-500" style={{ width: `${(item.count / maxSubscriptionCount) * 100}%` }} /></div></div>)}</CardContent></Card>
      <Card><CardHeader><CardTitle>كفاءة وسائل الدفع</CardTitle><p className="text-sm text-slate-500">تُستخدم لمعرفة القنوات الأكثر استخدامًا ونجاحًا.</p></CardHeader><CardContent className="overflow-x-auto"><table className="w-full text-sm"><thead><tr className="border-b text-slate-500"><th className="p-2 text-right">الوسيلة</th><th className="p-2">المحاولات</th><th className="p-2">المؤكد</th><th className="p-2">نسبة النجاح</th><th className="p-2 text-left">الإيراد</th></tr></thead><tbody>{data?.payment_methods.map(item => <tr key={item.label} className="border-b last:border-0"><td className="p-2">{methodLabels[item.label] || item.label}</td><td className="p-2 text-center">{count(item.attempts)}</td><td className="p-2 text-center">{count(item.verified)}</td><td className="p-2 text-center">{percent(item.attempts ? Number(((item.verified / item.attempts) * 100).toFixed(1)) : null)}</td><td className="p-2 text-left font-medium">{money(item.revenue)}</td></tr>)}</tbody></table></CardContent></Card></div>}

    {view === 'overview' && <section><div className="mb-3 flex items-center gap-2"><Users className="h-5 w-5 text-indigo-600" /><h2 className="text-xl font-bold">حجم الأعمال وقاعدة المستخدمين</h2></div><div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
      {data && <><MetricCard label="المدرسون" value={count(data.summary.instructors)} help={`${count(data.summary.active_tenants)} نشاطًا نشطًا و${count(data.summary.suspended_tenants)} موقوفًا.`} />
      <MetricCard label="الطلاب المرتبطون" value={count(data.summary.students)} help={`${count(data.summary.online_students)} أونلاين و${count(data.summary.offline_students)} أوفلاين.`} tone="blue" />
      <MetricCard label="متوسط الطلاب لكل مدرس" value={data.summary.average_students_per_instructor.toLocaleString('ar-EG')} help="إجمالي الطلاب النشطين المرتبطين ÷ عدد حسابات المدرسين." tone="emerald" />
      <MetricCard label="مبالغ قيد المراجعة" value={money(data.summary.pending_amount)} help={`${count(data.summary.submitted_attempts)} محاولة دفع لم تُعتمد أو تُرفض بعد.`} tone="amber" /></>}
    </div></section>}

    {view === 'governance' && <div className="grid gap-6 lg:grid-cols-2"><Card><CardHeader><CardTitle>توزيع أحجام المدرسين</CardTitle><p className="text-sm text-slate-500">شرائح مجمعة حسب عدد الطلاب، دون إظهار أسماء المدرسين.</p></CardHeader><CardContent className="space-y-3">{data?.instructor_portfolio.map(item => <div key={item.bucket} className="flex items-center justify-between rounded-lg border p-3"><div><strong dir="ltr">{item.bucket}</strong><p className="text-xs text-slate-500">طالب لكل مدرس</p></div><div className="text-left"><p>{count(item.instructors)} مدرس</p><p className="text-xs text-slate-500">{count(item.students)} طالب</p></div></div>)}</CardContent></Card>
      <Card><CardHeader><CardTitle className="flex items-center gap-2"><CircleAlert className="h-5 w-5 text-amber-600" />جودة البيانات والمتابعة</CardTitle><p className="text-sm text-slate-500">مشكلات تقلل دقة التقارير أو تحتاج مراجعة تشغيلية.</p></CardHeader><CardContent className="space-y-3">{data && [
        ['طلاب غير مرتبطين بمدرس', data.summary.unassigned_students, 'يجب توزيعهم أو مراجعة سبب فك الارتباط.'],
        ['حسابات دون سجل اشتراك', data.summary.tenants_without_subscription, 'حسابات قديمة أو ترحيل غير مكتمل.'],
        ['مراجع دفع مكررة', data.summary.duplicate_references, 'تحتاج مراجعة لمنع احتساب التحويل مرتين.'],
        ['تواريخ مراجعة غير منطقية', data.summary.invalid_review_timestamps, 'تُستبعد من متوسط زمن المراجعة حتى لا تضلل التقارير.'],
      ].map(([label, value, help]) => <div key={String(label)} className={`rounded-lg border p-3 ${Number(value) > 0 ? 'border-amber-200 bg-amber-50' : 'border-emerald-200 bg-emerald-50'}`}><div className="flex justify-between"><strong>{label}</strong><Badge variant="outline">{count(Number(value))}</Badge></div><p className="mt-1 text-xs text-slate-600">{help}</p></div>)}</CardContent></Card></div>}

    {view === 'scenarios' && data?.can_calculate && <section className="space-y-4"><div><h2 className="flex items-center gap-2 text-xl font-bold"><Calculator className="h-5 w-5 text-violet-600" />معمل الحسابات والسيناريوهات</h2><p className="mt-1 text-sm text-slate-500">عمليات استكشافية يجريها المحلل بنفسه بعد تحميل البيانات. لا تغيّر المدفوعات أو الاشتراكات الحقيقية، وتظل منفصلة عن المؤشرات الرسمية.</p></div>
      <div className="grid gap-6 xl:grid-cols-2"><Card><CardHeader><CardTitle>What-if — ماذا لو؟</CardTitle><p className="text-sm text-slate-500">غيّر الافتراضات وشاهد الأثر فورًا على الإيراد والمخاطر.</p></CardHeader><CardContent className="space-y-4"><div className="grid gap-3 sm:grid-cols-2">
        {[['newInstructors','مدرسون جدد مفترضون'],['planPrice','متوسط سعر الخطة'],['pendingConversion','نسبة تحويل المعلّق %'],['churnRisk','نسبة عدم التجديد المتوقعة %'],['targetRevenue','هدف الإيراد الشهري']].map(([key,label]) => <label key={key} className="space-y-1 text-sm"><span>{label}</span><Input type="number" min="0" max={key==='pendingConversion'||key==='churnRisk'?'100':undefined} value={scenario[key as keyof typeof scenario]} onChange={event=>setScenario(current=>({...current,[key]:event.target.value}))}/></label>)}
      </div>{scenarioResults && <div className="grid gap-3 sm:grid-cols-2"><div className="rounded-lg bg-indigo-50 p-3"><p className="text-xs text-indigo-700">إيراد المدرسين الجدد</p><strong>{money(scenarioResults.newRevenue)}</strong></div><div className="rounded-lg bg-emerald-50 p-3"><p className="text-xs text-emerald-700">قابل للتحصيل من المعلق</p><strong>{money(scenarioResults.recoverablePending)}</strong></div><div className="rounded-lg bg-amber-50 p-3"><p className="text-xs text-amber-800">اشتراكات معرضة لعدم التجديد</p><strong>{scenarioResults.subscriptionsAtRisk.toLocaleString('ar-EG',{maximumFractionDigits:1})}</strong></div><div className="rounded-lg bg-violet-50 p-3"><p className="text-xs text-violet-700">الإيراد المتوقع</p><strong>{money(scenarioResults.projectedRevenue)}</strong><p className={`text-xs ${scenarioResults.projectedRevenue>=numericScenario.targetRevenue?'text-emerald-700':'text-rose-700'}`}>الفارق عن الهدف: {money(scenarioResults.projectedRevenue-numericScenario.targetRevenue)}</p></div></div>}</CardContent></Card>
      <Card><CardHeader><CardTitle>إنشاء عملية حسابية</CardTitle><p className="text-sm text-slate-500">اختر مؤشرين أو مؤشرًا ورقمًا ثابتًا، ثم احفظ العملية على حسابك.</p></CardHeader><CardContent className="space-y-3"><Input placeholder="اسم واضح، مثل: فجوة الإيراد" value={calculationForm.name} onChange={event=>setCalculationForm(current=>({...current,name:event.target.value}))}/><div className="grid gap-3 sm:grid-cols-2"><select className="rounded-md border bg-white p-2" value={calculationForm.left_metric} onChange={event=>setCalculationForm(current=>({...current,left_metric:event.target.value}))}>{metricCatalog.map(metric=><option key={metric.key} value={metric.key}>{metric.label}</option>)}</select><select className="rounded-md border bg-white p-2" value={calculationForm.operator} onChange={event=>setCalculationForm(current=>({...current,operator:event.target.value as AnalystCalculation['operator']}))}>{Object.entries(operatorLabels).map(([key,label])=><option key={key} value={key}>{label}</option>)}</select></div><div className="grid gap-3 sm:grid-cols-[9rem_1fr]"><select className="rounded-md border bg-white p-2" value={calculationForm.right_source} onChange={event=>setCalculationForm(current=>({...current,right_source:event.target.value}))}><option value="metric">مؤشر آخر</option><option value="constant">رقم ثابت</option></select>{calculationForm.right_source==='metric'?<select className="rounded-md border bg-white p-2" value={calculationForm.right_metric} onChange={event=>setCalculationForm(current=>({...current,right_metric:event.target.value}))}>{metricCatalog.map(metric=><option key={metric.key} value={metric.key}>{metric.label}</option>)}</select>:<Input type="number" placeholder="القيمة الثابتة" value={calculationForm.constant_value} onChange={event=>setCalculationForm(current=>({...current,constant_value:event.target.value}))}/>}</div><div className="grid gap-3 sm:grid-cols-2"><select className="rounded-md border bg-white p-2" value={calculationForm.result_format} onChange={event=>setCalculationForm(current=>({...current,result_format:event.target.value as AnalystCalculation['result_format']}))}><option value="number">رقم</option><option value="money">مبلغ</option><option value="percent">نسبة مئوية</option></select><div className="rounded-md bg-slate-100 p-2 text-center"><span className="text-xs text-slate-500">معاينة النتيجة: </span><strong>{formatCalculated(calculate({left_metric:calculationForm.left_metric,operator:calculationForm.operator,right_metric:calculationForm.right_source==='metric'?calculationForm.right_metric:null,constant_value:calculationForm.right_source==='constant'?calculationForm.constant_value:null},data?.summary),calculationForm.result_format)}</strong></div></div><Button className="w-full" disabled={calculationBusy||calculationForm.name.trim().length<3||(calculationForm.right_source==='constant'&&!calculationForm.constant_value)} onClick={()=>void saveCalculation()}><Save className="ml-2 h-4 w-4" />حفظ العملية على حسابي</Button></CardContent></Card></div>
      <Card><CardHeader><CardTitle>حساباتي المحفوظة</CardTitle></CardHeader><CardContent>{calculations.length===0?<p className="py-6 text-center text-sm text-slate-500">لم تحفظ عمليات حسابية بعد.</p>:<div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">{calculations.map(item=><div key={item.id} className="rounded-xl border p-4"><div className="flex items-start justify-between gap-2"><div><strong>{item.name}</strong><p className="mt-1 text-xs text-slate-500">{metricCatalog.find(metric=>metric.key===item.left_metric)?.label||item.left_metric} · {operatorLabels[item.operator]}</p></div><Button variant="ghost" size="sm" className="text-red-600" onClick={()=>void removeCalculation(item.id)}><Trash2 className="h-4 w-4" /></Button></div><p className="mt-4 text-2xl font-bold text-violet-700">{formatCalculated(calculate(item,data?.summary),item.result_format)}</p></div>)}</div>}</CardContent></Card>
    </section>}

    {view === 'reports' && <Card><CardHeader><CardTitle className="flex items-center gap-2"><CreditCard className="h-5 w-5 text-emerald-600" />تفاصيل آخر الدفعات المؤكدة</CardTitle></CardHeader><CardContent className="max-h-[32rem] space-y-3 overflow-auto">{data && !data.detailed ? <div className="rounded-lg bg-slate-100 p-5 text-sm leading-7 text-slate-700"><Database className="ml-1 inline h-4 w-4" />هذه البيانات غير ظاهرة لدور Analyst لأنها تحتوي أسماء أنشطة ومراجع تحويل. ملف التصدير يحتوي بدلًا منها على المجاميع والاتجاهات والتوزيعات كاملة. يمكن لمسؤول Billing مراجعة الصفوف الفردية.</div> : !data?.recent.length ? <p className="py-8 text-center text-slate-500">لا توجد دفعات مؤكدة.</p> : data.recent.map(item => <div key={item.id} className="rounded-lg border p-3"><div className="flex justify-between gap-3"><strong>{item.business_name}</strong><span>{money(Number(item.amount))}</span></div><p className="mt-1 text-xs text-slate-500">{methodLabels[item.method] || item.method} · المرجع: {item.reference_number} · {new Date(item.reviewed_at).toLocaleString('ar-EG')}</p></div>)}</CardContent></Card>}

    {view === 'governance' && <Card><CardHeader><CardTitle className="flex items-center gap-2"><Clock3 className="h-5 w-5 text-indigo-600" />قاموس المؤشرات</CardTitle><p className="text-sm text-slate-500">تعريف ثابت حتى لا يفسر شخصان الرقم بطريقتين مختلفتين.</p></CardHeader><CardContent className="grid gap-3 md:grid-cols-2">{[
      ['إيراد المنصة', 'دفعات اشتراكات المدرسين المؤكدة بتاريخ اعتمادها. لا يشمل أموال الطلاب.'],
      ['نسبة قبول الدفع', 'المؤكد ÷ (المؤكد + المرفوض). المحاولات المعلقة مستبعدة.'],
      ['القيمة المتعاقد عليها', 'سعر فترات الاشتراك المسجلة بعد الخصم، وقد لا تكون دُفعت أو تحققت بعد.'],
      ['الاشتراك التشغيلي', 'الفترة ذات الحالة Active فقط؛ Past Due وGrace تظهران منفصلتين.'],
      ['متوسط الطلاب', 'الطلاب النشطون المرتبطون ÷ جميع حسابات المدرسين، بما فيها الحسابات ذات صفر طلاب.'],
      ['نمو الحسابات', 'عدد حسابات النشاط المنشأة هذا الشهر مقارنة بالشهر السابق.'],
    ].map(([term, definition]) => <div key={term} className="rounded-lg border p-3"><strong>{term}</strong><p className="mt-1 text-sm leading-6 text-slate-600">{definition}</p></div>)}</CardContent></Card>}
    {data?.generated_at && <p className="text-center text-xs text-slate-400">آخر احتساب: {new Date(data.generated_at).toLocaleString('ar-EG')} · القيم المالية بالجنيه المصري</p>}
  </div>{view === 'reports' && data?.can_export_pdf && <AnalyticsPdfReport data={data} months={months} calculations={calculations} scenario={numericScenario} />}</main></div>;
}
