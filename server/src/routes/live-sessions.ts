import { RequestHandler, Response, Router } from 'express';
import type { AuthRequest } from '../middleware/auth';
import type {
    JoinDenialReason,
    LiveSessionCore,
    LiveSessionRecord,
    ProviderCallbackInput,
    ProviderCallbackResult,
} from '../services/live-session-core';

/**
 * W10-R1 — HTTP surface for the provider-neutral live session core.
 *
 * Authorization is deny-by-default and derived from the verified principal:
 *
 *  - the tenant is `req.user.tenantId` (server-derived), never a body value, so
 *    a caller cannot address another tenant's session by guessing an id;
 *  - the host is the authenticated principal id; a body `hostUserId` is never
 *    read, so a session cannot be created on someone else's behalf;
 *  - `POST /:id/start|end|cancel` are host-only (the core re-checks the host
 *    from the session row, so the route cannot widen it);
 *  - `POST /:id/join` issues a signed, tenant+session+user+role-bound ticket;
 *    a caller who already holds a ticket may present it, and a mismatched one
 *    is refused by the core;
 *  - `GET /:id/attendance` is host-only: presence is participant data, not a
 *    public figure;
 *  - `POST /callbacks/:provider` is NOT authenticated by a bearer token: the
 *    provider cannot hold one. The core verifies the signature through the
 *    injected verifier before reading a single field, and the tenant comes from
 *    the session row.
 *
 * ONE COMPOSITION CONTRACT — `createLiveRuntime(...)` in
 * `services/live-runtime-factory.ts` is the single supported entry point, and it
 * is what actually consumes BOTH of this lane's runtimes: it builds this router
 * over its own core (`:1067-1069`) and it drives the bounded recovery pass
 * (`:1388-1392`). A caller therefore never assembles a core, a store or a
 * router by hand; it constructs the runtime once and mounts `runtime.router`.
 *
 * This builder is the INTERNAL seam that runtime uses. It is exported because
 * the factory lives in `services/` and imports it, NOT because it is a second
 * composition path: constructing it from a hand-built `core` produces a router
 * with no `readiness()`, no `beginShutdown()` and no schema-report provenance,
 * so such a mount is unsupported by contract even though the type allows it.
 *
 * What is still missing is only the CALLER. `server/src/index.ts` does not
 * import the factory at all, so no live route is mounted today; that file is
 * Codex's, and the exact mount is reported as an integration request rather
 * than written from this lane. Lifecycle ordering the caller must follow:
 * verify → construct → mount → loop, and on the way out
 * stop-new-work (`beginShutdown`) → drain → release → close.
 */

export interface LiveSessionsRouterDeps {
    core: LiveSessionCore;
    optionalAuthenticate: RequestHandler;
}

const STATUS_BY_DENIAL: Record<JoinDenialReason, number> = {
    'invalid-input': 400,
    'session-not-found': 404,
    'tenant-mismatch': 403,
    'session-not-live': 409,
    'session-ended': 409,
    'role-not-allowed': 403,
    'session-full': 409,
    'ticket-invalid': 403,
    'signing-unconfigured': 503,
    // No store unit means no write happened; the caller may retry later.
    'transaction-required': 503,
};

const STATUS_BY_CALLBACK: Record<ProviderCallbackResult['status'], number> = {
    applied: 200,
    duplicate: 200,
    ignored: 202,
    rejected: 403,
};

const readBody = (req: AuthRequest): Record<string, unknown> =>
    (req.body ?? {}) as Record<string, unknown>;

const publicSession = (session: LiveSessionRecord): Record<string, unknown> => ({
    id: session.id,
    title: session.title,
    state: session.state,
    host_user_id: session.hostUserId,
    provider: session.provider,
    starts_at_ms: session.startsAtMs,
    ended_at_ms: session.endedAtMs,
    max_participants: session.maxParticipants,
});

