/**
 * M2-04 existing instructor enrollment management — isolated production-path
 * tests (node:test + tsx).
 *
 * Scope: the REAL production seam
 * `src/features/enrollment/instructor-students.ts` that
 * src/pages/InstructorStudents.tsx delegates to, imported unchanged. Every test
 * drives the same controller the page creates, with injected fake transports,
 * clipboard, origin, principal reader and session notifier. Fully isolated: no
 * DB, no network, no browser, no live services, no real localStorage, no
 * dependency install, no student data.
 *
 * Behaviours pinned (M2-04 acceptance):
 *  - the six reads are independent: a failing section keeps its last confirmed
 *    rows and reports the error beside them, never becomes an empty list, and
 *    a failed wallet read is never a confirmed zero balance;
 *  - a malformed body is an error, not an empty list;
 *  - a slow reply never overwrites a newer one, and a previous instructor's
 *    rows never survive a scope change;
 *  - a duplicate add/approve/reject/invite/suspend/reset click never reaches
 *    the transport (the latches are acquired before the first await);
 *  - a confirmed write is never reported as a failure because a follow-up read
 *    or the clipboard failed;
 *  - a failed add keeps the typed form and a failed decision keeps its target
 *    for a deliberate retry, and the retry sends exactly one more request;
 *  - an edit typed while a save is in flight is preserved, not cleared by the
 *    older save's reply;
 *  - invite rotation is single-flight (it revokes the previous link), a
 *    clipboard refusal keeps the confirmed link and never rotates again, and a
 *    deliberate copy retry never rotates;
 *  - an old `finally` removes only its OWN busy entry;
 *  - a session change retires in-flight work and clears every private output
 *    (invite link, one-time reset code) so nothing crosses sessions;
 *  - the canonical session comparison is exact, monotonic and never returns
 *    the token.
 *
 * M2-18 (active-branch assignment):
 *  - the bounded ACTIVE-branch catalog is its own section: archived rows are
 *    dropped, the list is capped at STUDENT_BRANCH_CATALOG_LIMIT, a non-null
 *    cursor means the catalog is not complete, and a malformed envelope is an
 *    error beside the last confirmed rows, never an empty catalog;
 *  - an assign/clear only publishes the server's OWN three-field projection for
 *    the SAME student and the SAME branch — a reply naming a different student
 *    or branch (stale/foreign) is refused and never cached;
 *  - a same-tick duplicate save never reaches the transport, a non-UUID selector
 *    is refused locally, `denied`/`not-found` clear the draft while
 *    `conflict`/transport `error` keep it for a deliberate retry, and a branch
 *    is never inferred from a local role, profile or status.
 *
 * Not proven here: DOM rendering, RTL paint, real HTTP, real DB, live services
 * and end-to-end authorization (the server remains authoritative).
 */
import assert from "node:assert/strict";
import test from "node:test";
import type { EnrollmentRequest, Student } from "../lib/api-http";
import {
  buildInviteUrl,
  buildStudentPayload,
  classifyEnrollmentFailure,
  classifyStudentBranchFailure,
  createInstructorStudentsController,
  hasBusy,
  hasBusyTarget,
  isStudentBranchId,
  normalizeBranchCatalog,
  normalizeRecords,
  normalizeStudents,
  parseSuspensionMinutes,
  readInstructorSessionPrincipal,
  readStudentBranchAssignment,
  readWalletBalance,
  resetInstructorSessionLifetime,
  validateStudentForm,
  STUDENT_BRANCH_CATALOG_LIMIT,
  type InstructorSessionStorage,
  type InstructorStudentsApi,
  type StudentFormValues,
} from "../features/enrollment/instructor-students";

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const storageOf = (entries: Record<string, string | null>): InstructorSessionStorage => ({
  getItem: (key) => (key in entries ? entries[key] : null),
});

const studentRow = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: "student-1",
  name: "طالب أول",
  phone: "01000000001",
  is_offline: false,
  approval_status: "approved",
  is_active: true,
  created_at: "2026-10-01T00:00:00.000Z",
  grade_name: "الصف الأول",
  group_name: "مجموعة أ",
  ...overrides,
});

const requestRow = (overrides: Partial<EnrollmentRequest> = {}): EnrollmentRequest => ({
  id: "request-1",
  student_name: "طالب جديد",
  phone: "01000000002",
  guardian_name: "ولي الأمر",
  guardian_phone: "01000000003",
  grade_id: "grade-1",
  group_id: "group-1",
  grade_name: "الصف الأول",
  group_name: "مجموعة أ",
  status: "pending",
  created_at: "2026-10-02T00:00:00.000Z",
  ...overrides,
});

const form = (overrides: Partial<StudentFormValues> = {}): StudentFormValues => ({
  name: "طالب جديد",
  student_type: "offline",
  phone: "",
  guardian_phone: "",
  email: "",
  password: "",
  group_id: "",
  ...overrides,
});

// Canonical UUIDs so a selectable branch passes the controller's own UUID guard.
const BRANCH_1 = "11111111-1111-1111-1111-111111111111";
const BRANCH_2 = "22222222-2222-2222-2222-222222222222";

interface Harness {
  controller: ReturnType<typeof createInstructorStudentsController>;
  state: {
    students: unknown;
    wallet: unknown;
    groups: unknown;
    requests: unknown;
    resets: unknown;
    violations: unknown;
    branches: unknown;
    studentsGates: Array<Deferred<unknown>>;
    walletGates: Array<Deferred<unknown>>;
    requestsGates: Array<Deferred<unknown>>;
    resetsGates: Array<Deferred<unknown>>;
    violationsGates: Array<Deferred<unknown>>;
    branchesGates: Array<Deferred<unknown>>;
    writeGates: Array<Deferred<void>>;
    clipboardGates: Array<Deferred<void>>;
    createCalls: Array<Partial<Student>>;
    rotateCalls: number;
    approveCalls: string[];
    rejectCalls: Array<{ id: string; reason: string }>;
    resetCalls: string[];
    resetResult: unknown;
    suspendCalls: Array<{ id: string; minutes: number; reason: string }>;
    branchCalls: Array<{ studentId: string; branchId: string | null }>;
    /** Overrides the fake server's projection, to prove a stale/foreign reply is refused. */
    branchResult: unknown;
    clipboardCalls: string[];
    clipboardAvailable: boolean;
    clipboardRejects: boolean;
    failCreateWith: unknown;
    failDecideWith: unknown;
    failRotateWith: unknown;
    failResetWith: unknown;
    failSuspendWith: unknown;
    failBranchWith: unknown;
    failStudentsWith: unknown;
    failWalletWith: unknown;
    failRequestsWith: unknown;
    principal: string | null;
    sessionListeners: Set<() => void>;
    origin: string;
  };
  fireSession: () => void;
}

