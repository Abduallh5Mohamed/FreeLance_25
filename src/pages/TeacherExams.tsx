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

// ---------------------------------------------------------------------------
// Pure helpers — exported so the isolated test suite exercises the real
// production behavior instead of a re-implementation.
// ---------------------------------------------------------------------------

/** Coerce a marks/degree input to a whole number >= 1 so an emptied number
 *  input can never send NaN to the API. */
export function normalizePositiveInt(value: unknown, fallback = 1): number {
  const n = typeof value === 'number' ? value : parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(n) || n < 1) return fallback;
  return Math.floor(n);
}

/** Total marks and the derived passing marks (percentage clamped to 0..100). */
export function computeExamTotals(
  questions: { marks?: number }[],
  passingScoreRaw: string | number,
): { totalMarks: number; passingPercent: number; passingMarks: number } {
  const totalMarks = (questions || []).reduce((sum, q) => sum + (q?.marks || 0), 0);
  const rawPercent = typeof passingScoreRaw === 'number'
    ? passingScoreRaw
    : parseInt(String(passingScoreRaw ?? ''), 10);
  const passingPercent = Math.max(0, Math.min(100, Number.isFinite(rawPercent) ? rawPercent : 0));
  const passingMarks = Math.ceil((passingPercent / 100) * totalMarks);
  return { totalMarks, passingPercent, passingMarks };
}

/** Normalize a datetime-local / ISO value to `YYYY-MM-DD HH:mm:ss`. */
export function formatExamDateTime(value: string | null | undefined): string | null {
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
}

/** Canonical Authorization header for the scoped raw-fetch calls. Mirrors the
 *  api-http transport (`Authorization: Bearer <authToken>` from localStorage);
 *  the backend now requires auth on these exam routes, so omitting the header
 *  turns a legitimate request into a 401. Omitted entirely when no token. */
export function buildAuthHeaders(): Record<string, string> {
  try {
    const token = typeof localStorage !== 'undefined' ? localStorage.getItem('authToken') : null;
    return token ? { Authorization: `Bearer ${token}` } : {};
  } catch {
    return {};
  }
}

/** RequestInit for the authenticated image upload. FormData must NOT set a
 *  Content-Type header — the browser adds the multipart boundary itself. */
export function buildImageUploadRequestInit(formData: FormData): RequestInit {
  return { method: 'POST', headers: buildAuthHeaders(), body: formData };
}

/** An auth/permission rejection (401/403) must surface as a session error and
 *  never be treated as success or as a generic failure. */
export function isAuthFailure(status: number): boolean {
  return status === 401 || status === 403;
}

/** Injectable fetch signature so the real production request calls below can
 *  be exercised without a browser or network. */
export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/** JSON RequestInit for a protected authoring mutation. The Authorization
 *  header is added only when a token exists; without one it is omitted
 *  entirely so a request is never sent as `Bearer null` / `Bearer `. */
export function buildJsonRequestInit(method: string, body: unknown): RequestInit {
  return {
    method,
    headers: { 'Content-Type': 'application/json', ...buildAuthHeaders() },
    body: JSON.stringify(body),
  };
}

/** Read the current acting identity (user id + token) so a retained orphan can
 *  be scoped to the session that created it and never leaks to another user. */
export function readCurrentIdentity(): string | null {
  try {
    if (typeof localStorage === 'undefined') return null;
    const userStr = localStorage.getItem('currentUser');
    const token = localStorage.getItem('authToken');
    if (!userStr && !token) return null;
    let userId = '';
    if (userStr) {
      try {
        userId = String((JSON.parse(userStr) as { id?: unknown } | null)?.id ?? '');
      } catch {
        userId = '';
      }
    }
    return `${userId}|${token ?? ''}`;
  } catch {
    return null;
  }
}

/** Build the production dependencies for the authoring controller. The fetch
 *  implementation is injectable so the real request construction and the
 *  rollback response handling can be tested without a live server. */
export function createExamAuthoringDeps(fetchImpl: FetchLike = fetch): ExamAuthoringDeps {
  return {
    getIdentity: readCurrentIdentity,
    createExam: async (payload) => {
      const response = await fetchImpl(`${API_URL}/exams`, buildJsonRequestInit('POST', payload));
      if (!response.ok) throw new Error('Failed to create exam');
      return response.json();
    },
    addQuestion: async (examId, payload) => {
      const response = await fetchImpl(`${API_URL}/exams/${examId}/questions`, buildJsonRequestInit('POST', payload));
      if (!response.ok) throw new Error('Failed to add question');
      return response.json();
    },
    deleteExam: async (examId) => {
      const response = await fetchImpl(`${API_URL}/exams/${examId}`, {
        method: 'DELETE',
        headers: buildAuthHeaders(),
      });
      // The rollback DELETE must not report success on a rejected response, or a
      // failed cleanup would silently leave an orphan exam behind.
      if (!response.ok) throw new Error('Failed to delete exam');
      return response.json().catch(() => ({}));
    },
  };
}

