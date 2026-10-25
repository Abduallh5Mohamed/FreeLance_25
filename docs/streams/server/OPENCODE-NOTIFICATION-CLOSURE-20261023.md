# OpenCode notification lane closures — outbox → claim → worker → dispatch recovery (2026-10-24 batch, doc path dated 2026-10-23)

Lane: OpenCode. Governing docs: `TWO-ACTIVE-LANES-FINAL-SOURCE-CLOSURE-20261023.md`,
`docs/streams/server/THREE-LANE-FILE-OWNERSHIP-20261022.json` (notification group owner
`opencode`). Evidence: the batch tooling REFUSED writes to
`C:/Users/abdua/opencode-reports/20261024-dual-lane/glm-handoff.md` (both `write` and `edit`
denied by the session permission set), so the full handoff content was delivered to the
supervisor in the lane's transcript instead of that file. The supervisor should persist it there.
SHA256 of changed sources is computed by the supervisor, not by this lane — no shell was used.

This is a source-closure progress record, not final acceptance. Nothing executable was run:
no compiler, no tests, no SQL, no provider, no service, no Git mutation.

## Scope of this record

Writable paths of this batch (all opencode-owned in the ownership registry):
- `server/src/services/notification-outbox.ts` (edited)
- `server/src/services/notification-worker.ts` (edited)
- `server/src/services/notification-runtime-factory.ts` (created; path registered to opencode
  under "Four-lane notification source closure 2026-10-23", absent on disk before this batch)
- `server/src/services/notification-dispatch-recovery.ts` (created; same registration basis)
- this doc (created)

Read-only references used: `notification-consent.ts`, `notification-preferences.ts`,
`delivery-channels.ts`, `routes/notifications.ts`, `routes/ops.ts`, migration
`20261018_14_notification_outbox_consent.sql`, `docs/contracts/NOTIFICATION-WORKER-CONTRACT.md`,
and the sibling composition pattern in `live-runtime-factory.ts` (workbuddy-owned; not edited).

## Defects found and fixed (before → after)

### 1. Parent-report rows could never enqueue with realistic identifiers (outbox)

- **Before:** `enqueueParentReportDelivery` built its idempotency key as a plain-text join
  `parent-report:{tenantId}:{parentUserId}:{studentEnrollmentId}:{period}:{channel}{suffix}`.
  With CHAR(36) identifiers and a common period this measures ~138–190 characters, past the
  module's own `validateEnqueueInput` cap (120) and the `idempotency_key` VARCHAR(160) column:
  `enqueueOutboxRow` returned `{ ok: false, error: 'idempotencyKey must be 1-120 characters' }`
  and the caller reported `validation-failed` before any row was written. Every realistic
  parent report was refused.
- **After:** the key is a bounded sha256 digest of the same components
  (`parent-report:` + 40 hex = 54 chars), mirroring the existing `producerIdempotencyKey`
  pattern. Idempotency semantics are unchanged (same components ⇒ same key ⇒ duplicate collapse;
  the suffix is hashed, not appended). Observed trace stays `ok: true | duplicate` for inputs
  that previously refused.

### 2. Stale-claim sweep could starve behind a flagged backlog; no tenant bound (outbox)

- **Before:** `recoverStaleSendingRows` selected `WHERE status='sending' AND updated_at <= ?`
  ordered oldest-first, then relied on a `last_error` CAS to avoid re-flagging. Because a
  quarantined row stays `sending` until an operator resolves it, a backlog of flagged rows
  larger than `limit` (default 25) filled every sweep page: `alreadyFlagged` grew forever and
  newer abandoned claims behind the page never got flagged — the bounded-scan/no-cursor
  starvation shape. The sweep was also whole-table, while the worker model is one worker per
  tenant.
- **After:** the SELECT excludes rows already carrying
  `stale-claim-unconfirmed`/`provider-outcome-unknown`, so bounded pages keep making progress
  past a flagged backlog; the CAS remains for concurrent sweeps (`alreadyFlagged` still reports
  one flag per abandoned claim). An optional `tenantId` (typed filter in
  `StaleSendingRecoveryOptions`) binds the sweep in SQL. Neither change alters any result
  contract: the sweep still never re-sends, never resolves, never steals a row.

### 3. Worker reaper is now tenant-bound (worker)

`reapStaleClaims` forwards `tenantId: deps.scope.tenantId` to the sweep, matching the claim and
dispatch tenancy. Behavior difference for an operator: a worker's reaper no longer flags rows of
other tenants (which it could never claim anyway).

## New closure pieces (registered paths, previously absent on disk)

### `notification-dispatch-recovery.ts`

Composition-only operator recovery for the manual-reconciliation gap the worker contract (§12.3,
Known limitations) explicitly left open:

- `listQuarantinedOutboxRows` — bounded, keyset-paginated (`ORDER BY id ASC`, cursor
  `afterId`, `limit` clamped 1..100, page fetched as bound+1 and trimmed) enumeration of rows
  `status='sending' AND last_error IN ('provider-outcome-unknown','stale-claim-unconfirmed')`,
  tenant-predicated in SQL. Read-only; carries no contact, payload, body or recipient identity.
