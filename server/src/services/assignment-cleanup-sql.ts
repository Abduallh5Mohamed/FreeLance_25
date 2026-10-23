/**
 * Connection-bound SQL adapter for the durable cleanup obligation store.
 *
 * This is the implementation the coordinator and the request path were written
 * against: `assignment-cleanup-recovery.ts` owns the contract, this file owns the
 * statements. It is deliberately the *only* place that knows the table, and it
 * never opens a connection, never imports a pool, and never reads configuration:
 * the caller injects a connection-bound client.
 *
 * Three properties are non-negotiable, and each one is why a method looks the way
 * it does:
 *
 *  1. **Same-connection, same-transaction write-ahead.** `recordPending` accepts
 *     the caller's transaction and runs *both* the idempotent insert and the
 *     read-back that classifies it on that transaction. A store that opened its
 *     own transaction for the read-back would not be write-ahead atomic even
 *     though the insert itself was inside the caller's unit.
 *  2. **The claim is one unit.** `claimBatch` selects a bounded keyset page
 *     `FOR UPDATE SKIP LOCKED` and stamps owner + version + lease in the same
 *     transaction, on one connection. A select-then-update split across two
 *     connections would hand the same row to two workers.
 *  3. **Identity is exact.** The ETag column must be proven NO PAD before this
 *     adapter is usable at all: under a PAD SPACE collation `"e"` and `"e "`
 *     compare equal, so the unique key would collapse two object versions into
 *     one obligation. The verdict comes from `probeAssignmentEtagCollation`,
 *     which is an **explicit** call — nothing here queries metadata at import,
 *     at construction, or implicitly.
 *
 * Missing schema is reported as `unavailable`, never as a weaker store: the
 * coordinator refuses to claim through an unavailable store, and the factory
 * surfaces the reason. There is no silent fallback.
 *
 * No `any`, no ts-ignore, no import of `db`/`pool`/`mysql`, no query at import.
 */

import { randomUUID } from 'crypto';
import type {
    AssignmentCleanupClaimRequest,
    AssignmentCleanupCompletionRequest,
    AssignmentCleanupFailure,
    AssignmentCleanupObligationRecord,
    AssignmentCleanupObligationStore,
    AssignmentCleanupProof,
    AssignmentCleanupRecordResult,
    AssignmentCleanupReleaseRequest,
    AssignmentCleanupState,
    AssignmentCleanupStoreAvailability,
    AssignmentCleanupTarget,
    AssignmentCleanupTerminalState,
    AssignmentCleanupTx,
    AssignmentCleanupUnclaimedCompletionRequest,
} from './assignment-cleanup-recovery';
import {
    ASSIGNMENT_CLEANUP_FAILURES,
    ASSIGNMENT_CLEANUP_STATES,
    AssignmentCleanupRowInvalidError,
    MAX_CLEANUP_LEASE_MS,
    cleanupStateForProof,
} from './assignment-cleanup-recovery';
import { CLEANUP_OBLIGATION_REASONS } from './assignments';
import type { AssignmentCleanupReason } from './assignments';

/** The single table this adapter owns. Never taken from a caller. */
export const ASSIGNMENT_CLEANUP_TABLE = 'assignment_cleanup_obligations';

/** The identity column whose collation decides whether ETag equality is exact. */
export const ASSIGNMENT_CLEANUP_ETAG_COLUMN = 'object_etag';

/* ------------------------------------------------------------------------- */
/* Client contract                                                           */
/* ------------------------------------------------------------------------- */

/** One connection (or one transaction) — the only thing this adapter touches. */
export interface AssignmentCleanupSqlConnection {
    query<T>(sql: string, params?: unknown[]): Promise<T[]>;
    execute(sql: string, params?: unknown[]): Promise<{ affectedRows?: number; insertId?: number }>;
}

/**
 * The injected client. `transaction` is required, not optional: the claim is a
 * select-then-update and cannot be made atomic without one. A deployment that
 * cannot provide it cannot provide this store.
 */
export interface AssignmentCleanupSqlClient extends AssignmentCleanupSqlConnection {
    transaction<T>(fn: (tx: AssignmentCleanupSqlConnection) => Promise<T>): Promise<T>;
}