function setup(options: { clipboard?: "reject" | "absent" } = {}): Harness {
  const state = {
    students: [studentRow()] as unknown,
    wallet: { balance: "125.50" } as unknown,
    groups: [{ id: "group-1", name: "مجموعة أ", is_active: true }] as unknown,
    requests: [requestRow()] as unknown,
    resets: [] as unknown,
    violations: [] as unknown,
    branches: {
      branches: [
        { id: BRANCH_1, name: "الفرع الرئيسي", status: "active" },
        { id: BRANCH_2, name: "فرع التجمع", status: "active" },
        { id: "branch-archived", name: "فرع مؤرشف", status: "archived" },
      ],
      next_cursor: null,
    } as unknown,
    studentsGates: [] as Array<Deferred<unknown>>,
    walletGates: [] as Array<Deferred<unknown>>,
    requestsGates: [] as Array<Deferred<unknown>>,
    resetsGates: [] as Array<Deferred<unknown>>,
    violationsGates: [] as Array<Deferred<unknown>>,
    branchesGates: [] as Array<Deferred<unknown>>,
    writeGates: [] as Array<Deferred<void>>,
    clipboardGates: [] as Array<Deferred<void>>,
    createCalls: [] as Array<Partial<Student>>,
    rotateCalls: 0,
    approveCalls: [] as string[],
    rejectCalls: [] as Array<{ id: string; reason: string }>,
    resetCalls: [] as string[],
    resetResult: { reset_token: "reset-code-1", expires_in_minutes: 15 } as unknown,
    suspendCalls: [] as Array<{ id: string; minutes: number; reason: string }>,
    branchCalls: [] as Array<{ studentId: string; branchId: string | null }>,
    branchResult: null as unknown,
    clipboardCalls: [] as string[],
    clipboardAvailable: options.clipboard !== "absent",
    clipboardRejects: options.clipboard === "reject",
    failCreateWith: null as unknown,
    failDecideWith: null as unknown,
    failRotateWith: null as unknown,
    failResetWith: null as unknown,
    failSuspendWith: null as unknown,
    failBranchWith: null as unknown,
    failStudentsWith: null as unknown,
    failWalletWith: null as unknown,
    failRequestsWith: null as unknown,
    principal: "session-a" as string | null,
    sessionListeners: new Set<() => void>(),
    origin: "https://app.test",
  };

  const takeWriteGate = async (): Promise<void> => {
    const gate = state.writeGates.shift();
    if (gate) await gate.promise;
  };

  const api: InstructorStudentsApi = {
    loadStudents: async () => {
      const gate = state.studentsGates.shift();
      if (gate) return gate.promise;
      if (state.failStudentsWith) throw state.failStudentsWith;
      return state.students;
    },
    loadWallet: async () => {
      const gate = state.walletGates.shift();
      if (gate) return gate.promise;
      if (state.failWalletWith) throw state.failWalletWith;
      return state.wallet;
    },
    loadGroups: async () => state.groups,
    loadRequests: async () => {
      const gate = state.requestsGates.shift();
      if (gate) return gate.promise;
      if (state.failRequestsWith) throw state.failRequestsWith;
      return state.requests;
    },
    loadResetRequests: async () => {
      const gate = state.resetsGates.shift();
      if (gate) return gate.promise;
      return state.resets;
    },
    loadViolations: async () => {
      const gate = state.violationsGates.shift();
      if (gate) return gate.promise;
      return state.violations;
    },
    loadBranches: async () => {
      const gate = state.branchesGates.shift();
      if (gate) return gate.promise;
      return state.branches;
    },
    createStudent: async (payload) => {
      state.createCalls.push(payload);
      await takeWriteGate();
      if (state.failCreateWith) throw state.failCreateWith;
      // The fake server applies the write, so the follow-up read reflects it.
      state.students = [
        ...(state.students as unknown[]),
        studentRow({ id: "student-new", name: payload.name ?? "" }),
      ];
      return { id: "student-new" };
    },
    rotateInvite: async () => {
      state.rotateCalls += 1;
      await takeWriteGate();
      if (state.failRotateWith) throw state.failRotateWith;
      return { id: "invite-1", token: "token-abc", expires_in_days: 30 };
    },
    approveRequest: async (id) => {
      state.approveCalls.push(id);
      await takeWriteGate();
      if (state.failDecideWith) throw state.failDecideWith;
      // The fake server decides the row, so a re-read no longer returns it.
      state.requests = (state.requests as EnrollmentRequest[]).filter((row) => row.id !== id);
      return { status: "approved" };
    },
    rejectRequest: async (id, reason) => {
      state.rejectCalls.push({ id, reason });
      await takeWriteGate();
      if (state.failDecideWith) throw state.failDecideWith;
      state.requests = (state.requests as EnrollmentRequest[]).filter((row) => row.id !== id);
      return { status: "rejected" };
    },
    approvePasswordReset: async (id) => {
      state.resetCalls.push(id);
      await takeWriteGate();
      if (state.failResetWith) throw state.failResetWith;
      return state.resetResult;
    },
    suspendStudent: async (studentUserId, minutes, reason) => {
      state.suspendCalls.push({ id: studentUserId, minutes, reason });
      await takeWriteGate();
      if (state.failSuspendWith) throw state.failSuspendWith;
      return { suspended: true, minutes };
    },
    assignStudentBranch: async (studentId, branchId) => {
      state.branchCalls.push({ studentId, branchId });
      await takeWriteGate();
      if (state.failBranchWith) throw state.failBranchWith;
      // The fake server returns its OWN three-field projection for the exact
      // (student, branch) it just wrote — unless a test overrides branchResult
      // to prove a stale/foreign reply is refused instead of published.
      if (state.branchResult !== null) return state.branchResult;
      return {
        student:
          branchId === null
            ? { student_id: studentId, branch_id: null, branch_name: null }
            : {
                student_id: studentId,
                branch_id: branchId,
                branch_name: branchId === BRANCH_1 ? "الفرع الرئيسي" : "فرع التجمع",
              },
      };
    },
    readPrincipal: () => state.principal,
    subscribeSession: (listener) => {
      state.sessionListeners.add(listener);
      return () => state.sessionListeners.delete(listener);
    },
    readOrigin: () => state.origin,
    clipboard:
      options.clipboard === "absent"
        ? null
        : {
            writeText: async (text: string) => {
              state.clipboardCalls.push(text);
              // The outcome is decided when the browser call is MADE; a gated
              // call may settle long afterwards, exactly like a real clipboard.
              const gate = state.clipboardGates.shift();
              const rejects = state.clipboardRejects;
              const available = state.clipboardAvailable;
              if (gate) await gate.promise;
              if (!available) throw new Error("clipboard unavailable");
              if (rejects) throw new Error("clipboard refused");
            },
          },
  };

  const controller = createInstructorStudentsController(api);
  return {
    controller,
    state,
    fireSession: () => {
      for (const listener of [...state.sessionListeners]) listener();
    },
  };
}

// ---------------------------------------------------------------------------
// Pure contract helpers
// ---------------------------------------------------------------------------

test("form: an offline student needs only a name, an online student needs phone and a 10 character password", () => {
  assert.equal(validateStudentForm(form()).ok, true);
  const missingName = validateStudentForm(form({ name: "   " }));
  assert.equal(missingName.ok, false);
  assert.ok(missingName.fieldErrors.name);

  const onlineMissing = validateStudentForm(form({ student_type: "online" }));
  assert.equal(onlineMissing.ok, false);
  assert.ok(onlineMissing.fieldErrors.phone);
  assert.ok(onlineMissing.fieldErrors.password);

  const onlineShort = validateStudentForm(
    form({ student_type: "online", phone: "01000000001", password: "123456789" })
  );
  assert.equal(onlineShort.ok, false);
  assert.ok(onlineShort.fieldErrors.password);

  assert.equal(
    validateStudentForm(form({ student_type: "online", phone: "01000000001", password: "1234567890" })).ok,
    true
  );
});

test("payload: is_offline stays a boolean, offline never sends a password, grade/group and guardian are preserved", () => {
  const offline = buildStudentPayload(
    form({ name: "  طالب  ", guardian_phone: "01000000009", group_id: "group-1" })
  );
  assert.equal(offline.name, "طالب");
  assert.equal(offline.is_offline, true);
  assert.equal(offline.approval_status, "approved");
  assert.equal(offline.guardian_phone, "01000000009");
  assert.equal(offline.group_id, "group-1");
  assert.equal("password" in offline, false);
  assert.equal("phone" in offline, false);

  const online = buildStudentPayload(
    form({
      student_type: "online",
      phone: "01000000001",
      password: "1234567890",
      email: "student@example.test",
    })
  );
  assert.equal(online.is_offline, false);
  assert.equal(online.password, "1234567890");
  assert.equal(online.phone, "01000000001");
  assert.equal(online.email, "student@example.test");
});

test("failure classification uses only the documented server strings", () => {
  assert.equal(classifyEnrollmentFailure(new Error("Student already belongs to this instructor")).kind, "duplicate");
  assert.equal(classifyEnrollmentFailure(new Error("رقم الهاتف أو البريد مستخدم بالفعل")).kind, "duplicate");
  assert.equal(classifyEnrollmentFailure(new Error("Pending request not found")).kind, "stale");
  assert.equal(classifyEnrollmentFailure(new Error("Pending reset request not found")).kind, "stale");
  assert.equal(classifyEnrollmentFailure(new Error("Instructor access required")).kind, "denied");
  assert.equal(classifyEnrollmentFailure(new Error("Active instructor workspace required")).kind, "denied");
  assert.equal(classifyEnrollmentFailure(new Error("لا يمكن إضافة الطالب لمجموعة لا تخصك")).kind, "denied");
  assert.equal(classifyEnrollmentFailure(new Error("Invalid grade or group")).kind, "invalid");
  assert.equal(classifyEnrollmentFailure(new Error("Rejection reason is required")).kind, "invalid");
  assert.equal(classifyEnrollmentFailure(new Error("اسم الطالب مطلوب")).kind, "invalid");
  // The shared client throws the message alone, so an unknown message is a
  // generic error — never silently mapped onto a contract kind.
  assert.equal(classifyEnrollmentFailure(new Error("HTTP 500")).kind, "error");
  assert.equal(classifyEnrollmentFailure(undefined).kind, "error");
});

test("suspension minutes are whole, in range, and never silently clamped", () => {
  assert.deepEqual(parseSuspensionMinutes("30"), { ok: true, value: 30 });
  assert.deepEqual(parseSuspensionMinutes(5), { ok: true, value: 5 });
  assert.deepEqual(parseSuspensionMinutes(1440), { ok: true, value: 1440 });
  assert.equal(parseSuspensionMinutes("4").ok, false);
  assert.equal(parseSuspensionMinutes("1441").ok, false);
  assert.equal(parseSuspensionMinutes("30abc").ok, false);
  assert.equal(parseSuspensionMinutes("").ok, false);
  assert.equal(parseSuspensionMinutes("2.5").ok, false);
  assert.equal(parseSuspensionMinutes(Number.NaN).ok, false);
});

test("invite link is built from the real origin and an encoded token", () => {
  assert.equal(buildInviteUrl("https://app.test", "abc"), "https://app.test/join/abc");
  assert.equal(buildInviteUrl("https://app.test/", "abc"), "https://app.test/join/abc");
  assert.equal(buildInviteUrl("https://app.test", "a b"), "https://app.test/join/a%20b");
  assert.equal(buildInviteUrl("https://app.test", "   "), null);
});

