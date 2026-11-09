"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.TXT_RECORD_VALUE_PREFIX = exports.TXT_RECORD_PREFIX = exports.VERIFICATION_TOKEN_BYTES = exports.MAX_LABEL_LENGTH = exports.MAX_HOSTNAME_LENGTH = void 0;
exports.normalizeHostname = normalizeHostname;
exports.validateCustomHostname = validateCustomHostname;
exports.generateVerificationToken = generateVerificationToken;
exports.buildTxtRecordName = buildTxtRecordName;
exports.buildTxtRecordValue = buildTxtRecordValue;
exports.resolveTxtViaDns = resolveTxtViaDns;
exports.txtRecordsProveOwnership = txtRecordsProveOwnership;
exports.verifyDomainOwnership = verifyDomainOwnership;
exports.canClaimDomain = canClaimDomain;
exports.createMemoryDomainClaimStore = createMemoryDomainClaimStore;
exports.createSqlDomainClaimStore = createSqlDomainClaimStore;
/**
 * Custom-domain / subdomain verification for M2 tenant branding (C2/C3).
 *
 * Deny-by-default hostname validation plus DNS TXT challenge generation and
 * verification behind injectable seams:
 * - validation is pure and synchronous (no network);
 * - TXT lookups go through an injected `TxtResolver` so tests bind a fake and
 *   production binds Node DNS;
 * - cross-tenant claims are denied through an injected `DomainClaimStore`
 *   (same tenant may refresh/re-verify its own claim; any claim owned by a
 *   different tenant denies the request before any DNS or write happens).
 *
 * No `any`, no ts-ignore, no runtime DDL, no secrets. Small pure functions.
 */
const node_crypto_1 = require("node:crypto");
const promises_1 = require("node:dns/promises");
exports.MAX_HOSTNAME_LENGTH = 253;
exports.MAX_LABEL_LENGTH = 63;
exports.VERIFICATION_TOKEN_BYTES = 32;
exports.TXT_RECORD_PREFIX = '_tabweb-verify';
exports.TXT_RECORD_VALUE_PREFIX = 'tabweb-verify=';
/** Internal / non-routable TLDs that can never be a tenant custom domain. */
const INTERNAL_TLDS = new Set([
    'local',
    'localhost',
    'internal',
    'intranet',
    'lan',
    'home',
    'homenet',
    'corp',
    'localdomain',
    'domain',
    'invalid',
    'example',
    'test',
    'onion',
]);
/**
 * Left-most labels reserved for platform/security operations. A tenant may
 * own `academy.example.com`, but `admin.academy.example.com`-style security
 * sensitive prefixes are never claimable as tenant branding.
 */
const RESERVED_FIRST_LABELS = new Set([
    'admin',
    'administrator',
    'superadmin',
    'root',
    'api',
    'internal',
    'platform',
    'system',
    'security',
    'abuse',
    'postmaster',
    'hostmaster',
    'webmaster',
    'support',
]);
const LABEL_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const TLD_PATTERN = /^[a-z]{2,}$/;
const IPV4_PATTERN = /^(?:\d{1,3}\.){3}\d{1,3}$/;
const HOSTNAME_CHARS_PATTERN = /^[a-z0-9.-]+$/;
const deny = (code, reason) => ({
    ok: false,
    code,
    reason,
});
/**
 * Normalize raw input to a canonical hostname key, or null when the input
 * is not usable at all. Trims whitespace, drops one trailing root dot and
 * lowercases (DNS is case-insensitive). Validation happens separately.
 */
function normalizeHostname(raw) {
    if (typeof raw !== 'string')
        return null;
    const trimmed = raw.trim().toLowerCase();
    if (!trimmed)
        return null;
    const withoutRootDot = trimmed.endsWith('.') ? trimmed.slice(0, -1) : trimmed;
    if (!withoutRootDot || withoutRootDot.length > exports.MAX_HOSTNAME_LENGTH)
        return null;
    return withoutRootDot;
}
const IPV6_LITERAL_PATTERN = /^\[?[0-9a-f:.]*:[0-9a-f:.]*\]?$/;
function isIpLiteral(hostname) {
    if (IPV6_LITERAL_PATTERN.test(hostname))
        return true; // IPv6 literal
    // Dotted-quad shape is rejected as an IP even when an octet is out of range.
    return IPV4_PATTERN.test(hostname);
}
/**
 * Strict hostname validation. Returns the canonical hostname on success.
 * Rejects IP literals, localhost, internal TLDs, reserved security prefixes,
 * punycode/unicode abuse, and malformed names. Deny-by-default: anything not
 * explicitly a well-formed public hostname is rejected.
 */
