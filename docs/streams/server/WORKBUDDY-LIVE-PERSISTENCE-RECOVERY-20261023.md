# WORKBUDDY — live persistence & recovery delivery (2026-10-23)

Task `server-live-persistence-recovery-20261023-01` · team `media` · approvalVersion 2 · access `write`
Repo `C:/Users/abdua/OneDrive/سطح المكتب/FreeLance_25-1` · branch `codex/workbuddy-server` · HEAD `cab9120`

**Authorship.** This document is written by the **lane supervisor** and consolidates three workers that ran on
disjoint files under one claim. Per-file attribution is in §2; nothing here is presented as a single worker's work.
The claim holder (`wb-live-persistence-session-20261023-01`) filed the bridge report.

**Scope statement.** Source only. No test was created, edited or run; no database, Docker, listener, SQL execution,
provider call, secret, Git mutation, push or deploy was performed. Every claim below about MySQL is a **requirement
written into source**, never an observed behaviour.

---

## 1. Schema ground truth (read-only, pinned)

`C:/Users/abdua/.codex/worktrees/claude-platform-closure/FreeLance_25-1/server/migrations/20261022_06_live_sessions_recordings.sql`
· 1,066 lines · sha256 **`391d02304861095056f89daf69c228e5149f8ac44ba5d499ddc0dea646566846`** · mtime 2026-10-22 18:58.
Re-hashed after every worker stopped: **unchanged**. No DDL was written, edited or executed by this lane.

Five tables, and what the adapters actually use:

| table | columns used | constraints that carry correctness |
|---|---|---|
| `live_sessions` | `id, tenant_id, host_user_id, title, state, provider, provider_room_id, starts_at_ms, ended_at_ms, max_participants, created_at_ms` | `uq_live_session_room`, `chk_live_session_ended`, `chk_live_session_max_participants` |
| `live_session_participants` | `id, tenant_id, session_id, user_id, role, ticket_fingerprint, joined_at_ms, last_seen_at_ms, left_at_ms` | `uq_live_participant (session_id,user_id)`, `idx_live_participant_active` |
| `live_session_callbacks` | `id, tenant_id, session_id, provider, event_id, kind, occurred_at_ms, outcome` | `uq_live_callback (tenant_id,provider,event_id)`, `chk_live_callback_outcome` |
| `live_recording_ingests` | all 12 columns incl. `claim_owner`, `claim_expires_at_ms` | both unique keys, `chk_live_ingest_lease_pair`, `chk_live_ingest_terminal_release`, `idx_live_ingest_pending` |
| `live_session_presence_intervals` | `id, tenant_id, session_id, participant_id, user_id, joined_at_ms, left_at_ms, close_reason` | `uq_presence_interval`, `chk_presence_left_reason` |

R12 (lease columns), R14 (pending index) and R10 (presence table) are **already in this DDL** — this task consumes
them, it did not request them again. R13 is adapter SQL by the migration's own header, which is where it was written.

---

## 2. Files, before → after, attribution

| file | before | after | worker |
|---|---|---|---|
| `server/src/services/live-session-sql.ts` | ABSENT | 42,897 B `901fa6f15e5b06eb…` | session/presence (claim holder) |
| `server/src/services/live-presence-sql.ts` | ABSENT | 12,331 B `8bdd9cd2e86aa2f2…` | session/presence |
| `server/src/services/live-recording-ingest-sql.ts` | ABSENT | 34,902 B `bdf54d22ccc01db4…` | ingest/recovery |
| `server/src/services/live-recording-recovery.ts` | ABSENT | 14,943 B `726edbdc9dd1e857…` | ingest/recovery |
| `server/src/services/live-runtime-factory.ts` | ABSENT | 12,104 B `e23a296968e51cf6…` | session/presence (phase 7) |
| `server/src/services/live-session-core.ts` | 61,961 B `fdc5034a…` | 74,089 B `750e7d9d…` | session/presence |
| `server/src/services/live-recording-ingest.ts` | 49,310 B `d4f53437…` | 63,694 B `37b12472…` | ingest/recovery |
| `server/src/services/video-asset-lifecycle.ts` | 50,082 B `cb645431…` | 63,213 B `bac163a7…` | library/metering |
| `server/src/services/media-usage-reconciliation.ts` | 58,871 B `b820557e…` | **unchanged** | library/metering (no defect found) |
| `server/src/routes/live-sessions.ts` | 10,943 B `44af3355…` | **unchanged** | session/presence (composition did not need it) |
| this document | ABSENT | new | supervisor |

`git status` went 37 → 45 entries: +5 new adapters, +this doc, +3 Codex files written at 02:35–02:36 (not this lane).
No file outside the 11 `allowedPaths` was written; the only mtimes after the baseline belong to the paths above.

---

## 3. Phase 2 — durable session store

- **Injected, connection-bound executor.** `LiveSessionSqlConnection` = `query` / `queryOne` / `execute` /
  `transaction`. No db/pool import, no statement at import time, no top-level side effect.
- **`withTransaction` is mandatory** and runs `work` on the transaction's own connection.
- **Sealed audit is mandatory.** The factory throws `invalid_deps` without a `sealedAudit` writer — no no-op, no
  `INSERT INTO audit_events` shortcut. The connection object handed to the writer deliberately has **no**
  `transaction` property, so `recordSealedAuditEvent` takes its "caller is already on one transactional connection"
  path: head lock, leaf read and append all run on the unit's connection.
- **Admission**: `SELECT … FOR UPDATE` on the **session** row → `SELECT COUNT(DISTINCT user_id) … WHERE left_at_ms IS
  NULL` inside the lock → refresh or insert. A rejoin refreshes the existing `uq_live_participant` row and returns
  `created:false` without consuming a second seat; a *reactivation* of a left participant does consume one and is
  refused when the room is full. `activeCount` is distinct active users, never rows, never joins.
- **CAS checked before success**: `updateSessionState` is `WHERE id=? AND tenant_id=? AND state=?` and
  `finalizeCallback` is `WHERE id=? AND outcome='pending'`; both return affected rows and the core treats 0 as
  `conflict`, never as success.
- **Callback outcome strings match `chk_live_callback_outcome` exactly** (`pending`, `applied`,
  `rejected:illegal-transition`, `ignored:unknown-participant`, `ignored:malformed`).
- **Tenant predicate on every read and write.** The single tenant-less read is `findSessionByProvider`, by design: a
  provider callback carries no caller tenant, so the tenant is read **from** the row and the core treats that row as
  the authority. `markParticipantLeft` and `finalizeCallback` gained an **optional** tenant parameter so those writes
  can carry the predicate; the adapter refuses a tenant-less call with `tenant_required`.
- **BIGINT safety**: exact `BigInt` comparison for every epoch-ms read, `Number.isSafeInteger` on every write; an
  unsafe value throws `unsafe_bigint` instead of truncating.

## 4. Phase 3 — recording ingest store (R13)

```sql
-- claimPending (one statement, affected rows)
UPDATE live_recording_ingests
   SET claim_owner = ?, claim_expires_at_ms = ?
 WHERE id = ? AND outcome = 'pending'
   AND (claim_owner IS NULL OR claim_expires_at_ms <= ?)

-- finalizeIngest (one statement, affected rows; 'pending' is the RELEASE form)
UPDATE live_recording_ingests
   SET outcome = ?, claim_owner = NULL, claim_expires_at_ms = NULL
 WHERE id = ? AND outcome = 'pending' AND claim_owner = ?
```

Owner and expiry are written **together** (the CHECK would reject half a lease; the adapter refuses earlier with
`invalid_input`). The release form keeps `outcome` unchanged and clears both claim columns — that clear is the **only**
reason a release reports `1` under MySQL's changed-rows semantics, so `0` always means the fence was lost. The
terminal form also satisfies `chk_live_ingest_terminal_release` because it clears in the same statement.

- **No external call inside a DB unit.** The meter and the library stay in the service between units.
- **A `pending` conflict is not "completed".** A lost insert re-reads the conflicting row inside the same unit and
  either fences it or reports `claim-held`; only a terminal row becomes `duplicate`.
- **Terminal replay compares the payload** (session, recording id, duration, bytes) and returns
  `{status:'conflict', reason:'payload-mismatch', fields:[…]}` with a `live.recording.replay_conflict` audit when it
  disagrees. `occurred_at_ms` and `title` are deliberately not compared.
- **A losing finalize writes no success audit** (`finalize_lost`, `deferred/claim-lost`).
- **`library-unconfigured` / `deferred` are unchanged** — the required library sink still decides terminality; nothing
  here can turn an absent sink into `ingested`.

## 5. Phase 4 — bounded recovery

`runRecordingRecoveryOnce(deps, options)` — explicit call only. No timer, no `process.on`, no start-on-construct.

| bound | default | ceiling |
|---|---|---|
| batch cap (rows consumed) | 200 | 1,000 |
| page size | 50 | 200 |
| attempts per row per pass | 1 | 3 |
| wall clock | 30 s | 120 s |

- **Keyset pagination** over `(occurred_at_ms, id)`, `WHERE outcome='pending' AND (occurred_at_ms > ? OR (occurred_at_ms = ? AND id > ?))`, `ORDER BY` the same pair, no `OFFSET`. An offset scan counts a result set other workers are shrinking: every settled row slides the next one into the slot just stepped over.
- **The lease is claimed before any sink** — the pass calls `service.resumePending`, which runs the same
  `claimPending` CAS a callback runs. A row it cannot claim is skipped, not processed.
- **It reuses the ingest path**, not a parallel writer. `resumePending({tenantId, provider, eventId})` takes a **key,
  never a payload**, so it cannot inject facts a signature did not cover; it skips signature verification only, and
  re-checks the ledger row, the session row, the tenant, the grace window and the caps from server rows.
- **No blind external resend, no provider retry loop.** A throw is reported `deferred`, never `done`; the marker stays
  `pending` and the lease expires.
- The report tallies `scanned / claimed / resumed / settled / deferred / skipped / alreadyTerminal / conflicts` plus
  per-reason counters, so a claim taken and abandoned cannot hide inside an aggregate.

## 6. Phase 5 — presence intervals

- Opened in the **same unit** as admission/join; closed in the **same unit** as leave, a verified `participant.left`
  callback, and session end (host path and verified `session.ended`).
- **Close cannot precede its open**: `AND joined_at_ms <= ?`. **Close happens once**: `AND left_at_ms IS NULL`, affected
  rows checked, and the caller writes no second audit.
- **A rejoin appends a new interval** — history is never overwritten. Two opens in the same millisecond collide on
  `uq_presence_interval`; that is reported as "already open", never as a crash and never as a silent overwrite.
- `attendance()` reads the real intervals when the store exposes them and falls back to the single participant row
  otherwise. The fallback keeps the documented limitation instead of pretending. `AttendanceReport`, `mergeIntervals`,
  the clamping and `countOpenPresence` are unchanged.
- **No automatic school attendance, no branch-only authority, no invented policy.** Presence grants nothing.

## 7. Phase 6 — library promotion

`createRecordingLibraryPort(runner, idFactory)` in `video-asset-lifecycle.ts`:

```sql
INSERT INTO video_assets (id, tenant_id, owner_user_id, provider, provider_asset_id, title)
VALUES (?, ?, ?, ?, ?, ?)
-- on ER_DUP_ENTRY, same connection:
SELECT id, tenant_id, provider, provider_asset_id FROM video_assets
 WHERE provider = ? AND provider_asset_id = ? LIMIT 1
```

| branch | result |
|---|---|
| first promotion | `{created:true, assetId}` |
| duplicate, same tenant, key exact | `{created:false, assetId: existing.id}` |
| duplicate, **other tenant** | throw `cross_tenant_collision` → ingest maps to `library:'deferred'`, marker stays `pending`; the other tenant's row is never read out or overwritten |
| duplicate, row does not match the sent key (case-insensitive collation) | throw `key_collision` (deferred) |
| recording id unrepresentable (>128, empty, outside the grammar) | throw `unrepresentable_key` (deferred) — never truncated |
| no owner | throw `owner_missing` (deferred) |

No `ON DUPLICATE KEY UPDATE` anywhere: it would let tenant B overwrite tenant A's row. `status` keeps its column
default (`uploaded`) — this lane publishes nothing.

**Owner chain (closed in this task).** `live_sessions.host_user_id` → `RecordingSessionRef.hostUserId` →
`RecordingAssetDescriptor.ownerUserId` → `video_assets.owner_user_id`, with a CHAR(36) bound that yields `null` rather
than a truncated id. Without it every promotion failed closed, so phase 6 would have shipped dead.

**Tenant-safe lookup: no defect found.** `findAssetByProvider` is tenant-less by design and the lifecycle rejects a
signed claim that disagrees with the stored tenant before any write; the CAS update is also scoped by the row's
tenant. Nothing was changed to look busy.

**Metering: already fails closed, not wired.** `recordVerifiedBytes` resolves `findAssetTenant(assetId)` and returns
`unknown asset` **before** `insertEvent` or either counter write, so an unresolvable id commits nothing and increments
nothing. The remaining gap is ordering in the ingest (it meters a synthetic provider-scoped id *before* the library
write), which is a wiring decision, not a persistence defect — see §9.

## 8. Phase 7 — runtime factory

`createLiveRuntime(deps) → LiveRuntime { core, ingest, sessionStore, ingestStore, library, status, router, runRecoveryOnce }`.

- `executor` and `sealedAudit` are **required** and throw at construction; there is no default and no no-op.
- `status` declares every capability: `sessions`, `presence`, `ingest`, `library`, `metering`, `recovery`,
  `sealedAudit`, `callbacks`, `ticketSigning`, `router`, plus a `reasons` map. `metering` is a **literal
  `'unconfigured'`** so no code path can claim it configured.
- Missing signature verifiers default to deny-all (refuse + audit), never to trust.
- No mount, no `index.ts` edit, no provider implementation, no real session, no timer, no schema probe.

**Source trace (read, not executed).**

| path | units that commit | caller observes |
|---|---|---|
| happy | U1 claim (marker+lease) → external library → U2 terminal CAS+audit | `ingested`, `library:'created'|'existing'`, `metering:'unconfigured'` |
| replay | U1 read-only (settled) → U2 dedupe audit | `duplicate / event-replay` |
| conflict | U1 read-only → U2 conflict audit | `conflict / payload-mismatch` + fields |
| rollback | throw inside a unit → ROLLBACK + rethrow; the external asset may exist (idempotent) but the ledger transition and its audit both roll back | the call rejects; marker stays repairable |
| lease lost | `claimPending`=0 → contended audit, no external call; or terminal CAS=0 → `finalize_lost`, no success audit | `deferred / claim-held` or `claim-lost` |
| missing schema | first statement throws `ER_NO_SUCH_TABLE` → ROLLBACK → rethrow; no marker, no external call | a rejection, nothing committed |
| two tenants | `(provider, provider_room_id)` is globally unique; a disagreeing signed claim → one audit in the **row's** tenant, no ledger row; every read carries `tenant_id = ?` | `rejected / cross-tenant`; tenant B never sees A's rows |

