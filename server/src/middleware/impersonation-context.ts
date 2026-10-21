/**
 * M7 O6 — request-level enforcement of a verified impersonation context.
 *
 * This is the integration the hardening record left open
 * (docs/streams/server/IMPERSONATION-HARDENING-20261019.md section 6): the
 * session lifecycle exists, but no request was impersonated because nothing
 * enforced the `x-impersonation` header. This module is that missing seam,
 * implemented as ordinary Express middleware mounted after the shared auth
 * guard so it runs on the ACTUAL common auth flow, not beside it.
 *
 * Rules (contract: docs/contracts/IMPERSONATION-INTEGRATION.md):
 *  1. The header is only ever CONTEXT. Authorization still resolves from
 *     server-derived rows; the header grants nothing by itself.
 *  2. Absent header -> the request is an ordinary request (unchanged).
 *  3. A present header is an ASSERTION of impersonation: missing bearer,
 *     malformed, bad signature, expired, revoked, unapproved, or a row that
 *     no longer matches the token all DENY — there is no fallback to the
 *     normal principal.
 *  4. The bearer must be the session's ACTOR (the separately authenticated
 *     support principal recorded as `started_by`), never the target: a token
 *     presented with the target's own credentials ("stolen context") or by
 *     any third principal is refused. No target credential is ever required.
 *  5. The actor must STILL hold the verified platform permission that
 *     authorized the session (`impersonation.start`) on EVERY context
 *     request, re-read from server rows through an injectable seam: removing
 *     the starter actor's permission (or their platform membership) ends
 *     impersonation on the very next request even while the target identity,
 *     the actor's user row, their token version and the session row all
 *     remain live and unchanged. A server-verified super_admin satisfies
 *     the key exactly like the management start guard — a JWT role claim
 *     alone never does. Fail closed: a false verdict, a store failure, or
 *     an absent seam all deny.
 *  6. A verified context can never manage sessions (the management
 *     namespace is denied; the router rejects it too).
 *  7. Once the actor binding and permission recheck pass, the EFFECTIVE
 *     principal is resolved
 *     SERVER-SIDE from the verified session row (target user + tenant) via
 *     the injected resolver — the live identity row decides role/liveness and
 *     live membership rows decide scope, so a suspended, deactivated or
 *     membership-revoked target fails closed on the very next request. No
 *     target JWT is minted, no header role is trusted, no membership is
 *     bypassed. The original actor is preserved in `req.impersonation`.
 *  8. Initial integration is READ-ONLY: only safe read methods on the
 *     approved prefix allowlist pass. Mutations are denied for both scopes —
 *     read scope by `evaluateImpersonationWrite` (`read_only`), write scope
 *     because no business route has opted in by declaring a stable action id
 *     yet. Protected actions (credentials/MFA/money/deletes) are blocked by
 *     classification regardless.
 *  9. Denials do not leak whether a session id exists.
 * 10. The verified context (actor vs target banner facts) is attached to
 *     `req.impersonation` only after every check passes; handlers read it
 *     from there, never from the raw header.
 *
 * No `any`, no ts-ignore, no signing-key material or tokens in logs.
 */
import { Request, RequestHandler, Response, NextFunction } from 'express';
import type { AuthRequest } from './auth';
import {
    IMPERSONATION_HEADER,
    type ImpersonationContext,
    type ImpersonationProtectionKind,
    type ImpersonationRequestPrincipal,
    type ImpersonationVerifyResult,
    evaluateImpersonationWrite,
    matchImpersonationPrincipal,
} from '../services/impersonation';
import { createProductionImpersonationVerifier } from '../routes/impersonation';
import { resolveImpersonationTargetPrincipal } from './auth';

/** The verifier seam: signature + expiry + LIVE session row on every call. */
export type ImpersonationVerifier = (token: unknown) => Promise<ImpersonationVerifyResult>;

/**
 * Session-management namespace. A context must never start, approve, revoke
 * or list sessions — the management router rejects a context itself, but the
 * namespace is denied here first as defense in depth.
 */
