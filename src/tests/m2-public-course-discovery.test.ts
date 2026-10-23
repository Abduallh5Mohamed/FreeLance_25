/**
 * M2-22 — anonymous published-course discovery: isolated production-path tests
 * (node:test + tsx).
 *
 * Scope: the REAL production seam
 * `src/features/catalog/public-course-discovery.ts` that
 * `src/pages/PublicCourseDiscovery.tsx` mounts, imported unchanged. Every test
 * drives the same controller the page creates, with an injected fake transport,
 * a manual timer (so the debounce is deterministic) and an injected principal
 * reader. Fully isolated: no DB, no network, no browser, no live service, no
 * real `localStorage`, no dependency install.
 *
 * Behaviours pinned:
 *  - the bounded first page: exactly ONE request, `limit` = the page constant,
 *    no cursor, no search term when nothing was typed;
 *  - a page whose rows cannot be validated is a FAILED read — never a partially
 *    adopted page, never an empty catalogue;
 *  - the server cursor is the only thing that can ask for a next page, it
 *    appends to the page it was issued for, and a double click never fetches the
 *    same page twice;
 *  - a failed next page never discards the page already on screen;
 *  - the search is debounced and bounded: keystrokes coalesce into ONE read, a
 *    term that exceeds the server ceiling is refused locally, and a blank term
 *    is sent as no filter at all;
 *  - a debounced read that fires after a newer keystroke is DROPPED instead of
 *    committing a page for an obsolete term;
 *  - an explicit search for the already-applied term sends NOTHING;
 *  - the detail read is exact: an envelope for another course, a malformed
 *    envelope and a missing `course` key are all failures, and unpublished,
 *    foreign and absent are ONE `unavailable` answer;
 *  - closing the detail retires the read, so a late reply cannot reopen it;
 *  - a session change retires in-flight operations without discarding the
 *    public page (the catalogue is not principal-scoped);
 *  - dispose commits nothing and cancels the pending debounce.
 *
 * Not proven here: DOM rendering, RTL paint, real HTTP, real DB, live services
 * and end-to-end authorization (the server remains authoritative).
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  PUBLIC_COURSE_PAGE_LIMIT,
  PUBLIC_COURSE_PAGE_MAX,
  PUBLIC_COURSE_SEARCH_MAX,
  PUBLIC_COURSE_SEARCH_TOO_LONG_MESSAGE,
  PUBLIC_COURSE_SEARCH_DEBOUNCE_MS,
  PUBLIC_COURSE_UNAVAILABLE_MESSAGE,
  classifyPublicCourseDetailFailure,
  classifyPublicDiscoveryFailure,
  createPublicCourseDiscoveryController,
  normalisePublicSearchTerm,
  readPublicCourse,
  type PublicCourse,
  type PublicCourseDiscoveryApi,
  type PublicDiscoveryTimer,
} from "../features/catalog/public-course-discovery";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const COURSE_A: PublicCourse = {
  course_id: "11111111-1111-4111-8111-111111111111",
  name: "التاريخ الإسلامي",
  subject: "التاريخ",
  description: "وصف الكورس",
  grade: "الصف الأول الثانوي",
  tenant_id: "22222222-2222-4222-8222-222222222222",
  business_name: "أكاديمية النور",
  display_name_ar: "أكاديمية النور",
  display_name_en: null,
  accent_color: "#0F766E",
};

const COURSE_B: PublicCourse = {
  course_id: "33333333-3333-4333-8333-333333333333",
  name: "الجغرافيا",
  subject: "الجغرافيا",
  description: null,
  grade: null,
  tenant_id: "44444444-4444-4444-8444-444444444444",
  business_name: "أكاديمية الأفق",
  display_name_ar: null,
  display_name_en: "Alofoq Academy",
  accent_color: null,
};

const pageOf = (courses: PublicCourse[], nextCursor: string | null = null) => ({
  courses,
  next_cursor: nextCursor,
});

const envelopeOf = (course: PublicCourse) => ({ course });

// ---------------------------------------------------------------------------
// Harness — manual timer so the debounce is deterministic
// ---------------------------------------------------------------------------

interface ScheduledTimer {
  callback: () => void;
  ms: number;
  cancelled: boolean;
}

interface Harness {
  controller: ReturnType<typeof createPublicCourseDiscoveryController>;
  state: {
    listCalls: Array<{ limit?: number; cursor?: string | null; search?: string | null }>;
    detailCalls: string[];
    listImpl: (options: { limit?: number; cursor?: string | null; search?: string | null }) => Promise<unknown>;
    detailImpl: (courseId: string) => Promise<unknown>;
    principal: string | null;
    sessionListeners: Set<() => void>;
    timers: ScheduledTimer[];
  };
  /** Runs every timer that has not been cancelled, in schedule order. */
  runTimers(): void;
  pendingTimers(): number;
  fireSessionChange(): void;
}

