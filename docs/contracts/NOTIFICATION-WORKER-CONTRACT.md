# Notification outbox worker — state, lease, result and startup contract

Status: implemented source contract (B2-W9, 2026-10-21). Owners:
`server/src/services/notification-worker.ts` (lifecycle + send-time authority),
`server/src/services/notification-outbox.ts` (claim / dispatch / retry / dedupe /
receipt), `server/src/services/delivery-channels.ts` (adapters, readiness,
contact resolution, redaction). No migration, DDL, provider, secret or runtime
wiring is part of this contract.

This document is the acceptance reference for the worker. It describes what the
code does today; it does not claim a live provider send, a durable exactly-once
delivery, or that startup/shutdown is mounted (that is I1, §9).

## 1. Scope and non-goals

The worker is the only component that turns due `notification_outbox` rows into
adapter sends. It adds **no second state machine**: claiming, consent re-check,
retry/backoff, dedupe and receipt writing stay in
`services/notification-outbox.ts`, and the worker calls those primitives.

Guaranteed:

- importing `notification-worker.ts` performs no I/O, starts no timer, sends
  nothing;
- one worker serves exactly one tenant, declared at construction;
- a channel with no ready adapter is never claimed;
- a row is never delivered to a contact resolved for a different purpose;
- consent (including STOP / unsubscribe) is re-read from the current ledger
  immediately before the adapter is reachable;
- an ambiguous provider result is quarantined, never retried as definitely
  unsent;
- no log line, `last_error` or receipt detail carries an email address, phone
  number, OTP, token or message body.

Not guaranteed (and not claimed anywhere in the code):

- **exactly-once external delivery.** There is no provider idempotency key, so
  the worker cannot promise it. The model is at-least-once with an explicit
  `unknown` quarantine (§5).
- that a `sent` result means the recipient received the message. It means the
  provider accepted it and returned an external id.
- that `stop()` makes in-flight work disappear. It bounds the wait and reports
  what is still running (§8).
- any SMS/email provider selection, certificate or credential handling.

## 2. Components and seams

| seam | type | production | test |
|---|---|---|---|
| `db` | `NotificationDataAccess` (query / queryOne / execute) | `server/src/db.ts` helpers injected by the caller | recording in-memory outbox |
| `adapters` | `AdapterRegistration[]` (`adapter`, `isReady()`) | `toDeliveryAdapter(createEmailAdapter({ transport }))` etc. | recording adapter |
| `contacts` | `PurposeContactStore` | deployer-owned store, purpose-scoped | purpose-scoped fake |
| `consent` | `OutboxConsentGate` | `createConsentLedgerGate(db)` over `notification_consent_events` | recording gate |
| `linkSecret` | `string` | `resolveLinkSecret(env.NOTIFICATION_LINK_SECRET)` (fails closed < 32 bytes) | fixed test secret |
| `hmacKey` | `string` | deployer-owned key for contact refs | fixed test key |
| `scheduler` | `WorkerScheduler` (`setTimeout` / `clearTimeout`) | default timers | counting fake |
| `log` | `(entry: unknown) => void` | console / structured logger | captured array |
| `render` | `(row) => TemplateRenderResult` | `outboxRowRenderer()` | real renderer |

The worker never resolves a contact itself and never calls a provider directly:
`DeliveryAdapter.deliver` is the only external edge, and every adapter is wrapped
by the worker before it is passed to the dispatcher (§4).

## 3. Lifecycle

```ts
const worker = createNotificationWorker(deps);
worker.start();                    // owns exactly one timer
await worker.runOnce();            // one bounded pass, callable while stopped
await worker.reapStaleClaims();    // one bounded reconciliation sweep
await worker.stop();               // clears the timer, drains within a bound
worker.status();                   // { running, inFlight, lastRunAt }
```

- Construction validates nothing about the outside world and touches no
  resource. A missing/empty `scope.tenantId` is not repaired: the claim query
  fails closed and claims zero rows.
- `start()` is idempotent (`running` guard) and schedules the first tick after
  `tickMs`. Ticks never overlap: the next timer is created only after the pass
  settles, and only while `running` is still true.
- `runOnce()` is independent of `running`, is tracked as in-flight so `stop()`
  can wait for it, and never throws for a row-level failure (a row failure is a
  result, not an exception; a pass-level throw is caught in `tick`).
- `reapStaleClaims()` is a separate explicit call. The worker owns no reaper
  timer; scheduling it belongs to the caller (I1).
- Every pass is bounded: at most `batchSize` rows are claimed per pass and at
  most `concurrency` rows are dispatched at a time (chunked `Promise.all`).

