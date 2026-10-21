# Assignment private upload — authorization → upload → finalize

Status: implemented server contract (2026-10-19, task
`server-assignment-upload-finalize-20261019-01`), extended for private-bucket
provisioning, ETag-bound scanning and bounded scan execution
(`server-assignment-private-storage-completion-20261019-01`), and extended again
on 2026-10-21 (task `server-b2-w4-assignment-recovery-20261021-01`) with the
`pending_scan` worker (§9) and a corrected finalize race rule (§2.3 step 13).
No migration is authored or executed by this contract. No provider is selected
here: the server uses the already configured private MinIO client in
`server/src/services/minio.ts` through a server-owned adapter
(`server/src/services/assignment-storage.ts`).

## 1. Purpose and boundaries

An enrolled student may attach one private file to an assignment submission
version. The browser never sends file bytes to this API and never names the
object key. The lifecycle is:

```
POST /:id/submissions                -> row (pending_upload) + short-lived upload authorization
PUT  <presigned object URL>          -> browser uploads directly to private storage
POST /:id/submissions/:sid/finalize  -> server verifies object metadata/signature/size, scans, records
```

The server is authoritative for:

- the object key (tenant / assignment / enrollment / submission namespacing);
- the stored object's size, content type, signature and ETag (from storage
  metadata, never from the client);
- the malware verdict (a verified scanner adapter, or fail-closed
  `pending_scan`);
- the submission row and its audit event (same transaction).

The API never accepts raw bytes, never buffers an upload, never returns a
public URL and never exposes the private `storage_key`.

## 2. Endpoints

All routes require the existing student authentication and an active,
approved, in-window enrollment (`students.is_active=1`,
`approval_status='approved'`, `enrollment_status` null/`active`, enrollment
dates covering `UTC_TIMESTAMP()`), resolved server-side. Every query carries
`tenant_id = <principal tenant>`.

### 2.1 `POST /api/assignments/:id/submissions`

Creates the next append-only submission version and its upload authorization.

Request body (only these fields are meaningful):

```json
{ "file_name": "hw.pdf", "file_type": "application/pdf" }
```

- `file_name` must carry an allowed extension (assignment `allowed_file_types`)
  and must not contain path separators or control characters.
- `file_type` is descriptive only. It is never trusted as the stored object's
  content type.
- `storage_key` is rejected with `400` (server-owned).
- `file_size_bytes`, `scan_status`, `checksum` are ignored/rejected as object
  facts; the server never persists them from the request.

Response `201`:

```json
{
  "id": "<submission uuid>",
  "assignment_id": "<assignment id>",
  "version": 1,
  "status": "submitted",
  "is_late": false,
  "file_size_bytes": 0,
  "upload_status": "pending_upload",
  "scan_status": "pending",
  "upload": {
    "method": "PUT",
    "url": "<short-lived presigned URL, private bucket>",
    "expires_in_seconds": 300,
    "expires_at": "2026-10-19T12:05:00.000Z",
    "required_headers": { "Content-Type": "application/pdf" },
    "max_bytes": 1048576
  }
}
```

`upload` is present only when a storage adapter is configured. The URL is
private, short-lived (default 300 s, clamped to 60–600 s) and bound to the
server-generated key. If no adapter is configured the route fails closed with
`503 upload_unavailable` and writes nothing.

Denials: `401` unauthenticated, `403` no active/approved enrollment or closed
submission window (`code` = `NOT_OPEN` / `DEADLINE_PASSED` /
`RESUBMISSION_BLOCKED` / `SUBMISSION_LIMIT_REACHED`), `404` assignment outside
the caller's tenant/audience, `400` invalid metadata or unsupported verifiable
file type, `409` a concurrent version won the UNIQUE key, `500` unexpected.

### 2.2 `POST /api/assignments/:id/submissions/:submissionId/upload-authorization`

Re-issues a short-lived authorization for a still-pending submission owned by
the caller. Used when the first URL expired. It re-runs enrollment, audience
and window checks. `409 already_finalized` when the object is already verified.
Response shape is the same `upload` object.

### 2.3 `POST /api/assignments/:id/submissions/:submissionId/finalize`