export const createLiveSessionsRouter = (deps: LiveSessionsRouterDeps): Router => {
    const router = Router();
    const core = deps.core;
    router.use(deps.optionalAuthenticate);

    const requireTenant = (req: AuthRequest, res: Response): { userId: string; tenantId: string } | null => {
        const user = req.user;
        if (!user) {
            res.status(401).json({ error: 'Authentication required' });
            return null;
        }
        if (typeof user.tenantId !== 'string' || !user.tenantId) {
            // No verified tenant scope means no live-session authority at all.
            res.status(403).json({ error: 'Tenant scope required' });
            return null;
        }
        return { userId: user.id, tenantId: user.tenantId };
    };

    const isHost = (session: LiveSessionRecord, userId: string): boolean => session.hostUserId === userId;

    router.post('/', async (req: AuthRequest, res: Response) => {
        const scope = requireTenant(req, res);
        if (!scope) return;
        const body = readBody(req);
        const result = await core.createSession({
            tenantId: scope.tenantId,
            hostUserId: scope.userId,
            title: typeof body.title === 'string' ? body.title : '',
            startsAtMs: typeof body.starts_at_ms === 'number' ? body.starts_at_ms : undefined,
            provider: typeof body.provider === 'string' ? body.provider : null,
            providerRoomId: typeof body.provider_room_id === 'string' ? body.provider_room_id : null,
            maxParticipants: typeof body.max_participants === 'number' ? body.max_participants : undefined,
        });
        if (!result.ok) {
            const status = result.reason === 'signing-unconfigured' || result.reason === 'transaction-required'
                ? 503
                : 400;
            return res.status(status).json({ error: result.reason });
        }
        res.status(201).json({ id: result.id, state: result.state });
    });

    router.get('/:id', async (req: AuthRequest, res: Response) => {
        const scope = requireTenant(req, res);
        if (!scope) return;
        const session = await core.getSession(scope.tenantId, req.params.id);
        if (!session) return res.status(404).json({ error: 'Session not found' });
        res.json(publicSession(session));
    });

    const hostAction = (
        action: (tenantId: string, sessionId: string, actorUserId: string) => Promise<{ ok: boolean; reason?: string; state?: string }>,
    ): RequestHandler => async (req: AuthRequest, res: Response) => {
        const scope = requireTenant(req, res);
        if (!scope) return;
        const session = await core.getSession(scope.tenantId, req.params.id);
        if (!session) return res.status(404).json({ error: 'Session not found' });
        if (!isHost(session, scope.userId)) return res.status(403).json({ error: 'Forbidden' });
        const result = await action(scope.tenantId, session.id, scope.userId);
        if (!result.ok) {
            const status = result.reason === 'not-found' ? 404
                : result.reason === 'forbidden' ? 403
                    : result.reason === 'transaction-required' ? 503
                        : result.reason === 'conflict' ? 409
                            : 409;
            return res.status(status).json({ error: result.reason });
        }
        res.json({ state: result.state });
    };

    router.post('/:id/start', hostAction((tenantId, sessionId, actor) => core.startSession(tenantId, sessionId, actor)));
    router.post('/:id/end', hostAction((tenantId, sessionId, actor) => core.endSession(tenantId, sessionId, actor)));
    router.post('/:id/cancel', hostAction((tenantId, sessionId, actor) => core.cancelSession(tenantId, sessionId, actor)));

    router.post('/:id/join', async (req: AuthRequest, res: Response) => {
        const scope = requireTenant(req, res);
        if (!scope) return;
        const body = readBody(req);
        const result = await core.join({
            tenantId: scope.tenantId,
            sessionId: req.params.id,
            userId: scope.userId,
            role: body.role,
            ticket: body.ticket,
        });
        if (!result.ok) {
            return res.status(STATUS_BY_DENIAL[result.reason]).json({
                error: result.reason,
                ...(result.detail === undefined ? {} : { detail: result.detail }),
            });
        }
        res.json({
            participant_id: result.participantId,
            role: result.role,
            ticket: result.ticket,
            expires_at_ms: result.expiresAtMs,
        });
    });

    router.post('/:id/leave', async (req: AuthRequest, res: Response) => {
        const scope = requireTenant(req, res);
        if (!scope) return;
        const result = await core.leave({
            tenantId: scope.tenantId,
            sessionId: req.params.id,
            userId: scope.userId,
        });
        if (!result.ok) {
            // A missing unit is a storage refusal, not a missing session.
            if (result.reason === 'transaction-required') {
                return res.status(503).json({ error: 'transaction-required' });
            }
            return res.status(404).json({ error: 'Session not found' });
        }
        // Idempotent: leaving twice is 200 with `left: false`, not an error.
        res.json({ left: result.left });
    });

    router.get('/:id/attendance', async (req: AuthRequest, res: Response) => {
        const scope = requireTenant(req, res);
        if (!scope) return;
        const session = await core.getSession(scope.tenantId, req.params.id);
        if (!session) return res.status(404).json({ error: 'Session not found' });
        if (!isHost(session, scope.userId)) return res.status(403).json({ error: 'Forbidden' });
        const report = await core.attendance(scope.tenantId, session.id, { countOpenPresence: false });
        if (!report) return res.status(404).json({ error: 'Session not found' });
        res.json({
            session_id: report.sessionId,
            window_start_ms: report.windowStartMs,
            window_end_ms: report.windowEndMs,
            total_covered_seconds: report.totalCoveredSeconds,
            anomalies: report.anomalies,
            participants: report.participants.map((participant) => ({
                user_id: participant.userId,
                role: participant.role,
                covered_seconds: participant.coveredSeconds,
                intervals: participant.intervals,
                anomaly: participant.anomaly,
            })),
        });
    });

    router.post('/callbacks/:provider', async (req: AuthRequest, res: Response) => {
        const body = readBody(req);
        const callback: ProviderCallbackInput = {
            provider: req.params.provider,
            eventId: typeof body.event_id === 'string' ? body.event_id : '',
            signature: typeof body.signature === 'string' ? body.signature : '',
            providerRoomId: typeof body.provider_room_id === 'string' ? body.provider_room_id : '',
            kind: body.kind,
            occurredAtMs: typeof body.occurred_at_ms === 'number' ? body.occurred_at_ms : undefined,
            tenantId: typeof body.tenant_id === 'string' ? body.tenant_id : null,
            providerParticipantId: typeof body.provider_participant_id === 'string'
                ? body.provider_participant_id
                : null,
        };
        const result = await core.applyProviderCallback(callback);
        // A duplicate is 200: the provider must stop retrying it. An ignored
        // callback is 202: accepted for the record, deliberately not applied.
        // A storage refusal is 503: nothing was committed, so a retry is safe.
        const status = result.status === 'rejected' && result.reason === 'transaction-required'
            ? 503
            : STATUS_BY_CALLBACK[result.status];
        res.status(status).json(result);
    });

    return router;
};
