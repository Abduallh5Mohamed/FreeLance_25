/**
 * M2-01 enrollment workflows — isolated production-path tests (node:test + tsx).
 *
 * Scope: the REAL production orchestration seam the three pages delegate to,
 * `src/features/enrollment/workflows.ts` (imported unchanged by
 * src/pages/JoinInstructor.tsx and src/pages/StudentSpaces.tsx). No copied
 * orchestration: every test drives the same controllers the pages create,
 * with injected fake transports/storage/notifier. Fully isolated: no env
 * files, no DB, no network, no browser, no live services, no real localStorage
 * (an in-memory storage seam is injected).
 *
 * Behaviours pinned (M2-01 acceptance):
 *  - duplicate-before-render suppression (synchronous single-flight latch);
 *  - failure-then-retry with the server message surfaced;
 *  - 401/403/expired (404/410) handling classified from the real contract
 *    (M2-CONTRACTS.md §1); the shared client throws the server's message,
 *    never the status (api-http.ts:69-89);
 *  - invitation A→B→A and reversed completions: a superseded or stale reply
 *    never commits, and a token change clears previous invitation data
 *    synchronously;
 *  - unmount invalidation: nothing in flight commits after dispose();
 *  - space-switch-then-profile-failure: the stale identity keys are discarded
 *    beside the rotated token, the old token is never restored, no success is
 *    implied, and the retry re-reads the profile only (never re-selects);
 *  - distinct loading / empty / expired / denied / error states — an empty
 *    space list renders only after the read completes;
 *  - the persisted space row is derived from the server profile, never from
 *    the clicked (previous-token) list row;
 *  - session ownership (supervisor/051): an obsolete operation never erases a
 *    replacement session's identity (a late success OR failure, and a retry
 *    that loses the session mid-flight), while it may still clear ITS OWN
 *    stale identity; a silent (non-bus) identity replacement blocks a pending
 *    submit / password-reset at completion.
 */
import assert from "node:assert/strict";
import test from "node:test";
import type { EnrollmentInviteInfo, Student, StudentSpace } from "../lib/api";
import {
  CURRENT_STUDENT_KEY,
  CURRENT_STUDENT_SPACE_KEY,
  INVITE_NOT_FOUND_MESSAGE,
  JOIN_DENIED_MESSAGE,
  STUDENT_ACCESS_DENIED_MESSAGE,
  classifyEnrollmentFailure,
  createEnrollmentGuard,
  createEnrollmentSequence,
  createJoinInviteController,
  createStudentSpacesController,
  reconcileInviteSelection,
  type EnrollmentStorage,
  type JoinInviteApi,
  type JoinInviteForm,
  type StudentSpacesApi,
  type StudentSpacesHooks,
} from "../features/enrollment/workflows";

// ---------------------------------------------------------------------------
// Test doubles
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

const inviteInfo = (overrides: Partial<EnrollmentInviteInfo> = {}): EnrollmentInviteInfo => ({
  business_name: "مساحة المدرس أ",
  subject_type: "رياضيات",
  expires_at: "2026-11-16T00:00:00.000Z",
  grades: [
    { id: "g1", name: "الصف الأول" },
    { id: "g2", name: "الصف الثاني" },
  ],
  groups: [
    { id: "grp1", name: "مجموعة أ", grade_id: "g1", course_id: "c1" },
    { id: "grp2", name: "مجموعة ب", grade_id: "g2", course_id: null },
  ],
  courses: [{ id: "c1", name: "كورس الأساسيات", grade: "g1" }],
  ...overrides,
});

const joinForm = (overrides: Partial<JoinInviteForm> = {}): JoinInviteForm => ({
  student_name: "طالب تجريبي",
  phone: "01000000000",
  guardian_name: "ولي الأمر",
  guardian_phone: "01000000001",
  password: "password-1234",
  grade_id: "g1",
  group_id: "grp1",
  requested_courses: ["c1"],
  ...overrides,
});

interface JoinApiRecorder {
  loads: Array<{ token: string; deferred: Deferred<EnrollmentInviteInfo> }>;
  submits: Array<{ token: string; form: JoinInviteForm; deferred: Deferred<{ message: string }> }>;
  resets: Array<{ token: string; phone: string; deferred: Deferred<{ message: string }> }>;
  api: JoinInviteApi;
}

function createJoinApi(): JoinApiRecorder {
  const loads: JoinApiRecorder["loads"] = [];
  const submits: JoinApiRecorder["submits"] = [];
  const resets: JoinApiRecorder["resets"] = [];
  return {
    loads,
    submits,
    resets,
    api: {
      loadInvite: (token) => {
        const d = deferred<EnrollmentInviteInfo>();
        loads.push({ token, deferred: d });
        return d.promise;
      },
      submitRequest: (token, form) => {
        const d = deferred<{ message: string }>();
        submits.push({ token, form, deferred: d });
        return d.promise;
      },
      requestReset: (token, phone) => {
        const d = deferred<{ message: string }>();
        resets.push({ token, phone, deferred: d });
        return d.promise;
      },
    },
  };
}

const space = (overrides: Partial<StudentSpace> = {}): StudentSpace => ({
  student_enrollment_id: "enr1",
  tenant_id: "t1",
  business_name: "مساحة أ",
  grade_id: "g1",
  group_id: "grp1",
  grade_name: "الصف الأول",
  group_name: "مجموعة أ",
  ...overrides,
});

const studentProfile = (
  overrides: Partial<Student & { tenant_id: string; business_name: string }> = {},
): Student & { tenant_id: string; business_name: string } => ({
  id: "enr1",
  name: "طالب تجريبي",
  phone: "01000000000",
  guardian_phone: "01000000001",
  grade_id: "g1",
  group_id: "grp1",
  grade_name: "الصف الأول",
  group_name: "مجموعة أ",
  is_offline: false,
  approval_status: "approved",
  tenant_id: "t1",
  business_name: "مساحة أ",
  ...overrides,
});

interface StorageRecorder {
  store: Map<string, string>;
  writes: Array<{ key: string; value: string }>;
  removals: string[];
  storage: EnrollmentStorage;
}

function createStorage(initial: Record<string, string> = {}): StorageRecorder {
  const store = new Map<string, string>(Object.entries(initial));
  const writes: StorageRecorder["writes"] = [];
  const removals: string[] = [];
  return {
    store,
    writes,
    removals,
    storage: {
      getItem: (key) => (store.has(key) ? (store.get(key) as string) : null),
      setItem: (key, value) => {
        store.set(key, String(value));
        writes.push({ key, value: String(value) });
      },
      removeItem: (key) => {
        store.delete(key);
        removals.push(key);
      },
    },
  };
}

interface SpacesApiRecorder {
  listLoads: Array<Deferred<StudentSpace[]>>;
  rotations: Array<{ enrollmentId: string; deferred: Deferred<{ token: string; tenant_id: string; student_enrollment_id: string }> }>;
  profiles: Array<Deferred<Student & { tenant_id: string; business_name: string }>>;
  api: StudentSpacesApi;
}

function createSpacesApi(): SpacesApiRecorder {
  const listLoads: SpacesApiRecorder["listLoads"] = [];
  const rotations: SpacesApiRecorder["rotations"] = [];
  const profiles: SpacesApiRecorder["profiles"] = [];
  return {
    listLoads,
    rotations,
    profiles,
    api: {
      loadSpaces: () => {
        const d = deferred<StudentSpace[]>();
        listLoads.push(d);
        return d.promise;
      },
      selectSpace: (enrollmentId) => {
        const d = deferred<{ token: string; tenant_id: string; student_enrollment_id: string }>();
        rotations.push({ enrollmentId, deferred: d });
        return d.promise;
      },
      loadProfile: () => {
        const d = deferred<Student & { tenant_id: string; business_name: string }>();
        profiles.push(d);
        return d.promise;
      },
    },
  };
}

