# Impersonation approval hardening — 2026-10-19

Task: `server-impersonation-hardening-20261019-01` (team `security`, batch
`parallel-server-completion-20261019`).
Branch: `codex/workbuddy-server`.

## Status

- Approval path corrected and covered by hermetic tests.
- **The impersonation router is NOT mounted** and `middleware/auth.ts` is NOT
  modified. Mounting `createImpersonationRouter` only exposes session
  management (start/approve/revoke/list); it does **not** implement
  impersonation on other requests. Request enforcement requires the
  integration contract in section 6, which is deliberately left to a separate
  approved change.

## 1. Defect reproduced before the fix

`POST /:id/approve` performed, in this order:

1. `findSession` (no lock) -> `transitionToActive` (pending -> active),
2. a separate `recordAudit` call wrapped in a no-op "transaction" by default,
3. `tokenKey()`; when it returned `null` the route answered **200** with
   `impersonation_token: null`,
4. the default key provider was `getJwtSecret()`, i.e. the JWT secret, and it
   **threw** when `JWT_SECRET` was unset — after the session was already
   active.

Observable failures on the unfixed code (new test file, before the change):

- missing / too-short / JWT-derived key -> `200` and `status = active`
  (unusable session, null token);
- audit sink failure -> `500`, but the row stayed `active` and unaudited;
- nothing prevented the two steps from landing on different connections.

## 2. What changed

### `server/src/services/impersonation.ts`

- `ImpersonationStore` gained `lockSession(sessionId)`; the SQL store issues
  `SELECT ... FOR UPDATE` (requires an open transaction).
- New `ImpersonationApprovalTransaction` / `ImpersonationTransactionRunner`
  seam: `lockSession`, `transitionToActive`, `readSession`, `recordAudit`.
- `createImpersonationService` now **requires** `approvalTransaction`. There is
  deliberately no non-transactional fallback: a caller that cannot supply a
  transaction cannot approve.
- `approve()` runs as one unit of work:
  1. locked read (`FOR UPDATE`),
  2. state/self-approval checks against the locked row,
  3. expiry computed from the locked row, clamped to 30 minutes,
  4. guarded `UPDATE ... WHERE id = ? AND status = 'pending_approval' AND started_by <> ?`
     and `affectedRows === 1` is required (0 -> `besides_transition`, 409),
  5. re-read of the activated row,
  6. sealed audit append **on the same transaction**.
  Any throw (including a failed audit) propagates out of the runner, so the
  production `withTransaction` rolls the activation back.
- `resolveImpersonationSigningKey(provider, { jwtSecret })`: fail-closed
  validator. Missing/`null`/throwing provider -> `missing`; non-Buffer or
  fewer than 32 bytes -> `invalid`; key bytes equal to the JWT secret ->
  `invalid`.
- `signImpersonationToken` now rejects key material shorter than 32 bytes, so
  a short key cannot silently mint a weak token.
- `matchImpersonationPrincipal(context, principal)`: pure binding check used by
  the future middleware (target user + tenant; deny reasons
  `unauthenticated` / `target_mismatch` / `tenant_mismatch`).

### `server/src/routes/impersonation.ts`

- `ImpersonationRouteDeps.approvalTransaction` is required.
- Removed the fake `transaction?` wrapper around `recordAudit` for start and
  revoke (it never contained the mutation). Those two still audit after their
  write; see residual risk R2.
- Approve handler:
  1. resolves and validates the signing key **before** calling the service;
     failure -> `503 { error, code: 'SIGNING_UNAVAILABLE' }`, nothing written;
  2. calls `service.approve` (atomic mutation + audit);
  3. mints the token with the already validated key — the response field is
     always a string, there is no null-token success path;
  4. best-effort tenant notification (unchanged).
- Default `tokenKey` reads **`IMPERSONATION_TOKEN_SECRET` only**; the JWT
  secret is never a fallback. The JWT secret is passed to the validator so a
  shared key is rejected.
- Production wiring adds `approvalTransaction` built on the existing
  `withTransaction` from `server/src/db.ts`; the audit append receives the
  same connection (`recordSealedAuditEvent(txDb, input)`), so the audit-chain
  head lock, the session row lock, the UPDATE and the audit insert commit or
  roll back together.
- No route mounting, no `index.ts` change, no auth-middleware change, no new
  migration, no SQL execution.

### Tests

- `server/tests/m7-impersonation.test.ts` — harness updated to the required
  transaction seam; assertions unchanged (21 tests, all still pass).
