/**
 * M2-03 existing material management — isolated production-path tests
 * (node:test + tsx).
 *
 * Scope: the REAL production seam `src/features/catalog/material-management.ts`
 * that src/pages/CourseContentManager.tsx delegates to, imported unchanged.
 * Every test drives the same controller the page creates, with injected fake
 * transports, principal reader and session notifier. Fully isolated: no DB, no
 * network, no browser, no live services, no real localStorage, no dependency
 * install.
 *
 * Behaviours pinned (M2-03 acceptance):
 *  - duplicate create/delete suppression with a synchronous latch acquired
 *    before the first await (React state cannot do that);
 *  - course A → B → A, empty selection, reversed replies, session change,
 *    logout and unmount never commit a foreign reply, and an empty selection
 *    CLEARS the previous list;
 *  - a create whose course or form incarnation changed while the request was
 *    in flight is blocked (the old conversion-before-create window);
 *  - a failed create/delete keeps the typed form / the delete target for a
 *    deliberate retry, and the retry sends exactly one more request;
 *  - a refresh that fails AFTER a server-confirmed write is reported
 *    separately and never presented as a failed write — including a malformed
 *    refresh body, which keeps the confirmed rows instead of erasing them;
 *  - a course transition retires the previous course's write latch, so a
 *    deliberate save on the new course is never answered as a "duplicate"
 *    while the retired request is still on the wire;
 *  - the player is a controller-owned preview ID resolved against the
 *    confirmed list, so a course switch, an empty selection, a logout or a
 *    refresh without the row all unmount it;
 *  - an older `finally` never clears a newer operation's busy marker;
 *  - the external-video contract is refused BEFORE any request, and a
 *    `video://` reference is sent unchanged;
 *  - duration is parsed strictly (no partial `parseInt`), grade/group
 *    associations are preserved, `is_published` stays pinned;
 *  - DELETE is a soft unpublish, never described as a hard delete;
 *  - distinct idle / loading / empty / error list states.
 *
 * Not proven here: DOM rendering, RTL paint, real HTTP, real DB, live services
 * and end-to-end authorization (the server remains authoritative).
 */
import assert from "node:assert/strict";
import test from "node:test";
import type { Course, CourseMaterial, Grade, Group } from "../lib/api-http";
import {
  buildMaterialPayload,
  classifyMaterialFailure,
  createMaterialManagementController,
  parseMaterialDuration,
  resolveMaterialFileUrl,
  resolvePreviewMaterial,
  validateMaterialForm,
  type MaterialFormValues,
  type MaterialManagementApi,
  type MaterialWritePayload,
} from "../features/catalog/material-management";
import {
  readCourseSessionPrincipal,
  resetCourseSessionLifetime,
  type CourseSessionStorage,
} from "../features/catalog/course-management";

const storageOf = (entries: Record<string, string | null>): CourseSessionStorage => ({
  getItem: (key) => (key in entries ? entries[key] : null),
});

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
}

/** Drains the queue once. Used where one operation is deliberately held open:
 *  `waitForIdle()` would wait for it too. */
const flush = (): Promise<void> => new Promise<void>((resolve) => setImmediate(resolve));

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const courseRow = (overrides: Partial<Course> = {}): Course => ({
  id: "course-a",
  name: "الرياضيات",
  subject: "الرياضيات",
  description: "وصف",
  grade: "الصف الأول",
  is_active: true,
  price: 100,
  ...overrides,
});

const gradeRow = (overrides: Partial<Grade> = {}): Grade => ({
  id: "grade-1",
  name: "الصف الأول",
  display_order: 1,
  is_active: true,
  ...overrides,
});

const groupRow = (overrides: Partial<Group> = {}): Group => ({
  id: "group-1",
  name: "مجموعة أ",
  grade_id: "grade-1",
  is_active: true,
  ...overrides,
});

const materialRow = (overrides: Partial<CourseMaterial> = {}): CourseMaterial => ({
  id: "material-1",
  course_id: "course-a",
  title: "الدرس الأول",
  material_type: "pdf",
  file_url: "https://example.test/doc.pdf",
  is_free: false,
  is_published: true,
  grade_id: "grade-1",
  group_ids: ["group-1"],
  ...overrides,
});

const form = (overrides: Partial<MaterialFormValues> = {}): MaterialFormValues => ({
  title: "الدرس الثاني",
  description: "شرح",
  material_type: "pdf",
  file_url: "https://example.test/doc.pdf",
  duration_minutes: "",
  is_free: false,
  grade_id: "grade-1",
  group_ids: ["group-1"],
  ...overrides,
});

interface Harness {
  controller: ReturnType<typeof createMaterialManagementController>;
  api: MaterialManagementApi;
  state: {
    courses: Course[];
    grades: Grade[];
    groups: Group[];
    materials: Record<string, CourseMaterial[]>;
    principal: string | null;
    materialLoads: string[];
    createCalls: MaterialWritePayload[];
    unpublishCalls: string[];
    materialGates: Array<Deferred<CourseMaterial[]>>;
    writeGates: Array<Deferred<void>>;
    /** Injects a body that is not an array (a malformed server reply). */
    malformedMaterialBody: unknown;
    failMaterialsWith: unknown;
    failNextMaterialLoadWith: unknown;
    failCreateWith: unknown;
    failDeleteWith: unknown;
    failCoursesWith: unknown;
    failOptionsWith: unknown;
    sessionListeners: Set<() => void>;
  };
  fireSessionChange: () => void;
}

