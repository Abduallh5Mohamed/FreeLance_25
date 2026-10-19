/**
 * M7 O2 — platform feature flags: validation, scoped targeting, versions and
 * the server-side enforcement helper other modules call.
 *
 * Model:
 *  - `feature_flags` is the registry; a flag is identified by a stable key and
 *    points at ONE active immutable version row.
 *  - `feature_flag_versions` freezes a targeting decision (all / plan /
 *    tenant_list / percentage) at creation. Enabling, disabling or retargeting
 *    always publishes a NEW version; rollback only moves the active pointer.
 *  - Enforcement (`evaluateRequiredFeature`) is deny-by-default: an unknown
 *    flag key, an archived flag, a flag without an active version, a disabled
 *    version or any lookup failure all resolve to `false` and never throw.
 *  - Percentage targeting uses a stable keyed hash of (flagKey, tenantId) so a
 *    tenant stays in or out of a rollout independent of evaluation timing.
 *
 * No runtime DDL, no PII in logs, no `any`.
 */

import { createHash } from 'crypto';

export interface FeatureFlagsDataAccess {
    query: <T = Record<string, unknown>>(sql: string, params?: unknown[]) => Promise<T[]>;
    queryOne: <T = Record<string, unknown>>(sql: string, params?: unknown[]) => Promise<T | null>;
    execute: (sql: string, params?: unknown[]) => Promise<{ insertId?: number; affectedRows?: number }>;
}

export type TargetingMode = 'all' | 'plan' | 'tenant_list' | 'percentage';

export const TARGETING_MODES: readonly TargetingMode[] = ['all', 'plan', 'tenant_list', 'percentage'];

/** Towering cap for a tenant-list targeting version. */
export const MAX_TARGET_TENANTS = 100;

export const FLAG_KEY_PATTERN = /^[a-z][a-z0-9_.-]{2,79}$/;
const ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const PERCENT_RANGE = { min: 0, max: 100 } as const;

export type ValidateResult<T> = { ok: true; value: T } | { ok: false; error: string };

export interface TargetingSpec {
    mode: TargetingMode;
    planId: string | null;
    tenantIds: string[];
    percentage: number | null;
    enabled: boolean;
}

const optionalText = (value: unknown, max: number): string | null => {
    if (typeof value !== 'string') return null;
    const trimmed = value.trim();
    if (!trimmed) return null;
    return trimmed.length > max ? trimmed.slice(0, max) : trimmed;
};

const normalizeTenantId = (value: unknown): string | null => {
    if (typeof value !== 'string') return null;
    const trimmed = value.trim();
    if (!trimmed || trimmed.length > 64 || !ID_PATTERN.test(trimmed)) return null;
    return trimmed;
};

/** Freeze the raw request body into a validated targeting spec. */
export const validateTargetingInput = (body: unknown): ValidateResult<TargetingSpec> => {
    if (typeof body !== 'object' || body === null) {
        return { ok: false, error: 'Targeting payload must be an object' };
    }
    const raw = body as Record<string, unknown>;
    const mode = optionalText(raw['targeting_mode'], 20);
    if (!mode || !TARGETING_MODES.includes(mode as TargetingMode)) {
        return { ok: false, error: 'targeting_mode must be one of all, plan, tenant_list, percentage' };
    }
    const enabledRaw = raw['enabled'] ?? true;
    if (enabledRaw !== true && enabledRaw !== false && enabledRaw !== 0 && enabledRaw !== 1) {
        return { ok: false, error: 'enabled must be a boolean' };
    }
    const enabled = enabledRaw === true || enabledRaw === 1;
    const spec: TargetingSpec = {
        mode: mode as TargetingMode,
        planId: null,
        tenantIds: [],
        percentage: null,
        enabled,
    };
    if (spec.mode === 'plan') {
        const planId = typeof raw['plan_id'] === 'string' ? raw['plan_id'].trim() : '';
        if (!planId || planId.length > 64 || !ID_PATTERN.test(planId)) {
            return { ok: false, error: 'plan_id is required for plan targeting' };
        }
        spec.planId = planId;
    }
    if (spec.mode === 'percentage') {
        const percentageValue = raw['percentage'];
        const percentage = typeof percentageValue === 'number' ? percentageValue : Number(percentageValue);
        if (!Number.isInteger(percentage) || percentage < PERCENT_RANGE.min || percentage > PERCENT_RANGE.max) {
            return {
                ok: false,
                error: `percentage must be an integer between ${PERCENT_RANGE.min} and ${PERCENT_RANGE.max}`,
            };
        }
        spec.percentage = percentage;
    }
    if (spec.mode === 'tenant_list') {
        const rawList = raw['tenant_ids'];
        if (!Array.isArray(rawList) || rawList.length === 0) {
            return { ok: false, error: 'tenant_ids must be a non-empty array for tenant_list targeting' };
        }
        if (rawList.length > MAX_TARGET_TENANTS) {
            return { ok: false, error: `tenant_ids is limited to ${MAX_TARGET_TENANTS} tenants` };
        }
        const ids: string[] = [];
        for (const candidate of rawList) {
            const id = normalizeTenantId(candidate);
            if (!id) return { ok: false, error: 'tenant_ids contains an invalid tenant id' };
            if (ids.includes(id)) return { ok: false, error: 'tenant_ids contains a duplicate tenant id' };
            ids.push(id);
        }
        spec.tenantIds = ids;
    }
    return { ok: true, value: spec };
};

