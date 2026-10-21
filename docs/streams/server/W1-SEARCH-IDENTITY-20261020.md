# W1 search identity — recovery review and completion report

**Task:** `server-w1-search-recovery-review-20261020-01` (recovery/verification of the terminated W1 run)
**Worker:** `wb-w1-search-recovery-20261020-01`, team `backend`
**Branch:** `codex/workbuddy-server` (never switched; no commit, no push, no stash, no other git mutation)

## 0. Claim and scope

Claimed the new task through `mcp__tabweb-supervisor__next_approved_task` exactly once with
`workerId=wb-w1-search-recovery-20261020-01`, `team=backend`. The original claim of
`server-w1-search-student-identity-20261020-01` was already retired by the supervisor; its token was
never read, used or printed. The claim token of this run is kept private and appears only in the
`submit_task_report` call.

The terminated worker is native session `01a15a8b-bd10-780d-be79-2d43518760a9`, agent task
`agent-98cb357b-8c62-4651-be7a-2fbe9148b508`, terminal 502 (`getaddrinfo ENOTFOUND www.workbuddy.ai`)
at `2026-10-20 21:24:31.865`, log lines 43868 / 43884–43889 of the evidence file
`WorkBuddySupervisorBridge/handoff/WORKBUDDY-W1-CLAIM-EVIDENCE-20261020.md`. It left on-disk changes
and never reported; those changes are **not mine** and are reported below strictly as inherited.

## 1. Fingerprints — before and after

Baseline was fingerprinted immediately before the claim and re-verified after all work stopped.
Only file hashes and sizes changed where noted; nothing else in the write set moved.

| File | Inherited (before) | After my work | Changed by me? |
|---|---|---|---|
| `server/src/routes/search.ts` | `c583b360f294d51a0b2ac956e80c1693d511b14f5e3791d34d8213cae6a4fceb` (11328 B) | `c583b360f294d51a0b2ac956e80c1693d511b14f5e3791d34d8213cae6a4fceb` (11328 B) | no |
| `server/src/services/search.ts` | `59d8e0ca8dddb7ac059dfc696d2790539f8199318b982891f72af1c6fcc7ae6e` (22766 B) | `59d8e0ca8dddb7ac059dfc696d2790539f8199318b982891f72af1c6fcc7ae6e` (22766 B) | no |
| `server/tests/m8-search.test.ts` | `b558228bc5493b8f52fd526320c8244cab74bff3f5901302bee5278e0400c593` (42769 B) | `4e54dacd82bee6adf81e94ce199f55816cd61cc7bbc24d28bd052d3adade0eeb` (52519 B) | **yes** (additive only) |
| `docs/streams/server/W1-SEARCH-IDENTITY-20261020.md` | `ABSENT` | new file, this document | **yes** |

(For reference, the pre-orphan baseline was `8597b5cc…` / `257261a9…` / `5d6c33e6…`, so the state I
inherited was already changed relative to that baseline. The three files are untracked in git on
`codex/workbuddy-server`; I made no commit, no push and no other mutation.)

## Section A — inherited from the terminated worker (verified, not authored by me)

I read and verified the inherited implementation. I did **not** write it and claim no authorship.

### A1. `createStudentViewerResolver` — user/enrollment identity (verified correct)

`server/src/routes/search.ts` (`STUDENT_VIEWER_SQL`, lines 189–197; resolver, lines 237–245):

- The statement is `SELECT s.user_id, s.tenant_id, grp.branch_id, grp.branch_scope FROM students s …`
  — it projects `s.user_id` (the `users.id` foreign key), never `s.id` (the enrollment-row primary
  key). The WHERE pins `s.user_id=? AND s.tenant_id=?` plus `is_active=1`,
  `approval_status='approved'` and the enrollment status/date window.
- The resolver returns `studentUserId: row.user_id` and the branch refinement
  `branchId: row.branch_scope === 'branch' ? row.branch_id : null`.
- The route binds `viewer.studentUserId` into `buildStudentSearchQuery`, whose fragment filters
  `se.user_id = ?`. The value bound is therefore the user id. Proven at the seam by the inherited
  test `W1: the production student resolver returns users.id, not the students.id row id`: with
  `students.id = 'enr-a'` deliberately different from `users.id = 'student-a'`, the captured
  candidate binding is `candidate.params[1] === 'student-a'` and `!== 'enr-a'`, and the resolver
  statement is asserted to contain `SELECT s.user_id`.