function spacesController(recorder: SpacesApiRecorder, hooks: StudentSpacesHooks) {
  return createStudentSpacesController(recorder.api, hooks);
}

// ---------------------------------------------------------------------------
// Shared guards and classification
// ---------------------------------------------------------------------------

test("single-flight guard rejects a second acquire until release", () => {
  const guard = createEnrollmentGuard();
  assert.equal(guard.acquire(), true);
  assert.equal(guard.acquire(), false);
  assert.equal(guard.isBusy(), true);
  guard.release();
  assert.equal(guard.isBusy(), false);
  assert.equal(guard.acquire(), true);
});

test("load sequence drops everything but the latest generation", () => {
  const sequence = createEnrollmentSequence();
  const first = sequence.next();
  const second = sequence.next();
  assert.equal(sequence.isCurrent(first), false);
  assert.equal(sequence.isCurrent(second), true);
  sequence.invalidate();
  assert.equal(sequence.isCurrent(second), false);
});

test("failure classification follows the real server contract", () => {
  assert.deepEqual(classifyEnrollmentFailure(new Error(INVITE_NOT_FOUND_MESSAGE)), {
    kind: "expired",
    message: INVITE_NOT_FOUND_MESSAGE,
  });
  assert.deepEqual(classifyEnrollmentFailure(Object.assign(new Error("x"), { status: 410 })), {
    kind: "expired",
    message: "x",
  });
  assert.deepEqual(classifyEnrollmentFailure(new Error(JOIN_DENIED_MESSAGE)), {
    kind: "denied",
    message: JOIN_DENIED_MESSAGE,
  });
  assert.deepEqual(classifyEnrollmentFailure(Object.assign(new Error("x"), { status: 403 })), {
    kind: "denied",
    message: "x",
  });
  assert.deepEqual(classifyEnrollmentFailure(Object.assign(new Error("x"), { status: 429 })), {
    kind: "unavailable",
    message: "x",
  });
  assert.deepEqual(classifyEnrollmentFailure(new Error("HTTP 500")), {
    kind: "error",
    message: "HTTP 500",
  });
  assert.equal(classifyEnrollmentFailure("boom").message, "boom");
});

test("reconcileInviteSelection keeps a compatible selection and drops an incompatible one", () => {
  const info = inviteInfo();
  const form = joinForm();
  assert.equal(reconcileInviteSelection(form, info), form, "compatible selection must be stable");

  const stale = joinForm({ grade_id: "gX", group_id: "grpX", requested_courses: ["c1", "gone"] });
  const reconciled = reconcileInviteSelection(stale, info);
  assert.equal(reconciled.grade_id, "");
  assert.equal(reconciled.group_id, "");
  assert.deepEqual(reconciled.requested_courses, ["c1"]);
  assert.equal(reconciled.student_name, stale.student_name, "entered values are retained");

  const crossGrade = joinForm({ grade_id: "g1", group_id: "grp2" });
  const fixed = reconcileInviteSelection(crossGrade, info);
  assert.equal(fixed.group_id, "", "a group of another grade is cleared");
  assert.equal(reconcileInviteSelection(form, null), form);
});

// ---------------------------------------------------------------------------
// Journey 1 — join invitation load (A→B→A, reversed, unmount)
// ---------------------------------------------------------------------------

test("a token change clears the previous invitation synchronously and a stale reply never commits", async () => {
  const recorder = createJoinApi();
  const controller = createJoinInviteController(recorder.api);

  const first = controller.loadInvite("tokenA");
  recorder.loads[0].deferred.resolve(inviteInfo({ business_name: "مساحة أ" }));
  await first;
  assert.equal(controller.getState().phase, "ready");
  assert.equal(controller.getState().info?.business_name, "مساحة أ");

  // Switching the token must clear the previous invitation data at once —
  // no stale business name, grades, groups or success under the new token.
  const second = controller.loadInvite("tokenB");
  assert.equal(controller.getState().phase, "loading");
  assert.equal(controller.getState().info, null);
  recorder.loads[1].deferred.resolve(inviteInfo({ business_name: "مساحة ب" }));
  await second;
  assert.equal(controller.getState().info?.business_name, "مساحة ب");

  // The superseded reply for tokenA arrives late and must not commit.
  // (First load already resolved; simulate a reversed order below.)
  const third = controller.loadInvite("tokenA");
  assert.equal(controller.getState().info, null);
  recorder.loads[2].deferred.resolve(inviteInfo({ business_name: "مساحة أ" }));
  await third;
  assert.equal(controller.getState().token, "tokenA");
  assert.equal(controller.getState().info?.business_name, "مساحة أ");
});

test("reversed completions: the earlier load's reply is dropped", async () => {
  const recorder = createJoinApi();
  const controller = createJoinInviteController(recorder.api);

  const first = controller.loadInvite("tokenA");
  const second = controller.loadInvite("tokenB");
  // The older request settles LAST (reversed completion).
  recorder.loads[1].deferred.resolve(inviteInfo({ business_name: "مساحة ب" }));
  await second;
  recorder.loads[0].deferred.resolve(inviteInfo({ business_name: "مساحة أ" }));
  await first;
  assert.equal(controller.getState().info?.business_name, "مساحة ب");
  assert.equal(controller.getState().token, "tokenB");
});

test("invitation load failures map to expired / denied / error states", async () => {
  const recorder = createJoinApi();
  const controller = createJoinInviteController(recorder.api);

  const expired = controller.loadInvite("tokenA");
  recorder.loads[0].deferred.reject(new Error(INVITE_NOT_FOUND_MESSAGE));
  await expired;
  assert.equal(controller.getState().phase, "expired");
  assert.equal(controller.getState().message, INVITE_NOT_FOUND_MESSAGE);
  assert.equal(controller.getState().info, null);

  recorder.loads.length = 0;
  const denied = controller.loadInvite("tokenB");
  recorder.loads[0].deferred.reject(new Error(JOIN_DENIED_MESSAGE));
  await denied;
  assert.equal(controller.getState().phase, "denied");

  recorder.loads.length = 0;
  const failed = controller.loadInvite("tokenC");
  recorder.loads[0].deferred.reject(new Error("HTTP 503"));
  await failed;
  assert.equal(controller.getState().phase, "error");
  assert.equal(controller.getState().failure?.kind, "error");
});

test("a malformed invitation body fails closed instead of rendering an empty form", async () => {
  const recorder = createJoinApi();
  const controller = createJoinInviteController(recorder.api);
  const pending = controller.loadInvite("tokenA");
  recorder.loads[0].deferred.resolve({ business_name: "x" } as unknown as EnrollmentInviteInfo);
  await pending;
  assert.equal(controller.getState().phase, "error");
  assert.equal(controller.getState().info, null);
  assert.match(controller.getState().message ?? "", /استجابة غير صالحة/);
});

test("unmount invalidation: a late invitation reply never commits", async () => {
  const recorder = createJoinApi();
  const controller = createJoinInviteController(recorder.api);
  const seen: string[] = [];
  controller.subscribe((state) => seen.push(state.phase));

  const pending = controller.loadInvite("tokenA");
  controller.dispose();
  recorder.loads[0].deferred.resolve(inviteInfo());
  await pending;
  assert.equal(controller.getState().phase, "loading");
  assert.equal(controller.getState().info, null);
  assert.ok(!seen.includes("ready"), "no subscriber may observe the post-unmount commit");
});

