import { useState, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Textarea } from "@/components/ui/textarea";
import { Checkbox } from "@/components/ui/checkbox";
import { Calendar } from "@/components/ui/calendar";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { FileQuestion, Plus, Trash2, Edit2, Eye, CalendarIcon, Users, Upload, Image as ImageIcon, X } from "lucide-react";
import { format } from "date-fns";
import { ar } from "date-fns/locale";
import { cn } from "@/lib/utils";
import Header from "@/components/Header";
import { useToast } from "@/components/ui/use-toast";

const API_URL = import.meta.env.VITE_API_URL || '/api';

import {
  getCourses,
  getGroups,
  getExams,
  createExam,
  updateExam,
  deleteExam,
  getExamQuestions,
  Exam
} from "@/lib/api-http";

interface Group {
  id: string;
  name: string;
  course_id: string;
}

const ExamManager = () => {
  const [courses, setCourses] = useState([]);
  const [groups, setGroups] = useState([]);
  const [exams, setExams] = useState([]);
  const [questions, setQuestions] = useState([]);
  const [isExamOpen, setIsExamOpen] = useState(false);
  const [isQuestionOpen, setIsQuestionOpen] = useState(false);
  const [selectedExam, setSelectedExam] = useState(null);
  const [loading, setLoading] = useState(false);
  const [selectedGroups, setSelectedGroups] = useState([]);
  const [editingExam, setEditingExam] = useState(null);
  const [editingQuestion, setEditingQuestion] = useState(null);

  const [examForm, setExamForm] = useState({
    title: "",
    description: "",
    course_id: "",
    exam_date: null,
    exam_time: "",
    duration_minutes: 60,
    total_marks: 100,
    passing_marks: 50,
    total_questions: 10,
  });

  const [questionForm, setQuestionForm] = useState({
    question_text: "",
    question_image: "",
    question_type: "multiple_choice",
    correct_answer: "",
    correct_answer_index: -1,
    options: ["", "", "", ""],
    points: 1,
    explanation: ""
  });
  const [uploadingImage, setUploadingImage] = useState(false);

  const { toast } = useToast();

  useEffect(() => {
    fetchCourses();
    fetchGroups();
    fetchExams();
  }, []);

  const fetchCourses = async () => {
    try {
      const data = await getCourses();
      setCourses(data || []);
    } catch (error) {
      console.error('Error fetching courses:', error);
    }
  };

  const fetchGroups = async () => {
    try {
      const data = await getGroups();
      setGroups(data || []);
    } catch (error) {
      console.error('Error fetching groups:', error);
    }
  };

  const fetchExams = async () => {
    try {
      const data = await getExams();
      setExams(data || []);
    } catch (error) {
      console.error('Error fetching exams:', error);
    }
  };

  const fetchQuestions = async (examId) => {
    try {
      const data = await getExamQuestions(examId);
      setQuestions((data as any[]) || []);
    } catch (error) {
      console.error('Error fetching questions:', error);
    }
  };

  const handleExamSubmit = async (e) => {
    e.preventDefault();
    setLoading(true);

    if (selectedGroups.length === 0) {
      toast({
        title: "خطأ",
        description: "يجب اختيار مجموعة واحدة على الأقل",
        variant: "destructive",
      });
      setLoading(false);
      return;
    }

    try {
      // Prepare start_time and end_time for MySQL
      let startTime = null;
      let endTime = null;

      console.log('📅 Exam Form Data:', {
        exam_date: examForm.exam_date,
        exam_time: examForm.exam_time,
        duration_minutes: examForm.duration_minutes
      });

      if (examForm.exam_date && examForm.exam_time) {
        const [hours, minutes] = examForm.exam_time.split(':');
        const startDate = new Date(examForm.exam_date);
        startDate.setHours(parseInt(hours), parseInt(minutes), 0, 0);
        startTime = startDate.toISOString();

        console.log('⏰ Start Date created:', startDate);
        console.log('⏰ Start Time ISO:', startTime);

        // Calculate end time (start + duration)
        const endDate = new Date(startDate);
        endDate.setMinutes(endDate.getMinutes() + examForm.duration_minutes);
        endTime = endDate.toISOString();

        console.log('⏰ End Date created:', endDate);
        console.log('⏰ End Time ISO:', endTime);
      } else {
        console.warn('⚠️ No exam_date or exam_time provided!');
      }

      // ✅ Send to MySQL API ONLY (no Supabase)
      const examData = {
        title: examForm.title,
        description: examForm.description || null,
        course_id: examForm.course_id,
        duration_minutes: examForm.duration_minutes,
        total_marks: examForm.total_marks,
        passing_marks: examForm.passing_marks || 50,
        start_time: startTime,
        end_time: endTime,
        is_active: true
      };

      console.log('📝 Creating exam with MySQL API:', examData);

      const response = await fetch(`${API_URL}/exams`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${localStorage.getItem('token')}`
        },
        body: JSON.stringify(examData)
      });

      if (!response.ok) {
        const errorData = await response.json();
        console.error('❌ MySQL API error:', errorData);
        throw new Error(errorData.error || 'Failed to create exam');
      }

      const createdExam = await response.json();
      console.log('✅ Exam created in MySQL:', createdExam);

      toast({
        title: "✅ تم الإضافة بنجاح",
        description: `تم إضافة الامتحان: ${examForm.title}`,
      });

      fetchExams();
      setIsExamOpen(false);
      setSelectedGroups([]);
      setExamForm({
        title: "",
        description: "",
        course_id: "",
        exam_date: null,
        exam_time: "",
        duration_minutes: 60,
        total_marks: 100,
        passing_marks: 50,
        total_questions: 10,
      });
  } catch (error) {
    console.error('Error:', error);
    toast({
      title: "خطأ",
      description: error.message || "حدث خطأ، حاول مرة أخرى",
      variant: "destructive",
    });
  } finally {
    setLoading(false);
  }
};

const handleQuestionSubmit = async (e) => {
  e.preventDefault();
  setLoading(true);

  try {
    // Validate: must have at least text or image
    if (!questionForm.question_text && !questionForm.question_image) {
      toast({
        title: "خطأ",
        description: "يجب إدخال نص السؤال أو رفع صورة على الأقل",
        variant: "destructive",
      });
      setLoading(false);
      return;
    }

    // For multiple choice, validate correct answer selected
    if (questionForm.question_type === 'multiple_choice' && questionForm.correct_answer_index === -1) {
      toast({
        title: "خطأ",
        description: "يجب اختيار الإجابة الصحيحة",
        variant: "destructive",
      });
      setLoading(false);
      return;
    }

    // Prepare options - convert to object format for API
    const optionsData = questionForm.question_type === 'multiple_choice' 
      ? JSON.stringify({ a: questionForm.options[0], b: questionForm.options[1], c: questionForm.options[2], d: questionForm.options[3] })
      : null;

    // Convert correct_answer_index to letter (a, b, c, d)
    const correctAnswerLetter = questionForm.question_type === 'multiple_choice'
      ? ['a', 'b', 'c', 'd'][questionForm.correct_answer_index]
      : null;

    // Send to MySQL API
    const response = await fetch(`${API_URL}/exams/${selectedExam.id}/questions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${localStorage.getItem('token')}`
      },
      body: JSON.stringify({
        question_text: questionForm.question_text || null,
        question_image: questionForm.question_image || null,
        question_type: questionForm.question_type,
        options: optionsData,
        correct_answer: correctAnswerLetter,
        marks: questionForm.points,
        display_order: 0
      })
    });

    if (!response.ok) {
      const err = await response.json();
      throw new Error(err.error || 'فشل إضافة السؤال');
    }

    toast({
      title: "تم الإضافة بنجاح",
      description: "تم إضافة السؤال بنجاح",
    });

    fetchQuestions(selectedExam.id);
    fetchExams();
    setIsQuestionOpen(false);
    setQuestionForm({
      question_text: "",
      question_image: "",
      question_type: "multiple_choice",
      correct_answer: "",
      correct_answer_index: -1,
      options: ["", "", "", ""],
      points: 1,
      explanation: ""
    });
  } catch (error) {
    console.error('Error:', error);
    toast({
      title: "خطأ",
      description: error.message || "حدث خطأ، حاول مرة أخرى",
      variant: "destructive",
    });
  } finally {
    setLoading(false);
  }
};

const handleDeleteExam = async (id) => {
  try {
    await deleteExam(id);

    fetchExams();
    toast({
      title: "تم الحذف بنجاح",
      description: "تم حذف الامتحان",
    });
  } catch (error) {
    toast({
      title: "خطأ",
      description: "حدث خطأ في الحذف",
      variant: "destructive",
    });
  }
};

const handleDeleteQuestion = async (id) => {
  try {
    const response = await fetch(`${API_URL}/exams/${selectedExam.id}/questions/${id}`, {
      method: 'DELETE',
      headers: {
        'Authorization': `Bearer ${localStorage.getItem('token')}`
      }
    });

    if (!response.ok) throw new Error('Failed to delete');

    fetchQuestions(selectedExam.id);
    toast({
      title: "تم الحذف بنجاح",
      description: "تم حذف السؤال",
    });
  } catch (error) {
    toast({
      title: "خطأ",
      description: "حدث خطأ في الحذف",
      variant: "destructive",
    });
  }
};

const handleEditExam = async (exam) => {
  setEditingExam(exam);
  setSelectedGroups([]);

  setExamForm({
    title: exam.title,
    description: exam.description || "",
    course_id: exam.course_id,
    exam_date: exam.exam_date ? new Date(exam.exam_date) : null,
    exam_time: exam.exam_time || "",
    duration_minutes: exam.duration_minutes,
    total_marks: exam.total_marks,
    passing_marks: exam.passing_marks || 50,
    total_questions: exam.total_questions,
  });
  setIsExamOpen(true);
};

const handleUpdateExam = async (e) => {
  e.preventDefault();
  setLoading(true);

  try {
    await updateExam(editingExam.id, {
      title: examForm.title,
      duration_minutes: examForm.duration_minutes,
      total_marks: examForm.total_marks,
      passing_marks: examForm.passing_marks,
    } as any);

    toast({
      title: "تم التحديث بنجاح",
      description: "تم تحديث بيانات الامتحان بنجاح",
    });

    fetchExams();
    setIsExamOpen(false);
    setEditingExam(null);
    setSelectedGroups([]);
    setExamForm({
      title: "",
      description: "",
      course_id: "",
      exam_date: null,
      exam_time: "",
      duration_minutes: 60,
      total_marks: 100,
      passing_marks: 50,
      total_questions: 10,
    });
  } catch (error) {
    console.error('Error:', error);
    toast({
      title: "خطأ",
      description: error.message || "حدث خطأ، حاول مرة أخرى",
      variant: "destructive",
    });
  } finally {
    setLoading(false);
  }
};

const handleEditQuestion = (question) => {
  setEditingQuestion(question);

  // Parse options if they're in object format
  let optionsArray = ["", "", "", ""];
  if (question.options) {
    if (typeof question.options === 'string') {
      try {
        const parsed = JSON.parse(question.options);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          optionsArray = [parsed.a || "", parsed.b || "", parsed.c || "", parsed.d || ""];
        } else if (Array.isArray(parsed)) {
          optionsArray = parsed;
        }
      } catch (e) {
        console.error('Failed to parse options:', e);
      }
    } else if (Array.isArray(question.options)) {
      optionsArray = question.options;
    }
  }

  // Find the index of the correct answer (a=0, b=1, c=2, d=3)
  let correctAnswerIndex = -1;
  if (question.correct_answer) {
    const letterToIndex = { 'a': 0, 'b': 1, 'c': 2, 'd': 3 };
    correctAnswerIndex = letterToIndex[question.correct_answer] ?? -1;
  }

  setQuestionForm({
    question_text: question.question_text || "",
    question_image: question.question_image || "",
    question_type: question.question_type || "multiple_choice",
    correct_answer: question.correct_answer || "",
    correct_answer_index: correctAnswerIndex,
    options: optionsArray,
    points: question.points || 1,
    explanation: question.explanation || ""
  });
  setIsQuestionOpen(true);
};

const handleUpdateQuestion = async (e) => {
  e.preventDefault();
  setLoading(true);

  try {
    // Validate: must have at least text or image
    if (!questionForm.question_text && !questionForm.question_image) {
      toast({
        title: "خطأ",
        description: "يجب إدخال نص السؤال أو رفع صورة على الأقل",
        variant: "destructive",
      });
      setLoading(false);
      return;
    }

    // Prepare options - convert to JSON format for API
    const optionsData = questionForm.question_type === 'multiple_choice' 
      ? JSON.stringify({ a: questionForm.options[0], b: questionForm.options[1], c: questionForm.options[2], d: questionForm.options[3] })
      : null;

    // Convert correct_answer_index to letter
    const correctAnswerLetter = questionForm.question_type === 'multiple_choice'
      ? ['a', 'b', 'c', 'd'][questionForm.correct_answer_index]
      : null;

    const response = await fetch(`${API_URL}/exams/${selectedExam.id}/questions/${editingQuestion.id}`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${localStorage.getItem('token')}`
      },
      body: JSON.stringify({
        question_text: questionForm.question_text || null,
        question_image: questionForm.question_image || null,
        question_type: questionForm.question_type,
        options: optionsData,
        correct_answer: correctAnswerLetter,
        points: questionForm.points,
        explanation: questionForm.explanation || null
      })
    });

    if (!response.ok) {
      const err = await response.json();
      throw new Error(err.error || 'فشل تحديث السؤال');
    }

    toast({
      title: "تم التحديث بنجاح",
      description: "تم تحديث السؤال بنجاح",
    });

    fetchQuestions(selectedExam.id);
    setIsQuestionOpen(false);
    setEditingQuestion(null);
    setQuestionForm({
      question_text: "",
      question_image: "",
      question_type: "multiple_choice",
      correct_answer: "",
      correct_answer_index: -1,
      options: ["", "", "", ""],
      points: 1,
      explanation: ""
    });
  } catch (error) {
    console.error('Error:', error);
    toast({
      title: "خطأ",
      description: error.message || "حدث خطأ، حاول مرة أخرى",
      variant: "destructive",
    });
  } finally {
    setLoading(false);
  }
};

