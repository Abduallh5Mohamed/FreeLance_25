"use strict";
/**
 * B2-C-PERSISTENCE — real SQL adapter for `PublicationStore`.
 *
 * SOURCE CODE ONLY: no database connection is opened or implied. Nothing here
 * proves that migration `20261021_01_exam_manual_publication.sql` was applied.
 * Every statement of a unit of work runs through the injected connection-bound
 * transaction runner. The adapter never writes an audit row itself: the
 * domain service/route layer is the single writer and calls `writeAudit` on the
 * transaction-bound handle, so the sealed audit row uses that same `conn`. A
 * missing runner or audit writer is rejected before any statement; there is no
 * pooled or autocommit fallback.
 *
 * Table: `progress_report_publications`
 *  - one row per `(tenant_id, student_enrollment_id, course_id)`, enforced by
 *    `UNIQUE uq_progress_publication`;
 *  - `version` is the CAS counter; every successful transition is
 *    `UPDATE ... WHERE ... AND version = ?` and affected rows must be 1;
 *  - the initial-row race is resolved by trying the CAS first and then an
 *    `INSERT` whose duplicate key is re-read under the tenant predicate. Losers
 *    return 0 affected rows (conflict), never a second row.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.createBoundProgressPublicationSqlStore = exports.createProgressPublicationSqlStore = exports.PROGRESS_PUBLICATION_LIST_CAP = exports.ProgressPublicationSqlError = void 0;
const node_crypto_1 = require("node:crypto");
class ProgressPublicationSqlError extends Error {
    constructor(code, message) {
        super(message);
        this.code = code;
        this.name = 'ProgressPublicationSqlError';
    }
}
exports.ProgressPublicationSqlError = ProgressPublicationSqlError;
/** Bounded list read for the teacher feed; never an unbounded tenant scan. */
exports.PROGRESS_PUBLICATION_LIST_CAP = 5000;
const PUBLICATION_COLUMNS = `tenant_id, student_enrollment_id, course_id, state,
    published_by, published_at, version`;
const FIND_SQL = `SELECT ${PUBLICATION_COLUMNS}
    FROM progress_report_publications
    WHERE tenant_id = ? AND student_enrollment_id = ? AND course_id = ?
    LIMIT 1`;
const LIST_SQL = `SELECT ${PUBLICATION_COLUMNS}
    FROM progress_report_publications
    WHERE tenant_id = ?`;
const LIST_ORDER = 'ORDER BY student_enrollment_id ASC, course_id ASC LIMIT ?';
const CAS_UPDATE = `UPDATE progress_report_publications
    SET state = ?, published_by = ?, published_at = ?, version = version + 1
    WHERE tenant_id = ? AND student_enrollment_id = ? AND course_id = ? AND version = ?`;
const INSERT_ROW = `INSERT INTO progress_report_publications
    (id, tenant_id, student_enrollment_id, course_id, state, published_by, published_at, version)
    VALUES (?, ?, ?, ?, ?, ?, ?, 1)`;
