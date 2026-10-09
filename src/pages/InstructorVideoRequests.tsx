import { useEffect, useMemo, useState } from 'react';
import { Check, Clock, Inbox, Library, Play, Search, Send, X } from 'lucide-react';
import Header from '@/components/Header';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { SecureVideoPlayer } from '@/components/SecureVideoPlayer';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Textarea } from '@/components/ui/textarea';
import { useToast } from '@/hooks/use-toast';
import {
  acceptVideoOffer, cancelVideoRequest, getGrades, getGroups, getMySentRequests,
  getReceivedRequests, getSharedWithMe, getShareableLectures,
  getVideoRequestOffers, proposeVideoOffer, publishSharedLecture, rejectVideoOffer,
  searchVideoRequestInstructors, sendVideoRequest, type Grade, type Group,
  type InstructorVideoRequest, type ShareableLecture, type SharedLecture, type VideoOffer,
} from '@/lib/api';

const labels: Record<string, string> = {
  open: 'مفتوح', awaiting_requester: 'بانتظار قرار الطالب', completed: 'مكتمل',
  cancelled_by_requester: 'ألغاه الطالب', cancelled_by_owner: 'ألغاه صاحب الفيديو',
  expired: 'منتهي', failed_insufficient_balance: 'الرصيد غير كافٍ',
};
const active = (status: string) => status === 'open' || status === 'awaiting_requester';
const remaining = (date: string) => {
  const ms = new Date(date).getTime() - Date.now();
  if (ms <= 0) return 'انتهت المهلة';
  const hours = Math.floor(ms / 3_600_000), minutes = Math.floor((ms % 3_600_000) / 60_000);
  return `${hours}س ${minutes}د`;
};

