import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { motion } from 'framer-motion';
import {
  Video,
  Wallet,
  Users,
  GitPullRequest,
  ArrowUpCircle,
  ArrowDownCircle,
  Clock,
  TrendingUp,
  Bell,
  PlayCircle,
  AlertTriangle,
  Building2,
  RefreshCw,
} from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import Header from '@/components/Header';
import {
  getInstructorStats,
  getInstructorWalletTransactions,
  getReceivedRequests,
  getMyTenantSubscription,
  getMyTenantProfile, updateMyTenantProfile,
  verifyCurrentSession,
  AUTH_SESSION_CHANGED_EVENT,
  type MyTenantSubscription,
  type User,
} from '@/lib/api';
import { useToast } from '@/hooks/use-toast';
import { subscribeSessionChange } from '@/lib/session-events';
import {
  createTenantProfileController,
  readCourseSessionPrincipal,
  type TenantProfileController,
  type TenantProfileEditState,
  type TenantProfileState,
} from '@/features/tenant/profile';
import BranchManager from '@/features/tenant/BranchManager';
import TenantBrandingCard from '@/features/tenant/TenantBrandingCard';
import AcademicPeriodsCard from '@/features/tenant/AcademicPeriodsCard';

const UNAVAILABLE = '—';

const cardVariants = {
  hidden: { opacity: 0, y: 20 },
  visible: (i: number) => ({ opacity: 1, y: 0, transition: { delay: i * 0.1 } }),
};

/**
 * M2-05 — read-only identity of the server-selected workspace.
 *
 * The page owns only rendering; the request lifecycle (loading / error /
 * unauthorized / denied / no-workspace states, runtime DTO validation,
 * stale-reply invalidation, session and disposal fences) lives in
 * `src/features/tenant/profile.ts`, which the hermetic tests drive. The card
 * shows ONLY a server-confirmed profile from the accepted M2-B01 endpoint —
 * never a local user name, a billing DTO or a fallback identity — and the
 * institution status is displayed as metadata, not as payment or entitlement.
 */
const readPrincipal = (): string | null => {
  try {
    return readCourseSessionPrincipal(localStorage);
  } catch {
    return null;
  }
};

const PROFILE_PHASE_TEXT: Record<TenantProfileState['phase'], string> = {
  idle: 'جارٍ تحضير هوية المساحة…',
  loading: 'جارٍ تحميل هوية المساحة…',
  ready: '',
  error: '',
  unauthorized: 'انتهت صلاحية الجلسة. سجّل الدخول مرة أخرى لعرض هوية المساحة.',
  denied: 'تم تعطيل الحساب من الإدارة؛ لا يمكن عرض هوية المساحة.',
  'no-workspace': 'لا توجد مساحة عمل مُصرّح بها مرتبطة بهذا الحساب.',
};
interface DashboardStats {
  wallet_unavailable: boolean;
  wallet_balance: number;
  total_lectures: number | null;
  total_students: number | null;
  pending_received_requests: number | null;
}

const emptyStats = (): DashboardStats => ({
  wallet_unavailable: true,
  wallet_balance: 0,
  total_lectures: null,
  total_students: null,
  pending_received_requests: null,
});

