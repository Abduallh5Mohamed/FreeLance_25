/**
 * M8 Q6 — per-tenant data export.
 *
 * Scope + permission model (deny by default):
 *  - An export is started only by the verified tenant OWNER of the
 *    server-derived tenant, or by a verified platform actor holding the
 *    `tenant_export.request` permission (server-owned rows only; a JWT role
 *    claim is never evidence).
 *  - The whole surface fails closed with 503 unless TENANT_EXPORT_SECRET is
 *    configured with at least EXPORT_SECRET_MIN_BYTES (32) bytes: no job is
 *    created, no token is issued, no byte is read, and the denial is audited.
 *  - One active (pending) export per tenant is enforced twice: an explicit
 *    pre-check AND the database-level UNIQUE key on the generated
 *    active_tenant_lock column (see migration 20261018_23), so two concurrent
 *    requests cannot both start an export; the loser of that INSERT race is
 *    mapped to 409 instead of surfacing a 500. A completed export starts a
 *    cooldown window during which new requests are 409.
 *  - Completion and its audit are ONE transaction, and the transaction seam is
 *    required rather than optional: without it the surface refuses to publish
 *    (503) instead of running an autocommit sequence that merely looks durable.
 *    There is no compensating UPDATE on the request or completion paths. A
 *    compensation cannot tell its own uncommitted row from another attempt's,
 *    and one that matched `completed` could demote a winner this call never
 *    completed. Every row-mutating failure path is an OWNED, fenced transition.
 *  - Durable execution ownership (I2) is REQUIRED, and is injected rather than
 *    assumed. A `pending` row is not ownership — it is the state another attempt
 *    is standing in — and the process-local single-flight set is not fencing.
 *    Without the capability the surface fails closed before job creation,
 *    before processing and before any storage write. The owner identity is
 *    generated server-side from the crypto source and never taken from a
 *    request. Every ownership-sensitive statement — completion, failure, abort
 *    and release — carries the SAME four-term fence evaluated by the database:
 *    exact owner, exact epoch, a LIVE unexpired lease, and the intended state.
 *    See `EXPORT_OWNERSHIP_OWNED_PREDICATE`.
 *  - A terminal `failed`/`aborted` audit exists ONLY inside the same
 *    transaction as an owned transition that moved exactly one row. Zero rows
 *    (lease lost to another attempt), an audit that rolled the transaction
 *    back, and an unknowable COMMIT are three DIFFERENT outcomes and all three
 *    leave the job's state unknown to this call: it then records a NON-terminal
 *    audit (`ownership_unproven`, `ownership_lost`,
 *    `failure_audit_rolled_back`, `failure_commit_unknown`) and asserts nothing
 *    about the job. `commit_unknown` is never relabelled `uncommitted`.
 *  - Ambiguous commit, success side: if the completion callback finished and
 *    the transaction wrapper then threw, the COMMIT outcome is unknowable. That
 *    case performs NO row write and emits NO completed audit — it records
 *    `tenant_export.completion_unknown` and the caller must read the job back
 *    to learn whether it is pending or completed.
 *  - Artifacts live under a per-attempt namespace
 *    (`{prefix}/{tenantId}/{exportId}/{attemptId}/…`), so racing attempts never
 *    write the same key and a loser cannot overwrite the winner's bytes. Only
 *    the winning attempt's manifest pointer is persisted, in the same
 *    transaction as its audit. A loser's namespace is left unreferenced: no
 *    purge, no deletion, and no ownership inferred from the process-local
 *    single-flight set.
 *  - Cancellation: the irreversible publication point is the COMMIT of the row
 *    transition. An abort before the manifest write prevents publication;
 *    artifacts already written are orphans referenced by no row, never
 *    advertised as a downloadable export. An abort that loses the race does not
 *    retract a published export — the manifest is returned as completed.
 *
 * Ownership (W2 repair):
 *  - `tenant_id` is a nullable column on several planned tables. It was
 *    populated once by the 20261017_04 backfill, and some write paths never
 *    set it, so `WHERE tenant_id = ?` silently dropped every row created
 *    after that backfill (SQL `=` never matches NULL).
 *  - Each planned table therefore declares ownership *authorities*:
 *      * `owns`     — a predicate proving the row belongs to the bound tenant
 *                     (direct `tenant_id`, or a parent whose own tenant is
 *                     proven: lectures/groups/exams -> courses, children ->
 *                     their planned parent);
 *      * `conflicts` — a predicate proving the same row is claimed by a
 *                     different tenant.
 *    A row is exported only when at least one authority proves the tenant AND
 *    no authority resolves to another tenant. A direct `tenant_id` that
 *    contradicts the proven parent is rejected and counted, never preferred.
 *    Two resolved authorities that disagree are ambiguity, and ambiguity is a
 *    denial: there is no "first row"/"first parent" selection anywhere.
 *  - Authorities are denial-only where they are not a proof source (e.g. a
 *    lecture's group, an exam's group attachments). They can remove a row but
 *    never add one, so the export never widens beyond the plan's parent chain.
 *  - Rows whose ownership cannot be proven (NULL direct value and no
 *    resolvable parent) are never selected and are never counted: an
 *    unattributable row is not evidence of this tenant's data, and a count
 *    could describe another institution's activity.
 *
 * Completeness manifest (v2):
 *  - Per-table row count, byte size and SHA-256 checksum of the exact JSONL
 *    payload written through the injected storage interface.
 *  - `coverage.included[]` names every table that was written with its
 *    ownership basis, parent chain, rejected-contradiction count and whether a
 *    resource cap truncated it. `coverage.omitted[]` names every tenant-scoped
 *    table in `server/migrations` that the plan does not export, with a reason
 *    and, where a proof exists, a proven lower bound of this tenant's rows.
 *  - `coverage.complete` and `coverage.incomplete` answer different questions
 *    and neither of them means "broken":
 *      * `complete` is always false — this file is a declared subset of
 *        tenant-scoped tables, read table by table without a consistent
 *        point-in-time snapshot, and rows whose ownership cannot be proven are
 *        withheld. No other field can make it a full copy of the tenant.
 *      * `incomplete` is true only when a gap was detected *inside the
 *        declared plan*: a resource cap truncated a table, a table was skipped
 *        because the byte budget was spent, or a row was rejected as an
 *        ownership contradiction. `incomplete: false` means no such gap was
 *        detected in the planned tables; it never upgrades the extract to
 *        complete.
 *  - Reads are paged by keyset (`id > ?`) with a bounded page size, and both a
 *    per-table row cap and a total byte cap are enforced while reading — the
 *    whole table is never materialised before the JSONL is built.
 *  - Stale `pending` jobs are never reclaimed on age alone: `tenant_data_exports`
 *    has no owner/fencing column, so reclaiming would race a live worker. That
 *    part needs a schema change (I2) and is reported, not invented here.
 *
 *  - Abort: `deps.signal` is checked before every page and before every table.
 *    An aborted run writes no further table, writes no manifest, records the
 *    job as `failed` with the code `aborted`, audits `tenant_export.aborted`
 *    and never audits a success. Each read is a single awaited statement, so
 *    there is no open iterator to close: aborting simply stops issuing work.
 *  - Failure codes: the job `error` column and every audit payload carry a
 *    closed code (`aborted`, `source_unavailable`, `read_failed`,
 *    `storage_write_failed`, `completion_conflict`), never a driver message.
 *    A MySQL error carries `sql`, `sqlMessage` and the bound parameters, and
 *    the manifest is a downloadable artifact, so raw text is never persisted.
 *  - Concurrency: one in-process attempt per export id is enforced explicitly
 *    (`export_in_progress`). Across processes the completion CAS still decides
 *    the winner and a loser never demotes or fails the winner's row, but the
 *    loser can still overwrite the winner's manifest object because the storage
 *    key is derived from the export id alone. Closing that needs a fencing
 *    column on `tenant_data_exports` (the same I2 request above); it is not
 *    invented here.
 *
 *  - Downloads require a signed, expiring HMAC token
 *    (base64url(payload).base64url(HMAC-SHA256(secret, payload))) binding
 *    export id + tenant id + expiry; verification is constant-time and fails
 *    closed. The signed export id must equal the requested export id, and the
 *    persisted token hash makes re-issuance rotate (invalidate) the previous
 *    token. Every request, completion, failure, token issuance and download
 *    is audited; configuration and download denials are audited too.
 *
 * This module never reads process.env or performs I/O itself: the secret,
 * the clock, the id generator, the storage and the audit writer are all
 * injected, so the whole flow is hermetically testable.
 */

import { createHash, createHmac, randomUUID, timingSafeEqual } from 'crypto';

export const EXPORT_SECRET_MIN_BYTES = 32;
export const EXPORT_DOWNLOAD_TOKEN_TTL_SECONDS = 600;
export const EXPORT_DOWNLOAD_WINDOW_SECONDS = 24 * 60 * 60;
export const EXPORT_COOLDOWN_SECONDS = 300;
export const EXPORT_STORAGE_PREFIX = 'tenant-exports';
export const EXPORT_PLATFORM_PERMISSION = 'tenant_export.request';
/** v2 adds the `coverage` section and the `incomplete` flag. */
export const EXPORT_MANIFEST_VERSION = 2;

/** Rows per keyset page. Overridable per call for tests; validated on use. */
export const EXPORT_PAGE_SIZE = 500;
/** Hard cap on rows read from one table before it is declared truncated. */
export const EXPORT_MAX_ROWS_PER_TABLE = 50_000;
/** Hard cap on the bytes this export may write across all tables (64 MiB). */
export const EXPORT_MAX_TOTAL_BYTES = 64 * 1024 * 1024;
const EXPORT_MAX_PAGE_SIZE = 10_000;

export interface ExportLimits {
    pageSize: number;
    maxRowsPerTable: number;
    maxTotalBytes: number;
}

export const EXPORT_DEFAULT_LIMITS: ExportLimits = {
    pageSize: EXPORT_PAGE_SIZE,
    maxRowsPerTable: EXPORT_MAX_ROWS_PER_TABLE,
    maxTotalBytes: EXPORT_MAX_TOTAL_BYTES,
};

export interface TenantExportDataAccess {
    query: <T = Record<string, unknown>>(sql: string, params?: unknown[]) => Promise<T[]>;
    queryOne: <T = Record<string, unknown>>(sql: string, params?: unknown[]) => Promise<T | null>;
    execute: (sql: string, params?: unknown[]) => Promise<{ insertId?: number; affectedRows?: number }>;
    /**
     * Optional serialized-transaction seam. When present, job state
     * transitions run inside it; without it each statement runs on the
     * caller's connection.
     */
    transaction?: <T>(fn: (tx: TenantExportDataAccess) => Promise<T>) => Promise<T>;
}

/** Injected object storage seam (production: S3/local adapter; tests: memory). */
export interface TenantExportStorage {
    write(key: string, body: string): Promise<void>;
    read(key: string): Promise<string>;
}

export interface TenantExportAuditInput {
    actorUserId: string | null;
    tenantId: string | null;
    action: string;
    resourceType: string;
    resourceId: string;
    oldValue?: unknown;
    newValue?: unknown;
    reason?: string;
}

export interface TenantExportDeps {
    db: TenantExportDataAccess;
    storage: TenantExportStorage;
    /** TENANT_EXPORT_SECRET; the surface fails closed (503) below 32 bytes. */
    secret: string | undefined;
    /**
     * Audit writer. The optional executor is the transaction-scoped access
     * object when a transaction seam is available, so the business write and
     * its audit row commit or roll back together.
     */
    audit: (input: TenantExportAuditInput, db?: TenantExportDataAccess) => Promise<void>;
    now?: () => number;
    newId?: () => string;
    /** Resource caps; defaults to EXPORT_DEFAULT_LIMITS. */
    limits?: Partial<ExportLimits>;
    /**
     * Cancellation seam. Checked before every page and every table; an aborted
     * run never writes a manifest and never records a success.
     */
    signal?: AbortSignal;
    /**
     * REQUIRED durable execution ownership.
     *
     * Without it the surface fails closed before any read, write or storage
     * side effect: a state change this module cannot prove it owns is a state
     * change it must not make. See `EXPORT_OWNERSHIP_OWNED_PREDICATE` for the
     * contract the port must declare and enforce.
     */
    ownership?: ExportOwnershipPort;
}

/**
 * Closed set of failure codes. The job `error` column and the audit payloads
 * only ever carry one of these, so a driver message (which embeds `sql`,
 * `sqlMessage` and the bound parameters) cannot reach storage or the log.
 */
export type ExportFailureCode =
    | 'aborted'
    | 'export_in_progress'
    | 'transaction-capability-absent'
    | 'ownership_capability_absent'
    | 'ownership_lost'
    | 'source_unavailable'
    | 'read_failed'
    | 'storage_write_failed'
    | 'audit_failed'
    | 'completion_conflict'
    | 'completion_unknown';

