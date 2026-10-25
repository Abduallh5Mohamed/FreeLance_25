import { useState, useEffect, useCallback, useRef } from "react";
import { useNavigate } from "react-router-dom";
import Header from "@/components/Header";
import {
  getStudents,
  getCourses,
  getMaterials,
  User,
  verifyCurrentSession,
  AUTH_SESSION_CHANGED_EVENT
} from "@/lib/api";
import StatsCard from "@/components/StatsCard";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Users,
  BookOpen,
  Calendar,
  DollarSign,
  TrendingUp,
  Clock,
  GraduationCap,
  FileVideo,
  AlertTriangle,
  RefreshCw,
  FileText,
  Sparkles
} from "lucide-react";
import { useToast } from "@/components/ui/use-toast";
import { FloatingParticles } from "@/components/FloatingParticles";
import { motion } from "framer-motion";

const EMPTY_VALUE = "—";

const buildStats = () => [
  {
    title: "إجمالي الطلاب",
    value: EMPTY_VALUE,
    subtitle: "الطلاب المسجلين",
    icon: Users,
    trend: "neutral" as const
  },
  {
    title: "الكورسات النشطة",
    value: EMPTY_VALUE,
    subtitle: "الكورسات المتاحة",
    icon: BookOpen,
    trend: "neutral" as const
  },
  {
    title: "معدل الحضور",
    value: EMPTY_VALUE,
    subtitle: "غير متاح",
    icon: Calendar,
    trend: "neutral" as const
  },
  {
    title: "المحتوى التعليمي",
    value: EMPTY_VALUE,
    subtitle: "ملفات تعليمية",
    icon: FileVideo,
    trend: "neutral" as const
  }
];