Body must be empty (`{}`). Any client-supplied object fact is rejected with
`400 untrusted_finalize_fields`: `storage_key`, `file_size_bytes`,
`scan_status`, `checksum`, `sha256`, `etag`, `content_type`, `size`, or any
other field. The server derives every fact from storage metadata.

Server sequence (first denial wins; nothing is written on denial):

1. Authenticate, resolve the active enrollment, load the assignment in the
   caller's tenant and re-check the audience match.
2. Load the submission by `(id, assignment_id, tenant_id,
   student_enrollment_id)`. Missing or foreign → `404`.
3. `revoked` → `409 submission_revoked`.
4. Already finalized (`file_size_bytes > 0`) → idempotent `200` with the
   recorded state, no audit, no storage call.
5. Re-evaluate the submission window (`status='published'`, not archived,
   deadline + late policy). Closed → `403`.
6. Parse the stored `storage_key` and verify every segment equals the
   server-derived tenant/assignment/enrollment/submission and that the
   extension matches. Mismatch → `409 storage_binding_mismatch`.
7. `statObject(key)`:
   - missing → `404 object_not_found`;
   - storage error → `502 storage_unavailable`.
   The stat's ETag and size are the provenance of every later step.
8. Size: integer, `MIN_FILE_BYTES <= size <= assignment.max_file_bytes`;
   otherwise `400 file_size_out_of_bounds` (oversize included).
9. Content type: the stored metadata `content-type` must equal the expected
   MIME for the extension (parameters stripped, case-insensitive). Missing or
   different → `422 content_type_mismatch`.
10. Signature: a bounded prefix (≤ 4096 bytes, `getPartialObject`) must match
    the extension's magic bytes. Mismatch / unsupported type →
    `422 signature_mismatch`.
11. Malware scan (only when a verified scanner is injected). The scan runs
    under a hard wall-clock bound (§6) and its input carries the ETag and size
    the server stat'ed, so a verdict is produced for — and re-checked against —
    that exact object version.
    - verified scanner returns `clean` → `scan_status='clean'`,
      `upload_status='finalized'`;
    - scanner returns `infected` → `scan_status='infected'`,
      `upload_status='quarantined'`, audited, `422 scan_infected`. The object is
      destroyed only when the adapter can delete **that exact version**; if it
      cannot, nothing is deleted and the version-exact cleanup is pending (§9.6).
      The row is `infected` either way, so the submission is not readable;
    - scanner returns `failed`, throws or exceeds the bound → row untouched,
      `502 scan_unavailable` (retryable);
    - no scanner configured → row records the verified size but
      `scan_status` stays `pending`, response `202 upload_status='pending_scan'`.
      **Uploaded is not clean.** The server never fabricates `clean` from an
      extension or from the absence of a scanner.

    Steps 8–10 are admission denials. Each of them cleans up the rejected
    object by **exact version** — the same `{etag, sizeBytes}` the stat in step 7
    produced, through the same capability-gated seam as a quarantine cleanup, with
    no mutable-key fallback (§9.7). A denial's status, code and body never change
    because of the cleanup, and a cleanup that cannot be proven deletes nothing
    and is reported pending.
12. Object-version re-check (before any write): `statObject(key)` again and
    require the same ETag and size observed in step 7. A different ETag or
    size means the object was replaced between verification and finalize —
    the newer object was never verified or scanned, so a verdict for the older
    object must not authorize it. Denial is `409 object_replaced` (stable
    code), the row stays `pending_upload` and the caller may re-finalize.
    This closes the stat/read/scan/finalize window as far as it can be closed
    without new persisted provenance columns (§8).
13. Atomic row + audit: `UPDATE ... SET file_size_bytes=?, scan_status=? WHERE
    id=? AND assignment_id=? AND tenant_id=? AND student_enrollment_id=?
    AND file_size_bytes=0 AND scan_status='pending' AND status<>'revoked'`, then
    `audit_events` in the same transaction. The `status<>'revoked'` predicate is
    part of the race guard: a staff revoke that lands between the read and the
    write owns the row, and a revoked version must never be recorded as ready.
    `affectedRows=0` → re-read and answer from committed state:
    - the winner recorded **the same verified size and the same verdict** →
      idempotent `200` with the recorded state (this is the duplicate-finalize
      case; the loser never audits and never writes a second version);
    - the winner is `status='revoked'` → `409 submission_revoked`;
    - anything else (a different verdict, a different size, a vanished row) →
      `409 finalize_conflict`.
    A size match alone is **not** idempotency: a winner that recorded
    `infected` while this attempt scanned `clean` is a conflict, because
    answering `200` would report this attempt as having produced a state it
    never produced.