/** The caller cancelled the export; nothing further is read or written. */
export class ExportAbortedError extends Error {
    readonly code: ExportFailureCode = 'aborted';
    constructor() {
        super('The export was aborted before it completed');
    }
}

/** A second in-process attempt for the same export id is already running. */
export class ExportInProgressError extends Error {
    readonly code: ExportFailureCode = 'export_in_progress';
    constructor() {
        super('The export is already being processed');
    }
}

/**
 * The injected data access exposes no `transaction` seam.
 *
 * Completion and its audit must commit together; without a seam they cannot, and
 * an autocommit sequence that happens to look durable is not durable. The
 * surface therefore refuses to publish at all rather than advertising a
 * non-atomic completion.
 */
export class ExportTransactionCapabilityError extends Error {
    readonly code: ExportFailureCode = 'transaction-capability-absent';
    constructor() {
        super('The export data access provides no transaction seam');
    }
}

/**
 * The completion callback finished (status row written, audit written) but the
 * transaction wrapper itself threw, so the COMMIT outcome is unknown: the job
 * row is either still `pending` (rolled back) or already `completed` (committed).
 *
 * No compensation may run on this path. Any compensation that guesses the
 * outcome either demotes a row that actually committed — which can be another
 * attempt's completion — or overwrites a state this call never observed.
 */
export class ExportCompletionUnknownError extends Error {
    readonly code: ExportFailureCode = 'completion_unknown';
    constructor() {
        super('The export completion commit outcome is unknown');
    }
}

/**
 * No durable execution-ownership capability is injected, or the injected one
 * does not declare the fencing contract this module enforces.
 *
 * Durable ownership is what makes a state change exclusive across processes.
 * Without it, a `pending` row is not proof that this attempt owns it, and the
 * process-local single-flight set is not fencing — another process has no
 * knowledge of that Set. The surface therefore refuses to run rather than
 * performing state changes it cannot prove it owns.
 */
export class ExportOwnershipCapabilityError extends Error {
    readonly code: ExportFailureCode = 'ownership_capability_absent';
    constructor() {
        super('The export service has no durable execution ownership capability');
    }
}

/**
 * The row could not be claimed, or an owned transition matched zero rows: the
 * ownership this call believed it held is gone.
 *
 * This is NOT a terminal job state. The caller must not record that the job
 * failed, because another attempt may own the row and may be running right now.
 */
export class ExportOwnershipLostError extends Error {
    readonly code: ExportFailureCode = 'ownership_lost';
    constructor() {
        super('The export attempt does not hold the row');
    }
}

// ---------------------------------------------------------------------------
// Durable execution ownership (I2).
//
// Cross-process exclusive state changes need a fencing column pair in the
// database. This module cannot create it, so it declares the exact contract and
// requires an injected port that enforces it. The port is REQUIRED: without it
// the export surface fails closed before any read, write or storage side
// effect, because every state change it would make is unprovable.
// ---------------------------------------------------------------------------

/** Narrow statement executor handed to the port (never the whole access object). */
export type ExportStatementExecutor = (
    sql: string,
    params?: unknown[],
) => Promise<{ insertId?: number; affectedRows?: number }>;

/**
 * The canonical fencing predicate every owned transition must carry.
 *
 * Four terms, all evaluated by the database in the SAME statement that changes
 * the row:
 *
 *   `export_owner = ?`      — WHO may act. A server-generated identity, never a
 *                             client-supplied one.
 *   `owner_epoch = ?`       — WHICH claim. Fences a writer whose claim has since
 *                             been taken over and re-issued.
 *   `owner_lease_until_ms > ?` — WHETHER the claim is still live. A lease that
 *                             has expired is not ownership, even if the row
 *                             still carries the old owner string.
 *   `status = 'pending'`    — the intended state, re-checked at write time.
 *
 * `status = 'pending'` alone is NOT ownership: it is the state another attempt
 * is standing in. Owner without a live lease is not ownership either — it is a
 * stale claim. Both halves are required, and the lease term is what makes an
 * expired-then-reacquired row safe for the new claimant.
 */
export const EXPORT_OWNERSHIP_OWNED_PREDICATE =
    'export_owner = ? AND owner_epoch = ? AND owner_lease_until_ms > ? AND status = \'pending\'';

/** Columns the predicate requires. Missing schema ⇒ the port must refuse. */
export const EXPORT_OWNERSHIP_REQUIRED_COLUMNS: readonly string[] = [
    'export_owner',
    'owner_epoch',
    'owner_lease_until_ms',
];

/** How long a claim is held before another attempt may take the row. */
export const EXPORT_OWNERSHIP_LEASE_MS = 5 * 60 * 1000;

export interface ExportOwnershipClaimInput {
    exportId: string;
    tenantId: string;
    /** Server-generated owner identity; never derived from a request. */
    owner: string;
    nowMs: number;
    leaseMs: number;
    /** Absolute expiry the claim installs; derived from `nowMs + leaseMs`. */
    leaseUntilMs: number;
}

export interface ExportOwnershipGrant {
    /** Fencing epoch: every later owned transition must present it. */
    epoch: number;
    leaseUntilMs: number;
}

export interface ExportOwnershipFailureInput {
    exportId: string;
    tenantId: string;
    owner: string;
    epoch: number;
    /** Validated clock captured at the transition; the lease term uses it. */
    nowMs: number;
    code: ExportFailureCode;
}

export interface ExportOwnershipReleaseInput {
    exportId: string;
    tenantId: string;
    owner: string;
    epoch: number;
    /** Validated clock captured at the transition; the lease term uses it. */
    nowMs: number;
}

export interface ExportOwnershipContract {
    /** Must equal `EXPORT_OWNERSHIP_OWNED_PREDICATE`. */
    readonly ownedPredicate: string;
    /** Must contain every entry of `EXPORT_OWNERSHIP_REQUIRED_COLUMNS`. */
    readonly requiredColumns: readonly string[];
}

/**
 * The injected durable-ownership port.
 *
 * `claim` performs the real fencing statement and returns the grant, or `null`
 * when the row is not claimable. `failureStatement` and `releaseStatement` build
 * the fenced terminal transitions; the CALLER executes each inside a
 * transaction together with its audit and requires exactly one affected row,
 * which is what couples a terminal audit to a proven owned state change.
 */
export interface ExportOwnershipPort {
    describe(): ExportOwnershipContract;
    claim(
        executor: ExportOwnershipClaimExecutor,
        input: ExportOwnershipClaimInput,
    ): Promise<ExportOwnershipGrant | null>;
    failureStatement(input: ExportOwnershipFailureInput): { sql: string; params: unknown[] };
    releaseStatement(input: ExportOwnershipReleaseInput): { sql: string; params: unknown[] };
}

/** A table body or the manifest could not be written to the export storage. */
export class ExportStorageWriteError extends Error {
    readonly code: ExportFailureCode = 'storage_write_failed';
    constructor() {
        super('The export payload could not be written to storage');
    }
}

const abortIfRequested = (signal: AbortSignal | undefined): void => {
    if (signal?.aborted) throw new ExportAbortedError();
};

/**
 * Missing-relation and missing-column failures mean the export plan and the
 * live schema disagree, which is a configuration fault reported as a generic
 * "source unavailable" — never as an empty successful export.
 *
 * Lock conflicts (1205/1213) and duplicate keys (1062) are deliberately absent:
 * a lock wait is a transient contention signal and must not be reclassified as
 * a missing source.
 */
const SOURCE_UNAVAILABLE_CODES = new Set([
    'ER_NO_SUCH_TABLE',
    'ER_BAD_FIELD_ERROR',
    'ER_UNKNOWN_TABLE',
    'ER_BAD_DB_ERROR',
    'ER_TABLEACCESS_DENIED_ERROR',
]);
const SOURCE_UNAVAILABLE_ERRNOS = new Set([1049, 1054, 1109, 1142, 1146]);

export const classifyExportFailure = (error: unknown): ExportFailureCode => {
    if (error instanceof ExportAbortedError) return 'aborted';
    if (error instanceof ExportInProgressError) return 'export_in_progress';
    if (error instanceof ExportTransactionCapabilityError) return 'transaction-capability-absent';
    if (error instanceof ExportOwnershipCapabilityError) return 'ownership_capability_absent';
    if (error instanceof ExportOwnershipLostError) return 'ownership_lost';
    if (error instanceof ExportCompletionUnknownError) return 'completion_unknown';
    if (error instanceof ExportStorageWriteError) return 'storage_write_failed';
    if (error instanceof ExportStateConflictError) return 'completion_conflict';
    if (typeof error === 'object' && error !== null) {
        const code = (error as { code?: unknown }).code;
        if (typeof code === 'string' && SOURCE_UNAVAILABLE_CODES.has(code)) return 'source_unavailable';
        const errno = (error as { errno?: unknown }).errno;
        if (typeof errno === 'number' && SOURCE_UNAVAILABLE_ERRNOS.has(errno)) return 'source_unavailable';
    }
    return 'read_failed';
};

/**
 * A single-row CAS must report exactly one affected row. `undefined` is not
 * zero (it would drop a won transition) and is not one (it would fabricate a
 * won transition), so an unusable count throws instead of being coerced.
 */
const affectedRowsOf = (result: { affectedRows?: number }, operation: string): number => {
    const affected = result.affectedRows;
    if (typeof affected !== 'number' || !Number.isSafeInteger(affected) || affected < 0) {
        throw new Error(`The export ${operation} did not report a usable affected-row count`);
    }
    return affected;
};

// ---------------------------------------------------------------------------
// Ownership model: every statement proves ownership before a row is loaded.
// ---------------------------------------------------------------------------

/** The ownership classification the statement returns for each row. */
export const EXPORT_OWNERSHIP_OWNED = 'owned';
export const EXPORT_OWNERSHIP_CONTRADICTION = 'contradiction';
const OWNERSHIP_COLUMN = '__ownership';

export type ExportOwnershipBasis = 'direct' | 'parent';

export interface ExportOwnershipAuthority {
    /** Human-readable proof source, e.g. `courses.id = lectures.course_id`. */
    source: string;
    /**
     * SQL predicate that is true when this authority proves the row belongs to
     * the bound tenant. `null` makes the authority denial-only: it can reject a
     * row but never justify including one.
     */
    owns: string | null;
    /** SQL predicate that is true when this authority resolves elsewhere. */
    conflicts: string;
}

interface ExportPlanSpec {
    table: string;
    /** Explicit, alias-qualified column list (never SELECT *). */
    select: string;
    /** FROM clause aliasing the exported table as `t`. */
    from: string;
    authorities: readonly ExportOwnershipAuthority[];
    basis: ExportOwnershipBasis;
    parent: string | null;
}

export interface ExportTablePlan extends ExportPlanSpec {
    /**
     * The first-page statement. Later pages append the keyset predicate
     * (`AND t.id > ?`), so this exact string is what a single-page table runs.
     */
    sql: string;
}

const countPlaceholders = (fragment: string): number => fragment.split('?').length - 1;

const buildExportPageSql = (spec: ExportPlanSpec, withCursor: boolean): string => {
    const conflicts = spec.authorities.map((authority) => `(${authority.conflicts})`).join(' OR ');
    const owns = spec.authorities
        .filter((authority): authority is ExportOwnershipAuthority & { owns: string } => authority.owns !== null)
        .map((authority) => `(${authority.owns})`)
        .join(' OR ');
    return [
        `SELECT ${spec.select},`,
        `CASE WHEN ${conflicts} THEN '${EXPORT_OWNERSHIP_CONTRADICTION}' ELSE '${EXPORT_OWNERSHIP_OWNED}' END AS ${OWNERSHIP_COLUMN}`,
        `FROM ${spec.from}`,
        `WHERE (${owns})`,
        withCursor ? 'AND t.id > ?' : '',
        'ORDER BY t.id',
        'LIMIT ?',
    ].filter((part) => part !== '').join(' ');
};

/**
 * Parameters in the exact textual order of the placeholders: the CASE
 * classification first, then the WHERE ownership proof, then the keyset
 * cursor, then the page size. Every parameter except the cursor is the
 * export tenant, so a mis-ordered pin can never widen the scope.
 */
const exportPageParams = (
    spec: ExportPlanSpec,
    tenantId: string,
    cursor: string | null,
    pageSize: number,
): unknown[] => {
    const params: unknown[] = [];
    const pushTenantPins = (fragment: string): void => {
        for (let index = 0; index < countPlaceholders(fragment); index += 1) params.push(tenantId);
    };
    for (const authority of spec.authorities) pushTenantPins(authority.conflicts);
    for (const authority of spec.authorities) {
        if (authority.owns !== null) pushTenantPins(authority.owns);
    }
    if (cursor !== null) params.push(cursor);
    params.push(pageSize);
    return params;
};

