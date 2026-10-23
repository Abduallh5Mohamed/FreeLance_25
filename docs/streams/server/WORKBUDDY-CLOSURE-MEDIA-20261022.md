# WORKBUDDY — media lane closure delivery (2026-10-22)

Task: `server-closure-media-20261022-01` · worker `wb-closure-media-20261022-01` · team `media` ·
workspace `C:/Users/abdua/OneDrive/سطح المكتب/FreeLance_25-1` · branch `codex/workbuddy-server` · HEAD `cab9120`.

Scope: the 51 registered `media` paths only. No other file was written, no Git mutation, no DB/Docker/service/
listener/migration/provider/secret/purge/deploy, no full suite.

Status vocabulary used below: **implemented** (source exists and is typechecked), **wired** (composed at a real
boundary), **untested** (no committed test exercises it — an ad-hoc hermetic harness was used instead and is named),
**live-unproven** (cannot be shown without a real provider/DB), **policy-held** (blocked on a decision or a
capability that this lane must not invent).

---

## 1. Per-item result

| ID | Status | What changed / what is missing |
|---|---|---|
| W1-R | **policy-held** | No code change. Pagination, per-kind caps and the tenant/branch/unpublished filters already exist (`search.ts`: `SEARCH_PAGE_SIZE_CAP`, `SEARCH_CANDIDATE_CAP`, `branchFragment`, `buildStaffSearchQuery`). "Measure with real data, then index if the measurement demands it" needs a real dataset and a latency baseline that this lane cannot produce. Indexing is schema-owner work. |
| W2-R | **implemented** + **policy-held** (plan extension) | 11 ownership-proof count probes added for the declared school-data gaps (see §4). The exported table set itself was **not** extended: `m8-tenant-export.test.ts` pins `EXPORT_TABLE_PLAN.length`, `coverage.omitted.length === 63` and the per-category counts, and this lane may not modify existing assertions. Extension is therefore an explicit request (§5, R2). |
| W3-R | **live-unproven** | No code change. Durable revoke/concurrency already delivered in `playback-session-registry.ts` / `playback-entitlement.ts`; proving "the next request is refused with no bytes" needs a live provider and multi-process run. Not claimed. |
| W4-R1 | **contract-only** | The scan worker and storage are academic-owned (`assignment-scan-worker.ts`, `assignment-storage.ts`) — not touched. The durable attempts/lease/next-attempt/exhaustion/recovery contract and its exact DDL are requested in §5 (R1). |
| W4-R2 | **implemented**, **untested** by committed test, **live-unproven** | New `createObjectCleanupService` + `ObjectVersionStore` port + reference adapter in `video-asset-lifecycle.ts`: no mutable-key delete path exists, `blocked-capability` when the adapter cannot prove an exact version (production MinIO declares `conditionalDelete: false`), `deleted` only on `version-deleted`/`version-absent`. Verified by an ad-hoc harness (§3.3). Durable table is requested (§5, R3). |
| W4-R3 | **policy-held** | A real scanner provider, timeouts and storage-versioning integration need provider authorisation. No fake-clean path was added. |
| W5-R | **contract-only** | The `video://` parse/bind contract already exists (`security/video-access-policy.ts`, codex-owned, read only). The DB-level constraint that stops the lecture/material race is requested in §5 (R4); no migration was written (schema source is Claude's). |
| W6-R1 | **implemented**, **untested** against real MySQL | `createSqlMediaMeteringStore` in `media-usage-reconciliation.ts` implements the published I2-1/I2-2 contract: one connection, `START TRANSACTION`, tenant counter lock then asset counter lock (`SELECT … FOR UPDATE`), `COMMIT`, `ROLLBACK` on any throw, release in `finally`. Verified by an ad-hoc harness that asserts the SQL order (§3.1). |
| W6-R2 | **implemented** + **wired**, **live-unproven** | `media_usage_gap_outbox` port (I2-4) + in-memory and SQL adapters + `drainMediaUsageGaps`; the lifecycle now enqueues a durable gap when metering is `deferred`/`unconfigured` (`gapOutbox` dep). Rebuild/reconciliation were already present and untouched. Verified end-to-end by an ad-hoc harness (§3.2). |
| W10-R1 | **implemented**, **not mounted** | New `live-session-core.ts` (state machine, signed join tickets, host/join/leave, signed provider callbacks with dedupe/tenant/grace, attendance derivation) and `routes/live-sessions.ts` (factory only). 11 committed tests pass. The router is deliberately **not** default-exported and not mounted: there is no production `LiveSessionStore` until the schema lands, and `server/src/index.ts` is Codex-owned. Mount request in §5 (R6). |
| W10-R2 | **implemented**, **library unconfigured** | New `live-recording-ingest.ts`: verified recording callback → tenant from session row → double dedupe → descriptor (`visibility: 'unpublished'`, `accessPolicy: 'deny'`, `publishable: false`) → metering through the same verified path → optional library port. 9 committed tests pass. Automatic attendance is *derived* (`attendance()`); writing it into `attendance_records` is academic-owned and is a request (§5, R7). |
| W10-R3 | **policy-held** | Provider/DRM/ABR/resume/offline/device-matrix verification needs the provider and rights decision. V7 stays default-deny. |

> **Superseded counts.** The W10-R1 / W10-R2 rows above describe the earlier delivery (11 and 9 tests). The
> atomicity correction of 2026-10-22 took them to **17** and **10**; §9 states the current status, the exact
> changes and the new limits. Nothing in §1 was rewritten, so the earlier claim stays auditable.

---

## 2. Files and before→after bytes

Inherited bytes are from `WORKBUDDY-THREE-LANE-BASELINE-20261022.md`; "own" means written by this worker.

| path | attribution | before (sha256 / bytes) | after (sha256 / bytes) |
|---|---|---|---|
| `server/src/services/live-session-core.ts` | **own** (new) | ABSENT | `846e5d1daa8620c06bc10abc6cc9e1ccd5ed71b4ed569980986604405ff030ab` / 46277 |
| `server/src/services/live-recording-ingest.ts` | **own** (new) | ABSENT | `7c2994988ac771509529f698b462a47942496f126b75ffaba9c3dde1e785ca27` / 25830 |
| `server/src/routes/live-sessions.ts` | **own** (new) | ABSENT | `7115bbc509226aecf9184bae83140ccbe6f1a20974bd4a7564fb67e5eeefcc4f` / 10214 |
| `server/tests/live-session-core.test.ts` | **own** (new) | ABSENT | `acb8d8ef69af4ef7feb2e898e7586d2c28a65daf004d3001891cb7b2fde71cdd` / 15795 |
| `server/tests/live-recording-ingest.test.ts` | **own** (new) | ABSENT | `4ccf2ea70d2448f0379ea29987234f0f248107d9b842b2f50fdc1e9993c38760` / 10657 |
| `server/src/services/media-usage-reconciliation.ts` | inherited + **own** append | `b1d0492de0a043a2798695efe4be60ca929970de20d426f057f4fd759a6c89bc` / 36142 | `b820557e06098178be2b914089db81626af75629775be171bcb0471c761295e8` / 58871 |
| `server/src/services/video-asset-lifecycle.ts` | inherited + **own** append | `ff97189fa277aa639a2ea7fdc81bba2366d3f8dbacb982c7758dc84b3114b911` / 30744 | `cb64543191699e7a3beb869c465567bee2f5d693de8189bd0fd1953878d6a92f` / 50082 |
| `server/src/services/tenant-export.ts` | inherited + **own** append | `f5cab23e7440236d535569f3aecb802e6af7f8d76315f4fbf3ade5c2be8378fc` / 64928 | `49d885eec65027196930f2269c84eefdacbd4739586467bbe55a1f7578968378` / 67720 |
| `docs/streams/server/WORKBUDDY-CLOSURE-MEDIA-20261022.md` | **own** (new) | ABSENT | this file |

Integrity check: all 45 present baseline media paths were re-hashed; **only the three files above differ**. The six
paths that were ABSENT at baseline (`live-session-core.ts`, `live-recording-ingest.ts`, `routes/live-sessions.ts`,
both live tests, this report) are the new ones. No media file outside this list was touched, and no academic,
notification, codex or Claude file was modified.

What was preserved byte-for-byte inside the three edited files: every inherited export, every inherited behaviour
and every inherited test contract. The additions are appended sections plus one optional dependency; the inherited
`withTransaction` unit, the counter order, the idempotency key, the reconciliation read-only contract, the asset
state machine and the export plan are unchanged. `media-usage-reconciliation.ts` imports `recordAudit` as a value
(previously type-only) because the new SQL adapter writes audits on the same connection.

---

## 3. Commands actually run, and what each proved

All test commands ran from `server/` with `M1_NETWORK_MODE=hermetic node --require ../scripts/m1-network-guard.cjs
--import tsx --test <files>`. No network, no DB, no provider.

| # | command (file list) | result |
|---|---|---|
| 3.0 | `node node_modules/typescript/bin/tsc --noEmit -p server/tsconfig.json` | **exit 0** (first run showed two pre-existing `gradebook.ts` errors owned by the academic lane; they were gone on the final run — that file is not mine and was not edited here) |
| 3.1 | `tests/live-session-core.test.ts` | **11/11 pass** |
| 3.2 | `tests/live-recording-ingest.test.ts` | **9/9 pass** |
| 3.3 | `tests/media-usage-reconciliation.test.ts` `tests/m3-video-lifecycle.test.ts` `tests/m3-video-review-fixes.test.ts` `tests/video-usage-storage.test.ts` `tests/video-usage-replay.test.ts` | **118/118 pass** (inherited suites; no assertion edited) |
| 3.4 | `tests/m1-video-processing-recovery.test.ts` | **41/41 pass** |
| 3.5 | `tests/m8-tenant-export.test.ts` | **40/40 pass** (probe addition does not disturb plan/omitted counts) |
| 3.6 | ad-hoc harness (temporary file, deleted after the run) over the SQL meter store + gap outbox | asserts: `START TRANSACTION` first, tenant counter locked **before** asset counter, `COMMIT` on success, `ROLLBACK` on a failed statement, exactly one release per unit; outbox dedupe; drain delivers once; an unproven asset is `deferred` then `exhausted` at the attempt cap — **passed** |
| 3.7 | ad-hoc harness over the cleanup service + lifecycle gap wiring | asserts: `conditionalDelete: false` ⇒ `blocked-capability` and **no delete**; missing version ⇒ `blocked-capability`; capability granted ⇒ only the exact version is touched; `reconcile` is `mutated: false`; a `deferred` meter leaves one durable outbox row keyed by the callback id, which `drainMediaUsageGaps` then delivers — **passed** |

Not run, deliberately: the full suite, any live/integration suite, any DB or provider path.

---

## 4. W2-R — the probes that were added

Every probe is pinned to a `NOT NULL tenant_id` verified in `server/migrations` (or, for `videos`, to a course join
because that table has no tenant column). Each one turns "declared gap" into a proven lower bound in the export
manifest, and a failing probe is recorded as a failure rather than swallowed.

`gradebook_scores`, `playback_progress`, `video_assets`, `videos` (via `courses.tenant_id`), `parent_links`,
`schedule_sessions`, `schedule_series`, `exam_versions`, `tenant_media_files`, `student_enrollment_requests`,
`tenant_memberships` — in addition to the inherited `attendance_records` and `lesson_completions`.

Deliberately not probed: `notification_outbox` and `notification_delivery_receipts` (their `tenant_id` is NULLable,
so a tenant-pinned count would not prove ownership), and every table without a tenant-resolvable chain.

---

## 5. Exact requests (each is a decision or a schema, not a guess)

**R1 — W4-R1 durable scan contract** (owner: schema = Claude, worker = academic). Table
`assignment_scan_attempts(id CHAR(36) PK, tenant_id CHAR(36) NOT NULL, submission_id CHAR(36) NOT NULL,
object_key VARCHAR(1024) NOT NULL, object_version_id VARCHAR(128) NULL, attempt_no INT UNSIGNED NOT NULL,
lease_owner VARCHAR(128) NULL, lease_expires_at DATETIME(3) NULL, next_attempt_at DATETIME(3) NULL,
state ENUM('pending','leased','scanning','clean','infected','failed','exhausted') NOT NULL, scanner VARCHAR(64) NULL,
verdict VARCHAR(32) NULL, last_error VARCHAR(500) NULL, UNIQUE KEY uq_scan_attempt (submission_id, attempt_no),
KEY idx_scan_due (state, next_attempt_at), KEY idx_scan_lease (state, lease_expires_at))`.
Contract the worker must satisfy: claim = `UPDATE … SET lease_owner=?, lease_expires_at=? WHERE state IN
('pending','leased') AND (next_attempt_at IS NULL OR next_attempt_at<=UTC_TIMESTAMP()) AND (lease_expires_at IS NULL
OR lease_expires_at<UTC_TIMESTAMP()) ORDER BY next_attempt_at LIMIT 1` with the affected row re-read as the fence;
`attempt_no` is the fencing token every verdict write must match; exhaustion writes `state='exhausted'` and makes the
row unclaimable; recovery is "expired lease is claimable with a new `attempt_no`", never a silent re-use.

**R2 — W2-R export plan extension** (owner: Codex, because it changes an asserted contract). Adding the ten
tenant-owned school tables to `EXPORT_TABLE_PLAN` changes `EXPORT_TABLE_PLAN.length`, `coverage.omitted.length`
(63) and the `outside_plan` count (32) that `m8-tenant-export.test.ts` asserts. This lane may not edit those
assertions, so the extension needs the test owner to move the pinned numbers together with the plan.

**R3 — W4-R2 durable cleanup table.** `video_object_cleanups(id CHAR(36) PK, tenant_id CHAR(36) NOT NULL,
asset_id CHAR(36) NOT NULL, object_key VARCHAR(1024) NOT NULL, object_version_id VARCHAR(128) NULL,
state ENUM('pending','deleted','blocked-capability','failed') NOT NULL, evidence ENUM('version-deleted',
'version-absent') NULL, attempts INT UNSIGNED NOT NULL DEFAULT 0, last_error VARCHAR(500) NULL,
requested_at DATETIME(3) NOT NULL, last_attempt_at DATETIME(3) NULL, deleted_at DATETIME(3) NULL,
UNIQUE KEY uq_cleanup (tenant_id, object_key, object_version_id), KEY idx_cleanup_state (tenant_id, state,
requested_at))`. Plus a storage capability declaration (`conditionalDelete`, `versioning`) exposed by the MinIO
adapter so `blocked-capability` is a fact and not a default.

**R4 — W5-R binding constraint.** `video_bindings(id, tenant_id, video_id, lecture_id CHAR(36) NULL,
material_id CHAR(36) NULL, UNIQUE KEY (video_id), UNIQUE KEY (lecture_id), UNIQUE KEY (material_id),
CHECK ((lecture_id IS NULL) <> (material_id IS NULL)))` — the two nullable columns plus the CHECK are what make
"one target, one type, one video" enforceable; `UNIQUE (lectures)` alone cannot stop the cross-type race.

**R5 — I2 metering tables** (already published in `B2-W6-MEDIA-METERING-20261021.md` §C.7 and now implemented
against): `video_storage_transitions`, `media_storage_asset_counters`, `media_storage_tenant_counters`, and new
`media_usage_gap_outbox(id, tenant_id, asset_id, operation_id, resulting_bytes, evidence_source, occurred_at,
reason, status ENUM('pending','delivered'), attempts, last_attempt_at, last_error, created_at,
UNIQUE KEY (tenant_id, asset_id, operation_id), KEY (tenant_id, status, created_at))`.

**R6 — W10 mount** (owner: Codex). `server/src/index.ts` must mount `createLiveSessionsRouter({ core,
optionalAuthenticate })` **after** a production `LiveSessionStore` exists, and the callback route needs the
signature-verifier wiring plus raw-body handling. Tables: `live_sessions(id, tenant_id, host_user_id, title,
state ENUM('scheduled','live','ended','cancelled'), provider VARCHAR(128) NULL, provider_room_id VARCHAR(128) NULL,
starts_at DATETIME(3), ended_at DATETIME(3) NULL, max_participants INT UNSIGNED, created_at,
UNIQUE KEY (provider, provider_room_id))`, `live_session_participants(id, tenant_id, session_id, user_id,
role ENUM('host','cohost','participant'), ticket_fingerprint CHAR(64), joined_at DATETIME(3),
last_seen_at DATETIME(3), left_at DATETIME(3) NULL, UNIQUE KEY (session_id, user_id), KEY (tenant_id, session_id))`,
`live_session_callbacks(id, tenant_id, session_id, provider, event_id, kind, occurred_at, outcome,
UNIQUE KEY (tenant_id, provider, event_id))`, and for W10-R2
`live_recording_ingests(id, tenant_id, session_id, provider, event_id, provider_recording_id, duration_seconds,
storage_bytes, occurred_at, outcome, UNIQUE KEY (tenant_id, provider, event_id),
UNIQUE KEY (tenant_id, provider, provider_recording_id))`.

**R7 — W10-R2 attendance sink** (owner: academic). `attendance()` returns per-participant merged intervals and
covered seconds; writing them into `attendance_records` needs the academic owner's idempotency key
(`live_session_id + user_id`) and the source-policy decision (manual vs automatic, correction reason).

**R8 — W10-R2 library adapter** (owner: media, blocked on the `videos` insert contract). The ingest currently
reports `library: 'unconfigured'`; a production adapter must create a `videos` row (course/lecture/material binding,
`uploaded_by`, storage keys) and keep `visibility: 'unpublished'` until an explicit publication decision exists.

---

## 6. Honest limits

- **Nothing here is live.** No MySQL, MinIO, scanner or streaming provider was contacted. The SQL adapters are
  typechecked and exercised only against a recording fake that asserts SQL order; MySQL locking, collation and
  `ER_DUP_ENTRY` behaviour are **not** proven.
- **No production composition changed.** The meter SQL store, the gap outbox, the cleanup service, the live core and
  the recording ingest are not imported by `server/src/index.ts`. Storage metering therefore still reports
  `unconfigured` in the deployed lifecycle unless an owner wires the adapter.
- **Two modules have no committed test.** `video-asset-lifecycle.ts` and `media-usage-reconciliation.ts` are existing
  modules; this lane may not add tests to them, so the new cleanup service and the SQL adapter were verified by the
  ad-hoc harnesses in §3.6–3.7, which were deleted after the run. That is weaker evidence than a committed test and
  is reported as **untested** rather than as passing.
- **The live router is unmounted and has no production store.** Its tests cover the service, not HTTP wiring; no
  Express-level test was added (the route file is a new module, but a route test would need the mount that does not
  exist yet).
- **No publication policy is invented.** A recording lands unpublished with a `deny` policy; no guardian-consent,
  retention or "who may watch a class recording" decision was taken.
- **No provider success is claimed.** Every provider-facing path requires an injected signature verifier; an
  unverified payload is ignored and audited.
- **No claim of acceptance.** `reported` is not `accepted`, and this lane did not self-accept any phase.

---

## 7. Inherited-vs-own attribution (short form)

Inherited and unchanged: the atomic meter unit and its 48 tests, `video-usage-events.ts`, playback
entitlement/progress/registry/watermark, `video-security.ts`, `video-processor.ts`, `search.ts`, all 45 existing media
tests, `security/video-access-policy.ts` (read only, codex-owned), `assignment-storage.ts` /
`assignment-scan-worker.ts` (academic, untouched).

Own: the five new files in §2, the appended SQL-adapter/outbox section of `media-usage-reconciliation.ts`, the
appended cleanup section plus the `gapOutbox` dependency in `video-asset-lifecycle.ts`, and the probe block in
`tenant-export.ts`.

---

## 8. Live contract v2 (for schema review)

Written **before** the source correction, at the schema owner's request, so the tables can be fixed once. The same
text is handed over as `WORKBUDDY-LIVE-CONTRACT-V2-20261022.md`.

**This section is a requirement, not a fact.** Nothing here is implemented as SQL, migrated, wired or proven
against MySQL. The only executable evidence in the repo is a hermetic in-memory adapter whose staging/rollback is a
**seam model** (§8.9), not MySQL proof. No schema file, migration or SQL adapter was written or modified.

### 8.1 Tables the live path needs

All timestamps are epoch milliseconds (`BIGINT`), because every value the service handles (`startsAtMs`,
`endedAtMs`, `joinedAtMs`, `occurredAtMs`, `leftAtMs`) is an integer millisecond count and converting to `DATETIME(3)`
would introduce a timezone step the service never sees. If the schema owner prefers `DATETIME(3)`, the adapter — not
the service — owns that conversion.

#### 8.1.1 `live_sessions`

| column | type | null | notes |
|---|---|---|---|
| `id` | `CHAR(36)` | NOT NULL | primary key |
| `tenant_id` | `CHAR(36)` | NOT NULL | every read is tenant-scoped |
| `host_user_id` | `CHAR(36)` | NOT NULL | the only principal allowed to drive the lifecycle |
| `title` | `VARCHAR(200)` | NOT NULL | service truncates to `LIVE_TITLE_MAX_LENGTH` |
| `state` | `ENUM('scheduled','live','ended','cancelled')` | NOT NULL | default `'scheduled'` |
| `provider` | `VARCHAR(128)` | NULL | provider key, `NULL` when no provider |
| `provider_room_id` | `VARCHAR(128)` | NULL | provider key, `NULL` when no provider |
| `starts_at_ms` | `BIGINT` | NOT NULL | |
| `ended_at_ms` | `BIGINT` | NULL | written **only** together with `state = 'ended'` |
| `max_participants` | `INT UNSIGNED` | NOT NULL | 1..5000 (`MAX_PARTICIPANTS_CEILING`) |
| `created_at_ms` | `BIGINT` | NOT NULL | |

Unique keys: `PRIMARY KEY (id)`, `UNIQUE KEY uq_live_session_room (provider, provider_room_id)`.
MySQL allows repeated `NULL`s in a unique key, so sessions without a provider do not collide.
Secondary: `KEY idx_live_sessions_tenant (tenant_id, state, starts_at_ms)`.

#### 8.1.2 `live_session_participants`

| column | type | null | notes |
|---|---|---|---|
| `id` | `CHAR(36)` | NOT NULL | primary key |
| `tenant_id` | `CHAR(36)` | NOT NULL | |
| `session_id` | `CHAR(36)` | NOT NULL | |
| `user_id` | `CHAR(36)` | NOT NULL | |
| `role` | `ENUM('host','cohost','participant')` | NOT NULL | host is derived from `live_sessions.host_user_id`, never from a body value |
| `ticket_fingerprint` | `CHAR(64)` | NOT NULL | sha256 of the ticket, never the ticket |
| `joined_at_ms` | `BIGINT` | NOT NULL | start of the **current** presence interval |
| `last_seen_at_ms` | `BIGINT` | NOT NULL | |
| `left_at_ms` | `BIGINT` | NULL | `NULL` means active |

Unique keys: `PRIMARY KEY (id)`, `UNIQUE KEY uq_live_participant (session_id, user_id)`.
The second key is what makes "one actor, one row, one count" enforceable: a rejoin **updates** the row instead of
inserting a second one, so capacity cannot be inflated by repeated joins.
Secondary: `KEY idx_live_participant_active (session_id, left_at_ms)` — the admission count reads this.

#### 8.1.3 `live_session_callbacks`

| column | type | null | notes |
|---|---|---|---|
| `id` | `CHAR(36)` | NOT NULL | primary key |
| `tenant_id` | `CHAR(36)` | NOT NULL | always the **session row's** tenant, never the callback claim |
| `session_id` | `CHAR(36)` | NOT NULL | |
| `provider` | `VARCHAR(128)` | NOT NULL | |
| `event_id` | `VARCHAR(128)` | NOT NULL | provider event id |
| `kind` | `VARCHAR(32)` | NOT NULL | one of the four normalised kinds |
| `occurred_at_ms` | `BIGINT` | NOT NULL | |
| `outcome` | `VARCHAR(48)` | NOT NULL | see below |

Unique keys: `PRIMARY KEY (id)`, `UNIQUE KEY uq_live_callback (tenant_id, provider, event_id)`.
Terminal `outcome` values the service writes: `'applied'`, `'rejected:illegal-transition'`,
`'ignored:unknown-participant'`, `'ignored:malformed'`.
`'pending'` is a **transient claim** written at the start of a unit and must be replaced by a terminal value before
the unit commits. `'pending'` must never be observable after a commit; if a row is found `'pending'`, the unit
failed and rolled back incorrectly — it is a defect signal, not a state.

#### 8.1.4 `live_recording_ingests` (recording ingest ledger)

| column | type | null | notes |
|---|---|---|---|
| `id` | `CHAR(36)` | NOT NULL | primary key |
| `tenant_id` | `CHAR(36)` | NOT NULL | session row tenant |
| `session_id` | `CHAR(36)` | NOT NULL | |
| `provider` | `VARCHAR(128)` | NOT NULL | |
| `event_id` | `VARCHAR(128)` | NOT NULL | |
| `provider_recording_id` | `VARCHAR(128)` | NOT NULL | |
| `duration_seconds` | `INT UNSIGNED` | NOT NULL | |
| `storage_bytes` | `BIGINT UNSIGNED` | NOT NULL | |
| `occurred_at_ms` | `BIGINT` | NOT NULL | |
| `outcome` | `VARCHAR(32)` | NOT NULL | `'pending'` then the terminal ingest outcome |

Unique keys: `PRIMARY KEY (id)`, `UNIQUE KEY uq_ingest_event (tenant_id, provider, event_id)`,
`UNIQUE KEY uq_ingest_recording (tenant_id, provider, provider_recording_id)`.
Two keys, because a provider may replay one event **and** send a second event naming the same recording; both must
collapse to one asset.

#### 8.1.5 `live_session_presence_intervals` — **required**

| column | type | null | notes |
|---|---|---|---|
| `id` | `CHAR(36)` | NOT NULL | primary key |
| `tenant_id` | `CHAR(36)` | NOT NULL | |
| `session_id` | `CHAR(36)` | NOT NULL | |
| `participant_id` | `CHAR(36)` | NOT NULL | the row in 8.1.2 |
| `user_id` | `CHAR(36)` | NOT NULL | denormalised for the per-actor read |
| `joined_at_ms` | `BIGINT` | NOT NULL | interval start |
| `left_at_ms` | `BIGINT` | NULL | `NULL` while open |
| `close_reason` | `ENUM('leave','callback','session-ended')` | NULL | set with `left_at_ms` |

Unique keys: `PRIMARY KEY (id)`, `UNIQUE KEY uq_presence_interval (session_id, user_id, joined_at_ms)`.
Secondary: `KEY idx_presence_open (session_id, user_id, left_at_ms)`.

Why it is required: §8.8. The participant row can hold only one interval, so without this table a rejoin destroys the
earlier interval and attendance silently under-reports. The code in this correction does **not** write this table; it
is a schema request, not an implementation claim.

### 8.2 Exact transaction boundaries

One unit per operation. "Unit" means one `withTransaction` call on one connection.

| operation | statements that must be in the **same** unit |
|---|---|
| `createSession` | `INSERT live_sessions`; `INSERT audit_events` (`live.session.created`) |
| `startSession` / `endSession` / `cancelSession` | `SELECT … FROM live_sessions WHERE id=? AND tenant_id=? FOR UPDATE`; `UPDATE live_sessions SET state=?, ended_at_ms=? WHERE id=? AND tenant_id=? AND state=<expected>`; `INSERT audit_events` (`live.session.<next>`) |
| `join` (admission) | `SELECT … FROM live_sessions WHERE id=? AND tenant_id=? FOR UPDATE`; the active-participant count **and** the actor's existing row read; `INSERT`/`UPDATE live_session_participants`; `INSERT audit_events` (`live.participant.joined` / `live.participant.rejoined`) |
| `leave` | `SELECT … FOR UPDATE live_sessions`; `UPDATE live_session_participants SET left_at_ms=?, last_seen_at_ms=? WHERE session_id=? AND user_id=? AND left_at_ms IS NULL`; `INSERT audit_events` (`live.participant.left`) |
| callback — claim and apply | `INSERT live_session_callbacks (outcome='pending')` (the unique key claims the event); the CAS on `live_sessions` or the participant row; `UPDATE live_session_callbacks SET outcome='applied' WHERE id=? AND outcome='pending'`; `INSERT audit_events` (`live.callback.applied`) |
| callback — decision after the claim (illegal transition, unknown participant, malformed participant id) | `INSERT live_session_callbacks (outcome='pending')`; `UPDATE … SET outcome='rejected:illegal-transition' \| 'ignored:unknown-participant' \| 'ignored:malformed'`; `INSERT audit_events` |
| callback — decision before any claim (unverified signature, malformed envelope, unknown session, cross-tenant, outside grace) | one `INSERT audit_events` in its own unit. No ledger row: there is no trusted session row (or no claimed marker) for the row to belong to, and the audit `reason` **is** the terminal outcome |
| recording ingest | `INSERT live_recording_ingests` (with both unique keys) in its own unit. The library asset and the storage meter are external ports and are **not** in that unit (§8.7) |
| read paths (`getSession`, `attendance`) | no unit; a single tenant-scoped read |

Deliberate consequence: a decision that never reached a marker writes one audit row and nothing else. A decision that
did reach a marker writes the marker's terminal outcome **and** its audit, or neither.

### 8.3 Locking, isolation and lock order

- **Isolation.** `READ COMMITTED` minimum for every unit. `REPEATABLE READ` is acceptable only if every predicate
  read inside the unit is a locking read (`FOR UPDATE` / `FOR SHARE`); a snapshot count is exactly the bug this
  contract exists to remove.
- **Lock order.**
  1. `live_sessions` row (the session being mutated);
  2. `live_session_participants` rows of that session;
  3. `audit_events` (append-only; no lock taken, no read back);
  4. metering: **tenant counter before asset counter** (unchanged W6 order, already implemented in
     `media-usage-reconciliation.ts`).
  Two units therefore cannot take the session row and a participant row in opposite orders, and a join and a leave of
  the same session serialise on the same first lock.
- **Why admission cannot be decided from a pre-read.** Capacity is a *predicate* over rows another unit is about to
  insert: `COUNT(DISTINCT user_id) WHERE left_at_ms IS NULL < max_participants`. Two units that read that count
  without holding the session row lock both observe the pre-insert state and both insert, so the session ends with
  `max + 1` active participants even though each unit individually saw "room available". The row lock on
  `live_sessions` makes the count and the insert one serialised pair: the second unit's count runs after the first
  unit's commit. The count must therefore be taken **after** the lock is held, inside the same unit as the write, and
  must count **distinct `user_id`s** — never rows, never joins.
- **Deadlock.** Bounded: one session row then its participant rows. Cross-session units share no participant rows.
  A unit that must touch two sessions is not part of this contract.

### 8.4 CAS predicates the adapter must implement

| write | predicate | meaning of `affectedRows = 0` |
|---|---|---|
| session transition | `UPDATE live_sessions SET state=?, ended_at_ms=? WHERE id=? AND tenant_id=? AND state=<expected>` | the state moved under us → `conflict` (host path) / `illegal-transition` (callback path); the unit must not audit success |
| `ended_at_ms` | written in the **same** statement as `state='ended'`, never a second update | a separate update would allow `ended` with no end time |
| participant presence refresh | `UPDATE live_session_participants SET role=?, ticket_fingerprint=?, last_seen_at_ms=?, left_at_ms=NULL, joined_at_ms=IF(left_at_ms IS NULL, joined_at_ms, ?) WHERE session_id=? AND user_id=?` | no row → `INSERT`; a concurrent `INSERT` loses on `uq_live_participant` (`ER_DUP_ENTRY`), which the adapter must treat as "row exists": re-read and retry the update **once**, inside the same unit |
| participant leave | `UPDATE … SET left_at_ms=?, last_seen_at_ms=? WHERE session_id=? AND user_id=? AND left_at_ms IS NULL` | already left → idempotent no-op, not an error |
| marker finalize | `UPDATE live_session_callbacks SET outcome=? WHERE id=? AND outcome='pending'` | already terminal → roll the unit back and report a conflict; never overwrite a committed decision |
| ingest ledger claim | `INSERT …` relying on both unique keys | duplicate event → `event-replay`; duplicate recording → `recording-exists` |

`joined_at_ms` on an active row is **not** refreshed (the interval keeps its original start); on a row that already
left it **is** replaced with the new join time (a new interval). That is the only presence semantics the current
single-pair row can express — see §8.8.

### 8.5 Dedupe keys and replay semantics

Keys: `live_session_callbacks (tenant_id, provider, event_id)`;
`live_recording_ingests (tenant_id, provider, event_id)` and `(tenant_id, provider, provider_recording_id)`.

- **Replay after a rolled-back failure.** Nothing was committed — no marker, no state change, no audit — so the
  replay claims the key again and performs the work. This is the property the old `outcome: 'pending'`-before-CAS
  ordering destroyed: the marker survived the failure and every replay answered `duplicate`, so the transition could
  never be applied.
- **Replay after a committed decision.** The marker is terminal; the claim fails on the unique key; the service
  returns `duplicate` and applies nothing. A committed decision is never re-evaluated, and a committed `applied` is
  never applied twice.
- **Replay of a decision that never claimed a marker** (unverified, malformed, unknown session, cross-tenant, outside
  grace) is not deduplicated by the ledger: those branches write only an audit and return the same status again.
  Their response contract is unchanged by this correction.

### 8.6 What `withTransaction` must guarantee (requirement, not implemented fact)

- Real `BEGIN` … `COMMIT`, and `ROLLBACK` on any throw, with the original error rethrown after the rollback.
- **One connection.** Every statement inside `work` must run on the unit's connection. A unit that quietly uses the
  pool autocommits and voids the entire contract; the port must make that impossible by construction (unit handle,
  not a store that resolves its own connection).
- Isolation: `READ COMMITTED` minimum; `REPEATABLE READ` only with locking reads (§8.3).
- Deadlock / lock-timeout retry is **owned by the adapter**, for the whole unit, bounded (3 attempts, only
  `ER_LOCK_DEADLOCK` / `ER_LOCK_WAIT_TIMEOUT`), and only while the unit has no external side effect. A unit that has
  already called the meter or the library must not be retried by the adapter — the provider replay is the retry.
- A failed `ROLLBACK` must surface as an error. It must never be reported as a successful commit.
- **No autocommit fallback.** If the port is absent, the service returns `transaction-required`
  (`createSession`, `startSession`/`endSession`/`cancelSession`, `join`, `leave`, `applyProviderCallback`). There is
  no code path that writes outside a unit.

### 8.7 Recording ingest ordering (declared gap, not fixed here)

- Order in `live-recording-ingest.ts`: resolve the session from the provider room → `insertIngest` (ledger, unique
  keys) → storage meter (external) → library asset (external) → audit.
- **The ledger is committed first.** It is the only transactional side; the meter and the library are external
  ports. No atomicity is claimed across them, and this correction does not add one.
- `deferred` means: the ledger row exists, the external write did **not** confirm. `unconfigured` means the port was
  not supplied. Neither is a measurement and neither may be reported as one.
- **A crash between the ledger insert and the library write is a declared gap.** The committed ledger row is the
  durable evidence of that gap. A provider replay of the same event returns `duplicate`, because the unique key is
  already committed — so the missing asset is *not* repaired by replay. Repair requires a reconciliation read of
  non-terminal rows, which is **not implemented** (request R9).
- Requirement for the durable adapter: the ledger claim runs in its own unit (so two concurrent deliveries cannot
  both pass the key check), and the outcome is finalised in a **second** unit after the external calls
  (`finalizeIngest(id, outcome)`). A crash before finalisation leaves a repairable `'pending'` row.

> **Superseded by §8.10 (supervisor, same session).** The paragraph above was written when both units were still a
> requirement. They now exist in `live-recording-ingest.ts`, and the "replay returns `duplicate`" statement is no
> longer true for a `pending` row: a pending marker is resumable. §8.10 is the current contract for this path.

### 8.8 Presence-interval limitation (data model, not papered over)

`live_session_participants` holds a single `joined_at_ms` / `left_at_ms` pair per `(session_id, user_id)`. A rejoin
after a leave therefore **overwrites** the earlier presence interval, and `deriveAttendance` — which reads the rows
it is given — can only ever see the latest interval per actor. Attendance for a participant who joined, left and
rejoined silently loses the first interval.

This is a **data-model limitation**, not a bug to be patched in the service: inventing a second interval inside the
single row (or in an untyped side field) would produce a value the durable adapter cannot store. The fix is the
append-only table in §8.1.5, and the code change that follows from it is a separate, schema-gated task. The current
`deriveAttendance` contract (merge overlapping intervals, clamp to the session window, count open presence only on
request) stays exactly as it is.

### 8.9 The in-memory adapter is a seam model, not MySQL proof

`createInMemoryLiveSessionStore()` now implements `withTransaction` by staging a copy of its rows, running the unit
against the copy, committing by in-place replacement on success and discarding the copy on a throw. It serialises
units with a single in-process promise queue, which is *stronger* than per-session locking.

That models the **shape** of a unit (stage → commit or discard) so the mandatory-unit requirement, the rollback and
the "no poisoned marker" property are testable in a hermetic run. It proves **nothing** about MySQL: no SQL is
generated, no isolation level exists, no deadlock is possible, `ER_DUP_ENTRY` is not exercised, and a process crash
is not simulated. Any claim of durability or of a real lock must wait for the SQL adapter and a real database.

### 8.10 Supervisor addendum — the ingest ledger is unit-bound and a pending marker is resumable

Written after reviewing the correction (§9.10). It supersedes the last paragraph of §8.7 and completes §8.5 for the
recording path.

**Port.** `RecordingIngestStore` now extends `RecordingIngestUnit` and carries a mandatory
`withTransaction?<T>(work: (unit: RecordingIngestUnit) => Promise<T>): Promise<T>`. The unit is
`findSessionByProviderRoom` / `findIngest(tenantId, provider, eventId)` / `insertIngest` / `finalizeIngest(id,
outcome)` / `recordAudit`. A store without it is refused with `{status:'rejected', reason:'transaction-required'}`
and **nothing is written** — no ledger row, no library asset, no meter call.

**Two units, no third write.**

1. **Claim unit** — `findIngest` (is this event already known?) then `insertIngest(outcome='pending')`. Both
   statements are in the unit so two concurrent deliveries cannot both pass the key check on a pre-read.
2. **Terminal unit** — `finalizeIngest(id, outcome)` plus the terminal `live.recording.ingested` audit. The audit
   carries `ledger_outcome`, so an audit that records a still-pending marker says so instead of implying success.

The storage meter and the library asset remain **external** calls between the two units. No atomicity is claimed
across them and none is possible; what changed is that their failure no longer destroys the event.

**Replay semantics (replaces "a committed marker is always a duplicate").**

| marker state on replay | behaviour |
|---|---|
| absent | claim and process normally |
| `pending` | **resume**: re-drive the meter (same `operationId`) and the library, then finalise |
| `ingested` (terminal) | `duplicate / event-replay`, nothing re-driven |
| second event naming the same recording | `duplicate / recording-exists` |

Resume is only safe because both external ports are idempotent by key — the meter dedupes on `operationId` (the
provider event id) and `createRecordingAsset` answers `created:false` for an existing `(tenant, provider,
recording)`. **The durable adapter and both ports must keep those guarantees**; if either loses them, resume becomes
a double write and this contract is void.

**Adapter requirements.** `finalizeIngest` must be `UPDATE … SET outcome = ? WHERE id = ? AND outcome = 'pending'`
and report the affected row count, so two concurrent resumes cannot both settle the marker. The claim unit must be
serialised per `(tenant, provider, event_id)` at minimum by the unique key, and the terminal unit must not be retried
by the adapter once an external port has been called — the provider redelivery is the retry.

**What is still open.** A reconciliation sweep over `outcome = 'pending'` rows is **not implemented** (request R9).
The difference from the earlier state is that the repair set is now *queryable* (`WHERE outcome = 'pending'`) instead
of invisible, and a provider replay repairs it without a sweep. A library that never recovers still needs the sweep.

> **§10 supersedes this section's resume/finalise paragraph** (2026-10-22, task
> `server-closure-recording-resume-safety-20261022-01`). `finalizeIngest` is now guarded and returns affected rows, a
> resume must win an explicit lease, and an unconfigured required library no longer settles the marker. §8.10 stays
> here unedited as the record of what was declared before that correction.

