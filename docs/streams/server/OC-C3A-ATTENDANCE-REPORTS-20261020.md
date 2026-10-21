# OC-C3a — manual-attendance reports (manual leg only) — 2026-10-20

Task: C3a of OPENCODE-C1-C8-ALLOCATION-20261020.md, executed under the CLOSURE-BATCH1 scope review (owner approval 2026-10-20). Manual leg only; no automatic/live attendance, no reconciliation, no legacy-vs-new source-of-truth decision (D6 remains HELD).

## Files created (all NEW; no existing file edited, `index.ts` not touched, nothing mounted)

| File | sha256 |
|---|---|
| `server/src/services/attendance-reports.ts` | `2c873f0fd5d709b5f6a89e2bd97c9645e8eddb052c7b69f20d794855b0adb913` |
| `server/src/routes/attendance-reports.ts` | `db9e257cde03d894156e916bea8d4cb5f01e5952669f99f8702f49b69f4afaba` |
| `server/tests/m5-attendance-reports.test.ts` | `c80ab00c39604a671bd36ab7339a009b0001613f733255e18db4e1547ec4ba0d` |
| `docs/streams/server/OC-C3A-ATTENDANCE-REPORTS-20261020.md` (this file) | (self; re-hash on delivery review if needed) |

New module deliverables are `createAttendanceReportsRouter(deps)` (unmounted factory; mounting = I1) + a pure aggregation service. No production wiring, no default export, no SQL of its own beyond the parameterized reads below; the store is injected.

## Tests (hermetic; written together with the module — stated honestly: these are acceptance tests for NEW modules, not defect-failing tests first, because the gap was "no route existed")

`node node_modules/tsx/dist/cli.mjs --test --test-force-exit server/tests/m5-attendance-reports.test.ts` → **23/23 pass, 0 fail** (2026-10-20):

1. Anonymous summary is 401 with no data access.
2. Student is denied the staff surface (403, zero record reads).
3. Instructor of another tenant denied (403, zero record reads).
4. Missing `from`/`to` bounds → 400 (all three cases).
5. Malformed bound → 400.
6. Inverted range → 400.
7. Range over the 366-day cap → 400 (error names the cap).
8. Range of exactly the max span accepted (proves the cap boundary is not off-by-one).
9. Cross-tenant/unknown `student_id`, `group_id`, `branch_id` filter → 404 **before any record read** (tenant-predicated existence check asserted on SQL + bindings).
10. Non-owner receives only the assigned-group predicate (`ss.group_id IN (SELECT id FROM \`groups\` WHERE instructor_id = ?) OR ss.created_by = ?`); injected scope args asserted exactly (`tenant-a`, `instructor-a`, `isOwner:false`); param order in SQL asserted (tenant, range, filters, visibility).
11. Owner keeps tenant-wide visibility (`1=1`, no assigned-group predicate, 3 params).
12. Optional filters reach the SQL in deterministic order (`ar.student_id`, `ar.group_id`, `ss.branch_id`).
13. Aggregate totals equal the sum of underlying rows: per-state buckets, `total`, `corrected`, and each of `by_student`/`by_group`/`by_session` folds back exactly to the top-level totals (fixture 8 rows).
14. Deterministic ordering: students/sessions ascending by id; groups NULL-first then ascending.
15. Summary truncation: 5001 rows → `X-Results-Truncated: true`, `row_count` 5000, and aggregates still equal the sum of the rows actually reported on.
16. Corrected rows counted (`corrected: 2`) while `reason`/`correction_reason` never appear in the serialized payload — asserted against store rows deliberately contaminated with `reason` and `correction_reason` fields (no passthrough leak).
17. The emitted record SELECT never contains the word `reason`; corrected is `(ar.corrected_at IS NOT NULL) AS corrected`.
18. CSV export: one row per underlying record; header `student_id,group_id,session_id,state,marked_at_utc,corrected`; formula cells (`=cmd|…`, `=HYPERLINK(…)`) neutralized via the progress-reports `escapeCsvValue`/`neutralizeCsvCell` helper (imported); corrected exported as boolean `true`/`false`.
19. Export truncation at the hard cap: 5001 fetch → exactly 5000 data lines + `X-Results-Truncated: true`.
20. Uncapped export → 2 lines + explicit `X-Results-Truncated: false`.
21. Export is audited (`INSERT INTO audit_events`): actor `owner-x`, tenant `tenant-a`, action `attendance_report.export`, `resource_type attendance_report`, payload carries range from/to, filter set, `row_count`, `truncated`, totals and `requested_at` — and no `reason` token passes through the audit either.
22. Audit failure → export fails with generic 500 `{ error: 'Failed to export attendance report' }` and no data (no ids, no states) reaches the response.
23. Store failure → generic 500 for both summary (`Failed to build attendance report`) and export (`Failed to export attendance report`); store internals never leak.

