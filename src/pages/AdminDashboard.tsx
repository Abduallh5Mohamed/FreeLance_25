import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  Activity, AlertTriangle, ArrowLeft, BarChart3, CheckSquare, CreditCard, Headphones,
  ListTodo, RefreshCw, ShieldCheck, UserCog, Users, WalletCards,
} from 'lucide-react';
import Header from '@/components/Header';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { getAdminDashboard, type AdminDashboardData } from '@/lib/api';

const roleLabels: Record<string, string> = {
  super_admin: 'Super Admin', operations_admin: 'Operations', billing_admin: 'Billing',
  support_admin: 'Support', security_admin: 'Security', analyst: 'Analyst',
};

const toneClass: Record<string, string> = {
  indigo: 'bg-indigo-50 text-indigo-700', emerald: 'bg-emerald-50 text-emerald-700',
  rose: 'bg-rose-50 text-rose-700', blue: 'bg-blue-50 text-blue-700',
  amber: 'bg-amber-50 text-amber-700', orange: 'bg-orange-50 text-orange-700',
  violet: 'bg-violet-50 text-violet-700', slate: 'bg-slate-100 text-slate-700',
};

const metricIcon = (key: string) => {
  if (key.includes('revenue') || key.includes('payment')) return WalletCards;
  if (key.includes('subscription')) return CreditCard;
  if (key.includes('support')) return Headphones;
  if (key.includes('task')) return ListTodo;
  if (key.includes('approval')) return CheckSquare;
  if (key.includes('audit')) return ShieldCheck;
  if (key.includes('admin')) return UserCog;
  if (key.includes('student') || key.includes('instructor')) return Users;
  return Activity;
};

const shortcutCatalog = [
  { permission: 'instructor.read', title: 'المدرسون', description: 'الحسابات والحالة وبيانات كل مدرس.', href: '/admin/instructors', icon: Users },
  { permission: 'subscription.read', title: 'اشتراكات المنصة', description: 'الخطط والتجديدات وحالات الاشتراك.', href: '/admin/platform', icon: CreditCard },
  { permission: 'task.read', title: 'مركز العمليات', description: 'مهامك ومهام فريقك والتسليمات.', href: '/admin/operations', icon: ListTodo },
  { permission: 'approval.read', title: 'الموافقات', description: 'القرارات الحساسة المسموح لك بمراجعتها.', href: '/admin/approvals', icon: CheckSquare },
  { permission: 'support.read', title: 'الدعم', description: 'التذاكر والحالات التي تحتاج تدخلًا.', href: '/support', icon: Headphones },
  { permission: 'admin_roles.manage', title: 'فريق الإدارة', description: 'إنشاء المسؤولين وتحديد أدوارهم.', href: '/admin/team', icon: UserCog },
  { permission: 'finance.read', title: 'مركز التحليلات', description: 'الإيراد والنمو والاشتراكات وكفاءة الدفع وجودة البيانات والتصدير.', href: '/admin/finance', icon: BarChart3 },
  { permission: 'security.read', title: 'الأمان والتدقيق', description: 'مراجعة أحداث الإدارة والقرارات المسجلة.', href: '/admin/security', icon: ShieldCheck },
];

