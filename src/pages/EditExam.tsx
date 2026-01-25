import { useState, useEffect } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { useToast } from '@/hooks/use-toast';
import { getExamById, User } from '@/lib/api-http';
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

  useEffect(() => {
    const userStr = localStorage.getItem('currentUser');
    const user: User | null = userStr ? JSON.parse(userStr) : null;

    if (!user || (user.role !== 'teacher' && user.role !== 'admin')) {
      navigate('/auth');
      return;
    }

    loadExamData();
  }, [examId]);

  const loadExamData = async () => {
    try {
      setLoading(true);
      
      // Load exam details
      const examData = await getExamById(examId!);
      setExam(examData);

      // Load questions
      const response = await fetch(`${API_URL}/exams/${examId}/questions`);
      const questionsData = await response.json();
      
      // Parse options for multiple choice questions
      const parsedQuestions = questionsData.map((q: any) => ({
        ...q,
        option_a: q.options ? JSON.parse(q.options).a : '',
        option_b: q.options ? JSON.parse(q.options).b : '',
        option_c: q.options ? JSON.parse(q.options).c : '',
        option_d: q.options ? JSON.parse(q.options).d : '',
      }));
      
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
            onClick={() => navigate('/teacher/exams')}
            className="mb-4"
          >
            <ArrowLeft className="h-4 w-4 ml-2" />
            العودة للامتحانات
          </Button>
          
          <h1 className="text-3xl font-bold bg-gradient-to-r from-cyan-600 to-teal-600 bg-clip-text text-transparent">
            تعديل امتحان: {exam.title}
          </h1>
        </div>

        <Card className="shadow-lg">
          <CardHeader className="bg-gradient-to-r from-cyan-50 to-teal-50">
            <CardTitle className="flex items-center gap-2">
              <ClipboardCheck className="h-5 w-5 text-cyan-600" />
              الأسئلة ({questions.length})
            </CardTitle>
          </CardHeader>
          <CardContent className="pt-6">
            <div className="space-y-4">
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
                        <Label>صورة السؤال (رابط)</Label>
                        <div className="flex gap-2">
                          <Input
                            type="url"
                            value={editingQuestion.question_image || ''}
                            onChange={(e) =>
                              setEditingQuestion({ ...editingQuestion, question_image: e.target.value })
                            }
                            placeholder="https://..."
                          />
                          <Button
                            type="button"
                            variant="outline"
                            size="icon"
                            disabled
                          >
                            <ImageIcon className="h-4 w-4" />
                          </Button>
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
                              src={question.question_image} 
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
                                  className={`p-2 rounded border ${
                                    question.correct_answer === opt.key
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
