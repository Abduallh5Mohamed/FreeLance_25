# B2-W4 — assignment upload lifecycle and scan worker (recovery)

Task: `server-b2-w4-assignment-recovery-20261021-01`
Worker: `wb-b2-w4-recovery-20261021-01` · team `storage`
Branch: `codex/workbuddy-server` · Windows + Git Bash
Date: 2026-10-21

This is a **recovery** of work left on disk by a worker that died on a transport
502 at 20:36 (`wb-b2-w4-upload-lifecycle-20261021-01`). The inherited bytes are
not mine and are not claimed as mine. Everything below separates what I verified
from what I changed.

---

## (A) Inherited state I verified

Snapshot authority: `C:/Users/abdua/WorkBuddySupervisorBridge/handoff/WORKBUDDY-B2-RECOVERY-BASELINE-20261021.md` (B2-W4 table).

I re-hashed all nine paths before writing anything. **All nine matched the
snapshot exactly** — no drift, no third-party edit between the snapshot and my
claim.

| path | inherited sha256 | bytes | matched snapshot | what I confirmed it does |
|---|---|---|---|---|
| `server/src/routes/assignments.ts` | `ac04d0116d47fc0d7366d040f701753414a7633b52e33a522d2f9085865c6ee1` | 83098 | yes | full lifecycle: create → upload-authorization (resume) → finalize → cancel → staff revoke; no object-serving route |
| `server/src/services/assignments.ts` | `5255bdf2e1e973db62dc355b16ef70fd38140ced434b8f17ec7beff6ef2af28f` | 24178 | yes | pure policy: validation, window/late, abandoned-pending accounting, key generation, finalize body rejection |
| `server/src/services/assignment-storage.ts` | `b674bd270bb42e4d71ce88b251364e7e4cbada60c5f806437c027ace5760ec4c` | 18898 | yes | object store adapter, ETag version binding, bounded prefix read, signature policy, signed POST policy capability, scanner contract + bounded scan |
| `server/src/services/assignment-scan-worker.ts` | **ABSENT** | – | yes (absent) | — (Gap A) |
| `server/tests/m4-assignments.test.ts` | `873f0bc7addd4e8ba720f1199eef6b34c6d277e34bc4680064d3a7c51cbc089e` | 61315 | yes | 40 tests: policy + route, incl. abandoned-pending, cancel, resume |
| `server/tests/m4-assignment-storage.test.ts` | `040211fc776af676b36491531b3685d4185137f0738cf2d63af1ba3b889838bf` | 48423 | yes | 47 tests: finalize denials, version binding, race, admission size, route surface |
| `server/tests/m4-assignment-scan-worker.test.ts` | `7103dea9e2b265779f669e2306c2d0563f28d1dc597b04e42d66ed838cf98bec` | 21981 | yes | 22 tests that define the worker contract; imported a module that did not exist |
| `docs/contracts/ASSIGNMENT-UPLOAD-FINALIZE.md` | `67001dd9240115086835cc5d0a9c8d1bcf2e620fd608fb5f659fc89014c9ebee` | 16390 | yes | prior contract; step 13 said "same size ⇒ idempotent 200" (the bug) and had no worker section |
| `docs/streams/server/B2-W4-ASSIGNMENTS-20261021.md` | **ABSENT** | – | yes (absent) | — (this file) |

Pre-write test state (measured by me, matching the launch-failure note §4):

| suite | before |
|---|---|
| `m4-assignments.test.ts` | 40/40 pass |
| `m4-assignment-storage.test.ts` | 46/47 — `finalize: a racing winner that recorded a different verdict is a conflict, not a success` (200 ≠ 409) |
| `m4-assignment-scan-worker.test.ts` | 0/1 — `MODULE_NOT_FOUND` for `../src/services/assignment-scan-worker` |

### Acceptance walk of the inherited code (before my changes)

| scope item | status in inherited bytes | evidence |
|---|---|---|
| abandoned `pending_upload` does not permanently burn the attempt limit | implemented | `isAbandonedPendingUpload` + `evaluateSubmission` exclude unverified stale rows; 15 min TTL; unknown `submitted_at` conservatively still counts; tests `resubmit: abandoned…`, `resubmit: a recent pending_upload still counts…`, `resubmit: resubmission_policy=block ignores…` |
| guarded resume/cancel with proven submission and object identity | implemented | resume = `upload-authorization` (own row, revoked/finalized/window checks, key re-verified); cancel = own row + `status<>'revoked' AND file_size_bytes=0` CAS + key re-verified + best-effort object removal; tests `resume: re-authorization targets the stored server key…`, `cancel: abandoned own upload…`, `cancel: finalized, already-revoked, foreign and staff callers never change state` |
| clean idempotent finalize/retry, concurrency prevents duplicate versions | **partially** | idempotent retry and single-version guarantee correct; the *loser* branch accepted any same-size winner as success → **Gap B** |
| immutable object/version binding at readiness (or fail-closed) | implemented | `objectVersion` requires ETag + positive integer size; missing ETag → `503 object_version_unbound`; post-scan re-stat requires same ETag *and* size → `409 object_replaced`; tests `an adapter that cannot express an object version fails closed`, `an object replaced between verification and scan…`, `a replaced object is refused even without a scanner` |
| no staff read of a non-clean or foreign file | implemented | no download/object route at all (asserted by route-surface test); staff list projects metadata only, never `storage_key`; a `pending_scan` row is not downloadable by contract §3 |
| admission size not falsely claimed | implemented, honest | `max_bytes_enforced:false` + `finalize_stat_only` for presigned PUT; `true` + `signed_content_length_range` only when the adapter signs a POST content-length range (MinIO `setContentLengthRange`) |
| byte cap before reading the body where supported | implemented | `readPrefix(key, MAX_SIGNATURE_PREFIX_BYTES=4096)`; adapter clamps and destroys the stream at the limit |
| no unsigned public bucket | implemented | `initializeBuckets()` probes/creates only, never sets a policy; test asserts zero `policy` calls |
| scan worker: bounded, CAS, fail-closed | **missing** | Gap A |

