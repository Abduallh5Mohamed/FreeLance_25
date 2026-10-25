# Assignment durable cleanup + upload/scan recovery — source delivery

Task `server-assignment-durable-cleanup-recovery-20261023-01` (lane WorkBuddy,
team `storage`, approval v2, claim held for the whole run). Source only: no
tests, no typecheck, no SQL executed, no DB/Docker/provider/Git mutation, no
`index.ts` mount, no DDL authored in `server/migrations/**`.

This document is the delivery contract for two other owners:

- **Claude** — the exact durable schema (`§4`). No migration is authored here;
  every statement below is a *proposal* with its exact text, so the migration
  owner can adopt it verbatim instead of re-deriving it.
- **Codex** — the exact lifecycle hooks (`§5`) for composing the runtime. This
  module never mounts itself and opens no timer.

---

## 1. Scope and what this is not

Before this task, a rejected or cancelled object was destroyed best-effort by the
request that discovered it, and an `infected` verdict destroyed the scanned
version the same way. The *obligation* to destroy those bytes existed only
inside that request. If the process died after the denial and before the delete
— or if the adapter could not delete by exact version — the only trace was a log
line, and nothing could finish the work later.

This task adds:

1. a durable obligation record that names an **exact object version**;
2. write-ahead ordering at every rejection/cancel/quarantine point, so the
   obligation is durable before the bytes are touched and, where the caller owns
   a transaction, in the *same* unit of work as the state change;
3. a bounded coordinator (`runOnce`) that claims obligations with an owner +
   version fence + lease, re-proves the identity, deletes only that version, and
   settles the row;
4. an opt-in **fenced** claim mode for the existing scan worker (no second
   scanner, no second state machine);
5. a composition root with honest readiness reasons and an explicit
   `runOnce` / `stop` / `drain` surface;
6. a **plan-only**, tenant-scoped orphan surface (no deletion, no bucket count).

It is **not**: a queue, a scheduler, a scanner, a new provider, a retention
policy, or a licence to delete a key. There is no `removeObject(storage_key)`
call anywhere in these paths — see `§6` item 5.

---

## 2. Inventory of the current lifecycle (source trace, Phase 1)

`assignment_submissions` (migration `20261018_08`) carries
`status ENUM('submitted','late','revoked')`, `file_size_bytes BIGINT`,
`scan_status ENUM('pending','clean','infected','failed')`, `storage_key`,
`submitted_at`, `revoked_at/by/reason`. There is **no** obligation, claim, lease,
attempt or object-version column.

`upload_status` is derived, never stored (`assignments.deriveUploadStatus`):

| `file_size_bytes` | `scan_status` | `upload_status` |
|---|---|---|
| `0` | any | `pending_upload` |
| `> 0` | `pending` | `pending_scan` |
| `> 0` | `clean` | `finalized` |
| `> 0` | `infected` / `failed` | `quarantined` |

Writers of that state, and the cleanup each one owes:

| point | source | state written | cleanup owed today |
|---|---|---|---|
| create submission | `POST /:id/submissions` | row inserted, `size=0`, `scan=pending` | none yet (no object) |
| cancel | `POST .../cancel` | `status='revoked'` + audit | the abandoned object's version |
| finalize — admission | `POST .../finalize` | **none** (row stays `pending_upload`) | the verified version (`413` oversize, `400` size window, `422` content type, `422` signature) |
| finalize — clean | same | `size`, `scan='clean'` + audit | none |
| finalize — pending scan | same | `size`, `scan='pending'` + audit | none (never clean) |
| finalize — infected | same | `size`, `scan='infected'` + audit | the scanned version |
| staff revoke | `POST .../revoke` | `status='revoked'` + audit | **none, by design** — a revoked verified submission keeps its bytes for the record; it is not a cleanup point |
| scan worker | `assignment-scan-worker.ts` | `scan_status='clean'\|'infected'` via CAS | the scanned version on `infected` |
| student resubmit | `POST /:id/submissions` | new row/version | none |

Preserved unchanged: authority and audience resolution (`resolveStaffScope`,
`resolveEnrollment`, `enrollmentMatchesAssignment`), grading authority and the
deterministic gradebook id, quota/resubmission policy (`evaluateSubmission`),
every audit event, the exact-version deletion seam, the duplicate-key race
answer, the finalize CAS and its "same size **and** same verdict" idempotency
rule, and the `status<>'revoked'` race guard.

---

## 3. The durable obligation (Phases 2–3)

### 3.1 Identity

`AssignmentCleanupTarget` = `tenantId`, `assignmentId`, `enrollmentId`,
`submissionId`, `storageKey`, `etag`, `sizeBytes`, `reason`.

- The key must re-parse to exactly those four identifiers
  (`normalizeCleanupTarget` → `parseSubmissionStorageKey`); anything else is
  `null`, i.e. "never record, never delete".
- `etag` is stored and compared **byte for byte**: no trim, no case folding, no
  normalisation. An identity normalised on one side only stops being an identity
  (the `utf8mb4_bin` PAD-SPACE lesson, `§4.1`).
- `sizeBytes` is a positive integer; `reason` is a closed union
  (`CLEANUP_OBLIGATION_REASONS`): four admission reasons, `scan_infected`,
  `cancelled_upload`.
- Two obligations for one submission are legitimate (rejected, re-uploaded,
  rejected again). Two obligations for the same `(submissionId, etag, sizeBytes)`
  are the same work.

### 3.2 State machine

`pending → deleted` · `pending → superseded`.

- `deleted` requires a proof that nothing is at the key for the named version:
  the store's `removed`, the store's `already_absent`, or a trusted re-stat that
  found nothing (`pre_stat_absent`).
- `superseded` means the named version is no longer the current version. Nothing
  was deleted by us and the replacement is untouched. It is deliberately **not**
  `deleted`: with a versioned bucket the older bytes can still exist, and calling
  that "deleted" would be a fabricated success.
- There is no `failed` state. A failure is `pending` + `last_failure`, which is
  what makes it retryable.

### 3.3 Ordering at each call site

| call site | obligation write | external delete | settlement |
|---|---|---|---|
| finalize admission denial | own transaction, **before** the delete | after commit of that insert | after the delete (`completeUnclaimed`) |
| cancel | **inside** the revocation transaction (revoke + audit + obligation = one unit) | after commit | after the delete |
| finalize `infected` | **inside** the verdict transaction (verdict + audit + obligation = one unit) | after commit | after the delete |
| coordinator | claim (CAS) | after a fresh stat | `completeClaim` (CAS on owner+version+lease) |

Consequences that are deliberate:

- A quarantine whose obligation cannot be recorded **does not commit**: the
  finalize transaction rolls back and answers `500`, the row stays
  `pending_upload`, the bytes stay put, nothing was claimed. The same holds for a
  cancellation.
- A rejection (which writes no row state) records the obligation in its own
  transaction. If that insert fails, **no delete is issued** — deleting without
  the durable record would lose the write-ahead property. The denial status,
  code and body are unchanged.
- When no durable store is injected the behaviour is the historical best-effort
  cleanup, reported as `cleanup-unconfigured`. Nothing is claimed to be queued.

### 3.4 Claim, fence, lease, continuation, bounds

- **Claim**: `claimBatch` stamps `claim_owner`, `claim_version = claim_version+1`
  and `lease_until_ms` on rows that are `pending` **and** (`claim_owner IS NULL`
  **or** `lease_until_ms <= nowMs`), ordered by the keyset pair
  `(created_at_ms, id)` ascending, `LIMIT` a clamped integer.
- **Fence**: completion and release are `WHERE id=? AND state='pending'
  AND claim_owner=? AND claim_version=? AND lease_until_ms > ?`. `affectedRows=0`
  is a lost claim, and a lost claim **halts the run** (`halted:'claim_lost'`):
  if our lease was taken, our other claims from the same page are stale too, so
  continuing would let a zombie run keep writing.
- **Continuation**: the keyset pair only. Never an OFFSET — an offset skips rows
  when earlier ones are completed between pages. The pair is returned in the
  report; a fresh run also continues naturally because claimed rows leave the
  `pending` set.
- **Bounds** (defaults, hard caps): page 10/50, pages 4/20, items 25/200, run
  budget 5 s/30 s, lease 30 s/5 min–5 min, retry delay 1 s/60 s (deterministic
  `base × 2^n`, never random).
- **Stop**: `stop()` is cooperative — no new page or item starts, the in-flight
  delete finishes. Rows claimed in a page but never inspected keep their lease
  and are re-claimable after it expires; that is safe because every step is
  idempotent by version.
- **Capability gate**: when the adapter cannot delete by exact version the run
  refuses to claim at all (`halted:'capability_absent'`). Claiming work we
  cannot act on would burn a lease and bump an attempt counter for nothing.

### 3.5 External deletion and DB completion are two stages

The delete is issued only after a fresh `statObject` proves the key still holds
the recorded version. Then the store itself must enforce the precondition
(`removeObjectVersion`), and only its own answer is trusted:

| store answer | state | proof |
|---|---|---|
| `removed` | `deleted` | `store_removed` |
| `already_absent` | `deleted` | `store_already_absent` |
| `version_replaced` | `superseded` | `store_version_replaced` |
| `unsupported` | `pending` | failure `capability_absent` |
| throws / `failed` | `pending` | failure `store_error` |
| re-stat: nothing | `deleted` | `pre_stat_absent` |
| re-stat: other version | `superseded` | `pre_stat_version_replaced` |

A crash between the delete and the DB completion leaves the row `pending`; the
replay re-stats, finds nothing at the key, and completes as `deleted`. That is
the only place "not found" is treated as idempotent, and it is always backed by
a store answer or a fresh stat — never by an error message.

---

## 4. Durable schema contract (for Claude — proposal only, no DDL authored here)

### 4.1 The table

```sql
CREATE TABLE assignment_cleanup_obligations (
    id CHAR(36) NOT NULL,
    tenant_id CHAR(36) NOT NULL,
    assignment_id CHAR(36) NOT NULL,
    student_enrollment_id CHAR(36) NOT NULL,
    submission_id CHAR(36) NOT NULL,
    storage_key VARCHAR(255) NOT NULL,
    -- Exact object-version identity. NEVER trimmed or normalised in SQL:
    -- utf8mb4_0900_bin is NO PAD, so '"abc"' and '"abc "' stay distinct.
    object_etag VARCHAR(256) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin NOT NULL,
    object_size_bytes BIGINT NOT NULL,
    reason ENUM('admission_oversize','admission_size_out_of_bounds',
                'admission_content_type_mismatch','admission_signature_mismatch',
                'scan_infected','cancelled_upload') NOT NULL,
    state ENUM('pending','deleted','superseded') NOT NULL DEFAULT 'pending',
    claim_owner VARCHAR(64) NULL,
    claim_version INT NOT NULL DEFAULT 0,
    lease_until_ms BIGINT NULL,
    attempts INT NOT NULL DEFAULT 0,
    last_failure ENUM('capability_absent','store_error','binding_mismatch',
                      'record_state_invalid','legacy_etag_unprovable') NULL,
    retry_after_ms BIGINT NULL,
    completion_proof ENUM('store_removed','store_already_absent','pre_stat_absent',
                          'store_version_replaced','pre_stat_version_replaced') NULL,
    created_at_ms BIGINT NOT NULL,
    updated_at_ms BIGINT NOT NULL,
    completed_at_ms BIGINT NULL,
    PRIMARY KEY (id),
    -- One obligation per exact version; a different version of the same
    -- submission is a second, legitimate obligation.
    UNIQUE KEY uq_cleanup_target (submission_id, object_etag, object_size_bytes),
    -- Claim order: keyset (created_at_ms, id) over pending rows, lease filtered
    -- in the same index scan.
    KEY k_cleanup_claim (state, created_at_ms, id),
    -- Lease expiry sweeps / operator views.
    KEY k_cleanup_lease (state, lease_until_ms),
    KEY k_cleanup_tenant (tenant_id, state, created_at_ms)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
```

This block is the **pre-migration proposal**. The adopted, reconciled contract —
every column with its exact type/nullability, all thirteen `CHECK`s, and the
statement-to-index mapping — is §G (§4.1 is superseded by it wherever the two
differ; the one line that already changed is `last_failure` above).

Why `utf8mb4_0900_bin` and not `utf8mb4_bin`: in MySQL 8 `utf8mb4_bin` is
PAD SPACE, so `'"etag"'` and `'"etag" '` compare equal and the UNIQUE key would
silently collapse two different versions into one obligation. The collation must
be chosen from server metadata, and MariaDB / an unknown version must be treated
as `unknown` rather than assumed to support `0900`.

### 4.2 `recordPending` (idempotent insert)

