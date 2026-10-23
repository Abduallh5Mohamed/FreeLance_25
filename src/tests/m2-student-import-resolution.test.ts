/**
 * M2-11 local CSV duplicate review + JSON rejected-row report — isolated
 * production-path tests (node:test + tsx).
 *
 * Scope: the REAL accepted parser (`parseStudentCsv`), the REAL M2-11 decision
 * model and lifecycle (`src/features/students/import-resolution.ts`), the REAL
 * M2-11 report seam (`src/features/students/import-report.ts`) and the REAL
 * `StudentImportPreview` component with its ACTUAL control callbacks — all
 * imported unchanged. Fully isolated: no DB, no network, no browser, no real
 * download, no storage, no dependency install.
 *
 * Behaviours pinned:
 *  - the initial decisions are the honest ones: an invalid row is never
 *    includable, a duplicate candidate starts PENDING (never first-wins) and an
 *    issue-free non-duplicate row starts included;
 *  - the counts are mutually exclusive and always sum to the row total;
 *  - inclusion collisions use the accepted EXACT trimmed nonempty key semantics
 *    on phone/email/barcode: case, leading zeros and `+` are preserved, blanks
 *    never match, and a collision is refused with the ACTUAL row numbers while
 *    the previous decisions are preserved;
 *  - an overlapping candidate CHAIN across different fields resolves correctly,
 *    because the conflict scan is whole-file and never limited to adjacent rows
 *    or the visible page;
 *  - a decision is keyed by the stable physical row identity, not the display
 *    index, so paging cannot re-target it;
 *  - the model fails closed on a repeated row identity or an over-bound file;
 *  - a session/principal change, a clear and a disposal drop every decision;
 *  - the report carries EXACTLY the non-included rows, with physical row
 *    numbers, the permitted field text verbatim and documented reasons;
 *  - the report is deterministic JSON, formula-looking text stays inert, and
 *    the size gate runs BEFORE any Blob or object URL exists;
 *  - exactly one object URL and one link per click, removed and revoked on
 *    success, failure, replacement and disposal — never leaked;
 *  - the real component renders the decision layer only with a live model, the
 *    report control is disabled when nothing is non-included, and its decision,
 *    reset and report callbacks act on the real seams.
 *
 * Not proven here: real browser download behaviour, DOM paint, RTL layout, a
 * server import (none exists in this batch) and any platform uniqueness claim.
 */
import assert from "node:assert/strict";
import test from "node:test";
import Module from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  STUDENT_CSV_MAX_RECORDS,
  parseStudentCsv,
  type StudentCsvRow,
  type StudentCsvPreviewState,
  createStudentCsvPreviewController,
} from "../features/students/csv-preview";
import {
  IMPORT_RESOLUTION_VERSION,
  SERVER_MATCH_REVIEW_STATES,
  applyImportDecision,
  clearServerMatches,
  computeBlockingConflicts,
  createImportResolutionController,
  currentServerMatchReview,
  excludeServerMatch,
  findImportConflicts,
  initialImportResolutionState,
  keepServerMatch,
  loadImportResolution,
  nonIncludedCount,
  resetImportResolution,
  seedServerMatches,
  undoServerMatch,
  type ImportResolutionState,
} from "../features/students/import-resolution";
import {
  SERVER_RESOLUTION_FIELDS,
  createServerResolutionController,
  type ServerResolutionField,
  type ServerResolutionResult,
} from "../features/students/server-resolution";
import {
  IMPORT_REPORT_FILENAME,
  IMPORT_REPORT_KIND,
  IMPORT_REPORT_MAX_BYTES,
  IMPORT_REPORT_VERSION,
  buildImportReport,
  createImportReportController,
  type ImportReportEnvironment,
  type ImportReportLink,
} from "../features/students/import-report";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const flush = (): Promise<void> => new Promise<void>((resolve) => setImmediate(resolve));

/** Parses a fixture with the REAL parser and fails loudly if it is invalid. */
const parsedRows = (csv: string): StudentCsvRow[] => {
  const parsed = parseStudentCsv(csv);
  if (parsed.ok !== true) {
    throw new Error(`fixture must parse: ${JSON.stringify(parsed.error)}`);
  }
  return parsed.rows;
};

/** Loads a fixture into a fresh decision model. */
const modelOf = (csv: string): ImportResolutionState => loadImportResolution(parsedRows(csv));

const statusOf = (state: ImportResolutionState, rowNumber: number): string =>
  state.rows.find((row) => row.rowNumber === rowNumber)?.status ?? "missing";

/** A synthetic row, for the bounds that a real parser can never produce. */
const syntheticRow = (overrides: Partial<StudentCsvRow> = {}): StudentCsvRow => ({
  rowNumber: 2,
  rowIndex: 1,
  name: "Ali",
  email: "",
  phone: "",
  guardian_phone: "",
  grade: "",
  barcode: "",
  issues: [],
  duplicates: [],
  ...overrides,
});

/**
 * A confirmed M2-14 result built by hand.
 *
 * The review model only ever reads the documented `rows` / `summary` shape, so
 * this fixture involves no transport, no parser and no network. The summary is
 * derived from the rows so it always balances.
 */
const serverResult = (
  entries: readonly (readonly [number, readonly ServerResolutionField[]])[],
): ServerResolutionResult => {
  const rows = entries.map(([rowNumber, fields]) => ({
    row_number: rowNumber,
    matched_fields: fields.slice(),
  }));
  const matched = rows.filter((row) => row.matched_fields.length > 0).length;
  return { rows, summary: { checked: rows.length, matched, clear: rows.length - matched } };
};

/** The captured browser boundary: every call is recorded, nothing is real. */
interface ReportEnvHarness {
  env: ImportReportEnvironment;
  created: Blob[];
  urls: string[];
  revoked: string[];
  links: {
    href: string;
    download: string;
    rel: string;
    clicked: number;
    removed: number;
  }[];
  scheduled: (() => void)[];
  runScheduled: () => void;
  failOnCreate: boolean;
}

const createReportEnv = (): ReportEnvHarness => {
  const harness: ReportEnvHarness = {
    created: [],
    urls: [],
    revoked: [],
    links: [],
    scheduled: [],
    failOnCreate: false,
    runScheduled: () => {
      const tasks = harness.scheduled.slice();
      harness.scheduled.length = 0;
      for (const task of tasks) task();
    },
    env: {
      createObjectURL: (blob: Blob) => {
        if (harness.failOnCreate) throw new Error("createObjectURL unavailable");
        harness.created.push(blob);
        const url = `blob:test/${harness.urls.length + 1}`;
        harness.urls.push(url);
        return url;
      },
      revokeObjectURL: (url: string) => {
        harness.revoked.push(url);
      },
      createLink: (): ImportReportLink => {
        const record = { href: "", download: "", rel: "", clicked: 0, removed: 0 };
        harness.links.push(record);
        return {
          get href() { return record.href; },
          set href(value: string) { record.href = value; },
          get download() { return record.download; },
          set download(value: string) { record.download = value; },
          get rel() { return record.rel; },
          set rel(value: string) { record.rel = value; },
          click: () => { record.clicked += 1; },
          remove: () => { record.removed += 1; },
        };
      },
      schedule: (task: () => void) => {
        harness.scheduled.push(task);
      },
    },
  };
  return harness;
};

// ===========================================================================
// The model: initial decisions and truthful counts
// ===========================================================================

test("model: a duplicate starts pending, an issue makes a row invalid, a clean row starts included", () => {
  const state = modelOf(
    "name,phone,email\nAli,0100,a@b.c\nSara,0100,d@e.f\nOmar,0300,o@b.c\n,0400,x@y.z\n",
  );

  assert.equal(statusOf(state, 2), "pending", "a duplicate candidate is never decided for the user");
  assert.equal(statusOf(state, 3), "pending");
  assert.equal(statusOf(state, 4), "included", "a clean row collides with nothing in this file");
  assert.equal(statusOf(state, 5), "invalid", "a missing name makes the row non-includable");

  assert.deepEqual(state.counts, {
    total: 4,
    included: 1,
    excluded: 0,
    pending: 2,
    invalid: 1,
  });
  assert.equal(nonIncludedCount(state.counts), 3);
  assert.equal(state.version, IMPORT_RESOLUTION_VERSION);
  assert.equal(state.loaded, true);
});

test("model: the four counts are mutually exclusive and always sum to the total", () => {
  const state = modelOf(
    "name,phone,email\nAli,0100,a@b.c\nSara,0100,d@e.f\nOmar,0300,o@b.c\n,0400,x@y.z\n",
  );
  const { total, included, excluded, pending, invalid } = state.counts;
  assert.equal(included + excluded + pending + invalid, total);
  assert.equal(state.rows.length, total);
});

test("model: the duplicate comparison is exact after trim, and preserves case and leading zeros", () => {
  // A padded value is the SAME value: the parser trims it before the comparison.
  const padded = modelOf("name,phone,email\nA, 0100 ,x@y.z\nB,0100,y@z.w\n");
  assert.equal(statusOf(padded, 2), "pending");
  assert.equal(statusOf(padded, 3), "pending");

  // Case is preserved: two different spellings are NOT a duplicate.
  const cased = modelOf("name,phone,email\nA,0100,X@Y.Z\nB,0200,x@y.z\n");
  assert.equal(statusOf(cased, 2), "included");
  assert.equal(statusOf(cased, 3), "included");
  assert.equal(cased.counts.pending, 0);

  // Leading zeros are preserved: 007 and 7 are different values.
  const zeros = modelOf("name,phone,email\nA,007,e@x.y\nB,7,f@x.y\n");
  assert.equal(statusOf(zeros, 2), "included");
  assert.equal(statusOf(zeros, 3), "included");
});

test("model: a blank value never matches another blank value", () => {
  const state = modelOf("name,phone,email\nA,,\nB,,\n");
  assert.equal(statusOf(state, 2), "included");
  assert.equal(statusOf(state, 3), "included");
  assert.equal(state.counts.pending, 0);
});

// ===========================================================================
// The model: explicit decisions and whole-file conflicts
// ===========================================================================

test("model: an invalid row can never be included", () => {
  const state = modelOf("name,phone\nAli,0100\n,0200\n");
  const result = applyImportDecision(state, 3, "include");
  assert.equal(result.ok, false);
  assert.equal(result.reason, "invalid-row");
  assert.equal(result.state.refusal?.reason, "invalid-row");
  assert.equal(statusOf(result.state, 3), "invalid", "the row is unchanged");
});