Response `200` (clean) / `202` (pending scan):

```json
{
  "id": "<submission id>",
  "version": 1,
  "upload_status": "finalized",
  "scan_status": "clean",
  "file_size_bytes": 2048,
  "status": "submitted"
}
```

Denials carry a stable `code` and never a storage key or object URL.

## 3. Upload state machine

`upload_status` is derived from persisted columns only:

| `file_size_bytes` | `scan_status`        | `upload_status` |
|-------------------|----------------------|-----------------|
| `0`               | `pending`            | `pending_upload`|
| `> 0`             | `pending`            | `pending_scan`  |
| `> 0`             | `clean`              | `finalized`     |
| `> 0`             | `infected`/`failed`  | `quarantined`   |

The existing schema expresses the whole machine without new columns. A
`pending_upload` row has no verified object and therefore no trusted size.

**Download gate.** No endpoint serves the stored object, and any future
download/read endpoint MUST derive access from this machine: only
`finalized` (verified size + trusted `clean` verdict) may ever be served. A
`pending_scan` row is denied forever until a trusted scan verdict exists —
"uploaded" is never "clean", and the server never fabricates a verdict from
an extension or from the absence of a scanner.

## 4. Object key contract

```
tenants/{tenantId}/assignments/{assignmentId}/{enrollmentId}/{submissionId}.{ext}
```

- Every segment is a server-derived identifier matching
  `[A-Za-z0-9_-]{1,64}`; the extension is `[a-z0-9]{1,16}`.
- The key is generated before the row insert from server facts and re-verified
  at finalize. A client can never choose, extend or redirect it.
- No read endpoint projects `storage_key`. The create response no longer
  returns it (frontend change, §7).

## 5. Storage adapter contract

`AssignmentObjectStore` (`server/src/services/assignment-storage.ts`):

```ts
statObject(key): Promise<{ sizeBytes; contentType; etag; lastModified } | null>;
readPrefix(key, maxBytes): Promise<Buffer>;
createUploadUrl({ objectKey, contentType, expiresInSeconds }): Promise<string>;
createUploadAuthorization?({ objectKey, contentType, expiresInSeconds, maxBytes }):
  Promise<{ method: 'PUT' | 'POST'; url; fields?; maxBytesEnforced: boolean }>;
removeObject(key): Promise<void>;                 // mutable-key delete
capabilities?: { conditionalDelete: boolean };    // declared, never inferred
removeObjectVersion?({ objectKey, etag, sizeBytes }):
  Promise<'removed' | 'already_absent' | 'version_replaced'>;
```

- Production implementation lazily imports the existing MinIO client; module
  load never opens a connection and tests inject a fake.
- Prefix reads are bounded (`getPartialObject(..., 0, maxBytes)`); the server
  never downloads a whole submission to validate it. The cap is applied before
  the body is consumed: the adapter requests at most
  `MAX_SIGNATURE_PREFIX_BYTES` (4096) and destroys the stream as soon as the
  limit is reached.
- **Admission size is only claimed when the store enforces it.** When the
  adapter exposes `createUploadAuthorization`, the production implementation
  signs a MinIO POST policy with `setContentLengthRange(1, maxBytes)`, so the
  store itself refuses an oversize body before it is admitted; the response
  then reports `max_bytes_enforced: true` and
  `max_bytes_enforcement: 'signed_content_length_range'`. When it does not, the
  route falls back to a presigned PUT, which is SigV4 and **cannot bind the
  body length**; the response reports `max_bytes_enforced: false` and
  `max_bytes_enforcement: 'finalize_stat_only'`. A `max_bytes` field in a JSON
  response never constrains a PUT — claiming otherwise would be a false
  guarantee.
