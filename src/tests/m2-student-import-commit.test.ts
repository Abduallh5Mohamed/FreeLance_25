/**
 * M2-16 — the client half of the audited idempotent student-row import:
 * isolated production-path tests (node:test + tsx).
 *
 * Scope: the REAL accepted parser and decision model
 * (`src/features/students/csv-preview.ts`, `import-resolution.ts`), the REAL
 * M2-16 client module (`src/features/students/import-commit.ts`) and the REAL
 * `StudentImportPreview` component with its ACTUAL control callbacks — all
 * imported unchanged. Fully isolated: no DB, no network, no browser, no
 * storage, no dependency install.
 *
 * Behaviours pinned:
 *  - a batch is confirmable ONLY when the current decisions have no pending and
 *    no invalid row AND a fresh reconciliation answered exactly the current
 *    included set with zero matches; every refusal names its reason and rows;
 *  - one explicit confirmation mints ONE opaque key for ONE canonical batch;
 *    a retry of an UNCERTAIN outcome reuses the SAME key and the SAME payload,
 *    while a changed payload can never inherit that key;
 *  - exactly one submission is in flight; a second click is refused as `busy`;
 *  - a file/decision/reconciliation/principal/session/reset/close/dispose change
 *    clears the result and retires a pending reply, and a retired reply cannot
 *    publish, cannot restore a private result and cannot release a NEWER latch,
 *    so a reversed success/error order is harmless;
 *  - only a 2xx that matches the documented DTO becomes `committed`; a 4xx is a
 *    definite refusal, a 5xx or a transport rejection is an uncertain failure
 *    that keeps the attempt open for a same-key retry;
 *  - nothing is persisted, nothing is logged and nothing is sent automatically;
 *  - the component renders the import only with a live seam, states on screen
 *    that this creates tenant student records only, and preserves the accepted
 *    preview, decision, report, reconciliation and review controls.
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
  parseStudentCsv,
  type StudentCsvPreviewState,
  type StudentCsvRow,
} from "../features/students/csv-preview";
import {
  applyImportDecision,
  loadImportResolution,
  type ImportResolutionRow,
  type ImportResolutionState,
} from "../features/students/import-resolution";
import {
  createServerResolutionController,
  type ServerResolutionController,
  type ServerResolutionState,
  type ServerResolutionResult,
} from "../features/students/server-resolution";
import {
  IMPORT_COMMIT_KEY_MAX_CHARS,
  IMPORT_COMMIT_KEY_MIN_CHARS,
  IMPORT_COMMIT_KEY_PATTERN,
  IMPORT_COMMIT_MAX_ROWS,
  IMPORT_COMMIT_MAX_ROW_NUMBER,
  IMPORT_COMMIT_MIN_ROW_NUMBER,
  IMPORT_COMMIT_MESSAGES,
  IMPORT_COMMIT_ROW_KEYS,
  IMPORT_COMMIT_VALUE_BOUNDS,
  buildImportCommitRequest,
  canonicalImportCommitPayload,
  createImportCommitController,
  evaluateImportCommitGate,
  initialImportCommitState,
  parseImportCommitResponse,
  type ImportCommitRequest,
  type ImportCommitResult,
  type ImportCommitState,
  type ImportCommitTransport,
} from "../features/students/import-commit";

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
 * A clean two-row fixture: both records are INCLUDED, so the decision model is
 * fully decided and the only remaining gate is the reconciliation.
 */
const CLEAN_CSV = "name,phone,email\nAli,0100,a@b.c\nSara,0200,d@e.f\n";
const CLEAN_ROWS = [2, 3];

/** The same clean fixture, but with a row the model must decide first. */
const PENDING_CSV = "name,phone,email\nAli,0100,a@b.c\nSara,0100,d@e.f\n";

const includedRowsOf = (csv: string = CLEAN_CSV): ImportResolutionRow[] =>
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

/** A fresh, all-clear reconciliation answer for exactly the given row numbers. */
const clearResultFor = (rowNumbers: readonly number[]): ServerResolutionResult => ({
  rows: rowNumbers.map((row_number) => ({ row_number, matched_fields: [] })),
  summary: { checked: rowNumbers.length, matched: 0, clear: rowNumbers.length },
});

interface Deferred<T> { promise: Promise<T>; resolve: (value: T) => void; reject: (error: unknown) => void }

const deferred = <T,>(): Deferred<T> => {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
};

/** The documented successful answer for the given row numbers. */
const commitEnvelopeFor = (rowNumbers: readonly number[], replayed = false): unknown => ({
  batch_id: "9d4b1f2c-6a3e-4c8d-9e5f-1a2b3c4d5e6f",
  replayed,
  created: rowNumbers.length,
  row_numbers: [...rowNumbers],
});

interface RecordedCall { readonly request: ImportCommitRequest; readonly key: string }

/**
 * A transport that records every submitted request.
 *
 * A static answer is served as a 2xx body; a FUNCTION answer receives the
 * request and the 1-based attempt number and returns the COMPLETE transport
 * response, so a test can express a failure, a conflict or a replay directly.
 */
const recordingTransport = (
  answer:
    | unknown
    | ((request: ImportCommitRequest, attempt: number) => { status: number; body: unknown }) =
    commitEnvelopeFor(CLEAN_ROWS),
) => {
  const calls: RecordedCall[] = [];
  const transport: ImportCommitTransport = async (request) => {
    const attempt = calls.length + 1;
    calls.push({ request, key: request.idempotency_key });
    if (typeof answer === "function") return answer(request, attempt);
    return { status: 200, body: answer };
  };
  return { transport, calls };
};

/** A key source that yields predictable, in-shape keys, one per call. */
const sequentialKeys = (prefix = "k") => {
  let counter = 0;
  const keys: string[] = [];
  return {
    keys,
    createKey: () => {
      counter += 1;
      const key = `${prefix}${String(counter).padStart(30, "0")}`;
      keys.push(key);
      return key;
    },
  };
};

// ---------------------------------------------------------------------------
// The confirmation gate
// ---------------------------------------------------------------------------

test("gate: a fully decided file with a fresh all-clear reconciliation is confirmable", () => {
  const gate = evaluateImportCommitGate(modelOf(CLEAN_CSV).rows, clearResultFor(CLEAN_ROWS));
  assert.equal(gate.ok, true);
  if (gate.ok !== true) return;
  assert.deepEqual(gate.rows.map((row) => row.row_number), CLEAN_ROWS);
});

test("gate: the confirmable rows carry exactly the seven documented keys in order", () => {
  const gate = evaluateImportCommitGate(modelOf(CLEAN_CSV).rows, clearResultFor(CLEAN_ROWS));
  assert.equal(gate.ok, true);
  if (gate.ok !== true) return;
  for (const row of gate.rows) {
    assert.deepEqual(Object.keys(row), [...IMPORT_COMMIT_ROW_KEYS]);
  }
});

test("gate: no reconciliation at all is a refusal, never an implicit all-clear", () => {
  const gate = evaluateImportCommitGate(modelOf(CLEAN_CSV).rows, null);
  assert.equal(gate.ok, false);
  if (gate.ok !== false) return;
  assert.equal(gate.reason, "not-reconciled");
  assert.deepEqual(gate.rowNumbers, []);
});

test("gate: an invalid row refuses the whole batch and names the row", () => {
  const model = modelOf(PENDING_CSV);
  const rows = model.rows.map((row) =>
    row.rowNumber === 2 ? { ...row, status: "invalid" as const } : row,
  );
  const gate = evaluateImportCommitGate(rows, clearResultFor([2, 3]));
  assert.equal(gate.ok, false);
  if (gate.ok !== false) return;
  assert.equal(gate.reason, "invalid-rows");
  assert.deepEqual(gate.rowNumbers, [2]);
});

test("gate: a pending row refuses the whole batch and names the row", () => {
  const gate = evaluateImportCommitGate(modelOf(PENDING_CSV).rows, clearResultFor([2, 3]));
  assert.equal(gate.ok, false);
  if (gate.ok !== false) return;
  assert.equal(gate.reason, "pending-rows");
  assert.deepEqual(gate.rowNumbers, [2, 3]);
});

test("gate: an empty inclusion set is refused with no-rows", () => {
  const model = modelOf(CLEAN_CSV);
  const rows = model.rows.map((row) => ({ ...row, status: "excluded" as const }));
  const gate = evaluateImportCommitGate(rows, null);
  assert.equal(gate.ok, false);
  if (gate.ok !== false) return;
  assert.equal(gate.reason, "no-rows");
});

test("gate: an over-bound inclusion set is refused with too-many-rows", () => {
  const rows = Array.from({ length: IMPORT_COMMIT_MAX_ROWS + 1 }, (_, index) =>
    syntheticRow({ rowNumber: index + 2, rowIndex: index + 1 }),
  );
  const gate = evaluateImportCommitGate(rows, clearResultFor([2]));
  assert.equal(gate.ok, false);
  if (gate.ok !== false) return;
  assert.equal(gate.reason, "too-many-rows");
});

test("gate: a row identity outside the physical range is refused, never coerced", () => {
  for (const rowNumber of [IMPORT_COMMIT_MIN_ROW_NUMBER - 1, IMPORT_COMMIT_MAX_ROW_NUMBER + 1]) {
    const gate = evaluateImportCommitGate([syntheticRow({ rowNumber })], clearResultFor([rowNumber]));
    assert.equal(gate.ok, false, `row ${rowNumber} must be refused`);
    if (gate.ok !== false) return;
    assert.equal(gate.reason, "out-of-range");
    assert.deepEqual(gate.rowNumbers, [rowNumber]);
  }
});

test("gate: a blank name is refused with missing-name", () => {
  const gate = evaluateImportCommitGate(
    [syntheticRow({ name: "   " })],
    clearResultFor([2]),
  );
  assert.equal(gate.ok, false);
  if (gate.ok !== false) return;
  assert.equal(gate.reason, "missing-name");
  assert.deepEqual(gate.rowNumbers, [2]);
});

