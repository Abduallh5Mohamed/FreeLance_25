# W2 — export ownership & completeness

**Task:** `server-w2-export-ownership-completeness-20261020-01` · **Team:** storage · **Worker:** `wb-w2-export-ownership-20261020-01`
**Batch:** closure-batch1-20261020 · **Branch:** `codex/workbuddy-server` (not switched, not committed, not pushed)
**Controlling scope:** `docs/streams/server/CLOSURE-BATCH1-SCOPE-REVIEW-20261020.md` §W2 (binding, read in full)
**Status:** work complete, `reported` submitted — **not** acceptance.

Write set used: `server/src/services/tenant-export.ts`, `server/tests/m8-tenant-export.test.ts`, this document.
`server/src/routes/tenant-export.ts` was **not** modified — see §8 for why no route change was needed.

---

## 1. Defects reproduced before the repair

Reproduction method: source read of the baseline files (sha256 recorded in
`WorkBuddySupervisorBridge/handoff/WORKBUDDY-W-BATCH-BASELINE-20261020.md`) plus the regression
assertions that encode each defect. A live before/after test run was **not** possible: the six
W1/W2 paths are untracked with no committed tree (baseline §3), and Git mutations are forbidden, so
there is no second checkout to run the new tests against the old source. Each item below names the
failing assertion and the causing line so the claim is checkable.

### D1 — a partial export that reads as complete (nullable `tenant_id`)

- Causing lines (baseline): `server/src/services/tenant-export.ts:123` (lectures),
  `:135` (groups), `:163` (exams) — each statement ended `... FROM <table> WHERE tenant_id = ? ORDER BY id`.
  `tenant_id` is a nullable column added by `server/migrations/20261017_04_tenant_columns_backfill.sql:42`
  (lectures), `:9` (groups), `:75` (exams) and populated **once** by that migration's UPDATEs (`:106-132`).
  `server/src/routes/lectures.ts:570-573` and `server/src/routes/groups.ts:328` insert rows without
  `tenant_id`, and no trigger or default exists.
- Consequence: SQL `=` never matches NULL, so every row created after the backfill is silently absent
  while the manifest still advertises a complete snapshot.
- Failing assertion that pins the repair:
  `tests/m8-tenant-export.test.ts` → *"a row with a NULL tenant_id but a proven parent is exported"*:
  `assert.equal(body.trimEnd().split('\n').length, 1)` → under the baseline statement the body is `''`
  (`0 !== 1`) because `WHERE tenant_id = ?` cannot match the seeded `tenant_id: null` row.
  The same test also asserts the repaired predicate exists:
  `assert.ok(lecturesPlan.sql.includes('WHERE ((t.tenant_id = ?) OR (pc.tenant_id = ?))'))`.

### D2 — no coverage statement

- Causing lines (baseline): `server/src/services/tenant-export.ts:279-288` (manifest interface: only
  `tables`, `total_rows`, `total_bytes`, `excluded`) and `:500-509` (manifest construction);
  `:188-195` (`EXPORT_EXCLUSIONS` names secrets/users/other tenants/out-of-plan only — no per-table list).
- Consequence: a consumer reads the file as full coverage of the tenant.
- Failing assertion: *"the manifest publishes an explicit included/omitted coverage list with reasons"* —
  `manifest.coverage` did not exist, and `coverage.omitted.length === 63` /
  `coverage.omitted_children` / `coverage.complete === false` all fail against the baseline manifest.

### D3 — unbounded memory shape

- Causing lines (baseline): `server/src/services/tenant-export.ts:473-474`
  (`const rows = await deps.db.query(plan.sql, [tenantId]); const body = jsonlOf(rows);`) — the whole
  table is loaded, then serialised. No row/byte cap. Driven from inside the request at
  `server/src/routes/tenant-export.ts:173-174`.
- Failing assertion: *"a large table is read in keyset pages, not loaded whole"* —
  `assert.equal(pageQueries.length, 3)` and `coverage.pages === 3` (7 rows, page size 3). The baseline
  issues exactly one statement per table and reports no `pages` field, so both fail.

### Root cause (all three)

`tenant_id` was treated as the single ownership authority. The backfill filled it once; write paths
that create rows afterwards never set it; and the export had no way to express "proven through the
parent" or "not proven at all". The manifest had no vocabulary for a scoped subset.

---

## 2. Ownership model (binding decision §W2 applied literally)

Every planned table declares **authorities**. A row is exported only when:

1. at least one authority **proves** the bound tenant (`owns`), and
2. no authority **resolves to another tenant** (`conflicts`).