**Verdict: the identity fix is real, complete and enforced at the production seam. No change needed.**

### A2. Token cap (verified correct)

`server/src/services/search.ts`:

- `SEARCH_QUERY_MAX_TOKENS = 8` is an exported, documented constant (each token costs one `LIKE`
  predicate, so character length alone does not bound statement amplification).
- `validateSearchQuery` rejects a normalized query over the bound with a 400 (`q must contain at
  most 8 words`) — no silent truncation; and `appendTitlePrefilter` throws a `RangeError` for direct
  builder callers instead of dropping or truncating tokens.
- Covered by the inherited test `W1: the token bound is enforced explicitly at the limit and one over
  it`: at 8 tokens the route answers 200 with exactly 8 `LIKE ?` predicates; at 9 tokens the route
  answers 400 with zero SQL executed; the builder throws.

**Verdict: the bounded configuration exists and is enforced explicitly. No change needed.**

### A3. Guard set in the generated SQL (verified present)

Student candidates: tenant pin (`c.tenant_id = ?`), enrollment `EXISTS` over
`student_courses ⋈ students` with `sc.status='active'`, `se.user_id=?`, `se.tenant_id=?`,
`is_active=1`, `approval_status='approved'`, enrollment status/start/end window;
`c.is_active=1`; `l.is_published=1`, `l.archived_at IS NULL`; announcements pinned to
`a.status='published'` with the audience/branch gate bound to the server-resolved branch. Staff
path remains owner-only with no publication gate. Unified in the inherited SQL-builder tests
(tests 5–9, 12, 20–23).

**Verdict: no production source gap was found. I made zero changes to either source file.**

## Section B — changes I made and why

**One additive edit, entirely inside `server/tests/m8-search.test.ts`.** No source file was touched.

### B1. The proven gap (failing test first)

The W1 acceptance requires reproducing, at the production seam (real `createStudentViewerResolver`
+ real service + real route), not only the unequal-id positive but also the denials: foreign/other
tenant, branch restriction, unpublished content, inactive/unapproved enrollment, failing enrollment
read. The inherited suite covered the positive, the missing/foreign-row denial and the fail-closed
read, but the inherited seam double `makeStudentSeamDataAccess` (a) never served announcements or
lectures at all and (b) modeled none of the documented row-level gates, so three required denials
could not be reproduced: a deactivated enrollment still resolved a viewer, an inactive course was
still served, and other-branch/draft announcements could not be tested because the table was never
served.

I added three tests and ran them against the gate-blind double first — the required failing-test
proof (38 tests, 35 pass, 3 fail):

- `not ok 36 - W1: an inactive, unapproved or out-of-window enrollment row is denied at the resolver`
  → `a deactivated enrollment must not resolve a viewer` … `200 !== 404`
- `not ok 37 - W1: unpublished and inactive content is denied for the student at the production seam`
  → `an inactive course is denied by SQL`
- `not ok 38 - W1: branch restriction denies other-branch and draft announcements and ignores a forged branch`

### B2. The fix

Extended the seam double (same file, test-only) to mirror the documented row-level gates of the
statements the seam drives, deciding rows from the bound parameters — the SQL is never interpreted or
re-generated, and no gate logic is duplicated from the SQL builders:

- students read: enrollment visibility (active, approved, active enrollment status, start/end
  window) around the existing user/tenant match;
- student course candidates: tenant pin + enrollment EXISTS (the catalog is the enrolled set) +
  `c.is_active = 1`;
- student lesson candidates: same plus `l.is_published = 1` / `l.archived_at IS NULL`;
- student announcements: tenant pin + `a.status = 'published'` + the audience/branch gate keyed on
  the branch the generated SQL actually binds (a viewer with no proven branch binds none and only
  receives tenant-wide rows).

Every gate field defaults to "passes", so all inherited fixtures behave exactly as before. No
existing assertion was deleted, loosened or reformatted; no `any`, no `@ts-ignore`, no skipped tests
were introduced.