---

## (B) Changes I made

Own changes only. Four files written; the other five allowedPaths were left
byte-identical.

| path | before sha256 → after sha256 | bytes before → after | why |
|---|---|---|---|
| `server/src/services/assignment-scan-worker.ts` | **ABSENT** → `a40b390a16d8cde964864255e92c6a604f7c8506b68a10d5bce6ed75cfb7839e` | – → 22096 | **Gap A.** New bounded, explicitly-driven `pending_scan` worker + SQL store over existing columns. Satisfies the 22 inherited assertions and the scope's fail-closed rules. |
| `server/src/routes/assignments.ts` | `ac04d0116d47fc0d7366d040f701753414a7633b52e33a522d2f9085865c6ee1` → `535f59877212312d62799139929b0f1885ea27d4b03da89ef7b5cb378002cd0c` | 83098 → 84068 | **Gap B** production fix (see below) + one additional race fix (see "extra finding"). Two hunks, both inside the finalize handler; nothing else touched. |
| `server/tests/m4-assignment-storage.test.ts` | `040211fc776af676b36491531b3685d4185137f0738cf2d63af1ba3b889838bf` → `944fe8a0a097f9f38004a1226996a05337362f78064a8becc558b64198471cb8` | 48423 → 49661 | One added regression test for the extra revoke/finalize race. **No inherited assertion was changed, weakened or removed.** |
| `docs/contracts/ASSIGNMENT-UPLOAD-FINALIZE.md` | `67001dd9240115086835cc5d0a9c8d1bcf2e620fd608fb5f659fc89014c9ebee` → `66acec66020227619c82b6ca992eec5fc3cc7cf2762f3c584825d2a3d0353d8b` | 16390 → 24912 | Corrected step 13 (same size **and** same verdict), added the revoke predicate, documented the optional signed-POST admission capability and the byte-cap-before-read behaviour, added §9 (worker contract, bounds, CAS columns, limitations/I2) and §10 (stable codes). |
| `docs/streams/server/B2-W4-ASSIGNMENTS-20261021.md` | **ABSENT** → this file | – | Required report. Self-hash intentionally not embedded. |

Unchanged (verified byte-identical to the snapshot):
`server/src/services/assignments.ts`, `server/src/services/assignment-storage.ts`,
`server/tests/m4-assignments.test.ts`, `server/tests/m4-assignment-scan-worker.test.ts`.

### Gap B — what the finalize race actually was

**Production-logic defect, not a fixture defect.** The fixture was correct.

The inherited loser branch re-read the row and treated *any* winner that had
recorded the same byte size as an idempotent success:

```ts
if (current && Number(current.file_size_bytes) === verifiedSize.value) {
    return res.status(200).json(finalizeProjection(current));
}
```