test("model: a conflicting inclusion is refused with the actual row numbers and changes nothing", () => {
  const state = modelOf("name,phone,email\nAli,0100,a@b.c\nSara,0100,d@e.f\n");
  const first = applyImportDecision(state, 2, "include");
  assert.equal(first.ok, true);
  assert.equal(statusOf(first.state, 2), "included");

  const second = applyImportDecision(first.state, 3, "include");
  assert.equal(second.ok, false);
  assert.equal(second.reason, "conflict");
  assert.deepEqual(second.conflicts, [
    { field: "phone", value: "0100", rowNumbers: [2] },
  ]);
  // The refusal names the real rows and preserves the previous decision.
  assert.equal(statusOf(second.state, 2), "included", "the earlier decision survives");
  assert.equal(statusOf(second.state, 3), "pending", "the refused row is untouched");
  assert.equal(second.state.refusal?.rowNumber, 3);
});

test("model: an overlapping candidate CHAIN across two fields resolves step by step", () => {
  // Line 2 collides with 3 on phone; line 3 also collides with 4 on email.
  // The chain can only be resolved by an explicit exclusion, never by adjacency.
  const state = modelOf(
    "name,phone,email\nA,0100,x@y.z\nB,0100,m@n.o\nC,0200,m@n.o\n",
  );
  assert.equal(statusOf(state, 2), "pending");
  assert.equal(statusOf(state, 3), "pending");
  assert.equal(statusOf(state, 4), "pending");

  const a = applyImportDecision(state, 2, "include");
  assert.equal(a.ok, true, "A is the first of its group, so nothing blocks it");

  const bBlocked = applyImportDecision(a.state, 3, "include");
  assert.equal(bBlocked.ok, false);
  assert.deepEqual(bBlocked.conflicts, [{ field: "phone", value: "0100", rowNumbers: [2] }]);

  const aOut = applyImportDecision(bBlocked.state, 2, "exclude");
  assert.equal(aOut.ok, true);

  const b = applyImportDecision(aOut.state, 3, "include");
  assert.equal(b.ok, true, "B is includable once its phone conflict is gone");

  // B now blocks C on EMAIL: the second link of the chain.
  const cBlocked = applyImportDecision(b.state, 4, "include");
  assert.equal(cBlocked.ok, false);
  assert.deepEqual(cBlocked.conflicts, [{ field: "email", value: "m@n.o", rowNumbers: [3] }]);

  const bOut = applyImportDecision(cBlocked.state, 3, "exclude");
  const c = applyImportDecision(bOut.state, 4, "include");
  assert.equal(c.ok, true, "C is includable once B is excluded");

  assert.deepEqual(c.state.counts, {
    total: 3,
    included: 1,
    excluded: 2,
    pending: 0,
    invalid: 0,
  });
});

test("model: an excluded row can be re-included once its conflicts are removed", () => {
  const state = modelOf("name,phone,email\nAli,0100,a@b.c\nSara,0100,d@e.f\n");
  const included = applyImportDecision(state, 2, "include");
  assert.equal(included.ok, true);

  const excluded = applyImportDecision(included.state, 2, "exclude");
  assert.equal(excluded.ok, true);
  assert.equal(statusOf(excluded.state, 2), "excluded");

  const again = applyImportDecision(excluded.state, 2, "include");
  assert.equal(again.ok, true);
  assert.equal(statusOf(again.state, 2), "included");
});

test("model: an issue-free non-duplicate row can be excluded and re-included", () => {
  const state = modelOf("name,phone\nAli,0100\nSara,0200\n");
  assert.equal(statusOf(state, 2), "included");

  const excluded = applyImportDecision(state, 2, "exclude");
  assert.equal(excluded.ok, true);
  assert.equal(statusOf(excluded.state, 2), "excluded");
  assert.equal(excluded.state.counts.excluded, 1);

  const included = applyImportDecision(excluded.state, 2, "include");
  assert.equal(included.ok, true);
  assert.equal(statusOf(included.state, 2), "included");
});

test("model: an unknown row is refused without touching the state", () => {
  const state = modelOf("name,phone\nAli,0100\n");
  const result = applyImportDecision(state, 99, "include");
  assert.equal(result.ok, false);
  assert.equal(result.reason, "unknown-row");
  assert.deepEqual(result.state.counts, state.counts);
});

test("model: reset restores the initial decisions of the same file", () => {
  const state = modelOf("name,phone,email\nAli,0100,a@b.c\nSara,0100,d@e.f\n");
  const changed = applyImportDecision(applyImportDecision(state, 2, "exclude").state, 3, "exclude");
  assert.equal(changed.state.counts.excluded, 2);

  const reset = resetImportResolution(changed.state);
  assert.equal(statusOf(reset, 2), "pending");
  assert.equal(statusOf(reset, 3), "pending");
  assert.equal(reset.counts.pending, 2);
  assert.equal(reset.refusal, null);
  assert.equal(reset.revision, changed.state.revision + 1);
});

test("model: the conflict scan covers the WHOLE file, not the visible page", () => {
  // 30 rows: the collision is between the FIRST and the LAST row, so a page of
  // 25 can never see both.
  const lines = ["name,phone"];
  for (let index = 0; index < 28; index += 1) lines.push(`Row${index},0${index}`);
  lines.push("Last,0999");
  lines.push("Tail,0999");
  const state = modelOf(`${lines.join("\n")}\n`);

  const last = state.rows[state.rows.length - 2];
  const tail = state.rows[state.rows.length - 1];
  assert.equal(last.rowNumber, 30);
  assert.equal(tail.rowNumber, 31);

  const included = applyImportDecision(state, 30, "include");
  assert.equal(included.ok, true);
  const blocked = applyImportDecision(included.state, 31, "include");
  assert.equal(blocked.ok, false, "the collision is found across the whole file");
  assert.deepEqual(blocked.conflicts, [{ field: "phone", value: "0999", rowNumbers: [30] }]);
});

test("model: decisions are keyed by the physical row number, not the display index", () => {
  const state = modelOf("name,phone\nAli,0100\nSara,0200\nOmar,0300\n");
  const excluded = applyImportDecision(state, 3, "exclude");
  assert.equal(statusOf(excluded.state, 3), "excluded");
  // Row 3 is the SECOND data record: excluding it must not touch record 2.
  assert.equal(statusOf(excluded.state, 2), "included");
  assert.equal(statusOf(excluded.state, 4), "included");
  assert.equal(excluded.state.rows[1].rowIndex, 2);
});

test("model: blocking conflicts are computed in one pass for pending and excluded rows", () => {
  const state = modelOf("name,phone,email\nAli,0100,a@b.c\nSara,0100,d@e.f\nOmar,0300,o@b.c\n");
  const before = computeBlockingConflicts(state);
  assert.equal(before.size, 0, "no included row collides with a pending one yet");

  const included = applyImportDecision(state, 2, "include");
  const after = computeBlockingConflicts(included.state);
  assert.deepEqual(after.get(3), [{ field: "phone", value: "0100", rowNumbers: [2] }]);
  assert.equal(after.has(4), false, "a clean row has no conflict");

  // An excluded row keeps reporting what blocks its re-inclusion.
  const excluded = applyImportDecision(included.state, 3, "exclude");
  assert.deepEqual(computeBlockingConflicts(excluded.state).get(3), [
    { field: "phone", value: "0100", rowNumbers: [2] },
  ]);
});

test("model: findImportConflicts never reports the row itself", () => {
  const state = modelOf("name,phone\nAli,0100\nSara,0100\n");
  assert.deepEqual(findImportConflicts(state, 2), [], "no included row exists yet");
  const included = applyImportDecision(state, 2, "include");
  assert.deepEqual(findImportConflicts(included.state, 2), [], "a row never conflicts with itself");
});

// ===========================================================================
// The model: bounds and lifecycle
// ===========================================================================

test("model: a repeated physical row identity fails closed", () => {
  const duplicated = loadImportResolution([
    syntheticRow({ rowNumber: 2, rowIndex: 1 }),
    syntheticRow({ rowNumber: 2, rowIndex: 2 }),
  ]);
  assert.equal(duplicated.loaded, false);
  assert.deepEqual(duplicated.rows, []);
});

test("model: an over-bound file fails closed", () => {
  const rows: StudentCsvRow[] = [];
  for (let index = 0; index <= STUDENT_CSV_MAX_RECORDS; index += 1) {
    rows.push(syntheticRow({ rowNumber: index + 2, rowIndex: index + 1 }));
  }
  const state = loadImportResolution(rows);
  assert.equal(state.loaded, false);
  assert.deepEqual(state.rows, []);
});

test("lifecycle: load, reset and clear move the published state", () => {
  const controller = createImportResolutionController({});
  const seen: ImportResolutionState[] = [];
  controller.subscribe((state) => seen.push(state));
  try {
    assert.equal(controller.getState().loaded, false);

    controller.load(parsedRows("name,phone\nAli,0100\nSara,0200\n"));
    assert.equal(controller.getState().loaded, true);
    assert.equal(controller.getState().counts.total, 2);

    controller.exclude(2);
    assert.equal(controller.getState().counts.excluded, 1);

    controller.reset();
    assert.equal(controller.getState().counts.excluded, 0);

    controller.clear();
    assert.equal(controller.getState().loaded, false);
    assert.deepEqual(controller.getState().rows, []);
    assert.ok(seen.length >= 4, "every transition was published");
  } finally {
    controller.dispose();
  }
});

test("lifecycle: a session change drops every decision", () => {
  let fire: (() => void) | null = null;
  const controller = createImportResolutionController({
    readPrincipal: () => "session:a",
    subscribeSession: (listener) => {
      fire = listener;
      return () => { fire = null; };
    },
  });
  try {
    controller.load(parsedRows("name,phone\nAli,0100\nSara,0200\n"));
    controller.exclude(2);
    assert.equal(controller.getState().counts.excluded, 1);

    assert.ok(fire);
    (fire as () => void)();
    assert.equal(controller.getState().loaded, false);
    assert.deepEqual(controller.getState().rows, []);
  } finally {
    controller.dispose();
  }
});

test("lifecycle: a silent principal change clears BEFORE a decision is applied", () => {
  let principal = "session:a";
  const controller = createImportResolutionController({ readPrincipal: () => principal });
  try {
    controller.load(parsedRows("name,phone\nAli,0100\nSara,0200\n"));
    assert.equal(controller.getState().counts.total, 2);

    principal = "session:b";
    const result = controller.include(2);
    // The old scope's rows are gone, so the decision has nothing to land on.
    assert.equal(result.ok, false);
    assert.equal(result.reason, "unknown-row");
    assert.equal(controller.getState().loaded, false);
    assert.deepEqual(controller.getState().rows, []);
  } finally {
    controller.dispose();
  }
});

