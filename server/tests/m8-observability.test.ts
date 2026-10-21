import assert from 'node:assert/strict';
import test from 'node:test';
import type { Application, Request, Response } from 'express';
import {
    CIRCULAR,
    MAX_DEPTH_MARKER,
    REDACTED,
    createLogger,
    isSensitiveKey,
    maskEmail,
    maskPhone,
    redactValue,
} from '../src/services/logger';
import {
    DEFAULT_DURATION_BUCKETS,
    HTTP_METHOD_FALLBACK,
    boundedHttpMethod,
    createHttpObserver,
    createMetricsRegistry,
    statusClass,
} from '../src/services/metrics';
import {
    REQUEST_ID_PATTERN,
    createRequestContextMiddleware,
    getRequestContext,
    getRequestId,
    normalizeIncomingRequestId,
    resolveVerifiedTenantId,
} from '../src/middleware/request-context';
import {
    METRICS_TOKEN_MIN_BYTES,
    authorizeMetricsRequest,
    constantTimeEqual,
    createObservabilityMiddleware,
    createOpsRouter,
    defaultRouteTemplate,
    mountObservability,
} from '../src/routes/ops';
import type { ObservabilityDeps } from '../src/routes/ops';

/* -------------------------------------------------------------------------- */
/* Hermetic request/response doubles                                           */
/* -------------------------------------------------------------------------- */

interface FakeResponse {
    statusCode: number;
    headers: Record<string, string>;
    settled: boolean;
    body?: unknown;
    status(code: number): FakeResponse;
    setHeader(name: string, value: string): FakeResponse;
    set(name: string, value: string): FakeResponse;
    json(payload: unknown): FakeResponse;
    send(payload: string): FakeResponse;
    on(event: string, listener: () => void): FakeResponse;
    emit(event: string): void;
}

const makeResponse = (): FakeResponse => {
    const listeners: Record<string, Array<() => void>> = {};
    const response: FakeResponse = {
        statusCode: 200,
        headers: {},
        settled: false,
        status(code) { response.statusCode = code; return response; },
        setHeader(name, value) { response.headers[name.toLowerCase()] = value; return response; },
        set(name, value) { response.headers[name.toLowerCase()] = value; return response; },
        json(payload) { response.statusCode = response.statusCode || 200; response.body = payload; response.settled = true; return response; },
        send(payload) { response.body = payload; response.settled = true; return response; },
        on(event, listener) { (listeners[event] ??= []).push(listener); return response; },
        emit(event) { for (const listener of listeners[event] ?? []) listener(); },
    };
    return response;
};

type Handler = (req: unknown, res: unknown, next: (error?: unknown) => void) => unknown;

const invoke = async (
    handler: Handler,
    request: { method?: string; url: string; headers?: Record<string, string>; body?: unknown; query?: Record<string, string> },
): Promise<FakeResponse> => {
    const response = makeResponse();
    const req = {
        method: request.method ?? 'GET',
        url: request.url,
        originalUrl: request.url,
        baseUrl: '',
        headers: request.headers ?? {},
        body: request.body ?? {},
        query: request.query ?? {},
        ip: '127.0.0.1',
        socket: { remoteAddress: '127.0.0.1' },
    };
    await (handler as unknown as (r: unknown, s: unknown, n: () => void) => Promise<void>)(req, response, () => {});
    const deadline = Date.now() + 5000;
    while (!response.settled && Date.now() < deadline) {
        await new Promise((resolve) => setImmediate(resolve));
    }
    return response;
};

/* -------------------------------------------------------------------------- */
/* Request/tenant context                                                      */
/* -------------------------------------------------------------------------- */

test('request-context: generates a safe id when none is supplied and echoes it', () => {
    const middleware = createRequestContextMiddleware({ generate: () => 'generated-id-000000001' });
    for (const headers of [{}, { 'x-request-id': '' }, { 'x-request-id': 'bad id' }, { 'x-request-id': '<script>' }]) {
        const req: Record<string, unknown> = { headers };
        const res = makeResponse();
        let continued = false;
        middleware(req as unknown as Request, res as unknown as Response, () => { continued = true; });
        assert.equal(continued, true);
        assert.equal(req.requestId, 'generated-id-000000001');
        assert.equal(res.headers['x-request-id'], 'generated-id-000000001');
        assert.match(String(req.requestId), REQUEST_ID_PATTERN);
    }
});

