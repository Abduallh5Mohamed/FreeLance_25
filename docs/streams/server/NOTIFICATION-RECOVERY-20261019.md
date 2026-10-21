# Notification outbox — claim/sending recovery hardening (2026-10-19)

Task: `server-notification-recovery-hardening-20261019-01`
Branch: `codex/workbuddy-server`
Scope written: `server/src/services/notification-outbox.ts`,
`server/tests/m6-notification-outbox.test.ts`, this document.

No schema change, no migration, no provider change, no scheduler start, no real
message, no network. All behaviour below is proven by injected fakes.

## 1. Defects proven from source

### D1 — terminal transition wrote NULL into a `NOT NULL` column (row wedged after a real send)

`finishRow` issued `next_attempt_at = ?` with `null` for every terminal state
(`sent`, `failed`, `bounced`, `cancelled`), while migration
`20261018_14_notification_outbox_consent.sql:87` declares
`next_attempt_at TIMESTAMP(3) NOT NULL`.

Consequence on a strict MySQL server (`STRICT_TRANS_TABLES`, the MySQL 8
default; `server/src/db.ts` does not relax `sql_mode`): the UPDATE that records
a successful send is rejected **after** `adapter.deliver` already handed the
message to the provider. The row therefore stays in `sending` forever:
`claimDueOutboxIds` only selects `pending`, and `dispatchOutboxRow` skips
non-pending rows. The delivery happened, the database says it did not, and
nothing surfaces the divergence. In non-strict mode the same statement stores a
zero date, corrupting the retry schedule.

The old test fake hid this by writing `nextAttemptAt ?? row.next_attempt_at`,
i.e. it silently coalesced the `NULL` the production code sent.

Reproduction: the fake now enforces the real column contract and throws
`Column 'next_attempt_at' cannot be null`; 10 pre-existing tests failed on the
unmodified source before the fix.

### D2 — no recovery for an abandoned `sending` claim

A crash between the claim UPDATE (`pending → sending`, `attempts + 1`) and the
terminal write left the row permanently `sending` with no marker, no log and no
query that would reveal it. Same shape for a lost adapter response: the
provider may have accepted the message and the process died before recording
it.

### D3 — pre-adapter failures wedged the claim

A throwing consent gate or a throwing `render` propagated out of
`dispatchOutboxRow` while the row was already claimed, leaving it `sending`
with no attempt release. Both failures happen strictly before the adapter, so
they have no external effect and are safe to retry.

### D4 — a failed receipt insert could mask a successful delivery

`writeReceipt` was awaited unguarded after the terminal state write. A receipt
store outage rethrew to the dispatcher loop while the row was already `sent`;
the caller sees "not delivered" for a delivered message.

## 2. Behaviour after the change

| Case | Before | After |
| --- | --- | --- |
| Successful send | UPDATE rejected (strict) → row stuck `sending` | `sent` + `delivered_at` + one receipt; `next_attempt_at` keeps its last value |
| Failed/bounced/cancelled | same NULL write | terminal state persisted normally |
| Consent ledger throws | row stuck `sending`, exception escapes | row released to `pending` with bounded backoff (`consent-check-failed`), adapter never called |
| Render throws | row stuck `sending`, exception escapes | row released to `pending` with bounded backoff (`render-failed`) |
| Receipt INSERT throws | exception escapes, row already terminal | terminal state kept, one sanitized `receipt-persist-failed` log line, no resend |
| Crash after claim | invisible, permanent | `recoverStaleSendingRows` flags it once (`last_error = 'stale-claim-unconfirmed'`), status untouched |
| Slow adapter, lease expired | n/a | flagged, then the real result still lands and clears the flag |
| Two dispatchers | claim race already correct | unchanged (conditional UPDATE) and now covered by a test |

`finishRow` uses `next_attempt_at = COALESCE(?, next_attempt_at)`, so a terminal
state keeps the last scheduled time instead of writing `NULL`.

## 3. Stale-claim recovery model

`recoverStaleSendingRows(db, { olderThanMs?, limit?, now?, log? })`:

1. Selects `status = 'sending' AND updated_at <= now - lease` (bounded
   `LIMIT`). `updated_at` is bumped by the claim UPDATE, so it is the claim
   timestamp; the lease defaults to 15 minutes and is clamped to 60s..24h.
2. Compare-and-set on `last_error`: only the sweep that flips the row from
   "not marked" to `stale-claim-unconfirmed` records a flag. Concurrent sweeps
   (or a sweep after a restart) produce exactly one flag per claim; the rest
   report `alreadyFlagged`.
3. Emits one sanitized alert per newly flagged row (id, channel, event type,
   attempts — no contact, no body).

It deliberately does **not**:

- change `status` (so the row stays unclaimable — no blind resend),
- write a delivery receipt (an unknown outcome is not a delivery result),
- mark the row `sent` or `failed` (that would invent an outcome).