function setup(overrides: { materials?: Record<string, CourseMaterial[]> } = {}): Harness {
  const state = {
    courses: [courseRow()],
    grades: [gradeRow()],
    groups: [groupRow()],
    materials: overrides.materials ?? { "course-a": [materialRow()] },
    principal: "tenant-a" as string | null,
    materialLoads: [] as string[],
    createCalls: [] as MaterialWritePayload[],
    unpublishCalls: [] as string[],
    materialGates: [] as Array<Deferred<CourseMaterial[]>>,
    writeGates: [] as Array<Deferred<void>>,
    malformedMaterialBody: null as unknown,
    failMaterialsWith: null as unknown,
    failNextMaterialLoadWith: null as unknown,
    failCreateWith: null as unknown,
    failDeleteWith: null as unknown,
    failCoursesWith: null as unknown,
    failOptionsWith: null as unknown,
    sessionListeners: new Set<() => void>(),
  };

  const takeMaterialGate = async (courseId: string): Promise<CourseMaterial[]> => {
    const gate = state.materialGates.shift();
    if (gate) return gate.promise;
    if (state.failNextMaterialLoadWith) {
      const failure = state.failNextMaterialLoadWith;
      state.failNextMaterialLoadWith = null;
      throw failure;
    }
    if (state.failMaterialsWith) throw state.failMaterialsWith;
    if (state.malformedMaterialBody) {
      return state.malformedMaterialBody as CourseMaterial[];
    }
    return state.materials[courseId] ?? [];
  };
  const takeWriteGate = async (): Promise<void> => {
    const gate = state.writeGates.shift();
    if (gate) await gate.promise;
  };

  const api: MaterialManagementApi = {
    loadCourses: async () => {
      if (state.failCoursesWith) throw state.failCoursesWith;
      return state.courses;
    },
    loadGrades: async () => {
      if (state.failOptionsWith) throw state.failOptionsWith;
      return state.grades;
    },
    loadGroups: async () => {
      if (state.failOptionsWith) throw state.failOptionsWith;
      return state.groups;
    },
    loadMaterials: async (courseId) => {
      state.materialLoads.push(courseId);
      return takeMaterialGate(courseId);
    },
    createMaterial: async (payload) => {
      state.createCalls.push(payload);
      await takeWriteGate();
      if (state.failCreateWith) throw state.failCreateWith;
      return materialRow({ id: "created-id", ...payload });
    },
    unpublishMaterial: async (id) => {
      state.unpublishCalls.push(id);
      await takeWriteGate();
      if (state.failDeleteWith) throw state.failDeleteWith;
    },
    readPrincipal: () => state.principal,
    subscribeSession: (listener) => {
      state.sessionListeners.add(listener);
      return () => state.sessionListeners.delete(listener);
    },
  };

  const controller = createMaterialManagementController(api);
  return {
    controller,
    api,
    state,
    fireSessionChange: () => {
      for (const listener of [...state.sessionListeners]) listener();
    },
  };
}

// ---------------------------------------------------------------------------
// Contract helpers (pure)
// ---------------------------------------------------------------------------

test("duration: blank stays blank, whole minutes parse, partial reads are refused", () => {
  assert.deepEqual(parseMaterialDuration(""), { ok: true, value: undefined });
  assert.deepEqual(parseMaterialDuration("   "), { ok: true, value: undefined });
  assert.deepEqual(parseMaterialDuration("30"), { ok: true, value: 30 });
  // parseInt('30abc') === 30 is exactly the partial read that is refused here.
  assert.equal(parseMaterialDuration("30abc").ok, false);
  assert.equal(parseMaterialDuration("3.5").ok, false);
  assert.equal(parseMaterialDuration("-5").ok, false);
  assert.equal(parseMaterialDuration("0").ok, false);
  assert.equal(parseMaterialDuration("Infinity").ok, false);
  assert.equal(parseMaterialDuration(Number.NaN).ok, false);
  assert.equal(parseMaterialDuration(Number.POSITIVE_INFINITY).ok, false);
});

test("external video link is refused by the contract, video:// passes unchanged", () => {
  const external = resolveMaterialFileUrl("video", "https://drive.google.com/file/d/abc/view");
  assert.equal(external.ok, false);
  if (external.ok === false) assert.equal(external.reason, "external-video");

  const internal = resolveMaterialFileUrl("video", "  video://tenant/video-1  ");
  assert.equal(internal.ok, true);
  if (internal.ok) assert.equal(internal.url, "video://tenant/video-1");

  // A non-video document link is accepted as typed: the server has no scheme
  // restriction for pdf/presentation rows.
  const doc = resolveMaterialFileUrl("pdf", "https://drive.google.com/file/d/abc/view");
  assert.equal(doc.ok, true);

  const missing = resolveMaterialFileUrl("pdf", "   ");
  assert.equal(missing.ok, false);
  if (missing.ok === false) assert.equal(missing.reason, "missing");
});

