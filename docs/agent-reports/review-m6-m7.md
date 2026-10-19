# Security Review — Milestones M6 & M7

Scope: parent-links, notification-consent, notification-outbox, delivery-channels,
lesson-discussions, feature-flags, audit-log, moderation, platform-mfa, impersonation
(services + routes), their mounts in `server/src/index.ts`, and migrations
20261018_13/14/16/17/18/19.

Method: read-only inspection. Only verified findings are listed. Severity: Critical/High/Medium/Low.

## Findings

### High

**H1 — Cross-tenant lesson-discussion access granted by the bare `admin` role claim**
`server/src/routes/lesson-discussions.ts:853-856` skips tenant equality whenever `principal.role === 'admin'`:
```
if (principal.role !== 'student') {
    if (principal.role !== 'admin') {
        if (!principal.tenantId || principal.tenantId !== lecture.tenant_id) return DENIED_ACCESS;
    }
    ...
```
It then delegates to `resolveResourceBranchAccess` (`server/src/security/resource-branch.ts:202-224`), whose tenant-scope branch returns `allowed` after only proving the resource tenant is non-null — it never compares `principal.tenantId` (by design it defers to the caller's predicate). Because the caller's predicate was deliberately removed for `admin`, a principal whose `users.role = 'admin'` (server-owned via `middleware/auth.ts:138`, but not tenant-bounded) can read/post/reply/delete/report on any *tenant-level* (group-less) lecture discussion in **any** tenant. The mismatch is masked for branch-scoped lectures (`resource-branch.ts:234-238` denies non-platform cross-tenant), so the exposure is tenant-scope lectures.
Fix: delete the `admin` bypass and always require `principal.tenantId === lecture.tenant_id` unless a *verified* platform capability is present (`hasVerifiedPlatformPermission`), and do not use `role` labels for cross-tenant reach.

### Medium

**M1 — Moderation decision allows the reported content's author to judge their own case**
`server/src/routes/moderation.ts:442-444` rejects only the reporter:
```
if (row.reporter_user_id === scope.userId) {
    return res.status(403).json({ error: 'A reviewer cannot decide a case they reported' });
}
```
`moderation_cases.target_author_user_id` is populated at `routes/moderation.ts:336`, and the appeal path already uses it (`routes/moderation.ts:484-485`), but the primary `/decision` (and `/appeal-decision`) path never excludes the target author. A tenant moderator who authored the reported content can therefore `dismiss` or `restore_content` on their own content.
Fix: on `/cases/:id/decision` and `/cases/:id/appeal-decision`, also return 403 when `row.target_author_user_id === scope.userId` (and not `scope.platform`, or exclude platform too if authors can be platform staff).

**M2 — Tamper-evident audit chain is unreliable under same-second and concurrent appends**
`server/src/services/audit-log.ts:108-110` reads the leaf with `ORDER BY created_at DESC, id DESC`, while verification walks `ORDER BY created_at ASC, id ASC` (`audit-log.ts:193-200`). `audit_events.created_at` is `TIMESTAMP ... DEFAULT CURRENT_TIMESTAMP` (second precision) — `server/migrations/20260921_saas_foundation.sql:166` — and `id` is a random UUID. Two sealed rows written in the same second are ordered by UUID, not insertion order, so the row that was actually written second (linking to the first) is walked *before* its predecessor, producing a false `chain-link-mismatch`. Concurrent writers are worse: each reads the same leaf and inserts a new row linking to it, forking the chain (the read is not locked with `FOR UPDATE` and there is no single-writer/serialized sequence). The chain has no persisted head/anchor either, so deleting the newest rows is undetected.
Fix: add a monotonic sequence (e.g. `AUTO_INCREMENT chain_seq BIGINT` or a single-row head table), insert and read the leaf under `SELECT ... FOR UPDATE`/serialized transaction, order both leaf-read and verification by that sequence, and persist an anchored head for tail-truncation detection.

**M3 — Impersonation read-scope is not enforced by the documented helper**
`server/src/services/impersonation.ts:422-430` — `evaluateImpersonationWrite` returns `{ ok: false }` only for `classifyProtectedAction` hits, even when `context.scope === 'read'`; its docstring (`impersonation.ts:418-421`) promises "read scope additionally allows no mutations at all". `requireImpersonationWriteScope` (`impersonation.ts:432`) is the only read-scope gate and is a separate helper an adopter may not call. A read-only session can therefore perform any non-classified mutation through an adopter that uses only `evaluateImpersonationWrite`.
Fix: in `evaluateImpersonationWrite`, block every action when `context.scope === 'read'` (return `{ blocked: true, protection: 'read_only' }` or similar) so the documented guarantee holds regardless of which helper is used.

**M4 — Platform-MFA and impersonation routers are never mounted (controls unreachable)**
`server/src/index.ts:243-245` mounts only `/api/platform/flags`, `/api/audit-logs`, `/api/moderation`. A repo-wide search shows `server/src/routes/impersonation.ts` is imported nowhere and `server/src/routes/platform-mfa.ts` is referenced only by itself. Consequently MFA enroll/verify/disable/step-up (`createMfaVerifier`, `createRequireStepUp`) and the impersonation lifecycle + `createImpersonationVerifier`/`x-impersonation` banner are dead code: platform admins cannot enroll mandatory MFA and impersonation sessions can never be started or enforced. (This is also why M3 is currently latent rather than exploitable.)
Fix: mount both routers behind the `/api` auth/permission guards in `index.ts`, and adopt `createMfaVerifier`/`createImpersonationVerifier` in `middleware/auth.ts` (or explicitly document the deferral and remove the "mandatory"/"enforced" claims).

**M5 — MFA recovery codes are not invalidated on re-enroll/disable**
`server/src/services/platform-mfa.ts:572-578` only INSERTs recovery-code hashes; `disable` (`platform-mfa.ts:603-611`) leaves them in place, and `upsertPendingSecret` (`platform-mfa.ts:523-533`) resets the secret without deleting them. `verifyRecoveryCodeForUser` (`platform-mfa.ts:364-381`) matches by `(user_id, code_hash, used_at IS NULL)`, so a previously issued, unused recovery code remains a valid second factor across disable → re-enroll → re-activate.
Fix: `DELETE FROM platform_mfa_recovery_codes WHERE user_id = ?` on enroll and disable (or store codes with the enrollment `stepup_epoch` and require the epoch to match on consume).

### Low

**L1 — Feature-flag enforcement helper is never called**
`server/src/services/feature-flags.ts:337` defines `isRequiredFeatureEnabled` (deny-by-default), but a repo-wide search finds no callers — only comments in `routes/platform-flags.ts:15` and `feature-flags.ts:334`. Flags can be created/targeted but have no runtime effect, so any surface that assumes it is gated is effectively ungated.
Fix: wire `isRequiredFeatureEnabled` into the gated surfaces (or remove the unused helper and the "enforcement helper" claim).

**L2 — Unsubscribe links are 7-day bearer tokens and are not single-use**
`server/src/services/notification-outbox.ts:394` sets `linkTtlSecondsDefault = 7 * 24 * 3600`; `verifySecureLink` (`notification-outbox.ts:423-453`) checks signature + `exp` only and never consults `jti`; the unauthenticated handler (`server/src/routes/notification-consent.ts:133-191`) replays a `revoke` on every valid token. Anyone who obtains the forwarded email link can repeatedly revoke the user's notifications for a week (denial of notifications).
Fix: shorten the TTL, persist and consume the `jti`, and/or only honor unsubscribe tokens referenced by a recent outbox message.

**L3 — Rate limiters are per-process, in-memory**
`lesson-discussions.ts:115-120` (`createUserRateLimiter`), `platform-mfa.ts:84-88` (`createMfaRateLimiter`) and `impersonation.ts:473-493` (`createImpersonationRateLimiter`) keep fixed windows in a local `Map`. Under multiple instances or a restart the counters are independent/reset, so the limits can be exceeded.
Fix: back the limiters with a shared store (or document the single-instance assumption).

**L4 — Outbox idempotency race surfaces as 500 instead of the duplicate row**
`server/src/services/notification-outbox.ts:168-195` does check-then-insert; the DB unique key `uq_outbox_idempotency` (`server/migrations/20261018_14_notification_outbox_consent.sql:93`) correctly prevents duplicate rows, but a concurrent insert throws `ER_DUP_ENTRY` which is unhandled → 500. No duplicate delivery occurs, but the caller sees a spurious failure and callers that retry amplify load.
Fix: catch `ER_DUP_ENTRY` and re-select the existing row (return `{ duplicate: true }`).

## Checked and clean

- `server/src/routes/parent-links.ts` + `services/parent-links.ts`: parent-view secret uses no hardcoded fallback and fails closed (503); OTP is single-use via the shared identity-OTP challenge (`consumeChallenge`/`consumeSubmission` conditional updates); revocation is checked against live link status; revoke authz is owner/student/active-staff with 404 for everyone else.
- `server/src/routes/parent-views.ts`: authenticates solely with its own scoped HMAC token (`createParentViewVerifier`), re-verifies the live link + token expiry/revocation per request, and every query is scoped by the token's `tenantId` + `studentEnrollmentId` (read-only, single child). Mounting `/api/parent` before `optionalAuth`/`enforceTenantAuthorityBoundary` (`server/src/index.ts:162`) is safe here because the router consumes no request-supplied tenant/selector and does not rely on `req.user`.
- `server/src/routes/notification-consent.ts` + `services/notification-consent.ts`: the principal namespace/role is server-derived, every authenticated statement is bound to `(user_id, user_type)` from the token, owner writes force `source = account_settings`, and the one unauthenticated surface (signed unsubscribe) verifies against a dedicated secret that fails closed.
- `server/src/routes/audit-logs.ts`: verified platform reader vs active tenant-owner scope; a tenant owner's filter is pinned to the server-derived tenant (`audit-logs.ts:80-84`); chain verification is platform-only; CSV export neutralizes formula injection and is itself audited; no UPDATE/DELETE against `audit_events`.
- `server/src/routes/platform-flags.ts`: every path sits behind verified platform permission guards (`platform_flags.read` / `platform_flags.manage`) resolved from server rows (`requireAdminPermission`), never a JWT role claim.
- `server/src/routes/moderation.ts` scope resolution (`moderation.ts:145-168`) and `security/admin-permissions.ts`: platform/tenant authority comes only from server-owned rows (`admin_user_roles`/`admin_role_permissions`, `tenants.owner_user_id`, `tenant_memberships`), deny-by-default, with lookups failing closed (503).
- Migrations `20261018_13/14/16/17/18/19`: authoring-only and idempotent (`INFORMATION_SCHEMA` probes + `PREPARE`/`EXECUTE`), no DROP/TRUNCATE/row rewrite; the constraints backing idempotency/dedup exist (outbox `uq_outbox_idempotency`, `parent_links` unique link, discussion report/block uniques, moderation `report_id`/`revision_no`/`case_id` uniques).
