/**
 * M2-14 / M2-B08 — shared hermetic harness for the private student-import
 * suites, extended by M2-16 with the transactional commit fixture.
 *
 * This module is TEST-ONLY support. It provides:
 *   * positive import interception of the forbidden default modules
 *     (`src/db`, `src/services/minio`, `src/services/subscription-renewal`,
 *     `dotenv`) so the real production modules can be composed without a
 *     database, a provider, an environment file or a listener;
 *   * a synthetic fixture connection that answers ONLY the statements the real
 *     handlers issue: the two reconciliation statements (the owner verification
 *     and the chunked match read) and, since M2-16, the four commit statements
 *     (the batch/idempotency read with and without `FOR UPDATE`, the batch
 *     INSERT and the student INSERT). Every other statement — an unrelated
 *     read, an audit insert into another table — is refused loudly, so the
 *     written surface is an OBSERVABLE property rather than a promise;
 *   * a transactional connection whose writes are staged per connection and
 *     applied or discarded as a whole, so atomicity, rollback and commit
 *     uncertainty are observable, and whose locking read waits while another
 *     connection holds an open transaction, so concurrent same-key attempts
 *     serialize exactly as they do on the real unique index;
 *   * the real production composition (optional auth -> tenant-authority
 *     boundary -> student-workspace boundary -> real tenant-self router with
 *     the real student-import router mounted under `/student-import`) with only
 *     leaf data repositories and the connection injected;
 *   * request/response plumbing that drives the real Express chain without a
 *     socket.
 *
 * No production handler logic is copied here: the fixture only answers SQL.
 */
import assert from 'node:assert/strict';
import path from 'node:path';
import Module from 'node:module';
import jwt from 'jsonwebtoken';
import type { RequestHandler, Router } from 'express';

// ---------------------------------------------------------------------------
// Positive import interception
// ---------------------------------------------------------------------------

export const TEST_SECRET = 'm2-b08-hermetic-jwt-secret-not-a-real-key';

const normalize = (id: string) => path.resolve(id).toLowerCase();

export interface Isolation {
  /** Every interception that actually happened, in order. */
  interceptionLog: string[];
  /** Every forbidden default adapter that was CALLED (must stay empty). */
  sentinelCalls: string[];
  install(): void;
  restore(): void;
  /** Require one module while the sentinels are installed. */
  load(specifier: string): any;
  /** The resolved ids of the intercepted modules, for assertions. */
  interceptedIds(): string[];
  /** True when the CommonJS loader hook is back to the original. */
  hookRestored(): boolean;
}

export function createIsolation(): Isolation {
  const interceptionLog: string[] = [];
  const sentinelCalls: string[] = [];
  const originalLoad = (Module as any)._load;

  const violation = (name: string): never => {
    sentinelCalls.push(name);
    throw new Error(`HERMETIC_VIOLATION:${name}`);
  };

  const dbSentinel = {
    query: async (): Promise<any> => violation('db.query'),
    queryOne: async (): Promise<any> => violation('db.queryOne'),
    execute: async (): Promise<any> => violation('db.execute'),
    getPool: (): never => violation('db.getPool'),
  };
  const minioSentinel = {
    BUCKETS: { PAYMENT_PROOFS: 'payment-proofs', LECTURES: 'lectures' },
    uploadBuffer: async (): Promise<any> => violation('minio.uploadBuffer'),
    deleteFile: async (): Promise<any> => violation('minio.deleteFile'),
    getPrivateObjectUrl: async (): Promise<any> => violation('minio.getPrivateObjectUrl'),
  };
  const renewalSentinel = {
    executeRenewalIntent: async (): Promise<any> => violation('renewal.executeRenewalIntent'),
  };
  const dotenvSentinel = {
    config: (): never => violation('dotenv.config'),
  };

  const sentinelByPath = new Map<string, { id: string; exports: unknown }>();
  const register = (absolute: string, exports: unknown) => {
    const id = require.resolve(absolute);
    sentinelByPath.set(normalize(id), { id, exports });
  };

  // Resolved from THIS file: tests/helpers -> server/src/...
  register(path.join(__dirname, '../../src/db'), dbSentinel);
  register(path.join(__dirname, '../../src/services/minio'), minioSentinel);
  register(path.join(__dirname, '../../src/services/subscription-renewal'), renewalSentinel);
  register('dotenv', dotenvSentinel);

  const install = () => {
    (Module as any)._load = function (request: string, parent: any, isMain: boolean) {
      let resolved: string | null = null;
      if (parent && typeof parent.filename === 'string') {
        try { resolved = Module.createRequire(parent.filename).resolve(request); }
        catch { resolved = null; }
      }
      const hit = resolved ? sentinelByPath.get(normalize(resolved)) : undefined;
      if (hit) {
        interceptionLog.push(hit.id);
        return hit.exports;
      }
      return originalLoad.apply(this, [request, parent, isMain]);
    };
  };

  const restore = () => { (Module as any)._load = originalLoad; };

  const load = (specifier: string) => {
    install();
    try {
      return require(specifier);
    } finally {
      restore();
    }
  };

  return {
    interceptionLog,
    sentinelCalls,
    install,
    restore,
    load,
    interceptedIds: () => [...sentinelByPath.values()].map(entry => entry.id),
    hookRestored: () => (Module as any)._load === originalLoad,
  };
}