## 2. Reproduction evidence at the production seam

Real `createStudentViewerResolver`, real `buildStudent*` service, real route, real auth middleware;
the double only decides which rows MySQL would return from the bound parameters.

| Reproduction | Test (assertion) | Result |
|---|---|---|
| Unequal-id **positive** | `W1: the production student resolver returns users.id, not the students.id row id` — 200, `candidate.params[1] === 'student-a'` (users.id), `!== 'enr-a'` (students.id) | pass |
| Unequal-id **positive** (end-to-end) | `W1: an enrolled student with students.id != users.id sees her courses and her group branch` — results `['c-100']`, total 1; announcement params `['tenant-a','br-1','%math%']` | pass |
| Foreign/other tenant denial | `W1: a student without a row in her own tenant still gets nothing (guards unchanged)` — 404, no `FROM courses c` statement for both (a) no row and (b) row only in a foreign tenant | pass |
| Branch restriction denial | `W1: branch restriction denies other-branch and draft announcements and ignores a forged branch` — other-branch row `a-3` and draft `a-4` excluded, results exactly `['a-1','a-2']`; forged `branch_id=br-9` ignored (params stay `['tenant-a','br-1','%math%']`); unproven branch binds none (`['tenant-a','%math%']`, only tenant row) | pass |
| Unpublished/inactive content denial | `W1: unpublished and inactive content is denied for the student at the production seam` — inactive course `c-101`, unpublished lesson `l-101`, archived lesson `l-102` all excluded; only `c-100` / `l-100` returned | pass |
| Inactive/unapproved enrollment denial | `W1: an inactive, unapproved or out-of-window enrollment row is denied at the resolver` — all five variants (deactivated, pending approval, withdrawn, not-yet-started, expired) answer 404 with no candidate query | pass |
| Failing enrollment read fails closed | `W1: a failing enrollment read fails closed instead of returning an empty result` — 500, no `FROM courses c` statement | pass |

## 3. Verification commands and real output

From `server/` (hermetic, per task):

```
M1_NETWORK_MODE=hermetic node --require ../scripts/m1-network-guard.cjs --import tsx --test tests/m8-search.test.ts
```

- Inherited baseline, before any edit: `# tests 35` `# pass 35` `# fail 0`
- Gap proof (three new tests against the gate-blind double): `# tests 38` `# pass 35` `# fail 3`
- Final state: `# tests 38` `# pass 38` `# fail 0` `# skipped 0`

From the repo root:

```
node node_modules/typescript/bin/tsc --noEmit -p server/tsconfig.json
```

- `tsc exit code: 0` (baseline and after my edit)

The full test suite was **not** run (forbidden by the task).

## 4. What I verified vs what I could not prove

**Verified:**

- The inherited resolver projects/returns `users.id` and binds the user id into `se.user_id = ?`
  (source read + seam capture).
- The token bound (8) exists, is documented, rejects at the route with 400 and throws for direct
  builder callers; no silent truncation.
- All required guards survive in the generated SQL and now have positive **and** negative
  reproduction at the production seam, including the three previously unreproducible denials.
- Every inherited assertion still passes; the inherited fix and its 5 W1 tests are intact.

**Could not prove (limitations):**

- No live MySQL: the seam is a scripted data-access double over the real resolver/service/route
  under `M1_NETWORK_MODE=hermetic`; MySQL itself never executes the generated SQL, so the row-level
  gates are asserted through the exact SQL text, bindings and the double's documented mirror of the
  WHERE semantics — not through a real query plan. A live-SQL proof against a real database remains
  outstanding.
- The full suite was not run (explicitly forbidden); only `tests/m8-search.test.ts` plus the
  `server/` `tsc --noEmit` project were executed. No other consumers were re-checked.
- No DB/Docker/listeners/network/providers/secrets/installs and no git mutations were performed; the
  search router is still intentionally unmounted in production wiring.

**Nothing in this report is a claim of milestone acceptance** — `reported` is not `accepted`; the
supervisor and the human owner decide.

**Questions for the supervisor:** none blocking. Note for coordination: no production source change
was required for W1 — the terminated worker's inherited fix verified clean; the only recovery work
needed was the missing report plus the missing negative reproductions inside the owned test file.
