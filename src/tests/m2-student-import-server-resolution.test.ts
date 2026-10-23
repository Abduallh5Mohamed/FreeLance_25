/**
 * M2-14 / M2-B08 — private READ-ONLY student-import server reconciliation:
 * isolated production-path tests (node:test + tsx).
 *
 * Scope: the REAL accepted parser and decision model
 * (`src/features/students/csv-preview.ts`, `import-resolution.ts`), the REAL
 * M2-14 client module (`src/features/students/server-resolution.ts`) and the
 * REAL `StudentImportPreview` component with its ACTUAL control callbacks — all
 * imported unchanged. Fully isolated: no DB, no network, no browser, no
 * storage, no dependency install.
 *
 * Behaviours pinned:
 *  - only CURRENTLY INCLUDED rows are submitted: a pending, excluded or invalid
 *    row is never sent, and the request row carries exactly the four documented
 *    keys — never a name, a guardian phone or a grade;
 *  - the physical row number is preserved, and the three values are copied
 *    unchanged (nothing is trimmed, casefolded or normalized);
 *  - the response is trusted only when it answers the submitted rows, in the
 *    submitted order, with the documented field subset order and a summary that
 *    balances; anything else is a truthful `malformed` state;
 *  - exactly one request is in flight, a second click is refused (not queued),
 *    and an automatic call never happens on a file/decision/reset change;
 *  - a decision/file/principal/session/close/reset/dispose change clears the
 *    results and retires a pending reply;
 *  - a retired reply cannot publish, cannot restore private results and cannot
 *    release a NEWER busy latch, so a reversed success/error order is harmless;
 *  - a failure is never presented as "the rows do not exist", and a retry is
 *    explicit and re-sends the SAME rows;
 *  - the component renders the reconciliation only with a live seam, keeps the
 *    close control enabled while a request is in flight, and states on screen
 *    that nothing was imported and no access was granted.
 *
 * Not proven here: real browser transport, DOM paint, RTL layout and any real
 * server behaviour (covered by the server suites).
 */
import assert from "node:assert/strict";
import test from "node:test";
import Module from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  STUDENT_CSV_DUPLICATE_COLUMNS,
  createStudentCsvPreviewController,
  parseStudentCsv,
  type StudentCsvPreviewState,
  type StudentCsvRow,
} from "../features/students/csv-preview";
import {
  applyImportDecision,
  clearServerMatches,
  createImportResolutionController,
  currentServerMatchReview,
  excludeServerMatch,
  keepServerMatch,
  loadImportResolution,
  seedServerMatches,
  undoServerMatch,
  type ImportResolutionRow,
  type ImportResolutionState,
} from "../features/students/import-resolution";
import { buildImportReport } from "../features/students/import-report";
import {
  SERVER_RESOLUTION_FIELDS,
  SERVER_RESOLUTION_MAX_ROW_NUMBER,
  SERVER_RESOLUTION_MAX_ROWS,
  SERVER_RESOLUTION_MESSAGES,
  SERVER_RESOLUTION_VOCABULARY_MATCHES_CSV,
  buildServerResolutionRequest,
  createServerResolutionController,
  parseServerResolutionResponse,
  type ServerResolutionRequestRow,
} from "../features/students/server-resolution";

// ---------------------------------------------------------------------------
// Fixtures and helpers
// ---------------------------------------------------------------------------

const SRC_ROOT = fileURLToPath(new URL("..", import.meta.url));

const flush = (): Promise<void> => new Promise<void>((resolve) => setImmediate(resolve));

const parsedRows = (csv: string): StudentCsvRow[] => {
  const parsed = parseStudentCsv(csv);
  if (parsed.ok !== true) throw new Error(`fixture must parse: ${JSON.stringify(parsed.error)}`);
  return parsed.rows;
};

const modelOf = (csv: string): ImportResolutionState => loadImportResolution(parsedRows(csv));

/**
 * The default fixture. Rows 2 and 3 share the exact phone `0100`, so BOTH start
 * PENDING (the accepted model never picks a winner); row 4 has no name and is
 * INVALID; rows 5 and 6 are INCLUDED. The included set is therefore [5, 6].
 */
const CSV =
  "name,phone,email\nAli,0100,a@b.c\nSara,0100,d@e.f\n,0300,o@b.c\nOmar,0400,q@r.s\nHana,0500,h@i.j\n";

const INCLUDED = [5, 6];

const includedRowsOf = (csv = CSV): ImportResolutionRow[] =>
  modelOf(csv).rows.filter((row) => row.status === "included");

/** A synthetic model row, for the bounds a real parser can never produce. */
const syntheticRow = (overrides: Partial<ImportResolutionRow> = {}): ImportResolutionRow => ({
  rowNumber: 2,
  rowIndex: 1,
  status: "included",
  name: "Ali",
  email: "a@b.c",
  phone: "0100",
  guardian_phone: "0111",
  grade: "3",
  barcode: "B1",
  issues: [],
  duplicates: [],
  ...overrides,
});

interface Deferred<T> { promise: Promise<T>; resolve: (value: T) => void; reject: (error: unknown) => void }

const deferred = <T,>(): Deferred<T> => {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
};

/** The exact wire body of a successful answer for the given row numbers. */
const envelopeFor = (entries: Array<[number, string[]]>): unknown => {
  const rows = entries.map(([row_number, matched_fields]) => ({ row_number, matched_fields }));
  const matched = rows.filter((entry) => entry.matched_fields.length > 0).length;
  return { rows, summary: { checked: rows.length, matched, clear: rows.length - matched } };
};

/** A transport that records every submitted body and answers one envelope. */
const recordingTransport = (answer: unknown | ((rows: readonly ServerResolutionRequestRow[]) => unknown) = []) => {
  const calls: ServerResolutionRequestRow[][] = [];
  const transport = async (rows: readonly ServerResolutionRequestRow[]) => {
    calls.push(rows.map((row) => ({ ...row })));
    return typeof answer === "function" ? (answer as (rows: readonly ServerResolutionRequestRow[]) => unknown)(rows) : answer;
  };
  return { transport, calls };
};

// ---------------------------------------------------------------------------
// Request building
// ---------------------------------------------------------------------------

test("request: only the CURRENTLY INCLUDED rows are submitted", () => {
  const built = buildServerResolutionRequest(modelOf(CSV).rows);
  assert.equal(built.ok, true);
  if (built.ok !== true) return;
  assert.deepEqual(built.rows.map((row) => row.row_number), INCLUDED);
});

test("request: a pending row is never submitted", () => {
  const built = buildServerResolutionRequest(modelOf(CSV).rows);
  assert.equal(built.ok, true);
  if (built.ok !== true) return;
  assert.equal(built.rows.some((row) => row.row_number === 2), false, "row 2 is pending, not decided");
  assert.equal(built.rows.some((row) => row.row_number === 3), false, "row 3 is pending, not decided");
});