// ---------------------------------------------------------------------------
// Synthetic fixture state
// ---------------------------------------------------------------------------

export const TENANT_A = 'tenant-a';
export const TENANT_B = 'tenant-b';
export const TENANT_INACTIVE = 'tenant-inactive';
export const OWNER_A = 'owner-a';
export const OWNER_B = 'owner-b';
export const INSTRUCTOR_A = 'instructor-a';
export const ROLE_OWNER_MEMBER = 'role-owner-member-1';
export const BILLING_ONLY = 'billing-only-instructor-1';
export const MULTI = 'multi-1';
export const STUDENT = 'student-1';
export const ADMIN = 'admin-1';
export const NO_SCOPE = 'no-scope-1';

export interface TenantRow {
  id: string;
  business_name: string;
  subject_type: string | null;
  status: string;
  legacy_compat: number;
  owner_user_id: string;
}

export interface IdentityRow { is_active: number; token_version: number; suspension_active: number }

/**
 * One stored student row of a tenant.
 *
 * Only the three match columns and the two predicates the endpoint may read are
 * modelled for the reconciliation route; the commit route additionally writes
 * the four remaining accepted CSV fields, which are modelled as optional so a
 * reconciliation-only fixture stays honest about never reading them.
 */
export interface StudentRow {
  id: string;
  tenant_id: string;
  is_active: number;
  email: string | null;
  phone: string | null;
  barcode: string | null;
  name?: string;
  guardian_phone?: string | null;
  grade?: string | null;
}

/**
 * One committed import-batch/idempotency record.
 *
 * The sanitized audit record of the M2-16 commit: the tenant, the caller, the
 * opaque key, the canonical digest and the final result. It deliberately
 * carries no CSV value and no created student id.
 */
export interface BatchRecord {
  id: string;
  tenant_id: string;
  idempotency_key: string;
  payload_digest: string;
  created_count: number;
  row_numbers: number[];
  created_by: string;
}

/** One INSERT statement the fixture accepted, with its parsed table. */
export interface Write {
  table: string;
  sql: string;
  params: any[];
}

export interface State {
  users: Record<string, IdentityRow>;
  instructorAccounts: Record<string, { tenant_status: string; legacy_compat: number; allowed: number }>;
  memberships: Record<string, string[]>;
  tenantOwner: Record<string, string>;
  membershipRole: Record<string, string>;
  enrollments: Record<string, Array<{ id: string; user_id: string; tenant_id: string; instructor_id: string | null; group_id: string | null; grade_id: string | null }>>;
  tenants: TenantRow[];
  /** The stored student rows of every tenant. */
  students: StudentRow[];
  /** The committed import-batch/idempotency records of every tenant. */
  importBatches: BatchRecord[];
  failAcquire: boolean;
  failOwnerSelect: boolean;
  /** Fail the match read of ONE field, so the partial-progress case is real. */
  failMatchEmail: boolean;
  failMatchPhone: boolean;
  failMatchBarcode: boolean;
  /** A release that throws: it must be swallowed and must happen exactly once. */
  failRelease: boolean;
  /**
   * Emulate the case-insensitive column collation: the SQL answers a SUPERSET
   * (case-insensitive) instead of an exact match, so the application-level
   * exact comparison is observable.
   */
  collationSuperset: boolean;
  /** Emulate a deployment where the `students` table does not exist. */
  missingSchema: boolean;
  /** Fail `beginTransaction`, so no transaction is ever open. */
  failBegin: boolean;
  /** Fail `commit` itself: the outcome is UNKNOWN and must not become success. */
  failCommit: boolean;
  /** Fail `rollback`, so the session must be discarded instead of released. */
  failRollback: boolean;
  /** Fail the batch/idempotency read. */
  failBatchSelect: boolean;
  /** Fail the batch/audit INSERT. */
  failBatchInsert: boolean;
  /** Fail the student INSERT. */
  failStudentInsert: boolean;
  /**
   * Fail the Nth student INSERT (1-based) instead of the first, so a failure
   * that happens AFTER earlier rows were staged is observable.
   */
  failStudentInsertChunk: number;
}

export const identity = (): IdentityRow => ({ is_active: 1, token_version: 0, suspension_active: 0 });
export const activeAccount = () => ({ tenant_status: 'active', legacy_compat: 1, allowed: 1 });