test("validation refuses an external video and reports it as a contract refusal", () => {
  const result = validateMaterialForm(form({ material_type: "video", file_url: "https://drive.google.com/x" }));
  assert.equal(result.ok, false);
  assert.equal(result.externalVideoRejected, true);
  assert.ok(result.fieldErrors.file_url);

  const badDuration = validateMaterialForm(form({ duration_minutes: "12abc" }));
  assert.equal(badDuration.ok, false);
  assert.equal(badDuration.externalVideoRejected, false);
  assert.ok(badDuration.fieldErrors.duration_minutes);

  const missingGroups = validateMaterialForm(form({ group_ids: [] }));
  assert.equal(missingGroups.ok, false);
  assert.ok(missingGroups.fieldErrors.group_ids);
});

test("payload pins is_published, keeps grade/group associations and appends the order", () => {
  const payload = buildMaterialPayload(form({ duration_minutes: "45" }), "course-a", 3);
  assert.equal(payload.course_id, "course-a");
  assert.equal(payload.is_published, true);
  assert.equal(payload.display_order, 3);
  assert.equal(payload.grade_id, "grade-1");
  assert.deepEqual(payload.group_ids, ["group-1"]);
  assert.equal(payload.duration_minutes, 45);
  // A blank duration is omitted entirely — no invented default.
  assert.equal(buildMaterialPayload(form(), "course-a", 0).duration_minutes, undefined);
});

test("failure classification uses the server's documented messages only", () => {
  assert.equal(classifyMaterialFailure(new Error("Material not found")).kind, "unavailable");
  assert.equal(classifyMaterialFailure(new Error("Workspace access required")).kind, "denied");
  assert.equal(
    classifyMaterialFailure(new Error("Course is outside your teaching scope")).kind,
    "denied"
  );
  assert.equal(
    classifyMaterialFailure(new Error("External video links are not allowed. Upload the video to the platform.")).kind,
    "contract"
  );
  assert.equal(classifyMaterialFailure(new Error("Failed to create material")).kind, "error");
});

// ---------------------------------------------------------------------------
// Course / list lifetimes
// ---------------------------------------------------------------------------

test("selecting a course loads its published materials and reaches a ready phase", async () => {
  const h = setup();
  await h.controller.selectCourse("course-a");
  const state = h.controller.getState();
  assert.equal(state.selectedCourse, "course-a");
  assert.equal(state.phase, "ready");
  assert.equal(state.materials.length, 1);
  assert.deepEqual(h.state.materialLoads, ["course-a"]);
  h.controller.dispose();
});

test("an empty selection CLEARS the previous course's list", async () => {
  const h = setup();
  await h.controller.selectCourse("course-a");
  assert.equal(h.controller.getState().materials.length, 1);
  await h.controller.selectCourse("");
  const state = h.controller.getState();
  assert.equal(state.selectedCourse, "");
  assert.equal(state.phase, "idle");
  assert.deepEqual(state.materials, [], "the previous list must not stay on screen");
  h.controller.dispose();
});

test("course A -> B -> A never resurrects the first A's late rows", async () => {
  const h = setup({ materials: { "course-a": [materialRow({ id: "a1" })], "course-b": [materialRow({ id: "b1" })] } });
  const gateA1 = deferred<CourseMaterial[]>();
  h.state.materialGates.push(gateA1);
  const firstA = h.controller.selectCourse("course-a");
  await flush();

  const second = h.controller.selectCourse("course-b");
  await second;
  assert.equal(h.controller.getState().materials[0]?.id, "b1");

  // Back to A: this load resolves immediately with the current A rows.
  await h.controller.selectCourse("course-a");
  assert.equal(h.controller.getState().materials[0]?.id, "a1");

  // The FIRST A reply arrives last; it belongs to a retired selection.
  gateA1.resolve([materialRow({ id: "stale-a" })]);
  await firstA;
  assert.equal(h.controller.getState().materials[0]?.id, "a1", "a reversed reply must not commit");
  h.controller.dispose();
});

test("a late reply for a superseded course cannot overwrite the newer list", async () => {
  const h = setup({ materials: { "course-a": [materialRow({ id: "a1" })], "course-b": [materialRow({ id: "b1" })] } });
  const gateA = deferred<CourseMaterial[]>();
  h.state.materialGates.push(gateA);
  const loadA = h.controller.selectCourse("course-a");
  await flush();
  await h.controller.selectCourse("course-b");
  gateA.resolve([materialRow({ id: "late-a" })]);
  await loadA;
  const state = h.controller.getState();
  assert.equal(state.selectedCourse, "course-b");
  assert.equal(state.materials[0]?.id, "b1");
  h.controller.dispose();
});

