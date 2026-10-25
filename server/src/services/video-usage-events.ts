/**
 * V8 — usage events for watch time and storage.
 *
 * Two independent event families are metered with the same, tenant-attributed
 * record so reconciliation can be rebuilt from the ledger:
 *
 *  - `watch`   — seconds actually watched, reported by a client heartbeat
 *                (deduplicated per heartbeat window) or a provider callback;
 *  - `storage` — bytes stored, reported by a provider callback.
 *
 * Every event carries a caller-supplied `dedupeKey`. The ledger's
 * UNIQUE(tenant_id, dedupe_key) is the race guard, so a replayed heartbeat or
 * provider callback is absorbed instead of double-counted. The tenant is
 * ALWAYS a server-derived input (the principal's verified tenant for a
 * heartbeat, the signed provider payload for a callback) and is stored on the
 * row, so aggregates are tenant-scoped by construction.
 *
 * Pure validation/normalization is separated from the store so the exact rules
 * are testable without I/O. No `any`, no ts-ignore, no network, no runtime DDL.
 */
import { randomUUID } from 'crypto';
import { AuditRecordInput, recordAudit } from '../security/audit';

export const USAGE_KINDS = ['watch', 'storage'] as const;
export type UsageKind = (typeof USAGE_KINDS)[number];

/**
 * The unit of each family. They are deliberately distinct and must never be
 * summed into one number: a byte is not a second, and neither is a student.
 * `storage` events here are absolute provider observations; the cumulative
 * storage meter lives in `media-usage-reconciliation.ts` and is not this sum.
 */
export const USAGE_UNITS = { watch: 'seconds', storage: 'bytes' } as const;
export type UsageUnit = (typeof USAGE_UNITS)[UsageKind];

export function unitForUsageKind(kind: UsageKind): UsageUnit {
    return USAGE_UNITS[kind];
}

export const MAX_WATCH_SECONDS_PER_EVENT = 3600;
export const MAX_STORAGE_BYTES_PER_EVENT = 10 * 1024 * 1024 * 1024;
export const DEFAULT_HEARTBEAT_WINDOW_SECONDS = 30;

/**
 * Per-enrollment anti-inflation bounds for client watch heartbeats. A single
 * session can never report more than one dedupe window of watch time, and the
 * whole enrollment is bounded by an aggregate-seconds ceiling plus an event
 * count (rate limit) inside a rolling window.
 */
export const DEFAULT_HEARTBEAT_ENROLLMENT_WINDOW_SECONDS = 3600;
export const DEFAULT_MAX_HEARTBEAT_EVENTS_PER_ENROLLMENT = 240;
export const DEFAULT_MAX_HEARTBEAT_SECONDS_PER_ENROLLMENT = 7200;

export function normalizeUsageKind(value: unknown): UsageKind | null {
    if (typeof value !== 'string') return null;
    return (USAGE_KINDS as readonly string[]).includes(value) ? (value as UsageKind) : null;
}

const DEDUPE_KEY_RE = /^[A-Za-z0-9:_.-]{1,200}$/;

export function normalizeDedupeKey(value: unknown): string | null {
    if (typeof value !== 'string') return null;
    const trimmed = value.trim();
    if (!trimmed || trimmed.length > 200) return null;
    return DEDUPE_KEY_RE.test(trimmed) ? trimmed : null;
}

function normalizeId(value: unknown): string | null {
    if (typeof value !== 'string') return null;
    const trimmed = value.trim();
    if (!trimmed || trimmed.length > 128 || !/^[A-Za-z0-9_-]+$/.test(trimmed)) return null;
    return trimmed;
}

/**
 * Strict non-negative integer. Digits only.
 *
 * `parseInt('12abc')` returned 12 and `'1e21'` returned 1, so a malformed
 * provider or client quantity was silently coerced into a real one instead of
 * being refused. A non-safe integer is also refused: an unsafe double is not a
 * representable quantity, and `9007199254740993` used to become
 * `9007199254740992` — silently wrong seconds charged.
 */
function toNonNegativeInt(value: unknown): number | null {
    if (typeof value === 'number') {
        return Number.isSafeInteger(value) && value >= 0 ? value : null;
    }
    if (typeof value === 'string' && /^\d+$/.test(value.trim())) {
        const parsed = Number(value.trim());
        return Number.isSafeInteger(parsed) ? parsed : null;
    }
    return null;
}