const flush = (): Promise<void> => new Promise<void>((resolve) => setImmediate(resolve));

function setup(): Harness {
  const state = {
    listCalls: [] as Array<{ limit?: number; cursor?: string | null; search?: string | null }>,
    detailCalls: [] as string[],
    listImpl: async (_options: {
      limit?: number;
      cursor?: string | null;
      search?: string | null;
    }): Promise<unknown> => pageOf([COURSE_A]),
    detailImpl: async (_courseId: string): Promise<unknown> => envelopeOf(COURSE_A),
    principal: "session:1" as string | null,
    sessionListeners: new Set<() => void>(),
    timers: [] as ScheduledTimer[],
  };

  const timer: PublicDiscoveryTimer = {
    set: (callback, ms) => {
      const entry: ScheduledTimer = { callback, ms, cancelled: false };
      state.timers.push(entry);
      return entry;
    },
    clear: (handle) => {
      if (handle && typeof handle === "object") {
        (handle as ScheduledTimer).cancelled = true;
      }
    },
  };

  const api: PublicCourseDiscoveryApi = {
    list: async (options) => {
      state.listCalls.push({ ...options });
      return state.listImpl(options);
    },
    detail: async (courseId) => {
      state.detailCalls.push(courseId);
      return state.detailImpl(courseId);
    },
    readPrincipal: () => state.principal,
    subscribeSession: (listener) => {
      state.sessionListeners.add(listener);
      return () => state.sessionListeners.delete(listener);
    },
    timer,
  };

  return {
    controller: createPublicCourseDiscoveryController(api),
    state,
    runTimers: () => {
      const due = state.timers.filter((entry) => !entry.cancelled);
      for (const entry of due) {
        entry.cancelled = true;
        entry.callback();
      }
    },
    pendingTimers: () => state.timers.filter((entry) => !entry.cancelled).length,
    fireSessionChange: () => {
      for (const listener of [...state.sessionListeners]) listener();
    },
  };
}

// ---------------------------------------------------------------------------
// Contract constants and classification
// ---------------------------------------------------------------------------

test("contract: the page constants mirror the server bounds", () => {
  assert.equal(PUBLIC_COURSE_PAGE_LIMIT, 24);
  assert.equal(PUBLIC_COURSE_PAGE_MAX, 60);
  assert.equal(PUBLIC_COURSE_SEARCH_MAX, 100);
  assert.equal(PUBLIC_COURSE_SEARCH_DEBOUNCE_MS, 300);
  // Unpublished, foreign and absent are ONE answer; the client keeps them one.
  assert.equal(PUBLIC_COURSE_UNAVAILABLE_MESSAGE, "Course not found");
});