- `server/tests/m7-impersonation-hardening.test.ts` — new (13 tests).

## 3. Behaviour preserved (regression-covered)

- starter and approver must be different (`self_approval`, 403);
- only `pending_approval` can activate (`not_pending`, 409);
- exact target tenant: target resolution is `(targetUserId, tenantId)` and the
  route denies `404` when no row matches; no enumeration;
- no privileged target: `role = 'admin'` -> 403, and the production resolver
  excludes `u.role <> 'admin'`;
- short expiry: requested seconds clamped to 1..1800; activation expiry is
  `min(now + requested, existing expiry)` and never above 30 minutes;
- allowed read scope: `scope` defaults to `read`, `write` only when explicit;
  read scope denies every mutation through `evaluateImpersonationWrite`;
- live revoke: verifier re-reads the session row on every call;
- protected-action deny: password/MFA/money/delete always blocked, even with
  `write` scope;
- verified platform permissions only: no raw JWT role claim is used for
  authorization; identity/authority resolution is untouched.

## 4. Signing prerequisites (operational, fail closed)

Before the route is mounted, the deployment must set:

```
IMPERSONATION_TOKEN_SECRET=<random secret, >= 32 bytes, distinct from JWT_SECRET>
```

- absent, shorter than 32 bytes, equal to `JWT_SECRET`, or a throwing
  provider -> approve returns `503 SIGNING_UNAVAILABLE`, the session stays
  `pending_approval`, no audit and no notification are written;
- verification with an unavailable key denies (`store_error`), with a wrong
  key denies (`signature`);
- rotation: changing the secret invalidates every outstanding context token
  immediately; live sessions remain active in the table and can be revoked.
  Rotation therefore requires revoking active sessions first (or accepting
  that their tokens stop verifying).

No secret is added to the repository and no `.env` file is modified by this
change.

## 5. Token binding

`imp1.<sessionId>.<actor>.<target>.<tenant>.<w0|w1>.<iat>.<mac>`

- `actor` is `session.started_by` (the support principal that started it);
- `target` is `session.target_user_id`;
- `tenant` is `session.tenant_id`;
- the MAC covers all parts with HMAC-SHA256 over the dedicated key.

The verifier re-checks signature, then the **live** row: `status = 'active'`,
`expires_at > now`, and `started_by` / `target_user_id` / `tenant_id` equal to
the token claims. Any mismatch is `row_mismatch`.

## 6. Integration contract for `x-impersonation` (NOT implemented here)

This section is a specification for a separate approved change. Nothing below
is mounted or enforced today.

### 6.1 Proposed files

| File | Change | Notes |
| --- | --- | --- |
| `server/src/middleware/impersonation-context.ts` | new | builds the verifier once from the shared store and `IMPERSONATION_TOKEN_SECRET`; exports `enforceImpersonationContext` and `enforceImpersonationAction(actionOf)` |
| `server/src/index.ts` | mount | `app.use('/api', enforceImpersonationContext)` **after** `optionalAuth` + tenant/student boundary middleware, **before** any business router |
| `server/src/index.ts` | mount | `app.use('/api/platform/impersonation', impersonationRoutes)` with its own `authenticate` (already inside the router) |
| `server/src/config/impersonation.ts` | optional | single reader for the dedicated secret and the read allowlist; no behavior change if omitted |

### 6.2 Request flow (exact order)

```
1. authenticate (existing)  -> req.user or 401
2. header = req.headers['x-impersonation']
   - absent -> continue as the normal principal (no impersonation)
3. verdict = await verifier(header)
   - !ok -> 403 { code: 'IMPERSONATION_INVALID', reason }   (fail closed)
4. principal = { userId: req.user.id, tenantId: req.user.tenantId ?? null }
   binding = matchImpersonationPrincipal(verdict.context, principal)
   - !ok -> 403 { code: 'IMPERSONATION_DENIED', reason }
5. if path is the impersonation-management namespace -> 403
   (a context can never manage sessions; the router already rejects it too)
6. req.impersonation = verdict.context      // banner facts for handlers/logs
7. action = `${routerName}.${handlerName}` or an explicit per-route action id
   write = evaluateImpersonationWrite(context, action)
   - blocked -> 403 { code: 'IMPERSONATION_BLOCKED', protection }
8. method/path allowlist (section 6.3)
   - not allowed -> 403 { code: 'IMPERSONATION_SCOPE' }
9. continue to the business handler
```

