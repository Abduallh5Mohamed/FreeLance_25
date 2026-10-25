/**
 * M5 G3 manual attendance routes.
 *
 * Authority + integrity model (exact-assignment boundaries, 2026-10-19):
 *  - Staff (verified tenant owner or active instructor membership in the
 *    server-selected tenant) may mark attendance only for a session they are
 *    entitled to. A tenant or branch membership ALONE is never a grant: a
 *    non-owner's row-level access is the live assigned-group subquery
 *    (`groups.instructor_id`, re-checked on every request) plus sessions they
 *    created; only the tenant owner keeps the tenant-wide exception. The
 *    session is loaded under that visibility predicate, so a cross-tenant or
 *    foreign session is indistinguishable from not-found.
 *  - Only students truly enrolled in that tenant/session are accepted. A group
 *    session accepts only that group's students, a branch session only that
 *    branch's students; any other id is `403` and nothing is written.
 *  - Duplicate marking for the same (session, student) is idempotent: an
 *    identical re-mark is a no-op. A CHANGED state is a correction and
 *    requires a meaningful reason (blank/whitespace is denied with no writes)
 *    wherever it is requested: the mark/bulk paths and the dedicated
 *    correction endpoint, which audits before/after, actor, time and reason.
 *  - Bulk marking is atomic: the whole batch is applied in one transaction and
 *    audited per record; any rejection or audit failure writes nothing.
 *  - A correction stores the correction reason in BOTH `reason` and
 *    `correction_reason`, exactly like a changed re-mark through the mark/bulk
 *    paths, so the stored row and the audit's before/after never disagree.
 *  - Every list feed is bounded and explicit: validated `from`/`to` UTC range
 *    filters, deterministic ordering (sort column, then id), the page-size cap
 *    the contract already defines, and truncation metadata in one response
 *    header, `X-Results-Truncated: true|false`. The pre-existing list
 *    envelopes (staff `{ session_id, records }`, student `{ student_id,
 *    records }`) keep exactly their pre-batch keys. History stays reachable
 *    through explicit ranges.
 *
 * Exports `createAttendanceRecordsRouter(deps)` and a production default-wired
 * router. Mounting happens in a later task. No runtime DDL.
 */

import { Router, RequestHandler, Response } from 'express';
import { randomUUID } from 'crypto';
import { AuthRequest } from '../middleware/auth';
import { recordAudit, snapshotRow } from '../security/audit';
import {
    AttendanceState,
    ValidatedMark,
    validateBulkInput,
    validateCorrectionInput,
    validateMarkInput,
} from '../services/attendance-records';
import { normalizeId } from '../services/announcements';
import { buildTimeRangeConditions, parseTimeRangeFilter } from '../services/schedules';

export interface AttendanceDataAccess {
    query: <T = Record<string, unknown>>(sql: string, params?: unknown[]) => Promise<T[]>;
    queryOne: <T = Record<string, unknown>>(sql: string, params?: unknown[]) => Promise<T | null>;
    execute: (sql: string, params?: unknown[]) => Promise<{ insertId?: number; affectedRows?: number }>;
}

export interface AttendanceDeps {
    db: AttendanceDataAccess;
    authenticate: RequestHandler;
    loadActiveTenantAuthority: (userId: string, tenantId: string) => Promise<{ authority: string } | null>;
    now?: () => Date;
    transaction?: <T>(fn: (tx: AttendanceDataAccess) => Promise<T>) => Promise<T>;
}

const STAFF_AUTHORITIES = new Set(['owner', 'instructor']);

/**
 * Page-size caps already defined by the existing list contracts. Each list
 * fetches one row past its cap so the response can expose an explicit
 * `X-Results-Truncated` header instead of silently dropping rows past the
 * limit; validated `from`/`to` UTC range filters keep full history reachable,
 * and each list keeps exactly its pre-batch envelope keys.
 */
const STAFF_RECORDS_PAGE_CAP = 500;
const STUDENT_RECORDS_PAGE_CAP = 200;

