/**
 * M4 A5 — assignments with private file submissions domain policy.
 *
 * Pure, deterministic, I/O-free and clock-injected. It validates assignment
 * definitions and upload metadata, and decides whether a submission is open,
 * late or refused. Scope (tenant/branch/group), enrollment and storage are
 * composed by the route; nothing here reads a request.
 *
 * Deadlines are authored as a tenant-local wall time plus an IANA timezone and
 * stored as an absolute UTC instant (reusing the C6 timezone primitives). Late
 * policy decides what happens after the instant:
 *  - `block`     : no submission after the deadline.
 *  - `mark_late` : accepted and flagged late.
 *  - `accept`    : accepted, not flagged.
 *
 * Upload metadata is private: a bounded opaque `storage_key` is required and a
 * public URL is refused by construction. `scan_status` is server-owned and is
 * never accepted from the client.
 *
 * No `any`, no ts-ignore, no network, no runtime DDL.
 */

import { isValidTimeZone, localWallTimeToInstant } from './content-release';

export const LATE_POLICIES = ['block', 'mark_late', 'accept'] as const;
export type LatePolicy = (typeof LATE_POLICIES)[number];

export const RESUBMISSION_POLICIES = ['allow', 'block'] as const;
export type ResubmissionPolicy = (typeof RESUBMISSION_POLICIES)[number];

export const ASSIGNMENT_BRANCH_SCOPES = ['tenant', 'branch'] as const;
export type AssignmentBranchScope = (typeof ASSIGNMENT_BRANCH_SCOPES)[number];

export const ASSIGNMENT_STATUSES = ['draft', 'published', 'closed'] as const;
export type AssignmentStatus = (typeof ASSIGNMENT_STATUSES)[number];

export const SUBMISSION_STATUSES = ['submitted', 'late', 'revoked'] as const;
export type SubmissionStatus = (typeof SUBMISSION_STATUSES)[number];

export const SCAN_STATUSES = ['pending', 'clean', 'infected', 'failed'] as const;
export type ScanStatus = (typeof SCAN_STATUSES)[number];

export const DEFAULT_ALLOWED_FILE_TYPES = ['pdf', 'doc', 'docx', 'png', 'jpg', 'jpeg', 'zip', 'txt'];
export const DEFAULT_MAX_FILE_BYTES = 25 * 1024 * 1024;
export const MIN_FILE_BYTES = 1024;
export const MAX_FILE_BYTES_LIMIT = 2 * 1024 * 1024 * 1024;
export const DEFAULT_MAX_SUBMISSIONS = 5;
export const MAX_SUBMISSIONS_LIMIT = 50;
export const MAX_TITLE_LENGTH = 255;
export const MAX_INSTRUCTIONS_LENGTH = 20000;
export const MAX_FILE_NAME_LENGTH = 255;
export const MAX_FILE_TYPE_LENGTH = 120;
export const MAX_STORAGE_KEY_LENGTH = 255;

const ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const EXTENSION_PATTERN = /^[a-z0-9]{1,16}$/;
const STORAGE_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/;

export type ValidationResult<T> = { ok: true; value: T } | { ok: false; error: string };

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function normalizeId(value: unknown): string | null {
    if (typeof value !== 'string') return null;
    const trimmed = value.trim();
    return ID_PATTERN.test(trimmed) ? trimmed : null;
}

export function normalizeAssignmentStatus(value: unknown): AssignmentStatus | null {
    if (typeof value !== 'string') return null;
    return (ASSIGNMENT_STATUSES as readonly string[]).includes(value) ? (value as AssignmentStatus) : null;
}

export function normalizeLatePolicy(value: unknown): LatePolicy | null {
    if (typeof value !== 'string') return null;
    return (LATE_POLICIES as readonly string[]).includes(value) ? (value as LatePolicy) : null;
}

export function normalizeResubmissionPolicy(value: unknown): ResubmissionPolicy | null {
    if (typeof value !== 'string') return null;
    return (RESUBMISSION_POLICIES as readonly string[]).includes(value) ? (value as ResubmissionPolicy) : null;
}

export function normalizeBranchScope(value: unknown): AssignmentBranchScope | null {
    if (typeof value !== 'string') return null;
    return (ASSIGNMENT_BRANCH_SCOPES as readonly string[]).includes(value)
        ? (value as AssignmentBranchScope)
        : null;
}

/**
 * Normalize an allowed-file-type list (bare lowercase extensions). An absent
 * value yields the safe default set; an empty list means "any type" and is
 * rejected so the default can never be silently widened to unrestricted.
 */