export function makeState(): State {
  return {
    users: {
      [OWNER_A]: identity(), [OWNER_B]: identity(), [INSTRUCTOR_A]: identity(),
      [ROLE_OWNER_MEMBER]: identity(), [BILLING_ONLY]: identity(), [MULTI]: identity(),
      [STUDENT]: identity(), [ADMIN]: identity(), [NO_SCOPE]: identity(),
    },
    instructorAccounts: {
      [OWNER_A]: activeAccount(), [OWNER_B]: activeAccount(), [INSTRUCTOR_A]: activeAccount(),
      [ROLE_OWNER_MEMBER]: activeAccount(), [MULTI]: activeAccount(), [NO_SCOPE]: activeAccount(),
      [BILLING_ONLY]: { tenant_status: 'active', legacy_compat: 0, allowed: 0 },
    },
    memberships: {
      [OWNER_A]: [TENANT_A],
      [OWNER_B]: [TENANT_B],
      [INSTRUCTOR_A]: [TENANT_A],
      [ROLE_OWNER_MEMBER]: [TENANT_A],
      [BILLING_ONLY]: [TENANT_A],
      [MULTI]: [TENANT_A, TENANT_B],
      [STUDENT]: [],
      [ADMIN]: [],
      [NO_SCOPE]: [],
    },
    tenantOwner: {
      [TENANT_A]: OWNER_A,
      [TENANT_B]: OWNER_B,
    },
    membershipRole: {
      [`${INSTRUCTOR_A}@${TENANT_A}`]: 'instructor',
      [`${ROLE_OWNER_MEMBER}@${TENANT_A}`]: 'owner',
      [`${BILLING_ONLY}@${TENANT_A}`]: 'instructor',
      [`${MULTI}@${TENANT_A}`]: 'instructor',
      [`${MULTI}@${TENANT_B}`]: 'instructor',
    },
    enrollments: {
      [STUDENT]: [{ id: 'enrollment-1', user_id: STUDENT, tenant_id: TENANT_A, instructor_id: INSTRUCTOR_A, group_id: 'g-1', grade_id: 'gr-1' }],
    },
    tenants: [
      { id: TENANT_A, business_name: 'Synthetic Academy A', subject_type: 'institute', status: 'active', legacy_compat: 1, owner_user_id: OWNER_A },
      { id: TENANT_B, business_name: 'Synthetic Academy B', subject_type: 'institute', status: 'active', legacy_compat: 1, owner_user_id: OWNER_B },
      { id: TENANT_INACTIVE, business_name: 'Synthetic Academy C', subject_type: 'institute', status: 'suspended', legacy_compat: 1, owner_user_id: OWNER_A },
    ],
    /**
     * The stored records of TENANT_A and TENANT_B.
     *
     * `a2` deliberately stores the SAME email with different capitalisation as
     * `a1`, so a case-insensitive SQL filter is a superset that the application
     * must narrow to an exact match. `a3` carries a leading-zero phone. `a4` is
     * INACTIVE and must never match. `b1` carries the SAME email/phone/barcode
     * as `a1` in ANOTHER tenant and must never be visible to tenant A.
     */
    students: [
      { id: 'a1', tenant_id: TENANT_A, is_active: 1, email: 'a@x.com', phone: '0100', barcode: 'B1' },
      { id: 'a2', tenant_id: TENANT_A, is_active: 1, email: 'A@X.COM', phone: '0200', barcode: 'B2' },
      { id: 'a3', tenant_id: TENANT_A, is_active: 1, email: 'c@x.com', phone: '007', barcode: 'B3' },
      { id: 'a4', tenant_id: TENANT_A, is_active: 0, email: 'gone@x.com', phone: '0400', barcode: 'B4' },
      { id: 'a5', tenant_id: TENANT_A, is_active: 1, email: null, phone: '0500', barcode: null },
      { id: 'b1', tenant_id: TENANT_B, is_active: 1, email: 'a@x.com', phone: '0100', barcode: 'B1' },
    ],
    failAcquire: false,
    failOwnerSelect: false,
    failMatchEmail: false,
    failMatchPhone: false,
    failMatchBarcode: false,
    failRelease: false,
    collationSuperset: false,
    missingSchema: false,
    failBegin: false,
    failCommit: false,
    failRollback: false,
    failBatchSelect: false,
    failBatchInsert: false,
    failStudentInsert: false,
    failStudentInsertChunk: 0,
    importBatches: [],
  };
}

// ---------------------------------------------------------------------------
// The exact statements the real handler issues
// ---------------------------------------------------------------------------

export const squash = (sql: string) => sql.replace(/\s+/g, ' ').trim();

export const OWNER_SELECT =
  'SELECT t.owner_user_id,t.status AS tenant_status,u.is_active AS caller_active FROM tenants t JOIN users u ON u.id=? WHERE t.id=?';

/** The exact chunked match statement of one field and chunk size. */
export const matchSql = (field: string, count: number): string =>
  `SELECT ${field} AS value FROM students WHERE tenant_id=? AND is_active=1 AND ${field} IN (${Array.from({ length: count }, () => '?').join(',')})`;

/**
 * Recognise a match statement and recover its field and chunk size.
 *
 * Only the three documented fields are accepted: a handler that invented a
 * fourth match column would be refused here instead of silently passing.
 */
export const parseMatchSql = (sql: string): { field: string; count: number } | null => {
  const found = /^SELECT (email|phone|barcode) AS value FROM students WHERE tenant_id=\? AND is_active=1 AND (email|phone|barcode) IN \(([?,]+)\)$/.exec(sql);
  if (!found) return null;
  if (found[1] !== found[2]) return null;
  const count = found[3].split(',').length;
  return { field: found[1], count };
};

// ---------------------------------------------------------------------------
// M2-16 — the exact commit statements the real write handler issues
// ---------------------------------------------------------------------------

