# M8 Q4 — Observability alert rules

**Scope:** actionable production alerts derived from the Q4 metrics and logs
(`server/src/services/metrics.ts`, `server/src/services/logger.ts`,
`server/src/middleware/request-context.ts`, `server/src/routes/ops.ts`).
This document is a specification, not a runnable rule file: thresholds are the
agreed defaults, and each alert states its metric source, window, expression and
severity. Tune per environment; keep every alert's `for:` duration non-zero so
single-scrape noise cannot page.

Correlation: every HTTP sample carries `route` (the route **template**, not the
raw path) and `status_class`; every log line carries `request_id` and
`tenant_id`. `http_request_duration_seconds` is a histogram, so `histogram_quantile`
is usable directly.

## Metrics referenced

| Metric | Type | Labels | Meaning |
| --- | --- | --- | --- |
| `http_requests_total` | counter | `method`, `route`, `status_class` | finished requests |
| `http_request_duration_seconds` | histogram | `method`, `route`, `status_class` | request latency |
| `queue_lag_seconds` | gauge (injected source) | deployment-defined (`queue`, ...) | oldest pending job age per queue |
| `auth_failures_total` **or** log-derived | counter/log | `route`, (reason) | authentication/authorization rejects |

> `queue_lag_seconds` (and any other workload gauge) is supplied through
> `MetricsRegistry.registerGaugeSource`; the alerting platform scrapes whatever
> sources the deployment registers.

## Alerts

### A1 — Elevated 5xx error rate (page)

- **Source:** `http_requests_total{status_class="5xx"}` / `http_requests_total`
- **Window:** 5m, evaluated every 1m
- **Expression:**
  ```promql
  sum(rate(http_requests_total{status_class="5xx"}[5m]))
  /
  clamp_min(sum(rate(http_requests_total[5m])), 1)
  > 0.02
  ```
- **For:** 10m
- **Severity:** critical
- **Why:** a sustained >2% server-error rate is user-visible breakage.
- **First response:** group by `route` to localise:
  `topk(5, sum by (route) (rate(http_requests_total{status_class="5xx"}[5m])))`.

### A2 — Absolute 5xx volume surge (page)

- **Source:** `http_requests_total{status_class="5xx"}`
- **Window:** 5m, evaluated every 1m
- **Expression:**
  ```promql
  sum by (route) (rate(http_requests_total{status_class="5xx"}[5m])) > 1
  ```
- **For:** 10m
- **Severity:** critical
- **Why:** catches a low-traffic surface failing hard before the ratio crosses A1.

### A3 — p95 latency regression (ticket / page during launch)

- **Source:** `http_request_duration_seconds` (histogram)
- **Window:** 10m, evaluated every 1m
- **Expression:**
  ```promql
  histogram_quantile(
    0.95,
    sum by (le, route) (rate(http_request_duration_seconds_bucket[10m]))
  ) > 1.5
  ```
- **For:** 15m
- **Severity:** warning (critical if the service has a published p95 SLO)
- **Why:** p95 over 1.5s on any route template degrades student/teacher flows.
- **Note:** the histogram's default buckets top at 10s; add deployment-specific
  buckets if the SLO sits above that.

### A4 — Queue / job lag (page)

- **Source:** `queue_lag_seconds` (injected gauge source)
- **Window:** instantaneous, evaluated every 1m
- **Expression:**
  ```promql
  max by (queue) (queue_lag_seconds) > 300
  ```
- **For:** 10m
- **Severity:** critical
- **Why:** a queue whose oldest pending job is over 5 minutes behind is not
  keeping up (video processing, notifications, lifecycle reconciliation).
- **Warning tier:** `> 120` for 15m → warning, so the page does not fire first.

### A5 — Authentication failure spike (page)

- **Source:** counter `auth_failures_total` (or a log-derived count of
  401/403 responses by `route`) — the Q4 registry exposes the HTTP-side signal
  as `http_requests_total{status_class="4xx"}` per auth route until a dedicated
  auth-failure counter is registered by the auth stream.
- **Window:** 5m, evaluated every 1m
- **Expression:**
  ```promql
  sum(rate(http_requests_total{route=~"/api/(auth|parent)/.*",status_class="4xx"}[5m])) > 20
  ```
  **For:** 5m
- **Severity:** critical
- **Why:** a credential-stuffing or token-forgery wave shows as a sharp 4xx
  spike on auth surfaces. Correlate with `request_id`/`tenant_id` log lines.
- **Note:** if a dedicated `auth_failures_total{reason}` counter is added, prefer
  ```promql
  sum by (reason) (rate(auth_failures_total[5m])) > 20
  ```
  and split `bad_credentials` (abuse) from `session_revoked` (expected churn).

### A6 — Log error-rate sentinel (ticket)

- **Source:** structured logs at `level="error"`
- **Window:** 5m
- **Expression:** alert when `error`-level access lines exceed 1% of total
  `http_request` lines for 10m.
- **Severity:** warning
- **Why:** catches failures that do not surface as 5xx (background work logged
  through the same logger).

## Suppressions and guards

- Always keep `for:` non-zero (≥5m) to avoid paging on a single failed scrape.
- Rate windows use `clamp_min(..., 1)` on denominators to avoid division blow-ups
  at low traffic.
- During a planned migration window, silence A1/A2 for the migrating route only,
  never globally.
- A `503` from `/metrics` means `METRICS_TOKEN` is unset or shorter than 32
  bytes: the scrape is failing closed. Follow-up: configure the token; do not
  weaken the check.

## Non-goals

- No alert on request volume or `route="unmatched"` volume alone (expected for
  bots/probes); use them only as context for A1/A2.
- No PII in any alert label or annotation: labels are limited to `route`,
  `method`, `status_class`, `queue` and `reason` (all low-cardinality,
  non-identifying).
