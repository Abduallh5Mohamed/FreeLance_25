# Impersonation server integration — O6 (2026-10-19)

Task: `server-impersonation-integration-20261019-01` (team `security`, batch
`server-completion-wave2-20261019`).
workerId `wb-impersonation-integration-w2-20261019-01`.
Branch: `codex/workbuddy-server`.

Scope: complete the O6 server integration left open by
`docs/streams/server/IMPERSONATION-HARDENING-20261019.md` (R1) and
`docs/streams/server/IMPERSONATION-AUDIT-FOLLOWUP-20261019.md` (R2, already
fixed — NOT reopened here):

1. serialize concurrent duplicate starts on an existing stable verified row,
2. preserve the mutation + sealed-audit atomicity of start/approve/revoke,
3. enforce the `x-impersonation` context through the actual common auth flow,
4. preserve the actor vs effective-principal distinction,
5. keep the initial integration read-only under a context,
6. leave ordinary non-impersonated requests unchanged,
7. mount management only after executable allow/deny tests passed.

The normative contract is `docs/contracts/IMPERSONATION-INTEGRATION.md`.

## Files (all inside allowedPaths)

| File | Purpose |
| --- | --- |
| `server/src/services/impersonation.ts` | `ImpersonationStore.lockTargetUser` (`SELECT id FROM users WHERE id = ? LIMIT 1 FOR UPDATE`); `start` takes that lock BEFORE counting inside the same transaction; new fail-closed deny reason `target_not_lockable`; header docs. |
| `server/src/middleware/impersonation-context.ts` | new: request-context enforcement (verifier + principal binding + management-namespace deny + read allowlist + mutation gate), `enforceImpersonationContext`, `enforceImpersonationAction`, `evaluateImpersonationRequest`. |
| `server/src/middleware/auth.ts` | `AuthRequest.impersonation?: ImpersonationContext` (banner facts; additive only). |
| `server/src/routes/impersonation.ts` | exported `productionImpersonationTokenKey` + `createProductionImpersonationVerifier` (dedicated secret only) reused by the middleware; header doc updated. |
| `server/src/index.ts` | mounts `enforceImpersonationContext` right after the shared `/api` guard chain and `/api/platform/impersonation` management. |
| `server/tests/m7-impersonation.test.ts` | fixture implements `lockTargetUser`. |
| `server/tests/m7-impersonation-hardening.test.ts` | fixture implements `lockTargetUser` (its runner already serializes). |
| `server/tests/m7-impersonation-integration.test.ts` | new: 4 concurrency tests + 14 enforcement tests. |
| `docs/contracts/IMPERSONATION-INTEGRATION.md` | new contract (supersedes hardening 6 as a proposal). |
| `docs/streams/server/IMPERSONATION-INTEGRATION-20261019.md` | this record. |

## 1. Concurrent duplicate starts — defect reproduced before the fix

Before the change, `start` ran `countActiveForTargetUser` -> `insertSession`
inside one transaction. Two transactions can both count zero and both insert.
Reproduced with TWO SEPARATE transaction runners interleaved on a shared
table (fixture: per-target users-row lock queue, count barrier releasing
simultaneously in-flight counts, snapshot-restore rollback — no global mutex).
Failing output before the fix:

- `two simultaneous starts for one target open exactly one session (locked
  target row serializes them)` — `['ok','ok']` instead of
  `['ok','target_active_session']`; two session rows, two audits;
  `maxInFlight` 2 !== 1 (no serialization existed).
- `a start for a target whose verified row disappeared fails closed inside
  the transaction` — service returned `ok` and inserted a ghost-target row.

The control `starts for different targets are NOT serialized by the
target-row lock` passed both before and after (maxInFlight 2, both succeed),
proving the fix is a per-target row lock, not a global mutex.

## 2. The fix

`start` now locks the stable verified target row FIRST, on the same
connection/transaction, then counts (which includes `pending_approval` and
`active`), then inserts + audits atomically (unchanged R2 seam). A target row
that cannot be locked (deleted between route resolution and the transaction)
returns `target_not_lockable` and the route fails closed with 500; nothing is
written. No new schema, no partial-index proposal; approve/revoke atomicity
and their guarded `affectedRows` transitions are untouched and still green.

