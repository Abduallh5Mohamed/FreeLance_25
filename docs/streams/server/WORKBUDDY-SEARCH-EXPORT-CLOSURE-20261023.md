# WORKBUDDY — Search / export boundary closure (C-SEARCH-EXPORT)

Task: `server-search-export-boundary-closure-20261023-01`
Batch: `codex-workbuddy-continuation-20261023`
Lane: WorkBuddy (search + export boundary only). Codex keeps `server/src/index.ts`, Claude keeps
schema/migrations. Nothing here touches either.
Date: 2026-10-23.

Status: **source complete, executable verification deferred** (no tests, no typecheck, no DB, no
providers in this task). Every statement below is a claim about the source at the hash given, not
about a running system.

---

## 1. What this delivery is not

Three earlier items are **inherited and preserved unchanged in behaviour**. They were re-read, not
re-implemented, and no edit in this task depends on rewriting them:

| Item | Where | State after this task |
|---|---|---|
| Student identity fix (`s.user_id`, never `s.id`) | `routes/search.ts:272-282` (query), `:327-337` (resolver) | unchanged in meaning; the query gained `DISTINCT` + `LIMIT 2` for ambiguity detection only |
| Eight-token rule, reject-never-truncate | `services/search.ts:77`, `:298-320` | unchanged; a second guard was added in front of it (§3.1) |
| Export included/omitted `incomplete` manifest | `services/tenant-export.ts` `ExportCoverage` | shape unchanged (`complete` still always `false`); contents corrected (§4.1) |

No table was added to `EXPORT_TABLE_PLAN`, no exclusion category was changed, no manifest field was
added or removed, and no storage key shape was changed.

---

## 2. Hashes

Baseline captured before the first write; "after" measured at the end of this task.

| Path | Before (sha256) | Before bytes | After (sha256) | After bytes |
|---|---|---|---|---|
| `server/src/routes/search.ts` | `c583b360f294d51a0b2ac956e80c1693d511b14f5e3791d34d8213cae6a4fceb` | 11 328 | `4055aee27792d83b3d82efd08823cb335cd53b514a4fa8a7af1dadc365ac2eca` | 16 106 |
| `server/src/services/search.ts` | `59d8e0ca8dddb7ac059dfc696d2790539f8199318b982891f72af1c6fcc7ae6e` | 22 766 | `6ec9d497d33e0dc8a7858a5f4547f783c917c7a38d8074e3dd127186cac5c29d` | 25 937 |
| `server/src/routes/tenant-export.ts` | `4f34622ee6ff585b7ee44811d1113cd46527592f5c64e173aa49c9015cd561d1` | 16 327 | `baef4d9c3b5b6052778af8dceadf9eb15a83f4233e4f157594f42fc880baf2af` | 20 069 |
| `server/src/services/tenant-export.ts` | `49d885eec65027196930f2269c84eefdacbd4739586467bbe55a1f7578968378` | 67 720 | `84c65d01cd3039e6d9bd41f35c14d54b606a897854072348580d292c5affe791` | 80 225 |
| `docs/streams/server/WORKBUDDY-SEARCH-EXPORT-CLOSURE-20261023.md` | ABSENT | — | this file | — |

All five paths are in this task's `allowedPaths`. Nothing outside them was written. Line endings
were verified byte-level after the edits (LF throughout, no CRLF introduced); the two files edited
only through the editor tool are LF as well, so the repository convention here is LF and no
whole-file re-encoding occurred.

Structural check performed (comment/string/template-aware delimiter balance, four files): all
balanced. This is a syntax-shape check, **not** a typecheck and not a test run.

---

## 3. Search: defects found and closed

### 3.1 The prefilter accepted a raw query and could silently under-recall

`appendTitlePrefilter` mirrors `normalizeSearchText` inside SQL. Both sides must be fed the same
string. Before this task the parameter was typed and documented as "already folded", but nothing
enforced it: a direct builder caller passing `"أحمد"` produced SQL predicates over the *folded*
titles while `toSearchHits` scored against the *folded* query. Any title that matches after folding
but not before it is then removed by MySQL **before** it is ever scored — a missing result, with no
error and no `truncated` flag. That is the worst failure shape available here.

Now (`services/search.ts:313`): the single choke point every builder passes through refuses a
non-normalized query with `TypeError`. `normalizeSearchText` is idempotent on its own output, so the
route's call path is unaffected; only a misusing caller now fails loudly instead of quietly losing
rows.

### 3.2 Length bounds counted UTF-16 code units

`String#length` counts a surrogate pair twice. The 100 cap therefore meant 50 astral characters, and
the 2-character minimum accepted a single astral character as "2". Bounds are now counted in Unicode
code points (`services/search.ts:203`, used at `:208-214`), so both limits mean what their message
says.

**Policy note, stated explicitly:** a one-code-point query (for example a single emoji) is now
rejected by the existing 2-character minimum, where it previously slipped through as 2 units. This
is the existing policy applied consistently, not a new one; no query is truncated or shortened
anywhere.

### 3.3 Unicode folding is deliberately *not* extended (documented boundary)

`services/search.ts:44-56` now records why `String#normalize('NFKC')` is **not** applied. MySQL has
no NFKC function, so folding presentation forms or full-width characters in JavaScript only would
make the SQL predicate narrower than the JavaScript match and reintroduce exactly the under-recall
of §3.1. Both sides are generated from the same character tables, so the predicate remains a strict
superset and JavaScript still decides the exact match. A compatibility-folded search needs a
persisted normalized column (the existing `SEARCH-RECALL-20261019.md` follow-up), not a one-sided
fold.

### 3.4 An accepted-but-unapplied `branch_id` returned tenant-wide rows

`buildStaffSearchQuery` applies a branch refinement for `lessons`, `announcements` and
`question_bank`. For `kind=courses` it silently ignored `branch_id` — `courses` has no branch column
and no branch-owning parent in its candidate source — so a caller asking for one branch received
every course in the tenant while the request looked scoped.

`services/search.ts:105-109` now declares which kinds support the refinement, and
`routes/search.ts:209-214` answers `400 branch_id is not supported for this search kind` instead of
ignoring the selector. A student viewer gets the same treatment (`routes/search.ts:167-172`): her
branch is derived from her enrollment, so a client-supplied branch is never a selector.

**Behaviour change, deliberate:** a request that previously succeeded with an ignored filter now
fails with 400. Returning unscoped data under a scoped-looking request is the defect; failing closed
is the fix.

### 3.5 Tenant authority was resolved non-deterministically

`TENANT_AUTHORITY_SQL` was `UNION ALL ... LIMIT 1` with no `ORDER BY`. An owner who also holds an
`instructor` membership row could be admitted on one request and denied with 403 on the next,
depending on which branch MySQL produced first. The union is now wrapped and ordered
(`routes/search.ts:243-256`): `ORDER BY (authority = 'owner') DESC LIMIT 1`. The ordering can only
raise the answer to `owner`, never widen it past the two roles the `WHERE` clause already admits.

### 3.6 A student with two enrollments was scoped to an arbitrary branch

`STUDENT_VIEWER_SQL` ended in `LIMIT 1`. A student may hold several active enrollment rows (per
group, or a tenant-wide row plus a branch row); the resolver then returned whichever row came first
and the announcement query was gated on that branch. Concretely: branch-B announcements could be
served to a branch-A viewer, or hidden from a viewer who belongs to both.

Now (`routes/search.ts:257-283`, `:324-336`): `SELECT DISTINCT ... ORDER BY grp.branch_scope,
grp.branch_id LIMIT 2`. Zero rows ⇒ `null` (404, unchanged). Two distinct scope rows ⇒
`StudentScopeAmbiguousError` (code `student_scope_ambiguous`) ⇒ `403` at `routes/search.ts:177-181`.
There is no first-row tie-break; ambiguity is a denial. Rows that differ only in nothing collapse
under `DISTINCT`, so duplicate enrollments in the same scope stay admissible.

### 3.7 Raw driver errors were logged

`console.error('Search error:', error)` printed the driver error object, which carries `sql`,
`sqlMessage` and the bound parameters — i.e. the caller's search terms and tenant identifiers, into
the server log. `routes/search.ts:115-120` logs the label plus `error.code` only (`unclassified`
otherwise); the HTTP body stays the fixed `Failed to run the search`.

### 3.8 Responses were cacheable

Both search and export routers now set `Cache-Control: no-store` for every status code
(`routes/search.ts:127-132`, `routes/tenant-export.ts:204-209`). Search payloads name unpublished
and tenant-private titles; export payloads are personal data.

---

## 4. Export: defects found and closed

### 4.1 The manifest could claim rows the payload did not contain

`readExportTable` counted a row when it was *classified*, then decided whether the page fitted the
remaining byte budget. A page that did not fit was dropped from `body`, but `rows` had already been
incremented for it. The manifest therefore reported `rows: N` next to `bytes`/`checksum` computed
over a shorter payload — a self-contradicting artifact that a consumer verifying `rows × line` would
reject, and that overstated coverage of a truncated table.

Now (`services/tenant-export.ts:1192-1262`): rows are counted only when the chunk is appended;
inspected contradictions are still counted (they are a fact about the read, not about the write);
and the read reports **what** stopped it — `truncatedBy: 'rows' | 'bytes' | null` — instead of a
single boolean. That distinction also fixes the budget classification: previously
`budgetExhausted` required `truncated && remainingBytes <= 0`, so a table truncated because its page
exceeded a *small but non-zero* remainder never marked the budget as spent, and every later table
was read and dropped page by page. Now `truncatedBy === 'bytes'` is the trigger
(`services/tenant-export.ts:1449`).

### 4.2 There was no cancellation, and an abort could have produced a success

`processTenantExport` had no abort seam at all: a client that disconnected mid-export left the
server reading and writing a whole-tenant artifact for a response nobody would receive, and the job
still completed and audited success.

Now:

* `TenantExportDeps.signal?: AbortSignal` (`:186`);
* `abortIfRequested` is checked before every table (`:1412`) and before the manifest is written
  (`:1487`), and inside every page (`:1208`);
* an aborted run writes **no manifest**, records the job as `failed` with the code `aborted`, audits
  `tenant_export.aborted`, and never audits `tenant_export.completed` (`:1554-1563`);
* `routes/tenant-export.ts:117-130` binds the signal to the response lifecycle
  (`res.on('close')` aborts only when `!res.writableEnded`, so a normal finish never aborts), and
  releases the listener in `finally` (`:255`).

Each read is a single awaited statement, so there is no open iterator or cursor to close: aborting
stops issuing work. The storage interface has no streaming method, so nothing is left half-open
there either — a table body is written only after it was fully read and bounded.

### 4.3 Raw driver text was persisted, audited and served

The failure path wrote `error.message` into `tenant_data_exports.error` (1000 chars), into the audit
`newValue`, and — through `coverage.limitations` — into the downloadable manifest. A MySQL error
message embeds the statement and the bound parameters, and an export manifest is an artifact the
tenant owner downloads.

Now the job column, every audit payload and every limitation string carry a **closed code**
(`ExportFailureCode`, `:194-201`):

| Code | Meaning | HTTP (`routes/tenant-export.ts:85-93`) |
|---|---|---|
| `aborted` | caller cancelled | 409 `The export was cancelled` |
| `export_in_progress` | second in-process attempt | 409 `The export is already being processed` |
| `source_unavailable` | plan and schema disagree (missing table/column/db/privilege) | 503 `The export data source is unavailable` |
| `read_failed` | any other read failure | 500 generic |
| `storage_write_failed` | table body or manifest write failed | 503 `The export storage is unavailable` |
| `audit_failed` | completion write committed, audit did not | 500 generic |
| `completion_conflict` | another attempt won the transition | 409 `The export was completed by another attempt` |

`classifyExportFailure` (`:249-261`) maps **only** `ER_NO_SUCH_TABLE`, `ER_BAD_FIELD_ERROR`,
`ER_UNKNOWN_TABLE`, `ER_BAD_DB_ERROR`, `ER_TABLEACCESS_DENIED_ERROR` and errnos
`1049/1054/1109/1142/1146` to `source_unavailable`. Lock waits (`1205`), deadlocks (`1213`) and
duplicate keys (`1062`) are deliberately absent: a lock conflict is transient contention and must
never be reclassified as a missing source. A missing source therefore produces a generic 503, never
an empty successful export.

