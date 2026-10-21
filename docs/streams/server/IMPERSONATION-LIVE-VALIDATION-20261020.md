# Isolated live MySQL validation of support impersonation — 2026-10-20

Task: `server-impersonation-isolated-mysql-validation-20261020-01` (team `qa`).
Branch: `codex/workbuddy-server` (HEAD `03b7707bdf3a3e0c19a24768ed83d6e0d5ce40c3`).
Worker: `wb-impersonation-isolated-mysql-validation-20261020-01`.

## Status

- Support impersonation was exercised **for real** on a brand-new, isolated,
  throwaway MySQL 8.0.44 instance seeded with synthetic rows only, over real
  loopback HTTP, through the **actual production** middlewares, verifier,
  SQL store, management router and sealed-audit writer. No fixture doubles
  stand in for the security-critical path.
- `server/tests/integration/m7-impersonation-live.test.ts`: **14/14 pass**,
  reproduced three consecutive times on the same instance.
- **One real production defect found and pinned** (section 8): the approval
  write path stores `expires_at` two hours behind the instant it announces, so
  a freshly approved session is **already expired**. It is reported, **not
  fixed** — this task may not modify production code.
- No existing database, container, volume or production credential was
  touched. No production code, frontend file or `src/public/index.html` was
  modified. Nothing was committed or pushed.

## 1. What the task required, and where each item is proven

| Requirement | Result | Evidence |
| --- | --- | --- |
| Real production SQL adapters, not fakes | done | tests 1, 4, 6, 7, 9, 10, 12 use `src/middleware/auth`, `impersonation-context`, `services/impersonation`, `routes/impersonation`, `services/audit-log`, `src/db` |
| Real distinct MySQL connections | done | test 1 asserts two simultaneously held pool connections report different `CONNECTION_ID()` |
| Concurrent start, same target → one pending/active | done | test 2: `[201, 409]`, exactly one row, exactly one `session_requested` audit |
| Independent target starts positively | done | test 3: second target `201`, second audit row |
| Audit failure rolls back start/approve/revoke | done | test 6: real `ER_NO_SUCH_TABLE` inside the transaction, no phantom row, no activation, no revoke |
| Live actor permission removed (identity/tokenVersion unchanged) → next-request deny | done | test 7: `actor_permission_revoked`, users row still active with `token_version = 0`, session row still `active`, and restoring the permission revives the same context |
| Exact target deactivated / membership revoked → next-request deny | done | test 8: `target_identity_unavailable`, then `tenant_mismatch` |
| Signature / expiry / scope / tenant mismatch | done | test 9: `signature`, `expired`, `row_mismatch`, `tenant_mismatch`, plus a positive control |
| Ordinary request unaffected | done | tests 1, 11 |
| Actor distinct from effective principal | done | test 10: `actorUserId` = support actor, `principalId` = target, role/tenant from the target |
| Guards before all business routes + parent deny | done | test 11 (allowlist, mutation, management namespace, `/api/parent`) and test 14 (static mount-order assertion on `src/index.ts`) |
| Sealed audit chain over real rows | done | test 13: `verifyAuditChain` → `ok: true`, `checked: 5`, anchored, untruncated |
| Dedicated random test-only secret, never published | done | section 3 |
| No public API or listener exposed | done | section 3 |

## 2. Isolation proof

- The instance is a **new** `mysqld` process with its own data directory
  created by `--initialize-insecure` inside the owned run folder. It is not a
  copy of, and shares nothing with, any M1 stack, `flux-postgres` or any other
  container or database on the machine.
- Binding: `--bind-address=127.0.0.1 --port=23377 --mysqlx=0`. `netstat`
  shows exactly one listener, `127.0.0.1:23377`, owned by the `mysqld` pid in
  `mysqld.pid`. Nothing is bound to `0.0.0.0`.
- Docker was never used: `docker ps` fails with
  `open //./pipe/dockerDesktopLinuxEngine: The system cannot find the file
  specified`, i.e. the daemon is unreachable, so no existing container could
  be started, stopped, reset or purged. No `docker` verb was run against any
  existing object.
- The database name is `imp_live_20261020`; the suite refuses to run unless
  the target is loopback, on a port in `20000..65000`, with a database name
  matching `^imp_live_[a-z0-9_]+$` and two distinct secrets of at least 32
  characters (`assertOwnedTarget`). It fails closed before opening a single
  connection otherwise.
