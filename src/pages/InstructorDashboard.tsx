import { useState, useEffect } from 'react';
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
} from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import Header from '@/components/Header';
import { getInstructorStats, getInstructorWalletTransactions, getReceivedRequests, getMyTenantSubscription, type MyTenantSubscription, User } from '@/lib/api';
import { useToast } from '@/hooks/use-toast';

const cardVariants = {
  hidden: { opacity: 0, y: 20 },
  visible: (i: number) => ({ opacity: 1, y: 0, transition: { delay: i * 0.1 } }),
};

export default function InstructorDashboard() {
  const navigate = useNavigate();
  const { toast } = useToast();
  const [currentUser, setCurrentUser] = useState<User | null>(null);
  const [stats, setStats] = useState({
    wallet_balance: 0 as number,
    total_lectures: 0,
    total_students: 0,
    pending_sent_requests: 0,
    pending_received_requests: 0,
  });
  const [recentTransactions, setRecentTransactions] = useState<any[]>([]);
  const [pendingRequests, setPendingRequests] = useState<any[]>([]);
  const [subscription, setSubscription] = useState<MyTenantSubscription | null>(null);
  const [graceSeconds, setGraceSeconds] = useState(0);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const userStr = localStorage.getItem('currentUser');
    if (!userStr) { navigate('/auth'); return; }

    const user = JSON.parse(userStr) as User;
    if (user.role !== 'instructor' && user.role !== 'admin') {
      navigate('/auth');
      toast({ variant: 'destructive', title: 'غير مسموح', description: 'هذه الصفحة للـ instructors فقط' });
      return;
    }
    setCurrentUser(user);
    loadData(user.id);
  }, []);

  const loadData = async (id: string) => {
    try {
      setLoading(true);
      const [statsData, txData, reqData, subscriptionData] = await Promise.allSettled([
        getInstructorStats(id),
        getInstructorWalletTransactions(id, 1, 5),
        getReceivedRequests(id),
        getMyTenantSubscription(),
      ]);

      if (statsData.status === 'fulfilled') {
        const raw = statsData.value;
        setStats({
          ...raw,
          wallet_balance: Number(raw.wallet_balance) || 0,
          total_lectures: Number(raw.total_lectures) || 0,
          total_students: Number(raw.total_students) || 0,
          pending_sent_requests: Number(raw.pending_sent_requests) || 0,
          pending_received_requests: Number(raw.pending_received_requests) || 0,
        });
      }
      if (txData.status === 'fulfilled')    setRecentTransactions(txData.value.data || []);
      if (reqData.status === 'fulfilled')   setPendingRequests((reqData.value || []).filter((r: any) => r.status === 'open' || r.status === 'awaiting_requester'));
      if (subscriptionData.status === 'fulfilled') {
        setSubscription(subscriptionData.value);
        setGraceSeconds(Number(subscriptionData.value.grace_seconds_remaining || 0));
      }
    } catch (err) {
      console.error('Dashboard load error:', err);
    } finally {
      setLoading(false);
    }
  };

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

  const statCards = [
    { title: 'رصيد المحفظة',        value: `${Number(stats.wallet_balance).toFixed(2)} ج.م`, icon: Wallet,        color: 'from-emerald-500 to-teal-500',   path: '/instructor-wallet'          },
    { title: 'فيديوهاتي',           value: stats.total_lectures,                      icon: Video,         color: 'from-indigo-500 to-purple-500',  path: '/instructor-lectures'         },
    { title: 'تسجيل وطلبات الطلاب', value: stats.total_students,                      icon: Users,         color: 'from-blue-500 to-cyan-500',      path: '/instructor-students'         },
    { title: 'طلبات واردة معلقة',   value: stats.pending_received_requests,            icon: Bell,          color: 'from-orange-500 to-red-500',     path: '/instructor-video-requests'  },
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

        {subscription && ['active', 'past_due', 'grace_period'].includes(subscription.subscription_status || '') && graceSeconds > 0 && (
          <Card className="mb-8 border-amber-300 bg-amber-50 shadow-md">
            <CardContent className="flex flex-col gap-3 p-5 sm:flex-row sm:items-center sm:justify-between">
              <div className="flex items-start gap-3 text-amber-950"><AlertTriangle className="mt-1 h-6 w-6 shrink-0 text-amber-600" /><div><p className="font-bold">انتهى اشتراك المنصة، وأمامك مهلة 4 أيام للتجديد</p><p className="text-sm">سيتم تعطيل الحساب تلقائيًا عند انتهاء العداد. تواصل مع الإدارة لإتمام التجديد.</p></div></div>
              <div className="rounded-md bg-amber-100 px-4 py-2 text-center font-mono text-lg font-bold text-amber-900" dir="ltr">{formatCountdown(graceSeconds)}</div>
            </CardContent>
          </Card>
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
                  <p className="text-sm">لا توجد معاملات بعد</p>
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
                  <p className="text-sm">لا توجد طلبات معلقة</p>
                </div>
              ) : (
                <div className="space-y-3">
                  {pendingRequests.slice(0, 4).map(req => (
                    <div key={req.id} className="p-3 rounded-lg bg-orange-50 border border-orange-100">
                      <p className="font-medium text-sm text-slate-800">{req.requested_title}</p>
                      <p className="text-xs text-slate-500 mt-1">من: {req.requester_name}</p>
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
