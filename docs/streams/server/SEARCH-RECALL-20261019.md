# Search recall — candidate cap hardening (2026-10-19, recovery)

Task: `server-search-recall-hardening-recovery-20261019-01`
(recovery of the killed `server-search-recall-hardening-20261019-01` run;
the original worker's code edits landed, this document did not)
Branch: `codex/workbuddy-server`
Scope written: `server/src/routes/search.ts`,
`server/src/services/search.ts`, `server/tests/m8-search.test.ts`, this document.

No schema change was executed, no migration was run, no DB/Docker/network was
touched. All behaviour below is proven by injected fakes plus static asserts on
the generated SQL. The already-authored (NOT executed) index plan for the gated
candidate loads lives in `server/migrations/20261018_23_search_export.sql`.

## 1. Defect proven from source (before this batch)

The candidate SQL loaded the first `SEARCH_CANDIDATE_CAP = 500` tenant-visible
rows (`ORDER BY id ASC LIMIT 500`) with **no title filter in SQL**; title
matching ran in JavaScript afterwards (`matchScore` over the loaded rows).

Consequence: the cap bounded an arbitrary id-ordered table *prefix*, not the
matching set. With more than 500 visible rows in a kind, a row whose title
matches the query but whose id sorts after the 500th visible row could never be
loaded, so a **valid match silently disappeared** — recall was a function of
insertion order, not of relevance. The unfiltered prefilter also wasted the
candidate budget on unrelated rows.

The recall question of this task — "do valid matches beyond the first 500
disappear?" — was therefore YES before the change, and is NO after it (proof in
§3).

## 2. Behaviour after the change

- The title filter is pushed into SQL (`appendTitlePrefilter`): every token of
  the JS-normalized query becomes an escaped `LIKE ? ESCAPE '!'` predicate over
  a SQL expression that mirrors `normalizeSearchText` — MySQL 8
  `REGEXP_REPLACE` strips the same Arabic diacritic/tatweel ranges, `REPLACE`
  folds the same alef/yaa/taa-marbuta variants, `LOWER` case-folds ASCII. The
  SQL predicate is a strict superset of the exact JS normalized substring
  match (a contiguous whitespace-free token survives JS whitespace collapsing
  unchanged), so the cap now bounds **matching** rows; JavaScript still decides
  the exact match and the score.
- Every candidate statement ends with `ORDER BY <table>.id ASC LIMIT 500`, so
  the capped window — and therefore pagination — is deterministic.
- A query that normalizes to nothing appends `AND 1 = 0`: no candidate row is
  loaded at all (it could never match).
- Tenant/branch/enrollment/publication/audience gates remain in the WHERE
  clause, evaluated by MySQL BEFORE projection: tenant pin + server-derived
  values only, student enrollment EXISTS (active, approved, in-window),
  `l.is_published = 1`, `a.status = 'published'`, audience gating; the staff
  (owner) path sees every status of her own tenant only. No gate moved into JS.
- The route reports `truncated: true` when `rows.length >= 500`; `total` is
  then a lower bound of the real match count, never a global total-count claim.
- LIKE metacharacters (`%`, `_`, `!`) are escaped and tokens are bound
  parameters; user text never lands in the statement text.

| Case | Before | After |
| --- | --- | --- |
| 600 unrelated rows + 1 valid match at index 550 | match lost (never loaded) | returned (`c-0550`), `total: 1` |
| > 500 matching rows | first 500 by id, no signal | first 500 by id ranked, `truncated: true`, `total` = lower bound |
| Page 1..N over tied scores | unstable window | deterministic, no repeat/skip |
| `%`/`_`/`'`/`;` in the query | n/a (no SQL filter) | escaped/bound, statement shape unchanged |

## 3. Tests (all in `server/tests/m8-search.test.ts`, 30/30 pass)

- Recall beyond 500: `search: a valid match beyond the first 500 unrelated rows
  is still returned` (600 unrelated + later match; also asserts the LIKE filter
  precedes `LIMIT` and `ORDER BY c.id ASC` is present).