- The bucket is `MINIO_BUCKET_ASSIGNMENTS` (default
  `assignment-submissions`), wired as `BUCKETS.ASSIGNMENTS` in
  `services/minio.ts`. `initializeBuckets()` provisions it together with the
  video/payment buckets: it creates a missing bucket and never mutates an
  existing one. Provisioning has no policy capability at all — the injected
  `BucketProvisioningClient` surface is `bucketExists`/`makeBucket` only,
  there is no `setBucketPolicy` call anywhere in the service, and `makeBucket`
  creates a private bucket (no anonymous access). The bucket is therefore
  explicitly private by construction, not by convention. Tests pin this with
  an injected adapter whose policy method is a tripwire.
- SigV4 presigned PUT cannot cryptographically bind `Content-Type` or
  `Content-Length`. Finalize enforces both from stored metadata; an oversize
  or wrong-type object is rejected and removed best-effort.
- **`removeObject` is a mutable-key delete** — it destroys whatever is at the key
  when it runs. It is therefore used for **no lifecycle cleanup at all**: every
  rejection and cancel cleanup goes through `removeObjectVersion` with the exact
  stat'ed version, or deletes nothing (§9.6, §9.7). The method remains on the
  adapter surface only so an adapter can still expose it; the assignment
  lifecycle never calls it, and a store that cannot prove a version gets no
  destructive call from this module at all.

## 6. Malware scanner contract

```ts
scan({ objectKey, sizeBytes, contentType, extension, etag }):
  Promise<{ verdict: 'clean' } | { verdict: 'infected'; signature?: string }
        | { verdict: 'failed'; reason: string }>;
```

Requirements for any future verified adapter (for example a ClamAV service):

- The input carries the **ETag and size the server stat'ed**. The adapter must
  bind its read (and its verdict) to exactly that object version; a verdict
  for any other version is meaningless because the server re-checks the ETag
  after scanning (step 12 of §2.3).
- The server runs the scan under a hard wall-clock bound (`runBoundedScan`,
  default 30 s, clamped to 1–120 s via the route's `scanTimeoutMs`
  dependency). Exceeding it fails closed with `502 scan_unavailable`.
- The adapter must bound its own resource consumption: read at most the
  object size reported in the input, with its own per-read timeout, and never
  stream an unbounded amount of object bytes into memory.
- unavailable/error states (`failed`, throw, timeout) MUST be fail-closed:
  `502 scan_unavailable`, row untouched, retryable. Never a placeholder or
  extension-derived `clean`.

No scanner is wired in this scope. The route therefore always ends in
`pending_scan` (HTTP 202) after a successful verification, and a
`pending_scan` submission can never be downloaded (§3). A future scanner
adapter must be injected as a verified adapter; until then `clean` is
unreachable. This is deliberate fail-closed behavior, not a placeholder
success.

## 7. Required frontend caller changes (documented only — client not edited)

The human client (`codex/human-client`, `src/**`) must:

1. Stop reading `storage_key` from the create response. It is no longer
   returned.
2. After `201`, `PUT` the file bytes to `response.upload.url` with exactly
   `response.upload.required_headers` (at minimum `Content-Type`) and a body
   whose length is `<= response.upload.max_bytes`.
3. On success, call `POST /:id/submissions/:id/finalize` with an empty body.
   Treat `200` (`finalized`) and `202` (`pending_scan`) as accepted; show
   "under review" for `202`, never "clean".
4. On `409`/`403` from finalize, show the stable `code`; on `404
   object_not_found`, re-request an upload authorization and retry the PUT.
   A `409 object_replaced` means the uploaded object changed while it was
   being verified: the client must re-upload and finalize again — the server
   never adopts an object it did not verify.
5. Never send `storage_key`, `file_size_bytes`, `scan_status`, checksum, ETag
   or content type as finalize facts.

## 8. Schema and operational gaps (proposed, not executed)

The current schema is sufficient for the lifecycle above but cannot persist
provenance. The stat'ed ETag/size are re-checked within a single finalize
call (§2.3 step 12), which closes the stat/scan/finalize window for the
request being served; it cannot be re-checked later, because nothing records
which object version a `pending_scan` row was verified against. A future
scan worker MUST therefore re-stat and re-verify the object itself rather
than trusting a previously recorded verdict. Proposed additive migration
(authoring by the migration owner, outside this task):

