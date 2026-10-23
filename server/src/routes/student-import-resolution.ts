/**
 * M2-14 / M2-B08 — private READ-ONLY server reconciliation for the local student
 * CSV preview.
 *
 * Scope (`docs/streams/client/M2-14-HANDOFF.md`): the accepted M2-08/M2-11
 * preview can flag WITHIN-FILE duplicate candidates, and the accepted decisions
 * can prepare an inclusion set, but neither can say anything about records that
 * already exist in the platform. This module answers exactly that one question
 * for the owner of the server-selected tenant:
 *
 *   "of the rows I am about to include, which ones carry an email / phone /
 *    barcode that ALREADY exists in my own tenant?"
 *
 * What this endpoint is NOT, and never does:
 *  - it is a POST that performs READS ONLY: there is no INSERT/UPDATE/DELETE,
 *    no transaction, no audit event, no import commit, no account creation, no
 *    password/OTP, no enrollment and no assignment anywhere in this file;
 *  - it never returns an existing record's identity or data. The response
 *    carries a row number and the NAMES of the matched fields only — never a
 *    student id, user id, name, stored contact value or any other private
 *    value, and the projection below never even SELECTs those columns;
 *  - it does not normalize, casefold, merge, link accounts or claim that a
 *    match is an identity. Two different records may match different fields of
 *    one request row, and that is reported as-is without inventing a canonical
 *    identity;
 *  - it establishes no new uniqueness policy: an overlap here is a warning the
 *    owner reads, not a rejection and not an approval to overwrite anything.
 *
 * Matching semantics are deliberately exact:
 *  - the SQL is only a CANDIDATE FILTER. The columns use a case-insensitive
 *    collation, so `WHERE email IN (...)` can return a SUPERSET (a stored
 *    `A@X.com` for a requested `a@x.com`). The application therefore confirms
 *    EXACT string equality against the requested value before reporting a
 *    match, so case, leading zeros and `+` are preserved and never normalized;
 *  - only active students of the SELECTED tenant are read, and the tenant is
 *    always qualified by the server-selected id — never by a client selector.
 *
 * Cost is bounded and linear:
 *  - the request is capped at 1000 rows of three values each, every value is
 *    capped at 4096 characters, and an explicit TOTAL character bound is
 *    enforced before any data access;
 *  - the distinct values per field are deduplicated and read in CHUNKS with
 *    parameterized `IN (...)` lists, so the number of statements is a function
 *    of the bounded value count (at most 3 fields x 5 chunks) and never of the
 *    row count: there is no per-row query (N+1) and no per-row scan of the
 *    result set (quadratic).
 *
 * ---------------------------------------------------------------------------
 * M2-16 — the audited idempotent student-row import (WRITE), added BESIDE the
 * reconciliation above, never replacing it.
 *
 * `POST /student-import/commit` is the only mutation in this file. It takes the
 * same owner/tenant authority boundary, re-validates the SAME three exact
 * values inside the transaction, and refuses the WHOLE batch when any nonblank
 * value already exists for this tenant. What it creates is bounded by design:
 *  - it writes STUDENT ROWS ONLY: id (server-generated UUID), tenant_id
 *    (server-selected), name, email, phone, guardian_phone, grade and barcode.
 *    No other column is written, so no account, login, password, invitation,
 *    OTP, enrollment, group/course/branch, payment or access column can be
 *    touched — the insert's column list is exactly those eight;
 *  - it writes ONE sanitized import-batch record: the tenant, the caller, the
 *    opaque idempotency key, the canonical payload digest, the created count
 *    and the submitted row numbers. No CSV value, no created student id and
 *    no existing-record identity is stored or returned;
 *  - students and the batch record commit ATOMICALLY: any failure rolls the
 *    whole batch back, so a partial batch never exists;
 *  - the TRANSACTION OPENS BEFORE the owner-authority read, and that read and
 *    every recheck and write after it share ONE transaction on ONE connection.
 *    An ownership change, a suspension or a caller revocation that lands
 *    between the authorization and the write therefore cannot slip through;
 *  - idempotency: the same tenant, the same key and the same digest returns
 *    the recorded result WITHOUT another insert; the same key with a different
 *    digest is a conflict. A key is minted by the client as an unpredictable
 *    opaque token, and an uncertain commit is never turned into a success.
 */
import { Router } from 'express';
import type { Response } from 'express';
import type { AuthRequest } from '../middleware/auth';
import { createHash, randomUUID } from 'crypto';

/**
 * The transactional connection seam used by the commit route ONLY.
 *
 * The reconciliation route never asks for this: it takes
 * `StudentImportResolutionConnection` and therefore cannot open a transaction
 * even by mistake. `destroy` exists because a commit whose outcome is UNKNOWN
 * must not be returned to the pool — the session may still hold an open
 * transaction that only the pool owner can be certain about.
 */
export interface StudentImportCommitConnection {
  execute(sql: string, params?: any[]): Promise<[any, any]>;
  beginTransaction(): Promise<void>;
  commit(): Promise<void>;
  rollback(): Promise<void>;
  release(): void;
  destroy(): void;
}