## 9. Per-item status

| item | status |
|---|---|
| session store (phases 2) | **implemented**, **live-unproven** — no database was contacted |
| presence intervals (phase 5) | **implemented**, in-memory fallback preserved, **live-unproven** |
| ingest store + R13 fence (phase 3) | **implemented**, **live-unproven**; the service-level fence was already test-proven in the previous task |
| bounded recovery (phase 4) | **implemented**, **live-unproven**; no pass was ever run |
| library promotion + owner chain (phase 6) | **implemented**, **live-unproven**; the cross-tenant branch cannot be exercised without a database |
| metering for recordings | **policy-held / not wired** — needs the promoted `video_assets.id`, i.e. metering *after* the library write |
| runtime factory (phase 7) | **implemented**, **unmounted**; `server/src/index.ts` untouched |
| tests | **not written, not run** — the task forbids it |
| HTTP surface | **unchanged** — `live-sessions.ts` is byte-identical |

## 10. Requests

**To Claude (schema owner) — nothing was added to the schema.**

- **R16** `video_assets.uq_video_asset_provider (provider, provider_asset_id)` is **global**. Add
  `UNIQUE KEY uq_video_asset_tenant_provider (tenant_id, provider, provider_asset_id)`. Dropping the global key would
  make `findAssetByProvider` ambiguous (callbacks are tenant-less by design), so that is a contract decision, not a
  mechanical fix. Today the global key makes a cross-tenant recording-id collision **unrepresentable**, and the
  adapter fails closed instead of filing one tenant's recording under another.
- **R17** `provider` and `provider_asset_id` are `utf8mb4_unicode_ci`, so the unique key treats `REC-1` and `rec-1`
  as the same key. They should be `utf8mb4_bin`. The adapter detects the mismatch and fails closed; only the schema
  can guarantee it.
- **R18** columns with no home today (all nullable, nothing depends on them): `session_id CHAR(36) NULL` +
  `KEY idx_video_assets_session (tenant_id, session_id)`, `duration_seconds INT UNSIGNED NULL`, `recorded_at
  TIMESTAMP NULL`, `source_event_id VARCHAR(128) NULL`, `visibility ENUM('unpublished','published') NOT NULL DEFAULT
  'unpublished'`. No `provider_recording_id` column is requested — that mapping *is* `provider_asset_id`.
- **R19** `live_session_presence_intervals` has no actor column: an interval proves *which participant* was present,
  not *which principal* opened or closed it. If per-interval attribution is required, add nullable
  `opened_by_user_id` / `closed_by_user_id` or `cause_event_id`. It was not faked.
- **R20** `uq_presence_interval (session_id, user_id, joined_at_ms)` cannot represent two presence periods that start
  in the same millisecond. A rejoin in that millisecond is refused honestly rather than overwriting; fixing it needs a
  sequence component in the key.
- **R21** the R9/R14 index `(outcome, claim_expires_at_ms)` does **not** serve the recovery's keyset order
  `(occurred_at_ms, id)`; add `KEY idx_live_ingest_scan (outcome, occurred_at_ms, id)`. Correctness is unaffected (the
  scan cannot skip a row); this is a scan-cost request.
- **Contract text correction** — §4's participant-refresh `SET` order was wrong for MySQL: `SET left_at_ms = NULL,
  joined_at_ms = IF(left_at_ms IS NULL, …)` reads the value the same statement just wrote, because MySQL evaluates
  `SET` left to right. The adapter assigns `joined_at_ms` first. §4 should say so.

**To Codex (mount) — one router only.**

```ts
import { createLiveRuntime } from './services/live-runtime-factory';
import { recordSealedAuditEvent } from './services/audit-log';
// optionalAuth is already imported at :89 — reuse it.

const liveExecutor = {
    query:   (sql, params) => query(sql, params),
    queryOne: (sql, params) => queryOne(sql, params),
    execute: (sql, params) => execute(sql, params),
    transaction: (work) => withTransaction((conn) => work(connBoundAccess(conn))),
};

const liveRuntime = createLiveRuntime({
    executor: liveExecutor,
    sealedAudit: recordSealedAuditEvent,
    verifyLiveCallbackSignature: /* provider adapter */,
    verifyRecordingCallbackSignature: /* provider adapter */,
    ticketSecret: process.env.LIVE_TICKET_SECRET,
    optionalAuthenticate: optionalAuth,
});

if (liveRuntime.router) app.use('/api/live-sessions', liveRuntime.router);
```

Must **not** be mounted: a `/api/live-recordings` router (none exists; the provider webhook must be a separately
reviewed route that calls `liveRuntime.ingest.ingest(callback)`), `runRecoveryOnce` on any route (operator-only), and
anything at all when `liveRuntime.router === null`. Express is **4.18**, so an async handler that rejects is not
forwarded to the error handler — the mount needs an async-error boundary or a missing-schema throw becomes an
unhandled rejection.

## 11. Limits — what this delivery does not prove

- **No database was contacted.** Isolation level, `FOR UPDATE` acquisition and ordering, deadlock behaviour,
  `ER_DUP_ENTRY` codes and message text, `affectedRows`/changed-rows semantics, `LIMIT` inside `UPDATE … ORDER BY`,
  and the driver's BIGINT mapping are all **requirements in source**, not observations.
- **No test was written or run** (forbidden by the task). The existing suites were read, not executed; the ingest
  changes were argued case-by-case against all 12 existing tests and are expected to pass, which is not the same as
  passing.
- **Nothing is mounted.** The factory is composed by nothing; `index.ts` is untouched.
- **The executor adapter in §10 is a request**, not shipped code — it lives in Codex's file.
- The presence fallback path still cannot represent two intervals for an adapter without the interval port; the
  documented limitation is narrowed, not removed.
- `attendance()` is three reads, not a snapshot: a concurrent write can skew a report marginally. Pre-existing.
- A verified `participant.joined` callback reactivates a participant row through `upsertParticipant`, not
  `admitParticipant`, so a provider-driven rejoin can exceed `max_participants` when it races an admission.
  Pre-existing, reported, not changed (fixing it is a behaviour change, not a persistence fix).
- ~~A verified `participant.joined` also refreshes the participant row with the pre-read join time, so a rejoin keeps
  the **old** `joined_at_ms` in the legacy single-row path.~~ **Closed in §13.3**: a rejoin now writes the accepted
  `occurredAtMs` to both the row and the new interval.
- ~~A stale `participant.left`/`participant.joined` callback could be applied because ordering was inferred from
  `lastSeenAtMs`, which is an activity mark, not an event identity.~~ **Closed in §13.3** (fail-closed, §13.5).

## 12. Write stop

All writes stopped at the moment this document was written; the last code write was `live-recording-ingest-sql.ts`
(34,902 B, `bdf54d22…`). `tsc --noEmit -p server/tsconfig.json` → **exit 0** over the whole project after the final
edit. The claim was released by the bridge report; `queue_status.active` is empty.

`reported` ≠ `accepted`. Acceptance is Codex's.

---

# 13. Source correction (Codex review, 2026-10-23)

Task `server-live-persistence-source-correction-20261023-01`, from
`CODEX-LIVE-PERSISTENCE-SOURCE-CORRECTION-20261023.md`. The §1–§12 delivery was **not accepted** and was **not
resubmitted**: this section records only the delta. Same 11 paths, same reservation, same write stop — no new file
was created in the repository, and no test, SQL statement, migration, mount, DB, Docker, listener, provider call or
Git mutation was performed.

Three defects were named. Each is a real defect in the delivered source, not a documentation gap.

## 13.1 L1 — a stuck `pending` row can no longer starve newer rows

**Defect.** The recovery scan always started at the head of the pending set and the ingest never terminalised a row
it had permanently refused. A row that was claimed while its session was still `live` and then failed in the library
stayed `pending` after the session `ended`; every later pass re-read it first, the grace check refused it, nothing
settled it, and it consumed one of the 50 batch slots on every pass for ever. A caller that simply called
`runRecoveryOnce` in a loop would never reach newer rows.

**Fix, in three layers that each stand alone:**

1. **Continuation (cooperative).** `runRecoveryOnce` accepts `options.after` and returns `report.continuation` plus
   `report.sweepComplete`. The continuation is the key of the last row the pass actually **inspected** — claimed,
   skipped, quarantined or deferred — not the last one it claimed, so a pass that inspects nothing (an immediately
   expired wall clock) does not make the caller lose its place. A completed sweep returns `continuation: null` so the
   next pass starts at the beginning again and picks up a row inserted mid-pass with an earlier key. Persisting the
   continuation between invocations is the **caller's** obligation: there is no `setInterval`, no `process.on`, no
   module-level cursor and no automatic retry in either file. A caller that discards the continuation is documented
   as re-creating the old behaviour — which is why the next layer exists.
2. **Lease filter (correctness).** The keyset scan now also requires
   `(claim_owner IS NULL OR claim_expires_at_ms <= ?)`, so a row another worker is actively holding is not offered to
   this pass at all. It does not change the access path: `idx_live_ingest_pending (outcome, occurred_at_ms, id)`
   still supplies the range and the order, and the two lease columns are a residual filter on rows the index already
   narrowed, bounded by `LIMIT`. No new column, no new index, no DDL. `LIMIT` is clamped and sent through the text
   protocol; no caller value reaches a statement as SQL.
3. **Fenced terminal quarantine (self-healing).** The only rows this correction is authorised to settle are the two
   whose terminality is provable *and permanent*: `ended` with `ended_at_ms` set and `occurred_at_ms > ended_at_ms +
   grace_ms` → `ignored:outside-grace`, and `cancelled` → `ignored:session-cancelled`. Both are terminal in
   `LEGAL_SESSION_TRANSITIONS` (no transition leaves either), so a proof that holds now still holds later — which is
   exactly why a `scheduled` row is **not** quarantined: it can still go `live`. The transition is fenced:
   `findIngest` → `claimPending` CAS → **session re-read on the same unit** → proof re-evaluated → `finalizeIngest`
   with `expect:{owner}` → `live.recording.ignored` audit carrying the proof (`session_state`, `ended_at_ms`,
   `occurred_at_ms`, `grace_ms`, `ledger_outcome`). `0` from either CAS means this attempt does not own the row: no
   audit, no success claim, the row is left exactly as the other writer left it. The audit action is
   `live.recording.ignored`, **never** `live.recording.ingested`.

**Deliberately NOT terminalised** — these stay `pending` and remain retryable: a throw, a meter error, `claim-held`,
an unknown session, a read failure, a `scheduled` session, the descriptor caps, a reason that did not survive the
fence, and any store without `claimPending` (`claim-unavailable`) or without `findSessionById` (no proof ⇒ no write;
the lease is handed back with `outcome:'pending'`).

**Report shape.** `quarantined` is a new tally with a per-reason split in `quarantinedReasons`, counted as progress
separately from `settled` and `resumed`. A quarantine is not an ingest and is never counted as one.

## 13.2 L2 — `providerParticipantId` is resolved, never equated with `userId`

**Defect.** The core resolved a provider participant by
`participants.find(row => row.userId === providerParticipantId)`. That treats a provider's opaque participant
identifier as an application user id. Any provider that issues ids that happen to collide with a real user id — or a
caller that can choose the id — could drive presence for a user it does not own.

**Fix.** The equality resolution is **deleted** (grep for `userId === providerParticipantId` in
`live-session-core.ts` returns only the null/undefined guard on the callback field). Participant callbacks now require
an injected `resolveProviderParticipant({tenantId, sessionId, provider, providerParticipantId})`. The contract:

- **Absent resolver ⇒ fail closed.** The callback finalises `ignored:mapping-unavailable` with the provider identity
  kept as bounded *evidence* (`provider_participant_id`), never used as a participant or user id. `session.started` /
  `session.ended` never consult the resolver and are unaffected.
- **The resolver's answer is re-validated against THIS session.** The core re-reads the session's participants and
  requires a row whose `id` **and** `userId` both match the resolver's answer. A resolver that names a participant of
  another session or tenant produces `ignored:unknown-participant`, not a write. The mapping is server-established;
  the callback is never the authority.
- `createInternalUserIdParticipantResolver` is exported as an explicit opt-in helper and is **never auto-wired**:
  `grep -rn createInternalUserIdParticipantResolver src/` finds only its definition and its own doc comment. The
  factory reports `participantMapping: 'configured' | 'unconfigured'` as a capability, so a composition that forgot
  the resolver is visible in `status` rather than silently permissive.

## 13.3 L3 — a stale callback can neither resurrect nor evict, and rejoin time is corrected

**Defect.** Ordering was inferred from `lastSeenAtMs`, which is an activity mark, not an event identity. A delayed
`participant.joined` arriving after a `participant.left` reactivated a departed participant; a delayed
`participant.left` evicted a participant who had already rejoined. The rejoin also wrote the **pre-read** join time,
so the participant row and the interval it opened disagreed.

**Fix.** Presence ordering is per participant and runs **before** any state change, through an optional CAS port:

```ts
readPresenceCursor?(tenantId, sessionId, participantId): Promise<PresenceEventCursor | null>;
advancePresenceCursor?(input: {tenantId; sessionId; participantId;
    expected: PresenceEventCursor | null; next: PresenceEventCursor }): Promise<number>;
