import { useState, useEffect, useRef, useCallback } from 'react';
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
  type VideoSecurityViolation, type StudentPasswordResetRequest, type EnrollmentRequest, type Group, User } from '@/lib/api';
import { useToast } from '@/hooks/use-toast';

export default function InstructorStudents() {
  const navigate = useNavigate();
  const { toast } = useToast();
  const [currentUser, setCurrentUser] = useState<User | null>(null);
  const [walletBalance, setWalletBalance] = useState(0);
  const [students, setStudents] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [groups, setGroups] = useState<Group[]>([]);
  const [showAdd, setShowAdd] = useState(false);
  const [saving, setSaving] = useState(false);
  const [inviteUrl, setInviteUrl] = useState('');
  const [requests, setRequests] = useState<EnrollmentRequest[]>([]);
  const [resetRequests, setResetRequests] = useState<StudentPasswordResetRequest[]>([]);
  const [videoViolations, setVideoViolations] = useState<VideoSecurityViolation[]>([]);
  const [busyRequestId, setBusyRequestId] = useState<string | null>(null);
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [form, setForm] = useState({ name: '', student_type: 'offline', phone: '', guardian_phone: '', email: '', password: '', group_id: '' });

  /** Sync guards: only the latest load may commit; one mutating action at a time. */
  const loadSeqRef = useRef(0);
  const mountedRef = useRef(true);
  const busyActionRef = useRef<string | null>(null);
  const decisionRef = useRef<string | null>(null);

  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  const loadData = useCallback(async (id: string) => {
    const seq = ++loadSeqRef.current;
    try {
      setLoading(true);
      const [studentsData, walletData] = await Promise.allSettled([
        getInstructorStudents(id),
        getInstructorWallet(id),
      ]);
      if (seq !== loadSeqRef.current || !mountedRef.current) return;

      let loadFailed = false;
      if (studentsData.status === 'fulfilled') setStudents(studentsData.value || []);
      else { loadFailed = true; console.error('Students load error:', studentsData.reason); }
      if (walletData.status === 'fulfilled') setWalletBalance(Number(walletData.value?.balance ?? 0));
      else { loadFailed = true; console.error('Wallet load error:', walletData.reason); }

      if (loadFailed) {
        setLoadError('تعذر تحميل قائمة الطلاب');
      } else {
        setLoadError(null);
      }
      const [groupsResult, requestsResult, resetsResult, violationsResult] = await Promise.allSettled([
        getGroups(),
        getEnrollmentRequests(),
        getStudentPasswordResetRequests(),
        getInstructorVideoViolations(),
      ]);
      if (seq !== loadSeqRef.current || !mountedRef.current) return;
      if (loadFailed || [groupsResult, requestsResult, resetsResult, violationsResult].some(result => result.status === 'rejected')) {
        setLoadError('تعذر تحميل بعض بيانات الصفحة؛ القيم المعروضة قد تكون غير مكتملة');
      }
      setGroups(groupsResult.status === 'fulfilled' ? groupsResult.value : []);
      setRequests(requestsResult.status === 'fulfilled' ? requestsResult.value : []);
      setResetRequests(resetsResult.status === 'fulfilled' ? resetsResult.value : []);
      setVideoViolations(violationsResult.status === 'fulfilled' ? violationsResult.value : []);
    } catch (err) {
      console.error('Load error:', err);
      if (seq === loadSeqRef.current && mountedRef.current) setLoadError('تعذر تحميل البيانات');
    } finally {
      if (seq === loadSeqRef.current && mountedRef.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    const userStr = localStorage.getItem('currentUser');
    if (!userStr) { navigate('/auth'); return; }
    let user: User;
    try {
      user = JSON.parse(userStr) as User;
    } catch (error) {
      console.error('Error parsing user data:', error);
      navigate('/auth');
      return;
    }
    if (user.role !== 'instructor' && user.role !== 'admin') { navigate('/auth'); return; }
    setCurrentUser(user);
    loadData(user.id);
  }, [loadData, navigate]);

  const markBusy = (key: string): boolean => {
    if (busyActionRef.current) return false;
    busyActionRef.current = key;
    setBusyAction(key);
    return true;
  };

  const clearBusy = () => {
    busyActionRef.current = null;
    setBusyAction(null);
  };

  const approvePasswordReset = async (request: StudentPasswordResetRequest) => {
    if (!markBusy(`password-reset:${request.id}`)) return;
    try {
      const result = await approveStudentPasswordReset(request.id);
      await navigator.clipboard?.writeText(result.reset_token);
      window.prompt(`الكود صالح ${result.expires_in_minutes} دقيقة. أرسله للطالب عبر قناة آمنة، ولن يظهر مرة أخرى:`, result.reset_token);
      if (currentUser) await loadData(currentUser.id);
      toast({ title: 'تم إصدار كود أحادي الاستخدام ونسخه' });
    } catch (error) { toast({ variant: 'destructive', title: 'تعذر إصدار الكود', description: error instanceof Error ? error.message : 'خطأ غير متوقع' }); }
    finally { clearBusy(); }
  };

  const createInvite = async () => {
    if (!markBusy('invite')) return;
    try {
      const invite = await rotateStudentInvite();
      const url = `${window.location.origin}/join/${invite.token}`;
      setInviteUrl(url);
      await navigator.clipboard?.writeText(url);
      toast({ title: 'تم إنشاء رابط جديد ونسخه', description: 'الرابط صالح لمدة 30 يومًا وأُلغي أي رابط أقدم.' });
    } catch (error) { toast({ variant: 'destructive', title: 'تعذر إنشاء الرابط', description: error instanceof Error ? error.message : 'خطأ غير متوقع' }); }
    finally { clearBusy(); }
  };

  const decideRequest = async (request: EnrollmentRequest, accept: boolean) => {
    if (decisionRef.current) return; // one enrollment decision at a time
    decisionRef.current = request.id;
    setBusyRequestId(request.id);
    try {
      if (accept) await approveEnrollmentRequest(request.id);
      else {
        const reason = window.prompt('اكتب سبب الرفض');
        if (!reason?.trim()) return;
        await rejectEnrollmentRequest(request.id, reason.trim());
      }
      // Server confirmed; refresh without reporting a fake success on refresh failure.
      try {
        if (currentUser) await loadData(currentUser.id);
      } catch (refreshError) {
        console.error('Error refreshing after decision:', refreshError);
      }
      toast({ title: accept ? 'تم قبول الطالب' : 'تم رفض الطلب' });
    } catch (error) { toast({ variant: 'destructive', title: 'تعذر تنفيذ القرار', description: error instanceof Error ? error.message : 'خطأ غير متوقع' }); }
    finally {
      decisionRef.current = null;
      setBusyRequestId(null);
    }
  };

  const suspendForVideoViolation = async (violation: VideoSecurityViolation) => {
    const rawMinutes = window.prompt('مدة التعليق بالدقائق (من 5 إلى 1440)', '30');
    if (!rawMinutes) return;
    const reason = window.prompt('سبب التعليق', `مراجعة أمنية: ${violation.activity_type}`);
    if (!reason?.trim()) return;
    if (!markBusy(`suspend:${violation.id}`)) return;
    try {
      await suspendStudentForVideoSecurity(violation.student_user_id, Number(rawMinutes), reason.trim());
      toast({ title: 'تم تعليق حساب الطالب وتسجيل خروجه' });
      if (currentUser) await loadData(currentUser.id);
    } catch (error) {
      toast({ variant: 'destructive', title: 'تعذر تعليق الحساب', description: error instanceof Error ? error.message : 'خطأ غير متوقع' });
    } finally { clearBusy(); }
  };

  const addStudent = async (event: React.FormEvent) => {
    event.preventDefault();
    if (busyActionRef.current) return; // synchronous guard: no duplicate creates
    const online = form.student_type === 'online';
    if (!form.name.trim() || (online && (!form.phone.trim() || form.password.length < 10))) {
      toast({ variant: 'destructive', title: 'بيانات غير مكتملة', description: online ? 'طالب الأونلاين يحتاج الاسم والهاتف وكلمة مرور من 10 أحرف على الأقل.' : 'اسم الطالب مطلوب.' });
      return;
    }
    busyActionRef.current = 'add-student';
    setBusyAction('add-student');
    setSaving(true);
    try {
      await createStudent({ name: form.name.trim(), phone: form.phone.trim() || undefined, email: form.email.trim() || undefined,
        guardian_phone: form.guardian_phone.trim() || undefined, group_id: form.group_id || undefined,
        is_offline: !online, password: online ? form.password : undefined, approval_status: 'approved' });
      toast({ title: 'تمت إضافة الطالب', description: online ? 'تم إنشاء حساب دخول للطالب وربطه بك.' : 'تم تسجيل الطالب الأوفلاين وربطه بك دون حساب دخول.' });
      setForm({ name: '', student_type: 'offline', phone: '', guardian_phone: '', email: '', password: '', group_id: '' });
      setShowAdd(false);
      if (currentUser) await loadData(currentUser.id);
    } catch (error) {
      toast({ variant: 'destructive', title: 'تعذر إضافة الطالب', description: error instanceof Error ? error.message : 'حدث خطأ غير متوقع' });
    } finally {
      busyActionRef.current = null;
      setBusyAction(null);
      setSaving(false);
    }
  };

  const filteredStudents = students.filter(s =>
    s.name?.toLowerCase().includes(search.toLowerCase()) ||
    s.phone?.includes(search)
  );

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-50 via-blue-50 to-cyan-50" dir="rtl">
      <Header />

      <main className="container mx-auto px-4 py-8">
        <motion.div initial={{ opacity: 0, y: -20 }} animate={{ opacity: 1, y: 0 }} className="mb-6">
          <h1 className="text-3xl font-bold bg-gradient-to-r from-blue-600 to-cyan-600 bg-clip-text text-transparent flex items-center gap-2">
            <Users className="w-8 h-8 text-blue-600" />
            تسجيل وطلبات الطلاب
          </h1>
          <div className="mt-2 flex flex-wrap items-center justify-between gap-3"><p className="text-slate-500">{students.length} طالب مسجل — تظهر هنا بيانات طلابك فقط.</p><Button onClick={() => setShowAdd(v => !v)}><Plus className="ml-2 h-4 w-4" />إضافة طالب</Button></div>
        </motion.div>

        <div className="mb-6 rounded-lg border border-blue-200 bg-blue-50 p-3 text-sm leading-6 text-blue-900"><Info className="ml-1 inline h-4 w-4" /><strong>الطالب الأوفلاين</strong> سجل للحضور والمتابعة داخل السنتر ولا يحتاج كلمة مرور. <strong>طالب الأونلاين</strong> يُنشأ له حساب دخول برقم الهاتف وكلمة المرور ليستخدم محتوى المنصة. في الحالتين يُربط الطالب بحسابك ولا يظهر لمدرس آخر.</div>

        <Card className="mb-6 border-cyan-200"><CardContent className="space-y-3 p-5"><div className="flex flex-wrap items-center justify-between gap-3"><div><h2 className="flex items-center gap-2 font-bold"><LinkIcon className="h-5 w-5" />رابط تسجيل طلابك</h2><p className="text-sm text-slate-500">أنشئ الرابط وشاركه مع الطلاب. كل طلب ينتظر موافقتك.</p></div><Button disabled={busyAction !== null} onClick={createInvite}><Copy className="ml-2 h-4 w-4" />إنشاء رابط جديد ونسخه</Button></div>{inviteUrl && <Input readOnly dir="ltr" value={inviteUrl} onFocus={e => e.currentTarget.select()} />}</CardContent></Card>

        <Card className="mb-6 border-amber-200"><CardContent className="space-y-3 p-5">
          <div className="flex items-center justify-between gap-3"><div><h2 className="font-bold">طلبات تسجيل الطلاب المنتظرة</h2><p className="text-sm text-slate-500">الطلبات التي أرسلها الطلاب من رابطك تظهر هنا حتى تقبلها أو ترفضها.</p></div><Badge className="bg-amber-100 text-amber-800">{requests.filter(r => r.status === 'pending').length} منتظر</Badge></div>
          {requests.filter(r => r.status === 'pending').length === 0
            ? <div className="rounded-lg border border-dashed p-6 text-center text-sm text-slate-500">لا توجد طلبات تسجيل منتظرة حاليًا. أنشئ الرابط بالأعلى وشاركه مع طلابك.</div>
            : requests.filter(r => r.status === 'pending').map(request => <div key={request.id} className="flex flex-wrap items-center justify-between gap-3 rounded-lg border p-3"><div><p className="font-medium">{request.student_name}</p><p className="text-sm text-slate-500" dir="ltr">{request.phone}</p><p className="text-sm">{request.grade_name} — {request.group_name} | ولي الأمر: {request.guardian_name} ({request.guardian_phone})</p></div><div className="flex gap-2"><Button size="sm" disabled={busyRequestId !== null} onClick={() => decideRequest(request, true)}><Check className="ml-1 h-4 w-4" />قبول وإنشاء الحساب</Button><Button size="sm" variant="destructive" disabled={busyRequestId !== null} onClick={() => decideRequest(request, false)}><X className="ml-1 h-4 w-4" />رفض</Button></div></div>)}
        </CardContent></Card>

        {resetRequests.some(r => r.status === 'pending') && <Card className="mb-6 border-amber-200"><CardContent className="space-y-3 p-5"><h2 className="font-bold">طلبات استرجاع الحساب</h2><p className="text-sm text-slate-500">تحقق من هوية الطالب خارج المنصة قبل إصدار الكود.</p>{resetRequests.filter(r => r.status === 'pending').map(request => <div key={request.id} className="flex flex-wrap items-center justify-between gap-3 rounded-lg border p-3"><div><p className="font-medium">{request.name}</p><p className="text-sm text-slate-500" dir="ltr">{request.phone}</p></div><Button size="sm" variant="outline" disabled={busyAction !== null} onClick={() => approvePasswordReset(request)}>إصدار كود 15 دقيقة</Button></div>)}</CardContent></Card>}

        {videoViolations.length > 0 && <Card className="mb-6 border-red-200"><CardContent className="space-y-3 p-5">
          <h2 className="flex items-center gap-2 font-bold text-red-800"><ShieldAlert className="h-5 w-5" />تنبيهات حماية الفيديو</h2>
          <p className="text-sm text-slate-500">آخر محاولات الالتقاط أو السلوك غير المعتاد لطلابك. الإشارات منخفضة الثقة ليست دليلاً قاطعًا بمفردها.</p>
          {videoViolations.slice(0, 20).map(item => <div key={item.id} className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-red-100 bg-red-50/40 p-3">
            <div><p className="font-medium">{item.student_name} — {item.activity_type}</p><p className="text-xs text-slate-500">{item.video_title || 'فيديو'} | ثقة: {item.confidence} | نقاط: {item.violation_weight} | {new Date(item.created_at).toLocaleString('ar-EG')}</p>{item.details && <p className="mt-1 max-w-2xl text-xs text-slate-600">{item.details}</p>}</div>
            <Button size="sm" variant="destructive" disabled={busyAction !== null} onClick={() => suspendForVideoViolation(item)}>تعليق الحساب</Button>
          </div>)}
        </CardContent></Card>}

        {showAdd && <Card className="mb-6 border-blue-200"><CardContent className="p-5"><form className="grid gap-4 md:grid-cols-2" onSubmit={addStudent}>
          <div className="space-y-1"><Label>نوع الطالب</Label><select className="w-full rounded-md border bg-white p-2" value={form.student_type} onChange={e => setForm({ ...form, student_type: e.target.value, password: e.target.value === 'offline' ? '' : form.password })}><option value="offline">أوفلاين — متابعة وحضور دون حساب دخول</option><option value="online">أونلاين — له حساب دخول للمنصة</option></select></div>
          <div className="space-y-1"><Label>اسم الطالب</Label><Input value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} placeholder="الاسم الكامل" /></div>
          <div className="space-y-1"><Label>رقم هاتف الطالب {form.student_type === 'online' ? '(مطلوب للدخول)' : '(اختياري)'}</Label><Input dir="ltr" inputMode="tel" value={form.phone} onChange={e => setForm({ ...form, phone: e.target.value })} placeholder="01xxxxxxxxx" /></div>
          <div className="space-y-1"><Label>رقم ولي الأمر (اختياري)</Label><Input dir="ltr" inputMode="tel" value={form.guardian_phone} onChange={e => setForm({ ...form, guardian_phone: e.target.value })} /></div>
          <div className="space-y-1"><Label>البريد الإلكتروني (اختياري)</Label><Input dir="ltr" type="email" value={form.email} onChange={e => setForm({ ...form, email: e.target.value })} /></div>
          <div className="space-y-1"><Label>المجموعة (اختياري)</Label><select className="w-full rounded-md border bg-white p-2" value={form.group_id} onChange={e => setForm({ ...form, group_id: e.target.value })}><option value="">بدون مجموعة الآن</option>{groups.map(group => <option key={group.id} value={group.id}>{group.name}</option>)}</select></div>
          {form.student_type === 'online' && <div className="space-y-1 md:col-span-2"><Label>كلمة مرور الطالب</Label><Input dir="ltr" type="password" minLength={10} maxLength={128} autoComplete="new-password" value={form.password} onChange={e => setForm({ ...form, password: e.target.value })} placeholder="10 أحرف على الأقل" /><p className="text-xs text-slate-500">سلّمها للطالب بطريقة آمنة؛ سيدخل باستخدام رقم الهاتف المكتوب أعلاه.</p></div>}
          <div className="flex gap-2 md:col-span-2"><Button type="submit" disabled={saving}>{saving ? 'جارٍ الحفظ…' : 'حفظ الطالب'}</Button><Button type="button" variant="outline" onClick={() => setShowAdd(false)}>إلغاء</Button></div>
        </form></CardContent></Card>}

        {/* Search */}
        {loadError && (
          <div role="alert" className="mb-6 rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-700">
            {loadError}
          </div>
        )}
        <div className="relative mb-6">
          <Search className="absolute right-3 top-2.5 w-4 h-4 text-slate-400" />
          <Input
            placeholder="ابحث بالاسم أو رقم الهاتف…"
            className="pr-9"
            value={search}
            onChange={e => setSearch(e.target.value)}
          />
        </div>

        {/* Students grid */}
        {loading ? (
          <div className="text-center py-16 text-slate-400">جاري التحميل…</div>
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
                          <Badge variant="outline" className={student.is_offline ? 'bg-amber-50 text-amber-700' : 'bg-emerald-50 text-emerald-700'}>{student.is_offline ? 'أوفلاين' : 'أونلاين'}</Badge>
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
