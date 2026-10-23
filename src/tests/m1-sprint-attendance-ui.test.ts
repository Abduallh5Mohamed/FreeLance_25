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
 *   - createKeyedSubmissionGuard               (per-student synchronous single-flight)
 *   - createResponseSequence (+ invalidate)    (stale response / scope-change/clear)
 *   - classifyAttendanceError                  (server rejection vs auth vs network)
 *   - resolveGuardianPhone                     (canonical guardian_phone resolution)
 *   - submitAttendanceMark (injected deps)     (single-flight mark + fail-closed refresh)
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
    "export const clearAuthToken = () => {};",
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
  createKeyedSubmissionGuard,
  createResponseSequence,
  classifyAttendanceError,
  resolveGuardianPhone,
  processBarcodeScan,
  submitAttendanceMark,
} = attendance;

const VALID_BARCODE = "YX6CKWVPB835S2HPKSP57R9PO"; // 25 chars, matches BARCODE_LENGTH
const STUDENT = { id: "s1", name: "طالب تجريبي", barcode: VALID_BARCODE };
// Explicit UTC instant (Cairo 11:00 mid-day, supervisor/026): a fixed
// instant, not a host-local Date, so the Africa/Cairo day key is identical
// on every test host.
const SCAN_DATE = new Date("2026-10-16T09:00:00Z");

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
// Guardian contact resolution (AttendanceLog WhatsApp report)
// ---------------------------------------------------------------------------
test("resolveGuardianPhone returns the canonical guardian_phone, trimmed", () => {
  // Regression: AttendanceLog.tsx referenced the undeclared `student.parent_phone`
  // (TS2339). The canonical field the /students endpoint returns is
  // `guardian_phone`; the resolver must read exactly that.
  assert.equal(resolveGuardianPhone({ guardian_phone: "01012345678" }), "01012345678");
  assert.equal(resolveGuardianPhone({ guardian_phone: "  01012345678  " }), "01012345678");
});

test("resolveGuardianPhone fails closed for a legacy record that only has parent_phone", () => {
  // Legacy `parent_phone` is intentionally not a second source of truth: the
  // backend contract exposes guardian_phone only, so a record without it has no
  // usable contact (the caller then shows "رقم ولي الأمر غير متوفر").
  const legacyOnly = { name: "طالب قديم", phone: "01111111111", parent_phone: "01099999999" };
  assert.equal(resolveGuardianPhone(legacyOnly), "");
});

test("resolveGuardianPhone treats missing / blank / nullish contact as absent", () => {
  assert.equal(resolveGuardianPhone({ guardian_phone: "" }), "");
  assert.equal(resolveGuardianPhone({ guardian_phone: "   " }), "");
  assert.equal(resolveGuardianPhone({}), "");
  assert.equal(resolveGuardianPhone(null), "");
  assert.equal(resolveGuardianPhone(undefined), "");
});

// ---------------------------------------------------------------------------
// Selected-scope handling: a superseded fetch must not overwrite newer state
// (mirrors AttendanceLog.tsx / Attendance.tsx fetch guards)
// ---------------------------------------------------------------------------
test("scope guard ignores a superseded fetch and only applies the current one", () => {
  const seq = createResponseSequence();
  // Model the page state: only the current token may commit data / clear loading.
  let applied: string | null = null;
  let loading = false;

  const applyIfCurrent = (token: number, data: string) => {
    if (!seq.isCurrent(token)) return; // stale response dropped
    applied = data;
    loading = false;
  };

  // User picks student A, then immediately switches to student B.
  const tokenA = seq.next();
  loading = true;
  const tokenB = seq.next();
  loading = true;

  // B's request resolves first, then A's older response arrives late.
  applyIfCurrent(tokenB, "B-records");
  applyIfCurrent(tokenA, "A-records"); // must be ignored

  assert.equal(applied, "B-records");
  assert.equal(loading, false);
});

// ---------------------------------------------------------------------------
// Scope clear: deselection must invalidate an in-flight fetch even when NO
// replacement request starts. AttendanceLog.tsx calls
// attendanceSequence.invalidate() on student deselection and
// groupsSequence/studentsSequence.invalidate() on grade/group clear.
// ---------------------------------------------------------------------------
test("scope clear invalidates an in-flight fetch that has no replacement request", () => {
  const seq = createResponseSequence();
  let records: string[] = [];
  const token = seq.next(); // fetch for the selected student starts
  // User clears the selection: the page empties the rows and invalidates.
  seq.invalidate();
  records = [];
  // The old request completes late: it must NOT restore rows for a scope that
  // is no longer selected, even though no new request was started.
  if (seq.isCurrent(token)) records = ["late-old-row"];
  assert.deepEqual(records, []);
});

test("invalidate() supersedes outstanding tokens; the next() request stays current", () => {
  const seq = createResponseSequence();
  const stale = seq.next();
  assert.equal(seq.isCurrent(stale), true);
  seq.invalidate();
  assert.equal(seq.isCurrent(stale), false); // cleared: outstanding token is stale
  const fresh = seq.next();
  assert.equal(seq.isCurrent(fresh), true);
  assert.equal(seq.isCurrent(stale), false);
});

