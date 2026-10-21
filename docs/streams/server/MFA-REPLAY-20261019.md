# Platform MFA — replay & concurrency hardening (recovery record)

Task: `server-mfa-replay-hardening-recovery-20261019-01` (recovery of
`server-mfa-replay-hardening-20261019-01`, original worker terminated by a 429
mid-run; this record documents the verified end state of the code).

Scope: `server/src/services/platform-mfa.ts`,
`server/src/routes/platform-mfa.ts`, `server/tests/m7-platform-mfa.test.ts`.
No other files were touched. `middleware/auth.ts`, `index.ts` and shared
helpers are intentionally untouched (see residual limits).

## What the code actually does (verified by reading the source)

All statements below were re-verified against the current source before
writing this document; the focused suite (`server/tests/m7-platform-mfa.test.ts`,
34 tests) passes hermetically (`M1_NETWORK_MODE=hermetic`, network guard active).

### 1. TOTP step replay protection (concurrency-safe)

- `verifyTotpForUser` (service) reads the row, computes the RFC 6238 code over
  the ±1-step window, and rejects any step `<= last_used_step`
  (`verifyTotpReplayChecked`) before any state changes.
- The winning step is then consumed by the store's conditional update
  `markStepUsed`:
  `UPDATE ... SET last_used_step = ? WHERE user_id = ? AND status IN
  ('active','pending') AND stepup_epoch = ? AND last_used_step < ?`.
  The `last_used_step < ?` predicate makes the consumption itself atomic in
  SQL: two simultaneous requests presenting the same code race on one row and
  exactly one `UPDATE` affects a row. The loser gets 0 affected rows and is
  answered `400 MFA_CODE_INVALID` (reason `replayed`, or `stale_enrollment`
  when the epoch moved underneath it).
- Code comparison uses a constant-time scan (`codesEqual`), never early-exit
  string equality.

### 2. Recovery-code consumption (single use under races)

- Recovery codes are 20 random bytes (hex), stored only as SHA-256 hashes and
  returned in plaintext exactly once, at activation.
- `consumeRecoveryCode` flips `used_at` with a conditional update
  (`... WHERE user_id = ? AND code_hash = ? AND used_at IS NULL`), so two
  simultaneous requests with the same code race on one row and exactly one
  succeeds; the loser is answered 400.

### 3. Enrollment key sealing

- The TOTP secret is 20 random bytes shown base32 once; the stored copy is
  AES-256-GCM sealed (`sealValue`, versioned `v1.iv.tag.ciphertext` envelope).
  Opening with a wrong key or a tampered envelope throws (GCM tag), and the
  route surfaces that as a denial, never as a fallback to plaintext.
- The sealing key comes only from `MFA_SECRET_KEY` (hex/base64/raw, must decode
  to >= 32 bytes — `MIN_MFA_SECRET_KEY_BYTES`). There is **no** JWT-secret
  fallback anywhere in the module; a missing/short key fails closed with 503 on
  every surface that needs secret material (enroll, verify, disable via
  step-up), while a pure status read still works.

### 4. Disable / re-enroll invalidation

- `disable` sets `status='disabled'`, clears the sealed secret, resets
  `last_used_step`, bumps `stepup_epoch` (killing every outstanding step-up
  token, which is epoch-bound), and deletes all stored recovery codes —
  only when a row was actually affected.
- `upsertPendingSecret` takes a row lock (`SELECT ... FOR UPDATE`) first and
  returns 0 (no write) when the row is already `active`, so a concurrent enroll
  can never rotate a live enrollment. A re-enroll also purges every previously
  issued recovery code before the new pending secret lands, so old codes can
  never survive as a second factor across disable → re-enroll → re-activate.
- `activate` is a conditional `UPDATE ... WHERE status='pending' AND
  stepup_epoch = ?`; only the request that wins pending → active discloses a
  recovery-code batch (a concurrent valid verify of another step succeeds but
  discloses nothing).
- `verifyTotpForUser` binds step consumption to the enrollment epoch observed
  at read time; a secret swapped between read and update yields 0 affected
  rows and the verification fails (`stale_enrollment`) — a replaced pending
  secret can never be activated by a code verified against the old one.

### 5. Lockout persisted, fail-closed

- Bad codes/replays increment `failed_attempts` in the row itself
  (`recordFailure`); at `MAX_VERIFY_ATTEMPTS` (5) the row gets
  `locked_until = now + LOCKOUT_SECONDS` (900 s). Because the counter and the
  lockout live in the row, both survive restarts and are enforced by every
  router instance (`lockoutOf`), not just the process that saw the failures.
- A locked row denies even a correct code (429 `MFA_LOCKED`) and no step is
  consumed. A successful verification clears the counter.

### 6. Audit rollback