export interface TeacherExamPayloadInput {
  course_id: string;
  grade_id: string | null;
  group_ids: string[] | null;
  title: string;
  description: string | null;
  duration_minutes: string | number;
  total_marks: number;
  passing_marks: number;
  passing_percentage: number;
  start_time: string;
  end_time: string;
}

/** Build the POST /exams payload for the teacher authoring form. */
export function buildTeacherExamPayload(input: TeacherExamPayloadInput) {
  return {
    course_id: input.course_id,
    grade_id: input.grade_id || null,
    group_ids: input.group_ids && input.group_ids.length > 0 ? input.group_ids : null,
    title: input.title,
    description: input.description || null,
    duration_minutes: normalizePositiveInt(input.duration_minutes, 60),
    total_marks: input.total_marks,
    passing_marks: input.passing_marks,
    passing_percentage: input.passing_percentage,
    is_active: true,
    // Provide both unified ISO strings; backend will extract DATE() and TIME()
    start_date: input.start_time,
    end_date: input.end_time,
    start_time: input.start_time,
    end_time: input.end_time,
  };
}

export interface ExamAuthoringDeps {
  createExam: (payload: unknown) => Promise<{ id: string }>;
  addQuestion: (examId: string, payload: unknown) => Promise<unknown>;
  deleteExam: (examId: string) => Promise<unknown>;
  /** Current acting identity (user id + token). Used to scope a retained orphan
   *  so it can never leak across a user/token change. Optional; when absent the
   *  controller behaves as a single-session (identity `null`) flow. */
  getIdentity?: () => string | null;
}

export type ExamAuthoringOutcome =
  | { status: 'blocked' }
  | { status: 'orphan-pending'; examId: string }
  /**
   * The acting identity/token changed while the multi-step authoring operation
   * was in flight. No later phase ran under the new session, nothing was
   * deleted, and the outcome deliberately carries NO exam id: the retained
   * exam (if any) is recoverable only by the identity that started the save.
   */
  | { status: 'identity-changed' }
  | { status: 'created'; examId: string; questionsAdded: number }
  | { status: 'rolled-back'; examId: string; questionsAdded: number; error: Error }
  | { status: 'cleanup-failed'; examId: string; questionsAdded: number; error: Error; cleanupError: Error };

/** Single-flight controller for "create exam + insert its questions".
 *  - blocks duplicate concurrent submits (deny);
 *  - captures the INITIATING identity once, before the first request, and
 *    re-checks it before every later phase (each question insert, the
 *    compensating delete, and every outcome returned to the caller), so a
 *    multi-step save can never continue — or report its result — under a
 *    different user/token;
 *  - reports success only after the server accepted every question;
 *  - on a mid-way question failure it compensates by deleting the exam it
 *    just created, so a failed save never leaves an orphan exam behind;
 *  - if that compensating delete itself fails, the orphan exam id is retained
 *    UNDER ITS ORIGINAL OWNER and further submits by that owner are refused
 *    until acknowledged, so a failed save can never silently recreate a
 *    duplicate exam, while another identity never sees the id. */