/* ------------------------------------------------------------------------- */
/* ETag collation probe (explicit, lazy, never called here)                   */
/* ------------------------------------------------------------------------- */

/**
 * What is known about the ETag column's collation.
 *
 * `no-pad-verified` is the only value that makes this adapter usable. It means:
 * the server reported MySQL 8 (not MariaDB, whose version string also starts
 * with a digit), the column's collation was read from `information_schema`, and
 * that collation's `PAD_ATTRIBUTE` is exactly `NO PAD`.
 */
export type AssignmentEtagCollationVerdict =
    | { status: 'no-pad-verified'; collation: string }
    | { status: 'pad-space'; collation: string }
    | {
        status: 'unknown';
        reason: 'server-version-unknown' | 'column-not-found' | 'pad-attribute-unavailable';
    };

export interface AssignmentEtagCollationReport {
    verdict: AssignmentEtagCollationVerdict;
    serverVersion: string | null;
    columnCollation: string | null;
    padAttribute: string | null;
    /**
     * Always false. `utf8mb4_0900_bin` is a MySQL 8 fact, not a portable
     * promise: MariaDB and older servers must answer `unknown`, and a caller
     * must not promote `unknown` to `no-pad-verified` on its own.
     */
    portable: false;
}

interface VersionRow { version: string | null }
interface CollationRow { collation_name: string | null }
interface PadRow { pad_attribute: string | null }

/**
 * Read the real collation facts for the ETag column.
 *
 * This is the explicit lazy metadata path: the caller decides when to run it
 * (startup readiness, an operator probe), and passes the verdict into
 * `createSqlAssignmentCleanupStore`. It is **not** called by this module, and no
 * query is issued at import or construction. Nothing in this task executes it.
 */
export const probeAssignmentEtagCollation = async (
    connection: AssignmentCleanupSqlConnection,
    options?: { table?: string; column?: string },
): Promise<AssignmentEtagCollationReport> => {
    const table = options?.table ?? ASSIGNMENT_CLEANUP_TABLE;
    const column = options?.column ?? ASSIGNMENT_CLEANUP_ETAG_COLUMN;

    const versionRows = await connection.query<VersionRow>('SELECT VERSION() AS version');
    const serverVersion = typeof versionRows[0]?.version === 'string' ? versionRows[0].version : null;
    const isMysql8 = serverVersion !== null
        && /^8\./.test(serverVersion)
        && !/mariadb/i.test(serverVersion);
    if (!isMysql8) {
        return {
            verdict: { status: 'unknown', reason: 'server-version-unknown' },
            serverVersion,
            columnCollation: null,
            padAttribute: null,
            portable: false,
        };
    }

    const columnRows = await connection.query<CollationRow>(
        `SELECT COLLATION_NAME AS collation_name
         FROM information_schema.COLUMNS
         WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?
         LIMIT 1`,
        [table, column],
    );
    const columnCollation = typeof columnRows[0]?.collation_name === 'string'
        ? columnRows[0].collation_name
        : null;
    if (!columnCollation) {
        return {
            verdict: { status: 'unknown', reason: 'column-not-found' },
            serverVersion,
            columnCollation: null,
            padAttribute: null,
            portable: false,
        };
    }

    let padAttribute: string | null = null;
    try {
        const padRows = await connection.query<PadRow>(
            'SELECT PAD_ATTRIBUTE AS pad_attribute FROM information_schema.COLLATIONS WHERE COLLATION_NAME = ? LIMIT 1',
            [columnCollation],
        );
        padAttribute = typeof padRows[0]?.pad_attribute === 'string' ? padRows[0].pad_attribute : null;
    } catch {
        // MariaDB (and any server without PAD_ATTRIBUTE) lands here. That is an
        // `unknown`, not a `NO PAD`: the column must not be trusted.
        return {
            verdict: { status: 'unknown', reason: 'pad-attribute-unavailable' },
            serverVersion,
            columnCollation,
            padAttribute: null,
            portable: false,
        };
    }
    if (padAttribute === null) {
        return {
            verdict: { status: 'unknown', reason: 'pad-attribute-unavailable' },
            serverVersion,
            columnCollation,
            padAttribute,
            portable: false,
        };
    }
    return {
        verdict: padAttribute === 'NO PAD'
            ? { status: 'no-pad-verified', collation: columnCollation }
            : { status: 'pad-space', collation: columnCollation },
        serverVersion,
        columnCollation,
        padAttribute,
        portable: false,
    };
};

