import { useState, useEffect } from "react";
import Header from "@/components/Header";
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
  AlertTriangle
} from "lucide-react";
import { useToast } from "@/components/ui/use-toast";
import { getStudents, getCourses, getAttendance } from "@/lib/api";

const TeacherDashboard = () => {
  const { toast } = useToast();
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
      value: 1,
      subtitle: "كورسات التاريخ",
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

      // TODO: Add expenses API endpoint
      toast({
        title: "قريباً",
        description: "سيتم إضافة هذه الميزة قريباً",
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

  useEffect(() => {
    fetchDashboardData();
  }, []);

  const fetchDashboardData = async () => {
    try {
      // Fetch students count
      const students = await getStudents();

      // Fetch today's attendance
      const today = new Date().toISOString().split('T')[0];
      const todayAttendance = await getAttendance({ date: today });

      const totalStudents = students?.length || 0;
      const presentToday = todayAttendance?.filter(a => a.status === 'present').length || 0;
      const attendanceRate = totalStudents > 0 ? Math.round((presentToday / totalStudents) * 100) : 0;

      setStats(prev => prev.map((stat, index) => {
        switch (index) {
          case 0:
            return { ...stat, value: totalStudents };
          case 2:
            return { ...stat, value: `${attendanceRate}%` };
          case 3:
            return { ...stat, value: 0 }; // TODO: Add course materials API
          default:
            return stat;
        }
      }));

    } catch (error) {
      console.error('Error fetching dashboard data:', error);
    }
  };

  return (
    <div className="min-h-screen bg-background" dir="rtl">
      <Header />

      <main className="container mx-auto px-4 py-8">
        {/* Welcome Section */}
        <div className="mb-8">
          <div className="flex items-center justify-between">
            <div>
              <h1 className="text-3xl font-bold text-foreground mb-2">
                مرحباً، الأستاذ محمد رمضان 👋
              </h1>
              <p className="text-muted-foreground">
                إليك ملخص سريع عن أنشطتك اليوم - منصة القائد
              </p>
            </div>
            <div className="flex gap-2">
              <Button className="bg-gradient-primary shadow-glow hover:shadow-glow/70">
                <Plus className="w-4 h-4 ml-2" />
                إضافة محتوى جديد
              </Button>
              <Dialog open={isExpenseDialogOpen} onOpenChange={setIsExpenseDialogOpen}>
                <DialogTrigger asChild>
                  <Button variant="outline" className="shadow-medium">
                    <DollarSign className="w-4 h-4 ml-2" />
                    إضافة مصروف
                  </Button>
                </DialogTrigger>
                <DialogContent className="sm:max-w-[425px]" dir="rtl">
                  <DialogHeader>
                    <DialogTitle>إضافة مصروف جديد</DialogTitle>
                  </DialogHeader>
                  <div className="grid gap-4 py-4">
                    <div className="grid gap-2">
                      <Label htmlFor="description">وصف المصروف</Label>
                      <Textarea
                        id="description"
                        placeholder="مثال: كتب دراسية، أدوات مكتبية..."
                        value={expenseData.description}
                        onChange={(e) => setExpenseData({ ...expenseData, description: e.target.value })}
                      />
                    </div>
                    <div className="grid gap-2">
                      <Label htmlFor="amount">المبلغ (جنيه)</Label>
                      <Input
                        id="amount"
                        type="number"
                        placeholder="0.00"
                        value={expenseData.amount}
                        onChange={(e) => setExpenseData({ ...expenseData, amount: e.target.value })}
                      />
                    </div>
                    <div className="grid gap-2">
                      <Label htmlFor="category">الفئة (اختياري)</Label>
                      <Input
                        id="category"
                        placeholder="مثال: تعليمي، إداري، تقني..."
                        value={expenseData.category}
                        onChange={(e) => setExpenseData({ ...expenseData, category: e.target.value })}
                      />
                    </div>
                  </div>
                  <div className="flex justify-end gap-2">
                    <Button variant="outline" onClick={() => setIsExpenseDialogOpen(false)}>
                      إلغاء
                    </Button>
                    <Button onClick={handleAddExpense}>
                      إضافة المصروف
                    </Button>
                  </div>
                </DialogContent>
              </Dialog>
            </div>
          </div>
        </div>

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
          <Card className="bg-gradient-card shadow-soft border-border/50">
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <TrendingUp className="w-5 h-5 text-primary" />
                الإجراءات السريعة
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              <Button variant="outline" className="w-full justify-start">
                <Users className="w-4 h-4 ml-2" />
                إضافة طالب جديد
              </Button>
              <Button variant="outline" className="w-full justify-start">
                <BookOpen className="w-4 h-4 ml-2" />
                إنشاء كورس جديد
              </Button>
              <Button variant="outline" className="w-full justify-start">
                <Calendar className="w-4 h-4 ml-2" />
                تسجيل الحضور
              </Button>
              <Button variant="outline" className="w-full justify-start">
                <FileVideo className="w-4 h-4 ml-2" />
                رفع فيديو تعليمي
              </Button>
            </CardContent>
          </Card>

          {/* Recent Activities */}
          <Card className="lg:col-span-2 bg-gradient-card shadow-soft border-border/50">
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Clock className="w-5 h-5 text-primary" />
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
                  <div className="text-center py-8 text-muted-foreground">
                    <Clock className="w-12 h-12 mx-auto mb-4 opacity-50" />
                    <p>لا توجد أنشطة حديثة</p>
                    <p className="text-sm">ابدأ بإضافة محتوى تعليمي للطلاب</p>
                  </div>
                )}
              </div>
            </CardContent>
          </Card>
        </div>

        {/* Today's Schedule */}
        <Card className="mt-6 bg-gradient-card shadow-soft border-border/50">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <GraduationCap className="w-5 h-5 text-primary" />
              جدول اليوم
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-1 gap-4">
              <div className="p-4 bg-muted/30 rounded-lg">
                <div className="flex items-center justify-between mb-2">
                  <span className="font-medium text-primary">التاريخ</span>
                  <span className="text-xs bg-primary/20 text-primary px-2 py-1 rounded-full">
                    نشط
                  </span>
                </div>
                <h4 className="font-medium text-foreground">دروس التاريخ والحضارات</h4>
                <p className="text-sm text-muted-foreground mt-1">تدريس مادة التاريخ للمراحل الثانوية - المحتوى التعليمي والامتحانات</p>
              </div>
            </div>
          </CardContent>
        </Card>
      </main>
    </div>
  );
};

export default TeacherDashboard;