const affectedRowsOf = (result) => {
    const value = typeof result.affectedRows === 'string' ? Number(result.affectedRows) : result.affectedRows;
    return typeof value === 'number' && Number.isFinite(value) ? value : 0;
};
const isDuplicateError = (error) => typeof error === 'object' && error !== null && error.code === 'ER_DUP_ENTRY';
const normalizeVersion = (value) => {
    const parsed = typeof value === 'string' ? Number(value) : value;
    if (!Number.isSafeInteger(parsed) || parsed < 0) {
        throw new ProgressPublicationSqlError('invalid_version', 'publication version must be a non-negative safe integer');
    }
    return parsed;
};
const normalizeExpectedVersion = (value) => {
    if (!Number.isSafeInteger(value) || value < 0) {
        throw new ProgressPublicationSqlError('invalid_version', 'expectedVersion must be a non-negative safe integer');
    }
    return value;
};
const normalizeState = (value) => {
    if (value !== 'draft' && value !== 'published') {
        throw new ProgressPublicationSqlError('invalid_state', 'publication state must be draft or published');
    }
    return value;
};
const toPublishedAt = (value) => {
    if (value === null)
        return null;
    const date = value instanceof Date ? value : new Date(value);
    if (!Number.isFinite(date.getTime())) {
        throw new ProgressPublicationSqlError('invalid_row', 'published_at is not a parseable timestamp');
    }
    return date;
};
const mapRecord = (row) => {
    if (typeof row.tenant_id !== 'string'
        || typeof row.student_enrollment_id !== 'string'
        || typeof row.course_id !== 'string') {
        throw new ProgressPublicationSqlError('invalid_row', 'publication identity columns must be strings');
    }
    return {
        tenantId: row.tenant_id,
        studentEnrollmentId: row.student_enrollment_id,
        courseId: row.course_id,
        state: normalizeState(row.state),
        publishedBy: row.published_by,
        publishedAt: toPublishedAt(row.published_at),
        version: normalizeVersion(row.version),
    };
};
class ProgressPublicationSqlTransaction {
    constructor(conn, deps) {
        this.conn = conn;
        this.deps = deps;
    }
    /** The ONLY audit path: required sealed writer, on this transaction's conn. */
    async writeAudit(input) {
        await this.deps.audit(this.conn, input);
    }
    async findPublication(tenantId, studentEnrollmentId, courseId) {
        const rows = await this.conn.query(FIND_SQL, [tenantId, studentEnrollmentId, courseId]);
        const row = rows[0];
        if (!row)
            return null;
        if (row.tenant_id !== tenantId) {
            throw new ProgressPublicationSqlError('invalid_row', 'publication row belongs to another tenant');
        }
        return mapRecord(row);
    }
    async listPublications(tenantId, courseId) {
        const params = [tenantId];
        let sql = LIST_SQL;
        if (courseId !== undefined) {
            sql += ' AND course_id = ?';
            params.push(courseId);
        }
        sql += ` ${LIST_ORDER}`;
        params.push(exports.PROGRESS_PUBLICATION_LIST_CAP);
        const rows = await this.conn.query(sql, params);
        return rows.filter((row) => row.tenant_id === tenantId).map(mapRecord);
    }
    async transitionPublication(input) {
        const expectedVersion = normalizeExpectedVersion(input.expectedVersion);
        const nextState = normalizeState(input.nextState);
        const publishedBy = nextState === 'published' ? input.actorUserId : null;
        const publishedAt = nextState === 'published' ? input.now : null;
        const update = await this.conn.execute(CAS_UPDATE, [
            nextState,
            publishedBy,
            publishedAt,
            input.tenantId,
            input.studentEnrollmentId,
            input.courseId,
            expectedVersion,
        ]);
        let affected = affectedRowsOf(update);
        if (affected === 0 && expectedVersion === 0) {
            try {
                const inserted = await this.conn.execute(INSERT_ROW, [
                    this.deps.idFactory(),
                    input.tenantId,
                    input.studentEnrollmentId,
                    input.courseId,
                    nextState,
                    publishedBy,
                    publishedAt,
                ]);
                affected = affectedRowsOf(inserted);
            }
            catch (error) {
                if (!isDuplicateError(error))
                    throw error;
                // The unique key is the race arbiter. Re-read under the tenant
                // predicate; only a still-version-0 seeded row may be updated.
                const existing = await this.findPublication(input.tenantId, input.studentEnrollmentId, input.courseId);
                if (!existing || existing.version !== expectedVersion)
                    return 0;
                const retried = await this.conn.execute(CAS_UPDATE, [
                    nextState,
                    publishedBy,
                    publishedAt,
                    input.tenantId,
                    input.studentEnrollmentId,
                    input.courseId,
                    expectedVersion,
                ]);
                affected = affectedRowsOf(retried);
            }
        }
        // No audit here: the service/route layer is the single writer and calls
        // `writeAudit` on this same transaction-bound handle.
        return affected;
    }
}
class ProgressPublicationSqlStoreImpl {
    constructor(deps) {
        this.deps = deps;
        if (!deps || typeof deps.transaction !== 'function') {
            throw new ProgressPublicationSqlError('invalid_runner', 'ProgressPublicationSqlStore requires a connection-bound transaction runner');
        }
        if (typeof deps.audit !== 'function') {
            throw new ProgressPublicationSqlError('invalid_audit', 'ProgressPublicationSqlStore requires the sealed connection-bound audit writer');
        }
        this.audit = deps.audit;
        this.idFactory = deps.idFactory ?? node_crypto_1.randomUUID;
    }
    inTransaction(conn) {
        return new ProgressPublicationSqlTransaction(conn, {
            audit: this.audit,
            idFactory: this.idFactory,
        });
    }
    findPublication(tenantId, studentEnrollmentId, courseId) {
        return this.deps.transaction((conn) => this.inTransaction(conn).findPublication(tenantId, studentEnrollmentId, courseId));
    }
    listPublications(tenantId, courseId) {
        return this.deps.transaction((conn) => this.inTransaction(conn).listPublications(tenantId, courseId));
    }
    transitionPublication(input) {
        return this.deps.transaction((conn) => this.inTransaction(conn).transitionPublication(input));
    }
}
/** Build the adapter; a missing/non-callable runner throws before any query. */
const createProgressPublicationSqlStore = (deps) => new ProgressPublicationSqlStoreImpl(deps);
exports.createProgressPublicationSqlStore = createProgressPublicationSqlStore;
const createBoundProgressPublicationSqlStore = (conn, deps) => new ProgressPublicationSqlStoreImpl(deps).inTransaction(conn);
exports.createBoundProgressPublicationSqlStore = createBoundProgressPublicationSqlStore;
