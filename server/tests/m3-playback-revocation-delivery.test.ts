/**
 * W3 — revoking a playback session must stop the NEXT byte request.
 *
 * These tests drive the REAL production seams end to end:
 *   - `createSqlPlaybackSessionStore` (the durable slot table) for the revoke,
 *   - `createSqlPlaybackEntitlementStore` + `createPlaybackEntitlementService`
 *     (the durable per-session entitlement rows) for issuance/revocation,
 *   - `createPlaybackSessionsRouter` for self/support authority,
 *   - `createSecureVideoDeliveryRouter` for manifest/media/key/refresh.
 *
 * The SQL adapter is exercised against a stateful in-memory database that
 * honours `transaction` with rollback, so the real statements (and their
 * atomic boundary) run; nothing is mirrored into a predicate. No database,
 * network, provider or listener is contacted.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Readable, Writable } from 'node:stream';
import type { Router } from 'express';
import type { PlaybackStoreDb } from '../src/services/playback-session-registry';
import type { PlaybackEntitlementService } from '../src/services/playback-entitlement';
import type { SecureVideoDeliveryDeps, VideoLessonAssociation } from '../src/routes/secure-video';
import { invokeRoute } from './helpers/m2-harness';

/**
 * `secure-video.ts` transitively builds the MinIO client, which requires
 * credentials at import time. Hermetic dummies are set BEFORE those modules
 * load; both the MinIO client and the MySQL pool stay lazy, so no connection
 * is opened and no network is touched.
 */
process.env.MINIO_ACCESS_KEY ??= 'w3-test-access-key';
process.env.MINIO_SECRET_KEY ??= 'w3-test-secret-key';

const {
    createSqlPlaybackSessionStore,
} = require('../src/services/playback-session-registry') as typeof import('../src/services/playback-session-registry');
const {
    createPlaybackEntitlementService,
    createSqlPlaybackEntitlementStore,
} = require('../src/services/playback-entitlement') as typeof import('../src/services/playback-entitlement');
const {
    createSecureVideoDeliveryRouter,
} = require('../src/routes/secure-video') as typeof import('../src/routes/secure-video');
const {
    createPlaybackSessionsRouter,
} = require('../src/routes/playback-sessions') as typeof import('../src/routes/playback-sessions');
const {
    createVideoSession,
    getActiveSession,
    getUserActiveSessionId,
    readDurableSessionStatus,
    VideoSessionPersistenceError,
} = require('../src/services/video-security') as typeof import('../src/services/video-security');

const SECRET = 'w3-hermetic-playback-secret-0123456789';
const BASE_MS = 1_700_000_000_000;

interface SlotState {
    id: string;
    tenant_id: string;
    user_id: string;
    device_id: string;
    session_id: string;
    status: string;
    started_at: string;
    last_heartbeat_at: string;
    ended_at: string | null;
    ended_reason: string | null;
}

interface EntitlementState {
    jti: string;
    tenant_id: string;
    lesson_id: string;
    student_enrollment_id: string;
    session_id: string;
    issued_at: string;
    expires_at: string;
    revoked_at: string | null;
    revoke_reason: string | null;
}

interface AuditState {
    action: string;
    actorId: string | null;
    sessionId: string | null;
    reason: string | null;
    inTransaction: boolean;
}

interface DeviceState {
    id: string;
    tenant_id: string;
    user_id: string;
    device_fingerprint: string;
    device_label: string | null;
    status: string;
    first_seen_at: string;
    last_seen_at: string;
    revoked_at: string | null;
    revoked_by: string | null;
    revoke_reason: string | null;
}

type Failure = 'entitlement-revoke' | 'audit-insert' | null;

interface DurableWorld {
    slots: Map<string, SlotState>;
    devices: Map<string, DeviceState>;
    entitlements: Map<string, EntitlementState>;
    videoSessions: Map<string, { is_active: number }>;
    audits: AuditState[];
    failure: Failure;
    /** Makes the `video_sessions` read throw, i.e. an unreadable session store. */
    readFailure: 'video-sessions' | null;
    statements: string[];
}

const iso = (ms: number): string => new Date(ms).toISOString();
const mysql = (ms: number): string => iso(ms).slice(0, 19).replace('T', ' ');

const createWorld = (): DurableWorld => ({
    slots: new Map(),
    devices: new Map(),
    entitlements: new Map(),
    videoSessions: new Map(),
    audits: [],
    failure: null,
    readFailure: null,
    statements: [],
});

/**
 * Stateful stand-in for the MySQL pool: the exact statements emitted by the
 * two SQL stores are answered from real state, and `transaction` snapshots and
 * restores that state so a mid-transaction failure is observable as a rollback.
 */