test("request: an excluded row is never submitted", () => {
  // Row 5 is INCLUDED by the fixture; an explicit exclusion must remove it.
  const excluded = applyImportDecision(modelOf(CSV), 5, "exclude").state;
  const built = buildServerResolutionRequest(excluded.rows);
  assert.equal(built.ok, true);
  if (built.ok !== true) return;
  assert.deepEqual(built.rows.map((row) => row.row_number), [6]);
});

test("request: an invalid row is never submitted", () => {
  const built = buildServerResolutionRequest(modelOf(CSV).rows);
  assert.equal(built.ok, true);
  if (built.ok !== true) return;
  assert.equal(built.rows.some((row) => row.row_number === 4), false, "row 4 is invalid");
});

test("request: the row carries exactly the four documented keys", () => {
  const built = buildServerResolutionRequest(modelOf(CSV).rows);
  assert.equal(built.ok, true);
  if (built.ok !== true) return;
  for (const row of built.rows) {
    assert.deepEqual(Object.keys(row).sort(), ["barcode", "email", "phone", "row_number"]);
  }
});

test("request: no name, guardian phone or grade is ever sent", () => {
  const built = buildServerResolutionRequest(modelOf(CSV).rows);
  assert.equal(built.ok, true);
  if (built.ok !== true) return;
  const serialized = JSON.stringify(built.rows);
  for (const forbidden of ["Ali", "Omar", "name", "guardian", "grade", "0111", "rowIndex"]) {
    assert.equal(serialized.includes(forbidden), false, `the request must not contain ${forbidden}`);
  }
});

test("request: the PHYSICAL row number is preserved, not the display index", () => {
  // The accepted parser numbers a record by its physical line, and a quoted
  // multi-line cell makes the row number differ from the record index.
  const rows = parsedRows('name,phone\n"Ali\nAli",0100\nSara,0200\n');
  const built = buildServerResolutionRequest(loadImportResolution(rows).rows);
  assert.equal(built.ok, true);
  if (built.ok !== true) return;
  assert.deepEqual(built.rows.map((row) => row.row_number), [2, 4]);
});

test("request: the three values are copied unchanged, never normalized", () => {
  const rows = parsedRows("name,phone,email,barcode\nAli,007,A@B.C,00B1\n");
  const built = buildServerResolutionRequest(loadImportResolution(rows).rows);
  assert.equal(built.ok, true);
  if (built.ok !== true) return;
  assert.equal(built.rows[0].phone, "007");
  assert.equal(built.rows[0].email, "A@B.C");
  assert.equal(built.rows[0].barcode, "00B1");
});

test("request: an empty inclusion set is refused with no-included-rows", () => {
  const model = modelOf(CSV);
  const none = { ...model, rows: model.rows.map((row) => ({ ...row, status: "excluded" as const })) };
  const built = buildServerResolutionRequest(none.rows);
  assert.equal(built.ok, false);
  if (built.ok !== false) return;
  assert.equal(built.reason, "no-included-rows");
});

test("request: an over-bound inclusion set is refused with too-many-rows", () => {
  const rows = Array.from({ length: SERVER_RESOLUTION_MAX_ROWS + 1 }, (_, index) =>
    syntheticRow({ rowNumber: index + 2, rowIndex: index + 1 }),
  );
  const built = buildServerResolutionRequest(rows);
  assert.equal(built.ok, false);
  if (built.ok !== false) return;
  assert.equal(built.reason, "too-many-rows");
});

test("request: a row identity outside the physical range is refused, never coerced", () => {
  const below = buildServerResolutionRequest([syntheticRow({ rowNumber: 1 })]);
  assert.equal(below.ok, false);
  const above = buildServerResolutionRequest([syntheticRow({ rowNumber: SERVER_RESOLUTION_MAX_ROW_NUMBER + 1 })]);
  assert.equal(above.ok, false);
});

// ---------------------------------------------------------------------------
// Response parsing
// ---------------------------------------------------------------------------

const parse = (raw: unknown, expected: number[] = [2]) => parseServerResolutionResponse(raw, expected);

test("parse: the documented envelope is accepted", () => {
  const parsed = parse(envelopeFor([[2, ["email"]]]));
  assert.equal(parsed.ok, true);
  if (parsed.ok !== true) return;
  assert.deepEqual(parsed.result.rows, [{ row_number: 2, matched_fields: ["email"] }]);
  assert.deepEqual(parsed.result.summary, { checked: 1, matched: 1, clear: 0 });
});

test("parse: an empty matched_fields subset is a truthful clear row", () => {
  const parsed = parse(envelopeFor([[2, []]]));
  assert.equal(parsed.ok, true);
  if (parsed.ok !== true) return;
  assert.deepEqual(parsed.result.rows[0].matched_fields, []);
  assert.deepEqual(parsed.result.summary, { checked: 1, matched: 0, clear: 1 });
});

test("parse: the documented field order is accepted and preserved", () => {
  const parsed = parse(envelopeFor([[2, ["email", "phone", "barcode"]]]));
  assert.equal(parsed.ok, true);
  if (parsed.ok !== true) return;
  assert.deepEqual(parsed.result.rows[0].matched_fields, ["email", "phone", "barcode"]);
});

test("parse: a non-object body is malformed", () => {
  for (const raw of [null, undefined, 7, "rows", [], true]) {
    assert.equal(parse(raw).ok, false);
  }
});

test("parse: an extra or missing envelope key is malformed", () => {
  assert.equal(parse({ ...(envelopeFor([[2, []]]) as object), extra: 1 }).ok, false);
  assert.equal(parse({ rows: [] }).ok, false);
  assert.equal(parse({ summary: { checked: 0, matched: 0, clear: 0 } }).ok, false);
});

test("parse: a non-array rows value is malformed", () => {
  assert.equal(parse({ rows: {}, summary: { checked: 0, matched: 0, clear: 0 } }).ok, false);
});

test("parse: a response that answers a different number of rows is malformed", () => {
  assert.equal(parse(envelopeFor([[2, []], [3, []]]), [2]).ok, false);
  assert.equal(parse(envelopeFor([[2, []]]), [2, 3]).ok, false);
});

test("parse: a reordered row is malformed", () => {
  const parsed = parse(envelopeFor([[5, []], [2, []]]), [2, 5]);
  assert.equal(parsed.ok, false);
});

test("parse: a substituted row number is malformed", () => {
  assert.equal(parse(envelopeFor([[3, []]]), [2]).ok, false);
});

test("parse: a duplicated row entry is malformed", () => {
  // Two entries for the same row can never answer two DIFFERENT submitted rows.
  assert.equal(parse(envelopeFor([[2, []], [2, []]]), [2, 3]).ok, false);
});

test("parse: an extra per-row key is malformed", () => {
  const raw = { rows: [{ row_number: 2, matched_fields: [], name: "Ali" }], summary: { checked: 1, matched: 0, clear: 1 } };
  assert.equal(parse(raw).ok, false);
});

test("parse: a missing per-row key is malformed", () => {
  assert.equal(parse({ rows: [{ row_number: 2 }], summary: { checked: 1, matched: 0, clear: 1 } }).ok, false);
  assert.equal(parse({ rows: [{ matched_fields: [] }], summary: { checked: 1, matched: 0, clear: 1 } }).ok, false);
});

