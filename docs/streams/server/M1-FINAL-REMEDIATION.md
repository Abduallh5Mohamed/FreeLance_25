# M1 — Server final remediation record (2026-10-17)

Task: `m1-server-consolidated-closure-remediation-20261017-01` (WorkBuddy, branch
`codex/workbuddy-server`). This record is evidence, **not** milestone acceptance:
Codex reviews and decides. Snapshot commit `af799c7f63b0aed7e3f90800f2cb2f2e8e0251ec`
plus the working tree (the review target); the tree was dirty before this task and
all prior corrections were preserved.

## 1. F1 / F2 — issuance defects (verified fixed)

**F1 (legacy staff login revoked incorrectly).** The canonical `/api/auth/login`
staff branch selected staff without `token_version` and signed a JWT without `tv`,
so a staff password change (which bumps the server version) permanently locked that
path out while `/api/staff/login` kept working.

- Fix: `server/src/routes/auth.ts` staff lookup now loads `token_version`, falls back
  only on a genuinely missing pre-migration column (`isMissingStaffTokenVersion`),
  and signs `tv: Number(staff.token_version || 0)` with the capped lifetime resolver.
  Other database failures propagate (fail closed); suspension gates are unchanged.
- Evidence: `server/tests/m1-close-auth-token-version.test.ts` — 14/14 pass,
  including both login paths at version 0 and 7, identical `tv` for the same row,
  version-bump revocation, pre-migration column fallback, DB failure fail-closed.

**F2 (workspace-select lifetime bypass).** Student workspace selection signed with
the raw `process.env.JWT_EXPIRES_IN || '7d'` instead of the shared validated,
capped resolver.

- Fix: `server/src/routes/student-enrollment.ts` uses
  `resolveJwtLifetimeSeconds(process.env.JWT_EXPIRES_IN)` and keeps the selected
  enrollment/tenant and `tv` claims.
- Evidence: same test file — unset/malformed/oversized values fall back or cap at
  7 days, short valid values honored exactly, `exp - iat` bounds asserted.

## 2. S1 — tenant-owned branch + branch-membership model

- New guarded migration (never executed outside the owned isolated stack):
  `server/migrations/20261017_06_branch_membership.sql`
  (`branches`: tenant FK, name, status, version, unique tenant+name;
  `branch_memberships`: branch FK, user FK, role, status, version, unique
  branch+user; utf8mb4_unicode_ci to match the schema).
- Enforcement: `server/src/security/branch-access.ts` — authority comes from the
  verified principal and server rows only. Denials: malformed selector, missing
  branch, cross-tenant branch, suspended branch, missing/revoked membership,
  membership version mismatch. Tenant owners keep an explicit owner path inside
  their own tenant only. Database failures propagate (fail closed).
- Real wiring: `POST /student-enrollment/spaces/:enrollmentId/select` validates a
  supplied `branch_id` against the server-side model for the enrollment's tenant;
  denials reuse the generic `403 {error:'Workspace not available'}` so nothing is
  enumerated. No client selector is ever treated as membership evidence.
- Legacy ambiguity: no branch rows are fabricated for existing tenants; a selector
  against a pre-migration schema (missing table) is denied, never bypassed.
- Evidence: `server/tests/m1-close-branch-membership.test.ts` — 15/15 pass
  (allow, missing membership, cross-branch same tenant, cross-tenant forged
  selector, suspended branch, revoked membership, version mismatch, malformed
  selector, owner path, DB failure, legacy no-selector path unchanged).

## 3. S2 — contact verification (OTP) lifecycle

- New guarded migration: `server/migrations/20261017_07_identity_otp.sql`
  (`identity_otp_challenges`: contact HMAC, purpose, tenant, identity, code HMAC,
  attempts/max, resend availability, expiry, consumed_at, created_ip).
- Service: `server/src/security/identity-otp.ts` — cryptographic random codes,
  HMAC-only storage (plaintext never persisted or logged), 5-minute expiry,
  attempt cap, per-contact throttle window, resend cooldown, purpose + contact +
  tenant binding, atomic single-use consumption via a conditional UPDATE, and a
  delivery interface that must be injected. With no delivery configured, issuance
  fails closed (`DeliveryNotConfiguredError`) **before** any row is written.