test("normalization: a non-array body is null (an error), and rows without an id are unusable", () => {
  assert.equal(normalizeStudents({ rows: [] }), null);
  assert.equal(normalizeStudents(null), null);
  assert.deepEqual(normalizeStudents([]), []);

  const rows = normalizeStudents([
    studentRow(),
    { name: "بدون معرف" },
    null,
    studentRow({ id: "student-2", is_offline: 1, phone: null }),
  ]);
  assert.ok(rows);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].is_offline, false);
  assert.equal(rows[1].is_offline, true);
  assert.equal(rows[1].phone, null);
  assert.equal(rows[1].grade_name, "الصف الأول");

  assert.equal(normalizeRecords([{ id: "a" }])?.length, 1);
  assert.equal(normalizeRecords("nope"), null);
  assert.equal(normalizeRecords([{ nope: 1 }])?.length, 0);
});

test("wallet balance: a decimal string is read, anything else is unknown — never zero", () => {
  assert.equal(readWalletBalance({ balance: "125.50" }), 125.5);
  assert.equal(readWalletBalance({ balance: 0 }), 0);
  assert.equal(readWalletBalance({ balance: "0.00" }), 0);
  assert.equal(readWalletBalance({ balance: "" }), null);
  assert.equal(readWalletBalance({ balance: null }), null);
  assert.equal(readWalletBalance({ balance: "abc" }), null);
  assert.equal(readWalletBalance({}), null);
  assert.equal(readWalletBalance(null), null);
});

// ---------------------------------------------------------------------------
// Session boundary
// ---------------------------------------------------------------------------

test("session: consecutive reads of the same session are stable and the token never leaves the reader", () => {
  resetInstructorSessionLifetime();
  const storage = storageOf({
    currentUser: JSON.stringify({ id: "user-1", role: "instructor" }),
    authToken: "secret-token-value",
  });
  const first = readInstructorSessionPrincipal(storage);
  const second = readInstructorSessionPrincipal(storage);
  assert.equal(first, second);
  assert.ok(first);
  assert.equal(String(first).includes("secret-token-value"), false);
});

test("session: A → B → A yields a new incarnation every time", () => {
  resetInstructorSessionLifetime();
  const a = storageOf({ currentUser: JSON.stringify({ id: "user-1", role: "instructor" }), authToken: "token-a" });
  const b = storageOf({ currentUser: JSON.stringify({ id: "user-1", role: "instructor" }), authToken: "token-b" });
  const firstA = readInstructorSessionPrincipal(a);
  const seenB = readInstructorSessionPrincipal(b);
  const secondA = readInstructorSessionPrincipal(a);
  assert.notEqual(firstA, seenB);
  assert.notEqual(seenB, secondA);
  assert.notEqual(firstA, secondA);
});

test("session: logout is null, and the next login is a different incarnation", () => {
  resetInstructorSessionLifetime();
  const signedIn = storageOf({ currentUser: JSON.stringify({ id: "user-1", role: "instructor" }), authToken: "t" });
  const signedOut = storageOf({ currentUser: null, authToken: null });
  const before = readInstructorSessionPrincipal(signedIn);
  assert.equal(readInstructorSessionPrincipal(signedOut), null);
  const after = readInstructorSessionPrincipal(signedIn);
  assert.notEqual(before, after);
});

test("session: a different role or billing flag is a different session", () => {
  resetInstructorSessionLifetime();
  const instructor = storageOf({ currentUser: JSON.stringify({ id: "user-1", role: "instructor" }), authToken: "t" });
  const admin = storageOf({ currentUser: JSON.stringify({ id: "user-1", role: "admin" }), authToken: "t" });
  const billing = storageOf({
    currentUser: JSON.stringify({ id: "user-1", role: "instructor", billing_only: true }),
    authToken: "t",
  });
  const a = readInstructorSessionPrincipal(instructor);
  const b = readInstructorSessionPrincipal(admin);
  const c = readInstructorSessionPrincipal(billing);
  assert.notEqual(a, b);
  assert.notEqual(b, c);
  assert.notEqual(a, c);
});

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

test("loadAll commits every section independently", async () => {
  const h = setup();
  h.state.resets = [{ id: "reset-1", status: "pending", name: "طالب", phone: "01000000004", created_at: "2026-10-03" }];
  h.state.violations = [{ id: "v-1", student_user_id: "user-9", student_name: "طالب", activity_type: "capture", violation_weight: 1, violation_score: 1, confidence: "low", created_at: "2026-10-04" }];
  await h.controller.loadAll("instructor-1");
  const state = h.controller.getState();
  assert.equal(state.studentsPhase, "ready");
  assert.equal(state.students.length, 1);
  assert.equal(state.walletPhase, "ready");
  assert.equal(state.walletBalance, 125.5);
  assert.equal(state.groupsPhase, "ready");
  assert.equal(state.requestsPhase, "ready");
  assert.equal(state.resetsPhase, "ready");
  assert.equal(state.violationsPhase, "ready");
  assert.equal(state.violations.length, 1);
  assert.equal(state.branchesPhase, "ready");
  assert.equal(state.branches.length, 2);
  assert.equal(state.scopeId, "instructor-1");
});

test("a failed students read with nothing confirmed is an error, never an empty list", async () => {
  const h = setup();
  h.state.failStudentsWith = new Error("فشل في جلب الطلاب");
  await h.controller.loadStudents("instructor-1");
  const state = h.controller.getState();
  assert.equal(state.studentsPhase, "error");
  assert.equal(state.studentsError, "فشل في جلب الطلاب");
  assert.deepEqual(state.students, []);
});

test("a failed students read keeps the confirmed rows and reports the error beside them", async () => {
  const h = setup();
  await h.controller.loadStudents("instructor-1");
  assert.equal(h.controller.getState().students.length, 1);
  h.state.failStudentsWith = new Error("network down");
  await h.controller.loadStudents("instructor-1");
  const state = h.controller.getState();
  assert.equal(state.studentsPhase, "ready");
  assert.equal(state.students.length, 1);
  assert.equal(state.studentsError, "network down");
});

test("a malformed students body is an error, not an empty list", async () => {
  const h = setup();
  h.state.students = { message: "ok" };
  await h.controller.loadStudents("instructor-1");
  const state = h.controller.getState();
  assert.equal(state.studentsPhase, "error");
  assert.ok(state.studentsError);
  assert.deepEqual(state.students, []);
});

test("a confirmed empty array is an honest empty state", async () => {
  const h = setup();
  h.state.students = [];
  await h.controller.loadStudents("instructor-1");
  assert.equal(h.controller.getState().studentsPhase, "empty");
  assert.equal(h.controller.getState().studentsError, null);
});

test("a failed wallet read is unknown, never a confirmed zero, and a later failure keeps the confirmed value", async () => {
  const h = setup();
  h.state.failWalletWith = new Error("wallet down");
  await h.controller.loadWallet("instructor-1");
  assert.equal(h.controller.getState().walletBalance, null);
  assert.equal(h.controller.getState().walletPhase, "error");
  assert.equal(h.controller.getState().walletError, "wallet down");

  h.state.failWalletWith = null;
  await h.controller.loadWallet("instructor-1");
  assert.equal(h.controller.getState().walletBalance, 125.5);

  h.state.failWalletWith = new Error("wallet down again");
  await h.controller.loadWallet("instructor-1");
  assert.equal(h.controller.getState().walletBalance, 125.5);
  assert.equal(h.controller.getState().walletError, "wallet down again");
});

test("a malformed wallet body never becomes zero", async () => {
  const h = setup();
  h.state.wallet = { balance: "not-a-number" };
  await h.controller.loadWallet("instructor-1");
  assert.equal(h.controller.getState().walletBalance, null);
  assert.equal(h.controller.getState().walletPhase, "error");
});

test("partial failure stays partial: a failed requests read does not disturb students or the wallet", async () => {
  const h = setup();
  h.state.failRequestsWith = new Error("requests down");
  await h.controller.loadAll("instructor-1");
  const state = h.controller.getState();
  assert.equal(state.studentsPhase, "ready");
  assert.equal(state.students.length, 1);
  assert.equal(state.walletBalance, 125.5);
  assert.equal(state.requestsPhase, "error");
  assert.equal(state.requestsError, "requests down");
  assert.deepEqual(state.requests, []);
});

test("a slow reply never overwrites a newer one", async () => {
  const h = setup();
  const slow = deferred<unknown>();
  h.state.studentsGates.push(slow);
  const first = h.controller.loadStudents("instructor-1");

  h.state.students = [studentRow({ id: "student-new", name: "الأحدث" })];
  await h.controller.loadStudents("instructor-1");
  assert.equal(h.controller.getState().students[0].id, "student-new");

  slow.resolve([studentRow({ id: "student-old", name: "القديم" })]);
  await first;
  assert.equal(h.controller.getState().students[0].id, "student-new");
});

