/**
 * V1/V3/V8 — provider-neutral video asset, playback entitlement and usage
 * surface.
 *
 * The router is a thin, deny-by-default layer over three injected services:
 *
 *  - `VideoAssetLifecycle`        (V1) — asset state machine + idempotent callbacks;
 *  - `PlaybackEntitlementService` (V3) — short-lived bound playback tokens;
 *  - `VideoUsageEventService`     (V8) — watch/storage usage with dedupe.
 *
 * Scoping is server-derived only:
 *  - the tenant/owner of an asset command comes from the verified principal;
 *  - a playback entitlement binds the principal's tenant + enrollment and the
 *    server-resolved lesson tenant (a cross-tenant lesson is unreachable);
 *  - usage heartbeats attribute to the principal's tenant/enrollment.
 *
 * Provider callbacks (`POST /callbacks/:provider`, `POST /usage/provider`) are
 * intentionally unauthenticated but signature-gated through injected
 * verifiers: an unverified payload is ignored and never applied. The factory
 * is exported as `createVideoAssetsRouter(deps)` and is NOT mounted here, so
 * the caller owns the mount path and the production wiring.
 *
 * No `any`, no ts-ignore, no network, no runtime DDL.
 */
import crypto from 'crypto';
import { Router, RequestHandler, Response } from 'express';
import { AuthRequest } from '../middleware/auth';
import {
    ProviderCallbackInput,
    VideoAssetLifecycle,
    createSqlVideoAssetStore,
    createVideoAssetLifecycle,
    normalizeAssetId,
    normalizeProviderKey,
} from '../services/video-asset-lifecycle';
import {
    PlaybackEntitlementService,
    createPlaybackEntitlementService,
    createSqlPlaybackEntitlementStore,
} from '../services/playback-entitlement';
import {
    UsageEventInput,
    VideoUsageEventService,
    buildHeartbeatDedupeKey,
    buildProviderDedupeKey,
    createSqlVideoUsageStore,
    createVideoUsageEventService,
    DEFAULT_HEARTBEAT_WINDOW_SECONDS,
    normalizeUsageKind,
} from '../services/video-usage-events';

/** Injected provider-callback verifier for usage reports (same fail-closed rule). */
export interface UsageCallbackInput {
    provider: string;
    eventId: string;
    tenantId: string;
    kind: string;
    signature: string;
    watchSeconds?: number;
    storageBytes?: number;
    assetId?: string;
}

export interface VideoAssetsDeps {
    authenticate: RequestHandler;
    lifecycle: VideoAssetLifecycle;
    entitlement: PlaybackEntitlementService;
    usage: VideoUsageEventService;
    /** Server-side scope of a lesson; a mismatched tenant denies issuance. */
    resolveLessonScope: (lessonId: string) => Promise<{ tenantId: string } | null>;
    /** Optional verified platform capability for cross-tenant revoke. */
    isPlatformAdmin?: (userId: string) => Promise<boolean>;
    /** Usage provider-callback verifier; absent => callbacks are ignored. */
    verifyUsageCallback?: (input: UsageCallbackInput) => boolean | Promise<boolean>;
    now?: () => number;
    heartbeatWindowSeconds?: number;
}

const isStaffRole = (role: string | undefined): boolean => role !== undefined && role !== 'student';

