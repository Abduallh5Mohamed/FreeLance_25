/**
 * M2-14 / M2-B08 — the client half of the private READ-ONLY server
 * reconciliation for the local student CSV preview.
 *
 * The accepted M2-08 preview and the accepted M2-11 decisions answer "what does
 * this file contain" and "which rows do I intend to include". They cannot answer
 * "does this value already exist in my tenant". This module adds exactly that
 * one question, and nothing else:
 *
 *   the user clicks once → the CURRENT locally INCLUDED rows are submitted to
 *   `POST /api/tenants/me/student-import/resolve` → the answer names, per row,
 *   which of the three exact keys already exist in the tenant.
 *
 * What this module is NOT, and never does:
 *  - it does not import, create, update, enroll, invite or grant access to
 *    anything, and it has no commit path at all;
 *  - it does not send a NAME, a guardian phone, a grade or any other column:
 *    the request carries `row_number`, `email`, `phone` and `barcode` only;
 *  - it does not send PENDING, EXCLUDED or INVALID rows: only rows whose local
 *    decision is `included` are candidates;
 *  - it never calls automatically. A file selection, a decision, a reset or a
 *    page change never triggers a request; only an explicit `resolve()` or
 *    `retry()` does;
 *  - it does not persist or log anything: no storage, no `console`, no trace of
 *    the private values survives the call;
 *  - it never presents a match as an identity proof, an import success or an
 *    approval to overwrite: a match is "this value already exists here".
 *
 * Lifecycle rules (the ones the handoff makes non-negotiable):
 *  - at most ONE request is in flight; a second click is refused with `busy`
 *    instead of racing the first;
 *  - a decision/file/principal/session/close/reset/dispose change CLEARS the
 *    results and RETIRES a pending reply, so a late answer can never restore
 *    private results into a scope that no longer owns them;
 *  - a retired reply cannot release a NEWER busy latch: the latch is owned by a
 *    ticket, and a reply whose ticket is no longer the active one changes
 *    nothing;
 *  - a reversed success/error order is therefore harmless: only the CURRENT
 *    ticket may publish, whatever order the promises settle in;
 *  - a malformed 2xx is a truthful `malformed` state, never a partial result and
 *    never a silent success;
 *  - a retry is explicit and re-sends the SAME rows the user submitted, or
 *    nothing at all if that set is gone.
 */
import { STUDENT_CSV_DUPLICATE_COLUMNS } from './csv-preview';
import type { ImportResolutionRow } from './import-resolution';

// ---------------------------------------------------------------------------
// Bounds and vocabulary
// ---------------------------------------------------------------------------

/** The maximum number of rows one request may carry (the server bound). */
export const SERVER_RESOLUTION_MAX_ROWS = 1000;
/** The physical line of the first data record of an accepted CSV file. */
export const SERVER_RESOLUTION_MIN_ROW_NUMBER = 2;
/** The physical line of the last possible data record. */
export const SERVER_RESOLUTION_MAX_ROW_NUMBER = 1001;

/**
 * The three exact match fields, in their DOCUMENTED response order.
 *
 * This is deliberately NOT `STUDENT_CSV_DUPLICATE_COLUMNS`: the accepted parser
 * declares its duplicate columns as phone, email, barcode, while the M2-14
 * contract fixes the `matched_fields` subset order as email, phone, barcode.
 * The two are the same SET and a different ORDER, so the order is stated here
 * explicitly instead of being inherited from a vocabulary that answers a
 * different question.
 */
export const SERVER_RESOLUTION_FIELDS = ['email', 'phone', 'barcode'] as const;
export type ServerResolutionField = (typeof SERVER_RESOLUTION_FIELDS)[number];

/**
 * The invariant that ties the two vocabularies together: the M2-14 match fields
 * are the SAME SET as the accepted duplicate columns, in a DIFFERENT documented
 * order. A future change that added a fourth column on one side only would make
 * this false, and the client suite asserts it.
 */
export const SERVER_RESOLUTION_VOCABULARY_MATCHES_CSV =
  STUDENT_CSV_DUPLICATE_COLUMNS.length === SERVER_RESOLUTION_FIELDS.length &&
  STUDENT_CSV_DUPLICATE_COLUMNS.every(
    (field) => (SERVER_RESOLUTION_FIELDS as readonly string[]).indexOf(field) !== -1,
  );

export interface ServerResolutionRequestRow {
  readonly row_number: number;
  readonly email: string;
  readonly phone: string;
  readonly barcode: string;
}

export interface ServerResolutionResultRow {
  readonly row_number: number;
  readonly matched_fields: readonly ServerResolutionField[];
}

export interface ServerResolutionSummary {
  readonly checked: number;
  readonly matched: number;
  readonly clear: number;
}

export interface ServerResolutionResult {
  readonly rows: readonly ServerResolutionResultRow[];
  readonly summary: ServerResolutionSummary;
}