function validateCustomHostname(raw) {
    if (typeof raw !== 'string' || !raw.trim()) {
        return deny('EMPTY', 'Hostname is required');
    }
    // Reject non-ASCII on the RAW input: case folding can map look-alikes to
    // ASCII (e.g. KELVIN SIGN U+212A lowercases to "k"), which would let a
    // homograph silently collide with a real hostname.
    // eslint-disable-next-line no-control-regex
    if (/[^\x00-\x7f]/.test(raw)) {
        return deny('PUNYCODE', 'Internationalized / punycode hostnames are not accepted');
    }
    const hostname = normalizeHostname(raw);
    if (!hostname)
        return deny('TOO_LONG', 'Hostname is empty or exceeds 253 characters');
    if (isIpLiteral(hostname)) {
        return deny('IP_ADDRESS', 'IP addresses cannot be used as a custom domain');
    }
    if (hostname === 'localhost' || hostname.endsWith('.localhost')) {
        return deny('LOCALHOST', 'localhost cannot be used as a custom domain');
    }
    // Punycode A-labels (`xn--`) are rejected: only plain ASCII names are claimable.
    if (hostname.split('.').some((label) => label.startsWith('xn--'))) {
        return deny('PUNYCODE', 'Internationalized / punycode hostnames are not accepted');
    }
    if (!HOSTNAME_CHARS_PATTERN.test(hostname)) {
        return deny('INVALID_CHARACTERS', 'Hostname may only contain letters, digits, dots and hyphens');
    }
    if (hostname.includes('..') || hostname.startsWith('.') || hostname.startsWith('-') || hostname.endsWith('-')) {
        return deny('BAD_LABEL', 'Hostname has an empty or malformed label');
    }
    const labels = hostname.split('.');
    if (labels.length < 2) {
        return deny('SINGLE_LABEL', 'A custom domain must contain at least one dot');
    }
    for (const label of labels) {
        if (!label || label.length > exports.MAX_LABEL_LENGTH || !LABEL_PATTERN.test(label)) {
            return deny('BAD_LABEL', `Malformed DNS label: "${label}"`);
        }
    }
    const tld = labels[labels.length - 1];
    if (INTERNAL_TLDS.has(tld)) {
        return deny('INTERNAL_TLD', `The .${tld} suffix is internal and cannot be used as a custom domain`);
    }
    if (!TLD_PATTERN.test(tld)) {
        return deny('BAD_TLD', 'Top-level domain must be at least two letters');
    }
    if (RESERVED_FIRST_LABELS.has(labels[0])) {
        return deny('RESERVED_SUBDOMAIN', `The "${labels[0]}" prefix is reserved for platform operations`);
    }
    return { ok: true, hostname };
}
/** Generate a fresh verification token (64 lowercase hex chars by default). */
function generateVerificationToken(randomSource = node_crypto_1.randomBytes) {
    return randomSource(exports.VERIFICATION_TOKEN_BYTES).toString('hex');
}
/** FQDN the tenant must publish the TXT challenge at. */
function buildTxtRecordName(hostname) {
    return `${exports.TXT_RECORD_PREFIX}.${hostname}`;
}
/** Exact TXT value the tenant must publish. Compared with strict equality. */
function buildTxtRecordValue(token) {
    return `${exports.TXT_RECORD_VALUE_PREFIX}${token}`;
}
/** Production TXT resolver over Node DNS. DNS failures reject (fail closed). */
async function resolveTxtViaDns(fqdn) {
    const answers = await (0, promises_1.resolveTxt)(fqdn);
    return answers.map((entry) => entry.join(''));
}
function normalizeTxtEntry(entry) {
    const joined = typeof entry === 'string' ? entry : entry.join('');
    const trimmed = joined.trim();
    // DNS libraries may surface records with surrounding quotes.
    if (trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"')) {
        return trimmed.slice(1, -1).trim();
    }
    return trimmed;
}
/**
 * True only when one published TXT record exactly equals the expected
 * challenge value. Substring/container matches never verify.
 */
function txtRecordsProveOwnership(records, expectedToken) {
    if (typeof expectedToken !== 'string' || expectedToken.length === 0)
        return false;
    const expected = buildTxtRecordValue(expectedToken);
    return records.some((entry) => normalizeTxtEntry(entry) === expected);
}
/**
 * Verify ownership by reading the challenge TXT record. Any resolver error
 * fails closed (`verified: false`) so DNS outages never grant ownership.
 */
async function verifyDomainOwnership(check) {
    const validated = validateCustomHostname(check.hostname);
    if (!validated.ok)
        return { verified: false, reason: 'INVALID_HOSTNAME' };
    let records;
    try {
        records = await check.resolveTxt(buildTxtRecordName(validated.hostname));
    }
    catch {
        return { verified: false, reason: 'DNS_LOOKUP_FAILED' };
    }
    if (txtRecordsProveOwnership(records, check.expectedToken))
        return { verified: true };
    return { verified: false, reason: 'TXT_MISMATCH' };
}
/**
 * Cross-tenant claim gate. No claim (or a claim owned by the same tenant)
 * allows the flow to continue; a claim owned by any other tenant denies it
 * regardless of pending/verified status, blocking domain takeover.
 */