/** The batch/idempotency read, with or without the locking clause. */
export const BATCH_SELECT_RE =
  /^SELECT id,payload_digest,created_count FROM student_import_batches WHERE tenant_id=\? AND idempotency_key=\?( FOR UPDATE)?$/;

/** The batch/audit INSERT of exactly seven parameters. */
export const BATCH_INSERT_RE =
  /^INSERT INTO student_import_batches \(id,tenant_id,idempotency_key,payload_digest,created_count,row_numbers,created_by\) VALUES \(\?,\?,\?,\?,\?,\?,\?\)$/;

/**
 * The student INSERT of exactly the eight documented columns, in any number of
 * value tuples. A handler that invented a ninth column, or that wrote a
 * different column order, is refused here instead of silently passing.
 */
export const STUDENT_INSERT_RE =
  /^INSERT INTO students \(id,tenant_id,name,email,phone,guardian_phone,grade,barcode\) VALUES ((?:\(\?(?:,\?){7}\)(?:,\(\?(?:,\?){7}\))*))$/;

/** Parse the value tuples of a student INSERT into parameter groups of eight. */
export const parseStudentInsertParams = (params: any[]): any[][] => {
  const groups: any[][] = [];
  for (let offset = 0; offset < params.length; offset += 8) {
    groups.push(params.slice(offset, offset + 8));
  }
  return groups;
};

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

export interface Call { sql: string; params: any[] }

export interface Harness {
  chain: RequestHandler[];
  calls: Call[];
  events: string[];
  state: State;
  connectionCount: () => number;
  releaseCount: () => number;
  destroyCount: () => number;
  /** Every statement the fixture did NOT recognize: must always be empty. */
  mutations: () => string[];
  /** Every INSERT the fixture accepted, in issue order (M2-16). */
  writes: () => Write[];
  /** The INSERTs a `commit()` actually applied (M2-16). */
  appliedWrites: () => Write[];
  /** The INSERTs a `rollback()` discarded (M2-16). */
  discardedWrites: () => Write[];
  /** The committed batch/idempotency records (M2-16). */
  storedBatches: () => BatchRecord[];
  /** How many connections currently hold an open transaction (M2-16). */
  openTransactionCount: () => number;
}

export interface AppModules {
  auth: any;
  boundary: any;
  studentBoundary: any;
  tenantSelf: any;
  /** The production student-import router module itself (M2-16). */
  resolution: any;
}

/** Load the real production modules under the installed sentinels. */
export function loadAppModules(isolation: Isolation, tenantSelfSpecifier: string): AppModules {
  isolation.install();
  try {
    const auth = require(path.join(__dirname, '../../src/middleware/auth'));
    const boundary = require(path.join(__dirname, '../../src/middleware/tenant-authority-boundary'));
    const studentBoundary = require(path.join(__dirname, '../../src/middleware/student-workspace-boundary'));
    const tenantSelf = require(tenantSelfSpecifier);
    const resolution = require(path.join(__dirname, '../../src/routes/student-import-resolution'));
    return { auth, boundary, studentBoundary, tenantSelf, resolution };
  } finally {
    isolation.restore();
  }
}

export interface HarnessOptions {
  /**
   * `tenant-self` (default) mounts the real tenant-self router with the real
   * student-import router under it, so authority, the tenant boundary and the
   * mount are production code. `student-import` mounts ONLY the production
   * student-import router behind the same middleware chain, which is how a
   * deployment without the transactional seam is exercised.
   */
  mount?: 'tenant-self' | 'student-import';
  /** Bind the transactional commit seam. The default is true. */
  withCommitSeam?: boolean;
}