export function createExamAuthoringController(deps: ExamAuthoringDeps) {
  const identityOf = deps.getIdentity ?? (() => null);
  let inFlight = false;
  let orphanExamId: string | null = null;
  // Identity that owned the orphan, so it is only surfaced to the same session.
  let orphanOwner: string | null = null;
  const ownsOrphan = () => orphanExamId !== null && orphanOwner === identityOf();
  return {
    isBusy: () => inFlight,
    /** The exam id left behind when a question failed AND its rollback delete
     *  also failed, scoped to the current identity; null once acknowledged or
     *  when the orphan belongs to a different user/token. */
    orphanExamId: () => (ownsOrphan() ? orphanExamId : null),
    /** Acknowledge the orphan so authoring is allowed again. Explicit only:
     *  we never silently retry a destructive delete. */
    clearOrphan: () => { orphanExamId = null; orphanOwner = null; },
    async submit(examPayload: unknown, questionPayloads: unknown[]): Promise<ExamAuthoringOutcome> {
      if (inFlight) return { status: 'blocked' };
      // A previous save under the SAME identity left an exam we could not clean
      // up; refuse to create a second one until the caller acknowledges. An
      // orphan from a different identity must not block or leak into this one.
      if (ownsOrphan()) return { status: 'orphan-pending', examId: orphanExamId as string };

      // Capture the operation scope ONCE. Every later phase is attributed to
      // this identity, not to whoever happens to be logged in at that moment.
      const initiator = identityOf();
      const stillInitiator = () => identityOf() === initiator;
      const retainOrphan = (id: string) => {
        orphanExamId = id;
        orphanOwner = initiator; // the ORIGINAL owner, never the current session
      };

      inFlight = true;
      try {
        const created = await deps.createExam(examPayload);
        const examId = created?.id;
        if (!examId) throw new Error('createExam returned no id');

        // The session changed while create was pending: do not add questions,
        // do not delete, and do not surface the id to the new session.
        if (!stillInitiator()) {
          retainOrphan(examId);
          return { status: 'identity-changed' };
        }

        let questionsAdded = 0;
        try {
          for (const payload of questionPayloads) {
            // Re-check before each subsequent write.
            if (!stillInitiator()) {
              retainOrphan(examId);
              return { status: 'identity-changed' };
            }
            await deps.addQuestion(examId, payload);
            questionsAdded += 1;
          }
        } catch (err) {
          const error = err instanceof Error ? err : new Error(String(err));
          // Destructive cleanup must never run under a different identity.
          if (!stillInitiator()) {
            retainOrphan(examId);
            return { status: 'identity-changed' };
          }
          try {
            await deps.deleteExam(examId);
            if (!stillInitiator()) {
              // The rollback did happen, so nothing is left behind; the outcome
              // itself belongs to the initiating session only.
              return { status: 'identity-changed' };
            }
            return { status: 'rolled-back', examId, questionsAdded, error };
          } catch (cleanupErr) {
            const cleanupError = cleanupErr instanceof Error ? cleanupErr : new Error(String(cleanupErr));
            retainOrphan(examId);
            if (!stillInitiator()) return { status: 'identity-changed' };
            return { status: 'cleanup-failed', examId, questionsAdded, error, cleanupError };
          }
        }

        // Final commit gate: a save that finished after the session changed is
        // never reported as this session's success.
        if (!stillInitiator()) {
          retainOrphan(examId);
          return { status: 'identity-changed' };
        }

        return { status: 'created', examId, questionsAdded };
      } finally {
        inFlight = false;
      }
    },
  };
}

