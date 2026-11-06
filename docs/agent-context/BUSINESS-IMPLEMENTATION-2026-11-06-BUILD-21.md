# Business implementation — 2026-11-06, BUILD-21

Continues [BUILD-20](BUSINESS-IMPLEMENTATION-2026-11-06-BUILD-20.md).
[Player contract](../streams/client/J03-STUDENT-CATALOG-VIDEO-PLAYER.md),
[execution queue](BUSINESS-EXECUTION-QUEUE.md).

## Result and limits

The actual student learning path now has an explicit lesson-video panel and
catalog playback through the existing secure player. Candidates remain a private
bounded metadata projection and now say `session_required`, not production-ready.
Opening a confirmed row sends only the course/lesson/reference tuple and device
binding. There is no generic or direct-URL fallback. The client also understands
older `unconfigured` responses without a playback action.

The actual session route now challenges missing consent before resolution would
hide it behind 404. Consent is explicit and single flight; only a confirmed current
acceptance issues a new catalog request. Existing fresh consent checks remain.

The player validates the same-origin manifest/session/token binding and initial
server forensic watermark. It owns refresh/heartbeat, request/readiness deadlines,
HLS/native source handling and scope/unmount/close fences. Revocation, unavailable
runtime, malformed replies, network or media failures stop media with an honest
message. Ordinary playback failures do not force account logout. Refresh preserves
position/play intent without changing video identity. No progress writes.

No migration was added or applied. Earlier reference/session schema remains
unapplied. No provider or live DB was called; this is local implementation and
synthetic verification, not actual media/schema/browser/device/load acceptance.

## Changed files

| File | Change |
|---|---|
| `src/features/catalog/catalog-video-playback.ts` (new) | Exact request/response boundary, protected POST, consent/session/refresh/heartbeat lifecycle |
| `src/features/catalog/student-lesson-videos.ts` (new) | Strict private metadata parser, explicit read/selection and session fence |
| `src/features/catalog/StudentLessonVideos.tsx` (new) | Actual collapsed student panel and selected catalog player |
| `src/components/SecureVideoPlayer.tsx` | Typed catalog mode, real HLS/native lifecycle, server watermark, error/consent/close states; legacy entry mode retained |
| `src/pages/StudentContent.tsx` | Mount videos only on accessible lesson rows |
| `src/lib/api-http.ts` | Canonical no-store authenticated lesson-video metadata read |
| `server/src/services/student-lesson-videos.ts` | Candidate status becomes `session_required`, with unchanged locator-free projection |
| `server/src/routes/secure-video.ts` | Existing consent challenge before catalog resolution |
| `src/tests/catalog-video-playback.test.ts` (new) | Controller, parsers, exact transport, denial/consent/lifecycle/rotation cases |
| `src/tests/student-catalog-video-ui.test.ts` (new) | Actual panel SSR/effects, actual player catalog effect, consent button and late-response cleanup |
| `server/tests/student-lesson-videos.test.ts`, `server/tests/m2-student-course-access.test.ts` | Exact updated metadata status |
| `server/tests/m1-media-socket-regressions.test.ts` | Missing consent must challenge before calling a resolver that would refuse it |

Context updates: this record, player contract, README, FEATURE_MATRIX, strategy 22,
execution queue and BUILD-19/20 contract/record continuation pointers.

## Fresh commands and results

Installed Node v24.19.0; no installation. Run commands independently as needed:

```powershell
$businessNode = 'C:/Users/BaraaWael/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node.exe'
& $businessNode --import ./node_modules/tsx/dist/loader.mjs --test --test-reporter=spec src/tests/catalog-video-playback.test.ts src/tests/student-catalog-video-ui.test.ts src/tests/student-lesson-contents.test.ts src/tests/student-pdf-download.test.ts src/tests/lesson-videos.test.ts src/tests/m1-session-contract.test.ts
& $businessNode --import ./node_modules/tsx/dist/loader.mjs --test --test-reporter=spec src/tests/*.test.ts src/auth/access-control.test.ts
& $businessNode ./node_modules/typescript/bin/tsc -p tsconfig.app.json --noEmit
& $businessNode ./node_modules/vite/bin/vite.js build
```

Focused frontend: **88 pass / 0 fail**, including 21 new playback/UI cases.
Full frontend test command: **1931 pass / 0 fail** on the final run.
Frontend typecheck and Vite build passed. Vite still warns about large chunks;
the main generated JS chunk is about 3.63 MB / 1.03 MB gzip. This slice does not
claim a bundle-size or loading-performance improvement.

```powershell
& $businessNode --import ./node_modules/tsx/dist/loader.mjs --import ./server/tests/helpers/isolated-io-guard.ts --test --test-reporter=spec --test-name-pattern 'catalog|generic fallback|student video metadata' server/tests/catalog-video-session.test.ts server/tests/student-lesson-videos.test.ts server/tests/m1-media-socket-regressions.test.ts server/tests/m3-playback-revocation-delivery.test.ts
& $businessNode --import ./node_modules/tsx/dist/loader.mjs --import ./server/tests/helpers/isolated-io-guard.ts --test --test-reporter=spec server/tests/student-lesson-videos.test.ts server/tests/m2-lesson-videos.test.ts server/tests/m2-lesson-contents.test.ts server/tests/m2-lesson-release.test.ts server/tests/m2-student-course-access.test.ts server/tests/m2-course-lessons.test.ts server/tests/m2-course-lessons-reorder.test.ts server/tests/m2-course-units.test.ts server/tests/m2-course-publication.test.ts server/tests/m2-public-course-discovery.test.ts
& $businessNode --import ./node_modules/tsx/dist/loader.mjs --import ./server/tests/helpers/isolated-io-guard.ts --test --test-reporter=spec server/tests/catalog-video-session.test.ts server/tests/m1-media-socket-regressions.test.ts server/tests/m3-playback-revocation-delivery.test.ts
& $businessNode ./server/node_modules/typescript/bin/tsc -p server/tsconfig.json
```

Scoped video/metadata: **29 pass / 0 fail**. Ten catalog suites: **457 pass / 0
fail**. Server compile/build passed. Broader video regression remains **156 pass /
1 fail**, the same premium-lecture creation fixture observed in BUILD-20 (expected
201, got 403 because its destination-course proof is absent). It was rerun here;
there is no whole-backend-green claim or relaxed premium authorization.

Transcripts: `output/catalog-video-build21-frontend.txt`,
`output/catalog-video-build21-all-frontend.txt`, `output/catalog-video-build21-server.txt`,
`output/catalog-video-build21-video-regressions.txt`, `output/catalog-video-build21-vite.txt`.
UI verification uses actual TSX effects/button handlers with hook/media fixtures
and SSR, not an actual browser or real HLS provider.

## Next work

The immediate J03 owner-to-student catalog-video implementation is now local,
conditional code. Real schema/provider/source/device/load acceptance, samples and
interruption policy remain separate open work. No catalog or legacy progress is
combined and no lesson is completed automatically.

Next local product work: return to J02's lesson bundle and inspect the existing
homework/quiz contracts and source before binding those contents. Do not duplicate
assessment engines or infer a catalog ID is a legacy assignment ID. Other J00–J10
journeys remain tracked in the queue. No Git/GitHub, deployment, migration
application, package installation, provider activation or spending.
