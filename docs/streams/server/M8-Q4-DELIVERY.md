# M8 Q4 — Observability delivery

**Status:** implemented, typechecked and tested hermetically.
**Backlog row:** M8 Q4 (`docs/17-full-feature-backlog.md`) — *structured redacted
logs, traces/metrics, tenant/request IDs and actionable alerts.*

## Files

| File | Role |
| --- | --- |
| `server/src/middleware/request-context.ts` | request/tenant id middleware |
| `server/src/services/logger.ts` | structured JSON logger + redaction layer |
| `server/src/services/metrics.ts` | Prometheus metrics registry + HTTP observer |
| `server/src/routes/ops.ts` | `createObservabilityMiddleware`, `createOpsRouter`, `mountObservability`, token auth |
| `server/tests/m8-observability.test.ts` | 25 hermetic tests |
| `docs/streams/server/M8-Q4-ALERTS.md` | alert rules |

No migration, no schema change and no `server/src/index.ts` edit: Q4 is pure
runtime instrumentation. The wiring entry point is exported for the host to
call (see below), so no other stream's files were touched.

## What was delivered

### Request / tenant context (`request-context.ts`)
- `X-Request-Id` is generated (`crypto.randomUUID`) when absent and echoed on the
  response header and on `req.requestId` / `req.requestContext`.
- An incoming id is accepted **only** if it matches the strict, injection-safe
  `REQUEST_ID_PATTERN` (`^[A-Za-z0-9][A-Za-z0-9._-]{7,127}$`); anything else is
  discarded and replaced. Untrusted values are never echoed.
- The tenant id is read from the **verified principal only**
  (`req.user.tenantId`); a client-supplied tenant header is ignored
  (deny-by-default). The getter recomputes the tenant after authentication.
- Idempotent: re-applying preserves the existing id/header.

### Structured redacted logging (`logger.ts`)
- One JSON line per record; injected clock and sink for hermetic tests.
- Redaction walks the payload: secret keys (`password`, `token`, `secret`,
  `authorization`, `cookie`, `api_key`, `credential`, `private_key`, `otp`,
  `pin`, `cvv`, `card_number`, `session_id`, `bearer`, ...) → `[REDACTED]`;
  emails/phones masked (key-driven, plus email value detection).
- Bounds depth (`[MaxDepth]`), array length, string length; breaks cycles
  (`[Circular]`); caps total record size and replaces an oversized record with a
  bounded, redacted preview while keeping short scalar context (correlation ids).
- Level threshold; `child()` bindings.

### Metrics (`metrics.ts`)
- Dependency-free registry: counters, histograms, gauges, plus injectable
  `GaugeSource`s sampled at scrape time (queue/job lag).
- HTTP counters/histograms dimensioned by **route template + status class**
  (`http_requests_total`, `http_request_duration_seconds`).
- Prometheus text exposition (`# HELP`/`# TYPE`, cumulative histogram buckets,
  `+Inf`, `_sum`, `_count`); deterministic ordering; label-name/type validation
  rejects unexpected or conflicting series.

### Ops surfaces (`ops.ts`)
- `createObservabilityMiddleware(deps)` — context + one HTTP sample + one
  redacted access log per finished request; never throws into the request.
- `/metrics` — **denied by default**; requires a dedicated bearer `METRICS_TOKEN`
  of ≥32 bytes compared in constant time (SHA-256 digests + `timingSafeEqual`).
  Missing/short configured token → **503** (fail closed); missing/wrong bearer →
  **401**; valid → Prometheus text (`Cache-Control: no-store`).
- `/healthz` — liveness, **no dependencies**, generic body.
- `/readyz` — runs injected dependency checks, returns a generic
  ready/not-ready verdict only (no dependency names/errors/versions).
- `mountObservability(app, deps)` — wires context middleware, observability
  middleware and the ops router. **`index.ts` is not edited**; the host calls it
  before the terminal 404 handler.

## Wiring example (host-owned)

```ts
import { createLogger } from './services/logger';
import { createMetricsRegistry } from './services/metrics';
import { mountObservability } from './routes/ops';

mountObservability(app, {
  logger: createLogger({ level: 'info' }),
  metrics: createMetricsRegistry(),
  metricsToken: process.env.METRICS_TOKEN,   // >= 32 bytes or /metrics is 503
  readiness: [/* injected dependency checks */],
});
```

## Verification

- `node node_modules/typescript/bin/tsc --noEmit -p server/tsconfig.json` — clean.
- `node node_modules/tsx/dist/cli.mjs --test server/tests/m8-observability.test.ts`
  — 25/25 pass.
- Full suite `server/tests/*.test.ts` — **2094/2094 pass, run twice**.
- No `any`, no `@ts-ignore`; all behavior token-tested (allow/deny/cross-tenant/
  validation/failure where applicable), no DB/Docker/network contact.

## Notes / limits

- `queue_lag_seconds` is intentionally a source-driven gauge: Q4 ships the
  mechanism and tests it with an injected source; each queue owner registers its
  own source. No speculative queue schema was invented.
- The alert rules are a specification (thresholds, expressions, severities) in
  `docs/streams/server/M8-Q4-ALERTS.md`, not a vendor rule file.
- A dedicated `auth_failures_total{reason}` counter is suggested in the alerts
  doc; until the auth stream registers it, A5 derives from auth-route 4xx.
