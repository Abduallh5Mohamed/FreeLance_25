/**
 * M2-11 — the LOCAL import-resolution model.
 *
 * Scope (human180/152 delegation, `docs/streams/client/M2-11-HANDOFF.md`): the
 * missing step between the accepted 170 preview (which FLAGS within-file
 * candidate collisions) and any future import. This module lets the user make
 * EXPLICIT include/exclude/pending decisions across the WHOLE bounded file and
 * reports the collisions that block an inclusion.
 *
 * What this module is NOT:
 *  - it does not parse, read or validate a file: it consumes the accepted
 *    `parseStudentCsv` result unchanged and never re-maps, casefolds or
 *    normalizes a value;
 *  - it does not merge, delete or auto-resolve anything, and it never applies a
 *    silent "first wins" rule;
 *  - it does not import, persist or call the server: there is no request, no
 *    storage and no account linking anywhere in this file;
 *  - it does not claim uniqueness in the platform: a decision is local
 *    preparation only, and the server may later reject the same values.
 *
 * The rules are deliberately small and explicit:
 *
 *  - a row with a structural issue is `invalid` and can NEVER be included;
 *  - an issue-free row that carries a within-file duplicate candidate starts
 *    `pending` — the user must choose, nothing is decided for them;
 *  - an issue-free row with no candidate starts `included`, because it collides
 *    with nothing in this file;
 *  - the `included` set must not collide on ANY of the three exact nonempty
 *    keys (`phone`, `email`, `barcode`), so a conflicting inclusion is REFUSED
 *    with the actual row numbers and the previous decisions are preserved.
 *
 * Bounds: the accepted parser caps the file at 1000 records, so this model
 * holds at most one bounded decision set for the current file instance. Every
 * collision lookup goes through ONE index of the included rows, keyed by the
 * exact nonempty field/value, that is built once per calculation: no all-pairs
 * comparison, no per-row DOM growth, and a duplicate group is never walked
 * once per row.
 */
import {
  STUDENT_CSV_DUPLICATE_COLUMNS,
  STUDENT_CSV_MAX_RECORDS,
  type StudentCsvDuplicateCandidate,
  type StudentCsvDuplicateColumn,
  type StudentCsvRow,
  type StudentCsvRowIssue,
} from './csv-preview';
import type { ServerResolutionField, ServerResolutionResult } from './server-resolution';

/**
 * The shape version of the published snapshot. A snapshot that does not carry
 * this exact version is not one of ours and is never read as a decision set.
 */
export const IMPORT_RESOLUTION_VERSION = 1;

/** Every status a row can have. The four are mutually exclusive. */
export type ImportRowStatus = 'included' | 'excluded' | 'pending' | 'invalid';

/** The two decisions a user can make about an issue-free row. */
export type ImportDecision = 'include' | 'exclude';

/**
 * One collision that blocks an inclusion: the exact key and the ALREADY
 * INCLUDED rows that carry the same exact trimmed value.
 */
export interface ImportConflictReference {
  readonly field: StudentCsvDuplicateColumn;
  readonly value: string;
  readonly rowNumbers: readonly number[];
}

/** Why a decision was refused. Every value is a local, documented reason. */
export type ImportRefusalReason = 'unknown-row' | 'invalid-row' | 'conflict';

export interface ImportResolutionRefusal {
  readonly rowNumber: number;
  readonly reason: ImportRefusalReason;
  /** The blocking collisions; empty for a non-conflict refusal. */
  readonly conflicts: readonly ImportConflictReference[];
}

/** A row projected into the decision model (the field text is copied verbatim). */
export interface ImportResolutionRow {
  /** The physical line the record starts on: the stable row identity. */
  readonly rowNumber: number;
  readonly rowIndex: number;
  readonly status: ImportRowStatus;
  readonly name: string;
  readonly email: string;
  readonly phone: string;
  readonly guardian_phone: string;
  readonly grade: string;
  readonly barcode: string;
  readonly issues: readonly StudentCsvRowIssue[];
  readonly duplicates: readonly StudentCsvDuplicateCandidate[];
}