/**
 * Deterministic heartbeat dedupe key: one event per (session, window bucket).
 * The bucket is derived from the injected clock, never from a client value, so
 * a burst of heartbeats inside one window collapses to a single unit.
 */
export function buildHeartbeatDedupeKey(
    sessionId: unknown,
    nowMs: number,
    windowSeconds: number = DEFAULT_HEARTBEAT_WINDOW_SECONDS,
): string | null {
    const session = normalizeId(sessionId);
    if (!session) return null;
    const window = Math.max(1, Math.trunc(windowSeconds));
    const bucket = Math.floor(nowMs / (window * 1000));
    return `hb:${session}:${bucket}`;
}

/**
 * Clamp a reported heartbeat delta to the dedupe window. A single heartbeat
 * can never account for more than one window of watch time, so a client-chosen
 * large delta cannot inflate the aggregate. Returns null for unusable input.
 */
export function clampHeartbeatSeconds(
    value: unknown,
    windowSeconds: number = DEFAULT_HEARTBEAT_WINDOW_SECONDS,
): number | null {
    const parsed = toNonNegativeInt(value);
    if (parsed === null || parsed <= 0) return null;
    const window = Math.max(1, Math.trunc(windowSeconds));
    return Math.min(parsed, window);
}

/** Deterministic provider-callback dedupe key: one event per provider event id. */
export function buildProviderDedupeKey(provider: unknown, eventId: unknown): string | null {
    const safeProvider = normalizeProviderSegment(provider);
    const safeEvent = normalizeProviderSegment(eventId);
    if (!safeProvider || !safeEvent) return null;
    return `cb:${safeProvider}:${safeEvent}`;
}

function normalizeProviderSegment(value: unknown): string | null {
    if (typeof value !== 'string') return null;
    const trimmed = value.trim();
    if (!trimmed || trimmed.length > 128) return null;
    return /^[A-Za-z0-9_.:-]+$/.test(trimmed) ? trimmed : null;
}

export type UsageSource = 'heartbeat' | 'provider' | 'other';

export interface NormalizedUsageEvent {
    tenantId: string;
    kind: UsageKind;
    dedupeKey: string;
    sessionId: string | null;
    studentEnrollmentId: string | null;
    assetId: string | null;
    watchSeconds: number;
    storageBytes: number;
    source: UsageSource;
    occurredAtMs: number;
}

export interface UsageEventInput {
    tenantId: unknown;
    kind: unknown;
    dedupeKey: unknown;
    sessionId?: unknown;
    studentEnrollmentId?: unknown;
    assetId?: unknown;
    watchSeconds?: unknown;
    storageBytes?: unknown;
    source?: unknown;
    occurredAtMs?: unknown;
}

export type UsageValidation =
    | { ok: true; value: NormalizedUsageEvent }
    | { ok: false; error: string };