export const IMPERSONATION_MANAGEMENT_PREFIX = '/api/platform/impersonation';

/**
 * The approved platform permission key the actor must STILL hold on every
 * context request: the same verified key the management start guard
 * requires (`routes/impersonation.ts`), resolved from server rows — never
 * from a JWT role claim. Removing this key from the starter actor (or
 * their platform membership) denies the very next impersonated request even
 * while the actor's user row, token version, the target identity and the
 * session row all remain live and unchanged.
 */
export const IMPERSONATION_ACTOR_PERMISSION_KEY = 'impersonation.start';

/**
 * Live, server-row verified platform-permission recheck for the
 * authenticated ACTOR. Resolves true only for a server-verified active
 * super_admin or a holder of the permission key (the exact rule of
 * `createRequireAdminPermission` in ../security/admin-permissions); a
 * rejected promise signals a store failure and must be treated as a denial.
 */
export type ActorPermissionCheck = (actorUserId: string) => Promise<boolean>;

/**
 * Approved read-only allowlist prefixes (hardening record section 6.3).
 * Default deny: a path passes only when it equals a prefix or continues it
 * at a path-segment boundary (`/api/attendance` allows `/api/attendance/1`
 * but not `/api/attendance-records`, which is a separate surface).
 */
export const IMPERSONATION_READ_ALLOWED_PREFIXES: readonly string[] = [
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
export const IMPERSONATION_ALWAYS_DENIED_PREFIXES: readonly string[] = [
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
export const matchesPathPrefix = (path: string, prefix: string): boolean =>
    path === prefix || path.startsWith(`${prefix}/`);

/** The request path without query; impersonation decisions never read query state. */
export const impersonationRequestPath = (req: Request): string => req.originalUrl.split('?')[0];

/**
 * Default action id for the request-level action classification:
 * `<method> <path-without-/api>`, e.g. `delete /exams/42`, so
 * `classifyProtectedAction` catches password/MFA/money/delete-shaped routes
 * even before a route declares a stable action id.
 */
export const defaultImpersonationActionId = (method: string, path: string): string =>
    `${method.toLowerCase()} ${path.replace(/^\/api\/?/, '')}`;

export type ImpersonationDenialCode =
    | 'IMPERSONATION_UNAUTHENTICATED'
    | 'IMPERSONATION_INVALID'
    | 'IMPERSONATION_DENIED'
    | 'IMPERSONATION_BLOCKED'
    | 'IMPERSONATION_SCOPE';

/**
 * Server-side resolver for the session target's EFFECTIVE principal. It
 * receives only the verified context's target user id and tenant (both read
 * from the live session row, never from the client) and must re-derive the
 * principal from live rows — identity role/liveness and membership scope —
 * returning null when the target identity can no longer serve requests
 * (deactivated, suspended, or no longer a member of the session tenant).
 */
export type EffectivePrincipalResolver = (
    targetUserId: string,
    tenantId: string,
) => Promise<NonNullable<AuthRequest['user']> | null>;

export type ImpersonationRequestOutcome =
    | { ok: true; context: ImpersonationContext | null; effectivePrincipal?: NonNullable<AuthRequest['user']> }
    | {
        ok: false;
        status: 401 | 403;
        code: ImpersonationDenialCode;
        reason: string;
        error: string;
        protection?: ImpersonationProtectionKind;
    };

export interface ImpersonationEnforcementDeps {
    verifier: ImpersonationVerifier;
    /** Principal resolved by the shared auth flow, or null when anonymous. */
    principal: ImpersonationRequestPrincipal | null;
    /** Raw `x-impersonation` header value as received. */
    header: unknown;
    method: string;
    path: string;
    /**
     * Required whenever a header is presented: resolves the effective target
     * principal server-side. A null result denies the request.
     */
    resolveEffectivePrincipal?: EffectivePrincipalResolver;
    /**
     * Live server-row recheck of the authenticated actor's platform
     * permission, required whenever a header is presented: the actor must
     * still hold `IMPERSONATION_ACTOR_PERMISSION_KEY`. A false verdict, a
     * rejected promise (store failure) or an ABSENT seam all deny — a
     * support context never survives a permission withdrawal, a lookup
     * failure or an unconfigured wire. Ordinary (headerless) requests never
     * consult it.
     */
    checkActorPermission?: ActorPermissionCheck;
    actionOf?: (method: string, path: string) => string;
    managementPrefix?: string;
    allowedPrefixes?: readonly string[];
    deniedPrefixes?: readonly string[];
}

const denied = (
    status: 401 | 403,
    code: ImpersonationDenialCode,
    reason: string,
    error: string,
    protection?: ImpersonationProtectionKind,
): ImpersonationRequestOutcome => ({ ok: false, status, code, reason, error, protection });

/**
 * The contract evaluation, separated from Express so the allow/deny matrix
 * is directly testable. Returns the verified context to attach, or the
 * precise denial. Never throws: every failure is a closed denial.
 */
export const evaluateImpersonationRequest = async (
    deps: ImpersonationEnforcementDeps,
): Promise<ImpersonationRequestOutcome> => {
    const {
        verifier, principal, header, method, path,
        resolveEffectivePrincipal, checkActorPermission,
        actionOf = defaultImpersonationActionId,
        managementPrefix = IMPERSONATION_MANAGEMENT_PREFIX,
        allowedPrefixes = IMPERSONATION_READ_ALLOWED_PREFIXES,
        deniedPrefixes = IMPERSONATION_ALWAYS_DENIED_PREFIXES,
    } = deps;
    // An ordinary request: no context is asserted and nothing changes.
    if (header === undefined || header === null) return { ok: true, context: null };
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
    const binding = matchImpersonationPrincipal(context, principal);
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
    let actorPermitted: boolean;
    try {
        actorPermitted = await checkActorPermission(principal.userId);
    } catch {
        return denied(403, 'IMPERSONATION_DENIED', 'actor_permission_unavailable', 'The impersonation actor permission could not be verified');
    }
    if (!actorPermitted) {
        return denied(403, 'IMPERSONATION_DENIED', 'actor_permission_revoked', 'The authenticated actor no longer holds the required platform permission');
    }

    if (matchesPathPrefix(path, managementPrefix)) {
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
        if (deniedPrefixes.some((prefix) => matchesPathPrefix(path, prefix))) {
            return denied(403, 'IMPERSONATION_SCOPE', 'path_denied', 'This surface is always denied while impersonating');
        }
        if (!allowedPrefixes.some((prefix) => matchesPathPrefix(path, prefix))) {
            return denied(403, 'IMPERSONATION_SCOPE', 'path_not_allowed', 'This path is not in the impersonation read allowlist');
        }
        return { ok: true, context, effectivePrincipal };
    }

    // Mutating request: the action gate first (protected actions and the
    // read-only scope), then the integration-wide no-mutation rule.
    const action = actionOf(method, path);
    const actionVerdict = evaluateImpersonationWrite(context, action);
    if (actionVerdict.blocked) {
        return denied(
            403,
            'IMPERSONATION_BLOCKED',
            actionVerdict.protection,
            `This action is blocked while impersonating (${actionVerdict.protection})`,
            actionVerdict.protection,
        );
    }
    // Write scope reached here: mutations still require the route to opt in
    // by declaring a stable action id, which no route does yet, so the
    // initial integration stays read-only.
    return denied(403, 'IMPERSONATION_SCOPE', 'mutation_not_enabled', 'Mutations are not enabled under an impersonation context yet');
};

export interface ImpersonationContextMiddlewareDeps {
    verifier: ImpersonationVerifier;
    /**
     * Server-side resolver for the session target's effective principal.
     * Required for any request that actually presents a header: production
     * binds it to the live identity/membership rows (see
     * `resolveImpersonationTargetPrincipal` in ./auth).
     */
    resolveEffectivePrincipal?: EffectivePrincipalResolver;
    /**
     * Live server-row recheck of the authenticated actor's platform
     * permission (see `checkActorPermission` on `ImpersonationEnforcementDeps`).
     * Production binds it to the verified platform-permission lookup.
     */
    checkActorPermission?: ActorPermissionCheck;
    /** Overrides the action id used for mutating-request classification. */
    actionOf?: (method: string, path: string) => string;
    managementPrefix?: string;
    allowedPrefixes?: readonly string[];
    deniedPrefixes?: readonly string[];
}

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
export const createImpersonationContextMiddleware = (
    deps: ImpersonationContextMiddlewareDeps,
): RequestHandler =>
    (req: AuthRequest, res: Response, next: NextFunction): void => {
        void (async () => {
            const outcome = await evaluateImpersonationRequest({
                verifier: deps.verifier,
                principal: req.user
                    ? { userId: req.user.id, tenantId: req.user.tenantId ?? null }
                    : null,
                header: req.headers[IMPERSONATION_HEADER],
                method: req.method,
                path: impersonationRequestPath(req),
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
        })().catch((error: unknown) => {
            console.error('Impersonation context enforcement failed unexpectedly:', error);
            res.status(403).json({
                error: 'The impersonation context could not be enforced',
                code: 'IMPERSONATION_DENIED',
                reason: 'enforcement_error',
            });
        });
    };

/**
 * Explicit rejection for the independently authenticated opaque-token parent
 * path (`/api/parent`), which is mounted BEFORE the shared JWT guard chain by
 * design and therefore cannot verify a context. A presented
 * `x-impersonation` header there is REFUSED instead of silently ignored: the
 * parent surface never serves an impersonated request.
 */
export const rejectImpersonationHeader: RequestHandler = (req: Request, res: Response, next: NextFunction): void => {
    const header = req.headers[IMPERSONATION_HEADER];
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

/**
 * Adopter-facing per-route gate: a handler that declares a stable action id
 * mounts this before its own logic. Without a verified context the request
 * is ordinary and passes; with one, the action is evaluated exactly like the
 * request-level gate (protected actions and read-scope mutations blocked).
 */
export const enforceImpersonationAction = (actionOf: (req: Request) => string): RequestHandler =>
    (req: AuthRequest, res: Response, next: NextFunction): void => {
        const context = req.impersonation ?? null;
        if (!context) {
            next();
            return;
        }
        const verdict = evaluateImpersonationWrite(context, actionOf(req));
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

/* ----------------------------------------------------------------------- */
/* Production wiring.                                                       */
/* ----------------------------------------------------------------------- */

let productionVerifier: ImpersonationVerifier | null = null;

/**
 * The production verifier is built once from the shared SQL store and the
 * dedicated `IMPERSONATION_TOKEN_SECRET` (never the JWT secret) and re-reads
 * the live session row on every call, so revoke is immediate. Built lazily so
 * importing this module never touches the database.
 */
const verifierFor = (token: unknown): Promise<ImpersonationVerifyResult> => {
    productionVerifier ??= createProductionImpersonationVerifier();
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
export const enforceImpersonationContext: RequestHandler =
    (req: AuthRequest, res: Response, next: NextFunction): void => {
        createImpersonationContextMiddleware({
            verifier: verifierFor,
            checkActorPermission: async (actorUserId: string) => {
                // Lazy import: the module loads its SQL layer lazily too, so
                // mounting never touches the database.
                const { hasVerifiedPlatformPermission } = await import('../security/admin-permissions');
                return hasVerifiedPlatformPermission(IMPERSONATION_ACTOR_PERMISSION_KEY, actorUserId);
            },
            resolveEffectivePrincipal: async (targetUserId, tenantId) => {
                const outcome = await resolveImpersonationTargetPrincipal(targetUserId, tenantId, req);
                // A target identity that no longer resolves fails closed.
                return outcome.ok ? outcome.user : null;
            },
        })(req, res, next);
    };
