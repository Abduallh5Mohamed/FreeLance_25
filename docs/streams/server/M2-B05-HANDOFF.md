# M2-B05 larger WorkBuddy batch: private lesson catalog and atomic ordering

Human180 explicitly restores WorkBuddy for larger new M2 batches; human152 delegates
bounded M2 implementation, backlog17/C5 requires unit/lesson create/edit/reorder/
archive. Use existing176 private verified institution-owner authority and course/unit
metadata relationship. This task completes one coherent backend lesson-management
surface including batch ordering, audit and failure/authority conformance, not a
sequence of tiny create/read tickets. No student/public/publishing/access policy.
Task `client-m2-b05-lesson-catalog-20261021-01`, backend, WorkBuddy native only.

Before: accepted176 private course units, no lesson-child metadata endpoints.
After: verified owner can list/create/edit/archive/reactivate lesson metadata
under a unit of an active owned course; atomically reorder up to100 selected
lessons with full prevalidation/audit/rollback. No lesson delivery/content/assets,
unit/course move, student assignment, drip/progression or financial effects.

## Exact seven allowedPaths

- `server/src/routes/course-lessons.ts`: dedicated injected production router.
- `server/src/routes/tenant-self.ts`: additive import/mount ONLY, preserve accepted
 176/151 handlers/default wiring byte-for-byte. Mount under existing `/catalog`
  after existing authenticate; no auth/index/other-router changes.
- `server/migrations/20261021_01_course_lessons.sql`: additive new table FILE only.
- `server/tests/helpers/m2-course-lessons-harness.ts`: synthetic positively isolated
  test fixtures/composition helpers, no production code copied into tests.
- `server/tests/m2-course-lessons.test.ts`: real CRUD/authority/validation tests.
- `server/tests/m2-course-lessons-reorder.test.ts`: real atomic batch/failure tests.
- `docs/streams/server/M2-B05-CONTRACT.md`: actual contract/schema/checks/limits.

OpenCode concurrently owns only frontend M2-09 corrections. Do not touch src/**,
api-http, unit router/accepted tests, package/config/other schema/auth/middleware/
index/provider. Native MCP claim exact task only, your own unique workerId/session
if available. No preclaim/other claim inspection. Preserve all dirty work.

## API and authority

Prefix `/api/tenants/me/catalog/courses/:courseId/units/:unitId/lessons`:
GET list; POST create; PATCH `/:lessonId`; POST `/reorder`.
Same176 selected-tenant verified actual owner row, active user/tenant, no membership
label/global teacher/admin/student authority. Explicit billingOnly refusal before
connection; preserve upstream auth/tenant selector/student boundary precedence.
Owner before course existence; course active+tenant selected, unit belongs to course,
lesson belongs to unit. Foreign/null/inactive course/foreign unit/lesson fails
indistinguishably404 without leakage/writes. Archived unit/lesson is private metadata,
still owner-manageable; no existing access rule changes. No client tenant selector.

Strict UUID paths, object keys/types; title trimmed1..255; optional description
null or string<=10000 characters (engineering bound), display_order integer
0..2147483647 default0, status active/archived defaultactive on create. POST only
title/description/display_order, PATCH nonempty subset title/description/order/status.
Reject URLs/asset fields, publication/financial/identity/assignment selectors or
unknown keys. Duplicate labels and numeric order ties allowed; id tie-breaker.
No hard delete/move/asset/upload/student/progression endpoint.

DTO exactly id/unit_id/title/description/display_order/status/created_at/updated_at.
No tenant/owner/contact/billing row spread. Use SQL UNIX_TIMESTAMP epoch projections
and validated canonical ISO DTO before write commit, matching corrected176; no
driver/session-timezone assumption or config changes/fake timestamp fallback.
GET default25/max100 keyset(display_order,id), limit+1, bounded canonical cursor
<=256chars, no offset/totals/drain. Validate bounds before DB. Cursor position,
not cross-request snapshot: mutable order can repeat/omit rows; document truth.
Every own response no-store before await; upstream responses unchanged.

## Larger-batch atomic ordering and transactions

`POST /reorder` accepts ONLY `{items:[{id,display_order}]}` length1..100, unique
UUID ids, strict keys/integer bounds, no coercion. Partial selection updates only
those positions; tied numeric order allowed, no mass renumbering/snapshot policy.
One connection/transaction: verify/lock actual owner, active course, parent unit;
lock target lesson rows in a deterministic id order. Confirm ALL ids belong to
the bound unit BEFORE ANY update/audit. Foreign/missing mixture404 rolls back all;
no partial success. No-op rows produce no update/audit. Changed rows each have a
bounded audit event with actor/derived tenant/course/unit/lesson old/new metadata;
one atomic commit. Return explicit canonical DTOs for selected lessons (max100),
document deterministic result ordering, not a whole catalog read.

Individual create/update also same transaction/authorization/parent locks and atomic
audit; no-op truthful. Materialize all response DTOs before commit. Failure to acquire/
begin/read/write/audit/readback/format/rollback/commit must have truthful status and
exactly one safe release OR destroy. Lost commit ack uncertain: no rollback claimed,
no auto retry/idempotent-create promise; discard connection. All batch operations
bounded, no N+1 unbounded hierarchy loads. Do not modify other resource order/status.

New `course_lessons` table: UUID idPK, unit_id FKcourse_units(id), title,
description nullable text, display_order nonnegative INT, active/archived status,
TIMESTAMP created/updated, index(unit_id,display_order,id). Derive course/tenant via
parent relations, no independent duplicated tenant/course columns. No ALTER/drop/
backfill/application, no runtime DDL. FK collation/engine match declared176 parent;
actual runtime schema compatibility remains separate authorized rollout gate.

## Completion and verification

Use real production factory and real tenant-self mount plus real auth/boundary
composition with injected leaf repositories. Intercept default DB/provider/renewal/
dotenv bodies BEFORE any app import; assert no cache/default adapter calls. No
whole server index/listener/socket/live DB/network/browser/service/install/npx fetch.
Synthetic data only, no credentials/user/student traces. Do not copy handler logic.

Cover full CRUD/noop/status/order/DTO/timezones/list boundaries/cursor ties, every
authority/parent scope/selector case, strict payloads, owner/parent/lesson locks,
batch duplicates/100 vs101 items, mixed foreign/unknown ids, all scope proof before
updates, no-op+changed mix, failure mid-update/audit/readback/commit/rollback and
no leaked partial state (transactional fixture plus call-order assertions). Record
actual bounded SQL/request/cleanup evidence, no unmeasured latency/concurrency claim.

Run both new isolated suites+unchanged164 accepted profile/read/update/branch/unit
tests and server tsc. No legacy auth-boundary/m1-expanded-tenant-admin/default DB
suite, no optional lint/TEMP debug/source reconstruction/source-disable probes.
Checkpoint real inventory/implementation/test milestones. Stop ALL edits/checks
before native MCP report and concise unique worker Markdown (actual commands,
before/after, changed paths, results/limits). Codex reviews independently; do not
self-accept, create own task or enable schedules. One task per native session.
On quota/guard stop once and report exact sanitized reason, no model/account bypass.

Done is this complete private backend catalog/atomic-order surface and migration
FILE, not full C5/M2, public/student consumption, upload/provider or runtime rollout.