test('request-context: accepts a strictly safe incoming id and rejects anything else', () => {
    assert.equal(normalizeIncomingRequestId('trace-abcdef123456'), 'trace-abcdef123456');
    assert.equal(normalizeIncomingRequestId('a'.repeat(128)), 'a'.repeat(128));
    for (const unsafe of ['a', 'short', 'has space', 'semi;colon', 'comma,value', 'quote"x', '<x>', 'a'.repeat(129), 42, null, undefined, {}]) {
        assert.equal(normalizeIncomingRequestId(unsafe), null, `must reject ${String(unsafe)}`);
    }

    const middleware = createRequestContextMiddleware({ generate: () => 'fallback-generated-id' });
    const safe = makeResponse();
    const safeReq: Record<string, unknown> = { headers: { 'x-request-id': 'trace-abcdef123456' } };
    middleware(safeReq as unknown as Request, safe as unknown as Response, () => {});
    assert.equal(safeReq.requestId, 'trace-abcdef123456');
    assert.equal(safe.headers['x-request-id'], 'trace-abcdef123456');

    const unsafeRes = makeResponse();
    const unsafeReq: Record<string, unknown> = { headers: { 'x-request-id': 'nope nope' } };
    middleware(unsafeReq as unknown as Request, unsafeRes as unknown as Response, () => {});
    assert.equal(unsafeReq.requestId, 'fallback-generated-id');
    assert.notEqual(unsafeRes.headers['x-request-id'], 'nope nope');
});

test('request-context: a generated id is a UUID that matches the strict pattern', () => {
    const middleware = createRequestContextMiddleware();
    const first = makeResponse();
    const firstReq: Record<string, unknown> = { headers: {} };
    middleware(firstReq as unknown as Request, first as unknown as Response, () => {});
    const second = makeResponse();
    const secondReq: Record<string, unknown> = { headers: {} };
    middleware(secondReq as unknown as Request, second as unknown as Response, () => {});
    assert.match(String(firstReq.requestId), REQUEST_ID_PATTERN);
    assert.notEqual(firstReq.requestId, secondReq.requestId);
});

test('request-context: tenant id comes only from the verified principal', () => {
    const middleware = createRequestContextMiddleware({ generate: () => 'ctx-id-000000001' });
    const res = makeResponse();
    const req: Record<string, unknown> = {
        headers: { 'x-tenant-id': 'tenant-evil', 'x-request-id': 'ctx-id-000000001' },
        user: { tenantId: 'tenant-a' },
    };
    middleware(req as unknown as Request, res as unknown as Response, () => {});
    assert.equal(resolveVerifiedTenantId(req as unknown as Request), 'tenant-a');
    assert.equal(getRequestContext(req as unknown as Request).tenantId, 'tenant-a');

    const anonReq: Record<string, unknown> = { headers: { 'x-tenant-id': 'tenant-evil' } };
    assert.equal(getRequestContext(anonReq as unknown as Request).tenantId, null);
    assert.equal(resolveVerifiedTenantId(anonReq as unknown as Request), null);

    // The context getter reflects an authenticated principal even when the
    // middleware ran before authentication.
    assert.equal(getRequestId(req as unknown as Request), 'ctx-id-000000001');
});

test('request-context: re-applying the middleware preserves the existing id', () => {
    const middleware = createRequestContextMiddleware({ generate: () => 'first-id-0000001' });
    const res = makeResponse();
    const req: Record<string, unknown> = { headers: { 'x-request-id': 'incoming-safe-id' } };
    middleware(req as unknown as Request, res as unknown as Response, () => {});
    const again = createRequestContextMiddleware({ generate: () => 'second-id-000000' });
    again(req as unknown as Request, res as unknown as Response, () => {});
    assert.equal(req.requestId, 'incoming-safe-id');
    assert.equal(res.headers['x-request-id'], 'incoming-safe-id');
});

/* -------------------------------------------------------------------------- */
/* Logger + redaction                                                          */
/* -------------------------------------------------------------------------- */

test('logger: masks emails and phones', () => {
    assert.equal(maskEmail('user@example.com'), 'u***@example.com');
    assert.equal(maskEmail('not-an-email'), REDACTED);
    assert.equal(maskPhone('+1 (555) 123-4567'), '***4567');
    assert.equal(maskPhone('12'), REDACTED);
});

test('logger: key-based secret detection avoids short-token false positives', () => {
    for (const key of ['password', 'passwordHash', 'passphrase', 'access_token', 'refreshToken', 'Authorization', 'cookie', 'set-cookie', 'api_key', 'apiKey', 'clientSecret', 'private_key', 'signingKey', 'otpCode', 'user_pin', 'cvv', 'card_number', 'session_id', 'bearer']) {
        assert.equal(isSensitiveKey(key), true, `${key} must be sensitive`);
    }
    for (const key of ['monkey', 'shipping', 'ping', 'spin', 'hotel', 'request_id', 'x-request-id', 'note', 'route']) {
        assert.equal(isSensitiveKey(key), false, `${key} must not be sensitive`);
    }
});

