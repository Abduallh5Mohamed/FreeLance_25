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
npx tsc -p tsconfig.app.json --noEmit
npm run build

# backend types/build
npm --prefix server run build

# frontend access-control smoke
npm run test:access
```

Run one or more focused tests by explicit path:

```powershell
npx tsx --test src/tests/<feature>.test.ts
npx tsx --test server/tests/<feature>.test.ts
```

The backend `npm test` runs `server/tests/*.test.ts` and can be large. Prefer a
focused suite while iterating, then expand to nearby integration contracts.
Do not run database/provider-bound legacy scripts unless the test explicitly
proves isolation from real DB, dotenv defaults and external services.

## Test-writing conventions

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

