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

export interface Grade {
    id: string;
    name: string;
}

export interface Group {
    id: string;
    name: string;
    grade_id: string;
}

export interface EssayQuestion {
    id: string;
    question_text: string;
    points: number;
    student_answer?: string;
    student_image?: string;
    assigned_score?: number;
}

export interface StudentAttempt {
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

/**
 * Thrown when a protected request is attempted without a stored session token.
 * Callers fail closed instead of sending an unauthenticated request that the
 * strict-auth backend rejects with 401.
 */
export class MissingAuthTokenError extends Error {
    constructor() {
        super('Missing auth token');
        this.name = 'MissingAuthTokenError';
    }
}

/**
 * Performs a protected request with the canonical session bearer token attached,
 * reading the same `authToken` localStorage key as the shared transport so the
 * strict-auth backend accepts the request. Throws MissingAuthTokenError when no
 * token is stored, so no unauthenticated request is ever fired.
 */
export const authedFetch = async (url: string, init: RequestInit = {}): Promise<Response> => {
    let token: string | null = null;
    try {
        token = localStorage.getItem('authToken');
    } catch {
        token = null;
    }
    if (!token) throw new MissingAuthTokenError();
    const headers = new Headers(init.headers);
    headers.set('Authorization', `Bearer ${token}`);
    return fetch(url, { ...init, headers });
};

export type SubmitOutcome = 'success' | 'unauthorized' | 'forbidden' | 'error';

/**
 * Classifies a submit response so only a 2xx clears the row. Any rejected submit
 * (401/403/other) leaves the attempt in the list with its entered scores, so the
 * grader can retry without losing input.
 */
export const classifySubmitOutcome = (status: number): SubmitOutcome => {
    if (status >= 200 && status < 300) return 'success';
    if (status === 401) return 'unauthorized';
    if (status === 403) return 'forbidden';
    return 'error';
};

// ---------------------------------------------------------------------------
// Production request adapters (transport = the canonical `authedFetch` above).
// These are the exact functions the page calls; tests drive them with a mocked
// global fetch so the real request/decision paths are exercised.
// ---------------------------------------------------------------------------

export type LoadOutcome = 'ok' | 'unauthorized' | 'forbidden' | 'error';

export interface LoadResult<T> {
    outcome: LoadOutcome;
    /** Decoded rows; only populated when outcome === 'ok' and malformed === false. */
    rows: T[];
    /** True when the response was 2xx but its body was not a JSON array. */
    malformed: boolean;
}

export const classifyLoadOutcome = (status: number): LoadOutcome => {
    if (status === 401) return 'unauthorized';
    if (status === 403) return 'forbidden';
    if (status >= 200 && status < 300) return 'ok';
    return 'error';
};

/**
 * Protected GET through the canonical bearer transport. It checks `response.ok`
 * BEFORE decoding, so a non-2xx error body (e.g. a 401/403 JSON object) is never
 * handed to array state, and a 2xx body that is not an array is reported as
 * malformed with no rows. The result therefore can never carry a non-array.
 */
export async function loadArray<T>(url: string): Promise<LoadResult<T>> {
    const response = await authedFetch(url);
    const outcome = classifyLoadOutcome(response.status);
    if (outcome !== 'ok') return { outcome, rows: [], malformed: false };
    let data: unknown;
    try {
        data = await response.json();
    } catch {
        return { outcome: 'ok', rows: [], malformed: true };
    }
    if (!Array.isArray(data)) return { outcome: 'ok', rows: [], malformed: true };
    return { outcome: 'ok', rows: data as T[], malformed: false };
}

const SESSION_EXPIRED_MESSAGE = 'انتهت الجلسة، يرجى تسجيل الدخول مرة أخرى';
const SELECTORS_FORBIDDEN_MESSAGE = 'ليست لديك صلاحية عرض بيانات الصفوف والمجموعات';
const SELECTORS_MALFORMED_MESSAGE = 'بيانات الصفوف والمجموعات غير صالحة';
const SELECTORS_FAILED_MESSAGE = 'فشل تحميل بيانات الصفوف والمجموعات';
const PENDING_MALFORMED_MESSAGE = 'استجابة غير صالحة لمحاولات التصحيح';

export type SelectorLoadFailure =
    | { outcome: LoadOutcome; malformed: boolean }
    | { error: unknown };

/**
 * Maps a selector (grades/groups) load failure to a safe, user-facing message.
 * Returns null ONLY for a well-formed 2xx array, so a 401/403/missing token/
 * network failure or a non-array body can never be presented to the grader as
 * "no grades" — the previous behaviour silently swallowed every non-ok outcome
 * and left the selectors looking legitimately empty with no way to retry.
 */
export const describeSelectorLoadFailure = (failure: SelectorLoadFailure): string | null => {
    if ('error' in failure) {
        return failure.error instanceof MissingAuthTokenError
            ? SESSION_EXPIRED_MESSAGE
            : SELECTORS_FAILED_MESSAGE;
    }
    if (failure.outcome === 'ok' && !failure.malformed) return null;
    if (failure.outcome === 'unauthorized') return SESSION_EXPIRED_MESSAGE;
    if (failure.outcome === 'forbidden') return SELECTORS_FORBIDDEN_MESSAGE;
    if (failure.malformed) return SELECTORS_MALFORMED_MESSAGE;
    return SELECTORS_FAILED_MESSAGE;
};

/** Safe message for a failed pending-attempts load; never returns an empty-string "ok". */
export const describePendingLoadFailure = (outcome: LoadOutcome, malformed: boolean): string => {
    if (outcome === 'unauthorized') return SESSION_EXPIRED_MESSAGE;
    if (outcome === 'forbidden') return 'ليست لديك صلاحية عرض محاولات التصحيح';
    if (malformed) return PENDING_MALFORMED_MESSAGE;
    return 'فشل تحميل محاولات الطلاب';
};

export const loadGrades = (): Promise<LoadResult<Grade>> =>
    loadArray<Grade>(`${API_BASE_URL}/grades`);

export const loadGroups = (): Promise<LoadResult<Group>> =>
    loadArray<Group>(`${API_BASE_URL}/groups`);

export const loadPendingAttempts = (
    gradeId: string,
    groupId: string,
): Promise<LoadResult<StudentAttempt>> => {
    const params = new URLSearchParams({ grade_id: gradeId });
    if (groupId && groupId !== 'all') {
        params.set('group_id', groupId);
    }
    return loadArray<StudentAttempt>(
        `${API_BASE_URL}/manual-grading/pending?${params.toString()}`,
    );
};

export interface SubmitResult {
    outcome: SubmitOutcome;
    status: number;
}

/**
 * Protected grading POST through the canonical bearer transport. Returns the
 * classified status so the caller can retain the row (and its entered scores)
 * on any non-2xx response.
 */
export const submitGrading = async (student: StudentAttempt): Promise<SubmitResult> => {
    const totalScore = calculateTotalScore(student);
    const essayScores = student.essay_questions.reduce((acc, q) => {
        acc[q.id] = q.assigned_score!;
        return acc;
    }, {} as Record<string, number>);

    const response = await authedFetch(`${API_BASE_URL}/manual-grading/submit`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            exam_id: student.exam_id,
            student_id: student.student_id,
            essay_scores: essayScores,
            total_score: totalScore,
        }),
    });
    return { outcome: classifySubmitOutcome(response.status), status: response.status };
};