test('logger: redacts secrets, masks PII, walks nested objects and breaks cycles', () => {
    const cyclic: Record<string, unknown> = { token: 'super-secret-token' };
    cyclic.self = cyclic;
    const redacted = redactValue({
        password: 'hunter2',
        Authorization: 'Bearer abc.def.ghi',
        headers: { cookie: 'sid=1', 'x-request-id': 'trace-abcdef123456' },
        profile: { email: 'user@example.com', phone: '+15551234567', contact: 'other@example.com', nested: { private_key: 'pem' } },
        cycle: cyclic,
        safe: 'visible',
    }) as Record<string, unknown>;

    assert.equal(redacted.password, REDACTED);
    assert.equal(redacted.Authorization, REDACTED);
    assert.deepEqual(redacted.headers, { cookie: REDACTED, 'x-request-id': 'trace-abcdef123456' });
    const profile = redacted.profile as Record<string, unknown>;
    assert.equal(profile.email, 'u***@example.com');
    assert.equal(profile.phone, '***4567');
    assert.equal(profile.contact, 'o***@example.com');
    assert.deepEqual(profile.nested, { private_key: REDACTED });
    assert.equal((redacted.cycle as Record<string, unknown>).token, REDACTED);
    assert.equal((redacted.cycle as Record<string, unknown>).self, CIRCULAR);
    assert.equal(redacted.safe, 'visible');
    assert.ok(!JSON.stringify(redacted).includes('hunter2'));
    assert.ok(!JSON.stringify(redacted).includes('super-secret-token'));
});

test('logger: bounds depth, array length and string length', () => {
    const deep = { a: { b: { c: { d: { e: { f: { g: { h: 'too deep' } } } } } } } };
    assert.ok(JSON.stringify(redactValue(deep)).includes(MAX_DEPTH_MARKER));

    const array = redactValue({ items: Array.from({ length: 120 }, (_, index) => index) }, { maxArrayLength: 10 }) as { items: unknown[] };
    assert.equal(array.items.length, 11);
    assert.equal(array.items[10], '[+110 more]');

    const long = redactValue({ note: 'x'.repeat(50) }, { maxStringLength: 10 }) as { note: string };
    assert.equal(long.note, `${'x'.repeat(10)}…`);
});

test('logger: emits one JSON line with redacted fields and respects the level threshold', () => {
    const lines: string[] = [];
    const logger = createLogger({
        level: 'info',
        now: () => new Date('2026-10-19T10:00:00.000Z'),
        write: (line) => lines.push(line),
    });
    logger.debug('ignored', { should: 'not appear' });
    logger.info('hello', { password: 'p', phone: '+15551234567', request_id: 'r-1' });

    assert.equal(lines.length, 1);
    const record = JSON.parse(lines[0]) as Record<string, unknown>;
    assert.equal(record.time, '2026-10-19T10:00:00.000Z');
    assert.equal(record.level, 'info');
    assert.equal(record.message, 'hello');
    assert.equal(record.password, REDACTED);
    assert.equal(record.request_id, 'r-1');
    assert.equal((record.phone as string).startsWith('***'), true);
    assert.ok(!lines[0].includes('"password":"p"'));
});

test('logger: child bindings are merged and truncates oversized records', () => {
    const lines: string[] = [];
    const logger = createLogger({
        now: () => new Date('2026-10-19T10:00:00.000Z'),
        write: (line) => lines.push(line),
        maxBytes: 200,
    });
    logger.child({ request_id: 'r-1', tenant_id: 'tenant-a' }).warn('big', { blob: 'y'.repeat(1000) });
    const record = JSON.parse(lines[0]) as Record<string, unknown>;
    assert.equal(record.truncated, true);
    assert.equal(typeof record.preview, 'string');
    assert.equal(record.request_id, 'r-1');
    assert.ok((record.preview as string).length <= 200);
});

/* -------------------------------------------------------------------------- */
/* Metrics registry                                                            */
/* -------------------------------------------------------------------------- */

test('metrics: renders counters, histograms and gauges in Prometheus format', () => {
    const registry = createMetricsRegistry();
    const counter = registry.counter('jobs_processed_total', 'Jobs processed.', ['queue']);
    counter.inc({ queue: 'video' });
    counter.inc({ queue: 'video' }, 2);
    registry.counter('jobs_processed_total', 'Jobs processed.', ['queue']);

    const histogram = registry.histogram('job_duration_seconds', 'Job duration.', ['queue']);
    histogram.observe({ queue: 'video' }, 0.0123);

    const gauge = registry.gauge('workers_active', 'Active workers.', ['pool']);
    gauge.set({ pool: 'video' }, 4);
    gauge.dec({ pool: 'video' }, 1);

    const output = registry.render();
    assert.ok(output.includes('# TYPE jobs_processed_total counter'));
    assert.ok(output.includes('jobs_processed_total{queue="video"} 3'));
    assert.ok(output.includes('# TYPE job_duration_seconds histogram'));
    assert.ok(output.includes('job_duration_seconds_bucket{le="0.025",queue="video"} 1'));
    assert.ok(output.includes('job_duration_seconds_bucket{le="+Inf",queue="video"} 1'));
    assert.ok(output.includes('job_duration_seconds_sum{queue="video"} 0.0123'));
    assert.ok(output.includes('job_duration_seconds_count{queue="video"} 1'));
    assert.ok(output.includes('# TYPE workers_active gauge'));
    assert.ok(output.includes('workers_active{pool="video"} 3'));
});