function canClaimDomain(existing, tenantId) {
    if (!existing || existing.tenantId === tenantId)
        return { allowed: true };
    return { allowed: false, reason: 'CLAIMED_BY_ANOTHER_TENANT' };
}
/** Hermetic in-memory store for tests and local development. */
function createMemoryDomainClaimStore() {
    const byHostname = new Map();
    return {
        findByHostname: async (hostname) => byHostname.get(hostname) ?? null,
        listByTenant: async (tenantId) => [...byHostname.values()]
            .filter((claim) => claim.tenantId === tenantId)
            .sort((a, b) => (a.hostname < b.hostname ? -1 : a.hostname > b.hostname ? 1 : 0)),
        savePendingClaim: async (input) => {
            const now = new Date().toISOString();
            const previous = byHostname.get(input.hostname);
            if (previous && previous.tenantId !== input.tenantId) {
                throw new Error('Domain is already claimed by another tenant');
            }
            const claim = {
                hostname: input.hostname,
                tenantId: input.tenantId,
                status: 'pending',
                token: input.token,
                txtName: input.txtName,
                createdAt: previous?.createdAt ?? now,
                updatedAt: now,
                verifiedAt: null,
            };
            byHostname.set(input.hostname, claim);
            return { ...claim };
        },
        markVerified: async (hostname, tenantId) => {
            const current = byHostname.get(hostname);
            if (!current || current.tenantId !== tenantId)
                return null;
            const now = new Date().toISOString();
            const verified = {
                ...current,
                status: 'verified',
                updatedAt: now,
                verifiedAt: now,
            };
            byHostname.set(hostname, verified);
            return { ...verified };
        },
        deleteClaim: async (hostname, tenantId) => {
            const current = byHostname.get(hostname);
            if (!current || current.tenantId !== tenantId)
                return false;
            byHostname.delete(hostname);
            return true;
        },
    };
}
function rowToClaim(row) {
    return {
        hostname: row.hostname,
        tenantId: row.tenant_id,
        status: row.status === 'verified' ? 'verified' : 'pending',
        token: row.verification_token,
        txtName: row.txt_name,
        createdAt: String(row.created_at),
        updatedAt: String(row.updated_at),
        verifiedAt: row.verified_at ? String(row.verified_at) : null,
    };
}
/**
 * Production store over the `tenant_custom_domains` table (created by a
 * versioned migration outside this change; this module executes no DDL).
 * Every mutation is scoped by (hostname, tenant_id) so a caller can only
 * ever transition or release its own tenant's claim.
 */
function createSqlDomainClaimStore(db) {
    return {
        findByHostname: async (hostname) => {
            const row = await db.queryOne(`SELECT hostname,tenant_id,status,verification_token,txt_name,created_at,updated_at,verified_at
         FROM tenant_custom_domains WHERE hostname=? LIMIT 1`, [hostname]);
            return row ? rowToClaim(row) : null;
        },
        listByTenant: async (tenantId) => {
            const rows = await db.query(`SELECT hostname,tenant_id,status,verification_token,txt_name,created_at,updated_at,verified_at
         FROM tenant_custom_domains WHERE tenant_id=? ORDER BY hostname ASC`, [tenantId]);
            return rows.map(rowToClaim);
        },
        savePendingClaim: async (input) => {
            await db.execute(`INSERT INTO tenant_custom_domains
          (hostname,tenant_id,status,verification_token,txt_name,created_at,updated_at,verified_at)
         VALUES (?,?, 'pending',?,?,UTC_TIMESTAMP(),UTC_TIMESTAMP(),NULL)
         ON DUPLICATE KEY UPDATE
          verification_token=IF(tenant_id=VALUES(tenant_id),VALUES(verification_token),verification_token),
          txt_name=IF(tenant_id=VALUES(tenant_id),VALUES(txt_name),txt_name),
          status=IF(tenant_id=VALUES(tenant_id),'pending',status),
          verified_at=IF(tenant_id=VALUES(tenant_id),NULL,verified_at),
          updated_at=IF(tenant_id=VALUES(tenant_id),UTC_TIMESTAMP(),updated_at)`, [input.hostname, input.tenantId, input.token, input.txtName]);
            const saved = await db.queryOne(`SELECT hostname,tenant_id,status,verification_token,txt_name,created_at,updated_at,verified_at
         FROM tenant_custom_domains WHERE hostname=? AND tenant_id=? LIMIT 1`, [input.hostname, input.tenantId]);
            if (!saved)
                throw new Error('Domain claim write was not visible to the owning tenant');
            return rowToClaim(saved);
        },
        markVerified: async (hostname, tenantId) => {
            await db.execute(`UPDATE tenant_custom_domains
         SET status='verified',verified_at=UTC_TIMESTAMP(),updated_at=UTC_TIMESTAMP()
         WHERE hostname=? AND tenant_id=? AND status='pending'`, [hostname, tenantId]);
            const row = await db.queryOne(`SELECT hostname,tenant_id,status,verification_token,txt_name,created_at,updated_at,verified_at
         FROM tenant_custom_domains WHERE hostname=? AND tenant_id=? LIMIT 1`, [hostname, tenantId]);
            if (!row || row.status !== 'verified')
                return null;
            return rowToClaim(row);
        },
        deleteClaim: async (hostname, tenantId) => {
            const result = await db.execute(`DELETE FROM tenant_custom_domains WHERE hostname=? AND tenant_id=?`, [hostname, tenantId]);
            return result.affectedRows > 0;
        },
    };
}
