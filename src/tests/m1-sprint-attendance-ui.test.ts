/**
 * M1 attendance UI — isolated production-path regression tests.
 *
 * Runner: node:test via tsx (`npx tsx --test src/tests/m1-sprint-attendance-ui.test.ts`).
 * No DOM/jsdom, no env files, no database, no network, no live services, no
 * application startup.
 *
 * Scope of production code exercised: the shared attendance helpers exported
 * by src/pages/QRAttendance.tsx. That module is the single source of truth for
 * the attendance pages (Attendance.tsx, AttendanceLog.tsx, BarcodeAttendance.tsx
 * all import from it):
 *   - sanitizeBarcode / formatLocalDate        (normalization + local date keys)
 *   - createSubmissionGuard                    (duplicate scan/submission suppression)
 *   - createResponseSequence                   (stale response / scope-change guard)
 *   - classifyAttendanceError                  (server rejection vs auth vs network)
 *   - processBarcodeScan (injected deps)       (allow / reject / failure pipeline)
 *
 * Isolation: QRAttendance.tsx also imports its React component graph. Two of
 * those imports cannot load under node — @/lib/api-http reads import.meta.env
 * at module init, and @/components/Header pulls the whole app shell. They are
 * replaced with inert stubs through a resolve hook so the REAL exported
 * functions still load and run unmodified. Every test injects its own
 * dependencies; nothing here touches env, a DB, the network, or a browser.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { registerHooks } from "node:module";

// ---------------------------------------------------------------------------
// Isolation: stub only the component-graph imports that cannot load under node.
// ---------------------------------------------------------------------------
const STUBS: Record<string, string> = {
  "@/lib/api-http": [
    "export const getStudents = async () => [];",
    "export const getGroups = async () => [];",
    "export const getAttendanceByDate = async () => [];",
    "export const markAttendance = async () => ({});",
    "export const getAttendance = async () => [];",
    "export const getCourses = async () => [];",
    "export const getGrades = async () => [];",
  ].join("\n"),
  "@/components/Header": "export default function Header() { return null; }",
};

registerHooks({
  resolve(specifier, context, nextResolve) {
    const stub = STUBS[specifier];
    if (stub) {
      return { url: "data:text/javascript," + encodeURIComponent(stub), shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
});

// ---------------------------------------------------------------------------
// Import the real production module (after the stubs are registered).
// ---------------------------------------------------------------------------
const attendance = await import("../pages/QRAttendance");
const {
  BARCODE_LENGTH,
  sanitizeBarcode,
  formatLocalDate,
  createSubmissionGuard,
  createResponseSequence,
  classifyAttendanceError,
  processBarcodeScan,
} = attendance;

const VALID_BARCODE = "YX6CKWVPB835S2HPKSP57R9PO"; // 25 chars, matches BARCODE_LENGTH
const STUDENT = { id: "s1", name: "طالب تجريبي", barcode: VALID_BARCODE };
const SCAN_DATE = new Date(2026, 9, 16); // 2026-10-16, local

// ---------------------------------------------------------------------------
// Module / export sanity — proves the real page module loaded, not file text.
// ---------------------------------------------------------------------------
test("real attendance page module loads and exports the shared helpers", () => {
  assert.equal(typeof attendance.default, "function");
  assert.equal(typeof processBarcodeScan, "function");
  assert.equal(typeof classifyAttendanceError, "function");
  assert.equal(BARCODE_LENGTH, 25);
});

// ---------------------------------------------------------------------------
// Normalization helpers
// ---------------------------------------------------------------------------
test("sanitizeBarcode strips non-alphanumerics and uppercases", () => {
  assert.equal(sanitizeBarcode("ab-12 cd!@#"), "AB12CD");
  assert.equal(sanitizeBarcode("yx6ckwvpb835s2hpksp57r9po"), VALID_BARCODE);
  assert.equal(sanitizeBarcode("   "), "");
});

test("formatLocalDate returns a local YYYY-MM-DD key (no UTC shift)", () => {
  assert.equal(formatLocalDate(new Date(2026, 9, 16, 0, 0, 0)), "2026-10-16");
  assert.equal(formatLocalDate(new Date(2026, 0, 1, 23, 59, 59)), "2026-01-01");
  assert.equal(formatLocalDate(new Date(2026, 0, 9)), "2026-01-09"); // zero padding
  assert.equal(formatLocalDate("2026-03-05T10:20:30"), "2026-03-05");
});

// ---------------------------------------------------------------------------
// Duplicate scan/submission suppression
// ---------------------------------------------------------------------------
test("submission guard rejects a duplicate in-flight attempt and allows after release", () => {
  const guard = createSubmissionGuard();
  assert.equal(guard.busy, false);

  assert.equal(guard.tryAcquire(), true); // first scan allowed
  assert.equal(guard.busy, true);
  assert.equal(guard.tryAcquire(), false); // duplicate scan dropped while in flight
  assert.equal(guard.tryAcquire(), false); // still dropped

  guard.release();
  assert.equal(guard.busy, false);
  assert.equal(guard.tryAcquire(), true); // a later, separate scan is allowed
  guard.release();
});

// ---------------------------------------------------------------------------
// Stale response / selected-scope changes
// ---------------------------------------------------------------------------
test("response sequence flags superseded (stale) responses", () => {
  const seq = createResponseSequence();

  const first = seq.next();
  assert.equal(seq.isCurrent(first), true);

  const second = seq.next(); // e.g. the user changed the selected date/scope
  assert.equal(seq.isCurrent(first), false); // older response must be ignored
  assert.equal(seq.isCurrent(second), true);
});

// ---------------------------------------------------------------------------
// Error classification: server rejection vs auth vs network vs duplicate
// ---------------------------------------------------------------------------
test("classifyAttendanceError maps axios-style status codes", () => {
  const axiosLike = (status: number, data?: unknown) => ({ response: { status, data } });
  assert.equal(classifyAttendanceError(axiosLike(409)).kind, "duplicate");
  assert.equal(classifyAttendanceError(axiosLike(401)).kind, "auth");
  assert.equal(classifyAttendanceError(axiosLike(403)).kind, "auth");
  assert.equal(classifyAttendanceError(axiosLike(400)).kind, "validation");
  assert.equal(classifyAttendanceError(axiosLike(404)).kind, "not_found");
  assert.equal(classifyAttendanceError(axiosLike(500)).kind, "server");
  assert.equal(classifyAttendanceError(new Error("socket hang up")).kind, "network");
});

test("classifyAttendanceError reads the shared HTTP client contract (Error text)", () => {
  // src/lib/api-http.ts throws Error(`HTTP ${status}`) when the server sends no text.
  assert.equal(classifyAttendanceError(new Error("HTTP 401")).kind, "auth");
  assert.equal(classifyAttendanceError(new Error("HTTP 500")).kind, "server");
  // ...or Error(serverMessage) when the server sends one.
  const duplicate = classifyAttendanceError(new Error("Attendance already recorded for this date"));
  assert.equal(duplicate.kind, "duplicate");
  assert.equal(duplicate.serverMessage, "Attendance already recorded for this date");
});

test("classifyAttendanceError keeps a safe fallback message but surfaces the server text", () => {
  const err = { response: { status: 400, data: { error: "student_id is required" } } };
  const classified = classifyAttendanceError(err);
  assert.equal(classified.kind, "validation");
  assert.equal(classified.status, 400);
  assert.equal(classified.serverMessage, "student_id is required");
  assert.ok(classified.message.length > 0); // always displayable
});

// ---------------------------------------------------------------------------
// Barcode scan pipeline with injected dependencies (allow / reject / failure)
// ---------------------------------------------------------------------------
interface ScanCalls {
  loadedStudents: number;
  loadedRecords: number;
  marked: Array<{ barcode: string; date: Date }>;
}

const makeDeps = (
  overrides: Partial<{
    loadStudents: () => Promise<Array<{ id: string; name: string; barcode?: string | null }>>;
    loadAttendanceForDate: (date: Date) => Promise<Array<{ student_id: string; attendance_date: string | Date }>>;
    markAttendance: (barcode: string, date: Date) => Promise<unknown>;
  }> = {},
) => {
  const calls: ScanCalls = { loadedStudents: 0, loadedRecords: 0, marked: [] };
  const deps = {
    loadStudents: async () => {
      calls.loadedStudents += 1;
      return [STUDENT];
    },
    loadAttendanceForDate: async () => {
      calls.loadedRecords += 1;
      return [];
    },
    markAttendance: async (barcode: string, date: Date) => {
      calls.marked.push({ barcode, date });
      return { ok: true };
    },
    ...overrides,
  };
  return { deps, calls };
};

test("processBarcodeScan records a valid, not-yet-recorded scan (allow)", async () => {
  const { deps, calls } = makeDeps();

  const outcome = await processBarcodeScan(
    { barcode: "yx6ckwvp-b835s2hpksp57r9po", date: SCAN_DATE }, // messy scanner input
    deps,
  );

  assert.deepEqual(outcome, { kind: "recorded", studentName: STUDENT.name });
  assert.equal(calls.marked.length, 1);
  assert.equal(calls.marked[0].barcode, VALID_BARCODE); // sanitized before POST
});

test("processBarcodeScan rejects a duplicate same-day record without re-posting (reject)", async () => {
  // Regression: attendance_date arrives as a datetime string. The old code
  // compared it raw against the date key, which never matched, so a second
  // scan produced a duplicate row. The pipeline must compare normalized local
  // date keys and refuse to POST again.
  const { deps, calls } = makeDeps({
    loadAttendanceForDate: async () => [
      { student_id: STUDENT.id, attendance_date: "2026-10-16T08:30:00" },
    ],
  });

  const outcome = await processBarcodeScan({ barcode: VALID_BARCODE, date: SCAN_DATE }, deps);

  assert.deepEqual(outcome, { kind: "duplicate", studentName: STUDENT.name });
  assert.equal(calls.marked.length, 0); // must NOT post a duplicate
});

test("processBarcodeScan does not treat another day's record as a duplicate", async () => {
  const { deps, calls } = makeDeps({
    loadAttendanceForDate: async () => [
      { student_id: STUDENT.id, attendance_date: "2026-10-15T08:30:00" },
    ],
  });

  const outcome = await processBarcodeScan({ barcode: VALID_BARCODE, date: SCAN_DATE }, deps);

  assert.equal(outcome.kind, "recorded");
  assert.equal(calls.marked.length, 1);
});

test("processBarcodeScan rejects a malformed barcode before any lookup", async () => {
  const { deps, calls } = makeDeps();

  const outcome = await processBarcodeScan({ barcode: "short", date: SCAN_DATE }, deps);

  assert.deepEqual(outcome, { kind: "invalid_length", expected: 25, actual: 5 });
  assert.equal(calls.loadedStudents, 0);
  assert.equal(calls.marked.length, 0);
});

test("processBarcodeScan reports an unknown barcode without posting", async () => {
  const { deps, calls } = makeDeps();

  const outcome = await processBarcodeScan({ barcode: "A".repeat(25), date: SCAN_DATE }, deps);

  assert.deepEqual(outcome, { kind: "unknown_barcode" });
  assert.equal(calls.marked.length, 0);
});

test("processBarcodeScan classifies a network failure instead of reporting success", async () => {
  const { deps } = makeDeps({
    markAttendance: async () => {
      throw new Error("socket hang up");
    },
  });

  const outcome = await processBarcodeScan({ barcode: VALID_BARCODE, date: SCAN_DATE }, deps);

  assert.equal(outcome.kind, "error");
  if (outcome.kind === "error") {
    assert.equal(outcome.classified.kind, "network");
  }
});

test("processBarcodeScan surfaces a server rejection (409 duplicate) as a failure, not success", async () => {
  const { deps } = makeDeps({
    markAttendance: async () => {
      throw { response: { status: 409, data: { error: "already recorded" } } };
    },
  });

  const outcome = await processBarcodeScan({ barcode: VALID_BARCODE, date: SCAN_DATE }, deps);

  assert.equal(outcome.kind, "error");
  if (outcome.kind === "error") {
    assert.equal(outcome.classified.kind, "duplicate");
    assert.equal(outcome.classified.status, 409);
  }
});