/**
 * The minimal read-only connection seam the reconciliation route needs.
 *
 * It is deliberately NARROWER than the tenant-self connection: a reconciliation
 * is a read, so this module never asks for `beginTransaction`/`commit`/
 * `rollback` and cannot start a transaction even by mistake — and it never asks
 * for `destroy` either, because with no transaction open there is no uncertain
 * transaction state to discard. Production binds the real pooled connection;
 * the hermetic tests bind a fixture.
 */
export interface StudentImportResolutionConnection {
  execute(sql: string, params?: any[]): Promise<[any, any]>;
  release(): void;
}

export interface StudentImportResolutionDeps {
  getConnection: () => Promise<StudentImportResolutionConnection>;
  /**
   * The transactional supplier used by the commit route only. When it is
   * absent the commit route is refused with 503 — the caller never falls back
   * to the read-only seam, because a write needs a transaction.
   */
  getCommitConnection?: () => Promise<StudentImportCommitConnection>;
}

/** The maximum number of request rows. */
export const STUDENT_IMPORT_RESOLUTION_MAX_ROWS = 1000;
/** The physical line of the first data record of an accepted CSV file. */
export const STUDENT_IMPORT_RESOLUTION_MIN_ROW_NUMBER = 2;
/** The physical line of the last possible data record (1000 records). */
export const STUDENT_IMPORT_RESOLUTION_MAX_ROW_NUMBER = 1001;
/** The maximum number of characters in one submitted value. */
export const STUDENT_IMPORT_RESOLUTION_MAX_VALUE_CHARS = 4096;
/**
 * The explicit TOTAL value-character bound of one request.
 *
 * The accepted parser caps the whole source file at 1 MiB, so a legitimate
 * payload is far below this; the bound exists to refuse an oversized body
 * BEFORE any statement is prepared, instead of letting the structural maximum
 * (1000 x 3 x 4096 characters) define the worst case.
 */
export const STUDENT_IMPORT_RESOLUTION_MAX_TOTAL_CHARS = 2 * 1024 * 1024;
/** The number of distinct values read per statement. */
export const STUDENT_IMPORT_RESOLUTION_CHUNK = 200;

/**
 * The three exact match fields, in their DOCUMENTED subset order. The order of
 * `matched_fields` is derived from this array and is therefore deterministic.
 */
export const STUDENT_IMPORT_RESOLUTION_FIELDS = ['email', 'phone', 'barcode'] as const;
export type StudentImportResolutionField = (typeof STUDENT_IMPORT_RESOLUTION_FIELDS)[number];

/** The exact four keys of one request row. */
export const STUDENT_IMPORT_RESOLUTION_ROW_KEYS = ['row_number', 'email', 'phone', 'barcode'] as const;

export interface StudentImportResolutionRequestRow {
  row_number: number;
  email: string;
  phone: string;
  barcode: string;
}

/** The exact response DTO of one request row: a number and field NAMES only. */
export interface StudentImportResolutionResultRow {
  row_number: number;
  matched_fields: StudentImportResolutionField[];
}

export interface StudentImportResolutionSummary {
  checked: number;
  matched: number;
  clear: number;
}

// ---------------------------------------------------------------------------
// M2-16 — the commit contract
// ---------------------------------------------------------------------------

/**
 * The exact seven keys of one committed row, in the canonical order.
 *
 * This is the column list of the student insert too, so the request shape, the
 * payload digest and the write are the same contract: a row that carries a
 * selector, a status, an id or any other field is malformed and refused.
 */
export const STUDENT_IMPORT_COMMIT_ROW_KEYS = [
  'row_number',
  'name',
  'email',
  'phone',
  'guardian_phone',
  'grade',
  'barcode',
] as const;
export type StudentImportCommitRowKey = (typeof STUDENT_IMPORT_COMMIT_ROW_KEYS)[number];

export interface StudentImportCommitRequestRow {
  row_number: number;
  name: string;
  email: string;
  phone: string;
  guardian_phone: string;
  grade: string;
  barcode: string;
}

/**
 * The exact INSERT column list of the student write.
 *
 * Eight columns: the server-generated id, the server-selected tenant and the
 * six accepted CSV fields. NOTHING else is written, so no account, login,
 * password, invitation, OTP, enrollment, group/course/branch, payment or access
 * column can be touched by this endpoint — the default values of every other
 * column are the schema's own, never this endpoint's decision.
 */
export const STUDENT_IMPORT_COMMIT_STUDENT_COLUMNS = [
  'id',
  'tenant_id',
  'name',
  'email',
  'phone',
  'guardian_phone',
  'grade',
  'barcode',
] as const;

/** The maximum number of rows in one batch. */
export const STUDENT_IMPORT_COMMIT_MAX_ROWS = 1000;
/** The physical line of the first data record of an accepted CSV file. */
export const STUDENT_IMPORT_COMMIT_MIN_ROW_NUMBER = 2;
/** The physical line of the last possible data record. */
export const STUDENT_IMPORT_COMMIT_MAX_ROW_NUMBER = 1001;
/** The number of rows written per INSERT statement. */
export const STUDENT_IMPORT_COMMIT_INSERT_CHUNK = 200;

