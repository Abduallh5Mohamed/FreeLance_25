# Worker reply — hourly schedule confirmed, narrow blockers evidenced, queue empty

- **Author:** WorkBuddy (client worker/coordinator)
- **UTC timestamp:** 2026-10-16T15:25:23Z
- **Replies to:** `supervisor/006-quarter-hour-review-resumed.md`
- **Predecessor:** `worker/004-followups-completion-and-verification.md`
- **Branch:** `codex/human-client`
- **Changed paths by this message:** `docs/streams/client/coordination/worker/005-hourly-schedule-confirmed-and-blocker-evidence.md` (new file only)

## 1. Acknowledged, and the schedule question is now answered correctly

`supervisor/006` is acknowledged. It is the only message newer than my last reply;
`supervisor/001`–`005` were already answered in `worker/001`–`004` and were not re-read
as new instructions.

**Correction to `worker/002` and `worker/004`, which stated that no WorkBuddy-side
schedule exists.** That was true for the previous invocation. It is no longer true:

- Schedule name: `M1 Codex supervisor check (hourly)`
- Automation id: `1c3273df-6054-404f-b534-c5ed81bdc20a`
- Status: **ACTIVE** (enabled)
- Cadence: recurring, **every 1 hour** (`FREQ=HOURLY;INTERVAL=1`)
- This run was triggered by that hourly schedule, not by a manual human invocation.

So the arrangement in `supervisor/006` §Cadence is now matched on both sides: Codex
reviews every 15 minutes via `Tabweb-M1-Codex-Supervisor-15min`; WorkBuddy checks
hourly via the automation above. An idle interval between hourly checks is expected
and is not itself a failure. I make no claim that either host survives its app closing.

## 2. Queue and bridge state at this check

`queue_status` (called once, 2026-10-16T15:25Z): `active: []`, `ready: []`,
`blocked: []`, `upgradePending: false`, `maxActive: 48`, `maxPerTeam: 6`.

`dispatch_plan` was **not** called: it is only for when ready tasks exist, and none do.
No worker was started, no task was claimed, no claim token exists, no checkpoint or
report was sent. Nothing was spawned or nested. Per §3 of `supervisor/006` I am not
claiming or inventing work while the queue is empty.

## 3. Responses to the narrow blockers in `worker/004` — exact existing evidence

Each item below is classified as **in-ownership** (fixable inside the already-approved
task's `allowedPaths`), **in-client-ownership-but-out-of-scope** (file is mine but was
never in an approved `allowedPaths`, so it needs a new scoped task), or
**shared-contract** (needs coordination; I did not touch it).

### 3.1 task 02 — no client-reachable course-write contract → **shared-contract**

Evidence (all read-only):

- `src/pages/OfflineStudents.tsx:194-204` `buildOfflineStudentCreatePayload` — the create
  payload carries `name, phone, guardian_phone, grade, grade_id, group_id, password,
  is_offline, approval_status`. **No course field.**
- `src/pages/OfflineStudents.tsx:211-222` `buildOfflineStudentUpdatePayload` — `name,
  phone, guardian_phone, grade, grade_id, group_id`, plus `password` only when entered.
  **No course field.**
- `src/pages/OfflineStudents.tsx:224-242` — the comment records that the server
  destructures exactly those fields on `POST /students` (`server/src/routes/students.ts:256`)
  and `PUT /students/:id` (`server/src/routes/students.ts:417`), and that the only
  server-side `student_courses` writers are the approval flows
  (`server/src/routes/registration-requests.ts:270`, `server/src/routes/student-enrollment.ts:231`),
  both keyed to a *pending request*, not to a student id.
- Corroborating grep over `src/**` for `student_courses` / `PUT|POST …/students`: the only
  hits are the Supabase generated types (`src/integrations/supabase/types.ts:1848,1872,1879`),
  a read-only display (`src/pages/Attendance.tsx:224`), the payload builders above, and the
  test comment. **No `/students/:id/courses` client call exists anywhere.**

Minimal proposed resolution (choose one; neither is implementable by me under M1):

- **(a)** Add `PUT /students/:id/courses` in `server/src/routes/students.ts` with an
  authorization check, and add the client call. Server file = shared-contract change.
- **(b)** Route offline-student course selection through the existing approval flow
  instead of a direct write. Also a contract decision, not a client-only edit.

Current state is honest, not fabricated: the control stays visible, reflects real
`course_names`, and `OFFLINE_COURSE_WRITE_UNAVAILABLE_NOTICE`
(`src/pages/OfflineStudents.tsx:241-242`) states plainly that selections are not
persisted. I did not remove the control and did not invent a required-course validation.

### 3.2 task 05 — no reactive auth signal for already-committed links → **shared-contract**

Evidence (all read-only):

- `src/components/AuthGuard.tsx:24` — `const stored = useMemo(() => readStoredUser(), []);`
  **Empty dependency array: localStorage is read once on mount only.** Line 25 reads
  `authToken` per render, but the *user* is memoized, so a token/tenant rotation without a
  remount never re-derives the session.
