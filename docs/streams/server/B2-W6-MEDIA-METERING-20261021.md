# B2-W6 — media storage/watch metering and reconciliation

Task `server-b2-w6-metering-recovery-20261021-01` · team `media` · branch `codex/workbuddy-server`
Recovery + independent audit of the work left on disk by the worker that died on the transport 502 at
2026-10-21 20:36. Controlling scope: `docs/streams/server/BATCH2-IMPLEMENTATION-SCOPE-20261021.md` § B2-W6.

Status: **reported, not accepted.** No external operation was performed. Nothing here closes a milestone.

---

## (A) Inherited state I verified

All eight inherited paths were hashed before any edit and matched
`C:/Users/abdua/WorkBuddySupervisorBridge/handoff/WORKBUDDY-B2-RECOVERY-BASELINE-20261021.md` § B2-W6
exactly. I did not author these bytes; I inherited, read and audited them.

| path | inherited sha256 | bytes | verdict |
|---|---|---|---|
| `server/src/services/video-usage-events.ts` | `4c6316cb7b0c185b109e26cb89921ab285e2547826dd96a1305f34e9926cebe2` | 19626 | inherited, **unchanged by me** |
| `server/src/services/playback-progress.ts` | `96c7fe7b76309d6452d96fcf40c3b6a51159f4d5516f6a2abaecffe1a86c129d` | 23789 | inherited, **untouched** (see A.6) |
| `server/src/services/video-asset-lifecycle.ts` | `e54805212b13583fd1ce455cc860b3aca463477e1fe5c80e7b85327fa504d377` | 29174 | inherited, extended by me |
| `server/src/routes/video-assets.ts` | `61b08203cb811b0130027b3a1e3c2027ea7dfdd6a2f9ccf1c91c62e09485ec90` | 35363 | inherited, extended by me |
| `server/src/services/media-usage-reconciliation.ts` | `a4d7408d30e86047a2d0e07f47fd1f5940d2b899be621d1000a62cdd25a9b252` | 26490 | inherited (new file), extended by me |
| `server/tests/media-usage-reconciliation.test.ts` | `1daa491e05cb51956c81191432d92234bee2f155067c8c59048f2182fa5f756c` | 9762 | inherited, extended by me |
| `server/tests/video-usage-storage.test.ts` | `8bfe3afdb2e7023c23a62f6ff7a96249f081c0fd3f71a7b0253fbb01ee2bdd8e` | 21779 | inherited, extended by me |
| `server/tests/video-usage-replay.test.ts` | `8ec9f7e1640cd5dc23885a960fc2d3e0c0176b57ed039f348e4f91630dcd0d0c` | 9569 | inherited, **unchanged by me** |
| `docs/streams/server/B2-W6-MEDIA-METERING-20261021.md` | absent | – | created by me (this file) |

`git diff HEAD` shows only three modified tracked files in my scope
(`video-asset-lifecycle.ts`, `routes/video-assets.ts`, `video-usage-events.ts`) plus four untracked new
files. Of those, `video-usage-events.ts` was modified by the *dead* worker, not by me — its hash is
byte-identical to the inherited baseline, so my delta to it is zero.

### A.1 What the inherited code does

**`video-usage-events.ts` (V8 observation ledger).** Two event families in one append-only table:
`kind='watch'` (seconds) and `kind='storage'` (bytes). Tenant is always a server-derived input. The
ledger's `UNIQUE(tenant_id, dedupe_key)` is the replay guard: `insertEvent` returns `false` on
`ER_DUP_ENTRY` and the service reports `deduplicated: true`. Watch heartbeats get a deterministic
dedupe key `hb:{sessionId}:{floor(now/window)}` and the delta is clamped to one window
(`clampHeartbeatSeconds`), so a client-chosen large delta cannot inflate the aggregate; a per-enrollment
rate limit and aggregate cap (`heartbeatLimit`) bound a burst of session ids. `listEvents` +
`rebuildWatchSeconds` were added so the aggregate can be recomputed from rows.

**`media-usage-reconciliation.ts` (per-asset storage meter).** A second, separate ledger of *transitions*
(`upload | replace | delete | retry`) keyed by `st:{assetId}:{operationId}` (sha256-shortened if > 200
chars). `rebuildStorageTotals` is pure and folds the transitions in canonical
`(occurredAtMs, idempotencyKey)` order: `upload`/`replace` set an absolute size, `delete` forces 0,
`retry` carries the previous size forward. Because every value is absolute or zero, a shuffled delivery
converges on the same final number and no prefix can go negative. `recordVerifiedBytes` derives
`upload` on the first event for an asset and `replace` afterwards, so a replacement contributes
`new − previous` (a delta), never a second full amount. Ownership is resolved from server rows
(`findAssetTenant`) before any write. `reconcileStorageUsage` compares the materialized counter with the
rebuild and returns `mutated: false` — it never writes.

**`video-asset-lifecycle.ts`.** `uploaded → processing → ready | failed`, `failed → processing` bounded
by attempts, dead-letter on exhaustion. Callbacks are signature-verified first, tenant-checked against
the stored row second, deduped through `video_asset_callbacks UNIQUE(provider, callback_id)` third, and
transition legality fourth. The dead worker added a `meterStorage` port invoked only on a verified
`ready` callback that carries `storage_bytes` from the signed payload.

**`routes/video-assets.ts`.** Thin deny-by-default router; mounted at `/api/video-assets`
(`server/src/index.ts:257`). Provider callbacks are unauthenticated but signature-gated through injected
verifiers. The default export composes the lifecycle, entitlement and usage services over `lazyDb`.

### A.2 Acceptance matrix (audited against the source, not against the green tests)

| # | Acceptance item | Verdict | Where / why |
|---|---|---|---|
| 1 | Storage byte meter per asset from server- or provider-verified data only | **implemented** | `normalizeEvidenceSource` (`media-usage-reconciliation.ts:152`) accepts only `provider-callback` / `server-measured`; `applyProviderCallback` verifies the signature before the meter is reachable (`video-asset-lifecycle.ts:403-421`) |
| 2 | Observed object metadata is not live provider proof | **implemented** | `object-metadata-observed` is a named rejection, not a fallback (`media-usage-reconciliation.ts:154`, error `metadataObservation`) |
| 3 | No client-supplied numbers anywhere | **implemented (gap closed by me)** | The lifecycle forwards only the signed `storage_bytes`. `POST /usage/provider` previously signed only `provider/event_id/tenant_id/kind`, so a captured signature could carry a rewritten count — see B.3 |
| 4 | Idempotent `upload`/`replace`/`delete`/`retry`; replay counts once | **implemented** | unique `(tenant, idempotency_key)` in the store port; `insertEvent → false` short-circuits to `deduplicated` before any counter write |
| 5 | Replacement applies a **delta**, not a second full amount | **implemented** | absolute snapshot folded in canonical order; `bytesDelta = next − previous` (`media-usage-reconciliation.ts:320` inside the fold at `:295-323`; append-path delta at `:512`) |
| 6 | Delete cannot drive a counter negative; a second delete is idempotent | **implemented** | `delete` forces `next = 0`; the append path also floors with `Math.max(0, …)`; the same operation id is absorbed by the key, a distinct one applies delta 0 |
| 7 | Storage and watch are separate units, never mixed with a student count | **implemented** | two ledgers, `USAGE_UNITS` / `unitForUsageKind`; no student-count field in the meter or the report (grep for `studentCount|student_count` in the four sources: none) |
| 8 | Cumulative counters rebuildable from recorded events | **implemented (storage) / not applicable (watch)** | `rebuildStorageTotals` is pure and total-ordered; watch has no *separate* materialized counter — `sumWatchSeconds` **is** the aggregate, so a rebuild can only disagree with itself. Equality of aggregate and rebuild is asserted in `video-usage-replay.test.ts` |
| 9 | Reconciliation detects and reports a **scoped** discrepancy without silently overwriting | **implemented (gap closed by me)** | report is per-tenant or per-asset, `mutated: false`; a tenant-scoped pass also compares every asset counter because opposite drifts can cancel. An empty scope no longer raises a phantom `counter-missing` — see B.1 |
| 10 | Events bound to existing lifecycle boundaries, stable tenant/principal context | **implemented** | metering happens inside `applyProviderCallback` at the `ready` boundary; tenant is `asset.tenantId` (server row), never the payload |
| 11 | Foreign or unprovable tenant events rejected, not attributed | **implemented** | callback `tenant_id` that disagrees with the row → `rejected/cross-tenant` before the callback ledger; the meter independently re-checks `findAssetTenant` → `tenantMismatch`; `rebuildStorageTotals` filters by tenant again |
| 12 | Failure atomicity explicit, or an outbox contract without a notification dependency | **partial — explicit, not atomic** | the asset state commit precedes metering; a meter failure yields `metering: 'deferred'` + audit and is *not* rolled back. No retry/outbox exists (I2-4). No notification module is imported |
| 13 | No money, no subscription, no charge logic | **implemented (absence verified)** | grep for `price|amount|charge|invoice|subscri|payment|currency|decimal|wallet|balance` over the four sources returns only the comment that says there is none |
| 14 | **Wired into a real production module** | **missing — and now audited instead of silent** | `createVideoAssetLifecycle` is composed exactly once, at `routes/video-assets.ts:692`, **without** `meterStorage`. `createMediaMeteringService` / `reconcileStorageUsage` have **zero** production call sites. See A.3 |