const createDurableDb = (world: DurableWorld) => {
    const snapshot = () => ({
        slots: new Map([...world.slots].map(([key, value]) => [key, { ...value }])),
        devices: new Map([...world.devices].map(([key, value]) => [key, { ...value }])),
        entitlements: new Map([...world.entitlements].map(([key, value]) => [key, { ...value }])),
        audits: world.audits.map((entry) => ({ ...entry })),
    });
    const restore = (snap: ReturnType<typeof snapshot>) => {
        world.slots = snap.slots;
        world.devices = snap.devices;
        world.entitlements = snap.entitlements;
        world.audits = snap.audits;
    };

    const rows = (sql: string, params: unknown[]): unknown[] => {
        if (/FROM playback_tenant_policies/.test(sql)) return [];
        if (/FROM playback_devices WHERE id = \?/.test(sql)) {
            const device = world.devices.get(String(params[0]));
            return device ? [{ ...device }] : [];
        }
        if (/SELECT status FROM playback_session_slots/.test(sql)) {
            const slot = world.slots.get(String(params[0]));
            return slot ? [{ status: slot.status }] : [];
        }
        if (/FROM playback_session_slots WHERE session_id = \?/.test(sql)) {
            const slot = world.slots.get(String(params[0]));
            return slot ? [{ ...slot }] : [];
        }
        if (/FROM playback_entitlements WHERE session_id = \?/.test(sql)) {
            return [...world.entitlements.values()]
                .filter((row) => row.session_id === String(params[0]))
                .sort((a, b) => (a.issued_at < b.issued_at ? 1 : -1))
                .map((row) => ({ ...row }));
        }
        if (/SELECT revoked_at FROM playback_entitlements WHERE jti = \?/.test(sql)) {
            const row = world.entitlements.get(String(params[0]));
            return row ? [{ revoked_at: row.revoked_at }] : [];
        }
        if (/FROM video_sessions WHERE id = \?/.test(sql)) {
            if (world.readFailure === 'video-sessions') throw new Error('session store unavailable');
            const row = world.videoSessions.get(String(params[0]));
            return row ? [{ ...row }] : [];
        }
        // Session-creation reads used by the positive control.
        if (/FROM video_security_consents/.test(sql)) return [{ id: 'consent-1' }];
        if (/SELECT v\.\*/.test(sql) && /FROM videos v/.test(sql)) {
            return [{ id: 'video-1', is_encrypted: 1, hls_key: 'hls/key', original_key: 'orig/key' }];
        }
        if (/SELECT name, phone FROM users/.test(sql)) return [{ name: 'Student', phone: '01001234567' }];
        if (/SELECT s\.name, g\.name as group_name/.test(sql)) return [{ name: 'Student', group_name: 'Group A' }];
        if (/SELECT \* FROM videos/.test(sql)) return [{ is_encrypted: 1, hls_key: 'hls/key', original_key: 'orig/key' }];
        if (/SELECT encryption_key, is_encrypted/.test(sql)) return [{ is_encrypted: 1, encryption_key: '00112233' }];
        return [];
    };

    const mutate = (sql: string, params: unknown[]): { affectedRows: number } => {
        // The device cascade targets `device_id`, so it must be matched before
        // the session-id branch below (same statement prefix, different column).
        if (/UPDATE playback_session_slots SET status = 'revoked'/.test(sql) && /WHERE device_id = \?/.test(sql)) {
            let affected = 0;
            for (const slot of world.slots.values()) {
                if (slot.device_id === String(params[1]) && slot.status === 'active') {
                    slot.status = 'revoked';
                    slot.ended_at = iso(BASE_MS);
                    slot.ended_reason = String(params[0]);
                    affected += 1;
                }
            }
            return { affectedRows: affected };
        }
        if (/UPDATE playback_devices SET status = 'revoked'/.test(sql)) {
            const device = world.devices.get(String(params[2]));
            if (!device || device.status !== 'active') return { affectedRows: 0 };
            device.status = 'revoked';
            device.revoked_at = iso(BASE_MS);
            device.revoked_by = String(params[0]);
            device.revoke_reason = String(params[1]);
            return { affectedRows: 1 };
        }
        if (/UPDATE playback_session_slots SET status = 'revoked'/.test(sql)) {
            const slot = world.slots.get(String(params[1]));
            if (!slot || slot.status !== 'active') return { affectedRows: 0 };
            slot.status = 'revoked';
            slot.ended_at = iso(BASE_MS);
            slot.ended_reason = String(params[0]);
            return { affectedRows: 1 };
        }
        if (/UPDATE playback_session_slots SET status = 'ended'/.test(sql)) {
            const slot = world.slots.get(String(params[1]));
            if (!slot || slot.status !== 'active') return { affectedRows: 0 };
            slot.status = 'ended';
            slot.ended_at = iso(BASE_MS);
            slot.ended_reason = String(params[0]);
            return { affectedRows: 1 };
        }
        if (/UPDATE playback_entitlements\s+SET revoked_at = \?/.test(sql)) {
            if (world.failure === 'entitlement-revoke') throw new Error('entitlement store unavailable');
            const sessionId = String(params[2]);
            let affected = 0;
            for (const row of world.entitlements.values()) {
                if (row.session_id === sessionId && row.revoked_at === null) {
                    row.revoked_at = String(params[0]);
                    row.revoke_reason = String(params[1]);
                    affected += 1;
                }
            }
            return { affectedRows: affected };
        }
        if (/INSERT INTO playback_entitlements/.test(sql)) {
            const [jti, tenantId, lessonId, enrollmentId, sessionId, issuedAt, expiresAt] = params.map(String);
            if (!world.entitlements.has(jti)) {
                world.entitlements.set(jti, {
                    jti,
                    tenant_id: tenantId,
                    lesson_id: lessonId,
                    student_enrollment_id: enrollmentId,
                    session_id: sessionId,
                    issued_at: issuedAt,
                    expires_at: expiresAt,
                    revoked_at: null,
                    revoke_reason: null,
                });
            }
            return { affectedRows: 1 };
        }
        return { affectedRows: 1 };
    };

    const build = (inTransaction: boolean): PlaybackStoreDb => {
        const db: PlaybackStoreDb = {
            query: async <T = unknown>(sql: string, params: unknown[] = []): Promise<T[]> => {
                world.statements.push(`query: ${sql.replace(/\s+/g, ' ').trim()}`);
                return rows(sql, params) as T[];
            },
            queryOne: async <T = unknown>(sql: string, params: unknown[] = []): Promise<T | null> => {
                world.statements.push(`queryOne: ${sql.replace(/\s+/g, ' ').trim()}`);
                const result = rows(sql, params);
                return (result[0] ?? null) as T | null;
            },
            execute: async (sql: string, params: unknown[] = []) => {
                world.statements.push(`execute: ${sql.replace(/\s+/g, ' ').trim()}`);
                return mutate(sql, params);
            },
        };
        if (!inTransaction) {
            db.transaction = async <T>(fn: (tx: PlaybackStoreDb) => Promise<T>): Promise<T> => {
                const snap = snapshot();
                try {
                    return await fn(build(true));
                } catch (error) {
                    restore(snap);
                    throw error;
                }
            };
        }
        return db;
    };

    return build(false);
};

