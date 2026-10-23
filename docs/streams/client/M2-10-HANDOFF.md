# M2-10 larger private lesson-management UI in existing unit panel

Human180/152 delegated bounded C5 work, accepted183 unit UI and B05 declared API.
Task client-m2-10-lesson-management-ui-20261021-01, WorkBuddy NEW native lane.
Before: unit rows can manage units but not lesson children. After: explicit unit
selection opens a bounded private lesson panel supporting list/paging, create,
edit title/description/order, archive/reactivate and atomic selection reorder,
with truthful errors/uncertain writes and safe close/session/selection lifetimes.
One coherent usable UI+controller+transport+tests/contracts batch. B05 backend and
182 identity correction are now ACCEPTED185 after independent248 tests/server tsc0.
Consume that accepted contract; migration remains FILE-only, no runtime rollout
guarantee. This UI still requires independent acceptance. No API policy change.

## Exact six allowedPaths

- src/features/catalog/CourseUnitManager.tsx: additive explicit per-row lesson
  selection and keyed child mount. Preserve accepted183 unit controls/lifetimes;
  no unit controller rewrite. Pass immutable courseId+selected unit.id; unmount
  on parent close/unit change/private scope loss, including replacement/removal
  of selected row. Never retain children in hidden/denied unit views.
- src/features/catalog/CourseLessonManager.tsx: new dedicated accessible Arabic/RTL
  rendering, explicit actions, controlled forms, labels/live feedback, close stays
  usable while pending, type=button except deliberate form submit.
- src/features/catalog/course-lessons.ts: new injected production controller and
  strict DTO/envelope validation/lifecycle/request/selection/epoch rules.
- src/lib/api-http.ts: additive exact lesson DTO/list/create/update/reorder adapters
  ONLY. Preserve shared request/auth/error/session and all existing adapters.
- src/tests/m2-course-lesson-ui.test.ts: real production transport/controller and
  component callbacks, failures/deferred races/cleanup/bounds. No copied rendering
  or controller logic used as expected behavior.
- docs/streams/client/M2-10-CONTRACTS.md: actual behavior/checks/limits.

No Courses.tsx/backend/schema/router/shared helpers/package/config/provider/player
changes. Unique worker reply allowed separately. OpenCode owns seven backend B05
paths; NEVER edit them or public supervisor probes. Both scopes are disjoint.

## Contract and usable behavior

Read accepted185 server/M2-B05-CONTRACT.md and actual router;182 UUID normalization is closed.
Existing prefix /tenants/me/catalog/courses/:courseId/units/:unitId/lessons:
GET limit/cursor, POST title/optional description/order, PATCH/:lessonId nonempty
subset title/description/order/status, POST/reorder ONLY items:[{id,display_order}].
No delete/move/assets/uploads/content/student/teacher/access/publish/financial/OTP.
Actual server-selected verified owner enforces authority; client label is not a
permission inference. Surface403/404/BILLING_ONLY and feature/schema-unavailable
honestly; never bypass through old lesson endpoints or treat failure as empty.

DTO exactly eight keys id/unit_id/title/description/display_order/status/created_at/
updated_at, strict UUID/bound unit and PATCH target identity, canonical valid ISO,
title trimmed1..255, description null/string<=10000, integer order0..INTMAX,
status active/archived. Refuse malformed/oversized envelope BEFORE copying rows.
Request default25/limit25, keep ONE page<=25; next/first-page navigation, no totals/
drain/poll/prefetch per row. Cursor<=256 canonical server token; position not snapshot
under mutable order; show concise notice, no full-catalog/snapshot claim.

Forms support title/description/order and explicit null clearing; archive/reactivate
separate explicit actions. Reorder selected visible rows only, at most25 unique ids
from current bound page (server max100 remains backend-only), validate all positions
then send ONE atomic batch, no per-row update loop, no blanket renumbering or
cross-page/cross-unit ordering. Show confirmation/changed selected rows truthfully.
Returned selection must exactly match requested identity set without duplicates,
foreign units or extra rows before applying; validate body before confirmed success.
Unit metadata status does not change student access.

## Lifecycle and correctness

Immutable course+unit bindings; controller created per keyed mount, disposed on
unmount. Adopt principal changes BEFORE success/error handling; session event,
parent close/unit change/denial clear all private rows/drafts/selection/messages and
retire in-flight work. Old responses cannot restore stale private content. Fence
reads with generation/confirmed-write epoch, drafts with form generation, mutation
ownership with unique tickets. No stale read overwrites newer confirmed write.
One actual write flight (acquire synchronously before await); truthfully disable
saving controls; confirmed write releases OWN ticket before optional follow-up GET
so enabled actions are not silently dropped (179/183). Old finally cannot release
newer ticket. One bounded follow-up GET after confirmed create/reorder; refresh
failure does not turn confirmed save into failed save. No automatic mutation retry.
Transport/invalid2xx/write500/commit uncertainty stays uncertain; preserve draft and
offer explicit read reconciliation, never silently retry or promise idempotence.
Read reconciliation reports current state only, not proof of previous write success.

## Verification and completion

Real production controller/parser/adapters through canonical request with synthetic
fetch/window/storage/session fixtures; real component tree and actual callbacks,
not source regex alone. Cover successful full flow including atomic reorder,
cross-unit/malformed/duplicate/oversized DTO, denied/missing/billing/unavailable,
validation/no-request failures, pending close/unit/session changes on both outcomes,
old/new write tickets, stale read after write, confirmed-save/failed-refresh,
uncertain writes/no retries, reorder single-request/exact identity set and25 bound,
no per-row background fetch and selected-child cleanup on parent deny/removal.
Run new suite plus unchanged254 safe M2-09/course/branch/profile tests and unchanged
public179 regression; frontend tsc with known11 outside diagnostics reported honestly.
No unsafe server/default adapters/dotenv, DB/live network/browser/services/install/
npx fetch/TEMP debug/source reconstruction/optional lint/Git/deploy/migration apply.

Before report stop ALL edits/checks. Native MCP report + concise unique worker reply:
actual changed paths, commands/outcomes, source bounds, before/after and remaining
browser/runtime/type/performance limits. No self-acceptance/own tasks/timers or
invented native IDs. Codex independent source/contract/architecture/tests review
required. Done is private lesson-management UI only, not full C5/M2/rollout.