- Real flow: the public join request (`POST /student-enrollment/join/:token/requests`)
  now requires a consumed challenge (`otp_challenge_id`) bound to the submitted
  phone, purpose `enrollment_join` and the invite tenant; `POST .../contact-otp`
  and `.../contact-otp/verify` are rate-limited and never return the code. No
  admin/owner is minted and the existing instructor approval is untouched.
- Provider decision **BLOCKED**: no SMS/email/WhatsApp provider, channel or cost is
  approved, so `delivery` is deliberately `null` in production wiring and the
  endpoints answer `503 Contact verification is not available yet`. No mock success
  and no live message claim is made.
- Evidence: `server/tests/m1-close-identity-otp.test.ts` — 10/10 pass (HMAC-only
  storage, single-use replay denial, attempt cap, expiry, cross-contact/purpose/
  tenant reuse denial, resend cooldown, throttle, absent-delivery fail-closed with
  zero rows, DB failure propagation, concurrent consume exactly-one).

## 4. S9 — tracked-source secret scan

- `scripts/scan-m1-tracked-secrets.cjs`: `git ls-files` + optional `--changed`
  paths, text extensions only, explicit exclusions (`.env*`, `.qa`, node_modules,
  dist/build/coverage, retired-claim archives, lockfiles). Output is
  `path:line rule-id` only — matched values are never printed. Exit codes 0/1/2.
- Evidence: `server/tests/m1-secret-scan.test.ts` — 6/6 pass (detection,
  redaction, allowlist, exclusions, `--changed`, usage error).
- Real run on this tree: `scanned=944 findings=2 allowlisted=3` — two **real,
  redacted** findings outside this task's write scope:
  - `backend-ecosystem.config.js:18 jwt-secret-assignment`
  - `server/start-minio.ps1:48 db-password-assignment`
  These require removal + credential rotation as separate approved operational work;
  no rotation is claimed here.

## 5. Validation (after all changes)

| Check | Result |
|---|---|
| Hermetic suite, repo root (`M1_NETWORK_MODE=hermetic`, guard preload, tsx loader) | **1107/1107 pass** |
| Hermetic suite, server cwd | **1107/1107 pass** |
| `tsc --noEmit -p server/tsconfig.json` | exit 0 |
| `git diff --check` | exit 0 |
| New isolated bootstrap (`bootstrap-retry04`, unique volume `..._mysql_retry04`) | **96 tables, 0 `[ERROR]` log lines**; `branches`, `branch_memberships`, `identity_otp_challenges` present with expected columns and the tenant FK |
| Guarded live run (seed → API → tenant-isolation integration) | **3/3 pass**, `M1 isolated validation completed successfully` |
| Backup/restore on second uniquely named DB (`tabweb_m1_test_restore_proof_04_final`) | tables 96=96; INSERT payload SHA-256 identical (`a0336155…`); row counts match; source DB untouched |

Prior volumes (`retry02`, `retry03`, earlier proofs) are preserved untouched; the
failed volume remains as evidence. No historical migration was edited, no FK check
was disabled, no Docker reset/prune, no git write.

## 6. S1–S9 verdict (no self-acceptance)

| ID | Verdict | Basis |
|---|---|---|
| S1 | **PASS (server contract)** | Resource-derived branch contract + migration 08 + live allow/deny/revocation evidence. Legacy `unassigned` classification remains a product decision; admin UI absent (API + audit exist). |
| S2 | **PARTIAL — delivery BLOCKED** | Lifecycle, storage, throttling, single-use and real-flow guard implemented and tested; the provider/channel/cost decision is unapproved, so live delivery remains `503`. |
| S3 | PASS | Unchanged from the final review; RBAC suite green in 1141. |
| S4 | PASS | Invitation single-use/expiry preserved; join now additionally requires contact verification. |
| S5 | PASS | Immutable staged bootstrap, new migrations staged from reviewed hashes, restore content proof. |
| S6 | PASS | Live A→B file boundary test green. |
| S7 | PASS | Live cross-tenant video boundary test green. |
| S8 | PASS | Socket/queue boundaries unchanged and green. |
| S9 | **PARTIAL — rotation external** | Both tracked literals removed, fail-closed startup tested, redacted scan `findings=0`; credential rotation and Git-history rewrite are unexecuted external steps. |