const examAuthoringController = createExamAuthoringController(createExamAuthoringDeps());

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
  // Set when a failed save could not clean up its exam; blocks new creates.
  const [orphanExamId, setOrphanExamId] = useState<string | null>(null);

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

    if (!user || (user.role !== 'teacher' && user.role !== 'admin' && user.role !== 'staff' && user.role !== 'instructor')) {
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

    if (!Number.isFinite(currentQuestion.marks) || currentQuestion.marks < 1) {
      toast({
        title: 'خطأ',
        description: 'يرجى إدخال درجة صحيحة للسؤال (1 على الأقل)',
        variant: 'destructive'
      });
      return;
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
      const { totalMarks, passingPercent, passingMarks } = computeExamTotals(questions, examData.passing_score);

      // Normalize date/time for backend (expects exam_date + start_time/end_time derived)
      const startDateTime = formatExamDateTime(examData.start_date) || new Date().toISOString().replace('T', ' ').substring(0, 19);
      const endDateTime = formatExamDateTime(examData.end_date) || new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString().replace('T', ' ').substring(0, 19);

      const examPayload = buildTeacherExamPayload({
        course_id: selectedCourse,
        grade_id: examData.grade_id || null,  // ✅ Include grade_id
        group_ids: selectedGroupIds.length > 0 ? selectedGroupIds : null, // ✅ Include group_ids
        title: examData.title,
        description: examData.description || null,
        duration_minutes: examData.duration_minutes,
        total_marks: totalMarks,
        passing_marks: passingMarks, // computed from percentage
        passing_percentage: passingPercent,
        start_time: startDateTime,
        end_time: endDateTime,
      });

      const questionPayloads = questions.map((question, i) => {
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

        return {
          question_text: question.question_text,
          question_image: question.question_image || null,  // ✅ Include image
          question_type: question.question_type,  // ✅ Include type
          options: options,
          correct_answer: correctAnswer,
          points: normalizePositiveInt(question.marks, 1),
          display_order: i + 1
        };
      });

      const outcome = await examAuthoringController.submit(examPayload, questionPayloads);

      if (outcome.status === 'blocked') return; // duplicate submit ignored

      if (outcome.status === 'orphan-pending') {
        // A previous failed save still owns an uncleaned exam; refuse to create
        // a second one and keep the user's form intact.
        setOrphanExamId(outcome.examId);
        toast({
          title: 'خطأ',
          description: `يوجد امتحان سابق لم يكتمل حذفه (المعرف: ${outcome.examId}). راجع الامتحانات ثم أكّد المتابعة.`,
          variant: 'destructive'
        });
        return;
      }

      if (outcome.status === 'identity-changed') {
        // The session/token changed while the save was running. Nothing was
        // deleted and no id is reported: keep the form intact and tell the
        // operator the save must be reviewed under the original session.
        toast({
          title: 'انتهت الجلسة',
          description: 'تغيّرت جلسة المستخدم أثناء الحفظ، ولم تُنشأ أسئلة إضافية ولم يُحذف شيء. راجع الامتحانات ثم أعد المحاولة من الجلسة الصحيحة.',
          variant: 'destructive'
        });
        return;
      }

      if (outcome.status === 'cleanup-failed') {
        console.error('Error creating exam:', outcome.error);
        setOrphanExamId(outcome.examId);
        toast({
          title: 'خطأ',
          description: `فشل إنشاء الامتحان (تعذر إضافة السؤال ${outcome.questionsAdded + 1}) وبقي الامتحان بالمعرف ${outcome.examId} بدون حذف. لم تتم إعادة المحاولة تلقائياً.`,
          variant: 'destructive'
        });
        return;
      }

      if (outcome.status === 'rolled-back') {
        console.error('Error creating exam:', outcome.error);
        toast({
          title: 'خطأ',
          description: `فشل إنشاء الامتحان وتم التراجع (تعذر إضافة السؤال ${outcome.questionsAdded + 1})`,
          variant: 'destructive'
        });
        return;
      }

      toast({
        title: 'نجح',
        description: `تم إنشاء الامتحان بنجاح مع ${outcome.questionsAdded} سؤال`
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
        headers: buildAuthHeaders()
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
                        min={1}
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
                                  const response = await fetch(`${API_URL}/exams/upload-question-image`, buildImageUploadRequestInit(formData));

                                  const data = await response.json().catch(() => null);
                                  if (response.ok && data?.success) {
                                    setCurrentQuestion({ ...currentQuestion, question_image: data.imageUrl });
                                    toast({ title: 'تم رفع الصورة بنجاح' });
                                  } else {
                                    toast({
                                      title: isAuthFailure(response.status)
                                        ? 'انتهت الجلسة، يرجى تسجيل الدخول مجدداً'
                                        : 'فشل رفع الصورة',
                                      variant: 'destructive'
                                    });
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
                              src={currentQuestion.question_image.startsWith('http')
                                ? currentQuestion.question_image
                                : `/api${currentQuestion.question_image}`
                              }
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
                                onChange={(e) => setCurrentQuestion({ ...currentQuestion, marks: normalizePositiveInt(e.target.value, 1) })}
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
                              aria-label={`حذف السؤال ${index + 1}`}
                              title="حذف السؤال"
                            >
                              <Trash2 className="h-4 w-4" />
                            </Button>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  {orphanExamId && (
                    <div className="rounded-md border border-red-300 bg-red-50 p-3 text-sm text-red-700 flex items-center justify-between gap-3">
                      <span>
                        يوجد امتحان غير مكتمل لم يُحذف (المعرف: {orphanExamId}). لن يتم إنشاء امتحان جديد حتى تأكيد المعالجة.
                      </span>
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={() => {
                          examAuthoringController.clearOrphan();
                          setOrphanExamId(null);
                        }}
                      >
                        تأكيد المعالجة
                      </Button>
                    </div>
                  )}

                  <Button
                    type="submit"
                    disabled={loading || questions.length === 0 || orphanExamId !== null}
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
                              aria-label={`تعديل امتحان ${exam.title}`}
                              title="تعديل الامتحان"
                            >
                              <Edit className="h-4 w-4" />
                            </Button>
                            <Button
                              variant="ghost"
                              size="sm"
                              onClick={() => handleDeleteExam(exam.id)}
                              className="text-red-600 hover:text-red-700"
                              aria-label={`حذف امتحان ${exam.title}`}
                              title="حذف الامتحان"
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