interface TestSession {
    sessionId: string;
    userId: string;
    videoId: string;
    ip: string;
    userAgent: string;
    fingerprint: string;
    screenRes: string;
    createdAt: number;
    lastHeartbeat: number;
    violationScore: number;
    isActive: boolean;
    previewOnly: boolean;
    studentEnrollmentId?: string;
    tenantId?: string;
    segmentRequests: number[];
    manifestRequests: number[];
    keyRequests: number[];
    activeMediaRequests: number;
}

const makeSession = (sessionId: string, overrides: Partial<TestSession> = {}): TestSession => ({
    sessionId,
    userId: 'student-1',
    videoId: 'video-1',
    ip: '10.0.0.1',
    userAgent: 'hermetic-agent',
    fingerprint: 'fp-1',
    screenRes: '1920x1080',
    createdAt: BASE_MS,
    lastHeartbeat: BASE_MS,
    violationScore: 0,
    isActive: true,
    previewOnly: false,
    studentEnrollmentId: 'enroll-1',
    tenantId: 'tenant-1',
    segmentRequests: [],
    manifestRequests: [],
    keyRequests: [],
    activeMediaRequests: 0,
    ...overrides,
});

class DeliveryResponse extends Writable {
    statusCode?: number;
    body?: Record<string, unknown>;
    headers: Record<string, string> = {};
    chunks: Buffer[] = [];

    _write(chunk: unknown, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
        this.chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
        callback();
    }

    status(code: number): this {
        this.statusCode = code;
        return this;
    }

    json(payload: unknown): this {
        this.statusCode ??= 200;
        this.body = payload as Record<string, unknown>;
        this.end();
        return this;
    }

    set(field: string | Record<string, string>, value?: string): this {
        if (typeof field === 'string') this.headers[field.toLowerCase()] = value ?? '';
        else for (const [key, headerValue] of Object.entries(field)) this.headers[key.toLowerCase()] = headerValue;
        return this;
    }

    send(payload: unknown): this {
        this.statusCode ??= 200;
        if (Buffer.isBuffer(payload)) this.chunks.push(payload);
        else if (typeof payload === 'string') this.chunks.push(Buffer.from(payload));
        else this.body = payload as Record<string, unknown>;
        this.end();
        return this;
    }
}

interface DeliveryInvocation {
    method: 'GET' | 'POST';
    path: string;
    query?: Record<string, string>;
    body?: Record<string, unknown>;
}

const invokeDelivery = async (router: Router, invocation: DeliveryInvocation) => {
    const response = new DeliveryResponse();
    const search = invocation.query ? `?${new URLSearchParams(invocation.query).toString()}` : '';
    const url = `${invocation.path}${search}`;
    const request: Record<string, unknown> = {
        method: invocation.method,
        url,
        originalUrl: url,
        headers: { 'user-agent': 'hermetic-agent' },
        body: invocation.body ?? {},
        query: invocation.query ?? {},
        params: {},
    };
    (router as unknown as (req: Record<string, unknown>, res: DeliveryResponse, next: () => void) => void)(
        request, response, () => undefined,
    );
    await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('delivery route did not settle')), 2000);
        const finish = () => { clearTimeout(timer); resolve(); };
        if (response.writableEnded) return finish();
        response.once('finish', finish);
        response.once('close', finish);
    });
    return {
        status: response.statusCode ?? (response.writableEnded ? 200 : 0),
        body: response.body,
        text: Buffer.concat(response.chunks).toString('utf8'),
        chunks: response.chunks,
        headers: response.headers,
    };
};

const mediaQuery = (sessionId: string) => ({ sid: sessionId, token: `tok-${sessionId}` });

/**
 * One durable world + two independent delivery "processes", each with its own
 * session cache, plus the real playback-session router over the same durable
 * store. The caches are the only thing the instances do not share.
 */