---

## 9. Atomicity correction (2026-10-22)

Task `server-closure-media-live-atomicity-correction-20261022-01` · worker
`wb-media-live-atomicity-correction-20261022-01` · team `media`. A **source correction of three defects** in the
W10-R1/W10-R2 delivery, not a rewrite and not a feature: every existing behaviour, response shape and denial code is
preserved, and the contract in §8 was written **before** the code.

Baseline: the 51 pre-claim paths in `WORKBUDDY-LIVE-CORRECTION-BASELINE-20261022.md`. All 51 were re-hashed after the
correction: **45 are byte-identical** and exactly **6 changed** — the four files below plus the two test files. No
file was created inside the repo.

### 9.1 Defect A — no atomic unit (acceptance 1)

**Before.** Every mutation wrote through `store.*` and then called a **separate** `audit()` (`store.recordAudit`):
`createSession` (:610-630), `transition` (:569-585), `join` (:710-728), `leave` (:747-757),
`applyProviderCallback` (:851-949). There was no transaction port. Two consequences: a failure between the state
write and the audit left a half transition, and the callback inserted its dedupe marker with `outcome: 'pending'`
**before** the transition (:851-861), so a failed CAS or a throw left the marker behind — every replay answered
`{status:'duplicate'}` and the transition could never be applied.

