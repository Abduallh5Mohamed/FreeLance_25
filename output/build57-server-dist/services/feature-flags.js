"use strict";
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
Object.defineProperty(exports, "__esModule", { value: true });
exports.isRequiredFeatureEnabled = exports.previewTargetedTenants = exports.evaluateRequiredFeature = exports.loadTenantPlanId = exports.evaluateTargeting = exports.stableTenantHash = exports.validateAuditReason = exports.validateRollbackInput = exports.validateFlagCreateInput = exports.validateTargetingInput = exports.FLAG_KEY_PATTERN = exports.MAX_TARGET_TENANTS = exports.TARGETING_MODES = void 0;
const crypto_1 = require("crypto");
exports.TARGETING_MODES = ['all', 'plan', 'tenant_list', 'percentage'];
/** Towering cap for a tenant-list targeting version. */
exports.MAX_TARGET_TENANTS = 100;
exports.FLAG_KEY_PATTERN = /^[a-z][a-z0-9_.-]{2,79}$/;
const ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const PERCENT_RANGE = { min: 0, max: 100 };
const optionalText = (value, max) => {
    if (typeof value !== 'string')
        return null;
    const trimmed = value.trim();
    if (!trimmed)
        return null;
    return trimmed.length > max ? trimmed.slice(0, max) : trimmed;
};
const normalizeTenantId = (value) => {
    if (typeof value !== 'string')
        return null;
    const trimmed = value.trim();
    if (!trimmed || trimmed.length > 64 || !ID_PATTERN.test(trimmed))
        return null;
    return trimmed;
};
/** Freeze the raw request body into a validated targeting spec. */
const validateTargetingInput = (body) => {
    if (typeof body !== 'object' || body === null) {
        return { ok: false, error: 'Targeting payload must be an object' };
    }
    const raw = body;
    const mode = optionalText(raw['targeting_mode'], 20);
    if (!mode || !exports.TARGETING_MODES.includes(mode)) {
        return { ok: false, error: 'targeting_mode must be one of all, plan, tenant_list, percentage' };
    }
    const enabledRaw = raw['enabled'] ?? true;
    if (enabledRaw !== true && enabledRaw !== false && enabledRaw !== 0 && enabledRaw !== 1) {
        return { ok: false, error: 'enabled must be a boolean' };
    }
    const enabled = enabledRaw === true || enabledRaw === 1;
    const spec = {
        mode: mode,
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
        if (rawList.length > exports.MAX_TARGET_TENANTS) {
            return { ok: false, error: `tenant_ids is limited to ${exports.MAX_TARGET_TENANTS} tenants` };
        }
        const ids = [];
        for (const candidate of rawList) {
            const id = normalizeTenantId(candidate);
            if (!id)
                return { ok: false, error: 'tenant_ids contains an invalid tenant id' };
            if (ids.includes(id))
                return { ok: false, error: 'tenant_ids contains a duplicate tenant id' };
            ids.push(id);
        }
        spec.tenantIds = ids;
    }
    return { ok: true, value: spec };
};
exports.validateTargetingInput = validateTargetingInput;
/** Freeze the flag registry create payload. */
const validateFlagCreateInput = (body) => {
    if (typeof body !== 'object' || body === null) {
        return { ok: false, error: 'Flag payload must be an object' };
    }
    const raw = body;
    const rawKey = typeof raw['flag_key'] === 'string' ? raw['flag_key'].trim().toLowerCase() : '';
    if (!rawKey || !exports.FLAG_KEY_PATTERN.test(rawKey)) {
        return { ok: false, error: 'flag_key must be 3-80 lowercase letters, digits, dot, dash or underscore' };
    }
    const rawDescription = raw['description'];
    let description = null;
    if (rawDescription !== undefined && rawDescription !== null) {
        if (typeof rawDescription !== 'string')
            return { ok: false, error: 'description must be a string' };
        description = rawDescription.trim().slice(0, 500) || null;
    }
    return { ok: true, value: { flagKey: rawKey, description } };
};
exports.validateFlagCreateInput = validateFlagCreateInput;
/** Freeze the rollback payload. */
const validateRollbackInput = (body) => {
    if (typeof body !== 'object' || body === null)
        return { ok: false, error: 'Rollback payload must be an object' };
    const raw = body;
    const versionNo = typeof raw['version_no'] === 'number'
        ? raw['version_no']
        : Number(raw['version_no']);
    if (!Number.isInteger(versionNo) || versionNo < 1 || versionNo > 100000) {
        return { ok: false, error: 'version_no must be a positive integer' };
    }
    return { ok: true, value: { versionNo } };
};
exports.validateRollbackInput = validateRollbackInput;
/** Freeze and require an audit reason for every flag mutation. */
const validateAuditReason = (value) => {
    if (typeof value !== 'string')
        return { ok: false, error: 'reason is required' };
    const trimmed = value.trim();
    if (trimmed.length < 3 || trimmed.length > 500) {
        return { ok: false, error: 'reason must be 3-500 characters' };
    }
    return { ok: true, value: trimmed };
};
exports.validateAuditReason = validateAuditReason;
/**
 * Stable rollout membership: sha256(flagKey|tenantId) collapsed to 0..99.
 * Deterministic across processes, replays and nodes — a tenant's membership in
 * a percentage rollout never flips between evaluations.
 */
