/**
 * M2-16 — the client half of the audited idempotent student-row import.
 *
 * The accepted M2-08/11/14/15 chain answers "what does this file contain",
 * "which rows do I intend to include", "which of these values already exist in
 * my tenant" and "what did I decide about each existing match". None of it can
 * persist anything. This module adds exactly ONE further step, and nothing else:
 *
 *   the user confirms once → the CURRENT included rows, which a FRESH
 *   reconciliation has just reported as entirely clear, are submitted as ONE
 *   bounded batch under ONE idempotency key → the server creates tenant student
 *   rows plus a sanitized import record, or refuses the whole batch.
 *
 * What this module is NOT, and never does:
 *  - it does not create an account, a login, a password, an invitation, an OTP,
 *    an enrollment, a group/course/branch assignment, a payment or any access.
 *    It sends the six accepted CSV columns and nothing else;
 *  - it does not send a row that is pending, excluded or invalid: the batch is
 *    exactly the currently `included` rows, in ascending physical row order;
 *  - it does not authorize itself: a batch is confirmable ONLY when the current
 *    decisions have no pending and no invalid row AND the CURRENT confirmed
 *    reconciliation answered exactly those included row numbers and reported
 *    zero matches. A local review decision is never a write authorization;
 *  - it never calls automatically. Selecting a file, changing a decision,
 *    reconciling or downloading a report never submits anything; only an
 *    explicit `confirm()` does;
 *  - it does not persist or log anything: no storage, no `console`, and no
 *    private CSV value survives a call;
 *  - it never fakes success: only a 2xx that matches the documented DTO becomes
 *    `committed`, and an uncertain transport outcome stays `failed` so the same
 *    key and the same payload can be retried.
 *
 * Idempotency rules:
 *  - one confirmation mints ONE opaque key for ONE canonical batch;
 *  - a retry of an UNCERTAIN outcome reuses the SAME key and the SAME payload,
 *    so the server can replay the recorded result instead of creating twice;
 *  - a changed payload can never reuse that key: the canonical form is compared
 *    first, and a different batch mints a new key;
 *  - a DEFINITE outcome (committed, rejected, conflict, malformed) drops the
 *    attempt, so the next confirmation starts a new attempt.
 *
 * Lifecycle rules (the ones the handoff makes non-negotiable):
 *  - at most ONE submission is in flight; a second click is refused with `busy`
 *    instead of racing the first;
 *  - a file/decision/reconciliation/principal/session/reset/close/dispose change
 *    CLEARS the result and RETIRES a pending reply, so a late answer can never
 *    restore a private result into a scope that no longer owns it;
 *  - a retired reply cannot release a NEWER latch: the latch is owned by a
 *    ticket, and a reply whose ticket is no longer the active one changes
 *    nothing;
 *  - a reversed success/error order is therefore harmless.
 */
import type { ImportResolutionRow } from './import-resolution';
import type { ServerResolutionResult } from './server-resolution';

// ---------------------------------------------------------------------------
// Bounds and vocabulary
// ---------------------------------------------------------------------------

/** The maximum number of rows one batch may carry (the server bound). */
export const IMPORT_COMMIT_MAX_ROWS = 1000;
/** The physical line of the first data record of an accepted CSV file. */
export const IMPORT_COMMIT_MIN_ROW_NUMBER = 2;
/** The physical line of the last possible data record. */
export const IMPORT_COMMIT_MAX_ROW_NUMBER = 1001;

/** The accepted bounds of one idempotency key. */
export const IMPORT_COMMIT_KEY_MIN_CHARS = 16;
export const IMPORT_COMMIT_KEY_MAX_CHARS = 128;
/**
 * An opaque, URL-safe, bounded key. A predictable or short key is refused: a
 * guessable key would let an unrelated batch be replayed into this tenant.
 */
export const IMPORT_COMMIT_KEY_PATTERN = /^[A-Za-z0-9_-]{16,128}$/;

/**
 * The exact seven keys of one submitted row, in the canonical order used by the
 * request body and by the payload identity.
 */
