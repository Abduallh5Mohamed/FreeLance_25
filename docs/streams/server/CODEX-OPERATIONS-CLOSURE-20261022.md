# Codex operations closure review — 2026-10-22

## Scope and evidence

Read-only source review using enterprise-system-design skill; this report is the only written file. No tests added or run, no database, service, listener, network, provider, secret access or Git operation. Source references below describe code, not live operational proof. Previous 2873-test baseline belongs to the parent's earlier verification and was not repeated here.

Other lanes retain ownership: Claude finance/enrollment/parent/schema/index; WorkBuddy academic/media/notifications. DST and MFA are separate Codex assignments. This report does not authorize edits to those owners' files.

## Current source state

| Capability | Existing evidence | Remaining limit |
|---|---|---|
| HTTP metrics | `server/src/services/metrics.ts:296` names request counter/duration; `server/src/routes/ops.ts:132` middleware records finish events using route templates, method whitelist, status class | No capacity/SLO evidence from real traffic |
| Metrics protection | `server/src/routes/ops.ts:55,264` minimum32-byte dedicated token, constant-time comparison, denied responses no-store | Token provisioning/rotation, scrape network boundary and actual monitoring service are operational work, not implemented by this review |
| Response-bounded probes | `server/src/routes/ops.ts:222–242` bounded Promise.race and cleared timer; `/healthz` independent of dependencies; `/readyz` budget and empty-list rejection at278–296 | Timeout ends the response wait, not the underlying operation; `SELECT1` can remain outstanding after timeout. No cancellation/single-flight admission guarantee is established by these functions |
| Default readiness | `server/src/routes/ops.ts:310–335`; `server/src/index.ts:159–164` only database check wired | Does not establish notification worker/scanner/storage/provider or reporting functionality ready; school-reporting column readiness is a separate request gate |
| Generic registry | `server/src/services/metrics.ts:58–66,224` supports gauge sources | Search of `server/src` found no call to registerGaugeSource beyond the declaration/implementation; no queue/job/pool gauge source is currently registered |
| Notification lifecycle | `server/src/services/notification-worker.ts:122–168` deps, outcome counters per run, start/stop/status | These are result objects, not Prometheus instrumentation. Worker startup/integration is still the owning lane's responsibility |
| Scan lifecycle | `server/src/services/assignment-scan-worker.ts:125–205` bounded candidates/verdict/outcomes | No metrics registry hook found; durable attempts/lease/cleanup remain WorkBuddy/schema work |
| Usage reconciliation | `server/src/services/media-usage-reconciliation.ts:683` read-only reconcile function | No SQL-backed scheduled caller proven here; don't register a fake queue gauge from an in-memory store and call it production metering |
| Bootstrap artifact | `scripts/build-m1-bootstrap.mjs:25–70` refuses existing destination, checks reviewed source hashes and stages ordered SQL | A deterministic bootstrap bundle is not an encrypted backup or a successful restore of current application data and object bytes |
| Backup/restore | Original inventory explicitly holds I4-R3; `CURRENT-SERVER-PROGRESS-20261019.md:130` records missing Q5 evidence | No current DB+object snapshot restore proof, RTO/RPO measurement, restore credential/key ownership or rehearsal evidence established in this review |
| Alerts/load | Ops/metrics source has no alert evaluator/configuration or production workload evidence identified by targeted search | Do not treat metric definitions as alerts or green unit tests as p95/error/queue-lag capacity evidence |

## Proposed tasks and exact next files

These are allocations for the parent to approve; no implementation was made here. Keep each task independent from ongoing worker writers.

### OPS1 — bounded worker telemetry contract (pure, no startup)

New owned files: `server/src/services/worker-observability.ts`, `docs/contracts/WORKER-OBSERVABILITY-CONTRACT.md`, `docs/streams/server/CODEX-WORKER-OBSERVABILITY-20261022.md`.

Implement a dependency-injected observer over the existing MetricsRegistry. Fixed worker kinds (`notification`, `assignment_scan`, `tenant_export`, `media_reconciliation`) and fixed outcome enums; never accept tenant/user/contact/object-key/job IDs as labels. Counters for completed runs/outcomes, histogram for run duration, gauges for current in-flight/running/last successful run. Unknown measurement must remain unknown/unavailable rather than reporting an invented zero backlog. Do not persist or execute jobs here.

Hooks request to WorkBuddy: explicit call sites in `notification-worker.ts`, `assignment-scan-worker.ts`, `tenant-export.ts`, and eventual reconciliation runner, added only by their assigned writer after contract freeze. Integration request to Claude: share the existing production metrics registry with the observer. Current inline `createMetricsRegistry()` in index must not lead to a second invisible registry. index change is not assigned to OPS1.

Future verification when parent requests tests: bounded series across random IDs, unknown kinds rejected/normalized explicitly, no observer failure may break the domain operation, running gauge decremented on thrown failures, no timer or import startup. This review did not add/run those tests.

### OPS2 — bounded underlying readiness work

Owned existing file after allocation: `server/src/routes/ops.ts`; optional new `server/src/services/readiness-coordinator.ts`; report `docs/streams/server/CODEX-READINESS-COORDINATION-20261022.md`.

Preserve current response deadlines, generic responses, no-store, liveness separation and empty-check rule. Add per-check single-flight/admission so repeated probes cannot create an unbounded number of unresolved checks. Document limitation: a permanently hung driver call still needs driver-enforced timeout/cancellation or connection disposal. Do not equate Promise.race with operation cancellation. If safe driver cancellation requires db/config edits, raise a separate dependency; do not touch shared db.ts implicitly. Choose replacement policy carefully: restarting a check on every TTL while the old check hangs recreates the leak.

