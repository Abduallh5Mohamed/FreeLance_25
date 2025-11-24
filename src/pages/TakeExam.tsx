import { useState, useEffect, useCallback } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Label } from "@/components/ui/label";
import { Clock, AlertCircle, CheckCircle2, XCircle, Trophy, Timer } from "lucide-react";
import { useParams, useNavigate } from "react-router-dom";
import { useToast } from "@/hooks/use-toast";
import { motion, AnimatePresence } from "framer-motion";
import { FloatingParticles } from "@/components/FloatingParticles";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { getExamById, getExamQuestions, canAttemptExam, startExamAttempt, submitExamAttempt } from "@/lib/api";

interface Question {
  id: string;
  question_text?: string;
  question?: string;
  options?: string | string[];
  correct_answer?: string | number;
  correctAnswer?: number;
  marks?: number;
  points?: number;
  display_order?: number;
}

interface ExamData {
  id: string;
  title: string;
  course_id?: string;
  course?: string;
  duration_minutes?: number;
  duration?: number;
  total_marks?: number;
  totalMarks?: number;
  passing_marks?: number;
  passingMarks?: number;
  start_time?: Date;
  end_time?: Date;
  questions: Question[];
}

const TakeExam = () => {
  const { examId } = useParams();
  const navigate = useNavigate();
  const { toast } = useToast();

  const [exam, setExam] = useState<ExamData | null>(null);
  const [answers, setAnswers] = useState<Record<string, number>>({});
  const [timeLeft, setTimeLeft] = useState(0); // in seconds
  const [isSubmitted, setIsSubmitted] = useState(false);
  const [loading, setLoading] = useState(true);
  const [result, setResult] = useState<{ score: number; total: number; percentage: number; passed: boolean } | null>(null);
  const [currentQuestion, setCurrentQuestion] = useState(0);
  const [canAttempt, setCanAttempt] = useState(true);
  const [attemptMessage, setAttemptMessage] = useState('');
  const [attemptResult, setAttemptResult] = useState<{ score: number; total: number; passed: boolean; passingMarks: number } | null>(null);
  const [examStartTime, setExamStartTime] = useState<Date | null>(null);
  const [studentId, setStudentId] = useState<string>('');

  // Sample exam data - replace with real API call
  const sampleExam: ExamData = {
    id: examId || '1',
    title: 'امتحان الحرب العالمية الأولى',
    course: 'التاريخ الحديث',
    duration: 60, // 60 minutes
    totalMarks: 50,
    passingMarks: 30,
    questions: [
      {
        id: 'q1',
        question: 'في أي عام بدأت الحرب العالمية الأولى؟',
        options: ['1912', '1914', '1916', '1918'],
        correctAnswer: 1,
        points: 2
      },
      {
        id: 'q2',
        question: 'ما هي الدولة التي انضمت للحلفاء عام 1917؟',
        options: ['ألمانيا', 'إيطاليا', 'الولايات المتحدة', 'اليابان'],
        correctAnswer: 2,
        points: 2
      },
      {
        id: 'q3',
        question: 'من كان قائد القوات البريطانية في الحرب العالمية الأولى؟',
        options: ['ونستون تشرشل', 'دوغلاس هيغ', 'برنارد مونتغمري', 'آرثر ويلينغتون'],
        correctAnswer: 1,
        points: 2
      },
      {
        id: 'q4',
        question: 'ما اسم المعاهدة التي أنهت الحرب العالمية الأولى؟',
        options: ['معاهدة لوزان', 'معاهدة فرساي', 'معاهدة سيفر', 'معاهدة فيينا'],
        correctAnswer: 1,
        points: 2
      },
      {
        id: 'q5',
        question: 'ما هو السبب المباشر لاندلاع الحرب العالمية الأولى؟',
        options: [
          'الأزمة المغربية',
          'اغتيال ولي عهد النمسا',
          'غزو بولندا',
          'الثورة البلشفية'
        ],
        correctAnswer: 1,
        points: 2
      },
      {
        id: 'q6',
        question: 'كم دولة شاركت في الحرب العالمية الأولى تقريباً؟',
        options: ['15 دولة', '25 دولة', '30 دولة', '40 دولة'],
        correctAnswer: 2,
        points: 2
      },
      {
        id: 'q7',
        question: 'ما هي الدولة التي انسحبت من الحرب عام 1917؟',
        options: ['فرنسا', 'روسيا', 'إيطاليا', 'بلجيكا'],
        correctAnswer: 1,
        points: 2
      },
      {
        id: 'q8',
        question: 'في أي مدينة تم توقيع معاهدة السلام؟',
        options: ['لندن', 'برلين', 'باريس', 'فيينا'],
        correctAnswer: 2,
        points: 2
      }
    ]
  };

  useEffect(() => {
    const loadExamData = async () => {
      try {
        if (!examId) return;

        // Get student ID from localStorage
        const userStr = localStorage.getItem('currentUser');
        const studentStr = localStorage.getItem('currentStudent');
        if (!userStr) {
          toast({ title: 'خطأ', description: 'يجب تسجيل الدخول أولاً', variant: 'destructive' });
          navigate('/auth');
          return;
        }
        const user = JSON.parse(userStr);
        const studentObj = studentStr ? JSON.parse(studentStr) : null;
        // Prefer explicit student record id; fallback to user.student_id; final fallback to user.id (may fail backend if not enrolled)
        const currentStudentId = studentObj?.id || user.student_id || user.id;
        if (!currentStudentId) {
          toast({ title: 'خطأ', description: 'لا يمكن تحديد هوية الطالب. يرجى إعادة تسجيل الدخول.', variant: 'destructive' });
          navigate('/student-exams');
          return;
        }
        setStudentId(currentStudentId);

        // Check if student can attempt this exam
        const attemptCheck = await canAttemptExam(examId, currentStudentId);
        console.log('🔍 Can attempt check:', attemptCheck);

        if (!attemptCheck.canAttempt) {
          setCanAttempt(false);
          setAttemptMessage(attemptCheck.message || attemptCheck.reason || 'لا يمكنك دخول هذا الامتحان');

          // If already attempted, fetch exam to display summary
          if (attemptCheck.reason === 'already_attempted') {
            try {
              const examData = await getExamById(examId);
              // Fetch questions to derive total marks if missing
              const qs = await getExamQuestions(examId);
              const computedTotal = Array.isArray(qs)
                ? qs.reduce((sum: number, q: any) => sum + (q.marks || q.points || 1), 0)
                : 0;
              const rawTotal = examData.total_marks || examData.totalMarks || computedTotal;
              const rawPassing = examData.passing_marks || examData.passingMarks || 0;
              // Interpret passing as percentage if > total and <=100
              const passingMarks = rawTotal > 0 && rawPassing > rawTotal && rawPassing <= 100
                ? Math.ceil((rawPassing / 100) * rawTotal)
                : rawPassing;
              const existingScore = attemptCheck.score || 0;
              const passed = existingScore >= passingMarks;
              setAttemptResult({ score: existingScore, total: rawTotal, passed, passingMarks });
            } catch (e) {
              console.error('Failed to load exam for attempt summary', e);
            }
          }

          if (attemptCheck.reason === 'not_started' && attemptCheck.startTime) {
            setExamStartTime(new Date(attemptCheck.startTime));
          }

          setLoading(false);
          return;
        }

        // Start exam attempt
        await startExamAttempt(examId, currentStudentId);

        // Load exam details
        console.log('🔍 Loading exam with ID:', examId);
        const examData = await getExamById(examId);
        console.log('📋 Exam data loaded:', examData);

        if (!examData) {
          toast({
            title: 'خطأ',
            description: 'لم يتم العثور على الامتحان',
            variant: 'destructive'
          });
          navigate('/student-exams');
          return;
        }

        // Load exam questions
        console.log('🎯 Fetching questions for exam:', examId);
        const questions = await getExamQuestions(examId);
        console.log('📝 Questions fetched:', questions, 'Count:', Array.isArray(questions) ? questions.length : 0);

        // Convert question options if they're JSON strings
        const processedQuestions = Array.isArray(questions)
          ? (questions).map((q: Question) => {
            console.log('Processing question:', q);
            // Parse options - they come as either string or object from API
            let parsedOptions: string[] = [];
            if (typeof q.options === 'string') {
              try {
                const parsed = JSON.parse(q.options);
                // If options is an object like {a: "option1", b: "option2", ...}, convert to array
                if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
                  parsedOptions = [parsed.a, parsed.b, parsed.c, parsed.d].filter(Boolean);
                } else if (Array.isArray(parsed)) {
                  parsedOptions = parsed;
                }
              } catch (e) {
                console.error('Failed to parse options string:', e);
                parsedOptions = [];
              }
            } else if (typeof q.options === 'object' && !Array.isArray(q.options) && q.options !== null) {
              // Options is already an object {a: "...", b: "...", c: "...", d: "..."}
              const opts = q.options as Record<string, string>;
              parsedOptions = [opts.a, opts.b, opts.c, opts.d].filter(Boolean);
            } else if (Array.isArray(q.options)) {
              parsedOptions = q.options;
            }

            // Convert correct_answer from letter to index if needed
            let correctAnswer: string | number | undefined = q.correct_answer;
            if (typeof correctAnswer === 'string') {
              const letterToIndex = { 'a': 0, 'b': 1, 'c': 2, 'd': 3 };
              correctAnswer = letterToIndex[correctAnswer as keyof typeof letterToIndex];
              if (correctAnswer === undefined) {
                console.warn(`⚠️ Unknown letter for correct_answer: ${q.correct_answer}, defaulting to 0`);
                correctAnswer = 0;
              }
            } else if (typeof correctAnswer === 'number') {
              // Already a number, keep it
            } else {
              console.warn(`⚠️ Unexpected correct_answer type: ${typeof correctAnswer}, value: ${correctAnswer}`);
              correctAnswer = 0;
            }

            console.log(`Q ID: ${q.id}, Original: ${q.correct_answer}, Converted: ${correctAnswer}`);

            console.log('Processed question options:', parsedOptions);

            return {
              ...q,
              options: parsedOptions,
              correct_answer: correctAnswer
            };
          })
          : [];

        console.log('✅ Processed questions:', processedQuestions);

        // Create exam with questions
        const fullExam: ExamData = {
          ...examData,
          questions: processedQuestions
        };

        setExam(fullExam);
        setTimeLeft((examData.duration_minutes || 60) * 60); // Convert to seconds
        setLoading(false);
      } catch (error) {
        console.error('❌ Error loading exam:', error);
        setLoading(false);
        toast({
          title: 'خطأ',
          description: 'فشل تحميل الامتحان',
          variant: 'destructive'
        });
        navigate('/student-exams');
      }
    };

    loadExamData();

    // Prevent page refresh during exam
    const handleBeforeUnload = (e: BeforeUnloadEvent) => {
      if (!isSubmitted) {
        e.preventDefault();
        e.returnValue = '';
      }
    };
    window.addEventListener('beforeunload', handleBeforeUnload);
    return () => window.removeEventListener('beforeunload', handleBeforeUnload);
  }, [examId, navigate, toast, isSubmitted]);

  const handleAnswerChange = (questionId: string, answerIndex: number) => {
    setAnswers(prev => ({
      ...prev,
      [questionId]: answerIndex
    }));
  };

  const calculateScore = useCallback(() => {
    if (!exam) return { score: 0, total: 0, percentage: 0, passed: false };

    let score = 0;
    let correctCount = 0;
    let wrongCount = 0;

    console.log('=== Calculating Score ===');
    console.log('Exam questions:', exam.questions);
    console.log('User answers:', answers);

    exam.questions.forEach((question: Question, idx: number) => {
      const userAnswer = answers[question.id];
      const correctAnswer = question.correct_answer;

      console.log(`Q${idx + 1}: User answered: ${userAnswer}, Correct: ${correctAnswer}, Match: ${userAnswer === correctAnswer}`);

      if (userAnswer === correctAnswer) {
        score += question.marks || question.points || 1;
        correctCount++;
        console.log(`✅ Correct! Score: ${question.marks || question.points || 1}`);
      } else {
        wrongCount++;
        console.log(`❌ Wrong!`);
      }
    });

    // Derive total marks if missing from exam object
    let totalMarks = exam.total_marks || exam.totalMarks || 0;
    if (!totalMarks) {
      totalMarks = exam.questions.reduce((sum, q) => sum + (q.marks || q.points || 1), 0);
    }
    let passingMarks = exam.passing_marks || exam.passingMarks || 0;
    // Interpret passing as percentage (e.g., 50 means 50%) if raw passing > total but <=100
    if (totalMarks > 0 && passingMarks > totalMarks && passingMarks <= 100) {
      passingMarks = Math.ceil((passingMarks / 100) * totalMarks);
    }
    const percentage = totalMarks > 0 ? (score / totalMarks) * 100 : 0;
    const passed = score >= passingMarks;

    console.log(`Final: ${score}/${totalMarks}, Correct: ${correctCount}, Wrong: ${wrongCount}, Passed: ${passed}`);

    return { score, total: totalMarks, percentage, passed };
  }, [exam, answers]);

  const handleSubmit = useCallback(async () => {
    const examResult = calculateScore();
    setResult(examResult);
    setIsSubmitted(true);

    // Submit attempt to backend
    if (examId && studentId) {
      try {
        await submitExamAttempt(examId, studentId, answers, examResult.score);
        console.log('✅ Exam attempt submitted successfully');
      } catch (error) {
        console.error('❌ Failed to submit exam attempt:', error);
      }
    }

    toast({
      title: examResult.passed ? "تهانينا! 🎉" : "للأسف",
      description: examResult.passed
        ? `لقد نجحت بدرجة ${examResult.score}/${examResult.total}`
        : `لم تحصل على درجة النجاح. حصلت على ${examResult.score}/${examResult.total}`,
      variant: examResult.passed ? "default" : "destructive"
    });
  }, [calculateScore, toast, examId, studentId, answers]);

  // Timer countdown
  useEffect(() => {
    if (timeLeft > 0 && !isSubmitted && !loading) {
      const timer = setTimeout(() => setTimeLeft(timeLeft - 1), 1000);
      return () => clearTimeout(timer);
    } else if (timeLeft === 0 && exam && !isSubmitted && !loading) {
      handleSubmit();
    }
  }, [timeLeft, isSubmitted, exam, loading, handleSubmit]);

  const formatTime = (seconds: number) => {
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
  };

  const getTimeColor = () => {
    if (timeLeft > 300) return 'text-green-600'; // > 5 mins
    if (timeLeft > 60) return 'text-yellow-600'; // > 1 min
    return 'text-red-600 animate-pulse'; // < 1 min
  };

  const answeredCount = Object.keys(answers).length;
  const progress = exam ? (answeredCount / exam.questions.length) * 100 : 0;

  if (loading) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-background via-background to-primary/5 flex items-center justify-center">
        <FloatingParticles />
        <motion.div
          initial={{ opacity: 0, scale: 0.9 }}
          animate={{ opacity: 1, scale: 1 }}
          className="text-center"
        >
          <Clock className="w-16 h-16 mx-auto mb-4 text-primary animate-spin" />
          <p className="text-lg font-medium">جاري تحميل الامتحان...</p>
        </motion.div>
      </div>
    );
  }

  // Show message or summary if student can't attempt exam
  if (!canAttempt) {
    // If already attempted show result summary
    if (attemptResult) {
      return (
        <div className="min-h-screen bg-gradient-to-br from-background via-background to-primary/5 flex items-center justify-center p-4">
          <FloatingParticles />
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            className="max-w-md w-full"
          >
            <Card className="shadow-2xl border-2">
              <CardHeader className="text-center pb-4">
                <div className={`mx-auto w-16 h-16 rounded-full flex items-center justify-center mb-4 ${attemptResult.passed ? 'bg-green-100 dark:bg-green-900/20' : 'bg-red-100 dark:bg-red-900/20'}`}>
                  {attemptResult.passed ? (
                    <CheckCircle2 className="w-8 h-8 text-green-600 dark:text-green-500" />
                  ) : (
                    <XCircle className="w-8 h-8 text-red-600 dark:text-red-500" />
                  )}
                </div>
                <CardTitle className="text-2xl">نتيجة الامتحان</CardTitle>
              </CardHeader>
              <CardContent className="text-center space-y-4">
                <p className="text-lg font-semibold">الدرجة: {attemptResult.score} / {attemptResult.total}</p>
                <p className={attemptResult.passed ? 'text-green-600 font-semibold' : 'text-red-600 font-semibold'}>
                  {attemptResult.passed ? 'تم النجاح' : `لم تحصل على درجة النجاح (${attemptResult.passingMarks})`}
                </p>
                <Button
                  onClick={() => navigate('/student-exams')}
                  className="w-full"
                >
                  العودة للامتحانات
                </Button>
              </CardContent>
            </Card>
          </motion.div>
        </div>
      );
    }
    // Generic block view
    return (
      <div className="min-h-screen bg-gradient-to-br from-background via-background to-primary/5 flex items-center justify-center p-4">
        <FloatingParticles />
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          className="max-w-md w-full"
        >
          <Card className="shadow-2xl border-2">
            <CardHeader className="text-center pb-4">
              <div className="mx-auto w-16 h-16 bg-yellow-100 dark:bg-yellow-900/20 rounded-full flex items-center justify-center mb-4">
                <AlertCircle className="w-8 h-8 text-yellow-600 dark:text-yellow-500" />
              </div>
              <CardTitle className="text-2xl">غير متاح</CardTitle>
            </CardHeader>
            <CardContent className="text-center space-y-4">
              <p className="text-lg text-muted-foreground">{attemptMessage}</p>
              {examStartTime && (
                <div className="bg-primary/5 p-4 rounded-lg">
                  <p className="text-sm font-medium mb-2">الامتحان يبدأ في:</p>
                  <p className="text-lg font-bold text-primary">
                    {examStartTime.toLocaleDateString('ar-EG', {
                      weekday: 'long',
                      year: 'numeric',
                      month: 'long',
                      day: 'numeric'
                    })}
                  </p>
                  <p className="text-xl font-bold text-primary mt-2">
                    {examStartTime.toLocaleTimeString('ar-EG', {
                      hour: '2-digit',
                      minute: '2-digit'
                    })}
                  </p>
                </div>
              )}
              <Button
                onClick={() => navigate('/student-exams')}
                className="w-full"
              >
                العودة للامتحانات
              </Button>
            </CardContent>
          </Card>
        </motion.div>
      </div>
    );
  }

  if (!exam) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-background via-background to-primary/5 flex items-center justify-center">
        <Card className="max-w-md">
          <CardContent className="pt-6 text-center">
            <XCircle className="w-16 h-16 mx-auto mb-4 text-destructive" />
            <h2 className="text-xl font-bold mb-2">خطأ في تحميل الامتحان</h2>
            <Button onClick={() => navigate('/student-exams')} className="mt-4">
              العودة للامتحانات
            </Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  if (exam.questions.length === 0) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-background via-background to-primary/5 flex items-center justify-center">
        <Card className="max-w-md">
          <CardContent className="pt-6 text-center">
            <AlertCircle className="w-16 h-16 mx-auto mb-4 text-yellow-600" />
            <h2 className="text-xl font-bold mb-2">لا توجد أسئلة في هذا الامتحان</h2>
            <p className="text-muted-foreground mb-4">يرجى الاتصال بالمعلم لإضافة أسئلة</p>
            <Button onClick={() => navigate('/student-exams')} className="mt-4">
              العودة للامتحانات
            </Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  if (isSubmitted && result) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-background via-background to-primary/5 relative overflow-hidden" dir="rtl">
        <FloatingParticles />
        <div className="container mx-auto px-4 py-12 relative z-10 max-w-3xl">
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
          >
            <Card className={`border-4 ${result.passed ? 'border-green-500' : 'border-red-500'}`}>
              <CardHeader className="text-center pb-8">
                <div className="mx-auto mb-4">
                  {result.passed ? (
                    <motion.div
                      initial={{ scale: 0 }}
                      animate={{ scale: 1 }}
                      transition={{ type: "spring", stiffness: 200 }}
                    >
                      <Trophy className="w-24 h-24 text-green-500 mx-auto" />
                    </motion.div>
                  ) : (
                    <XCircle className="w-24 h-24 text-red-500 mx-auto" />
                  )}
                </div>
                <CardTitle className="text-3xl">
                  {result.passed ? 'نجحت في الامتحان! 🎉' : 'للأسف، لم تنجح'}
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-6">
                {/* Score Display */}
                <div className="text-center">
                  <div className={`text-6xl font-bold mb-2 ${result.passed ? 'text-green-600' : 'text-red-600'}`}>
                    {result.score}/{result.total}
                  </div>
                  <div className="text-2xl font-semibold text-muted-foreground">
                    {result.percentage.toFixed(1)}%
                  </div>
                </div>

                {/* Stats */}
                <div className="grid grid-cols-2 gap-4">
                  <Card className="p-4 text-center">
                    <div className="text-sm text-muted-foreground mb-1">إجابات صحيحة</div>
                    <div className="text-2xl font-bold text-green-600">
                      {exam.questions.filter(q => answers[q.id] === q.correct_answer).length}
                    </div>
                  </Card>
                  <Card className="p-4 text-center">
                    <div className="text-sm text-muted-foreground mb-1">إجابات خاطئة</div>
                    <div className="text-2xl font-bold text-red-600">
                      {exam.questions.filter(q => answers[q.id] !== undefined && answers[q.id] !== q.correct_answer).length}
                    </div>
                  </Card>
                </div>

                {/* Detailed Results */}
                <div className="space-y-4">
                  <h3 className="font-bold text-lg">الإجابات التفصيلية:</h3>
                  {exam.questions.map((question, idx) => {
                    const userAnswer = answers[question.id];
                    const isCorrect = userAnswer === question.correct_answer;
                    const wasAnswered = userAnswer !== undefined;

                    return (
                      <Card key={question.id} className={`p-4 ${isCorrect ? 'border-green-500' : wasAnswered ? 'border-red-500' : 'border-gray-300'}`}>
                        <div className="flex items-start gap-3">
                          <div className="mt-1">
                            {isCorrect ? (
                              <CheckCircle2 className="w-5 h-5 text-green-600" />
                            ) : wasAnswered ? (
                              <XCircle className="w-5 h-5 text-red-600" />
                            ) : (
                              <AlertCircle className="w-5 h-5 text-gray-400" />
                            )}
                          </div>
                          <div className="flex-1">
                            <div className="font-medium mb-2">
                              السؤال {idx + 1}: {question.question_text || question.question}
                            </div>
                            {wasAnswered && (
                              <div className="text-sm space-y-1">
                                <div className={userAnswer === question.correct_answer ? 'text-green-600' : 'text-red-600'}>
                                  إجابتك: {Array.isArray(question.options) ? question.options[userAnswer] : 'خيار غير معروف'}
                                </div>
                                {!isCorrect && (
                                  <div className="text-green-600">
                                    الإجابة الصحيحة: {Array.isArray(question.options) ? question.options[question.correct_answer as number] : 'خيار غير معروف'}
                                  </div>
                                )}
                              </div>
                            )}
                            {!wasAnswered && (
                              <div className="text-sm text-gray-500">
                                لم تجب على هذا السؤال
                              </div>
                            )}
                          </div>
                          <Badge variant={isCorrect ? "default" : "destructive"}>
                            {question.points || question.marks || 1} نقطة
                          </Badge>
                        </div>
                      </Card>
                    );
                  })}
                </div>

                {/* Actions */}
                <div className="flex gap-3">
                  <Button
                    onClick={() => navigate('/student-exams')}
                    className="flex-1"
                    variant="outline"
                  >
                    العودة للامتحانات
                  </Button>
                  <Button
                    onClick={() => navigate('/student')}
                    className="flex-1 bg-gradient-to-r from-primary to-accent"
                  >
                    العودة للرئيسية
                  </Button>
                </div>
              </CardContent>
            </Card>
          </motion.div>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gradient-to-br from-background via-background to-primary/5 relative overflow-hidden" dir="rtl">
      <FloatingParticles />

      {/* Sticky Header with Timer */}
      <div className="sticky top-0 z-50 bg-background/95 backdrop-blur-sm border-b shadow-lg">
        <div className="container mx-auto px-4 py-4">
          <div className="flex items-center justify-between gap-4">
            <div>
              <h1 className="text-xl font-bold">{exam.title}</h1>
              <p className="text-sm text-muted-foreground">{exam.course}</p>
            </div>

            <div className="flex items-center gap-4">
              {/* Progress */}
              <div className="hidden md:flex items-center gap-2">
                <span className="text-sm font-medium">التقدم:</span>
                <div className="w-32">
                  <Progress value={progress} className="h-2" />
                </div>
                <span className="text-sm text-muted-foreground">
                  {answeredCount}/{exam.questions.length}
                </span>
              </div>

              {/* Timer */}
              <Card className={`${getTimeColor()} border-2`}>
                <CardContent className="p-3 flex items-center gap-2">
                  <Timer className="w-5 h-5" />
                  <span className="text-2xl font-mono font-bold">
                    {formatTime(timeLeft)}
                  </span>
                </CardContent>
              </Card>
            </div>
          </div>

          {/* Mobile Progress */}
          <div className="md:hidden mt-3">
            <div className="flex items-center justify-between text-sm mb-1">
              <span>التقدم</span>
              <span>{answeredCount}/{exam.questions.length}</span>
            </div>
            <Progress value={progress} className="h-2" />
          </div>
        </div>
      </div>

      {/* Questions */}
      <div className="container mx-auto px-4 py-6 relative z-10 max-w-4xl">
        <AnimatePresence mode="wait">
          <motion.div
            key={currentQuestion}
            initial={{ opacity: 0, x: 20 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: -20 }}
            transition={{ duration: 0.3 }}
          >
            <Card className="mb-6">
              <CardHeader>
                <div className="flex items-start justify-between gap-4">
                  <div className="flex-1">
                    <div className="flex items-center gap-2 mb-2">
                      <Badge variant="outline">
                        السؤال {currentQuestion + 1} من {exam.questions.length}
                      </Badge>
                      <Badge>
                        {exam.questions[currentQuestion].points || exam.questions[currentQuestion].marks || 1} نقطة
                      </Badge>
                    </div>
                    <CardTitle className="text-xl">
                      {exam.questions[currentQuestion].question_text || exam.questions[currentQuestion].question}
                    </CardTitle>
                  </div>
                </div>
              </CardHeader>
              <CardContent>
                <RadioGroup
                  value={answers[exam.questions[currentQuestion].id]?.toString()}
                  onValueChange={(value) => {
                    console.log(`Selected answer index: ${value} for question: ${exam.questions[currentQuestion].id}`);
                    handleAnswerChange(exam.questions[currentQuestion].id, parseInt(value));
                  }}
                  className="space-y-3"
                >
                  {(() => {
                    const q = exam.questions[currentQuestion];
                    const options = q.options;
                    let optionsArray: string[] = [];

                    console.log(`=== Rendering Question ${currentQuestion + 1} ===`);
                    console.log('Question object:', q);
                    console.log('Correct answer stored:', q.correct_answer, 'Type:', typeof q.correct_answer);

                    if (typeof options === 'string') {
                      try {
                        const parsed = JSON.parse(options);
                        // If it's an object like {a: "...", b: "...", c: "...", d: "..."}, convert to array
                        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
                          optionsArray = [parsed.a, parsed.b, parsed.c, parsed.d].filter(Boolean);
                        } else if (Array.isArray(parsed)) {
                          optionsArray = parsed;
                        }
                      } catch (e) {
                        console.error('Failed to parse options:', e, options);
                        optionsArray = [];
                      }
                    } else if (Array.isArray(options)) {
                      optionsArray = options;
                    }

                    console.log('Rendering options:', optionsArray);

                    if (optionsArray.length === 0) {
                      return <div className="text-center py-8 text-muted-foreground">لا توجد خيارات متاحة</div>;
                    }

                    return optionsArray.map((option: string, idx: number) => (
                      <motion.div
                        key={idx}
                        initial={{ opacity: 0, y: 10 }}
                        animate={{ opacity: 1, y: 0 }}
                        transition={{ delay: idx * 0.1 }}
                      >
                        <Label
                          htmlFor={`option-${idx}`}
                          className={`flex items-center gap-3 p-4 rounded-lg border-2 cursor-pointer transition-all hover:bg-accent ${answers[exam.questions[currentQuestion].id] === idx
                            ? 'border-primary bg-primary/10'
                            : 'border-border'
                            }`}
                        >
                          <RadioGroupItem value={idx.toString()} id={`option-${idx}`} />
                          <span className="flex-1 text-base">{option}</span>
                        </Label>
                      </motion.div>
                    ));
                  })()}
                </RadioGroup>
              </CardContent>
            </Card>

            {/* Navigation */}
            <div className="flex items-center justify-between gap-4">
              <Button
                onClick={() => setCurrentQuestion(Math.max(0, currentQuestion - 1))}
                disabled={currentQuestion === 0}
                variant="outline"
                size="lg"
              >
                السؤال السابق
              </Button>

              <div className="flex gap-2">
                {exam.questions.map((_, idx) => (
                  <button
                    key={idx}
                    onClick={() => setCurrentQuestion(idx)}
                    className={`w-10 h-10 rounded-lg font-medium transition-all ${idx === currentQuestion
                      ? 'bg-primary text-white scale-110'
                      : answers[exam.questions[idx].id] !== undefined
                        ? 'bg-green-500 text-white'
                        : 'bg-muted hover:bg-muted-foreground/20'
                      }`}
                  >
                    {idx + 1}
                  </button>
                ))}
              </div>

              {currentQuestion < exam.questions.length - 1 ? (
                <Button
                  onClick={() => setCurrentQuestion(Math.min(exam.questions.length - 1, currentQuestion + 1))}
                  size="lg"
                  className="bg-gradient-to-r from-primary to-accent"
                >
                  السؤال التالي
                </Button>
              ) : (
                <Button
                  onClick={handleSubmit}
                  size="lg"
                  className="bg-gradient-to-r from-green-600 to-green-500"
                  disabled={answeredCount < exam.questions.length}
                >
                  تسليم الامتحان
                </Button>
              )}
            </div>

            {/* Warning if not all answered */}
            {currentQuestion === exam.questions.length - 1 && answeredCount < exam.questions.length && (
              <motion.div
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                className="mt-4"
              >
                <Card className="border-yellow-500 bg-yellow-500/10">
                  <CardContent className="pt-4 flex items-center gap-2">
                    <AlertCircle className="w-5 h-5 text-yellow-600" />
                    <span className="text-sm">
                      لم تجب على جميع الأسئلة ({answeredCount}/{exam.questions.length}). تأكد من الإجابة على جميع الأسئلة قبل التسليم.
                    </span>
                  </CardContent>
                </Card>
              </motion.div>
            )}
          </motion.div>
        </AnimatePresence>
      </div>
    </div>
  );
};

export default TakeExam;