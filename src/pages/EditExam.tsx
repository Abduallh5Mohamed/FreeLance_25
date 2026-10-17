import { useState, useEffect, useMemo, useRef } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { useToast } from '@/hooks/use-toast';
import { getExamById, User, getCourses, getGrades, getGroups, Course, Grade, Group, Exam } from '@/lib/api-http';
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

/** RequestInit for the authenticated question-list load (GET, no body). */
export function buildQuestionListRequestInit(): RequestInit {
  return { headers: buildAuthHeaders() };
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

/** HTTP failure carrying its status so callers can classify 401/403. */
export class ExamHttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = 'ExamHttpError';
    this.status = status;
  }
}

/** Injectable fetch signature so the real production request calls below can
 *  be exercised without a browser or network. */
export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/** JSON RequestInit for a protected authoring mutation. The Authorization
 *  header is added only when a token exists; without one it is omitted
 *  entirely so a request is never sent as `Bearer null` / `Bearer ` and the
 *  server's 401 is surfaced instead of being presented as success. */
export function buildJsonRequestInit(method: string, body: unknown): RequestInit {
  return {
    method,
    headers: { 'Content-Type': 'application/json', ...buildAuthHeaders() },
    body: JSON.stringify(body),
  };
}

/** Production GET for an exam's question list (the real request the page
 *  sends). A non-ok response becomes an ExamHttpError so 401/403 is classified
 *  as a session failure and never treated as a successful empty load. */export async function loadExamQuestions(
  examId: string,
  fetchImpl: FetchLike = fetch,
): Promise<any[]> {
  const response = await fetchImpl(
    `${API_URL}/exams/${examId}/questions`,
    buildQuestionListRequestInit(),
  );
  if (!response.ok) throw new ExamHttpError(response.status, 'Failed to load questions');
  const data = await response.json().catch(() => null);
  return Array.isArray(data) ? data : [];
}

/** Production image upload (the real request the page sends). Returns a
 *  discriminated result so the caller can tell an auth rejection from a
 *  generic failure and never treats a rejection as success. */
