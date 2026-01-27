import { useState, useEffect } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import { Badge } from "@/components/ui/badge";
import { CheckCircle2, Clock, Save, User, Image as ImageIcon } from "lucide-react";
import Header from "@/components/Header";

const API_BASE_URL = import.meta.env.VITE_API_URL || 'http://72.62.35.177:3001/api';

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

const ManualGrading = () => {
    const { toast } = useToast();
    const [grades, setGrades] = useState<Grade[]>([]);
    const [groups, setGroups] = useState<Group[]>([]);
    const [selectedGrade, setSelectedGrade] = useState<string>("");
    const [selectedGroup, setSelectedGroup] = useState<string>("");
    const [students, setStudents] = useState<StudentAttempt[]>([]);
    const [loading, setLoading] = useState(false);
    const [saving, setSaving] = useState(false);

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
        if (!selectedGrade || !selectedGroup) return;

        setLoading(true);
        try {
            const response = await fetch(
                `${API_BASE_URL}/manual-grading/pending?grade_id=${selectedGrade}&group_id=${selectedGroup}`
            );
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
        const newStudents = [...students];
        const numScore = parseFloat(score);
        const maxScore = newStudents[studentIndex].essay_questions[questionIndex].points;

        if (numScore >= 0 && numScore <= maxScore) {
            newStudents[studentIndex].essay_questions[questionIndex].assigned_score = numScore;
            setStudents(newStudents);
        }
    };

    const calculateTotalScore = (student: StudentAttempt): number => {
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

    const handleSubmitGrades = async (student: StudentAttempt) => {
        // Check if all essay questions are graded
        const allGraded = student.essay_questions.every(q => q.assigned_score !== undefined);

        if (!allGraded) {
            toast({
                title: "تنبيه",
                description: "يجب تصحيح جميع الأسئلة المقالية",
                variant: "destructive"
            });
            return;
        }

        setSaving(true);
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
                // Remove student from list
                setStudents(students.filter(s => s.student_id !== student.student_id));
            }
        } catch (error) {
            console.error('Error submitting grades:', error);
            toast({
                title: "خطأ",
                description: "فشل تسليم الدرجات",
                variant: "destructive"
            });
        } finally {
            setSaving(false);
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
                ) : students.length === 0 ? (
                    <Card>
                        <CardContent className="py-12 text-center text-muted-foreground">
                            {selectedGrade && selectedGroup
                                ? "لا توجد امتحانات تحتاج تصحيح في هذه المجموعة"
                                : "اختر الصف والمجموعة لعرض الطلاب"
                            }
                        </CardContent>
                    </Card>
                ) : (
                    <div className="space-y-6">
                        {students.map((student, studentIndex) => (
                            <Card key={`${student.student_id}-${student.exam_id}`} className="border-2">
                                <CardHeader className="bg-muted/30">
                                    <div className="flex items-center justify-between">
                                        <div className="flex items-center gap-3">
                                            <User className="w-6 h-6 text-primary" />
                                            <div>
                                                <CardTitle className="text-xl">{student.student_name}</CardTitle>
                                                <p className="text-sm text-muted-foreground">
                                                    {student.exam_title} • {new Date(student.submitted_at).toLocaleDateString('ar-EG')}
                                                </p>
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
                                        disabled={saving}
                                        className="w-full"
                                        size="lg"
                                    >
                                        {saving ? (
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