/** The accepted bounds of one idempotency key. */
export const STUDENT_IMPORT_COMMIT_KEY_MIN_CHARS = 16;
export const STUDENT_IMPORT_COMMIT_KEY_MAX_CHARS = 128;
/**
 * An opaque, URL-safe, bounded key. A predictable or short key is refused: a
 * guessable key would let an unrelated batch be replayed into this tenant.
 */
export const STUDENT_IMPORT_COMMIT_KEY_PATTERN = /^[A-Za-z0-9_-]{16,128}$/;

/**
 * The per-column character bounds of the destination table.
 *
 * They are the schema's own VARCHAR widths, mirrored here so a well-formed
 * request can never be refused by the database for a length the application
 * could have refused first — and so no value is ever truncated silently.
 */
export const STUDENT_IMPORT_COMMIT_VALUE_BOUNDS: Record<
  Exclude<StudentImportCommitRowKey, 'row_number'>,
  number
> = {
  name: 255,
  email: 255,
  phone: 50,
  guardian_phone: 50,
  grade: 100,
  barcode: 50,
};

/** The documented server codes of the commit outcomes. */
export const STUDENT_IMPORT_COMMIT_CODE_EXISTING_MATCH = 'STUDENT_IMPORT_EXISTING_MATCH';
export const STUDENT_IMPORT_COMMIT_CODE_IDEMPOTENCY_CONFLICT = 'STUDENT_IMPORT_IDEMPOTENCY_CONFLICT';
export const STUDENT_IMPORT_COMMIT_CODE_VALUE_CONFLICT = 'STUDENT_IMPORT_VALUE_CONFLICT';
export const STUDENT_IMPORT_COMMIT_CODE_COMMIT_UNCERTAIN = 'STUDENT_IMPORT_COMMIT_UNCERTAIN';
export const STUDENT_IMPORT_COMMIT_CODE_COMMIT_UNAVAILABLE = 'STUDENT_IMPORT_COMMIT_UNAVAILABLE';

/** The exact response DTO of one committed batch. */
export interface StudentImportCommitResponse {
  batch_id: string;
  replayed: boolean;
  created: number;
  row_numbers: number[];
}

const hasOwn = (value: object, key: string): boolean => Object.prototype.hasOwnProperty.call(value, key);

/** A plain object: not null, not an array. */
const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * Validates one submitted value.
 *
 * A value must be a STRING, must be already trimmed (the accepted parser trims
 * every cell, so an untrimmed value is not one of ours and is refused rather
 * than silently normalized) and must fit the per-value bound. An empty string
 * is legal: it means "this field is absent for this row".
 */
const parseValue = (raw: unknown): string | null => {
  if (typeof raw !== 'string') return null;
  if (raw.length > STUDENT_IMPORT_RESOLUTION_MAX_VALUE_CHARS) return null;
  if (raw !== raw.trim()) return null;
  return raw;
};

interface ParsedRequest {
  rows: StudentImportResolutionRequestRow[];
}

/**
 * The strict request parser. It runs BEFORE any connection is taken and refuses
 * a malformed key set, a malformed type, an out-of-bound row number, a repeated
 * row number, an out-of-bound value and an oversized total.
 */
const parseRequest = (body: unknown): ParsedRequest | null => {
  if (!isPlainObject(body)) return null;
  const keys = Object.keys(body);
  if (keys.length !== 1 || keys[0] !== 'rows') return null;
  const rawRows = body.rows;
  if (!Array.isArray(rawRows)) return null;
  if (rawRows.length < 1 || rawRows.length > STUDENT_IMPORT_RESOLUTION_MAX_ROWS) return null;

  const rows: StudentImportResolutionRequestRow[] = [];
  const seen = new Set<number>();
  let totalChars = 0;

  for (const rawRow of rawRows) {
    if (!isPlainObject(rawRow)) return null;
    const rowKeys = Object.keys(rawRow);
    // Exactly the four documented keys: a selector, a name, a guardian phone or
    // any other extra field is a malformed request, not something to ignore.
    if (rowKeys.length !== STUDENT_IMPORT_RESOLUTION_ROW_KEYS.length) return null;
    for (const key of STUDENT_IMPORT_RESOLUTION_ROW_KEYS) {
      if (!hasOwn(rawRow, key)) return null;
    }
    const rowNumber = rawRow.row_number;
    if (typeof rowNumber !== 'number' || !Number.isInteger(rowNumber)) return null;
    if (rowNumber < STUDENT_IMPORT_RESOLUTION_MIN_ROW_NUMBER) return null;
    if (rowNumber > STUDENT_IMPORT_RESOLUTION_MAX_ROW_NUMBER) return null;
    if (seen.has(rowNumber)) return null;
    seen.add(rowNumber);

    const email = parseValue(rawRow.email);
    const phone = parseValue(rawRow.phone);
    const barcode = parseValue(rawRow.barcode);
    if (email === null || phone === null || barcode === null) return null;
    // A row that carries nothing is not a reconciliation candidate.
    if (email === '' && phone === '' && barcode === '') return null;

    totalChars += email.length + phone.length + barcode.length;
    if (totalChars > STUDENT_IMPORT_RESOLUTION_MAX_TOTAL_CHARS) return null;

    rows.push({ row_number: rowNumber, email, phone, barcode });
  }

  return { rows };
};


