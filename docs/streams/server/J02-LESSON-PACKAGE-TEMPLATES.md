# J02 — private lesson-package templates and explicit destination timing (server)

BUILD-44 update: selected library-storage prerequisites were applied only to the
isolated synthetic demo. Library list/revision reads now validate exact library
storage without unrelated reference-source gates; mutations/application keep
their original full gates. Validated LIMIT lookahead is bound as a decimal
string for actual MySQL/mysql2 compatibility. Separate season imports may retain
an old-course source_lesson_id as historical provenance; it never grants access
or names an application destination. Imported refs are re-proven target-course
sources and use the existing content hash/shape. See
[import contract](J10-SEASON-TEMPLATE-IMPORT.md) and
[BUILD-44](../../agent-context/BUSINESS-IMPLEMENTATION-2026-11-07-BUILD-44.md).

Historical BUILD-34 had file-only migrations; selected storage/package sections
were later applied only to the isolated synthetic demo in BUILD-44/45. BUILD-47
adds actual Chrome/MySQL create/revise/archive lost-ACK/reload/GET proof against
the unchanged original library engine: three writes, two revisions and three
receipts, no duplicate write. No new backend source or DDL in BUILD-47. Existing
library audit remains unsealed; no provider/load/mobile/production acceptance.
See [BUILD-47](../../agent-context/BUSINESS-IMPLEMENTATION-2026-11-08-BUILD-47.md).

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

BUILD-45 adds actual MySQL/HTTP application proof on the isolated synthetic demo:
target material refs, concurrent application, receipt and release/prerequisite/
withdrawal denial. Exact schema sections/snapshots and Chrome evidence are in
[BUILD-45](../../agent-context/BUSINESS-IMPLEMENTATION-2026-11-07-BUILD-45.md).
Ready schema is not video/quiz/file delivery acceptance. Original application
audit is not newly sealed. Native mysql2 pool/checked-out connections normalize
only integer terminal SELECT LIMIT/OFFSET params to decimal strings. SQL stays
parameterized; selectors/writes and injected-store contracts are unchanged.
Reserved lesson/student routes were not edited. Native student course/path and
owner unit/lesson reads were verified through actual mounts.

See [BUILD-34](../../agent-context/BUSINESS-IMPLEMENTATION-2026-11-06-BUILD-34.md)
for exact installed-Node commands, counts and logs. Synthetic transactions now
snapshot and restore rows on rollback and preserve committed rows on lost ACK;
tests include concurrent intent and real route execution. This is not applied
MySQL schema, real isolation/locking/load or provider/browser acceptance. No
publication, quiz pin, copied student history, access or financial action is added.
