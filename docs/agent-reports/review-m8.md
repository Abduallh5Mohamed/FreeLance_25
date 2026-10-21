# Security Review — M8: search, tenant export, observability

Task: `m8-security-review-search-export-obs-20261020-01` (read-only; this file is the only write).
Branch: `codex/workbuddy-server`, working tree already dirty from other tasks. No other file was modified.

Scope (all paths relative to the repo root):
`server/src/services/search.ts`, `server/src/routes/search.ts`, `server/src/services/tenant-export.ts`,
`server/src/routes/tenant-export.ts`, `server/src/middleware/request-context.ts`,
`server/src/services/logger.ts`, `server/src/services/metrics.ts`, `server/src/routes/ops.ts`,
`server/migrations/20261018_23_search_export.sql`, plus the schema/write-path files needed to prove or
disprove a claim (`middleware/auth.ts`, `security/admin-permissions.ts`, `security/audit.ts`,
`routes/lectures.ts`, `routes/groups.ts`, `routes/exams.ts`, `routes/student-enrollment.ts`,
migrations `20260920_00`, `20260925_01`, `20261017_01/04/06/08`, `20261018_01/05/08`).

Method: static, line-by-line reading of the current working tree. Every finding below was reproduced by
reading the cited code in this tree; nothing is carried over from another report. No DB, server, Docker,
migration, network call or test run was performed (other workers are writing). A finding without a
current `file:line` was not reported. "Reachable" means the statement is on a path mounted in
`server/src/index.ts` (`/api/search` at :201, `/api/tenant-exports` at :202, `mountObservability` at :157);
mount ordering itself is out of scope and was not reviewed.

Severity is about security impact. Where a finding has no confidentiality/integrity impact I say so and
grade it for correctness/availability, not to inflate it.

## Findings

### High

**H1 — The tenant export silently omits lectures, groups, exams and exam_questions (data completeness)**
`server/src/services/tenant-export.ts:123` (`... FROM lectures WHERE tenant_id = ?`), `:135`
(`FROM \`groups\` WHERE tenant_id = ?`), `:163` (`FROM exams WHERE tenant_id = ?`) and `:167`
(`FROM exam_questions q INNER JOIN exams e ON e.id = q.exam_id WHERE e.tenant_id = ?`).

Those three columns are nullable and are only ever populated by a one-time backfill:
`server/migrations/20261017_04_tenant_columns_backfill.sql:9` (groups), `:42` (lectures), `:75` (exams),
backfilled at `:107`, `:113`, `:121`. No write path sets them afterwards — `routes/lectures.ts:571`,
`routes/groups.ts:328` and `routes/exams.ts:674` insert without `tenant_id`, and there is no trigger
(`grep CREATE TRIGGER server/migrations` → none). Every lecture, group and exam created since that
migration therefore has `tenant_id = NULL`.

Impact: the export returns **zero rows** for those four tables (exams also kills `exam_questions`, which
is joined through `exams.tenant_id`) while the manifest records `rows: 0` as if that were complete
(`tenant-export.ts:478`, `:500-509`). A tenant owner who exports their data gets an archive missing all
current courses' lessons, all groups and all exams, with no warning. This is a correctness/data-portability
defect, **not** a confidentiality leak: NULL rows are dropped, never another tenant's rows, so it fails
closed. Reachable: `POST /api/tenant-exports` (`routes/tenant-export.ts:159-179`).
Fix (in the export, without touching other modules): derive ownership through the tenant-owned parent as
the rest of the codebase does — `lectures INNER JOIN courses c ON c.id = l.course_id WHERE c.tenant_id = ?`
and `groups INNER JOIN courses c ON c.id = g.course_id WHERE c.tenant_id = ?`; for `exams`/`exam_questions`
use the same ownership resolution as the backfill (`exam_groups → groups → courses → tenants`, only when
every group resolves to one tenant) or join `exams.course_id`. Add a hermetic test that asserts each plan
statement constrains on a tenant-owned parent (not on the nullable denormalized column) and a schema
contract test that fails if a planned column disappears.
The durable fix (populate `tenant_id` on write, then `NOT NULL`) spans `routes/lectures.ts`,
`routes/groups.ts`, `routes/exams.ts` and a migration — out of this read-only task's scope; proposed as
follow-up G2 below.

### Medium