test("list states stay distinct: idle, loading, empty, error", async () => {
  const h = setup({ materials: { "course-a": [] } });
  assert.equal(h.controller.getState().phase, "idle");

  const gate = deferred<CourseMaterial[]>();
  h.state.materialGates.push(gate);
  const pending = h.controller.selectCourse("course-a");
  await flush();
  assert.equal(h.controller.getState().phase, "loading");
  gate.resolve([]);
  await pending;
  assert.equal(h.controller.getState().phase, "empty");

  h.state.failMaterialsWith = new Error("Failed to fetch materials");
  await h.controller.refresh();
  const failed = h.controller.getState();
  assert.equal(failed.phase, "error");
  assert.equal(failed.listError, "Failed to fetch materials");
  assert.deepEqual(failed.materials, []);
  h.controller.dispose();
});

test("a malformed list body is an error, never an empty list", async () => {
  const h = setup();
  h.state.malformedMaterialBody = { message: "not an array" };
  await h.controller.selectCourse("course-a");
  const state = h.controller.getState();
  assert.equal(state.phase, "error");
  assert.ok(state.listError);
  h.controller.dispose();
});

// ---------------------------------------------------------------------------
// Create lifecycle
// ---------------------------------------------------------------------------

test("a duplicate create fired before the re-render reaches the transport once", async () => {
  const h = setup();
  await h.controller.selectCourse("course-a");
  const gate = deferred<void>();
  h.state.writeGates.push(gate);

  const first = h.controller.submit(form());
  const second = await h.controller.submit(form());
  assert.equal(second, "duplicate");
  assert.equal(h.state.createCalls.length, 1, "the second click must not send a request");

  gate.resolve();
  assert.equal(await first, "created");
  assert.equal(h.state.createCalls.length, 1);
  h.controller.dispose();
});

test("a failed create keeps the form and a deliberate retry sends exactly one more request", async () => {
  const h = setup();
  await h.controller.selectCourse("course-a");
  h.state.failCreateWith = new Error("Failed to create material");

  assert.equal(await h.controller.submit(form()), "failed");
  assert.equal(h.controller.getState().createError, "Failed to create material");
  assert.equal(h.state.createCalls.length, 1);

  h.state.failCreateWith = null;
  assert.equal(await h.controller.submit(form()), "created");
  assert.equal(h.state.createCalls.length, 2);
  h.controller.dispose();
});

test("a create whose form incarnation was replaced can no longer commit", async () => {
  const h = setup();
  await h.controller.selectCourse("course-a");
  const instance = h.controller.openForm();
  const gate = deferred<void>();
  h.state.writeGates.push(gate);

  const pending = h.controller.submit(form(), instance);
  // The instructor closes/reopens the form while the request is in flight.
  h.controller.closeForm();
  const newer = h.controller.openForm();
  assert.notEqual(newer, instance);
  gate.resolve();

  assert.equal(await pending, "blocked");
  assert.equal(h.controller.getState().createdId, null);
  assert.equal(h.controller.getState().createError, null, "a blocked commit writes no error on the newer form");
  h.controller.dispose();
});

test("a create whose course changed mid-flight is blocked instead of mixing targets", async () => {
  const h = setup({ materials: { "course-a": [materialRow()], "course-b": [] } });
  await h.controller.selectCourse("course-a");
  const gate = deferred<void>();
  h.state.writeGates.push(gate);

  const pending = h.controller.submit(form({ title: "للدورة أ" }));
  await flush();
  await h.controller.selectCourse("course-b");
  gate.resolve();

  assert.equal(await pending, "blocked");
  assert.equal(h.state.createCalls.length, 1);
  assert.equal(h.state.createCalls[0].course_id, "course-a", "the request carried the original target");
  assert.equal(h.controller.getState().createdId, null);
  h.controller.dispose();
});

test("success followed by a failed refresh is reported separately, not as a failed write", async () => {
  const h = setup();
  await h.controller.selectCourse("course-a");
  h.state.failNextMaterialLoadWith = new Error("Failed to fetch materials");

  assert.equal(await h.controller.submit(form()), "created");
  await h.controller.waitForIdle();
  const state = h.controller.getState();
  assert.equal(state.createdId, "created-id");
  assert.equal(state.createError, null, "the confirmed write is not a failure");
  assert.equal(state.refreshError, "Failed to fetch materials");
  h.controller.dispose();
});

test("an older finally never clears a newer operation's busy marker", async () => {
  const h = setup();
  await h.controller.selectCourse("course-a");
  const firstGate = deferred<void>();
  h.state.writeGates.push(firstGate);
  const first = h.controller.submit(form());
  await flush();
  assert.equal(h.controller.getState().busyKind, "create");

  // The session changes: everything in flight is retired and the latch freed.
  h.fireSessionChange();
  await h.controller.selectCourse("course-a");

  const secondGate = deferred<void>();
  h.state.writeGates.push(secondGate);
  const second = h.controller.submit(form());
  await flush();
  assert.equal(h.controller.getState().busyKind, "create");

  // The retired operation completes last.
  firstGate.resolve();
  assert.equal(await first, "blocked");
  assert.equal(h.controller.getState().busyKind, "create", "the newer operation still owns the busy marker");

  secondGate.resolve();
  assert.equal(await second, "created");
  // The confirmed write starts its own refresh; only that refresh may hold the
  // marker now, and it clears it when it settles.
  assert.notEqual(h.controller.getState().busyKind, "delete");
  await h.controller.waitForIdle();
  assert.equal(h.controller.getState().busyKind, null);
  h.controller.dispose();
});

