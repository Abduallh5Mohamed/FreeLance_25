# M2-01 — Verified client contracts for the invitation / enrollment / student-space journeys

UTC: 2026-10-17. Branch `codex/human-client`. Task
`client-m2-01-enrollment-workflows-20261017-01`.

This document fixes the contracts the three pages under change actually
depend on, read from source BEFORE any behaviour change. Nothing here is
invented: every method, path, field, status and message below was read
from the cited file:line. Client code must use these contracts only and
must fail closed for anything not listed.

Sources read (read-only in this batch):

- `src/lib/api-http.ts` — shared HTTP client and the invitation /
  enrollment / spaces functions.
- `src/lib/session-events.ts` — same-document session notification bus.
- `server/src/routes/student-enrollment.ts` — join, requests, spaces,
  password reset, backfill review.
- `server/src/routes/tenant-invitations.ts` — tenant invitation redeem.
- `server/src/routes/students.ts` — `/students/me` scoped student profile.
- `server/src/routes/auth.ts` — `/me` (principal echo; not used by these
  pages).

---

## 0. Shared HTTP client contract (api-http.ts)

- Base URL: `VITE_API_URL` env or relative `/api` (api-http.ts:9-24).
- `Authorization: Bearer <authToken>` header only when a token exists in
  `localStorage.authToken` (api-http.ts:52-62).
- **Rejection shape:** a non-OK response throws
  `new Error(error.error || 'HTTP ' + status)` (api-http.ts:69-89). The
  HTTP **status code is NOT propagated** to callers — only the server's
  `error` message string. Client code therefore cannot branch on 4xx/5xx
  numerically; the server messages below are the contract surface.
- 403 with `code: 'BILLING_ONLY'` rewrites the stored instructor identity
  to `billing_only` and redirects to `/instructor-subscription`
  (api-http.ts:71-84); 403 with `code: 'TENANT_SUSPENDED'` clears the
  session and redirects to `/auth` (api-http.ts:85-88). Neither code
  applies to the public/student flows in this batch.
- JSON bodies are `application/json` (api-http.ts:54-58). Success
  responses return the parsed JSON body; there is no other success
  signal.

### Session notification contract (session-events.ts)

- `notifySessionChange(kind)` with kind `'login' | 'token' | 'identity' |
  'logout' | 'scope'`; the event carries ONLY the kind — never a token,
  user or private link (session-events.ts:34-39, 62-73).
- `selectStudentSpace` is a canonical token writer: it persists the new
  scoped token via `setAuthToken` and notifies `'token'` AFTER the write
  (api-http.ts:2278-2286). A caller that then persists the selected
  identity notifies `'scope'` after its own write completes. The page
  under change keeps this order.
- `clearAuthToken` removes `authToken`, `currentUser`, `currentStudent`
  and notifies `'logout'` (api-http.ts:38-45).

---

## 1. AVAILABLE contracts

### 1.1 Invitation metadata — GET `/api/student-enrollment/join/:token`

Client: `getEnrollmentInviteInfo(token)` (api-http.ts:2254-2255), token
`encodeURIComponent`-escaped into the path.

Server: `student-enrollment.ts:78-95`, `rateLimit('student-join-view',
60, 15min)`.

- Principal: **public, no auth**. Query: none. Body: none.
- Token format enforced server-side: `/^[0-9a-f]{64}$/i`, not revoked,
  `expires_at > UTC_TIMESTAMP()`, tenant `status='active'`
  (student-enrollment.ts:24-32).
- **404** `{ error: 'Invitation is invalid or expired' }` for a missing,
  malformed, revoked or expired invitation — the server deliberately
  does not distinguish these (student-enrollment.ts:80).
- **429** from the view rate limit after 60 views / 15 min (message from
  the rate-limit middleware; no other failure mode exists on this route).
- Success **200** with `Cache-Control: no-store`:

  ```ts
  {
    business_name: string;
    subject_type: string | null;      // optional in the client type
    expires_at: string;               // server UTC datetime string
    grades: Array<{ id: string; name: string }>;        // active grades of the instructor's active groups
    groups: Array<{ id: string; name: string; grade_id: string; course_id: string | null }>;
    courses: Array<{ id: string; name: string; grade: string | null }>;
  }
  ```