/**
 * The counts of the current file. They are MUTUALLY EXCLUSIVE and always sum to
 * `total`: `included + excluded + pending + invalid === total`.
 */
export interface ImportResolutionCounts {
  readonly total: number;
  readonly included: number;
  readonly excluded: number;
  readonly pending: number;
  readonly invalid: number;
}

export interface ImportResolutionState {
  readonly version: number;
  /** True once a parsed file has been loaded into this instance. */
  readonly loaded: boolean;
  readonly rows: readonly ImportResolutionRow[];
  readonly counts: ImportResolutionCounts;
  /** Bumped by every accepted transition, so a consumer can detect a change. */
  readonly revision: number;
  /** The last refused decision, or null. Never a decision that was applied. */
  readonly refusal: ImportResolutionRefusal | null;
  /**
   * M2-15 — the explicit review of the CURRENT confirmed server matches, keyed
   * by the PHYSICAL row number so it survives paging and costs one bounded map
   * lookup per rendered row (no all-pairs scan, no all-row DOM).
   *
   * A matched row keeps its `included` DECISION and gains a `pending` review:
   * seeding a match never excludes anything by itself, because an automatic
   * exclusion is exactly what this batch forbids.
   */
  readonly serverMatches: ReadonlyMap<number, ServerMatchReview>;
  /** The review counts of the current set. Mutually exclusive, sum to its size. */
  readonly serverMatchCounts: ServerMatchCounts;
  /** The generation of the set. Every seed takes the next one. */
  readonly serverMatchGeneration: number;
  /**
   * The identity of the confirmed reconciliation that seeded the set, so
   * re-seeding the SAME result is a no-op instead of resetting the user's
   * keep/exclude decisions on every render.
   */
  readonly serverMatchSource: unknown;
}

/** The three review states of one matched row. Mutually exclusive. */
export type ServerMatchReviewState = 'pending' | 'kept' | 'excluded';

/** Every review state, in the documented order. */
export const SERVER_MATCH_REVIEW_STATES = ['pending', 'kept', 'excluded'] as const;

/**
 * One explicit review of a matched row.
 *
 * `matched_fields` is the EXACT subset of field NAMES the confirmed response
 * returned for this row, in its documented order. It never carries a stored
 * value, an id, a name or a count of existing records.
 */
export interface ServerMatchReview {
  readonly matched_fields: readonly ServerResolutionField[];
  readonly review: ServerMatchReviewState;
  /** The set generation this entry belongs to; a stale entry is never trusted. */
  readonly generation: number;
}

export interface ServerMatchCounts {
  readonly pending: number;
  readonly kept: number;
  readonly excluded: number;
}

const emptyServerMatchCounts = (): ServerMatchCounts => ({ pending: 0, kept: 0, excluded: 0 });

const countServerMatches = (
  matches: ReadonlyMap<number, ServerMatchReview>,
): ServerMatchCounts => {
  let pending = 0;
  let kept = 0;
  let excluded = 0;
  for (const entry of matches.values()) {
    if (entry.review === 'pending') pending += 1;
    else if (entry.review === 'kept') kept += 1;
    else excluded += 1;
  }
  return { pending, kept, excluded };
};

export type ImportDecisionResult =
  | { readonly ok: true; readonly state: ImportResolutionState }
  | {
      readonly ok: false;
      readonly reason: ImportRefusalReason;
      readonly conflicts: readonly ImportConflictReference[];
      /** The published state: unchanged decisions, plus the refusal record. */
      readonly state: ImportResolutionState;
    };

const emptyCounts = (): ImportResolutionCounts => ({
  total: 0,
  included: 0,
  excluded: 0,
  pending: 0,
  invalid: 0,
});

/** The state of a mounted panel that has no file yet. */
export function initialImportResolutionState(): ImportResolutionState {
  return {
    version: IMPORT_RESOLUTION_VERSION,
    loaded: false,
    rows: [],
    counts: emptyCounts(),
    revision: 0,
    refusal: null,
    serverMatches: new Map<number, ServerMatchReview>(),
    serverMatchCounts: emptyServerMatchCounts(),
    serverMatchGeneration: 0,
    serverMatchSource: null,
  };
}

