# M2-09: private course-unit metadata controls in existing course details

Human152 delegated remaining bounded M2 work; backlog17/C5 and accepted176 API.
Task `client-m2-09-course-unit-ui-20261020-01`, frontend, write. Before: Courses
details has course fields only. After: explicitly opened private owner-only unit
panel lists one page and creates/renames/reorders/archives/reactivates metadata
using176, with truthful denials/errors/unknown-write outcomes. Existing course
management/price/enrollment logic stays unchanged. No full C5/M2 or runtime claim.

## Exact six allowedPaths

- `src/pages/Courses.tsx`: additive import and keyed dedicated component mount in
  existing course-details dialog, only while detailsDialogOpen && selectedCourse;
  pass selectedCourse.id, unmount on close/change. Dialog width/vertical scrolling
  may adjust locally for usable bounded panel; no course controller/form rewrite.
- `src/features/catalog/CourseUnitManager.tsx`: dedicated accessible Arabic/RTL UI.
- `src/features/catalog/course-units.ts`: injected production controller/lifetimes.
- `src/lib/api-http.ts`: additive unit DTO and list/create/update adapters ONLY;
  no shared request/auth/errors/session/other existing endpoint change.
- `src/tests/m2-course-unit-ui.test.ts`: actual transport/controller/component tests.
- `docs/streams/client/M2-09-CONTRACTS.md`: actual contract/checks/limits.

No backend/router/auth/shared helper/schema/package/config/provider/player edits,
no migration application/network/live browser/DB/services/install/npx fetch/Git/deploy.
Unique worker coordination report allowed separately. Preserve all accepted dirty work.

## Contract and presentation

Read server/M2-B04-CONTRACT and176. Prefix `/tenants/me/catalog/courses/:courseId/units`;
GET limit25/cursor, POST{name,display_order?}, PATCH unitId nonempty subset name/
display_order/status. IDs UUID; name trim1..255; order integer0..2147483647; active/
archived. Default create order0. Duplicate names/order allowed, id tie-breaker.
DTO exactly id/course_id/name/display_order/status/created_at/updated_at. List
envelope units/next_cursor; write unit. Strict runtime validation, matching course_id
and PATCH id, response <=25 before row traversal/copy, cursor max256/type. No row
spread/fallback fake values, selectors, inferred permissions or discarded-code guesses.
Canonical request discards HTTP status/code: classify only documented error messages.
Preserve billing-only canonical redirect/identity event and suspension behavior.

Panel labelled institution-owner-only, server remains authority; never derive canEdit
from local role/profile. Explicit open before GET, no eager GET per course/card/
dialog and no separate courses API call. Mounted courseId binding must be immutable
for a controller lifetime; change/close disposes private state. Ordinary user course
selection is a resource id, never tenant authority. Foreign/inactive course404 is
truthful; migration not applied may give500, never mocked production success.

One bounded held page; next/first navigation, no totals/all-page drain/polling.
Cursor is position, not snapshot: reorder between reads may repeat/omit rows.
Show honest limited paging/reorder notice; do not invent snapshot token/dedup guarantee.
Name/order editor and separate archive/reactivate action, every non-submit button
type=button. Label order as metadata position, not lesson unlocking/publication.
No delete/move course/lesson/material/upload/publish/access/paid policy controls.

## Lifecycle and writes

Injected controller owns requests and UI state; render component owns presentation.
Use canonical principal reader/notifier read-only. Single synchronous mutation flight
before await, separate page/form/request/session generations. Observe current principal
BEFORE settlement on BOTH stale success/error. Close/unmount/session change clears
private rows/form/draft/target/confirmation; old finally cannot release newer latch.
No old course completion affects another selected course. Truthful busy state after
supersession; actual disabled attribute follows saving/form constraints, never latches
on historical operation.kind after failure. Explicit close remains usable while reading.

Definite read authorization/scope loss clears private editor/draft/target/confirmed
result and retires pending writes (late completion cannot revive private state),
while retryable ordinary read failure may retain draft. Read denied/session/no-workspace/
missing-course/server/malformed/loading/empty distinct. Preserve suitable drafts for
ordinary write denials and retryable failures; do not erase newer edits with old reply.

Unknown create/update500/network/malformed success may have persisted: uncertain
warning, NEVER automatic write retry. Deliberate list reconcile shows current state,
not proof of prior write/audit; deliberate create retry may duplicate (names repeat),
warn. Definite conflict permits deliberate retry without an unrelated operation.
Confirmed DTO only; retain newer form edits. Refresh at most ONE bounded first-page
read after a confirmed order/create change if needed; no hidden repeated loads.
Do not turn a confirmed save into failed save merely because refresh failed.
No persistence of drafts/private unit state outside component/controller lifetime.

## Tests and completion

Inventory actual page/controller/canonical transport and accepted course/branch tests
before edits. Hermetic real adapter tests for exact path/encoding/query/bearer/
payload/no tenant selectors and shared billing/suspension outcomes. Real injected
controller tests for strict DTO/course/PATCH id,25/26 response bound, integer/name
bounds, owner denial/expiry/missing-course, duplicate clicks, conflict retry, unknown
write/reconcile/no auto writes, reverse GET/page/form/mutation, silent principal on
BOTH stale outcomes, newer latch, close/dispose/course binding and request counts.
Real component controls/render tests for fields/errors/actual disabled attribute,
pending close and ordinary deliberate retry; no copied state/render implementation.
No native DOM/browser claim. Synthetic fixtures only; no data/token logs.

Run new suite + unchanged `m2-course-management.test.ts`, `m2-tenant-branches-ui.test.ts`,
`m2-tenant-profile-ui.test.ts`, `m2-tenant-profile-edit.test.ts` (184 relevant tests)
and frontend tsc, distinguish known11 outside diagnostics from new scoped errors.
No unsafe server suite/default DB/provider/dotenv, optional lint/TEMP/debug comparison,
source reconstruction/source-disable probe. Checkpoint real milestones. Stop ALL
edits/checks before native MCP report and concise unique worker Markdown exact
commands/results/architecture/bounds/limits. Codex independently reviews stable code.
No self-acceptance/timer change/unmeasured performance or migration rollout claim.
