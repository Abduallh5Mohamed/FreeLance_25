# M1 — Resource-derived branch contract (2026-10-17)

Task: `m1-branch-resource-isolation-secret-cleanup-20261017-01`.
Branch `codex/workbuddy-server`, snapshot `af799c7f63b0aed7e3f90800f2cb2f2e8e0251ec` + working
tree. This document is the server contract; it is **evidence, not acceptance**.
M1 remains open.

## 1. Why this exists

The previous S1 work only validated the **optional** `branch_id` selector on
`POST /api/student-enrollment/spaces/:id/select`. An absent selector produced
`no-branch-context` and every other resource route ignored branches entirely,
so deleting the selector bypassed the check. This contract makes branch
authority **resource-derived**: the branch is read from the trusted
resource/parent chain the server itself wrote, never from a caller selector.

## 2. Resource classification

| Resource | Trusted branch chain | Classification |
|---|---|---|
| group | `groups.branch_id` + `groups.branch_scope` | branch or explicit tenant |
| lecture | `lectures.group_id -> groups` | branch if the group is branch-owned; otherwise tenant (course tenant) |
| material | `material_groups -> groups` (all links must agree) | branch if any linked group is branch-owned; conflicting links are ambiguous |
| exam | `exam_groups -> groups` (all links must agree) | branch if any linked group is branch-owned; conflicting links are ambiguous |
| premium lecture | `premium_lectures.group_id -> groups` | branch if the group is branch-owned |
| attendance | `attendance.group_id` or the student's group -> `groups` | branch if that group is branch-owned; otherwise tenant |
| file | exam-question image / premium-receipt parent -> `groups` | branch if a parent is branch-owned; otherwise tenant |
| video | `videos.lecture_id` / `videos.material_id` -> group chain | branch if a parent is branch-owned; conflicting parents are ambiguous |
| course | tenant-owned (`courses.tenant_id`) | **explicit tenant-level**; no branch column is invented |

`groups.branch_scope` is the only branch classification column:

- `branch` — branch-owned. `branch_id` is required. A missing id is
  **ambiguous and denied**, never defaulted to tenant-wide.
- `tenant` — explicitly tenant-level (independent instructor or tenant-wide
  content). `branch_id` must be NULL.
- `unassigned` — a legacy row created before the branch model. Its ownership was
  never recorded, so it is `ambiguous` and **denied** (the `legacyUnclassified`
  marker is audit-only and never an authorization). It is reported by the
  quarantine workflow for investigation/classification, can never satisfy a branch
  context, and is never auto-assigned or widened to tenant scope. An authorized
  actor may classify it explicitly as `tenant` (or `branch`) through the audited
  quarantine endpoint; it is never guessed into a branch.

No redundant `branch_id` is added to child tables: the parent chain is
authoritative, and a conflicting parent chain is a denial rather than a guess.

## 3. Schema and migration

New guarded migration (only new migration in this task):

- `server/migrations/20261017_08_resource_branch_scope.sql`
  - `groups.branch_id CHAR(36) NULL` + index `(branch_scope, branch_id)` +
    FK `fk_groups_branch -> branches(id)` (added only if absent; FK checks are
    never disabled).
  - `groups.branch_scope VARCHAR(16) NOT NULL DEFAULT 'unassigned'`.
  - `branch_audit_log` for lifecycle and quarantine actions.
- Historical migrations are untouched. `server/bootstrap/m1/manifest.json`
  gained exactly the new source entry and hash.

Source hash `20261017_08_resource_branch_scope.sql`:
`b7bdc154fb5f53865dd32107e338152a0a5ce4c84c7d5baa339e428c88819e39`
(identical in the staged `bootstrap-retry05` copy).

## 4. Enforcement decision

`server/src/security/resource-branch.ts`:

- Loads the resource chain with server-side SQL. No request field participates.
- **Branch resource**: tenant equality, active branch, live membership (or the
  narrow tenant-owner / verified-platform path), and version equality when the
  session carries a branch claim. A selector must equal the derived branch.
- **Tenant resource**: no branch is invented. The resource route's existing
  exact-resource predicate continues to enforce tenant equality; a selector is
  a context mismatch (403).
- **Ambiguous**: denied and recorded in `branch_audit_log`; never widened.
- **DB failure**: propagates, so the handler fails closed.

API error shape (generic, no enumeration):