**Server closure recommendation: still BLOCKED** — S2 delivery and S9 secret
rotation are external/approval-dependent, the legacy branch classification is a
product decision, and branch administration has no UI. Codex decides acceptance.

## 7. Changed files (this task) and snapshot hashes

| Path | SHA-256 |
|---|---|
| `server/migrations/20261017_06_branch_membership.sql` | `9dcc079a56712a2b6f93254634c2335d0b9fb2852eec63ec63be451a20e557fc` |
| `server/migrations/20261017_07_identity_otp.sql` | `66554fc9a6974204f2e1f27147436cddfadac080671bbba1b4eb6f1451776afd` |
| `server/src/security/branch-access.ts` | `e03cbb55fb4a2aec3d0c47619cc8724ecfe5a1fa65c7ee0b1ba733c55794abce` |
| `server/src/security/identity-otp.ts` | `592437161a97635db19e7e0f4730c6d9c601812c2f09055b9ccb7882571ac679` |
| `server/src/routes/student-enrollment.ts` | `570f77d85d4a9c88ecf8ae7262669e4f90b289d14d4b14b0d653ee62b1842988` |
| `server/src/routes/auth.ts` | `9c86258b11bfd5aecd95ec77abe188cebe6b79709d0222219fb0b15147443ce0` |
| `scripts/scan-m1-tracked-secrets.cjs` | `8a941be1e28a0b85585c0501e9f680900052b6a2ab754a8b58ce2b498d9cc88b` |
| `server/bootstrap/m1/manifest.json` (35 source migrations) | `7d36d4fd7f9abd98b40d1f81b6a0013e27dbfb767b98119b242a5ab0ca29e5cf` |
| `server/tests/m1-close-auth-token-version.test.ts` | `decf185679c8df22b277ae38fe95cfeb5ad16c1f44dc11860f3b91b3401b0c0e` |
| `server/tests/m1-close-branch-membership.test.ts` | `46ff50c8b9f76561ae858bd37f7c7bcd3a1995aa80f676f97d7f933dd43de817` |
| `server/tests/m1-close-identity-otp.test.ts` | `9f8ac843b592424f7116ba3fe979a1b5ad07b4658fb073f8e984c55b0de8cdd6` |
| `server/tests/m1-secret-scan.test.ts` | `bb353b5d50ac28e80d6e14b8192b8cdbad64c3a627efe231da4939bbf095381f` |

Also touched within scope: `server/tests/m1-close-enrollment-courses.test.ts`
(one assertion re-pointed to the exported handler body after the F2 refactor; the
security property is unchanged), and the private run directory evidence
(`bootstrap-retry04/`, `backup-restore-proof/*retry04*`).

## 8. Open questions / blockers

1. **OTP delivery provider** — choose channel (SMS/email/WhatsApp), provider,
   sender identity and cost model; then a small approved scope wires the adapter
   and the endpoints stop returning 503.