test("group and student list loaders drop responses for a cleared scope", () => {
  const groupsSeq = createResponseSequence();
  const studentsSeq = createResponseSequence();
  let groups: string[] = [];
  let students: string[] = [];
  const gToken = groupsSeq.next(); // groups load in flight
  const sToken = studentsSeq.next(); // students load in flight
  // Both scopes are cleared before either list resolves.
  groupsSeq.invalidate();
  studentsSeq.invalidate();
  if (groupsSeq.isCurrent(gToken)) groups = ["stale-group"];
  if (studentsSeq.isCurrent(sToken)) students = ["stale-student"];
  assert.deepEqual(groups, []);
  assert.deepEqual(students, []);
});

test("a superseded fetch with reversed completion keeps only the newest scope", () => {
  const seq = createResponseSequence();
  let records: string[] = [];
  const tokenA = seq.next(); // select student A
  const tokenB = seq.next(); // immediately switch to student B
  if (seq.isCurrent(tokenB)) records = ["B-row"]; // B resolves first
  if (seq.isCurrent(tokenA)) records = ["A-row"]; // A resolves late -> ignored
  assert.deepEqual(records, ["B-row"]);
});

// ---------------------------------------------------------------------------
// Single-flight attendance submission (Attendance.tsx handleMarkAttendance):
// the synchronous keyed guard must collapse two same-tick calls for one
// student to a single write, while a later retry or another student is allowed.
// ---------------------------------------------------------------------------
const makeMarkDeps = () => {
  const calls = { mark: 0, refresh: 0 };
  const deps = {
    markAttendance: async () => {
      calls.mark += 1;
      return "rec-1";
    },
    refreshAttendance: async () => {
      calls.refresh += 1;
    },
  };
  return { deps, calls };
};

test("submitAttendanceMark collapses two same-tick submissions for one student to one write", async () => {
  const guard = createKeyedSubmissionGuard();
  const { deps, calls } = makeMarkDeps();
  const request = { studentId: "s1", status: "present" as const, date: SCAN_DATE };

  const [first, second] = await Promise.all([
    submitAttendanceMark(request, deps, guard),
    submitAttendanceMark(request, deps, guard),
  ]);

  assert.equal(calls.mark, 1); // the same-tick duplicate did NOT issue a second write
  assert.equal(calls.refresh, 1);
  assert.deepEqual([first.kind, second.kind].sort(), ["ignored", "recorded"]);
});

test("submitAttendanceMark allows a later retry and an independent student", async () => {
  const guard = createKeyedSubmissionGuard();
  const { deps, calls } = makeMarkDeps();
  const request = { studentId: "s1", status: "present" as const, date: SCAN_DATE };

  const first = await submitAttendanceMark(request, deps, guard);
  assert.equal(first.kind, "recorded");
  assert.equal(guard.isBusy("s1"), false); // released after completion

  const retry = await submitAttendanceMark(request, deps, guard);
  assert.equal(retry.kind, "recorded"); // a later, separate submission is allowed

  const other = await submitAttendanceMark({ ...request, studentId: "s2" }, deps, guard);
  assert.equal(other.kind, "recorded"); // another student is not blocked

  assert.equal(calls.mark, 3);
});

test("submitAttendanceMark refreshes server state and classifies a duplicate rejection", async () => {
  const guard = createKeyedSubmissionGuard();
  const calls = { refresh: 0 };
  const deps = {
    markAttendance: async () => {
      throw { response: { status: 409, data: { error: "already recorded" } } };
    },
    refreshAttendance: async () => {
      calls.refresh += 1;
    },
  };

  const outcome = await submitAttendanceMark(
    { studentId: "s1", status: "present", date: SCAN_DATE },
    deps,
    guard,
  );

  assert.equal(outcome.kind, "duplicate");
  if (outcome.kind === "duplicate") assert.equal(outcome.classified.kind, "duplicate");
  assert.equal(calls.refresh, 1); // server rows re-read, no false success
  assert.equal(guard.isBusy("s1"), false); // released -> retry stays actionable
});

test("submitAttendanceMark classifies a network failure, refreshes, and releases", async () => {
  const guard = createKeyedSubmissionGuard();
  const calls = { refresh: 0 };
  const deps = {
    markAttendance: async () => {
      throw new Error("socket hang up");
    },
    refreshAttendance: async () => {
      calls.refresh += 1;
    },
  };

  const outcome = await submitAttendanceMark(
    { studentId: "s1", status: "absent", date: SCAN_DATE },
    deps,
    guard,
  );

  assert.equal(outcome.kind, "error");
  if (outcome.kind === "error") assert.equal(outcome.classified.kind, "network");
  assert.equal(calls.refresh, 1);
  assert.equal(guard.isBusy("s1"), false);
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
      { student_id: STUDENT.id, attendance_date: "2026-10-16T08:30:00Z" },
    ],
  });

  const outcome = await processBarcodeScan({ barcode: VALID_BARCODE, date: SCAN_DATE }, deps);

  assert.deepEqual(outcome, { kind: "duplicate", studentName: STUDENT.name });
  assert.equal(calls.marked.length, 0); // must NOT post a duplicate
});