const TeacherDashboard = () => {
  const { toast } = useToast();
  const navigate = useNavigate();
  const [currentUser, setCurrentUser] = useState<User | null>(null);
  const [stats, setStats] = useState(buildStats);
  const [statsLoading, setStatsLoading] = useState(true);
  const [statsError, setStatsError] = useState<string | null>(null);
  const [recentActivities] = useState<any[]>([]);
  const isMountedRef = useRef(true);
  const loadSeqRef = useRef(0);

  const resetDashboard = useCallback(() => {
    setCurrentUser(null);
    setStats(buildStats());
    setStatsError(null);
  }, []);

  const loadDashboard = useCallback(async () => {
    const requestSeq = ++loadSeqRef.current;
    const startingToken = localStorage.getItem('authToken') ?? '';

    setStatsLoading(true);
    setStatsError(null);
    setStats(buildStats());

    const isCurrent = () =>
      isMountedRef.current
      && requestSeq === loadSeqRef.current
      && startingToken === (localStorage.getItem('authToken') ?? '');

    if (!startingToken) {
      navigate('/auth', { replace: true });
      return;
    }

    try {
      const verification = await verifyCurrentSession();
      if (!isCurrent()) return;

      if (verification.state === 'anonymous') {
        navigate('/auth', { replace: true });
        return;
      }
      if (verification.state === 'changed') return;
      if (verification.state !== 'authenticated') {
        setStatsError('تعذّر التحقق من الجلسة الآن. حاول مرة أخرى.');
        return;
      }

      const user = verification.user;
      if (user.role !== 'teacher' && user.role !== 'staff' && user.role !== 'instructor') {
        toast({
          variant: "destructive",
          title: "غير مسموح",
          description: "هذه الصفحة للمعلمين والمسؤولين فقط",
        });
        navigate('/forbidden', { replace: true });
        return;
      }

      setCurrentUser(user);

      const [students, courses, materials] = await Promise.all([
        getStudents(),
        getCourses(),
        getMaterials()
      ]);

      if (!isCurrent()) return;
      if (!Array.isArray(students) || !Array.isArray(courses) || !Array.isArray(materials)) {
        throw new Error('Unexpected dashboard payload');
      }

      setStats(prev => prev.map((stat, index) => {
        switch (index) {
          case 0:
            return { ...stat, value: String(students.length) };
          case 1:
            return { ...stat, value: String(courses.length) };
          case 3:
            return { ...stat, value: String(materials.length) };
          default:
            return stat;
        }
      }));
    } catch (error) {
      if (!isCurrent()) return;
      setStats(buildStats());
      setStatsError('تعذّر تحميل إحصاءات لوحة التحكم. تحقق من الاتصال وحاول مرة أخرى.');
    } finally {
      if (isCurrent()) setStatsLoading(false);
    }
  }, [navigate, toast]);

  useEffect(() => {
    isMountedRef.current = true;
    void loadDashboard();

    const refresh = () => {
      loadSeqRef.current += 1;
      resetDashboard();
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
  }, [loadDashboard, resetDashboard]);

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-50 via-cyan-50 to-teal-50 dark:from-slate-900 dark:via-cyan-950 dark:to-teal-950" dir="rtl">
      <FloatingParticles />
      <Header />

      <main className="container mx-auto px-4 py-8 relative z-10">
        {/* Welcome Section */}
        <motion.div
          initial={{ opacity: 0, y: -20 }}
          animate={{ opacity: 1, y: 0 }}
          className="mb-8"
        >
          <div className="flex items-center justify-between">
            <div>
              <h1 className="text-4xl font-bold bg-gradient-to-r from-cyan-600 to-teal-600 bg-clip-text text-transparent mb-2">
                {`مرحباً، ${currentUser?.name || 'أستاذ'} 👋`}
              </h1>
              <p className="text-slate-600 dark:text-slate-400">
                إليك ملخص سريع عن أنشطتك اليوم - Tabweb Academy
              </p>
            </div>
            {/* Removed buttons: إدارة المحتوى التعليمي and إضافة مصروف */}
          </div>
        </motion.div>

        {statsError && (
          <div
            role="alert"
            aria-live="polite"
            className="mb-6 flex flex-col gap-3 rounded-xl border border-red-200 bg-red-50 p-4 text-red-800 sm:flex-row sm:items-center sm:justify-between"
          >
            <div className="flex items-start gap-2">
              <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0" aria-hidden="true" />
              <p className="text-sm">{statsError}</p>
            </div>
            <Button variant="outline" size="sm" onClick={() => void loadDashboard()}>
              <RefreshCw className="ml-2 h-4 w-4" aria-hidden="true" />
              إعادة المحاولة
            </Button>
          </div>
        )}

        {/* Stats Grid */}
        <div
          className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6 mb-8"
          aria-busy={statsLoading}
          aria-live="polite"
        >
          {stats.map((stat, index) => (
            <StatsCard
              key={index}
              title={stat.title}
              value={stat.value}
              subtitle={stat.subtitle}
              icon={stat.icon}
              trend={stat.trend}
            />
          ))}
        </div>

        {/* Main Content Grid */}
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          {/* Quick Actions */}
          <Card className="bg-white dark:bg-slate-800 shadow-lg border-0">
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-cyan-700 dark:text-cyan-400">
                <Sparkles className="w-5 h-5" />
                الإجراءات السريعة
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              <Button
                variant="outline"
                className="w-full justify-start border-cyan-600 text-cyan-600 hover:bg-cyan-50"
                onClick={() => navigate('/students')}
              >
                <Users className="w-4 h-4 ml-2" />
                إضافة طالب جديد
              </Button>
              <Button
                variant="outline"
                className="w-full justify-start border-teal-600 text-teal-600 hover:bg-teal-50"
                onClick={() => navigate('/courses')}
              >
                <BookOpen className="w-4 h-4 ml-2" />
                إنشاء كورس جديد
              </Button>
              <Button
                variant="outline"
                className="w-full justify-start border-cyan-600 text-cyan-600 hover:bg-cyan-50"
                onClick={() => navigate('/barcode-attendance')}
              >
                <Calendar className="w-4 h-4 ml-2" />
                تسجيل الحضور
              </Button>
              <Button
                variant="outline"
                className="w-full justify-start border-teal-600 text-teal-600 hover:bg-teal-50"
                onClick={() => navigate('/teacher-content-manager')}
              >
                <FileVideo className="w-4 h-4 ml-2" />
                رفع محتوى تعليمي
              </Button>
              <Button
                variant="outline"
                className="w-full justify-start border-cyan-600 text-cyan-600 hover:bg-cyan-50"
                onClick={() => navigate('/exam-results')}
              >
                <TrendingUp className="w-4 h-4 ml-2" />
                نتائج الامتحانات
              </Button>
              {currentUser?.role === 'instructor' && (
                <>
                  <Button
                    variant="outline"
                    className="w-full justify-start border-emerald-600 text-emerald-600 hover:bg-emerald-50"
                    onClick={() => navigate('/instructor-wallet')}
                  >
                    <DollarSign className="w-4 h-4 ml-2" />
                    محفظتي ورصيدي
                  </Button>
                  <Button
                    variant="outline"
                    className="w-full justify-start border-purple-600 text-purple-600 hover:bg-purple-50"
                    onClick={() => navigate('/instructor-video-requests')}
                  >
                    <FileText className="w-4 h-4 ml-2" />
                    طلبات الفيديو
                  </Button>
                </>
              )}
            </CardContent>
          </Card>

          {/* Recent Activities */}
          <Card className="lg:col-span-2 bg-white dark:bg-slate-800 shadow-lg border-0">
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-cyan-700 dark:text-cyan-400">
                <Clock className="w-5 h-5" />
                الأنشطة الأخيرة
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="space-y-4">
                {recentActivities.length > 0 ? (
                  recentActivities.map((activity, index) => (
                    <div key={index} className="flex items-start gap-4 p-4 bg-muted/30 rounded-lg">
                      <div className={`w-10 h-10 rounded-full flex items-center justify-center bg-background ${activity.color}`}>
                        <activity.icon className="w-5 h-5" />
                      </div>
                      <div className="flex-1">
                        <h4 className="font-medium text-foreground">{activity.title}</h4>
                        <p className="text-sm text-muted-foreground">{activity.subtitle}</p>
                        <p className="text-xs text-muted-foreground mt-1">{activity.time}</p>
                      </div>
                    </div>
                  ))
                ) : (
                  <div className="text-center py-8 text-slate-500 dark:text-slate-400">
                    <Clock className="w-12 h-12 mx-auto mb-4 opacity-30" />
                    <p className="font-medium">سجل الأنشطة غير متاح حاليًا</p>
                    <p className="text-sm">لم يتم تحميل مصدر موثوق للأنشطة.</p>
                  </div>
                )}
              </div>
            </CardContent>
          </Card>
        </div>

        {/* Today's Schedule */}
        <Card className="mt-6 bg-white dark:bg-slate-800 shadow-lg border-0">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-cyan-700 dark:text-cyan-400">
              <GraduationCap className="w-5 h-5" />
              جدول اليوم
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-sm text-muted-foreground">جدول اليوم غير متاح حاليًا؛ راجع صفحة المواعيد.</p>
          </CardContent>
        </Card>
      </main>
    </div>
  );
};

export default TeacherDashboard;