test("parse: a non-array matched_fields is malformed", () => {
  assert.equal(parse({ rows: [{ row_number: 2, matched_fields: "email" }], summary: { checked: 1, matched: 1, clear: 0 } }).ok, false);
});

test("parse: an unknown matched field is malformed", () => {
  assert.equal(parse({ rows: [{ row_number: 2, matched_fields: ["name"] }], summary: { checked: 1, matched: 1, clear: 0 } }).ok, false);
  assert.equal(parse({ rows: [{ row_number: 2, matched_fields: ["EMAIL"] }], summary: { checked: 1, matched: 1, clear: 0 } }).ok, false);
});

test("parse: a duplicated matched field is malformed", () => {
  assert.equal(parse({ rows: [{ row_number: 2, matched_fields: ["email", "email"] }], summary: { checked: 1, matched: 1, clear: 0 } }).ok, false);
});

test("parse: a matched-field subset in the wrong order is malformed", () => {
  assert.equal(parse({ rows: [{ row_number: 2, matched_fields: ["phone", "email"] }], summary: { checked: 1, matched: 1, clear: 0 } }).ok, false);
  assert.equal(parse({ rows: [{ row_number: 2, matched_fields: ["barcode", "email"] }], summary: { checked: 1, matched: 1, clear: 0 } }).ok, false);
});

test("parse: a non-integer or negative summary count is malformed", () => {
  for (const summary of [
    { checked: 1.5, matched: 0, clear: 0 },
    { checked: 1, matched: -1, clear: 2 },
    { checked: 1, matched: 0, clear: 1.2 },
    { checked: "1", matched: 0, clear: 1 },
  ]) {
    assert.equal(parse({ rows: [{ row_number: 2, matched_fields: [] }], summary }).ok, false, JSON.stringify(summary));
  }
});

test("parse: a summary that does not balance is malformed", () => {
  const row = { row_number: 2, matched_fields: [] };
  assert.equal(parse({ rows: [row], summary: { checked: 2, matched: 0, clear: 2 } }).ok, false, "checked");
  assert.equal(parse({ rows: [row], summary: { checked: 1, matched: 1, clear: 0 } }).ok, false, "matched");
  assert.equal(parse({ rows: [row], summary: { checked: 1, matched: 0, clear: 5 } }).ok, false, "clear");
});

test("parse: an extra summary key is malformed", () => {
  assert.equal(parse({ rows: [{ row_number: 2, matched_fields: [] }], summary: { checked: 1, matched: 0, clear: 1, extra: 0 } }).ok, false);
});

// ---------------------------------------------------------------------------
// Controller: explicit, single-flight, fenced
// ---------------------------------------------------------------------------

test("controller: constructing it issues no request", () => {
  const { transport, calls } = recordingTransport(envelopeFor([[2, []]]));
  const controller = createServerResolutionController({ resolve: transport });
  try {
    assert.equal(controller.getState().phase, "idle");
    assert.equal(calls.length, 0, "nothing may be sent before an explicit click");
  } finally {
    controller.dispose();
  }
});

test("controller: an explicit resolve sends only the included rows", async () => {
  const { transport, calls } = recordingTransport((rows) => envelopeFor(rows.map((row) => [row.row_number, []])));
  const controller = createServerResolutionController({ resolve: transport });
  try {
    const outcome = await controller.resolve(modelOf(CSV).rows);
    assert.equal(outcome.ok, true);
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].map((row) => row.row_number), INCLUDED);
  } finally {
    controller.dispose();
  }
});

test("controller: a confirmed answer publishes the ready state", async () => {
  const { transport } = recordingTransport(envelopeFor([[5, ["email"]], [6, []]]));
  const controller = createServerResolutionController({ resolve: transport });
  try {
    await controller.resolve(includedRowsOf());
    const state = controller.getState();
    assert.equal(state.phase, "ready");
    assert.deepEqual(state.result?.summary, { checked: 2, matched: 1, clear: 1 });
    assert.equal(state.message, null);
  } finally {
    controller.dispose();
  }
});

test("controller: a second click while one request is in flight is refused as busy", async () => {
  const gate = deferred<unknown>();
  let calls = 0;
  const controller = createServerResolutionController({
    resolve: async () => { calls += 1; return gate.promise; },
  });
  try {
    const first = controller.resolve(includedRowsOf());
    await flush();
    const second = await controller.resolve(includedRowsOf());
    assert.equal(second.ok, false);
    if (second.ok !== false) return;
    assert.equal(second.reason, "busy");
    assert.equal(calls, 1, "a refused click must not start a second request");
    gate.resolve(envelopeFor([[5, []], [6, []]]));
    await first;
  } finally {
    controller.dispose();
  }
});

test("controller: a failed request is never presented as 'the rows do not exist'", async () => {
  const controller = createServerResolutionController({
    resolve: async () => { throw new Error("HTTP 500"); },
  });
  try {
    const outcome = await controller.resolve(includedRowsOf());
    assert.equal(outcome.ok, false);
    if (outcome.ok !== false) return;
    assert.equal(outcome.reason, "failed");
    const state = controller.getState();
    assert.equal(state.phase, "failed");
    assert.equal(state.result, null, "a failure must not leave a result behind");
    assert.equal(state.message, SERVER_RESOLUTION_MESSAGES.failed);
    assert.match(state.message ?? "", /لم يُستنتج/);
  } finally {
    controller.dispose();
  }
});

test("controller: a malformed 2xx is a truthful malformed state, not a partial result", async () => {
  const controller = createServerResolutionController({
    resolve: async () => ({ rows: [{ row_number: 2, matched_fields: ["name"] }], summary: { checked: 1, matched: 1, clear: 0 } }),
  });
  try {
    const outcome = await controller.resolve(includedRowsOf());
    assert.equal(outcome.ok, false);
    if (outcome.ok !== false) return;
    assert.equal(outcome.reason, "malformed");
    assert.equal(controller.getState().phase, "malformed");
    assert.equal(controller.getState().result, null);
  } finally {
    controller.dispose();
  }
});

test("controller: a retry re-sends exactly the same rows", async () => {
  const { transport, calls } = recordingTransport(envelopeFor([[5, ["phone"]], [6, []]]));
  const controller = createServerResolutionController({ resolve: transport });
  try {
    await controller.resolve(includedRowsOf());
    await controller.retry();
    assert.equal(calls.length, 2);
    assert.deepEqual(calls[0], calls[1]);
  } finally {
    controller.dispose();
  }
});

test("controller: a retry with nothing submitted is refused instead of inventing rows", async () => {
  const { transport, calls } = recordingTransport(envelopeFor([[2, []]]));
  const controller = createServerResolutionController({ resolve: transport });
  try {
    const outcome = await controller.retry();
    assert.equal(outcome.ok, false);
    if (outcome.ok !== false) return;
    assert.equal(outcome.reason, "no-included-rows");
    assert.equal(calls.length, 0);
  } finally {
    controller.dispose();
  }
});

