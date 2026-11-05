# Business implementation — 2026-11-06, BUILD-19

Continuation: [BUILD-20](BUSINESS-IMPLEMENTATION-2026-11-06-BUILD-20.md) implements
catalog session/refresh/media/heartbeat integration. This record remains the
historical metadata/proof slice; student player and external acceptance are open.

Continues [BUILD-18](BUSINESS-IMPLEMENTATION-2026-11-06-BUILD-18.md). [Student catalog-video proof contract](../streams/server/J03-STUDENT-CATALOG-VIDEO-PROOF.md), [execution queue](BUSINESS-EXECUTION-QUEUE.md).

## Result and limits

The actual student router now serves bounded, private lesson-video metadata after a shared fresh catalog/access/source proof. It explicitly reports `playback_status:unconfigured`; no URL, video ID, token or media is returned. A server-private selected-reference proof uses the same implementation for future session issuance/delivery and does not act as a grant by itself.

Proof covers live student identity/version/suspension, active approved/windowed enrollment, active course link, course publication, active lesson/unit, release/prerequisite, own group/course/tenant and existing live branch/membership policy, explicit reference and same-course/same-tenant source with no legacy parent conflicts. Mixed references stay within 20 distinct positions. A candidate needs ready/encrypted metadata and distinct HLS/original source keys. Eligibility is freshly read; withdrawal is observed on the next proof and nothing is cached as authority.

The legacy resolver cannot safely be given a catalog lesson ID. Accordingly the existing secure-video session, entitlement, preview, refresh and byte-delivery handlers remain unchanged. This slice **does not complete playback** and adds no student play button or separate unprotected media route.

## Changed files

| File | Change |
|---|---|
| `server/src/services/student-lesson-videos.ts` (new) | Shared batched student/reference/source proof, fixed metadata projection and selected-reference proof |
| `server/src/routes/student-course-access.ts` | Actual no-store student videos endpoint and strict selector boundary |
| `server/tests/student-lesson-videos.test.ts` (new) | Identity/enrollment/lesson/schema/source/group/branch/revocation/limit cases and constant statement count for one/twenty references |
| `server/tests/m2-student-course-access.test.ts` | Actual mounted auth/selector/DTO/schema/withdrawal cases and explicit route inventory |

Context: this record, proof contract, README, FEATURE_MATRIX, strategy 22, execution queue and prior-build pointer.

## Verification

Installed Node v24.19.0, no installation. Commands:

```powershell
$businessNode = 'C:/Users/BaraaWael/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node.exe'
& $businessNode --import ./node_modules/tsx/dist/loader.mjs --import ./server/tests/helpers/isolated-io-guard.ts --test --test-reporter=spec server/tests/student-lesson-videos.test.ts
& $businessNode --import ./node_modules/tsx/dist/loader.mjs --import ./server/tests/helpers/isolated-io-guard.ts --test --test-reporter=spec server/tests/m2-student-course-access.test.ts
& $businessNode --import ./node_modules/tsx/dist/loader.mjs --import ./server/tests/helpers/isolated-io-guard.ts --test --test-reporter=spec server/tests/student-lesson-videos.test.ts server/tests/m2-lesson-videos.test.ts server/tests/m2-lesson-contents.test.ts server/tests/m2-lesson-release.test.ts server/tests/m2-student-course-access.test.ts server/tests/m2-course-lessons.test.ts server/tests/m2-course-lessons-reorder.test.ts server/tests/m2-course-units.test.ts server/tests/m2-course-publication.test.ts server/tests/m2-public-course-discovery.test.ts | Select-Object -Last 9
$catalogTestExit = $LASTEXITCODE
exit $catalogTestExit
```

Backend compile command (run independently, not after the shell exit above):

```powershell
& $businessNode ./server/node_modules/typescript/bin/tsc -p server/tsconfig.json
```

Narrow fresh results: **35 proof tests and 98 actual student-router tests passed**, zero failures. The final broadened ten-suite catalog/proof run passed **457 tests / 0 failures**. Backend TypeScript compile passed and emits the server build. No frontend source, browser or frontend build was changed/run in this slice; no inherited frontend result is presented as new evidence.

Service tests use synthetic SQL under isolated I/O guard and run actual shared policy/helpers. Router tests use the existing real authentication/tenant/workspace chain with only leaf DB fixtures; no actual SQL, network listener, provider, environment file or migration. Cases include fixed no-locator DTO, exact server identity and selectors, source/reference withdrawal, token/version suspension, locked/prerequisite lessons, missing/unclassified/foreign group, active/revoked/version-mismatched branch membership, absent/invalid schema, unencrypted/legacy source denial, bounded mixed references and no N+1 query growth. Reads create no token, session, audit write or completion.

## Readiness and next work

No migration in this slice; BUILD-17 schema is still an unapplied file. Missing actual required schema returns unavailable. No Git/GitHub, live DB, provider, deployment, package installation, migration application or spending.

Next: durable catalog-bound session context, issuance/refresh and per-media request proof retaining consent/device/session/entitlement/rate controls and denying noncatalog fallback for restricted references. Actual student playback/UI remains pending until that contract is enforced. Current login-session binding at delivery, HLS source/byte/version validation and post-provider revocation checks are not supplied by this request metadata proof. Real FK/index/query-plan/locking/load acceptance and the wider business plan remain open.
