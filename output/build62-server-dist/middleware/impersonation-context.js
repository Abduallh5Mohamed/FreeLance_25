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
Object.defineProperty(exports, "__esModule", { value: true });
exports.enforceImpersonationContext = exports.enforceImpersonationAction = exports.rejectImpersonationHeader = exports.createImpersonationContextMiddleware = exports.evaluateImpersonationRequest = exports.defaultImpersonationActionId = exports.impersonationRequestPath = exports.matchesPathPrefix = exports.IMPERSONATION_ALWAYS_DENIED_PREFIXES = exports.IMPERSONATION_READ_ALLOWED_PREFIXES = exports.IMPERSONATION_ACTOR_PERMISSION_KEY = exports.IMPERSONATION_MANAGEMENT_PREFIX = void 0;
const impersonation_1 = require("../services/impersonation");
const impersonation_2 = require("../routes/impersonation");
const auth_1 = require("./auth");
/**
 * Session-management namespace. A context must never start, approve, revoke
 * or list sessions — the management router rejects a context itself, but the
 * namespace is denied here first as defense in depth.
 */
exports.IMPERSONATION_MANAGEMENT_PREFIX = '/api/platform/impersonation';
/**
 * The approved platform permission key the actor must STILL hold on every
 * context request: the same verified key the management start guard
 * requires (`routes/impersonation.ts`), resolved from server rows — never
 * from a JWT role claim. Removing this key from the starter actor (or
 * their platform membership) denies the very next impersonated request even
 * while the actor's user row, token version, the target identity and the
 * session row all remain live and unchanged.
 */
exports.IMPERSONATION_ACTOR_PERMISSION_KEY = 'impersonation.start';
/**
 * Approved read-only allowlist prefixes (hardening record section 6.3).
 * Default deny: a path passes only when it equals a prefix or continues it
 * at a path-segment boundary (`/api/attendance` allows `/api/attendance/1`
 * but not `/api/attendance-records`, which is a separate surface).
 */
exports.IMPERSONATION_READ_ALLOWED_PREFIXES = [
    '/api/courses',
    '/api/lectures',
    '/api/materials',
    '/api/attendance',
    '/api/exams',
    '/api/exam-results',
    '/api/grades',
    '/api/groups',
    '/api/schedules',
    '/api/assignments',
    '/api/gradebook',
    '/api/students',
    '/api/notifications',
    '/api/messages',
];
/**
 * Always denied under a context, even for safe read methods: bulk, PII,
 * credential, billing, management and audit surfaces.
 */
exports.IMPERSONATION_ALWAYS_DENIED_PREFIXES = [
    '/api/platform',
    '/api/auth',
    '/api/tenant-exports',
    '/api/files',
    '/api/instructor-wallet',
    '/api/fees',
    '/api/payment-requests',
    '/api/subscriptions',
    '/api/audit-logs',
    '/api/search',
];
const SAFE_READ_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
/** Segment-boundary prefix match: exact path or a child path segment. */
const matchesPathPrefix = (path, prefix) => path === prefix || path.startsWith(`${prefix}/`);
exports.matchesPathPrefix = matchesPathPrefix;
/** The request path without query; impersonation decisions never read query state. */
const impersonationRequestPath = (req) => req.originalUrl.split('?')[0];
exports.impersonationRequestPath = impersonationRequestPath;
/**
 * Default action id for the request-level action classification:
 * `<method> <path-without-/api>`, e.g. `delete /exams/42`, so
 * `classifyProtectedAction` catches password/MFA/money/delete-shaped routes
 * even before a route declares a stable action id.
 */
const defaultImpersonationActionId = (method, path) => `${method.toLowerCase()} ${path.replace(/^\/api\/?/, '')}`;
exports.defaultImpersonationActionId = defaultImpersonationActionId;
const denied = (status, code, reason, error, protection) => ({ ok: false, status, code, reason, error, protection });
/**
 * The contract evaluation, separated from Express so the allow/deny matrix
 * is directly testable. Returns the verified context to attach, or the
 * precise denial. Never throws: every failure is a closed denial.
 */