const defineExportPlan = (spec: ExportPlanSpec): ExportTablePlan => {
    // A plan whose authorities are ALL denial-only would build `WHERE ()`,
    // which is a syntax error at run time — and, if it ever parsed, an empty
    // table presented as successfully exported. Refuse it where it is defined.
    if (!spec.authorities.some((authority) => authority.owns !== null)) {
        throw new Error(`The export plan for ${spec.table} declares no ownership proof`);
    }
    return {
        ...spec,
        sql: buildExportPageSql(spec, false),
    };
};

const directTenantAuthority = (alias = 't'): ExportOwnershipAuthority => ({
    source: `${alias}.tenant_id`,
    owns: `${alias}.tenant_id = ?`,
    conflicts: `${alias}.tenant_id <> ?`,
});

const parentTenantAuthority = (parentAlias: string, source: string): ExportOwnershipAuthority => ({
    source,
    owns: `${parentAlias}.tenant_id = ?`,
    conflicts: `${parentAlias}.tenant_id <> ?`,
});

/**
 * The completeness plan. Column lists are explicit (never SELECT *) so
 * credential material cannot creep in: students.password_hash is the only
 * secret column in scope and it is deliberately absent from its list.
 *
 * `t` is always the exported table. Parent joins are 1:1 on a primary key, so
 * they cannot duplicate rows; set-shaped authorities are expressed as EXISTS
 * subqueries for the same reason.
 */
export const EXPORT_TABLE_PLAN: readonly ExportTablePlan[] = [
    defineExportPlan({
        table: 'courses',
        select: 't.id, t.name, t.subject, t.description, t.grade, t.is_active, t.price, t.duration_months, t.thumbnail_url, t.tenant_id, t.instructor_id, t.created_at, t.updated_at',
        from: 'courses t',
        authorities: [directTenantAuthority()],
        basis: 'direct',
        parent: null,
    }),
    defineExportPlan({
        table: 'lectures',
        select: 't.id, t.course_id, t.grade_id, t.group_id, t.instructor_id, t.title, t.description, t.video_url, t.duration_minutes, t.price, t.display_order, t.is_free, t.is_published, t.archived_at, t.tenant_id, t.created_at, t.updated_at',
        from: 'lectures t LEFT JOIN courses pc ON pc.id = t.course_id LEFT JOIN `groups` pg ON pg.id = t.group_id',
        authorities: [
            directTenantAuthority(),
            parentTenantAuthority('pc', 'courses.id = lectures.course_id'),
            {
                // Denial-only: a lecture attached to another tenant's group is
                // ambiguous ownership, so it is rejected rather than assigned
                // to whichever authority happens to resolve first.
                source: 'groups.tenant_id = lectures.group_id',
                owns: null,
                conflicts: 'pg.tenant_id <> ?',
            },
        ],
        basis: 'parent',
        parent: 'courses.id = lectures.course_id',
    }),
    defineExportPlan({
        table: 'announcements',
        select: 't.id, t.tenant_id, t.branch_id, t.title, t.body, t.audience, t.status, t.created_by, t.published_at, t.retracted_at, t.version, t.created_at, t.updated_at',
        from: 'announcements t',
        authorities: [directTenantAuthority()],
        basis: 'direct',
        parent: null,
    }),
    defineExportPlan({
        table: 'schedules',
        select: 't.id, t.tenant_id, t.branch_id, t.group_id, t.title, t.audience, t.timezone, t.starts_at, t.ends_at, t.status, t.created_by, t.cancelled_at, t.version, t.created_at, t.updated_at',
        from: 'schedules t',
        authorities: [directTenantAuthority()],
        basis: 'direct',
        parent: null,
    }),
    defineExportPlan({
        table: 'groups',
        select: 't.id, t.name, t.description, t.course_id, t.grade_id, t.instructor_id, t.branch_id, t.branch_scope, t.max_students, t.current_students, t.schedule_days, t.schedule_time, t.is_active, t.tenant_id, t.created_at, t.updated_at',
        from: '`groups` t LEFT JOIN courses pc ON pc.id = t.course_id',
        authorities: [directTenantAuthority(), parentTenantAuthority('pc', 'courses.id = groups.course_id')],
        basis: 'parent',
        parent: 'courses.id = groups.course_id',
    }),
    defineExportPlan({
        table: 'branches',
        select: 't.id, t.tenant_id, t.name, t.status, t.version, t.created_at, t.updated_at',
        from: 'branches t',
        authorities: [directTenantAuthority()],
        basis: 'direct',
        parent: null,
    }),
    defineExportPlan({
        table: 'branch_memberships',
        select: 't.id, t.branch_id, t.user_id, t.role, t.status, t.version, t.created_at, t.updated_at',
        from: 'branch_memberships t INNER JOIN branches b ON b.id = t.branch_id',
        authorities: [parentTenantAuthority('b', 'branches.id = branch_memberships.branch_id')],
        basis: 'parent',
        parent: 'branches.id = branch_memberships.branch_id',
    }),
    defineExportPlan({
        table: 'grades',
        select: 't.id, t.name, t.display_order, t.is_active, t.tenant_id, t.created_at, t.updated_at',
        from: 'grades t',
        authorities: [directTenantAuthority()],
        basis: 'direct',
        parent: null,
    }),
    defineExportPlan({
        table: 'students',
        select: 't.id, t.name, t.email, t.phone, t.grade, t.grade_id, t.group_id, t.barcode, t.is_offline, t.approval_status, t.parent_phone, t.address, t.notes, t.is_active, t.term, t.user_id, t.tenant_id, t.instructor_id, t.enrollment_start_date, t.enrollment_end_date, t.enrollment_status, t.created_at, t.updated_at',
        from: 'students t',
        authorities: [directTenantAuthority()],
        basis: 'direct',
        parent: null,
    }),
    defineExportPlan({
        table: 'student_courses',
        select: 't.id, t.student_id, t.course_id, t.enrollment_date, t.status, t.progress',
        from: 'student_courses t INNER JOIN students s ON s.id = t.student_id',
        authorities: [parentTenantAuthority('s', 'students.id = student_courses.student_id')],
        basis: 'parent',
        parent: 'students.id = student_courses.student_id',
    }),
    defineExportPlan({
        table: 'course_materials',
        select: 't.id, t.course_id, t.title, t.description, t.material_type, t.file_url, t.file_size, t.duration_minutes, t.display_order, t.is_free, t.is_published, t.created_at, t.updated_at',
        from: 'course_materials t INNER JOIN courses c ON c.id = t.course_id',
        authorities: [parentTenantAuthority('c', 'courses.id = course_materials.course_id')],
        basis: 'parent',
        parent: 'courses.id = course_materials.course_id',
    }),
    defineExportPlan({
        table: 'exams',
        select: 't.id, t.title, t.description, t.course_id, t.duration_minutes, t.total_marks, t.passing_marks, t.exam_date, t.start_time, t.end_time, t.is_active, t.is_published, t.allow_review, t.shuffle_questions, t.tenant_id, t.created_at, t.updated_at',
        from: 'exams t LEFT JOIN courses pc ON pc.id = t.course_id',
        authorities: [
            directTenantAuthority(),
            parentTenantAuthority('pc', 'courses.id = exams.course_id'),
            {
                // Denial-only: an exam attached to a group that resolves to
                // another tenant is a contradiction between authorities.
                source: 'exam_groups -> groups -> courses',
                owns: null,
                conflicts: 'EXISTS (SELECT 1 FROM exam_groups eg INNER JOIN `groups` g ON g.id = eg.group_id LEFT JOIN courses gc ON gc.id = g.course_id WHERE eg.exam_id = t.id AND (gc.tenant_id <> ? OR g.tenant_id <> ?))',
            },
        ],
        basis: 'parent',
        parent: 'courses.id = exams.course_id',
    }),
    defineExportPlan({
        table: 'exam_questions',
        select: 't.id, t.exam_id, t.question_text, t.question_type, t.options, t.correct_answer, t.points, t.explanation, t.display_order, t.created_at, t.updated_at',
        from: 'exam_questions t INNER JOIN exams e ON e.id = t.exam_id LEFT JOIN courses pc ON pc.id = e.course_id',
        authorities: [
            { ...directTenantAuthority('e'), source: 'exams.tenant_id = exam_questions.exam_id' },
            parentTenantAuthority('pc', 'courses.id = exams.course_id'),
            {
                // The parent exam is rejected as a contradiction, so its
                // questions must be rejected with it instead of surviving on a
                // narrower authority.
                source: 'exam_groups -> groups -> courses (parent exam)',
                owns: null,
                conflicts: 'EXISTS (SELECT 1 FROM exam_groups eg INNER JOIN `groups` g ON g.id = eg.group_id LEFT JOIN courses gc ON gc.id = g.course_id WHERE eg.exam_id = e.id AND (gc.tenant_id <> ? OR g.tenant_id <> ?))',
            },
        ],
        basis: 'parent',
        parent: 'exams.id = exam_questions.exam_id -> courses.id = exams.course_id',
    }),
    defineExportPlan({
        table: 'question_bank_questions',
        select: 't.id, t.tenant_id, t.branch_id, t.branch_scope, t.question_type, t.question_text, t.options, t.correct_answers, t.points, t.explanation, t.tags, t.current_version, t.archived_at, t.created_by, t.created_at, t.updated_at, t.version',
        from: 'question_bank_questions t',
        authorities: [directTenantAuthority()],
        basis: 'direct',
        parent: null,
    }),
    defineExportPlan({
        table: 'question_bank_versions',
        select: 't.id, t.question_id, t.tenant_id, t.version, t.question_type, t.question_text, t.options, t.correct_answers, t.points, t.explanation, t.tags, t.created_by, t.created_at',
        from: 'question_bank_versions t',
        authorities: [directTenantAuthority()],
        basis: 'direct',
        parent: null,
    }),
    defineExportPlan({
        table: 'assignments',
        select: 't.id, t.tenant_id, t.branch_id, t.branch_scope, t.course_id, t.group_id, t.title, t.instructions, t.deadline_at, t.deadline_timezone, t.late_policy, t.resubmission_policy, t.max_submissions, t.max_file_bytes, t.allowed_file_types, t.status, t.archived_at, t.created_by, t.created_at, t.updated_at, t.version',
        from: 'assignments t',
        authorities: [directTenantAuthority()],
        basis: 'direct',
        parent: null,
    }),
    defineExportPlan({
        table: 'assignment_submissions',
        select: 't.id, t.tenant_id, t.assignment_id, t.student_enrollment_id, t.student_user_id, t.version, t.status, t.file_name, t.file_type, t.file_size_bytes, t.storage_key, t.scan_status, t.is_late, t.submitted_at, t.revoked_at, t.revoked_by, t.revoke_reason, t.created_at',
        from: 'assignment_submissions t',
        authorities: [directTenantAuthority()],
        basis: 'direct',
        parent: null,
    }),
];

/** Human-readable record of what the export never contains. */
export const EXPORT_EXCLUSIONS: readonly string[] = [
    'students.password_hash (credential material is never selected)',
    'users (platform identity rows carry no tenant scope and are never selected)',
    'platform secrets and configuration (API keys, HMAC secrets, env values)',
    'rows of other tenants (every statement pins the tenant in its ownership proof and contradiction check)',
    'a consistent point-in-time snapshot (each table is read in its own paged statement)',
];

/**
 * Why a tenant-scoped table is not exported. The category is the stable,
 * machine-checkable statement; the prose `reason` is human wording that may be
 * re-edited. `product_excluded` is the only category that records a product
 * decision rather than a pending one.
 */
export type ExportOmissionCategory =
    | 'credential_secret'
    | 'platform_finance'
    | 'operational_state'
    | 'product_excluded'
    | 'outside_plan'
    | 'budget_exhausted';

/**
 * Tenant-scoped tables in `server/migrations` that EXPORT_TABLE_PLAN does not
 * export, grouped by category. Each table is named exactly once across all
 * groups so `coverage.omitted` is a set, not a list; a table named twice would
 * double-count coverage.
 *
 * `outside_plan` means "not decided yet": adding such a table changes the
 * declared export scope and needs an explicit owner decision. `product_excluded`
 * is different — it records a decision that was already taken.
 */
