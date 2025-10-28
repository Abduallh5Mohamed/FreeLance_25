import { useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { BarChart3, Download, Calendar, Users, DollarSign, BookOpen, TrendingUp } from "lucide-react";
import Header from "@/components/Header";

const Reports = () => {
  const [reportType, setReportType] = useState("attendance");
  const [startDate, setStartDate] = useState("");
  const [endDate, setEndDate] = useState("");
  const [selectedCourse, setSelectedCourse] = useState("all");

  // Real data from database (will be loaded later)
  const attendanceData = {
    totalStudents: 0,
    averageAttendance: 0,
    presentToday: 0,
    absentToday: 0
  };

  const financialData = {
    totalRevenue: 0,
    collected: 0,
    pending: 0,
    monthlyGrowth: 0
  };

  const courseData = {
    totalCourses: 0,
    totalLessons: 0,
    completedLessons: 0,
    averageProgress: 0
  };

  const generateReport = () => {
    // Here you would implement actual report generation
    console.log("Generating report:", { reportType, startDate, endDate, selectedCourse });
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-50 via-cyan-50 to-teal-50 dark:from-slate-900 dark:via-cyan-950 dark:to-teal-950" dir="rtl">
      <Header />
      
      <div className="container mx-auto px-4 py-8">
        <div className="flex items-center justify-between mb-8">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 bg-primary/10 rounded-lg flex items-center justify-center">
              <BarChart3 className="w-6 h-6 text-primary" />
            </div>
            <div>
              <h1 className="text-2xl font-bold text-foreground">التقارير والإحصائيات</h1>
              <p className="text-muted-foreground">تحليل شامل لأداء المنصة</p>
            </div>
          </div>
        </div>

        {/* Statistics Cards */}
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6 mb-8">
          <Card className="shadow-soft">
            <CardContent className="p-6">
              <div className="flex items-center gap-4">
                <div className="w-12 h-12 bg-blue-100 rounded-lg flex items-center justify-center">
                  <Users className="w-6 h-6 text-blue-600" />
                </div>
                <div>
                  <p className="text-sm text-muted-foreground">إجمالي الطلاب</p>
                  <p className="text-2xl font-bold text-foreground">{attendanceData.totalStudents}</p>
                  <p className="text-xs text-green-600 flex items-center gap-1">
                    <TrendingUp className="w-3 h-3" />
                    +5% من الشهر الماضي
                  </p>
                </div>
              </div>
            </CardContent>
          </Card>

          <Card className="shadow-soft">
            <CardContent className="p-6">
              <div className="flex items-center gap-4">
                <div className="w-12 h-12 bg-green-100 rounded-lg flex items-center justify-center">
                  <Calendar className="w-6 h-6 text-green-600" />
                </div>
                <div>
                  <p className="text-sm text-muted-foreground">معدل الحضور</p>
                  <p className="text-2xl font-bold text-foreground">{attendanceData.averageAttendance}%</p>
                  <p className="text-xs text-green-600 flex items-center gap-1">
                    <TrendingUp className="w-3 h-3" />
                    +3% من الشهر الماضي
                  </p>
                </div>
              </div>
            </CardContent>
          </Card>

          <Card className="shadow-soft">
            <CardContent className="p-6">
              <div className="flex items-center gap-4">
                <div className="w-12 h-12 bg-yellow-100 rounded-lg flex items-center justify-center">
                  <DollarSign className="w-6 h-6 text-yellow-600" />
                </div>
                <div>
                  <p className="text-sm text-muted-foreground">الإيرادات الشهرية</p>
                  <p className="text-2xl font-bold text-foreground">{financialData.totalRevenue.toLocaleString()} ج.م</p>
                  <p className="text-xs text-green-600 flex items-center gap-1">
                    <TrendingUp className="w-3 h-3" />
                    +{financialData.monthlyGrowth}% من الشهر الماضي
                  </p>
                </div>
              </div>
            </CardContent>
          </Card>

          <Card className="shadow-soft">
            <CardContent className="p-6">
              <div className="flex items-center gap-4">
                <div className="w-12 h-12 bg-purple-100 rounded-lg flex items-center justify-center">
                  <BookOpen className="w-6 h-6 text-purple-600" />
                </div>
                <div>
                  <p className="text-sm text-muted-foreground">الكورسات النشطة</p>
                  <p className="text-2xl font-bold text-foreground">{courseData.totalCourses}</p>
                  <p className="text-xs text-muted-foreground">{courseData.totalLessons} درس إجمالي</p>
                </div>
              </div>
            </CardContent>
          </Card>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-8">
          {/* Report Generator */}
          <Card className="shadow-soft">
            <CardHeader>
              <CardTitle>إنشاء تقرير مخصص</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="reportType">نوع التقرير</Label>
                <Select value={reportType} onValueChange={setReportType}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="attendance">تقرير الحضور</SelectItem>
                    <SelectItem value="financial">التقرير المالي</SelectItem>
                    <SelectItem value="performance">تقرير الأداء</SelectItem>
                    <SelectItem value="courses">تقرير الكورسات</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label htmlFor="startDate">من تاريخ</Label>
                  <Input
                    id="startDate"
                    type="date"
                    value={startDate}
                    onChange={(e) => setStartDate(e.target.value)}
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="endDate">إلى تاريخ</Label>
                  <Input
                    id="endDate"
                    type="date"
                    value={endDate}
                    onChange={(e) => setEndDate(e.target.value)}
                  />
                </div>
              </div>

              <div className="space-y-2">
                <Label htmlFor="course">الكورس</Label>
                <Select value={selectedCourse} onValueChange={setSelectedCourse}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">جميع الكورسات</SelectItem>
                    <SelectItem value="history">التاريخ الإسلامي</SelectItem>
                    <SelectItem value="geography">جغرافيا مصر</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              <Button onClick={generateReport} className="w-full">
                <Download className="w-4 h-4 ml-2" />
                إنشاء وتحميل التقرير
              </Button>
            </CardContent>
          </Card>

          {/* Quick Stats */}
          <Card className="shadow-soft">
            <CardHeader>
              <CardTitle>إحصائيات سريعة</CardTitle>
            </CardHeader>
            <CardContent className="space-y-6">
              <div className="space-y-4">
                <div>
                  <div className="flex items-center justify-between mb-2">
                    <span className="text-sm text-muted-foreground">الحضور اليوم</span>
                    <span className="text-sm font-medium">{attendanceData.presentToday}/{attendanceData.totalStudents}</span>
                  </div>
                  <div className="w-full bg-muted rounded-full h-2">
                    <div 
                      className="bg-green-600 h-2 rounded-full" 
                      style={{ width: `${(attendanceData.presentToday / attendanceData.totalStudents) * 100}%` }}
                    />
                  </div>
                </div>

                <div>
                  <div className="flex items-center justify-between mb-2">
                    <span className="text-sm text-muted-foreground">المبلغ المحصل</span>
                    <span className="text-sm font-medium">{financialData.collected.toLocaleString()} ج.م</span>
                  </div>
                  <div className="w-full bg-muted rounded-full h-2">
                    <div 
                      className="bg-blue-600 h-2 rounded-full" 
                      style={{ width: `${(financialData.collected / financialData.totalRevenue) * 100}%` }}
                    />
                  </div>
                </div>

                <div>
                  <div className="flex items-center justify-between mb-2">
                    <span className="text-sm text-muted-foreground">تقدم الكورسات</span>
                    <span className="text-sm font-medium">{courseData.completedLessons}/{courseData.totalLessons}</span>
                  </div>
                  <div className="w-full bg-muted rounded-full h-2">
                    <div 
                      className="bg-purple-600 h-2 rounded-full" 
                      style={{ width: `${(courseData.completedLessons / courseData.totalLessons) * 100}%` }}
                    />
                  </div>
                </div>
              </div>

              <div className="border-t pt-4">
                <h4 className="font-medium mb-3">آخر الأنشطة</h4>
                <div className="space-y-2 text-sm">
                  <div className="flex items-center justify-between">
                    <span className="text-muted-foreground">طالب جديد انضم</span>
                    <span className="text-xs text-muted-foreground">منذ ساعتين</span>
                  </div>
                  <div className="flex items-center justify-between">
                    <span className="text-muted-foreground">دفعة جديدة سُجلت</span>
                    <span className="text-xs text-muted-foreground">منذ 3 ساعات</span>
                  </div>
                  <div className="flex items-center justify-between">
                    <span className="text-muted-foreground">كورس جديد تم إنشاؤه</span>
                    <span className="text-xs text-muted-foreground">أمس</span>
                  </div>
                </div>
              </div>
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
};

export default Reports;