const evaluateImpersonationRequest = async (deps) => {
    const { verifier, principal, header, method, path, resolveEffectivePrincipal, checkActorPermission, actionOf = exports.defaultImpersonationActionId, managementPrefix = exports.IMPERSONATION_MANAGEMENT_PREFIX, allowedPrefixes = exports.IMPERSONATION_READ_ALLOWED_PREFIXES, deniedPrefixes = exports.IMPERSONATION_ALWAYS_DENIED_PREFIXES, } = deps;
    // An ordinary request: no context is asserted and nothing changes.
    if (header === undefined || header === null)
        return { ok: true, context: null };
    if (typeof header !== 'string') {
        return denied(403, 'IMPERSONATION_INVALID', 'malformed', 'The impersonation header is malformed');
    }
    // A presented context requires the shared auth flow to have authenticated
    // the request first.
    if (!principal || !principal.userId) {
        return denied(401, 'IMPERSONATION_UNAUTHENTICATED', 'unauthenticated', 'Authentication is required for an impersonated request');
    }
    const verdict = await verifier(header);
    if (!verdict.ok) {
        return denied(403, 'IMPERSONATION_INVALID', verdict.reason, 'The impersonation context is not valid');
    }
    const context = verdict.context;
    // The bearer must be the session's support ACTOR. A context presented
    // with the target's own credentials (or any third principal's) is a
    // stolen context and is refused here.
    const binding = (0, impersonation_1.matchImpersonationPrincipal)(context, principal);
    if (!binding.ok) {
        return denied(403, 'IMPERSONATION_DENIED', binding.reason, 'The impersonation context does not match the authenticated actor');
    }
    // The actor must STILL hold the verified platform permission that
    // authorized the session, re-read from server rows on EVERY context
    // request: withdrawing `impersonation.start` (or the actor's platform
    // membership) ends impersonation on the next request even though the
    // actor's user row, token version, the target identity and the session
    // row are all unchanged. A target that is still live is not enough.
    // Fail closed: an absent seam, a rejected lookup (store failure) and a
    // false verdict all deny, without leaking session existence.
    if (!checkActorPermission) {
        return denied(403, 'IMPERSONATION_DENIED', 'actor_permission_unavailable', 'The impersonation actor permission could not be verified');
    }
    let actorPermitted;
    try {
        actorPermitted = await checkActorPermission(principal.userId);
    }
    catch {
        return denied(403, 'IMPERSONATION_DENIED', 'actor_permission_unavailable', 'The impersonation actor permission could not be verified');
    }
    if (!actorPermitted) {
        return denied(403, 'IMPERSONATION_DENIED', 'actor_permission_revoked', 'The authenticated actor no longer holds the required platform permission');
    }
    if ((0, exports.matchesPathPrefix)(path, managementPrefix)) {
        return denied(403, 'IMPERSONATION_DENIED', 'management_namespace', 'An impersonation context cannot manage impersonation sessions');
    }
    // Effective identity, resolved SERVER-SIDE from the verified session row.
    // Without a resolver seam a presented context can never be served.
    if (!resolveEffectivePrincipal) {
        return denied(403, 'IMPERSONATION_DENIED', 'target_identity_unavailable', 'The impersonation target identity could not be resolved');
    }
    const effectivePrincipal = await resolveEffectivePrincipal(context.targetUserId, context.tenantId);
    if (!effectivePrincipal || effectivePrincipal.id !== context.targetUserId) {
        return denied(403, 'IMPERSONATION_DENIED', 'target_identity_unavailable', 'The impersonation target identity is no longer usable');
    }
    if (String(effectivePrincipal.tenantId ?? '') !== context.tenantId) {
        return denied(403, 'IMPERSONATION_DENIED', 'tenant_mismatch', 'The impersonation target is not an active member of the session tenant');
    }
    const upperMethod = method.toUpperCase();
    if (SAFE_READ_METHODS.has(upperMethod)) {
        if (deniedPrefixes.some((prefix) => (0, exports.matchesPathPrefix)(path, prefix))) {
            return denied(403, 'IMPERSONATION_SCOPE', 'path_denied', 'This surface is always denied while impersonating');
        }
        if (!allowedPrefixes.some((prefix) => (0, exports.matchesPathPrefix)(path, prefix))) {
            return denied(403, 'IMPERSONATION_SCOPE', 'path_not_allowed', 'This path is not in the impersonation read allowlist');
        }
        return { ok: true, context, effectivePrincipal };
    }
    // Mutating request: the action gate first (protected actions and the
    // read-only scope), then the integration-wide no-mutation rule.
    const action = actionOf(method, path);
    const actionVerdict = (0, impersonation_1.evaluateImpersonationWrite)(context, action);
    if (actionVerdict.blocked) {
        return denied(403, 'IMPERSONATION_BLOCKED', actionVerdict.protection, `This action is blocked while impersonating (${actionVerdict.protection})`, actionVerdict.protection);
    }
    // Write scope reached here: mutations still require the route to opt in
    // by declaring a stable action id, which no route does yet, so the
    // initial integration stays read-only.
    return denied(403, 'IMPERSONATION_SCOPE', 'mutation_not_enabled', 'Mutations are not enabled under an impersonation context yet');
};
exports.evaluateImpersonationRequest = evaluateImpersonationRequest;
/**
 * Injectable factory used by tests and by future adopters that need a custom
 * verifier, resolver or allowlist. Production mounts
 * `enforceImpersonationContext`.
 *
 * On a verified context the request's principal becomes the session TARGET
 * (resolved server-side), and the authenticated support actor is preserved in
 * `req.impersonation` — never the other way round. Downstream routers and
 * their own re-checks therefore authorize exactly the target's own
 * server-derived scopes.
 */