export const attemptKey = (student: Pick<StudentAttempt, 'student_id' | 'exam_id'>): string =>
    `${student.student_id}-${student.exam_id}`;

export interface ScopeKey {
    gradeId: string;
    groupId: string;
}

/**
 * Generation + scope guard for the pending-attempts load. `begin` invalidates
 * every in-flight request and issues a ticket for the new scope (or null when
 * the scope is empty). `isCurrent` is true only for the latest ticket that still
 * matches the active scope, so a superseded, out-of-scope or post-clear response
 * can never commit. `clear` invalidates in-flight requests when the selection is
 * emptied.
 */
export const createLatestRequestGuard = () => {
    let seq = 0;
    let scope: ScopeKey = { gradeId: '', groupId: '' };
    return {
        begin(next: ScopeKey): number | null {
            seq += 1;
            scope = { ...next };
            if (!next.gradeId) return null;
            return seq;
        },
        clear(): void {
            seq += 1;
            scope = { gradeId: '', groupId: '' };
        },
        isCurrent(ticket: number, candidate: ScopeKey): boolean {
            return ticket === seq
                && scope.gradeId === candidate.gradeId
                && scope.groupId === candidate.groupId;
        },
    };
};

export type SubmitLifecycleResult =
    | { kind: 'success' }
    | { kind: 'rejected'; result: SubmitResult }
    | { kind: 'error'; error: unknown }
    | { kind: 'duplicate' };

