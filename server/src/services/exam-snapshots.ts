/**
 * M4 A2 — timed exams with immutable, versioned snapshots.
 *
 * Pure, deterministic, clock-injected and I/O-free. Publishing an exam freezes
 * a versioned snapshot: the route copies the pinned question-bank versions into
 * `exam_version_questions`, and this module validates and hashes that frozen
 * content. An attempt always references its own `exam_version_id`, so later
 * edits to a question-bank question can never change an active attempt.
 *
 * Time contract (server clock is the only authority):
 *  - `opens_at` / `closes_at` bound the exam availability window in absolute
 *    UTC instants; a request before `opens_at` or at/after `closes_at` is denied.
 *  - starting an attempt mints `deadline = min(now + duration, closes_at)`; the
 *    server, never the client, computes and stores it.
 *  - a manual submit is accepted only while the deadline has not passed; a
 *    submit inside the optional grace window is rejected as late, and only the
 *    server-side auto-submit path may capture answers there.
 *
 * Audience/enrollment is deny-by-default: an attempt requires a live enrollment
 * whose tenant matches the exam and whose group/branch matches one of the
 * exam's targets (or any enrollment when the exam is tenant-wide).
 *
 * No `any`, no ts-ignore, no network, no runtime DDL.
 */

import { createHash } from 'crypto';
import { QuestionKind, QUESTION_KINDS } from './question-bank';
import { ScoringPolicy, normalizeScoringPolicy } from './exam-grading';

export const SNAPSHOT_STATUSES = ['draft', 'published', 'archived'] as const;
export type SnapshotStatus = (typeof SNAPSHOT_STATUSES)[number];

export const MIN_DURATION_SECONDS = 60;
export const MAX_DURATION_SECONDS = 24 * 60 * 60;
export const MAX_GRACE_SECONDS = 60 * 60;
export const MAX_SNAPSHOT_QUESTIONS = 200;
export const MAX_POINTS = 1000;

const ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

export type ValidationResult<T> = { ok: true; value: T } | { ok: false; error: string };

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function normalizeId(value: unknown): string | null {
    if (typeof value !== 'string') return null;
    const trimmed = value.trim();
    return ID_PATTERN.test(trimmed) ? trimmed : null;
}

export function normalizeSnapshotStatus(value: unknown): SnapshotStatus | null {
    if (typeof value !== 'string') return null;
    return (SNAPSHOT_STATUSES as readonly string[]).includes(value) ? (value as SnapshotStatus) : null;
}

/** A published (or archived) snapshot is frozen and can never be rewritten. */
export function isSnapshotImmutable(status: unknown): boolean {
    return status === 'published' || status === 'archived';
}

function normalizePositiveInt(value: unknown, min: number, max: number): number | null {
    const parsed = typeof value === 'number' ? value : Number(value);
    if (!Number.isInteger(parsed) || parsed < min || parsed > max) return null;
    return parsed;
}

function normalizePoints(value: unknown): number | null {
    const parsed = typeof value === 'number' ? value : Number(value);
    if (!Number.isFinite(parsed) || parsed < 0 || parsed > MAX_POINTS) return null;
    const scaled = parsed * 100;
    if (Math.abs(scaled - Math.round(scaled)) > 1e-9) return null;
    return Math.round(scaled) / 100;
}

/** Parse an absolute instant (ISO string or `YYYY-MM-DD HH:MM:SS`, treated UTC). */
function normalizeInstant(value: unknown): string | null | undefined {
    if (value === undefined || value === null || value === '') return null;
    if (typeof value !== 'string') return undefined;
    const trimmed = value.trim();
    const candidate = /[TZ]/.test(trimmed) ? trimmed : `${trimmed.replace(' ', 'T')}Z`;
    const parsed = new Date(candidate);
    if (!Number.isFinite(parsed.getTime())) return undefined;
    return parsed.toISOString();
}

export interface PinnedQuestionRef {
    questionId: string;
    version: number;
    position: number;
}

export interface ValidatedExamVersion {
    durationSeconds: number;
    opensAtUtc: string | null;
    closesAtUtc: string | null;
    graceSeconds: number;
    passingPoints: number;
    scoring: ScoringPolicy;
    questions: PinnedQuestionRef[];
}

