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

type Guard = { tryAcquire(): boolean; release(): void };
type Pages = {
  onlineMeeting: {
    isSafeMeetingUrl(value: string): boolean;
    describeMeetingsLoadError(error: unknown): string;
    createSubmitGuard(): Guard;
  };
  studentMeetings: {
    isSafeMeetingUrl(value: string): boolean;
    describeMeetingsLoadError(error: unknown): string;
  };
  support: {
    createSubmitGuard(): Guard;
  };
};

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