const EXPORT_OMITTED_GROUPS: readonly {
    category: ExportOmissionCategory;
    reason: string;
    tables: readonly string[];
}[] = [
    {
        category: 'credential_secret',
        reason: 'credential and session secret material is never exported',
        tables: [
            'identity_otp_challenges',
            'impersonation_sessions',
            'parent_view_tokens',
            'student_enrollment_invites',
            'student_password_reset_requests',
            'tenant_invitations',
        ],
    },
    {
        category: 'platform_finance',
        reason: 'platform billing and finance: exporting these needs an explicit privacy decision, and this batch makes no financial-data change',
        tables: [
            'expenses',
            'instructor_topup_requests',
            'payment_requests',
            'platform_revenue_events',
            'revenues',
            'student_fees',
            'subscription_requests',
            'tenant_account_notes',
            'tenant_billing_profiles',
            'tenant_renewal_intents',
            'tenant_subscriptions',
        ],
    },
    {
        category: 'operational_state',
        reason: 'operational, telemetry and internal job state is not tenant content',
        tables: [
            'admin_work_items',
            'audit_events',
            'branch_audit_log',
            'imports',
            'playback_devices',
            'playback_entitlements',
            'playback_session_slots',
            'playback_tenant_policies',
            'student_import_batches',
            'tenant_data_exports',
            'video_asset_callbacks',
            'video_processing_queue',
            'video_usage_events',
        ],
    },
    {
        // A decision already taken, not a pending one: the owner excluded the
        // certificate feature (A8) from the product on 2026-10-19, so these
        // rows are not tenant content the export owes anyone. Source,
        // migrations and historical rows are retained, not deleted.
        category: 'product_excluded',
        reason: 'product-excluded by owner decision (2026-10-19): the certificate feature (A8) is outside the product, so certificate rows are not tenant content this export covers; the source, migrations and historical rows are retained, not deleted',
        tables: ['certificates'],
    },
    {
        category: 'outside_plan',
        reason: 'tenant content outside the approved plan: adding it changes the declared export scope and needs an explicit owner decision, so this batch neither adds it nor endorses its exclusion',
        tables: [
            'attendance_records',
            'exam_grading_runs',
            'exam_version_questions',
            'exam_versioned_answers',
            'exam_versioned_attempts',
            'exam_versions',
            'gradebook_policies',
            'gradebook_scores',
            'lesson_completions',
            'lesson_discussion_blocks',
            'lesson_discussion_replies',
            'lesson_discussion_reports',
            'lesson_discussion_threads',
            'lesson_release_policies',
            'moderation_appeals',
            'moderation_cases',
            'moderation_decision_history',
            'notification_consent_events',
            'notification_delivery_receipts',
            'notification_outbox',
            'parent_links',
            'playback_progress',
            'question_bank_version_usages',
            'schedule_series',
            'schedule_sessions',
            'student_enrollment_requests',
            'tenant_branding',
            'tenant_custom_domains',
            'tenant_media_files',
            'tenant_memberships',
            'video_assets',
            'videos',
        ],
    },
];

/**
 * Proven lower bounds for omitted tables. Each statement is pinned to the
 * export tenant through a column that cannot be NULL (a direct `tenant_id`, or
 * a parent chain whose terminal column is NOT NULL), so the count is evidence
 * of this tenant's own rows and never a global orphan count.
 */
interface ExportCountProbe {
    table: string;
    sql: string;
    evidence: string;
}

const EXPORT_OMITTED_PROBES: readonly ExportCountProbe[] = [
    {
        table: 'attendance_records',
        sql: 'SELECT COUNT(*) AS n FROM attendance_records WHERE tenant_id = ?',
        evidence: 'attendance_records.tenant_id IS NOT NULL',
    },
    {
        table: 'lesson_completions',
        sql: 'SELECT COUNT(*) AS n FROM lesson_completions WHERE tenant_id = ?',
        evidence: 'lesson_completions.tenant_id IS NOT NULL',
    },
    /*
     * W2-R — the declared school-data gaps now carry a proven lower bound
     * instead of only a reason. Each statement is pinned to a NOT NULL
     * `tenant_id` verified in `server/migrations`, so the count is this
     * tenant's own rows and never a global orphan count. The tables stay
     * omitted: exporting them changes the declared scope, which the existing
     * coverage assertions pin, so the plan extension is a separate owner
     * decision (see the delivery note) and is NOT silently applied here.
     */
    {
        table: 'gradebook_scores',
        sql: 'SELECT COUNT(*) AS n FROM gradebook_scores WHERE tenant_id = ?',
        evidence: 'gradebook_scores.tenant_id IS NOT NULL',
    },
    {
        table: 'playback_progress',
        sql: 'SELECT COUNT(*) AS n FROM playback_progress WHERE tenant_id = ?',
        evidence: 'playback_progress.tenant_id IS NOT NULL',
    },
    {
        table: 'video_assets',
        sql: 'SELECT COUNT(*) AS n FROM video_assets WHERE tenant_id = ?',
        evidence: 'video_assets.tenant_id IS NOT NULL',
    },
    {
        // `videos` has no tenant column of its own: ownership is proven through
        // the course it belongs to, exactly like the planned child probes.
        table: 'videos',
        sql: 'SELECT COUNT(*) AS n FROM videos v INNER JOIN courses c ON c.id = v.course_id WHERE c.tenant_id = ?',
        evidence: 'videos.course_id -> courses.tenant_id',
    },
    {
        table: 'parent_links',
        sql: 'SELECT COUNT(*) AS n FROM parent_links WHERE tenant_id = ?',
        evidence: 'parent_links.tenant_id IS NOT NULL',
    },
    {
        table: 'schedule_sessions',
        sql: 'SELECT COUNT(*) AS n FROM schedule_sessions WHERE tenant_id = ?',
        evidence: 'schedule_sessions.tenant_id IS NOT NULL',
    },
    {
        table: 'schedule_series',
        sql: 'SELECT COUNT(*) AS n FROM schedule_series WHERE tenant_id = ?',
        evidence: 'schedule_series.tenant_id IS NOT NULL',
    },
    {
        table: 'exam_versions',
        sql: 'SELECT COUNT(*) AS n FROM exam_versions WHERE tenant_id = ?',
        evidence: 'exam_versions.tenant_id IS NOT NULL',
    },
    {
        table: 'tenant_media_files',
        sql: 'SELECT COUNT(*) AS n FROM tenant_media_files WHERE tenant_id = ?',
        evidence: 'tenant_media_files.tenant_id IS NOT NULL',
    },
    {
        table: 'student_enrollment_requests',
        sql: 'SELECT COUNT(*) AS n FROM student_enrollment_requests WHERE tenant_id = ?',
        evidence: 'student_enrollment_requests.tenant_id IS NOT NULL',
    },
    {
        table: 'tenant_memberships',
        sql: 'SELECT COUNT(*) AS n FROM tenant_memberships WHERE tenant_id = ?',
        evidence: 'tenant_memberships.tenant_id IS NOT NULL',
    },
];

/**
 * Children of exported rows that the plan does not export at all. Their
 * ownership is proven through the planned parent, which is the only way to
 * show the omission is real without reading another tenant's rows.
 */
const EXPORT_OMITTED_CHILD_PROBES: readonly ExportCountProbe[] = [
    {
        table: 'exam_results',
        sql: 'SELECT COUNT(*) AS n FROM exam_results r INNER JOIN exams e ON e.id = r.exam_id INNER JOIN courses c ON c.id = e.course_id WHERE c.tenant_id = ?',
        evidence: 'exam_results.exam_id -> exams.course_id -> courses.tenant_id',
    },
    {
        table: 'group_courses',
        sql: 'SELECT COUNT(*) AS n FROM group_courses gc INNER JOIN `groups` g ON g.id = gc.group_id INNER JOIN courses c ON c.id = g.course_id WHERE c.tenant_id = ?',
        evidence: 'group_courses.group_id -> groups.course_id -> courses.tenant_id',
    },
    {
        table: 'student_materials',
        sql: 'SELECT COUNT(*) AS n FROM student_materials sm INNER JOIN course_materials m ON m.id = sm.material_id INNER JOIN courses c ON c.id = m.course_id WHERE c.tenant_id = ?',
        evidence: 'student_materials.material_id -> course_materials.course_id -> courses.tenant_id',
    },
];

// ---------------------------------------------------------------------------
// Checksums, JSONL, tokens.
// ---------------------------------------------------------------------------

export const sha256Hex = (value: string): string =>
    createHash('sha256').update(value, 'utf8').digest('hex');

export const jsonlOf = (rows: readonly Record<string, unknown>[]): string =>
    rows.length === 0 ? '' : `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`;

const b64url = (input: string): string => Buffer.from(input, 'utf8').toString('base64url');

const timingSafeStringEqual = (a: string, b: string): boolean => {
    const left = Buffer.from(a, 'utf8');
    const right = Buffer.from(b, 'utf8');
    return left.length === right.length && timingSafeEqual(left, right);
};

export interface ExportDownloadTokenPayload {
    v: 1;
    e: string;
    t: string;
    x: number;
}

export const signExportToken = (secret: string, payload: ExportDownloadTokenPayload): string => {
    const body = b64url(JSON.stringify(payload));
    const signature = createHmac('sha256', secret).update(body).digest('base64url');
    return `${body}.${signature}`;
};

const verifyExportTokenSignature = (secret: string, token: string): ExportDownloadTokenPayload | null => {
    const dot = token.indexOf('.');
    if (dot <= 0 || dot === token.length - 1) return null;
    const body = token.slice(0, dot);
    const signature = token.slice(dot + 1);
    if (signature.includes('.')) return null;
    let payload: Partial<ExportDownloadTokenPayload>;
    try {
        payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as Partial<ExportDownloadTokenPayload>;
    } catch {
        return null;
    }
    if (
        payload.v !== 1
        || typeof payload.e !== 'string' || payload.e.length === 0
        || typeof payload.t !== 'string' || payload.t.length === 0
        || typeof payload.x !== 'number' || !Number.isFinite(payload.x)
    ) {
        return null;
    }
    const expected = createHmac('sha256', secret).update(body).digest('base64url');
    if (!timingSafeStringEqual(expected, signature)) return null;
    return payload as ExportDownloadTokenPayload;
};

// ---------------------------------------------------------------------------
// Job rows + manifest.
// ---------------------------------------------------------------------------

export interface TenantExportJobRow {
    id: string;
    tenant_id: string;
    status: string;
    requested_by: string | null;
    storage_key: string | null;
    file_size: number | string | null;
    manifest: unknown;
    token_hash: string | null;
    expires_at: string | Date | null;
    error: string | null;
    created_at: string | Date;
    completed_at: string | Date | null;
}

export interface ExportTableManifest {
    table: string;
    rows: number;
    bytes: number;
    checksum: string;
}

/** Per-table coverage: how the rows were proven and whether they are whole. */
export interface ExportTableCoverage {
    table: string;
    rows: number;
    basis: ExportOwnershipBasis;
    parent: string | null;
    authorities: string[];
    /** Rows that claimed this tenant while another authority disagreed. */
    rejected_contradictions: number;
    /** True when a resource cap stopped the read before the table was exhausted. */
    truncated: boolean;
    pages: number;
}

export interface ExportOmittedTable {
    table: string;
    /** Stable classification of the omission; `reason` is the human wording. */
    category: ExportOmissionCategory;
    reason: string;
    /** Proven lower bound of this tenant's rows; null when no proof exists. */
    provable_rows: number | null;
    evidence: string | null;
}

export interface ExportOmittedChild {
    table: string;
    evidence: string;
    provable_rows: number | null;
}

export interface ExportCoverage {
    scope: string;
    included: ExportTableCoverage[];
    omitted: ExportOmittedTable[];
    omitted_children: ExportOmittedChild[];
    rejected: Array<{ table: string; rows: number; reason: string }>;
    limitations: string[];
    /**
     * Always false. It does not mean the export is broken: the plan is a
     * declared subset of tenant-scoped tables, no consistent point-in-time
     * snapshot is taken, and rows whose ownership cannot be proven are
     * withheld. Nothing in this manifest can make it a full copy of the tenant.
     */
    complete: boolean;
    /**
     * True only when a gap was detected inside the declared plan (a cap
     * truncated a table, a table was skipped for budget, or a row was rejected
     * as a contradiction). False means no such gap was detected in the planned
     * tables; it does not mean the extract is a complete copy — `complete`
     * stays false either way.
     */
    incomplete: boolean;
}

export interface ExportManifest {
    version: number;
    tenant_id: string;
    started_at: string;
    completed_at: string;
    tables: ExportTableManifest[];
    total_rows: number;
    total_bytes: number;
    excluded: string[];
    coverage: ExportCoverage;
    /** Mirrors `coverage.incomplete`; see there for what it does not mean. */
    incomplete: boolean;
}

const EXPORT_COVERAGE_SCOPE =
    'EXPORT_TABLE_PLAN: a declared subset of tenant-scoped tables, read table by table without a consistent snapshot';

const EXPORT_COVERAGE_LIMITATIONS: readonly string[] = [
    'rows whose ownership cannot be proven from the plan parent chain are excluded and are not counted: an unattributable row is not evidence of this tenant, and a count could describe another institution',
    'root rows with a NULL tenant_id (courses, grades, students) cannot be attributed and are excluded without a count',
    'grades.tenant_id NULL means a shared legacy catalog row, which is not tenant-owned and is excluded',
    'each table is read in its own paged statement, so the extract is not a consistent point-in-time snapshot',
    'stale pending jobs are never reclaimed on age alone: tenant_data_exports has no owner/fencing column, so reclaiming would race a live worker and needs a schema change (I2)',
    // Spreadsheet safety: the payload is JSONL and no stored value is rewritten.
    // Rewriting a leading "=" or "+" would falsify the data the owner asked to
    // export, so the control is a documented consumer obligation, not a silent
    // mutation. JSON itself is not a formula context; a CSV conversion is.
    'the payload is JSONL, never CSV, and no cell is rewritten: a spreadsheet consumer must itself neutralise values beginning with =, +, -, @, TAB or CR (rewriting stored values would falsify the export)',
    // PII: named so the consumer knows the extract is personal data, and so the
    // access rule is part of the artifact rather than only of the code.
    'students rows contain personal data (name, email, phone, parent_phone, address, notes); the export is limited to the verified tenant owner or a platform actor holding tenant_export.request, and every download is audited',
];