Future verification: never-settling check with repeated probes starts bounded work; late rejection is handled; healthy checks recover; no dependency names/errors leak; shutdown does not claim to cancel unsupported driver operations.

### OPS3 — alert/SLO specification before deployment

New docs only: `docs/streams/server/OPERATIONS-SLO-ALERTS-20261022.md`, `docs/streams/server/OPERATIONS-INCIDENT-RUNBOOK-20261022.md`.

Define measurable request errors/latency, worker progress age, oldest runnable backlog age, provider-unavailable and unknown-outcome rates, scan exhaustion, pending cleanup bytes/count and reconciliation discrepancy. Thresholds require expected traffic/queue cadence and operator decision; do not invent a guaranteed SLO. Each alert needs metric provenance, observation window, missing-data behavior, routing owner and immediate safe action. Provider unknown outcome must trigger reconciliation, not blind resend. Backlog metrics require scoped, bounded canonical SQL maintained by the domain owner; never query per tenant during each scrape or expose PII labels.

No Prometheus/Grafana deployment/config or `.github/**` ownership is granted here. Those shared operations files need a separately allocated task after tooling choice.

### OPS4 — backup/restore design and isolated rehearsal gate

New docs only now: `docs/streams/server/BACKUP-RESTORE-CONTRACT-20261022.md`, `docs/streams/server/RESTORE-REHEARSAL-PLAN-20261022.md`.

Inventory canonical MySQL tables plus private object bytes/version IDs and migration/price/audit versions. Specify consistent cut or recorded replay boundary across DB and objects, encryption/key retrieval separation, retention and least privilege, manifest hashes, evidence redaction and independent restoration destination. Record ordering of replay, object reference reconciliation, sealed audit-chain verification and financial balance reconstruction. Destructive cleanup cannot be part of a rehearsal by default. Define proposed RPO/RTO targets as pending owner agreement, not measured facts.

Actual `mysqldump`/snapshot/object-copy/decrypt/restore operations require explicit destination, access, key and live-operation authorization. A future script might be `scripts/verify-restore-manifest.mjs` for offline manifest validation, but scripts ownership belongs to the parent and is not granted by this report. Existing `server/freelance_backup.sql` is not inspected or treated as authorized production evidence.

### OPS5 — reproducible load/soak plan

New doc: `docs/streams/server/CAPACITY-LOAD-PLAN-20261022.md`. Do not add/start a generator or listener under this task.

Define synthetic scenario mix and tenant counts, hot/cold search/export behavior, video authorization (not fake bandwidth claims), school reporting aggregates, notification/scan lag and pool contention. Separate pure hermetic budget tests from service load tests. Capture process/driver/provider configuration, dataset digest, warm-up, duration, offered versus achieved rate, p50/p95/p99, error taxonomy, memory/event-loop/pool/queue measurements, stop thresholds and concurrency saturation. Inject slow DB/provider, delivery unknown outcomes and restarts only under authorized isolated environment. Unit-test throughput is not production capacity.

## Recommended order

1. OPS1 observer contract and pure implementation; owners wire hooks only after contract freeze.
2. OPS2 readiness admission bound on isolated ops files.
3. OPS3 alert definitions and OPS4/5 plans in parallel as docs-only tasks.
4. Claude integration shares registry and startup/shutdown contracts after stop handoffs.
5. Separately authorized restore/load/live runs produce actual evidence; rerun full hermetic suite only after all writing lanes stop and user requests verification.

## Stop state

Review complete. Only this report was written. No implementation/test/live verification or operational milestone is claimed. Writing stopped.

## OPS2 implementation follow-up — parent-authorized

The parent subsequently authorized OPS2 implementation in `server/src/routes/ops.ts` only (and optionally a new coordinator file). The correction is implemented inline; no new source file is needed.

- `createSingleFlightProbe` allocates one slot per configured liveness/readiness function when the router is constructed. The readiness list is snapshotted; no per-request keys or growing metadata map exists.
- The first caller starts one underlying operation and a bounded result. Concurrent callers share that result while retaining their own remaining sweep deadline.
- Crucially, timeout completion does **not** release the operation slot. If the driver promise never settles, subsequent probes reuse the settled failed result and do not start another query or add another callback to the never-settling driver promise. There is only one underlying completion/rejection observer for that flight.
- When the underlying operation actually resolves or rejects, its slot is released. The next request may attempt a new check; there is no retry timer. A late rejection is consumed by the existing bounded observer.
- Per-request deadline timers are cleared through the existing `runBounded` finally path. A timed-out underlying operation retains bounded constant metadata but no recurring timer. Ordinary concurrent HTTP requests still consume normal request resources; this does not claim to implement server-wide request admission or pool limits.
- Endpoint paths, bodies, status codes, token checks, no-store, liveness/readiness separation and empty-readiness policy are unchanged. Duplicate configured check entries still have separate fixed slots, so the bound is one operation per configuration entry, not a global cross-router/cross-process singleton.

Honest recovery limit: an operation that truly never settles makes its probe remain unavailable until it settles or its host is restarted. This change does not pretend to cancel SQL, dispose a driver connection, or recover an uncooperative provider. Driver-level timeout/cancellation remains a separate dependency requiring db/config ownership. Other checks still run within the sweep budget.

No tests were added or run and no typecheck was run, per the parent's explicit restriction. Source was inspected against existing ops endpoint contracts; regression execution remains the parent's next verification step when authorized. No source outside ops.ts and this report was changed. Writing stopped after this correction.