/**
 * The status a row starts with, derived ONLY from the accepted parse result:
 * an issue makes it invalid, a within-file candidate makes it pending, and a
 * row with neither starts included.
 */
const initialStatus = (issues: readonly unknown[], duplicates: readonly unknown[]): ImportRowStatus => {
  if (issues.length > 0) return 'invalid';
  if (duplicates.length > 0) return 'pending';
  return 'included';
};

const countRows = (rows: readonly ImportResolutionRow[]): ImportResolutionCounts => {
  let included = 0;
  let excluded = 0;
  let pending = 0;
  let invalid = 0;
  for (const row of rows) {
    if (row.status === 'included') included += 1;
    else if (row.status === 'excluded') excluded += 1;
    else if (row.status === 'pending') pending += 1;
    else invalid += 1;
  }
  return { total: rows.length, included, excluded, pending, invalid };
};

/** How many rows are NOT included: the exact set the report carries. */
export const nonIncludedCount = (counts: ImportResolutionCounts): number =>
  counts.invalid + counts.excluded + counts.pending;

/**
 * Loads one parsed file into a fresh decision set.
 *
 * The load FAILS CLOSED on a result this model cannot represent — more records
 * than the accepted parser bound, or a repeated physical row identity — so a
 * malformed input never produces a half-decided panel.
 */
export function loadImportResolution(rows: readonly StudentCsvRow[]): ImportResolutionState {
  if (rows.length > STUDENT_CSV_MAX_RECORDS) return initialImportResolutionState();
  const seen = new Set<number>();
  const projected: ImportResolutionRow[] = [];
  for (const row of rows) {
    // The physical line is the stable identity of a decision; a repeat would
    // make two different records share one decision, so it is refused.
    if (seen.has(row.rowNumber)) return initialImportResolutionState();
    seen.add(row.rowNumber);
    projected.push({
      rowNumber: row.rowNumber,
      rowIndex: row.rowIndex,
      status: initialStatus(row.issues, row.duplicates),
      name: row.name,
      email: row.email,
      phone: row.phone,
      guardian_phone: row.guardian_phone,
      grade: row.grade,
      barcode: row.barcode,
      issues: row.issues,
      duplicates: row.duplicates,
    });
  }
  return {
    version: IMPORT_RESOLUTION_VERSION,
    loaded: true,
    rows: projected,
    counts: countRows(projected),
    revision: 0,
    refusal: null,
    // A freshly loaded file has no confirmed reconciliation behind it.
    serverMatches: new Map<number, ServerMatchReview>(),
    serverMatchCounts: emptyServerMatchCounts(),
    serverMatchGeneration: 0,
    serverMatchSource: null,
  };
}

/** Restores the initial decisions of the SAME file, clearing the refusal. */
export function resetImportResolution(state: ImportResolutionState): ImportResolutionState {
  if (!state.loaded) return state;
  const rows = state.rows.map((row) => ({
    ...row,
    status: initialStatus(row.issues, row.duplicates),
  }));
  return {
    ...state,
    rows,
    counts: countRows(rows),
    revision: state.revision + 1,
    refusal: null,
    // A reset returns the DECISIONS to their initial state, so every review
    // that was made against the previous set is retired with it.
    serverMatches: new Map<number, ServerMatchReview>(),
    serverMatchCounts: emptyServerMatchCounts(),
    serverMatchGeneration: state.serverMatchGeneration + 1,
    serverMatchSource: null,
  };
}

/**
 * The exact index key of one collision: the field and the EXACT, nonempty,
 * already trimmed value.
 *
 * The key is the field name followed by the EXACT value. The three field names
 * are not prefixes of one another, so two different fields can never produce
 * the same key, and two rows share a key exactly when they carry the same
 * field and the same exact value.
 */
const conflictKey = (field: StudentCsvDuplicateColumn, value: string): string =>
  `${field} ${value}`;

/**
 * The INCLUDED rows indexed by their exact collision key, built ONCE.
 *
 * The index replaces a traversal of every candidate group: the work is
 * proportional to the number of included rows (at most three keys each), not
 * to the size of the duplicate groups. A group's own member list is never
 * read, so one 1000-member group cannot cost 1000 reads per pending row.
 */