**After** (`server/src/services/live-session-core.ts`):

| change | symbol / line |
|---|---|
| new unit port; every method must run on the unit's connection | `LiveSessionUnit` :355 |
| serialised admission added to the port | `admitParticipant` :375 |
| marker finalisation added to the port | `finalizeCallback` :387 |
| **mandatory** unit; absent ⇒ typed refusal, no autocommit path | `LiveSessionStore.withTransaction` :395-400 |
| single refusal helper | `runUnit` :622 |
| one-audit decision in its own unit | `decide` :631 |
| state CAS + audit in one unit | `transition` :642 |
| insert + audit in one unit | `createSession` :689 |
| read + admission + audit in one unit | `join` :752 (admission :811) |
| presence write + audit in one unit | `leave` :844 |
| claim → apply → finalise → audit in one unit | `applyProviderCallback` :872, claim :979 / :1051, finalise :992 / :1017 / :1031 / :1064 / :1078 / :1100 |
| typed refusal in each result union | `JoinDenialReason` :520, `CreateSessionResult` :534, `SessionTransitionResult` :540, `LeaveResult` :544, `ProviderCallbackResult` :563 |

Behaviour of the unit: success commits marker + state/presence + audit together; **any** throw rolls all of them back
and propagates, so the caller never sees success for a partly applied unit and a later replay still finds the work.
A decision that owns a marker (illegal transition, unknown participant, malformed participant id) commits the
marker's terminal outcome **and** its audit; a decision reached before a marker exists (unverified, malformed
envelope, unknown session, cross-tenant, outside grace) is one audit in its own unit and writes no ledger row. The
`pending` outcome is now transient only — it cannot be observed after a commit.

