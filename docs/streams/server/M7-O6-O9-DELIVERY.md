# M7 O6 + O9 delivery — platform MFA (TOTP) and impersonation sessions

Batch: `m7-server-super-admin-20261018-19` — 2026-10-19.
Backlog rows: **O9** (platform MFA, mandatory for super-admin/staff sensitive roles, recovery + step-up) and **O6** (impersonation: reason + second-admin approval, 30-minute bound, visible banner, read/write scope, per-action audit, protected actions blocked, tenant-owner notification). Both depend on S2/S3; authorization is always a VERIFIED platform permission, never a JWT role claim.

## Files

| File | Role |
| --- | --- |
| `server/src/services/platform-mfa.ts` | RFC 6238 TOTP (node:crypto only), AES-256-GCM secret sealing, recovery codes, step-up tokens, `createMfaVerifier`, `createRequireStepUp`, SQL store, rate limiter |
| `server/src/routes/platform-mfa.ts` | `/api/platform-mfa/*` factory + production default wiring |
| `server/src/services/impersonation.ts` | Session lifecycle, issued-context token + verifier seam, protected-action policy, notification hook, SQL store |
| `server/src/routes/impersonation.ts` | `/api/impersonation/*` factory + production default wiring |
| `server/migrations/20261018_19_platform_mfa_impersonation.sql` | Idempotent schema draft (INFORMATION_SCHEMA guards + PREPARE/EXECUTE), authoring-only |
| `server/bootstrap/m1/manifest.json` | Hash-anchored `20261018_19_platform_mfa_impersonation.sql` + unresolved note (re-read before edit; `_18` from a parallel batch untouched) |
| `server/tests/m7-platform-mfa.test.ts`, `server/tests/m7-impersonation.test.ts` | Hermetic tests: 20 + 21 |

## O9 — Platform MFA

- **TOTP core**: RFC 4226/6238 with SHA-1 HMAC, 30 s steps, RFC 4226 test vectors asserted (`755224…520489`), 6 digits, `±1` window, `crypto.timingSafeEqual` comparison, **replay protection of used time-steps**: after a match the step is persisted through a monotonic conditional update (`last_used_step < step`, `affectedRows=0` ⇒ `replayed`), so an equal-or-older step can never verify twice, even racing.
- **Secret storage**: 20 random bytes, shown base32; stored **AES-256-GCM sealed** (`v1.iv.tag.cipher`) with a key from `MFA_SECRET_KEY` (≥ 32 bytes; hex/base64/raw accepted). Missing/short key ⇒ **fail closed 503** for enroll/verify/step-up; status stays readable and leaks no secret material. The route factory also accepts an **injected sealed value** (`deps.sealKey`), which is what hermetic tests use.
- **Recovery codes**: generated once at activation (10 codes), returned **in plaintext exactly once** in the activate response, stored only as SHA-256 hashes; consumption is a conditional single-use flip (`used_at IS NULL`), second use denied.
- **Step-up**: success issues `su1.<userId>.<epoch>.<issuedAt>.<mac>` (HMAC-SHA256 over the seal key, constant-time MAC check). `createRequireStepUp(deps)(maxAgeSeconds)` is the guard for sensitive routes; the epoch is re-read live from the row so a disable (epoch bump) instantly invalidates outstanding tokens. Default accepted age 600 s.
- **Endpoints** (all `authenticateToken` + verified platform permission; `platform_mfa.manage` for mutations, `platform_mfa.read` for status):
  - `GET /status` — enrolled/locked state only.
  - `POST /enroll` — new pending secret sealed; 409 when already active; requires `reason` (audited).
  - `POST /verify` — TOTP or single-use recovery code; pending ⇒ activation `platform_mfa.activated` + recovery codes; active ⇒ `platform_mfa.verified`; issues `step_up_token`; failure ⇒ persisted counter lockout (**5 bad codes ⇒ 15-min lock**, survives restarts) plus per-user fixed-window rate limits (enroll 3/15 min, verify 8/5 min, disable 5/15 min, clock injectable).
  - `POST /disable` — requires manage permission **and a fresh step-up token**, requires `reason`, bumps epoch, audited.
- **Every mutation audited** through the injected sealed-audit writer (hash chain) inside an injectable transaction seam; audit failure aborts the mutation (500).
- `MfaKeyUnavailableError`/key checks never throw to the client; surfaces answer 503.

### Integration points (documented; `auth.ts`/`middleware/auth.ts` NOT touched)

- Verifier seam for middleware adoption: `createMfaVerifier({ store, sealKey, now })` exposes `verifyCode`/`verifyRecoveryCode`/`issueStepUpToken`. After `authenticateToken` (and the platform-permission guard), middleware can require `verifyCode(...).ok` to make platform MFA mandatory for super-admin/staff sensitive roles; `createRequireStepUp(...)(seconds)` wraps any sensitive route today. SQL stores come from `createSqlPlatformMfaStore(db)`; production wiring for both sits at the bottom of the route files.

## O6 — Impersonation

