# M4 A2 / A3 Delivery

## Scope
- A2 timed exams with immutable, versioned snapshots (pinned question-bank versions, server-authoritative clock, one attempt per student per exam)
- A3 deterministic MCQ auto-grading (integer-hundredths scoring, essay to manual review, idempotent regrade)

## Files
- server/src/services/exam-snapshots.ts
- server/src/services/exam-grading.ts
- server/src/routes/exam-versions.ts
- server/migrations/20261018_09_exam_snapshots_grading.sql
- server/tests/m4-exam-snapshots.test.ts
- server/tests/m4-exam-grading.test.ts
- server/bootstrap/m1/manifest.json (reviewed manifest inventory update)

## Behavior
- Creating an exam version resolves each pinned `question_bank_versions` row into a frozen snapshot, storing the real `source_version_id` provenance; publishing sets the snapshot immutable and writes `question_bank_version_usages` so the pinned question-bank versions become locked.
- The server clock is the only authority: `opens_at` / `closes_at` bound availability, an attempt start mints `deadline = min(now + duration, closes_at)`, and a late manual submit is rejected; only the auto-submit path may capture answers inside the grace window.
- Audience and enrollment are deny-by-default: a student attempt requires a live, approved enrollment whose tenant matches the exam and whose group/branch matches an exam target (a tenant-wide exam matches any enrollment in the tenant); one attempt per exam per enrollment is enforced by a UNIQUE storage key.
- Grading runs from the snapshot only: all arithmetic is on integer hundredths (no float drift), single/true-false are all-or-nothing, multiple-choice honours optional partial credit or negative marking, and an essay (or unknown type) routes the attempt to `pending_review` with no auto score.
- A regrade re-applies only when the deterministic grading fingerprint changed, records an `exam_grading_runs` idempotency row keyed by the fingerprint, and is audited either way.
- Authorization derives from the verified principal (tenant owner/instructor for staff, owning student for attempts); every sensitive mutation writes an audit event and an audit failure aborts the write (500) rather than committing unaudited.

## Tests
- A2/A3 pure domain tests plus route allow/deny, cross-tenant, validation and failure cases for every handler.
- New: server/tests/m4-exam-snapshots.test.ts (28 tests) and server/tests/m4-exam-grading.test.ts (29 tests) both pass.
- Typecheck: tsc --noEmit clean.
- Full suite: 1665 tests, 1663 pass, 2 fail. Both failures are outside this task: `m1-bootstrap-plan.test.ts` fails because `20261018_10_gradebook_certificates.sql` is not yet in the reviewed manifest (another agent owns it), and `m4-certificates.test.ts` is another agent's in-progress feature. This migration (`20261018_09_*`) is registered in the manifest.

## Deferred
- The migration is authoring-only (idempotent INFORMATION_SCHEMA guards + PREPARE/EXECUTE); it is not executed against MySQL.
- The router exports a factory plus a default-wired instance and is not mounted in `index.ts` per task rules.
- No server-side auto-submit scheduler is included; the grace window decision is exposed via `evaluateAttemptPhase` / `isAutoSubmitDue` for a later mounting task.