test('metrics: gauge sources are sampled at render time', () => {
    const registry = createMetricsRegistry();
    let value = 7;
    registry.registerGaugeSource({
        name: 'queue_lag_seconds',
        help: 'Oldest pending job age in seconds.',
        collect: () => [{ labels: { queue: 'video' }, value }, { labels: { queue: 'video' }, value: Number.NaN }],
    });
    assert.ok(registry.render().includes('queue_lag_seconds{queue="video"} 7'));
    value = 11;
    const output = registry.render();
    assert.ok(output.includes('queue_lag_seconds{queue="video"} 11'));
    assert.ok(!output.includes('queue_lag_seconds{queue="video"} NaN'));
    assert.equal(output.split('queue_lag_seconds{queue="video"}').length - 1, 1);
});

test('metrics: rejects invalid names, unexpected labels and conflicting types', () => {
    const registry = createMetricsRegistry();
    assert.throws(() => registry.counter('bad name', 'nope'), /Invalid metric name/);
    assert.throws(() => registry.counter('ok_metric', 'help', ['bad-label']), /Invalid label name/);
    const counter = registry.counter('scoped_total', 'help', ['route']);
    assert.throws(() => counter.inc({ other: 'x' }), /Unexpected label/);
    assert.throws(() => counter.inc({}), /Missing label/);
    assert.throws(() => registry.gauge('scoped_total', 'help', ['route']), /already defined as counter/);
    assert.throws(() => registry.counter('scoped_total', 'help', ['other']), /different labels/);
});

test('metrics: http observer dimensions by route template and status class', () => {
    const registry = createMetricsRegistry();
    const observer = createHttpObserver(registry, { buckets: DEFAULT_DURATION_BUCKETS });
    observer.observe({ method: 'GET', route: '/api/widgets', status: 200, durationMs: 12.3 });
    observer.observe({ method: 'POST', route: '/api/widgets', status: 500, durationMs: 50 });
    observer.observe({ method: 'GET', route: '/api/widgets', status: 404, durationMs: 5 });

    const output = registry.render();
    assert.ok(output.includes('http_requests_total{method="GET",route="/api/widgets",status_class="2xx"} 1'));
    assert.ok(output.includes('http_requests_total{method="POST",route="/api/widgets",status_class="5xx"} 1'));
    assert.ok(output.includes('http_requests_total{method="GET",route="/api/widgets",status_class="4xx"} 1'));
    assert.ok(output.includes('http_request_duration_seconds_count{method="GET",route="/api/widgets",status_class="2xx"} 1'));
});

test('metrics: statusClass maps codes and unknown values', () => {
    assert.equal(statusClass(200), '2xx');
    assert.equal(statusClass(404), '4xx');
    assert.equal(statusClass(503), '5xx');
    assert.equal(statusClass(0), 'unknown');
    assert.equal(statusClass(1000), 'unknown');
    assert.equal(statusClass(Number.NaN), 'unknown');
});

/* -------------------------------------------------------------------------- */
/* Observability middleware                                                    */
/* -------------------------------------------------------------------------- */

test('observability middleware: records one metric sample and a redacted access log', () => {
    const registry = createMetricsRegistry();
    const lines: string[] = [];
    const logger = createLogger({ level: 'debug', now: () => new Date('2026-10-19T10:00:00.000Z'), write: (line) => lines.push(line) });
    let clock = 1000;
    const middleware = createObservabilityMiddleware({ logger, metrics: registry, now: () => clock });

    const res = makeResponse();
    const req = {
        method: 'GET',
        url: '/api/widgets/42',
        originalUrl: '/api/widgets/42',
        baseUrl: '',
        route: { path: '/api/widgets/:id' },
        headers: { 'x-request-id': 'trace-abcdef123456', authorization: 'Bearer should-not-log' },
        user: { tenantId: 'tenant-a' },
        socket: { remoteAddress: '127.0.0.1' },
    };
    const next = (): void => {};
    middleware(req as unknown as Request, res as unknown as Response, next);
    // Re-application on the same request must not double-record.
    middleware(req as unknown as Request, res as unknown as Response, next);

    clock = 1035;
    res.statusCode = 200;
    res.emit('finish');

    const output = registry.render();
    assert.ok(output.includes('http_requests_total{method="GET",route="/api/widgets/:id",status_class="2xx"} 1'));
    assert.equal(output.split('route="/api/widgets/:id"').length - 1 >= 1, true);
    // Exactly one counter sample for the series.
    assert.equal(output.split('http_requests_total{method="GET",route="/api/widgets/:id",status_class="2xx"} 1').length, 2);

    assert.equal(lines.length, 1);
    const record = JSON.parse(lines[0]) as Record<string, unknown>;
    assert.equal(record.message, 'http_request');
    assert.equal(record.level, 'info');
    assert.equal(record.request_id, 'trace-abcdef123456');
    assert.equal(record.tenant_id, 'tenant-a');
    assert.equal(record.route, '/api/widgets/:id');
    assert.equal(record.status, 200);
    assert.equal(record.duration_ms, 35);
    assert.ok(!lines[0].includes('should-not-log'));
});