test("a scope change clears the previous instructor and drops its late reply", async () => {
  const h = setup();
  const slow = deferred<unknown>();
  h.state.studentsGates.push(slow);
  const previous = h.controller.loadStudents("instructor-a");

  h.state.students = [studentRow({ id: "student-b" })];
  await h.controller.loadAll("instructor-b");
  assert.equal(h.controller.getState().scopeId, "instructor-b");
  assert.equal(h.controller.getState().students[0].id, "student-b");

  slow.resolve([studentRow({ id: "student-a" })]);
  await previous;
  assert.equal(h.controller.getState().students[0].id, "student-b");
});

// ---------------------------------------------------------------------------
// Add student
// ---------------------------------------------------------------------------

test("a same-tick duplicate add never reaches the transport", async () => {
  const h = setup();
  const instance = h.controller.openForm();
  const gate = deferred<void>();
  h.state.writeGates.push(gate);

  const first = h.controller.submitStudent(form(), instance);
  const second = h.controller.submitStudent(form(), instance);
  assert.equal(await second, "duplicate");
  assert.equal(h.state.createCalls.length, 1);

  gate.resolve();
  assert.equal(await first, "created");
});

test("an invalid form is refused before any request and reports the field", async () => {
  const h = setup();
  const instance = h.controller.openForm();
  const outcome = await h.controller.submitStudent(form({ name: "  " }), instance);
  assert.equal(outcome, "invalid");
  assert.equal(h.state.createCalls.length, 0);
  assert.ok(h.controller.getState().fieldErrors.name);
});

test("a failed add keeps the typed form and a deliberate retry sends exactly one more request", async () => {
  const h = setup();
  const instance = h.controller.openForm();
  h.state.failCreateWith = new Error("تعذر إنشاء الحساب");
  const first = await h.controller.submitStudent(form({ name: "طالب محفوظ" }), instance);
  assert.equal(first, "failed");
  assert.equal(h.controller.getState().addError, "تعذر إنشاء الحساب");
  assert.equal(h.controller.isFormCurrent(instance), true);
  assert.equal(h.controller.formRevision(), 0);

  h.state.failCreateWith = null;
  const second = await h.controller.submitStudent(form({ name: "طالب محفوظ" }), instance);
  assert.equal(second, "created");
  assert.equal(h.state.createCalls.length, 2);
  assert.equal(h.controller.getState().addError, null);
});

test("a confirmed add is not turned into a failure by a failing follow-up read", async () => {
  const h = setup();
  const instance = h.controller.openForm();
  await h.controller.loadStudents("instructor-1");
  h.state.failStudentsWith = new Error("refresh down");
  const outcome = await h.controller.submitStudent(form(), instance);
  assert.equal(outcome, "created");
  const state = h.controller.getState();
  assert.equal(state.addError, null);
  assert.equal(state.studentsError, "refresh down");
  assert.equal(state.students.length, 1);
});

test("an edit typed while the save is in flight is preserved", async () => {
  const h = setup();
  const instance = h.controller.openForm();
  const gate = deferred<void>();
  h.state.writeGates.push(gate);
  const pending = h.controller.submitStudent(form({ name: "الأول" }), instance);
  h.controller.noteFormEdit();
  gate.resolve();
  assert.equal(await pending, "created-edited");
  assert.equal(h.controller.formRevision(), 1);
});

test("a save whose form was closed meanwhile does not reopen or clear anything", async () => {
  const h = setup();
  const instance = h.controller.openForm();
  const gate = deferred<void>();
  h.state.writeGates.push(gate);
  const pending = h.controller.submitStudent(form(), instance);
  h.controller.closeForm();
  gate.resolve();
  assert.equal(await pending, "created-closed");
  assert.equal(h.controller.isFormCurrent(instance), false);
});

test("a save that completes after a session change is blocked and commits nothing", async () => {
  const h = setup();
  const instance = h.controller.openForm();
  const gate = deferred<void>();
  h.state.writeGates.push(gate);
  const pending = h.controller.submitStudent(form(), instance);
  h.state.principal = "session-b";
  h.fireSession();
  gate.resolve();
  assert.equal(await pending, "blocked");
  assert.equal(h.controller.getState().createdStudentId, null);
});

// ---------------------------------------------------------------------------
// Decisions
// ---------------------------------------------------------------------------

test("a same-tick duplicate approve sends one decision", async () => {
  const h = setup();
  const gate = deferred<void>();
  h.state.writeGates.push(gate);
  const first = h.controller.decideRequest("request-1", true);
  const second = h.controller.decideRequest("request-1", true);
  assert.equal(await second, "duplicate");
  assert.equal(h.state.approveCalls.length, 1);
  gate.resolve();
  assert.equal(await first, "approved");
});

test("a rejection without a usable reason is refused before the transport", async () => {
  const h = setup();
  assert.equal(await h.controller.decideRequest("request-1", false, "  "), "invalid");
  assert.equal(await h.controller.decideRequest("request-1", false, "لا"), "invalid");
  assert.equal(h.state.rejectCalls.length, 0);
  assert.equal(await h.controller.decideRequest("request-1", false, "سبب كافٍ"), "rejected");
  assert.deepEqual(h.state.rejectCalls, [{ id: "request-1", reason: "سبب كافٍ" }]);
});

test("a failed decision keeps the row and its target for a deliberate retry", async () => {
  const h = setup();
  await h.controller.loadRequests();
  h.state.failDecideWith = new Error("تعذر تنفيذ القرار");
  const first = await h.controller.decideRequest("request-1", true);
  assert.equal(first, "failed");
  const state = h.controller.getState();
  assert.equal(state.decisionError, "تعذر تنفيذ القرار");
  assert.equal(state.decisionTargetId, "request-1");
  assert.equal(state.requests.length, 1);

  h.state.failDecideWith = null;
  const second = await h.controller.decideRequest("request-1", true);
  assert.equal(second, "approved");
  assert.equal(h.state.approveCalls.length, 2);
  assert.equal(h.controller.getState().requests.length, 0);
});

test("a confirmed decision removes only its own row, even when the re-read fails", async () => {
  const h = setup();
  h.state.requests = [requestRow(), requestRow({ id: "request-2", student_name: "آخر" })];
  await h.controller.loadRequests();
  h.state.failRequestsWith = new Error("list down");
  const outcome = await h.controller.decideRequest("request-1", true);
  assert.equal(outcome, "approved");
  const state = h.controller.getState();
  assert.deepEqual(state.requests.map((row) => row.id), ["request-2"]);
  assert.equal(state.requestsError, "list down");
});

test("a stale decision is refreshed instead of retried as a new decision", async () => {
  const h = setup();
  await h.controller.loadRequests();
  h.state.failDecideWith = new Error("Pending request not found");
  const outcome = await h.controller.decideRequest("request-1", true);
  assert.equal(outcome, "stale");
  const state = h.controller.getState();
  assert.equal(state.decisionTargetId, null);
  assert.equal(state.requests.length, 1);
  assert.equal(h.state.approveCalls.length, 1);
});

test("a second target is refused while a decision is in flight, and A never removes B", async () => {
  const h = setup();
  h.state.requests = [requestRow(), requestRow({ id: "request-2" })];
  await h.controller.loadRequests();
  const gate = deferred<void>();
  h.state.writeGates.push(gate);
  const first = h.controller.decideRequest("request-1", true);
  assert.equal(await h.controller.decideRequest("request-2", true), "duplicate");
  gate.resolve();
  assert.equal(await first, "approved");
  assert.deepEqual(h.controller.getState().requests.map((row) => row.id), ["request-2"]);
});

test("a decision that completes after a session change is blocked and commits nothing", async () => {
  const h = setup();
  await h.controller.loadRequests();
  const gate = deferred<void>();
  h.state.writeGates.push(gate);
  const pending = h.controller.decideRequest("request-1", true);
  h.state.principal = "session-b";
  h.fireSession();
  gate.resolve();
  assert.equal(await pending, "blocked");
  assert.equal(h.controller.getState().requests.length, 0); // cleared by the session change
});

// ---------------------------------------------------------------------------
// Invitation
// ---------------------------------------------------------------------------

test("a duplicate invite click rotates exactly once", async () => {
  const h = setup();
  const gate = deferred<void>();
  h.state.writeGates.push(gate);
  const first = h.controller.rotateInvite();
  assert.equal(await h.controller.rotateInvite(), "duplicate");
  gate.resolve();
  assert.equal(await first, "rotated");
  assert.equal(h.state.rotateCalls, 1);
  assert.equal(h.controller.getState().inviteUrl, "https://app.test/join/token-abc");
});

test("a confirmed rotation is kept when the clipboard refuses, and it never rotates again", async () => {
  const h = setup({ clipboard: "reject" });
  const outcome = await h.controller.rotateInvite();
  assert.equal(outcome, "rotated-not-copied");
  const state = h.controller.getState();
  assert.equal(state.inviteUrl, "https://app.test/join/token-abc");
  assert.equal(state.inviteCopied, false);
  assert.equal(state.inviteError, null);
  assert.equal(h.state.rotateCalls, 1);
});

test("an absent clipboard is reported as not copied, never as a fake success", async () => {
  const h = setup({ clipboard: "absent" });
  assert.equal(await h.controller.rotateInvite(), "rotated-not-copied");
  assert.equal(h.controller.getState().inviteCopied, false);
  assert.equal(h.controller.getState().inviteUrl, "https://app.test/join/token-abc");
});

