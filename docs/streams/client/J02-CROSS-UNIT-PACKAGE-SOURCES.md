# J02 — bounded cross-unit package source selection — BUILD-33

## Actual entry point and requests

Opening `LessonPackagePreview` inside `CourseLessonManager` now mounts
`LessonPackageSources`. The closed panel makes no request. Opening reads one
private unit page; choosing an active unit reads one private lesson page.
Choosing a lesson does not fetch package contents until deliberate comparison.
No lesson prefetch for other units, automatic cursor draining or full-course scan.

The existing canonical `listCourseUnits` / `listCourseLessons` transports use
`limit=25`, an optional opaque cursor, and now an optional AbortSignal. Existing
call sites remain compatible. Existing strict parsers bind unit DTOs to the
fixed course and lesson DTOs to the selected unit. The picker stores only the
current 25 units and 25 lessons, one cursor per list and a small chosen-source
projection. Paging replaces rows; first-page controls restart without retaining
a cursor history. Duplicate identities, overflow, malformed/foreign DTOs and
immediately repeated/unbounded cursors fail closed.

Archived units/lessons and the destination lesson remain labelled disabled
options. The controller also rejects these selections; a selector is never
authority. Server owner/course/unit/lesson checks remain on every existing read,
and the BUILD-32 apply route derives source unit inside the verified course.
The picker adds no backend route, schema, source publication or access grant.

## Fixed source/destination context

The source is `{unitId,lessonId,title}` from the currently confirmed page.
`LessonPackagePreviewEditor` gets an immutable selected source and a component
key including course, destination unit/lesson and source unit/lesson. Comparison
uses `lessonPackageReader(course,sourceUnit)` for source and
`lessonPackageReader(course,destinationUnit)` for destination. BUILD-32 reuse
still posts to the destination path with the explicit source lesson ID; source
unit is not accepted as server-side ownership/course authority.

Choosing another unit/lesson, changing either page, clearing the unit or refreshing
immediately drops the old chosen source, comparison, selected references and
review/approval by unmounting the old child. A failed page is not an empty
successful list and cannot preserve a usable old child. Keyset ordering can
change between requests: pages are not a consistent snapshot, and first-page
refresh remains available.

## Session, cancellation and an in-flight save

Principal/session/workspace events, scope-key changes, unmount and 25-second
deadlines fence late replies and abort pending transport. A superseded unit
request cannot restore its lesson list. Invalid/cleared unit selection cancels
pending work and restores usable controls rather than leaving `loading` stuck.
No selected-source state is persisted to browser storage.

`LessonPackageReuse` reports `applying`, `recovering` and `uncertain` through a
stable lock callback. Both source controller actions and visible controls reject
changes while locked; refreshing the comparison is disabled too. This retains
the in-memory operation/recovery context while a save is unresolved. A confirmed
save unlocks selection; session invalidation hides data. Review-only requests
can be abandoned because they do not write.

Closing the whole panel/page or navigation still can lose the memory-only pending
operation locator. This does not undo work already received by the server, as
the UI warns. Cross-reload pending-operation restoration and receipt history
are still not implemented. Confirmed saves still require refreshing content
panels/comparison; they do not imply current delivery or student eligibility.

## Limits and next

Original positions/source audiences are reused; conflicts are still resolved
explicitly through the existing controls. No saved template, timing editor,
quiz pin, announcement publication, student history or allowance reset is added.
The receipt and earlier schema prerequisites remain unapplied files; existing
server review/apply fail closed without them.

Next: define a saved same-course reference template and its revision/review
semantics, then explicit destination timing without copying publication/access
or student history. Real browser/accessibility/device, schema/isolation/source
writer, query/load and provider acceptance remain separate. Local callback/SSR
and synthetic HTTP/SQL tests do not prove latency or task-time improvement.