export function normalizeAllowedFileTypes(value: unknown): string[] | null {
    if (value === undefined || value === null || value === '') return [...DEFAULT_ALLOWED_FILE_TYPES];
    if (!Array.isArray(value) || value.length === 0 || value.length > 32) return null;
    const types: string[] = [];
    for (const entry of value) {
        if (typeof entry !== 'string') return null;
        const type = entry.trim().toLowerCase().replace(/^\./, '');
        if (!EXTENSION_PATTERN.test(type)) return null;
        if (!types.includes(type)) types.push(type);
    }
    return types;
}

function normalizePositiveInt(value: unknown, max: number): number | null {
    const parsed = typeof value === 'number' ? value : Number(value);
    if (!Number.isInteger(parsed) || parsed <= 0 || parsed > max) return null;
    return parsed;
}

export interface ValidatedAssignment {
    title: string;
    instructions: string | null;
    courseId: string | null;
    groupId: string | null;
    branchScope: AssignmentBranchScope;
    branchId: string | null;
    /** Absolute UTC instant for the deadline; null means no deadline. */
    deadlineUtc: string | null;
    deadlineTimeZone: string;
    latePolicy: LatePolicy;
    resubmissionPolicy: ResubmissionPolicy;
    maxSubmissions: number;
    maxFileBytes: number;
    allowedFileTypes: string[];
}

/**
 * Validate an assignment create/edit payload. A branch target requires a
 * branch and must not carry a course/group audience (never mixed); a deadline
 * requires a valid local wall time in a valid IANA timezone.
 */
export function validateAssignmentInput(body: unknown): ValidationResult<ValidatedAssignment> {
    const record = isRecord(body) ? body : {};

    const title = typeof record['title'] === 'string' ? record['title'].trim() : '';
    if (!title) return { ok: false, error: 'title is required' };
    if (title.length > MAX_TITLE_LENGTH) return { ok: false, error: `title must be at most ${MAX_TITLE_LENGTH} characters` };

    let instructions: string | null = null;
    if (record['instructions'] !== undefined && record['instructions'] !== null && record['instructions'] !== '') {
        if (typeof record['instructions'] !== 'string') return { ok: false, error: 'instructions must be a string' };
        instructions = record['instructions'].trim();
        if (instructions.length > MAX_INSTRUCTIONS_LENGTH) {
            return { ok: false, error: `instructions must be at most ${MAX_INSTRUCTIONS_LENGTH} characters` };
        }
        if (!instructions) instructions = null;
    }

    const branchScope = normalizeBranchScope(record['branch_scope'] ?? 'tenant');
    if (!branchScope) return { ok: false, error: 'branch_scope must be tenant or branch' };

    const courseId = record['course_id'] === undefined || record['course_id'] === null || record['course_id'] === ''
        ? null
        : normalizeId(record['course_id']);
    if (record['course_id'] !== undefined && record['course_id'] !== null && record['course_id'] !== '' && !courseId) {
        return { ok: false, error: 'course_id is invalid' };
    }
    const groupId = record['group_id'] === undefined || record['group_id'] === null || record['group_id'] === ''
        ? null
        : normalizeId(record['group_id']);
    if (record['group_id'] !== undefined && record['group_id'] !== null && record['group_id'] !== '' && !groupId) {
        return { ok: false, error: 'group_id is invalid' };
    }

    let branchId: string | null = null;
    if (branchScope === 'branch') {
        branchId = normalizeId(record['branch_id']);
        if (!branchId) return { ok: false, error: 'branch_id is required for a branch assignment' };
        if (courseId || groupId) return { ok: false, error: 'a branch assignment must not target a course or group' };
    } else if (record['branch_id'] !== undefined && record['branch_id'] !== null && record['branch_id'] !== '') {
        return { ok: false, error: 'a tenant assignment must not target a branch' };
    }

    const timeZoneRaw = record['deadline_timezone'];
    let deadlineTimeZone = 'UTC';
    if (timeZoneRaw !== undefined && timeZoneRaw !== null && timeZoneRaw !== '') {
        if (!isValidTimeZone(timeZoneRaw)) return { ok: false, error: 'deadline_timezone must be a valid IANA timezone' };
        deadlineTimeZone = timeZoneRaw;
    }

    let deadlineUtc: string | null = null;
    const rawDeadline = record['deadline'];
    if (rawDeadline !== undefined && rawDeadline !== null && rawDeadline !== '') {
        const instant = localWallTimeToInstant(rawDeadline, deadlineTimeZone);
        if (!instant) return { ok: false, error: 'deadline must be a valid local date-time' };
        deadlineUtc = instant.toISOString();
    }

    const latePolicy = normalizeLatePolicy(record['late_policy'] ?? 'block');
    if (!latePolicy) return { ok: false, error: 'late_policy must be block, mark_late or accept' };

    const resubmissionPolicy = normalizeResubmissionPolicy(record['resubmission_policy'] ?? 'allow');
    if (!resubmissionPolicy) return { ok: false, error: 'resubmission_policy must be allow or block' };

    const maxSubmissions = normalizePositiveInt(record['max_submissions'] ?? DEFAULT_MAX_SUBMISSIONS, MAX_SUBMISSIONS_LIMIT);
    if (maxSubmissions === null) return { ok: false, error: `max_submissions must be an integer between 1 and ${MAX_SUBMISSIONS_LIMIT}` };

    const maxFileBytes = record['max_file_bytes'] === undefined || record['max_file_bytes'] === null
        ? DEFAULT_MAX_FILE_BYTES
        : normalizePositiveInt(record['max_file_bytes'], MAX_FILE_BYTES_LIMIT);
    if (maxFileBytes === null || maxFileBytes < MIN_FILE_BYTES) {
        return { ok: false, error: `max_file_bytes must be between ${MIN_FILE_BYTES} and ${MAX_FILE_BYTES_LIMIT}` };
    }

    const allowedFileTypes = normalizeAllowedFileTypes(record['allowed_file_types']);
    if (allowedFileTypes === null) return { ok: false, error: 'allowed_file_types must be a list of extensions' };

    return {
        ok: true,
        value: {
            title, instructions, courseId, groupId, branchScope, branchId,
            deadlineUtc, deadlineTimeZone, latePolicy, resubmissionPolicy,
            maxSubmissions, maxFileBytes, allowedFileTypes,
        },
    };
}