const asTime = (value: string | Date | null | undefined): number => {
    if (!value) return 0;
    const parsed = new Date(value).getTime();
    return Number.isFinite(parsed) ? parsed : 0;
};

const secretConfigured = (secret: string | undefined): secret is string =>
    typeof secret === 'string' && secret.length >= EXPORT_SECRET_MIN_BYTES;

/**
 * Runs `fn` inside the injected transaction.
 *
 * The seam is REQUIRED, not optional. Every guarded transition in this module
 * publishes a row and its audit together, and only a real transaction makes
 * that atomic. An earlier revision fell back to statement-per-call autocommit
 * and then tried to compensate with extra UPDATEs; that fallback is what made
 * a compensation able to demote a row it did not own. There is no fallback any
 * more: a caller without the seam gets `ExportTransactionCapabilityError`
 * before anything is written.
 */
const inTransaction = async <T>(
    db: TenantExportDataAccess,
    fn: (tx: TenantExportDataAccess) => Promise<T>,
): Promise<T> => {
    if (typeof db.transaction !== 'function') throw new ExportTransactionCapabilityError();
    return db.transaction(fn);
};

/** A guarded transition found the row in an unexpected state (not an outage). */
class ExportStateConflictError extends Error {}

/** MySQL duplicate-key (1062) surfaces as ER_DUP_ENTRY on the driver error. */
const isDuplicateKeyError = (error: unknown): boolean => {
    if (typeof error !== 'object' || error === null) return false;
    if ((error as { code?: unknown }).code === 'ER_DUP_ENTRY') return true;
    return (error as { errno?: unknown }).errno === 1062;
};

// ---------------------------------------------------------------------------
// Request (fail closed on secret, transaction seam, durable ownership, one
// active per tenant, cooldown).
// ---------------------------------------------------------------------------

export type ExportRequestResult =
    | { ok: true; job: { id: string; tenantId: string; status: string; createdAt: string } }
    | { ok: false; status: number; error: string };

export const requestTenantExport = async (
    deps: TenantExportDeps,
    input: { tenantId: string; actorUserId: string; reason?: string },
): Promise<ExportRequestResult> => {
    if (!secretConfigured(deps.secret)) {
        await deps.audit({
            actorUserId: input.actorUserId,
            tenantId: input.tenantId,
            action: 'tenant_export.request_denied',
            resourceType: 'tenant_data_exports',
            resourceId: '*',
            newValue: { tenant_id: input.tenantId },
            reason: 'The tenant export service is not configured',
        });
        return { ok: false, status: 503, error: 'The tenant export service is not configured' };
    }
    if (typeof deps.db.transaction !== 'function') {
        // Refused BEFORE a job exists. A pending row that cannot be completed
        // atomically would sit behind the one-active rule with no way to settle
        // it, so the request never starts rather than being abandoned mid-way.
        await deps.audit({
            actorUserId: input.actorUserId,
            tenantId: input.tenantId,
            action: 'tenant_export.request_denied',
            resourceType: 'tenant_data_exports',
            resourceId: '*',
            newValue: { tenant_id: input.tenantId },
            reason: 'The export data access provides no transaction seam',
        });
        return { ok: false, status: 503, error: 'The tenant export service is not configured' };
    }
    // Durable execution ownership is required BEFORE job creation. A pending row
    // that no attempt can provably own is a row any failing attempt could
    // settle, which is precisely the race this capability exists to close.
    try {
        requireOwnershipCapability(deps);
    } catch {
        await deps.audit({
            actorUserId: input.actorUserId,
            tenantId: input.tenantId,
            action: 'tenant_export.request_denied',
            resourceType: 'tenant_data_exports',
            resourceId: '*',
            newValue: { tenant_id: input.tenantId },
            reason: 'The export service has no durable execution ownership capability',
        });
        return { ok: false, status: 503, error: 'The tenant export service is not configured' };
    }
    const now = deps.now ?? Date.now;
    const active = await deps.db.queryOne<{ id: string; status: string }>(
        `SELECT id, status FROM tenant_data_exports
         WHERE tenant_id = ? AND status = 'pending' LIMIT 1`,
        [input.tenantId],
    );
    if (active) {
        // A pending row is honoured, never stolen on age: there is no fencing
        // column, so reclaiming it could race a worker that is still alive.
        return { ok: false, status: 409, error: 'An export for this tenant is already in progress' };
    }
    const lastCompleted = await deps.db.queryOne<{ created_at: string | Date; completed_at: string | Date | null }>(
        `SELECT created_at, completed_at FROM tenant_data_exports
         WHERE tenant_id = ? AND status = 'completed'
         ORDER BY completed_at DESC, created_at DESC LIMIT 1`,
        [input.tenantId],
    );
    if (lastCompleted) {
        // The cooldown measures from when the export SETTLED, not from when it
        // was requested: a long export could otherwise be older than the window
        // at the moment it finishes, letting the next request start immediately
        // after a completion. `created_at` remains the fallback for rows
        // completed before `completed_at` was populated.
        const settledAt = asTime(lastCompleted.completed_at) || asTime(lastCompleted.created_at);
        if (settledAt > 0 && now() - settledAt < EXPORT_COOLDOWN_SECONDS * 1000) {
            return { ok: false, status: 409, error: 'An export for this tenant was completed recently; the cooldown window applies' };
        }
    }
    const id = deps.newId?.() ?? randomUUID();
    try {
        await inTransaction(deps.db, async (db) => {
            await db.execute(
                `INSERT INTO tenant_data_exports (id, tenant_id, status, requested_by)
                 VALUES (?, ?, 'pending', ?)`,
                [id, input.tenantId, input.actorUserId],
            );
            await deps.audit({
                actorUserId: input.actorUserId,
                tenantId: input.tenantId,
                action: 'tenant_export.requested',
                resourceType: 'tenant_data_exports',
                resourceId: id,
                newValue: { tenant_id: input.tenantId },
                reason: input.reason ?? 'Tenant data export requested',
            }, db);
        });
    } catch (error) {
        if (isDuplicateKeyError(error)) {
            // A concurrent request won the UNIQUE(active_tenant_lock) race.
            return { ok: false, status: 409, error: 'An export for this tenant is already in progress' };
        }
        // Any other failure rolls the whole insert back, so no pending row and
        // no unaudited job survive. There is deliberately no compensating
        // UPDATE here: a compensation cannot tell its own uncommitted row from
        // another attempt's, and the transaction seam is already guaranteed by
        // the capability check above.
        throw error;
    }
    return { ok: true, job: { id, tenantId: input.tenantId, status: 'pending', createdAt: new Date(now()).toISOString() } };
};

// ---------------------------------------------------------------------------
// Processing: paged tenant-proven reads, checksums, storage writes, coverage.
// ---------------------------------------------------------------------------

const resolveLimits = (overrides: Partial<ExportLimits> | undefined): ExportLimits => {
    const limits: ExportLimits = { ...EXPORT_DEFAULT_LIMITS, ...overrides };
    if (!Number.isInteger(limits.pageSize) || limits.pageSize < 1 || limits.pageSize > EXPORT_MAX_PAGE_SIZE) {
        throw new Error(`The export page size must be an integer between 1 and ${EXPORT_MAX_PAGE_SIZE}`);
    }
    if (!Number.isInteger(limits.maxRowsPerTable) || limits.maxRowsPerTable < 1) {
        throw new Error('The export row cap must be a positive integer');
    }
    if (!Number.isInteger(limits.maxTotalBytes) || limits.maxTotalBytes < 1) {
        throw new Error('The export byte cap must be a positive integer');
    }
    return limits;
};

interface ExportTableRead {
    body: string;
    /** Rows actually written into `body` — never rows that were only fetched. */
    rows: number;
    rejected: number;
    /** What stopped the read: the row cap, the byte budget, or nothing. */
    truncatedBy: 'rows' | 'bytes' | null;
    pages: number;
}

/**
 * Reads one table page by page. The JSONL body is assembled per page and the
 * byte budget is checked before each page is appended, so neither the table
 * nor the export is ever materialised unbounded.
 *
 * Row accounting: a page that does not fit the remaining budget is inspected
 * but NOT written, and its rows are not counted. Counting them would make the
 * manifest claim rows the payload does not contain, while `bytes` and
 * `checksum` describe the shorter body — a self-contradicting manifest.
 */
const readExportTable = async (
    db: TenantExportDataAccess,
    plan: ExportTablePlan,
    tenantId: string,
    limits: ExportLimits,
    budget: { remainingBytes: number },
    signal: AbortSignal | undefined,
): Promise<ExportTableRead> => {
    let cursor: string | null = null;
    let body = '';
    let rows = 0;
    let rejected = 0;
    let truncatedBy: 'rows' | 'bytes' | null = null;
    let pages = 0;
    let scanned = 0;
    for (;;) {
        abortIfRequested(signal);
        const sql: string = cursor === null ? plan.sql : buildExportPageSql(plan, true);
        const fetched: Array<Record<string, unknown>> = await db.query<Record<string, unknown>>(
            sql,
            exportPageParams(plan, tenantId, cursor, limits.pageSize),
        );
        pages += 1;
        const allowance = limits.maxRowsPerTable - scanned;
        const capped = fetched.length > allowance;
        const page = capped ? fetched.slice(0, Math.max(allowance, 0)) : fetched;
        scanned += page.length;
        const lines: string[] = [];
        let pageRejected = 0;
        for (const row of page) {
            const ownership = row[OWNERSHIP_COLUMN];
            if (ownership === EXPORT_OWNERSHIP_CONTRADICTION) {
                pageRejected += 1;
                continue;
            }
            if (ownership !== EXPORT_OWNERSHIP_OWNED) {
                // Fail closed: a row the statement did not classify cannot be
                // silently exported, and cannot be silently dropped either.
                throw new Error(`The export read returned an unclassified row for ${plan.table}`);
            }
            const { [OWNERSHIP_COLUMN]: _classification, ...record } = row;
            lines.push(JSON.stringify(record));
        }
        // Inspected contradictions are a fact about the read even when the page
        // itself is dropped, so they are always reported.
        rejected += pageRejected;
        if (lines.length > 0) {
            const chunk = `${lines.join('\n')}\n`;
            const chunkBytes = Buffer.byteLength(chunk, 'utf8');
            if (chunkBytes > budget.remainingBytes) {
                truncatedBy = 'bytes';
                break;
            }
            budget.remainingBytes -= chunkBytes;
            body += chunk;
            rows += lines.length;
        }
        if (capped) {
            truncatedBy = 'rows';
            break;
        }
        if (fetched.length < limits.pageSize) break;
        const last: Record<string, unknown> | undefined = fetched[fetched.length - 1];
        const lastId: unknown = last?.id;
        if (typeof lastId !== 'string' || lastId.length === 0) {
            throw new Error(`The export read cannot page ${plan.table}: the row has no string id`);
        }
        cursor = lastId;
    }
    return { body, rows, rejected, truncatedBy, pages };
};

const countProbe = async (
    db: TenantExportDataAccess,
    probe: ExportCountProbe,
    tenantId: string,
): Promise<{ provableRows: number | null; failure: string | null }> => {
    try {
        const rows = await db.query<{ n: number | string }>(probe.sql, [tenantId]);
        const value = rows[0]?.n;
        if (value === undefined || value === null) return { provableRows: null, failure: null };
        const parsed = Number(value);
        return Number.isFinite(parsed) && parsed >= 0
            ? { provableRows: parsed, failure: null }
            : { provableRows: null, failure: `unexpected count for ${probe.table}` };
    } catch (error) {
        // The omission is declared either way; a failed probe only removes the
        // lower bound, and that is recorded rather than swallowed. The reason
        // is a closed code, not the driver message: `coverage.limitations` is
        // persisted in the manifest and served to the caller.
        return { provableRows: null, failure: `${probe.table}: count probe failed (${classifyExportFailure(error)})` };
    }
};

/**
 * Merge the omission groups into one classification, enforcing the two
 * invariants the manifest depends on:
 *
 *  - every omitted table is classified exactly once (a table named in two
 *    groups would double-count coverage, and one named twice inside a group
 *    would appear twice in `coverage.omitted`);
 *  - every count probe belongs to a classified table (a probe for an
 *    unclassified table would be executed and then silently dropped, so the
 *    manifest would lose a lower bound the plan already paid to compute).
 *
 * Both are static-constant errors, so this is a pure check with no I/O; it runs
 * when coverage is built rather than at import, keeping construction inert.
 */
