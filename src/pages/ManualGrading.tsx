import { useState, useEffect, useRef } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import { Badge } from "@/components/ui/badge";
import { CheckCircle2, Clock, Save, User, Image as ImageIcon } from "lucide-react";
import Header from "@/components/Header";

// Vite injects `import.meta.env` at build time; it is absent when this module
// is imported outside Vite (isolated Node tests), so guard the read.
const readApiBase = (): string => {
    try {
        return import.meta.env.VITE_API_URL || '/api';
    } catch {
        return '/api';
    }
};

const API_BASE_URL = readApiBase();

interface Grade {
    id: string;
    name: string;
}

interface Group {
    id: string;
    name: string;
    grade_id: string;
}

interface EssayQuestion {
    id: string;
    question_text: string;
    points: number;
    student_answer?: string;
    student_image?: string;
    assigned_score?: number;
}

interface StudentAttempt {
    student_id: string;
    student_name: string;
    exam_id: string;
    exam_title: string;
    auto_score: number; // الدرجة الاختياري
    total_marks: number;
    essay_questions: EssayQuestion[];
    status: string;
    submitted_at: string;
}

export interface AssignedScoreResult {
    valid: boolean;
    value?: number;
}

/**
 * Validates a raw score input against the question's max points.
 * - an empty string is a valid "clear" (value undefined) so a grader can undo a
 *   score they typed — previously clearing was silently ignored;
 * - a number outside [0, maxScore] is rejected so the input reverts instead of
 *   persisting an out-of-range score.
 */
export const resolveAssignedScore = (raw: string, maxScore: number): AssignedScoreResult => {
    if (raw.trim() === '') return { valid: true, value: undefined };
    const num = Number(raw);
    if (!Number.isFinite(num) || num < 0 || num > maxScore) return { valid: false };
    return { valid: true, value: num };
};

export const isAttemptFullyGraded = (student: StudentAttempt): boolean =>
    student.essay_questions.every(q => q.assigned_score !== undefined);

export const calculateTotalScore = (student: StudentAttempt): number => {
    const essayTotal = student.essay_questions.reduce(
        (sum, q) => sum + (q.assigned_score || 0),
        0
    );
    // تأكد من تحويل auto_score لـ number
    const autoScore = typeof student.auto_score === 'string'
        ? parseFloat(student.auto_score)
        : student.auto_score;
    return autoScore + essayTotal;
};