test("classification: only documented messages classify a read failure", () => {
  assert.equal(classifyPublicDiscoveryFailure(new Error("Failed to load public courses")).reason, "server");
  assert.equal(classifyPublicDiscoveryFailure(new Error("Failed to load public course")).reason, "server");
  assert.equal(classifyPublicDiscoveryFailure(new Error("Invalid public course list limit")).reason, "invalid");
  assert.equal(classifyPublicDiscoveryFailure(new Error("Invalid public course list cursor")).reason, "invalid");
  assert.equal(classifyPublicDiscoveryFailure(new Error("Invalid public course search term")).reason, "invalid");
  assert.equal(classifyPublicDiscoveryFailure(new Error("Token expired")).reason, "session");
  assert.equal(classifyPublicDiscoveryFailure(new Error("Session revoked")).reason, "session");
  // An unrecognised message is never turned into a fabricated status.
  assert.equal(classifyPublicDiscoveryFailure(new Error("boom")).reason, "unknown");
  assert.equal(classifyPublicDiscoveryFailure(new Error("boom")).message, "boom");
  // A list 404 wording is NOT a detail 404 wording.
  assert.equal(
    classifyPublicDiscoveryFailure(new Error(PUBLIC_COURSE_UNAVAILABLE_MESSAGE)).reason,
    "unknown",
  );
});

test("classification: the detail read merges unpublished, foreign and absent into one reason", () => {
  const failure = classifyPublicCourseDetailFailure(new Error(PUBLIC_COURSE_UNAVAILABLE_MESSAGE));
  assert.equal(failure.reason, "unavailable");
  assert.equal(failure.message, PUBLIC_COURSE_UNAVAILABLE_MESSAGE);
  assert.equal(
    classifyPublicCourseDetailFailure(new Error("Failed to load public course")).reason,
    "server",
  );
});

// ---------------------------------------------------------------------------
// Search-term normalisation
// ---------------------------------------------------------------------------

test("search term: blank and whitespace-only become NO filter at all", () => {
  assert.deepEqual(normalisePublicSearchTerm(""), { ok: true, term: null });
  assert.deepEqual(normalisePublicSearchTerm("   "), { ok: true, term: null });
  assert.deepEqual(normalisePublicSearchTerm(null), { ok: true, term: null });
  assert.deepEqual(normalisePublicSearchTerm(undefined), { ok: true, term: null });
});

test("search term: the term is trimmed and bounded by the server ceiling", () => {
  assert.deepEqual(normalisePublicSearchTerm("  تاريخ  "), { ok: true, term: "تاريخ" });
  assert.deepEqual(normalisePublicSearchTerm("a".repeat(PUBLIC_COURSE_SEARCH_MAX)), {
    ok: true,
    term: "a".repeat(PUBLIC_COURSE_SEARCH_MAX),
  });
  const tooLong = normalisePublicSearchTerm("a".repeat(PUBLIC_COURSE_SEARCH_MAX + 1));
  assert.equal(tooLong.ok, false);
  assert.equal(tooLong.ok === false ? tooLong.message : "", PUBLIC_COURSE_SEARCH_TOO_LONG_MESSAGE);
});

// ---------------------------------------------------------------------------
// First page
// ---------------------------------------------------------------------------

test("first page: exactly one bounded request, no cursor and no search term", async () => {
  const harness = setup();
  const outcome = await harness.controller.load();

  assert.equal(outcome, "ready");
  assert.equal(harness.state.listCalls.length, 1);
  assert.deepEqual(harness.state.listCalls[0], {
    limit: PUBLIC_COURSE_PAGE_LIMIT,
    cursor: null,
    search: null,
  });
  const state = harness.controller.getState();
  assert.equal(state.phase, "ready");
  assert.deepEqual(state.courses, [COURSE_A]);
  assert.equal(state.nextCursor, null);
  assert.equal(state.appliedSearch, null);
  assert.equal(state.error, null);
});

test("first page: an empty catalogue is 'empty', not 'error' and not 'ready'", async () => {
  const harness = setup();
  harness.state.listImpl = async () => pageOf([]);

  const outcome = await harness.controller.load();

  assert.equal(outcome, "empty");
  assert.equal(harness.controller.getState().phase, "empty");
  assert.deepEqual(harness.controller.getState().courses, []);
});

test("first page: a duplicate load in the same tick sends exactly one request", async () => {
  const harness = setup();
  let release!: (value: unknown) => void;
  harness.state.listImpl = () => new Promise<unknown>((resolve) => { release = resolve; });

  const first = harness.controller.load();
  const second = harness.controller.load();
  assert.equal(await second, "blocked");

  release(pageOf([COURSE_A]));
  assert.equal(await first, "ready");
  assert.equal(harness.state.listCalls.length, 1);
});

