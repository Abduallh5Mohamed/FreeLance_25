import { useState, useEffect } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { useToast } from '@/hooks/use-toast';
import { getExamById, User, getCourses, getGrades, getGroups, Course, Grade, Group } from '@/lib/api-http';
import { ClipboardCheck, Plus, Trash2, Edit2, Save, ArrowLeft, Image as ImageIcon } from 'lucide-react';
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
  const [exam, setExam] = useState<any>(null);
  const [questions, setQuestions] = useState<Question[]>([]);
  const [editingQuestion, setEditingQuestion] = useState<Question | null>(null);
  const [editingExamDetails, setEditingExamDetails] = useState(false);
  const [addingNewQuestion, setAddingNewQuestion] = useState(false);
  const [newQuestion, setNewQuestion] = useState<Question>({
    question_text: '',
    question_type: 'multiple_choice',
    option_a: '',
    option_b: '',
    option_c: '',
    option_d: '',
    correct_answer: 'a',
    points: 1
  });

  // Lists for dropdowns
  const [courses, setCourses] = useState<Course[]>([]);
  const [grades, setGrades] = useState<Grade[]>([]);
  const [groups, setGroups] = useState<Group[]>([]);

  // Filtered groups based on selected grade
  const filteredGroups = exam?.grade_id && exam.grade_id !== 'all'
    ? groups.filter(g => g.grade_id === exam.grade_id)
    : groups;

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
    loadExamData();
  }, [examId]);

  const loadCourses = async () => {
    try {
      const data = await getCourses();
      setCourses(data || []);
    } catch (error) {
      console.error('Error loading courses:', error);
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

  const loadExamData = async () => {
    try {
      setLoading(true);

      // Load exam details
      const examData = await getExamById(examId!);

      // Convert ISO dates to local datetime-local format (YYYY-MM-DDTHH:mm)
      if (examData.start_time) {
        const startDate = new Date(examData.start_time);
        examData.start_time = startDate.getFullYear() + '-' +
          String(startDate.getMonth() + 1).padStart(2, '0') + '-' +
          String(startDate.getDate()).padStart(2, '0') + 'T' +
          String(startDate.getHours()).padStart(2, '0') + ':' +
          String(startDate.getMinutes()).padStart(2, '0');
      }

      if (examData.end_time) {
        const endDate = new Date(examData.end_time);
        examData.end_time = endDate.getFullYear() + '-' +
          String(endDate.getMonth() + 1).padStart(2, '0') + '-' +
          String(endDate.getDate()).padStart(2, '0') + 'T' +
          String(endDate.getHours()).padStart(2, '0') + ':' +
          String(endDate.getMinutes()).padStart(2, '0');
      }

      setExam(examData);

      // Load questions
      const response = await fetch(`${API_URL}/exams/${examId}/questions`);
      const questionsData = await response.json();

      // Parse options for multiple choice questions
      const parsedQuestions = questionsData.map((q: any) => {
        // Check if options is already an object or needs parsing
        let options = q.options;
        if (typeof options === 'string') {
          try {
            options = JSON.parse(options);
          } catch (e) {
            options = {};
          }
        }

        return {
          ...q,
          option_a: options?.a || '',
          option_b: options?.b || '',
          option_c: options?.c || '',
          option_d: options?.d || '',
        };
      });

      setQuestions(parsedQuestions);
    } catch (error) {
      console.error('Error loading exam:', error);
      toast({
        title: 'خطأ',
        description: 'فشل تحميل بيانات الامتحان',
        variant: 'destructive'
      });
    } finally {
      setLoading(false);
    }
  };

  const handleUpdateExamDetails = async () => {
    try {
      // Format dates properly for MySQL - keep local time
      const formatDateTime = (dateStr: string) => {
        if (!dateStr) return null;
        // dateStr is already in format YYYY-MM-DDTHH:mm from datetime-local input
        // Just replace T with space for MySQL format: YYYY-MM-DD HH:mm:ss
        return dateStr.replace('T', ' ') + ':00';
      };

      const updateData = {
        title: exam.title,
        course_id: exam.course_id,
        grade_id: exam.grade_id === 'all' ? null : exam.grade_id,
        group_id: exam.group_id === 'all' ? null : exam.group_id,
        start_time: formatDateTime(exam.start_time),
        end_time: formatDateTime(exam.end_time),
        duration: exam.duration
      };

      console.log('🔄 Updating exam with data:', updateData);

      const response = await fetch(`${API_URL}/exams/${examId}`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${localStorage.getItem('authToken') || ''}`
        },
        body: JSON.stringify(updateData)
      });

      if (!response.ok) {
        const errorData = await response.json();
        console.error('❌ Update failed:', errorData);
        throw new Error('Failed to update exam');
      }

      const result = await response.json();
      console.log('✅ Update successful:', result);

      toast({
        title: 'تم التحديث',
        description: 'تم تحديث بيانات الامتحان بنجاح'
      });

      setEditingExamDetails(false);
      loadExamData();
    } catch (error) {
      console.error('❌ Error updating exam:', error);
      toast({
        title: 'خطأ',
        description: 'فشل تحديث بيانات الامتحان',
        variant: 'destructive'
      });
    }
  };

  const handleUpdateQuestion = async (question: Question) => {
    try {
      const options = question.question_type === 'multiple_choice'
        ? JSON.stringify({
          a: question.option_a,
          b: question.option_b,
          c: question.option_c,
          d: question.option_d
        })
        : null;

      const response = await fetch(`${API_URL}/exams/${examId}/questions/${question.id}`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${localStorage.getItem('authToken') || ''}`
        },
        body: JSON.stringify({
          question_text: question.question_text,
          question_image: question.question_image || null,
          question_type: question.question_type,
          options: options,
          correct_answer: question.correct_answer || null,
          points: question.points,
          explanation: null
        })
      });

      if (!response.ok) throw new Error('Failed to update question');

      toast({
        title: 'تم التحديث',
        description: 'تم تحديث السؤال بنجاح'
      });

      setEditingQuestion(null);
      loadExamData();
    } catch (error) {
      toast({
        title: 'خطأ',
        description: 'فشل تحديث السؤال',
        variant: 'destructive'
      });
    }
  };

  const handleDeleteQuestion = async (questionId: string) => {
    if (!confirm('هل أنت متأكد من حذف هذا السؤال؟')) return;

    try {
      const response = await fetch(`${API_URL}/exams/${examId}/questions/${questionId}`, {
        method: 'DELETE',
        headers: {
          'Authorization': `Bearer ${localStorage.getItem('authToken') || ''}`
        }
      });

      if (!response.ok) throw new Error('Failed to delete question');

      toast({
        title: 'تم الحذف',
        description: 'تم حذف السؤال بنجاح'
      });

      loadExamData();
    } catch (error) {
      toast({
        title: 'خطأ',
        description: 'فشل حذف السؤال',
        variant: 'destructive'
      });
    }
  };

  const handleAddNewQuestion = async () => {
    try {
      const options = newQuestion.question_type === 'multiple_choice'
        ? JSON.stringify({
          a: newQuestion.option_a,
          b: newQuestion.option_b,
          c: newQuestion.option_c,
          d: newQuestion.option_d
        })
        : null;

      const response = await fetch(`${API_URL}/exams/${examId}/questions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${localStorage.getItem('authToken') || ''}`
        },
        body: JSON.stringify({
          question_text: newQuestion.question_text,
          question_image: newQuestion.question_image || null,
          question_type: newQuestion.question_type,
          options: options,
          correct_answer: newQuestion.correct_answer || null,
          points: newQuestion.points,
          explanation: null
        })
      });

      if (!response.ok) throw new Error('Failed to add question');

      toast({
        title: 'تم الإضافة',
        description: 'تم إضافة السؤال بنجاح'
      });

      // Reset form
      setNewQuestion({
        question_text: '',
        question_type: 'multiple_choice',
        option_a: '',
        option_b: '',
        option_c: '',
        option_d: '',
        correct_answer: 'a',
        points: 1
      });
      setAddingNewQuestion(false);
      loadExamData();
    } catch (error) {
      toast({
        title: 'خطأ',
        description: 'فشل إضافة السؤال',
        variant: 'destructive'
      });
    }
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

  if (!exam) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-gray-50 to-gray-100">
        <Header />
        <div className="flex items-center justify-center h-screen">
          <p>لم يتم العثور على الامتحان</p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gradient-to-br from-gray-50 to-gray-100">
      <Header />
      <div className="container mx-auto px-4 py-8">
        <div className="mb-6">
          <Button
            variant="outline"
            onClick={() => navigate('/teacher-exams')}
            className="mb-4"
          >
            <ArrowLeft className="h-4 w-4 ml-2" />
            العودة للامتحانات
          </Button>

          <h1 className="text-3xl font-bold bg-gradient-to-r from-cyan-600 to-teal-600 bg-clip-text text-transparent">
            تعديل امتحان: {exam.title}
          </h1>
        </div>

        {/* Exam Details Card */}
        <Card className="shadow-lg mb-6">
          <CardHeader className="bg-gradient-to-r from-purple-50 to-pink-50">
            <div className="flex justify-between items-center">
              <CardTitle className="flex items-center gap-2">
                <ClipboardCheck className="h-5 w-5 text-purple-600" />
                تفاصيل الامتحان
              </CardTitle>
              {!editingExamDetails && (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setEditingExamDetails(true)}
                  className="text-blue-600"
                >
                  <Edit2 className="h-4 w-4 ml-2" />
                  تعديل التفاصيل
                </Button>
              )}
            </div>
          </CardHeader>
          <CardContent className="pt-6">
            {editingExamDetails ? (
              <div className="space-y-4">
                <div>
                  <Label>عنوان الامتحان</Label>
                  <Input
                    value={exam?.title || ''}
                    onChange={(e) => setExam({ ...exam, title: e.target.value })}
                    placeholder="اكتب عنوان الامتحان"
                  />
                </div>

                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <div>
                    <Label>المادة</Label>
                    <Select
                      value={exam?.course_id || ''}
                      onValueChange={(value) => setExam({ ...exam, course_id: value })}
                    >
                      <SelectTrigger>
                        <SelectValue placeholder="اختر المادة" />
                      </SelectTrigger>
                      <SelectContent>
                        {courses.map((course) => (
                          <SelectItem key={course.id} value={course.id}>
                            {course.name}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>

                  <div>
                    <Label>الصف</Label>
                    <Select
                      value={exam?.grade_id || 'all'}
                      onValueChange={(value) => {
                        // Reset group when grade changes
                        setExam({ ...exam, grade_id: value, group_id: 'all' });
                      }}
                    >
                      <SelectTrigger>
                        <SelectValue placeholder="اختر الصف (اختياري)" />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="all">كل الصفوف</SelectItem>
                        {grades.map((grade) => (
                          <SelectItem key={grade.id} value={grade.id}>
                            {grade.name}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>

                  <div>
                    <Label>المجموعة</Label>
                    <Select
                      value={exam?.group_id || 'all'}
                      onValueChange={(value) => setExam({ ...exam, group_id: value })}
                    >
                      <SelectTrigger>
                        <SelectValue placeholder="اختر المجموعة (اختياري)" />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="all">كل المجموعات</SelectItem>
                        {filteredGroups.map((group) => (
                          <SelectItem key={group.id} value={group.id}>
                            {group.name}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>

                  <div>
                    <Label>المدة (بالدقائق)</Label>
                    <Input
                      type="number"
                      value={exam?.duration || ''}
                      onChange={(e) => setExam({ ...exam, duration: parseInt(e.target.value) || 0 })}
                    />
                  </div>
                </div>

                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <div>
                    <Label>وقت البداية</Label>
                    <Input
                      type="datetime-local"
                      value={exam?.start_time || ''}
                      onChange={(e) => setExam({ ...exam, start_time: e.target.value })}
                    />
                  </div>

                  <div>
                    <Label>وقت النهاية</Label>
                    <Input
                      type="datetime-local"
                      value={exam?.end_time || ''}
                      onChange={(e) => setExam({ ...exam, end_time: e.target.value })}
                    />
                  </div>
                </div>

                <div className="flex gap-2">
                  <Button
                    onClick={handleUpdateExamDetails}
                    className="bg-green-600 hover:bg-green-700"
                  >
                    <Save className="h-4 w-4 ml-2" />
                    حفظ التعديلات
                  </Button>
                  <Button
                    variant="outline"
                    onClick={() => {
                      setEditingExamDetails(false);
                      loadExamData(); // Reload to reset changes
                    }}
                  >
                    إلغاء
                  </Button>
                </div>
              </div>
            ) : (
              <div className="space-y-3">
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <div>
                    <span className="text-sm text-gray-500">المادة:</span>
                    <p className="font-semibold">{courses.find(c => c.id === exam.course_id)?.name || 'غير محدد'}</p>
                  </div>
                  <div>
                    <span className="text-sm text-gray-500">الصف:</span>
                    <p className="font-semibold">{exam.grade_id && exam.grade_id !== 'all' ? grades.find(g => g.id === exam.grade_id)?.name : 'كل الصفوف'}</p>
                  </div>
                  <div>
                    <span className="text-sm text-gray-500">المجموعة:</span>
                    <p className="font-semibold">{exam.group_id && exam.group_id !== 'all' ? groups.find(g => g.id === exam.group_id)?.name : 'كل المجموعات'}</p>
                  </div>
                  <div>
                    <span className="text-sm text-gray-500">المدة:</span>
                    <p className="font-semibold">{exam.duration} دقيقة</p>
                  </div>
                  <div>
                    <span className="text-sm text-gray-500">وقت البداية:</span>
                    <p className="font-semibold">{new Date(exam.start_time).toLocaleString('ar-EG')}</p>
                  </div>
                  <div>
                    <span className="text-sm text-gray-500">وقت النهاية:</span>
                    <p className="font-semibold">{new Date(exam.end_time).toLocaleString('ar-EG')}</p>
                  </div>
                </div>
              </div>
            )}
          </CardContent>
        </Card>

        <Card className="shadow-lg">
          <CardHeader className="bg-gradient-to-r from-cyan-50 to-teal-50">
            <div className="flex justify-between items-center">
              <CardTitle className="flex items-center gap-2">
                <ClipboardCheck className="h-5 w-5 text-cyan-600" />
                الأسئلة ({questions.length})
              </CardTitle>
              {!addingNewQuestion && (
                <Button
                  onClick={() => setAddingNewQuestion(true)}
                  className="bg-green-600 hover:bg-green-700"
                >
                  <Plus className="h-4 w-4 ml-2" />
                  إضافة سؤال جديد
                </Button>
              )}
            </div>
          </CardHeader>
          <CardContent className="pt-6">
            <div className="space-y-4">
              {/* Add New Question Form */}
              {addingNewQuestion && (
                <div className="border-2 border-green-200 rounded-lg p-4 bg-green-50">
                  <h3 className="text-lg font-semibold mb-4 text-green-700">إضافة سؤال جديد</h3>
                  <div className="space-y-4">
                    <div>
                      <Label>نوع السؤال</Label>
                      <Select
                        value={newQuestion.question_type}
                        onValueChange={(value: 'multiple_choice' | 'essay') =>
                          setNewQuestion({ ...newQuestion, question_type: value })
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
                      <Label>نص السؤال</Label>
                      <Textarea
                        value={newQuestion.question_text}
                        onChange={(e) =>
                          setNewQuestion({ ...newQuestion, question_text: e.target.value })
                        }
                        placeholder="اكتب نص السؤال هنا"
                      />
                    </div>

                    <div>
                      <Label>صورة السؤال (اختياري)</Label>
                      <div className="space-y-2">
                        <Input
                          type="file"
                          accept="image/*"
                          onChange={async (e) => {
                            const file = e.target.files?.[0];
                            if (file) {
                              try {
                                const formData = new FormData();
                                formData.append('image', file);

                                const response = await fetch(`${API_URL}/exams/upload-question-image`, {
                                  method: 'POST',
                                  body: formData
                                });

                                const result = await response.json();

                                if (result.success) {
                                  setNewQuestion({ ...newQuestion, question_image: result.imageUrl });
                                  toast({
                                    title: 'تم الرفع',
                                    description: 'تم رفع الصورة بنجاح'
                                  });
                                }
                              } catch (error) {
                                toast({
                                  title: 'خطأ',
                                  description: 'فشل رفع الصورة',
                                  variant: 'destructive'
                                });
                              }
                            }
                          }}
                        />
                        {newQuestion.question_image && (
                          <div className="relative">
                            <img
                              src={newQuestion.question_image.startsWith('http')
                                ? newQuestion.question_image
                                : `${API_URL.replace('/api', '')}${newQuestion.question_image}`
                              }
                              alt="معاينة"
                              className="max-w-xs rounded border"
                            />
                            <Button
                              type="button"
                              variant="destructive"
                              size="sm"
                              className="absolute top-2 right-2"
                              onClick={() => setNewQuestion({ ...newQuestion, question_image: '' })}
                            >
                              <Trash2 className="h-4 w-4" />
                            </Button>
                          </div>
                        )}
                      </div>
                    </div>

                    {newQuestion.question_type === 'multiple_choice' && (
                      <>
                        <div className="grid grid-cols-2 gap-3">
                          <div>
                            <Label>الخيار أ</Label>
                            <Input
                              value={newQuestion.option_a || ''}
                              onChange={(e) =>
                                setNewQuestion({ ...newQuestion, option_a: e.target.value })
                              }
                              placeholder="أدخل الخيار أ"
                            />
                          </div>
                          <div>
                            <Label>الخيار ب</Label>
                            <Input
                              value={newQuestion.option_b || ''}
                              onChange={(e) =>
                                setNewQuestion({ ...newQuestion, option_b: e.target.value })
                              }
                              placeholder="أدخل الخيار ب"
                            />
                          </div>
                          <div>
                            <Label>الخيار ج</Label>
                            <Input
                              value={newQuestion.option_c || ''}
                              onChange={(e) =>
                                setNewQuestion({ ...newQuestion, option_c: e.target.value })
                              }
                              placeholder="أدخل الخيار ج"
                            />
                          </div>
                          <div>
                            <Label>الخيار د</Label>
                            <Input
                              value={newQuestion.option_d || ''}
                              onChange={(e) =>
                                setNewQuestion({ ...newQuestion, option_d: e.target.value })
                              }
                              placeholder="أدخل الخيار د"
                            />
                          </div>
                        </div>

                        <div>
                          <Label>الإجابة الصحيحة</Label>
                          <Select
                            value={newQuestion.correct_answer || 'a'}
                            onValueChange={(value: 'a' | 'b' | 'c' | 'd') =>
                              setNewQuestion({ ...newQuestion, correct_answer: value })
                            }
                          >
                            <SelectTrigger>
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              <SelectItem value="a">أ</SelectItem>
                              <SelectItem value="b">ب</SelectItem>
                              <SelectItem value="c">ج</SelectItem>
                              <SelectItem value="d">د</SelectItem>
                            </SelectContent>
                          </Select>
                        </div>
                      </>
                    )}

                    <div>
                      <Label>الدرجة</Label>
                      <Input
                        type="number"
                        value={newQuestion.points}
                        onChange={(e) =>
                          setNewQuestion({ ...newQuestion, points: parseInt(e.target.value) || 1 })
                        }
                        placeholder="الدرجة المخصصة للسؤال"
                        min="1"
                      />
                    </div>

                    <div className="flex gap-2">
                      <Button
                        onClick={handleAddNewQuestion}
                        className="bg-green-600 hover:bg-green-700"
                        disabled={!newQuestion.question_text.trim()}
                      >
                        <Plus className="h-4 w-4 ml-2" />
                        إضافة السؤال
                      </Button>
                      <Button
                        variant="outline"
                        onClick={() => {
                          setAddingNewQuestion(false);
                          setNewQuestion({
                            question_text: '',
                            question_type: 'multiple_choice',
                            option_a: '',
                            option_b: '',
                            option_c: '',
                            option_d: '',
                            correct_answer: 'a',
                            points: 1
                          });
                        }}
                      >
                        إلغاء
                      </Button>
                    </div>
                  </div>
                </div>
              )}

              {/* Existing Questions */}
              {questions.map((question, index) => (
                <div key={question.id} className="border rounded-lg p-4 bg-white">
                  {editingQuestion?.id === question.id ? (
                    // Edit Mode
                    <div className="space-y-4">
                      <div>
                        <Label>نوع السؤال</Label>
                        <Select
                          value={editingQuestion.question_type}
                          onValueChange={(value: 'multiple_choice' | 'essay') =>
                            setEditingQuestion({ ...editingQuestion, question_type: value })
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
                        <Label>نص السؤال</Label>
                        <Textarea
                          value={editingQuestion.question_text}
                          onChange={(e) =>
                            setEditingQuestion({ ...editingQuestion, question_text: e.target.value })
                          }
                        />
                      </div>

                      <div>
                        <Label>صورة السؤال (اختياري)</Label>
                        <div className="space-y-2">
                          <Input
                            type="file"
                            accept="image/*"
                            onChange={async (e) => {
                              const file = e.target.files?.[0];
                              if (file) {
                                try {
                                  const formData = new FormData();
                                  formData.append('image', file);

                                  const response = await fetch(`${API_URL}/exams/upload-question-image`, {
                                    method: 'POST',
                                    body: formData
                                  });

                                  const result = await response.json();

                                  if (result.success) {
                                    setEditingQuestion({ ...editingQuestion, question_image: result.imageUrl });
                                    toast({
                                      title: 'تم الرفع',
                                      description: 'تم رفع الصورة بنجاح'
                                    });
                                  }
                                } catch (error) {
                                  toast({
                                    title: 'خطأ',
                                    description: 'فشل رفع الصورة',
                                    variant: 'destructive'
                                  });
                                }
                              }
                            }}
                          />
                          {editingQuestion.question_image && (
                            <div className="relative">
                              <img
                                src={editingQuestion.question_image.startsWith('http')
                                  ? editingQuestion.question_image
                                  : `${API_URL.replace('/api', '')}${editingQuestion.question_image}`
                                }
                                alt="معاينة"
                                className="max-w-xs rounded border"
                              />
                              <Button
                                type="button"
                                variant="destructive"
                                size="sm"
                                className="absolute top-2 right-2"
                                onClick={() => setEditingQuestion({ ...editingQuestion, question_image: '' })}
                              >
                                <Trash2 className="h-4 w-4" />
                              </Button>
                            </div>
                          )}
                        </div>
                      </div>

                      {editingQuestion.question_type === 'multiple_choice' && (
                        <>
                          <div className="grid grid-cols-2 gap-3">
                            <div>
                              <Label>الخيار أ</Label>
                              <Input
                                value={editingQuestion.option_a || ''}
                                onChange={(e) =>
                                  setEditingQuestion({ ...editingQuestion, option_a: e.target.value })
                                }
                              />
                            </div>
                            <div>
                              <Label>الخيار ب</Label>
                              <Input
                                value={editingQuestion.option_b || ''}
                                onChange={(e) =>
                                  setEditingQuestion({ ...editingQuestion, option_b: e.target.value })
                                }
                              />
                            </div>
                            <div>
                              <Label>الخيار ج</Label>
                              <Input
                                value={editingQuestion.option_c || ''}
                                onChange={(e) =>
                                  setEditingQuestion({ ...editingQuestion, option_c: e.target.value })
                                }
                              />
                            </div>
                            <div>
                              <Label>الخيار د</Label>
                              <Input
                                value={editingQuestion.option_d || ''}
                                onChange={(e) =>
                                  setEditingQuestion({ ...editingQuestion, option_d: e.target.value })
                                }
                              />
                            </div>
                          </div>

                          <div>
                            <Label>الإجابة الصحيحة</Label>
                            <Select
                              value={editingQuestion.correct_answer || 'a'}
                              onValueChange={(value: 'a' | 'b' | 'c' | 'd') =>
                                setEditingQuestion({ ...editingQuestion, correct_answer: value })
                              }
                            >
                              <SelectTrigger>
                                <SelectValue />
                              </SelectTrigger>
                              <SelectContent>
                                <SelectItem value="a">أ</SelectItem>
                                <SelectItem value="b">ب</SelectItem>
                                <SelectItem value="c">ج</SelectItem>
                                <SelectItem value="d">د</SelectItem>
                              </SelectContent>
                            </Select>
                          </div>
                        </>
                      )}

                      <div>
                        <Label>الدرجة</Label>
                        <Input
                          type="number"
                          value={editingQuestion.points}
                          onChange={(e) =>
                            setEditingQuestion({ ...editingQuestion, points: parseInt(e.target.value) })
                          }
                        />
                      </div>

                      <div className="flex gap-2">
                        <Button
                          onClick={() => handleUpdateQuestion(editingQuestion)}
                          className="bg-green-600 hover:bg-green-700"
                        >
                          <Save className="h-4 w-4 ml-2" />
                          حفظ
                        </Button>
                        <Button
                          variant="outline"
                          onClick={() => setEditingQuestion(null)}
                        >
                          إلغاء
                        </Button>
                      </div>
                    </div>
                  ) : (
                    // View Mode
                    <div>
                      <div className="flex justify-between items-start mb-3">
                        <div className="flex-1">
                          <div className="flex items-center gap-2 mb-2">
                            <span className="font-bold text-cyan-600">#{index + 1}</span>
                            <span className="text-xs bg-cyan-100 text-cyan-700 px-2 py-1 rounded">
                              {question.question_type === 'multiple_choice' ? 'اختيار من متعدد' : 'مقالي'}
                            </span>
                            <span className="text-xs bg-purple-100 text-purple-700 px-2 py-1 rounded">
                              {question.points} درجة
                            </span>
                          </div>
                          <p className="text-lg mb-2">{question.question_text}</p>

                          {question.question_image && (
                            <img
                              src={question.question_image.startsWith('http')
                                ? question.question_image
                                : `${API_URL.replace('/api', '')}${question.question_image}`
                              }
                              alt="صورة السؤال"
                              className="max-w-md rounded-lg mb-3"
                            />
                          )}

                          {question.question_type === 'multiple_choice' && (
                            <div className="grid grid-cols-2 gap-2 mt-3">
                              {[
                                { key: 'a', value: question.option_a },
                                { key: 'b', value: question.option_b },
                                { key: 'c', value: question.option_c },
                                { key: 'd', value: question.option_d }
                              ].filter(opt => opt.value).map(opt => (
                                <div
                                  key={opt.key}
                                  className={`p-2 rounded border ${question.correct_answer === opt.key
                                    ? 'bg-green-50 border-green-500'
                                    : 'bg-gray-50'
                                    }`}
                                >
                                  <span className="font-bold">{opt.key.toUpperCase()}:</span> {opt.value}
                                </div>
                              ))}
                            </div>
                          )}
                        </div>

                        <div className="flex gap-2">
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => setEditingQuestion(question)}
                            className="text-blue-600"
                          >
                            <Edit2 className="h-4 w-4" />
                          </Button>
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => handleDeleteQuestion(question.id!)}
                            className="text-red-600"
                          >
                            <Trash2 className="h-4 w-4" />
                          </Button>
                        </div>
                      </div>
                    </div>
                  )}
                </div>
              ))}

              {questions.length === 0 && (
                <div className="text-center py-8 text-gray-500">
                  لا توجد أسئلة في هذا الامتحان
                </div>
              )}
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