// ---------------------------------------------------------------------------
// Delete lifecycle (soft unpublish)
// ---------------------------------------------------------------------------

test("duplicate delete is suppressed and the write is a soft unpublish", async () => {
  const h = setup();
  await h.controller.selectCourse("course-a");
  const target = h.controller.getState().materials[0];
  const gate = deferred<void>();
  h.state.writeGates.push(gate);

  h.controller.requestDelete(target);
  const first = h.controller.confirmDelete();
  const second = await h.controller.confirmDelete();
  assert.equal(second, "duplicate");
  assert.equal(h.state.unpublishCalls.length, 1);

  gate.resolve();
  assert.equal(await first, "unpublished");
  assert.deepEqual(h.state.unpublishCalls, ["material-1"]);
  assert.equal(h.controller.getState().deleteTarget, null);
  h.controller.dispose();
});

test("a failed delete keeps its target so the instructor can retry deliberately", async () => {
  const h = setup();
  await h.controller.selectCourse("course-a");
  const target = h.controller.getState().materials[0];
  h.state.failDeleteWith = new Error("Failed to delete material");

  h.controller.requestDelete(target);
  assert.equal(await h.controller.confirmDelete(), "failed");
  const failed = h.controller.getState();
  assert.equal(failed.deleteError, "Failed to delete material");
  assert.equal(failed.deleteTarget?.id, "material-1", "the target survives the failure");

  h.state.failDeleteWith = null;
  assert.equal(await h.controller.confirmDelete(), "unpublished");
  assert.equal(h.state.unpublishCalls.length, 2);
  h.controller.dispose();
});

test("a delete whose dialog was cancelled cannot clear or error a newer target", async () => {
  const h = setup({ materials: { "course-a": [materialRow({ id: "m1" }), materialRow({ id: "m2" })] } });
  await h.controller.selectCourse("course-a");
  const [first, second] = h.controller.getState().materials;
  const gate = deferred<void>();
  h.state.writeGates.push(gate);

  h.controller.requestDelete(first);
  const pending = h.controller.confirmDelete();
  await flush();
  h.controller.cancelDelete();
  h.controller.requestDelete(second);
  gate.resolve();

  assert.equal(await pending, "blocked");
  const state = h.controller.getState();
  assert.equal(state.deleteTarget?.id, "m2", "the newer dialog is untouched");
  assert.equal(state.deleteError, null);
  h.controller.dispose();
});

// ---------------------------------------------------------------------------
// External-video contract
// ---------------------------------------------------------------------------

test("an external video link is refused before any request is made", async () => {
  const h = setup();
  await h.controller.selectCourse("course-a");
  const outcome = await h.controller.submit(
    form({ material_type: "video", file_url: "https://drive.google.com/file/d/abc/view" })
  );
  assert.equal(outcome, "rejected");
  assert.equal(h.state.createCalls.length, 0, "no request may leave the page");
  const state = h.controller.getState();
  assert.ok(state.fieldErrors.file_url);
  assert.equal(state.createError, null);
  h.controller.dispose();
});

test("a video:// reference is sent unchanged", async () => {
  const h = setup();
  await h.controller.selectCourse("course-a");
  assert.equal(
    await h.controller.submit(form({ material_type: "video", file_url: "video://tenant/v-9", duration_minutes: "12" })),
    "created"
  );
  const payload = h.state.createCalls[0];
  assert.equal(payload.material_type, "video");
  assert.equal(payload.file_url, "video://tenant/v-9");
  assert.equal(payload.duration_minutes, 12);
  h.controller.dispose();
});

// ---------------------------------------------------------------------------
// Session / dispose
// ---------------------------------------------------------------------------

test("a session change clears the previous principal's data and retires in-flight replies", async () => {
  const h = setup();
  await h.controller.selectCourse("course-a");
  const gate = deferred<CourseMaterial[]>();
  h.state.materialGates.push(gate);
  const pending = h.controller.refresh();
  await flush();

  h.fireSessionChange();
  gate.resolve([materialRow({ id: "foreign" })]);
  await pending;
  await h.controller.waitForIdle();

  const state = h.controller.getState();
  assert.deepEqual(state.materials, []);
  assert.equal(state.selectedCourse, "");
  assert.equal(state.phase, "idle");
  h.controller.dispose();
});

test("dispose blocks commits and retires the latch", async () => {
  const h = setup();
  await h.controller.selectCourse("course-a");
  h.controller.dispose();
  assert.equal(await h.controller.submit(form()), "blocked");
  assert.equal(h.state.createCalls.length, 0);
});

test("observed lifetime: A -> logout -> A blocks the first A's pending create", async () => {
  resetCourseSessionLifetime();
  let token: string | null = "token-A";
  const storage: CourseSessionStorage = {
    getItem: (key) =>
      key === "authToken" ? token : key === "currentUser" ? JSON.stringify({ id: "u1", role: "instructor" }) : null,
  };
  const h = setup();
  h.api.readPrincipal = () => readCourseSessionPrincipal(storage);
  await h.controller.selectCourse("course-a");

  const gate = deferred<void>();
  h.state.writeGates.push(gate);
  const pending = h.controller.submit(form());

  // Logout is observed by a real production read, then the same account logs
  // back in with the same token bytes.
  token = null;
  await h.controller.loadOptions();
  token = "token-A";
  gate.resolve();

  assert.equal(await pending, "blocked", "returning to A after an observed logout is a new lifetime");
  assert.equal(h.controller.getState().createdId, null);
  h.controller.dispose();
});

