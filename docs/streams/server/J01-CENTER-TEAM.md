# J01/J04 — independent center workforce

BUILD-62: CENTER_ACCOUNT_ONLY early denial now emits Cache-Control:no-store in strict and optional authentication, before feature mounts. The durable center-only role boundary and actual scope remain unchanged. Current native center worker/workspace/group reads and academic403 denial verified alongside teacher/learner/support reads; no new financial/platform/teaching grant.

Contract approved by owner on 8 November 2026: independent employee accounts,
linked by the institution owner to selected resource branches, with finite
operational permissions; no finance or platform administration. BUILD-58 is
local implementation evidence, not production or independent acceptance.

## Identity and mounts

- Owner: live users-table session, active owned tenant, current token_version;
  never JWT tenant/page claims as authority. Billing-only, impersonation and
  legacy `staff` identity namespace are denied.
- Employee: new `users` row, role `staff`, durable `center_account=1`, and one
  separate `center_team_members` row (unique user). No tenant_memberships,
  admin_user_roles or branch_memberships are created.
- Canonical authentication reads the durable marker. Such accounts reach only
  auth self/logout, personal support, and the dedicated team namespace.
  Generic groups, students, fees, branches and platform staff APIs remain denied,
  even if page/tenant claims are forged. Dedicated routes repeat live checks.
- Existing legacy staff and platform support contracts remain distinct.
  Suspension removes center workspace access and invalidates sessions; it does
  not prohibit all future personal-support authentication.
- Mounted through existing `tenant-self.ts` at `/api/tenants/me/catalog`.
  No change to the reserved server entry point was needed.

## Finite rights and scope

`groups.read`, `attendance.mark`, `tasks.manage` only. Attendance requires
groups.read when assigned. No implicit/all-branches default. At most20 selected
resource branches per employee; all must belong to the live owned tenant.
Activation requires active branches. Suspension can still retain an inactive
same-tenant branch selection so it cannot be blocked by branch suspension.

Resource `branches` control groups. `tenant_branches` are separate settings
metadata. Matching names do not establish authority and are never auto-mapped.
Groups must be active, branch-scoped and attached to an active same-tenant
course. Fresh member/token/branch proofs run on reads and inside write locks.
Owner member/password management additionally uses current member version.
Changes/reset bump token_version; password reset does not reactivate a member.

| Endpoint suffix | Purpose |
|---|---|
| GET `/team/owner` | Owner employees + active resource branches; fail closed above100/100 or2000 links |
| POST `/team/members` | New independent account; existing phone in either identity table conflicts |
| POST `/team/members/:id/access` | Versioned permissions/branches/active or suspended |
| POST `/team/members/:id/password` | Private owner-specified password reset and session invalidation |
| GET `/team/workspaces` | Employee's own active workspace; explicit selection |
| GET `/team/work/:memberId/groups` | Authorized groups only |
| GET `/team/work/:memberId/groups/:groupId/sessions` | Actual scheduled group sessions, UTC[-7d,+7d) |
| GET `/team/work/:memberId/sessions/:sessionId/students` | Eligible current roster and recorded attendance only |
| POST `/team/work/:memberId/attendance/sessions/:sessionId/records` | Narrow delegation into canonical attendance engine |
| GET/POST `/team/tasks` | Owner internal operational tasks |
| POST `/team/tasks/:id/assign` | Versioned owner transfer to active scoped assignee |
| GET `/team/work/:memberId/tasks` | Only current assignee's tasks in currently allowed active branches |
| POST `/team/work/:memberId/tasks/:id/status` | Versioned start/resolve; resolved is terminal |
| GET `/team/operations/:key` | Actor-owned historical receipt under current authority |
| POST `/team/operations/:key/retire` | Explicit durable tombstone or existing committed receipt |

Lists use25+lookahead/keyset where paged, fixed DTOs and no-store/Vary
Authorization. Unknown identity/query/body selectors are rejected. Roster does
not expose phones, grades or financial data. Unrecorded attendance is not absence.

## Canonical attendance, atomic writes and recovery

`attendance-records.ts` adds an optional delegation port used only by this
dedicated mount. The generic attendance router receives none. Delegation is
proved before any owner/creator shortcut, then inside the canonical transaction.
Existing enrollment/session/record locking, correction reasons and original
attendance audit remain in the original engine. No duplicated assessment engine.

Each new mutation uses a UUID Idempotency-Key, SHA256 non-secret intent
fingerprint and same-connection mutation/audit/operation receipt. Owner/member
locks serialize normal writes with explicit retirement. Passwords are never
included in fingerprints, receipts or audit. Reusing a provisioning/reset key
cannot change its original password. Keys are bound to actor/tenant/kind/intent.
Replays return historical facts; they do not prove current state. Attendance and
task worker replays/receipt reads additionally re-prove current resource scope;
revocation, branch suspension or transfer cannot be bypassed by a stored key.

Absent receipt is not proof of no write. Explicit retirement locks the actor and
records a tombstone only if absent; subsequent writes with that key conflict.
Already committed operations are returned, not undone or deleted. Lost resource
authority can prevent recovery; UI keeps the intent locked instead of guessing.
Commit/rollback cleanup failures destroy uncertain connections; failures never
report confirmed writes. No blind retries. Audit is atomic but **unsealed**.

Readiness checks query actual table engines, JSON/receipt key columns and unique
identity indexes; attendance additionally requires transactional source tables
and unique(session_id,student_id). Missing schema fails closed. These bounded
checks add request overhead that still needs measurement under task5.

## Deployment boundary and related correction

Migration `20261108_01_center_team.sql` is additive (five statements). It was
applied ONLY to the isolated synthetic demo after a private snapshot, not the
source/production database. Local account tests are actual native auth evidence,
not real-user onboarding or verified phone ownership/OTP acceptance.

Legacy resource branch writes previously autocommitted before an audit failure.
All five branch mutation paths now share `audited-branch-write.ts` backed by
withTransaction; no-change paths produce no audit. Actual SQL failure rollback
was verified. The demo-only existing `branch_audit_log` CREATE was separately
applied after snapshot; a pre-fix synthetic branch is retained without fabricated
audit backfill. Branch policy/permission model was not expanded.

Internal center tasks are owner-created operational requests with optional
owner-defined due time, assignment/transfer/start/resolve and overdue display.
They are not student intake, platform ticket delegation, automatic notifications,
an SLA guarantee, grading rights or finance. Those contexts need their own
contracts. Real concurrent commit races, load, mobile/accessibility, human alternate
operator handover and production schema acceptance remain open.