### 4.4 A losing attempt demoted the winner's row

Two attempts on the same export id both read `pending`, both read tables, and both attempted the
completion CAS. The loser's `UPDATE ... WHERE status='pending'` matched zero rows, it threw a plain
`Error`, and the outer `catch` then ran `UPDATE ... SET status='failed' WHERE status='pending'`
(no match, harmless) **and audited `tenant_export.failed` against a completed export**. The audit
trail claimed a failure for an export that had succeeded.

Now (`:1522-1553`): the CAS loser throws `ExportStateConflictError`, which classifies as
`completion_conflict`; that branch audits `tenant_export.completion_conflict`, does **not** demote
the row and does **not** record a failure. The transition itself now requires exactly one affected
row (`affectedRowsOf(..., 'completion transition') !== 1`, `:1508`) — `undefined` is neither zero
(which would drop a won transition) nor one (which would fabricate one), so it throws instead of
being coerced with `?? 0`. The same rule was applied to token rotation (`:1645`).

### 4.5 In-process attempts were not serialized

`processTenantExport` had no attempt guard, so two concurrent calls in the same process could both
read the same tables and both write the same storage keys. A module-level `IN_FLIGHT_EXPORTS` set
(`:1355`) now rejects a second attempt with `ExportInProgressError` **before** any read, and the id
is released in `finally` (`:1583-1589`).

**Residual, stated rather than hidden (SUPERSEDED by §A.5, 2026-10-23):** across processes the CAS
keeps the *row* correct but the loser can still overwrite the winner's `manifest.json`, because the
storage key is derived from the export id alone. Closing that needs a fencing column on
`tenant_data_exports` — the same I2 request already recorded (§7.1). It was not invented here.

> **Correction (§G.7):** this residual no longer exists. Every key is now
> `{prefix}/{tenantId}/{exportId}/{attemptId}/…` with `attemptId = randomUUID()`, so a loser writes only
> under its own prefix and no row ever references those objects (§A.5). What I2 still buys is
> exclusivity of the *row transitions*, not artifact isolation.

### 4.6 The cooldown measured from the wrong timestamp

`requestTenantExport` compared `now - created_at` of the last completed export against
`EXPORT_COOLDOWN_SECONDS`. A long export could therefore be older than the window at the moment it
finished, letting the next request start immediately after a completion. It now measures from
`completed_at` (falling back to `created_at` for rows completed before that column was populated),
selected by `ORDER BY completed_at DESC, created_at DESC` (`:1091-1106`).

### 4.7 Invalid limits left the tenant blocked forever

`resolveLimits` ran **before** the guarded region. An invalid `deps.limits` threw with the job still
`pending`, and a `pending` row blocks every later request for that tenant behind the one-active
rule. Limits are now resolved inside the guarded region (`:1409`), so the job settles as `failed`
with a code.

### 4.8 The failure path could replace the root cause

If the compensating write or the failure audit threw, the caller saw *that* error instead of the
real one. `bestEffortMarkFailed` / `bestEffortAudit` (`:1361-1388`) swallow only in the failure
path, so the original error always reaches the route. The durable state (`status='failed'` +
code) is what an operator reads; the audit is best-effort by design there, and that trade-off is
stated in the code.

### 4.9 Omission classification was asserted in prose, not enforced

`coverage.omitted` was built by walking the groups; a table listed twice would be counted twice, and
a probe for a table no group names would be executed and then silently dropped. `classifyOmittedTables`
(`:1300-1320`) now builds one `Map`, throws on a duplicate classification and throws on a probe with
no classification, and `buildOmittedCoverage` walks that map. Both invariants are pure constant
checks (no I/O) and run when coverage is built, not at import.

### 4.10 A plan with no ownership proof built invalid SQL

`buildExportPageSql` joins only the authorities whose `owns` is non-null into `WHERE (${owns})`. A
plan whose authorities were all denial-only would emit `WHERE ()` — a syntax error at run time and,
if it ever parsed, an empty table presented as successfully exported. `defineExportPlan` now refuses
such a plan where it is declared (`:363-375`). No current plan is affected.

### 4.11 The audit executor could lose its receiver

`serviceDeps` passed `db.execute` directly to `recordAudit`, which invokes it as a bare function. For
any access object whose `execute` reads `this` (a class-based adapter), the call would run with an
undefined receiver. `routes/tenant-export.ts:76` now passes
`(sql, params) => db.execute(sql, params)`, keeping the binding explicit — the same receiver
discipline applied to the assignment router earlier.

---

## 5. Scope trace, end to end

Principal → tenant → branch → student → parent chain, with the exact predicate that pins each hop.

| Hop | Source | Pinning |
|---|---|---|
| principal | `req.user` after `deps.authenticate` | server-owned; no route reads a role or id from the body/query |
| tenant (owner) | `user.tenantId` | never a client selector; `buildStaffSearchQuery`/`buildStudent*` receive it as the first bound parameter |
| tenant (platform actor) | `tenant_id` from body/query, capability-gated | `hasPlatformPermission(user.id, 'tenant_export.request')`, then `tenants.status='active'` must hold; the actor is *not* an owner and the override is audited |
| branch (staff) | `branch_id` query parameter | pattern-validated, then `EXISTS (SELECT 1 FROM branches br2 WHERE br2.id=? AND br2.tenant_id=? AND br2.status='active')` — a foreign or unknown branch matches nothing; refused outright for kinds that cannot apply it (§3.4) |
| branch (student) | enrollment row | `students.user_id` → `groups.branch_id`, used only when `branch_scope='branch'`; no client input; ambiguous scope denies (§3.6) |
| student identity | `students.user_id` | the enrollment `EXISTS` binds `se.user_id = ? AND se.tenant_id = ?` — `students.id` is never bound into `se.user_id` |
| course/lesson parent | `courses.tenant_id` | `INNER JOIN courses c ... WHERE c.tenant_id = ?` |
| export parent chain | declared `authorities[]` per table | `owns` proves, `conflicts` rejects; a row is exported only when some authority proves the tenant **and** none resolves elsewhere |

Export-specific pins:

* `exportPageParams` pushes the tenant for **every** placeholder of every authority, in the exact
  textual order of `buildExportPageSql` (conflicts, then owning authorities, then cursor, then page
  size). Every parameter except the cursor is the export tenant, so a mis-ordered pin cannot widen
  the scope.
* Omitted-row counts are pinned to a `NOT NULL tenant_id` or to a parent chain whose terminal column
  is `NOT NULL` (`EXPORT_OMITTED_PROBES`, `EXPORT_OMITTED_CHILD_PROBES`), so a count describes this
  tenant's rows and never a global orphan population. Unattributable rows are excluded **and not
  counted**.
* `downloadTenantExport` requires the signed export id to equal the requested id
  (`services/tenant-export.ts` download path) — a valid token for another export of the same tenant
  cannot be replayed.

---

## 6. Boundedness

| Bound | Value | Enforced where |
|---|---|---|
| search query length | 100 code points | `validateSearchQuery` |
| search query tokens | 8, rejected not truncated | `validateSearchQuery`, `appendTitlePrefilter` |
| search page size / page | 25 / 100 | `parseSearchPagination` |
| search candidates | 500, `ORDER BY <id> ASC` | every builder |
| export page | 500 rows (max 10 000) | `resolveLimits`, `LIMIT ?` |
| export rows per table | 50 000 | `readExportTable` |
| export total bytes | 64 MiB | shared `budget.remainingBytes` |

Peak memory per table is `O(min(table, remaining budget))` plus one page: the JSONL body is
assembled page by page and a page that does not fit is dropped, not buffered. The whole tenant is
never materialised. `truncated` on a search result is a lower bound, not a total; `coverage.complete`
is always `false` and `incomplete` is explicit — there is no path that presents a partial extract as
a complete one.

---

## 7. Held dependencies, raised precisely

### 7.1 I2 — fencing on `tenant_data_exports` (blocks cross-process attempt safety)

> **Superseded twice — read §C.9 and §G.8 instead.** The DDL below was the first draft of the request
> and does **not** match the statements the service now binds. The canonical contract is
> `export_owner` / `owner_epoch` / `owner_lease_until_ms` (§C.9), which is exactly what
> `OWNERSHIP_CLAIM_SQL`, `OWNERSHIP_FAILURE_SQL`, `OWNERSHIP_ABORT_SQL`, `OWNERSHIP_RELEASE_SQL`,
> `OWNERSHIP_RENEW_SQL`, `OWNERSHIP_READ_EPOCH_SQL` and the completion CAS reference. The
> `active_tenant_lock` column and the `uq_tenant_export_active` key below are the *separate* one-active
> guarantee already delivered by migration 20261018_23, not part of the ownership fence.

```sql
ALTER TABLE tenant_data_exports
    ADD COLUMN claim_owner     VARCHAR(64)  NULL,
    ADD COLUMN claim_lease_until_ms BIGINT  NULL,
    ADD COLUMN claim_version   INT          NOT NULL DEFAULT 0,
    ADD COLUMN active_tenant_lock VARCHAR(64) AS (...) STORED,
    ADD UNIQUE KEY uq_tenant_export_active (active_tenant_lock);
```

Required semantics (same discipline as the assignment cleanup claim): claim = `owner +
claim_version + lease` CAS; a lost CAS must halt the attempt, not retry; `pending` is reclaimable
only after `claim_lease_until_ms`; the completion transition is fenced on `claim_owner` and
`claim_version`. Until this lands, `IN_FLIGHT_EXPORTS` covers one process and the CAS keeps the row
correct. The manifest object is **not** clobberable by a second process: every key carries its own
attempt id (§A.5, §G.4), so what I2 still buys is row-transition exclusivity, not artifact isolation.

### 7.2 Separate job contract (not implemented here, not needed for correctness today)

The export runs inline in the request. If it must become a durable job, the contract is:

```
POST /tenant-exports            -> 202 { id, status: 'pending' }        (no body, no manifest)
GET  /tenant-exports/:id        -> { id, status: 'pending'|'running'|'completed'|'failed',
                                     progress: { table, tables_done, tables_total, rows, bytes },
                                     error: ExportFailureCode | null }
POST /tenant-exports/:id/cancel -> 202 { status: 'cancelling' }         (sets the same signal)
```

with `processTenantExport` taking an external `signal` (already supported), a resumable per-table
cursor persisted next to the job (needs 7.1), and the manifest written only by the attempt that won
the completion CAS. Nothing in the current source blocks this shape; it is deliberately not
implemented because it needs the schema in 7.1.

### 7.3 `assignment_submissions` has only a direct tenant authority

Rows whose `tenant_id` is NULL (created before the 2026-10-17 backfill) are excluded even though
their parent assignment could prove the tenant. The exact patch is one authority:

```ts
parentTenantAuthority('pa', 'assignments.id = assignment_submissions.assignment_id')
```

plus `LEFT JOIN assignments pa ON pa.id = t.assignment_id` in `from`. It is **not** applied: it
changes the declared export set and `coverage.included[].authorities`, which is an owner decision
(the same rule that kept the plan from being extended with new tables). Recorded here as a declared
gap, not as an unmet criterion of this task.

### 7.4 NFKC search folding

Needs a persisted normalized-title column plus index (see §3.3). Not a source-only change.

---

## 8. What is still unverified

* No test was run and no test was edited; no typecheck was run; no SQL was executed; no DB, storage
  provider, listener or secret was touched; no Git operation was performed.
* Delimiter balance is a shape check. It cannot catch a type error, an arity mismatch or a wrong
  property name; the compile step is Codex's.
* `res.on('close')` abort semantics are asserted from the Node/Express contract, not observed. The
  guard `!res.writableEnded` is what keeps a normal finish from aborting.
* The `StudentScopeAmbiguousError` path changes one behaviour: a student with mixed-scope active
  enrollments now receives 403 instead of an arbitrary branch scope. That is intentional and is the
  only case where the resolver stops returning a viewer.