- Null/empty: `subject_type` may be null; `grades`/`groups`/`courses` are
  `[]` when the instructor has no active groups; a group's `grade_id`
  references a grade that is only present in `grades` when active; the
  group's own `grade_id` is the authoritative link between group and
  grade (server: groups come first, grades/courses are derived from the
  groups, student-enrollment.ts:81-92).
- Expiry: invitation links live **30 days** from rotation and rotation
  revokes all older links of that instructor (student-enrollment.ts:35,
  44-52). A link that expires between page load and submit behaves like
  an invalid link on the next call.

### 1.2 Join request — POST `/api/student-enrollment/join/:token/requests`

Client: `submitEnrollmentRequest(token, data)` (api-http.ts:2256-2261),
body `{ student_name, phone, guardian_name, guardian_phone, password?,
grade_id, group_id, requested_courses? }` (strings; courses string[]).

Server: `student-enrollment.ts:97-161`,
`rateLimit('student-join-submit', 8, 60min)`, `optionalAuth`.

- Principal: anonymous, or an authenticated **student**. Query: none.
- Validation on the server (client must not invent its own):
  - invite valid (same rules as 1.1) else **404** `'Invitation is
    invalid or expired'`.
  - required non-empty: `student_name`, `guardian_name`, `phone`,
    `guardian_phone`, `grade_id`, `group_id` else **400** `'All student,
    guardian, grade and group fields are required'`.
  - anonymous submitter: `password` length 10..128 else **400**
    `'Password must be between 10 and 128 characters'`.
  - signed-in student whose normalized phone differs from the submitted
    phone: **400** `'Use the phone number of the signed-in student
    account'`.
  - group must exist, be active, belong to the invite's instructor and
    `group.grade_id` must equal `grade_id`: **400** `'Invalid grade or
    group'`.
  - signed-in non-student principal: **403** `'Only students can join an
    instructor'` (student-enrollment.ts:134).
- **Meaning of success — HTTP 202** with
  `{ message: 'إذا كانت البيانات صحيحة فسيظهر الطلب للمدرس للمراجعة.' }`
  (publicMessage, student-enrollment.ts:15, 131, 137, 143, 160). The
  server deliberately returns the SAME 202 for: a newly recorded
  request, a suppressed duplicate phone, an already-enrolled student and
  an already-pending request — no client state may distinguish them, and
  none of them is an approval. A successful join request means only:
  *the request is queued for the instructor's review; access remains
  pending-approval.* The instructor is notified (student-enrollment.ts:
  152-159); approval is a separate instructor-side call
  (`/requests/:id/approve`, student-enrollment.ts:175-250) outside this
  batch.
- `requested_courses` is capped at 50 unique ids server-side
  (student-enrollment.ts:107-108).
- **429** from the submit rate limit (8/hour). **500** is not a declared
  path on this route (the insert/enqueue path has no 500 branch).

### 1.3 Student spaces — GET `/api/student-enrollment/spaces`

Client: `getStudentSpaces()` (api-http.ts:2273).

Server: `student-enrollment.ts:271-281`, `authenticateToken`.

- Principal: authenticated **student** (the global token, before any
  space is chosen). **401** when the bearer token is missing/invalid/
  expired (middleware). **403** `'Student access required'` for any
  other role.
- Success **200** array (may be `[]`):

  ```ts
  Array<{
    student_enrollment_id: string;   // students.id
    tenant_id: string;              // tenants.id, tenant status must be 'active'
    business_name: string;
    grade_id: string | null;
    group_id: string | null;
    grade_name: string | null;      // LEFT JOIN, nullable
    group_name: string | null;      // LEFT JOIN, nullable
  }>
  ```

- Only rows with `is_active=1` and `approval_status='approved'` and an
  active tenant are returned; order by `business_name`. An empty array
  is a real, completed "no accepted membership" answer — the client must
  only show it AFTER the read completes.
- No pagination on this route; the row count is bounded by the
  principal's own enrollments.

### 1.4 Space selection (token rotation) — POST `/api/student-enrollment/spaces/:enrollmentId/select`

Client: `selectStudentSpace(studentEnrollmentId)`
(api-http.ts:2274-2287). Server: `student-enrollment.ts:283-297`.

- Principal: authenticated **student**. **401** on a bad token; **403**
  `'Student access required'` otherwise.