- Every row in the database is synthetic: eight `users` (`*@live.invalid`),
  two `tenants`, five `tenant_memberships`, two `admin_roles`, three
  `admin_user_roles`, four `admin_role_permissions`. No production credential,
  `.env`, api-env or password file was read.

## 3. Secret handling

- A dedicated `IMPERSONATION_TOKEN_SECRET` was generated with
  `crypto.randomBytes(32)` (64 hex characters) for this disposable run only,
  alongside a separate random `JWT_SECRET`. They are provably distinct
  (`secretsDistinct: true`).
- Both live in a private run file,
  `…/handoff/impersonation-isolated-20261020/.env.m7live`, whose ACL has
  inheritance removed so only the owning Windows account keeps `(R,W)`.
  POSIX mode bits are not meaningful on NTFS and are reported only for
  completeness.
- The **value was never printed, logged or written to any report**. Only
  presence, length and a SHA-256 prefix of the whole file are recorded
  (`942FB867B748C78C`).
- No real environment file was written; nothing was exported outside the
  spawned processes.
- Earlier in the run one throw-away application password was echoed by a
  failing `mysql.exe -e "CREATE USER … IDENTIFIED BY '…'"` invocation. Both
  the root and the application passwords were immediately rotated with fresh
  `crypto.randomBytes(24)` values and the mysql CLI was abandoned in favour of
  library calls that never put a password on `argv`. The leaked value was
  never valid against the surviving instance.

## 4. Provenance

Production sources under test (unchanged by this task; SHA-256):

```
35c9207f4168e8d212c75eb0bad0f362f6fb1d52551a032a07f1a51e695dd5ef  server/src/middleware/impersonation-context.ts
faeebcbcb1403323310185164ac5108d755dc2c03a9361802c13dc4805088b34  server/src/middleware/auth.ts
4fb331a96a14994fbf3a347f35d673997980912f6d5333ed60dca29a5cbb660c  server/src/services/impersonation.ts
e46b7f9129ce189841911f9a35bf12f20d49bfaf4da326900bad90f36329a103  server/src/services/audit-log.ts
44aabb647ce7179530f2f5f63939b0538a0dcea5b837dd505a6706ae454be40e  server/src/routes/impersonation.ts
0cce895ff2bec4ffc195bd5469132749da845f2b5312c619f94c9832c9ede546  server/src/security/admin-permissions.ts
ad2a04b4ea698f6fded0c179c2ce8991a5fc173bc08f97c14a4527eb65c2d4be  server/src/security/identity-scope.ts
7bb71f3a10b09f2481bb308ba0c6251fa96b7321315221b6ca227f4ec998e342  server/src/db.ts
0c83bcda72ed9ab3c9fa7b34a102dc057bafb36244918ffbbedcc0f56913c9ae  server/src/index.ts
```

Test file (new, the only source-tree file this task created):

```
627a2bc3b6d03c3f1fa6e86c06ad81d611ef262b29aa8bf216e452b5075285e0  server/tests/integration/m7-impersonation-live.test.ts (742 lines)
```

Migrations: the unchanged chain of **57** `server/migrations/*.sql` files, each
hashed in `migration-hashes.json` before it ran. No migration file was edited,
no SQL was rewritten, no FK check or trigger was disabled.

Fixture provenance: every row is inserted by the suite's `before()` hook with
fixed synthetic UUIDs (`a0000000-…`, `c0000000-…`, `d0000000-…`) and
`@live.invalid` addresses. The hook wipes the ten fixture tables and reseeds
them on every run, so repeated runs start from the same state.

## 5. Instance and schema

```
version            8.0.44 (MySQL Community Server - GPL)
port               23377, bound to 127.0.0.1 only, mysqlx disabled
datadir            …/impersonation-isolated-20261020/mysqldata (unique to this run)
global/session tz  +02:00  (system: Egypt Daylight Time, +03:00)
database           imp_live_20261020
tables             142
```

The instance is started with `--default-time-zone=+02:00` so its wall clock
matches the offset `src/db.ts` pins on the application pool. Without that, every
`TIMESTAMP` read through the pool appears one hour in the past and every live
`expires_at` looks expired — a harness artefact, not a product behaviour (see
section 9).

Migration application, two passes over the same unchanged files:

- pass 1: **50 applied, 7 failed, 137 tables**. All seven failures were
  ordering artefacts of applying a chain to an empty schema
  (`Failed to open the referenced table 'lectures'`, `Unknown column
  'instructor_id' in 'students'`, `Key column 'tenant_id' doesn't exist`, …).