test("a deliberate copy retry never rotates the invite", async () => {
  const h = setup({ clipboard: "reject" });
  await h.controller.rotateInvite();
  assert.equal(h.state.rotateCalls, 1);

  assert.equal(await h.controller.copyInviteLink(), "unavailable");
  assert.equal(h.state.rotateCalls, 1);
  assert.equal(h.controller.getState().inviteUrl, "https://app.test/join/token-abc");

  h.state.clipboardRejects = false;
  assert.equal(await h.controller.copyInviteLink(), "copied");
  assert.equal(h.state.rotateCalls, 1);
  assert.equal(h.controller.getState().inviteCopied, true);
});

test("copying before any link exists does nothing", async () => {
  const h = setup();
  assert.equal(await h.controller.copyInviteLink(), "unavailable");
  assert.equal(h.state.clipboardCalls.length, 0);
});

test("a failed rotation keeps the previous link and reports the error", async () => {
  const h = setup();
  await h.controller.rotateInvite();
  const previous = h.controller.getState().inviteUrl;
  h.state.failRotateWith = new Error("Failed to create invitation");
  assert.equal(await h.controller.rotateInvite(), "failed");
  assert.equal(h.controller.getState().inviteUrl, previous);
  assert.equal(h.controller.getState().inviteError, "Failed to create invitation");
});

// ---------------------------------------------------------------------------
// Password reset (existing manual delivery path)
// ---------------------------------------------------------------------------

test("an issued code survives a clipboard refusal and is never claimed as copied", async () => {
  const h = setup({ clipboard: "reject" });
  const outcome = await h.controller.approveReset("reset-1");
  assert.equal(outcome, "issued-not-copied");
  const code = h.controller.getState().resetCode;
  assert.ok(code);
  assert.equal(code?.requestId, "reset-1");
  assert.equal(code?.expiresInMinutes, 15);
  assert.equal(code?.copied, false);
  assert.equal(h.controller.getState().resetActionError, null);
});

test("a duplicate reset click issues one code", async () => {
  const h = setup();
  const gate = deferred<void>();
  h.state.writeGates.push(gate);
  const first = h.controller.approveReset("reset-1");
  assert.equal(await h.controller.approveReset("reset-1"), "duplicate");
  gate.resolve();
  assert.equal(await first, "issued");
  assert.equal(h.state.resetCalls.length, 1);
});

test("a stale reset request is refreshed, not retried", async () => {
  const h = setup();
  h.state.failResetWith = new Error("Pending reset request not found");
  assert.equal(await h.controller.approveReset("reset-1"), "stale");
  assert.equal(h.controller.getState().resetCode, null);
  assert.equal(h.state.resetCalls.length, 1);
});

test("a malformed reset reply issues no code", async () => {
  const h = setup();
  // A body without a token must never be shown as an issued code.
  h.state.resetResult = { expires_in_minutes: 15 };
  assert.equal(await h.controller.approveReset("reset-1"), "failed");
  assert.equal(h.controller.getState().resetCode, null);
  assert.ok(h.controller.getState().resetActionError);
  assert.equal(h.state.resetCalls.length, 1);
});

// ---------------------------------------------------------------------------
// Video security suspension (existing manual action, unchanged policy)
// ---------------------------------------------------------------------------

test("an out-of-range suspension duration is refused before the transport", async () => {
  const h = setup();
  const violation = { id: "v-1", student_user_id: "user-9", activity_type: "capture" } as never;
  assert.equal(await h.controller.suspendStudent(violation, "2", "سبب"), "invalid");
  assert.equal(await h.controller.suspendStudent(violation, "2000", "سبب"), "invalid");
  assert.equal(await h.controller.suspendStudent(violation, "30", "   "), "invalid");
  assert.equal(h.state.suspendCalls.length, 0);
  assert.ok(h.controller.getState().securityError);
});

test("a duplicate suspension sends one request", async () => {
  const h = setup();
  const violation = { id: "v-1", student_user_id: "user-9", activity_type: "capture" } as never;
  const gate = deferred<void>();
  h.state.writeGates.push(gate);
  const first = h.controller.suspendStudent(violation, "30", "مراجعة أمنية");
  assert.equal(await h.controller.suspendStudent(violation, "30", "مراجعة أمنية"), "duplicate");
  gate.resolve();
  assert.equal(await first, "suspended");
  assert.equal(h.state.suspendCalls.length, 1);
  assert.deepEqual(h.state.suspendCalls[0], { id: "user-9", minutes: 30, reason: "مراجعة أمنية" });
});

// ---------------------------------------------------------------------------
// Busy ownership and lifecycle
// ---------------------------------------------------------------------------

test("an older finally removes only its own busy entry", async () => {
  const h = setup();
  const instance = h.controller.openForm();
  const addGate = deferred<void>();
  const inviteGate = deferred<void>();
  h.state.writeGates.push(addGate, inviteGate);

  const add = h.controller.submitStudent(form(), instance);
  const invite = h.controller.rotateInvite();
  assert.equal(hasBusy(h.controller.getState(), "add"), true);
  assert.equal(hasBusy(h.controller.getState(), "invite"), true);

  addGate.resolve();
  await add;
  // The add's finally must not clear the invite that is still in flight.
  assert.equal(hasBusy(h.controller.getState(), "add"), false);
  assert.equal(hasBusy(h.controller.getState(), "invite"), true);

  inviteGate.resolve();
  await invite;
  assert.equal(h.controller.getState().busy.length, 0);
});

test("busy helpers answer per kind and per target", async () => {
  const h = setup();
  await h.controller.loadRequests();
  const gate = deferred<void>();
  h.state.writeGates.push(gate);
  const pending = h.controller.decideRequest("request-1", true);
  assert.equal(hasBusyTarget(h.controller.getState(), "decision", "request-1"), true);
  assert.equal(hasBusyTarget(h.controller.getState(), "decision", "request-2"), false);
  gate.resolve();
  await pending;
  assert.equal(hasBusy(h.controller.getState(), "decision"), false);
});

test("a reply that lands after dispose commits nothing", async () => {
  const h = setup();
  const gate = deferred<unknown>();
  h.state.studentsGates.push(gate);
  const pending = h.controller.loadStudents("instructor-1");
  h.controller.dispose();
  gate.resolve([studentRow({ id: "late" })]);
  await pending;
  assert.deepEqual(h.controller.getState().students, []);
});

test("a session change clears every private output and all confirmed rows", async () => {
  const h = setup();
  await h.controller.loadAll("instructor-1");
  await h.controller.rotateInvite();
  await h.controller.approveReset("reset-1");
  assert.ok(h.controller.getState().inviteUrl);
  assert.ok(h.controller.getState().resetCode);

  h.state.principal = "session-b";
  h.fireSession();

  const state = h.controller.getState();
  assert.equal(state.inviteUrl, null);
  assert.equal(state.inviteCopied, null);
  assert.equal(state.resetCode, null);
  assert.deepEqual(state.students, []);
  assert.deepEqual(state.requests, []);
  assert.equal(state.studentsPhase, "idle");
  assert.equal(state.walletBalance, null);
  assert.equal(state.scopeId, "");
});

test("waitForIdle settles a write together with the re-read it started", async () => {
  const h = setup();
  const instance = h.controller.openForm();
  await h.controller.loadStudents("instructor-1");
  void h.controller.submitStudent(form(), instance);
  await h.controller.waitForIdle();
  assert.equal(h.state.createCalls.length, 1);
  assert.equal(h.controller.getState().busy.length, 0);
  assert.equal(h.controller.getState().studentsPhase, "ready");
  assert.equal(h.controller.getState().students.length, 2);
});

// ---------------------------------------------------------------------------
// 078 lifetime regressions — unannounced identity, refresh revalidation, link
// incarnation. Each one drives the same production controller the page runs.
// ---------------------------------------------------------------------------

/** Wait until a gated read has actually started (its gate was taken). */
async function waitForGatedRead(gates: Array<Deferred<unknown>>): Promise<void> {
  for (let i = 0; i < 25 && gates.length > 0; i += 1) await Promise.resolve();
  assert.equal(gates.length, 0, "the follow-up read must have started");
}

test("a silent principal replacement drops the in-flight reply and retires the old private outputs", async () => {
  const h = setup();
  await h.controller.loadAll("instructor-1");
  await h.controller.rotateInvite();
  await h.controller.approveReset("reset-1");
  assert.equal(h.controller.getState().students.length, 1);
  assert.ok(h.controller.getState().inviteUrl);
  assert.ok(h.controller.getState().resetCode);

  const gate = deferred<unknown>();
  h.state.studentsGates.push(gate);
  const pending = h.controller.loadStudents("instructor-1");
  // No session event: the page never announced this replacement.
  h.state.principal = "session-b";
  gate.resolve([studentRow({ id: "student-b" })]);
  await pending;

  const state = h.controller.getState();
  assert.deepEqual(state.students, []);
  assert.equal(state.studentsPhase, "idle");
  assert.equal(state.inviteUrl, null);
  assert.equal(state.inviteCopied, null);
  assert.equal(state.resetCode, null);
});