/* ------------------------------------------------------------------------- */
/* Schema declaration                                                        */
/* ------------------------------------------------------------------------- */

/**
 * The migration owner's declaration that the additive schema exists
 * (`server/migrations/20261023_05_assignment_cleanup_scan_fencing.sql`).
 *
 * `'declared'` is a literal, not a boolean: a caller has to write the word, so
 * nobody enables the durable path by passing `true` reflexively.
 */
export interface AssignmentCleanupSchemaDeclaration {
    obligations: 'declared';
    /** Verdict from `probeAssignmentEtagCollation` — never assumed. */
    etagCollation: AssignmentEtagCollationVerdict;
}

/* ------------------------------------------------------------------------- */
/* Row projection                                                            */
/* ------------------------------------------------------------------------- */

interface ObligationRow {
    id: string;
    tenant_id: string;
    assignment_id: string;
    student_enrollment_id: string;
    submission_id: string;
    storage_key: string;
    object_etag: string;
    object_size_bytes: number | string;
    reason: string;
    state: string;
    claim_owner: string | null;
    claim_version: number | string;
    lease_until_ms: number | string | null;
    attempts: number | string;
    last_failure: string | null;
    created_at_ms: number | string;
    updated_at_ms: number | string;
}

/**
 * Parse a stored integer **strictly**.
 *
 * The permissive version of this (`Number(value)`, finite check) accepted `''`,
 * `'  '`, `'1.5'`, `'0x10'`, `'1e3'` and any value past `Number.MAX_SAFE_INTEGER`,
 * and the projection then turned a `null` into `0`. For `object_size_bytes` that
 * fabricates a zero-byte object; for `claim_version` it resets a fence to the
 * version a request-path settlement matches on. Both are silent corruption, so
 * the rule here is: only a safe integer, or nothing.
 */
const parseSafeInt = (value: number | string | null): number | null => {
    if (value === null) return null;
    if (typeof value === 'number') {
        return Number.isSafeInteger(value) ? value : null;
    }
    if (typeof value !== 'string') return null;
    // No exponent, no hex, no decimal point, no empty string. BIGINT/INT columns
    // are returned as plain digits; anything else is not this column's value.
    const digits = value.trim();
    if (!/^-?\d+$/.test(digits)) return null;
    const parsed = Number(digits);
    return Number.isSafeInteger(parsed) ? parsed : null;
};

const invalidRow = (field: string, rowId: string | null): never => {
    throw new AssignmentCleanupRowInvalidError(field, rowId);
};

const requireSafeInt = (
    value: number | string | null,
    field: string,
    rowId: string | null,
): number => {
    const parsed = parseSafeInt(value);
    if (parsed === null) return invalidRow(field, rowId);
    return parsed;
};

/**
 * A driver answer we can act on.
 *
 * `undefined` is not zero. A client that does not report `affectedRows` cannot
 * prove a single-row CAS matched, and guessing "0" would silently drop a claim
 * we actually won while guessing "1" would fabricate one. Refuse instead.
 */
const affectedRowsOf = (result: { affectedRows?: number } | null | undefined): number => {
    const reported = result?.affectedRows;
    if (typeof reported !== 'number' || !Number.isSafeInteger(reported) || reported < 0) {
        throw new Error(
            'assignment cleanup client did not report a usable affectedRows count;'
            + ' a fenced write cannot be confirmed without it',
        );
    }
    return reported;
};

const toState = (value: string, rowId: string | null): AssignmentCleanupState => {
    if (!(ASSIGNMENT_CLEANUP_STATES as readonly string[]).includes(value)) {
        // An unknown enum value means schema/code drift. Fail loudly rather than
        // project a state the coordinator would act on.
        return invalidRow('state', rowId);
    }
    return value as AssignmentCleanupState;
};

const toFailure = (value: string | null, rowId: string | null): AssignmentCleanupFailure | null => {
    if (value === null) return null;
    if (!(ASSIGNMENT_CLEANUP_FAILURES as readonly string[]).includes(value)) {
        return invalidRow('last_failure', rowId);
    }
    return value as AssignmentCleanupFailure;
};

