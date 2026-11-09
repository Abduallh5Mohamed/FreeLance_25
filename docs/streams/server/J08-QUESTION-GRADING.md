# J08 — Owner question grading, BUILD-42

BUILD-43 activation update: the selected snapshot/manual-grade/audit/gradebook/
receipt prerequisites and queue index were applied ONLY to the owner's isolated
synthetic local demo after private before snapshots. Real MySQL/HTTP verified
concurrency, durable receipts, finalization and sealed audit; installed Chrome
verified the actual panel save. Source/production DBs were not changed. Later
unapplied/schema-gate statements below describe the original authoring checkpoint,
not current demo readiness. See [BUILD-43](../../agent-context/BUSINESS-IMPLEMENTATION-2026-11-07-BUILD-43.md).

Mounted by `tenant-self.ts` at `/api/tenants/me/catalog/grading`. This is an
owner workbench over the existing versioned manual-grading planner/SQL store,
not the legacy exam-question grading screen. No new scoring engine.

## Authority and reads

Every request uses authentication followed by a transaction proving the current
active tenant owner, active account, token version and suspension state. Staff
identity, students, billing-only and impersonated sessions are refused. Client
tenant/student/instructor headers do not grant scope and are rejected.

- `GET /exams?after=<uuid>`: 25 same-tenant active-course exam headers.
- `GET /exams/:examId/versions?after=<uuid>`: 25 published pinned versions.
- `GET /versions/:versionId/questions`: at most 100 essay question headers.
- `GET /questions/:questionRef/answers?after=<uuid>`: ten pending-review answers,
  latest revision, pinned question text/points/explanation; lookahead one.
- `GET /attempts/:attemptId/review`: existing finalizer's completeness and total,
  attempt version and opaque review token. This is not family publication.
- `GET /operations/:operationId`: historical outcome for the current owner who
  wrote that tenant-scoped operation, or null. Never retries a write.

All responses are no-store. Answer DTOs omit student identity, answer keys and
reviewer identity. Only supported short JSON-string responses are shown as text;
other payloads are not resolved to files/URLs. Oversized/malformed persisted
JSON may refuse the page rather than return partial evidence. Explanation is a
pinned explanation, not an approved rubric.

## Writes and recovery

`POST /attempts/:attemptId/grade` accepts exactly `operation_id`,
`expected_version`, `question_ref`, `points` (complete decimal string, at most
two places) and nullable `feedback` (at most 2,000 characters). Only pinned essay
answers pending review qualify. The original planner checks range/manual-review
status. CAS increments the displayed attempt version and appends a revision.

`POST /attempts/:attemptId/finalize` accepts exactly `operation_id`,
`expected_version`, `review_token`. A fresh complete preview is required. The
token binds current version, total and latest revisions. The original finalizer
and gradebook projection run once; `gradebook_linked=false` remains an explicit
outcome where that existing engine permits a skipped projection.

Revision/final status, gradebook projection where applicable, sealed audit chain
and immutable operation receipt share one connection and transaction. Receipt
payload contains outcome metadata, never feedback or answer text. Matching
canonical replay returns 200, new commit 201; changed payload/version conflicts
do not overwrite. Historical receipt recovery precedes current attempt lookup,
but still requires the live owner and matching original actor.

Uncertain commit acknowledgement destroys the connection without rollback of an
unknown committed outcome and returns 503 `PERSISTENCE_UNCERTAIN`. The client
must resolve by GET. A missing receipt is not permission to issue a fresh write.
Pre-commit write failures roll back; unexpected failures conservatively remain
uncertain to the caller. Reads roll back and release.

## Schema and limits

`20261107_03_exam_manual_operations.sql` is FILE ONLY, UNAPPLIED. It adds an
outcome-receipt table and the tenant/version/status/ID answer-queue index.
Runtime gates eight core transactional tables, operation columns/JSON result and
compound primary key, the queue index and exact answer/revision unique key
shapes. This does not prove every deployed column type or foreign key.

The existing engine bundle is preceded by bounded probes: 100 questions, 100
answers, 1,000 revisions, each with overflow lookahead. Missing schema/index or
overflow fails closed. MySQL query plans, actual lock behavior/deadlocks,
collations, audit/gradebook schema and load must be accepted on an authorized
environment before operational use. No migration or provider was activated.

## Remaining J08

Explicit grader assignment and scoped capabilities, approved rubric, post-final
reopening/impact review and family result publication are separate unfinished
contracts. This workbench must not be treated as authorization for them.
