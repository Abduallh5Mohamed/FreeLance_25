# Frontend handoff — support-session banner and impersonation UX

Audience: the frontend developer wiring the support-impersonation screens.
Server contract: `docs/contracts/IMPERSONATION-INTEGRATION.md` (normative).
Live evidence behind this handoff:
`docs/streams/server/IMPERSONATION-LIVE-VALIDATION-20261020.md`.
Branch: `codex/workbuddy-server`. Written 2026-10-20.

This document is a **UI contract only**. It does not change any server code and
does not authorise editing `src/public/index.html` or any other frontend file —
that work belongs to a separate approved task.

---

## 1. The model in one paragraph

A support agent (the **actor**) opens a session against a customer user (the
**effective target**). A second, different admin must **approve** it. Approval
returns a short-lived opaque **context token**. From then on, the actor's
browser sends that token on every request, and the server serves those requests
**as the target**, with the target's own roles, tenant and permissions. The
actor never becomes the target on the server side: the server keeps the two
identities separate and only ever exposes the target's data because the session
row says so. The UI's single most important job is to make that substitution
impossible to miss, and to make it impossible to perform by accident.

Two facts the UI must never confuse:

| Fact | Meaning | Where it comes from |
| --- | --- | --- |
| **Actor** | the human at the keyboard, the support agent | the authenticated login |
| **Effective target** | whose data the screen is showing | the session, server-resolved |

---

## 2. What the server gives you