// ---------------------------------------------------------------------------
// Journey 1 — submit / password-reset single-flight
// ---------------------------------------------------------------------------

test("a duplicate submit fired before render never reaches the transport", async () => {
  const recorder = createJoinApi();
  const controller = createJoinInviteController(recorder.api);
  const loaded = controller.loadInvite("tokenA");
  recorder.loads[0].deferred.resolve(inviteInfo());
  await loaded;

  const first = controller.submit(joinForm());
  const second = controller.submit(joinForm());
  assert.equal(recorder.submits.length, 1, "exactly one request per operation");
  recorder.submits[0].deferred.resolve({ message: "queued" });
  assert.equal(await first, "submitted");
  assert.equal(await second, "blocked");
  assert.equal(controller.getState().submitted, true);
  assert.equal(controller.getState().busyKind, null);

  // A completed join request can never be submitted again.
  assert.equal(await controller.submit(joinForm()), "blocked");
  assert.equal(recorder.submits.length, 1);
});

test("submit without a current invitation is blocked, not sent", async () => {
  const recorder = createJoinApi();
  const controller = createJoinInviteController(recorder.api);
  const loading = controller.loadInvite("tokenA");
  recorder.loads[0].deferred.reject(new Error(INVITE_NOT_FOUND_MESSAGE));
  await loading;
  assert.equal(await controller.submit(joinForm()), "blocked");
  assert.equal(recorder.submits.length, 0);
});

test("a selection the loaded invitation does not contain is rejected before the request", async () => {
  const recorder = createJoinApi();
  const controller = createJoinInviteController(recorder.api);
  const loaded = controller.loadInvite("tokenA");
  recorder.loads[0].deferred.resolve(inviteInfo());
  await loaded;
  const outcome = await controller.submit(joinForm({ grade_id: "gX", group_id: "grpX" }));
  assert.equal(outcome, "invalid");
  assert.equal(recorder.submits.length, 0);
  assert.match(controller.getState().actionError ?? "", /مطابقًا/);
});

test("a short anonymous password is rejected before the request", async () => {
  const recorder = createJoinApi();
  const controller = createJoinInviteController(recorder.api);
  const loaded = controller.loadInvite("tokenA");
  recorder.loads[0].deferred.resolve(inviteInfo());
  await loaded;
  const outcome = await controller.submit(joinForm({ password: "short" }), { passwordRequired: true });
  assert.equal(outcome, "invalid");
  assert.equal(recorder.submits.length, 0);
});

test("a failed submit keeps the operation retryable and surfaces the server message", async () => {
  const recorder = createJoinApi();
  const controller = createJoinInviteController(recorder.api);
  const loaded = controller.loadInvite("tokenA");
  recorder.loads[0].deferred.resolve(inviteInfo());
  await loaded;

  const failed = controller.submit(joinForm());
  recorder.submits[0].deferred.reject(new Error("Invitation is invalid or expired"));
  assert.equal(await failed, "failed");
  assert.equal(controller.getState().submitted, false);
  assert.equal(controller.getState().busyKind, null);
  assert.equal(controller.getState().actionError, INVITE_NOT_FOUND_MESSAGE);

  // Retry: the latch was released, the entered form stays with the page and
  // the second attempt reaches the transport and succeeds.
  const retried = controller.submit(joinForm());
  assert.equal(recorder.submits.length, 2);
  recorder.submits[1].deferred.resolve({ message: "queued" });
  assert.equal(await retried, "submitted");
  assert.equal(controller.getState().actionError, null);
});

test("submit and password-reset share one synchronous latch", async () => {
  const recorder = createJoinApi();
  const controller = createJoinInviteController(recorder.api);
  const loaded = controller.loadInvite("tokenA");
  recorder.loads[0].deferred.resolve(inviteInfo());
  await loaded;

  const submitted = controller.submit(joinForm());
  const reset = await controller.requestPasswordReset("01000000000");
  assert.equal(reset, "blocked");
  assert.equal(recorder.resets.length, 0, "a reset cannot fire while a submit is in flight");
  assert.equal(recorder.submits.length, 1);
  recorder.submits[0].deferred.resolve({ message: "queued" });
  await submitted;
});

test("password reset runs one request and keeps the phone on failure", async () => {
  const recorder = createJoinApi();
  const controller = createJoinInviteController(recorder.api);
  const loaded = controller.loadInvite("tokenA");
  recorder.loads[0].deferred.resolve(inviteInfo());
  await loaded;

  assert.equal(await controller.requestPasswordReset("  "), "invalid");
  assert.equal(recorder.resets.length, 0);

  const failed = controller.requestPasswordReset("01000000000");
  recorder.resets[0].deferred.reject(new Error("HTTP 503"));
  assert.equal(await failed, "failed");
  assert.equal(controller.getState().resetSent, false);
  assert.equal(controller.getState().actionError, "HTTP 503");

  const retried = controller.requestPasswordReset("01000000000");
  assert.equal(recorder.resets.length, 2);
  assert.equal(recorder.resets[1].phone, "01000000000");
  recorder.resets[1].deferred.resolve({ message: "queued" });
  assert.equal(await retried, "sent");
  assert.equal(controller.getState().resetSent, true);
});

// ---------------------------------------------------------------------------
// Journey 1 — mutation lifecycle (supervisor/049): a mutation belongs to the
// token, generation and principal it started under
// ---------------------------------------------------------------------------

test("a superseded join submit never marks a different invitation submitted", async () => {
  const recorder = createJoinApi();
  const controller = createJoinInviteController(recorder.api);

  const loaded = controller.loadInvite("tokenA");
  recorder.loads[0].deferred.resolve(inviteInfo({ business_name: "مساحة أ" }));
  await loaded;
  assert.equal(controller.getState().phase, "ready");

  const submitting = controller.submit(joinForm());
  assert.equal(recorder.submits.length, 1);
  assert.equal(recorder.submits[0].token, "tokenA");

  // The route changes while the request is in flight (a different link is
  // opened): A's success must land nowhere.
  const switched = controller.loadInvite("tokenB");
  recorder.loads[1].deferred.resolve(inviteInfo({ business_name: "مساحة ب" }));
  await switched;
  assert.equal(controller.getState().info?.business_name, "مساحة ب");

  recorder.submits[0].deferred.resolve({ message: "queued" });
  assert.equal(await submitting, "blocked");
  assert.equal(controller.getState().submitted, false, "A's success must not mark B submitted");
  assert.equal(controller.getState().token, "tokenB");
  assert.equal(controller.getState().busyKind, null, "the retired attempt leaves no busy marker");
});

test("a superseded password reset never marks the new invitation's reset as sent", async () => {
  const recorder = createJoinApi();
  const controller = createJoinInviteController(recorder.api);

  const loaded = controller.loadInvite("tokenA");
  recorder.loads[0].deferred.resolve(inviteInfo());
  await loaded;

  const resetting = controller.requestPasswordReset("01000000000");
  assert.equal(recorder.resets.length, 1);

  const switched = controller.loadInvite("tokenB");
  recorder.loads[1].deferred.resolve(inviteInfo());
  await switched;

  recorder.resets[0].deferred.resolve({ message: "queued" });
  assert.equal(await resetting, "blocked");
  assert.equal(controller.getState().resetSent, false);
  assert.equal(controller.getState().actionError, null);
});