test("gate: every documented value bound is enforced locally", () => {
  const overflows: Array<[Partial<ImportResolutionRow>, string]> = [
    [{ name: "n".repeat(IMPORT_COMMIT_VALUE_BOUNDS.name + 1) }, "name"],
    [{ email: "e".repeat(IMPORT_COMMIT_VALUE_BOUNDS.email + 1) }, "email"],
    [{ phone: "p".repeat(IMPORT_COMMIT_VALUE_BOUNDS.phone + 1) }, "phone"],
    [{ guardian_phone: "g".repeat(IMPORT_COMMIT_VALUE_BOUNDS.guardian_phone + 1) }, "guardian_phone"],
    [{ grade: "d".repeat(IMPORT_COMMIT_VALUE_BOUNDS.grade + 1) }, "grade"],
    [{ barcode: "b".repeat(IMPORT_COMMIT_VALUE_BOUNDS.barcode + 1) }, "barcode"],
  ];
  for (const [overrides, field] of overflows) {
    const gate = evaluateImportCommitGate([syntheticRow(overrides)], clearResultFor([2]));
    assert.equal(gate.ok, false, `${field} must be refused`);
    if (gate.ok !== false) return;
    assert.equal(gate.reason, "value-too-long", field);
  }
  // The bound itself is still accepted.
  const atBound = evaluateImportCommitGate(
    [syntheticRow({ barcode: "b".repeat(IMPORT_COMMIT_VALUE_BOUNDS.barcode) })],
    clearResultFor([2]),
  );
  assert.equal(atBound.ok, true);
});

test("gate: a decision made after the reconciliation makes it stale", () => {
  const model = modelOf(CLEAN_CSV);
  const after = applyImportDecision(model, 3, "exclude").state;
  const gate = evaluateImportCommitGate(after.rows, clearResultFor(CLEAN_ROWS));
  assert.equal(gate.ok, false);
  if (gate.ok !== false) return;
  assert.equal(gate.reason, "reconciliation-stale");
  assert.deepEqual(gate.rowNumbers, [2], "the row numbers now being submitted");
});

test("gate: a reordered reconciliation answer is stale, not a match", () => {
  const reordered: ServerResolutionResult = {
    rows: [{ row_number: 3, matched_fields: [] }, { row_number: 2, matched_fields: [] }],
    summary: { checked: 2, matched: 0, clear: 2 },
  };
  const gate = evaluateImportCommitGate(modelOf(CLEAN_CSV).rows, reordered);
  assert.equal(gate.ok, false);
  if (gate.ok !== false) return;
  assert.equal(gate.reason, "reconciliation-stale");
});

test("gate: a single existing match refuses the whole batch and names the row", () => {
  const matched: ServerResolutionResult = {
    rows: [{ row_number: 2, matched_fields: ["email"] }, { row_number: 3, matched_fields: [] }],
    summary: { checked: 2, matched: 1, clear: 1 },
  };
  const gate = evaluateImportCommitGate(modelOf(CLEAN_CSV).rows, matched);
  assert.equal(gate.ok, false);
  if (gate.ok !== false) return;
  assert.equal(gate.reason, "existing-matches");
  assert.deepEqual(gate.rowNumbers, [2]);
});

test("gate: an inconsistent summary is refused even when every row reads clear", () => {
  const rows = [{ row_number: 2, matched_fields: [] }, { row_number: 3, matched_fields: [] }];
  for (const summary of [
    { checked: 2, matched: 1, clear: 1 },
    { checked: 3, matched: 0, clear: 3 },
    { checked: 2, matched: 0, clear: 5 },
  ]) {
    const gate = evaluateImportCommitGate(modelOf(CLEAN_CSV).rows, { rows, summary });
    assert.equal(gate.ok, false, JSON.stringify(summary));
    if (gate.ok !== false) return;
    assert.equal(gate.reason, "existing-matches");
  }
});

test("gate: the batch is ascending by physical row number, whatever the model order", () => {
  const rows = [syntheticRow({ rowNumber: 3, rowIndex: 2 }), syntheticRow({ rowNumber: 2, rowIndex: 1 })];
  const gate = evaluateImportCommitGate(rows, clearResultFor([2, 3]));
  assert.equal(gate.ok, true);
  if (gate.ok !== true) return;
  assert.deepEqual(gate.rows.map((row) => row.row_number), [2, 3]);
});

test("gate: values are copied verbatim, never trimmed or casefolded", () => {
  const rows = [
    syntheticRow({ name: " Ali ", email: "A@B.C", phone: "007", barcode: "00B1", grade: " 3 " }),
  ];
  const gate = evaluateImportCommitGate(rows, clearResultFor([2]));
  assert.equal(gate.ok, true);
  if (gate.ok !== true) return;
  assert.equal(gate.rows[0].name, " Ali ");
  assert.equal(gate.rows[0].email, "A@B.C");
  assert.equal(gate.rows[0].phone, "007");
  assert.equal(gate.rows[0].barcode, "00B1");
  assert.equal(gate.rows[0].grade, " 3 ");
});

// ---------------------------------------------------------------------------
// Canonical payload and request building
// ---------------------------------------------------------------------------

const gateRowsOf = (csv: string = CLEAN_CSV, resolution: ServerResolutionResult | null = clearResultFor(CLEAN_ROWS)) => {
  const gate = evaluateImportCommitGate(modelOf(csv).rows, resolution);
  assert.equal(gate.ok, true, "the fixture must be confirmable");
  if (gate.ok !== true) throw new Error("fixture must be confirmable");
  return gate.rows;
};

test("payload: the canonical form is the documented array-of-arrays", () => {
  const canonical = canonicalImportCommitPayload(gateRowsOf());
  assert.equal(
    canonical,
    JSON.stringify([
      [2, "Ali", "a@b.c", "0100", "", "", ""],
      [3, "Sara", "d@e.f", "0200", "", "", ""],
    ]),
  );
});

test("payload: the canonical form is a direct projection in the given order", () => {
  // The ascending guarantee belongs to the GATE (tested above): the canonical
  // form itself never reorders, renumbers or trims anything. It is the identity
  // the idempotency key is bound to, so it must be a faithful projection.
  const rows = gateRowsOf();
  assert.equal(
    canonicalImportCommitPayload([rows[1], rows[0]]),
    JSON.stringify([
      [3, "Sara", "d@e.f", "0200", "", "", ""],
      [2, "Ali", "a@b.c", "0100", "", "", ""],
    ]),
  );
  assert.equal(
    canonicalImportCommitPayload(rows),
    JSON.stringify([
      [2, "Ali", "a@b.c", "0100", "", "", ""],
      [3, "Sara", "d@e.f", "0200", "", "", ""],
    ]),
  );
});

test("payload: the gate always hands the canonical form ascending rows", () => {
  const model = modelOf(CLEAN_CSV);
  const reversedOrder = [model.rows[1], model.rows[0]];
  const gate = evaluateImportCommitGate(reversedOrder, clearResultFor(CLEAN_ROWS));
  assert.equal(gate.ok, true);
  if (gate.ok !== true) return;
  const numbers = gate.rows.map((row) => row.row_number);
  assert.deepEqual(numbers, [...numbers].sort((left, right) => left - right));
});

test("payload: the canonical form never contains the idempotency key", () => {
  const canonical = canonicalImportCommitPayload(gateRowsOf());
  assert.equal(canonical.includes("idempotency"), false);
  assert.equal(canonical.includes("key"), false);
});

test("payload: one changed value is a DIFFERENT batch", () => {
  const rows = gateRowsOf();
  const changed = [rows[0], { ...rows[1], phone: "0999" }];
  assert.notEqual(
    canonicalImportCommitPayload(changed),
    canonicalImportCommitPayload(rows),
  );
});

test("payload: a leading zero or a case difference is a different batch", () => {
  const rows = gateRowsOf();
  assert.notEqual(
    canonicalImportCommitPayload([{ ...rows[0], phone: "00100" }, rows[1]]),
    canonicalImportCommitPayload(rows),
  );
  assert.notEqual(
    canonicalImportCommitPayload([{ ...rows[0], email: "A@B.C" }, rows[1]]),
    canonicalImportCommitPayload(rows),
  );
});

test("keys: the documented bounds and shape of one idempotency key", () => {
  assert.equal(IMPORT_COMMIT_KEY_MIN_CHARS, 16);
  assert.equal(IMPORT_COMMIT_KEY_MAX_CHARS, 128);
  assert.equal(IMPORT_COMMIT_KEY_PATTERN.test("a".repeat(IMPORT_COMMIT_KEY_MIN_CHARS)), true);
  assert.equal(IMPORT_COMMIT_KEY_PATTERN.test("a".repeat(IMPORT_COMMIT_KEY_MAX_CHARS)), true);
  assert.equal(IMPORT_COMMIT_KEY_PATTERN.test("a".repeat(IMPORT_COMMIT_KEY_MIN_CHARS - 1)), false);
  assert.equal(IMPORT_COMMIT_KEY_PATTERN.test("a".repeat(IMPORT_COMMIT_KEY_MAX_CHARS + 1)), false);
  for (const bad of ["has space", "slash/inside", "plus+sign", "unicode-ü", "semi;colon"]) {
    assert.equal(IMPORT_COMMIT_KEY_PATTERN.test(bad), false, bad);
  }
  assert.equal(IMPORT_COMMIT_KEY_PATTERN.test("Abc-def_0123456789"), true);
});

test("request: the body carries exactly the two documented keys", () => {
  const request = buildImportCommitRequest("key-0123456789abcdef", gateRowsOf());
  assert.deepEqual(Object.keys(request), ["idempotency_key", "rows"]);
});