### A.3 The wiring question (the thing green tests cannot show)

The router is live (`server/src/index.ts:257`), so `POST /api/video-assets/callbacks/:provider` is a real
production path. Its composition is:

```ts
lifecycle: createVideoAssetLifecycle({
    store: createSqlVideoAssetStore(lazyDb),
    verifyCallbackSignature: verifyProviderCallbackFromEnv,
}),            // ← no meterStorage
```

Therefore, before my change, a verified `ready` callback carrying `storage_bytes` **committed the asset
state and silently dropped the bytes**: the metering branch was guarded by `&& deps.meterStorage`, and
`media-usage-reconciliation.ts` is imported by nothing but tests. The 32 green tests passed because they
inject `meterStorage: meter.service` themselves — a composition production does not have.

I did **not** wire the in-memory adapter into production, and I did not fabricate a durable store. Reason,
precisely:

- There is no transition/counter table. `server/migrations/20261018_06_video_assets_entitlements.sql`
  defines `video_usage_events` as `id, tenant_id, asset_id, kind ENUM('watch','storage'), watch_seconds,
  storage_bytes BIGINT, dedupe_key VARCHAR(200), session_id, student_enrollment_id, source,
  occurred_at, created_at` with `UNIQUE(tenant_id, dedupe_key)`. It has **no transition discriminator**.
- Overloading that table is not neutral: `GET /usage/summary` returns `usage.storageBytes(tenantId)` =
  `SUM(storage_bytes)` over the tenant. Writing absolute transition snapshots into the same table would
  (a) invent column semantics and (b) corrupt that sum — a 1000-byte asset replaced by 600 would report
  1600. `delete`/`retry` cannot be distinguished from a `replace` without a new column.
- An in-memory adapter in production would return `recorded: true` for a number that dies with the
  process, is invisible to reconciliation, and is not shared across instances. That is the false success
  the governing rules forbid, so it is refused.

What I did instead (B.2): the omission is now **explicit and auditable** —
`video.asset.metering_unconfigured` + `metering: 'unconfigured'` — and the composition site carries a
comment naming the I2 dependency, so wiring becomes a one-line addition once the tables exist. The seam
itself (`deps.meterStorage` on `createVideoAssetLifecycle`) already exists and is proven by tests.

### A.4 Reconciliation is not scheduled either

Nothing calls `reconcileStorageUsage` in production, and it has no SQL adapter — only
`createInMemoryMediaMeteringStore`. Even with tables, a run needs an owner: an admin route or a worker,
both outside this task's paths (`server/src/index.ts` is off-limits; a worker is a new module). Raised as
I2-5, not invented here.

### A.5 Pre-existing limitations I inherited and did not change

- **The append path is a read-modify-write.** `record()` reads the counter, inserts the event, then
  writes the counter. The *event* insert is race-safe (unique key); the *counter* update is not. Two
  concurrent replacements can lose a delta. The in-memory adapter is single-process so tests cannot show
  this. A durable adapter must either be built on a connection-bound transaction holding a row lock, or
  the port needs an atomic `applyDelta`. I did not add `applyDelta` because no adapter exists to
  implement it and an unused method is speculation. Reconciliation detects the resulting drift — it is
  not silent, but it is not prevented.
- **`insertCallback` runs before the transition-legality check**, so an illegal callback is recorded with
  `outcome='pending'` and never updated. Pre-existing, outside this task's acceptance.
- **`POST /usage/provider` accepts `storage_bytes` only as a JSON number**; a numeric string is dropped
  (fail-closed). Documented, not loosened.
- **`/usage/summary` reports a sum of absolute storage observations**, which is not "bytes stored". The
  per-asset cumulative meter is the correct number and is a different quantity. Changing the summary's
  meaning is a product decision outside this task.

### A.6 `playback-progress.ts` — intentionally untouched

Hash and mtime are the pre-batch ones (`96c7fe7b…`, 2026-10-18 14:56:13); it is not in `git status`. It is
the V6 resume/high-water-mark service: monotonic position, duration bound, rate limit, device permission.
It has no byte or second counter, no event ledger, and no tenant-total concept, so there is no metering
boundary to attach. Watch time is metered from the entitled heartbeat in
`POST /api/video-assets/usage/heartbeat` (`video-usage-events.ts`), which already carries a verified
playback entitlement — that is the correct seam. Wiring progress writes into metering would double-count
against the heartbeat path. Left untouched deliberately.

---

## (B) Changes I made

Five files changed, four untouched. Every existing assertion was preserved; nothing was skipped,
weakened, `any`-cast or `@ts-ignore`d.

| # | path | before sha256 | after sha256 | before → after bytes | why |
|---|---|---|---|---|---|
| B.1 | `server/src/services/media-usage-reconciliation.ts` | `a4d7408d30e86047a2d0e07f47fd1f5940d2b899be621d1000a62cdd25a9b252` | `75fda2bcbf4c44b6676486d6fe850fc9b1fbdafec8914cc986b01d265188ea04` | 26490 → 26763 | false `counter-missing` on an empty scope |
| B.2 | `server/src/services/video-asset-lifecycle.ts` | `e54805212b13583fd1ce455cc860b3aca463477e1fe5c80e7b85327fa504d377` | `ff97189fa277aa639a2ea7fdc81bba2366d3f8dbacb982c7758dc84b3114b911` | 29174 → 30744 | silent drop of verified bytes when no meter is composed |
| B.3 | `server/src/routes/video-assets.ts` | `61b08203cb811b0130027b3a1e3c2027ea7dfdd6a2f9ccf1c91c62e09485ec90` | `575cdbd51722af4011b54bff83237f98196d6b19dec7348d0a4418c82bb2be91` | 35363 → 37113 | usage-callback signature did not cover the numbers; composition-site note |
| B.4 | `server/tests/video-usage-storage.test.ts` | `8bfe3afdb2e7023c23a62f6ff7a96249f081c0fd3f71a7b0253fbb01ee2bdd8e` | `cf2ce1a39bb718b029e2b8a0dd09644ea30bb220f63e926043d5bff64c441e05` | 21779 → 26821 | tests for B.2, B.3 |
| B.5 | `server/tests/media-usage-reconciliation.test.ts` | `1daa491e05cb51956c81191432d92234bee2f155067c8c59048f2182fa5f756c` | `a626a0c4d74bb4fc6fe8ea7d303e2b2c4da1a1bba89e2f353d15ea9f7e2bb301` | 9762 → 14925 | tests for B.1, atomicity, foreign rows |
| – | `server/src/services/video-usage-events.ts` | `4c6316cb…6cebe2` | `4c6316cb…6cebe2` (identical) | 19626 → 19626 | **not touched by me** |
| – | `server/src/services/playback-progress.ts` | `96c7fe7b…c129d` | `96c7fe7b…c129d` (identical) | 23789 → 23789 | **not touched by me** |
| – | `server/tests/video-usage-replay.test.ts` | `8ec9f7e1…d0d0c` | `8ec9f7e1…d0d0c` (identical) | 9569 → 9569 | no verified gap; inherited assertions kept verbatim |