test("invitation A -> B -> A does not revive the old submit", async () => {
  const recorder = createJoinApi();
  const controller = createJoinInviteController(recorder.api);

  const first = controller.loadInvite("tokenA");
  recorder.loads[0].deferred.resolve(inviteInfo());
  await first;

  const submitting = controller.submit(joinForm());
  // Route goes A -> B and back to A: the token text is the same again, so
  // only the captured generation can retire the old mutation.
  const toB = controller.loadInvite("tokenB");
  recorder.loads[1].deferred.resolve(inviteInfo());
  await toB;
  const backToA = controller.loadInvite("tokenA");
  recorder.loads[2].deferred.resolve(inviteInfo());
  await backToA;
  assert.equal(controller.getState().token, "tokenA");

  recorder.submits[0].deferred.resolve({ message: "queued" });
  assert.equal(await submitting, "blocked");
  assert.equal(controller.getState().submitted, false, "an old incarnation of A must not commit");
});

test("a superseded submit failure does not surface an error for the new invitation", async () => {
  const recorder = createJoinApi();
  const controller = createJoinInviteController(recorder.api);

  const loaded = controller.loadInvite("tokenA");
  recorder.loads[0].deferred.resolve(inviteInfo());
  await loaded;

  const submitting = controller.submit(joinForm());
  const switched = controller.loadInvite("tokenB");
  recorder.loads[1].deferred.resolve(inviteInfo());
  await switched;

  recorder.submits[0].deferred.reject(new Error(INVITE_NOT_FOUND_MESSAGE));
  assert.equal(await submitting, "blocked");
  assert.equal(controller.getState().actionError, null, "B's form is never blamed for A's failure");
  assert.equal(controller.getState().phase, "ready");
});

test("unmount during a join submit: the late success never commits", async () => {
  const recorder = createJoinApi();
  const controller = createJoinInviteController(recorder.api);
  const loaded = controller.loadInvite("tokenA");
  recorder.loads[0].deferred.resolve(inviteInfo());
  await loaded;

  const submitting = controller.submit(joinForm());
  controller.dispose();
  recorder.submits[0].deferred.resolve({ message: "queued" });
  assert.equal(await submitting, "blocked");
  assert.equal(controller.getState().submitted, false);
});

test("a route change retires the in-flight latch instead of blocking the new invitation", async () => {
  const recorder = createJoinApi();
  const controller = createJoinInviteController(recorder.api);
  const loaded = controller.loadInvite("tokenA");
  recorder.loads[0].deferred.resolve(inviteInfo());
  await loaded;

  const stale = controller.submit(joinForm());
  const switched = controller.loadInvite("tokenB");
  recorder.loads[1].deferred.resolve(inviteInfo());
  await switched;

  // The retired operation must not keep the journey busy: B can submit now.
  const current = controller.submit(joinForm());
  assert.equal(recorder.submits.length, 2, "the new invitation is not blocked by the retired one");
  assert.equal(recorder.submits[1].token, "tokenB");

  // The stale attempt settles: it must not commit AND its `finally` must not
  // release the newer operation's latch (that would let a duplicate through).
  recorder.submits[0].deferred.resolve({ message: "queued" });
  assert.equal(await stale, "blocked");
  const duplicate = await controller.submit(joinForm());
  assert.equal(duplicate, "blocked", "the newer submit still owns the latch");
  assert.equal(recorder.submits.length, 2);

  recorder.submits[1].deferred.resolve({ message: "queued" });
  assert.equal(await current, "submitted");
  assert.equal(controller.getState().submitted, true);
  assert.equal(controller.getState().token, "tokenB");
});

test("an empty route token invalidates the previous invitation without a request", async () => {
  const recorder = createJoinApi();
  const controller = createJoinInviteController(recorder.api);

  const loaded = controller.loadInvite("tokenA");
  recorder.loads[0].deferred.resolve(inviteInfo());
  await loaded;
  const submitting = controller.submit(joinForm());
  recorder.submits[0].deferred.resolve({ message: "queued" });
  await submitting;
  assert.equal(controller.getState().submitted, true);

  // The route loses its token: the previous invitation's success must not win
  // over the new route, and no request is fired for an incomplete link.
  const emptied = controller.loadInvite("");
  await emptied;
  assert.equal(recorder.loads.length, 1, "no request for an incomplete link");
  assert.equal(controller.getState().phase, "incomplete");
  assert.equal(controller.getState().token, "");
  assert.equal(controller.getState().info, null);
  assert.equal(controller.getState().submitted, false, "the old success does not survive the route change");
  assert.match(controller.getState().message ?? "", /غير مكتمل/);
});

test("an identity change retires an in-flight submit", async () => {
  const recorder = createJoinApi();
  let identity: string | null = "anon:";
  const controller = createJoinInviteController({ ...recorder.api, readIdentity: () => identity });

  const loaded = controller.loadInvite("tokenA");
  recorder.loads[0].deferred.resolve(inviteInfo());
  await loaded;

  const submitting = controller.submit(joinForm(), { passwordRequired: true });
  assert.equal(recorder.submits.length, 1);

  // The session identity changed while the request was in flight (login in
  // this document): the password-required precondition it was submitted under
  // no longer holds, so the mutation is retired.
  identity = "student:s1";
  controller.syncIdentity();
  recorder.submits[0].deferred.resolve({ message: "queued" });
  assert.equal(await submitting, "blocked");
  assert.equal(controller.getState().submitted, false);
  assert.equal(controller.getState().busyKind, null);
});

// ---------------------------------------------------------------------------
// Journey 3 — student spaces: loading / empty / denied / error
// ---------------------------------------------------------------------------

test("the empty state renders only after the spaces read completes", async () => {
  const recorder = createSpacesApi();
  const storage = createStorage();
  const notifications: string[] = [];
  const controller = spacesController(recorder, {
    storage: storage.storage,
    notify: (kind) => notifications.push(kind),
  });

  const pending = controller.loadSpaces();
  // In flight: the journey must show loading — never "no membership".
  assert.equal(controller.getState().phase, "loading");
  assert.equal(controller.getState().spaces.length, 0);

  recorder.listLoads[0].resolve([]);
  await pending;
  assert.equal(controller.getState().phase, "empty");
});

test("a spaces read failure is an error state with a working retry", async () => {
  const recorder = createSpacesApi();
  const storage = createStorage();
  const controller = spacesController(recorder, { storage: storage.storage });

  const failed = controller.loadSpaces();
  recorder.listLoads[0].reject(new Error(STUDENT_ACCESS_DENIED_MESSAGE));
  await failed;
  assert.equal(controller.getState().phase, "error");
  assert.equal(controller.getState().failure?.kind, "denied");
  assert.equal(controller.getState().message, STUDENT_ACCESS_DENIED_MESSAGE);

  const retried = controller.loadSpaces();
  recorder.listLoads[1].resolve([space()]);
  await retried;
  assert.equal(controller.getState().phase, "ready");
  assert.equal(controller.getState().spaces.length, 1);
});

test("a malformed spaces body is an error, not an empty list", async () => {
  const recorder = createSpacesApi();
  const storage = createStorage();
  const controller = spacesController(recorder, { storage: storage.storage });
  const pending = controller.loadSpaces();
  recorder.listLoads[0].resolve({ nope: true } as unknown as StudentSpace[]);
  await pending;
  assert.equal(controller.getState().phase, "error");
  assert.match(controller.getState().message ?? "", /استجابة غير صالحة/);
});

