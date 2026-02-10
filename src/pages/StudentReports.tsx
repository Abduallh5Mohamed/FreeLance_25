import { useState, useEffect, useMemo } from "react";
import { useNavigate } from "react-router-dom";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import {
  Search,
  Users,
  Calendar,
  DollarSign,
  Award,
  MessageSquare,
  FileText,
  CheckCircle,
  XCircle,
  Clock,
  Send,
  Eye,
  Printer,
  Download,
} from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import {
  getStudents,
  getGroups,
  getGrades,
  getAttendance,
  getFees,
  getStudentExamResults,
  Student,
  User,
} from "@/lib/api";
import Header from "@/components/Header";

// WhatsApp icon component
const WhatsAppIcon = ({ className }: { className?: string }) => (
  <svg className={className} viewBox="0 0 24 24" fill="currentColor">
    <path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 01-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 01-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 012.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0012.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 005.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 00-3.48-8.413z" />
  </svg>
);

interface StudentReport {
  student: Student;
  attendanceDays: number;
  absentDays: number;
  lateDays: number;
  paidMonths: string[];
  unpaidMonths: string[];
  totalPaid: number;
  totalRemaining: number;
  examResults: {
    examTitle: string;
    score: number;
    totalMarks: number;
    percentage: number;
    date: string;
  }[];
  notes: string;
}

interface Group {
  id: string;
  name: string;
}

interface Grade {
  id: string;
  name: string;
}