- Every mutation (enroll / verify / disable) runs its store writes and its
  sealed audit entry through `runAtomic`: an injected transaction seam wins;
  otherwise a router owning the SQL store uses `db.transaction`
  (`withTransaction` in production wiring) so the mutation and the audit entry
  commit or roll back together. A failed audit therefore aborts the mutation
  — a consumed step or a disabled row cannot commit without its audit record.
- In production wiring the audit append shares the caller's connection inside
  the MFA transaction; standalone appends take their own transactional
  connection.

### 7. Step-up token validation (subject / session / purpose / expiry / epoch)

- Tokens are stateless HMAC-SHA-256 strings
  `su2.<userId>.<epoch>.<issuedAt>.<purpose>.<sessionId>.<mac>`.
- `verifyStepUpToken` checks, in order: format/version, MAC
  (constant-time `timingSafeEqual`), subject (`other_user`), enrollment epoch
  (`stale_epoch` — re-enroll and disable both bump it), purpose (`purpose`,
  default `platform_mfa.step_up`), session id (`session`, default `''`), and
  finally age (`expired`, default max 600 s). Any mismatch is a denial; the
  `createRequireStepUp` guard answers 403 with a `STEP_UP_*` code and 503 when
  the key is unavailable (fail-closed).
- `POST /disable` is the in-scope route guarded by it.

## What the tests prove (34/34 pass, hermetic)

Focused run: `M1_NETWORK_MODE=hermetic node --require ./scripts/m1-network-guard.cjs
--import tsx --test server/tests/m7-platform-mfa.test.ts` → **34 pass, 0 fail**.

- RFC 4226/6238 core: HMAC-SHA-1 test vectors, base32 roundtrip, ±1 window,
  replay-checked window logic.
- Sealing: roundtrip, wrong key throws, tampered envelope throws, key from env
  (missing / short / valid forms).
- Step-up tokens: in-window acceptance; tampering, foreign user, stale epoch,
  expiry, legacy-format and garbage rejection; purpose and session binding
  (a token minted for `sess-2` cannot act in `sess-1`; wrong purpose rejected).
- Parallel races (real `Promise.all` through the route, injected in-memory
  store mirroring the SQL predicates):
  - same TOTP code submitted twice simultaneously → exactly `[200, 400]`;
  - same recovery code submitted twice simultaneously → exactly `[200, 400]`
    and 9 hashes remain;
  - two simultaneous pending activations with different valid steps → both 200
    but exactly one recovery batch disclosed and one `platform_mfa.activated`
    audit;
  - pending secret swapped mid-verification (store hook) → 400, row untouched,
    replacement secret intact.
- Fail-closed: missing sealing key denies verify (503) **without consuming the
  step** (`last_used_step` stays 0) and denies enroll without writing a row;
  persisted lockout denies a correct code on a freshly built router (429,
  `MFA_LOCKED`, step not consumed).
- Audit rollback through the production transaction seam (buffering SQL
  double): failed audit on verify → no `last_used_step` write committed;
  on enroll → no `platform_mfa_*` write committed; on disable → neither the
  disable nor the recovery-code purge commits; successful enroll commits.
- SQL store statements: re-enroll and disable each issue the recovery-code
  purge, ordered before the new pending insert / after the disable.
- Lifecycle: disable → re-enroll → re-activate — the first batch of recovery
  codes is dead at every stage, the fresh batch works.
- Authorization: anonymous 401 with zero store reads; tenant owner 403;
  enroll/verify/disable gated on the injected platform permission
  (`platform_mfa.manage`, status on `platform_mfa.read`); a permission-denied
  admin writes nothing.

## Residual limits (not claimed as done)

- **Enforcement integration is not wired**: `createMfaVerifier` /
  `createRequireStepUp` are exported seams. Mounting them into
  `middleware/auth.ts`, `index.ts` or any sensitive route (making platform MFA
  mandatory, guarding e.g. impersonation or exports with step-up) is outside
  this task's allowed paths — auth/index are owned by other workers. No
  API-wide mandatory enforcement is claimed.
- Concurrency of the SQL predicates against a real MySQL server (row locking,
  `FOR UPDATE` behavior) is asserted through statement inspection and the
  in-memory mirror, not a live database (no DB execution allowed in this
  scope).
- The in-memory test store mirrors the SQL conditional predicates; if the SQL
  text drifts, the mirror tests will not catch it (the SQL-store statement
  tests narrow this for the purge paths only).
- SMS second-factor delivery remains deferred; no policy limits were changed.

## Verification evidence (this recovery run)

- Focused: 34/34 pass (command above).
- Full guarded suites (root and server cwd) and `tsc --noEmit` were run at
  completion; counts are recorded in the task report. Baseline before this
  task: 2223/2223, tsc 0.
