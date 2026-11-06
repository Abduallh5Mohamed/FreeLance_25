# BUILD-34 — saved lesson templates, reviewed application and truthful recovery

6 November 2026. The user explicitly transferred implementation to Codex after
OpenCode's usage block. This is local implementation/verification evidence,
not independent acceptance, an OpenCode task submission or production approval.
[Owner handover](CODEX-BUSINESS-HANDOVER-2026-11-06.md).

## User outcome

The owner can save selected references from a lesson as a private same-course
template, append immutable revisions, archive it, explicitly select a loaded
revision and apply it to a destination lesson after current review/confirmation.
Keep/set/clear timing applies to that destination only. Original content,
publication, audience, quiz pin, student progress, submissions and attempts are
not cloned or granted. The five reference kinds share the existing source policy.

A lost or malformed write response no longer claims that nothing was saved.
Create/revise/archive/apply preserve the operation and freeze conflicting actions;
GET receipt lookup reconciles the exact historical operation. Missing receipt
does not authorize a new write. Confirmed success is kept separate from failure
to refresh a list, and stale lists are cleared.

## Source and architecture

Preserved the original batch-A mounts, timing editor, migration 10 and partial
correction source; completed the correction instead of rewriting another worker's
unrelated work. Old WorkBuddy reserved files were not edited.

Product files changed in this continuation:

- `server/src/services/lesson-package-templates.ts`: complete library outcomes,
  payload/actor/course/kind-bound receipts and GET recovery, archive no-change
  receipt commit, strict physical schema validation, stored content hash/count/
  position checks, shared planner integration, review/receipt context and stronger
  replay binding. Revision success now includes the complete template name;
  replay and initial success have the same outcome shape.
- `server/src/routes/lesson-package-templates.ts`: new private no-store library
  operation lookup under live owner/course proof on the transaction connection.
- `server/migrations/20261106_11_lesson_template_operations.sql`: additive library
  receipt table; FILE ONLY, not applied.
- `src/features/catalog/lesson-package-templates.ts`: keyed library writes,
  bounded read/write/archive deadlines, uncertain states and read-only recovery,
  principal invalidation, bounded page replacement, external locks, strict context
  and timing matching for application review/receipts.
- `src/features/catalog/LessonPackageTemplates.tsx`: stable parent/source/dialog
  lock propagation, guarded navigation and close, explicit paged revision selection,
  cleared approval on selection changes, fenced manual reads, storage/session
  cleanup and private-data removal. Confirmed library saves close the completed
  editor; pending/uncertain saves retain their recovery context.
- `src/features/catalog/lesson-template-timing.ts`: reject overflowing time fields
  and values outside server timestamp range; normalize milliseconds to the same
  server seconds rather than displaying a precision the server does not store.
- `src/pages/Courses.tsx`: template child lock guards the actual enclosing dialog's
  `onOpenChange`, close button and replacement course selection; session cleanup
  still takes precedence over write-context retention.

The shared `server/src/services/lesson-package-reuse.ts` extraction from the
preserved partial correction is part of the resulting architecture: both direct
reuse and templates use `planLessonPackageFinalState` and the same reference
insert path. Its existing route contract remains tested. Tenant-self mounts
the private template router next to the existing lesson router after auth;
Courses mounts the keyed template panel only inside open course details. Neither
uses a client tenant selector as authority.

Tests changed/added:

- `server/tests/lesson-package-templates.test.ts`: transactional fixture now
  serializes synthetic connections, snapshots mutable rows and restores rollback;
  lost commit ACK preserves durable rows and requires connection destruction.
  Physical column metadata derives from the unapplied DDL independently of the
  service schema spec, with incompatible-type/FK/index/engine overrides.
- `src/tests/lesson-package-templates.test.ts`: library recovery/deadline/locks,
  bounded pages, silent principal changes, exact response context and existing
  application/parser/transport regression coverage.
- `src/tests/lesson-package-template-panels.test.ts`: actual parent, source,
  application and Courses-dialog effects/callbacks, canonical HTTP transports,
  explicit revision paging, lost writes, GET recovery, storage/session invalidation
  and parent/internal close controls. Unrelated course loading/toast/header are
  isolated for the actual Courses callback test; no browser is claimed.
- `src/tests/lesson-template-timing.test.ts`: matching server range/precision and
  overflow regression cases.