const createHarness = (
    options: { association?: VideoLessonAssociation; createFails?: boolean } = {},
) => {
    const world = createWorld();
    const db = createDurableDb(world);
    const entitlementStore = createSqlPlaybackEntitlementStore(db);
    const clock = { nowMs: BASE_MS };
    const entitlement: PlaybackEntitlementService = createPlaybackEntitlementService({
        store: entitlementStore,
        getSecret: () => SECRET,
        now: () => clock.nowMs,
        idFactory: () => `jti-${world.entitlements.size + 1}`,
    });

    const makeProcess = () => {
        const cache = new Map<string, TestSession>();
        const deps: SecureVideoDeliveryDeps = {
            authenticate: (req, _res, next) => {
                (req as { user?: unknown }).user = {
                    id: 'student-1', email: null, phone: null, role: 'student',
                    tenantId: 'tenant-1', studentEnrollmentId: 'enroll-1',
                };
                next();
            },
            queryOne: <T = unknown>(sql: string, params: unknown[] = []) => db.queryOne<T>(sql, params),
            execute: async () => ({ affectedRows: 1 }),
            getActiveSession: (sessionId) => cache.get(sessionId) ?? null,
            createVideoSession: async (params) => {
                // Mirrors the production fail-closed create: a session is only
                // published after its durable row exists.
                if (options.createFails) throw new Error('session_persist_failed');
                const sessionId = 'sess-durable-1';
                cache.set(sessionId, makeSession(sessionId, {
                    userId: params.userId,
                    videoId: params.videoId,
                    previewOnly: params.previewOnly ?? false,
                    studentEnrollmentId: params.studentEnrollmentId,
                    tenantId: params.tenantId,
                }));
                world.videoSessions.set(sessionId, { is_active: 1 });
                return { sessionId, watermarkSeed: 'watermark-seed' };
            },
            killSession: async (sessionId) => { world.videoSessions.set(sessionId, { is_active: 0 }); },
            isUserSuspended: async () => ({ suspended: false }),
            generateVideoSessionToken: (input) => `tok-${input.sessionId}`,
            verifyVideoSessionToken: (token) => {
                const sessionId = String(token).replace(/^tok-/, '');
                const session = cache.get(sessionId);
                if (!session) return { valid: false, reason: 'unknown session' };
                return {
                    valid: true,
                    decoded: { sid: session.sessionId, sub: session.userId, vid: session.videoId, po: session.previewOnly },
                };
            },
            getClientIp: () => '10.0.0.1',
            hashValue: (value) => `hash:${value}`,
            recordViolation: async () => ({
                suspended: false, score: 0, action: 'none', killed: false,
                restrictions: { qualityCap: null, fullscreenAllowed: true, riskScore: 0 },
            }),
            getThumbnailUrl: async () => 'thumbnail.jpg',
            getUserVideoRestrictions: async () => ({ qualityCap: null, fullscreenAllowed: true, riskScore: 0 }),
            inspectDeliveryRequest: () => ({ allowed: true, release: () => undefined }),
            getObjectBuffer: async () => Buffer.from(
                '#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI="key.bin"\n#EXTINF:4,\nsegment_0.ts\n',
            ),
            getObjectStream: async () => Readable.from([Buffer.from('segment-bytes')]),
            hasVideoAccess: async () => true,
            hasPreviewOffer: async () => false,
            resolveBranch: async () => ({
                kind: 'allowed', scope: 'tenant', branchId: null,
                membershipRole: null, membershipVersion: null, legacyUnclassified: false,
            }),
            resolveVideoLesson: async () => options.association ?? { kind: 'unique', lessonId: 'lesson-1' },
            entitlement,
            now: () => clock.nowMs,
            issueEntitlementTtlSeconds: 300,
            renewBeforeMs: 120_000,
        };
        return { cache, router: createSecureVideoDeliveryRouter(deps) };
    };

    const processA = makeProcess();
    const processB = makeProcess();

    const kills: Array<{ sessionId: string; reason: string }> = [];
    /**
     * `tenantId` mirrors what `resolvePrincipal` derives server-side: admins get
     * no tenant scope at all, staff get their active membership. `admin-3` and
     * `operator-1` therefore reach support with a role label only, and must be
     * authorized by the live capability set (or denied).
     */
    const actors: Record<string, { role: string; tenantId?: string }> = {
        'student-1': { role: 'student', tenantId: 'tenant-1' },
        'student-2': { role: 'student', tenantId: 'tenant-1' },
        'admin-1': { role: 'admin', tenantId: 'tenant-1' },
        'admin-2': { role: 'admin', tenantId: 'tenant-2' },
        'admin-3': { role: 'admin' },
        'staff-2': { role: 'staff', tenantId: 'tenant-2' },
        'operator-1': { role: 'admin' },
    };
    /** Live `security.manage` holders; withdrawal applies to the next request. */
    const capabilities = new Set<string>();
    const capabilityState = { failure: false };
    const killBehaviour: { mode: 'durable' | 'throw' } = { mode: 'durable' };

    const registry = createSqlPlaybackSessionStore(db, {
        audit: async (event, tx) => {
            if (world.failure === 'audit-insert') throw new Error('audit store unavailable');
            world.audits.push({
                action: String(event.action),
                actorId: typeof event.actorId === 'string' ? event.actorId : null,
                sessionId: typeof event.sessionId === 'string' ? event.sessionId : null,
                reason: typeof event.reason === 'string' ? event.reason : null,
                inTransaction: tx !== undefined,
            });
        },
        revokeEntitlements: async (tx, input) => {
            const store = createSqlPlaybackEntitlementStore(tx);
            const revoke = store.revokeBySessionId;
            if (!revoke) throw new Error('entitlement store cannot revoke by session');
            return revoke(input);
        },
    });

    const sessionsRouter = createPlaybackSessionsRouter({
        authenticate: (req, _res, next) => {
            const token = String((req.headers as Record<string, unknown>).authorization ?? '');
            const actorId = token.replace(/^Bearer /, '');
            const actor = actors[actorId];
            if (actor) {
                (req as { user?: unknown }).user = { id: actorId, role: actor.role, tenantId: actor.tenantId };
            }
            next();
        },
        registry,
        killDeliverySession: async (sessionId, reason) => {
            kills.push({ sessionId, reason });
            if (killBehaviour.mode === 'throw') throw new Error('local kill failed');
            world.videoSessions.set(sessionId, { is_active: 0 });
        },
        hasPlatformCapability: async (userId) => {
            if (capabilityState.failure) throw new Error('admin permissions unavailable');
            return capabilities.has(userId);
        },
        now: () => new Date(BASE_MS),
    });

    const seedSession = async (sessionId: string, overrides: { userId?: string; tenantId?: string } = {}) => {
        const userId = overrides.userId ?? 'student-1';
        const tenantId = overrides.tenantId ?? 'tenant-1';
        world.slots.set(sessionId, {
            id: `slot-${sessionId}`,
            tenant_id: tenantId,
            user_id: userId,
            device_id: 'device-1',
            session_id: sessionId,
            status: 'active',
            started_at: iso(BASE_MS),
            last_heartbeat_at: iso(BASE_MS),
            ended_at: null,
            ended_reason: null,
        });
        world.videoSessions.set(sessionId, { is_active: 1 });
        processA.cache.set(sessionId, makeSession(sessionId, { userId, tenantId }));
        await entitlement.issue({ tenantId, lessonId: 'lesson-1', studentEnrollmentId: 'enroll-1', sessionId }, 300);
    };

    const revoke = (sessionId: string, actor: string, kind: 'self' | 'support') =>
        invokeRoute(sessionsRouter, {
            method: 'POST',
            url: kind === 'self' ? `/sessions/${sessionId}/revoke` : `/sessions/${sessionId}/support-revoke`,
            token: actor,
            body: {},
        });

    const seedDevice = (deviceId = 'device-1', overrides: { tenantId?: string; userId?: string } = {}) => {
        world.devices.set(deviceId, {
            id: deviceId,
            tenant_id: overrides.tenantId ?? 'tenant-1',
            user_id: overrides.userId ?? 'student-1',
            device_fingerprint: 'fp-1',
            device_label: null,
            status: 'active',
            first_seen_at: iso(BASE_MS),
            last_seen_at: iso(BASE_MS),
            revoked_at: null,
            revoked_by: null,
            revoke_reason: null,
        });
        return deviceId;
    };

    return {
        world, db, entitlement, entitlementStore, processA, processB, sessionsRouter,
        registry, kills, killBehaviour, seedSession, seedDevice, revoke, clock,
        capabilities, capabilityState,
    };
};