const classifyOmittedTables = (): Map<string, { category: ExportOmissionCategory; reason: string }> => {
    const classified = new Map<string, { category: ExportOmissionCategory; reason: string }>();
    for (const group of EXPORT_OMITTED_GROUPS) {
        for (const table of group.tables) {
            if (classified.has(table)) {
                throw new Error(`The export omission table ${table} is classified more than once`);
            }
            classified.set(table, { category: group.category, reason: group.reason });
        }
    }
    for (const probe of EXPORT_OMITTED_PROBES) {
        if (!classified.has(probe.table)) {
            throw new Error(`The export omission probe ${probe.table} has no classification`);
        }
    }
    return classified;
};

const buildOmittedCoverage = async (
    db: TenantExportDataAccess,
    tenantId: string,
    signal: AbortSignal | undefined,
): Promise<{ omitted: ExportOmittedTable[]; omittedChildren: ExportOmittedChild[]; probeFailures: string[] }> => {
    const classified = classifyOmittedTables();
    const probeFailures: string[] = [];
    const probed = new Map<string, { provableRows: number | null; evidence: string }>();
    for (const probe of EXPORT_OMITTED_PROBES) {
        // The probe loops are bounded work but they are still work: a cancelled
        // export stops issuing statements instead of finishing every probe.
        abortIfRequested(signal);
        const result = await countProbe(db, probe, tenantId);
        if (result.failure !== null) probeFailures.push(result.failure);
        probed.set(probe.table, { provableRows: result.provableRows, evidence: probe.evidence });
    }
    const omitted: ExportOmittedTable[] = [];
    for (const [table, meta] of classified) {
        const proof = probed.get(table);
        omitted.push({
            table,
            category: meta.category,
            reason: meta.reason,
            provable_rows: proof?.provableRows ?? null,
            evidence: proof?.evidence ?? null,
        });
    }
    const omittedChildren: ExportOmittedChild[] = [];
    for (const probe of EXPORT_OMITTED_CHILD_PROBES) {
        abortIfRequested(signal);
        const result = await countProbe(db, probe, tenantId);
        if (result.failure !== null) probeFailures.push(result.failure);
        omittedChildren.push({
            table: probe.table,
            evidence: probe.evidence,
            provable_rows: result.provableRows,
        });
    }
    return { omitted, omittedChildren, probeFailures };
};

/** Export ids with an attempt running in THIS process. */
const IN_FLIGHT_EXPORTS = new Set<string>();

/**
 * Local concurrency guard only.
 *
 * It prevents two callers inside one process from doing the same work twice. It
 * is NOT fencing and must never be read as one: another process has no
 * knowledge of this Set, so cross-process exclusivity is a schema question (the
 * I2 contract), not a source question. Nothing downstream may treat this as
 * proof of ownership — in particular it must never be used to justify a state
 * change on the job row.
 */
const claimLocalAttempt = (exportId: string): void => {
    if (IN_FLIGHT_EXPORTS.has(exportId)) throw new ExportInProgressError();
    IN_FLIGHT_EXPORTS.add(exportId);
};

/**
 * A validated clock reading.
 *
 * A transition captures its own `now` ONCE, before any statement runs, and the
 * lease term uses that same value. Capturing it per statement would let two
 * statements in one transition disagree about whether the lease is live, and a
 * coerced or invalid clock (`NaN`, a non-finite number) must never silently
 * become "the lease is still valid".
 */
const captureTransitionClock = (now: () => number): number => {
    const reading = now();
    if (typeof reading !== 'number' || !Number.isFinite(reading) || !Number.isSafeInteger(reading)) {
        throw new ExportTransactionCapabilityError();
    }
    return reading;
};

/**
 * Require the durable-ownership capability and require it to DECLARE the
 * fencing contract.
 *
 * Three things are checked, in order: the port object exists; it exposes the
 * four operations this module calls; and `describe()` returns exactly the
 * canonical predicate and every required column.
 *
 * This is a CONTRACT CHECK, not proof of enforcement. A port can declare the
 * right strings and still run something else, and this function cannot see the
 * statements it will execute. What it does establish is that a placeholder with
 * nothing true to declare cannot pass, and that the production adapter below is
 * the one concrete, reviewable implementation — the port exists so a deployment
 * can substitute its own fencing columns without editing this file.
 */
const requireOwnershipCapability = (deps: TenantExportDeps): ExportOwnershipPort => {
    const port: unknown = deps.ownership;
    if (typeof port !== 'object' || port === null) throw new ExportOwnershipCapabilityError();
    const candidate = port as Partial<ExportOwnershipPort>;
    if (
        typeof candidate.claim !== 'function'
        || typeof candidate.failureStatement !== 'function'
        || typeof candidate.releaseStatement !== 'function'
        || typeof candidate.describe !== 'function'
    ) {
        throw new ExportOwnershipCapabilityError();
    }
    let contract: ExportOwnershipContract;
    try {
        contract = candidate.describe();
    } catch {
        throw new ExportOwnershipCapabilityError();
    }
    if (contract.ownedPredicate !== EXPORT_OWNERSHIP_OWNED_PREDICATE) {
        throw new ExportOwnershipCapabilityError();
    }
    for (const column of EXPORT_OWNERSHIP_REQUIRED_COLUMNS) {
        if (!Array.isArray(contract.requiredColumns) || !contract.requiredColumns.includes(column)) {
            throw new ExportOwnershipCapabilityError();
        }
    }
    return port as ExportOwnershipPort;
};

/**
 * Validate a claim result strictly. A grant this module cannot read is not a
 * grant: an epoch that is not a positive safe integer, or a lease that has
 * already expired, means the port did not fence anything.
 */
const validateOwnershipGrant = (
    grant: ExportOwnershipGrant | null,
    nowMs: number,
): ExportOwnershipGrant | null => {
    if (grant === null) return null;
    if (typeof grant !== 'object') throw new ExportOwnershipCapabilityError();
    const epoch = (grant as { epoch?: unknown }).epoch;
    const leaseUntilMs = (grant as { leaseUntilMs?: unknown }).leaseUntilMs;
    if (typeof epoch !== 'number' || !Number.isSafeInteger(epoch) || epoch < 1) {
        throw new ExportOwnershipCapabilityError();
    }
    if (typeof leaseUntilMs !== 'number' || !Number.isSafeInteger(leaseUntilMs) || leaseUntilMs <= nowMs) {
        throw new ExportOwnershipCapabilityError();
    }
    return { epoch, leaseUntilMs };
};

// ---------------------------------------------------------------------------
// The concrete in-file SQL adapter.
//
// This is the reviewable implementation behind the port contract. Its SQL is
// fixed text with bound parameters only — no identifier, no operator and no
// predicate is assembled from caller input — and every statement carries the
// full four-term fence. It is NOT executed by this module: the port is injected,
// and a deployment wires it against the real schema. When the schema is absent
// the claim statement finds no columns and the port refuses, which keeps the
// surface unconfigured rather than activating a placeholder.
// ---------------------------------------------------------------------------

/** The claim: takes the row only when unowned or its lease has lapsed. */
const OWNERSHIP_CLAIM_SQL = `
    UPDATE tenant_data_exports
    SET export_owner = ?, owner_epoch = owner_epoch + 1, owner_lease_until_ms = ?
    WHERE id = ? AND tenant_id = ? AND status = 'pending'
      AND (export_owner IS NULL OR owner_lease_until_ms <= ?)
`;

/** Terminal failure, fenced by owner + epoch + live lease + intended state. */
const OWNERSHIP_FAILURE_SQL = `
    UPDATE tenant_data_exports
    SET status = 'failed', error = ?
    WHERE id = ? AND tenant_id = ? AND export_owner = ? AND owner_epoch = ?
      AND owner_lease_until_ms > ? AND status = 'pending'
`;

/** Terminal abort, fenced identically to the failure transition. */
const OWNERSHIP_ABORT_SQL = `
    UPDATE tenant_data_exports
    SET status = 'failed', error = ?
    WHERE id = ? AND tenant_id = ? AND export_owner = ? AND owner_epoch = ?
      AND owner_lease_until_ms > ? AND status = 'pending'
`;

/**
 * Release: hands the row back to `pending` and clears the claim, so a later
 * attempt can take it. Fenced identically — a release is an ownership-sensitive
 * mutation like any other terminal transition.
 */
const OWNERSHIP_RELEASE_SQL = `
    UPDATE tenant_data_exports
    SET export_owner = NULL, owner_lease_until_ms = NULL, error = NULL
    WHERE id = ? AND tenant_id = ? AND export_owner = ? AND owner_epoch = ?
      AND owner_lease_until_ms > ? AND status = 'pending'
`;

/**
 * The claim's epoch read-back.
 *
 * A claim statement that increments `owner_epoch` must report the value it
 * installed, and the value must come back on a seam the caller actually
 * provides. The claim executor is widened to `query` for exactly this one
 * read, inside the same transaction as the claim: the row is still fenced by
 * owner, live lease and `status='pending'`, so the read cannot observe another
 * attempt's row. An epoch this adapter cannot read is a malformed grant, and a
 * malformed grant is a refusal — never a guessed `1`.
 */
const OWNERSHIP_READ_EPOCH_SQL = `
    SELECT owner_epoch FROM tenant_data_exports
    WHERE id = ? AND tenant_id = ? AND export_owner = ? AND status = 'pending'
      AND owner_lease_until_ms > ?
`;

/** Claim executor: the statement seam plus the one read-back it must support. */
export interface ExportOwnershipClaimExecutor extends ExportStatementExecutor {
    query?: <T = Record<string, unknown>>(sql: string, params?: unknown[]) => Promise<T[]>;
}

/**
 * Build the concrete port over an injected executor.
 *
 * The executor is the only thing this adapter touches: it is handed the
 * transaction-scoped access object by the caller, so every statement runs
 * inside the caller's transaction. No pool, no import-time query, no direct
 * `db` import — the adapter cannot reach the database except through the seam
 * it was given.
 */
export const createSqlExportOwnershipPort = (
    executor: ExportOwnershipClaimExecutor,
): ExportOwnershipPort => {
    const describe = (): ExportOwnershipContract => ({
        ownedPredicate: EXPORT_OWNERSHIP_OWNED_PREDICATE,
        requiredColumns: [...EXPORT_OWNERSHIP_REQUIRED_COLUMNS],
    });
    return {
        describe,
        claim: async (run, input) => {
            const claimRun = (run ?? executor) as ExportOwnershipClaimExecutor;
            const updated = await claimRun(OWNERSHIP_CLAIM_SQL, [
                input.owner,
                input.leaseUntilMs,
                input.exportId,
                input.tenantId,
                input.nowMs,
            ]);
            if (affectedRowsOf(updated, 'ownership claim') !== 1) return null;
            if (typeof claimRun.query !== 'function') {
                // Without the read-back seam the epoch is unknowable, and an
                // unknowable epoch cannot fence anything.
                throw new ExportOwnershipCapabilityError();
            }
            const rows = await claimRun.query<{ owner_epoch: unknown }>(OWNERSHIP_READ_EPOCH_SQL, [
                input.exportId,
                input.tenantId,
                input.owner,
                input.nowMs,
            ]);
            const epoch = Array.isArray(rows) ? rows[0]?.owner_epoch : undefined;
            if (typeof epoch !== 'number' || !Number.isSafeInteger(epoch) || epoch < 1) {
                throw new ExportOwnershipCapabilityError();
            }
            return { epoch, leaseUntilMs: input.leaseUntilMs };
        },
        failureStatement: (input) => ({
            sql: input.code === 'aborted' ? OWNERSHIP_ABORT_SQL : OWNERSHIP_FAILURE_SQL,
            params: [
                input.code,
                input.exportId,
                input.tenantId,
                input.owner,
                input.epoch,
                input.nowMs,
            ],
        }),
        releaseStatement: (input) => ({
            sql: OWNERSHIP_RELEASE_SQL,
            params: [
                input.exportId,
                input.tenantId,
                input.owner,
                input.epoch,
                input.nowMs,
            ],
        }),
    };
};

type OwnedFailureOutcome =
    | 'recorded'
    | 'ownership_lost'
    | 'audit_rolled_back'
    | 'commit_unknown';

/**
 * Record the terminal failed/aborted state under PROVEN ownership.
 *
 * The row write and its terminal audit are one transaction, and the write must
 * move exactly one row under the fenced predicate. Anything else leaves the
 * job's state unknown to this call, and this call then asserts nothing about
 * it — no terminal audit, and no later compensation.
 *
 * The four outcomes are deliberately distinct, because they mean different
 * things and only one of them is a claim about the job:
 *
 *   `recorded`          — the fenced write moved exactly one row AND the audit
 *                         committed. The terminal `failed`/`aborted` audit is
 *                         already committed inside this transaction.
 *   `ownership_lost`    — the fenced write moved zero rows. This attempt does
 *                         not hold the row; another attempt may.
 *   `audit_rolled_back` — the write moved one row, the audit threw, the whole
 *                         transaction rolled back. The row is back to `pending`
 *                         and still owned by this attempt.
 *   `commit_unknown`    — the callback finished (write + audit both returned)
 *                         and the wrapper then threw. The COMMIT outcome is
 *                         unknowable, so this is NOT `uncommitted` and NOT
 *                         `recorded`: the terminal audit may or may not exist.
 *
 * The original error always stays primary: a failure to record a failure never
 * replaces the failure that caused it.
 */
