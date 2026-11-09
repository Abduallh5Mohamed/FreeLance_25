# J10 — Course settings reuse UI, BUILD-43

The explicit history action reads a private 25-record page of stored creation
snapshots, retained across panel reload. Period/name/date labels describe the
creation time, not current publication or availability. It replaces one page,
requires live owner proof, hides on session change, refuses while saving/unknown,
and does not silently refresh or mutate the original course list. Confirmed
creation clears the previous history page until a fresh read.

`Courses.tsx` mounts collapsed `SeasonCourseReuse`. Opening is not a private read.
Explicit buttons read one 25-row page of existing academic periods and owner
courses. Academic-period creation/editing remains in its existing institution
dashboard card; the new workbench does not create another registry.

User chooses a period/source, enters the new draft name, confirms the right to
reuse its settings/description, previews all copied fields and the period's
date-only bounds, then explicitly confirms draft creation. Changing any input
or reading another selector page discards the review. A new course-list read is
separate from a confirmed historical creation receipt.

The panel states the scope: settings only, zero initial price, unpublished draft,
no generated schedule, no students/fees/permissions and no copied templates or
lesson content. It must not call this whole-season migration or template reuse.

The canonical authenticated relative transport validates exact DTOs and target
bindings. Controller fences identity/session/epoch/disposal/25-second deadlines.
Current account/workspace changes hide private state. Saving/unknown/recovery
blocks writes and selector actions. A minimal sessionStorage marker contains
only operation, source-course and period UUIDs, not content/name/review token.
Storage refusal prevents POST. Reload permits GET-only reconciliation, never
automatic repetition. Unknown/missing/mismatched receipt stays locked.

Confirmed creation survives refresh or marker cleanup failure. Cleanup failure
requires reopening/reconciling before writing again. Definite conflict clears
approval and needs a new review. No unverified optimistic course is inserted in
the original course list. React renders copied text without raw HTML.

Local tests cover controller failure behavior, strict projections, canonical
transport and actual panel callbacks. Installed desktop Chrome also ran login,
selection/review/confirmation and actual draft creation against isolated MySQL.
Mobile, accessibility, production and provider acceptance remain separate.