```sql
INSERT INTO assignment_cleanup_obligations
    (id, tenant_id, assignment_id, student_enrollment_id, submission_id, storage_key,
     object_etag, object_size_bytes, reason, state, claim_owner, claim_version,
     lease_until_ms, attempts, last_failure, retry_after_ms, completion_proof,
     created_at_ms, updated_at_ms, completed_at_ms)
VALUES (?,?,?,?,?,?,?,?,?,'pending',NULL,0,NULL,0,NULL,NULL,NULL,?,?,NULL)
ON DUPLICATE KEY UPDATE id = id;
```

Eleven bound parameters, in this order: `id, tenant_id, assignment_id,
student_enrollment_id, submission_id, storage_key, object_etag,
object_size_bytes, reason, created_at_ms, updated_at_ms`. Every other column is
an explicit literal (`'pending'`, `NULL`, `0`) rather than a default, so the
statement satisfies `chk_assignment_cleanup_10` (owner/lease pair) and
`chk_assignment_cleanup_12` (a `pending` row carries no proof and no settlement
instant) by construction, on a table whose defaults are not read.
`ASSIGNMENT_CLEANUP_STATEMENTS.insert` (`assignment-cleanup-sql.ts:759-765`) is
the same bytes.

`affectedRows`: `1` = inserted (`recorded`), `0` (or `2` on some drivers) =
existing. The adapter must then read back `id, claim_version, state` for the
unique tuple and answer:

- `existing` when the row is `pending`;
- `conflict` when the same **submission** already has a `pending` row for a
  different version — the request path must then not delete (the older
  obligation is still owed), and the coordinator owns it; **this rule is not
  implemented by the adapter and contradicts §3.1 + `uq_cleanup_target` — see
  §G.6 item 9**;
- `conflict` when the row is terminal (nothing left to do for this version).

The adapter must run this insert on the **caller's** transaction when one is
provided (`recordPending(target, tx)`), so a rejection/cancellation cannot
commit without its obligation.

### 4.3 `claimBatch`

```sql
SELECT id, tenant_id, assignment_id, student_enrollment_id, submission_id,
       storage_key, object_etag, object_size_bytes, reason, state,
       claim_owner, claim_version, lease_until_ms, attempts, last_failure,
       created_at_ms, updated_at_ms
FROM assignment_cleanup_obligations
WHERE state = 'pending'
  AND (claim_owner IS NULL OR lease_until_ms <= ?)          -- nowMs
  AND (retry_after_ms IS NULL OR retry_after_ms <= ?)        -- nowMs
  AND (created_at_ms > ? OR (created_at_ms = ? AND id > ?))  -- keyset, when after != null
ORDER BY created_at_ms ASC, id ASC
LIMIT ?                                                      -- clamped integer literal
FOR UPDATE SKIP LOCKED;
```

then, in the same transaction, one stamped update per claimed id:

```sql
UPDATE assignment_cleanup_obligations
SET claim_owner = ?, claim_version = claim_version + 1,
    lease_until_ms = ?, updated_at_ms = ?
WHERE id = ? AND state = 'pending'
  AND (claim_owner IS NULL OR lease_until_ms <= ?);
```

`affectedRows = 0` ⇒ another worker won that row: skip it, do not report it as
claimed. `SKIP LOCKED` is what keeps two workers from blocking on each other; the
`claim_version` bump is what makes a stale lease harmless.

### 4.4 `completeClaim` / `releaseClaim` / `completeUnclaimed`

```sql
UPDATE assignment_cleanup_obligations
SET state = ?, completion_proof = ?, claim_owner = NULL,
    claim_version = claim_version + 1, lease_until_ms = NULL,
    completed_at_ms = ?, updated_at_ms = ?
WHERE id = ? AND state = 'pending' AND claim_owner = ? AND claim_version = ?
  AND lease_until_ms > ?;
```

```sql
UPDATE assignment_cleanup_obligations
SET claim_owner = NULL, claim_version = claim_version + 1, lease_until_ms = NULL,
    attempts = attempts + 1, last_failure = ?, retry_after_ms = ?, updated_at_ms = ?
WHERE id = ? AND state = 'pending' AND claim_owner = ? AND claim_version = ?
  AND lease_until_ms > ?;
```

```sql
UPDATE assignment_cleanup_obligations
SET state = ?, completion_proof = ?, completed_at_ms = ?, updated_at_ms = ?
WHERE id = ? AND state = 'pending'
  AND claim_owner IS NULL AND lease_until_ms IS NULL AND claim_version = ?;
```

`completeUnclaimed` is the request path's settlement of a row it recorded and
finished itself: `claim_owner IS NULL` means no coordinator has taken it, so a
coordinator that already claimed it wins and this call is a no-op. A `0` here is
not an error — the row stays `pending` and the coordinator replays it, deriving
the same terminal state from the store's own answer.

### 4.5 Fenced scan verdict (opt-in, for the existing worker)

Today the verdict CAS is bound to the row identity, `scan_status='pending'`,
`status<>'revoked'` and `file_size_bytes` — but **not** to a claim. Add:

```sql
ALTER TABLE assignment_submissions
  ADD COLUMN scan_claim_owner VARCHAR(64) NULL,
  ADD COLUMN scan_claim_version INT NOT NULL DEFAULT 0,
  ADD COLUMN scan_lease_until_ms BIGINT NULL,
  ADD COLUMN scan_attempts INT NOT NULL DEFAULT 0,
  ADD COLUMN scan_last_error VARCHAR(255) NULL,
  ADD COLUMN scan_next_attempt_ms BIGINT NULL,
  ADD COLUMN object_etag VARCHAR(256) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin NULL,
  ADD KEY k_scan_claim (scan_status, scan_next_attempt_ms, submitted_at, id);
```

The fenced verdict write (only when the store declares
`capabilities.fencedVerdictWrite === true`):

```sql
UPDATE assignment_submissions
SET scan_status = ?,
    scan_claim_owner = NULL, scan_claim_version = scan_claim_version + 1,
    scan_lease_until_ms = NULL, scan_last_error = NULL
WHERE id = ? AND tenant_id = ? AND assignment_id = ? AND student_enrollment_id = ?
  AND scan_status = 'pending' AND file_size_bytes = ? AND status <> 'revoked'
  AND scan_claim_owner = ? AND scan_claim_version = ? AND scan_lease_until_ms > ?;
```

`object_etag` closes the last provenance gap: without it two objects of the same
size are indistinguishable to the verdict CAS (the older I2 request, contract
`ASSIGNMENT-UPLOAD-FINALIZE.md` §9.4). With it the write can also require
`object_etag = ?`.

### 4.6 Gaps this contract does **not** close

- `assignment_submissions.object_etag` is still needed for the *verdict* binding
  (§4.5); the obligation table records the *cleanup* target and is not a
  substitute.
- No column stores "this row's bytes are still owed" on the submission itself.
  The obligation table is the single source of that fact; do not add a second
  flag that can drift from it.
- The production MinIO adapter declares `conditionalDelete: false`. Until a
  version-capable adapter exists (versioned bucket + a version-scoped delete),
  every obligation stays `pending` with `capability_absent` and nothing is
  deleted. That is the honest state, not a defect of this source.

---

## 5. Lifecycle hooks (for Codex)

```ts
import { createAssignmentRecoveryRuntime } from './services/assignment-recovery-factory';

const recovery = createAssignmentRecoveryRuntime({
    objectStore,            // the same adapter the router uses
    cleanupStore,           // §4 adapter, only once the table exists
    scanStore,              // createSqlAssignmentScanStore(...) today
    scanner,                // undefined ⇒ scan pass reports `scanner-unconfigured`
    listing,                // optional, plan-only orphan surface
    submissionLookup,       // optional, plan-only orphan surface
    onError: (e) => logger.error({ err: e }, 'assignment recovery'),
});

logger.info({ readiness: recovery.describeReadiness() }, 'assignment recovery readiness');
```

- **Construction is inert.** No query, no connection, no timer, no claim. A
  runtime that is constructed and never run does nothing.
- **Run**: `await recovery.runOnce()` from the existing scheduler tick. It never
  schedules the next tick itself.
- **Shutdown**: `recovery.stop()` then `await recovery.drain()`. `stop` is
  cooperative: no new pass or cleanup item starts, an in-flight delete or scan
  finishes (a scan is already wall-clock bounded by `scanTimeoutMs`).
- **Router wiring** (only after §4.1 lands): pass
  `cleanupObligations: cleanupStore` to `createAssignmentsRouter`. Until then the
  router keeps the documented `cleanup-unconfigured` behaviour — do **not** pass
  an in-process queue.
- **No mount.** This task adds no route and no `app.use`.
- Readiness is configuration, not verification: `verified: false` is a literal,
  because nothing here proves the schema, the adapter or the scanner works.

Readiness reasons (`AssignmentRecoveryReason`): `object-store-unconfigured`,
`cleanup-store-unconfigured`, `exact-delete-unsupported`,
`scan-store-unconfigured`, `scanner-unconfigured`,
`orphan-listing-unconfigured`, `orphan-lookup-unconfigured`.

---

## 6. Independent source review (traces only, no executable probes)

1. **Cross-tenant input.** Every route path resolves `enrollment.tenantId` from
   the verified session and loads the row with
   `tenant_id = ? AND student_enrollment_id = ?`; the key is then re-parsed and
   must match all four identifiers (`verifySubmissionStorageKey` in the route,
   `normalizeCleanupTarget` again in the coordinator and in the orphan planner).
   The planner derives `tenants/{tenantId}/assignments/` itself and counts any
   returned key of another tenant as `rejectedKeys` instead of using it. The scan
   worker re-verifies the binding before any stat. **Verdict: no path reaches an
   object it did not prove belongs to the caller's tenant and submission.**
2. **Replaced object.** Finalize re-stats and answers `409 object_replaced`; the
   coordinator re-stats and answers `superseded` **without any delete**; the
   store answers `version_replaced` and destroys nothing. A replacement version
   therefore always survives. **Verdict: no path deletes bytes it did not name.**
3. **Duplicate finalize.** The CAS plus `sameOutcome` (same size **and** same
   verdict) makes the loser a `200` replay with no audit and no second delete; a
   winner with a different verdict yields `409 finalize_conflict`. **Verdict:
   one obligation, one delete, one audit.**
4. **Missing ETag.** `boundObjectVersion` returns null ⇒ finalize `503
   object_version_unbound` before any write; worker `unbound_object_version`;
   coordinator releases with `capability_absent`. **Verdict: unprovable bytes are
   never scanned, recorded or deleted.**
5. **Adapter lacks exact-delete.** `supportsExactVersionRemoval` requires both
   the declared flag and the method. Without them: no delete, log line
   `cleanup pending`, coordinator refuses to claim
   (`halted:'capability_absent'`), readiness `exact-delete-unsupported`. There is
   no `removeObject(key)` fallback anywhere in these five files. **Verdict: the
   key is never the target.**
6. **Expired / lost lease.** `completeClaim` and `releaseClaim` are fenced on
   `(id, owner, claim_version)` **and** `lease_until_ms > now`; `false` halts the
   run. The scan worker takes a durable claim only when the store declares its
   verdict write enforces the fence, and reports `claimFencing: 'in-run-only'`
   otherwise. **Verdict: a stale worker cannot silently overwrite the row's new
   owner; where that cannot be guaranteed, the run says so.**
7. **Audit failure.** Audit, state change and obligation share one transaction at
   every point that owns one (verdict, cancel). A failed audit rolls the whole
   unit back and answers `500`; nothing is claimed and nothing is deleted.
   **Verdict: no unaudited state change, no obligation-less quarantine.**
8. **Crash after delete before DB acknowledgement.** The row stays `pending`; the
   replay re-stats, finds nothing, completes as `deleted` (`pre_stat_absent`).
   When the delete was confirmed by the store instead, the store's
   `already_absent` proves the same thing. **Verdict: replay converges; no
   double delete, no lost obligation.**
9. **Scanner unavailable.** Absent ⇒ `scanner_absent` abort with zero claims;
   `failed`/throw/timeout ⇒ `scan_failed` / `502 scan_unavailable`, row untouched
   and retryable; a `failed` verdict is never reinterpreted as clean; an
   unconfirmed verdict is retried only inside the configured per-row cap.
   **Verdict: uploaded is still never clean.**

Also re-checked: `stop()` between items leaves claimed rows to lease expiry
(safe, idempotent); `items` can be smaller than `claimed` and `pending` is
defined as `items - deleted - superseded`; a store returning a non-`pending` row
for a claim is released as `record_state_invalid` rather than guessed at.

---

## 7. Honest limitations (held, not faked)

- **No durable store in production** ⇒ `cleanup-unconfigured`: rejections and
  cancels still delete the exact version best-effort, and every cleanup that
  cannot be proven is reported pending in the log, never as queued.