- pass 2: **4 applied**, the remaining **3** failed only with
  `Duplicate column name 'price'`, `Table 'student_enrollment_backfill_reviews'
  already exists`, `Duplicate column name 'subject_type'` — i.e. their objects
  already existed, so nothing is missing.
- final: 57/57 files resolved, **142 tables**, and every table and column the
  impersonation path touches verified present:

```
users(id,email,role,is_active,token_version,suspended_until)
tenants(id,owner_user_id,status,legacy_compat)
tenant_memberships(id,tenant_id,user_id,status)
students(id,tenant_id)
admin_roles(code)
admin_user_roles(user_id,role_code)
admin_role_permissions(role_code,permission_key)
impersonation_sessions(id,started_by,approved_by,target_user_id,tenant_id,scope,
                       status,requested_seconds,expires_at,revoked_at,revoked_by)
audit_events(id,action,entry_hash,prev_entry_hash,chain_seq)
audit_chain_head(id,head_seq,head_entry_hash,head_row_id)
```

`tenant_memberships` only needs `tenant_id` for the auth membership query;
`instructor_id` / `group_id` / `grade_id` come from `students`, which is why the
`students(id,tenant_id)` subset is sufficient here.

Full machine-readable snapshot: `evidence-snapshot.json` in the run folder
(`schema.required[].missingColumns` is empty for all ten tables).

## 6. The live suite

`server/tests/integration/m7-impersonation-live.test.ts` is **not** part of
`npm test`: the hermetic runner globs `tests/*.test.ts`, which excludes
`tests/integration/`. It boots the real module graph after pointing
`process.env.DB_*` at the owned database, then mounts the production order on a
loopback Express app on an ephemeral port:

```
/api/parent   rejectImpersonationHeader → parent surface
/api          optionalAuth → enforceImpersonationContext
/api/platform/impersonation   management router (real requireAdminPermission)
/api          business routes (students read, audit-logs, students write)
```

Results (three consecutive runs, identical):

```
ok 1  the live target is the owned synthetic database served by real distinct connections
ok 2  concurrent starts for the same target open exactly one session on real MySQL
ok 3  a start for a different target succeeds independently
ok 4  approval by a second admin activates the session and mints a bound context
ok 5  DEFECT: approval stores an expires_at two hours behind the instant it announces
ok 6  a failing sealed-audit sink rolls start, approve and revoke back
ok 7  withdrawing the actor live platform permission denies the very next request
ok 8  target deactivation and membership revocation deny the next request
ok 9  signature, expiry, scope and tenant mismatches are refused on real rows
ok 10 a verified context keeps the actor distinct from the effective principal
ok 11 the enforcement keeps the read allowlist, mutation deny, management deny and parent reject
ok 12 revocation stops the context on the very next request
ok 13 the sealed audit chain verifies over the real synthetic rows
ok 14 index.ts mounts the enforcement after the shared guard and before every business router

# tests 14
# pass 14
# fail 0
```

Post-run database state (preserved for review, nothing cleaned up):

```
impersonation_sessions   2 pending_approval, 1 revoked
audit_events             5 sealed, 0 unsealed
  session_requested 3, session_approved 1, session_revoked 1
audit_chain_head         1 row, verifyAuditChain → ok, checked 5, anchored
```

## 7. What the enforcement actually proved

- **Concurrency is real, not simulated.** Two starts for the same target ran on
  two distinct server sessions and resolved to `201` + `409` with exactly one
  `pending_approval` row and exactly one sealed `session_requested` event. A
  different target started independently, so the serialization is per target,
  not a global mutex.
- **The audit sink is load-bearing.** With `audit_events` renamed away, start,
  approve and revoke each failed with a genuine `ER_NO_SUCH_TABLE` raised
  inside their transaction. No phantom `pending_approval` row survived, the
  pending row stayed pending, and the active row stayed active. When the table
  came back, the same start succeeded and produced exactly one new audit row.
- **Permission withdrawal is checked live, per request.** Deleting
  `impersonation.start` from `admin_role_permissions` left the actor's `users`
  row active, its `token_version` at `0` and the session row `active`, and the
  very next request was denied with `actor_permission_revoked`. Re-inserting
  the permission revived the *same* context, proving the recheck is live rather
  than a one-shot invalidation.
- **Target liveness is re-resolved server-side.** Deactivating the target gave
  `target_identity_unavailable`; removing its membership gave
  `tenant_mismatch`. Both are read from rows, not from the token.