export interface SubmissionLimits {
    maxFileBytes: number;
    allowedFileTypes: string[];
}

export interface ValidatedUpload {
    fileName: string;
    fileType: string;
    fileSizeBytes: number;
    /** Private opaque storage reference; never a public URL. */
    storageKey: string;
}

function extensionOf(fileName: string): string | null {
    const match = /\.([A-Za-z0-9]{1,16})$/.exec(fileName);
    return match ? match[1].toLowerCase() : null;
}

/**
 * Validate private upload metadata against an assignment's limits. A public URL
 * (`scheme://`) or a traversal/absolute storage key is refused; the size and
 * extension must fit the assignment. `scan_status` is deliberately NOT read
 * here: it is server-owned.
 */
export function validateUploadMetadata(body: unknown, limits: SubmissionLimits): ValidationResult<ValidatedUpload> {
    const record = isRecord(body) ? body : {};

    const fileName = typeof record['file_name'] === 'string' ? record['file_name'].trim() : '';
    if (!fileName) return { ok: false, error: 'file_name is required' };
    if (fileName.length > MAX_FILE_NAME_LENGTH) return { ok: false, error: 'file_name is too long' };
    if (/[\\/]/.test(fileName) || /[\u0000-\u001f]/.test(fileName)) {
        return { ok: false, error: 'file_name must not contain path separators or control characters' };
    }

    const fileType = typeof record['file_type'] === 'string' ? record['file_type'].trim() : '';
    if (!fileType) return { ok: false, error: 'file_type is required' };
    if (fileType.length > MAX_FILE_TYPE_LENGTH) return { ok: false, error: 'file_type is too long' };

    const fileSizeBytes = normalizePositiveInt(record['file_size_bytes'], MAX_FILE_BYTES_LIMIT);
    if (fileSizeBytes === null) return { ok: false, error: 'file_size_bytes must be a positive integer' };
    if (fileSizeBytes > limits.maxFileBytes) return { ok: false, error: 'file exceeds the assignment size limit' };

    const extension = extensionOf(fileName);
    if (!extension) return { ok: false, error: 'file_name must carry an extension' };
    if (limits.allowedFileTypes.length > 0 && !limits.allowedFileTypes.includes(extension)) {
        return { ok: false, error: 'file type is not allowed for this assignment' };
    }

    const storageKey = typeof record['storage_key'] === 'string' ? record['storage_key'].trim() : '';
    if (!storageKey) return { ok: false, error: 'storage_key is required' };
    if (storageKey.length > MAX_STORAGE_KEY_LENGTH) return { ok: false, error: 'storage_key is too long' };
    if (storageKey.includes('://') || storageKey.startsWith('/') || storageKey.includes('..') || !STORAGE_KEY_PATTERN.test(storageKey)) {
        return { ok: false, error: 'storage_key must be a private opaque key, not a public URL' };
    }

    return { ok: true, value: { fileName, fileType, fileSizeBytes, storageKey } };
}