`server/src/routes/live-sessions.ts` gained the 503 mapping for the new refusal only (`:54`, `:113`, `:141`, `:188`,
`:239`). No existing status code changed.

### 9.2 Defect B — capacity race (acceptance 2)

**Before.** `join` (:676-720) did `listParticipants` → count `leftAtMs === null` → `upsertParticipant`. Two
concurrent joins both observed `activeCount < maxParticipants` and both inserted. Measured, not assumed: a scratch
reproduction of that exact sequence against the adapter's autocommit methods produced
`{"results":["admitted","admitted"],"active":2,"capacity":1}` — 2 admitted into a 1-seat session.

**After.** The service no longer counts at all. `join` (:752) calls `unit.admitParticipant` (:811), and the adapter
takes the decision **inside** the unit (:1198): it counts **distinct `user_id`s** with `left_at_ms IS NULL`, refreshes
an existing row instead of inserting a second one, keeps an active row's original `joined_at_ms`, and starts a new
interval for a row that had left. Capacity therefore cannot be decided from a pre-read snapshot, and one actor can
never occupy two seats.

### 9.3 Defect C — untrusted tenant in the audit partition (acceptance 3)

**Before.** `applyProviderCallback` read `tenantClaim` from the callback body and stamped it into the audit on the
unverified-signature (:779-786), malformed (:791-798) and unknown-session (:804-811) branches; the ingest had the
identical defect at :315-323, :327-335 and :340-348. An attacker chose which tenant's audit partition received a
security event.

