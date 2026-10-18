import { Router, Request, Response, RequestHandler } from 'express';
import {
    createPlaybackSessionRegistry,
    asPlaybackSessionStore,
    createSqlPlaybackSessionStore,
    PlaybackDeviceLimitError,
    type PlaybackSessionStore,
    type PlaybackDevice,
    type PlaybackStoreDb,
} from '../services/playback-session-registry';
import {
    createPlaybackProgressService,
    asPlaybackProgressStore,
    createSqlPlaybackProgressService,
    type PlaybackProgressStore,
} from '../services/playback-progress';
import {
    generateWatermarkPayload,
    pseudonymizeIdentity,
    type WatermarkPayload,
    type WatermarkInput,
} from '../services/playback-watermark';
import { recordAudit } from '../security/audit';

export type PlaybackSessionsDb = PlaybackStoreDb;

export interface PlaybackSessionsDeps {
    db?: PlaybackSessionsDb;
    authenticate?: RequestHandler;
    now?: () => Date;
    registry?: PlaybackSessionStore;
    progress?: PlaybackProgressStore;
    audit?: (event: Record<string, unknown>) => void | Promise<void>;
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
        const result = await registry.revokeSession({
            sessionId,
            actorId: str(user.id) ?? '',
            actorType: 'self',
            reason: str(body.reason) ?? 'self_revoke',
            support: false,
        });
        if (!result.revoked) {
            const status = result.reason === 'session_not_found' ? 404 : 403;
            return res.status(status).json(result);
        }
        // also release slot
        await registry.releaseSlot(sessionId, 'self_revoke');
        return res.json(result);
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
        if (!(userRole === 'admin' || userRole === 'super_admin' || userRole === 'staff')) {
            return res.status(403).json({ error: 'forbidden' });
        }
        const slot = await registry.getSession(sessionId);
        const userTenantId = str(user.tenantId) ?? str(user.tenant_id);
        if (slot && userTenantId && slot.tenantId !== userTenantId && userRole !== 'super_admin') {
            return res.status(403).json({ error: 'tenant_mismatch' });
        }
        const result = await registry.revokeSession({
            sessionId,
            actorId: str(user.id) ?? '',
            actorType: 'support',
            reason: str(body.reason) ?? 'support_revoke',
            support: true,
        });
        if (!result.revoked) {
            const status = result.reason === 'session_not_found' ? 404 : 403;
            return res.status(status).json(result);
        }
        await registry.releaseSlot(sessionId, 'support_revoke');
        if (deps.audit) {
            await deps.audit({ action: 'playback.session.support_revoke', sessionId, actorId: str(user.id) });
        }
        return res.json(result);
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
        const support = userRole === 'admin' || userRole === 'super_admin' || userRole === 'staff';
        const device = await registry.getDevice(deviceId);
        const userTenantId = str(user.tenantId) ?? str(user.tenant_id);
        if (device && userTenantId && device.tenantId !== userTenantId && userRole !== 'super_admin') {
            return res.status(403).json({ error: 'tenant_mismatch' });
        }
        if (device && !support && device.userId !== (str(user.id) ?? '')) {
            return res.status(403).json({ error: 'not_owner' });
        }
        const result = await registry.revokeDevice({
            deviceId,
            actorId: str(user.id) ?? '',
            reason: str(body.reason) ?? (support ? 'support_revoke' : 'self_revoke'),
            support,
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

const productionAudit = async (event: Record<string, unknown>): Promise<void> => {
    const { execute } = await loadDb();
    const action = str(event.action) ?? 'playback.audit';
    await recordAudit(execute, {
        actorUserId: str(event.actorId) ?? str(event.userId),
        tenantId: str(event.tenantId),
        action,
        resourceType: action.startsWith('playback.device') ? 'playback_device' : 'playback_session',
        resourceId: str(event.sessionId) ?? str(event.deviceId) ?? 'unknown',
        newValue: event,
    });
};

export default createPlaybackSessionsRouter({
    db: productionDb,
    authenticate: async (req, res, next) => {
        const { authenticateToken } = await import('../middleware/auth');
        return authenticateToken(req, res, next);
    },
    audit: productionAudit,
    // Production default: durable, cross-process state in the migration-07
    // tables. Tests keep the in-memory stores.
    registry: createSqlPlaybackSessionStore(productionDb, { audit: productionAudit }),
    progress: createSqlPlaybackProgressService(productionDb),
});
