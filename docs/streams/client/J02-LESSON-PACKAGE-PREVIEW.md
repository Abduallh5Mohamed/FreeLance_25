# J02 — owner lesson package reuse preview — BUILD-31

## Current selector continuation — BUILD-33

[Cross-unit source selection](J02-CROSS-UNIT-PACKAGE-SOURCES.md) supersedes the
original same-unit/current-page selector below. The actual entry point now loads
one unit page, then one chosen unit's lesson page. Comparison has separate source
and destination readers within the fixed course; source/page changes discard
the old child and its review. Save/recovery uncertainty locks source browsing
and comparison. The comparison itself remains advisory/read-only; BUILD-32's
explicit server review/apply remains the only copy action. Saved templates and
timing are still open. The opening scope below describes the original BUILD-31.

## Scope and actual entry point

`CourseLessonManager` mounts `LessonPackagePreview` beside the existing material,
video, activity and announcement managers of each lesson. Opening the panel
performs no network request. The owner deliberately selects a different lesson
from the currently loaded page of the **same unit and course**, then compares.
Cross-unit selection, reusable saved templates and batch copying are not implemented.
The source set is bounded by the existing lesson page; it is not a tenant scan.

This is a client composition of the existing private owner reads, not a new
backend authorization surface. Course/unit are immutable component inputs;
source/destination IDs are checked and source must be a current option. These
client constraints are selectors only: each existing route still proves the
actual owner and course/unit/lesson/source authority server-side. No tenant,
student, group or enrollment authority is taken from new request selectors.

## Requests and comparison

Four independent private GETs per lesson: `/contents`, `/videos`, `/activities`,
`/announcement`, under `/api/tenants/me/catalog/courses/:courseId/units/:unitId/lessons/:lessonId`.
If a quiz reference exists, one additional exact
`/activities/quiz/:contentId/version` read is performed. Maximum **10 requests
total**, at most 8 initial concurrent reference reads, only on deliberate compare.
No per-row prefetch, source enumeration, provider request or automatic polling.
The canonical authenticated transport and existing strict DTO parsers are reused.

Both packages must load and validate completely. Missing schema, rejection,
malformed projection, unexpected locator, foreign quiz pin or corrupt mixed
positions fail the comparison; missing data is never silently an empty package.
The mixed material/video count remains at most 20 per package. The displayed
proposed count counts new distinct material/video references, not duplicate
references already present. Shared occupied positions, same reference at a
different position and combined capacity overflow are explicit conflicts.

Homework/quiz and announcement are separate singleton slots. Different existing
source references conflict. Missing/unavailable sources, draft state, restricted
audience and differing pinned quiz versions are shown. Source/destination pinned
version numbers are displayed; missing pins are not playback/attempt readiness.
Announcement catalog publication must be reviewed again at the destination;
private source publication alone is not catalog publication.

`present` means only the reference is already bound; `review` means only a
candidate for manual review; neither means a student can access it. Material
presence never proves file scanning/delivery readiness. Video status `ready`
does not prove consent, playback session, provider or student eligibility.
Restricted audience is a warning, not a computed equality or recipient count:
existing activity headers do not expose exact group sets. Individual audience
proof remains on the original student/preview routes.

## Read lifecycle and limits

The comparison comprises separate reads, not one atomic database snapshot.
Concurrent edits may change facts between responses or after display. There is
no `can_copy` flag, reusable approval token, write plan or automatic apply.
Partial failures clear previous results. Selecting another source, closing the
panel, changing the loaded source set, unmounting, principal changes and session
events fence late responses. A 25-second deadline aborts pending reads and clears
the result; no public/legacy fallback or blind retry occurs. Rendered titles
are ordinary escaped React text. Data is not persisted in browser storage.

No reference, quiz pin, source, publication, schedule, prerequisite, enrollment,
permission, submission, attempt, grade or progress ledger is written. Existing
manual binding controls remain available; shared exam/enrollment attempt limits
are unchanged. Copying the same exam reference must not reset those limits.

## Separate reviewed apply — BUILD-32

[Reviewed reference reuse](../server/J02-LESSON-PACKAGE-REUSE.md) is now mounted
under this preview as a separate selection/server-review/approval flow. The
comparison reader and controller above remain read-only; they never authorize
the write. The former no-batch-copy limitation describes BUILD-31, superseded
only by that conditional explicit flow. New receipt schema remains unapplied.
Cross-unit UI source selection and saved templates/timing are still open.

## Apply boundary retained

Before batch apply: server-computed current review, exact selected references,
same-course parent authority and bounded locked final-state validation; atomic
reference writes plus audit; stale-review rejection; idempotency/unknown-commit
recovery; explicit exclusions for quiz pins and announcement publication.
Client comparison alone must never authorize that write. Cross-unit source
selection and timing/template persistence require an explicit bounded contract.

Local tests use synthetic HTTP responses, controller lifecycles and actual
component callbacks/SSR. They do not prove browser behavior, MySQL isolation,
applied schema, device/media delivery or acceptable request latency/load.