export interface SubmissionWindowAssignment {
    status: string;
    archived: boolean;
    deadlineUtc: string | null;
    latePolicy: string;
}

export interface EvaluateSubmissionInput extends SubmissionWindowAssignment {
    resubmissionPolicy: string;
    maxSubmissions: number;
}

export type WindowDecision =
    | { open: true; late: boolean }
    | { open: false; reason: 'not_published' | 'archived' | 'closed' | 'deadline_passed' };

/** Whether the submission window is open for this assignment at `now`. */
export function evaluateSubmissionWindow(assignment: SubmissionWindowAssignment, now: Date): WindowDecision {
    if (assignment.archived) return { open: false, reason: 'archived' };
    if (assignment.status !== 'published') {
        return { open: false, reason: assignment.status === 'closed' ? 'closed' : 'not_published' };
    }
    if (!assignment.deadlineUtc) return { open: true, late: false };
    const deadline = Date.parse(assignment.deadlineUtc);
    if (!Number.isFinite(deadline)) return { open: false, reason: 'deadline_passed' };
    if (now.getTime() <= deadline) return { open: true, late: false };
    const policy = normalizeLatePolicy(assignment.latePolicy);
    if (policy === 'accept') return { open: true, late: false };
    if (policy === 'mark_late') return { open: true, late: true };
    return { open: false, reason: 'deadline_passed' };
}

export interface ExistingSubmission {
    version: number;
    status: string;
}

export type SubmitDenialReason = 'NOT_OPEN' | 'DEADLINE_PASSED' | 'RESUBMISSION_BLOCKED' | 'SUBMISSION_LIMIT_REACHED';

export type SubmitDecision =
    | { allowed: true; late: boolean; nextVersion: number }
    | { allowed: false; reason: SubmitDenialReason };

/**
 * Whether an enrolled student may submit (or resubmit) right now. A revoked
 * submission is invalidated and never counts toward the resubmission/limit
 * gates, so a teacher revocation re-opens the slot. The next version is
 * `max(version) + 1` and is always monotonically increasing.
 */
export function evaluateSubmission(
    assignment: EvaluateSubmissionInput,
    existing: readonly ExistingSubmission[],
    now: Date,
): SubmitDecision {
    const window = evaluateSubmissionWindow(assignment, now);
    if (!window.open) {
        return { allowed: false, reason: window.reason === 'deadline_passed' ? 'DEADLINE_PASSED' : 'NOT_OPEN' };
    }
    const active = existing.filter((submission) => submission.status !== 'revoked');
    if (assignment.resubmissionPolicy === 'block' && active.length > 0) {
        return { allowed: false, reason: 'RESUBMISSION_BLOCKED' };
    }
    if (active.length >= assignment.maxSubmissions) {
        return { allowed: false, reason: 'SUBMISSION_LIMIT_REACHED' };
    }
    const maxVersion = existing.reduce((max, submission) => Math.max(max, Number(submission.version) || 0), 0);
    return { allowed: true, late: window.late, nextVersion: maxVersion + 1 };
}

export interface AssignmentAudienceFacts {
    tenantId: string;
    branchScope: string;
    branchId: string | null;
    groupId: string | null;
}

export interface EnrollmentAudienceFacts {
    tenantId: string;
    /** Derived branch only when the enrollment/group is branch-scoped. */
    branchId: string | null;
    groupId: string | null;
}

/**
 * Deny-by-default audience match for a student: the enrollment must be in the
 * same tenant, and must match a branch- or group-scoped assignment. A
 * tenant-wide assignment matches any enrollment in the tenant.
 */
export function enrollmentMatchesAssignment(
    assignment: AssignmentAudienceFacts,
    enrollment: EnrollmentAudienceFacts,
): boolean {
    if (assignment.tenantId !== enrollment.tenantId) return false;
    if (assignment.branchScope === 'branch') {
        return assignment.branchId !== null && enrollment.branchId !== null && assignment.branchId === enrollment.branchId;
    }
    if (assignment.groupId !== null) {
        return enrollment.groupId !== null && assignment.groupId === enrollment.groupId;
    }
    return true;
}
