import { FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Headphones, Loader2, MessageSquare, Plus, RefreshCw, Send } from "lucide-react";
import Header from "@/components/Header";
import StudentHeader from "@/components/StudentHeader";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/hooks/use-toast";
import {
  createSupportTicket,
  getMySupportTickets,
  getSupportQueue,
  getSupportTicket,
  replyToSupportTicket,
  updateSupportTicketStatus,
  type SupportCategory,
  type SupportReply,
  type SupportStatus,
  type SupportTicket,
} from "@/lib/api";

/**
 * Synchronous in-flight latch for async UI actions.
 *
 * The `submitting` state only blocks a second click after React re-renders;
 * two events in the same tick both still see `submitting === false`. The latch
 * is acquired synchronously inside each handler so a same-tick duplicate
 * submit (double click, Enter + click) is rejected before any request is sent.
 * `release` must run in a `finally` so a failed attempt stays retryable.
 *
 * Mirrored in OnlineMeeting.tsx; both copies are pinned by
 * src/tests/m1-sprint-meeting-support-ui.test.ts.
 */
export interface SubmitGuard {
  tryAcquire(): boolean;
  release(): void;
}

export function createSubmitGuard(): SubmitGuard {
  let inFlight = false;
  return {
    tryAcquire: () => {
      if (inFlight) return false;
      inFlight = true;
      return true;
    },
    release: () => {
      inFlight = false;
    },
  };
}

const categoryLabels: Record<SupportCategory, string> = {
  technical: "مشكلة تقنية",
  account: "الحساب وتسجيل الدخول",
  billing: "الدفع أو الاشتراك",
  content: "المحتوى التعليمي",
  exam: "الاختبارات والنتائج",
  video: "الفيديو والمحاضرات",
  other: "أخرى",
};

const statusLabels: Record<SupportStatus, string> = {
  open: "جديدة",
  waiting_on_support: "بانتظار الدعم",
  waiting_on_user: "بانتظار ردك",
  resolved: "تم الحل",
  closed: "مغلقة",
};

const statusStyle: Record<SupportStatus, string> = {
  open: "bg-blue-100 text-blue-800",
  waiting_on_support: "bg-amber-100 text-amber-800",
  waiting_on_user: "bg-violet-100 text-violet-800",
  resolved: "bg-emerald-100 text-emerald-800",
  closed: "bg-slate-100 text-slate-700",
};

interface CurrentUser { id: string; role: string; name?: string; admin_permissions?: string[] }