test("observed lifetime: an unchanged session still commits (positive control)", async () => {
  resetCourseSessionLifetime();
  const storage = storageOf({
    authToken: "token-A",
    currentUser: JSON.stringify({ id: "u1", role: "instructor" }),
  });
  const h = setup();
  h.api.readPrincipal = () => readCourseSessionPrincipal(storage);
  await h.controller.selectCourse("course-a");

  const gate = deferred<void>();
  h.state.writeGates.push(gate);
  const pending = h.controller.submit(form());
  gate.resolve();

  assert.equal(await pending, "created");
  assert.equal(h.controller.getState().createdId, "created-id");
  h.controller.dispose();
});

test("the real reader is the one the page injects: a token rotation invalidates an in-flight create", async () => {
  resetCourseSessionLifetime();
  let token = "token-A";
  const storage: CourseSessionStorage = {
    getItem: (key) =>
      key === "authToken" ? token : key === "currentUser" ? JSON.stringify({ id: "u1", role: "instructor" }) : null,
  };
  const h = setup();
  h.api.readPrincipal = () => readCourseSessionPrincipal(storage);
  await h.controller.selectCourse("course-a");

  const gate = deferred<void>();
  h.state.writeGates.push(gate);
  const pending = h.controller.submit(form());
  token = "token-B";
  gate.resolve();

  assert.equal(await pending, "blocked");
  h.controller.dispose();
});

// ---------------------------------------------------------------------------
// Independent option reads
// ---------------------------------------------------------------------------

test("a failed options read does not blank the materials list", async () => {
  const h = setup();
  await h.controller.selectCourse("course-a");
  h.state.failOptionsWith = new Error("Failed to fetch groups");
  await h.controller.loadOptions();
  const state = h.controller.getState();
  assert.equal(state.materials.length, 1, "the list is independent of the options read");
  assert.equal(state.optionsError, "Failed to fetch groups");
  h.controller.dispose();
});

test("a failed courses read is reported separately and does not wipe the list", async () => {
  const h = setup();
  await h.controller.selectCourse("course-a");
  h.state.failCoursesWith = new Error("Failed to fetch courses");
  await h.controller.loadCourses();
  const state = h.controller.getState();
  assert.equal(state.coursesError, "Failed to fetch courses");
  assert.equal(state.materials.length, 1);
  h.controller.dispose();
});

test("form incarnations are distinct and the current one is reported honestly", async () => {
  const h = setup();
  await h.controller.selectCourse("course-a");
  const first = h.controller.openForm();
  assert.equal(h.controller.isFormCurrent(first), true);
  h.controller.closeForm();
  assert.equal(h.controller.isFormCurrent(first), false);
  const second = h.controller.openForm();
  assert.equal(h.controller.isFormCurrent(second), true);
  assert.notEqual(first, second);
  h.controller.dispose();
});

// ---------------------------------------------------------------------------
// supervisor/070 — course transition, malformed refresh, preview lifetime
// ---------------------------------------------------------------------------

const videoRow = (id: string, overrides: Partial<CourseMaterial> = {}): CourseMaterial =>
  materialRow({ id, material_type: "video", file_url: `video://tenant/${id}`, ...overrides });

test("supervisor070: a retired course write must not lock the next course", async () => {
  const h = setup();
  await h.controller.selectCourse("course-a");
  const gate = deferred<void>();
  h.state.writeGates.push(gate);

  const stale = h.controller.submit(form(), h.controller.openForm());
  await flush();
  await h.controller.selectCourse("course-b");

  // The instructor deliberately saves on the NEW course while the retired A
  // request is still on the wire: it must not be answered as a duplicate.
  const current = await h.controller.submit(form(), h.controller.openForm());
  gate.resolve();
  assert.equal(await stale, "blocked");

  assert.equal(current, "created", "a retired course A request must not block a deliberate course B action");
  assert.equal(h.state.createCalls.length, 2);
  assert.equal(h.state.createCalls[0].course_id, "course-a", "the retired request kept its own target");
  assert.equal(h.state.createCalls[1].course_id, "course-b");
  h.controller.dispose();
});

test("supervisor070: the retired write's finally never frees the newer course's latch or busy state", async () => {
  const h = setup();
  await h.controller.selectCourse("course-a");
  const staleGate = deferred<void>();
  h.state.writeGates.push(staleGate);
  const stale = h.controller.submit(form());
  await flush();

  await h.controller.selectCourse("course-b");
  const currentGate = deferred<void>();
  h.state.writeGates.push(currentGate);
  const current = h.controller.submit(form());
  await flush();
  assert.equal(h.controller.getState().busyKind, "create");

  // The retired A request settles LAST: it must not free B's latch (otherwise
  // a second B click would send a duplicate) nor clear B's busy marker.
  staleGate.resolve();
  assert.equal(await stale, "blocked");
  assert.equal(h.controller.getState().busyKind, "create", "the newer course still owns the busy marker");

  currentGate.resolve();
  assert.equal(await current, "created");
  await h.controller.waitForIdle();
  assert.equal(h.controller.getState().busyKind, null);
  assert.equal(h.state.createCalls.length, 2);
  h.controller.dispose();
});