export function buildHarness(state: State, modules: AppModules, options: HarnessOptions = {}): Harness {
  const calls: Call[] = [];
  const events: string[] = [];
  const mutations: string[] = [];
  const writeLog: Write[] = [];
  const appliedWrites: Write[] = [];
  const discardedWrites: Write[] = [];
  let connectionCount = 0;
  let releaseCount = 0;
  let destroyCount = 0;

  /**
   * Connections currently holding an open transaction. A locking read
   * (`FOR UPDATE`) waits while ANOTHER connection holds one, which is how MySQL
   * serializes two concurrent same-key commit attempts.
   */
  const openTransactions = new Set<object>();
  /**
   * The idempotency keys currently locked by a locking read or a batch insert,
   * mapped to the connection that holds the lock.
   *
   * MySQL takes a gap lock for `SELECT ... FOR UPDATE` on a key that does not
   * exist yet, so two concurrent same-key attempts cannot both decide they are
   * the first writer: the second one waits for the first transaction to close
   * and then reads the committed record. The lock is per key, so attempts on
   * DIFFERENT keys (or different tenants) never wait for each other.
   */
  const keyLocks = new Map<string, object>();
  const acquireKeyLock = async (lockKey: string, token: object) => {
    const deadline = Date.now() + 2000;
    for (;;) {
      const holder = keyLocks.get(lockKey);
      if (holder === undefined || holder === token) {
        keyLocks.set(lockKey, token);
        return;
      }
      if (Date.now() > deadline) {
        throw new Error('hermetic fixture: idempotency key lock wait timed out (a transaction was never closed)');
      }
      await new Promise<void>(resolve => setTimeout(resolve, 2));
    }
  };
  const releaseKeyLocks = (token: object) => {
    for (const [lockKey, holder] of [...keyLocks]) {
      if (holder === token) keyLocks.delete(lockKey);
    }
  };

  /** The real MySQL error a missing table produces. */
  const missingTable = (): never => {
    const error: any = new Error("Table 'tabweb.students' doesn't exist");
    error.code = 'ER_NO_SUCH_TABLE';
    error.errno = 1146;
    throw error;
  };

  /** The real MySQL error a duplicate key produces. */
  const duplicateEntry = (): never => {
    const error: any = new Error("Duplicate entry for key 'students.email'");
    error.code = 'ER_DUP_ENTRY';
    error.errno = 1062;
    throw error;
  };

  const fieldFailure = (field: string): boolean => {
    if (field === 'email') return state.failMatchEmail;
    if (field === 'phone') return state.failMatchPhone;
    return state.failMatchBarcode;
  };

  /** The writes one connection has staged inside its open transaction. */
  const makePending = () => ({
    batches: [] as BatchRecord[],
    students: [] as StudentRow[],
    writes: [] as Write[],
  });

  /** How many student INSERT statements this harness has answered. */
  let harnessStudentInsertCount = 0;

  /**
   * The statement handler of ONE connection.
   *
   * Reads are answered exactly as before. The four M2-16 commit statements are
   * answered too, but only ever into the connection's own pending staging, so a
   * rollback makes them disappear and a commit applies the whole batch at once.
   * Anything else is still a contract violation and is refused loudly.
   */
  const makeExecute =
    (pending: ReturnType<typeof makePending>, token: object) =>
    async (sql: string, params: any[]): Promise<[any, any]> => {
      const n = squash(sql);
      calls.push({ sql, params });

      if (n === OWNER_SELECT) {
        events.push('owner');
        if (state.missingSchema) missingTable();
        if (state.failOwnerSelect) throw new Error('owner verification failed: internal detail leaked');
        const tenant = state.tenants.find(t => t.id === params[1]);
        const user = state.users[params[0]];
        if (!tenant || !user) return [[], []];
        return [[{
          owner_user_id: tenant.owner_user_id,
          tenant_status: tenant.status,
          caller_active: user.is_active,
        }], []];
      }

      const match = parseMatchSql(n);
      if (match) {
        events.push(`match:${match.field}`);
        if (state.missingSchema) missingTable();
        if (fieldFailure(match.field)) throw new Error(`match read failed on ${match.field}: internal detail leaked`);
        const tenantId = String(params[0]);
        const wanted = params.slice(1).map(value => String(value));
        const compare = state.collationSuperset
          ? (stored: string, value: string) => stored.toLowerCase() === value.toLowerCase()
          : (stored: string, value: string) => stored === value;
        const rows: any[] = [];
        for (const student of state.students) {
          if (student.tenant_id !== tenantId) continue;
          if (Number(student.is_active) !== 1) continue;
          const stored = student[match.field as 'email' | 'phone' | 'barcode'];
          if (typeof stored !== 'string') continue;
          if (wanted.some(value => compare(stored, value))) rows.push({ value: stored });
        }
        return [rows, []];
      }

      const batchSelect = BATCH_SELECT_RE.exec(n);
      if (batchSelect) {
        events.push('batch-select');
        if (state.missingSchema) missingTable();
        if (state.failBatchSelect) throw new Error('batch read failed: internal detail leaked');
        const tenantId = String(params[0]);
        const idempotencyKey = String(params[1]);
        if (batchSelect[1]) {
          // The locking read takes the key's gap lock, so a concurrent attempt
          // on the SAME key waits for this transaction to close and then reads
          // the committed record.
          await acquireKeyLock(`${tenantId}|${idempotencyKey}`, token);
        }
        const found =
          state.importBatches.find(
            record => record.tenant_id === tenantId && record.idempotency_key === idempotencyKey,
          ) ??
          pending.batches.find(
            record => record.tenant_id === tenantId && record.idempotency_key === idempotencyKey,
          );
        if (!found) return [[], []];
        return [[{
          id: found.id,
          payload_digest: found.payload_digest,
          created_count: found.created_count,
        }], []];
      }

      const batchInsert = BATCH_INSERT_RE.exec(n);
      if (batchInsert) {
        events.push('batch-insert');
        if (state.missingSchema) missingTable();
        if (state.failBatchInsert) throw new Error('batch insert failed: internal detail leaked');
        const [id, tenant_id, idempotency_key, payload_digest, created_count, row_numbers, created_by] =
          params.map(value => String(value));
        // The insert takes the same lock the locking read takes, so the unique
        // (tenant_id, idempotency_key) stays the serialization point.
        await acquireKeyLock(`${tenant_id}|${idempotency_key}`, token);
        // A concurrent attempt that already committed this key collides here.
        const clash = state.importBatches.some(
          record => record.tenant_id === tenant_id && record.idempotency_key === idempotency_key,
        );
        if (clash) duplicateEntry();
        pending.batches.push({
          id,
          tenant_id,
          idempotency_key,
          payload_digest,
          created_count: Number(created_count),
          row_numbers: JSON.parse(String(row_numbers)),
          created_by,
        });
        const batchWrite: Write = { table: 'student_import_batches', sql, params };
        writeLog.push(batchWrite);
        pending.writes.push(batchWrite);
        return [[{ affectedRows: 1, insertId: 0 }], []];
      }

      const studentInsert = STUDENT_INSERT_RE.exec(n);
      if (studentInsert) {
        events.push('student-insert');
        if (state.missingSchema) missingTable();
        // `failStudentInsertChunk` fails a LATER chunk, so rows that were
        // already staged by an earlier chunk have to be discarded by the
        // rollback: the atomicity of the batch is observable, not promised.
        if (state.failStudentInsert) throw new Error('student insert failed: internal detail leaked');
        if (
          state.failStudentInsertChunk > 0 &&
          harnessStudentInsertCount + 1 === state.failStudentInsertChunk
        ) {
          throw new Error('student insert failed on a later chunk: internal detail leaked');
        }
        harnessStudentInsertCount += 1;
        const groups = parseStudentInsertParams(params);
        for (const values of groups) {
          const [id, tenant_id, name, email, phone, guardian_phone, grade, barcode] = values;
          const cell = (value: unknown) =>
            value === null || value === undefined || value === '' ? null : String(value);
          // `students.email` and `students.barcode` are GLOBALLY unique in the
          // legacy baseline, so a value owned by ANOTHER tenant collides here
          // exactly as it does in production.
          for (const [field, value] of [['email', email], ['barcode', barcode]] as const) {
            const stored = cell(value);
            if (stored === null) continue;
            if (
              state.students.some(student => student[field] === stored) ||
              pending.students.some(student => student[field] === stored)
            ) {
              duplicateEntry();
            }
          }
          pending.students.push({
            id: String(id),
            tenant_id: String(tenant_id),
            is_active: 1,
            email: cell(email),
            phone: cell(phone),
            barcode: cell(barcode),
            name: String(name),
            guardian_phone: cell(guardian_phone),
            grade: cell(grade),
          });
        }
        const studentWrite: Write = { table: 'students', sql, params };
        writeLog.push(studentWrite);
        pending.writes.push(studentWrite);
        return [[{ affectedRows: groups.length, insertId: 0 }], []];
      }

      // Anything else — an unrelated read, an unknown mutation — is a contract
      // violation and is refused loudly.
      mutations.push(n);
      throw new Error(`Unhandled student import SQL in hermetic fixture: ${n}`);
    };

  const makeConnection = () => {
    connectionCount += 1;
    const token = {};
    const pending = makePending();
    return {
      // Present so an accidental transaction attempt is observable: the module
      // must never open one on the reconciliation path, and `events`/`writes`
      // would show it.
      beginTransaction: async () => {
        events.push('begin');
        if (state.failBegin) throw new Error('begin transaction failed: internal detail leaked');
        openTransactions.add(token);
      },
      commit: async () => {
        events.push('commit');
        if (state.failCommit) throw new Error('commit failed: outcome unknown: internal detail leaked');
        // The whole batch lands together: the batch record and the students.
        for (const record of pending.batches) state.importBatches.push(record);
        for (const student of pending.students) state.students.push(student);
        for (const write of pending.writes) appliedWrites.push(write);
        pending.batches.length = 0;
        pending.students.length = 0;
        pending.writes.length = 0;
        openTransactions.delete(token);
        releaseKeyLocks(token);
      },
      rollback: async () => {
        events.push('rollback');
        if (state.failRollback) throw new Error('rollback failed: internal detail leaked');
        // The whole batch is discarded: a partial batch never exists.
        for (const write of pending.writes) discardedWrites.push(write);
        pending.batches.length = 0;
        pending.students.length = 0;
        pending.writes.length = 0;
        openTransactions.delete(token);
        releaseKeyLocks(token);
      },
      execute: makeExecute(pending, token),
      release: () => {
        events.push('release');
        releaseCount += 1;
        if (state.failRelease) throw new Error('release failed: internal detail leaked');
      },
      destroy: () => {
        events.push('destroy');
        destroyCount += 1;
        openTransactions.delete(token);
        releaseKeyLocks(token);
      },
    };
  };

  const db = {
    query: async (): Promise<any> => { throw new Error('HERMETIC_VIOLATION:db.query not expected'); },
    queryOne: async (): Promise<any> => { throw new Error('HERMETIC_VIOLATION:db.queryOne not expected'); },
    execute: async (): Promise<any> => { throw new Error('HERMETIC_VIOLATION:db.execute not expected'); },
    getConnection: async () => {
      if (state.failAcquire) throw new Error('pool connection unavailable: internal detail leaked');
      return makeConnection();
    },
  };

  const repository = {
    findUsersIdentity: async (id: string) => state.users[id] ?? null,
    findStaffIdentity: async () => null,
    findInstructorAccount: async (id: string) => state.instructorAccounts[id] ?? null,
    findStudentEnrollments: async (id: string) => state.enrollments[id] ?? [],
    findActiveTenantMemberships: async (id: string) => (state.memberships[id] ?? []).map(tenant_id => ({ tenant_id })),
  };

  const loadActiveTenantAuthority = async (userId: string, tenantId: string) => {
    const tenant = state.tenants.find(t => t.id === tenantId);
    if (!tenant || tenant.status !== 'active') return null;
    if (state.tenantOwner[tenantId] === userId) {
      return state.users[userId]?.is_active === 1 ? { authority: 'owner' } : null;
    }
    const role = state.membershipRole[`${userId}@${tenantId}`];
    if (role === 'owner' || role === 'instructor') return { authority: role };
    return null;
  };

  // The terminal router under test. The default is the real production mount;
  // the direct mount exercises the production student-import router alone,
  // including a deployment without the transactional seam.
  const terminalRouter: Router =
    options.mount === 'student-import'
      ? modules.resolution.createStudentImportResolutionRouter(
          options.withCommitSeam === false
            ? { getConnection: db.getConnection }
            : { getConnection: db.getConnection, getCommitConnection: db.getConnection },
        )
      : modules.tenantSelf.createTenantSelfRouter({
          db,
          authenticate: modules.auth.createAuthenticateToken(repository),
          loadActiveTenantAuthority,
          uploadBuffer: async () => { throw new Error('HERMETIC_VIOLATION:injected.uploadBuffer'); },
          deleteFile: async () => { throw new Error('HERMETIC_VIOLATION:injected.deleteFile'); },
          getPrivateObjectUrl: async () => { throw new Error('HERMETIC_VIOLATION:injected.getPrivateObjectUrl'); },
          executeRenewalIntent: async () => { throw new Error('HERMETIC_VIOLATION:injected.executeRenewalIntent'); },
        });

  const chain: RequestHandler[] = [
    modules.auth.createOptionalAuth(repository),
    modules.boundary.enforceTenantAuthorityBoundary,
    modules.studentBoundary.enforceStudentWorkspaceBoundary,
    terminalRouter,
  ];

  return {
    chain,
    calls,
    events,
    state,
    connectionCount: () => connectionCount,
    releaseCount: () => releaseCount,
    destroyCount: () => destroyCount,
    mutations: () => [...mutations],
    writes: () => [...writeLog],
    appliedWrites: () => [...appliedWrites],
    discardedWrites: () => [...discardedWrites],
    storedBatches: () => state.importBatches.map(record => ({ ...record })),
    openTransactionCount: () => openTransactions.size,
  };
}