- **No exact-version delete in production** (`conditionalDelete: false`) ⇒ every
  obligation would stay `pending`; the pending set is explained at deployment
  level by readiness (`exact-delete-unsupported`), because claiming rows we
  cannot act on would only burn leases.
- **No scanner** ⇒ `pending_scan` forever, `clean` unreachable, scan pass
  `scanner-unconfigured`.
- **No per-row failure marker for an immediate failure**: a `pending` row whose
  request-path delete returned `unsupported`/`failed` carries no `last_failure`
  until a coordinator claims it. The immediate failure is in the log and in the
  run report; persisting it needs no new column (the column exists in §4.1) but
  would need a sixth port method, which this task deliberately did not add.
- **Orphan reconciliation is plan-only.** `planTenantOrphanReconciliation`
  deletes nothing, counts nothing globally, and requires an explicit
  `notModifiedSinceMs` — a retention window is a deployment decision, and
  inventing one here would authorize deletions nobody agreed to.
- **No timer, no mount, no provider, no migration.**

---

## 8. Hashes and attribution

Branch `codex/workbuddy-server`, snapshot `cab9120`. Baseline captured **before**
the claim was used to write anything; the claim token was obtained from the
bridge before the first write.

| path | baseline sha256 | baseline B | after sha256 | after B |
|---|---|---|---|---|
| `server/src/routes/assignments.ts` | `ae3786f32c03461b3ec8aa9e62a6469d42bc4c4befb155265e717cf07086c082` | 103625 | `f955f25c024167a08f5e7dbd4a66d7b60f6dfc6820e1c0936dc745f7bdb1d098` | 113005 |
| `server/src/services/assignments.ts` | `5255bdf2e1e973db62dc355b16ef70fd38140ced434b8f17ec7beff6ef2af28f` | 24178 | `f1f2aacc0bf8fdb012c95c305a015de9d115c8a542788634aded6f473057b14b` | 25294 |
| `server/src/services/assignment-storage.ts` | `4682fef08629d795c5ff7c1ef282f32333f032d857492036f528065939a5d0fc` | 24486 | `4682fef08629d795c5ff7c1ef282f32333f032d857492036f528065939a5d0fc` | 24486 |
| `server/src/services/assignment-scan-worker.ts` | `f079965948424b8aa3cfaa6f79cf855da53bf0286c9c64757838ed1dc874403e` | 25685 | `f3d43a5f58703bc301ed480a67016dc63da5d7ba4aacdbec3233ec3fafee3f36` | 34423 |
| `server/src/services/assignment-cleanup-recovery.ts` | *(absent — new file, registered to this task)* | — | `3e59422b4308ba30039fa3c5c41c26d05e54c436d255fa80e1557a5096f5026d` | 42875 |
| `server/src/services/assignment-recovery-factory.ts` | *(absent — new file, registered to this task)* | — | `d5277cc8d40b8f0ee63aff9ee6cd78add34e3195f6713836830cb010b67e5338` | 14842 |
| `docs/streams/server/WORKBUDDY-ASSIGNMENT-RECOVERY-20261023.md` | *(absent — new file, registered to this task)* | — | *recorded in the handoff file after this document was finalised* | — |

- **Byte-identical, inherited, untouched:** `assignment-storage.ts`. Its
  capability-gated seam (`supportsExactVersionRemoval`,
  `removeScannedObjectVersion`, `boundObjectVersion`, key binding) is reused
  as-is; no change was needed, so none was made.
- **Inherited and modified:** `routes/assignments.ts`,
  `assignments.ts`, `assignment-scan-worker.ts` — all three were written by
  earlier WorkBuddy tasks (`server-assignment-upload-finalize-20261019-01`,
  `server-assignment-private-storage-completion-20261019-01`,
  `server-b2-w4-assignment-recovery-20261021-01`) and their behaviour is
  preserved except where this task states otherwise.
- **New, owned by this task:** `assignment-cleanup-recovery.ts`,
  `assignment-recovery-factory.ts`, this document. All three are registered in
  `THREE-LANE-FILE-OWNERSHIP-20261022.json` under `workbuddy`.
- **Nothing outside the seven allowed paths was written.** No live task was
  repeated, no SQL was executed, no provider or scanner was contacted, no Git
  state was mutated.

### 8.1 Task B delta (`server-assignment-cleanup-sql-fencing-20261023-01`)

The table above is the Task A record and is left unedited. Task B's baseline was
captured **after** Task A reported and **before** Task B's claim was used to
write anything; the claim token was obtained from the bridge first.

| path | baseline-B sha256 | B | after-B sha256 | B |
|---|---|---|---|---|
| `server/src/routes/assignments.ts` | `f955f25c024167a08f5e7dbd4a66d7b60f6dfc6820e1c0936dc745f7bdb1d098` | 113005 | `000dbfcc0fd44208e2be61ad9e7c81ed6b922ca5cbbe5a6f9535a6894f268e44` | 116004 |
| `server/src/services/assignments.ts` | `f1f2aacc0bf8fdb012c95c305a015de9d115c8a542788634aded6f473057b14b` | 25294 | `f1f2aacc0bf8fdb012c95c305a015de9d115c8a542788634aded6f473057b14b` | 25294 |
| `server/src/services/assignment-storage.ts` | `4682fef08629d795c5ff7c1ef282f32333f032d857492036f528065939a5d0fc` | 24486 | `4682fef08629d795c5ff7c1ef282f32333f032d857492036f528065939a5d0fc` | 24486 |
| `server/src/services/assignment-scan-worker.ts` | `f3d43a5f58703bc301ed480a67016dc63da5d7ba4aacdbec3233ec3fafee3f36` | 34423 | `b1cfdf237156e45ba1b6fdb15554b082b28305d900ee712ae6a13be5908ef4a9` | 50544 |
| `server/src/services/assignment-cleanup-recovery.ts` | `3e59422b4308ba30039fa3c5c41c26d05e54c436d255fa80e1557a5096f5026d` | 42875 | `6313eca0d0b77dabb9a19c0211b66fa8bf565f21942956b82df7d3822b3b2ab9` | 45166 |
| `server/src/services/assignment-recovery-factory.ts` | `d5277cc8d40b8f0ee63aff9ee6cd78add34e3195f6713836830cb010b67e5338` | 14842 | `18a2df08bf3d6979c872bd17ff1904f5e0a5b4958d9a2a4a04ffb1558f7ae983` | 16243 |
| `server/src/services/assignment-cleanup-sql.ts` | *(absent — new file, registered to this task)* | — | `7df13f616871e65466f548afd6e1322c869c4b2304c95b488db24037686cecb4` | 27149 |
| `docs/streams/server/WORKBUDDY-ASSIGNMENT-RECOVERY-20261023.md` | `f47e2998…` | 29713 | *changes with every revision of this file; the delivered hash is in the handoff record* | — |

Every hash above except this document's own is a full 64-character sha256. The
document's row cannot contain its own hash (writing it would change the hash),
so its delivered value is recorded in
`WorkBuddySupervisorBridge/handoff/WORKBUDDY-ASSIGNMENT-SQL-FENCING-HANDOFF-20261023.md`.
Two paths are **byte-identical to baseline-B** — `assignment-storage.ts` and
`assignments.ts` — so nothing in Task B changed the storage seam or the reason
vocabulary.

### 8.2 Adapter invariant closure delta (`server-assignment-adapter-invariant-closure-20261023-01`)

Baseline captured before the claim was used to write anything.

| path | baseline-C sha256 | B | after-C sha256 | B |
|---|---|---|---|---|
| `server/src/routes/assignments.ts` | `000dbfcc0fd44208e2be61ad9e7c81ed6b922ca5cbbe5a6f9535a6894f268e44` | 116004 | `ac84fb1eada04222b34467db3fea5c9b1ca914bedcbc44f44914a1a6a9fbc446` | 116364 |
| `server/src/services/assignments.ts` | `f1f2aacc0bf8fdb012c95c305a015de9d115c8a542788634aded6f473057b14b` | 25294 | `f1f2aacc0bf8fdb012c95c305a015de9d115c8a542788634aded6f473057b14b` | 25294 |
| `server/src/services/assignment-storage.ts` | `4682fef08629d795c5ff7c1ef282f32333f032d857492036f528065939a5d0fc` | 24486 | `4682fef08629d795c5ff7c1ef282f32333f032d857492036f528065939a5d0fc` | 24486 |
| `server/src/services/assignment-scan-worker.ts` | `b1cfdf237156e45ba1b6fdb15554b082b28305d900ee712ae6a13be5908ef4a9` | 50544 | `378c9988b5c4e7cf24a9dbd801c3d262369785134f5327a6da64c7fef94cda91` | 56803 |
| `server/src/services/assignment-cleanup-recovery.ts` | `6313eca0d0b77dabb9a19c0211b66fa8bf565f21942956b82df7d3822b3b2ab9` | 45166 | `ba485c849357e5005f885eb9926e019d7c6f2bb1e73edba1f422a8b53e73bce1` | 48017 |
| `server/src/services/assignment-recovery-factory.ts` | `18a2df08bf3d6979c872bd17ff1904f5e0a5b4958d9a2a4a04ffb1558f7ae983` | 16243 | `18a2df08bf3d6979c872bd17ff1904f5e0a5b4958d9a2a4a04ffb1558f7ae983` | 16243 |
| `server/src/services/assignment-cleanup-sql.ts` | `7df13f616871e65466f548afd6e1322c869c4b2304c95b488db24037686cecb4` | 27149 | `2d060acd6f6e0aac051c42b1267d83610c9ac8106c04dad0c8b8d8e109e2f394` | 35430 |
| `docs/streams/server/WORKBUDDY-ASSIGNMENT-RECOVERY-20261023.md` | `fd09863a078499875d7ba51254b36afb22b04be328c7909218dc762c69cd12da` | 43202 | *this revision; delivered hash in the handoff record* | — |

Three paths are **byte-identical to baseline-C**: `assignments.ts`,
`assignment-storage.ts` and `assignment-recovery-factory.ts`. The factory needed
no change because it never consumes the per-pass halt reason — `invalid_row`
surfaces inside `cleanup.halted` / `scan.aborted`, which the report already
carries verbatim.

---

## 9. Questions for the supervisor

> **Status after Task B.** Questions 1–3 were answered by
> `CODEX-ASSIGNMENT-SQL-FENCING-DECISIONS-20261023.txt` and are now
> implementation, not questions: the table stays Claude-owned under the migration
> name `20261023_05_assignment_cleanup_scan_fencing.sql`, **shipped as
> `20261024_06_assignment_cleanup_scan_fencing.sql`** (§G.6); the scan store ships
> **fenced** behind a literal schema declaration and a collation probe, with
> `unavailable` — never a silent downgrade — when either is absent; and
> `object_etag` ships in the same migration because it is the only way to bind a
> verdict to a version. Questions 4 and 5 remain open.

1. **Table ownership.** §4.1 authors a new table
   (`assignment_cleanup_obligations`) with a `utf8mb4_0900_bin` identity column.
   Is that a Claude-owned migration under the current lane split, and should the
   collation choice be gated on a server-version probe (as with R22) or declared
   as a hard MySQL 8 requirement?
2. **Scan fencing.** §4.5 adds five claim/attempt columns to
   `assignment_submissions` and a fenced verdict statement. Should the reference
   SQL store ship with it (making `createSqlAssignmentScanStore` fenced), or stay
   as the honest un-fenced reference until a deployment adapter needs it?
3. **`object_etag` on the submission row.** It is the only way to bind a
   *verdict* to a version. Do you want it in the same migration as the obligation
   table, or deferred until the download gate exists?
4. **Orphan deletion.** The planner stops at a plan. The deletion step needs a
   retention decision (and a dry-run evidence trail). Is that a separate,
   explicitly approved task, or should it stay unimplemented?
5. **Verification.** No tests and no typecheck were run, per the task
   instructions. The next verifiable step is a focused suite over
   `createAssignmentCleanupRecovery` (claim/fence/replay) plus a typecheck once
   the lane allows it; both are outside this claim.

---

## 10. Task B: the SQL adapter, the verdict binding, and the `20261024_06` contract

*(Filed as `20261023_05`; the authored file is `20261024_06_assignment_cleanup_scan_fencing.sql` —
§G.6 item 1.)*

This section is the contract Claude's migration must satisfy, stated against the
code that already exists. Every name below is a real export; every literal is
copied from the source, not retyped from memory.

### 10.1 What Task B added, and why each part exists

