# System map

## Runtime shape

```text
Browser / React
  -> src/lib/api-http.ts (relative /api, auth/session transport)
  -> Vite dev proxy
  -> server/src/index.ts (Express composition root)
       -> authentication and authority middleware
       -> route modules in server/src/routes/
       -> domain/services in server/src/services/ and server/src/security/
       -> server/src/db.ts -> MySQL
       -> MinIO / FFmpeg / optional external adapters
```

`server/src/index.ts` is the authoritative HTTP mount list and startup/shutdown
composition root. A router or factory that is not imported and mounted there is
not part of the production HTTP runtime.

## Frontend map

| Location | Responsibility |
|---|---|
| `src/App.tsx` | Browser routes and role guards |
| `src/pages/` | Page-level views for admin/teacher/instructor/student/public flows |
| `src/features/` | Newer bounded feature adapters, controllers and components |
| `src/lib/api-http.ts` | Main HTTP adapter and DTO parsing surface |
| `src/auth/` | Access-control helpers/tests |
| `src/contexts/` | Session and application context |
| `src/components/` | Shared and legacy UI components |
| `src/tests/` | Node/TSX frontend production tests |

Principal page groups in `src/App.tsx`:

- Public/auth: `/`, `/auth`, `/login`, `/discover`, invitations and support.
- Teacher: `/teacher`, `/courses`, students, groups, attendance, fees,
  reports, content, exams and grading.
- Platform admin: `/admin/*`, including platform, approvals, team, analytics and
  security.
- Instructor: `/instructor*`, lectures, wallet, subscription and students.
- Student: `/student*`, content, lectures, exams, messages and meetings.

New frontend work should keep transport parsing separate from page rendering.
Controllers must guard against stale session/principal/target responses and
updates after disposal.

## Backend map

| Location | Responsibility |
|---|---|
| `server/src/index.ts` | Middleware order, route mounts, startup and shutdown |
| `server/src/routes/` | HTTP boundary, validation, fixed response projection |
| `server/src/services/` | Domain rules, storage, workers and composition factories |
| `server/src/security/` | Principal, tenant, capability and access rules |
| `server/src/middleware/` | Authentication, tenant/workspace and impersonation boundaries |
| `server/src/db.ts` | Shared MySQL pool and transaction helper |
| `server/migrations/` | Additive schema files; never proof of application |
| `server/tests/` | Hermetic route/service tests and harnesses |

Important global middleware ordering in `server/src/index.ts`:

1. CORS and body parsing.
2. Special parent/public boundaries.
3. Optional authentication plus tenant and student-workspace boundaries on
   `/api`.
4. Verified impersonation context.
5. Specific routers.
6. Not-found and error boundaries.

Changing this order can widen access and requires focused security regression
tests.

## Identity and authority

Supported roles are `admin`, `instructor`, `teacher`, `staff`, `student` and
`parent`. `server/src/middleware/auth.ts` verifies HS256 JWTs and re-resolves:

- live identity and token version;
- optional durable login session;
- active tenant membership for non-admin staff/teacher/instructor identities;
- selected active student workspace from server rows;
- optional live branch membership/version;
- instructor billing-only state.

Use `req.user.tenantId`, `studentEnrollmentId`, `branchId` and related resolved
fields only after the appropriate middleware. Do not authorize using request
body IDs, query IDs or unverified JWT membership claims.

## Data and storage

- MySQL access is provided by `query`, `queryOne`, `execute`, `getPool` and
  `withTransaction` in `server/src/db.ts`.
- The pool timezone is currently `+02:00`; security-sensitive release decisions
  should use explicit instants/server time rather than browser timezone guesses.
- MinIO setup is under `server/src/services/minio.ts`; assignment storage uses a
  dedicated adapter and video has separate original/HLS/thumbnail/preview
  buckets.
- Local tenant export storage is path-confined under
  `storage/tenant-exports` by default.

## Finding the actual implementation

Use mounts and symbols rather than documentation titles:

```powershell
rg -n "app.use\(" server/src/index.ts
rg -n "export default|create.*Router|create.*Runtime" server/src/routes server/src/services
rg -n "<Route path=" src/App.tsx
rg -n "describe\(|test\(" server/tests src/tests
```