// ---------------------------------------------------------------------------
// Request/response plumbing (no listener, no socket)
// ---------------------------------------------------------------------------

export interface Result { status: number; body: any; headers: Record<string, string>; handlerReached: boolean; responseCount: number }

export interface ReqOptions {
  token?: string | null;
  method?: string;
  pathName?: string;
  query?: any;
  body?: any;
  headers?: Record<string, string>;
}

export const RESOLVE_PATH = '/student-import/resolve';

export function makeReq(opts: ReqOptions = {}) {
  const headers: Record<string, string> = {};
  if (opts.token) headers.authorization = `Bearer ${opts.token}`;
  for (const [key, value] of Object.entries(opts.headers ?? {})) headers[key.toLowerCase()] = value;
  const pathName = opts.pathName ?? RESOLVE_PATH;
  return {
    method: opts.method ?? 'POST',
    url: pathName,
    originalUrl: `/api/tenants/me${pathName}`,
    path: pathName,
    headers,
    query: opts.query ?? {},
    body: opts.body ?? {},
    params: {},
    header(name: string) { return headers[name.toLowerCase()]; },
  };
}

export function runChain(chain: RequestHandler[], req: any): Promise<Result> {
  return new Promise((resolve, reject) => {
    let index = 0;
    let settled = false;
    let responseCount = 0;
    const finish = (result: Result) => { if (!settled) { settled = true; resolve(result); } };

    const headers: Record<string, string> = {};
    const res: any = {
      statusCode: 200,
      status(code: number) { res.statusCode = code; return res; },
      set(name: string, value: string) { headers[name] = value; headers[name.toLowerCase()] = value; return res; },
      setHeader(name: string, value: string) { headers[name] = value; headers[name.toLowerCase()] = value; return res; },
      json(payload: any) { responseCount += 1; finish({ status: res.statusCode, body: payload, headers, handlerReached: true, responseCount }); return res; },
      send(payload: any) { responseCount += 1; finish({ status: res.statusCode, body: payload, headers, handlerReached: true, responseCount }); return res; },
      end() { responseCount += 1; finish({ status: res.statusCode, body: undefined, headers, handlerReached: true, responseCount }); return res; },
    };

    const next = (error?: any) => {
      if (error) { if (!settled) { settled = true; reject(error); } return; }
      const middleware = chain[index++];
      if (!middleware) {
        finish({ status: 0, body: undefined, headers, handlerReached: false, responseCount });
        return;
      }
      try {
        const outcome = (middleware as any)(req, res, next);
        if (outcome && typeof outcome.then === 'function') outcome.catch(next);
      } catch (error) {
        next(error);
      }
    };

    next();
  });
}

