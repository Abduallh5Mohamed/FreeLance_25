"use strict";
/**
 * M8 Q4 — operations wiring: observability middleware, the protected metrics
 * scrape endpoint and the liveness/readiness probes.
 *
 * This module is the single entry point a host wires in (there is intentionally
 * no edit to `server/src/index.ts` in this delivery):
 *
 *   import { mountObservability } from './routes/ops';
 *   mountObservability(app, deps);
 *
 * `createObservabilityMiddleware` attaches the correlation context, records one
 * HTTP request sample (route template + status class) per finished request and
 * emits one structured, redacted access-log line.
 *
 * `/metrics` is denied by default: it requires a dedicated `METRICS_TOKEN`
 * bearer value of at least 32 bytes, compared in constant time. A missing or
 * too-short configured token fails closed with 503; a missing/incorrect bearer
 * is 401. The process-to-process bearer never appears in logs. Denials are
 * `no-store`: a cached denial or verdict must never be replayed by a proxy.
 *
 * `/healthz` is pure liveness (no dependencies). `/readyz` runs injected
 * dependency checks and reports a generic ready/not-ready verdict with no
 * detail leakage.
 *
 * Every probe is bounded: a check that never settles is cut off at
 * `checkTimeoutMs` (and the whole readiness sweep at `readinessBudgetMs`) and
 * reported as unavailable/not-ready, so a hung dependency can never hang the
 * probe. Timeout handles are always cleared, so a probe leaves no timer behind
 * and no background timer is started. Liveness and dependency readiness stay
 * separate concepts: `/healthz` never runs a dependency check.
 * Each configured probe has one underlying operation in flight. A timeout
 * keeps that slot occupied until the actual operation settles, so repeated
 * requests cannot launch unbounded work against a hung driver. This is an
 * admission bound, not SQL cancellation; stuck work keeps readiness false.
 *
 * An empty readiness list is NOT treated as ready: a deployment that wires no
 * checks looks identical to a broken one, so it reports `not_ready` unless the
 * operator explicitly opts in with `readinessOptIn` (documented intent that no
 * dependency gate exists).
 */
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.defaultOpsRouter = exports.DEFAULT_READINESS_BUDGET_MS = exports.DEFAULT_CHECK_TIMEOUT_MS = exports.METRICS_TOKEN_MIN_BYTES = void 0;
exports.defaultRouteTemplate = defaultRouteTemplate;
exports.createObservabilityMiddleware = createObservabilityMiddleware;
exports.constantTimeEqual = constantTimeEqual;
exports.authorizeMetricsRequest = authorizeMetricsRequest;
exports.createOpsRouter = createOpsRouter;
exports.mountObservability = mountObservability;
exports.createDatabaseReadinessCheck = createDatabaseReadinessCheck;
const crypto_1 = require("crypto");
const perf_hooks_1 = require("perf_hooks");
const express_1 = require("express");
const request_context_1 = require("../middleware/request-context");
const logger_1 = require("../services/logger");
const metrics_1 = require("../services/metrics");
/** Minimum byte length of a deployable metrics token. */
exports.METRICS_TOKEN_MIN_BYTES = 32;
/** Per-check timeout for the liveness/readiness predicates, in milliseconds. */
exports.DEFAULT_CHECK_TIMEOUT_MS = 2000;
/** Overall budget for one readiness sweep (all checks), in milliseconds. */
exports.DEFAULT_READINESS_BUDGET_MS = 5000;
const resolveLogLevel = (value) => {
    if (value === 'debug' || value === 'info' || value === 'warn' || value === 'error')
        return value;
    return 'info';
};
/**
 * Route template for the metrics label: the matched Express route pattern, not
 * the raw path (bounded cardinality). Unmatched requests collapse to a single
 * `unmatched` label.
 */
function defaultRouteTemplate(req) {
    const rawPath = req.route?.path;
    const routePath = Array.isArray(rawPath) ? rawPath.find((entry) => typeof entry === 'string') : rawPath;
    if (typeof routePath === 'string' && routePath.length > 0) {
        const base = typeof req.baseUrl === 'string' ? req.baseUrl : '';
        const combined = `${base}${routePath === '/' ? '' : routePath}`;
        return combined.length > 0 ? combined : '/';
    }
    return 'unmatched';
}
/**
 * Build the observability middleware. Applies the correlation context (if not
 * already applied), then records one HTTP sample and one access-log line on the
 * response `finish` event. Metrics/logging can never fail the request.
 */