Limits (clamped, never trusted from input):

| limit | default | range |
|---|---|---|
| `batchSize` | 25 | 1–100 |
| `concurrency` | 4 | 1–16 |
| `leaseMs` | 15 min | 1 min–24 h |
| `drainTimeoutMs` | 5 s | 1 ms–60 s |
| `tickMs` | 30 s | 1 s–24 h |

## 4. Send-time authority (the worker's own policy)

Applied per row, in this order, **after** the outbox has claimed the row and
**after** the outbox has re-checked consent:

1. `registration.isReady()` — false ⇒ `{ outcome: 'unavailable', reason: 'adapter-not-ready' }`
   (only reachable if readiness flips between claim and send; unready
   registrations are filtered out of the claim in the first place).
2. `resolveContactForSend(contacts, { tenantId, userId, userType, channel, purpose })`
   — purpose-scoped. Non-external channel, unknown purpose, or missing contact ⇒
   permanent `failed` before any adapter call. A throwing store ⇒
   `failed: contact-lookup-failed` (fail closed, retryable).
3. Non-email channels require `verified === true` ⇒ else permanent
   `failed: contact-not-verified`.
4. The adapter is called with the resolved contact. A **throw** from the
   adapter is mapped to `unknown` (the request may be on the wire), never to a
   retryable failure.

The bridge `toDeliveryAdapter(configured)` propagates the adapter's own
readiness reason verbatim (`readiness(): { ready: false, reason }`), so an
operator sees `no-provider-configured` rather than a generic label, and never
invents a message id: a provider `ok` without an external id becomes `unknown`.

## 5. Result taxonomy

`ChannelSendOutcome` (adapter → dispatcher) and the outbox state it produces:

| adapter outcome | meaning | outbox write | receipt | retry? |
|---|---|---|---|---|
| `sent` | provider accepted, external id present | `sent`, `delivered_at` set | `sent` + proof (`message_id`, optional `provider_status`, `contact_ref`) | no |
| `bounced` | provider reported undeliverable recipient | `bounced` (terminal) | `bounced` | no |
| `failed` (transient) | refused before acceptance, safe to retry | `pending` + `next_attempt_at` (backoff ladder 60/300/1800/7200/86400 s) | `failed` | yes, bounded |
| `failed` + `permanent` | refused, must not be retried | `failed` (terminal) | `failed` | no |
| `unknown` | **the request may or may not have been accepted** (timeout after write, transport error, accepted without receipt id) | status stays `sending`, `last_error = 'provider-outcome-unknown'` | `unknown` | **never automatically** |
| `unavailable` | nothing was transmitted (no provider configured / adapter not ready) | `pending` + `next_attempt_at`; at the attempt cap `failed` | none while retrying, `failed` at the cap | yes, bounded |

Pre-send denials and their states:

| condition | state | receipt |
|---|---|---|
| consent denied (STOP / unsubscribe / no grant) | `cancelled`, `last_error = 'consent-revoked'` | `cancelled` |
| consent ledger unreadable | `pending` + backoff (or `failed` at cap), `consent-check-failed: …` | `failed` at cap |
| render failed / unknown template event | `pending` + backoff (or `failed` at cap) | `failed` at cap |
| no adapter for the channel (direct dispatch only) | `pending` + backoff (or `failed` at cap), `no-adapter` | none |
| attempt cap already reached | `failed`, `attempt-cap-reached` | `failed` |
| tenant mismatch (`tenantScope` set) | untouched | none |
| row not `pending` (already claimed/settled) | untouched | none |

Two markers are durable and queryable, because the outbox `status` ENUM has no
`unknown` member and this batch may not author a migration:

- `provider-outcome-unknown` — quarantined ambiguous send. The row stays
  `sending` (so no dispatcher can claim it) and is resolved only by an
  authoritative late result or an operator reconciliation.
- `stale-claim-unconfirmed` — a `sending` claim outlived the lease. Written by
  `recoverStaleSendingRows`; status is deliberately **not** changed and the row
  is never re-sent by the sweep.

`unknown` is never downgraded to `failed`/`pending` by the worker, and the
dispatcher never re-claims a `sending` row.

## 6. Lease and fencing

A claim is a lease, not a promise.

1. **Claim** (conditional UPDATE, atomic in the store):
   `UPDATE notification_outbox SET status='sending', attempts=attempts+1
    WHERE id=? AND status='pending' AND next_attempt_at<=? [AND tenant_id=?]`
   `affectedRows = 0` ⇒ the row was already claimed or is not due; the
   dispatcher returns `skipped` and calls no adapter.
