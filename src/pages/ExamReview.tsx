import { useState, useEffect } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { CheckCircle2, XCircle, FileText, ArrowRight, MessageSquare, Award } from "lucide-react";
import StudentHeader from "@/components/StudentHeader";
import { useToast } from "@/hooks/use-toast";
import { motion } from "framer-motion";
import { FloatingParticles } from "@/components/FloatingParticles";

const API_BASE_URL = import.meta.env.VITE_API_URL || 'http://192.168.1.7:3001/api';

interface Question {
    id: string;
    question_text: string;
    question_image: string | null;
    question_type: 'multiple_choice' | 'essay';
    options: any;
    correct_answer: string | null;
    points: number;
    explanation: string | null;
    student_answer: string | null;
    is_correct: boolean | null;
    essay_grade: {
        score: number;
        feedback: string | null;
        graded_by: string | null;
        graded_at: string | null;
    } | null;
}

interface ReviewData {
    exam: {
        id: string;
        title: string;
        description: string;
        total_marks: number;
        passing_marks: number;
    };
    attempt: {
        status: string;
        score: number;
        started_at: string;
        completed_at: string;
        passed: boolean;
    };
    questions: Question[];
}

const ExamReview = () => {
    const { examId } = useParams<{ examId: string }>();
    const navigate = useNavigate();
    const { toast } = useToast();

    const [reviewData, setReviewData] = useState<ReviewData | null>(null);
    const [loading, setLoading] = useState(true);
    const [studentId, setStudentId] = useState<string>('');

    useEffect(() => {
        fetchReviewData();
    }, [examId]);

    const fetchReviewData = async () => {
        try {
            const userStr = localStorage.getItem('currentUser');
            if (!userStr) {
                navigate('/auth');
                return;
            }

            const user = JSON.parse(userStr);
            if (user.role !== 'student') {
                navigate('/auth');
                return;
            }

            setStudentId(user.id);

            const response = await fetch(`${API_BASE_URL}/exams/${examId}/review/${user.id}`);

            if (!response.ok) {
                throw new Error('Failed to fetch review data');
            }

            const data = await response.json();
            setReviewData(data);
        } catch (error) {
            console.error('Error loading review:', error);
            toast({
                variant: "destructive",
                title: "خطأ",
                description: "فشل تحميل بيانات المراجعة",
            });
        } finally {
            setLoading(false);
        }
    };

    const parseOptions = (options: any): string[] => {
        if (Array.isArray(options)) {
            console.log('✅ Options is already array:', options);
            return options;
        }
        if (typeof options === 'string') {
            try {
                const parsed = JSON.parse(options);
                if (Array.isArray(parsed)) {
                    console.log('✅ Parsed options from string:', parsed);
                    return parsed;
                }
                if (parsed && typeof parsed === 'object') {
                    const arr = [parsed.a, parsed.b, parsed.c, parsed.d].filter(Boolean);
                    console.log('✅ Parsed options from object:', arr);
                    return arr;
                }
                return [];
            } catch (e) {
                console.error('❌ Failed to parse options:', e);
                return [];
            }
        }
        if (options && typeof options === 'object' && !Array.isArray(options)) {
            const arr = [options.a, options.b, options.c, options.d].filter(Boolean);
            console.log('✅ Converted object to array:', arr);
            return arr;
        }
        console.warn('⚠️ Options format unknown:', options);
        return [];
    };

    const getOptionLabel = (index: number): string => {
        return String.fromCharCode(65 + index); // A, B, C, D
    };

    if (loading) {
        return (
            <div className="min-h-screen bg-gradient-to-br from-background via-background to-primary/5">
                <StudentHeader />
                <FloatingParticles />
                <div className="container mx-auto px-4 py-12 flex items-center justify-center min-h-[60vh]">
                    <p className="text-lg">جاري التحميل...</p>
                </div>
            </div>
        );
    }

    if (!reviewData) {
        return (
            <div className="min-h-screen bg-gradient-to-br from-background via-background to-primary/5">
                <StudentHeader />
                <FloatingParticles />
                <div className="container mx-auto px-4 py-12 text-center">
                    <p className="text-lg text-red-500">لم يتم العثور على بيانات المراجعة</p>
                    <Button onClick={() => navigate('/student-exam-results')} className="mt-4">
                        العودة للنتائج
                    </Button>
                </div>
            </div>
        );
    }

    const { exam, attempt, questions } = reviewData;
    const correctAnswers = questions.filter(q => q.is_correct === true).length;
    const wrongAnswers = questions.filter(q => q.is_correct === false).length;
    const essayQuestions = questions.filter(q => q.question_type === 'essay').length;

    return (
        <div className="min-h-screen bg-gradient-to-br from-background via-background to-primary/5" dir="rtl">
            <StudentHeader />
            <FloatingParticles />

            <div className="container mx-auto px-4 py-8 relative z-10 max-w-5xl">
                {/* Header */}
                <motion.div
                    initial={{ opacity: 0, y: -20 }}
                    animate={{ opacity: 1, y: 0 }}
                    className="mb-6"
                >
                    <Button
                        variant="ghost"
                        onClick={() => navigate('/student-exam-results')}
                        className="mb-4"
                    >
                        <ArrowRight className="w-4 h-4 ml-2" />
                        العودة للنتائج
                    </Button>

                    <Card className={`border-2 ${attempt.passed ? 'border-green-500/30 bg-gradient-to-br from-green-500/5 to-emerald-500/5' : 'border-red-500/30 bg-gradient-to-br from-red-500/5 to-pink-500/5'}`}>
                        <CardHeader>
                            <div className="flex items-start justify-between">
                                <div>
                                    <CardTitle className="text-2xl mb-2">{exam.title}</CardTitle>
                                    {exam.description && (
                                        <p className="text-muted-foreground text-sm">{exam.description}</p>
                                    )}
                                </div>
                                <Badge className={`${attempt.passed ? 'bg-green-500' : 'bg-red-500'} text-white`}>
                                    {attempt.passed ? '✓ ناجح' : '✗ راسب'}
                                </Badge>
                            </div>
                        </CardHeader>
                        <CardContent>
                            <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                                <div className="text-center p-4 bg-background/50 rounded-lg">
                                    <p className="text-sm text-muted-foreground mb-1">الدرجة</p>
                                    <p className="text-3xl font-bold">{attempt.score}/{exam.total_marks}</p>
                                </div>
                                <div className="text-center p-4 bg-background/50 rounded-lg">
                                    <p className="text-sm text-muted-foreground mb-1">النسبة</p>
                                    <p className="text-3xl font-bold">{((attempt.score / exam.total_marks) * 100).toFixed(1)}%</p>
                                </div>
                                <div className="text-center p-4 bg-background/50 rounded-lg">
                                    <p className="text-sm text-muted-foreground mb-1">إجابات صحيحة</p>
                                    <p className="text-3xl font-bold text-green-600">{correctAnswers}</p>
                                </div>
                                <div className="text-center p-4 bg-background/50 rounded-lg">
                                    <p className="text-sm text-muted-foreground mb-1">إجابات خاطئة</p>
                                    <p className="text-3xl font-bold text-red-600">{wrongAnswers}</p>
                                </div>
                            </div>
                        </CardContent>
                    </Card>
                </motion.div>

                {/* Questions Review */}
                <div className="space-y-6">
                    {questions.map((question, index) => {
                        const isEssay = question.question_type === 'essay';
                        const options = parseOptions(question.options);

                        return (
                            <motion.div
                                key={question.id}
                                initial={{ opacity: 0, y: 20 }}
                                animate={{ opacity: 1, y: 0 }}
                                transition={{ delay: index * 0.1 }}
                            >
                                <Card className={`border-2 ${isEssay
                                    ? 'border-blue-500/30'
                                    : question.is_correct
                                        ? 'border-green-500/30'
                                        : 'border-red-500/30'
                                    }`}>
                                    <CardHeader>
                                        <div className="flex items-start gap-3">
                                            <div className={`p-2 rounded-lg shrink-0 ${isEssay
                                                ? 'bg-blue-500/20'
                                                : question.is_correct
                                                    ? 'bg-green-500/20'
                                                    : 'bg-red-500/20'
                                                }`}>
                                                {isEssay ? (
                                                    <FileText className="w-5 h-5 text-blue-600" />
                                                ) : question.is_correct ? (
                                                    <CheckCircle2 className="w-5 h-5 text-green-600" />
                                                ) : (
                                                    <XCircle className="w-5 h-5 text-red-600" />
                                                )}
                                            </div>
                                            <div className="flex-1">
                                                <div className="flex items-center gap-2 mb-2">
                                                    <span className="text-sm font-medium text-muted-foreground">
                                                        السؤال {index + 1}
                                                    </span>
                                                    <Badge variant="outline" className="text-xs">
                                                        {question.points} {question.points === 1 ? 'نقطة' : 'نقاط'}
                                                    </Badge>
                                                    {isEssay && (
                                                        <Badge className="bg-blue-500 text-white text-xs">
                                                            مقالي
                                                        </Badge>
                                                    )}
                                                </div>
                                                <CardTitle className="text-lg font-medium">
                                                    {question.question_text}
                                                </CardTitle>
                                                {question.question_image && (
                                                    <img
                                                        src={question.question_image}
                                                        alt="سؤال"
                                                        className="mt-3 rounded-lg max-w-md"
                                                    />
                                                )}
                                            </div>
                                        </div>
                                    </CardHeader>

                                    <CardContent className="space-y-4">
                                        {/* Multiple Choice Question */}
                                        {!isEssay && (
                                            <div className="space-y-4">
                                                {/* Question Text - Always Show */}
                                                <div className="bg-blue-50 dark:bg-blue-900/20 p-4 rounded-lg border-2 border-blue-200 dark:border-blue-800">
                                                    <p className="text-sm font-bold text-blue-700 dark:text-blue-400 mb-2 flex items-center gap-2">
                                                        <span className="text-lg">📝</span>
                                                        نص السؤال:
                                                    </p>
                                                    <p className="text-xl font-bold text-gray-900 dark:text-gray-100">
                                                        {question.question_text}
                                                    </p>
                                                </div>

                                                {/* Your Answer */}
                                                <div className="bg-yellow-50 dark:bg-yellow-900/20 p-4 rounded-lg border-2 border-yellow-300 dark:border-yellow-700">
                                                    <p className="text-sm font-bold text-yellow-700 dark:text-yellow-400 mb-2 flex items-center gap-2">
                                                        <span className="text-lg">✍️</span>
                                                        إجابتك:
                                                    </p>
                                                    <div className="flex items-center justify-between">
                                                        <p className="text-lg font-bold">
                                                            {question.student_answer && options.length > 0 ?
                                                                `${question.student_answer.toUpperCase()}. ${options[question.student_answer.charCodeAt(0) - 97] || options[question.student_answer.charCodeAt(0) - 65] || question.student_answer}`
                                                                : question.student_answer ? `${question.student_answer.toUpperCase()}`
                                                                    : 'لم يتم الإجابة'}
                                                        </p>
                                                        {question.is_correct !== null && (
                                                            <Badge className={`${question.is_correct ? 'bg-green-500' : 'bg-red-500'} text-white text-sm`}>
                                                                {question.is_correct ? '✓ صحيحة' : '✗ خاطئة'}
                                                            </Badge>
                                                        )}
                                                    </div>
                                                </div>

                                                {/* Correct Answer */}
                                                {question.correct_answer && (
                                                    <div className="bg-green-50 dark:bg-green-900/20 p-4 rounded-lg border-2 border-green-300 dark:border-green-700">
                                                        <p className="text-sm font-bold text-green-700 dark:text-green-400 mb-2 flex items-center gap-2">
                                                            <CheckCircle2 className="w-4 h-4" />
                                                            الإجابة الصحيحة:
                                                        </p>
                                                        <p className="text-lg font-bold">
                                                            {options.length > 0
                                                                ? `${question.correct_answer.toUpperCase()}. ${options[question.correct_answer.charCodeAt(0) - 97] || options[question.correct_answer.charCodeAt(0) - 65] || question.correct_answer}`
                                                                : question.correct_answer.toUpperCase()}
                                                        </p>
                                                    </div>
                                                )}

                                                {/* Score */}
                                                <div className="bg-gradient-to-r from-purple-50 to-pink-50 dark:from-purple-900/20 dark:to-pink-900/20 p-4 rounded-lg border-2 border-purple-300 dark:border-purple-700">
                                                    <p className="text-sm font-bold text-purple-700 dark:text-purple-400 mb-2 flex items-center gap-2">
                                                        <Award className="w-4 h-4" />
                                                        الدرجة المكتسبة:
                                                    </p>
                                                    <p className="text-2xl font-bold text-purple-600">
                                                        {question.is_correct ? question.points : 0} / {question.points}
                                                    </p>
                                                </div>

                                                {/* All Options - Only if available */}
                                                {options.length > 0 && (
                                                    <div className="border-t pt-4">
                                                        <p className="text-sm font-bold text-muted-foreground mb-3">جميع الخيارات:</p>
                                                        <div className="space-y-2">
                                                            {options.map((option: string, optIndex: number) => {
                                                                const optionLabel = getOptionLabel(optIndex).toLowerCase();
                                                                const isStudentAnswer = question.student_answer?.toLowerCase() === optionLabel;
                                                                const isCorrectAnswer = question.correct_answer?.toLowerCase() === optionLabel;

                                                                return (
                                                                    <div
                                                                        key={optIndex}
                                                                        className={`p-3 rounded-lg border-2 ${isCorrectAnswer
                                                                            ? 'border-green-500 bg-green-500/10'
                                                                            : isStudentAnswer
                                                                                ? 'border-red-500 bg-red-500/10'
                                                                                : 'border-border'
                                                                            }`}
                                                                    >
                                                                        <div className="flex items-center gap-3">
                                                                            <span className="font-bold text-lg">{optionLabel.toUpperCase()}.</span>
                                                                            <span>{option}</span>
                                                                            {isCorrectAnswer && (
                                                                                <Badge className="bg-green-500 text-white mr-auto text-xs">
                                                                                    <CheckCircle2 className="w-3 h-3 ml-1" />
                                                                                    الإجابة الصحيحة
                                                                                </Badge>
                                                                            )}
                                                                            {isStudentAnswer && !isCorrectAnswer && (
                                                                                <Badge variant="destructive" className="mr-auto text-xs">
                                                                                    <XCircle className="w-3 h-3 ml-1" />
                                                                                    اخترتها
                                                                                </Badge>
                                                                            )}
                                                                            {isStudentAnswer && isCorrectAnswer && (
                                                                                <Badge className="bg-green-500 text-white mr-auto text-xs">
                                                                                    ✓ اخترتها
                                                                                </Badge>
                                                                            )}
                                                                        </div>
                                                                    </div>
                                                                );
                                                            })}
                                                        </div>
                                                    </div>
                                                )}                                            </div>
                                        )}
                                        {/* Essay Question */}
                                        {isEssay && (
                                            <div className="space-y-4">
                                                {/* Student's Answer */}
                                                <div className="bg-blue-50 dark:bg-blue-900/20 p-4 rounded-lg border-2 border-blue-300 dark:border-blue-700">
                                                    <p className="text-sm font-bold text-blue-700 dark:text-blue-400 mb-3 flex items-center gap-2">
                                                        <span className="text-lg">✍️</span>
                                                        إجابتك على السؤال المقالي:
                                                    </p>
                                                    <div className="bg-white dark:bg-gray-800 p-4 rounded-lg border">
                                                        <p className="text-base whitespace-pre-wrap leading-relaxed">
                                                            {question.student_answer || 'لم يتم الإجابة على هذا السؤال'}
                                                        </p>
                                                    </div>
                                                </div>

                                                {/* Grading Section */}
                                                {question.essay_grade ? (
                                                    <div className="space-y-3">
                                                        {/* Score Card */}
                                                        <div className="bg-gradient-to-r from-purple-50 to-pink-50 dark:from-purple-900/20 dark:to-pink-900/20 p-5 rounded-lg border-2 border-purple-300 dark:border-purple-700">
                                                            <div className="flex items-center gap-2 mb-3">
                                                                <Award className="w-6 h-6 text-purple-600" />
                                                                <h4 className="font-bold text-lg text-purple-700 dark:text-purple-400">
                                                                    تقييم المدرس
                                                                </h4>
                                                            </div>
                                                            <div className="flex items-center justify-between bg-white dark:bg-gray-800 p-4 rounded-lg">
                                                                <span className="text-base font-medium">الدرجة المكتسبة:</span>
                                                                <span className="text-3xl font-bold text-purple-600">
                                                                    {question.essay_grade.score} / {question.points}
                                                                </span>
                                                            </div>
                                                            {question.essay_grade.graded_at && (
                                                                <p className="text-xs text-muted-foreground mt-2 text-center">
                                                                    تم التصحيح في: {new Date(question.essay_grade.graded_at).toLocaleString('ar-EG')}
                                                                </p>
                                                            )}
                                                        </div>

                                                        {/* Feedback Card */}
                                                        {question.essay_grade.feedback && (
                                                            <div className="bg-gradient-to-br from-amber-50 to-orange-50 dark:from-amber-900/20 dark:to-orange-900/20 p-5 rounded-lg border-2 border-amber-300 dark:border-amber-700">
                                                                <div className="flex items-start gap-3">
                                                                    <MessageSquare className="w-5 h-5 text-amber-600 mt-1 shrink-0" />
                                                                    <div className="flex-1">
                                                                        <p className="text-sm font-bold text-amber-700 dark:text-amber-400 mb-3">
                                                                            ملاحظات وتعليقات المدرس:
                                                                        </p>
                                                                        <div className="bg-white dark:bg-gray-800 p-4 rounded-lg border">
                                                                            <p className="text-base whitespace-pre-wrap leading-relaxed">
                                                                                {question.essay_grade.feedback}
                                                                            </p>
                                                                        </div>
                                                                    </div>
                                                                </div>
                                                            </div>
                                                        )}
                                                    </div>
                                                ) : (
                                                    <div className="bg-yellow-50 dark:bg-yellow-900/20 p-4 rounded-lg border-2 border-yellow-300 dark:border-yellow-700">
                                                        <p className="text-sm font-medium text-yellow-700 dark:text-yellow-400 flex items-center gap-2">
                                                            <span className="text-lg">⏳</span>
                                                            لم يتم تصحيح هذا السؤال بعد من قبل المدرس
                                                        </p>
                                                        <p className="text-xs text-muted-foreground mt-2">
                                                            الدرجة: 0 / {question.points} (في انتظار التصحيح)
                                                        </p>
                                                    </div>
                                                )}
                                            </div>
                                        )}

                                        {/* Explanation */}
                                        {question.explanation && !isEssay && (
                                            <div className="bg-muted/50 p-4 rounded-lg border">
                                                <p className="text-sm font-medium mb-1">📖 شرح الإجابة:</p>
                                                <p className="text-sm text-muted-foreground">{question.explanation}</p>
                                            </div>
                                        )}
                                    </CardContent>
                                </Card>
                            </motion.div>
                        );
                    })}
                </div>

                {/* Back Button */}
                <div className="mt-8 text-center">
                    <Button
                        onClick={() => navigate('/student-exam-results')}
                        size="lg"
                        className="bg-gradient-to-r from-primary to-accent"
                    >
                        <ArrowRight className="w-5 h-5 ml-2" />
                        العودة لصفحة النتائج
                    </Button>
                </div>
            </div>
        </div>
    );
};

export default ExamReview;
