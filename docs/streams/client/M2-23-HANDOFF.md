# M2-23 handoff: scheduled lesson release, progression and student course access

Task: `client-m2-23-student-learning-path-20261023-01`

## Goal and before/after

Before: private unit/lesson metadata and explicit course publication exist, but lessons have no configured release instant or prerequisite, and students have no single server-authoritative course learning path.

After: an authorized teaching principal can configure an optional explicit UTC release instant and optional earlier active same-course lesson prerequisite. An authenticated student with the selected active approved workspace and an active `student_courses` row can read a fixed published-course learning path, open only released/unlocked lessons, and explicitly mark an accessible lesson complete. Completion is idempotent. Direct selectors fail closed. This batch does not infer payment, dates, timezone, attendance or enrollment.

## Exact allowed paths

1. `server/migrations/20261023_04_lesson_release_progress.sql`
2. `server/src/routes/course-lessons.ts`
3. `server/src/routes/student-course-access.ts`
4. `server/src/index.ts`
5. `server/tests/m2-lesson-release.test.ts`
6. `server/tests/m2-student-course-access.test.ts`
7. `src/lib/api-http.ts`
8. `src/features/catalog/course-lessons.ts`
9. `src/features/catalog/CourseLessonManager.tsx`
10. `src/features/catalog/student-learning-path.ts`
11. `src/pages/StudentContent.tsx`
12. `src/tests/m2-course-lesson-ui.test.ts`
13. `src/tests/m2-student-learning-path.test.ts`
14. `docs/streams/server/M2-B15-CONTRACT.md`
15. `docs/streams/client/M2-23-CONTRACTS.md`

## Required behavior

- Add one additive migration file only, never apply it. Add nullable lesson `release_at` and nullable self-referencing prerequisite, plus a unique student/lesson completion record with server completion instant. Existing lessons stay immediately released with no prerequisite; no backfill.
- Extend the private lesson transaction API/editor with explicit nullable UTC ISO release and nullable prerequisite. The prerequisite must be an active lesson in the same course, sort before the target, and not be self; reject invalid/cyclic configuration. Use server time for access decisions and epoch projection for stored instants. Audit actual changes atomically, make identical retries truthful no-ops, and destroy uncertain connections.
- Add a student-only router. Resolve identity solely from the authenticated principal's selected active approved `student_enrollment_id`; require a matching active `student_courses` row and a published active same-tenant course. Return bounded fixed course/unit/lesson DTOs only. A lesson is accessible when active, released by server time, and its prerequisite is complete. Locked/unreleased lessons expose metadata and a reason but no private description/content locator. Exact inaccessible reads and forged/foreign selectors return an indistinguishable 404.
- `POST /courses/:courseId/lessons/:lessonId/completion` accepts an empty body, succeeds only for the authenticated eligible student and currently accessible lesson, records the server instant once, and returns the same canonical result on retry. It grants no enrollment, payment status or access beyond progression.
- Replace `StudentContent`'s local-storage student selector with this strict server-authoritative learning-path adapter/controller. Preserve session/principal/target/dispose race fences, bounded states and duplicate completion blocking.
- No OTP, signup, enrollment creation/approval, payment, provider/upload/stream, live DB/network/browser/service, dependency install, Git/deploy, M3, automatic timezone/date policy or migration application.

## Impact, tests and done

- Hermetic server tests cover configuration validation, tenant/teaching scope, UTC/server-time boundaries, cycles, audit/cleanup, active selected student workspace, exact active course enrollment, publication, locked direct URLs, idempotent completion and fixed projections with DB/default/dotenv isolation.
- Client production tests cover strict DTO parsing, editor lifecycle, learning path states, stale principal/session/target replies and duplicate completion.
- Run both new server suites plus relevant unchanged course/unit/lesson/public suites, both client suites and scoped types. Stop all activity before MCP report; the report is not self-acceptance.