const stableTenantHash = (flagKey, tenantId) => {
    const digest = (0, crypto_1.createHash)('sha256').update(`${flagKey}|${tenantId}`, 'utf8').digest('hex');
    return parseInt(digest.slice(0, 8), 16) % 100;
};
exports.stableTenantHash = stableTenantHash;
const specFromVersion = (version, mode) => {
    let tenantIds = [];
    if (Array.isArray(version.tenant_ids)) {
        tenantIds = version.tenant_ids.filter((id) => typeof id === 'string');
    }
    else if (typeof version.tenant_ids === 'string') {
        try {
            const parsed = JSON.parse(version.tenant_ids);
            if (Array.isArray(parsed)) {
                tenantIds = parsed.filter((id) => typeof id === 'string');
            }
        }
        catch {
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
const evaluateTargeting = (spec, context) => {
    if (!spec.enabled)
        return false;
    switch (spec.mode) {
        case 'all':
            return true;
        case 'plan':
            return context.planId !== null && context.planId === spec.planId;
        case 'tenant_list':
            return spec.tenantIds.includes(context.tenantId);
        case 'percentage':
            return spec.percentage !== null && (0, exports.stableTenantHash)(context.flagKey, context.tenantId) < spec.percentage;
    }
};
exports.evaluateTargeting = evaluateTargeting;
/** Most recent live plan of the tenant (active/past_due/grace_period). */
const loadTenantPlanId = async (db, tenantId) => {
    const row = await db.queryOne(`SELECT plan_id FROM tenant_subscriptions
         WHERE tenant_id=? AND status IN ('active','past_due','grace_period')
         ORDER BY created_at DESC, id DESC LIMIT 1`, [tenantId]);
    return row?.plan_id ?? null;
};
exports.loadTenantPlanId = loadTenantPlanId;
/**
 * Server-side enforcement core. Deny-by-default for unknown flags, archived
 * flags, missing active versions and disabled or non-matching targeting.
 */
const evaluateRequiredFeature = async (db, tenantId, flagKey) => {
    const tenant = typeof tenantId === 'string' ? tenantId.trim() : '';
    const key = typeof flagKey === 'string' ? flagKey.trim().toLowerCase() : '';
    if (!tenant || !key || !exports.FLAG_KEY_PATTERN.test(key))
        return false;
    let flag;
    try {
        flag = await db.queryOne('SELECT id, is_archived FROM feature_flags WHERE flag_key=? LIMIT 1', [key]);
    }
    catch {
        return false;
    }
    if (!flag || Number(flag.is_archived) === 1)
        return false;
    let version;
    try {
        version = await db.queryOne(`SELECT v.id, v.targeting_mode, v.plan_id, v.percentage, v.tenant_ids, v.enabled
             FROM feature_flag_versions v
             INNER JOIN feature_flags f ON f.active_version_id = v.id
             WHERE f.id = ? AND v.flag_id = ? LIMIT 1`, [flag.id, flag.id]);
    }
    catch {
        return false;
    }
    if (!version)
        return false;
    const mode = exports.TARGETING_MODES.includes(version.targeting_mode)
        ? version.targeting_mode
        : null;
    if (!mode)
        return false;
    const spec = specFromVersion(version, mode);
    const planId = spec.mode === 'plan' ? await (0, exports.loadTenantPlanId)(db, tenantId) : null;
    return (0, exports.evaluateTargeting)(spec, { flagKey: key, tenantId: tenant, planId });
};
exports.evaluateRequiredFeature = evaluateRequiredFeature;
/**
 * Preview: which active tenants a would-be (or new) version would affect.
 * Returns the full count plus a bounded id sample so the response stays small.
 */
const previewTargetedTenants = async (db, spec, options = {}) => {
    const flagKey = options.flagKey ?? 'preview';
    const sampleLimit = options.sampleLimit ?? 100;
    const tenants = await db.query(`SELECT t.id AS tenant_id,
                (SELECT s.plan_id FROM tenant_subscriptions s
                 WHERE s.tenant_id = t.id AND s.status IN ('active','past_due','grace_period')
                 ORDER BY s.created_at DESC, s.id DESC LIMIT 1) AS plan_id
         FROM tenants t
         WHERE t.status = 'active'
         ORDER BY t.id ASC
         LIMIT 2000`);
    const matched = tenants
        .filter((tenant) => (0, exports.evaluateTargeting)(spec, {
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
exports.previewTargetedTenants = previewTargetedTenants;
/* ----------------------------------------------------------------------- */
/* Production binding: lazily imported real pool, never at import time.     */
/* ----------------------------------------------------------------------- */
let dbModule = null;
const loadProductionDb = async () => {
    dbModule ?? (dbModule = await Promise.resolve().then(() => __importStar(require('../db'))));
    const { query, queryOne, execute } = dbModule;
    return {
        query: (sql, params) => query(sql, params),
        queryOne: (sql, params) => queryOne(sql, params),
        execute: (sql, params) => execute(sql, params),
    };
};
/**
 * Enforcement entry point other modules call:
 * `await isRequiredFeatureEnabled(tenantId, flag)`.
 * Every failure mode (db error, unknown flag, breach of validation) is denied.
 */
const isRequiredFeatureEnabled = async (tenantId, flagKey) => {
    try {
        const db = await loadProductionDb();
        return await (0, exports.evaluateRequiredFeature)(db, tenantId, flagKey);
    }
    catch {
        return false;
    }
};
exports.isRequiredFeatureEnabled = isRequiredFeatureEnabled;
