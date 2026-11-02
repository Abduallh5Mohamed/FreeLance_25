# Sprint attendance/grades hermetic harness converted, tested and reported

Task: `audit-20261026-sprint-attendance-hermetic-harness-01`
(worker `opencode-native-sprint-attendance-hermetic-harness-20261026`, correction
lane). Supervisor alone decides acceptance. No Git/GitHub command was used; no
live DB, migration, provider, payment, network, package install or deployment was
used. Native session ID was not available to this CLI session.

## Changed paths

- `server/tests/m1-sprint-attendance-boundary.test.ts` (the only allowed path)
- Coordination report only: this file.

No production route, source, shared helper or WorkBuddy M2-23 path was edited.
`server/src/routes/attendance.ts`, `server/src/routes/grades.ts`,
`server/src/middleware/auth.ts` and `server/src/middleware/teaching-access.ts`
were read only.

## Behavior before → after

Baseline under the external-I/O denial guard: **0 pass / 29 fail**, every failure
at the suite's `Server.listen(127.0.0.1)` before route execution.

After conversion: the loopback `createServer` + `fetch` harness is gone. Each
request is dispatched in-process to the REAL `createAttendanceRouter` or
`createGradesRouter` at the prefix production mounts (`/api/attendance`,
`/api/grades`), with a synchronous express-style request/response pair. Express
still performs route matching and `req.params`; the pre-query path is normalized
to `/`, so a mount-root `?query` request cannot become an empty path.

Per request, `net.Server.prototype.listen` and `fetch` are replaced with
recorders for the duration of the call and restored afterwards; a non-empty
attempt list fails the test. Real injected auth, teaching-write, platform
permission, branch seam, fakeDb and notification seam are unchanged.

The in-memory SQL adapter was aligned with the current emitted statements (it had
drifted from the routes, which produced 500s once the listener barrier was
removed):

- added the scoped `SELECT sc.id, sc.group_id FROM students sc WHERE sc.id = ?`
  resolution used by attendance marking (barcode path already existed);
- added the serialized `transaction` seam required by the attendance duplicate
  guard, with the same `query`/`queryOne`/`execute` fake adapter;
- updated the notify-absent attendance read to the current
  `status IN ('present','late','excused')` projection.

All 29 original scenarios remain: authentication/revocation, workspace 403,
read scope, cross-tenant 404, platform read, server-derived group, duplicate
409, update/delete ownership, schema validation, Cairo default day, storage 500,
notification scope, grade read scope, real teaching entitlement, soft-delete 404
and input validation. No test is skipped and the adapter still throws on any
unhandled statement.

Two stale expectations had to follow current production, not the other way
around (production source unchanged): the attendance POST resolves the student
through its scope predicate, so an out-of-scope `student_id` is now
indistinguishable from a missing one. The two write tests that previously
expected 403 after an unscoped lookup now expect exact 404 with the same
no-insert assertions:

- `same-tenant student of another instructor`: 403 → 404, no insert;
- `student in another tenant`: 403 → 404, no insert.

This matches the existing read-boundary 404s and the foreign-barcode 404 case.
No fail-closed behavior was relaxed; 404 is not less restrictive than 403.

## Verification (exact commands / results)

| Command | Result |
|---|---|
| `node --require ./.codex-audit/deny-external.cjs --import tsx --test server/tests/m1-sprint-attendance-boundary.test.ts` | **29 pass / 0 fail / 0 skipped** (baseline 0/29) |
| `node --require ./.codex-audit/deny-external.cjs --import tsx --test server/tests/m1-attendance-calendar.test.ts` | **18 pass / 0 fail** |
| `npm run build` in `server/` | exit 0, no diagnostics |

## Limits

- Hermetic guarded tests plus a TypeScript build only; no live MySQL, migration
  application or production acceptance is claimed.
- The required build regenerated gitignored `server/dist` output; no tracked
  source outside the allowed test path was edited.
- The two 403→404 expectations are documented for supervisor review because the
  task text asked for exact statuses; the change follows the real router.
- Supervisor decides acceptance.