export function createVideoAssetsRouter(deps: VideoAssetsDeps): Router {
    const router = Router();
    const now = deps.now ?? ((): number => Date.now());
    const heartbeatWindow = deps.heartbeatWindowSeconds ?? DEFAULT_HEARTBEAT_WINDOW_SECONDS;

    const requireTenant = (req: AuthRequest, res: Response): { tenantId: string } | null => {
        if (!req.user) {
            res.status(401).json({ error: 'Authentication required' });
            return null;
        }
        const tenantId = req.user.tenantId;
        if (!tenantId) {
            res.status(403).json({ error: 'No tenant workspace selected' });
            return null;
        }
        return { tenantId };
    };

    /* --------------------------------------------------------------------- */
    /* POST /assets — register an uploaded asset (owner from principal)        */
    /* --------------------------------------------------------------------- */
    router.post('/assets', deps.authenticate, async (req: AuthRequest, res: Response) => {
        try {
            const scope = requireTenant(req, res);
            if (!scope) return;
            const principal = req.user!;
            if (!isStaffRole(principal.role)) return res.status(403).json({ error: 'Staff access required' });

            const provider = normalizeProviderKey((req.body as Record<string, unknown>)?.provider);
            const providerAssetId = normalizeProviderKey((req.body as Record<string, unknown>)?.provider_asset_id);
            if (!provider || !providerAssetId) {
                return res.status(400).json({ error: 'provider and provider_asset_id are required' });
            }
            const title = (req.body as Record<string, unknown>)?.title;
            const result = await deps.lifecycle.registerAsset({
                tenantId: scope.tenantId,
                ownerUserId: principal.id,
                provider,
                providerAssetId,
                title: typeof title === 'string' ? title : undefined,
            });
            if (!result.ok) return res.status(400).json({ error: 'Invalid asset registration' });
            return res.status(201).json({ id: result.id, status: result.state });
        } catch (error) {
            console.error('Video asset registration error:', error);
            return res.status(500).json({ error: 'Failed to register asset' });
        }
    });

    /* --------------------------------------------------------------------- */
    /* GET /assets/:assetId — tenant + owner scoped read                       */
    /* --------------------------------------------------------------------- */
    router.get('/assets/:assetId', deps.authenticate, async (req: AuthRequest, res: Response) => {
        try {
            const scope = requireTenant(req, res);
            if (!scope) return;
            const assetId = normalizeAssetId(req.params.assetId);
            if (!assetId) return res.status(404).json({ error: 'Asset not found' });
            const asset = await deps.lifecycle.getAsset(scope.tenantId, assetId);
            if (!asset) return res.status(404).json({ error: 'Asset not found' });
            const isMaster = asset.ownerUserId === req.user!.id || req.user!.role === 'admin';
            if (!isMaster) return res.status(403).json({ error: 'Forbidden' });
            return res.json(projectAsset(asset));
        } catch (error) {
            console.error('Video asset read error:', error);
            return res.status(500).json({ error: 'Failed to load asset' });
        }
    });

    /* --------------------------------------------------------------------- */
    /* POST /assets/:assetId/processing — owner starts/retries processing      */
    /* --------------------------------------------------------------------- */
    router.post('/assets/:assetId/processing', deps.authenticate, async (req: AuthRequest, res: Response) => {
        try {
            const scope = requireTenant(req, res);
            if (!scope) return;
            if (!isStaffRole(req.user!.role)) return res.status(403).json({ error: 'Staff access required' });
            const assetId = normalizeAssetId(req.params.assetId);
            if (!assetId) return res.status(404).json({ error: 'Asset not found' });

            const asset = await deps.lifecycle.getAsset(scope.tenantId, assetId);
            if (!asset) return res.status(404).json({ error: 'Asset not found' });
            if (asset.ownerUserId !== req.user!.id && req.user!.role !== 'admin') {
                return res.status(403).json({ error: 'Forbidden' });
            }

            const result = await deps.lifecycle.beginProcessing(scope.tenantId, assetId);
            if (result.ok) {
                return res.json({ id: assetId, status: result.state, attempts: result.attempts, dead_lettered: result.deadLettered });
            }
            if (result.reason === 'not-found') return res.status(404).json({ error: 'Asset not found' });
            return res.status(409).json({ error: 'Transition not allowed', reason: result.reason, from: result.from });
        } catch (error) {
            console.error('Video asset processing error:', error);
            return res.status(500).json({ error: 'Failed to start processing' });
        }
    });

    /* --------------------------------------------------------------------- */
    /* POST /callbacks/:provider — signature-gated provider callback           */
    /* --------------------------------------------------------------------- */
    router.post('/callbacks/:provider', async (req: AuthRequest, res: Response) => {
        try {
            const body = (req.body ?? {}) as Record<string, unknown>;
            const result = await deps.lifecycle.applyProviderCallback({
                provider: req.params.provider,
                callbackId: typeof body.callback_id === 'string' ? body.callback_id : '',
                signature: typeof body.signature === 'string' ? body.signature : '',
                providerAssetId: typeof body.provider_asset_id === 'string' ? body.provider_asset_id : '',
                targetState: body.target_state,
                tenantId: typeof body.tenant_id === 'string' ? body.tenant_id : null,
                detail: typeof body.detail === 'string' ? body.detail : null,
                error: typeof body.error === 'string' ? body.error : null,
            });
            if (result.status === 'ignored') return res.status(202).json({ outcome: 'ignored', reason: result.reason });
            if (result.status === 'rejected') {
                return res.status(result.reason === 'cross-tenant' ? 403 : 400)
                    .json({ outcome: 'rejected', reason: result.reason });
            }
            return res.json({
                outcome: result.status,
                status: result.state,
                ...(result.status === 'applied' ? { attempts: result.attempts, dead_lettered: result.deadLettered } : {}),
            });
        } catch (error) {
            console.error('Video asset callback error:', error);
            return res.status(500).json({ error: 'Failed to apply callback' });
        }
    });

    /* --------------------------------------------------------------------- */
    /* POST /playback/entitlements — issue a bound short-lived token           */
    /* --------------------------------------------------------------------- */
    router.post('/playback/entitlements', deps.authenticate, async (req: AuthRequest, res: Response) => {
        try {
            const principal = req.user;
            if (!principal) return res.status(401).json({ error: 'Authentication required' });
            const tenantId = principal.tenantId;
            const studentEnrollmentId = principal.studentEnrollmentId;
            if (!tenantId || !studentEnrollmentId) {
                return res.status(403).json({ error: 'A student workspace is required' });
            }
            const body = (req.body ?? {}) as Record<string, unknown>;
            const lessonId = normalizeAssetId(body.lessonId);
            const sessionId = normalizeAssetId(body.sessionId);
            if (!lessonId || !sessionId) {
                return res.status(400).json({ error: 'lessonId and sessionId are required' });
            }
            const lesson = await deps.resolveLessonScope(lessonId);
            if (!lesson || lesson.tenantId !== tenantId) {
                return res.status(404).json({ error: 'Lesson not found' });
            }
            const issued = await deps.entitlement.issue(
                { tenantId, lessonId, studentEnrollmentId, sessionId },
                body.ttlSeconds,
            );
            if (!issued.ok) {
                return res.status(issued.reason === 'secret-unavailable' ? 503 : 400)
                    .json({ error: issued.reason === 'secret-unavailable' ? 'Playback temporarily unavailable' : 'Invalid entitlement request' });
            }
            return res.status(201).json({
                token: issued.token,
                jti: issued.claims.jti,
                lessonId,
                expiresIn: issued.expiresIn,
            });
        } catch (error) {
            console.error('Playback entitlement issue error:', error);
            return res.status(500).json({ error: 'Failed to issue entitlement' });
        }
    });

    /* --------------------------------------------------------------------- */
    /* POST /playback/entitlements/revoke — tenant-scoped revocation           */
    /* --------------------------------------------------------------------- */
    router.post('/playback/entitlements/revoke', deps.authenticate, async (req: AuthRequest, res: Response) => {
        try {
            const principal = req.user;
            if (!principal) return res.status(401).json({ error: 'Authentication required' });
            const body = (req.body ?? {}) as Record<string, unknown>;
            const jti = normalizeAssetId(body.jti);
            if (!jti) return res.status(400).json({ error: 'jti is required' });
            const record = await deps.entitlement.load(jti);
            if (!record) return res.status(404).json({ error: 'Entitlement not found' });
            const isPlatformAdmin = deps.isPlatformAdmin ? await deps.isPlatformAdmin(principal.id) : false;
            if (!isPlatformAdmin && record.tenantId !== principal.tenantId) {
                return res.status(403).json({ error: 'Forbidden' });
            }
            const reason = typeof body.reason === 'string' ? body.reason : 'revoked';
            const result = await deps.entitlement.revoke(jti, reason, principal.id);
            if (!result.revoked) return res.status(404).json({ error: 'Entitlement not found' });
            return res.json({ revoked: true, jti });
        } catch (error) {
            console.error('Playback entitlement revoke error:', error);
            return res.status(500).json({ error: 'Failed to revoke entitlement' });
        }
    });

    /* --------------------------------------------------------------------- */
    /* POST /usage/heartbeat — client watch heartbeat (tenant-attributed)      */
    /* --------------------------------------------------------------------- */
    router.post('/usage/heartbeat', deps.authenticate, async (req: AuthRequest, res: Response) => {
        try {
            const principal = req.user;
            if (!principal) return res.status(401).json({ error: 'Authentication required' });
            if (!principal.tenantId || !principal.studentEnrollmentId) {
                return res.status(403).json({ error: 'A student workspace is required' });
            }
            const body = (req.body ?? {}) as Record<string, unknown>;
            const sessionId = normalizeAssetId(body.sessionId);
            if (!sessionId) return res.status(400).json({ error: 'sessionId is required' });
            const dedupeKey = buildHeartbeatDedupeKey(sessionId, now(), heartbeatWindow);
            if (!dedupeKey) return res.status(400).json({ error: 'Invalid heartbeat' });

            const input: UsageEventInput = {
                tenantId: principal.tenantId,
                kind: 'watch',
                dedupeKey,
                sessionId,
                studentEnrollmentId: principal.studentEnrollmentId,
                watchSeconds: body.deltaSeconds,
                source: 'heartbeat',
                assetId: typeof body.assetId === 'string' ? body.assetId : undefined,
            };
            const result = await deps.usage.record(input);
            if ('error' in result) return res.status(400).json({ error: result.error });
            return res.json({ recorded: result.recorded, deduplicated: result.deduplicated });
        } catch (error) {
            console.error('Usage heartbeat error:', error);
            return res.status(500).json({ error: 'Failed to record heartbeat' });
        }
    });

    /* --------------------------------------------------------------------- */
    /* POST /usage/provider — signature-gated storage/watch callback           */
    /* --------------------------------------------------------------------- */
    router.post('/usage/provider', async (req: AuthRequest, res: Response) => {
        try {
            const body = (req.body ?? {}) as Record<string, unknown>;
            const provider = normalizeProviderKey(body.provider);
            const eventId = typeof body.event_id === 'string' ? body.event_id : '';
            const tenantId = typeof body.tenant_id === 'string' ? body.tenant_id.trim() : '';
            const signature = typeof body.signature === 'string' ? body.signature : '';
            const kind = normalizeUsageKind(body.kind);
            const callback: UsageCallbackInput = {
                provider: provider ?? '',
                eventId,
                tenantId,
                kind: kind ?? '',
                signature,
                watchSeconds: typeof body.watch_seconds === 'number' ? body.watch_seconds : undefined,
                storageBytes: typeof body.storage_bytes === 'number' ? body.storage_bytes : undefined,
                assetId: typeof body.asset_id === 'string' ? body.asset_id : undefined,
            };

            let verified = false;
            if (deps.verifyUsageCallback) {
                try {
                    verified = Boolean(await deps.verifyUsageCallback(callback));
                } catch {
                    verified = false;
                }
            }
            if (!verified || !provider || !kind || !tenantId) {
                return res.status(202).json({ outcome: 'ignored', reason: 'unverified-signature' });
            }
            const dedupeKey = buildProviderDedupeKey(provider, eventId);
            if (!dedupeKey) return res.status(400).json({ error: 'event_id is required' });
            const result = await deps.usage.record({
                tenantId,
                kind,
                dedupeKey,
                assetId: callback.assetId,
                watchSeconds: callback.watchSeconds,
                storageBytes: callback.storageBytes,
                source: 'provider',
            });
            if ('error' in result) return res.status(400).json({ error: result.error });
            return res.json({ recorded: result.recorded, deduplicated: result.deduplicated });
        } catch (error) {
            console.error('Usage provider callback error:', error);
            return res.status(500).json({ error: 'Failed to record usage' });
        }
    });

    /* --------------------------------------------------------------------- */
    /* GET /usage/summary — tenant-scoped reconciliation totals                */
    /* --------------------------------------------------------------------- */
    router.get('/usage/summary', deps.authenticate, async (req: AuthRequest, res: Response) => {
        try {
            const scope = requireTenant(req, res);
            if (!scope) return;
            if (!isStaffRole(req.user!.role)) return res.status(403).json({ error: 'Staff access required' });
            const [watchSeconds, storageBytes] = await Promise.all([
                deps.usage.watchSeconds(scope.tenantId),
                deps.usage.storageBytes(scope.tenantId),
            ]);
            return res.json({ tenantId: scope.tenantId, watchSeconds, storageBytes });
        } catch (error) {
            console.error('Usage summary error:', error);
            return res.status(500).json({ error: 'Failed to load usage summary' });
        }
    });

    return router;
}