export const sign = (id: string, role: string, extra: Record<string, unknown> = {}, options: jwt.SignOptions = {}) =>
  jwt.sign({ id, role, tv: 0, ...extra }, TEST_SECRET, { expiresIn: '5m', ...options });

export const withSilencedErrors = async <T>(fn: () => Promise<T>): Promise<T> => {
  const original = console.error;
  console.error = () => undefined;
  try { return await fn(); } finally { console.error = original; }
};

export const ownerToken = () => sign(OWNER_A, 'instructor');
export const ownerBToken = () => sign(OWNER_B, 'instructor');

/** One request row, with the exact four documented keys. */
export const row = (row_number: number, email = '', phone = '', barcode = '') =>
  ({ row_number, email, phone, barcode });

/** A well-formed body around a set of rows. */
export const body = (rows: any[]) => ({ rows });

/**
 * A resolve request. `pathName` defaults to the mounted path; the direct mount
 * (`buildHarness(state, modules, { mount: 'student-import' })`) serves the
 * router at the chain root, so those tests pass `/resolve`.
 */
export const resolveReq = (payload: any, token: string | null = ownerToken(), pathName: string = RESOLVE_PATH) =>
  makeReq({ token, method: 'POST', pathName, body: payload });

/** Assert the response DTO is exactly the documented shape. */
export const assertEnvelope = (payload: any) => {
  assert.deepEqual(Object.keys(payload).sort(), ['rows', 'summary']);
  assert.ok(Array.isArray(payload.rows));
  assert.deepEqual(Object.keys(payload.summary).sort(), ['checked', 'clear', 'matched']);
  for (const entry of payload.rows) {
    assert.deepEqual(Object.keys(entry).sort(), ['matched_fields', 'row_number']);
    assert.ok(Array.isArray(entry.matched_fields));
    for (const field of entry.matched_fields) {
      assert.ok(['email', 'phone', 'barcode'].includes(field), `unexpected matched field ${field}`);
    }
    // The documented deterministic subset order.
    const order = ['email', 'phone', 'barcode'];
    const indexes = entry.matched_fields.map((field: string) => order.indexOf(field));
    assert.deepEqual(indexes, [...indexes].sort((a, b) => a - b), 'matched_fields must follow email,phone,barcode');
  }
};