export default function InstructorVideoRequests() {
  const { toast } = useToast();
  const [sent, setSent] = useState<InstructorVideoRequest[]>([]);
  const [received, setReceived] = useState<InstructorVideoRequest[]>([]);
  const [library, setLibrary] = useState<SharedLecture[]>([]);
  const [lectures, setLectures] = useState<ShareableLecture[]>([]);
  const [grades, setGrades] = useState<Grade[]>([]);
  const [groups, setGroups] = useState<Group[]>([]);
  const [busy, setBusy] = useState(false);
  const [search, setSearch] = useState('');
  const [matches, setMatches] = useState<Array<{ id: string; name: string; phone?: string }>>([]);
  const [requestOpen, setRequestOpen] = useState(false);
  const [requestForm, setRequestForm] = useState({ owner_id: '', requested_title: '', requested_grade: '', requested_group: '', message: '' });
  const [offerRequest, setOfferRequest] = useState<InstructorVideoRequest | null>(null);
  const [offerLecture, setOfferLecture] = useState('');
  const [history, setHistory] = useState<{ request: InstructorVideoRequest; offers: VideoOffer[] } | null>(null);
  const [preview, setPreview] = useState<VideoOffer | null>(null);
  const [publishItem, setPublishItem] = useState<SharedLecture | null>(null);
  const [publishGrade, setPublishGrade] = useState('');
  const [publishGroups, setPublishGroups] = useState<string[]>([]);

  const load = async () => {
    const [a, b, c, d, e, f] = await Promise.all([getMySentRequests(''), getReceivedRequests(''), getSharedWithMe(''), getShareableLectures(), getGrades(), getGroups()]);
    setSent(a); setReceived(b); setLibrary(c); setLectures(d); setGrades(e); setGroups(f);
  };
  useEffect(() => { void load().catch(error => toast({ variant: 'destructive', title: 'تعذر تحميل الطلبات', description: error.message })); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const run = async (action: () => Promise<unknown>, message: string) => {
    setBusy(true);
    try { await action(); await load(); toast({ title: message }); }
    catch (error) { toast({ variant: 'destructive', title: 'لم تكتمل العملية', description: error instanceof Error ? error.message : 'خطأ غير متوقع' }); }
    finally { setBusy(false); }
  };

  const searchInstructors = async () => {
    if (search.trim().length < 2) return;
    try { setMatches(await searchVideoRequestInstructors(search)); }
    catch (error) { toast({ variant: 'destructive', title: 'تعذر البحث', description: error instanceof Error ? error.message : '' }); }
  };

  const openHistory = async (request: InstructorVideoRequest) => {
    try { setHistory({ request, offers: await getVideoRequestOffers(request.id) }); }
    catch (error) { toast({ variant: 'destructive', title: 'تعذر تحميل العروض', description: error instanceof Error ? error.message : '' }); }
  };

  const openPreview = async (offer: VideoOffer) => { setPreview(offer); };

  const availableGroups = useMemo(() => groups.filter(group => group.grade_id === publishGrade), [groups, publishGrade]);

  const RequestCard = ({ item, incoming = false }: { item: InstructorVideoRequest; incoming?: boolean }) => (
    <Card>
      <CardContent className="space-y-3 p-4">
        <div className="flex items-start justify-between gap-3"><div><h3 className="font-bold">{item.requested_title}</h3><p className="text-sm text-slate-500">{incoming ? item.requester_name : item.owner_name}</p></div><Badge variant="outline">{labels[item.status] || item.status}</Badge></div>
        <div className="rounded-lg bg-slate-50 p-3 text-sm"><p>الصف: {item.requested_grade}</p><p>المجموعة المطلوبة: {item.requested_group}</p>{item.message && <p className="mt-1 text-slate-600">{item.message}</p>}</div>
        {active(item.status) && <p className="flex items-center gap-1 text-xs text-amber-700"><Clock className="h-3 w-3" />متبقي: {remaining(item.expires_at)}</p>}
        {item.active_offer_title && <div className="rounded-lg border border-indigo-200 bg-indigo-50 p-3 text-sm"><strong>{item.active_offer_title}</strong><span className="mr-2">{Number(item.active_offer_price).toFixed(2)} ج.م</span></div>}
        <div className="flex flex-wrap gap-2">
          <Button size="sm" variant="outline" onClick={() => void openHistory(item)}>سجل العروض</Button>
          {incoming && item.status === 'open' && <Button size="sm" onClick={() => { setOfferRequest(item); setOfferLecture(''); }}>ترشيح فيديو</Button>}
          {!incoming && item.status === 'awaiting_requester' && item.active_offer_id && <Button size="sm" onClick={() => void openHistory(item)}><Play className="ml-1 h-4 w-4" />معاينة واتخاذ قرار</Button>}
          {active(item.status) && <Button size="sm" variant="destructive" disabled={busy} onClick={() => void run(() => cancelVideoRequest(item.id), 'تم إلغاء الطلب')}>إلغاء الطلب</Button>}
        </div>
      </CardContent>
    </Card>
  );

  return <div className="min-h-screen bg-slate-50" dir="rtl"><Header /><main className="container mx-auto space-y-6 px-4 py-8">
    <div className="flex flex-wrap items-center justify-between gap-3"><div><h1 className="text-3xl font-bold">طلبات الفيديوهات</h1><p className="text-slate-500">اطلب درسًا، راجع المعاينة، ثم انشره لمجموعاتك بعد الشراء.</p></div><Button onClick={() => setRequestOpen(true)}><Send className="ml-2 h-4 w-4" />طلب فيديو جديد</Button></div>
    <Tabs defaultValue="sent"><TabsList className="grid w-full grid-cols-3"><TabsTrigger value="sent">طلباتي</TabsTrigger><TabsTrigger value="received">الواردة</TabsTrigger><TabsTrigger value="library">المكتبة المشتركة</TabsTrigger></TabsList>
      <TabsContent value="sent" className="grid gap-4 md:grid-cols-2">{sent.length ? sent.map(item => <RequestCard key={item.id} item={item} />) : <Empty text="لم ترسل طلبات بعد" />}</TabsContent>
      <TabsContent value="received" className="grid gap-4 md:grid-cols-2">{received.length ? received.map(item => <RequestCard key={item.id} item={item} incoming />) : <Empty text="لا توجد طلبات واردة" />}</TabsContent>
      <TabsContent value="library" className="grid gap-4 md:grid-cols-2">{library.length ? library.map(item => <Card key={item.shared_lecture_id}><CardHeader><CardTitle>{item.title}</CardTitle></CardHeader><CardContent className="space-y-3"><p className="text-sm text-slate-500">صاحب الفيديو: {item.owner_name}</p><p className="text-sm">{item.is_published ? `منشور: ${item.group_names.join('، ')}` : 'غير منشور للطلاب بعد'}</p><Button size="sm" onClick={() => { setPublishItem(item); setPublishGrade(item.grade_id || ''); setPublishGroups(item.group_ids || []); }}>اختيار الصف والمجموعات</Button></CardContent></Card>) : <Empty text="لا توجد فيديوهات مشتراة" />}</TabsContent>
    </Tabs>
  </main>

  <Dialog open={requestOpen} onOpenChange={setRequestOpen}><DialogContent dir="rtl"><DialogHeader><DialogTitle>طلب فيديو جديد</DialogTitle></DialogHeader><div className="space-y-3"><div className="flex gap-2"><Input placeholder="ابحث باسم المدرس أو هاتفه" value={search} onChange={e => setSearch(e.target.value)} onKeyDown={e => e.key === 'Enter' && void searchInstructors()} /><Button variant="outline" onClick={() => void searchInstructors()}><Search className="h-4 w-4" /></Button></div>{matches.length > 0 && <div className="max-h-36 space-y-1 overflow-auto rounded border p-2">{matches.map(item => <button key={item.id} className={`block w-full rounded p-2 text-right text-sm ${requestForm.owner_id === item.id ? 'bg-indigo-100' : 'hover:bg-slate-50'}`} onClick={() => setRequestForm(current => ({ ...current, owner_id: item.id }))}>{item.name} · <span dir="ltr">{item.phone}</span></button>)}</div>}<Field label="الفيديو أو الدرس المطلوب"><Input value={requestForm.requested_title} onChange={e => setRequestForm({ ...requestForm, requested_title: e.target.value })} /></Field><Field label="الصف المطلوب"><Input value={requestForm.requested_grade} onChange={e => setRequestForm({ ...requestForm, requested_grade: e.target.value })} /></Field><Field label="المجموعة المطلوبة"><Input value={requestForm.requested_group} onChange={e => setRequestForm({ ...requestForm, requested_group: e.target.value })} /></Field><Field label="تفاصيل إضافية"><Textarea value={requestForm.message} onChange={e => setRequestForm({ ...requestForm, message: e.target.value })} /></Field></div><DialogFooter><Button disabled={busy || !requestForm.owner_id || !requestForm.requested_title || !requestForm.requested_grade || !requestForm.requested_group} onClick={() => void run(async () => { await sendVideoRequest(requestForm); setRequestOpen(false); setRequestForm({ owner_id: '', requested_title: '', requested_grade: '', requested_group: '', message: '' }); }, 'تم إرسال الطلب لمدة 48 ساعة')}>إرسال</Button></DialogFooter></DialogContent></Dialog>

  <Dialog open={!!offerRequest} onOpenChange={open => !open && setOfferRequest(null)}><DialogContent dir="rtl"><DialogHeader><DialogTitle>ترشيح فيديو</DialogTitle></DialogHeader><Select value={offerLecture} onValueChange={setOfferLecture}><SelectTrigger><SelectValue placeholder="اختر فيديو جاهزًا بمعاينة وسعر" /></SelectTrigger><SelectContent>{lectures.map(item => <SelectItem key={item.id} value={item.id}>{item.title} — {Number(item.price).toFixed(2)} ج.م</SelectItem>)}</SelectContent></Select><DialogFooter><Button disabled={busy || !offerLecture} onClick={() => offerRequest && void run(async () => { await proposeVideoOffer(offerRequest.id, offerLecture); setOfferRequest(null); }, 'تم إرسال العرض وتجديد المهلة 48 ساعة')}>إرسال العرض</Button></DialogFooter></DialogContent></Dialog>

  <Dialog open={!!history} onOpenChange={open => !open && setHistory(null)}><DialogContent className="max-h-[85vh] overflow-y-auto" dir="rtl"><DialogHeader><DialogTitle>سجل العروض</DialogTitle></DialogHeader><div className="space-y-3">{history?.offers.length ? history.offers.map(offer => <div key={offer.id} className="rounded-lg border p-3"><div className="flex justify-between"><strong>{offer.title_snapshot}</strong><Badge variant="outline">{offer.status}</Badge></div><p className="text-sm">{Number(offer.price_snapshot).toFixed(2)} ج.م</p>{offer.rejection_reason && <p className="mt-1 text-sm text-red-700">سبب الرفض: {offer.rejection_reason}</p>}<div className="mt-2 flex gap-2"><Button size="sm" variant="outline" onClick={() => void openPreview(offer)}>معاينة</Button>{offer.status === 'proposed' && history.request.status === 'awaiting_requester' && <><Button size="sm" disabled={busy} onClick={() => void run(async () => { await acceptVideoOffer(offer.id); setHistory(null); }, 'تم الشراء وإضافة الفيديو لمكتبتك')}><Check className="ml-1 h-4 w-4" />قبول</Button><Button size="sm" variant="destructive" disabled={busy} onClick={() => { const reason = window.prompt('اكتب سبب رفض هذا الترشيح:')?.trim(); if (reason) void run(async () => { await rejectVideoOffer(offer.id, reason); setHistory(null); }, 'رُفض الترشيح وبقي الطلب مفتوحًا'); }}><X className="ml-1 h-4 w-4" />رفض</Button></>}</div></div>) : <p className="text-center text-slate-500">لم تُرسل عروض بعد.</p>}</div></DialogContent></Dialog>

  <Dialog open={!!preview} onOpenChange={open => !open && setPreview(null)}><DialogContent className="max-w-4xl" dir="rtl"><DialogHeader><DialogTitle>{preview?.title_snapshot}</DialogTitle></DialogHeader>{preview && <SecureVideoPlayer videoId={preview.video_id} offerId={preview.id} userId={JSON.parse(localStorage.getItem('currentUser') || '{}').id || ''} studentName={JSON.parse(localStorage.getItem('currentUser') || '{}').name || ''} groupName="معاينة عرض" onClose={() => setPreview(null)} />}<p className="text-sm text-slate-500">هذه نسخة منفصلة مشفّرة ولا تتجاوز أول 10 دقائق.</p></DialogContent></Dialog>

  <Dialog open={!!publishItem} onOpenChange={open => !open && setPublishItem(null)}><DialogContent dir="rtl"><DialogHeader><DialogTitle>نشر الفيديو للمجموعات</DialogTitle></DialogHeader><Select value={publishGrade} onValueChange={value => { setPublishGrade(value); setPublishGroups([]); }}><SelectTrigger><SelectValue placeholder="اختر الصف" /></SelectTrigger><SelectContent>{grades.map(item => <SelectItem key={item.id} value={item.id}>{item.name}</SelectItem>)}</SelectContent></Select><div className="max-h-48 space-y-2 overflow-auto">{availableGroups.map(group => <label key={group.id} className="flex items-center gap-2 rounded border p-2"><input type="checkbox" checked={publishGroups.includes(group.id)} onChange={e => setPublishGroups(current => e.target.checked ? [...current, group.id] : current.filter(id => id !== group.id))} />{group.name}</label>)}</div><DialogFooter><Button disabled={busy || !publishGrade || !publishGroups.length} onClick={() => publishItem && void run(async () => { await publishSharedLecture(publishItem.shared_lecture_id, publishGrade, publishGroups); setPublishItem(null); }, 'تم نشر الفيديو للمجموعات المحددة')}>حفظ النشر</Button></DialogFooter></DialogContent></Dialog>
  </div>;
}

function Field({ label, children }: { label: string; children: React.ReactNode }) { return <div className="space-y-1"><Label>{label}</Label>{children}</div>; }
function Empty({ text }: { text: string }) { return <Card className="md:col-span-2"><CardContent className="py-12 text-center text-slate-500"><Inbox className="mx-auto mb-2 h-10 w-10 opacity-30" />{text}</CardContent></Card>; }