```

`PresenceEventCursor` is `{eventAtMs, eventId}` — the pair, because a timestamp without an event id cannot say
*which* event set it (R20). Decision table, all fail-closed:

| condition | marker | state / intervals / success audit |
| --- | --- | --- |
| either port absent | `ignored:ordering-unavailable` | untouched |
| `occurredAtMs < cursor.eventAtMs` | `ignored:stale-event` | untouched |
| `occurredAtMs === cursor.eventAtMs` | `ignored:ambiguous-event` | untouched (no fabricated +1 ms, no id-as-time comparison) |
| CAS returns ≠ 1 (lost the race) | `ignored:stale-event` | untouched |
| CAS returns 1 | applied | written |

Rejoin is fixed: `joinedAtMs: wasLeft ? occurredAtMs : participant.joinedAtMs` on the row, and the interval opened
below uses the same `occurredAtMs`, so row and interval agree on the accepted instant. A `participant.left` closes an
interval only when `markParticipantLeft` actually moved the row (`left > 0`), so a repeated left closes nothing.
`lastSeenAtMs` stays an activity mark and is no longer the ordering authority.

The in-memory unit used by the core's own composition implements the CAS against a per-participant map
(`presenceCursors`) with the same `expected`/`next` semantics, so the ordered path is exercised by the same code that
runs in production, not only by the SQL adapter.

## 13.4 Before → after hashes (measured by the lane supervisor, not reported by a worker)

Baseline `handoff/WORKBUDDY-LIVE-CORRECTION-BASELINE-20261023.txt` captured **before** any write, at
`2026-10-23 03:44:57 +0300`. Re-measured after both workers finished:

| # | path | before (sha256) | after (sha256) | bytes | state |
| --- | --- | --- | --- | --- | --- |
| 1 | `server/src/services/live-session-core.ts` | `750e7d9d…` | `c4328d4a…` | 74,089 → 85,882 | moved (L2+L3) |
| 2 | `server/src/services/live-session-sql.ts` | `901fa6f1…` | `3ed58659…` | 42,897 → 45,031 | moved (header + R22/R23 request; **no cursor implementation**) |
| 3 | `server/src/services/live-runtime-factory.ts` | `e23a2969…` | `82127d8d…` | 12,104 → 15,852 | moved (participantMapping, continuation pass-through) |
| 4 | `server/src/services/live-recording-ingest.ts` | `37b12472…` | `20d18b8a…` | 63,694 → 76,030 | moved (L1 quarantine) |
| 5 | `server/src/services/live-recording-ingest-sql.ts` | `bdf54d22…` | `4df9f3f6…` | 34,902 → 37,787 | moved (lease filter, terminal outcomes) |
| 6 | `server/src/services/live-recording-recovery.ts` | `726edbdc…` | `6d580cdb…` | 14,943 → 21,374 | moved (continuation, sweepComplete) |
| 7 | `server/src/services/live-presence-sql.ts` | `8bdd9cd2…` | `8bdd9cd2…` | 12,331 | **byte-identical** |
| 8 | `server/src/routes/live-sessions.ts` | `44af3355…` | `44af3355…` | 10,943 | **byte-identical** |
| 9 | `server/src/services/media-usage-reconciliation.ts` | `b820557e…` | `b820557e…` | 58,871 | **byte-identical** |
| 10 | `server/src/services/video-asset-lifecycle.ts` | `bac163a7…` | `bac163a7…` | 63,213 | **byte-identical** |
| 11 | this document | `20587f99…` | `afac333c…` → final hash carried in the bridge report | 21,982 → ~37,579 | moved (this section only) |

**6 moved, 5 byte-identical, 0 outside the 11 paths.** The out-of-scope check is a filesystem query, not an
inference: `find server docs -type f -newermt "2026-10-23 03:44:58"` returns exactly the six code files above and
nothing else — no test file, no migration, no `index.ts`, no new file. `tsc --noEmit -p server/tsconfig.json` →
**exit 0** over the whole project, run by the supervisor after the last write.

Row 7 (`live-presence-sql.ts`) being byte-identical is the point of §13.5: the adapter was **not** given a cursor it
cannot honestly implement.

## 13.5 New held capabilities — two precise schema requests

These are the reason two of the three corrections are fail-closed rather than live. They are requests, not DDL
executed here, and they belong to Claude (schema source).

**R22 — presence event cursor.** `live_session_participants` has no column that identifies *which* event last moved
the row, so `live-session-sql.ts` deliberately does **not** implement `readPresenceCursor`/`advancePresenceCursor`.
Their absence is the fail-closed signal the core reads.

```sql
ALTER TABLE live_session_participants
  ADD COLUMN presence_event_at_ms BIGINT NULL,
  ADD COLUMN presence_event_id    VARCHAR(128) NULL,
  ADD CONSTRAINT chk_live_participant_presence_cursor
    CHECK ((presence_event_at_ms IS NULL) = (presence_event_id IS NULL));
```

The pair is written together because a cursor without an event id cannot say which event set it (R20). The CAS must
then be one statement on the participant row, inside the same session/participant unit:

```sql
UPDATE live_session_participants
   SET presence_event_at_ms = ?, presence_event_id = ?
 WHERE tenant_id = ? AND session_id = ? AND id = ?
   AND ((presence_event_at_ms IS NULL AND ? IS NULL)
        OR (presence_event_at_ms = ? AND presence_event_id = ?));
```

**R23 — `chk_live_callback_outcome` must admit the four new terminal outcomes.** The CHECK currently admits only
`pending`, `applied`, `rejected:illegal-transition`, `ignored:unknown-participant`, `ignored:malformed`. The core can
now request `ignored:mapping-unavailable`, `ignored:ordering-unavailable`, `ignored:stale-event`,
`ignored:ambiguous-event`. Until the CHECK is extended, this adapter refuses them with `invalid_outcome` and the unit
**rolls back** — no state change, no success audit, and no marker either, so no stuck `pending` row accumulates. The
TypeScript enum stays exactly the database enum; no widening on the code side.

**Consequence, stated plainly:** with today's adapter, a `participant.joined`/`participant.left` callback is
**refused** (R22 first, R23 second) rather than recorded as ignored. Presence application on this store is inert —
by design, and only until R22+R23 land. `session.started`/`session.ended` are unaffected.

## 13.6 Limits of this correction

- **Still no database was contacted.** The lease predicate's behaviour on a NULL expiry, the residual-filter/LIMIT
  interaction with `idx_live_ingest_pending`, `FOR UPDATE` acquisition order, and the CAS `affectedRows` semantics
  under MySQL's changed-rows default are **requirements in source**, not observations. The recovery's
  `page.length < pageSize ⇒ sweepComplete` inference is sound only because the adapter's `MAX_PENDING_PAGE` (500) is
  above the recovery's `RECOVERY_PAGE_SIZE_CEILING` (200), so the adapter never clamps a page below what was asked
  for and truncates it into a false "sweep complete". That is an argument, not a measurement.
- **No test was written, edited or run** (forbidden by the task). The continuation cursor, the lease filter, the
  quarantine fence, the resolver re-validation and the presence CAS have **no** executed coverage. Any statement that
  they "pass" would be false.
- **The continuation is not persisted by anything.** `runRecoveryOnce` returns it; no scheduler, timer or durable
  cursor stores it. Without a caller that persists it, only the quarantine layer prevents starvation, and only for
  the two provable reasons. A row stuck `pending` for a transient reason is still re-listed first on every sweep —
  that is intentional (it is retryable) and is bounded by `maxAttemptsPerRow`, not eliminated.
- **Quarantine is irreversible.** `ignored:outside-grace` and `ignored:session-cancelled` are terminal; a row
  quarantined on a wrong session read cannot be re-opened by this code. The proof is evaluated under the fence on
  the same unit to make that as narrow as possible, but there is no undo path and none is proposed.
- **R22/R23 are unmet**, so the L2/L3 paths are correct in source and inert in production (§13.5).
- Nothing is mounted; `index.ts` is untouched; the executor adapter and the mount hook from §10 remain requests.

## 13.7 Write stop (correction)

The last code write was `live-recording-ingest.ts` (`20d18b8a…`, 04:05 +0300); the only later write is this section.
The document's own final sha256 is carried in the bridge report rather than inlined here, because writing it into the
file would change the value being written. `tsc --noEmit -p server/tsconfig.json` → **exit 0**. The claim is released
by the bridge report. `reported` ≠ `accepted` — acceptance is Codex's.

---

# 14. Durable presence cursor + R23 vocabulary (2026-10-23, section C)

Task `server-live-presence-durable-cursor-20261023-01`, scope = section C of
`CODEX-PLATFORM-OBLIGATION-LIVE-CONTINUATION-20261023.md`. Sections A and B belong to Claude; this section touches
neither. Same 11 paths, same reservation, same write stop. **No SQL, no test, no typecheck, no provider call, no
service, no Git mutation** — that prohibition is in the continuation itself and it was honoured, so type correctness
below is **source review only** (§14.7).

## 14.1 R22 — the cursor is implemented, and gated

`live-session-sql.ts` now implements `readPresenceCursor` / `advancePresenceCursor` on the unit, bound to the unit's
own connection. The ports are attached **conditionally**: only when the composition passes
`presenceCursor: 'declared'`. The default is `'unconfigured'`, in which case the two properties are **absent** — which
is the fail-closed signal the core already reads (`ignored:ordering-unavailable`, no state change). Ordered callbacks
are therefore never enabled silently, and the source can implement the agreed contract while the migration is still
pending.

`'declared'` is an attestation, not a probe: this adapter issues no catalog query at import time. The runtime check
is the second line of defence — see §14.2.

**Read** (one statement, on the unit's connection):

```sql
SELECT presence_event_at_ms, presence_event_id
  FROM live_session_participants
 WHERE tenant_id = ? AND session_id = ? AND id = ?
```

Bindings in clause order: `tenant`, `session`, `participant`. A `NULL` pair is the documented "no cursor yet" state
(existing rows begin NULL; no historical event time is fabricated). A **half-set** pair is refused as `invalid_row`:
`chk_live_participant_presence_cursor` forbids it, and if it is seen anyway the read does not guess which half to
believe. The event id is validated **byte-exact** — never trimmed, lower-cased or re-encoded — and bounded to
`VARCHAR(128)`; an over-long id is refused rather than truncated, because a truncated id names a different event.

**CAS** (one statement, same connection):

```sql
UPDATE live_session_participants
   SET presence_event_at_ms = ?, presence_event_id = ?
 WHERE tenant_id = ? AND session_id = ? AND id = ?
   AND ((? IS NULL AND presence_event_at_ms IS NULL AND presence_event_id IS NULL)
        OR (presence_event_at_ms = ? AND presence_event_id = ?))