test("an unannounced replacement is adopted at the next entry, so old rows never survive a failure", async () => {
  const h = setup();
  await h.controller.loadAll("instructor-1");
  assert.equal(h.controller.getState().students.length, 1);

  h.state.principal = "session-b";
  h.state.failStudentsWith = new Error("list down");
  await h.controller.loadStudents("instructor-1");

  const state = h.controller.getState();
  assert.deepEqual(state.students, []);
  assert.equal(state.studentsPhase, "error");
  assert.equal(state.studentsError, "list down");
});

test("observed A → B → A retires twice and a late reply cannot revive the first session's rows", async () => {
  const h = setup();
  await h.controller.loadAll("instructor-1");

  h.state.principal = "session-b";
  await h.controller.loadStudents("instructor-1");
  assert.equal(h.controller.getState().students.length, 1);

  const slow = deferred<unknown>();
  h.state.studentsGates.push(slow);
  const pending = h.controller.loadStudents("instructor-1");
  h.state.principal = "session-a";
  slow.resolve([studentRow({ id: "student-a-again" })]);
  await pending;

  assert.deepEqual(h.controller.getState().students, []);
});

test("after an adopted replacement the controller is usable again on the new session", async () => {
  const h = setup();
  await h.controller.loadAll("instructor-1");
  h.state.principal = "session-b";
  h.state.students = [studentRow({ id: "student-b" })];

  await h.controller.loadStudents("instructor-1");
  assert.deepEqual(h.controller.getState().students.map((row) => row.id), ["student-b"]);
  assert.equal(await h.controller.rotateInvite(), "rotated");
  assert.equal(await h.controller.copyInviteLink(), "copied");
});

test("a decision confirmed under A is not published when the session changes during its refresh", async () => {
  const h = setup();
  await h.controller.loadRequests();
  const gate = deferred<unknown>();
  h.state.requestsGates.push(gate);
  const pending = h.controller.decideRequest("request-1", true);
  await waitForGatedRead(h.state.requestsGates);

  h.state.principal = "session-b";
  h.fireSession();
  gate.resolve([]);

  assert.equal(await pending, "blocked");
  const state = h.controller.getState();
  // The write was confirmed, so this is NOT a retryable write failure.
  assert.equal(state.decisionError, null);
  assert.equal(state.decisionTargetId, null);
  assert.deepEqual(state.requests, []);
  assert.equal(h.state.approveCalls.length, 1);
});

test("a decision confirmed under A is not published after a scope change during its refresh", async () => {
  const h = setup();
  await h.controller.loadStudents("instructor-1");
  await h.controller.loadRequests();
  const gate = deferred<unknown>();
  h.state.requestsGates.push(gate);
  const pending = h.controller.decideRequest("request-1", true);
  await waitForGatedRead(h.state.requestsGates);

  await h.controller.loadAll("instructor-2");
  gate.resolve([]);

  assert.equal(await pending, "blocked");
  assert.equal(h.controller.getState().scopeId, "instructor-2");
  assert.equal(h.controller.getState().decisionError, null);
});

test("a stale-decision refresh that crosses a session change returns blocked, not stale", async () => {
  const h = setup();
  await h.controller.loadRequests();
  h.state.failDecideWith = new Error("Pending request not found");
  const gate = deferred<unknown>();
  h.state.requestsGates.push(gate);
  const pending = h.controller.decideRequest("request-1", true);
  await waitForGatedRead(h.state.requestsGates);

  h.state.principal = "session-b";
  h.fireSession();
  gate.resolve([]);

  assert.equal(await pending, "blocked");
  assert.equal(h.controller.getState().decisionTargetId, null);
});

test("a create confirmed under A is not published when the session changes during its refresh", async () => {
  const h = setup();
  const instance = h.controller.openForm();
  await h.controller.loadStudents("instructor-1");
  const gate = deferred<unknown>();
  h.state.studentsGates.push(gate);
  const pending = h.controller.submitStudent(form(), instance);
  await waitForGatedRead(h.state.studentsGates);

  h.state.principal = "session-b";
  h.fireSession();
  gate.resolve([]);

  assert.equal(await pending, "blocked");
  const state = h.controller.getState();
  assert.equal(state.createdStudentId, null);
  assert.equal(state.addError, null);
  assert.equal(h.state.createCalls.length, 1);
});

test("an issued reset code is not published when the session changes during its refresh", async () => {
  const h = setup();
  const gate = deferred<unknown>();
  h.state.resetsGates.push(gate);
  const pending = h.controller.approveReset("reset-1");
  await waitForGatedRead(h.state.resetsGates);

  h.state.principal = "session-b";
  h.fireSession();
  gate.resolve([]);

  assert.equal(await pending, "blocked");
  assert.equal(h.controller.getState().resetCode, null);
  assert.equal(h.state.resetCalls.length, 1);
});

test("a suspension confirmed under A is not published when the session changes during its refresh", async () => {
  const h = setup();
  const violation = { id: "v-1", student_user_id: "user-9", activity_type: "capture" } as never;
  const gate = deferred<unknown>();
  h.state.violationsGates.push(gate);
  const pending = h.controller.suspendStudent(violation, "30", "مراجعة أمنية");
  await waitForGatedRead(h.state.violationsGates);

  h.state.principal = "session-b";
  h.fireSession();
  gate.resolve([]);

  assert.equal(await pending, "blocked");
  const state = h.controller.getState();
  assert.equal(state.securityTargetId, null);
  assert.equal(state.securityError, null);
  assert.equal(h.state.suspendCalls.length, 1);
});

test("an older copy that succeeds after a newer refused rotation never certifies the new link", async () => {
  const h = setup();
  await h.controller.rotateInvite();
  assert.equal(h.controller.getState().inviteCopied, true);

  const gate = deferred<void>();
  h.state.clipboardGates.push(gate);
  const oldCopy = h.controller.copyInviteLink();
  // The newer rotation's own clipboard write is refused.
  h.state.clipboardRejects = true;
  assert.equal(await h.controller.rotateInvite(), "rotated-not-copied");
  assert.equal(h.controller.getState().inviteCopied, false);

  gate.resolve();
  assert.equal(await oldCopy, "superseded");
  const state = h.controller.getState();
  assert.equal(state.inviteCopied, false);
  assert.equal(state.inviteUrl, "https://app.test/join/token-abc");
  assert.equal(h.state.rotateCalls, 2);
});

test("an older copy that fails after a newer successful copy never overwrites the confirmed state", async () => {
  const h = setup();
  await h.controller.rotateInvite();

  h.state.clipboardRejects = true;
  const gate = deferred<void>();
  h.state.clipboardGates.push(gate);
  const oldCopy = h.controller.copyInviteLink();
  h.state.clipboardRejects = false;
  assert.equal(await h.controller.rotateInvite(), "rotated");
  assert.equal(h.controller.getState().inviteCopied, true);

  gate.resolve();
  assert.equal(await oldCopy, "superseded");
  assert.equal(h.controller.getState().inviteCopied, true);
  assert.equal(h.state.rotateCalls, 2);
});

test("a copy that settles after dispose commits nothing", async () => {
  const h = setup();
  await h.controller.rotateInvite();
  const gate = deferred<void>();
  h.state.clipboardGates.push(gate);
  const pending = h.controller.copyInviteLink();
  h.controller.dispose();
  gate.resolve();

  assert.equal(await pending, "blocked");
  // The rotation's confirmed result is untouched: the late copy changed nothing.
  assert.equal(h.controller.getState().inviteCopied, true);
});

test("a retried copy of the current link still reports a real clipboard result", async () => {
  const h = setup({ clipboard: "reject" });
  await h.controller.rotateInvite();
  assert.equal(h.controller.getState().inviteCopied, false);
  h.state.clipboardRejects = false;
  assert.equal(await h.controller.copyInviteLink(), "copied");
  assert.equal(h.controller.getState().inviteCopied, true);
  assert.equal(h.state.rotateCalls, 1);
});

// ---------------------------------------------------------------------------
// 079 scope-lifetime regressions — the scope is a monotonic LIFETIME, not an
// id. Every mutation captures it before its first await and re-validates it
// after each one, and a scope change retires the old scope's latches so the
// new scope is never blocked by transport the retired scope still owes.
// ---------------------------------------------------------------------------

test("A → B → A cannot revive a decision that was in flight under the first A", async () => {
  const h = setup();
  await h.controller.loadAll("instructor-a");
  const gate = deferred<void>();
  h.state.writeGates.push(gate);
  const pending = h.controller.decideRequest("request-1", true);

  // Back to the SAME instructor id: the scope is a new lifetime, not a revival.
  await h.controller.loadAll("instructor-b");
  await h.controller.loadAll("instructor-a");
  assert.equal(h.controller.getState().scopeId, "instructor-a");

  gate.resolve();
  assert.equal(await pending, "blocked");
  const state = h.controller.getState();
  // Nothing from the retired operation is published: no success, no error and
  // no locally removed row.
  assert.equal(state.decisionError, null);
  assert.equal(state.decisionTargetId, null);
  assert.deepEqual(
    state.requests.map((row) => row.id),
    ["request-1"]
  );
});

