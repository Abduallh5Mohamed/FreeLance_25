# M1 Video Processing Reliability & Recovery — Design Record

Task: `m1-video-processing-reliability-batch-01` (batch m1-implementation-20261013, branch
`codex/m1-wip-20261009`). Scope files only: `server/src/index.ts`,
`server/src/routes/videos.ts`, `server/src/services/video-processor.ts`,
`server/src/services/minio.ts`, `server/tests/m1-upload-contract.test.ts`,
`server/tests/m1-video-processing-recovery.test.ts`, this document.

## 1. What was broken (verified defects)

The upload critical section (named-lock serialization, single-transaction
claim+enqueue, stream-guarded byte transfer, dedicated 4-connection
upload-lock pool separate from the 10-slot request pool) was already in
place and is preserved unchanged. The PROCESSING lifecycle around it had
five verified defects:

1. **Two competing recovery paths.** `server/src/index.ts` ran its own
   stuck-video recovery 15 s after boot: it reset every video in
   `processing` older than 10 minutes back to `uploading` and called
   `processVideo` directly — a job genuinely running (in this or another
   process) was reset mid-flight, and the second pass started outside every
   lock and outside the in-flight guard.
2. **No cross-process exclusion for processing.** `startVideoProcessing`
   guarded only with a per-process `Set`. Two API processes could process
   the same video concurrently (double ffmpeg passes, racing MinIO writes,
   double delete of the original object).
3. **Queue rows never settled.** Nothing ever wrote
   `video_processing_queue.status` to `completed`/`failed`. Rows stayed
   `pending` forever after a successful run, and a transient processing
   failure left a permanently failed video that only an operator noticed.
4. **One-shot startup recovery.** The queue consumer ran exactly once at
   boot; a failed read lost that cycle, and nothing consumed committed rows
   that appeared later. It also launched every stranded job at once.
5. **Recovery routes bypassed the job rows.** `/upload/recover-stuck`
   re-enqueued `uploading` videos (live uploads — racing the byte transfer
   and risking truncated-byte processing), and `/:videoId/retry` +
   `/:videoId/reprocess` started the processor with no queue row at all.

## 2. The unified lifecycle (one protected execution path)

Every processing run — upload completion, startup sweep, periodic consumer,
admin recovery, user retry/reprocess — now flows through
`runVideoProcessingJob(videoId, tenantId, deps)` in `server/src/routes/videos.ts`:

```
verify ownership → idempotency guards → acquire named lock → claim row → run → settle → release
```

1. **Exact tenant/video/job ownership** (`createSqlVideoJobLoader`): the
   queue row and the video row are joined with `q.tenant_id IS NOT NULL AND
   v.tenant_id IS NOT NULL AND q.tenant_id = v.tenant_id AND q.tenant_id = ?`.
   An inconsistent row can never be claimed; `processVideo`'s own
   tenant-scoped row load remains as the second line of defense.
2. **Idempotency guards**: a settled row (`completed`/`failed`), a video
   already `ready` (settle the row completed, never re-run — the original
   object is gone and a re-run would flip a ready video to failed), a video
   already `failed` (settle failed), or a video still `uploading` (a live
   upload, not a crashed job) is never processed.
3. **Cross-process exclusion**: a MySQL named lock
   (`GET_LOCK(name, 0)`, non-blocking) on a **dedicated processing-lock
   pool** (`PROCESSING_LOCK_POOL_SIZE = 3`), separate from both the request
   pool and the upload-lock pool. A live holder denies the contender with
   `locked` — never queues. A crashed holder's session dies and MySQL frees
   the lock immediately.
4. **Atomic claim** (`createSqlVideoJobClaim`):
   `UPDATE … SET status='processing', started_at=NOW(), worker_id=?
   WHERE video_id=? AND status IN ('pending','processing')`. The
   `processing` acceptance is the crash-window takeover: the claim succeeds
   only while WE hold the lock, so no live claimant can exist.