const toReason = (value: string, rowId: string | null): AssignmentCleanupReason => {
    if (!(CLEANUP_OBLIGATION_REASONS as readonly string[]).includes(value)) {
        return invalidRow('reason', rowId);
    }
    return value as AssignmentCleanupReason;
};

/**
 * Project a stored row, refusing anything that cannot be trusted.
 *
 * Every field below is either strictly parsed or fatal. The owner/lease pair is
 * checked as a pair: a stamped claim always writes both, and every release path
 * clears both, so a lease without an owner (or an owner without a lease) is a
 * row whose fence cannot be reasoned about. Timestamps are checked for order
 * because `updated_at_ms < created_at_ms` makes a keyset cursor go backwards.
 */
const toRecord = (row: ObligationRow): AssignmentCleanupObligationRecord => {
    const id = typeof row.id === 'string' && row.id.length > 0 ? row.id : invalidRow('id', null);
    // Exact bytes. No trim, no case folding: this is the object identity.
    if (typeof row.object_etag !== 'string' || row.object_etag.length === 0) {
        return invalidRow('object_etag', id);
    }
    const sizeBytes = requireSafeInt(row.object_size_bytes, 'object_size_bytes', id);
    if (sizeBytes < 0) return invalidRow('object_size_bytes', id);
    const claimVersion = requireSafeInt(row.claim_version, 'claim_version', id);
    if (claimVersion < 0) return invalidRow('claim_version', id);
    const attempts = requireSafeInt(row.attempts, 'attempts', id);
    if (attempts < 0) return invalidRow('attempts', id);
    const createdAtMs = requireSafeInt(row.created_at_ms, 'created_at_ms', id);
    const updatedAtMs = requireSafeInt(row.updated_at_ms, 'updated_at_ms', id);
    if (createdAtMs < 0) return invalidRow('created_at_ms', id);
    if (updatedAtMs < createdAtMs) return invalidRow('updated_at_ms', id);

    const owner = row.claim_owner;
    const leaseUntilMs = row.lease_until_ms === null
        ? null
        : requireSafeInt(row.lease_until_ms, 'lease_until_ms', id);
    if (owner === null && leaseUntilMs !== null) return invalidRow('claim_owner', id);
    if (owner !== null && leaseUntilMs === null) return invalidRow('lease_until_ms', id);

    return {
        id,
        tenantId: row.tenant_id,
        assignmentId: row.assignment_id,
        enrollmentId: row.student_enrollment_id,
        submissionId: row.submission_id,
        storageKey: row.storage_key,
        etag: row.object_etag,
        sizeBytes,
        reason: toReason(row.reason, id),
        state: toState(row.state, id),
        claimOwner: owner,
        claimVersion,
        leaseUntilMs,
        attempts,
        lastFailure: toFailure(row.last_failure, id),
        createdAtMs,
        updatedAtMs,
    };
};

const SELECT_COLUMNS = `id,tenant_id,assignment_id,student_enrollment_id,submission_id,storage_key,
    object_etag,object_size_bytes,reason,state,claim_owner,claim_version,lease_until_ms,
    attempts,last_failure,created_at_ms,updated_at_ms`;

/* ------------------------------------------------------------------------- */
/* Claim page statement                                                      */
/* ------------------------------------------------------------------------- */

/**
 * The claim page, built once and used twice: by `claimBatch` and by the exported
 * contract. The continuation predicate is part of the statement, not a comment
 * beside it — an exported contract that advertises SQL the adapter never sends
 * is worse than no contract.
 */
export const buildAssignmentCleanupClaimPage = (withKeyset: boolean): string =>
    `SELECT ${SELECT_COLUMNS} FROM ${ASSIGNMENT_CLEANUP_TABLE}
WHERE state = 'pending'
  AND (claim_owner IS NULL OR lease_until_ms <= ?)
  AND (retry_after_ms IS NULL OR retry_after_ms <= ?)`
    + (withKeyset ? `\n  AND (created_at_ms > ? OR (created_at_ms = ? AND id > ?))` : '')
    + `
ORDER BY created_at_ms ASC, id ASC
LIMIT ?
FOR UPDATE SKIP LOCKED`;

/* ------------------------------------------------------------------------- */
/* Adapter                                                                   */
/* ------------------------------------------------------------------------- */