The statement returns the classification as `__ownership ∈ {owned, contradiction}`; the service
exports `owned`, rejects and counts `contradiction`, and **throws** on anything else (no silent drop,
no silent export).

- A direct `tenant_id` that contradicts the proven parent is rejected — both directions (direct says
  ours / parent says theirs, and direct says theirs / parent says ours) produce `contradiction`
  because the `WHERE` keeps a row when *any* authority proves the tenant and the `CASE` then sees the
  disagreement.
- **No first-row/first-parent selection.** No `LIMIT 1`, no `MIN`/`MAX` over authorities. Two
  resolved authorities that disagree are a denial.
- Authorities that are not a proof source are **denial-only** (`owns: null`): a lecture's group, an
  exam's group attachments. They can remove a row, never add one — so the export never widens beyond
  the parent chain named in the scope review.
- Rows with no resolvable authority are **never selected and never counted**: an unattributable row is
  not proof of this tenant, and a count could describe another institution (scope §W2).

| Table | Basis | Proof source(s) | Denial-only source(s) |
|---|---|---|---|
| courses | direct | `courses.tenant_id` | — |
| lectures | parent | `lectures.tenant_id`, `courses.id = lectures.course_id` | `groups.tenant_id = lectures.group_id` |
| announcements | direct | `announcements.tenant_id` | — |
| schedules | direct | `schedules.tenant_id` | — |
| groups | parent | `groups.tenant_id`, `courses.id = groups.course_id` | — |
| branches | direct | `branches.tenant_id` | — |
| branch_memberships | parent | `branches.id = branch_memberships.branch_id` (table has no `tenant_id`) | — |
| grades | direct | `grades.tenant_id` | — |
| students | direct | `students.tenant_id` | — |
| student_courses | parent | `students.id = student_courses.student_id` | — |
| course_materials | parent | `courses.id = course_materials.course_id` | — |
| exams | parent | `exams.tenant_id`, `courses.id = exams.course_id` | `exam_groups -> groups -> courses` |
| exam_questions | parent | `exams.tenant_id`, `courses.id = exams.course_id` (via the parent exam) | `exam_groups -> groups -> courses` (parent exam) |
| question_bank_questions | direct | `tenant_id` | — |
| question_bank_versions | direct | `tenant_id` | — |
| assignments | direct | `tenant_id` | — |
| assignment_submissions | direct | `tenant_id` | — |

Deliberate non-decisions:

- `group_courses` (many-to-many) is **not** an authority for `groups`. The 20261017_04 backfill used
  `groups.course_id` only; promoting a secondary link set to an ownership claim would deny rows the
  backfill already assigned. Raised for I2, not implemented.
- `exam_groups` is denial-only for `exams`. The binding scope names `exams.course_id` as the chain, so
  a group link may contradict but never justify inclusion. Consequence: an exam whose course carries a
  NULL tenant and whose only proof would be a group link stays unresolved (see §7).
- `students` and `grades` keep direct-only ownership. `grades.tenant_id NULL` is a *shared legacy
  catalog* row (migration 20261017_01:4-5), not tenant-owned; `students.tenant_id` is nullable and
  inferring it from `group_id` would extend the scope review's named chains.

---

## 3. Manifest v2 — coverage contract

`EXPORT_MANIFEST_VERSION` is now `2` (shape change: `coverage` + `incomplete`).

```
manifest.coverage = {
  scope: 'EXPORT_TABLE_PLAN: a declared subset … no consistent snapshot',
  included[]:  { table, rows, basis, parent, authorities[], rejected_contradictions, truncated, pages },
  omitted[]:   { table, reason, provable_rows|null, evidence|null },   // 63 entries
  omitted_children[]: { table, evidence, provable_rows|null },          // 3 entries
  rejected[]:  { table, rows, reason },
  limitations[]: string[],
  complete: false,     // always: declared subset, no snapshot, unprovable ownership excluded
  incomplete: boolean  // true on a positive gap inside the plan: truncation, budget skip, rejection
}
manifest.incomplete = coverage.incomplete
```

`included[]` is generated from the plan (never hand-maintained), so a table cannot be silently dropped
from the manifest. `omitted[]` is a hand-curated list (below) so a reviewer can check it line by line.

**No global orphan counts.** The only numbers published for omitted data are `provable_rows`, each
produced by a statement whose terminal column is NOT NULL and pinned to the tenant:
`attendance_records.tenant_id`, `lesson_completions.tenant_id`, and three parent-chain probes
(`exam_results`, `group_courses`, `student_materials`). Anything that cannot be proven is reported as a
limitation with **no count**.

---

## 4. Included / omitted coverage decision

