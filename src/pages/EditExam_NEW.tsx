import { useState, useEffect } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { useToast } from '@/hooks/use-toast';
import { User } from '@/lib/api-http';
import { Plus, Trash2, ArrowLeft, Save } from 'lucide-react';
import Header from '@/components/Header';

const API_URL = import.meta.env.VITE_API_URL || '/api';

interface Question {
    id?: string;
    question_text: string;
    question_image?: string;
    question_type: 'multiple_choice' | 'essay';
    option_a?: string;
    option_b?: string;
    option_c?: string;
    option_d?: string;
    correct_answer?: 'a' | 'b' | 'c' | 'd';
    points: number;
}

export default function EditExam() {
    const { examId } = useParams();
    const { toast } = useToast();
    const navigate = useNavigate();
    const [loading, setLoading] = useState(false);
    const [saving, setSaving] = useState(false);

    const [courses, setCourses] = useState<any[]>([]);
    const [grades, setGrades] = useState<any[]>([]);
    const [groups, setGroups] = useState<any[]>([]);

    const [examData, setExamData] = useState({
        title: '',
        description: '',
        course_id: '',
        grade_id: '',
        duration_minutes: '60',
        start_date: '',
        end_date: '',
        passing_score: '60'
    });

    const [selectedGroupIds, setSelectedGroupIds] = useState<string[]>([]);
    const [questions, setQuestions] = useState<Question[]>([]);
    const [currentQuestion, setCurrentQuestion] = useState<Question>({
        question_text: '',
        question_type: 'multiple_choice',
        option_a: '',
        option_b: '',
        option_c: '',
        option_d: '',
        correct_answer: 'a',
        points: 1
    });

    useEffect(() => {
        const userStr = localStorage.getItem('currentUser');
        const user: User | null = userStr ? JSON.parse(userStr) : null;

        if (!user || (user.role !== 'teacher' && user.role !== 'admin')) {
            navigate('/auth');
            return;
        }

        loadData();
    }, [examId]);

    const loadData = async () => {
        try {
            setLoading(true);

            // Load courses, grades, groups
            const [coursesRes, gradesRes, groupsRes] = await Promise.all([
                fetch(`${API_URL}/courses`),
                fetch(`${API_URL}/grades`),
                fetch(`${API_URL}/groups`)
            ]);

            setCourses(await coursesRes.json());
            setGrades(await gradesRes.json());
            setGroups(await groupsRes.json());

            // Load exam data
            const examRes = await fetch(`${API_URL}/exams/${examId}`);
            const exam = await examRes.json();

            // Format datetime for inputs
            const formatDateTime = (dt: string) => {
                if (!dt) return '';
                const d = new Date(dt);
                const pad = (n: number) => String(n).padStart(2, '0');
                return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
            };

            setExamData({
                title: exam.title || '',
                description: exam.description || '',
                course_id: exam.course_id || '',
                grade_id: exam.grade_id || '',
                duration_minutes: String(exam.duration_minutes || 60),
                start_date: formatDateTime(exam.start_time),
                end_date: formatDateTime(exam.end_time),
                passing_score: String(exam.passing_marks || 60)
            });

            // Load questions
            const questionsRes = await fetch(`${API_URL}/exams/${examId}/questions`);
            const questionsData = await questionsRes.json();

            const parsedQuestions = questionsData.map((q: any) => {
                const opts = q.options ? JSON.parse(q.options) : {};
                return {
                    id: q.id,
                    question_text: q.question_text,
                    question_image: q.question_image,
                    question_type: q.question_type,
                    option_a: opts.a || '',
                    option_b: opts.b || '',
                    option_c: opts.c || '',
                    option_d: opts.d || '',
                    correct_answer: q.correct_answer || 'a',
                    points: q.points || 1
                };
            });

            setQuestions(parsedQuestions);

            // Load exam groups
            const groupsRes2 = await fetch(`${API_URL}/exams/${examId}/groups`);
            if (groupsRes2.ok) {
                const examGroups = await groupsRes2.json();
                setSelectedGroupIds(examGroups.map((g: any) => g.group_id));
            }

        } catch (error) {
            console.error('Error loading data:', error);
            toast({
                title: 'خطأ',
                description: 'فشل تحميل البيانات',
                variant: 'destructive'
            });
        } finally {
            setLoading(false);
        }
    };

    const handleSaveExam = async () => {
        try {
            setSaving(true);

            // Format dates
            const formatDateTime = (value: string) => {
                if (!value) return null;
                if (/T/.test(value) && !/Z$/.test(value)) {
                    const [d, t] = value.split('T');
                    return `${d} ${t}:00`;
                }
                return value;
            };

            const startDateTime = formatDateTime(examData.start_date);
            const endDateTime = formatDateTime(examData.end_date);

            // Calculate marks
            const totalMarks = questions.reduce((sum, q) => sum + q.points, 0);
            const passingPercent = Math.max(0, Math.min(100, parseInt(examData.passing_score) || 60));
            const passingMarks = Math.ceil((passingPercent / 100) * totalMarks);

            // Update exam
            const examRes = await fetch(`${API_URL}/exams/${examId}`, {
                method: 'PUT',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${localStorage.getItem('authToken') || ''}`
                },
                body: JSON.stringify({
                    title: examData.title,
                    description: examData.description,
                    course_id: examData.course_id,
                    grade_id: examData.grade_id,
                    duration_minutes: parseInt(examData.duration_minutes),
                    total_marks: totalMarks,
                    passing_marks: passingMarks,
                    start_time: startDateTime,
                    end_time: endDateTime,
                    start_date: startDateTime,
                    end_date: endDateTime
                })
            });

            if (!examRes.ok) throw new Error('Failed to update exam');

            // Delete all existing questions
            for (const q of questions) {
                if (q.id) {
                    await fetch(`${API_URL}/exams/${examId}/questions/${q.id}`, {
                        method: 'DELETE',
                        headers: { 'Authorization': `Bearer ${localStorage.getItem('authToken')}` }
                    });
                }
            }

            // Re-add all questions
            for (let i = 0; i < questions.length; i++) {
                const question = questions[i];
                const options = question.question_type === 'multiple_choice'
                    ? JSON.stringify({
                        a: question.option_a,
                        b: question.option_b,
                        c: question.option_c,
                        d: question.option_d
                    })
                    : null;

                await fetch(`${API_URL}/exams/${examId}/questions`, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'Authorization': `Bearer ${localStorage.getItem('authToken')}`
                    },
                    body: JSON.stringify({
                        question_text: question.question_text,
                        question_image: question.question_image,
                        question_type: question.question_type,
                        options: options,
                        correct_answer: question.correct_answer,
                        points: question.points,
                        display_order: i + 1
                    })
                });
            }

            toast({
                title: 'نجح',
                description: 'تم حفظ التعديلات بنجاح'
            });

            navigate('/teacher-exams');
        } catch (error) {
            console.error('Error saving exam:', error);
            toast({
                title: 'خطأ',
                description: 'فشل حفظ التعديلات',
                variant: 'destructive'
            });
        } finally {
            setSaving(false);
        }
    };

    const addQuestion = () => {
        if (!currentQuestion.question_text) {
            toast({ title: 'خطأ', description: 'من فضلك أدخل نص السؤال', variant: 'destructive' });
            return;
        }

        setQuestions([...questions, { ...currentQuestion }]);
        setCurrentQuestion({
            question_text: '',
            question_type: 'multiple_choice',
            option_a: '',
            option_b: '',
            option_c: '',
            option_d: '',
            correct_answer: 'a',
            points: 1
        });
    };

    const removeQuestion = (index: number) => {
        setQuestions(questions.filter((_, i) => i !== index));
    };

    if (loading) {
        return (
            <div className="min-h-screen bg-gradient-to-br from-gray-50 to-gray-100">
                <Header />
                <div className="flex items-center justify-center h-screen">
                    <p>جاري التحميل...</p>
                </div>
            </div>
        );
    }

    return (
        <div className="min-h-screen bg-gradient-to-br from-gray-50 to-gray-100">
            <Header />
            <div className="container mx-auto px-4 py-8">
                <div className="mb-6 flex items-center justify-between">
                    <div>
                        <Button
                            variant="outline"
                            onClick={() => navigate('/teacher-exams')}
                            className="mb-4"
                        >
                            <ArrowLeft className="h-4 w-4 ml-2" />
                            العودة
                        </Button>
                        <h1 className="text-3xl font-bold bg-gradient-to-r from-cyan-600 to-teal-600 bg-clip-text text-transparent">
                            تعديل الامتحان
                        </h1>
                    </div>

                    <Button
                        onClick={handleSaveExam}
                        disabled={saving}
                        className="bg-gradient-to-r from-green-600 to-emerald-600"
                    >
                        <Save className="h-4 w-4 ml-2" />
                        {saving ? 'جاري الحفظ...' : 'حفظ التعديلات'}
                    </Button>
                </div>

                <Card className="shadow-lg">
                    <CardHeader className="bg-gradient-to-r from-cyan-50 to-teal-50">
                        <CardTitle>بيانات الامتحان</CardTitle>
                    </CardHeader>
                    <CardContent className="pt-6">
                        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-6">
                            <div>
                                <Label>المادة *</Label>
                                <Select value={examData.course_id} onValueChange={(value) => setExamData({ ...examData, course_id: value })}>
                                    <SelectTrigger>
                                        <SelectValue placeholder="اختر المادة" />
                                    </SelectTrigger>
                                    <SelectContent>
                                        {courses.map((course) => (
                                            <SelectItem key={course.id} value={course.id}>{course.name}</SelectItem>
                                        ))}
                                    </SelectContent>
                                </Select>
                            </div>

                            <div>
                                <Label>الصف الدراسي *</Label>
                                <Select value={examData.grade_id} onValueChange={(value) => setExamData({ ...examData, grade_id: value })}>
                                    <SelectTrigger>
                                        <SelectValue placeholder="اختر الصف" />
                                    </SelectTrigger>
                                    <SelectContent>
                                        {grades.map((grade) => (
                                            <SelectItem key={grade.id} value={grade.id}>{grade.name}</SelectItem>
                                        ))}
                                    </SelectContent>
                                </Select>
                            </div>

                            <div className="md:col-span-2">
                                <Label>عنوان الامتحان *</Label>
                                <Input
                                    value={examData.title}
                                    onChange={(e) => setExamData({ ...examData, title: e.target.value })}
                                    placeholder="مثال: امتحان نصف الترم"
                                />
                            </div>

                            <div className="md:col-span-2">
                                <Label>وصف الامتحان</Label>
                                <Textarea
                                    value={examData.description}
                                    onChange={(e) => setExamData({ ...examData, description: e.target.value })}
                                    placeholder="وصف مختصر..."
                                    rows={2}
                                />
                            </div>

                            <div>
                                <Label>مدة الامتحان (دقائق) *</Label>
                                <Input
                                    type="number"
                                    value={examData.duration_minutes}
                                    onChange={(e) => setExamData({ ...examData, duration_minutes: e.target.value })}
                                />
                            </div>

                            <div>
                                <Label>نسبة النجاح (%) *</Label>
                                <Input
                                    type="number"
                                    min={0}
                                    max={100}
                                    value={examData.passing_score}
                                    onChange={(e) => setExamData({ ...examData, passing_score: e.target.value })}
                                />
                            </div>

                            <div>
                                <Label>وقت البدء *</Label>
                                <Input
                                    type="datetime-local"
                                    value={examData.start_date}
                                    onChange={(e) => setExamData({ ...examData, start_date: e.target.value })}
                                />
                            </div>

                            <div>
                                <Label>وقت الانتهاء *</Label>
                                <Input
                                    type="datetime-local"
                                    value={examData.end_date}
                                    onChange={(e) => setExamData({ ...examData, end_date: e.target.value })}
                                />
                            </div>
                        </div>

                        {/* Questions Section */}
                        <div className="border-t pt-6 mt-6">
                            <h3 className="text-xl font-semibold mb-4">الأسئلة ({questions.length})</h3>

                            {/* Existing Questions */}
                            {questions.map((q, index) => (
                                <Card key={index} className="mb-3 bg-gray-50">
                                    <CardContent className="pt-4">
                                        <div className="flex items-start justify-between">
                                            <div className="flex-1">
                                                <p className="font-semibold">سؤال {index + 1}: {q.question_text}</p>
                                                <p className="text-sm text-gray-600">النوع: {q.question_type === 'multiple_choice' ? 'اختيار من متعدد' : 'مقالي'} | الدرجة: {q.points}</p>
                                                {q.question_image && <p className="text-xs text-blue-600">✓ يحتوي على صورة</p>}
                                            </div>
                                            <Button
                                                size="sm"
                                                variant="destructive"
                                                onClick={() => removeQuestion(index)}
                                            >
                                                <Trash2 className="h-4 w-4" />
                                            </Button>
                                        </div>
                                    </CardContent>
                                </Card>
                            ))}

                            {/* Add New Question */}
                            <Card className="mt-6 bg-cyan-50 border-cyan-200">
                                <CardHeader>
                                    <CardTitle className="text-lg flex items-center gap-2">
                                        <Plus className="h-5 w-5" />
                                        إضافة سؤال جديد
                                    </CardTitle>
                                </CardHeader>
                                <CardContent className="space-y-4">
                                    <div>
                                        <Label>نوع السؤال *</Label>
                                        <Select
                                            value={currentQuestion.question_type}
                                            onValueChange={(value: 'multiple_choice' | 'essay') =>
                                                setCurrentQuestion({ ...currentQuestion, question_type: value })
                                            }
                                        >
                                            <SelectTrigger>
                                                <SelectValue />
                                            </SelectTrigger>
                                            <SelectContent>
                                                <SelectItem value="multiple_choice">اختيار من متعدد</SelectItem>
                                                <SelectItem value="essay">سؤال مقالي</SelectItem>
                                            </SelectContent>
                                        </Select>
                                    </div>

                                    <div>
                                        <Label>نص السؤال *</Label>
                                        <Textarea
                                            value={currentQuestion.question_text}
                                            onChange={(e) => setCurrentQuestion({ ...currentQuestion, question_text: e.target.value })}
                                            placeholder="اكتب السؤال هنا..."
                                            rows={3}
                                        />
                                    </div>

                                    {/* Image Upload */}
                                    <div>
                                        <Label>صورة السؤال (اختياري)</Label>
                                        <div className="flex items-center gap-3">
                                            <Input
                                                type="file"
                                                accept="image/*"
                                                onChange={async (e) => {
                                                    const file = e.target.files?.[0];
                                                    if (file) {
                                                        const formData = new FormData();
                                                        formData.append('image', file);

                                                        try {
                                                            const response = await fetch(`${API_URL}/exams/upload-question-image`, {
                                                                method: 'POST',
                                                                body: formData
                                                            });

                                                            const data = await response.json();
                                                            if (data.success) {
                                                                setCurrentQuestion({ ...currentQuestion, question_image: data.imageUrl });
                                                                toast({ title: 'تم رفع الصورة بنجاح' });
                                                            }
                                                        } catch (error) {
                                                            toast({ title: 'فشل رفع الصورة', variant: 'destructive' });
                                                        }
                                                    }
                                                }}
                                                className="max-w-xs"
                                            />
                                            {currentQuestion.question_image && (
                                                <img
                                                    src={`${import.meta.env.VITE_API_URL?.replace('/api', '')}${currentQuestion.question_image}`}
                                                    alt="Preview"
                                                    className="h-16 w-16 object-cover rounded border"
                                                />
                                            )}
                                        </div>
                                    </div>

                                    {currentQuestion.question_type === 'multiple_choice' && (
                                        <>
                                            <div className="grid grid-cols-2 gap-3">
                                                <div>
                                                    <Label>الخيار أ *</Label>
                                                    <Input
                                                        value={currentQuestion.option_a}
                                                        onChange={(e) => setCurrentQuestion({ ...currentQuestion, option_a: e.target.value })}
                                                    />
                                                </div>
                                                <div>
                                                    <Label>الخيار ب *</Label>
                                                    <Input
                                                        value={currentQuestion.option_b}
                                                        onChange={(e) => setCurrentQuestion({ ...currentQuestion, option_b: e.target.value })}
                                                    />
                                                </div>
                                                <div>
                                                    <Label>الخيار ج *</Label>
                                                    <Input
                                                        value={currentQuestion.option_c}
                                                        onChange={(e) => setCurrentQuestion({ ...currentQuestion, option_c: e.target.value })}
                                                    />
                                                </div>
                                                <div>
                                                    <Label>الخيار د *</Label>
                                                    <Input
                                                        value={currentQuestion.option_d}
                                                        onChange={(e) => setCurrentQuestion({ ...currentQuestion, option_d: e.target.value })}
                                                    />
                                                </div>
                                            </div>

                                            <div className="grid grid-cols-2 gap-3">
                                                <div>
                                                    <Label>الإجابة الصحيحة *</Label>
                                                    <Select
                                                        value={currentQuestion.correct_answer || 'a'}
                                                        onValueChange={(value) => setCurrentQuestion({ ...currentQuestion, correct_answer: value as 'a' | 'b' | 'c' | 'd' })}
                                                    >
                                                        <SelectTrigger>
                                                            <SelectValue />
                                                        </SelectTrigger>
                                                        <SelectContent>
                                                            <SelectItem value="a">الخيار أ</SelectItem>
                                                            <SelectItem value="b">الخيار ب</SelectItem>
                                                            <SelectItem value="c">الخيار ج</SelectItem>
                                                            <SelectItem value="d">الخيار د</SelectItem>
                                                        </SelectContent>
                                                    </Select>
                                                </div>
                                                <div>
                                                    <Label>درجة السؤال *</Label>
                                                    <Input
                                                        type="number"
                                                        value={currentQuestion.points}
                                                        onChange={(e) => setCurrentQuestion({ ...currentQuestion, points: parseInt(e.target.value) })}
                                                        min="1"
                                                    />
                                                </div>
                                            </div>
                                        </>
                                    )}

                                    {currentQuestion.question_type === 'essay' && (
                                        <div>
                                            <Label>درجة السؤال *</Label>
                                            <Input
                                                type="number"
                                                value={currentQuestion.points}
                                                onChange={(e) => setCurrentQuestion({ ...currentQuestion, points: parseInt(e.target.value) })}
                                                min="1"
                                            />
                                        </div>
                                    )}

                                    <Button
                                        type="button"
                                        onClick={addQuestion}
                                        variant="outline"
                                        className="w-full border-cyan-600 text-cyan-600 hover:bg-cyan-50"
                                    >
                                        <Plus className="h-4 w-4 ml-2" />
                                        إضافة السؤال
                                    </Button>
                                </CardContent>
                            </Card>
                        </div>
                    </CardContent>
                </Card>
            </div>
        </div>
    );
}
