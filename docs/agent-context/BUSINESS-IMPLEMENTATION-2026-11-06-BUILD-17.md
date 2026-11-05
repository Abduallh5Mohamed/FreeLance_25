# Business implementation — 2026-11-06, BUILD-17

Continues the next J02/J03 work recorded after [BUILD-16](BUSINESS-IMPLEMENTATION-2026-11-05-BUILD-16.md). [Owner video preparation contract](../streams/server/J02-LESSON-VIDEO-PREPARATION.md). [Execution queue](BUSINESS-EXECUTION-QUEUE.md).

Follow-up: [BUILD-18](BUSINESS-IMPLEMENTATION-2026-11-06-BUILD-18.md) implements the actual owner video editor locally. UI-pending statements below preserve this backend checkpoint; student playback is still a separate next slice.

## Result

The existing owner catalog router now mounts list, bounded available-video selection, attach and detach for explicit lesson-video references. Current source evidence supports same-course/same-tenant `videos` as the preparation source; unmounted provider-neutral assets are not silently mapped to courses. No legacy pointers/URLs or progress are rewritten.

Source preparation refuses foreign/not-ready videos and existing direct/reverse lecture/material associations. Video/material reference writes share the lesson lock, one order namespace and a combined 20-reference limit. Mutation and sanitized audit are atomic; identical current-state attachment is a no-op, conflicts have no write, and a lost commit acknowledgement reports uncertainty and discards the connection. Foreign source names are withheld while the owner can detach a stale reference.

This is the **backend preparation slice**, not a completed owner video editor or student playback feature. Existing student and secure-video endpoints remain unchanged. A processing state of `ready` is not a delivery authorization.

## Changed files

| File | Change |
|---|---|
| `server/src/services/lesson-videos.ts` (new) | Actual schema/engine/unique-index/source-PK gates, bounded shared positions and explicit video eligibility |
| `server/src/routes/course-lessons.ts` | Actual owner-only video routes, mixed material/video capacity/order enforcement, atomic audit and truthful unknown commit |
| `server/migrations/20261106_01_course_lesson_videos.sql` (new, unapplied) | Explicit typed lesson/video relation without legacy backfill |
| `server/tests/m2-lesson-videos.test.ts` (new) | Real router with synthetic transaction fixtures for source/authority/schema/DTO/replay/capacity/rollback/uncertain commit |
| `server/tests/m2-lesson-contents.test.ts` | Missing-new-schema compatibility, mixed write limits and actual authenticated tenant-self mounting for video verbs |

Context: this record, video contract, README, FEATURE_MATRIX, execution queue, strategy 22 and preceding J02/BUILD-16 follow-up pointers.

## Verification

Installed Node v24.19.0, no install. Commands actually used:

```powershell
$businessNode = 'C:/Users/BaraaWael/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node.exe'
& $businessNode --import ./node_modules/tsx/dist/loader.mjs --import ./server/tests/helpers/isolated-io-guard.ts --test --test-reporter=spec server/tests/m2-lesson-contents.test.ts
& $businessNode --import ./node_modules/tsx/dist/loader.mjs --import ./server/tests/helpers/isolated-io-guard.ts --test --test-reporter=spec server/tests/m2-lesson-videos.test.ts server/tests/m2-lesson-contents.test.ts
& $businessNode --import ./node_modules/tsx/dist/loader.mjs --import ./server/tests/helpers/isolated-io-guard.ts --test --test-reporter=dot server/tests/m2-lesson-videos.test.ts server/tests/m2-lesson-contents.test.ts server/tests/m2-lesson-release.test.ts server/tests/m2-student-course-access.test.ts server/tests/m2-course-lessons.test.ts server/tests/m2-course-lessons-reorder.test.ts server/tests/m2-course-units.test.ts server/tests/m2-course-publication.test.ts server/tests/m2-public-course-discovery.test.ts
& $businessNode ./server/node_modules/typescript/bin/tsc -p server/tsconfig.json
```

Initial narrow material suite: 29 pass; initial video/material run: **54 pass / 0 fail**. A subsequent source-primary-key gate added one refusal case, bringing these two narrow suites to 55 cases; both were included in the final combined nine-suite run, which passed with exit 0 and no failures. All seven listed existing catalog/publication/release/student suites also passed in that final isolated run. Backend TypeScript compilation passed after the final helper change and emits the backend build. No historical report count is reused as new regression evidence.

Tests execute the actual route factory and helpers with synthetic SQL; mounted tenant-self tests exercise real auth/dispatch and owner denial. The new serialized fixture checks duplicate-intent behavior under a fake parent transaction, not real MySQL locking. Source fixtures exercise canonical IDs, ready/scope/legacy conflicts, fixed no-locator projections, 25+6 selector pages, shared twentieth/overflow/conflicting positions, source withdrawal/detach, audit/insert rollback, and unknown commit/readback. The isolated I/O guard remained enabled; no actual database/provider/environment file was used.

No frontend source changed, so no frontend/browser/build acceptance is claimed for this backend-only slice. No student-playback test is claimed because that path is not implemented here. Runtime query-plan, scan-cost, FK/collation and production locking/load acceptance remain open.

## Readiness and next work

The new migration remains a file only. Missing actual video-binding schema yields unavailable; ordinary material behavior remains compatible when the new table is absent. Partial new schema fails closed for material attachment so it cannot ignore existing video references. No Git/GitHub, live DB, migration application, real provider, package installation, deployment or spending.

Next: owner video reference selector/editor using this contract, followed by catalog-aware student playback proof and delivery. Live storage/media setup and schema acceptance need their specific external authorization. Multiple contents and separate catalog/legacy progress remain unchanged; the rest of J02/J03 and the business strategy remain partial.