/** mysql2 duplicate-key error (the UNIQUE (session_id, student_id) guard fired). */
const isDuplicateKeyError = (error: unknown): boolean => {
    if (typeof error !== 'object' || error === null) return false;
    const code = (error as { code?: unknown }).code;
    const errno = (error as { errno?: unknown }).errno;
    return code === 'ER_DUP_ENTRY' || errno === 1062;
};

/** Thrown inside the atomic section when the version guard loses; rolls back and maps to 409. */
class AttendanceConflictError extends Error {}

/** Thrown before any write when a payload is semantically invalid for the stored row; maps to 400. */
class AttendanceValidationError extends Error {}

interface StaffScope {
    tenantId: string;
    userId: string;
    isOwner: boolean;
}

interface SessionRow {
    id: string;
    tenant_id: string;
    branch_id: string | null;
    group_id: string | null;
    title: string;
    audience: string;
    timezone: string;
    starts_at: string | Date;
    ends_at: string | Date;
    status: string;
    created_by: string | null;
}

interface RecordRow {
    id: string;
    tenant_id: string;
    session_id: string;
    student_id: string;
    state: string;
    reason: string | null;
    version: number;
}

interface MarkOutcome {
    id: string;
    student_id: string;
    state: AttendanceState;
    outcome: 'created' | 'corrected' | 'unchanged';
}

/**
 * A denial returned from INSIDE a transaction callback. Kept as a value (not a
 * thrown error) so expected denials perform no attendance write and are not
 * confused with faults. A normal callback return releases its unit locks.
 */
type TxDenial = { ok: false; status: number; body: Record<string, unknown> };