Base path: `/api/platform/impersonation` (session management, always called with
the **actor's normal login** — never with a context header).

| Method | Path | Purpose | Success |
| --- | --- | --- | --- |
| `POST` | `/start` | open a pending request | `201` `{ id, status: 'pending_approval', approval_required: true, max_seconds, target_user_id, tenant_id, scope, reason, started_by, created_at }` |
| `POST` | `/:id/approve` | second admin activates it | `200` `{ …session, status: 'active', expires_at, impersonation_token }` |
| `POST` | `/:id/revoke` | end it immediately | `200` session projection with `status: 'revoked'` |
| `GET` | `/sessions` | the actor's recent sessions (max 50) | `200` array of session projections |

Session projection fields (snake_case, as returned):

```
id, started_by, approved_by, target_user_id, tenant_id, reason,
scope ('read' | 'write'), status ('pending_approval' | 'active' | 'revoked'),
expires_at, revoked_at, revoked_by, created_at
```

Start body:

```json
{ "target_user_id": "…", "tenant_id": "…",
  "reason": "at least 16 characters of justification",
  "scope": "read", "duration_seconds": 600 }
```

Rules the server enforces and the UI must reflect **before** submitting:

- the reason is mandatory, 16–1000 characters;
- `duration_seconds` is optional, defaults to 1800, hard-capped at 1800;
- `scope` defaults to `read`; `write` must be an explicit, separate choice;
- a support actor cannot target themselves (`400`);
- platform administrators cannot be impersonated (`403`);
- an already active session for the same target is refused (`409`);
- rate limits: 5 starts and 10 approvals per actor per 10 minutes (`429`).

**The context token is the `impersonation_token` string.** The UI treats it as
an opaque credential. It is not a JWT, it has no readable claims, and nothing in
the UI may parse it.

---

## 3. Sending the context

Header name: `x-impersonation`. Value: the `impersonation_token` exactly as
received.

Hard rules:

1. **In memory only.** Keep it in a module/session-scoped variable (or a
   `sessionStorage` entry if the product requires surviving a reload — never
   `localStorage`, never a cookie, never IndexedDB).
2. **Never in a URL.** Not in query strings, not in hash fragments, not in
   `Referer`-carrying links, not in share links.
3. **Never logged.** No `console.log`, no analytics event, no error-reporting
   payload, no screenshot tooling that serialises request headers.
4. **Only on the surfaces that accept it.** Do not attach it to
   `/api/platform/**`, `/api/auth/**`, upload/download URLs, payment or export
   calls — those are denied by design and attaching the header only produces
   noise.
5. **Never send it with a different login.** The server refuses a context whose
   actor is not the bearer (`actor_mismatch`), so after a re-login or a user
   switch the token must be discarded, not reused.

---

## 4. The banner (the core requirement)

While a context is active, **every screen** shows a persistent support banner.
Not a toast. Not a dismissible notice. Not a modal that can be lost.

### 4.1 Required content

| Slot | Value | Notes |
| --- | --- | --- |
| Mode label | "وضع الدعم" / "Support mode" | must be visually distinct from normal chrome (fixed bar, high contrast, distinct colour) |
| Actor | display name + id of `started_by` | who is doing this |
| Effective target | display name + id of `target_user_id` | whose data is on screen |
| Tenant | name + id of `tenant_id` | which workspace is being shown |
| Scope | `read` or `write` | `read` should read as "عرض فقط / view only" |
| Expiry | local time + live countdown from `expires_at` | see §6 — the server is the authority, the clock is a hint |
| Session id | `id` | short form is fine; needed for support tickets |
| Exit | an explicit, always-visible button | see §7 |

The banner must remain visible on scroll, in full-screen views, in drawers and
in print/PDF export headers. If the layout cannot host a top bar, it must be
reproduced in a fixed region that cannot be collapsed.

### 4.2 Where the banner facts come from

The server does not echo banner facts on business responses today. The UI keeps
them from the two moments it already has:

- `POST /:id/approve` → the full session projection plus `expires_at` and the
  token: store `id`, `started_by`, `target_user_id`, `tenant_id`, `scope`,
  `expires_at` together with the token, as one atomic "active context" object;
- `GET /sessions` → for restoring the banner after a reload, match on the
  session id and require `status === 'active'` before restoring anything.

If the stored context object is incomplete, the UI must **not** show a partial
banner and must **not** send the token. Drop the context and require a fresh
approval.

### 4.3 Human-readable names

The projection carries ids only. Resolve display names through the normal
profile endpoints **while the context is active** (they are reads and are
allowed), and cache them alongside the context. Never substitute the actor's own
name for the target's — a banner that shows the wrong human is worse than no
banner.

---

## 5. Scope, as the UI must present it

- `read` — view-only. Every mutation must be visibly disabled (not merely fail
  on click), with a tooltip/inline note: "غير متاح أثناء وضع الدعم للعرض فقط".
  The server will also refuse with `403 IMPERSONATION_SCOPE` /
  `protection: 'read_only'`; the disabled state is the courtesy, the server
  response is the guarantee.
- `write` — the server currently **still denies** mutations
  (`mutation_not_enabled`) because no business route has opted in yet. Until a
  release note says otherwise, treat every mutation as unavailable regardless of
  scope, and never present `write` as "full access".

The UI must never derive, widen or request a scope from the client side. The
scope is fixed at start, re-checked against the live row on every request, and a
signed/live mismatch is denied (`row_mismatch`).

---

## 6. Expiry — and a warning you must design around

`expires_at` is announced by the approve response as a UTC instant. **As of this
writing the persisted value is wrong by two hours in the deployed
configuration** (see the validation record, section 8), so a freshly approved
session can be reported as already expired by the server.

Frontend implications, all mandatory:

1. **The server is the only authority.** The countdown is a hint; the first
   `403 IMPERSONATION_INVALID / expired` is the truth.
2. Show the expiry as a countdown **and** an absolute local time.
3. Warn at ≤ 5 minutes and ≤ 1 minute remaining, with a "طلب تمديد" affordance
   that starts a **new** session (there is no extend endpoint; the UI must not
   invent one).
4. When the countdown reaches zero, or a request returns `expired`, end the
   context **immediately** and locally: clear the token, clear the stored
   context, remove the banner, return to the actor's own identity, and show a
   clear message. Do not retry the failed request with the same token, and do
   not silently fall back to the actor's identity while keeping the banner up.
5. Never extend, refresh or re-sign a token in the browser. There is no
   client-side renewal path.

---

## 7. Exiting the context

There are exactly three ways out, and all three must do the same cleanup:

| Trigger | Behaviour |
| --- | --- |
| The user presses **"إنهاء وضع الدعم"** | `POST /:id/revoke` with the actor's normal login (no context header), then run the full cleanup below |
| The context becomes unusable (expired / revoked / denied) | no server call needed; run the full cleanup below |
| Tab/window close or a full navigation away | drop the in-memory token; on next load, restore only from `GET /sessions` with `status === 'active'` |

Full cleanup, in this order:

1. clear the in-memory token and the stored context object;
2. clear any cached target profile/tenant names gathered for the banner;
3. remove the banner;
4. reset all client-side query caches / stores that were populated while
   impersonating (otherwise the target's data lingers in the actor's own
   session — this is the most common real-world leak);
5. navigate to a neutral surface and re-fetch as the actor.

If `revoke` fails (network, `500`), the UI must **still** perform steps 1–5 and
tell the user the session may remain active server-side until it expires, with
the session id so support can follow up. Never keep a token in the browser
because the revoke call failed.

---

## 8. The UI never grants permission

Non-negotiable:

- The client never decides who may impersonate whom. Whether the current user
  may start, approve or revoke is a server decision
  (`impersonation.start` / `.approve` / `.manage`, resolved from server rows on
  every request).
- Hiding or showing a button is a **convenience**, never a control. Every
  action must still be attempted against the server and its answer honoured.
- No client-side "approve my own request" shortcut. The server refuses
  self-approval (`403`) and the UI must not offer it — the approve screen must
  not list the requester as a possible approver.
- No client-side scope escalation, no client-side tenant switch, no "act as"
  flag that the server does not verify.
- No role or permission values taken from a token, a cookie or a cached profile
  for the purpose of enabling a privileged action.
- No "remember this impersonation" convenience that re-establishes a context
  without a fresh start + approve.

---

## 9. Denial handling — every code, mapped

The enforcement middleware answers `403` (or `401`) with
`{ error, code, reason, protection? }`. Branch on `code` **and** `reason`, never
on `error` text.

| `code` | `reason` | What it means | UI behaviour |
| --- | --- | --- | --- |
| `IMPERSONATION_UNAUTHENTICATED` | `unauthenticated` | the request carried a context but no valid login | drop the context, force re-login |
| `IMPERSONATION_INVALID` | `malformed` | the stored token is corrupt | drop the context (storage bug — log a diagnostic **without** the token) |
| `IMPERSONATION_INVALID` | `signature` | token not signed by this server (wrong environment, stale build) | drop the context, show "الجلسة غير صالحة" |
| `IMPERSONATION_INVALID` | `not_active` | revoked or never active | drop the context, return to actor identity |
| `IMPERSONATION_INVALID` | `expired` | expired | drop the context, offer a new request |
| `IMPERSONATION_INVALID` | `row_mismatch` | signed scope disagrees with the live row | drop the context, report as a server-side inconsistency |
| `IMPERSONATION_INVALID` | `store_error` | verification could not read the session | keep the banner, show a retryable error, do **not** silently fall back |
| `IMPERSONATION_DENIED` | `actor_mismatch` | the context belongs to a different login | drop the context immediately (possible token reuse) |
| `IMPERSONATION_DENIED` | `tenant_mismatch` | the actor's tenant does not match the session tenant, or the target left the tenant | drop the context |
| `IMPERSONATION_DENIED` | `actor_permission_revoked` | the actor lost `impersonation.start` | drop the context, show "تم سحب صلاحية الدعم" |
| `IMPERSONATION_DENIED` | `actor_permission_unavailable` | permission lookup failed | keep the banner, retryable error; never fail open |
| `IMPERSONATION_DENIED` | `target_identity_unavailable` | the target was deactivated or deleted | drop the context, tell the user the customer account is no longer usable |
| `IMPERSONATION_DENIED` | `management_namespace` | a context tried to manage sessions | programming error — drop the context and log a diagnostic |
| `IMPERSONATION_DENIED` | `parent_path` | a context hit the parent surface | programming error — never attach the header there |
| `IMPERSONATION_SCOPE` | `path_denied` | surface is always denied while impersonating (platform, auth, exports, files, wallet, fees, subscriptions, audit logs, search) | show "غير متاح أثناء وضع الدعم", keep the context |
| `IMPERSONATION_SCOPE` | `path_not_allowed` | path is outside the read allowlist | same as above |
| `IMPERSONATION_SCOPE` | `mutation_not_enabled` | mutations are not enabled under a context yet | disable the control, explain |
| `IMPERSONATION_BLOCKED` | `read_only` / `password_change` / `mfa_change` / `money_movement` / `data_delete` (in `protection`) | protected action attempted under a context | block permanently, never retry |

Read allowlist (context requests may read only these prefixes):
`/api/courses`, `/api/lectures`, `/api/materials`, `/api/attendance`, `/api/exams`,
`/api/exam-results`, `/api/grades`, `/api/groups`, `/api/schedules`,
`/api/assignments`, `/api/gradebook`, `/api/students`, `/api/notifications`,
`/api/messages`.

Always denied: `/api/platform`, `/api/auth`, `/api/tenant-exports`, `/api/files`,
`/api/instructor-wallet`, `/api/fees`, `/api/payment-requests`,
`/api/subscriptions`, `/api/audit-logs`, `/api/search`, and the whole
`/api/parent` surface.

### Stale-context rule

If a request is denied with any reason in the "drop the context" column above,
the UI must treat the context as **gone**: clear it, remove the banner, reset
caches, and re-issue the request as the actor (or show a signed-out-of-support
state). It must never:

- retry the same request with the same token,
- show the target's cached data under the actor's chrome,
- keep the banner visible while the requests are actually running as the actor.

---

## 10. Anti-patterns (review checklist)

Reject a PR that does any of these:

- banner rendered only on the "impersonation" page instead of globally;
- banner that can be dismissed, minimised to nothing, or hidden by a CSS class
  toggle the user controls;
- token in `localStorage`, a cookie, a query parameter or an analytics event;
- token logged in an error boundary or a network-inspector helper;
- "act as" implemented by swapping a role claim or a header the server does not
  verify;
- approve button rendered for the requester;
- scope selector in the UI;
- silent fallback to the actor's identity while the banner stays up;
- retry loop on `expired` / `not_active`;
- cached target data left in the actor's store after exit;
- any client-side check presented as an authorization guarantee.

## 11. Acceptance checklist for the frontend task

1. Start → pending screen shows reason, scope, target, tenant, and the fact that
   a **different** admin must approve.
2. Approve → banner appears **before** any target data renders; no flash of the
   actor's own data under the target's context.
3. Banner shows actor, effective target, tenant, scope, session id, expiry
   (countdown + absolute), and the exit button — on every route.
4. Reload → banner restored only from `GET /sessions` with `status === 'active'`;
   otherwise no banner and no token.
5. Exit → revoke called, token and caches cleared, banner gone, actor identity
   restored; also verified when `revoke` fails.
6. Force each denial reason in §9 (stub the response) → the UI performs the
   documented behaviour, in particular the "drop the context" cases.
7. Mutation attempt under a context → disabled in the UI **and** correctly
   handled if the server still refuses.
8. Nothing about the token appears in the DOM, in storage other than the chosen
   session-scoped slot, in URLs, or in console output.

---

## 12. Known server-side caveat to design around

The approval write path currently persists `expires_at` two hours behind the
instant it announces, so a freshly approved session is refused as `expired`
before any rule can run (validation record, section 8; reported, not fixed in
this task). Until that is corrected, expect `expired` on the very first request
after approval and make sure the UI degrades exactly as §6.4 requires instead of
showing a broken half-impersonated screen. Do not "fix" it on the client by
adding an offset — the client must never compensate for a server clock.