Updated server/client template contracts, README, FEATURE_MATRIX, execution queue
and the maintained supervision note. Historical rejected reports remain historical.
The external continuation prompt now follows the user's direct Codex ownership;
OpenCode is not restarted. Cadence remains the existing fifteen-minute schedule,
conditional on the machine being awake/logged in and queue availability.

## Behavior proved locally

- Create/revise/archive lost commit ACK: explicit uncertainty, connection destroy,
  matching GET receipt and replay without a second write/audit/version.
- Changed payload/kind/actor/course cannot reuse another operation; competing
  identical creates commit once, competing expected-head revisions advance once.
- Version/reference, timing, shared audit and receipt failures roll back stored
  state. Archive/revision failures restore status/head and version data too.
- All five kinds reuse original positions/audiences; stale source facts, audience,
  destination bindings and timing invalidate review. Position/capacity/singleton/
  unavailable-source conflicts produce no partial mutation.
- Malformed stored positions, counts, reference identity and content hash fail
  before mutation. Incompatible schema types/nullability/length/collation/enums,
  indexes/FKs and engines fail closed.
- Parent create/revise/archive/refresh/paging, source controls and close handlers
  preserve pending context; the enclosing course dialog refuses ordinary closure.
- History responses do not auto-select a revision. First/next pages replace the
  bounded visible page; page/template/revision/timing changes clear approval.
- Session/storage/silent identity changes prevent late reads/results restoring
  private rows or source/template/destination metadata. Missing/failed recovery
  remains uncertain; archive timeout does not unlock a fresh write.

## Exact verification

All commands ran from the repository root using the installed compatible
Node **v24.19.0**. No packages installed. Exit **0** for each final command:

```powershell
$businessNode='C:/Users/BaraaWael/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node.exe'
& $businessNode --import ./node_modules/tsx/dist/loader.mjs --import ./server/tests/helpers/isolated-io-guard.ts --test --test-reporter=spec server/tests/lesson-package-templates.test.ts server/tests/lesson-package-timing.test.ts server/tests/lesson-package-reuse.test.ts server/tests/m2-course-units.test.ts server/tests/m2-course-lessons.test.ts server/tests/m2-course-lessons-reorder.test.ts server/tests/m2-lesson-release.test.ts server/tests/m2-public-catalog-composition.test.ts
$frontendTests=@(Get-ChildItem src/tests/*.test.ts | ForEach-Object {$_.FullName}) + @('src/auth/access-control.test.ts')
& $businessNode --import ./node_modules/tsx/dist/loader.mjs --test --test-reporter=spec @frontendTests
& $businessNode ./node_modules/typescript/bin/tsc -p tsconfig.app.json --noEmit
& $businessNode ./server/node_modules/typescript/bin/tsc -p server/tsconfig.json
& $businessNode ./node_modules/vite/bin/vite.js build
```

Final results:

| Check | Result | Log |
|---|---|---|
| Listed backend regression suites | 302 pass / 0 fail | `output/build34-backend.log` |
| Full frontend suite above | 2137 pass / 0 fail | `output/build34-frontend.log` |
| Frontend types | pass | `output/build34-client-types.log` (empty success) |
| Server types/build compilation | pass | `output/build34-server-types.log` (empty success) |
| Vite production build | pass, existing chunk warning | `output/build34-vite.log` |

The main minified chunk is about 3,778 kB (gzip 1,074 kB); this remains an
unresolved performance concern, not a measured browser-load result. Earlier
system-Node `registerHooks` failures were runtime incompatibility and are
superseded by this compatible-Node frontend run. No entire-backend passing claim:
the separately documented premium-lecture test failure was not fixed or reclassified.

## Limits and next

No Git/GitHub, DB access, migration execution, real provider, deployment,
installation, payment activation, actual browser/device test, real MySQL
locking/isolation/query-plan or load test occurred. Synthetic transaction tests
are not proof of production concurrency or applied schema. The runtime refuses
missing/incompatible schemas. No production-readiness or independent-review
acceptance is inferred from these local checks.

Operation context remains in memory after page/route departure; the best-effort
beforeunload warning is neither cancellation nor durable recovery. A historical
receipt is not the current mutable lesson/library state; other panels need fresh
reads. Actual field value/time-saving measurement and broader J01–J10 journeys
remain open in the queue. Next local journey: J05 teacher preparation summary,
starting with the current source/authority contract and using only available
authorized data. External sample/media/schema acceptance remains separate.