- The enrollment must belong to the principal, be active, approved, and
  its tenant active: otherwise **404** `'Student workspace not found'`
  (student-enrollment.ts:290).
- Success **200**: `{ token, tenant_id, student_enrollment_id }` — a
  scoped JWT (`type: 'student_scoped'`, claims `tenant_id`,
  `student_enrollment_id`, `instructor_id`, `group_id`, `grade_id`,
  `expiresIn` = `JWT_EXPIRES_IN` or `'7d'`, student-enrollment.ts:
  291-296).
- **The client side effect is part of the contract:** the function
  persists the returned token with `setAuthToken` and notifies
  `'token'` after the write (api-http.ts:2278-2286). After this point
  the previous token is gone server-recognised too (there is no
  revoke-old-token step; the old token simply ages out). A later failure
  in the same journey must never restore the old token; the server
  remains the source of truth for which space is active.

### 1.5 Scoped student profile — GET `/api/students/me`

Client: `getCurrentStudentEnrollment()` (api-http.ts:2288). Server:
`students.ts:110-124`, `authenticateToken`.

- Principal: the **scoped student token** issued by 1.4.
- **409** `{ error: 'Select an instructor workspace first', code:
  'STUDENT_SPACE_REQUIRED' }` when the token lacks
  `studentEnrollmentId`/`tenantId` (students.ts:111-113) — e.g. the
  global token, or a mismatched old/new scoped token.
- **404** `'Student enrollment not found'` when the scoped enrollment
  row is gone (students.ts:122).
- **401** when the token is invalid/expired (middleware).
- Success **200**: student row fields (`id`, `user_id`, `tenant_id`,
  `name`, `phone`, `guardian_name`, `guardian_phone`, `grade_id`,
  `group_id`, `barcode`, `approval_status`, `is_active`, `grade_name`,
  `group_name`, `business_name`) — the authoritative identity for the
  now-active space, to be persisted as `localStorage.currentStudent`.

### 1.6 Password-reset request — POST `/api/student-enrollment/join/:token/password-reset`

Client: `requestStudentPasswordReset(inviteToken, phone)`
(api-http.ts:2289-2292); body `{ phone }`.

Server: `student-enrollment.ts:300-318`,
`rateLimit('student-password-reset', 5, 60min)`.

- Principal: public (token-gated by the invite). **Always 202** with
  `{ message: 'إذا كان الحساب موجودًا فسيصل طلب الاسترجاع إلى المدرس.' }`
  — including when the invite is invalid or no enrollment matches
  (student-enrollment.ts:303-317). Success means only "if the account
  exists, the instructor received a request"; nothing more may be
  inferred client-side.
- Related instructor-side lifecycle (not used by the pages in this
  batch): approval issues a code valid **15 minutes**
  (`/password-resets/:id/approve`, student-enrollment.ts:330-347) and
  `/password-resets/complete` consumes it (10..128 chars,
  student-enrollment.ts:349-370).

### 1.7 Tenant invitation redeem — POST `/api/tenant-invitations/redeem`

Client: `redeemTenantInvitation(token, password)` (api-http.ts:399-400);
body `{ token, password }`.

Server: `tenant-invitations.ts:8-39`. **Principal: none** — this call
establishes the instructor credential from the emailed invitation.

- **400** `'Valid invitation token and password of at least 12
  characters are required'` when the token is not `/^[0-9a-f]{64}$/` or
  the password is not 12..128 chars (tenant-invitations.ts:11-13).
- **404** `'Invitation invalid or expired'` when no row matches
  `token_hash`, or `used_at` is set (single-use), or `expires_at` has
  passed, or the tenant is not active (tenant-invitations.ts:19-27).
- Success **200** `{ success: true }` after `users.password_hash` update
  + `is_active=1` and `used_at` marking in one transaction
  (tenant-invitations.ts:28-31). `{ success: true }` from the server is
  the ONLY success signal; the client must not infer activation from
  local state. **500** `'Failed to redeem invitation'` on server
  failure; no 429 on this route.
- The token arrives in the URL fragment (`#token=…`), is never sent
  anywhere except this call, and the page drops it from the URL with
  `history.replaceState` after a server-confirmed activation.

### 1.8 Not-available on these routes (documented gaps)