### Included (17, unchanged from the approved plan — no table was added)

`courses, lectures, announcements, schedules, groups, branches, branch_memberships, grades, students,
student_courses, course_materials, exams, exam_questions, question_bank_questions,
question_bank_versions, assignments, assignment_submissions`

### Omitted (63 = 6 + 11 + 13 + 33)

1. **Credential/session secrets (6)** — `identity_otp_challenges, impersonation_sessions,
   parent_view_tokens, student_enrollment_invites, student_password_reset_requests, tenant_invitations`
   — secret material is never exported.
2. **Platform billing/finance (11)** — `expenses, instructor_topup_requests, payment_requests,
   platform_revenue_events, revenues, student_fees, subscription_requests, tenant_account_notes,
   tenant_billing_profiles, tenant_renewal_intents, tenant_subscriptions` — exporting needs an
   explicit privacy decision; this batch makes no financial-data change.
3. **Operational/telemetry/internal job state (13)** — `admin_work_items, audit_events,
   branch_audit_log, imports, playback_devices, playback_entitlements, playback_session_slots,
   playback_tenant_policies, student_import_batches, tenant_data_exports, video_asset_callbacks,
   video_processing_queue, video_usage_events` — not tenant content.
4. **Tenant content outside the approved plan (33)** — `attendance_records, certificates,
   exam_grading_runs, exam_version_questions, exam_versioned_answers, exam_versioned_attempts,
   exam_versions, gradebook_policies, gradebook_scores, lesson_completions, lesson_discussion_blocks,
   lesson_discussion_replies, lesson_discussion_reports, lesson_discussion_threads,
   lesson_release_policies, moderation_appeals, moderation_cases, moderation_decision_history,
   notification_consent_events, notification_delivery_receipts, notification_outbox, parent_links,
   playback_progress, question_bank_version_usages, schedule_series, schedule_sessions,
   student_enrollment_requests, tenant_branding, tenant_custom_domains, tenant_media_files,
   tenant_memberships, video_assets, videos` — **declared gaps, not endorsed exclusions.** Adding any
   of them changes the declared scope and needs an owner decision; this batch does neither.

What I refused:

- Adding the 32 missing tables (explicitly out of scope).
- Endorsing the 31 suggested exclusions wholesale. The scan's four buckets were kept as *reason text*
  but `certificates`, `tenant_branding` and `tenant_custom_domains` are re-bucketed into group 4 as
  tenant content awaiting a decision rather than "deliberately excluded".
- Reporting any orphan count, any other tenant's id, or any content of a rejected row.

---

## 5. Resource bounds (D3)

- Keyset paging: `WHERE … AND t.id > ? ORDER BY t.id LIMIT ?`. `LIMIT` is a bound parameter, never
  interpolated. Page size default `500`, validated `1..10000`.
- `maxRowsPerTable` default `50_000` — the page is sliced to the remaining allowance, so the cap is
  exact and `truncated: true` is declared.
- `maxTotalBytes` default `64 MiB` — checked per page **before** the chunk is appended; a table that
  cannot fit is written as far as it fits and marked `truncated`, and once the budget is spent the
  remaining tables move to `coverage.omitted` with reason `byte budget exhausted`.
- Overriding the caps is a test-only seam (`deps.limits`); production uses the defaults.

---

## 6. Test matrix (`server/tests/m8-tenant-export.test.ts`, 38 tests, 0 skipped)

| # | Kind | Test | Result |
|---|---|---|---|
| 1 | allow (core regression) | NULL `tenant_id` + proven parent is exported, `basis: parent`, `pages >= 1` | pass |
| 2 | deny | direct `tenant_id` contradicting the parent is rejected, counted, `incomplete: true` | pass |
| 3 | deny | two parents disagree → denied, 3 authorities declared, no `LIMIT 1`, no `MIN/MAX` | pass |
| 4 | contract | `included` = 17 in plan order, `omitted` = 63 unique with reasons, 3 `omitted_children`, `complete: false`, limitations | pass |
| 5 | leak | content proven to belong elsewhere never appears; every pin is the tenant; cursor is one of this export's ids | pass |
| 6 | bound | 7 rows / page size 3 → 3 statements, cursors `l-03`,`l-06`, all rows once in keyset order | pass |
| 7 | bound | row cap 3 → `rows: 3`, `truncated: true`, job still `completed` | pass |
| 8 | bound | 64-byte budget → `total_bytes <= 64`, `incomplete: true` | pass |
| 9–38 | regression | the 30 pre-existing assertions, retained | pass |

Existing assertions retained: every one. Two literal forms changed, both strengthened, never loosened:

