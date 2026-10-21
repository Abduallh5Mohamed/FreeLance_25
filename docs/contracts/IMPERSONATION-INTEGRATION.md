# Impersonation integration contract (O6)

Branch: `codex/workbuddy-server`.
Status: implemented for the M7 O6 server milestone on 2026-10-19 by
`server-impersonation-integration-20261019-01`; request-context enforcement and
the management surface are mounted, with the read-only initial scope below.
Corrected on 2026-10-20 by
`server-impersonation-integration-correction-20261020-01` after supervisor
source review: (a) the enforcement is mounted immediately after the shared
`/api` guard chain and BEFORE every business router (it previously sat after
`parent-links`, `notification-consent`, `lesson-discussions`, `search`,
`tenant-exports` and `platform/mfa`), and the opaque-token parent path now
explicitly rejects a presented `x-impersonation` header; (b) the bearer of an
impersonated request is the support ACTOR — the previous binding required
the target's own credentials, which is not support impersonation — and the
effective target principal is resolved server-side from live rows.
Corrected again on 2026-10-20 by
`server-impersonation-live-actor-permission-20261020-01`: the actor's live
platform permission is re-checked from server rows on EVERY context request
(denied `actor_permission_revoked` / `actor_permission_unavailable`), and the
verifier additionally requires the signed scope flag to match the live
session row's scope.

This contract is the normative reference for the `x-impersonation` header. It
extends `docs/streams/server/IMPERSONATION-HARDENING-20261019.md` section 6
(the proposal) with what was actually built, and supersedes the "NOT
implemented" note in that section.

## 1. Surfaces

| Concern | Owner |
| --- | --- |
| Session lifecycle (start/approve/revoke/list) | `server/src/routes/impersonation.ts`, mounted at `/api/platform/impersonation` |
| Request-context enforcement | `server/src/middleware/impersonation-context.ts`, mounted in `server/src/index.ts` immediately after the shared `/api` guard chain |
| Verifier (signature + expiry + LIVE row incl. scope) | `createImpersonationVerifier` in `server/src/services/impersonation.ts` |
| Live actor-permission recheck | `checkActorPermission` seam in `server/src/middleware/impersonation-context.ts`, production-wired to `hasVerifiedPlatformPermission('impersonation.start', actorUserId)` (`server/src/security/admin-permissions.ts`) |
| Context facts for handlers/audit | `req.impersonation` (`AuthRequest.impersonation`, actor vs target) |

## 2. Request flow (exact order)

```
1.  shared auth guard (optionalAuth + tenant/student boundaries) resolves the
    bearer principal from server-side rows
2.  header = req.headers['x-impersonation']
      absent            -> ordinary request; nothing changes
      not a string      -> 403 IMPERSONATION_INVALID (malformed)
3.  no authenticated principal          -> 401 IMPERSONATION_UNAUTHENTICATED
4.  verifier(header)  (signature, expiry, live session row: status active,
    expires_at in the future, started_by/target/tenant/scope match the token)
      !ok                                   -> 403 IMPERSONATION_INVALID <reason>
5.  matchImpersonationPrincipal(context, req.user)
      bearer is not the session ACTOR      -> 403 IMPERSONATION_DENIED actor_mismatch
      bearer tenant is not the session one -> 403 IMPERSONATION_DENIED tenant_mismatch
6.  live actor-permission recheck (server rows, every context request):
    the ACTOR must still hold `impersonation.start` (a verified super_admin
    satisfies the key, exactly like the management start guard; a JWT role
    claim never does)
      seam absent / lookup fails          -> 403 IMPERSONATION_DENIED
                                               actor_permission_unavailable
      permission withdrawn                -> 403 IMPERSONATION_DENIED
                                               actor_permission_revoked
7.  path is the management namespace        -> 403 IMPERSONATION_DENIED management_namespace
8.  effective principal resolved SERVER-SIDE from the verified session row
    (target user + tenant) against live identity/membership rows
      (resolveImpersonationTargetPrincipal, middleware/auth.ts)
      identity dead / not a member         -> 403 IMPERSONATION_DENIED
                                               target_identity_unavailable / tenant_mismatch
9.  req.impersonation = context (banner facts; handlers never read the header)
    AND req.user := the resolved TARGET principal (the actor is preserved in
    req.impersonation.actorUserId; authResolved stays true)
10. safe read method (GET/HEAD/OPTIONS):
      always-denied prefix                  -> 403 IMPERSONATION_SCOPE path_denied
      not in the read allowlist             -> 403 IMPERSONATION_SCOPE path_not_allowed
      allowed                               -> business handler
    mutating method:
      classifyProtectedAction / read scope  -> 403 IMPERSONATION_BLOCKED <protection>
      write scope, no route opt-in          -> 403 IMPERSONATION_SCOPE mutation_not_enabled
```

Rules that must not be relaxed:

- The header is CONTEXT only. Authorization still resolves from server-derived
  rows; the header never grants authority.
- A presented header is an assertion of impersonation. Missing bearer,
  malformed, bad signature, expired, revoked, unapproved or row-mismatched
  headers all DENY; there is no fallback to the normal principal.
- The bearer of an impersonated request is the support ACTOR recorded as
  `started_by`. The target's own credentials are a stolen context
  (`actor_mismatch`) and a different support actor cannot ride someone else's
  context; no target credential is ever required or accepted.