- **Start**: `POST /api/impersonation/start` (`impersonation.start` + per-actor limiter 5/10 min). Body: target user + tenant, **mandatory `reason` (≥ 16 chars, audited verbatim)**, explicit `scope` (`read` default, `write` only when requested), `duration_seconds` clamped to **≤ 1800 (30 min)** and validated (integer 1..1800). The target is resolved **server-side only**: unknown/not-a-member ⇒ 404 (no tenant-membership enumeration), target platform admin ⇒ 403, self-impersonation ⇒ 400, another active/pending session for the same target ⇒ 409. Creates `pending_approval`; audited `impersonation.session_requested`.
- **Approve**: `POST /:id/approve` (`impersonation.approve`, limiter 10/10 min). **Only a second, different admin** (self-approval denied 403); conditional `pending_approval → active` transition with the new expiry (races/late approvals ⇒ 409). Issues the **context token** `imp1.<sessionId>.<actor>.<target>.<tenant>.<w0|w1>.<issuedAt>.<mac>` carrying the **banner facts** (`banner: { impersonated: true, sessionId, tenantId, scope }`); audits `impersonation.session_approved`; fires the injected tenant-owner notification (`session_started`, ids/scope/expiry only) — a failing hook never fails the request.
- **Live verification (immediate revoke)**: `createImpersonationVerifier({ store, tokenKey, now })(token)` re-checks signature, then the **LIVE session row** — status `active`, not expired, actor/target/tenant consistent — on every call. `transitionToRevoked` (starter, approver, or `impersonation.manage` holder via `POST /:id/revoke`) takes effect on the next request; duplicates ⇒ 409. Audited `impersonation.session_revoked` + `session_ended` notification.
- **Read-only by default with explicit write scope**: `requireImpersonationWriteScope(context)` denies mutations under `read` scope; `write` must have been explicitly requested at start and approved.
- **Protected actions blocked while impersonating**: `classifyProtectedAction(action)` + `evaluateImpersonationWrite(context, action)` — blocks `password_change` (password/passwd), `mfa_change` (mfa/totp/2fa/recovery/step-up), `money_movement` (wallet/withdraw/payout/refund/topup/invoice/billing) and `data_delete` (delete/destroy/purge/hard-delete) **even with write scope**. Adopters call the helpers before their own handlers; the impersonation routes themselves additionally refuse any valid impersonated context (no chaining, 403).
- **Auditing every action under a session**: adopters pass the context through; audit rows use `resourceType 'impersonation_session'`, `resourceId = sessionId` and the reason, so every action under a session is traceable (`evaluateImpersonationWrite` denials are also auditable events).
- **Listing**: `GET /sessions` (`impersonation.read`) returns only sessions the caller started/approved (store-filtered, bounded 50).

### Integration point (documented; `middleware/auth.ts` NOT edited)

Adopters wire `createImpersonationVerifier({ store: createSqlImpersonationStore(db), tokenKey, now })` against the `x-impersonation` header after authentication, then enforce `requireImpersonationWriteScope(context)` and `evaluateImpersonationWrite(context, action)`. The verifier resolves against the live row, so revocation/expiry applies immediately without any middleware change; `resolveProductionTargetUser` and `hasVerifiedPlatformPermission('impersonation.manage')` are exported production seams.

## Migration (idempotent, never executed)

`20261018_19_platform_mfa_impersonation.sql`: `platform_mfa_secrets` (sealed secret, replayed `last_used_step`, failed-attempt lockout `locked_until`, `stepup_epoch`, FK users), `platform_mfa_recovery_codes` (hash, single-use `used_at`, unique per user+hash), `impersonation_sessions` (status enum `pending_approval/active/revoked/expired`, enum scope, hard 30-min expiry, FKs to users/tenants, target/tenant/started indexes). Every statement guarded by `INFORMATION_SCHEMA` probes + `PREPARE/EXECUTE`; registered in `server/bootstrap/m1/manifest.json` (`sourceSha256` + unresolved draft note) — hash-anchored as a reviewed draft only; **no SQL was executed**, and deploying source before an approved isolated bootstrap/live validation is out of scope.

## Verification

- `node node_modules/tsx/dist/cli.mjs --test server/tests/m7-platform-mfa.test.ts` → 20/20 pass.
- `node node_modules/tsx/dist/cli.mjs --test server/tests/m7-impersonation.test.ts` → 21/21 pass.
- Full suite `node node_modules/tsx/dist/cli.mjs --test server/tests/*.test.ts` → **2052 tests / 2052 pass / 0 fail**, run twice (identical result), with the concurrent `_18` moderation batch still green.
- `node node_modules/typescript/bin/tsc --noEmit -p server/tsconfig.json` → clean.
- Coverage per handler: anonymous 401 (zero storage access), non-platform 403, cross-identity/cross-tenant denials (foreign step-up token, unrelated revoker, non-owned session listing, unknown/cross-tenant target 404), input validation 400s, per-user rate limits 429, lockout 429, single-use replay 400/409, step-up requirement 403, failing audit ⇒ 500 with no successful response, notification-hook resilience, and the pure TOTP/seal/step-up/protected-action cores with RFC 4226 vectors.