export default function AdminDashboard() {
  const [data, setData] = useState<AdminDashboardData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const load = async () => {
    setLoading(true); setError(null);
    try { setData(await getAdminDashboard()); }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'تعذر تحميل مساحة عمل الإدارة'); }
    finally { setLoading(false); }
  };
  useEffect(() => { void load(); }, []);

  const shortcuts = shortcutCatalog.filter(item => data?.permissions.includes(item.permission));
  return <div className="min-h-screen bg-slate-50" dir="rtl"><Header /><main className="main-content min-h-screen p-4 md:p-8"><div className="mx-auto max-w-7xl space-y-7">
    <header className="flex flex-wrap items-start justify-between gap-4"><div><p className="text-sm font-medium text-indigo-600">إدارة المنصة · مساحة حسب الصلاحية</p><h1 className="mt-1 text-3xl font-bold text-slate-900">{data?.title || 'لوحة الإدارة'}</h1><p className="mt-2 max-w-3xl text-slate-600">{data?.description || 'يتم تحميل الأدوات والبيانات المسموح بها لدورك فقط.'}</p><div className="mt-3 flex flex-wrap gap-2">{data?.roles.map(role => <Badge key={role} variant="outline">{roleLabels[role] || role}</Badge>)}</div></div><Button variant="outline" onClick={load} disabled={loading}><RefreshCw className={`ml-2 h-4 w-4 ${loading ? 'animate-spin' : ''}`} />تحديث</Button></header>

    <div className="rounded-xl border border-blue-200 bg-blue-50 p-4 text-sm leading-7 text-blue-950"><ShieldCheck className="ml-1 inline h-4 w-4" /><strong>لماذا تختلف هذه اللوحة بين المسؤولين؟</strong> لأن النظام يطبق أقل صلاحية لازمة للعمل. الأرقام والقوائم والأزرار التي تظهر لك صادرة من صلاحيات الخادم، وليست مجرد عناصر مخفية في الواجهة.</div>
    {error && <div role="alert" className="rounded-xl border border-red-200 bg-red-50 p-4 text-red-800">{error}<Button variant="link" className="mr-2 text-red-800" onClick={load}>إعادة المحاولة</Button></div>}

    <section aria-label="مؤشرات دوري" className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
      {loading && Array.from({ length: 4 }).map((_, index) => <Card key={index} className="animate-pulse"><CardContent className="h-28 p-5" /></Card>)}
      {!loading && data?.metrics.map(metric => { const Icon = metricIcon(metric.key); const content = <CardContent className="flex items-center gap-3 p-5"><div className={`rounded-xl p-3 ${toneClass[metric.tone || 'slate'] || toneClass.slate}`}><Icon className="h-5 w-5" /></div><div><p className="text-sm text-slate-500">{metric.label}</p><p className="text-2xl font-bold text-slate-900">{typeof metric.value === 'number' ? metric.value.toLocaleString('ar-EG') : metric.value}</p></div></CardContent>; return metric.href ? <Link key={metric.key} to={metric.href}><Card className="h-full transition hover:border-indigo-300 hover:shadow-sm">{content}</Card></Link> : <Card key={metric.key}>{content}</Card>; })}
    </section>

    {!loading && data && <section><div className="mb-3 flex items-center gap-2"><BarChart3 className="h-5 w-5 text-indigo-600" /><h2 className="text-xl font-bold">أدوات عملي</h2></div><div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">{shortcuts.map(({ permission, title, description, href, icon: Icon }) => <Card key={permission}><CardContent className="flex items-center justify-between gap-4 p-5"><div className="flex gap-3"><div className="rounded-lg bg-slate-100 p-2"><Icon className="h-5 w-5" /></div><div><h3 className="font-bold">{title}</h3><p className="mt-1 text-sm text-slate-500">{description}</p></div></div><Button asChild size="sm" variant="outline"><Link to={href}><ArrowLeft className="h-4 w-4" /></Link></Button></CardContent></Card>)}</div></section>}

    {!loading && data?.queues.length === 0 && <Card><CardContent className="p-10 text-center text-slate-500"><Activity className="mx-auto mb-3 h-10 w-10 opacity-30" /><p>لا توجد قوائم عمل تحتاج تدخلًا ضمن صلاحياتك حاليًا.</p></CardContent></Card>}
    <section className="grid gap-5 lg:grid-cols-2">{data?.queues.map(queue => <Card key={queue.key}><CardHeader className="flex-row items-center justify-between"><CardTitle>{queue.title}</CardTitle><Button asChild variant="ghost" size="sm"><Link to={queue.href}>عرض الكل<ArrowLeft className="mr-2 h-4 w-4" /></Link></Button></CardHeader><CardContent className="space-y-2">{queue.items.length === 0 ? <p className="rounded-lg bg-slate-50 p-5 text-center text-sm text-slate-500">لا توجد عناصر معلّقة.</p> : queue.items.map(item => <Link key={item.id} to={item.href} className="flex items-center justify-between gap-3 rounded-lg border p-3 transition hover:border-indigo-300"><div><p className="font-medium text-slate-900">{item.title}</p>{item.detail && <p className="mt-1 text-xs text-slate-500">{item.detail}</p>}</div><div className="text-left">{item.status && <Badge variant="outline">{item.status}</Badge>}{item.created_at && <p className="mt-1 text-xs text-slate-400">{new Date(item.created_at).toLocaleDateString('ar-EG')}</p>}</div></Link>)}</CardContent></Card>)}</section>

    {data?.metrics.some(metric => String(metric.key).includes('overdue') && Number(metric.value) > 0) && <div className="flex items-start gap-2 rounded-xl border border-rose-200 bg-rose-50 p-4 text-rose-900"><AlertTriangle className="mt-1 h-4 w-4" /><p>هناك مهام متأخرة ظاهرة لدورك. افتح مركز العمليات وحدد المسؤول والموعد التالي بدل متابعتها خارج النظام.</p></div>}
  </div></main></div>;
}
