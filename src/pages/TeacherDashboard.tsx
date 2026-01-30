import { useState, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import Header from "@/components/Header";
import { getStudents, getCourses, getMaterials, User } from "@/lib/api";
import StatsCard from "@/components/StatsCard";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Users,
  BookOpen,
  Calendar,
  DollarSign,
  TrendingUp,
  Clock,
  GraduationCap,
  Plus,
  FileVideo,
  UserCheck,
  AlertTriangle,
  Video,
  FileText,
  Upload,
  Sparkles
} from "lucide-react";
import { useToast } from "@/components/ui/use-toast";
import { FloatingParticles } from "@/components/FloatingParticles";
import { motion } from "framer-motion";

const TeacherDashboard = () => {
  const { toast } = useToast();
  const navigate = useNavigate();
  const [currentUser, setCurrentUser] = useState<User | null>(null);
  const [isExpenseDialogOpen, setIsExpenseDialogOpen] = useState(false);
  const [expenseData, setExpenseData] = useState({
    description: '',
    amount: '',
    category: ''
  });

  const [stats, setStats] = useState([
    {
      title: "إجمالي الطلاب",
      value: 0,
      subtitle: "الطلاب المسجلين",
      icon: Users,
      trend: "up" as const
    },
    {
      title: "الكورسات النشطة",
      value: 0,
      subtitle: "الكورسات المتاحة",
      icon: BookOpen,
      trend: "up" as const
    },
    {
      title: "معدل الحضور",
      value: "0%",
      subtitle: "الحضور اليوم",
      icon: Calendar,
      trend: "up" as const
    },
    {
      title: "المحتوى التعليمي",
      value: 0,
      subtitle: "ملفات تعليمية",
      icon: FileVideo,
      trend: "up" as const
    }
  ]);

  const [recentActivities, setRecentActivities] = useState([]);

  // Check authentication on mount
  useEffect(() => {
    const checkAuth = async () => {
      try {
        const userStr = localStorage.getItem('currentUser');
        if (!userStr) {
          navigate('/auth');
          toast({
            variant: "destructive",
            title: "غير مسموح",
            description: "يرجى تسجيل الدخول كمعلم أولاً",
          });
          return;
        }

        const user = JSON.parse(userStr) as User;
        if (user.role !== 'admin' && user.role !== 'teacher' && user.role !== 'staff') {
          navigate('/auth');
          toast({
            variant: "destructive",
            title: "غير مسموح",
            description: "هذه الصفحة للمعلمين والمسؤولين فقط",
          });
          return;
        }

        setCurrentUser(user);
        fetchDashboardData();
      } catch (error) {
        console.error('Auth check error:', error);
        navigate('/auth');
      }
    };

    checkAuth();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleAddExpense = async () => {
    try {
      if (!expenseData.description || !expenseData.amount) {
        toast({
          variant: "destructive",
          title: "خطأ",
          description: "يرجى ملء جميع الحقول المطلوبة",
        });
        return;
      }

      toast({
        title: "تم إضافة المصروف بنجاح",
        description: `تم إضافة مصروف بقيمة ${expenseData.amount} جنيه`,
      });

      setExpenseData({ description: '', amount: '', category: '' });
      setIsExpenseDialogOpen(false);
    } catch (error) {
      console.error('Error adding expense:', error);
      toast({
        variant: "destructive",
        title: "خطأ",
        description: "حدث خطأ أثناء إضافة المصروف",
      });
    }
  };

  const fetchDashboardData = async () => {
    try {
      // Fetch students count
      const students = await getStudents();
      const totalStudents = students?.length || 0;

      // Fetch courses count
      const courses = await getCourses();
      const totalCourses = courses?.length || 0;

      // Fetch materials count
      const materials = await getMaterials();
      const totalMaterials = materials?.length || 0;

      setStats(prev => prev.map((stat, index) => {
        switch (index) {
          case 0:
            return { ...stat, value: totalStudents };
          case 1:
            return { ...stat, value: totalCourses };
          case 3:
            return { ...stat, value: totalMaterials };
          default:
            return stat;
        }
      }));

    } catch (error) {
      console.error('Error fetching dashboard data:', error);
    }
  };

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
                {currentUser?.role === 'admin' ? 'مرحباً أيها القائد 👋' : `مرحباً، ${currentUser?.name} 👋`}
              </h1>
              <p className="text-slate-600 dark:text-slate-400">
                إليك ملخص سريع عن أنشطتك اليوم - منصة القائد
              </p>
            </div>
            {/* Removed buttons: إدارة المحتوى التعليمي and إضافة مصروف */}
          </div>
        </motion.div>

        {/* Stats Grid */}
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6 mb-8">
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
                    <p className="font-medium">لا توجد أنشطة حديثة</p>
                    <p className="text-sm">ابدأ بإضافة محتوى تعليمي للطلاب</p>
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
            <div className="grid grid-cols-1 gap-4">
              <div className="p-4 bg-gradient-to-r from-cyan-50 to-teal-50 dark:from-cyan-950/30 dark:to-teal-950/30 rounded-lg border border-cyan-200 dark:border-cyan-800">
                <div className="flex items-center justify-between mb-2">
                  <span className="font-medium text-cyan-700 dark:text-cyan-400">التاريخ</span>
                  <span className="text-xs bg-cyan-600 text-white px-3 py-1 rounded-full">
                    نشط
                  </span>
                </div>
                <h4 className="font-bold text-slate-800 dark:text-slate-200">دروس التاريخ والحضارات</h4>
                <p className="text-sm text-slate-600 dark:text-slate-400 mt-1">تدريس مادة التاريخ للمراحل الثانوية - المحتوى التعليمي والامتحانات</p>
              </div>
            </div>
          </CardContent>
        </Card>
      </main>
    </div>
  );
};

export default TeacherDashboard;