## 3. Request-context enforcement

`enforceImpersonationContext` mounts in `server/src/index.ts` immediately
after the shared `/api` guard chain (path-less `app.use`, so every `/api`
surface is covered with exactly the contract request order and the existing
mounting-contract assertions stay valid). It verifies the header against the
LIVE session row, binds the bearer to the session's target user and tenant,
denies the management namespace, attaches `req.impersonation` only after every
check passes, and then applies the read-only allowlist (see contract).

Management mounting (`/api/platform/impersonation`) was added ONLY after the
executable allow/deny tests passed. `/api/parent` stays before the guard by
design (opaque tokens) and is documented in the contract.

## 4. Tests (server/tests/m7-impersonation-integration.test.ts, new)

Concurrency:

| Test | Covers |
| --- | --- |
| `two simultaneous starts for one target open exactly one session` | two independent interleaved transactions: exactly one row/audit; maxInFlight === 1 |
| `starts for different targets are NOT serialized by the target-row lock` | control: no global mutex; maxInFlight === 2 |
| `a start for a target whose verified row disappeared fails closed` | `target_not_lockable`; nothing written |
| `an existing live session (active or pending) still blocks a later start after the lock` | pending/active eligible states included |

Enforcement (real Express router chain mirroring index.ts order: optionalAuth
-> enforcement -> business routers):

| Test | Covers |
| --- | --- |
| `...without authentication is denied 401, not downgraded` | anonymous |
| `a forged actor (wrong signing key)...` | signature deny before row read (no existence leak) |
| `a valid context replayed by another principal or tenant is denied` | cross-tenant: `target_mismatch` + `tenant_mismatch` |
| `the support actor cannot ride their own context token` | bearer must be the target |
| `a revoked session stops working on the very next request` | live re-read |
| `an expired or unapproved session can never serve a request` | expiry + pending_approval |
| `a read context cannot mutate...` | `data_delete`/`password_change`/`read_only`/`mutation_not_enabled` |
| `protected GET surfaces are always denied...` | `/api/audit-logs`, `/api/auth/me`, `/api/files/**`, unlisted read |
| `a valid read context serves allowlisted reads...` | positive + actor vs target distinction; bearer stays the target |
| `ordinary non-impersonated requests are unchanged` | with/without bearer; malformed header refused |
| `a verified context can never manage impersonation sessions` | management namespace; handler never reached |
| `route-adopted action ids gate their own mutations...` | `enforceImpersonationAction` opt-in helper |
| `the pure evaluation mirrors the middleware matrix and the prefix boundary` | `evaluateImpersonationRequest` + segment boundary |
| `the default action id derives from method and path...` | DELETE classification |

## 5. Verification evidence

Focused (root cwd, guarded hermetic):

```
M1_NETWORK_MODE=hermetic node --require ./scripts/m1-network-guard.cjs \
  --import tsx --test server/tests/m7-impersonation.test.ts \
  server/tests/m7-impersonation-hardening.test.ts \
  server/tests/m7-impersonation-integration.test.ts
# tests 58 / pass 58 / fail 0     (before this change: 40, with the two new
#                                  concurrency failures reproduced above)
```

Typecheck:

```
cd server && node node_modules/typescript/bin/tsc --noEmit
# exit 0
```

Mounting-contract tests after the index.ts mount (regression guard):

```
m8-stabilization-mounting, m2-m3-mounting, m1-security-index-config,
p0-checklist, teacher-school-product-alignment
# tests 33 / pass 33 / fail 0
```

Full hermetic suites (both cwds) are recorded in the task report; they are
extra evidence only — the authoritative combined run happens in the
coordinator turn after all writers stop.

## 6. Residuals (not faked)

1. **Write scope is mounted read-only.** No business route declares a stable
   action id yet, so every mutation under a context is denied
   (`IMPERSONATION_SCOPE mutation_not_enabled`). Per-route opt-in is future
   work; the allowlist mechanism (deny by default, prefix list) is what this
   change delivers.
2. **UI banner / customer disclosure** is a human-frontend dependency; the
   server exposes only `req.impersonation` banner facts.
