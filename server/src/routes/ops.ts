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
 * is 401. The process-to-process bearer never appears in logs.
 *
 * `/healthz` is pure liveness (no dependencies). `/readyz` runs injected
 * dependency checks and reports a generic ready/not-ready verdict with no
 * detail leakage.
 */

import { createHash, timingSafeEqual } from 'crypto';
import { Application, NextFunction, Request, RequestHandler, Response, Router } from 'express';
import {
    ContextRequest,
    createRequestContextMiddleware,
    getRequestContext,
} from '../middleware/request-context';
import { Logger, LogLevel, createLogger } from '../services/logger';
import {
    HttpObserver,
    MetricsRegistry,
    createHttpObserver,
    createMetricsRegistry,
} from '../services/metrics';

/** Minimum byte length of a deployable metrics token. */
export const METRICS_TOKEN_MIN_BYTES = 32;

/** A readiness dependency check; its name is never exposed to a caller. */
export interface ReadinessCheck {
    name: string;
    check: () => boolean | Promise<boolean>;
}

export interface ObservabilityDeps {
    logger: Logger;
    metrics: MetricsRegistry;
    /** Override the HTTP observer (defaults to the registry-backed one). */
    httpObserver?: HttpObserver;
    /** Dedicated bearer token guarding `/metrics`; may be undefined (fail closed). */
    metricsToken?: string;
    /** Monotonic millisecond clock (defaults to `Date.now`). */
    now?: () => number;
    /** Resolves the route template used as the metrics label. */
    routeResolver?: (req: Request) => string;
    /** Liveness predicate; defaults to always-alive. */
    liveness?: () => boolean | Promise<boolean>;
    /** Readiness dependency checks run by `/readyz`. */
    readiness?: readonly ReadinessCheck[];
}

interface ObservedRequest extends ContextRequest {
    __observabilityHooked?: boolean;
}

const resolveLogLevel = (value: string | undefined): LogLevel => {
    if (value === 'debug' || value === 'info' || value === 'warn' || value === 'error') return value;
    return 'info';
};

/**
 * Route template for the metrics label: the matched Express route pattern, not
 * the raw path (bounded cardinality). Unmatched requests collapse to a single
 * `unmatched` label.
 */
export function defaultRouteTemplate(req: Request): string {
    const rawPath = (req as { route?: { path?: unknown } }).route?.path;
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
export function createObservabilityMiddleware(deps: ObservabilityDeps): RequestHandler {
    const requestContext = createRequestContextMiddleware();
    const observer = deps.httpObserver ?? createHttpObserver(deps.metrics);
    const now = deps.now ?? (() => Date.now());
    const resolveRoute = deps.routeResolver ?? defaultRouteTemplate;

    return (req: Request, res: Response, next: NextFunction): void => {
        requestContext(req, res, () => { /* context only; continue below */ });
        const marked = req as ObservedRequest;
        if (!marked.__observabilityHooked && typeof res.on === 'function') {
            marked.__observabilityHooked = true;
            const startedAt = now();
            res.on('finish', () => {
                const durationMs = Math.max(0, now() - startedAt);
                const status = Number.isInteger(res.statusCode) ? res.statusCode : 200;
                let route = 'unmatched';
                try {
                    route = resolveRoute(req) || 'unmatched';
                } catch {
                    route = 'unmatched';
                }
                try {
                    observer.observe({ method: req.method, route, status, durationMs });
                } catch {
                    /* instrumentation must never break the request */
                }
                const context = getRequestContext(req);
                const level: LogLevel = status >= 500 ? 'error' : status >= 400 ? 'warn' : 'info';
                try {
                    deps.logger[level]('http_request', {
                        request_id: context.requestId,
                        tenant_id: context.tenantId,
                        method: req.method,
                        route,
                        status,
                        duration_ms: durationMs,
                    });
                } catch {
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
export function constantTimeEqual(a: string, b: string): boolean {
    const digestA = createHash('sha256').update(a, 'utf8').digest();
    const digestB = createHash('sha256').update(b, 'utf8').digest();
    return timingSafeEqual(digestA, digestB);
}

export interface MetricsAuthorization {
    ok: boolean;
    /** 200 when authorized, 401 for a missing/incorrect bearer, 503 when misconfigured. */
    status: number;
}

/**
 * Authorize a metrics scrape. Fails closed: an unset or too-short configured
 * token is a 503 (the endpoint is not safely deployable), and any missing or
 * wrong bearer is a 401.
 */
export function authorizeMetricsRequest(authorization: unknown, configuredToken: unknown): MetricsAuthorization {
    if (typeof configuredToken !== 'string' || Buffer.byteLength(configuredToken, 'utf8') < METRICS_TOKEN_MIN_BYTES) {
        return { ok: false, status: 503 };
    }
    if (typeof authorization !== 'string') return { ok: false, status: 401 };
    const match = /^Bearer\s+([^\s]+)$/i.exec(authorization.trim());
    if (!match) return { ok: false, status: 401 };
    const equal = constantTimeEqual(match[1], configuredToken);
    return { ok: equal, status: equal ? 200 : 401 };
}

const noStore = (res: Response): void => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Content-Type', 'text/plain; version=0.0.4; charset=utf-8');
};

/**
 * Router exposing `/metrics`, `/healthz` and `/readyz`. Mount it at the
 * application root (paths already include their leading slash).
 */
export function createOpsRouter(deps: ObservabilityDeps): Router {
    const router = Router();
    const liveness = deps.liveness ?? (() => true);
    const readiness = deps.readiness ?? [];

    router.get('/metrics', (req: Request, res: Response) => {
        const result = authorizeMetricsRequest(req.headers.authorization, deps.metricsToken);
        if (!result.ok) {
            deps.logger.warn('metrics_scrape_denied', { status: result.status });
            res.status(result.status).json({
                error: result.status === 503 ? 'Metrics endpoint is not configured' : 'Unauthorized',
            });
            return;
        }
        noStore(res);
        res.send(deps.metrics.render());
    });

    router.get('/healthz', async (_req: Request, res: Response) => {
        let alive = false;
        try {
            alive = await liveness();
        } catch {
            alive = false;
        }
        res.setHeader('Cache-Control', 'no-store');
        res.status(alive ? 200 : 503).json({ status: alive ? 'ok' : 'unavailable' });
    });

    router.get('/readyz', async (_req: Request, res: Response) => {
        let ready = true;
        for (const dependency of readiness) {
            try {
                if (!(await dependency.check())) ready = false;
            } catch {
                ready = false;
            }
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
export function mountObservability(app: Application, deps: ObservabilityDeps): void {
    app.use(createRequestContextMiddleware());
    app.use(createObservabilityMiddleware(deps));
    app.use(createOpsRouter(deps));
}

/** A readiness check that lazily probes the database with a trivial query. */
export function createDatabaseReadinessCheck(): ReadinessCheck {
    return {
        name: 'database',
        check: async () => {
            try {
                const { query } = await import('../db');
                await query('SELECT 1');
                return true;
            } catch {
                return false;
            }
        },
    };
}

/* Production default wiring (env-driven, no connection opened at import). */

const defaultLogger = createLogger({ level: resolveLogLevel(process.env.LOG_LEVEL) });
const defaultMetrics = createMetricsRegistry();

export const defaultOpsRouter: Router = createOpsRouter({
    logger: defaultLogger,
    metrics: defaultMetrics,
    metricsToken: process.env.METRICS_TOKEN,
    readiness: [createDatabaseReadinessCheck()],
});

export default defaultOpsRouter;
