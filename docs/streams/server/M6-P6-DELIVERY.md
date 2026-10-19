# M6 P6 — lesson comments and Q&A (2026-10-18)

## Files changed
- `server/src/services/lesson-discussions.ts` — pure domain policy + SQL store:
  input validation and length bounds, retention window, per-user rate limiter,
  PII-free notification hook, store contract, visibility projections.
- `server/src/routes/lesson-discussions.ts` — `createLessonDiscussionsRouter(deps)`
  factory plus a production-wired default (real pool/auth/audit injected
  lazily) and `resolveProductionLessonAccess`, which reuses the composed
  content-access policy. Mounted by `server/src/index.ts`.
- `server/migrations/20261018_16_lesson_discussions.sql` — idempotent,
  guarded schema file, **authoring-only, not executed**.
- `server/bootstrap/m1/manifest.json` — added the new migration's SHA-256
  (`4e89a561…3f2da`) plus an explicit "not executed / needs isolated approval"
  unresolved note, matching `scripts/build-m1-bootstrap.mjs`.
- `server/src/index.ts` — mounts `/api/parent-links`, `/api/parent` (pre-guard),
  `/api/notification-consent` and `/api/lesson-discussions`.
- `server/tests/m6-lesson-discussions.test.ts` — 34 hermetic tests.
- `server/tests/m2-m3-mounting.test.ts` — appended mounting/anonymous-denial
  assertions (existing assertions and `EXPECTED_MOUNTS` untouched).
- `docs/streams/server/M2-M3-MOUNTING.md` — appended the M6 mount contract.
- `docs/streams/server/M6-P6-DELIVERY.md` — this note.

## Access model (enrolled only)
- Every request re-resolves access from **server rows** through the injected
  `resolveLessonAccess`/`resolveProductionLessonAccess` seam. A client-supplied
  lecture, tenant or branch is never evidence of enrollment.
- `resolveProductionLessonAccess` composes the existing `evaluateContentAccess`
  policy: the lesson must be published, not archived, in the caller's enrolled
  audience/branch, and released (immediate/scheduled/sequential; a sequential
  prerequisite is checked against the caller's own completion record).
- Staff (verified owner/instructor/admin) reach a lesson only inside their own
  tenant and only through resource-derived `resolveResourceBranchAccess`
  (`resourceType: 'lecture'`); an ambiguous branch is denied.
- A denied/unenrolled caller receives `404` for both the lesson and any thread
  (no enumeration). A cross-tenant stored row is also `404`.
- Thread/reply body is `null` unless visible; `hidden` rows are shown only to
  staff (with the moderation reason); `deleted` rows are filtered in SQL.

## Moderation
- `POST /threads/:id/moderate` and `POST /replies/:id/moderate` are staff-only.
- Actions: `hide`, `restore`, `delete`. `hide`/`delete` require a non-empty
  reason (≤300 chars) stored in `hidden_reason`; `restore` must not carry one.
- Author self-delete (`DELETE /threads/:id`, `DELETE /replies/:id`) is allowed;
  staff may delete any row in their tenant. Foreign authors get `403`.
- A shared visible row is hidden from students as soon as moderation commits.
- Every mutation writes an `audit_events` row (`thread.create`,
  `reply.create`, `thread/delete`, `reply.delete`, `thread.moderate.<action>`,
  `reply.moderate.<action>`, `discussion.report`, `discussion.block`,
  `discussion.unblock`) inside the optional transaction seam; a failing audit
  aborts the accepted write (tested).

## Deletion and retention
- Deletion is a soft delete: `deleted_at` plus `retention_expires_at`.
- `DEFAULT_RETENTION_DAYS = 180`; authored values are clamped to `1..3650`.
- `retention_expires_at` is an explicit indexed column so a future purge job can
  safely remove rows past the window. This task performs no runtime DDL and no
  purge.

## Reports and blocks
- `POST /reports` accepts `target_type` (`thread|reply`), `target_id` and a
  bounded reason. The target must exist, be inside the caller's resolved
  tenant/lesson, and not be the caller's own content. One report per reporter
  per target is enforced by `uq_disc_report`.
- Blocking is personal and tenant-scoped: `lesson_discussion_blocks` with a
  unique `(tenant_id, blocker_user_id, blocked_user_id)`. Blocking is
  idempotent and cannot target self. A block only filters thread/reply listing
  for the blocker; it never mutates the blocked user's rows. The list is
  bounded (`LIMIT 500`).

## Notifications and rate limits
- `DiscussionNotificationHook` is injected and best-effort: a failing hook never
  fails an accepted mutation. Events carry ids/tenant/lecture/author role only —
  no message bodies, contact data or other PII.
- Per-user, clock-injectable, bounded-memory limiters apply per action:
  thread create 10/min, reply 30/min, report 20/min, block 40/min → `429`.

## Schema (file only, never executed)
`server/migrations/20261018_16_lesson_discussions.sql`:
- `lesson_discussion_threads` — `status open|hidden|deleted`, moderation
  columns, `deleted_at`, `retention_expires_at`, `reply_count`,
  `last_activity_at`, `version`; indexes for
  `(tenant_id, lecture_id, last_activity_at)`, `(tenant_id, author_user_id)` and
  retention; `fk_disc_threads_tenant` → `tenants` (cascade).
- `lesson_discussion_replies` — `status visible|hidden|deleted`, same
  moderation/retention columns; `fk_disc_replies_thread` → thread (cascade),
  `fk_disc_replies_tenant` → tenants.
- `lesson_discussion_reports` — `target_type thread|reply`, bounded reason,
  `status open|reviewed|dismissed`, unique reporter/target key,
  `fk_disc_reports_tenant`.
- `lesson_discussion_blocks` — unique blocker/blocked key,
  `fk_disc_blocks_tenant`.
- Every statement is guarded by an `INFORMATION_SCHEMA` probe (+
  `PREPARE`/`EXECUTE`), FKs are name-guarded, so re-running is a no-op. No
  `DROP`, `TRUNCATE`, FK-disable or data rewrite.

## Test evidence
- `node node_modules/tsx/dist/cli.mjs --test server/tests/m6-lesson-discussions.test.ts`
  — 34/34 pass.
- `node node_modules/tsx/dist/cli.mjs --test server/tests/m2-m3-mounting.test.ts`
  — 11/11 pass (including the appended M6 assertions).
- `node node_modules/typescript/bin/tsc --noEmit -p server/tsconfig.json` — clean.
- All tests are hermetic: in-memory store, injected access resolver, injected
  clock/id factory/notification hook, real auth middleware over an injected
  principal repository. No MySQL, provider, network or `.env` usage.

## Deferred (documented, not silently promised)
- The delete-retention purge job (or scheduled task) that reads
  `retention_expires_at` is out of scope; the column and index are in place.
- Moderation queue UI/report triage tooling over the `open` report state is out
  of scope; the route stores the report and audits it.
- Real notification delivery is an injected adapter concern; the default hook is
  a no-op.
