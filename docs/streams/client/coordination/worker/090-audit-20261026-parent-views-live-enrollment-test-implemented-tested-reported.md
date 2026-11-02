# Parent views live-enrollment SQL contract corrected, tested and reported

Task: `audit-20261026-parent-views-live-enrollment-test-01`
(worker `opencode-native-parent-views-enrollment-test-20261026`, correction
lane). Supervisor alone decides acceptance. No Git/GitHub command was used; no
live DB, migration, provider, payment, network, package install, listener or
deployment was used. A real native session ID was not available to this CLI
session; only the MCP coordination label
`opencode-cli-parent-views-20261026-1223` was supplied.

Worker timer `Tabweb-OpenCode-Worker-15min` reports Windows state **Disabled**.
Its stale NextRunTime label at report time was `2026-10-26 12:33:58 +03:00`
(Africa/Cairo); that is a scheduled trigger label, not a guaranteed worker
start. Human152 directs supervisor-managed CLI; Codex review cadence is
15 minutes. No schedule was changed, enabled or restarted.

## Changed paths

- `server/tests/m6-parent-views.test.ts` (the only allowed path)
- Coordination report only: this file.

No production source, sibling test or WorkBuddy M2-23 path was edited.
`server/src/routes/parent-views.ts` was read only.

## Baseline

Supervisor's guarded failure reproduced before edits in this run:

- `sql store: every read is tenant + enrollment scoped and issues no write`
- expected progress bind `[ENROLLMENT, TENANT, ENROLLMENT]`
- actual `[ENROLLMENT, TENANT, ENROLLMENT, ENROLLMENT, TENANT]`

This is a stale test assertion, not a production defect. The current
`createSqlParentViewsStore` adds a read-time live-enrollment re-check to every
child-scoped query.

## Correction

- Added `assertLiveEnrollmentAuthority(statement, alias, viaExists)`, an explicit
  SQL-contract assertion (not fake-DB execution). It requires:
  - the five liveness predicates: `is_active = TRUE`;
    `approval_status IS NULL OR ... = 'approved'`;
    `enrollment_status IS NULL OR ... = 'active'`;
    `enrollment_start_date IS NULL OR ... <= UTC_TIMESTAMP()`; and
    `enrollment_end_date IS NULL OR ... > UTC_TIMESTAMP()`;
  - for the child read, the direct `s.id = ? AND s.tenant_id = ?` authority;
  - for progress, attendance and grades, the
    `EXISTS (SELECT 1 FROM students ls WHERE ls.id = ? AND ls.tenant_id = ?`
    authority binding the token enrollment to the exact token tenant.
- Updated ordered parameter binds to the current SQL:
  - progress: `[ENROLLMENT, TENANT, ENROLLMENT, ENROLLMENT, TENANT]` (five);
  - attendance: `[TENANT, ENROLLMENT, ENROLLMENT, TENANT]`;
  - grades: `[TENANT, TENANT, ENROLLMENT, ENROLLMENT, TENANT]`.
- Retained all existing assertions: no `execute`/write, tenant scoping, course
  and published/archived filters, explicit child projection, forbidden
  contact/note columns, bounded `LIMIT 200`, and projection/coercion tests.

## Verification (exact commands / results)

Run from `D:\FreeLance_25-1\FreeLance_25-1`.

| Command | Result |
|---|---|
| `node --require ./.codex-audit/deny-external.cjs --import tsx --test server/tests/m6-parent-views.test.ts` | baseline **17 pass / 1 fail**; after edit included in three-suite run |
| `node --require ./.codex-audit/deny-external.cjs --import tsx --test server/tests/m6-parent-views.test.ts server/tests/m6-parent-links.test.ts server/tests/m6-lesson-discussions.test.ts` | **83 pass / 0 fail / 0 skipped** |
| `npm --prefix server run build` | exit 0, no diagnostics |

## Limits

- Hermetic guarded fake-database SQL-contract tests plus a TypeScript build only;
  no live MySQL, migration application or production acceptance is claimed.
- The build may regenerate gitignored `server/dist`; no tracked source outside
  the allowed test path was edited.
- Supervisor decides acceptance and any further correction.
- Worker timer remains disabled; the next check label was
  `2026-10-26 12:33:58 +03:00` Africa/Cairo at 12:25:26, not a promised start.
