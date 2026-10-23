/**
 * M2-04 — existing instructor enrollment management page.
 *
 * The page renders; it does not orchestrate. Every read, mutation, latch and
 * lifetime lives in `src/features/enrollment/instructor-students.ts`, which is
 * the exact module the hermetic tests drive (src/tests/m2-instructor-students.test.ts).
 *
 * What changed here is deliberately narrow: the six reads now have their own
 * loading/error/empty state (a failed read is never an empty list and a failed
 * wallet read is never a confirmed zero), a confirmed invite/create/decision is
 * no longer reported as a failure when the follow-up read or the clipboard
 * fails, the invite button cannot rotate twice, a decision cannot be sent twice
 * and keeps its target on failure, and an edit typed while a save is in flight
 * is never cleared by that save's reply. A copy of an OLDER invite link can no
 * longer report the newer link as copied, and a confirmed action is never
 * published after the session or the instructor scope changed underneath it.
 *
 * M2-18 adds a bounded ACTIVE-branch selector per student: the page renders the
 * server's own catalog and assignment projection and forwards an explicit
 * assign/clear. It never invents a branch, never infers permission locally and
 * never shows a branch before the server named it for that student.
 */
import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { motion } from 'framer-motion';
import { Users, Search, Phone, GraduationCap, MapPin, Plus, Info, Link as LinkIcon, Copy, Check, X, ShieldAlert } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import Header from '@/components/Header';
import { createStudent, getGroups, getInstructorStudents, getInstructorWallet, rotateStudentInvite, getEnrollmentRequests,
  approveEnrollmentRequest, rejectEnrollmentRequest, getStudentPasswordResetRequests, approveStudentPasswordReset,
  getInstructorVideoViolations, suspendStudentForVideoSecurity,
  type VideoSecurityViolation, type StudentPasswordResetRequest, type EnrollmentRequest, type User } from '@/lib/api';
import { listMyTenantBranches, assignStudentBranch as assignStudentBranchRequest } from '@/lib/api-http';
import { useToast } from '@/hooks/use-toast';
import { subscribeSessionChange } from '@/lib/session-events';
import {
  createInstructorStudentsController,
  hasBusy,
  hasBusyTarget,
  readInstructorSessionPrincipal,
  STUDENT_BRANCH_CATALOG_LIMIT,
  type InstructorStudentsController,
  type InstructorStudentsState,
  type StudentFormValues,
} from '@/features/enrollment/instructor-students';
import StudentImportPreview from '@/features/students/StudentImportPreview';

const EMPTY_FORM: StudentFormValues = {
  name: '',
  student_type: 'offline',
  phone: '',
  guardian_phone: '',
  email: '',
  password: '',
  group_id: '',
};

/** The canonical session boundary: the token is compared inside the reader,
 *  never returned, rendered or sent anywhere. */
const readPrincipal = (): string | null => {
  try {
    return readInstructorSessionPrincipal(localStorage);
  } catch {
    return null;
  }
};

const readStoredUser = (): User | null => {
  try {
    const raw = localStorage.getItem('currentUser');
    if (!raw) return null;
    return JSON.parse(raw) as User;
  } catch {
    return null;
  }
};

const isAllowedRole = (user: User | null): boolean =>
  user?.role === 'instructor' || user?.role === 'admin';