test('observability middleware: unmatched routes collapse to a single label and 5xx logs at error', () => {
    const registry = createMetricsRegistry();
    const lines: string[] = [];
    const logger = createLogger({ now: () => new Date('2026-10-19T10:00:00.000Z'), write: (line) => lines.push(line) });
    const middleware = createObservabilityMiddleware({ logger, metrics: registry, now: () => 0, routeResolver: () => '' });
    const res = makeResponse();
    const req = { method: 'GET', url: '/nope/1', originalUrl: '/nope/1', headers: {}, socket: {} };
    middleware(req as unknown as Request, res as unknown as Response, () => {});
    res.statusCode = 503;
    res.emit('finish');
    assert.ok(registry.render().includes('http_requests_total{method="GET",route="unmatched",status_class="5xx"} 1'));
    assert.equal((JSON.parse(lines[0]) as Record<string, unknown>).level, 'error');
});

test('observability middleware: defaultRouteTemplate prefers the route pattern', () => {
    assert.equal(defaultRouteTemplate({ baseUrl: '/api', route: { path: '/widgets' } } as unknown as Request), '/api/widgets');
    assert.equal(defaultRouteTemplate({ baseUrl: '/api', route: { path: '/' } } as unknown as Request), '/api');
    assert.equal(defaultRouteTemplate({ baseUrl: '', route: { path: '/' } } as unknown as Request), '/');
    assert.equal(defaultRouteTemplate({ baseUrl: '', method: 'GET' } as unknown as Request), 'unmatched');
});

/* -------------------------------------------------------------------------- */
/* Ops router: /metrics, /healthz, /readyz                                     */
/* -------------------------------------------------------------------------- */

const VALID_TOKEN = 'm'.repeat(METRICS_TOKEN_MIN_BYTES);

const makeOpsDeps = (overrides: Partial<ObservabilityDeps> = {}): { deps: ObservabilityDeps; lines: string[] } => {
    const lines: string[] = [];
    const deps: ObservabilityDeps = {
        logger: createLogger({ now: () => new Date('2026-10-19T10:00:00.000Z'), write: (line) => lines.push(line) }),
        metrics: createMetricsRegistry(),
        metricsToken: VALID_TOKEN,
        ...overrides,
    };
    return { deps, lines };
};

test('ops: healthz is pure liveness and never runs dependency checks', async () => {
    let readinessCalls = 0;
    const { deps } = makeOpsDeps({
        liveness: () => true,
        readiness: [{ name: 'database', check: async () => { readinessCalls += 1; return true; } }],
    });
    const router = createOpsRouter(deps);
    const ok = await invoke(router as unknown as Handler, { url: '/healthz' });
    assert.equal(ok.statusCode, 200);
    assert.deepEqual(ok.body, { status: 'ok' });
    assert.equal(readinessCalls, 0);

    const down = createOpsRouter(makeOpsDeps({ liveness: () => false }).deps);
    const unavailable = await invoke(down as unknown as Handler, { url: '/healthz' });
    assert.equal(unavailable.statusCode, 503);
    assert.deepEqual(unavailable.body, { status: 'unavailable' });
});

test('ops: readyz returns a generic verdict with no dependency detail', async () => {
    const ready = createOpsRouter(makeOpsDeps({
        readiness: [{ name: 'database', check: async () => true }, { name: 'queue', check: () => true }],
    }).deps);
    const readyResponse = await invoke(ready as unknown as Handler, { url: '/readyz' });
    assert.equal(readyResponse.statusCode, 200);
    assert.deepEqual(readyResponse.body, { status: 'ready' });

    const notReady = createOpsRouter(makeOpsDeps({
        readiness: [
            { name: 'database', check: async () => false },
            { name: 'queue', check: () => { throw new Error('queue connection refused'); } },
        ],
    }).deps);
    const notReadyResponse = await invoke(notReady as unknown as Handler, { url: '/readyz' });
    assert.equal(notReadyResponse.statusCode, 503);
    assert.deepEqual(notReadyResponse.body, { status: 'not_ready' });
    assert.ok(!JSON.stringify(notReadyResponse.body).includes('queue'));
    assert.ok(!JSON.stringify(notReadyResponse.body).includes('database'));
});