test("lifecycle: a disposed controller stops publishing and refuses decisions", () => {
  const controller = createImportResolutionController({});
  let publishes = 0;
  controller.subscribe(() => { publishes += 1; });
  controller.load(parsedRows("name,phone\nAli,0100\n"));
  const before = publishes;
  controller.dispose();
  assert.equal(controller.include(2).ok, false);
  assert.equal(publishes, before, "nothing is published after disposal");
});

// ===========================================================================
// The report: exact set, deterministic JSON, inert text
// ===========================================================================

test("report: it carries EXACTLY the non-included rows, in physical order", () => {
  const state = modelOf(
    "name,phone,email\nAli,0100,a@b.c\nSara,0100,d@e.f\n,0300,o@b.c\nOmar,0400,q@r.s\n",
  );
  const built = buildImportReport(state);
  assert.equal(built.ok, true);
  if (!("payload" in built)) return;

  assert.equal(built.payload.report, IMPORT_REPORT_KIND);
  assert.equal(built.payload.version, IMPORT_REPORT_VERSION);
  assert.equal(built.payload.scope, "local-preview");
  assert.deepEqual(built.payload.rows.map((row) => row.rowNumber), [2, 3, 4]);
  assert.deepEqual(built.payload.rows.map((row) => row.status), ["pending", "pending", "invalid"]);
  assert.deepEqual(built.payload.rows[0].reasons, ["duplicate-candidate-pending"]);
  assert.deepEqual(built.payload.rows[2].reasons, ["missing-name"]);
  assert.deepEqual(built.payload.counts, state.counts);

  // The INCLUDED row is never exported.
  assert.equal(built.text.includes("q@r.s"), false, "an included row's values are not exported");
  assert.equal(built.text.includes("Omar"), false);
  assert.equal(built.rowCount, 3);
});

test("report: an excluded row carries its documented reasons and candidates", () => {
  const state = modelOf("name,phone,email\nAli,0100,a@b.c\nSara,0100,d@e.f\n");
  const excluded = applyImportDecision(state, 2, "exclude");
  const built = buildImportReport(excluded.state);
  assert.equal(built.ok, true);
  if (!("payload" in built)) return;

  const row = built.payload.rows.find((candidate) => candidate.rowNumber === 2);
  assert.ok(row);
  assert.equal(row.status, "excluded");
  assert.deepEqual(row.reasons, ["excluded-by-user", "duplicate-candidate"]);
  assert.deepEqual(row.candidates, [{ field: "phone", value: "0100", rowNumbers: [2, 3] }]);
  // The exact permitted field text is copied verbatim.
  assert.equal(row.name, "Ali");
  assert.equal(row.phone, "0100");
  assert.equal(row.email, "a@b.c");
});

test("report: the document is deterministic and keeps a fixed key order", () => {
  const state = modelOf("name,phone\nAli,0100\nSara,0100\n");
  const first = buildImportReport(state);
  const second = buildImportReport(state);
  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  if (!("text" in first) || !("text" in second)) return;
  assert.equal(first.text, second.text, "the same decisions produce the same bytes");

  const parsed = JSON.parse(first.text) as Record<string, unknown>;
  assert.deepEqual(Object.keys(parsed), ["report", "version", "scope", "counts", "rows"]);
  const row = (parsed.rows as Record<string, unknown>[])[0];
  assert.deepEqual(Object.keys(row), [
    "rowNumber",
    "status",
    "name",
    "email",
    "phone",
    "guardian_phone",
    "grade",
    "barcode",
    "reasons",
    // M2-15: the documented match-field names, always present and always after
    // the reasons, so a v2 consumer reads one fixed shape.
    "matched_fields",
    "candidates",
  ]);
});

test("report: formula-looking and markup-looking text stays inert JSON data", () => {
  const csv = [
    "name,phone,email",
    '=cmd|\'/C calc\'!A0,0100,dup@x.y',
    '"<img src=x onerror=alert(1)>",0100,dup@x.y',
  ].join("\n");
  const state = modelOf(`${csv}\n`);
  const built = buildImportReport(state);
  assert.equal(built.ok, true);
  if (!("text" in built)) return;

  const parsed = JSON.parse(built.text) as { rows: { name: string }[] };
  // The values round-trip EXACTLY: they were never evaluated, converted or
  // stripped, and JSON has no formula semantics at all.
  assert.equal(parsed.rows[0].name, "=cmd|'/C calc'!A0");
  assert.equal(parsed.rows[1].name, "<img src=x onerror=alert(1)>");
  // A JSON string literal, not an executable cell.
  assert.ok(built.text.includes('"=cmd|'), "the formula is a quoted JSON string");
});

test("report: quotes, backslashes and newlines are escaped and round-trip", () => {
  const rows = [
    syntheticRow({ rowNumber: 2, rowIndex: 1, name: 'He said "hi"\\ok', issues: [{ code: "missing-name", field: "name", rowNumber: 2 }] }),
  ];
  const state = loadImportResolution(rows);
  const built = buildImportReport(state);
  assert.equal(built.ok, true);
  if (!("text" in built)) return;
  const parsed = JSON.parse(built.text) as { rows: { name: string }[] };
  assert.equal(parsed.rows[0].name, 'He said "hi"\\ok');
});

test("report: an all-included file produces NO report rather than a fake success", () => {
  const state = modelOf("name,phone\nAli,0100\nSara,0200\n");
  const built = buildImportReport(state);
  assert.equal(built.ok, false);
  if (!("reason" in built)) return;
  assert.equal(built.reason, "empty");
});

test("report: an unloaded model produces NO report", () => {
  const built = buildImportReport(initialImportResolutionState());
  assert.equal(built.ok, false);
  if (!("reason" in built)) return;
  assert.equal(built.reason, "not-loaded");
});

test("report: the size gate refuses the document BEFORE any Blob exists", () => {
  const rows: StudentCsvRow[] = [];
  for (let index = 0; index < 900; index += 1) {
    rows.push(syntheticRow({
      rowNumber: index + 2,
      rowIndex: index + 1,
      name: "",
      email: "x".repeat(20000),
      issues: [{ code: "missing-name", field: "name", rowNumber: index + 2 }],
    }));
  }
  const state = loadImportResolution(rows);
  assert.equal(state.counts.invalid, 900);

  const built = buildImportReport(state);
  assert.equal(built.ok, false);
  if (!("reason" in built)) return;
  assert.equal(built.reason, "too-large");
  assert.ok(built.bytes > IMPORT_REPORT_MAX_BYTES, "the measured size exceeds the cap");

  // The same decision set through the seam allocates NOTHING.
  const harness = createReportEnv();
  const controller = createImportReportController(harness.env);
  try {
    const result = controller.download(state);
    assert.equal(result.ok, false);
    if (!("reason" in result)) return;
    assert.equal(result.reason, "too-large");
    assert.equal(harness.created.length, 0, "no Blob was created");
    assert.equal(harness.urls.length, 0, "no object URL was created");
    assert.equal(harness.links.length, 0, "no link was created");
  } finally {
    controller.dispose();
  }
});

// ===========================================================================
// The report seam: resource lifecycle
// ===========================================================================

test("report seam: one click creates one Blob, one URL and one link, then revokes", async () => {
  const state = modelOf("name,phone\nAli,0100\nSara,0100\n");
  const harness = createReportEnv();
  const controller = createImportReportController(harness.env);
  try {
    const result = controller.download(state);
    assert.equal(result.ok, true);
    if (!("url" in result)) return;

    assert.equal(harness.created.length, 1);
    assert.equal(harness.created[0].type, "application/json");
    assert.equal(harness.urls.length, 1);
    assert.equal(harness.links.length, 1);
    assert.equal(harness.links[0].href, result.url);
    assert.equal(harness.links[0].download, IMPORT_REPORT_FILENAME);
    assert.equal(harness.links[0].rel, "noopener");
    assert.equal(harness.links[0].clicked, 1, "the link is clicked exactly once");
    assert.equal(harness.links[0].removed, 1, "the link is removed immediately");
    assert.equal(result.filename, IMPORT_REPORT_FILENAME);
    assert.equal(controller.liveUrl(), result.url, "the URL is still live for one tick");

    // The Blob carries the exact document the build produced.
    const text = await harness.created[0].text();
    assert.equal(text, (buildImportReport(state) as { text: string }).text);

    harness.runScheduled();
    assert.deepEqual(harness.revoked, [result.url], "the URL is revoked exactly once");
    assert.equal(controller.liveUrl(), null);
  } finally {
    controller.dispose();
  }
});

test("report seam: a second click replaces the first URL instead of leaking it", () => {
  const state = modelOf("name,phone\nAli,0100\nSara,0100\n");
  const harness = createReportEnv();
  const controller = createImportReportController(harness.env);
  try {
    const first = controller.download(state);
    const second = controller.download(state);
    assert.equal(first.ok, true);
    assert.equal(second.ok, true);
    if (!("url" in first) || !("url" in second)) return;

    assert.deepEqual(harness.revoked, [first.url], "the replaced URL dies before the new one");
    assert.equal(harness.urls.length, 2);
    assert.equal(harness.links.length, 2);
    assert.equal(controller.liveUrl(), second.url);

    harness.runScheduled();
    assert.deepEqual(harness.revoked, [first.url, second.url]);
    assert.equal(controller.liveUrl(), null);
  } finally {
    controller.dispose();
  }
});

test("report seam: disposal revokes the live URL and never double-revokes", () => {
  const state = modelOf("name,phone\nAli,0100\nSara,0100\n");
  const harness = createReportEnv();
  const controller = createImportReportController(harness.env);
  const result = controller.download(state);
  assert.equal(result.ok, true);
  if (!("url" in result)) return;

  controller.dispose();
  assert.deepEqual(harness.revoked, [result.url]);
  // The scheduled task must not revoke it a second time.
  harness.runScheduled();
  assert.deepEqual(harness.revoked, [result.url], "a URL is revoked at most once");
  assert.equal(controller.liveUrl(), null);

  // A disposed controller produces nothing.
  const after = controller.download(state);
  assert.equal(after.ok, false);
  if (!("reason" in after)) return;
  assert.equal(after.reason, "failed");
});

test("report seam: a failed materialization leaves no URL behind", () => {
  const state = modelOf("name,phone\nAli,0100\nSara,0100\n");
  const harness = createReportEnv();
  harness.failOnCreate = true;
  const controller = createImportReportController(harness.env);
  try {
    const result = controller.download(state);
    assert.equal(result.ok, false);
    if (!("reason" in result)) return;
    assert.equal(result.reason, "failed");
    assert.equal(controller.liveUrl(), null);
    assert.equal(harness.links.length, 0, "no link was created");
    assert.deepEqual(harness.revoked, [], "nothing was allocated, so nothing is revoked");
  } finally {
    controller.dispose();
  }
});

