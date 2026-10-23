import { useState, useEffect, useRef } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Trophy, CheckCircle2, XCircle, Clock, Calendar, FileText, TrendingUp, Award, Eye } from "lucide-react";
import { Button } from "@/components/ui/button";
import StudentHeader from "@/components/StudentHeader";
import { useNavigate } from "react-router-dom";
import { useToast } from "@/hooks/use-toast";
import { motion, AnimatePresence } from "framer-motion";
import { FloatingParticles } from "@/components/FloatingParticles";
import { useScreenRecordingPrevention } from "@/hooks/useScreenRecordingPrevention";

// Vite injects `import.meta.env` at build time; it is absent when this module
// is imported outside Vite (isolated Node tests), so guard the read and fall
// back to the nginx-proxied relative path.
const readApiBase = (): string => {
  try {
    return import.meta.env.VITE_API_URL || '/api';
  } catch {
    return '/api';
  }
};

const API_BASE_URL = readApiBase();

export interface ExamResult {
  id: string;
  exam_id: string;
  exam_title: string;
  score: number;
  total_marks: number;
  passing_marks: number;
  passed: boolean;
  status?: 'pending_review' | 'passed' | 'failed';  // ✅ Status from backend
  attempted_at: string;
  percentage: number;
}

export type FetchOutcome = 'ok' | 'unauthorized' | 'forbidden' | 'error';

/**
 * Maps an HTTP status to a page outcome. 401 (missing/expired session) and 403
 * (wrong role / no permission) must be handled separately from generic
 * failures, so the page never renders an empty-results state for an
 * authentication or permission problem.
 */
export const classifyFetchOutcome = (status: number): FetchOutcome => {
  if (status === 401) return 'unauthorized';
  if (status === 403) return 'forbidden';
  if (status >= 200 && status < 300) return 'ok';
  return 'error';
};

/**
 * Normalizes one backend result row. The server stays authoritative: the
 * `status` field is taken from the payload when present and only derived from
 * the score when the backend omits it.
 */
export const normalizeExamResult = (result: any): ExamResult => {
  const score = result.score || 0;
  const totalMarks = result.total_marks || result.exam?.total_marks || 0;
  const passingMarks = result.passing_marks || result.exam?.passing_marks || 0;
  const percentage = totalMarks > 0 ? (score / totalMarks) * 100 : 0;
  const status = result.status || (score >= passingMarks ? 'passed' : 'failed');
  return {
    id: result.id,
    exam_id: result.exam_id,
    exam_title: result.exam_title || result.exam?.title || 'امتحان',
    score,
    total_marks: totalMarks,
    passing_marks: passingMarks,
    passed: status === 'passed',
    status: status as 'pending_review' | 'passed' | 'failed',
    attempted_at: result.attempted_at || result.created_at,
    percentage,
  };
};

export const sortResultsByDate = (results: ExamResult[]): ExamResult[] =>
  [...results].sort((a, b) => new Date(b.attempted_at).getTime() - new Date(a.attempted_at).getTime());

/**
 * Thrown when a protected request is attempted without a stored session token.
 * Callers fail closed (redirect to /auth) instead of sending an unauthenticated
 * request that the strict-auth backend rejects with 401.
 */
export class MissingAuthTokenError extends Error {
  constructor() {
    super('Missing auth token');
    this.name = 'MissingAuthTokenError';
  }
}

/**
 * Performs a protected request with the canonical session bearer token attached,
 * reading the same `authToken` localStorage key as the shared transport so the
 * strict-auth backend accepts the request. Throws MissingAuthTokenError when no
 * token is stored, so no unauthenticated request is ever fired.
 */
export const authedFetch = async (url: string, init: RequestInit = {}): Promise<Response> => {
  let token: string | null = null;
  try {
    token = localStorage.getItem('authToken');
  } catch {
    token = null;
  }
  if (!token) throw new MissingAuthTokenError();
  const headers = new Headers(init.headers);
  headers.set('Authorization', `Bearer ${token}`);
  return fetch(url, { ...init, headers });
};