export const createAttendanceRecordsRouter = (deps: AttendanceDeps): Router => {
    const router = Router();
    const { db } = deps;
    // A mutation without a real transaction must fail closed BEFORE any write.
    // There is deliberately NO autocommit fallback: running a mark/correction
    // directly on `db` would let the record and its audit commit as separate
    // autocommit statements, so a missing transaction seam is a hard 503, never
    // a fake transaction callback over the shared pool.
    const runAtomic = deps.transaction;

    router.use(deps.authenticate);

    const resolveStaffScope = async (req: AuthRequest, res: Response): Promise<StaffScope | null> => {
        const user = req.user;
        if (!user) {
            res.status(401).json({ error: 'Authentication required' });
            return null;
        }
        if (!user.tenantId) {
            res.status(403).json({ error: 'An active tenant membership is required' });
            return null;
        }
        const authority = await deps.loadActiveTenantAuthority(user.id, user.tenantId);
        if (!authority || !STAFF_AUTHORITIES.has(authority.authority)) {
            res.status(403).json({ error: 'Tenant instructor authority required' });
            return null;
        }
        return {
            tenantId: user.tenantId,
            userId: user.id,
            isOwner: authority.authority === 'owner',
        };
    };

    /**
     * Row-level session visibility under the exact-assignment policy. Deny by
     * default for a non-owner: only groups they are verifiably assigned to
     * (evaluated live, so reassignment/revocation applies immediately) and
     * sessions they created. A tenant or branch membership alone never grants
     * access to every group/session of the branch.
     */
    const buildSessionVisibility = (scope: StaffScope, alias: string): { sql: string; params: unknown[] } => {
        if (scope.isOwner) return { sql: '1=1', params: [] };
        const params: unknown[] = [scope.userId];
        const sql = `(${alias}.group_id IN (SELECT id FROM \`groups\` WHERE instructor_id = ?) OR ${alias}.created_by = ?)`;
        params.push(scope.userId);
        return { sql, params };
    };

    const loadStaffSession = async (scope: StaffScope, sessionId: string): Promise<SessionRow | null> => {
        const visibility = buildSessionVisibility(scope, 'schedule_sessions');
        return db.queryOne<SessionRow>(
            `SELECT id, tenant_id, branch_id, group_id, title, audience, timezone, starts_at, ends_at, status, created_by
             FROM schedule_sessions
             WHERE id = ? AND tenant_id = ? AND ${visibility.sql} LIMIT 1`,
            [sessionId, scope.tenantId, ...visibility.params],
        );
    };

    /**
     * Re-validate the canonical session on the CALLER'S transaction with a
     * LOCKING read. The outer pre-check reads a snapshot that can be stale, so a
     * session cancelled or reassigned (group/creator) since then must not
     * authorize this write. `FOR UPDATE` locks the session row.
     *
     * Group-dependent grants are evaluated from an explicitly locked, current
     * group row; a visibility subquery alone does not hold the assignment.
     * Owner and session-creator grants do not require group membership.
     */
    const lockSessionForWrite = async (
        tx: AttendanceDataAccess,
        scope: StaffScope,
        sessionId: string,
    ): Promise<SessionRow | null> => {
        // Read the canonical session first; a visibility subquery is not a
        // current, locked proof of group assignment.
        const row = await tx.queryOne<SessionRow>(
            `SELECT id, tenant_id, branch_id, group_id, title, audience, timezone, starts_at, ends_at, status, created_by
             FROM schedule_sessions
             WHERE id = ? AND tenant_id = ? LIMIT 1 FOR UPDATE`,
            [sessionId, scope.tenantId],
        );
        if (!row || row.tenant_id !== scope.tenantId) return null;
        // Preserve the existing policy's independent owner/creator grants.
        if (scope.isOwner || row.created_by === scope.userId) return row;
        if (!row.group_id) return null;
        const group = await tx.queryOne<{ id: string; tenant_id: string; instructor_id: string | null }>(
            'SELECT id, tenant_id, instructor_id FROM `groups` WHERE id = ? AND tenant_id = ? LIMIT 1 FOR UPDATE',
            [row.group_id, scope.tenantId],
        );
        // Evaluate the returned CURRENT row after any lock wait. Locking only
        // its id and trusting the earlier visibility check would retain a
        // grant revoked while this transaction was waiting.
        if (!group || group.id !== row.group_id || group.tenant_id !== scope.tenantId
            || group.instructor_id !== scope.userId) return null;
        return row;
    };

    /**
     * CURRENT (locking) read of the canonical student eligibility rows on the
     * caller's transaction.
     *
     * A plain SELECT under REPEATABLE READ reads the transaction snapshot, so a
     * deactivation / un-enrollment / group move committed after the snapshot is
     * invisible and the write would still proceed. `FOR UPDATE` forces a current
     * read AND locks the matched rows, so a concurrent eligibility change either
     * blocks here or is seen before the attendance write/audit. `ORDER BY s.id`
     * gives a deterministic lock order shared by the single and bulk paths, so
     * the source requests a consistent ordering; this is not a deadlock-freedom guarantee.
     *
     * The exact tenant/active/approval/enrollment predicates and the
     * group/branch linkage are applied under the lock. A branch-scoped session
     * joins (and therefore locks) the student's group row; a group-scoped
     * session locks the student row, which itself carries `group_id`.
     */
    const lockEligibleStudentIds = async (
        tx: AttendanceDataAccess,
        tenantId: string,
        session: Pick<SessionRow, 'group_id' | 'branch_id'>,
        studentIds: string[],
    ): Promise<Set<string>> => {
        if (studentIds.length === 0) return new Set();
        const placeholders = studentIds.map(() => '?').join(',');
        let sql = 'SELECT s.id FROM students s';
        if (session.branch_id && !session.group_id) {
            sql += ' INNER JOIN `groups` g ON g.id = s.group_id';
        }
        sql += ` WHERE s.tenant_id=? AND s.is_active=1 AND s.approval_status='approved'
                   AND (s.enrollment_status IS NULL OR s.enrollment_status='active')
                   AND (s.enrollment_start_date IS NULL OR s.enrollment_start_date<=UTC_TIMESTAMP())
                   AND (s.enrollment_end_date IS NULL OR s.enrollment_end_date>UTC_TIMESTAMP())
                   AND s.id IN (${placeholders})`;
        const params: unknown[] = [tenantId, ...studentIds];
        if (session.group_id) {
            sql += ' AND s.group_id = ?';
            params.push(session.group_id);
        } else if (session.branch_id) {
            sql += ' AND g.branch_id = ?';
            params.push(session.branch_id);
        }
        sql += ' ORDER BY s.id ASC FOR UPDATE';
        const rows = await tx.query<{ id: string }>(sql, params);
        return new Set(rows.map((row) => row.id));
    };

    const applyMark = async (
        tx: AttendanceDataAccess,
        scope: StaffScope,
        session: SessionRow,
        entry: ValidatedMark,
    ): Promise<MarkOutcome> => {
        // `forUpdate` makes the read a locking read, which bypasses the
        // transaction's REPEATABLE READ snapshot: after a duplicate-key loss it
        // must see the winner's row committed by the other transaction.
        const findRecordRow = (studentId: string, forUpdate = false) => tx.queryOne<RecordRow>(
            `SELECT id, tenant_id, session_id, student_id, state, reason, version
             FROM attendance_records
             WHERE tenant_id=? AND session_id=? AND student_id=? LIMIT 1${forUpdate ? ' FOR UPDATE' : ''}`,
            [scope.tenantId, session.id, studentId],
        );

        const existing = await findRecordRow(entry.studentId);

        if (existing && existing.state === entry.state) {
            return { id: existing.id, student_id: entry.studentId, state: entry.state, outcome: 'unchanged' };
        }

        if (existing) {
            if (entry.reason === null) {
                // A changed state is an audited correction: the backlog
                // requires a meaningful reason. Deny BEFORE any write rather
                // than storing a null reason over the saved one. An exact-same
                // mark never reaches this branch (handled above as a no-op).
                throw new AttendanceValidationError('reason is required when changing an existing attendance state');
            }
            const updated = await tx.execute(
                `UPDATE attendance_records
                 SET state=?, reason=?, corrected_at=UTC_TIMESTAMP(), corrected_by=?, correction_reason=?,
                     version=version+1, updated_at=CURRENT_TIMESTAMP
                 WHERE id=? AND tenant_id=? AND version=?`,
                [entry.state, entry.reason, scope.userId, entry.reason, existing.id, scope.tenantId, existing.version],
            );
            if (updated.affectedRows === 0) throw new AttendanceConflictError('attendance record changed concurrently');
            await recordAudit(tx.execute, {
                actorUserId: scope.userId,
                tenantId: scope.tenantId,
                action: 'attendance.correct',
                resourceType: 'attendance_record',
                resourceId: existing.id,
                reason: entry.reason ?? undefined,
                oldValue: snapshotRow(existing),
                newValue: { state: entry.state, reason: entry.reason, session_id: session.id, student_id: entry.studentId },
            });
            return { id: existing.id, student_id: entry.studentId, state: entry.state, outcome: 'corrected' };
        }

        const id = randomUUID();
        try {
            await tx.execute(
                `INSERT INTO attendance_records
                   (id, tenant_id, session_id, group_id, student_id, state, reason, marked_by, marked_at)
                 VALUES (?,?,?,?,?,?,?,?,UTC_TIMESTAMP())`,
                [id, scope.tenantId, session.id, session.group_id, entry.studentId, entry.state, entry.reason, scope.userId],
            );
        } catch (error) {
            if (!isDuplicateKeyError(error)) throw error;
            // Two concurrent first marks lost the "no existing record" window;
            // the UNIQUE (session_id, student_id) guard decided the race. The
            // winner's committed row is authoritative: report it idempotently.
            const racedRow = await findRecordRow(entry.studentId, true);
            if (!racedRow) throw error;
            return {
                id: racedRow.id,
                student_id: racedRow.student_id,
                state: racedRow.state as AttendanceState,
                outcome: 'unchanged',
            };
        }
        await recordAudit(tx.execute, {
            actorUserId: scope.userId,
            tenantId: scope.tenantId,
            action: 'attendance.mark',
            resourceType: 'attendance_record',
            resourceId: id,
            reason: entry.reason ?? undefined,
            newValue: { session_id: session.id, student_id: entry.studentId, state: entry.state, reason: entry.reason },
        });
        return { id, student_id: entry.studentId, state: entry.state, outcome: 'created' };
    };

    // -----------------------------------------------------------------------
    // Staff: list records for one session
    // -----------------------------------------------------------------------
    router.get('/sessions/:sessionId/records', async (req: AuthRequest, res: Response) => {
        try {
            const scope = await resolveStaffScope(req, res);
            if (!scope) return;
            const sessionId = normalizeId(req.params.sessionId);
            if (!sessionId) return res.status(404).json({ error: 'Session not found' });
            const range = parseTimeRangeFilter(req.query);
            if (!range.ok) return res.status(400).json({ error: range.error });
            const session = await loadStaffSession(scope, sessionId);
            if (!session) return res.status(404).json({ error: 'Session not found' });
            const timeRange = buildTimeRangeConditions('marked_at', range.value);
            const rows = await db.query(
                `SELECT id, student_id, state, reason, marked_by, marked_at, corrected_at, corrected_by, correction_reason
                 FROM attendance_records
                 WHERE tenant_id=? AND session_id=?${timeRange.sql}
                 ORDER BY student_id ASC, id ASC
                 LIMIT ${STAFF_RECORDS_PAGE_CAP + 1}`,
                [scope.tenantId, sessionId, ...timeRange.params],
            );
            const truncated = rows.length > STAFF_RECORDS_PAGE_CAP;
            res.set('X-Results-Truncated', truncated ? 'true' : 'false');
            res.json({ session_id: sessionId, records: truncated ? rows.slice(0, STAFF_RECORDS_PAGE_CAP) : rows });
        } catch (error) {
            console.error('List attendance records error:', error);
            res.status(500).json({ error: 'Failed to list attendance records' });
        }
    });

    // -----------------------------------------------------------------------
    // Staff: single mark (idempotent)
    // -----------------------------------------------------------------------
    router.post('/sessions/:sessionId/records', async (req: AuthRequest, res: Response) => {
        try {
            const scope = await resolveStaffScope(req, res);
            if (!scope) return;
            const sessionId = normalizeId(req.params.sessionId);
            if (!sessionId) return res.status(404).json({ error: 'Session not found' });
            const validated = validateMarkInput(req.body);
            if (!validated.ok) return res.status(400).json({ error: validated.error });

            if (typeof runAtomic !== 'function') {
                return res.status(503).json({ error: 'Attendance marking is temporarily unavailable' });
            }

            const result = await runAtomic(async (tx): Promise<{ ok: true; outcome: MarkOutcome } | TxDenial> => {
                // Re-validate the canonical session on THIS transaction with a
                // locking read: the outer snapshot may be stale, so a session
                // cancelled or reassigned since then must not authorize a write.
                const sessionNow = await lockSessionForWrite(tx, scope, sessionId);
                if (!sessionNow) return { ok: false, status: 404, body: { error: 'Session not found' } };
                if (sessionNow.status === 'cancelled') {
                    return { ok: false, status: 409, body: { error: 'A cancelled session cannot be marked' } };
                }
                // Current locking read of canonical eligibility: a deactivation,
                // un-enrollment or group move committed after the pre-check
                // blocks here or is seen — never silently marked.
                const eligibleNow = await lockEligibleStudentIds(tx, scope.tenantId, sessionNow, [validated.value.studentId]);
                if (!eligibleNow.has(validated.value.studentId)) {
                    return { ok: false, status: 403, body: { error: 'Student is not enrolled in this session' } };
                }
                return { ok: true, outcome: await applyMark(tx, scope, sessionNow, validated.value) };
            });
            if (!result.ok) return res.status(result.status).json(result.body);
            const outcome = result.outcome;
            res.status(outcome.outcome === 'created' ? 201 : 200).json({
                ...outcome,
                idempotent: outcome.outcome === 'unchanged',
                session_id: sessionId,
            });
        } catch (error) {
            if (error instanceof AttendanceValidationError) {
                return res.status(400).json({ error: error.message });
            }
            if (error instanceof AttendanceConflictError) {
                return res.status(409).json({ error: 'Attendance record changed concurrently' });
            }
            console.error('Mark attendance error:', error);
            res.status(500).json({ error: 'Failed to mark attendance' });
        }
    });

    // -----------------------------------------------------------------------
    // Staff: bulk mark (atomic)
    // -----------------------------------------------------------------------
    router.post('/sessions/:sessionId/records/bulk', async (req: AuthRequest, res: Response) => {
        try {
            const scope = await resolveStaffScope(req, res);
            if (!scope) return;
            const sessionId = normalizeId(req.params.sessionId);
            if (!sessionId) return res.status(404).json({ error: 'Session not found' });
            const validated = validateBulkInput(req.body);
            if (!validated.ok) return res.status(400).json({ error: validated.error });

            if (typeof runAtomic !== 'function') {
                return res.status(503).json({ error: 'Attendance marking is temporarily unavailable' });
            }

            const studentIds = validated.value.records.map((record) => record.studentId);

            const result = await runAtomic(async (tx): Promise<{ ok: true; outcomes: MarkOutcome[] } | TxDenial> => {
                // Re-validate the canonical session on THIS transaction (locking
                // read); a cancellation/reassignment since the outer snapshot
                // must not authorize the batch.
                const sessionNow = await lockSessionForWrite(tx, scope, sessionId);
                if (!sessionNow) return { ok: false, status: 404, body: { error: 'Session not found' } };
                if (sessionNow.status === 'cancelled') {
                    return { ok: false, status: 409, body: { error: 'A cancelled session cannot be marked' } };
                }
                // One locking read over the whole batch, deterministic ORDER BY
                // id; any ineligible student refuses the WHOLE batch (nothing
                // written, whole transaction rolls back).
                const eligibleNow = await lockEligibleStudentIds(tx, scope.tenantId, sessionNow, studentIds);
                const nowIneligible = studentIds.filter((id) => !eligibleNow.has(id));
                if (nowIneligible.length > 0) {
                    return { ok: false, status: 403, body: { error: 'Some students are not enrolled in this session', students: nowIneligible } };
                }
                const outcomes: MarkOutcome[] = [];
                for (const entry of validated.value.records) {
                    outcomes.push(await applyMark(tx, scope, sessionNow, entry));
                }
                return { ok: true, outcomes };
            });
            if (!result.ok) return res.status(result.status).json(result.body);
            const outcomes = result.outcomes;

            const tally = (outcome: MarkOutcome['outcome']): number =>
                outcomes.filter((result) => result.outcome === outcome).length;

            res.json({
                session_id: sessionId,
                total: outcomes.length,
                created: tally('created'),
                corrected: tally('corrected'),
                unchanged: tally('unchanged'),
                records: outcomes,
            });
        } catch (error) {
            if (error instanceof AttendanceValidationError) {
                return res.status(400).json({ error: error.message });
            }
            if (error instanceof AttendanceConflictError) {
                return res.status(409).json({ error: 'Attendance record changed concurrently' });
            }
            console.error('Bulk mark attendance error:', error);
            res.status(500).json({ error: 'Failed to mark attendance' });
        }
    });

    // -----------------------------------------------------------------------
    // Staff: correct an existing record (audited before/after)
    // -----------------------------------------------------------------------
    router.post('/records/:recordId/correct', async (req: AuthRequest, res: Response) => {
        try {
            const scope = await resolveStaffScope(req, res);
            if (!scope) return;
            const recordId = normalizeId(req.params.recordId);
            if (!recordId) return res.status(404).json({ error: 'Attendance record not found' });
            const validated = validateCorrectionInput(req.body);
            if (!validated.ok) return res.status(400).json({ error: validated.error });

            if (typeof runAtomic !== 'function') {
                return res.status(503).json({ error: 'Attendance correction is temporarily unavailable' });
            }

            const visibility = buildSessionVisibility(scope, 'ss');
            const existing = await db.queryOne<RecordRow>(
                `SELECT a.id, a.tenant_id, a.session_id, a.student_id, a.state, a.reason, a.version
                 FROM attendance_records a
                 INNER JOIN schedule_sessions ss ON ss.id = a.session_id
                 WHERE a.id=? AND a.tenant_id=? AND ${visibility.sql} LIMIT 1`,
                [recordId, scope.tenantId, ...visibility.params],
            );
            if (!existing) return res.status(404).json({ error: 'Attendance record not found' });
            if (existing.state === validated.value.state) {
                return res.status(409).json({ error: 'The record already has this state' });
            }

            const result = await runAtomic(async (tx): Promise<{ ok: true; changed: boolean } | TxDenial> => {
                // Revalidate the canonical session on THIS transaction: a
                // cancellation/reassignment since the outer read must not
                // authorize a correction either.
                const sessionNow = await lockSessionForWrite(tx, scope, existing.session_id);
                if (!sessionNow) return { ok: false, status: 404, body: { error: 'Attendance record not found' } };
                if (sessionNow.status === 'cancelled') {
                    return { ok: false, status: 409, body: { error: 'A cancelled session cannot be corrected' } };
                }
                const updated = await tx.execute(
                    `UPDATE attendance_records
                     SET state=?, reason=?, corrected_at=UTC_TIMESTAMP(), corrected_by=?, correction_reason=?,
                         version=version+1, updated_at=CURRENT_TIMESTAMP
                     WHERE id=? AND tenant_id=? AND version=?`,
                    [validated.value.state, validated.value.reason, scope.userId, validated.value.reason, recordId, scope.tenantId, existing.version],
                );
                if (updated.affectedRows === 0) return { ok: true, changed: false };
                await recordAudit(tx.execute, {
                    actorUserId: scope.userId,
                    tenantId: scope.tenantId,
                    action: 'attendance.correct',
                    resourceType: 'attendance_record',
                    resourceId: recordId,
                    reason: validated.value.reason,
                    oldValue: snapshotRow(existing),
                    newValue: { state: validated.value.state, reason: validated.value.reason },
                });
                return { ok: true, changed: true };
            });
            if (!result.ok) return res.status(result.status).json(result.body);
            if (!result.changed) return res.status(409).json({ error: 'Attendance record changed concurrently' });

            res.json({ id: recordId, state: validated.value.state, reason: validated.value.reason });
        } catch (error) {
            console.error('Correct attendance error:', error);
            res.status(500).json({ error: 'Failed to correct attendance' });
        }
    });

    // -----------------------------------------------------------------------
    // Student: only the caller's own records
    // -----------------------------------------------------------------------
    router.get('/me', async (req: AuthRequest, res: Response) => {
        try {
            const user = req.user;
            if (!user) return res.status(401).json({ error: 'Authentication required' });
            if (user.role !== 'student') return res.status(403).json({ error: 'Student access required' });
            if (!user.tenantId) return res.status(403).json({ error: 'An active student workspace is required' });
            const range = parseTimeRangeFilter(req.query);
            if (!range.ok) return res.status(400).json({ error: range.error });
            const student = await db.queryOne<{ id: string; tenant_id: string }>(
                `SELECT id, tenant_id FROM students
                 WHERE user_id=? AND tenant_id=? AND is_active=1 AND approval_status='approved'
                   AND (enrollment_status IS NULL OR enrollment_status='active')
                   AND (enrollment_start_date IS NULL OR enrollment_start_date<=UTC_TIMESTAMP())
                   AND (enrollment_end_date IS NULL OR enrollment_end_date>UTC_TIMESTAMP())
                 LIMIT 1`,
                [user.id, user.tenantId],
            );
            if (!student) return res.status(404).json({ error: 'Student workspace not found' });
            const timeRange = buildTimeRangeConditions('ss.starts_at', range.value);
            const rows = await db.query(
                `SELECT a.id, a.session_id, a.state, a.reason, a.marked_at, a.corrected_at,
                        ss.title, ss.starts_at, ss.ends_at, ss.timezone
                 FROM attendance_records a
                 INNER JOIN schedule_sessions ss ON ss.id = a.session_id
                 WHERE a.student_id=? AND a.tenant_id=?${timeRange.sql}
                 ORDER BY ss.starts_at DESC, ss.id DESC
                 LIMIT ${STUDENT_RECORDS_PAGE_CAP + 1}`,
                [student.id, student.tenant_id, ...timeRange.params],
            );
            const truncated = rows.length > STUDENT_RECORDS_PAGE_CAP;
            res.set('X-Results-Truncated', truncated ? 'true' : 'false');
            res.json({ student_id: student.id, records: truncated ? rows.slice(0, STUDENT_RECORDS_PAGE_CAP) : rows });
        } catch (error) {
            console.error('Student attendance error:', error);
            res.status(500).json({ error: 'Failed to load attendance' });
        }
    });

    return router;
};

