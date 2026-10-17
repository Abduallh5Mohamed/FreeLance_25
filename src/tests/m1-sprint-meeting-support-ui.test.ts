/**
 * M1 sprint meeting/support UI isolated tests (node:test + tsx).
 *
 * Scope: the meeting and support UI contracts corrected in this sprint —
 *
 *   - src/pages/OnlineMeeting.tsx   (teacher meetings)
 *   - src/pages/StudentMeetings.tsx (student meetings)
 *   - src/pages/Support.tsx         (support tickets)
 *
 * Pinned contracts:
 *   1. `isSafeMeetingUrl` — a meeting link is only usable when it is an
 *      absolute http(s) URL with a host; every other scheme is rejected so a
 *      stored or server-provided link can never execute script or navigate the
 *      user away from the app. The two copies (teacher + student) must agree.
 *   2. `describeMeetingsLoadError` — a failed list fetch (401/403/5xx/network)
 *      must be reported as an honest load failure, never as "no meetings". The
 *      two copies must agree.
 *   3. `createSubmitGuard` — a synchronous in-flight latch that rejects a
 *      same-tick duplicate submit and, after `release()`, allows a retry. The
 *      two copies (OnlineMeeting + Support) must agree.
 *
 * These tests are fully isolated: no env files, no database, no network, no
 * live app startup. The transport modules that would read Vite's
 * `import.meta.env` (`@/lib/api`, `@/lib/api-http`) and static image assets are
 * replaced with inert in-memory modules via `node:module` resolve hooks, so the
 * page modules can be imported under plain Node.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { registerHooks } from "node:module";
import type { SupportReply, SupportTicket } from "../lib/api";
import { notifySessionChange } from "../lib/session-events";

// ---------------------------------------------------------------------------
// Inert in-memory replacements for transport + assets. These never perform
// I/O and exist only so the page modules (and their header components) can be
// imported outside Vite. No dotenv / DB / network imports are involved.
// ---------------------------------------------------------------------------
const API_STUB = [
  "export const createSupportTicket = async () => ({ id: 'stub', ticket_number: 'STUB-1' });",
  "export const getMySupportTickets = async () => [];",
  "export const getSupportQueue = async () => [];",
  "export const getSupportTicket = async () => ({ ticket: null, replies: [] });",
  "export const replyToSupportTicket = async () => ({ id: 'stub-reply' });",
  "export const updateSupportTicketStatus = async () => ({ id: 'stub' });",
].join("\n");

const API_HTTP_STUB = [
  "export const getGrades = async () => [];",
  "export const getGroups = async () => [];",
  "export const createSubscriptionRequest = async () => ({});",
  "export const getSubscriptions = async () => [];",
  "export const clearAuthToken = () => {};",
].join("\n");

const ASSET_EXT = /\.(png|jpe?g|gif|svg|webp|avif|css|scss)$/i;

const toDataModule = (source: string) =>
  "data:text/javascript," + encodeURIComponent(source);

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (ASSET_EXT.test(specifier)) {
      return { url: toDataModule("export default 'stub-asset';"), shortCircuit: true };
    }
    const resolved = nextResolve(specifier, context);
    const clean = String(resolved.url).split("?")[0].replace(/\\/g, "/");
    if (clean.endsWith("/src/lib/api-http.ts")) {
      return { url: toDataModule(API_HTTP_STUB), shortCircuit: true };
    }
    if (clean.endsWith("/src/lib/api.ts")) {
      return { url: toDataModule(API_STUB), shortCircuit: true };
    }
    return resolved;
  },
});

// ---------------------------------------------------------------------------
// Minimal in-memory localStorage so the pages' auth helpers can be exercised
// under Node with no I/O (no files, no network, no browser).
// ---------------------------------------------------------------------------
const storage = new Map<string, string>();
(globalThis as unknown as { localStorage: Storage }).localStorage = {
  getItem: (key: string) => (storage.has(key) ? storage.get(key)! : null),
  setItem: (key: string, value: string) => { storage.set(key, String(value)); },
  removeItem: (key: string) => { storage.delete(key); },
  clear: () => { storage.clear(); },
  key: (index: number) => Array.from(storage.keys())[index] ?? null,
  get length() { return storage.size; },
};

type Guard = { tryAcquire(): boolean; release(): void };
type Loader<T> = { load(): Promise<void>; invalidate(): void };
type LoaderDeps<T> = {
  request: (identity: string | null) => Promise<T[]>;
  readIdentity: () => string | null;
  readScope?: () => string | null;
  onClear: () => void;
  onApply: (items: T[]) => void;
  onError: (message: string) => void;
  onLoadingChange?: (loading: boolean) => void;
};
type DetailsDeps = {
  request: (ticketId: string) => Promise<{ ticket: SupportTicket; replies: SupportReply[] }>;
  onSelect: (ticket: SupportTicket) => void;
  onClearReplies: () => void;
  onApply: (ticket: SupportTicket, replies: SupportReply[]) => void;
  onError: (message: string) => void;
  onLoadingChange?: (loading: boolean) => void;
};
type DetailsController = { open(ticket: SupportTicket): Promise<void>; invalidate(): void };
type ActionRefusal = "no-session" | "scope-changed" | "not-in-list" | "unsafe-url";
type ActionDecision = { ok: boolean; reason?: ActionRefusal; url?: string };
type ActionGateDeps = {
  readScope: () => string | null;
  isMember: (link: string) => boolean;
  clearLinks: () => void;
  invalidateLoad: () => void;
  openLink?: (url: string) => void;
  copyText?: (text: string) => Promise<void> | void;
  onRefused?: (reason: ActionRefusal, message: string) => void;
};
type ActionGate = {
  applied(scope: string | null): void;
  clear(): void;
  authorize(link: string): ActionDecision;
  join(link: string): ActionDecision;
  copy(link: string): Promise<ActionDecision>;
};
type WatcherDeps = {
  readScope: () => string | null;
  onScopeChange: () => void;
  getWindow?: () => (Window & typeof globalThis) | null;
  getDocument?: () => Document | null;
};
type Watcher = { start(): void; stop(): void; check(): boolean };
type MeetingHelpers = {
  isSafeMeetingUrl(value: string): boolean;
  describeMeetingsLoadError(error: unknown): string;
  createSubmitGuard(): Guard;
  createMeetingsLoader<T>(deps: LoaderDeps<T>): Loader<T>;
  createMeetingSessionGuard(deps: {
    getLoader: () => { invalidate: () => void } | null;
    clearRenderedMeetings: () => void;
  }): () => void;
  meetingAuthToken(): string | null;
  getMeetingAuthHeaders(): Record<string, string>;
  meetingLoadScope(): string | null;
  NO_MEETING_SCOPE_MESSAGE: string;
  createMeetingActionGate(deps: ActionGateDeps): ActionGate;
  createMeetingsScopeWatcher(deps: WatcherDeps): Watcher;
};
type MeetingCopy = Omit<MeetingHelpers, "createSubmitGuard">;
type Pages = {
  onlineMeeting: MeetingHelpers;
  studentMeetings: MeetingCopy;
  support: {
    createSubmitGuard(): Guard;
    createLatestRequestGuard(): { begin(): number; isLatest(token: number): boolean };
    createTicketDetailsController(deps: DetailsDeps): DetailsController;
  };
};

/** A manually-resolved promise so a test can control completion order. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

let pagesPromise: Promise<Pages> | null = null;

function loadPages(): Promise<Pages> {
  pagesPromise ??= (async () => ({
    onlineMeeting: await import("../pages/OnlineMeeting"),
    studentMeetings: await import("../pages/StudentMeetings"),
    support: await import("../pages/Support"),
  }))();
  return pagesPromise;
}

// ---------------------------------------------------------------------------
// 1. isSafeMeetingUrl
// ---------------------------------------------------------------------------
const ACCEPTED_LINKS = [
  "https://zoom.us/j/123456789",
  "http://meet.google.com/abc-defg-hij",
  "https://example.com/room?pwd=secret",
  "https://example.com:8443/live",
  "   https://zoom.us/j/42   ", // surrounding whitespace is trimmed
];

const REJECTED_LINKS = [
  "",
  "   ",
  "javascript:alert(1)",
  "JavaScript:alert(1)",
  "data:text/html,<script>alert(1)</script>",
  "blob:https://evil.example/uuid",
  "file:///etc/passwd",
  "mailto:teacher@example.com",
  "tel:+201234567890",
  "zoom.us/j/123", // relative, no scheme
  "//evil.example/room", // protocol-relative, no scheme
  "https://", // scheme but no host
  "http://", // scheme but no host
];

test("isSafeMeetingUrl accepts only absolute http(s) links with a host", async () => {
  const { onlineMeeting } = await loadPages();
  for (const link of ACCEPTED_LINKS) {
    assert.equal(
      onlineMeeting.isSafeMeetingUrl(link),
      true,
      `expected accepted: ${JSON.stringify(link)}`,
    );
  }
  for (const link of REJECTED_LINKS) {
    assert.equal(
      onlineMeeting.isSafeMeetingUrl(link),
      false,
      `expected rejected: ${JSON.stringify(link)}`,
    );
  }
});

test("isSafeMeetingUrl: teacher and student copies agree on every case", async () => {
  const { onlineMeeting, studentMeetings } = await loadPages();
  for (const link of [...ACCEPTED_LINKS, ...REJECTED_LINKS]) {
    assert.equal(
      onlineMeeting.isSafeMeetingUrl(link),
      studentMeetings.isSafeMeetingUrl(link),
      `copies disagree for ${JSON.stringify(link)}`,
    );
  }
});

// ---------------------------------------------------------------------------
// 2. describeMeetingsLoadError
// ---------------------------------------------------------------------------
const SESSION_EXPIRED = "انتهت صلاحية الجلسة. سجّل الدخول مرة أخرى.";
const NO_PERMISSION = "لا تملك صلاحية عرض الاجتماعات.";
const SERVER_ERROR = "تعذر تحميل الاجتماعات من الخادم. حاول مرة أخرى.";
const CONNECTION_ERROR = "تعذر الاتصال بالخادم. تحقق من الشبكة وحاول مرة أخرى.";

const ERROR_CASES: Array<{ label: string; error: unknown; expected: string }> = [
  { label: "401 response", error: { response: { status: 401 } }, expected: SESSION_EXPIRED },
  { label: "403 response", error: { response: { status: 403 } }, expected: NO_PERMISSION },
  { label: "500 response", error: { response: { status: 500 } }, expected: SERVER_ERROR },
  { label: "404 response", error: { response: { status: 404 } }, expected: SERVER_ERROR },
  { label: "network failure (no response)", error: new Error("Network Error"), expected: CONNECTION_ERROR },
  { label: "null", error: null, expected: CONNECTION_ERROR },
  { label: "undefined", error: undefined, expected: CONNECTION_ERROR },
  { label: "string", error: "boom", expected: CONNECTION_ERROR },
  { label: "response without numeric status", error: { response: { status: "401" } }, expected: CONNECTION_ERROR },
];

test("describeMeetingsLoadError maps failure kinds to honest messages", async () => {
  const { onlineMeeting } = await loadPages();
  for (const { label, error, expected } of ERROR_CASES) {
    assert.equal(
      onlineMeeting.describeMeetingsLoadError(error),
      expected,
      `unexpected message for ${label}`,
    );
  }
});

test("describeMeetingsLoadError: 401/403 are never reported as a connection problem", async () => {
  const { onlineMeeting } = await loadPages();
  assert.notEqual(onlineMeeting.describeMeetingsLoadError({ response: { status: 401 } }), CONNECTION_ERROR);
  assert.notEqual(onlineMeeting.describeMeetingsLoadError({ response: { status: 403 } }), CONNECTION_ERROR);
});

test("describeMeetingsLoadError: teacher and student copies agree on every case", async () => {
  const { onlineMeeting, studentMeetings } = await loadPages();
  for (const { label, error } of ERROR_CASES) {
    assert.equal(
      onlineMeeting.describeMeetingsLoadError(error),
      studentMeetings.describeMeetingsLoadError(error),
      `copies disagree for ${label}`,
    );
  }
});

// ---------------------------------------------------------------------------
// 3. createSubmitGuard
// ---------------------------------------------------------------------------
test("createSubmitGuard rejects a same-tick duplicate and allows retry after release", async () => {
  const { onlineMeeting } = await loadPages();
  const guard = onlineMeeting.createSubmitGuard();

  // Same tick: the first acquire wins, the next two are rejected.
  assert.deepEqual([guard.tryAcquire(), guard.tryAcquire(), guard.tryAcquire()], [true, false, false]);

  // Release happens in the handler's `finally`, so a retry is allowed.
  guard.release();
  assert.equal(guard.tryAcquire(), true);
  guard.release();
  assert.equal(guard.tryAcquire(), true);
});

test("createSubmitGuard keeps a failed attempt retryable", async () => {
  const { onlineMeeting } = await loadPages();
  const guard = onlineMeeting.createSubmitGuard();

  let attempts = 0;
  const submit = async (shouldFail: boolean) => {
    if (!guard.tryAcquire()) return false;
    try {
      attempts += 1;
      if (shouldFail) throw new Error("transport failure");
      return true;
    } finally {
      guard.release();
    }
  };

  await assert.rejects(() => submit(true));
  assert.equal(attempts, 1);
  // The failed attempt released the latch, so the user can retry.
  assert.equal(await submit(false), true);
  assert.equal(attempts, 2);
});

test("createSubmitGuard: independent instances do not share state", async () => {
  const { onlineMeeting } = await loadPages();
  const a = onlineMeeting.createSubmitGuard();
  const b = onlineMeeting.createSubmitGuard();
  assert.equal(a.tryAcquire(), true);
  assert.equal(b.tryAcquire(), true, "a second guard must not be blocked by the first");
  assert.equal(a.tryAcquire(), false);
});

test("createSubmitGuard: OnlineMeeting and Support copies behave identically", async () => {
  const { onlineMeeting, support } = await loadPages();
  const teacher = onlineMeeting.createSubmitGuard();
  const supportGuard = support.createSubmitGuard();

  const teacherSequence = [teacher.tryAcquire(), teacher.tryAcquire()];
  const supportSequence = [supportGuard.tryAcquire(), supportGuard.tryAcquire()];
  assert.deepEqual(teacherSequence, supportSequence);
  assert.deepEqual(teacherSequence, [true, false]);

  teacher.release();
  supportGuard.release();
  assert.deepEqual([teacher.tryAcquire(), supportGuard.tryAcquire()], [true, true]);
});

// ---------------------------------------------------------------------------
// 4. createMeetingsLoader — stale-completion / identity invalidation
//
// These drive the real production loader (the same object the page wires to
// component state), not a re-implementation of its decision.
// ---------------------------------------------------------------------------
test("createMeetingsLoader commits only the newest response when an older one resolves later", async () => {
  const { onlineMeeting } = await loadPages();
  const first = deferred<string[]>();
  const second = deferred<string[]>();
  const responses = [first.promise, second.promise];
  let call = 0;
  const applied: string[][] = [];
  const errors: string[] = [];
  const loading: boolean[] = [];
  let clears = 0;

  const loader = onlineMeeting.createMeetingsLoader<string>({
    request: () => responses[call++],
    readIdentity: () => "teacher-1",
    onClear: () => { clears += 1; },
    onApply: (items) => applied.push(items),
    onError: (message) => errors.push(message),
    onLoadingChange: (value) => loading.push(value),
  });

  const loadOld = loader.load(); // claims token 1
  const loadNew = loader.load(); // claims token 2, invalidating token 1
  second.resolve(["new-meeting"]);
  await loadNew;
  first.resolve(["old-meeting"]); // stale: must never overwrite the newer list
  await loadOld;

  assert.deepEqual(applied, [["new-meeting"]], "only the newest list may commit");
  assert.deepEqual(errors, []);
  assert.equal(clears, 2, "each load clears stale links before loading");
  // The stale completion must not flip loading back off.
  assert.deepEqual(loading, [true, true, false]);
});

test("createMeetingsLoader reports 401/403 honestly, clears the list and never applies", async () => {
  const { onlineMeeting, studentMeetings } = await loadPages();
  const copies: Array<[string, Pages["onlineMeeting"] | Pages["studentMeetings"]]> = [
    ["OnlineMeeting", onlineMeeting],
    ["StudentMeetings", studentMeetings],
  ];
  const cases = [
    { status: 401, expected: SESSION_EXPIRED },
    { status: 403, expected: NO_PERMISSION },
  ];

  for (const [name, copy] of copies) {
    for (const { status, expected } of cases) {
      const applied: string[][] = [];
      const errors: string[] = [];
      let clears = 0;
      const loader = copy.createMeetingsLoader<string>({
        request: () => Promise.reject({ response: { status } }),
        readIdentity: () => "user-1",
        onClear: () => { clears += 1; },
        onApply: (items) => applied.push(items),
        onError: (message) => errors.push(message),
      });

      await loader.load();

      assert.deepEqual(applied, [], `${name}: a failed load must not apply a list`);
      assert.deepEqual(errors, [expected], `${name}: honest message for ${status}`);
      assert.equal(clears, 1, `${name}: stale links cleared on failure`);
    }
  }
});

test("createMeetingsLoader drops a response whose user identity changed mid-flight", async () => {
  const { studentMeetings } = await loadPages();
  const pending = deferred<string[]>();
  let identity: string | null = "student-A";
  const applied: string[][] = [];
  const errors: string[] = [];

  const loader = studentMeetings.createMeetingsLoader<string>({
    request: () => pending.promise,
    readIdentity: () => identity,
    onClear: () => {},
    onApply: (items) => applied.push(items),
    onError: (message) => errors.push(message),
  });

  const load = loader.load(); // issued for student-A
  identity = null; // the user signed out before the response landed
  pending.resolve(["private-join-link"]);
  await load;

  assert.deepEqual(applied, [], "a previous user's links must never be committed");
  assert.deepEqual(errors, []);
});

test("createMeetingsLoader.invalidate drops an in-flight response (unmount/logout)", async () => {
  const { onlineMeeting } = await loadPages();
  const pending = deferred<string[]>();
  const applied: string[][] = [];
  const loader = onlineMeeting.createMeetingsLoader<string>({
    request: () => pending.promise,
    readIdentity: () => "teacher-1",
    onClear: () => {},
    onApply: (items) => applied.push(items),
    onError: () => {},
  });

  const load = loader.load();
  loader.invalidate();
  pending.resolve(["late-link"]);
  await load;

  assert.deepEqual(applied, []);
});

// ---------------------------------------------------------------------------
// 5. createLatestRequestGuard — Support ticket-detail stale-completion
// ---------------------------------------------------------------------------
test("createLatestRequestGuard only lets the newest token commit", async () => {
  const { support } = await loadPages();
  const guard = support.createLatestRequestGuard();
  const a = guard.begin();
  const b = guard.begin();
  assert.equal(guard.isLatest(a), false);
  assert.equal(guard.isLatest(b), true);
  const c = guard.begin();
  assert.equal(guard.isLatest(b), false);
  assert.equal(guard.isLatest(c), true);
});

// ---------------------------------------------------------------------------
// 6. createTicketDetailsController — the real production open/clear/commit path
//
// These drive the exact controller the Support page wires to component state
// (open → clear previous replies → commit only the latest response), not a
// re-implementation of the caller workflow.
// ---------------------------------------------------------------------------
const makeTicket = (id: string): SupportTicket => ({
  id,
  ticket_number: `T-${id}`,
  category: "technical",
  subject: `subject ${id}`,
  status: "open",
  priority: "normal",
  created_at: "2026-01-01T00:00:00.000Z",
  updated_at: "2026-01-01T00:00:00.000Z",
});

const makeReply = (id: string): SupportReply => ({
  id,
  sender_id: "user-1",
  sender_name: "user",
  sender_role: "student",
  body: `body ${id}`,
  created_at: "2026-01-01T00:00:00.000Z",
});

test("createTicketDetailsController clears the previous ticket's replies the moment another ticket opens", async () => {
  const { support } = await loadPages();
  const first = deferred<{ ticket: SupportTicket; replies: SupportReply[] }>();
  const second = deferred<{ ticket: SupportTicket; replies: SupportReply[] }>();
  const pending = [first.promise, second.promise];
  let call = 0;
  let replies: string[] = [];
  const applied: string[][] = [];
  const selected: string[] = [];
  let clears = 0;
  const errors: string[] = [];

  const controller = support.createTicketDetailsController({
    request: () => pending[call++],
    onSelect: (ticket) => selected.push(ticket.id),
    onClearReplies: () => { clears += 1; replies = []; },
    onApply: (ticket, next) => {
      selected[selected.length - 1] = ticket.id;
      replies = next.map((item) => item.id);
      applied.push(replies);
    },
    onError: (message) => errors.push(message),
  });

  const openA = controller.open(makeTicket("A"));
  first.resolve({ ticket: makeTicket("A"), replies: [makeReply("a1")] });
  await openA;
  assert.deepEqual(replies, ["a1"]);

  const openB = controller.open(makeTicket("B"));
  // Ticket A's replies must be gone the instant B is opened, before B settles.
  assert.deepEqual(replies, [], "stale replies cleared while the different ticket loads");
  second.resolve({ ticket: makeTicket("B"), replies: [makeReply("b1")] });
  await openB;

  assert.deepEqual(replies, ["b1"]);
  assert.deepEqual(applied, [["a1"], ["b1"]], "each ticket commits only its own replies");
  assert.equal(clears, 2, "replies cleared on every open");
  assert.deepEqual(errors, []);
});

test("createTicketDetailsController clears stale replies on failure and never commits the failed ticket", async () => {
  const { support } = await loadPages();
  const first = deferred<{ ticket: SupportTicket; replies: SupportReply[] }>();
  const failing = deferred<{ ticket: SupportTicket; replies: SupportReply[] }>();
  const pending = [first.promise, failing.promise];
  let call = 0;
  let replies: string[] = [];
  const applied: string[][] = [];
  const errors: string[] = [];
  const loading: boolean[] = [];

  const controller = support.createTicketDetailsController({
    request: () => pending[call++],
    onSelect: () => {},
    onClearReplies: () => { replies = []; },
    onApply: (_ticket, next) => { replies = next.map((item) => item.id); applied.push(replies); },
    onError: (message) => errors.push(message),
    onLoadingChange: (value) => loading.push(value),
  });

  const openA = controller.open(makeTicket("A"));
  first.resolve({ ticket: makeTicket("A"), replies: [makeReply("a1")] });
  await openA;
  assert.deepEqual(replies, ["a1"]);

  const openB = controller.open(makeTicket("B"));
  assert.deepEqual(replies, [], "A's replies cleared before B can fail");
  failing.reject(new Error("network down"));
  await openB;

  assert.deepEqual(replies, [], "a failed open must not resurrect the previous ticket's replies");
  assert.deepEqual(applied, [["a1"]], "no details committed for the failed ticket");
  assert.deepEqual(errors, ["network down"]);
  assert.deepEqual(loading, [true, false, true, false], "loading toggles per open");
});

test("createTicketDetailsController drops a superseded open (reversed completion)", async () => {
  const { support } = await loadPages();
  const first = deferred<{ ticket: SupportTicket; replies: SupportReply[] }>();
  const second = deferred<{ ticket: SupportTicket; replies: SupportReply[] }>();
  const pending = [first.promise, second.promise];
  let call = 0;
  const applied: string[][] = [];

  const controller = support.createTicketDetailsController({
    request: () => pending[call++],
    onSelect: () => {},
    onClearReplies: () => {},
    onApply: (_ticket, next) => applied.push(next.map((item) => item.id)),
    onError: () => {},
  });

  const openA = controller.open(makeTicket("A"));
  const openB = controller.open(makeTicket("B"));
  second.resolve({ ticket: makeTicket("B"), replies: [makeReply("b1")] });
  await openB;
  first.resolve({ ticket: makeTicket("A"), replies: [makeReply("a1")] }); // stale
  await openA;

  assert.deepEqual(applied, [["b1"]], "only the newest open may commit");
});

test("createTicketDetailsController.invalidate drops an in-flight open (close/identity change)", async () => {
  const { support } = await loadPages();
  const pending = deferred<{ ticket: SupportTicket; replies: SupportReply[] }>();
  const applied: string[][] = [];
  const errors: string[] = [];

  const controller = support.createTicketDetailsController({
    request: () => pending.promise,
    onSelect: () => {},
    onClearReplies: () => {},
    onApply: (_ticket, next) => applied.push(next.map((item) => item.id)),
    onError: (message) => errors.push(message),
  });

  const openA = controller.open(makeTicket("A"));
  controller.invalidate();
  pending.resolve({ ticket: makeTicket("A"), replies: [makeReply("a1")] });
  await openA;

  assert.deepEqual(applied, [], "an invalidated open must not commit");
  assert.deepEqual(errors, []);
});

// ---------------------------------------------------------------------------
// 7. Canonical token key + load scope (OnlineMeeting / StudentMeetings)
// ---------------------------------------------------------------------------
test("meeting auth helpers read the canonical authToken key and fail closed when absent", async () => {
  const { onlineMeeting, studentMeetings } = await loadPages();
  const copies: Array<[string, MeetingCopy]> = [
    ["OnlineMeeting", onlineMeeting],
    ["StudentMeetings", studentMeetings],
  ];
  for (const [name, copy] of copies) {
    localStorage.clear();
    assert.equal(copy.meetingAuthToken(), null, `${name}: no token -> null`);
    assert.deepEqual(copy.getMeetingAuthHeaders(), {}, `${name}: no token -> no Authorization`);

    // The legacy `token` key is NOT canonical and must be ignored.
    localStorage.setItem("token", "legacy-token");
    assert.equal(copy.meetingAuthToken(), null, `${name}: legacy key ignored`);
    assert.deepEqual(copy.getMeetingAuthHeaders(), {}, `${name}: legacy key must not build a header`);

    localStorage.setItem("authToken", "canonical-token");
    assert.equal(copy.meetingAuthToken(), "canonical-token", `${name}: canonical key read`);
    assert.deepEqual(
      copy.getMeetingAuthHeaders(),
      { Authorization: "Bearer canonical-token" },
      `${name}: Authorization built from authToken`,
    );
  }
  localStorage.clear();
});

test("meeting load scope includes the auth token, so a rotation for the same user is a scope change", async () => {
  const { onlineMeeting, studentMeetings } = await loadPages();
  localStorage.clear();
  assert.equal(onlineMeeting.meetingLoadScope(), null);
  localStorage.setItem("currentUser", JSON.stringify({ id: "teacher-1" }));
  assert.equal(onlineMeeting.meetingLoadScope(), null, "no token -> no scope");
  localStorage.setItem("authToken", "token-a");
  assert.equal(onlineMeeting.meetingLoadScope(), "teacher-1:token-a");
  localStorage.setItem("authToken", "token-b");
  assert.equal(
    onlineMeeting.meetingLoadScope(),
    "teacher-1:token-b",
    "same user, rotated token -> different scope",
  );
  assert.equal(studentMeetings.meetingLoadScope(), "teacher-1:token-b", "student copy agrees");
  localStorage.clear();
});

test("createMeetingsLoader drops a response whose token rotated mid-flight (same user)", async () => {
  const { onlineMeeting, studentMeetings } = await loadPages();
  const copies: Array<[string, MeetingCopy]> = [
    ["OnlineMeeting", onlineMeeting],
    ["StudentMeetings", studentMeetings],
  ];
  for (const [name, copy] of copies) {
    const pending = deferred<string[]>();
    let scope: string | null = "teacher-1:token-a";
    const applied: string[][] = [];
    const loader = copy.createMeetingsLoader<string>({
      request: () => pending.promise,
      readIdentity: () => "teacher-1",
      readScope: () => scope,
      onClear: () => {},
      onApply: (items) => applied.push(items),
      onError: () => {},
    });

    const load = loader.load(); // issued under token-a
    scope = "teacher-1:token-b"; // token rotated for the same user before the response landed
    pending.resolve(["private-join-link"]);
    await load;

    assert.deepEqual(applied, [], `${name}: a response issued under a rotated token must not commit`);
  }
});

test("createMeetingsLoader issues NO protected request when there is no session scope", async () => {
  const { onlineMeeting, studentMeetings } = await loadPages();
  const copies: Array<[string, MeetingCopy]> = [
    ["OnlineMeeting", onlineMeeting],
    ["StudentMeetings", studentMeetings],
  ];
  for (const [name, copy] of copies) {
    let requests = 0;
    const applied: string[][] = [];
    const errors: string[] = [];
    const loading: boolean[] = [];
    const loader = copy.createMeetingsLoader<string>({
      request: async () => {
        requests += 1;
        return ["should-never-be-fetched"];
      },
      readIdentity: () => null,
      readScope: () => null,
      onClear: () => {},
      onApply: (items) => applied.push(items),
      onError: (message) => errors.push(message),
      onLoadingChange: (value) => loading.push(value),
    });

    await loader.load();

    assert.equal(requests, 0, `${name}: no session scope must not reach the transport`);
    assert.deepEqual(applied, [], `${name}: nothing is applied`);
    assert.deepEqual(errors, [copy.NO_MEETING_SCOPE_MESSAGE], `${name}: honest session message`);
    assert.deepEqual(loading, [true, false], `${name}: loading is released`);
  }
});

// ---------------------------------------------------------------------------
// 7. createMeetingActionGate — action-time authorization of join/copy/open
//
// The gate is what the pages call on every join/copy click, including the
// non-secure-context clipboard fallback (which lives inside the injected
// copyText), so a stale or foreign session can neither open nor copy a private
// meeting link.
// ---------------------------------------------------------------------------
const gateHarness = (overrides: Partial<ActionGateDeps> = {}) => {
  const state = {
    opens: [] as string[],
    copies: [] as string[],
    clears: 0,
    invalidations: 0,
    refusals: [] as Array<{ reason: ActionRefusal; message: string }>,
  };
  const deps: ActionGateDeps = {
    readScope: () => "user-1:token-1",
    isMember: () => true,
    clearLinks: () => { state.clears += 1; },
    invalidateLoad: () => { state.invalidations += 1; },
    openLink: (url) => { state.opens.push(url); },
    copyText: (text) => { state.copies.push(text); },
    onRefused: (reason, message) => { state.refusals.push({ reason, message }); },
    ...overrides,
  };
  return { deps, state };
};

test("the action gate opens and copies a link from the applied scope (normal paths)", async () => {
  const { onlineMeeting, studentMeetings } = await loadPages();
  const copies: Array<[string, MeetingCopy]> = [
    ["OnlineMeeting", onlineMeeting],
    ["StudentMeetings", studentMeetings],
  ];
  const LINK = "https://zoom.us/j/123456789";

  for (const [name, copy] of copies) {
    const { deps, state } = gateHarness();
    const gate = copy.createMeetingActionGate(deps);
    gate.applied("user-1:token-1");

    const joined = gate.join(LINK);
    assert.equal(joined.ok, true, `${name}: join allowed for the applied scope`);
    assert.deepEqual(state.opens, [LINK]);
    assert.deepEqual(state.copies, [], `${name}: join does not copy`);

    const copied = await gate.copy(LINK);
    assert.equal(copied.ok, true, `${name}: copy allowed for the applied scope`);
    assert.deepEqual(state.copies, [LINK]);
    assert.deepEqual(state.refusals, []);
    assert.equal(state.clears, 0, `${name}: a successful action clears nothing`);
  }
});

test("a null session scope refuses the action, clears the links and invalidates the load", async () => {
  const { onlineMeeting, studentMeetings } = await loadPages();
  const copies: Array<[string, MeetingCopy]> = [
    ["OnlineMeeting", onlineMeeting],
    ["StudentMeetings", studentMeetings],
  ];
  const LINK = "https://zoom.us/j/123456789";

  for (const [name, copy] of copies) {
    const { deps, state } = gateHarness({ readScope: () => null });
    const gate = copy.createMeetingActionGate(deps);
    gate.applied("user-1:token-1"); // a list was displayed earlier

    const joined = gate.join(LINK);
    assert.equal(joined.ok, false, `${name}: no session -> refuse`);
    assert.equal(joined.reason, "no-session");
    assert.deepEqual(state.opens, [], `${name}: nothing is opened`);

    const copied = await gate.copy(LINK);
    assert.equal(copied.ok, false);
    assert.equal(copied.reason, "no-session");
    assert.deepEqual(state.copies, [], `${name}: the clipboard fallback is never reached`);

    assert.equal(state.clears, 2, `${name}: the private links are dropped`);
    assert.equal(state.invalidations, 2, `${name}: the in-flight load is retired`);
    assert.deepEqual(state.refusals.map((r) => r.reason), ["no-session", "no-session"]);
  }
});

test("a scope change (user or token) refuses the action against the applied list", async () => {
  const { onlineMeeting } = await loadPages();
  const LINK = "https://zoom.us/j/123456789";
  let scope = "user-1:token-1";
  const { deps, state } = gateHarness({ readScope: () => scope });
  const gate = onlineMeeting.createMeetingActionGate(deps);

  gate.applied(scope); // the displayed list belongs to user-1:token-1

  scope = "user-1:token-2"; // token rotated for the same user
  const rotated = gate.join(LINK);
  assert.equal(rotated.ok, false);
  assert.equal(rotated.reason, "scope-changed");
  assert.deepEqual(state.opens, []);
  assert.equal(state.clears, 1);
  assert.equal(state.invalidations, 1);

  scope = "user-2:token-2"; // a different user signed in
  assert.equal(gate.authorize(LINK).reason, "scope-changed");
  assert.deepEqual(state.opens, [], "still nothing opened");
});

test("a link that is no longer in the applied list is refused without clearing the list", async () => {
  const { onlineMeeting } = await loadPages();
  const LISTED = "https://zoom.us/j/listed";
  const { deps, state } = gateHarness({ isMember: (link) => link === LISTED });
  const gate = onlineMeeting.createMeetingActionGate(deps);
  gate.applied("user-1:token-1");

  const decision = gate.join("https://zoom.us/j/removed");

  assert.equal(decision.ok, false);
  assert.equal(decision.reason, "not-in-list");
  assert.deepEqual(state.opens, [], "a link no longer on screen is never opened");
  assert.equal(state.clears, 0, "membership is not a session problem: the list stays");
  assert.equal(state.invalidations, 0);
  assert.equal(gate.join(LISTED).ok, true, "the still-listed link remains actionable");
});

test("the action gate refuses everything until a list has been applied", async () => {
  const { onlineMeeting } = await loadPages();
  const { deps, state } = gateHarness();
  const gate = onlineMeeting.createMeetingActionGate(deps);

  const decision = gate.join("https://zoom.us/j/123456789");
  assert.equal(decision.ok, false);
  assert.equal(decision.reason, "scope-changed");
  assert.deepEqual(state.opens, []);

  // clear() (load in flight / list dropped) puts the gate back in that state.
  gate.applied("user-1:token-1");
  assert.equal(gate.authorize("https://zoom.us/j/123456789").ok, true);
  gate.clear();
  assert.equal(gate.authorize("https://zoom.us/j/123456789").reason, "scope-changed");
});

test("an unsafe link is refused by the gate before any open or copy", async () => {
  const { onlineMeeting } = await loadPages();
  const UNSAFE = "javascript:alert(1)";
  const { deps, state } = gateHarness();
  const gate = onlineMeeting.createMeetingActionGate(deps);
  gate.applied("user-1:token-1");

  assert.equal(gate.join(UNSAFE).reason, "unsafe-url");
  assert.equal((await gate.copy(UNSAFE)).reason, "unsafe-url");
  assert.deepEqual(state.opens, []);
  assert.deepEqual(state.copies, []);
  // Not a session problem: the displayed list is kept.
  assert.equal(state.clears, 0);
});

// ---------------------------------------------------------------------------
// 8. createMeetingsScopeWatcher — a session change AFTER the list is on screen
// ---------------------------------------------------------------------------
const fakeEventTarget = () => {
  const listeners = new Map<string, Set<(event: unknown) => void>>();
  return {
    addEventListener(type: string, handler: (event: unknown) => void) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type)!.add(handler);
    },
    removeEventListener(type: string, handler: (event: unknown) => void) {
      listeners.get(type)?.delete(handler);
    },
    dispatch(type: string, event: unknown = {}) {
      for (const handler of Array.from(listeners.get(type) ?? [])) handler(event);
    },
    count(type: string) {
      return listeners.get(type)?.size ?? 0;
    },
  };
};

test("the scope watcher clears the rows exactly once per session change", async () => {
  const { onlineMeeting, studentMeetings } = await loadPages();
  const copies: Array<[string, MeetingCopy]> = [
    ["OnlineMeeting", onlineMeeting],
    ["StudentMeetings", studentMeetings],
  ];

  for (const [name, copy] of copies) {
    const win = fakeEventTarget();
    const doc = fakeEventTarget();
    let scope: string | null = "user-1:token-1";
    let changes = 0;
    const watcher = copy.createMeetingsScopeWatcher({
      readScope: () => scope,
      onScopeChange: () => { changes += 1; },
      getWindow: () => win as unknown as Window & typeof globalThis,
      getDocument: () => doc as unknown as Document,
    });

    watcher.start();
    assert.equal(changes, 0, `${name}: starting is not a change`);
    assert.equal(win.count("focus"), 1, `${name}: focus listener attached`);
    assert.equal(win.count("storage"), 1, `${name}: storage listener attached`);
    assert.equal(doc.count("visibilitychange"), 1, `${name}: visibility listener attached`);

    win.dispatch("focus"); // same scope -> nothing
    assert.equal(changes, 0, `${name}: an unchanged scope is not a change`);

    scope = "user-1:token-2"; // token rotated in another tab
    win.dispatch("focus");
    assert.equal(changes, 1, `${name}: the change is detected once`);

    doc.dispatch("visibilitychange"); // already handled -> no repeat
    assert.equal(changes, 1, `${name}: no duplicate notification`);

    win.dispatch("storage", { key: "some-unrelated-key" }); // ignored
    assert.equal(changes, 1, `${name}: unrelated storage writes are ignored`);

    scope = null; // signed out in another tab
    win.dispatch("storage", { key: "authToken", newValue: null });
    assert.equal(changes, 2, `${name}: a session-key change is detected`);

    watcher.stop();
    assert.equal(win.count("focus"), 0, `${name}: listeners removed on stop`);
    assert.equal(win.count("storage"), 0);
    assert.equal(doc.count("visibilitychange"), 0);
    win.dispatch("focus");
    assert.equal(changes, 2, `${name}: no callback after stop`);
  }
});

test("a session change clears the rows and invalidates the in-flight load", async () => {
  const { onlineMeeting } = await loadPages();
  const win = fakeEventTarget();
  const pending = deferred<string[]>();
  let scope: string | null = "user-1:token-1";
  const applied: string[][] = [];
  let rows: string[] = ["private-join-link"];
  let errors: string[] = ["previous error"];

  const loader = onlineMeeting.createMeetingsLoader<string>({
    request: () => pending.promise,
    readIdentity: () => "user-1",
    readScope: () => scope,
    onClear: () => { rows = []; errors = []; },
    onApply: (items) => applied.push(items),
    onError: () => {},
  });

  const gate = onlineMeeting.createMeetingActionGate({
    readScope: () => scope,
    isMember: () => true,
    clearLinks: () => { rows = []; errors = []; },
    invalidateLoad: () => loader.invalidate(),
  });
  gate.applied(scope);

  // The page's onScopeChange wiring.
  const watcher = onlineMeeting.createMeetingsScopeWatcher({
    readScope: () => scope,
    onScopeChange: () => {
      rows = [];
      errors = [];
      gate.clear();
      loader.invalidate();
    },
    getWindow: () => win as unknown as Window & typeof globalThis,
  });
  watcher.start();

  const load = loader.load(); // in flight under user-1:token-1
  scope = null; // signed out while the load was pending
  win.dispatch("focus");

  assert.deepEqual(rows, [], "the private links are dropped on the session change");
  assert.deepEqual(errors, []);
  assert.equal(gate.authorize("private-join-link").reason, "no-session");

  pending.resolve(["private-join-link"]); // the late response lands
  await load;
  assert.deepEqual(applied, [], "the retired load cannot repopulate the links");
  assert.deepEqual(rows, []);
});

test("the session guard retires the in-flight load and clears rendered links on a same-document session change", async () => {
  const { onlineMeeting, studentMeetings } = await loadPages();
  const copies: Array<[string, MeetingCopy]> = [
    ["OnlineMeeting", onlineMeeting],
    ["StudentMeetings", studentMeetings],
  ];

  for (const [name, copy] of copies) {
    const pending = deferred<string[]>();
    let scope: string | null = "user-1:token-1";
    const applied: string[][] = [];
    let rows: string[] = ["private-join-link"];
    let errors: string[] = ["previous error"];

    const loader = copy.createMeetingsLoader<string>({
      request: () => pending.promise,
      readIdentity: () => "user-1",
      readScope: () => scope,
      onClear: () => { rows = []; errors = []; },
      onApply: (items) => applied.push(items),
      onError: () => {},
    });

    const unsubscribe = copy.createMeetingSessionGuard({
      getLoader: () => loader,
      clearRenderedMeetings: () => { rows = []; errors = []; },
    });

    const load = loader.load(); // in flight under user-1:token-1
    // A logout completed in THIS document notifies through the real bus
    // after the whole mutation (supervisor/026): the subscriber must react
    // before the late response can commit.
    notifySessionChange("logout");

    assert.deepEqual(rows, [], `${name}: rendered private links are cleared on the notification`);
    assert.deepEqual(errors, []);

    pending.resolve(["private-join-link"]); // the late response lands
    await load;
    assert.deepEqual(applied, [], `${name}: the retired load cannot repopulate the links`);
    assert.deepEqual(rows, []);

    unsubscribe();
    notifySessionChange("login"); // a change after unmount must never reach the view
    assert.deepEqual(rows, [], `${name}: an unmounted subscriber never reacts`);
  }
});

test("the session guard reacts to a token rotation and a space switch, not to nothing", async () => {
  const { onlineMeeting } = await loadPages();
  const pending = deferred<string[]>();
  let scope: string | null = "user-1:token-1";
  const applied: string[][] = [];
  let rows: string[] = ["private-join-link"];

  const loader = onlineMeeting.createMeetingsLoader<string>({
    request: () => pending.promise,
    readIdentity: () => "user-1",
    readScope: () => scope,
    onClear: () => { rows = []; },
    onApply: (items) => applied.push(items),
    onError: () => {},
  });

  const unsubscribe = onlineMeeting.createMeetingSessionGuard({
    getLoader: () => loader,
    clearRenderedMeetings: () => { rows = []; },
  });

  // Control: with no session change the load commits normally (the loader
  // itself clears the rendered rows while loading — that is its own stale
  // protection, not a session reaction).
  const committed = loader.load();
  pending.resolve(["private-join-link"]);
  await committed;
  assert.deepEqual(applied, [["private-join-link"]], "no notification: the load commits normally");

  // A token rotation (selectStudentSpace) is a session change.
  const rotated = deferred<string[]>();
  const loader2 = onlineMeeting.createMeetingsLoader<string>({
    request: () => rotated.promise,
    readIdentity: () => "user-1",
    readScope: () => "user-1:token-2",
    onClear: () => { rows = []; },
    onApply: (items) => applied.push(items),
    onError: () => {},
  });
  unsubscribe();
  const unsubscribe2 = onlineMeeting.createMeetingSessionGuard({
    getLoader: () => loader2,
    clearRenderedMeetings: () => { rows = []; },
  });

  const load2 = loader2.load();
  notifySessionChange("token");
  assert.deepEqual(rows, [], "a token rotation clears the rendered links and retires the load");

  rotated.resolve(["private-join-link"]);
  await load2;
  assert.deepEqual(applied, [["private-join-link"]], "only the pre-rotation load committed");
  unsubscribe2();
});