| Decision | Status | Body |
|---|---|---|
| missing / cross-tenant / membership missing | 404 | `{"error":"Resource not found"}` |
| ambiguous branch context | 403 | `{"error":"Resource branch context is ambiguous","code":"BRANCH_CONTEXT_AMBIGUOUS"}` |
| selector mismatch / malformed selector | 403 | `{"error":"Forbidden","code":"BRANCH_CONTEXT_DENIED"}` |
| branch suspended / membership revoked / version bump | 403 | `{"error":"Forbidden","code":"BRANCH_ACCESS_REVOKED"}` |
| stale branch-scoped session at auth | 401 | `{"error":"...","code":"BRANCH_REVOKED"}` |

## 5. Session binding and live revocation

`server/src/middleware/auth.ts` re-reads the branch and membership on **every**
protected request (no cross-request cache):

- A token with `branch_id` must resolve to an active branch in the same tenant.
- A non-owner must have an active `branch_memberships` row whose `version`
  equals `branch_membership_version` in the token.
- A branch suspension, membership revocation, membership version bump or
  tenant mismatch denies the next request with `401 BRANCH_REVOKED`.
- `POST /student-enrollment/spaces/:id/select` now binds `branch_id` and
  `branch_membership_version` into the token, and verifies that the selector
  matches the enrollment group's own branch.

Revocation denies subsequent requests; it does not undo work already
committed. Branch-sensitive writes use guarded/conditional SQL and the existing
transaction boundaries.

## 6. Creation and administration

- Group creation accepts a branch only after validating the active branch,
  tenant and caller membership. A branch-scoped group without a branch is
  rejected; a group created without a branch is explicitly `tenant`.
- Lecture/material/exam/premium creation validates every group link: all
  branch-owned links must name the same branch and the caller must be
  authorized. A bare selector cannot assign a branch.
- Minimal administration (no UI) is mounted at `/api/branches`:
  - `GET /`, `POST /`, `PATCH /:id`
  - `GET|POST /:id/memberships`, `DELETE /:id/memberships/:userId`
  - `GET /quarantine`, `POST /quarantine/groups/:groupId/classify`
  Every mutation writes a verified-actor `branch_audit_log` row. Revocation is
  a status/version change, never a delete.

## 7. Quarantine and the product question

The quarantine report returns counts and rows for:

- `branch_scope='branch'` with no `branch_id`
- `branch_scope='tenant'` with a `branch_id`
- `branch_scope='unassigned'` (legacy)
- a branch id that is missing or belongs to another tenant

**Product question (unresolved, not decided by this task):** should legacy
`unassigned` groups be explicitly tenant-level or assigned to branches? This
task preserves their existing tenant access, reports them, and never guesses.
A tenant owner must classify each row through the audited endpoint if a
different decision is required.

## 8. Tests and evidence

- `server/tests/m1-branch-resource-contract.test.ts` — resolver decisions
  (allow, no-selector bypass, forged selector, cross-branch, cross-tenant,
  revoked, version bump, ambiguous, DB failure) plus real groups/files
  handlers and live auth revocation.
- `server/tests/integration/m1-branch-resource-live.test.ts` — live isolated
  evidence: branch group allow/deny, revocation next request, branch-owned
  lecture, branch-scoped student token, explicit tenant-level creation,
  branch administration/audit/quarantine.
- Existing suites were updated only with a tenant-scope fixture seam; their
  pre-branch behavior is unchanged.

## 9. Remaining limitations

1. Legacy `unassigned` classification is a product decision (above).
2. Branch administration has API + audit but no UI.
3. Live coverage is focused on groups, lectures, student selection and branch
   administration; materials/exams/attendance/premium/files/videos are
   enforced in code and covered by resolver/handler tests, not every one by a
   live route.
4. OTP/SMS delivery is still deferred: absent provider remains fail-closed
   `503`; onboarding via contact verification is unavailable until a provider,
   channel and cost are approved.
5. Credential rotation and Git-history rewrite are external and unexecuted.

## 10. Correction — legacy fallback + video parent chain (2026-10-17)

Task: `m1-branch-legacy-video-correction-20261017-01`. Records the exact
corrections Codex flagged as `partial_not_accepted_legacy_scope_fallback_and_video_parent_gap`.
Evidence, not acceptance; M1 remains open.

### 10.1 FIX1 — legacy `unassigned`/`NULL` is ambiguous/deny (no silent tenant fallback)

`server/src/security/resource-branch.ts` `mapGroupScope`: a group whose
`branch_scope` is `'unassigned'`, `NULL`, or any unknown value returns
`scope:'ambiguous'` with `legacyUnclassified:true` (audit-only). The resolver
denies **every** principal for an ambiguous resource — including the tenant owner
and a verified platform operator. There is no owner bypass and no invented default
branch; the row is reported via `branch_audit_log` and stays classifiable only
through the audited `/api/branches/quarantine/.../classify` endpoint. An
explicitly `tenant`-classified row keeps its tenant access (positive control).