| addition | file | the gap it closes |
|---|---|---|
| `AssignmentCleanupTx` requires `query` **and** `execute` | `assignment-cleanup-recovery.ts` | §4.2 specified the read-back on the caller's transaction, but the port only exposed `execute`, so the read-back could not be classified inside the unit. |
| `availability` on the store port + `store_unavailable` | `assignment-cleanup-recovery.ts` | A store that exists but is unusable is not the same as no store. Conflating them reported `unconfigured` for a misconfigured deployment. |
| `assignment-cleanup-sql.ts` (new) | — | The connection-bound adapter, the collation probe, and the statements as reviewable data. |
| `expectedEtag` on the verdict + same-size guard | `assignment-scan-worker.ts` | Two objects of the same size were indistinguishable to the verdict CAS. |
| fenced / reference / unavailable scan stores | `assignment-scan-worker.ts` | A fenced claim the verdict does not enforce is not a claim. |
| `objectVersionColumn` on the router | `routes/assignments.ts` | The finalize write can now persist the verified version, but only when the column is declared. |

### 10.2 Migration `20261024_06_assignment_cleanup_scan_fencing.sql` (Claude-owned; not authored here)

**Table `assignment_cleanup_obligations`** — exactly §4.1, unchanged by Task B,
plus the thirteen `CHECK`s and the `NOT NULL`/collation detail listed in §G.3.
No column was added in this task.

**Additive columns on `assignment_submissions`** — the seven from §4.5:

```sql
ALTER TABLE assignment_submissions
  ADD COLUMN scan_claim_owner     VARCHAR(64)  NULL,
  ADD COLUMN scan_claim_version   INT          NOT NULL DEFAULT 0,
  ADD COLUMN scan_lease_until_ms  BIGINT       NULL,
  ADD COLUMN scan_attempts        INT          NOT NULL DEFAULT 0,
  ADD COLUMN scan_last_error      VARCHAR(255) NULL,
  ADD COLUMN scan_next_attempt_ms BIGINT       NULL,
  ADD COLUMN object_etag          VARCHAR(256) CHARACTER SET utf8mb4
                                  COLLATE utf8mb4_0900_bin NULL,
  ADD KEY k_scan_claim (scan_status, scan_next_attempt_ms, submitted_at, id),
  ADD CONSTRAINT chk_assignment_scan_version CHECK (scan_claim_version >= 0),
  ADD CONSTRAINT chk_assignment_scan_attempts CHECK (scan_attempts >= 0),
  ADD CONSTRAINT chk_assignment_scan_lease CHECK (scan_lease_until_ms IS NULL OR scan_lease_until_ms > 0),
  ADD CONSTRAINT chk_assignment_scan_retry CHECK (scan_next_attempt_ms IS NULL OR scan_next_attempt_ms > 0),
  ADD CONSTRAINT chk_assignment_scan_owner_pair CHECK ((scan_claim_owner IS NULL) = (scan_lease_until_ms IS NULL));
```

Four requirements the source depends on, each with its reason:

1. **No backfill of `object_etag`.** See §10.5. A backfill would invent a
   version that no finalize ever verified.
2. **`utf8mb4_0900_bin` requires MySQL 8.0.1 or later.** On MariaDB the column
   cannot be created at all. If the target is MariaDB, do **not** substitute
   `utf8mb4_bin`: it is PAD SPACE, so `'"e"'` and `'"e "'` compare equal and the
   UNIQUE key on the obligation table silently merges two versions into one
   obligation. The probe answers `unknown` and the fenced stores refuse; that is
   the intended outcome, not a deployment bug to work around.
3. **`scan_attempts` and `scan_last_error` are written only by `fencedRelease`.**
   A successful verdict clears `scan_last_error`; it never increments attempts.
4. **`k_scan_claim` must match the fenced claim predicate** —
   `scan_status`, `scan_next_attempt_ms`, `submitted_at`, `id` — or the claim
   page degrades to a scan of every pending row.

### 10.3 The exact statements, exported as data

Both statement sets are exported so the contract can be reviewed against the
bytes that will run, instead of being retyped into a document and drifting.

`ASSIGNMENT_CLEANUP_STATEMENTS` (in `assignment-cleanup-sql.ts`) has exactly
eight keys: `insert`, `readByIdentity`, `claimPage`, `claimPageAfter`,
`stampClaim`, `completeClaim`, `releaseClaim`, `completeUnclaimed`.

Both claim-page strings come from one function,
`buildAssignmentCleanupClaimPage(withKeyset)`, and `claimBatch` calls that same
function. The exported SQL and the executed SQL are therefore the same bytes by
construction — the earlier revision of this document described a commented
`-- keyset:` placeholder beside the real statement, and §11 removed that: an
exported contract that advertises SQL the adapter never sends is worse than no
contract at all.

`ASSIGNMENT_SCAN_STATEMENTS` (in `assignment-scan-worker.ts`) has six keys:
`referenceClaim`, `referenceVerdict`, `fencedClaimPage`, `fencedClaimStamp`,
`fencedVerdict`, `fencedRelease`.

The fence lives in `fencedVerdict` and nowhere else. Its predicate is the whole
point of the migration:

```sql
WHERE id=? AND tenant_id=? AND assignment_id=? AND student_enrollment_id=?
  AND scan_status='pending' AND file_size_bytes=? AND status<>'revoked'
  AND object_etag=? AND scan_claim_owner=? AND scan_claim_version=?
  AND scan_lease_until_ms>?
```

Owner, version and unexpired lease are in the **same statement** as the status
write. A lease checked in a separate round-trip is not a fence: the row can be
re-claimed between the check and the write. That is why
`capabilities.fencedVerdictWrite` is a capability the store must declare, and
why the fenced store refuses to list a pending batch at all — there is no
un-fenced path through it to fall back to.

### 10.4 Readiness: the collation probe is a measurement, not an assumption

`probeAssignmentEtagCollation(connection, { table?, column? })` returns:

```ts
{
  verdict: { status: 'no-pad-verified'; collation: string }
         | { status: 'pad-space'; collation: string }
         | { status: 'unknown'; reason: 'server-version-unknown'
                              | 'column-not-found'
                              | 'pad-attribute-unavailable' };
  serverVersion: string | null;
  columnCollation: string | null;
  padAttribute: string | null;
  portable: false;   // literal
}
```

It is never called at import or construction, and no query is issued by the
module on load; the caller decides when to measure (startup readiness, an
operator probe). The ladder is:

- server is not MySQL 8, or reports MariaDB ⇒ `unknown` /
  `server-version-unknown` — before any column is looked at;
- the column does not exist ⇒ `unknown` / `column-not-found`;
- `information_schema.COLLATIONS` has no `PAD_ATTRIBUTE` (MariaDB) or it is
  NULL ⇒ `unknown` / `pad-attribute-unavailable`;
- `PAD_ATTRIBUTE = 'NO PAD'` ⇒ `no-pad-verified`; anything else ⇒ `pad-space`.

`portable: false` is literal on every branch. `utf8mb4_0900_bin` is a MySQL 8
fact, not a portable promise, and a caller must not promote `unknown` to
`no-pad-verified` on its own.

### 10.5 Legacy rows: `re-finalize-required`

`LEGACY_UNBOUND_ETAG_POLICY = 're-finalize-required'`.

`fencedClaimPage` requires `object_etag IS NOT NULL`. A `pending_scan` row
written before this migration therefore has no version binding, and the fenced
claim never touches it: it is not backfilled, not inferred from a `statObject`,
and not scanned. The only exit is re-finalization, which records the version it
actually verified. Inferring a version from the current object would bind the
verdict to bytes nobody uploaded under that row — the exact defect this column
exists to prevent.

### 10.6 When the schema is absent, the answer is `unavailable`

The two stores have **different** availability shapes, and the difference is
deliberate:

```ts
AssignmentCleanupStoreAvailability = { mode: 'durable' | 'unavailable'; reason: ... | null }
AssignmentScanStoreAvailability    = { mode: 'fenced' | 'reference-unfenced' | 'unavailable'; reason: ... | null }
```

The reasons are closed:

| store | reason | produced when |
|---|---|---|
| cleanup | `schema-not-declared` | `schema` is absent or `obligations !== 'declared'` |
| cleanup | `transaction-capability-absent` | the client has no `transaction` function |
| cleanup | `etag-collation-unverified` | `etagCollation.status !== 'no-pad-verified'` |
| scan | `schema-not-declared` | options supplied and `fencingColumns !== 'declared'` |
| scan | `etag-collation-unverified` | options supplied and `etagCollation.status !== 'no-pad-verified'` |

Each reason is reachable — the `transaction-capability-absent` branch was added
in this task precisely because the union previously declared it while nothing
produced it, which is a capability claim the code did not make.

**The cleanup store has no reference mode.** `createSqlAssignmentCleanupStore(client, options)`
requires `options`, and a durable obligation store that cannot be trusted has no
weaker sibling to fall back to: returning one would let the coordinator claim
rows it cannot settle. Failing a gate yields `{ mode: 'unavailable' }` and every
method refuses.

**The scan store does have one, and only when it is asked for nothing.**
`createSqlAssignmentScanStore(client)` with no options returns the explicit
`reference-unfenced` store — the pre-existing behaviour, honestly labelled.
Supplying options and failing a gate yields `unavailable`, never a quiet fall
back to that reference store.

The coordinator halts with `'store_unavailable'`, and the factory reports
`cleanup-store-unavailable` / `scan-store-unavailable` with halt reason
`'unavailable'`, so a deployment can tell "nobody configured a store" from
"somebody configured one that cannot be trusted".

### 10.7 What the router needs, and what is deliberately still off

`routes/assignments.ts` reads two optional dependencies:

- `deps.cleanupObligations` — the store; absent ⇒ `cleanup-unconfigured`;
- `deps.objectVersionColumn === 'declared'` — gates `object_etag=?` in the
  finalize `UPDATE`. The literal is deliberate: `true` would let a caller
  persist a column the migration may not have created.

The default production router passes **neither**. That is the honest state until
`20261024_06` is applied: the code is correct and inert, and no deployment can
accidentally write a column that isn't there or record an obligation no table
can hold.

### 10.8 What this task still does not do

- **No exact-version delete.** The MinIO adapter still declares
  `conditionalDelete: false`. Nothing here invents a conditional delete;
  obligations stay `pending` with `capability_absent`.
- **No migration, no DB contact, no provider, no scanner.** No statement in this
  document was executed.
- **No tests, no typecheck** — per the task instructions. The structural checks
  that were run are listed in the handoff record and are not a substitute for
  either.

---

## 11. Adapter invariant closure (`server-assignment-adapter-invariant-closure-20261023-01`)

Task B delivered the adapter. This pass went through the executable bodies and
fixed what a body-level review found. Nothing here is a new feature; every item
is a case where the code would have produced a confident wrong answer.

### 11.1 The coercion defect, stated exactly

`toInt` was:

```ts
const parsed = typeof value === 'number' ? value : Number(value);
return Number.isFinite(parsed) ? parsed : null;
```

and the projection then wrote `?? 0` for `sizeBytes`, `claimVersion`,
`attempts`, `createdAtMs` and `updatedAtMs`. What that accepted:

| stored value | `Number()` | projected as | consequence |
|---|---|---|---|
| `''` or `'  '` | `0` | `0` | zero-byte object, version 0 |
| `'1.5'` | `1.5` | `1.5` | non-integer version written back into a fence |
| `'0x10'` | `16` | `16` | a version nobody wrote |
| `'1e3'` | `1000` | `1000` | same |
| `'9007199254740993'` | `9007199254740992` | imprecise | increment can stop changing the value |
| `'abc'` | `NaN` | `0` | **fence reset to 0** |

The last row is the dangerous one. A request-path settlement matches on
`claim_version = ?`, and the handle's version came from that projection. A
corrupt version projected as `0` produced a handle that would match a row whose
stored version is also unreadable — the settlement would complete a row whose
claim history is unknown. That is a fence reset, not a rounding error.

### 11.2 What replaced it

`parseSafeInt` accepts only digits with an optional minus, then requires
`Number.isSafeInteger`. `requireSafeInt` throws
`AssignmentCleanupRowInvalidError` (code `'invalid_row'`) instead of returning a
default. `toRecord` now refuses a row when:

- `id` is missing or empty, or `object_etag` is not a non-empty string;
- `object_size_bytes`, `claim_version`, `attempts`, `created_at_ms`,
  `updated_at_ms` is not a safe integer, or is negative;
- `updated_at_ms < created_at_ms` (a keyset cursor would move backwards);
- `claim_owner` and `lease_until_ms` are not both set or both clear — a stamped
  claim writes both and every release path clears both, so a half-pair is a row
  whose fence cannot be reasoned about;
- `state`, `reason` or `last_failure` is outside the closed unions (these used to
  throw plain `Error`; they now throw the typed error so the caller can classify
  them without string matching).

`claimBatch` no longer computes `(toInt(...) ?? 0) + 1`. It requires a readable
version, refuses an increment that would leave the safe-integer range, and
refuses a non-positive `file_size_bytes`.