export default function Support() {
  const { toast } = useToast();
  const currentUser = useMemo<CurrentUser | null>(() => {
    try { return JSON.parse(localStorage.getItem("currentUser") || "null"); }
    catch { return null; }
  }, []);
  const isAdmin = currentUser?.role === "admin" || Boolean(currentUser?.admin_permissions?.includes("support.read"));
  const [tickets, setTickets] = useState<SupportTicket[]>([]);
  const [selected, setSelected] = useState<SupportTicket | null>(null);
  const [replies, setReplies] = useState<SupportReply[]>([]);
  const [loading, setLoading] = useState(true);
  const [detailsLoading, setDetailsLoading] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [category, setCategory] = useState<SupportCategory>("technical");
  const [subject, setSubject] = useState("");
  const [description, setDescription] = useState("");
  const [reply, setReply] = useState("");

  // One shared latch for every ticket mutation, matching the single
  // `submitting` flag: while any mutation is in flight the others are blocked.
  const submitGuardRef = useRef<SubmitGuard | null>(null);
  submitGuardRef.current ??= createSubmitGuard();

  const loadTickets = useCallback(async () => {
    setLoading(true);
    try {
      setTickets(isAdmin ? await getSupportQueue() : await getMySupportTickets());
    } catch (error) {
      toast({ variant: "destructive", title: "تعذر تحميل طلبات الدعم", description: error instanceof Error ? error.message : "حاول مرة أخرى" });
    } finally {
      setLoading(false);
    }
  }, [isAdmin, toast]);

  useEffect(() => { loadTickets(); }, [loadTickets]);

  const openTicket = async (ticket: SupportTicket) => {
    setSelected(ticket);
    setDetailsLoading(true);
    try {
      const details = await getSupportTicket(ticket.id);
      setSelected(details.ticket);
      setReplies(details.replies);
    } catch (error) {
      toast({ variant: "destructive", title: "تعذر فتح التذكرة", description: error instanceof Error ? error.message : "حاول مرة أخرى" });
    } finally {
      setDetailsLoading(false);
    }
  };

  const submitTicket = async (event: FormEvent) => {
    event.preventDefault();
    // Synchronous latch: a same-tick duplicate submit must not create two tickets.
    if (!submitGuardRef.current?.tryAcquire()) return;
    setSubmitting(true);
    try {
      const created = await createSupportTicket({ category, subject, description });
      setTickets((previous) => [created, ...previous]);
      setCreateOpen(false);
      setSubject("");
      setDescription("");
      toast({ title: "تم إرسال طلب الدعم", description: `رقم التذكرة: ${created.ticket_number}` });
      await openTicket(created);
    } catch (error) {
      toast({ variant: "destructive", title: "لم يتم إرسال الطلب", description: error instanceof Error ? error.message : "راجع البيانات وحاول مرة أخرى" });
    } finally {
      submitGuardRef.current?.release();
      setSubmitting(false);
    }
  };

  const sendReply = async () => {
    if (!selected || !reply.trim()) return;
    // Synchronous latch: a same-tick duplicate send must not post two replies.
    if (!submitGuardRef.current?.tryAcquire()) return;
    setSubmitting(true);
    try {
      const created = await replyToSupportTicket(selected.id, reply.trim());
      const nextStatus: SupportStatus = isAdmin ? "waiting_on_user" : "waiting_on_support";
      setReplies((previous) => [...previous, created]);
      setSelected({ ...selected, status: nextStatus });
      setReply("");
      await loadTickets();
    } catch (error) {
      toast({ variant: "destructive", title: "تعذر إرسال الرد", description: error instanceof Error ? error.message : "حاول مرة أخرى" });
    } finally {
      submitGuardRef.current?.release();
      setSubmitting(false);
    }
  };

  const changeStatus = async (status: SupportStatus) => {
    if (!selected) return;
    // Synchronous latch: a same-tick duplicate click must not PATCH twice.
    if (!submitGuardRef.current?.tryAcquire()) return;
    setSubmitting(true);
    try {
      await updateSupportTicketStatus(selected.id, status);
      setSelected({ ...selected, status });
      await loadTickets();
      toast({ title: "تم تحديث حالة التذكرة" });
    } catch (error) {
      toast({ variant: "destructive", title: "تعذر تحديث الحالة", description: error instanceof Error ? error.message : "حاول مرة أخرى" });
    } finally {
      submitGuardRef.current?.release();
      setSubmitting(false);
    }
  };

  return (
    <div className="min-h-screen bg-slate-50" dir="rtl">
      {currentUser?.role === "student" ? <StudentHeader /> : <Header />}
      <main className="main-content p-4 md:p-8">
        <div className="mx-auto max-w-7xl space-y-6">
          <header className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <h1 className="flex items-center gap-2 text-2xl font-bold text-slate-900"><Headphones className="h-6 w-6 text-orange-500" />{isAdmin ? "مركز الدعم" : "التواصل مع الإدارة"}</h1>
              <p className="mt-1 text-sm text-slate-600">{isAdmin ? "تابع طلبات المستخدمين ورد عليها حسب الأولوية." : "أرسل مشكلتك وتابع الرد وحالة الحل من مكان واحد."}</p>
            </div>
            <div className="flex gap-2">
              <Button variant="outline" onClick={loadTickets} disabled={loading}><RefreshCw className="ml-2 h-4 w-4" />تحديث</Button>
              {!isAdmin && <Button onClick={() => setCreateOpen(true)}><Plus className="ml-2 h-4 w-4" />طلب دعم جديد</Button>}
            </div>
          </header>

          <div className="grid gap-6 lg:grid-cols-[360px_1fr]">
            <Card className="overflow-hidden">
              <CardHeader className="border-b"><CardTitle className="text-lg">{isAdmin ? "قائمة الانتظار" : "طلباتي"}</CardTitle></CardHeader>
              <CardContent className="max-h-[68vh] space-y-2 overflow-y-auto p-3">
                {loading ? (
                  <div className="flex justify-center py-12"><Loader2 className="h-7 w-7 animate-spin text-orange-500" /></div>
                ) : tickets.length === 0 ? (
                  <div className="py-12 text-center text-sm text-slate-500">
                    <Headphones className="mx-auto mb-3 h-10 w-10 text-slate-300" />
                    <p>{isAdmin ? "لا توجد تذاكر في قائمة الانتظار." : "لم ترسل طلب دعم بعد."}</p>
                    {!isAdmin && <Button variant="link" onClick={() => setCreateOpen(true)}>أنشئ أول طلب</Button>}
                  </div>
                ) : tickets.map((ticket) => (
                  <button key={ticket.id} onClick={() => openTicket(ticket)} className={`w-full rounded-xl border p-3 text-right transition ${selected?.id === ticket.id ? "border-orange-300 bg-orange-50" : "bg-white hover:bg-slate-50"}`}>
                    <div className="flex items-start justify-between gap-2"><span className="font-semibold text-slate-900 line-clamp-1">{ticket.subject}</span><Badge className={statusStyle[ticket.status]}>{statusLabels[ticket.status]}</Badge></div>
                    <p className="mt-1 text-xs text-slate-500">{ticket.ticket_number} · {categoryLabels[ticket.category]}</p>
                    {isAdmin && ticket.user_name && <p className="mt-1 text-xs text-slate-600">{ticket.user_name}</p>}
                  </button>
                ))}
              </CardContent>
            </Card>

            <Card className="min-h-[520px] overflow-hidden">
              {!selected ? (
                <CardContent className="flex min-h-[520px] flex-col items-center justify-center text-center text-slate-500"><MessageSquare className="mb-4 h-12 w-12 text-slate-300" /><h2 className="font-semibold text-slate-700">اختر تذكرة لعرض التفاصيل</h2><p className="mt-1 text-sm">ستظهر الرسائل والحالة والإجراءات هنا.</p></CardContent>
              ) : detailsLoading ? (
                <CardContent className="flex min-h-[520px] items-center justify-center"><Loader2 className="h-8 w-8 animate-spin text-orange-500" /></CardContent>
              ) : (
                <div className="flex min-h-[520px] flex-col">
                  <div className="border-b p-5">
                    <div className="flex flex-wrap items-start justify-between gap-3"><div><p className="text-xs text-slate-500">{selected.ticket_number}</p><h2 className="mt-1 text-xl font-bold text-slate-900">{selected.subject}</h2><p className="mt-1 text-sm text-slate-500">{categoryLabels[selected.category]}</p></div><Badge className={statusStyle[selected.status]}>{statusLabels[selected.status]}</Badge></div>
                    {selected.description && <p className="mt-4 whitespace-pre-wrap rounded-xl bg-slate-50 p-4 text-sm leading-7 text-slate-700">{selected.description}</p>}
                  </div>
                  <div className="flex-1 space-y-3 overflow-y-auto p-5">
                    {replies.length === 0 ? <p className="py-8 text-center text-sm text-slate-500">لم تُرسل ردود بعد.</p> : replies.map((item) => {
                      const mine = item.sender_id === currentUser?.id;
                      return <div key={item.id} className={`flex ${mine ? "justify-start" : "justify-end"}`}><div className={`max-w-[85%] rounded-2xl px-4 py-3 ${mine ? "bg-orange-500 text-white" : "border bg-white"}`}><p className="text-xs font-semibold opacity-80">{item.sender_name}</p><p className="mt-1 whitespace-pre-wrap text-sm leading-6">{item.body}</p><p className="mt-1 text-[10px] opacity-70">{new Date(item.created_at).toLocaleString("ar-EG")}</p></div></div>;
                    })}
                  </div>
                  <div className="border-t bg-white p-4">
                    {selected.status !== "closed" && <div className="flex items-end gap-2"><Textarea value={reply} onChange={(event) => setReply(event.target.value)} aria-label="اكتب ردك هنا" placeholder="اكتب ردك هنا..." className="min-h-20" /><Button size="icon" onClick={sendReply} disabled={submitting || !reply.trim()} aria-label="إرسال الرد"><Send className="h-4 w-4" /></Button></div>}
                    <div className="mt-3 flex flex-wrap gap-2">
                      {isAdmin && selected.status !== "resolved" && selected.status !== "closed" && <Button size="sm" variant="outline" onClick={() => changeStatus("resolved")} disabled={submitting}>تم الحل</Button>}
                      {selected.status !== "closed" && <Button size="sm" variant="ghost" onClick={() => changeStatus("closed")} disabled={submitting}>إغلاق التذكرة</Button>}
                    </div>
                  </div>
                </div>
              )}
            </Card>
          </div>
        </div>
      </main>

      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent dir="rtl" className="sm:max-w-xl">
          <DialogHeader><DialogTitle>طلب دعم جديد</DialogTitle></DialogHeader>
          <form onSubmit={submitTicket} className="space-y-4">
            <div className="space-y-2"><Label htmlFor="support-category">نوع المشكلة</Label><Select value={category} onValueChange={(value) => setCategory(value as SupportCategory)}><SelectTrigger id="support-category"><SelectValue /></SelectTrigger><SelectContent>{Object.entries(categoryLabels).map(([value, label]) => <SelectItem key={value} value={value}>{label}</SelectItem>)}</SelectContent></Select></div>
            <div className="space-y-2"><Label htmlFor="support-subject">عنوان مختصر</Label><Input id="support-subject" value={subject} onChange={(event) => setSubject(event.target.value)} minLength={3} maxLength={200} required /></div>
            <div className="space-y-2"><Label htmlFor="support-description">اشرح المشكلة وما الذي كنت تحاول فعله</Label><Textarea id="support-description" value={description} onChange={(event) => setDescription(event.target.value)} minLength={10} maxLength={10000} className="min-h-32" required /></div>
            <Button type="submit" className="w-full" disabled={submitting}>{submitting && <Loader2 className="ml-2 h-4 w-4 animate-spin" />}إرسال الطلب</Button>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}