test("a spaces load failure after unmount never commits", async () => {
  const recorder = createSpacesApi();
  const storage = createStorage();
  const controller = spacesController(recorder, { storage: storage.storage });
  const seen: string[] = [];
  controller.subscribe((state) => seen.push(state.phase));

  const pending = controller.loadSpaces();
  controller.dispose();
  recorder.listLoads[0].reject(new Error("late failure"));
  await pending;
  assert.equal(controller.getState().phase, "loading");
  assert.ok(!seen.includes("error"));
});

// ---------------------------------------------------------------------------
// Journey 3 — selection: single-flight, happy path, failures, token swap
// ---------------------------------------------------------------------------

test("selection is single-flight across rows and commits only server data", async () => {
  const recorder = createSpacesApi();
  const storage = createStorage();
  const notifications: string[] = [];
  let navigations = 0;
  const controller = spacesController(recorder, {
    storage: storage.storage,
    notify: (kind) => notifications.push(kind),
    onSelected: () => { navigations += 1; },
  });

  const loaded = controller.loadSpaces();
  recorder.listLoads[0].resolve([space(), space({ student_enrollment_id: "enr2", business_name: "مساحة ب" })]);
  await loaded;

  // The clicked row carries stale names on purpose: the persisted identity
  // must come from the server profile, never from the clicked row.
  const target = space({ business_name: "اسم قديم من القائمة" });
  const first = controller.select(target);
  const duplicate = controller.select(space({ student_enrollment_id: "enr2" }));
  assert.equal(await duplicate, "duplicate");
  assert.equal(recorder.rotations.length, 1);
  assert.equal(recorder.rotations[0].enrollmentId, target.student_enrollment_id);

  recorder.rotations[0].deferred.resolve({ token: "new-token", tenant_id: "t1", student_enrollment_id: "enr1" });
  await Promise.resolve();
  assert.equal(controller.getState().selectingId, "enr1");
  recorder.profiles[0].resolve(studentProfile({ business_name: "مساحة أ" }));
  assert.equal(await first, "selected");

  assert.equal(navigations, 1);
  assert.deepEqual(notifications, ["scope"]);
  assert.equal(controller.getState().selectingId, null);
  assert.equal(controller.getState().pendingIdentityLoad, false);

  const storedStudent = JSON.parse(storage.store.get(CURRENT_STUDENT_KEY) as string);
  assert.equal(storedStudent.business_name, "مساحة أ");
  const storedSpace = JSON.parse(storage.store.get(CURRENT_STUDENT_SPACE_KEY) as string);
  assert.equal(storedSpace.business_name, "مساحة أ", "the space row comes from the server profile");
  assert.equal(storedSpace.student_enrollment_id, "enr1");
  assert.equal(storage.removals.length, 0);
});

test("token swap then profile failure discards the stale identity and never restores the old token", async () => {
  const recorder = createSpacesApi();
  const storage = createStorage({
    currentStudent: JSON.stringify(studentProfile({ business_name: "مساحة سابقة" })),
    currentStudentSpace: JSON.stringify(space({ business_name: "مساحة سابقة" })),
    authToken: "old-token",
  });
  const notifications: string[] = [];
  let navigations = 0;
  const controller = spacesController(recorder, {
    storage: storage.storage,
    notify: (kind) => notifications.push(kind),
    onSelected: () => { navigations += 1; },
  });

  const loaded = controller.loadSpaces();
  recorder.listLoads[0].resolve([space()]);
  await loaded;

  const selecting = controller.select(space());
  recorder.rotations[0].deferred.resolve({ token: "new-token", tenant_id: "t1", student_enrollment_id: "enr1" });
  await Promise.resolve();
  // The scoped profile read fails after the token already rotated.
  recorder.profiles[0].reject(new Error("Select an instructor workspace first"));
  assert.equal(await selecting, "profile-failed");

  // The previous space's identity must not sit beside the new token.
  assert.equal(storage.store.has(CURRENT_STUDENT_KEY), false);
  assert.equal(storage.store.has(CURRENT_STUDENT_SPACE_KEY), false);
  assert.equal(storage.store.get("authToken"), "old-token", "the old token is never restored");
  assert.equal(navigations, 0, "no success is implied");
  assert.deepEqual(notifications, ["identity"]);
  assert.equal(controller.getState().pendingIdentityLoad, true);
  assert.equal(controller.getState().selectionError, "Select an instructor workspace first");

  // The retry re-reads the profile only — it never re-selects (no second
  // token rotation) and commits on the server profile.
  const retried = controller.retryIdentityLoad();
  assert.equal(recorder.rotations.length, 1, "retry must not re-select the space");
  assert.equal(recorder.profiles.length, 2);
  recorder.profiles[1].resolve(studentProfile({ business_name: "مساحة أ" }));
  assert.equal(await retried, "selected");
  assert.equal(navigations, 1);
  assert.deepEqual(notifications, ["identity", "scope"]);
  assert.equal(JSON.parse(storage.store.get(CURRENT_STUDENT_KEY) as string).business_name, "مساحة أ");
});

test("a profile/enrollment mismatch after rotation fails closed", async () => {
  const recorder = createSpacesApi();
  const storage = createStorage();
  const notifications: string[] = [];
  const controller = spacesController(recorder, {
    storage: storage.storage,
    notify: (kind) => notifications.push(kind),
  });

  const loaded = controller.loadSpaces();
  recorder.listLoads[0].resolve([space()]);
  await loaded;

  const selecting = controller.select(space());
  recorder.rotations[0].deferred.resolve({ token: "new-token", tenant_id: "t1", student_enrollment_id: "enr1" });
  await Promise.resolve();
  recorder.profiles[0].resolve(studentProfile({ id: "some-other-enrollment" }));
  assert.equal(await selecting, "profile-failed");
  assert.equal(storage.store.has(CURRENT_STUDENT_KEY), false);
  assert.ok(!notifications.includes("scope"));
  assert.equal(controller.getState().pendingIdentityLoad, true);
});

test("a failed rotation leaves the previous identity untouched", async () => {
  const recorder = createSpacesApi();
  const storage = createStorage({ currentStudent: JSON.stringify(studentProfile()) });
  const notifications: string[] = [];
  let navigations = 0;
  const controller = spacesController(recorder, {
    storage: storage.storage,
    notify: (kind) => notifications.push(kind),
    onSelected: () => { navigations += 1; },
  });

  const loaded = controller.loadSpaces();
  recorder.listLoads[0].resolve([space()]);
  await loaded;

  const selecting = controller.select(space());
  recorder.rotations[0].deferred.reject(new Error("Student workspace not found"));
  assert.equal(await selecting, "failed");
  assert.equal(controller.getState().selectionError, "Student workspace not found");
  assert.equal(controller.getState().pendingIdentityLoad, false);
  assert.equal(storage.store.has(CURRENT_STUDENT_KEY), true, "the previous identity stays valid");
  assert.deepEqual(notifications, []);
  assert.equal(navigations, 0);

  // The user can try again from the retained list.
  const retried = controller.select(space());
  assert.equal(recorder.rotations.length, 2);
  recorder.rotations[1].deferred.resolve({ token: "new-token", tenant_id: "t1", student_enrollment_id: "enr1" });
  await Promise.resolve();
  recorder.profiles[0].resolve(studentProfile());
  assert.equal(await retried, "selected");
  assert.equal(navigations, 1);
});

