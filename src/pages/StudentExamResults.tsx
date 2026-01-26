import { useState, useEffect } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Trophy, CheckCircle2, XCircle, Clock, Calendar, FileText, TrendingUp, Award, Download } from "lucide-react";
import jsPDF from 'jspdf';
import StudentHeader from "@/components/StudentHeader";
import { useNavigate } from "react-router-dom";
import { useToast } from "@/hooks/use-toast";
import { motion, AnimatePresence } from "framer-motion";
import { FloatingParticles } from "@/components/FloatingParticles";
import { useScreenRecordingPrevention } from "@/hooks/useScreenRecordingPrevention";

const API_BASE_URL = import.meta.env.VITE_API_URL || 'http://72.62.35.177:3001/api';

interface ExamResult {
  id: string;
  exam_id: string;
  exam_title: string;
  score: number;
  total_marks: number;
  passing_marks: number;
  passed: boolean;
  attempted_at: string;
  percentage: number;
}

const StudentExamResults = () => {
  useScreenRecordingPrevention(); // Prevent screen recording & screenshots
  const [examResults, setExamResults] = useState<ExamResult[]>([]);
  const [loading, setLoading] = useState(true);
  const [studentId, setStudentId] = useState<string>('');
  
  const navigate = useNavigate();
  const { toast } = useToast();

  useEffect(() => {
    fetchExamResults();
  }, []);

  const fetchExamResults = async () => {
    try {
      // Check if user is logged in and is a student
      const userStr = localStorage.getItem('currentUser');
      
      if (!userStr) {
        navigate('/auth');
        toast({
          variant: "destructive",
          title: "غير مسموح",
          description: "يرجى تسجيل الدخول أولاً",
        });
        setLoading(false);
        return;
      }

      const user = JSON.parse(userStr);
      if (user.role !== 'student') {
        navigate('/auth');
        toast({
          variant: "destructive",
          title: "غير مسموح",
          description: "هذه الصفحة للطلاب فقط",
        });
        setLoading(false);
        return;
      }

      const currentStudentId = user.id;
      setStudentId(currentStudentId);

      // Fetch exam results from backend
      const response = await fetch(`${API_BASE_URL}/exam-results/student/${currentStudentId}`, {
        headers: {
          'Content-Type': 'application/json',
        },
      });

      if (!response.ok) {
        throw new Error('Failed to fetch exam results');
      }

      const data = await response.json();
      console.log('Exam results:', data);

      // Process and sort results
      const processedResults = (data || []).map((result: any) => {
        const score = result.score || 0;
        const totalMarks = result.total_marks || result.exam?.total_marks || 0;
        const passingMarks = result.passing_marks || result.exam?.passing_marks || 0;
        const percentage = totalMarks > 0 ? (score / totalMarks) * 100 : 0;
        
        // Calculate passed status based on score vs passing marks
        const isPassed = score >= passingMarks;
        
        return {
          id: result.id,
          exam_id: result.exam_id,
          exam_title: result.exam_title || result.exam?.title || 'امتحان',
          score: score,
          total_marks: totalMarks,
          passing_marks: passingMarks,
          passed: isPassed,
          attempted_at: result.attempted_at || result.created_at,
          percentage: percentage
        };
      }).sort((a: ExamResult, b: ExamResult) => 
        new Date(b.attempted_at).getTime() - new Date(a.attempted_at).getTime()
      );

      setExamResults(processedResults);
      setLoading(false);
    } catch (error) {
      console.error('Error fetching exam results:', error);
      toast({
        variant: "destructive",
        title: "خطأ",
        description: "فشل تحميل نتائج الامتحانات",
      });
      setLoading(false);
    }
  };

  const getGradeColor = (percentage: number) => {
    if (percentage >= 85) return 'from-green-500 to-emerald-500';
    if (percentage >= 75) return 'from-blue-500 to-cyan-500';
    if (percentage >= 65) return 'from-yellow-500 to-orange-500';
    return 'from-red-500 to-pink-500';
  };

  const getGradeLabel = (percentage: number) => {
    if (percentage >= 85) return 'ممتاز';
    if (percentage >= 75) return 'جيد جداً';
    if (percentage >= 65) return 'جيد';
    if (percentage >= 50) return 'مقبول';
    return 'ضعيف';
  };

  const [generatingPDF, setGeneratingPDF] = useState<string | null>(null);

  const averageScore = examResults.length > 0
    ? examResults.reduce((sum, result) => sum + result.percentage, 0) / examResults.length
    : 0;

  const passedExams = examResults.filter(r => r.passed).length;
  const totalExams = examResults.length;

  // Generate PDF for a specific result
  const generateResultPDF = async (result: ExamResult) => {
    setGeneratingPDF(result.id);
    try {
      const doc = new jsPDF({
        orientation: 'portrait',
        unit: 'mm',
        format: 'a4'
      });

      // Get student name from localStorage
      const userStr = localStorage.getItem('currentUser');
      const user = userStr ? JSON.parse(userStr) : null;
      const studentName = user?.name || 'طالب';

      // Arabic font setup
      doc.setFont('helvetica', 'bold');
      
      // Header
      doc.setFillColor(59, 130, 246);
      doc.rect(0, 0, 210, 40, 'F');
      
      doc.setTextColor(255, 255, 255);
      doc.setFontSize(24);
      doc.text('Exam Result Certificate', 105, 25, { align: 'center' });
      
      // Student info
      doc.setTextColor(0, 0, 0);
      doc.setFontSize(14);
      doc.text(`Student: ${studentName}`, 20, 55);
      doc.text(`Exam: ${result.exam_title}`, 20, 65);
      doc.text(`Date: ${new Date(result.attempted_at).toLocaleDateString('en-US')}`, 20, 75);
      
      // Score box
      const passed = result.passed;
      doc.setFillColor(passed ? 34 : 239, passed ? 197 : 68, passed ? 94 : 68);
      doc.roundedRect(50, 90, 110, 50, 5, 5, 'F');
      
      doc.setTextColor(255, 255, 255);
      doc.setFontSize(32);
      doc.text(`${result.score} / ${result.total_marks}`, 105, 115, { align: 'center' });
      doc.setFontSize(16);
      doc.text(`${result.percentage.toFixed(1)}%`, 105, 130, { align: 'center' });
      
      // Status
      doc.setTextColor(0, 0, 0);
      doc.setFontSize(20);
      doc.text(passed ? 'PASSED' : 'FAILED', 105, 160, { align: 'center' });
      
      // Grade
      doc.setFontSize(16);
      doc.text(`Grade: ${getGradeLabel(result.percentage)}`, 105, 175, { align: 'center' });
      
      // Passing mark info
      doc.setFontSize(12);
      doc.setTextColor(100, 100, 100);
      doc.text(`Passing Score: ${result.passing_marks}`, 105, 190, { align: 'center' });
      
      // Footer
      doc.setFontSize(10);
      doc.text('Al-Qaed Educational Platform', 105, 280, { align: 'center' });
      
      // Save
      doc.save(`exam-result-${result.exam_title.replace(/\s+/g, '-')}.pdf`);
      
      toast({
        title: "تم التحميل",
        description: "تم تحميل شهادة نتيجة الامتحان بنجاح",
      });
    } catch (error) {
      console.error('PDF generation error:', error);
      toast({
        variant: "destructive",
        title: "خطأ",
        description: "فشل إنشاء ملف PDF",
      });
    } finally {
      setGeneratingPDF(null);
    }
  };

  if (loading) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-background via-background to-primary/5">
        <StudentHeader />
        <FloatingParticles />
        <div className="container mx-auto px-4 py-12 flex items-center justify-center min-h-[60vh]">
          <motion.div
            initial={{ opacity: 0, scale: 0.9 }}
            animate={{ opacity: 1, scale: 1 }}
            className="text-center"
          >
            <Clock className="w-16 h-16 mx-auto mb-4 text-primary animate-spin" />
            <p className="text-lg font-medium">جاري تحميل النتائج...</p>
          </motion.div>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gradient-to-br from-background via-background to-primary/5" dir="rtl">
      <StudentHeader />
      <FloatingParticles />

      <div className="container mx-auto px-4 py-6 md:py-8 lg:py-12 relative z-10">
        {/* Header */}
        <motion.div
          initial={{ opacity: 0, y: -20 }}
          animate={{ opacity: 1, y: 0 }}
          className="mb-6 md:mb-8"
        >
          <div className="flex items-center gap-3 mb-4">
            <div className="p-3 bg-gradient-to-br from-primary/20 to-accent/20 rounded-xl">
              <Trophy className="w-8 h-8 text-primary" />
            </div>
            <div>
              <h1 className="text-2xl md:text-3xl lg:text-4xl font-bold">نتائج الامتحانات</h1>
              <p className="text-muted-foreground text-sm md:text-base">سجل أدائك في جميع الامتحانات</p>
            </div>
          </div>
        </motion.div>

        {/* Statistics Cards */}
        {examResults.length > 0 && (
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 mb-6 md:mb-8"
          >
            <Card className="bg-gradient-to-br from-blue-500/10 to-cyan-500/10 border-blue-500/20">
              <CardContent className="pt-6">
                <div className="flex items-center justify-between">
                  <div>
                    <p className="text-sm text-muted-foreground mb-1">إجمالي الامتحانات</p>
                    <p className="text-3xl font-bold text-blue-600">{totalExams}</p>
                  </div>
                  <FileText className="w-12 h-12 text-blue-500 opacity-50" />
                </div>
              </CardContent>
            </Card>

            <Card className="bg-gradient-to-br from-green-500/10 to-emerald-500/10 border-green-500/20">
              <CardContent className="pt-6">
                <div className="flex items-center justify-between">
                  <div>
                    <p className="text-sm text-muted-foreground mb-1">امتحانات ناجحة</p>
                    <p className="text-3xl font-bold text-green-600">{passedExams}</p>
                  </div>
                  <CheckCircle2 className="w-12 h-12 text-green-500 opacity-50" />
                </div>
              </CardContent>
            </Card>

            <Card className="bg-gradient-to-br from-purple-500/10 to-pink-500/10 border-purple-500/20">
              <CardContent className="pt-6">
                <div className="flex items-center justify-between">
                  <div>
                    <p className="text-sm text-muted-foreground mb-1">المعدل العام</p>
                    <p className="text-3xl font-bold text-purple-600">{averageScore.toFixed(1)}%</p>
                  </div>
                  <TrendingUp className="w-12 h-12 text-purple-500 opacity-50" />
                </div>
              </CardContent>
            </Card>

            <Card className="bg-gradient-to-br from-orange-500/10 to-yellow-500/10 border-orange-500/20">
              <CardContent className="pt-6">
                <div className="flex items-center justify-between">
                  <div>
                    <p className="text-sm text-muted-foreground mb-1">معدل النجاح</p>
                    <p className="text-3xl font-bold text-orange-600">
                      {totalExams > 0 ? ((passedExams / totalExams) * 100).toFixed(0) : 0}%
                    </p>
                  </div>
                  <Award className="w-12 h-12 text-orange-500 opacity-50" />
                </div>
              </CardContent>
            </Card>
          </motion.div>
        )}

        {/* Exam Results List */}
        {examResults.length > 0 ? (
          <AnimatePresence>
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4 md:gap-6">
              {examResults.map((result, index) => (
                <motion.div
                  key={result.id}
                  initial={{ opacity: 0, y: 20 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ delay: index * 0.1 }}
                >
                  <Card className={`relative overflow-hidden border-2 ${result.passed ? 'border-green-500/30 bg-gradient-to-br from-green-500/5 to-emerald-500/5' : 'border-red-500/30 bg-gradient-to-br from-red-500/5 to-pink-500/5'} hover:shadow-xl transition-all duration-300`}>
                    {/* Status Badge */}
                    <div className="absolute top-3 left-3">
                      {result.passed ? (
                        <Badge className="bg-gradient-to-r from-green-500 to-emerald-500 text-white border-0">
                          ✓ ناجح
                        </Badge>
                      ) : (
                        <Badge className="bg-gradient-to-r from-red-500 to-pink-500 text-white border-0">
                          ✗ راسب
                        </Badge>
                      )}
                    </div>

                    <CardHeader className="pb-3">
                      <div className="flex items-start gap-3 mt-6">
                        <div className={`p-2 rounded-lg bg-gradient-to-br ${result.passed ? 'from-green-500/20 to-emerald-500/20' : 'from-red-500/20 to-pink-500/20'}`}>
                          {result.passed ? (
                            <CheckCircle2 className="w-6 h-6 text-green-600" />
                          ) : (
                            <XCircle className="w-6 h-6 text-red-600" />
                          )}
                        </div>
                        <div className="flex-1">
                          <CardTitle className="text-lg mb-1">{result.exam_title}</CardTitle>
                          <div className="flex items-center gap-2 text-xs text-muted-foreground">
                            <Calendar className="w-3 h-3" />
                            {new Date(result.attempted_at).toLocaleDateString('ar-EG', {
                              year: 'numeric',
                              month: 'long',
                              day: 'numeric'
                            })}
                          </div>
                        </div>
                      </div>
                    </CardHeader>

                    <CardContent className="space-y-4">
                      {/* Score Display */}
                      <div className="text-center py-4 bg-muted/30 rounded-lg">
                        <p className="text-sm text-muted-foreground mb-2">الدرجة</p>
                        <div className="flex items-center justify-center gap-2">
                          <span className={`text-4xl font-bold ${result.passed ? 'text-green-600' : 'text-red-600'}`}>
                            {result.score}
                          </span>
                          <span className="text-2xl text-muted-foreground">/ {result.total_marks}</span>
                        </div>
                      </div>

                      {/* Percentage & Grade */}
                      <div className="flex items-center justify-between">
                        <div className="text-center flex-1">
                          <p className="text-xs text-muted-foreground mb-1">النسبة المئوية</p>
                          <p className="text-2xl font-bold">{result.percentage.toFixed(1)}%</p>
                        </div>
                        <div className="text-center flex-1">
                          <p className="text-xs text-muted-foreground mb-1">التقدير</p>
                          <Badge className={`bg-gradient-to-r ${getGradeColor(result.percentage)} text-white border-0 text-sm px-3 py-1`}>
                            {getGradeLabel(result.percentage)}
                          </Badge>
                        </div>
                      </div>

                      {/* Passing Mark Info */}
                      <div className="text-center text-xs text-muted-foreground pt-2 border-t">
                        درجة النجاح: {result.passing_marks}
                      </div>

                      {/* Download PDF Button */}
                      <Button
                        onClick={() => generateResultPDF(result)}
                        disabled={generatingPDF === result.id}
                        className="w-full mt-3 bg-gradient-to-r from-blue-600 to-indigo-600 hover:from-blue-700 hover:to-indigo-700"
                      >
                        {generatingPDF === result.id ? (
                          <Clock className="w-4 h-4 ml-2 animate-spin" />
                        ) : (
                          <Download className="w-4 h-4 ml-2" />
                        )}
                        {generatingPDF === result.id ? 'جاري التحميل...' : 'تحميل النتيجة PDF'}
                      </Button>
                    </CardContent>
                  </Card>
                </motion.div>
              ))}
            </div>
          </AnimatePresence>
        ) : (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            className="text-center py-12"
          >
            <Card className="max-w-md mx-auto">
              <CardContent className="pt-12 pb-12">
                <Trophy className="w-16 h-16 mx-auto mb-4 text-muted-foreground opacity-50" />
                <h3 className="text-xl font-bold mb-2">لا توجد نتائج بعد</h3>
                <p className="text-muted-foreground">لم تقم بحل أي امتحان حتى الآن</p>
              </CardContent>
            </Card>
          </motion.div>
        )}
      </div>
    </div>
  );
};

export default StudentExamResults;
