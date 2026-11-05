# J02 — owner-only lesson material preparation

Implemented locally 2026-11-03 following the owner's request to continue the
business plan. This is the first bounded binding slice, not student delivery or
whole-J02 acceptance. BUILD-03 also supplies the owner UI and bounded selector
described below. Several contents per lesson and separate catalog/legacy
completion ledgers are the owner's resolved product decisions.

## HTTP contract and runtime

Existing authenticated mount: `/api/tenants/me/catalog`, via
`tenant-self.ts` → `createCourseLessonsRouter`. No new default adapter or app
startup is introduced. Paths below are relative to that mount:

| Method | Path | Input / successful response |
|---|---|---|
| GET | `/courses/:courseId/units/:unitId/lessons/:lessonId/contents` | No query/body; `{contents: Content[]}` sorted by display_order/id |
| POST | same | Exactly `{material_id: UUID, display_order: integer}`; 201 `{content: Content, unchanged: false}` |
| DELETE | same + `/:contentId` | No query/body; 200 `{detached: true, content_id}` |
| GET | same + `/available-materials` | Optional UUID `cursor` only; `{materials: MaterialOption[], next_cursor: UUID or null}` |

`Content` has exactly `content_id`, `material_id`, `title`, `material_type`,
`display_order`. No file URL, video locator, tenant/owner field or provider data.
Order is 0..2147483647. Maximum 20 references per lesson. The same material
may occur in different lessons, once in each. No automatic renumbering or batch
reordering is implemented. Removing and reattaching uses separate transactions;
it is not an atomic reorder facility.

`MaterialOption` contains exactly `material_id`, `title`, `material_type`,
`is_published` (boolean). The selector includes drafts for the verified owner,
with the same parent/tenant/schema checks as the contents read. It reads at
most 26 same-course rows ordered by UUID, returns at most 25, and uses the last
visible material UUID as `next_cursor` when another row exists. Only `cursor`
is accepted; no arbitrary limit or tenant selector. There is no automatic page
draining or cross-page snapshot guarantee. No URL/contact/provider fields.

## Owner UI — BUILD-03

`CourseLessonManager.tsx` renders a collapsed `LessonContentManager` per lesson.
Opening it mounts `LessonContentEditor` and one controller bound to immutable
course/unit/lesson IDs; no per-row requests happen before opening. The picker
uses the new private selector, not the legacy unbounded material list with URLs.
Drafts are labelled and already-attached options hidden. The owner chooses an
unused integer position, can page forward or restart the material list, and
must explicitly confirm detach. Detach preserves the original material.

`lesson-contents.ts` strictly parses all external envelopes, DTO keys, UUIDs,
order bounds, uniqueness, sorted lists, publication booleans and forward cursor
progression. `api-http.ts` uses the existing authenticated `request` helper,
strict request projections and no client tenant/identity authority.

The controller has a synchronous single-flight latch. Canonical principal
checks at claim/response time, same-document session subscription, cross-tab
storage invalidation, keyed target mounting and disposal fence old replies.
Session loss clears contents/options/drafts; close/reopen creates a new lifetime.
No post-mutation automatic retry occurs. A network/5xx/malformed write outcome
requires an explicit successful read before further writes. Confirmed save plus
failed refresh retains the confirmation, labels the old list and blocks further
writes until refreshed. Options loading failure clears options and permits an
explicit reload without claiming an empty source catalog. A schema-unavailable
response displays unavailable, with no editor or fabricated known item count.

Exact repeat POST (same case-insensitive material UUID and same order) returns
200 with `unchanged: true`, with no write, audit or commit. Existing material
at another position, occupied position, or full lesson returns 409. Missing
DELETE target returns 404, with no write or audit. GET and every handler-level
failure carry `Cache-Control: no-store`. Upstream auth denials retain their
existing contract.

## Authority and consistency

Every request verifies live active user/tenant ownership before looking up the
course. Active course → selected tenant, unit → course, lesson → unit are
proved on the same connection. Role labels and client selectors never grant
authority. Billing-only access is denied before taking a connection.

Attach additionally proves `course_materials.id` + **same course_id** with a
locking read. Unpublished materials and archived lessons/units remain private
owner preparation data, matching existing owner metadata management. Attaching
does not publish or grant access. Allowed source types are existing materials
(`pdf`, `video`, `presentation`, `link`, `other`); a `video` material reference
does not prove playable media or activate streaming.

Mutation locking follows owner → course → unit → lesson, serializing concurrent
content writes before count/conflict checks. One fixed joined read, capped at
21 rows, supplies references and current source titles, with no per-row lookup.
Foreign/missing sources in existing bindings, invalid projected metadata, or
overflow fail closed with 409 rather than omitting rows. This surface does not
repair corrupt out-of-band data. If a material is later moved to another course,
the joined course predicate makes the next read fail closed.

Attach/detach and sanitized ID/order audit transitions use the existing
`audit_events` SQL seam on that transaction. Audit failure rolls back the
mutation. Deletion removes only the reference, retaining source material.
Commit failure returns 500 + `PERSISTENCE_UNCERTAIN`, destroys the connection,
and makes no rollback/success/retry claim. A client must reconcile with GET
before deliberately retrying. Begin/rollback/cleanup use the existing lifecycle.

## Schema and limits of readiness

`server/migrations/20261103_01_course_lesson_contents.sql` is an additive,
**unapplied file**. It declares two FKs, unique lesson/source and lesson/order,
and a nonnegative order check. Actual target engine/charset/collation must be
checked before any independently authorized application: the legacy material
table inherits the database default, while the lesson table declares its own.

At request time the actual `information_schema.COLUMNS` must expose the four
required columns; otherwise 503 `LESSON_CONTENTS_UNAVAILABLE`, without content
writes. This is a minimal availability gate, **not** a full FK/index/type/schema
certification. Other SQL incompatibility fails closed through the transaction
handler. No schema DDL or migration runs at runtime.

No live database, concurrent MySQL execution, query plan, real FK enforcement,
provider, authenticated browser journey or production latency was exercised. Tests use the
real router with transactional fixture SQL; a separate composition case runs
the real authentication/tenant boundaries/mount for all three verbs' owner
denial. These are local regression evidence, not production acceptance.

## Remaining steps

2026-11-04 continuation: student metadata visibility and group/branch/lesson
revalidation are implemented under [BUILD-04](J03-STUDENT-LESSON-MATERIALS-CONTRACT.md).
File/video opening remains unavailable. The student path does not accept legacy
URLs as delivery authority; the remaining delivery work below is still open.

1. Student metadata visibility and delivery gate that rechecks enrollment,
   publication, active unit/lesson, release, prerequisite and material policy.
   Do not reuse legacy material URLs as authority to bypass the catalog path.
2. Direct `video_assets` binding only after defining course authority: its
   current schema has tenant/owner but no course relationship. Same tenant
   alone is insufficient. No provider token/URL guessing.
3. Keep `course_lesson_completions` separate from legacy `lesson_completions` /
   `student_materials`; opening a material never automatically completes a
   catalog lesson. Explain the distinction when the student UI is extended.

Current tests and exact commands: [implementation record](../../agent-context/BUSINESS-IMPLEMENTATION-2026-11-03.md).