/**
 * Validate an exam-version create payload. The question list pins exact
 * question-bank versions (never "latest"), so a snapshot is reproducible.
 */
export function validateExamVersionInput(body: unknown): ValidationResult<ValidatedExamVersion> {
    const record = isRecord(body) ? body : {};

    const durationSeconds = normalizePositiveInt(
        record['duration_seconds'] ?? record['durationSeconds'],
        MIN_DURATION_SECONDS,
        MAX_DURATION_SECONDS,
    );
    if (durationSeconds === null) {
        return { ok: false, error: `duration_seconds must be an integer between ${MIN_DURATION_SECONDS} and ${MAX_DURATION_SECONDS}` };
    }

    const opensAtUtc = normalizeInstant(record['opens_at'] ?? record['opensAt']);
    if (opensAtUtc === undefined) return { ok: false, error: 'opens_at must be a valid date-time' };
    const closesAtUtc = normalizeInstant(record['closes_at'] ?? record['closesAt']);
    if (closesAtUtc === undefined) return { ok: false, error: 'closes_at must be a valid date-time' };
    if (opensAtUtc && closesAtUtc && Date.parse(closesAtUtc) <= Date.parse(opensAtUtc)) {
        return { ok: false, error: 'closes_at must be after opens_at' };
    }

    const graceSeconds = record['grace_seconds'] === undefined || record['grace_seconds'] === null
        ? 0
        : normalizePositiveInt(record['grace_seconds'], 0, MAX_GRACE_SECONDS);
    if (graceSeconds === null) {
        return { ok: false, error: `grace_seconds must be an integer between 0 and ${MAX_GRACE_SECONDS}` };
    }

    const passingPoints = record['passing_points'] === undefined || record['passing_points'] === null
        ? 0
        : normalizePoints(record['passing_points']);
    if (passingPoints === null) return { ok: false, error: 'passing_points must be a non-negative number up to two decimals' };

    const scoring = normalizeScoringPolicy(record['scoring'] ?? record['scoring_policy']);
    if (scoring === null) return { ok: false, error: 'scoring policy is invalid' };

    const rawQuestions = record['questions'];
    if (!Array.isArray(rawQuestions) || rawQuestions.length === 0) {
        return { ok: false, error: 'questions must be a non-empty list' };
    }
    if (rawQuestions.length > MAX_SNAPSHOT_QUESTIONS) {
        return { ok: false, error: `at most ${MAX_SNAPSHOT_QUESTIONS} questions may be snapshotted` };
    }

    const questions: PinnedQuestionRef[] = [];
    const seenPositions = new Set<number>();
    const seenPins = new Set<string>();
    for (let index = 0; index < rawQuestions.length; index += 1) {
        const entry = rawQuestions[index];
        if (!isRecord(entry)) return { ok: false, error: `question ${index + 1} is invalid` };
        const questionId = normalizeId(entry['question_id'] ?? entry['questionId']);
        if (!questionId) return { ok: false, error: `question ${index + 1} has an invalid question_id` };
        const version = normalizePositiveInt(entry['version'], 1, 1_000_000);
        if (version === null) return { ok: false, error: `question ${index + 1} has an invalid version` };
        const position = entry['position'] === undefined || entry['position'] === null
            ? index + 1
            : normalizePositiveInt(entry['position'], 1, MAX_SNAPSHOT_QUESTIONS);
        if (position === null) return { ok: false, error: `question ${index + 1} has an invalid position` };
        if (seenPositions.has(position)) return { ok: false, error: 'question positions must be unique' };
        const pin = `${questionId}@${version}`;
        if (seenPins.has(pin)) return { ok: false, error: 'a question version may only be pinned once' };
        seenPositions.add(position);
        seenPins.add(pin);
        questions.push({ questionId, version, position });
    }
    questions.sort((a, b) => a.position - b.position);

    return { ok: true, value: { durationSeconds, opensAtUtc, closesAtUtc, graceSeconds, passingPoints, scoring, questions } };
}

export interface SnapshotQuestionSource {
    questionId: string;
    version: number;
    questionType: QuestionKind;
    questionText: string;
    options: string[];
    correctAnswers: string[];
    points: number;
    explanation: string | null;
}

export interface SnapshotEntry extends SnapshotQuestionSource {
    position: number;
    contentHash: string;
}