test("report seam: an empty report allocates nothing", () => {
  const state = modelOf("name,phone\nAli,0100\n");
  const harness = createReportEnv();
  const controller = createImportReportController(harness.env);
  try {
    const result = controller.download(state);
    assert.equal(result.ok, false);
    if (!("reason" in result)) return;
    assert.equal(result.reason, "empty");
    assert.equal(harness.created.length, 0);
    assert.equal(harness.urls.length, 0);
  } finally {
    controller.dispose();
  }
});

// ===========================================================================
// The real component
// ===========================================================================

const SRC_ROOT = fileURLToPath(new URL("..", import.meta.url));

/** A ready preview state produced by the REAL preview controller. */
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

/** The real change handlers of the rendered tree (the file selection). */
const collectChangeHandlers = (node: unknown, found: ((event: unknown) => void)[] = []): ((event: unknown) => void)[] => {
  if (Array.isArray(node)) {
    node.forEach((child) => { collectChangeHandlers(child, found); });
    return found;
  }
  const element = node as { props?: Record<string, unknown> } | null;
  if (!element?.props) return found;
  if (typeof element.props.onChange === "function") {
    found.push(element.props.onChange as (event: unknown) => void);
  }
  collectChangeHandlers(element.props.children, found);
  return found;
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
 *
 * The M2-15 review layer needs a live server seam to be visible at all, so the
 * last two arguments are optional and default to "no reconciliation": every
 * M2-11 call site keeps rendering exactly what it rendered before.
 */
const renderPanel = async (
  preview: StudentCsvPreviewState,
  resolution: ImportResolutionState | null,
  resolutionController: unknown,
  reportController: unknown,
  serverController: unknown = null,
  serverState: unknown = null,
): Promise<{ html: string; controls: RenderedControl[]; changes: ((event: unknown) => void)[] }> => {
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
      changes: collectChangeHandlers(tree),
    };
  } finally {
    moduleInternals._load = original;
    if (previousReact === undefined) delete (globalThis as { React?: unknown }).React;
    else (globalThis as { React?: unknown }).React = previousReact;
  }
};

const PANEL_CSV = "name,phone,email\nAli,0100,a@b.c\nSara,0100,d@e.f\n,0300,o@b.c\nOmar,0400,q@r.s\n";

test("component: the decision layer renders the counts, the reset and the report control", async () => {
  const preview = await previewStateFrom(PANEL_CSV);
  const controller = createImportResolutionController({});
  controller.load(preview.rows);
  try {
    const { html } = await renderPanel(preview, controller.getState(), controller, null);

    assert.match(html, /مُدرَج: 1/);
    assert.match(html, /مستبعَد: 0/);
    assert.match(html, /قيد الانتظار: 2/);
    assert.match(html, /غير صالح: 1/);
    assert.match(html, /إعادة ضبط القرارات/);
    assert.match(html, /تنزيل تقرير الصفوف غير المُدرجة/);
    // The privacy notice is IN the label, not in a hidden tooltip.
    assert.match(html, /يحتوي بيانات هذا الملف المحلي/);
    // The accepted 170 controls are untouched.
    assert.match(html, /إغلاق المعاينة/);
    assert.match(html, /الصفحة 1 من 1/);
  } finally {
    controller.dispose();
  }
});

test("component: the report control is disabled when nothing is non-included", async () => {
  const preview = await previewStateFrom("name,phone\nAli,0100\nSara,0200\n");
  const controller = createImportResolutionController({});
  controller.load(preview.rows);
  try {
    const { controls } = await renderPanel(preview, controller.getState(), controller, null);
    const report = controls.find((control) => control.text.includes("تنزيل تقرير"));
    assert.ok(report);
    assert.equal(Boolean(report.disabled), true, "an all-included file has no report to make");
  } finally {
    controller.dispose();
  }
});

test("component: the real include control performs the real decision", async () => {
  const preview = await previewStateFrom(PANEL_CSV);
  const controller = createImportResolutionController({});
  controller.load(preview.rows);
  try {
    const { controls } = await renderPanel(preview, controller.getState(), controller, null);
    const include = controls.find((control) => control.text.trim() === "إدراج");
    assert.ok(include, "the include control exists");
    assert.equal(Boolean(include.disabled), false, "a pending row can be included");

    include.onClick();
    // The first page row is physical line 2.
    assert.equal(controller.getState().rows[0].status, "included");
    assert.equal(controller.getState().counts.included, 2);
  } finally {
    controller.dispose();
  }
});

test("component: the real exclude control performs the real decision", async () => {
  const preview = await previewStateFrom(PANEL_CSV);
  const controller = createImportResolutionController({});
  controller.load(preview.rows);
  try {
    const { controls } = await renderPanel(preview, controller.getState(), controller, null);
    const exclude = controls.find((control) => control.text.trim() === "استبعاد");
    assert.ok(exclude);
    exclude.onClick();
    assert.equal(controller.getState().rows[0].status, "excluded");
    assert.equal(controller.getState().counts.excluded, 1);
  } finally {
    controller.dispose();
  }
});

test("component: the real reset control restores the initial decisions", async () => {
  const preview = await previewStateFrom(PANEL_CSV);
  const controller = createImportResolutionController({});
  controller.load(preview.rows);
  controller.exclude(2);
  controller.exclude(5);
  try {
    const { controls } = await renderPanel(preview, controller.getState(), controller, null);
    const reset = controls.find((control) => control.text.trim() === "إعادة ضبط القرارات");
    assert.ok(reset);
    reset.onClick();
    assert.equal(controller.getState().counts.excluded, 0);
    assert.equal(controller.getState().counts.included, 1);
    assert.equal(controller.getState().counts.pending, 2);
  } finally {
    controller.dispose();
  }
});

test("component: the real report control materializes ONE document from the live set", async () => {
  const preview = await previewStateFrom(PANEL_CSV);
  const controller = createImportResolutionController({});
  controller.load(preview.rows);
  const harness = createReportEnv();
  const report = createImportReportController(harness.env);
  try {
    const { controls } = await renderPanel(preview, controller.getState(), controller, report);
    const button = controls.find((control) => control.text.includes("تنزيل تقرير"));
    assert.ok(button);
    assert.equal(Boolean(button.disabled), false);

    button.onClick();
    assert.equal(harness.created.length, 1, "exactly one document");
    assert.equal(harness.links.length, 1, "exactly one link");
    assert.equal(harness.links[0].clicked, 1);
    assert.equal(harness.links[0].removed, 1);
    const text = await harness.created[0].text();
    assert.ok(text.includes('"rowNumber": 4'), "the invalid row is in the report");
    assert.equal(text.includes("q@r.s"), false, "the included row is not");
  } finally {
    report.dispose();
    controller.dispose();
  }
});

test("component: an invalid row offers no include control", async () => {
  const preview = await previewStateFrom("name,phone\nAli,0100\n,0200\n");
  const controller = createImportResolutionController({});
  controller.load(preview.rows);
  try {
    const { html, controls } = await renderPanel(preview, controller.getState(), controller, null);
    assert.match(html, /غير قابل للإدراج/);
    // Exactly one includable row (line 2), so exactly one include control.
    const includes = controls.filter((control) => control.text.trim() === "إدراج");
    assert.equal(includes.length, 1);
  } finally {
    controller.dispose();
  }
});

test("component: a refusal is rendered with the real conflicting row numbers", async () => {
  const preview = await previewStateFrom("name,phone,email\nAli,0100,a@b.c\nSara,0100,d@e.f\n");
  const controller = createImportResolutionController({});
  controller.load(preview.rows);
  try {
    controller.include(2);
    const refused = controller.include(3);
    assert.equal(refused.ok, false);

    const { html } = await renderPanel(preview, controller.getState(), controller, null);
    assert.match(html, /تعذّر إدراج السطر 3/);
    assert.match(html, /يتعارض مع السطر 2/);
    assert.match(html, /القرارات السابقة محفوظة/);
  } finally {
    controller.dispose();
  }
});

test("component: without a live model the accepted preview renders unchanged", async () => {
  const preview = await previewStateFrom(PANEL_CSV);
  // The decision layer must not appear before its seam exists.
  const { html, controls } = await renderPanel(preview, null, null, null);

  assert.match(html, /<table/);
  assert.match(html, /Ali/);
  assert.match(html, /إغلاق المعاينة/);
  assert.equal(html.includes("إعادة ضبط القرارات"), false);
  assert.equal(html.includes("تنزيل تقرير"), false);
  assert.equal(controls.some((control) => control.text.trim() === "إدراج"), false);
});

// ===========================================================================
// The 194 corrections: the guarded export, the exact cleanup and the index
// ===========================================================================

/** Which native step of the materialization fails. */
interface FailingEnvOptions {
  readonly failObjectUrl?: boolean;
  readonly failCreateLink?: boolean;
  readonly failOn?: "href" | "download" | "rel" | "click" | "remove";
  readonly failSchedule?: boolean;
  readonly failRevoke?: boolean;
}

interface FailingEnvCounts {
  revoked: number;
  removed: number;
  clicked: number;
  links: number;
}

/**
 * A browser boundary where exactly ONE native step can fail.
 *
 * Everything is synthetic: no Blob is created by a browser, no URL exists and
 * no anchor is ever attached to a document.
 */
const createFailingEnv = (
  options: FailingEnvOptions,
): { env: ImportReportEnvironment; counts: FailingEnvCounts } => {
  const counts: FailingEnvCounts = { revoked: 0, removed: 0, clicked: 0, links: 0 };
  const guard = (step: string): void => {
    if (options.failOn === step) throw new Error(`synthetic ${step} failure`);
  };
  const env: ImportReportEnvironment = {
    createObjectURL: () => {
      if (options.failObjectUrl) throw new Error("synthetic createObjectURL failure");
      return "blob:synthetic/1";
    },
    revokeObjectURL: () => {
      counts.revoked += 1;
      if (options.failRevoke) throw new Error("synthetic revokeObjectURL failure");
    },
    createLink: () => {
      if (options.failCreateLink) throw new Error("synthetic createLink failure");
      counts.links += 1;
      const record = { href: "", download: "", rel: "" };
      return {
        get href() { return record.href; },
        set href(value: string) { guard("href"); record.href = value; },
        get download() { return record.download; },
        set download(value: string) { guard("download"); record.download = value; },
        get rel() { return record.rel; },
        set rel(value: string) { guard("rel"); record.rel = value; },
        click: () => { guard("click"); counts.clicked += 1; },
        remove: () => { counts.removed += 1; guard("remove"); },
      };
    },
    schedule: (task: () => void) => {
      if (options.failSchedule) throw new Error("synthetic schedule failure");
      task();
    },
  };
  return { env, counts };
};