export const IMPORT_COMMIT_ROW_KEYS = [
  'row_number',
  'name',
  'email',
  'phone',
  'guardian_phone',
  'grade',
  'barcode',
] as const;
export type ImportCommitRowKey = (typeof IMPORT_COMMIT_ROW_KEYS)[number];

/**
 * The accepted column bounds of the destination table, mirrored here so a
 * confirmable batch can never be refused by the database for a length the UI
 * could have refused first. They are the schema's own VARCHAR widths.
 */
export const IMPORT_COMMIT_VALUE_BOUNDS: Record<Exclude<ImportCommitRowKey, 'row_number'>, number> = {
  name: 255,
  email: 255,
  phone: 50,
  guardian_phone: 50,
  grade: 100,
  barcode: 50,
};

export interface ImportCommitRow {
  readonly row_number: number;
  readonly name: string;
  readonly email: string;
  readonly phone: string;
  readonly guardian_phone: string;
  readonly grade: string;
  readonly barcode: string;
}

/** The exact request body: one opaque key and the canonical rows. */
export interface ImportCommitRequest {
  readonly idempotency_key: string;
  readonly rows: readonly ImportCommitRow[];
}

/** The exact response DTO: a batch id, a replay flag, a count and row numbers. */
export interface ImportCommitResult {
  readonly batch_id: string;
  readonly replayed: boolean;
  readonly created: number;
  readonly row_numbers: readonly number[];
}

/** The injected transport answer: the status is part of the contract. */
export interface ImportCommitTransportResponse {
  readonly status: number;
  readonly body: unknown;
}

/**
 * The injected transport. It must resolve with the STATUS and the parsed body
 * for every HTTP answer, and may reject ONLY when the outcome is unknown (a
 * network failure). A rejection is what makes a retry reuse the same key.
 */
export type ImportCommitTransport = (
  request: ImportCommitRequest,
) => Promise<ImportCommitTransportResponse>;

// ---------------------------------------------------------------------------
// The confirmation gate
// ---------------------------------------------------------------------------

/**
 * Why a batch is not confirmable. Every value is a local, documented reason and
 * every one of them is visible in the UI as the disabled explanation.
 */
export type ImportCommitRefusal =
  | 'no-rows'
  | 'pending-rows'
  | 'invalid-rows'
  | 'too-many-rows'
  | 'out-of-range'
  | 'missing-name'
  | 'value-too-long'
  | 'not-reconciled'
  | 'reconciliation-stale'
  | 'existing-matches';

export type ImportCommitGate =
  | { readonly ok: true; readonly rows: readonly ImportCommitRow[] }
  | { readonly ok: false; readonly reason: ImportCommitRefusal; readonly rowNumbers: readonly number[] };

/** The six submitted values of one row, in the canonical key order. */
const commitValues = (row: ImportResolutionRow): readonly string[] => [
  row.name,
  row.email,
  row.phone,
  row.guardian_phone,
  row.grade,
  row.barcode,
];

/** Projects one decision row into the exact submitted row. Nothing is trimmed. */
const toCommitRow = (row: ImportResolutionRow): ImportCommitRow => ({
  row_number: row.rowNumber,
  name: row.name,
  email: row.email,
  phone: row.phone,
  guardian_phone: row.guardian_phone,
  grade: row.grade,
  barcode: row.barcode,
});

/**
 * Evaluates the confirmation gate for the CURRENT decision model and the
 * CURRENT confirmed reconciliation.
 *
 * The order of the checks is the order of the user's own questions: is the file
 * fully decided, is every included row well-formed, and did a fresh
 * reconciliation clear exactly those rows? A failed check returns the affected
 * physical row numbers so the UI can point at them, and never invents a batch.
 */
