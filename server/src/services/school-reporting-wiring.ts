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

import { AsyncLocalStorage } from 'node:async_hooks';
import { Router, type RequestHandler } from 'express';
import type { PoolConnection } from 'mysql2/promise';
import { query as defaultQuery, queryOne as defaultQueryOne, withTransaction as defaultWithTransaction } from '../db';
import type { AuditRecordInput } from '../security/audit';
import { recordSealedAuditEvent, type AuditLogDataAccess } from './audit-log';
import { createExamManualGradingRouter, type ManualGradingAuditRecord } from '../routes/exam-manual-grading';
import {
    createProgressReportsRouter,
    createSqlCourseAuthority,
    type ProgressReportsDeps,
} from '../routes/progress-reports';
import {
    createAttendanceReportsRouter,
    type AttendanceReportAuditWriter,
    type AttendanceReportScope,
    type RecordVisibilityFilter,
} from '../routes/attendance-reports';
import {
    createExamManualGradingSqlStore,
    type ExamGradingSqlConnection,
    type ExamManualGradingAuditExecutor,
    type ExamManualGradingAuditInput,
    type ExamManualGradingAuditSink,
    type ExamManualGradingSqlStore,
} from './exam-manual-grading-sql';
import {
    createProgressPublicationSqlStore,
    type ProgressPublicationSqlStore,
} from './progress-publication-sql';
import {
    createProgressReportSourceSql,
    type SqlProgressReportSource,
} from './progress-report-source-sql';
import { createBillingLedgerSqlStore, type BillingLedgerSqlDeps, type BillingLedgerSqlStore } from './billing-ledger-sql';
import type {
    ExamManualGradingAuthority,
    ExamAuthorityDecision,
    ManualGradingScope,
    ManualGradingStore,
} from './exam-manual-grading';

/** Minimal connection surface shared by every real adapter. */
export interface ReportingSqlConnection {
    query<T = Record<string, unknown>>(sql: string, params?: readonly unknown[]): Promise<T[]>;
    execute(
        sql: string,
        params?: readonly unknown[],
    ): Promise<{ affectedRows?: number | string; insertId?: number | string }>;
}

/** Read seam used by authorities and the readiness probe (no transaction). */
export interface ReportingReadAccess {
    query<T = Record<string, unknown>>(sql: string, params?: readonly unknown[]): Promise<T[]>;
    queryOne<T = Record<string, unknown>>(sql: string, params?: readonly unknown[]): Promise<T | null>;
}

/** One connection per transaction; the callback receives exactly that connection. */
export interface ReportingDatabase extends ReportingReadAccess {
    transaction<T>(fn: (conn: ReportingSqlConnection) => Promise<T>): Promise<T>;
}

export interface SchemaReadinessResult {
    readonly ready: boolean;
    readonly missing: readonly string[];
}

export interface SchemaReadinessProbe {
    check(): Promise<SchemaReadinessResult>;
}

/**
 * Tables the wired surfaces need. The two new B2-C-SCHEMA tables are listed
 * first; the rest are the existing tables the real adapters read (the ledger
 * tables are deliberately excluded because no financial surface is wired).
 */
export const REPORTING_REQUIRED_TABLES = [
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
] as const;

/**
 * Columns the wired adapter SQL names. Table presence alone is not enough:
 * migration `20261021_01` adds `exam_versioned_attempts.reviewer_user_id` to an
 * EXISTING table, and the two new tables may exist with an older shape. This
 * list is explicit and derived from that migration plus the column names in
 * `exam-manual-grading-sql.ts` and `progress-publication-sql.ts`.
 */
export const REPORTING_REQUIRED_COLUMNS = [
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
] as const;

export const DEFAULT_READINESS_TTL_MS = 5000;

const TABLE_PLACEHOLDERS = REPORTING_REQUIRED_TABLES.map(() => '?').join(', ');
const COLUMN_TABLES = [...new Set(REPORTING_REQUIRED_COLUMNS.map((entry) => entry.table))];
const COLUMN_TABLE_PLACEHOLDERS = COLUMN_TABLES.map(() => '?').join(', ');

/**
 * Lazily evaluated INFORMATION_SCHEMA probe. It verifies both required table
 * names and required column names. The cache stores a successful reading
 * (including a missing-table or missing-column reading) for `ttlMs`; a probe
 * error is never cached, so the next request retries instead of keeping the
 * surface down for an unrelated transient failure.
 */