## API shape (for I1 mounting only — nothing is wired)

- Auth: `deps.authenticate` + `deps.loadActiveTenantAuthority` (server-verified authority; role labels never authority).
- `deps.buildRecordVisibility(scope)` is COPY-INJECTED: production must supply the exact predicate `routes/attendance-records.ts` applies (owner = tenant-wide; non-owner instructors only live assigned groups + own-created sessions). The router passes `{ tenantId, userId, isOwner }` and appends the returned fragment/params last in the read.
- `GET /summary?from&to[&student_id&group_id&branch_id]` → `{ tenant_id, range, filters, row_count, truncated, totals{present,absent,late,excused,total,corrected,students,sessions}, by_student[], by_group[], by_session[] }` + `X-Results-Truncated: true|false`.
- `GET /export.csv?...` → `text/csv; charset=utf-8`, one row per underlying record (`student_id,group_id,session_id,state,marked_at_utc,corrected`), formula-neutralized, audited before any byte is sent, same cap/header.
- Both: bounded range (both bounds required `YYYY-MM-DD[ HH:MM[:SS]]` UTC, `from<=to`, max 366 days — caps are technical read bounds, not new product policy), hard row cap `ATTENDANCE_REPORT_ROW_CAP = 5000`, fetch-one-past-cap truncation, aggregates computed only over reported rows (invariant "totals = sum of underlying rows" preserved under truncation).

## Schema assumptions handed to I2

Source of truth table: `attendance_records` (migration `20261018_11_schedules_attendance_records.sql`, definition read and column names copied). Assumptions relied on:

1. `attendance_records(tenant_id, session_id, group_id NULL, student_id, state ENUM('present','absent','late','excused'), marked_at DATETIME, corrected_at/corrected_by/correction_reason, UNIQUE(session_id, student_id))` — the read uses `tenant_id`, `session_id`, `group_id`, `student_id`, `state`, `marked_at` and computes `corrected` as `(corrected_at IS NOT NULL)`.
2. `schedule_sessions(id, tenant_id, branch_id, group_id, created_by)` joinable on `attendance_records.session_id = schedule_sessions.id` (existing FK). `branch_id` filter resolves through the join.
3. Optional (non-blocking, per the allocation §4d): `attendance_records(tenant_id, group_id, marked_at)` index for paged-range reads; without it queries still work, just slower. NOT applied by me.
4. Range semantics: the bounded range filters `attendance_records.marked_at` (the record's own time), mirroring the existing staff record list. The contract SQL for the store lives in the route factory and is fully parameterized. **An injected store passing the tests is NOT evidence this SQL behaves correctly against a live MySQL instance** — that proof is I2/I1's live validation, not mine.

## HELD / policy items (not decided by this task)

- `reason` / `correction_reason` visibility for any audience — undecided (D3, task text explicitly forbids exposure). The store SELECT and every response/export/aggregate never carry them; the corrected fact is exposed as boolean/count only.
- Legacy `attendance` table vs `attendance_records` as report source of truth (D6) — this module reads only `attendance_records`; no reconciliation, no `/notify-absent`, no lifecycle work (C3b).
- Product cadence/scheduling of reports and any UI surface — out of batch 1.
- `ATTENDANCE_REPORT_ROW_CAP = 5000` and `ATTENDANCE_REPORT_MAX_RANGE_DAYS = 366` are technical read caps chosen here; changing them is a config/owner decision, no behavior depends on a specific value beyond the tests.

## Limits (what an injected store does not prove)

- No SQL correctness/concurrency proof (see §Schema assumptions item at the end): hermetic tests assert the emitted SQL text + bindings, which is the gate MySQL enforces live.
- The assigned-group visibility is copy-injected (`deps.buildRecordVisibility`); the tests verify the router passes the right scope and the standard predicate is included, but the live re-checked `groups.instructor_id` subquery semantics are only as good as the production wiring I1 supplies.
- `existsInTenant`-style filter checks select `id … WHERE id=? AND tenant_id=?` only — they do not verify liveness (is_active/approval windows) for filter targets; row-level results are still tenant-scoped. This mirrors the attendance router's deny-by-default posture but is documented, not proven, for exotic states.
- Typecheck is provisional during parallel writes: `tsc --noEmit -p server/tsconfig.json` ran clean at delivery time (0 errors); full regression is deferred until all writers stop, per the batch protocol.
- Test res.send support lives locally in the test file (the shared harness has no `send` stub); the shared helpers file was NOT edited.
