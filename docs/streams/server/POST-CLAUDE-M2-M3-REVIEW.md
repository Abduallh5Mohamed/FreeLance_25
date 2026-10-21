# Post-Claude M2/M3 verification and correction

Task: `post-claude-m2-m3-verify-correct-20261018-01` (team `media`, worker `wb-postclaude-m2m3-20261018-01`).
Branch `codex/workbuddy-server`, baseline HEAD `28288ed`.
Scope: re-verify F1–F11 from `docs/agent-reports/review-m2-m3.md` against the code that
exists at this HEAD (not against the review text), correct only defects that are
still open inside the approved `allowedPaths`, and record everything that needs a
different owner.

Method: every verdict below comes from reading the current source and from the
hermetic suites that drive the **real exported handlers/services** through injected
dependencies. No live database, no Docker, no network, no provider call was used.
"FIXED" means the mechanism that closes the finding is present in the current code
and is covered by a passing test; it is not a re-statement of a delivery note.

## Verdict summary

| id | verdict | closing mechanism (`file:line`) | covering test |
| --- | --- | --- | --- |
| F1 | FIXED before this task | Route never forwards a caller policy: `server/src/routes/playback-sessions.ts:97-104`. `acquireSlot` falls back to `getPolicy(tenantId)` when no policy is passed (`server/src/services/playback-session-registry.ts:263`), and every policy source is clamped to `PLAYBACK_POLICY_CEILINGS` (`:36-61`). SQL adapter reads the tenant row and clamps (`:523-547`). | `route: client-supplied policy is ignored and cannot raise limits (F1)`; `V5: normalizePlaybackPolicy clamps to server ceilings (F1)`; `sql store: tenant policy is read from the DB and clamped (F1)` |
| F2 | FIXED before this task | Non-privileged callers get `userId = user.id`; the `userId` query selector is only honoured for staff roles: `server/src/routes/playback-sessions.ts:345-349` (`GET /devices`) and `:412-416` (`GET /sessions`). Privileged callers keep the explicit filter. | `route: device/session listing ignores foreign userId for non-privileged callers (F2)` |
| F3 | PARTIALLY FIXED — issuance/verification closed, media-delivery wiring out of scope | Issuance now composes the same content-access policy and denies unpublished/out-of-audience (404) or not-yet-released/prerequisite (403): `server/src/routes/video-assets.ts:275-302`. The token is verified on the heartbeat path via `verifyPlaybackEntitlement` (`server/src/services/playback-entitlement.ts:165`, used at `video-assets.ts:370-379`). `server/src/routes/secure-video.ts` still does not present/verify an entitlement before serving bytes — that file is outside `allowedPaths`; see "Residual blockers". | `F3 issuance: the composed policy gates issuance (unpublished/out-of-audience 404, not-released 403)`; `F3 verify helper: matching binding allows and every mismatch/blank denies` |
| F4 | FIXED before this task | Real SQL adapters exist and are injected by the production export: `createSqlPlaybackSessionStore` (`server/src/services/playback-session-registry.ts:515`), `createSqlPlaybackProgressService` (`server/src/services/playback-progress.ts:387`), wired at `server/src/routes/playback-sessions.ts:497-508`. Slot acquisition/registration run on one pooled connection inside a transaction with `FOR UPDATE` (`playback-sessions.ts:452-482`). In-memory stores remain the test/default seam only. | `sql store: acquireSlot locks, counts and inserts in one transaction`; `sql store: registerDevice creates a row inside a transaction`; `sql store: recordProgress upserts and rejects non-monotonic writes` |
| F5 | FIXED before this task | Revocation requires record ownership, a verified tenant-admin capability, or a verified platform-admin capability: `server/src/routes/video-assets.ts:327-340`. Tenant admin is resolved from `tenants.owner_user_id` / active `tenant_memberships.role_key='owner'` (`:634-646`, `:719-725`). | `F5 revoke: a different enrollment in the same tenant cannot revoke`; `F5 revoke: a verified tenant admin may revoke; a platform admin may revoke cross-tenant` |
| F6 | FIXED before this task | The batch row is inserted first inside the transaction, then students, then the audit; a duplicate-key race re-reads the existing batch and returns it (`server/src/routes/student-import.ts:267-290`). Production injects a real single-connection transaction (`:451-471` over `db.withTransaction`), so a failed batch insert rolls back the student rows. | `commit: the whole import runs inside the injected transaction seam`; `commit: a losing duplicate-key batch race resolves to the existing batch and inserts no students`; `commit: a repeat of the same file hash is idempotent (200, no double import)` |
| F7 | FIXED before this task | Heartbeats require a server-issued entitlement bound to tenant/enrollment/lesson/session, so the dedupe key is derived from verified claims (`server/src/routes/video-assets.ts:366-387`). Delta is clamped to one window (`:381-384`), and a per-enrollment event rate limit plus aggregate cap return 429 (`:389-400`). | `F7 heartbeat: a token bound to another lesson/session cannot be replayed`; `F7 heartbeat: a client delta is clamped to one dedupe window (no inflation)`; `F7 heartbeat: a per-enrollment rate limit rejects a burst of distinct sessions`; `F7 heartbeat: the per-enrollment aggregate cap is enforced` |
| F8 | FIXED before this task | The body/query tenant-selector rule is exempted only for the two signature-verified callback paths; header selectors stay rejected everywhere: `server/src/middleware/tenant-authority-boundary.ts:13-19`, `:31-39`. | `F8 boundary: tenant selectors stay rejected on every non-callback path`; `F8 boundary: only the signature-verified callback paths tolerate a tenant selector`; `F8 boundary: the header selector stays rejected even on a callback path` |
| F9 | FIXED before this task | Production wiring passes only `VIDEO_PLAYBACK_SECRET` with no `JWT_SECRET` fallback (`server/src/routes/video-assets.ts:665-670`); a blank secret yields `secret-unavailable` and issuance fails closed (`server/src/services/playback-entitlement.ts:277-278`). | `F9 production wiring: playback tokens use a dedicated secret with no JWT fallback`; `F9 runtime: with only JWT_SECRET present, playback issuance fails closed` |
| F10 | FIXED before this task | Registration is deny-by-default at `>= maxDevices`: in-memory throws `PlaybackDeviceLimitError` (`server/src/services/playback-session-registry.ts:190-195`); SQL counts active devices under `FOR UPDATE` and throws (`:588-612`). The route maps it to 409 `device_limit` (`server/src/routes/playback-sessions.ts:86-93`). | `V5: device limit enforced at registration (F10)`; `route: device registration rejected past maxDevices (F10)`; `sql store: registerDevice rejects a new device past maxDevices (F10)` |
| F11 | FIXED before this task (file outside my write scope) | `PUT /releases/:lectureId` resolves the prerequisite and requires the same `tenant_id` and `course_id`, rejecting a self reference first: `server/src/routes/content-access.ts:673-689`. | `release config: a prerequisite from another course is rejected 400 with no write`; `release config: a prerequisite from another tenant is rejected 400 with no write`; `release config: a nonexistent prerequisite is rejected 400 with no write` |
| N1 (new) | **CORRECTED by this task** | Partial lifecycle updates merged the request with the stored row and never validated the merged half-open window, so a single-field update could persist `start >= end`. Fixed in `server/src/routes/student-enrollment.ts` (helper `enrollmentWindowIsValid`, check before UPDATE/audit). | `window: a merged window with start >= end is invalid (unit)`; `lifecycle: a start-date-only update that inverts the stored window is rejected with no write`; `lifecycle: an end-date-only update before the stored start is rejected with no write`; `lifecycle: a partial update that keeps the merged window valid still applies` |