test("first page: an unparseable body is a failed read, never an empty catalogue", async () => {
  const harness = setup();
  harness.state.listImpl = async () => ({ courses: "nope", next_cursor: null });

  const outcome = await harness.controller.load();

  assert.equal(outcome, "failed");
  const state = harness.controller.getState();
  assert.equal(state.phase, "error");
  assert.deepEqual(state.courses, []);
  assert.equal(state.nextCursor, null);
});

test("first page: ONE malformed row refuses the WHOLE page (no partial adoption)", async () => {
  const harness = setup();
  // The second row carries an extra key: the fixed projection is broken, so the
  // page cannot be trusted — and the first, valid row is NOT adopted either.
  harness.state.listImpl = async () => ({
    courses: [COURSE_A, { ...COURSE_B, price: 300 }],
    next_cursor: null,
  });

  await harness.controller.load();

  const state = harness.controller.getState();
  assert.equal(state.phase, "error");
  assert.deepEqual(state.courses, []);
});

test("first page: a failed read reports the server message and holds nothing", async () => {
  const harness = setup();
  harness.state.listImpl = async () => { throw new Error("Failed to load public courses"); };

  const outcome = await harness.controller.load();

  assert.equal(outcome, "failed");
  const state = harness.controller.getState();
  assert.equal(state.phase, "error");
  assert.equal(state.error, "Failed to load public courses");
  assert.equal(state.reason, "server");
  assert.deepEqual(state.courses, []);
});

// ---------------------------------------------------------------------------
// Next page
// ---------------------------------------------------------------------------

test("next page: the server cursor is the only thing that can ask for more", async () => {
  const harness = setup();
  harness.state.listImpl = async (options) => options.cursor === null
    ? pageOf([COURSE_A], "cursor-1")
    : pageOf([COURSE_B], null);

  await harness.controller.load();
  assert.equal(harness.controller.getState().nextCursor, "cursor-1");

  const outcome = await harness.controller.loadMore();

  assert.equal(outcome, "ready");
  assert.equal(harness.state.listCalls.length, 2);
  assert.deepEqual(harness.state.listCalls[1], {
    limit: PUBLIC_COURSE_PAGE_LIMIT,
    cursor: "cursor-1",
    search: null,
  });
  const state = harness.controller.getState();
  assert.deepEqual(state.courses, [COURSE_A, COURSE_B]);
  assert.equal(state.nextCursor, null);
  assert.equal(state.loadingMore, false);
});

test("next page: without a server cursor nothing is sent", async () => {
  const harness = setup();
  await harness.controller.load();

  const outcome = await harness.controller.loadMore();

  assert.equal(outcome, "blocked");
  assert.equal(harness.state.listCalls.length, 1);
});

test("next page: a double click never fetches the same page twice", async () => {
  const harness = setup();
  harness.state.listImpl = async (options) => options.cursor === null
    ? pageOf([COURSE_A], "cursor-1")
    : pageOf([COURSE_B], null);
  await harness.controller.load();

  const first = harness.controller.loadMore();
  const second = harness.controller.loadMore();

  assert.equal(await second, "blocked");
  assert.equal(await first, "ready");
  assert.equal(harness.state.listCalls.length, 2);
});

test("next page: a failed next page never discards the page already held", async () => {
  const harness = setup();
  harness.state.listImpl = async (options) => {
    if (options.cursor === null) return pageOf([COURSE_A], "cursor-1");
    throw new Error("Failed to load public courses");
  };
  await harness.controller.load();

  const outcome = await harness.controller.loadMore();

  assert.equal(outcome, "failed");
  const state = harness.controller.getState();
  // The first page is still exactly what the server last confirmed.
  assert.deepEqual(state.courses, [COURSE_A]);
  assert.equal(state.nextCursor, "cursor-1");
  assert.equal(state.loadingMore, false);
  assert.equal(state.error, "Failed to load public courses");
});

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