The fenced scan store had the same shape: `Number(row.scan_claim_version ?? 0) + 1`
turned an unreadable version into `1` — the value a *first* claim would have.
A row whose version cannot be read must never be claimed, because the stamp would
hand out a weaker fence than the row has already seen. It now throws
`AssignmentScanRowInvalidError`, and the worker does not retry it.

### 11.3 `affectedRows`: exact, and never guessed

Every fenced write now goes through `affectedRowsOf` / `scanAffectedRows`, which
return the reported count or throw. `undefined` is not zero:

- treating it as `0` silently drops a claim the caller actually won (the row then
  looks unclaimed to this run while the lease is held);
- treating it as `1` fabricates a claim.

Single-row CAS statements are compared with `=== 1`, not `> 0`. For the
idempotent insert the test is `=== 1` for `recorded`, because MySQL can report
`2` under `CLIENT_FOUND_ROWS`; `recorded` versus `existing` is informational
only — both mean a durable pending obligation exists, and the identity/terminal
verdict comes from the read-back, never from this count.

### 11.4 Request bounds, before anything is locked

`claimBatch` validates the request before the first query: non-empty owner,
`nowMs` a non-negative safe integer, `leaseUntilMs` a safe integer that is
strictly after `nowMs` and no further than `MAX_CLEANUP_LEASE_MS` (300 s) /
`MAX_SCAN_LEASE_MS` (600 s) away, `limit >= 1`, and a continuation cursor whose
`createdAtMs` and `id` are both usable. An already-expired lease is refused
rather than handed out.

`releaseClaim` clamps `retryAfterMs` to a whole non-negative value and refuses a
sum that leaves the safe-integer range, instead of `Math.trunc` on whatever
arrived.

### 11.5 `completeUnclaimed` and a stolen claim

The predicate is now:

```sql
WHERE id = ? AND state = 'pending'
  AND claim_owner IS NULL AND lease_until_ms IS NULL AND claim_version = ?
```

Three conditions, each covering a different theft:

- `state = 'pending'` — a coordinator that already settled the row wins.
- `claim_owner IS NULL AND lease_until_ms IS NULL` — rejects a live claim, and
  also a claim whose lease expired but which was never released (that row still
  carries an owner).
- `claim_version = ?` — every claim, release and completion increments the
  version, so a claim that was taken and later released no longer matches the
  version the request path recorded. This is the condition the coerced `0` used
  to defeat (§11.1); the projection now refuses such a row before a handle exists.

### 11.6 Typed failure, end to end

| where | before | now |
|---|---|---|
| claim page | `claim_store_failed` | `invalid_row` when the error is the typed one |
| completion / release | throw became `claim_lost` | `invalid_row`, and the throw is still reported |
| scan claim | `claim_failed` after 3 retries | `invalid_row`, no retry |
| request-path recording | `record_failed` | `store_invalid_row` |

`store_invalid_row` is added to `AssignmentCleanupRecording`, and the rejection
path treats it exactly like `record_failed`: **no delete is issued**. The cancel
and infected-verdict paths record inside their own transaction, so a corrupt row
throws and the whole unit rolls back (500) rather than committing a revocation
whose obligation state is unprovable.

### 11.7 The write-ahead trace, re-verified

Three recording sites, all on the caller's connection:

| site | unit | recorded before |
|---|---|---|
| rejection (`removeRejectedObject`) | own `runAtomic` | the delete |
| cancel | revoke + audit tx | the delete, after the revoke write |
| infected verdict | verdict + audit tx | the delete, after the verdict write |

The transaction handle is passed as `{ query: (sql, p) => tx.query(sql, p), execute: (sql, p) => tx.execute(sql, p) }`
— wrapped, not extracted. `AssignmentsDataAccess` is an interface of function
properties, so an implementation that reads `this` would break the moment the
method were passed unbound; the arrow preserves the receiver, and
`recordPending` runs both the insert and the read-back on it.

### 11.8 Statement errors are not reclassified

There is no error-code classification anywhere in this lane: `grep` for
`1054`, `42S22`, `1213`, `1205`, `ER_LOCK`, `errno` across the five files returns
only an `ER_DUP_ENTRY`/`1062` check on the finalize path, which is unrelated. A
deadlock or a lock-wait timeout therefore surfaces as `claim_store_failed` — it
is never reported as schema absence, and schema absence is decided by the literal
declaration and the collation probe only.

### 11.9 One known, deliberate gap

The router's own request-path checks previously used `(result.affectedRows ?? 0) === 0`
(e.g. the cancel `UPDATE ... WHERE status<>'revoked'`). In the final source-closure task
(2026-10-23) the `?? 0` coercion was removed and the transaction seam now throws when the
driver reports no affected-row count, while a genuine `0` still fails **closed** as
`cancel_conflict` (nothing deleted, no success is claimed). The undefined-count case now
surfaces as a driver-contract error instead of being silently treated as a miss. This gap
was therefore closed, not silently left.

### 11.10 Unchanged

No migration, no conditional MinIO delete, no orphan deletion, no tests, no
typecheck, no SQL executed. Orphan reconciliation remains plan-only.

---

# ADDENDUM 2026-10-23 — recovery factory / runtime lifecycle closure

Task: `server-assignment-recovery-runtime-closure-20261023-01`. Followup on the delivered A/B/C
invariants; none of them are redone here.

## D.1 Hashes

| Path | Before | Before bytes | After | After bytes |
|---|---|---|---|---|
| `server/src/routes/assignments.ts` | `ac84fb1eada04222…` | 116,364 | **unchanged, byte-identical** | 116,364 |
| `server/src/services/assignment-storage.ts` | `4682fef08629d795…` | 24,486 | `eca9c1edfd978eae7b8893a08601c76030dbf81b558df10b393c441d40a19b25` | 24,732 |
| `server/src/services/assignment-scan-worker.ts` | `378c9988b5c4e7cf…` | 56,803 | `1bf890792aeaa0a50c8ffdc82799164d179e58d1d2cac5bc9d07a1526ff5deec` | 60,319 |
| `server/src/services/assignments.ts` | `f1f2aacc0bf8fdb0…` | 25,294 | **unchanged, byte-identical** | 25,294 |
| `server/src/services/assignment-cleanup-recovery.ts` | `ba485c849357e500…` | 48,017 | `22d01490cdd1f39bbe5486f0e192aa81458658ec3c012b552aa61df512e80051` | 51,763 |
| `server/src/services/assignment-recovery-factory.ts` | `18a2df08bf3d6979…` | 16,243 | `91adf1dbbad6507bb7da266fc24fd73a6cacc4584d84d61092e25dab43bbe06c` | 19,966 |
| `server/src/services/assignment-cleanup-sql.ts` | `2d060acd6f6e0aac…` | 35,430 | **unchanged, byte-identical** | 35,430 |

`routes/assignments.ts`, `services/assignments.ts` and `assignment-cleanup-sql.ts` were reviewed and
left byte-identical: the route's record-before-delete ordering and the SQL adapter's exported
statement contract were verified against the executed SQL and required no change.

## D.2 Factory — existence was treated as readiness

`scanner`/`scanStore`/`listing`/`submissionLookup` were each reported `configured` from mere
presence (`options.scanner ? 'configured' : 'unconfigured'`). Injecting `{}` — which runtime
injection defeats the compile-time types to prevent — reported `scanner: 'configured'`,
`scanRecovery: 'configured'`, `orphanPlanning: 'configured'` and `scanClaimFencing: 'fenced'` from a
truthy `claims` stub. Everything then failed closed per row, so no destructive action occurred, but
the readiness signal was fabricated. Each surface is now checked for the callable it must actually
provide (`hasCallable`), mirroring the downstream capability contracts, so a stub cannot satisfy
them by shape alone.

`scanClaimFencing` also reported `'in-run-only'` when no scan pass could run at all (no scan store,
or no object store), describing a claim discipline nothing was following. It now reports
`'unavailable'` in those cases.

## D.3 Factory — `stop()` could not stop the scan pass

`stop()` set `stopped = true` and called `cleanupRecovery.stop()`, but the scan worker exposes only
`runOnce()` and has no stop surface, and the factory passed none when constructing it. A stop that
arrived while the scan pass was in flight let it keep claiming batches and running concurrent scans
to completion — and the run then reported `halted: null` as if it had finished cleanly, unlike the
cleanup pass which surfaces `halted: 'stopped'`.

The scan worker now accepts an advisory `shouldContinue?: () => boolean`, read before the claim and
again between the claim and the scan pool. A stop before the claim issues nothing; a stop after the
claim releases every claimed row (CAS on owner + version + lease) and returns the new
`aborted: 'stopped'` reason, so no lease is held by a cancelled run. The factory supplies the flag,
and a mid-flight stop is now visible as `halted: 'stopped'`. A scan already in flight cannot be
un-run, and the code and the doc say so rather than implying otherwise.

## D.4 Factory — a child rejection escaped unobserved

`execute()` awaited both child passes with no `try/catch`, and the `onError` hook was forwarded to
the children but never invoked for the factory's own observed failures. Any child rejection — an
owner-injected `now()` that throws, or a future unwrapped child path — escaped as a rejected
`runOnce()`/`drain()` and, under the documented fire-and-forget usage, became an unhandled rejection.
The passes are now awaited inside a guard that settles the in-flight bookkeeping before re-throwing,
so the owner still sees the original error but nothing escapes unobserved.

## D.5 Scan worker — a stale abort reason poisoned every later run

`claimAbort` was closure state that was never reset. Tick 1 hit one unparseable row and correctly set
`claimAbort = 'invalid_row'`; tick 2 hit a transient store failure, `claimBatch` returned `null`
without touching the flag, and the run reported `aborted: 'invalid_row'` — which the module's own
documentation defines as "retrying cannot fix it, so the run stops". A supervisor that halts or pages
on `invalid_row` stopped scanning permanently after one transient failure. `claimAbort` is now reset
at the top of every `claimBatch()` call.

## D.6 Cleanup recovery — identity compared against a differently-normalized ETag

`current` comes from `boundObjectVersion`, which **trims** the ETag; `target.etag` is deliberately
**never trimmed**. A padded or quoted adapter ETag therefore made the two sides of
`current.etag !== target.etag` describe the *same* version differently, and the obligation was closed
as `superseded` with a terminal row and no failure recorded — a fabricated terminal state that
stranded the rejected/infected bytes. The comparison now normalizes both sides through one form, and
`cleanupRemovalInput` trims once so the delete precondition carries the same form the stat check
used rather than a second one.

## D.7 Cleanup recovery — a store throw was booked as a lost CAS

After a caught non-`invalid_row` error, `settled`/`handedBack` was still `false`, so the else branch
ran and reported `halted: 'claim_lost'`, `lostClaims: 1`. But the CAS was never attempted: the store
failed, it did not refuse the fence. The row was still ours and still `pending`, and replay would
have re-stated it. Both the completion and the release catch now distinguish a store failure
(`claim_store_failed`) from a lost fence.

## D.8 Cleanup recovery — budget and lease were enforced only at page boundaries

The deadline was checked per page, but the item loop had no check and the per-page lease was stamped
once at claim time. One page holds up to `pageSize` external stat+delete round-trips, so a slow page
ran far past both the run budget and the lease it was stamped with; a second coordinator then claimed
the same rows while the first was still deleting them. Safety was preserved incidentally by the
store's precondition and the CAS fencing — the accounting was not honest. The deadline is now checked
per item.

## D.9 Cleanup recovery — an unusable retention cutoff silently disabled the filter

`object.lastModifiedMs >= request.notModifiedSinceMs` with a `NaN` cutoff makes every comparison
false, so the retention filter was silently disabled and every unowned object became a candidate.
Planning-only (no delete is issued), but the filter must mean what it says: an unusable cutoff or
timestamp now halts the plan with `invalid_retention_cutoff` instead of widening it.

## D.10 Safe-integer discipline

`boundObjectVersion` and `normalizeCleanupTarget` both used `Number.isInteger`, which accepts
`2**53` and `1e21`. An unsafe size is not a representable byte count, and distinct real sizes would
collide on one double, so the version string and the delete precondition could match the wrong
version. Both now require `Number.isSafeInteger`.

## D.11 Held — one corrupt row permanently blocks all recovery

Nothing is claimed from a page whose claim throws `invalid_row` (fail-closed, correct). But
`continuation` is `null` when a run halts before completing a page and `runOnce()` accepts no
cursor, so every future run restarts at the keyset head and halts on the same row forever — and
obligations behind it, including genuinely dangerous infected bytes, are never reached. The
fail-closed choice is right; the absence of any progress mechanism is the gap, and it belongs in the
store's claim query (a poison-row sideline), for which no SQL lives in this lane. Raised as a
contract request rather than invented here.

## D.12 Preserved

