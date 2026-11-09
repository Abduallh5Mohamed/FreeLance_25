# BUILD-37 — teacher-reviewed return draft from separate attendance/progress evidence

7 November 2026. Direct owner-authorized Codex continuation. Schedule remains
disabled. Partial J07 implementation, not durable/student delivery, independent
acceptance or completion of the business strategy.

## User outcome

Inside the existing open course-details dialog, the owner can page through the
course's eligible students, choose an explicit UTC period (maximum 31 days) and
read actual ended current-group attendance beside independent catalog progress.
Excused absence remains excused; missing marks are unrecorded, not absence.

The teacher manually chooses up to three incomplete/unlocked lesson steps and
optional whole-minute estimates. Unknown duration stays unknown. Preview and
explicit confirmed review re-read the evidence and selected lesson eligibility.
Changed attendance, duration, completion or access conditions reject stale review.

No reliable session-to-catalog-lesson relation exists in the inspected source,
so the system does not decide which lessons a student missed. Legacy lecture/
video progress is not used as catalog completion. Neither incompletion nor
viewing duration is treated as evidence of absence, comprehension or intent.

Reviewed success explicitly remains a **memory-only unsent draft**. Nothing is
saved, assigned, messaged, completed or unlocked. This is not a financial
subscription decision or permission to open a media source/exam.

## Changed files and architecture

- `server/src/routes/course-return-plan.ts` (new): injected private roster,
  preview and review routes; current active owner/caller/exact tenant course
  authority, strict bounded selectors, live enrolled student/current group and
  branch integrity, shared suspension predicate, fixed no-store DTOs and fully
  read-only transaction cleanup.
- `server/src/routes/tenant-self.ts`: mounts the new router after authentication
  under `/catalog`. Existing reserved student/lesson files were not edited.
- `src/features/catalog/course-return-plan.ts` (new): canonical private transports,
  input/response context/step validation and controller; bounded roster, exact
  student/window, up to three local steps, strict integer estimates, preview token
  lifecycle and principal/session/deadline/supersession fences.
- `src/features/catalog/CourseReturnPlan.tsx` (new): actual roster/date/evidence/
  lesson-selection/estimate/preview/confirmation UI. Bounded lesson evidence is
  displayed in local pages of 25. Source/status distinctions and unsent-memory
  limitations are explicit. Names/titles render as escaped text.
- `src/pages/Courses.tsx`: mounts the keyed return-draft panel only inside the
  open selected-course dialog next to the existing panels.
- `server/tests/course-return-plan.test.ts` (new): 20 real-route tests with the
  existing transaction fixture and explicit SELECT-only protocol. Scope, timing,
  private projection, attendance distinctions, separate progress, shared live
  lesson proof, changed review, schema/caps and cleanup failure are exercised.
- `src/tests/course-return-plan.test.ts` (new): 10 input/parser/controller/actual
  mounted callback tests, canonical HTTP, explicit review confirmation, strict
  estimates, scope/page/date invalidation, escaped names and stale/error/deadline/
  session/storage/disposal behavior.

Updated queue, README and FEATURE_MATRIX. Contracts:
[server](../streams/server/J07-COURSE-RETURN-PLAN.md),
[client](../streams/client/J07-COURSE-RETURN-PLAN.md).
All unrelated edits and old WorkBuddy reserved paths were preserved.

## Authority and evidence limits

The actor remains the owner throughout; no student request or token is fabricated.
The selected student's user/enrollment identity is derived from current server
rows. Existing `verifyStudentEnrollment`, `resolveStudentCourse` and
`proveStudentLesson` are reused with that server-derived scope. A published active
course association is required for preview/review. No new staff teaching grant.

Roster size is 25/page. Attendance includes at most 100 ended, noncancelled
group-audience sessions of the current group, tenant and [from,to) UTC window.
No historical membership reconstruction, attendance reason/correction/health
details, contact data or staff identities are returned. Stored UTC schedule
DATETIME is formatted by SQL, avoiding client-decoder timezone interpretation.

