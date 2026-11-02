# Local development and verification

Commands assume PowerShell at the repository root.

## Install and run

```powershell
npm install
Push-Location server; npm install; Pop-Location
npm run dev
```

`npm run dev` starts Vite and the backend. The backend's `server/dev.ps1`
starts/configures local MinIO before `tsx watch src/index.ts`.

Expected local endpoints:

- frontend: `http://localhost:8080` (Vite may choose `8081` if occupied);
- backend health: `http://localhost:3001/health`;
- MinIO API: `http://127.0.0.1:9000`;
- MinIO console: `http://127.0.0.1:9001`.

Never document or commit actual local credentials. Use `.env.example` for key
names and local `.env` files for values.

## Required configuration groups

- Database: `DB_HOST`, `DB_PORT`, `DB_USER`, `DB_PASSWORD`, `DB_NAME`.
- Auth: `JWT_SECRET`; production must also use the session/security settings
  required by the target feature.
- MinIO: `MINIO_ENDPOINT`, `MINIO_PORT`, `MINIO_USE_SSL`,
  `MINIO_ACCESS_KEY`, `MINIO_SECRET_KEY`, bucket variables.
- Optional providers/workers: only configure variables named by their current
  source contracts. Missing provider configuration must remain fail-closed.

## Cheap verification ladder

Run the smallest sufficient set first:

```powershell
# repository conflict markers
npm run check:conflicts

# frontend types and build
npm run typecheck          # tsc -p tsconfig.app.json --noEmit (covers src/tests)
npm run build

# backend types/build
npm --prefix server run build

# frontend tests: every src/tests suite plus access-control
npm run test:src

# backend hermetic suites (injected seams + isolation guard, no DB/services)
npm --prefix server run test:isolated
```

Run one or more focused tests by explicit path:

```powershell
npx tsx --test src/tests/<feature>.test.ts
npx tsx --test server/tests/<feature>.test.ts
```

The backend `npm test` runs `server/tests/*.test.ts` and is large; it still
contains suites unrelated to the isolated work that are known-red (search,
premium lectures, attendance, staff auth, migrations, work items). Use
`npm run test:isolated` for the verified hermetic set and reserve `npm test`
for when you are touching one of those areas. Do not run database/provider-bound
legacy scripts unless the test explicitly proves isolation from real DB, dotenv
defaults and external services.

## Test-writing conventions

Isolation status after the 2026-10-26 batch 4 (see
[FEATURE_MATRIX](FEATURE_MATRIX.md)):

- The M2 group harnesses now build the router through `createGroupsRouter` with
  `branchAccess` injected (`tenantScopeBranchDeps`), so `getResourceBranchDeps()`
  — and its dynamic `import('../db')` — is unreachable. The real
  `resolveResourceBranchAccess` decision still runs on every request.
- `server/tests/helpers/isolated-io-guard.ts` is the default barrier for
  hermetic suites: importing it (for its side effect) makes sockets, TLS,
  HTTP(S) clients, DNS lookups, `fetch` and `listen()` throw
  `ISOLATED_IO_BLOCKED:<capability>` immediately. A suite that falls back to a
  real pool or a real port fails fast and visibly. `isolated-io-guard.test.ts`
  is the negative control.
- Frontend transport tests read headers through `new Headers(init.headers)`
  because the shared `request` helper normalises them to a `Headers` instance.
  `ApiRequestError` carries `status` and `code`, so assertions check those
  fields rather than expecting them to be discarded.
- `node:module.registerHooks` is required by some frontend suites; Node
  **22.22.2** is the verified version (local run and the pinned CI runner).
  Do not claim those suites pass on an unverified runtime.
- Do not weaken production branch, tenant or session checks to make a fixture
  pass; fix the fixture or inject the missing seam. See
  [audit D/G](AUDIT-2026-10-26.md).

- Server route tests normally inject an in-memory data seam or a purpose-built
  harness; do not import production defaults accidentally.
- Clear/restore environment values modified by a test.
- Assert fixed DTO keys, tenant ownership, denial behavior, idempotency and
  cleanup/error paths—not only happy status codes.
- Frontend controller tests should cover stale replies, principal/session/target
  changes, disposal, duplicates and malformed transport data.

## Common startup diagnoses

### Browser shows `/api/...` 500 plus Vite `ECONNREFUSED`

The frontend proxy is alive but backend `3001` exited. Read the first backend
exception rather than debugging React.

### `MINIO_ACCESS_KEY and MINIO_SECRET_KEY are required`

Start through `npm run dev` / `server/dev.ps1`, which keeps the MinIO launcher
and Node process environment aligned. Confirm variable presence without printing
values. Do not hard-code launcher credentials in source.

### Vite moves to 8081

Port 8080 is occupied. The API proxy still targets backend 3001; use the URL
Vite prints or stop the old frontend process.

### Runtime import says an export is missing

Check both sides after merges:

```powershell
rg -n "EXPORT_NAME" src/lib/api-http.ts src
npx tsc -p tsconfig.app.json --noEmit
```

### Schema-dependent route returns 503

This may be intended fail-closed behavior. Find its verifier/readiness contract.
Do not “fix” it by assuming a migration file was applied or bypassing the
schema grant.

### Which routes need the M2-23 migration

`server/migrations/20261023_04_lesson_release_progress.sql` is a **FILE ONLY** and
has not been applied. These surfaces read its columns and fail closed (500) until
it is applied:

- `server/src/routes/course-lessons.ts` — the whole router
  (`release_at`, `prerequisite_lesson_id`);
- `server/src/routes/student-course-access.ts` — the path and completion reads
  (`release_at`, `course_lesson_completions`);
- `server/src/routes/course-units.ts` — **only the active→archived transition**,
  which proves no active lesson depends on a lesson of the unit being archived
  (`course_lessons.prerequisite_lesson_id`). Every other unit operation, including
  creating, renaming and reordering a unit, is unaffected.

Applying it is a separate authorized gate. Do not treat a 500 here as a bug to be
worked around by weakening the guard.