**After.** Those three branches audit with `tenantId: null` — a global security event — in both modules
(`live-session-core.ts` :898, :910, :923; `live-recording-ingest.ts` :329, :342, :356). The claim is still recorded as
bounded **evidence** (`newValue.tenant_claim`, :883 and :314), never as a partition. Once the session row resolves,
only `session.tenantId` is used (:935-945 cross-tenant, :955-964 outside grace, :1031-1040 applied; ingest :368-380). The
verified-mismatch branch was already correct and still uses the trusted row tenant only. Every branch returns the
same status and reason as before — this changed the destination of the audit, not the response.

### 9.4 Files, attribution and before→after bytes

| path | attribution | before (sha256 / bytes) | after (sha256 / bytes) |
|---|---|---|---|
| `server/src/services/live-session-core.ts` | inherited (W10-R1) + **own correction** | `846e5d1daa8620c06bc10abc6cc9e1ccd5ed71b4ed569980986604405ff030ab` / 46277 | `fdc5034a12e11468fdd39732f82febc387337cb5391db9b93d7993d561e6c302` / 61961 |
| `server/src/services/live-recording-ingest.ts` | inherited (W10-R2) + **own correction** | `7c2994988ac771509529f698b462a47942496f126b75ffaba9c3dde1e785ca27` / 25830 | `143351fbb7762942274a294ce372e26ca0a4a96c0dc08683876a1ae8bea07a30` / 27037 |
| `server/src/routes/live-sessions.ts` | inherited (W10-R1) + **own correction** | `7115bbc509226aecf9184bae83140ccbe6f1a20974bd4a7564fb67e5eeefcc4f` / 10214 | `44af3355df2e29a1dd4284e42c384cb382b12656b0ee9b3a2841676646ffb705` / 10943 |
| `server/tests/live-session-core.test.ts` | inherited (W10-R1) + **own correction** | `acb8d8ef69af4ef7feb2e898e7586d2c28a65daf004d3001891cb7b2fde71cdd` / 15795 | `5d4f1785a7f7de9f5aab27816cd539e0469de7782319af7637f8d6dc1e56db28` / 26727 |
| `server/tests/live-recording-ingest.test.ts` | inherited (W10-R2) + **own correction** | `4ccf2ea70d2448f0379ea29987234f0f248107d9b842b2f50fdc1e9993c38760` / 10657 | `8a47824a9ca10e02f9996b5110933b04358b4d452bbdea1f3a62d4afbb996b44` / 12554 |
| `docs/streams/server/WORKBUDDY-CLOSURE-MEDIA-20261022.md` | inherited (own, earlier lane) + **own §8/§9** | `69de0df61ab2f2619004cc6ae19f20882b3ef792e5b9428b515d9988575ca469` / 18536 | not self-referential — this file's own after-hash is recorded in the task evidence, not inside itself |

Inherited and untouched by this correction: the other 45 media paths, every inherited export and behaviour of the
two live modules (state machine, ticket signing/verification, host authority, tenant scoping, grace window, dedupe
keys, descriptor planner, `deny`/`unpublished` ingest defaults, attendance derivation), and every inherited
assertion.

### 9.5 Commands run, and their exact counts

All test commands ran from `server/` as
`M1_NETWORK_MODE=hermetic node --require ../scripts/m1-network-guard.cjs --import tsx --test <files>`.

| # | command | result |
|---|---|---|
| 9.5.1 | `node node_modules/typescript/bin/tsc --noEmit -p server/tsconfig.json` (repo root) | **exit 0**. First run reported one error of my own — `live-session-core.ts(626,35) TS2322` in `runUnit` — fixed by calling the narrowed optional method directly; final run is clean |
| 9.5.2 | `tests/live-session-core.test.ts tests/live-recording-ingest.test.ts` (before adding tests) | **20/20 pass** — the 20 inherited tests are green against the corrected source, unchanged |
| 9.5.3 | `tests/live-session-core.test.ts` | **17/17 pass** (was 11) |
| 9.5.4 | `tests/live-recording-ingest.test.ts` | **10/10 pass** (was 9) |
| 9.5.5 | scratch reproduction of the pre-correction join sequence (temp file outside the repo, deleted after the run) | `{"results":["admitted","admitted"],"active":2,"capacity":1}` — the old algorithm really does over-admit |