test("processBarcodeScan does not treat another day's record as a duplicate", async () => {
  const { deps, calls } = makeDeps({
    loadAttendanceForDate: async () => [
      { student_id: STUDENT.id, attendance_date: "2026-10-15T08:30:00Z" },
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

// ---------------------------------------------------------------------------
// BarcodeAttendance.tsx — canonical authentication contract, fail-closed
// request construction, failed-scan retention and group-scope staleness.
//
// Regression: the page read `localStorage.token` at eight protected call
// sites while the canonical client (src/lib/api-http.ts) reads `authToken`, so
// every request went out unauthenticated (or as `Bearer null`).
// ---------------------------------------------------------------------------
const barcodePage = await import("../pages/BarcodeAttendance");
const {
  AUTH_TOKEN_STORAGE_KEY,
  MissingAuthTokenError,
  isMissingAuthTokenError,
  readAuthToken,
  createProtectedTransport,
  classifyBarcodeScanError,
  shouldClearBarcodeInputAfterFailure,
  createScopedResponseGuard,
  createBarcodeAttendanceController,
  describePaymentPresentation,
  describeLastAttendancePresentation,
} = barcodePage;

/** Minimal in-memory Storage stand-in; no browser, no globals. */
const fakeStorage = (initial: Record<string, string> = {}) => {
  const map = new Map(Object.entries(initial));
  return {
    getItem: (key: string) => (map.has(key) ? (map.get(key) as string) : null),
    setItem: (key: string, value: string) => void map.set(key, value),
    removeItem: (key: string) => void map.delete(key),
  } as unknown as Storage;
};

test("barcode page module loads and exports its auth/failure helpers", () => {
  assert.equal(typeof barcodePage.default, "function");
  assert.equal(typeof createProtectedTransport, "function");
  assert.equal(typeof classifyBarcodeScanError, "function");
});

test("readAuthToken reads the canonical authToken key and ignores the legacy token key", () => {
  assert.equal(AUTH_TOKEN_STORAGE_KEY, "authToken");
  assert.equal(readAuthToken(fakeStorage({ authToken: "tok-1" })), "tok-1");
  // The legacy key is not a session source: it must not authenticate anything.
  assert.equal(readAuthToken(fakeStorage({ token: "legacy-1" })), null);
  assert.equal(readAuthToken(fakeStorage({ authToken: "   " })), null);
  assert.equal(readAuthToken(fakeStorage({})), null);
});

test("protected transport attaches the canonical bearer token on GET and POST", async () => {
  const seen: Array<{ method: string; url: string; config: any; data?: any }> = [];
  const http = {
    get: async (url: string, config: any) => {
      seen.push({ method: "GET", url, config });
      return { data: [] };
    },
    post: async (url: string, data: any, config: any) => {
      seen.push({ method: "POST", url, data, config });
      return { data: {} };
    },
  };
  const transport = createProtectedTransport({
    http,
    getToken: () => readAuthToken(fakeStorage({ authToken: "tok-42" })),
  });

  await transport.get("/api/attendance", { params: { date: "2026-10-16", group_id: "g1" } });
  await transport.post("/api/attendance", { student_id: "s1" });

  assert.equal(seen.length, 2);
  assert.equal(seen[0].method, "GET");
  assert.equal(seen[0].config.headers.Authorization, "Bearer tok-42");
  assert.deepEqual(seen[0].config.params, { date: "2026-10-16", group_id: "g1" });
  assert.equal(seen[1].method, "POST");
  assert.equal(seen[1].config.headers.Authorization, "Bearer tok-42");
  assert.deepEqual(seen[1].data, { student_id: "s1" });
});

test("protected transport fails closed with no token and issues NO request", async () => {
  let transportCalls = 0;
  const http = {
    get: async () => {
      transportCalls += 1;
      return { data: [] };
    },
    post: async () => {
      transportCalls += 1;
      return { data: {} };
    },
  };
  // Only the legacy key is present, so the canonical session is missing.
  const transport = createProtectedTransport({
    http,
    getToken: () => readAuthToken(fakeStorage({ token: "legacy-1" })),
  });

  await assert.rejects(
    () => transport.get("/api/groups"),
    (error: unknown) => error instanceof MissingAuthTokenError && isMissingAuthTokenError(error),
  );
  await assert.rejects(
    () => transport.post("/api/attendance", { student_id: "s1" }),
    (error: unknown) => isMissingAuthTokenError(error),
  );

  assert.equal(transportCalls, 0); // never `Bearer null`, never an unauthenticated call
});

test("classifyBarcodeScanError separates a missing session from 401/403 and server rejections", () => {
  assert.equal(classifyBarcodeScanError(new MissingAuthTokenError()).kind, "missing_token");
  assert.equal(classifyBarcodeScanError({ response: { status: 401 } }).kind, "auth");
  assert.equal(classifyBarcodeScanError({ response: { status: 403 } }).kind, "auth");
  assert.equal(classifyBarcodeScanError(new Error("HTTP 401")).kind, "auth");
  assert.equal(
    classifyBarcodeScanError({ response: { status: 409, data: { error: "already recorded" } } }).kind,
    "duplicate",
  );
  assert.equal(classifyBarcodeScanError(new Error("socket hang up")).kind, "network");
  assert.equal(classifyBarcodeScanError({ response: { status: 500 } }).kind, "server");

  // A rejection is never reported as a success: every classification carries a
  // displayable message and a failure kind.
  for (const error of [
    new MissingAuthTokenError(),
    { response: { status: 401 } },
    { response: { status: 403 } },
    { response: { status: 500 } },
  ]) {
    const classified = classifyBarcodeScanError(error);
    assert.ok(classified.message.length > 0);
    assert.notEqual(classified.kind, "duplicate" as never);
  }
});

test("a failed scan keeps the barcode for retry; only an already-recorded scan clears it", () => {
  assert.equal(shouldClearBarcodeInputAfterFailure("duplicate"), true);
  for (const kind of ["missing_token", "auth", "validation", "not_found", "server", "network"] as const) {
    assert.equal(shouldClearBarcodeInputAfterFailure(kind), false);
  }
});

test("group-scoped loader guard drops a late response and a stale failure for a superseded group", () => {
  const guard = createScopedResponseGuard();
  let records: string[] = [];
  let loading = false;
  let failureShown = false;

  const tokenA = guard.begin("group-A"); // load for the selected group A
  loading = true;
  const tokenB = guard.begin("group-B"); // user switches to group B
  loading = true;

  // B resolves first, then A's older response arrives late.
  if (guard.isCurrent(tokenB, "group-B")) {
    records = ["B-row"];
    loading = false;
  }
  if (guard.isCurrent(tokenA, "group-B")) {
    records = ["A-row"];
    loading = false;
  }
  assert.deepEqual(records, ["B-row"]);
  assert.equal(loading, false);

  // A failure of the superseded load must not surface as the current state.
  if (guard.isCurrent(tokenA, "group-B")) failureShown = true;
  assert.equal(failureShown, false);
  assert.equal(guard.isCurrent(tokenB, "group-B"), true);
});

test("group-scoped loader guard retires an in-flight load when the scope is cleared", () => {
  const guard = createScopedResponseGuard();
  let records: string[] = ["previous-group-rows"];
  const token = guard.begin("group-A");
  // Group deselected: the page empties the rows and invalidates, WITHOUT
  // starting a replacement request.
  guard.invalidate();
  records = [];
  if (guard.isCurrent(token, "")) records = ["late-A-row"];
  assert.deepEqual(records, []);
});

// ---------------------------------------------------------------------------
// BarcodeAttendance rendering decisions (production helpers consumed by BOTH
// table consumers): explicit paid/unpaid/unknown states and honest
// unavailable previous-attendance. Regression: the absent table consumed the
// PaymentAvailability strings as booleans (unpaid/unknown rendered "paid" and
// hid the payment action) and rendered a failed previous-attendance lookup
// (_attended: null + _unavailable: true) as a confirmed absence.
// ---------------------------------------------------------------------------
test("describePaymentPresentation gives explicit states and only unpaid authorizes payment", () => {
  assert.deepEqual(describePaymentPresentation("paid"), { state: "paid", allowPayment: false });
  assert.deepEqual(describePaymentPresentation("unpaid"), { state: "unpaid", allowPayment: true });
  // 'unknown' (lookup failed) never implies paid/unpaid and never authorizes
  // a payment that could double-charge.
  assert.deepEqual(describePaymentPresentation("unknown"), { state: "unknown", allowPayment: false });
  // A never-loaded (missing) entry is unknown, not unpaid.
  assert.deepEqual(describePaymentPresentation(undefined), { state: "unknown", allowPayment: false });
});

test("describeLastAttendancePresentation renders a failed lookup as unavailable, never absent", () => {
  assert.deepEqual(describeLastAttendancePresentation(undefined), { state: "never" });
  assert.deepEqual(
    describeLastAttendancePresentation({ _scheduledDate: "2026-10-15", _attended: true, _unavailable: false }),
    { state: "attended" },
  );
  assert.deepEqual(
    describeLastAttendancePresentation({ _scheduledDate: "2026-10-15", _attended: false, _unavailable: false }),
    { state: "absent" },
  );
  // The controller marks a failed previous-attendance read with
  // _attended: null + _unavailable: true; it must NOT render "absent".
  assert.deepEqual(
    describeLastAttendancePresentation({ _scheduledDate: "2026-10-15", _attended: null, _unavailable: true }),
    { state: "unavailable" },
  );
  // Defensive: _attended null without the flag is still not a confirmed absence.
  assert.deepEqual(
    describeLastAttendancePresentation({ _scheduledDate: "2026-10-15", _attended: null, _unavailable: false }),
    { state: "unavailable" },
  );
});

// ---------------------------------------------------------------------------
// BarcodeAttendance production controller (group-scoped loader actually wired
// into the page), driven with an injected deferred transport and state sinks:
// A success, A->B with reversed completions, group clear without replacement,
// unmount invalidation, top-level 401/403/network failure, nested fees /
// previous-attendance failure and the honest absent computation.
// ---------------------------------------------------------------------------
interface DeferredCall {
  url: string;
  params: any;
  settle: (value?: any) => void;
  fail: (error: any) => void;
  resolved: boolean;
}

const makeControllerHarness = (options: {
  scope?: string;
  students?: any[];
  groups?: any[];
  now?: () => Date;
} = {}) => {
  const calls: DeferredCall[] = [];
  const http = {
    get: async (url: string, config?: any) => {
      const params = config?.params ?? {};
      return new Promise((resolve, reject) => {
        const call: DeferredCall = {
          url,
          params,
          resolved: false,
          settle: (value?: any) => {
            call.resolved = true;
            resolve({ data: value ?? [] });
          },
          fail: (error: any) => {
            call.resolved = true;
            reject(error);
          },
        };
        calls.push(call);
      });
    },
  };
  const students = options.students ?? [
    { id: "s1", name: "طالب A", group_id: "g1", is_active: true, phone: "0100" },
    { id: "s2", name: "طالب B", group_id: "g1", is_active: true, phone: "0111" },
  ];
  const groups = options.groups ?? [
    { id: "g1", schedule_days: ["sun", "mon", "tue", "wed", "thu", "fri", "sat"] },
    { id: "g2", schedule_days: ["sun", "mon", "tue", "wed", "thu", "fri", "sat"] },
  ];
  const state = {
    scope: options.scope ?? "g1",
    attendanceRows: [] as any[],
    absentRows: [] as any[],
    lastAttendance: {} as Record<string, any>,
    monthlyPayments: {} as Record<string, string>,
    todayLoad: { loading: false, error: null } as { loading: boolean; error: any },
    absentLoad: { loading: false, error: null } as { loading: boolean; error: any },
  };
  const controller = createBarcodeAttendanceController({
    http,
    apiUrl: "/api",
    readScope: () => state.scope,
    readStudents: () => students,
    readGroups: () => groups,
    now: options.now ?? (() => new Date("2026-10-16T09:00:00Z")), // Cairo 2026-10-16 11:00 (explicit instant)
    sinks: {
      setAttendanceRows: (rows) => {
        state.attendanceRows = rows;
      },
      setAbsentRows: (rows) => {
        state.absentRows = rows;
      },
      replaceLastAttendance: (map) => {
        state.lastAttendance = map;
      },
      replaceMonthlyPayments: (map) => {
        state.monthlyPayments = map;
      },
      setTodayLoad: (loadState) => {
        state.todayLoad = loadState;
      },
      setAbsentLoad: (loadState) => {
        state.absentLoad = loadState;
      },
    },
  });
  /** Settle a pending call and let the controller's awaits run. */
  const settleMain = async (index: number, rows: any[]) => {
    const call = calls[index];
    call.settle(rows);
    await new Promise((r) => setImmediate(r));
  };
  const failMain = async (index: number, error: any) => {
    const call = calls[index];
    call.fail(error);
    await new Promise((r) => setImmediate(r));
  };
  /** The index of the newest pending call matching a predicate. */
  const findCall = (predicate: (call: DeferredCall) => boolean) =>
    calls.findIndex(predicate);
  return { calls, controller, state, settleMain, failMain, findCall };
};

test("controller commits a successful today load with payment and previous-attendance maps", async () => {
  const h = makeControllerHarness();

  void h.controller.loadTodayAttendance();
  await new Promise((r) => setImmediate(r));
  assert.equal(h.calls.length, 1); // exactly one main attendance request
  assert.deepEqual(h.calls[0].params, { date: "2026-10-16", group_id: "g1" });

  h.calls[0].settle([{ id: "r1", student_id: "s1", status: "present" }]);
  await new Promise((r) => setImmediate(r));
  assert.equal(h.calls.length, 2); // nested fees lookup for the present record
  h.calls[1].settle([{ payment_year: 2026, payment_month: 10 }]); // paid this month
  await new Promise((r) => setImmediate(r));
  assert.equal(h.calls.length, 3); // nested previous-attendance lookup
  h.calls[2].settle([{ id: "r0", student_id: "s1", status: "present" }]);
  await new Promise((r) => setImmediate(r));

  assert.deepEqual(h.state.attendanceRows, [{ id: "r1", student_id: "s1", status: "present" }]);
  assert.deepEqual(h.state.monthlyPayments, { s1: "paid" });
  assert.equal(h.state.lastAttendance.s1._attended, true);
  assert.equal(h.state.lastAttendance.s1._unavailable, false);
  assert.equal(h.state.todayLoad.error, null);
});

// ---------------------------------------------------------------------------
// Africa/Cairo business-day contract (supervisor/026): the today load and the
// previous-scheduled-session lookup both key on the Cairo calendar day of the
// injected clock — identical for every operator, matching what the server
// records — instead of the host-local or UTC day, which disagree with Cairo
// between 21:00 and 24:00 UTC.
// ---------------------------------------------------------------------------

test("controller keys the today load and previous-session lookup on the Cairo business day", async () => {
  // 21:30Z on 2026-10-16 is already 2026-10-17 in Cairo (EEST, UTC+3) while
  // the UTC day is still 2026-10-16 — the old UTC/local keys recorded the
  // wrong day for every operator at this hour.
  const h = makeControllerHarness({ now: () => new Date("2026-10-16T21:30:00Z") });

  void h.controller.loadTodayAttendance();
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(h.calls[0].params, { date: "2026-10-17", group_id: "g1" });

  h.calls[0].settle([{ id: "r1", student_id: "s1", status: "present" }]);
  await new Promise((r) => setImmediate(r));
  h.calls[1].settle([{ payment_year: 2026, payment_month: 10 }]);
  await new Promise((r) => setImmediate(r));
  // Previous scheduled session before the Cairo day 2026-10-17 for an
  // every-day schedule is 2026-10-16 — a Cairo calendar-day walk-back, not
  // a host-local or UTC one.
  const previousCall = h.calls[2];
  assert.equal(previousCall.params.date, "2026-10-16");
  previousCall.settle([{ id: "r0", student_id: "s1", status: "present" }]);
  await new Promise((r) => setImmediate(r));
  assert.equal(h.state.lastAttendance.s1._scheduledDate, "2026-10-16");
});

test("scope change A->B clears the previous group's committed rows and maps immediately", async () => {
  const h = makeControllerHarness();

  // Successful load for group A.
  void h.controller.loadTodayAttendance();
  await new Promise((r) => setImmediate(r));
  h.calls[0].settle([{ id: "r1", student_id: "s1", status: "present" }]);
  await new Promise((r) => setImmediate(r));
  h.calls[1].settle([]); // fees: unpaid
  await new Promise((r) => setImmediate(r));
  h.calls[2].settle([]); // previous attendance: absent yesterday
  await new Promise((r) => setImmediate(r));
  assert.equal(h.state.attendanceRows.length, 1);

  // User switches to group B (the page calls resetScope before loading B):
  // committed A rows/maps must disappear WITHOUT waiting for B's response.
  h.state.scope = "g2";
  h.controller.resetScope();
  assert.deepEqual(h.state.attendanceRows, []);
  assert.deepEqual(h.state.monthlyPayments, {});
  assert.deepEqual(h.state.lastAttendance, {});
  assert.deepEqual(h.state.todayLoad, { loading: false, error: null });
});

test("A->B reversed completion keeps only group B's rows (late A response dropped)", async () => {
  const h = makeControllerHarness();

  // Load for A starts (main request pending).
  void h.controller.loadTodayAttendance();
  await new Promise((r) => setImmediate(r));
  assert.equal(h.calls[0].params.group_id, "g1");

  // User switches to B before A resolves: reset + fresh load.
  h.state.scope = "g2";
  h.controller.resetScope();
  void h.controller.loadTodayAttendance();
  await new Promise((r) => setImmediate(r));
  assert.equal(h.calls[1].params.group_id, "g2");

  // B resolves first and fully commits.
  h.calls[1].settle([{ id: "rB", student_id: "s1", status: "present" }]);
  await new Promise((r) => setImmediate(r));
  h.calls[2].settle([]); // fees for s1
  await new Promise((r) => setImmediate(r));
  h.calls[3].settle([{ id: "rB0", student_id: "s1", status: "present" }]);
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(h.state.attendanceRows, [{ id: "rB", student_id: "s1", status: "present" }]);

  // A's older response arrives late: it must NOT repopulate the rows/maps.
  h.calls[0].settle([{ id: "rA", student_id: "s1", status: "present" }]);
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(h.state.attendanceRows, [{ id: "rB", student_id: "s1", status: "present" }]);
  assert.equal(h.state.lastAttendance.s1._attended, true); // still B's map
});

test("a failed load for the selected scope retires old rows and shows an actionable error", async () => {
  const h = makeControllerHarness();

  // Successful load for A first.
  void h.controller.loadTodayAttendance();
  await new Promise((r) => setImmediate(r));
  h.calls[0].settle([{ id: "r1", student_id: "s1", status: "present" }]);
  await new Promise((r) => setImmediate(r));
  h.calls[1].settle([]);
  await new Promise((r) => setImmediate(r));
  h.calls[2].settle([]);
  await new Promise((r) => setImmediate(r));

  // Switch to B; B's load fails with 401.
  h.state.scope = "g2";
  h.controller.resetScope();
  void h.controller.loadTodayAttendance();
  await new Promise((r) => setImmediate(r));
  const bIndex = h.findCall((c) => c.params.group_id === "g2" && !c.resolved);
  h.calls[bIndex].fail({ response: { status: 401 } });
  await new Promise((r) => setImmediate(r));

  assert.deepEqual(h.state.attendanceRows, []); // old A rows must not linger
  assert.deepEqual(h.state.monthlyPayments, {});
  assert.equal(h.state.todayLoad.loading, false);
  assert.equal(h.state.todayLoad.error.kind, "auth");
});

test("a network failure of the selected scope's load clears rows and reports the failure", async () => {
  const h = makeControllerHarness();
  void h.controller.loadTodayAttendance();
  await new Promise((r) => setImmediate(r));
  h.calls[0].fail(new Error("socket hang up"));
  await new Promise((r) => setImmediate(r));

  assert.deepEqual(h.state.attendanceRows, []);
  assert.equal(h.state.todayLoad.loading, false);
  assert.equal(h.state.todayLoad.error.kind, "network");
});

test("a late failure of a superseded load never surfaces as the current state", async () => {
  const h = makeControllerHarness();

  void h.controller.loadTodayAttendance(); // A pending
  await new Promise((r) => setImmediate(r));
  h.state.scope = "g2";
  h.controller.resetScope();
  void h.controller.loadTodayAttendance(); // B
  await new Promise((r) => setImmediate(r));
  const bIndex = h.findCall((c) => c.params.group_id === "g2" && !c.resolved);
  h.calls[bIndex].settle([]); // B succeeds with no records
  await new Promise((r) => setImmediate(r));

  // A's load now fails: the failure must not appear on B's screen.
  h.calls[0].fail({ response: { status: 500 } });
  await new Promise((r) => setImmediate(r));
  assert.equal(h.state.todayLoad.error, null);
});

test("group clear without a replacement request retires the in-flight load", async () => {
  const h = makeControllerHarness();

  void h.controller.loadTodayAttendance();
  await new Promise((r) => setImmediate(r));
  // User deselects the group: scope cleared and guards invalidated, no new
  // request is issued.
  h.state.scope = "";
  h.controller.resetScope();
  h.calls[0].settle([{ id: "r1", student_id: "s1", status: "present" }]);
  await new Promise((r) => setImmediate(r));

  assert.deepEqual(h.state.attendanceRows, []);
  assert.equal(h.calls.length, 1); // no replacement request was started
});

test("unmount invalidation stops every outstanding load", async () => {
  const h = makeControllerHarness();

  void h.controller.loadTodayAttendance();
  await new Promise((r) => setImmediate(r));
  h.controller.invalidate(); // page unmount
  h.calls[0].settle([{ id: "r1", student_id: "s1", status: "present" }]);
  await new Promise((r) => setImmediate(r));

  assert.deepEqual(h.state.attendanceRows, []);
});

test("a scope change mid nested reads stops the superseded loop before committing maps", async () => {
  const h = makeControllerHarness();

  void h.controller.loadTodayAttendance();
  await new Promise((r) => setImmediate(r));
  h.calls[0].settle([{ id: "r1", student_id: "s1", status: "present" }]);
  await new Promise((r) => setImmediate(r));
  assert.equal(h.calls.length, 2); // nested fees lookup in flight

  // Scope changes while the nested read is pending, then it completes.
  h.state.scope = "g2";
  h.controller.resetScope();
  h.calls[1].settle([{ payment_year: 2026, payment_month: 10 }]);
  await new Promise((r) => setImmediate(r));

  // The superseded loop must not commit the payment map.
  assert.deepEqual(h.state.monthlyPayments, {});
  assert.deepEqual(h.state.attendanceRows, []);
});

test("a nested fees failure is unknown, never a confirmed unpaid", async () => {
  const h = makeControllerHarness();

  void h.controller.loadTodayAttendance();
  await new Promise((r) => setImmediate(r));
  h.calls[0].settle([{ id: "r1", student_id: "s1", status: "present" }]);
  await new Promise((r) => setImmediate(r));
  h.calls[1].fail(new Error("fees endpoint down")); // nested failure
  await new Promise((r) => setImmediate(r));
  h.calls[2].settle([]); // previous attendance: absent yesterday
  await new Promise((r) => setImmediate(r));

  assert.deepEqual(h.state.monthlyPayments, { s1: "unknown" });
  assert.equal(h.state.lastAttendance.s1._attended, false);
});

test("a failed previous-attendance lookup is unavailable, never a confirmed absence", async () => {
  const h = makeControllerHarness();

  void h.controller.loadTodayAttendance();
  await new Promise((r) => setImmediate(r));
  h.calls[0].settle([{ id: "r1", student_id: "s1", status: "present" }]);
  await new Promise((r) => setImmediate(r));
  h.calls[1].settle([]); // fees: unpaid (verified)
  await new Promise((r) => setImmediate(r));
  h.calls[2].fail({ response: { status: 403 } }); // previous read denied
  await new Promise((r) => setImmediate(r));

  assert.equal(h.state.lastAttendance.s1._unavailable, true);
  assert.equal(h.state.lastAttendance.s1._attended, null);
  // ...and the rendering decision must present it as unavailable, not absent.
  assert.equal(describeLastAttendancePresentation(h.state.lastAttendance.s1).state, "unavailable");
});

test("absent computation is honest: no successful today load means no absent rows and no request", async () => {
  const h = makeControllerHarness();

  // Without a successful today load we cannot know who is absent; calling the
  // absent loader must not invent absence and must not issue any request.
  await h.controller.loadAbsentStudents();

  assert.deepEqual(h.state.absentRows, []);
  assert.deepEqual(h.state.absentLoad, { loading: false, error: null });
  assert.equal(h.calls.length, 0);
});

test("absent rows are computed from the committed present records with their own lookups", async () => {
  const h = makeControllerHarness();

  // Today: s1 present, s2 not recorded (absent).
  void h.controller.loadTodayAttendance();
  await new Promise((r) => setImmediate(r));
  h.calls[0].settle([{ id: "r1", student_id: "s1", status: "present" }]);
  await new Promise((r) => setImmediate(r));
  h.calls[1].settle([]); // fees s1
  await new Promise((r) => setImmediate(r));
  h.calls[2].settle([{ id: "r0", student_id: "s1", status: "present" }]);
  await new Promise((r) => setImmediate(r));

  const beforeAbsent = h.calls.length;
  // The absent loader awaits per-student nested reads, so drive it with the
  // deferred transport rather than awaiting its promise.
  void h.controller.loadAbsentStudents();
  await new Promise((r) => setImmediate(r));
  assert.equal(h.calls.length, beforeAbsent + 1); // previous-attendance read for s2
  h.calls[beforeAbsent].settle([]); // absent yesterday
  await new Promise((r) => setImmediate(r));
  assert.equal(h.calls.length, beforeAbsent + 2); // fees read for s2
  h.calls[beforeAbsent + 1].settle([]); // unpaid
  await new Promise((r) => setImmediate(r));

  assert.deepEqual(h.state.absentRows.map((s: any) => s.id), ["s2"]);
  assert.equal(h.state.lastAttendance.s2._attended, false);
  assert.equal(h.state.monthlyPayments.s2, "unpaid");
  // The absent loader merges (never replaces) the scope's maps: the present
  // student s1's entries committed by the today loader must survive.
  assert.equal(h.state.lastAttendance.s1._attended, true);
  assert.equal(h.state.monthlyPayments.s1, "unpaid");
});

// ---------------------------------------------------------------------------
// Dependent absent computations vs the authoritative attendance snapshot
// (supervisor/022 reproduction): clearCommitted() retires rows/maps but the
// absent computation's own guard stayed valid, so an in-flight loop
// repopulated absentRows/maps after the authoritative load failed. The exact
// deferred sequence: successful today load with [], absent computation holding
// its nested read, today refresh whose main request fails offline, then the
// old absent nested reads resolve.
// ---------------------------------------------------------------------------
test("a failed today refresh fences the in-flight absent computation (supervisor reproduction)", async () => {
  const h = makeControllerHarness();

  // 1. Successful today load with no records (nobody present today).
  const initial = h.controller.loadTodayAttendance();
  await h.settleMain(0, []);
  await initial;
  assert.equal(h.calls.length, 1);

  // 2. Absent computation starts and holds its nested previous-attendance read.
  const absent = h.controller.loadAbsentStudents();
  await new Promise((r) => setImmediate(r));
  assert.equal(h.calls.length, 2);
  assert.equal(h.calls[1].params.student_id, "s1");

  // 3. A fresh today load (refresh) starts; its main request fails offline.
  const refresh = h.controller.loadTodayAttendance();
  await new Promise((r) => setImmediate(r));
  const refreshIndex = h.findCall(
    (c) => c.params.date && !c.params.student_id && !c.resolved,
  );
  await h.failMain(refreshIndex, new Error("offline"));

  // 4. The old absent computation's nested read resolves afterwards.
  h.calls[1].settle([]);
  await absent;

  // The authoritative load failed: the fenced computation must leave no rows,
  // no republished maps and no lingering loading state, and must issue no
  // further reads after the fence.
  assert.deepEqual(h.state.absentRows, []);
  assert.deepEqual(h.state.lastAttendance, {});
  assert.deepEqual(h.state.monthlyPayments, {});
  assert.equal(h.state.todayLoad.loading, false);
  assert.equal(h.state.todayLoad.error.kind, "network");
  assert.deepEqual(h.state.absentLoad, { loading: false, error: null });
  assert.equal(h.calls.length, 3); // initial + absent nested + failed refresh; no reads after the fence
});

test("a successful today refresh fences an in-flight absent computation from the previous snapshot", async () => {
  const h = makeControllerHarness();

  // Snapshot 1: empty today load (nobody present).
  const initial = h.controller.loadTodayAttendance();
  await h.settleMain(0, []);
  await initial;

  // Absent computation for snapshot 1 starts, holding its nested read.
  const absent = h.controller.loadAbsentStudents();
  await new Promise((r) => setImmediate(r));
  assert.equal(h.calls.length, 2);

  // Refresh succeeds with a new record (s1 present now) — the snapshot changed.
  const refresh = h.controller.loadTodayAttendance();
  await new Promise((r) => setImmediate(r));
  const refreshIndex = h.findCall(
    (c) => c.params.date && !c.params.student_id && !c.resolved,
  );
  await h.settleMain(refreshIndex, [{ id: "r1", student_id: "s1", status: "present" }]);

  // The snapshot-1 absent computation's late nested read must not commit.
  h.calls[1].settle([]);
  await absent;

  assert.deepEqual(h.state.absentRows, []); // no stale absentees repopulated
  assert.deepEqual(h.state.lastAttendance, {});
  assert.deepEqual(h.state.monthlyPayments, {});
  assert.deepEqual(h.state.attendanceRows, [{ id: "r1", student_id: "s1", status: "present" }]);
  assert.equal(h.state.todayLoad.error, null);
});

test("scope clear fences an in-flight absent computation without a replacement request", async () => {
  const h = makeControllerHarness();

  const initial = h.controller.loadTodayAttendance();
  await h.settleMain(0, []);
  await initial;

  const absent = h.controller.loadAbsentStudents();
  await new Promise((r) => setImmediate(r));
  assert.equal(h.calls.length, 2); // previous-attendance read for s1 pending

  // Group deselected: scope cleared, no replacement request issued.
  h.state.scope = "";
  h.controller.resetScope();

  h.calls[1].settle([]); // the superseded nested read resolves late
  await absent;

  assert.deepEqual(h.state.absentRows, []);
  assert.deepEqual(h.state.absentLoad, { loading: false, error: null });
  assert.equal(h.calls.length, 2); // the fenced loop issued no further reads
});

test("unmount invalidation fences an in-flight absent computation", async () => {
  const h = makeControllerHarness();

  const initial = h.controller.loadTodayAttendance();
  await h.settleMain(0, []);
  await initial;

  const absent = h.controller.loadAbsentStudents();
  await new Promise((r) => setImmediate(r));
  assert.equal(h.calls.length, 2);

  h.controller.invalidate(); // page unmount
  h.calls[1].settle([]);
  await absent;

  assert.deepEqual(h.state.absentRows, []);
  assert.deepEqual(h.state.absentLoad, { loading: false, error: null });
  assert.equal(h.calls.length, 2);
});