function isQuestionKind(value: unknown): value is QuestionKind {
    return typeof value === 'string' && (QUESTION_KINDS as readonly string[]).includes(value);
}

/** Deterministic content hash of a frozen snapshot question. */
export function snapshotContentHash(entry: Omit<SnapshotEntry, 'contentHash'>): string {
    const canonical = JSON.stringify({
        questionId: entry.questionId,
        version: entry.version,
        questionType: entry.questionType,
        questionText: entry.questionText,
        options: [...entry.options],
        correctAnswers: [...entry.correctAnswers],
        points: entry.points,
    });
    return createHash('sha256').update(canonical).digest('hex');
}

/**
 * Validate the resolved pinned source rows and freeze them into snapshot
 * entries. Choice questions require a valid option set and an answer key that
 * is a subset of the options; true/false requires a literal boolean; essay must
 * carry no machine answer.
 */
export function buildSnapshotEntries(
    sources: readonly { source: SnapshotQuestionSource; position: number }[],
): ValidationResult<SnapshotEntry[]> {
    const entries: SnapshotEntry[] = [];
    for (const { source, position } of sources) {
        if (!isQuestionKind(source.questionType)) return { ok: false, error: 'snapshot question has an invalid type' };
        const questionText = typeof source.questionText === 'string' ? source.questionText.trim() : '';
        if (!questionText) return { ok: false, error: 'snapshot question text is required' };
        const points = normalizePoints(source.points);
        if (points === null) return { ok: false, error: 'snapshot question points are invalid' };
        const options = Array.isArray(source.options) ? source.options.map((entry) => String(entry)) : [];
        const correctAnswers = Array.isArray(source.correctAnswers)
            ? source.correctAnswers.map((entry) => String(entry))
            : [];

        if (source.questionType === 'single_choice' || source.questionType === 'multiple_choice') {
            if (options.length < 2 || new Set(options).size !== options.length) {
                return { ok: false, error: 'a choice question needs at least two unique options' };
            }
            if (correctAnswers.length === 0 || !correctAnswers.every((answer) => options.includes(answer))) {
                return { ok: false, error: 'every correct answer must be one of the options' };
            }
            if (source.questionType === 'single_choice' && correctAnswers.length !== 1) {
                return { ok: false, error: 'a single_choice question must have exactly one correct answer' };
            }
        } else if (source.questionType === 'true_false') {
            const single = correctAnswers[0];
            if (single !== 'true' && single !== 'false') {
                return { ok: false, error: 'a true_false question needs a true or false answer' };
            }
        } else if (correctAnswers.length > 0) {
            return { ok: false, error: 'an essay question must not carry a machine answer' };
        }

        const base = {
            questionId: source.questionId,
            version: source.version,
            questionType: source.questionType,
            questionText,
            options,
            correctAnswers,
            points,
            explanation: source.explanation ?? null,
            position,
        };
        entries.push({ ...base, contentHash: snapshotContentHash(base) });
    }
    return { ok: true, value: entries };
}

export interface SnapshotTiming {
    durationSeconds: number;
    opensAtUtc: string | null;
    closesAtUtc: string | null;
    graceSeconds: number;
}

export type StartDenialReason = 'snapshot_not_published' | 'not_yet_open' | 'closed' | 'already_attempted';

export type StartDecision =
    | { allowed: true; deadlineUtc: string; remainingSeconds: number }
    | { allowed: false; reason: StartDenialReason };

/**
 * Decide whether a new attempt may start. Only a published snapshot is
 * attemptable; the availability window is compared against the injected server
 * clock, and an existing attempt for the same enrollment always denies.
 */
export function evaluateAttemptStart(
    timing: SnapshotTiming,
    status: unknown,
    hasExistingAttempt: boolean,
    now: Date,
): StartDecision {
    if (!isSnapshotImmutable(status)) return { allowed: false, reason: 'snapshot_not_published' };
    if (hasExistingAttempt) return { allowed: false, reason: 'already_attempted' };

    const nowMs = now.getTime();
    if (timing.opensAtUtc) {
        const opens = Date.parse(timing.opensAtUtc);
        if (!Number.isFinite(opens)) return { allowed: false, reason: 'not_yet_open' };
        if (nowMs < opens) return { allowed: false, reason: 'not_yet_open' };
    }
    if (timing.closesAtUtc) {
        const closes = Date.parse(timing.closesAtUtc);
        if (!Number.isFinite(closes)) return { allowed: false, reason: 'closed' };
        if (nowMs >= closes) return { allowed: false, reason: 'closed' };
    }

    let deadlineMs = nowMs + timing.durationSeconds * 1000;
    if (timing.closesAtUtc) {
        const closes = Date.parse(timing.closesAtUtc);
        if (Number.isFinite(closes)) deadlineMs = Math.min(deadlineMs, closes);
    }
    const remainingSeconds = Math.max(0, Math.floor((deadlineMs - nowMs) / 1000));
    return { allowed: true, deadlineUtc: new Date(deadlineMs).toISOString(), remainingSeconds };
}