export default function InstructorDashboard() {
  const navigate = useNavigate();
  const { toast } = useToast();
  const isMountedRef = useRef(true);
  const loadSeqRef = useRef(0);
  const [currentUser, setCurrentUser] = useState<User | null>(null);
  const [stats, setStats] = useState<DashboardStats>(emptyStats);
  const [recentTransactions, setRecentTransactions] = useState<any[]>([]);
  const [txUnavailable, setTxUnavailable] = useState(false);
  const [pendingRequests, setPendingRequests] = useState<any[]>([]);
  const [requestsUnavailable, setRequestsUnavailable] = useState(false);
  const [subscription, setSubscription] = useState<MyTenantSubscription | null>(null);
  const [profileSnapshot, setProfileSnapshot] = useState<TenantProfileState | null>(null);
  const profileControllerRef = useRef<TenantProfileController | null>(null);
  const [graceSeconds, setGraceSeconds] = useState(0);
  const [loading, setLoading] = useState(true);
  const [statsError, setStatsError] = useState<string | null>(null);

  useEffect(() => {
    // One controller per mount: the seam owns the request lifecycle (session
    // fences, stale-reply invalidation, disposal). Disposal retires
    // everything in flight on unmount and clears the private identity.
    const instance = createTenantProfileController({
      loadProfile: () => getMyTenantProfile(),
      updateProfile: (businessName) => updateMyTenantProfile(businessName),
      readPrincipal,
      subscribeSession: (listener) => subscribeSessionChange(() => listener()),
    });
    profileControllerRef.current = instance;
    const unsubscribe = instance.subscribe(setProfileSnapshot);
    void instance.load();
    return () => {
      unsubscribe();
      instance.dispose();
      profileControllerRef.current = null;
    };
  }, []);

  const resetData = useCallback(() => {
    setCurrentUser(null);
    setStats(emptyStats());
    setRecentTransactions([]);
    setPendingRequests([]);
    setSubscription(null);
    setGraceSeconds(0);
    setTxUnavailable(false);
    setRequestsUnavailable(false);
    setStatsError(null);
  }, []);

  const loadDashboard = useCallback(async () => {
    const token = ++loadSeqRef.current;
    const startingToken = localStorage.getItem('authToken') ?? '';
    const isCurrent = () =>
      isMountedRef.current
      && token === loadSeqRef.current
      && startingToken === (localStorage.getItem('authToken') ?? '');

    resetData();
    setLoading(true);

    const session = await verifyCurrentSession();
    if (!isCurrent()) return;

    if (session.state === 'anonymous') {
      navigate('/auth', { replace: true });
      return;
    }
    if (session.state === 'changed') return;
    if (session.state !== 'authenticated') {
      setLoading(false);
      setStatsError('تعذّر التحقق من الجلسة الآن. حاول مرة أخرى.');
      return;
    }

    const user = session.user;
    if (user.role !== 'instructor' && user.role !== 'admin') {
      toast({ variant: 'destructive', title: 'غير مسموح', description: 'هذه الصفحة للـ instructors فقط' });
      navigate('/auth', { replace: true });
      return;
    }
    setCurrentUser(user);

    const [statsData, txData, reqData, subscriptionData] = await Promise.allSettled([
      getInstructorStats(user.id),
      getInstructorWalletTransactions(user.id, 1, 5),
      getReceivedRequests(user.id),
      getMyTenantSubscription(),
    ]);
    if (!isCurrent()) return;

    if (statsData.status === 'fulfilled') {
      const raw = statsData.value;
      const rawWallet = Number((raw as { wallet_balance?: unknown }).wallet_balance);
      const walletPresent = (raw as { wallet_balance?: unknown }).wallet_balance !== undefined
        && Number.isFinite(rawWallet)
        && rawWallet >= 0;
      const count = (value: unknown): number | null => {
        const parsed = Number(value);
        return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
      };
      setStats({
        wallet_unavailable: !walletPresent,
        wallet_balance: walletPresent ? rawWallet : 0,
        total_lectures: count(raw.total_lectures),
        total_students: count(raw.total_students),
        pending_received_requests: count(raw.pending_received_requests),
      });
    } else {
      setStatsError('تعذّر تحميل إحصائيات لوحة التحكم. تحقق من الاتصال وحاول مرة أخرى.');
    }

    if (txData.status === 'fulfilled') {
      setRecentTransactions(txData.value.data || []);
    } else {
      setTxUnavailable(true);
    }

    if (reqData.status === 'fulfilled') {
      setPendingRequests(
        (reqData.value || []).filter((r: any) => r.status === 'open' || r.status === 'awaiting_requester')
      );
    } else {
      setRequestsUnavailable(true);
    }

    if (subscriptionData.status === 'fulfilled') {
      setSubscription(subscriptionData.value);
      setGraceSeconds(Number(subscriptionData.value.grace_seconds_remaining || 0));
    }

    setLoading(false);
  }, [navigate, resetData, toast]);

  useEffect(() => {
    isMountedRef.current = true;
    void loadDashboard();

    const refresh = () => {
      void loadDashboard();
    };
    const onStorage = (event: StorageEvent) => {
      if (!event.key || event.key === 'authToken' || event.key === 'currentUser') refresh();
    };

    window.addEventListener(AUTH_SESSION_CHANGED_EVENT, refresh);
    window.addEventListener('storage', onStorage);
    return () => {
      isMountedRef.current = false;
      loadSeqRef.current += 1;
      window.removeEventListener(AUTH_SESSION_CHANGED_EVENT, refresh);
      window.removeEventListener('storage', onStorage);
    };
  }, [loadDashboard]);

  useEffect(() => {
    if (graceSeconds <= 0) return undefined;
    const timer = window.setInterval(() => setGraceSeconds(value => Math.max(0, value - 1)), 1000);
    return () => window.clearInterval(timer);
  }, [graceSeconds]);

  const formatCountdown = (seconds: number) => {
    const days = Math.floor(seconds / 86400);
    const hours = Math.floor((seconds % 86400) / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const remaining = seconds % 60;
    return `${days} يوم، ${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(remaining).padStart(2, '0')}`;
  };

  const walletText = stats.wallet_unavailable ? UNAVAILABLE : `${stats.wallet_balance.toFixed(2)} ج.م`;
  const statCards = [
    { title: 'رصيد المحفظة',        value: walletText, icon: Wallet,        color: 'from-emerald-500 to-teal-500',   path: '/instructor-wallet'          },
    { title: 'فيديوهاتي',           value: stats.total_lectures === null ? UNAVAILABLE : stats.total_lectures, icon: Video,         color: 'from-indigo-500 to-purple-500',  path: '/instructor-lectures'         },
    { title: 'تسجيل وطلبات الطلاب', value: stats.total_students === null ? UNAVAILABLE : stats.total_students, icon: Users,         color: 'from-blue-500 to-cyan-500',      path: '/instructor-students'         },
    { title: 'طلبات واردة معلقة',   value: stats.pending_received_requests === null ? UNAVAILABLE : stats.pending_received_requests, icon: Bell,          color: 'from-orange-500 to-red-500',     path: '/instructor-video-requests'  },
  ];

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-50 via-indigo-50 to-purple-50" dir="rtl">
      <Header />

      <main className="container mx-auto px-4 py-8">
        {/* Welcome */}
        <motion.div initial={{ opacity: 0, y: -20 }} animate={{ opacity: 1, y: 0 }} className="mb-8">
          <h1 className="text-3xl font-bold bg-gradient-to-r from-indigo-600 to-purple-600 bg-clip-text text-transparent">
            مرحباً، {currentUser?.name} 👋
          </h1>
          <p className="text-slate-500 mt-1">إليك ملخص حساباتك ونشاطك على المنصة</p>
        </motion.div>

        {/* Selected institution identity — read-only, server-confirmed (M2-05) */}
        <Card className="mb-8 border-0 shadow-lg">
          <CardHeader>
            <CardTitle className="text-indigo-700 flex items-center gap-2">
              <Building2 className="w-5 h-5" />
              هوية المساحة المختارة
            </CardTitle>
          </CardHeader>
          <CardContent>
            {(() => {
              const phase = profileSnapshot?.phase ?? 'idle';
              const profile = profileSnapshot?.profile ?? null;
              const edit: TenantProfileEditState = profileSnapshot?.edit ?? {
                status: 'closed',
                draft: '',
                error: null,
                notice: null,
              };
              if (phase === 'ready' && profile) {
                const subjectType = (profile.subject_type ?? '').trim();
                const saving = edit.status === 'saving';
                return (
                  <div className="space-y-4">
                    <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                      <div className="min-w-0">
                        <p className="text-lg font-bold text-slate-800 truncate" dir="auto">{profile.business_name}</p>
                        {subjectType ? (
                          <p className="text-sm text-slate-500 mt-1">النوع: <span dir="auto">{subjectType}</span></p>
                        ) : null}
                      </div>
                      <div className="flex items-center gap-3 shrink-0">
                        <div className="text-sm text-slate-500">
                          حالة المساحة (كما أكدها الخادم): <Badge variant="outline" className="mr-1" dir="auto">{profile.status}</Badge>
                        </div>
                        {edit.status === 'closed' ? (
                          <Button variant="outline" size="sm"
                            onClick={() => profileControllerRef.current?.openEditor()}>
                            تعديل الاسم
                          </Button>
                        ) : null}
                      </div>
                    </div>

                    {edit.status !== 'closed' ? (
                      <form
                        className="border-t border-slate-200 pt-4 space-y-3"
                        onSubmit={(event) => {
                          event.preventDefault();
                          void profileControllerRef.current?.save();
                        }}
                        onKeyDown={(event) => {
                          if (event.key === 'Escape' && !saving) {
                            event.preventDefault();
                            profileControllerRef.current?.cancelEdit();
                          }
                        }}
                      >
                        <label htmlFor="institution-name" className="block text-sm font-medium text-slate-700">
                          اسم المؤسسة
                        </label>
                        <input
                          id="institution-name"
                          type="text"
                          dir="auto"
                          maxLength={255}
                          disabled={saving}
                          value={edit.draft}
                          onChange={(event) => profileControllerRef.current?.updateDraft(event.target.value)}
                          className="w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm text-slate-800 shadow-sm focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-200 disabled:bg-slate-100"
                        />
                        <p className="text-xs text-slate-500">
                          التعديل متاح لمالك المؤسسة فقط؛ يتحقق الخادم من الملكية قبل الحفظ.
                        </p>
                        <div aria-live="polite" className="space-y-1">
                          {saving ? (
                            <p className="text-sm text-slate-500">جارٍ حفظ الاسم… بانتظار تأكيد الخادم.</p>
                          ) : null}
                          {edit.error ? (
                            <p className="text-sm text-red-600 flex items-start gap-2">
                              <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
                              <span>تعذّر حفظ الاسم: {edit.error}</span>
                            </p>
                          ) : null}
                          {edit.notice ? (
                            <p className="text-sm text-amber-700 flex items-start gap-2">
                              <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
                              <span>{edit.notice}</span>
                            </p>
                          ) : null}
                        </div>
                        <div className="flex flex-wrap gap-2">
                          <Button type="submit" size="sm" disabled={saving}
                            className="bg-indigo-600 hover:bg-indigo-700">
                            حفظ الاسم
                          </Button>
                          <Button type="button" size="sm" variant="outline" disabled={saving}
                            onClick={() => profileControllerRef.current?.cancelEdit()}>
                            إلغاء
                          </Button>
                          {edit.status === 'uncertain' ? (
                            <Button type="button" size="sm" variant="outline" className="gap-2"
                              onClick={() => { void profileControllerRef.current?.reconcile(); }}>
                              <RefreshCw className="w-4 h-4" /> قراءة الحالة الحالية
                            </Button>
                          ) : null}
                        </div>
                      </form>
                    ) : null}
                  </div>
                );
              }
              if (phase === 'error') {
                return (
                  <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                    <p className="text-sm text-red-600 flex items-center gap-2">
                      <AlertTriangle className="w-4 h-4 shrink-0" />
                      {profileSnapshot?.error || 'تعذّر تحميل هوية المساحة.'}
                    </p>
                    <Button variant="outline" size="sm" className="gap-2 shrink-0"
                      onClick={() => { void profileControllerRef.current?.refresh(); }}>
                      <RefreshCw className="w-4 h-4" /> إعادة المحاولة
                    </Button>
                  </div>
                );
              }
              if (phase === 'idle' || phase === 'loading') {
                return <p className="text-sm text-slate-400">{PROFILE_PHASE_TEXT[phase]}</p>;
              }
              return (
                <p className="text-sm text-slate-500 flex items-center gap-2">
                  <AlertTriangle className="w-4 h-4 shrink-0 text-amber-500" />
                  {PROFILE_PHASE_TEXT[phase]}
                </p>
              );
            })()}
          </CardContent>
        </Card>

        {/* Tenant branch metadata — dedicated component, opened explicitly (M2-07) */}
        <BranchManager />

        {/* Private localized branding — dedicated card, opened explicitly (M2-12) */}
        <TenantBrandingCard />

        {/* Private academic-period planning catalog — dedicated card, opened explicitly (M2-13) */}
        <AcademicPeriodsCard />

        {subscription && ['active', 'past_due', 'grace_period'].includes(subscription.subscription_status || '') && graceSeconds > 0 && (
          <Card className="mb-8 border-amber-300 bg-amber-50 shadow-md">
            <CardContent className="flex flex-col gap-3 p-5 sm:flex-row sm:items-center sm:justify-between">
              <div className="flex items-start gap-3 text-amber-950"><AlertTriangle className="mt-1 h-6 w-6 shrink-0 text-amber-600" /><div><p className="font-bold">انتهى اشتراك المنصة، وأمامك مهلة 4 أيام للتجديد</p><p className="text-sm">سيتم تعطيل الحساب تلقائيًا عند انتهاء العداد. تواصل مع الإدارة لإتمام التجديد.</p></div></div>
              <div className="rounded-md bg-amber-100 px-4 py-2 text-center font-mono text-lg font-bold text-amber-900" dir="ltr">{formatCountdown(graceSeconds)}</div>
            </CardContent>
          </Card>
        )}

        {statsError && (
          <div role="alert" className="mb-8 flex flex-col gap-3 rounded-xl border border-red-200 bg-red-50 p-4 text-red-800 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex items-start gap-2">
              <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0" />
              <p className="text-sm">{statsError}</p>
            </div>
            <Button variant="outline" size="sm" onClick={() => void loadDashboard()}>
              <RefreshCw className="ml-2 h-4 w-4" />
              إعادة المحاولة
            </Button>
          </div>
        )}

        {/* Stats grid */}
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-8">
          {statCards.map((card, i) => (
            <motion.div key={card.title} custom={i} variants={cardVariants} initial="hidden" animate="visible">
              <Card
                className="cursor-pointer hover:shadow-lg transition-shadow border-0 overflow-hidden"
                onClick={() => navigate(card.path)}
              >
                <CardContent className="p-0">
                  <div className={`bg-gradient-to-br ${card.color} p-4 text-white`}>
                    <card.icon className="w-6 h-6 mb-2 opacity-80" />
                    <p className="text-2xl font-bold">{loading ? '…' : card.value}</p>
                    <p className="text-xs opacity-80 mt-1">{card.title}</p>
                  </div>
                </CardContent>
              </Card>
            </motion.div>
          ))}
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          {/* Quick actions */}
          <Card className="border-0 shadow-lg">
            <CardHeader>
              <CardTitle className="text-indigo-700 flex items-center gap-2">
                <TrendingUp className="w-5 h-5" />
                إجراءات سريعة
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              <Button className="w-full justify-start bg-indigo-600 hover:bg-indigo-700 gap-2"
                onClick={() => navigate('/instructor-lectures')}>
                <PlayCircle className="w-4 h-4" /> فيديوهاتي
              </Button>
              <Button className="w-full justify-start bg-purple-600 hover:bg-purple-700 gap-2"
                onClick={() => navigate('/instructor-video-requests')}>
                <GitPullRequest className="w-4 h-4" /> طلبات الفيديو
              </Button>
              <Button className="w-full justify-start bg-emerald-600 hover:bg-emerald-700 gap-2"
                onClick={() => navigate('/instructor-wallet')}>
                <Wallet className="w-4 h-4" /> محفظتي
              </Button>
              <Button className="w-full justify-start bg-blue-600 hover:bg-blue-700 gap-2"
                onClick={() => navigate('/instructor-students')}>
                <Users className="w-4 h-4" /> رابط التسجيل وطلبات الطلاب
              </Button>
            </CardContent>
          </Card>

          {/* Recent transactions */}
          <Card className="border-0 shadow-lg">
            <CardHeader>
              <CardTitle className="text-emerald-700 flex items-center gap-2">
                <Wallet className="w-5 h-5" />
                آخر معاملات المحفظة
              </CardTitle>
            </CardHeader>
            <CardContent>
              {recentTransactions.length === 0 ? (
                <div className="text-center py-6 text-slate-400">
                  <Wallet className="w-10 h-10 mx-auto mb-2 opacity-30" />
                  <p className="text-sm">{txUnavailable ? 'تعذّر تحميل المعاملات' : 'لا توجد معاملات بعد'}</p>
                </div>
              ) : (
                <div className="space-y-3">
                  {recentTransactions.map(tx => (
                    <div key={tx.id} className="flex items-center gap-3 p-2 rounded-lg bg-slate-50">
                      {tx.type === 'credit' ? (
                        <ArrowUpCircle className="w-5 h-5 text-emerald-500 shrink-0" />
                      ) : (
                        <ArrowDownCircle className="w-5 h-5 text-red-500 shrink-0" />
                      )}
                      <div className="flex-1 min-w-0">
                        <p className="text-xs text-slate-600 truncate">{tx.description}</p>
                        <p className="text-xs text-slate-400">{new Date(tx.created_at).toLocaleDateString('ar-EG')}</p>
                      </div>
                      <span className={`font-bold text-sm shrink-0 ${tx.type === 'credit' ? 'text-emerald-600' : 'text-red-600'}`}>
                        {tx.type === 'credit' ? '+' : '-'}{tx.amount} ج.م
                      </span>
                    </div>
                  ))}
                  <Button variant="outline" size="sm" className="w-full" onClick={() => navigate('/instructor-wallet')}>
                    عرض الكل
                  </Button>
                </div>
              )}
            </CardContent>
          </Card>

          {/* Pending received requests */}
          <Card className="border-0 shadow-lg">
            <CardHeader>
              <CardTitle className="text-orange-700 flex items-center gap-2 justify-between">
                <div className="flex items-center gap-2">
                  <Bell className="w-5 h-5" />
                  طلبات واردة معلقة
                </div>
                {pendingRequests.length > 0 && (
                  <Badge className="bg-orange-500">{pendingRequests.length}</Badge>
                )}
              </CardTitle>
            </CardHeader>
            <CardContent>
              {pendingRequests.length === 0 ? (
                <div className="text-center py-6 text-slate-400">
                  <Clock className="w-10 h-10 mx-auto mb-2 opacity-30" />
                  <p className="text-sm">{requestsUnavailable ? 'تعذّر تحميل الطلبات' : 'لا توجد طلبات معلقة'}</p>
                </div>
              ) : (
                <div className="space-y-3">
                  {pendingRequests.slice(0, 4).map(req => (
                    <div key={req.id} className="p-3 rounded-lg bg-orange-50 border border-orange-100">
                      <p className="font-medium text-sm text-slate-800">{req.requested_title}</p>
                      <p className="text-xs text-slate-500 mt-1">من: {req.requester_name}</p>
                      {req.status === 'awaiting_requester' ? (
                        <p className="text-xs text-indigo-600 mt-1 truncate">
                          بانتظار قرار مقدم الطلب{req.active_offer_title ? ` — العرض: ${req.active_offer_title}` : ''}
                        </p>
                      ) : (
                        <p className="text-xs text-orange-600 mt-1">بانتظار عرضك</p>
                      )}
                      {req.message && <p className="text-xs text-slate-400 mt-1 truncate">"{req.message}"</p>}
                    </div>
                  ))}
                  <Button variant="outline" size="sm" className="w-full border-orange-200 text-orange-700"
                    onClick={() => navigate('/instructor-video-requests')}>
                    إدارة الطلبات
                  </Button>
                </div>
              )}
            </CardContent>
          </Card>
        </div>
      </main>
    </div>
  );
}