3. **`/api/parent`** (mounted before the shared guard for opaque-token auth)
   is outside context enforcement; it serves only the bearer's own children.
4. **No live MySQL verification** of `FOR UPDATE` / `affectedRows`; hermetic
   seam only, no SQL executed, no migration authored.
5. **Rate limiting remains in-process** (hardening R5).
6. **`IMPERSONATION_TOKEN_SECRET` must be provisioned**; until then approvals
   fail closed with 503 and presented contexts deny (fail closed by design).

---

# Supervisor correction (2026-10-20) — `server-impersonation-integration-correction-20261020-01`

Worker `wb-impersonation-correction-20261020-01` (team security). Same approved
scope; no feature added, no operations. Two defects found in the supervisor's
source review of the wave2 integration were corrected. The R2 audit atomicity,
the target-row serialization of concurrent starts, and all prior hardening
were preserved untouched.

## Defect 1 — the enforcement was mounted AFTER six business routers

`index.ts` mounted `parent-links`, `notification-consent`,
`lesson-discussions`, `search`, `tenant-exports` and `platform/mfa` BEFORE
`app.use(enforceImpersonationContext)` despite its "immediately after the
guard chain" comment: a presented `x-impersonation` header reached those
handlers without ever being verified.

Fix: the enforcement now mounts immediately after the shared `/api` guard
chain and before EVERY business router, and the opaque-token parent path
(`/api/parent`, mounted before the guard by design) explicitly REFUSES a
presented header via the new `rejectImpersonationHeader` middleware
(403 `IMPERSONATION_DENIED parent_path`) instead of silently bypassing it.

Evidence: static order assertions on the real `index.ts` plus an assembled
chain (in the extracted production order) driven end-to-end — a forged
context and a wrong-actor context on each of the six previously-earlier
routes returns 403 with the handler never entered; ordinary requests on every
surface still return 200; the parent path refuses the header.

## Defect 2 — the request binding required the TARGET's credentials

`matchImpersonationPrincipal` required the authenticated bearer to be the
session TARGET (`target_mismatch` otherwise), i.e. the integration demanded
the target's own login — the opposite of support impersonation.

Fix: the bearer must now be the session's support ACTOR (`started_by`); the
target's own credentials are a stolen context (`actor_mismatch`), a different
support actor cannot ride someone else's context, and an actor whose live
tenant scope differs from the session tenant is refused (`tenant_mismatch`).
Once the actor binding passes, the effective TARGET principal is resolved
SERVER-SIDE (`resolveImpersonationTargetPrincipal`, `middleware/auth.ts`,
reusing the production `resolvePrincipal` path): the live users row decides
role/liveness, live membership rows decide scope, and the verified session
row's tenant is the only selector. No target JWT is minted, no header role is
trusted, no membership check is skipped. `req.user` then IS the target (so
every downstream router and re-check authorizes exactly the target's own
scopes) and the actor is preserved in `req.impersonation`. A service-level
`self_target` guard refuses a start against the actor's own user (the route
already denied it with 400).

## Verification

- Focused (root cwd):
  `M1_NETWORK_MODE=hermetic node --require ./scripts/m1-network-guard.cjs --import tsx --test server/tests/m7-impersonation.test.ts server/tests/m7-impersonation-hardening.test.ts server/tests/m7-impersonation-integration.test.ts`
  → **69 tests, 69 pass, 0 fail** (baseline 58; +11 tests).
- Typecheck: `cd server && node node_modules/typescript/bin/tsc --noEmit` → exit 0.
- No DB/SQL execution, network, Docker, provider, secrets/env, dependency or
  git-write operations.

## Residuals / questions for Codex

1. Write scope remains read-only (no business route declares a stable action
   id yet); opting routes in touches files outside this task's allowedPaths.
2. No live MySQL verification of the actor binding / effective-principal
   resolution (hermetic seam only).
3. The effective-principal resolution re-reads the identity/membership rows
   per impersonated request (same cost profile as a direct request); a
   per-session cache was deliberately NOT added (liveness must be fresh).
4. `IMPERSONATION_TOKEN_SECRET` provisioning remains a deployment
   prerequisite (fail closed until then).

---

# Correction record — live actor permission recheck (2026-10-20)

