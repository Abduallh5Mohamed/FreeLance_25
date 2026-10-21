# OC T1 — gradebook core — 2026-10-20

Status: stopped writing. Focused tests and typecheck are green in the current
mixed working tree. No git/DB/Docker/network/dependency changes were made.

## Scope executed

- Category-weighted calculation for valid, non-empty policy categories.
- Staff student-grade read now requires the existing course-enrollment relation.
- CSV export exposes the calculated grade while preserving the existing columns
  and the `gradebook.export` audit row.
- No roster endpoint was added (not specified by the approved backlog).

## Files changed

| File | BEFORE sha256 | AFTER sha256 |
|---|---|---|
| `server/src/services/gradebook.ts` | `24e1d8afaba6e7786b35cfeeba2236ee79f525f18a0316320f034b1a8ae7ef76` | `55d410d2eb8a3cfa7621ec3195eef5af42791302e2471523e6604b330e9982ad` |
| `server/src/routes/gradebook.ts` | `97eb2357bf92429518652eaf3d17a349fbb9ac9aafd40834256c8ae8c5eefbda` | `2a02657fffe86edec6a25ba0fed39298039221dbde7840d6a22994173481055a` |
| `server/tests/m4-gradebook.test.ts` | `21001b4f0d7a073df8a8e95d6a1401ba44845de5f0c9e23ca5ec61935dcd643f` | `7fda853301ca4e5c458990524e4a68293f4622eb9c706539e040b0816daf9b6f` |
| `docs/streams/server/OC-T1-GRADEBOOK-20261020.md` | absent (new) | this report |

## Defects reproduced before the repair

All reproductions were run first and failed against the pre-repair code.

1. **Weighted mode ignored stored policy category weights.**
   - `calculateGrade: weighted mode honors policy category weights` — failed
     `expected 83, actual 85`.
   - `calculateGrade: category weighting aggregates every item inside a category`
     — failed `expected 78, actual 76.67`.
   - `staff grade read applies the stored category weights` — failed
     `expected 83, actual 85`.
   - Repair: `services/gradebook.ts:154-180` folds each valid score into its
     policy category, then applies the category weight; `:211-212` uses this
     path when categories exist. `routes/gradebook.ts:123-141` re-validates the
     stored policy JSON and passes the categories into `calculateGrade`.

2. **`GET /students/:enrollmentId` returned a grade for an enrollment outside
   the course.**
   - `staff grade read rejects an enrollment that is not enrolled in the course`
     — failed `expected 404, actual 200`.
   - Repair: `routes/gradebook.ts:349` adds the existing
     `enrollmentInCourse` guard. That helper already ORs `groups.course_id` and
     active `student_courses` (`routes/gradebook.ts:213-222`); no new
     enrollment relation was invented.

3. **CSV export had no calculated grade.**
   - `CSV export includes the calculated grade and keeps the audit` — failed
     because `calculated_rounded` was absent from the header.
   - Repair: `routes/gradebook.ts:355-378` groups the exported score rows by
     enrollment, calculates one grade per enrollment with the loaded policy, and
     appends `calculated_percent`, `calculated_rounded`, `calculated_passed`
     after the existing six columns. The existing `gradebook.export` audit and
     its 500-on-audit-failure behavior are unchanged.

Additional documented behavior:
- `calculateGrade: empty categories are excluded from the weighted denominator`
  asserts that a category with no valid scores contributes no weight to the
  denominator.
- `calculateGrade: weighted entries fall back to entry weights when no policy
  category has scores` locks the preserved legacy path for uncategorized rows
  (`services/gradebook.ts:132-152`, `:211-212`).

## Held items (not decided here)

- **Empty-category product policy.** The implementation uses only non-empty
  valid categories, as authorized. Whether an empty category must instead count
  as a zero score for the student remains a product decision; the code location
  to revisit is `server/src/services/gradebook.ts:154-180` and its call at
  `:211-212`. The behavior is documented and tested, not treated as settled
  policy.
- **Extra credit, score caps, rounding and passing policy.** Unchanged from the
  pre-existing implementation (`server/src/services/gradebook.ts:191-219`);
  no new policy was selected.
- **Roster endpoint.** Not added. `docs/17-full-feature-backlog.md:62` (A6) only
  requires visible weighted/points policy, recomputable calculated grades and
  scoped permissions; it does not specify a roster endpoint. No authority
  contract for a new roster surface exists, so it is held.
- **Per-student branch reach for branch-scoped instructors.** The existing
  course-level branch gate (`routes/gradebook.ts:190-200`, used at `:345`) is
  preserved. There is no authoritative branch relation on
  `student_courses` (`server/migrations/20260920_00_legacy_baseline.sql:123-137`)
  and students only reach a branch through an optional group
  (`students.group_id` at `:58-80`; `groups.branch_id` added at
  `server/migrations/20261017_08_resource_branch_scope.sql:24-37`). Whether a
  branch-scoped instructor may read an enrollment from another branch of a
  course they are otherwise authorized for is therefore held rather than
  guessed. This does not block the cross-course enrollment fix at
  `routes/gradebook.ts:349`.
- **`groups.course_id` vs `student_courses`.** Both are treated as enrollment
  evidence by the existing `enrollmentInCourse` helper; this task reused that
  helper instead of choosing a canonical relation. No conflicting authoritative
  contract was introduced.

## Verification

Focused test:

```text
node node_modules/tsx/dist/cli.mjs --test server/tests/m4-gradebook.test.ts
tests 34, pass 34, fail 0
```

Before the repair the same file reported `pass 29, fail 5` (the five new
reproductions above). No assertion was weakened or skipped.

Typecheck observation (provisional while other writers are active):

```text
node node_modules/typescript/bin/tsc --noEmit -p server/tsconfig.json
(no output — clean)
```

## Limits

- Tests are hermetic with injected data access; SQL tenant/branch guards are
  asserted from statement text and bound parameters, not a live MySQL engine.
- No real concurrency, migration application, or production export consumer was
  exercised.
- Only `server/tests/m4-gradebook.test.ts` was run; no full-suite regression was
  attempted while other writers are active.
