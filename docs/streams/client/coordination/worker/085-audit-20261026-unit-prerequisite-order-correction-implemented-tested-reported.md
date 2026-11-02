# Unit prerequisite-order correction implemented, tested and reported

Task: `audit-20261026-unit-order-correction-01`
(worker `opencode-audit-unit-order-20261026`, correction lane). Supervisor alone
decides acceptance. No Git/GitHub command was used; no live DB, migration,
provider, payment, network, package install or deployment was used.

## Changed paths (exact, within allowedPaths)

- `server/src/routes/course-units.ts`
- `server/tests/m2-course-units.test.ts`

No active WorkBuddy M2-23 path was touched: `course-lessons.ts`,
`m2-lesson-release.test.ts`, the B15 contract and their helpers are unchanged.

## Behavior before → after

`PATCH /api/tenants/me/catalog/courses/:courseId/units/:unitId` previously
checked only the active→archived lesson relationship. A `display_order` change
could move a unit that holds a prerequisite after its active dependent unit, or
move a dependent unit before its prerequisite, silently breaking the student
path order `(unit.display_order, unit.id, lesson.display_order, lesson.id)`.

After the change, before the `UPDATE`, the handler proves the FINAL unit order
with two bounded `LIMIT 1` existence reads on the same transaction/connection:

- outgoing: an active lesson of the moved unit waits on an active lesson of an
  active unit that would sort AFTER the moved unit's final `(display_order, id)`;
- incoming: an active lesson of an earlier-or-tied active unit waits on a lesson
  of the moved unit.

The comparison uses the FINAL display order and the unit id as the tie-breaker,
exactly as the student path reads a tie. Reactivating an archived unit is proved
too, because its lessons return to the path. A relevant inversion answers
`409 { "error": "Course unit prerequisite order would be invalidated" }` with no
`UPDATE`, no audit row, rollback and connection release. A proof query error
fails closed (`500`, rollback, no write). A rename-only edit, a truthful no-op
and an archive are not re-judged, so an unrelated edit does not re-assert a
pre-existing out-of-band inconsistency. Tenant/course authority, archive
semantics and the single-transaction audit behavior are unchanged.

## Tests added (`server/tests/m2-course-units.test.ts`)

Hermetic fixture support for the two proof statements plus a `failOrderProof`
seam, and seven route-level tests:

1. a prerequisite unit that stays before its dependent unit is accepted (200,
   one UPDATE, one audit, commit);
2. moving a prerequisite unit after its dependent unit is refused (409, zero
   UPDATE, zero audit, rollback, release);
3. moving a dependent unit before its prerequisite unit is refused (outgoing
   direction);
4. equal `display_order` is judged by unit id, with both a refused and an
   accepted tie;
5. an unrelated rename does not run the proof or re-assert a stale inverted edge;
6. reactivating an archived unit re-proves its cross-unit edges (409 on an
   inversion, no write);
7. a failed proof query fails closed (500, zero UPDATE, zero audit, rollback,
   release).

## Verification (exact commands / results)

| Command | Result |
|---|---|
| `node --require ./.codex-audit/deny-external.cjs --import tsx --test server/tests/m2-course-units.test.ts` | 80 pass / 0 fail (73 baseline + 7 new) |
| 10-suite catalog set from `SUPERVISOR-REVIEW-2026-10-26.md` (public discovery, public identity, catalog composition, publication, lesson release, student access, course lessons, lesson reorder, course units, db transaction lifecycle) with `deny-external.cjs` | 345 pass / 0 fail |
| `npm --prefix server run build` | exit 0, no diagnostics |

## Limits

- Hermetic route/harness tests only; no live MySQL, no migration application and
  no production acceptance is claimed.
- The required `tsc` build regenerated `server/dist` build output; no source
  outside the two allowedPaths was edited.
- The task instruction's two-path scope is unchanged; the supervisor decides
  acceptance.