export async function uploadQuestionImage(
  formData: FormData,
  fetchImpl: FetchLike = fetch,
): Promise<{ ok: boolean; status: number; imageUrl?: string }> {
  const response = await fetchImpl(
    `${API_URL}/exams/upload-question-image`,
    buildImageUploadRequestInit(formData),
  );
  const result: any = await response.json().catch(() => null);
  const success = response.ok && !!result?.success;
  return { ok: success, status: response.status, imageUrl: success ? result.imageUrl : undefined };
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

export interface EditExamRouteLoadStart {
  token: number;
  /**
   * True when this load belongs to a DIFFERENT exam than the one on screen, so
   * the caller must retire the previous route's data before awaiting anything.
   */
  reset: boolean;
}

export interface EditExamRouteLoadGuard {
  begin(scope: string): EditExamRouteLoadStart;
  /** True only while `token` is still the newest load. */
  isCurrent(token: number): boolean;
  /** True only while the on-screen data belongs to `scope`. */
  isScopeCurrent(scope: string): boolean;
  /**
   * Route generation: changes ONLY on a scope change or unmount — never on a
   * same-scope reload — so save/upload operations can fence their commits
   * against route transitions without being superseded by their own reload.
   */
  currentRouteGeneration(): number;
  /** Unmount/teardown: retire every outstanding load and operation. */
  invalidate(): void;
}

/**
 * Route-load lifecycle of the EditExam page.
 *
 * Two independent decisions are needed and were previously conflated:
 *  - a newer load supersedes an older one (load generation), so a stale
 *    response can never commit;
 *  - a load for a DIFFERENT exam must retire the previous exam's data first, so
 *    a failed question fetch can never leave the new exam header paired with the
 *    old route's questions;
 *  - a save/upload that finishes after the route moved on must NOT commit or
 *    reload its old exam over the current one (route generation + operation
 *    tokens below; string-only scope equality fails for A -> B -> A, because
 *    the loaded scope legitimately returns to 'A').
 */
export const createEditExamRouteLoadGuard = (): EditExamRouteLoadGuard => {
  let loadGeneration = 0;
  let routeGeneration = 0;
  let loadedScope: string | null = null;
  return {
    begin(scope: string): EditExamRouteLoadStart {
      const reset = loadedScope !== scope;
      if (reset) routeGeneration += 1;
      loadedScope = scope;
      return { token: ++loadGeneration, reset };
    },
    isCurrent(token: number): boolean {
      return token === loadGeneration;
    },
    isScopeCurrent(scope: string): boolean {
      return loadedScope === scope;
    },
    currentRouteGeneration(): number {
      return routeGeneration;
    },
    invalidate(): void {
      loadGeneration += 1;
      routeGeneration += 1;
    },
  };
};

// ---------------------------------------------------------------------------
// Per-operation save/upload fencing.
//
// Guarding only the reload is not enough: EVERY state, toast, form
// reset/close and image commit of a save/upload must be fenced by a
// per-operation token that captures the route generation at start, the target
// identity AND the target's form-lifetime incarnation. A completion may commit
// only while the operation still owns the current route AND target, so:
//  - an A -> B late success cannot close B's form, reset B's draft or toast
//    over B;
//  - A -> B -> A cannot revive A's stale commit (string-only scope equality
//    would pass, because the loaded scope legitimately returns to 'A');
//  - an unmount invalidates every outstanding operation;
//  - out-of-order same-target uploads cannot let the older image overwrite the
//    newer one (the newest commit wins; a later failure never revives an older
//    result);
//  - closing/reopening a draft or cancelling/reopening the same question
//    editor advances that form's incarnation, so a completion from the
//    previous form session can never commit into the new one;
//  - every operation captures an IMMUTABLE operation kind at start
//    (details / new-draft / edit-question / delete-list). Authority is NEVER
//    re-inferred from the current UI at completion: an editor save/upload
//    stays an editor operation even after the editor closes, so it must
//    always require its original target and form incarnation, while a list
//    delete stays list authority and never requires an open editor.
// A failed same-scope save keeps the user's edits — only a toast is shown.
// ---------------------------------------------------------------------------

/** The form/target a save or upload operation acts on. */
export type EditExamOperationTarget = 'details' | 'new' | string;

/** The immutable authority an operation captures when it starts. It decides
 *  which fencing rules apply at completion and is NEVER derived from the
 *  current UI state, so closing an editor can never reclassify an in-flight
 *  editor operation into list authority. */
export type EditExamOperationKind = 'details' | 'new-draft' | 'edit-question' | 'delete-list';

/** Form-lifetime generations an operation captures when it starts. A form
 *  target is current only while BOTH its identity and its incarnation are
 *  unchanged; the page advances the incarnation at every real form boundary
 *  (open / close / switch / reset / new-draft). */
export interface EditExamOperationGenerations {
  /** Incarnation of the new-question draft. */
  newDraft?: number;
  /** Incarnation of the question edit form. */
  editForm?: number;
}

export interface EditExamOperationToken {
  scope: string;
  /** Immutable operation authority captured when the operation started. */
  kind: EditExamOperationKind;
  /** Route generation captured when the operation started. */
  routeGeneration: number;
  /** Monotonic per-tracker operation number (out-of-order protection). */
  operation: number;
  target: EditExamOperationTarget;
  /** New-draft incarnation captured when the operation started. */
  newDraftGeneration?: number;
  /** Edit-form incarnation captured when the operation started. */
  editFormGeneration?: number;
}

export interface EditExamOperationState {
  scope: string;
  routeGeneration: number;
  editingQuestionId: string | null;
  addingNewQuestion: boolean;
  /** Current incarnation of the new-question draft (advanced by the page). */
  newDraftGeneration: number;
  /** Current incarnation of the question edit form (advanced by the page). */
  editFormGeneration: number;
}

/** Strict incarnation equality: an operation can only prove ownership of a
 *  form whose lifetime generation is both present and unchanged. */
function ownsGeneration(captured: number | undefined, current: number | undefined): boolean {
  return typeof current === 'number' && captured === current;
}

/** True only while the operation still owns the current route and target.
 *  The fencing rules are selected by the IMMUTABLE captured kind, never by
 *  the current UI: closing the editor can never turn an editor save/upload
 *  into list authority, and a list delete never requires an editor. */
export function isEditExamOperationCurrent(
  token: EditExamOperationToken,
  state: EditExamOperationState,
): boolean {
  if (token.routeGeneration !== state.routeGeneration) return false;
  if (token.scope !== state.scope) return false;
  switch (token.kind) {
    case 'details':
      return true;
    case 'new-draft':
      // The new-question draft must still be open, no edit form may have taken
      // over the screen, and the draft must be the SAME incarnation the
      // operation started in (close/reopen advances the generation).
      return (
        state.addingNewQuestion &&
        state.editingQuestionId === null &&
        ownsGeneration(token.newDraftGeneration, state.newDraftGeneration)
      );
    case 'edit-question':
      // Editor save/upload ALWAYS requires the original target AND the form
      // incarnation captured at start — even when the editor is now closed.
      // A closed, switched or reopened editor retires the operation; it never
      // falls back to list authority.
      return (
        state.editingQuestionId === token.target &&
        ownsGeneration(token.editFormGeneration, state.editFormGeneration)
      );
    case 'delete-list':
      // List authority: the list Delete button runs OUTSIDE any editor, so it
      // must never require an open editor or form identity. Route/scope
      // fencing and per-question completion ordering govern; a DIFFERENT open
      // editor keeps the delete fenced so its reload never lands under
      // another question's editor.
      return state.editingQuestionId === null || state.editingQuestionId === token.target;
  }
}

export interface EditExamOperationTracker {
  begin(
    kind: EditExamOperationKind,
    target: EditExamOperationTarget,
    scope: string,
    routeGeneration: number,
    generations?: EditExamOperationGenerations,
  ): EditExamOperationToken;
  /**
   * Record a completion (success OR failure) for the token's target. False
   * when a NEWER operation for the same target already completed — the older
   * result must not commit (an older upload cannot overwrite after a newer
   * attempt failed) and a stale failure must not toast over a newer
   * successful result.
   */
  recordCompletion(token: EditExamOperationToken): boolean;
}

export const createEditExamOperationTracker = (): EditExamOperationTracker => {
  let sequence = 0;
  const latestCompletion = new Map<EditExamOperationTarget, number>();
  return {
    begin(kind, target, scope, routeGeneration, generations) {
      return {
        scope,
        kind,
        routeGeneration,
        operation: ++sequence,
        target,
        newDraftGeneration: generations?.newDraft,
        editFormGeneration: generations?.editForm,
      };
    },
    recordCompletion(token) {
      const last = latestCompletion.get(token.target) ?? 0;
      if (last > token.operation) return false;
      latestCompletion.set(token.target, token.operation);
      return true;
    },
  };
};

/** Result of one protected authoring request. */
export interface EditExamOperationResult {
  ok: boolean;
  status: number;
  imageUrl?: string;
}

export type EditExamOperationOutcome = 'committed' | 'superseded' | 'failed';

export interface EditExamOperationSinks {
  /** Success commits (toast/close/reset/image) — called only when current. */
  commit(result: EditExamOperationResult): void;
  /** Failure commits (toast) — called only when current; the form is kept. */
  reject(result: EditExamOperationResult): void;
  /** Reload the saved scope (the page keeps its own scope guard). */
  reload(scope: string): void;
}

/**
 * The production lifecycle every save/upload handler runs through: capture the
 * operation kind, execute the real request, and commit only while the
 * operation still owns the route and target under its captured authority.
 */
export async function runEditExamOperation(
  params: {
    scope: string;
    /** Immutable operation authority, passed by the actual handler. */
    kind: EditExamOperationKind;
    target: EditExamOperationTarget;
    execute: () => Promise<EditExamOperationResult>;
  },
  deps: {
    tracker: EditExamOperationTracker;
    readState: () => EditExamOperationState;
    sinks: EditExamOperationSinks;
  },
): Promise<EditExamOperationOutcome> {
  const startState = deps.readState();
  const token = deps.tracker.begin(
    params.kind,
    params.target,
    params.scope,
    startState.routeGeneration,
    { newDraft: startState.newDraftGeneration, editForm: startState.editFormGeneration },
  );
  const result = await params.execute();
  if (!isEditExamOperationCurrent(token, deps.readState())) return 'superseded';
  // The newest completion per target wins: an older upload cannot commit
  // after a newer attempt (failed or not) completed, and a stale failure
  // cannot toast over a newer successful result.
  if (!deps.tracker.recordCompletion(token)) return 'superseded';
  if (!result.ok) {
    deps.sinks.reject(result);
    return 'failed';
  }
  deps.sinks.commit(result);
  deps.sinks.reload(params.scope);
  return 'committed';
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

  const [saving, setSaving] = useState(false);
  const saveGuardRef = useRef(createSingleFlightGuard());
  // Route-load lifecycle: generation + which exam the on-screen data belongs to.
  const routeGuardRef = useRef(createEditExamRouteLoadGuard());

  // Per-operation fencing: refs always hold the LATEST route/target state, so a
  // completion that arrives after a route change checks the CURRENT screen
  // (not the render the operation started from).
  const operationTrackerRef = useRef(createEditExamOperationTracker());
  const examIdRef = useRef(examId);
  const editingQuestionIdRef = useRef<string | null>(null);
  const addingNewQuestionRef = useRef(false);
  // Form-lifetime incarnations: advanced by the page at real form boundaries
  // (open / close / switch / reset / new-draft) so a completion from a
  // previous form session can never commit into a new one.
  const newDraftGenerationRef = useRef(0);
  const editFormGenerationRef = useRef(0);
  useEffect(() => {
    examIdRef.current = examId;
  }, [examId]);
  useEffect(() => {
    editingQuestionIdRef.current = editingQuestion?.id ?? null;
  }, [editingQuestion]);
  useEffect(() => {
    addingNewQuestionRef.current = addingNewQuestion;
  }, [addingNewQuestion]);

  const readOperationState = (): EditExamOperationState => ({
    scope: examIdRef.current ?? '',
    routeGeneration: routeGuardRef.current.currentRouteGeneration(),
    editingQuestionId: editingQuestionIdRef.current,
    addingNewQuestion: addingNewQuestionRef.current,
    newDraftGeneration: newDraftGenerationRef.current,
    editFormGeneration: editFormGenerationRef.current,
  });

  // Form-lifetime boundaries. Every open/close/switch/reset of a question form
  // advances that form's incarnation; in-flight operations capture the
  // incarnation they started in and are fenced when it moves.
  const openNewQuestionDraft = () => {
    newDraftGenerationRef.current += 1;
    setAddingNewQuestion(true);
  };
  const closeNewQuestionDraft = () => {
    newDraftGenerationRef.current += 1;
    setAddingNewQuestion(false);
  };
  const openQuestionEditor = (question: Question | null) => {
    editFormGenerationRef.current += 1;
    setEditingQuestion(question);
  };

  // Single-flight wrapper: blocks concurrent save submits and mirrors the
  // in-flight state into `saving` so the submit buttons can be disabled.
  const runGuardedSave = async (task: () => Promise<void>) => {
    if (saveGuardRef.current.isBusy()) return;
    setSaving(true);
    try {
      await saveGuardRef.current.run(task);
    } finally {
      setSaving(false);
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

  const loadExamData = async (scope: string = examId ?? '') => {
    const { token: seq, reset } = routeGuardRef.current.begin(scope);
    if (reset) {
      // A route/scope change retires the PREVIOUS exam's data before the new
      // load starts: a failed new question fetch must never leave the new exam
      // header paired with the old route's questions.
      setExam(null);
      setQuestions([]);
    }
    try {
      setLoading(true);

      // Load exam details
      const examData = (await getExamById(scope)) as ExamDetail | null;
      if (!routeGuardRef.current.isCurrent(seq)) return; // a newer load superseded this one

      // Convert ISO dates to local datetime-local format (YYYY-MM-DDTHH:mm)
      if (examData?.start_time) {
        const startDate = new Date(examData.start_time);
        examData.start_time = startDate.getFullYear() + '-' +
          String(startDate.getMonth() + 1).padStart(2, '0') + '-' +
          String(startDate.getDate()).padStart(2, '0') + 'T' +
          String(startDate.getHours()).padStart(2, '0') + ':' +
          String(startDate.getMinutes()).padStart(2, '0');
      }

      if (examData?.end_time) {
        const endDate = new Date(examData.end_time);
        examData.end_time = endDate.getFullYear() + '-' +
          String(endDate.getMonth() + 1).padStart(2, '0') + '-' +
          String(endDate.getDate()).padStart(2, '0') + 'T' +
          String(endDate.getHours()).padStart(2, '0') + ':' +
          String(endDate.getMinutes()).padStart(2, '0');
      }

      setExam(examData);

      // Load questions
      const questionsData = await loadExamQuestions(scope);
      if (!routeGuardRef.current.isCurrent(seq)) return; // stale response, drop it

      // Parse options for multiple choice questions
      const parsedQuestions = questionsData.map((q: any) => ({
        ...q,
        ...normalizeQuestionOptions(q.options),
      }));

      setQuestions(parsedQuestions);
    } catch (error) {
      if (!routeGuardRef.current.isCurrent(seq)) return; // stale failure, keep current view
      console.error('Error loading exam:', error);
      const authFailure = error instanceof ExamHttpError && isAuthFailure(error.status);
      toast({
        title: 'خطأ',
        description: authFailure
          ? 'انتهت الجلسة أو لا تملك صلاحية الوصول لهذا الامتحان'
          : 'فشل تحميل بيانات الامتحان',
        variant: 'destructive'
      });
    } finally {
      if (routeGuardRef.current.isCurrent(seq)) setLoading(false);
    }
  };

  /** Reload only when the route still shows the exam this save belonged to. */
  const reloadSavedScope = (scope: string) => {
    if (routeGuardRef.current.isScopeCurrent(scope)) loadExamData(scope);
  };

  // Unmount/teardown: retire every outstanding load.
  useEffect(() => () => routeGuardRef.current.invalidate(), []);

  const handleUpdateExamDetails = async () => {
    // Capture the exam this save belongs to, so a completion that arrives after
    // the route moved on cannot reload the old exam over the current one.
    const saveScope = examId ?? '';
    await runGuardedSave(async () => {
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
        total_marks: totalMarks  // ✅ Auto-update total marks from questions
      };

      console.log('🔄 Updating exam with data:', updateData);

      await runEditExamOperation(
        {
          scope: saveScope,
          kind: 'details',
          target: 'details',
          execute: async () => {
            try {
              const response = await fetch(`${API_URL}/exams/${saveScope}`, buildJsonRequestInit('PUT', updateData));
              if (!response.ok) {
                const errorData = await response.json().catch(() => null);
                console.error('❌ Update failed:', errorData);
                return { ok: false, status: response.status };
              }
              const result = await response.json().catch(() => null);
              console.log('✅ Update successful:', result);
              return { ok: true, status: response.status };
            } catch (error) {
              console.error('❌ Error updating exam:', error);
              return { ok: false, status: 0 };
            }
          },
        },
        {
          tracker: operationTrackerRef.current,
          readState: readOperationState,
          sinks: {
            commit: () => {
              toast({
                title: 'تم التحديث',
                description: 'تم تحديث بيانات الامتحان بنجاح'
              });
              setEditingExamDetails(false);
            },
            reject: () => {
              // A failed same-scope save keeps the form and the user's edits.
              toast({
                title: 'خطأ',
                description: 'فشل تحديث بيانات الامتحان',
                variant: 'destructive'
              });
            },
            reload: (scope) => reloadSavedScope(scope),
          },
        },
      );
    });
  };

  const handleUpdateQuestion = async (question: Question) => {
    const saveScope = examId ?? '';
    await runGuardedSave(async () => {
      const options = question.question_type === 'multiple_choice'
        ? JSON.stringify({
          a: question.option_a,
          b: question.option_b,
          c: question.option_c,
          d: question.option_d
        })
        : null;

      await runEditExamOperation(
        {
          scope: saveScope,
          kind: 'edit-question',
          target: question.id ?? '',
          execute: async () => {
            try {
              const response = await fetch(`${API_URL}/exams/${saveScope}/questions/${question.id}`, buildJsonRequestInit('PUT', {
                question_text: question.question_text,
                question_image: question.question_image || null,
                question_type: question.question_type,
                options: options,
                correct_answer: question.correct_answer || null,
                points: normalizePositiveInt(question.points, 1),
                explanation: null
              }));
              return { ok: response.ok, status: response.status };
            } catch (error) {
              console.error('Error updating question:', error);
              return { ok: false, status: 0 };
            }
          },
        },
        {
          tracker: operationTrackerRef.current,
          readState: readOperationState,
          sinks: {
            commit: () => {
              toast({
                title: 'تم التحديث',
                description: 'تم تحديث السؤال بنجاح'
              });
              openQuestionEditor(null);
            },
            reject: () => {
              // A failed save keeps the edit form and the user's input.
              toast({
                title: 'خطأ',
                description: 'فشل تحديث السؤال',
                variant: 'destructive'
              });
            },
            reload: (scope) => reloadSavedScope(scope),
          },
        },
      );
    });
  };

  const handleDeleteQuestion = async (questionId: string) => {
    if (!confirm('هل أنت متأكد من حذف هذا السؤال؟')) return;
    const saveScope = examId ?? '';

    // Single-flight: a second click must never fire a duplicate DELETE.
    await runGuardedSave(async () => {
      await runEditExamOperation(
        {
          scope: saveScope,
          // The list Delete button runs OUTSIDE any editor (editingQuestionId
          // is normally null): the delete-list authority requires route/scope
          // fencing and per-question completion ordering only — never an open
          // editor or form identity.
          kind: 'delete-list',
          target: questionId,
          execute: async () => {
            try {
              const response = await fetch(`${API_URL}/exams/${saveScope}/questions/${questionId}`, {
                method: 'DELETE',
                headers: buildAuthHeaders()
              });
              return { ok: response.ok, status: response.status };
            } catch (error) {
              console.error('Error deleting question:', error);
              return { ok: false, status: 0 };
            }
          },
        },
        {
          tracker: operationTrackerRef.current,
          readState: readOperationState,
          sinks: {
            commit: () => {
              toast({
                title: 'تم الحذف',
                description: 'تم حذف السؤال بنجاح'
              });
            },
            reject: () => {
              toast({
                title: 'خطأ',
                description: 'فشل حذف السؤال',
                variant: 'destructive'
              });
            },
            reload: (scope) => reloadSavedScope(scope),
          },
        },
      );
    });
  };

  const handleAddNewQuestion = async () => {
    const saveScope = examId ?? '';
    await runGuardedSave(async () => {
      const options = newQuestion.question_type === 'multiple_choice'
        ? JSON.stringify({
          a: newQuestion.option_a,
          b: newQuestion.option_b,
          c: newQuestion.option_c,
          d: newQuestion.option_d
        })
        : null;

      await runEditExamOperation(
        {
          scope: saveScope,
          kind: 'new-draft',
          target: 'new',
          execute: async () => {
            try {
              const response = await fetch(`${API_URL}/exams/${saveScope}/questions`, buildJsonRequestInit('POST', {
                question_text: newQuestion.question_text,
                question_image: newQuestion.question_image || null,
                question_type: newQuestion.question_type,
                options: options,
                correct_answer: newQuestion.correct_answer || null,
                points: normalizePositiveInt(newQuestion.points, 1),
                explanation: null
              }));
              return { ok: response.ok, status: response.status };
            } catch (error) {
              console.error('Error adding question:', error);
              return { ok: false, status: 0 };
            }
          },
        },
        {
          tracker: operationTrackerRef.current,
          readState: readOperationState,
          sinks: {
            commit: () => {
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
              closeNewQuestionDraft();
            },
            reject: () => {
              // A failed add keeps the draft and the form open for retry.
              toast({
                title: 'خطأ',
                description: 'فشل إضافة السؤال',
                variant: 'destructive'
              });
            },
            reload: (scope) => reloadSavedScope(scope),
          },
        },
      );
    });
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
                  onClick={openNewQuestionDraft}
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
                            if (file) {
                              await runEditExamOperation(
                                {
                                  scope: examId ?? '',
                                  kind: 'new-draft',
                                  target: 'new',
                                  execute: async () => {
                                    try {
                                      const formData = new FormData();
                                      formData.append('image', file);
                                      return await uploadQuestionImage(formData);
                                    } catch (error) {
                                      return { ok: false, status: 0 };
                                    }
                                  },
                                },
                                {
                                  tracker: operationTrackerRef.current,
                                  readState: readOperationState,
                                  sinks: {
                                    commit: (result) => {
                                      if (result.imageUrl) {
                                        setNewQuestion((prev) => ({ ...prev, question_image: result.imageUrl }));
                                      }
                                      toast({
                                        title: 'تم الرفع',
                                        description: 'تم رفع الصورة بنجاح'
                                      });
                                    },
                                    reject: (result) => {
                                      toast({
                                        title: 'خطأ',
                                        description: isAuthFailure(result.status)
                                          ? 'انتهت الجلسة، يرجى تسجيل الدخول مجدداً'
                                          : 'فشل رفع الصورة',
                                        variant: 'destructive'
                                      });
                                    },
                                    reload: () => {},
                                  },
                                },
                              );
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
                          closeNewQuestionDraft();
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
                                    if (file) {
                                      await runEditExamOperation(
                                        {
                                          scope: examId ?? '',
                                          kind: 'edit-question',
                                          target: editingQuestion?.id ?? '',
                                          execute: async () => {
                                            try {
                                              const formData = new FormData();
                                              formData.append('image', file);
                                              return await uploadQuestionImage(formData);
                                            } catch (error) {
                                              return { ok: false, status: 0 };
                                            }
                                          },
                                        },
                                        {
                                          tracker: operationTrackerRef.current,
                                          readState: readOperationState,
                                          sinks: {
                                            commit: (result) => {
                                              if (result.imageUrl) {
                                                setEditingQuestion((prev) =>
                                                  prev ? { ...prev, question_image: result.imageUrl } : prev,
                                                );
                                              }
                                              toast({
                                                title: 'تم الرفع',
                                                description: 'تم رفع الصورة بنجاح'
                                              });
                                            },
                                            reject: (result) => {
                                              toast({
                                                title: 'خطأ',
                                                description: isAuthFailure(result.status)
                                                  ? 'انتهت الجلسة، يرجى تسجيل الدخول مجدداً'
                                                  : 'فشل رفع الصورة',
                                                variant: 'destructive'
                                              });
                                            },
                                            reload: () => {},
                                          },
                                        },
                                      );
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
                          onClick={() => openQuestionEditor(null)}
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
                                : `${API_URL.replace('/api', '')}${question.question_image}`
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
                            onClick={() => openQuestionEditor(question)}
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
                            disabled={saving}
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