Task: `server-impersonation-live-actor-permission-20261020-01`
(workerId `wb-impersonation-live-actor-permission-20261020-01`; same approved
scope as the corrections above; prior corrections preserved, not redone).

## Defect 3 — a context outlived the actor's platform permission

`enforceImpersonationContext` verified the token (signature, expiry, live
session row) and resolved the effective target principal, but never re-checked
the ACTOR's platform permission. Reproduced scenario: remove the starter
actor's verified `impersonation.start` permission while the actor's users row
stays active, the token version unchanged and the session row active — the
context kept working. An ordinary authenticated user (or a user whose platform
membership was removed) retained full support context merely because their
identity/session was live.

Fix: an injectable `checkActorPermission(actorUserId)` seam runs on EVERY
request that presents a context, immediately after the actor binding and
before the management-namespace and effective-principal checks:

- the actor must STILL hold the approved platform permission key
  `impersonation.start` (`IMPERSONATION_ACTOR_PERMISSION_KEY`) — never a raw
  role. A server-verified active super_admin satisfies the key exactly like
  the management start guard (`hasVerifiedPlatformPermission`, same rule);
- a false verdict denies `actor_permission_revoked`; an absent seam or a
  rejecting store (lookup failure) denies `actor_permission_unavailable`
  (fail closed, no session-existence leak);
- production `enforceImpersonationContext` binds the seam to
  `hasVerifiedPlatformPermission('impersonation.start', actorUserId)`, so the
  recheck reads the same server rows the start guard reads;
- ordinary (headerless) requests never consult the seam.

## Defect 4 — the verifier ignored the signed scope against the live row

`createImpersonationVerifier` compared actor/target/tenant between the signed
context and the live row but NOT the scope, although the documented contract
(and the module header) claim scope consistency: a write-flagged context over
a read row (or the reverse) verified, letting `evaluateImpersonationWrite`
gate a scope the live row no longer backs. Fix: the live row's scope must
equal the signed scope flag, else `row_mismatch`. The live row's `expires_at`
remains the only expiry authority (the signed field records the issue time);
verified consistent, deliberately not re-interpreted (no policy expansion).

## Verification

- Focused (server cwd):
  `M1_NETWORK_MODE=hermetic node --require ../scripts/m1-network-guard.cjs --import tsx --test tests/m7-impersonation.test.ts tests/m7-impersonation-hardening.test.ts tests/m7-impersonation-integration.test.ts`
  → **75 tests, 75 pass, 0 fail** (three-file baseline was 69; +6 tests:
  per-request recheck + revocation next-request deny with untouched business
  handler + re-read proof, store-failure deny, signed-scope-vs-row mismatch
  (both directions + positive control), ordinary requests never consult the
  seam, and the assembled production chain refusing a valid-but-revoked
  context on every earlier route).
- Full hermetic suite after all writes stopped (root cwd and server cwd) and
  `tsc --noEmit`: see the submitted task report.
- Scope: writes only inside allowedPaths (`server/src/services/impersonation.ts`,
  `server/src/middleware/impersonation-context.ts`,
  `server/tests/m7-impersonation-hardening.test.ts`,
  `server/tests/m7-impersonation-integration.test.ts`,
  `docs/contracts/IMPERSONATION-INTEGRATION.md`,
  `docs/streams/server/IMPERSONATION-INTEGRATION-20261019.md`).
- No DB/SQL execution, network, Docker, provider, secrets/env, dependency or
  git-write operations.

## Residuals / questions for Codex

1. No live MySQL verification of the permission-row lookup (hermetic seam
   only); the production lookup is `hasVerifiedPlatformPermission` over
   `admin_user_roles` / `admin_role_permissions` / `users.is_active`.
2. The recheck adds one indexed permission lookup per impersonated request
   (by design: liveness must be fresh; no caching introduced).
3. `impersonation.start` was chosen as the rechecked key because it is the key
   the actor held when the session was opened (source-proven); any split
   (e.g. a dedicated serve-time key) would be a product/policy decision —
   not taken here.
4. `IMPERSONATION_TOKEN_SECRET` provisioning remains a deployment
   prerequisite (fail closed until then).
