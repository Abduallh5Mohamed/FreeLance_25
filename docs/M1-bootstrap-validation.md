# M1 fresh-install bootstrap staging

The staged plan is a review artifact, not a database runner. It copies every
tracked `server/migrations/YYYYMMDD_*.sql` in lexical order into a new,
explicitly named empty destination and prepends
`server/bootstrap/m1/prelude.sql` as `20260920_00z_m1_prelude.sql`. It also
prepends `server/bootstrap/m1/database-collation.sql` as
`20260920_00_a_m1_database_collation.sql`. Lexical
filename order therefore runs the database-collation prelude first, the legacy
baseline second, creates `groups`, then applies the
dependency prelude before migration `20260920_01`. It refuses an existing destination and
never connects to MySQL or reads environment configuration.

Run from either the repository root or another working directory:

```powershell
node scripts/build-m1-bootstrap.mjs C:\temp\m1-bootstrap-stage
```

The generated `manifest.json` records SHA-256 hashes of the original source
migrations and the staged order. The generator preserves all source files. It
only moves the byte-matched `groups.instructor_id` ALTER from
`20260928_runtime_schema_replacement.sql` to the reviewed prelude, and exits
with an error if that known statement changes. It does not suppress unexpected
SQL or edit old migration files.

## Database-collation prelude (ERROR 3780 repair)

The first fresh MySQL run failed at `20260920_05_instructor_system.sql`
line 19 with `ERROR 3780 ... instructor_wallets.instructor_id and
referenced column 'id' ... are incompatible`. Root cause: MySQL 8.0's server
default collation is `utf8mb4_0900_ai_ci`, and the legacy baseline creates
tables without an explicit charset, so `users(id)` is
`utf8mb4_0900_ai_ci`, while later migrations create tables with explicit
`COLLATE=utf8mb4_unicode_ci` and foreign keys to `users(id)`.

Converting the already-created tables is impossible: every baseline foreign
key references `users(id)`, and `ALTER TABLE ... CONVERT TO CHARACTER SET`
fails on either side of an incompatible pair (verified empirically —
converting `users` fails with ERROR 3780 on `user_roles_ibfk_1`). Disabling
foreign-key checks is prohibited.

`20260920_00_a_m1_database_collation.sql` therefore runs before the baseline
and sets the database default to `utf8mb4/utf8mb4_unicode_ci`. Every table
created without an explicit charset — baseline and later migrations alike —
is then `utf8mb4_unicode_ci`, matching the explicit tables and their foreign
keys. No historical migration is edited; no foreign-key check is disabled.
The file's SHA-256 is anchored in the reviewed manifest; the generator
refuses to stage it if it changes.

The prelude creates the minimum `lectures` table required by
`20260920_05_instructor_system.sql` before that migration runs. It deliberately
omits `instructor_id`, `price`, and `archived_at`: the instructor migration
adds the first field, while `20260924_instructor_video_exchange.sql` owns the
last two. The later guarded create in `20261017_02_missing_core_tables.sql`
therefore sees the table and skips its fallback. `groups.instructor_id` is
created before `20260925_01_student_tenant_enrollment.sql` uses it.

## Verification status

The staging generator and its tests are hermetic: they use only tracked source
files and temporary filesystem destinations. They do not execute SQL. This
plan has not yet been validated against fresh MySQL; the coordinator owns that
separate integration run. Any additional dependency or DDL failure found there
must be repaired explicitly and documented in the plan before another run.

## Live validation evidence — 2026-10-17 (isolated stack only)

Executed by the WorkBuddy coordinator after two native workers died mid-run
(supervisor-retired claims; this section records the completed evidence):

- **Owned stack** (compose project `m1isoab9b92cae66d4d4daeefe10c6f8ad3`):
  MySQL `mysql:8.0` on `127.0.0.1:13316` (volume
  `m1isoab9b92cae66d4d4daeefe10c6f8ad3_mysql_retry03`, fresh and uniquely
  named; failed retry02 volumes preserved as evidence) and MinIO
  `minio-m1-isolated:RELEASE.2025-10-15T17-29-55Z` on
  `127.0.0.1:19000/19001` — built locally from the pinned official source
  release (upstream commit `9e49d5e7a648f00e26f224f4dc28e6b07f8c84a`, source
  archive sha256 `be6d0bd3696c3a13a35f02d3a0280b64319c67918b4501c5c3d87f96d000085c`).
  No production endpoint, no default DB, no prebuilt release binary.
- **Hash anchoring**: all 33 source migration hashes match
  `server/bootstrap/m1/manifest.json`; the staged collation prelude matches the
  manifest's `databaseCollationSha256`
  (`60c1bf0c55f3bbb1f76cfdcd8d52b3c532be9616952b85f26a8b9caed1925929`); the
  only staged deviation is the documented `groups.instructor_id` ALTER moved
  byte-identically into `20260920_00z_m1_prelude.sql`. No historical migration
  was edited; no foreign-key check disabled.
- **Fresh bootstrap**: MySQL entrypoint logs show zero SQL errors (0/132
  error-ish lines). `tabweb_m1_test` initialized with 93 tables, 9 users,
  2 tenants; `users.id` and `instructor_wallets.instructor_id` collations are
  both `utf8mb4_unicode_ci` (database default `utf8mb4_unicode_ci`) — the
  ERROR 3780 root cause is closed.
- **Seed + API + integration** (`server/scripts/run-m1-isolated-validation.cjs`,
  network guard active, loopback only): seed completed; API healthy on
  `127.0.0.1:3188`; live tenant-isolation integration suite **3/3 passed**
  (`M1 isolated validation completed successfully`).
- **Backup/restore proof** (same owned container, second uniquely named
  database `tabweb_m1_test_restore_proof_01`; source DB never restored over):
  mysqldump 157,810 bytes (sha256 `e996462c8b107e3a…` full value in
  `backup-restore-proof/restore-verification.json`), restored counts match
  source exactly (tables 93=93, users 9=9, tenants 2=2); source
  `tabweb_m1_test` still present and unchanged by the restore.
- **Hermetic regression**: full server suite **1062/1062** from both the
  repository root and the server directory, and `tsc --noEmit` exit 0.

Run the planner tests with:

```powershell
cd server
npx tsx --test tests/m1-bootstrap-plan.test.ts
```
