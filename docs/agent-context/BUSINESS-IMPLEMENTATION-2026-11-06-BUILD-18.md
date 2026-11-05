# Business implementation — 2026-11-06, BUILD-18

Continues [BUILD-17](BUSINESS-IMPLEMENTATION-2026-11-06-BUILD-17.md). [Owner video contract](../streams/server/J02-LESSON-VIDEO-PREPARATION.md), [execution queue](BUSINESS-EXECUTION-QUEUE.md).

Follow-up: [BUILD-19](BUSINESS-IMPLEMENTATION-2026-11-06-BUILD-19.md) adds a fresh shared student catalog-video proof and actual private metadata route. It does not issue a session/token or deliver media; protected playback integration remains next.

## Result

The actual `CourseLessonManager` now mounts a collapsed owner video-reference editor per lesson. Opening reads video references, the existing material subset and one bounded eligible-video page. It shows processing/source status without a play button or locator, supports explicit selection/position and confirmed detach, and explains that preparation neither activates student playback nor changes progress.

Material and video snapshots determine the displayed combined count and occupied positions. Local validation rejects malformed/partial numeric input, unlisted/duplicate sources, occupied material/video positions and the combined 20-reference ceiling before a request. These are UI guards, not authority: separate reads are not an atomic snapshot and the existing server transaction repeats live scope/order/count proof.

Single-flight operations and strict DTO/acknowledgement parsing fence duplicate/stale responses. Confirmed persistence followed by a failed refresh stays confirmed, hides obsolete rows and blocks another write until successful refresh. A later successful read replaces obsolete failure copy. Unknown/malformed/failed commit responses never trigger automatic resend; the owner must explicitly refresh before deciding again. A current GET does not prove whether a historical request will commit; there is no immutable attempt receipt or cross-reload recovery claim in this reference editor.

Controller/principal/session/disposal boundaries clear private views and abort transport. A keyed editor binds immutable course/unit/lesson targets. Source-unavailable references have no foreign title and can be explicitly detached. Source selection pages are explicit; failed option reads clear choices and show an error instead of pretending the source catalog is empty. No drafts, reference payloads or new recovery keys are persisted in browser storage.

## Changed files

| File | Change |
|---|---|
| `src/features/catalog/lesson-videos.ts` (new) | Strict video/reference/option DTOs; mixed snapshots; fenced single-flight preparation controller |
| `src/features/catalog/LessonVideoManager.tsx` (new) | Collapsed actual editor, processing labels, shared positions/count, selection paging and explicit detach confirmation |
| `src/features/catalog/CourseLessonManager.tsx` | Actual per-lesson editor mount |
| `src/features/catalog/LessonContentManager.tsx` | Explain shared material/video positions and ceiling |
| `src/lib/api-http.ts` | Canonical video list/options/attach/detach APIs and optional abort signal on existing owner material read |
| `src/tests/lesson-videos.test.ts` (new) | DTO/transport/order/count, save/refresh separation, uncertainty, paging, permission/schema and read/write lifecycle fences |
| `tmp/owner-lesson-videos-browser.cjs` (new) | Real parent lesson manager/editor/controller/API browser journey with synthetic interception |

Context: this record, README, FEATURE_MATRIX, execution queue, strategy 22, video-contract UI continuation and preceding-build pointer.

## Verification

Installed Node v24.19.0; no installation. Exact scoped commands:

```powershell
$businessNode = 'C:/Users/BaraaWael/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node.exe'
& $businessNode --import ./node_modules/tsx/dist/loader.mjs --test --test-reporter=spec src/tests/lesson-videos.test.ts src/tests/lesson-contents.test.ts src/tests/m2-course-lesson-ui.test.ts src/tests/m2-student-learning-path.test.ts src/tests/student-lesson-contents.test.ts
& $businessNode ./node_modules/typescript/bin/tsc -p tsconfig.app.json --noEmit
& $businessNode ./node_modules/vite/bin/vite.js build
& $businessNode tmp/owner-lesson-videos-browser.cjs
```

Scoped frontend **186 pass / 0 fail**. Frontend TypeScript and Vite build passed with retained large-chunk/mixed-import/outdated Browserslist warnings. Main JS remains approximately 3.6 MB before gzip; no performance improvement or whole-project acceptance is claimed. No backend source changed and no backend/live-DB verification is claimed for this slice; BUILD-17 records its own previous backend evidence.

Browser fixture bundles the actual `CourseLessonManager`, new editor, controller and canonical API; responses are intercepted at a synthetic secure origin and other origins are aborted. It verifies no closed-editor video/material reads, exact bound paths and body, malformed order and occupied material position producing no POST, confirmed attach/failed refresh separation, explicit selector next page, unknown commit followed by read without resend, explicit detach confirmation preserving all source media, unavailable-source metadata, and authority-loss clearing. Two deliberate POSTs, one deliberate DELETE, **24 intercepted requests**, zero playback/media requests or draft persistence. No page errors or horizontal overflow at 390/1024 pixels. Mobile screenshot visually inspected.

Artifacts: `tmp/owner-lesson-videos-browser.html`, `tmp/owner-lesson-videos-{390,1024}.png`. Fixtures use synthetic rows/responses, not actual provider, backend or MySQL integration. The API tests use a stubbed fetch; the browser exercise proves the actual parent mount and form wiring, not only an injected controller.

## Readiness and next work

No schema, backend, provider or progress change in this slice. The BUILD-17 migration remains unapplied and the video UI reports unavailable when required proof is absent. No Git/GitHub, live DB, migration application, real provider, package installation, deployment or spending.

Owner video preparation UI is now implemented locally. The next slice is an explicit **catalog-aware student playback contract and path**, with fresh enrollment/course publication/release/prerequisite/source/group/branch proof at issuance and delivery. The existing legacy resolver does not supply a catalog lesson identity; there is no student play action here. Live media/schema/query-plan/load acceptance and the remaining lesson package types/business journeys remain open.