const StudentReports = () => {
  const navigate = useNavigate();
  const { toast } = useToast();

  const [students, setStudents] = useState<Student[]>([]);
  const [groups, setGroups] = useState<Group[]>([]);
  const [grades, setGrades] = useState<Grade[]>([]);
  const [attendanceData, setAttendanceData] = useState<any[]>([]);
  const [feesData, setFeesData] = useState<any[]>([]);
  const [examResultsData, setExamResultsData] = useState<Map<string, any[]>>(new Map());
  const [studentNotes, setStudentNotes] = useState<Map<string, string>>(new Map());
  const [loading, setLoading] = useState(true);

  // Filters
  const [searchQuery, setSearchQuery] = useState("");
  const [selectedGroup, setSelectedGroup] = useState<string>("all");
  const [selectedGrade, setSelectedGrade] = useState<string>("all");

  // Report Dialog
  const [selectedStudent, setSelectedStudent] = useState<Student | null>(null);
  const [showReportDialog, setShowReportDialog] = useState(false);
  const [editingNotes, setEditingNotes] = useState("");

  // Check authentication
  useEffect(() => {
    const userStr = localStorage.getItem('currentUser');
    const user: User | null = userStr ? JSON.parse(userStr) : null;

    if (!user || (user.role !== 'admin' && user.role !== 'teacher' && user.role !== 'staff')) {
      navigate('/auth');
      return;
    }

    loadData();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const loadData = async () => {
    try {
      setLoading(true);

      const [studentsData, groupsData, gradesData, attendanceRes, feesRes] = await Promise.all([
        getStudents(),
        getGroups(),
        getGrades(),
        getAttendance({}),
        getFees(),
      ]);

      setStudents(studentsData || []);
      setGroups(groupsData || []);
      setGrades(gradesData || []);
      setAttendanceData(attendanceRes || []);
      setFeesData(feesRes || []);

      // Load exam results for each student
      const resultsMap = new Map<string, any[]>();
      for (const student of (studentsData || [])) {
        try {
          const results = await getStudentExamResults(student.id) as any[];
          if (results && Array.isArray(results) && results.length > 0) {
            resultsMap.set(student.id, results);
          }
        } catch (e) {
          // Ignore errors for individual students
        }
      }
      setExamResultsData(resultsMap);

    } catch (error) {
      console.error('Error loading data:', error);
      toast({
        title: "خطأ",
        description: "فشل تحميل البيانات",
        variant: "destructive",
      });
    } finally {
      setLoading(false);
    }
  };

  // Filter students
  const filteredStudents = useMemo(() => {
    return students.filter((student) => {
      if (searchQuery) {
        const query = searchQuery.toLowerCase();
        const matchesName = student.name?.toLowerCase().includes(query);
        const matchesPhone = student.phone?.includes(query);
        if (!matchesName && !matchesPhone) return false;
      }

      if (selectedGroup !== "all" && student.group_id !== selectedGroup) {
        return false;
      }

      if (selectedGrade !== "all" && student.grade_id !== selectedGrade) {
        return false;
      }

      return true;
    });
  }, [students, searchQuery, selectedGroup, selectedGrade]);

  const getMonthName = (month: number) => {
    const months = [
      'يناير', 'فبراير', 'مارس', 'أبريل', 'مايو', 'يونيو',
      'يوليو', 'أغسطس', 'سبتمبر', 'أكتوبر', 'نوفمبر', 'ديسمبر'
    ];
    return months[month - 1] || month.toString();
  };

  // Calculate student report
  const calculateStudentReport = (student: Student): StudentReport => {
    // Attendance
    const studentAttendance = attendanceData.filter(a => a.student_id === student.id);
    const attendanceDays = studentAttendance.filter(a => a.status === 'present').length;
    const absentDays = studentAttendance.filter(a => a.status === 'absent').length;
    const lateDays = studentAttendance.filter(a => a.status === 'late').length;

    // Fees - find by student name or phone
    const studentFees = feesData.filter(f =>
      f.student_name === student.name ||
      f.phone === student.phone
    );

    // Current month check
    const now = new Date();
    const currentYear = now.getFullYear();
    const currentMonth = now.getMonth() + 1;

    const paidMonths: string[] = [];
    const unpaidMonths: string[] = [];
    let totalPaid = 0;
    let totalRemaining = 0;
    let currentMonthPaid = 0;
    let hasPaidCurrentMonth = false;

    studentFees.forEach(fee => {
      const monthLabel = fee.payment_month && fee.payment_year
        ? `${getMonthName(fee.payment_month)} ${fee.payment_year}`
        : fee.due_date
        ? new Date(fee.due_date).toLocaleDateString('ar-EG', { month: 'long', year: 'numeric' })
        : 'غير محدد';

      if (fee.status === 'paid') {
        paidMonths.push(monthLabel);
        totalPaid += Number(fee.paid_amount) || 0;
        // Check if this is current month payment
        if (fee.payment_year === currentYear && fee.payment_month === currentMonth) {
          currentMonthPaid = Number(fee.paid_amount) || Number(fee.amount) || 0;
          hasPaidCurrentMonth = true;
        }
      } else {
        unpaidMonths.push(monthLabel);
        totalRemaining += Number(fee.remaining_amount) || Number(fee.amount) || 0;
      }
    });

    // If student has not paid for current month, add it to unpaid
    if (!hasPaidCurrentMonth) {
      const currentMonthLabel = `${getMonthName(currentMonth)} ${currentYear}`;
      if (!unpaidMonths.includes(currentMonthLabel)) {
        unpaidMonths.unshift(currentMonthLabel);
      }
    }

    // Exam Results
    const examResults = (examResultsData.get(student.id) || []).map((result: any) => ({
      examTitle: result.exams?.title || result.exam_title || 'امتحان',
      score: result.marks_obtained || result.score || 0,
      totalMarks: result.exams?.total_marks || result.total_marks || 100,
      percentage: ((result.marks_obtained || result.score || 0) / (result.exams?.total_marks || result.total_marks || 100)) * 100,
      date: result.submitted_at ? new Date(result.submitted_at).toLocaleDateString('ar-EG') : '',
    }));

    // Notes
    const notes = studentNotes.get(student.id) || '';

    return {
      student,
      attendanceDays,
      absentDays,
      lateDays,
      paidMonths,
      unpaidMonths,
      totalPaid: currentMonthPaid,
      totalRemaining: hasPaidCurrentMonth ? 0 : totalRemaining,
      examResults,
      notes,
    };
  };

  // Save notes to database
  const saveNotes = async () => {
    if (selectedStudent) {
      try {
        const token = localStorage.getItem('token');
        const response = await fetch(`${import.meta.env.VITE_API_URL || '/api'}/students/${selectedStudent.id}/notes`, {
          method: 'PUT',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${token}`,
          },
          body: JSON.stringify({ notes: editingNotes }),
        });
        if (response.ok) {
          const newNotes = new Map(studentNotes);
          newNotes.set(selectedStudent.id, editingNotes);
          setStudentNotes(newNotes);
          toast({
            title: "تم الحفظ",
            description: "تم حفظ الملاحظات بنجاح",
          });
        } else {
          throw new Error('Failed to save notes');
        }
      } catch (error) {
        console.error('Error saving notes:', error);
        toast({
          title: "خطأ",
          description: "فشل في حفظ الملاحظات",
          variant: "destructive",
        });
      }
    }
  };

  // Generate WhatsApp message
  const generateWhatsAppMessage = (report: StudentReport): string => {
    const avgScore = report.examResults.length > 0
      ? (report.examResults.reduce((sum, r) => sum + r.percentage, 0) / report.examResults.length).toFixed(1)
      : 'لا توجد امتحانات';

    let message = `📋 *تقرير الطالب: ${report.student.name}*\n\n`;

    message += `📅 *الحضور والغياب:*\n`;
    message += `✅ أيام الحضور: ${report.attendanceDays}\n`;
    message += `❌ أيام الغياب: ${report.absentDays}\n`;
    message += `⏰ أيام التأخير: ${report.lateDays}\n\n`;

    message += `💰 *المصروفات:*\n`;
    message += `✅ المبلغ المدفوع: ${report.totalPaid} جنيه\n`;
    message += `❌ المبلغ المتبقي: ${report.totalRemaining} جنيه\n`;
    if (report.paidMonths.length > 0) {
      message += `📗 الشهور المدفوعة: ${report.paidMonths.join('، ')}\n`;
    }
    if (report.unpaidMonths.length > 0) {
      message += `📕 الشهور غير المدفوعة: ${report.unpaidMonths.join('، ')}\n`;
    }
    message += `\n`;

    message += `📊 *الدرجات:*\n`;
    message += `📈 المتوسط العام: ${avgScore}%\n`;
    if (report.examResults.length > 0) {
      report.examResults.slice(0, 5).forEach(exam => {
        message += `• ${exam.examTitle}: ${exam.score}/${exam.totalMarks} (${exam.percentage.toFixed(0)}%)\n`;
      });
    }
    message += `\n`;

    if (report.notes) {
      message += `📝 *ملاحظات الإدارة:*\n${report.notes}\n\n`;
    }

    message += `\n_تقرير من سنتر القائد - ${new Date().toLocaleDateString('ar-EG')}_`;

    return encodeURIComponent(message);
  };

  // Send WhatsApp - يرسل لرقم ولي الأمر فقط
  const sendWhatsApp = (student: Student) => {
    const report = calculateStudentReport(student);

    // استخدام رقم ولي الأمر فقط
    const guardianPhone = student.guardian_phone;

    if (!guardianPhone) {
      toast({
        title: "خطأ",
        description: "لا يوجد رقم هاتف لولي الأمر. يرجى إضافة رقم ولي الأمر أولاً.",
        variant: "destructive",
      });
      return;
    }

    // Clean phone number
    let cleanPhone = guardianPhone.replace(/\D/g, '');
    if (cleanPhone.startsWith('0')) {
      cleanPhone = '2' + cleanPhone; // Egypt country code
    }
    if (!cleanPhone.startsWith('2')) {
      cleanPhone = '2' + cleanPhone;
    }

    const message = generateWhatsAppMessage(report);
    const whatsappUrl = `https://wa.me/${cleanPhone}?text=${message}`;
    window.open(whatsappUrl, '_blank');
  };

  // View report dialog
  const viewReport = async (student: Student) => {
    setSelectedStudent(student);
    setEditingNotes(studentNotes.get(student.id) || '');
    setShowReportDialog(true);
    
    // Load notes from database
    try {
      const token = localStorage.getItem('token');
      const response = await fetch(`${import.meta.env.VITE_API_URL || '/api'}/students/${student.id}/notes`, {
        headers: { 'Authorization': `Bearer ${token}` },
      });
      if (response.ok) {
        const data = await response.json();
        setEditingNotes(data.notes || '');
        const newNotes = new Map(studentNotes);
        newNotes.set(student.id, data.notes || '');
        setStudentNotes(newNotes);
      }
    } catch (error) {
      console.error('Error loading notes:', error);
    }
  };

  const resetFilters = () => {
    setSearchQuery("");
    setSelectedGroup("all");
    setSelectedGrade("all");
  };

  if (loading) {
    return (
      <>
        <Header />
        <div className="min-h-screen bg-gradient-to-br from-blue-50 via-white to-purple-50 p-6">
          <div className="max-w-7xl mx-auto">
            <div className="text-center py-12">
              <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-blue-600 mx-auto"></div>
              <p className="mt-4 text-gray-600">جاري التحميل...</p>
            </div>
          </div>
        </div>
      </>
    );
  }

  const currentReport = selectedStudent ? calculateStudentReport(selectedStudent) : null;

  return (
    <>
      <Header />
      <div className="min-h-screen bg-gradient-to-br from-blue-50 via-white to-purple-50 p-6" dir="rtl">
        <div className="max-w-7xl mx-auto space-y-6">
          {/* Header */}
          <div className="flex flex-col md:flex-row items-start md:items-center justify-between gap-4">
            <div>
              <h1 className="text-3xl font-bold text-gray-900 flex items-center gap-3">
                <FileText className="w-8 h-8 text-blue-600" />
                تقارير الطلاب
              </h1>
              <p className="text-gray-600">عرض ومتابعة تقارير الطلاب الشاملة</p>
            </div>
            <Button onClick={resetFilters} variant="outline">
              إعادة تعيين الفلاتر
            </Button>
          </div>

          {/* Filters */}
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Search className="w-5 h-5" />
                الفلاتر والبحث
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                {/* Search */}
                <div className="relative">
                  <Search className="absolute right-3 top-1/2 transform -translate-y-1/2 h-4 w-4 text-gray-400" />
                  <Input
                    placeholder="ابحث بالاسم أو الهاتف..."
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    className="pr-10 text-right"
                  />
                </div>

                {/* Grade Filter */}
                <Select value={selectedGrade} onValueChange={setSelectedGrade}>
                  <SelectTrigger className="text-right">
                    <SelectValue placeholder="اختر الصف" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">كل الصفوف</SelectItem>
                    {grades.map((grade) => (
                      <SelectItem key={grade.id} value={grade.id}>
                        {grade.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>

                {/* Group Filter */}
                <Select value={selectedGroup} onValueChange={setSelectedGroup}>
                  <SelectTrigger className="text-right">
                    <SelectValue placeholder="اختر المجموعة" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">كل المجموعات</SelectItem>
                    {groups.map((group) => (
                      <SelectItem key={group.id} value={group.id}>
                        {group.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              {/* Results count */}
              <div className="mt-4 text-sm text-gray-600">
                عرض {filteredStudents.length} من {students.length} طالب
              </div>
            </CardContent>
          </Card>

          {/* Students Table */}
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Users className="w-5 h-5" />
                الطلاب ({filteredStudents.length})
              </CardTitle>
            </CardHeader>
            <CardContent>
              {filteredStudents.length > 0 ? (
                <div className="overflow-x-auto">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead className="text-right">الاسم</TableHead>
                        <TableHead className="text-right">هاتف الطالب</TableHead>
                        <TableHead className="text-right">هاتف ولي الأمر</TableHead>
                        <TableHead className="text-right">الصف</TableHead>
                        <TableHead className="text-center">الحضور</TableHead>
                        <TableHead className="text-center">الغياب</TableHead>
                        <TableHead className="text-center">المدفوعات</TableHead>
                        <TableHead className="text-center">الدرجات</TableHead>
                        <TableHead className="text-center">الإجراءات</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {filteredStudents.map((student) => {
                        const report = calculateStudentReport(student);
                        const avgScore = report.examResults.length > 0
                          ? (report.examResults.reduce((sum, r) => sum + r.percentage, 0) / report.examResults.length)
                          : null;

                        // إيجاد اسم الصف من قائمة الصفوف
                        const gradeName = student.grade || grades.find(g => g.id === student.grade_id)?.name || '-';

                        return (
                          <TableRow key={student.id}>
                            <TableCell className="font-medium">{student.name}</TableCell>
                            <TableCell>{student.phone || '-'}</TableCell>
                            <TableCell>
                              {student.guardian_phone ? (
                                <span className="text-green-600 font-medium">{student.guardian_phone}</span>
                              ) : (
                                <span className="text-red-500">غير مسجل</span>
                              )}
                            </TableCell>
                            <TableCell>{gradeName}</TableCell>
                            <TableCell className="text-center">
                              <Badge variant="outline" className="bg-green-50 text-green-700">
                                <CheckCircle className="w-3 h-3 ml-1" />
                                {report.attendanceDays}
                              </Badge>
                            </TableCell>
                            <TableCell className="text-center">
                              <Badge variant="outline" className="bg-red-50 text-red-700">
                                <XCircle className="w-3 h-3 ml-1" />
                                {report.absentDays}
                              </Badge>
                            </TableCell>
                            <TableCell className="text-center">
                              {report.totalPaid > 0 ? (
                                <Badge className="bg-green-600">
                                  مدفوع
                                </Badge>
                              ) : (
                                <Badge variant="destructive">
                                  غير مدفوع
                                </Badge>
                              )}
                            </TableCell>
                            <TableCell className="text-center">
                              {avgScore !== null ? (
                                <Badge variant={avgScore >= 60 ? "default" : "destructive"}>
                                  {avgScore.toFixed(0)}%
                                </Badge>
                              ) : (
                                <span className="text-gray-400">-</span>
                              )}
                            </TableCell>
                            <TableCell>
                              <div className="flex items-center justify-center gap-2">
                                <Button
                                  variant="outline"
                                  size="sm"
                                  onClick={() => viewReport(student)}
                                  title="عرض التقرير"
                                >
                                  <Eye className="w-4 h-4" />
                                </Button>
                                <Button
                                  variant="outline"
                                  size="sm"
                                  onClick={() => sendWhatsApp(student)}
                                  className="text-green-600 hover:text-green-700 hover:bg-green-50"
                                  title="إرسال عبر واتساب"
                                >
                                  <WhatsAppIcon className="w-4 h-4" />
                                </Button>
                              </div>
                            </TableCell>
                          </TableRow>
                        );
                      })}
                    </TableBody>
                  </Table>
                </div>
              ) : (
                <div className="text-center py-12">
                  <Users className="w-16 h-16 mx-auto text-gray-300 mb-4" />
                  <p className="text-gray-500">لا يوجد طلاب</p>
                </div>
              )}
            </CardContent>
          </Card>
        </div>
      </div>

      {/* Report Dialog */}
      <Dialog open={showReportDialog} onOpenChange={setShowReportDialog}>
        <DialogContent className="max-w-4xl max-h-[90vh] overflow-y-auto" dir="rtl">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-xl">
              <FileText className="w-6 h-6 text-blue-600" />
              تقرير الطالب: {selectedStudent?.name}
            </DialogTitle>
          </DialogHeader>

          {currentReport && (
            <div className="space-y-6">
              {/* Attendance Section */}
              <Card>
                <CardHeader className="pb-3">
                  <CardTitle className="flex items-center gap-2 text-lg">
                    <Calendar className="w-5 h-5 text-blue-600" />
                    الحضور والغياب
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  <div className="grid grid-cols-3 gap-4 text-center">
                    <div className="p-4 bg-green-50 rounded-lg">
                      <CheckCircle className="w-8 h-8 text-green-600 mx-auto mb-2" />
                      <p className="text-2xl font-bold text-green-700">{currentReport.attendanceDays}</p>
                      <p className="text-sm text-green-600">يوم حضور</p>
                    </div>
                    <div className="p-4 bg-red-50 rounded-lg">
                      <XCircle className="w-8 h-8 text-red-600 mx-auto mb-2" />
                      <p className="text-2xl font-bold text-red-700">{currentReport.absentDays}</p>
                      <p className="text-sm text-red-600">يوم غياب</p>
                    </div>
                    <div className="p-4 bg-yellow-50 rounded-lg">
                      <Clock className="w-8 h-8 text-yellow-600 mx-auto mb-2" />
                      <p className="text-2xl font-bold text-yellow-700">{currentReport.lateDays}</p>
                      <p className="text-sm text-yellow-600">يوم تأخير</p>
                    </div>
                  </div>
                </CardContent>
              </Card>

              {/* Fees Section */}
              <Card>
                <CardHeader className="pb-3">
                  <CardTitle className="flex items-center gap-2 text-lg">
                    <DollarSign className="w-5 h-5 text-green-600" />
                    المصروفات والمدفوعات
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  <div className="grid grid-cols-2 gap-4 mb-4">
                    <div className="p-4 bg-green-50 rounded-lg text-center">
                      <p className="text-2xl font-bold text-green-700">{Number(currentReport.totalPaid).toLocaleString()} جنيه</p>
                      <p className="text-sm text-green-600">المبلغ المدفوع (هذا الشهر)</p>
                    </div>
                    <div className="p-4 bg-red-50 rounded-lg text-center">
                      <p className="text-2xl font-bold text-red-700">{currentReport.totalPaid > 0 ? 'مدفوع' : 'غير مدفوع'}</p>
                      <p className="text-sm text-red-600">حالة الشهر الحالي</p>
                    </div>
                  </div>
                  <div className="grid grid-cols-2 gap-4">
                    <div>
                      <h4 className="font-medium text-green-700 mb-2">الشهور المدفوعة:</h4>
                      {currentReport.paidMonths.length > 0 ? (
                        <div className="flex flex-wrap gap-2">
                          {currentReport.paidMonths.map((month, idx) => (
                            <Badge key={idx} className="bg-green-100 text-green-700">{month}</Badge>
                          ))}
                        </div>
                      ) : (
                        <p className="text-gray-400 text-sm">لا توجد شهور مدفوعة</p>
                      )}
                    </div>
                    <div>
                      <h4 className="font-medium text-red-700 mb-2">الشهور غير المدفوعة:</h4>
                      {currentReport.unpaidMonths.length > 0 ? (
                        <div className="flex flex-wrap gap-2">
                          {currentReport.unpaidMonths.map((month, idx) => (
                            <Badge key={idx} variant="destructive">{month}</Badge>
                          ))}
                        </div>
                      ) : (
                        <p className="text-gray-400 text-sm">لا توجد شهور غير مدفوعة</p>
                      )}
                    </div>
                  </div>
                </CardContent>
              </Card>

              {/* Exam Results Section */}
              <Card>
                <CardHeader className="pb-3">
                  <CardTitle className="flex items-center gap-2 text-lg">
                    <Award className="w-5 h-5 text-yellow-600" />
                    الدرجات والامتحانات
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  {currentReport.examResults.length > 0 ? (
                    <div className="space-y-3">
                      {currentReport.examResults.map((exam, idx) => (
                        <div key={idx} className="flex items-center justify-between p-3 bg-gray-50 rounded-lg">
                          <div>
                            <p className="font-medium">{exam.examTitle}</p>
                            <p className="text-sm text-gray-500">{exam.date}</p>
                          </div>
                          <div className="text-left">
                            <p className="font-bold text-lg">{exam.score}/{exam.totalMarks}</p>
                            <Badge variant={exam.percentage >= 60 ? "default" : "destructive"}>
                              {exam.percentage.toFixed(0)}%
                            </Badge>
                          </div>
                        </div>
                      ))}
                      <div className="mt-4 p-4 bg-blue-50 rounded-lg text-center">
                        <p className="text-sm text-blue-600">المتوسط العام</p>
                        <p className="text-2xl font-bold text-blue-700">
                          {(currentReport.examResults.reduce((sum, r) => sum + r.percentage, 0) / currentReport.examResults.length).toFixed(1)}%
                        </p>
                      </div>
                    </div>
                  ) : (
                    <p className="text-center text-gray-400 py-4">لا توجد نتائج امتحانات</p>
                  )}
                </CardContent>
              </Card>

              {/* Notes Section */}
              <Card>
                <CardHeader className="pb-3">
                  <CardTitle className="flex items-center gap-2 text-lg">
                    <MessageSquare className="w-5 h-5 text-purple-600" />
                    ملاحظات الإدارة
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  <Textarea
                    placeholder="أضف ملاحظات خاصة بهذا الطالب..."
                    value={editingNotes}
                    onChange={(e) => setEditingNotes(e.target.value)}
                    className="min-h-[100px]"
                  />
                  <Button onClick={saveNotes} className="mt-3">
                    حفظ الملاحظات
                  </Button>
                </CardContent>
              </Card>
            </div>
          )}

          <DialogFooter className="flex gap-2 mt-4">
            <Button
              variant="outline"
              onClick={() => setShowReportDialog(false)}
            >
              إغلاق
            </Button>
            <Button
              onClick={() => selectedStudent && sendWhatsApp(selectedStudent)}
              className="bg-green-600 hover:bg-green-700"
            >
              <WhatsAppIcon className="w-4 h-4 ml-2" />
              إرسال لولي الأمر
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
};

export default StudentReports;
