# J02/J03 — catalog homework submission backend (BUILD-27)

BUILD-57 continuation: schema/scan-fencing/context migrations applied ONLY to isolated synthetic demo after snapshot. Native policy/history verified; mysql2 decoded allowed-file-type arrays now preserved. Runtime still returns upload_configured:false and valid keyed create503/no submission rows; no scanner/storage provider or delivery acceptance. Historical unapplied statements below are superseded for this demo only. [Evidence](../../agent-context/BUSINESS-IMPLEMENTATION-2026-11-08-BUILD-57.md).

BUILD-27 backend boundary; [BUILD-28 student UI](../client/J03-STUDENT-CATALOG-HOMEWORK.md)
now mounts explicit upload/resume/verify/cancel and changes homework candidate
metadata to `submission_required`. Actual runtime remains unconfigured; there
is no provider activation, migration application or production acceptance here.
Reuses the mounted `/api/assignments` submission engine and its existing
[private upload contract](../../contracts/ASSIGNMENT-UPLOAD-FINALIZE.md).

## Server-owned context and routes

Base: `/api/assignments/catalog/courses/:courseId/lessons/:lessonId/activities/:contentId`.
UUID resource selectors, authenticated student and exact server-selected
enrollment only. No query selectors or identity override headers. Server proof
derives assignment/tenant/user/enrollment from the current lesson reference,
publication, release/prerequisite, active identity/token version/suspension,
approved in-window enrollment, actual group/branch and source audience.
Branch-wide homework without a group remains unsupported by the source contract.

| Method/path relative to base | Body/header | Result |
|---|---|---|
| GET `/submission-policy` | Empty | Current deadline, policies, file limits/types, original engine admission decision and separate `upload_configured` flag |
| GET `/submissions/mine` | Empty | Own matching-context versions only, private fixed projection, no upload URLs/keys |
| GET `/requests/:requestKey` | UUID key; empty | `{submission:null}` or `{submission:{id,version,status,file_name,file_type,file_size_bytes,upload_status,scan_status},unchanged:true}` |
| POST `/submissions` | Exactly `{file_name,file_type}`; UUID `Idempotency-Key` header | Original engine 201 with id/version/status/late/upload/scan/size facts; no assignment or enrollment IDs |
| POST `/submissions/:submissionId/upload-authorization` | Empty | Original engine authorization for the exact stored own version |
| POST `/submissions/:submissionId/finalize` | Empty | Existing signature/size/type/ETag/scanner verification and atomic verdict/audit |
| POST `/submissions/:submissionId/cancel` | Empty | Original pending-upload cancellation/audit/exact-version cleanup |

All responses, including authentication failures, are `Cache-Control: no-store`.
Catalog responses whitelist fields; no source assignment/enrollment IDs, stored
context or standalone object key. The signed upload authorization is a private,
short-lived capability and must not be logged or persisted by the future UI.
Opening policy/history/recovery never signs a target, writes a row or scans.

The factory internally resolves the catalog request, records its private context
in a per-response WeakMap, and rewrites only to the existing engine handler.
Bodies never choose that context or destination. The original transaction seam
is wrapped with fresh locking proof on the same write connection. No second
upload, submission, grading or cleanup engine is created.

## Durable identity and retries

File-only `20261106_06_catalog_homework_context.sql` adds nullable JSON
`catalog_context`, nullable ASCII binary CHAR(36) `catalog_request_key` and unique
`(tenant_id,student_enrollment_id,catalog_request_key)` to original submissions.
The original submission INSERT and audit include the context/key atomically.
Context is exactly user, tenant, enrollment, course, lesson, content, assignment;
it is not attached later or supplied by the client. Existing version uniqueness
and assignment/enrollment attempt policy still apply across lessons and keys.

A committed identical key/context/file retry returns its current receipt without
signing again, inserting, or auditing creation again. A reused key for a different
file/context is 409 `CATALOG_REQUEST_CONFLICT`. Revoking/cancelling a version does
not reset its receipt: a genuinely new allowed version needs a new key. Concurrent
initial calls still serialize course/authority/version admission and cannot
create two rows with one key; a losing call may receive access/policy/conflict
denial and must inspect its receipt, not assume a new slot.

Unknown write/commit result returns 503 `PERSISTENCE_UNCERTAIN`; read the request
receipt or own history before deciding another action. GET recovery never
finalizes/re-authorizes/creates. A missing receipt means no matching committed
row is currently visible, not proof that a still-running write was rolled back.
Recovery requires current authority. A lost authority or removed reference can
therefore prevent recovery; there is no authority bypass for uncertainty.

Historical unbound submissions are never backfilled, attached or exposed as a
catalog version. They continue to count toward original admission policy. Generic
student assignment resource routes deny assignments with a current catalog
reference or a persisted context, including encoded selectors and after detach.
Metadata listings and authorized staff history/grade/revoke retain original
policy. Production now resolves exact selected enrollment rather than first row.

## Admission, verification and runtime gates

Actual schema probes require JSON context, ASCII binary request key, original
unique version/primary indexes, new request uniqueness, InnoDB, and the declared
ETag VARCHAR(256) / `utf8mb4_0900_bin` boundary. Shared lesson proof retains its
own schema checks. Partial/wrong schema fails closed; a file is not readiness.

Catalog POST additionally requires a configured object store that declares exact
version deletion and implements it, declared ETag persistence, and an explicit
durable cleanup store. The existing production composition does **not** supply
the last two ports, so this new upload journey remains unconfigured even if only
the context migration were applied. No provider or recovery worker is activated.

Creation rechecks current policy, complete bounded history and next version on
the write connection. Finalize rechecks policy and server deadline after scanning,
inside the transaction: starting before a deadline cannot extend it. Context
proof surrounds provider-derived success responses and guards verdict writes.
Withdrawal during scan cannot persist a clean verdict. Original stat/type/size/
magic-byte/ETag race checks and exact-version cleanup remain in force.

No scanner still means HTTP 202 `pending_scan`, never clean; a trusted injected
scanner is the only clean path. Completed retries reuse recorded facts rather
than scanning again. Cancellation may settle cleanup after its own commit;
server-owned cleanup is not a renewed student access grant.

History/admission reads in the production boundary are capped at 1001; more than
1000 versions fails closed before policy is evaluated. The implementation does
not silently truncate history and reset allowances. This also applies to legacy
own-history reads using the production catalog dependency; isolated old fixtures
retain their old seam. No new paging or migration/backfill policy for very long
revoked histories is implied.

An issued signed URL cannot be recalled by an API access check: it can transfer
bytes until its existing TTL expires. Subsequent authorization/finalize/read is
still gated. This slice does not promise immediate storage-token revocation,
or orphan cleanup before actual durable cleanup schema/runtime acceptance.

## Acceptance and next slice

25 new actual-router/authority tests plus existing catalog/exam/upload/scanner
suites run under isolated I/O. Fixtures simulate rollback, serialized concurrency,
lost commit acknowledgements and trusted provider facts; they do not prove real
MySQL locking/JSON/index behavior, storage capabilities, scanner verdicts or load.
No browser/upload/provider acceptance. No student UI or progress completion here.

The actual picker, keyed create, isolated signed transfer, explicit verification,
re-authorization/cancel and read-only reconciliation are now implemented locally
in BUILD-28. The UI retains only the opaque request identity and never replays
unknown PUTs/writes automatically or redirects to legacy assignment routes.
Metadata is `submission_required`; actual schema/runtime/browser/load acceptance
and the next lesson-package announcement/audience work remain open.