export const createInformationSchemaReadinessProbe = (
    db: ReportingReadAccess,
    options: { ttlMs?: number; now?: () => number } = {},
): SchemaReadinessProbe => {
    const ttlMs = options.ttlMs ?? DEFAULT_READINESS_TTL_MS;
    const now = options.now ?? (() => Date.now());
    let cached: { at: number; result: SchemaReadinessResult } | null = null;
    return {
        async check(): Promise<SchemaReadinessResult> {
            const at = now();
            if (cached && at - cached.at < ttlMs) return cached.result;
            const tableRows = await db.query<{ TABLE_NAME: string }>(
                `SELECT TABLE_NAME FROM INFORMATION_SCHEMA.TABLES
                 WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME IN (${TABLE_PLACEHOLDERS})`,
                [...REPORTING_REQUIRED_TABLES],
            );
            const presentTables = new Set(tableRows.map((row) => String(row.TABLE_NAME ?? '')));
            const missingTables = REPORTING_REQUIRED_TABLES.filter((table) => !presentTables.has(table));

            const columnRows = await db.query<{ TABLE_NAME: string; COLUMN_NAME: string }>(
                `SELECT TABLE_NAME, COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS
                 WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME IN (${COLUMN_TABLE_PLACEHOLDERS})`,
                [...COLUMN_TABLES],
            );
            const presentColumns = new Set(
                columnRows.map((row) => `${String(row.TABLE_NAME ?? '')}.${String(row.COLUMN_NAME ?? '')}`),
            );
            const missingColumns = REPORTING_REQUIRED_COLUMNS
                .filter((entry) => !presentColumns.has(`${entry.table}.${entry.column}`))
                .map((entry) => `${entry.table}.${entry.column}`);

            const missing = [...missingTables, ...missingColumns];
            const result: SchemaReadinessResult = { ready: missing.length === 0, missing };
            cached = { at, result };
            return result;
        },
    };
};

export interface SchoolReportingWiringDeps {
    /** Connection-bound database seam (production: `createDefaultReportingDatabase()`). */
    db: ReportingDatabase;
    /** Real token authenticator, passed by `index.ts`. */
    authenticate: RequestHandler;
    /** Defaults to the INFORMATION_SCHEMA probe over `db`. */
    schemaProbe?: SchemaReadinessProbe;
    /**
     * Test/capability seam. When absent, the production default is
     * `recordSealedAuditEvent` on the same connection. A supplied non-function
     * is rejected at construction.
     */
    sealedAuditSink?: (conn: ReportingSqlConnection, input: AuditRecordInput) => Promise<void>;
    now?: () => Date;
    readinessTtlMs?: number;
}

export interface SchoolReportingRouters {
    examManualGrading: Router;
    progressReports: Router;
    attendanceReports: Router;
}

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

export const createSqlTenantAuthorityLoader = (
    db: ReportingReadAccess,
): ((userId: string, tenantId: string) => Promise<{ authority: string } | null>) =>
    (userId, tenantId) => db.queryOne<{ authority: string }>(
        TENANT_AUTHORITY_SQL,
        [tenantId, userId, userId, tenantId],
    );

const STAFF_AUTHORITIES = new Set(['owner', 'instructor']);

const EXAM_IDS_LIMIT = 500;

/**
 * Production authority for the manual-grading router. It mirrors the explicit
 * server-derived teaching relations already used by `routes/exam-versions.ts`:
 * tenant owner, course instructor, and an instructor of a group of that course.
 * Branch membership is NEVER a grant (it is only a constraint elsewhere in the
 * product); role labels are never authority. Reads only.
 */