Counts: 10 findings already fixed at HEAD, 1 partially fixed (F3, with the
remaining portion blocked by file scope), 1 new defect corrected here.

## N1 — what was wrong and what changed

`createEnrollmentLifecycleHandler` (`server/src/routes/student-enrollment.ts:817+`)
treats an absent field as "unchanged" and merges it with the stored row:

```
term: validated.value.term ?? existing.term
enrollment_start_date: validated.value.startDate ?? existing.enrollment_start_date
enrollment_end_date:   validated.value.endDate   ?? existing.enrollment_end_date
```

`validateEnrollmentLifecycleInput` only compares start/end when **both** are in the
same request, so a partial update could invert the effective window. The read
predicates are `start <= UTC_TIMESTAMP()` and `end > UTC_TIMESTAMP()`; an inverted
window can never satisfy both, so the enrollment silently becomes permanently
inactive while `enrollment_status` still reads `active`. That is a data-integrity
and support-burden defect, not a cosmetic one.

Change (minimal, no contract change):

- Added `enrollmentWindowIsValid(start, end)` — normalizes `Date`/`YYYY-MM-DD`/
  `YYYY-MM-DD HH:MM:SS`/ISO strings to `YYYY-MM-DD HH:MM:SS` and requires
  `start < end` when both sides exist.
- The handler validates the **merged** values inside the transaction, before the
  `UPDATE students` and before the audit write, and returns HTTP 400 with
  `Enrollment date window must have a start before its exclusive end`.
- No new dependency, no schema change, no change to the accepted request shape.
  A request that supplies both dates is still rejected by the existing
  `validateEnrollmentLifecycleInput` guard; the new check only covers the merged case.