const includedKeyIndex = (
  rows: readonly ImportResolutionRow[],
): Map<string, number[]> => {
  const index = new Map<string, number[]>();
  for (const row of rows) {
    if (row.status !== 'included') continue;
    for (const field of STUDENT_CSV_DUPLICATE_COLUMNS) {
      const value = row[field];
      // A blank value never matches anything, exactly as in the parser.
      if (value === '') continue;
      const key = conflictKey(field, value);
      const existing = index.get(key);
      if (existing) existing.push(row.rowNumber);
      else index.set(key, [row.rowNumber]);
    }
  }
  return index;
};

/**
 * The collisions that block including `rowNumber`.
 *
 * Only rows that are CURRENTLY INCLUDED can block an inclusion, and only on an
 * exact, nonempty key. A row never conflicts with itself. The lookup is a
 * bounded key read from the included-row index, never a traversal of a
 * duplicate group.
 */
export function findImportConflicts(
  state: ImportResolutionState,
  rowNumber: number,
): readonly ImportConflictReference[] {
  const row = state.rows.find((candidate) => candidate.rowNumber === rowNumber);
  if (!row || row.duplicates.length === 0) return [];
  const index = includedKeyIndex(state.rows);
  const conflicts: ImportConflictReference[] = [];
  for (const candidate of row.duplicates) {
    const blocking = (index.get(conflictKey(candidate.field, candidate.value)) ?? []).filter(
      (number) => number !== rowNumber,
    );
    if (blocking.length > 0) {
      conflicts.push({ field: candidate.field, value: candidate.value, rowNumbers: blocking });
    }
  }
  return conflicts;
}

/**
 * The blocking collisions of EVERY row the user could still include, in ONE
 * pass over the file.
 *
 * This is what lets the panel show a whole-file truth on a 25-row page: the
 * conflicts of a row are computed against the whole file, never against the
 * visible slice. Pending and excluded rows are both included in the result,
 * because an excluded row may be re-included once its conflicts are gone.
 *
 * The cost is bounded by the number of rows and the three exact keys each of
 * them can carry: the included-row index is built once and every row is then a
 * bounded key lookup, so a duplicate group is never walked once per row.
 */
export function computeBlockingConflicts(
  state: ImportResolutionState,
): ReadonlyMap<number, readonly ImportConflictReference[]> {
  const index = includedKeyIndex(state.rows);
  const result = new Map<number, readonly ImportConflictReference[]>();
  for (const row of state.rows) {
    if (row.status === 'included' || row.status === 'invalid') continue;
    if (row.duplicates.length === 0) continue;
    const conflicts: ImportConflictReference[] = [];
    for (const candidate of row.duplicates) {
      const blocking = (index.get(conflictKey(candidate.field, candidate.value)) ?? []).filter(
        (number) => number !== row.rowNumber,
      );
      if (blocking.length > 0) {
        conflicts.push({ field: candidate.field, value: candidate.value, rowNumbers: blocking });
      }
    }
    if (conflicts.length > 0) result.set(row.rowNumber, conflicts);
  }
  return result;
}

const replaceRow = (
  state: ImportResolutionState,
  rowNumber: number,
  status: ImportRowStatus,
): ImportResolutionState => {
  const rows = state.rows.map((row) =>
    row.rowNumber === rowNumber ? { ...row, status } : row,
  );
  return {
    ...state,
    rows,
    counts: countRows(rows),
    revision: state.revision + 1,
    refusal: null,
  };
};

const refuse = (
  state: ImportResolutionState,
  rowNumber: number,
  reason: ImportRefusalReason,
  conflicts: readonly ImportConflictReference[],
): ImportDecisionResult => ({
  ok: false,
  reason,
  conflicts,
  state: { ...state, refusal: { rowNumber, reason, conflicts } },
});

/**
 * Applies ONE explicit decision to ONE row.
 *
 * An inclusion is refused when it would make two INCLUDED rows share an exact
 * nonempty key. The refusal is not a silent failure: it names the field, the
 * value and the actual row numbers, and the previous decisions are untouched.
 */