* Existing tests that assert the exact `coverage.limitations` array or the `manifest.json` byte
  content will need the two new limitation lines; existing tests that assert the resolver is called
  once per request are unaffected.

---

## 9. Acceptance asks

1. Confirm the four `allowedPaths` files are the only source changes (§2).
2. Confirm the behaviour changes in §3.4 (400 on an inapplicable `branch_id`) and §3.6 (403 on
   ambiguous student scope) are accepted as boundary fixes rather than regressions.
3. Accept or reject §7.1 as the next schema request; §4.5's residual depends on it.
4. Decide §7.3 (assignment_submissions parent authority) as an export-scope owner decision.

---

# ADDENDUM 2026-10-23 — attempt isolation correction

Task: `server-export-attempt-isolation-correction-20261023-01`. This is a **followup on the delivered
source**, not a rerun: the search half and the read/coverage half of the export are untouched by this
addendum. Only the attempt-isolation, compensation and cancellation behaviour changed.

Files changed in this addendum: `server/src/services/tenant-export.ts`,
`server/src/routes/tenant-export.ts`. `routes/search.ts` and `services/search.ts` are **byte-identical**
to the previous delivery (hashes in §A.2) and were deliberately not reopened.

## A.1 What was wrong

Two defects, both in the attempt-isolation layer, both confirmed by reading the delivered bodies.

**A.1.1 A compensation that could demote a completed winner.** `runTenantExport` set
`transitioned = true` immediately after the CAS matched one row, then ran the audit inside the same
transaction callback. When the audit threw, the `catch` called `failJobAfterAuditFailure`, whose
predicate was `status IN ('pending', 'completed')`. That predicate is the defect:

- With a transaction seam the rollback leaves the row `pending`, so the compensation matched its own
  row — correct but accidental.
- The moment the commit outcome is not the caller's to know (a COMMIT failure, a dropped connection
  after commit), the row may be `completed`; the compensation then demoted it, and if another attempt
  had completed the same id in the meantime it demoted **that** attempt's winner.
- The compensation could not distinguish "my uncommitted row" from "someone else's committed row",
  because `tenant_data_exports` has no attempt or fencing column. Any predicate wide enough to cover
  the ambiguous case is wide enough to hit a row this call never owned.

The same shape existed on the request path: `inserted && !deps.db.transaction` compensated with
`failPendingJob` after an autocommit INSERT, i.e. an autocommit sequence patched by extra UPDATEs.

**A.1.2 A deterministic object namespace.** Table and manifest keys were
`{prefix}/{tenantId}/{exportId}/{table}.jsonl` and `{prefix}/{tenantId}/{exportId}/manifest.json`.
Two attempts racing the same export id therefore wrote the same keys, and a losing attempt wrote
them **before** its CAS — so the winner's already-published bytes could be overwritten by the loser
while the winner's row still pointed at that key.

## A.2 Hashes

| Path | Before this addendum | After this addendum |
|---|---|---|
| `server/src/routes/search.ts` | `4055aee27792d83b3d82efd08823cb335cd53b514a4fa8a7af1dadc365ac2eca` (16 106) | **unchanged, byte-identical** |
| `server/src/services/search.ts` | `6ec9d497d33e0dc8a7858a5f4547f783c917c7a38d8074e3dd127186cac5c29d` (25 937) | **unchanged, byte-identical** |
| `server/src/routes/tenant-export.ts` | `baef4d9c3b5b6052778af8dceadf9eb15a83f4233e4f157594f42fc880baf2af` (20 069) | `18d3a5188baca84e36c408ffbddfa561a042f5be96963f704b619660072c3745` (20 476) |
| `server/src/services/tenant-export.ts` | `84c65d01cd3039e6d9bd41f35c14d54b606a897854072348580d292c5affe791` (80 225) | `f06b20c89b998fe164347a405108fa72de3fc02279e0f515426226b5f5ddbef4` (87 037) |

`failPendingJob` and `failJobAfterAuditFailure` no longer exist in the file; `errorMessage` and the
`inserted`/`transitioned` flags were removed with them.

## A.3 The compensation contract, restated

Every row-mutating statement in the module now uses one predicate:

```sql
WHERE id = ? AND tenant_id = ? AND status = 'pending'
```

`bestEffortMarkFailed` (`:1413`) is the only failure-path row write. It **cannot** demote a completed
row, so a concurrent winner survives any failure this attempt suffers afterwards. When the row has
moved on, the statement matches nothing and that is the correct outcome.

> **Superseded by §C.2/§C.3 and §B.2 (2026-10-23), restated in §G.7.** The predicate above is no
> longer what the module uses, and `bestEffortMarkFailed` no longer exists. Every row-mutating
> attempt transition now carries the four-term fence
> `export_owner = ? AND owner_epoch = ? AND owner_lease_until_ms > ? AND status = 'pending'` plus the
> `id`/`tenant_id` pins, and the only failure-path row write is the fenced statement returned by
> `ownership.failureStatement(...)` inside `recordOwnedFailure`. The claim's own predicate is a
> *different* statement by necessity: it installs owner, epoch and lease, and matches only an unowned
> or lapsed row.

`inTransaction` (`:1060`) no longer falls back to autocommit: a caller without the seam gets
`ExportTransactionCapabilityError` (`:248`) **before anything is written**. `requestTenantExport`
refuses at `:1111` before a job row exists, so a tenant is never left with a pending job that cannot
be completed atomically, and `runTenantExport` re-checks at `:1451` before its first read.

## A.4 Ambiguous commit is a distinct outcome, not a guess

Two flags replace the single `transitioned` (`:1583-1584`):

| Flag | Set when | Meaning |
|---|---|---|
| `statusWritten` | the CAS matched exactly one row | the transition happened inside the transaction |
| `callbackFinished` | the audit also returned | the callback ran to completion; only the wrapper can have failed |

- `callbackFinished` true and the wrapper threw ⇒ the COMMIT outcome is unknowable. **No row write,
  no failed/completed audit.** `ExportCompletionUnknownError` (`:264`) → code `completion_unknown` →
  audit `tenant_export.completion_unknown` only (`:1634-1647`). The row is either pending or
  completed and the caller must read it back.
- `statusWritten` true, `callbackFinished` false ⇒ deterministic rollback. The outer failure path
  settles the row with the pending-only predicate and audits `tenant_export.failed` with
  `audit_failed`. There is no second, wider compensation.
- `statusWritten` false ⇒ the CAS lost (`completion_conflict`) or the row never moved; audit only.

## A.5 Per-attempt artifact namespace

`{prefix}/{tenantId}/{exportId}/{attemptId}/{table}.jsonl` and
`{prefix}/{tenantId}/{exportId}/{attemptId}/manifest.json`, with `attemptId = randomUUID()`
(`:1475`). Three properties matter:

1. **The attempt id is server-owned, not `deps.newId`.** `newId` is the caller's job-id generator;
   an injected deterministic generator would hand every attempt the same namespace and silently
   restore the collision. Using `randomUUID()` directly removes that.
2. **Only the winner's pointer is persisted.** `storage_key` is written by the CAS inside the same
   transaction as the audit, so it can only ever name the manifest of the attempt that won. A loser's
   namespace stays unreferenced.
3. **Nothing is deleted.** No purge, no cross-attempt deletion, and no ownership inferred from
   `IN_FLIGHT_EXPORTS` — `claimLocalAttempt` (`:1404`) is documented as a local work guard, explicitly
   not fencing, because another process has no knowledge of the Set.

**Download semantics are unchanged.** `downloadTenantExport` reads `job.storage_key` and nothing else
reads a table object: a grep for `.jsonl`/`manifest.json` across `server/src` returns only the two
writes in this module and the `jsonlOf` helper. The manifest JSON is byte-for-byte the same format;
only the storage key path changed. No manifest-format change was needed or made.

**Cost, stated:** unreferenced attempt namespaces accumulate. Cleaning them needs an owner decision
(a retention/purge policy) and is deliberately not implemented here.

## A.6 Cancellation and the publication point

The honest linearization point is the **COMMIT of the row transition**, not a signal check.

- The pre-manifest `abortIfRequested` (`:1561`) is the last point at which an abort can prevent
  publication. It is now documented as exactly that, and the code no longer implies that an abort
  leaves no bytes: table artifacts already written are orphans under this attempt's namespace,
  referenced by no row, and never advertised as downloadable.
- An abort that loses the race does **not** retract a published export. Once the manifest is written
  and the CAS commits, the function returns the manifest as completed; there is no post-commit abort
  check that would report a cancellation for an export the client can download.