test("a new scope can decide while the retired scope's transport is unresolved, and the old finally cannot free it", async () => {
  const h = setup();
  await h.controller.loadAll("instructor-a");
  const oldGate = deferred<void>();
  const newGate = deferred<void>();
  h.state.writeGates.push(oldGate, newGate);
  const retired = h.controller.decideRequest("request-1", true);

  await h.controller.loadAll("instructor-b");
  // The retired scope's latch and busy entry are gone synchronously.
  assert.equal(hasBusy(h.controller.getState(), "decision"), false);

  const fresh = h.controller.decideRequest("request-2", true);
  assert.equal(hasBusyTarget(h.controller.getState(), "decision", "request-2"), true);

  // The retired operation settles while the newer one is still in flight.
  oldGate.resolve();
  assert.equal(await retired, "blocked");
  // Its finally may not clear the newer scope's busy entry …
  assert.equal(hasBusyTarget(h.controller.getState(), "decision", "request-2"), true);
  // … nor release its latch: a third click is still a duplicate, not a request.
  assert.equal(await h.controller.decideRequest("request-2", true), "duplicate");

  newGate.resolve();
  assert.equal(await fresh, "approved");
  assert.equal(h.state.approveCalls.length, 2);
  assert.equal(hasBusy(h.controller.getState(), "decision"), false);
});

test("a retired scope's failure never publishes its error into the new scope", async () => {
  const h = setup();
  await h.controller.loadAll("instructor-a");
  const gate = deferred<void>();
  h.state.writeGates.push(gate);
  const pending = h.controller.decideRequest("request-1", true);

  await h.controller.loadAll("instructor-b");
  h.state.failDecideWith = new Error("HTTP 500");
  gate.resolve();

  assert.equal(await pending, "blocked");
  // Not "failed": this write belongs to a scope that no longer exists.
  assert.equal(h.controller.getState().decisionError, null);
  assert.equal(h.controller.getState().decisionTargetId, null);
});

test("A → B → A during a decision's refresh still blocks the confirmed decision", async () => {
  const h = setup();
  await h.controller.loadAll("instructor-a");
  const gate = deferred<unknown>();
  h.state.requestsGates.push(gate);
  const pending = h.controller.decideRequest("request-1", true);
  await waitForGatedRead(h.state.requestsGates);

  await h.controller.loadAll("instructor-b");
  await h.controller.loadAll("instructor-a");
  gate.resolve([]);

  assert.equal(await pending, "blocked");
  assert.equal(h.controller.getState().scopeId, "instructor-a");
  assert.equal(h.controller.getState().decisionError, null);
});

test("a create confirmed under the first A is not published after A → B → A", async () => {
  const h = setup();
  await h.controller.loadAll("instructor-a");
  const instance = h.controller.openForm();
  const gate = deferred<void>();
  h.state.writeGates.push(gate);
  const pending = h.controller.submitStudent(form(), instance);

  await h.controller.loadAll("instructor-b");
  await h.controller.loadAll("instructor-a");
  gate.resolve();

  assert.equal(await pending, "blocked");
  // The server wrote, but the confirmed id belongs to a retired lifetime.
  assert.equal(h.controller.getState().createdStudentId, null);
  assert.equal(h.state.createCalls.length, 1);
});

// ---------------------------------------------------------------------------
// M2-18 — Active-branch assignment (planning metadata only)
// ---------------------------------------------------------------------------

test("M2-18: the active-branch catalog is its own section — archived dropped, non-id dropped, hasMore only on a cursor", async () => {
  const h = setup();
  await h.controller.loadBranches();
  const state = h.controller.getState();
  assert.equal(state.branchesPhase, "ready");
  assert.equal(state.branches.length, 2);
  assert.ok(state.branches.every((b) => b.status === "active"));
  assert.equal(state.branchesHasMore, false);
  assert.equal(state.branchesError, null);
});

test("M2-18: a non-null cursor marks the catalog as not complete", async () => {
  const h = setup();
  h.state.branches = { branches: [{ id: BRANCH_1, name: "الفرع الرئيسي", status: "active" }], next_cursor: "cursor-2" };
  await h.controller.loadBranches();
  assert.equal(h.controller.getState().branchesHasMore, true);
});

test("M2-18: the catalog is capped at STUDENT_BRANCH_CATALOG_LIMIT", async () => {
  const h = setup();
  const many = Array.from({ length: STUDENT_BRANCH_CATALOG_LIMIT + 7 }, (_, i) => ({
    id: `branch-${i}`,
    name: `فرع ${i}`,
    status: "active",
  }));
  h.state.branches = { branches: many, next_cursor: null };
  await h.controller.loadBranches();
  assert.equal(h.controller.getState().branches.length, STUDENT_BRANCH_CATALOG_LIMIT);
});

test("M2-18: a malformed branches envelope is an error beside confirmed rows, never an empty catalog", async () => {
  const h = setup();
  await h.controller.loadBranches();
  assert.equal(h.controller.getState().branches.length, 2);
  h.state.branches = { oops: true };
  await h.controller.loadBranches();
  const state = h.controller.getState();
  // The last confirmed rows survive; only a section with nothing confirmed
  // becomes a full error state.
  assert.equal(state.branchesPhase, "ready");
  assert.equal(state.branches.length, 2);
  assert.ok(state.branchesError);
});

test("M2-18: a failed branches read with nothing confirmed is an error", async () => {
  const h = setup();
  const gate = deferred<unknown>();
  h.state.branchesGates.push(gate);
  const pending = h.controller.loadBranches();
  gate.reject(new Error("فروع غير متاحة"));
  await pending;
  const state = h.controller.getState();
  assert.equal(state.branchesPhase, "error");
  assert.equal(state.branchesError, "فروع غير متاحة");
  assert.deepEqual(state.branches, []);
});

test("M2-18: a scope change clears the branch catalog and its assignments", async () => {
  const h = setup();
  await h.controller.loadBranches();
  assert.equal(h.controller.getState().branches.length, 2);
  await h.controller.assignBranch("student-1", BRANCH_1);
  assert.ok(h.controller.getState().branchAssignments["student-1"]);
  // loadStudents adopts the new scope (clearing the branch section) without
  // re-reading it, so the retirement is observable.
  await h.controller.loadStudents("instructor-b");
  const state = h.controller.getState();
  assert.deepEqual(state.branches, []);
  assert.deepEqual(state.branchAssignments, {});
  assert.equal(state.branchesPhase, "idle");
});

test("M2-18: assigning publishes only the server's three-field projection and clears the draft", async () => {
  const h = setup();
  const outcome = await h.controller.assignBranch("student-1", BRANCH_1);
  assert.equal(outcome, "assigned");
  const state = h.controller.getState();
  assert.deepEqual(state.branchAssignments["student-1"], {
    student_id: "student-1",
    branch_id: BRANCH_1,
    branch_name: "الفرع الرئيسي",
  });
  assert.deepEqual(h.state.branchCalls, [{ studentId: "student-1", branchId: BRANCH_1 }]);
  assert.equal(state.branchDraftStudentId, null);
  assert.equal(state.branchDraftId, null);
});

test("M2-18: clearing publishes branch_id null", async () => {
  const h = setup();
  await h.controller.assignBranch("student-1", BRANCH_1);
  const outcome = await h.controller.assignBranch("student-1", null);
  assert.equal(outcome, "cleared");
  assert.deepEqual(h.controller.getState().branchAssignments["student-1"], {
    student_id: "student-1",
    branch_id: null,
    branch_name: null,
  });
  assert.deepEqual(h.state.branchCalls, [
    { studentId: "student-1", branchId: BRANCH_1 },
    { studentId: "student-1", branchId: null },
  ]);
});

test("M2-18: a same-tick duplicate save never reaches the transport", async () => {
  const h = setup();
  const gate = deferred<void>();
  h.state.writeGates.push(gate);
  const first = h.controller.assignBranch("student-1", BRANCH_1);
  const second = h.controller.assignBranch("student-1", BRANCH_1);
  assert.equal(await second, "duplicate");
  assert.equal(h.state.branchCalls.length, 1);
  gate.resolve();
  assert.equal(await first, "assigned");
});

test("M2-18: a non-UUID selector is refused before the transport", async () => {
  const h = setup();
  assert.equal(await h.controller.assignBranch("student-1", "not-a-uuid"), "invalid");
  assert.equal(await h.controller.assignBranch("student-1", ""), "invalid");
  assert.equal(await h.controller.assignBranch("", BRANCH_1), "invalid");
  assert.equal(h.state.branchCalls.length, 0);
});

test("M2-18: a reply naming a different student is refused and never cached", async () => {
  const h = setup();
  h.state.branchResult = { student: { student_id: "student-2", branch_id: BRANCH_1, branch_name: "الفرع الرئيسي" } };
  const outcome = await h.controller.assignBranch("student-1", BRANCH_1);
  assert.equal(outcome, "conflict");
  assert.equal(h.controller.getState().branchAssignments["student-1"], undefined);
});