### B.1 `reconcileStorageUsage` no longer invents a discrepancy for an empty scope

`discrepancy()` returned `counter-missing` whenever the counter was `null`, including for a tenant or
asset that had never been metered. A tenant-scoped pass over a fresh tenant therefore reported
`status: 'mismatch'` with one phantom entry — on every pass, for every idle tenant, which is exactly how
a real gap gets buried. The guard is one condition: if `recordedTotal === null && eventCount === 0`,
return `null` (nothing was ever metered, so nothing can be missing). Events present with a missing
counter still report `counter-missing`; a counter with no events still reports drift.

### B.2 A verified byte count can no longer be dropped silently

`MeteringOutcome` gains `'unconfigured'`. When a `ready` callback carries `storage_bytes` and
`deps.meterStorage` is absent, the service now writes
`video.asset.metering_unconfigured` (reason `meter_not_configured`, with the byte count in `newValue`)
and returns `metering: 'unconfigured'`. The asset transition still commits — the state machine must not
be blocked by a missing meter — but the byte gap is an auditable fact instead of a no-op. A callback
with no bytes raises no audit, so the signal is not noise. The route does not surface `metering` to
clients, so no new response field appears.

### B.3 The usage-callback signature now covers the numbers it authorizes

`verifyUsageCallbackFromEnv` signed `[provider, event_id, tenant_id, kind]` and nothing else, while the
route forwarded `storage_bytes` / `watch_seconds` from the same unauthenticated body into
`video_usage_events`. Anyone holding one valid signature could rewrite the count and the meter would
record an unverified number — the acceptance item "derived only from provider-verified data" was not true
on that path. The payload now appends `bytes=…`, `seconds=…`, `asset=…` when present (prefixed, so the two
optional numeric fields cannot be confused), mirroring the convention the dead worker already applied to
the asset callback verifier. Callbacks carrying neither number keep the original four-field shape. The
verifier is exported so the production function itself — not a stand-in — is under test.

Behaviour change, fail-closed: a provider that signs a byte- or second-bearing usage callback with the old
four-field payload is now ignored (`202`). This is a tightening, not a widening; it needs a provider-side
re-signing note (see C.6).

The composition site also gained a comment stating why `meterStorage` is absent and what I2 must provide,
so the next reader cannot mistake the omission for an oversight.

---

## (C) Evidence

### C.1 Focused suites — before → after

Same command shape for every run, from `server/`:

```
M1_NETWORK_MODE=hermetic node --require ../scripts/m1-network-guard.cjs --import tsx --test tests/<file>
```

| suite | inherited (before my edits) | after my edits | delta |
|---|---|---|---|
| `tests/video-usage-storage.test.ts` | 18 tests, 18 pass, 0 fail | **21 tests, 21 pass, 0 fail** | +3 |
| `tests/video-usage-replay.test.ts` | 7 tests, 7 pass, 0 fail | **7 tests, 7 pass, 0 fail** | 0 (unchanged file) |
| `tests/media-usage-reconciliation.test.ts` | 7 tests, 7 pass, 0 fail | **10 tests, 10 pass, 0 fail** | +3 |
| **total** | **32 pass** | **38 pass, 0 fail, 0 skipped, 0 todo** | +6 |

The inherited 32 were re-run before any edit and reproduced 18 / 7 / 7 exactly, so the "32 pass" in the
handoff is confirmed rather than trusted.

### C.2 Pre-existing suites covering the files I touched

| suite | result |
|---|---|
| `tests/m2-m3-mounting.test.ts` | 20 / 20 pass |
| `tests/m3-video-lifecycle.test.ts` | 55 / 55 pass |
| `tests/m3-video-review-fixes.test.ts` | 15 / 15 pass |
| `tests/m3-playback-sessions.test.ts` | 64 / 64 pass |
| `tests/m3-playback-sql-store.test.ts` | 11 / 11 pass |

165 / 165, no failure. These are the suites that exercise the router, the lifecycle state machine, the
mounting/auth boundary of `/usage/provider`, and the progress service. No full-suite run: the other two
recovery workers and the Claude lane are writing in this tree.

### C.3 Typecheck

```
node node_modules/typescript/bin/tsc --noEmit -p server/tsconfig.json
→ exit 0, zero diagnostics
```

### C.4 New tests, and what each one proves

`video-usage-storage.test.ts`
- *verified bytes with no composed meter are audited as unconfigured, not dropped* — the exact production
  composition (no `meterStorage`); asserts `metering: 'unconfigured'` **and** the
  `video.asset.metering_unconfigured` audit. This is the test that would have failed before B.2.
- *a byte-less ready callback never raises an unconfigured metering audit* — the signal stays meaningful.
- *the production usage-callback signature covers the byte and second counts* — drives the real exported
  verifier with a real HMAC: honest signature accepted; the same signature with a rewritten
  `storage_bytes`, a rewritten `watch_seconds`, or a different `asset_id` rejected; byte-less payload
  still accepted in its original shape; missing secret fails closed. This would have failed before B.3.

`media-usage-reconciliation.test.ts`
- *a tenant with no metered events reports match* — tenant- and asset-scoped, kills the phantom entry (B.1).
- *a counter write failure keeps the event, surfaces the error, and is reported as a gap* — **failure
  atomicity**: the append survives, the caller gets a rejection instead of a false success, reconciliation
  reports `counter-missing` with the rebuilt total, and the retry is absorbed by the idempotency key so
  recovery cannot double count.
- *rows from another tenant are never attributed, even if a store returns them* — a deliberately leaky
  adapter; the rebuild still says 1000 while the counter says 6000, proving tenant filtering happens at
  the fold and not only in the query.

All new tests drive the real service over a real adapter; no mock decides a transition, a delta or a
reconciliation verdict.

### C.5 Event and unit taxonomy

| family | unit | ledger | key | evidence |
|---|---|---|---|---|
| watch | seconds | `video_usage_events` (`kind='watch'`) | `hb:{sessionId}:{windowBucket}` | entitled client heartbeat or provider callback |
| storage **observation** | bytes | `video_usage_events` (`kind='storage'`) | `cb:{provider}:{eventId}` | signed provider callback (absolute snapshot; summed by `/usage/summary`) |
| storage **transition** | bytes | `MediaMeteringStore` (durable table pending I2) | `st:{assetId}:{operationId}` | `provider-callback` \| `server-measured` only |

`upload`/`replace` are absolute sizes, `delete` is zero, `retry` carries forward. Bytes and seconds are
never added together, and neither is a student count.

### C.6 Reconciliation report shape

```ts
{
  unit: 'storage_bytes',
  tenantId: string,
  assetId: string | null,          // null = tenant-scoped pass (also compares every asset)
  checkedAtMs: number,
  status: 'match' | 'mismatch',
  eventCount: number,
  mutated: false,                  // literal: reconciliation is a report, never a repair
  discrepancies: [{
    unit: 'storage_bytes',
    scope: 'tenant' | 'asset',
    tenantId: string,
    assetId: string | null,
    recordedTotal: number | null,  // null when the counter was never written
    rebuiltTotal: number,
    delta: number | null,          // recorded - rebuilt; null when there is nothing to subtract
    eventCount: number,
    reason: 'counter-drift' | 'counter-missing',
  }],
}
```