test("unmount during selection: the late profile reply never commits", async () => {
  const recorder = createSpacesApi();
  const storage = createStorage();
  const notifications: string[] = [];
  let navigations = 0;
  const controller = spacesController(recorder, {
    storage: storage.storage,
    notify: (kind) => notifications.push(kind),
    onSelected: () => { navigations += 1; },
  });

  const loaded = controller.loadSpaces();
  recorder.listLoads[0].resolve([space()]);
  await loaded;

  const selecting = controller.select(space());
  recorder.rotations[0].deferred.resolve({ token: "new-token", tenant_id: "t1", student_enrollment_id: "enr1" });
  await Promise.resolve();
  controller.dispose();
  recorder.profiles[0].resolve(studentProfile());
  assert.equal(await selecting, "blocked");
  assert.equal(storage.writes.length, 0);
  assert.deepEqual(notifications, []);
  assert.equal(navigations, 0);
});

test("selection without a loaded list is blocked", async () => {
  const recorder = createSpacesApi();
  const storage = createStorage();
  const controller = spacesController(recorder, { storage: storage.storage });
  assert.equal(await controller.select(space()), "blocked");
  assert.equal(recorder.rotations.length, 0);
});

// ---------------------------------------------------------------------------
// Journey 3 — external session boundary (supervisor/049): a late profile must
// not persist an identity into a session that is no longer ours
// ---------------------------------------------------------------------------

test("the session boundary does not block the rotation it produced", async () => {
  const recorder = createSpacesApi();
  const storage = createStorage();
  const notifications: string[] = [];
  let navigations = 0;
  let authToken: string | null = "old-token";
  const controller = spacesController(recorder, {
    storage: storage.storage,
    notify: (kind) => notifications.push(kind),
    onSelected: () => { navigations += 1; },
    readAuthToken: () => authToken,
  });

  const loaded = controller.loadSpaces();
  recorder.listLoads[0].resolve([space()]);
  await loaded;

  const selecting = controller.select(space());
  recorder.rotations[0].deferred.resolve({ token: "rotated-token", tenant_id: "t1", student_enrollment_id: "enr1" });
  authToken = "rotated-token"; // our own rotation wrote it (api-http.ts:2278)
  await Promise.resolve();
  recorder.profiles[0].resolve(studentProfile({ business_name: "مساحة أ" }));
  assert.equal(await selecting, "selected");
  assert.deepEqual(notifications, ["scope"]);
  assert.equal(navigations, 1);
  assert.equal(JSON.parse(storage.store.get(CURRENT_STUDENT_KEY) as string).business_name, "مساحة أ");
});

test("a replaced session blocks the identity commit even when the profile succeeds", async () => {
  const recorder = createSpacesApi();
  const storage = createStorage({ currentStudent: JSON.stringify(studentProfile({ business_name: "مساحة سابقة" })) });
  const notifications: string[] = [];
  let navigations = 0;
  let authToken: string | null = "old-token";
  const controller = spacesController(recorder, {
    storage: storage.storage,
    notify: (kind) => notifications.push(kind),
    onSelected: () => { navigations += 1; },
    readAuthToken: () => authToken,
  });

  const loaded = controller.loadSpaces();
  recorder.listLoads[0].resolve([space()]);
  await loaded;

  const selecting = controller.select(space());
  recorder.rotations[0].deferred.resolve({ token: "rotated-token", tenant_id: "t1", student_enrollment_id: "enr1" });
  authToken = "rotated-token";
  await Promise.resolve();
  // Another session replaced the token while the profile read was in flight.
  authToken = "someone-elses-token";
  recorder.profiles[0].resolve(studentProfile({ business_name: "مساحة أ" }));

  assert.equal(await selecting, "profile-failed");
  assert.equal(storage.store.has(CURRENT_STUDENT_KEY), false, "no identity is written into a foreign session");
  assert.ok(!notifications.includes("scope"), "never announce a scope change we do not own");
  assert.equal(navigations, 0, "no success is implied");
  assert.equal(controller.getState().pendingIdentityLoad, true);
});

test("a logout under the selection blocks the identity commit", async () => {
  const recorder = createSpacesApi();
  const storage = createStorage({ currentStudent: JSON.stringify(studentProfile()) });
  const notifications: string[] = [];
  let authToken: string | null = "old-token";
  const controller = spacesController(recorder, {
    storage: storage.storage,
    notify: (kind) => notifications.push(kind),
    readAuthToken: () => authToken,
  });

  const loaded = controller.loadSpaces();
  recorder.listLoads[0].resolve([space()]);
  await loaded;

  const selecting = controller.select(space());
  recorder.rotations[0].deferred.resolve({ token: "rotated-token", tenant_id: "t1", student_enrollment_id: "enr1" });
  authToken = "rotated-token";
  await Promise.resolve();
  authToken = null; // logout cleared the canonical token (api-http.ts:38)
  recorder.profiles[0].resolve(studentProfile());

  assert.equal(await selecting, "profile-failed");
  assert.equal(storage.store.has(CURRENT_STUDENT_KEY), false);
  assert.ok(!notifications.includes("scope"));
  assert.equal(controller.getState().pendingIdentityLoad, true);
});

test("a pending identity retry is refused after the session changed", async () => {
  const recorder = createSpacesApi();
  const storage = createStorage();
  let authToken: string | null = "old-token";
  const controller = spacesController(recorder, {
    storage: storage.storage,
    readAuthToken: () => authToken,
  });

  const loaded = controller.loadSpaces();
  recorder.listLoads[0].resolve([space()]);
  await loaded;

  const selecting = controller.select(space());
  recorder.rotations[0].deferred.resolve({ token: "rotated-token", tenant_id: "t1", student_enrollment_id: "enr1" });
  authToken = "rotated-token";
  await Promise.resolve();
  recorder.profiles[0].reject(new Error("HTTP 503"));
  assert.equal(await selecting, "profile-failed");
  assert.equal(controller.getState().pendingIdentityLoad, true);

  // The session changed: retrying would read ANOTHER session's profile.
  authToken = "another-token";
  assert.equal(await controller.retryIdentityLoad(), "blocked");
  assert.equal(recorder.profiles.length, 1, "no profile read under a foreign token");
  assert.equal(controller.getState().pendingIdentityLoad, true);
});

// ---------------------------------------------------------------------------
// Journey 3 — session-OWNERSHIP boundary (supervisor/051): an obsolete
// operation must never erase a NEWER session's identity, while our OWN stale
// identity may still be cleaned up. Ownership + baseline decide, not a blind
// unconditional removeItem.
// ---------------------------------------------------------------------------