```sql
ALTER TABLE assignment_submissions
  ADD COLUMN upload_state ENUM('pending_upload','pending_scan','finalized','quarantined')
      NOT NULL DEFAULT 'pending_upload',
  ADD COLUMN object_etag VARCHAR(64) NULL,
  ADD COLUMN object_last_modified TIMESTAMP NULL,
  ADD COLUMN finalized_at TIMESTAMP NULL,
  ADD COLUMN scan_source VARCHAR(64) NULL;
```

With `object_etag`/`object_last_modified` persisted, a scan worker (or a
download gate) can bind every later decision to the exact verified object
version. Until then, the in-request re-stat check is the strongest available
guarantee and any out-of-band scan must re-verify provenance itself.

Operational prerequisites:

- private bucket `assignment-submissions` (or `MINIO_BUCKET_ASSIGNMENTS`) —
  now created by `initializeBuckets()` at startup together with the video and
  payment buckets, with no policy ever set (§5). No manual provisioning step
  and no policy file is required or permitted;
- a trusted malware scanner adapter (§6) — absent means every verified upload
  ends `pending_scan` (202) and is undownloadable (§3);
- a `pending_scan` → `clean`/`quarantined` scan worker — implemented as
  `server/src/services/assignment-scan-worker.ts` (§9). It is **not** wired into
  process startup: no timer, no import side effect, no `index.ts` change. An
  owner must call `runOnce()` from an explicit scheduler;
- an orphan cleanup policy (proposal only — no purge is implemented): a
  client that uploads and never finalizes leaves an object. A safe policy
  would be a scheduled job that lists objects older than the upload
  authorization window (≥ 600 s) under `tenants/{tenant}/assignments/...`,
  cross-checks each against the submission rows (delete only objects with no
  matching `pending_upload`/`pending_scan` row), logs every candidate before
  removal, and runs dry-run first. Admission-rejected objects
  (oversize/mismatch) are removed best-effort by the route; an **infected**
  object is removed only when the adapter can delete its exact version (§9.6),
  so a pending-quarantine object is one more orphan class this policy must
  cover. No lifecycle rule, automatic bucket expiry, or bulk delete may run
  without that dry-run evidence.

None of these are faked by this implementation.

## 9. `pending_scan` worker contract

`server/src/services/assignment-scan-worker.ts`. Explicitly driven; nothing
starts on import or on construction.

```ts
createAssignmentScanWorker({ store, objectStore, scanner?, scanTimeoutMs?,
  batchSize?, concurrency?, maxAttemptsPerRow?, claimAttempts?,
  retryDelayMs?, sleep?, onError? }): { runOnce(): Promise<RunResult> }
createSqlAssignmentScanStore({ query, execute }): AssignmentScanStore
```

### 9.1 Run result

```ts
{ aborted: 'scanner_absent' | 'claim_failed' | 'already_running' | null,
  claimed: number, clean: number, quarantined: number, failed: number,
  outcomes: Array<{ submissionId, outcome: OutcomeCode }>,
  quarantineCleanup: Array<{ submissionId,
    cleanup: 'removed' | 'already_absent' | 'version_replaced'
           | 'unsupported' | 'failed' }> }
```

`quarantined` counts rows left with an infected verdict, including rows whose
byte cleanup is pending. `quarantineCleanup` has one entry per infected verdict
and is the only place that says what happened to the **bytes**; `unsupported`
and `failed` both mean the scanned bytes may still exist and the cleanup is
pending an operator.

| `outcome` | meaning | row afterwards |
|---|---|---|
| `clean` | clean verdict recorded for the verified version | `scan_status='clean'` |
| `quarantined` | infected verdict recorded **and** the scanned version is provably gone from the key | `scan_status='infected'` |
| `quarantined_cleanup_pending` | infected verdict recorded, but the scanned bytes could not be provably destroyed (`unsupported` or `failed` cleanup) | `scan_status='infected'` (not readable) |
| `scan_failed` | no confirmed verdict (error, throw, timeout, `failed`, or the CAS write threw) | unchanged (`pending`) |
| `storage_error` | `statObject` failed | unchanged (`pending`) |
| `object_changed` | key holds a different version (ETag or size differs) | unchanged (`pending`) |
| `unbound_object_version` | adapter reports no ETag / no positive size | unchanged (`pending`) |
| `binding_mismatch` | persisted `storage_key` does not match the row facts | unchanged; never stat'ed |
| `object_missing` | nothing at the key | unchanged (`pending`) |
| `verdict_not_recorded` | verdict produced, CAS lost to another writer | unchanged (owned by the winner) |