Exact-version identity and key re-parse binding; same-transaction write-ahead for
cancellation/verdict plus audit/obligation; two-stage delete with only the store's answer counting
(`version_replaced` ⇒ `superseded`, never `deleted`); claim fencing on owner + version + lease with a
lost CAS halting the run; fresh stat and key re-binding before every delete; typed `invalid_row`
distinct from `claim_store_failed`; cursor advancing only after a fully processed page; an in-flight
item always settled after its delete; orphan planning issuing no delete at all; MinIO
`conditionalDelete: false` with no invented delete implementation; the default production wiring
unconfigured.

## D.13 Not verified

No tests, no typecheck, no compiler, no SQL/DB/services/listeners/providers, no Docker, no secrets,
no Git, no migration/index/auth/manifest/notification edits, no new source files, no production
activation. A regex-aware delimiter-balance check and an arrow-declaration audit were run on all
seven source files and are **not** represented as compilation. Two checker limitations are recorded
honestly: the balance checker reports a false positive on `services/assignments.ts:81` from a `]`
inside the regex character class on line 79 (that file is byte-identical to baseline, so the report
is definitively a checker artifact), and the arrow audit flags three declarations that end `=> ({`
— a valid arrow returning a parenthesised object.

---

# ADDENDUM 2 — 2026-10-23 — exact opaque ETag identity + poison-row contract

Task: `server-assignment-etag-exact-identity-correction-20261023-01`.

## E.1 Hashes

| Path | Before | Before bytes | After | After bytes |
|---|---|---|---|---|
| `server/src/routes/assignments.ts` | `ac84fb1eada04222…` | 116,364 | **unchanged, byte-identical** | 116,364 |
| `server/src/services/assignment-storage.ts` | `eca9c1edfd978eae…` | 24,732 | `2a8823cf22faf408c7ccb749311ac14d386cd3a7dff27d3838b8cd180c4d3865` | 26,520 |
| `server/src/services/assignment-scan-worker.ts` | `1bf890792aeaa0a5…` | 60,319 | **unchanged, byte-identical** | 60,319 |
| `server/src/services/assignments.ts` | `f1f2aacc0bf8fdb0…` | 25,294 | **unchanged, byte-identical** | 25,294 |
| `server/src/services/assignment-cleanup-recovery.ts` | `22d01490cdd1f39b…` | 51,763 | `9e4f5ffd2f6d768d66dc79d883bb20e844593cf35c028e4852ffe75386636b68` | 51,809 |
| `server/src/services/assignment-recovery-factory.ts` | `91adf1dbbad6507b…` | 19,966 | **unchanged, byte-identical** | 19,966 |
| `server/src/services/assignment-cleanup-sql.ts` | `2d060acd6f6e0aac…` | 35,430 | **unchanged, byte-identical** | 35,430 |

Five of the eight registered paths are byte-identical. Two changed, both only to remove ETag
normalization. The SQL adapter needed no change: it already reads and writes `object_etag` as exact
bytes (see §E.5).

## E.2 The defect: three trim sites collapsed opaque identities

An ETag is opaque. `"e"` and `"e "` are two different objects under the exact NO PAD storage contract
this lane depends on, and three places normalized one into the other:

1. **`assignment-storage.ts` `boundObjectVersion`** — `metadata.etag.trim()`. Every version bound
   from a padded provider ETag carried the trimmed string, so `version`, the `etag` field, the stat
   proof and the delete precondition all described the *normalized* value.
2. **`assignment-cleanup-recovery.ts` `cleanupRemovalInput`** — `target.etag.trim()`. Added in the
   previous addendum with the reasoning "so the check and the precondition agree". They agreed on a
   value no provider contract proves denotes the same object.
3. **`assignment-cleanup-recovery.ts` `performVersionCleanup`** — the pre-stat replacement comparison
   trimmed **both** sides, so `"e"` versus `"e "` compared equal and a live replacement was treated
   as the recorded version.

Consequence in one sentence: an obligation recorded for `"e"` could be satisfied — and its bytes
deleted — by an object whose real ETag was `"e "`, because the normalized identity matched and the
exact-version precondition was built from the normalized string.

No provider contract in this lane supplies a proof that a trimmed ETag denotes the same object, so no
canonicalization is applied and none was invented. The raw string is the identity.

## E.3 What changed

- `boundObjectVersion` no longer trims. `AssignmentObjectMetadata.etag`,
  `BoundObjectVersion.version`/`.etag` and `ExactVersionRemovalInput.etag` all document that the value
  is raw and opaque, and that a caller must never re-derive it by trimming the composite `version`
  string.
- `cleanupRemovalInput` carries `target.etag` raw.
- The pre-stat replacement comparison compares raw on both sides. Different raw ETags are a
  replacement: the recorded version is not deleted and no terminal success is claimed for it.

`normalizeCleanupTarget` was already exact (it validates type, non-emptiness and a bounded length and
never normalizes), and `toRecord` in the SQL adapter already read `object_etag` as exact bytes with an
`invalidRow` on empty. Both are unchanged and were verified rather than assumed.

## E.4 Every ETag consumer, audited

| Site | Preserves raw? | Evidence |
|---|---|---|
| `boundObjectVersion` (5 callers: scan `scanned`, scan `current`, route cancel, route finalize, cleanup `current`) | **now yes** | trim removed |
| `normalizeCleanupTarget` | yes | length + type check only, no normalization |
| `cleanupRemovalInput` | **now yes** | trim removed |
| `performVersionCleanup` pre-stat comparison | **now yes** | both-side trim removed |
| Scan `scanned.etag !== candidate.etag` | yes | both raw; `scanned` from `boundObjectVersion`, `candidate.etag` from the DB row |
| Scan claim `row.object_etag` | yes | `typeof` check only |
| Scan verdict CAS `object_etag=?` | yes | binds the raw claimed ETag |
| SQL `toRecord` | yes | `invalidRow` on empty, no trim |
| SQL `recordPending` / dedupe predicates | yes | bind `target.etag` raw |
| Route re-stat `current.etag !== metadata.etag` | yes | both from `statObject` / `boundObjectVersion` |
| Route `buildCleanupTarget` → `normalizeCleanupTarget` | yes | passes `version.etag` through |

## E.5 Poison-row / starvation contract against the ACTUAL claim query

The claim page is `buildAssignmentCleanupClaimPage`:

```sql
SELECT … FROM assignment_cleanup_obligations
WHERE state = 'pending'
  AND (claim_owner IS NULL OR lease_until_ms <= ?)
  AND (retry_after_ms IS NULL OR retry_after_ms <= ?)
  [AND (created_at_ms > ? OR (created_at_ms = ? AND id > ?))]
ORDER BY created_at_ms ASC, id ASC
LIMIT ?
FOR UPDATE SKIP LOCKED
```

`SKIP LOCKED` skips rows another transaction currently holds — it does **not** skip a row that is
*claimable but unreadable*. `toRecord` throws `AssignmentCleanupRowInvalidError` for a corrupt row,
the coordinator halts with `invalid_row`, claims nothing from that page, and `continuation` stays
`null` because `runOnce()` accepts no cursor. Every subsequent run restarts at the keyset head and
halts on the same row. The row is permanently claimable (it is `pending`, unowned, unleased) and
permanently unreadable, so it starves every obligation behind it — including genuinely dangerous
infected bytes.

**The precise requirement, stated as a requirement and not implemented:**

A safe sideline needs a *cursor*, not a quarantine. The minimum that makes progress possible without
any destructive or permanent-quarantine policy:

1. `runOnce(after?: { createdAtMs: number; id: string })` — the coordinator must accept the
   continuation it already reports, so a halted run can resume *past* the offending row instead of
   restarting at the head. The cursor is already computed and already returned; it is simply not
   accepted back.
2. The claim query gains a bounded, non-destructive skip that is **auditable and reversible** — for
   example `AND (poison_sideline_until_ms IS NULL OR poison_sideline_until_ms <= ?)`, where a
   sideline stamp is written by the *same* statement that records the invalid-row halt, carries a
   TTL, and never changes `state` away from `pending`. A row that becomes readable again is claimed
   normally on its next pass.
3. The halt reason distinguishes "this page could not be read" from "this row is corrupt", so an
   operator can see how many rows are sidelined and why, and the sideline stamp is visible in the
   row rather than inferred from a counter.

What is explicitly **not** being requested or invented: no row is deleted, no `state` is rewritten to
a terminal value, no backfill of ambiguous data, and no permanent quarantine. A sideline stamp with a
TTL is a scheduling fact, not a verdict.

This is a DDL + claim-query change, so it belongs to the schema lane. It is raised here as the exact
contract and deliberately not implemented in this task.

## E.6 Source traces (static reasoning only)

| # | Scenario | Outcome |
|---|---|---|
| 1 | **`"e"` vs `"e "`** — obligation recorded for `"e"`, live object's ETag is `"e "` | pre-stat comparison differs ⇒ `superseded` / `pre_stat_version_replaced`. Nothing deleted. Previously both were trimmed and compared equal, so the delete proceeded against the wrong bytes. |
| 2 | **Raw quote difference** — recorded `"abc"`, live `"\"abc\""` (quotes part of the value) | differs ⇒ replacement. No quote stripping anywhere in the chain. |
| 3 | **Replacement** — recorded `"e"`, live `"f"` | differs ⇒ `superseded`. The replacement survives. |
| 4 | **Same exact bytes** — recorded `"e"`, live `"e"` | equal ⇒ delete proceeds with the raw ETag in the precondition. |
| 5 | **Malformed metadata** — `statObject` returns no ETag, or an empty one | `boundObjectVersion` returns null ⇒ `capability_absent`, released, nothing deleted. |
| 6 | **Conditional-delete mismatch** — store reports `version_replaced` | `superseded` / `store_version_replaced`. Nothing destroyed. |
| 7 | **Ambiguously normalized old record** — an obligation persisted before this fix whose stored ETag was already trimmed | **Unverifiable dependency, retained.** The original bytes are not reconstructible, nothing is backfilled, and the row is not silently closed or claimed deleted. It behaves per §E.6 row 1: if the live ETag differs from the stored (trimmed) one it is a replacement; if it happens to equal the trimmed value the delete proceeds on a value the original upload never proved. This is recorded as a dependency on a data audit, not resolved here. |

## E.7 Preserved

Strict safe-integer sizes; claim fences (owner + version + lease) with a lost CAS halting the run;
stop/drain; exact object-key ownership via key re-parse; MinIO `conditionalDelete: false` with no
invented delete implementation; `invalid_row` distinct from `claim_store_failed`; per-item deadline
checks; the factory's callable-surface readiness checks; the SQL adapter's NO PAD collation gate.

## E.8 Not verified

No tests, no typecheck, no compiler, no SQL/DB/services/listeners/providers, no Docker, no secrets,
no Git, no DDL, no new source files, no production activation. Static delimiter-balance and
arrow-declaration checks were run and are not represented as compilation.

---

# ADDENDUM 3 — 2026-10-23 — source-closure review (assignments / scan / cleanup)

Task: `server-source-closure-agent2-20261023-01` (lane: `routes/assignments.ts`,
`services/assignments.ts`, `assignment-scan-worker.ts`, `assignment-storage.ts`,
`assignment-cleanup-recovery.ts`, `assignment-recovery-factory.ts`, `assignment-cleanup-sql.ts`,
this document). Source review only: no tests, no typecheck, no compiler, no SQL/DB, no provider, no
Docker, no Git, no migration, no new file.

## F.1 What changed

| path | change | why |
|---|---|---|
| `routes/assignments.ts` | local `affectedRowsOf` guard + 7 call sites | an unreported `affectedRows` was read as a successful write |
| `services/assignment-recovery-factory.ts` | readiness predicates + `halted` on stop | readiness probed names no port declares; two ports unprobed; a stopped scan reported `halted: null` |
| `services/assignment-cleanup-sql.ts` | `completeClaim` state/proof guard | a claimed completion could record a terminal state its own proof contradicts |

Unchanged, byte-identical to the state reviewed: `services/assignments.ts`,
`assignment-scan-worker.ts`, `assignment-storage.ts`, `assignment-cleanup-recovery.ts`.

## F.2 Hashes (after this pass)

| path | after sha256 | B |
|---|---|---|
| `server/src/routes/assignments.ts` | `12798bd0b277bd93ac91b40b45c32787e984fa279815d567edbebfaa98e9fd6f` | 118146 |
| `server/src/services/assignments.ts` | `f1f2aacc0bf8fdb012c95c305a015de9d115c8a542788634aded6f473057b14b` | 25294 |
| `server/src/services/assignment-scan-worker.ts` | `1bf890792aeaa0a50c8ffdc82799164d179e58d1d2cac5bc9d07a1526ff5deec` | 60319 |
| `server/src/services/assignment-storage.ts` | `2a8823cf22faf408c7ccb749311ac14d386cd3a7dff27d3838b8cd180c4d3865` | 26520 |
| `server/src/services/assignment-cleanup-recovery.ts` | `be0b751ae543662b62f98d94bfc2146d449339c080dc2793e5879fa300547a99` | 52643 |
| `server/src/services/assignment-recovery-factory.ts` | `02f4f6ee1ff8af584a099e23fc16ef6c25e497390d01ee99d245ae98f9413ace` | 20384 |
| `server/src/services/assignment-cleanup-sql.ts` | `54f3044e15a11c9637506ea2fa477939dd9de341988efbee73621a294fa6288c` | 36017 |
| this document | *changes with every revision; delivered value in the handoff record* | — |