// ---------------------------------------------------------------------------
// M2-16 — the commit request parser and the canonical payload
// ---------------------------------------------------------------------------

interface ParsedCommitRequest {
  idempotencyKey: string;
  rows: StudentImportCommitRequestRow[];
}

/**
 * Validates one submitted commit value against the DESTINATION column bound.
 *
 * The value must be a STRING, must already be trimmed (the accepted parser
 * trims every cell, so an untrimmed value is not one of ours and is refused
 * rather than silently normalized) and must fit the mirrored VARCHAR width of
 * the column it is written to. An empty string is legal and means "absent";
 * it is written as NULL, never as a blank value.
 */
const parseCommitValue = (
  raw: unknown,
  key: Exclude<StudentImportCommitRowKey, 'row_number'>,
): string | null => {
  if (typeof raw !== 'string') return null;
  if (raw !== raw.trim()) return null;
  if (raw.length > STUDENT_IMPORT_COMMIT_VALUE_BOUNDS[key]) return null;
  return raw;
};

/**
 * The strict commit request parser. It runs BEFORE any connection is taken.
 *
 * Refused: a malformed key set (exactly `idempotency_key` and `rows`), a key
 * that is not an opaque bounded token, an empty or oversized batch, a row with
 * a malformed key set or type, an out-of-bound or repeated row number, an
 * untrimmed or over-bound value, an empty required name, and a repeated
 * NONBLANK email/phone/barcode INSIDE the batch (a within-file duplicate would
 * collide on the destination's unique columns and is refused here instead of
 * being diagnosed by the database).
 */
const parseCommitRequest = (body: unknown): ParsedCommitRequest | null => {
  if (!isPlainObject(body)) return null;
  const keys = Object.keys(body);
  if (keys.length !== 2) return null;
  if (!hasOwn(body, 'idempotency_key') || !hasOwn(body, 'rows')) return null;

  const idempotencyKey = body.idempotency_key;
  if (typeof idempotencyKey !== 'string') return null;
  if (!STUDENT_IMPORT_COMMIT_KEY_PATTERN.test(idempotencyKey)) return null;

  const rawRows = body.rows;
  if (!Array.isArray(rawRows)) return null;
  if (rawRows.length < 1 || rawRows.length > STUDENT_IMPORT_COMMIT_MAX_ROWS) return null;

  const rows: StudentImportCommitRequestRow[] = [];
  const seenRowNumbers = new Set<number>();
  const seenValues: Record<'email' | 'phone' | 'barcode', Set<string>> = {
    email: new Set<string>(),
    phone: new Set<string>(),
    barcode: new Set<string>(),
  };

  for (const rawRow of rawRows) {
    if (!isPlainObject(rawRow)) return null;
    const rowKeys = Object.keys(rawRow);
    if (rowKeys.length !== STUDENT_IMPORT_COMMIT_ROW_KEYS.length) return null;
    for (const rowKey of STUDENT_IMPORT_COMMIT_ROW_KEYS) {
      if (!hasOwn(rawRow, rowKey)) return null;
    }

    const rowNumber = rawRow.row_number;
    if (typeof rowNumber !== 'number' || !Number.isInteger(rowNumber)) return null;
    if (rowNumber < STUDENT_IMPORT_COMMIT_MIN_ROW_NUMBER) return null;
    if (rowNumber > STUDENT_IMPORT_COMMIT_MAX_ROW_NUMBER) return null;
    if (seenRowNumbers.has(rowNumber)) return null;
    seenRowNumbers.add(rowNumber);

    const name = parseCommitValue(rawRow.name, 'name');
    // The destination column is NOT NULL: an absent name is a malformed row.
    if (name === null || name === '') return null;
    const email = parseCommitValue(rawRow.email, 'email');
    const phone = parseCommitValue(rawRow.phone, 'phone');
    const guardianPhone = parseCommitValue(rawRow.guardian_phone, 'guardian_phone');
    const grade = parseCommitValue(rawRow.grade, 'grade');
    const barcode = parseCommitValue(rawRow.barcode, 'barcode');
    if (
      email === null ||
      phone === null ||
      guardianPhone === null ||
      grade === null ||
      barcode === null
    ) {
      return null;
    }

    for (const field of ['email', 'phone', 'barcode'] as const) {
      const value = field === 'email' ? email : field === 'phone' ? phone : barcode;
      if (value === '') continue;
      if (seenValues[field].has(value)) return null;
      seenValues[field].add(value);
    }

    rows.push({
      row_number: rowNumber,
      name,
      email,
      phone,
      guardian_phone: guardianPhone,
      grade,
      barcode,
    });
  }

  return { idempotencyKey, rows };
};