export const createSqlExamManualGradingAuthority = (
    db: ReportingReadAccess,
): ExamManualGradingAuthority => {
    const loadAuthority = createSqlTenantAuthorityLoader(db);
    const examCourse = (examId: string) => db.queryOne<{ id: string; tenant_id: string | null; instructor_id: string | null }>(
        `SELECT c.id, c.tenant_id, c.instructor_id
           FROM exams e INNER JOIN courses c ON c.id = e.course_id
          WHERE e.id = ? LIMIT 1`,
        [examId],
    );
    const instructorTeachesCourse = async (tenantId: string, userId: string, courseId: string): Promise<boolean> => {
        const row = await db.queryOne<{ id: string }>(
            'SELECT g.id FROM `groups` g INNER JOIN courses c ON c.id = g.course_id WHERE g.course_id=? AND g.instructor_id=? AND c.tenant_id=? LIMIT 1',
            [courseId, userId, tenantId],
        );
        return Boolean(row);
    };
    const authorizeExam = async (scope: ManualGradingScope, examId: string): Promise<ExamAuthorityDecision> => {
        const course = await examCourse(examId);
        if (!course || course.tenant_id !== scope.tenantId) return 'not_found';
        const authority = await loadAuthority(scope.userId, scope.tenantId);
        if (!authority || !STAFF_AUTHORITIES.has(authority.authority)) return 'forbidden';
        if (authority.authority === 'owner') return 'ok';
        if (course.instructor_id === scope.userId) return 'ok';
        if (await instructorTeachesCourse(scope.tenantId, scope.userId, course.id)) return 'ok';
        return 'forbidden';
    };
    const listAuthorizedExamIds = async (scope: ManualGradingScope): Promise<readonly string[]> => {
        const authority = await loadAuthority(scope.userId, scope.tenantId);
        if (!authority || !STAFF_AUTHORITIES.has(authority.authority)) return [];
        if (authority.authority === 'owner') {
            const rows = await db.query<{ id: string }>(
                `SELECT e.id FROM exams e INNER JOIN courses c ON c.id = e.course_id
                  WHERE c.tenant_id = ? ORDER BY e.id ASC LIMIT ?`,
                [scope.tenantId, EXAM_IDS_LIMIT],
            );
            return rows.map((row) => String(row.id));
        }
        const rows = await db.query<{ id: string }>(
            `SELECT DISTINCT e.id FROM exams e
               INNER JOIN courses c ON c.id = e.course_id
               LEFT JOIN \`groups\` g ON g.course_id = c.id
              WHERE c.tenant_id = ? AND (c.instructor_id = ? OR g.instructor_id = ?)
              ORDER BY e.id ASC LIMIT ?`,
            [scope.tenantId, scope.userId, scope.userId, EXAM_IDS_LIMIT],
        );
        return rows.map((row) => String(row.id));
    };
    return { authorizeExam, listAuthorizedExamIds };
};

/**
 * Row-level attendance visibility, copied verbatim from the attendance router's
 * server-verified predicate (owner sees the tenant; an instructor sees only
 * groups they are assigned to and sessions they created). This module only
 * binds the module's injected contract; the attendance domain is not changed.
 */
export const buildAttendanceRecordVisibility = (scope: AttendanceReportScope): RecordVisibilityFilter => {
    if (scope.isOwner) return { sql: '1=1', params: [] };
    return {
        sql: '(ss.group_id IN (SELECT id FROM `groups` WHERE instructor_id = ?) OR ss.created_by = ?)',
        params: [scope.userId, scope.userId],
    };
};

const isAuditExecutor = (value: object): value is ExamManualGradingAuditExecutor =>
    typeof (value as { writeAudit?: unknown }).writeAudit === 'function';

/**
 * Adapt one mysql2 pool connection to the adapter contract. Every adapter and
 * the sealed writer receive the SAME returned wrapper for the whole unit of
 * work, so no statement can escape to another pooled connection.
 */
export const bindReportingConnection = (connection: PoolConnection): ReportingSqlConnection => {
    const conn: ReportingSqlConnection = {
        async query<T = Record<string, unknown>>(sql: string, params?: readonly unknown[]): Promise<T[]> {
            const [rows] = await connection.query(sql, params ? [...params] : undefined);
            return (Array.isArray(rows) ? rows : []) as unknown as T[];
        },
        async execute(sql: string, params?: readonly unknown[]) {
            const [result] = await connection.execute(sql, params ? [...params] : undefined);
            return result as unknown as { affectedRows?: number | string; insertId?: number | string };
        },
    };
    return conn;
};