interface AssetProjectionSource {
    id: string;
    provider: string;
    providerAssetId: string;
    title: string;
    status: string;
    attempts: number;
    maxAttempts: number;
    deadLettered: boolean;
    deadLetterReason: string | null;
}

function projectAsset(asset: AssetProjectionSource): Record<string, unknown> {
    return {
        id: asset.id,
        provider: asset.provider,
        provider_asset_id: asset.providerAssetId,
        title: asset.title,
        status: asset.status,
        attempts: asset.attempts,
        max_attempts: asset.maxAttempts,
        dead_lettered: asset.deadLettered,
        dead_letter_reason: asset.deadLetterReason,
    };
}

/* =========================================================================
 * Production wiring (not mounted here — the caller owns the mount path)
 * ========================================================================= */

let dbModule: typeof import('../db') | null = null;
const loadDb = async (): Promise<typeof import('../db')> => {
    dbModule ??= await import('../db');
    return dbModule;
};

const lazyDb = {
    query: async <T = unknown>(sql: string, params?: unknown[]): Promise<T[]> => {
        const { query } = await loadDb();
        return query<T>(sql, params as never) as Promise<T[]>;
    },
    queryOne: async <T = unknown>(sql: string, params?: unknown[]): Promise<T | null> => {
        const { queryOne } = await loadDb();
        return queryOne<T>(sql, params as never) as Promise<T | null>;
    },
    execute: async (sql: string, params?: unknown[]): Promise<{ insertId?: number; affectedRows?: number }> => {
        const { execute } = await loadDb();
        return execute(sql, params as never);
    },
};

