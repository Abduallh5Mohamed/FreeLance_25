# Assignment private storage — completion stream (2026-10-19)

Task: `server-assignment-private-storage-completion-20261019-01` (team storage,
worker `wb-assignment-storage-w2-20261019-01`). Completes the residual gaps of
`server-assignment-upload-finalize-20261019-01` (recorded in
`ASSIGNMENT-STORAGE-20261019.md`), in code only, hermetically.

## Before (verified gaps)

1. **Bucket provisioning.** `BUCKETS` in `server/src/services/minio.ts` had no
   assignment entry, so `initializeBuckets()` never created
   `MINIO_BUCKET_ASSIGNMENTS` (default `assignment-submissions`); the upload
   adapter's bucket would never exist in a fresh deployment.
2. **Object replacement between stat/header/scan/finalize.** The scanner input
   carried only the key/size/type/extension. A clean verdict for object
   version A could be recorded while the object at the same key had been
   replaced by a different (unverified) version B: nothing bound the verdict
   to the exact object version it was produced from.
3. **Unbounded scan.** `malwareScanner.scan(...)` was awaited with no wall-clock
   bound; a hanging adapter held the finalize request open indefinitely.
4. Scanner absence already failed closed (`202 pending_scan`, no download
   endpoint exists) — preserved unchanged.

## After

Files (all inside the task's allowedPaths):

- `server/src/services/minio.ts` — `BUCKETS.ASSIGNMENTS` wiring
  (`MINIO_BUCKET_ASSIGNMENTS`, default `assignment-submissions`);
  `initializeBuckets` refactored over an injected `BucketProvisioningClient`
  (`bucketExists`/`makeBucket` only — no policy capability exists in the
  surface and no `setBucketPolicy` call exists in the service), so the
  assignment bucket is created private alongside the video/payment buckets,
  which are unchanged. Export signature preserved for the existing callers
  (`index.ts`, `routes/videos.ts`, `test-minio.ts`). Provisioning was not run.
- `server/src/services/assignment-storage.ts` — `MalwareScanInput` carries the
  stat'ed `etag`; `runBoundedScan` + `scanTimeoutMs` clamp (default 30 s,
  bounded 1–120 s) with `ScanTimeoutError`; timer always cleared.
- `server/src/routes/assignments.ts` — finalize passes the stat'ed ETag into
  the scan, runs it under the bound, and after the scan (or in the no-scanner
  path) re-stats the object and denies `409 object_replaced` when the ETag or
  size changed, before any DB write. Existing key binding, HEAD size, magic
  bytes, `pending_scan` and the race-guarded atomic finalize are untouched.
- `server/tests/m1-storage-config.test.ts` — static wiring guard: provisioning
  wires the private bucket with the documented default, the object adapter
  targets the same default, and no `setBucketPolicy(` call exists.
- `server/tests/m4-assignment-storage.test.ts` — injected bucket-adapter tests
  (creates only the missing private bucket, never sets a policy — tripwire,
  preserves/probes the video+payment buckets, idempotent); finalize tests:
  stale-ETag replacement `409` (scanner bound to the stat'ed version),
  no-scanner replacement `409` (ETag and size variants), hanging scan bounded
  to `502 scan_unavailable`, fast scan still `200` under the same bound.
- `docs/contracts/ASSIGNMENT-UPLOAD-FINALIZE.md` — provisioning/private-bucket
  facts, scanner contract (ETag binding, wall-clock bound, adapter resource
  bounds, fail-closed states), finalize step 12 (object-version re-check),
  download gate for `pending_scan`, updated deployment prerequisites and a
  safe orphan-cleanup **proposal** (no purge implemented).
- `docs/streams/server/ASSIGNMENT-STORAGE-COMPLETION-20261019.md` — this file.

## Defects reproduced before the fix (temporary revert, then restored)

Against the pre-change route (`git`-free revert of the scan/re-stat block):

- `finalize: an object replaced between verification and scan cannot keep a
  stale clean verdict` → `AssertionError: 200 !== 409` — the old flow recorded
  the clean verdict and wrote the row for the replaced object.
- `finalize: a replaced object is refused even without a scanner (recorded
  size stays true)` → `AssertionError: 202 !== 409` — the old no-scanner path
  recorded the size of an object that had already been replaced.
- `finalize: a scan that exceeds the wall-clock bound fails closed, never
  clean` → `AssertionError: undefined !== 502` after ~5 s — the old flow had
  no bound; the request never answered.

## Evidence (hermetic; no network, DB, Docker or provider calls)

- Focused (root cwd):
  `M1_NETWORK_MODE=hermetic node --require ./scripts/m1-network-guard.cjs --import tsx --test server/tests/m1-storage-config.test.ts server/tests/m4-assignments.test.ts server/tests/m4-assignment-storage.test.ts`
  → 80 tests, 80 pass, 0 fail (baseline before this work: 73/73).
- Full root cwd: `... --test server/tests/*.test.ts` → 2285/2285 pass.
- Full server cwd: `... --test tests/*.test.ts` → first attempt 2281/2282 with
  one failure in another worker's in-progress file
  (`tests/m7-impersonation-integration.test.ts`,
  `ReferenceError: DEFAULT_IMPERSONATION_SECONDS is not defined`, a mid-write
  transient); immediate re-run → 2298/2298 pass. Not related to this scope.
- Typecheck: `cd server && node node_modules/typescript/bin/tsc --noEmit` →
  exit 0.

## Residuals (not faked, not authorized here)

1. **No trusted scanner.** Finalize still ends `pending_scan` (202) with no
   scanner injected; `clean` remains unreachable and `pending_scan` is never
   downloadable. Fail-closed by design.
2. **No persisted provenance columns.** The in-request ETag re-stat closes the
   stat/scan/finalize window for the served request, but a later scan worker
   cannot tell which object version a `pending_scan` row was verified
   against. Exact proposal recorded in the contract §8
   (`object_etag`, `object_last_modified`, `finalized_at`, `scan_source`,
   `upload_state`); migration authoring is outside this scope.
3. **Residual TOCTOU after the re-stat.** A replacement landing between the
   re-stat and the DB write cannot be detected by the API; full closure
   requires storage object versioning (version-id-bound reads) or a
   server-side scan proxy — both provider/product decisions.
4. **Orphan cleanup** remains a proposal only (contract §8); no purge, delete
   or lifecycle operation was implemented.
5. Frontend caller changes remain documented-only (`409 object_replaced` added
   to §7).