test("request: every row carries exactly the seven documented keys in order", () => {
  const request = buildImportCommitRequest("key-0123456789abcdef", gateRowsOf());
  assert.equal(request.rows.length, CLEAN_ROWS.length);
  for (const row of request.rows) {
    assert.deepEqual(Object.keys(row), [...IMPORT_COMMIT_ROW_KEYS]);
  }
});

test("request: the submitted values are the file's own, unchanged", () => {
  const request = buildImportCommitRequest("key-0123456789abcdef", gateRowsOf());
  assert.equal(request.rows[0].name, "Ali");
  assert.equal(request.rows[0].phone, "0100");
  assert.equal(request.rows[0].email, "a@b.c");
  assert.equal(JSON.stringify(request).includes("Ali"), true, "the six accepted columns ARE sent");
});

test("request: no identity, account or enrollment field is ever built", () => {
  const serialized = JSON.stringify(buildImportCommitRequest("key-0123456789abcdef", gateRowsOf()));
  for (const forbidden of ["user_id", "account", "password", "role", "invitation", "otp", "enrollment", "group_id", "course_id", "branch_id", "payment", "tenant_id", "status"]) {
    assert.equal(serialized.includes(forbidden), false, `the request must not contain ${forbidden}`);
  }
});

// ---------------------------------------------------------------------------
// Response parsing
// ---------------------------------------------------------------------------

const parseCommit = (raw: unknown, expected: readonly number[] = CLEAN_ROWS) =>
  parseImportCommitResponse(raw, expected);

test("parse: the documented envelope is accepted", () => {
  const parsed = parseCommit(commitEnvelopeFor(CLEAN_ROWS));
  assert.equal(parsed.ok, true);
  if (parsed.ok !== true) return;
  assert.equal(parsed.result.replayed, false);
  assert.equal(parsed.result.created, 2);
  assert.deepEqual(parsed.result.row_numbers, CLEAN_ROWS);
});

test("parse: a replayed envelope is accepted and reported as replayed", () => {
  const parsed = parseCommit(commitEnvelopeFor(CLEAN_ROWS, true));
  assert.equal(parsed.ok, true);
  if (parsed.ok !== true) return;
  assert.equal(parsed.result.replayed, true);
});

test("parse: a non-object body is malformed", () => {
  for (const raw of [null, undefined, 7, "batch", [], true]) {
    assert.equal(parseCommit(raw).ok, false, JSON.stringify(raw) ?? "undefined");
  }
});

test("parse: an extra or missing envelope key is malformed", () => {
  assert.equal(parseCommit({ ...(commitEnvelopeFor(CLEAN_ROWS) as object), extra: 1 }).ok, false);
  assert.equal(parseCommit({ batch_id: "b", replayed: false, created: 2 }).ok, false);
});

test("parse: a batch id outside the documented bounds is malformed", () => {
  for (const batch_id of ["", "x".repeat(129), 7, null]) {
    const raw = { ...(commitEnvelopeFor(CLEAN_ROWS) as object), batch_id };
    assert.equal(parseCommit(raw).ok, false, JSON.stringify(batch_id));
  }
});

test("parse: a non-boolean replay flag is malformed", () => {
  for (const replayed of ["false", 0, null]) {
    const raw = { ...(commitEnvelopeFor(CLEAN_ROWS) as object), replayed };
    assert.equal(parseCommit(raw).ok, false, JSON.stringify(replayed));
  }
});

test("parse: a created count that is not a positive integer is malformed", () => {
  for (const created of [0, -1, 1.5, "2", null]) {
    const raw = { ...(commitEnvelopeFor(CLEAN_ROWS) as object), created };
    assert.equal(parseCommit(raw).ok, false, JSON.stringify(created));
  }
});

test("parse: a created count that differs from the batch is malformed", () => {
  assert.equal(parseCommit(commitEnvelopeFor(CLEAN_ROWS)).ok, true);
  const raw = { ...(commitEnvelopeFor(CLEAN_ROWS) as object), created: 1 };
  assert.equal(parseCommit(raw).ok, false);
});

test("parse: a different number of answered row numbers is malformed", () => {
  assert.equal(parseCommit(commitEnvelopeFor([2]), [2, 3]).ok, false);
  assert.equal(parseCommit(commitEnvelopeFor([2, 3]), [2]).ok, false);
});

test("parse: a substituted row number is malformed", () => {
  assert.equal(parseCommit(commitEnvelopeFor([2, 4])).ok, false);
});

test("parse: a reordered row set is malformed", () => {
  const raw = {
    batch_id: "9d4b1f2c-6a3e-4c8d-9e5f-1a2b3c4d5e6f",
    replayed: false,
    created: 2,
    row_numbers: [3, 2],
  };
  assert.equal(parseCommit(raw).ok, false);
});

test("parse: a duplicated row entry is malformed", () => {
  const raw = {
    batch_id: "9d4b1f2c-6a3e-4c8d-9e5f-1a2b3c4d5e6f",
    replayed: false,
    created: 2,
    row_numbers: [2, 2],
  };
  assert.equal(parseCommit(raw).ok, false);
});

test("parse: a non-integer row number is malformed", () => {
  const raw = {
    batch_id: "9d4b1f2c-6a3e-4c8d-9e5f-1a2b3c4d5e6f",
    replayed: false,
    created: 2,
    row_numbers: [2, "3"],
  };
  assert.equal(parseCommit(raw).ok, false);
});

test("parse: a created student id is never part of the contract", () => {
  // The server DTO has exactly four keys; a body that adds a created id is a
  // different contract and must be refused rather than partially trusted.
  const raw = { ...(commitEnvelopeFor(CLEAN_ROWS) as object), student_ids: ["a", "b"] };
  assert.equal(parseCommit(raw).ok, false);
});

// ---------------------------------------------------------------------------
// Controller: explicit, single-flight, fenced
// ---------------------------------------------------------------------------

test("controller: constructing it issues no request", () => {
  const { transport, calls } = recordingTransport();
  const controller = createImportCommitController({ commit: transport, createKey: sequentialKeys().createKey });
  try {
    assert.deepEqual(controller.getState(), initialImportCommitState());
    assert.equal(calls.length, 0, "nothing may be sent before an explicit confirmation");
  } finally {
    controller.dispose();
  }
});

test("controller: an explicit confirmation submits exactly one request", async () => {
  const { transport, calls } = recordingTransport();
  const controller = createImportCommitController({ commit: transport, createKey: sequentialKeys().createKey });
  try {
    const outcome = await controller.confirm(modelOf(CLEAN_CSV).rows, clearResultFor(CLEAN_ROWS));
    assert.equal(outcome.ok, true);
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].request.rows.map((row) => row.row_number), CLEAN_ROWS);
  } finally {
    controller.dispose();
  }
});

test("controller: the submitted body carries exactly the two documented keys", async () => {
  const { transport, calls } = recordingTransport();
  const controller = createImportCommitController({ commit: transport, createKey: sequentialKeys().createKey });
  try {
    await controller.confirm(modelOf(CLEAN_CSV).rows, clearResultFor(CLEAN_ROWS));
    assert.deepEqual(Object.keys(calls[0].request), ["idempotency_key", "rows"]);
    for (const row of calls[0].request.rows) {
      assert.deepEqual(Object.keys(row), [...IMPORT_COMMIT_ROW_KEYS]);
    }
  } finally {
    controller.dispose();
  }
});

test("controller: the minted key is opaque, in shape and unpredictable", async () => {
  const { transport, calls } = recordingTransport();
  const source = sequentialKeys();
  const controller = createImportCommitController({ commit: transport, createKey: source.createKey });
  try {
    await controller.confirm(modelOf(CLEAN_CSV).rows, clearResultFor(CLEAN_ROWS));
    const key = calls[0].request.idempotency_key;
    assert.equal(IMPORT_COMMIT_KEY_PATTERN.test(key), true, key);
    const payload = JSON.stringify(calls[0].request.rows);
    assert.equal(payload.includes(key), false, "the key must not be derived from the payload");
  } finally {
    controller.dispose();
  }
});

test("controller: a confirmed answer publishes the committed state and the result", async () => {
  const { transport } = recordingTransport();
  const controller = createImportCommitController({ commit: transport, createKey: sequentialKeys().createKey });
  try {
    await controller.confirm(modelOf(CLEAN_CSV).rows, clearResultFor(CLEAN_ROWS));
    const state = controller.getState();
    assert.equal(state.phase, "committed");
    assert.equal(state.result?.created, 2);
    assert.deepEqual(state.result?.row_numbers, CLEAN_ROWS);
    assert.equal(state.result?.replayed, false);
    assert.equal(state.message, null, "a success carries no warning message");
  } finally {
    controller.dispose();
  }
});

test("controller: the published result is exactly the server DTO, nothing more", async () => {
  const { transport } = recordingTransport();
  const controller = createImportCommitController({ commit: transport, createKey: sequentialKeys().createKey });
  try {
    const outcome = await controller.confirm(modelOf(CLEAN_CSV).rows, clearResultFor(CLEAN_ROWS));
    assert.equal(outcome.ok, true);
    if (outcome.ok !== true) return;
    assert.deepEqual(Object.keys(outcome.result), ["batch_id", "replayed", "created", "row_numbers"]);
  } finally {
    controller.dispose();
  }
});

test("controller: a second click while one submission is in flight is refused as busy", async () => {
  const gate = deferred<{ status: number; body: unknown }>();
  let calls = 0;
  const controller = createImportCommitController({
    commit: async () => { calls += 1; return gate.promise; },
    createKey: sequentialKeys().createKey,
  });
  try {
    const first = controller.confirm(modelOf(CLEAN_CSV).rows, clearResultFor(CLEAN_ROWS));
    await flush();
    const second = await controller.confirm(modelOf(CLEAN_CSV).rows, clearResultFor(CLEAN_ROWS));
    assert.equal(second.ok, false);
    if (second.ok !== false) return;
    assert.equal(second.reason, "busy");
    assert.equal(calls, 1, "a refused click must not start a second submission");
    assert.equal(controller.getState().phase, "submitting");
    gate.resolve({ status: 200, body: commitEnvelopeFor(CLEAN_ROWS) });
    await first;
  } finally {
    controller.dispose();
  }
});