function constantTimeEqualHex(expectedHex: string, suppliedHex: string): boolean {
    if (!/^[0-9a-f]+$/i.test(suppliedHex) || expectedHex.length !== suppliedHex.length) return false;
    return crypto.timingSafeEqual(Buffer.from(expectedHex, 'hex'), Buffer.from(suppliedHex, 'hex'));
}

/** HMAC provider-callback verifier; a missing secret or signature fails closed. */
function verifyProviderCallbackFromEnv(callback: ProviderCallbackInput): boolean {
    const secret = process.env.VIDEO_CALLBACK_SECRET?.trim();
    if (!secret || !callback.signature) return false;
    const expected = crypto.createHmac('sha256', secret)
        .update([callback.provider, callback.callbackId, callback.providerAssetId, String(callback.targetState), callback.tenantId ?? ''].join('\n'))
        .digest('hex');
    return constantTimeEqualHex(expected, callback.signature);
}

function verifyUsageCallbackFromEnv(callback: UsageCallbackInput): boolean {
    const secret = process.env.VIDEO_CALLBACK_SECRET?.trim();
    if (!secret || !callback.signature) return false;
    const expected = crypto.createHmac('sha256', secret)
        .update([callback.provider, callback.eventId, callback.tenantId, callback.kind].join('\n'))
        .digest('hex');
    return constantTimeEqualHex(expected, callback.signature);
}

export default createVideoAssetsRouter({
    authenticate: async (req, res, next) => {
        const { authenticateToken } = await import('../middleware/auth');
        return authenticateToken(req, res, next);
    },
    lifecycle: createVideoAssetLifecycle({
        store: createSqlVideoAssetStore(lazyDb),
        verifyCallbackSignature: verifyProviderCallbackFromEnv,
    }),
    entitlement: createPlaybackEntitlementService({
        store: createSqlPlaybackEntitlementStore(lazyDb),
        getSecret: () => process.env.VIDEO_PLAYBACK_SECRET || process.env.JWT_SECRET,
    }),
    usage: createVideoUsageEventService({ store: createSqlVideoUsageStore(lazyDb) }),
    resolveLessonScope: async (lessonId) => {
        const row = await lazyDb.queryOne<{ tenant_id: string }>(
            `SELECT c.tenant_id FROM lectures l INNER JOIN courses c ON c.id = l.course_id WHERE l.id = ? LIMIT 1`,
            [lessonId],
        );
        return row ? { tenantId: row.tenant_id } : null;
    },
    verifyUsageCallback: verifyUsageCallbackFromEnv,
});