export function evaluateImportCommitGate(
  rows: readonly ImportResolutionRow[],
  resolution: ServerResolutionResult | null,
): ImportCommitGate {
  const invalid = rows.filter((row) => row.status === 'invalid').map((row) => row.rowNumber);
  if (invalid.length > 0) return { ok: false, reason: 'invalid-rows', rowNumbers: invalid };

  const pending = rows.filter((row) => row.status === 'pending').map((row) => row.rowNumber);
  if (pending.length > 0) return { ok: false, reason: 'pending-rows', rowNumbers: pending };

  // Ascending physical order: the canonical batch, whatever order the model
  // happens to hold.
  const included = rows
    .filter((row) => row.status === 'included')
    .slice()
    .sort((left, right) => left.rowNumber - right.rowNumber);

  if (included.length === 0) return { ok: false, reason: 'no-rows', rowNumbers: [] };
  if (included.length > IMPORT_COMMIT_MAX_ROWS) {
    return { ok: false, reason: 'too-many-rows', rowNumbers: [] };
  }

  const outOfRange = included
    .filter(
      (row) =>
        !Number.isInteger(row.rowNumber) ||
        row.rowNumber < IMPORT_COMMIT_MIN_ROW_NUMBER ||
        row.rowNumber > IMPORT_COMMIT_MAX_ROW_NUMBER,
    )
    .map((row) => row.rowNumber);
  if (outOfRange.length > 0) return { ok: false, reason: 'out-of-range', rowNumbers: outOfRange };

  const missingName = included.filter((row) => row.name.trim() === '').map((row) => row.rowNumber);
  if (missingName.length > 0) return { ok: false, reason: 'missing-name', rowNumbers: missingName };

  const tooLong = included
    .filter((row) => {
      const values = commitValues(row);
      const bounds = IMPORT_COMMIT_VALUE_BOUNDS;
      return (
        values[0].length > bounds.name ||
        values[1].length > bounds.email ||
        values[2].length > bounds.phone ||
        values[3].length > bounds.guardian_phone ||
        values[4].length > bounds.grade ||
        values[5].length > bounds.barcode
      );
    })
    .map((row) => row.rowNumber);
  if (tooLong.length > 0) return { ok: false, reason: 'value-too-long', rowNumbers: tooLong };

  if (!resolution) return { ok: false, reason: 'not-reconciled', rowNumbers: [] };

  const expected = included.map((row) => row.rowNumber);
  const answered = resolution.rows.map((row) => row.row_number);
  // The reconciliation must answer EXACTLY the current included set, in the
  // same order. A decision made after it, an exclusion of a matched row or an
  // undo of a match all make the answered set differ, and the batch is refused
  // until a FRESH reconciliation covers the exact set being submitted.
  if (
    answered.length !== expected.length ||
    answered.some((rowNumber, index) => rowNumber !== expected[index])
  ) {
    return { ok: false, reason: 'reconciliation-stale', rowNumbers: expected };
  }

  const matchedRows = resolution.rows
    .filter((row) => row.matched_fields.length > 0)
    .map((row) => row.row_number);
  if (
    matchedRows.length > 0 ||
    resolution.summary.matched !== 0 ||
    resolution.summary.checked !== expected.length ||
    resolution.summary.clear !== expected.length
  ) {
    return { ok: false, reason: 'existing-matches', rowNumbers: matchedRows };
  }

  return { ok: true, rows: included.map(toCommitRow) };
}

// ---------------------------------------------------------------------------
// Canonical payload
// ---------------------------------------------------------------------------

/**
 * The canonical payload identity of a batch.
 *
 * Two batches are the SAME batch exactly when this string is equal: the rows in
 * ascending physical order, each as a fixed-order array of its seven values.
 * The idempotency key is bound to it, so a retry of the same batch reuses the
 * key and a different batch can never inherit it.
 */
export function canonicalImportCommitPayload(rows: readonly ImportCommitRow[]): string {
  return JSON.stringify(
    rows.map((row) => [
      row.row_number,
      row.name,
      row.email,
      row.phone,
      row.guardian_phone,
      row.grade,
      row.barcode,
    ]),
  );
}