test("supervisor051: a late successful profile never erases the replacement owner's identity", async () => {
  const recorder = createSpacesApi();
  const storage = createStorage();
  const notifications: string[] = [];
  let navigations = 0;
  let currentToken = "session-A";
  const controller = spacesController(recorder, {
    storage: storage.storage,
    notify: (kind) => notifications.push(kind),
    onSelected: () => { navigations += 1; },
    readAuthToken: () => currentToken,
  });

  const loaded = controller.loadSpaces();
  recorder.listLoads[0].resolve([space()]);
  await loaded;

  // We rotate to a space; our own rotation persists the token.
  const selecting = controller.select(space());
  recorder.rotations[0].deferred.resolve({ token: currentToken, tenant_id: "t1", student_enrollment_id: "enr1" });
  await Promise.resolve();

  // The session is replaced with B, which installs its OWN identity, and only
  // THEN does the late profile read for A succeed.
  currentToken = "session-B";
  storage.storage.setItem(CURRENT_STUDENT_KEY, JSON.stringify(studentProfile({ business_name: "مساحة ب" })));
  storage.storage.setItem(CURRENT_STUDENT_SPACE_KEY, JSON.stringify(space({ business_name: "مساحة ب" })));
  recorder.profiles[0].resolve(studentProfile({ business_name: "مساحة أ", id: "enr1" }));

  assert.equal(await selecting, "profile-failed");
  assert.equal(
    JSON.parse(storage.store.get(CURRENT_STUDENT_KEY) as string).business_name,
    "مساحة ب",
    "B's currentStudent must never be erased by A's obsolete success",
  );
  assert.equal(
    JSON.parse(storage.store.get(CURRENT_STUDENT_SPACE_KEY) as string).business_name,
    "مساحة ب",
    "B's currentStudentSpace must never be erased by A's obsolete success",
  );
  assert.ok(!notifications.includes("scope"), "never announce a scope change we do not own");
  assert.equal(navigations, 0, "a late success under a foreign session never navigates");
  assert.equal(controller.getState().pendingIdentityLoad, false, "no stale pending action leaks into B's session");
});

test("supervisor051: a late failed profile never erases the replacement owner's identity", async () => {
  const recorder = createSpacesApi();
  const storage = createStorage();
  const notifications: string[] = [];
  let currentToken = "session-A";
  const controller = spacesController(recorder, {
    storage: storage.storage,
    notify: (kind) => notifications.push(kind),
    readAuthToken: () => currentToken,
  });

  const loaded = controller.loadSpaces();
  recorder.listLoads[0].resolve([space()]);
  await loaded;

  const selecting = controller.select(space());
  recorder.rotations[0].deferred.resolve({ token: currentToken, tenant_id: "t1", student_enrollment_id: "enr1" });
  await Promise.resolve();

  // Same replacement, but the late profile FAILS: the failure branch must also
  // test ownership before any cleanup.
  currentToken = "session-B";
  storage.storage.setItem(CURRENT_STUDENT_KEY, JSON.stringify(studentProfile({ business_name: "مساحة ب" })));
  storage.storage.setItem(CURRENT_STUDENT_SPACE_KEY, JSON.stringify(space({ business_name: "مساحة ب" })));
  recorder.profiles[0].reject(new Error("Select an instructor workspace first"));

  assert.equal(await selecting, "profile-failed");
  assert.equal(
    JSON.parse(storage.store.get(CURRENT_STUDENT_KEY) as string).business_name,
    "مساحة ب",
    "B's identity survives a late A failure too",
  );
  assert.equal(
    JSON.parse(storage.store.get(CURRENT_STUDENT_SPACE_KEY) as string).business_name,
    "مساحة ب",
  );
  assert.equal(controller.getState().pendingIdentityLoad, false);
});

test("a genuine own-rotation profile failure still discards the stale identity with the boundary injected", async () => {
  const recorder = createSpacesApi();
  const storage = createStorage({
    currentStudent: JSON.stringify(studentProfile({ business_name: "مساحة سابقة" })),
    currentStudentSpace: JSON.stringify(space({ business_name: "مساحة سابقة" })),
    authToken: "old-token",
  });
  const notifications: string[] = [];
  let navigations = 0;
  let authToken: string | null = "old-token";
  const controller = spacesController(recorder, {
    storage: storage.storage,
    notify: (kind) => notifications.push(kind),
    onSelected: () => { navigations += 1; },
    readAuthToken: () => authToken,
  });

  const loaded = controller.loadSpaces();
  recorder.listLoads[0].resolve([space()]);
  await loaded;

  // We still own the session (our own rotation persisted the token) and the
  // stored identity is still the stale baseline: legitimate own-rotation
  // cleanup must still discard it (supervisor/051 — preserve this).
  const selecting = controller.select(space());
  recorder.rotations[0].deferred.resolve({ token: "rotated-token", tenant_id: "t1", student_enrollment_id: "enr1" });
  authToken = "rotated-token";
  await Promise.resolve();
  recorder.profiles[0].reject(new Error("Select an instructor workspace first"));
  assert.equal(await selecting, "profile-failed");

  assert.equal(storage.store.has(CURRENT_STUDENT_KEY), false, "our own stale identity is still discarded");
  assert.equal(storage.store.has(CURRENT_STUDENT_SPACE_KEY), false);
  assert.deepEqual(notifications, ["identity"]);
  assert.equal(navigations, 0);
  assert.equal(controller.getState().pendingIdentityLoad, true, "the profile-only retry is still offered while we own it");
});

test("a pending identity retry that loses the session mid-flight must not erase the new owner", async () => {
  const recorder = createSpacesApi();
  const storage = createStorage();
  const notifications: string[] = [];
  let authToken: string | null = "old-token";
  const controller = spacesController(recorder, {
    storage: storage.storage,
    notify: (kind) => notifications.push(kind),
    readAuthToken: () => authToken,
  });

  const loaded = controller.loadSpaces();
  recorder.listLoads[0].resolve([space()]);
  await loaded;

  // Own-rotation profile failure while we still own the session: stale identity
  // discarded, profile-only retry offered.
  const selecting = controller.select(space());
  recorder.rotations[0].deferred.resolve({ token: "rotated-token", tenant_id: "t1", student_enrollment_id: "enr1" });
  authToken = "rotated-token";
  await Promise.resolve();
  recorder.profiles[0].reject(new Error("HTTP 503"));
  assert.equal(await selecting, "profile-failed");
  assert.equal(controller.getState().pendingIdentityLoad, true);

  // The retry passes the PRE-request ownership check (the token is still ours)
  // and fires the profile read; the session is then replaced WHILE that read
  // is in flight and the new owner installs its own identity.
  const retrying = controller.retryIdentityLoad();
  assert.equal(recorder.profiles.length, 2, "the retry reads the profile once, only for our own session");
  authToken = "someone-elses-token";
  storage.storage.setItem(CURRENT_STUDENT_KEY, JSON.stringify(studentProfile({ business_name: "مساحة ب" })));
  storage.storage.setItem(CURRENT_STUDENT_SPACE_KEY, JSON.stringify(space({ business_name: "مساحة ب" })));
  recorder.profiles[1].resolve(studentProfile({ business_name: "مساحة أ", id: "enr1" }));

  assert.equal(await retrying, "blocked", "the retry is refused after the await when the session is not ours");
  assert.equal(
    JSON.parse(storage.store.get(CURRENT_STUDENT_KEY) as string).business_name,
    "مساحة ب",
    "the replacement owner survives the obsolete retry",
  );
  assert.equal(
    JSON.parse(storage.store.get(CURRENT_STUDENT_SPACE_KEY) as string).business_name,
    "مساحة ب",
  );
  assert.ok(!notifications.includes("scope"));
});

// ---------------------------------------------------------------------------
// Journey 1 — silent session-identity replacement (supervisor/051): the cached
// identity only follows the same-document bus. A replacement that bypasses the
// bus (a raw storage write) must still forfeit a pending mutation, so the
// controller honours the injected reader at mutation completion.
// ---------------------------------------------------------------------------