Catalog evidence includes at most 500 active lessons and only the selected
enrollment's `course_lesson_completions`. Release uses database epoch comparison;
prerequisite completion remains enrollment-bound. Selected steps additionally
run the shared current lesson proof. Oversized/duplicate/corrupt sets or missing
required source schemas fail closed instead of returning sampled completeness.

The review digest binds the actor, tenant, resource/enrollment/window/current
group, attendance evidence and selected titled steps/estimates. It is not an
authority grant or persisted receipt. Current checks run on both preview and
review; changed facts/eligibility produce 409. Checked-at is deliberately not
part of the digest. No attendance/progress/source write, audit or commit occurs.
Read/cleanup errors destroy the connection; all paths roll back read transactions.

Base lesson eligibility is not source delivery authority. Source-specific file,
video, activity, branch/audience and attempt checks still run at their original
student entry points. This panel contains no direct media/quiz link, question,
answer or key, and no prerequisite/subscription/completion mutation.

## Verification

Installed compatible Node v24.19.0 from repository root. No installation.
Final commands exit 0; the final backend regressions followed the shared
suspension-predicate string-compatibility fix (regex replacement instead of
`replaceAll`, matching the server's configured TypeScript library).

```powershell
$businessNode='C:/Users/BaraaWael/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node.exe'
& $businessNode --import ./node_modules/tsx/dist/loader.mjs --import ./server/tests/helpers/isolated-io-guard.ts --test --test-reporter=spec server/tests/course-return-plan.test.ts server/tests/lesson-learning-evidence.test.ts server/tests/lesson-preparation.test.ts server/tests/lesson-package-templates.test.ts server/tests/lesson-package-reuse.test.ts server/tests/lesson-package-timing.test.ts server/tests/m2-course-units.test.ts server/tests/m2-course-lessons.test.ts server/tests/m2-course-lessons-reorder.test.ts server/tests/m2-lesson-release.test.ts server/tests/m2-public-catalog-composition.test.ts
$frontendTests=@(Get-ChildItem src/tests/*.test.ts | ForEach-Object {$_.FullName}) + @('src/auth/access-control.test.ts')
& $businessNode --import ./node_modules/tsx/dist/loader.mjs --test --test-reporter=spec @frontendTests
& $businessNode ./node_modules/typescript/bin/tsc -p tsconfig.app.json --noEmit
& $businessNode ./server/node_modules/typescript/bin/tsc -p server/tsconfig.json
& $businessNode ./node_modules/vite/bin/vite.js build
```

| Check | Result | Log |
|---|---|---|
| Listed backend regressions | 358 pass / 0 fail | `output/build37-backend.log` |
| Full frontend command | 2165 pass / 0 fail | `output/build37-frontend.log` |
| New scoped backend / frontend | 20 / 10 pass | `output/build37-focused-{server,client}.log` |
| Frontend types / server compilation | pass | `output/build37-{client,server}-types.log` |
| Vite | pass, existing chunk warning | `output/build37-vite.log` |

Main chunk about 3,813 kB minified / 1,084 kB gzip remains an unresolved performance
concern. No browser-latency inference. The known separately documented premium
lecture backend test failure was not fixed/reclassified; scoped passing checks
are not a declaration that the entire backend passes.

## Remaining

Next J07 work: durable versioned plan storage, atomic audit and operation receipt,
unknown-write recovery and authorized student read under current enrollment, then
student/family availability and actual plan-start/completion measurement. Later
concept/question-to-explanation links need explicit teacher review and media/
assessment secrecy/access contracts. This draft adds none implicitly.

Real schema/engine/index/locking/query plans, browser/device and usefulness
acceptance remain open. No Git/GitHub, DB or migration execution, provider,
deployment, packages, external messages or paid/model/account action occurred.
No schedule restart or unrelated pending-marker deletion occurred.
