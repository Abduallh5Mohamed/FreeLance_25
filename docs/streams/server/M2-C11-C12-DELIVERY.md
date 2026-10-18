# M2 C11+C12 — schedules & announcements, and CSV student import (2026-10-18)

## Files changed
- `server/src/services/announcements.ts` — pure C11 policy: audience normalization
  (`tenant`/`branch` for announcements, `tenant`/`branch`/`group` for schedules),
  input validation (title ≤ 200, body ≤ 5000, bounds-checked audience targets),
  IANA-timezone wall-time → absolute UTC conversion (reusing
  `isValidTimeZone`/`localWallTimeToInstant` from `content-release.ts`),
  deny-by-default visibility predicates (`isAnnouncementVisibleTo`,
  `isScheduleVisibleTo`) and tenant/branch/group SQL filters
  (`buildVisibleAnnouncementFilter`, `buildVisibleScheduleFilter`).
- `server/src/routes/announcements.ts` — router factory
  `createAnnouncementsRouter(deps)`; endpoints below.
- `server/src/services/student-csv-import.ts` — pure C12 import domain: an
  RFC-4180-style reader (quoted fields, escaped quotes, CR/LF/CRLF, BOM) with
  hard byte (512 KiB), row (1000), column (40) and field-length (500) limits;
  header allow-list/deny-list (`password`, `password_hash`, `pass`, `pwd`,
  `hash` are rejected); per-row type validation; in-file + injected existing-key
  duplicate detection; `skip`/`update`/`error` resolution planning; SHA-256
  content hash; and CSV formula-injection neutralization for exported reports.
- `server/src/routes/student-import.ts` — router factory
  `createStudentImportRouter(deps)`; endpoints below.
- `server/migrations/20261018_05_announcements_import.sql` — idempotent schema
  (see below).
- `server/tests/m2-announcements.test.ts` — 30 unit + router rejection-path tests.
- `server/tests/m2-student-import.test.ts` — 21 unit + router rejection-path tests.
- `server/bootstrap/m1/manifest.json` — added the new migration's source hash
  (see disclosure below).
- `docs/streams/server/M2-C11-C12-DELIVERY.md` — this note.

## Behavior
- **Authority is server-owned.** Every staff route resolves the caller's active
  tenant authority (`owner`/`instructor`) from server rows via the injected
  `loadActiveTenantAuthority`; the tenant is the server-selected membership, never
  a client-supplied id. A missing/other authority is `403`.
- **Branch/group targets are provable-in-tenant.** A `branch` audience is only
  written after the branch is confirmed active and inside the caller's tenant; a
  `group` audience is confirmed via its owning course/tenant. Foreign targets are
  `403` and nothing is written.
- **Time is an absolute UTC instant.** Authored local wall times are converted with
  the request's IANA timezone; the timezone is retained on the row for re-editing.
  Invalid/ambiguous schedules fail closed (`400`).
- **Students see only their own audience.** Student feeds resolve the caller's
  approved, active enrollment server-side (never from the request) and filter in
  SQL: tenant rows for their tenant, branch rows only when their group's
  `branch_scope` is `branch`, group rows only for their own group. Rows outside the
  audience are never loaded.
- **Edits are optimistic and immutable-by-state.** Updates are guarded by
  `version`; a concurrent change is `409`. A `retracted`/`cancelled` row can no
  longer be edited (`409`).
- **Every mutation is audited inside the write transaction** (before/after
  snapshots), so a failed audit aborts the mutation rather than committing unaudited.
- **C12 import is idempotent and leak-proof.** `commit` is keyed on
  `(tenant_id, file_hash)` (and optional `file_key`); re-submitting the same file
  returns the original batch (`200`, `idempotent: true`) and writes nothing. No
  password/hash column is accepted, stored, or echoed. Rejected-row reports have
  every cell formula-neutralized.

## Endpoints
Announcements / schedules (staff: owner or active instructor):
- `GET /` — list tenant announcements (optional `branch_id` filter).
- `POST /` — create an announcement (`201`, audited).
- `PATCH /:id` — edit title/body/audience, version-guarded (`200`, audited).
- `POST /:id/retract` — retract (`200`, audited; `409` if already retracted).
- `GET /schedules` — list tenant schedules.
- `POST /schedules` — create a schedule (`201`, audited).
- `PATCH /schedules/:id` — edit, version-guarded (`200`, audited).
- `POST /schedules/:id/cancel` — cancel (`200`, audited; `409` if already cancelled).
Student (own audience only):
- `GET /student` — published announcements inside the caller's audience.
- `GET /schedules/student` — scheduled rows inside the caller's audience.

Student import (staff: owner or active instructor):
- `POST /preview` — parse/validate and report valid/rejected/duplicate counts; no writes.
- `POST /commit` — idempotent, audited import (`201`; `200` idempotent replay; `409` on duplicate-with-`error`).
- `GET /batches` — tenant import history.
- `GET /batches/:id/report.csv` — formula-safe rejected-row CSV (audited export).

## Schema (file only, not executed)
- `announcements` — tenant/branch audience, `status` (`published`/`retracted`),
  `published_at`/`retracted_at`, `version`.
- `schedules` — tenant/branch/group audience, `timezone`, UTC `starts_at`/`ends_at`,
  `status` (`scheduled`/`cancelled`), `version`.
- `student_import_batches` — import ledger; `UNIQUE (tenant_id, file_hash)` and
  `UNIQUE (tenant_id, file_key)`; `headers`/`rejected_rows` JSON; counts. No
  credential column.
- Adds guarded index `students(tenant_id, instructor_id)`.
- Idempotent via `CREATE TABLE IF NOT EXISTS` + `INFORMATION_SCHEMA` guard +
  `PREPARE`/`EXECUTE`.

## Tests
- Focused: `m2-announcements` 30/30, `m2-student-import` 21/21.
- Full suite: **1391 pass / 0 fail** (`node node_modules/tsx/dist/cli.mjs --test server/tests/*.test.ts`);
  baseline before this task was 1340, so +51 net.
- Typecheck: `tsc --noEmit -p server/tsconfig.json` clean.
- Each handler has both a success path and a rejection path (401 anonymous, 403
  non-staff/cross-tenant/foreign target, 400 invalid payload/CSV, 404 unknown,
  409 state/version/duplicate conflict, 500 audit-failure), plus pure-policy unit
  coverage including timezone conversion and formula neutralization.

## Open questions / follow-ups
- **Disclosed manifest edit.** `server/tests/m1-bootstrap-plan.test.ts` requires
  every migration's source hash in `server/bootstrap/m1/manifest.json`. Adding
  `20261018_05_announcements_import.sql` therefore required one entry outside this
  task's file allow-list:
  `"20261018_05_announcements_import.sql": "2cb61f3f7fa06593fc244bb54a4a66c587ae4918bd9bff3205576d10c24057ff"`.
  The bootstrap-plan test passes (2/2). The owning bootstrap stream should confirm
  the hash if it regenerates the manifest.
- **XLSX import is deferred** by the C12 contract; only CSV is supported. No new
  dependency was added to read spreadsheets.
- **Routers are intentionally unmounted.** `createAnnouncementsRouter` and
  `createStudentImportRouter` export factories but are not wired into
  `server/src/index.ts` by this task; the integration stream mounts them.
- Imported rows do not currently set a group/grade reference (no such column is
  accepted), so branch/group placement of imported students remains an explicit
  follow-up action rather than an import side effect.