**M1 — Student search always returns zero rows: the viewer's enrollment id is compared to `students.user_id`**
`server/src/routes/search.ts:218` returns `studentUserId: row.id` from
`SELECT s.id, s.tenant_id, ... FROM students s` (`:172-180`), i.e. the **enrollment** primary key
(`students.id`, `CHAR(36) DEFAULT (UUID())`, `migrations/20260920_00_legacy_baseline.sql:59`).
`server/src/services/search.ts:348` then binds that value to `AND se.user_id = ?` where `se` is
`students`. `students.user_id` is a different column (`20260925_01_student_tenant_enrollment.sql:5`) and
is generated separately (`routes/student-enrollment.ts:570,573-577`: `studentId = randomUUID()` vs
`userId`). The EXISTS can therefore never match.

Impact: every `role === 'student'` call to `GET /api/search?kind=courses|lessons` returns
`{results: [], total: 0}`, while the announcement path (which does not use the value) still works. Fail
closed — no data leak — but the student half of M8 Q3 is non-functional in production. Reachable:
`GET /api/search` (`routes/search.ts:110-132`). The hermetic tests cannot catch it because they inject
`resolveStudentViewer` (`server/tests/m8-search.test.ts:407,484`); no test exercises the production SQL
at `routes/search.ts:172-180`.
Fix: `SELECT s.id, s.user_id, ...` and return `studentUserId: row.user_id` (keep the field name; the
fragment's contract is a user id). Add a test that runs the production `resolveStudentViewer` against a
fixture where `students.id !== students.user_id` and asserts the bound parameter equals `user_id`.

**M2 — A `pending` export that never finishes blocks the tenant permanently, and the export runs synchronously with no size cap**
`server/src/services/tenant-export.ts:385-392` refuses a new export whenever any row for the tenant is
`status = 'pending'`, and `migrations/20261018_23_search_export.sql:110-116` makes that a database
invariant via `UNIQUE(active_tenant_lock)`. The only code that clears `pending` is the guarded failure
transitions (`tenant-export.ts:328-339`, `:484-488`), which run only if the process is still alive to run
them. The whole export is executed inline in the request (`routes/tenant-export.ts:173`) and materialises
each table fully in memory (`tenant-export.ts:472-481`: `query` → `jsonlOf` → `Buffer.byteLength` →
`storage.write`), with no row/byte cap.

Impact: a crash, OOM or request timeout between the INSERT (`:409-413`) and the completion UPDATE leaves
the row `pending` forever, and that tenant can never start another export (409) — a permanent,
tenant-scoped denial of the feature; a large tenant can also push the shared process into memory pressure
that affects every tenant. Trigger is **not attacker-controlled** (an owner can start an export but cannot
force the crash), so this is graded for availability, not as an exploit. Reachable: `POST /api/tenant-exports`.
Fix: reclaim stale work before the pre-check (`UPDATE ... SET status='failed', error='stale' WHERE
tenant_id=? AND status='pending' AND created_at < UTC_TIMESTAMP() - INTERVAL 15 MINUTE`, guarded, then
re-read), and move the work out of the request (background worker with a per-table row/byte cap and
streamed JSONL). A `pending_started_at`/heartbeat column makes the reclaim precise.

**M3 — Search prefilter amplifies one request into up to 50 unindexable full-scan predicates, with no rate limit**
`server/src/services/search.ts:234-246` adds **one** `AND <normalizedTitleExpr> LIKE ? ESCAPE '!'` per
normalized query token, where `normalizedTitleExpr` (`:205-218`) is
`LOWER(REPLACE(REPLACE(REPLACE(REGEXP_REPLACE(col, '[…]', ''), …))))`. `SEARCH_QUERY_MAX_LENGTH = 100`
(`:48`) permits up to ~50 single-character tokens, and the leading `%` plus the function wrapper means no
index can serve the predicate — the indexes added by
`migrations/20261018_23_search_export.sql:48,64,82` cannot be used for it (they only narrow the scan).
Neither `/api/search` nor the app has a request rate limiter (`server/src/index.ts:201`, no limiter in the
mount chain). Impact: each search is a full scan of the tenant's visible rows with 50 regex/REPLACE chains
per row; an authenticated student or tenant owner can repeat it. Magnitude is **unproven** (no load test
was allowed) — the construction, not the seconds, is what is verified. Reachable: `GET /api/search`.
Fix: cap the token count (`SEARCH_TOKEN_CAP = 8`, ignore the rest) and/or prefilter on a single
`LIKE '%<whole normalized query>%'`-style predicate over a persisted normalized-title column with an index
(prefix or FULLTEXT), as already proposed in `docs/streams/server/SEARCH-RECALL-20261019.md`; add a
per-principal limiter on `/api/search`.

### Low

**L1 — Export authorization and contention denials are not audited, contrary to the module contract**
`services/tenant-export.ts:8-22` and `routes/tenant-export.ts:18-21` state that every request and denial is
audited. Audited today: 503 misconfiguration (`tenant-export.ts:373-381`), request, failure, completion,
token issued, download, download denied. **Not** audited: the 403s from the owner/platform checks
(`routes/tenant-export.ts:118-121`, `:196-198`, `:220-222`, `:252-254`), the 404/410 from
`issueExportDownloadToken` (`services/tenant-export.ts:590-596`) and the 409s for an active export or the
cooldown (`:390-392`, `:399-404`). Impact: cross-tenant IDOR probing against `/api/tenant-exports/:id` and
`:id/download` leaves no trace, and the cooldown/one-active 409s are invisible to operators. No data
exposure. Reachable: every `/api/tenant-exports` route.
Fix: write a `tenant_export.*_denied` audit row with a reason code before each early return (the actor is
known on all of these paths).

**L2 — The signed download token travels in the query string and stays replayable for its full 600 s TTL**
`routes/tenant-export.ts:245` reads `req.query.token`; `services/tenant-export.ts:670-674` accepts any
token whose SHA-256 equals the stored `token_hash` until `x` elapses (`:651`), and `token_hash` is not
cleared after a successful download. Mitigating design property, verified: the token alone is not enough —
the route also requires authentication and `canReadJob` for the job's tenant (`routes/tenant-export.ts:236-254`).
So a token leaked via access logs/Referer only helps an already-authorized caller. Reachable:
`GET /api/tenant-exports/:id/download`.
Fix: accept the token in a header (or a POST body) instead of the query string, and make it single-use by
clearing `token_hash` in the same guarded UPDATE that records the download.

**L3 — The PII export download sets no cache directives**
`routes/tenant-export.ts:262-264` sets only `Content-Type` and `Content-Disposition` before
`res.send(result.body)` — a full tenant PII dump (students' phones, guardian phones, addresses, notes).
`/metrics` does set `no-store` (`routes/ops.ts:175-178`), so the omission is inconsistent rather than
deliberate. Impact: intermediary/browser caching of an export. Reachable: `GET /api/tenant-exports/:id/download`.
Fix: `Cache-Control: no-store`, `Pragma: no-cache`, `X-Content-Type-Options: nosniff`.

**L4 — Logger redaction is key-driven only for phones, and the free-text `message` bypasses redaction entirely**
`server/src/services/logger.ts:248` serialises `message` through `truncateString` only — never through
`redactValue`. `:149-152` masks an email/phone when the **key** matches (`PHONE_KEY_PATTERN`, `:63`) or when
the whole string is an email (`EMAIL_VALUE_PATTERN`, `:65`); there is no phone **value** detector. Impact: a
phone number interpolated into a message, or carried under a neutral key (`note`, `detail`, `guardian`),
is emitted verbatim, which contradicts the module's "masks phone values" description (`:9`). No token
leak was found (keys containing `token`/`secret`/`password` are redacted at any depth, including whole
arrays — `:180`). Reachable: every access-log line (`routes/ops.ts:125-132`).
Fix: run `message` through the same value-level masking (or forbid interpolation and log a fixed event
name), and add a phone-value pattern (e.g. `\+?\d[\d\s()-]{7,}\d`) applied to string values regardless of key.

**L5 — `/readyz` runs an uncached database probe for any unauthenticated caller**
`routes/ops.ts:213-225` executes every configured readiness check per request, and
`createDatabaseReadinessCheck` (`:241-254`) issues `SELECT 1` each time; the router has no auth and no
limiter. Impact: unauthenticated DB load proportional to request rate; impact unproven without a load
test. Reachable: `GET /readyz` (mounted at the app root, `:237`).
Fix: cache the verdict for a few seconds (single in-flight probe), or expose `/readyz` only on the
internal listener / behind the metrics bearer.

**L6 — The ledger migration is not convergent and the ledger has no tenant FK**
`migrations/20261018_23_search_export.sql:99-121` uses `CREATE TABLE IF NOT EXISTS`; if the table exists
without the generated column or `UNIQUE uq_tenant_data_exports_active`, re-running the file silently
succeeds and the "at most one active export per tenant" invariant is simply absent — the service's
duplicate-key mapping (`services/tenant-export.ts:426-429`) then never triggers. The table also has no
`FOREIGN KEY (tenant_id) REFERENCES tenants(id)`, so export rows (and the job ledger entries) can outlive
their tenant. The index steps themselves are correctly guarded (`:41-87`).
Fix: add the column/unique key through `INFORMATION_SCHEMA`-guarded `ALTER TABLE` steps like the index
steps, and add the tenant FK (with the delete policy decided deliberately, e.g. `ON DELETE CASCADE`).

**L7 — Export artifacts are never purged**
`services/tenant-export.ts` only writes (`:477`, `:511`) and reads (`:733`) storage objects; `expires_at`
(`:512`) is enforced on download (`:666-669`) but nothing deletes the job rows or the stored JSONL, and no
retention job exists. Impact: tenant PII (students' phones/guardian phones/addresses/notes, exam answers)
accumulates on disk indefinitely after the 24 h download window closes. Reachable: consequence of
`POST /api/tenant-exports`.
Fix: a scheduled purge that deletes rows past `expires_at + retention` and their storage objects, with an
audit row per purge.

## Observations (not findings)

- `services/search.ts:328-337`: a `branch_id` refinement on `kind=courses` is silently dropped (courses
  have no branch column). The caller gets tenant-wide courses with no signal that the filter was ignored.
  Not a leak; a contract wart worth a 400 or an explicit `branch_applied: false`.
- `routes/search.ts:157-170`: `TENANT_AUTHORITY_SQL` is `UNION ALL … LIMIT 1` with no `ORDER BY`. An owner
  who also holds an `instructor` membership row can be resolved as `instructor` and get a 403 from `:136`.
  Latent and nondeterministic; `ORDER BY (authority = 'owner') DESC` or two separate lookups fixes it.
- `services/search.ts:329-332`: the question-bank branch refinement filters on `qb.branch_id` but not
  `branch_scope`, so a row with `branch_scope='branch'` and `branch_id IS NULL` stays visible under every
  branch filter (within the tenant only).
- `services/tenant-export.ts:512`: `expires_at` is computed from `now()`, while the cooldown reads
  `created_at` (`:393-398`) — a slow export can complete after its own cooldown window has effectively
  started. Cosmetic.

## False positives from `docs/agent-reports/security.md`

`docs/agent-reports/security.md` contains **no** finding about any of the nine files in this scope: its S1-S20
and L1-L10 items are about students, videos, lectures (content routes), groups, grades, meetings, auth,
staff, uploads, CORS, `index.ts`, `db.ts` and socket code. It never audited the M8 search/export/
observability surface, so there is nothing in it to confirm or falsify here — **0 confirmed, 0 false
positives** for this scope. Two of its *global* claims do reach these files and both still hold in the
current tree:
- ":125 No SQL string interpolation of request input found … all other queries are parameterized" — holds
  for search: the only interpolated fragments are constants and column expressions
  (`services/search.ts:205-218,244,339`); every token is a bound parameter and LIKE metacharacters are
  escaped (`:190-191`). It also holds for export: every statement is a constant string
  (`services/tenant-export.ts:116-185`).
- ":124 no hard-coded secrets found in `server/src`" — holds here; the export HMAC secret comes only from
  `process.env.TENANT_EXPORT_SECRET` (`routes/tenant-export.ts:380`).
One adjacent claim should not be inherited by the export: security.md:23 notes `students.password_hash` is
exposed by `SELECT s.*` in `routes/students.ts`. The export deliberately uses explicit column lists and
omits `password_hash` (`services/tenant-export.ts:151`, `:188-195`), so it does not reproduce that defect.

## Checked and clean

1. **Search tenant/branch/visibility gates run in SQL before the cap and before ranking.** Every staff
   source pins `tenant_id` (`services/search.ts:281-303`) or joins the tenant-owned course (`:287-289`);
   the student sources pin tenant + course + `EXISTS` enrollment and `is_published` (`:344-369`). Only
   rows that pass those predicates are loaded, and `toSearchHits` (`:445-461`) scores that set — so
   unpublished or foreign titles are never in memory. Unpublished lessons are excluded for students
   (`:364`) and intentionally visible to the verified owner (`:322-323`).
2. **LIKE/wildcard injection.** `%`, `_` and the escape character itself are escaped (`:190-191`), the
   escape char is a constant (`:57,244`), tokens are bound (`:243`), and hostile input is covered by
   `tests/m8-search.test.ts:210`. No user-controlled string reaches SQL text.
3. **Query/page/candidate caps.** 2..100 chars, page 1..100, limit 1..25, 500-candidate cap, deterministic
   `ORDER BY id`, honest `truncated` flag (`services/search.ts:48-53,139-169,339,393,415,485-499`).
   Array-valued query params are rejected (`:162-165`).
4. **Export authority is derived from server rows, never a token role label.** Owner: `tenants.owner_user_id`
   (`routes/tenant-export.ts:361-368`); platform: `admin_user_roles`/`admin_role_permissions`
   (`:343-359`); the JWT `role` claim is not consulted anywhere on this surface (`:79-123`). A platform
   actor must name an existing active tenant (`:89-111`); an owner is pinned to `req.user.tenantId`
   (`:113-122`). Authentication already enforces liveness, suspension and `token_version`
   (`middleware/auth.ts:151-160`), so the permission lookups do not need to repeat it.
5. **Export content.** Explicit column lists, `students.password_hash` absent, `users`/staff/secret tables
   excluded, no `SELECT *`; every statement pins `tenant_id` or joins a tenant-owned parent
   (`services/tenant-export.ts:116-195`). No token, hash or secret column appears in the plan.
6. **Download token design.** HMAC-SHA256 over `base64url(payload)` bound to `{v,e,t,x}`
   (`services/tenant-export.ts:215-251`); constant-time compare (`:209-213`); expiry from the injected clock
   (`:651`); tenant binding (`:654-656`); job re-read by `(id, tenant_id)` and `status='completed'`
   (`:657-665`); signed export id must equal the URL id (`:701-713`); the persisted hash makes re-issue
   invalidate earlier tokens (`:604-625`, `:670-674`). The secret is `TENANT_EXPORT_SECRET` only — **no
   fallback to `JWT_SECRET`** — and the surface fails closed with 503 below 32 bytes (`:296-297,372-383`).
7. **Storage key traversal.** Keys are `${prefix}/${tenantId}/${exportId}/${table}.jsonl` with
   `tenantId`/`exportId` from the DB row (`services/tenant-export.ts:476,510`); the route param passes
   `normalizeId` (`/^[A-Za-z0-9_-]{1,64}$/`, `services/announcements.ts:36-43`) before any use
   (`routes/tenant-export.ts:188,213,243`); and `LocalTenantExportStorage.resolveKey` enforces
   `root`-prefix containment with `path.resolve` (`routes/tenant-export.ts:326-332`). Three independent
   barriers; no traversal path found.
8. **One-active-export race.** Pre-check (`services/tenant-export.ts:385-392`) plus
   `UNIQUE(active_tenant_lock)` on the generated column (`migrations/20261018_23_search_export.sql:110-116`),
   duplicate key mapped to 409 (`:426-429`), and job INSERT + audit committed together through the
   transaction seam with a guarded compensating transition when the seam is absent (`:408-447`).
9. **Request-id header injection.** Strict pattern, 128-char cap, first-element unwrap, regenerate on
   mismatch (`middleware/request-context.ts:35,59-65`); echoed on the response only after validation
   (`:127`); the tenant id is never read from a header (`:77-80`); re-mounting preserves the id (`:113-129`).
   No CR/LF, quote or comma can round-trip.
10. **Metrics auth and cardinality.** Dedicated bearer, ≥32 bytes, SHA-256 + `timingSafeEqual`, 503 when
    unconfigured, 401 otherwise (`routes/ops.ts:147-173`); the configured token is never logged (`:192`).
    Labels are validated against the declared set and an unexpected label throws
    (`services/metrics.ts:94-104`); the `route` label is the Express template with an `unmatched`
    fallback (`routes/ops.ts:80-89`), `status_class` is bucketed (`services/metrics.ts:326-329`), and
    label values are escaped (`:106-114`). No user-controlled label value reaches the registry.
11. **Health endpoint leakage.** `/healthz` and `/readyz` return a status word only — no dependency names,
    counts, versions or error text (`routes/ops.ts:202-225`).
12. **Logger mechanics.** Depth/array/string bounds, `[Circular]` via a `WeakSet`, `[MaxDepth]`, sensitive
    key substrings that avoid `monkey`/`shipping` false positives, and a redacted preview for oversized
    records (`services/logger.ts:127-137,164-220,259-272`). Tokens/secrets nested under any depth are
    redacted, including a whole array whose key matches (`:180`).
13. **Migration idempotency for the index steps.** `INFORMATION_SCHEMA`-guarded `ADD INDEX` through
    `PREPARE`/`EXECUTE`, no destructive DDL, no data rewrite (`migrations/20261018_23_search_export.sql:41-87`).
    (The `CREATE TABLE` step is covered by L6.)

## Gaps and proposed follow-up tasks

Evidence classes: **code** (read in this tree), **hermetic test** (exists and asserts the property),
**live** (would need a running stack — not attempted), **not implemented**.

| # | Gap | Evidence | Size |
|---|-----|----------|------|
| G1 | Student search binds the enrollment id to `students.user_id`, so student course/lesson search is empty (M1) | code; hermetic tests miss it (they inject the viewer) | S |
| G2 | Export completeness: `lectures`/`groups`/`exams`/`exam_questions` filtered on a nullable, unpopulated `tenant_id` (H1); write paths never set it | code; no schema-contract test | M |
| G3 | Export resilience: no stale-`pending` reclaim, synchronous in-request work, no row/byte cap, no retention purge (M2, L7) | code; not implemented | M |
| G4 | Search recall/performance: no persisted normalized-title column, unindexable LIKE prefilter, no token cap, no rate limit (M3) | code; proposal exists in `docs/streams/server/SEARCH-RECALL-20261019.md` | M |
| G5 | Export audit/transport hygiene: denials unlogged, token in query string, no `no-store` (L1-L3) | code | S |
| G6 | Ledger migration convergence + tenant FK (L6) | code; migration is authoring-only and was not executed | S |

Proposed tasks (paths are suggestions for the supervisor to approve, not claims):
- **G1** `allowedPaths`: `server/src/routes/search.ts`, `server/tests/m8-search.test.ts`,
  `docs/agent-reports/review-m8-fix.md`. No deps. Acceptance: a hermetic test where `students.id !==
  students.user_id` returns the enrolled course/lesson, and a cross-tenant/not-enrolled case still returns
  empty; `tsc --noEmit -p server/tsconfig.json` clean.
- **G2** `allowedPaths`: `server/src/services/tenant-export.ts`, `server/tests/m8-tenant-export.test.ts`,
  `server/src/routes/lectures.ts`, `server/src/routes/groups.ts`, `server/src/routes/exams.ts`, plus one new
  migration (shared path — needs Codex coordination). Deps: none for the export-side fix; the write-path
  `tenant_id` population should land with the migration. Acceptance: export includes a lecture/group/exam
  created through the API; cross-tenant rows still excluded; manifest counts match.
- **G3** `allowedPaths`: `server/src/services/tenant-export.ts`, `server/src/routes/tenant-export.ts`,
  `server/tests/m8-tenant-export.test.ts`, one migration for the retention index. Deps: G2. Acceptance:
  a stale `pending` row is reclaimed to `failed` and a new export is accepted; a purge removes expired rows
  and objects; caps reject an oversized table with a recorded failure instead of OOM.
- **G4** `allowedPaths`: `server/src/services/search.ts`, `server/tests/m8-search.test.ts`, one migration.
  Deps: none. Acceptance: token count capped, a normalized-title index exists and is used (EXPLAIN in the
  isolated validation stack), `truncated` semantics unchanged.

## Limits of this review

- Read-only by task: **no finding was fixed**, so the acceptance line "fixed at root cause" cannot be met
  by this task. H1/M1 need the follow-ups above.
- No code was executed: the H1/M1 defects are proven by schema + write-path reading, not by a query; the
  M2/M3/M5 magnitudes are marked unproven for the same reason.
- `server/src/index.ts` was read only to establish reachability; mount order and the auth guard chain
  around it were not reviewed (out of scope, and being edited concurrently).
- Files outside the nine-module scope were consulted only to prove or disprove a claim about them.

## Commands run

`git status --short`, `git rev-parse --abbrev-ref HEAD`, `ls -la` on the nine files,
`grep`/`sed -n` over `server/src`, `server/migrations`, `server/tests` (all read-only).
No test suite, typecheck, build, server, DB, Docker, migration, package install or network call.