- `assert.deepEqual(query.params, ['tenant-a'])` → `assertTenantPinned(query, 'tenant-a')`, which now
  checks **every** authority pin (1–3 per table, not one), that the page size is bound as a number, and
  that a keyset cursor is an id from this export's own result set. The old literal could not survive a
  second tenant pin, which the parent proof requires.
- `assert.equal(manifest.version, 1)` → `assert.equal(manifest.version, EXPORT_MANIFEST_VERSION)`.

Fixture change (not an assertion change): seeded rows now carry `__ownership`, because that column is
part of the statement's result contract; the service fails closed on a row it cannot classify.

---

## 7. Limitations / not proven

1. **No live MySQL.** Predicate semantics (`<>` vs NULL, `LIMIT ?`, correlated `EXISTS`) are proven by
   construction and statement shape, not by execution. No DB, Docker, listener or network was used.
2. **No consistent snapshot.** Each table is read in its own paged statement; `coverage.complete` is
   `false` and the manifest says so. Snapshot-transaction completeness is **not** claimed.
3. **Stale `pending` jobs — blocked on schema.** `tenant_data_exports` (migration 20261018_23:99-119)
   has no owner/lease/fencing column, so reclaiming on age would race a live worker. Nothing is
   reclaimed; a crashed job keeps returning 409 until an operator acts. Needs a fencing column (I2) and
   queue wiring (I1) — deliberately not invented.
4. **In-request processing retained.** `POST /api/tenant-exports` still runs the export inside the
   request. Reads are now bounded, but request latency is not; moving it to a worker needs the same
   queue/fencing work as (3).
5. **Unprovable rows are excluded without a count** (by design). A `tenant_id`-NULL `students` row, a
   shared `grades` row, a `courses` row with NULL tenant, or an exam whose only proof would be a group
   link is not exported and not counted. Their existence is reported as a limitation, never a number.
6. **`exam_groups` is denial-only**, so a NULL-course-tenant exam with a valid group proof stays
   unresolved. Consistent with the binding scope's named chain, but it is a real gap until I2 unifies
   `tenant_id` at write time.
7. **Omitted-table probes are lower bounds.** A probe counts rows reachable through the stated chain; a
   row reachable only through a chain not stated is not counted. A failed probe is recorded in
   `coverage.limitations` and yields `provable_rows: null`, not zero.
8. **`coverage.omitted` is a curated constant.** It was derived from the migrations' `CREATE`/`ALTER …
   tenant_id` set (76 tables, 63 outside the plan) with a read-only scan, then re-bucketed by hand. It
   is not generated at runtime, so a future migration can make it stale — it must be reviewed with any
   schema change.
9. **No acceptance.** `reported` is not acceptance; the coordinator/human decides.

---

## 8. Route file left unchanged

`server/src/routes/tenant-export.ts` needed no change: the plural API, response shapes, signed
downloads, tenant authority and the 201/409/503 paths are untouched. The memory defect was inside
`processTenantExport`, and the "runs inside the request" part cannot be fixed without a worker/scheduler
and a fencing column, both forbidden here (§7.3–7.4). Its header comment still accurately describes the
surface.

---

## 9. Commands and real output

```
$ cd server && M1_NETWORK_MODE=hermetic node --require ../scripts/m1-network-guard.cjs \
    --import tsx --test tests/m8-tenant-export.test.ts
1..38
# tests 38
# suites 0
# pass 38
# fail 0
# cancelled 0
# skipped 0
# todo 0
# duration_ms 743.3321