Rules that must not be relaxed:

- The bearer principal is the **target user**; `req.user` is never silently
  swapped from the support actor. `matchImpersonationPrincipal` rejects a
  token presented for another target or tenant.
- A missing/invalid/expired/revoked header is a denial, never "fall back to
  the normal principal": a client that sends the header is asserting
  impersonation and must not gain the support principal's authority.
- The context is attached only after verification; handlers read
  `req.impersonation`, never the raw header.
- Denials must not leak whether the session id exists.

### 6.3 Safe read-only allowlist

Default deny. With `scope = 'read'` only `GET`/`HEAD`/`OPTIONS` are allowed,
and only below these prefixes:

```
/api/courses            /api/lectures           /api/materials
/api/attendance         /api/exams              /api/exam-results
/api/grades             /api/groups             /api/schedules
/api/assignments        /api/gradebook          /api/students
/api/notifications      /api/messages
```

Always denied, even for `GET` (bulk/PII/credential/billing surfaces):

```
/api/platform/**        /api/auth/**            /api/tenant-exports/**
/api/files/**           /api/instructor-wallet/**  /api/fees/**
/api/payment-requests/**  /api/subscriptions/**  /api/audit/**
/api/search/**          (bulk cross-entity reads)
```

`scope = 'write'` may additionally pass non-`GET` methods only when all of the
following hold: the path is in the allowlist, the action is not classified as
protected, and the route opted in by declaring a stable action id. Any
`classifyProtectedAction(action)` hit is blocked for both scopes:

- `password_change`, `mfa_change` — credential/step-up changes;
- `money_movement` — wallet, refunds, invoices, billing;
- `data_delete` — delete/purge/destroy.

The allowlist is a starting proposal and needs product/security sign-off; the
mechanism (deny by default, explicit prefix list) is the part that should not
change.

### 6.4 What this contract does not do

- It does not mount anything, so no request is currently impersonated.
- It does not change `middleware/auth.ts`; the middleware above is additive.
- It does not grant the support actor any authority: authorization still
  resolves from server rows for the target user, and protected actions stay
  blocked.
- It does not implement UI/banner rendering; the context exposes the banner
  facts only.

## 7. Verification evidence

Focused (root cwd):

```
M1_NETWORK_MODE=hermetic node --require ./scripts/m1-network-guard.cjs \
  --import tsx --test server/tests/m7-impersonation.test.ts \
  server/tests/m7-impersonation-hardening.test.ts
# tests 34 / pass 34 / fail 0
```

Full root:

```
M1_NETWORK_MODE=hermetic node --require ./scripts/m1-network-guard.cjs \
  --import tsx --test server/tests/*.test.ts
# tests 2223 / pass 2223 / fail 0
```

Full server cwd:

```
cd server && M1_NETWORK_MODE=hermetic node --require ../scripts/m1-network-guard.cjs \
  --import tsx --test tests/*.test.ts
# tests 2223 / pass 2223 / fail 0
```

Typecheck:

```
cd server && node node_modules/typescript/bin/tsc --noEmit
# exit 0
```

An earlier full-root run reported 3 failures in `m4-assignment-storage`,
`m7-platform-mfa` and `m8-search`; all three pass when run alone and the full
suite passed on re-run, so they were transient (concurrent sibling edits), not
impersonation regressions.

## 8. Residual risks / gaps

- **R1 — not mounted.** No live request is enforced; the router default export
  exists but `index.ts` is unchanged. Impersonation is not implemented
  end-to-end.
- **R2 — start/revoke audit is not in the same transaction as their write.**
  Start failure leaves a `pending_approval` row (no privilege; approval is
  atomic). Revoke failure leaves the row `revoked` (fail-safe direction).
  Making both atomic needs the same seam extended to insert/revoke and is a
  separate change.
- **R3 — no live MySQL verification.** `FOR UPDATE`, `affectedRows` and
  rollback semantics are exercised through the injected seam, not a real
  InnoDB instance. The table comes from migration `20261018_19`; no new
  migration is needed, and none was executed.
- **R4 — dedicated secret must be provisioned.** Until
  `IMPERSONATION_TOKEN_SECRET` exists in the deployment, every approval
  returns 503 by design.
- **R5 — rate limiting is in-process** (unchanged); a multi-instance
  deployment needs a shared limiter for the start/approve endpoints.
- **R6 — the integration allowlist is a proposal** and needs sign-off before
  the middleware is written.