### C.7 Exact I2 requests (no SQL written against imagined columns)

**I2-1 — durable transition ledger.** `video_storage_transitions`: `id CHAR(36) PK`,
`tenant_id CHAR(36)`, `asset_id CHAR(36)`, `transition ENUM('upload','replace','delete','retry')`,
`resulting_bytes BIGINT UNSIGNED`, `idempotency_key VARCHAR(200)`, `evidence_source VARCHAR(32)`,
`occurred_at TIMESTAMP`, `created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP`,
`UNIQUE KEY (tenant_id, idempotency_key)`, `KEY (tenant_id, asset_id, occurred_at)`.
The unique key is the replay guard the port already assumes.

**I2-2 — counters.** MySQL cannot put `NULL` in a primary key, so the single "asset_id NULL = tenant
total" shape in the port cannot be one table: needs `media_storage_asset_counters(tenant_id, asset_id,
storage_bytes, updated_at) PRIMARY KEY (tenant_id, asset_id)` **and**
`media_storage_tenant_counters(tenant_id, storage_bytes, updated_at) PRIMARY KEY (tenant_id)`. Both
`BIGINT UNSIGNED` (bytes are never fractional; no `FLOAT`).

**I2-3 — atomic append.** The port exposes `readStorageCounter` then `writeStorageCounter`, which is a
read-modify-write. A durable adapter must run inside one connection-bound transaction holding a row lock,
or the port needs `applyDelta(tenantId, assetId, delta)` with
`storage_bytes = GREATEST(0, storage_bytes + ?)` plus the tenant total in the same transaction. Contract
decision needed before any adapter is written.

**I2-4 — deferred/unconfigured repair path.** `deferred` and `unconfigured` are detected, never repaired.
A retry/outbox that re-drives `recordVerifiedBytes` from the audited callback (which already carries the
verified byte count and a stable `callback_id`) needs an owner and a table. No notification dependency is
involved or wanted.

**I2-5 — a caller for reconciliation.** Nothing invokes `reconcileStorageUsage`; it has no SQL adapter and
no schedule. Needs an admin route or a worker, and `server/src/index.ts` is not mine.

### C.8 Honest limits

- **The meter is not live.** Production composes the lifecycle without `meterStorage`; no production code
  imports `media-usage-reconciliation.ts`. Today the deployment records the gap as an audit event and
  returns `metering: 'unconfigured'`. Nothing about this delivery makes storage metering operational.
- **No SQL, no provider, no DB was executed or contacted.** Every test is hermetic; the SQL adapters in
  `video-usage-events.ts` / `video-asset-lifecycle.ts` are typechecked and read, not run. I cannot claim
  MySQL behaviour (collation on `dedupe_key`, `ER_DUP_ENTRY` under a real unique index, `TIMESTAMP`
  round-tripping) from these tests.
- **Concurrency is unproven for the counter**, as described in A.5. The event insert is safe; the counter
  is not, and tests cannot show it in a single-process adapter.
- **The signature tightening needs provider coordination** (B.3). Byte- or second-bearing usage callbacks
  must sign the extended payload or they will be ignored.
- **`/usage/summary` still reports a sum of absolute observations**, which is not "bytes stored".

### C.9 What I deliberately did not do

- No rewrite of inherited code that already met acceptance; `video-usage-events.ts`,
  `playback-progress.ts` and `video-usage-replay.test.ts` are byte-identical to what I inherited.
- No in-memory meter composed into production (false success).
- No SQL against imagined columns, no migration, no DDL, no `server/migrations/**` edit.
- No edits outside my nine paths — in particular no `server/src/index.ts`, `middleware/auth.ts`, `db.ts`,
  `bootstrap/m1/manifest.json`, `secure-video.ts`, `video-security.ts`, `playback-session-registry.ts`,
  `playback-entitlement.ts`, `routes/playback-sessions.ts`, no assignment/notification file, no client
  file, no Claude-lane file. I did not reformat or touch the other recovery workers' files.
- No full test suite, no DB, no Docker, no service, no listener, no network, no provider, no secret, no
  install, no Git mutation (no reset/clean/stash/checkout/commit/push/merge).
- No claim of acceptance. `reported` is not `accepted`.

---

## Correction pass — the atomic meter seam (2026-10-21)

Task `server-b2-w6-atomic-meter-correction-20261021-01` · team `media` · branch `codex/workbuddy-server`.
Controlling scope: the same `docs/streams/server/BATCH2-IMPLEMENTATION-SCOPE-20261021.md` § B2-W6, with the
correction acceptance added by the supervisor (atomic contract mandatory; interleaving/rollback regression;
production meter still honestly `unconfigured`).

Status: **reported, not accepted.** No SQL was written or executed, no migration, no DB, no provider, no
network. This pass corrects one defect in the append path described above in A.5; it does not close W6 and
does not make storage metering operational.

### (A) Inherited state verified — correction pass

Every hash below was recomputed from disk before the first write of this pass and matched
`C:/Users/abdua/WorkBuddySupervisorBridge/handoff/WORKBUDDY-B2-CORRECTION-BASELINE-20261021.md` § W6-atomic
exactly (which in turn matches § 2 of `WORKBUDDY-B2-DELIVERY-20261021.md`). **I did not author these bytes.**
The inherited green suites were also re-run before any edit and reproduced 21 / 7 / 10 exactly.

| path | pre-claim sha256 | bytes | disposition |
|---|---|---|---|
| `server/src/services/video-usage-events.ts` | `4c6316cb7b0c185b109e26cb89921ab285e2547826dd96a1305f34e9926cebe2` | 19626 | inherited, **unchanged** |
| `server/src/services/playback-progress.ts` | `96c7fe7b76309d6452d96fcf40c3b6a51159f4d5516f6a2abaecffe1a86c129d` | 23789 | inherited, **unchanged** (still no metering boundary — see A.6 above) |
| `server/src/services/video-asset-lifecycle.ts` | `ff97189fa277aa639a2ea7fdc81bba2366d3f8dbacb982c7758dc84b3114b911` | 30744 | inherited, **unchanged** |
| `server/src/routes/video-assets.ts` | `575cdbd51722af4011b54bff83237f98196d6b19dec7348d0a4418c82bb2be91` | 37113 | inherited, **unchanged** |
| `server/src/services/media-usage-reconciliation.ts` | `75fda2bcbf4c44b6676486d6fe850fc9b1fbdafec8914cc986b01d265188ea04` | 26763 | inherited, **corrected by me** |
| `server/tests/media-usage-reconciliation.test.ts` | `a626a0c4d74bb4fc6fe8ea7d303e2b2c4da1a1bba89e2f353d15ea9f7e2bb301` | 14925 | inherited, extended by me |
| `server/tests/video-usage-storage.test.ts` | `cf2ce1a39bb718b029e2b8a0dd09644ea30bb220f63e926043d5bff64c441e05` | 26821 | inherited, extended by me |
| `server/tests/video-usage-replay.test.ts` | `8ec9f7e1640cd5dc23885a960fc2d3e0c0176b57ed039f348e4f91630dcd0d0c` | 9569 | inherited, **unchanged** |
| `docs/streams/server/B2-W6-MEDIA-METERING-20261021.md` | `c50755a9fb0c39ac364f2038e1d38b80e22c935d28b2c35729e1686f33d621ad` | 27635 | inherited, appended by me (this section) |

#### A.1 The defect, read from the source (not inferred from the tests)

The inherited `record()` did this, in this order, with **no transaction around any of it**:

1. `findAssetTenant` — read
2. `listEvents(tenantId)` — read
3. `readStorageCounter(asset)` and `readStorageCounter(tenant)` — read
4. `insertEvent` — **write 1**
5. `writeStorageCounter(asset)` — **write 2**
6. `writeStorageCounter(tenant)` — **write 3**
7. `recordAudit` — **write 4**

Two consequences, both real:

- **Lost update.** Steps 2–3 are a read-modify-write over the shared tenant counter. Two appends that both
  read `tenant = 1000` each write `1000 + ownDelta`, so the second overwrites the first. Nothing in the port
  could prevent it: the store exposed bare `writeStorageCounter(tenantId, null, total)` with no lock, no CAS
  and no delta operation.
- **Partial commit.** The event (step 4) is durable before either counter (5–6). A failure at step 5 leaves a
  committed event with no counter movement — a permanent counter/event mismatch that only reconciliation can
  *detect*, never repair. The inherited test
  *"a counter write failure keeps the event, surfaces the error, and is reported as a gap"* asserted exactly
  that degraded behaviour as if it were the contract.

#### A.2 Failures I captured against the inherited code before changing it

Both probes were written first and run against the untouched source; the output below is the real native run.

| probe | expected | inherited code produced |
|---|---|---|
| two parallel appends, two assets, one tenant | tenant counter `3000` | **`2000`** (`AssertionError: expected 3000, actual 2000`) — one 1000-byte delta lost |
| append whose first counter write throws | event not committed (`1`) | **`2`** events — the event survived, both counters did not move |

That is the durable counter/event mismatch the correction exists to remove. Both probes pass after the fix
(C.4).

#### A.3 What I deliberately left untouched

`video-usage-events.ts`, `playback-progress.ts`, `video-asset-lifecycle.ts`, `routes/video-assets.ts` and
`video-usage-replay.test.ts` are byte-identical to the inherited baseline.

- The **watch** path has no materialized counter (`sumWatchSeconds` is a SQL `SUM` over rows), so it has no
  read-modify-write and no lost-update surface. Nothing to correct there.
- The **lifecycle** boundary deliberately commits the asset state before metering and reports a meter failure
  as `deferred` + audit. Making *that* atomic needs one connection shared by two modules (`video_assets` and
  the metering tables) — an I2 concern, not this correction. The `unconfigured` guard and the
  `unconfigured | deferred | recorded | deduplicated` taxonomy are unchanged and still honest.
- The **HMAC-verified callback fields** are untouched: `verifyProviderCallbackFromEnv` still signs
  `provider / callbackId / providerAssetId / targetState / tenantId` plus `storageBytes` when present, and the
  lifecycle still forwards only the signed `storageBytes` with `callbackId` as the operation id. The existing
  signature test still passes unmodified.

### (B) Changes I made

Three files changed; six untouched. Every inherited assertion that asserted a *correct* behaviour was kept
verbatim. Nothing was skipped, weakened, `any`-cast or `@ts-ignore`d.

| # | path | before sha256 | after sha256 | before → after bytes | why |
|---|---|---|---|---|---|
| B.1 | `server/src/services/media-usage-reconciliation.ts` | `75fda2bcbf4c44b6676486d6fe850fc9b1fbdafec8914cc986b01d265188ea04` | `b1d0492de0a043a2798695efe4be60ca929970de20d426f057f4fd759a6c89bc` | 26763 → 36142 | one mandatory transaction-bound append; no loose write path; lock order; arithmetic guards; the in-memory adapter now really rolls back |
| B.2 | `server/tests/media-usage-reconciliation.test.ts` | `a626a0c4d74bb4fc6fe8ea7d303e2b2c4da1a1bba89e2f353d15ea9f7e2bb301` | `e5d44b5f5ae4f8e50a6d8a1d59b21a76260f78b4eff27880532e2af6673d953b` | 14925 → 21510 | rollback at each seam, retry-after-rollback, unsafe total, read-only typing |
| B.3 | `server/tests/video-usage-storage.test.ts` | `cf2ce1a39bb718b029e2b8a0dd09644ea30bb220f63e926043d5bff64c441e05` | `0c5e3d02f1998dfbb18240d5bc9c0ec2e79ad9271db4985dfd04e44918807adc` | 26821 → 36758 | interleaving, duplicate-in-unit, same-snapshot rebuild, no-transaction fail-closed |
| B.4 | `docs/streams/server/B2-W6-MEDIA-METERING-20261021.md` (this file) | `c50755a9fb0c39ac364f2038e1d38b80e22c935d28b2c35729e1686f33d621ad` | recomputed externally — a file cannot embed its own post-edit hash | 27635 → (see delivery note) | appended this correction section (A)–(E) |

#### B.1 One mandatory transaction seam

The port no longer exposes any write outside a transaction. Writes exist **only** on a handle that is valid
only inside the callback:

```ts
export interface MediaMeteringReadStore {          // reconciliation is typed against this
    listEvents(tenantId: string, assetId?: string): Promise<StorageMeterEventRow[]>;
    readStorageCounter(tenantId: string, assetId: string | null): Promise<number | null>;
}

export interface MediaMeteringUnit { tenantId: string; assetId: string }

export interface MediaMeteringTransaction {       // ONLY valid inside withTransaction
    findAssetTenant(assetId: string): Promise<string | null>;
    listEvents(tenantId: string, assetId?: string): Promise<StorageMeterEventRow[]>;
    insertEvent(row: StorageMeterEventRow): Promise<boolean>;
    readStorageCounter(tenantId: string, assetId: string | null): Promise<number | null>;
    writeStorageCounter(tenantId: string, assetId: string | null, total: number): Promise<void>;
    recordAudit(input: AuditRecordInput): Promise<void>;
}

export interface MediaMeteringStore extends MediaMeteringReadStore {
    withTransaction<T>(
        unit: MediaMeteringUnit,
        work: (tx: MediaMeteringTransaction) => Promise<T>,
    ): Promise<T>;
}
```

`withTransaction` is **required, not optional**. There is no `applyDelta`-or-autocommit branch and no
"try atomic, else loose" path: `record()` returns
`{ error: 'the meter store cannot open a transaction; refusing to write' }` when the injected store has no
`withTransaction`, and the runtime `typeof` guard exists because a JS adapter can still be non-conforming
(TypeScript cannot enforce it at runtime). **Fail closed, never degrade.**

Co-committed in one unit: ownership check → idempotency check/insert → event append → **tenant** counter →
**asset** counter → audit. All six, or none.

#### B.2 Idempotency moved inside the unit

The duplicate decision is now `tx.insertEvent()` returning `false` — the ledger's
`UNIQUE(tenant_id, idempotency_key)` guard — evaluated *inside* the same transaction that would have written
the counters. There is no pre-read to race, and the `video.usage.storage.deduplicated` audit commits inside
the unit. Because `insertEvent` no longer exists on the store, an outside-the-unit append is not expressible.

#### B.3 Deterministic lock order: TENANT, then ASSET

Stated in the port contract, in the module header, and at the write site. Every writer takes the shared tenant
counter **before** the per-asset counter; the two `writeStorageCounter` calls are issued in that order. One
order everywhere is what stops two concurrent appends from deadlocking, and taking both inside the unit is
what stops a delta being lost between them.

#### B.4 The in-memory adapter really executes and really rolls back

`createInMemoryMediaMeteringStore().withTransaction` now:

- runs `work` against a **staged overlay** (pending events / keys / counters / audits) that reads through to
  committed state, so the callback executes against a coherent view;
- **discards the overlay on any throw** — the committed arrays and map are never touched, which is the
  rollback;
- **commits in one synchronous block with no `await`**, so nothing can interleave between the event and the
  two counters;
- **serializes units per tenant** (a FIFO tail per tenant id), which is the in-process model of
  `SELECT … FOR UPDATE` on the shared tenant counter row taken before the asset row.

The previous adapter was a plain map writer with no callback at all, so it could not have proven either
property. The tests assert that the callback reached the abort point (an ordered `attempts` trace) — a fake
that skipped the callback could not produce that trace.

#### B.5 Arithmetic

`floorByteTotal` guards every total that is written: floor at 0 (a drifted-low counter cannot produce a
negative state) and refuse anything outside `Number.isSafeInteger`. A refusal throws *inside* the unit, so it
rolls back rather than persisting an untrustworthy number. Inputs stay exact integers: `resultingBytes` must
be a non-negative integer ≤ the 10 GiB per-asset cap; `bytesDelta` may be negative (that is a delta, not a
state) and every stored total is `>= 0`.

#### B.6 One inherited assertion encoded the defect, and was replaced

`media-usage-reconciliation.test.ts` previously asserted *"a counter write failure keeps the event …"* — i.e.
it asserted the partial commit. It is replaced by four assertions of the correct contract: full rollback
between event and first counter, full rollback between the two counters, full rollback on audit failure, and
"a rolled-back unit consumes no idempotency key, so the provider's retry records exactly once". This is the
one inherited assertion I did not preserve, and it is the assertion that documented the bug. Every other
inherited assertion (positive, redaction, tenant-isolation, unit-separation, signature) is unchanged and still
passes.

### (C) Evidence

#### C.1 Focused suites — before → after

Same command shape for every run, from `server/`:

```
M1_NETWORK_MODE=hermetic node --require ../scripts/m1-network-guard.cjs --import tsx --test tests/<file>
```

| suite | inherited (re-run before any edit) | after this pass | delta |
|---|---|---|---|
| `tests/video-usage-storage.test.ts` | 21 tests, 21 pass, 0 fail | **27 tests, 27 pass, 0 fail** | +6 |
| `tests/video-usage-replay.test.ts` | 7 tests, 7 pass, 0 fail | **7 tests, 7 pass, 0 fail** | 0 (file unchanged) |
| `tests/media-usage-reconciliation.test.ts` | 10 tests, 10 pass, 0 fail | **14 tests, 14 pass, 0 fail** | +4 |
| **total** | **38 pass, 0 fail** | **48 pass, 0 fail, 0 skipped, 0 todo** | **+10** |

No suite outside these three was run: the only changed source module has **zero production importers**
(`grep -r media-usage-reconciliation server/src` returns one comment in `video-usage-events.ts`), so no other
suite exercises it. Full regression stays with the supervisor.

#### C.2 Typecheck

```
node node_modules/typescript/bin/tsc --noEmit -p server/tsconfig.json
→ exit 0, zero diagnostics
```

`server/tsconfig.json` includes `src/**/*` only, so the three test files were additionally typechecked
explicitly with the same strict flags (they are transpile-only under `tsx`):

```
node node_modules/typescript/bin/tsc --noEmit --strict --target ES2020 --module commonjs \
  --moduleResolution node --esModuleInterop --skipLibCheck --types node \
  server/tests/media-usage-reconciliation.test.ts server/tests/video-usage-storage.test.ts \
  server/tests/video-usage-replay.test.ts