```

Eight placeholders, eight bindings in textual order: `next.eventAtMs`, `next.eventId`, `tenant`, `session`,
`participant`, `expected.eventAtMs`, `expected.eventAtMs`, `expected.eventId`. `expected: null` matches **only** a
stored NULL pair (`? IS NULL` is true, and `presence_event_at_ms = NULL` is never true). A non-null `expected`
matches only an exact `(instant, event id)` pair. MySQL evaluates the WHERE clause against the **original** row
values before `SET` runs, so the two assignments cannot influence the predicate guarding them — the §4 left-to-right
hazard applies to a `SET` list reading its own earlier assignment, not to `WHERE`.

`affectedRows` is read through the existing checked `affectedOf`, so an unreadable count is 0, never success. Two
consequences are deliberate: **1** means this event won and may change state; **0** means the stored cursor moved
between the read and the CAS, so the event is stale and is refused. An advance whose `next` equals the stored pair
also returns 0 under MySQL's changed-rows default — the core refuses equal instants as `ambiguous-event` before the
CAS, so a no-op advance is never requested, and a 0 is never read as success.

The cursor participates in the unit that also writes the callback marker, the participant row, the interval and the
sealed audit (`live.callback.applied`). It is not a separate transaction and never opens a connection of its own.

## 14.2 Missing schema fails closed, twice

- **Static**: the ports are absent unless `'declared'`.
- **Runtime**: even when declared, a driver `ER_BAD_FIELD_ERROR` (1054 / SQLSTATE 42S22) on either statement is
  rethrown as the typed `schema_unavailable`, which propagates out of the unit so the **whole callback rolls back**.
  A missing column is never reported as "no cursor" and never as an ordering decision. The mapping is narrow on
  purpose: any other driver error is rethrown untouched, so a connection fault is not mislabelled as a missing
  migration.

`createLiveSessionSqlStore` normalises the input (`=== 'declared'`), so a truthy or misspelled value cannot enable
the cursor, and exposes the **resolved** value as `store.presenceCursor` — a composition reads what the store will
actually do, not what it asked for.

## 14.3 R23 — vocabulary extended, mismatch typed

`CALLBACK_OUTCOMES` now carries the nine R23 values: the five original plus `ignored:mapping-unavailable`,
`ignored:ordering-unavailable`, `ignored:stale-event`, `ignored:ambiguous-event`. If the database still enforces the
old CHECK, `finalizeCallback` raises `ER_CHECK_CONSTRAINT_VIOLATED` (3819), which is mapped to `schema_unavailable`
naming R23 — with a rollback and no state change. Narrowing the TypeScript list again would move the refusal back
into source and hide the schema gap, so the list follows the agreed contract and the failure is explicit instead.

## 14.4 Core / adapter / in-memory agreement

| situation | in-memory unit | SQL adapter (declared) | core outcome |
| --- | --- | --- | --- |
| no cursor yet, event accepted | `null`, CAS with `expected: null` → 1 | stored NULL pair, CAS branch 1 → 1 | applied |
| event older than cursor | CAS with stale `expected` → 0 | predicate fails → 0 | `ignored:stale-event` (refused earlier by the core) |
| event equal to cursor | CAS with equal `expected` → 0 | predicate matches, nothing changes → 0 | `ignored:ambiguous-event` (refused before the CAS) |
| lost race between read and CAS | 0 | 0 | `ignored:stale-event` |
| ports absent | n/a (always present) | properties absent | `ignored:ordering-unavailable` |
| columns missing | n/a | throws `schema_unavailable` | callback throws, unit rolls back |

One divergence, stated rather than hidden: the in-memory unit returns `null` for a participant it has never seen,
while the SQL read throws `invalid_row` for a missing participant row. On every **reachable** path they agree,
because the core resolves the participant from `listParticipants` inside the same unit; the SQL side refuses because
a participant that vanished mid-unit must not be silently refreshed, and returning "no cursor" would let that
happen. The in-memory store cannot represent that case, so the difference is confined to it.

## 14.5 Readiness is reported per capability

`LiveRuntimeStatus` gains three fields and one correction:

- `presenceOrdering` — `configured` iff `store.presenceCursor === 'declared'` **and** both ports are functions on the
  built store. Definition stated in the type, checked against the store, not against `deps`.
- `sessionLifecycle` — `configured` iff the store exposes `withTransaction`, `insertSession`, `findSession`,
  `findSessionByProvider` and `updateSessionState`.
- `liveReady` — `configured` iff **mapping AND ordering AND session lifecycle** are all configured. This is the only
  field that may be read as "the live callback path is ready"; `reasons.liveReady` names what is missing.
- `recoveryCheckpoint` — always `unconfigured` here, with an `integration-open` reason. `recovery: 'configured'` means
  the entry point exists; it does **not** mean starvation is solved. Nothing in this lane persists
  `report.continuation`, so L1 is **integration-open** until Codex supplies a durable checkpointing caller. An unused
  token is not an operational fix.

`participantMapping` stays exactly as delivered: required and explicitly injected, `createInternalUserIdParticipantResolver`
still never auto-wired.

## 14.6 migration02 — not delivered, nothing to pin

`server/migrations/20261023_02_live_callback_presence_contract.sql` does **not exist** in this checkout
(`ls` fails), and no live migration file of any name is present under `server/migrations/` — so there is **no
migration02 hash to record** and no `live06` file here to compare against. The source implements the contract text as
agreed in §13.5 and in the adapter header, and stays `'unconfigured'` until the migration exists and the composition
attests it. When Claude delivers it, the hash is recorded in the bridge report and the composition may flip the
attestation; nothing in this delivery pre-empts that.

## 14.7 Before → after hashes (measured by the supervisor)

Baseline `handoff/WORKBUDDY-LIVE-CURSOR-BASELINE-20261023.txt`, captured before any write at
`2026-10-23 14:14:02 +0300`:

| # | path | before | after | bytes | state |
| --- | --- | --- | --- | --- | --- |
| 1 | `live-session-sql.ts` | `3ed58659…` | `1bfd1c62…` | 45,031 → 58,881 | moved (R22 + R23) |
| 2 | `live-runtime-factory.ts` | `82127d8d…` | `18e96a03…` | 15,852 → 21,844 | moved (readiness split, attestation, recoveryCheckpoint) |
| 3 | `live-session-core.ts` | `c4328d4a…` | `2db4a3f3…` | 85,882 → 85,957 | moved (header note only, no behaviour) |
| 4–10 | the other seven paths | — | unchanged | — | **byte-identical** |
| 11 | this document | `8320723c…` | `54157d01…` before the reference fix; final hash carried in the bridge report | 37,803 → ~49,052 | moved (this section only) |

**3 moved, 8 byte-identical, 0 outside the 11.** The out-of-scope check is a filesystem query
(`find server docs -newermt "2026-10-23 14:14:02"`), not an inference. No test, no migration, no `index.ts`, no new
repository file.

## 14.8 Limits of this section

- **No typecheck was run** — the continuation explicitly does not authorize it. Type correctness is therefore
  **source review only**: I read every changed statement, its clause order and its binding order, and I did not
  compile. A type error would not have been caught here, and this paragraph is the honest statement of that gap.
- **No database was contacted.** `? IS NULL` binding, changed-rows semantics, 1054/3819 code shapes, `VARCHAR(128)`
  byte comparison under the column collation (R17 asks for `utf8mb4_bin` and is still open, so a case-insensitive
  collation would make two different event ids compare equal at the database level even though the source treats
  them as distinct) are **requirements in source**, not observations.
- **No test was written, edited or run.** The cursor, the gating and the 3819 mapping have zero executed coverage.
- **The cursor is inert in production**: not declared by default, and the migration does not exist, so a
  `participant.joined`/`left` callback is still refused — now with `ignored:ordering-unavailable` (ports absent)
  rather than `invalid_outcome`.
- **`liveReady` is `unconfigured`** for any composition built today, by construction.
- Nothing is mounted; `index.ts` is untouched; metering and the recovery checkpoint remain open obligations.

## 14.9 Write stop (section C)

Last code write `live-session-core.ts` (comment only), before this section. No compiler, no SQL, no test, no
provider, no service, no Git. Claim released by the bridge report. `reported` ≠ `accepted` — acceptance is Codex's.

## 15. F1–F4 — verification, identity, checkpoint, integration contract

Task `server-live-readiness-checkpoint-20261023-01`, executed against
`CODEX-LIVE-F1-F4-DECISIONS-20261023.md`. Same 11 paths; **4 moved, 7 byte-identical, 0 outside**.
This section states what the source now does, what it deliberately refuses to claim, and what the
database must still supply.

### 15.1 F1 — readiness is three questions, not one

The previous round reported `liveReady: 'configured'` from *wiring alone*: the presence cursor was a
caller attestation (`'declared'`) and "the function exists" was treated as "the path works". That is an
attestation, not a verification, and it was the defect this round removes.

`status` is now documented as the **construction-time snapshot** — every field in it is a configuration
fact measured once. The verdict moved to `runtime.readiness()`, which re-evaluates on every call:

- **configuration** — the existing `LiveCapability` contract, unchanged in shape. `liveReady` is kept for
  compatibility, explicitly documented as configuration-only, and made *more* conservative: it now also
  requires both verifiers to be non-default and `ticketSecret` to pass `isValidTicketSecret` (the core's
  own 32-byte rule), not merely to be a non-empty string. A secret the core would refuse to sign with is
  no longer reported as a configured signer.
- **schema** — `verifyLiveSchema(executor)` in `live-session-sql.ts`: an explicit `async` call that reads
  `information_schema` on the injected connection and returns a per-area report. It is never awaited at
  module scope and never called by the factory; construction stays I/O-free. It never throws for a missing
  table, column or privilege — the area becomes `absent` or `unknown` with a short reason. Only an
  unusable executor throws (`invalid_deps`).
- **operations** — `OperationalEvidence` is a referenced record (`source`, `reviewer`, `scope`,
  `reviewedAtMs`), never a boolean and never a header. Absent, future-dated, out-of-scope or older than
  `LIVE_OPERATIONAL_EVIDENCE_MAX_AGE_MS` ⇒ `operational: 'not-verified'`.
  **SUPERSEDED by §16.2**: that shape-checked record and the 24-hour constant were rejected by the
  binding review — a fabricated object satisfied both. The current rule is provenance, not shape.

**The report cannot be forged.** `verifyLiveSchema` registers each report in a module-private `WeakSet`
and in a `WeakMap` keyed by the **executor object**. `isLiveSchemaReport` consults the WeakSet and
`isLiveSchemaReportFor` additionally requires object identity, so a structurally identical literal is not a
report and a wrapper around the same pool does not inherit a verification performed against another
connection. The factory refuses anything else with `invalid_deps` — it does not warn and it does not
downgrade.

**Freshness is evaluated at request time.** `LIVE_SCHEMA_MAX_AGE_MS` is 15 minutes; `schemaFreshnessMs`
can only shorten it (`resolveFreshnessMs` clamps to the maximum, and a non-finite or non-positive value
falls back to the maximum, never to "forever"). A report that aged out flips `schemaFresh` to `false` and
`fullyReady` to `unconfigured` without anything being restarted.

**Runtime drift invalidates.** `noteSchemaUnavailable(area, reason)` records the area and instant; that
area then reads `invalidated` and `fullyReady` drops, because a `schema_unavailable` observed after the
measurement is newer than the measurement. `applySchemaReport(report)` accepts only a report produced by
the trusted path for this executor, replaces the measurement and clears the invalidations it re-checked.

`fullyReady` requires **configuration complete + report present + fresh + `sessionLifecycle`,
`presenceOrdering`, `presenceEventIdentity` all `verified` + no invalidation**. `ingestLedger` and
`recoveryCheckpoint` are reported per area but are not part of the callback-path verdict, and the reason
string says which one is missing. The deny-all verifier can never satisfy it.

### 15.2 F2 — the event identity is a collation contract, measured

`utf8mb4_bin` is PAD SPACE in MySQL 8, so `'evt-1'` and `'evt-1 '` compare equal and two provider events
collapse into one cursor identity. Option A was chosen: `utf8mb4_0900_bin`, whose NO PAD attribute must be
**read from metadata**.

`classifyPresenceEventIdIdentity` takes four measured facts and returns `compatible | incompatible |
unknown`:

1. no `VERSION()` text, a `MariaDB` server, an unparseable version, or a major below 8 ⇒ `unknown` (the
   collation does not exist there) — never `compatible`;
2. `CHARACTER_SET_NAME !== 'utf8mb4'` ⇒ `incompatible`;
3. `COLLATION_NAME !== 'utf8mb4_0900_bin'` by **exact** equality ⇒ `incompatible`. `endsWith('_bin')`,
   `includes('bin')`, lower-casing and trimming are forbidden in the code and the comment says why:
   `utf8mb4_bin` and `utf8mb4_0900_as_cs` are different collations with different pad semantics;
4. `PAD_ATTRIBUTE !== 'NO PAD'` ⇒ `incompatible`, with the `'evt-1'` / `'evt-1 '` example in the reason.
   `'PAD SPACE'` is a named failure, not an `unknown`: the value was read and it is the wrong one.

The TypeScript side already refused to trim or truncate (`requirePresenceEventId`, `VARCHAR(128)` bound,
no normalisation); a comment now records that the DB-side guarantee comes from this classifier, and that
trimming an event id would defeat it. No `eventId` type change, no digest column.

### 15.3 F3 — one durable cursor, fenced by a row version

`live_recording_ingest_sql.ts` now implements the R24 store against the **requested** table (absent today,
so every operation degrades instead of throwing):

- **one fixed purpose** `'recording-recovery-global'`, a module constant with no construction override — a
  caller-chosen key would create two independent scans of the same workset;
- **`claim`**: create-only `INSERT … ON DUPLICATE KEY UPDATE purpose = purpose`, then one lease CAS
  (`owner IS NULL OR lease_expires_at_ms IS NULL OR lease_expires_at_ms <= ?`), then a **same-unit re-read**;
  `claimed: true` only when the row this transaction can see names this owner;
- **`advance`**: one statement fenced on `owner + row_version + sweep_generation + live lease + previous
  cursor`. The previous-cursor clause is a NULL probe plus an equality, so a first page (no cursor) and a
  resumed page are distinguished by the bind, not by string building. 12 placeholders, 12 bindings.
- **`completeSweep`**: the same fence, `SET cursor_occurred_at_ms = NULL, cursor_id = NULL,
  sweep_generation = sweep_generation + 1` — the reset and the generation bump are one statement, so a
  crash cannot leave a generation that claims a reset the cursor does not reflect;
- **`release`**: clears owner and expiry, never renews; an expired or foreign lease matches 0 rows;
- `row_version` changes on **every** mutation, so under MySQL changed-rows semantics affected rows = 1
  exactly when the CAS won and 0 always means lost. The 0 case is classified by **re-reading the row in the
  same unit** (`stale-owner`, `stale-version`, `stale-generation`, `cursor-mismatch`, `lease-expired`),
  never from a driver message;
- missing table (1146/42S02) ⇒ `checkpoint-absent`, missing column (1054/42S22) ⇒ `schema-unavailable`;
  both are **returned**, so the pass stops and reports rather than failing.

The pass (`runRecordingRecoveryOnce`) changed as follows when `deps.checkpoint` is present, and **not at
all** when it is absent (`checkpoint: null`, `options.after` used directly — the integration-open note
stays):

- claim first; not claimed ⇒ `checkpoint-unavailable`, zero work, `checkpoint.failure` names the reason;
- **`options.after` cannot override the durable row.** `'after' in options` is the test, so an explicit
  `null` counts: it is accepted only when it equals the claimed cursor (numeric instant, byte-exact `id`),
  otherwise the pass refuses with `cursor-override-rejected`, releases and scans nothing. A caller cannot
  skip work and a stale value cannot rewind a concurrent worker. (The release is no longer performed *in*
  this branch — see §16.3: `finally` owns the single attempt on every exit, so an early return cannot
  release twice.)
- ownership/time is checked **before every additional page**; an expired lease ⇒ `checkpoint-lease-lost`,
  no advance, no renewal;
- **each fully inspected page is persisted before the next one is read** — including pages whose rows were
  all skipped, deferred or quarantined. A mid-page stop (batch cap / wall clock) persists only the prefix
  actually inspected (`lastInspected`), never the page end, because the rows after it were not looked at;
- a **failed advance stops the pass immediately** (`checkpoint-advance-failed`); no further page is read,
  because after a lost fence the work is no longer this worker's;
- a completed sweep is persisted by `completeSweep` in one CAS (not advance-then-reset);
- **crash semantics**: persist-after-page means a crash can replay one page, never skip one. Individual
  ingest/library idempotency remains independently required, unchanged;
- one `release` attempt on every stop path; `released: false` is an answer about ownership, not an error.
  **Refined in §16.3**: the attempt lives in `finally`, runs at most once, is skipped when ownership was
  already lost or the local lease expired, and never replaces the original error.

`options.shutdown === true` returns `shutdown-in-progress` **before** the claim: no claim, no release, no
scan, no cursor movement. That is the "no new recovery pass during shutdown" primitive.

### 15.4 F4 — the caller contract

Delivered as one file: `handoff/WORKBUDDY-LIVE-F1-F4-INTEGRATION-REQUEST-20261023.md` (factory signatures,
dependency matrix, required schema checks, unconfigured states, start ordering
`verify → construct → mount → loop`, shutdown ordering `stop-new-work → drain → release-if-owner → close`
with **no final recovery pass**, and Claude's R24 + R22-collation request).

### 15.5 Before → after hashes (measured by the lane supervisor)

| # | path | before | after | bytes | state |
| --- | --- | --- | --- | --- | --- |
| 1 | `live-session-sql.ts` | `1bfd1c62…` | `262b6500…` | 58,881 → 84,634 | moved (F1 verifier, F2 classifier) |
| 2 | `live-recording-ingest-sql.ts` | `4df9f3f6…` | `303b4aea…` | 37,787 → 68,020 | moved (R24 store) |
| 3 | `live-recording-recovery.ts` | `6d580cdb…` | `cd293e8d…` | 21,374 → 39,363 | moved (checkpoint-aware pass) |
| 4 | `live-runtime-factory.ts` | `18e96a03…` | `74024b1c…` | 21,844 → 46,658 | moved (readiness split, checkpoint wiring, shutdown) |
| 5–11 | the other seven paths | — | unchanged | — | **byte-identical** |
| 11 | this document | `8e6c1a5b…` | (self-reference) | 49,125 → +this section | moved (this section only) |

The out-of-scope check is a filesystem query
(`find server/src server/tests server/migrations docs/streams -newermt "2026-10-23 15:00"`), not an
inference: exactly those four source files. No test, no migration, no `index.ts`, no new repository file.

### 15.6 Limits of this section

- **No typecheck was run** — the decisions forbid it. Type correctness is **source review only**: every
  changed statement, clause order and binding order was read; nothing was compiled, so a type error would
  not have been caught here.
- **No database was contacted, no SQL executed.** The catalog queries, the CAS predicates, the 12-binding
  advance, `information_schema.COLLATIONS.PAD_ATTRIBUTE`, 1146/42S02 and 1054/42S22 are **requirements in
  source**, not observations.
- **No test was written, edited or run.** The verifier, the classifier, the checkpoint store and the
  checkpoint-aware pass have **zero executed coverage**.
- **`fullyReady` is `unconfigured` for every composition buildable today**: no report can be `verified`
  without R22/R24, and `presenceCursor` is not declared by default.
- **The checkpoint is inert**: R24 does not exist, so a declared checkpoint returns
  `checkpoint-unavailable` and scans nothing. Bounded recovery is still INTEGRATION-OPEN — the port exists,
  nothing schedules it, and starvation is not operationally closed.
- **Two limits the verifier states itself** rather than hiding: a CHECK constraint's admitted values are
  not readable portably (R23 is proven only by a rejected write), and byte preservation of
  `presence_event_id` follows from the collation contract rather than being measured.
- `LIVE_OPERATIONAL_EVIDENCE_MAX_AGE_MS = 24 h` is a **lane default**, not a decided value; Codex may set it.
  **SUPERSEDED by §16.2**: the constant is deleted, not re-valued. Lifetime now comes from the trusted
  resolver's verdict, so this lane no longer invents one.

### 15.7 Write stop (F1–F4)

Last code write `live-runtime-factory.ts`, then this section. No compiler, no SQL, no test, no provider, no
service, no Git. Claim released by the bridge report. `reported` ≠ `accepted` — acceptance is Codex's.

## 16. Correction — provenance instead of shape, `finally` instead of a branch

Task `server-live-readiness-cleanup-correction-20261023-01`. Two defects in §15 were named by the binding
review (`CODEX-F1F4-REVIEW-DECISIONS-20261023.md`) and are fixed here **in source**, in the same 11 paths.
F1, F2, F3 and F4 are preserved; nothing was reverted.

### 16.1 The two defects, stated as they were

1. **`operational: 'verified'` could rest on the SHAPE of an object.** `evaluateOperationalEvidence` checked
   that `source` was a non-empty string, that `scope` contained the scope name, that `reviewedAtMs` was
   recent, and then returned `verified`. Every one of those is a field a caller can type by hand. The
   function therefore could not distinguish evidence from a *description* of evidence, and the 24-hour
   `LIVE_OPERATIONAL_EVIDENCE_MAX_AGE_MS` made it worse by inventing a lifetime this lane had no basis for.
2. **The checkpoint release was performed on individual stop paths.** A release sat in the
   `cursor-override-rejected` branch and another at the tail of the function. A throw from
   `listPendingIngests`, a throw from `advance`, or any future early return would leave the lease held until
   it expired — and adding a release to each new exit is the kind of obligation that is correct until the
   next person edits the function.

### 16.2 Operations is now a grant from an injected trusted resolver

The shape check and the 24-hour constant are **deleted**, not re-tuned.

- A caller may only point at an `OperationalEvidenceReference` (`source`, optional `reviewer`). That object
  is explicitly documented as *not* evidence.
- `loadVerifiedOperationalEvidence` is `async` and takes an injected `TrustedOperationalEvidenceResolver`.
  The resolver is asked about the **exact** `deploymentId`, `contractVersion` and `executorId`, and must
  answer `verified: true`, a `scope` that includes `'live.callback.path'`, a finite `verifiedAtMs` not in the
  future, and an `expiresAtMs` still ahead. Anything else — no resolver, no reference, a refusal, a throw,
  a different deployment/contract/executor, an out-of-scope or already-expired verdict — returns
  `{ grant: null, reason }`. A resolver that throws is a **refusal**, not a pass.
- **No default lifetime exists.** How long a review stays true is the resolver's statement, not a constant
  this lane chooses. This removes the invention rather than replacing it with a smaller invention.
- The returned `OperationalEvidenceGrant` is frozen and registered in a module-private
  `WeakSet` plus a `WeakMap` keyed by the **executor object**. `isOperationalEvidenceGrantFor(grant,
  executor)` is the only accepted proof, so a literal with identical fields is not a grant and a grant
  loaded for one connection is not valid for another.
- `readiness()` re-checks provenance → contract → scope → expiry **on every call**. Expiry is evaluated at
  call time, so a grant ages out without a restart.
- `operational` is still gated on `fullyReady === 'configured'`: a valid grant on an unconfigured callback
  path is not a verified operation.

The only assignment that can produce `'verified'` is the single ternary in `evaluateReadiness`, and its
first operand is `describeOperationalState(...)`, which begins with the provenance check. There is no
boolean shortcut, no request/header path, and no second producer — verified by grep, not by reading the
header comment.

### 16.3 The release lives in `finally`, exactly once

The claim + scan body is now inside `try { … } finally { await releaseOnce(); }`, and the two explicit
releases are gone. `releaseOnce` is bounded by four rules:

- **at most one attempt, ever** (`releaseAttempted`) — no retry loop, and therefore no renewal;
- **skipped when `ownershipLost` is set** — a failed `advance`/`completeSweep` CAS has already proved
  another worker holds the row, and writing to it would be a write against someone else's lease;
- **skipped when the local lease deadline has passed** — a lease that expired cannot be released or renewed
  without a fresh claim, so asking would be a renewal in disguise; the report says `lease-expired`;
- **it never throws** — the release call is wrapped, a failure becomes `released: false` plus a `failure`,
  and an error already unwinding from the body propagates untouched.

`options.shutdown === true` still returns **before** the claim, so shutdown neither claims nor releases: it
refuses. No recovery pass is started on the way out.

Two consequences worth stating rather than leaving implicit:

- **The report aliases the mutable checkpoint object on purpose.** `buildReport()` runs *inside* the `try`,
  so the `finally` executes after the returned object exists. The `checkpoint` field is the same object
  `releaseOnce` mutates — a snapshot would always report `released: false`. This is documented at both
  sites, and `elapsedMs` consequently measures the scan, not the cleanup.
- **`failure` is a closed union** (`RecordingRecoveryReportFailure`), not `string`: the port's
  classifications plus the two answers only the pass can produce (`cursor-override-rejected`,
  `release-error`). A typo is a compile error instead of a silently new value.

### 16.4 Before → after hashes (correction only, measured by the lane supervisor)

| # | path | before correction | after correction | bytes |
| --- | --- | --- | --- | --- |
| 1 | `live-runtime-factory.ts` | `74024b1c3b46a902` | `85bca4b9c1f85540` | 46,658 → 57,193 |
| 2 | `live-recording-recovery.ts` | `cd293e8d4b4f0007` | `d1441c919c597476` | 39,363 → 43,377 |
| 3 | this document | `d57caaa7b9bfdc4b` | recorded in the handoff file | 61,471 → recorded in the handoff file |

The document's own final hash is recorded in `handoff/WORKBUDDY-LIVE-CLEANUP-CORRECTION-20261023.md` rather
than inside itself: a file cannot contain its own digest, and a figure written here would be stale the
moment it was written.

The other eight paths are **byte-identical** to their §15.5 state: `live-session-core.ts` `2db4a3f3`,
`live-session-sql.ts` `262b6500`, `live-presence-sql.ts` `8bdd9cd2`, `live-recording-ingest.ts` `20d18b8a`,
`live-recording-ingest-sql.ts` `303b4aea`, `routes/live-sessions.ts` `44af3355`,
`media-usage-reconciliation.ts` `b820557e`, `video-asset-lifecycle.ts` `bac163a7`. Nothing outside the 11
paths was written.

### 16.5 Limits — what this correction does not prove

- **No compiler ran.** "Compiles" here means: braces/parens/brackets balance, every symbol that is assigned
  is declared in the same file, every removed symbol has no remaining reference outside this document, and
  the one construction site of `RecordingRecoveryReportCheckpoint` uses `failure: null`. That is a
  static read, not `tsc`.
- **No test was written or run.** `loadVerifiedOperationalEvidence`, `describeOperationalState`,
  `releaseOnce` and the aliasing contract have **zero executed coverage**. In particular, the claim that a
  thrown `listPendingIngests` still releases is an *argument from the code shape* (`finally`), not a
  measurement.
- **No resolver exists yet.** Nothing in this repo implements `TrustedOperationalEvidenceResolver`, so
  `operational` is `not-verified` for every composition buildable today — which is the intended state, not a
  gap this lane may close by writing its own trust root.
- **`executorId` strictness is unvalidated.** `describeOperationalState` does not re-derive `executorId`
  from the executor; it trusts the grant, which is bound to the executor **object**. If two compositions
  share one executor object with different `executorId` strings, both grants remain valid for it. That is a
  question for Codex, not something this lane decided.
- **The release path has never touched a database.** R24 is still absent, so a declared checkpoint returns
  `checkpoint-unavailable` and `releaseOnce` is unreachable in production today.
- **No typecheck, no mount, no SQL, no migration, no metering change** — unchanged from §15.6.

### 16.6 Write stop (correction)

Last code write `live-recording-recovery.ts`, then this document, then the bridge report. No compiler, no
SQL, no test, no provider, no service, no Git. Claim released by the bridge report. `reported` ≠ `accepted`
— acceptance is Codex's.

## 17. Grant acceptance is matched against the server-side composition context

Direct follow-up to §16.2, from the same review thread. §16.2 fixed *who* may issue a grant; this closes
*which deployment* may consume it. Before this change the grant was checked against the executor object,
the contract version, the scope and the expiry — but never against the identity of the deployment the
process was actually configured to serve, so a grant legitimately issued for one environment would satisfy
another environment's runtime as long as the same executor object was reused.

### 17.1 The context is a type, not two loose strings

`LiveCompositionContext = { deploymentId, executorId }`, captured by `createLiveRuntime` **once**, from
`deps.compositionContext`, through `readCompositionContext`, which returns a **frozen copy** or `null`.
Three rules are enforced by construction rather than by convention:

- **never from a request.** There is no code path in this file that reads either id from a header, a query,
  a body or a route parameter — the value arrives as a construction dependency and nowhere else;
- **never inferred from the connection.** Nothing reads identity off `executor`; the executor object is used
  for provenance only (the `WeakMap` key). A connection knows which host it reached, not which deployment
  this process was configured to serve;
- **never normalised.** Emptiness is detected on the trimmed form, but the comparison is `===` on the
  caller's own bytes. Two ids that differ by one character are two ids.

Capture at construction is also a decision: the identity of a deployment cannot change while the runtime
serves requests, and a value re-read per `readiness()` call would be a value something could change per
call. Because the copy is frozen, later mutation of `deps.compositionContext` has no effect.

### 17.2 Acceptance order, and what each step closes

`describeOperationalState(grant, executor, compositionContext, nowMs)` now runs:

1. **provenance** — was this object produced by the trusted loader, for THIS executor object? (closes the
   fabricated object)
2. **composition context** — `grant.deploymentId === compositionContext.deploymentId` **and**
   `grant.executorId === compositionContext.executorId`? (closes cross-environment reuse; absent context ⇒
   `not-verified` with a reason that names the missing context)
3. **contract version**, 4. **scope**, 5. **expiry** — as before, expiry evaluated at call time.

`loadVerifiedOperationalEvidence` lost its two loose `deploymentId`/`executorId` parameters and takes
`compositionContext` instead. That is deliberate: with two independent parameters a caller could ask the
resolver about deployment A and then hand the runtime deployment B. Now the loader and the runtime read the
same shape, and a grant loaded under a different context than the runtime's is refused at step 2.

There is still exactly **one** assignment that can produce `'verified'` — the ternary in `evaluateReadiness` —
and its first operand is `describeOperationalState`.

### 17.3 Before → after hashes (this refinement)

| # | path | before | after | bytes |
| --- | --- | --- | --- | --- |
| 1 | `live-runtime-factory.ts` | `85bca4b9c1f85540` | recorded in the handoff file | 57,193 → recorded in the handoff file |
| 2 | this document | `fdbbc2a5d0aa6925` | recorded in the handoff file | 70,503 → recorded in the handoff file |

Both "after" digests live in `handoff/WORKBUDDY-LIVE-CLEANUP-CORRECTION-20261023.md` §7 rather than here:
a file cannot contain its own digest, and a number typed into prose is a number that can be wrong.

The other nine paths are **byte-identical** to §16.4 / §15.5. `live-recording-recovery.ts` was **not**
touched: the `finally` cleanup and the aliasing contract from §16.3 stand exactly as delivered.

### 17.4 Limits of this refinement

- **No compiler, no test.** Same standing limit: balance/`grep`/read only. The context matching has **zero
  executed coverage**, including the mismatch and absent-context paths.
- **No composition supplies a context yet.** `routes/live-sessions.ts` and `index.ts` are not wired, so
  every buildable composition has `compositionContext: undefined` ⇒ `operational: 'not-verified'`. That is
  the intended default, and it is now the *reason* rather than a silent `false`.
- **The context is trusted once supplied.** This lane cannot verify that a caller filled it from
  configuration rather than from a request; it can only refuse to accept identity from anywhere else. Who
  supplies it, and from which config key, remains Codex's integration decision.
- **`executorId` is still a declared string, not derived.** Per the instruction, identity is not inferred
  from the connection object — so the pairing of one `executorId` to one executor object is the caller's
  responsibility, checked only for equality against the grant.

### 17.5 Write stop (refinement)

Last code write `live-runtime-factory.ts`, then this section, then the handoff record. No compiler, no SQL,
no test, no provider, no service, no Git.

## 18. Library first, then metering by the recording — not by the event

Task `server-live-library-meter-composition-20261023-01`. Source only. The `compositionContext` refinement
(§17) is **inherited** into this task's baseline and is not claimed as work here.

### 18.1 The two defects this closes

1. **Metering ran before the library write, against a synthetic id.** `runVerified` called the meter with
   `buildRecordingMeterAssetId(provider, providerRecordingId)` — a `rec-*` string that is not a
   `video_assets.id`, cannot be resolved by `MediaMeteringService`, and proves no ownership. That is why the
   factory left `meterStorage` unwired: wiring it would have made every recording settle as
   `metering_deferred` for ever.
2. **The meter's operation id was `provider:eventId`.** The meter's idempotency key is
   `st:{assetId}:{operationId}`, so two delivery events for the SAME provider recording produced two keys and
   two charges.

### 18.2 The new order, and what each step proves

| # | step | refusal |
| --- | --- | --- |
| 1 | claim the ledger marker (unchanged, fenced) | `claim-held` / `claim-unavailable` / `claim-lost` |
| 2 | **library promotion** — idempotent create, or readback of the row the unique key holds | `library-unconfigured`, `library-error`, `library-owner-mismatch`, `library-cross-tenant`, `library-key-collision` |
| 3 | **prove the promoted identity** — canonical `assetId`, `tenantId` = this session's tenant, `ownerUserId` = the descriptor's owner | `metering-identity-unproven` |
| 4 | **meter** with that real `assetId` and the recording's stage identity | `metering-error`, `metering-unknown` |
| 5 | terminal unit, one fenced `finalizeIngest` + one success audit | `claim-lost` (0 affected ⇒ no success audit) |

**No library success ⇒ no metering and no terminal `ingested`.** Step 3 is what makes step 4 safe: an asset
that the unique key handed back is not this recording's asset if its tenant or owner disagrees, and charging
it would bill one tenant or one person for another's recording.

**IMMUTABLE STAGE IDEMPOTENCY MAP.** Storage operation identity is
`(tenantId, provider, providerRecordingId, stage)` with `stage ∈ RECORDING_METER_STAGES = ['storage']`, and
the meter composes `st:{assetId}:{operationId}`. The event id is **not** part of it. Adding a stage is a
schema-visible decision, not a refactor. `buildRecordingMeterOperationId` is bounded to the meter's
`OPERATION_ID_RE` (200 chars) by falling back to a full sha256 digest, never by truncation.

### 18.3 Crash / replay contract — traced, not assumed

| crash point | what exists | what the retry does |
| --- | --- | --- |
| after claim, before library | ledger row `pending`, lease held | lease expires, another attempt claims, nothing external happened |
| after library, before meter | asset exists (irreversible) | library answers `existing` with the SAME id, meter records once |
| after meter, before terminal | asset + bytes recorded | library `existing`, meter answers `deduplicated` (same key), terminal settles |
| after terminal | row `ingested` | replay compares the persisted payload ⇒ `duplicate` or `conflict` |

**External effects are never rolled back by a DB rollback.** A crash after the library leaves the asset
created; a crash after the meter leaves the bytes counted. What makes the replay safe is that both steps are
keyed on the RECORDING, so a replay converges on the same two records instead of creating new ones. If either
port loses idempotency this contract is void, and this module cannot detect that.

A configured meter that failed leaves the marker **`pending` and releases the lease**, so a redelivery
repairs it immediately instead of waiting for expiry. An **unconfigured** meter does not block terminality —
it is a policy state — and the result carries `storageAccounted: false` so `status: 'ingested'` can never be
read as "bytes were accounted".

### 18.4 Interface changes (all inside the 11 paths)

- `RecordingLibraryPort.createRecordingAsset` → `RecordingLibraryAsset`
  (`{created, assetId, tenantId, ownerUserId}`): the meter needs the tenant and owner, not just an id.
- `RecordingLibraryPromotionPort.createRecordingAsset` → the same four fields; its readback now selects
  `owner_user_id` and refuses `owner_mismatch` instead of answering with another user's asset.
- `RecordingLibraryErrorCode` += `owner_mismatch`.
- `RecordingMeteringOutcome` += `not-attempted` (no proven asset to meter — distinct from `deferred`).
- `RecordingCallbackResult` `ingested` += `storageAccounted: boolean`; `deferred` reasons +=
  `library-owner-mismatch`, `library-cross-tenant`, `library-key-collision`, `metering-error`,
  `metering-unknown`, `metering-identity-unproven`.
- `buildRecordingMeterOperationId(provider, eventId)` → `buildRecordingMeterOperationId({tenantId, provider,
  providerRecordingId, stage})`. **`buildRecordingMeterAssetId` is DELETED** — a synthetic-id builder invites
  exactly the reuse it caused. `isCanonicalAssetId` replaces it.
- Factory: `LiveRuntimeDeps.meterStorage?`, `LiveRuntimeStatus.metering` widened from the literal
  `'unconfigured'` to `LiveCapability`, `LiveRuntimeReadiness.recordingConfigured` added.

### 18.5 Composition and capability separation

`meterStorage` is forwarded when injected and left `undefined` when not — no no-op meter, no provider client,
no timer. The callback path and the recording path are now two separate answers:
`fullyReady`/`operational` stay scoped to `live.callback.path`, and `recordingConfigured` is a
configuration-only verdict for library + meter + checkpoint. **`operational: 'verified'` never implies that
recordings are operationally verified**, and `recordingConfigured` never implies the callback path is ready.

Startup/shutdown ordering is unchanged from §15.4 (`verify → construct → mount → loop`;
`stop-new-work → drain → release-if-owner → close`, no final recovery pass). `beginShutdown()` and the
`finally` checkpoint release from §16.3 are untouched; `live-recording-recovery.ts` is byte-identical.

### 18.6 Before → after hashes (full SHA256)

| path | before | after |
| --- | --- | --- |
| `live-recording-ingest.ts` | `20d18b8a…` | recorded in the handoff file |
| `video-asset-lifecycle.ts` | `bac163a7…` | recorded in the handoff file |
| `live-runtime-factory.ts` | `33646c06…` | recorded in the handoff file |
| this document | `50506849…` | recorded in the handoff file |
| 7 others | unchanged | **byte-identical** to the task baseline |

Full digests, sizes and the byte-identical list are in
`handoff/WORKBUDDY-LIVE-FINAL-COMPOSITION-VERIFICATION-20261023.md`.

### 18.7 Remaining prerequisites — not delivered here

- **Schema (Claude, unchanged requests):** R16–R24 as already registered. This task adds **no** new DDL
  request: the ledger row still has no asset column, and the meter identity is derived, not stored.
- **Codex:** the `index.ts` mount, and the decision of which composition injects `meterStorage`
  (`MediaMeteringService` satisfies `RecordingStorageMeterPort` structurally — verified by reading both
  declarations, not by compiling).
- **Integration-open:** a row whose provider never redelivers still needs the reconciliation sweep (R9). The
  grace window quarantines only the two provable reasons.

### 18.8 Limits

- **No compiler, no test, no SQL, no database, no provider.** "Compiles" here means delimiter balance, every
  assigned symbol declared in the same file, and every port implementation updated by reading it.
- **Zero executed coverage** for: the new order, `identityProven`, every new deferred reason, the owner
  mismatch refusal, and `storageAccounted`.
- **`RecordingStorageMeterPort` compatibility is a reading, not a check.** `RecordStorageResult` is
  `{recorded:true,deduplicated:false,…} | {recorded:false,deduplicated:true,…} | {error}`; it is assignable to
  the port's `{recorded:boolean;deduplicated:boolean} | {error}`, but no compiler confirmed it.
- **Owner-mismatch keeps the row `pending`.** That is deliberate — a human decides — but a session whose host
  changed between promotion and retry stays pending **indefinitely** unless its event is already outside grace
  or the session is cancelled. Grace is a predicate on the immutable event time (§19.4), so it does not "close"
  over a pending row. Recorded as an unknown branch, not solved.
- **The in-memory seam is stricter now**: it throws `owner_missing` where it used to invent an id. That is
  the durable port's behaviour, matched on purpose.

### 18.9 Write stop

Last code write `live-runtime-factory.ts`, then this section, then the handoff record and the bridge report.
No compiler, no SQL, no test, no provider, no service, no Git.

## 19. A missing meter leaves a durable obligation, not a terminal success

Task `server-live-meter-unconfigured-resume-correction-20261023-01`. This corrects §18, which allowed an
unconfigured meter to settle `ingested` with `storageAccounted: false`.

### 19.1 Why that was a defect and not a policy

The absent-meter branch reported `unconfigured` and then fell through to the terminal unit, so the row became
`ingested`. Three facts made that unrecoverable:

1. `ingested` is terminal — a same-event retry answers `duplicate` and never re-drives the meter;
2. the recovery pass only scans `pending`, so a terminal row is invisible to it;
3. `storageAccounted: false` is response and audit data. It is **not** a durable obligation: nothing reads it
   back, nothing retries it, and no operator query is obliged to look at it.

So the first delivery of a recording destroyed the storage obligation for good. "No meter composed" was
being treated as an exemption from accounting, which it is not.

### 19.2 The correction

- The absent-meter branch sets `metering = 'unconfigured'` **and** `meteringFailure = 'metering-unconfigured'`,
  so `deferredReason` is non-null and the terminal unit takes the release path.
- `terminal` now requires three conditions, and states the third twice on purpose:
  `deferredReason === null && (library === 'created' || library === 'existing') && storageAccounted`, where
  `storageAccounted = metering === 'recorded' || metering === 'deduplicated'`. There is no path from "meter
  never ran" to `ingested`.
- `'metering-unconfigured'` is a typed member of the `deferred` reason union, so a caller must handle it.
- The release is the guarded form `finalizeIngest({ outcome: 'pending', expect: { owner } })` and the returned
  **affected row count is checked**: `claim_released: released === 1`, `ledger_outcome: released === 1 ?
  'pending' : 'unknown'`. A release that affected 0 rows is reported as not released, never assumed.
- The `metering_unconfigured` audit now records `asset_id`, `storage_bytes`, the `meter_operation_id` a later
  retry will present, and `ledger_outcome: 'pending'`.
- `storageAccounted` stays on the `ingested` result as a positive assertion, and is now `true` **by
  construction**; the field is documented as such rather than removed, so a future stage can widen it again
  without silently changing the meaning.

### 19.3 Resuming after the meter is installed

The resume path is the same `runVerified`, so it needs no new branch:

- the library answers `existing` with the **same** promoted `assetId` (idempotent on
  `(tenant, provider, providerRecordingId)`);
- the meter key is `st:{assetId}:{live:storage:{tenant}:{provider}:{recording}}` — identical to the key the
  first delivery would have used, so the retry records **one** charge, and a second retry is `deduplicated`.

No event id participates in either key, so this holds even if the redelivery carries a different provider
event.

### 19.4 RECOVERY ELIGIBILITY — the exact condition, corrected

This section previously described grace as a window that closes with time ("recoverable only while it is inside
the grace window", "once `occurredAtMs > endedAtMs + graceMs`"). That framing was wrong, and the correction
matters because it changes what a no-meter deployment should expect.

The predicate is on **immutable** values. `provesTerminal('outside-grace')`
(`live-recording-ingest.ts:953-958`) is:

```
fresh.state === 'ended' && fresh.endedAtMs !== null && occurredAtMs > fresh.endedAtMs + graceMs
```

and `resumePending` passes `existing.occurredAtMs` — the persisted event time. The code says why, in place
(`live-recording-ingest.ts:1747-1750`): *"The persisted event time, not `now()`: the grace window is about when
the recording happened, and re-stamping it would let a resume walk a row past its own window."*

What follows, stated exactly:

- `occurred_at_ms` is written once and never updated, and `ended` is terminal in `LEGAL_SESSION_TRANSITIONS`, so
  `endedAtMs` cannot move later either. The predicate is decided when the session ends and **cannot change on a
  later retry**.
- A row inside grace stays inside grace for ever, however many passes run and however long the deployment waits.
  Elapsed wall-clock time does not quarantine it.
- A row outside grace was already outside when the session ended; the first pass that can hold the fence proves
  it and quarantines it. Waiting is not what moved it.
- Therefore a deployment that runs with no meter for a long time does **not** accumulate
  `ignored:outside-grace` rows *because* it waited. Its affected rows stay `pending` (they are inside grace), and
  nothing else terminalises them — see §20.3, which is the real remaining limit.
- The starvation argument for quarantine still holds, but for a narrower reason than §19.4 used to give: it
  removes the rows that can *never* succeed (outside grace, or a cancelled session). It does not remove an
  inside-grace row whose meter never ran.

A cancelled session is the second provable terminal reason and is independent of grace: `state === 'cancelled'`
suffices, so a cancellation quarantines an inside-grace row too.

Two facts from the previous text that remain true and are kept:

- a quarantined row's loss is visible in the audit trail (`live.recording.metering_unconfigured` with the asset
  id and the meter key) but **nothing reconciles it** — reconciliation is R9, which does not exist;
- the factory still reports `metering: 'unconfigured'` and `recordingConfigured: 'unconfigured'` in such a
  deployment, so the gap is at least stated at the capability level.

### 19.5 Factory wording

`reasons.metering` and the `meterStorage` dependency doc now say the recording **stays pending with
`metering-unconfigured`** instead of claiming it settles with `storageAccounted: false`. The capability
verdict is unchanged: no meter ⇒ `metering: 'unconfigured'` and `recordingConfigured: 'unconfigured'`.

### 19.6 Before → after hashes

| path | before | after |
| --- | --- | --- |
| `live-recording-ingest.ts` | `65b893a8…` | recorded in the handoff file |
| `live-runtime-factory.ts` | `590a47af…` | recorded in the handoff file |
| this document | `4801ccfc…` | recorded in the handoff file |
| 8 others | unchanged | **byte-identical** |

Full digests are in `handoff/WORKBUDDY-LIVE-METER-UNCONFIGURED-CORRECTION-20261023.md`. §18 is left as
written — it records what was delivered then, and §19 states what it got wrong.

### 19.7 Limits

- **No compiler, no test, no SQL, no database.** The three-condition `terminal` is a reading, not a run.
- **Zero executed coverage** for the `metering-unconfigured` path, the checked release, and the resume-after-
  install convergence.
- **The grace/quarantine interaction was traced, not executed**: the claim that an outside-grace pending row
  is quarantined and its accounting lost follows from reading `settleTerminal` and the grace comparison.
- **No durable outbox, no reconciliation sweep.** The obligation survives only as long as the pending row.

### 19.8 Write stop

Last code write `live-runtime-factory.ts`, then this section, then the handoff record and the bridge report.
No compiler, no SQL, no test, no provider, no service, no Git.

---

## 20. Live composition open paths (`server-live-composition-open-paths-20261023-01`)

This pass re-read `runVerified`, `resumePending`, `settleTerminal` and the factory rather than trusting §18/§19.
It corrects one wrong claim, names one defect that cannot be fixed in source, changes one factory check, and
hands Codex an exact mount contract. F1–F4, R22/R23 and the library/meter fixes are **not** redone.

### 20.1 The grace predicate is immutable, not a countdown

§19.4 said a row is "recoverable only while it is inside the grace window" and that waiting pushes it out. That
was wrong and is corrected in place. The predicate is

```
state === 'ended' && endedAtMs !== null && occurredAtMs > endedAtMs + graceMs
```

where `occurredAtMs` is the **persisted** event time (`live-recording-ingest.ts:1747-1750` explains why it must
not be re-stamped: re-stamping "would let a resume walk a row past its own window") and `endedAtMs` is frozen by
`ended` being terminal in `LEGAL_SESSION_TRANSITIONS`. Neither operand moves, so eligibility is decided once and
never changes on a retry. Consequences are listed in §19.4; the two that matter operationally are:

- an inside-grace row is **never** quarantined by the passage of time, so a no-meter deployment accumulates
  `pending` rows, not `ignored:outside-grace` rows;
- an outside-grace row was already ineligible when the session ended; the first pass that holds the fence
  removes it.

### 20.2 A defect source cannot fix: `graceMs` is current config, not admission evidence

`graceMs` comes from `deps.graceSeconds` (`live-recording-ingest.ts:887`,
`normalizeGraceSeconds`). It is read at run time, so **every retry re-judges an old row against the current
configuration**. Lower `recordingGraceSeconds` and a row that was validly admitted under the previous value is
re-proven `outside-grace` on its next pass and quarantined — even though its admission was correct when it
happened, and even if its library asset was already promoted and only the charge is outstanding.

That is precisely "a valid promoted accounting obligation silently quarantined because eligibility metadata
changed". The audit records `grace_ms` at the moment of quarantine, which makes the change visible after the
fact, but nothing prevents it.

There is no source-only fix, and inventing one would be worse than the defect:

- using `MAX_RECORDING_GRACE_SECONDS` instead of the configured value would fail closed but silently ignore the
  operator's setting, and it still re-judges old rows against a different number;
- refusing to quarantine at all restores the starvation §19.4 exists to prevent;
- the ingest row carries no promotion or accounting evidence (`RecordingIngestRow`, `live-recording-ingest.ts:431-451`,
  has no asset id, no meter state, no admitted grace), so the code cannot distinguish "nothing was ever owed"
  from "the charge is still owed".

**Exact schema request (Claude).** Either one closes it; the first is the smaller change:

```sql
-- Option A (preferred): freeze the admission decision on the row.
ALTER TABLE live_recording_ingests
  ADD COLUMN admitted_grace_ms BIGINT NULL,
  ADD COLUMN admitted_at_ms   BIGINT NULL;
