"use strict";
/**
 * M5 G7 (C3a) — manual-attendance report routes.
 *
 * Source of truth: the `attendance_records` table ONLY (column names copied
 * from the verified definition in
 * `migrations/20261018_11_schedules_attendance_records.sql` and the existing
 * queries in `routes/attendance-records.ts`). The legacy `attendance` table is
 * never read here and the legacy-vs-new source-of-truth decision (D6) is NOT
 * made by this module; no automatic/live attendance or reconciliation lives
 * here either.
 *
 * Authority + scope model (identical to the attendance router's
 * server-verified rules, 2026-10-19):
 *  - Staff only: a verified tenant owner or an active instructor membership in
 *    the server-selected tenant. Role labels are never authority.
 *  - Row-level record visibility is NOT invented here: it is copy-injected as
 *    `deps.buildRecordVisibility` — the same predicate the attendance router
 *    applies (`groups.instructor_id` membership re-checked live + sessions
 *    the caller created; only the tenant owner keeps the tenant-wide
 *    exception). A tenant or branch membership alone never grants row access.
 *  - The record query always carries `ar.tenant_id = ?`, so a cross-tenant
 *    filter id is indistinguishable from unknown and is rejected 404 before
 *    any record read.
 *
 * Report surface (mounted elsewhere in a later task — this factory is NOT
 * attached anywhere by this task and no production wiring is exported):
 *  - `GET /summary`     — deterministic per state/totals + per student /
 *                         per group / per session aggregates over a validated
 *                         bounded UTC date range (both bounds required, max
 *                         span capped in services/attendance-reports.ts).
 *  - `GET /export.csv`  — the same bounded read as one CSV row per underlying
 *                         record, formula-injection neutralized through the
 *                         service's use of the progress-reports `neutralizeCsvCell`
 *                         helper, audited (actor, tenant, row count, range,
 *                         truncated flag) and capped. An audit failure fails
 *                         the export before any data is written to the
 *                         response.
 *  - Both feeds are bounded by one hard row cap and carry
 *    `X-Results-Truncated: true|false`; aggregates are computed over exactly
 *    the reported rows, so totals always equal the sum of underlying rows.
 *
 * Privacy contract: no report, export or aggregate exposes `reason` or
 * `correction_reason` (private reason visibility is an undecided policy, D3).
 * What a corrected row yields is the boolean/count fact only. `correction`
 * facts are exposed as counts and a per-row boolean.
 *
 * Store contract: `deps.store` is an injected read-only data access. It is the
 * seam for production wiring later; supplying it here is NOT evidence that any
 * SQL has been run or works. The shipped SELECT below is restricted to the
 * fields in `AttendanceReportRecordRow` (never `reason`/`correction_reason`);
 * production also needs the optional `(tenant_id, group_id, marked_at)` index
 * from I2, which remains non-blocking.
 *
 * Audit contract: `deps.audit` is REQUIRED and is the only write path. The
 * router hands it the same store handle used for the read plus the audit
 * payload, so the production wiring can bind a sealed writer to one
 * connection. Construction without it fails before any request. If the writer
 * throws, the export fails with a generic error and no CSV byte is sent.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.createAttendanceReportsRouter = void 0;
const express_1 = require("express");
const crypto_1 = require("crypto");
const announcements_1 = require("../services/announcements");
const attendance_reports_1 = require("../services/attendance-reports");
const schedules_1 = require("../services/schedules");
const STAFF_AUTHORITIES = new Set(['owner', 'instructor']);
/** Server-side literals (never client input) behind the validated filter ids. */
const FILTER_EXISTENCE_SQL = {
    students: 'SELECT id FROM students WHERE id = ? AND tenant_id = ? LIMIT 1',
    groups: 'SELECT id FROM `groups` WHERE id = ? AND tenant_id = ? LIMIT 1',
    branches: 'SELECT id FROM branches WHERE id = ? AND tenant_id = ? LIMIT 1',
};
const FILTER_KIND_LABEL = {
    students: 'Student',
    groups: 'Group',
    branches: 'Branch',
};
const FILTER_QUERY_PARAM = {
    students: 'student_id',
    groups: 'group_id',
    branches: 'branch_id',
};
const createAttendanceReportsRouter = (deps) => {
    if (!deps || typeof deps.audit !== 'function') {
        throw new Error('Attendance reports require a sealed audit writer');
    }
    const router = (0, express_1.Router)();
    const { store } = deps;
    const now = deps.now ?? (() => new Date());
    router.use(deps.authenticate);
    const resolveStaffScope = async (req, res) => {
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
     * Optional `student_id` / `group_id` / `branch_id` filters. A present but
     * malformed value is a 400; a well-formed id that does not exist inside
     * the caller's tenant (including a cross-tenant id) is a 404 before any
     * record read, because the record query itself only ever carries this
     * tenant's rows.
     */
    const resolveReportFilters = async (req, scope, res) => {
        const filters = { students: undefined, groups: undefined, branches: undefined };
        for (const kind of Object.keys(FILTER_EXISTENCE_SQL)) {
            const raw = req.query[FILTER_QUERY_PARAM[kind]];
            if (raw === undefined)
                continue;
            const normalized = (0, announcements_1.normalizeId)(raw);
            if (normalized === null) {
                res.status(400).json({ error: `Invalid ${FILTER_QUERY_PARAM[kind]} filter` });
                return null;
            }
            filters[kind] = normalized;
        }
        for (const kind of Object.keys(FILTER_EXISTENCE_SQL)) {
            const id = filters[kind];
            if (id === undefined)
                continue;
            const rows = await store.query(FILTER_EXISTENCE_SQL[kind], [id, scope.tenantId]);
            if (!rows || rows.length === 0) {
                res.status(404).json({ error: `${FILTER_KIND_LABEL[kind]} not found` });
                return null;
            }
        }
        return filters;
    };
    /**
     * The single bounded record read both feeds share. Fetches one row past
     * the hard cap so truncation is explicit, not silent. The visibility
     * fragment comes last in the parameter list, exactly as injected.
     */
    const loadReportRows = async (scope, fromUtc, toUtc, filters) => {
        const conditions = ['ar.tenant_id = ?', 'ar.marked_at >= ?', 'ar.marked_at <= ?'];
        const params = [scope.tenantId, fromUtc, toUtc];
        for (const kind of Object.keys(FILTER_EXISTENCE_SQL)) {
            const id = filters[kind];
            if (id === undefined)
                continue;
            const column = kind === 'students' ? 'ar.student_id' : kind === 'groups' ? 'ar.group_id' : 'ss.branch_id';
            conditions.push(`${column} = ?`);
            params.push(id);
        }
        const visibility = deps.buildRecordVisibility(scope);
        conditions.push(visibility.sql);
        params.push(...visibility.params);
        const sql = `SELECT ar.id, ar.tenant_id, ar.session_id, ar.group_id, ar.student_id, ar.state, ar.marked_at,
                    (ar.corrected_at IS NOT NULL) AS corrected
             FROM attendance_records ar
             INNER JOIN schedule_sessions ss ON ss.id = ar.session_id
             WHERE ${conditions.join(' AND ')}
             ORDER BY ar.marked_at ASC, ar.id ASC
             LIMIT ${attendance_reports_1.ATTENDANCE_REPORT_ROW_CAP + 1}`;
        return store.query(sql, params);
    };
    /** Shared bounded-read prologue; returns null when the response is sent. */
    const resolveReportRead = async (req, res) => {
        const scope = await resolveStaffScope(req, res);
        if (!scope)
            return null;
        const range = (0, attendance_reports_1.validateReportRange)(req.query, schedules_1.parseTimeRangeFilter);
        if (!range.ok) {
            res.status(400).json({ error: range.error });
            return null;
        }
        const filters = await resolveReportFilters(req, scope, res);
        if (!filters)
            return null;
        const raw = await loadReportRows(scope, range.value.fromUtc, range.value.toUtc, filters);
        const truncated = raw.length > attendance_reports_1.ATTENDANCE_REPORT_ROW_CAP;
        return {
            scope,
            rows: truncated ? raw.slice(0, attendance_reports_1.ATTENDANCE_REPORT_ROW_CAP) : raw,
            truncated,
            filters,
            fromUtc: range.value.fromUtc,
            toUtc: range.value.toUtc,
        };
    };
    // -----------------------------------------------------------------------
    // GET /summary — deterministic aggregates over the bounded range
    // -----------------------------------------------------------------------
    router.get('/summary', async (req, res) => {
        try {
            const read = await resolveReportRead(req, res);
            if (!read)
                return;
            res.set('X-Results-Truncated', read.truncated ? 'true' : 'false');
            res.json({
                tenant_id: read.scope.tenantId,
                range: { from: read.fromUtc, to: read.toUtc },
                filters: {
                    student_id: read.filters.students ?? null,
                    group_id: read.filters.groups ?? null,
                    branch_id: read.filters.branches ?? null,
                },
                row_count: read.rows.length,
                truncated: read.truncated,
                totals: (0, attendance_reports_1.summarizeAttendanceRows)(read.rows),
                by_student: (0, attendance_reports_1.aggregateAttendanceByStudent)(read.rows),
                by_group: (0, attendance_reports_1.aggregateAttendanceByGroup)(read.rows),
                by_session: (0, attendance_reports_1.aggregateAttendanceBySession)(read.rows),
            });
        }
        catch (error) {
            console.error('Attendance report summary error:', error);
            res.status(500).json({ error: 'Failed to build attendance report' });
        }
    });
    // -----------------------------------------------------------------------
    // GET /export.csv — neutralized, capped, audited; audit failure loses
    // the export (no data reaches the response).
    // -----------------------------------------------------------------------
    router.get('/export.csv', async (req, res) => {
        try {
            const read = await resolveReportRead(req, res);
            if (!read)
                return;
            const csv = (0, attendance_reports_1.buildAttendanceReportCsv)(read.rows);
            // Exactly one sealed event, written before any CSV byte is sent.
            // The writer receives the same store handle used for the read.
            await deps.audit(store, {
                actorUserId: read.scope.userId,
                tenantId: read.scope.tenantId,
                action: 'attendance_report.export',
                resourceType: 'attendance_report',
                resourceId: (0, crypto_1.randomUUID)(),
                newValue: {
                    from: read.fromUtc,
                    to: read.toUtc,
                    filters: {
                        student_id: read.filters.students ?? null,
                        group_id: read.filters.groups ?? null,
                        branch_id: read.filters.branches ?? null,
                    },
                    row_count: read.rows.length,
                    truncated: read.truncated,
                    totals: (0, attendance_reports_1.summarizeAttendanceRows)(read.rows),
                    requested_at: now().toISOString(),
                },
            });
            res.set('Content-Type', 'text/csv; charset=utf-8');
            res.set('Content-Disposition', 'inline; filename="attendance-report.csv"');
            res.set('X-Results-Truncated', read.truncated ? 'true' : 'false');
            res.status(200).send(csv);
        }
        catch (error) {
            console.error('Attendance report export error:', error);
            res.status(500).json({ error: 'Failed to export attendance report' });
        }
    });
    return router;
};
exports.createAttendanceReportsRouter = createAttendanceReportsRouter;