test("search: a keystroke is debounced — nothing is sent before the timer fires", async () => {
  const harness = setup();
  await harness.controller.load();
  assert.equal(harness.state.listCalls.length, 1);

  harness.controller.setSearch("تار");

  assert.equal(harness.state.listCalls.length, 1, "no request yet");
  assert.equal(harness.controller.getState().searchInput, "تار", "the typed value is retained");
  assert.equal(harness.pendingTimers(), 1);

  harness.runTimers();
  await flush();

  assert.equal(harness.state.listCalls.length, 2);
  assert.deepEqual(harness.state.listCalls[1], {
    limit: PUBLIC_COURSE_PAGE_LIMIT,
    cursor: null,
    search: "تار",
  });
  assert.equal(harness.controller.getState().appliedSearch, "تار");
});

test("search: several keystrokes coalesce into ONE read for the final term", async () => {
  const harness = setup();
  await harness.controller.load();

  harness.controller.setSearch("ت");
  harness.controller.setSearch("تا");
  harness.controller.setSearch("تار");
  harness.controller.setSearch("تاريخ");

  assert.equal(harness.pendingTimers(), 1, "only the last keystroke is still scheduled");
  harness.runTimers();
  await flush();

  assert.equal(harness.state.listCalls.length, 2);
  assert.equal(harness.state.listCalls[1].search, "تاريخ");
});

test("search: a debounced read that fires after a NEWER keystroke is dropped", async () => {
  const harness = setup();
  await harness.controller.load();
  let releaseFirst!: (value: unknown) => void;
  harness.state.listImpl = () => new Promise<unknown>((resolve) => { releaseFirst = resolve; });

  // Term A is scheduled, then term B replaces it before A's reply lands.
  harness.controller.setSearch("أ");
  harness.runTimers();
  await flush();
  assert.equal(harness.state.listCalls.length, 2, "A was sent");

  harness.controller.setSearch("أب");
  releaseFirst(pageOf([COURSE_B]));
  await flush();

  const state = harness.controller.getState();
  // A's reply must not be adopted: the term on screen is B, not A.
  assert.deepEqual(state.courses, [COURSE_A], "the previous page is still held");
  assert.equal(state.appliedSearch, null);

  harness.runTimers();
  await flush();
  assert.equal(harness.state.listCalls[2].search, "أب");
});

test("search: clearing the term is sent as NO filter at all", async () => {
  const harness = setup();
  await harness.controller.load();

  // Establish a filter first, so clearing it is a real change.
  harness.controller.setSearch("تاريخ");
  harness.runTimers();
  await flush();
  assert.equal(harness.state.listCalls[1].search, "تاريخ");
  assert.equal(harness.controller.getState().appliedSearch, "تاريخ");

  harness.controller.setSearch("   ");
  harness.runTimers();
  await flush();

  assert.equal(harness.state.listCalls.length, 3);
  assert.equal(harness.state.listCalls[2].search, null, "a blank term is not sent as an empty q");
  assert.equal(harness.controller.getState().appliedSearch, null);
});

test("search: a blank term while already unfiltered sends NOTHING", async () => {
  const harness = setup();
  await harness.controller.load();

  harness.controller.setSearch("   ");
  harness.runTimers();
  await flush();

  // The page already shows the unfiltered first page: a truthful no-op.
  assert.equal(harness.state.listCalls.length, 1);
  assert.equal(harness.controller.getState().appliedSearch, null);
  assert.equal(harness.controller.getState().phase, "ready");
});

test("search: an over-long term is refused LOCALLY, with no request at all", async () => {
  const harness = setup();
  await harness.controller.load();

  harness.controller.setSearch("a".repeat(PUBLIC_COURSE_SEARCH_MAX + 1));
  harness.runTimers();
  await flush();

  assert.equal(harness.state.listCalls.length, 1, "no request was sent");
  const state = harness.controller.getState();
  assert.equal(state.error, PUBLIC_COURSE_SEARCH_TOO_LONG_MESSAGE);
  assert.equal(state.reason, "invalid");
});