export function validateUsageEvent(input: UsageEventInput): UsageValidation {
    const tenantId = typeof input.tenantId === 'string' ? input.tenantId.trim() : '';
    if (!tenantId || tenantId.length > 128) return { ok: false, error: 'tenant_id is required' };

    const kind = normalizeUsageKind(input.kind);
    if (!kind) return { ok: false, error: 'kind must be watch or storage' };

    const dedupeKey = normalizeDedupeKey(input.dedupeKey);
    if (!dedupeKey) return { ok: false, error: 'dedupe_key is required' };

    const sessionId = input.sessionId === undefined || input.sessionId === null ? null : normalizeId(input.sessionId);
    const studentEnrollmentId = input.studentEnrollmentId === undefined || input.studentEnrollmentId === null ? null : normalizeId(input.studentEnrollmentId);
    const assetId = input.assetId === undefined || input.assetId === null ? null : normalizeId(input.assetId);
    if (input.sessionId !== undefined && input.sessionId !== null && !sessionId) return { ok: false, error: 'session_id is malformed' };
    if (input.studentEnrollmentId !== undefined && input.studentEnrollmentId !== null && !studentEnrollmentId) return { ok: false, error: 'student_enrollment_id is malformed' };
    if (input.assetId !== undefined && input.assetId !== null && !assetId) return { ok: false, error: 'asset_id is malformed' };

    const source: UsageSource = input.source === 'heartbeat' || input.source === 'provider' ? input.source : 'other';

    let watchSeconds = 0;
    let storageBytes = 0;
    if (kind === 'watch') {
        const parsed = toNonNegativeInt(input.watchSeconds);
        if (parsed === null || parsed <= 0) return { ok: false, error: 'watch_seconds must be a positive integer' };
        if (parsed > MAX_WATCH_SECONDS_PER_EVENT) return { ok: false, error: 'watch_seconds exceeds the per-event cap' };
        watchSeconds = parsed;
    } else {
        const parsed = toNonNegativeInt(input.storageBytes);
        if (parsed === null) return { ok: false, error: 'storage_bytes must be a non-negative integer' };
        if (parsed > MAX_STORAGE_BYTES_PER_EVENT) return { ok: false, error: 'storage_bytes exceeds the per-event cap' };
        storageBytes = parsed;
    }

    // Safe non-negative integer only. `Number.isFinite(Number(x))` accepted
    // unsafe and negative values, and an absurd one reached `toMysqlUtc` where
    // `new Date(ms).toISOString()` throws RangeError inside the insert — a 500
    // for input that should simply be refused or defaulted.
    const suppliedOccurredAt = toNonNegativeInt(input.occurredAtMs);
    const occurredAtMs = suppliedOccurredAt === null ? Date.now() : suppliedOccurredAt;

    return {
        ok: true,
        value: { tenantId, kind, dedupeKey, sessionId, studentEnrollmentId, assetId, watchSeconds, storageBytes, source, occurredAtMs },
    };
}

/* =========================================================================
 * Store boundary
 * ========================================================================= */

export interface NewUsageEventRow extends NormalizedUsageEvent {
    id: string;
}

export interface VideoUsageStore {
    /** Returns false when the (tenant, dedupe_key) pair already exists. */
    insertEvent(row: NewUsageEventRow): Promise<boolean>;
    /** Ordered ascending by (occurred_at, id); used to rebuild cumulative counters. */
    listEvents(tenantId: string, kind?: UsageKind): Promise<NewUsageEventRow[]>;
    sumWatchSeconds(tenantId: string): Promise<number>;
    sumStorageBytes(tenantId: string): Promise<number>;
    /** Watch seconds recorded for one enrollment at/after `sinceMs`. */
    sumWatchSecondsForEnrollment(studentEnrollmentId: string, sinceMs: number): Promise<number>;
    /** Watch events recorded for one enrollment at/after `sinceMs` (rate limit). */
    countWatchEventsForEnrollment(studentEnrollmentId: string, sinceMs: number): Promise<number>;
    recordAudit(input: AuditRecordInput): Promise<void>;
}

export type RecordUsageResult =
    | { recorded: boolean; deduplicated: boolean }
    | { error: string };

/**
 * `enrollment_unknown` is a FAIL-CLOSED reason, not a rate outcome: the
 * per-enrollment ceiling could not be evaluated because the caller supplied no
 * enrollment id, so no heartbeat is admitted rather than admitting it against a
 * budget nobody checked.
 */
export type HeartbeatLimitReason = 'rate-limit' | 'aggregate-cap' | 'enrollment_unknown';
export type HeartbeatLimitDecision = { allowed: true } | { allowed: false; reason: HeartbeatLimitReason };

export interface HeartbeatLimitInput {
    studentEnrollmentId: string;
    nowMs: number;
    windowSeconds: number;
    maxEventsPerWindow: number;
    maxSecondsPerWindow: number;
}

export interface VideoUsageEventService {
    record(input: UsageEventInput): Promise<RecordUsageResult>;
    watchSeconds(tenantId: string): Promise<number>;
    storageBytes(tenantId: string): Promise<number>;
    /**
     * Cumulative watch counter rebuilt from the recorded watch events. The
     * materialized aggregate and this rebuild must agree; reconciliation uses
     * the rebuild as authority. Storage observations are NOT rebuilt here —
     * they are snapshots, not a cumulative counter.
     */
    rebuildWatchSeconds(tenantId: string): Promise<number>;
    /** Anti-inflation gate for watch heartbeats, scoped to one enrollment. */
    heartbeatLimit(input: HeartbeatLimitInput): Promise<HeartbeatLimitDecision>;
}