test("controller: an empty inclusion set is refused locally without a request", async () => {
  const { transport, calls } = recordingTransport(envelopeFor([]));
  const controller = createServerResolutionController({ resolve: transport });
  try {
    const outcome = await controller.resolve([]);
    assert.equal(outcome.ok, false);
    if (outcome.ok !== false) return;
    assert.equal(outcome.reason, "no-included-rows");
    assert.equal(calls.length, 0);
  } finally {
    controller.dispose();
  }
});

test("controller: a missing transport is an honest unavailable state", async () => {
  const controller = createServerResolutionController({});
  try {
    const outcome = await controller.resolve(includedRowsOf());
    assert.equal(outcome.ok, false);
    if (outcome.ok !== false) return;
    assert.equal(outcome.reason, "unavailable");
    assert.equal(controller.getState().phase, "failed");
    assert.equal(controller.getState().result, null);
  } finally {
    controller.dispose();
  }
});

test("controller: clear drops the confirmed result", async () => {
  const { transport } = recordingTransport(envelopeFor([[5, ["email"]], [6, []]]));
  const controller = createServerResolutionController({ resolve: transport });
  try {
    await controller.resolve(includedRowsOf());
    assert.equal(controller.getState().phase, "ready");
    controller.clear();
    assert.equal(controller.getState().phase, "idle");
    assert.equal(controller.getState().result, null);
  } finally {
    controller.dispose();
  }
});

test("controller: a cleared pending reply cannot restore the dropped result", async () => {
  const gate = deferred<unknown>();
  const controller = createServerResolutionController({ resolve: async () => gate.promise });
  try {
    const pending = controller.resolve(includedRowsOf());
    await flush();
    controller.clear();
    gate.resolve(envelopeFor([[5, ["email"]], [6, []]]));
    const outcome = await pending;
    assert.equal(outcome.ok, false);
    if (outcome.ok !== false) return;
    assert.equal(outcome.reason, "superseded");
    assert.equal(controller.getState().phase, "idle", "a retired reply must not publish");
    assert.equal(controller.getState().result, null);
  } finally {
    controller.dispose();
  }
});

test("controller: a retired reply cannot release a NEWER busy latch", async () => {
  const first = deferred<unknown>();
  const second = deferred<unknown>();
  let calls = 0;
  const controller = createServerResolutionController({
    resolve: async () => { calls += 1; return calls === 1 ? first.promise : second.promise; },
  });
  try {
    const attemptA = controller.resolve(includedRowsOf());
    await flush();
    controller.clear();
    const attemptB = controller.resolve(includedRowsOf());
    await flush();
    assert.equal(calls, 2);

    // The retired reply settles LAST-ISH: it must change nothing at all.
    first.resolve(envelopeFor([[5, ["email"]], [6, []]]));
    await attemptA;
    assert.equal(controller.getState().phase, "resolving", "the newer attempt still owns the panel");

    // The decisive property: the older finally did NOT release the new latch.
    const third = await controller.resolve(includedRowsOf());
    assert.equal(third.ok, false);
    if (third.ok !== false) return;
    assert.equal(third.reason, "busy");
    assert.equal(calls, 2);

    second.resolve(envelopeFor([[5, []], [6, []]]));
    const outcomeB = await attemptB;
    assert.equal(outcomeB.ok, true);
    assert.equal(controller.getState().phase, "ready");
  } finally {
    controller.dispose();
  }
});

test("controller: a reversed completion order cannot overwrite the newer answer", async () => {
  const first = deferred<unknown>();
  const second = deferred<unknown>();
  let calls = 0;
  const controller = createServerResolutionController({
    resolve: async () => { calls += 1; return calls === 1 ? first.promise : second.promise; },
  });
  try {
    const attemptA = controller.resolve(includedRowsOf());
    await flush();
    controller.clear();
    const attemptB = controller.resolve(includedRowsOf());
    await flush();

    // B (the newer attempt) settles FIRST.
    second.resolve(envelopeFor([[5, ["phone"]], [6, []]]));
    await attemptB;
    assert.deepEqual(controller.getState().result?.rows[0].matched_fields, ["phone"]);

    // A (the retired attempt) settles LAST and must not overwrite it.
    first.resolve(envelopeFor([[5, ["email"]], [6, []]]));
    await attemptA;
    assert.deepEqual(controller.getState().result?.rows[0].matched_fields, ["phone"]);
    assert.deepEqual(controller.getState().result?.summary, { checked: 2, matched: 1, clear: 1 });
  } finally {
    controller.dispose();
  }
});

test("controller: a principal change before a click refuses the request", async () => {
  let principal = "session:a";
  const { transport, calls } = recordingTransport(envelopeFor([[2, []]]));
  const controller = createServerResolutionController({ resolve: transport, readPrincipal: () => principal });
  try {
    principal = "session:b";
    const outcome = await controller.resolve(includedRowsOf());
    assert.equal(outcome.ok, false);
    if (outcome.ok !== false) return;
    assert.equal(outcome.reason, "scope-changed");
    assert.equal(calls.length, 0, "the former scope's rows must not be submitted");
  } finally {
    controller.dispose();
  }
});

test("controller: a principal change DURING the flight drops the answer", async () => {
  let principal = "session:a";
  const gate = deferred<unknown>();
  const controller = createServerResolutionController({ resolve: async () => gate.promise, readPrincipal: () => principal });
  try {
    const pending = controller.resolve(includedRowsOf());
    await flush();
    principal = "session:b";
    gate.resolve(envelopeFor([[5, ["email"]], [6, []]]));
    const outcome = await pending;
    assert.equal(outcome.ok, false);
    if (outcome.ok !== false) return;
    assert.equal(outcome.reason, "scope-changed");
    assert.equal(controller.getState().result, null, "another scope's answer must never be shown");
  } finally {
    controller.dispose();
  }
});

test("controller: revalidateScope reports and drops a silent principal change", async () => {
  let principal = "session:a";
  const { transport } = recordingTransport(envelopeFor([[5, ["email"]], [6, []]]));
  const controller = createServerResolutionController({ resolve: transport, readPrincipal: () => principal });
  try {
    await controller.resolve(includedRowsOf());
    assert.equal(controller.revalidateScope(), false);
    principal = "session:c";
    assert.equal(controller.revalidateScope(), true);
    assert.equal(controller.getState().result, null);
  } finally {
    controller.dispose();
  }
});

test("controller: a session event drops the results and retires the reply", async () => {
  const gate = deferred<unknown>();
  const listeners: Array<() => void> = [];
  const controller = createServerResolutionController({
    resolve: async () => gate.promise,
    subscribeSession: (listener) => { listeners.push(listener); return () => {}; },
  });
  try {
    const pending = controller.resolve(includedRowsOf());
    await flush();
    for (const listener of listeners) listener();
    assert.equal(controller.getState().phase, "idle");
    gate.resolve(envelopeFor([[5, ["email"]], [6, []]]));
    const outcome = await pending;
    assert.equal(outcome.ok, false);
    assert.equal(controller.getState().result, null);
  } finally {
    controller.dispose();
  }
});

