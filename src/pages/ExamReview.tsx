import { useState, useEffect } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { CheckCircle2, XCircle, FileText, ArrowRight, MessageSquare, Award, Download, Printer } from "lucide-react";
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
    const [generatingPDF, setGeneratingPDF] = useState(false);

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
        if (Array.isArray(options)) return options;
        if (typeof options === 'string') {
            try {
                const parsed = JSON.parse(options);
                return Array.isArray(parsed) ? parsed : [];
            } catch {
                return [];
            }
        }
        return [];
    };

    const getOptionLabel = (index: number): string => {
        return String.fromCharCode(65 + index); // A, B, C, D
    };

    const generateExamPDF = async () => {
        if (!reviewData) return;

        setGeneratingPDF(true);

        try {
            // Create a printable version using window.print
            const printWindow = window.open('', '_blank');
            if (!printWindow) {
                toast({
                    title: "خطأ",
                    description: "يرجى السماح للنوافذ المنبثقة",
                    variant: "destructive"
                });
                return;
            }

            const passed = reviewData.attempt.passed;
            const percentage = ((reviewData.attempt.score / reviewData.exam.total_marks) * 100).toFixed(1);
            const correctAnswers = reviewData.questions.filter(q => q.is_correct).length;
            const wrongAnswers = reviewData.questions.filter(q => q.student_answer && !q.is_correct).length;
            const unanswered = reviewData.questions.filter(q => !q.student_answer).length;

            let questionsHTML = '';
            reviewData.questions.forEach((question, idx) => {
                const isCorrect = question.is_correct;
                const wasAnswered = !!question.student_answer;
                const options = parseOptions(question.options);
                
                let optionsHTML = '';
                if (question.question_type === 'multiple_choice') {
                    options.forEach((option: string, optIdx: number) => {
                        const optionLetter = String.fromCharCode(97 + optIdx);
                        const isUserAnswer = question.student_answer === optionLetter;
                        const isCorrectAnswer = question.correct_answer === optionLetter;
                        
                        let optionClass = 'option';
                        if (isUserAnswer && isCorrectAnswer) optionClass += ' correct-answer';
                        else if (isUserAnswer && !isCorrectAnswer) optionClass += ' wrong-answer';
                        else if (isCorrectAnswer) optionClass += ' correct-answer';
                        
                        optionsHTML += `
                            <div class="${optionClass}">
                                <span class="option-letter">${optionLetter})</span>
                                <span>${option}</span>
                                ${isUserAnswer ? '<span class="marker">●</span>' : '<span class="marker">○</span>'}
                                ${isCorrectAnswer ? '<span class="check">✓</span>' : ''}
                            </div>
                        `;
                    });
                }

                let answerSummary = '';
                if (question.question_type === 'multiple_choice') {
                    if (wasAnswered) {
                        if (isCorrect) {
                            answerSummary = '<div class="answer-summary correct">✓ إجابتك صحيحة</div>';
                        } else {
                            answerSummary = `<div class="answer-summary wrong">✗ إجابتك: ${question.student_answer} | الصحيحة: ${question.correct_answer}</div>`;
                        }
                    } else {
                        answerSummary = '<div class="answer-summary unanswered">لم تجب على هذا السؤال</div>';
                    }
                } else if (question.question_type === 'essay') {
                    if (question.essay_grade) {
                        answerSummary = `<div class="answer-summary essay">الدرجة: ${question.essay_grade.score}/${question.points}</div>`;
                        if (question.essay_grade.feedback) {
                            answerSummary += `<div class="feedback">${question.essay_grade.feedback}</div>`;
                        }
                    } else {
                        answerSummary = '<div class="answer-summary pending">قيد المراجعة</div>';
                    }
                }

                questionsHTML += `
                    <div class="question-card">
                        <div class="question-header">
                            <span class="question-number">السؤال ${idx + 1}:</span>
                            <span class="question-points">(${question.points} نقطة)</span>
                        </div>
                        <div class="question-text">${question.question_text}</div>
                        <div class="options-container">
                            ${optionsHTML}
                        </div>
                        ${answerSummary}
                    </div>
                `;
            });

            const htmlContent = `
                <!DOCTYPE html>
                <html dir="rtl" lang="ar">
                <head>
                    <meta charset="UTF-8">
                    <title>نتيجة الامتحان - ${reviewData.exam.title}</title>
                    <style>
                        @media print {
                            @page { margin: 1cm; }
                            body { margin: 0; }
                            .no-print { display: none !important; }
                        }
                        
                        * {
                            margin: 0;
                            padding: 0;
                            box-sizing: border-box;
                        }
                        
                        body {
                            font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
                            direction: rtl;
                            background: white;
                            color: #000;
                            line-height: 1.6;
                        }
                        
                        .container {
                            max-width: 210mm;
                            margin: 0 auto;
                            padding: 10mm;
                        }
                        
                        .header {
                            background: linear-gradient(135deg, #0d9488 0%, #14b8a6 100%);
                            color: white;
                            padding: 30px;
                            border-radius: 10px;
                            text-align: center;
                            margin-bottom: 30px;
                        }
                        
                        .header h1 {
                            font-size: 32px;
                            margin-bottom: 10px;
                        }
                        
                        .header h2 {
                            font-size: 20px;
                            font-weight: normal;
                        }
                        
                        .result-box {
                            background: ${passed ? '#dcfce7' : '#fee2e2'};
                            border: 3px solid ${passed ? '#22c55e' : '#ef4444'};
                            padding: 30px;
                            border-radius: 10px;
                            text-align: center;
                            margin-bottom: 30px;
                        }
                        
                        .result-box .status {
                            font-size: 36px;
                            font-weight: bold;
                            color: ${passed ? '#15803d' : '#dc2626'};
                            margin-bottom: 10px;
                        }
                        
                        .result-box .score {
                            font-size: 24px;
                            color: #000;
                        }
                        
                        .stats {
                            background: #f3f4f6;
                            padding: 20px;
                            border-radius: 10px;
                            margin-bottom: 30px;
                        }
                        
                        .stats-row {
                            display: flex;
                            justify-content: space-around;
                            margin-bottom: 10px;
                        }
                        
                        .stat-item {
                            text-align: center;
                            font-size: 16px;
                        }
                        
                        .stat-value {
                            font-size: 24px;
                            font-weight: bold;
                            color: #0d9488;
                        }
                        
                        .section-title {
                            font-size: 24px;
                            color: #0d9488;
                            margin: 30px 0 20px;
                            padding-bottom: 10px;
                            border-bottom: 2px solid #0d9488;
                        }
                        
                        .question-card {
                            background: white;
                            border: 2px solid #e5e7eb;
                            border-radius: 8px;
                            padding: 20px;
                            margin-bottom: 20px;
                            page-break-inside: avoid;
                        }
                        
                        .question-header {
                            display: flex;
                            justify-content: space-between;
                            margin-bottom: 15px;
                            padding: 10px;
                            background: #f9fafb;
                            border-radius: 5px;
                        }
                        
                        .question-number {
                            font-weight: bold;
                            color: #0d9488;
                            font-size: 18px;
                        }
                        
                        .question-points {
                            color: #6b7280;
                            font-size: 16px;
                        }
                        
                        .question-text {
                            font-size: 16px;
                            margin-bottom: 15px;
                            line-height: 1.8;
                        }
                        
                        .options-container {
                            margin: 15px 0;
                        }
                        
                        .option {
                            padding: 12px 15px;
                            margin: 8px 0;
                            border-radius: 5px;
                            border: 1px solid #e5e7eb;
                            display: flex;
                            align-items: center;
                            gap: 10px;
                        }
                        
                        .option-letter {
                            font-weight: bold;
                            min-width: 30px;
                        }
                        
                        .marker {
                            margin-right: auto;
                            font-size: 18px;
                        }
                        
                        .check {
                            color: #22c55e;
                            font-size: 20px;
                            font-weight: bold;
                        }
                        
                        .correct-answer {
                            background: #dcfce7;
                            border-color: #22c55e;
                            color: #15803d;
                        }
                        
                        .wrong-answer {
                            background: #fee2e2;
                            border-color: #ef4444;
                            color: #dc2626;
                        }
                        
                        .answer-summary {
                            margin-top: 15px;
                            padding: 10px 15px;
                            border-radius: 5px;
                            font-size: 14px;
                        }
                        
                        .answer-summary.correct {
                            background: #dcfce7;
                            color: #15803d;
                        }
                        
                        .answer-summary.wrong {
                            background: #fee2e2;
                            color: #dc2626;
                        }
                        
                        .answer-summary.unanswered {
                            background: #f3f4f6;
                            color: #6b7280;
                        }
                        
                        .answer-summary.essay,
                        .answer-summary.pending {
                            background: #dbeafe;
                            color: #1e40af;
                        }
                        
                        .feedback {
                            margin-top: 10px;
                            padding: 10px;
                            background: #f9fafb;
                            border-right: 3px solid #0d9488;
                            font-size: 14px;
                        }
                        
                        .footer {
                            text-align: center;
                            color: #6b7280;
                            margin-top: 40px;
                            padding-top: 20px;
                            border-top: 1px solid #e5e7eb;
                            font-size: 14px;
                        }
                        
                        .print-button {
                            background: linear-gradient(135deg, #f59e0b 0%, #ea580c 100%);
                            color: white;
                            border: none;
                            padding: 15px 40px;
                            font-size: 18px;
                            border-radius: 8px;
                            cursor: pointer;
                            margin: 20px auto;
                            display: block;
                        }
                        
                        .print-button:hover {
                            opacity: 0.9;
                        }
                    </style>
                </head>
                <body>
                    <div class="container">
                        <div class="header">
                            <h1>نتيجة الامتحان</h1>
                            <h2>${reviewData.exam.title}</h2>
                        </div>
                        
                        <div class="result-box">
                            <div class="status">${passed ? '✓ ناجح' : '✗ راسب'}</div>
                            <div class="score">${reviewData.attempt.score}/${reviewData.exam.total_marks} (${percentage}%)</div>
                        </div>
                        
                        <div class="stats">
                            <div class="stats-row">
                                <div class="stat-item">
                                    <div>الإجابات الصحيحة</div>
                                    <div class="stat-value">${correctAnswers}</div>
                                </div>
                                <div class="stat-item">
                                    <div>الإجابات الخاطئة</div>
                                    <div class="stat-value">${wrongAnswers}</div>
                                </div>
                                <div class="stat-item">
                                    <div>لم تجب</div>
                                    <div class="stat-value">${unanswered}</div>
                                </div>
                            </div>
                            <div style="text-align: center; margin-top: 10px;">
                                تاريخ الامتحان: ${new Date(reviewData.attempt.completed_at).toLocaleDateString('ar-EG')}
                            </div>
                        </div>
                        
                        <button class="print-button no-print" onclick="window.print()">🖨️ طباعة أو حفظ كـ PDF</button>
                        
                        <h3 class="section-title">تفاصيل الأسئلة والإجابات</h3>
                        
                        ${questionsHTML}
                        
                        <div class="footer">
                            <p>منصة القائد التعليمية - جميع الحقوق محفوظة © ${new Date().getFullYear()}</p>
                        </div>
                    </div>
                </body>
                </html>
            `;

            printWindow.document.write(htmlContent);
            printWindow.document.close();

            toast({
                title: "تم فتح نافذة الطباعة ✅",
                description: "اضغط على زر الطباعة ثم اختر 'حفظ كـ PDF' من القائمة",
            });
        } catch (error) {
            console.error('Error generating PDF:', error);
            toast({
                title: "خطأ",
                description: "فشل إنشاء صفحة الطباعة",
                variant: "destructive"
            });
        } finally {
            setGeneratingPDF(false);
        }
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
                    <Button onClick={() => navigate('/student/exam-results')} className="mt-4">
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
                        onClick={() => navigate('/student/exam-results')}
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
                                        {!isEssay && options.length > 0 && (
                                            <div className="space-y-4">
                                                {/* Your Answer */}
                                                <div className="bg-blue-50 dark:bg-blue-900/20 p-4 rounded-lg border-2 border-blue-300 dark:border-blue-700">
                                                    <p className="text-sm font-bold text-blue-700 dark:text-blue-400 mb-2 flex items-center gap-2">
                                                        <span className="text-lg">✍️</span>
                                                        إجابتك:
                                                    </p>
                                                    <div className="flex items-center justify-between">
                                                        <p className="text-lg font-bold">
                                                            {question.student_answer ?
                                                                `${question.student_answer}. ${options[question.student_answer.charCodeAt(0) - 65] || 'غير محدد'}`
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
                                                            {question.correct_answer}. {options[question.correct_answer.charCodeAt(0) - 65] || ''}
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

                                                {/* All Options */}
                                                <div className="border-t pt-4">
                                                    <p className="text-sm font-bold text-muted-foreground mb-3">جميع الخيارات:</p>
                                                    <div className="space-y-2">
                                                        {options.map((option: string, optIndex: number) => {
                                                            const optionLabel = getOptionLabel(optIndex);
                                                            const isStudentAnswer = question.student_answer === optionLabel;
                                                            const isCorrectAnswer = question.correct_answer === optionLabel;

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
                                                                        <span className="font-bold text-lg">{optionLabel}.</span>
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
                                            </div>
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

                {/* Action Buttons */}
                <div className="mt-8 flex flex-col gap-4 items-center">
                    {/* PDF Download Button */}
                    <Button
                        onClick={generateExamPDF}
                        disabled={generatingPDF}
                        size="lg"
                        className="w-full max-w-md bg-gradient-to-r from-amber-500 to-orange-600 hover:from-amber-600 hover:to-orange-700 text-white shadow-lg"
                    >
                        {generatingPDF ? (
                            <>
                                <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-white ml-2" />
                                جاري فتح نافذة الطباعة...
                            </>
                        ) : (
                            <>
                                <Printer className="w-5 h-5 ml-2" />
                                تحميل النتيجة كاملة (PDF)
                            </>
                        )}
                    </Button>

                    {/* Back Button */}
                    <Button
                        onClick={() => navigate('/student-exam-results')}
                        size="lg"
                        variant="outline"
                        className="w-full max-w-md"
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