The **before** hash of the three edited files is not recorded: the review read the files and then
edited them in place, and this lane has no Git snapshot. The four unchanged files match the hashes
above exactly, which is what pins the reviewed state. `assignment-cleanup-recovery.ts` and
`assignment-cleanup-sql.ts` are both past the values in §8.2/§11 — the former carries the
unconditional provenance gate (`legacy_etag_unprovable`, §F.6) and the latter this pass's
`completeClaim` guard.

## F.3 `undefined` affected-row counts were read as success

`AssignmentsDataAccess.execute` returns `{ affectedRows?: number }`, and every lifecycle guard was
`if ((updated.affectedRows) === 0)`. `undefined === 0` is **false**, so a seam that reported no count
fell through the guard as a *successful* write: the cancel would commit without its revocation, the
finalize verdict would be treated as recorded, a staff revoke as applied. §11.9 asserted the seam
throws; only `productionTransaction` does, and only on the transaction path — nothing local to the
guards enforced it, so any other injected seam silently weakened them.

`affectedRowsOf` now returns the reported count or throws, and the single-row CAS sites compare
`!== 1` (cancel, finalize verdict, staff revoke, assignment update/publish/archive). The grade
correction keeps `=== 0` for its documented no-op branch, but now goes through the same guard, so an
unreported count throws instead of being read as "no change". A genuine `0` still fails closed
exactly as before.

## F.4 Readiness probed method names no port declares

`hasCallable(options.listing, 'list')` and `hasCallable(options.submissionLookup, 'find')` — the ports
are `AssignmentObjectListing.listTenantObjects` and
`AssignmentSubmissionLookup.hasSubmissionForVersion`. Neither `list` nor `find` exists anywhere in
the lane, so `orphanPlanning` was reported `unconfigured` / `orphan-listing-unconfigured` for a
correctly implemented adapter. Both now probe the real method.

## F.5 Two ports were never probed at all

`durableCleanupStore` came from `describeCapability().durableStore`, which is `store ? … : …` —
presence only — and `hasObjectStore` was `options.objectStore !== undefined`. So `{}` reported
`cleanup: 'configured'` / `scanRecovery: 'configured'`, `ready: true`, and `runOnce()` then called a
missing `claimBatch` (TypeError out of `runOnce`) or ran a scan pass whose every row died on a
missing `statObject`. The cleanup store is now probed for all five port methods and the object store
for `statObject`, so a stub cannot satisfy readiness by shape — the rule §D.2 states and applied to
the other three surfaces.

## F.6 A stopped scan still reported `halted: null`

The post-pass guard was `if (halted === null && stopped && scanReport !== null && scanReport.aborted
!== 'stopped')`. A stop that the scan pass itself honoured (`aborted: 'stopped'`, §D.3) therefore left
`halted: null` — the exact "finished cleanly" signal §D.3 set out to remove. The condition is now
`halted === null && stopped`, so every run cut short by `stop()` reports `halted: 'stopped'` while the
child report still carries its own `aborted`.

## F.7 `completeClaim` accepted a terminal state its proof contradicts

`completeUnclaimed` derives the terminal state from the proof and refuses a mismatch; `completeClaim`
did not, so a caller could write `state='deleted'` with `proof='store_version_replaced'` — a fabricated
deletion for a version that was only replaced. It now applies the same `cleanupStateForProof` check.
The coordinator derives both from one proof, so no existing caller changes behaviour.

## F.8 Held — contract requests, not implemented here

1. **`last_failure` ENUM is missing a value the code writes.** §4.1 declares
   `last_failure ENUM('capability_absent','store_error','binding_mismatch','record_state_invalid')`,
   but `ASSIGNMENT_CLEANUP_FAILURES` (`assignment-cleanup-recovery.ts:138-159`) also contains
   `legacy_etag_unprovable`, and `releaseClaim` (`assignment-cleanup-sql.ts:653-682`) binds it. Under
   a strict SQL mode that insert/update fails with `1265 Data truncated`, so the release is lost and
   the row keeps its lease until expiry. Exact required change to the migration
   (`20261023_05_assignment_cleanup_scan_fencing.sql`, not authored here):
   `last_failure ENUM('capability_absent','store_error','binding_mismatch','record_state_invalid','legacy_etag_unprovable') NULL`.
   §4.1 stands superseded on that one line.
   **Status 2026-10-24 — satisfied, not applied.** The migration that was actually authored,
   `20261024_06_assignment_cleanup_scan_fencing.sql:68`, declares all five values in that exact
   order, and `releaseClaim` in `assignment-cleanup-sql.ts` binds `request.failure` unchanged.
   The set is closed on both sides (§G.4). §4.1 was corrected. Nothing was executed: a source
   match is not a deployed enum.
2. **`cleanupObligations` requires `transaction`.** With a durable store injected and no
   `deps.transaction`, `runAtomic` is `fn(db)` — no unit of work. A cancel or infected verdict then
   commits its state change and, if the obligation insert throws, answers `500` with the state
   already committed and no obligation. The write-ahead *ordering* survives; the atomicity §3.3
   claims does not. Either the router refuses `cleanupObligations` without `transaction`, or the
   wiring contract states it. Not decided here.
3. **Poison-row sideline** (§E.5) is still open: `runOnce()` accepts no cursor, so one unreadable row
   halts every run at the keyset head.
4. **Rejection racing a finalize.** A rejection deletes the version it verified; a concurrent finalize
   of the same version (possible only if the assignment limits changed between the two stats) can have
   already marked the row `clean`, and the rejection then deletes the bytes that row points at. There
   is no transition that retracts a recorded obligation, so closing this needs a product decision on
   which writer wins, not a guard in the route.
5. **`cleanup: 'configured'` overstates.** With the unconditional provenance gate (§F.9) the cleanup
   pass can claim and release but never delete, so a deployment reads `configured` / `ready: true`
   for a pass that cannot finish work. Readiness is defined as configuration, so this was left as is
   rather than redefined here.

## F.9 Preserved

The unconditional unproven-ETag hold (`capability().recordVersionIdentity` is the literal
`'unverified'`; `inspectAndDelete` releases `legacy_etag_unprovable` before any stat, absent-object
inference, superseded verdict, conditional delete or terminal settlement, and no option, enum,
boolean, registry or timestamp bypasses it); write-ahead ordering at all three points (rejection in
its own unit, cancel in the revocation unit, infected verdict in the verdict unit); exact-version
deletes only, no `removeObject(key)`; claim fences on owner + version + unexpired lease in the same
statement, with a lost CAS halting the cleanup run; `pending_scan` never clean and no scanner never a
verdict; bounded pages/items/elapsed/lease/retry; `invalid_row` distinct from `claim_store_failed`
and never completed or quarantined; the SQL adapter's NO PAD gate and strict safe-integer projection;
MinIO `conditionalDelete: false`; default wiring still unconfigured.

## F.10 Not verified

No tests, no typecheck, no compiler, no SQL/DB/services/listeners/providers, no Docker, no secrets, no
Git, no migration, no new file, no production activation. Nothing in this addendum is represented as
compilation or as acceptance of the task.

---

# ADDENDUM 4 — 2026-10-24 — schema/CAS contract reconciled against `20261024_06`

Task: `workbuddy-assignment-recovery-contract-20261024-01`. Source and document only: no tests, no
typecheck, no compiler, no SQL/DB execution, no services/providers/Docker, no Git, no new source file,
no migration edit. The migration (`server/migrations/20261024_06_assignment_cleanup_scan_fencing.sql`)
was **read**, never written.

Everything below is derived from two sources and nothing else: the statements and mappers in
`assignment-cleanup-sql.ts`, and the migration file. **No deployed enum is claimed.** A source match
between the code's closed union and the `ENUM(...)` in the DDL is a review fact, not a database fact;
nothing here was applied, and the migration's own header forbids assuming a prior partial apply.

## G.1 Table contract (`assignment_cleanup_obligations`)

| # | column | type | null | default | notes |
|---|---|---|---|---|---|
| 1 | `id` | `CHAR(36)` | NO | — | `crypto.randomUUID()` (`newId`) |
| 2 | `tenant_id` | `CHAR(36)` | NO | — | from the target |
| 3 | `assignment_id` | `CHAR(36)` | NO | — | from the target |
| 4 | `student_enrollment_id` | `CHAR(36)` | NO | — | from the target |
| 5 | `submission_id` | `CHAR(36)` | NO | — | from the target |
| 6 | `storage_key` | `VARCHAR(255)` | NO | — | re-parsed/re-bound before any delete |
| 7 | `object_etag` | `VARCHAR(256)` `utf8mb4_0900_bin` | NO | — | exact bytes, NO PAD; never trimmed |
| 8 | `object_size_bytes` | `BIGINT` | NO | — | `> 0` (`chk_..._1`) |
| 9 | `reason` | `ENUM` (6) | NO | — | §G.4 |
| 10 | `state` | `ENUM('pending','deleted','superseded')` | NO | `'pending'` | §G.4 |
| 11 | `claim_owner` | `VARCHAR(64)` | YES | `NULL` | paired with `lease_until_ms` |
| 12 | `claim_version` | `INT` | NO | `0` | fence counter, `>= 0` |
| 13 | `lease_until_ms` | `BIGINT` | YES | `NULL` | `> 0` when present |
| 14 | `attempts` | `INT` | NO | `0` | `>= 0`, bumped by `releaseClaim` only |
| 15 | `last_failure` | `ENUM` (5) | YES | `NULL` | §G.4 |
| 16 | `retry_after_ms` | `BIGINT` | YES | `NULL` | `>= 0` when present |
| 17 | `completion_proof` | `ENUM` (5) | YES | `NULL` | §G.4 |
| 18 | `created_at_ms` | `BIGINT` | NO | — | `>= 0` |
| 19 | `updated_at_ms` | `BIGINT` | NO | — | `>= created_at_ms` |
| 20 | `completed_at_ms` | `BIGINT` | YES | `NULL` | `> 0` when present |

Table: `ENGINE=InnoDB`, `CHARSET=utf8mb4`, `COLLATE=utf8mb4_unicode_ci` (so `id`, `storage_key` and
the identifier columns are `unicode_ci`; only `object_etag` overrides to `0900_bin`).

## G.2 Keys and indexes, exact order

| object | kind | exact column order | the statement it serves |
|---|---|---|---|
| `PRIMARY` | PK | `(id)` | `stampClaim`, `completeClaim`, `releaseClaim`, `completeUnclaimed` — all reach one row by `id` |
| `uq_cleanup_target` | UNIQUE | `(submission_id, object_etag, object_size_bytes)` | the `INSERT … ON DUPLICATE KEY UPDATE` and `readByIdentity` — the read-back predicate is the same triple in the same order |
| `k_cleanup_claim` | KEY | `(state, created_at_ms, id)` | the claim page: `state = 'pending'` (prefix), `ORDER BY created_at_ms ASC, id ASC`, and the keyset `created_at_ms > ? OR (created_at_ms = ? AND id > ?)` — predicate and sort both follow this order, so the page is an index range, not a filesort |
| `k_cleanup_lease` | KEY | `(state, lease_until_ms)` | **unused by this adapter** (see §G.6 item 8) |
| `k_cleanup_tenant` | KEY | `(tenant_id, state, created_at_ms)` | **unused by this adapter** — the claim path is deliberately not tenant-scoped |

There is no index on `claim_owner`; no statement looks a row up by owner (owner is always a
same-row predicate beside `id`).

## G.3 CHECK constraints (13) and the path that keeps each satisfied