$ node node_modules/typescript/bin/tsc --noEmit -p server/tsconfig.json
tsc exit=0
```

`server/tsconfig.json` includes only `src/**`, so the test file is compiled by the tsx runner, not by
`tsc`. The full suite was not run (forbidden). No DB, Docker, mysqld, listener, provider, secret, install
or Git mutation was used.

---

## 10. Files and hashes

| Path | sha256 before (baseline) | sha256 after |
|---|---|---|
| `server/src/services/tenant-export.ts` | `dfc28c91b08bb3c0…` (baseline prefix) | see bridge report |
| `server/src/routes/tenant-export.ts` | `4f34622ee6ff585b…` | unchanged (`4f34622ee6ff585b7ee44811d1113cd46527592f5c64e173aa49c9015cd561d1`) |
| `server/tests/m8-tenant-export.test.ts` | `4b02e4931589fe2c…` (baseline prefix) | see bridge report |
| `docs/streams/server/W2-EXPORT-OWNERSHIP-20261020.md` | ABSENT | see bridge report |

The baseline record stores 16-hex prefixes for these paths; the full before-hash of the two changed
files cannot be recomputed because they are untracked with no committed tree and Git mutation is
forbidden. The unchanged route file confirms the prefix method matches the recorded baseline.

---

## 11. CORRECTION (2026-10-20) — `certificates` is product-excluded, not pending

**Task:** `server-w2-export-manifest-correction-20261020-01` · **Team:** storage · **Worker:**
`wb-w2-export-manifest-correction-20261020-01` · **Status:** `reported` — not acceptance, and not
acceptance of the whole W2 work. Sections 1–10 above are the previous worker's findings and are left
unchanged.

### What was wrong

§4 group 4 grouped `certificates` with "tenant content outside the approved plan … needs an explicit
owner decision". That is a *pending* decision, and it contradicts one already taken: the owner excluded
the certificate feature (A8) from the product on **2026-10-19** (`docs/17-full-feature-backlog.md:66`,
`docs/18-workflows-and-execution-approval-ar.md:33`; source, migrations and historical rows retained,
only the public mount removed). A consumer reading the old manifest would have concluded the export owes
certificate data and is merely waiting on a decision.

### What moved

- `certificates` left the `outside_plan` group (33 → 32 tables) and became its own group.
- The manifest gained a stable, machine-checkable `category` on every `coverage.omitted[]` entry, typed
  as `ExportOmissionCategory`: `credential_secret | platform_finance | operational_state |
  product_excluded | outside_plan | budget_exhausted`. The prose `reason` stays human wording; the
  category is what a regression pins. This is additive to the v2 shape — the plural API, response
  shapes, ownership proofs, privacy rules and resource caps are unchanged.
- The old reason (quoted): `tenant content outside the approved plan: adding it changes the declared
  export scope and needs an explicit owner decision, so this batch neither adds it nor endorses its
  exclusion`
- The new reason (quoted): `product-excluded by owner decision (2026-10-19): the certificate feature
  (A8) is outside the product, so certificate rows are not tenant content this export covers; the
  source, migrations and historical rows are retained, not deleted`
- `certificates` was **not** added to `EXPORT_TABLE_PLAN`, is not exported, and carries no probe
  (`provable_rows: null`, `evidence: null`). Total omitted stays **63** (6 + 11 + 13 + 1 + 32).

### Uniqueness guarantee

`EXPORT_OMITTED_GROUPS` is one curated structure, and the new test enumerates
`included ∪ omitted ∪ omitted_children` and asserts `new Set(names).size === names.length` (83 = 17 +
63 + 3). It also asserts `certificates` appears exactly once in `omitted`, and pins the per-category
counts (6/11/13/1/32), so a future move between groups cannot silently duplicate or drop a table. The
group type now carries `category`, so a table cannot be re-bucketed without naming its category.

### `complete` / `incomplete` wording

Descriptions only — no semantic change. The module header, `ExportCoverage` and `ExportManifest` now
say explicitly that `complete: false` means "declared subset, no snapshot, unprovable rows withheld"
(not "broken"), and that `incomplete: true` means "a gap was detected *inside the declared plan*: cap
truncation, budget skip, or a rejected contradiction", while `incomplete: false` never upgrades the
extract to complete.

### Test evidence

`server/tests/m8-tenant-export.test.ts`: 38 existing assertions/tests retained, nothing deleted or
loosened; 2 tests added (`certificates is declared as product-excluded…`, `the coverage enumeration
names every table at most once across all three lists`). Result **40/40 pass, 0 skipped**.

```
$ cd server && M1_NETWORK_MODE=hermetic node --require ../scripts/m1-network-guard.cjs \
    --import tsx --test tests/m8-tenant-export.test.ts
1..40
# tests 40  # pass 40  # fail 0  # skipped 0  # todo 0

$ node node_modules/typescript/bin/tsc --noEmit -p server/tsconfig.json
tsc exit=0
```

`server/tsconfig.json` includes only `src/**`; the test file is compiled by the tsx runner. The full
suite was not run (forbidden). No DB, Docker, mysqld, listener, provider, secret, install or Git
mutation was used. Files written: `server/src/services/tenant-export.ts`,
`server/tests/m8-tenant-export.test.ts`, this document.

### Remaining limits

Unchanged from §7: no live MySQL execution, no consistent snapshot, no fencing column for stale
`pending` jobs (I2/I1), in-request processing retained, unprovable rows excluded without a count.
`coverage.omitted` is still a curated constant and must be reviewed with any schema change. Whether
"product-excluded" should also remove `certificates` from any future schema inventory is an I2
coordination question, not a change made here.