`aborted` values are terminal for the run and produce zero claims:
`scanner_absent` (no scanner injected — fail closed, never clean),
`claim_failed` (claim store failed after its bounded budget),
`already_running` (a run is already in flight in this process).

### 9.2 Bounds

| knob | default | hard cap |
|---|---|---|
| `batchSize` (rows claimed per run) | 10 | 50 |
| `concurrency` (objects scanned in parallel) | 2 | 8 |
| `claimAttempts` | 3 | 5 |
| `maxAttemptsPerRow` | 1 (no retry unless opted in) | 5 |
| `retryDelayMs` (base, both backoffs) | 250 ms | 5000 ms |
| `scanTimeoutMs` | shared `runBoundedScan` bound, 30 s | 120 s |

Backoff is deterministic exponential (`base × 2^n`), never random. An
over-large configuration is clamped, never honoured.

### 9.3 Claim and verdict write — existing columns only

The worker issues exactly two statements, both over
`assignment_submissions` columns that already exist (`scan_status`,
`file_size_bytes`, `status`). No column is invented; no DDL is performed.

- claim: `SELECT id,tenant_id,assignment_id,student_enrollment_id,storage_key,
  file_size_bytes FROM assignment_submissions WHERE scan_status='pending' AND
  file_size_bytes>0 AND status<>'revoked' ORDER BY submitted_at ASC, id ASC
  LIMIT <clamped integer>`. Revoked rows are excluded so a teacher revocation is
  never scanned back to life. The claim is server-owned and therefore spans
  tenants — it is not a principal-scoped request.
- verdict write (compare-and-set):
  `UPDATE assignment_submissions SET scan_status=? WHERE id=? AND tenant_id=?
  AND assignment_id=? AND student_enrollment_id=? AND scan_status='pending' AND
  file_size_bytes=? AND status<>'revoked'`. `affectedRows=0` is reported as
  `verdict_not_recorded`; the worker never loops to force a verdict.

### 9.4 Verdict provenance

- The row facts are re-derived from the persisted `storage_key` and must match
  the row exactly; a forged/foreign key is never stat'ed.
- The object is stat'ed; its version (ETag + size) must exist and its size must
  equal the row's verified `file_size_bytes`, otherwise nothing is scanned.
- The scanner input carries that ETag and size. After the verdict the object is
  stat'ed **again**; a changed version discards the verdict (`object_changed`). A
  verdict is therefore bound to the scanned version, never to client metadata
  and never to an extension.
- An infected verdict is quarantined at the row and, where the adapter allows it,
  the **scanned version** is destroyed — see §9.6. A lost verdict write never
  leaves known-malware bytes in place and never yields a clean state.

**What the persisted verdict is bound to — and what it is not.** The CAS is bound
to the row identity (`id`, `tenant_id`, `assignment_id`,
`student_enrollment_id`), to `scan_status='pending'`, to `status<>'revoked'`, and
to `file_size_bytes`. It is **not** bound to the ETag: `assignment_submissions`
has no `object_etag` column, so two different objects of the same size are
indistinguishable to the write. That is an explicit **I2 gap** (§8, §9.5.6), and
it is exactly why a quarantine delete may not be key-based: the row cannot prove
which object version it describes, so the *store* must enforce the version
precondition, or nothing is deleted (§9.6). A missing durable version column is
never permission to delete the current key.

### 9.6 Quarantine cleanup — exact version, capability, pending

The delete that follows an `infected` verdict must destroy **exactly the object
version that was scanned**, and nothing else.

