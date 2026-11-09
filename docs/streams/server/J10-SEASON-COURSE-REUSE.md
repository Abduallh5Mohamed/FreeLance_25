# J10 — Reviewed course settings reuse, BUILD-43

BUILD-61 retains institution ownership/rights/review contract and adds live teaching identity/membership/session plus no mixed platform role before all paths including receipt recovery. Academic responsibility alone grants no reuse right. No copied students, fees, grants or automatic publication.

BUILD-44 continuation: settings reuse stays settings-only. A separate
[template import](J10-SEASON-TEMPLATE-IMPORT.md) now reuses an explicit pinned
revision by mapping every reference to an already-prepared same-kind source in
the new draft. It does not silently copy old-course IDs or binary content.

Owner approved a season as a named start/end date-only period in the institution,
and reuse limited to owned course settings/content templates after review, with
no students, finance or permission transfer. Existing `academic_periods` is the
period registry; no competing season entity or automatic lifecycle was added.

This increment implements **course settings only**. Content-template/source
mapping across courses is unfinished; references cannot be copied blindly when
their existing authority is bound to the old course.

Mounted under `/api/tenants/me/catalog/season-reuse` by `tenant-self.ts`:

- GET `/periods?after`: 25 unarchived same-tenant period headers, lookahead one.
- GET `/courses?after`: 25 active same-tenant course configurations.
- POST `/review`: exactly period_id, source_course_id, target_name and
  rights_confirmed=true. Read-only transaction re-proves owner/source/period.
- POST `/apply`: same fields plus review_token and operation_id UUID. Creates
  one independent draft, sealed audit and immutable operation record atomically.
- GET `/operations/:operationId`: original-actor historical receipt, or null.
- GET `/history?after`: 25 tenant-owned creation records, keyed by operation
  UUID, with target/source IDs and stored period/name/date snapshots only.
  No actor/hash/private content is projected. This is historical creation,
  not the target course's current active/publication state. Owner authority is
  re-proven, without mutating or guessing the old period/course state.

Owner proof includes live tenant/account status, suspension and token version
under a transaction lock. Student/staff/billing/impersonated identities and
authority selectors are refused. Queries and projections are bounded/explicit;
responses no-store. Date-only values round-trip as date strings.

Only name, subject, description and textual grade are reused. Target price is
initialized to zero, publication_state=draft, published_at=NULL and ownership
derived from the current server-proven owner. No enrollment/group/assessment/
balance/subscription/media/template/schedule or delegated access is copied.
An active draft is not publication. Existing publication/enrollment/access
guards remain required. The original source is never updated or archived.

Review hash binds actor, tenant, source configuration, period label/dates and
target configuration. Apply re-reads/locks both sources; any changed evidence
refuses 409. An explicit right-to-reuse attestation is required and audited;
it is not independent proof of legal content ownership.

One source can produce at most one draft per period/tenant, enforced by an
exact unique key in `season_course_reuse_operations`. New keys do not bypass
that rule. Same-key canonical replay returns the original receipt before live
source lookup; changed payload or actor conflicts. Fresh commit 201, replay 200.
The operation stores period/name/date snapshots so historical creation remains
explainable if a planning period is subsequently edited. It does not schedule
lessons or automatically update the cloned course when period dates change.

Pre-commit errors roll back draft, audit and operation together. Commit ACK
failure destroys the unknown connection without rollback, returns uncertainty
and requires GET recovery. A missing receipt is not retry authorization.

Schema gates InnoDB core tables, publication columns and exact unique key shapes.
No claim is made that they prove every deployed column type/index/FK. Migration
`20261107_04_season_course_reuse.sql` is applied **only to the authorized synthetic
local demo** in BUILD-43, not to source/production databases.

Real MySQL/HTTP tests cover concurrent duplicate prevention, stale review,
receipt/replay, unchanged source, no copied enrollments/groups/grades and sealed
audit verification. Chrome desktop covers explicit UI confirmation. Actual
production schema/isolation/load/mobile/content reuse acceptance is unfinished.