-- Written once by the insert that admits the row. `provesTerminal` must compare
-- against COALESCE(admitted_grace_ms, <configured>) and must NOT re-derive it
-- from current config for a row that has one.
```

```sql
-- Option B: a durable accounting obligation, so quarantine cannot lose a charge.
CREATE TABLE live_recording_accounting_obligations (
  id CHAR(36) NOT NULL,
  tenant_id CHAR(36) NOT NULL,
  asset_id CHAR(36) NOT NULL,
  provider VARCHAR(32) NOT NULL,
  provider_recording_id VARCHAR(128) NOT NULL,
  stage VARCHAR(32) NOT NULL,
  owed_bytes BIGINT NOT NULL,
  state ENUM('pending','recorded','deduplicated','abandoned') NOT NULL DEFAULT 'pending',
  created_at_ms BIGINT NOT NULL,
  updated_at_ms BIGINT NOT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_accounting_target (tenant_id, provider, provider_recording_id, stage),
  KEY k_accounting_pending (state, created_at_ms, id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
-- Quarantine may then proceed without losing accounting, because the obligation
-- is a row of its own and no longer depends on the ingest row staying pending.
```

Until one of these lands, the honest statement is: **an outside-grace quarantine may abandon a storage charge,
and the only record of it is the audit line**. That is stated here instead of being smoothed over.

### 20.3 The immortal inside-grace row

The mirror image of §20.2, and the more common one. A row whose event is inside grace and whose meter never ran
has no terminal reason available: `outside-grace` is false by construction, `session-cancelled` needs a
cancellation, and everything else stays `pending` by design. It is therefore **immortal** and re-listed on every
pass. The continuation lets a cooperating caller move past it; a caller that discards the continuation re-reads
it for ever, which is the starvation §19.4 describes — but the quarantine layer cannot remove this row, because
it is not provably ineligible.

Option B above is the fix. Without it, the correct expectation is: the pending set grows monotonically while a
deployment has no meter, and it does not self-heal.

### 20.4 Factory: the meter port is now validated, not just checked for null

`meteringConfigured` was `deps.meterStorage !== undefined && deps.meterStorage !== null`. A mis-wired object —
`{}`, a stub, a wrapper missing the method — was reported `configured` and forwarded into the ingest, where every
call throws, the throw is caught as `deferred`, and the row retries for ever against something that cannot
succeed. The failure then looks like a provider problem, not a composition problem.

`live-runtime-factory.ts` now narrows the value through `unknown` and requires a callable
`recordVerifiedBytes` before it is forwarded:

```ts
const meterCandidate: unknown = deps.meterStorage;
const meterPortUsable = typeof meterCandidate === 'object'
    && meterCandidate !== null
    && typeof (meterCandidate as { recordVerifiedBytes?: unknown }).recordVerifiedBytes === 'function';
```

The check runs **before** the ingest is composed, and the same `meterPortUsable` drives
`meteringConfigured`/`recordingConfigured`, so the forwarded port and the reported capability cannot disagree.
A malformed port is treated exactly like an absent one — `undefined`, never a no-op meter — and gets its own
readiness reason so the operator sees "injected but not a port" rather than "no meter".

### 20.5 Which schema area each capability actually needs

Callback evidence and recording evidence are separate, and conflating them is how a green callback path gets
mistaken for a working recording path. Enumerated by area:

| area | required objects | what it proves | what it does **not** prove |
|---|---|---|---|
| participant lifecycle | R22 cursor columns + paired-NULL CHECK + `utf8mb4_0900_bin`, R23 CHECK admitting the four `ignored:*` and the OLD `chk_live_callback_outcome` **gone** | join/leave ordering and cursor durability | nothing about recordings |
| recording ingest ledger | R12–R15 ingest columns/index/sink keys | that an event was admitted and can be replayed | nothing about the library or the meter |
| library promotion | R16 tenant-scoped `video_assets` unique, R18 nullable recording columns | that a promoted asset is unique per provider recording | nothing about bytes being charged |
| storage metering | the meter's own store (external) | that bytes were recorded or deduplicated | nothing about the session |
| recovery checkpoint | R24 `20261024_04_live_recovery_checkpoint.sql` | that a sweep resumes where it stopped | nothing about correctness of the rows |

**CORRECTED (Agent 3, contract-closure review).** The `participant lifecycle` row previously listed
“R19 presence actor” and “R21 `KEY (outcome, occurred_at_ms, id)`”. **No migration in
`server/migrations/` creates either object** — `grep` for `live_` across every `2026102[3-9]*.sql` returns
exactly three files (`20261022_06`, `20261023_02`, `20261024_04`), and neither R19 nor R21 appears in them.
Those two claims were removed rather than satisfied by inventing DDL, and `verifyLiveSchema` never required
them. §21 is the authoritative statement of what the verifier asserts.

The operational-evidence grant is scoped `'live.callback.path'` and **cannot** certify the recording flow; that
is why `readiness().recordingConfigured` is a separate, configuration-only verdict and why
`operational: 'verified'` never implies it (§18, unchanged here).

### 20.6 Grant context: already accepted, re-verified

Deployment and executor identity are compared against `deps.compositionContext` — captured once at construction
(`live-runtime-factory.ts:425`, `:966`) and compared at grant acceptance (`:875-890`): a null context answers
`not-verified`, and `deploymentId`/`executorId` must match exactly. No request-derived value participates. This
was delivered in the previous grant task; it is re-verified here, not re-implemented.

### 20.7 Contract for Codex (`index.ts` is Codex-owned; nothing here mounts anything)

The factory exposes callable primitives and nothing else — no timer, no `setInterval`, no import-time work, no
mount. To make the live lane live, Codex's composition needs exactly these, and each is a deliberate caller
decision rather than a default:

1. **Mount.** `deps.optionalAuthenticate` → `createLiveSessionsRouter(...)` returns `router | null`; mount the
   returned router only. A `null` router means authentication was not supplied, and mounting a self-authenticated
   route would be a privilege change.
2. **Executor.** `deps.compositionContext` must be set to the real `{ deploymentId, executorId }` of this
   process. Leaving it undefined keeps every operational verdict `not-verified` — correct, and the intended
   default.
3. **Async errors.** Every port call that can throw is already caught at its unit boundary and reported; the
   router does not install a process-level handler. Codex should attach the express error middleware at the
   mount site, because an async throw outside a route handler is not something this module can intercept.
4. **Health.** `readiness()` is synchronous and side-effect free; call it from the health endpoint rather than
   re-deriving capability from the presence of injected objects.
5. **Shutdown.** `stop()`/`drain()` are explicit and idempotent. Call `stop()` first (refuses new work), then
   `drain()` (waits for in-flight units), then close the pool. There is no timer to clear, so shutdown has
   nothing else to cancel.
6. **Recovery hook.** The sweep is a caller-driven pass with a `continuation` the caller persists. If Codex wires
   a scheduler, it must persist `continuation` between invocations — otherwise §20.3's starvation returns even
   though the checkpoint exists.

### 20.8 Before → after

| path | before (baseline) | after |
| --- | --- | --- |
| `live-runtime-factory.ts` | `ff610b44c1b7e2fe69dfd93e12acc3ad199e18750154d11d86ee133678061942` (67423 B) | `ac913b0b69f4e97e3698501c0c3c891380db26433481fe71e8150b46b8592372` (69133 B) |
| this document | `0b5ba706cf01a7b52efb7078c5af70277147886dfbed7e046224f2ab67dd8643` (90215 B) | recorded in the handoff — a document cannot contain its own digest |
| 9 others | unchanged | **byte-identical** |

The factory digest above is the value measured after the edit with `sha256sum`, not a placeholder; the document's
own digest is in `handoff/WORKBUDDY-LIVE-COMPOSITION-OPEN-PATHS-20261023.md`.

### 20.9 Limits

- **No compiler, no test, no SQL, no database, no provider.** The factory change is a reading: the shape check,
  its position before composition, and the single shared verdict are all verified by reading the file.
- **§20.2 and §20.3 are requests, not fixes.** Nothing here makes quarantine accounting-safe; only Option A or
  Option B does.
- **The stage-idempotency review (`same recording, different event`) and the terminal CAS were re-read, not
  changed**: the meter key excludes the event id, so a second event naming the same recording hits
  `st:{assetId}:{operationId}` and answers `deduplicated`; `ingested` is terminal and a replay answers
  `duplicate` without re-driving the meter. That behaviour is unchanged and remains unexecuted.
- **No drain/stop gap was found that a timer would fix.** The primitives exist; what is missing is a caller.

---

## 21. The schema verifier contract — what `verifyLiveSchema` actually asserts

Task `server-live-schema-verification-contract-20261024-01`, contract-closure review. Three files touched:
`server/src/services/live-session-sql.ts`, `server/src/services/live-runtime-factory.ts`, this document.
No migration, route, service or index file was edited; no SQL, database, test, compiler, typecheck, build,
service, provider, Docker or Git command was run. **No catalog query was executed in this review.** Everything
below is read from the requirement tables in the source and from the migrations as text.

**Why this section exists.** A previous pass added `verifyLiveSchema` and died before reporting it. The code was
therefore unverified evidence, and its comments were not trustworthy. This section is the contract that the code
is now held to, the inventory of what it asserts, and the exact places where it did not match the migrations.

### 21.1 The five areas and where their requirements come from

| area | code | tables | migration ground truth |
|---|---|---|---|
| `sessionLifecycle` | `live-session-sql.ts:1641` | `live_sessions`, `live_session_participants`, `live_session_callbacks` | `20261022_06:56-76`, `:280-297`, `:460-476` + R23 in `20261023_02:328,346` |
| `presenceOrdering` | `:1816` | `live_session_participants` | `20261023_02:144` (combined ALTER), `:158`, `:165`, `:192` |
| `presenceEventIdentity` | `:1851` | `live_session_participants` + `information_schema.COLLATIONS` | `20261023_02:144,165` (`utf8mb4_0900_bin`) |
| `ingestLedger` | `:1876` | `live_recording_ingests` | `20261022_06:635-658` |
| `recoveryCheckpoint` | `:1969` | `live_recovery_checkpoints` | `20261024_04:149-181` |

`LIVE_SCHEMA_CONTRACT_VERSION` is `live-schema-20261024-3` (`:1390`). A report carrying any other string is
refused by the factory with `invalid_deps`, and an operational grant issued against an older string is refused
as `not-verified` — an old label never inherits the tighter claim.

### 21.2 Required columns — 50 distinct columns (51 requirements), all matched

Each requirement is `(name, DATA_TYPE, length, charset, collation, signedness, enum vocabulary, NULLability,
EXTRA empty, and — for the R22 pair — no DEFAULT)`. Verified by `columnMismatch` (`:2495`). The count is 51
requirements over 50 distinct columns: `presence_event_id` is asserted twice, once by `presenceOrdering`
(existence and nullability in context) and once by `presenceEventIdentity` (the collation contract).

| table | columns | migration |
|---|---|---|
| `live_sessions` | `id CHAR(36)`, `tenant_id CHAR(36)`, `host_user_id CHAR(36)`, `title VARCHAR(200)`, `state ENUM('scheduled','live','ended','cancelled')`, `provider VARCHAR(128) NULL`, `provider_room_id VARCHAR(128) NULL`, `starts_at_ms BIGINT`, `ended_at_ms BIGINT NULL`, `max_participants INT UNSIGNED`, `created_at_ms BIGINT` — all `utf8mb4/utf8mb4_unicode_ci` | `20261022_06:57-67` |
| `live_session_participants` | `id`, `tenant_id`, `session_id`, `user_id` `CHAR(36)`; `role ENUM('host','cohost','participant')`; `ticket_fingerprint CHAR(64)`; `joined_at_ms`, `last_seen_at_ms` `BIGINT`; `left_at_ms BIGINT NULL` | `20261022_06:281-289` |
| `live_session_callbacks` | `id`, `tenant_id`, `session_id` `CHAR(36)`; `provider VARCHAR(128)`; `event_id VARCHAR(128)`; `kind VARCHAR(32)`; `occurred_at_ms BIGINT`; `outcome VARCHAR(48)` — all NOT NULL | `20261022_06:461-468` |
| `live_session_participants` (R22) | `presence_event_at_ms BIGINT NULL` **no DEFAULT**; `presence_event_id VARCHAR(128) NULL` `utf8mb4_0900_bin` **no DEFAULT** | `20261023_02:158,165` |
| `live_recording_ingests` | 12 columns incl. `duration_seconds INT UNSIGNED`, `storage_bytes BIGINT UNSIGNED`, `outcome VARCHAR(32)`, `claim_owner VARCHAR(64) NULL`, `claim_expires_at_ms BIGINT NULL` | `20261022_06:636-647` |
| `live_recovery_checkpoints` | `purpose VARCHAR(64)` `0900_bin`; `cursor_occurred_at_ms BIGINT NULL`; `cursor_id VARCHAR(64) NULL` `0900_bin`; `owner VARCHAR(128) NULL` `0900_bin`; `lease_expires_at_ms BIGINT NULL`; `row_version BIGINT UNSIGNED`; `sweep_generation BIGINT UNSIGNED`; `updated_at_ms BIGINT` | `20261024_04:152-169` |

**Result: every required column matches its migration, including the two collation regimes** (table default
`utf8mb4_unicode_ci` vs the byte-exact `utf8mb4_0900_bin` on the three identity columns). No column requirement
is unsupported by a migration.

### 21.3 Required indexes — 17 requirements, exact order, no prefix

Matched by name, `NON_UNIQUE`, full column list in `SEQ_IN_INDEX` order, and `SUB_PART IS NULL`
(`buildIndexIndex` `:2205`, compared in `evaluateArea`). Order matters because `(tenant_id, id)` and
`(id, tenant_id)` are different parent keys for a composite tenant FK.

- `live_sessions`: `PRIMARY(id)`, `uq_live_session_id_tenant(tenant_id,id)` UNIQUE,
  `uq_live_session_room(provider,provider_room_id)` UNIQUE, `idx_live_sessions_tenant(tenant_id,state,starts_at_ms)`
  — `20261022_06:68-71`.
- `live_session_participants`: `PRIMARY(id)`, `uq_live_participant(session_id,user_id)` UNIQUE,
  `uq_live_participant_tenant(tenant_id,session_id,id)` UNIQUE, `idx_live_participant_active(session_id,left_at_ms)`
  — `20261022_06:290-293`.
- `live_session_callbacks`: `PRIMARY(id)`, `uq_live_callback(tenant_id,provider,event_id)` UNIQUE,
  `idx_live_callback_session(tenant_id,session_id)` — `20261022_06:469-471`.
- `live_recording_ingests`: `PRIMARY(id)`, `uq_ingest_event(tenant_id,provider,event_id)` UNIQUE,
  `uq_ingest_recording(tenant_id,provider,provider_recording_id)` UNIQUE,
  `idx_live_ingest_pending(outcome,claim_expires_at_ms)`, `idx_live_ingest_session(tenant_id,session_id)`
  — `20261022_06:648-652`.
- `live_recovery_checkpoints`: `PRIMARY(purpose)` — `20261024_04:172`.

**Result: all 17 match. `PRIMARY` is required by name, which is what MySQL reports.**

### 21.4 Required CHECKs — 13 present + 1 required ABSENT

Each must exist in `TABLE_CONSTRAINTS` with `CONSTRAINT_TYPE='CHECK'`, be `ENFORCED='YES'`, and still express
the declared predicate, recognised **structurally** from `CHECK_CLAUSE` (`checkShapeMatches` `:2407`) — never
from the constraint name.

| CHECK | shape asserted | migration |
|---|---|---|
| `chk_live_session_ended` | `(state='ended') = (ended_at_ms IS NOT NULL)` | `20261022_06:73` |
| `chk_live_session_max_participants` | `max_participants BETWEEN 1 AND 5000` | `:74` |
| `chk_live_callback_outcome_v2` | `outcome IN (<the nine values>)` | `20261023_02:328,346` |
| `chk_live_participant_cursor_pair` | `(presence_event_at_ms IS NULL) = (presence_event_id IS NULL)` | `20261023_02:192` |
| `chk_live_ingest_lease_pair` | `(claim_owner IS NULL) = (claim_expires_at_ms IS NULL)` | `20261022_06:655` |
| `chk_live_ingest_terminal_release` | `outcome='pending' OR (claim_owner IS NULL AND claim_expires_at_ms IS NULL)` | `:656` |
| `chk_live_recovery_cursor_pair` / `_lease_pair` | the two all-or-NULL pairs | `20261024_04:173-174` |
| `chk_live_recovery_cursor_ms` / `_lease_ms` | `col IS NULL OR col <= 9007199254740991` | `:175-176` |
| `chk_live_recovery_version` / `_generation` | `row_version BETWEEN 1 AND …`, `sweep_generation BETWEEN 0 AND …` | `:177-178` |
| `chk_live_recovery_changed_ms` | `updated_at_ms <= 9007199254740991` | `:179` |

**Required ABSENT: `live_session_callbacks.chk_live_callback_outcome`.** `20261023_02:328` drops it in the same
atomic `ALTER` that installs `_v2`, `:387` drops it in the both-present state, and the migration's own final
guard treats `@c6_oc_old_end = 1` as drift (`:421`). While it survives it is still enforced and still admits
only the five original values, so the four `ignored:*` outcomes this adapter writes would raise 3819. Its
absence is now a required fact (§21.7 defect 2).

### 21.5 Required foreign keys — 7, with schema, table and column order

`KEY_COLUMN_USAGE` is read ordered by `ORDINAL_POSITION` (`buildForeignKeyIndex`), and each FK is checked for:
referencing columns in order, referenced table, referenced columns in order, and
`REFERENCED_TABLE_SCHEMA === DATABASE()` — the tenant boundary, so a child row cannot name another database's
parent row.

- `live_sessions.fk_live_session_tenant(tenant_id) → tenants(id)` — `20261022_06:72`.
- `live_session_participants.fk_live_participant_tenant(tenant_id) → tenants(id)`, and
  `fk_live_participant_session(tenant_id,session_id) → live_sessions(tenant_id,id)` — `:294-295`.
- `live_session_callbacks.fk_live_callback_tenant(tenant_id) → tenants(id)`,
  `fk_live_callback_session(tenant_id,session_id) → live_sessions(tenant_id,id)` — `:472-473`.
- `live_recording_ingests.fk_live_ingest_tenant(tenant_id) → tenants(id)`,
  `fk_live_ingest_session(tenant_id,session_id) → live_sessions(tenant_id,id)` — `:653-654`.
- `live_recovery_checkpoints`: **none, by design** — the absence is recorded in `notes` (`:2027-2030`), and
  `20261024_04:30-33` states the same.

**Result: all 7 match, including column order. `ON DELETE RESTRICT` is deliberately not asserted — it is not
part of what the adapter depends on, and asserting it would be a requirement no migration fact supports.**

### 21.6 Verdict semantics — `verified` / `absent` / `unknown`

`evaluateArea` (`:2566`) evaluates three buckets in a fixed order, and the order is the safety property:

1. **`absent`** — a PROVEN mismatch: a row was READ and the fact is different (wrong type, wrong length, wrong
   collation, wrong nullability, non-empty `EXTRA`, a forbidden DEFAULT, wrong index order, wrong uniqueness, a
   prefix index, a missing row **in a result set scoped to a known schema**, a CHECK that is `NOT ENFORCED` or
   whose clause no longer matches, a FK pointing at another schema/table/column order, or the R23 old CHECK
   still present).
2. **`unknown`** — anything not measured: a failed read (privilege, connection, missing
   `information_schema` table, unsupported flavour), an unreadable `ENFORCED`, an unreadable `CHECK_CLAUSE`, an
   unreadable `NON_UNIQUE`, an unreadable `DATABASE()`, an unclassifiable collation, or a MariaDB/pre-8 server.
3. **`verified`** — reached only when **both** lists are empty, i.e. every required fact was read and matched.

`unknown` is not a fourth shade of `verified`: the factory treats any area that is not `verified` as blocking
(`live-runtime-factory.ts:1259`), so `unknown` ⇒ `fullyReady: 'unconfigured'` ⇒ **unavailable**. `absent` and
`unknown` both deny readiness; they differ only in what they tell the operator (drift vs. unmeasured).

### 21.7 Defects found and fixed (all three files owned by this review)

1. **CHECK_CLAUSE outer parentheses — false `absent` on a valid deployment.**
   *Before:* `between`, `atMost`, `nullOrAtMost`, `membership` matched the clause with a leading `^` anchor and
   no parenthesis handling, while `normalizeCheckClause` preserves parentheses. MySQL returns
   `` (`max_participants` between 1 and 5000) ``, so the normalised `(max_participantsbetween1and5000)` failed the
   regex and `chk_live_session_max_participants`, `chk_live_callback_outcome_v2` and all four R24 range CHECKs
   were reported **absent** on a correct database. The migration itself anticipates both renderings
   (`20261023_02:308-317` lists `(...)` and `...`), so the verifier was stricter than the contract.
   *After:* `checkShapeMatches` strips one REDUNDANT outer pair before matching (`:2399-2401`), using the
   existing `stripOuterParens` that only removes a pair spanning the whole text. Grouping is preserved, no
   predicate is weakened, and `(a OR b) AND c` is still distinguished from `a OR (b AND c)`.
2. **The dropped R23 CHECK was never asserted absent — false `verified`.**
   *Before:* only `chk_live_callback_outcome_v2` was required. A half-applied `20261023_02` (state A′/E: old
   CHECK present, v2 also present) reported `verified` while the old five-value CHECK still rejected every
   `ignored:mapping-unavailable` / `ignored:ordering-unavailable` / `ignored:stale-event` /
   `ignored:ambiguous-event` write at runtime.
   *After:* `AreaSpec.forbiddenChecks` (`:1547`), one entry (`:1766`), evaluated at `:2695`: a present forbidden
   CHECK is `absent` with the reason naming the replacement. A failed constraint read stays `unknown`.
3. **Unreadable `DATABASE()` produced `absent` — false `absent`.**
   *Before:* every schema-scoped read filters `TABLE_SCHEMA = DATABASE()`. With no schema selected (or the name
   denied) those queries succeed and return **zero rows**, which the evaluator read as "table is absent" and
   reported `absent` for all five areas — a valid deployment declared broken because of a connection setting.
   *After:* `schemaKnown` gates every absence conclusion through `failAbsent` (`:2591-2599`); an unreadable
   schema name makes the area `unknown` with that reason. A row that IS returned and differs is still `absent`.
4. **Unreadable `NON_UNIQUE` was coerced to "not unique" — false `absent`.**
   *Before:* `readCatalogInt(row.NON_UNIQUE) !== 0` set `unique = false` for a NULL/unparseable flag, so a
   required UNIQUE key was reported `NOT UNIQUE`.
   *After:* `CatalogIndex.unique` is `boolean | null`; an unreadable flag is `unknown` for that index, not a
   mismatch.
5. **Operational grant was re-read from the caller's `deps` object on every call.**
   *Before:* `readiness()` passed `deps.operationalEvidence`, so the object handed to the factory could be
   replaced after construction even though the documented contract is "load it BEFORE composition".
   *After:* the grant is captured once at construction (`live-runtime-factory.ts:978`) and re-verified on every
   call. Provenance, executor identity, deployment, contract, scope and expiry checks are unchanged — the
   capture removes a mutation channel, it does not add or relax a check.

**Contract version bumped** `live-schema-20261024-2` → `live-schema-20261024-3` because a report now also
asserts a forbidden constraint's absence and no longer depends on MySQL's parenthesis rendering. Reports and
grants under the older string are refused rather than reinterpreted.

### 21.8 Catalog robustness — the enumerated failure modes

| condition | behaviour |
|---|---|
| permission denied on `information_schema` | the read throws, `readCatalog` returns `ok:false`, the area is `unknown` with `code: message` — never `absent` |
| non-MySQL / MariaDB | `SELECT DATABASE()` or `information_schema.COLUMNS` fails ⇒ `unknown`; a MariaDB version string, an unparseable major, or major < 8 ⇒ `presenceEventIdentity: unknown` (never `compatible`) |
| empty result set, schema known | a required object is genuinely missing ⇒ `absent` |
| empty result set, schema NOT known | `unknown` (defect 3) |
| NULL in a catalog column | `ENFORCED` NULL ⇒ `unknown`; `CHECK_CLAUSE` NULL ⇒ `unknown`; `NON_UNIQUE` NULL ⇒ `unknown`; `COLLATION_NAME` NULL on a varchar ⇒ `incompatible` (the row was read and its shape is not the contract) |
| `COLUMN_DEFAULT` | only the R22 pair is constrained (`noDefault`). MySQL reports SQL NULL both for "no default" and for `DEFAULT NULL`; the two are semantically identical on a nullable column, so the ambiguity cannot flip a verdict. `DEFAULT CURRENT_TIMESTAMP` / `DEFAULT_GENERATED` would be caught by the `EXTRA` check before the default check |
| `EXTRA` | any non-empty `EXTRA` (generated, auto-increment, on-update, `DEFAULT_GENERATED`) fails the column — a stored column is required, and this is checked before `noDefault` |
| `SELECT VERSION()` empty/failed | report carries `serverVersion: ''`, `presenceEventIdentity` becomes `unknown` |
| executor unusable | `invalid_deps` — the only throw |

### 21.9 Provenance, expiry, and operational separation — status

- **Report provenance.** `verifyLiveSchema` registers each report in a module-private `WeakSet` and in a
  `WeakMap` keyed by the **executor object** (`:3003`, `isLiveSchemaReportFor` `:3017`). The factory accepts a
  report only through `assertUsableReport` (`live-runtime-factory.ts:987`): `isLiveSchemaReportFor(report,
  executor)` **and** `report.contractVersion === LIVE_SCHEMA_CONTRACT_VERSION`, else `invalid_deps`. A
  structurally identical literal, or a report measured on another connection, is refused.
- **Expiry.** `LIVE_SCHEMA_MAX_AGE_MS = 15 min`; `schemaFreshnessMs` can only shorten it (`resolveFreshnessMs`,
  clamped, non-finite/non-positive ⇒ maximum). `readiness()` re-reads the clock on every call, so an aged-out
  report stops counting without a restart.
- **Operational evidence is a SEPARATE grant, never implied.** `describeOperationalState` requires, in order:
  provenance (`isOperationalEvidenceGrantFor` — WeakSet + per-executor WeakMap), a non-null server-side
  `compositionContext`, exact `deploymentId`, exact `executorId`, exact contract version, the
  `live.callback.path` scope, and `expiresAtMs > now`. `operational: 'verified'` additionally requires
  `fullyReady === 'configured'`. **A schema `verified` never yields `operational: 'verified'`** — the two
  verdicts share no input, and the scope string is not in any report.
- **Nothing at import time.** No `db`/pool import, no top-level statement, no `await`, no mount, no timer, no
  `process.on`. `createLiveSessionsRouter` is called only when `optionalAuthenticate` is supplied; the verifier
  is never called by the factory.

### 21.10 Unresolved mismatches and held questions (not fixed here)

1. **`live_session_presence_intervals` is not verified by any area.** The store writes it
   (`openPresenceInterval`/`closePresenceInterval`/`listPresenceIntervals`) and it exists in
   `20261022_06:887-904`, but no `AreaSpec` covers it — so `presence` can read `configured` with that table
   absent. **Question for the schema owner:** should a sixth area `presenceIntervals` be added (which changes
   `LIVE_SCHEMA_AREAS`, the report shape and the contract version again), or is the presence table's absence
   acceptable because `sessionLifecycle` already fails first?
2. **`live_sessions.state DEFAULT 'scheduled'` is not required.** The migration declares it
   (`20261022_06:61`); the verifier tolerates its absence because every INSERT names `state` explicitly
   (`insertSessionRow`). **Question:** is the default load-bearing for any writer outside this lane?
3. **`ON DELETE RESTRICT` is not asserted** on the three composite FKs (`20261022_06:295,473,654`). It is not
   something the adapter depends on, so asserting it would add a requirement with no code justification.
   **Question:** does any operator runbook depend on RESTRICT rather than CASCADE semantics?
4. **`verifyLiveSchema` does not assert that the R23 migration's `chk_live_callback_outcome_v2` is the ONLY
   outcome constraint** beyond the named forbidden one; a third, differently-named outcome CHECK would pass.
   Held: naming every possible constraint is not possible from the catalog; the forbidden-name assertion covers
   the one the migrations actually create and drop.
5. **A future-dated report is treated as fresh.** `ageMs = Math.max(0, now - checkedAtMs)`
   (`live-runtime-factory.ts:1251`), so a report with a clock ahead of the reader stays inside the window.
   Left as is deliberately: rejecting negative ages would turn normal NTP skew into a false `unconfigured`.
   Recorded as a limit, not fixed.
6. **`SECTION 20.5` previously claimed R19/R21 objects that no migration creates.** Corrected in place; the
   verifier never required them, so no code change followed.

### 21.11 What this section does NOT claim

No test, compiler, typecheck or build was run, so the edited code is **unproven as code**: the changes are
argued by reading. No catalog query was executed, so **no statement here is an observation about a database**.
No deployment was measured, so `fullyReady` and `operational` remain **unverified for every environment**, and
nothing in this section makes the live lane operationally ready.


## Codex source correction: presence interval coverage (2026-10-24)

The schema contract is now `live-schema-20261024-4`. The existing required `presenceOrdering` area also verifies `live_session_presence_intervals`: eight columns, primary/deduplication/open/participant indexes, the paired NULL close-reason CHECK, and tenant/participant foreign-key column shapes, transcribed from `20261022_06_live_sessions_recordings.sql`. The table is included in catalog reads. A missing or unreadable interval dependency cannot establish verified presence ordering. No sixth area was added.

Readiness rejects future-dated schema reports instead of clamping their age to zero. Existing executor provenance, expiry limits and separate operational evidence remain required. Foreign-key delete actions remain outside this matcher and must not be claimed verified. These are source corrections only: no compiler, tests, SQL or runtime verification was executed. Earlier section inventories and version-3 references describe the earlier delivery, not the current requirement count.