const createImpersonationContextMiddleware = (deps) => (req, res, next) => {
    void (async () => {
        const outcome = await (0, exports.evaluateImpersonationRequest)({
            verifier: deps.verifier,
            principal: req.user
                ? { userId: req.user.id, tenantId: req.user.tenantId ?? null }
                : null,
            header: req.headers[impersonation_1.IMPERSONATION_HEADER],
            method: req.method,
            path: (0, exports.impersonationRequestPath)(req),
            resolveEffectivePrincipal: deps.resolveEffectivePrincipal,
            checkActorPermission: deps.checkActorPermission,
            actionOf: deps.actionOf,
            managementPrefix: deps.managementPrefix,
            allowedPrefixes: deps.allowedPrefixes,
            deniedPrefixes: deps.deniedPrefixes,
        });
        if (outcome.ok) {
            if (outcome.context && outcome.effectivePrincipal) {
                // Attached only after every check passed: banner facts for
                // handlers/logs, never the raw header.
                req.impersonation = outcome.context;
                // The effective principal is the session TARGET, resolved
                // server-side. The actor is preserved in the context above.
                // `authResolved` stays true so downstream authenticate
                // middleware does not re-resolve the actor's token.
                req.user = outcome.effectivePrincipal;
                req.authResolved = true;
            }
            next();
            return;
        }
        res.status(outcome.status).json({
            error: outcome.error,
            code: outcome.code,
            reason: outcome.reason,
            ...(outcome.protection ? { protection: outcome.protection } : {}),
        });
    })().catch((error) => {
        console.error('Impersonation context enforcement failed unexpectedly:', error);
        res.status(403).json({
            error: 'The impersonation context could not be enforced',
            code: 'IMPERSONATION_DENIED',
            reason: 'enforcement_error',
        });
    });
};
exports.createImpersonationContextMiddleware = createImpersonationContextMiddleware;
/**
 * Explicit rejection for the independently authenticated opaque-token parent
 * path (`/api/parent`), which is mounted BEFORE the shared JWT guard chain by
 * design and therefore cannot verify a context. A presented
 * `x-impersonation` header there is REFUSED instead of silently ignored: the
 * parent surface never serves an impersonated request.
 */