export function applyImportDecision(
  state: ImportResolutionState,
  rowNumber: number,
  decision: ImportDecision,
): ImportDecisionResult {
  if (!state.loaded) return refuse(state, rowNumber, 'unknown-row', []);
  const row = state.rows.find((candidate) => candidate.rowNumber === rowNumber);
  if (!row) return refuse(state, rowNumber, 'unknown-row', []);
  // A structurally invalid row is never includable, and excluding it would
  // pretend a decision was made about a row that cannot be imported at all.
  if (row.status === 'invalid') return refuse(state, rowNumber, 'invalid-row', []);
  if (decision === 'exclude') {
    if (row.status === 'excluded') return { ok: true, state };
    return { ok: true, state: replaceRow(state, rowNumber, 'excluded') };
  }
  const conflicts = findImportConflicts(state, rowNumber);
  if (conflicts.length > 0) return refuse(state, rowNumber, 'conflict', conflicts);
  if (row.status === 'included') return { ok: true, state };
  return { ok: true, state: replaceRow(state, rowNumber, 'included') };
}

// ---------------------------------------------------------------------------
// M2-15 — the explicit review of the current confirmed server matches
// ---------------------------------------------------------------------------

/**
 * Retires every review and forgets the source result.
 *
 * Idempotent: an already-empty set is returned unchanged, so a caller may run
 * this on every non-confirmed transition without churning the revision.
 */
export function clearServerMatches(state: ImportResolutionState): ImportResolutionState {
  if (state.serverMatches.size === 0 && state.serverMatchSource === null) return state;
  return {
    ...state,
    serverMatches: new Map<number, ServerMatchReview>(),
    serverMatchCounts: emptyServerMatchCounts(),
    serverMatchGeneration: state.serverMatchGeneration + 1,
    serverMatchSource: null,
    revision: state.revision + 1,
  };
}

/**
 * Seeds the review from ONE current confirmed reconciliation.
 *
 * The whole previous set is REPLACED atomically, and re-seeding the SAME result
 * is a no-op, so a re-render can never reset the user's keep/exclude decisions.
 *
 * Only a row that exists in this model AND is currently `included` becomes a
 * review item: a result for a row the model does not hold is ignored rather
 * than invented, and seeding NEVER changes a decision — an automatic exclusion
 * is exactly what this batch forbids.
 */
export function seedServerMatches(
  state: ImportResolutionState,
  result: ServerResolutionResult,
): ImportResolutionState {
  if (!state.loaded) return state;
  if (state.serverMatchSource === result) return state;
  const byRowNumber = new Map(state.rows.map((row) => [row.rowNumber, row]));
  const generation = state.serverMatchGeneration + 1;
  const matches = new Map<number, ServerMatchReview>();
  for (const entry of result.rows) {
    if (entry.matched_fields.length === 0) continue;
    const row = byRowNumber.get(entry.row_number);
    if (!row || row.status !== 'included') continue;
    matches.set(entry.row_number, {
      // The exact subset, in the response's documented order, copied as-is.
      matched_fields: [...entry.matched_fields],
      review: 'pending',
      generation,
    });
  }
  return {
    ...state,
    serverMatches: matches,
    serverMatchCounts: countServerMatches(matches),
    serverMatchGeneration: generation,
    serverMatchSource: result,
    revision: state.revision + 1,
  };
}

/**
 * Keeps one matched row included: only the REVIEW changes, never the decision.
 *
 * It applies to a row that is still `included` (i.e. a `pending` review). A row
 * already excluded by its match is returned to review with `undoServerMatch`
 * first, so the model can never hold the contradictory pair
 * `review: 'kept'` + `status: 'excluded'`.
 */
export function keepServerMatch(
  state: ImportResolutionState,
  rowNumber: number,
): ImportResolutionState {
  const entry = state.serverMatches.get(rowNumber);
  if (!entry || entry.review === 'kept') return state;
  const row = state.rows.find((candidate) => candidate.rowNumber === rowNumber);
  if (!row || row.status !== 'included') return state;
  const matches = new Map(state.serverMatches);
  matches.set(rowNumber, { ...entry, review: 'kept' });
  return {
    ...state,
    serverMatches: matches,
    serverMatchCounts: countServerMatches(matches),
    revision: state.revision + 1,
  };
}