function createObservabilityMiddleware(deps) {
    const requestContext = (0, request_context_1.createRequestContextMiddleware)();
    const observer = deps.httpObserver ?? (0, metrics_1.createHttpObserver)(deps.metrics);
    const now = deps.now ?? (() => Date.now());
    const resolveRoute = deps.routeResolver ?? defaultRouteTemplate;
    return (req, res, next) => {
        requestContext(req, res, () => { });
        const marked = req;
        if (!marked.__observabilityHooked && typeof res.on === 'function') {
            marked.__observabilityHooked = true;
            const startedAt = now();
            res.on('finish', () => {
                const durationMs = Math.max(0, now() - startedAt);
                const status = Number.isInteger(res.statusCode) ? res.statusCode : 200;
                let route = 'unmatched';
                try {
                    route = resolveRoute(req) || 'unmatched';
                }
                catch {
                    route = 'unmatched';
                }
                try {
                    observer.observe({ method: req.method, route, status, durationMs });
                }
                catch {
                    /* instrumentation must never break the request */
                }
                const context = (0, request_context_1.getRequestContext)(req);
                const level = status >= 500 ? 'error' : status >= 400 ? 'warn' : 'info';
                try {
                    deps.logger[level]('http_request', {
                        request_id: context.requestId,
                        tenant_id: context.tenantId,
                        method: req.method,
                        route,
                        status,
                        duration_ms: durationMs,
                    });
                }
                catch {
                    /* logging must never break the request */
                }
            });
        }
        next();
    };
}
/**
 * Constant-time string comparison via fixed-length SHA-256 digests: equal-length
 * digests are compared byte-by-byte, so the comparison neither short-circuits on
 * a common prefix nor leaks the input length.
 */
function constantTimeEqual(a, b) {
    const digestA = (0, crypto_1.createHash)('sha256').update(a, 'utf8').digest();
    const digestB = (0, crypto_1.createHash)('sha256').update(b, 'utf8').digest();
    return (0, crypto_1.timingSafeEqual)(digestA, digestB);
}
/**
 * Authorize a metrics scrape. Fails closed: an unset or too-short configured
 * token is a 503 (the endpoint is not safely deployable), and any missing or
 * wrong bearer is a 401.
 */
function authorizeMetricsRequest(authorization, configuredToken) {
    if (typeof configuredToken !== 'string' || Buffer.byteLength(configuredToken, 'utf8') < exports.METRICS_TOKEN_MIN_BYTES) {
        return { ok: false, status: 503 };
    }
    if (typeof authorization !== 'string')
        return { ok: false, status: 401 };
    const match = /^Bearer\s+([^\s]+)$/i.exec(authorization.trim());
    if (!match)
        return { ok: false, status: 401 };
    const equal = constantTimeEqual(match[1], configuredToken);
    return { ok: equal, status: equal ? 200 : 401 };
}
const noStore = (res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Content-Type', 'text/plain; version=0.0.4; charset=utf-8');
};
/** A finite, positive millisecond bound; anything else falls back. */
const boundedMs = (value, fallback) => typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
/**
 * Resolve `task` within `timeoutMs`. A rejection (including a synchronous throw)
 * or a timeout yields `{ ok: false }`; a late result after the timeout is
 * ignored rather than surfaced as an unhandled rejection. The timer handle is
 * cleared on every path, so a probe never leaks a pending timer.
 */
const runBounded = async (task, timeoutMs) => {
    let handle;
    const attempt = Promise.resolve()
        .then(task)
        .then((value) => ({ ok: true, value }), () => ({ ok: false }));
    try {
        return await Promise.race([
            attempt,
            new Promise((resolve) => {
                handle = setTimeout(() => resolve({ ok: false }), timeoutMs);
            }),
        ]);
    }
    finally {
        if (handle !== undefined) {
            clearTimeout(handle);
            handle = undefined;
        }
    }
};
/**
 * Admit at most one underlying operation per configured probe. A timed-out
 * response does not mean that a driver operation stopped: retain its flight
 * until the operation actually settles, and reuse the already-bounded result
 * for subsequent requests. In particular, repeated requests after a timeout
 * neither start another query nor subscribe again to a never-settling query.
 *
 * Concurrent callers share the result, but each caller still has its own
 * remaining readiness budget. Only that bounded result is awaited repeatedly;
 * the underlying operation has one completion/rejection observer. No retry
 * timer or request-keyed map is retained. A genuinely stuck operation keeps
 * this probe unavailable until it settles (or the host is restarted); this
 * does not claim SQL cancellation or connection disposal.
 */