const openQuestionsDialog = (exam) => {
  setSelectedExam(exam);
  fetchQuestions(exam.id);
};

return (
  <div className="min-h-screen bg-gradient-to-br from-slate-50 via-cyan-50 to-teal-50 dark:from-slate-900 dark:via-cyan-950 dark:to-teal-950" dir="rtl">
    <Header />

    <div className="container mx-auto px-4 py-8">
      <div className="flex items-center justify-between mb-8">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 bg-primary/10 rounded-lg flex items-center justify-center">
            <FileQuestion className="w-6 h-6 text-primary" />
          </div>
          <div>
            <h1 className="text-2xl font-bold text-foreground">إدارة الامتحانات</h1>
            <p className="text-muted-foreground">إضافة وإدارة امتحانات الكورسات</p>
          </div>
        </div>

        <Dialog open={isExamOpen} onOpenChange={(open) => {
          setIsExamOpen(open);
          if (!open) {
            setEditingExam(null);
            setSelectedGroups([]);
            setExamForm({
              title: "",
              description: "",
              course_id: "",
              exam_date: null,
              exam_time: "",
              duration_minutes: 60,
              total_marks: 100,
              passing_marks: 50,
              total_questions: 10,
            });
          }
        }}>
          <DialogTrigger asChild>
            <Button className="shadow-medium">
              <Plus className="w-4 h-4 ml-2" />
              إضافة امتحان جديد
            </Button>
          </DialogTrigger>
          <DialogContent className="max-w-md">
            <DialogHeader>
              <DialogTitle>{editingExam ? "تعديل الامتحان" : "إضافة امتحان جديد"}</DialogTitle>
            </DialogHeader>
            <form onSubmit={editingExam ? handleUpdateExam : handleExamSubmit} className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="course">الكورس</Label>
                <Select value={examForm.course_id} onValueChange={(value) => setExamForm(prev => ({ ...prev, course_id: value }))}>
                  <SelectTrigger>
                    <SelectValue placeholder="اختر الكورس" />
                  </SelectTrigger>
                  <SelectContent>
                    {courses.map((course) => (
                      <SelectItem key={course.id} value={course.id}>
                        {course.name} - {course.subject}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div className="space-y-2">
                <Label htmlFor="title">عنوان الامتحان</Label>
                <Input
                  id="title"
                  value={examForm.title}
                  onChange={(e) => setExamForm(prev => ({ ...prev, title: e.target.value }))}
                  placeholder="أدخل عنوان الامتحان"
                  required
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="description">الوصف</Label>
                <Textarea
                  id="description"
                  value={examForm.description}
                  onChange={(e) => setExamForm(prev => ({ ...prev, description: e.target.value }))}
                  placeholder="وصف الامتحان (اختياري)"
                />
              </div>

              <div className="space-y-2">
                <Label>تاريخ الامتحان</Label>
                <Popover>
                  <PopoverTrigger asChild>
                    <Button
                      variant="outline"
                      className={cn(
                        "w-full justify-start text-right font-normal",
                        !examForm.exam_date && "text-muted-foreground"
                      )}
                    >
                      <CalendarIcon className="ml-2 h-4 w-4" />
                      {examForm.exam_date ? (
                        format(examForm.exam_date, "PPP", { locale: ar })
                      ) : (
                        <span>اختر التاريخ</span>
                      )}
                    </Button>
                  </PopoverTrigger>
                  <PopoverContent className="w-auto p-0" align="start">
                    <Calendar
                      mode="single"
                      selected={examForm.exam_date}
                      onSelect={(date) => {
                        console.log('📅 Date selected from Calendar:', date);
                        setExamForm(prev => ({ ...prev, exam_date: date }));
                      }}
                      initialFocus
                      className="pointer-events-auto"
                    />
                  </PopoverContent>
                </Popover>
              </div>

              <div className="space-y-2">
                <Label htmlFor="exam_time">وقت الامتحان</Label>
                <Input
                  id="exam_time"
                  type="time"
                  value={examForm.exam_time}
                  onChange={(e) => {
                    console.log('🕐 Time changed:', e.target.value);
                    setExamForm(prev => ({ ...prev, exam_time: e.target.value }));
                  }}
                  required
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="duration">مدة الامتحان (بالدقائق)</Label>
                <Input
                  id="duration"
                  type="number"
                  value={examForm.duration_minutes}
                  onChange={(e) => setExamForm(prev => ({ ...prev, duration_minutes: parseInt(e.target.value) }))}
                  min="1"
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="total_marks">إجمالي الدرجات</Label>
                <Input
                  id="total_marks"
                  type="number"
                  value={examForm.total_marks}
                  onChange={(e) => setExamForm(prev => ({ ...prev, total_marks: parseInt(e.target.value) }))}
                  min="1"
                  required
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="passing_marks">درجة النجاح</Label>
                <Input
                  id="passing_marks"
                  type="number"
                  value={examForm.passing_marks}
                  onChange={(e) => setExamForm(prev => ({ ...prev, passing_marks: parseInt(e.target.value) }))}
                  min="1"
                  max={examForm.total_marks}
                  required
                />
              </div>

              <div className="space-y-2">
                <Label>المجموعات المستهدفة</Label>
                <div className="space-y-2 max-h-40 overflow-y-auto border rounded-md p-3">
                  {groups.map((group) => (
                    <div key={group.id} className="flex items-center space-x-2 space-x-reverse">
                      <Checkbox
                        id={`exam-group-${group.id}`}
                        checked={selectedGroups.includes(group.id)}
                        onCheckedChange={(checked) => {
                          if (checked) {
                            setSelectedGroups([...selectedGroups, group.id]);
                          } else {
                            setSelectedGroups(selectedGroups.filter(id => id !== group.id));
                          }
                        }}
                      />
                      <Label htmlFor={`exam-group-${group.id}`} className="text-sm font-normal">
                        {group.name}
                      </Label>
                    </div>
                  ))}
                </div>
              </div>

              <Button type="submit" className="w-full" disabled={loading}>
                {loading ? (editingExam ? "جاري التحديث..." : "جاري الإضافة...") : (editingExam ? "تحديث الامتحان" : "إضافة الامتحان")}
              </Button>
            </form>
          </DialogContent>
        </Dialog>
      </div>

      <Card className="shadow-soft">
        <CardHeader>
          <CardTitle>قائمة الامتحانات</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          <div className="enhanced-table-container">
            <Table className="enhanced-table">
              <TableHeader>
                <TableRow>
                  <TableHead>الامتحان</TableHead>
                  <TableHead>الكورس</TableHead>
                  <TableHead>التاريخ</TableHead>
                  <TableHead>المدة</TableHead>
                  <TableHead>الدرجات</TableHead>
                  <TableHead>الإجراءات</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {exams.map((exam) => (
                  <TableRow key={exam.id}>
                    <TableCell>
                      <div>
                        <p className="font-medium">{exam.title}</p>
                        {exam.description && (
                          <p className="text-sm text-muted-foreground">{exam.description}</p>
                        )}
                      </div>
                    </TableCell>
                    <TableCell>{exam.courses?.name} - {exam.courses?.subject}</TableCell>
                    <TableCell>
                      {exam.exam_date ? format(new Date(exam.exam_date), 'dd/MM/yyyy', { locale: ar }) : 'غير محدد'}
                    </TableCell>
                    <TableCell>{exam.duration_minutes} دقيقة</TableCell>
                    <TableCell>{exam.total_marks} درجة</TableCell>
                    <TableCell>
                      <div className="flex gap-1">
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => handleEditExam(exam)}
                          title="تعديل الامتحان"
                        >
                          <Edit2 className="w-4 h-4" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => openQuestionsDialog(exam)}
                          title="عرض الأسئلة"
                        >
                          <Eye className="w-4 h-4" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => window.location.href = `/exam-reports/${exam.id}`}
                          className="text-blue-600 hover:text-blue-700"
                          title="عرض التقارير والطلاب"
                        >
                          <Users className="w-4 h-4" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => handleDeleteExam(exam.id)}
                          className="text-destructive hover:text-destructive"
                          title="حذف الامتحان"
                        >
                          <Trash2 className="w-4 h-4" />
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </CardContent>
      </Card>

      {/* Questions Dialog */}
      <Dialog open={selectedExam !== null} onOpenChange={() => setSelectedExam(null)}>
        <DialogContent className="max-w-4xl max-h-[80vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>
              أسئلة امتحان: {selectedExam?.title}
              <Button
                onClick={() => setIsQuestionOpen(true)}
                className="mr-4"
                size="sm"
              >
                <Plus className="w-4 h-4 ml-2" />
                إضافة سؤال
              </Button>
            </DialogTitle>
          </DialogHeader>

          <div className="space-y-4">
            {questions.map((question, index) => (
              <Card key={question.id}>
                <CardContent className="pt-4">
                  <div className="flex justify-between items-start">
                    <div className="flex-1">
                      <p className="font-medium mb-2">
                        س{index + 1}: {question.question_text}
                      </p>
                      {question.options && (
                        <div className="space-y-1 text-sm text-muted-foreground">
                          {question.options.map((option, optIndex) => (
                            <p key={optIndex} className={option === question.correct_answer ? "text-green-600 font-medium" : ""}>
                              {String.fromCharCode(65 + optIndex)}) {option}
                            </p>
                          ))}
                        </div>
                      )}
                      <p className="text-sm text-primary mt-2">
                        الإجابة الصحيحة: {question.correct_answer} | النقاط: {question.points}
                      </p>
                      {question.explanation && (
                        <p className="text-sm text-muted-foreground mt-1 bg-muted p-2 rounded">
                          <span className="font-medium">التفسير:</span> {question.explanation}
                        </p>
                      )}
                    </div>
                    <div className="flex gap-1">
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => handleEditQuestion(question)}
                      >
                        <Edit2 className="w-4 h-4" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => handleDeleteQuestion(question.id)}
                        className="text-destructive hover:text-destructive"
                      >
                        <Trash2 className="w-4 h-4" />
                      </Button>
                    </div>
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        </DialogContent>
      </Dialog>

      {/* Add Question Dialog */}
      <Dialog open={isQuestionOpen} onOpenChange={(open) => {
        setIsQuestionOpen(open);
        if (!open) {
          setEditingQuestion(null);
          setQuestionForm({
            question_text: "",
            question_image: "",
            question_type: "multiple_choice",
            correct_answer: "",
            correct_answer_index: -1,
            options: ["", "", "", ""],
            points: 1,
            explanation: ""
          });
        }
      }}>
        <DialogContent className="max-w-md max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{editingQuestion ? "تعديل السؤال" : "إضافة سؤال جديد"}</DialogTitle>
          </DialogHeader>
          <form onSubmit={editingQuestion ? handleUpdateQuestion : handleQuestionSubmit} className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="question_type">نوع السؤال *</Label>
              <Select value={questionForm.question_type} onValueChange={(value) => setQuestionForm(prev => ({ ...prev, question_type: value }))}>
                <SelectTrigger>
                  <SelectValue placeholder="اختر نوع السؤال" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="multiple_choice">اختيار من متعدد</SelectItem>
                  <SelectItem value="essay">سؤال مقالي</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-2">
              <Label htmlFor="question_text">نص السؤال</Label>
              <Textarea
                id="question_text"
                value={questionForm.question_text}
                onChange={(e) => setQuestionForm(prev => ({ ...prev, question_text: e.target.value }))}
                placeholder="اكتب السؤال هنا..."
              />
              <p className="text-xs text-muted-foreground">يمكنك كتابة نص السؤال أو رفع صورة أو كلاهما</p>
            </div>

            <div className="space-y-2">
              <Label className="flex items-center gap-2">
                <ImageIcon className="w-4 h-4" />
                صورة السؤال
              </Label>
              {questionForm.question_image ? (
                <div className="relative">
                  <img 
                    src={questionForm.question_image} 
                    alt="صورة السؤال" 
                    className="w-full max-h-48 object-contain rounded-lg border"
                  />
                  <Button
                    type="button"
                    variant="destructive"
                    size="icon"
                    className="absolute top-2 left-2 h-6 w-6"
                    onClick={() => setQuestionForm(prev => ({ ...prev, question_image: "" }))}
                  >
                    <X className="w-3 h-3" />
                  </Button>
                </div>
              ) : (
                <div className="border-2 border-dashed rounded-lg p-4 text-center">
                  <input
                    type="file"
                    accept="image/*"
                    id="question-image-upload"
                    className="hidden"
                    onChange={async (e) => {
                      const file = e.target.files?.[0];
                      if (file) {
                        setUploadingImage(true);
                        try {
                          const reader = new FileReader();
                          reader.onload = (event) => {
                            const base64 = event.target?.result as string;
                            setQuestionForm(prev => ({ ...prev, question_image: base64 }));
                            setUploadingImage(false);
                          };
                          reader.onerror = () => {
                            toast({ title: "خطأ", description: "فشل قراءة الصورة", variant: "destructive" });
                            setUploadingImage(false);
                          };
                          reader.readAsDataURL(file);
                        } catch (err) {
                          toast({ title: "خطأ", description: "فشل رفع الصورة", variant: "destructive" });
                          setUploadingImage(false);
                        }
                      }
                    }}
                  />
                  <label htmlFor="question-image-upload" className="cursor-pointer">
                    {uploadingImage ? (
                      <div className="flex items-center justify-center gap-2 text-muted-foreground">
                        <div className="animate-spin rounded-full h-5 w-5 border-b-2 border-primary"></div>
                        جاري الرفع...
                      </div>
                    ) : (
                      <div className="flex flex-col items-center gap-2 text-muted-foreground hover:text-primary transition-colors">
                        <Upload className="w-8 h-8" />
                        <span className="text-sm">اضغط لرفع صورة السؤال</span>
                        <span className="text-xs">(اختياري - يمكنك كتابة نص فقط)</span>
                      </div>
                    )}
                  </label>
                </div>
              )}
            </div>

            {questionForm.question_type === 'multiple_choice' && (
              <div className="space-y-3">
                <Label>الخيارات (اختر الإجابة الصحيحة بعلامة ✓)</Label>
                {questionForm.options.map((option, index) => (
                  <div key={index} className="flex items-center gap-2">
                    <Checkbox
                      checked={questionForm.correct_answer_index === index}
                      onCheckedChange={(checked) => {
                        if (checked) {
                          setQuestionForm(prev => ({
                            ...prev,
                            correct_answer_index: index,
                            correct_answer: prev.options[index]
                          }));
                        }
                      }}
                      className="mt-2"
                    />
                    <Input
                      value={option}
                      onChange={(e) => {
                        const newOptions = [...questionForm.options];
                        newOptions[index] = e.target.value;

                        // Update correct_answer if this is the selected option
                        if (questionForm.correct_answer_index === index) {
                          setQuestionForm(prev => ({
                            ...prev,
                            options: newOptions,
                            correct_answer: e.target.value
                          }));
                        } else {
                          setQuestionForm(prev => ({ ...prev, options: newOptions }));
                        }
                      }}
                      placeholder={`الخيار ${String.fromCharCode(65 + index)}`}
                      required
                      className={questionForm.correct_answer_index === index ? "border-green-500" : ""}
                    />
                  </div>
                ))}
              </div>
            )}

            {questionForm.question_type === 'essay' && (
              <div className="p-4 bg-muted/50 rounded-lg">
                <p className="text-sm text-muted-foreground">
                  السؤال المقالي: الطالب سيكتب الإجابة بنفسه أو يرفع صورة للإجابة.
                  <br />
                  سيتم تصحيح الإجابة يدوياً من قبل المعلم.
                </p>
              </div>
            )}

            <div className="space-y-2">
              <Label htmlFor="explanation">تفسير الإجابة (اختياري)</Label>
              <Textarea
                id="explanation"
                value={questionForm.explanation}
                onChange={(e) => setQuestionForm(prev => ({ ...prev, explanation: e.target.value }))}
                placeholder="اشرح لماذا هذه هي الإجابة الصحيحة"
                rows={3}
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="points">درجة السؤال *</Label>
              <Input
                id="points"
                type="number"
                value={questionForm.points}
                onChange={(e) => setQuestionForm(prev => ({ ...prev, points: parseFloat(e.target.value) }))}
                min="0.1"
                step="0.1"
              />
            </div>

            <Button type="submit" className="w-full" disabled={loading}>
              {loading ? (editingQuestion ? "جاري التحديث..." : "جاري الإضافة...") : (editingQuestion ? "تحديث السؤال" : "إضافة السؤال")}
            </Button>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  </div>
);
};

export default ExamManager;