test("a silent identity replacement during a join submit blocks its late commit", async () => {
  const recorder = createJoinApi();
  let identity: string | null = null; // anonymous principal
  const controller = createJoinInviteController({ ...recorder.api, readIdentity: () => identity });

  const loaded = controller.loadInvite("tokenA");
  recorder.loads[0].deferred.resolve(inviteInfo());
  await loaded;
  assert.equal(controller.getState().phase, "ready");

  const submitting = controller.submit(joinForm(), { passwordRequired: true });
  assert.equal(recorder.submits.length, 1);

  // The identity is replaced SILENTLY — no notifySessionChange, no syncIdentity
  // call — so the controller can only detect it by re-reading at completion.
  identity = "student:s1";
  recorder.submits[0].deferred.resolve({ message: "queued" });

  assert.equal(await submitting, "blocked");
  assert.equal(controller.getState().submitted, false, "a stale submit must not mark the journey submitted under the new identity");
});

test("a silent identity replacement during a password reset blocks its late commit", async () => {
  const recorder = createJoinApi();
  let identity: string | null = null;
  const controller = createJoinInviteController({ ...recorder.api, readIdentity: () => identity });

  const loaded = controller.loadInvite("tokenA");
  recorder.loads[0].deferred.resolve(inviteInfo());
  await loaded;

  const resetting = controller.requestPasswordReset("01000000000");
  assert.equal(recorder.resets.length, 1);

  identity = "student:s1"; // silent replacement (bypassed the session bus)
  recorder.resets[0].deferred.resolve({ message: "queued" });

  assert.equal(await resetting, "blocked");
  assert.equal(controller.getState().resetSent, false, "a stale reset must not mark the new identity's reset as sent");
});

// ---------------------------------------------------------------------------
// Journey 1 — session-recovery boundaries (supervisor/054): an obsolete
// operation must settle into a HONEST non-busy state (the page disables its
// controls from busyKind), a principal replaced before an operation starts
// must not misclassify the deliberate new operation, and a current-principal
// retry must be allowed with exactly one request — no reload, no bus event,
// no automatic replay.
// ---------------------------------------------------------------------------

for (const operation of ['submit', 'reset'] as const) {
  test(`supervisor054 silent replacement releases ${operation} busy state`, async () => {
    const recorder = createJoinApi();
    let identity: string | null = null;
    const controller = createJoinInviteController({ ...recorder.api, readIdentity: () => identity });
    const loading = controller.loadInvite('fixture-invite');
    recorder.loads[0].deferred.resolve(inviteInfo());
    await loading;
    const old =
      operation === 'submit'
        ? controller.submit(joinForm())
        : controller.requestPasswordReset('01000000000');
    identity = 'student:replacement';
    (operation === 'submit' ? recorder.submits[0] : recorder.resets[0]).deferred.resolve({ message: 'queued' });
    assert.equal(await old, 'blocked');
    assert.equal(
      controller.getState().busyKind,
      null,
      'obsolete request must not leave disabled controls after it settled',
    );
    const current =
      operation === 'submit'
        ? controller.submit(joinForm())
        : controller.requestPasswordReset('01000000000');
    assert.equal(
      operation === 'submit' ? recorder.submits.length : recorder.resets.length,
      2,
      'the retry under the current principal produces exactly one request',
    );
    (operation === 'submit' ? recorder.submits[1] : recorder.resets[1]).deferred.resolve({ message: 'queued' });
    assert.equal(await current, operation === 'submit' ? 'submitted' : 'sent');
  });
}

for (const operation of ['submit', 'reset'] as const) {
  test(`supervisor054 silent replacement during a ${operation} failure retires the busy state`, async () => {
    const recorder = createJoinApi();
    let identity: string | null = null;
    const controller = createJoinInviteController({ ...recorder.api, readIdentity: () => identity });

    const loading = controller.loadInvite("tokenA");
    recorder.loads[0].deferred.resolve(inviteInfo());
    await loading;

    const failing =
      operation === 'submit'
        ? controller.submit(joinForm())
        : controller.requestPasswordReset('01000000000');
    assert.equal(operation === 'submit' ? recorder.submits.length : recorder.resets.length, 1);

    // The principal is silently replaced and the old operation then FAILS:
    // the failure belongs to the replaced principal, so no stale error may
    // surface, no terminal fact may be set, and the settled operation must
    // not leave the journey busy forever.
    identity = 'student:replacement';
    (operation === 'submit' ? recorder.submits[0] : recorder.resets[0]).deferred.reject(new Error('HTTP 503'));

    assert.equal(await failing, 'blocked');
    assert.equal(
      controller.getState().actionError,
      null,
      "the current form is never blamed for the old principal's failure",
    );
    assert.equal(controller.getState().submitted, false);
    assert.equal(controller.getState().resetSent, false);
    assert.equal(
      controller.getState().busyKind,
      null,
      'a settled failure must not strand the controls disabled',
    );

    // And the journey is usable again under the CURRENT principal.
    const retried =
      operation === 'submit'
        ? controller.submit(joinForm())
        : controller.requestPasswordReset('01000000000');
    assert.equal(
      operation === 'submit' ? recorder.submits.length : recorder.resets.length,
      2,
      'exactly one new request after the settled failure',
    );
    (operation === 'submit' ? recorder.submits[1] : recorder.resets[1]).deferred.resolve({ message: 'queued' });
    assert.equal(await retried, operation === 'submit' ? 'submitted' : 'sent');
  });
}

for (const operation of ['submit', 'reset'] as const) {
  test(`supervisor054 a principal replaced BEFORE a ${operation} does not misclassify it`, async () => {
    const recorder = createJoinApi();
    let identity: string | null = null;
    const controller = createJoinInviteController({ ...recorder.api, readIdentity: () => identity });

    const loading = controller.loadInvite("tokenA");
    recorder.loads[0].deferred.resolve(inviteInfo());
    await loading;

    // The replacement happens BEFORE the operation starts (nothing in
    // flight, no bus event): the deliberate operation must capture the
    // CURRENT principal and be allowed — not treated as obsolete.
    identity = 'student:replacement';
    const started =
      operation === 'submit'
        ? controller.submit(joinForm())
        : controller.requestPasswordReset('01000000000');
    assert.equal(
      operation === 'submit' ? recorder.submits.length : recorder.resets.length,
      1,
      "the current principal's request is sent",
    );
    (operation === 'submit' ? recorder.submits[0] : recorder.resets[0]).deferred.resolve({ message: 'queued' });
    assert.equal(await started, operation === 'submit' ? 'submitted' : 'sent');
    assert.equal(controller.getState().busyKind, null);
  });
}

test("supervisor054 an obsolete completion never clears a newer operation's busy marker", async () => {
  const recorder = createJoinApi();
  const controller = createJoinInviteController(recorder.api);

  const loaded = controller.loadInvite("tokenA");
  recorder.loads[0].deferred.resolve(inviteInfo());
  await loaded;

  // Op1 starts; a route change retires it (unconditional latch release).
  const stale = controller.submit(joinForm());
  const switched = controller.loadInvite("tokenB");
  recorder.loads[1].deferred.resolve(inviteInfo());
  await switched;

  // Op2 starts on the new invitation and owns the busy marker.
  const current = controller.submit(joinForm());
  assert.equal(controller.getState().busyKind, 'submit');

  // Op1 settles late: it must not commit AND must not clear the busy marker
  // the NEWER operation owns.
  recorder.submits[0].deferred.resolve({ message: 'queued' });
  assert.equal(await stale, 'blocked');
  assert.equal(
    controller.getState().busyKind,
    'submit',
    "a retired operation never resets a newer operation's busy state",
  );

  recorder.submits[1].deferred.resolve({ message: 'queued' });
  assert.equal(await current, 'submitted');
  assert.equal(controller.getState().busyKind, null);
});
