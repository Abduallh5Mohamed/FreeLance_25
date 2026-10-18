import { Router, Request, Response, RequestHandler } from 'express';
import {
    createPlaybackSessionRegistry,
    normalizePlaybackPolicy,
    type PlaybackSessionRegistry,
    type PlaybackPolicy,
} from '../services/playback-session-registry';
import {
    createPlaybackProgressService,
    type PlaybackProgressService,
} from '../services/playback-progress';
import {
    generateWatermarkPayload,
    pseudonymizeIdentity,
    type WatermarkPayload,
    type WatermarkInput,
} from '../services/playback-watermark';

export interface PlaybackSessionsDb {
    query: <T = unknown>(sql: string, params?: unknown[]) => Promise<T[]>;
    queryOne: <T = unknown>(sql: string, params?: unknown[]) => Promise<T | null>;
    execute: (sql: string, params?: unknown[]) => Promise<{ insertId?: number; affectedRows?: number }>;
}

export interface PlaybackSessionsDeps {
    db?: PlaybackSessionsDb;
    authenticate?: RequestHandler;
    now?: () => Date;
    registry?: PlaybackSessionRegistry;
    progress?: PlaybackProgressService;
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
    const registry = deps.registry ?? createPlaybackSessionRegistry({ now, audit: deps.audit });
    const progress = deps.progress ?? createPlaybackProgressService({ now });

    // POST /sessions  (start a playback session)
    const startHandler = async (req: Request, res: Response) => {
        const user = getUser(req);
        const body = (req.body ?? {}) as Record<string, unknown>;
        const tenantId = str(body.tenantId) ?? str(user.tenantId) ?? str(user.tenant_id);
        const userId = str(body.userId) ?? str(user.id) ?? str(user.userId);
        if (!tenantId || !userId) {
            return res.status(400).json({ error: 'tenantId and userId required' });
        }

        const assetId = str(body.assetId) ?? str(body.videoId) ?? str(body.lessonId);
        const durationSeconds = num(body.durationSeconds) ?? num(body.duration) ?? 0;
        const fingerprint = str(body.fingerprint) ?? str(body.deviceFingerprint) ?? 'unknown-device';
        const deviceLabel = str(body.deviceLabel) ?? str(body.deviceName) ?? null;

        // register device
        const device = registry.registerDevice({ tenantId, userId, fingerprint, label: deviceLabel, now: now() });

        const sessionId = str(body.sessionId) ?? `ps-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;

        // optional policy override
        const policyInput = body.policy ?? body.playbackPolicy;
        const policy = policyInput ? normalizePlaybackPolicy(policyInput, tenantId) : undefined;

        const acquisition = await registry.acquireSlot({
            tenantId,
            userId,
            deviceId: device.id,
            sessionId,
            policy,
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
            const resume = progress.getResumePosition({
                tenantId,
                studentEnrollmentId: str(user.studentEnrollmentId) ?? str(user.student_enrollment_id) ?? userId,
                assetId,
                deviceId: device.id,
                now: now(),
            });
            if (resume.allowed) resumePosition = resume.position;
        }

        return res.status(201).json({
            sessionId,
            deviceId: device.id,
            acquired: true,
            warning: acquisition.warning,
            activeSlots: acquisition.activeSlots,
            limit: acquisition.slot ? undefined : undefined,
            watermark,
            resumePosition,
            policy: registry.getPolicy(tenantId),
        });
    };

    router.post('/sessions', authenticate, startHandler);
    router.post('/sessions/start', authenticate, startHandler);
    router.post('/start', authenticate, startHandler);

    // POST /sessions/:sessionId/heartbeat
    const heartbeatHandler = async (req: Request, res: Response) => {
        const sessionId = String(req.params.sessionId || req.body?.sessionId || '');
        if (!sessionId) return res.status(400).json({ error: 'sessionId required' });
        if (!registry.isSessionActive(sessionId)) {
            return res.status(404).json({ error: 'session_not_active' });
        }
        const hb = progress.recordHeartbeat({ sessionId, now: now() });
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
        const result = progress.recordProgress({
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
        const result = progress.getResumePosition({ tenantId, studentEnrollmentId: enrollmentId, assetId, deviceId, now: now() });
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
        registry.releaseSlot(sessionId, 'self_revoke');
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
        registry.releaseSlot(sessionId, 'support_revoke');
        if (deps.audit) {
            await deps.audit({ action: 'playback.session.support_revoke', sessionId, actorId: str(user.id) });
        }
        return res.json(result);
    };
    router.post('/sessions/:sessionId/support-revoke', authenticate, supportRevokeHandler);

    // GET /devices
    const listDevicesHandler = async (req: Request, res: Response) => {
        const user = getUser(req);
        const tenantId = str(req.query.tenantId as string) ?? str(user.tenantId) ?? str(user.tenant_id);
        const userId = str(req.query.userId as string) ?? str(user.id);
        if (!tenantId) return res.status(400).json({ error: 'tenantId required' });
        return res.json(registry.listDevices(tenantId, userId ?? undefined));
    };
    router.get('/devices', authenticate, listDevicesHandler);

    // POST /devices/:deviceId/revoke
    const revokeDeviceHandler = async (req: Request, res: Response) => {
        const user = getUser(req);
        const body = (req.body ?? {}) as Record<string, unknown>;
        const deviceId = String(req.params.deviceId || body.deviceId || '');
        const support = body.support === true || str(user.role) === 'admin' || str(user.role) === 'super_admin';
        const result = registry.revokeDevice({
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
        const tenantId = str(req.params.tenantId) ?? str(req.query.tenantId as string) ?? str(user.tenantId) ?? str(user.tenant_id);
        if (!tenantId) return res.status(400).json({ error: 'tenantId required' });
        return res.json(registry.getPolicy(tenantId));
    };
    router.get('/policy', authenticate, policyHandler);
    router.get('/policy/:tenantId', authenticate, policyHandler);

    // GET /sessions
    const listSessionsHandler = async (req: Request, res: Response) => {
        const user = getUser(req);
        const tenantId = str(req.query.tenantId as string) ?? str(user.tenantId) ?? str(user.tenant_id);
        const userId = str(req.query.userId as string) ?? undefined;
        const status = str(req.query.status as string) ?? undefined;
        if (!tenantId) return res.status(400).json({ error: 'tenantId required' });
        return res.json(registry.listSessions(tenantId, userId, status ?? undefined));
    };
    router.get('/sessions', authenticate, listSessionsHandler);

    return router;
}

export const createPlaybackSessionRouter = createPlaybackSessionsRouter;
export const createPlaybackSessions = createPlaybackSessionsRouter;
export default createPlaybackSessionsRouter;