const StudentExamResults = () => {
  useScreenRecordingPrevention(); // Prevent screen recording & screenshots
  const [examResults, setExamResults] = useState<ExamResult[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [studentId, setStudentId] = useState<string>('');
  // Monotonic sequence so a slow in-flight response can never overwrite a newer one
  const loadSeqRef = useRef(0);

  const navigate = useNavigate();
  const { toast } = useToast();

  useEffect(() => {
    fetchExamResults();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const fetchExamResults = async () => {
    const requestSeq = ++loadSeqRef.current;
    setLoading(true);
    setError(null);
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
        return;
      }

      const currentStudentId = user.id;
      setStudentId(currentStudentId);

      // Fetch exam results from backend with the canonical session bearer
      let response: Response;
      try {
        response = await authedFetch(`${API_BASE_URL}/exam-results/student/${currentStudentId}`, {
          headers: {
            'Content-Type': 'application/json',
          },
        });
      } catch (authErr) {
        if (authErr instanceof MissingAuthTokenError) {
          navigate('/auth');
          return;
        }
        throw authErr;
      }

      if (requestSeq !== loadSeqRef.current) return; // stale response — a newer load superseded this one

      const outcome = classifyFetchOutcome(response.status);
      if (outcome === 'unauthorized') {
        navigate('/auth');
        return;
      }
      if (outcome === 'forbidden') {
        setError('ليست لديك صلاحية لعرض هذه النتائج');
        toast({
          variant: "destructive",
          title: "غير مسموح",
          description: "ليست لديك صلاحية لعرض هذه النتائج",
        });
        return;
      }
      if (outcome !== 'ok') {
        throw new Error(`Failed to fetch exam results (${response.status})`);
      }

      const data = await response.json();
      if (requestSeq !== loadSeqRef.current) return;

      // Server-authoritative normalization; newest attempt first.
      setExamResults(sortResultsByDate((data || []).map(normalizeExamResult)));
    } catch (err) {
      if (requestSeq !== loadSeqRef.current) return;
      console.error('Error fetching exam results:', err);
      setError('فشل تحميل نتائج الامتحانات');
      toast({
        variant: "destructive",
        title: "خطأ",
        description: "فشل تحميل نتائج الامتحانات",
      });
    } finally {
      if (requestSeq === loadSeqRef.current) setLoading(false);
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

  // Filter out pending results for statistics
  const gradedResults = examResults.filter(r => r.status !== 'pending_review');
  const pendingResults = examResults.filter(r => r.status === 'pending_review');

  const averageScore = gradedResults.length > 0
    ? gradedResults.reduce((sum, result) => sum + result.percentage, 0) / gradedResults.length
    : 0;

  const passedExams = gradedResults.filter(r => r.passed).length;
  const totalExams = examResults.length;
  const totalGraded = gradedResults.length;

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

  // A failed load must never be shown as the "no results yet" empty state.
  if (error && examResults.length === 0) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-background via-background to-primary/5">
        <StudentHeader />
        <FloatingParticles />
        <div className="container mx-auto px-4 py-12 flex items-center justify-center min-h-[60vh]">
          <Card className="max-w-md mx-auto">
            <CardContent className="pt-12 pb-12 text-center">
              <XCircle className="w-16 h-16 mx-auto mb-4 text-red-500" />
              <h3 className="text-xl font-bold mb-2">تعذر تحميل النتائج</h3>
              <p className="text-muted-foreground mb-6">{error}</p>
              <Button
                onClick={() => fetchExamResults()}
                className="bg-gradient-to-r from-primary to-accent hover:opacity-90"
              >
                إعادة المحاولة
              </Button>
            </CardContent>
          </Card>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gradient-to-br from-background via-background to-primary/5 overflow-x-hidden" dir="rtl">
      <StudentHeader />
      <FloatingParticles />

      <div className="w-full px-3 xs:px-4 sm:px-6 md:px-8 lg:px-12 xl:px-16 py-4 sm:py-6 md:py-8 lg:py-12 relative z-10 max-w-[100vw]">
        {/* Header */}
        <motion.div
          initial={{ opacity: 0, y: -20 }}
          animate={{ opacity: 1, y: 0 }}
          className="mb-4 sm:mb-6 md:mb-8"
        >
          <div className="flex items-center gap-2 sm:gap-3 mb-3 sm:mb-4">
            <div className="p-2 sm:p-3 bg-gradient-to-br from-primary/20 to-accent/20 rounded-lg sm:rounded-xl flex-shrink-0">
              <Trophy className="w-6 h-6 sm:w-8 sm:h-8 text-primary" />
            </div>
            <div className="min-w-0 flex-1">
              <h1 className="text-lg sm:text-xl md:text-2xl lg:text-3xl font-bold truncate">نتائج الامتحانات</h1>
              <p className="text-muted-foreground text-xs sm:text-sm md:text-base truncate">سجل أدائك في جميع الامتحانات</p>
            </div>
          </div>
        </motion.div>

        {/* Statistics Cards */}
        {examResults.length > 0 && (
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            className="grid grid-cols-2 lg:grid-cols-4 gap-2 sm:gap-3 md:gap-4 mb-4 sm:mb-6 md:mb-8"
          >
            <Card className="bg-gradient-to-br from-blue-500/10 to-cyan-500/10 border-blue-500/20">
              <CardContent className="p-3 sm:p-4 md:pt-6">
                <div className="flex items-center justify-between gap-2">
                  <div className="min-w-0 flex-1">
                    <p className="text-[10px] sm:text-xs md:text-sm text-muted-foreground mb-0.5 sm:mb-1 truncate">إجمالي الامتحانات</p>
                    <p className="text-xl sm:text-2xl md:text-3xl font-bold text-blue-600">{totalExams}</p>
                  </div>
                  <FileText className="w-8 h-8 sm:w-10 sm:h-10 md:w-12 md:h-12 text-blue-500 opacity-50 flex-shrink-0" />
                </div>
              </CardContent>
            </Card>

            <Card className="bg-gradient-to-br from-green-500/10 to-emerald-500/10 border-green-500/20">
              <CardContent className="p-3 sm:p-4 md:pt-6">
                <div className="flex items-center justify-between gap-2">
                  <div className="min-w-0 flex-1">
                    <p className="text-[10px] sm:text-xs md:text-sm text-muted-foreground mb-0.5 sm:mb-1 truncate">امتحانات ناجحة</p>
                    <p className="text-xl sm:text-2xl md:text-3xl font-bold text-green-600">{passedExams}</p>
                  </div>
                  <CheckCircle2 className="w-8 h-8 sm:w-10 sm:h-10 md:w-12 md:h-12 text-green-500 opacity-50 flex-shrink-0" />
                </div>
              </CardContent>
            </Card>

            <Card className="bg-gradient-to-br from-purple-500/10 to-pink-500/10 border-purple-500/20">
              <CardContent className="p-3 sm:p-4 md:pt-6">
                <div className="flex items-center justify-between gap-2">
                  <div className="min-w-0 flex-1">
                    <p className="text-[10px] sm:text-xs md:text-sm text-muted-foreground mb-0.5 sm:mb-1 truncate">المعدل العام</p>
                    <p className="text-xl sm:text-2xl md:text-3xl font-bold text-purple-600">{averageScore.toFixed(1)}%</p>
                  </div>
                  <TrendingUp className="w-8 h-8 sm:w-10 sm:h-10 md:w-12 md:h-12 text-purple-500 opacity-50 flex-shrink-0" />
                </div>
              </CardContent>
            </Card>

            <Card className="bg-gradient-to-br from-orange-500/10 to-yellow-500/10 border-orange-500/20">
              <CardContent className="p-3 sm:p-4 md:pt-6">
                <div className="flex items-center justify-between gap-2">
                  <div className="min-w-0 flex-1">
                    <p className="text-[10px] sm:text-xs md:text-sm text-muted-foreground mb-0.5 sm:mb-1 truncate">معدل النجاح</p>
                    <p className="text-xl sm:text-2xl md:text-3xl font-bold text-orange-600">
                      {totalGraded > 0 ? ((passedExams / totalGraded) * 100).toFixed(0) : 0}%
                    </p>
                  </div>
                  <Award className="w-8 h-8 sm:w-10 sm:h-10 md:w-12 md:h-12 text-orange-500 opacity-50 flex-shrink-0" />
                </div>
              </CardContent>
            </Card>

            {pendingResults.length > 0 && (
              <Card className="bg-gradient-to-br from-blue-500/10 to-indigo-500/10 border-blue-500/20">
                <CardContent className="p-3 sm:p-4 md:pt-6">
                  <div className="flex items-center justify-between gap-2">
                    <div className="min-w-0 flex-1">
                      <p className="text-[10px] sm:text-xs md:text-sm text-muted-foreground mb-0.5 sm:mb-1 truncate">قيد المراجعة</p>
                      <p className="text-xl sm:text-2xl md:text-3xl font-bold text-blue-600">{pendingResults.length}</p>
                    </div>
                    <Clock className="w-8 h-8 sm:w-10 sm:h-10 md:w-12 md:h-12 text-blue-500 opacity-50 flex-shrink-0" />
                  </div>
                </CardContent>
              </Card>
            )}

          </motion.div>
        )}

        {/* Exam Results List */}
        {examResults.length > 0 ? (
          <AnimatePresence>
            <div className="grid grid-cols-1 xs:grid-cols-1 sm:grid-cols-2 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-3 2xl:grid-cols-4 gap-3 sm:gap-4 md:gap-5 lg:gap-6">
              {examResults.map((result, index) => (
                <motion.div
                  key={result.id}
                  initial={{ opacity: 0, y: 20 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ delay: index * 0.1 }}
                >
                  <Card className={`relative overflow-hidden border-2 ${result.status === 'pending_review'
                    ? 'border-blue-500/30 bg-gradient-to-br from-blue-500/5 to-indigo-500/5'
                    : result.passed
                      ? 'border-green-500/30 bg-gradient-to-br from-green-500/5 to-emerald-500/5'
                      : 'border-red-500/30 bg-gradient-to-br from-red-500/5 to-pink-500/5'
                    } hover:shadow-xl transition-all duration-300`}>
                    {/* Status Badge */}
                    <div className="absolute top-2 sm:top-3 left-2 sm:left-3 z-10">
                      {result.status === 'pending_review' ? (
                        <Badge className="bg-gradient-to-r from-blue-500 to-indigo-500 text-white border-0 text-[10px] sm:text-xs px-2 py-0.5">
                          ⏳ قيد المراجعة
                        </Badge>
                      ) : result.passed ? (
                        <Badge className="bg-gradient-to-r from-green-500 to-emerald-500 text-white border-0 text-[10px] sm:text-xs px-2 py-0.5">
                          ✓ ناجح
                        </Badge>
                      ) : null}
                    </div>

                    <CardHeader className="pb-2 sm:pb-3 px-3 sm:px-6 pt-8 sm:pt-10">
                      <div className="flex items-start gap-2 sm:gap-3">
                        <div className={`p-1.5 sm:p-2 rounded-lg bg-gradient-to-br flex-shrink-0 ${result.status === 'pending_review'
                          ? 'from-blue-500/20 to-indigo-500/20'
                          : result.passed
                            ? 'from-green-500/20 to-emerald-500/20'
                            : 'from-red-500/20 to-pink-500/20'
                          }`}>
                          {result.status === 'pending_review' ? (
                            <Clock className="w-4 h-4 sm:w-5 sm:h-5 md:w-6 md:h-6 text-blue-600" />
                          ) : result.passed ? (
                            <CheckCircle2 className="w-4 h-4 sm:w-5 sm:h-5 md:w-6 md:h-6 text-green-600" />
                          ) : (
                            <XCircle className="w-4 h-4 sm:w-5 sm:h-5 md:w-6 md:h-6 text-red-600" />
                          )}
                        </div>
                        <div className="flex-1 min-w-0">
                          <CardTitle className="text-sm sm:text-base md:text-lg mb-1 truncate">{result.exam_title}</CardTitle>
                          <div className="flex items-center gap-1 sm:gap-2 text-[10px] sm:text-xs text-muted-foreground">
                            <Calendar className="w-3 h-3 flex-shrink-0" />
                            <span className="truncate">{new Date(result.attempted_at).toLocaleDateString('ar-EG', {
                              year: 'numeric',
                              month: 'short',
                              day: 'numeric'
                            })}</span>
                          </div>
                        </div>
                      </div>
                    </CardHeader>

                    <CardContent className="space-y-3 sm:space-y-4 px-3 sm:px-6 pb-3 sm:pb-6">
                      {/* Score Display */}
                      {result.status === 'pending_review' ? (
                        <div className="text-center py-3 sm:py-4 bg-blue-50 dark:bg-blue-900/10 rounded-lg border border-blue-200 dark:border-blue-800">
                          <Clock className="w-6 h-6 sm:w-7 sm:h-7 md:w-8 md:h-8 mx-auto mb-2 text-blue-600" />
                          <p className="text-xs sm:text-sm font-medium text-blue-700 dark:text-blue-400 mb-1 px-2">
                            قيد المراجعة
                          </p>
                          <p className="text-[10px] sm:text-xs text-muted-foreground px-2">
                            سيتم إعلان النتيجة النهائية قريباً
                          </p>
                          <div className="mt-2 sm:mt-3 pt-2 sm:pt-3 border-t border-blue-200 dark:border-blue-800">
                            <p className="text-[10px] sm:text-xs text-muted-foreground mb-1">الدرجة المبدئية</p>
                            <p className="text-xl sm:text-2xl font-bold text-blue-600">
                              {result.score} / {result.total_marks}
                            </p>
                          </div>
                        </div>
                      ) : (
                        <div className="text-center py-3 sm:py-4 bg-muted/30 rounded-lg">
                          <p className="text-xs sm:text-sm text-muted-foreground mb-1 sm:mb-2">الدرجة</p>
                          <div className="flex items-center justify-center gap-1 sm:gap-2">
                            <span className={`text-2xl sm:text-3xl md:text-4xl font-bold ${result.passed ? 'text-green-600' : 'text-red-600'}`}>
                              {result.score}
                            </span>
                            <span className="text-lg sm:text-xl md:text-2xl text-muted-foreground">/ {result.total_marks}</span>
                          </div>
                        </div>
                      )}

                      {/* Percentage & Grade - Only show if not pending */}
                      {result.status !== 'pending_review' && (
                        <>
                          <div className="flex items-center justify-between gap-2">
                            <div className="text-center flex-1 min-w-0">
                              <p className="text-[10px] sm:text-xs text-muted-foreground mb-0.5 sm:mb-1 truncate">النسبة المئوية</p>
                              <p className="text-lg sm:text-xl md:text-2xl font-bold">{result.percentage.toFixed(1)}%</p>
                            </div>
                            <div className="text-center flex-1 min-w-0">
                              <p className="text-[10px] sm:text-xs text-muted-foreground mb-0.5 sm:mb-1 truncate">التقدير</p>
                              <Badge className={`bg-gradient-to-r ${getGradeColor(result.percentage)} text-white border-0 text-xs sm:text-sm px-2 sm:px-3 py-0.5 sm:py-1`}>
                                {getGradeLabel(result.percentage)}
                              </Badge>
                            </div>
                          </div>

                          {/* Passing Mark Info */}
                          <div className="text-center text-[10px] sm:text-xs text-muted-foreground pt-1.5 sm:pt-2 border-t">
                            درجة النجاح: {result.passing_marks}
                          </div>
                        </>
                      )}

                      {/* View Details Button */}
                      <Button
                        onClick={() => navigate(`/exam-review/${result.exam_id}`)}
                        className="w-full mt-2 sm:mt-3 md:mt-4 bg-gradient-to-r from-primary to-accent hover:opacity-90 text-xs sm:text-sm h-8 sm:h-9 md:h-10"
                      >
                        <Eye className="w-3.5 h-3.5 sm:w-4 sm:h-4 ml-1 sm:ml-2" />
                        عرض التفاصيل
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