test("controller: dispose drops everything and publishes nothing afterwards", async () => {
  const gate = deferred<unknown>();
  const controller = createServerResolutionController({ resolve: async () => gate.promise });
  const seen: string[] = [];
  const unsubscribe = controller.subscribe((state) => seen.push(state.phase));
  const pending = controller.resolve(includedRowsOf());
  await flush();
  controller.dispose();
  unsubscribe();
  gate.resolve(envelopeFor([[5, ["email"]], [6, []]]));
  await pending;
  assert.equal(controller.getState().phase, "idle");
  assert.equal(controller.getState().result, null);
  assert.equal(seen[seen.length - 1], "resolving", "a disposed controller must not publish again");
});

test("controller: a disposed controller refuses a new attempt", async () => {
  const { transport, calls } = recordingTransport(envelopeFor([[2, []]]));
  const controller = createServerResolutionController({ resolve: transport });
  controller.dispose();
  const outcome = await controller.resolve(includedRowsOf());
  assert.equal(outcome.ok, false);
  assert.equal(calls.length, 0);
});

test("controller: no storage write and no console call happens during a full reconciliation", async () => {
  const storageWrites: string[] = [];
  const consoleCalls: string[] = [];
  const previousLocal = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  const previousSession = Object.getOwnPropertyDescriptor(globalThis, "sessionStorage");
  const previousLog = console.log;
  const previousError = console.error;
  const previousWarn = console.warn;
  const spyStorage = new Proxy({} as Record<string, unknown>, {
    set(_target, key) { storageWrites.push(String(key)); return true; },
    get() { storageWrites.push("read"); return undefined; },
    has() { storageWrites.push("has"); return false; },
  });
  try {
    Object.defineProperty(globalThis, "localStorage", { value: spyStorage, configurable: true, writable: true });
    Object.defineProperty(globalThis, "sessionStorage", { value: spyStorage, configurable: true, writable: true });
    console.log = (...args: unknown[]) => { consoleCalls.push(String(args[0])); };
    console.error = (...args: unknown[]) => { consoleCalls.push(String(args[0])); };
    console.warn = (...args: unknown[]) => { consoleCalls.push(String(args[0])); };

    const { transport } = recordingTransport(envelopeFor([[5, ["email"]], [6, []]]));
    const controller = createServerResolutionController({ resolve: transport, readPrincipal: () => "session:a" });
    await controller.resolve(includedRowsOf());
    controller.clear();
    controller.dispose();
    assert.deepEqual(storageWrites, [], "the private reconciliation must never be persisted");
    assert.deepEqual(consoleCalls, [], "the private reconciliation must never be logged");
  } finally {
    console.log = previousLog;
    console.error = previousError;
    console.warn = previousWarn;
    if (previousLocal) Object.defineProperty(globalThis, "localStorage", previousLocal);
    else delete (globalThis as { localStorage?: unknown }).localStorage;
    if (previousSession) Object.defineProperty(globalThis, "sessionStorage", previousSession);
    else delete (globalThis as { sessionStorage?: unknown }).sessionStorage;
  }
});

test("controller: the transport receives only the four documented keys per row", async () => {
  const { transport, calls } = recordingTransport(envelopeFor([[5, ["email"]], [6, []]]));
  const controller = createServerResolutionController({ resolve: transport });
  try {
    await controller.resolve(modelOf(CSV).rows);
    for (const row of calls[0]) {
      assert.deepEqual(Object.keys(row).sort(), ["barcode", "email", "phone", "row_number"]);
    }
  } finally {
    controller.dispose();
  }
});

test("controller: the documented subset order is email, phone, barcode", () => {
  assert.deepEqual([...SERVER_RESOLUTION_FIELDS], ["email", "phone", "barcode"]);
});

test("controller: the match vocabulary is the same SET as the accepted duplicate columns", () => {
  // Same set, DIFFERENT documented order: the accepted parser lists phone first.
  assert.equal(SERVER_RESOLUTION_VOCABULARY_MATCHES_CSV, true);
  assert.deepEqual([...SERVER_RESOLUTION_FIELDS].sort(), ["barcode", "email", "phone"]);
  assert.deepEqual([...STUDENT_CSV_DUPLICATE_COLUMNS], ["phone", "email", "barcode"]);
});

// ---------------------------------------------------------------------------
// The real component
// ---------------------------------------------------------------------------

interface RenderedControl {
  readonly text: string;
  readonly disabled: unknown;
  readonly type: unknown;
  readonly onClick: () => void;
}