// ---------------------------------------------------------------------------
// Request building
// ---------------------------------------------------------------------------

/** Why a request could not be built. Both are local, documented reasons. */
export type ServerResolutionBuildRefusal = 'no-included-rows' | 'too-many-rows';

export type ServerResolutionRequestBuild =
  | { readonly ok: true; readonly rows: readonly ServerResolutionRequestRow[] }
  | { readonly ok: false; readonly reason: ServerResolutionBuildRefusal };

/**
 * Builds the request from the CURRENT decision model.
 *
 * Only `included` rows are candidates — a pending row is an undecided question,
 * an excluded row is a refusal and an invalid row can never be imported, so
 * none of them is a reconciliation candidate. The physical row number is
 * preserved verbatim, and the three exact values are copied unchanged: nothing
 * is trimmed, casefolded or normalized here, because a normalized value would
 * no longer be the value the user's file contains.
 */
export function buildServerResolutionRequest(
  rows: readonly ImportResolutionRow[],
): ServerResolutionRequestBuild {
  const included = rows.filter((row) => row.status === 'included');
  if (included.length === 0) return { ok: false, reason: 'no-included-rows' };
  if (included.length > SERVER_RESOLUTION_MAX_ROWS) return { ok: false, reason: 'too-many-rows' };
  const projected: ServerResolutionRequestRow[] = [];
  for (const row of included) {
    // A row identity outside the documented physical range is not something
    // this endpoint can express; it is refused instead of being coerced.
    if (
      !Number.isInteger(row.rowNumber) ||
      row.rowNumber < SERVER_RESOLUTION_MIN_ROW_NUMBER ||
      row.rowNumber > SERVER_RESOLUTION_MAX_ROW_NUMBER
    ) {
      return { ok: false, reason: 'too-many-rows' };
    }
    projected.push({
      row_number: row.rowNumber,
      email: row.email,
      phone: row.phone,
      barcode: row.barcode,
    });
  }
  return { ok: true, rows: projected };
}

// ---------------------------------------------------------------------------
// Response parsing
// ---------------------------------------------------------------------------

export type ServerResolutionParseResult =
  | { readonly ok: true; readonly result: ServerResolutionResult }
  | { readonly ok: false; readonly reason: 'malformed' };

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isCount = (value: unknown): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value >= 0;

const isField = (value: unknown): value is ServerResolutionField =>
  typeof value === 'string' && (SERVER_RESOLUTION_FIELDS as readonly string[]).indexOf(value) !== -1;

/**
 * Parses a response against the EXACT rows that were submitted.
 *
 * The expected row numbers are the contract: one entry per submitted row, in
 * the submitted order, with no extra entry and no missing entry. Anything else —
 * an extra key, a reordered row, a duplicated field, an out-of-order subset, a
 * summary that does not balance — is `malformed`. A malformed answer is never
 * partially trusted and never repaired.
 */