/**
 * The canonical payload of one batch: a JSON array of arrays in the fixed
 * documented key order.
 *
 * Key order is never the object's own (JSON key order is an implementation
 * detail of the caller), so the digest is taken over this canonical form. Two
 * batches with the same rows therefore produce the same digest regardless of
 * how the client serialized them, and a single changed cell changes it.
 */
const canonicalCommitPayload = (rows: readonly StudentImportCommitRequestRow[]): string =>
  JSON.stringify(
    rows.map((row) => STUDENT_IMPORT_COMMIT_ROW_KEYS.map((key) => row[key])),
  );

/** The canonical digest stored with the batch record and compared on replay. */
const commitPayloadDigest = (payload: string): string =>
  createHash('sha256').update(payload, 'utf8').digest('hex');

/**
 * Reads the exact matching stored values of ONE field, in bounded chunks.
 *
 * Only the match column is projected: no id, no name and no other private
 * value ever leaves the database. A `NULL` or non-string cell is skipped, and
 * the SQL result is a CANDIDATE SET — the caller confirms exact equality.
 */
const readMatchingValues = async (
  connection: StudentImportResolutionConnection,
  tenantId: string,
  field: StudentImportResolutionField,
  values: readonly string[],
): Promise<Set<string>> => {
  const matched = new Set<string>();
  if (values.length === 0) return matched;
  for (let offset = 0; offset < values.length; offset += STUDENT_IMPORT_RESOLUTION_CHUNK) {
    const chunk = values.slice(offset, offset + STUDENT_IMPORT_RESOLUTION_CHUNK);
    const placeholders = chunk.map(() => '?').join(',');
    const [rows] = await connection.execute(
      `SELECT ${field} AS value FROM students WHERE tenant_id=? AND is_active=1 AND ${field} IN (${placeholders})`,
      [tenantId, ...chunk],
    );
    for (const row of (rows as any[]) ?? []) {
      const stored = row?.value;
      if (typeof stored !== 'string') continue;
      matched.add(stored);
    }
  }
  return matched;
};