test("search: applying the already-applied term sends NOTHING", async () => {
  const harness = setup();
  await harness.controller.load();
  harness.controller.setSearch("تاريخ");
  harness.runTimers();
  await flush();
  assert.equal(harness.state.listCalls.length, 2);

  // The same term again: a truthful no-op, not a second read.
  harness.controller.setSearch("تاريخ");
  harness.runTimers();
  await flush();

  assert.equal(harness.state.listCalls.length, 2);
});

test("search: an explicit apply sends immediately and cancels the pending debounce", async () => {
  const harness = setup();
  await harness.controller.load();

  harness.controller.setSearch("جغر");
  assert.equal(harness.pendingTimers(), 1);

  const outcome = await harness.controller.applySearch();

  assert.equal(outcome, "ready");
  assert.equal(harness.state.listCalls.length, 2);
  assert.equal(harness.state.listCalls[1].search, "جغر");
  assert.equal(harness.pendingTimers(), 0, "the debounce was cancelled");

  // The cancelled timer must not produce a second read.
  harness.runTimers();
  await flush();
  assert.equal(harness.state.listCalls.length, 2);
});

// ---------------------------------------------------------------------------
// Detail
// ---------------------------------------------------------------------------

test("detail: one exact read, and only the validated server course is held", async () => {
  const harness = setup();

  const outcome = await harness.controller.openDetail(COURSE_A.course_id);

  assert.equal(outcome, "ready");
  assert.deepEqual(harness.state.detailCalls, [COURSE_A.course_id]);
  const detail = harness.controller.getState().detail;
  assert.equal(detail.status, "ready");
  assert.equal(detail.courseId, COURSE_A.course_id);
  assert.deepEqual(detail.course, COURSE_A);
});

test("detail: unpublished, foreign and absent are ONE 'unavailable' answer", async () => {
  const harness = setup();
  harness.state.detailImpl = async () => { throw new Error(PUBLIC_COURSE_UNAVAILABLE_MESSAGE); };

  const outcome = await harness.controller.openDetail(COURSE_A.course_id);

  assert.equal(outcome, "unavailable");
  const detail = harness.controller.getState().detail;
  assert.equal(detail.status, "unavailable");
  assert.equal(detail.course, null);
  assert.equal(detail.error, PUBLIC_COURSE_UNAVAILABLE_MESSAGE);
});

test("detail: an envelope for ANOTHER course is not a success for this one", async () => {
  const harness = setup();
  harness.state.detailImpl = async () => envelopeOf(COURSE_B);

  const outcome = await harness.controller.openDetail(COURSE_A.course_id);

  assert.equal(outcome, "failed");
  const detail = harness.controller.getState().detail;
  assert.equal(detail.status, "error");
  assert.equal(detail.course, null);
});

test("detail: a malformed envelope is a failure, never a fabricated course", async () => {
  for (const body of [
    null,
    {},
    { course: null },
    { course: COURSE_A, extra: true },
    [envelopeOf(COURSE_A)],
    { course: { ...COURSE_A, price: 300 } },
  ]) {
    const harness = setup();
    harness.state.detailImpl = async () => body;

    const outcome = await harness.controller.openDetail(COURSE_A.course_id);

    assert.equal(outcome, "failed", `body ${JSON.stringify(body)} must fail`);
    assert.equal(harness.controller.getState().detail.status, "error");
    assert.equal(harness.controller.getState().detail.course, null);
  }
});

test("detail: a blank id sends nothing", async () => {
  const harness = setup();

  const outcome = await harness.controller.openDetail("   ");

  assert.equal(outcome, "idle");
  assert.deepEqual(harness.state.detailCalls, []);
});

test("detail: closing the panel retires the read, so a late reply cannot reopen it", async () => {
  const harness = setup();
  let release!: (value: unknown) => void;
  harness.state.detailImpl = () => new Promise<unknown>((resolve) => { release = resolve; });

  const opened = harness.controller.openDetail(COURSE_A.course_id);
  harness.controller.closeDetail();
  release(envelopeOf(COURSE_A));

  assert.equal(await opened, "blocked");
  const detail = harness.controller.getState().detail;
  assert.equal(detail.status, "idle");
  assert.equal(detail.courseId, null);
  assert.equal(detail.course, null);
});