const manifest = (sessionId: string) => ({ method: 'GET' as const, path: '/manifest/video-1/playlist.m3u8', query: mediaQuery(sessionId) });
const media = (sessionId: string) => ({ method: 'GET' as const, path: '/media/video-1', query: { ...mediaQuery(sessionId), path: '480p/segment_0.ts' } });
const key = (sessionId: string) => ({ method: 'GET' as const, path: '/key/video-1', query: mediaQuery(sessionId) });
const refresh = (sessionId: string) => ({
    method: 'POST' as const,
    path: '/refresh-token',
    body: { sessionId, fingerprint: 'fp-1', screenRes: '1920x1080' },
});

/* ------------------------------------------------------------------ */
/* positive controls                                                   */
/* ------------------------------------------------------------------ */

test('w3: session creation issues a durable entitlement and authorized self playback is served', async () => {
    const h = createHarness();
    const created = await invokeDelivery(h.processA.router, {
        method: 'POST', path: '/session', body: { videoId: 'video-1', fingerprint: 'fp-1', screenRes: '1920x1080' },
    });
    assert.equal(created.status, 200, JSON.stringify(created.body));
    const sessionId = String(created.body?.sessionId);
    assert.equal(h.world.entitlements.size, 1, 'issuance must persist a durable record');
    const stored = [...h.world.entitlements.values()][0];
    assert.equal(stored.session_id, sessionId);
    assert.equal(stored.revoked_at, null);

    const first = await invokeDelivery(h.processA.router, manifest(sessionId));
    assert.equal(first.status, 200);
    assert.match(first.text, /#EXTM3U/);
    const segment = await invokeDelivery(h.processA.router, media(sessionId));
    assert.equal(segment.status, 200);
    assert.equal(segment.text, 'segment-bytes');
    const encryptionKey = await invokeDelivery(h.processA.router, key(sessionId));
    assert.equal(encryptionKey.status, 200);
});

test('w3: a support actor with a verified role and matching tenant may revoke; self may revoke', async () => {
    const h = createHarness();
    await h.seedSession('sess-1');
    const support = await h.revoke('sess-1', 'admin-1', 'support');
    assert.equal(support.statusCode, 200, JSON.stringify(support.body));
    assert.equal((support.body as { revoked?: boolean }).revoked, true);
    assert.equal(h.world.audits.length, 1, 'one meaningful revoke event, no duplicates');
    assert.equal(h.world.audits[0].action, 'playback.session.support_revoke');
    assert.equal(h.world.audits[0].actorId, 'admin-1');
    assert.equal(h.world.audits[0].inTransaction, true, 'audit commits inside the durable transaction');

    await h.seedSession('sess-2');
    const self = await h.revoke('sess-2', 'student-1', 'self');
    assert.equal(self.statusCode, 200);
    assert.equal((self.body as { revoked?: boolean }).revoked, true);
    assert.equal(h.world.audits.length, 2);
    assert.equal(h.world.audits[1].action, 'playback.session.self_revoke');
});

test('w3: a foreign user and a foreign-tenant support actor cannot revoke', async () => {
    const h = createHarness();
    await h.seedSession('sess-1');
    const foreign = await h.revoke('sess-1', 'student-2', 'self');
    assert.equal(foreign.statusCode, 403);
    assert.equal((foreign.body as { error?: string }).error, 'not_authorized');
    const foreignTenant = await h.revoke('sess-1', 'admin-2', 'support');
    assert.equal(foreignTenant.statusCode, 403);
    assert.equal((foreignTenant.body as { error?: string }).error, 'tenant_mismatch');
    assert.equal(h.world.slots.get('sess-1')?.status, 'active', 'no cross-tenant effect');
    assert.equal(h.world.audits.length, 0);
    const stillServed = await invokeDelivery(h.processA.router, manifest('sess-1'));
    assert.equal(stillServed.status, 200, 'a denied revoke must not stop playback');
});

/* ------------------------------------------------------------------ */
/* the defect: the NEXT request after a revoke                         */
/* ------------------------------------------------------------------ */

test('w3: after a revoke the NEXT manifest, media, key and refresh requests are denied with no bytes', async () => {
    const h = createHarness();
    await h.seedSession('sess-1');
    assert.equal((await invokeDelivery(h.processA.router, manifest('sess-1'))).status, 200);

    const revoked = await h.revoke('sess-1', 'admin-1', 'support');
    assert.equal(revoked.statusCode, 200, JSON.stringify(revoked.body));

    for (const request of [manifest('sess-1'), media('sess-1'), key('sess-1')]) {
        const denied = await invokeDelivery(h.processA.router, request);
        assert.equal(denied.status, 403, `${request.path} must deny after revoke`);
        assert.equal(denied.chunks.length, 0, `${request.path} must not send bytes`);
        assert.equal(denied.body?.reason, 'revoked');
    }
    const deniedRefresh = await invokeDelivery(h.processA.router, refresh('sess-1'));
    assert.equal(deniedRefresh.status, 403, 'refresh must not mint a token for a revoked session');
    assert.equal(deniedRefresh.body?.reason, 'revoked');
    assert.equal(h.world.entitlements.get('jti-1')?.revoked_at !== null, true);
});

test('w3: a second instance with its own stale session cache is denied by the durable store', async () => {
    const h = createHarness();
    await h.seedSession('sess-1');
    // Process B has never seen this session through its own cache path, so give
    // it the strongest possible stale cache: a fully live session object.
    h.processB.cache.set('sess-1', makeSession('sess-1'));
    assert.equal((await invokeDelivery(h.processB.router, manifest('sess-1'))).status, 200, 'positive control');

    assert.equal((await h.revoke('sess-1', 'admin-1', 'support')).statusCode, 200);

    const denied = await invokeDelivery(h.processB.router, manifest('sess-1'));
    assert.equal(denied.status, 403, 'the durable record, not the local map, must decide');
    assert.equal(denied.body?.reason, 'revoked');
    assert.equal(denied.chunks.length, 0);
    const deniedSegment = await invokeDelivery(h.processB.router, media('sess-1'));
    assert.equal(deniedSegment.status, 403);
    assert.equal(deniedSegment.chunks.length, 0);
    const deniedKey = await invokeDelivery(h.processB.router, key('sess-1'));
    assert.equal(deniedKey.status, 403);
    assert.equal(deniedKey.chunks.length, 0);
    const deniedRefresh = await invokeDelivery(h.processB.router, refresh('sess-1'));
    assert.equal(deniedRefresh.status, 403, 'an independent instance must not mint a token after the revoke');
    assert.equal(deniedRefresh.body?.reason, 'revoked');
    assert.equal(deniedRefresh.body?.sessionToken, undefined);
});

test('w3: a second instance with an empty cache denies without serving bytes', async () => {
    const h = createHarness();
    await h.seedSession('sess-1');
    assert.equal((await h.revoke('sess-1', 'student-1', 'self')).statusCode, 200);
    const denied = await invokeDelivery(h.processB.router, manifest('sess-1'));
    assert.equal(denied.status, 401);
    assert.equal(denied.chunks.length, 0);
});

test('w3: a durably inactive delivery session is denied even when no entitlement row is required', async () => {
    // A video with no unique lecture is outside the per-student entitlement
    // model, so the entitlement check returns `required: false`. The durable
    // session row must still stop delivery after a kill in another process.
    const h = createHarness({ association: { kind: 'none', lessonId: null, reason: 'course-only' } });
    await h.seedSession('sess-1');
    h.world.videoSessions.set('sess-1', { is_active: 0 });
    for (const request of [manifest('sess-1'), media('sess-1'), key('sess-1')]) {
        const denied = await invokeDelivery(h.processA.router, request);
        assert.equal(denied.status, 401, `${request.path} must honour the durable session status`);
        assert.equal(denied.chunks.length, 0);
    }
});

/* ------------------------------------------------------------------ */
/* durable-authority correction: no cache-only success                 */
/* ------------------------------------------------------------------ */

test('w3 correction: a missing durable session row denies even with a live local cache entry', async () => {
    const h = createHarness();
    await h.seedSession('sess-1');
    assert.equal((await invokeDelivery(h.processA.router, manifest('sess-1'))).status, 200, 'positive control');

    // The row is gone (the creation insert never landed, or the row was
    // purged) while the process that "created" the session still holds a
    // fully live cache entry. The cache must not be able to serve it.
    h.world.videoSessions.delete('sess-1');
    assert.equal(h.processA.cache.get('sess-1')?.isActive, true, 'the local cache must still look alive');

    for (const request of [manifest('sess-1'), media('sess-1'), key('sess-1')]) {
        const denied = await invokeDelivery(h.processA.router, request);
        assert.equal(denied.status, 401, `${request.path} must deny without a durable row`);
        assert.equal(denied.body?.error, 'session_inactive');
        assert.equal(denied.chunks.length, 0, `${request.path} must not send bytes`);
    }
    const deniedRefresh = await invokeDelivery(h.processA.router, refresh('sess-1'));
    assert.equal(deniedRefresh.status, 401, 'refresh must not mint a token without a durable row');
    assert.equal(deniedRefresh.body?.error, 'session_inactive');
    assert.equal(deniedRefresh.body?.sessionToken, undefined);
});

test('w3 correction: an unreadable durable session store denies instead of serving', async () => {
    const h = createHarness();
    await h.seedSession('sess-1');
    assert.equal((await invokeDelivery(h.processA.router, manifest('sess-1'))).status, 200, 'positive control');

    h.world.readFailure = 'video-sessions';
    for (const request of [manifest('sess-1'), media('sess-1'), key('sess-1')]) {
        const denied = await invokeDelivery(h.processA.router, request);
        assert.equal(denied.status, 401, `${request.path} must fail closed when the store is unreadable`);
        assert.equal(denied.chunks.length, 0);
    }
    const deniedRefresh = await invokeDelivery(h.processA.router, refresh('sess-1'));
    assert.equal(deniedRefresh.status, 401);
    assert.equal(deniedRefresh.body?.sessionToken, undefined);

    h.world.readFailure = null;
    assert.equal((await invokeDelivery(h.processA.router, manifest('sess-1'))).status, 200, 'recovery restores delivery');
});

test('w3 correction: a durable insert failure mints no session and leaves no local grant', async () => {
    const userId = 'student-insert-fails';
    let attemptedSessionId: string | null = null;
    const failingPersistence = {
        execute: async (sql: string, params: unknown[] = []) => {
            if (/INSERT INTO video_sessions/.test(sql)) {
                attemptedSessionId = String(params[0]);
                throw new Error('session store unavailable');
            }
            return { affectedRows: 1 };
        },
    };

    await assert.rejects(
        createVideoSession({
            userId, videoId: 'video-1', ip: '10.0.0.1', userAgent: 'hermetic-agent',
            fingerprint: 'fp-1', screenRes: '1920x1080',
        }, failingPersistence),
        (error: unknown) => error instanceof VideoSessionPersistenceError,
        'creation must fail rather than return an unusable session id',
    );

    const orphanId = attemptedSessionId;
    assert.ok(orphanId, 'the insert was attempted');
    assert.equal(getActiveSession(orphanId), null, 'no orphan entry in the process cache');
    assert.equal(getUserActiveSessionId(userId), null, 'no orphan user -> session mapping');

    // Positive control: the same seam publishes a session that the durable
    // reader can actually see.
    const rows = new Map<string, { is_active: number }>();
    const workingPersistence = {
        execute: async (sql: string, params: unknown[] = []) => {
            if (/INSERT INTO video_sessions/.test(sql)) {
                rows.set(String(params[0]), { is_active: 1 });
                return { affectedRows: 1 };
            }
            if (/UPDATE video_sessions SET is_active=0/.test(sql)) {
                for (const row of rows.values()) row.is_active = 0;
                return { affectedRows: 1 };
            }
            return { affectedRows: 1 };
        },
    };
    const okUser = 'student-insert-works';
    const created = await createVideoSession({
        userId: okUser, videoId: 'video-1', ip: '10.0.0.1', userAgent: 'hermetic-agent',
        fingerprint: 'fp-1', screenRes: '1920x1080',
    }, workingPersistence);
    assert.equal(rows.get(created.sessionId)?.is_active, 1, 'the row exists before the session is published');
    assert.equal(getUserActiveSessionId(okUser), created.sessionId);
    assert.notEqual(getActiveSession(created.sessionId), null);

    const reader = {
        queryOne: async <T = unknown>(_sql: string, params: unknown[] = []): Promise<T | null> =>
            (rows.get(String(params[0])) ?? null) as T | null,
    };
    assert.equal(await readDurableSessionStatus(reader, created.sessionId), 'active');
    assert.equal(await readDurableSessionStatus(reader, 'missing-session'), 'unknown');
});

test('w3 correction: the session route issues no token when creation cannot persist', async () => {
    const h = createHarness({ createFails: true });
    const created = await invokeDelivery(h.processA.router, {
        method: 'POST', path: '/session',
        body: { videoId: 'video-1', fingerprint: 'fp-1', screenRes: '1920x1080' },
    });
    assert.equal(created.status, 503);
    assert.equal(created.body?.code, 'PLAYBACK_UNAVAILABLE');
    assert.equal(created.body?.sessionId, undefined);
    assert.equal(created.body?.sessionToken, undefined);
    assert.equal(created.body?.streamUrl, undefined);
    assert.equal(created.text, '', 'no response bytes carrying a session');
    assert.equal(h.processA.cache.size, 0, 'nothing was published to the process cache');
    assert.equal(h.world.entitlements.size, 0, 'no entitlement for a session that does not exist');
});

/* ------------------------------------------------------------------ */
/* failure modes                                                       */
/* ------------------------------------------------------------------ */

test('w3: a storage failure during revoke rolls back — no half-revoked state', async () => {
    const h = createHarness();
    await h.seedSession('sess-1');

    h.world.failure = 'entitlement-revoke';
    const failed = await h.revoke('sess-1', 'admin-1', 'support');
    assert.equal(failed.statusCode, 500);
    assert.equal((failed.body as { error?: string }).error, 'revoke_failed');
    assert.equal(h.world.slots.get('sess-1')?.status, 'active', 'slot update must roll back');
    assert.equal(h.world.entitlements.get('jti-1')?.revoked_at, null, 'entitlement must not be half-revoked');
    assert.equal(h.world.audits.length, 0, 'no audit row may survive a rolled-back revoke');
    assert.equal(h.kills.length, 0, 'the local kill runs only after a commit');

    h.world.failure = 'audit-insert';
    const failedAudit = await h.revoke('sess-1', 'admin-1', 'support');
    assert.equal(failedAudit.statusCode, 500);
    assert.equal(h.world.slots.get('sess-1')?.status, 'active', 'audit failure must roll the durable change back');
    assert.equal(h.world.entitlements.get('jti-1')?.revoked_at, null);

    // Positive control: with storage healthy the session is still playable.
    h.world.failure = null;
    const served = await invokeDelivery(h.processA.router, manifest('sess-1'));
    assert.equal(served.status, 200);
});

/* ------------------------------------------------------------------ */
/* resource-scoped support authority (role label is never enough)       */
/* ------------------------------------------------------------------ */

test('w3 authority: a support role label without a tenant or capability is denied inertly', async () => {
    const h = createHarness();
    await h.seedSession('sess-1');
    // `admin-3` is a live admin principal with no server-derived tenant, i.e.
    // exactly the shape `resolvePrincipal` produces for an admin.
    const denied = await h.revoke('sess-1', 'admin-3', 'support');
    assert.equal(denied.statusCode, 403);
    assert.equal((denied.body as { error?: string }).error, 'tenant_required');
    assert.equal(h.world.slots.get('sess-1')?.status, 'active', 'no slot mutation');
    assert.equal(h.world.entitlements.get('jti-1')?.revoked_at, null, 'no entitlement revocation');
    assert.equal(h.world.audits.length, 0, 'no audit success');
    assert.equal(h.kills.length, 0, 'no local close');
    assert.equal((await invokeDelivery(h.processA.router, manifest('sess-1'))).status, 200, 'playback unaffected');
});

test('w3 authority: a verified platform capability authorizes cross-tenant support revoke', async () => {
    const h = createHarness();
    await h.seedSession('sess-1');
    await h.seedSession('sess-2');
    h.capabilities.add('operator-1');
    h.capabilities.add('admin-2');

    const noTenant = await h.revoke('sess-1', 'operator-1', 'support');
    assert.equal(noTenant.statusCode, 200, JSON.stringify(noTenant.body));
    assert.equal((noTenant.body as { revoked?: boolean }).revoked, true);
    assert.equal(h.world.audits[0].action, 'playback.session.support_revoke');
    assert.equal(h.world.audits[0].actorId, 'operator-1');
    assert.equal(h.world.audits[0].inTransaction, true);

    // A foreign tenant is allowed only because the live capability says so.
    const foreign = await h.revoke('sess-2', 'admin-2', 'support');
    assert.equal(foreign.statusCode, 200, JSON.stringify(foreign.body));
    assert.equal(h.world.slots.get('sess-2')?.status, 'revoked');
    assert.equal(h.world.audits.length, 2);
});

test('w3 authority: a failed capability lookup denies with no mutation and no audit', async () => {
    const h = createHarness();
    await h.seedSession('sess-1');
    h.capabilities.add('operator-1');
    h.capabilityState.failure = true;

    const denied = await h.revoke('sess-1', 'operator-1', 'support');
    assert.equal(denied.statusCode, 503);
    assert.equal((denied.body as { error?: string }).error, 'authority_unavailable');
    assert.equal(h.world.slots.get('sess-1')?.status, 'active');
    assert.equal(h.world.entitlements.get('jti-1')?.revoked_at, null);
    assert.equal(h.world.audits.length, 0);
    assert.equal(h.kills.length, 0);
    assert.equal((await invokeDelivery(h.processA.router, manifest('sess-1'))).status, 200);
});

test('w3 authority: capability withdrawal denies the NEXT support revoke (no caching)', async () => {
    const h = createHarness();
    h.capabilities.add('operator-1');
    await h.seedSession('sess-1');
    assert.equal((await h.revoke('sess-1', 'operator-1', 'support')).statusCode, 200);
    assert.equal(h.world.audits.length, 1);

    await h.seedSession('sess-2');
    h.capabilities.delete('operator-1');
    const denied = await h.revoke('sess-2', 'operator-1', 'support');
    assert.equal(denied.statusCode, 403);
    assert.equal((denied.body as { error?: string }).error, 'tenant_required');
    assert.equal(h.world.slots.get('sess-2')?.status, 'active');
    assert.equal(h.world.audits.length, 1, 'the withdrawn capability emits no event');
});

test('w3 authority: device support revoke follows the same decision contract', async () => {
    const h = createHarness();
    h.seedDevice('device-1');

    const roleOnly = await invokeRoute(h.sessionsRouter, {
        method: 'POST', url: '/devices/device-1/revoke', token: 'admin-3', body: {},
    });
    assert.equal(roleOnly.statusCode, 403);
    assert.equal((roleOnly.body as { error?: string }).error, 'tenant_required');
    assert.equal(h.world.devices.get('device-1')?.status, 'active', 'no device mutation');

    const foreign = await invokeRoute(h.sessionsRouter, {
        method: 'POST', url: '/devices/device-1/revoke', token: 'staff-2', body: {},
    });
    assert.equal(foreign.statusCode, 403);
    assert.equal((foreign.body as { error?: string }).error, 'tenant_mismatch');
    assert.equal(h.world.devices.get('device-1')?.status, 'active');

    h.capabilityState.failure = true;
    const unverified = await invokeRoute(h.sessionsRouter, {
        method: 'POST', url: '/devices/device-1/revoke', token: 'operator-1', body: {},
    });
    assert.equal(unverified.statusCode, 503);
    assert.equal(h.world.devices.get('device-1')?.status, 'active');
    h.capabilityState.failure = false;

    h.capabilities.add('operator-1');
    const allowed = await invokeRoute(h.sessionsRouter, {
        method: 'POST', url: '/devices/device-1/revoke', token: 'operator-1', body: {},
    });
    assert.equal(allowed.statusCode, 200, JSON.stringify(allowed.body));
    assert.equal((allowed.body as { revoked?: boolean }).revoked, true);
    assert.equal(h.world.devices.get('device-1')?.status, 'revoked');
    assert.equal(h.world.devices.get('device-1')?.revoked_by, 'operator-1');

    // Ownership still authorizes a self revoke without any capability.
    h.seedDevice('device-2');
    const self = await invokeRoute(h.sessionsRouter, {
        method: 'POST', url: '/devices/device-2/revoke', token: 'student-1', body: {},
    });
    assert.equal(self.statusCode, 200);
    assert.equal(h.world.devices.get('device-2')?.status, 'revoked');
});

test('w3: a local kill failure after commit does not resurrect the revoked session', async () => {
    const h = createHarness();
    await h.seedSession('sess-1');
    h.killBehaviour.mode = 'throw';
    const revoked = await h.revoke('sess-1', 'admin-1', 'support');
    assert.equal(revoked.statusCode, 200, 'the durable revoke is committed, so the API reports success');
    assert.equal((revoked.body as { revoked?: boolean }).revoked, true);
    assert.equal(h.world.slots.get('sess-1')?.status, 'revoked');
    assert.equal(h.world.entitlements.get('jti-1')?.revoked_at !== null, true);
    assert.equal(h.world.videoSessions.get('sess-1')?.is_active, 1, 'the local kill never ran');
    assert.deepEqual(h.kills, [{ sessionId: 'sess-1', reason: 'support_revoke' }]);

    const denied = await invokeDelivery(h.processA.router, manifest('sess-1'));
    assert.equal(denied.status, 403);
    assert.equal(denied.body?.reason, 'revoked');
    assert.equal(denied.chunks.length, 0);
});
