"use strict";
/**
 * B2-C-INTEGRATION — production wiring for the Batch-2 school reporting
 * surfaces.
 *
 * Everything here is a factory: importing this module issues no query, acquires
 * no connection and starts no worker. It imports the existing `../db` module,
 * which owns the MySQL pool; this wiring module itself evaluates no statement
 * at import. The default production database seam is built by
 * `createDefaultReportingDatabase()`, which only adapts the existing `db.ts`
 * helpers.
 *
 * Connection discipline: one `ReportingDatabase.transaction` callback receives
 * one connection wrapper. Every statement of the unit of work — including the
 * sealed audit append — is issued through that same wrapper. The adapters are
 * the real B2-C-PERSISTENCE SQL adapters. This module adds no SQL of its own
 * except the read-only authority/scope queries and the INFORMATION_SCHEMA
 * readiness probe; none of them writes.
 *
 * Audit discipline: `recordSealedAuditEvent` is the default writer. It is bound
 * to the transaction connection through a per-connection adapter, so the audit
 * row and the state change share the connection. A missing audit writer or a
 * missing transaction runner is rejected before any request is served. The
 * attendance-report export is sealed the same way: exactly one event, on the
 * unit-of-work connection, before any CSV byte.
 *
 * Schema readiness: the new tables are source-only migrations and may not be
 * applied. `createInformationSchemaReadinessProbe()` checks the required table
 * names AND the required columns lazily at request time (never at
 * import/construction) with a short TTL cache and fails closed to HTTP 503
 * before any handler, data read, write or audit. Known MySQL schema-error
 * codes raised later in a request are mapped to the same generic 503; unknown
 * errors stay generic 500. No runtime DDL is issued.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.createSchoolReportingRouters = exports.createInternalLedgerStore = exports.isKnownSchemaError = exports.createDefaultReportingDatabase = exports.createDefaultSealedAuditSink = exports.bindReportingConnection = exports.buildAttendanceRecordVisibility = exports.createSqlExamManualGradingAuthority = exports.createSqlTenantAuthorityLoader = exports.createInformationSchemaReadinessProbe = exports.DEFAULT_READINESS_TTL_MS = exports.REPORTING_REQUIRED_COLUMNS = exports.REPORTING_REQUIRED_TABLES = void 0;
const node_async_hooks_1 = require("node:async_hooks");
const express_1 = require("express");
const db_1 = require("../db");
const audit_log_1 = require("./audit-log");
const exam_manual_grading_1 = require("../routes/exam-manual-grading");
const progress_reports_1 = require("../routes/progress-reports");
const attendance_reports_1 = require("../routes/attendance-reports");
const exam_manual_grading_sql_1 = require("./exam-manual-grading-sql");
const progress_publication_sql_1 = require("./progress-publication-sql");
const progress_report_source_sql_1 = require("./progress-report-source-sql");
const billing_ledger_sql_1 = require("./billing-ledger-sql");
/**
 * Tables the wired surfaces need. The two new B2-C-SCHEMA tables are listed
 * first; the rest are the existing tables the real adapters read (the ledger
 * tables are deliberately excluded because no financial surface is wired).
 */
exports.REPORTING_REQUIRED_TABLES = [
    'exam_manual_answer_revisions',
    'progress_report_publications',
    'exam_versioned_attempts',
    'exam_versioned_answers',
    'exam_version_questions',
    'exam_versions',
    'exams',
    'courses',
    'students',
    'groups',
    'student_courses',
    'branches',
    'branch_memberships',
    'gradebook_scores',
    'lectures',
    'lesson_completions',
    'attendance_records',
    'schedule_sessions',
];
/**
 * Columns the wired adapter SQL names. Table presence alone is not enough:
 * migration `20261021_01` adds `exam_versioned_attempts.reviewer_user_id` to an
 * EXISTING table, and the two new tables may exist with an older shape. This
 * list is explicit and derived from that migration plus the column names in
 * `exam-manual-grading-sql.ts` and `progress-publication-sql.ts`.
 */