Reproduction evidence: before the handler change, the two new handler tests failed
with `200 !== 400` (2 failures, 20 passes in
`tests/m2-c8-c10-enrollment-lifecycle.test.ts`). After the change the same file is
22/22 passing.

## Commands actually run

Baseline (before any edit, HEAD `28288ed`):

| command | exit | counts | failures |
| --- | --- | --- | --- |
| `M1_NETWORK_MODE=hermetic node --require ./scripts/m1-network-guard.cjs --import tsx --test server/tests/*.test.ts` (repo root) | 1 | tests 1772, pass 1771, fail 1 | `stages every migration in order with exact source hashes and reviewed dependency moves` (`server/tests/m1-bootstrap-plan.test.ts`) — untracked `server/migrations/20261018_13_parent_links.sql` is not in the reviewed bootstrap manifest |
| `cd server && M1_NETWORK_MODE=hermetic node --require ../scripts/m1-network-guard.cjs --import tsx --test tests/*.test.ts` | 1 | tests 1772, pass 1771, fail 1 | same single failure |
| `cd server && ../node_modules/.bin/tsc --noEmit` | 2 | 9 errors | all 9 in untracked `server/src/services/parent-links.ts` (sibling-owned WIP, outside this task) |

Final (after the N1 fix):

| command | exit | counts | failures |
| --- | --- | --- | --- |
| root suite | 1 | tests 1776, pass 1775, fail 1 | only the same pre-existing bootstrap/manifest failure; no M2/M3 failure |
| server-cwd suite | 1 | tests 1776, pass 1775, fail 1 | same single failure |
| `cd server && ../node_modules/.bin/tsc --noEmit` | 2 | 1 error | `src/routes/parent-views.ts(268,7): TS2741` — untracked sibling file that changed concurrently during this run; no error in any file this task touched |
| `git status --short && git diff --stat` | 0 | 2 files changed, +115 lines | only `server/src/routes/student-enrollment.ts` and `server/tests/m2-c8-c10-enrollment-lifecycle.test.ts` |

The pre-existing untracked items (`docs/*.zip`, `docs/share/`, `docs/New Text
Document.md`, `server/migrations/20261018_13_parent_links.sql`) were not touched.
`server/src/routes/parent-links.ts`, `server/src/routes/parent-views.ts` and
`server/src/services/parent-links.ts` are sibling-worker files that appeared/were
edited during this run; this task wrote none of them.

No assertion was weakened, skipped or deleted. The four added tests are additive:
one pure-unit window test and three handler tests (two denials with "no write"
assertions, one positive control that a valid partial update still applies).

## Residual blockers (not fixable inside `allowedPaths`)

1. **F3 media delivery (client contract + file scope).** `server/src/routes/secure-video.ts`
   is not in `allowedPaths` and is a singleton router with no injected entitlement
   service. Wiring `verifyPlaybackEntitlement` there requires (a) a dependency seam,
   (b) a server-resolved `videoId -> lessonId` association (sessions store `videoId`,
   not `lessonId`), and (c) threading a new `entitlement` query parameter into the
   rewritten manifest/segment/key URLs, which is a client-facing change. Until that
   coordinated change lands, the entitlement controls issuance and usage accounting
   but is **not** an additional gate on byte delivery; `secure-video.ts` continues to
   rely on `verifyVideoSessionToken` + `evaluateDeliveryPolicy`. Exact call sites and
   the required `lessonId` resolution are documented in `docs/streams/server/M3-FIXES.md`
   ("F3 part 2"). Proposed files for a follow-up scope:
   `server/src/routes/secure-video.ts`, its test file, and the frontend player.
2. **Bootstrap manifest failure.** The untracked migration
   `server/migrations/20261018_13_parent_links.sql` is rejected by
   `server/tests/m1-bootstrap-plan.test.ts` because its hash is absent from the
   reviewed plan. That file and the plan/manifest are outside this task; the owning
   task must review and register the migration hash explicitly.
3. **Typecheck.** The remaining `tsc` error is in `server/src/routes/parent-views.ts`
   (untracked, sibling-owned, still changing). It is unrelated to M2/M3 and to the
   files changed here.
4. **F8 boundary file.** The callback exemption already lives in
   `server/src/middleware/tenant-authority-boundary.ts`, which is a shared helper
   outside `allowedPaths`; it was verified read-only and needed no change from me.
5. **Live/SQL behaviour.** The SQL adapters and transactions are verified by
   scripted fakes only. No database was executed, so migration-07 table semantics,
   `FOR UPDATE` contention and `withTransaction` rollback remain unverified against a
   real MySQL instance by design of this task.
