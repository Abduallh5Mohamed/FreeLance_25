# Security review: M1 closure (read-only, 2026-10-18)

Scope: new/modified files in `server/src` (routes/branches, public-identity, security/audit, security/branch-access, security/identity-otp, security/resource-branch; modified auth, middleware/auth, staff, courses, student-enrollment, tenant-invitations, admin-*, platform-tenants, files, materials, messages, payment-requests, videos, secure-video, services/socket) and migrations `20261017_02..08`, `20261018_01`. Static review only; no DB/Docker/network; no `.env*` reads. Paths relative to repo root.

## Findings (verified)

### H1. OTP contact verification is reusable for enrollment submission (replay + no expiry/identity binding)
- Files:
  - `server/src/security/identity-otp.ts:212-219` (`assertConsumed`)
  - `server/src/routes/student-enrollment.ts:386-399` (join request submission)
- Detail: `verify()` atomically consumes a challenge, but submission only calls `assertConsumed`, which checks `consumed_at`, `purpose`, `contact_hash`, `tenant_id`. It does not check `expires_at`, does not bind `identity_id`, and never marks the challenge as used for a submission. A consumed challenge can therefore be replayed to create multiple enrollment requests, including after it has expired.
- Fix: make submission a one-time transition. Either consume a second "submitted" flag on the challenge row (atomic `UPDATE ... SET submitted_at=NOW() WHERE id=? AND consumed_at IS NOT NULL AND submitted_at IS NULL`) and require `affectedRows=1`, or store the challenge id on the created request with a unique constraint. Also add `expires_at > now` and `identity_id` checks to `assertConsumed`, and extend `OtpFailureReason` with `identity-mismatch`/`expired`.

### H2. OTP challenges are not bound to `identity_id`
- File: `server/src/security/identity-otp.ts:180-219` (`verify`, `assertConsumed`)
- Detail: `OtpChallengeRow.identity_id` is stored by `issue()` but neither `verify()` nor `assertConsumed()` compares it. The challenge is therefore not actually bound to an account/identity, only to contact+purpose+tenant.
- Fix: add `identityId?: string | null` to `verify()`/`assertConsumed()` inputs and reject with `identity-mismatch` when `(challenge.identity_id ?? null) !== (input.identityId ?? null)`.

### M1. Video session token device binding is bypassable by omitting headers
- File: `server/src/middleware/auth.ts:440-452` (`verifyVideoSessionToken`)
- Detail: fingerprint/screen checks run only when the request supplies the header (`if (fingerprint && ...)`). An attacker who omits `x-video-fingerprint` / `x-screen-resolution` skips those bindings while the token still validates; only IP and UA remain.
- Fix: treat a missing header as a mismatch when the token carries a non-empty `fp`/`sr`, e.g. `if (!fingerprint || decoded.fp !== fingerprint) return invalid`. Require both headers at session creation and reject tokens without them.

### L1. `verifySocketPrincipal` does not pin the JWT algorithm
- File: `server/src/services/socket.ts:33-40`
- Detail: `jwt.verify(token, getJwtSecret())` is called without `{ algorithms: ['HS256'] }`, unlike the REST middleware (`middleware/auth.ts:62`). Exported helper is only used by tests today, but it is a weaker verification path if reused.
- Fix: pass `{ algorithms: ['HS256'] }` (and reject non-string ids/roles as already done).

### L2. OTP HMAC key falls back to the JWT signing secret
- File: `server/src/routes/student-enrollment.ts:317-320` (`getOtpService`)
- Detail: `process.env.OTP_HMAC_SECRET || process.env.JWT_SECRET` reuses the JWT secret to HMAC OTP codes/contact hashes. Key reuse couples two security domains and means rotating the JWT secret invalidates OTP state (and vice versa).
- Fix: require a dedicated `OTP_HMAC_SECRET` (>=32 bytes) and fail closed (503) when it is absent, as already done for delivery.

## Checked and found clean

- Migrations `20261017_02..08` and `20261018_01`: every DDL is guarded by `information_schema` probes; no `DROP`, no `TRUNCATE`, no FK-disable, no data-destroying step; backfills are `WHERE ... IS NULL` / grouped `HAVING` with single-tenant resolution; `branch_audit_log` and `identity_otp_challenges` are `CREATE TABLE IF NOT EXISTS`. Idempotent as authored.
- OTP service: codes are `crypto.randomInt` over a 32-char alphabet at length 8; only HMAC hashes persisted; atomic single-use `consumeChallenge` conditional on `consumed_at IS NULL`; attempt cap checked before comparison; resend cooldown and per-contact throttle enforced; no code returned in HTTP responses (delivery is `null` -> 503).
- `branch-access.ts` / `resource-branch.ts`: authority derived from server rows; malformed/missing/cross-tenant/suspended/revoked/version-mismatch denied; ambiguous legacy rows denied and never widened; DB errors propagate (fail closed).
- `branches.ts`: tenant admin authorization re-checks ownership/platform capability server-side; quarantine classification is guarded by current classification (409 on concurrent change); revocation is status+version, not delete.
- `files.ts`: tenant + exact-participant predicate; realpath containment for storage paths; active content types forced to attachment; `nosniff`.
- `public-identity.ts`: bounded pagination (max 100), UUID-validated teacher id, narrow projections, only published/active rows.
- `auth.ts`/`middleware/auth.ts`: JWT verification pins `HS256`; lifetime capped at 7 days; suspension/token-version liveness enforced per request; no hard-coded secrets in `server/src` (scan found none).
- SQL usage in reviewed files is parameterized; the only string interpolation is validated numeric `LIMIT/OFFSET` and whitelisted column/scope fragments.
- No `.env*` files were read.