// ---------------------------------------------------------------------------
// Session, dispose and the public-data rule
// ---------------------------------------------------------------------------

test("session: a change retires the in-flight read but KEEPS the public page", async () => {
  const harness = setup();
  await harness.controller.load();
  let release!: (value: unknown) => void;
  harness.state.listImpl = () => new Promise<unknown>((resolve) => { release = resolve; });

  const pending = harness.controller.load();
  harness.state.principal = "session:2";
  harness.fireSessionChange();
  release(pageOf([COURSE_B]));

  assert.equal(await pending, "blocked");
  const state = harness.controller.getState();
  // The catalogue is public and byte-identical for every principal, so nothing
  // held becomes foreign; only the unstampable reply is dropped.
  assert.deepEqual(state.courses, [COURSE_A]);
  assert.equal(state.phase, "ready");
  assert.equal(state.error, null);
});

test("session: a reply observed after a principal change never commits", async () => {
  const harness = setup();
  let release!: (value: unknown) => void;
  harness.state.listImpl = () => new Promise<unknown>((resolve) => { release = resolve; });

  const pending = harness.controller.load();
  // No notification is fired: the reader alone observes the new session.
  harness.state.principal = "session:9";
  release(pageOf([COURSE_B]));

  assert.equal(await pending, "blocked");
  assert.deepEqual(harness.controller.getState().courses, []);
});

test("dispose: nothing commits afterwards and the pending debounce is cancelled", async () => {
  const harness = setup();
  await harness.controller.load();

  harness.controller.setSearch("تار");
  assert.equal(harness.pendingTimers(), 1);

  harness.controller.dispose();
  assert.equal(harness.pendingTimers(), 0, "the debounce was cancelled");

  harness.runTimers();
  await flush();
  assert.equal(harness.state.listCalls.length, 1, "no read was issued after dispose");

  // Every later entry point is inert.
  assert.equal(await harness.controller.load(), "blocked");
  assert.equal(await harness.controller.loadMore(), "blocked");
  assert.equal(await harness.controller.openDetail(COURSE_A.course_id), "idle");
  assert.deepEqual(harness.state.detailCalls, []);
  assert.deepEqual(harness.controller.getState().courses, []);
});

// ---------------------------------------------------------------------------
// Structural honesty
// ---------------------------------------------------------------------------

test("projection: the page holds only the ten public fields the server sent", async () => {
  const harness = setup();
  await harness.controller.load();

  const row = harness.controller.getState().courses[0];
  assert.deepEqual(Object.keys(row).sort(), [
    "accent_color",
    "business_name",
    "course_id",
    "description",
    "display_name_ar",
    "display_name_en",
    "grade",
    "name",
    "subject",
    "tenant_id",
  ]);

  // No private, commercial, delivery or contact value is ever present.
  const values = Object.values(row as unknown as Record<string, unknown>);
  for (const forbidden of [
    "price", "instructor", "instructor_id", "lesson", "material", "student",
    "email", "phone", "owner", "subscription", "enrollment", "payment",
    "is_active", "publication_state", "published_at", "thumbnail_url",
  ]) {
    assert.equal(
      Object.keys(row as unknown as Record<string, unknown>).includes(forbidden),
      false,
      `the public projection must not carry the "${forbidden}" key`,
    );
    assert.equal(values.includes(forbidden), false, `and no "${forbidden}" value`);
  }
});

test("readPublicCourse: the shared parser is the SAME strict one the transport uses", () => {
  assert.deepEqual(readPublicCourse(COURSE_A), COURSE_A);
  assert.equal(readPublicCourse({ ...COURSE_A, price: 100 }), null);
  assert.equal(readPublicCourse({ ...COURSE_A, accent_color: "#0f766e" }), null, "lowercase accent is not canonical");
  assert.equal(readPublicCourse({ ...COURSE_A, name: "" }), null);
  assert.equal(readPublicCourse(null), null);
});
