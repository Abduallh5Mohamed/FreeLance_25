import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import Header from '@/components/Header';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Badge } from '@/components/ui/badge';
import { createAdminWorkItem, getAdminWorkItem, getAdminWorkItems, addAdminWorkItemComment, type AdminWorkItem } from '@/lib/api';

const types = [
  ['other', 'مهمة عامة'], ['instructor_onboarding', 'تهيئة مدرس'],
  ['subscription_issue', 'مشكلة اشتراك'], ['payment_verification', 'مراجعة دفع'],
  ['support_case', 'حالة دعم'], ['technical_issue', 'مشكلة تقنية'],
];

export default function AdminOperations() {
  const canCreate = (() => { try { const profile = JSON.parse(localStorage.getItem('currentUser') || 'null'); return profile?.role === 'admin' || profile?.admin_permissions?.includes('task.create'); } catch { return false; } })();
  const [items, setItems] = useState<AdminWorkItem[]>([]);
  const [selected, setSelected] = useState<AdminWorkItem | null>(null);
  const [events, setEvents] = useState<Array<{ id: string; event_type: string; body?: string; created_at: string }>>([]);
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [type, setType] = useState('other');
  const [comment, setComment] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = async () => {
    try { setError(null); setItems((await getAdminWorkItems()).data); }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'تعذر تحميل المهام'); }
  };

  useEffect(() => { void refresh(); }, []);

  const openItem = async (id: string) => {
    try {
      const data = await getAdminWorkItem(id);
      setSelected(data.item);
      setEvents(data.events);
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'تعذر فتح المهمة'); }
  };

  const create = async () => {
    if (title.trim().length < 3) return;
    setBusy(true);
    try {
      const result = await createAdminWorkItem({ title: title.trim(), description: description.trim(), type, priority: 'normal' });
      setTitle(''); setDescription('');
      await refresh();
      await openItem(result.id);
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'تعذر إنشاء المهمة'); }
    finally { setBusy(false); }
  };

  const sendComment = async () => {
    if (!selected || !comment.trim()) return;
    setBusy(true);
    try { await addAdminWorkItemComment(selected.id, comment.trim()); setComment(''); await openItem(selected.id); }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'تعذر إضافة التعليق'); }
    finally { setBusy(false); }
  };

  return <div className="min-h-screen bg-slate-50" dir="rtl"><Header />
    <main className="main-content min-h-screen p-4 md:p-8"><div className="mx-auto max-w-7xl space-y-6">
      <header><p className="text-sm text-indigo-600">إدارة المنصة</p><h1 className="text-3xl font-bold">مركز العمليات</h1><p className="mt-2 text-slate-600">المهام والتسليمات والتعليقات الداخلية محفوظة هنا؛ المحادثة ليست بديلًا عن متابعة العمل.</p></header>
      {error && <div role="alert" className="rounded-lg border border-red-200 bg-red-50 p-3 text-red-800">{error}<Button variant="link" onClick={refresh}>إعادة المحاولة</Button></div>}
      <div className="grid gap-6 lg:grid-cols-3">
        {canCreate && <Card><CardHeader><CardTitle>مهمة جديدة</CardTitle></CardHeader><CardContent className="space-y-3">
          <select aria-label="نوع المهمة" className="w-full rounded-md border bg-white p-2" value={type} onChange={e => setType(e.target.value)}>{types.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select>
          <Input placeholder="عنوان المهمة" value={title} onChange={e => setTitle(e.target.value)} />
          <Textarea placeholder="وصف المهمة الداخلي" value={description} onChange={e => setDescription(e.target.value)} />
          <Button onClick={create} disabled={busy || title.trim().length < 3}>إنشاء مهمة</Button>
        </CardContent></Card>}
        <Card><CardHeader className="flex-row items-center justify-between"><CardTitle>قائمة المهام</CardTitle><Button variant="outline" size="sm" onClick={refresh}>تحديث</Button></CardHeader><CardContent className="max-h-[600px] space-y-2 overflow-auto">
          {items.length === 0 ? <p className="text-sm text-slate-500">لا توجد مهام ظاهرة لك.</p> : items.map(item => <button key={item.id} onClick={() => void openItem(item.id)} className="w-full rounded-lg border bg-white p-3 text-right hover:border-indigo-300"><div className="flex justify-between gap-2"><span className="font-medium">{item.title}</span><Badge variant="outline">{item.status}</Badge></div><p className="mt-1 text-xs text-slate-500">{new Date(item.created_at).toLocaleString('ar-EG')}</p></button>)}
        </CardContent></Card>
        <Card><CardHeader><CardTitle>{selected ? selected.title : 'تفاصيل المهمة'}</CardTitle></CardHeader><CardContent className="space-y-3">
          {!selected ? <p className="text-sm text-slate-500">اختر مهمة لعرض تاريخها.</p> : <><p className="text-sm">الحالة: <Badge>{selected.status}</Badge></p><div className="max-h-72 space-y-2 overflow-auto">{events.map(event => <div key={event.id} className="rounded-lg border p-2 text-sm"><p className="font-medium">{event.event_type}</p>{event.body && <p className="mt-1 whitespace-pre-wrap">{event.body}</p>}<p className="mt-1 text-xs text-slate-500">{new Date(event.created_at).toLocaleString('ar-EG')}</p></div>)}</div><Textarea aria-label="تعليق داخلي" placeholder="تعليق داخلي — لا يظهر للمدرس أو الطالب" value={comment} onChange={e => setComment(e.target.value)} /><Button onClick={sendComment} disabled={busy || !comment.trim()}>إضافة تعليق</Button></>}
        </CardContent></Card>
      </div><Button asChild variant="ghost"><Link to="/admin">العودة للوحة الإدارة</Link></Button>
    </div></main></div>;
}