/**
 * Excludes one matched row: the ONLY path that turns a match into a decision.
 *
 * It is always explicit — the user clicked — and it records the exact matched
 * field names so the local report can state WHY the row was excluded.
 */
export function excludeServerMatch(
  state: ImportResolutionState,
  rowNumber: number,
): ImportResolutionState {
  const entry = state.serverMatches.get(rowNumber);
  if (!entry) return state;
  const row = state.rows.find((candidate) => candidate.rowNumber === rowNumber);
  // Only an includable row can be excluded; an invalid row is never decided.
  if (!row || row.status !== 'included') return state;
  const matches = new Map(state.serverMatches);
  matches.set(rowNumber, { ...entry, review: 'excluded' });
  const rows = state.rows.map((candidate) =>
    candidate.rowNumber === rowNumber ? { ...candidate, status: 'excluded' as const } : candidate,
  );
  return {
    ...state,
    rows,
    counts: countRows(rows),
    serverMatches: matches,
    serverMatchCounts: countServerMatches(matches),
    revision: state.revision + 1,
    refusal: null,
  };
}

/**
 * Returns one reviewed row to `server-match-pending`.
 *
 * An exclusion made by `excludeServerMatch` is undone back to `included`. This
 * can never create a within-file conflict: while a review set exists the only
 * decision changes available are `keepServerMatch` (no change) and
 * `excludeServerMatch` (removal), because any plain decision retires the whole
 * set first.
 */
export function undoServerMatch(
  state: ImportResolutionState,
  rowNumber: number,
): ImportResolutionState {
  const entry = state.serverMatches.get(rowNumber);
  if (!entry || entry.review === 'pending') return state;
  const matches = new Map(state.serverMatches);
  matches.set(rowNumber, { ...entry, review: 'pending' });
  const rows = entry.review === 'excluded'
    ? state.rows.map((candidate) =>
        candidate.rowNumber === rowNumber && candidate.status === 'excluded'
          ? { ...candidate, status: 'included' as const }
          : candidate,
      )
    : state.rows;
  return {
    ...state,
    rows,
    counts: countRows(rows),
    serverMatches: matches,
    serverMatchCounts: countServerMatches(matches),
    revision: state.revision + 1,
  };
}

/**
 * The CURRENT review of one row, or null.
 *
 * An entry from an older generation is never returned, so a report can never
 * carry matched field names that belong to a superseded reconciliation.
 */
export function currentServerMatchReview(
  state: ImportResolutionState,
  rowNumber: number,
): ServerMatchReview | null {
  const entry = state.serverMatches.get(rowNumber);
  if (!entry) return null;
  if (entry.generation !== state.serverMatchGeneration) return null;
  return entry;
}

// ---------------------------------------------------------------------------
// The lifecycle seam
// ---------------------------------------------------------------------------

export interface ImportResolutionApi {
  /** The canonical principal reader. It is READ-ONLY here. */
  readPrincipal?: () => string | null;
  /** The canonical session notifier. It is READ-ONLY here. */
  subscribeSession?: (listener: () => void) => () => void;
}

export interface ImportResolutionController {
  getState(): ImportResolutionState;
  subscribe(listener: (state: ImportResolutionState) => void): () => void;
  /** Replaces the decision set with the initial decisions of ONE parsed file. */
  load(rows: readonly StudentCsvRow[]): void;
  /** Restores the initial decisions of the current file. */
  reset(): void;
  include(rowNumber: number): ImportDecisionResult;
  exclude(rowNumber: number): ImportDecisionResult;
  /**
   * M2-15 — seeds the review from ONE current confirmed reconciliation.
   * Idempotent for the same result; replaces the whole previous set otherwise.
   */
  seedServerMatches(result: ServerResolutionResult): void;
  /** Retires every review: a retired result must leave nothing behind. */
  clearServerMatches(): void;
  /** Keeps one matched row included (review only). */
  keepServerMatch(rowNumber: number): void;
  /** Excludes one matched row: the only explicit match-to-decision path. */
  excludeServerMatch(rowNumber: number): void;
  /** Returns one reviewed row to server-match-pending. */
  undoServerMatch(rowNumber: number): void;
  /** The blocking collisions of every decisionable row, whole file. */
  blockingConflicts(): ReadonlyMap<number, readonly ImportConflictReference[]>;
  /**
   * Re-reads the canonical principal and adopts a silent scope change.
   *
   * Returns TRUE when the canonical principal changed since the last
   * observation: the private decisions were dropped, so the caller MUST refuse
   * any action that would export the former scope's rows. Returns FALSE when
   * the scope is unchanged and the current decisions may be used.
   *
   * The reader is the canonical one this controller was built with, so the
   * check is the same observation the decisions themselves are fenced by.
   */
  revalidateScope(): boolean;
  /** Clears the decision set: a closed panel, a refused file, a lost session. */
  clear(): void;
  dispose(): void;
}