- **The actor never becomes the effective principal.** On a verified context
  the handler sees `principalId = target`, `principalRole = teacher`,
  `principalTenant = tenant A`, while `actorUserId` stays the support actor and
  the banner carries `sessionId`/`tenantId`/`scope`.
- **The allowlist is deny-by-default.** `/api/audit-logs` → `path_denied`,
  `POST /api/students` → `read_only`, management namespace →
  `management_namespace`, `/api/parent` → `parent_path`, and an ordinary
  request without a header is untouched.
- **Mount order is asserted against the real file.** Test 14 reads
  `src/index.ts` and requires the enforcement to appear exactly once, after the
  shared guard chain and before every business and management router, with the
  parent rejection before the parent views router.

## 8. DEFECT — approval mints an already-expired session

**Not fixed by this task.** Reported here with reproduction and numbers.

`server/src/services/impersonation.ts`, `createSqlImpersonationStore`:

```ts
transitionToActive: async (sessionId, approverId, expiresAt, now) => {
    const result = await db.execute(
        `UPDATE impersonation_sessions
         SET approved_by = ?, status = 'active', expires_at = ?, updated_at = ?
         WHERE id = ? AND status = 'pending_approval' AND started_by <> ?`,
        [approverId, expiresAt.toISOString().slice(0, 19).replace('T', ' '),
         rowStamp(now), sessionId, approverId],
    );
```

`expiresAt.toISOString()` is a **UTC** wall clock. The same column is written
elsewhere by passing a `Date` and letting the driver apply the pool's
`timezone: '+02:00'` (`insertSession`), and it is read back through that same
`+02:00` interpretation (`src/db.ts`). The two writers of one column therefore
use different conventions, and the sealed audit row records a third value
(`bounded.toISOString()`).

Observed on the isolated instance (test 5, reproduced three times):

```
announced by the route (UTC ISO)      2026-10-19T23:30:12.000Z   (now + 600s)
literal column value (CAST AS CHAR)   2026-10-19 23:30:12
instant the +02:00 read path yields   2026-10-19T21:30:12.000Z   (drift −7200s)
verifier verdict                      { ok: false, reason: 'expired' }
surface response                      HTTP 403, reason 'expired'
```

Consequence: **every approved session is dead on arrival.** The approval
returns `200` with a signed `impersonation_token`, and the very first
impersonated request is refused as `expired` before any allowlist, scope or
tenant rule can run. On a deployment whose database session time zone is
*not* `+02:00` the sign flips instead: `insertSession` becomes the wrong
writer while `transitionToActive` happens to be right. The two conventions
cannot both be correct, so this needs one authoritative decision (store UTC and
read UTC, or always pass `Date` and let the pool convert) rather than a local
patch.

Impact on this validation: the enforcement tests (7–11) exercise the rules by
giving the approved row an expiry written with `NOW() + INTERVAL 600 SECOND`,
i.e. the instant the application *intended* to store — the same convention the
read path uses. That workaround is documented in the test (`ensureUsableExpiry`)
and does not hide the defect: test 5 pins it with the drift, the literal column
value, the verifier verdict and the live surface response.

## 9. Harness corrections made during the run (test file only)

These were mistakes in my own test, not product findings; each was fixed in the
test file rather than by weakening an assertion.

1. The suite's own `mysql2` pool did not mirror `src/db.ts`'s
   `timezone: '+02:00'`, so its `TIMESTAMP` reads were an hour off and every
   row looked expired. Fixed by pinning the same offset on the suite's pools.
2. `REVOKE INSERT ON db.audit_events FROM 'm7live'@'127.0.0.1'` is not
   expressible: the application user holds **database-level** grants, so MySQL
   answered `There is no such grant defined … on table 'audit_events'`. Replaced
   with `RENAME TABLE audit_events TO audit_events_unavailable` (restored in a
   `finally`), which fails the append inside the transaction for a real reason.
3. The chain assertion used `verification.valid`; the interface exposes
   `ChainVerification.ok` (`firstFailure`, not `failures`).
4. The drift assertion initially demanded exactly `-7200s`; the stored string
   is truncated to whole seconds, so the honest bound is `|drift + 7200| <= 1`.

## 10. Regression state after the change

All runs executed after the last write to the test file:

```
# guarded hermetic suite, repo root cwd
M1_NETWORK_MODE=hermetic node --require ./scripts/m1-network-guard.cjs \
  --import tsx --test server/tests/*.test.ts
# tests 2316 / pass 2316 / fail 0        (95 test files)

# guarded hermetic suite, server cwd
cd server && M1_NETWORK_MODE=hermetic node --require ../scripts/m1-network-guard.cjs \
  --import tsx --test tests/*.test.ts
# tests 2316 / pass 2316 / fail 0

# typecheck
cd server && node node_modules/typescript/bin/tsc --noEmit
# exit 0
```

The counts above are the **actual snapshot of this run**, not a guarantee: the
earlier 2316 figure was not assumed. `tsconfig.json` only includes `src/**/*`,
so the new integration test is outside the project typecheck; it was verified
separately with a strict standalone invocation
(`tsc --noEmit --strict --module esnext --moduleResolution bundler --target
es2022 --types node tests/integration/m7-impersonation-live.test.ts` → exit 0).

## 11. Reproduce

Secrets are read from the private run file and are redacted below.

```bash
# 1. isolated instance (already running in this run; pid in mysqld.pid)
"C:/Program Files/MySQL/MySQL Server 8.0/bin/mysqld.exe" \
  --datadir="$RUN/mysqldata" --port=23377 --bind-address=127.0.0.1 \
  --mysqlx=0 --default-time-zone=+02:00 \
  --pid-file="$RUN/mysqld.pid" --log-error="$RUN/mysqld.log" \
  --secure-file-priv="$RUN"

# 2. schema (unchanged migrations, hashes recorded first)
node "$RUN/apply-migrations.cjs"        # pass 1: 50 applied, 7 ordering failures
node "$RUN/retry-migrations.cjs"        # pass 2: 4 applied, 3 already-exist

# 3. the live suite
cd server && M7_LIVE_ENV_FILE="$RUN/.env.m7live" \
  node --import tsx --test tests/integration/m7-impersonation-live.test.ts

# 4. evidence snapshot (read-only)
cd server && M7_LIVE_ENV_FILE="$RUN/.env.m7live" node --import tsx "$RUN/evidence-snapshot.ts"
```

`$RUN` = `C:/Users/abdua/WorkBuddySupervisorBridge/handoff/impersonation-isolated-20261020`.

## 12. Limitations

- The fixture is **minimal but real**: the ten tables the impersonation path
  reads and writes, seeded with eight synthetic users. The remaining 132
  migrated tables exist but carry no rows, so this is **not** a claim of a full
  application bootstrap and no full-stack request path was exercised.
- The business handlers behind `/api/students` are two-line stubs mounted in the
  test app. They exist to prove *guard ordering and principal substitution*,
  not the behaviour of the real student routes; no production route file was
  modified or invoked.
- `optionalAuth` ran against the real principal repository, but the JWT
  fixtures are minted by the test with the run's `JWT_SECRET`; no login flow,
  MFA challenge or refresh rotation was exercised.
- The parent surface is represented by `rejectImpersonationHeader` plus a
  passthrough handler, not by `parentViewsRoutes`, because the parent router
  requires its own opaque-token configuration.
- Only MySQL 8.0.44 on Windows was used. No MariaDB, no containerised engine, no
  `utf8mb4` collation edge cases beyond the default.
- No external network or provider was contacted at any point.
- The instance and its data directory are **left running/preserved** for
  review, as required; the process must be stopped by whoever finishes the
  review (or by the next task) — this task's final act is documented in the
  report.

## 13. Open questions for the owner

1. The `expires_at` convention (section 8) needs one authoritative decision.
   Which is intended: store UTC and read UTC (drop the pool `timezone` pin for
   this column), or always pass `Date` and let the pool convert? Until then
   every approved support session is unusable.
2. `ChainVerification.ok` is asserted; if a future change renames it, test 13
   is the canary.
3. Should the live suite become a CI job behind an explicit opt-in flag? It
   currently requires a real MySQL and refuses to run without the owned-target
   guard, so it cannot be part of the hermetic suite.

## 14. Files written by this task

- `server/tests/integration/m7-impersonation-live.test.ts` (new, 742 lines)
- `docs/streams/server/IMPERSONATION-LIVE-VALIDATION-20261020.md` (this file)
- `docs/contracts/IMPERSONATION-CLIENT-HANDOFF.md` (frontend handoff)
- `…/handoff/impersonation-isolated-20261020/` (owned run folder: private env
  file, `mysqldata/`, logs, migration hashes, `evidence-snapshot.json`, TAP
  captures)

No other path was written. Nothing was committed, pushed or merged.