test("supervisor070: a malformed refresh keeps the confirmed rows and reports a separate error", async () => {
  const h = setup();
  await h.controller.selectCourse("course-a");
  const previous = h.controller.getState().materials;
  assert.equal(previous.length, 1);

  h.state.malformedMaterialBody = { invalid: true };
  assert.equal(await h.controller.submit(form()), "created");
  await h.controller.waitForIdle();

  const state = h.controller.getState();
  assert.deepEqual(state.materials, previous, "a failed refresh must not erase confirmed rows");
  assert.equal(state.phase, "ready");
  assert.ok(state.refreshError, "the refresh failure is reported on its own channel");
  assert.equal(state.createError, null, "the server-confirmed write is still not a failure");
  assert.equal(state.createdId, "created-id");
  assert.equal(h.state.createCalls.length, 1, "a malformed refresh must not invite a blind re-creation");
  h.controller.dispose();
});

test("supervisor070: the refresh retry after a malformed body re-reads the list without re-creating", async () => {
  const h = setup({ materials: { "course-a": [materialRow({ id: "a1" })] } });
  await h.controller.selectCourse("course-a");
  h.state.malformedMaterialBody = { invalid: true };
  await h.controller.submit(form());
  await h.controller.waitForIdle();
  assert.ok(h.controller.getState().refreshError);

  // The server answers correctly on the retry: the confirmed rows are replaced
  // by the fresh ones and the separate error is cleared.
  h.state.malformedMaterialBody = null;
  h.state.materials["course-a"] = [materialRow({ id: "a1" }), materialRow({ id: "created-id" })];
  await h.controller.refresh();

  const state = h.controller.getState();
  assert.equal(state.refreshError, null);
  assert.equal(state.phase, "ready");
  assert.equal(state.materials.length, 2);
  assert.equal(h.state.createCalls.length, 1, "the retry is a read, never a second create");
  h.controller.dispose();
});

// ---------------------------------------------------------------------------
// Retry intent (supervisor/072): the page's Retry button must not turn a read
// retry into the destructive initial-load branch while confirmed rows exist.
// ---------------------------------------------------------------------------

test("supervisor072: Retry after a malformed refresh keeps the confirmed rows", async () => {
  const h = setup();
  await h.controller.selectCourse("course-a");
  const confirmed = h.controller.getState().materials;
  assert.equal(confirmed.length, 1);

  h.state.malformedMaterialBody = { invalid: true };
  assert.equal(await h.controller.submit(form(), h.controller.openForm()), "created");
  await h.controller.waitForIdle();
  assert.deepEqual(h.controller.getState().materials, confirmed);

  // The page's Retry button calls exactly this method; the server answers
  // malformed again instead of recovering.
  await h.controller.refresh();
  const state = h.controller.getState();
  assert.deepEqual(
    state.materials,
    confirmed,
    "a read retry is still a refresh, not a destructive initial load"
  );
  assert.equal(state.phase, "ready");
  assert.ok(state.refreshError, "the repeated failure is reported on its own channel");
  assert.equal(state.listError, null, "a confirmed list never becomes a list error");
  assert.equal(state.createError, null, "the confirmed write is still not a failure");
  assert.equal(state.createdId, "created-id");
  assert.equal(h.state.createCalls.length, 1, "the retry is a read, never a second create");
  h.controller.dispose();
});

test("supervisor072: repeated rejected retries keep the rows, then a good read recovers", async () => {
  const h = setup();
  await h.controller.selectCourse("course-a");
  const confirmed = h.controller.getState().materials;

  h.state.failMaterialsWith = new Error("Failed to fetch materials");
  await h.controller.refresh();
  let state = h.controller.getState();
  assert.deepEqual(state.materials, confirmed, "a rejected read never erases confirmed rows");
  assert.equal(state.phase, "ready");
  assert.equal(state.refreshError, "Failed to fetch materials");
  assert.equal(state.createError, null);
  assert.equal(h.state.createCalls.length, 0);

  // The same rejection again: same honest, non-destructive result.
  await h.controller.refresh();
  state = h.controller.getState();
  assert.deepEqual(state.materials, confirmed);
  assert.equal(state.refreshError, "Failed to fetch materials");

  // The server recovers: the retry replaces the rows and clears the error.
  h.state.failMaterialsWith = null;
  h.state.materials["course-a"] = [materialRow({ id: "a1" }), materialRow({ id: "a2" })];
  await h.controller.refresh();
  state = h.controller.getState();
  assert.equal(state.refreshError, null);
  assert.equal(state.phase, "ready");
  assert.equal(state.materials.length, 2);
  assert.equal(h.state.createCalls.length, 0);
  h.controller.dispose();
});

