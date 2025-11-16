import { useState, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { CheckCircle2, XCircle, Clock, ArrowLeft, Phone, Mail } from "lucide-react";
import { useParams, useNavigate } from "react-router-dom";
import { useToast } from "@/hooks/use-toast";
import Header from "@/components/Header";
import { getExamById, getExamAttempts, getNotAttemptedStudents } from "@/lib/api";

interface ExamAttempt {
  id: string;
  student_id: string;
  student_name: string;
  student_phone?: string;
  student_email?: string;
  started_at: string;
  completed_at?: string;
  score?: number;
  status: string;
}

interface Student {
  id: string;
  name: string;
  phone?: string;
  email?: string;
  grade_id?: string;
  group_id?: string;
}

interface Exam {
  id: string;
  title: string;
  description?: string;
  total_marks?: number;
  duration_minutes?: number;
  start_time?: string;
  end_time?: string;
}

const ExamReports = () => {
  const { examId } = useParams();
  const navigate = useNavigate();
  const { toast } = useToast();

  const [exam, setExam] = useState<Exam | null>(null);
  const [attempted, setAttempted] = useState<ExamAttempt[]>([]);
  const [notAttempted, setNotAttempted] = useState<Student[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    loadExamReports();
  }, [examId]);

  const loadExamReports = async () => {
    try {
      if (!examId) return;

      setLoading(true);

      // Load exam details
      const examData = await getExamById(examId);
      if (!examData) {
        toast({
          title: 'خطأ',
          description: 'لم يتم العثور على الامتحان',
          variant: 'destructive'
        });
        navigate('/exam-manager');
        return;
      }
      setExam(examData);

      // Load attempts
      const attemptsData = await getExamAttempts(examId);
      setAttempted(attemptsData || []);

      // Load not attempted students
      const notAttemptedData = await getNotAttemptedStudents(examId);
      setNotAttempted(notAttemptedData || []);

    } catch (error) {
      console.error('Error loading exam reports:', error);
      toast({
        title: 'خطأ',
        description: 'فشل تحميل التقارير',
        variant: 'destructive'
      });
    } finally {
      setLoading(false);
    }
  };

  const formatDateTime = (dateString?: string) => {
    if (!dateString) return '-';
    const date = new Date(dateString);
    return date.toLocaleString('ar-EG', {
      year: 'numeric',
      month: 'long',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit'
    });
  };

  const getStatusBadge = (status: string) => {
    switch (status) {
      case 'completed':
        return <Badge className="bg-green-500"><CheckCircle2 className="w-3 h-3 mr-1" /> مكتمل</Badge>;
      case 'in_progress':
        return <Badge className="bg-blue-500"><Clock className="w-3 h-3 mr-1" /> جاري</Badge>;
      default:
        return <Badge variant="secondary">{status}</Badge>;
    }
  };

  if (loading) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-slate-50 via-cyan-50 to-teal-50 dark:from-slate-900 dark:via-cyan-950 dark:to-teal-950" dir="rtl">
        <Header />
        <div className="container mx-auto px-4 py-8">
          <div className="flex items-center justify-center h-64">
            <p className="text-lg">جاري التحميل...</p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-50 via-cyan-50 to-teal-50 dark:from-slate-900 dark:via-cyan-950 dark:to-teal-950" dir="rtl">
      <Header />

      <div className="container mx-auto px-4 py-8">
        <div className="flex items-center justify-between mb-6">
          <div>
            <h1 className="text-3xl font-bold text-foreground mb-2">تقرير الامتحان</h1>
            {exam && (
              <p className="text-lg text-muted-foreground">{exam.title}</p>
            )}
          </div>
          <Button onClick={() => navigate('/exam-manager')} variant="outline">
            <ArrowLeft className="w-4 h-4 ml-2" />
            العودة للامتحانات
          </Button>
        </div>

        {/* Statistics Cards */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-6">
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-sm font-medium text-muted-foreground">إجمالي الطلاب</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="text-3xl font-bold">{attempted.length + notAttempted.length}</div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-sm font-medium text-muted-foreground">الطلاب الذين امتحنوا</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="text-3xl font-bold text-green-600">{attempted.length}</div>
              <p className="text-xs text-muted-foreground mt-1">
                {((attempted.length / (attempted.length + notAttempted.length)) * 100).toFixed(1)}% من الإجمالي
              </p>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-sm font-medium text-muted-foreground">الطلاب الذين لم يمتحنوا</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="text-3xl font-bold text-red-600">{notAttempted.length}</div>
              <p className="text-xs text-muted-foreground mt-1">
                {((notAttempted.length / (attempted.length + notAttempted.length)) * 100).toFixed(1)}% من الإجمالي
              </p>
            </CardContent>
          </Card>
        </div>

        {/* Students Who Attempted */}
        <Card className="mb-6">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <CheckCircle2 className="w-5 h-5 text-green-600" />
              الطلاب الذين أدوا الامتحان ({attempted.length})
            </CardTitle>
          </CardHeader>
          <CardContent>
            {attempted.length === 0 ? (
              <p className="text-center text-muted-foreground py-8">لا يوجد طلاب امتحنوا بعد</p>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>اسم الطالب</TableHead>
                    <TableHead>رقم الهاتف</TableHead>
                    <TableHead>وقت البدء</TableHead>
                    <TableHead>وقت الانتهاء</TableHead>
                    <TableHead>الدرجة</TableHead>
                    <TableHead>الحالة</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {attempted.map((attempt) => (
                    <TableRow key={attempt.id}>
                      <TableCell className="font-medium">{attempt.student_name}</TableCell>
                      <TableCell>
                        {attempt.student_phone && (
                          <div className="flex items-center gap-1 text-sm">
                            <Phone className="w-3 h-3" />
                            {attempt.student_phone}
                          </div>
                        )}
                      </TableCell>
                      <TableCell>{formatDateTime(attempt.started_at)}</TableCell>
                      <TableCell>{formatDateTime(attempt.completed_at)}</TableCell>
                      <TableCell>
                        {attempt.score !== null && attempt.score !== undefined ? (
                          <span className="font-bold">{attempt.score} / {exam?.total_marks || 0}</span>
                        ) : (
                          '-'
                        )}
                      </TableCell>
                      <TableCell>{getStatusBadge(attempt.status)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>

        {/* Students Who Haven't Attempted */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <XCircle className="w-5 h-5 text-red-600" />
              الطلاب الذين لم يؤدوا الامتحان ({notAttempted.length})
            </CardTitle>
          </CardHeader>
          <CardContent>
            {notAttempted.length === 0 ? (
              <p className="text-center text-green-600 py-8 font-medium">
                ✅ جميع الطلاب أدوا الامتحان
              </p>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>اسم الطالب</TableHead>
                    <TableHead>رقم الهاتف</TableHead>
                    <TableHead>البريد الإلكتروني</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {notAttempted.map((student) => (
                    <TableRow key={student.id}>
                      <TableCell className="font-medium">{student.name}</TableCell>
                      <TableCell>
                        {student.phone && (
                          <div className="flex items-center gap-1 text-sm">
                            <Phone className="w-3 h-3" />
                            {student.phone}
                          </div>
                        )}
                      </TableCell>
                      <TableCell>
                        {student.email && (
                          <div className="flex items-center gap-1 text-sm">
                            <Mail className="w-3 h-3" />
                            {student.email}
                          </div>
                        )}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
};

export default ExamReports;