const normalizeExecuteHeader = (
    result: { affectedRows?: number | string; insertId?: number | string },
): { insertId?: number; affectedRows?: number } => {
    const insertId = typeof result.insertId === 'string' ? Number(result.insertId) : result.insertId;
    const affectedRows = typeof result.affectedRows === 'string' ? Number(result.affectedRows) : result.affectedRows;
    return {
        insertId: typeof insertId === 'number' && Number.isFinite(insertId) ? insertId : undefined,
        affectedRows: typeof affectedRows === 'number' && Number.isFinite(affectedRows) ? affectedRows : undefined,
    };
};

const bindAuditAccess = (conn: ReportingSqlConnection): AuditLogDataAccess => ({
    query: <T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]> =>
        conn.query<T>(sql, params),
    queryOne: async <T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T | null> => {
        const rows = await conn.query<T>(sql, params);
        return rows[0] ?? null;
    },
    execute: async (sql: string, params?: unknown[]) => normalizeExecuteHeader(await conn.execute(sql, params ?? [])),
});

export const createDefaultSealedAuditSink = (): ((
    conn: ReportingSqlConnection,
    input: AuditRecordInput,
) => Promise<void>) => (conn, input) => recordSealedAuditEvent(bindAuditAccess(conn), input);

/** Production database seam derived from the existing `db.ts` helpers. */
export const createDefaultReportingDatabase = (): ReportingDatabase => ({
    query: <T = Record<string, unknown>>(sql: string, params?: readonly unknown[]) =>
        defaultQuery<T>(sql, params ? [...params] : undefined),
    queryOne: <T = Record<string, unknown>>(sql: string, params?: readonly unknown[]) =>
        defaultQueryOne<T>(sql, params ? [...params] : undefined),
    transaction: <T>(fn: (conn: ReportingSqlConnection) => Promise<T>): Promise<T> =>
        defaultWithTransaction((connection) => fn(bindReportingConnection(connection))),
});

const readinessGuard = (probe: SchemaReadinessProbe): RequestHandler => async (_req, res, next) => {
    try {
        const result = await probe.check();
        if (!result.ready) {
            res.status(503).json({ error: 'Reporting is temporarily unavailable' });
            return;
        }
        next();
    } catch {
        res.status(503).json({ error: 'Reporting is temporarily unavailable' });
    }
};

const KNOWN_SCHEMA_ERROR_CODES = new Set(['ER_NO_SUCH_TABLE', 'ER_BAD_FIELD_ERROR', 'ER_BAD_TABLE_ERROR']);

/** True only for the reviewed schema-drift codes; unknown errors are not hidden. */
export const isKnownSchemaError = (error: unknown): boolean => {
    if (!error || typeof error !== 'object') return false;
    const code = (error as { code?: unknown }).code;
    return typeof code === 'string' && KNOWN_SCHEMA_ERROR_CODES.has(code);
};

interface SchemaErrorContext {
    schemaError: boolean;
}

const schemaErrorScope = new AsyncLocalStorage<SchemaErrorContext>();

const markSchemaError = (error: unknown): void => {
    if (!isKnownSchemaError(error)) return;
    const context = schemaErrorScope.getStore();
    if (context) context.schemaError = true;
};

/**
 * Wrap every datastore seam so a KNOWN schema-drift code raised during a
 * request is remembered for that request. The routers catch handler errors and
 * answer 500; the response wrapper below converts only a remembered known
 * schema error to the generic 503. Unknown errors keep their generic 500.
 */
const withSchemaErrorTracking = (db: ReportingDatabase): ReportingDatabase => ({
    query: async <T = Record<string, unknown>>(sql: string, params?: readonly unknown[]): Promise<T[]> => {
        try {
            return await db.query<T>(sql, params);
        } catch (error) {
            markSchemaError(error);
            throw error;
        }
    },
    queryOne: async <T = Record<string, unknown>>(sql: string, params?: readonly unknown[]): Promise<T | null> => {
        try {
            return await db.queryOne<T>(sql, params);
        } catch (error) {
            markSchemaError(error);
            throw error;
        }
    },
    transaction: async <T>(fn: (conn: ReportingSqlConnection) => Promise<T>): Promise<T> => {
        try {
            return await db.transaction(fn);
        } catch (error) {
            markSchemaError(error);
            throw error;
        }
    },
});