const createSingleFlightProbe = (task) => {
    let current = null;
    return (timeoutMs) => {
        if (current !== null) {
            const result = current.result;
            return runBounded(() => result, timeoutMs).then((outcome) => outcome.ok ? outcome.value : { ok: false });
        }
        const flight = { result: Promise.resolve({ ok: false }) };
        current = flight;
        const attempt = Promise.resolve().then(task).then((value) => {
            if (current === flight)
                current = null;
            return value;
        }, (error) => {
            if (current === flight)
                current = null;
            throw error;
        });
        flight.result = runBounded(() => attempt, timeoutMs);
        return flight.result;
    };
};
/**
 * Router exposing `/metrics`, `/healthz` and `/readyz`. Mount it at the
 * application root (paths already include their leading slash).
 */
function createOpsRouter(deps) {
    const router = (0, express_1.Router)();
    const liveness = createSingleFlightProbe(deps.liveness ?? (() => true));
    // Fixed, router-owned slots: no state grows with request count or input.
    const readiness = (deps.readiness ?? []).map((dependency) => createSingleFlightProbe(() => dependency.check()));
    const checkTimeoutMs = boundedMs(deps.checkTimeoutMs, exports.DEFAULT_CHECK_TIMEOUT_MS);
    const readinessBudgetMs = boundedMs(deps.readinessBudgetMs, exports.DEFAULT_READINESS_BUDGET_MS);
    router.get('/metrics', (req, res) => {
        const result = authorizeMetricsRequest(req.headers.authorization, deps.metricsToken);
        if (!result.ok) {
            deps.logger.warn('metrics_scrape_denied', { status: result.status });
            // A denial is per-caller and must never be cached or replayed.
            res.setHeader('Cache-Control', 'no-store');
            res.status(result.status).json({
                error: result.status === 503 ? 'Metrics endpoint is not configured' : 'Unauthorized',
            });
            return;
        }
        noStore(res);
        res.send(deps.metrics.render());
    });
    router.get('/healthz', async (_req, res) => {
        const outcome = await liveness(checkTimeoutMs);
        const alive = outcome.ok && Boolean(outcome.value);
        res.setHeader('Cache-Control', 'no-store');
        res.status(alive ? 200 : 503).json({ status: alive ? 'ok' : 'unavailable' });
    });
    router.get('/readyz', async (_req, res) => {
        // No checks wired is not evidence of readiness: require an explicit
        // opt-in, otherwise an unwired deployment must report not-ready.
        let ready = readiness.length > 0 || deps.readinessOptIn === true;
        const deadline = perf_hooks_1.performance.now() + readinessBudgetMs;
        for (const check of readiness) {
            const remaining = deadline - perf_hooks_1.performance.now();
            if (remaining <= 0) {
                ready = false;
                break;
            }
            const outcome = await check(Math.min(checkTimeoutMs, remaining));
            if (!outcome.ok || !outcome.value)
                ready = false;
        }
        res.setHeader('Cache-Control', 'no-store');
        // Generic verdict only: no dependency names, counts, errors or versions.
        res.status(ready ? 200 : 503).json({ status: ready ? 'ready' : 'not_ready' });
    });
    return router;
}
/**
 * Wire the request context, the observability middleware and the ops router
 * onto an Express application. Call before the terminal 404 handler.
 */
function mountObservability(app, deps) {
    app.use((0, request_context_1.createRequestContextMiddleware)());
    app.use(createObservabilityMiddleware(deps));
    app.use(createOpsRouter(deps));
}
/** A readiness check that lazily probes the database with a trivial query. */
function createDatabaseReadinessCheck() {
    return {
        name: 'database',
        check: async () => {
            try {
                const { query } = await Promise.resolve().then(() => __importStar(require('../db')));
                await query('SELECT 1');
                return true;
            }
            catch {
                return false;
            }
        },
    };
}
/* Production default wiring (env-driven, no connection opened at import). */
const defaultLogger = (0, logger_1.createLogger)({ level: resolveLogLevel(process.env.LOG_LEVEL) });
const defaultMetrics = (0, metrics_1.createMetricsRegistry)();
exports.defaultOpsRouter = createOpsRouter({
    logger: defaultLogger,
    metrics: defaultMetrics,
    metricsToken: process.env.METRICS_TOKEN,
    readiness: [createDatabaseReadinessCheck()],
});
exports.default = exports.defaultOpsRouter;
