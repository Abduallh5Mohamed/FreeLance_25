# J02 — private lesson-package templates and explicit destination timing (server)

State: corrected locally in BUILD-34; independent/live acceptance remains separate. Migrations are FILE ONLY and were not applied.

## Ownership and authority

- Mounted at `/api/tenants/me/catalog` from `server/src/routes/tenant-self.ts`.
- Every request re-verifies, on the same transaction connection:
  - the tenant owner relationship (`tenants.owner_user_id` + active caller),
  - the course belongs to the server-selected tenant and is active,
  - for apply/review/status, the unit belongs to that course and the lesson
    belongs to that unit.
- Client tenant/student/enrollment/instructor selector headers are rejected.
- Billing-only accounts are denied before work starts.
- No client-selected tenant, course or lesson id is treated as authority.

## Endpoints

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/courses/:courseId/lesson-templates` | active templates, 25/page |
| POST | `/courses/:courseId/lesson-templates` | create named template + revision 1 |
| GET | `/courses/:courseId/lesson-templates/:templateId/revisions` | persisted revisions |
| POST | `/courses/:courseId/lesson-templates/:templateId/revisions` | append immutable revision |
| PATCH | `/courses/:courseId/lesson-templates/:templateId` | archive (`{status:"archived",operation_id}`) |
| POST | `/courses/:courseId/units/:unitId/lessons/:lessonId/lesson-template-review` | re-read current facts and issue a review token |
| POST | `/courses/:courseId/units/:unitId/lessons/:lessonId/lesson-template-apply` | apply reviewed references + timing atomically |
| GET | `/courses/:courseId/units/:unitId/lessons/:lessonId/lesson-template-operations/:operationId` | durable receipt lookup only |

Create body: `{name, source_lesson_id, selections:[{kind,source_id}], operation_id}`.
Revision body: `{source_lesson_id, selections, expected_revision, operation_id}`.
Review body: `{template_id, revision_number, timing:{mode,...}}`.
Apply body adds `review_token` and `operation_id`.
Timing: `keep` (`{mode:"keep"}` or null `release_at`), `set`
(`release_at` explicit UTC ISO `...Z`), `clear` (`release_at:null`).

## Data written

- `lesson_package_templates`: tenant/course-scoped name, status, head revision.
- `lesson_package_template_revisions`: immutable count/hash snapshots.
- `lesson_package_template_references`: kind, source id, original media
  `display_order`; no content, URL, key, student data or grant.
- `lesson_template_operations`: tenant/operation primary key, actor, destination,
  template/revision, timing, request hash and counts for idempotent replay.

Migrations:
`server/migrations/20261106_10_lesson_package_templates.sql`,
`server/migrations/20261106_11_lesson_template_operations.sql`.

## Review/apply invariants

- The template must be active; archived templates cannot be applied or revised.
- The stored revision must exist; stored references are bounded and validated.
- The destination lesson and unit must be active.
- Every source reference is re-read through the shared final-state engine used by
  direct package reuse; unavailable sources conflict rather than copy anything.
- Position conflicts, occupied activity slots and capacity overflow block apply.
- `review_token` binds actor, tenant, course, destination, template revision,
  stored references, source facts, items and timing. Apply recomputes it.
- Timing only changes `course_lessons.release_at` for the one destination
  lesson. It never touches the template or source lessons.
- References, timing, audit and receipt are written on one transaction.
- If the process loses the commit acknowledgement the route answers
  `PERSISTENCE_UNCERTAIN`; the client must use the GET receipt endpoint and must
  not retry the write with a new operation id. Reuse of an operation id with a
  different identity/hash returns `TEMPLATE_OPERATION_CONFLICT`.
- Fail closed with `LESSON_TEMPLATES_UNAVAILABLE` when the required schema or
  shared reference tables are absent.

## Audit

`course_lesson_template.created`, `.revised`, `.archived`, `.applied` are written
through the existing `recordAudit` with redacted `snapshotRow` values. Apply
records operation id, template/revision, stored references, timing from/to and
created/existing counts.

## BUILD-34 correction contract

Library create/revise/archive each require a fresh UUID operation_id. The new
lesson_template_library_operations table stores a historical outcome and payload
hash atomically with writes/shared audit. Matching replay returns that original
outcome without mutating; mismatched actor/course/kind/hash conflicts. Current
owner/course authority is still proved on every request. Already archived writes
commit their own no-change receipt without duplicating the archive audit.

GET /courses/:courseId/lesson-templates/operations/:operationId returns
{operation:null} or {operation:{operation_id,operation_kind,...originalOutcome}}.
The originalOutcome for revise includes template_id AND a complete template
summary (including name). All endpoints are private no-store. Missing receipt
never proves cancellation; a commit error destroys the connection and is uncertain.
Library list/revisions default to 25 rows, max request limit 50.

Review and application/recovery DTOs include exact context:
{template_id,revision_number,lesson_id}. The review also binds every current
destination binding, source fact and explicit keep/set/clear timing. The apply
payload hash binds the review_token too. Status is read-only historical evidence,
not proof that mutable lesson/source facts still have the same state now.

The runtime gate inspects types, required lengths/nullability, binary identity/
hash collations, enums, InnoDB engines, unique indexes and revision/template FKs
for all five new tables. Stored reference positions/types, mixed positions,
singletons, source/count/media bounds and content_hash are validated before planning.
Direct reuse and templates share planLessonPackageFinalState and reference writes.

## Verification and limits

See [BUILD-34](../../agent-context/BUSINESS-IMPLEMENTATION-2026-11-06-BUILD-34.md)
for exact installed-Node commands, counts and logs. Synthetic transactions now
snapshot and restore rows on rollback and preserve committed rows on lost ACK;
tests include concurrent intent and real route execution. This is not applied
MySQL schema, real isolation/locking/load or provider/browser acceptance. No
publication, quiz pin, copied student history, access or financial action is added.
