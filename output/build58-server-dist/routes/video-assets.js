"use strict";
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
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.createVideoAssetsRouter = createVideoAssetsRouter;
exports.verifyUsageCallbackFromEnv = verifyUsageCallbackFromEnv;
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
const crypto_1 = __importDefault(require("crypto"));
const express_1 = require("express");
const video_asset_lifecycle_1 = require("../services/video-asset-lifecycle");
const playback_entitlement_1 = require("../services/playback-entitlement");
const video_usage_events_1 = require("../services/video-usage-events");
const content_access_1 = require("./content-access");
const content_release_1 = require("../services/content-release");
/**
 * Bounded, fixed-label failure logging.
 *
 * A raw driver or provider error object carries `sql`, `sqlMessage`, bound
 * parameters, request URLs and — on the delivery and callback paths — ticket,
 * token and signature material, so printing it writes all of that into the
 * server log. Only the fixed label is emitted; the object's message, code and
 * shape are never echoed, and no request data is interpolated into it.
 */
const logVideoAssetFailure = (label, error) => {
    void error;
    console.error(`[VideoAssets] ${label}`);
};
const isStaffRole = (role) => role !== undefined && role !== 'student';
function createVideoAssetsRouter(deps) {
    const router = (0, express_1.Router)();
    const now = deps.now ?? (() => Date.now());
    const heartbeatWindow = deps.heartbeatWindowSeconds ?? video_usage_events_1.DEFAULT_HEARTBEAT_WINDOW_SECONDS;
    const heartbeatLimits = deps.heartbeatLimits ?? {};
    const heartbeatLimitWindow = heartbeatLimits.windowSeconds ?? video_usage_events_1.DEFAULT_HEARTBEAT_ENROLLMENT_WINDOW_SECONDS;
    const maxHeartbeatsPerEnrollment = heartbeatLimits.maxEventsPerEnrollment ?? video_usage_events_1.DEFAULT_MAX_HEARTBEAT_EVENTS_PER_ENROLLMENT;
    const maxHeartbeatSecondsPerEnrollment = heartbeatLimits.maxSecondsPerEnrollment ?? video_usage_events_1.DEFAULT_MAX_HEARTBEAT_SECONDS_PER_ENROLLMENT;
    const requireTenant = (req, res) => {
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
    router.post('/assets', deps.authenticate, async (req, res) => {
        try {
            const scope = requireTenant(req, res);
            if (!scope)
                return;
            const principal = req.user;
            if (!isStaffRole(principal.role))
                return res.status(403).json({ error: 'Staff access required' });
            const provider = (0, video_asset_lifecycle_1.normalizeProviderKey)(req.body?.provider);
            const providerAssetId = (0, video_asset_lifecycle_1.normalizeProviderKey)(req.body?.provider_asset_id);
            if (!provider || !providerAssetId) {
                return res.status(400).json({ error: 'provider and provider_asset_id are required' });
            }
            const title = req.body?.title;
            const result = await deps.lifecycle.registerAsset({
                tenantId: scope.tenantId,
                ownerUserId: principal.id,
                provider,
                providerAssetId,
                title: typeof title === 'string' ? title : undefined,
            });
            if (!result.ok)
                return res.status(400).json({ error: 'Invalid asset registration' });
            return res.status(201).json({ id: result.id, status: result.state });
        }
        catch (error) {
            logVideoAssetFailure('Asset registration failed', error);
            return res.status(500).json({ error: 'Failed to register asset' });
        }
    });
    /* --------------------------------------------------------------------- */
    /* GET /assets/:assetId — tenant + owner scoped read                       */
    /* --------------------------------------------------------------------- */
    router.get('/assets/:assetId', deps.authenticate, async (req, res) => {
        try {
            const scope = requireTenant(req, res);
            if (!scope)
                return;
            const assetId = (0, video_asset_lifecycle_1.normalizeAssetId)(req.params.assetId);
            if (!assetId)
                return res.status(404).json({ error: 'Asset not found' });
            const asset = await deps.lifecycle.getAsset(scope.tenantId, assetId);
            if (!asset)
                return res.status(404).json({ error: 'Asset not found' });
            const isMaster = asset.ownerUserId === req.user.id || req.user.role === 'admin';
            if (!isMaster)
                return res.status(403).json({ error: 'Forbidden' });
            return res.json(projectAsset(asset));
        }
        catch (error) {
            logVideoAssetFailure('Asset read failed', error);
            return res.status(500).json({ error: 'Failed to load asset' });
        }
    });
    /* --------------------------------------------------------------------- */
    /* POST /assets/:assetId/processing — owner starts/retries processing      */
    /* --------------------------------------------------------------------- */
    router.post('/assets/:assetId/processing', deps.authenticate, async (req, res) => {
        try {
            const scope = requireTenant(req, res);
            if (!scope)
                return;
            if (!isStaffRole(req.user.role))
                return res.status(403).json({ error: 'Staff access required' });
            const assetId = (0, video_asset_lifecycle_1.normalizeAssetId)(req.params.assetId);
            if (!assetId)
                return res.status(404).json({ error: 'Asset not found' });
            const asset = await deps.lifecycle.getAsset(scope.tenantId, assetId);
            if (!asset)
                return res.status(404).json({ error: 'Asset not found' });
            if (asset.ownerUserId !== req.user.id && req.user.role !== 'admin') {
                return res.status(403).json({ error: 'Forbidden' });
            }
            const result = await deps.lifecycle.beginProcessing(scope.tenantId, assetId);
            if (result.ok) {
                return res.json({ id: assetId, status: result.state, attempts: result.attempts, dead_lettered: result.deadLettered });
            }
            if (result.reason === 'not-found')
                return res.status(404).json({ error: 'Asset not found' });
            return res.status(409).json({ error: 'Transition not allowed', reason: result.reason, from: result.from });
        }
        catch (error) {
            logVideoAssetFailure('Asset processing failed', error);
            return res.status(500).json({ error: 'Failed to start processing' });
        }
    });
    /* --------------------------------------------------------------------- */
    /* POST /callbacks/:provider — signature-gated provider callback           */
    /* --------------------------------------------------------------------- */
    router.post('/callbacks/:provider', async (req, res) => {
        try {
            const body = (req.body ?? {});
            const result = await deps.lifecycle.applyProviderCallback({
                provider: req.params.provider,
                callbackId: typeof body.callback_id === 'string' ? body.callback_id : '',
                signature: typeof body.signature === 'string' ? body.signature : '',
                providerAssetId: typeof body.provider_asset_id === 'string' ? body.provider_asset_id : '',
                targetState: body.target_state,
                tenantId: typeof body.tenant_id === 'string' ? body.tenant_id : null,
                detail: typeof body.detail === 'string' ? body.detail : null,
                error: typeof body.error === 'string' ? body.error : null,
                storageBytes: typeof body.storage_bytes === 'number' ? body.storage_bytes : null,
            });
            if (result.status === 'ignored')
                return res.status(202).json({ outcome: 'ignored', reason: result.reason });
            if (result.status === 'rejected') {
                return res.status(result.reason === 'cross-tenant' ? 403 : 400)
                    .json({ outcome: 'rejected', reason: result.reason });
            }
            return res.json({
                outcome: result.status,
                status: result.state,
                ...(result.status === 'applied' ? { attempts: result.attempts, dead_lettered: result.deadLettered } : {}),
            });
        }
        catch (error) {
            logVideoAssetFailure('Provider callback failed', error);
            return res.status(500).json({ error: 'Failed to apply callback' });
        }
    });
    /* --------------------------------------------------------------------- */
    /* POST /playback/entitlements — issue a bound short-lived token           */
    /* --------------------------------------------------------------------- */
    router.post('/playback/entitlements', deps.authenticate, async (req, res) => {
        try {
            const principal = req.user;
            if (!principal)
                return res.status(401).json({ error: 'Authentication required' });
            const tenantId = principal.tenantId;
            const studentEnrollmentId = principal.studentEnrollmentId;
            if (!tenantId || !studentEnrollmentId) {
                return res.status(403).json({ error: 'A student workspace is required' });
            }
            const body = (req.body ?? {});
            const lessonId = (0, video_asset_lifecycle_1.normalizeAssetId)(body.lessonId);
            const sessionId = (0, video_asset_lifecycle_1.normalizeAssetId)(body.sessionId);
            if (!lessonId || !sessionId) {
                return res.status(400).json({ error: 'lessonId and sessionId are required' });
            }
            // Compose the SAME content-access policy used by every lesson read:
            // a token is only issued for a published, released lesson that is in
            // the caller's enrollment/audience. A missing or cross-tenant lesson
            // stays a 404 (no enumeration).
            const access = await deps.resolveLessonScope(lessonId, {
                id: principal.id,
                tenantId,
                studentEnrollmentId,
                role: principal.role,
            });
            if (!access || access.tenantId !== tenantId) {
                return res.status(404).json({ error: 'Lesson not found' });
            }
            const decision = (0, content_access_1.evaluateContentAccess)(access);
            if (!decision.allowed) {
                const status = (0, content_access_1.contentAccessDenialStatus)(decision.code);
                return res.status(status).json({
                    error: status === 403 ? 'Lesson is not available yet' : 'Lesson not found',
                });
            }
            const issued = await deps.entitlement.issue({ tenantId, lessonId, studentEnrollmentId, sessionId }, body.ttlSeconds);
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
        }
        catch (error) {
            logVideoAssetFailure('Playback entitlement issue failed', error);
            return res.status(500).json({ error: 'Failed to issue entitlement' });
        }
    });
    /* --------------------------------------------------------------------- */
    /* POST /playback/entitlements/revoke — tenant-scoped revocation           */
    /* --------------------------------------------------------------------- */
    router.post('/playback/entitlements/revoke', deps.authenticate, async (req, res) => {
        try {
            const principal = req.user;
            if (!principal)
                return res.status(401).json({ error: 'Authentication required' });
            const body = (req.body ?? {});
            const jti = (0, video_asset_lifecycle_1.normalizeAssetId)(body.jti);
            if (!jti)
                return res.status(400).json({ error: 'jti is required' });
            const record = await deps.entitlement.load(jti);
            if (!record)
                return res.status(404).json({ error: 'Entitlement not found' });
            // Only the record's own enrollment may revoke it, or a verified
            // tenant admin / platform admin. Same-tenant staff are not enough.
            const ownsRecord = typeof principal.studentEnrollmentId === 'string'
                && principal.studentEnrollmentId.length > 0
                && record.studentEnrollmentId === principal.studentEnrollmentId;
            const isPlatformAdmin = deps.isPlatformAdmin ? await deps.isPlatformAdmin(principal.id) : false;
            const isTenantAdmin = !ownsRecord && !isPlatformAdmin
                && deps.isTenantAdmin !== undefined
                && principal.tenantId === record.tenantId
                ? await deps.isTenantAdmin(principal.id, record.tenantId)
                : false;
            if (!ownsRecord && !isTenantAdmin && !isPlatformAdmin) {
                return res.status(403).json({ error: 'Forbidden' });
            }
            const reason = typeof body.reason === 'string' ? body.reason : 'revoked';
            const result = await deps.entitlement.revoke(jti, reason, principal.id);
            if (!result.revoked)
                return res.status(404).json({ error: 'Entitlement not found' });
            return res.json({ revoked: true, jti });
        }
        catch (error) {
            logVideoAssetFailure('Playback entitlement revoke failed', error);
            return res.status(500).json({ error: 'Failed to revoke entitlement' });
        }
    });
    /* --------------------------------------------------------------------- */
    /* POST /usage/heartbeat — client watch heartbeat (tenant-attributed)      */
    /* --------------------------------------------------------------------- */
    router.post('/usage/heartbeat', deps.authenticate, async (req, res) => {
        try {
            const principal = req.user;
            if (!principal)
                return res.status(401).json({ error: 'Authentication required' });
            if (!principal.tenantId || !principal.studentEnrollmentId) {
                return res.status(403).json({ error: 'A student workspace is required' });
            }
            const body = (req.body ?? {});
            const sessionId = (0, video_asset_lifecycle_1.normalizeAssetId)(body.sessionId);
            const lessonId = (0, video_asset_lifecycle_1.normalizeAssetId)(body.lessonId);
            if (!sessionId || !lessonId)
                return res.status(400).json({ error: 'sessionId and lessonId are required' });
            // A heartbeat must present the server-issued playback entitlement
            // for this exact tenant/enrollment/lesson/session. The client can no
            // longer invent a session id: watch time is bound to a token that
            // passed the content-access policy at issuance.
            const entitlement = await (0, playback_entitlement_1.verifyPlaybackEntitlement)(deps.entitlement, {
                token: body.token,
                tenantId: principal.tenantId,
                lessonId,
                studentEnrollmentId: principal.studentEnrollmentId,
                sessionId,
            });
            if (!entitlement.allowed) {
                return res.status(403).json({ error: 'A valid playback entitlement is required' });
            }
            // Reject an unprovable asset selector FIRST — before the rate limit
            // and before the ledger write — so no side effect records an
            // attribution the server cannot prove. See the note above.
            if (body.assetId !== undefined) {
                return res.status(400).json({ error: 'Asset attribution is not available for watch heartbeats' });
            }
            // One heartbeat can never account for more than one dedupe window of
            // watch time, so a large client delta cannot inflate the aggregate.
            const deltaSeconds = (0, video_usage_events_1.clampHeartbeatSeconds)(body.deltaSeconds, heartbeatWindow);
            if (deltaSeconds === null)
                return res.status(400).json({ error: 'Invalid heartbeat' });
            const nowMs = now();
            const dedupeKey = (0, video_usage_events_1.buildHeartbeatDedupeKey)(entitlement.claims.sessionId, nowMs, heartbeatWindow);
            if (!dedupeKey)
                return res.status(400).json({ error: 'Invalid heartbeat' });
            // Bound the whole enrollment: a burst of distinct session ids is
            // stopped by the per-enrollment event rate limit and aggregate cap.
            const limit = await deps.usage.heartbeatLimit({
                studentEnrollmentId: principal.studentEnrollmentId,
                nowMs,
                windowSeconds: heartbeatLimitWindow,
                maxEventsPerWindow: maxHeartbeatsPerEnrollment,
                maxSecondsPerWindow: maxHeartbeatSecondsPerEnrollment,
            });
            if (!limit.allowed) {
                return res.status(429).json({ error: 'Watch heartbeat limit exceeded', reason: limit.reason });
            }
            // Asset attribution is OPTIONAL and there is no server-side proof
            // available for it, so none is recorded: the event carries the
            // server-proven tenant, enrollment, session and watch seconds only.
            // See the rejection note above for why a client selector is refused
            // rather than trusted.
            const input = {
                tenantId: principal.tenantId,
                kind: 'watch',
                dedupeKey,
                sessionId: entitlement.claims.sessionId,
                studentEnrollmentId: principal.studentEnrollmentId,
                watchSeconds: deltaSeconds,
                source: 'heartbeat',
                occurredAtMs: nowMs,
            };
            const result = await deps.usage.record(input);
            if ('error' in result)
                return res.status(400).json({ error: result.error });
            return res.json({ recorded: result.recorded, deduplicated: result.deduplicated });
        }
        catch (error) {
            logVideoAssetFailure('Usage heartbeat failed', error);
            return res.status(500).json({ error: 'Failed to record heartbeat' });
        }
    });
    /* --------------------------------------------------------------------- */
    /* POST /usage/provider — signature-gated storage/watch callback           */
    /* --------------------------------------------------------------------- */
    router.post('/usage/provider', async (req, res) => {
        try {
            const body = (req.body ?? {});
            const provider = (0, video_asset_lifecycle_1.normalizeProviderKey)(body.provider);
            const eventId = typeof body.event_id === 'string' ? body.event_id : '';
            const tenantId = typeof body.tenant_id === 'string' ? body.tenant_id.trim() : '';
            const signature = typeof body.signature === 'string' ? body.signature : '';
            const kind = (0, video_usage_events_1.normalizeUsageKind)(body.kind);
            const callback = {
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
                }
                catch {
                    verified = false;
                }
            }
            if (!verified || !provider || !kind || !tenantId) {
                return res.status(202).json({ outcome: 'ignored', reason: 'unverified-signature' });
            }
            const dedupeKey = (0, video_usage_events_1.buildProviderDedupeKey)(provider, eventId);
            if (!dedupeKey)
                return res.status(400).json({ error: 'event_id is required' });
            const result = await deps.usage.record({
                tenantId,
                kind,
                dedupeKey,
                assetId: callback.assetId,
                watchSeconds: callback.watchSeconds,
                storageBytes: callback.storageBytes,
                source: 'provider',
            });
            if ('error' in result)
                return res.status(400).json({ error: result.error });
            return res.json({ recorded: result.recorded, deduplicated: result.deduplicated });
        }
        catch (error) {
            logVideoAssetFailure('Usage provider callback failed', error);
            return res.status(500).json({ error: 'Failed to record usage' });
        }
    });
    /* --------------------------------------------------------------------- */
    /* GET /usage/summary — tenant-scoped reconciliation totals                */
    /* --------------------------------------------------------------------- */
    router.get('/usage/summary', deps.authenticate, async (req, res) => {
        try {
            const scope = requireTenant(req, res);
            if (!scope)
                return;
            if (!isStaffRole(req.user.role))
                return res.status(403).json({ error: 'Staff access required' });
            const [watchSeconds, storageBytes] = await Promise.all([
                deps.usage.watchSeconds(scope.tenantId),
                deps.usage.storageBytes(scope.tenantId),
            ]);
            return res.json({ tenantId: scope.tenantId, watchSeconds, storageBytes });
        }
        catch (error) {
            logVideoAssetFailure('Usage summary failed', error);
            return res.status(500).json({ error: 'Failed to load usage summary' });
        }
    });
    return router;
}
function projectAsset(asset) {
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
let dbModule = null;
const loadDb = async () => {
    dbModule ?? (dbModule = await Promise.resolve().then(() => __importStar(require('../db'))));
    return dbModule;
};
const lazyDb = {
    query: async (sql, params) => {
        const { query } = await loadDb();
        return query(sql, params);
    },
    queryOne: async (sql, params) => {
        const { queryOne } = await loadDb();
        return queryOne(sql, params);
    },
    execute: async (sql, params) => {
        const { execute } = await loadDb();
        return execute(sql, params);
    },
};
function constantTimeEqualHex(expectedHex, suppliedHex) {
    if (!/^[0-9a-f]+$/i.test(suppliedHex) || expectedHex.length !== suppliedHex.length)
        return false;
    return crypto_1.default.timingSafeEqual(Buffer.from(expectedHex, 'hex'), Buffer.from(suppliedHex, 'hex'));
}
/** HMAC provider-callback verifier; a missing secret or signature fails closed. */
function verifyProviderCallbackFromEnv(callback) {
    const secret = process.env.VIDEO_CALLBACK_SECRET?.trim();
    if (!secret || !callback.signature)
        return false;
    const payload = [callback.provider, callback.callbackId, callback.providerAssetId, String(callback.targetState), callback.tenantId ?? ''];
    // Byte-bearing callbacks bind the size into the signature so a replay with a
    // mutated `storage_bytes` cannot pass. Byte-less callbacks keep the original
    // payload shape for backward compatibility.
    if (typeof callback.storageBytes === 'number')
        payload.push(String(callback.storageBytes));
    const expected = crypto_1.default.createHmac('sha256', secret)
        .update(payload.join('\n'))
        .digest('hex');
    return constantTimeEqualHex(expected, callback.signature);
}
/**
 * HMAC verifier for the usage callback. The signed payload covers the NUMBERS
 * as well as the identity: a signature that only covered provider/event/tenant/
 * kind would let anyone who captured one valid callback replay it with a
 * rewritten byte or second count, and the meter would then record an
 * unverified number. Values are prefixed so the two optional numeric fields
 * cannot be confused with each other. Callbacks that carry neither a byte nor
 * a second count keep the original four-field payload shape.
 */
function verifyUsageCallbackFromEnv(callback) {
    const secret = process.env.VIDEO_CALLBACK_SECRET?.trim();
    if (!secret || !callback.signature)
        return false;
    const payload = [callback.provider, callback.eventId, callback.tenantId, callback.kind];
    if (typeof callback.storageBytes === 'number')
        payload.push(`bytes=${callback.storageBytes}`);
    if (typeof callback.watchSeconds === 'number')
        payload.push(`seconds=${callback.watchSeconds}`);
    if (typeof callback.assetId === 'string' && callback.assetId)
        payload.push(`asset=${callback.assetId}`);
    const expected = crypto_1.default.createHmac('sha256', secret)
        .update(payload.join('\n'))
        .digest('hex');
    return constantTimeEqualHex(expected, callback.signature);
}
const LESSON_ACCESS_LECTURE_SQL = `
    SELECT l.id, l.course_id, l.instructor_id, l.group_id, l.grade_id,
           l.is_published, l.display_order, l.archived_at, c.tenant_id,
           g.branch_id AS group_branch_id, g.branch_scope AS group_branch_scope
    FROM lectures l
    INNER JOIN courses c ON c.id = l.course_id
    LEFT JOIN \`groups\` g ON g.id = l.group_id
    WHERE l.id = ? LIMIT 1
`;
const LESSON_ACCESS_ENROLLMENT_SQL = `
    SELECT s.id, s.tenant_id, s.instructor_id, s.group_id, s.grade_id,
           g.branch_id AS group_branch_id, g.branch_scope AS group_branch_scope
    FROM students s
    INNER JOIN tenants t ON t.id = s.tenant_id
    LEFT JOIN \`groups\` g ON g.id = s.group_id
    WHERE s.id = ? AND s.user_id = ? AND s.is_active = 1 AND s.approval_status = 'approved' AND t.status = 'active'
      AND (s.enrollment_status IS NULL OR s.enrollment_status = 'active')
      AND (s.enrollment_start_date IS NULL OR s.enrollment_start_date <= UTC_TIMESTAMP())
      AND (s.enrollment_end_date IS NULL OR s.enrollment_end_date > UTC_TIMESTAMP())
    LIMIT 1
`;
const LESSON_ACCESS_POLICY_SQL = `
    SELECT lecture_id, course_id, tenant_id, release_mode, release_at, release_timezone,
           prerequisite_lecture_id, released_at
    FROM lesson_release_policies WHERE lecture_id = ? LIMIT 1
`;
const PREREQUISITE_COMPLETED_SQL = `
    SELECT 1 AS done FROM lesson_completions
    WHERE student_enrollment_id = ? AND lecture_id = ? LIMIT 1
`;
const TENANT_ADMIN_SQL = `
    SELECT 'owner' AS authority
    FROM tenants t
    WHERE t.id = ? AND t.owner_user_id = ? AND t.status = 'active'
    UNION ALL
    SELECT m.role_key AS authority
    FROM tenant_memberships m
    INNER JOIN tenants t ON t.id = m.tenant_id
    INNER JOIN users u ON u.id = m.user_id
    WHERE m.user_id = ? AND m.tenant_id = ? AND m.status = 'active'
      AND t.status = 'active' AND u.is_active = 1 AND m.role_key = 'owner'
    LIMIT 1
`;
function deriveBranchFacts(scope, branchId) {
    const normalized = (scope ?? '').trim().toLowerCase();
    if (normalized === 'branch') {
        return branchId ? { branchId, branchAmbiguous: false } : { branchId: null, branchAmbiguous: true };
    }
    return { branchId: null, branchAmbiguous: false };
}
exports.default = createVideoAssetsRouter({
    authenticate: async (req, res, next) => {
        const { authenticateToken } = await Promise.resolve().then(() => __importStar(require('../middleware/auth')));
        return authenticateToken(req, res, next);
    },
    // Storage metering is deliberately NOT composed here. The durable
    // per-asset transition ledger and its counter table do not exist in the
    // current schema, and the only byte-bearing table (`video_usage_events`)
    // has no transition discriminator and is already summed as absolute
    // observations by `GET /usage/summary` — writing deltas into it would
    // invent column semantics and corrupt that sum. Composing the in-memory
    // adapter here would report `recorded` while losing the number on restart,
    // which is exactly the false success the rules forbid. So the omission is
    // explicit instead of silent: a byte-bearing `ready` callback is audited as
    // `video.asset.metering_unconfigured` and answered with
    // `metering: 'unconfigured'`. Wiring `meterStorage` becomes a one-line
    // addition once I2 provides the tables.
    lifecycle: (0, video_asset_lifecycle_1.createVideoAssetLifecycle)({
        store: (0, video_asset_lifecycle_1.createSqlVideoAssetStore)(lazyDb),
        verifyCallbackSignature: verifyProviderCallbackFromEnv,
    }),
    entitlement: (0, playback_entitlement_1.createPlaybackEntitlementService)({
        store: (0, playback_entitlement_1.createSqlPlaybackEntitlementStore)(lazyDb),
        // F9: a DEDICATED playback secret only. There is deliberately no
        // JWT_SECRET fallback; an unset secret fails closed (issue refuses).
        getSecret: () => process.env.VIDEO_PLAYBACK_SECRET,
    }),
    usage: (0, video_usage_events_1.createVideoUsageEventService)({ store: (0, video_usage_events_1.createSqlVideoUsageStore)(lazyDb) }),
    resolveLessonScope: async (lessonId, principal) => {
        const lecture = await lazyDb.queryOne(LESSON_ACCESS_LECTURE_SQL, [lessonId]);
        if (!lecture)
            return null;
        const enrollment = principal.studentEnrollmentId
            ? await lazyDb.queryOne(LESSON_ACCESS_ENROLLMENT_SQL, [principal.studentEnrollmentId, principal.id])
            : null;
        const policyRow = await lazyDb.queryOne(LESSON_ACCESS_POLICY_SQL, [lessonId]);
        const policy = (0, content_release_1.buildLessonReleasePolicy)(lecture, policyRow);
        let prerequisiteCompleted = false;
        if (policy.releaseMode === 'sequential' && policy.prerequisiteLectureId && enrollment) {
            const done = await lazyDb.queryOne(PREREQUISITE_COMPLETED_SQL, [enrollment.id, policy.prerequisiteLectureId]);
            prerequisiteCompleted = done !== null;
        }
        const lectureBranch = deriveBranchFacts(lecture.group_branch_scope, lecture.group_branch_id);
        const enrollmentBranch = enrollment
            ? deriveBranchFacts(enrollment.group_branch_scope, enrollment.group_branch_id)
            : null;
        return {
            tenantId: lecture.tenant_id,
            isStaff: principal.role !== 'student',
            lecture: {
                tenantId: lecture.tenant_id,
                instructorId: lecture.instructor_id,
                groupId: lecture.group_id,
                gradeId: lecture.grade_id,
                branchId: lectureBranch.branchId,
                branchAmbiguous: lectureBranch.branchAmbiguous,
                isPublished: Boolean(lecture.is_published),
                archived: lecture.archived_at !== null && lecture.archived_at !== undefined,
                displayOrder: Number(lecture.display_order ?? 0),
            },
            enrollment: enrollment ? {
                id: enrollment.id,
                tenantId: enrollment.tenant_id,
                instructorId: enrollment.instructor_id,
                groupId: enrollment.group_id,
                gradeId: enrollment.grade_id,
                branchId: enrollmentBranch?.branchId ?? null,
            } : null,
            policy,
            prerequisiteCompleted,
            now: new Date(),
        };
    },
    isTenantAdmin: async (userId, tenantId) => {
        const row = await lazyDb.queryOne(TENANT_ADMIN_SQL, [tenantId, userId, userId, tenantId]);
        return row !== null;
    },
    verifyUsageCallback: verifyUsageCallbackFromEnv,
});