const treeText = (node: unknown): string => {
  if (typeof node === "string") return node;
  if (typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(treeText).join("");
  const element = node as { props?: { children?: unknown } } | null;
  if (element?.props) return treeText(element.props.children);
  return "";
};

const collectControls = (node: unknown, found: RenderedControl[] = []): RenderedControl[] => {
  if (Array.isArray(node)) {
    node.forEach((child) => { collectControls(child, found); });
    return found;
  }
  const element = node as { props?: Record<string, unknown> } | null;
  if (!element?.props) return found;
  if (typeof element.props.onClick === "function") {
    found.push({
      text: treeText(node),
      disabled: element.props.disabled,
      type: element.props.type,
      onClick: element.props.onClick as () => void,
    });
  }
  collectControls(element.props.children, found);
  return found;
};

const collectSubmitTypes = (node: unknown, found: unknown[] = []): unknown[] => {
  if (Array.isArray(node)) {
    node.forEach((child) => { collectSubmitTypes(child, found); });
    return found;
  }
  const element = node as { props?: Record<string, unknown> } | null;
  if (!element?.props) return found;
  if (element.props.type === "submit") found.push(element.props.type);
  collectSubmitTypes(element.props.children, found);
  return found;
};

const previewStateFrom = async (csv: string, fileName = "students.csv"): Promise<StudentCsvPreviewState> => {
  const controller = createStudentCsvPreviewController({
    readFile: async () => csv,
    readPrincipal: () => "session:a",
    subscribeSession: () => () => {},
  });
  try {
    await controller.selectFile({ name: fileName, size: csv.length });
    return controller.getState();
  } finally {
    controller.dispose();
  }
};

/**
 * Renders the REAL `StudentImportPreview` with the REAL React server renderer.
 *
 * The four injected states are served in the component's source order (preview,
 * resolution, report message, server reconciliation) and the six refs in theirs
 * (preview controller, file input, resolution controller, report controller,
 * server controller, selection token). `useEffect` is a no-op, so the component
 * never builds its own controllers and the injected seams are exactly the ones
 * under test.
 */
const renderPanel = async (
  preview: StudentCsvPreviewState,
  resolution: ImportResolutionState | null,
  resolutionController: unknown,
  reportController: unknown,
  serverController: unknown,
  serverState: unknown,
): Promise<{ html: string; controls: RenderedControl[]; submits: unknown[] }> => {
  const projectRequire = Module.createRequire(import.meta.url);
  const React = projectRequire("react");
  const { renderToStaticMarkup } = projectRequire("react-dom/server");
  const componentPath = projectRequire.resolve("../features/students/StudentImportPreview.tsx");
  const moduleInternals = Module as unknown as { _load: (...args: unknown[]) => unknown };
  const original = moduleInternals._load;
  const previousReact = (globalThis as { React?: unknown }).React;
  try {
    moduleInternals._load = function (
      specifier: string,
      parent: { filename?: string } | undefined,
      isMain: boolean,
    ) {
      if (specifier === "react" && /StudentImportPreview\.tsx$/.test(parent?.filename || "")) {
        let stateCall = 0;
        let refCall = 0;
        return {
          ...React,
          useState: () => {
            stateCall += 1;
            if (stateCall === 1) return [preview, () => {}];
            if (stateCall === 2) return [resolution, () => {}];
            if (stateCall === 3) return [null, () => {}];
            return [serverState, () => {}];
          },
          useRef: () => {
            refCall += 1;
            if (refCall === 1) return { current: null };
            if (refCall === 2) return { current: null };
            if (refCall === 3) return { current: resolutionController };
            if (refCall === 4) return { current: reportController };
            if (refCall === 5) return { current: serverController };
            return { current: 0 };
          },
          useEffect: () => {},
        };
      }
      if (specifier.startsWith("@/")) {
        return original.call(this, path.resolve(SRC_ROOT, specifier.slice(2)), parent, isMain);
      }
      return original.apply(this, arguments as unknown as unknown[]);
    } as never;
    delete projectRequire.cache[componentPath];
    const Component = projectRequire(componentPath).default as (...args: unknown[]) => unknown;
    (globalThis as { React?: unknown }).React = React;
    const tree = Component();
    return {
      html: renderToStaticMarkup(tree as never),
      controls: collectControls(tree),
      submits: collectSubmitTypes(tree),
    };
  } finally {
    moduleInternals._load = original;
    if (previousReact === undefined) delete (globalThis as { React?: unknown }).React;
    else (globalThis as { React?: unknown }).React = previousReact;
  }
};

const PANEL_CSV =
  "name,phone,email\nAli,0100,a@b.c\nSara,0100,d@e.f\n,0300,o@b.c\nOmar,0400,q@r.s\nHana,0500,h@i.j\n";

/** The decision seam the panel dispatches into: it only has to answer with a model. */
const resolutionSeamFor = (model: ImportResolutionState) => ({
  clear: () => {},
  include: () => ({ ok: true, state: model }),
  exclude: () => ({ ok: true, state: model }),
  reset: () => {},
  getState: () => model,
  subscribe: () => () => {},
});

test("component: the reconciliation control renders with a live seam", async () => {
  const preview = await previewStateFrom(PANEL_CSV);
  const model = loadImportResolution(parsedRows(PANEL_CSV));
  const resolutionController = {
    clear: () => {}, include: () => ({}), exclude: () => ({}), reset: () => {},
    getState: () => model, subscribe: () => () => {},
  };
  const serverController = createServerResolutionController({ resolve: async () => envelopeFor([]) });
  try {
    const { html, controls } = await renderPanel(
      preview, model, resolutionController, null, serverController, serverController.getState(),
    );
    assert.match(html, /مطابقة الصفوف المُدرجة مع السجلات الموجودة/);
    const control = controls.find((entry) => entry.text.includes("مطابقة الصفوف المُدرجة"));
    assert.ok(control, "the reconcile control must exist");
    assert.equal(control!.disabled, false, "an included row exists, so the control is usable");
    assert.equal(control!.type, "button", "a reconciliation click must never submit a form");
  } finally {
    serverController.dispose();
  }
});

test("component: the reconciliation notice states read-only, no import and no access", async () => {
  const preview = await previewStateFrom(PANEL_CSV);
  const model = loadImportResolution(parsedRows(PANEL_CSV));
  const resolutionController = {
    clear: () => {}, include: () => ({}), exclude: () => ({}), reset: () => {},
    getState: () => model, subscribe: () => () => {},
  };
  const serverController = createServerResolutionController({ resolve: async () => envelopeFor([]) });
  try {
    const { html } = await renderPanel(
      preview, model, resolutionController, null, serverController, serverController.getState(),
    );
    assert.match(html, /قراءة فقط/);
    assert.match(html, /لا يُنشأ طالب ولا يُعدّل سجل ولا يُمنح وصول/);
    assert.match(html, /ليست إثبات\s*هوية ولا نجاح استيراد ولا موافقة على الاستبدال/);
    // The old, now-false claim that nothing is ever sent must be gone.
    assert.equal(/لا يُرسل أي شيء إلى الخادم/.test(html), false);
  } finally {
    serverController.dispose();
  }
});

test("component: the reconciliation control is disabled when nothing is included", async () => {
  const csv = "name,phone\nAli,0100\n,0200\n";
  const preview = await previewStateFrom(csv);
  // Exclude every includable row THROUGH the accepted model, so the counts are
  // the real ones and not a hand-written guess.
  let model = loadImportResolution(parsedRows(csv));
  for (const row of [...model.rows]) {
    if (row.status === "included") model = applyImportDecision(model, row.rowNumber, "exclude").state;
  }
  assert.equal(model.counts.included, 0);
  const resolutionController = resolutionSeamFor(model);
  const serverController = createServerResolutionController({ resolve: async () => envelopeFor([]) });
  try {
    const { controls } = await renderPanel(
      preview, model, resolutionController, null, serverController, serverController.getState(),
    );
    const control = controls.find((entry) => entry.text.includes("مطابقة الصفوف المُدرجة"));
    assert.ok(control);
    assert.equal(control!.disabled, true, "there is nothing to reconcile");
  } finally {
    serverController.dispose();
  }
});

test("component: clicking the control submits only the included rows through the real controller", async () => {
  const preview = await previewStateFrom(PANEL_CSV);
  const model = loadImportResolution(parsedRows(PANEL_CSV));
  const resolutionController = {
    clear: () => {}, include: () => ({}), exclude: () => ({}), reset: () => {},
    getState: () => model, subscribe: () => () => {},
  };
  const { transport, calls } = recordingTransport((rows) =>
    envelopeFor(rows.map((row) => [row.row_number, []])),
  );
  const serverController = createServerResolutionController({ resolve: transport });
  try {
    const { controls } = await renderPanel(
      preview, model, resolutionController, null, serverController, serverController.getState(),
    );
    const control = controls.find((entry) => entry.text.includes("مطابقة الصفوف المُدرجة"));
    assert.ok(control);
    control!.onClick();
    await flush();
    await flush();
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].map((row) => row.row_number), INCLUDED);
    assert.deepEqual(Object.keys(calls[0][0]).sort(), ["barcode", "email", "phone", "row_number"]);
  } finally {
    serverController.dispose();
  }
});

