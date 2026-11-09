"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.createHostResolver = exports.createTenantHostService = exports.resolveHost = exports.getTenantByHost = exports.resolveHostToTenant = exports.resolveTenantFromHost = exports.resolveTenantByHost = void 0;
exports.stripPort = stripPort;
exports.normalizeHostHeader = normalizeHostHeader;
exports.resolveTenantHost = resolveTenantHost;
exports.resolveTenantHostDetailed = resolveTenantHostDetailed;
exports.createTenantHostResolver = createTenantHostResolver;
/**
 * Host-header -> tenant resolution for M2 (C2/C3).
 *
 * Deny-by-default: a host resolves to a tenant only when it is either
 *   1. an exact, verified custom domain (tenant_custom_domains.status='verified'
 *      joined to an active tenant), or
 *   2. a single-label platform subdomain (`<label>.<platform-base>`) whose label
 *      maps to an active tenant (by subdomain or id).
 *
 * Everything else (bad/unknown/unverified/suspended host, port confusion,
 * wildcard/extra-label hosts, IDN/punycode) is denied. The port is stripped
 * before any lookup; case and trailing dots are normalized through the existing
 * domain-verification validator.
 */
const domain_verification_1 = require("./domain-verification");
const DEFAULT_PLATFORM_DOMAINS = ['tabweb.app', 'tabweb.test', 'localhost'];
function dataAccess(deps) {
    const db = deps.db ?? {};
    const query = (deps.query ?? db.query);
    const queryOne = (deps.queryOne ?? db.queryOne);
    if (!query || !queryOne) {
        throw new Error('Tenant host resolver requires query/queryOne');
    }
    return { query, queryOne };
}
function platformDomains(deps) {
    const fromDeps = deps.platformDomains ??
        (deps.platformDomain ? [deps.platformDomain] : undefined) ??
        (deps.platformBaseDomain ? [deps.platformBaseDomain] : undefined) ??
        (deps.baseDomain ? [deps.baseDomain] : undefined);
    const fromEnv = typeof process !== 'undefined' && process.env && process.env.PLATFORM_BASE_DOMAIN
        ? process.env.PLATFORM_BASE_DOMAIN.split(',').map((s) => s.trim()).filter(Boolean)
        : [];
    const list = fromDeps && fromDeps.length ? fromDeps : fromEnv.length ? fromEnv : DEFAULT_PLATFORM_DOMAINS;
    return list.map((d) => d.trim().toLowerCase()).filter(Boolean);
}
function stripPort(raw) {
    const trimmed = raw.trim();
    if (!trimmed)
        return null;
    if (trimmed.startsWith('[')) {
        const close = trimmed.indexOf(']');
        if (close === -1)
            return null;
        const host = trimmed.slice(0, close + 1);
        const rest = trimmed.slice(close + 1);
        if (rest !== '' && !/^:\d+$/.test(rest))
            return null;
        return host;
    }
    const colonCount = (trimmed.match(/:/g) || []).length;
    if (colonCount === 0)
        return trimmed;
    if (colonCount === 1) {
        const [host, port] = trimmed.split(':');
        if (!/^\d+$/.test(port))
            return null;
        return host;
    }
    return null;
}
function normalizeHostHeader(raw) {
    if (typeof raw !== 'string')
        return null;
    const stripped = stripPort(raw);
    if (!stripped)
        return null;
    return (0, domain_verification_1.normalizeHostname)(stripped);
}
function makeResult(row) {
    const tenant = { id: row.id, status: row.status, subdomain: row.subdomain ?? null };
    return { id: row.id, tenantId: row.id, tenant, status: row.status, subdomain: row.subdomain ?? null, ok: true };
}
async function resolveTenantHost(deps, rawHost) {
    const host = normalizeHostHeader(rawHost);
    if (!host)
        return null;
    const db = dataAccess(deps);
    // Platform subdomain: exactly one label before a configured platform base.
    for (const base of platformDomains(deps)) {
        const suffix = '.' + base;
        if (host === base)
            return null;
        if (host.endsWith(suffix)) {
            const label = host.slice(0, host.length - suffix.length);
            if (!label || label.includes('.') || label.length > 63)
                return null;
            if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))
                return null;
            if (label.startsWith('xn--'))
                return null;
            const row = await db.queryOne(`SELECT id, status, subdomain FROM tenants WHERE (subdomain = ? OR id = ?) AND status = 'active' LIMIT 1`, [label, label]);
            if (!row || row.status !== 'active')
                return null;
            return makeResult(row);
        }
    }
    // Custom domain: must be a valid public hostname and a verified claim.
    const validated = (0, domain_verification_1.validateCustomHostname)(host);
    if (!validated.ok)
        return null;
    const row = await db.queryOne(`SELECT t.id, t.status, t.subdomain
     FROM tenant_custom_domains d
     INNER JOIN tenants t ON t.id = d.tenant_id
     WHERE d.hostname = ? AND d.status = 'verified' AND t.status = 'active'
     LIMIT 1`, [validated.hostname]);
    if (!row || row.status !== 'active')
        return null;
    return makeResult(row);
}
async function resolveTenantHostDetailed(deps, rawHost) {
    const host = normalizeHostHeader(rawHost);
    if (!host)
        return { ok: false, tenantId: null, reason: 'BAD_HOST' };
    const resolved = await resolveTenantHost(deps, rawHost);
    if (!resolved)
        return { ok: false, tenantId: null, reason: 'HOST_NOT_RESOLVED' };
    return { ok: true, tenantId: resolved.tenantId, tenant: resolved.tenant };
}
exports.resolveTenantByHost = resolveTenantHost;
const resolveTenantFromHost = async (deps, rawHost) => {
    const resolved = await resolveTenantHost(deps, rawHost);
    return resolved ? { tenantId: resolved.tenantId, id: resolved.id, tenant: resolved.tenant } : null;
};
exports.resolveTenantFromHost = resolveTenantFromHost;
exports.resolveHostToTenant = resolveTenantHostDetailed;
exports.getTenantByHost = resolveTenantHost;
exports.resolveHost = resolveTenantHost;
function createTenantHostResolver(deps = {}) {
    return {
        resolve: (rawHost) => resolveTenantHost(deps, rawHost),
        resolveTenant: (rawHost) => resolveTenantHost(deps, rawHost),
        resolveTenantHost: (rawHost) => resolveTenantHost(deps, rawHost),
        resolveTenantByHost: (rawHost) => resolveTenantHost(deps, rawHost),
        normalizeHost: (rawHost) => normalizeHostHeader(rawHost),
        stripPort: (rawHost) => stripPort(rawHost),
    };
}
exports.createTenantHostService = createTenantHostResolver;
exports.createHostResolver = createTenantHostResolver;
exports.default = { resolveTenantHost, createTenantHostResolver, normalizeHostHeader, stripPort };
