# M7 O4 — content moderation / reports (2026-10-19)

Implements backlog row **O4** (`docs/17-full-feature-backlog.md`):

> `O4 | content moderation/reports | P6/C4 | queue, evidence, decision/reason,
> appeals, tenant notification, reviewer permissions`

The moderation queue is built on top of the M6 P6 lesson-discussion report table
(`lesson_discussion_reports`, owned by `server/src/services/lesson-discussions.ts`,
consumed read-only through an injected source). Nothing in the M6 service or
route is modified.

## Files

- `server/migrations/20261018_18_moderation.sql` — authoring-only, idempotent DDL
  (three tables; guarded with `INFORMATION_SCHEMA` lookups + `PREPARE`/`EXECUTE`,
  never executed here).
- `server/bootstrap/m1/manifest.json` — registered the migration's exact SHA-256
  (`7419b47c…e139`) in `sourceSha256` plus an "authoring-only / needs isolated
  approval" unresolved note.
- `server/src/services/moderation.ts` — pure domain policy: validation, decision
  → content-action mapping, content hashing, defensive projection, the SQL
  `ModerationStore`, and the injectable report-source / content-gateway /
  owner-notifier seams.
- `server/src/routes/moderation.ts` — the Express router (7 endpoints) and the
  production default-wired instance.
- `server/src/index.ts` — mounts `/api/moderation` (and the M7 `/api/platform/flags`
  and `/api/audit-logs`) after the shared `/api` guard chain.
- `server/tests/m7-moderation.test.ts` — hermetic allow/deny/cross-tenant/
  validation/failure coverage per handler.
- `server/tests/m2-m3-mounting.test.ts` — appended M7 mount + anonymous-denial
  assertions.
- `docs/streams/server/M2-M3-MOUNTING.md` — appended M7 mount section.

## Data model

| Table | Purpose |
| --- | --- |
| `moderation_cases` | one row per promoted report; tenant-scoped, `version` for optimistic concurrency |
| `moderation_decision_history` | **append-only** decision/appeal revisions (unique `(case_id, revision_no)`) |
| `moderation_appeals` | at most one appeal per case (unique `case_id`), `pending` → `resolved` |

Cases store only a **bounded, non-PII evidence snapshot**: target ids, target
status and a SHA-256 of the message body. The raw thread/reply body is never
persisted, never audited and never logged.

## Endpoints

| Method | Path | Behaviour |
| --- | --- | --- |
| GET | `/cases` | queue listing; tenant pinned for tenant moderators, optional `tenant_id`/`status`/`target_type`/`assigned_to`/`limit` for platform |
| GET | `/cases/:id` | case + append-only history + appeal |
| POST | `/cases` | promote a report; snapshots evidence; rejects unknown/unprovable/duplicate reports |
| POST | `/cases/:id/assign` | assign a verified reviewer of the case tenant (empty body ⇒ self-assign) |
| POST | `/cases/:id/decision` | record decision + reason, apply the content action, append history, audit |
| POST | `/cases/:id/appeal` | the reporter or target author files the single appeal |
| POST | `/cases/:id/appeal-decision` | a different reviewer resolves the appeal and closes the case |

## Authorization and isolation

- Deny-by-default, always after `authenticateToken`. A principal is a
  **platform moderator** only when a server-owned permission row verifies it
  (`hasVerifiedPlatformPermission('moderation.manage', userId)` — a verified
  `super_admin` or permission holder); a JWT role claim is never sufficient.
- Otherwise the principal must resolve to a server-owned **active owner /
  instructor authority inside the caller's own tenant** (`loadActiveTenantAuthority`,
  the same `TENANT_AUTHORITY_SQL` used by announcements/gradebook).
- Tenant moderators are **pinned to the server-derived tenant**: a cross-tenant
  case id, report id or reviewer is answered `404` (no enumeration). There is no
  client-supplied tenant selector.
- Filing an appeal is a **party** right (the report's reporter or the target
  content's author), not a moderator right; a non-party non-moderator gets `404`,
  a non-party moderator gets `403`.
- The appeal reviewer must differ from the **original decider** and from the
  **appellant**; a reviewer may not decide a case they reported.
- Assigned reviewers must be verified moderators of the case tenant; an unknown
  reviewer is `400`.

## Decision, appeal, audit

- `contentActionForDecision` is the single mapping (`dismiss → none`,
  `hide_content → hide`, `remove_content → delete`, `restore_content → restore`);
  the action is applied through the injected content gateway, and a `0`-row
  content result is a `409`.
- Every decision/appeal appends an immutable history revision
  (`revision_no = max + 1`, unique per case) recording decision, reason, actor
  and actor role; a history conflict is a `409`.
- Every mutation writes a sealed audit event in the **same atomic unit** as the
  state change (production uses a pooled transaction), so a failed audit aborts
  the write.
- The tenant owner is notified through an injected, PII-free notifier
  (ids/status/decision/actor only). Notification is best-effort: a notifier
  failure never fails the accepted mutation and is logged without content.

## Concurrency

All state transitions are optimistic: `assignCase` / `recordDecision` /
`setStatus` return affected rows and the route treats `0` as `409` rather than
silently overwriting; the appeal insert relies on the unique `case_id` so a
second appeal is `409` (including on `ER_DUP_ENTRY`).

## Verification

- `server/tests/m7-moderation.test.ts` — 24 tests over the real router with an
  in-memory store: allow, deny (anon / non-moderator / non-party), cross-tenant
  → `404`, validation → `400`, and failure/concurrency → `409` for every
  handler; plus audit-trail and evidence-snapshot (no raw body) assertions.
- `server/tests/m2-m3-mounting.test.ts` — the M7 mounts exist after the guard
  chain, collide with no other mount, and deny an anonymous caller with zero
  storage access.
- `npx tsc --noEmit -p server/tsconfig.json` is clean for the touched files.
- Full suite green (`node node_modules/tsx/dist/cli.mjs --test server/tests/*.test.ts`).

## Safety

The migration is **authoring-only**: it has not been executed or validated on
MySQL. Reviewers should run it against a throwaway MySQL before any fresh
staging bootstrap.