const ManualGrading = () => {
    const { toast } = useToast();
    const [grades, setGrades] = useState<Grade[]>([]);
    const [groups, setGroups] = useState<Group[]>([]);
    const [selectedGrade, setSelectedGrade] = useState<string>("");
    const [selectedGroup, setSelectedGroup] = useState<string>("");
    const [students, setStudents] = useState<StudentAttempt[]>([]);
    const [loading, setLoading] = useState(false);
    const [loadError, setLoadError] = useState<string | null>(null);
    const [savingId, setSavingId] = useState<string | null>(null); // Track which student is being saved
    // In-flight attempt keys, so a duplicate submit for the same student/exam
    // cannot fire a second POST before React re-renders.
    const inFlightRef = useRef<Set<string>>(new Set());

    useEffect(() => {
        fetchGrades();
        fetchGroups();
    }, []);

    const fetchGrades = async () => {
        try {
            const response = await fetch(`${API_BASE_URL}/grades`);
            const data = await response.json();
            setGrades(data);
        } catch (error) {
            console.error('Error fetching grades:', error);
        }
    };

    const fetchGroups = async () => {
        try {
            const response = await fetch(`${API_BASE_URL}/groups`);
            const data = await response.json();
            setGroups(data);
        } catch (error) {
            console.error('Error fetching groups:', error);
        }
    };

    const fetchPendingAttempts = async () => {
        if (!selectedGrade) return;

        setLoading(true);
        setLoadError(null);
        try {
            const params = new URLSearchParams({ grade_id: selectedGrade });
            if (selectedGroup && selectedGroup !== 'all') {
                params.set('group_id', selectedGroup);
            }

            const response = await fetch(
                `${API_BASE_URL}/manual-grading/pending?${params.toString()}`
            );

            if (!response.ok) {
                throw new Error(`Failed to fetch pending attempts (${response.status})`);
            }

            const data = await response.json();

            // تأكد إن الـ response array
            if (Array.isArray(data)) {
                setStudents(data);
            } else {
                setStudents([]);
                console.error('Expected array but got:', data);
            }
        } catch (error) {
            console.error('Error fetching pending attempts:', error);
            setLoadError('فشل تحميل محاولات الطلاب');
            toast({
                title: "خطأ",
                description: "فشل تحميل محاولات الطلاب",
                variant: "destructive"
            });
        } finally {
            setLoading(false);
        }
    };

    useEffect(() => {
        if (selectedGrade && selectedGroup) {
            fetchPendingAttempts();
        }
    }, [selectedGrade, selectedGroup]);

    const filteredGroups = groups.filter(g => g.grade_id === selectedGrade);

    const handleScoreChange = (studentIndex: number, questionIndex: number, score: string) => {
        const question = students[studentIndex]?.essay_questions[questionIndex];
        if (!question) return;
        const resolved = resolveAssignedScore(score, question.points);
        if (!resolved.valid) return; // out-of-range input reverts (controlled value unchanged)

        setStudents(prev => prev.map((student, sIdx) => {
            if (sIdx !== studentIndex) return student;
            const essay_questions = student.essay_questions.map((q, qIdx) =>
                qIdx === questionIndex ? { ...q, assigned_score: resolved.value } : q
            );
            return { ...student, essay_questions };
        }));
    };

    const handleSubmitGrades = async (student: StudentAttempt) => {
        // Check if all essay questions are graded
        if (!isAttemptFullyGraded(student)) {
            toast({
                title: "تنبيه",
                description: "يجب تصحيح جميع الأسئلة المقالية",
                variant: "destructive"
            });
            return;
        }

        const attemptKey = `${student.student_id}-${student.exam_id}`;
        if (inFlightRef.current.has(attemptKey)) return; // duplicate submit guard
        inFlightRef.current.add(attemptKey);
        setSavingId(attemptKey);
        try {
            const totalScore = calculateTotalScore(student);
            const essayScores = student.essay_questions.reduce((acc, q) => {
                acc[q.id] = q.assigned_score!;
                return acc;
            }, {} as Record<string, number>);

            const response = await fetch(
                `${API_BASE_URL}/manual-grading/submit`,
                {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        exam_id: student.exam_id,
                        student_id: student.student_id,
                        essay_scores: essayScores,
                        total_score: totalScore
                    })
                }
            );

            if (response.ok) {
                toast({
                    title: "تم بنجاح",
                    description: "تم تسليم الدرجات بنجاح"
                });
                // Remove this specific attempt from list (student may have multiple exams)
                setStudents(prev => prev.filter(s =>
                    !(s.student_id === student.student_id && s.exam_id === student.exam_id)
                ));
                return;
            }

            // A rejected submit must be surfaced; the row is kept so the grader
            // can retry. 401/403 are reported distinctly from other failures.
            const description = response.status === 401
                ? 'انتهت الجلسة، يرجى تسجيل الدخول مرة أخرى'
                : response.status === 403
                    ? 'ليست لديك صلاحية تسليم الدرجات'
                    : 'فشل تسليم الدرجات، حاول مرة أخرى';
            toast({
                title: "خطأ",
                description,
                variant: "destructive"
            });
        } catch (error) {
            console.error('Error submitting grades:', error);
            toast({
                title: "خطأ",
                description: "فشل تسليم الدرجات",
                variant: "destructive"
            });
        } finally {
            inFlightRef.current.delete(attemptKey);
            // Only clear this attempt's marker; a concurrent save for a
            // different student must keep its own in-flight state.
            setSavingId(prev => (prev === attemptKey ? null : prev));
        }
    };

    return (
        <div className="min-h-screen bg-gradient-to-br from-background via-background to-primary/5">
            <Header />

            <div className="container mx-auto p-6">
                <Card className="mb-6">
                    <CardHeader>
                        <CardTitle className="text-2xl">تصحيح الأسئلة المقالية ورفع الدرجات</CardTitle>
                    </CardHeader>
                    <CardContent>
                        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                            {/* Grade Selection */}
                            <div>
                                <Label>الصف الدراسي</Label>
                                <Select value={selectedGrade} onValueChange={setSelectedGrade}>
                                    <SelectTrigger>
                                        <SelectValue placeholder="اختر الصف" />
                                    </SelectTrigger>
                                    <SelectContent>
                                        {grades.map(grade => (
                                            <SelectItem key={grade.id} value={grade.id}>
                                                {grade.name}
                                            </SelectItem>
                                        ))}
                                    </SelectContent>
                                </Select>
                            </div>

                            {/* Group Selection */}
                            <div>
                                <Label>المجموعة</Label>
                                <Select
                                    value={selectedGroup}
                                    onValueChange={setSelectedGroup}
                                    disabled={!selectedGrade}
                                >
                                    <SelectTrigger>
                                        <SelectValue placeholder="اختر المجموعة" />
                                    </SelectTrigger>
                                    <SelectContent>
                                        <SelectItem value="all">الكل</SelectItem>
                                        {filteredGroups.map(group => (
                                            <SelectItem key={group.id} value={group.id}>
                                                {group.name}
                                            </SelectItem>
                                        ))}
                                    </SelectContent>
                                </Select>
                            </div>
                        </div>
                    </CardContent>
                </Card>

                {loading ? (
                    <div className="text-center py-12">
                        <Clock className="w-16 h-16 mx-auto mb-4 text-primary animate-spin" />
                        <p>جاري تحميل البيانات...</p>
                    </div>
                ) : loadError ? (
                    <Card>
                        <CardContent className="py-12 text-center">
                            <p className="text-muted-foreground mb-4">{loadError}</p>
                            <Button onClick={() => fetchPendingAttempts()}>إعادة المحاولة</Button>
                        </CardContent>
                    </Card>
                ) : students.length === 0 ? (
                    <Card>
                        <CardContent className="py-12 text-center text-muted-foreground">
                            {selectedGrade
                                ? "لا توجد امتحانات تحتاج تصحيح لهذه الصفوف/المجموعات"
                                : "اختر الصف (ويمكنك اختيار المجموعة أو الكل)"
                            }
                        </CardContent>
                    </Card>
                ) : (
                    <div className="space-y-6">
                        <div className="mb-4 bg-blue-50 dark:bg-blue-900/20 p-4 rounded-lg border border-blue-200">
                            <p className="text-sm font-medium text-blue-900 dark:text-blue-100">
                                📊 عدد الطلاب المنتظرين: <span className="font-bold">{students.length}</span> طالب
                            </p>
                        </div>
                        {students.map((student, studentIndex) => (
                            <Card key={`${student.student_id}-${student.exam_id}`} className="border-2">
                                <CardHeader className="bg-muted/30">
                                    <div className="flex items-center justify-between">
                                        <div className="flex items-center gap-3">
                                            <User className="w-6 h-6 text-primary" />
                                            <div>
                                                <CardTitle className="text-xl">{student.student_name}</CardTitle>
                                                <div className="flex flex-col gap-1 mt-1">
                                                    <Badge variant="secondary" className="w-fit">
                                                        📝 {student.exam_title}
                                                    </Badge>
                                                    <p className="text-xs text-muted-foreground">
                                                        تاريخ التسليم: {new Date(student.submitted_at).toLocaleDateString('ar-EG', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })}
                                                    </p>
                                                </div>
                                            </div>
                                        </div>
                                        <Badge variant="outline" className="bg-blue-50 text-blue-700 border-blue-300">
                                            <Clock className="w-4 h-4 ml-1" />
                                            قيد المراجعة
                                        </Badge>
                                    </div>
                                </CardHeader>

                                <CardContent className="p-6 space-y-6">
                                    {/* Auto Score */}
                                    <div className="bg-green-50 dark:bg-green-900/10 p-4 rounded-lg border border-green-200">
                                        <div className="flex items-center justify-between">
                                            <span className="font-medium">درجة الأسئلة الاختيارية (تلقائي)</span>
                                            <span className="text-2xl font-bold text-green-700">
                                                {student.auto_score}
                                            </span>
                                        </div>
                                    </div>

                                    {/* Essay Questions */}
                                    <div>
                                        <h3 className="text-lg font-semibold mb-4">الأسئلة المقالية</h3>
                                        <div className="space-y-4">
                                            {student.essay_questions.map((question, questionIndex) => (
                                                <Card key={question.id} className="bg-muted/20">
                                                    <CardContent className="p-4 space-y-3">
                                                        <div className="flex items-start justify-between">
                                                            <p className="font-medium flex-1">{question.question_text}</p>
                                                            <Badge variant="secondary">
                                                                {question.points} {question.points === 1 ? 'درجة' : 'درجات'}
                                                            </Badge>
                                                        </div>

                                                        {/* Student Answer */}
                                                        <div className="bg-background p-3 rounded border">
                                                            <p className="text-sm font-medium mb-2">إجابة الطالب:</p>
                                                            {question.student_answer && (
                                                                <p className="text-sm mb-2">{question.student_answer}</p>
                                                            )}
                                                            {question.student_image && (
                                                                <img
                                                                    src={question.student_image}
                                                                    alt="إجابة الطالب"
                                                                    className="max-w-full max-h-64 rounded border mt-2"
                                                                />
                                                            )}
                                                            {!question.student_answer && !question.student_image && (
                                                                <p className="text-sm text-muted-foreground">لم يتم الإجابة</p>
                                                            )}
                                                        </div>

                                                        {/* Score Input */}
                                                        <div className="flex items-center gap-4">
                                                            <Label className="whitespace-nowrap">
                                                                الدرجة المستحقة (من {question.points}):
                                                            </Label>
                                                            <Input
                                                                type="number"
                                                                min="0"
                                                                max={question.points}
                                                                step="0.5"
                                                                value={question.assigned_score ?? ''}
                                                                onChange={(e) => handleScoreChange(studentIndex, questionIndex, e.target.value)}
                                                                className="max-w-[120px]"
                                                                placeholder="0"
                                                            />
                                                        </div>
                                                    </CardContent>
                                                </Card>
                                            ))}
                                        </div>
                                    </div>

                                    {/* Total Score */}
                                    <div className="bg-primary/10 p-4 rounded-lg border-2 border-primary/30">
                                        <div className="flex items-center justify-between">
                                            <span className="text-lg font-bold">الدرجة الكلية النهائية</span>
                                            <span className="text-3xl font-bold text-primary">
                                                {calculateTotalScore(student)} / {student.total_marks}
                                            </span>
                                        </div>
                                    </div>

                                    {/* Submit Button */}
                                    <Button
                                        onClick={() => handleSubmitGrades(student)}
                                        disabled={savingId === `${student.student_id}-${student.exam_id}`}
                                        className="w-full"
                                        size="lg"
                                    >
                                        {savingId === `${student.student_id}-${student.exam_id}` ? (
                                            <>
                                                <Clock className="w-5 h-5 ml-2 animate-spin" />
                                                جاري التسليم...
                                            </>
                                        ) : (
                                            <>
                                                <Save className="w-5 h-5 ml-2" />
                                                تسليم الدرجات
                                            </>
                                        )}
                                    </Button>
                                </CardContent>
                            </Card>
                        ))}
                    </div>
                )}
            </div>
        </div>
    );
};

export default ManualGrading;