test("component: the confirmed counts and the per-row warning render", async () => {
  const preview = await previewStateFrom(PANEL_CSV);
  const model = loadImportResolution(parsedRows(PANEL_CSV));
  const resolutionController = {
    clear: () => {}, include: () => ({}), exclude: () => ({}), reset: () => {},
    getState: () => model, subscribe: () => () => {},
  };
  const serverController = createServerResolutionController({
    resolve: async () => envelopeFor([[5, ["email", "phone"]], [6, []]]),
  });
  try {
    await serverController.resolve(model.rows);
    // M2-15: the per-row warning is driven by the REVIEW seeded from the
    // confirmed result, which the component's own effect does on a real mount.
    const seeded = seedServerMatches(model, serverController.getState().result!);
    const seededController = { ...resolutionController, getState: () => seeded };
    const { html } = await renderPanel(
      preview, seeded, seededController, null, serverController, serverController.getState(),
    );
    assert.match(html, /تم الفحص: 2/);
    assert.match(html, /موجود مسبقًا: 1/);
    assert.match(html, /غير موجود: 1/);
    assert.match(html, /موجود مسبقًا في مؤسستك/);
    assert.match(html, /البريد الإلكتروني، الهاتف/);
    assert.match(html, /تنبيه فقط، وليس إثبات هوية ولا استيرادًا/);
    assert.match(html, /أعداد فقط — لم يُستورد أي طالب ولم يُمنح أي وصول/);
  } finally {
    serverController.dispose();
  }
});

test("component: a failed reconciliation shows an honest message and an explicit retry", async () => {
  const preview = await previewStateFrom(PANEL_CSV);
  const model = loadImportResolution(parsedRows(PANEL_CSV));
  const resolutionController = {
    clear: () => {}, include: () => ({}), exclude: () => ({}), reset: () => {},
    getState: () => model, subscribe: () => () => {},
  };
  let calls = 0;
  const serverController = createServerResolutionController({
    resolve: async () => { calls += 1; throw new Error("HTTP 500"); },
  });
  try {
    await serverController.resolve(model.rows);
    assert.equal(serverController.getState().phase, "failed");
    const { html, controls } = await renderPanel(
      preview, model, resolutionController, null, serverController, serverController.getState(),
    );
    assert.match(html, /لم يُستنتج أن الصفوف غير موجودة/);
    const retry = controls.find((entry) => entry.text.includes("إعادة المحاولة"));
    assert.ok(retry, "a failure must offer an explicit retry");
    assert.equal(retry!.type, "button");
    retry!.onClick();
    await flush();
    await flush();
    assert.equal(calls, 2, "the retry must actually re-send");
  } finally {
    serverController.dispose();
  }
});

test("component: the close control stays enabled while a reconciliation is in flight", async () => {
  const preview = await previewStateFrom(PANEL_CSV);
  const model = loadImportResolution(parsedRows(PANEL_CSV));
  const resolutionController = {
    clear: () => {}, include: () => ({}), exclude: () => ({}), reset: () => {},
    getState: () => model, subscribe: () => () => {},
  };
  const gate = deferred<unknown>();
  const serverController = createServerResolutionController({ resolve: async () => gate.promise });
  try {
    const pending = serverController.resolve(model.rows);
    await flush();
    assert.equal(serverController.getState().phase, "resolving");
    const { controls } = await renderPanel(
      preview, model, resolutionController, null, serverController, serverController.getState(),
    );
    const close = controls.find((entry) => entry.text.includes("إغلاق المعاينة"));
    assert.ok(close);
    assert.equal(close!.disabled, undefined, "the user can always close a pending reconciliation");
    // The reconcile control itself is latched while one request is in flight.
    const reconcileControl = controls.find((entry) => entry.text.includes("مطابقة الصفوف المُدرجة"));
    assert.equal(reconcileControl!.disabled, true);
    gate.resolve(envelopeFor([[5, []], [6, []]]));
    await pending;
  } finally {
    serverController.dispose();
  }
});

test("component: every reconciliation control is a non-submit control", async () => {
  const preview = await previewStateFrom(PANEL_CSV);
  const model = loadImportResolution(parsedRows(PANEL_CSV));
  const resolutionController = {
    clear: () => {}, include: () => ({}), exclude: () => ({}), reset: () => {},
    getState: () => model, subscribe: () => () => {},
  };
  const serverController = createServerResolutionController({ resolve: async () => envelopeFor([]) });
  try {
    const { controls, submits } = await renderPanel(
      preview, model, resolutionController, null, serverController, serverController.getState(),
    );
    for (const control of controls) {
      if (control.text.includes("مطابقة") || control.text.includes("إعادة المحاولة")) {
        assert.equal(control.type, "button");
      }
    }
    assert.deepEqual(submits, [], "the panel must not gain a submit control");
  } finally {
    serverController.dispose();
  }
});

test("component: the reconciliation layer is absent without a live seam", async () => {
  const preview = await previewStateFrom(PANEL_CSV);
  const model = loadImportResolution(parsedRows(PANEL_CSV));
  const resolutionController = {
    clear: () => {}, include: () => ({}), exclude: () => ({}), reset: () => {},
    getState: () => model, subscribe: () => () => {},
  };
  const { html } = await renderPanel(preview, model, resolutionController, null, null, null);
  assert.equal(/مطابقة الصفوف المُدرجة مع السجلات الموجودة/.test(html), false);
  // The accepted decision layer is untouched.
  assert.match(html, /إعادة ضبط القرارات/);
  assert.match(html, /تنزيل تقرير الصفوف غير المُدرجة/);
});

// ---------------------------------------------------------------------------
// M2-15 — the confirmed answer is the ONLY seed of the explicit review
// ---------------------------------------------------------------------------

test("review: a confirmed answer seeds only the matched INCLUDED rows", async () => {
  const controller = createImportResolutionController({});
  const server = createServerResolutionController({
    resolve: async () => envelopeFor([[5, ["email", "barcode"]], [6, []]]),
  });
  try {
    controller.load(parsedRows(CSV));
    const outcome = await server.resolve(controller.getState().rows);
    assert.equal(outcome.ok, true);
    const result = server.getState().result;
    assert.ok(result);

    controller.seedServerMatches(result!);
    const state = controller.getState();
    assert.equal(state.serverMatches.size, 1, "a clear row is not a review item");
    assert.deepEqual(state.serverMatches.get(5)?.matched_fields, ["email", "barcode"]);
    assert.equal(currentServerMatchReview(state, 6), null);
    assert.equal(state.rows.find((row) => row.rowNumber === 5)?.status, "included");
  } finally {
    server.dispose();
    controller.dispose();
  }
});

test("review: a malformed answer seeds nothing and keeps no stale set", async () => {
  const controller = createImportResolutionController({});
  let answer: unknown = envelopeFor([[5, ["email"]], [6, []]]);
  const server = createServerResolutionController({ resolve: async () => answer });
  try {
    controller.load(parsedRows(CSV));
    await server.resolve(controller.getState().rows);
    controller.seedServerMatches(server.getState().result!);
    assert.equal(controller.getState().serverMatches.size, 1);

    // A malformed 2xx is never a partial result, so there is nothing to seed.
    answer = { rows: [{ row_number: 5, matched_fields: ["email"] }], summary: { checked: 1, matched: 1, clear: 0 } };
    const outcome = await server.resolve(controller.getState().rows);
    assert.equal(outcome.ok, false);
    assert.equal(outcome.reason, "malformed");
    assert.equal(server.getState().result, null, "a malformed answer holds no result");

    // The caller retires the review with the discarded answer.
    const retired = clearServerMatches(controller.getState());
    assert.equal(retired.serverMatches.size, 0);
    assert.equal(currentServerMatchReview(retired, 5), null);
  } finally {
    server.dispose();
    controller.dispose();
  }
});