exports.REPORTING_REQUIRED_COLUMNS = [
    { table: 'exam_versioned_attempts', column: 'reviewer_user_id' },
    { table: 'exam_manual_answer_revisions', column: 'id' },
    { table: 'exam_manual_answer_revisions', column: 'tenant_id' },
    { table: 'exam_manual_answer_revisions', column: 'attempt_id' },
    { table: 'exam_manual_answer_revisions', column: 'question_ref' },
    { table: 'exam_manual_answer_revisions', column: 'revision' },
    { table: 'exam_manual_answer_revisions', column: 'awarded_hundredths' },
    { table: 'exam_manual_answer_revisions', column: 'reviewer_user_id' },
    { table: 'exam_manual_answer_revisions', column: 'feedback' },
    { table: 'exam_manual_answer_revisions', column: 'created_at' },
    { table: 'progress_report_publications', column: 'id' },
    { table: 'progress_report_publications', column: 'tenant_id' },
    { table: 'progress_report_publications', column: 'student_enrollment_id' },
    { table: 'progress_report_publications', column: 'course_id' },
    { table: 'progress_report_publications', column: 'state' },
    { table: 'progress_report_publications', column: 'published_by' },
    { table: 'progress_report_publications', column: 'published_at' },
    { table: 'progress_report_publications', column: 'version' },
];
exports.DEFAULT_READINESS_TTL_MS = 5000;
const TABLE_PLACEHOLDERS = exports.REPORTING_REQUIRED_TABLES.map(() => '?').join(', ');
const COLUMN_TABLES = [...new Set(exports.REPORTING_REQUIRED_COLUMNS.map((entry) => entry.table))];
const COLUMN_TABLE_PLACEHOLDERS = COLUMN_TABLES.map(() => '?').join(', ');
/**
 * Lazily evaluated INFORMATION_SCHEMA probe. It verifies both required table
 * names and required column names. The cache stores a successful reading
 * (including a missing-table or missing-column reading) for `ttlMs`; a probe
 * error is never cached, so the next request retries instead of keeping the
 * surface down for an unrelated transient failure.
 */