test('ops: metrics denies a missing, malformed or wrong bearer and fails closed when unconfigured', async () => {
    const missing = createOpsRouter(makeOpsDeps().deps);
    assert.equal((await invoke(missing as unknown as Handler, { url: '/metrics' })).statusCode, 401);

    const malformed = createOpsRouter(makeOpsDeps().deps);
    assert.equal((await invoke(malformed as unknown as Handler, { url: '/metrics', headers: { authorization: 'Basic abc' } })).statusCode, 401);

    const wrong = createOpsRouter(makeOpsDeps().deps);
    assert.equal((await invoke(wrong as unknown as Handler, { url: '/metrics', headers: { authorization: 'Bearer wrong-token' } })).statusCode, 401);

    const unconfigured = createOpsRouter(makeOpsDeps({ metricsToken: undefined }).deps);
    assert.equal((await invoke(unconfigured as unknown as Handler, { url: '/metrics', headers: { authorization: `Bearer ${VALID_TOKEN}` } })).statusCode, 503);

    const tooShort = createOpsRouter(makeOpsDeps({ metricsToken: 'short-token' }).deps);
    assert.equal((await invoke(tooShort as unknown as Handler, { url: '/metrics', headers: { authorization: 'Bearer short-token' } })).statusCode, 503);
});

test('ops: metrics serves Prometheus text with a valid dedicated bearer', async () => {
    const { deps } = makeOpsDeps();
    deps.metrics.counter('ops_checks_total', 'Checks run.').inc();
    const router = createOpsRouter(deps);
    const response = await invoke(router as unknown as Handler, {
        url: '/metrics',
        headers: { authorization: `Bearer ${VALID_TOKEN}` },
    });
    assert.equal(response.statusCode, 200);
    assert.match(response.headers['content-type'], /text\/plain; version=0\.0\.4/);
    assert.equal(response.headers['cache-control'], 'no-store');
    assert.ok(String(response.body).includes('ops_checks_total 1'));
});

test('ops: authorizeMetricsRequest and constantTimeEqual fail closed', () => {
    assert.deepEqual(authorizeMetricsRequest(undefined, undefined), { ok: false, status: 503 });
    assert.deepEqual(authorizeMetricsRequest('Bearer x', 'short'), { ok: false, status: 503 });
    assert.deepEqual(authorizeMetricsRequest(undefined, VALID_TOKEN), { ok: false, status: 401 });
    assert.deepEqual(authorizeMetricsRequest('Bearer wrong', VALID_TOKEN), { ok: false, status: 401 });
    assert.deepEqual(authorizeMetricsRequest(`Bearer ${VALID_TOKEN}`, VALID_TOKEN), { ok: true, status: 200 });

    assert.equal(constantTimeEqual('abc', 'abc'), true);
    assert.equal(constantTimeEqual('abc', 'abd'), false);
    assert.equal(constantTimeEqual('abc', 'abcdef'), false);
});

/* -------------------------------------------------------------------------- */
/* mountObservability wiring                                                   */
/* -------------------------------------------------------------------------- */

test('mountObservability: attaches context, observability and the ops router', async () => {
    const handlers: unknown[] = [];
    const app = {
        use: (...args: unknown[]) => { handlers.push(args[0]); return app; },
    };
    const { deps } = makeOpsDeps({ readiness: [{ name: 'database', check: () => true }] });
    mountObservability(app as unknown as Application, deps);

    assert.equal(handlers.length, 3);
    for (const handler of handlers) assert.equal(typeof handler, 'function');

    // The first handler is the request-context middleware and sets the header.
    const contextRes = makeResponse();
    const contextReq: Record<string, unknown> = { headers: { 'x-request-id': 'trace-abcdef123456' } };
    (handlers[0] as Handler)(contextReq, contextRes, () => {});
    assert.equal(contextRes.headers['x-request-id'], 'trace-abcdef123456');

    // The last handler is the ops router.
    const opsRes = await invoke(handlers[2] as Handler, { url: '/healthz' });
    assert.equal(opsRes.statusCode, 200);
    assert.deepEqual(opsRes.body, { status: 'ok' });
});

/* -------------------------------------------------------------------------- */
/* W7 hardening: bounded probes, explicit readiness, bounded labels,          */
/* Error depth/cycle handling and no-store denials.                           */
/* -------------------------------------------------------------------------- */

/** Count of live timer handles, used to prove a probe clears its timeout. */
const activeTimeoutCount = (): number =>
    process.getActiveResourcesInfo().filter((resource) => resource === 'Timeout').length;

