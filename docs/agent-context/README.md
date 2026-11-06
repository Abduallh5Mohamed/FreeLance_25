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
| Business strategy integration, journey priorities and acceptance mapping | [22-business-strategy-integration-ar.md](../22-business-strategy-integration-ar.md) (planning addition 2026-11-03; no runtime-readiness change) |
| Local business implementation, current scoped evidence and next work | [BUSINESS-IMPLEMENTATION-2026-11-03.md](BUSINESS-IMPLEMENTATION-2026-11-03.md) (guided import, final-order correction, owner lesson material UI/backend; not whole-strategy completion) |
| Student visibility and PDF boundary history | [BUSINESS-IMPLEMENTATION-2026-11-04.md](BUSINESS-IMPLEMENTATION-2026-11-04.md) (default delivery unconfigured; source schema unapplied) |
| Owner PDF ingestion implementation | [BUSINESS-IMPLEMENTATION-2026-11-05.md](BUSINESS-IMPLEMENTATION-2026-11-05.md) (producer/UI; migrations unapplied) |
| PDF adapters and student download continuation | [BUSINESS-IMPLEMENTATION-2026-11-05-BUILD-07.md](BUSINESS-IMPLEMENTATION-2026-11-05-BUILD-07.md) (explicit adapters + conditional student download UI; default runtime unconfigured) |
| PDF source withdrawal continuation | [BUSINESS-IMPLEMENTATION-2026-11-05-BUILD-08.md](BUSINESS-IMPLEMENTATION-2026-11-05-BUILD-08.md) (audited owner revocation and student offer/download denial; no object deletion) |
| J04 initial support detail boundary | [BUSINESS-IMPLEMENTATION-2026-11-05-BUILD-09.md](BUSINESS-IMPLEMENTATION-2026-11-05-BUILD-09.md) (private fixed detail projection, bounded latest replies and honest UI warning) |
| J04 reply pagination | [BUSINESS-IMPLEMENTATION-2026-11-05-BUILD-10.md](BUSINESS-IMPLEMENTATION-2026-11-05-BUILD-10.md) (same-ticket keyset pages, real older-reply UI, session fences and browser evidence) |
| J04 write reliability | [BUSINESS-IMPLEMENTATION-2026-11-05-BUILD-11.md](BUSINESS-IMPLEMENTATION-2026-11-05-BUILD-11.md) (keyed creation/replies, atomic status/audit and reload-safe read-only reconciliation; real schema acceptance pending) |
| J04 lesson support context | [BUSINESS-IMPLEMENTATION-2026-11-05-BUILD-12.md](BUSINESS-IMPLEMENTATION-2026-11-05-BUILD-12.md) (student lesson help action, shared live proof and atomic reference binding; new migration unapplied; generic support stays available) |
| J04 internal support notes | [BUSINESS-IMPLEMENTATION-2026-11-05-BUILD-13.md](BUSINESS-IMPLEMENTATION-2026-11-05-BUILD-13.md) (separate authorized notes, atomic keyed writes, read-only reload recovery and actual panel; migration unapplied) |
| Current business execution queue and remaining journeys | [BUSINESS-EXECUTION-QUEUE.md](BUSINESS-EXECUTION-QUEUE.md) (J00–J10 status, next catalog-aware student playback and external acceptance gates) |
| J04 assignment backend | [BUSINESS-IMPLEMENTATION-2026-11-05-BUILD-14.md](BUSINESS-IMPLEMENTATION-2026-11-05-BUILD-14.md) (versioned platform-support assignment/transfer and immutable recovery receipts; migration unapplied) |
| J04 assignment UI | [BUSINESS-IMPLEMENTATION-2026-11-05-BUILD-15.md](BUSINESS-IMPLEMENTATION-2026-11-05-BUILD-15.md) (bounded recipient discovery, actual claim/transfer/unassign panel, fresh current-state read after historical recovery) |
| J04 assigned queue | [BUSINESS-IMPLEMENTATION-2026-11-05-BUILD-16.md](BUSINESS-IMPLEMENTATION-2026-11-05-BUILD-16.md) (canonical self-assigned keyset reads, actual queue and refresh after assignment activity; new index unapplied) |
| J02 owner video preparation backend | [BUSINESS-IMPLEMENTATION-2026-11-06-BUILD-17.md](BUSINESS-IMPLEMENTATION-2026-11-06-BUILD-17.md) (actual owner video-reference routes, explicit course/tenant source proof and shared material/video limits; migration unapplied) |
| J02 owner video editor | [BUSINESS-IMPLEMENTATION-2026-11-06-BUILD-18.md](BUSINESS-IMPLEMENTATION-2026-11-06-BUILD-18.md) (actual lesson-manager selector/reference editor, mixed positions/count, confirmation and lifecycle/browser evidence) |
| J03 student catalog-video proof | [BUSINESS-IMPLEMENTATION-2026-11-06-BUILD-19.md](BUSINESS-IMPLEMENTATION-2026-11-06-BUILD-19.md) (private metadata and fresh batched proof; candidate status updated by BUILD-21) |
| J03 catalog video sessions | [BUSINESS-IMPLEMENTATION-2026-11-06-BUILD-20.md](BUSINESS-IMPLEMENTATION-2026-11-06-BUILD-20.md) (mounted issuance/refresh/media/heartbeat proof and durable context; new migration unapplied; broad video run has one documented premium-lecture test failure) |
| Latest business implementation — J03 student video player | [BUSINESS-IMPLEMENTATION-2026-11-06-BUILD-21.md](BUSINESS-IMPLEMENTATION-2026-11-06-BUILD-21.md) (actual student panel/catalog player, explicit consent, renewal and scope fences; 1931 frontend tests pass; schema/provider/browser/device/load acceptance remains open; next local work J02 homework/quiz binding) |
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