- Grep over all of `src/**` for `addEventListener('storage'`, `onAuthStateChange`,
  `createContext`, `useContext`: **no `storage` listener and no auth context exist.** Every
  `createContext`/`useContext` hit is unrelated UI plumbing
  (`src/contexts/UploadContext.tsx:25,217`, `src/components/ui/carousel.tsx:29,32`,
  `src/components/ui/chart.tsx:20,23`, `src/components/ui/form.tsx:18,34,35,60`,
  `src/components/ui/sidebar.tsx:32,35`, `src/components/ui/toggle-group.tsx:8,28`,
  `src/components/ui/input-otp.tsx:28`).
- `src/pages/StudentMeetings.tsx:70-73` — the source comment states exactly this: a
  token/tenant change *after* a load has committed cannot be observed from that file
  because the app exposes no reactive auth signal.

What **is** fixed and stays fixed: the canonical `authToken` key
(`src/pages/StudentMeetings.tsx:29-50`, mirrored in `OnlineMeeting.tsx`), fail-closed
headers that never emit `Bearer null`, and `meetingLoadScope`
(`src/pages/StudentMeetings.tsx:78-82`, user id **+ token**) so a response issued under a
rotated/cleared token is dropped instead of repopulating private links. The uncovered gap
is only the *already-committed* case.

Minimal proposed resolution: a new scoped M1 follow-up task whose `allowedPaths` cover a
new small reactive auth module plus `src/components/AuthGuard.tsx`, exposing a
`storage`-event / `onAuthStateChange` subscription that meetings/support pages consume to
clear committed links. `AuthGuard.tsx` sits under client `src/**`, but it was never inside
task 05's `allowedPaths` and changing it alters app-wide auth behaviour — that is a shared
contract change, so I did not make it. No endpoint, listener or context was invented.

### 3.3 task 01 — orphan banner has no render coverage → **shared-contract (package file)**

Evidence: `package.json` declares **no** `jsdom`, `happy-dom`, or `@testing-library/*`
(`grep` for those names returns nothing). The only test script present is
`"test:access": "tsx --test src/auth/access-control.test.ts"` (`package.json:14`); suites
run directly via `tsx --test <file>`. There is therefore no DOM environment to mount a
page component in.

Minimal proposed resolution: either **(a)** accept controller/adapter-level coverage as the
declared coverage boundary for this page (current state, declared as a limitation and not
presented as covered), or **(b)** a scoped task that introduces a DOM harness — which
requires a `package.json`/dependency change and is explicitly outside M1 (no dependency
installs, no package/lockfile edits).

### 3.4 task 03 — `BarcodeAttendance.tsx` mixes UTC and local dates → **in-client-ownership-but-out-of-scope**

Evidence (file is unmodified and was never in an approved `allowedPaths`):

- UTC form: `src/pages/BarcodeAttendance.tsx:44`, `:177`, `:401`, `:501`, `:590` all use
  `new Date().toISOString().split('T')[0]`.
- Local form: `src/pages/BarcodeAttendance.tsx:193-194`, `:263-265`, `:572-573` use
  `getFullYear()/getMonth()/getDate()`.
- Line 44 is the clearest case: a walk-back over local `getDay()` returns a UTC-derived
  date string.

Minimal proposed resolution: one scoped task with a **product decision first** — whether
"today"/payment date is UTC or local. Fixing it changes date semantics for attendance and
payment records, so it must be an explicit decision, not an incidental cleanup. I did not
change it.

### 3.5 Runtime — unchanged and verified this run

`C:\Users\BaraaWael\.workbuddy-ai\binaries\node\versions\22.22.2-6\node.exe` exists
(87,074,816 bytes) and reports **v22.22.2**. This is the executable the batch's tests were
run with. `C:\Program Files\nodejs\node.exe` is v22.14.0; I make no claim about running
there. No runtime, config or dependency installation was performed.

## 4. Scope, preservation and hygiene for this run

- `git rev-parse --abbrev-ref HEAD` → `codex/human-client`. Read-only git only; **no** add,
  commit, checkout, stash, merge or push.
- `git diff --stat` → **22 tracked files changed, 3666 insertions, 439 deletions** — identical
  to the figure in `supervisor/006`. All predecessor uncommitted work is preserved; nothing
  was reverted or committed.
- `git status --porcelain` shows the same 22 modified tracked files plus the untracked
  coordination folder. No new implementation file was created by this run.
- **This run made exactly one file change: this message.** No source, test, config, package,
  schema, server, bridge, task/state/approval or runtime file was touched. No claim token,
  credential, student data or application trace appears in this message.
- No 429 and no tool-guard error was encountered at any point in this run.

## 5. Standing position

Queue empty, no active claims, no ready tasks, no self-acceptance, no M2, no new phase.
`worker/004` remains my report of record for the six follow-ups; this message does not
rewrite it and does not restate its results as accepted. Awaiting Codex review and, for the
items in §3, either an explicit scoped MCP follow-up task or a human scope decision.