/* Production wiring: real pool, real auth, real tenant authority. */

const TENANT_AUTHORITY_SQL = `
    SELECT 'owner' AS authority
    FROM tenants t
    WHERE t.id = ? AND t.owner_user_id = ? AND t.status = 'active'
    UNION ALL
    SELECT m.role_key AS authority
    FROM tenant_memberships m
    INNER JOIN tenants t ON t.id = m.tenant_id
    INNER JOIN users u ON u.id = m.user_id
    WHERE m.user_id = ? AND m.tenant_id = ? AND m.status = 'active'
      AND t.status = 'active' AND u.is_active = 1
      AND m.role_key IN ('owner','instructor')
    LIMIT 1
`;

let dbModule: typeof import('../db') | null = null;
const loadDb = async (): Promise<typeof import('../db')> => {
    dbModule ??= await import('../db');
    return dbModule;
};

const productionDb: AttendanceDataAccess = {
    query: async <T = Record<string, unknown>>(sql: string, params?: unknown[]) => {
        const { query } = await loadDb();
        return query<T>(sql, params as never);
    },
    queryOne: async <T = Record<string, unknown>>(sql: string, params?: unknown[]) => {
        const { queryOne } = await loadDb();
        return queryOne<T>(sql, params as never);
    },
    execute: async (sql: string, params?: unknown[]) => {
        const { execute } = await loadDb();
        return execute(sql, params as never);
    },
};

