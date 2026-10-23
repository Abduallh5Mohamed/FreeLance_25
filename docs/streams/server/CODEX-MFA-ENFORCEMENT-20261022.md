# Codex sensitive-action MFA component — 2026-10-22

## Delivered scope

- New source only: `server/src/security/sensitive-action-mfa.ts`.
- No existing auth, index, route, permission, MFA crypto, database or schema source changed.
- No tests added or run, no typecheck run, no database/service/network/Git operation. This is an unvalidated source delivery requiring review and regression verification before mounting.

The existing service exposes `verifyStepUpToken`, which verifies the HMAC, user, session, purpose, issuance age and current enrollment epoch. The new guard reuses it rather than implementing cryptography. It also requires a current active enrollment row, an explicit server-owned platform capability, and an injected live identity/session check. Neither the JWT role label nor branch membership grants access. Default SQL capability functions remain available for later wiring, but this component requires the lookup dependency explicitly.

Construction rejects missing capability/store/liveness/key/clock dependencies, empty capability and an invalid verification window. The accepted window may tighten the existing service default of600 seconds; it cannot extend it. The key and clock are checked at request time so missing runtime material fails503. All responses are no-store. Missing identity is401; missing/inconsistent verified session is403; revoked identity/session is401; denied capability, inactive enrollment or invalid token is403; failed authority lookup, malformed enrollment epoch, mismatched row identity or unavailable key is503. Upstream errors and credential material are not logged.

The guard does not mutate domain state, issue tokens, implement MFA enrollment/recovery or replace resource authorization. Successful step-up is valid only at the point checked. An action that needs authority to remain valid through a write still requires a transaction-bound recheck/guard at the mutation boundary; this middleware alone does not eliminate revocation races.

## Integration matrix — source-supported requirements, not newly selected policy

| Surface | Existing reference | Next integration requirement |
|---|---|---|
| Platform sensitive roles | docs17 O9: mandatory MFA for super-admin/staff sensitive roles | Maintainer must inventory exact routes/capabilities and apply the guard per sensitive action; no broad namespace or role-claim shortcut |
| Payout destination changes | docs19: destination authority and step-up on change | Mount only when that route and its existing capability/identity model are implemented; financial execution remains outside this component |
| MFA enrollment/verify/recovery/status | Existing routes/platform-mfa.ts | Keep authentication/capability/rate-limit policy; do not wrap enrollment or recovery in a prerequisite active-enrollment guard |
| MFA disable | Existing route already uses createRequireStepUp | Preserve existing behavior; replacement is not performed here |
| Impersonated request | AuthRequest distinguishes actor and effective principal | Do not mount this platform action guard after principal rewriting without an explicit actor/session contract; no actor is guessed from a header |
| Legacy token without session identity | Existing step-up helper can bind an empty session | This stricter component denies an empty session; deployment must confirm/migrate authoritative session-bound tokens, not relax to empty IDs |

## Required checks before acceptance

1. Authenticator and live identity/session adapter establish a nonempty session and exact owner; revoked/inactive/mismatched cases deny. No constant-true liveness fallback.
2. Real capability resolver denies tenant admin/JWT-only role and permits only explicit server capability or verified active super-admin.
3. Active/pending/disabled/missing enrollment, invalid epoch, stale epoch, wrong user/session/purpose/signature, future/expired token, short/missing key, failed store and invalid configuration cases.
4. Downstream resource authorization stays enforced; exactly one continuation on success; no continuation on any denial; no secret/token/upstream exception in response or logs.
5. Enrollment/recovery paths remain usable; action-specific transaction rechecks close the business write boundary where required.

## Status

**Unmounted. Not proof that O9 is complete.** Exact sensitive-route policy, session adapter, actor/principal integration, typecheck and tests remain for supervisor-controlled follow-up. No claim of production enforcement, live SQL correctness or full platform-MFA acceptance is made.