/** Freeze the flag registry create payload. */
export const validateFlagCreateInput = (
    body: unknown,
): ValidateResult<{ flagKey: string; description: string | null }> => {
    if (typeof body !== 'object' || body === null) {
        return { ok: false, error: 'Flag payload must be an object' };
    }
    const raw = body as Record<string, unknown>;
    const rawKey = typeof raw['flag_key'] === 'string' ? raw['flag_key'].trim().toLowerCase() : '';
    if (!rawKey || !FLAG_KEY_PATTERN.test(rawKey)) {
        return { ok: false, error: 'flag_key must be 3-80 lowercase letters, digits, dot, dash or underscore' };
    }
    const rawDescription = raw['description'];
    let description: string | null = null;
    if (rawDescription !== undefined && rawDescription !== null) {
        if (typeof rawDescription !== 'string') return { ok: false, error: 'description must be a string' };
        description = rawDescription.trim().slice(0, 500) || null;
    }
    return { ok: true, value: { flagKey: rawKey, description } };
};

/** Freeze the rollback payload. */
export const validateRollbackInput = (body: unknown): ValidateResult<{ versionNo: number }> => {
    if (typeof body !== 'object' || body === null) return { ok: false, error: 'Rollback payload must be an object' };
    const raw = body as Record<string, unknown>;
    const versionNo = typeof raw['version_no'] === 'number'
        ? raw['version_no']
        : Number(raw['version_no']);
    if (!Number.isInteger(versionNo) || versionNo < 1 || versionNo > 100000) {
        return { ok: false, error: 'version_no must be a positive integer' };
    }
    return { ok: true, value: { versionNo } };
};

/** Freeze and require an audit reason for every flag mutation. */
export const validateAuditReason = (value: unknown): ValidateResult<string> => {
    if (typeof value !== 'string') return { ok: false, error: 'reason is required' };
    const trimmed = value.trim();
    if (trimmed.length < 3 || trimmed.length > 500) {
        return { ok: false, error: 'reason must be 3-500 characters' };
    }
    return { ok: true, value: trimmed };
};

/**
 * Stable rollout membership: sha256(flagKey|tenantId) collapsed to 0..99.
 * Deterministic across processes, replays and nodes — a tenant's membership in
 * a percentage rollout never flips between evaluations.
 */
export const stableTenantHash = (flagKey: string, tenantId: string): number => {
    const digest = createHash('sha256').update(`${flagKey}|${tenantId}`, 'utf8').digest('hex');
    return parseInt(digest.slice(0, 8), 16) % 100;
};

interface FlagVersionRow {
    id: string;
    targeting_mode: string;
    plan_id: string | null;
    percentage: number | null;
    tenant_ids: unknown;
    enabled: number | boolean;
}

const specFromVersion = (version: FlagVersionRow, mode: TargetingMode): TargetingSpec => {
    let tenantIds: string[] = [];
    if (Array.isArray(version.tenant_ids)) {
        tenantIds = version.tenant_ids.filter((id): id is string => typeof id === 'string');
    } else if (typeof version.tenant_ids === 'string') {
        try {
            const parsed: unknown = JSON.parse(version.tenant_ids);
            if (Array.isArray(parsed)) {
                tenantIds = parsed.filter((id: unknown): id is string => typeof id === 'string');
            }
        } catch {
            tenantIds = [];
        }
    }
    return {
        mode,
        planId: typeof version.plan_id === 'string' ? version.plan_id : null,
        tenantIds,
        percentage: version.percentage === null || version.percentage === undefined ? null : Number(version.percentage),
        enabled: version.enabled === 1 || version.enabled === true,
    };
};

export const evaluateTargeting = (spec: TargetingSpec, context: { flagKey: string; tenantId: string; planId: string | null }): boolean => {
    if (!spec.enabled) return false;
    switch (spec.mode) {
        case 'all':
            return true;
        case 'plan':
            return context.planId !== null && context.planId === spec.planId;
        case 'tenant_list':
            return spec.tenantIds.includes(context.tenantId);
        case 'percentage':
            return spec.percentage !== null && stableTenantHash(context.flagKey, context.tenantId) < spec.percentage;
    }
};