test("controller: a gate refusal never builds a request", async () => {
  const { transport, calls } = recordingTransport();
  const controller = createImportCommitController({ commit: transport, createKey: sequentialKeys().createKey });
  try {
    const outcome = await controller.confirm(modelOf(PENDING_CSV).rows, clearResultFor([2, 3]));
    assert.equal(outcome.ok, false);
    if (outcome.ok !== false) return;
    assert.equal(outcome.reason, "pending-rows");
    assert.equal(calls.length, 0, "a locally refused batch must never reach the transport");
    const state = controller.getState();
    assert.equal(state.phase, "rejected");
    assert.equal(state.message, IMPORT_COMMIT_MESSAGES["pending-rows"]);
    assert.equal(state.result, null);
  } finally {
    controller.dispose();
  }
});

test("controller: an existing match is refused locally, never submitted", async () => {
  const { transport, calls } = recordingTransport();
  const controller = createImportCommitController({ commit: transport, createKey: sequentialKeys().createKey });
  try {
    const matched: ServerResolutionResult = {
      rows: [{ row_number: 2, matched_fields: ["phone"] }, { row_number: 3, matched_fields: [] }],
      summary: { checked: 2, matched: 1, clear: 1 },
    };
    const outcome = await controller.confirm(modelOf(CLEAN_CSV).rows, matched);
    assert.equal(outcome.ok, false);
    if (outcome.ok !== false) return;
    assert.equal(outcome.reason, "existing-matches");
    assert.equal(calls.length, 0, "a matched value must never be submitted for creation");
  } finally {
    controller.dispose();
  }
});

test("controller: a missing transport is an honest unavailable state", async () => {
  const controller = createImportCommitController({ createKey: sequentialKeys().createKey });
  try {
    const outcome = await controller.confirm(modelOf(CLEAN_CSV).rows, clearResultFor(CLEAN_ROWS));
    assert.equal(outcome.ok, false);
    if (outcome.ok !== false) return;
    assert.equal(outcome.reason, "unavailable");
    assert.equal(controller.getState().phase, "rejected");
    assert.equal(controller.getState().result, null);
  } finally {
    controller.dispose();
  }
});

test("controller: a key source outside the documented shape is refused, never weakened", async () => {
  for (const bad of ["short", "has space", "x".repeat(129), 7, null, undefined]) {
    const { transport, calls } = recordingTransport();
    const controller = createImportCommitController({ commit: transport, createKey: () => bad as never });
    try {
      const outcome = await controller.confirm(modelOf(CLEAN_CSV).rows, clearResultFor(CLEAN_ROWS));
      assert.equal(outcome.ok, false, JSON.stringify(bad));
      if (outcome.ok !== false) return;
      assert.equal(outcome.reason, "unavailable", JSON.stringify(bad));
      assert.equal(calls.length, 0, "a key that cannot be minted safely must never be submitted");
    } finally {
      controller.dispose();
    }
  }
});

test("controller: a key source that throws is refused as unavailable", async () => {
  const { transport, calls } = recordingTransport();
  const controller = createImportCommitController({
    commit: transport,
    createKey: () => { throw new Error("no entropy"); },
  });
  try {
    const outcome = await controller.confirm(modelOf(CLEAN_CSV).rows, clearResultFor(CLEAN_ROWS));
    assert.equal(outcome.ok, false);
    if (outcome.ok !== false) return;
    assert.equal(outcome.reason, "unavailable");
    assert.equal(calls.length, 0);
  } finally {
    controller.dispose();
  }
});

test("controller: the default key source produces an in-shape opaque key", async () => {
  const { transport, calls } = recordingTransport();
  const controller = createImportCommitController({ commit: transport });
  try {
    const outcome = await controller.confirm(modelOf(CLEAN_CSV).rows, clearResultFor(CLEAN_ROWS));
    assert.equal(outcome.ok, true);
    assert.equal(IMPORT_COMMIT_KEY_PATTERN.test(calls[0].request.idempotency_key), true);
  } finally {
    controller.dispose();
  }
});

// ---------------------------------------------------------------------------
// Idempotency
// ---------------------------------------------------------------------------

test("idempotency: one confirmation mints exactly one key", async () => {
  const { transport, calls } = recordingTransport();
  const source = sequentialKeys();
  const controller = createImportCommitController({ commit: transport, createKey: source.createKey });
  try {
    await controller.confirm(modelOf(CLEAN_CSV).rows, clearResultFor(CLEAN_ROWS));
    assert.equal(calls.length, 1);
    assert.equal(source.keys.length, 1, "one batch, one key");
  } finally {
    controller.dispose();
  }
});

test("idempotency: a server fault keeps the attempt open for a same-key retry", async () => {
  const { transport, calls } = recordingTransport((_request, attempt) =>
    attempt === 1
      ? { status: 500, body: { code: "STUDENT_IMPORT_COMMIT_UNAVAILABLE" } }
      : { status: 200, body: commitEnvelopeFor(CLEAN_ROWS) },
  );
  const controller = createImportCommitController({ commit: transport, createKey: sequentialKeys().createKey });
  try {
    const first = await controller.confirm(modelOf(CLEAN_CSV).rows, clearResultFor(CLEAN_ROWS));
    assert.equal(first.ok, false);
    if (first.ok !== false) return;
    assert.equal(first.reason, "failed");
    assert.equal(controller.getState().phase, "failed");
    assert.equal(controller.getState().result, null, "an uncertain outcome must never claim a result");
    assert.equal(controller.canRetry(), true, "the same batch may be retried with the same key");

    const second = await controller.confirm(modelOf(CLEAN_CSV).rows, clearResultFor(CLEAN_ROWS));
    assert.equal(second.ok, true);
    assert.equal(calls.length, 2);
    assert.equal(calls[1].key, calls[0].key, "the retry must reuse the SAME idempotency key");
    assert.deepEqual(calls[1].request.rows, calls[0].request.rows, "and the SAME payload");
  } finally {
    controller.dispose();
  }
});

test("idempotency: a transport rejection keeps the attempt open for a same-key retry", async () => {
  let attempts = 0;
  const keys: string[] = [];
  const bodies: ImportCommitRequest["rows"][] = [];
  const controller = createImportCommitController({
    commit: async (request) => {
      attempts += 1;
      keys.push(request.idempotency_key);
      bodies.push(request.rows.map((row) => ({ ...row })));
      if (attempts === 1) throw new Error("network failure");
      return { status: 200, body: commitEnvelopeFor(CLEAN_ROWS) };
    },
    createKey: sequentialKeys().createKey,
  });
  try {
    const first = await controller.confirm(modelOf(CLEAN_CSV).rows, clearResultFor(CLEAN_ROWS));
    assert.equal(first.ok, false);
    if (first.ok !== false) return;
    assert.equal(first.reason, "failed", "an unknown transport outcome is a failure, never a success");
    assert.equal(controller.getState().phase, "failed");
    assert.equal(controller.canRetry(), true);

    const second = await controller.confirm(modelOf(CLEAN_CSV).rows, clearResultFor(CLEAN_ROWS));
    assert.equal(second.ok, true);
    assert.equal(keys.length, 2);
    assert.equal(keys[1], keys[0], "the retry reuses the same key");
    assert.deepEqual(bodies[1], bodies[0], "and the same payload");
  } finally {
    controller.dispose();
  }
});

test("idempotency: a changed payload can never inherit the previous key", async () => {
  const { transport, calls } = recordingTransport(() => ({ status: 500, body: { code: "INTERNAL" } }));  const controller = createImportCommitController({ commit: transport, createKey: sequentialKeys().createKey });
  try {
    await controller.confirm(modelOf(CLEAN_CSV).rows, clearResultFor(CLEAN_ROWS));
    assert.equal(controller.canRetry(), true);

    // The same batch, one changed value: a NEW key, never the old one.
    const changed = modelOf(CLEAN_CSV).rows.map((row) =>
      row.rowNumber === 3 ? { ...row, phone: "0999" } : row,
    );
    await controller.confirm(changed, clearResultFor(CLEAN_ROWS));
    assert.equal(calls.length, 2);
    assert.notEqual(calls[1].key, calls[0].key, "a different batch must mint a different key");
  } finally {
    controller.dispose();
  }
});

test("idempotency: a definite refusal drops the attempt", async () => {
  const { transport, calls } = recordingTransport(() => ({ status: 400, body: { code: "STUDENT_IMPORT_COMMIT_INVALID" } }));
  const source = sequentialKeys();
  const controller = createImportCommitController({ commit: transport, createKey: source.createKey });
  try {
    const first = await controller.confirm(modelOf(CLEAN_CSV).rows, clearResultFor(CLEAN_ROWS));
    assert.equal(first.ok, false);
    if (first.ok !== false) return;
    assert.equal(first.reason, "rejected");
    assert.equal(controller.canRetry(), false, "a definite outcome leaves nothing to retry");

    const second = await controller.confirm(modelOf(CLEAN_CSV).rows, clearResultFor(CLEAN_ROWS));
    assert.equal(second.ok, false);
    assert.equal(calls.length, 2);
    assert.notEqual(calls[1].key, calls[0].key, "a new confirmation is a new attempt with a new key");
  } finally {
    controller.dispose();
  }
});

test("idempotency: a committed batch re-confirmed replays under the same key", async () => {
  const { transport, calls } = recordingTransport();
  const controller = createImportCommitController({ commit: transport, createKey: sequentialKeys().createKey });
  try {
    await controller.confirm(modelOf(CLEAN_CSV).rows, clearResultFor(CLEAN_ROWS));
    const second = await controller.confirm(modelOf(CLEAN_CSV).rows, clearResultFor(CLEAN_ROWS));
    assert.equal(second.ok, true);
    assert.equal(calls.length, 2);
    assert.equal(calls[1].key, calls[0].key, "the recorded batch answers the same key");
  } finally {
    controller.dispose();
  }
});

