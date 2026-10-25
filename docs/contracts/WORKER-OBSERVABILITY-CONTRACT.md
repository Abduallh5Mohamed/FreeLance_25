# Worker observability contract — 2026-10-24 (R16)

Status: implemented source contract. Owner files:
`server/src/services/worker-observability.ts` (this contract's subject),
`server/src/services/metrics.ts` (registry the observer attaches to).
Hooks in the worker files, the shared-registry change in `server/src/index.ts`
and startup/shutdown wiring are NOT part of this batch; the integration request
is specified in §7–§9 and must be executed by the owning writer after contract
freeze. No migration, DDL, provider, secret or runtime startup belongs to it.

## 1. Scope and non-goals

The observer is a pure, dependency-injected adapter over the ONE production
`MetricsRegistry`. It records what happens in worker runs; it never starts,
schedules or executes work:

- importing `worker-observability.ts` performs no I/O, starts no timer and
  registers nothing; every side effect happens inside
  `createWorkerObservability(registry, options)`;
- it creates no registry: the registry must be injected. Two separate
  registries produce two invisible metric families; that is a wiring fault,
  and §8 tells the integration owner how to avoid it;
- it does not probe the database, does not own scheduling, and is not mounted
  anywhere in this batch. `server/src/index.ts` is untouched here;
- it never persists jobs and never reconciles them.

## 2. Fixed enums (the only label values that can ever exist)

| constant | values |
|---|---|
| `WORKER_KINDS` | `notification`, `assignment_scan`, `tenant_export`, `media_reconciliation` |
| `WORKER_OUTCOMES` | `succeeded`, `failed`, `unknown`, `skipped` |
| `WORKER_TELEMETRY_INCIDENT_REASONS` | `invalid_worker_kind`, `invalid_outcome`, `invalid_duration`, `duplicate_end`, `observer_error` |

Nothing that is tenant/user/contact/object-key/job data can become a label:
labels are only `kind`, `outcome`, `reason`. A value outside the fixed enums is
rejected, counted in `worker_telemetry_incidents_total` and never becomes a
series. This makes the total series bound:

| metric | max series |
|---|---|
| `worker_runs_total` | 16 (4 kinds × 4 outcomes) |
| `worker_run_duration_seconds` | 4 (+buckets per kind) |
| `worker_passes_inflight`, `worker_running`, `worker_last_success_timestamp_seconds` | 4 each |
| `worker_telemetry_incidents_total` | 5 |
| `worker_backlog` | ≤ 4 (one per kind with a usable sampler) |

## 3. Metrics (names and semantics)

| name | type | labels | semantics |
|---|---|---|---|
| `worker_runs_total` | counter | `kind,outcome` | completed runs; only valid declared outcomes are recorded |
| `worker_run_duration_seconds` | histogram | `kind` | duration of completed runs; default buckets `0.05…3600` (seconds), replaceable via `runDurationBuckets` |
| `worker_passes_inflight` | gauge | `kind` | ops started but not yet ended; ≥ 0 |
| `worker_running` | gauge | `kind` | lifecycle running flag (1/0), set explicitly by `setWorkerRunning`; a kind whose lifecycle was never reported renders NO series (unknown, not 0) |
| `worker_last_success_timestamp_seconds` | gauge | `kind` | epoch seconds of the last run that ended `succeeded`; unset until the first success (unknown, not 0) |
| `worker_telemetry_incidents_total` | counter | `reason` | rejected/duplicated observations and observer errors |
| `worker_backlog` | gauge source | `kind` | runnable backlog depth per kind, sampled ONLY at scrape time if the domain owner supplied a sampler; without one, no series exists |

Absence semantics: an absent series means "unknown", never "zero". Nothing in
this module fabricates a value.

## 4. Public signatures (verbatim from source)

```ts
export function createWorkerObservability(
    registry: MetricsRegistry,
    options: WorkerObservabilityOptions = {},
): WorkerObservability;

export interface WorkerObservabilityOptions {
    now?: () => number;                            // default Date.now
    runDurationBuckets?: readonly number[];        // default DEFAULT_WORKER_RUN_BUCKETS
    backlogSamplers?: Partial<Record<WorkerKind, WorkerBacklogSampler>>;
}

export interface WorkerObservability {
    startWorkerRun(kind: WorkerKind): WorkerRunHandle;
    runWorkerOperation<T>(
        kind: WorkerKind,
        operation: () => T | Promise<T>,
        classify?: (result: T) => WorkerOutcome,
    ): Promise<T>;
    setWorkerRunning(kind: WorkerKind, running: boolean): void;
}

export interface WorkerRunHandle {
    end(outcome: WorkerOutcome, observation?: WorkerRunObservation): void;
}

export interface WorkerRunObservation { durationMs?: number }
export interface WorkerBacklogSampler { (): number | null }
```

`createWorkerObservability` is the only entry point. Calling it twice over the
same registry re-uses the first definitions (registry `define` is idempotent);
the recommended deployment is one adapter per registry.

## 5. Error semantics

- The observer can never change a domain outcome: every public method swallows
  its own failures into `worker_telemetry_incidents_total{reason="observer_error"}`,
  and `runWorkerOperation` rethrows the original domain error unchanged.
- `runWorkerOperation`: success records the classified outcome (default
  `succeeded`); a rejection records `failed` first and then rethrows. In-flight
  is decremented exactly once on every path because the decrement sits inside
  `recordEnd` and `end` is once-per-handle. A throwing `classify` is an
  `invalid_outcome` incident: duration and in-flight are still honest, but no
  run-outcome counter is incremented (never guessed as `unknown` or `succeeded`).
- `end` rules: exactly one call per handle records telemetry; a second call
  counts `duplicate_end` and changes nothing. An explicitly supplied
  `durationMs` that is non-numeric/negative counts `invalid_duration` and the
  measured duration is used instead. An end that is never called leaves the
  in-flight gauge elevated — hooks MUST call `end` exactly once on every code
  path (§7 shows the mandatory shape).
- An invalid `kind` at start counts `invalid_worker_kind` and returns an inert
  handle whose every `end` also counts a `invalid_worker_kind` incident.
- `setWorkerRunning` with an invalid kind is an `invalid_worker_kind` incident;
  otherwise it sets the 1/0 gauge.
- Backlog sampling: a sampler that throws, returns `null`/undefined or a
  non-finite/negative value emits no series for that kind — unknown, never
  zero. One failing sampler does not hide other kinds. There is no scheduling,
  no caching and no DB access here: the sampler body is the domain owner's
  responsibility, and this contract forbids it from running a per-tenant query
  per scrape (OPS3's bounded canonical SQL requirement stands).

## 6. Limits

- Series bounds above; no label can be caller-controlled input.
- Durations are milliseconds; the histogram receives seconds. A negative
  explicit duration is an incident (not clamped silently).
- `worker_backlog` exists only when at least one sampler was configured at
  construction; it is registered as a gauge source on the SAME registry.
- No timer, interval, listener or socket is created by or for the observer;
  shutdown has nothing to drain.

## 7. Hook request — WorkBuddy-owner worker files (after freeze)

Only the owning writer of each file adds these hooks; this batch did not edit:

1. `server/src/services/notification-worker.ts` — construct nothing per run:
   the integration owner passes one `WorkerObservability` created over the
   production registry (§8). Inside `runOnce()`:
   ```ts
   const handle = observability.startWorkerRun('notification');
   try {
       // existing pass body
       handle.end(passReport.passThrew ? 'failed' : classifyPass(passReport));
   } catch (error) {
       handle.end('failed');
       throw error;
   }
   ```
   Suggested pass classification: all rows reached a terminal sent/bounced or
   clean retry state ⇒ `succeeded`; any quarantined `unknown` outcome in the
   pass ⇒ `unknown`; pass-level throw ⇒ `failed`; overlap-guard abstention ⇒
   `skipped`. The precise mapping is the worker owner's decision and belongs
   in their report. `start()`/`stop()` (or the I1 wiring) should bracket with
   `setWorkerRunning('notification', true/false)`.
2. `server/src/services/assignment-scan-worker.ts` — same manual-handle shape
   around `runOnce()` with `kind: 'assignment_scan'`; prefer
   `runWorkerOperation('assignment_scan', () => runOnce(...))` when the run
   report is not needed beyond metrics.
3. `server/src/services/tenant-export.ts` — one run per export job execution
  (not per table): `runWorkerOperation('tenant_export', () => execute..., classifyFromJobState)`;
   `completion_unknown` failures classify as outcome `unknown`, aborts as
   `skipped`, other `ExportFailureCode`s as `failed`.
4. `media_reconciliation` — when a reconciliation runner exists (R08 pending),
   wrap the reconciling call of `reconcileStorageUsage` the same way. Until a
   runner exists, this kind stays at zero series: correctly absent.

Rules for hook owners: never pass tenant/user/contact/object-key/job IDs to the
observer; do not call `runWorkerOperation` inside a timer class they should not
change (it follows the caller's own clock only); a hook strictly follows the
"end exactly once" shape above; the observer's returned promise must not be
dropped (`void`-swallowed) without its catch preserving domain error logging.

## 8. Registry sharing request — integration owner (`server/src/index.ts`)

`index.ts:164-169` currently builds `createMetricsRegistry()` inline. After
contract freeze the integration owner makes ONE registry process-wide:

```ts
const metrics = createMetricsRegistry();
const workerObservability = createWorkerObservability(metrics);
mountObservability(app, { logger, metrics, metricsToken, readiness: [...] });
// pass workerObservability to the notification worker / scan runner wiring
```

The change is single-file, worker-free and is NOT part of this batch. The
default ops router segment in `ops.ts` (`defaultMetrics`) is a fallback for a
host that never calls `mountObservability`; it must not gain a second
production observer.

## 9. Startup/shutdown request — integration owner

- Construct the observer during startup wiring, after config validation,
  together with the workers it will serve; never at module import.
- Bracket every worker lifecycle with `setWorkerRunning(kind, true)` after
  `start()` and `(kind, false)` after `stop()` succeeds or reports
  `drained: false` (still false: the process is not quiescent either way).
- No drain is owed by the observer itself: it owns no handle. Graceful
  shutdown stays bounded by the workers' existing drain contracts.
- No new runtime environment flag activates this; the observer is wired by
  code, not configuration, and there is no runtime config change in this batch.

## 10. Held (not implemented and not claimed here)

- Deployment of Prometheus/Grafana, scrape auth provisioning, alert rules and
  SLO thresholds (OPS3 files) — thresholds need operator decision, not invented
  defaults here.
- Real backlog SQL per kind (R08/R11/R12 domain owners). The sampler seam is
  provided; no sampler is configured by this batch, so `worker_backlog` never
  renders until a domain owner proves a bounded canonical query.
- Runtime verification against real traffic/workers. Bounded-series and
  failure-injection checks listed in the round handoff remain untested.

## 11. Registry integrity amendments — `metrics.ts` (2026-10-24, round4)

Source-level correction package; no public-interface change. The observer
(`server/src/services/worker-observability.ts`) is untouched — its fixed-enum
labels contain no control characters, so the key-encoding fix below cannot
change its series.

1. Cross-family rendered-name collisions in `define()`. Previously `define`
   checked collisions only against registered gauge sources, so
   `counter foo_count` plus `histogram foo` (either declaration order) rendered
   the name `foo_count` inside two `# TYPE` families — invalid exposition.
   `define` now rejects any rendered-name intersection with EVERY existing
   descriptor (histograms contribute `name`, `name_bucket`, `name_sum`,
   `name_count`; counters and gauges contribute their bare `name`). Re-defining
   the SAME name with the SAME type/label set stays idempotent and is never
   treated as a collision. Existing wiring (`http_requests_total`,
   `http_request_duration_seconds` and derived names, the `worker_*` family,
   `worker_backlog`) was read-checked: no rendered-name intersection exists,
   so no current call site newly throws.
2. Reserved histogram label `le` is rejected at definition time. Rendering
   overwrote a user-provided `le` with the bucket cut, collapsing distinct
   series into one sample identity. This was proven by inspection before the
   change (it produces duplicate sample identities) and is therefore enforced,
   counter to the default of only changing proven defects.
3. Duplicate histogram bounds are collapsed in `normalizedBuckets` (sorted,
   equal neighbours deduped). Duplicates were proven to render two identical
   cumulative `le=` samples per series (the second equal-bound counter is
   never incremented by `findIndex`). No other bounds vector exists: `String`
   is injective on distinct finite positive numbers (`-0` is filtered by
   `> 0`), so only numeric duplicates can collide on `le`.
4. Series-key encoding: `labelKey` now JSON-encodes the ordered
   (labelName, value) tuple instead of concatenating with control delimiters.
   Proof: with labelNames `[a, b]`, labels `{a:"p\u0001b\u001fq", b:"r"}`
   and labels `{a:"p", b:"q\u0001b\u001fr"}` both produced the identical
   delimiter-concatenated key, so the second tuple's observations merged into
   the first tuple's series. JSON escaping removes the ambiguity; the key is
   in-memory only and the sorted rendered output is unchanged.

Verification status: both declaration orders of every collision case and the
tuple-identity proof were established by read-review only. No tests were run
in this batch and none are claimed.