const recordOwnedFailure = async (
    deps: TenantExportDeps,
    ownership: ExportOwnershipPort,
    input: {
        exportId: string;
        tenantId: string;
        owner: string;
        epoch: number;
        nowMs: number;
        code: ExportFailureCode;
    },
): Promise<OwnedFailureOutcome> => {
    let statusWritten = false;
    let callbackFinished = false;
    try {
        await inTransaction(deps.db, async (tx) => {
            const statement = ownership.failureStatement({
                exportId: input.exportId,
                tenantId: input.tenantId,
                owner: input.owner,
                epoch: input.epoch,
                nowMs: input.nowMs,
                code: input.code,
            });
            const updated = await tx.execute(statement.sql, statement.params);
            // Exactly one row must move. Zero means the ownership this call
            // believed it held is gone; more than one means the predicate is
            // not selective and must not be trusted at all.
            if (affectedRowsOf(updated, 'owned failure transition') !== 1) {
                throw new ExportOwnershipLostError();
            }
            statusWritten = true;
            await deps.audit({
                actorUserId: null,
                tenantId: input.tenantId,
                action: input.code === 'aborted' ? 'tenant_export.aborted' : 'tenant_export.failed',
                resourceType: 'tenant_data_exports',
                resourceId: input.exportId,
                newValue: { code: input.code },
                reason: input.code === 'aborted' ? 'Tenant data export aborted' : 'Tenant data export failed',
            }, tx);
            callbackFinished = true;
        });
    } catch (error) {
        if (error instanceof ExportOwnershipLostError) return 'ownership_lost';
        if (callbackFinished) return 'commit_unknown';
        if (statusWritten) return 'audit_rolled_back';
        // The statement itself threw: nothing was written, so the row is
        // untouched and this attempt's claim is still live.
        return 'audit_rolled_back';
    }
    return 'recorded';
};

const bestEffortAudit = async (
    deps: TenantExportDeps,
    input: TenantExportAuditInput,
): Promise<void> => {
    try {
        await deps.audit(input);
    } catch {
        // Same rule: never mask the original failure with an audit failure.
    }
};

const runTenantExport = async (
    deps: TenantExportDeps,
    exportId: string,
    tenantId: string,
    now: () => number,
): Promise<ExportManifest> => {
    // Fail closed, in this order, BEFORE any read, write or storage side effect:
    //   1. the required durable-ownership capability must exist and declare the
    //      fencing contract;
    //   2. a transaction seam must exist, or no state change can be atomic.
    // A `pending` row is not ownership, and the process-local single-flight set
    // is not fencing, so without (1) every state change below would be
    // unprovable — including the one that settles the job as failed.
    const ownership = requireOwnershipCapability(deps);
    if (typeof deps.db.transaction !== 'function') throw new ExportTransactionCapabilityError();
    const startedAt = new Date(now()).toISOString();
    const tables: ExportTableManifest[] = [];
    const included: ExportTableCoverage[] = [];
    const rejected: ExportCoverage['rejected'] = [];
    const skipped: string[] = [];
    let totalRows = 0;
    let totalBytes = 0;
    let budgetExhausted = false;
    let failureCode: ExportFailureCode | null = null;
    // Per-attempt immutable object namespace.
    //
    // Every artifact this attempt writes lives under a fresh attempt id, so two
    // attempts racing the same export id can never write the same key. A losing
    // attempt therefore cannot overwrite the winner's bytes before its CAS —
    // the deterministic shared key was exactly that hole.
    //
    // The id comes from `randomUUID()` and NOT from `deps.newId`: `newId` is the
    // caller's job-id generator, and an injected deterministic generator would
    // hand every attempt the same namespace and silently restore the collision.
    // The attempt id is server-owned by construction.
    //
    // Nothing is deleted: a loser's namespace simply stays unreferenced, because
    // the row only ever stores the pointer of the attempt that WON the CAS.
    const attemptId = randomUUID();
    const attemptPrefix = `${EXPORT_STORAGE_PREFIX}/${tenantId}/${exportId}/${attemptId}`;
    // Server-owned execution identity. It is generated here, from the crypto
    // source, and never taken from a request, a header, a body field or the
    // caller's id generator: an arbitrary client owner would let any caller
    // assert ownership of any tenant's row.
    const owner = randomUUID();
    // The claim lives INSIDE the guarded region so that losing it is auditable
    // as a non-terminal outcome rather than escaping unrecorded. The clock is
    // captured once, before the claim, and the same value is reused by every
    // later lease term in this attempt: two statements disagreeing about
    // whether the lease is live is exactly the hole the lease term closes.
    const claimNowMs = captureTransitionClock(now);
    let grant: ExportOwnershipGrant | null = null;
    try {
        grant = validateOwnershipGrant(
            await inTransaction(deps.db, async (tx) =>
                ownership.claim((sql, params) => tx.execute(sql, params), {
                    exportId,
                    tenantId,
                    owner,
                    nowMs: claimNowMs,
                    leaseMs: EXPORT_OWNERSHIP_LEASE_MS,
                    leaseUntilMs: claimNowMs + EXPORT_OWNERSHIP_LEASE_MS,
                })),
            claimNowMs,
        );
        if (grant === null) {
            // The row is not claimable: another attempt holds it, or it is no
            // longer pending. That is not a failure of THIS job, so no terminal
            // state may be recorded for it — see the catch below.
            throw new ExportOwnershipLostError();
        }
        // Resolved INSIDE the guarded region on purpose: an invalid cap must
        // settle the job as failed. Throwing before the transition would leave
        // the row pending and block the tenant behind the one-active rule.
        const limits = resolveLimits(deps.limits);
        const budget = { remainingBytes: limits.maxTotalBytes };
        for (const plan of EXPORT_TABLE_PLAN) {
            abortIfRequested(deps.signal);
            if (budgetExhausted) {
                // The byte budget is a hard bound: a table that was not read is
                // reported as omitted, never as an included empty table.
                skipped.push(plan.table);
                continue;
            }
            const read = await readExportTable(deps.db, plan, tenantId, limits, budget, deps.signal);
            const bytes = Buffer.byteLength(read.body, 'utf8');
            const key = `${attemptPrefix}/${plan.table}.jsonl`;
            try {
                await deps.storage.write(key, read.body);
            } catch {
                // Classified, not forwarded: a storage driver message can name
                // the bucket path and the export key.
                throw new ExportStorageWriteError();
            }
            tables.push({ table: plan.table, rows: read.rows, bytes, checksum: sha256Hex(read.body) });
            included.push({
                table: plan.table,
                rows: read.rows,
                basis: plan.basis,
                parent: plan.parent,
                authorities: plan.authorities.map((authority) => authority.source),
                rejected_contradictions: read.rejected,
                truncated: read.truncatedBy !== null,
                pages: read.pages,
            });
            if (read.rejected > 0) {
                rejected.push({
                    table: plan.table,
                    rows: read.rejected,
                    reason: 'the row claimed this tenant while another ownership authority resolved to a different tenant; it is rejected rather than assigned to one side',
                });
            }
            totalRows += read.rows;
            totalBytes += bytes;
            if (read.truncatedBy === 'bytes') budgetExhausted = true;
        }
        const omittedCoverage = await buildOmittedCoverage(deps.db, tenantId, deps.signal);
        for (const table of skipped) {
            omittedCoverage.omitted.push({
                table,
                category: 'budget_exhausted',
                reason: 'not read: the export byte budget was exhausted by earlier tables',
                provable_rows: null,
                evidence: null,
            });
        }
        const truncatedTables = included.filter((entry) => entry.truncated).map((entry) => entry.table);
        const incomplete = truncatedTables.length > 0 || skipped.length > 0 || rejected.length > 0;
        const coverage: ExportCoverage = {
            scope: EXPORT_COVERAGE_SCOPE,
            included,
            omitted: omittedCoverage.omitted,
            omitted_children: omittedCoverage.omittedChildren,
            rejected,
            limitations: [...EXPORT_COVERAGE_LIMITATIONS, ...omittedCoverage.probeFailures.map((failure) => `omitted-row probe failed: ${failure}`)],
            complete: false,
            incomplete,
        };
        const manifest: ExportManifest = {
            version: EXPORT_MANIFEST_VERSION,
            tenant_id: tenantId,
            started_at: startedAt,
            completed_at: new Date(now()).toISOString(),
            tables,
            total_rows: totalRows,
            total_bytes: totalBytes,
            excluded: [...EXPORT_EXCLUSIONS],
            coverage,
            incomplete,
        };
        // Cancellation boundary. This is the last point at which an abort can
        // still prevent publication: after it the manifest may be written and
        // the row transition may commit. Nothing below may claim that an abort
        // leaves no bytes behind — table artifacts already written above are
        // orphans under this attempt's namespace, referenced by no row.
        //
        // The irreversible publication point is the COMMIT of the row
        // transition, not this check. If the abort loses that race the export
        // IS published, and this function returns its manifest rather than
        // reporting a cancellation for an export the client can download.
        abortIfRequested(deps.signal);
        const manifestKey = `${attemptPrefix}/manifest.json`;
        try {
            await deps.storage.write(manifestKey, JSON.stringify(manifest));
        } catch {
            throw new ExportStorageWriteError();
        }
        const expiresAt = new Date(now() + EXPORT_DOWNLOAD_WINDOW_SECONDS * 1000);
        // The completion clock is captured HERE, once, and the lease term uses
        // it. Capturing it inside the statement would let a claim that expires
        // between the check and the write still complete.
        const completeNowMs = captureTransitionClock(now);
        // Two flags, because two different failures look alike from the outside:
        //   statusWritten    — the fenced UPDATE matched exactly one row, so the
        //                      transition happened inside the transaction;
        //   callbackFinished — the audit also returned, so the callback ran to
        //                      completion and only the wrapper can have failed.
        // The second is the ambiguous-commit case; the first alone is a
        // deterministic rollback. Collapsing them is what previously let a
        // compensation demote a row this call never owned.
        let statusWritten = false;
        let callbackFinished = false;
        try {
            await inTransaction(deps.db, async (db) => {
                // The completion UPDATE carries the FULL fence: exact owner,
                // exact epoch, a LIVE unexpired lease and the intended state,
                // all evaluated by the database in this one statement.
                //
                // Owner proof held before the writes is not enough: a claim can
                // expire mid-run and be taken over by another attempt, and only
                // the write-time lease term can tell the two apart. A stale
                // claimant whose lease has lapsed therefore cannot complete the
                // row the new claimant now owns.
                const updated = await db.execute(
                    `UPDATE tenant_data_exports
                     SET status = 'completed', storage_key = ?, file_size = ?, manifest = ?,
                         expires_at = ?, completed_at = CURRENT_TIMESTAMP
                     WHERE id = ? AND tenant_id = ? AND status = 'pending'
                       AND export_owner = ? AND owner_epoch = ?
                       AND owner_lease_until_ms > ?`,
                    [
                        manifestKey,
                        totalBytes,
                        JSON.stringify(manifest),
                        expiresAt,
                        exportId,
                        tenantId,
                        owner,
                        grant.epoch,
                        completeNowMs,
                    ],
                );
                // Exactly one row must have moved: `undefined` is neither zero
                // (which would drop a won transition) nor one (which would
                // fabricate one), so it is refused rather than coerced.
                if (affectedRowsOf(updated, 'completion transition') !== 1) {
                    throw new ExportStateConflictError('The export job is no longer pending');
                }
                statusWritten = true;
                await deps.audit({
                    actorUserId: null,
                    tenantId,
                    action: 'tenant_export.completed',
                    resourceType: 'tenant_data_exports',
                    resourceId: exportId,
                    newValue: { tables: tables.length, rows: totalRows, bytes: totalBytes, incomplete },
                    reason: 'Tenant data export completed',
                }, db);
                callbackFinished = true;
            });
        } catch (error) {
            if (callbackFinished) {
                // The callback succeeded, so the only failure left is the COMMIT
                // itself, and its outcome is unknowable from here. No
                // compensation runs: the row may be this attempt's own committed
                // completion, or another attempt's winner, or still pending.
                // Guessing would either demote a completed row or fabricate a
                // failure for an export that is downloadable.
                throw new ExportCompletionUnknownError();
            }
            if (statusWritten) {
                // Deterministic rollback: the transition did not commit, so the
                // row is back to 'pending' and still owned by this attempt. The
                // failure path settles it as an owned, fenced transition; there
                // is no second, wider compensation here.
                failureCode = 'audit_failed';
            }
            throw error;
        }
        return manifest;
    } catch (error) {
        const code = failureCode ?? classifyExportFailure(error);
        if (code === 'completion_conflict' || code === 'completion_unknown') {
            // Neither outcome authorises a row write. A conflict means another
            // attempt already settled the job; an unknown means this call does
            // not know which state it left behind. Both are recorded as an audit
            // and nothing else, so no completed row is ever demoted by a path
            // that did not complete it, and no failed/completed audit is
            // fabricated for a state this call never observed.
            await bestEffortAudit(deps, {
                actorUserId: null,
                tenantId,
                action: code === 'completion_conflict'
                    ? 'tenant_export.completion_conflict'
                    : 'tenant_export.completion_unknown',
                resourceType: 'tenant_data_exports',
                resourceId: exportId,
                newValue: { code },
                reason: code === 'completion_conflict'
                    ? 'The tenant data export lost the completion transition to another attempt'
                    : 'The export completion commit outcome is unknown: the job row is either pending or completed and must be read back, not assumed',
            });
            throw error;
        }
        if (grant === null) {
            // No proven durable ownership. `status = 'pending'` is the state
            // another attempt is standing in, not proof that this attempt owns
            // the row, and the process-local single-flight set is not fencing.
            // So this call may not assert that the job failed: another attempt
            // may own it and may be running right now.
            await bestEffortAudit(deps, {
                actorUserId: null,
                tenantId,
                action: 'tenant_export.ownership_unproven',
                resourceType: 'tenant_data_exports',
                resourceId: exportId,
                newValue: { code },
                reason: 'The export did not hold proven durable ownership, so no terminal job state was recorded',
            });
            throw error;
        }
        if (code === 'transaction-capability-absent' || code === 'ownership_capability_absent') {
            // No transaction ⇒ no transactionally coupled terminal audit, which
            // is the only form a terminal audit is allowed to take here.
            await bestEffortAudit(deps, {
                actorUserId: null,
                tenantId,
                action: 'tenant_export.ownership_unproven',
                resourceType: 'tenant_data_exports',
                resourceId: exportId,
                newValue: { code },
                reason: 'The export could not record a terminal state without a transaction seam, so no terminal job state was recorded',
            });
            throw error;
        }
        // Terminal failed/aborted, recorded ONLY as an owned, fenced,
        // transactionally coupled transition that moved exactly one row. The
        // terminal audit commits inside that same transaction, so a terminal
        // audit can never exist without the proven state change beside it.
        //
        // The clock is captured once, here, and is the same value the lease
        // term evaluates. Capturing it inside the transition would let the
        // lease appear live for the write and expired for the check.
        const failureNowMs = captureTransitionClock(now);
        const outcome = await recordOwnedFailure(deps, ownership, {
            exportId,
            tenantId,
            owner,
            epoch: grant.epoch,
            nowMs: failureNowMs,
            code,
        });
        if (outcome === 'recorded') {
            // Everything this call is entitled to say about the job's final
            // state has already been committed with its audit.
            throw error;
        }
        // The terminal transition did not provably commit. Whether the lease
        // lapsed, the audit rolled the transaction back, or the COMMIT itself
        // is unknowable, this call must not assert the job's final state.
        await bestEffortAudit(deps, {
            actorUserId: null,
            tenantId,
            action: outcome === 'ownership_lost'
                ? 'tenant_export.ownership_lost'
                : outcome === 'commit_unknown'
                    ? 'tenant_export.failure_commit_unknown'
                    : 'tenant_export.failure_audit_rolled_back',
            resourceType: 'tenant_data_exports',
            resourceId: exportId,
            newValue: { code, outcome },
            reason: outcome === 'ownership_lost'
                ? 'The export no longer held the job row, so no terminal state was recorded'
                : outcome === 'commit_unknown'
                    ? 'The terminal failure transition commit outcome is unknown: the job row is either failed or pending and must be read back, not assumed'
                    : 'The terminal failure transition rolled back with its audit, so the row is still pending and no terminal state was recorded',
        });
        throw error;
    }
};