→ exit 0, zero diagnostics
```

That second command caught two real errors in my own first draft (`bytesDelta` read off the
`deduplicated: true` union member), which were fixed by discriminant narrowing rather than by a cast.

#### C.3 Scenario → assertion map

| required scenario | test | asserts |
|---|---|---|
| controlled interleaving, two parallel assets in one tenant | *two parallel assets in one tenant both land on the shared tenant counter* | asset 1000 / 2000, tenant **3000**, rebuild 3000 (was 2000) |
| same-asset replace interleaved with another append | *a replacement interleaved with another append lands both deltas exactly once* | −400 and +500 both applied once, tenant 1100, 3 events |
| same asset, replace submitted before an earlier-timestamped replace | *a replace interleaved with an earlier-timestamped replace loses neither delta* | canonical 1000→800→600, counter 600 == rebuild 600 |
| duplicate event, single effect, inside the unit | *a duplicate is absorbed inside the unit and never touches a counter* | exactly 2 units of work, 1 event, counter map identical, 1 dedupe audit + 1 recorded audit |
| failure between the event write and the first counter | *a failure between the event write and the first counter rolls the whole unit back* | trace `[event, tenant-counter]`; 0 new events, counters identical, 0 new audits, error surfaces, reconciliation `match` |
| failure after the first counter, before the second | *a failure after the first counter but before the second rolls back both* | trace `[event, tenant-counter, asset-counter]`; both counters back to 500 |
| audit failure | *an audit failure rolls back the event and both counters* | trace ends at `audit`; nothing committed |
| rollback leaves no idempotency key behind | *a failed unit leaves no trace, so the legitimate retry records once* | retry records, delta 900, counter 900, reconciliation `match` |
| out-of-order rebuild from the same snapshot | *an out-of-order append rebuilds from the snapshot it appends to* | counter == rebuild for asset and tenant; rebuild audit carries the exact before/after it wrote |
| no transaction available | *a store without a transaction seam is refused and writes nothing* | `{error: transactionRequired}`, **0 loose writes**, no event, no counter |
| unsafe total | *an unsafe byte total is refused instead of persisted* | rejection with the guard message, counters and events untouched |
| reconciliation still cannot write | *the store is only read, never written* | only `listEvents`/`readStorageCounter` are ever called; events, counters and audits unchanged |

#### C.4 What these tests do not prove

- They prove the **contract** at the injected seam, not MySQL. The in-memory `withTransaction` models
  serialization and rollback; it is not evidence about InnoDB locking, gap locks, or deadlock detection.
- The two captured failures (A.2) are native runs against the inherited code. The remaining new tests are
  regression guards: their old-code failure was derived by reading the inherited read-modify-write, not
  separately executed.
- `deferred` at the lifecycle boundary is unchanged: a meter failure still leaves the asset `ready` and the
  gap for reconciliation. That remains an I2 outbox item, not something this pass fixed.

### (D) I2 connection-bound contract for the persistence owner

This is the contract the durable adapter must satisfy. It is **described, not implemented** — no table, no
migration and no DDL was authored here. It uses the table shapes already requested in C.7 (I2-1 transition
ledger, I2-2 asset and tenant counters).

**D.1 Port shape.** Implement `MediaMeteringStore` exactly as in B.1: `listEvents` / `readStorageCounter` for
reads, and `withTransaction(unit, work)` as the only write path. Do **not** add a bare `insertEvent` or
`writeStorageCounter` to the store, and do **not** make `withTransaction` optional — the service refuses to
write when it is absent, which is the intended fail-closed behaviour.

**D.2 One connection, two locks, one order.** `withTransaction` must:

1. acquire a dedicated connection from the pool and `BEGIN` on it — every statement issued by `tx` must run on
   that connection, never on the pool;
2. `SELECT storage_bytes FROM media_storage_tenant_counters WHERE tenant_id = ? FOR UPDATE` — the **tenant**
   row first, creating it with an `INSERT … ON DUPLICATE KEY UPDATE` (or `INSERT IGNORE`) if absent;
3. `SELECT storage_bytes FROM media_storage_asset_counters WHERE tenant_id = ? AND asset_id = ? FOR UPDATE` —
   the **asset** row second, same upsert-if-absent rule;
4. run `work(tx)` on that connection;
5. `COMMIT` on success, `ROLLBACK` on any throw, then release the connection.

The order is not a preference. Two appends that lock tenant-then-asset in one place and asset-then-tenant in
another will deadlock under load; the service already issues its writes in tenant→asset order, and the adapter
must take the locks in that same order.

**D.3 Statements behind each `tx` method.**

| `tx` method | statement shape |
|---|---|
| `findAssetTenant` | `SELECT tenant_id FROM video_assets WHERE id = ?` (server rows only; the payload is never consulted) |
| `listEvents` | `SELECT … FROM video_storage_transitions WHERE tenant_id = ? [AND asset_id = ?] ORDER BY occurred_at ASC, id ASC` on the transaction connection |
| `insertEvent` | `INSERT INTO video_storage_transitions (…) VALUES (…)`, catching `ER_DUP_ENTRY` on `UNIQUE (tenant_id, idempotency_key)` and returning `false` |
| `readStorageCounter` | `SELECT storage_bytes FROM media_storage_asset_counters WHERE tenant_id=? AND asset_id=?` (or the tenant table when `assetId === null`), on the transaction connection |
| `writeStorageCounter` | `UPDATE … SET storage_bytes = ?, updated_at = UTC_TIMESTAMP() WHERE tenant_id = ? [AND asset_id = ?]` — an **absolute** write of the total the service computed, not a `+=` delta, so a retry of the same unit is idempotent |
| `recordAudit` | the existing `recordAudit(execute, input)` insert, executed on the **same connection** so the audit row commits or rolls back with the event |

**D.4 Idempotency key.** `st:{assetId}:{operationId}` (`buildStorageIdempotencyKey`), sha256-shortened to
`st:{assetId}:h:{40 hex}` when longer than 200 characters, unique on `(tenant_id, idempotency_key)`. The key
must be enforced by the **database**, not by a read-then-insert in the adapter: the `ER_DUP_ENTRY` →
`false` translation is the whole guard. Note the key is tenant-scoped, so the same operation id in another
tenant is legal.

**D.5 Rollback semantics.** A throw from any `tx` method — duplicate handling excepted — must abort the unit:
no transition row, no asset counter movement, no tenant counter movement, no audit row, and the original error
re-thrown to the caller. Never swallow a statement error into a returned `{error}` *after* the insert: the
service treats a returned `{error}` as a commit, so a post-insert failure must throw.

**D.6 Known cost to decide before writing the adapter.** The unit currently lists **all** of a tenant's
transitions inside the transaction (`listEvents(tenantId)`) because out-of-order detection and the rebuild
need them. On a large tenant that is a wide read held under two row locks. The owner should either bound it
(transitions for the asset + the tenant total are sufficient for the in-order path) or move the rebuild out
of the lock and use a fenced `applyDelta`. That decision changes performance, not the atomicity contract, so
it is left to the persistence owner with this note rather than guessed here.

**D.7 Not part of this contract.** The asset state machine (`video_assets`) is not in this unit. Co-committing
`status = 'ready'` with the byte counters would need one connection across both modules and is a separate
decision; until then the lifecycle's `deferred` outcome remains the honest description of a meter failure
after the state commit.

### (E) Honest limits

- **The meter is still `unconfigured` in production.** No production module imports
  `media-usage-reconciliation.ts`; `createVideoAssetLifecycle` is still composed without `meterStorage`
  (`routes/video-assets.ts:692`), so a byte-bearing `ready` callback is still audited as
  `video.asset.metering_unconfigured` and answered `metering: 'unconfigured'`. This pass makes the seam
  *correct*; it does not make metering *operational*.
- **No SQL, no DB, no provider, no network.** No migration, no DDL, no adapter was written. Every claim about
  transactions, `FOR UPDATE`, rollback and serialization is proven at the injected seam only. MySQL behaviour
  (InnoDB locking, deadlock detection, `ER_DUP_ENTRY` under the real unique index, `BIGINT UNSIGNED`
  round-tripping) is unverified.
- **The in-memory serialization is a model, not a proof of concurrency safety in production.** It serializes
  per tenant inside one process; a real deployment has multiple processes, which is precisely why the lock
  order and the single-connection rule are contractual (D.2) rather than advisory.
- **`deferred` still means "not recorded".** A meter failure after the asset state commit leaves the gap for
  reconciliation; the retry/outbox that would close it (I2-4) does not exist and was not invented here.
- **Reconciliation is still unscheduled and has no SQL adapter** (I2-5). Its read surface is now typed
  read-only, which is a correctness improvement, not a deployment.
- **No full suite was run.** The Claude lane and the other correction worker are writing in this tree; full
  regression stays with the supervisor.
- **Nothing here is accepted.** `reported` is not `accepted`.

---

## Verification pass — independent re-verification of the correction (2026-10-21)

Task `server-b2-w6-atomic-meter-recovery-20261021-01` · team `media` · branch `codex/workbuddy-server` ·
worker `wb-b2-w6-atomic-meter-recovery-20261021-01`.

Status: **reported, not accepted.** This pass verifies the inherited correction against the three recovery
acceptance criteria and re-verifies every factual claim in this document against the code on disk. It changes
**no source file and no test file**. The only file touched is this document (five edits, itemized in F.4).

### (F.1) Inherited-vs-own attribution

Every byte of code on disk is **inherited** from the 429-killed correction worker and was preserved
byte-for-byte. Before any edit, all nine `allowedPaths` were hashed and matched
`C:/Users/abdua/WorkBuddySupervisorBridge/handoff/WORKBUDDY-B2-RECOVERY2-BASELINE-20261021.md` § W6 exactly:

| path | sha256 (pre-claim, == baseline) | bytes | disposition |
|---|---|---|---|
| `server/src/services/video-usage-events.ts` | `4c6316cb7b0c185b109e26cb89921ab285e2547826dd96a1305f34e9926cebe2` | 19626 | inherited, **untouched by me** |
| `server/src/services/playback-progress.ts` | `96c7fe7b76309d6452d96fcf40c3b6a51159f4d5516f6a2abaecffe1a86c129d` | 23789 | inherited, **untouched by me** |
| `server/src/services/video-asset-lifecycle.ts` | `ff97189fa277aa639a2ea7fdc81bba2366d3f8dbacb982c7758dc84b3114b911` | 30744 | inherited, **untouched by me** |
| `server/src/routes/video-assets.ts` | `575cdbd51722af4011b54bff83237f98196d6b19dec7348d0a4418c82bb2be91` | 37113 | inherited, **untouched by me** |
| `server/src/services/media-usage-reconciliation.ts` | `b1d0492de0a043a2798695efe4be60ca929970de20d426f057f4fd759a6c89bc` | 36142 | inherited, **untouched by me** |
| `server/tests/media-usage-reconciliation.test.ts` | `e5d44b5f5ae4f8e50a6d8a1d59b21a76260f78b4eff27880532e2af6673d953b` | 21510 | inherited, **untouched by me** |
| `server/tests/video-usage-storage.test.ts` | `0c5e3d02f1998dfbb18240d5bc9c0ec2e79ad9271db4985dfd04e44918807adc` | 36758 | inherited, **untouched by me** |
| `server/tests/video-usage-replay.test.ts` | `8ec9f7e1640cd5dc23885a960fc2d3e0c0176b57ed039f348e4f91630dcd0d0c` | 9569 | inherited, **untouched by me** |
| `docs/streams/server/B2-W6-MEDIA-METERING-20261021.md` | `e7657148ff96a2786d788fc98dcfc327d87fa6db0b52b3e691cf929faf579754` | 51306 | inherited doc, **edited by me** (F.4 only) |

The eight code/test files were not opened for writing at any point; their post-verification hashes are
identical to the pre-claim hashes above.

### (F.2) The three acceptance criteria, proven by reading the code

**Criterion 1 — atomic contract mandatory.** `server/src/services/media-usage-reconciliation.ts`:

- Refusal, not degradation: `record()` checks `typeof store.withTransaction !== 'function'` and returns
  `{ error: STORAGE_METER_ERRORS.transactionRequired }` (`:436-438`; message at `:98`) **before** any read or
  write. There is no autocommit fallback anywhere in the module.
- One write path: the sole writer is the `record` closure (`:425-569`), whose only store call is
  `store.withTransaction({ tenantId, assetId }, …)` (`:440`). `MediaMeteringStore` (`:230-251`) exposes writes
  only through `withTransaction`; `insertEvent` / `writeStorageCounter` / `recordAudit` live on
  `MediaMeteringTransaction` (`:211-223`), a handle that exists only as the callback parameter;
  `MediaMeteringReadStore` (`:190-195`) — the type reconciliation is written against — has reads only. A bare
  `insertEvent`/`writeStorageCounter` outside the unit is not expressible.
- Inside the SAME unit, in order: ownership resolved from server rows via `tx.findAssetTenant`
  (`:443-445`, `unknownAsset` / `tenantMismatch`); snapshot reads (`:449-459`); idempotency decided by
  `tx.insertEvent` returning `false` with the dedupe audit inside the unit (`:493-504`); event append
  (`:493`); **tenant counter first** (`:529` `writeStorageCounter(tenantId, null, …)`) **then asset counter**
  (`:530`) — the deterministic order stated at `:526-528`; out-of-order rebuild audit (`:533-543`); recorded
  audit (`:545-559`).
- Regression test: `server/tests/video-usage-storage.test.ts:342-365` — a store without `withTransaction`
  yields exactly `{ error: transactionRequired }` with **zero** loose writes, no event, no counter.

**Criterion 2 — interleaving and rollback regression.** All required scenarios exist and pass:

| scenario | test (file:line) |
|---|---|
| two parallel assets in one tenant | `server/tests/video-usage-storage.test.ts:205-224` (tenant counter 3000, rebuild 3000) |
| same-asset replace interleaved with another append | `server/tests/video-usage-storage.test.ts:226-253` (−400 and +500 applied once, tenant 1100, 3 events) |
| replace interleaved with an earlier-timestamped replace | `server/tests/video-usage-storage.test.ts:255-279` (canonical 1000→800→600, counter == rebuild) |
| duplicate event | `server/tests/video-usage-storage.test.ts:285-313` (2 units, 1 event, counters identical, 1 dedupe + 1 recorded audit); also `server/tests/video-usage-replay.test.ts:75-90` |
| injected failure between the event write and the tenant counter | `server/tests/media-usage-reconciliation.test.ts:270-302` (trace `[event, tenant-counter]`; nothing committed) |
| injected failure after the tenant counter, before the asset counter | `server/tests/media-usage-reconciliation.test.ts:304-331` (trace `[event, tenant-counter, asset-counter]`; both counters back to 500) |
| injected failure at the audit | `server/tests/media-usage-reconciliation.test.ts:333-358` (trace ends at `audit`; nothing committed) |
| rollback consumes no idempotency key | `server/tests/media-usage-reconciliation.test.ts:360-385` |

The fault harness (`server/tests/media-usage-reconciliation.test.ts:92-123`) wraps the real adapter's
transaction and aborts at one chosen statement while recording an ordered `attempts` trace, so a rollback
assertion cannot be satisfied by a callback that never ran. The adapter genuinely executes the callback and
rolls back: staged overlay (`media-usage-reconciliation.ts:796-826`), discard on throw (commit block at
`:833-836` is unreachable after a throw), one synchronous commit, per-tenant FIFO serialization (`:770-777`).
No lost delta, no partial commit.

Old positive / redaction / tenant-scoping tests are present and green: positive upload/replace/delete/retry
(`video-usage-storage.test.ts:73-177`), evidence redaction (`:387-407`), tenant isolation
(`video-usage-storage.test.ts:371-378`, `media-usage-reconciliation.test.ts:407-436`,
`video-usage-replay.test.ts:92-108`), unit separation (`video-usage-storage.test.ts:483-497`), signature
coverage (`video-usage-storage.test.ts:724-759`).

**Criterion 3 — production meter still honestly unconfigured.** `server/src/routes/video-assets.ts:675-695`
composes `createVideoAssetLifecycle({ store: createSqlVideoAssetStore(lazyDb), verifyCallbackSignature:
verifyProviderCallbackFromEnv })` — **no `meterStorage`** — with the omission explained at `:680-691`.
`server/src/services/video-asset-lifecycle.ts:531-583`: when a verified `ready` callback carries bytes and no
meter is composed, the outcome is `metering: 'unconfigured'` (`:538`) plus the audit
`video.asset.metering_unconfigured` (`:539-547`, reason `meter_not_configured`, byte count in `newValue`) — an
auditable gap, not a silent drop. Regression test: `video-usage-storage.test.ts:663-693`. No invented table,
adapter, migration or DDL claims production wiring: `grep -r media-usage-reconciliation server/src` returns
one comment in `video-usage-events.ts:31` and nothing else; the durable shapes exist only as the described
I2 requests in section (D).

**Restated, because it bounds every claim above:** the injected in-memory store's serialization and rollback
is a **model of the contract at the seam — it is not proof about MySQL** (InnoDB row/gap locking, deadlock
detection, `ER_DUP_ENTRY` under the real unique index). Production metering remains **unconfigured** until
separately reviewed SQL/wiring (I2-1…I2-5, section D) lands. Neither this pass nor the inherited correction
makes storage metering operational.

### (F.3) Commands run and measured counts (this pass, native output)

All from `server/`, hermetic:

```
M1_NETWORK_MODE=hermetic node --require ../scripts/m1-network-guard.cjs --import tsx --test tests/<file>
```

| suite | result |
|---|---|
| `tests/video-usage-storage.test.ts` | `# tests 27` `# pass 27` `# fail 0` `# skipped 0` `# todo 0` — exit 0 |
| `tests/video-usage-replay.test.ts` | `# tests 7` `# pass 7` `# fail 0` — exit 0 |
| `tests/media-usage-reconciliation.test.ts` | `# tests 14` `# pass 14` `# fail 0` — exit 0 |
| **total** | **48 pass, 0 fail, 0 skipped, 0 todo** |

