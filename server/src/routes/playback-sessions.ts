import { Router, Request, Response, RequestHandler } from 'express';
import {
    createPlaybackSessionRegistry,
    asPlaybackSessionStore,
    createSqlPlaybackSessionStore,
    PlaybackDeviceLimitError,
    type PlaybackSessionStore,
    type PlaybackDevice,
    type PlaybackStoreDb,
    type RevokeResult,
} from '../services/playback-session-registry';
import {
    createPlaybackProgressService,
    asPlaybackProgressStore,
    createSqlPlaybackProgressService,
    type PlaybackProgressStore,
} from '../services/playback-progress';
import { createSqlPlaybackEntitlementStore } from '../services/playback-entitlement';
import {
    generateWatermarkPayload,
    pseudonymizeIdentity,
    type WatermarkPayload,
    type WatermarkInput,
} from '../services/playback-watermark';
import { recordAudit } from '../security/audit';
import { hasVerifiedPlatformPermission } from '../security/admin-permissions';

export type PlaybackSessionsDb = PlaybackStoreDb;

/**
 * Roles that may act as support at all. The label alone is never authority:
 * see `resolveSupportAuthority`.
 */
const SUPPORT_REVOKE_ROLES = new Set(['admin', 'super_admin', 'staff']);

/**
 * The existing platform capability that authorizes cross-tenant reach across
 * the video surface (`secure-video.ts`, `videos.ts`). No new key is introduced.
 */
const PLATFORM_SECURITY_PERMISSION = 'security.manage';

const defaultPlatformCapability = (userId: string): Promise<boolean> =>
    hasVerifiedPlatformPermission(PLATFORM_SECURITY_PERMISSION, userId);

export interface PlaybackSessionsDeps {
    db?: PlaybackSessionsDb;
    authenticate?: RequestHandler;
    now?: () => Date;
    registry?: PlaybackSessionStore;
    progress?: PlaybackProgressStore;
    audit?: (event: Record<string, unknown>) => void | Promise<void>;
    /**
     * Secondary local effect of a revoke: close the media-delivery session in
     * this process. It runs only AFTER the durable revocation committed, and a
     * failure here is logged rather than reported, because the durable store
     * already denies the next request — a local failure must never make a
     * revoked session look alive again.
     */
    killDeliverySession?: (sessionId: string, reason: string) => Promise<void>;
    /**
     * Verified platform capability (`security.manage`: an active super_admin
     * row or the permission key granted by `admin_role_permissions`). It is the
     * ONLY path that authorizes support outside the actor's own tenant.
     * Production passes the real predicate; hermetic tests inject a fixture.
     * A rejection or a throw is a denial — never a fallback to the role label.
     */
    hasPlatformCapability?: (userId: string) => Promise<boolean>;
}

const defaultAuthenticate: RequestHandler = (_req, res) => {
    res.status(401).json({ error: 'Authentication required' });
};

function getUser(req: Request): Record<string, unknown> {
    return (req as Request & { user?: Record<string, unknown> }).user ?? {};
}