const rejectImpersonationHeader = (req, res, next) => {
    const header = req.headers[impersonation_1.IMPERSONATION_HEADER];
    if (header === undefined || header === null) {
        next();
        return;
    }
    res.status(403).json({
        error: 'Impersonation contexts are not accepted on this surface',
        code: 'IMPERSONATION_DENIED',
        reason: 'parent_path',
    });
};
exports.rejectImpersonationHeader = rejectImpersonationHeader;
/**
 * Adopter-facing per-route gate: a handler that declares a stable action id
 * mounts this before its own logic. Without a verified context the request
 * is ordinary and passes; with one, the action is evaluated exactly like the
 * request-level gate (protected actions and read-scope mutations blocked).
 */
const enforceImpersonationAction = (actionOf) => (req, res, next) => {
    const context = req.impersonation ?? null;
    if (!context) {
        next();
        return;
    }
    const verdict = (0, impersonation_1.evaluateImpersonationWrite)(context, actionOf(req));
    if (verdict.blocked) {
        res.status(403).json({
            error: `This action is blocked while impersonating (${verdict.protection})`,
            code: 'IMPERSONATION_BLOCKED',
            reason: verdict.protection,
            protection: verdict.protection,
        });
        return;
    }
    next();
};
exports.enforceImpersonationAction = enforceImpersonationAction;
/* ----------------------------------------------------------------------- */
/* Production wiring.                                                       */
/* ----------------------------------------------------------------------- */
let productionVerifier = null;
/**
 * The production verifier is built once from the shared SQL store and the
 * dedicated `IMPERSONATION_TOKEN_SECRET` (never the JWT secret) and re-reads
 * the live session row on every call, so revoke is immediate. Built lazily so
 * importing this module never touches the database.
 */
const verifierFor = (token) => {
    productionVerifier ?? (productionVerifier = (0, impersonation_2.createProductionImpersonationVerifier)());
    return productionVerifier(token);
};
/**
 * Mount immediately after the shared auth guard and BEFORE every business
 * router. Ordinary requests (no `x-impersonation` header) pass through
 * unchanged.
 *
 * The effective-principal resolver is bound per request: the target's own
 * live identity/membership rows decide the effective principal (and the
 * request path participates in the same billing-scope gate a direct request
 * would hit), so a suspended or revoked target fails closed on the very next
 * request.
 *
 * The actor permission is re-checked on every request against server rows
 * through the same verified platform-permission lookup the management start
 * guard uses, so withdrawing the actor's `impersonation.start` permission
 * (or their platform membership) denies the next impersonated request while
 * every row stays live.
 */
const enforceImpersonationContext = (req, res, next) => {
    (0, exports.createImpersonationContextMiddleware)({
        verifier: verifierFor,
        checkActorPermission: async (actorUserId) => {
            // Lazy import: the module loads its SQL layer lazily too, so
            // mounting never touches the database.
            const { hasVerifiedPlatformPermission } = await Promise.resolve().then(() => __importStar(require('../security/admin-permissions')));
            return hasVerifiedPlatformPermission(exports.IMPERSONATION_ACTOR_PERMISSION_KEY, actorUserId);
        },
        resolveEffectivePrincipal: async (targetUserId, tenantId) => {
            const outcome = await (0, auth_1.resolveImpersonationTargetPrincipal)(targetUserId, tenantId, req);
            // A target identity that no longer resolves fails closed.
            return outcome.ok ? outcome.user : null;
        },
    })(req, res, next);
};
exports.enforceImpersonationContext = enforceImpersonationContext;