export default function InstructorStudents() {
  const navigate = useNavigate();
  const { toast } = useToast();
  const [snapshot, setSnapshot] = useState<InstructorStudentsState | null>(null);
  const [form, setForm] = useState<StudentFormValues>(EMPTY_FORM);
  const [search, setSearch] = useState('');
  const [showAdd, setShowAdd] = useState(false);
  const controllerRef = useRef<InstructorStudentsController | null>(null);
  /** The form incarnation this page is showing: a save started by an older one
   *  can never clear or close the form the instructor is typing into now. */
  const formInstanceRef = useRef(0);

  useEffect(() => {
    const instance = createInstructorStudentsController({
      loadStudents: (instructorId) => getInstructorStudents(instructorId),
      loadWallet: (instructorId) => getInstructorWallet(instructorId),
      loadGroups: () => getGroups(),
      loadRequests: () => getEnrollmentRequests(),
      loadResetRequests: () => getStudentPasswordResetRequests(),
      loadViolations: () => getInstructorVideoViolations(),
      // M2-18 — the bounded ACTIVE-branch catalog, read as its own section.
      loadBranches: () => listMyTenantBranches({ limit: STUDENT_BRANCH_CATALOG_LIMIT }),
      assignStudentBranch: (studentId, branchId) => assignStudentBranchRequest(studentId, branchId),
      createStudent: (payload) => createStudent(payload),
      rotateInvite: () => rotateStudentInvite(),
      approveRequest: (id) => approveEnrollmentRequest(id),
      rejectRequest: (id, reason) => rejectEnrollmentRequest(id, reason),
      approvePasswordReset: (id) => approveStudentPasswordReset(id),
      suspendStudent: (studentUserId, minutes, reason) =>
        suspendStudentForVideoSecurity(studentUserId, minutes, reason),
      readPrincipal,
      subscribeSession: (listener) => subscribeSessionChange(() => listener()),
      readOrigin: () => window.location.origin,
      clipboard: typeof navigator !== 'undefined' && navigator.clipboard ? navigator.clipboard : null,
    });
    const unsubscribe = instance.subscribe(setSnapshot);
    controllerRef.current = instance;

    const user = readStoredUser();
    if (!user || !isAllowedRole(user)) {
      navigate('/auth');
      return () => {
        controllerRef.current = null;
        instance.dispose();
        unsubscribe();
      };
    }
    formInstanceRef.current = instance.openForm();
    void instance.loadAll(user.id);

    // A different principal must not inherit the previous instructor's form,
    // rows or private outputs.
    const unsubSession = subscribeSessionChange(() => {
      const next = readStoredUser();
      if (!next || !isAllowedRole(next)) {
        navigate('/auth');
        return;
      }
      formInstanceRef.current = instance.openForm();
      setForm(EMPTY_FORM);
      void instance.loadAll(next.id);
    });

    return () => {
      unsubSession();
      controllerRef.current = null;
      instance.dispose();
      unsubscribe();
    };
  }, [navigate]);

  const students = snapshot?.students ?? [];
  const studentsPhase = snapshot?.studentsPhase ?? 'idle';
  const requests = snapshot?.requests ?? [];
  const requestsPhase = snapshot?.requestsPhase ?? 'idle';
  const pendingRequests = requests.filter((request) => request.status === 'pending');
  const pendingResets = (snapshot?.resetRequests ?? []).filter((request) => request.status === 'pending');
  const violations = snapshot?.violations ?? [];
  const groups = snapshot?.groups ?? [];
  const adding = snapshot ? hasBusy(snapshot, 'add') : false;
  const rotating = snapshot ? hasBusy(snapshot, 'invite') : false;
  const copying = snapshot ? hasBusy(snapshot, 'copy') : false;
  const inviteUrl = snapshot?.inviteUrl ?? null;
  const inviteCopied = snapshot?.inviteCopied ?? null;

  // M2-18 — the bounded ACTIVE-branch catalog and the server-confirmed
  // assignments. Nothing here is inferred locally: a branch is only shown for
  // a student after the server's own projection named that student.
  const branches = snapshot?.branches ?? [];
  const branchesPhase = snapshot?.branchesPhase ?? 'idle';
  const branchAssignments = snapshot?.branchAssignments ?? {};
  const assigningBranch = snapshot ? hasBusy(snapshot, 'branch') : false;

  /** Arms the pending save target WITHOUT sending anything. `null` = clear. */
  const selectStudentBranch = (studentId: string, branchId: string | null) => {
    controllerRef.current?.selectBranch(studentId, branchId);
  };

  /** The explicit save. `denied`/`not-found` cleared the draft (and `conflict`
   *  or a transport `failed` kept it, so the same save can be retried). */
  const saveStudentBranch = async (studentId: string, branchId: string | null) => {
    const controller = controllerRef.current;
    if (!controller) return;
    const outcome = await controller.assignBranch(studentId, branchId);
    if (outcome === 'assigned') { toast({ title: 'تم تعيين الفرع' }); return; }
    if (outcome === 'cleared') { toast({ title: 'تم إزالة الفرع' }); return; }
    if (outcome === 'duplicate') {
      toast({ title: 'جارٍ الحفظ بالفعل', description: 'انتظر اكتمال العملية الحالية.' });
      return;
    }
    if (outcome === 'denied') {
      toast({ variant: 'destructive', title: 'غير مسموح', description: 'لا تملك صلاحية تعيين الفروع لهذا الطالب.' });
      return;
    }
    if (outcome === 'not-found') {
      toast({ variant: 'destructive', title: 'غير موجود', description: 'الطالب أو الفرع غير موجود داخل نطاقك.' });
      return;
    }
    if (outcome === 'conflict') {
      toast({ variant: 'destructive', title: 'تغيّرت البيانات', description: 'تعدّل الطالب أثناء الحفظ؛ حدّث الصفحة وأعد المحاولة.' });
      return;
    }
    if (outcome === 'invalid') {
      toast({ variant: 'destructive', title: 'بيانات غير صحيحة', description: 'الفرع المختار غير صالح.' });
      return;
    }
    // 'failed': the draft is retained beside the control; nothing else to say.
  };

  /** Every keystroke bumps the form revision: a save that completes while the
   *  instructor is still typing keeps the newer input instead of clearing it. */
  const editForm = (changes: Partial<StudentFormValues>) => {
    setForm((previous) => ({ ...previous, ...changes }));
    controllerRef.current?.noteFormEdit();
  };

  const openAddForm = () => {
    const controller = controllerRef.current;
    if (!controller) return;
    if (showAdd) {
      setShowAdd(false);
      controller.closeForm();
      return;
    }
    formInstanceRef.current = controller.openForm();
    setForm(EMPTY_FORM);
    setShowAdd(true);
  };

  const closeAddForm = () => {
    setShowAdd(false);
    controllerRef.current?.closeForm();
  };

  const createInvite = async () => {
    const controller = controllerRef.current;
    if (!controller) return;
    const outcome = await controller.rotateInvite();
    if (outcome === 'rotated') {
      toast({ title: 'تم إنشاء رابط جديد ونسخه', description: 'الرابط صالح لمدة 30 يومًا وأُلغي أي رابط أقدم.' });
      return;
    }
    if (outcome === 'rotated-not-copied') {
      toast({
        title: 'تم إنشاء الرابط',
        description: 'الرابط جاهز لكن المتصفح لم يسمح بالنسخ؛ استخدم زر نسخ الرابط بجانبه.',
      });
      return;
    }
    if (outcome === 'duplicate') {
      toast({ title: 'جارٍ إنشاء الرابط بالفعل', description: 'انتظر اكتمال العملية الحالية قبل إنشاء رابط آخر.' });
    }
  };

  const copyInvite = async () => {
    const controller = controllerRef.current;
    if (!controller) return;
    const outcome = await controller.copyInviteLink();
    if (outcome === 'copied') {
      toast({ title: 'تم نسخ الرابط' });
      return;
    }
    if (outcome === 'superseded') {
      // The copy finished, but the link it copied was replaced meanwhile: it
      // says nothing about the link now on screen.
      toast({ title: 'تغيّر الرابط أثناء النسخ', description: 'أُنشئ رابط أحدث؛ انسخ الرابط المعروض الآن.' });
      return;
    }
    if (outcome === 'unavailable') {
      toast({
        variant: 'destructive',
        title: 'تعذر النسخ',
        description: 'المتصفح لا يسمح بالوصول إلى الحافظة؛ حدّد الرابط وانسخه يدويًا.',
      });
    }
  };

  const decideRequest = async (request: EnrollmentRequest, accept: boolean) => {
    const controller = controllerRef.current;
    if (!controller) return;
    let reason: string | undefined;
    if (!accept) {
      const raw = window.prompt('اكتب سبب الرفض');
      if (!raw || !raw.trim()) return;
      reason = raw;
    }
    const outcome = await controller.decideRequest(request.id, accept, reason);
    if (outcome === 'approved') { toast({ title: 'تم قبول الطالب' }); return; }
    if (outcome === 'rejected') { toast({ title: 'تم رفض الطلب' }); return; }
    if (outcome === 'stale') {
      toast({ title: 'تمت معالجة الطلب مسبقًا', description: 'حُدّثت القائمة بحالة الخادم الحالية.' });
      return;
    }
    if (outcome === 'duplicate') {
      toast({ title: 'جارٍ تنفيذ قرار بالفعل', description: 'انتظر اكتمال القرار الحالي.' });
      return;
    }
    if (outcome === 'invalid') {
      toast({ variant: 'destructive', title: 'بيانات غير مكتملة', description: 'سبب الرفض مطلوب (3 أحرف على الأقل).' });
    }
  };

  const approvePasswordReset = async (request: StudentPasswordResetRequest) => {
    const controller = controllerRef.current;
    if (!controller) return;
    const outcome = await controller.approveReset(request.id);
    if (outcome === 'issued' || outcome === 'issued-not-copied') {
      const code = controller.getState().resetCode;
      if (code) {
        // Existing manual delivery path: the code is shown once and never
        // logged. No OTP, provider or automatic message is involved.
        window.prompt(
          `الكود صالح ${code.expiresInMinutes} دقيقة. أرسله للطالب عبر قناة آمنة، ولن يظهر مرة أخرى:`,
          code.token
        );
      }
      controller.clearResetCode();
      toast({
        title: outcome === 'issued' ? 'تم إصدار كود أحادي الاستخدام ونسخه' : 'تم إصدار كود أحادي الاستخدام',
        description: outcome === 'issued' ? undefined : 'لم يسمح المتصفح بالنسخ؛ انقل الكود الظاهر الآن.',
      });
      return;
    }
    if (outcome === 'stale') {
      toast({ title: 'تمت معالجة الطلب مسبقًا', description: 'حُدّثت القائمة بحالة الخادم الحالية.' });
    }
  };

  const suspendForVideoViolation = async (violation: VideoSecurityViolation) => {
    const controller = controllerRef.current;
    if (!controller) return;
    const rawMinutes = window.prompt('مدة التعليق بالدقائق (من 5 إلى 1440)', '30');
    if (!rawMinutes) return;
    const reason = window.prompt('سبب التعليق', `مراجعة أمنية: ${violation.activity_type}`);
    if (!reason?.trim()) return;
    const outcome = await controller.suspendStudent(violation, rawMinutes, reason);
    if (outcome === 'suspended') {
      toast({ title: 'تم تعليق حساب الطالب وتسجيل خروجه' });
      return;
    }
    if (outcome === 'duplicate') {
      toast({ title: 'جارٍ تعليق هذا الحساب بالفعل' });
    }
  };

  const addStudent = async (event: React.FormEvent) => {
    event.preventDefault();
    const controller = controllerRef.current;
    if (!controller) return;
    const outcome = await controller.submitStudent(form, formInstanceRef.current);
    if (outcome === 'created') {
      // The server confirmed the write: only now is the typed form cleared.
      toast({ title: 'تمت إضافة الطالب', description: form.student_type === 'online' ? 'تم إنشاء حساب دخول للطالب وربطه بك.' : 'تم تسجيل الطالب الأوفلاين وربطه بك دون حساب دخول.' });
      setForm(EMPTY_FORM);
      formInstanceRef.current = controller.openForm();
      setShowAdd(false);
      return;
    }
    if (outcome === 'created-edited') {
      toast({
        title: 'تمت إضافة الطالب',
        description: 'أُضيف الطالب، لكن النموذج يحتوي تعديلات أحدث فلم يُمسح؛ راجعه قبل الإضافة التالية.',
      });
      return;
    }
    if (outcome === 'created-closed') {
      toast({ title: 'تمت إضافة الطالب' });
      return;
    }
    if (outcome === 'duplicate') {
      toast({ title: 'جارٍ حفظ الطالب بالفعل', description: 'انتظر اكتمال الحفظ الحالي.' });
      return;
    }
    if (outcome === 'invalid') {
      toast({ variant: 'destructive', title: 'بيانات غير مكتملة', description: 'راجع الحقول المطلوبة أدناه.' });
      return;
    }
    if (outcome === 'rejected') {
      toast({ variant: 'destructive', title: 'غير مسموح', description: 'لا يمكن إضافة الطالب لهذه المجموعة.' });
    }
  };

  const filteredStudents = students.filter((student) =>
    student.name?.toLowerCase().includes(search.toLowerCase()) || student.phone?.includes(search)
  );

  const studentCount = studentsPhase === 'ready' || studentsPhase === 'empty' ? students.length : null;

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-50 via-blue-50 to-cyan-50" dir="rtl">
      <Header />

      <main className="container mx-auto px-4 py-8">
        <motion.div initial={{ opacity: 0, y: -20 }} animate={{ opacity: 1, y: 0 }} className="mb-6">
          <h1 className="text-3xl font-bold bg-gradient-to-r from-blue-600 to-cyan-600 bg-clip-text text-transparent flex items-center gap-2">
            <Users className="w-8 h-8 text-blue-600" />
            تسجيل وطلبات الطلاب
          </h1>
          <div className="mt-2 flex flex-wrap items-center justify-between gap-3">
            <p className="text-slate-500">
              {studentCount === null ? 'جارٍ التحقق من قائمة طلابك…' : `${studentCount} طالب مسجل`} — تظهر هنا بيانات طلابك فقط.
            </p>
            <Button onClick={openAddForm}><Plus className="ml-2 h-4 w-4" />إضافة طالب</Button>
          </div>
        </motion.div>

        <div className="mb-6 rounded-lg border border-blue-200 bg-blue-50 p-3 text-sm leading-6 text-blue-900"><Info className="ml-1 inline h-4 w-4" /><strong>الطالب الأوفلاين</strong> سجل للحضور والمتابعة داخل السنتر ولا يحتاج كلمة مرور. <strong>طالب الأونلاين</strong> يُنشأ له حساب دخول برقم الهاتف وكلمة المرور ليستخدم محتوى المنصة. في الحالتين يُربط الطالب بحسابك ولا يظهر لمدرس آخر.</div>

        <Card className="mb-6 border-cyan-200"><CardContent className="space-y-3 p-5">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h2 className="flex items-center gap-2 font-bold"><LinkIcon className="h-5 w-5" />رابط تسجيل طلابك</h2>
              <p className="text-sm text-slate-500">أنشئ الرابط وشاركه مع الطلاب. كل طلب ينتظر موافقتك.</p>
            </div>
            <Button onClick={createInvite} disabled={rotating}>
              <Copy className="ml-2 h-4 w-4" />{rotating ? 'جارٍ الإنشاء…' : 'إنشاء رابط جديد ونسخه'}
            </Button>
          </div>
          {inviteUrl && (
            <div className="space-y-2">
              <Input readOnly dir="ltr" value={inviteUrl} onFocus={(e) => e.currentTarget.select()} />
              <div className="flex flex-wrap items-center gap-2">
                <Button size="sm" variant="outline" onClick={copyInvite} disabled={copying}>
                  <Copy className="ml-1 h-4 w-4" />{copying ? 'جارٍ النسخ…' : 'نسخ الرابط'}
                </Button>
                {inviteCopied === true && <span className="text-sm text-emerald-700">تم نسخ الرابط.</span>}
                {inviteCopied === false && (
                  <span className="text-sm text-amber-700">لم يسمح المتصفح بالنسخ — الرابط صالح، انسخه يدويًا.</span>
                )}
              </div>
            </div>
          )}
          {snapshot?.inviteError && <p className="text-sm text-red-700">{snapshot.inviteError}</p>}
        </CardContent></Card>

        <Card className="mb-6 border-amber-200"><CardContent className="space-y-3 p-5">
          <div className="flex items-center justify-between gap-3">
            <div>
              <h2 className="font-bold">طلبات تسجيل الطلاب المنتظرة</h2>
              <p className="text-sm text-slate-500">الطلبات التي أرسلها الطلاب من رابطك تظهر هنا حتى تقبلها أو ترفضها.</p>
            </div>
            <Badge className="bg-amber-100 text-amber-800">
              {requestsPhase === 'ready' || requestsPhase === 'empty' ? `${pendingRequests.length} منتظر` : '—'}
            </Badge>
          </div>
          {snapshot?.requestsError && (
            <div className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-800">
              <p>{snapshot.requestsError}</p>
              <Button size="sm" variant="outline" className="mt-2" onClick={() => void controllerRef.current?.loadRequests()}>
                إعادة المحاولة
              </Button>
            </div>
          )}
          {requestsPhase === 'loading' && <div className="rounded-lg border border-dashed p-6 text-center text-sm text-slate-500">جارٍ تحميل الطلبات…</div>}
          {requestsPhase === 'error' && !snapshot?.requestsError && <div className="rounded-lg border border-dashed p-6 text-center text-sm text-slate-500">تعذر تحميل الطلبات.</div>}
          {(requestsPhase === 'ready' || requestsPhase === 'empty') && pendingRequests.length === 0 && (
            <div className="rounded-lg border border-dashed p-6 text-center text-sm text-slate-500">لا توجد طلبات تسجيل منتظرة حاليًا. أنشئ الرابط بالأعلى وشاركه مع طلابك.</div>
          )}
          {pendingRequests.map((request) => {
            const deciding = snapshot ? hasBusyTarget(snapshot, 'decision', request.id) : false;
            return (
              <div key={request.id} className="flex flex-wrap items-center justify-between gap-3 rounded-lg border p-3">
                <div>
                  <p className="font-medium">{request.student_name}</p>
                  <p className="text-sm text-slate-500" dir="ltr">{request.phone}</p>
                  <p className="text-sm">{request.grade_name} — {request.group_name} | ولي الأمر: {request.guardian_name} ({request.guardian_phone})</p>
                </div>
                <div className="flex gap-2">
                  <Button size="sm" onClick={() => decideRequest(request, true)} disabled={deciding}>
                    <Check className="ml-1 h-4 w-4" />قبول وإنشاء الحساب
                  </Button>
                  <Button size="sm" variant="destructive" onClick={() => decideRequest(request, false)} disabled={deciding}>
                    <X className="ml-1 h-4 w-4" />رفض
                  </Button>
                </div>
              </div>
            );
          })}
          {snapshot?.decisionError && <p className="text-sm text-red-700">{snapshot.decisionError}</p>}
        </CardContent></Card>

        {pendingResets.length > 0 && (
          <Card className="mb-6 border-amber-200"><CardContent className="space-y-3 p-5">
            <h2 className="font-bold">طلبات استرجاع الحساب</h2>
            <p className="text-sm text-slate-500">تحقق من هوية الطالب خارج المنصة قبل إصدار الكود.</p>
            {pendingResets.map((request) => {
              const issuing = snapshot ? hasBusyTarget(snapshot, 'reset', request.id) : false;
              return (
                <div key={request.id} className="flex flex-wrap items-center justify-between gap-3 rounded-lg border p-3">
                  <div>
                    <p className="font-medium">{request.name}</p>
                    <p className="text-sm text-slate-500" dir="ltr">{request.phone}</p>
                  </div>
                  <Button size="sm" variant="outline" onClick={() => approvePasswordReset(request)} disabled={issuing}>
                    {issuing ? 'جارٍ الإصدار…' : 'إصدار كود 15 دقيقة'}
                  </Button>
                </div>
              );
            })}
            {snapshot?.resetActionError && <p className="text-sm text-red-700">{snapshot.resetActionError}</p>}
          </CardContent></Card>
        )}

        {violations.length > 0 && (
          <Card className="mb-6 border-red-200"><CardContent className="space-y-3 p-5">
            <h2 className="flex items-center gap-2 font-bold text-red-800"><ShieldAlert className="h-5 w-5" />تنبيهات حماية الفيديو</h2>
            <p className="text-sm text-slate-500">آخر محاولات الالتقاط أو السلوك غير المعتاد لطلابك. الإشارات منخفضة الثقة ليست دليلاً قاطعًا بمفردها.</p>
            {violations.slice(0, 20).map((item) => {
              const suspending = snapshot ? hasBusyTarget(snapshot, 'suspend', item.student_user_id) : false;
              return (
                <div key={item.id} className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-red-100 bg-red-50/40 p-3">
                  <div>
                    <p className="font-medium">{item.student_name} — {item.activity_type}</p>
                    <p className="text-xs text-slate-500">{item.video_title || 'فيديو'} | ثقة: {item.confidence} | نقاط: {item.violation_weight} | {new Date(item.created_at).toLocaleString('ar-EG')}</p>
                    {item.details && <p className="mt-1 max-w-2xl text-xs text-slate-600">{item.details}</p>}
                  </div>
                  <Button size="sm" variant="destructive" onClick={() => suspendForVideoViolation(item)} disabled={suspending}>
                    {suspending ? 'جارٍ التعليق…' : 'تعليق الحساب'}
                  </Button>
                </div>
              );
            })}
            {snapshot?.securityError && <p className="text-sm text-red-700">{snapshot.securityError}</p>}
          </CardContent></Card>
        )}

        {showAdd && (
          <Card className="mb-6 border-blue-200"><CardContent className="p-5">
            <form className="grid gap-4 md:grid-cols-2" onSubmit={addStudent}>
              <div className="space-y-1"><Label>نوع الطالب</Label><select className="w-full rounded-md border bg-white p-2" value={form.student_type} onChange={(e) => editForm({ student_type: e.target.value, password: e.target.value === 'offline' ? '' : form.password })}><option value="offline">أوفلاين — متابعة وحضور دون حساب دخول</option><option value="online">أونلاين — له حساب دخول للمنصة</option></select></div>
              <div className="space-y-1"><Label>اسم الطالب</Label><Input value={form.name} onChange={(e) => editForm({ name: e.target.value })} placeholder="الاسم الكامل" />{snapshot?.fieldErrors.name && <p className="text-xs text-red-700">{snapshot.fieldErrors.name}</p>}</div>
              <div className="space-y-1"><Label>رقم هاتف الطالب {form.student_type === 'online' ? '(مطلوب للدخول)' : '(اختياري)'}</Label><Input dir="ltr" inputMode="tel" value={form.phone} onChange={(e) => editForm({ phone: e.target.value })} placeholder="01xxxxxxxxx" />{snapshot?.fieldErrors.phone && <p className="text-xs text-red-700">{snapshot.fieldErrors.phone}</p>}</div>
              <div className="space-y-1"><Label>رقم ولي الأمر (اختياري)</Label><Input dir="ltr" inputMode="tel" value={form.guardian_phone} onChange={(e) => editForm({ guardian_phone: e.target.value })} /></div>
              <div className="space-y-1"><Label>البريد الإلكتروني (اختياري)</Label><Input dir="ltr" type="email" value={form.email} onChange={(e) => editForm({ email: e.target.value })} /></div>
              <div className="space-y-1"><Label>المجموعة (اختياري)</Label><select className="w-full rounded-md border bg-white p-2" value={form.group_id} onChange={(e) => editForm({ group_id: e.target.value })}><option value="">بدون مجموعة الآن</option>{groups.map((group) => <option key={group.id} value={group.id}>{group.name}</option>)}</select>{snapshot?.groupsError && <p className="text-xs text-amber-700">تعذر تحميل المجموعات؛ يمكن الحفظ بدون مجموعة أو إعادة المحاولة.</p>}</div>
              {form.student_type === 'online' && (
                <div className="space-y-1 md:col-span-2">
                  <Label>كلمة مرور الطالب</Label>
                  <Input dir="ltr" type="password" minLength={10} maxLength={128} autoComplete="new-password" value={form.password} onChange={(e) => editForm({ password: e.target.value })} placeholder="10 أحرف على الأقل" />
                  {snapshot?.fieldErrors.password && <p className="text-xs text-red-700">{snapshot.fieldErrors.password}</p>}
                  <p className="text-xs text-slate-500">سلّمها للطالب بطريقة آمنة؛ سيدخل باستخدام رقم الهاتف المكتوب أعلاه.</p>
                </div>
              )}
              {snapshot?.addError && <p className="text-sm text-red-700 md:col-span-2">{snapshot.addError}</p>}
              <div className="flex gap-2 md:col-span-2">
                <Button type="submit" disabled={adding}>{adding ? 'جارٍ الحفظ…' : 'حفظ الطالب'}</Button>
                <Button type="button" variant="outline" onClick={closeAddForm}>إلغاء</Button>
              </div>
            </form>
          </CardContent></Card>
        )}

        {/* M2-08: the local, read-only student CSV preview. It is mounted on
            its own and shares nothing with the enrollment controller above:
            it never calls an API, never creates a student and never touches
            the stored enrollment state. */}
        <StudentImportPreview />

        {/* M2-18 — the bounded ACTIVE-branch catalog, read as its own section.
            Only active branches are selectable; the page never drains further
            pages. Assigning a branch is planning metadata and never changes a
            student's login, enrollment, group, access, pricing or billing. */}
        <Card className="mb-6 border-emerald-200"><CardContent className="space-y-3 p-5">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h2 className="flex items-center gap-2 font-bold"><MapPin className="h-5 w-5" />فروع المركز</h2>
              <p className="text-sm text-slate-500">الفروع النشطة فقط يمكن تعيينها لطالب. تعيين الفرع بيانات تخطيطية لا تغيّر الدخول أو الاشتراك أو الفواتير.</p>
            </div>
            <Badge className="bg-emerald-100 text-emerald-800">
              {branchesPhase === 'ready' || branchesPhase === 'empty' ? `${branches.length} فرع` : '—'}
            </Badge>
          </div>
          {snapshot?.branchesError && (
            <div className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-800">
              <p>{snapshot.branchesError}</p>
              <Button size="sm" variant="outline" className="mt-2" onClick={() => void controllerRef.current?.loadBranches()}>
                إعادة المحاولة
              </Button>
            </div>
          )}
          {branchesPhase === 'loading' && <div className="rounded-lg border border-dashed p-6 text-center text-sm text-slate-500">جارٍ تحميل الفروع…</div>}
          {branchesPhase === 'error' && !snapshot?.branchesError && <div className="rounded-lg border border-dashed p-6 text-center text-sm text-slate-500">تعذر تحميل الفروع.</div>}
          {(branchesPhase === 'ready' || branchesPhase === 'empty') && branches.length === 0 && (
            <div className="rounded-lg border border-dashed p-6 text-center text-sm text-slate-500">لا توجد فروع نشطة بعد.</div>
          )}
          {branches.length > 0 && (
            <div className="flex flex-wrap gap-2">
              {branches.map((branch) => (
                <Badge key={branch.id} variant="outline" className="bg-emerald-50 border-emerald-200 text-emerald-700">
                  <MapPin className="w-3 h-3 ml-1" />{branch.name}
                </Badge>
              ))}
              {snapshot?.branchesHasMore && (
                <span className="text-xs text-amber-700">توجد فروع أخرى غير معروضة (القائمة مقتصرة على {STUDENT_BRANCH_CATALOG_LIMIT}).</span>
              )}
            </div>
          )}
        </CardContent></Card>

        {/* Search */}
        <div className="relative mb-6">
          <Search className="absolute right-3 top-2.5 w-4 h-4 text-slate-400" />
          <Input
            placeholder="ابحث بالاسم أو رقم الهاتف…"
            className="pr-9"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>

        {snapshot?.studentsError && studentsPhase !== 'error' && (
          <div className="mb-4 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-800">
            <p>{snapshot.studentsError}</p>
            <Button size="sm" variant="outline" className="mt-2" onClick={() => void controllerRef.current?.loadStudents()}>
              إعادة المحاولة
            </Button>
          </div>
        )}

        {/* Students grid */}
        {studentsPhase === 'idle' || studentsPhase === 'loading' ? (
          <div className="text-center py-16 text-slate-400">جاري التحميل…</div>
        ) : studentsPhase === 'error' ? (
          <Card className="border-0 shadow-sm">
            <CardContent className="py-16 text-center text-slate-500">
              <Users className="w-14 h-14 mx-auto mb-4 opacity-20" />
              <p className="font-medium">تعذر تحميل قائمة الطلاب</p>
              <p className="mt-1 text-sm">هذه ليست قائمة فارغة؛ لم يصل رد صالح من الخادم.</p>
              <Button size="sm" variant="outline" className="mt-3" onClick={() => void controllerRef.current?.loadStudents()}>
                إعادة المحاولة
              </Button>
            </CardContent>
          </Card>
        ) : filteredStudents.length === 0 ? (
          <Card className="border-0 shadow-sm">
            <CardContent className="py-16 text-center text-slate-400">
              <Users className="w-14 h-14 mx-auto mb-4 opacity-20" />
              <p className="font-medium">{students.length === 0 ? 'لا يوجد طلاب مسجلين بعد' : 'لا توجد نتائج للبحث'}</p>
            </CardContent>
          </Card>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {filteredStudents.map((student, i) => (
              <motion.div
                key={student.id}
                initial={{ opacity: 0, y: 20 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: i * 0.05 }}
              >
                <Card className="border-0 shadow-sm hover:shadow-lg transition-shadow">
                  <CardContent className="p-5">
                    <div className="flex items-start gap-3">
                      <div className="w-12 h-12 rounded-full bg-gradient-to-br from-blue-500 to-cyan-500 flex items-center justify-center text-white font-bold text-lg shrink-0">
                        {student.name?.charAt(0)}
                      </div>
                      <div className="flex-1 min-w-0">
                        <h3 className="font-semibold text-slate-800 truncate">{student.name}</h3>
                        {student.phone && (
                          <div className="flex items-center gap-1 text-sm text-slate-500 mt-1">
                            <Phone className="w-3 h-3" />
                            <span dir="ltr">{student.phone}</span>
                          </div>
                        )}
                        <div className="flex items-center gap-2 mt-2 flex-wrap">
                          {student.is_offline !== null && (
                            <Badge variant="outline" className={student.is_offline ? 'bg-amber-50 text-amber-700' : 'bg-emerald-50 text-emerald-700'}>{student.is_offline ? 'أوفلاين' : 'أونلاين'}</Badge>
                          )}
                          {student.grade_name && (
                            <Badge variant="outline" className="text-xs bg-blue-50 border-blue-200 text-blue-700">
                              <GraduationCap className="w-3 h-3 ml-1" />
                              {student.grade_name}
                            </Badge>
                          )}
                          {student.group_name && (
                            <Badge variant="outline" className="text-xs bg-cyan-50 border-cyan-200 text-cyan-700">
                              <MapPin className="w-3 h-3 ml-1" />
                              {student.group_name}
                            </Badge>
                          )}
                        </div>
                        {/* M2-18 — planning-only branch assignment. The select is
                            bounded to the ACTIVE catalog; saving is explicit and
                            the shown branch is only ever the server's reply. */}
                        {(() => {
                          const draftActive = snapshot?.branchDraftStudentId === student.id;
                          const assignment = branchAssignments[student.id];
                          const selectValue = draftActive ? (snapshot?.branchDraftId ?? '') : (assignment?.branch_id ?? '');
                          return (
                            <div className="mt-3 space-y-1">
                              <div className="flex items-center gap-1 text-xs text-slate-500">
                                <MapPin className="w-3 h-3" />
                                <span>{assignment ? `الفرع: ${assignment.branch_name}` : 'بدون فرع'}</span>
                              </div>
                              <select
                                className="w-full rounded-md border bg-white p-1 text-sm disabled:opacity-60"
                                value={selectValue}
                                disabled={branchesPhase !== 'ready' && branchesPhase !== 'empty'}
                                onChange={(e) => selectStudentBranch(student.id, e.target.value ? e.target.value : null)}
                              >
                                <option value="">بدون فرع</option>
                                {branches.map((branch) => (
                                  <option key={branch.id} value={branch.id}>{branch.name}</option>
                                ))}
                              </select>
                              <div className="flex flex-wrap gap-1">
                                {draftActive ? (
                                  <>
                                    <Button size="sm" onClick={() => void saveStudentBranch(student.id, snapshot?.branchDraftId ?? null)} disabled={assigningBranch}>
                                      {assigningBranch ? 'جارٍ الحفظ…' : 'حفظ الفرع'}
                                    </Button>
                                    <Button size="sm" variant="ghost" onClick={() => controllerRef.current?.clearBranchDraft()} disabled={assigningBranch}>إلغاء</Button>
                                  </>
                                ) : (
                                  assignment && (
                                    <Button size="sm" variant="outline" onClick={() => void saveStudentBranch(student.id, null)} disabled={assigningBranch}>
                                      {assigningBranch ? 'جارٍ الإزالة…' : 'إزالة الفرع'}
                                    </Button>
                                  )
                                )}
                              </div>
                              {draftActive && snapshot?.branchError && <p className="text-xs text-red-700">{snapshot.branchError}</p>}
                            </div>
                          );
                        })()}
                      </div>
                    </div>
                  </CardContent>
                </Card>
              </motion.div>
            ))}
          </div>
        )}
      </main>
    </div>
  );
}