export const createStudentImportResolutionRouter = (deps: StudentImportResolutionDeps): Router => {
  const router = Router();
  const { getConnection } = deps;

  /**
   * Local billing-only denial.
   *
   * `auth.ts` exempts the whole `/api/tenants/me` prefix from the instructor
   * billing-only page restriction, so mounting under that prefix does not by
   * itself enforce the denial. This route therefore refuses BEFORE any data
   * access, exactly like the accepted tenant-self children, and leaves the
   * shared authentication middleware untouched.
   */
  const denyBillingOnly = (req: AuthRequest, res: Response): boolean => {
    if (!req.user?.billingOnly) return false;
    res.status(403).json({
      error: 'Student import reconciliation is not available while the account is limited to billing and support',
      code: 'BILLING_ONLY',
    });
    return true;
  };

  /**
   * POST /api/tenants/me/student-import/resolve
   *
   * Owner-only, read-only, bounded. The caller must be the verified owner of
   * the server-selected ACTIVE tenant, resolved from server rows on the same
   * connection that performs the reads. No tenant selector is accepted in the
   * header, the query or the body.
   *
   * Outcomes:
   *  - 400 malformed payload (before any connection is taken);
   *  - 403 billing-only (before any connection is taken);
   *  - 403 not the verified owner of the selected tenant;
   *  - 404 no server-selected tenant;
   *  - 500 acquisition/read failure — with NO fabricated `clear` answer;
   *  - 200 `{ rows, summary }` in request-row order.
   *
   * `Cache-Control: no-store` is set before the first await and before every
   * denial, so every outcome this handler can produce carries it.
   */
  router.post('/resolve', async (req: AuthRequest, res: Response) => {
    res.set('Cache-Control', 'no-store');
    if (denyBillingOnly(req, res)) return;

    const parsed = parseRequest(req.body);
    if (!parsed) return res.status(400).json({ error: 'Invalid student import resolution payload' });

    const userId = req.user?.id;
    const tenantId = req.user?.tenantId;
    if (!userId || !tenantId) return res.status(404).json({ error: 'Tenant membership not found' });

    let connection: StudentImportResolutionConnection | null = null;
    try {
      connection = await getConnection();

      // Server-owned owner authority, read on the SAME connection that performs
      // the match reads. A membership role label never reaches here, and a
      // suspended tenant or inactive caller row resolves to nothing.
      const [ownerRows] = await connection.execute(
        `SELECT t.owner_user_id,t.status AS tenant_status,u.is_active AS caller_active
         FROM tenants t JOIN users u ON u.id=? WHERE t.id=?`,
        [userId, tenantId],
      );
      const owner = (ownerRows as any[])?.[0];
      if (
        !owner ||
        String(owner.owner_user_id) !== userId ||
        owner.tenant_status !== 'active' ||
        Number(owner.caller_active) !== 1
      ) {
        return res.status(403).json({ error: 'Forbidden' });
      }

      // Deduplicated, bounded value sets: one read per distinct value, never one
      // read per row.
      const distinct: Record<StudentImportResolutionField, string[]> = {
        email: [],
        phone: [],
        barcode: [],
      };
      for (const field of STUDENT_IMPORT_RESOLUTION_FIELDS) {
        const unique = new Set<string>();
        for (const row of parsed.rows) {
          const value = row[field];
          if (value !== '') unique.add(value);
        }
        distinct[field] = [...unique];
      }

      const matchedValues: Record<StudentImportResolutionField, Set<string>> = {
        email: await readMatchingValues(connection, tenantId, 'email', distinct.email),
        phone: await readMatchingValues(connection, tenantId, 'phone', distinct.phone),
        barcode: await readMatchingValues(connection, tenantId, 'barcode', distinct.barcode),
      };

      let matchedCount = 0;
      const rows: StudentImportResolutionResultRow[] = parsed.rows.map((row) => {
        const matchedFields = STUDENT_IMPORT_RESOLUTION_FIELDS.filter((field) => {
          const value = row[field];
          if (value === '') return false;
          // EXACT equality: the SQL collation may have returned a superset.
          return matchedValues[field].has(value);
        });
        if (matchedFields.length > 0) matchedCount += 1;
        return { row_number: row.row_number, matched_fields: [...matchedFields] };
      });

      const checked = rows.length;
      return res.json({
        rows,
        summary: { checked, matched: matchedCount, clear: checked - matchedCount },
      });
    } catch (error) {
      // A failed read is never reported as "clear": the whole answer is refused.
      console.error('Resolve student import rows error:', error);
      return res.status(500).json({ error: 'Failed to resolve student import rows' });
    } finally {
      if (connection) {
        // Read-only: no transaction was opened and no statement left the
        // session dirty, so the connection is returned to the pool exactly
        // once. A release that throws means it is already gone.
        try { connection.release(); } catch { /* connection already released */ }
      }
    }
  });

  /**
   * POST /api/tenants/me/student-import/commit
   *
   * Owner-only, write, bounded and audited. The caller must be the verified
   * owner of the server-selected ACTIVE tenant, resolved from server rows on
   * the SAME transactional connection that performs the writes. No tenant
   * selector is accepted in the header, the query or the body.
   *
   * The order is deliberate and observable: acquire the connection, OPEN THE
   * TRANSACTION, and only then read the owner authority. The authority read
   * and every recheck and write after it therefore share ONE transaction on
   * ONE connection, so an ownership change, a suspension or a caller
   * revocation that lands between the authorization and the write cannot slip
   * through. A denied authority rolls that transaction back before the answer
   * and writes nothing.
   *
   * Outcomes:
   *  - 400 malformed payload (before any connection is taken);
   *  - 403 billing-only (before any connection is taken);
   *  - 503 no transactional seam is bound;
   *  - 403 not the verified owner of the selected tenant;
   *  - 404 no server-selected tenant;
   *  - 409 `STUDENT_IMPORT_EXISTING_MATCH` — a nonblank email/phone/barcode of
   *    the batch already exists for this tenant (row numbers + field names);
   *  - 409 `STUDENT_IMPORT_IDEMPOTENCY_CONFLICT` — same key, different digest;
   *  - 409 `STUDENT_IMPORT_VALUE_CONFLICT` — a globally unique destination
   *    column collided (no row number and no field name: the owner of the
   *    existing value may be another tenant, and attributing it would reveal
   *    that tenant's data);
   *  - 500 `STUDENT_IMPORT_COMMIT_UNCERTAIN` — the commit outcome is unknown;
   *  - 200 `{ batch_id, replayed, created, row_numbers }`.
   *
   * `Cache-Control: no-store` is set before the first await and before every
   * denial, so every outcome this handler can produce carries it.
   */
  router.post('/commit', async (req: AuthRequest, res: Response) => {
    res.set('Cache-Control', 'no-store');
    if (denyBillingOnly(req, res)) return;

    const parsed = parseCommitRequest(req.body);
    if (!parsed) {
      return res.status(400).json({ error: 'Invalid student import commit payload' });
    }

    const userId = req.user?.id;
    const tenantId = req.user?.tenantId;
    if (!userId || !tenantId) return res.status(404).json({ error: 'Tenant membership not found' });

    // A write needs a transaction, so the transactional seam is required. The
    // commit route never falls back to the read-only seam.
    const acquireCommitConnection = deps.getCommitConnection;
    if (!acquireCommitConnection) {
      return res.status(503).json({
        error: 'Student import commit is unavailable',
        code: STUDENT_IMPORT_COMMIT_CODE_COMMIT_UNAVAILABLE,
      });
    }

    const payload = canonicalCommitPayload(parsed.rows);
    const digest = commitPayloadDigest(payload);
    const rowNumbers = parsed.rows.map((row) => row.row_number);

    let connection: StudentImportCommitConnection | null = null;
    let transactionOpen = false;
    let commitOutcomeUnknown = false;
    try {
      connection = await acquireCommitConnection();

      // The transaction opens BEFORE the authority read. The owner, tenant and
      // caller authority is revalidated INSIDE the same transaction that
      // performs the writes, so an ownership change, a suspension or a caller
      // revocation that lands between the authorization and the write cannot
      // slip through: the authority read and every write after it share ONE
      // transaction on ONE connection.
      await connection.beginTransaction();
      transactionOpen = true;

      // Server-owned owner authority, re-read on the SAME connection and
      // INSIDE the open transaction that performs the writes. A membership role
      // label never reaches here, and a suspended tenant or inactive caller row
      // resolves to nothing.
      const [ownerRows] = await connection.execute(
        `SELECT t.owner_user_id,t.status AS tenant_status,u.is_active AS caller_active
         FROM tenants t JOIN users u ON u.id=? WHERE t.id=?`,
        [userId, tenantId],
      );
      const owner = (ownerRows as any[])?.[0];
      if (
        !owner ||
        String(owner.owner_user_id) !== userId ||
        owner.tenant_status !== 'active' ||
        Number(owner.caller_active) !== 1
      ) {
        // The denial happens INSIDE the open transaction, so it is rolled back
        // BEFORE the answer: the session is closed with nothing written, and
        // the connection is released exactly once by the `finally` block.
        await connection.rollback();
        transactionOpen = false;
        return res.status(403).json({ error: 'Forbidden' });
      }

      // Idempotency. The unique (tenant_id, idempotency_key) is the
      // serialization point: the locking read below makes concurrent same-key
      // attempts wait for each other, so exactly one of them can be the first
      // writer and every other one answers from the stored record.
      const [batchRows] = await connection.execute(
        `SELECT id,payload_digest,created_count FROM student_import_batches
         WHERE tenant_id=? AND idempotency_key=? FOR UPDATE`,
        [tenantId, parsed.idempotencyKey],
      );
      const existingBatch = (batchRows as any[])?.[0];
      if (existingBatch) {
        const replay = String(existingBatch.payload_digest) === digest;
        await connection.rollback();
        transactionOpen = false;
        if (replay) {
          return res.json({
            batch_id: String(existingBatch.id),
            replayed: true,
            created: Number(existingBatch.created_count),
            row_numbers: rowNumbers,
          });
        }
        return res.status(409).json({
          error: 'This idempotency key was already used for a different batch',
          code: STUDENT_IMPORT_COMMIT_CODE_IDEMPOTENCY_CONFLICT,
        });
      }

      // Re-check every nonblank value against the tenant's active students
      // INSIDE the transaction, with the same bounded deduplicated chunked
      // reads and application-level exact equality the reconciliation route
      // uses. The SQL is a candidate filter; the collation may return a
      // superset, so equality is confirmed in the application.
      const distinct: Record<'email' | 'phone' | 'barcode', string[]> = {
        email: [],
        phone: [],
        barcode: [],
      };
      for (const field of ['email', 'phone', 'barcode'] as const) {
        const unique = new Set<string>();
        for (const row of parsed.rows) {
          if (row[field] !== '') unique.add(row[field]);
        }
        distinct[field] = [...unique];
      }
      const matchedValues: Record<'email' | 'phone' | 'barcode', Set<string>> = {
        email: await readMatchingValues(connection, tenantId, 'email', distinct.email),
        phone: await readMatchingValues(connection, tenantId, 'phone', distinct.phone),
        barcode: await readMatchingValues(connection, tenantId, 'barcode', distinct.barcode),
      };
      const matchedRows: StudentImportResolutionResultRow[] = [];
      for (const row of parsed.rows) {
        const matchedFields = (['email', 'phone', 'barcode'] as const).filter((field) => {
          if (row[field] === '') return false;
          return matchedValues[field].has(row[field]);
        });
        if (matchedFields.length > 0) {
          matchedRows.push({ row_number: row.row_number, matched_fields: [...matchedFields] });
        }
      }
      if (matchedRows.length > 0) {
        // The WHOLE batch is refused: no overwrite, no merge, no keep
        // exception and no partial success. Row numbers and the NAMES of the
        // matched fields only — never a stored value, an id or an identity.
        await connection.rollback();
        transactionOpen = false;
        return res.status(409).json({
          error: 'Some submitted rows already exist in this tenant',
          code: STUDENT_IMPORT_COMMIT_CODE_EXISTING_MATCH,
          rows: matchedRows,
        });
      }

      // One sanitized batch/audit record, written BEFORE the students so the
      // unique key is the serialization point for concurrent attempts. Its
      // result fields are already final at write time, so the record never has
      // to be updated and can never disagree with the students.
      const batchId = randomUUID();
      await connection.execute(
        `INSERT INTO student_import_batches
           (id,tenant_id,idempotency_key,payload_digest,created_count,row_numbers,created_by)
         VALUES (?,?,?,?,?,?,?)`,
        [
          batchId,
          tenantId,
          parsed.idempotencyKey,
          digest,
          parsed.rows.length,
          JSON.stringify(rowNumbers),
          userId,
        ],
      );

      // Student rows only. The column list is exactly the eight documented
      // columns, so no account, login, password, invitation, OTP, enrollment,
      // group/course/branch, payment or access column can be touched: every
      // other column keeps the schema's own default. An absent optional value
      // is written as NULL, never as a blank string, so the globally unique
      // email/barcode columns do not collide on "empty".
      const columnList = STUDENT_IMPORT_COMMIT_STUDENT_COLUMNS.join(',');
      for (
        let offset = 0;
        offset < parsed.rows.length;
        offset += STUDENT_IMPORT_COMMIT_INSERT_CHUNK
      ) {
        const chunk = parsed.rows.slice(offset, offset + STUDENT_IMPORT_COMMIT_INSERT_CHUNK);
        const valuesSql = chunk
          .map(() => `(${STUDENT_IMPORT_COMMIT_STUDENT_COLUMNS.map(() => '?').join(',')})`)
          .join(',');
        const params: unknown[] = [];
        for (const row of chunk) {
          params.push(
            randomUUID(),
            tenantId,
            row.name,
            row.email === '' ? null : row.email,
            row.phone === '' ? null : row.phone,
            row.guardian_phone === '' ? null : row.guardian_phone,
            row.grade === '' ? null : row.grade,
            row.barcode === '' ? null : row.barcode,
          );
        }
        await connection.execute(
          `INSERT INTO students (${columnList}) VALUES ${valuesSql}`,
          params as any[],
        );
      }

      commitOutcomeUnknown = true;
      await connection.commit();
      commitOutcomeUnknown = false;
      transactionOpen = false;

      return res.json({
        batch_id: batchId,
        replayed: false,
        created: parsed.rows.length,
        row_numbers: rowNumbers,
      });
    } catch (error) {
      if (commitOutcomeUnknown) {
        // `commit()` itself failed: the transaction may or may not have been
        // applied. The outcome is UNKNOWN, so it is never turned into a
        // retryable success and never rolled back blindly — the session is
        // discarded so the pool cannot reuse it, and the caller is told to
        // retry with the SAME idempotency key (a replay is answered from the
        // stored record if the transaction did land).
        try { connection?.destroy(); } catch { /* connection already gone */ }
        connection = null;
        transactionOpen = false;
        console.error('Commit student import batch — outcome unknown:', error);
        return res.status(500).json({
          error: 'The import outcome is unknown; retry with the same idempotency key',
          code: STUDENT_IMPORT_COMMIT_CODE_COMMIT_UNCERTAIN,
        });
      }

      const driverCode = (error as { code?: unknown } | null)?.code;
      if (driverCode === 'ER_DUP_ENTRY' && connection) {
        // A duplicate key. The batch record is inserted first, so this is
        // normally the idempotency key — but a globally unique student column
        // (email or barcode, possibly owned by ANOTHER tenant) collides the
        // same way. The answer is derived from stored rows only, never from
        // the driver message.
        if (transactionOpen) {
          try {
            await connection.rollback();
            transactionOpen = false;
          } catch {
            // A rollback that fails leaves the session in an unknown state, so
            // the pool must not reuse it.
            try { connection.destroy(); } catch { /* connection already gone */ }
            connection = null;
            transactionOpen = false;
            console.error('Commit student import batch — rollback failed:', error);
            return res.status(500).json({ error: 'Failed to commit student import batch' });
          }
        }
        const [rereadRows] = await connection.execute(
          `SELECT id,payload_digest,created_count FROM student_import_batches
           WHERE tenant_id=? AND idempotency_key=?`,
          [tenantId, parsed.idempotencyKey],
        );
        const reread = (rereadRows as any[])?.[0];
        if (reread) {
          if (String(reread.payload_digest) === digest) {
            return res.json({
              batch_id: String(reread.id),
              replayed: true,
              created: Number(reread.created_count),
              row_numbers: rowNumbers,
            });
          }
          return res.status(409).json({
            error: 'This idempotency key was already used for a different batch',
            code: STUDENT_IMPORT_COMMIT_CODE_IDEMPOTENCY_CONFLICT,
          });
        }
        // Not the idempotency key: a submitted value conflicts with an existing
        // record. No row number and no field name is returned, because the
        // conflicting record may belong to another tenant.
        return res.status(409).json({
          error: 'A submitted value conflicts with an existing record',
          code: STUDENT_IMPORT_COMMIT_CODE_VALUE_CONFLICT,
        });
      }

      // Any other failure rolls the whole batch back in `finally`. A partial
      // batch never exists, and no SQL or internal detail is exposed.
      console.error('Commit student import batch error:', error);
      return res.status(500).json({ error: 'Failed to commit student import batch' });
    } finally {
      if (!connection) return;
      if (transactionOpen) {
        try {
          await connection.rollback();
        } catch {
          // A rollback that fails leaves the session in an unknown state, so
          // the pool must not reuse it.
          try { connection.destroy(); } catch { /* connection already gone */ }
          return;
        }
      }
      // The connection is returned to the pool exactly once. A release that
      // throws means it is already gone.
      try { connection.release(); } catch { /* connection already released */ }
    }
  });

  return router;
};