| # | constraint | kept by |
|---|---|---|
| 1 | `object_size_bytes > 0` | `normalizeCleanupTarget` refuses `<= 0`, so no target can carry one |
| 2 | `CHAR_LENGTH(object_etag) > 0` | same, plus `toRecord` refusing an empty etag |
| 3 | `claim_version >= 0` | insert literal `0`; every write is `+ 1` on a projected `>= 0` value |
| 4 | `attempts >= 0` | insert literal `0`; `releaseClaim` only increments |
| 5 | `created_at_ms >= 0` | `Date.getTime()` from the injected clock |
| 6 | `updated_at_ms >= created_at_ms` | both bound to the same `nowMs` on insert; later writes move `updated_at_ms` forward (see §G.6 item 7) |
| 7 | `lease_until_ms IS NULL OR > 0` | `claimBatch` refuses an already-expired lease before locking |
| 8 | `retry_after_ms IS NULL OR >= 0` | `releaseClaim` clamps `retryAfterMs` to a whole `>= 0` and checks the sum is a safe integer |
| 9 | `completed_at_ms IS NULL OR > 0` | only written from `nowMs` |
| 10 | `(claim_owner IS NULL) = (lease_until_ms IS NULL)` | the pair is written together (stamp) and cleared together (complete/release); `toRecord` refuses a half-pair |
| 11 | `state = 'pending' OR (completion_proof IS NOT NULL AND completed_at_ms IS NOT NULL)` | `completeClaim`/`completeUnclaimed` write state + proof + instant in one statement |
| 12 | `state <> 'pending' OR (completion_proof IS NULL AND completed_at_ms IS NULL)` | insert writes `NULL`/`NULL` literals; release never touches either column |
| 13 | `state = 'pending' OR (claim_owner IS NULL AND lease_until_ms IS NULL)` | both completion statements null the pair in the same statement as the state write |

`assignment_submissions` gains five more: `chk_assignment_scan_version`, `…_attempts`, `…_lease`,
`…_retry`, `…_owner_pair` (§10.2). Those belong to the scan lane's statements; they are recorded here
only so the additive contract is complete.

## G.4 Closed value sets, and what the code can actually bind

| set | values | code | migration |
|---|---|---|---|
| `state` | `pending`, `deleted`, `superseded` | `ASSIGNMENT_CLEANUP_STATES` | line 63, same order |
| `reason` | `admission_oversize`, `admission_size_out_of_bounds`, `admission_content_type_mismatch`, `admission_signature_mismatch`, `scan_infected`, `cancelled_upload` | `CLEANUP_OBLIGATION_REASONS` (`assignments.ts`) | line 62, same order |
| `last_failure` | `capability_absent`, `store_error`, `binding_mismatch`, `record_state_invalid`, `legacy_etag_unprovable` | `ASSIGNMENT_CLEANUP_FAILURES` | line 68, same order |
| `completion_proof` | `store_removed`, `store_already_absent`, `pre_stat_absent`, `store_version_replaced`, `pre_stat_version_replaced` | `ASSIGNMENT_CLEANUP_PROOFS` | line 70, same order |

**`releaseClaim` is the only writer of `last_failure`** (`last_failure = ?`, bound to
`request.failure`, typed as the full five-value union). `recordPending` binds the literal `NULL`;
`claimBatch`, `completeClaim` and `completeUnclaimed` never name the column. So the bindable set is
exactly the five values above — including `legacy_etag_unprovable`, which is the one the earlier
§4.1 DDL omitted.

Reachable *today* is a smaller set, and the difference is the provenance hold: with the gate
unconditional, `inspectAndDelete` returns before any `statObject` or conditional delete, so
`capability_absent` and `store_error` are declared but unreachable, and the only values that can reach
`releaseClaim` are `binding_mismatch` (key does not re-bind), `record_state_invalid` (non-`pending` row
handed to a claim) and `legacy_etag_unprovable` (the gate itself). `runOnce`'s halt reason
`capability_absent` is a *run* outcome, not a `last_failure` write.

## G.5 Exact CAS semantics

`claimBatch` — one transaction, one connection:

```sql
SELECT <17 columns> FROM assignment_cleanup_obligations
WHERE state = 'pending'
  AND (claim_owner IS NULL OR lease_until_ms <= ?)        -- nowMs
  AND (retry_after_ms IS NULL OR retry_after_ms <= ?)     -- nowMs
  [AND (created_at_ms > ? OR (created_at_ms = ? AND id > ?))]  -- only when after != null
ORDER BY created_at_ms ASC, id ASC
LIMIT ?
FOR UPDATE SKIP LOCKED
```

then one stamp per returned row, and only `affectedRows === 1` is kept:

```sql
UPDATE assignment_cleanup_obligations
SET claim_owner = ?, claim_version = ?, lease_until_ms = ?, updated_at_ms = ?
WHERE id = ? AND state = 'pending'
  AND (claim_owner IS NULL OR lease_until_ms <= ?)
```

The stamped version is `current + 1` computed in the adapter, not `claim_version + 1` in SQL, and it
is refused if the increment leaves the safe-integer range. Access path: `k_cleanup_claim` for the
page, `PRIMARY` for each stamp. `SKIP LOCKED` skips rows another transaction holds — it does **not**
skip a claimable-but-unreadable row (§E.5).

`completeClaim` (fenced, one statement, no transaction needed):

```sql
UPDATE … SET state = ?, completion_proof = ?, claim_owner = NULL,
    claim_version = claim_version + 1, lease_until_ms = NULL,
    completed_at_ms = ?, updated_at_ms = ?
WHERE id = ? AND state = 'pending' AND claim_owner = ? AND claim_version = ?
  AND lease_until_ms > ?          -- the lease must still be LIVE
```

The adapter derives `state` from `proof` via `cleanupStateForProof` and answers `false` **without
issuing SQL** when the caller's pair disagrees, so a terminal state its own proof contradicts can
never be written.

`releaseClaim` — same fence, plus `last_failure` and the retry clock; `attempts` is bumped here and
only here:

```sql
UPDATE … SET claim_owner = NULL, claim_version = claim_version + 1, lease_until_ms = NULL,
    attempts = attempts + 1, last_failure = ?, retry_after_ms = ?, updated_at_ms = ?
WHERE id = ? AND state = 'pending' AND claim_owner = ? AND claim_version = ?
  AND lease_until_ms > ?
```

`completeUnclaimed` (request path settling a row it recorded itself):

```sql
UPDATE … SET state = ?, completion_proof = ?, completed_at_ms = ?, updated_at_ms = ?
WHERE id = ? AND state = 'pending'
  AND claim_owner IS NULL AND lease_until_ms IS NULL AND claim_version = ?
```

Three conditions, three thefts: `state` (a coordinator already settled it), the null owner **and**
null lease (a live claim, or an expired-but-unreleased one, still carries an owner), and
`claim_version` (a claim+release moved the counter past the handle's value). It does not increment
the version — the row is terminal, and `state = 'pending'` is what makes a second replay a no-op.
Access path for all three: `PRIMARY` (`id` first), with the remaining columns as same-row filters.

Every single-row CAS is compared with `=== 1`; an unreported `affectedRows` throws rather than being
read as either answer.

## G.6 Reconciliation against `20261024_06` — matches, and discrepancies

Matches (no code change needed): the 20 columns and their order in the `INSERT`; the unique triple;
`k_cleanup_claim`'s column order against `ORDER BY created_at_ms, id`; all four closed value sets;
`utf8mb4_0900_bin` on `object_etag`, which is exactly what `probeAssignmentEtagCollation` must verify
(`PAD_ATTRIBUTE = 'NO PAD'`) before `availability` can be `durable`.

Discrepancies, documented and **not** fixed (the migration is read-only to this lane):

1. **Filename.** §9, §10, §10.2 and §10.7 referred to `20261023_05_assignment_cleanup_scan_fencing.sql`;
   the authored file is `20261024_06_…`. Corrected in this document and in the
   `AssignmentCleanupSchemaDeclaration` comment; nothing reads the name.
2. **`last_failure` had four values in §4.1** (doc line 217) against five in the migration (line 68).
   The code already had five. §4.1 corrected; §F.8 item 1 marked satisfied.
3. **§4.4's `completeUnclaimed` omitted `AND lease_until_ms IS NULL`** (doc line 322) while the
   adapter has always sent it (`assignment-cleanup-sql.ts`, `completeUnclaimed`). §4.4 corrected;
   `chk_..._10` makes the clause redundant *given* the CHECK, but the code does not rely on that.
4. **§4.2's `INSERT` listed 14 columns** and leaned on column defaults; the executed statement names
   all 20 with explicit literals. Behaviourally identical, textually not. §4.2 corrected.
5. **§4.1 declared no `CHECK`s at all**; the migration declares thirteen. §G.3 is now the list.
6. **§10.2's `ALTER` listed no `CHECK`s**; the migration adds five. §10.2 corrected.
7. **`updated_at_ms >= created_at_ms` couples completion to clock monotonicity.** `completeClaim` and
   `releaseClaim` bind `updated_at_ms = nowMs` from the coordinator's clock. A coordinator whose clock
   is behind the writer that inserted the row makes the statement violate `chk_..._6`; the driver
   raises, `affectedRowsOf` never runs, and the run halts `claim_store_failed` — a failure, never a
   silent success. Recorded, not "fixed": the correct response to skew is an operational one.
8. **Two indexes are declared that no statement uses** (`k_cleanup_lease`, `k_cleanup_tenant`). Not a
   defect, but the claim path is not tenant-scoped and expiry is filtered inside `k_cleanup_claim`'s
   range scan, so nobody should read those keys as evidence of tenant isolation in `claimBatch`.
9. **§4.2's "conflict when the same submission already has a *different* version pending" is not
   implemented and cannot be**, without a second query: `recordPending` reads back only the exact
   `(submission_id, object_etag, object_size_bytes)` tuple, and `uq_cleanup_target` deliberately
   permits several versions per submission (§3.1 calls them legitimate). The adapter's `conflict`
   means identity drift on that tuple, or a terminal row. Left unresolved because choosing is a
   product decision, not a mapping fix.
10. **The migration's guard is stricter than this document.** It refuses to run unless
    `assignment_submissions` is InnoDB, `utf8mb4_unicode_ci`, has `PK(id)` with no prefix, and matches
    nine exact column types (`submitted_at TIMESTAMP`, `file_size_bytes BIGINT`, `scan_status` and
    `status` enums as written), and it refuses if any of the seven new columns or `k_scan_claim`
    already exists. A deployed base that differs in any of those (e.g. `DATETIME`) is rejected before
    any DDL. That is a base-schema fact this lane cannot verify without a database, and it is not a
    code mismatch.
11. **Projection tolerances looser than the `CHECK`s.** `toRecord` rejects `object_size_bytes < 0`
    (not `<= 0`) and accepts a `lease_until_ms` of `0` or below, while `chk_..._1`/`chk_..._7` forbid
    both. No write path can produce such a row (`normalizeCleanupTarget` requires `> 0`, and the
    stamp requires a lease strictly after `nowMs`), and the looser projection fails closed anyway
    (a zero-size row is released `binding_mismatch`). Left as is rather than turning a per-row
    release into a page-level `invalid_row` halt.
12. **`id` comparisons use `utf8mb4_unicode_ci`** (PAD SPACE, case-insensitive) for the keyset
    tiebreak, while `object_etag` is `utf8mb4_0900_bin`. The keyset is self-consistent — the
    predicate and `ORDER BY` use the same column and collation — but ids differing only in case would
    tie. UUIDs are lowercase hex, so this is an observation, not a change.

## G.7 Invariants re-confirmed against this contract

- **Provenance hold.** `capability().recordVersionIdentity` is the literal `'unverified'`;
  `inspectAndDelete` validates the binding and the state, then releases `legacy_etag_unprovable`
  **before** `statObject`, before any absent-object inference, before a `superseded` verdict, before a
  conditional delete and before any terminal settlement. No option, enum, boolean, registry or
  timestamp cutoff is read on that path. In this contract that means: a row can be claimed, released
  and re-claimed, and never reaches `deleted`/`superseded`, because `completeClaim` is only called
  with a proof `inspectAndDelete` returned, and it returns none.
- **No terminal success without evidence.** `state` is always `cleanupStateForProof(proof)`; a proof
  exists only from a store answer (`removed`, `already_absent`, `version_replaced`) or a trusted
  re-stat. Neither is reachable today, which is why nothing terminalizes.
- **Missing scanner / missing conditional delete stay `unavailable`.** `capability_absent` is a halt
  *before* claiming, so no lease is burned; the factory reports `exact-delete-unsupported` /
  `scanner-unconfigured` and `verified: false`; no store, no schema declaration, no `transaction`, or
  a non-`NO PAD` verdict yields `{ mode: 'unavailable' }` and every method refuses.
- **Stop/drain and lost ownership.** `stop()` halts between pages and between items; a completion or
  release that answers `false` (or a fence the row no longer matches) increments `lostClaims` and
  halts `claim_lost` — a stale run does not keep writing. The factory propagates the stop to the scan
  pass and reports `halted` rather than `null`.
- **Write-ahead.** `recordPending` runs insert **and** read-back on the caller's transaction; a
  caller-owned `tx` propagates a failure, a store-owned insert reports `record_failed` and the caller
  deletes nothing.

## G.8 Not verified

No tests, no typecheck, no compiler, no SQL/DB execution, no migration applied, no services,
providers or Docker, no Git, no new source file. Nothing in this addendum asserts that the table
exists, that the enum is deployed, or that any statement has ever run against a database.