export interface AssignmentCleanupSqlStoreOptions {
    schema: AssignmentCleanupSchemaDeclaration;
    /** Injected for deterministic ids; defaults to `crypto.randomUUID`. */
    newId?: () => string;
    now?: () => Date;
}

export type AssignmentCleanupSqlStore = AssignmentCleanupObligationStore & {
    availability: AssignmentCleanupStoreAvailability;
};

const unavailableReason = (
    client: AssignmentCleanupSqlClient,
    schema: AssignmentCleanupSchemaDeclaration | undefined,
): AssignmentCleanupStoreAvailability => {
    if (!schema || schema.obligations !== 'declared') {
        return { mode: 'unavailable', reason: 'schema-not-declared' };
    }
    // The claim and the completion each need one unit of work on one
    // connection. A client without `transaction` would fail later as a bare
    // TypeError inside `claimBatch`; name it here instead, so the factory can
    // report why the durable path is off.
    if (typeof client?.transaction !== 'function') {
        return { mode: 'unavailable', reason: 'transaction-capability-absent' };
    }
    if (schema.etagCollation.status !== 'no-pad-verified') {
        return { mode: 'unavailable', reason: 'etag-collation-unverified' };
    }
    return { mode: 'durable', reason: null };
};

/**
 * Build the durable obligation store.
 *
 * When the declared schema or the ETag collation does not hold, the returned
 * object reports `availability.mode === 'unavailable'` and every method rejects.
 * It is never silently downgraded to an in-memory or best-effort store: the
 * coordinator reads `availability` and refuses to claim, and the factory
 * surfaces the reason to whoever composes it.
 */