export interface GradingSubmitterHooks {
    /**
     * Monotonic id of the active grade/group scope. It is bumped on EVERY scope
     * change — including a return to a previously used pair — so a submit that
     * started in an older scope can never be mistaken for a current one.
     */
    getScopeGeneration: () => number;
    /** Called only when a 2xx submit completes within the generation it started in. */
    onSubmitted?: (student: StudentAttempt) => void;
}

/**
 * Owns synchronous duplicate suppression (a second submit for the same
 * student/exam is rejected before React re-renders) and the failed-submit
 * retention rule: a row is removed only on a 2xx response that resolves inside
 * the SAME scope generation it started in.
 *
 * Completion is tied to the generation, not to grade/group string equality: on
 * an A -> B -> A roundtrip a pending first-A submit would otherwise compare
 * equal to the freshly reloaded A scope and delete the newly loaded/re-edited A
 * row. Any rejection/error leaves the row (and its entered scores) intact.
 */
export const createGradingSubmitter = (
    hooks: GradingSubmitterHooks,
    submit: (student: StudentAttempt) => Promise<SubmitResult> = submitGrading,
) => {
    const inFlight = new Set<string>();
    return {
        isInFlight(student: StudentAttempt): boolean {
            return inFlight.has(attemptKey(student));
        },
        async submit(student: StudentAttempt): Promise<SubmitLifecycleResult> {
            const key = attemptKey(student);
            if (inFlight.has(key)) return { kind: 'duplicate' };
            inFlight.add(key);
            const generationAtSubmit = hooks.getScopeGeneration();
            try {
                const result = await submit(student);
                if (result.outcome === 'success') {
                    if (hooks.getScopeGeneration() === generationAtSubmit) {
                        hooks.onSubmitted?.(student);
                    }
                    return { kind: 'success' };
                }
                return { kind: 'rejected', result };
            } catch (error) {
                return { kind: 'error', error };
            } finally {
                inFlight.delete(key);
            }
        },
    };
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
    // Selector load failures are surfaced separately from the attempts table so
    // a failed grades/groups request is never shown as an empty selector.
    const [gradesError, setGradesError] = useState<string | null>(null);
    const [groupsError, setGroupsError] = useState<string | null>(null);
    const [savingId, setSavingId] = useState<string | null>(null); // Track which student is being saved

    // Monotonic scope generation, read by the submitter so a success that
    // resolves after the grader switched scope (including A -> B -> A) cannot
    // delete rows from the newer scope.
    const scopeGenerationRef = useRef(0);
    const lastScopeRef = useRef<ScopeKey>({ gradeId: '', groupId: '' });

    // Generation + scope guard for pending-attempts loads (superseded/out-of-scope
    // responses and selection clears cannot commit).
    const pendingGuardRef = useRef<ReturnType<typeof createLatestRequestGuard> | null>(null);
    if (pendingGuardRef.current === null) {
        pendingGuardRef.current = createLatestRequestGuard();
    }

    // Owns duplicate suppression + failed-submit retention across renders.
    const submitterRef = useRef<ReturnType<typeof createGradingSubmitter> | null>(null);
    if (submitterRef.current === null) {
        submitterRef.current = createGradingSubmitter({
            getScopeGeneration: () => scopeGenerationRef.current,
            onSubmitted: (student) => setStudents(prev => prev.filter(s =>
                !(s.student_id === student.student_id && s.exam_id === student.exam_id)
            )),
        });
    }

    useEffect(() => {
        fetchGrades();
        fetchGroups();
    }, []);

    const fetchGrades = async () => {
        try {
            const result = await loadGrades();
            const failure = describeSelectorLoadFailure(result);
            if (failure) {
                // A non-2xx error object or a non-array body is reported as a
                // retryable error; it never reaches array state.
                setGradesError(failure);
                return;
            }
            setGradesError(null);
            setGrades(result.rows);
        } catch (error) {
            console.error('Error fetching grades:', error);
            setGradesError(describeSelectorLoadFailure({ error }));
        }
    };

    const fetchGroups = async () => {
        try {
            const result = await loadGroups();
            const failure = describeSelectorLoadFailure(result);
            if (failure) {
                setGroupsError(failure);
                return;
            }
            setGroupsError(null);
            setGroups(result.rows);
        } catch (error) {
            console.error('Error fetching groups:', error);
            setGroupsError(describeSelectorLoadFailure({ error }));
        }
    };

    const retrySelectors = () => {
        void fetchGrades();
        void fetchGroups();
    };

    const fetchPendingAttempts = async () => {
        const scope: ScopeKey = { gradeId: selectedGrade, groupId: selectedGroup };
        const guard = pendingGuardRef.current!;
        const ticket = guard.begin(scope);
        if (ticket === null) return; // empty scope — nothing to load

        setLoading(true);
        setLoadError(null);
        try {
            const result = await loadPendingAttempts(scope.gradeId, scope.groupId);

            // A superseded or out-of-scope response must not commit.
            if (!guard.isCurrent(ticket, scope)) return;

            if (result.outcome === 'ok' && !result.malformed) {
                setStudents(result.rows);
                return;
            }

            // A non-2xx outcome OR a 2xx non-array body is an error state, never
            // an empty list: an invalid payload must not look like "no pending
            // attempts" and the grader must be able to retry.
            const message = describePendingLoadFailure(result.outcome, result.malformed);
            setLoadError(message);
            toast({
                title: "خطأ",
                description: message,
                variant: "destructive"
            });
        } catch (error) {
            if (!guard.isCurrent(ticket, scope)) return;
            console.error('Error fetching pending attempts:', error);
            const message = error instanceof MissingAuthTokenError
                ? SESSION_EXPIRED_MESSAGE
                : 'فشل تحميل محاولات الطلاب';
            setLoadError(message);
            toast({
                title: "خطأ",
                description: message,
                variant: "destructive"
            });
        } finally {
            if (guard.isCurrent(ticket, scope)) setLoading(false);
        }
    };

    useEffect(() => {
        const next: ScopeKey = { gradeId: selectedGrade, groupId: selectedGroup };
        const previous = lastScopeRef.current;
        if (previous.gradeId !== next.gradeId || previous.groupId !== next.groupId) {
            // Issue a new generation for every real scope change. A return to a
            // previously used grade/group pair therefore still gets a distinct
            // generation, so a late submit from the first visit cannot delete a
            // row produced by the newer visit.
            lastScopeRef.current = next;
            scopeGenerationRef.current += 1;
        }
        if (selectedGrade && selectedGroup) {
            fetchPendingAttempts();
        } else {
            // Selection cleared: invalidate any in-flight load and drop stale
            // rows so a superseded response cannot repopulate the table.
            pendingGuardRef.current!.clear();
            setStudents([]);
            setLoadError(null);
            setLoading(false);
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
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

        const key = attemptKey(student);
        setSavingId(key);
        try {
            const outcome = await submitterRef.current!.submit(student);

            if (outcome.kind === 'success') {
                toast({
                    title: "تم بنجاح",
                    description: "تم تسليم الدرجات بنجاح"
                });
                return;
            }
            if (outcome.kind === 'duplicate') return; // a submit is already in flight

            if (outcome.kind === 'rejected') {
                // A rejected submit must be surfaced; the row is kept so the
                // grader can retry. 401/403 are reported distinctly.
                const description = outcome.result.outcome === 'unauthorized'
                    ? SESSION_EXPIRED_MESSAGE
                    : outcome.result.outcome === 'forbidden'
                        ? 'ليست لديك صلاحية تسليم الدرجات'
                        : 'فشل تسليم الدرجات، حاول مرة أخرى';
                toast({
                    title: "خطأ",
                    description,
                    variant: "destructive"
                });
                return;
            }

            console.error('Error submitting grades:', outcome.error);
            toast({
                title: "خطأ",
                description: outcome.error instanceof MissingAuthTokenError
                    ? SESSION_EXPIRED_MESSAGE
                    : "فشل تسليم الدرجات",
                variant: "destructive"
            });
        } finally {
            // Only clear this attempt's marker; a concurrent save for a
            // different student must keep its own in-flight state.
            setSavingId(prev => (prev === key ? null : prev));
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

                {(gradesError || groupsError) && (
                    <Card className="mb-6 border-destructive/40">
                        <CardContent className="py-4 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3">
                            <p role="alert" className="text-sm text-destructive">
                                {gradesError || groupsError}
                            </p>
                            <Button variant="outline" size="sm" onClick={retrySelectors}>
                                إعادة المحاولة
                            </Button>
                        </CardContent>
                    </Card>
                )}

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
