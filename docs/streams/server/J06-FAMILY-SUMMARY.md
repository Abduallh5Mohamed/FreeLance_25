# J06 — bounded family summary and agenda

BUILD-56 continuation: [actual scoped evidence](../../agent-context/BUSINESS-IMPLEMENTATION-2026-11-08-BUILD-56.md). Parent schema applied only to synthetic demo after snapshot. Native runtime has zero links/tokens and no PARENT_VIEW_SECRET; empty/denied browser path verified. Positive original-router/MySQL/Chrome path uses injected fixture principal, seeded verified-link premise and in-memory secret inside outer ROLLBACK, not actual OTP/onboarding or durable-link acceptance. Original UI now distinguishes service503 from lost child access401/403/404; lost access clears summary, selected link and current option until fresh discovery. Discovery/session store failures return stable503 without driver payload logging. Backend59/frontend2275/types/build pass. Publication, channels, real identity, load/mobile and field usefulness remain open. Historical no-schema/no-browser statements below describe BUILD-39.

BUILD-39, 7 November 2026. Existing parent linking/scoped-token contract is
reused; no new provider, schema, parent role or automatic cross-institution
aggregation is introduced. This is a locally implemented read journey, not
acceptance of the existing parent subsystem or external delivery.

## Actual mount and credentials

`parent-views.ts` mounts `createFamilySummaryRouter` at `/family-summary` with
the production read adapter and existing real parent verifier. The existing
composition root already mounts parent views before ordinary JWT middleware at
`/api/parent`. Therefore the actual endpoint is
`GET /api/parent/family-summary`, authenticated only by a dedicated scoped
`pv1` bearer. A standard login bearer cannot read it. No composition-root or
reserved WorkBuddy files were changed.

The browser discovers only its own links via the existing authenticated
`GET /api/parent-links` and explicitly requests a scoped session through
`POST /api/parent-links/:id/session`. Discovery is capped by the existing
latest-200 contract. This batch adds no-store headers to the links router and
requires a direct users-table principal: old staff identities, billing-only
accounts and support impersonation are denied before link lifecycle handlers.
The old staff-identity namespace cannot collide with a parent user ID. Existing
ordinary users with current tenant authority retain the established revocation
contract; no new staff authority is inferred.

## Read authority and privacy

- Verify the scoped token, expiry, current stored token and exact live link
  before collection, and verify it again before returning private data.
  The new endpoint additionally requires explicit `active` link status and null
  revocation time, rather than normalizing unknown status to active.
- All authority comes from verified tenant/enrollment/parent claims. Query/body
  selectors and tenant/enrollment/impersonation headers are rejected. The
  existing composition-root impersonation rejection remains in place.
- Query current active tenant and users-table parent/student accounts, applying
  the shared suspension predicate; recheck enrollment approval/status/start/end.
- A current group is available only through an active student-course assignment,
  same-tenant active course and valid tenant/active-branch group scope.
  Invalid/missing group assignment gives `no_current_group`, not known zero absence.
- Re-read the child's current identity/group/course after collection and discard
  the entire response on a change. Reads use separate current SQL statements;
  there is no claim of one atomic publication snapshot or real-time revocation
  subscription. A revocation after the final proof remains the normal boundary
  of a completed private read.
- Fixed projection: child name and current group/course names, bounded session
  metadata, attendance states/counts, one deterministic action, UTC windows and
  a grade-unavailable marker. No contact details, tenant/parent/enrollment/user
  identities, tokens, scores, answers, notes or other children in the summary.
- Every endpoint response is `Cache-Control: no-store`, `Vary: Authorization`.
  Errors contain stable codes without SQL or child payload logging.

## Sources and bounds

Server clock defines `[now-7d, now)` attendance and `[now, now+7d)` agenda,
rounded to seconds. Dates are absolute UTC. Attendance considers ended,
non-cancelled **current-group** sessions only, within the enrollment interval.
Future agenda considers non-cancelled current-group sessions within the same
enrollment interval. Tenant-wide and branch-wide sessions are deliberately not
included in this initial family view. This is not a reconstruction of past
group memberships and is labelled accordingly.

Missing attendance is `unmarked`; `excused` is separate from `absent` and `late`.
No percentage or diagnosis is inferred. Query 101 rows for each window; more
than 100 in either rejects the whole response (503), without silently reporting
truncated totals. Duplicate IDs, invalid states/titles/UTC dates and malformed
source rows also reject the response.

Actual catalog columns are checked for the existing nine source tables.
Required existing indexes are checked structurally, independent of their names:
schedule `(tenant_id, group_id, starts_at)` prefix and exact unique attendance
`(session_id, student_id)`. Missing metadata/index/schema yields unavailable;
no runtime DDL. These gates and LIMITs do not prove query cost: actual MySQL
EXPLAIN, load, liveness races and source-schema acceptance remain open.

One action, in order: recorded absence -> ask/support the child; unmarked ->
confirm with teacher; upcoming session -> prepare; unavailable group -> contact
teacher; otherwise no action inferred. Excused absence alone is not penalized.

`gradebook_scores` has no established family-publication proof in the inspected
schema. The new endpoint never queries it; grades return
`{status:'unavailable',reason:'publication_contract_required'}`. The legacy
`/api/parent/grades` handler now also fails closed with 503 and
`PARENT_GRADE_PUBLICATION_UNCONFIGURED`, without calling its old score adapter.
This is an intentional compatibility correction: the prior all-recorded-score
aggregate is not a publication contract. Its exported adapter remains for
historical compatibility/tests but is not invoked by the mounted handler.
All parent-view responses now carry no-store, including legacy auth errors.
Restoring grade display requires a separately reviewed source-publication contract.
No legacy/catalog progress is merged and no J07 plan is disclosed to parents.

## Status and verification

400 denied selectors, 401 invalid/revoked/expired scoped session, 404 lost live
child scope, 503 missing secret/schema/index/invalid evidence/read failure.
No writes are made by the summary route. User-requested session issuance uses
the existing token service, never a simulated token or fake delivery.

See [BUILD-39](../../agent-context/BUSINESS-IMPLEMENTATION-2026-11-07-BUILD-39.md)
for tests and limits. No live schema, secret, provider, database or migration
was accessed/applied. Real parent account onboarding, source publication,
quiet hours/opt-out, institution aggregation policy and actual channels remain
separate. There is no background sender, delivery receipt or time-saving claim.