- **No OTP** endpoint exists; phone verification is out-of-band.
- **No online payment / checkout** endpoint exists; subscription and
  billing are handled by the separate instructor flows, not by
  enrollment or invitation redemption.
- **No 30-day entitlement** grant exists for students; enrollment stays
  **pending instructor approval** until `/requests/:id/approve`.
- `POST /backfill-reviews/:id/resolve` is **410 Gone** — legacy identity
  assignment is disabled server-side (student-enrollment.ts:384-387);
  no client flow may depend on it.
- 401/403 semantics above come from `authenticateToken`
  (`server/src/middleware/auth.ts`); rate-limit messages come from
  `server/src/middleware/rate-limit.ts`. Both were read but their exact
  response bodies are middleware-owned and are surfaced to the UI as the
  thrown message only.

---

## 2. UNBUILT spec-19 items (fail closed — do not invent)

From the approved M2-01 scope (docs/streams/client/M2-HANDOFF.md):

| Spec-19 item | Status in source | Client rule |
| --- | --- | --- |
| OTP sign-up/verification | No route, no client fn | Not implemented; phone/guardian fields are plain validated strings |
| Online payment / checkout for enrollment | No route, no client fn | Not implemented; enrollment never touches money |
| 30-day entitlement grant | Not part of enrollment; only invite link lifetime is 30 days (student-enrollment.ts:35, 50-51) | No entitlement may be shown or stored from client state |