export interface VideoUsageEventDeps {
    store: VideoUsageStore;
    idFactory?: () => string;
}

export function createVideoUsageEventService(deps: VideoUsageEventDeps): VideoUsageEventService {
    const idFactory = deps.idFactory ?? randomUUID;
    const store = deps.store;

    return {
        record: async (input) => {
            const validated = validateUsageEvent(input);
            if (!validated.ok) return { error: validated.error };
            const id = idFactory();
            const inserted = await store.insertEvent({ id, ...validated.value });
            if (!inserted) return { recorded: false, deduplicated: true };
            await store.recordAudit({
                actorUserId: null,
                tenantId: validated.value.tenantId,
                action: 'video.usage.recorded',
                resourceType: 'video_usage_event',
                resourceId: id,
                newValue: {
                    kind: validated.value.kind,
                    watch_seconds: validated.value.watchSeconds,
                    storage_bytes: validated.value.storageBytes,
                    source: validated.value.source,
                },
            });
            return { recorded: true, deduplicated: false };
        },

        watchSeconds: async (tenantId) => {
            const safe = typeof tenantId === 'string' ? tenantId.trim() : '';
            return safe ? store.sumWatchSeconds(safe) : 0;
        },

        storageBytes: async (tenantId) => {
            const safe = typeof tenantId === 'string' ? tenantId.trim() : '';
            return safe ? store.sumStorageBytes(safe) : 0;
        },

        rebuildWatchSeconds: async (tenantId) => {
            const safe = typeof tenantId === 'string' ? tenantId.trim() : '';
            if (!safe) return 0;
            const events = await store.listEvents(safe, 'watch');
            return events.reduce((sum, event) => sum + event.watchSeconds, 0);
        },

        heartbeatLimit: async (input) => {
            const enrollmentId = typeof input.studentEnrollmentId === 'string' ? input.studentEnrollmentId.trim() : '';
            // No enrollment id means the per-enrollment ceiling CANNOT be
            // evaluated, which is not the same as "no ceiling applies".
            // Returning `allowed: true` here let a caller that omitted the id
            // bypass the aggregate cap entirely; the dedupe key still bounds
            // one session/window, but the enrollment-level budget was skipped.
            // Deny instead of guessing.
            if (!enrollmentId) return { allowed: false, reason: 'enrollment_unknown' };
            const window = Math.max(1, Math.trunc(input.windowSeconds));
            const maxEvents = Math.max(1, Math.trunc(input.maxEventsPerWindow));
            const maxSeconds = Math.max(1, Math.trunc(input.maxSecondsPerWindow));
            const since = input.nowMs - window * 1000;
            const [events, seconds] = await Promise.all([
                store.countWatchEventsForEnrollment(enrollmentId, since),
                store.sumWatchSecondsForEnrollment(enrollmentId, since),
            ]);
            if (events >= maxEvents) return { allowed: false, reason: 'rate-limit' };
            if (seconds >= maxSeconds) return { allowed: false, reason: 'aggregate-cap' };
            return { allowed: true };
        },
    };
}

/* =========================================================================
 * SQL adapter (production wiring)
 * ========================================================================= */

export interface VideoUsageDb {
    query: <T = unknown>(sql: string, params?: unknown[]) => Promise<T[]>;
    queryOne: <T = unknown>(sql: string, params?: unknown[]) => Promise<T | null>;
    execute: (sql: string, params?: unknown[]) => Promise<{ insertId?: number; affectedRows?: number }>;
}

export function isDuplicateUsageError(error: unknown): boolean {
    if (!error || typeof error !== 'object') return false;
    return (error as { code?: unknown }).code === 'ER_DUP_ENTRY';
}

function toMysqlUtc(ms: number): string {
    return new Date(ms).toISOString().slice(0, 19).replace('T', ' ');
}

function fromMysqlUtc(value: unknown): number {
    if (value instanceof Date) return value.getTime();
    if (typeof value === 'string' && value) {
        const date = new Date(/[TZ]/.test(value) ? value : `${value.replace(' ', 'T')}Z`);
        if (Number.isFinite(date.getTime())) return date.getTime();
    }
    return 0;
}