test("report seam: every native failure releases the link and the URL exactly once", () => {
  const state = modelOf("name,phone\nAli,0100\nSara,0100\n");

  // No allocation happened at all: nothing to release.
  const noAllocation = createFailingEnv({ failObjectUrl: true });
  const objectUrlController = createImportReportController(noAllocation.env);
  try {
    const result = objectUrlController.download(state);
    assert.equal(result.ok, false);
    assert.equal(noAllocation.counts.links, 0, "no link was created");
    assert.equal(noAllocation.counts.removed, 0);
    assert.equal(noAllocation.counts.revoked, 0, "nothing was allocated, so nothing is revoked");
  } finally {
    objectUrlController.dispose();
  }

  // The link could not be created: the URL is released, no link exists.
  const noLink = createFailingEnv({ failCreateLink: true });
  const linkController = createImportReportController(noLink.env);
  try {
    const result = linkController.download(state);
    assert.equal(result.ok, false);
    assert.equal(noLink.counts.revoked, 1, "the URL is released exactly once");
    assert.equal(noLink.counts.removed, 0, "there was no link to remove");
    assert.equal(noLink.counts.clicked, 0);
  } finally {
    linkController.dispose();
  }

  // A configuration, a click or a scheduling failure: the link is removed
  // once and the URL is revoked once.
  for (const step of ["href", "download", "rel", "click", "schedule"] as const) {
    const options: FailingEnvOptions = step === "schedule" ? { failSchedule: true } : { failOn: step };
    const failing = createFailingEnv(options);
    const controller = createImportReportController(failing.env);
    try {
      const result = controller.download(state);
      assert.equal(result.ok, false, `a ${step} failure is reported honestly`);
      assert.equal(failing.counts.removed, 1, `the link is removed once after a ${step} failure`);
      assert.equal(failing.counts.revoked, 1, `the URL is revoked once after a ${step} failure`);
      assert.equal(controller.liveUrl(), null, "no URL outlives a failed materialization");
    } finally {
      controller.dispose();
    }
  }

  // A removal that fails is contained: the download already happened and the
  // URL is still retired on the scheduled tick.
  const removal = createFailingEnv({ failOn: "remove" });
  const removalController = createImportReportController(removal.env);
  try {
    const result = removalController.download(state);
    assert.equal(result.ok, true);
    assert.equal(removal.counts.removed, 1, "the removal was attempted exactly once");
    assert.equal(removal.counts.revoked, 1, "the URL is revoked exactly once");
    assert.equal(removalController.liveUrl(), null);
  } finally {
    removalController.dispose();
  }

  // A revocation that throws is not retried: the reference is already gone.
  const revoke = createFailingEnv({ failRevoke: true });
  const revokeController = createImportReportController(revoke.env);
  try {
    const result = revokeController.download(state);
    assert.equal(result.ok, true);
    assert.equal(revoke.counts.revoked, 1);
    revokeController.dispose();
    assert.equal(revoke.counts.revoked, 1, "a failed revocation is never retried");
  } finally {
    revokeController.dispose();
  }
});

test("report seam: retire() releases the outstanding URL at once and keeps the seam usable", () => {
  const state = modelOf("name,phone\nAli,0100\nSara,0100\n");
  const harness = createReportEnv();
  const controller = createImportReportController(harness.env);
  try {
    const first = controller.download(state);
    assert.equal(first.ok, true);
    if (!("url" in first)) return;
    assert.equal(controller.liveUrl(), first.url);

    controller.retire();
    assert.deepEqual(harness.revoked, [first.url], "the outstanding URL dies immediately");
    assert.equal(controller.liveUrl(), null);

    // The seam is NOT disposed: a later valid download still works.
    const second = controller.download(state);
    assert.equal(second.ok, true);
    if (!("url" in second)) return;
    assert.notEqual(second.url, first.url);

    controller.dispose();
    assert.deepEqual(harness.revoked, [first.url, second.url], "a URL is revoked at most once");
  } finally {
    controller.dispose();
  }
});

test("model: the whole-file conflict lookup never walks a duplicate group", () => {
  const lines = ["name,phone"];
  for (let index = 0; index < 1000; index += 1) lines.push(`Synthetic ${index},0100`);
  const rows = parsedRows(`${lines.join("\n")}\n`);
  assert.equal(rows.length, 1000);

  // Every read of a group's member list is counted. The candidate's member
  // list is replaced by a counting proxy for the duration of this test only.
  let memberReads = 0;
  for (const row of rows) {
    for (const candidate of row.duplicates) {
      const memberList = candidate.rowNumbers;
      const counting = new Proxy(memberList, {
        get(target, key, receiver) {
          if (typeof key === "string" && /^\d+$/.test(key)) memberReads += 1;
          return Reflect.get(target, key, receiver);
        },
      });
      (candidate as { rowNumbers: number[] }).rowNumbers = counting;
    }
  }

  const state = loadImportResolution(rows);
  const conflicts = computeBlockingConflicts(state);
  assert.equal(conflicts.size, 0, "no row is included, so nothing blocks");
  assert.ok(
    memberReads <= 6000,
    `candidate-member reads=${memberReads}; the lookup must be indexed, not a group scan`,
  );

  // The same bound holds once a row IS included, and the blocking row is
  // still the exact one.
  const included = applyImportDecision(state, 2, "include");
  assert.equal(included.ok, true);
  const after = computeBlockingConflicts(included.state);
  assert.equal(after.size, 999, "every other pending row is blocked by the included one");
  assert.deepEqual(after.get(3), [{ field: "phone", value: "0100", rowNumbers: [2] }]);
  assert.deepEqual(after.get(1001), [{ field: "phone", value: "0100", rowNumbers: [2] }]);
  assert.ok(
    memberReads <= 6000,
    `candidate-member reads=${memberReads}; the lookup must stay indexed`,
  );
});

test("model: a chain inside a large group resolves on the exact blocking rows", () => {
  const lines = ["name,phone,email"];
  for (let index = 0; index < 20; index += 1) lines.push(`Group ${index},0100,g${index}@x.y`);
  lines.push("Chain,0200,g0@x.y");
  const state = modelOf(`${lines.join("\n")}\n`);

  // Rows 2..21 share the phone; row 22 shares the EMAIL of row 2.
  const included = applyImportDecision(state, 2, "include");
  assert.equal(included.ok, true);

  const conflicts = computeBlockingConflicts(included.state);
  assert.deepEqual(conflicts.get(3), [{ field: "phone", value: "0100", rowNumbers: [2] }]);
  assert.deepEqual(conflicts.get(21), [{ field: "phone", value: "0100", rowNumbers: [2] }]);
  assert.deepEqual(conflicts.get(22), [{ field: "email", value: "g0@x.y", rowNumbers: [2] }]);
  assert.equal(conflicts.get(2), undefined, "an included row never blocks itself");
  assert.equal(conflicts.size, 20);

  // The chain resolves only by an explicit exclusion, exactly as before.
  const excluded = applyImportDecision(included.state, 2, "exclude");
  assert.equal(excluded.ok, true);
  assert.equal(
    computeBlockingConflicts(excluded.state).size,
    0,
    "nothing blocks while no row is included",
  );

  const third = applyImportDecision(excluded.state, 3, "include");
  assert.equal(third.ok, true, "the chain resolves by an explicit decision");
  assert.deepEqual(computeBlockingConflicts(third.state).get(4), [
    { field: "phone", value: "0100", rowNumbers: [3] },
  ]);
});

test("component: the real report control refuses a former-principal export", async () => {
  const preview = await previewStateFrom(PANEL_CSV);
  let principal = "session:a";
  const controller = createImportResolutionController({ readPrincipal: () => principal });
  controller.load(preview.rows);
  const harness = createReportEnv();
  const report = createImportReportController(harness.env);
  try {
    const { controls } = await renderPanel(preview, controller.getState(), controller, report);
    const button = controls.find((control) => control.text.includes("تنزيل تقرير"));
    assert.ok(button);
    assert.equal(Boolean(button.disabled), false);

    // The scope is silently replaced: no session event, no re-render.
    principal = "session:b";
    button.onClick();

    assert.equal(harness.created.length, 0, "no document was materialized");
    assert.equal(harness.urls.length, 0, "no object URL was created");
    assert.equal(harness.links.length, 0, "no link was created");
    assert.equal(controller.getState().loaded, false, "the former scope's decisions are gone");
    assert.deepEqual(controller.getState().rows, []);

    // The panel is still usable for the CURRENT scope.
    controller.load(preview.rows);
    button.onClick();
    assert.equal(harness.created.length, 1, "a valid export still works");
    assert.equal(harness.links.length, 1);
  } finally {
    report.dispose();
    controller.dispose();
  }
});

test("component: a reset, a close and a replacement retire the outstanding report URL", async () => {
  const preview = await previewStateFrom(PANEL_CSV);
  const controller = createImportResolutionController({});
  controller.load(preview.rows);
  const harness = createReportEnv();
  const report = createImportReportController(harness.env);
  try {
    const { controls, changes } = await renderPanel(preview, controller.getState(), controller, report);
    const button = controls.find((control) => control.text.includes("تنزيل تقرير"));
    const reset = controls.find((control) => control.text.trim() === "إعادة ضبط القرارات");
    const close = controls.find((control) => control.text.trim() === "إغلاق المعاينة");
    assert.ok(button);
    assert.ok(reset);
    assert.ok(close);
    assert.equal(changes.length, 1, "the file selection is the only change handler");

    button.onClick();
    const first = report.liveUrl();
    assert.ok(first);
    reset.onClick();
    assert.deepEqual(harness.revoked, [first], "a reset retires the URL at once");

    button.onClick();
    const second = report.liveUrl();
    assert.ok(second);
    close.onClick();
    assert.deepEqual(harness.revoked, [first, second], "a close retires the URL at once");

    // The close dropped the decisions, so the file is loaded again before a
    // new export.
    controller.load(preview.rows);
    button.onClick();
    const third = report.liveUrl();
    assert.ok(third);
    changes[0]({
      target: { files: [{ name: "other.csv", size: 12 }], value: "C:/fake/other.csv" },
    });
    assert.deepEqual(
      harness.revoked,
      [first, second, third],
      "a replaced file retires the URL at once",
    );
    assert.equal(report.liveUrl(), null);
  } finally {
    report.dispose();
    controller.dispose();
  }
});

/**
 * A minimal browser boundary for the component's OWN seams.
 *
 * The component creates its report seam with the global `URL` and `document`,
 * so both are replaced by synthetic ones: nothing real is downloaded, no
 * object URL exists and no anchor is ever attached to a document.
 */