test('ops: a dependency check that never resolves is cut off and reports not_ready', async () => {
    let checks = 0;
    const { deps } = makeOpsDeps({
        readiness: [{
            name: 'database',
            check: () => { checks += 1; return new Promise<boolean>(() => { /* never settles */ }); },
        }],
        checkTimeoutMs: 40,
        readinessBudgetMs: 500,
    });
    const started = Date.now();
    const response = await invoke(createOpsRouter(deps) as unknown as Handler, { url: '/readyz' });
    const elapsed = Date.now() - started;

    assert.equal(checks, 1, 'the check is started once');
    assert.equal(response.statusCode, 503);
    assert.deepEqual(response.body, { status: 'not_ready' });
    assert.ok(elapsed < 1000, `a hung dependency must not hang the probe (took ${elapsed}ms)`);
});

test('ops: a resolved check clears its timeout handle (no leaked timer)', async () => {
    const before = activeTimeoutCount();
    const { deps } = makeOpsDeps({
        readiness: [{ name: 'database', check: async () => true }],
        checkTimeoutMs: 60_000,
    });
    const response = await invoke(createOpsRouter(deps) as unknown as Handler, { url: '/readyz' });

    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.body, { status: 'ready' });
    assert.equal(activeTimeoutCount(), before, 'the probe must clear its timeout handle');
});

test('ops: liveness that never resolves is bounded and reports unavailable', async () => {
    const { deps } = makeOpsDeps({
        liveness: () => new Promise<boolean>(() => { /* never settles */ }),
        checkTimeoutMs: 40,
    });
    const started = Date.now();
    const response = await invoke(createOpsRouter(deps) as unknown as Handler, { url: '/healthz' });
    const elapsed = Date.now() - started;

    assert.equal(response.statusCode, 503);
    assert.deepEqual(response.body, { status: 'unavailable' });
    assert.ok(elapsed < 1000, `liveness must be bounded (took ${elapsed}ms)`);
});

test('ops: empty readiness is not_ready unless the operator opts in explicitly', async () => {
    const explicitEmpty = createOpsRouter(makeOpsDeps({ readiness: [] }).deps);
    const emptyResponse = await invoke(explicitEmpty as unknown as Handler, { url: '/readyz' });
    assert.equal(emptyResponse.statusCode, 503, 'zero checks is not evidence of readiness');
    assert.deepEqual(emptyResponse.body, { status: 'not_ready' });

    const absent = createOpsRouter(makeOpsDeps().deps);
    const absentResponse = await invoke(absent as unknown as Handler, { url: '/readyz' });
    assert.equal(absentResponse.statusCode, 503, 'an unwired deployment must not look ready');
    assert.deepEqual(absentResponse.body, { status: 'not_ready' });

    const optedIn = createOpsRouter(makeOpsDeps({ readiness: [], readinessOptIn: true }).deps);
    const optedInResponse = await invoke(optedIn as unknown as Handler, { url: '/readyz' });
    assert.equal(optedInResponse.statusCode, 200);
    assert.deepEqual(optedInResponse.body, { status: 'ready' });

    const optedInWithCheck = createOpsRouter(makeOpsDeps({
        readiness: [{ name: 'database', check: () => false }],
        readinessOptIn: true,
    }).deps);
    const failingResponse = await invoke(optedInWithCheck as unknown as Handler, { url: '/readyz' });
    assert.equal(failingResponse.statusCode, 503, 'opt-in never overrides a failing check');
});

test('ops: /healthz stays live while a readiness dependency fails or hangs', async () => {
    let checks = 0;
    const { deps } = makeOpsDeps({
        readiness: [{
            name: 'database',
            check: () => { checks += 1; throw new Error('database down'); },
        }],
        checkTimeoutMs: 40,
    });
    const router = createOpsRouter(deps);

    const health = await invoke(router as unknown as Handler, { url: '/healthz' });
    assert.equal(health.statusCode, 200, 'liveness is independent of dependency readiness');
    assert.deepEqual(health.body, { status: 'ok' });
    assert.equal(checks, 0, 'liveness must never run a dependency check');

    const ready = await invoke(router as unknown as Handler, { url: '/readyz' });
    assert.equal(ready.statusCode, 503);
    assert.deepEqual(ready.body, { status: 'not_ready' });
    assert.equal(checks, 1);

    const hungDeps = makeOpsDeps({
        readiness: [{ name: 'queue', check: () => new Promise<boolean>(() => { /* never settles */ }) }],
        checkTimeoutMs: 40,
    }).deps;
    const hungRouter = createOpsRouter(hungDeps);
    assert.equal((await invoke(hungRouter as unknown as Handler, { url: '/healthz' })).statusCode, 200);
    assert.equal((await invoke(hungRouter as unknown as Handler, { url: '/readyz' })).statusCode, 503);
});