/** The exact request body of one attempt. */
export function buildImportCommitRequest(
  idempotencyKey: string,
  rows: readonly ImportCommitRow[],
): ImportCommitRequest {
  return {
    idempotency_key: idempotencyKey,
    rows: rows.map((row) => ({
      row_number: row.row_number,
      name: row.name,
      email: row.email,
      phone: row.phone,
      guardian_phone: row.guardian_phone,
      grade: row.grade,
      barcode: row.barcode,
    })),
  };
}

// ---------------------------------------------------------------------------
// Response parsing
// ---------------------------------------------------------------------------

export type ImportCommitParseResult =
  | { readonly ok: true; readonly result: ImportCommitResult }
  | { readonly ok: false; readonly reason: 'malformed' };

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const hasOwn = (value: object, key: string): boolean =>
  Object.prototype.hasOwnProperty.call(value, key);

/**
 * Parses a 2xx body against the EXACT batch that was submitted.
 *
 * The expected row numbers are the contract: the created count must equal the
 * batch size, and the answered row numbers must be exactly the submitted ones
 * in ascending order. Anything else — an extra key, a missing key, a different
 * count, a different row set, a non-boolean replay flag — is `malformed`, never
 * a partial success.
 */
export function parseImportCommitResponse(
  raw: unknown,
  expectedRowNumbers: readonly number[],
): ImportCommitParseResult {
  if (!isPlainObject(raw)) return { ok: false, reason: 'malformed' };
  if (Object.keys(raw).length !== 4) return { ok: false, reason: 'malformed' };
  for (const key of ['batch_id', 'replayed', 'created', 'row_numbers']) {
    if (!hasOwn(raw, key)) return { ok: false, reason: 'malformed' };
  }

  const batchId = raw.batch_id;
  if (typeof batchId !== 'string' || batchId.length < 1 || batchId.length > 128) {
    return { ok: false, reason: 'malformed' };
  }
  if (typeof raw.replayed !== 'boolean') return { ok: false, reason: 'malformed' };

  const created = raw.created;
  if (typeof created !== 'number' || !Number.isInteger(created) || created < 1) {
    return { ok: false, reason: 'malformed' };
  }
  if (created !== expectedRowNumbers.length) return { ok: false, reason: 'malformed' };

  const rawRows = raw.row_numbers;
  if (!Array.isArray(rawRows)) return { ok: false, reason: 'malformed' };
  if (rawRows.length !== expectedRowNumbers.length) return { ok: false, reason: 'malformed' };
  const rowNumbers: number[] = [];
  for (let index = 0; index < rawRows.length; index += 1) {
    const value = rawRows[index];
    if (typeof value !== 'number' || !Number.isInteger(value)) return { ok: false, reason: 'malformed' };
    if (value !== expectedRowNumbers[index]) return { ok: false, reason: 'malformed' };
    rowNumbers.push(value);
  }

  return { ok: true, result: { batch_id: batchId, replayed: raw.replayed, created, row_numbers: rowNumbers } };
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

export type ImportCommitPhase = 'idle' | 'submitting' | 'committed' | 'rejected' | 'conflict' | 'failed' | 'malformed';

export interface ImportCommitState {
  readonly phase: ImportCommitPhase;
  /** The recorded batch result, or null. Never a partial or invented result. */
  readonly result: ImportCommitResult | null;
  /** A truthful, non-private message for the current outcome, or null. */
  readonly message: string | null;
  readonly revision: number;
}

/** The honest outcome of one explicit confirmation. */
export type ImportCommitOutcome =
  | { readonly ok: true; readonly result: ImportCommitResult }
  | { readonly ok: false; readonly reason: ImportCommitFailureReason };

export type ImportCommitFailureReason =
  | ImportCommitRefusal
  /** A submission is already in flight; the click was refused, not queued. */
  | 'busy'
  /** The canonical principal changed: the former scope's result is gone. */
  | 'scope-changed'
  /** A newer attempt (or a clear) retired this one; it changed nothing. */
  | 'superseded'
  /** The outcome is UNKNOWN (transport failure or a server fault). Retry reuses the key. */
  | 'failed'
  /** The server refused the batch. No row was created. */
  | 'rejected'
  /** The key is already bound to a different payload. No row was created. */
  | 'conflict'
  /** A 2xx that does not match the documented contract. */
  | 'malformed'
  /** No transport, or no unpredictable key source, was available. */
  | 'unavailable';

export const IMPORT_COMMIT_MESSAGES: Record<string, string> = {
  'no-rows': 'لا توجد صفوف مُدرجة لإدخالها.',
  'pending-rows': 'توجد صفوف قيد الانتظار؛ احسم قرارها قبل الإدخال.',
  'invalid-rows': 'توجد صفوف غير صالحة في هذا الملف؛ لا يمكن إدخال الدفعة.',
  'too-many-rows': 'عدد الصفوف المُدرجة يتجاوز الحد المسموح للدفعة الواحدة.',
  'out-of-range': 'رقم أحد الصفوف خارج النطاق المسموح.',
  'missing-name': 'صف مُدرج بلا اسم؛ الاسم مطلوب.',
  'value-too-long': 'قيمة أحد الحقول أطول من الحد المسموح في السجل.',
  'not-reconciled': 'لا توجد مطابقة حديثة مع السجلات الموجودة؛ شغّل «مطابقة الصفوف المُدرجة» أولًا.',
  'reconciliation-stale': 'المطابقة الحالية لا تغطي الصفوف المُدرجة الآن بالضبط؛ أعد المطابقة.',
  'existing-matches': 'توجد قيم موجودة مسبقًا في مؤسستك؛ لا تُدخل أي صف حتى تستبعدها.',
  busy: 'جارٍ إدخال دفعة أخرى؛ انتظر نتيجتها.',
  'scope-changed': 'تغيّرت الجلسة؛ تم مسح نتيجة الإدخال.',
  superseded: 'تم إلغاء محاولة الإدخال هذه.',
  failed: 'تعذّر تأكيد نتيجة الإدخال؛ لم يُعرف هل تمّ الإدخال. أعد المحاولة بنفس الدفعة.',
  rejected: 'رُفضت الدفعة ولم يُدخل أي صف.',
  conflict: 'مفتاح الدفعة مستخدم ببيانات مختلفة؛ لم يُدخل أي صف.',
  malformed: 'ردّ الخادم لا يطابق الصيغة المتوقعة؛ لم تُعتمد أي نتيجة.',
  unavailable: 'إدخال الطلاب غير متاح الآن.',
};

/** The server's documented conflict codes, mapped to a local phase. */
const SERVER_CODE_EXISTING_MATCH = 'STUDENT_IMPORT_EXISTING_MATCH';
const SERVER_CODE_IDEMPOTENCY_CONFLICT = 'STUDENT_IMPORT_IDEMPOTENCY_CONFLICT';

/** Reads a documented server code without trusting anything else in the body. */
const readServerCode = (body: unknown): string | null => {
  if (!isPlainObject(body)) return null;
  const code = body.code;
  return typeof code === 'string' ? code : null;
};

export interface ImportCommitApi {
  /** The injected transport. Rejects ONLY when the outcome is unknown. */
  commit?: ImportCommitTransport;
  /** The canonical principal reader. READ-ONLY here. */
  readPrincipal?: () => string | null;
  /** The canonical session notifier. READ-ONLY here. */
  subscribeSession?: (listener: () => void) => () => void;
  /**
   * The opaque key source. The default uses `crypto.randomUUID()`; a source
   * that returns a key outside the documented shape is refused rather than
   * weakened.
   */
  createKey?: () => string;
}

export interface ImportCommitController {
  getState(): ImportCommitState;
  subscribe(listener: (state: ImportCommitState) => void): () => void;
  /** One explicit confirmation of the CURRENT gate-approved batch. */
  confirm(
    rows: readonly ImportResolutionRow[],
    resolution: ServerResolutionResult | null,
  ): Promise<ImportCommitOutcome>;
  /** True when the next confirmation would reuse the SAME key and payload. */
  canRetry(): boolean;
  /**
   * Adopts a silent principal change BEFORE the next action.
   * Returns true when the principal changed and the result was dropped.
   */
  revalidateScope(): boolean;
  /** Drops the result and retires any pending reply. */
  clear(): void;
  dispose(): void;
}

export function initialImportCommitState(): ImportCommitState {
  return { phase: 'idle', result: null, message: null, revision: 0 };
}

/** The unpredictable default key source, or null when none is available. */
const defaultKey = (): string | null => {
  const cryptoObject = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (!cryptoObject || typeof cryptoObject.randomUUID !== 'function') return null;
  try {
    const id = cryptoObject.randomUUID();
    return IMPORT_COMMIT_KEY_PATTERN.test(id) ? id : null;
  } catch {
    return null;
  }
};

/**
 * Creates the import lifecycle for ONE mounted panel.
 *
 * At most one submission is in flight, at most one recorded result is held, and
 * every visible transition is gated by the ticket that started it.
 */
export function createImportCommitController(api: ImportCommitApi = {}): ImportCommitController {
  let state = initialImportCommitState();
  let disposed = false;
  const listeners = new Set<(state: ImportCommitState) => void>();
  const readPrincipal = (): string | null => (api.readPrincipal ? api.readPrincipal() : null);
  let observedPrincipal = readPrincipal();

  /** The monotonic ticket source. Every attempt takes one. */
  let lastTicket = 0;
  /** The ticket that currently OWNS the busy latch, or 0 when idle. */
  let latchTicket = 0;
  /**
   * The attempt an UNCERTAIN outcome left open: the same canonical batch must
   * reuse this exact key. A definite outcome drops it.
   */
  let lastAttempt: { readonly canonical: string; readonly key: string } | null = null;

  const publish = (next: ImportCommitState): void => {
    state = next;
    for (const listener of [...listeners]) listener(state);
  };

  const busy = (): boolean => latchTicket !== 0;

  const settle = (
    phase: ImportCommitPhase,
    message: string | null,
    result: ImportCommitResult | null,
  ): void => {
    publish({ phase, result, message, revision: state.revision + 1 });
  };

  /**
   * Drops every visible result and RETIRES any pending reply.
   *
   * Retiring bumps the ticket source, so a reply that is still on the wire no
   * longer owns the latch and cannot publish, cannot release a newer latch and
   * cannot resurrect the dropped result.
   */
  const clear = (): void => {
    lastTicket += 1;
    latchTicket = 0;
    lastAttempt = null;
    publish(initialImportCommitState());
  };

  const adoptPrincipalChange = (): boolean => {
    const observed = readPrincipal();
    if (observed === observedPrincipal) return false;
    observedPrincipal = observed;
    clear();
    return true;
  };

  const unsubscribeSession = api.subscribeSession
    ? api.subscribeSession(() => {
        if (disposed) return;
        observedPrincipal = readPrincipal();
        clear();
      })
    : undefined;

  const mintKey = (): string | null => {
    const custom = api.createKey;
    if (typeof custom === 'function') {
      let key = '';
      try {
        key = custom();
      } catch {
        return null;
      }
      return typeof key === 'string' && IMPORT_COMMIT_KEY_PATTERN.test(key) ? key : null;
    }
    return defaultKey();
  };

  return {
    getState: () => state,
    subscribe: (listener) => {
      listeners.add(listener);
      listener(state);
      return () => {
        listeners.delete(listener);
      };
    },
    canRetry: () => lastAttempt !== null,
    confirm: async (rows, resolution) => {
      if (disposed) return { ok: false, reason: 'failed' };

      const gate = evaluateImportCommitGate(rows, resolution);
      if (gate.ok !== true) {
        // A local refusal is never a server attempt and never a fake success.
        settle('rejected', IMPORT_COMMIT_MESSAGES[gate.reason], null);
        return { ok: false, reason: gate.reason };
      }

      if (adoptPrincipalChange()) return { ok: false, reason: 'scope-changed' };
      if (busy()) return { ok: false, reason: 'busy' };

      const transport = api.commit;
      if (typeof transport !== 'function') {
        settle('rejected', IMPORT_COMMIT_MESSAGES.unavailable, null);
        return { ok: false, reason: 'unavailable' };
      }

      const canonical = canonicalImportCommitPayload(gate.rows);
      // The SAME canonical batch reuses the SAME key (an uncertain retry); a
      // different batch mints a new one. A key that cannot be minted safely is
      // a refusal, never a predictable fallback.
      let key: string | null;
      if (lastAttempt && lastAttempt.canonical === canonical) {
        key = lastAttempt.key;
      } else {
        key = mintKey();
        if (key === null) {
          settle('rejected', IMPORT_COMMIT_MESSAGES.unavailable, null);
          return { ok: false, reason: 'unavailable' };
        }
        lastAttempt = { canonical, key };
      }

      const request = buildImportCommitRequest(key, gate.rows);
      const expected = gate.rows.map((row) => row.row_number);

      const ticket = lastTicket + 1;
      lastTicket = ticket;
      latchTicket = ticket;
      settle('submitting', null, null);

      try {
        const response = await transport(request);
        // A retired attempt settles NOTHING: not the phase, not the result, not
        // the latch. This is what makes a reversed order harmless.
        if (ticket !== lastTicket || disposed) return { ok: false, reason: 'superseded' };
        if (readPrincipal() !== observedPrincipal) {
          observedPrincipal = readPrincipal();
          clear();
          return { ok: false, reason: 'scope-changed' };
        }

        const status = response.status;
        if (status >= 200 && status < 300) {
          const parsed = parseImportCommitResponse(response.body, expected);
          if (parsed.ok !== true) {
            // A definite 2xx that is not our DTO: nothing is trusted.
            lastAttempt = null;
            settle('malformed', IMPORT_COMMIT_MESSAGES.malformed, null);
            return { ok: false, reason: 'malformed' };
          }
          // The attempt is settled: a further click would be a NEW confirmation
          // of the same canonical batch and is answered by the recorded replay.
          settle('committed', null, parsed.result);
          return { ok: true, result: parsed.result };
        }

        if (status >= 500) {
          // An uncertain server fault: the batch MAY have landed. The attempt
          // stays open so a retry reuses the same key and payload.
          settle('failed', IMPORT_COMMIT_MESSAGES.failed, null);
          return { ok: false, reason: 'failed' };
        }

        // Every 4xx is a DEFINITE refusal: no row was created.
        lastAttempt = null;
        const code = readServerCode(response.body);
        if (status === 409 && code === SERVER_CODE_IDEMPOTENCY_CONFLICT) {
          settle('conflict', IMPORT_COMMIT_MESSAGES.conflict, null);
          return { ok: false, reason: 'conflict' };
        }
        if (status === 409 && code === SERVER_CODE_EXISTING_MATCH) {
          settle('rejected', IMPORT_COMMIT_MESSAGES['existing-matches'], null);
          return { ok: false, reason: 'existing-matches' };
        }
        settle('rejected', IMPORT_COMMIT_MESSAGES.rejected, null);
        return { ok: false, reason: 'rejected' };
      } catch {
        if (ticket !== lastTicket || disposed) return { ok: false, reason: 'superseded' };
        // The outcome is UNKNOWN: no success is claimed, and the attempt stays
        // open so the retry is the SAME key and the SAME payload.
        settle('failed', IMPORT_COMMIT_MESSAGES.failed, null);
        return { ok: false, reason: 'failed' };
      } finally {
        // Only the owner of the latch may release it: a retired reply must never
        // release a NEWER attempt's latch.
        if (latchTicket === ticket) latchTicket = 0;
      }
    },
    revalidateScope: () => {
      if (disposed) return false;
      return adoptPrincipalChange();
    },
    clear,
    dispose: () => {
      if (disposed) return;
      disposed = true;
      if (unsubscribeSession) unsubscribeSession();
      listeners.clear();
      lastTicket += 1;
      latchTicket = 0;
      lastAttempt = null;
      state = initialImportCommitState();
    },
  };
}