interface FakeBrowser {
  urls: string[];
  revoked: string[];
  anchors: { clicked: number; removed: number }[];
  restore: () => void;
}

const installFakeBrowser = (): FakeBrowser => {
  const urls: string[] = [];
  const revoked: string[] = [];
  const anchors: { clicked: number; removed: number }[] = [];
  const urlApi = URL as unknown as {
    createObjectURL: (blob: Blob) => string;
    revokeObjectURL: (url: string) => void;
  };
  const previousCreate = urlApi.createObjectURL;
  const previousRevoke = urlApi.revokeObjectURL;
  const globals = globalThis as unknown as { document?: unknown };
  const previousDocument = globals.document;

  urlApi.createObjectURL = () => {
    const url = `blob:live/${urls.length + 1}`;
    urls.push(url);
    return url;
  };
  urlApi.revokeObjectURL = (url: string) => {
    revoked.push(url);
  };
  globals.document = {
    createElement: () => {
      const anchor = { clicked: 0, removed: 0 };
      anchors.push(anchor);
      const record = { href: "", download: "", rel: "" };
      return {
        get href() { return record.href; },
        set href(value: string) { record.href = value; },
        get download() { return record.download; },
        set download(value: string) { record.download = value; },
        get rel() { return record.rel; },
        set rel(value: string) { record.rel = value; },
        click: () => { anchor.clicked += 1; },
        remove: () => { anchor.removed += 1; },
      };
    },
  };

  return {
    urls,
    revoked,
    anchors,
    restore: () => {
      urlApi.createObjectURL = previousCreate;
      urlApi.revokeObjectURL = previousRevoke;
      if (previousDocument === undefined) delete globals.document;
      else globals.document = previousDocument;
    },
  };
};

/**
 * Renders the REAL component with its mount EFFECT running.
 *
 * `useState`/`useRef` are backed by a tiny store so a second render observes
 * the state the component published, and the mount effect really creates the
 * component's own preview, decision and report seams and subscribes to the
 * REAL session notifier.
 */
const renderPanelLive = (): {
  controls: RenderedControl[];
  changes: ((event: unknown) => void)[];
  rerender: () => { controls: RenderedControl[]; changes: ((event: unknown) => void)[] };
  cleanups: (() => void)[];
  notifySession: (kind: string) => void;
  restore: () => void;
} => {
  const projectRequire = Module.createRequire(import.meta.url);
  const React = projectRequire("react");
  const componentPath = projectRequire.resolve("../features/students/StudentImportPreview.tsx");
  const moduleInternals = Module as unknown as { _load: (...args: unknown[]) => unknown };
  const original = moduleInternals._load;
  const previousReact = (globalThis as { React?: unknown }).React;
  const cleanups: (() => void)[] = [];
  const stateStore: unknown[] = [];
  const refStore: { current: unknown }[] = [];
  let stateCall = 0;
  let refCall = 0;
  let effectCall = 0;
  let mountRan = false;

  moduleInternals._load = function (
    specifier: string,
    parent: { filename?: string } | undefined,
    isMain: boolean,
  ) {
    if (specifier === "react" && /StudentImportPreview\.tsx$/.test(parent?.filename || "")) {
      return {
        ...React,
        useState: (initial: unknown) => {
          const index = stateCall;
          stateCall += 1;
          if (!(index in stateStore)) stateStore[index] = initial;
          return [
            stateStore[index],
            (next: unknown) => {
              stateStore[index] = typeof next === "function"
                ? (next as (value: unknown) => unknown)(stateStore[index])
                : next;
            },
          ];
        },
        useRef: (initial: unknown) => {
          const index = refCall;
          refCall += 1;
          if (!(index in refStore)) refStore[index] = { current: initial };
          return refStore[index];
        },
        useEffect: (effect: () => (() => void) | void) => {
          const index = effectCall;
          effectCall += 1;
          // The mount effect runs ONCE, like the real component.
          if (index === 0) {
            if (mountRan) return;
            mountRan = true;
            const cleanup = effect();
            if (typeof cleanup === "function") cleanups.push(cleanup);
            return;
          }
          effect();
        },
      };
    }
    if (specifier.startsWith("@/")) {
      return original.call(this, path.resolve(SRC_ROOT, specifier.slice(2)), parent, isMain);
    }
    return original.apply(this, arguments as unknown as unknown[]);
  } as never;

  try {
    delete projectRequire.cache[componentPath];
    const Component = projectRequire(componentPath).default as (...args: unknown[]) => unknown;
    (globalThis as { React?: unknown }).React = React;
    // The SAME session-events instance the component subscribes to.
    const sessionEvents = projectRequire("../lib/session-events") as {
      notifySessionChange: (kind: string) => void;
    };
    const render = (): { controls: RenderedControl[]; changes: ((event: unknown) => void)[] } => {
      // The hook order is per render, exactly like the real component.
      stateCall = 0;
      refCall = 0;
      effectCall = 0;
      const tree = Component();
      return { controls: collectControls(tree), changes: collectChangeHandlers(tree) };
    };
    const first = render();
    return {
      controls: first.controls,
      changes: first.changes,
      rerender: render,
      cleanups,
      notifySession: (kind: string) => sessionEvents.notifySessionChange(kind),
      // The JSX of the component needs the global React at EVERY render, so
      // it is restored only when the caller is done.
      restore: () => {
        if (previousReact === undefined) delete (globalThis as { React?: unknown }).React;
        else (globalThis as { React?: unknown }).React = previousReact;
      },
    };
  } finally {
    moduleInternals._load = original;
  }
};

test("component: a session loss retires the outstanding report URL of the live panel", async () => {
  const browser = installFakeBrowser();
  const live = renderPanelLive();
  try {
    const csv = PANEL_CSV;
    const initial = live.controls;
    assert.equal(
      initial.some((control) => control.text.includes("تنزيل تقرير")),
      false,
      "the decision layer only exists once a file is loaded",
    );

    // The REAL file selection of the REAL panel: its own preview seam reads
    // the synthetic file and its own decision seam loads the parsed rows.
    live.changes[0]({
      target: {
        files: [{ name: "students.csv", size: csv.length, text: async () => csv }],
        value: "C:/fake/students.csv",
      },
    });
    await flush();
    await flush();

    const after = live.rerender();
    const button = after.controls.find((control) => control.text.includes("تنزيل تقرير"));
    assert.ok(button, "the report control exists once the file is loaded");
    assert.equal(Boolean(button.disabled), false);

    button.onClick();
    assert.equal(browser.urls.length, 1, "the live panel created one object URL");
    assert.equal(browser.anchors.length, 1, "the live panel created one link");
    assert.equal(browser.anchors[0].clicked, 1);
    assert.deepEqual(browser.revoked, [], "the URL is still live for its tick");

    // The REAL session notifier: the lost session retires the URL at once.
    live.notifySession("logout");
    assert.deepEqual(browser.revoked, browser.urls, "a session loss retires the URL at once");
  } finally {
    for (const cleanup of live.cleanups) cleanup();
    live.restore();
    browser.restore();
  }
});

// ===========================================================================
// M2-15 — explicit existing-match review and the combined report
// ===========================================================================

/** A three-row file whose rows all start included, so a match can be reviewed. */
const REVIEW_CSV = "name,phone,email\nAli,0100,a@b.c\nSara,0200,d@e.f\nOmar,0300,o@b.c\n";

/** The review state of one row, or "none". */
const reviewOf = (state: ImportResolutionState, rowNumber: number): string =>
  state.serverMatches.get(rowNumber)?.review ?? "none";

test("review: only a confirmed result seeds a review, and seeding changes no decision", () => {
  const state = modelOf(REVIEW_CSV);
  const seeded = seedServerMatches(state, serverResult([[2, ["email"]]]));

  assert.equal(reviewOf(seeded, 2), "pending", "a match starts undecided");
  assert.equal(statusOf(seeded, 2), "included", "seeding never excludes anything");
  assert.deepEqual(seeded.counts, state.counts, "the decisions are untouched");
  assert.deepEqual(seeded.serverMatchCounts, { pending: 1, kept: 0, excluded: 0 });
  assert.equal(seeded.serverMatchGeneration, 1);
  assert.equal(seeded.serverMatches.size, 1, "a clear row never becomes a review item");
});

test("review: a multi-field match preserves the exact subset and its documented order", () => {
  const state = modelOf(REVIEW_CSV);
  const seeded = seedServerMatches(state, serverResult([[3, ["email", "phone", "barcode"]]]));

  assert.deepEqual(seeded.serverMatches.get(3)?.matched_fields, ["email", "phone", "barcode"]);
  // The documented order is the response order, never the parser's column order.
  assert.deepEqual([...SERVER_RESOLUTION_FIELDS], ["email", "phone", "barcode"]);
  assert.notDeepEqual([...SERVER_RESOLUTION_FIELDS], ["phone", "email", "barcode"]);
});

test("review: matches across pages are keyed by the physical row number", () => {
  const header = "name,phone,email\n";
  let csv = header;
  for (let index = 0; index < 30; index += 1) {
    csv += `P${index},9${String(index).padStart(3, "0")},p${index}@x.y\n`;
  }
  const state = modelOf(csv);
  // Line 31 is on page 2 of the 25-row preview: the model never pages.
  const seeded = seedServerMatches(state, serverResult([[31, ["email"]]]));

  assert.equal(seeded.rows.length, 30);
  assert.equal(reviewOf(seeded, 31), "pending", "the review is keyed by the physical line");
  assert.equal(currentServerMatchReview(seeded, 31)?.review, "pending");
  // A keep taken on a later page is the same entry, not a display index.
  assert.equal(reviewOf(keepServerMatch(seeded, 31), 31), "kept");
});

test("review: keep, exclude and undo drive both the counts and the decision", () => {
  const state = modelOf(REVIEW_CSV);
  const seeded = seedServerMatches(state, serverResult([[2, ["email"]], [3, ["phone"]]]));

  const kept = keepServerMatch(seeded, 2);
  assert.equal(reviewOf(kept, 2), "kept");
  assert.equal(statusOf(kept, 2), "included", "keeping changes no decision");
  assert.deepEqual(kept.serverMatchCounts, { pending: 1, kept: 1, excluded: 0 });

  const excluded = excludeServerMatch(kept, 3);
  assert.equal(reviewOf(excluded, 3), "excluded");
  assert.equal(statusOf(excluded, 3), "excluded", "the only path from a match to a decision");
  assert.deepEqual(excluded.serverMatchCounts, { pending: 0, kept: 1, excluded: 1 });
  assert.equal(excluded.counts.excluded, 1);
  assert.equal(excluded.counts.included, 2);

  const undone = undoServerMatch(excluded, 3);
  assert.equal(reviewOf(undone, 3), "pending");
  assert.equal(statusOf(undone, 3), "included", "an undo returns the row to the included set");
  assert.deepEqual(undone.serverMatchCounts, { pending: 1, kept: 1, excluded: 0 });
  assert.equal(undone.counts.included, 3);

  // Undoing a KEEP only returns the review; the decision was never changed.
  const unkept = undoServerMatch(undone, 2);
  assert.equal(reviewOf(unkept, 2), "pending");
  assert.equal(statusOf(unkept, 2), "included");
});

