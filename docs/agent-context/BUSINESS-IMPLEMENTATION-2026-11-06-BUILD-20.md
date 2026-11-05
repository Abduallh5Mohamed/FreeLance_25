# Business implementation — 2026-11-06, BUILD-20

Continues [BUILD-19](BUSINESS-IMPLEMENTATION-2026-11-06-BUILD-19.md).
[Contract](../streams/server/J03-CATALOG-VIDEO-SESSIONS.md),
[execution queue](BUSINESS-EXECUTION-QUEUE.md).

## Result

The actual secure-video router now supports explicit catalog lesson/reference
session requests, durable context in the original session INSERT, refresh and
fresh manifest/segment/key/heartbeat authorization. Catalog entitlement uses
the selected catalog lesson rather than a legacy-parent guess. Generic or
preview sessions cannot bypass a current catalog binding.

Fresh proof covers the BUILD-19 student/enrollment/publication/release/
prerequisite/group/branch/reference/source policy plus live login-session version,
consent, actual session schema and source metadata identity. Durable context is
checked against cache before use; source changes, login revocation, removed
references or unavailable authority deny. A post-acquisition check refuses
manifest/segment/key bytes when the catalog proof is withdrawn during the read.

No student playback UI, automatic completion, live provider activation or applied
migration. Metadata still explicitly reports playback unconfigured. The source
fingerprint is metadata identity, not a provider-byte/version guarantee. The wider
strategy remains incomplete and this report is not independent acceptance.

## Changed files

| File | Change |
|---|---|
| `server/src/services/catalog-video-session.ts` (new) | Exact selectors/context, fresh login/consent/catalog/source proof, durable binding and generic-fallback guard |
| `server/src/services/video-security.ts` | Context in the original INSERT, exact acknowledged catalog write, immutable copied cache context, no cache-only grant |
| `server/src/routes/secure-video.ts` | Actual issuance/refresh/media/heartbeat integration, catalog lesson entitlement and post-acquisition denial |
| `server/migrations/20261106_02_catalog_video_session_context.sql` (new, unapplied) | Nullable private JSON context; no backfill |
| `server/tests/catalog-video-session.test.ts` (new) | Real authority factory with isolated SQL fixtures, lifecycle/source/schema/consent/durable cases |
| `server/tests/m1-media-socket-regressions.test.ts` | Real delivery-router cases; dependency fixtures; legacy query-shape assertion restricted to its legacy SQL branch |
| `server/tests/m3-playback-revocation-delivery.test.ts` | Actual persistence ordering, immutable context, lost acknowledgement and invalid binding |

Context updates: this record, session contract, proof-contract continuation,
README, FEATURE_MATRIX, strategy 22, execution queue and BUILD-19 pointer.

## Fresh verification

Installed Node v24.19.0; no installation. All tests use the isolated I/O guard,
synthetic SQL/provider leaves and actual factories/handlers; no live DB or storage.

```powershell
$businessNode = 'C:/Users/BaraaWael/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node.exe'
& $businessNode --import ./node_modules/tsx/dist/loader.mjs --import ./server/tests/helpers/isolated-io-guard.ts --test --test-reporter=spec --test-name-pattern 'catalog|generic fallback' server/tests/catalog-video-session.test.ts server/tests/m1-media-socket-regressions.test.ts server/tests/m3-playback-revocation-delivery.test.ts
```

**28 passed / 0 failed** scoped catalog/session/delivery/persistence cases.
These include three post-acquisition revocation cases (manifest, segment, key),
scope/source overrides, unavailable authority, consent, generic/preview fallback,
entitlement/token/durable liveness and fixed-scope refresh.

```powershell
& $businessNode --import ./node_modules/tsx/dist/loader.mjs --import ./server/tests/helpers/isolated-io-guard.ts --test --test-reporter=spec server/tests/catalog-video-session.test.ts server/tests/m1-media-socket-regressions.test.ts server/tests/m3-playback-revocation-delivery.test.ts
```

Broader video regression: **156 passed / 1 failed (157 total)**. Open failure:
`premium lectures: creation requires ownership of the target group`, expected
201, received 403. Inspection finds this older fixture supplies group ownership
and branch classification but no result for the current premium route's
`SELECT course_id FROM groups` destination proof; the route denies before INSERT.
This slice does not change premium routing or relax that authority. It is an
observed failure, not a passing baseline or proof of an earlier test result.

```powershell
& $businessNode --import ./node_modules/tsx/dist/loader.mjs --import ./server/tests/helpers/isolated-io-guard.ts --test --test-reporter=spec server/tests/student-lesson-videos.test.ts server/tests/m2-lesson-videos.test.ts server/tests/m2-lesson-contents.test.ts server/tests/m2-lesson-release.test.ts server/tests/m2-student-course-access.test.ts server/tests/m2-course-lessons.test.ts server/tests/m2-course-lessons-reorder.test.ts server/tests/m2-course-units.test.ts server/tests/m2-course-publication.test.ts server/tests/m2-public-course-discovery.test.ts
& $businessNode ./server/node_modules/typescript/bin/tsc -p server/tsconfig.json
```

Ten catalog/student/owner suites: **457 passed / 0 failed**. Server TypeScript
compile/build passed. No frontend source changed; no frontend/browser checks are
claimed. Local output transcripts: `output/catalog-video-build20-scoped-tests.txt`,
`output/video-build20-tests.txt`, `output/catalog-build20-tests.txt`.

## Remaining work and limits

Next is the actual student player integration using the explicit reference tuple,
with consent/error/session lifecycle handling and no generic fallback. Metadata
readiness must be updated honestly with that integration. Catalog/legacy progress
remain separate and this slice adds no completion writes.

Migrations are files only, including the previous reference schema. Real engine,
FK/index/locking/concurrency/query-plan/load, object-version/source bytes, HLS,
multi-instance behavior and supported-device acceptance remain unverified. Fresh
per-media proofs add database work; there is no measured performance claim. A
revocation after streaming starts cannot recall already delivered bytes.

No Git/GitHub, package installation, live DB/provider, migration application,
deployment or spending. Other J00–J10 work remains in the execution queue.