2. **Fence value.** The claim is the only writer that increments `attempts`, so
   `attempts_fetched + 1` is exactly the value the claim produced. That number
   is the dispatcher's fencing token for the rest of the attempt.
3. **Fenced state write.** Every subsequent state write carries the predicate:
   `UPDATE … SET status=? … WHERE id=? AND status='sending' AND attempts=?`
   Predicate and write are evaluated atomically by the store. A dispatcher whose
   claim was superseded (row re-claimed after a quarantine reset, or any later
   attempt) writes nothing.
4. **Rejected transition is visible, not silent.** A rejected terminal write is
   logged as `outcome: 'skipped', reason: 'state-transition-rejected'`. The
   adapter receipt is still written: the external send really happened, and
   losing that evidence would hide a real delivery. The dispatcher's returned
   outcome describes the **external** result (`sent`), not the (rejected) state
   write.
5. **No age-based steal.** `reapStaleClaims()` / `recoverStaleSendingRows()`
   only *flags* (`stale-claim-unconfirmed`) and reports `blocked[]`. It never
   changes `status`, never consumes an attempt, never calls an adapter. Age
   alone is never sufficient authority to take a row.
6. **Bounded sweep flag.** The flag itself is a compare-and-set on `last_error`
   that skips rows already carrying `stale-claim-unconfirmed` or
   `provider-outcome-unknown`, so concurrent sweeps record one flag per claim.

The sweep's clock is `updated_at`, which is
`TIMESTAMP(3) … ON UPDATE CURRENT_TIMESTAMP(3)` in
`server/migrations/20261018_14_notification_outbox_consent.sql`, so the claim
UPDATE (and the quarantine write) refresh it without the code setting it
explicitly. A quarantined row is therefore old enough to be selected by a later
sweep but is excluded by the marker predicate — it is never re-flagged or
re-sent.

The fence is enforced by the store (single conditional statement), not by an
in-process counter: an `attempts` check in JavaScript alone would be a placebo.

## 7. Tenancy, principal and consent

- **Tenant.** One worker per tenant, declared at construction. The claim SQL
  binds `tenant_id = ?` (never a post-filter), the dispatch fetch binds
  `id = ? AND tenant_id = ?`, and the claim UPDATE binds `tenant_id = ?` again.
  A foreign row is reported as `skipped: tenant-mismatch`, never read into a
  dispatch decision. An empty tenant claims nothing.
- **Principal.** Recipient identity is the row's server-written
  `recipient_user_id` / `recipient_user_type`; nothing on the send path accepts a
  client-supplied recipient, channel or purpose.
- **Consent.** `createConsentLedgerGate(db).canDeliver` performs a fresh
  `notification_consent_events` read (latest `seq` wins) on **every** dispatch,
  before render and before the adapter. Semantics are the existing ones and are
  unchanged by this batch: no event ⇒ quiet default (in-app only, external
  denied); any `revoke` — including `stop_message` and `unsubscribe_link` —
  denies. The ledger-vs-preferences split is untouched: the outbox uses the
  consent ledger, the in-app feed routes use `notification-preferences`.
- **Contact authority.** `PurposeContactStore.findContactForPurpose` receives the
  row's purpose and channel and must scope its answer to them; a generic "any
  contact on file" row violates this contract.

## 8. Shutdown, drain and owned handles

`stop()`:

1. sets `running = false` so no new tick is scheduled;
2. clears the single owned timer (`scheduler.clearTimeout`) and nulls the handle;
3. snapshots the in-flight set and races `Promise.allSettled(inFlight)` against
   a `drainTimeoutMs` timer (that timer's handle is cleared in every branch);
4. returns `{ drained, inFlight }` — `drained: false` means work is still
   running after the bound and the caller must treat the process as not
   quiescent.

The worker owns exactly one timer at a time and no other handle: no interval, no
listener, no socket, no child process. A tick that was already awaiting a pass
reschedules nothing once `running` is false. A `runOnce()` that outlives `stop()`
still settles and still writes its fenced state (which is safe: the fence and
the row status decide, not the worker).

## 9. I1 startup / graceful-shutdown handshake

The worker is not mounted anywhere in this batch (`server/src/index.ts` is
untouched; mounting is I1's file). I1 must do exactly this:

```
// after config validation, before listen
const linkSecret = resolveLinkSecret(process.env.NOTIFICATION_LINK_SECRET);
const worker = createNotificationWorker({
  db,                                             // existing db helpers
  scope: { tenantId: resolveTenantForProcess() }, // required, never inferred
  adapters: [
    { adapter: toDeliveryAdapter(createEmailAdapter({ transport: emailTransport })), isReady: () => emailTransport !== null },
    // sms only when its provider is actually configured; SMS stays deferred
  ],
  contacts: purposeContactStore,
  consent: createConsentLedgerGate(db),
  linkSecret,
  hmacKey: process.env.NOTIFICATION_CONTACT_HMAC_KEY,
  log: structuredLog,
});
// after the HTTP server is listening
worker.start();
// in the shutdown hook, before closing the pool
const { drained, inFlight } = await worker.stop();
```

Rules for I1:

- call `start()` only after the HTTP server listens and configuration has been
  validated; constructing the worker must never be part of module import;
- call `stop()` in the graceful-shutdown hook **before** the DB pool is closed,
  and record `drained: false` as a shutdown warning, not a success;
- schedule `reapStaleClaims()` yourself (e.g. a bounded interval or an external
  cron); the worker does not own a reaper timer;
- one worker instance per tenant; a multi-tenant process needs one worker per
  tenant, not a widened scope;
- never pass a client-supplied tenant, contact, channel or purpose;
- a channel whose transport is not configured must be registered **unready**
  (or not registered), so it is never claimed. `createEmailAdapter()` /
  `createSmsAdapter()` with no transport are safe either way: they report
  `unavailable`, never `sent`.

## 10. Redaction rules

Every adapter reason, provider error, `last_error`, receipt detail and log line
passes through `redactPiiText` (single redaction point in
`delivery-channels.ts`), which:

- masks email addresses (`••••••`);
- masks credentials in `key=value` / `key: value` form, keeping the key name
  (`token=••••••`), for `token|otp|passcode|password|secret|pin|api_key|
  access_token|refresh_token|authorization|bearer`;
- masks `Bearer <credential>`;
- masks double-quoted fragments — providers echo the rendered body inside
  quotes, and a message body must never be loggable;
- masks digit runs of 6+ characters (phones, OTPs, national ids, card fragments);
- collapses whitespace and truncates to 200 characters.

Additionally:

- contacts are recorded only as `ref:<hmac-sha256-24>` or `last-4` masks;
- receipt `proof` is filtered by `sanitizeProof` (PII-shaped keys dropped;
  only `message_id`, `msgid`, `provider_status` and non-PII scalars survive);
- the message body and HTML never enter a log, a receipt detail or `last_error`;
- the worker's own reasons are fixed codes (`adapter-not-ready`,
  `contact-missing`, `contact-not-verified`, `contact-lookup-failed`,
  `adapter-transport-error`, `state-transition-rejected`, …).

Trade-off: redaction is intentionally lossy. A quoted diagnostic fragment is
masked even when benign, and an adapter that embeds free text without quotes can
still reduce operator detail. Adapters must not put the body, contact or
credentials into a reason in the first place; redaction is defence in depth.

## 11. Producer wiring

`server/src/routes/notifications.ts` is unchanged in this batch and needs no
change: it is the in-app feed / preferences / unread-count API, not an outbox
producer, and there is no authority contract that would let a client enqueue an
arbitrary notification to an arbitrary recipient. Adding such an endpoint
without a per-domain authority check would create exactly the spoofing surface
the consent ledger exists to prevent.

Producers in other domains (assignments, attendance, billing, progress) must
call `enqueueOutboxRow` from their own service through the documented hooks
contract, with a server-derived tenant and recipient. They are not edited here.

## 12. Known limitations

1. **No provider.** Nothing in this batch can prove a real send, a real receipt
   id, a real timeout or a real bounce. Every provider statement here is proven
   against a recording transport only.
2. **No `unknown` status.** The outbox ENUM has no member for it; quarantine is
   `status='sending'` plus `last_error='provider-outcome-unknown'`. A dedicated
   status needs a migration owned by another lane.
3. **Reconciliation is manual.** There is no provider-status poller and no
   operator tool in this batch; a quarantined row stays quarantined until an
   authoritative result or a human resolves it.
4. **Single tenant per worker.** No cross-tenant pass, by design; a deployment
   with many tenants needs many workers.
5. **No reaper timer.** `reapStaleClaims()` must be scheduled by I1.
6. **`stop()` can time out.** A slow adapter keeps a promise alive past
   `drainTimeoutMs`; the worker reports `drained: false` rather than killing it.
7. **Consent read is per row, not transactional with the send.** A STOP that
   lands between the consent read and the adapter call is not observed by that
   attempt. The window is one adapter call; closing it would require a
   provider-side idempotency key or a consent version fence in the store.