test("supervisor072: an empty confirmed list retries as an honest initial load", async () => {
  const h = setup({ materials: { "course-a": [] } });
  await h.controller.selectCourse("course-a");
  assert.equal(h.controller.getState().phase, "empty");

  // Nothing was confirmed, so there is nothing to preserve: the retry keeps
  // the documented initial-load outcome instead of faking an empty success.
  h.state.malformedMaterialBody = { invalid: true };
  await h.controller.refresh();
  let state = h.controller.getState();
  assert.equal(state.phase, "error");
  assert.ok(state.listError);
  assert.deepEqual(state.materials, []);

  h.state.malformedMaterialBody = null;
  await h.controller.refresh();
  state = h.controller.getState();
  assert.equal(state.phase, "empty");
  assert.equal(state.listError, null);
  assert.equal(state.refreshError, null);
  h.controller.dispose();
});

test("preview: only a playable row of the current confirmed list opens the player", async () => {
  const h = setup({
    materials: { "course-a": [videoRow("video-1"), materialRow({ id: "pdf-1" })] },
  });
  await h.controller.selectCourse("course-a");

  h.controller.requestPreview("pdf-1");
  assert.equal(h.controller.getState().previewMaterialId, null, "a non-video row never opens the player");

  h.controller.requestPreview("unknown-id");
  assert.equal(h.controller.getState().previewMaterialId, null, "an unknown id never opens the player");

  h.controller.requestPreview("video-1");
  const resolved = resolvePreviewMaterial(
    h.controller.getState().materials,
    h.controller.getState().previewMaterialId
  );
  assert.equal(resolved?.id, "video-1");
  assert.equal(resolved?.file_url, "video://tenant/video-1");

  h.controller.closePreview();
  assert.equal(h.controller.getState().previewMaterialId, null);
  h.controller.dispose();
});

test("preview: a course switch, an empty selection and A -> B -> A never keep the old player", async () => {
  const h = setup({
    materials: { "course-a": [videoRow("video-a")], "course-b": [videoRow("video-b")] },
  });
  await h.controller.selectCourse("course-a");
  h.controller.requestPreview("video-a");
  assert.equal(h.controller.getState().previewMaterialId, "video-a");

  await h.controller.selectCourse("course-b");
  assert.equal(h.controller.getState().previewMaterialId, null, "the old scope's preview is retired");
  assert.equal(
    resolvePreviewMaterial(h.controller.getState().materials, "video-a"),
    null,
    "a retired id cannot resolve against the new scope's rows"
  );

  await h.controller.selectCourse("course-a");
  assert.equal(
    h.controller.getState().previewMaterialId,
    null,
    "returning to A must not resurrect the player the transition closed"
  );

  h.controller.requestPreview("video-a");
  await h.controller.selectCourse("");
  assert.equal(h.controller.getState().previewMaterialId, null);
  assert.equal(
    resolvePreviewMaterial(h.controller.getState().materials, h.controller.getState().previewMaterialId),
    null
  );
  h.controller.dispose();
});

test("preview: a session change (logout) clears the player with the rest of the scope", async () => {
  const h = setup({ materials: { "course-a": [videoRow("video-1")] } });
  await h.controller.selectCourse("course-a");
  h.controller.requestPreview("video-1");
  assert.equal(h.controller.getState().previewMaterialId, "video-1");

  h.fireSessionChange();
  await h.controller.waitForIdle();

  const state = h.controller.getState();
  assert.equal(state.previewMaterialId, null);
  assert.deepEqual(state.materials, []);
  assert.equal(resolvePreviewMaterial(state.materials, "video-1"), null);
  h.controller.dispose();
});

test("preview: a refresh that no longer returns the row closes the player, a failed refresh keeps it", async () => {
  const h = setup({ materials: { "course-a": [videoRow("video-1")] } });
  await h.controller.selectCourse("course-a");
  h.controller.requestPreview("video-1");

  // A write's follow-up refresh fails: the confirmed rows stay on screen, so
  // the player may legitimately stay — it still points at the server's last
  // confirmed row of THIS scope.
  h.state.failNextMaterialLoadWith = new Error("Failed to fetch materials");
  assert.equal(await h.controller.submit(form()), "created");
  await h.controller.waitForIdle();
  assert.equal(h.controller.getState().previewMaterialId, "video-1");
  assert.ok(h.controller.getState().refreshError);

  // The server no longer returns the row (unpublished/removed): the player and
  // its id must go with it.
  h.state.materials["course-a"] = [];
  await h.controller.refresh();
  const state = h.controller.getState();
  assert.equal(state.previewMaterialId, null);
  assert.deepEqual(state.materials, []);
  assert.equal(state.phase, "empty");
  h.controller.dispose();
});

test("preview: dispose retires the player and no later request can reopen it", async () => {
  const h = setup({ materials: { "course-a": [videoRow("video-1")] } });
  await h.controller.selectCourse("course-a");
  h.controller.requestPreview("video-1");
  h.controller.dispose();
  assert.equal(h.controller.getState().previewMaterialId, null);
  h.controller.requestPreview("video-1");
  assert.equal(h.controller.getState().previewMaterialId, null);
});