Any flow that would need one of these must fail closed (show the
server's actual error) rather than simulate success.

## 3. M1 prerequisite evidence — honest scope

M1 acceptance (supervisor/039) is a **local scope** closure for the six
M1 client areas; it is not all-platform proof of API isolation, private
files, video or job/socket isolation (M2-HANDOFF §"عقود"). This batch
therefore makes no claim about those gates; it only pins the contracts
above and keeps the client inside them.

## 4. Mutation lifecycle invariants (supervisor/049 correction)

The loaders always carried a generation guard; the **mutations** did not.
Two production counterexamples (reproduced outside the repository at
`C:/Users/BaraaWael/TabwebClientSupervisor/049-m2-mutation-races.mts`)
showed a late mutation committing under a newer invitation/fragment:

1. load invite A → deferred submit A → load invite B → resolve A set
   `submitted: true` **under B**;
2. deferred activation A → fragment B + `syncToken` → resolve A marked
   **B** activated, after which the page wipes B's own URL fragment.

Invariants now enforced in `src/features/enrollment/workflows.ts`:

| Invariant | Mechanism |
| --- | --- |
| A mutation commits only for the token, generation and principal it captured **before** its first `await` | `isMutationCurrent(generation, token, principal)` in `submit` / `requestPasswordReset`; `disposed \|\| !sequence.isCurrent(generation) \|\| state.token !== token` in `activate` |
| A route change — **including an empty token** — retires every in-flight mutation | `loadInvite()` calls `retireInFlight()` (`sequence.invalidate()` + `guard.release()`) before anything else; an empty token patches `phase: 'incomplete'` and fires **no** request |
| A token/fragment lifecycle event always retires, even when the text is identical (A → B → A) | `syncToken()` invalidates unconditionally and resets a stranded `'activating'` back to `'form'` |
| A superseded operation never releases a **newer** operation's latch | ticket-scoped `guard.release(ticket)`; `guard.release()` without a ticket is the unconditional retire used only by the lifecycle paths |
| A mutation started under one identity does not commit after the identity changed | `readIdentity()` key captured with the mutation; `syncIdentity()` (called from the page's `subscribeSessionChange`) retires in-flight work |
| No identity is persisted into a session that is no longer ours | `hooks.readAuthToken()` must still return **exactly** the token this selection rotated to (api-http.ts:2278); otherwise `'scope'` is never notified, the identity is not committed and the profile-only retry is refused before it reads another session's profile (§5) |

`readIdentity` / `readAuthToken` are optional seams. Without them the two
identity boundaries cannot be evaluated and are **skipped rather than
guessed**; the pages always inject them, so production never skips.

Terminal `submitted` / `resetSent` are cleared by a **route** change (the
success belonged to another invitation) but kept across an **identity**
change: they are facts the server already accepted for that link, and
clearing them would invite a duplicate request under the new principal.

## 5. Session-ownership invariants (supervisor/051 correction)

Two production counterexamples (reproduced outside the repository at
`C:/Users/BaraaWael/TabwebClientSupervisor/051-m2-session-ownership.mts`)
showed that after a valid rotation to space A, once the session is replaced
by B and B persists its own identity, a late A profile — whether it
**succeeds** or **fails** — unconditionally removed B's `currentStudent` /
`currentStudentSpace`: `discardStoredIdentity()` deleted both keys without
asking who owned the session.

Invariants now enforced in `src/features/enrollment/workflows.ts`
(`createStudentSpacesController`):

| Invariant | Mechanism |
| --- | --- |
| A stale identity is discarded only while storage still holds the identity the selection began with | `select()` captures `baselineStudent` / `baselineSpace` synchronously (before any `await`); `discardStoredIdentity(baseline…)` removes + notifies `'identity'` **only** while BOTH keys still equal the baseline, otherwise it does nothing and returns `false` |
| A newer session's identity is never erased by an obsolete operation | once either key changed (B installed its own identity), the late success / failure / retry leaves storage untouched — it never notifies `'scope'`/`'identity'`, never navigates and never exposes a stale pending action |
| A genuine own-rotation profile failure still discards our own stale identity | while we own the session and the stored keys are still the pre-rotation baseline, the failed profile still removes them and keeps the profile-only retry (unchanged 049 behaviour) |
| An obsolete operation never COMMITS a previous identity into a foreign session | `commitIdentity` runs only after `isRotationTokenCurrent(rotation.token)` — the live token is exactly the one this selection rotated to |
| An obsolete operation is fenced without an invented abort transport | the profile retry is refused **before** the request when the token is not ours, and again **after** the `await` if it changed mid-flight; the in-flight profile read itself is not cancellable (the contract carries no abort) |

**Join silent-replacement boundary.** The cached identity key only follows the
same-document session bus (`syncIdentity`, driven by the page's
`subscribeSessionChange`), so a **silent** replacement — a storage write that
bypasses `notifySessionChange` — escapes the cached comparison. `join`'s
`isMutationCurrent` therefore re-reads the **actual** injected `readIdentity()`
at each `submit` / `requestPasswordReset` completion and commits only while it
still returns the captured principal; a silent replacement yields `'blocked'`
and leaves `submitted` / `resetSent` unmoved. No outside shared listener is
built — the existing injected reader at completion is the fence.

## 6. Session-recovery invariants (supervisor/054 correction)

A production counterexample (reproduced outside the repository at
`C:/Users/BaraaWael/TabwebClientSupervisor/054-m2-join-busy.mts`) showed that
after a silent identity replacement the obsolete `submit` / `requestPasswordReset`
returned `'blocked'` **before** clearing `busyKind`: the operation had settled,
but the page — which disables its controls from `busyKind`
(`src/pages/JoinInstructor.tsx`) — stayed busy forever. The cached principal
also stayed old, so a deliberate next operation could still be misclassified
as obsolete.

Invariants now enforced in `src/features/enrollment/workflows.ts`
(`createJoinInviteController`):

| Invariant | Mechanism |
| --- | --- |
| An obsolete operation settles into a HONEST non-busy state | the obsolete branch of `submit` / `requestPasswordReset` calls `retireObsoleteBusy(ticket)`, which clears `busyKind` — the page's controls are enabled again |
| Retiring a busy marker never clears a NEWER operation's state | the busy marker is owned by a guard ticket (`busyOwner`); it is cleared only while the retiring operation still owns it — the same fencing as the ticket-scoped `guard.release(ticket)` in the `finally` (049) |
| The actual principal is reconciled at every operation boundary | `submit` / `requestPasswordReset` re-read the injected `readIdentity()` at start (a replacement BEFORE the operation cannot misclassify it) and `retireObsoleteBusy` refreshes the cached principal on the obsolete path |
| A deliberate current-principal retry is allowed without a reload or a session-bus event | with the cache refreshed and the ticket-scoped latch released, the retry acquires the latch, captures the CURRENT principal and produces exactly one request |
| No automatic replay | an obsolete operation only retires its own state; nothing re-fires the superseded request |

A route change, `syncIdentity` (the bus-observed change) and `dispose()` keep
their earlier retiring behaviour (049/051) and remain the only unconditional
retires; terminal `submitted` / `resetSent` facts, form input retention and the
single-flight latch are unchanged.