export const createSqlAssignmentCleanupStore = (
    client: AssignmentCleanupSqlClient,
    options: AssignmentCleanupSqlStoreOptions,
): AssignmentCleanupSqlStore => {
    const availability = unavailableReason(client, options.schema);
    const newId = options.newId ?? ((): string => randomUUID());
    const now = options.now ?? ((): Date => new Date());

    const refuse = (): never => {
        throw new Error(
            `assignment cleanup store is unavailable (${availability.reason ?? 'unknown'});`
            + ' it must not be used',
        );
    };

    /**
     * Idempotent insert, classified by a read-back on the SAME connection.
     *
     * The classification is deliberately strict: a duplicate on the identity
     * tuple whose stored identity differs in any other field is a **conflict**,
     * never a merge and never "adopt the stored row as ours". The same goes for
     * a tuple that already reached a terminal state — re-queueing it would
     * silently reopen settled work.
     */
    const recordPending = async (
        target: AssignmentCleanupTarget,
        tx?: AssignmentCleanupTx,
    ): Promise<AssignmentCleanupRecordResult> => {
        if (availability.mode === 'unavailable') return refuse();
        const connection: AssignmentCleanupSqlConnection = tx ?? client;
        const nowMs = now().getTime();
        const id = newId();
        const inserted = await connection.execute(
            `INSERT INTO ${ASSIGNMENT_CLEANUP_TABLE}
                (id, tenant_id, assignment_id, student_enrollment_id, submission_id, storage_key,
                 object_etag, object_size_bytes, reason, state, claim_owner, claim_version,
                 lease_until_ms, attempts, last_failure, retry_after_ms, completion_proof,
                 created_at_ms, updated_at_ms, completed_at_ms)
             VALUES (?,?,?,?,?,?,?,?,?,'pending',NULL,0,NULL,0,NULL,NULL,NULL,?,?,NULL)
             ON DUPLICATE KEY UPDATE id = id`,
            [
                id,
                target.tenantId,
                target.assignmentId,
                target.enrollmentId,
                target.submissionId,
                target.storageKey,
                target.etag,
                target.sizeBytes,
                target.reason,
                nowMs,
                nowMs,
            ],
        );
        const rows = await connection.query<ObligationRow>(
            `SELECT ${SELECT_COLUMNS} FROM ${ASSIGNMENT_CLEANUP_TABLE}
             WHERE submission_id = ? AND object_etag = ? AND object_size_bytes = ?
             LIMIT 1`,
            [target.submissionId, target.etag, target.sizeBytes],
        );
        const row = rows[0];
        if (!row) return { outcome: 'conflict', id: null, claimVersion: null };
        // Project first: a row we cannot read is not a row we may classify.
        const record = toRecord(row);
        const identityMatches = record.tenantId === target.tenantId
            && record.assignmentId === target.assignmentId
            && record.enrollmentId === target.enrollmentId
            && record.submissionId === target.submissionId
            && record.storageKey === target.storageKey
            && record.etag === target.etag
            && record.sizeBytes === target.sizeBytes;
        if (!identityMatches) return { outcome: 'conflict', id: null, claimVersion: null };
        if (record.state !== 'pending') {
            // Already settled. Re-queueing would reopen work nobody owes.
            return { outcome: 'conflict', id: record.id, claimVersion: record.claimVersion };
        }
        // 1 means inserted, 0 means the row was already there. (`2` can appear
        // when the server runs with CLIENT_FOUND_ROWS, so the test is `=== 1`
        // rather than `> 0`.) The two answers are only informational: both mean
        // "a durable pending obligation exists". Whether this call may proceed is
        // decided by the read-back above, never by this count.
        const affected = affectedRowsOf(inserted);
        return {
            outcome: affected === 1 ? 'recorded' : 'existing',
            id: record.id,
            claimVersion: record.claimVersion,
        };
    };

    /**
     * Bounded keyset claim. One transaction, one connection: select the page
     * `FOR UPDATE SKIP LOCKED`, then stamp each row and keep only the rows this
     * caller actually won. Rows whose stamp lost are dropped, never reported as
     * claimed.
     */
    const claimBatch = async (
        request: AssignmentCleanupClaimRequest,
    ): Promise<AssignmentCleanupObligationRecord[]> => {
        if (availability.mode === 'unavailable') return refuse();
        // The request is validated before a single row is locked: a lease that
        // has already expired, or one measured in the wrong unit, would hand out
        // a claim that is dead on arrival.
        if (typeof request.owner !== 'string' || request.owner.length === 0) {
            throw new Error('assignment cleanup claim request has no owner');
        }
        if (!Number.isSafeInteger(request.nowMs) || request.nowMs < 0) {
            throw new Error('assignment cleanup claim request has an invalid nowMs');
        }
        if (!Number.isSafeInteger(request.leaseUntilMs)) {
            throw new Error('assignment cleanup claim request has an invalid leaseUntilMs');
        }
        if (request.leaseUntilMs <= request.nowMs) {
            throw new Error('assignment cleanup claim request has an already-expired lease');
        }
        if (request.leaseUntilMs - request.nowMs > MAX_CLEANUP_LEASE_MS) {
            throw new Error('assignment cleanup claim request lease exceeds the maximum');
        }
        if (!Number.isSafeInteger(request.limit) || request.limit < 1) {
            throw new Error('assignment cleanup claim request has an invalid limit');
        }
        if (request.after !== null) {
            if (!Number.isSafeInteger(request.after.createdAtMs) || request.after.createdAtMs < 0) {
                throw new Error('assignment cleanup claim request has an invalid continuation cursor');
            }
            if (typeof request.after.id !== 'string' || request.after.id.length === 0) {
                throw new Error('assignment cleanup claim request has an invalid continuation id');
            }
        }
        const limit = Math.max(1, Math.trunc(request.limit));
        return client.transaction(async (tx) => {
            const params: unknown[] = [request.nowMs, request.nowMs];
            if (request.after !== null) {
                params.push(request.after.createdAtMs, request.after.createdAtMs, request.after.id);
            }
            params.push(limit);
            // The statement is built by the same function the exported contract
            // is built from, so the advertised SQL and the executed SQL cannot
            // drift apart.
            const rows = await tx.query<ObligationRow>(
                buildAssignmentCleanupClaimPage(request.after !== null),
                params,
            );
            const claimed: AssignmentCleanupObligationRecord[] = [];
            for (const row of rows) {
                const currentVersion = requireSafeInt(row.claim_version, 'claim_version', row.id);
                const nextVersion = currentVersion + 1;
                // A version at the safe-integer ceiling cannot be incremented
                // without losing precision, which would weaken the fence.
                if (!Number.isSafeInteger(nextVersion)) return invalidRow('claim_version', row.id);
                const stamped = await tx.execute(
                    `UPDATE ${ASSIGNMENT_CLEANUP_TABLE}
                     SET claim_owner = ?, claim_version = ?, lease_until_ms = ?, updated_at_ms = ?
                     WHERE id = ? AND state = 'pending'
                       AND (claim_owner IS NULL OR lease_until_ms <= ?)`,
                    [request.owner, nextVersion, request.leaseUntilMs, request.nowMs, row.id, request.nowMs],
                );
                // Exactly one row: 0 means another writer won the stamp, and an
                // unreported count means we cannot tell — both must not be
                // reported as claimed.
                if (affectedRowsOf(stamped) !== 1) continue;
                claimed.push({
                    ...toRecord(row),
                    state: 'pending',
                    claimOwner: request.owner,
                    claimVersion: nextVersion,
                    leaseUntilMs: request.leaseUntilMs,
                    updatedAtMs: request.nowMs,
                });
            }
            return claimed;
        });
    };

    const completeClaim = async (request: AssignmentCleanupCompletionRequest): Promise<boolean> => {
        if (availability.mode === 'unavailable') return refuse();
        const result = await client.execute(
            `UPDATE ${ASSIGNMENT_CLEANUP_TABLE}
             SET state = ?, completion_proof = ?, claim_owner = NULL,
                 claim_version = claim_version + 1, lease_until_ms = NULL,
                 completed_at_ms = ?, updated_at_ms = ?
             WHERE id = ? AND state = 'pending' AND claim_owner = ? AND claim_version = ?
               AND lease_until_ms > ?`,
            [
                request.state,
                request.proof,
                request.nowMs,
                request.nowMs,
                request.id,
                request.owner,
                request.claimVersion,
                request.nowMs,
            ],
        );
        return affectedRowsOf(result) === 1;
    };

    const releaseClaim = async (request: AssignmentCleanupReleaseRequest): Promise<boolean> => {
        if (availability.mode === 'unavailable') return refuse();
        // A negative or non-integer retry delay would move the retry into the
        // past (or throw in the driver); clamp it to a whole, non-negative value
        // and keep the sum inside the safe-integer range.
        const retryAfterMs = Number.isSafeInteger(request.retryAfterMs) && request.retryAfterMs > 0
            ? request.retryAfterMs
            : 0;
        const retryAtMs = request.nowMs + retryAfterMs;
        if (!Number.isSafeInteger(retryAtMs)) {
            throw new Error('assignment cleanup release request has an out-of-range retry time');
        }
        const result = await client.execute(
            `UPDATE ${ASSIGNMENT_CLEANUP_TABLE}
             SET claim_owner = NULL, claim_version = claim_version + 1, lease_until_ms = NULL,
                 attempts = attempts + 1, last_failure = ?, retry_after_ms = ?, updated_at_ms = ?
             WHERE id = ? AND state = 'pending' AND claim_owner = ? AND claim_version = ?
               AND lease_until_ms > ?`,
            [
                request.failure,
                retryAtMs,
                request.nowMs,
                request.id,
                request.owner,
                request.claimVersion,
                request.nowMs,
            ],
        );
        return affectedRowsOf(result) === 1;
    };

    /**
     * Settle a row the request path recorded and finished itself.
     *
     * Three conditions make this safe against a claim that is current, past or
     * stolen:
     *
     *  - `state = 'pending'` — a coordinator that already settled the row wins.
     *  - `claim_owner IS NULL AND lease_until_ms IS NULL` — the pair is written
     *    together on claim and cleared together on release, so this rejects a
     *    live claim (owner set) as well as a claim whose lease has expired but
     *    was never released.
     *  - `claim_version = ?` — every claim, release and completion increments the
     *    version, so a claim that was taken and later released no longer matches
     *    the version this caller recorded. This is the condition that a coerced
     *    `claim_version` of `0` used to defeat; the projection now refuses such a
     *    row instead of producing a handle at all.
     */
    const completeUnclaimed = async (
        request: AssignmentCleanupUnclaimedCompletionRequest,
    ): Promise<boolean> => {
        if (availability.mode === 'unavailable') return refuse();
        const state: AssignmentCleanupTerminalState = cleanupStateForProof(request.proof);
        if (state !== request.state) return false;
        if (!Number.isSafeInteger(request.claimVersion) || request.claimVersion < 0) {
            throw new Error('assignment cleanup unclaimed completion has an invalid claimVersion');
        }
        const result = await client.execute(
            `UPDATE ${ASSIGNMENT_CLEANUP_TABLE}
             SET state = ?, completion_proof = ?, completed_at_ms = ?, updated_at_ms = ?
             WHERE id = ? AND state = 'pending'
               AND claim_owner IS NULL AND lease_until_ms IS NULL AND claim_version = ?`,
            [request.state, request.proof, request.nowMs, request.nowMs, request.id, request.claimVersion],
        );
        return affectedRowsOf(result) === 1;
    };

    return {
        availability,
        recordPending,
        claimBatch,
        completeClaim,
        releaseClaim,
        completeUnclaimed,
    };
};