Supervisor correction honored: a course is explicitly tenant-level; the fix does
**not** reclassify anything by walking `groups.course_id`, and no first-row guess
is made.

### 10.2 FIX2 — video parent chain resolves every present parent; course is never guessed

`loadVideo` (`createSqlResourceScopeLoader`) now:

- resolves every present parent (`lecture_id`, `material_id`, `course_id`) against
  the server rows. A dangling/missing parent is ambiguous even when another parent
  is valid — no dangling-FK fallback.
- validates `course_id` via the `courses` row; a supplied course with no matching
  row is denied (`dangling-course-parent`).
- rejects conflicting branch ids / tenants / provenance (`conflicting-branch-links`,
  `conflicting-parent-tenant`, `conflicting-course-provenance`).
- treats a course as explicit tenant-level only; it is **never** expanded through
  `groups.course_id`. A course referenced by many branch groups is therefore not
  guessed into a single branch, and an explicit tenant-level course keeps its
  legitimate tenant access.
- denies a video that has no resolvable parent context (`video-without-context`);
  the uploader's tenant alone is not sufficient.

### 10.3 Wiring review (no bypasses found)

All branch checks were already wired and are re-confirmed:
- `secure-video.ts`: `enforceVideoBranch` on `POST /session` (205) and
  `POST /refresh-token` (361); `sessionVideoBranchAllowed` on `POST /heartbeat`
  (466), `GET /manifest` (683), `GET /media` (750), `GET /key` (804).
- `videos.ts`: `enforceVideoBranch` / `videoBranchAllowed` on list-filter (2341)
  and read/update/delete/stream/key (2386, 2413, 2510, 2542, 2587, 2660).
- `groups.ts`, `materials.ts`, `lectures.ts`, `attendance.ts`, `exams.ts`,
  `premium-lectures.ts`, `files.ts`, `student-enrollment.ts`, `/api/branches`:
  all call the same central decision.

No new migration, no FK change, no OTP/SMS change, no frontend change.

### 10.4 Tests and evidence

New real-loader / real-handler tests (hermetic, no DB/network):

- `server/tests/m1-branch-legacy-scope.test.ts` — 10 tests. Drives the REAL
  `createSqlResourceScopeLoader` + `resolveResourceBranchAccess` and the REAL
  `groups` router. Covers: legacy `unassigned`/`NULL`/unknown → ambiguous; explicit
  tenant → allowed; tenant owner gets NO bypass; platform operator cannot widen;
  DB failure fail-closed; handler 403 for legacy read, 200 for explicit tenant,
  403 for owner-of-legacy read.
- `server/tests/m1-branch-video-scope.test.ts` — 12 tests. Drives the REAL
  `loadVideo`. Covers: branch-owned lecture parent → branch scope; course-only
  video → tenant scope (positive control); conflicting lecture+material branches →
  ambiguous; dangling lecture → ambiguous; dangling course → ambiguous; no-context →
  ambiguous; tenant-level course shared by many branch groups is NOT guessed into a
  branch; DB failure fail-closed; resolver member-allowed / cross-branch-denied /
  tenant-member-allowed / conflicting-denies-even-branch-member.

### 10.5 Validation

| Command | Result |
|---|---|
| hermetic, repo root + server cwd | **1163/1163 pass** (1141 prior + 22 new), exit 0 |
| `tsc --noEmit -p server/tsconfig.json` | exit 0 |
| `git diff --check` | exit 0 |
| redacted secret scan | `scanned=944 findings=0 allowlisted=3` |

Hashes:
- `server/tests/m1-branch-legacy-scope.test.ts` `b5dafbf1b4e76ce3e0e52c0caeecf6aaf6963112ddc7fefcaac48a9fdb25c300`
- `server/tests/m1-branch-video-scope.test.ts` `9d38ef10cd3b27e472aa5475394c254eecac9b98de8675387b7fd537f27e4319`

### 10.6 Resolved vs open

- **Resolved:** legacy scope fallback (deny-by-default), video parent gap (no
  course→group guessing, no silent fallback), supervisor correction (course is
  tenant-level; one-to-many branch groups do not reclassify the course).
- **Open (unchanged external/approval items):** SMS/OTP provider decision (503
  fail-closed retained), credential rotation / Git history (external), branch
  admin UI, broader live route coverage for materials/exams/attendance/premium/
  files/videos (enforced + resolver/handler tested, not every one live).