**What "exact version" means.** `etag:sizeBytes` as reported by the store for the
version the scanner read, re-checked by a second `statObject` immediately before
the verdict write. It is the same identity the readiness check uses
(`boundObjectVersion`). It is *not* the object key: a key is mutable, and a
concurrent uploader can replace its contents between the last stat and the
delete. A delete by key would then destroy bytes that were never scanned — a
different student's re-upload, or the same student's newer attempt.

**The gate.** A delete is issued only when all of these hold:

1. the verdict is `infected` (an explicit scanner verdict, not an error, not a
   timeout, not an extension guess);
2. the target is the scanned version — `removeObjectVersion({ objectKey, etag,
   sizeBytes })`, never `removeObject(objectKey)`;
3. the adapter declares `capabilities.conditionalDelete === true` **and**
   implements `removeObjectVersion`. The flag alone is not enough, and the method
   alone is not a claim the adapter stands behind. Both are required
   (`supportsExactVersionRemoval`);
4. the store itself enforces the precondition and answers `version_replaced`
   rather than deleting when the key holds a different version.

The verdict-write outcome does **not** gate the attempt: a lost CAS or a failed
verdict write still attempts the exact-version delete, because a row-write
failure must not leave known-malware bytes in place. It does gate what is
reported — the outcome stays `scan_failed` / `verdict_not_recorded` and is never
upgraded to a success.

**What happens without the capability.** Nothing is deleted. There is no
mutable-key fallback and no "stat then delete" approximation: a stat immediately
before a key delete narrows the window without closing it, and claiming
otherwise would be a fabricated guarantee. Instead:

- the row is `scan_status='infected'` — the durable, non-readable quarantine
  record — so the submission is never readable, never `clean`, and never
  downloadable (§3);
- the run reports `quarantine_cleanup_pending` with
  `quarantineCleanup[].cleanup = 'unsupported'` (or `'failed'` when the delete
  itself errored);
- the route logs a redacted `quarantine cleanup pending` line for the submission.

**What is pending.** The bytes remain in the private bucket, unaddressed by any
row that could serve them, until an operator or a future adapter destroys them.
There is **no durable per-row cleanup flag** — `assignment_submissions` has no
`quarantine_cleanup_state` column and this task authors no DDL — so the pending
state is observable only in the run result and the log. That is an explicit I2
gap (§8), and the production MinIO adapter declares `conditionalDelete: false`
today, so *every* production infected verdict currently ends in pending
cleanup. Flipping that flag requires a store that can prove the precondition
(for example a versioned bucket plus a `versionId`-scoped delete and a stat that
the version still matches); until then the flag must stay `false`.

The production adapter's declaration is in
`createMinioAssignmentObjectStore`: MinIO's `removeObject(bucket, key)` addresses
the key, S3 `DELETE` has no ETag precondition, and the optional `versionId` form
addresses a bucket *version* that this deployment neither enables nor can prove.

### 9.7 Rejection and cancel cleanup — the same rule, one class of defect

An admission denial and a student cancel both remove an object that was never
given a verdict. They are the **same defect class** as §9.6 and follow the same
rule, because the key is just as mutable in both cases.

**The branches.** Finalize denies and cleans up at exactly four points, each of
which runs *after* the server has stat'ed the object and holds a verified
version (`boundObjectVersion(metadata)` → `{etag, sizeBytes}`):

| branch | status | code |
|---|---|---|
| size over the assignment limit | 413 | `file_size_out_of_bounds` |
| verified size outside the allowed window | 400 | `file_size_out_of_bounds` |
| stored content-type mismatch | 422 | `content_type_mismatch` |
| signature mismatch / unsupported type | 422 | `signature_mismatch` / `unsupported_file_type` |

The student cancel of an unverified upload (`POST .../cancel`) is the fifth.

**The rule.** Every one of those five cleanups goes through
`removeScannedObjectVersion` with the exact version, gated on
`supportsExactVersionRemoval` — the identical seam as a quarantine cleanup.
There is **no mutable-key fallback anywhere**. The delete names
`{objectKey, etag, sizeBytes}`, and the store refuses it (`version_replaced`)
when the key no longer holds that version.