/** Most recent live plan of the tenant (active/past_due/grace_period). */
export const loadTenantPlanId = async (
    db: FeatureFlagsDataAccess,
    tenantId: string,
): Promise<string | null> => {
    const row = await db.queryOne<{ plan_id: string | null }>(
        `SELECT plan_id FROM tenant_subscriptions
         WHERE tenant_id=? AND status IN ('active','past_due','grace_period')
         ORDER BY created_at DESC, id DESC LIMIT 1`,
        [tenantId],
    );
    return row?.plan_id ?? null;
};

/**
 * Server-side enforcement core. Deny-by-default for unknown flags, archived
 * flags, missing active versions and disabled or non-matching targeting.
 */
export const evaluateRequiredFeature = async (
    db: FeatureFlagsDataAccess,
    tenantId: string,
    flagKey: string,
): Promise<boolean> => {
    const tenant = typeof tenantId === 'string' ? tenantId.trim() : '';
    const key = typeof flagKey === 'string' ? flagKey.trim().toLowerCase() : '';
    if (!tenant || !key || !FLAG_KEY_PATTERN.test(key)) return false;
    let flag: { id: string; is_archived: number | boolean } | null;
    try {
        flag = await db.queryOne<{ id: string; is_archived: number | boolean }>(
            'SELECT id, is_archived FROM feature_flags WHERE flag_key=? LIMIT 1',
            [key],
        );
    } catch {
        return false;
    }
    if (!flag || Number(flag.is_archived) === 1) return false;
    let version: FlagVersionRow | null;
    try {
        version = await db.queryOne<FlagVersionRow>(
            `SELECT v.id, v.targeting_mode, v.plan_id, v.percentage, v.tenant_ids, v.enabled
             FROM feature_flag_versions v
             INNER JOIN feature_flags f ON f.active_version_id = v.id
             WHERE f.id = ? AND v.flag_id = ? LIMIT 1`,
            [flag.id, flag.id],
        );
    } catch {
        return false;
    }
    if (!version) return false;
    const mode = TARGETING_MODES.includes(version.targeting_mode as TargetingMode)
        ? (version.targeting_mode as TargetingMode)
        : null;
    if (!mode) return false;
    const spec = specFromVersion(version, mode);
    const planId = spec.mode === 'plan' ? await loadTenantPlanId(db, tenantId) : null;
    return evaluateTargeting(spec, { flagKey: key, tenantId: tenant, planId });
};

/**
 * Preview: which active tenants a would-be (or new) version would affect.
 * Returns the full count plus a bounded id sample so the response stays small.
 */
export const previewTargetedTenants = async (
    db: FeatureFlagsDataAccess,
    spec: TargetingSpec,
    options: { flagKey?: string; sampleLimit?: number } = {},
): Promise<{ total: number; sample: string[] }> => {
    const flagKey = options.flagKey ?? 'preview';
    const sampleLimit = options.sampleLimit ?? 100;
    const tenants = await db.query<{ tenant_id: string; plan_id: string | null }>(
        `SELECT t.id AS tenant_id,
                (SELECT s.plan_id FROM tenant_subscriptions s
                 WHERE s.tenant_id = t.id AND s.status IN ('active','past_due','grace_period')
                 ORDER BY s.created_at DESC, s.id DESC LIMIT 1) AS plan_id
         FROM tenants t
         WHERE t.status = 'active'
         ORDER BY t.id ASC
         LIMIT 2000`,
    );
    const matched = tenants
        .filter((tenant) => evaluateTargeting(spec, {
            flagKey,
            tenantId: tenant.tenant_id,
            planId: tenant.plan_id ?? null,
        }))
        .map((tenant) => tenant.tenant_id);
    return {
        total: matched.length,
        sample: matched.slice(0, sampleLimit),
    };
};

/* ----------------------------------------------------------------------- */
/* Production binding: lazily imported real pool, never at import time.     */
/* ----------------------------------------------------------------------- */

let dbModule: typeof import('../db') | null = null;
const loadProductionDb = async (): Promise<FeatureFlagsDataAccess> => {
    dbModule ??= await import('../db');
    const { query, queryOne, execute } = dbModule;
    return {
        query: <T = Record<string, unknown>>(sql: string, params?: unknown[]) =>
            query<T>(sql, params as never) as Promise<T[]>,
        queryOne: <T = Record<string, unknown>>(sql: string, params?: unknown[]) =>
            queryOne<T>(sql, params as never) as Promise<T | null>,
        execute: (sql: string, params?: unknown[]) => execute(sql, params as never),
    };
};

/**
 * Enforcement entry point other modules call:
 * `await isRequiredFeatureEnabled(tenantId, flag)`.
 * Every failure mode (db error, unknown flag, breach of validation) is denied.
 */
export const isRequiredFeatureEnabled = async (
    tenantId: string,
    flagKey: string,
): Promise<boolean> => {
    try {
        const db = await loadProductionDb();
        return await evaluateRequiredFeature(db, tenantId, flagKey);
    } catch {
        return false;
    }
};