Typecheck, from the repo root:

```
node node_modules/typescript/bin/tsc --noEmit -p server/tsconfig.json
→ exit 0, zero diagnostics
```

The doc's C.2 secondary claim was also re-verified (explicit strict typecheck of the three test files, since
`server/tsconfig.json` includes `src/**/*` only — confirmed by reading `server/tsconfig.json`): exit 0, zero
diagnostics.

Additional factual claims re-verified against current code, all matching: the router mount
(`server/src/index.ts:257` → `/api/video-assets`); the `video_usage_events` DDL in
`server/migrations/20261018_06_video_assets_entitlements.sql` (no transition discriminator);
`hb:{session}:{bucket}` / `cb:{provider}:{event}` / `st:{assetId}:{operationId}` key shapes; zero production
importers of `media-usage-reconciliation.ts`; no money/student-count terms in the W6 sources; the five
pre-existing suites named in C.2 exist on disk (their historical 165/165 result is inherited evidence from
the original pass — not re-run here, per the no-full-suite rule while other lanes write).

### (F.4) What I changed in this document (my only edits)

Four stale line references in the (A.2) acceptance matrix, left over from the pre-correction code, corrected
to the current file:

1. item 1: `media-usage-reconciliation.ts:117` → `:152`; `video-asset-lifecycle.ts:394-412` → `:403-421`;
2. item 2: `media-usage-reconciliation.ts:119` → `:154`;
3. item 5: `:207-235, :399-402` → `:320` (fold at `:295-323`) and `:512`;
4. item 14: `routes/video-assets.ts:667` → `:692`.

Plus this section (F). No inherited section was deleted or reworded; every inherited hash table, probe
result, scenario map and limit stands as written.

### (F.5) Residual limits (unchanged from (E), confirmed by this pass)

The meter is still `unconfigured` in production; the in-memory rollback is not MySQL proof; `deferred` still
means "not recorded" (no outbox — I2-4); reconciliation is unscheduled with no SQL adapter (I2-5); the
usage-callback signature tightening needs provider coordination (C.6 of the original pass); `/usage/summary`
still sums absolute observations; no full suite was run. Nothing here is accepted.