export interface TimingPhase {
    phase: 'open' | 'grace' | 'expired';
    deadlineUtc: string;
    graceDeadlineUtc: string;
    remainingSeconds: number;
}

/**
 * Classify an in-flight attempt against the server clock:
 *  - `open`    : before the deadline, a manual submit is accepted;
 *  - `grace`   : inside the auto-submit window, a manual submit is late-rejected;
 *  - `expired` : past the grace window, no further writes are accepted.
 */
export function evaluateAttemptPhase(timing: SnapshotTiming, startedAtUtc: string, now: Date): TimingPhase {
    const started = Date.parse(startedAtUtc);
    const startMs = Number.isFinite(started) ? started : now.getTime();
    let deadlineMs = startMs + timing.durationSeconds * 1000;
    if (timing.closesAtUtc) {
        const closes = Date.parse(timing.closesAtUtc);
        if (Number.isFinite(closes)) deadlineMs = Math.min(deadlineMs, closes);
    }
    const graceMs = deadlineMs + Math.max(0, timing.graceSeconds) * 1000;
    const nowMs = now.getTime();
    const phase: TimingPhase['phase'] = nowMs <= deadlineMs ? 'open' : (nowMs <= graceMs ? 'grace' : 'expired');
    return {
        phase,
        deadlineUtc: new Date(deadlineMs).toISOString(),
        graceDeadlineUtc: new Date(graceMs).toISOString(),
        remainingSeconds: Math.max(0, Math.floor((deadlineMs - nowMs) / 1000)),
    };
}

export type SubmitDenialReason = 'NOT_OPEN' | 'LATE_REJECTED' | 'EXPIRED';

export type SubmitDecision =
    | { allowed: true; late: boolean }
    | { allowed: false; reason: SubmitDenialReason };

/**
 * Manual submit decision. A late submit is rejected, never silently accepted;
 * only the auto-submit path captures answers inside the grace window.
 */
export function evaluateManualSubmit(phase: TimingPhase): SubmitDecision {
    if (phase.phase === 'open') return { allowed: true, late: false };
    if (phase.phase === 'grace') return { allowed: false, reason: 'LATE_REJECTED' };
    return { allowed: false, reason: 'EXPIRED' };
}

/** True once the server must auto-submit (deadline passed). */
export function isAutoSubmitDue(phase: TimingPhase): boolean {
    return phase.phase !== 'open';
}

/** True once the attempt is past the whole grace window and must be expired. */
export function isAttemptExpiryDue(phase: TimingPhase): boolean {
    return phase.phase === 'expired';
}

export interface ExamAudienceTarget {
    groupId: string | null;
    branchId: string | null;
    branchScope: string;
}

export interface ExamAudience {
    tenantId: string;
    targets: readonly ExamAudienceTarget[];
}

export interface EnrollmentAudience {
    tenantId: string;
    groupId: string | null;
    branchId: string | null;
}

/**
 * Deny-by-default audience match: same tenant, then any target matches. An exam
 * with no targets is tenant-wide. A branch target requires the enrollment's
 * derived branch; a group target requires the exact group.
 */
export function enrollmentMatchesExam(audience: ExamAudience, enrollment: EnrollmentAudience): boolean {
    if (audience.tenantId !== enrollment.tenantId) return false;
    if (audience.targets.length === 0) return true;
    return audience.targets.some((target) => {
        if (target.branchScope === 'branch') {
            return target.branchId !== null && enrollment.branchId !== null && target.branchId === enrollment.branchId;
        }
        if (target.groupId !== null) return enrollment.groupId !== null && target.groupId === enrollment.groupId;
        return true;
    });
}