A dispatcher that is merely slow is not harmed: `finishRow` still matches
`WHERE id = ? AND status = 'sending'`, so the late authoritative result is
applied and clears the marker. A crashed dispatcher leaves the marker, which is
queryable, durable across restarts and blocks silent wedging.

## 4. Existing controls verified (unchanged)

- **Provider idempotency keys: absent.** `ChannelSendRequest`
  (`server/src/services/delivery-channels.ts:20`) carries
  `{ contact, locale, templateId, bodyText }` — the outbox
  `idempotency_key` is internal and never reaches an adapter. This is why
  recovery must not retry an unknown outcome; see §5.
- **Receipt dedupe: behavioural only.** `notification_delivery_receipts` has no
  unique key on `(outbox_id, outcome)`; dedupe comes from the conditional
  claim, so exactly one adapter call and one receipt per claimed attempt.
- **Consent re-check at the send point** happens after the claim and before the
  adapter; a revoke cancels the row without adapter contact.
- **Bounded backoff** is unchanged (`60s → 300s → 1800s → 7200s → 86400s`,
  capped by `max_attempts`).
- **No PII** in logs/receipts: every new log line goes through
  `sanitizeDeliveryLog` / `redactPiiText`, and the recovery alert carries no
  contact or body.

## 5. Residual gaps (not fixable inside the approved scope)

1. **No provider idempotency key.** Until `ChannelSendRequest` carries an
   outbox-scoped key that the provider dedupes on, an abandoned `sending` row
   cannot be retried automatically without risking a duplicate external
   message. Requires a provider/interface change outside this task.
2. **No `unknown`/`reconcile` status.** The status ENUM
   (`pending|sending|sent|failed|bounced|cancelled`) has no state for "sent or
   not, unknown". Rows are therefore left in `sending` with the
   `stale-claim-unconfirmed` marker in `last_error` (VARCHAR(500)) instead of a
   dedicated terminal state. A migration adding e.g. `reconcile_required` plus
   `claimed_at`/`claim_token` columns would be the clean fix.
3. **No claim fencing token.** Because recovery never returns a row to
   `pending`, `status = 'sending'` remains a sufficient fence. If a future
   change allows releasing stale claims, a `claim_token`/`attempts` fence is
   required so a superseded dispatcher cannot overwrite a newer claim.
4. **No operator resolution path.** Reconciling a flagged row (mark sent with
   provider proof, or re-queue after confirming non-delivery) is a manual
   operation today; it needs an authenticated ops surface, which is outside
   this file.
5. **No scheduler wiring.** `dispatchOutboxRow` / `claimDueOutboxIds` /
   `recoverStaleSendingRows` have no caller in `server/src` yet; a dispatcher
   tick should call recovery before claiming due rows. Starting it was
   explicitly out of scope.

## 6. Tests added (all in `server/tests/m6-notification-outbox.test.ts`)

| Test | Covers |
| --- | --- |
| `two dispatchers racing one row: exactly one claim wins, one send and one receipt` | two dispatchers, gated pre-claim read, single adapter call, single receipt, NOT NULL `next_attempt_at` preserved |
| `a crash after the claim leaves the row in sending; recovery flags it and never resends` | crash after claim, flag written, status untouched, no adapter recall, no invented receipt, row still unclaimable |
| `a stale flag does not steal a delayed in-flight adapter result` | delayed stale result: flag, then the late result lands once and clears the marker |
| `a failed receipt insert keeps the terminal sent state and never resends` | failed receipt persistence: terminal truth kept, sanitized alert, no second send |
| `a consent ledger failure releases the claim for a bounded retry and never calls the adapter` | revoked/unreadable consent at the send point, bounded backoff, no adapter contact |
| `concurrent recovery sweeps flag a stale row once and preserve the claim` | idempotent repeated recovery (one flag, one alert), repeated dispatch still skipped |
| `recovery ignores fresh claims and clamps an unsafe lease` | lease lower bound, fresh claim untouched |
| existing sent/failed/bounced/cancelled tests | now run against a fake that enforces `next_attempt_at NOT NULL` |

Positive path is exercised with injected fake adapters only; no real message
was sent.

## 7. Verification

```
cd "C:/Users/abdua/OneDrive/سطح المكتب/FreeLance_25-1"
M1_NETWORK_MODE=hermetic node --require ./scripts/m1-network-guard.cjs --import tsx \
  --test server/tests/m6-notification-outbox.test.ts
```

Before the fix: 10 failures (`Column 'next_attempt_at' cannot be null`,
`recoverStaleSendingRows is not a function`, consent throw escaping).
After: 32 tests, 32 pass, 0 fail.

Full-suite and typecheck results are recorded in the task report; unrelated
failures belong to sibling workers editing other files in the same tree.