- The omission-probe loops are now bounded by the same signal (`:1380`, and the omitted-group loop at
  `:1362` via `buildOmittedCoverage`'s new `signal` parameter), so a cancelled export stops issuing
  statements instead of finishing every probe.

## A.7 Every failure path, enumerated

| # | Failure | Code | Row write | Audit |
|---|---|---|---|---|
| 1 | no transaction seam (request) | `transaction-capability-absent` | none — refused before the job exists | `request_denied` |
| 2 | no transaction seam (process) | `transaction-capability-absent` | none — refused before the first read | `failed` |
| 3 | invalid limits | `read_failed` | pending-only | `failed` |
| 4 | abort in the table loop | `aborted` | pending-only | `aborted` |
| 5 | read/paging/unclassified row | `read_failed` | pending-only | `failed` |
| 6 | storage write (table or manifest) | `storage_write_failed` | pending-only | `failed` |
| 7 | abort in a probe loop | `aborted` | pending-only | `aborted` |
| 8 | abort before the manifest write | `aborted` | pending-only | `aborted` |
| 9 | CAS lost | `completion_conflict` | **none** | `completion_conflict` |
| 10 | audit threw inside the callback | `audit_failed` | pending-only | `failed` |
| 11 | ambiguous commit | `completion_unknown` | **none** | `completion_unknown` |
| 12 | compensating write/audit throws | — | swallowed | swallowed |

Rows 9 and 11 are the two that must never touch the row, and they no longer do.

> **Correction (§G.7):** "pending-only" in this table now means the fenced transition
> (`owner + epoch + live lease + pending`), not a bare `status = 'pending'` predicate, and the table's
> audit column is out of date in one row: row 2 (no transaction seam at process time) writes **no**
> row and audits `tenant_export.ownership_unproven`, not `tenant_export.failed` — a `failed` audit
> would assert a job state this call never established. Rows 3–8 and 10 are the rows that still move
> exactly one fenced row and audit `tenant_export.failed` / `tenant_export.aborted` in the same
> transaction; row 12 is gone (no compensating write exists anywhere).

`issueExportDownloadToken` was examined and left as-is: it uses the same required-seam
`inTransaction`, its only row write is the token rotation guarded by the same CAS, and a failed
rotation rolls back with the transaction so no token is ever returned for an uncommitted hash. Its
`rotated` flag has no downstream compensation to remove.

## A.8 Held dependencies (unchanged from §7, restated for this addendum)

- **I2 fencing on `tenant_data_exports`** is still required for cross-process attempt safety. The
  per-attempt namespace removes the *artifact* overwrite; it does not make two processes' row
  transitions exclusive. Until I2 lands, the CAS decides the winner and a loser never demotes it, but
  two processes can still both spend the read budget on the same id.
- **Orphan namespace retention/purge** needs an owner decision; not implemented.
- The `202/status/cancel` job contract remains a request, not authorized API scope.
- `assignment_submissions` parent authority remains out of scope by instruction.

## A.9 Not verified

No test was run or edited, no typecheck, no SQL/DB/storage/provider/secret, no Git. Delimiter balance
on the two changed files is a shape check only. The transaction-seam requirement is a **behaviour
change for hermetic callers without a seam**: they now receive `transaction-capability-absent` (503)
instead of the previous autocommit path. The production route wiring provides the seam, so production
behaviour is unchanged; tests that inject a seam-less `db` will need it added.

## A.10 Acceptance asks

1. Confirm rows 9 and 11 (no row write, audit-only) are the intended contract for conflict and
   ambiguous commit.
2. Confirm the transaction seam is required for the whole export surface (request + process), not
   only the completion transition.
3. Decide the orphan-namespace retention policy, or accept accumulation as the current behaviour.
4. Accept or reject I2 as the next schema request; cross-process row exclusivity depends on it.

---

# ADDENDUM 2 — 2026-10-23 — owned failure transition

Task: `server-export-owned-failure-transition-correction-20261023-01`. Third followup on the export
surface. The two search files are again byte-identical and untouched. The attempt-isolation fixes of
ADDENDUM 1 are preserved verbatim: `randomUUID()` attempt namespace, mandatory transaction seam,
two-flag ambiguous-commit handling.

## B.1 The two confirmed remaining paths

**B.1.1 `bestEffortMarkFailed` updated any matching pending row, with no owner proof.**
Its predicate was `WHERE id = ? AND tenant_id = ? AND status = 'pending'`. `status = 'pending'` is not
ownership — it is the state another attempt is standing in. Trace **A-fails / B-running**: A fails on
a read, B is concurrently processing the same export id and the row is still `pending`. A's UPDATE
matched that row and set `status='failed', error=<A's code>`. B's completion CAS
(`WHERE status='pending'`) then matched zero rows, so B — the legitimately active attempt — was
demoted to `completion_conflict` by a failure that was never B's. A made B lose its completion
without ever holding the row.

**B.1.2 The outer catch emitted a terminal audit even when the UPDATE changed zero rows.**
`bestEffortMarkFailed` ignored its affected-row count entirely (it was wrapped in a bare `catch`),
and the catch then emitted `tenant_export.failed` / `tenant_export.aborted` unconditionally. Trace
**A-fails / B-completed**: B has already committed the completion; A now fails, its pending-only
UPDATE matches zero rows, and A still writes `tenant_export.failed` with
`reason: 'Tenant data export failed'`. The audit asserts a final state that is false — the job is
completed and downloadable — and it is attributed to a call that changed nothing.

## B.2 The fix: ownership is a fenced transition, not a state

`bestEffortMarkFailed` is **deleted** (grep-verified: zero matches). There is no unowned failure path
left. The canonical predicate, exported as a constant:

```ts
export const EXPORT_OWNERSHIP_OWNED_PREDICATE =
    "export_owner = ? AND owner_epoch = ? AND status = 'pending'";
```

`status = 'pending'` alone can never justify a write again. `export_owner` proves *who*, `owner_epoch`
fences a stale writer, and both are re-checked in the same statement that changes the row.

`recordOwnedFailure` executes the port's fenced statement **and** its terminal audit inside one
transaction, and requires exactly one affected row:

- exactly 1 ⇒ the terminal `failed`/`aborted` audit is committed *with* the state change. A terminal
  audit therefore cannot exist without the proven transition beside it.
- 0 ⇒ `ExportOwnershipLostError` ⇒ outcome `ownership_lost` ⇒ non-terminal audit only.
- the audit throws ⇒ the whole transaction rolls back ⇒ outcome `uncommitted` ⇒ non-terminal audit
  only.
- more than 1 ⇒ `affectedRowsOf` refuses it: a non-selective predicate is not trusted at all.

## B.3 Durable ownership is required and injected, never assumed

`requireOwnershipCapability` checks three things in order: the port object exists; it exposes
`claim` / `failureStatement` / `describe`; and `describe()` returns exactly
`EXPORT_OWNERSHIP_OWNED_PREDICATE` plus every entry of `EXPORT_OWNERSHIP_REQUIRED_COLUMNS`
(`export_owner`, `owner_epoch`, `owner_lease_until_ms`). The third check is what raises this above
"function presence" — a placeholder that returns grants without enforcing the columns has nothing
true to declare.

The owner identity is `randomUUID()`, generated inside `runTenantExport`, never taken from a request,
header, body field or the caller's id generator. An arbitrary client owner would let any caller
assert ownership of any tenant's row.

Fail-closed points, all **before** side effects:

| Entry point | Check | Effect when absent |
|---|---|---|
| `requestTenantExport` | capability + transaction seam | audited `request_denied`, 503, **no job row created** |
| `processTenantExport` | capability | throws before the job is even read |
| `runTenantExport` | capability + seam | throws before the first read and the first storage write |

What this cannot check is whether an injected port's statements really hit those columns — that is
inherent to a seam. Which is exactly why the DDL goes to the schema owner (§B.6) instead of being
invented here.

## B.4 Static source trace (reasoning, NOT executed tests)

No test was run. These are traces of the delivered source, read line by line.

| # | Scenario | Path | Row write | Audit |
|---|---|---|---|---|
| 1 | **A fails / B running** | A never obtained a grant (B holds the claim, or A's claim lost) ⇒ `grant === null` ⇒ `ExportOwnershipLostError` | **none** | `tenant_export.ownership_unproven` |
| 2 | **A fails / B completed** | A holds a stale grant; fenced `export_owner = A AND owner_epoch = e AND status='pending'` matches 0 (row is `completed`) | **none** | `tenant_export.ownership_lost` |
| 3 | **CAS 0** | completion CAS matched 0 ⇒ `ExportStateConflictError` ⇒ `completion_conflict` | **none** | `tenant_export.completion_conflict` |
| 4 | **Audit throws** (completion tx) | rollback ⇒ `statusWritten` true, `callbackFinished` false ⇒ `audit_failed`; grant held ⇒ fenced failure transition, exactly 1 | `failed` + `error='audit_failed'` | `tenant_export.failed`, **inside the same transaction** |
| 5 | **Commit unknown** | `callbackFinished` true, wrapper threw ⇒ `ExportCompletionUnknownError` | **none** | `tenant_export.completion_unknown` |
| 6 | **Abort** | `abortIfRequested` ⇒ `aborted`; grant held ⇒ fenced transition, exactly 1 | `failed` + `error='aborted'` | `tenant_export.aborted`, same transaction |
| 7 | **Owned failure audit throws** | fenced UPDATE matched 1, audit threw ⇒ rollback ⇒ `uncommitted` | **none** (row back to `pending`) | `tenant_export.failure_transition_uncommitted` |

Rows 1, 2, 3, 5, 7 assert nothing about the job's final state. Only rows 4 and 6 do, and only with
the state change committed beside the audit in one transaction.

## B.5 Consequence, stated plainly

The production router passes `ownership: undefined` and says so in a comment. The port must enforce
fencing against columns that do not exist yet, and injecting a placeholder would be precisely the
"truthy capability" the service refuses. **The export surface is therefore inert in production by
design** — `requestTenantExport` returns an audited 503 before creating a job row — until a real port
is supplied against the I2 columns. This is the same "correct in source, inert until the schema
lands" posture the rest of this lane uses, and it is a deliberate fail-closed, not an accident.

## B.6 Exact I2 contract for the schema owner

```sql
ALTER TABLE tenant_data_exports
    ADD COLUMN export_owner          VARCHAR(64) NULL,
    ADD COLUMN owner_epoch           INT         NOT NULL DEFAULT 0,
    ADD COLUMN owner_lease_until_ms  BIGINT      NULL;
```

Claim (must return exactly one row and the new epoch; `owner_lease_until_ms` may be NULL only for
rows never claimed):

```sql
UPDATE tenant_data_exports
SET export_owner = ?, owner_epoch = owner_epoch + 1, owner_lease_until_ms = ?
WHERE id = ? AND tenant_id = ? AND status = 'pending'
  AND (export_owner IS NULL OR owner_lease_until_ms <= ?);
```

Owned failure (the statement `failureStatement` builds; the caller requires exactly one row):

```sql
UPDATE tenant_data_exports
SET status = 'failed', error = ?
WHERE id = ? AND tenant_id = ? AND export_owner = ? AND owner_epoch = ? AND status = 'pending';
```

Index for the claim scan (optional, only if the table grows): `(tenant_id, status,
owner_lease_until_ms)`. No table, no new file, no migration is written by this task.

## B.7 Preserved

Attempt namespace (`randomUUID`, not `deps.newId`); mandatory transaction; two-flag ambiguous
commit; per-attempt artifact isolation with no purge; both search files byte-identical; exported
table set unchanged; no parent-authority expansion; no new HTTP job API; generic errors, bounded
reads, incomplete manifest.

## B.8 Not verified

No tests, no typecheck, no SQL/DB/storage/provider/secret, no Git. Delimiter balance on both changed
files is a shape check only. The I2 statements above are a **request**, not executed DDL. Every row
of §B.4 is static reasoning about the delivered source, not an executed test.

---

# ADDENDUM 3 — 2026-10-23 — complete fencing source closure

Task: `server-export-complete-fencing-source-closure-20261023-01`. Prior source explicitly NOT
accepted. Both search files byte-identical again; ADDENDUM 1 and 2 preserved.

## C.1 The syntax defect

`buildOmittedCoverage` was declared:

```ts
const buildOmittedCoverage = async (
    db: TenantExportDataAccess,
    tenantId: string,
    signal: AbortSignal | undefined,
): Promise<{ ... }> {          // <-- missing `=>`
```

Line 1545 now reads `): Promise<{ ... }> => {`. This is a **parse error**, not a type error: the
declaration is not an arrow function at all.

The delimiter-balance checker used in ADDENDUM 1 and 2 could not see it. It treats `{` as an opening
brace and the function body's own braces happen to balance it, so the file reported "balanced" while
being uncompilable. **Delimiter balance is not compilation, and this addendum does not present it as
such.** A separate audit was added for this delivery: every `const X = async (` / `const X = (`
declaration in the file is scanned forward to its `):` line and must end in `=> {`. Result: 0
problems across all declarations.

## C.2 The completion UPDATE was still unfenced

The predicate was `WHERE id = ? AND status = 'pending' AND tenant_id = ?` — no owner, no epoch, no
lease. Trace **stale A / new B**: A claims the row, its 5-minute lease lapses while A is still
running, B claims the row (epoch bumped, new lease), and A reaches its completion. A's UPDATE matched
`status='pending'` and completed **B's** job with A's artifacts. A had owner proof *before* the
writes and none *at* the write.

Now the completion UPDATE carries the full fence, evaluated by the database in that one statement:

```sql
WHERE id = ? AND tenant_id = ? AND status = 'pending'
  AND export_owner = ? AND owner_epoch = ? AND owner_lease_until_ms > ?
```

A whose lease has lapsed cannot complete the row B now owns. Exactly one row must move
(`affectedRowsOf(...) !== 1` ⇒ `ExportStateConflictError`), inside the sealed transaction with the
audit.

## C.3 The canonical predicate had no lease term

`EXPORT_OWNERSHIP_OWNED_PREDICATE` was
`export_owner = ? AND owner_epoch = ? AND status = 'pending'`. Owner without a live lease is not
ownership — it is a stale claim. It is now:

```
export_owner = ? AND owner_epoch = ? AND owner_lease_until_ms > ? AND status = 'pending'
```

`ExportOwnershipFailureInput` and the new `ExportOwnershipReleaseInput` both carry `nowMs`, and
`failureStatement`/`releaseStatement` bind it into the lease term. Previously the failure input
omitted `now`/lease entirely, so a fenced failure statement could not have checked liveness even if
the predicate had contained the term.

Every ownership-sensitive mutation in the file now carries all four terms plus the tenant pin
(audited by script, see §C.7): claim, failure, abort, release, completion.

## C.4 `describe()` is a declaration, and is now labelled as one

The previous addendum claimed a placeholder "cannot pass" the contract check. That was wrong: a
placeholder can declare the right strings and run something else, and `requireOwnershipCapability`
cannot see the statements it will execute. The claim is removed from the code and from this document.

What the check does establish: the port exists, exposes the four operations, and declares exactly the
canonical predicate and every required column. That is a contract check. It is not enforcement
evidence, and it is not called that any more.

To make the contract concrete rather than declarative, `createSqlExportOwnershipPort` is now provided
**inside the existing service file** (no new file). Its SQL is fixed text with bound parameters only —
no identifier, operator or predicate is assembled from caller input — and every statement carries the
full fence. The port is exported for review and injection; it is **not executed here**, and the
production router still passes `ownership: undefined`, now with a comment explaining that wiring the
real adapter against a schema lacking the columns would turn every request into a schema fault
instead of a clear "not configured".

The claim's epoch is read back through a declared `query` seam on the claim executor, inside the same
transaction, still fenced by owner + live lease + `status='pending'`. An unreadable epoch throws
`ExportOwnershipCapabilityError`; it is never guessed.

## C.5 Lease loss is attempt evidence, never job success or failure

The failure path already produced only non-terminal audits on ownership loss. The completion side is
now the same: a lapsed lease makes the completion UPDATE match zero rows, which is
`ExportStateConflictError` ⇒ `completion_conflict` ⇒ audit-only, no row write. The job is left for
whoever holds it.

Clocks are captured once per transition (`captureTransitionClock`) and reused by every lease term in
that transition, so two statements in one transition cannot disagree about liveness. A non-finite or
unsafe-integer reading throws rather than coercing into "the lease is still valid".

## C.6 Failure commit uncertainty is now distinguished, not relabelled

`recordOwnedFailure` previously returned `'uncommitted'` for every non-recorded outcome. That label is
untruthful for one case: the callback can finish (write moved one row, audit returned) and the
wrapper can then throw on COMMIT — in which case the terminal audit may or may not exist. Four
outcomes now:

| Outcome | Meaning | Terminal audit? |
|---|---|---|
| `recorded` | fenced write moved exactly one row AND the audit committed | **yes**, inside the same transaction |
| `ownership_lost` | fenced write moved zero rows | no |
| `audit_rolled_back` | write moved one row, audit threw, whole transaction rolled back — row back to `pending`, still owned | no |
| `commit_unknown` | callback finished, wrapper threw — COMMIT outcome unknowable | **unknown**, and not claimed either way |

`commit_unknown` is never relabelled `uncommitted`. The audit action is
`tenant_export.failure_commit_unknown`, distinct from
`tenant_export.failure_audit_rolled_back`. No later terminal compensation exists on any path.

## C.7 Source review — all transition predicates

| Transition | Line | owner | epoch | live lease | state | tenant |
|---|---|---|---|---|---|---|
| Claim | 1689 | ✓ | ✓ (increment) | ✓ (install) | `pending` | ✓ |
| Failure | 1697 | ✓ | ✓ | ✓ | `pending` | ✓ |
| Abort | 1705 | ✓ | ✓ | ✓ | `pending` | ✓ |
| Release | 1717 | ✓ | ✓ | ✓ | `pending` | ✓ |
| Completion | 2106 | ✓ | ✓ | ✓ | `pending` | ✓ |

The download-token rotation (2338) is not an attempt-lifecycle transition: it mutates `token_hash` on a
row already `completed`, so it has no ownership-sensitive state to fence. It was reviewed and left as
it was.

## C.8 Scenario traces (static reasoning, not executed tests)

| # | Scenario | Outcome |
|---|---|---|
| 1 | **stale A / new B** | A's lease lapsed; B claimed (epoch bumped). A's completion UPDATE matches 0 rows (lease dead) ⇒ `completion_conflict`, audit-only, **A cannot complete B's job**. B completes with its own artifacts. |
| 2 | **expired A / no B** | A's lease lapsed, nobody re-claimed. A's completion matches 0 rows (lease dead) ⇒ `completion_conflict`, audit-only. The row stays `pending`, reclaimable by a fresh claim — not silently completed by a stale writer. |
| 3 | **completed B** | A fails after B completed. A's fenced failure matches 0 rows (row is `completed`, not `pending`) ⇒ `ownership_lost`, non-terminal audit, **no `tenant_export.failed`**. |
| 4 | **unknown failure commit** | Fenced failure moved one row, audit returned, wrapper threw ⇒ `commit_unknown` ⇒ `tenant_export.failure_commit_unknown`, no terminal claim either way. |
| 5 | **missing adapter / schema** | `requireOwnershipCapability` throws at request time (audited `request_denied`, 503, no job row), at process time (before the job read) and at run time (before the first read/write). No path activates a placeholder. |
| 6 | **malformed grant** | `validateOwnershipGrant` refuses an epoch that is not a positive safe integer or a lease already expired; the adapter refuses an unreadable epoch. Both ⇒ `ExportOwnershipCapabilityError`, no transition. |
| 7 | **cancelled publication** | Abort before the manifest write prevents publication; artifacts already written are orphans under this attempt's namespace, referenced by no row, never advertised. Abort that loses the race does not retract a published export. |

## C.9 Exact I2 contract (agrees with the fixed SQL)

```sql
ALTER TABLE tenant_data_exports
    ADD COLUMN export_owner          VARCHAR(64) NULL,
    ADD COLUMN owner_epoch           INT         NOT NULL DEFAULT 0,
    ADD COLUMN owner_lease_until_ms  BIGINT      NULL;
```

Requirements, as requirements rather than executed DDL:

- **Lease pairing**: `owner_lease_until_ms` is written only together with `export_owner`, and read
  only in the same statement that decides ownership. A row carrying an owner with a NULL lease is not
  claimable and not live.
- **Version**: `owner_epoch` is `NOT NULL DEFAULT 0` and is incremented only by the claim. It fences
  a writer whose claim has been taken over.
- **Indexes**: `(tenant_id, status, owner_lease_until_ms)` for the claim scan; `(export_owner,
  owner_epoch)` is covered by the claim's `(id, tenant_id)` lookup in practice, but a composite
  `(id, tenant_id, export_owner, owner_epoch)` removes any doubt for the terminal transitions.

The three statements in §C.7 are the ones the adapter runs verbatim.

## C.10 Not verified

No tests, no typecheck, no SQL/DB/storage/provider/secret, no Git, no migration, no new file, no
production activation. The arrow-declaration audit is a textual scan, not a compile. Every row of §C.8
is static reasoning about the delivered source.

---

# ADDENDUM 4 — 2026-10-24 — the claim seam: one connection, both seams

Task: `server-export-claim-seam-correction-20261024-01`. Fifth review of the export surface, third
followup on attempt ownership. ADDENDA 1–3 are preserved; the search files and
`routes/tenant-export.ts` are byte-identical to the previous delivery. This addendum corrects one
claim in §C.4 and changes one call site.

## D.1 The defect: the caller handed the port an execute-only handle

§C.4 said the claim's epoch "is read back through a declared `query` seam on the claim executor". That
was true of `createSqlExportOwnershipPort` and false of its only caller. `runTenantExport` passed

```ts
ownership.claim((sql, params) => tx.execute(sql, params), { … })
```

— a function with no `query` member. Static trace of the delivered source, pre-fix:

1. `claim` runs `OWNERSHIP_CLAIM_SQL` through that handle; the UPDATE matches one row, so
   `affectedRowsOf(…, 'ownership claim') === 1` passes (`:1774`).
2. The adapter then needs the installed epoch and finds no read seam:
   `typeof claimRun.query !== 'function'` ⇒ `ExportOwnershipCapabilityError` (`:1775-1779`). It does
   not guess `1`, which is correct.
3. The throw happens inside the `inTransaction` callback, so the wrapper rejects; on the transaction
   seam's contract that rolls the claim UPDATE back, so the row is not left half-claimed. A wrapper
   that rejected without rolling back would leave the row owned with a live five-minute lease and no
   running attempt — the same block as D.4.2, from a different cause.
4. `grant` is still `null` (the assignment never completed), so the outer catch takes the
   `grant === null` branch: `tenant_export.ownership_unproven`, no row write, rethrow.
5. `classifyExportFailure` ⇒ `ownership_capability_absent` ⇒ route 503
   `The tenant export service is not configured` (`routes/tenant-export.ts:100`).

Consequence, stated without inflation: this is **not** a fencing hole — nothing is left owned and no
winner is demoted. It is a total capability failure. With the I2 columns present, the shipped adapter
injected, and the router wired, **no attempt could ever claim a row**, so every export request would
return 503. The adapter was correct; the caller did not satisfy the contract it declared.

Why a typecheck does not catch it: `ExportOwnershipClaimExecutor.query` is **optional**
(`:1743-1745`), so an execute-only function is assignable to it. The contract is enforced only at
runtime, inside the adapter.

## D.2 The fix

`services/tenant-export.ts:1968-2001` (was `:1968-1976`). Before: the execute-only arrow. After: a
claim executor carrying **both** members, built inside the transaction callback:

```ts
const claimExecutor: ExportOwnershipClaimExecutor = Object.assign(
    (sql: string, params?: unknown[]) => tx.execute(sql, params),
    {
        query: <T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]> =>
            tx.query<T>(sql, params),
    },
);
return ownership.claim(claimExecutor, { … });
```

Three properties, each deliberate:

1. **Same connection.** Both members close over the same `tx` the transaction seam produced. The claim
   write and the epoch read-back cannot land on different connections, so the epoch returned is the
   epoch this attempt actually installed.
2. **Receiver preserved.** Both call `tx` as a method (`tx.execute`, `tx.query`), never as a bare
   function reference, so an access object whose methods read `this` is not dereferenced.
3. **No fallback.** The adapter's `run ?? executor` fallback is not used to paper over a missing
   `query`: the port's constructor executor may belong to another connection, and an epoch read from
   another connection is not this attempt's epoch. A caller that cannot supply both seams on one
   connection must fail, which is what the adapter already does.

Nothing else in the module changed. `failureStatement` / `releaseStatement` return SQL only and need
no read seam, so `recordOwnedFailure` is untouched.

## D.3 Preserved, re-read after the edit

| Property | Where |
|---|---|
| claim: id + tenant + `pending` + owner install + epoch increment + lease install | `:1690-1695` |
| failure / abort: id + tenant + owner + epoch + live lease + `pending` | `:1698-1711` |
| release: same fence, clears owner and lease | `:1718-1723` |
| completion: id + tenant + `pending` + owner + epoch + live lease | `:2131-2155` |
| `affectedRows` checked at claim, failure, completion, token rotation; `undefined` throws | `:495-501`, `:1774`, `:1877`, `:2153`, `:2368` |
| terminal audit only inside the transaction that moved exactly one row | `:1873-1890`, `:2156-2166` |
| per-attempt namespace from `randomUUID()`, not `deps.newId` | `:1952` |
| `completion_conflict` / `completion_unknown`: audit only, no row write | `:2190-2211` |
| mandatory transaction seam, refused before any side effect | `:1278-1292`, `:1928` |

## D.4 Held for the schema owner (Codex), with exact traces

**D.4.1 The three columns are still the precondition for wiring.** `ownership` stays `undefined`
(`routes/tenant-export.ts:494`). If it were wired before the columns exist, the claim UPDATE would
raise `ER_BAD_FIELD_ERROR` (1054) *before* the read-back is even attempted; `claim` does not catch it,
so it propagates out of the transaction, `grant` stays `null`, `classifyExportFailure` maps 1054 to
`source_unavailable`, and every request answers 503 `The export data source is unavailable` with a
`tenant_export.ownership_unproven` audit. That is a schema fault per request — the outcome the route
comment predicts — not a fencing failure, but it is not an acceptable steady state either.

**D.4.2 A pending row whose lease lapsed blocks the tenant permanently.** `requestTenantExport:1311-1320`
selects `status='pending'` with **no lease term** and answers 409. A row left `pending` by
`completion_conflict`, `ownership_lost`, `failure_audit_rolled_back` or `failure_commit_unknown` is
therefore never re-requestable; only `processTenantExport(id)` can re-claim it, and no route exposes
that for an existing id. The lease-aware pre-check would be:

```sql
SELECT id, status FROM tenant_data_exports
WHERE tenant_id = ? AND status = 'pending'
  AND (export_owner IS NULL OR owner_lease_until_ms IS NULL OR owner_lease_until_ms <= ?)
LIMIT 1
```

Expected signature: `deps.db.queryOne<{ id: string; status: string }>(sql, [tenantId, nowMs])`, with
`nowMs = captureTransitionClock(now)` so the pre-check and the claim cannot disagree about liveness.
**Not applied**: it references I2 columns on a request path that runs before schema verification, and
it relaxes the one-active rule from "never steal" to "steal an expired claim" — an owner decision, not
a source fix. Today's behaviour is the conservative side of that decision.

**D.4.3 The lease is never renewed.** `EXPORT_OWNERSHIP_LEASE_MS` is a fixed five minutes (`:378`) and
nothing extends it. An export that runs longer than the lease cannot complete: its completion UPDATE
matches zero rows (lease dead) ⇒ `completion_conflict`, audit-only, row left `pending`, its artifacts
orphaned under an unreferenced namespace. Closing this needs one of: a longer lease, a renewal
statement between tables, or a hard per-tenant export duration cap below the lease. Owner decision; no
code change made.

> **Superseded by §F.1 (2026-10-24).** Renewal is implemented as the optional `renew` member with the
> `OWNERSHIP_RENEW_SQL` live-lease CAS, invoked at each bounded phase boundary (§G.1). The fixed
> five-minute lease is unchanged; what a renewal buys is a fresh five minutes from a freshly captured
> clock. The duration-cap alternative in this paragraph is still **not** implemented and remains a
> product decision (§F.4.1).

**D.4.4 Ambiguous commit on the create path leaves an unowned pending row.**
`requestTenantExport:1339-1367` rethrows any non-duplicate error and its comment claims "Any other
failure rolls the whole insert back, so no pending row and no unaudited job survive". That holds when
the wrapper fails *before* COMMIT; when the wrapper fails *on* COMMIT the INSERT may have committed, and
the caller receives an error with no job id. The row then blocks the tenant exactly as in D.4.2, and
no one holds its id. Distinguishing it needs the same two-flag treatment as completion
(`statusWritten` / `callbackFinished`), and any compensating delete is forbidden by ADDENDUM 1's rule.
Recorded, not changed.

**D.4.5 One label is optimistic, and harmless.** `recordOwnedFailure:1892-1898` returns
`audit_rolled_back` both when the audit threw after a one-row write and when the statement itself
threw before any write, and the outer audit's reason says the row "is still pending". Inside a
transaction a failed statement cannot have committed the row, so the assertion holds for a wrapper
that rolls back; if the wrapper itself fails to roll back, the label overstates what is known. The
audit is non-terminal and asserts no final state, so nothing is demoted or fabricated by it. Left
as-is; a fifth outcome name would be a contract change for no observable difference.

## D.5 Reviewed and deliberately not changed

* `routes/tenant-export.ts` — **byte-identical**. `serviceDeps`' audit binding still preserves the
  receiver (`:83`); `ownership: undefined` left per D.4.1; the failure→HTTP table, the abort binding
  (`:135-147`, `:272-274`) and `res.headersSent` guard re-read.
* `createSqlExportOwnershipPort` — its SQL, its refusal on an unreadable epoch, and its
  `affectedRowsOf` check are correct as written. Softening the refusal into a fallback would read the
  epoch off another connection and is not done.
* `issueExportDownloadToken:2363-2368` — a completed-row mutation, not an attempt transition; the
  rotation is fenced by `status='completed'` + tenant, its count is checked, and no owner/epoch applies.
* The request INSERT (`:1341-1345`) has no `affectedRows` check. It is a creation inside the same
  transaction as its audit, not an owned transition, and no terminal/success state audit is coupled to
  it. Left unchanged rather than widened.
* `releaseStatement` is declared on the port and never called: a claim is released only by the lease
  lapsing or by a terminal transition. Releasing on `ownership_lost` or `completion_conflict` would be
  wrong (the row is not this attempt's), and releasing on `audit_rolled_back` would only shorten the
  block described in D.4.2. Left.
* `captureTransitionClock`, `validateOwnershipGrant`, `requireOwnershipCapability`,
  `classifyExportFailure`, `affectedRowsOf`, the per-table read/coverage code, and the download token
  path were read line by line and are unchanged.

## D.6 Not verified

No test was run or edited; no typecheck, compiler or build; no SQL/DB/storage/provider/secret; no Git;
no migration; no new file; no production activation. The `Object.assign` + generic-arrow construction
was reasoned about, not compiled: if it does not typecheck, the fix is a cast at the same call site and
not a behaviour change. The edited block's delimiters were traced by hand and the file was checked for
CR bytes; **no scripted balance or arrow-declaration audit was run this time**, so this addendum does
not carry the shape evidence ADDENDUM 3 carried. Nothing here is a readiness claim: the adapter
existing was never the gap, and wiring still depends on D.4.1.

## D.7 Hashes

| Path | Before this addendum | After this addendum |
|---|---|---|
| `server/src/routes/tenant-export.ts` | `eb6c6628776d345d48a7f9eabdeb26acddf672352186a71e457dba7cd9866073` (22 225) | **unchanged, byte-identical** |
| `server/src/services/tenant-export.ts` | `b3b42774dbf5745762ae1c01599ff54cb912e1d94674e29c38f6d4b5ad0d53e8` (114 590) | `d41d1f6ecebdf0fb78ecaff7057ba0f75c2cde2969214989189f8091110ebdc3` (115 945) |
| `server/src/routes/search.ts` | not reopened | not reopened |
| `server/src/services/search.ts` | not reopened | not reopened |

Line count 2 502 → 2 525 (23 lines: the claim executor, its comments, and the arrow-body wrapper).
No CR byte in the file after the edit (LF preserved).

## D.8 Acceptance asks

1. Confirm the only source change in this addendum is the claim call site (`:1968-2001`) and that
   `routes/tenant-export.ts` is untouched.
2. Decide D.4.2 (lease-aware one-active pre-check) and D.4.3 (lease renewal vs. duration cap). Both are
   owner decisions; neither is applied.
3. Confirm the I2 columns (§C.9) before `ownership` is wired, per D.4.1.

---

# ADDENDUM 5 — 2026-10-24 — `owner_epoch` is parsed, not type-tested

Task: export attempt ownership follow-up. Sixth review of the export surface, fourth on attempt
ownership. ADDENDA 1–4 preserved. One source file changed (`services/tenant-export.ts`), one file
written (this one). `routes/tenant-export.ts`, both search files, and every other file are untouched.
The D.2 claim seam is preserved verbatim (`:2037-2045`).

## E.1 The defect: a valid epoch was rejected for its JavaScript type

`createSqlExportOwnershipPort.claim` read the installed epoch back and then tested it inline:

```ts
const epoch = Array.isArray(rows) ? rows[0]?.owner_epoch : undefined;
if (typeof epoch !== 'number' || !Number.isSafeInteger(epoch) || epoch < 1) {
    throw new ExportOwnershipCapabilityError();
}
```

`owner_epoch` is `INT` in the schema (§C.9), but the *JavaScript* type is not part of the schema.
mysql2 returns `DECIMAL`/`BIGINT` (and `BIGINT`-backed integers) as a **string** unless the connection
sets a type cast, so a perfectly valid claim arrives as `'1'`. The `typeof epoch !== 'number'` arm then
refused it, the throw rolled the claim back inside the transaction, `grant` stayed `null`, and the
outer catch took the `grant === null` branch ⇒ `ownership_unproven` ⇒ 503. This is the D.1 failure
mode a second time, from a different cause: the adapter was right about the fence and wrong about the
driver's return type, so **no attempt could claim a row** on a string-returning connection. It is a
false negative, not a fencing hole — nothing is left owned and no winner is demoted.

## E.2 The fix: `parseOwnerEpoch`, at `:1776`

Accepted, and they must denote the same value:

| Input | Result |
|---|---|
| `1`, `42`, `9007199254740991` (safe positive integer `number`) | accepted, returned as-is |
| `'1'`, `'42'`, `'9007199254740991'` (strict `/^\d+$/` string, safe integer `>= 1`) | accepted, `Number()`-converted |

Refused, each ⇒ `ExportOwnershipCapabilityError`, never a guess, never a clamp:

| Input | Why |
|---|---|
| `0`, `'0'`, `'000'` | not positive |
| `-1`, `'-1'`, `'+1'` | sign; fails `typeof`/pattern |
| `' 1'`, `'1 '`, `'1\n'` | whitespace; `\d` only |
| `1.5`, `'1.0'`, `'1e3'`, `'0x1'`, `'1_000'` | fraction / exponent / hex / separator |
| `9007199254740992`, `'9007199254740993'` | past `MAX_SAFE_INTEGER`; `Number()` rounds to a non-safe double and `isSafeInteger` refuses it |
| `null`, `undefined`, `true`, `[]`, `{}` | not a number or a digit string |
| `NaN`, `Infinity`, `-Infinity` | not safe integers |

The digit string is parsed **after** the pattern, never before: `Number(' 1')` would return `1`, so the
pattern is what rejects whitespace and signs, and `Number()` only ever sees `[0-9]+`. `'01'` is
accepted because it denotes the same integer; no digit is discarded before conversion. The regex has no
`g` flag, so `lastIndex` cannot make a second call behave differently.

The read-back is also now required to identify **exactly one** row (`rows.length === 1`), where the old
code took `rows[0]` from any non-empty array. Zero rows after an UPDATE that matched one row means the
fence stopped matching inside the same transaction; more than one means the predicate is not selective.
Neither is a grant. This cannot reject a valid claim: the statement is keyed on `id`.

**`validateOwnershipGrant` (`:1660-1675`) was deliberately left strict.** It validates the port's
*declared* TypeScript contract (`epoch: number`), not a driver row, and it runs after the adapter has
normalised the value. Relaxing it would let a substitute port smuggle a string past the interface, and
would not fix the driver case, which the adapter already absorbs.

## E.3 Reviewed, not changed

1. **Second attempt while a lease is live.** Two gates, neither sufficient alone. `requestTenantExport`
   refuses any `pending` row with 409 (`:1311-1320`) — over-broad, never under-broad. Cross-process,
   the claim UPDATE requires `(export_owner IS NULL OR owner_lease_until_ms <= ?)` (`:1694`), so a live
   lease matches 0 rows ⇒ `claim` returns `null` ⇒ `ExportOwnershipLostError` ⇒
   `ownership_unproven` audit and no row write (`:2057-2061`, `:2267-2283`). In-process,
   `claimLocalAttempt` throws `ExportInProgressError` first. No change.
2. **Lease expiry during an export.** The completion UPDATE carries `owner_lease_until_ms > ?` with a
   clock captured once before the transaction (`:2164`, `:2186-2204`); a lapsed lease matches 0 rows ⇒
   `ExportStateConflictError` ⇒ `completion_conflict` ⇒ audit-only, no row write, row left `pending`.
   The failure and abort statements carry the same term. No change — the gap is that the 5-minute lease
   is never renewed (D.4.3, restated in E.4), which is a policy question, not a parse question.
3. **Publishing after ownership is lost.** The publication point is the COMMIT of the fenced row
   transition, not the manifest write. A loser writes only under its own `randomUUID()` attempt prefix
   (`:2007-2008`), so it cannot overwrite the winner's keys, and no row ever references its objects;
   they are orphans, not a published export. Re-read and unchanged.
4. **Unknown commit.** No compensating UPDATE was added anywhere. `callbackFinished` still short-circuits
   to `ExportCompletionUnknownError` / `commit_unknown` with audit only (`:2224-2231`, `:1949`), so a
   commit that may have installed the winner is never demoted by a loser. Preserved exactly.
5. `requestTenantExport`'s lease-blind pre-check (D.4.2) is unchanged: it now *matters more*, because a
   claim can actually succeed, but making it lease-aware is an owner decision that relaxes
   "never steal" to "steal an expired claim", and it touches a path that runs before schema
   verification. Recorded, not applied.

## E.4 Contract request — lease renewal (NOT implemented)

Adding renewal is a port-contract change, so it is specified here and nowhere in code:

```ts
// on ExportOwnershipPort, alongside claim/failureStatement/releaseStatement
renew?(input: {
    exportId: string; tenantId: string; owner: string; epoch: number;
    nowMs: number;          // captured once, reused by the lease term
    leaseUntilMs: number;   // nowMs + EXPORT_OWNERSHIP_LEASE_MS
}): Promise<boolean>;       // true = renewed, false = ownership lost
```

```sql
UPDATE tenant_data_exports
SET owner_lease_until_ms = ?
WHERE id = ? AND tenant_id = ? AND export_owner = ? AND owner_epoch = ?
  AND owner_lease_until_ms > ? AND status = 'pending'
```

Conditions: `affectedRows === 1` ⇒ renewed; `0` ⇒ stop before writing more bytes and take the existing
ownership-lost path (no terminal write). Params, in order: `leaseUntilMs, exportId, tenantId, owner,
epoch, nowMs` — the same six terms the failure statement already binds, with the lease written instead
of the status. The new lease must extend from the captured clock, never from
the old expiry. The statement must run between tables, never mid-table, and must never resurrect an
expired lease — hence the live-lease term, which makes `0` the correct answer for a stale claimant.
`renew` must stay **optional** so `requireOwnershipCapability` (`:1626-1653`) and every existing
injected port keep working; a required member would be a breaking contract change. Alternative, cheaper
and also unimplemented: a hard per-tenant export duration cap below `EXPORT_OWNERSHIP_LEASE_MS`.

## E.5 Hashes

| Path | Before | After |
|---|---|---|
| `server/src/services/tenant-export.ts` | `d41d1f6ecebdf0fb78ecaff7057ba0f75c2cde2969214989189f8091110ebdc3` (115 945 B) | `21d9ae98d79b6407212fb5b929bea854cb29e33dfd68fe960631b7e184dc18fa` (118 985 B) |
| `server/src/routes/tenant-export.ts` | `eb6c6628776d345d48a7f9eabdeb26acddf672352186a71e457dba7cd9866073` | **unchanged** |
| `server/src/services/search.ts` | `6ec9d497d33e0dc8a7858a5f4547f783c917c7a38d8074e3dd127186cac5c29d` | **unchanged** |
| `server/src/routes/search.ts` | `4055aee27792d83b3d82efd08823cb335cd53b514a4fa8a7af1dadc365ac2eca` | **unchanged** |

2 525 → 2 580 lines (+55: the parse helper, its comment, the exact-one-row check, and the extended
read-back comment). No CR byte after the edit.

## E.6 Not verified

No test written or run; no typecheck, compiler or build; no SQL/DB/storage/provider/secret; no Git; no
migration; no new file; no production wiring (`ownership` stays `undefined`). The accept/reject table in
E.2 is a specification of `parseOwnerEpoch`'s arms, not a test result; it was reasoned from the code and
`Number`/`Number.isSafeInteger` semantics. Nothing here is a readiness claim: wiring still depends on
D.4.1, and a renewal decision is still open under E.4.

## E.7 Acceptance asks

1. Confirm `parseOwnerEpoch` is the only behavioural change and that `validateOwnershipGrant` was left
   strict on purpose (E.2).
2. Confirm the D.2 seam (`:2037-2045`) is byte-identical.
3. Decide E.4 (renewal contract vs. duration cap) and D.4.2 (lease-aware pre-check); both remain
   unimplemented.

---

# ADDENDUM 6 — 2026-10-24 — optional lease renewal

Task: export lease renewal, correctness follow-up on the delivered source. ADDENDA 1–5 preserved.
One source file changed (`services/tenant-export.ts`) and this document. `routes/tenant-export.ts`,
both search files and every other path are untouched.

This addendum **supersedes the status line of §E.4**: the renewal contract specified there is now
implemented, exactly as specified (same six bound terms, same live-lease predicate, optional member).
The alternative recorded in E.4 — a hard per-tenant duration cap — is **not** implemented and remains
an open owner decision (F.4).

## F.1 What was added

`ExportOwnershipPort.renew?` (`:477`) — **optional**, so `requireOwnershipCapability` (`:1667-1694`)
still requires only the four existing operations and every previously injected port keeps working. A
port that omits `renew` renews nothing; that is the no-effect refusal described in F.3.

`ExportOwnershipRenewInput` (`:421-439`) carries `exportId, tenantId, owner, epoch, nowMs,
leaseUntilMs` — the six terms the failure statement already binds, with the lease written instead of
the status. `leaseUntilMs` is derived by the caller from a captured `nowMs`, never from the expiry in
the row.

`OWNERSHIP_RENEW_SQL` (`:1821-1838`), fixed text with bound parameters only:

```sql
UPDATE tenant_data_exports
SET owner_lease_until_ms = ?
WHERE id = ? AND tenant_id = ? AND export_owner = ? AND owner_epoch = ?
  AND owner_lease_until_ms > ? AND status = 'pending'
```

Params in order: `leaseUntilMs, exportId, tenantId, owner, epoch, nowMs`. `createSqlExportOwnershipPort`
(`:1983-1996`) runs it on the injected executor and returns
`affectedRowsOf(updated, 'ownership renewal') === 1`, so `undefined` **throws** (it is neither zero nor
one and is never coerced), `1` is `true`, and `0` is `false`.

`renewOwnedLease` (`:1737-1771`) is the caller-side step. It captures the clock once
(`captureTransitionClock`), computes `leaseUntilMs = nowMs + EXPORT_OWNERSHIP_LEASE_MS`, calls `renew`
as a **member** (receiver preserved, same discipline as the claim seam), and throws
`ExportOwnershipLostError` unless the result is exactly `true`. It also skips a renewal whose new
expiry would not exceed the expiry this attempt already installed: a no-op `UPDATE` reports zero
affected rows on a changed-rows connection, and zero is read as a lost lease, so the skip prevents a
false "ownership lost" on two renewals inside the same millisecond.

Call sites, all **before** the bounded expensive phase they protect and **between** tables (never
mid-table, per E.4):

| Where | Line | Protects |
|---|---|---|
| top of each `EXPORT_TABLE_PLAN` iteration, after the abort check and the budget skip | `:2212-2219` | that table's paged read + storage write |
| before `buildOmittedCoverage` | `:2255-2262` | the omitted-row probe statements |
| after the pre-manifest abort check, before the manifest write | `:2313-2320` | publication of `manifest.json` |

The attempt tracks `leaseUntilMs`, initialised from `grant.leaseUntilMs` (`:2194`) and advanced only by
a renewal that proved a live lease. The lease policy is **unchanged**: `EXPORT_OWNERSHIP_LEASE_MS` is
still five minutes (`:383`), and renewal extends by that same amount from the current clock.

## F.2 Consequences, traced

| # | Scenario | Path | Row write | Audit |
|---|---|---|---|---|
| 1 | **renewal returns `false`** (lease lapsed, epoch taken over, or row no longer `pending`) | `ExportOwnershipLostError` ⇒ `ownership_lost`; `grant` is held, so the existing owned failure path runs and its fenced statement matches 0 rows | **none** | `tenant_export.ownership_lost` |
| 2 | **renewal returns a non-boolean** (a substitute port) | not exactly `true` ⇒ same as #1 | **none** | `tenant_export.ownership_lost` |
| 3 | **renewal throws** (driver error, capability error) | propagates; classified; the owned failure transition runs under a still-live lease | `failed` + code, if the lease is live | `tenant_export.failed`, same transaction |
| 4 | **`renew` absent** | no-op, expiry unchanged, attempt continues | unchanged | unchanged |
| 5 | **long export** | the lease is extended before each phase, so the completion CAS's `owner_lease_until_ms > ?` can be satisfied where it previously could not | `completed` | `tenant_export.completed` |
| 6 | **expired claimant tries to renew** | the `owner_lease_until_ms > ?` term matches 0 rows; the expiry is never written | **none** | per #1 |

A lease is never resurrected: the statement's live-lease term, evaluated in the same statement that
writes the new expiry, refuses a lapsed claim, and the new expiry always comes from the current clock.

## F.3 Preserved

* **No-effect refusal when `renew` is absent.** `renew` stays optional, `requireOwnershipCapability`
  is unchanged in what it demands, and a port without it behaves exactly as before this addendum.
* **Original exception and `commit_unknown` semantics.** No new row write, no compensation, and no
  new failure code were introduced. `callbackFinished` / `statusWritten`, `ExportCompletionUnknownError`
  and the audit-only `completion_unknown` / `completion_conflict` branches are untouched, so a renewal
  can only ever take the pre-existing `ownership_lost` path.
* **Per-attempt winner isolation.** The attempt prefix is still `randomUUID()`-derived, only the
  completion CAS persists `storage_key`, and a loser's objects stay under its own prefix and are
  referenced by no row. Renewal adds no key and no deletion.
* The fixed five-minute lease, the four-term fence, `parseOwnerEpoch`, the claim seam (§D.2), the
  mandatory transaction seam, bounded reads and the incomplete manifest are unchanged.

## F.4 Held for the owner (PRODUCT POLICY — not implemented)

**F.4.1 Total export duration is now unbounded.** Renewal removes the "a run longer than five minutes
can never complete" defect (§D.4.3 / §E.4), but it also removes the only implicit ceiling: an attempt
can now hold the tenant's one-active slot for as long as it keeps renewing. Whether a hard
per-tenant export duration cap (the cheaper alternative in E.4) should exist **in addition to**
renewal, and what that cap is, is a product decision. No cap, timer or deadline was invented here; the
byte/row bounds in §6 still bound the work, and renewal is only attempted before a phase, never
unconditionally.

**F.4.2 Renewal cadence vs. remaining work.** Renewal is per table and per phase boundary, not
time-based. A single table's read is already bounded (500-row pages, 50 000 rows, shared byte budget),
so a phase cannot run unbounded without an abort — but "renew every N seconds during a long page loop"
would need a timer, which this task forbids. If a phase ever exceeds the lease, the correct fix is a
shorter phase, not a timer inside the page loop.

**F.4.3 D.4.2 is still open.** The lease-aware one-active pre-check is unchanged: a `pending` row whose
lease lapsed still answers 409 on the request path. Renewal makes that state less likely, not
impossible, and relaxing "never steal" to "steal an expired claim" remains an owner decision.

**F.4.4 Orphan namespaces (§A.5) remain unpurged**, as before.

## F.5 Hashes

| Path | Before | After |
|---|---|---|
| `server/src/services/tenant-export.ts` | `21d9ae98d79b6407212fb5b929bea854cb29e33dfd68fe960631b7e184dc18fa` (118 985 B) | `9329106bebe811b600bd33c71e9257f164228b5087092c15a829eaa6a4cce0fb` (126 488 B) |
| `server/src/routes/tenant-export.ts` | `eb6c6628776d345d48a7f9eabdeb26acddf672352186a71e457dba7cd9866073` | **unchanged, byte-identical** |
| `server/src/services/search.ts` | `6ec9d497d33e0dc8a7858a5f4547f783c917c7a38d8074e3dd127186cac5c29d` | **unchanged, byte-identical** |
| `server/src/routes/search.ts` | `4055aee27792d83b3d82efd08823cb335cd53b514a4fa8a7af1dadc365ac2eca` | **unchanged, byte-identical** |

2 580 → 2 747 lines. No CR byte in the file after the edit (LF preserved).

## F.6 Not verified

No test was written or run; no typecheck, compiler or build; no SQL/DB/storage/provider/secret; no Git;
no migration; no new file; no production wiring (`ownership` stays `undefined` in the router, so
`renew` is not reachable in production and nothing here activates it). Every row of F.2 is static
reasoning about the source, not an executed test. The `renew.call(...)` construction was reasoned
about, not compiled; if it does not typecheck the fix is a local cast at that call site and not a
behaviour change. Nothing here is a readiness claim.

## F.7 Acceptance asks

1. Confirm `renew` is optional and that `requireOwnershipCapability` was deliberately left requiring
   only the four existing operations (F.3).
2. Confirm `affectedRows === 0` on renewal takes the existing `ownership_lost` path with no row write,
   and that `undefined` throws (F.1, F.2).
3. Decide F.4.1: should a hard per-tenant export duration cap exist in addition to renewal, and at
   what value?
4. D.4.2 (lease-aware pre-check) and A.5 (orphan purge) remain open.

---

# ADDENDUM 7 — 2026-10-24 — renewed lease traced end to end; stale claims corrected

Independent contract-closure review of the export attempt-ownership / lease contract. Prior addenda were
treated as untrusted: every statement below was re-derived from the current body, not from a previous
report. ADDENDA 1–6 are preserved; their stale statements are marked in place (§G.7).

Files changed: `server/src/services/tenant-export.ts` (**comments only** — no executable statement,
signature, SQL string or bound parameter changed) and this document. Nothing else was written: no
route, no schema/migration, no new file, no test.

**Result of the trace: no behavioural defect was found in the five areas reviewed (A–E).** That is a
statement about the source as read, not an acceptance, and not a readiness claim — production wiring
is still `ownership: undefined` (§D.4.1).

## G.1 The renewed lease, phase by phase

Line anchors are for the file at the hash in §G.9 (2 754 lines).

| # | Phase | Cost | Renewal before it | Fence that actually stops a stale attempt |
|---|---|---|---|---|
| 0 | claim | 1 UPDATE + 1 SELECT | — | claim CAS: `id + tenant + pending + (unowned OR lease <= now)` |
| 1 | each table: paged read + `storage.write` | bounded: ≤50 000 rows, ≤64 MiB shared budget; page count follows `pageSize` (500 default) | **yes** — `:2219`, at the top of each `EXPORT_TABLE_PLAN` iteration, after the abort check and the budget skip | next renewal, or the completion CAS |
| 2 | omitted-row probes (`buildOmittedCoverage`) | 16 `COUNT(*)` statements (13 omitted-table + 3 child) | **yes** — `:2262` | as above |
| 3 | manifest construction | in-memory, no I/O | no (no I/O) | — |
| 4 | abort check | — | — | — |
| 5 | `storage.write(manifest.json)` | one write | **yes** — `:2320`, after the abort check, before the write | as above |
| 6 | completion CAS + completed audit | 1 UPDATE + 1 audit, one transaction | no (single statement) | the CAS's own four terms |
| 7 | terminal failure/abort | 1 UPDATE + 1 audit, one transaction | no | the failure statement's four terms |

`renewOwnedLease` (`:1744`) captures the clock **once** (`captureTransitionClock`), computes
`leaseUntilMs = nowMs + EXPORT_OWNERSHIP_LEASE_MS`, and passes both to the port; the port writes the
passed `leaseUntilMs` (`OWNERSHIP_RENEW_SQL`, `:1840`), so the new expiry is always
`captured now + 5 min` and never `old expiry + 5 min`. An expired claim cannot renew: the same
statement carries `owner_lease_until_ms > ?` with that captured `nowMs`, so a lapsed lease matches zero
rows and the attempt stops.

**The one phase not renewed internally is the page loop** (`readExportTable`). It is a deliberate,
bounded choice, and its worst case is safe: a lease that lapses mid-table cannot publish anything —
the next boundary's renewal returns `false` (`ownership_lost`, no row write) or the completion CAS
matches zero rows. What it can leave behind is an unreferenced table object under this attempt's own
prefix. Adding a timer inside the loop would be the forbidden fix (§F.4.2).

**A wrong local lease belief cannot publish.** The attempt's tracked `leaseUntilMs` (`:2201`, advanced
only by a successful renewal) is used *only* to skip a renewal that would not move the expiry forward.
It is never bound as a lease term: every SQL lease term uses a freshly captured clock against the
value the database holds. So even a belief that is too high can only cause a skipped renewal and a
later refusal — never a completion after expiry.

## G.2 The publication statement

The only statement that publishes an export is the completion UPDATE (`:2360`):

```sql
UPDATE tenant_data_exports
SET status = 'completed', storage_key = ?, file_size = ?, manifest = ?,
    expires_at = ?, completed_at = CURRENT_TIMESTAMP
WHERE id = ? AND tenant_id = ? AND status = 'pending'
  AND export_owner = ? AND owner_epoch = ?
  AND owner_lease_until_ms > ?
```

It is **not** id-only, and it is not pending-only: owner, epoch, live lease, intended state and tenant
are all evaluated by the database in the same statement that writes `storage_key`. The success audit
(`tenant_export.completed`) is written in the same transaction, after `affectedRows === 1`. There is no
second statement anywhere that sets `status = 'completed'` (grep: one occurrence, `:2362`), so no
publication path exists outside this fence.

## G.3 `affectedRows` semantics, statement by statement

| Statement | `1` | `0` | `undefined` / unusable |
|---|---|---|---|
| claim (`:1942`) | proceed to the epoch read-back | `claim` returns `null` ⇒ `ExportOwnershipLostError` ⇒ `ownership_unproven`, no row write | throws (`affectedRowsOf`, `:540`) |
| renewal (`:2002`) | `true` | `false` ⇒ `ExportOwnershipLostError` | throws |
| failure/abort (`:2064`) | audit in the same transaction | `ownership_lost`, non-terminal audit | throws, caught as `audit_rolled_back` (non-terminal, no state asserted — §D.4.5) |
| completion (`:2382`) | audit, commit | `ExportStateConflictError` ⇒ `completion_conflict`, audit only | throws ⇒ same conflict path, transaction rolls back |
| token rotation (`:2597`) | proceed | 409, no token | throws |

`undefined` is never coerced to `0` or `1` anywhere: `affectedRowsOf` refuses a non-safe-integer count.
No statement treats `0` as success.

## G.4 Ambiguous commit, and the absence of compensation

`callbackFinished` (`:2398`) is set only after the audit returns inside the callback, so a wrapper
throw after it is the ambiguous-commit case: `ExportCompletionUnknownError` ⇒ `completion_unknown` ⇒
audit `tenant_export.completion_unknown`, **no row write, no completed audit, no failed audit**
(`:2419-2432`). `statusWritten` alone ⇒ deterministic rollback ⇒ `failureCode = 'audit_failed'` and the
ordinary fenced failure path. There is **no compensating UPDATE and no DELETE anywhere in the file**
(grep for `storage.delete`/`remove`: none), so nothing can demote or drop a winning attempt.

Per-attempt isolation is intact: `attemptId = randomUUID()` (`:2143`), keys
`{prefix}/{tenantId}/{exportId}/{attemptId}/{table}.jsonl` and `…/manifest.json`, and the only pointer
ever persisted is the winner's, written by the CAS above. A loser's objects stay under its own prefix
and are referenced by no row.

## G.5 Abort

`abortIfRequested` runs before every table (`:2208`), before every page, before every probe, and once
more before the manifest write (`:2314`). An abort therefore writes no manifest and takes the fenced
`aborted` transition (`status='failed', error='aborted'`, audited `tenant_export.aborted` inside the
same transaction). There is no path that audits `tenant_export.completed` after an abort, and no abort
path touches storage at all — artifacts already written are orphans under this attempt's namespace.
An abort that loses the race to the COMMIT does not retract a published export, and the function
returns the manifest as completed.

## G.6 Receiver preservation

`claimExecutor` (`:2173`) is `Object.assign((sql, params) => tx.execute(sql, params), { query: (sql, params) => tx.query(sql, params) })`
— both members close over the same `tx` and call it as a method, so the claim write and the epoch
read-back cannot land on different connections and neither loses `this`. `recordOwnedFailure` calls
`tx.execute` (`:2064`), the completion calls `db.execute` (`:2360`), `inTransaction` calls
`db.transaction(fn)` (`:1280`), and the renewal is invoked as `renew.call(ownership, …)` (`:1763`).
No detached method reference remains on any of these paths.

## G.7 Corrections to earlier claims in this document

| Where | Stale claim | Corrected in place |
|---|---|---|
| §4.5 residual | "the loser can still overwrite the winner's `manifest.json`, because the storage key is derived from the export id alone" | marked superseded → per-attempt prefix (§A.5) |
| §7.1 | I2 DDL naming `claim_owner` / `claim_version` / `claim_lease_until_ms` | marked superseded → §C.9 (`export_owner` / `owner_epoch` / `owner_lease_until_ms`), which is what every statement binds |
| §A.3 | "every row-mutating statement uses `WHERE id = ? AND tenant_id = ? AND status = 'pending'`" and `bestEffortMarkFailed` | marked superseded → four-term fence; the symbol no longer exists |
| §A.7 | "pending-only" row writes; row 2 audited `failed` | marked corrected → fenced transition; row 2 audits `ownership_unproven` with no row write |
| §D.4.3 | "the lease is never renewed" | marked superseded → §F.1 |

Any statement in ADDENDA 1–5 that the lease is never renewed, or that a failure-path write is a bare
`status = 'pending'` UPDATE, is superseded by §F.1 and this addendum.

## G.8 Held — product policy, exact contract, NOT implemented

1. **Lease-aware one-active pre-check** (§D.4.2). `requestTenantExport` still refuses any `pending`
   row with 409. The exact patch, which must use the **same disjunct shape as the claim** (a row with
   an owner but a NULL lease is claimable by neither today):

   ```sql
   SELECT id, status FROM tenant_data_exports
   WHERE tenant_id = ? AND status = 'pending'
     AND (export_owner IS NULL OR owner_lease_until_ms IS NULL OR owner_lease_until_ms <= ?)
   LIMIT 1
   ```

   Signature: `deps.db.queryOne<{ id: string; status: string }>(sql, [tenantId, captureTransitionClock(now)])`.
   Not applied: it relaxes "never steal" to "steal an expired claim" (owner decision) and it references
   I2 columns on a path that runs before schema verification.
2. **Hard per-tenant export duration cap** (§F.4.1). Not implemented; no value invented. Renewal
   removes the implicit five-minute ceiling, so total runtime is bounded only by the row/byte caps.
3. **Orphan namespace retention/purge** (§A.5). Not implemented; no deletion exists.
4. **Ambiguous commit on the create path** (§D.4.4). `requestTenantExport` still cannot distinguish a
   COMMIT failure from a pre-COMMIT failure; a compensating delete is forbidden by §A.3's rule.
5. **`releaseStatement` is declared and never called** (§D.5). Unchanged: a claim ends by lease lapse
   or by a terminal transition.
6. **Production wiring** (§D.4.1). `ownership` stays `undefined`; this addendum does not activate it.

## G.9 What changed in source, and hashes

Three header comments only, all of them statements the body contradicted:

* the concurrency paragraph claimed a loser can overwrite the winner's manifest "because the storage
  key is derived from the export id alone" — false since §A.5; now says the loser cannot overwrite and
  that I2 buys row-transition exclusivity only;
* the lease sentence said renewal happens "between tables"; it now names all three boundaries and the
  `captured now + lease` rule;
* the stale-`pending` paragraph said the table has no owner/fencing column without noting that the port
  now declares them.

| Path | Before | After |
|---|---|---|
| `server/src/services/tenant-export.ts` | `9329106bebe811b600bd33c71e9257f164228b5087092c15a829eaa6a4cce0fb` (126 488 B) | `97e44592dfc70755c55ad4d3daf32ff58088a920d2c6e747c133a58cde932228` (127 048 B) |
| `server/src/routes/tenant-export.ts` | `eb6c6628776d345d48a7f9eabdeb26acddf672352186a71e457dba7cd9866073` | **unchanged, byte-identical** |
| `server/src/services/search.ts` | `6ec9d497d33e0dc8a7858a5f4547f783c917c7a38d8074e3dd127186cac5c29d` | **unchanged, byte-identical** |
| `server/src/routes/search.ts` | `4055aee27792d83b3d82efd08823cb335cd53b514a4fa8a7af1dadc365ac2eca` | **unchanged, byte-identical** |
| `docs/streams/server/WORKBUDDY-SEARCH-EXPORT-CLOSURE-20261023.md` | — | this file |

2 747 → 2 754 lines (+7, all comment lines). No CR byte in either file.

## G.10 Not verified

No test written or run; no compiler, typecheck or build; no SQL or DB execution; no storage provider,
service, Docker or listener; no Git; no mock; no new file; no schema or migration edit; production
wiring untouched. Every row of §G.1–G.6 is static reasoning about the source at the hash above, not an
observed run. Nothing here is an acceptance or a readiness claim: wiring still depends on §D.4.1, and
§G.8 items 1–2 are owner decisions.