Not run, deliberately: the full suite, any other suite, any DB, provider, listener or live operation.

### 9.6 Existing assertions

None deleted, skipped, weakened or edited. The only change to the inherited test bodies is the harness signature in
`live-session-core.test.ts` (an optional `wrap` hook that observes/fails the **real** staged unit, plus the
`storeForCore` binding) and the header bullet lists. Every inherited `assert` is byte-identical, and 9.5.2 proves it
by running them unchanged against the new source.

### 9.7 Per-item status

| item | status |
|---|---|
| Mandatory unit for create/transition/join/leave (A) | **implemented**, tested hermetically, **live-unproven**, **not wired** |
| Callback marker + transition/presence + audit co-commit; no poisoned replay marker (A) | **implemented**, tested hermetically, **live-unproven**, **not wired** |
| Typed `transaction-required` refusal, no autocommit fallback (A) | **implemented**, tested hermetically, **live-unproven** |
| Serialised capacity admission + distinct-active count + same-actor rejoin (B) | **implemented**, tested hermetically, **live-unproven** (the in-memory unit uses one in-process queue, not a row lock) |
| Trusted-tenant audit partition (C, both modules) | **implemented**, tested hermetically, **live-unproven** |
| Durable `withTransaction` / SQL adapter | **policy-held** — schema owner's; no SQL, DDL or migration written |
| Live contract v2 (§8) | **contract-only**, handed to the schema owner; nothing wired |
| Recording-ingest ledger/asset/meter ordering | **policy-held / declared gap** — the ledger commits first, the external writes cannot be atomic with it (R9) |
| Presence intervals across a rejoin | **policy-held** — needs the append-only table in §8.1.5 (R10); the data-model loss is not papered over |
| Router mount / production store | unchanged: **not wired**, `server/src/index.ts` untouched |

### 9.8 Residual limits this correction cannot close

- The in-memory unit is a **seam model**: staged copy, one in-process queue, no isolation level, no `ER_DUP_ENTRY`,
  no deadlock, no crash. It proves the shape of the unit, not MySQL.
- There is still **no durable adapter**, so the live router stays unmounted and every live path remains
  **live-unproven**.
- `join` reads the session inside the unit, but the *lock* is the adapter's obligation (§8.3). The reference adapter
  serialises globally, which is stronger than per-session and therefore proves nothing about lock granularity.
- The callback resolves the session by provider **before** the unit (a read). A concurrent state change is caught by
  the CAS inside the unit and is recorded as `rejected:illegal-transition`; the read itself is not transactional.
- The recording ingest still commits its ledger with `pending` and never finalises it; a crash after the ledger and
  before the library write remains a declared, un-repaired gap (R9).
- A rejoin after a leave still overwrites the earlier presence interval (§8.8). Attendance under-reports and this
  correction does not hide it.

### 9.9 New requests for the schema owner

- **R9** — ingest finalisation: ~~`finalizeIngest(id, outcome)` in a second unit~~ **done by the supervisor addendum
  (§9.10, §8.10)**; what remains is a **reconciliation read** of non-terminal `live_recording_ingests` rows
  (`WHERE outcome = 'pending'`), so a library that never recovers can be repaired by a sweep and not only by a
  provider replay.
- **R10** — `live_session_presence_intervals` (§8.1.5) and the code change that appends an interval on join and
  closes it on leave/callback, replacing the single-pair row as the attendance source.
- **R11** — confirm the `BIGINT` epoch-ms columns in §8.1 (or accept an adapter-owned conversion to `DATETIME(3)`).

### 9.10 Supervisor edit — attributed separately, not the worker's work

While reviewing the delivery above I found that acceptance 1 was **not** met on the recording path, and closed it
myself. This section exists so the two sets of bytes are never confused.

**The gap.** `live-recording-ingest.ts` had no transaction port at all. `insertIngest(outcome:'pending')` was a bare
store call, the terminal `live.recording.ingested` audit was a second bare call, and `insertIngest` returning
`inserted:false` was answered `duplicate` **regardless of the row's outcome**. So a delivery whose library write
failed committed a `pending` row and every later delivery of the same event was refused as a duplicate: the
recording was permanently lost while the marker claimed the event had been handled. That is the same poisoned
replay marker the correction removed from `live-session-core.ts`, one file over — and §8.7 had *declared* it instead
of fixing it, which I had under-specified in the brief.