5. **Run**: `processVideo(videoId, tenantId)` — unchanged.
6. **Settle** (`createSqlVideoJobSettler`): `completed` (completed_at,
   error cleared) or `failed` (completed_at + bounded error message),
   guarded by `status <> 'completed'/'failed'` so a late settle never
   clobbers a terminal state. A settle failure is logged and contained;
   the next sweep repairs it once the row is stale.
7. **Release**: `RELEASE_LOCK` + return to pool; on any release-round-trip
   failure the connection is **destroyed**, never pooled (a session that
   may still own the lock must not be handed to the next operation).

### Startup / recovery unification

- `index.ts` no longer touches videos or the processor. It starts
  `scheduleVideoQueueConsumer()` — an immediate sweep at boot plus a
  periodic sweep (`VIDEO_QUEUE_POLL_SECONDS`, default 60 s, unref'd timer).
- `loadPendingJobsWithRetry` retries a transient queue READ with
  exponential backoff (`VIDEO_QUEUE_LOAD_ATTEMPTS` = 3,
  `VIDEO_QUEUE_LOAD_BACKOFF_MS` = 1000 → 1 s, 2 s) before the sweep gives
  up for this cycle; the next periodic sweep retries.
- `createPendingVideoJobLoader` is the single read that defines what owes a
  run: `q.status IN ('pending','processing')` with the stale branch
  `q.started_at < NOW() - INTERVAL <lease> MINUTE`
  (`VIDEO_PROCESSING_LEASE_MINUTES`, default 60), exact tenant matching,
  `v.status='processing'`, `delivery_provider='minio'`,
  `ORDER BY q.created_at LIMIT <batch>` (`VIDEO_QUEUE_BATCH_SIZE`, default
  10). A **fresh** `processing` row belongs to a live run and is excluded —
  the lock is the authoritative liveness check before any takeover.
- `reconcileVideoProcessingQueue` stops at in-process saturation
  (`VIDEO_PROCESSING_CONCURRENCY`, default 2) and during shutdown;
  remaining rows are consumed by the next sweep.

### Admin recovery and user retry

- `POST /upload/recover-stuck` (verified platform capability) now re-arms
  only `processing`/`failed` videos past the threshold, re-opens their job
  row, and feeds the protected path. `uploading` videos are live uploads:
  counted as `liveUploadsLeftAlone` and left untouched.
- `POST /:videoId/retry` and `/:videoId/reprocess` re-arm the video to
  `processing`, re-open the job row (`ON DUPLICATE KEY UPDATE status=
  'pending', …`), and go through the protected path. The retry response
  carries `jobOutcome` (`started` / `already_running` / `saturated` /
  `shutting_down`).

### Shutdown

`SIGTERM`/`SIGINT` → stop the consumer → block new runs
(`requestVideoProcessingShutdown`) → close the HTTP server → bounded drain
(30 s, polling `inFlightVideoProcessingCount`) → close BOTH dedicated lock
pools (`closeUploadLockPool`, `closeProcessingLockPool`) → exit. A drain
timeout exits anyway; MySQL releases owner-dead locks with their sessions,
so a killed run cannot deadlock recovery.

## 3. Concurrency, budgets and crash semantics

- **Bounds**: concurrency 2 (env), batch 10 (env), poll 60 s (env,
  min 5 s), load attempts 3 with 1 s/2 s backoff (env), processing lease
  horizon 60 min (env).
- **Pool separation**: request pool (10, db.ts), upload-lock pool (4),
  processing-lock pool (3). Lock connections are drawn ONLY from their
  dedicated pool; a possibly-lock-owning connection is destroyed, never
  pooled, on any uncertain RELEASE_LOCK or rollback.
- **Crash before commit**: the claim+enqueue transaction rolls back; the
  video stays `uploading` and the upload remains retryable.
- **Crash after commit**: the committed row is `pending`; the next sweep
  consumes it through the protected path exactly once.
- **Crash between claim and lock**: the row is fresh `processing`; the
  loader excludes it until the lease horizon, then takeover runs after the
  lock proves the claimant gone.
- **Lost lock (holder died mid-run)**: the session death frees the lock;
  the row is stale `processing`; the next sweep takes over. A dead holder
  never deadlocks recovery.
- **Processing failure**: video `failed` (processVideo) + queue row
  `failed` with the error message — settled consistently. Automatic retry
  is deliberately NOT done: the schema has no attempts counter (see
  blockers). Admin/retry routes re-open the row explicitly.

## 4. Tests (hermetic; no DB/MinIO/network/Docker)

`server/tests/m1-video-processing-recovery.test.ts` — 41 tests:
competing workers (exactly one run), same-process contention, released and
lost locks, RELEASE_LOCK-failure destruction, claim/lock crash-window
takeover, loader staleness predicates, ownership mismatch and null-tenant
denial, ready/failed/uploading replay guards, settle failure containment,
claim failure containment, saturation-bounded sweep, load-failure
containment, retry with backoff (1000/2000 ms) and persistent-failure
surface, consumer cadence (immediate + interval + stop), configuration
defaults/env sanitization, e2e commit→crash→replay (processor runs exactly
once), enqueue-failure rollback, startup unification statics (no direct
`processVideo` in `index.ts`, exactly one production invocation site,
single consumer), lock-manager deny path, and the upload size/authority
compact set.

`server/tests/m1-upload-contract.test.ts` — 93 tests (was 90): updated the
loader/wiring assertions to the unified design (exact tenant matching,
stale takeover, dedicated processing-lock pool, consumer cadence, admin
recovery never touching live uploads, shutdown closing both pools).

### Evidence (this machine, this branch)

- Full server suite from `server/` (documented working dir): **377/377
  pass, 0 fail**.
- Isolated: `m1-video-processing-recovery.test.ts` 41/41;
  `m1-upload-contract.test.ts` 93/93.
- Root-run full suite: 373/377 — the 4 failures are the pre-existing
  `p0-checklist.test.ts` `process.cwd()` ENOENT failures (pass 5/5–9/9 when
  run from `server/`); out of scope and deliberately not repaired.
- `server && tsc --noEmit`: exit 0.
- Strict manual check of both touched test files (with
  `src/types/ffprobe-static.d.ts`): clean except pre-existing
  `noUnusedLocals` findings in untouched `src/` symbols
  (`initializeBuckets`, `localIp`, …) — pre-existing, not introduced here.
- No frontend files changed this task; no frontend type/build check
  required.

## 5. Blockers / live-verification gaps (honest)

1. **No live MySQL verification.** All execution is unit/static against
   injected adapters and recording executors. Real cross-process exclusion
   (two server processes contending `GET_LOCK`), the
   `DATE_SUB(NOW(), INTERVAL ? MINUTE)` prepared-statement behavior on the
   target MySQL version, the processing-lock pool under load, and
   shutdown drain timing remain unverified against a real database.
2. **No durable retry counter.** `video_processing_queue` has no
   attempts/retry column; automatic re-runs of failed processing are
   therefore NOT performed (bounded by zero auto-retries; explicit
   admin/retry re-open only). A durable `attempts` column would be the
   schema addition to authorize bounded automatic retries — reported as a
   missing-schema request, not invented.
3. **Lease horizon is a pre-filter, not a lease.** True fencing would need
   a lease table with fencing tokens; the named lock plus staleness
   horizon is the safe modeling possible with the existing schema. The
   lock check stays authoritative before every takeover.
4. **Clock assumption.** Staleness uses the DB clock (`NOW()`), not the
   app clock — safe under app/DB clock skew.
5. **Live MinIO/ffmpeg pipeline** unchanged and unverified this task.