**Cancel.** The cancel path has no earlier verdict to re-stat against, so it
proves the version first: `statObject` → `boundObjectVersion` → exact-version
delete. A stat failure, a missing object, or an adapter that cannot express a
version deletes **nothing** — the cleanup is left pending, and the cancellation
still succeeds with its unchanged response. A concurrent re-upload that lands
between the stat and the delete therefore survives.

**What happens without the capability.** Nothing is deleted and the cleanup is
reported pending in the operator log (`Assignment rejection cleanup pending`).
The row is not recorded by a denial (it stays `file_size_bytes = 0`,
`scan_status = 'pending'`, therefore unreadable), and a cancelled row is
`revoked`. No response body changes: the denial status, error code and body are
frozen, so "pending" is a log/operator fact, never a field a caller can read.

**Honest limitation.** The production MinIO adapter declares
`conditionalDelete: false` (§9.5 item 6), so on production storage **no** denial
or cancel cleanup actually destroys bytes today — every one of them ends pending,
exactly like every quarantine. The rejected or abandoned object stays in the
private bucket, unaddressed by any readable row, until an operator or a future
adapter removes it. This is the same I2 gap as §9.6: an `object_etag` /
`quarantine_cleanup_state` pair would make the pending set queryable, and no DDL
is authored or executed by this document.

**What this is not.** It is not a permission to delete "whatever is there now",
and it is not a claim that the window is closed by stat-then-delete. A stat
immediately before a key delete narrows the window without closing it; only the
store's own precondition can close it, which is why the capability is declared
rather than inferred.

### 9.5 What this adapter cannot prove (declared, not hidden)

1. **No durable attempt/lease columns.** `scan_attempts`,
   `scan_claimed_at`/`scan_lease_until` and `scan_last_error` do not exist. The
   attempt cap and the concurrency limit are therefore **in-run only**: two
   processes may scan the same row concurrently, and a permanently failing row
   is retried by every run. The CAS makes the duplicate harmless (only one
   verdict lands) but it wastes work. **I2 request:** additive migration
   `scan_attempts INT NOT NULL DEFAULT 0`, `scan_next_attempt_at TIMESTAMP NULL`,
   `scan_lease_until TIMESTAMP NULL`, `scan_last_error VARCHAR(255) NULL` — no
   DDL is authored or executed by this task.
2. **No cross-run exhaustion.** With no persisted attempt counter, "give up
   after N attempts" cannot be enforced across runs. Only the per-run cap is
   real. Such a row stays `pending` (and therefore unreadable) rather than being
   marked `failed`.
3. **Head-of-line risk.** Without `scan_next_attempt_at`, ordering is FIFO, so
   more than one batch of permanently failing rows can delay later rows.
4. **No scanner provider.** No ClamAV/AV service is selected, configured or
   contacted. With no injected adapter the worker aborts `scanner_absent`; the
   end-to-end `pending_scan → clean` path is therefore **not** proven against a
   real provider.
5. **No startup wiring.** The worker is not registered in `server/src/index.ts`
   (out of scope). Nothing schedules it today.
6. **No exact-version delete in production.** The MinIO adapter declares
   `conditionalDelete: false`, so an infected object is quarantined at the row
   but its bytes are **not** destroyed; the cleanup is pending (§9.6). There is
   also no durable per-row cleanup flag to track that pending work. **I2
   request:** `quarantine_cleanup_state ENUM('none','pending','done') NULL` (or
   equivalent) plus an `object_etag` column so the pending set is queryable. No
   DDL is authored or executed by this task.

## 10. Stable error codes (assignment upload lifecycle)

`untrusted_finalize_fields` (400) · `upload_unavailable` (503) ·
`storage_unavailable` (502) · `object_not_found` (404) ·
`object_version_unbound` (503) · `file_size_out_of_bounds` (413/400) ·
`content_type_mismatch` (422) · `signature_mismatch` / `unsupported_file_type`
(422) · `object_replaced` (409) · `scan_unavailable` (502) · `scan_infected`
(422) · `storage_binding_mismatch` (409) · `submission_revoked` (409) ·
`already_finalized` (409) · `finalize_conflict` (409) · `cancel_conflict` (409)
· `NOT_OPEN` / `DEADLINE_PASSED` / `RESUBMISSION_BLOCKED` /
`SUBMISSION_LIMIT_REACHED` (403).