- Truncation honesty: `search: the candidate cap is reported as truncation
  instead of a false total` (600 matching rows → `total = 500`,
  `truncated = true`; 3 rows → `total = 3`, `truncated = false`).
- Pagination ties: `search: tied scores paginate deterministically across pages`
  (6 identical-score rows, 3 pages, no repeat/skip) and `paginateHits sorts by
  score and slices the requested page`.
- SQL shape: `buildStaffSearchQuery filters the normalized title in SQL before
  the cap, in id order` (all 4 staff kinds; prefilter runs on the projected
  expression, e.g. `REGEXP_REPLACE(LEFT(qb.question_text, 120), ...)`).
- Arabic normalization: unit tests on `normalizeSearchText`/`matchScore` plus
  the end-to-end `search: Arabic normalization matches folded titles
  end-to-end` (diacritics folded on both sides; the SQL prefilter receives the
  folded query `%العربيه%`).
- Wildcards/injection: `LIKE metacharacters and hostile input stay escaped
  bound parameters` (`50%_off!` → `%50!%!_off!!%`; `'; DROP TABLE courses; --`
  stays a bound token; placeholder count equals parameter count).
- Allow/deny: owner across kinds incl. question bank; non-owner staff 403;
  student question-bank 403; student enrolled/published/audience gates in SQL;
  client-supplied `tenant_id` ignored (cross-tenant attempt); student without a
  workspace 404; anonymous 401 with zero SQL; malformed input 400; DB failure
  500.

Focused run (hermetic):
`M1_NETWORK_MODE=hermetic node --require ./scripts/m1-network-guard.cjs
--import tsx --test server/tests/m8-search.test.ts` → 30 pass / 0 fail.

## 4. Prior-work note (preserved)

An earlier stabilization batch fixed 3 typecheck errors in these files
(deterministic `ORDER BY id`, type guards). Those edits were preserved
untouched; this recovery only audited them and added the missing document.

## 5. Exact limitations (residual, honest)

1. **Cap semantics:** at most 500 *matching* rows per kind are ranked. Beyond
   that, results are the 500 lowest-id matches — relevance within the cap, id
   order at the boundary. `truncated: true` + lower-bound `total` is the
   contract; consumers must not present `total` as a global count while
   `truncated` is set.
2. **Prefilter cost:** the SQL normalization expression
   (`REGEXP_REPLACE`/`REPLACE`/`LOWER`) is computed per row over the
   tenant-visible slice, which cannot use a plain index on the raw title. On
   very large single-tenant catalogs the candidate load degrades toward a scan
   of that (gated) slice. Bounded, but not indexed.
3. **Proposed follow-up (NOT executed, needs its own approval + migration
   step):** persist a normalized-title column (the exact `normalizeSearchText`
   form, Arabic folds included) on `courses.name` / `lectures.title` /
   `announcements.title` / `question_bank_questions.question_text`, maintained
   on write, with a composite index per kind starting with `tenant_id` (+ the
   visibility columns per the authored plan in
   `20261018_23_search_export.sql`). The prefilter would then compare against
   the persisted column instead of the computed expression. No SQL was written
   or run by this task.
4. **Multi-token semantics:** the SQL prefilter requires every token to appear
   (AND of per-token `LIKE`); the exact JS match additionally requires the full
   normalized query as one contiguous substring. The prefilter is intentionally
   wider (superset); only JS decides final inclusion, so no false positives
   reach the client.
5. **Score tiebreak:** `score * 1000 + min(raw title length, 255)`; the raw
   (un-normalized) title length is used deliberately and documented in the
   tests (e.g. the Arabic end-to-end case asserts score `3*1000 + 12`).
6. **MySQL 8 assumption:** `REGEXP_REPLACE` with ICU semantics; the diacritic
   character class is generated from the same code-point ranges as the JS regex
   so both sides strip exactly the same characters.