test("review: the three states are mutually exclusive and sum to the set size", () => {
  const state = modelOf(REVIEW_CSV);
  const seeded = seedServerMatches(
    state,
    serverResult([[2, ["email"]], [3, ["email"]], [4, ["barcode"]]]),
  );
  const withKept = keepServerMatch(seeded, 2);
  const withExcluded = excludeServerMatch(withKept, 3);
  const counts = withExcluded.serverMatchCounts;
  assert.equal(counts.pending + counts.kept + counts.excluded, withExcluded.serverMatches.size);
  assert.deepEqual([...SERVER_MATCH_REVIEW_STATES], ["pending", "kept", "excluded"]);
});

test("review: re-seeding the SAME result never resets a user decision", () => {
  const state = modelOf(REVIEW_CSV);
  const result = serverResult([[2, ["email"]]]);
  const seeded = seedServerMatches(state, result);
  const kept = keepServerMatch(seeded, 2);
  const again = seedServerMatches(kept, result);

  assert.equal(again, kept, "the same result is a no-op, not a reset");
  assert.equal(reviewOf(again, 2), "kept");
  assert.equal(again.serverMatchGeneration, kept.serverMatchGeneration);
});

test("review: a new reconciliation replaces the whole previous set atomically", () => {
  const state = modelOf(REVIEW_CSV);
  const first = seedServerMatches(state, serverResult([[2, ["email"]], [3, ["email"]]]));
  const kept = keepServerMatch(first, 2);
  // A newer confirmed answer names a DIFFERENT row.
  const second = seedServerMatches(kept, serverResult([[4, ["phone"]]]));

  assert.equal(second.serverMatches.size, 1, "no entry of the old answer survives");
  assert.equal(reviewOf(second, 2), "none");
  assert.equal(reviewOf(second, 3), "none");
  assert.equal(reviewOf(second, 4), "pending");
  assert.equal(second.serverMatchGeneration, first.serverMatchGeneration + 1);
  // The DECISIONS are untouched by a replacement.
  assert.equal(statusOf(second, 2), "included");
});

test("review: a result for a non-included or unknown row is ignored, never invented", () => {
  const state = modelOf("name,phone,email\nAli,0100,a@b.c\nSara,0100,d@e.f\n,0300,o@b.c\n");
  // Line 3 is pending (shared phone) and line 4 is invalid.
  assert.equal(statusOf(state, 3), "pending");
  assert.equal(statusOf(state, 4), "invalid");
  const seeded = seedServerMatches(
    state,
    serverResult([[3, ["email"]], [4, ["email"]], [99, ["email"]]]),
  );
  assert.equal(seeded.serverMatches.size, 0);
  assert.deepEqual(seeded.serverMatchCounts, { pending: 0, kept: 0, excluded: 0 });
});

test("review: a plain decision retires the review set BEFORE it is applied", () => {
  const state = modelOf(REVIEW_CSV);
  const seeded = seedServerMatches(state, serverResult([[2, ["email"]], [3, ["email"]]]));
  const controller = createImportResolutionController({});
  try {
    controller.load(parsedRows(REVIEW_CSV));
    controller.seedServerMatches(serverResult([[2, ["email"]], [3, ["email"]]]));
    assert.equal(controller.getState().serverMatches.size, 2);

    controller.exclude(3);
    assert.equal(controller.getState().serverMatches.size, 0, "a plain decision retires the set");
    assert.equal(controller.getState().serverMatchSource, null);
    assert.equal(controller.getState().counts.excluded, 1);
    // The retired entry can never be revived by the old result.
    assert.equal(currentServerMatchReview(controller.getState(), 2), null);
    // The generation moved, so the retired entries are not merely "absent".
    assert.ok(controller.getState().serverMatchGeneration > seeded.serverMatchGeneration);
  } finally {
    controller.dispose();
  }
});

test("review: a reset and a clear retire the review", () => {
  const state = modelOf(REVIEW_CSV);
  const seeded = seedServerMatches(state, serverResult([[2, ["email"]]]));

  const reset = resetImportResolution(seeded);
  assert.equal(reset.serverMatches.size, 0);
  assert.equal(reset.serverMatchSource, null);
  assert.equal(statusOf(reset, 2), "included", "a reset restores the decisions of the file");

  const cleared = clearServerMatches(seeded);
  assert.equal(cleared.serverMatches.size, 0);
  assert.equal(cleared.serverMatchSource, null);
  assert.equal(cleared.counts.included, 3, "clearing a review changes no decision");
  assert.equal(cleared.serverMatchGeneration, seeded.serverMatchGeneration + 1);
  // Idempotent: clearing an empty set is a no-op.
  assert.equal(clearServerMatches(cleared), cleared);
});

test("review: keep cannot produce a kept-but-excluded row", () => {
  const state = modelOf(REVIEW_CSV);
  const seeded = seedServerMatches(state, serverResult([[2, ["email"]]]));
  const excluded = excludeServerMatch(seeded, 2);
  assert.equal(statusOf(excluded, 2), "excluded");

  const contradictory = keepServerMatch(excluded, 2);
  assert.equal(contradictory, excluded, "a kept review on an excluded row is refused");
  assert.equal(reviewOf(contradictory, 2), "excluded");
});

test("review: an entry from a superseded generation is never returned", () => {
  const state = modelOf(REVIEW_CSV);
  const seeded = seedServerMatches(state, serverResult([[2, ["email"]]]));
  assert.ok(currentServerMatchReview(seeded, 2), "the current entry is readable");

  // A state whose generation moved past the entry's own generation.
  const stale = { ...seeded, serverMatchGeneration: seeded.serverMatchGeneration + 1 };
  assert.equal(currentServerMatchReview(stale, 2), null, "a stale entry is never trusted");
});

test("review: a silent principal change drops the review before an action", () => {
  let principal: string | null = "session:a";
  const controller = createImportResolutionController({ readPrincipal: () => principal });
  try {
    controller.load(parsedRows(REVIEW_CSV));
    controller.seedServerMatches(serverResult([[2, ["email"]]]));
    assert.equal(controller.getState().serverMatches.size, 1);

    principal = "session:b";
    controller.keepServerMatch(2);
    assert.equal(controller.getState().serverMatches.size, 0, "another scope's review is dropped");
    assert.equal(controller.getState().loaded, false);
  } finally {
    controller.dispose();
  }
});

test("review: a session event drops the review", () => {
  let notify: (() => void) | null = null;
  const controller = createImportResolutionController({
    readPrincipal: () => "session:a",
    subscribeSession: (listener) => {
      notify = listener;
      return () => { notify = null; };
    },
  });
  try {
    controller.load(parsedRows(REVIEW_CSV));
    controller.seedServerMatches(serverResult([[2, ["email"]]]));
    assert.equal(controller.getState().serverMatches.size, 1);
    notify!();
    assert.equal(controller.getState().serverMatches.size, 0);
    assert.equal(controller.getState().loaded, false);
  } finally {
    controller.dispose();
  }
});

test("review: the map is bounded by the rows of this file, not by the answer", () => {
  const state = modelOf(REVIEW_CSV);
  const huge: [number, ServerResolutionField[]][] = [];
  for (let rowNumber = 2; rowNumber <= 1001; rowNumber += 1) {
    huge.push([rowNumber, ["email"]]);
  }
  const seeded = seedServerMatches(state, serverResult(huge));
  assert.equal(seeded.serverMatches.size, 3, "only the three real rows become review items");
  assert.deepEqual(seeded.serverMatchCounts, { pending: 3, kept: 0, excluded: 0 });
});

test("review: seeding performs no storage write and no console call", () => {
  const globalStore = globalThis as unknown as { localStorage?: unknown };
  const previous = globalStore.localStorage;
  let writes = 0;
  let consoleCalls = 0;
  const originalConsole = { ...console };
  try {
    globalStore.localStorage = {
      getItem: () => null,
      setItem: () => { writes += 1; },
      removeItem: () => { writes += 1; },
    };
    console.log = () => { consoleCalls += 1; };
    console.warn = () => { consoleCalls += 1; };
    console.error = () => { consoleCalls += 1; };

    const state = modelOf(REVIEW_CSV);
    const seeded = seedServerMatches(state, serverResult([[2, ["email"]]]));
    keepServerMatch(seeded, 2);
    excludeServerMatch(seeded, 2);
    buildImportReport(seeded);

    assert.equal(writes, 0, "the review model writes no storage");
    assert.equal(consoleCalls, 0, "the review model logs nothing");
  } finally {
    console.log = originalConsole.log;
    console.warn = originalConsole.warn;
    console.error = originalConsole.error;
    if (previous === undefined) delete globalStore.localStorage;
    else globalStore.localStorage = previous;
  }
});

test("report: an exclusion made from a match carries the reason and the exact field names", () => {
  const state = modelOf(REVIEW_CSV);
  const seeded = seedServerMatches(state, serverResult([[2, ["email", "barcode"]]]));
  const excluded = excludeServerMatch(seeded, 2);
  const built = buildImportReport(excluded);

  assert.ok(built.ok === true || "text" in built);
  const payload = JSON.parse((built as { text: string }).text);
  assert.equal(payload.rows.length, 1);
  assert.equal(payload.rows[0].rowNumber, 2);
  assert.equal(payload.rows[0].status, "excluded");
  assert.deepEqual(payload.rows[0].reasons, ["excluded-by-user", "existing-value-match"]);
  assert.deepEqual(payload.rows[0].matched_fields, ["email", "barcode"]);
  assert.equal(payload.version, IMPORT_REPORT_VERSION);
  assert.equal(IMPORT_REPORT_VERSION, 2, "the row shape and the reasons grew");
});

test("report: a KEPT match contributes no reason and no matched_fields", () => {
  const state = modelOf(REVIEW_CSV);
  const seeded = seedServerMatches(state, serverResult([[2, ["email"]], [3, ["phone"]]]));
  const kept = keepServerMatch(seeded, 2);
  // A kept row is still included, so it is not in the report at all.
  assert.equal(buildImportReport(kept).ok, false);

  // Excluding a DIFFERENT matched row names only that row's fields.
  const excluded = excludeServerMatch(kept, 3);
  const payload = JSON.parse((buildImportReport(excluded) as { text: string }).text);
  assert.equal(payload.rows.length, 1);
  assert.equal(payload.rows[0].rowNumber, 3);
  assert.deepEqual(payload.rows[0].reasons, ["excluded-by-user", "existing-value-match"]);
  assert.deepEqual(payload.rows[0].matched_fields, ["phone"]);
  // The kept row contributed nothing at all.
  assert.equal(
    payload.rows.some((entry: { rowNumber: number }) => entry.rowNumber === 2),
    false,
  );
});