test('metrics: unknown HTTP methods collapse into one bounded fallback bucket', () => {
    assert.equal(boundedHttpMethod('GET'), 'GET');
    assert.equal(boundedHttpMethod('get'), 'GET');
    assert.equal(boundedHttpMethod('PATCH'), 'PATCH');
    assert.equal(boundedHttpMethod('FROBNICATE-abc'), HTTP_METHOD_FALLBACK);
    assert.equal(boundedHttpMethod(''), HTTP_METHOD_FALLBACK);
    assert.equal(boundedHttpMethod(undefined), HTTP_METHOD_FALLBACK);
    assert.equal(boundedHttpMethod(42), HTTP_METHOD_FALLBACK);
    assert.equal(boundedHttpMethod({ method: 'GET' }), HTTP_METHOD_FALLBACK);

    const registry = createMetricsRegistry();
    const observer = createHttpObserver(registry);
    observer.observe({ method: 'GET', route: '/api/widgets', status: 200, durationMs: 1 });
    observer.observe({ method: 'get', route: '/api/widgets', status: 200, durationMs: 1 });
    observer.observe({ method: 'FROBNICATE-abc', route: '/api/widgets', status: 200, durationMs: 1 });
    observer.observe({ method: 'zzz-1', route: '/api/widgets', status: 200, durationMs: 1 });
    observer.observe({ method: 'zzz-2', route: '/api/widgets', status: 200, durationMs: 1 });

    const output = registry.render();
    const series = output.split('\n').filter((line) => line.startsWith('http_requests_total{'));
    assert.equal(series.length, 2, 'arbitrary verbs must not create new series');
    assert.ok(output.includes('http_requests_total{method="GET",route="/api/widgets",status_class="2xx"} 2'));
    assert.ok(output.includes(`http_requests_total{method="${HTTP_METHOD_FALLBACK}",route="/api/widgets",status_class="2xx"} 3`));
});

test('logger: a cyclic Error is logged without throwing and without expanding', () => {
    const error = new Error('boom');
    Object.assign(error, { cause: error, code: 'E_BOOM' });
    const lines: string[] = [];
    const logger = createLogger({
        level: 'debug',
        now: () => new Date('2026-10-19T10:00:00.000Z'),
        write: (line) => lines.push(line),
    });

    logger.error('failed', { error });

    assert.equal(lines.length, 1);
    const record = JSON.parse(lines[0]) as Record<string, unknown>;
    const logged = record.error as Record<string, unknown>;
    assert.equal(logged.name, 'Error');
    assert.equal(logged.message, 'boom');
    assert.equal(logged.cause, CIRCULAR);
    assert.equal(logged.code, 'E_BOOM');
    assert.ok(!lines[0].includes('[object Object]'));
});

test('logger: an Error past maxDepth is bounded and its cause chain is cut', () => {
    let error = new Error('leaf');
    for (let index = 0; index < 20; index += 1) {
        error = Object.assign(new Error(`level-${index}`), { cause: error });
    }

    const redacted = redactValue({ error }, { maxDepth: 4 }) as { error: Record<string, unknown> };
    const serialized = JSON.stringify(redacted);
    assert.ok(serialized.includes(MAX_DEPTH_MARKER), 'the depth bound must apply to Error values');
    assert.ok(serialized.length < 4096, `Error serialization must stay bounded (got ${serialized.length} bytes)`);

    assert.equal(redactValue(new Error('root'), { maxDepth: 0 }), MAX_DEPTH_MARKER);

    const lines: string[] = [];
    createLogger({
        level: 'debug',
        now: () => new Date('2026-10-19T10:00:00.000Z'),
        write: (line) => lines.push(line),
    }).error('deep failure', { error });
    assert.equal(lines.length, 1);
    assert.ok(lines[0].includes(MAX_DEPTH_MARKER));
    assert.ok(lines[0].length < 4096, `log line must stay bounded (got ${lines[0].length} bytes)`);
});

test('ops: metrics denials carry no-store', async () => {
    const missing = await invoke(createOpsRouter(makeOpsDeps().deps) as unknown as Handler, { url: '/metrics' });
    assert.equal(missing.statusCode, 401);
    assert.equal(missing.headers['cache-control'], 'no-store');

    const malformed = await invoke(
        createOpsRouter(makeOpsDeps().deps) as unknown as Handler,
        { url: '/metrics', headers: { authorization: 'Basic abc' } },
    );
    assert.equal(malformed.statusCode, 401);
    assert.equal(malformed.headers['cache-control'], 'no-store');

    const wrong = await invoke(
        createOpsRouter(makeOpsDeps().deps) as unknown as Handler,
        { url: '/metrics', headers: { authorization: 'Bearer wrong-token' } },
    );
    assert.equal(wrong.statusCode, 401);
    assert.equal(wrong.headers['cache-control'], 'no-store');

    const unconfigured = await invoke(
        createOpsRouter(makeOpsDeps({ metricsToken: undefined }).deps) as unknown as Handler,
        { url: '/metrics' },
    );
    assert.equal(unconfigured.statusCode, 503);
    assert.equal(unconfigured.headers['cache-control'], 'no-store');
    assert.deepEqual(unconfigured.body, { error: 'Metrics endpoint is not configured' });
});