/**
 * Creates the decision lifecycle for ONE mounted panel.
 *
 * At most ONE bounded decision set is held: loading a file replaces it, and a
 * clear drops it entirely. The canonical principal is observed BEFORE every
 * decision is applied, so a silent session swap can never let an old scope's
 * decision land on a new scope's rows.
 */
export function createImportResolutionController(
  api: ImportResolutionApi = {},
): ImportResolutionController {
  let state = initialImportResolutionState();
  let disposed = false;
  const listeners = new Set<(state: ImportResolutionState) => void>();
  const readPrincipal = (): string | null => (api.readPrincipal ? api.readPrincipal() : null);
  let observedPrincipal = readPrincipal();

  const publish = (next: ImportResolutionState): void => {
    state = next;
    for (const listener of [...listeners]) listener(state);
  };

  const clear = (): void => {
    publish(initialImportResolutionState());
  };

  /**
   * Adopts a silent principal change BEFORE the requested action is applied.
   * A decision made in one scope is never applied to another scope's rows.
   */
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
        // A session change drops every decision: the private file metadata is
        // gone with the scope, so a later decision has nothing to land on.
        observedPrincipal = readPrincipal();
        clear();
      })
    : undefined;

  return {
    getState: () => state,
    subscribe: (listener) => {
      listeners.add(listener);
      listener(state);
      return () => { listeners.delete(listener); };
    },
    load: (rows) => {
      if (disposed) return;
      adoptPrincipalChange();
      publish(loadImportResolution(rows));
    },
    reset: () => {
      if (disposed) return;
      adoptPrincipalChange();
      if (!state.loaded) return;
      publish(resetImportResolution(state));
    },
    include: (rowNumber) => {
      if (disposed) return { ok: false, reason: 'unknown-row', conflicts: [], state };
      adoptPrincipalChange();
      // A plain CSV decision changes the decision set the confirmed match set
      // belonged to, so every review is retired with it.
      const base = clearServerMatches(state);
      const result = applyImportDecision(base, rowNumber, 'include');
      publish(result.state);
      return result;
    },
    exclude: (rowNumber) => {
      if (disposed) return { ok: false, reason: 'unknown-row', conflicts: [], state };
      adoptPrincipalChange();
      const base = clearServerMatches(state);
      const result = applyImportDecision(base, rowNumber, 'exclude');
      publish(result.state);
      return result;
    },
    seedServerMatches: (result) => {
      if (disposed) return;
      // A silent principal change first: another scope's answer must never seed.
      adoptPrincipalChange();
      publish(seedServerMatches(state, result));
    },
    clearServerMatches: () => {
      if (disposed) return;
      publish(clearServerMatches(state));
    },
    keepServerMatch: (rowNumber) => {
      if (disposed) return;
      adoptPrincipalChange();
      publish(keepServerMatch(state, rowNumber));
    },
    excludeServerMatch: (rowNumber) => {
      if (disposed) return;
      adoptPrincipalChange();
      publish(excludeServerMatch(state, rowNumber));
    },
    undoServerMatch: (rowNumber) => {
      if (disposed) return;
      adoptPrincipalChange();
      publish(undoServerMatch(state, rowNumber));
    },
    blockingConflicts: () => computeBlockingConflicts(state),
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
      state = initialImportResolutionState();
    },
  };
}
