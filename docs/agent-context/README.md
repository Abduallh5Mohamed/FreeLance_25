# AI agent context — start here

Purpose: give a new agent enough verified orientation to start useful work in a
few minutes without loading the repository's large historical documentation.

Last source audit: **2026-10-26** (scoped source/build/tests; no live acceptance).
Treat status statements as a checkpoint and confirm any area you are about to
change against current source and tests. The current user instruction forbids
Git and GitHub use, including read-only commands; inspect files directly.

## Sixty-second overview

- Product: multi-tenant education/SaaS platform for platform admins, teachers,
  instructors, staff, students and parents.
- Frontend: React 18 + TypeScript + Vite, source under `src/`.
- Backend: Express + TypeScript + MySQL, source under `server/src/`.
- Object/media storage: MinIO; video processing also uses FFmpeg.
- Local ports: frontend `8080` (or next free port), backend `3001`, MinIO API
  `9000`, MinIO console `9001`.
- Browser code uses relative `/api`; Vite proxies it to `localhost:3001`.
- Authentication is JWT HS256 plus live server-side identity/session/scope
  resolution. Tenant and student workspace scope are not trusted from the UI.
- Database changes live as files in `server/migrations/`. Their presence never
  means they were applied to a particular database.

## Read only what your task needs

| Task | Read |
|---|---|
| Find a file, understand request flow or ownership | [SYSTEM_MAP.md](SYSTEM_MAP.md) |
| Decide what is complete or still open | [FEATURE_MATRIX.md](FEATURE_MATRIX.md) |
| Run, build, test or diagnose local startup | [DEVELOPMENT.md](DEVELOPMENT.md) |
| Change auth, tenant data, SQL, uploads, money or providers | [ENGINEERING_RULES.md](ENGINEERING_RULES.md) |
| Plan or hand off a bounded implementation | [TASK_PLAYBOOK.md](TASK_PLAYBOOK.md) |
| Current audit findings and plan gaps | [AUDIT-2026-10-26.md](AUDIT-2026-10-26.md) |
| Copy a bounded corrective task to WorkBuddy | [WORKBUDDY-NEXT.md](WORKBUDDY-NEXT.md) |
| Independent review of WorkBuddy's five batches | [SUPERVISOR-REVIEW-2026-10-26.md](SUPERVISOR-REVIEW-2026-10-26.md) |
| Copy the required follow-up corrections | [WORKBUDDY-CORRECTIONS-2026-10-26.md](WORKBUDDY-CORRECTIONS-2026-10-26.md) |
| Current OpenCode delegation and 15-minute supervision | [OPENCODE-SUPERVISION-2026-10-26.md](OPENCODE-SUPERVISION-2026-10-26.md) |

## Fast task-start checklist

```powershell
rg --files src server/src server/tests
rg -n "<symbol-or-route>" src server/src server/tests
```

Then read the target file, its nearest tests, and any imported authorization or
data-access seams. Do not infer behavior from filenames alone.

## Documentation hygiene

The repository root has many legacy `*_DONE.md`, deployment scripts, SQL
helpers and troubleshooting notes. Use them only when the current task directly
names them. The maintained orientation set is this directory; product contracts
remain under `docs/contracts/` and `docs/streams/`.