test("idempotency: clear drops the attempt, so the next confirmation mints a new key", async () => {
  const { transport, calls } = recordingTransport(() => ({ status: 500, body: { code: "INTERNAL" } }));
  const controller = createImportCommitController({ commit: transport, createKey: sequentialKeys().createKey });
  try {
    await controller.confirm(modelOf(CLEAN_CSV).rows, clearResultFor(CLEAN_ROWS));
    assert.equal(controller.canRetry(), true);
    controller.clear();
    assert.equal(controller.canRetry(), false);
    await controller.confirm(modelOf(CLEAN_CSV).rows, clearResultFor(CLEAN_ROWS));
    assert.equal(calls.length, 2);
    assert.notEqual(calls[1].key, calls[0].key);
  } finally {
    controller.dispose();
  }
});

// ---------------------------------------------------------------------------
// Failure mapping
// ---------------------------------------------------------------------------

test("failure: a 5xx is an uncertain failure that keeps the attempt open", async () => {
  for (const status of [500, 502, 503]) {
    const { transport, calls } = recordingTransport(() => ({ status, body: { code: "STUDENT_IMPORT_COMMIT_UNAVAILABLE" } }));
    const controller = createImportCommitController({ commit: transport, createKey: sequentialKeys().createKey });
    try {
      const outcome = await controller.confirm(modelOf(CLEAN_CSV).rows, clearResultFor(CLEAN_ROWS));
      assert.equal(outcome.ok, false, String(status));
      if (outcome.ok !== false) return;
      assert.equal(outcome.reason, "failed");
      assert.equal(controller.getState().phase, "failed");
      assert.equal(controller.getState().message, IMPORT_COMMIT_MESSAGES.failed);
      assert.equal(controller.canRetry(), true);
      assert.equal(calls.length, 1);
    } finally {
      controller.dispose();
    }
  }
});

test("failure: every 4xx is a definite refusal that creates nothing", async () => {
  for (const status of [400, 401, 403, 404, 409, 413, 422]) {
    const { transport, calls } = recordingTransport(() => ({ status, body: { code: "SOMETHING" } }));
    const controller = createImportCommitController({ commit: transport, createKey: sequentialKeys().createKey });
    try {
      const outcome = await controller.confirm(modelOf(CLEAN_CSV).rows, clearResultFor(CLEAN_ROWS));
      assert.equal(outcome.ok, false, String(status));
      if (outcome.ok !== false) return;
      assert.equal(outcome.reason, "rejected", String(status));
      assert.equal(controller.getState().phase, "rejected");
      assert.equal(controller.getState().result, null, "no row was created");
      assert.equal(controller.canRetry(), false);
      assert.equal(calls.length, 1);
    } finally {
      controller.dispose();
    }
  }
});

test("failure: a 409 with the idempotency code is a conflict", async () => {
  const { transport, calls } = recordingTransport(() => ({
    status: 409,
    body: { code: "STUDENT_IMPORT_IDEMPOTENCY_CONFLICT" },
  }));
  const controller = createImportCommitController({ commit: transport, createKey: sequentialKeys().createKey });
  try {
    const outcome = await controller.confirm(modelOf(CLEAN_CSV).rows, clearResultFor(CLEAN_ROWS));
    assert.equal(outcome.ok, false);
    if (outcome.ok !== false) return;
    assert.equal(outcome.reason, "conflict");
    assert.equal(controller.getState().phase, "conflict");
    assert.equal(controller.getState().message, IMPORT_COMMIT_MESSAGES.conflict);
    assert.equal(controller.getState().result, null);
    assert.equal(calls.length, 1);
  } finally {
    controller.dispose();
  }
});

test("failure: a 409 with the existing-match code reports existing values", async () => {
  const { transport } = recordingTransport(() => ({
    status: 409,
    body: { code: "STUDENT_IMPORT_EXISTING_MATCH", rows: [{ row_number: 2, matched_fields: ["email"] }] },
  }));
  const controller = createImportCommitController({ commit: transport, createKey: sequentialKeys().createKey });
  try {
    const outcome = await controller.confirm(modelOf(CLEAN_CSV).rows, clearResultFor(CLEAN_ROWS));
    assert.equal(outcome.ok, false);
    if (outcome.ok !== false) return;
    assert.equal(outcome.reason, "existing-matches");
    assert.equal(controller.getState().phase, "rejected");
    assert.equal(controller.getState().message, IMPORT_COMMIT_MESSAGES["existing-matches"]);
    assert.equal(controller.getState().result, null);
  } finally {
    controller.dispose();
  }
});

test("failure: a 409 with an unknown code is a plain refusal, never a guessed conflict", async () => {
  const { transport } = recordingTransport(() => ({ status: 409, body: { code: "SOMETHING_ELSE" } }));
  const controller = createImportCommitController({ commit: transport, createKey: sequentialKeys().createKey });
  try {
    const outcome = await controller.confirm(modelOf(CLEAN_CSV).rows, clearResultFor(CLEAN_ROWS));
    assert.equal(outcome.ok, false);
    if (outcome.ok !== false) return;
    assert.equal(outcome.reason, "rejected");
    assert.equal(controller.getState().phase, "rejected");
  } finally {
    controller.dispose();
  }
});

test("failure: a 4xx without a code is a plain refusal", async () => {
  const { transport } = recordingTransport(() => ({ status: 400, body: { message: "bad" } }));
  const controller = createImportCommitController({ commit: transport, createKey: sequentialKeys().createKey });
  try {
    const outcome = await controller.confirm(modelOf(CLEAN_CSV).rows, clearResultFor(CLEAN_ROWS));
    assert.equal(outcome.ok, false);
    if (outcome.ok !== false) return;
    assert.equal(outcome.reason, "rejected");
  } finally {
    controller.dispose();
  }
});

test("failure: a 2xx that is not the documented DTO is malformed and drops the attempt", async () => {
  for (const body of [
    null,
    { batch_id: "b", replayed: false, created: 2 },
    { ...(commitEnvelopeFor(CLEAN_ROWS) as object), created: 1 },
    { ...(commitEnvelopeFor(CLEAN_ROWS) as object), row_numbers: [2] },
  ]) {
    const { transport } = recordingTransport(() => ({ status: 200, body }));
    const controller = createImportCommitController({ commit: transport, createKey: sequentialKeys().createKey });
    try {
      const outcome = await controller.confirm(modelOf(CLEAN_CSV).rows, clearResultFor(CLEAN_ROWS));
      assert.equal(outcome.ok, false, JSON.stringify(body));
      if (outcome.ok !== false) return;
      assert.equal(outcome.reason, "malformed");
      assert.equal(controller.getState().phase, "malformed");
      assert.equal(controller.getState().result, null, "a malformed 2xx must never be a partial success");
      assert.equal(controller.getState().message, IMPORT_COMMIT_MESSAGES.malformed);
      assert.equal(controller.canRetry(), false);
    } finally {
      controller.dispose();
    }
  }
});

test("failure: a 3xx status is neither success nor a documented refusal", async () => {
  const { transport } = recordingTransport(() => ({ status: 302, body: null }));
  const controller = createImportCommitController({ commit: transport, createKey: sequentialKeys().createKey });
  try {
    const outcome = await controller.confirm(modelOf(CLEAN_CSV).rows, clearResultFor(CLEAN_ROWS));
    assert.equal(outcome.ok, false);
    if (outcome.ok !== false) return;
    assert.equal(outcome.reason, "rejected", "a redirect is not a 2xx and must not be a success");
    assert.equal(controller.getState().result, null);
  } finally {
    controller.dispose();
  }
});

// ---------------------------------------------------------------------------
// Lifecycle fences
// ---------------------------------------------------------------------------

test("lifecycle: clear drops the confirmed result", async () => {
  const { transport } = recordingTransport();
  const controller = createImportCommitController({ commit: transport, createKey: sequentialKeys().createKey });
  try {
    await controller.confirm(modelOf(CLEAN_CSV).rows, clearResultFor(CLEAN_ROWS));
    assert.equal(controller.getState().phase, "committed");
    controller.clear();
    assert.deepEqual(controller.getState(), initialImportCommitState());
  } finally {
    controller.dispose();
  }
});