function str(value: unknown): string | null {
    return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function num(value: unknown): number | null {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
}

export function createPlaybackSessionsRouter(deps: PlaybackSessionsDeps = {}): Router {
    const router = Router();
    const authenticate = deps.authenticate ?? defaultAuthenticate;
    const now = deps.now ?? (() => new Date());
    const registry = deps.registry ?? asPlaybackSessionStore(createPlaybackSessionRegistry({ now, audit: deps.audit }));
    const progress = deps.progress ?? asPlaybackProgressStore(createPlaybackProgressService({ now }));
    const hasPlatformCapability = deps.hasPlatformCapability ?? defaultPlatformCapability;

    type SupportAuthority =
        | { allowed: true; platformAuthorized: boolean }
        | { allowed: false; status: number; body: Record<string, unknown> };

    /**
     * Resource-scoped authority for a support (non-owner) revoke.
     *
     * The tenant is the server-derived scope on the authenticated principal
     * (`resolvePrincipal`), never a request field. Exact equality with the
     * target's tenant is sufficient on its own; anything else — a missing
     * tenant, a foreign tenant, a role label such as `admin`/`super_admin`
     * without a tenant — needs a LIVE platform capability. A lookup that throws
     * denies: an unverified actor is never treated as authorized.
     */
    const resolveSupportAuthority = async (
        actor: { id: string; tenantId: string | null },
        targetTenantId: string,
    ): Promise<SupportAuthority> => {
        if (actor.tenantId && actor.tenantId === targetTenantId) {
            return { allowed: true, platformAuthorized: false };
        }
        let platformAuthorized: boolean;
        try {
            platformAuthorized = await hasPlatformCapability(actor.id);
        } catch (error) {
            console.error('[Playback] Platform capability lookup failed:', error);
            return { allowed: false, status: 503, body: { error: 'authority_unavailable' } };
        }
        if (!platformAuthorized) {
            return {
                allowed: false,
                status: 403,
                body: { error: actor.tenantId ? 'tenant_mismatch' : 'tenant_required' },
            };
        }
        return { allowed: true, platformAuthorized: true };
    };

    /**
     * Commit one revocation and close the local delivery session afterwards.
     *
     * The durable part (slot status + session entitlements + audit) is a single
     * store transaction; if it fails, nothing changed and the caller must not
     * report success. The local kill is a second, best-effort effect: it can
     * only ever remove an already-revoked session from this process, so its
     * failure is logged and swallowed.
     */
    const commitRevocation = async (
        input: {
            sessionId: string;
            actorId: string;
            actorType: 'self' | 'support';
            reason: string;
            support: boolean;
            /**
             * Server-derived actor scope. The store re-checks it inside the
             * mutation transaction, so authority is proven against the row it
             * actually changes (TOCTOU), not only against a pre-read.
             */
            actorTenantId?: string | null;
            platformAuthorized?: boolean;
        },
    ): Promise<{ status: number; body: Record<string, unknown> }> => {
        let result: RevokeResult;
        try {
            result = await registry.revokeSession(input);
        } catch (error) {
            console.error('[Playback] Durable session revocation failed:', error);
            return { status: 500, body: { error: 'revoke_failed' } };
        }
        if (!result.revoked) {
            return { status: result.reason === 'session_not_found' ? 404 : 403, body: { ...result } };
        }
        if (deps.killDeliverySession) {
            try {
                await deps.killDeliverySession(input.sessionId, input.reason);
            } catch (error) {
                console.error('[Playback] Local delivery session close failed after a committed revoke:', error);
            }
        }
        return { status: 200, body: { ...result } };
    };

    // POST /sessions  (start a playback session)
    const startHandler = async (req: Request, res: Response) => {
        const user = getUser(req);
        const body = (req.body ?? {}) as Record<string, unknown>;
        const tenantId = str(body.tenantId) ?? str(user.tenantId) ?? str(user.tenant_id);
        const userId = str(body.userId) ?? str(user.id) ?? str(user.userId);
        if (!tenantId || !userId) {
            return res.status(400).json({ error: 'tenantId and userId required' });
        }
        const userTenantId = str(user.tenantId) ?? str(user.tenant_id);
        if (userTenantId && tenantId !== userTenantId) {
            return res.status(403).json({ error: 'tenant_mismatch' });
        }
        const userIdClaim = str(user.id) ?? str(user.userId);
        const userRole = str(user.role);
        const privileged = userRole === 'admin' || userRole === 'super_admin' || userRole === 'instructor' || userRole === 'teacher' || userRole === 'staff';
        if (userIdClaim && userId !== userIdClaim && !privileged) {
            return res.status(403).json({ error: 'user_mismatch' });
        }

        const assetId = str(body.assetId) ?? str(body.videoId) ?? str(body.lessonId);
        const fingerprint = str(body.fingerprint) ?? str(body.deviceFingerprint) ?? 'unknown-device';
        const deviceLabel = str(body.deviceLabel) ?? str(body.deviceName) ?? null;

        // register device; the server (never the client) owns the policy
        let device: PlaybackDevice;
        try {
            device = await registry.registerDevice({ tenantId, userId, fingerprint, label: deviceLabel, now: now() });
        } catch (error) {
            if (error instanceof PlaybackDeviceLimitError) {
                return res.status(409).json({ acquired: false, reason: 'device_limit', limit: error.limit });
            }
            throw error;
        }

        const sessionId = str(body.sessionId) ?? `ps-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;

        // No client-supplied policy: the registry resolves and clamps the
        // tenant policy server-side, so limits cannot be raised by the caller.
        const acquisition = await registry.acquireSlot({
            tenantId,
            userId,
            deviceId: device.id,
            sessionId,
        });

        if (!acquisition.acquired) {
            return res.status(409).json({
                acquired: false,
                reason: acquisition.reason,
                activeSlots: acquisition.activeSlots,
                deviceId: device.id,
            });
        }

        // watermark payload (partial identity only)
        const identityInput: WatermarkInput = {
            studentId: userId,
            name: str(user.name) ?? str(body.studentName),
            phone: str(user.phone) ?? str(body.studentPhone),
            email: str(user.email) ?? str(body.studentEmail),
            tenantId,
            groupLabel: str(body.groupName) ?? str(body.groupLabel),
            sessionId,
            forensicCode: str(body.forensicCode) ?? `${sessionId.slice(0, 8)}`,
        };
        const watermark: WatermarkPayload = generateWatermarkPayload(identityInput, { now });

        // progress resume for this asset (if provided)
        let resumePosition: number | null = null;
        if (assetId) {
            const resume = await progress.getResumePosition({
                tenantId,
                studentEnrollmentId: str(user.studentEnrollmentId) ?? str(user.student_enrollment_id) ?? userId,
                assetId,
                deviceId: device.id,
                now: now(),
            });
            if (resume.allowed) resumePosition = resume.position;
        }

        const policy = await registry.getPolicy(tenantId);

        return res.status(201).json({
            sessionId,
            deviceId: device.id,
            acquired: true,
            warning: acquisition.warning,
            activeSlots: acquisition.activeSlots,
            limit: policy.maxConcurrentSessions,
            watermark,
            resumePosition,
            policy,
        });
    };

    router.post('/sessions', authenticate, startHandler);
    router.post('/sessions/start', authenticate, startHandler);
    router.post('/start', authenticate, startHandler);

    // POST /sessions/:sessionId/heartbeat
    const heartbeatHandler = async (req: Request, res: Response) => {
        const user = getUser(req);
        const sessionId = String(req.params.sessionId || req.body?.sessionId || '');
        if (!sessionId) return res.status(400).json({ error: 'sessionId required' });
        if (!(await registry.isSessionActive(sessionId))) {
            return res.status(404).json({ error: 'session_not_active' });
        }
        const slot = await registry.getSession(sessionId);
        const userTenantId = str(user.tenantId) ?? str(user.tenant_id);
        const userIdClaim = str(user.id);
        if (slot && userTenantId && slot.tenantId !== userTenantId) {
            return res.status(403).json({ error: 'tenant_mismatch' });
        }
        if (slot && userIdClaim && slot.userId !== userIdClaim) {
            return res.status(403).json({ error: 'user_mismatch' });
        }
        const hb = await progress.recordHeartbeat({ sessionId, now: now() });
        if (!hb.accepted) {
            return res.status(429).json({ error: 'rate_limited', reason: hb.reason });
        }
        return res.json({ ok: true, ts: now().getTime() });
    };
    router.post('/sessions/:sessionId/heartbeat', authenticate, heartbeatHandler);
    router.post('/heartbeat', authenticate, heartbeatHandler);

    // POST /sessions/:sessionId/progress
    const progressHandler = async (req: Request, res: Response) => {
        const user = getUser(req);
        const body = (req.body ?? {}) as Record<string, unknown>;
        const sessionId = String(req.params.sessionId || body.sessionId || '');
        const tenantId = str(body.tenantId) ?? str(user.tenantId) ?? str(user.tenant_id);
        const enrollmentId = str(body.studentEnrollmentId) ?? str(body.enrollmentId) ?? str(user.studentEnrollmentId) ?? str(user.student_enrollment_id) ?? str(user.id);
        const assetId = str(body.assetId) ?? str(body.videoId) ?? str(body.lessonId);
        const positionSeconds = num(body.positionSeconds) ?? num(body.position) ?? 0;
        const durationSeconds = num(body.durationSeconds) ?? num(body.duration) ?? 0;
        const deviceId = str(body.deviceId);
        if (!tenantId || !enrollmentId || !assetId) {
            return res.status(400).json({ error: 'tenantId, enrollmentId, assetId required' });
        }
        const userTenantId = str(user.tenantId) ?? str(user.tenant_id);
        if (userTenantId && tenantId !== userTenantId) {
            return res.status(403).json({ error: 'tenant_mismatch' });
        }
        const userEnrollment = str(user.studentEnrollmentId) ?? str(user.student_enrollment_id) ?? str(user.id);
        const userRole = str(user.role);
        const privileged = userRole === 'admin' || userRole === 'super_admin' || userRole === 'instructor' || userRole === 'teacher' || userRole === 'staff';
        if (userEnrollment && enrollmentId !== userEnrollment && !privileged) {
            return res.status(403).json({ error: 'student_mismatch' });
        }
        const result = await progress.recordProgress({
            tenantId,
            studentEnrollmentId: enrollmentId,
            assetId,
            positionSeconds,
            durationSeconds,
            deviceId,
            sessionId: sessionId || null,
            now: now(),
        });
        if (!result.accepted) {
            const status = result.reason === 'rate_limited' ? 429
                : result.reason === 'device_not_permitted' ? 403
                : result.reason === 'tenant_mismatch' || result.reason === 'student_mismatch' ? 403
                : 400;
            return res.status(status).json(result);
        }
        return res.json(result);
    };
    router.post('/sessions/:sessionId/progress', authenticate, progressHandler);
    router.post('/progress', authenticate, progressHandler);

    // GET /sessions/:sessionId/resume
    const resumeHandler = async (req: Request, res: Response) => {
        const user = getUser(req);
        const query = req.query as Record<string, unknown>;
        const body = (req.body ?? {}) as Record<string, unknown>;
        const tenantId = str(query.tenantId) ?? str(body.tenantId) ?? str(user.tenantId) ?? str(user.tenant_id);
        const enrollmentId = str(query.studentEnrollmentId) ?? str(body.studentEnrollmentId) ?? str(user.studentEnrollmentId) ?? str(user.student_enrollment_id) ?? str(user.id);
        const assetId = str(query.assetId) ?? str(body.assetId) ?? str(query.videoId) ?? str(body.videoId);
        const deviceId = str(query.deviceId) ?? str(body.deviceId);
        if (!tenantId || !enrollmentId || !assetId) {
            return res.status(400).json({ error: 'tenantId, enrollmentId, assetId required' });
        }
        const userTenantId = str(user.tenantId) ?? str(user.tenant_id);
        if (userTenantId && tenantId !== userTenantId) {
            return res.status(403).json({ error: 'tenant_mismatch' });
        }
        const userEnrollment = str(user.studentEnrollmentId) ?? str(user.student_enrollment_id) ?? str(user.id);
        const userRole = str(user.role);
        const privileged = userRole === 'admin' || userRole === 'super_admin' || userRole === 'instructor' || userRole === 'teacher' || userRole === 'staff';
        if (userEnrollment && enrollmentId !== userEnrollment && !privileged) {
            return res.status(403).json({ error: 'student_mismatch' });
        }
        const result = await progress.getResumePosition({ tenantId, studentEnrollmentId: enrollmentId, assetId, deviceId, now: now() });
        if (!result.allowed) {
            const status = result.reason === 'device_not_permitted' ? 403 : 404;
            return res.status(status).json(result);
        }
        return res.json(result);
    };
    router.get('/sessions/:sessionId/resume', authenticate, resumeHandler);
    router.get('/resume', authenticate, resumeHandler);
    router.post('/resume', authenticate, resumeHandler);

    // POST /sessions/:sessionId/revoke  (self)
    const selfRevokeHandler = async (req: Request, res: Response) => {
        const user = getUser(req);
        const body = (req.body ?? {}) as Record<string, unknown>;
        const sessionId = String(req.params.sessionId || body.sessionId || '');
        if (!sessionId) return res.status(400).json({ error: 'sessionId required' });
        const slot = await registry.getSession(sessionId);
        const userTenantId = str(user.tenantId) ?? str(user.tenant_id);
        const userIdClaim = str(user.id) ?? '';
        if (slot && userTenantId && slot.tenantId !== userTenantId) {
            return res.status(403).json({ error: 'tenant_mismatch' });
        }
        if (slot && slot.userId !== userIdClaim) {
            return res.status(403).json({ error: 'not_authorized' });
        }
        const result = await commitRevocation({
            sessionId,
            actorId: str(user.id) ?? '',
            actorType: 'self',
            reason: str(body.reason) ?? 'self_revoke',
            support: false,
        });
        return res.status(result.status).json(result.body);
    };
    router.delete('/sessions/:sessionId', authenticate, selfRevokeHandler);
    router.post('/sessions/:sessionId/revoke', authenticate, selfRevokeHandler);
    router.post('/sessions/:sessionId/self-revoke', authenticate, selfRevokeHandler);

    // POST /sessions/:sessionId/support-revoke
    const supportRevokeHandler = async (req: Request, res: Response) => {
        const user = getUser(req);
        const body = (req.body ?? {}) as Record<string, unknown>;
        const sessionId = String(req.params.sessionId || body.sessionId || '');
        if (!sessionId) return res.status(400).json({ error: 'sessionId required' });
        const userRole = str(user.role);
        if (!userRole || !SUPPORT_REVOKE_ROLES.has(userRole)) {
            return res.status(403).json({ error: 'forbidden' });
        }
        const slot = await registry.getSession(sessionId);
        if (!slot) return res.status(404).json({ revoked: false, reason: 'session_not_found' });
        const actorId = str(user.id) ?? '';
        const actorTenantId = str(user.tenantId) ?? str(user.tenant_id);
        const authority = await resolveSupportAuthority({ id: actorId, tenantId: actorTenantId }, slot.tenantId);
        if (!authority.allowed) return res.status(authority.status).json(authority.body);
        const result = await commitRevocation({
            sessionId,
            actorId,
            actorType: 'support',
            reason: str(body.reason) ?? 'support_revoke',
            support: true,
            actorTenantId,
            platformAuthorized: authority.platformAuthorized,
        });
        // The durable store emits the single meaningful revoke event inside its
        // transaction; no second event is appended here.
        return res.status(result.status).json(result.body);
    };
    router.post('/sessions/:sessionId/support-revoke', authenticate, supportRevokeHandler);

    // GET /devices
    const listDevicesHandler = async (req: Request, res: Response) => {
        const user = getUser(req);
        const requestedTenantId = str(req.query.tenantId as string);
        const userTenantId = str(user.tenantId) ?? str(user.tenant_id);
        const tenantId = requestedTenantId ?? userTenantId;
        const userRole = str(user.role);
        const privileged = userRole === 'admin' || userRole === 'super_admin' || userRole === 'instructor' || userRole === 'teacher' || userRole === 'staff';
        if (requestedTenantId && userTenantId && requestedTenantId !== userTenantId && !privileged) {
            return res.status(403).json({ error: 'tenant_mismatch' });
        }
        if (!tenantId) return res.status(400).json({ error: 'tenantId required' });
        // Non-privileged callers may only list their own devices; the query
        // selector is ignored so a student cannot enumerate peers in-tenant.
        const requestedUserId = str(req.query.userId as string);
        const userId = privileged ? (requestedUserId ?? undefined) : (str(user.id) ?? undefined);
        if (!privileged && !userId) return res.status(403).json({ error: 'forbidden' });
        return res.json(await registry.listDevices(tenantId, userId));
    };
    router.get('/devices', authenticate, listDevicesHandler);

    // POST /devices/:deviceId/revoke
    const revokeDeviceHandler = async (req: Request, res: Response) => {
        const user = getUser(req);
        const body = (req.body ?? {}) as Record<string, unknown>;
        const deviceId = String(req.params.deviceId || body.deviceId || '');
        const userRole = str(user.role);
        const support = userRole !== null && SUPPORT_REVOKE_ROLES.has(userRole);
        const actorId = str(user.id) ?? '';
        const actorTenantId = str(user.tenantId) ?? str(user.tenant_id);
        const device = await registry.getDevice(deviceId);
        let platformAuthorized = false;
        if (device && support) {
            // Same decision contract as the session support-revoke: the exact
            // server-derived tenant, or a live verified platform capability.
            const authority = await resolveSupportAuthority({ id: actorId, tenantId: actorTenantId }, device.tenantId);
            if (!authority.allowed) return res.status(authority.status).json(authority.body);
            platformAuthorized = authority.platformAuthorized;
        }
        if (device && !support && device.userId !== actorId) {
            return res.status(403).json({ error: 'not_owner' });
        }
        const result = await registry.revokeDevice({
            deviceId,
            actorId,
            reason: str(body.reason) ?? (support ? 'support_revoke' : 'self_revoke'),
            support,
            actorTenantId,
            platformAuthorized,
        });
        if (!result.revoked) {
            const status = result.reason === 'device_not_found' ? 404 : 403;
            return res.status(status).json(result);
        }
        return res.json(result);
    };
    router.post('/devices/:deviceId/revoke', authenticate, revokeDeviceHandler);

    // GET /policy (or /policy/:tenantId)
    const policyHandler = async (req: Request, res: Response) => {
        const user = getUser(req);
        const requestedTenantId = str(req.params.tenantId) ?? str(req.query.tenantId as string);
        const userTenantId = str(user.tenantId) ?? str(user.tenant_id);
        const tenantId = requestedTenantId ?? userTenantId;
        const userRole = str(user.role);
        const privileged = userRole === 'admin' || userRole === 'super_admin' || userRole === 'instructor' || userRole === 'teacher' || userRole === 'staff';
        if (requestedTenantId && userTenantId && requestedTenantId !== userTenantId && !privileged) {
            return res.status(403).json({ error: 'tenant_mismatch' });
        }
        if (!tenantId) return res.status(400).json({ error: 'tenantId required' });
        return res.json(await registry.getPolicy(tenantId));
    };
    router.get('/policy', authenticate, policyHandler);
    router.get('/policy/:tenantId', authenticate, policyHandler);

    // GET /sessions
    const listSessionsHandler = async (req: Request, res: Response) => {
        const user = getUser(req);
        const requestedTenantId = str(req.query.tenantId as string);
        const userTenantId = str(user.tenantId) ?? str(user.tenant_id);
        const tenantId = requestedTenantId ?? userTenantId;
        const userRole = str(user.role);
        const privileged = userRole === 'admin' || userRole === 'super_admin' || userRole === 'instructor' || userRole === 'teacher' || userRole === 'staff';
        if (requestedTenantId && userTenantId && requestedTenantId !== userTenantId && !privileged) {
            return res.status(403).json({ error: 'tenant_mismatch' });
        }
        if (!tenantId) return res.status(400).json({ error: 'tenantId required' });
        // Non-privileged callers may only list their own sessions; the query
        // selector is ignored so a student cannot enumerate peers in-tenant.
        const requestedUserId = str(req.query.userId as string);
        const userId = privileged ? (requestedUserId ?? undefined) : (str(user.id) ?? undefined);
        if (!privileged && !userId) return res.status(403).json({ error: 'forbidden' });
        const status = str(req.query.status as string) ?? undefined;
        return res.json(await registry.listSessions(tenantId, userId, status));
    };
    router.get('/sessions', authenticate, listSessionsHandler);

    return router;
}

export const createPlaybackSessionRouter = createPlaybackSessionsRouter;
export const createPlaybackSessions = createPlaybackSessionsRouter;

/* Production wiring: real pool, real auth, real audit sink. */

let dbModule: typeof import('../db') | null = null;
const loadDb = async (): Promise<typeof import('../db')> => {
    dbModule ??= await import('../db');
    return dbModule;
};

const productionDb: PlaybackSessionsDb = {
    query: async <T = unknown>(sql: string, params?: unknown[]) => {
        const { query } = await loadDb();
        return query<T>(sql, params as never);
    },
    queryOne: async <T = unknown>(sql: string, params?: unknown[]) => {
        const { queryOne } = await loadDb();
        return queryOne<T>(sql, params as never);
    },
    execute: async (sql: string, params?: unknown[]) => {
        const { execute } = await loadDb();
        return execute(sql, params as never);
    },
    // Slot acquisition and device registration run their check-and-insert
    // critical section on one pooled connection inside a transaction, so the
    // `FOR UPDATE` lock and the insert cannot drift onto different connections.
    transaction: async <T>(fn: (tx: PlaybackStoreDb) => Promise<T>) => {
        const { getPool } = await loadDb();
        const connection = await getPool().getConnection();
        const readRows = async (sql: string, params?: unknown[]): Promise<unknown> => {
            const [rows] = await connection.execute(sql, params as never);
            return rows;
        };
        const tx: PlaybackStoreDb = {
            query: async <R = unknown>(sql: string, params?: unknown[]) => (await readRows(sql, params)) as R[],
            queryOne: async <R = unknown>(sql: string, params?: unknown[]) => {
                const rows = (await readRows(sql, params)) as R[];
                return rows.length > 0 ? rows[0] : null;
            },
            execute: async (sql: string, params?: unknown[]) => {
                const [result] = await connection.execute(sql, params as never);
                return result as { insertId?: number; affectedRows?: number };
            },
        };
        try {
            await connection.beginTransaction();
            const result = await fn(tx);
            await connection.commit();
            return result;
        } catch (error) {
            await connection.rollback();
            throw error;
        } finally {
            connection.release();
        }
    },
};

const productionAudit = async (event: Record<string, unknown>, tx?: PlaybackStoreDb): Promise<void> => {
    // Inside a store transaction the audit row must use the transaction's own
    // connection, so it commits (or rolls back) with the state change.
    const run = tx ? tx.execute : (await loadDb()).execute;
    const action = str(event.action) ?? 'playback.audit';
    await recordAudit(run, {
        actorUserId: str(event.actorId) ?? str(event.userId),
        tenantId: str(event.tenantId),
        action,
        resourceType: action.startsWith('playback.device') ? 'playback_device' : 'playback_session',
        resourceId: str(event.sessionId) ?? str(event.deviceId) ?? 'unknown',
        newValue: event,
    });
};

const productionRegistry = createSqlPlaybackSessionStore(productionDb, {
    audit: productionAudit,
    // Session-wide entitlement revocation joins the revocation transaction, so
    // a revoked slot never keeps a usable delivery record.
    revokeEntitlements: (tx, input) => {
        const store = createSqlPlaybackEntitlementStore(tx);
        const revoke = store.revokeBySessionId;
        if (!revoke) throw new Error('entitlement store cannot revoke by session');
        return revoke(input);
    },
});

export default createPlaybackSessionsRouter({
    db: productionDb,
    authenticate: async (req, res, next) => {
        const { authenticateToken } = await import('../middleware/auth');
        return authenticateToken(req, res, next);
    },
    audit: productionAudit,
    // Production default: durable, cross-process state in the migration-07
    // tables. Tests keep the in-memory stores.
    registry: productionRegistry,
    progress: createSqlPlaybackProgressService(productionDb),
    // Local close of the media-delivery session after the durable commit.
    // Loaded lazily like the pool and the auth middleware above, so importing
    // this module never builds the delivery engine or its timer.
    killDeliverySession: async (sessionId, reason) => {
        const { killSession } = await import('../services/video-security');
        await killSession(sessionId, reason);
    },
});