const createInformationSchemaReadinessProbe = (db, options = {}) => {
    const ttlMs = options.ttlMs ?? exports.DEFAULT_READINESS_TTL_MS;
    const now = options.now ?? (() => Date.now());
    let cached = null;
    return {
        async check() {
            const at = now();
            if (cached && at - cached.at < ttlMs)
                return cached.result;
            const tableRows = await db.query(`SELECT TABLE_NAME FROM INFORMATION_SCHEMA.TABLES
                 WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME IN (${TABLE_PLACEHOLDERS})`, [...exports.REPORTING_REQUIRED_TABLES]);
            const presentTables = new Set(tableRows.map((row) => String(row.TABLE_NAME ?? '')));
            const missingTables = exports.REPORTING_REQUIRED_TABLES.filter((table) => !presentTables.has(table));
            const columnRows = await db.query(`SELECT TABLE_NAME, COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS
                 WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME IN (${COLUMN_TABLE_PLACEHOLDERS})`, [...COLUMN_TABLES]);
            const presentColumns = new Set(columnRows.map((row) => `${String(row.TABLE_NAME ?? '')}.${String(row.COLUMN_NAME ?? '')}`));
            const missingColumns = exports.REPORTING_REQUIRED_COLUMNS
                .filter((entry) => !presentColumns.has(`${entry.table}.${entry.column}`))
                .map((entry) => `${entry.table}.${entry.column}`);
            const missing = [...missingTables, ...missingColumns];
            const result = { ready: missing.length === 0, missing };
            cached = { at, result };
            return result;
        },
    };
};
exports.createInformationSchemaReadinessProbe = createInformationSchemaReadinessProbe;
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
    LIMIT 1`;
const createSqlTenantAuthorityLoader = (db) => (userId, tenantId) => db.queryOne(TENANT_AUTHORITY_SQL, [tenantId, userId, userId, tenantId]);
exports.createSqlTenantAuthorityLoader = createSqlTenantAuthorityLoader;
const STAFF_AUTHORITIES = new Set(['owner', 'instructor']);
const EXAM_IDS_LIMIT = 500;
/**
 * Production authority for the manual-grading router. It mirrors the explicit
 * server-derived teaching relations already used by `routes/exam-versions.ts`:
 * the live responsible course instructor. Institution ownership is not a grant.
 * Branch membership is NEVER a grant (it is only a constraint elsewhere in the
 * product); role labels are never authority. Reads only.
 */
const createSqlExamManualGradingAuthority = (db) => {
    const loadAuthority = (0, exports.createSqlTenantAuthorityLoader)(db);
    const examCourse = (examId) => db.queryOne(`SELECT c.id, c.tenant_id, c.instructor_id
           FROM exams e INNER JOIN courses c ON c.id = e.course_id
          WHERE e.id = ? AND c.is_active=1 AND NOT EXISTS (SELECT 1 FROM admin_user_roles platform_role WHERE platform_role.user_id=c.instructor_id) LIMIT 1`, [examId]);
    const authorizeExam = async (scope, examId) => {
        const course = await examCourse(examId);
        if (!course || course.tenant_id !== scope.tenantId)
            return 'not_found';
        const authority = await loadAuthority(scope.userId, scope.tenantId);
        if (!authority || !STAFF_AUTHORITIES.has(authority.authority))
            return 'forbidden';
        if (course.instructor_id === scope.userId)
            return 'ok';
        return 'forbidden';
    };
    const listAuthorizedExamIds = async (scope) => {
        const authority = await loadAuthority(scope.userId, scope.tenantId);
        if (!authority || !STAFF_AUTHORITIES.has(authority.authority))
            return [];
        const rows = await db.query('SELECT e.id FROM exams e INNER JOIN courses c ON c.id=e.course_id WHERE c.tenant_id=? AND c.instructor_id=? AND c.is_active=1 AND NOT EXISTS (SELECT 1 FROM admin_user_roles platform_role WHERE platform_role.user_id=c.instructor_id) ORDER BY e.id ASC LIMIT ?', [scope.tenantId, scope.userId, EXAM_IDS_LIMIT]);
        return rows.map((row) => String(row.id));
    };
    return { authorizeExam, listAuthorizedExamIds };
};
exports.createSqlExamManualGradingAuthority = createSqlExamManualGradingAuthority;
/**
 * Row-level attendance visibility, copied verbatim from the attendance router's
 * server-verified predicate (owner sees the tenant; an instructor sees only
 * groups they are assigned to and sessions they created). This module only
 * binds the module's injected contract; the attendance domain is not changed.
 */
const buildAttendanceRecordVisibility = (scope) => {
    if (scope.isOwner)
        return { sql: '1=1', params: [] };
    return {
        sql: '(ss.group_id IN (SELECT id FROM `groups` WHERE instructor_id = ?) OR ss.created_by = ?)',
        params: [scope.userId, scope.userId],
    };
};
exports.buildAttendanceRecordVisibility = buildAttendanceRecordVisibility;
const isAuditExecutor = (value) => typeof value.writeAudit === 'function';
/**
 * Adapt one mysql2 pool connection to the adapter contract. Every adapter and
 * the sealed writer receive the SAME returned wrapper for the whole unit of
 * work, so no statement can escape to another pooled connection.
 */
const bindReportingConnection = (connection) => {
    const conn = {
        async query(sql, params) {
            const [rows] = await connection.query(sql, params ? [...params] : undefined);
            return (Array.isArray(rows) ? rows : []);
        },
        async execute(sql, params) {
            const [result] = await connection.execute(sql, params ? [...params] : undefined);
            return result;
        },
    };
    return conn;
};
exports.bindReportingConnection = bindReportingConnection;
const normalizeExecuteHeader = (result) => {
    const insertId = typeof result.insertId === 'string' ? Number(result.insertId) : result.insertId;
    const affectedRows = typeof result.affectedRows === 'string' ? Number(result.affectedRows) : result.affectedRows;
    return {
        insertId: typeof insertId === 'number' && Number.isFinite(insertId) ? insertId : undefined,
        affectedRows: typeof affectedRows === 'number' && Number.isFinite(affectedRows) ? affectedRows : undefined,
    };
};
const bindAuditAccess = (conn) => ({
    query: (sql, params) => conn.query(sql, params),
    queryOne: async (sql, params) => {
        const rows = await conn.query(sql, params);
        return rows[0] ?? null;
    },
    execute: async (sql, params) => normalizeExecuteHeader(await conn.execute(sql, params ?? [])),
});
const createDefaultSealedAuditSink = () => (conn, input) => (0, audit_log_1.recordSealedAuditEvent)(bindAuditAccess(conn), input);
exports.createDefaultSealedAuditSink = createDefaultSealedAuditSink;
/** Production database seam derived from the existing `db.ts` helpers. */
const createDefaultReportingDatabase = () => ({
    query: (sql, params) => (0, db_1.query)(sql, params ? [...params] : undefined),
    queryOne: (sql, params) => (0, db_1.queryOne)(sql, params ? [...params] : undefined),
    transaction: (fn) => (0, db_1.withTransaction)((connection) => fn((0, exports.bindReportingConnection)(connection))),
});
exports.createDefaultReportingDatabase = createDefaultReportingDatabase;
const readinessGuard = (probe) => async (_req, res, next) => {
    try {
        const result = await probe.check();
        if (!result.ready) {
            res.status(503).json({ error: 'Reporting is temporarily unavailable' });
            return;
        }
        next();
    }
    catch {
        res.status(503).json({ error: 'Reporting is temporarily unavailable' });
    }
};
const KNOWN_SCHEMA_ERROR_CODES = new Set(['ER_NO_SUCH_TABLE', 'ER_BAD_FIELD_ERROR', 'ER_BAD_TABLE_ERROR']);
/** True only for the reviewed schema-drift codes; unknown errors are not hidden. */
const isKnownSchemaError = (error) => {
    if (!error || typeof error !== 'object')
        return false;
    const code = error.code;
    return typeof code === 'string' && KNOWN_SCHEMA_ERROR_CODES.has(code);
};
exports.isKnownSchemaError = isKnownSchemaError;
const schemaErrorScope = new node_async_hooks_1.AsyncLocalStorage();
const markSchemaError = (error) => {
    if (!(0, exports.isKnownSchemaError)(error))
        return;
    const context = schemaErrorScope.getStore();
    if (context)
        context.schemaError = true;
};
/**
 * Wrap every datastore seam so a KNOWN schema-drift code raised during a
 * request is remembered for that request. The routers catch handler errors and
 * answer 500; the response wrapper below converts only a remembered known
 * schema error to the generic 503. Unknown errors keep their generic 500.
 */
const withSchemaErrorTracking = (db) => ({
    query: async (sql, params) => {
        try {
            return await db.query(sql, params);
        }
        catch (error) {
            markSchemaError(error);
            throw error;
        }
    },
    queryOne: async (sql, params) => {
        try {
            return await db.queryOne(sql, params);
        }
        catch (error) {
            markSchemaError(error);
            throw error;
        }
    },
    transaction: async (fn) => {
        try {
            return await db.transaction(fn);
        }
        catch (error) {
            markSchemaError(error);
            throw error;
        }
    },
});
const withSchemaErrorResponses = (router) => {
    const wrapper = (0, express_1.Router)();
    wrapper.use((req, res, next) => {
        const context = { schemaError: false };
        const json = res.json.bind(res);
        const send = res.send.bind(res);
        const unavailable = () => context.schemaError && (res.statusCode ?? 200) >= 500;
        res.json = (body) => {
            if (unavailable()) {
                res.status(503);
                return json({ error: 'Reporting is temporarily unavailable' });
            }
            return json(body);
        };
        res.send = (body) => {
            if (unavailable()) {
                res.status(503);
                return json({ error: 'Reporting is temporarily unavailable' });
            }
            return send(body);
        };
        schemaErrorScope.run(context, () => next());
    });
    wrapper.use(router);
    return wrapper;
};
/**
 * Run the real authenticator first (anonymous => 401 with zero datastore
 * access), then the readiness guard, then the router handler. The inner router
 * receives this composed authenticator and therefore cannot reach a handler or
 * adapter before both gates pass.
 */
const composeAuthenticate = (authenticate, probe) => {
    const guard = readinessGuard(probe);
    return (req, res, next) => {
        authenticate(req, res, (error) => {
            if (error) {
                next(error);
                return;
            }
            void guard(req, res, next);
        });
    };
};
const assertWiring = (deps) => {
    if (!deps || !deps.db || typeof deps.db.transaction !== 'function'
        || typeof deps.db.query !== 'function' || typeof deps.db.queryOne !== 'function') {
        throw new Error('School reporting wiring requires a connection-bound transaction runner and read seam');
    }
    if (typeof deps.authenticate !== 'function') {
        throw new Error('School reporting wiring requires the real authenticate middleware');
    }
    if (deps.sealedAuditSink !== undefined && typeof deps.sealedAuditSink !== 'function') {
        throw new Error('School reporting wiring requires a callable sealed audit writer');
    }
    if (deps.schemaProbe !== undefined && typeof deps.schemaProbe.check !== 'function') {
        throw new Error('School reporting wiring requires a callable schema readiness probe');
    }
};
/**
 * Internal-only ledger store factory for a later approved use. Nothing
 * financial is mounted by this module and `index.ts` does not call it.
 */
const createInternalLedgerStore = (deps) => (0, billing_ledger_sql_1.createBillingLedgerSqlStore)(deps);
exports.createInternalLedgerStore = createInternalLedgerStore;
const createSchoolReportingRouters = (deps) => {
    assertWiring(deps);
    const db = withSchemaErrorTracking(deps.db);
    const now = deps.now ?? (() => new Date());
    const probe = deps.schemaProbe ?? (0, exports.createInformationSchemaReadinessProbe)(db, { ttlMs: deps.readinessTtlMs });
    const sealedAuditSink = deps.sealedAuditSink ?? (0, exports.createDefaultSealedAuditSink)();
    const authenticate = composeAuthenticate(deps.authenticate, probe);
    const loadActiveTenantAuthority = (0, exports.createSqlTenantAuthorityLoader)(db);
    /* ------------------------------------------------------------------ */
    /* Exam manual grading: real adapter + single sealed audit writer     */
    /* ------------------------------------------------------------------ */
    const examTransactionRunner = (fn) => db.transaction(fn);
    const examAuditSink = (conn, input) => sealedAuditSink(conn, input);
    const examStore = (0, exam_manual_grading_sql_1.createExamManualGradingSqlStore)({
        transaction: examTransactionRunner,
        audit: examAuditSink,
    });
    const examManualGrading = (0, exam_manual_grading_1.createExamManualGradingRouter)({
        readOnly: true,
        store: examStore,
        authenticate,
        authority: (0, exports.createSqlExamManualGradingAuthority)(db),
        transaction: (fn) => examTransactionRunner((conn) => fn(examStore.inTransaction(conn))),
        audit: async (tx, input) => {
            if (!isAuditExecutor(tx)) {
                throw new Error('Exam manual grading audit writer is not bound to the transaction store');
            }
            const auditInput = {
                actorUserId: input.actorUserId,
                tenantId: input.tenantId,
                action: input.action,
                resourceType: input.resourceType,
                resourceId: input.resourceId,
                oldValue: input.oldValue,
                newValue: input.newValue,
            };
            await tx.writeAudit(auditInput);
        },
        now,
    });
    /* ------------------------------------------------------------------ */
    /* Progress reports: source, publication adapter + service            */
    /* ------------------------------------------------------------------ */
    const reportSource = (0, progress_report_source_sql_1.createProgressReportSourceSql)({
        transaction: (fn) => db.transaction(fn),
    });
    const publicationStore = (0, progress_publication_sql_1.createProgressPublicationSqlStore)({
        transaction: (fn) => db.transaction(fn),
        audit: (conn, input) => sealedAuditSink(conn, input),
    });
    const progressDeps = {
        authenticate,
        loadActiveTenantAuthority,
        authority: (0, progress_reports_1.createSqlCourseAuthority)({
            query: (sql, params) => db.query(sql, params),
            queryOne: (sql, params) => db.queryOne(sql, params),
        }),
        reportSource,
        store: publicationStore,
        audit: (input) => db.transaction((conn) => sealedAuditSink(conn, input)),
        now,
        transaction: (fn) => db.transaction(async (conn) => {
            const bound = publicationStore.inTransaction(conn);
            return fn({ store: bound, audit: (input) => bound.writeAudit(input) });
        }),
    };
    const progressReports = (0, progress_reports_1.createProgressReportsRouter)(progressDeps);
    /* ------------------------------------------------------------------ */
    /* Attendance reports: existing module bound to its injected contract */
    /* ------------------------------------------------------------------ */
    const attendanceStore = { query: (sql, params) => db.query(sql, params) };
    const attendanceAudit = (_store, input) => db.transaction((conn) => sealedAuditSink(conn, input));
    const attendanceReports = (0, attendance_reports_1.createAttendanceReportsRouter)({
        store: attendanceStore,
        authenticate,
        loadActiveTenantAuthority,
        buildRecordVisibility: exports.buildAttendanceRecordVisibility,
        audit: attendanceAudit,
        now,
    });
    return {
        examManualGrading: withSchemaErrorResponses(examManualGrading),
        progressReports: withSchemaErrorResponses(progressReports),
        attendanceReports: withSchemaErrorResponses(attendanceReports),
    };
};
exports.createSchoolReportingRouters = createSchoolReportingRouters;