/* ------------------------------------------------------------------------- */
/* Statement contract (exported for the migration owner, not executed here)   */
/* ------------------------------------------------------------------------- */

/**
 * The exact statements this adapter issues. Exported as data so the schema
 * contract can be reviewed against the code that will run it, instead of being
 * retyped into a document and drifting.
 */
export const ASSIGNMENT_CLEANUP_STATEMENTS = {
    insert: `INSERT INTO ${ASSIGNMENT_CLEANUP_TABLE}
  (id, tenant_id, assignment_id, student_enrollment_id, submission_id, storage_key,
   object_etag, object_size_bytes, reason, state, claim_owner, claim_version,
   lease_until_ms, attempts, last_failure, retry_after_ms, completion_proof,
   created_at_ms, updated_at_ms, completed_at_ms)
VALUES (?,?,?,?,?,?,?,?,?,'pending',NULL,0,NULL,0,NULL,NULL,NULL,?,?,NULL)
ON DUPLICATE KEY UPDATE id = id`,
    readByIdentity: `SELECT ${SELECT_COLUMNS} FROM ${ASSIGNMENT_CLEANUP_TABLE}
WHERE submission_id = ? AND object_etag = ? AND object_size_bytes = ?
LIMIT 1`,
    /** First page: no continuation predicate. */
    claimPage: buildAssignmentCleanupClaimPage(false),
    /** Continuation page: identical, plus the keyset predicate. */
    claimPageAfter: buildAssignmentCleanupClaimPage(true),
    stampClaim: `UPDATE ${ASSIGNMENT_CLEANUP_TABLE}
SET claim_owner = ?, claim_version = ?, lease_until_ms = ?, updated_at_ms = ?
WHERE id = ? AND state = 'pending'
  AND (claim_owner IS NULL OR lease_until_ms <= ?)`,
    completeClaim: `UPDATE ${ASSIGNMENT_CLEANUP_TABLE}
SET state = ?, completion_proof = ?, claim_owner = NULL,
    claim_version = claim_version + 1, lease_until_ms = NULL,
    completed_at_ms = ?, updated_at_ms = ?
WHERE id = ? AND state = 'pending' AND claim_owner = ? AND claim_version = ?
  AND lease_until_ms > ?`,
    releaseClaim: `UPDATE ${ASSIGNMENT_CLEANUP_TABLE}
SET claim_owner = NULL, claim_version = claim_version + 1, lease_until_ms = NULL,
    attempts = attempts + 1, last_failure = ?, retry_after_ms = ?, updated_at_ms = ?
WHERE id = ? AND state = 'pending' AND claim_owner = ? AND claim_version = ?
  AND lease_until_ms > ?`,
    completeUnclaimed: `UPDATE ${ASSIGNMENT_CLEANUP_TABLE}
SET state = ?, completion_proof = ?, completed_at_ms = ?, updated_at_ms = ?
WHERE id = ? AND state = 'pending'
  AND claim_owner IS NULL AND lease_until_ms IS NULL AND claim_version = ?`,
} as const;

/** Terminal states a completion may write, for a caller validating a proof. */
export const ASSIGNMENT_CLEANUP_TERMINAL_STATES: readonly AssignmentCleanupTerminalState[] = [
    'deleted',
    'superseded',
];

/** Proofs the adapter accepts, mirrored from the contract for the migration doc. */
export const ASSIGNMENT_CLEANUP_PROOF_VALUES: readonly AssignmentCleanupProof[] = [
    'store_removed',
    'store_already_absent',
    'pre_stat_absent',
    'store_version_replaced',
    'pre_stat_version_replaced',
];