**What I changed** (both files are in this task's `allowedPaths`):

| file | worker delivery | after the supervisor edit | bytes |
|---|---|---|---|
| `server/src/services/live-recording-ingest.ts` | `143351fb…a07a30` | `55cac360f96210ca7da6126efe70e0fcea0033bff6ca9c3f5675b76958b7d421` | 27037 → 33831 |
| `server/tests/live-recording-ingest.test.ts` | `8a47824a…996b44` | `ee1628d8c0a11020f75a1a4788236c5988807c9378dc0dfa9fc362e014c47214` | 12554 → 16991 |

- `RecordingIngestStore` now extends `RecordingIngestUnit` (`findIngest`, `finalizeIngest`) and carries a mandatory
  `withTransaction`; the service refuses with `transaction-required` and writes nothing when it is absent.
- The claim (`findIngest` + `insertIngest('pending')`) is one unit; `finalizeIngest` + the terminal audit are a
  second unit; the audit records `ledger_outcome`.
- A `pending` row is **resumed** instead of answered `duplicate`; a settled row is still `duplicate`.
- The in-memory adapter gained real staging + rollback (staged copy, in-place commit, discard on throw, serialised
  by one queue), matching the core's model — still a seam model, not MySQL proof.

**Evidence I ran myself** (not the worker's numbers):

```
cd server && M1_NETWORK_MODE=hermetic node --require ../scripts/m1-network-guard.cjs --import tsx \
  --test tests/live-session-core.test.ts tests/live-recording-ingest.test.ts
# tests 29 / pass 29 / fail 0 / skipped 0     (core 17, ingest 12)
node node_modules/typescript/bin/tsc --noEmit -p server/tsconfig.json   # exit 0
```

Two tests are new and both fail against the previous behaviour: *"a failed library leaves a repairable pending
marker that a replay finishes"* (asserts `outcome === 'pending'` after the failure, then a settled row and one asset
after the replay, with the same meter `operationId` both times) and *"a store without a transaction unit refuses the
callback and writes nothing"*. All 10 inherited ingest tests pass unchanged — no assertion was edited, skipped or
deleted, and the two dedupe assertions still hold because a **settled** marker is still a duplicate.

**Status.** implemented, tested hermetically, **live-unproven**; the durable adapter and the `pending` sweep are
still R9. Nothing was mounted and no schema was touched.

---

## 10. Recording resume safety (2026-10-22)

Task `server-closure-recording-resume-safety-20261022-01` · worker
`wb-media-recording-resume-safety-20261022-01` · team `media` · approvalVersion 2. This section is the delivery
record of **this worker**; §9.10 above is the supervisor's own edit and is not attributed here.

A **source correction**, not a rewrite: five defects in `server/src/services/live-recording-ingest.ts` and the
expectations they encoded in `server/tests/live-recording-ingest.test.ts`. Every pre-existing protection is kept
unchanged — signature-first, tenant from the session row, `tenantId: null` on unresolved-callback audits, mandatory
`withTransaction` with `transaction-required`, both dedupe keys, the `deny`/`unpublished` descriptor, the grace window
and the duration/bytes caps. No file outside the task's 51 `allowedPaths` was written; no file was created inside the
repo; no schema, migration, index or `server/src/index.ts` change was made.

Baseline: the 51 `allowedPaths` were hashed **before** the first edit. After the edits (this document included),
**48 are byte-identical and exactly 3 moved** — the two code/test files below and this document. No other lane's file
was touched by this worker.

### 10.1 The five defects (pre-edit line anchors)

| id | defect | pre-edit anchor | why it mattered |
|---|---|---|---|
| D1 | an unconfigured required library was terminalised as success: `library === 'deferred' ? 'pending' : 'ingested'` | `:600` | `library === 'unconfigured'` (no port supplied) settled the marker `ingested` and wrote `live.recording.ingested`. After the library was later configured, every redelivery found a settled marker and answered `duplicate / event-replay` **forever**: the recording was lost behind an audit line claiming it was ingested. |
| D2 | a `pending` resume had no ownership and no fence | `:470-495` (claim), `:515-594` (external calls) | two concurrent deliveries both saw `pending`, both ran the meter and the library, both finalised and both wrote a success audit. Nothing recorded which attempt owned the row. |
| D3 | the guarded transition result was discarded | `:603` | `await unit.finalizeIngest(...)` ignored the affected-row count, so a stale or losing claimant wrote `live.recording.ingested` for a transition it did not perform. §8.10 had already *declared* that `finalizeIngest` must report affected rows; the code did not implement its own declared contract. |
| D4 | the external sink keys were not provider-scoped, and one was not meter-legal | `:531-534` | `assetId: providerRecordingId` and `operationId: eventId`. Two providers both using `rec-1` inside one tenant collapsed into one meter asset; a provider recording id containing `:` (legal under `PROVIDER_KEY_RE`) was refused by `ASSET_ID_RE`, deferring metering forever with `invalidAsset`. |
| D5 | the audit action lied about state | `:607` | `live.recording.ingested` was written even when `ledger_outcome` was `pending`. A terminal-success action name must only mark a committed, own, guarded terminal transition. |

### 10.2 What changed (post-edit anchors)

| change | symbol / line |
|---|---|
| header rewritten: split units, no rollback of external effects, unknown outcome ≠ duplicate effect, seam-model limits | `:1-69` |
| bounded lease constant, documented trade-off | `RECORDING_INGEST_CLAIM_LEASE_MS` `:90` (5 min) |
| owner bound for the ledger column | `RECORDING_CLAIM_OWNER_MAX_LENGTH` `:74` (64) |
| provider-qualified meter operation id | `buildRecordingMeterOperationId` `:136` |
| provider-scoped, `ASSET_ID_RE`-legal meter asset id | `buildRecordingMeterAssetId` `:150` |
| one library dedupe-key helper | `buildRecordingAssetDedupeKey` `:166` |
| ledger row carries the lease | `RecordingIngestRow.claimOwner` / `.claimExpiresAtMs` `:293-297` |
| optional fenced claim, affected rows | `claimPending` `:331` |
| guarded finalise + release form, affected rows | `finalizeIngest` `:345` |
| distinct non-success variant | `RecordingCallbackResult` `status:'deferred'` `:416-433` |
| claim unit writes the owner on insert / must win `claimPending` on resume | `:643-683` |
| fail-closed branches | `:702-720` |
| provider-scoped meter keys passed to the port | `:742-744` |
| terminality decided by the library only | `const terminal` `:813` |
| guarded terminal transition + audit only when it returned 1 | `:850-897` |
| non-terminal path releases the lease and audits `live.recording.deferred` | `:817-848` |
| in-memory adapter: `claimPending`, guarded `finalizeIngest`, lease fields | `:959-977` |

### 10.3 Terminality — the required sink decides

- `outcome='ingested'` **only** when `library === 'created' || library === 'existing'`.
- `library === 'deferred'` (port threw) **and** `library === 'unconfigured'` (port absent) both leave the marker
  `pending`. They return `deferred / library-error` and `deferred / library-unconfigured` respectively, and audit
  `live.recording.deferred` with `ledger_outcome: 'pending'`.
- Metering remains a **reported gap** and never blocks the library or changes terminality. `metering:
  'deferred' | 'unconfigured'` is still a legitimate terminal ingest when the library succeeded — the existing
  invariant in *"a metering failure is deferred and never blocks the library write"* still passes, untouched.
- A known non-terminal result **releases** its own lease instead of settling. The release is the same guarded
  statement with `outcome: 'pending'` (see §10.4), so a redelivery can retry immediately instead of waiting out a lease
  the attempt knows it will not use. When the release itself returns 0 the audit says `ledger_outcome: 'unknown'`
  rather than claiming the row is still pending.
- A throw from the terminal unit is **not** caught: it rolls the unit back, propagates, leaves the marker `pending`
  with its lease and writes no audit. The provider redelivery is the retry. Catching it and returning `deferred` would
  have implied a known outcome the code does not have.

### 10.4 The fence contract

**Row.** `RecordingIngestRow` gains `claimOwner: string | null` and `claimExpiresAtMs: number | null`.

**Lease.** `RECORDING_INGEST_CLAIM_LEASE_MS = 5 * 60 * 1000`. Too short and a slow external call can outlive its own
lease, letting a second delivery claim the row while the first is still writing (the sinks stay idempotent, but two
attempts then race to declare the transition); too long and an attempt that died between the claim and the terminal
unit blocks every other delivery for that long. Five minutes is longer than the two external calls are allowed to take
and shorter than a provider's usual redelivery backoff.

**Owner token.** One token per `ingest()` call: `att-<attemptSeq>-<ledgerId, sanitised, ≤24>`, sliced to
`RECORDING_CLAIM_OWNER_MAX_LENGTH` (64). The process-local counter makes it unique per attempt even if an injected
`idFactory` repeats a value; the ledger id keeps two processes apart. It carries no tenant, session or provider data.

**`insertIngest`** carries the owner: the fresh inserter writes `claimOwner = <attempt>` and
`claimExpiresAtMs = now + lease`. The unique-key insert is itself the CAS for a first delivery, so the inserter
legitimately owns the row.

**`claimPending`** — optional on the unit, one statement, returns affected rows:

```sql
UPDATE live_recording_ingests
   SET claim_owner = ?, claim_expires_at_ms = ?
 WHERE id = ? AND outcome = 'pending'
   AND (claim_owner IS NULL OR claim_expires_at_ms <= ?)
```

1 = won (this attempt owns the row), 0 = lost.

**`finalizeIngest`** — guarded, returns affected rows:

```sql
UPDATE live_recording_ingests
   SET outcome = ?, claim_owner = NULL, claim_expires_at_ms = NULL
 WHERE id = ? AND outcome = 'pending' AND claim_owner = ?
```

`outcome: 'pending'` is the **release** form (pending → pending, claim cleared); it is the only non-terminal use of
the statement and exists so a known failure does not have to wait out its own lease. Any other outcome is terminal.

**Branches, as implemented:**

| situation | behaviour |
|---|---|
| fresh insert wins | owner = this attempt; proceed to the external calls |
| `pending` + `claimPending` absent from the adapter | **fail closed**: no external call, marker stays `pending`, audit `live.recording.resume_unfenced`, `deferred / claim-unavailable` |
| `pending` + `claimPending` returns 0 | no external call, no success audit, audit `live.recording.resume_contended`, `deferred / claim-held` |
| `claimPending` returns 1 | proceed to the external calls as the owner |
| `finalizeIngest` returns 0 after external success | **no success audit**; audit `live.recording.finalize_lost` with the owner it expected, `deferred / claim-lost` — never `ingested` |
| `finalizeIngest` returns 1 | terminal audit written in the same unit, `ingested` |
| non-terminal library outcome | marker stays `pending`, audit `live.recording.deferred` with `reason` and `ledger_outcome: 'pending'`, `deferred / library-*` |

The terminal unit writes `live.recording.ingested` **only** when its own guarded transition returned 1. A losing
claimant that already created the asset says so honestly in `finalize_lost`: the sink is idempotent, the ledger
transition is not theirs.

### 10.5 Sink keys — tenant/provider/recording scoped

- **Meter `operationId`** = `${provider}:${eventId}` (hashed suffix only when the pair exceeds 200 chars). Satisfies
  `OPERATION_ID_RE = /^[A-Za-z0-9:_.-]{1,200}$/`.
- **Meter `assetId`** = `rec-<provider, non-[A-Za-z0-9_-] → '-', ≤40>-<sha256(provider NUL providerRecordingId)[0..32]>`,
  e.g. `acme` + `rec-1` → `rec-acme-50508b5e916f4239d7ce79900c6a1659`. 77 chars maximum, legal for
  `ASSET_ID_RE = /^[A-Za-z0-9_-]{1,128}$/`, no colon, deterministic from `(provider, providerRecordingId)` — that
  stability is what makes a retry a meter duplicate instead of a second charge.
- **Tenant scoping** comes from the meter itself: its idempotency key is `st:{assetId}:{operationId}` and its unique
  constraint is `(tenant_id, idempotency_key)`. The asset id supplies provider+recording, the operation id supplies
  provider+event, the tenant is the meter's first key component.
- **Library dedupe** = `(tenantId, provider, providerRecordingId)`, exposed as
  `buildRecordingAssetDedupeKey(tenantId, provider, providerRecordingId)` (NUL-separated). `createRecordingAsset`
  **must** be idempotent on exactly that tuple and answer the existing `assetId` with `created: false`. The columns,
  not the helper string, are the uniqueness constraint.
- `media-usage-reconciliation.ts` was **not** changed. The ingest satisfies its existing contract from outside.

### 10.6 Three units — what this does *not* guarantee

- The claim unit, the external meter/library calls and the terminal unit are **three separate units**. External
  effects are **not rolled back**: an asset created before a terminal-unit failure stays created, and a meter event
  already appended stays appended.
- The fence prevents two writers from **both declaring** a terminal transition. It does not undo either writer's
  irreversible effect. Sink idempotency is what prevents a duplicate irreversible effect, and that is a requirement on
  the ports, not something this module can enforce.
- An **unknown** external outcome — a throw, or a lost response — does not authorise a duplicate irreversible effect.
  The row stays `pending` with its lease, the lease expires, and only then may another attempt claim it. That retry is
  safe only because both sinks are key-idempotent.
- No MySQL behaviour is claimed. The in-memory adapter is a **seam model**: no isolation level, no deadlock, no
  `ER_DUP_ENTRY`, no crash. Its `claimPending` mirrors the durable predicate *including* the SQL NULL case (an owner
  with no expiry is not claimable).

### 10.7 Per-item status

| item | status |
|---|---|
| D1 — unconfigured/deferred library no longer settles the marker | **implemented**, tested hermetically (updated expectation), **live-unproven** |
| D2 — explicit lease owner on insert and on resume | **implemented**, win path tested hermetically, **live-unproven** |
| D2 — contended / unfenced refusal | **implemented**, **untested by execution** (no new test cases permitted) |
| D3 — guarded `finalizeIngest`, affected rows consumed | **implemented**, 1-row path tested, **0-row path untested by execution** |
| D4 — provider-scoped meter `operationId`/`assetId` | **implemented**, asserted in one test; asset-id **stability across attempts untested by execution** (pure function, no clock/randomness) |
| D4 — library dedupe key + helper | **implemented**, adapter already idempotent, **live-unproven** |
| D5 — terminal-success action only for an own guarded transition | **implemented**, tested hermetically |
| Durable adapter / SQL | **policy-held** — requests R12–R14; no SQL written, nothing run against MySQL |
| Reconciliation sweep (R9) | **policy-held**, unchanged |
| Router mount / production store | unchanged: **not wired**, `server/src/index.ts` untouched |

### 10.8 Files, before → after

| file | before bytes | before sha256 | after bytes | after sha256 |
|---|---|---|---|---|
| `server/src/services/live-recording-ingest.ts` | 33,831 | `55cac360f96210ca7da6126efe70e0fcea0033bff6ca9c3f5675b76958b7d421` | 49,310 | `d4f5343744aacac43b26dbdf9711b0b76cd27a088fb00add751497193a5e8695` |
| `server/tests/live-recording-ingest.test.ts` | 16,991 | `ee1628d8c0a11020f75a1a4788236c5988807c9378dc0dfa9fc362e014c47214` | 17,623 | `58df16c92c4a1cc6bcaca8e04848e404f2465c07fe49343d71d1c84134f34f1b` |

Both files were untracked, so `git diff` proves nothing; the hashes are the evidence.

### 10.9 Commands actually run

```
# from the repo root
node node_modules/typescript/bin/tsc --noEmit -p server/tsconfig.json
# exit 0

# from server/
M1_NETWORK_MODE=hermetic node --require ../scripts/m1-network-guard.cjs --import tsx --test tests/live-recording-ingest.test.ts
# tests 12 / pass 12 / fail 0 / skipped 0   (exit 0)

M1_NETWORK_MODE=hermetic node --require ../scripts/m1-network-guard.cjs --import tsx --test tests/live-session-core.test.ts
# tests 17 / pass 17 / fail 0 / skipped 0   (exit 0)
```

`tsc` compiles `src` only; the tests run through `tsx`, so the test run — not `tsc` — is what proves the suite.

### 10.10 Test expectations changed (old → new → why)

No test was added, deleted, renamed or skipped. Three tests had assertions that encoded a defect this correction was
ordered to fix; only those assertions moved.

| test | old assertion | new assertion | why the old one was wrong |
|---|---|---|---|
| *a verified recording is ingested unpublished with a deny policy and metered once* | `assetId: 'rec-1'`, `operationId: 'evt-rec-1'` | `assetId: 'rec-acme-50508b5e916f4239d7ce79900c6a1659'`, `operationId: 'acme:evt-rec-1'` | D4. The raw ids are not provider-scoped: two providers both using `rec-1`/`evt-rec-1` shared one meter asset, and a `:`-containing recording id was refused by `ASSET_ID_RE`. |
| *an unconfigured meter or library is reported, never faked* | `status:'ingested'`, `library:'unconfigured'`, `assetId:null`, `visibility:'unpublished'` | `{status:'deferred', reason:'library-unconfigured'}`, marker `pending`, `live.recording.deferred` audited | D1. Settling an absent required sink as `ingested` was a terminal fake success: the marker could never be repaired after the library was configured. |
| *a failed library leaves a repairable pending marker that a replay finishes* | first result `status:'ingested'` / `library:'deferred'`; audit action `live.recording.ingested` with `ledger_outcome:'pending'`; replay `operationId` `'evt-rec-1'` twice | first result `{status:'deferred', reason:'library-error'}`; audit action `live.recording.deferred` with `ledger_outcome:'pending'` and no terminal action anywhere; replay `operationId` `'acme:evt-rec-1'` twice | D5 (a terminal-success action for a `pending` marker), D1 (a non-terminal outcome reported as a success) and D4 (the unqualified operation id). The repairability property the test proves — `pending` after the failure, one asset and a settled marker after the replay — is unchanged. |

The other nine tests are byte-identical, including both dedupe-key tests, the trusted-tenant audit-partition test, the
mandatory-unit refusal and the metering-does-not-block-the-library invariant.

### 10.11 Residual limits

- **Untested by execution** (no new cases were permitted): `claim-held`, `claim-unavailable`, `claim-lost`, the
  `finalizeIngest → 0` audit, and asset-id stability across attempts. Each is implemented and readable in the source;
  none is proven by a run.
- **No durable adapter.** Both predicates are requests (R12–R14). Nothing here is MySQL behaviour.
- **The lease has no heartbeat.** An attempt whose external calls legitimately exceed 5 minutes can lose its lease;
  a second delivery may then run concurrently. Both sinks are idempotent and only one `finalizeIngest` can return 1,
  so the outcome stays single-declared — but two external writes can overlap.
- **Release uses `finalizeIngest(outcome:'pending')`.** An adapter that constrains `outcome` to a terminal enum will
  throw instead; the row then stays `pending` until its lease expires. Safe, slower.
- **A concurrent first insert loses as `duplicate`** even though the winner may later fail. Repair then waits for the
  winner's lease to expire and for a redelivery; there is still no sweep (R9).
- **Meter ownership gap (not fixed, reported):** `recordVerifiedBytes` resolves `findAssetTenant(assetId)` and returns
  `unknown_asset` when the id is not a registered asset. The ingest asset id is a synthetic provider-scoped key, so in
  a live composition metering will stay `deferred` until an asset row exists for that id. Metering is a reported gap
  and never blocks the library, but this is a wiring gap the ingest cannot close alone.
- **Seam model only:** no isolation level, deadlock, `ER_DUP_ENTRY` or crash is modelled by the in-memory adapter.

### 10.12 Schema / wiring requests (for the schema owner — not implemented here)

- **R12 — columns.** `live_recording_ingests` gains `claim_owner VARCHAR(64) NULL` and
  `claim_expires_at_ms BIGINT NULL` (epoch ms; the epoch-ms vs `DATETIME(3)` question is R11). Both must be written
  together: the durable predicate treats `claim_owner IS NOT NULL AND claim_expires_at_ms IS NULL` as **unclaimable**
  (SQL NULL comparison), so an owner without an expiry would strand the row.
- **R13 — CAS predicates.** `claimPending` and `finalizeIngest` must each be a **single statement** returning the
  affected-row count, exactly as in §10.4. `finalizeIngest` must accept `outcome='pending'` as the release form and
  clear both claim columns in the same statement.
- **R14 — sweep index.** The R9 pending sweep needs `KEY (outcome, claim_expires_at_ms)` so it can find
  `outcome='pending' AND (claim_owner IS NULL OR claim_expires_at_ms <= now)` without a table scan.
- **R15 — sink keys.** Meter `assetId` derivation and `operationId` shape as in §10.5; library uniqueness on
  `(tenant_id, provider, provider_recording_id)`.
- **Explicitly: no migration was written, no SQL was executed, and nothing was verified against MySQL.**

### 10.13 Supervisor verification — independent re-run and reading (2026-10-22)

Added by the lane supervisor, **not** by the worker. §10.1–§10.12 are the worker's delivery; this is what I
re-measured myself after it stopped, from the baseline in
`handoff/WORKBUDDY-RECORDING-RESUME-BASELINE-20261022.{md,txt}` (51 hashes captured before the first edit).

**Measured, not taken on report.**

| check | result |
|---|---|
| `tsc --noEmit -p server/tsconfig.json` (repo root) | exit **0** |
| `tests/live-recording-ingest.test.ts` | **12 / 12** pass, 0 fail, 0 skipped |
| `tests/live-session-core.test.ts` | **17 / 17** pass, 0 fail, 0 skipped (unchanged protection set) |
| allowedPaths re-hashed | **48 identical / 3 moved** — `live-recording-ingest.ts` (33,831 → 49,310), `live-recording-ingest.test.ts` (16,991 → 17,623), this document (55,607 → …) |
| writes outside the 51 paths | **none** — `git status` still 37 entries, no new repo file, and the only mtimes after the baseline are those three files (18:35:12 / 18:35:53 / 18:37:20) |
| claim state | `reported`, claim released, `queue_status.active = []` |

**Read line by line, not skimmed.** D1: `const terminal = library === 'created' || library === 'existing'` (`:813`),
with `unconfigured` and `deferred` both falling into the release branch. D2: `claimPending` is called before any
external call and both refusal branches (`:702-720`) return before the meter or the library is touched. D3: the
success audit at `:878-896` is inside `if (affected !== 1) { … }`'s else path, so a 0-row transition can only produce
`finalize_lost`. D4: both sink keys are pure functions of provider+id and both satisfy the meter's regexes
(`ASSET_ID_RE` has no colon, `OPERATION_ID_RE` does). D5: `live.recording.ingested` appears exactly once in the file.

**Two properties I checked that the delivery does not state.**

1. A `claim-lost` writer does not orphan its asset id. The loser may have created the asset; the winner's
   `createRecordingAsset` then answers `created: false` with the existing id, so the winner's `ingested` result still
   carries an id. The ledger transition and the reported id stay with the same attempt.
2. The release form is safe under MySQL's default `affectedRows` semantics. `finalizeIngest(outcome:'pending')` sets
   `outcome` to the value it already holds, so the affected-row count is only non-zero because the same statement
   clears `claim_owner`/`claim_expires_at_ms`. An adapter that implements the release as `SET outcome = ?` alone would
   read its own success as `0` and downgrade a known non-terminal result to `claim-lost`. R13 must say this
   explicitly: the release statement must clear both claim columns.

**Residuals I confirm and want on the record.**

- **Concurrent first insert.** Two overlapping deliveries both miss `findIngest`; the loser's `insertIngest` returns
  `inserted: false` and it answers `duplicate`, while the winner may still fail and leave the row `pending`. The
  provider treats `duplicate` as "stop", so repair then needs a later redelivery or the R9 sweep. This race is
  **pre-existing** (it is the unique-key behaviour, unchanged by this task), but the new `pending` state makes it more
  visible: `duplicate` no longer implies "the work is done".
- **Meter ownership.** `recordVerifiedBytes` resolves `findAssetTenant(assetId)` (`media-usage-reconciliation.ts:443`)
  and returns `unknown asset` for an unregistered id, so the synthetic ingest asset id meters as `deferred` until an
  asset row exists. Pre-existing and unchanged in kind (the raw provider recording id was never a registered asset
  either), reported by the worker, not fixed here.
- **Reference adapter id shape.** `createInMemoryRecordingLibrary` answers `asset-<n>` for `created: true` but
  `provider:recording` for `created: false`. Harmless for the tests, misleading for anyone writing the durable adapter
  from it. Not changed; noted.

**What is still unproven by execution.** `claim-held`, `claim-unavailable`, `claim-lost`, the `finalizeIngest → 0`
audit, and asset-id stability across attempts have **no run behind them**: the task forbade new tests, and I did not
add any. They are implemented and readable; a verification task is required to close them, and I am not claiming them
green.