// ---------------------------------------------------------------------------
// M2-16 — the commit request/response helpers
// ---------------------------------------------------------------------------

export const COMMIT_PATH = '/student-import/commit';

/** A well-formed opaque idempotency key of the accepted shape. */
export const importKey = (seed = 'k') =>
  `${seed}-${'0'.repeat(24)}`.slice(0, 32).padEnd(16, 'x');

/**
 * One commit row, with the exact seven documented keys.
 *
 * The default values are already trimmed, in bounds and free of leading zeros
 * problems, so a test that changes one cell changes exactly one thing.
 */
export const commitRow = (
  row_number: number,
  {
    name = `Student ${row_number}`,
    email = '',
    phone = '',
    guardian_phone = '',
    grade = '',
    barcode = '',
  }: {
    name?: string;
    email?: string;
    phone?: string;
    guardian_phone?: string;
    grade?: string;
    barcode?: string;
  } = {},
) => ({ row_number, name, email, phone, guardian_phone, grade, barcode });

/** A well-formed commit body around a set of rows and a key. */
export const commitBody = (rows: any[], idempotency_key: string = importKey()) => ({
  idempotency_key,
  rows,
});

/**
 * A commit request. `pathName` defaults to the mounted path; the direct mount
 * (`buildHarness(state, modules, { mount: 'student-import' })`) serves the
 * router at the chain root, so those tests pass `/commit`.
 */
export const commitReq = (
  payload: any,
  token: string | null = ownerToken(),
  pathName: string = COMMIT_PATH,
) => makeReq({ token, method: 'POST', pathName, body: payload });

/** Assert the commit response DTO is exactly the documented shape. */
export const assertCommitEnvelope = (payload: any) => {
  assert.deepEqual(Object.keys(payload).sort(), ['batch_id', 'created', 'replayed', 'row_numbers']);
  assert.equal(typeof payload.batch_id, 'string');
  assert.equal(typeof payload.replayed, 'boolean');
  assert.equal(typeof payload.created, 'number');
  assert.ok(Array.isArray(payload.row_numbers));
  for (const rowNumber of payload.row_numbers) {
    assert.equal(typeof rowNumber, 'number');
    assert.ok(Number.isInteger(rowNumber));
  }
  // No created student id, no stored value and no identity may appear.
  assert.equal(payload.students, undefined);
  assert.equal(payload.ids, undefined);
};

/**
 * Assert that the only tables ever written were the two documented ones.
 *
 * `users`, `enrollments`, `payments`, `accounts` and every other table are
 * outside this endpoint's contract, so a write to any of them is a failure even
 * if the endpoint happened to succeed.
 */
export const assertOnlyDocumentedWrites = (harness: Harness) => {
  for (const write of harness.writes()) {
    assert.ok(
      write.table === 'student_import_batches' || write.table === 'students',
      `unexpected write to ${write.table}: ${write.sql}`,
    );
  }
};
