/**
 * M5 G3 manual attendance domain policy.
 *
 * Pure and clock-free. This module validates/normalizes a marking payload and
 * decides whether a student is eligible to be marked in a session. It never
 * reads the request, never resolves teacher authority and never performs I/O;
 * the route layer composes it with the verified principal, the session row and
 * the server-owned student/enrollment rows.
 *
 * States: present | absent | late | excused. Duplicate marking for the same
 * (session, student) is made idempotent by the route: an identical re-mark is a
 * no-op and a changed state is an audited correction. Eligibility is deny-by-
 * default: a group session only accepts that group's students, a branch session
 * only that branch's students, and a tenant session any active enrolled student
 * of the tenant.
 *
 * No `any`, no ts-ignore, no network, no runtime DDL.
 */

import { ValidationResult, normalizeId } from './announcements';

export const ATTENDANCE_STATES = ['present', 'absent', 'late', 'excused'] as const;
export type AttendanceState = (typeof ATTENDANCE_STATES)[number];

export const MAX_REASON_LENGTH = 255;
export const MAX_BULK_RECORDS = 500;

export function normalizeAttendanceState(value: unknown): AttendanceState | null {
    if (typeof value !== 'string') return null;
    return (ATTENDANCE_STATES as readonly string[]).includes(value)
        ? (value as AttendanceState)
        : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function normalizeReason(value: unknown): ValidationResult<string | null> {
    if (value === undefined || value === null || value === '') return { ok: true, value: null };
    if (typeof value !== 'string') return { ok: false, error: 'reason must be a string' };
    const reason = value.trim();
    if (!reason) return { ok: true, value: null };
    if (reason.length > MAX_REASON_LENGTH) {
        return { ok: false, error: `reason must be at most ${MAX_REASON_LENGTH} characters` };
    }
    return { ok: true, value: reason };
}

export interface ValidatedMark {
    studentId: string;
    state: AttendanceState;
    reason: string | null;
}

export interface ValidatedBulk {
    records: ValidatedMark[];
}

/** Validate a single mark payload for a session. */
export function validateMarkInput(body: unknown): ValidationResult<ValidatedMark> {
    const record = isRecord(body) ? body : {};
    const studentId = normalizeId(record['student_id'] ?? record['studentId']);
    if (!studentId) return { ok: false, error: 'student_id is required' };
    const state = normalizeAttendanceState(record['state']);
    if (!state) return { ok: false, error: 'state must be present, absent, late or excused' };
    const reason = normalizeReason(record['reason']);
    if (!reason.ok) return reason;
    return { ok: true, value: { studentId, state, reason: reason.value } };
}

/**
 * Validate a bulk mark payload. A repeated student within one payload is
 * rejected (400) rather than silently resolved, so the caller's intent is
 * never ambiguous. The route still applies the per-(session, student) unique
 * key for idempotency across separate requests.
 */
export function validateBulkInput(body: unknown): ValidationResult<ValidatedBulk> {
    const record = isRecord(body) ? body : {};
    const raw = record['records'];
    if (!Array.isArray(raw)) return { ok: false, error: 'records must be an array' };
    if (raw.length === 0) return { ok: false, error: 'records must not be empty' };
    if (raw.length > MAX_BULK_RECORDS) return { ok: false, error: `records must be at most ${MAX_BULK_RECORDS} entries` };

    const seen = new Set<string>();
    const records: ValidatedMark[] = [];
    for (const entry of raw) {
        const validated = validateMarkInput(entry);
        if (!validated.ok) return validated;
        if (seen.has(validated.value.studentId)) {
            return { ok: false, error: `duplicate student_id in payload: ${validated.value.studentId}` };
        }
        seen.add(validated.value.studentId);
        records.push(validated.value);
    }
    return { ok: true, value: { records } };
}

export interface ValidatedCorrection {
    state: AttendanceState;
    reason: string;
}

/** Validate a correction payload; a reason is mandatory because it is audited. */
export function validateCorrectionInput(body: unknown): ValidationResult<ValidatedCorrection> {
    const record = isRecord(body) ? body : {};
    const state = normalizeAttendanceState(record['state']);
    if (!state) return { ok: false, error: 'state must be present, absent, late or excused' };
    const reason = normalizeReason(record['reason']);
    if (!reason.ok) return reason;
    if (reason.value === null) return { ok: false, error: 'reason is required for a correction' };
    return { ok: true, value: { state, reason: reason.value } };
}

export interface SessionAudienceFacts {
    tenantId: string;
    groupId: string | null;
    branchId: string | null;
}

export interface StudentAudienceFacts {
    id: string;
    tenantId: string;
    groupId: string | null;
    branchId: string | null;
}

/**
 * Deny-by-default eligibility: the student must be in the same tenant and,
 * when the session is group- or branch-scoped, in that exact group/branch. A
 * NULL scope on either side never matches a restricted session.
 */
export function isStudentEligibleForSession(
    session: SessionAudienceFacts,
    student: StudentAudienceFacts,
): boolean {
    if (session.tenantId !== student.tenantId) return false;
    if (session.groupId !== null) {
        return student.groupId !== null && student.groupId === session.groupId;
    }
    if (session.branchId !== null) {
        return student.branchId !== null && student.branchId === session.branchId;
    }
    return true;
}