interface VideoUsageRow {
    id: string;
    tenant_id: string;
    asset_id: string | null;
    kind: string;
    watch_seconds: number | string;
    storage_bytes: number | string;
    dedupe_key: string;
    session_id: string | null;
    student_enrollment_id: string | null;
    source: string;
    occurred_at: unknown;
}

function mapUsageRow(row: VideoUsageRow): NewUsageEventRow | null {
    const kind = normalizeUsageKind(row.kind);
    if (!kind) return null;
    const source: UsageSource = row.source === 'heartbeat' || row.source === 'provider' ? row.source : 'other';
    return {
        id: row.id,
        tenantId: row.tenant_id,
        kind,
        dedupeKey: row.dedupe_key,
        sessionId: row.session_id,
        studentEnrollmentId: row.student_enrollment_id,
        assetId: row.asset_id,
        watchSeconds: Number(row.watch_seconds ?? 0),
        storageBytes: Number(row.storage_bytes ?? 0),
        source,
        occurredAtMs: fromMysqlUtc(row.occurred_at),
    };
}

const USAGE_COLUMNS = `id, tenant_id, asset_id, kind, watch_seconds, storage_bytes, dedupe_key,
    session_id, student_enrollment_id, source, occurred_at`;

export function createSqlVideoUsageStore(db: VideoUsageDb): VideoUsageStore {
    const sumFor = async (tenantId: string, column: 'watch_seconds' | 'storage_bytes'): Promise<number> => {
        const row = await db.queryOne<{ total: string | number | null }>(
            `SELECT COALESCE(SUM(${column}), 0) AS total FROM video_usage_events WHERE tenant_id = ?`,
            [tenantId],
        );
        return Number(row?.total ?? 0);
    };

    const forEnrollment = async (aggregate: 'SUM' | 'COUNT', enrollmentId: string, sinceMs: number): Promise<number> => {
        const expression = aggregate === 'SUM' ? 'COALESCE(SUM(watch_seconds), 0)' : 'COUNT(*)';
        const row = await db.queryOne<{ total: string | number | null }>(
            `SELECT ${expression} AS total FROM video_usage_events
             WHERE student_enrollment_id = ? AND kind = 'watch' AND occurred_at >= ?`,
            [enrollmentId, toMysqlUtc(sinceMs)],
        );
        return Number(row?.total ?? 0);
    };

    return {
        insertEvent: async (row) => {
            try {
                await db.execute(
                    `INSERT INTO video_usage_events
                       (id, tenant_id, asset_id, kind, watch_seconds, storage_bytes, dedupe_key,
                        session_id, student_enrollment_id, source, occurred_at)
                     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                    [
                        row.id,
                        row.tenantId,
                        row.assetId,
                        row.kind,
                        row.watchSeconds,
                        row.storageBytes,
                        row.dedupeKey,
                        row.sessionId,
                        row.studentEnrollmentId,
                        row.source,
                        toMysqlUtc(row.occurredAtMs),
                    ],
                );
                return true;
            } catch (error) {
                if (isDuplicateUsageError(error)) return false;
                throw error;
            }
        },

        sumWatchSeconds: (tenantId) => sumFor(tenantId, 'watch_seconds'),
        sumStorageBytes: (tenantId) => sumFor(tenantId, 'storage_bytes'),

        listEvents: async (tenantId, kind) => {
            const rows = kind === undefined
                ? await db.query<VideoUsageRow>(
                    `SELECT ${USAGE_COLUMNS} FROM video_usage_events
                     WHERE tenant_id = ? ORDER BY occurred_at ASC, id ASC`,
                    [tenantId],
                )
                : await db.query<VideoUsageRow>(
                    `SELECT ${USAGE_COLUMNS} FROM video_usage_events
                     WHERE tenant_id = ? AND kind = ? ORDER BY occurred_at ASC, id ASC`,
                    [tenantId, kind],
                );
            return rows
                .map(mapUsageRow)
                .filter((row): row is NewUsageEventRow => row !== null);
        },

        sumWatchSecondsForEnrollment: (enrollmentId, sinceMs) => forEnrollment('SUM', enrollmentId, sinceMs),
        countWatchEventsForEnrollment: (enrollmentId, sinceMs) => forEnrollment('COUNT', enrollmentId, sinceMs),

        recordAudit: async (input) => {
            await recordAudit(db.execute, input);
        },
    };
}