test("report: a stale review never leaks matched_fields into a later report", () => {
  const state = modelOf(REVIEW_CSV);
  const first = excludeServerMatch(
    seedServerMatches(state, serverResult([[2, ["email", "phone"]]])),
    2,
  );
  const before = JSON.parse((buildImportReport(first) as { text: string }).text);
  assert.deepEqual(before.rows[0].matched_fields, ["email", "phone"]);

  // A NEWER reconciliation no longer names line 2: the exclusion stays, the
  // match field names must NOT.
  const second = seedServerMatches(first, serverResult([[4, ["barcode"]]]));
  const after = JSON.parse((buildImportReport(second) as { text: string }).text);
  const row = after.rows.find((entry: { rowNumber: number }) => entry.rowNumber === 2);
  assert.deepEqual(row.reasons, ["excluded-by-user"], "no stale existing-value-match reason");
  assert.deepEqual(row.matched_fields, [], "no stale matched field names");
});

test("report: matched_fields carries NAMES only, never a value or an id", () => {
  const state = modelOf(REVIEW_CSV);
  const excluded = excludeServerMatch(
    seedServerMatches(state, serverResult([[2, ["email", "phone", "barcode"]]])),
    2,
  );
  const text = (buildImportReport(excluded) as { text: string }).text;
  const payload = JSON.parse(text);
  assert.deepEqual(payload.rows[0].matched_fields, ["email", "phone", "barcode"]);
  // The row's own values are the file's values, never a stored record's.
  assert.equal(payload.rows[0].email, "a@b.c");
  assert.equal(Object.prototype.hasOwnProperty.call(payload.rows[0], "id"), false);
  assert.equal(Object.prototype.hasOwnProperty.call(payload.rows[0], "matched_values"), false);
  // Nothing resembling a record identity is present anywhere in the document.
  assert.equal(/recordId|studentId|existingId/.test(text), false);
});

test("report: the combined document stays deterministic byte for byte", () => {
  const state = modelOf(REVIEW_CSV);
  const excluded = excludeServerMatch(
    seedServerMatches(state, serverResult([[2, ["email"]], [3, ["phone"]]])),
    2,
  );
  const once = (buildImportReport(excluded) as { text: string }).text;
  const twice = (buildImportReport(excluded) as { text: string }).text;
  assert.equal(once, twice);
  const payload = JSON.parse(once);
  assert.deepEqual(Object.keys(payload.rows[0]), [
    "rowNumber",
    "status",
    "name",
    "email",
    "phone",
    "guardian_phone",
    "grade",
    "barcode",
    "reasons",
    "matched_fields",
    "candidates",
  ]);
});

// ===========================================================================
// M2-15 — the review layer of the real component
// ===========================================================================

test("component: the review block is separate from the local conflicts and shows the counts", async () => {
  const preview = await previewStateFrom(PANEL_CSV);
  const controller = createImportResolutionController({});
  const server = createServerResolutionController({});
  try {
    controller.load(preview.rows);
    // Line 5 (Omar) is the only included row of this file.
    controller.seedServerMatches(serverResult([[5, ["email"]]]));
    const { html } = await renderPanel(
      preview, controller.getState(), controller, null, server, server.getState(),
    );

    // The server review has its OWN heading and its OWN counts.
    assert.match(html, /مراجعة التطابقات مع السجلات الموجودة/);
    assert.match(html, /قيد مراجعة التطابق: 1/);
    assert.match(html, /أُبقي مُدرجًا: 0/);
    assert.match(html, /مستبعَد بسبب التطابق: 0/);
    // The three counts are stated to be exclusive and to sum to the set size.
    assert.match(html, /المجموع 1 صف مطابق/);

    // The LOCAL within-file block is still its own, differently worded block.
    assert.match(html, /القرار محلي فقط/);
    assert.match(html, /لا يعني أن\s+السجل غير موجود في المنصة/);
    // The review block says it is not a within-file duplicate.
    assert.match(html, /وليست تكرارًا داخل هذا الملف/);
    // Both blocks exist and are NOT the same statement.
    assert.notEqual(
      html.indexOf("مراجعة التطابقات مع السجلات الموجودة"),
      html.indexOf("القرار محلي فقط"),
    );
  } finally {
    server.dispose();
    controller.dispose();
  }
});

test("component: the three review controls are explicit non-submit buttons", async () => {
  const preview = await previewStateFrom(PANEL_CSV);
  const controller = createImportResolutionController({});
  const server = createServerResolutionController({});
  try {
    controller.load(preview.rows);
    controller.seedServerMatches(serverResult([[5, ["email", "barcode"]]]));
    const { controls, html } = await renderPanel(
      preview, controller.getState(), controller, null, server, server.getState(),
    );

    for (const label of ["إبقاء مُدرجًا", "استبعاد بسبب التطابق", "تراجع"]) {
      const control = controls.find((entry) => entry.text.trim() === label);
      assert.ok(control, `the ${label} control exists`);
      assert.equal(control!.type, "button", `${label} must never submit a form`);
    }
    // No submit control exists anywhere in the panel.
    assert.equal(controls.some((entry) => entry.type === "submit"), false);
    // The review controls belong to the matched physical row only.
    assert.match(html, /data-review-row="5"/);
    assert.equal(/data-review-row="(2|3|4)"/.test(html), false);
  } finally {
    server.dispose();
    controller.dispose();
  }
});

test("component: the real review controls drive the real review model", async () => {
  const preview = await previewStateFrom(PANEL_CSV);
  const controller = createImportResolutionController({});
  const server = createServerResolutionController({});
  try {
    controller.load(preview.rows);
    controller.seedServerMatches(serverResult([[5, ["email"]]]));
    const { controls } = await renderPanel(
      preview, controller.getState(), controller, null, server, server.getState(),
    );

    const keep = controls.find((entry) => entry.text.trim() === "إبقاء مُدرجًا");
    assert.ok(keep);
    assert.equal(Boolean(keep!.disabled), false, "a pending review can be kept");
    keep!.onClick();
    assert.equal(controller.getState().serverMatches.get(5)?.review, "kept");
    assert.equal(statusOf(controller.getState(), 5), "included", "keeping changes no decision");

    const exclude = controls.find((entry) => entry.text.trim() === "استبعاد بسبب التطابق");
    assert.ok(exclude);
    exclude!.onClick();
    assert.equal(controller.getState().serverMatches.get(5)?.review, "excluded");
    assert.equal(statusOf(controller.getState(), 5), "excluded", "the match became a decision");
    assert.equal(controller.getState().counts.excluded, 1);

    const undo = controls.find((entry) => entry.text.trim() === "تراجع");
    assert.ok(undo);
    undo!.onClick();
    assert.equal(controller.getState().serverMatches.get(5)?.review, "pending");
    assert.equal(statusOf(controller.getState(), 5), "included", "an undo re-includes the row");
  } finally {
    server.dispose();
    controller.dispose();
  }
});

test("component: a review state disables the control it would duplicate", async () => {
  const preview = await previewStateFrom(PANEL_CSV);
  const controller = createImportResolutionController({});
  const server = createServerResolutionController({});
  try {
    controller.load(preview.rows);
    controller.seedServerMatches(serverResult([[5, ["email"]]]));
    controller.keepServerMatch(5);
    const kept = await renderPanel(
      preview, controller.getState(), controller, null, server, server.getState(),
    );
    const keptKeep = kept.controls.find((entry) => entry.text.trim() === "إبقاء مُدرجًا");
    assert.equal(Boolean(keptKeep?.disabled), true, "a kept review cannot be kept twice");
    const keptUndo = kept.controls.find((entry) => entry.text.trim() === "تراجع");
    assert.equal(Boolean(keptUndo?.disabled), false, "a kept review can be undone");

    controller.excludeServerMatch(5);
    const excluded = await renderPanel(
      preview, controller.getState(), controller, null, server, server.getState(),
    );
    const excludedExclude = excluded.controls.find(
      (entry) => entry.text.trim() === "استبعاد بسبب التطابق",
    );
    assert.equal(Boolean(excludedExclude?.disabled), true);
    const excludedKeep = excluded.controls.find((entry) => entry.text.trim() === "إبقاء مُدرجًا");
    assert.equal(
      Boolean(excludedKeep?.disabled),
      true,
      "an excluded row must be undone, never silently kept",
    );
  } finally {
    server.dispose();
    controller.dispose();
  }
});

test("component: the matched row shows its matched fields and its review state", async () => {
  const preview = await previewStateFrom(PANEL_CSV);
  const controller = createImportResolutionController({});
  const server = createServerResolutionController({});
  try {
    controller.load(preview.rows);
    controller.seedServerMatches(serverResult([[5, ["email", "barcode"]]]));
    const pending = await renderPanel(
      preview, controller.getState(), controller, null, server, server.getState(),
    );
    assert.match(pending.html, /موجود مسبقًا في مؤسستك:/);
    assert.match(pending.html, /البريد الإلكتروني، الباركود/);
    assert.match(pending.html, /حالة المراجعة: قيد مراجعة التطابق/);

    controller.excludeServerMatch(5);
    const excluded = await renderPanel(
      preview, controller.getState(), controller, null, server, server.getState(),
    );
    assert.match(excluded.html, /حالة المراجعة: مستبعَد بسبب التطابق/);
  } finally {
    server.dispose();
    controller.dispose();
  }
});

test("component: no review block renders when the review set is empty", async () => {
  const preview = await previewStateFrom(PANEL_CSV);
  const controller = createImportResolutionController({});
  const server = createServerResolutionController({});
  try {
    controller.load(preview.rows);
    const { html, controls } = await renderPanel(
      preview, controller.getState(), controller, null, server, server.getState(),
    );
    assert.equal(html.includes("data-review-row"), false);
    assert.equal(html.includes("مراجعة التطابقات مع السجلات الموجودة"), false);
    assert.equal(
      controls.some((entry) => entry.text.trim() === "إبقاء مُدرجًا"),
      false,
      "a panel with no match offers no match control",
    );
    // The decision layer itself is untouched.
    assert.match(html, /إعادة ضبط القرارات/);
    assert.match(html, /إغلاق المعاينة/);
  } finally {
    server.dispose();
    controller.dispose();
  }
});
