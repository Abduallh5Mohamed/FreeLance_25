# Codex-worker-observability R16 implementation — 2026-10-24 (round2, GLM lane)

Supervisor: Codex. Scope: R16 operations source closure, exact writable paths
only (`server/src/routes/ops.ts` read/reviewed, `server/src/services/metrics.ts`,
`server/src/services/worker-observability.ts`, this contract and this report).
No commands, no tests, no compiler/typecheck, no SQL/services/providers/network,
no git, no peer-path edits. One writer per file; previous OpenCode processes
verified absent by the supervisor before this round.

## What was implemented

### 1. `server/src/services/worker-observability.ts` (new)

Worker-observability adapter over the EXISTING `MetricsRegistry`:

- Fixed kinds `notification | assignment_scan | tenant_export | media_reconciliation`;
  fixed outcomes `succeeded | failed | unknown | skipped`; fixed incident
  reasons `invalid_worker_kind | invalid_outcome | invalid_duration |
  duplicate_end | observer_error`. Tenant/user/contact/object-key/job IDs are
  structurally impossible as labels.
- Bounded telemetry: `worker_runs_total` (≤16 series), a
  `worker_run_duration_seconds` histogram (per kind), gauges
  `worker_passes_inflight`, `worker_running` (1/0 lifecycle flag, unset =
  unknown), `worker_last_success_timestamp_seconds` (unset until first real
  success — no fabricated zero), `worker_telemetry_incidents_total`
  (5 reasons), optional scrape-time gauge source `worker_backlog` (only when a
  domain owner supplies samplers; absent/thrown/unusable sampler ⇒ no series,
  never zero).
- Injection only: `createWorkerObservability(registry, options)` throws if no
  usable registry is supplied and never constructs one itself.
- Domain safety: every public call fails into the incident counter instead of
  breaking a run; `runWorkerOperation` rethrows the original domain error
  unchanged; in-flight is decremented exactly once per handle (before any
  other recording), including on thrown/rejected operations; duplicate `end`
  and repeated hooks count `duplicate_end` and change nothing.
- No timer, no scheduler, no import-time effect, no runtime config change.

### 2. `server/src/services/metrics.ts` (edited, API preserved)

Genuine defects fixed at the actual implementation:

- Metric-name collisions across gauge sources and definitions. Before:
  `registerGaugeSource` only deduped exact same-name sources and `define`
  never consulted registered sources, so a gauge source named e.g.
  `http_requests_total` (or a histogram's `*_bucket`/`*_sum`/`*_count` shadow
  names) produced duplicate `# HELP`/`# TYPE` families or contradictory series
  names in `render()` — an exposition-format fault surfacing at scrape time.
  After: `renderedSeriesNames` computes each definition's rendered series set
  (histograms emit their three derived names); both `define` (against
  registered sources) and `registerGaugeSource` (against defined metrics)
  reject any intersection. A re-registration with an identical
  help/labelNames stays idempotent; a conflicting one now throws instead of
  being silently ignored.
- Gauge-source sample hardening in `render()`. Before: only the `collect()`
  call itself was try/caught; a returning source whose samples contained a
  non-string label value (`escapeLabelValue` calling `.replace` on a number),
  an invalid label name, a label set disagreeing with the declared
  `labelNames`, or a non-array return threw inside the render loop and
  disabled the whole `/metrics` response, and an unbounded sample list had no
  bound. After: samples are validated (array return, finite numeric value,
  string values, `LABEL_NAME_PATTERN`-valid names, exact declared label name
  set), invalid samples are skipped, and a per-source cap
  `MAX_GAUGE_SOURCE_SAMPLES` = 10 000 bounds the rendered output. Existing
  valid sources render byte-identically to before; the public `GaugeSource`
  interface and `registerGaugeSource` signature are unchanged.

### 3. `server/src/routes/ops.ts` (reviewed, unchanged)

Re-reviewed `createSingleFlightProbe` and its `/healthz` `/readyz` receivers
line by line for the four requested bug classes; no confirmed defect remained:

- Bounded resource: fixed slots snapshotted per configured check; each
  run-bounded wait allocates one cleared timer (`runBounded` `finally`); no
  per-request map grows.
- Late result/rejection: the underlying `attempt` has both settle observers
  attached synchronously (slot released exactly once, guarded by
  `current === flight` so a superseded flight cannot release a newer one); the
  rejection is consumed by `runBounded`'s rejection handler attached at
  creation, so a late rejection after timeout cannot become an unhandled
  rejection; a late result releases the slot only.
- Elapsed budget: `/readyz` computes one `performance.now()` deadline, uses
  `min(checkTimeoutMs, remaining)`, and any check cut off by budget
  exhaustion forces `not_ready` — verified unchanged and correct.
- Receiver mapping: the shared-result path maps an outer
  `{ok:true,value:{ok:false}}` wrapper to `{ok:false}` correctly; flight
  results never reject.

Timeout-still-not-cancellation, one-operation-per-configuration-entry and
hung-driver limits remain as documented in CODEX-OPERATIONS-CLOSURE-20261022;
no reimplementation was performed (`createSingleFlightProbe` was already
present) and no failure evidence was invented.

