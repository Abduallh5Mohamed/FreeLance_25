# M4 A1 / A5 Delivery

## Scope
- A1 reusable, tenant-owned question bank (kinds, tags, versioning, archive, export/import)
- A5 assignments with private file submissions (late/resubmission policy, versioned submissions, revoke)

## Files
- server/src/services/question-bank.ts
- server/src/routes/question-bank.ts
- server/src/services/assignments.ts
- server/src/routes/assignments.ts
- server/migrations/20261018_08_question_bank_assignments.sql
- server/tests/m4-question-bank.test.ts
- server/tests/m4-assignments.test.ts
- server/bootstrap/m1/manifest.json (reviewed manifest inventory update)

## Behavior
- Question bank is tenant-owned and reusable across courses/branches; kinds are single_choice, multiple_choice, true_false and essay; tags are normalized; a version becomes locked once it is used by a release, and visibility is deny-by-default per tenant/branch ownership.
- Assignments carry a local deadline rendered to UTC via the shared timezone helpers; late policy is block / mark_late / accept, and only one of branch, group or course scope may apply at a time.
- Submissions are private: only an internal storage_key is persisted and it is never projected in any response; students submit versioned entries under the assignment window, with resubmission policy and max-submissions enforced and revoked versions re-opening a slot; staff and student lists are scoped to the caller.
- Authorization derives from the verified principal; every sensitive mutation writes an audit event and an audit failure aborts the write (500) rather than committing unaudited.

## Tests
- A1/A5 pure domain tests plus route allow/deny, cross-tenant, validation and failure cases pass.
- Full suite: 1585 tests, 0 failures.
- Typecheck: tsc --noEmit clean.

## Deferred
- Storage/file scanning providers remain injected metadata only; no real object-store or AV integration.
- Migration is authoring-only (idempotent INFORMATION_SCHEMA guards + PREPARE/EXECUTE); it is not executed.
- Routers export a factory plus a default-wired instance and are not mounted in index.ts per task rules.
