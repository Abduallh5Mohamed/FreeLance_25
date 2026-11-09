import { FormEvent, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {Link,useLocation} from 'react-router-dom';
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
import { subscribeSessionChange } from "@/lib/session-events";
import { parseSupportReplyPage, type SupportReplyPage } from "@/features/support/reply-page";
import { createSupportAttempt, type SupportAttemptState } from "@/features/support/write-attempt";
import {parseSupportDraftTarget,createSupportContextController,initialSupportContextState,type SupportContextState} from '@/features/support/lesson-context';
import {readSupportSessionIdentity as supportSessionIdentity} from '@/features/support/session';
import {SupportPrivateNotes} from '@/features/support/SupportPrivateNotes';
import {SupportAssignment} from '@/features/support/SupportAssignment';
import {SupportAssignedQueue} from '@/features/support/SupportAssignedQueue';
import {SupportFollowupQueue} from '@/features/support/SupportFollowupQueue';
import {
  createSupportTicket,
  reconcileSupportTicket,
  reconcileSupportReply,
  getMySupportTickets,
  getSupportQueue,
  getSupportTicket,
  getOlderSupportReplies,
  getLessonSupportContext,
  getSupportTicketContext,
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

/**
 * Monotonic request token for ticket-detail loads. Each `openTicket` claims a
 * token; only the latest token may commit its result. A slower older response
 * (the user opened another ticket meanwhile) is therefore ignored instead of
 * overwriting the current selection, replies or the details spinner.
 *
 * Pinned by src/tests/m1-sprint-meeting-support-ui.test.ts.
 */
export interface LatestRequestGuard {
  begin(): number;
  isLatest(token: number): boolean;
}

export function createLatestRequestGuard(): LatestRequestGuard {
  let latest = 0;
  return {
    begin: () => {
      latest += 1;
      return latest;
    },
    isLatest: (token) => token === latest,
  };
}

/**
 * Production controller for the ticket-detail panel. `open()` is the exact path
 * the UI runs when a user opens a ticket:
 *   - it shows the chosen ticket header and clears the previous ticket's replies
 *     at once, so a different ticket's conversation is never shown under the new
 *     header while it loads — or after it fails;
 *   - only the latest `open()` may commit, so a slower response for a ticket the
 *     user has since replaced is dropped;
 *   - `invalidate()` retires in-flight opens (used on unmount / identity change).
 *
 * Pinned by src/tests/m1-sprint-meeting-support-ui.test.ts.
 */
export interface TicketDetailsControllerDeps {
  request: (ticketId: string, signal?: AbortSignal) => Promise<{ ticket: SupportTicket; replies: SupportReply[]; has_more_replies?: boolean; next_cursor?: string | null }>;
  requestOlder?: (ticketId: string, before: string, signal: AbortSignal) => Promise<SupportReplyPage>;
  readIdentity?: () => string | null;
  onSelect: (ticket: SupportTicket) => void;
  onClearReplies: () => void;
  onApply: (ticket: SupportTicket, replies: SupportReply[], hasMoreReplies?: boolean, nextCursor?: string | null) => void;
  onPrepend?: (replies: SupportReply[], nextCursor: string | null) => void;
  onOlderLoadingChange?: (loading: boolean) => void;
  onSessionEnded?: () => void;
  onError: (message: string) => void;
  onLoadingChange?: (loading: boolean) => void;
}

export interface TicketDetailsController {
  open(ticket: SupportTicket): Promise<void>;
  loadOlder(): Promise<void>;
  invalidate(): void;
  endSession(): void;
}

export function createTicketDetailsController(deps: TicketDetailsControllerDeps): TicketDetailsController {
  const guard = createLatestRequestGuard();
  const identity = deps.readIdentity?.();
  let target: string | null = null, cursor: string | null = null, olderBusy = false, ended = false;
  let activeToken = 0, abort = new AbortController(), loadedIds = new Set<string>();
  const invalidate = () => {
    guard.begin(); abort.abort(); target = cursor = null; olderBusy = false; loadedIds.clear();
    deps.onOlderLoadingChange?.(false);
  };
  const current = (token: number) => {
    if (!guard.isLatest(token)) return false;
    if (deps.readIdentity && (!identity || identity !== deps.readIdentity())) {
      invalidate(); ended = true; deps.onSessionEnded?.(); return false;
    }
    return true;
  };
  const accessLost = (error: unknown) => !!error && typeof error === 'object' && 'status' in error && typeof error.status === 'number' && [401,403,404].includes(error.status);
  return {
    async open(ticket) {
      if (ended) return;
      const token = guard.begin();
      if (!current(token)) return;
      abort.abort(); abort = new AbortController(); activeToken = token;
      target = ticket.id; cursor = null; olderBusy = false; loadedIds.clear(); deps.onOlderLoadingChange?.(false);
      // Show the chosen ticket and drop the previous ticket's replies at once: a
      // different ticket's conversation must never linger under this header.
      deps.onSelect(ticket);
      deps.onClearReplies();
      deps.onLoadingChange?.(true);
      let details: { ticket: SupportTicket; replies: SupportReply[]; has_more_replies?: boolean; next_cursor?: string | null } | null = null;
      let failure: unknown;
      let failed = false;
      try {
        details = await deps.request(ticket.id, abort.signal);
        if (details.ticket.id !== ticket.id) throw new Error('استجابة التذكرة لا تطابق المحادثة المختارة.');
      } catch (error) {
        failed = true;
        failure = error;
      }
      // A newer open (or an invalidate) superseded this one: commit nothing.
      if (!current(token)) return;
      if (failed) {
        if (accessLost(failure)) { invalidate(); ended = true; deps.onSessionEnded?.(); return; }
        // Replies were already cleared; report the failure for the chosen ticket.
        deps.onError(failure instanceof Error ? failure.message : "حاول مرة أخرى");
      } else if (details) {
        cursor = details.next_cursor ?? null; loadedIds = new Set(details.replies.map(row => row.id));
        deps.onApply(details.ticket, details.replies, details.has_more_replies, cursor);
      }
      deps.onLoadingChange?.(false);
    },
    async loadOlder() {
      const token = activeToken, before = cursor, ticketId = target;
      if (ended || olderBusy || !before || !ticketId || !deps.requestOlder || !current(token)) return;
      olderBusy = true; deps.onOlderLoadingChange?.(true);
      try {
        const page = parseSupportReplyPage(await deps.requestOlder(ticketId, before, abort.signal));
        if (!current(token)) return;
        if (page.next_cursor === before || page.replies.some(row => loadedIds.has(row.id))) throw new Error('تعذّر متابعة المحادثة. حدّث التذكرة وحاول مرة أخرى.');
        page.replies.forEach(row => loadedIds.add(row.id)); cursor = page.next_cursor;
        deps.onPrepend?.(page.replies, cursor);
      } catch (error) {
        if (current(token)) {
          if (accessLost(error)) { invalidate(); ended = true; deps.onSessionEnded?.(); }
          else deps.onError(error instanceof Error ? error.message : 'تعذّر تحميل الرسائل الأقدم.');
        }
      } finally { if (current(token)) { olderBusy = false; deps.onOlderLoadingChange?.(false); } }
    },
    invalidate,
    endSession() { invalidate(); ended = true; },
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

const idleAttempt = (): SupportAttemptState => ({ busy:false,uncertain:false,locked:false,error:null,blocked:false });
type TicketInput = {category:SupportCategory;subject:string;description:string;context?:{kind:'catalog_lesson';course_id:string;lesson_id:string}};
type CreateAttempt = ReturnType<typeof createSupportAttempt<TicketInput,Awaited<ReturnType<typeof createSupportTicket>>>>;
type ReplyAttempt = ReturnType<typeof createSupportAttempt<string,Awaited<ReturnType<typeof replyToSupportTicket>>>>;

export default function Support() {
  const { toast } = useToast();
  const location=useLocation();
  const draftTarget=useMemo(()=>parseSupportDraftTarget(location.search),[location.search]);
  const [generalFor,setGeneralFor]=useState<string|null>(null);
  const wantsLessonContext=draftTarget.kind!=='none'&&generalFor!==location.search;
  const draftScope=wantsLessonContext?location.search:'general';
  const currentUser = useMemo<CurrentUser | null>(() => {
    try { return JSON.parse(localStorage.getItem("currentUser") || "null"); }
    catch { return null; }
  }, []);
  const isAdmin = currentUser?.role === "admin" || Boolean(currentUser?.admin_permissions?.includes("support.read"));
  const [tickets, setTickets] = useState<SupportTicket[]>([]);
  const [selected, setSelected] = useState<SupportTicket | null>(null);
  const [replies, setReplies] = useState<SupportReply[]>([]);
  const replyScroller = useRef<HTMLDivElement | null>(null);
  const scrollUpdate = useRef<'bottom' | { height: number; top: number } | null>(null);
  useLayoutEffect(() => {
    const node = replyScroller.current, update = scrollUpdate.current;
    if (node && update) node.scrollTop = update === 'bottom' ? node.scrollHeight : update.top + node.scrollHeight - update.height;
    scrollUpdate.current = null;
  }, [replies]);
  const [hasMoreReplies, setHasMoreReplies] = useState(false);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [olderLoading, setOlderLoading] = useState(false);
  const [sessionEnded, setSessionEnded] = useState(false);
  const sessionAlive = useRef(true);
  const principal = useRef(supportSessionIdentity());
  const sameSession = () => sessionAlive.current && !!principal.current && principal.current === supportSessionIdentity();
  const [assignmentActivity,setAssignmentActivity]=useState(0),[assignmentRevision,setAssignmentRevision]=useState(0);
  const assignmentActivityChanged=useCallback((busy:boolean)=>{
    if(!sameSession())return;
    setAssignmentActivity(value=>Math.max(0,value+(busy?1:-1)));
    if(!busy)setAssignmentRevision(value=>value+1);
  },[]);
  const [loading, setLoading] = useState(true);
  const [detailsLoading, setDetailsLoading] = useState(false);
  const [createOpen, setCreateOpen] = useState(()=>wantsLessonContext&&draftTarget.kind==='lesson');
  const [submitting, setSubmitting] = useState(false);
  const [category, setCategory] = useState<SupportCategory>("technical");
  const [subject, setSubject] = useState("");
  const [description, setDescription] = useState("");
  const [reply, setReply] = useState("");
  const [draftContextState,setDraftContextState]=useState<SupportContextState>(initialSupportContextState);
  const [ticketContextState,setTicketContextState]=useState<SupportContextState>(initialSupportContextState);
  const draftContextRef=useRef<ReturnType<typeof createSupportContextController>|null>(null);
  const ticketContextRef=useRef<ReturnType<typeof createSupportContextController>|null>(null);
  const ticketContextTarget=useRef<string|null>(null);
  const createAttemptRef = useRef<CreateAttempt | null>(null);
  const replyAttemptRef = useRef<{ticketId:string;controller:ReplyAttempt} | null>(null);
  const [createAttemptState, setCreateAttemptState] = useState<SupportAttemptState>(idleAttempt);
  const [replyAttemptState, setReplyAttemptState] = useState<SupportAttemptState>(idleAttempt);
  const attemptStorage = (kind:string,target='new') => {
    const storageKey = `tabweb.support.attempt.v1.${encodeURIComponent(currentUser?.id ?? '')}.${kind}.${encodeURIComponent(target)}`;
    return {
      readKey: () => { if(!currentUser?.id)throw Error('Missing support identity');return sessionStorage.getItem(storageKey); },
      saveKey: (key:string) => { if(!currentUser?.id)throw Error('Missing support identity');const prior=sessionStorage.getItem(storageKey);if(prior&&prior!==key)throw Error('Pending support attempt');sessionStorage.setItem(storageKey,key); },
      clearKey: () => sessionStorage.removeItem(storageKey),makeKey:()=>crypto.randomUUID(),readIdentity:supportSessionIdentity,
    };
  };
  useEffect(()=>{
    if(!wantsLessonContext){setDraftContextState({phase:'ready',data:{state:'none',context:null},message:null});return;}
    if(draftTarget.kind!=='lesson'){setDraftContextState({phase:'error',data:null,message:'رابط سياق الدرس غير صالح. لم يتم إرفاق أي درس.'});return;}
    const controller=createSupportContextController({readIdentity:supportSessionIdentity,read:async signal=>({state:'available',context:await getLessonSupportContext(draftTarget.courseId,draftTarget.lessonId,signal)})});
    draftContextRef.current=controller;const unsubscribe=controller.subscribe(setDraftContextState);void controller.load();
    return()=>{unsubscribe();controller.dispose();draftContextRef.current=null;};
  },[draftScope]);
  useEffect(()=>{
    if(!selected){setTicketContextState(initialSupportContextState());return;}
    const ticketId=selected.id,controller=createSupportContextController({readIdentity:supportSessionIdentity,read:signal=>getSupportTicketContext(ticketId,signal),onDenied:()=>retirePrivateSupport()});
    ticketContextRef.current=controller;ticketContextTarget.current=ticketId;const unsubscribe=controller.subscribe(setTicketContextState);void controller.load();
    return()=>{unsubscribe();controller.dispose();ticketContextRef.current=null;ticketContextTarget.current=null;};
  },[selected?.id]);
  useEffect(() => {
    const controller=createSupportAttempt<TicketInput,Awaited<ReturnType<typeof createSupportTicket>>>({
      ...attemptStorage('create'),send:(payload,key,signal)=>createSupportTicket(payload,key,signal),reconcile:reconcileSupportTicket,onDenied:()=>retirePrivateSupport(),
    });
    createAttemptRef.current=controller;const unsubscribe=controller.subscribe(setCreateAttemptState);
    return()=>{unsubscribe();controller.dispose();createAttemptRef.current=null;};
  },[currentUser?.id,draftScope]);
  useEffect(() => {
    if(!selected){setReplyAttemptState(idleAttempt());return;}
    const ticketId=selected.id;
    const controller=createSupportAttempt<string,Awaited<ReturnType<typeof replyToSupportTicket>>>({
      ...attemptStorage('reply',ticketId),send:(body,key,signal)=>replyToSupportTicket(ticketId,body,key,signal),reconcile:(key,signal)=>reconcileSupportReply(ticketId,key,signal),onDenied:()=>retirePrivateSupport(),
    });
    replyAttemptRef.current={ticketId,controller};const unsubscribe=controller.subscribe(setReplyAttemptState);
    return()=>{unsubscribe();controller.dispose();replyAttemptRef.current=null;};
  },[selected?.id,currentUser?.id]);

  // One shared latch for every ticket mutation, matching the single
  // `submitting` flag: while any mutation is in flight the others are blocked.
  const submitGuardRef = useRef<SubmitGuard | null>(null);
  submitGuardRef.current ??= createSubmitGuard();

  // Owns the ticket-detail open lifecycle: clears the previous ticket's replies
  // before loading, commits only the latest response, and can retire in-flight
  // opens on unmount / identity change.
  const detailsControllerRef = useRef<TicketDetailsController | null>(null);
  detailsControllerRef.current ??= createTicketDetailsController({
    request: (ticketId, signal) => getSupportTicket(ticketId, signal),
    requestOlder: (ticketId, before, signal) => getOlderSupportReplies(ticketId, before, signal),
    readIdentity: supportSessionIdentity,
    onSelect: (ticket) => { setSelected(ticket); setReply('');if(ticketContextTarget.current===ticket.id)void ticketContextRef.current?.load();else setTicketContextState(initialSupportContextState()); },
    onClearReplies: () => { setReplies([]); setHasMoreReplies(false); setNextCursor(null); },
    onApply: (ticket, nextReplies, more, cursor) => {
      setSelected(ticket);
      scrollUpdate.current = 'bottom';
      setReplies(nextReplies);
      setHasMoreReplies(more === true);
      setNextCursor(cursor ?? null);
    },
    onPrepend: (older, cursor) => {
      const node = replyScroller.current;
      scrollUpdate.current = node ? { height: node.scrollHeight, top: node.scrollTop } : null;
      setReplies(previous => [...older, ...previous]); setNextCursor(cursor); setHasMoreReplies(cursor !== null);
    },
    onOlderLoadingChange: setOlderLoading,
    onSessionEnded: () => retirePrivateSupport(),
    onError: (message) => toast({ variant: "destructive", title: "تعذر فتح التذكرة", description: message }),
    onLoadingChange: (value) => setDetailsLoading(value),
  });
  const retirePrivateSupport = () => {
    sessionAlive.current=false;detailsControllerRef.current?.endSession();
    createAttemptRef.current?.invalidate();replyAttemptRef.current?.controller.invalidate();
    draftContextRef.current?.invalidate();ticketContextRef.current?.invalidate();
    setTickets([]);setSelected(null);setReplies([]);setNextCursor(null);setHasMoreReplies(false);
    setCreateOpen(false);setReply('');setDescription('');setSubject('');setLoading(false);setDetailsLoading(false);setSessionEnded(true);
  };

  const loadTickets = useCallback(async () => {
    if (!sameSession()) return;
    setLoading(true);
    try {
      const rows = isAdmin ? await getSupportQueue() : await getMySupportTickets();
      if (sameSession()) setTickets(rows);
    } catch (error) {
      if (sameSession()) toast({ variant: "destructive", title: "تعذر تحميل طلبات الدعم", description: error instanceof Error ? error.message : "حاول مرة أخرى" });
    } finally {
      if (sameSession()) setLoading(false);
    }
  }, [isAdmin, toast]);

  useEffect(() => { loadTickets(); }, [loadTickets]);

  // On unmount (e.g. logout) retire any in-flight detail load so a late response
  // can never commit a previous user's ticket or replies.
  useEffect(() => {
    sessionAlive.current = true;
    const end = retirePrivateSupport;
    const unsubscribe = subscribeSessionChange(end);
    const storage = (event: StorageEvent) => { if (event.key === null || ['authToken','currentUser','currentStudent','currentStudentSpace','student_session','offlineStudentSession'].includes(event.key)) end(); };
    window.addEventListener('storage', storage);
    return () => { sessionAlive.current = false; detailsControllerRef.current?.invalidate(); unsubscribe(); window.removeEventListener('storage', storage); };
  }, []);

  const openTicket = (ticket: SupportTicket) => detailsControllerRef.current!.open(ticket);
  const verifiedDraftContext=wantsLessonContext&&draftTarget.kind==='lesson'&&draftContextState.phase==='ready'
    &&draftContextState.data?.context?.course_id.toLowerCase()===draftTarget.courseId&&draftContextState.data.context.lesson_id.toLowerCase()===draftTarget.lessonId
    ?draftContextState.data.context:null;
  const canSendContext=!wantsLessonContext||!!verifiedDraftContext;

  const submitTicket = async (event: FormEvent, checkOnly=false) => {
    event.preventDefault();
    if (!sameSession()) return;
    if(!checkOnly&&!canSendContext){
      toast({variant:'destructive',title:'سياق الدرس غير مؤكد',description:'تحقق من الدرس أو اختر طلبًا عامًا صراحةً قبل الإرسال.'});return;
    }
    if(!checkOnly&&(subject.trim().length<3||subject.trim().length>200||description.trim().length<10||description.trim().length>10000)){
      toast({variant:'destructive',title:'راجع بيانات الطلب',description:'العنوان من ٣ إلى ٢٠٠ حرف، والشرح من ١٠ إلى ١٠٠٠٠ حرف بعد إزالة المسافات الزائدة.'});return;
    }
    // Synchronous latch: a same-tick duplicate submit must not create two tickets.
    if (!submitGuardRef.current?.tryAcquire()) return;
    setSubmitting(true);
    try {
      const attempt=createAttemptRef.current;if(!attempt)return;
      const context=verifiedDraftContext;
      const result = checkOnly ? await attempt.reconcile() : await attempt.send({ category, subject:subject.trim(), description:description.trim(),...(context?{context:{kind:'catalog_lesson' as const,course_id:context.course_id,lesson_id:context.lesson_id}}:{}) });
      if (!sameSession()) return;
      if(!result)return;
      const created=result.ticket;
      setTickets((previous) => [created, ...previous.filter(row=>row.id!==created.id)]);
      setCreateOpen(false);
      setSubject("");
      setDescription("");
      toast({ title: "تم إرسال طلب الدعم", description: `رقم التذكرة: ${created.ticket_number}` });
      await openTicket(created);
    } catch (error) {
      if (sameSession()) toast({ variant: "destructive", title: "تعذّر تأكيد نتيجة الطلب", description: "تحقق من نتيجة المحاولة قبل إنشاء طلب آخر." });
    } finally {
      submitGuardRef.current?.release();
      if (sameSession()) setSubmitting(false);
    }
  };

  const sendReply = async (checkOnly=false) => {
    if (!sameSession() || !selected || !checkOnly&&!reply.trim()) return;
    // Synchronous latch: a same-tick duplicate send must not post two replies.
    if (!submitGuardRef.current?.tryAcquire()) return;
    setSubmitting(true);
    try {
      const attempt=replyAttemptRef.current;if(!attempt||attempt.ticketId!==selected.id)return;
      const result=checkOnly?await attempt.controller.reconcile():await attempt.controller.send(reply.trim());
      if (!sameSession()) return;
      if(!result)return;
      const created=result.reply,nextStatus=result.ticket_status;
      scrollUpdate.current = 'bottom';
      setReplies((previous) => previous.some(row=>row.id===created.id)?previous:[...previous, created]);
      setSelected({ ...selected, status: nextStatus });
      setReply("");
      await loadTickets();
    } catch (error) {
      if (sameSession()) toast({ variant: "destructive", title: "تعذّر تأكيد نتيجة الرد", description: "تحقق من نتيجة المحاولة قبل إرسال رد جديد." });
    } finally {
      submitGuardRef.current?.release();
      if (sameSession()) setSubmitting(false);
    }
  };

  const changeStatus = async (status: SupportStatus) => {
    if (!sameSession() || !selected) return;
    // Synchronous latch: a same-tick duplicate click must not PATCH twice.
    if (!submitGuardRef.current?.tryAcquire()) return;
    setSubmitting(true);
    try {
      await updateSupportTicketStatus(selected.id, status);
      if (!sameSession()) return;
      setSelected({ ...selected, status });
      await loadTickets();
      toast({ title: "تم تحديث حالة التذكرة" });
    } catch (error) {
      if (sameSession()) toast({ variant: "destructive", title: "تعذّر تأكيد حالة التذكرة", description: "حدّث التذكرة للتحقق قبل إعادة تغيير الحالة." });
    } finally {
      submitGuardRef.current?.release();
      if (sameSession()) setSubmitting(false);
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
              <Link to="/center-work" className="self-center underline">مهام فريق السنتر</Link>
              <Button variant="outline" onClick={loadTickets} disabled={loading || sessionEnded}><RefreshCw className="ml-2 h-4 w-4" />تحديث</Button>
              {!isAdmin && <Button disabled={sessionEnded} onClick={() => setCreateOpen(true)}><Plus className="ml-2 h-4 w-4" />طلب دعم جديد</Button>}
            </div>
          </header>
          {sessionEnded ? <p role="alert" className="rounded border border-amber-200 bg-amber-50 p-3">تغيّرت الجلسة أو لم تعد المحادثة متاحة. أعد فتح صفحة الدعم للتحقق من صلاحية الحساب الحالي.</p> : null}
          {wantsLessonContext&&!sessionEnded?<section aria-label="سياق طلب مساعدة الدرس" className="min-w-0 space-y-2 break-words rounded-lg border border-indigo-200 bg-indigo-50 p-4 text-sm">
            {verifiedDraftContext?<p>طلب المساعدة متعلق بـ <strong>{verifiedDraftContext.course_name}</strong> — <strong>{verifiedDraftContext.lesson_title}</strong>.</p>
              :<p role="status">{draftContextState.phase==='loading'?'جارٍ التحقق من إتاحة الدرس…':draftContextState.message??'لم يتم تأكيد سياق الدرس بعد.'}</p>}
            <p>اكتب المشكلة بنفسك؛ سيُربط الطلب بمرجع الدرس بعد تحقق الخادم عند الإرسال.</p>
            <Button type="button" size="sm" variant="outline" disabled={submitting||createAttemptState.uncertain} onClick={()=>setGeneralFor(location.search)}>متابعة بطلب دعم عام</Button>
          </section>:null}

          {isAdmin&&!sessionEnded?<SupportAssignedQueue busyAssignment={assignmentActivity>0} revision={assignmentRevision} onOpen={openTicket}/>:null}
          {isAdmin&&!sessionEnded?<SupportFollowupQueue busyActivity={assignmentActivity>0||submitting||replyAttemptState.busy||createAttemptState.busy} revision={assignmentRevision} onOpen={openTicket}/>:null}
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
                  <button key={ticket.id} disabled={submitting} onClick={() => openTicket(ticket)} className={`w-full rounded-xl border p-3 text-right transition ${selected?.id === ticket.id ? "border-orange-300 bg-orange-50" : "bg-white hover:bg-slate-50"}`}>
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
                    {ticketContextState.phase==='ready'&&ticketContextState.data?.state==='available'&&ticketContextState.data.context?<p className="mt-3 break-words rounded border border-indigo-200 bg-indigo-50 p-3 text-sm">سياق الدرس: <strong>{ticketContextState.data.context.course_name}</strong> — <strong>{ticketContextState.data.context.lesson_title}</strong></p>:null}
                    {ticketContextState.phase==='ready'&&ticketContextState.data?.state==='unavailable'?<p className="mt-3 text-sm text-amber-800">سياق الدرس المرتبط لم يعد متاحًا حاليًا. يمكنك متابعة التذكرة.</p>:null}
                    {ticketContextState.message?<p role="status" className="mt-3 text-sm text-amber-800">{ticketContextState.message}</p>:null}
                  </div>
                  <div ref={replyScroller} aria-label="رسائل تذكرة الدعم" className="max-h-[60vh] flex-1 space-y-3 overflow-y-auto p-5">
                    {hasMoreReplies ? <div className="space-y-2 rounded border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
                      <p role="status">توجد رسائل أقدم في هذه المحادثة.</p>
                      <Button type="button" variant="outline" size="sm" disabled={olderLoading || !nextCursor} onClick={() => { void detailsControllerRef.current?.loadOlder(); }}>
                        {olderLoading ? 'جارٍ تحميل الرسائل الأقدم…' : 'عرض رسائل أقدم'}
                      </Button>
                    </div> : null}
                    {replies.length === 0 ? <p className="py-8 text-center text-sm text-slate-500">لم تُرسل ردود بعد.</p> : replies.map((item) => {
                      const mine = item.sender_id === currentUser?.id;
                      return <div key={item.id} className={`flex ${mine ? "justify-start" : "justify-end"}`}><div className={`max-w-[85%] rounded-2xl px-4 py-3 ${mine ? "bg-orange-500 text-white" : "border bg-white"}`}><p className="text-xs font-semibold opacity-80">{item.sender_name}</p><p className="mt-1 whitespace-pre-wrap text-sm leading-6">{item.body}</p><p className="mt-1 text-[10px] opacity-70">{new Date(item.created_at).toLocaleString("ar-EG")}</p></div></div>;
                    })}
                  </div>
                  <div className="border-t bg-white p-4">
                    {replyAttemptState.error ? <p role="alert" className="mb-2 text-sm text-red-700">{replyAttemptState.error}</p> : null}
                    {replyAttemptState.uncertain ? <div className="mb-3 space-y-2 rounded bg-amber-50 p-3 text-sm text-amber-900">
                      <p>هناك محاولة رد غير مؤكدة. التحقق يستعلم عن نتيجتها ولا يرسل ردًا جديدًا.</p>
                      <Button type="button" variant="outline" size="sm" disabled={submitting||replyAttemptState.busy||replyAttemptState.blocked} onClick={()=>{void sendReply(true);}}>التحقق من نتيجة الرد</Button>
                    </div> : null}
                    {selected.status !== "closed" && <div className="flex items-end gap-2"><Textarea disabled={replyAttemptState.locked||submitting||replyAttemptState.blocked} value={reply} onChange={(event) => setReply(event.target.value)} aria-label="اكتب ردك هنا" placeholder="اكتب ردك هنا..." maxLength={10000} className="min-h-20" /><Button size="icon" onClick={()=>{void sendReply();}} disabled={submitting || replyAttemptState.blocked || !reply.trim()} aria-label={replyAttemptState.uncertain?'إعادة نفس الرد':'إرسال الرد'}><Send className="h-4 w-4" /></Button></div>}
                    <div className="mt-3 flex flex-wrap gap-2">
                      {isAdmin && selected.status !== "resolved" && selected.status !== "closed" && <Button size="sm" variant="outline" onClick={() => changeStatus("resolved")} disabled={submitting}>تم الحل</Button>}
                      {selected.status !== "closed" && <Button size="sm" variant="ghost" onClick={() => changeStatus("closed")} disabled={submitting}>إغلاق التذكرة</Button>}
                    </div>
                    {isAdmin&&currentUser?.id?<SupportAssignment key={`assignment/${selected.id}`} ticketId={selected.id} accountId={currentUser.id} closed={selected.status==='closed'} onActivity={assignmentActivityChanged}/>:null}
                    {isAdmin&&currentUser?.id?<SupportPrivateNotes key={selected.id} ticketId={selected.id} accountId={currentUser.id}/>:null}
                  </div>
                </div>
              )}
            </Card>
          </div>
        </div>
      </main>

      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent dir="rtl" className="max-h-[90vh] overflow-y-auto sm:max-w-xl">
          <DialogHeader><DialogTitle>طلب دعم جديد</DialogTitle></DialogHeader>
          <form onSubmit={submitTicket} className="space-y-4">
            {wantsLessonContext?<div className="min-w-0 space-y-2 break-words rounded bg-indigo-50 p-3 text-sm"><p>{verifiedDraftContext?`الدرس المرتبط: ${verifiedDraftContext.course_name} — ${verifiedDraftContext.lesson_title}`:'لن يُرسل طلب مرتبط بدرس قبل تأكيد إتاحته.'}</p><Button type="button" size="sm" variant="outline" disabled={submitting||createAttemptState.uncertain} onClick={()=>setGeneralFor(location.search)}>متابعة بطلب دعم عام</Button></div>:null}
            {createAttemptState.error?<p role="alert" className="text-sm text-red-700">{createAttemptState.error}</p>:null}
            {createAttemptState.uncertain?<div className="space-y-2 rounded bg-amber-50 p-3 text-sm text-amber-900"><p>هناك محاولة غير مؤكدة. تحقق من نتيجتها أولًا، أو أعد نفس البيانات بنفس معرّف المحاولة.</p><Button type="button" variant="outline" disabled={submitting||createAttemptState.blocked} onClick={event=>{void submitTicket(event,true);}}>التحقق من نتيجة الطلب</Button></div>:null}
            <div className="space-y-2"><Label htmlFor="support-category">نوع المشكلة</Label><Select disabled={createAttemptState.locked||submitting||createAttemptState.blocked} value={category} onValueChange={(value) => setCategory(value as SupportCategory)}><SelectTrigger id="support-category"><SelectValue /></SelectTrigger><SelectContent>{Object.entries(categoryLabels).map(([value, label]) => <SelectItem key={value} value={value}>{label}</SelectItem>)}</SelectContent></Select></div>
            <div className="space-y-2"><Label htmlFor="support-subject">عنوان مختصر</Label><Input disabled={createAttemptState.locked||submitting||createAttemptState.blocked} id="support-subject" value={subject} onChange={(event) => setSubject(event.target.value)} minLength={3} maxLength={200} required /></div>
            <div className="space-y-2"><Label htmlFor="support-description">اشرح المشكلة وما الذي كنت تحاول فعله</Label><Textarea disabled={createAttemptState.locked||submitting||createAttemptState.blocked} id="support-description" value={description} onChange={(event) => setDescription(event.target.value)} minLength={10} maxLength={10000} className="min-h-32" required /></div>
            <Button type="submit" className="w-full" disabled={submitting||createAttemptState.blocked||!canSendContext}>{submitting && <Loader2 className="ml-2 h-4 w-4 animate-spin" />}{createAttemptState.uncertain?'إعادة نفس الطلب':'إرسال الطلب'}</Button>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}
