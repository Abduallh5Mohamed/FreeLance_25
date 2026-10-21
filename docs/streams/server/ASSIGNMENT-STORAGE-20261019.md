# Assignment private upload — server storage stream (2026-10-19)

Task: `server-assignment-upload-finalize-20261019-01` (team storage).
Scope: complete the assignment submission upload lifecycle on the existing
private MinIO integration, hermetically, without a provider change, a new
package, a migration or any client edit.

## Before

- `POST /:id/submissions` created the row immediately and called a
  `storageStat` seam that was wired to `async () => null` in production. No
  object could ever be verified, and the response returned the private
  `storage_key` to the creator.
- There was no upload authorization endpoint and no finalize endpoint.
- `scan_status` was written `pending` and never moved; there was no path that
  could distinguish "uploaded" from "clean".
- The only storage seam was a bare `(key) => size | null` function; content
  type, ETag, last-modified and a bounded prefix read were unavailable, so a
  forged content type or a renamed executable could not be rejected.

## After

Files:

- `server/src/services/assignment-storage.ts` (new) — server-owned object
  adapter over the existing MinIO client (lazy import; no connection at module
  load), canonical key parsing/binding, expected-MIME policy, bounded
  magic-byte verification, upload-URL TTL clamping, scanner contract.
- `server/src/services/assignments.ts` — `deriveUploadStatus`,
  `validateFinalizeRequest` (finalize accepts no client object facts).
- `server/src/routes/assignments.ts` — create now records `pending_upload`
  (size 0) and returns a short-lived private upload authorization; new
  `upload-authorization` and `finalize` routes; `upload_status` added to every
  submission projection; `productionStorageStat` (always null) replaced by
  `createMinioAssignmentObjectStore()`; no scanner wired (fail closed).
- `server/tests/m4-assignments.test.ts` — harness moved to an injected object
  store; create tests assert the private target and that creation never stats
  storage or trusts a client size.
- `server/tests/m4-assignment-storage.test.ts` (new) — pure adapter policy and
  finalize/authorization route behavior, including forged metadata, races and
  scanner outcomes.
- `docs/contracts/ASSIGNMENT-UPLOAD-FINALIZE.md` (new) — API contract and
  frontend caller changes.

Lifecycle:

1. `POST /:id/submissions` → row `pending_upload`, `file_size_bytes=0`,
   `scan_status='pending'`, response `upload` (PUT URL, expiry 300 s, required
   `Content-Type`, `max_bytes`). No `storage_key` in the response.
2. Browser PUTs directly to the private object; the API never receives or
   buffers bytes.
3. `POST /:id/submissions/:sid/finalize` with an empty body → key binding,
   stat, size, stored content type, bounded signature prefix, optional scanner.
   Atomic guarded `UPDATE` + audit. `200 finalized` (clean scanner), `202
   pending_scan` (no scanner), `422 quarantined` (infected) or a stable denial.

Security invariants enforced and tested:

- key is generated from server facts and re-verified at finalize; a forged
  tenant/assignment/enrollment/submission segment is `409` before storage;
- client-supplied `storage_key`, `file_size_bytes`, `scan_status`, checksum,
  ETag or any other field is `400`;
- size bounds come from `statObject`; oversize is `413` and the object is
  removed best-effort;
- stored content type must equal the expected MIME; a bounded (≤ 4096 byte)
  prefix must match the extension's magic bytes; failures are `422`;
- missing object `404`, storage failure `502`, scanner failure `502`
  (retryable), infected `422` + quarantine (row `scan_status='infected'`,
  object removed);
- duplicate finalize is idempotent (no second audit); a racing winner with a
  different size is `409 finalize_conflict`;
- revoked submission `409`, closed window `403`, foreign submission `404`,
  enrollment/assignment/tenant predicates are bound in SQL.

## Evidence

Verified by the recovery worker (`server-assignment-upload-finalize-recovery-20261019-01`,
2026-10-19) after the original worker was interrupted. No code change was
needed: the audit confirmed every scope item already implemented and tested;
this section records the actually executed verification.

Commands (all hermetic, exit code 0):

- Focused:
  `M1_NETWORK_MODE=hermetic node --require ./scripts/m1-network-guard.cjs --import tsx --test server/tests/m4-assignments.test.ts server/tests/m4-assignment-storage.test.ts`
  → 68 tests, 68 pass, 0 fail.
- Full root cwd:
  `M1_NETWORK_MODE=hermetic node --require ./scripts/m1-network-guard.cjs --import tsx --test server/tests/*.test.ts`
  → 2223 tests, 2223 pass, 0 fail.
- Full server cwd:
  `cd server && M1_NETWORK_MODE=hermetic node --require ../scripts/m1-network-guard.cjs --import tsx --test tests/*.test.ts`
  → 2223 tests, 2223 pass, 0 fail.
- Typecheck: `cd server && node node_modules/typescript/bin/tsc --noEmit` → exit 0.

No regression against the 2223/2223 + tsc-0 baseline. No network, Docker,
migration execution or dependency change was involved.

## Residual gaps (not faked)

1. **No trusted malware scanner.** Finalize ends `pending_scan` (202) and
   `clean` is unreachable until a verified adapter is injected. This is the
   required fail-closed state, not completion.
2. **Bucket provisioning.** `MINIO_BUCKET_ASSIGNMENTS` (default
   `assignment-submissions`) must exist and be private. The existing
   `initializeBuckets()` does not create it; adding it is a shared-file change
   in `server/src/services/minio.ts`, which this task does not own.
3. **No provenance columns.** `upload_state`, `object_etag`,
   `object_last_modified`, `finalized_at`, `scan_source` are proposed in the
   contract but not migrated (no migration authoring in this scope). State is
   derived from `file_size_bytes` + `scan_status`.
4. **Orphan cleanup.** Rejected objects are removed best-effort; a client that
   uploads and never finalizes leaves an object. A lifecycle/cleanup job is
   required.
5. **Frontend caller changes** are documented only; the human client still
   expects `storage_key` and does not call finalize.
6. **SigV4 PUT cannot bind Content-Type/Content-Length.** Finalize enforces
   both from stored metadata; a storage-level presigned POST policy would
   enforce them earlier and is a future hardening step.