## Configured / wired

Nothing is wired to the running process in this batch (by explicit scope): no
hooks in worker files, no `index.ts` registry change, no startup/shutdown
call. The concrete integration request (WorkBuddy hook shapes, one-registry
sharing, `setWorkerRunning` lifecycle bracketing) is published in
`docs/contracts/WORKER-OBSERVABILITY-CONTRACT.md` §7–§9 for the owning
writers after contract freeze.

## Held

- Backlog samplers: none configured; `worker_backlog` renders no series until
  a domain owner (R08/R11/R12) proves a bounded canonical query. The seam is
  code-level only.
- SLO thresholds, alert rules, runbook, deployment tooling, restore/load
  proof: remain held by the master plan; not simulated here.
- Sampling a backlog metric inside a timed worker function remains forbidden
  (no observation may schedule or execute work).

## Untested

No tests were added or run, and no compiler/typecheck was executed (explicit
restriction). Verification steps for the authorized parent: (1) bounded
series across random/invalid IDs (invalid kinds/outcomes produce no new
series, only incidents); (2) observer exception injection during runs (domain
outcome and rethrown error unchanged, in-flight decremented once); (3)
duplicate `end`, overlapping runs, `classify` throwing; (4) gauge source
rejections above render as `# HELP`-only families instead of a failed scrape;
(5) `/metrics` byte-diff vs. previous build for unchanged valid wiring.

## Honest limitations

- An `end` call that is never made leaves `worker_passes_inflight` elevated
  for the process lifetime; the observer cannot detect this timer-free. The
  contract mandates the exact once-path for hook writers.
- A second adapter over the same registry silently reuses the first metric
  definitions (per registry idempotency); one adapter per registry is the
  documented norm.
- The backlog gauge executes injected domain code at scrape time by design of
  the existing `GaugeSource` mechanism; no sampler ships here, and the
  contract forbids per-tenant queries inside one.
- No runtime evidence of any of the above exists until run; nothing in this
  report claims it.

---

# Round4 addition — GLM lane, finite registry integrity correction — 2026-10-24

Supervisor: Codex. Writable paths honored exactly
(`server/src/services/metrics.ts`, `server/src/services/worker-observability.ts`
— read-only this round, this contract, this report, plus the external
`C:/Users/abdua/opencode-reports/20261024-round4/glm-handoff.md`). No new
files, no commands, no tests, no compiler/typecheck, no SQL, no git, no
provider or service change.

## Exact changes (`server/src/services/metrics.ts` only)

1. `define()` now checks rendered-series name intersections against every
   existing descriptor in `definitions`, not only registered gauge sources.
   Proven defect: `counter foo_count` + `histogram foo` in EITHER declaration
   order rendered `foo_count` samples inside two `# TYPE` families. Same-name
   identical-type/label redefinition still returns the existing descriptor
   before any collision loop, so idempotent re-registration is untouched.
2. `labelKey` switched from `\u001f`/`\u0001` delimiter concatenation to
   JSON-encoded ordered `(name, value)` tuples. Proven defect: with
   labelNames `[a, b]`, `{a:"p\u0001b\u001fq", b:"r"}` and
   `{a:"p", b:"q\u0001b\u001fr"}` produced one identical key, merging distinct
   user label tuples into one series. Validation calls, public API, in-memory
   key usage (no persistence) and sorted rendering are unchanged.
3. After inspection, `normalizedBuckets` collapses duplicate positive bounds
   and `define()` rejects a histogram labelNames entry `le`. Both were proven
   to yield duplicate sample identities (identical cumulative `le=` lines;
   user `le` overwritten by the bucket cut). `-0` bounds are already excluded
   by the `> 0` filter and `String` is injective on distinct positive finite
   numbers, so no other bounds vector collides on `le`.
4. Header design-constraints comment updated to document the above. The
   Codex slice-before-filter sample bound in `render()`
   (`.slice(0, MAX_GAUGE_SOURCE_SAMPLES)` before validity filtering) is kept
   unchanged.

## Unchanged after review

- `server/src/services/worker-observability.ts`: no confirmed defect;
  injection-only construction, shared-registry usage, fixed kinds/outcomes/
  reasons and closed label sets stand as written. Its labels contain no
  control characters, so the `labelKey` re-encoding cannot alter its series.
- All existing metric call sites were name-checked against the new
  cross-definition collision rule: `http_requests_total`,
  `http_request_duration_seconds` (+ `_bucket`/`_sum`/`_count`), and the
  `worker_*` family with gauge source `worker_backlog` share no rendered
  names, so no current call site newly throws.

## Limits and verification honesty

- All defect proofs in this round are source-level read-reviews (manual
  expansion of encoding and rendering paths), not executed tests.
- The duplicate-bounds and reserved-`le` rejections were additionally
  inspected as instructed and only then enforced; they were not assumed.
- Same-name idempotent definition, gauge-source registration idempotency and
  byte-stable rendering of previously valid wiring are preserved by
  construction; a render byte-diff against a previous build remains the
  authorized parent's verification step if they choose to run one.