In the failing test the winner had persisted `file_size_bytes=2048` with
`scan_status='infected'`, while this attempt had scanned the same version and
computed `clean`. Size matched, so the route answered **200** and projected the
winner's `infected` state — reporting *this* attempt as if it had produced a
verdict it never produced. A clean attempt being answered as a success is
exactly the "false success" the acceptance forbids; worse, the converse (a
racing `clean` winner masking this attempt's `infected` verdict) would be a
security-relevant misreport.

Fix (`server/src/routes/assignments.ts`, loser branch): idempotency now requires
the winner to have recorded **the same verified size and the same verdict**.

```ts
const sameOutcome = current !== null
    && Number(current.file_size_bytes) === verifiedSize.value
    && current.scan_status === nextScanStatus;
```

Any other committed state is `409 finalize_conflict`. The duplicate-finalize
test (two concurrent clean finalizes) still returns `200/200` because the winner
recorded the same size *and* `clean`. The assertion was not touched.

### Extra finding I fixed (beyond the two named gaps)

Walking the acceptance list surfaced a second, narrower race: the finalize CAS
predicate was

```
... AND file_size_bytes=0 AND scan_status='pending'
```

with **no** `status<>'revoked'`. A staff revoke that lands between the finalize
read and the finalize write could therefore persist `status='revoked'` **with**
`file_size_bytes=2048, scan_status='clean'` — a revoked version that reports
`upload_status='finalized'` and would pass a future download gate that keys only
on the upload state machine (§3). The scan worker's own CAS already excludes
revoked rows; finalize did not.

Fix: add `AND status<>'revoked'` to the finalize CAS, and map a loser that
re-reads a revoked row to `409 submission_revoked` (rather than the generic
`finalize_conflict`), so the client gets the precise stable code. Covered by one
new test: `finalize: a revoke that wins the race is never recorded as a ready
version` (asserts 409 `submission_revoked`, asserts the SQL predicate contains
`status<>'revoked'`, asserts zero audits).

### Gap A — the scan-worker contract I implemented

Explicitly runnable, no side effects:

- `createAssignmentScanWorker({...}).runOnce()`. Construction does no I/O, opens
  no timer, touches no store. Import has no side effect. Not wired into
  `index.ts` (off-limits and deliberately not needed).

Bounds (clamped, never honoured above the cap):

| knob | default | cap |
|---|---|---|
| `batchSize` | 10 | 50 |
| `concurrency` | 2 | 8 |
| `claimAttempts` | 3 | 5 |
| `maxAttemptsPerRow` | 1 | 5 |
| `retryDelayMs` (base) | 250 ms | 5000 ms |
| `scanTimeoutMs` | shared 30 s | 120 s |

Claim: `SELECT … FROM assignment_submissions WHERE scan_status='pending' AND
file_size_bytes>0 AND status<>'revoked' ORDER BY submitted_at ASC, id ASC LIMIT
<clamped int>` — one bounded batch per run, revoked rows excluded, limit is a
clamped integer literal (no raw interpolation).

CAS verdict write: `UPDATE assignment_submissions SET scan_status=? WHERE
id=? AND tenant_id=? AND assignment_id=? AND student_enrollment_id=? AND
scan_status='pending' AND file_size_bytes=? AND status<>'revoked'`. Columns used
are exactly `scan_status`, `file_size_bytes`, `status` — all present in
`server/migrations/20261018_08_question_bank_assignments.sql`. No invented
column, no DDL.

Fail-closed behaviour:

- no scanner ⇒ `aborted:'scanner_absent'`, **zero claims**, nothing clean;
- scanner error / throw / timeout / `verdict:'failed'` ⇒ `scan_failed`, row
  untouched, retryable — **never** `infected`, never `clean`;
- unconfirmed verdict retried only up to `maxAttemptsPerRow`, deterministic
  exponential backoff, never a random loop, never softened;
- verdict bound to the stat'ed version: input carries ETag+size, the object is
  re-stat'ed after the scan, a changed ETag/size discards the verdict
  (`object_changed`);
- the persisted `storage_key` is re-derived and must match the row facts
  (tenant/assignment/enrollment/submission/extension); a forged key is never
  stat'ed;
- adapter with no ETag/positive size ⇒ `unbound_object_version`, never scanned;
- `infected` ⇒ object removed **even when the row write lost its race**;
- a second concurrent `runOnce()` in the same process ⇒ `already_running`,
  zero claims.

---

## (C) Evidence

### Commands (exactly as run, from the repo root)

```
cd server && M1_NETWORK_MODE=hermetic node --require ../scripts/m1-network-guard.cjs --import tsx --test tests/m4-assignments.test.ts
cd server && M1_NETWORK_MODE=hermetic node --require ../scripts/m1-network-guard.cjs --import tsx --test tests/m4-assignment-storage.test.ts
cd server && M1_NETWORK_MODE=hermetic node --require ../scripts/m1-network-guard.cjs --import tsx --test tests/m4-assignment-scan-worker.test.ts
node node_modules/typescript/bin/tsc --noEmit -p server/tsconfig.json
```

### Test counts

| suite | before | after |
|---|---|---|
| `m4-assignments.test.ts` | 40 pass / 0 fail | **40 pass / 0 fail** (untouched) |
| `m4-assignment-storage.test.ts` | 46 pass / 1 fail | **48 pass / 0 fail** (+1 own regression test) |
| `m4-assignment-scan-worker.test.ts` | 0 pass / 1 fail (module not found) | **22 pass / 0 fail** |
| total | 86 pass / 2 fail | **110 pass / 0 fail** |

Skipped: 0 in every suite. No `.skip`, no `any`, no `@ts-ignore`, no placeholder.

### Typecheck

`node node_modules/typescript/bin/tsc --noEmit -p server/tsconfig.json` → **exit 0, zero diagnostics**.
(`server/tsconfig.json` includes `src/**/*` only, so test files are exercised by
the runner, not by `tsc` — same situation as the inherited baseline.)

### Limitations (plain, not hidden)

1. **No scanner provider exists.** No ClamAV/AV service is selected, configured
   or contacted. With no injected adapter the worker aborts `scanner_absent`, and
   the route always ends `202 pending_scan`. The end-to-end
   `pending_scan → clean` path is **not proven against a real provider**, and I
   do not claim it.
2. **No durable attempt/lease columns.** `scan_attempts`,
   `scan_claimed_at`/`scan_lease_until`, `scan_last_error` do not exist. The
   attempt cap, the claim batch and the "one run at a time" guard are therefore
   **in-run only**: two processes may scan the same row concurrently, and a
   permanently failing row is retried by every run. The CAS makes the duplicate
   harmless (only one verdict lands) but the work is wasted. Cross-run
   "give up after N attempts" cannot be enforced; such a row stays `pending`
   (and therefore unreadable) rather than being marked `failed`.
3. **Head-of-line risk.** Without `scan_next_attempt_at`, ordering is FIFO, so
   more than one batch of permanently failing rows can delay later rows.
4. **Worker is not scheduled.** Not registered in `server/src/index.ts` (out of
   scope). Nothing calls `runOnce()` in production today.
5. **Bounded presigned PUT is not claimed.** A SigV4 presigned PUT cannot bind
   body length; the API reports `max_bytes_enforced:false` honestly. Real
   pre-admission enforcement exists only through the MinIO POST policy
   capability (`setContentLengthRange`), which is exercised with an injected
   adapter, not against a live MinIO.
6. **No DB, no provider, no network was used.** All storage/SQL behaviour is
   proven at the injected seam with recorded statements and recorded adapter
   calls. No MySQL, MinIO, Docker, migration or listener was started.
7. **`object_etag` is not persisted.** Readiness binding is per-request (stat →
   scan → re-stat) plus the worker's own re-stat. A later reader still cannot
   prove which version a `pending_scan` row was verified against; that needs the
   additive migration proposed in contract §8.

### I2 requests (no DDL authored or executed)

1. `assignment_submissions`: add `scan_attempts INT NOT NULL DEFAULT 0`,
   `scan_next_attempt_at TIMESTAMP NULL`, `scan_lease_until TIMESTAMP NULL`,
   `scan_last_error VARCHAR(255) NULL` — needed for durable attempt exhaustion,
   cross-process leasing and head-of-line avoidance. Until then the worker's
   caps are in-run only (limitation 2–3).
2. `assignment_submissions`: add `object_etag VARCHAR(64) NULL` (contract §8) so
   a verdict and a future download gate can be bound to a persisted object
   version rather than only to an in-request stat.

### What I deliberately did not do

- No rewrite of inherited bytes; the three inherited source/test files that did
  not need a change are byte-identical.
- No change to `server/src/index.ts`, `middleware/auth.ts`, `db.ts`,
  `bootstrap/m1/manifest.json`, `server/migrations/**`, any client file, or any
  W9/W6/Claude-lane batch-2 path.
- No migration, DDL, DB, Docker, service, listener, network, provider, secret,
  install or Git mutation.
- No full-suite run (other writers are active).
- No acceptance claim: `reported` is not `accepted`.

---

# Correction pass — `server-b2-w4-quarantine-recovery-20261021-01`

Task: `server-b2-w4-quarantine-recovery-20261021-01`
Worker: `wb-b2-w4-quarantine-recovery-20261021-01` · team `storage`
Branch: `codex/workbuddy-server` · Windows + Git Bash · Date: 2026-10-21

This section is the **missing correction pass**. A previous correction worker was
killed by a provider 429 *after* writing real, correct code; its bytes were
already on disk and green. My job was to verify that inherited correction without
rewriting it, and then close the same defect class in the paths the earlier
acceptance did not cover. Everything below separates inherited from own.

## (A) Inherited state I verified

Snapshot authority: `C:/Users/abdua/WorkBuddySupervisorBridge/handoff/WORKBUDDY-B2-RECOVERY2-BASELINE-20261021.md`
(W4 table), captured 2026-10-21 22:23:34 +0300, before any claim.

I re-hashed all nine allowedPaths before writing anything. **All nine matched the
snapshot exactly** — no drift, no third-party edit between the snapshot and my
claim.

| path | inherited sha256 | bytes | matched | what I confirmed it does |
|---|---|---|---|---|
| `server/src/routes/assignments.ts` | `55482541354bdda4aec8c96a3559fc14e6451b92905d7e1fdcfce5de490363d5` | 85747 | yes | lifecycle routes; **still had mutable-key deletes in the rejection/cancel paths** — the defect of this pass |
| `server/src/services/assignments.ts` | `5255bdf2e1e973db62dc355b16ef70fd38140ced434b8f17ec7beff6ef2af28f` | 24178 | yes | pure policy; nothing to do with deletes |
| `server/src/services/assignment-storage.ts` | `4682fef08629d795c5ff7c1ef282f32333f032d857492036f528065939a5d0fc` | 24486 | yes | the exact-version seam: `supportsExactVersionRemoval`, `removeScannedObjectVersion`, `BoundObjectVersion`, declared `capabilities` |
| `server/src/services/assignment-scan-worker.ts` | `f079965948424b8aa3cfaa6f79cf855da53bf0286c9c64757838ed1dc874403e` | 25685 | yes | deletes only through the seam, input `{objectKey, etag, sizeBytes}`, answers `quarantined_cleanup_pending` |
| `server/tests/m4-assignments.test.ts` | `873f0bc7addd4e8ba720f1199eef6b34c6d277e34bc4680064d3a7c51cbc089e` | 61315 | yes | 40 tests, incl. the cancel test that asserted a key delete |
| `server/tests/m4-assignment-storage.test.ts` | `2cd13914256ebdd859ee4f15d8e059b780ab07d0e39309e3eb75bb351076e1a5` | 53147 | yes | 50 tests, incl. 4 denial tests that asserted a key delete |
| `server/tests/m4-assignment-scan-worker.test.ts` | `d538d0df17dbe24d4358e3b0d95cd682175b92de5ba3625051c8a4e07cffe14f` | 30937 | yes | 27 tests covering the worker's version-bound quarantine |
| `docs/contracts/ASSIGNMENT-UPLOAD-FINALIZE.md` | `7f72cd9bc3aad50a4e8d4b02d3ce0b1b74fafa02ec73a1c16595f5fe88e82eb0` | 31810 | yes | §9.6 documents the quarantine rule; §5 still documented the rejection/cancel key deletes |
| `docs/streams/server/B2-W4-ASSIGNMENTS-20261021.md` | `72d2009827416dccf3d72f6a470d278b8622be8c3cd6f2f8c5bde7daa72d1747` | 17193 | yes | ended at the recovery pass; **no correction section** — the gap this section fills |

### The inherited correction, verified by reading (not rewritten)

I read all three seams and confirmed each claim in the code. Nothing was missing,
so **not one byte of the inherited correction was rewritten**.

| claim | verified at | confirmation |
|---|---|---|
| `supportsExactVersionRemoval(store)` requires **both** the flag and the method | `server/src/services/assignment-storage.ts:282` | `store.capabilities?.conditionalDelete === true && typeof store.removeObjectVersion === 'function'` |
| `removeScannedObjectVersion` returns `'unsupported' \| 'failed' \| ObjectVersionRemoval` and **never** falls back to `removeObject` | `server/src/services/assignment-storage.ts:296` | returns `'unsupported'` before any call when the gate fails; the catch answers `'failed'`; no `removeObject` reference exists in the function |
| the scan worker only ever deletes through that version-bound seam | `server/src/services/assignment-scan-worker.ts:455` | `removeScannedObjectVersion(objectStore, { objectKey: candidate.storageKey, etag: scanned.etag, sizeBytes: scanned.sizeBytes }, report)` — `scanned` is the post-scan re-stat version |
| unsupported/failed ⇒ `quarantined_cleanup_pending` | `server/src/services/assignment-scan-worker.ts:463` | `cleanup === 'unsupported' \|\| cleanup === 'failed' ? 'quarantined_cleanup_pending' : 'quarantined'` |
| the route has `quarantineRejectedObject(storageKey, version, submissionId)` on the infected-finalize branch | `server/src/routes/assignments.ts` (`quarantineRejectedObject`, line 603 after my edits) | used at the `uploadStatus === 'quarantined'` branch |

Measured before I wrote anything (my own runs, hermetic, from `server/`):

| suite | before |
|---|---|
| `m4-assignments.test.ts` | 40 pass / 0 fail |
| `m4-assignment-storage.test.ts` | 50 pass / 0 fail |
| `m4-assignment-scan-worker.test.ts` | 27 pass / 0 fail |
| total | **117 pass / 0 fail** |
| `tsc --noEmit -p server/tsconfig.json` | **exit 0, zero diagnostics** |

## (B) Changes I made

### Own change 1 — `server/src/routes/assignments.ts` (the defect)

`removeRejectedObject(storageKey, submissionId)` called
`objectStore.removeObject(storageKey)`: a **mutable-key** delete. It ran at four
finalize denial branches and at the student cancel path — all places where the
server had *already stat'ed the object and held a verified version*. That is the
same defect class as the inherited quarantine bug, and it was not in the earlier
acceptance.

What I changed, and nothing else in that file:

1. `removeRejectedObject` now takes a `BoundObjectVersion` and routes through
   `removeScannedObjectVersion` — the same capability-gated seam the quarantine
   path uses. It has **no mutable-key fallback**: when the adapter cannot prove
   the version it deletes nothing and logs
   `Assignment rejection cleanup pending`.
2. New `removeCancelledUpload(storageKey, submissionId)`: the cancel path has no
   earlier verdict to re-stat against, so it proves the version first
   (`statObject` → `boundObjectVersion` → exact-version delete). A stat failure, a
   missing object, or an unprovable version deletes nothing and leaves the
   cleanup pending — the cancellation still answers its unchanged `200`.
3. The four denial branches (size over limit, invalid verified size, content-type
   mismatch, signature mismatch) now pass `verifiedVersion`. That value is bound
   at `server/src/routes/assignments.ts:1198` and is already non-null-checked
   (`503 object_version_unbound`) before any branch runs.
4. The cancel path calls `removeCancelledUpload` instead of the key delete.

No status code, error code, response body, permission check, auth rule, SQL
statement or audit action was changed. `objectStore.removeObject` is now called
**nowhere** in the route.

### Own change 2 — `server/tests/m4-assignment-storage.test.ts`

A new section, **"Rejection and cancel cleanup: exact version, never the mutable
key"**, plus two shared helpers:

- `makeRejectionStore({ stat, live?, exactVersion? })` — a fake store over one
  mutable key holding immutable versions. `stat` is the version the server
  observes; `live` is the version actually at the key when a delete arrives.
  `removeObjectVersion` is enforced by the store itself (precondition compared
  against `live`, answering `version_replaced` rather than destroying a different
  version), and `exactVersion: false` models the key-only production adapter.
- `withCapturedErrors(fn)` — captures `console.error` for the duration of one
  call, because the pending-cleanup report is an operator-log fact (the denial
  response body is a frozen contract).

Then a table-driven loop over the four denial branches (size over limit, verified
size outside the window, content-type mismatch, signature mismatch) × three
scenarios (exact-version remove, controlled replacement race, unsupported
adapter) = **12 new tests**, listed in the scenario map in §(C). Plus the four
strengthened inherited assertions from §(B).

### Own change 3 — `server/tests/m4-assignments.test.ts`

A new section, **"Cancel cleanup: exact version, never the mutable key"**, with
`makeCancelStore(statVersion, liveVersion?, exactVersion?)` (the same
store-enforced precondition model), `cancelAbandoned(store)` (builds the student
router, invokes the cancel, and captures `console.error`), and **3 new tests**:
the proven version is removed and never by key; a re-upload that lands after the
stat survives; an absent object and a key-only adapter delete nothing and report
pending while the cancel still answers `200`. Plus the strengthened inherited
cancel assertion from §(B).

### Own change 4 — the two docs

`docs/contracts/ASSIGNMENT-UPLOAD-FINALIZE.md`: new **§9.7** ("Rejection and
cancel cleanup — the same rule, one class of defect") documenting the four
branches in a table, the exact-version rule, the cancel stat-then-delete
sequence, the pending-without-capability behaviour, and the honest limitation that
production destroys nothing today; the **§5** bullet that said `removeObject` "is
used only for admission rejections … and for the student's own cancel" and
acknowledged the residual hazard is corrected to say the lifecycle never calls it;
and finalize step 11 now annotates that steps 8–10 are admission denials that
clean up by exact version. No §9.x section was removed or reworded away.

`docs/streams/server/B2-W4-ASSIGNMENTS-20261021.md`: this correction section.

| path | before sha256 → after sha256 | bytes before → after | attribution |
|---|---|---|---|
| `server/src/routes/assignments.ts` | `55482541354bdda4aec8c96a3559fc14e6451b92905d7e1fdcfce5de490363d5` → `33668d50dc997e74d1fba89f3678a0c324decea3f0ecbd29e722e17208c239c4` | 85747 → 88693 | **own** — the two helpers above, four call sites, one cancel call site, one import. No inherited hunk touched. |
| `server/tests/m4-assignment-storage.test.ts` | `2cd13914256ebdd859ee4f15d8e059b780ab07d0e39309e3eb75bb351076e1a5` → `409dafc40b928d4af1c97e93a8afc1014d0acf6fbfa209412e3e39354a070da1` | 53147 → 62590 | **own** — 12 new tests + 4 strengthened assertions |
| `server/tests/m4-assignments.test.ts` | `873f0bc7addd4e8ba720f1199eef6b34c6d277e34bc4680064d3a7c51cbc089e` → `f1c6780b9b4ee24da5b56b7a85a5dd870c56b274e700facb4fae224f2128a1be` | 61315 → 68237 | **own** — 3 new tests + 1 strengthened assertion |
| `docs/contracts/ASSIGNMENT-UPLOAD-FINALIZE.md` | `7f72cd9bc3aad50a4e8d4b02d3ce0b1b74fafa02ec73a1c16595f5fe88e82eb0` → `37c1df78d96f855e59eb8ce8a5782e055b1763fa7186700fe854b21c86bb5f13` | 31810 → 35252 | **own** — new §9.7, corrected §5, annotated finalize step 11 |
| `docs/streams/server/B2-W4-ASSIGNMENTS-20261021.md` | `72d2009827416dccf3d72f6a470d278b8622be8c3cd6f2f8c5bde7daa72d1747` / 17193 | self-hash and self byte-count intentionally not embedded — writing either one changes this file, so neither can be accurate here | **own** — this correction section |

**Byte-identical, untouched (inherited bytes preserved):**
`server/src/services/assignments.ts`,
`server/src/services/assignment-storage.ts`,
`server/src/services/assignment-scan-worker.ts`,
`server/tests/m4-assignment-scan-worker.test.ts`.

### Inherited-vs-own attribution, explicitly

**Inherited (not mine, verified, preserved byte-for-byte):** the entire
exact-version seam in `assignment-storage.ts`; the entire version-bound
quarantine path in `assignment-scan-worker.ts`; `quarantineRejectedObject` and
the `verifiedVersion` binding in `routes/assignments.ts`; all 27 scan-worker
tests; the 117-test green baseline; the `tsc` clean baseline.

**Own (written by me in this pass):** the two route helpers and their five call
sites; 15 new tests; 5 strengthened assertions; the §9.7 contract section and the
§5 correction; this report section.

### The one conflict I had to resolve, stated plainly

The launch instruction said "keep the existing 117 tests passing" and "do not
weaken an assertion". Five of those inherited assertions asserted the **defect**:
they required `removeObject` to have been called with the mutable key
(4 denial tests in `m4-assignment-storage.test.ts`, 1 cancel test in
`m4-assignments.test.ts`). No implementation that routes every rejection through
exact-version removal can satisfy them, so leaving them untouched and claiming
"117 pass" would have been impossible, and deleting them would have been a
weakening.

I therefore **strengthened** each of them in place, keeping the test identity and
every other assertion, and replacing only the key-delete assertion with an
exact-version assertion plus a mutable-key-never assertion. Nothing was skipped,
nothing was deleted, no count was reduced:

| test | inherited assertion | own assertion |
|---|---|---|
| `finalize: an oversize object is 413, removed best-effort and not recorded` | `removed === [STORAGE_KEY]` | `removed === ['…#e:2000000']` **and** `mutableRemovals === []` |
| `finalize: an undersize object is rejected and removed` | `removed === [STORAGE_KEY]` | `removed === ['…#e:5']` **and** `mutableRemovals === []` |
| `finalize: a stored content-type mismatch is 422 and removed` | `removed === [STORAGE_KEY]` | `removed === ['…#e:2048']` **and** `mutableRemovals === []` |
| `finalize: a signature mismatch (renamed HTML as PDF) is 422 and removed` | `removed === [STORAGE_KEY]` | `removed === ['…#etag-1:2048']` **and** `mutableRemovals === []` |
| `cancel: an abandoned own upload is revoked, audited and its unverified bytes removed` | `removed === ['tenants/…/sub-1.pdf']` | `removed === ['tenants/…/sub-1.pdf#etag-1:2000']` **and** `mutableRemovals === []` |

Every other assertion in those five tests — status, code, body, "no
`UPDATE assignment_submissions`", audit action, SQL predicate, bound params — is
unchanged.

## (C) Evidence

### Commands (exactly as run)

```
cd server && M1_NETWORK_MODE=hermetic node --require ../scripts/m1-network-guard.cjs --import tsx --test tests/m4-assignments.test.ts
cd server && M1_NETWORK_MODE=hermetic node --require ../scripts/m1-network-guard.cjs --import tsx --test tests/m4-assignment-storage.test.ts
cd server && M1_NETWORK_MODE=hermetic node --require ../scripts/m1-network-guard.cjs --import tsx --test tests/m4-assignment-scan-worker.test.ts
node node_modules/typescript/bin/tsc --noEmit -p server/tsconfig.json
```

### Test counts

| suite | before | after |
|---|---|---|
| `m4-assignments.test.ts` | 40 pass / 0 fail | **43 pass / 0 fail** (+3 own) |
| `m4-assignment-storage.test.ts` | 50 pass / 0 fail | **62 pass / 0 fail** (+12 own) |
| `m4-assignment-scan-worker.test.ts` | 27 pass / 0 fail | **27 pass / 0 fail** (untouched) |
| total | **117 pass / 0 fail** | **132 pass / 0 fail** |

Skipped: 0 in every suite. No `.skip`, no `any`, no `@ts-ignore`, no cast used to
make anything green. The full suite was **not** run.

### Typecheck

`node node_modules/typescript/bin/tsc --noEmit -p server/tsconfig.json` → **exit
0, zero diagnostics**, before and after.

### The new tests are real regression tests (defect-reintroduction experiment)

A test that passes both before and after a fix is worthless, so I measured it. I
temporarily restored the mutable-key delete in `removeRejectedObject`, ran the
suites, and then restored the fix:

- with the defect reintroduced in the rejection helper:
  `m4-assignment-storage.test.ts` → **62 tests, 46 pass, 16 fail**. The 16
  failures are the 4 strengthened inherited assertions plus all 12 new tests.
- with the defect reintroduced in the cancel helper:
  `m4-assignments.test.ts` → **43 tests, 39 pass, 4 fail**. The 4 failures are the
  strengthened cancel assertion plus all 3 new tests.

Both files were restored to the fixed bytes (`33668d50…`) and re-run green
afterwards. The route file was never left in the defective state.

### Scenario → assertion map

All new tests use a fake adapter whose version-bound delete is **enforced by the
store itself** — it compares the precondition against the version that is live
when the delete arrives and answers `version_replaced` instead of destroying a
different version. The capability gate and the precondition binding both live in
the code under test, so no mock pre-decides the answer.

| # | scenario | assertions |
|---|---|---|
| 1 | size over the assignment limit, exact-version adapter | destroys exactly `#e:2000000`; `mutableRemovals === []`; no row `UPDATE` |
| 2 | size over the limit, **re-upload lands after the stat** | `destroyed === []` (the replacement survives); `mutableRemovals === []`; the store was still asked for `#e:2000000` only |
| 3 | size over the limit, **key-only adapter** | `mutableRemovals === []`; `versionRemovals === []`; log contains `Assignment rejection cleanup pending` |
| 4 | verified size outside the window | as #1, with `#e:5` |
| 5 | verified size outside the window, replacement race | as #2 |
| 6 | verified size outside the window, key-only adapter | as #3 |
| 7 | stored content-type mismatch | as #1, with `#e:2048` |
| 8 | content-type mismatch, replacement race | as #2 |
| 9 | content-type mismatch, key-only adapter | as #3 |
| 10 | signature mismatch | as #1, with `#etag-1:2048` |
| 11 | signature mismatch, replacement race | as #2 |
| 12 | signature mismatch, key-only adapter | as #3 |
| 13 | cancel, exact-version adapter | proves the version at the key, destroys exactly `#etag-1:2000`; `mutableRemovals === []`; response `200` + `{id,status:'revoked',cancelled:true}` unchanged |
| 14 | cancel, **re-upload lands after the stat** | `destroyed === []` (the replacement survives); `mutableRemovals === []`; the store was still asked for `#etag-1:2000` only; the cancel still answers `200` |
| 15 | cancel, object absent / key-only adapter | `destroyed === []`, `mutableRemovals === []`, `versionRemovals === []`; log contains `Assignment rejection cleanup pending`; the cancel still answers `200` with the unchanged body |

### Hashes and byte sizes of every allowedPath I touched

Before → after (before values are the inherited snapshot values, all confirmed
identical by my own re-hash before writing):

| path | before sha256 / bytes | after sha256 / bytes |
|---|---|---|
| `server/src/routes/assignments.ts` | `55482541354bdda4aec8c96a3559fc14e6451b92905d7e1fdcfce5de490363d5` / 85747 | `33668d50dc997e74d1fba89f3678a0c324decea3f0ecbd29e722e17208c239c4` / 88693 |
| `server/tests/m4-assignment-storage.test.ts` | `2cd13914256ebdd859ee4f15d8e059b780ab07d0e39309e3eb75bb351076e1a5` / 53147 | `409dafc40b928d4af1c97e93a8afc1014d0acf6fbfa209412e3e39354a070da1` / 62590 |
| `server/tests/m4-assignments.test.ts` | `873f0bc7addd4e8ba720f1199eef6b34c6d277e34bc4680064d3a7c51cbc089e` / 61315 | `f1c6780b9b4ee24da5b56b7a85a5dd870c56b274e700facb4fae224f2128a1be` / 68237 |
| `docs/contracts/ASSIGNMENT-UPLOAD-FINALIZE.md` | `7f72cd9bc3aad50a4e8d4b02d3ce0b1b74fafa02ec73a1c16595f5fe88e82eb0` / 31810 | `37c1df78d96f855e59eb8ce8a5782e055b1763fa7186700fe854b21c86bb5f13` / 35252 |
| `docs/streams/server/B2-W4-ASSIGNMENTS-20261021.md` | `72d2009827416dccf3d72f6a470d278b8622be8c3cd6f2f8c5bde7daa72d1747` / 17193 | self-hash and self byte-count intentionally not embedded — writing either one changes this file, so neither can be accurate here |

Four allowedPaths were not touched and remain byte-identical to the snapshot:
`server/src/services/assignments.ts`,
`server/src/services/assignment-storage.ts`,
`server/src/services/assignment-scan-worker.ts`,
`server/tests/m4-assignment-scan-worker.test.ts`.

## (D) Durability limits (explicit)

1. **Per-run attempt caps are not durable exhaustion.** The scan worker's
   `maxAttemptsPerRow`, `claimAttempts`, batch size and the "one run at a time"
   guard are all in-memory, per-process, per-run. There is no persisted
   `scan_attempts` / `scan_lease_until` column, so a permanently failing row is
   retried by every run and two processes may scan it concurrently. The CAS makes
   the duplicate harmless (only one verdict lands) but the work is wasted, and
   cross-run "give up after N attempts" cannot be enforced. This limit is
   **inherited, unchanged, and not closed by me** — closing it needs the additive
   migration in contract §8/I2, which this task does not author.
2. **The four denial branches and the cancel path previously deleted by mutable
   key.** That is the defect this pass closed, and it is now closed at the seam:
   every one of the five goes through `removeScannedObjectVersion` or deletes
   nothing. There is no mutable-key fallback anywhere in the route.
3. **Nothing is destroyed on production storage today.** The production MinIO
   adapter declares `capabilities.conditionalDelete = false`
   (`assignment-storage.ts`, `createMinioAssignmentObjectStore`), because
   `removeObject` addresses the key, S3 `DELETE` has no ETag precondition, and the
   `versionId` form addresses a bucket version this deployment neither enables nor
   can prove. So on the real adapter **every** denial, cancel and infected
   cleanup ends `unsupported` → pending, and the bytes stay in the private
   bucket. That is honest, not a silent success, but it does mean the cleanup
   behaviour proven here is proven at the injected seam, never against a live
   MinIO.
4. **No durable per-row pending-cleanup flag.** `assignment_submissions` has no
   `quarantine_cleanup_state` and no `object_etag`, so a pending cleanup is
   observable only in the worker's run result and the operator log — it is not
   queryable, and a restarted process cannot enumerate the pending set. Same I2
   gap as §9.6.
5. **"Pending" is a log fact, not a response field.** The denial response bodies
   are a frozen contract, so the pending state cannot be surfaced to the caller
   without changing them. I did not change them.
6. **The race tests model the race at the adapter.** The concurrent re-upload is
   simulated by the fake store answering `version_replaced` against its live
   version. That proves the route asked for the right version and destroyed
   nothing when the version had moved; it does not prove anything about real
   MinIO concurrency, which was never contacted.

## (E) What I deliberately did not do

- **I did not rewrite, reformat, restructure or "clean up" any inherited code.**
  The exact-version seam, the scan worker and all 27 of its tests are
  byte-identical to the snapshot.
- I did not touch any of the four untouched allowedPaths.
- I did not add, remove or rename any path. No new file was created.
- I did not touch another lane's files, schema, migrations, index, auth, DB,
  Docker, listeners, network, providers, secrets, package installs or Git state.
- I did not change any auth rule, permission check, status code, error code or
  response body.
- I did not add a scanner provider, select one, or contact one.
- I did not run the full suite (other writers are active) — only the three W4
  suites, hermetically.
- I did not weaken, skip or delete any inherited assertion; the five that
  encoded the defect were strengthened in place, as documented in §(B).
- I did not use `any`, `@ts-ignore` or a cast to make anything green.
- I did not claim a completion percentage, and `reported` is not `accepted`.