test("review: a failed request holds no result, so no review can be seeded from it", async () => {
  const controller = createImportResolutionController({});
  let fail = false;
  const server = createServerResolutionController({
    resolve: async () => {
      if (fail) throw new Error("network down");
      return envelopeFor([[5, ["email"]], [6, []]]);
    },
  });
  try {
    controller.load(parsedRows(CSV));
    await server.resolve(controller.getState().rows);
    controller.seedServerMatches(server.getState().result!);
    assert.equal(controller.getState().serverMatches.size, 1);

    fail = true;
    const outcome = await server.resolve(controller.getState().rows);
    assert.equal(outcome.ok, false);
    assert.equal(outcome.reason, "failed");
    assert.equal(server.getState().result, null, "a failure is never an empty answer");
    assert.equal(server.getState().phase, "failed");

    const retired = clearServerMatches(controller.getState());
    assert.equal(retired.serverMatches.size, 0);
  } finally {
    server.dispose();
    controller.dispose();
  }
});

test("review: a retry re-seeds only the NEW confirmed answer", async () => {
  const controller = createImportResolutionController({});
  let answer: unknown = envelopeFor([[5, ["email"]], [6, []]]);
  const server = createServerResolutionController({ resolve: async () => answer });
  try {
    controller.load(parsedRows(CSV));
    await server.resolve(controller.getState().rows);
    controller.seedServerMatches(server.getState().result!);
    controller.keepServerMatch(5);

    // A new confirmed answer names a DIFFERENT row of the same submitted set.
    answer = envelopeFor([[5, []], [6, ["phone"]]]);
    await server.retry();
    const result = server.getState().result;
    assert.ok(result);
    controller.seedServerMatches(result!);

    const state = controller.getState();
    assert.equal(state.serverMatches.size, 1, "the old entry is replaced atomically");
    assert.equal(currentServerMatchReview(state, 5), null);
    assert.deepEqual(state.serverMatches.get(6)?.matched_fields, ["phone"]);
    assert.equal(state.serverMatches.get(6)?.review, "pending", "a new answer starts undecided");
  } finally {
    server.dispose();
    controller.dispose();
  }
});

test("review: a reversed completion order cannot seed a stale answer", async () => {
  const controller = createImportResolutionController({});
  const first = deferred<unknown>();
  const second = deferred<unknown>();
  const answers = [first.promise, second.promise];
  let call = 0;
  const server = createServerResolutionController({
    resolve: async () => answers[call++]!,
  });
  try {
    controller.load(parsedRows(CSV));
    const attemptOne = server.resolve(controller.getState().rows);
    // A second click while the first is in flight is refused, so the newer
    // attempt starts only after the first is retired.
    assert.equal((await server.resolve(controller.getState().rows)).ok, false);
    server.clear();
    const attemptTwo = server.resolve(controller.getState().rows);

    // The RETIRED answer settles LAST: it must change nothing.
    second.resolve(envelopeFor([[5, ["phone"]], [6, []]]));
    const two = await attemptTwo;
    assert.equal(two.ok, true);
    first.resolve(envelopeFor([[5, ["email"]], [6, []]]));
    assert.equal((await attemptOne).ok, false);

    const result = server.getState().result;
    assert.ok(result);
    controller.seedServerMatches(result!);
    assert.deepEqual(
      controller.getState().serverMatches.get(5)?.matched_fields,
      ["phone"],
      "only the CURRENT answer may seed the review",
    );
  } finally {
    server.dispose();
    controller.dispose();
  }
});

test("review: a session event leaves no review behind in either seam", () => {
  // The SAME notifier is shared by both seams, exactly like the real panel.
  const listeners = new Set<() => void>();
  const subscribeSession = (listener: () => void) => {
    listeners.add(listener);
    return () => { listeners.delete(listener); };
  };
  const notify = () => {
    for (const listener of [...listeners]) listener();
  };
  const controller = createImportResolutionController({ readPrincipal: () => "session:a", subscribeSession });
  const server = createServerResolutionController({ readPrincipal: () => "session:a", subscribeSession });
  try {
    controller.load(parsedRows(CSV));
    controller.seedServerMatches({
      rows: [
        { row_number: 5, matched_fields: ["email"] },
        { row_number: 6, matched_fields: [] },
      ],
      summary: { checked: 2, matched: 1, clear: 1 },
    });
    // A snapshot taken while the review exists, to prove it is a value.
    const state = controller.getState();
    assert.equal(controller.getState().serverMatches.size, 1);
    assert.equal(server.getState().phase, "idle");
    assert.equal(listeners.size, 2, "both seams observe the same session");

    notify();
    assert.equal(controller.getState().serverMatches.size, 0, "the review dies with the scope");
    assert.equal(controller.getState().loaded, false);
    assert.equal(server.getState().result, null);
    assert.equal(state.serverMatches.size, 1, "the earlier snapshot is a value, not a view");
  } finally {
    server.dispose();
    controller.dispose();
  }
});

test("review: the combined report is built from the CONFIRMED field names", async () => {
  const controller = createImportResolutionController({});
  const server = createServerResolutionController({
    resolve: async () => envelopeFor([[5, ["email", "phone"]], [6, []]]),
  });
  try {
    controller.load(parsedRows(CSV));
    await server.resolve(controller.getState().rows);
    controller.seedServerMatches(server.getState().result!);
    controller.excludeServerMatch(5);

    const built = buildImportReport(controller.getState());
    assert.ok("text" in built);
    const payload = JSON.parse((built as { text: string }).text);
    const row = payload.rows.find((entry: { rowNumber: number }) => entry.rowNumber === 5);
    assert.deepEqual(row.reasons, ["excluded-by-user", "existing-value-match"]);
    assert.deepEqual(row.matched_fields, ["email", "phone"]);
    // The clear row 6 is still included and is therefore absent from the report.
    assert.equal(
      payload.rows.some((entry: { rowNumber: number }) => entry.rowNumber === 6),
      false,
    );
  } finally {
    server.dispose();
    controller.dispose();
  }
});

test("review: keep and undo never send a request", async () => {
  const controller = createImportResolutionController({});
  const { transport, calls } = recordingTransport(envelopeFor([[5, ["email"]], [6, []]]));
  const server = createServerResolutionController({ resolve: transport });
  try {
    controller.load(parsedRows(CSV));
    await server.resolve(controller.getState().rows);
    assert.equal(calls.length, 1);
    controller.seedServerMatches(server.getState().result!);

    keepServerMatch(controller.getState(), 5);
    undoServerMatch(controller.getState(), 5);
    excludeServerMatch(controller.getState(), 5);
    undoServerMatch(controller.getState(), 5);

    assert.equal(calls.length, 1, "a review action is local and never a request");
  } finally {
    server.dispose();
    controller.dispose();
  }
});