test("lifecycle: a cleared pending reply cannot restore the dropped result", async () => {
  const gate = deferred<{ status: number; body: unknown }>();
  const controller = createImportCommitController({ commit: async () => gate.promise, createKey: sequentialKeys().createKey });
  try {
    const pending = controller.confirm(modelOf(CLEAN_CSV).rows, clearResultFor(CLEAN_ROWS));
    await flush();
    controller.clear();
    gate.resolve({ status: 200, body: commitEnvelopeFor(CLEAN_ROWS) });
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

test("lifecycle: a retired reply cannot release a NEWER busy latch", async () => {
  const first = deferred<{ status: number; body: unknown }>();
  const second = deferred<{ status: number; body: unknown }>();
  let calls = 0;
  const controller = createImportCommitController({
    commit: async () => { calls += 1; return calls === 1 ? first.promise : second.promise; },
    createKey: sequentialKeys().createKey,
  });
  try {
    const attemptA = controller.confirm(modelOf(CLEAN_CSV).rows, clearResultFor(CLEAN_ROWS));
    await flush();
    controller.clear();
    const attemptB = controller.confirm(modelOf(CLEAN_CSV).rows, clearResultFor(CLEAN_ROWS));
    await flush();
    assert.equal(calls, 2);

    // The retired reply settles: it must change nothing at all.
    first.resolve({ status: 200, body: commitEnvelopeFor(CLEAN_ROWS) });
    await attemptA;
    assert.equal(controller.getState().phase, "submitting", "the newer attempt still owns the latch");

    // The decisive property: the older finally did NOT release the new latch.
    const third = await controller.confirm(modelOf(CLEAN_CSV).rows, clearResultFor(CLEAN_ROWS));
    assert.equal(third.ok, false);
    if (third.ok !== false) return;
    assert.equal(third.reason, "busy");
    assert.equal(calls, 2, "the refused click must not start a third submission");

    second.resolve({ status: 200, body: commitEnvelopeFor(CLEAN_ROWS) });
    const outcomeB = await attemptB;
    assert.equal(outcomeB.ok, true);
    assert.equal(controller.getState().phase, "committed");
  } finally {
    controller.dispose();
  }
});

test("lifecycle: a reversed completion order cannot overwrite the newer answer", async () => {
  const first = deferred<{ status: number; body: unknown }>();
  const second = deferred<{ status: number; body: unknown }>();
  let calls = 0;
  const controller = createImportCommitController({
    commit: async () => { calls += 1; return calls === 1 ? first.promise : second.promise; },
    createKey: sequentialKeys().createKey,
  });
  try {
    const attemptA = controller.confirm(modelOf(CLEAN_CSV).rows, clearResultFor(CLEAN_ROWS));
    await flush();
    controller.clear();
    const attemptB = controller.confirm(modelOf(CLEAN_CSV).rows, clearResultFor(CLEAN_ROWS));
    await flush();

    // B (the newer attempt) settles FIRST.
    second.resolve({ status: 200, body: commitEnvelopeFor(CLEAN_ROWS) });
    await attemptB;
    assert.equal(controller.getState().phase, "committed");
    assert.equal(controller.getState().result?.created, 2);

    // A (the retired attempt) settles LAST and must not overwrite it.
    first.resolve({ status: 200, body: commitEnvelopeFor([2]) });
    await attemptA;
    assert.equal(controller.getState().phase, "committed");
    assert.equal(controller.getState().result?.created, 2, "the retired reply must not publish");
  } finally {
    controller.dispose();
  }
});

test("lifecycle: a principal change before a confirmation refuses the request", async () => {
  let principal = "session:a";
  const { transport, calls } = recordingTransport();
  const controller = createImportCommitController({
    commit: transport,
    readPrincipal: () => principal,
    createKey: sequentialKeys().createKey,
  });
  try {
    principal = "session:b";
    const outcome = await controller.confirm(modelOf(CLEAN_CSV).rows, clearResultFor(CLEAN_ROWS));
    assert.equal(outcome.ok, false);
    if (outcome.ok !== false) return;
    assert.equal(outcome.reason, "scope-changed");
    assert.equal(calls.length, 0, "the former scope's rows must never be submitted");
  } finally {
    controller.dispose();
  }
});

test("lifecycle: a principal change DURING the flight drops the answer", async () => {
  let principal = "session:a";
  const gate = deferred<{ status: number; body: unknown }>();
  const controller = createImportCommitController({
    commit: async () => gate.promise,
    readPrincipal: () => principal,
    createKey: sequentialKeys().createKey,
  });
  try {
    const pending = controller.confirm(modelOf(CLEAN_CSV).rows, clearResultFor(CLEAN_ROWS));
    await flush();
    principal = "session:b";
    gate.resolve({ status: 200, body: commitEnvelopeFor(CLEAN_ROWS) });
    const outcome = await pending;
    assert.equal(outcome.ok, false);
    if (outcome.ok !== false) return;
    assert.equal(outcome.reason, "scope-changed");
    assert.equal(controller.getState().result, null, "another scope's answer must never be shown");
  } finally {
    controller.dispose();
  }
});

test("lifecycle: revalidateScope reports and drops a silent principal change", async () => {
  let principal = "session:a";
  const { transport } = recordingTransport();
  const controller = createImportCommitController({
    commit: transport,
    readPrincipal: () => principal,
    createKey: sequentialKeys().createKey,
  });
  try {
    await controller.confirm(modelOf(CLEAN_CSV).rows, clearResultFor(CLEAN_ROWS));
    assert.equal(controller.revalidateScope(), false);
    principal = "session:c";
    assert.equal(controller.revalidateScope(), true);
    assert.equal(controller.getState().result, null);
  } finally {
    controller.dispose();
  }
});

test("lifecycle: a session event drops the result and retires the reply", async () => {
  const gate = deferred<{ status: number; body: unknown }>();
  const listeners: Array<() => void> = [];
  const controller = createImportCommitController({
    commit: async () => gate.promise,
    subscribeSession: (listener) => { listeners.push(listener); return () => {}; },
    createKey: sequentialKeys().createKey,
  });
  try {
    const pending = controller.confirm(modelOf(CLEAN_CSV).rows, clearResultFor(CLEAN_ROWS));
    await flush();
    for (const listener of listeners) listener();
    assert.deepEqual(controller.getState(), initialImportCommitState());
    gate.resolve({ status: 200, body: commitEnvelopeFor(CLEAN_ROWS) });
    const outcome = await pending;
    assert.equal(outcome.ok, false);
    assert.equal(controller.getState().result, null);
  } finally {
    controller.dispose();
  }
});

test("lifecycle: dispose drops everything and publishes nothing afterwards", async () => {
  const gate = deferred<{ status: number; body: unknown }>();
  const controller = createImportCommitController({ commit: async () => gate.promise, createKey: sequentialKeys().createKey });
  const seen: string[] = [];
  const unsubscribe = controller.subscribe((state) => seen.push(state.phase));
  const pending = controller.confirm(modelOf(CLEAN_CSV).rows, clearResultFor(CLEAN_ROWS));
  await flush();
  controller.dispose();
  unsubscribe();
  gate.resolve({ status: 200, body: commitEnvelopeFor(CLEAN_ROWS) });
  await pending;
  assert.deepEqual(controller.getState(), initialImportCommitState());
  assert.equal(seen[seen.length - 1], "submitting", "a disposed controller must not publish again");
});

test("lifecycle: a disposed controller refuses a new attempt", async () => {
  const { transport, calls } = recordingTransport();
  const controller = createImportCommitController({ commit: transport, createKey: sequentialKeys().createKey });
  controller.dispose();
  const outcome = await controller.confirm(modelOf(CLEAN_CSV).rows, clearResultFor(CLEAN_ROWS));
  assert.equal(outcome.ok, false);
  assert.equal(calls.length, 0);
});

test("lifecycle: a subscriber is notified of every published transition", async () => {
  const { transport } = recordingTransport();
  const controller = createImportCommitController({ commit: transport, createKey: sequentialKeys().createKey });
  const seen: ImportCommitState[] = [];
  const unsubscribe = controller.subscribe((state) => seen.push(state));
  try {
    await controller.confirm(modelOf(CLEAN_CSV).rows, clearResultFor(CLEAN_ROWS));
    controller.clear();
    unsubscribe();
    controller.dispose();
    assert.deepEqual(seen.map((state) => state.phase), ["idle", "submitting", "committed", "idle"]);
    // A clear restarts the revision counter: the dropped result is a new scope.
    assert.deepEqual(seen.map((state) => state.revision), [0, 1, 2, 0]);
  } finally {
    controller.dispose();
  }
});

test("lifecycle: unsubscribing stops the notifications", async () => {
  const { transport } = recordingTransport();
  const controller = createImportCommitController({ commit: transport, createKey: sequentialKeys().createKey });
  const seen: string[] = [];
  const unsubscribe = controller.subscribe((state) => seen.push(state.phase));
  unsubscribe();
  try {
    await controller.confirm(modelOf(CLEAN_CSV).rows, clearResultFor(CLEAN_ROWS));
    assert.deepEqual(seen, ["idle"], "the immediate call is the only one an unsubscribed listener sees");
  } finally {
    controller.dispose();
  }
});

test("lifecycle: no storage write and no console call happens during a full confirmation", async () => {
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

    const { transport } = recordingTransport();
    const controller = createImportCommitController({
      commit: transport,
      readPrincipal: () => "session:a",
      createKey: sequentialKeys().createKey,
    });
    await controller.confirm(modelOf(CLEAN_CSV).rows, clearResultFor(CLEAN_ROWS));
    await controller.confirm(modelOf(CLEAN_CSV).rows, clearResultFor(CLEAN_ROWS));
    controller.clear();
    controller.dispose();
    assert.deepEqual(storageWrites, [], "the private rows must never be persisted");
    assert.deepEqual(consoleCalls, [], "the private rows must never be logged");
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

test("lifecycle: no automatic network call happens on any non-confirmation action", async () => {
  const { transport, calls } = recordingTransport();
  const controller = createImportCommitController({ commit: transport, createKey: sequentialKeys().createKey });
  try {
    // Constructing, reading state, subscribing, clearing and revalidating the
    // scope are all silent: only an explicit confirmation sends anything.
    controller.getState();
    controller.subscribe(() => {});
    controller.revalidateScope();
    controller.clear();
    controller.canRetry();
    await flush();
    assert.equal(calls.length, 0, "only an explicit confirmation may submit");
  } finally {
    controller.dispose();
  }
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
  const { createStudentCsvPreviewController } = await import("../features/students/csv-preview");
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
 * The five injected states are served in the component's source order (preview,
 * resolution, report message, server reconciliation, import commit) and the
 * seven refs in theirs (preview controller, file input, resolution controller,
 * report controller, server controller, import seam, selection token).
 * `useEffect` is a no-op, so the component never builds its own controllers and
 * the injected seams are exactly the ones under test.
 */
const renderPanel = async (options: {
  preview: StudentCsvPreviewState;
  resolution: ImportResolutionState;
  resolutionController: unknown;
  reportController?: unknown;
  serverController?: unknown;
  serverState?: unknown;
  commitController?: unknown;
  commitState?: unknown;
}): Promise<{ html: string; controls: RenderedControl[]; submits: unknown[] }> => {
  const projectRequire = Module.createRequire(import.meta.url);
  const React = projectRequire("react");
  const { renderToStaticMarkup } = projectRequire("react-dom/server");
  const componentPath = projectRequire.resolve("../features/students/StudentImportPreview.tsx");
  const moduleInternals = Module as unknown as { _load: (...args: unknown[]) => unknown };
  const original = moduleInternals._load;
  const previousReact = (globalThis as { React?: unknown }).React;
  const {
    preview,
    resolution,
    resolutionController,
    reportController = null,
    serverController = null,
    serverState = null,
    commitController = null,
    commitState = null,
  } = options;
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
            if (stateCall === 4) return [serverState, () => {}];
            return [commitState, () => {}];
          },
          useRef: () => {
            refCall += 1;
            if (refCall === 1) return { current: null };
            if (refCall === 2) return { current: null };
            if (refCall === 3) return { current: resolutionController };
            if (refCall === 4) return { current: reportController };
            if (refCall === 5) return { current: serverController };
            if (refCall === 6) return { current: commitController };
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

const PANEL_CSV = CLEAN_CSV;

/** The decision seam the panel dispatches into: it only has to answer with a model. */
const resolutionSeamFor = (model: ImportResolutionState) => ({
  clear: () => {},
  include: () => ({ ok: true, state: model }),
  exclude: () => ({ ok: true, state: model }),
  reset: () => {},
  getState: () => model,
  subscribe: () => () => {},
});

/** A live import seam wired to a recording transport, exactly as the panel builds it. */
const liveImportSeam = () => {
  const { transport, calls } = recordingTransport();
  const source = sequentialKeys();
  const controller = createImportCommitController({ commit: transport, createKey: source.createKey });
  return { controller, calls };
};

test("component: the import block renders with a live seam", async () => {
  const preview = await previewStateFrom(PANEL_CSV);
  const model = modelOf(PANEL_CSV);
  const { controller: commit } = liveImportSeam();
  try {
    const { html, controls } = await renderPanel({
      preview,
      resolution: model,
      resolutionController: resolutionSeamFor(model),
      serverController: createServerResolutionController({ resolve: async () => clearResultFor([]) }),
      serverState: null,
      commitController: commit,
      commitState: commit.getState(),
    });
    assert.match(html, /تأكيد إدخال الطلاب/);
    const control = controls.find((entry) => entry.text.includes("تأكيد إدخال الطلاب"));
    assert.ok(control, "the confirmation control must exist");
    assert.equal(control!.type, "button", "an import confirmation must never submit a form");
  } finally {
    commit.dispose();
  }
});

test("component: the import block is absent without a live seam", async () => {
  const preview = await previewStateFrom(PANEL_CSV);
  const model = modelOf(PANEL_CSV);
  const { controls } = await renderPanel({
    preview,
    resolution: model,
    resolutionController: resolutionSeamFor(model),
    serverController: null,
    serverState: null,
    commitController: null,
    commitState: null,
  });
  // The introductory paragraph mentions the control by name; the CONTROL itself
  // is what must not exist.
  assert.equal(
    controls.some((entry) => entry.text.includes("تأكيد إدخال الطلاب")),
    false,
    "a panel with no import seam offers no confirmation",
  );
  assert.equal(controls.some((entry) => entry.text.includes("إعادة المحاولة بنفس الدفعة")), false);
});

test("component: a ref that is not the real seam never receives a confirmation", async () => {
  const preview = await previewStateFrom(PANEL_CSV);
  const model = modelOf(PANEL_CSV);
  // A look-alike object without the real methods: the method-checked seam must
  // refuse it, so the button cannot fire a confirmation into nothing.
  const { controls } = await renderPanel({
    preview,
    resolution: model,
    resolutionController: resolutionSeamFor(model),
    commitController: { confirm: "not-a-function", clear: () => {}, dispose: () => {} },
    commitState: null,
  });
  assert.equal(controls.some((entry) => entry.text.includes("تأكيد إدخال الطلاب")), false);
});

test("component: the panel states student records only, with no login, enrollment or access", async () => {
  const preview = await previewStateFrom(PANEL_CSV);
  const model = modelOf(PANEL_CSV);
  const { controller: commit } = liveImportSeam();
  try {
    const { html } = await renderPanel({
      preview,
      resolution: model,
      resolutionController: resolutionSeamFor(model),
      commitController: commit,
      commitState: commit.getState(),
    });
    assert.match(html, /سجلات طلاب فقط/);
    assert.match(html, /لا يُنشأ حساب ولا تسجيل دخول ولا كلمة مرور ولا دعوة ولا OTP/);
    assert.match(html, /ولا تسجيل في مجموعة أو دورة أو فرع/);
    assert.match(html, /لا يُرسل شيء تلقائيًا/);
  } finally {
    commit.dispose();
  }
});

test("component: the confirmation is disabled without a fresh reconciliation and says why", async () => {
  const preview = await previewStateFrom(PANEL_CSV);
  const model = modelOf(PANEL_CSV);
  const { controller: commit } = liveImportSeam();
  try {
    const { controls } = await renderPanel({
      preview,
      resolution: model,
      resolutionController: resolutionSeamFor(model),
      serverController: null,
      serverState: null,
      commitController: commit,
      commitState: commit.getState(),
    });
    const control = controls.find((entry) => entry.text.includes("تأكيد إدخال الطلاب"));
    assert.ok(control);
    assert.equal(control!.disabled, true, "no reconciliation means no confirmation");
  } finally {
    commit.dispose();
  }
});

test("component: a fresh all-clear reconciliation enables the confirmation", async () => {
  const preview = await previewStateFrom(PANEL_CSV);
  const model = modelOf(PANEL_CSV);
  const { controller: commit } = liveImportSeam();
  const server = createServerResolutionController({ resolve: async () => clearResultFor([]) });
  try {
    const ready: ServerResolutionState = {
      phase: "ready",
      result: clearResultFor(CLEAN_ROWS),
      message: null,
      revision: 1,
    };
    const { controls } = await renderPanel({
      preview,
      resolution: model,
      resolutionController: resolutionSeamFor(model),
      serverController: server,
      serverState: ready,
      commitController: commit,
      commitState: commit.getState(),
    });
    const control = controls.find((entry) => entry.text.includes("تأكيد إدخال الطلاب"));
    assert.ok(control);
    assert.equal(control!.disabled, false, "the current decisions and a fresh all-clear answer enable it");
  } finally {
    commit.dispose();
    server.dispose();
  }
});

test("component: a pending row disables the confirmation and names it", async () => {
  const preview = await previewStateFrom(PENDING_CSV);
  const model = modelOf(PENDING_CSV);
  const { controller: commit } = liveImportSeam();
  const server = createServerResolutionController({ resolve: async () => clearResultFor([]) });
  try {
    const ready: ServerResolutionState = {
      phase: "ready",
      result: clearResultFor([2, 3]),
      message: null,
      revision: 1,
    };
    const { html } = await renderPanel({
      preview,
      resolution: model,
      resolutionController: resolutionSeamFor(model),
      serverController: server,
      serverState: ready,
      commitController: commit,
      commitState: commit.getState(),
    });
    assert.match(html, /توجد صفوف قيد الانتظار/);
  } finally {
    commit.dispose();
    server.dispose();
  }
});

test("component: an existing match disables the confirmation and names the affected rows", async () => {
  const preview = await previewStateFrom(PANEL_CSV);
  const model = modelOf(PANEL_CSV);
  const { controller: commit } = liveImportSeam();
  const server = createServerResolutionController({ resolve: async () => clearResultFor([]) });
  try {
    const matched: ServerResolutionState = {
      phase: "ready",
      result: {
        rows: [{ row_number: 2, matched_fields: ["email"] }, { row_number: 3, matched_fields: [] }],
        summary: { checked: 2, matched: 1, clear: 1 },
      },
      message: null,
      revision: 1,
    };
    const { html, controls } = await renderPanel({
      preview,
      resolution: model,
      resolutionController: resolutionSeamFor(model),
      serverController: server,
      serverState: matched,
      commitController: commit,
      commitState: commit.getState(),
    });
    assert.match(html, /توجد قيم موجودة مسبقًا/);
    assert.match(html, /الصفوف المتأثرة: 2/);
    const control = controls.find((entry) => entry.text.includes("تأكيد إدخال الطلاب"));
    assert.equal(control!.disabled, true);
  } finally {
    commit.dispose();
    server.dispose();
  }
});

test("component: rendering the panel alone submits nothing", async () => {
  const preview = await previewStateFrom(PANEL_CSV);
  const model = modelOf(PANEL_CSV);
  const { controller: commit, calls } = liveImportSeam();
  const server = createServerResolutionController({ resolve: async () => clearResultFor([]) });
  try {
    const ready: ServerResolutionState = {
      phase: "ready",
      result: clearResultFor(CLEAN_ROWS),
      message: null,
      revision: 1,
    };
    await renderPanel({
      preview,
      resolution: model,
      resolutionController: resolutionSeamFor(model),
      serverController: server,
      serverState: ready,
      commitController: commit,
      commitState: commit.getState(),
    });
    await flush();
    assert.equal(calls.length, 0, "nothing may be sent before an explicit click");
  } finally {
    commit.dispose();
    server.dispose();
  }
});

test("component: clicking the confirmation submits exactly one batch of seven-key rows", async () => {
  const preview = await previewStateFrom(PANEL_CSV);
  const model = modelOf(PANEL_CSV);
  const { controller: commit, calls } = liveImportSeam();
  const server = createServerResolutionController({ resolve: async () => clearResultFor([]) });
  try {
    const ready: ServerResolutionState = {
      phase: "ready",
      result: clearResultFor(CLEAN_ROWS),
      message: null,
      revision: 1,
    };
    const { controls } = await renderPanel({
      preview,
      resolution: model,
      resolutionController: resolutionSeamFor(model),
      serverController: server,
      serverState: ready,
      commitController: commit,
      commitState: commit.getState(),
    });
    const control = controls.find((entry) => entry.text.includes("تأكيد إدخال الطلاب"));
    assert.ok(control);
    control!.onClick();
    await flush();
    await flush();
    assert.equal(calls.length, 1, "one explicit click is exactly one submission");
    assert.deepEqual(calls[0].request.rows.map((row) => row.row_number), CLEAN_ROWS);
    for (const row of calls[0].request.rows) {
      assert.deepEqual(Object.keys(row), [...IMPORT_COMMIT_ROW_KEYS]);
    }
  } finally {
    commit.dispose();
    server.dispose();
  }
});

test("component: the batch size badge reports the confirmable row count", async () => {
  const preview = await previewStateFrom(PANEL_CSV);
  const model = modelOf(PANEL_CSV);
  const { controller: commit } = liveImportSeam();
  try {
    const { html } = await renderPanel({
      preview,
      resolution: model,
      resolutionController: resolutionSeamFor(model),
      commitController: commit,
      commitState: commit.getState(),
    });
    assert.match(html, /الدفعة: 2/);
  } finally {
    commit.dispose();
  }
});

test("component: a failed phase offers an explicit retry with the same batch", async () => {
  const preview = await previewStateFrom(PANEL_CSV);
  const model = modelOf(PANEL_CSV);
  const { controller: commit } = liveImportSeam();
  try {
    const failed: ImportCommitState = {
      phase: "failed",
      result: null,
      message: IMPORT_COMMIT_MESSAGES.failed,
      revision: 2,
    };
    const { html, controls } = await renderPanel({
      preview,
      resolution: model,
      resolutionController: resolutionSeamFor(model),
      commitController: commit,
      commitState: failed,
    });
    const retry = controls.find((entry) => entry.text.includes("إعادة المحاولة بنفس الدفعة"));
    assert.ok(retry, "an uncertain outcome must offer an explicit same-batch retry");
    assert.equal(retry!.type, "button");
    assert.match(html, /لم يُعرف هل تمّ الإدخال/);
  } finally {
    commit.dispose();
  }
});

test("component: a committed phase reports the recorded result without any private value", async () => {
  const preview = await previewStateFrom(PANEL_CSV);
  const model = modelOf(PANEL_CSV);
  const { controller: commit } = liveImportSeam();
  try {
    const committed: ImportCommitState = {
      phase: "committed",
      result: { batch_id: "9d4b1f2c-6a3e-4c8d-9e5f-1a2b3c4d5e6f", replayed: false, created: 2, row_numbers: CLEAN_ROWS },
      message: null,
      revision: 2,
    };
    const { html } = await renderPanel({
      preview,
      resolution: model,
      resolutionController: resolutionSeamFor(model),
      commitController: commit,
      commitState: committed,
    });
    assert.match(html, /تم إدخال: 2/);
    assert.match(html, /دفعة جديدة/);
    assert.match(html, /الصفوف المُدخلة: 2، 3/);
    assert.match(html, /لا حساب ولا وصول/);
    // The private values of the file are never echoed into the import result.
    assert.equal(/a@b\.c/.test(html), true, "the file values render in the TABLE, as accepted");
  } finally {
    commit.dispose();
  }
});

test("component: a submitting phase shows the in-flight notice", async () => {
  const preview = await previewStateFrom(PANEL_CSV);
  const model = modelOf(PANEL_CSV);
  const { controller: commit } = liveImportSeam();
  try {
    const submitting: ImportCommitState = { phase: "submitting", result: null, message: null, revision: 1 };
    const { html } = await renderPanel({
      preview,
      resolution: model,
      resolutionController: resolutionSeamFor(model),
      commitController: commit,
      commitState: submitting,
    });
    assert.match(html, /جارٍ إدخال الدفعة/);
  } finally {
    commit.dispose();
  }
});

test("component: the accepted preview, decision, reconciliation, report and close controls survive", async () => {
  const preview = await previewStateFrom(PANEL_CSV);
  const model = modelOf(PANEL_CSV);
  const { controller: commit } = liveImportSeam();
  const server = createServerResolutionController({ resolve: async () => clearResultFor([]) });
  try {
    const { controls, submits } = await renderPanel({
      preview,
      resolution: model,
      resolutionController: resolutionSeamFor(model),
      serverController: server,
      serverState: null,
      commitController: commit,
      commitState: commit.getState(),
    });
    // The accepted reconciliation control.
    const reconcile = controls.find((entry) => entry.text.includes("مطابقة الصفوف المُدرجة"));
    assert.ok(reconcile, "the accepted reconciliation control must survive");
    assert.equal(reconcile!.type, "button");
    // The accepted report control.
    const report = controls.find((entry) => entry.text.includes("تنزيل تقرير الصفوف غير المُدرجة"));
    assert.ok(report, "the accepted report control must survive");
    assert.equal(report!.type, "button");
    // The accepted close control, always enabled: the absence of the disabled
    // prop is what the accepted suites assert for it.
    const close = controls.find((entry) => entry.text.includes("إغلاق المعاينة"));
    assert.ok(close, "the accepted close control must survive");
    assert.equal(close!.type, "button");
    assert.equal(close!.disabled, undefined, "the user can always close the panel");
    // The accepted decision controls.
    assert.ok(controls.some((entry) => entry.text.includes("إدراج")), "the include decision must survive");
    assert.ok(controls.some((entry) => entry.text.includes("استبعاد")), "the exclude decision must survive");
    // Nothing in the panel may submit a form.
    assert.deepEqual(submits, [], "no control in this panel may submit a form");
  } finally {
    commit.dispose();
    server.dispose();
  }
});

test("component: the confirmation is latched while a submission is in flight", async () => {
  const preview = await previewStateFrom(PANEL_CSV);
  const model = modelOf(PANEL_CSV);
  // A REAL in-flight submission through the REAL controller, so the busy latch
  // the panel reads is the latch the controller actually owns.
  const gate = deferred<{ status: number; body: unknown }>();
  const calls: RecordedCall[] = [];
  const commit = createImportCommitController({
    commit: async (request) => {
      calls.push({ request, key: request.idempotency_key });
      return gate.promise;
    },
    createKey: sequentialKeys().createKey,
  });
  const server = createServerResolutionController({ resolve: async () => clearResultFor([]) });
  try {
    const ready: ServerResolutionState = {
      phase: "ready",
      result: clearResultFor(CLEAN_ROWS),
      message: null,
      revision: 1,
    };
    const pending = commit.confirm(model.rows, ready.result);
    await flush();
    assert.equal(commit.getState().phase, "submitting");
    const { controls, html } = await renderPanel({
      preview,
      resolution: model,
      resolutionController: resolutionSeamFor(model),
      serverController: server,
      serverState: ready,
      commitController: commit,
      commitState: commit.getState(),
    });
    assert.match(html, /جارٍ إدخال الدفعة/);
    const control = controls.find((entry) => entry.text.includes("تأكيد إدخال الطلاب"));
    assert.ok(control);
    assert.equal(control!.disabled, true, "a submission in flight latches the confirmation");
    // No retry control exists while the first attempt is still on the wire.
    assert.equal(controls.some((entry) => entry.text.includes("إعادة المحاولة بنفس الدفعة")), false);
    control!.onClick();
    await flush();
    assert.equal(calls.length, 1, "a latched click must not race the submission in flight");
    gate.resolve({ status: 200, body: commitEnvelopeFor(CLEAN_ROWS) });
    await pending;
  } finally {
    commit.dispose();
    server.dispose();
  }
});

test("component: the import block is absent without a decision model", async () => {
  const preview = await previewStateFrom(PANEL_CSV);
  const model = modelOf(PANEL_CSV);
  const { controller: commit } = liveImportSeam();
  try {
    const { controls } = await renderPanel({
      preview,
      resolution: null,
      resolutionController: resolutionSeamFor(model),
      commitController: commit,
      commitState: commit.getState(),
    });
    assert.equal(
      controls.some((entry) => entry.text.includes("تأكيد إدخال الطلاب")),
      false,
      "no decision model means no batch to confirm",
    );
  } finally {
    commit.dispose();
  }
});

test("component: a refused gate never presents its count as confirmable", async () => {
  const preview = await previewStateFrom(PANEL_CSV);
  const model = modelOf(PANEL_CSV);
  const { controller: commit } = liveImportSeam();
  try {
    // A stale reconciliation answers only row 2: the gate refuses, and the badge
    // falls back to the INCLUDED count while the stated reason beside it makes
    // clear that nothing is confirmable yet. The number is never the promise.
    const stale: ServerResolutionState = {
      phase: "ready",
      result: clearResultFor([2]),
      message: null,
      revision: 1,
    };
    const { html, controls } = await renderPanel({
      preview,
      resolution: model,
      resolutionController: resolutionSeamFor(model),
      commitController: commit,
      commitState: commit.getState(),
      serverState: stale,
      serverController: createServerResolutionController({ resolve: async () => clearResultFor([]) }),
    });
    assert.match(html, /الدفعة: 2/);
    assert.match(html, /المطابقة الحالية لا تغطي الصفوف المُدرجة الآن بالضبط/);
    const control = controls.find((entry) => entry.text.includes("تأكيد إدخال الطلاب"));
    assert.equal(control!.disabled, true, "the refusal keeps the confirmation closed");
  } finally {
    commit.dispose();
  }
});

test("component: a retired import answer leaves no result on screen", async () => {
  const preview = await previewStateFrom(PANEL_CSV);
  const model = modelOf(PANEL_CSV);
  const { controller: commit } = liveImportSeam();
  try {
    // The panel renders the CLEARED state after a file/decision/reconciliation
    // change: a retired answer must never paint a result.
    const { html } = await renderPanel({
      preview,
      resolution: model,
      resolutionController: resolutionSeamFor(model),
      commitController: commit,
      commitState: initialImportCommitState(),
    });
    assert.equal(/تم إدخال/.test(html), false);
    assert.equal(/نتيجة مسجّلة سابقًا/.test(html), false);
  } finally {
    commit.dispose();
  }
});