- `runDispatchRecoveryOnce` — one bounded pass: stale sweep (tenant-bound) plus one quarantined
  page; returns `{ stale, quarantined }` with the `nextAfterId` continuation. No timer, no
  scheduler; the caller persists the continuation.
- `reconcileQuarantinedRow` — verbatim delegation to `reconcileQuarantinedOutboxRow`, so the
  fencing (`attempts` lease), the attempt-cap refusal and receipts remain that module's single
  implementation. No path here writes `sent` without an authoritative resolution.

### `notification-runtime-factory.ts`

Composition-only environmental port (patterned on `live-runtime-factory.ts`):

- Construction is I/O-free and refuses (`invalid_deps`) placeholder or deformed dependencies:
  db requires callable `query/queryOne/execute`; contacts require a real purpose-scoped store
  (none is invented — `notification-contact-sql.ts` is registered to opencode but still absent,
  so no production contact store exists in this tree yet); tenant, link secret (≥32 bytes) and
  HMAC key (≥16 bytes) are bounded with the worker's exact `STARTUP_REASONS` codes.
- Adapters are wired through `toDeliveryAdapter`; readiness is the adapter's own signal,
  relayed conservatively (a readiness that throws or is not truth-shaped is unready, never
  ready). Duplicates by channel keep the first and are recorded in `status().channels`.
- `readiness()` re-evaluates per call: configuration (tenant/secrets/ready channels) plus schema
  state. Schema is verified ONLY via the explicit, read-only `verifyNotificationSchema`
  (`information_schema` probe of outbox/receipts/consent tables); reports are provenance-checked
  against the exact db object (WeakMap registry; a look-alike literal is refused
  `invalid_deps`); areas can be `unverified/verified/absent/unavailable/invalidated`; freshness
  is configurable downward only (default 15 min). `readiness().worker` is `'configured'` only
  when configuration is complete AND all schema areas are verified, fresh and not invalidated —
  config-without-schema is `unconfigured` with the gap named.
- `runRecoveryOnce` forwards one tenant-bound dispatch-recovery pass verbatim. The factory
  starts nothing, stops nothing, schedules nothing; `worker.start()`/`stop()` remain the
  integration owner's ordering per the worker contract §9.

## Implemented / held / not verified

- **Implemented (source only):** the two defect fixes above; tenant-bound worker reaper; the
  recovery module; the runtime factory with honest readiness. All existing public interfaces of
  the outbox and worker are preserved; both new options (`tenantId` on the sweep) are additive
  and absent elsewhere is unchanged behavior.
- **Held (fail-closed, not presented as working):** no production `PurposeContactStore`
  exists (registered `notification-contact-sql.ts` absent) — a mounted worker would fail closed
  per row with `contact-lookup-failed`… → `contact-missing` permanent failures rather than send
  to "any contact on file"; SMS/WhatsApp transports remain unconfigured
  (`createDeferredChannelAdapter` stays the exact `channel-deferred-by-owner` state); no
  `sent`/`delivered` claim exists because no provider, DB or adapter was exercised.
- **Explicitly not verified at runtime:** everything. No compiler/typecheck/test run was
  authorized; the "unproven at runtime" headers in both new files state this.

## Remaining cross-owner requests (exact)

1. **To the delivery-channels owner surface (opencode; not writable in this batch):**
   `sendThroughTransport` (delivery-channels.ts) permanently refuses an empty `templateId`
   (`template-not-approved`, permanent). Outbox rows produced by `enqueueParentReportDelivery`
   and `enqueueAcademicEventNotification` never set `template_id` — their rendered bodies are
   complete store-side (20261018_14 template columns verify) — so an email channel wired via
   this adapter chain terminally fails these rows at the first send attempt. Request: settle the
   email template policy (either template rows always carry an approved provider template id, or
   `sendThroughTransport` accepts a store-rendered body for `email` only), then I1 wiring must
   match. Until settled, any mounted email worker will truthfully fail such rows as
   `template-not-approved`.
2. **To Codex (integration/index and shared ownership — server/src/index.ts, readiness mounts):**
   the worker and runtime factory are still never mounted; `createNotificationRuntime` +
   `resolveNotificationWorkerStartup` + the §9 ordering (construct after config validation,
   `start()` after the HTTP server listens, `stop()` before the pool close, reaper scheduled by
   the host or an operator cron) need an authorized integration batch. No readiness probe was
   edited here; `routes/ops.ts` was only read.
3. **To the WorkBuddy test owner (tests own their listed owner: m6-notification-*.test.ts,
   m1-sprint-notification-support.test.ts belong to workbuddy):** reviewer heads-up —
   the parent-report idempotency key format changed from plaintext-join to
   `parent-report:`+sha256(40 hex); if a test asserts the old plaintext format or asserts a
   120-char refusal for a *typical* parent report, that assertion encoded the defect fixed
   above. No test file was read or edited by this batch.

## Honest residual model

The outbox → claim → worker chain keeps at-least-once delivery with explicit `unknown`
quarantine, fenced claims (`status='sending' AND attempts=?`), consent re-checked at send time,
STOP honored immediately, receipts deduped from truth (no fabricated delivered audit when no
provider was called). There is still no exactly-once external delivery promise, no provider
idempotency key, no automatic reconciliation poller, and no `sent` without a provider receipt id.