- The effective principal is the session TARGET, resolved server-side from
  live rows (identity role/liveness, membership scope anchored to the verified
  session row's tenant). No target JWT is minted, no role is taken from any
  header or token, and no membership check is skipped; a deactivated,
  suspended or membership-revoked target fails closed on the very next
  request.
- The ACTOR's live platform permission is re-checked on every context
  request: the actor must still hold `impersonation.start` (verified
  super_admin satisfies the key). Withdrawing the permission — or the actor's
  platform membership — denies the next impersonated request even while the
  actor's user row, token version, the target identity and the session row
  all stay live; a live target is not enough. Missing seam, store failure and
  a false verdict all deny (fail closed). Ordinary requests never consult it.
- The signed context's scope flag must equal the live session row's scope;
  the live row's `expires_at` is the only expiry authority (the signed field
  records the issue time).
- Denials must not leak whether a session id exists (signature is checked
  before the row read).
- Ordinary requests (no header) are byte-for-byte the previous behaviour.

## 3. Allowlist

Default deny. Segment-boundary prefix matching: a path passes only when it
equals an allowed prefix or continues it at a `/` boundary
(`/api/attendance/1` passes, `/api/attendance-records` does not — that is a
separate surface).

Read-allowed prefixes (approved hardening record 6.3):

```
/api/courses      /api/lectures       /api/materials     /api/attendance
/api/exams        /api/exam-results   /api/grades        /api/groups
/api/schedules    /api/assignments    /api/gradebook     /api/students
/api/notifications /api/messages
```

Always denied, even for safe read methods (bulk/PII/credential/billing/
management/audit surfaces):

```
/api/platform/**            /api/auth/**               /api/tenant-exports/**
/api/files/**               /api/instructor-wallet/**  /api/fees/**
/api/payment-requests/**    /api/subscriptions/**      /api/audit-logs/**
/api/search/**
```

Mutations: blocked for both scopes in this integration. A read scope denies
every mutation (`evaluateImpersonationWrite`, `read_only`); a write scope
still requires the business route to opt in by declaring a stable action id
(enforced with `enforceImpersonationAction`), and no route has opted in yet.
Protected actions (`password_change`, `mfa_change`, `money_movement`,
`data_delete`) are blocked by classification regardless of scope.

## 4. Actor vs effective principal

- Audit records for the session lifecycle use the platform actor
  (`started_by` / `approved_by` / `revoked_by`) as the actor and the target
  user as the resource subject.
- Under a verified context the request is authenticated as the ACTOR
  (bearer) and then re-principalled to the TARGET: `req.user` is the resolved
  effective principal (target id, role and tenant from the target's own live
  rows) and `req.impersonation` carries BOTH `actorUserId` (support principal)
  and `targetUserId` (effective principal). Adopters that record per-action
  audit events must keep that distinction; no business route has adopted it
  yet (see residuals).
- The actor/tenant binding rejects: the target's own credentials (stolen
  context), a different support actor's credentials, and an actor whose live
  tenant scope differs from the session tenant.
- The live actor-permission recheck (`impersonation.start`, read from server
  rows on every context request) is part of the actor chain: the consulted
  id is the authenticated bearer's — never a header or token value. A
  withdrawn permission denies `actor_permission_revoked`; an absent seam or
  a failing store denies `actor_permission_unavailable` (fail closed).

## 5. Signing prerequisite (operational, fail closed)

```
IMPERSONATION_TOKEN_SECRET=<random secret, >= 32 bytes, distinct from JWT_SECRET>
```

Absent/short/JWT-derived/throwing key: approval returns
`503 SIGNING_UNAVAILABLE` (nothing activated); a presented context verifies
as `store_error`/`signature` and is denied. Rotation invalidates outstanding
context tokens immediately; revoke active sessions first. No secret is stored
in the repository and no `.env` file is modified by this change.

## 6. Mounting notes

- `enforceImpersonationContext` is registered path-less immediately after the
  shared `/api` guard chain in `server/src/index.ts` and BEFORE every business
  router (`/api/parent-links`, `/api/notification-consent`,
  `/api/lesson-discussions`, `/api/search`, `/api/tenant-exports`,
  `/api/platform/mfa`, `/api/platform/impersonation`, and all later mounts).
  The request order for every `/api` surface is therefore exactly the contract
  order above; the path-less form also keeps the existing mounting-contract
  assertions (which pin the guard-chain statement shape and reject bare `/api`
  router mounts) valid without weakening them.
- `/api/parent` (parent views) is mounted BEFORE the shared guard by design
  (opaque `pv1.` tokens, not JWTs) and is therefore unable to verify a
  context: `rejectImpersonationHeader` runs first on that mount and REFUSES a
  presented `x-impersonation` header with 403 `IMPERSONATION_DENIED`
  `parent_path` instead of silently ignoring it. It only ever serves the
  bearer principal's own children data.
- The enforcement's order is regression-tested two ways in
  `server/tests/m7-impersonation-integration.test.ts`: the mount order is
  asserted from the real `index.ts` source, and the assembled chain (in the
  extracted production order) is driven end-to-end so an unauthorized context
  on any surface — including the previously earlier ones — cannot reach a
  handler.

## 7. Residuals / not implemented

- Write-scope mutations and per-route action opt-in: future work (deployed
  read-only).
- UI banner / customer disclosure rendering: human-frontend dependency; the
  server exposes the banner facts only.
- Rate limiting for the management endpoints remains in-process.
- No live MySQL verification of `FOR UPDATE` or of the live platform
  permission-row lookup in this change (hermetic seam only).