2. **Tracked secrets** — approve removal and rotation of the two redacted findings
   above (files are outside this task's write scope).
3. **Branch administration surfaces** — creating/suspending branches and
   memberships from the UI/API is not part of this server remediation; propose a
   follow-up scope if required for closure.

## 9. Follow-up 2026-10-17 — resource-derived branch isolation + tracked secret removal

Task `m1-branch-resource-isolation-secret-cleanup-20261017-01`. This section
supersedes the S1/S9 limits above with the evidence below; it does not close M1.

### 9.1 Branch resource contract

- Contract: `docs/streams/server/M1-BRANCH-RESOURCE-CONTRACT.md`.
- New module: `server/src/security/resource-branch.ts` — derives the branch
  from the trusted parent chain (`groups`, `material_groups`, `exam_groups`,
  `premium_lectures`, `attendance`, file parents, video parents). A caller
  selector must match the derived branch; a tenant-level resource rejects a
  selector; conflicting parent links and branch-scoped rows without a branch
  are ambiguous and denied, never widened.
- New migration only: `server/migrations/20261017_08_resource_branch_scope.sql`
  (`groups.branch_id`, `groups.branch_scope`, index, FK, `branch_audit_log`).
  Historical migrations are unchanged; no FK check is disabled.
- Wired handlers: groups, materials, lectures, attendance, exams,
  premium-lectures, files download, secure-video session/refresh,
  student workspace select, plus `/api/branches` lifecycle/audit/quarantine.
- Session binding: `auth.ts` re-reads branch + membership status/version on
  every request; revocation, suspension or version bump denies the next
  request with `401 BRANCH_REVOKED`. The student workspace-select token now
  carries `branch_id` + `branch_membership_version` and must match the
  enrollment group's branch.
- Legacy `unassigned` groups keep their pre-existing tenant access, are
  reported by the audited quarantine endpoint, and can never satisfy a branch
  context. Whether they should become branch-owned is an explicit product
  question in the contract document.

### 9.2 Tracked secrets removed

- `backend-ecosystem.config.js`: `DB_PASSWORD` and `JWT_SECRET` are now
  `requiredEnv(...)` references; a missing value throws during config load.
  No default/generated credential remains.
- `server/start-minio.ps1`: `MINIO_ROOT_USER` / `MINIO_ROOT_PASSWORD` are
  required from the environment; empty values exit non-zero before MinIO
  starts. No literal assignment remains.
- Tests: `server/tests/m1-secret-env-required.test.ts` proves missing-value
  failure and injected-value success for both files without printing values.
- Redacted scan (strict rules, no new exclusions/allowlisting of real
  findings):
  - tracked tree: `scanned=944 findings=0 allowlisted=3`
  - tracked + changed paths: `scanned=978 findings=0 allowlisted=9`
  - allowlisted entries are the pre-existing synthetic fixtures under
    `server/tests/`.
- Rotation and old Git history remain **unexecuted external steps**: no
  rotation, logout, purge/rewrite, secret-manager read or publishing occurred.

### 9.3 Validation commands and exits

| Command | Result |
|---|---|
| `M1_NETWORK_MODE=hermetic node --require ./scripts/m1-network-guard.cjs --import tsx --test server/tests/*.test.ts` (repo root) | **1141/1141 pass**, exit 0 |
| same command from `server/` with `../scripts/m1-network-guard.cjs` | **1141/1141 pass**, exit 0 |
| `npx tsc --noEmit -p server/tsconfig.json` | exit 0 |
| `git diff --check` | exit 0 |
| scanner tests (in suite) + real redacted scans | pass, `findings=0` |
| isolated runner (`seed -> API -> integration`) | **3/3 + 5/5 live tests pass**, exit 0 |

Prior 1107 pass was the baseline; the new total is 1141 hermetic tests (the
increase includes the new branch/secret tests). Integration tests are live-only
and are not part of the hermetic glob.

### 9.4 Fresh isolated stack

- New staged bootstrap `bootstrap-retry05` (unique volume
  `..._mysql_retry05`), built from the current source: **97 tables, 0
  `[ERROR]` log lines**, `groups.branch_id`/`branch_scope` and
  `branch_audit_log` present.
- Existing volumes (`retry02`, `retry03`, `retry04`, base) and prior dumps are
  preserved. Only the owned MySQL container was recreated; MinIO was left
  running. The owned API was stopped after the run; owned volumes remain for
  the supervisor.
- Live branch evidence: branch group allow/deny, cross-tenant 404, revocation
  next-request 403, branch suspension, branch-owned lecture + forged selector
  403, branch-scoped student token 401 after revocation, explicit tenant-level
  group preserved, branch administration/audit/quarantine.
- Restore proof into new DB `tabweb_m1_test_restore_05_final`:
  - tables 97 = 97; per-table `CHECKSUM TABLE` mismatches 0; row-count
    mismatches 0;
  - data-only dump SHA-256 identical
    `d5fed99b67aff72c7e47d962546bedd7afab73db6c4017373e17452fb327cc27`;
  - normalized schema structure mismatches 0 (only `AUTO_INCREMENT` counters,
    explicit `CHARACTER SET utf8mb4` display, and view database-name
    qualification differ; the logical definitions match).
- Non-blocking background warning observed once: the video queue's initial
  pending-job load logged `Incorrect arguments to mysqld_stmt_execute`; it did
  not affect the API, the branch routes or the integration results. It is
  pre-existing queue behavior, not introduced by migration 08.

### 9.5 Changed files and hashes (this follow-up)

| Path | SHA-256 |
|---|---|
| `server/migrations/20261017_08_resource_branch_scope.sql` | `b7bdc154fb5f53865dd32107e338152a0a5ce4c84c7d5baa339e428c88819e39` |
| `server/src/security/resource-branch.ts` | `8f3890029c5fe7a6e80bee7de56520900aaf65dc8cac235ffcace92b69c52ccf` |
| `server/src/middleware/auth.ts` | `54e4fddd04d6dc04ade4507aa096069aa070a6b4d0bf490160132972cd0da2bd` |
| `server/src/security/principal-repository.ts` | `af57ecbdf84ce88e200a8105bcaaa9627f2ed3818f99e3b11d58614cb17ab747` |
| `server/src/routes/branches.ts` | `c32eedc4193f9250ae55dade81b010338e032180c43c6575ea1b353d89671e47` |
| `server/src/routes/groups.ts` | `01f5eb1c2b78dde9969d8d922fedf97d616e7f3ee08129087902c2692bd9b7fa` |
| `server/src/routes/materials.ts` | `80f3655743069dd10ad30ed0b3ed620f1b39933cfec0080659457840f6bf13e8` |
| `server/src/routes/lectures.ts` | `0aadb41717adb02e735b949db2b33dc79103d4bb9853c6ef895204c9c8091661` |
| `server/src/routes/attendance.ts` | `e56e08822ceb9e464054efdb1d2681164fb02433680cfe09c224c24dec349ef8` |
| `server/src/routes/exams.ts` | `04c061f88c8851215ab5b9d9126f71f776eb0fd859bc79c6078c45cf8620a31c` |
| `server/src/routes/premium-lectures.ts` | `66a3a7f5a28a819ec5bc8c60eeef719de801da626f4a5fdd77bc6346a8fe9876` |
| `server/src/routes/files.ts` | `a06b265ab60e08ac1e5df7fc56fe7051b0d9db2d10781c3af06fe28b11cc28a4` |
| `server/src/routes/secure-video.ts` | `e69c7ba742a54d91a3d81ac8c972817b142428d08252b4c9c1eb3ef70798b50d` |
| `server/src/routes/student-enrollment.ts` | `d986bbe584bf8f015af7c001e2ff5148907a8d38d7c1821998706a9da157e94f` |
| `server/src/index.ts` | `232311059b7b17841d807924abc7aa1a25b25d9cf07ab192015c5fb960c7e995` |
| `server/scripts/seed-m1.ts` | `003ad7e632eec465c3660b20cb9058fb4dd19f031c09d556e584a12731d05021` |
| `server/scripts/run-m1-isolated-validation.cjs` | `eef1fb27a4a75eae95c3bb85a2dabda6f41ad024c13bf201e02bba115c64694b` |
| `backend-ecosystem.config.js` | `5ae528ef25f8b18ab11a4bac3c616193a5fe1a63aa945be0736ed4182c82380c` |
| `server/start-minio.ps1` | `354e8241a3aa1bd0b8ae600b2f2b6c2e586377b991938e62525831edd6512d87` |
| `server/tests/m1-branch-resource-contract.test.ts` | `d0f33c4fe7d1e9fd66c0eee068b78c2b8f13371e6c0e619f6827d4cdcec13dfa` |
| `server/tests/m1-secret-env-required.test.ts` | `f42cf6f37560098d70780509dcf3fc7f168ca222450046590da32340837e2c86` |
| `server/tests/integration/m1-branch-resource-live.test.ts` | `b1e38e091a4c5255ff3abaedf9fba1a12b7b38992bd3b00a759fe49bd2400652` |
| `server/bootstrap/m1/manifest.json` | `7ba96d0d69aaff2a5310acf084a356d591795a4fdee0979efb963345422af527` |
| `server/tests/helpers/tenant-scope-branch-deps.ts` | `956cf2b41b6e55aab76e045c5e84c0f5771e95c8ce2489543b0fa84b1f9ef9e6` |

### 9.6 Remaining blockers / questions

1. **Legacy branch classification (product decision):** are `unassigned`
   groups tenant-level or branch-owned? They are preserved and reported, never
   auto-assigned.
2. **SMS/OTP provider:** channel, provider, sender identity, cost and approval
   are still undecided; absent delivery remains fail-closed `503`, so contact
   verification onboarding is unavailable.
3. **Credential rotation / Git history:** unexecuted external steps; no claim
   of rotation is made.
4. **Branch administration UI:** API + audit exist; no UI is part of this
   server scope.
5. **Live route breadth:** groups/lectures/student selection/branch admin have
   live evidence; the other resources are enforced in code and covered by
   resolver/handler tests.

## 10. Correction follow-up — legacy scope + video parent gap (2026-10-17)

Task `m1-branch-legacy-video-correction-20261017-01`. Closes the two points Codex
flagged as `partial_not_accepted_legacy_scope_fallback_and_video_parent_gap`. This
section is evidence; M1 remains open (Codex decides acceptance).

### 10.1 FIX1 — legacy fallback becomes ambiguous/deny

`server/src/security/resource-branch.ts` `mapGroupScope` now returns
`scope:'ambiguous'` (audit-only `legacyUnclassified`) for `branch_scope`
`'unassigned'` / `NULL` / unknown — never a silent tenant fallback. The resolver
denies every principal, including the tenant owner and a verified platform operator;
there is no owner bypass and no invented default branch. An explicitly
`tenant`-classified row keeps its tenant access (positive control). Classification
of a legacy row is possible only through the audited quarantine endpoint.

### 10.2 FIX2 — video parent chain; course never guessed into a branch

`loadVideo` resolves every present parent (`lecture_id`, `material_id`,
`course_id`) against server rows; a dangling/missing parent is ambiguous even when
another parent is valid. Conflicting branch ids / tenants are ambiguous. A course is
treated as explicit tenant-level only and is **never** expanded through
`groups.course_id`, so a course shared by many branch groups is not guessed into a
single branch, and an explicit tenant-level course keeps its legitimate tenant
access. A video with no resolvable parent context is denied (`video-without-context`).

Supervisor correction honored: `course -> groups` is one-to-many across branches; no
first-row pick, no whole-course reclassification.

### 10.3 Wiring review — no bypasses

`enforceVideoBranch` / `sessionVideoBranchAllowed` are already on every
secure-video route (session, refresh-token, heartbeat, manifest, media, key) and on
all `videos.ts` list/read/update/delete/stream/key paths. No new bypass was found.

### 10.4 Tests and validation

New tests (hermetic, no DB/network): `server/tests/m1-branch-legacy-scope.test.ts`
(10) and `server/tests/m1-branch-video-scope.test.ts` (12) — 22 total, driving the
REAL `createSqlResourceScopeLoader` / `loadVideo` / `resolveResourceBranchAccess`
and the real `groups` router.

| Command | Result |
|---|---|
| hermetic, repo root + server cwd | **1163/1163 pass** (1141 prior + 22 new), exit 0 |
| `tsc --noEmit -p server/tsconfig.json` | exit 0 |
| `git diff --check` | exit 0 |
| redacted secret scan | `scanned=944 findings=0 allowlisted=3` |

No source file was modified for this correction beyond the already-present
`resource-branch.ts` fixes; only two new test files were added. Hashes:

- `server/tests/m1-branch-legacy-scope.test.ts` `b5dafbf1b4e76ce3e0e52c0caeecf6aaf6963112ddc7fefcaac48a9fdb25c300`
- `server/tests/m1-branch-video-scope.test.ts` `9d38ef10cd3b27e472aa5475394c254eecac9b98de8675387b7fd537f27e4319`

### 10.5 S1 verdict update

S1 is now **PASS (production-path tests + explicit relation contract)**: legacy
unclassified resources are denied without an owner escape hatch; authorized
quarantine and explicit-tenant positive controls work; every supplied video parent
is resolved or denied; conflict/missing-context fail closed; a course's
multi-branch relations are not guessed and legitimate tenant-level courses are
preserved. M1 is still not automatically accepted.

### 10.6 Remaining (unchanged external/approval)

1. **SMS/OTP provider** — channel/provider/cost undecided; absent delivery stays
   fail-closed `503`.
2. **Tracked secrets** — both literals already removed; rotation + Git history are
   external, unexecuted.
3. **Branch administration UI** — API + audit exist; no UI in this server scope.
4. **Live route breadth** — groups/lectures/student selection/branch admin have
   live evidence; the other resources are enforced in code and covered by
   resolver/handler tests.