const withSchemaErrorResponses = (router: Router): Router => {
    const wrapper = Router();
    wrapper.use((req, res, next) => {
        const context: SchemaErrorContext = { schemaError: false };
        const json = res.json.bind(res);
        const send = res.send.bind(res);
        const unavailable = (): boolean => context.schemaError && (res.statusCode ?? 200) >= 500;
        res.json = (body: unknown) => {
            if (unavailable()) {
                res.status(503);
                return json({ error: 'Reporting is temporarily unavailable' });
            }
            return json(body);
        };
        res.send = (body: unknown) => {
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
const composeAuthenticate = (authenticate: RequestHandler, probe: SchemaReadinessProbe): RequestHandler => {
    const guard = readinessGuard(probe);
    return (req, res, next) => {
        authenticate(req, res, (error?: unknown) => {
            if (error) {
                next(error);
                return;
            }
            void guard(req, res, next);
        });
    };
};

const assertWiring = (deps: SchoolReportingWiringDeps): void => {
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
export const createInternalLedgerStore = (deps: BillingLedgerSqlDeps): BillingLedgerSqlStore =>
    createBillingLedgerSqlStore(deps);

export const createSchoolReportingRouters = (deps: SchoolReportingWiringDeps): SchoolReportingRouters => {
    assertWiring(deps);
    const db = withSchemaErrorTracking(deps.db);
    const now = deps.now ?? (() => new Date());
    const probe = deps.schemaProbe ?? createInformationSchemaReadinessProbe(db, { ttlMs: deps.readinessTtlMs });
    const sealedAuditSink = deps.sealedAuditSink ?? createDefaultSealedAuditSink();
    const authenticate = composeAuthenticate(deps.authenticate, probe);
    const loadActiveTenantAuthority = createSqlTenantAuthorityLoader(db);

    /* ------------------------------------------------------------------ */
    /* Exam manual grading: real adapter + single sealed audit writer     */
    /* ------------------------------------------------------------------ */
    const examTransactionRunner = <T>(fn: (conn: ExamGradingSqlConnection) => Promise<T>): Promise<T> =>
        db.transaction(fn);
    const examAuditSink: ExamManualGradingAuditSink = (conn, input) => sealedAuditSink(conn, input);
    const examStore: ExamManualGradingSqlStore = createExamManualGradingSqlStore({
        transaction: examTransactionRunner,
        audit: examAuditSink,
    });
    const examManualGrading = createExamManualGradingRouter({
        store: examStore,
        authenticate,
        authority: createSqlExamManualGradingAuthority(db),
        transaction: <T>(fn: (tx: ManualGradingStore) => Promise<T>): Promise<T> =>
            examTransactionRunner((conn) => fn(examStore.inTransaction(conn))),
        audit: async (tx: ManualGradingStore, input: ManualGradingAuditRecord) => {
            if (!isAuditExecutor(tx)) {
                throw new Error('Exam manual grading audit writer is not bound to the transaction store');
            }
            const auditInput: ExamManualGradingAuditInput = {
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
    const reportSource: SqlProgressReportSource = createProgressReportSourceSql({
        transaction: (fn) => db.transaction(fn),
    });
    const publicationStore: ProgressPublicationSqlStore = createProgressPublicationSqlStore({
        transaction: (fn) => db.transaction(fn),
        audit: (conn, input) => sealedAuditSink(conn, input),
    });
    const progressDeps: ProgressReportsDeps = {
        authenticate,
        loadActiveTenantAuthority,
        authority: createSqlCourseAuthority({
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
    const progressReports = createProgressReportsRouter(progressDeps);

    /* ------------------------------------------------------------------ */
    /* Attendance reports: existing module bound to its injected contract */
    /* ------------------------------------------------------------------ */
    const attendanceStore = { query: <T = Record<string, unknown>>(sql: string, params?: readonly unknown[]) =>
        db.query<T>(sql, params) };
    const attendanceAudit: AttendanceReportAuditWriter = (_store, input) =>
        db.transaction((conn) => sealedAuditSink(conn, input));
    const attendanceReports = createAttendanceReportsRouter({
        store: attendanceStore,
        authenticate,
        loadActiveTenantAuthority,
        buildRecordVisibility: buildAttendanceRecordVisibility,
        audit: attendanceAudit,
        now,
    });

    return {
        examManualGrading: withSchemaErrorResponses(examManualGrading),
        progressReports: withSchemaErrorResponses(progressReports),
        attendanceReports: withSchemaErrorResponses(attendanceReports),
    };
};