export const processTenantExport = async (
    deps: TenantExportDeps,
    exportId: string,
): Promise<ExportManifest> => {
    // Fail closed before the job is even read: without durable ownership the
    // run below could not prove any state change it makes, including the one
    // that settles the job as failed.
    requireOwnershipCapability(deps);
    const now = deps.now ?? Date.now;
    const job = await deps.db.queryOne<TenantExportJobRow>(
        `SELECT id, tenant_id, status FROM tenant_data_exports WHERE id = ? LIMIT 1`,
        [exportId],
    );
    if (!job) throw new Error('The export job does not exist');
    if (job.status !== 'pending') throw new Error('The export job is not pending');
    // Local single-flight: two callers inside this process do not both read the
    // tenant and write the same objects. It is a work guard, not fencing —
    // see `claimLocalAttempt`.
    claimLocalAttempt(exportId);
    try {
        return await runTenantExport(deps, exportId, job.tenant_id, now);
    } finally {
        IN_FLIGHT_EXPORTS.delete(exportId);
    }
};

// ---------------------------------------------------------------------------
// Download tokens + downloads.
// ---------------------------------------------------------------------------

export type ExportTokenResult =
    | { ok: true; token: string; expiresAt: string }
    | { ok: false; status: number; error: string };

const loadCompletedJob = async (
    deps: TenantExportDeps,
    tenantId: string,
    exportId: string,
): Promise<TenantExportJobRow | null> => {
    const job = await deps.db.queryOne<TenantExportJobRow>(
        `SELECT id, tenant_id, status, storage_key, expires_at, token_hash
         FROM tenant_data_exports
         WHERE id = ? AND tenant_id = ? AND status = 'completed' LIMIT 1`,
        [exportId, tenantId],
    );
    return job ?? null;
};

export const issueExportDownloadToken = async (
    deps: TenantExportDeps,
    input: { tenantId: string; exportId: string; actorUserId: string },
): Promise<ExportTokenResult> => {
    if (!secretConfigured(deps.secret)) {
        return { ok: false, status: 503, error: 'The tenant export service is not configured' };
    }
    const now = deps.now ?? Date.now;
    const job = await loadCompletedJob(deps, input.tenantId, input.exportId);
    if (!job) {
        return { ok: false, status: 404, error: 'Export not found' };
    }
    const windowEnd = asTime(job.expires_at);
    if (windowEnd > 0 && windowEnd <= now()) {
        return { ok: false, status: 410, error: 'The export download window has expired' };
    }
    const tokenExpiresAt = Math.floor(now() / 1000) + EXPORT_DOWNLOAD_TOKEN_TTL_SECONDS;
    const token = signExportToken(deps.secret, {
        v: 1,
        e: input.exportId,
        t: input.tenantId,
        x: tokenExpiresAt,
    });
    let rotated = false;
    try {
        await inTransaction(deps.db, async (db) => {
            const updated = await db.execute(
                `UPDATE tenant_data_exports SET token_hash = ?
                 WHERE id = ? AND tenant_id = ? AND status = 'completed'`,
                [sha256Hex(token), input.exportId, input.tenantId],
            );
            if (affectedRowsOf(updated, 'token rotation') !== 1) {
                throw new ExportStateConflictError('The export is no longer available');
            }
            rotated = true;
            await deps.audit({
                actorUserId: input.actorUserId,
                tenantId: input.tenantId,
                action: 'tenant_export.download_issued',
                resourceType: 'tenant_data_exports',
                resourceId: input.exportId,
                newValue: { expires_at: new Date(tokenExpiresAt * 1000).toISOString() },
                reason: 'Tenant export download token issued',
            }, db);
        });
    } catch (error) {
        if (!rotated && error instanceof ExportStateConflictError) {
            return { ok: false, status: 409, error: 'The export is no longer available' };
        }
        throw error;
    }
    return { ok: true, token, expiresAt: new Date(tokenExpiresAt * 1000).toISOString() };
};

export type ExportDownloadVerification =
    | { ok: true; exportId: string; tenantId: string }
    | { ok: false; status: number; error: string };

export const verifyExportDownloadToken = async (
    deps: TenantExportDeps,
    input: { token: string; tenantId: string },
): Promise<ExportDownloadVerification> => {
    if (!secretConfigured(deps.secret)) {
        return { ok: false, status: 503, error: 'The tenant export service is not configured' };
    }
    const now = deps.now ?? Date.now;
    const payload = verifyExportTokenSignature(deps.secret as string, input.token);
    if (!payload) {
        return { ok: false, status: 403, error: 'The download token is invalid' };
    }
    if (payload.x * 1000 <= now()) {
        return { ok: false, status: 410, error: 'The download token has expired' };
    }
    if (payload.t !== input.tenantId) {
        return { ok: false, status: 403, error: 'The download token does not belong to this tenant' };
    }
    const job = await deps.db.queryOne<TenantExportJobRow>(
        `SELECT id, tenant_id, status, expires_at, token_hash
         FROM tenant_data_exports
         WHERE id = ? AND tenant_id = ? LIMIT 1`,
        [payload.e, payload.t],
    );
    if (!job || job.status !== 'completed') {
        return { ok: false, status: 403, error: 'The download token is invalid' };
    }
    const expiresAt = asTime(job.expires_at);
    if (expiresAt > 0 && expiresAt <= now()) {
        return { ok: false, status: 410, error: 'The export download window has expired' };
    }
    // Rotation: only the most recently issued token for this job verifies.
    // Older tokens are invalidated by the hash overwrite on re-issue.
    if (!job.token_hash || !timingSafeStringEqual(job.token_hash, sha256Hex(input.token))) {
        return { ok: false, status: 403, error: 'The download token is invalid' };
    }
    return { ok: true, exportId: payload.e, tenantId: payload.t };
};

export type ExportDownloadResult =
    | { ok: true; body: string; byteSize: number; manifest: ExportManifest | null }
    | { ok: false; status: number; error: string };

export const downloadTenantExport = async (
    deps: TenantExportDeps,
    input: { token: string; tenantId: string; exportId: string; actorUserId: string },
): Promise<ExportDownloadResult> => {
    const verification = await verifyExportDownloadToken(deps, {
        token: input.token,
        tenantId: input.tenantId,
    });
    if (!verification.ok) {
        await deps.audit({
            actorUserId: input.actorUserId,
            tenantId: input.tenantId,
            action: 'tenant_export.download_denied',
            resourceType: 'tenant_data_exports',
            resourceId: input.exportId,
            reason: verification.error,
        });
        return { ok: false, status: verification.status, error: verification.error };
    }
    if (verification.exportId !== input.exportId) {
        // The signed identity must equal the id in the requested URL; a valid
        // token for another export of the same tenant cannot be replayed here.
        await deps.audit({
            actorUserId: input.actorUserId,
            tenantId: verification.tenantId,
            action: 'tenant_export.download_denied',
            resourceType: 'tenant_data_exports',
            resourceId: input.exportId,
            reason: 'The download token does not match the requested export',
        });
        return { ok: false, status: 403, error: 'The download token does not match the requested export' };
    }
    const job = await deps.db.queryOne<TenantExportJobRow>(
        `SELECT id, tenant_id, status, storage_key, file_size, manifest
         FROM tenant_data_exports
         WHERE id = ? AND tenant_id = ? AND status = 'completed' LIMIT 1`,
        [verification.exportId, verification.tenantId],
    );
    if (!job || !job.storage_key) {
        await deps.audit({
            actorUserId: input.actorUserId,
            tenantId: verification.tenantId,
            action: 'tenant_export.download_denied',
            resourceType: 'tenant_data_exports',
            resourceId: verification.exportId,
            reason: 'The export file is no longer available',
        });
        return { ok: false, status: 410, error: 'The export file is no longer available' };
    }
    let body: string;
    try {
        body = await deps.storage.read(job.storage_key);
    } catch {
        await deps.audit({
            actorUserId: input.actorUserId,
            tenantId: verification.tenantId,
            action: 'tenant_export.download_denied',
            resourceType: 'tenant_data_exports',
            resourceId: verification.exportId,
            reason: 'The export file could not be read',
        });
        return { ok: false, status: 410, error: 'The export file is no longer available' };
    }
    const manifest: ExportManifest | null = parseManifest(job.manifest);
    await deps.audit({
        actorUserId: input.actorUserId,
        tenantId: verification.tenantId,
        action: 'tenant_export.downloaded',
        resourceType: 'tenant_data_exports',
        resourceId: verification.exportId,
        newValue: { bytes: Buffer.byteLength(body, 'utf8') },
        reason: 'Tenant data export downloaded',
    });
    return { ok: true, body, byteSize: Buffer.byteLength(body, 'utf8'), manifest };
};

const parseManifest = (value: unknown): ExportManifest | null => {
    if (value === null || value === undefined) return null;
    if (typeof value === 'string') {
        try {
            return JSON.parse(value) as ExportManifest;
        } catch {
            return null;
        }
    }
    if (typeof value === 'object') return value as ExportManifest;
    return null;
};