export function parseServerResolutionResponse(
  raw: unknown,
  expectedRowNumbers: readonly number[],
): ServerResolutionParseResult {
  if (!isPlainObject(raw)) return { ok: false, reason: 'malformed' };
  const envelopeKeys = Object.keys(raw);
  if (envelopeKeys.length !== 2) return { ok: false, reason: 'malformed' };
  if (!Object.prototype.hasOwnProperty.call(raw, 'rows')) return { ok: false, reason: 'malformed' };
  if (!Object.prototype.hasOwnProperty.call(raw, 'summary')) return { ok: false, reason: 'malformed' };
  const rawRows = raw.rows;
  const rawSummary = raw.summary;
  if (!Array.isArray(rawRows)) return { ok: false, reason: 'malformed' };
  if (rawRows.length !== expectedRowNumbers.length) return { ok: false, reason: 'malformed' };

  const rows: ServerResolutionResultRow[] = [];
  let matchedCount = 0;
  for (let index = 0; index < rawRows.length; index += 1) {
    const entry = rawRows[index];
    if (!isPlainObject(entry)) return { ok: false, reason: 'malformed' };
    const entryKeys = Object.keys(entry);
    if (entryKeys.length !== 2) return { ok: false, reason: 'malformed' };
    if (!Object.prototype.hasOwnProperty.call(entry, 'row_number')) return { ok: false, reason: 'malformed' };
    if (!Object.prototype.hasOwnProperty.call(entry, 'matched_fields')) return { ok: false, reason: 'malformed' };
    // The response must answer the submitted rows in the submitted order.
    if (entry.row_number !== expectedRowNumbers[index]) return { ok: false, reason: 'malformed' };
    const rawFields = entry.matched_fields;
    if (!Array.isArray(rawFields)) return { ok: false, reason: 'malformed' };
    const fields: ServerResolutionField[] = [];
    let previousIndex = -1;
    for (const candidate of rawFields) {
      if (!isField(candidate)) return { ok: false, reason: 'malformed' };
      const position = (SERVER_RESOLUTION_FIELDS as readonly string[]).indexOf(candidate);
      // Strictly increasing: a duplicate or an out-of-order subset is malformed.
      if (position <= previousIndex) return { ok: false, reason: 'malformed' };
      previousIndex = position;
      fields.push(candidate);
    }
    if (fields.length > 0) matchedCount += 1;
    rows.push({ row_number: entry.row_number, matched_fields: fields });
  }

  if (!isPlainObject(rawSummary)) return { ok: false, reason: 'malformed' };
  if (Object.keys(rawSummary).length !== 3) return { ok: false, reason: 'malformed' };
  const checked = rawSummary.checked;
  const matched = rawSummary.matched;
  const clear = rawSummary.clear;
  if (!isCount(checked) || !isCount(matched) || !isCount(clear)) return { ok: false, reason: 'malformed' };
  // The summary must describe the rows it accompanies, not a different answer.
  if (checked !== rows.length) return { ok: false, reason: 'malformed' };
  if (matched !== matchedCount) return { ok: false, reason: 'malformed' };
  if (clear !== checked - matched) return { ok: false, reason: 'malformed' };

  return { ok: true, result: { rows, summary: { checked, matched, clear } } };
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

export type ServerResolutionPhase = 'idle' | 'resolving' | 'ready' | 'failed' | 'malformed';

export interface ServerResolutionState {
  readonly phase: ServerResolutionPhase;
  /** The confirmed reconciliation, or null. Never a partial answer. */
  readonly result: ServerResolutionResult | null;
  /** A truthful, non-private message for the current failure, or null. */
  readonly message: string | null;
  readonly revision: number;
}

/** The honest outcome of one explicit attempt. */
export type ServerResolutionOutcome =
  | { readonly ok: true; readonly result: ServerResolutionResult }
  | { readonly ok: false; readonly reason: ServerResolutionFailureReason };

export type ServerResolutionFailureReason =
  /** Nothing is currently included, so there is nothing to reconcile. */
  | 'no-included-rows'
  /** The local inclusion set exceeds the documented request bound. */
  | 'too-many-rows'
  /** A request is already in flight; the click was refused, not queued. */
  | 'busy'
  /** The canonical principal changed: the former scope's data is gone. */
  | 'scope-changed'
  /** A newer attempt (or a clear) retired this one; it changed nothing. */
  | 'superseded'
  /** The request failed. The outcome is NOT known to be "clear". */
  | 'failed'
  /** A 2xx that does not match the documented contract. */
  | 'malformed'
  /** No API adapter was injected. */
  | 'unavailable';

export const SERVER_RESOLUTION_MESSAGES: Record<string, string> = {
  'no-included-rows': 'لا توجد صفوف مُدرجة لمطابقتها مع سجلات المنصة.',
  'too-many-rows': 'عدد الصفوف المُدرجة يتجاوز الحد المسموح للمطابقة.',
  busy: 'جارٍ تنفيذ مطابقة أخرى؛ انتظر نتيجتها.',
  'scope-changed': 'تغيّرت الجلسة؛ تم مسح نتائج المطابقة.',
  superseded: 'تم إلغاء هذه المطابقة.',
  failed: 'تعذّرت مطابقة السجلات الموجودة. لم يُستنتج أن الصفوف غير موجودة.',
  malformed: 'ردّ الخادم لا يطابق الصيغة المتوقعة؛ لم تُعتمد أي نتيجة.',
  unavailable: 'المطابقة مع سجلات المنصة غير متاحة الآن.',
};

export interface ServerResolutionApi {
  /**
   * The injected transport. It receives ONLY the projected request rows and
   * resolves with the raw response body. It must reject on a non-2xx.
   */
  resolve?: (rows: readonly ServerResolutionRequestRow[]) => Promise<unknown>;
  /** The canonical principal reader. READ-ONLY here. */
  readPrincipal?: () => string | null;
  /** The canonical session notifier. READ-ONLY here. */
  subscribeSession?: (listener: () => void) => () => void;
}

export interface ServerResolutionController {
  getState(): ServerResolutionState;
  subscribe(listener: (state: ServerResolutionState) => void): () => void;
  /** One explicit attempt on the CURRENT included rows. */
  resolve(rows: readonly ImportResolutionRow[]): Promise<ServerResolutionOutcome>;
  /** One explicit retry of the SAME rows as the last attempt, if they still exist. */
  retry(): Promise<ServerResolutionOutcome>;
  /**
   * Adopts a silent principal change BEFORE the next action.
   * Returns true when the principal changed and the results were dropped.
   */
  revalidateScope(): boolean;
  /** Drops the results and retires any pending reply. */
  clear(): void;
  dispose(): void;
}

export function initialServerResolutionState(): ServerResolutionState {
  return { phase: 'idle', result: null, message: null, revision: 0 };
}

/**
 * Creates the reconciliation lifecycle for ONE mounted panel.
 *
 * At most one request is in flight, at most one confirmed result is held, and
 * every visible transition is gated by the ticket that started it.
 */
export function createServerResolutionController(
  api: ServerResolutionApi = {},
): ServerResolutionController {
  let state = initialServerResolutionState();
  let disposed = false;
  const listeners = new Set<(state: ServerResolutionState) => void>();
  const readPrincipal = (): string | null => (api.readPrincipal ? api.readPrincipal() : null);
  let observedPrincipal = readPrincipal();

  /** The monotonic ticket source. Every attempt takes one. */
  let lastTicket = 0;
  /** The ticket that currently OWNS the busy latch, or 0 when idle. */
  let latchTicket = 0;
  /** The rows of the last attempt, so a retry is explicit and identical. */
  let lastRows: readonly ServerResolutionRequestRow[] | null = null;

  const publish = (next: ServerResolutionState): void => {
    state = next;
    for (const listener of [...listeners]) listener(state);
  };

  const busy = (): boolean => latchTicket !== 0;

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
    lastRows = null;
    publish(initialServerResolutionState());
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

  /**
   * Runs ONE attempt. `rows` is the already-projected request body.
   *
   * The order of the fences matters: the principal is observed first (a scope
   * change must not even start a request), then the latch is taken, then the
   * ticket is minted. After the await, ONLY the current ticket may settle.
   */
  const run = async (rows: readonly ServerResolutionRequestRow[]): Promise<ServerResolutionOutcome> => {
    if (disposed) return { ok: false, reason: 'failed' };
    if (adoptPrincipalChange()) return { ok: false, reason: 'scope-changed' };
    if (busy()) return { ok: false, reason: 'busy' };
    const transport = api.resolve;
    if (typeof transport !== 'function') {
      publish({ phase: 'failed', result: null, message: SERVER_RESOLUTION_MESSAGES.unavailable, revision: state.revision + 1 });
      return { ok: false, reason: 'unavailable' };
    }

    const ticket = lastTicket + 1;
    lastTicket = ticket;
    latchTicket = ticket;
    lastRows = rows;
    publish({ phase: 'resolving', result: null, message: null, revision: state.revision + 1 });

    try {
      const raw = await transport(rows);
      // A retired attempt settles NOTHING: not the phase, not the result, not
      // the latch. This is what makes a reversed success/error order harmless.
      if (ticket !== lastTicket || disposed) return { ok: false, reason: 'superseded' };
      // A silent principal change during the flight drops the answer.
      if (readPrincipal() !== observedPrincipal) {
        observedPrincipal = readPrincipal();
        clear();
        return { ok: false, reason: 'scope-changed' };
      }
      const parsed = parseServerResolutionResponse(raw, rows.map((entry) => entry.row_number));
      if (parsed.ok !== true) {
        publish({ phase: 'malformed', result: null, message: SERVER_RESOLUTION_MESSAGES.malformed, revision: state.revision + 1 });
        return { ok: false, reason: 'malformed' };
      }
      publish({ phase: 'ready', result: parsed.result, message: null, revision: state.revision + 1 });
      return { ok: true, result: parsed.result };
    } catch {
      if (ticket !== lastTicket || disposed) return { ok: false, reason: 'superseded' };
      // A failure is NOT a "clear" answer: the state carries no result at all.
      publish({ phase: 'failed', result: null, message: SERVER_RESOLUTION_MESSAGES.failed, revision: state.revision + 1 });
      return { ok: false, reason: 'failed' };
    } finally {
      // Only the owner of the latch may release it: a retired reply must never
      // release a NEWER attempt's latch.
      if (latchTicket === ticket) latchTicket = 0;
    }
  };

  return {
    getState: () => state,
    subscribe: (listener) => {
      listeners.add(listener);
      listener(state);
      return () => { listeners.delete(listener); };
    },
    resolve: async (rows) => {
      const built = buildServerResolutionRequest(rows);
      if (built.ok !== true) {
        publish({ phase: 'failed', result: null, message: SERVER_RESOLUTION_MESSAGES[built.reason], revision: state.revision + 1 });
        return { ok: false, reason: built.reason };
      }
      return run(built.rows);
    },
    retry: async () => {
      // An explicit retry re-sends exactly what the user submitted. If that set
      // is gone (a decision, a file change or a clear), there is nothing to
      // retry and the attempt is refused instead of inventing rows.
      const rows = lastRows;
      if (!rows) return { ok: false, reason: 'no-included-rows' };
      return run(rows);
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
      lastRows = null;
      state = initialServerResolutionState();
    },
  };
}