test("M2-18: a reply naming a different branch is refused and never cached", async () => {
  const h = setup();
  h.state.branchResult = { student: { student_id: "student-1", branch_id: BRANCH_2, branch_name: "فرع التجمع" } };
  const outcome = await h.controller.assignBranch("student-1", BRANCH_1);
  assert.equal(outcome, "conflict");
  assert.equal(h.controller.getState().branchAssignments["student-1"], undefined);
});

test("M2-18: a clear reply whose name is not null is refused", async () => {
  const h = setup();
  h.state.branchResult = { student: { student_id: "student-1", branch_id: null, branch_name: "بقايا" } };
  const outcome = await h.controller.assignBranch("student-1", null);
  assert.equal(outcome, "conflict");
  assert.equal(h.controller.getState().branchAssignments["student-1"], undefined);
});

test("M2-18: denied and not-found clear the draft; a transport error keeps it for a deliberate retry", async () => {
  const denied = setup();
  denied.controller.selectBranch("student-1", BRANCH_1);
  denied.state.failBranchWith = new Error("Forbidden");
  assert.equal(await denied.controller.assignBranch("student-1", BRANCH_1), "denied");
  assert.equal(denied.controller.getState().branchDraftStudentId, null);
  assert.equal(denied.controller.getState().branchError, "Forbidden");

  const nf = setup();
  nf.controller.selectBranch("student-1", BRANCH_1);
  nf.state.failBranchWith = new Error("Student not found");
  assert.equal(await nf.controller.assignBranch("student-1", BRANCH_1), "not-found");
  assert.equal(nf.controller.getState().branchDraftStudentId, null);

  const retry = setup();
  retry.controller.selectBranch("student-1", BRANCH_1);
  retry.state.failBranchWith = new Error("تعذر الحفظ");
  assert.equal(await retry.controller.assignBranch("student-1", BRANCH_1), "failed");
  const state = retry.controller.getState();
  assert.equal(state.branchDraftStudentId, "student-1");
  assert.equal(state.branchDraftId, BRANCH_1);
  assert.equal(state.branchError, "تعذر الحفظ");

  // The same save can now be retried on purpose.
  retry.state.failBranchWith = null;
  assert.equal(await retry.controller.assignBranch("student-1", BRANCH_1), "assigned");
  assert.equal(retry.state.branchCalls.length, 2);
});

test("M2-18: a branch write shows its own busy entry while in flight", async () => {
  const h = setup();
  const gate = deferred<void>();
  h.state.writeGates.push(gate);
  const pending = h.controller.assignBranch("student-1", BRANCH_1);
  assert.equal(hasBusy(h.controller.getState(), "branch"), true);
  assert.equal(hasBusyTarget(h.controller.getState(), "branch", "student-1"), true);
  gate.resolve();
  await pending;
  assert.equal(hasBusy(h.controller.getState(), "branch"), false);
});

test("M2-18: selectBranch arms the draft without transport; clearBranchDraft drops it", async () => {
  const h = setup();
  h.controller.selectBranch("student-1", BRANCH_2);
  let state = h.controller.getState();
  assert.equal(state.branchDraftStudentId, "student-1");
  assert.equal(state.branchDraftId, BRANCH_2);
  assert.equal(h.state.branchCalls.length, 0);
  h.controller.clearBranchDraft();
  state = h.controller.getState();
  assert.equal(state.branchDraftStudentId, null);
  assert.equal(state.branchDraftId, null);
  // A malformed selector never arms the draft.
  h.controller.selectBranch("student-1", "not-a-uuid");
  assert.equal(h.controller.getState().branchDraftStudentId, null);
});

test("M2-18: a branch save that completes after a session change is blocked and commits nothing", async () => {
  const h = setup();
  const gate = deferred<void>();
  h.state.writeGates.push(gate);
  const pending = h.controller.assignBranch("student-1", BRANCH_1);
  h.state.principal = "session-b";
  h.fireSession();
  gate.resolve();
  assert.equal(await pending, "blocked");
  assert.equal(h.controller.getState().branchAssignments["student-1"], undefined);
  assert.equal(h.state.branchCalls.length, 1); // it reached the transport
});

test("M2-18: a branch save that completes after a scope change is blocked", async () => {
  const h = setup();
  await h.controller.loadAll("instructor-a");
  const gate = deferred<void>();
  h.state.writeGates.push(gate);
  const pending = h.controller.assignBranch("student-1", BRANCH_1);
  await h.controller.loadAll("instructor-b");
  gate.resolve();
  assert.equal(await pending, "blocked");
  assert.equal(h.controller.getState().branchAssignments["student-1"], undefined);
});

test("M2-18: branch failure classification uses only the documented server strings", () => {
  assert.equal(classifyStudentBranchFailure(new Error("Forbidden")).kind, "denied");
  assert.equal(classifyStudentBranchFailure(new Error("Tenant membership not found")).kind, "denied");
  assert.equal(classifyStudentBranchFailure(new Error("Student not found")).kind, "not-found");
  assert.equal(classifyStudentBranchFailure(new Error("Branch not found")).kind, "not-found");
  assert.equal(classifyStudentBranchFailure(new Error("Student was modified concurrently")).kind, "conflict");
  assert.equal(classifyStudentBranchFailure(new Error("Invalid student branch payload")).kind, "invalid");
  assert.equal(classifyStudentBranchFailure(new Error("Invalid student id")).kind, "invalid");
  assert.equal(classifyStudentBranchFailure(new Error("HTTP 500")).kind, "error");
  // A near-miss string is never upgraded into a permission or existence claim.
  assert.equal(classifyStudentBranchFailure(new Error("Forbidden but not")).kind, "error");
});

test("M2-18: isStudentBranchId accepts only a canonical UUID", () => {
  assert.equal(isStudentBranchId("b1"), false);
  assert.equal(isStudentBranchId("branch-1"), false);
  assert.equal(isStudentBranchId(BRANCH_1), true);
  assert.equal(isStudentBranchId("123e4567-e89b-12d3-a456-426614174000"), true);
  assert.equal(isStudentBranchId("123E4567-E89B-12D3-A456-426614174000"), true);
  assert.equal(isStudentBranchId(null), false);
  assert.equal(isStudentBranchId(42), false);
});

test("M2-18: normalizeBranchCatalog drops non-active/non-id rows, caps, and reads the cursor", () => {
  assert.equal(normalizeBranchCatalog({ oops: true }), null);
  assert.equal(normalizeBranchCatalog({ branches: "nope" }), null);
  const catalog = normalizeBranchCatalog({
    branches: [
      { id: "b1", name: "أ", status: "active" },
      { id: "", name: "ب", status: "active" },
      { id: "b2", name: "ج", status: "archived" },
      { id: "b3", name: "د", status: "active" },
    ],
    next_cursor: "c2",
  });
  assert.ok(catalog);
  assert.equal(catalog.branches.length, 2);
  assert.ok(catalog.branches.every((b) => b.status === "active"));
  assert.equal(catalog.hasMore, true);
});

test("M2-18: readStudentBranchAssignment validates the SAME student and branch, else null", () => {
  assert.deepEqual(
    readStudentBranchAssignment({ student: { student_id: "s1", branch_id: "b1", branch_name: "أ" } }, "s1", "b1"),
    { student_id: "s1", branch_id: "b1", branch_name: "أ" }
  );
  assert.equal(readStudentBranchAssignment({ student: { student_id: "s2", branch_id: "b1", branch_name: "أ" } }, "s1", "b1"), null);
  assert.equal(readStudentBranchAssignment({ student: { student_id: "s1", branch_id: "b2", branch_name: "ب" } }, "s1", "b1"), null);
  assert.deepEqual(
    readStudentBranchAssignment({ student: { student_id: "s1", branch_id: null, branch_name: null } }, "s1", null),
    { student_id: "s1", branch_id: null, branch_name: null }
  );
  assert.equal(readStudentBranchAssignment({ student: { student_id: "s1", branch_id: null, branch_name: "x" } }, "s1", null), null);
  assert.equal(readStudentBranchAssignment({ nope: 1 }, "s1", null), null);
});

test("a new scope's add is not blocked by the retired scope's add, and A → B → A keeps the reset code private", async () => {
  const h = setup();
  await h.controller.loadAll("instructor-a");
  const instanceA = h.controller.openForm();
  const addGate = deferred<void>();
  h.state.writeGates.push(addGate);
  const retiredAdd = h.controller.submitStudent(form(), instanceA);

  await h.controller.loadAll("instructor-b");
  const instanceB = h.controller.openForm();
  assert.equal(await h.controller.submitStudent(form({ name: "طالب ب" }), instanceB), "created");
  assert.equal(h.state.createCalls.length, 2);

  addGate.resolve();
  assert.equal(await retiredAdd, "blocked");

  // The same lifetime rule holds for the private reset code.
  const resetGate = deferred<void>();
  h.state.writeGates.push(resetGate);
  const pendingReset = h.controller.approveReset("reset-1");
  await h.controller.loadAll("instructor-a");
  resetGate.resolve();
  assert.equal(await pendingReset, "blocked");
  assert.equal(h.controller.getState().resetCode, null);
});
