import { useState, useEffect, useMemo, useRef } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { useToast } from '@/hooks/use-toast';
import {
  ApiRequestError,
  authenticatedApiFetch,
  readAuthenticatedApiBlob,
  User,
  getCourses,
  getGrades,
  getGroups,
  Course,
  Grade,
  Group,
  Exam,
} from '@/lib/api-http';
import { ClipboardCheck, Plus, Trash2, Edit2, Save, ArrowLeft, Image as ImageIcon } from 'lucide-react';
import Header from '@/components/Header';

// Vite injects `import.meta.env` at build time; it is absent when this module
// is imported outside Vite (isolated Node tests), so guard the read.
const readApiBase = (): string => {
  try {
    return import.meta.env.VITE_API_URL || '/api';
  } catch {
    return '/api';
  }
};

const API_URL = readApiBase();
const API_ORIGIN = API_URL.replace(/\/api\/?$/, '');
const questionImageSrc = (value: string): string =>
  value.startsWith('http') ? value : `${API_ORIGIN}${value}`;

/** Read a response body through the protected session fence, then parse it.
 *  A stale response cannot be turned into local state after a session change. */
async function readProtectedJson<T>(response: Response): Promise<T | null> {
  const blob = await readAuthenticatedApiBlob(response);
  const text = await blob.text();
  if (!text) return null;
  try {
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

async function readProtectedErrorMessage(response: Response): Promise<string | null> {
  const payload = await readProtectedJson<{ error?: unknown }>(response);
  return payload && typeof payload.error === 'string' ? payload.error : null;
}

function isSessionChangedError(error: unknown): boolean {
  return error instanceof ApiRequestError
    && (error.code === 'CLIENT_SESSION_CHANGED' || error.code === 'SESSION_REQUIRED');
}

// The `Exam` type from api-http models the list endpoint only; the detail
// endpoint (GET /exams/:id) returns the full row including scheduling fields.
interface ExamDetail extends Exam {
  description?: string | null;
  grade_id?: string | null;
  group_id?: string | null;
  passing_marks?: number | null;
  passing_percentage?: number | null;
  start_time?: string | null;
  end_time?: string | null;
  exam_date?: string | null;
}

function sameExamDetailsDraft(a: ExamDetail | null, b: ExamDetail | null): boolean {
  if (!a || !b) return a === b;
  return a.title === b.title
    && (a.course_id || '') === (b.course_id || '')
    && (a.grade_id || 'all') === (b.grade_id || 'all')
    && (a.group_id || 'all') === (b.group_id || 'all')
    && String(a.start_time || '') === String(b.start_time || '')
    && String(a.end_time || '') === String(b.end_time || '')
    && a.duration_minutes === b.duration_minutes;
}

// ---------------------------------------------------------------------------
// Pure helpers — exported so the isolated test suite exercises the real
// production behavior instead of a re-implementation.
// ---------------------------------------------------------------------------

/** Parse the server `options` column (JSON string | object | array) into the
 *  a/b/c/d shape the authoring form uses. Never throws. */
export function normalizeQuestionOptions(
  options: unknown,
): { a: string; b: string; c: string; d: string } {
  const empty = { a: '', b: '', c: '', d: '' };
  let parsed: unknown = options;
  if (typeof parsed === 'string') {
    try {
      parsed = JSON.parse(parsed);
    } catch {
      return empty;
    }
  }
  if (Array.isArray(parsed)) {
    const arr = parsed as unknown[];
    return {
      a: String(arr[0] ?? ''),
      b: String(arr[1] ?? ''),
      c: String(arr[2] ?? ''),
      d: String(arr[3] ?? ''),
    };
  }
  if (parsed && typeof parsed === 'object') {
    const rec = parsed as Record<string, unknown>;
    return {
      a: String(rec.a ?? ''),
      b: String(rec.b ?? ''),
      c: String(rec.c ?? ''),
      d: String(rec.d ?? ''),
    };
  }
  return empty;
}

/** Coerce a points/degree input to a whole number >= 1 so an emptied number
 *  field can never send NaN to the API. */
export function normalizePositiveInt(value: unknown, fallback = 1): number {
  const n = typeof value === 'number' ? value : parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(n) || n < 1) return fallback;
  return Math.floor(n);
}

/** Single-flight guard used to prevent duplicate save submits. */
export function createSingleFlightGuard() {
  let inFlight = false;
  return {
    isBusy: () => inFlight,
    async run<T>(
      task: () => Promise<T>,
    ): Promise<{ status: 'ran'; value: T } | { status: 'blocked' }> {
      if (inFlight) return { status: 'blocked' };
      inFlight = true;
      try {
        return { status: 'ran', value: await task() };
      } finally {
        inFlight = false;
      }
    },
  };
}

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

const createBlankQuestion = (): Question => ({
  question_text: '',
  question_type: 'multiple_choice',
  option_a: '',
  option_b: '',
  option_c: '',
  option_d: '',
  correct_answer: 'a',
  points: 1,
});

function sameQuestionDraft(a: Question, b: Question): boolean {
  return a.question_text === b.question_text
    && (a.question_image || '') === (b.question_image || '')
    && a.question_type === b.question_type
    && (a.option_a || '') === (b.option_a || '')
    && (a.option_b || '') === (b.option_b || '')
    && (a.option_c || '') === (b.option_c || '')
    && (a.option_d || '') === (b.option_d || '')
    && (a.correct_answer || '') === (b.correct_answer || '')
    && a.points === b.points;
}

export default function EditExam() {
  const { examId } = useParams();
  const { toast } = useToast();
  const navigate = useNavigate();
  const [loading, setLoading] = useState(false);
  const [exam, setExam] = useState<ExamDetail | null>(null);
  const [questions, setQuestions] = useState<Question[]>([]);
  const [editingQuestion, setEditingQuestion] = useState<Question | null>(null);
  const [editingExamDetails, setEditingExamDetails] = useState(false);
  const [addingNewQuestion, setAddingNewQuestion] = useState(false);
  const [newQuestion, setNewQuestion] = useState<Question>(createBlankQuestion);

  const [saving, setSaving] = useState(false);
  const saveGuardRef = useRef(createSingleFlightGuard());
  const uploadGuardRef = useRef(createSingleFlightGuard());
  const loadSeqRef = useRef(0);
  const mountedRef = useRef(true);
  const examIdRef = useRef(examId);
  const examRef = useRef<ExamDetail | null>(exam);
  const newQuestionRef = useRef<Question>(newQuestion);
  examIdRef.current = examId;
  examRef.current = exam;
  newQuestionRef.current = newQuestion;

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      loadSeqRef.current += 1;
    };
  }, []);

  // Single-flight wrapper: blocks concurrent save submits synchronously and
  // mirrors the in-flight state into `saving` so the submit buttons can be disabled.
  const runGuardedSave = async (task: () => Promise<void>) => {
    if (saveGuardRef.current.isBusy()) return;
    setSaving(true);
    try {
      await saveGuardRef.current.run(task);
    } finally {
      if (mountedRef.current) setSaving(false);
    }
  };

  // Lists for dropdowns
  const [courses, setCourses] = useState<Course[]>([]);
  const [grades, setGrades] = useState<Grade[]>([]);
  const [groups, setGroups] = useState<Group[]>([]);

  // Filtered groups based on selected grade
  const filteredGroups = exam?.grade_id && exam.grade_id !== 'all'
    ? groups.filter(g => g.grade_id === exam.grade_id)
    : groups;

  // Calculate total marks automatically from all questions
  const totalMarks = useMemo(() => {
    return questions.reduce((sum, q) => sum + (q.points || 0), 0);
  }, [questions]);

  useEffect(() => {
    const userStr = localStorage.getItem('currentUser');
    const user: User | null = userStr ? JSON.parse(userStr) : null;

    if (!user || (user.role !== 'teacher' && user.role !== 'admin' && user.role !== 'staff' && user.role !== 'instructor')) {
      navigate('/auth');
      return;
    }

    // Route changed: drafts from the previous exam must not leak into this one.
    setEditingQuestion(null);
    setEditingExamDetails(false);
    setAddingNewQuestion(false);
    setNewQuestion(createBlankQuestion());
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
    const seq = ++loadSeqRef.current;
    const requestedExamId = examIdRef.current;
    if (!requestedExamId) {
      setLoading(false);
      return;
    }
    try {
      setLoading(true);

      // Load exam details
      const examResponse = await authenticatedApiFetch(`/exams/${encodeURIComponent(requestedExamId)}`);
      if (seq !== loadSeqRef.current || !mountedRef.current) return;
      if (!examResponse.ok) {
        if (examResponse.status === 404) {
          setExam(null);
          setQuestions([]);
          return;
        }
        const message = await readProtectedErrorMessage(examResponse);
        throw new Error(message || 'Failed to load exam');
      }
      const examData = await readProtectedJson<ExamDetail>(examResponse);
      if (seq !== loadSeqRef.current || !mountedRef.current) return;
      if (!examData || typeof examData.id !== 'string') throw new Error('Invalid exam response');

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
      const questionsResponse = await authenticatedApiFetch(
        `/exams/${encodeURIComponent(requestedExamId)}/questions?t=${Date.now()}`,
      );
      if (seq !== loadSeqRef.current || !mountedRef.current) return;
      if (!questionsResponse.ok) {
        const message = await readProtectedErrorMessage(questionsResponse);
        throw new Error(message || 'Failed to load questions');
      }
      const questionsData = await readProtectedJson<unknown>(questionsResponse);
      if (seq !== loadSeqRef.current || !mountedRef.current) return;

      // Parse options for multiple choice questions
      const parsedQuestions = (Array.isArray(questionsData) ? questionsData : []).map((q: any) => ({
        ...q,
        ...normalizeQuestionOptions(q.options),
      }));

      setQuestions(parsedQuestions);
    } catch (error) {
      if (seq !== loadSeqRef.current || !mountedRef.current) return; // stale failure, keep current view
      if (isSessionChangedError(error)) return; // the session layer owns this transition
      console.error('Error loading exam:', error);
      toast({
        title: 'خطأ',
        description: 'فشل تحميل بيانات الامتحان',
        variant: 'destructive'
      });
    } finally {
      if (seq === loadSeqRef.current && mountedRef.current) setLoading(false);
    }
  };

  const handleUpdateExamDetails = async () => {
    await runGuardedSave(async () => {
      const requestExamId = examIdRef.current;
      try {
        if (!exam) return;
        const submittedDraft: ExamDetail = { ...exam };

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
          duration_minutes: exam.duration_minutes,
          total_marks: totalMarks  // Auto-update total marks from questions
        };

        const response = await authenticatedApiFetch(`/exams/${encodeURIComponent(requestExamId)}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(updateData)
        });

        if (!response.ok) {
          const message = await readProtectedErrorMessage(response);
          throw new Error(message || 'Failed to update exam');
        }
        await readProtectedJson<unknown>(response);
        if (!mountedRef.current || examIdRef.current !== requestExamId) return;

        toast({
          title: 'تم التحديث',
          description: 'تم تحديث بيانات الامتحان بنجاح'
        });

        // Do not discard a newer draft the user typed while this save was in flight.
        if (sameExamDetailsDraft(examRef.current, submittedDraft)) {
          setEditingExamDetails(false);
        }
      } catch (error) {
        if (!mountedRef.current || examIdRef.current !== requestExamId) return;
        if (isSessionChangedError(error)) return;
        console.error('Error updating exam:', error);
        toast({
          title: 'خطأ',
          description: 'فشل تحديث بيانات الامتحان',
          variant: 'destructive'
        });
      }
    });
  };

  const handleUpdateQuestion = async (question: Question) => {
    await runGuardedSave(async () => {
      const requestExamId = examIdRef.current;
      try {
        if (!question.id || !requestExamId) return;
        const options = question.question_type === 'multiple_choice'
          ? JSON.stringify({
            a: question.option_a,
            b: question.option_b,
            c: question.option_c,
            d: question.option_d
          })
          : null;
        const normalizedPoints = normalizePositiveInt(question.points, 1);
        const updatedQuestion: Question = { ...question, points: normalizedPoints };

        const response = await authenticatedApiFetch(
          `/exams/${encodeURIComponent(requestExamId)}/questions/${encodeURIComponent(question.id)}`,
          {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              question_text: question.question_text,
              question_image: question.question_image || null,
              question_type: question.question_type,
              options: options,
              correct_answer: question.correct_answer || null,
              points: normalizedPoints,
              explanation: null
            })
          },
        );

        if (!response.ok) {
          const message = await readProtectedErrorMessage(response);
          throw new Error(message || 'Failed to update question');
        }
        await readProtectedJson<unknown>(response);
        if (!mountedRef.current || examIdRef.current !== requestExamId) return;

        // Reflect the accepted values locally so other drafts are not reloaded away.
        setQuestions(current => current.map(item => item.id === question.id ? updatedQuestion : item));
        setEditingQuestion(current => (
          current && current.id === question.id && sameQuestionDraft(current, question)
            ? null
            : current
        ));

        toast({
          title: 'تم التحديث',
          description: 'تم تحديث السؤال بنجاح'
        });

      } catch (error) {
        if (!mountedRef.current || examIdRef.current !== requestExamId) return;
        if (isSessionChangedError(error)) return;
        toast({
          title: 'خطأ',
          description: 'فشل تحديث السؤال',
          variant: 'destructive'
        });
      }
    });
  };

  const handleDeleteQuestion = async (questionId: string) => {
    if (!confirm('هل أنت متأكد من حذف هذا السؤال؟')) return;

    const requestExamId = examIdRef.current;
    await runGuardedSave(async () => {
      try {
        if (!requestExamId) return;
        const response = await authenticatedApiFetch(
          `/exams/${encodeURIComponent(requestExamId)}/questions/${encodeURIComponent(questionId)}`,
          { method: 'DELETE' },
        );

        if (!response.ok) {
          const message = await readProtectedErrorMessage(response);
          throw new Error(message || 'Failed to delete question');
        }
        await readProtectedJson<unknown>(response);
        if (!mountedRef.current || examIdRef.current !== requestExamId) return;

        // Remove the accepted deletion locally instead of reloading and
        // discarding unsaved edits in other question drafts.
        setQuestions(current => current.filter(item => item.id !== questionId));
        setEditingQuestion(current => current && current.id === questionId ? null : current);

        toast({
        title: 'تم الحذف',
        description: 'تم حذف السؤال بنجاح'
      });

      } catch (error) {
        if (!mountedRef.current || examIdRef.current !== requestExamId) return;
        if (isSessionChangedError(error)) return;
        toast({
        title: 'خطأ',
        description: 'فشل حذف السؤال',
        variant: 'destructive'
      });
    }
    });
  };

  const handleAddNewQuestion = async () => {
    await runGuardedSave(async () => {
      const requestExamId = examIdRef.current;
      try {
        if (!requestExamId) return;
        const submitted = { ...newQuestion };
        const options = submitted.question_type === 'multiple_choice'
          ? JSON.stringify({
            a: submitted.option_a,
            b: submitted.option_b,
            c: submitted.option_c,
            d: submitted.option_d
          })
          : null;

        const response = await authenticatedApiFetch(
          `/exams/${encodeURIComponent(requestExamId)}/questions`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              question_text: submitted.question_text,
              question_image: submitted.question_image || null,
              question_type: submitted.question_type,
              options: options,
              correct_answer: submitted.correct_answer || null,
              points: normalizePositiveInt(submitted.points, 1),
              explanation: null
            })
          },
        );

        if (!response.ok) {
          const message = await readProtectedErrorMessage(response);
          throw new Error(message || 'Failed to add question');
        }
        const created = await readProtectedJson<Question & { id?: string; options?: unknown }>(response);
        if (!mountedRef.current || examIdRef.current !== requestExamId) return;

        if (created && typeof created.id === 'string' && created.id) {
          const createdQuestion: Question = {
            ...created,
            ...normalizeQuestionOptions(created.options),
            points: normalizePositiveInt(created.points, 1),
          };
          setQuestions(current => [...current, createdQuestion]);
        } else if (!editingQuestion) {
          // A 2xx without the documented row is still committed; refresh the
          // server list instead of replaying the mutation.
          loadExamData();
        }

        // Do not clear a newer question draft typed while this request was in flight.
        if (sameQuestionDraft(newQuestionRef.current, submitted)) {
          setNewQuestion(createBlankQuestion());
          setAddingNewQuestion(false);
        }

        toast({
          title: 'تم الإضافة',
          description: 'تم إضافة السؤال بنجاح'
        });

      } catch (error) {
        if (!mountedRef.current || examIdRef.current !== requestExamId) return;
        if (isSessionChangedError(error)) return;
        toast({
          title: 'خطأ',
          description: 'فشل إضافة السؤال',
          variant: 'destructive'
        });
      }
    });
  };

  const uploadQuestionImage = async (file: File, apply: (url: string) => void) => {
    const requestExamId = examIdRef.current;
    try {
      const run = await uploadGuardRef.current.run(async () => {
        const formData = new FormData();
        formData.append('image', file);
        const response = await authenticatedApiFetch('/exams/upload-question-image', {
          method: 'POST',
          body: formData,
        });
        const result = await readProtectedJson<{ success?: unknown; imageUrl?: unknown; error?: unknown }>(response);
        if (!response.ok || !result || result.success !== true
          || typeof result.imageUrl !== 'string' || !result.imageUrl.trim()) {
          throw new Error(typeof result?.error === 'string' ? result.error : 'فشل رفع الصورة');
        }
        if (!mountedRef.current || examIdRef.current !== requestExamId) return;
        apply(result.imageUrl.trim());
        toast({ title: 'تم الرفع', description: 'تم رفع الصورة بنجاح' });
      });
      if (run.status === 'blocked') {
        toast({ title: 'جارٍ رفع صورة أخرى', description: 'انتظر اكتمال الرفع الحالي أولاً' });
      }
    } catch (error) {
      if (!mountedRef.current || examIdRef.current !== requestExamId) return;
      if (isSessionChangedError(error)) return;
      toast({
        title: 'خطأ',
        description: error instanceof Error ? error.message : 'فشل رفع الصورة',
        variant: 'destructive',
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
      <div className="container mx-auto px-3 sm:px-4 py-4 sm:py-8 max-w-full overflow-hidden">
        <div className="mb-4 sm:mb-6">
          <Button
            variant="outline"
            onClick={() => navigate('/teacher-exams')}
            className="mb-3 sm:mb-4 text-sm"
          >
            <ArrowLeft className="h-4 w-4 ml-2" />
            العودة للامتحانات
          </Button>

          <h1 className="text-xl sm:text-2xl md:text-3xl font-bold bg-gradient-to-r from-cyan-600 to-teal-600 bg-clip-text text-transparent break-words">
            تعديل امتحان: {exam.title}
          </h1>
        </div>

        {/* Exam Details Card */}
        <Card className="shadow-lg mb-6">
          <CardHeader className="bg-gradient-to-r from-purple-50 to-pink-50 px-3 sm:px-6">
            <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-2">
              <CardTitle className="flex items-center gap-2 text-base sm:text-lg">
                <ClipboardCheck className="h-5 w-5 text-purple-600 shrink-0" />
                تفاصيل الامتحان
              </CardTitle>
              {!editingExamDetails && (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setEditingExamDetails(true)}
                  className="text-blue-600 w-full sm:w-auto"
                >
                  <Edit2 className="h-4 w-4 ml-2" />
                  تعديل التفاصيل
                </Button>
              )}
            </div>
          </CardHeader>
          <CardContent className="pt-4 sm:pt-6 px-3 sm:px-6">
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

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 sm:gap-4">
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
                      value={exam?.duration_minutes || ''}
                      onChange={(e) => setExam({ ...exam, duration_minutes: normalizePositiveInt(e.target.value, 0) })}
                    />
                  </div>
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 sm:gap-4">
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
                    disabled={saving}
                  >
                    <Save className="h-4 w-4 ml-2" />
                    {saving ? 'جاري الحفظ...' : 'حفظ التعديلات'}
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
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 sm:gap-4">
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
                    <p className="font-semibold">{exam.duration_minutes} دقيقة</p>
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
          <CardHeader className="bg-gradient-to-r from-cyan-50 to-teal-50 px-3 sm:px-6">
            <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-2">
              <CardTitle className="flex items-center gap-2 text-sm sm:text-lg">
                <ClipboardCheck className="h-5 w-5 text-cyan-600 shrink-0" />
                <span className="break-words">الأسئلة ({questions.length}) • الدرجة الكلية: {totalMarks} درجة</span>
              </CardTitle>
              {!addingNewQuestion && (
                <Button
                  onClick={() => setAddingNewQuestion(true)}
                  className="bg-green-600 hover:bg-green-700 w-full sm:w-auto"
                >
                  <Plus className="h-4 w-4 ml-2" />
                  إضافة سؤال جديد
                </Button>
              )}
            </div>
          </CardHeader>
          <CardContent className="pt-4 sm:pt-6 px-3 sm:px-6">
            <div className="space-y-4">
              {/* Add New Question Form */}
              {addingNewQuestion && (
                <div className="border-2 border-green-200 rounded-lg p-3 sm:p-4 bg-green-50">
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
                            if (!file) return;
                            await uploadQuestionImage(file, (url) => {
                              setNewQuestion(current => ({ ...current, question_image: url }));
                            });
                          }}
                        />
                        {newQuestion.question_image && (
                          <div className="relative">
                            <img
                              src={newQuestion.question_image.startsWith('http')
                                ? newQuestion.question_image
                                : `${API_ORIGIN}${newQuestion.question_image}`
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
                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
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
                          setNewQuestion({ ...newQuestion, points: normalizePositiveInt(e.target.value, 1) })
                        }
                        placeholder="الدرجة المخصصة للسؤال"
                        min="1"
                      />
                    </div>

                    <div className="flex gap-2">
                      <Button
                        onClick={handleAddNewQuestion}
                        className="bg-green-600 hover:bg-green-700"
                        disabled={saving || !newQuestion.question_text.trim()}
                      >
                        <Plus className="h-4 w-4 ml-2" />
                        {saving ? 'جاري الإضافة...' : 'إضافة السؤال'}
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
                <div key={question.id} className="border rounded-lg p-3 sm:p-4 bg-white">
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
                              if (!file) return;
                              const targetQuestionId = editingQuestion.id;
                              await uploadQuestionImage(file, (url) => {
                                setEditingQuestion(current => (
                                  current && current.id === targetQuestionId
                                    ? { ...current, question_image: url }
                                    : current
                                ));
                              });
                            }}
                          />
                          {editingQuestion.question_image && (
                            <div className="relative">
                              <img
                                src={editingQuestion.question_image.startsWith('http')
                                  ? editingQuestion.question_image
                                  : `${API_ORIGIN}${editingQuestion.question_image}`
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
                          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
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
                            setEditingQuestion({ ...editingQuestion, points: normalizePositiveInt(e.target.value, 1) })
                          }
                        />
                      </div>

                      <div className="flex gap-2">
                        <Button
                          onClick={() => handleUpdateQuestion(editingQuestion)}
                          className="bg-green-600 hover:bg-green-700"
                          disabled={saving}
                        >
                          <Save className="h-4 w-4 ml-2" />
                          {saving ? 'جاري الحفظ...' : 'حفظ'}
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
                      <div className="flex flex-col sm:flex-row justify-between items-start gap-2 mb-3">
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
                                : `${API_ORIGIN}${question.question_image}`
                              }
                              alt="صورة السؤال"
                              className="max-w-full sm:max-w-md rounded-lg mb-3"
                            />
                          )}

                          {question.question_type === 'multiple_choice' && (
                            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 mt-3">
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

                        <div className="flex flex-wrap gap-2">
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => setEditingQuestion(question)}
                            className="text-blue-600"
                            aria-label={`تعديل السؤال ${index + 1}`}
                            title="تعديل السؤال"
                          >
                            <Edit2 className="h-4 w-4" />
                          </Button>
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => handleDeleteQuestion(question.id!)}
                            className="text-red-600"
                            aria-label={`حذف السؤال ${index + 1}`}
                            title="حذف السؤال"
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
