import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Badge } from '@/components/ui/badge';
import { useToast } from '@/hooks/use-toast';
import { getCourses, getExams as getExamsHttp, getGrades, getGroups, Course, Exam, Grade, User, Group } from '@/lib/api-http';
import { ClipboardCheck, Plus, Trash2, BookOpen, Clock, Edit, GraduationCap, Image as ImageIcon } from 'lucide-react';
import Header from '@/components/Header';
import { motion } from 'framer-motion';

const API_URL = import.meta.env.VITE_API_URL || '/api';

interface Question {
  question_text: string;
  question_image?: string;  // ✅ صورة السؤال
  question_type: 'multiple_choice' | 'essay';  // ✅ نوع السؤال
  option_a?: string;
  option_b?: string;
  option_c?: string;
  option_d?: string;
  correct_answer?: 'a' | 'b' | 'c' | 'd';
  marks: number;
}

export default function TeacherExams() {
  const { toast } = useToast();
  const navigate = useNavigate();
  const [courses, setCourses] = useState<Course[]>([]);
  const [exams, setExams] = useState<Exam[]>([]);
  const [grades, setGrades] = useState<Grade[]>([]);
  const [groups, setGroups] = useState<Group[]>([]);
  const [selectedCourse, setSelectedCourse] = useState<string>('');
  const [selectedGroupIds, setSelectedGroupIds] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [questions, setQuestions] = useState<Question[]>([]);

  const [examData, setExamData] = useState({
    title: '',
    description: '',
    grade_id: '',
    duration_minutes: '60',
    passing_score: '60',
    start_date: '',
    end_date: '',
  });

  const [currentQuestion, setCurrentQuestion] = useState<Question>({
    question_text: '',
    question_image: '',
    question_type: 'multiple_choice',
    option_a: '',
    option_b: '',
    option_c: '',
    option_d: '',
    correct_answer: 'a',
    marks: 1
  });

  // Check authentication
  useEffect(() => {
    const userStr = localStorage.getItem('currentUser');
    const user: User | null = userStr ? JSON.parse(userStr) : null;

    if (!user || (user.role !== 'teacher' && user.role !== 'admin')) {
      navigate('/auth');
      return;
    }

    loadCourses();
    loadGrades();
    loadGroups();
    loadExams();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const loadCourses = async () => {
    try {
      const data = await getCourses();
      setCourses(data || []);
    } catch (error) {
      console.error('Error loading courses:', error);
      toast({
        title: 'خطأ',
        description: 'فشل تحميل الدورات',
        variant: 'destructive'
      });
    }
  };

  const loadGrades = async () => {
    try {
      const data = await getGrades();
      setGrades(data || []);
    } catch (error) {
      console.error('Error loading grades:', error);
    }
  };

  const loadGroups = async () => {
    try {
      const data = await getGroups();
      setGroups(data || []);
    } catch (error) {
      console.error('Error loading groups:', error);
    }
  };

  const loadExams = async () => {
    try {
      console.log('📚 Loading exams from MySQL...');
      const data = await getExamsHttp();
      console.log('✅ Exams loaded from MySQL:', data);
      setExams(data || []);
    } catch (error) {
      console.error('❌ Error loading exams:', error);
    }
  };

  const addQuestion = () => {
    // Validation based on question type
    if (!currentQuestion.question_text) {
      toast({
        title: 'خطأ',
        description: 'يرجى كتابة نص السؤال',
        variant: 'destructive'
      });
      return;
    }

    if (currentQuestion.question_type === 'multiple_choice') {
      if (!currentQuestion.option_a || !currentQuestion.option_b) {
        toast({
          title: 'خطأ',
          description: 'يرجى ملء خيارين على الأقل للسؤال',
          variant: 'destructive'
        });
        return;
      }
    }

    setQuestions([...questions, currentQuestion]);
    setCurrentQuestion({
      question_text: '',
      question_image: '',
      question_type: 'multiple_choice',
      option_a: '',
      option_b: '',
      option_c: '',
      option_d: '',
      correct_answer: 'a',
      marks: 1
    });

    toast({
      title: 'تم الإضافة',
      description: 'تم إضافة السؤال إلى الامتحان'
    });
  };

  const removeQuestion = (index: number) => {
    setQuestions(questions.filter((_, i) => i !== index));
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    if (!selectedCourse || !examData.title || questions.length === 0) {
      toast({
        title: 'خطأ',
        description: 'يرجى ملء جميع الحقول وإضافة أسئلة',
        variant: 'destructive'
      });
      return;
    }

    if (!examData.grade_id) {
      toast({
        title: 'خطأ',
        description: 'يرجى اختيار الصف الدراسي',
        variant: 'destructive'
      });
      return;
    }

    if (selectedGroupIds.length === 0) {
      toast({
        title: 'خطأ',
        description: 'يرجى اختيار مجموعة واحدة على الأقل',
        variant: 'destructive'
      });
      return;
    }

    setLoading(true);
    try {
      // Calculate totals and passing from percentage
      const totalMarks = questions.reduce((sum, q) => sum + (q.marks || 0), 0);
      const rawPercent = parseInt(examData.passing_score || '0');
      const passingPercent = Math.max(0, Math.min(100, isNaN(rawPercent) ? 0 : rawPercent));
      const passingMarksCalc = Math.ceil((passingPercent / 100) * totalMarks);

      // Create exam via Backend API
      // Normalize date/time for backend (expects exam_date + start_time/end_time derived)
      const formatDateTime = (value: string | undefined) => {
        if (!value) return null;
        // value from <input type="datetime-local"> like 2025-11-24T13:30
        if (/T/.test(value) && !/Z$/.test(value)) {
          const [d, t] = value.split('T');
          return `${d} ${t}:00`; // ensure seconds component
        }
        try {
          const d = new Date(value);
          if (isNaN(d.getTime())) return null;
          const pad = (n: number) => String(n).padStart(2, '0');
          return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:00`;
        } catch {
          return null;
        }
      };

      const startDateTime = formatDateTime(examData.start_date) || new Date().toISOString().replace('T', ' ').substring(0, 19);
      const endDateTime = formatDateTime(examData.end_date) || new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString().replace('T', ' ').substring(0, 19);

      const response = await fetch(`${API_URL}/exams`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${localStorage.getItem('authToken') || ''}`
        },
        body: JSON.stringify({
          course_id: selectedCourse,
          grade_id: examData.grade_id || null,  // ✅ Include grade_id
          group_ids: selectedGroupIds.length > 0 ? selectedGroupIds : null, // ✅ Include group_ids
          title: examData.title,
          description: examData.description || null,
          duration_minutes: parseInt(examData.duration_minutes),
          total_marks: totalMarks,
          passing_marks: passingMarksCalc, // computed from percentage
          passing_percentage: passingPercent,
          is_active: true,
          // Provide both unified ISO strings; backend will extract DATE() and TIME()
          start_date: startDateTime,
          end_date: endDateTime,
          start_time: startDateTime,
          end_time: endDateTime
        })
      });

      if (!response.ok) throw new Error('Failed to create exam');
      const examResult = await response.json();

      // Insert questions via Backend API
      for (let i = 0; i < questions.length; i++) {
        const question = questions[i];

        // ✅ Prepare options based on question type
        let options = null;
        let correctAnswer = null;

        if (question.question_type === 'multiple_choice') {
          options = JSON.stringify({
            a: question.option_a,
            b: question.option_b,
            c: question.option_c,
            d: question.option_d
          });
          correctAnswer = question.correct_answer;
        }

        const response = await fetch(`${API_URL}/exams/${examResult.id}/questions`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${localStorage.getItem('token') || ''}`
          },
          body: JSON.stringify({
            question_text: question.question_text,
            question_image: question.question_image || null,  // ✅ Include image
            question_type: question.question_type,  // ✅ Include type
            options: options,
            correct_answer: correctAnswer,
            points: question.marks,
            display_order: i + 1
          })
        });

        if (!response.ok) {
          throw new Error(`Failed to add question ${i + 1}`);
        }
      }

      toast({
        title: 'نجح',
        description: `تم إنشاء الامتحان بنجاح مع ${questions.length} سؤال`
      });

      // Reset form
      setExamData({
        title: '',
        description: '',
        grade_id: '',
        duration_minutes: '60',
        passing_score: '60',
        start_date: '',
        end_date: '',
      });
      setQuestions([]);
      setSelectedCourse('');
      loadExams();
    } catch (error) {
      console.error('Error creating exam:', error);
      toast({
        title: 'خطأ',
        description: 'فشل إنشاء الامتحان',
        variant: 'destructive'
      });
    } finally {
      setLoading(false);
    }
  };

  const handleDeleteExam = async (id: string) => {
    if (!confirm('هل أنت متأكد من حذف هذا الامتحان؟')) return;

    try {
      console.log('🗑️ Deleting exam:', id);
      // Delete exam via Backend API (should cascade delete questions)
      const response = await fetch(`${API_URL}/exams/${id}`, {
        method: 'DELETE',
        headers: {
          'Authorization': `Bearer ${localStorage.getItem('token') || ''}`
        }
      });

      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.error || 'Failed to delete exam');
      }

      console.log('✅ Exam deleted successfully');
      toast({
        title: 'نجح',
        description: 'تم حذف الامتحان'
      });
      loadExams();
    } catch (error) {
      console.error('❌ Error deleting exam:', error);
      toast({
        title: 'خطأ',
        description: 'فشل حذف الامتحان',
        variant: 'destructive'
      });
    }
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-50 via-cyan-50 to-teal-50 dark:from-slate-900 dark:via-cyan-950 dark:to-teal-950">
      <Header />

      <div className="w-full px-4 py-8 space-y-6" dir="rtl">
        <div className="max-w-7xl mx-auto">
          {/* Page Header */}
          <motion.div
            initial={{ opacity: 0, y: -20 }}
            animate={{ opacity: 1, y: 0 }}
            className="flex items-center gap-3 mb-8"
          >
            <div className="p-3 bg-gradient-to-br from-cyan-500 to-teal-600 rounded-xl shadow-lg">
              <ClipboardCheck className="h-8 w-8 text-white" />
            </div>
            <div>
              <h1 className="text-3xl font-bold bg-gradient-to-r from-cyan-600 to-teal-600 bg-clip-text text-transparent">
                إنشاء الامتحانات
              </h1>
              <p className="text-sm text-muted-foreground mt-1">
                أنشئ امتحانات وأضف أسئلة للطلاب
              </p>
            </div>
          </motion.div>

          <div className="grid grid-cols-1 lg:grid-cols-4 gap-4 lg:gap-6">
            {/* Create Exam Form */}
            <Card className="lg:col-span-3 shadow-lg border-t-4 border-t-cyan-500">
              <CardHeader className="bg-gradient-to-r from-cyan-50 to-teal-50 dark:from-gray-800 dark:to-gray-700">
                <CardTitle className="flex items-center gap-2">
                  <ClipboardCheck className="h-5 w-5 text-cyan-600" />
                  إنشاء امتحان جديد
                </CardTitle>
              </CardHeader>
              <CardContent className="pt-6">
                <form onSubmit={handleSubmit} className="space-y-6">
                  {/* Exam Basic Info */}
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    <div className="md:col-span-2">
                      <Label>اختر الدورة *</Label>
                      <Select
                        value={selectedCourse}
                        onValueChange={(value) => {
                          setSelectedCourse(value);
                          // Reset grade and groups when course changes
                          setExamData({ ...examData, grade_id: '' });
                          setSelectedGroupIds([]);
                        }}
                      >
                        <SelectTrigger>
                          <SelectValue placeholder="اختر الدورة" />
                        </SelectTrigger>
                        <SelectContent>
                          {courses.map(c => (
                            <SelectItem key={c.id} value={c.id}>
                              <div className="flex items-center gap-2">
                                <BookOpen className="h-4 w-4 text-cyan-500" />
                                {c.name}
                              </div>
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>

                    <div className="md:col-span-2">
                      <Label>الصف الدراسي *</Label>
                      <Select
                        value={examData.grade_id}
                        onValueChange={(value) => {
                          setExamData({ ...examData, grade_id: value });
                          // Reset groups when grade changes
                          setSelectedGroupIds([]);
                        }}
                      >
                        <SelectTrigger>
                          <SelectValue placeholder="اختر الصف الدراسي" />
                        </SelectTrigger>
                        <SelectContent>
                          {grades
                            .filter(grade => {
                              if (!selectedCourse) return true;
                              const course = courses.find(c => c.id === selectedCourse);
                              return !course?.grade || grade.name === course.grade;
                            })
                            .map(grade => (
                              <SelectItem key={grade.id} value={grade.id}>
                                <div className="flex items-center gap-2">
                                  <GraduationCap className="h-4 w-4 text-purple-500" />
                                  {grade.name}
                                </div>
                              </SelectItem>
                            ))}
                        </SelectContent>
                      </Select>
                    </div>

                    {/* ✅ Group Selection */}
                    {examData.grade_id && (
                      <div className="md:col-span-2">
                        <Label>المجموعات *</Label>
                        <div className="flex flex-wrap gap-2 mt-2 p-3 bg-gray-50 rounded-lg border">
                          {groups
                            .filter(g => g.grade_id === examData.grade_id)
                            .map(group => (
                              <label key={group.id} className="flex items-center gap-2 cursor-pointer">
                                <input
                                  type="checkbox"
                                  checked={selectedGroupIds.includes(group.id)}
                                  onChange={(e) => {
                                    if (e.target.checked) {
                                      setSelectedGroupIds([...selectedGroupIds, group.id]);
                                    } else {
                                      setSelectedGroupIds(selectedGroupIds.filter(id => id !== group.id));
                                    }
                                  }}
                                  className="rounded"
                                />
                                <span className="text-sm">{group.name}</span>
                              </label>
                            ))}
                        </div>
                      </div>
                    )}

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
                        placeholder="وصف مختصر للامتحان..."
                        rows={2}
                      />
                    </div>

                    <div>
                      <Label>مدة الامتحان (بالدقائق) *</Label>
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
                      <Label>تاريخ البداية</Label>
                      <Input
                        type="datetime-local"
                        value={examData.start_date}
                        onChange={(e) => setExamData({ ...examData, start_date: e.target.value })}
                      />
                    </div>

                    <div>
                      <Label>تاريخ النهاية</Label>
                      <Input
                        type="datetime-local"
                        value={examData.end_date}
                        onChange={(e) => setExamData({ ...examData, end_date: e.target.value })}
                      />
                    </div>
                  </div>

                  {/* Live Summary */}
                  {(() => {
                    const totalMarksPreview = questions.reduce((sum, q) => sum + (q.marks || 0), 0);
                    const p = Math.max(0, Math.min(100, parseInt(examData.passing_score || '0') || 0));
                    const passingMarksPreview = Math.ceil((p / 100) * totalMarksPreview);
                    return (
                      <div className="rounded-md bg-primary/5 p-4 text-sm flex flex-wrap gap-4">
                        <span>الدرجة الكلية المتوقعة: <b>{totalMarksPreview}</b></span>
                        <span>درجة النجاح: <b>{passingMarksPreview}</b> ({p}%)</span>
                      </div>
                    );
                  })()}

                  {/* Add Question Section */}
                  <div className="border-t pt-6">
                    <h3 className="text-lg font-semibold mb-4 flex items-center gap-2">
                      <Plus className="h-5 w-5 text-cyan-600" />
                      إضافة سؤال
                    </h3>

                    <div className="space-y-4">
                      {/* ✅ Question Type Selection */}
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

                      {/* Question Text */}
                      <div>
                        <Label>نص السؤال *</Label>
                        <Textarea
                          value={currentQuestion.question_text}
                          onChange={(e) => setCurrentQuestion({ ...currentQuestion, question_text: e.target.value })}
                          placeholder="اكتب السؤال هنا..."
                          rows={3}
                        />
                      </div>

                      {/* ✅ Question Image Upload */}
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

                      {/* ✅ Show options only for multiple choice */}
                      {currentQuestion.question_type === 'multiple_choice' && (
                        <>
                          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                            <div>
                              <Label>الخيار أ *</Label>
                              <Input
                                value={currentQuestion.option_a}
                                onChange={(e) => setCurrentQuestion({ ...currentQuestion, option_a: e.target.value })}
                                placeholder="الخيار الأول"
                              />
                            </div>
                            <div>
                              <Label>الخيار ب *</Label>
                              <Input
                                value={currentQuestion.option_b}
                                onChange={(e) => setCurrentQuestion({ ...currentQuestion, option_b: e.target.value })}
                                placeholder="الخيار الثاني"
                              />
                            </div>
                            <div>
                              <Label>الخيار ج</Label>
                              <Input
                                value={currentQuestion.option_c}
                                onChange={(e) => setCurrentQuestion({ ...currentQuestion, option_c: e.target.value })}
                                placeholder="الخيار الثالث"
                              />
                            </div>
                            <div>
                              <Label>الخيار د</Label>
                              <Input
                                value={currentQuestion.option_d}
                                onChange={(e) => setCurrentQuestion({ ...currentQuestion, option_d: e.target.value })}
                                placeholder="الخيار الرابع"
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
                                value={currentQuestion.marks}
                                onChange={(e) => setCurrentQuestion({ ...currentQuestion, marks: parseInt(e.target.value) })}
                                min="1"
                              />
                            </div>
                          </div>
                        </>
                      )}

                      {/* ✅ Essay question - only marks */}
                      {currentQuestion.question_type === 'essay' && (
                        <div>
                          <Label>درجة السؤال *</Label>
                          <Input
                            type="number"
                            value={currentQuestion.marks}
                            onChange={(e) => setCurrentQuestion({ ...currentQuestion, marks: parseInt(e.target.value) })}
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
                    </div>
                  </div>

                  {/* Questions List */}
                  {questions.length > 0 && (
                    <div className="border-t pt-6">
                      <h3 className="text-lg font-semibold mb-4">
                        الأسئلة المضافة ({questions.length})
                      </h3>
                      <div className="space-y-3 max-h-64 overflow-y-auto">
                        {questions.map((q, index) => (
                          <div key={index} className="p-3 bg-cyan-50 dark:bg-gray-800 rounded-lg flex justify-between items-start">
                            <div className="flex-1">
                              <div className="flex items-center gap-2 mb-1">
                                <p className="font-medium">{index + 1}. {q.question_text}</p>
                                <span className="text-xs bg-blue-100 text-blue-700 px-2 py-1 rounded">
                                  {q.question_type === 'essay' ? 'مقالي' : 'اختيار من متعدد'}
                                </span>
                              </div>
                              <p className="text-sm text-muted-foreground mt-1">
                                {q.question_type === 'multiple_choice' && q.correct_answer
                                  ? `الإجابة: ${q.correct_answer.toUpperCase()} | `
                                  : ''}
                                الدرجة: {q.marks}
                              </p>
                              {q.question_image && (
                                <p className="text-xs text-muted-foreground mt-1 flex items-center gap-1">
                                  <ImageIcon className="h-3 w-3" />
                                  يحتوي على صورة
                                </p>
                              )}
                            </div>
                            <Button
                              type="button"
                              variant="ghost"
                              size="sm"
                              onClick={() => removeQuestion(index)}
                              className="text-red-600 hover:text-red-700"
                            >
                              <Trash2 className="h-4 w-4" />
                            </Button>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  <Button
                    type="submit"
                    disabled={loading || questions.length === 0}
                    className="w-full bg-gradient-to-r from-cyan-600 to-teal-600 hover:from-cyan-700 hover:to-teal-700"
                  >
                    {loading ? 'جاري الإنشاء...' : (
                      <>
                        <ClipboardCheck className="h-4 w-4 ml-2" />
                        إنشاء الامتحان ({questions.length} سؤال)
                      </>
                    )}
                  </Button>
                </form>
              </CardContent>
            </Card>

            {/* Exams List */}
            <Card className="shadow-lg border-t-4 border-t-cyan-500">
              <CardHeader className="bg-gradient-to-r from-cyan-50 to-teal-50 dark:from-gray-800 dark:to-gray-700">
                <CardTitle className="flex items-center gap-2">
                  <ClipboardCheck className="h-5 w-5 text-cyan-600" />
                  الامتحانات
                </CardTitle>
              </CardHeader>
              <CardContent className="pt-6">
                {exams.length === 0 ? (
                  <div className="text-center py-8">
                    <ClipboardCheck className="h-12 w-12 text-gray-300 mx-auto mb-3" />
                    <p className="text-sm text-gray-600">لا توجد امتحانات</p>
                  </div>
                ) : (
                  <div className="space-y-3">
                    {exams.map((exam) => (
                      <motion.div
                        key={exam.id}
                        initial={{ opacity: 0, y: 20 }}
                        animate={{ opacity: 1, y: 0 }}
                        className="p-4 border rounded-lg hover:shadow-md transition-all bg-white dark:bg-gray-800"
                      >
                        <div className="flex justify-between items-start mb-2">
                          <h4 className="font-bold">{exam.title}</h4>
                          <div className="flex gap-2">
                            <Button
                              variant="ghost"
                              size="sm"
                              onClick={() => navigate(`/teacher/exams/${exam.id}/edit`)}
                              className="text-blue-600 hover:text-blue-700"
                            >
                              <Edit className="h-4 w-4" />
                            </Button>
                            <Button
                              variant="ghost"
                              size="sm"
                              onClick={() => handleDeleteExam(exam.id)}
                              className="text-red-600 hover:text-red-700"
                            >
                              <Trash2 className="h-4 w-4" />
                            </Button>
                          </div>
                        </div>
                        <div className="space-y-1 text-xs">
                          <Badge variant="outline">
                            {courses.find(c => c.id === exam.course_id)?.name || 'دورة غير محددة'}
                          </Badge>
                          <p className="flex items-center gap-1 text-muted-foreground">
                            <Clock className="h-3 w-3" />
                            {exam.duration_minutes} دقيقة
                          </p>
                          <p className="text-muted-foreground">
                            الدرجة الكلية: {exam.total_marks}
                          </p>
                        </div>
                      </motion.div>
                    ))}
                  </div>
                )}
              </CardContent>
            </Card>
          </div>
        </div>
      </div>
    </div>
  );
}
