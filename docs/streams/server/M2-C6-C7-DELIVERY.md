# M2 C6+C7 — scheduled content release and sequential lesson unlocking (2026-10-18)

## Files changed
- `server/src/services/content-release.ts` — pure scheduling policy: release modes (`immediate`/`scheduled`/`manual`), IANA timezone validation, local wall-time to absolute UTC instant, tenant-local clock, `LessonReleasePolicy` builder and `evaluateLessonRelease` decision (closed on invalid schedule).
- `server/src/services/lesson-progress.ts` — C7 completion store (`isCompleted`, `completedLectureIds`, idempotent `recordCompletion` via unique key + `ER_DUP_ENTRY` detection).
- `server/src/routes/content-access.ts` — router factory `createContentAccessRouter(deps)` plus default-wired router; endpoints below; reused pure `evaluateContentAccess` policy so direct-URL access follows the same rules as listings.
- `server/migrations/20261018_03_content_release_progress.sql` — idempotent schema (see below).
- `server/tests/m2-content-release.test.ts` — unit + router rejection-path coverage.
- `docs/streams/server/M2-C6-C7-DELIVERY.md` — this note.

## Behavior
- **Scheduled drip release (C6):** a lesson is available only when its policy is `immediate`, already `released_at`, or a `scheduled` `release_at` instant has passed in the tenant's timezone. Server time is the authority; `release_at` is stored as an absolute UTC instant derived from the local wall time + IANA timezone. Invalid schedules fail closed.
- **Sequential unlocking (C7):** a lesson with `prerequisite_lecture_id` opens only after the prerequisite completion record exists for the same student enrollment. Direct `GET /lessons/:id` and list endpoints both consult the same `evaluateContentAccess` policy, so URL bypass is denied.
- **Denial semantics:** `NOT_YET_RELEASED` and `PREREQUISITE_REQUIRED` return `403`; missing/hidden/out-of-scope content returns `404`. Tenant, branch and enrollment scoping is deny-by-default from the verified principal.
- **Idempotency:** `lesson_completions` has `UNIQUE (student_enrollment_id, lecture_id)`; a duplicate insert is swallowed and no audit event is written. Release runs only audit for rows actually transitioned.
- **Audit:** completion creation and release configuration/materialization emit audit events only on real mutations.
- Unpublished lessons are hidden from listings and single-lesson reads.

## Endpoints
- `GET /lessons/:id` — single lesson, policy-gated.
- `GET /courses/:courseId/lessons` — listing, policy-gated per lesson.
- `POST /lessons/:id/complete` — records a completion (idempotent, audited once).
- `PUT /releases/:lectureId` — owner/instructor release policy upsert (validated, audited).
- `POST /courses/:courseId/releases/run` — materializes due scheduled releases; owner-scoped; audited once.

## Schema (file only, not executed)
- `lesson_release_policies` — PK `lecture_id`; `release_mode` enum, `release_at`, `release_timezone`, `prerequisite_lecture_id`, `released_at`, `version`.
- `lesson_completions` — `UNIQUE uq_lesson_completion (student_enrollment_id, lecture_id)`, index `idx_lesson_completion_course`.
- Idempotent via `INFORMATION_SCHEMA` guards + `PREPARE`/`EXECUTE`.

## Tests
- Focused: 62/62 pass.
- Full suite: 1296 pass / 1 fail — the sole failure is `m1-bootstrap-plan` #127, caused by this migration's hash not being registered in `server/bootstrap/m1/manifest.json` (see open question).
- Typecheck: `tsc --noEmit -p server/tsconfig.json` clean.

## Open questions / follow-ups
- **Manifest registration required.** `m1-bootstrap-plan.test.ts` requires every migration's source hash in `server/bootstrap/m1/manifest.json`. This stream is not permitted to edit the manifest. The owning bootstrap stream must add the entry:
  `"20261018_03_content_release_progress.sql": "7141df1388fb4f1c5c5046f6c0c761ebd57af1c3545dfc1688818cb218071644"`.
  Until then full-suite test #127 stays red.
- `release_timezone` defaults are assumed if the policy omits a timezone; product may prefer explicit failure.
- Release runner is request-scoped; a production scheduler (cron/queue) should invoke the same service, not the route.