const loadActiveTenantAuthority = async (userId: string, tenantId: string) => {
    const { queryOne } = await loadDb();
    return queryOne<{ authority: string }>(TENANT_AUTHORITY_SQL, [tenantId, userId, userId, tenantId]);
};

/**
 * Production atomic seam: a mark/correction and its audit event, and a whole
 * bulk batch with its per-record audits, must commit or roll back together.
 * It also makes the duplicate-key re-read see the winner's committed row.
 */
const productionTransaction = async <T>(fn: (tx: AttendanceDataAccess) => Promise<T>): Promise<T> => {
    const { withTransaction } = await loadDb();
    return withTransaction((connection) => fn({
        query: async <R = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<R[]> => {
            const [rows] = await connection.query(sql, params as never);
            return rows as unknown as R[];
        },
        queryOne: async <R = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<R | null> => {
            const [rows] = await connection.query(sql, params as never);
            return (rows as unknown as R[])[0] ?? null;
        },
        execute: async (sql: string, params?: unknown[]) => {
            const [result] = await connection.execute(sql, params as never);
            const header = result as { insertId?: number; affectedRows?: number };
            const affectedRows = header.affectedRows;
            if (typeof affectedRows !== 'number' || !Number.isSafeInteger(affectedRows)) {
                throw new Error('attendance-records transaction execute did not report a usable affected-row count');
            }
            return { insertId: typeof header.insertId === 'number' && Number.isSafeInteger(header.insertId) ? header.insertId : 0, affectedRows };
        },
    }));
};

export default createAttendanceRecordsRouter({
    db: productionDb,
    authenticate: async (req, res, next) => {
        const { authenticateToken } = await import('../middleware/auth');
        return authenticateToken(req, res, next);
    },
    loadActiveTenantAuthority,
    transaction: productionTransaction,
});
