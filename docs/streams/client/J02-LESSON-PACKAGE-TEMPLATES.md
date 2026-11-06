# J02 — private lesson-package templates and destination timing (client)

State: implemented and mounted in the owner course-details dialog.

## Mount

`src/pages/Courses.tsx` renders `LessonPackageTemplates key={selectedCourse.id}`
inside the existing details dialog, only while the dialog is open and a course
is selected. It is keyed by the course resource id; changing/closing the course
unmounts the panel and aborts its requests. No new route or tenant selector.

## Files

- `src/features/catalog/lesson-package-templates.ts` — exact response parsers,
  canonical selection, library/application transports and controllers.
- `src/features/catalog/lesson-template-timing.ts` — UTC parsing, canonical
  wire timing, Cairo display label.
- `src/features/catalog/LessonPackageTemplates.tsx` — active-template library,
  create from a chosen source lesson, append revision, archive, destination
  picker and review/apply/recover journey.
- `src/features/catalog/LessonTemplateTiming.tsx` — keep/set/clear editor.
- Reuses `LessonPackageSources` for bounded unit/lesson selection and
  `lessonPackageReader` for the selected source snapshot.

## Journey

1. Owner opens their course details dialog.
2. “حفظ قالب من حصة” loads an active source lesson, shows its material/video/
   homework/quiz/announcement references, and saves only checked references
   under a name.
3. Template rows show status and head revision. “إضافة مراجعة من مصدر” appends an
   immutable revision using the current head revision as the expected value.
   “أرشفة” removes the template from the active library without deleting
   revisions.
4. “تطبيق على حصة” selects a destination lesson, template and persisted revision,
   then edits timing: keep, explicit UTC, or clear.
5. Review renders the server's current items, conflicts, audience note and
   current/proposed timing. Apply is disabled until the owner expressly checks
   the confirmation box.
6. Saved shows only server-returned counts and timing; it explicitly tells the
   owner to refresh lesson sections/comparison rather than claiming the local
   lists were refreshed.
7. Lost write acknowledgement freezes controls and offers GET receipt recovery;
   it never retries the write under a new operation id.

## Safety properties

- Every request uses `authenticatedApiFetch`; no auth or tenant headers are
  fabricated. The session is re-checked through `subscribeSessionChange` and
  `readCourseSessionPrincipal`; a late reply after a session/principal change is
  discarded.
- Timing accepts only explicit UTC (`Z`) input. The Cairo label is display-only.
  No timezone conversion is guessed from the browser.
- The review token is opaque; the UI does not invent or bind its own authority.
- Titles are rendered as text, not HTML.
- The template UI states that the source audience/publication is unchanged and
  that a saved template is not a grant.

## BUILD-34 lifecycle contract

Create/revise/archive use private durable operation IDs just like application.
Unknown, malformed, timed-out and 5xx write replies freeze conflicting controls;
GET recovery for the exact operation is the only offered reconciliation. Missing
or failed receipt lookup stays uncertain. Confirmed success survives a failed
subsequent list refresh, and stale lists are cleared rather than called current.

Application review/receipts must match the requested template, loaded revision,
destination and timing. Revision history has bounded first/next page replacement
and explicit selection; no async response selects a version automatically. Template,
page, revision and timing changes clear review/confirmation. Keep/set/clear UTC
normalizes to server timestamp seconds/range; Cairo remains a display label.

Library/application pending state locks parent create/revise/archive/refresh/page,
source selection and internal close controls, including the enclosing Courses
Dialog onOpenChange and close button. Handlers/controllers also refuse admission,
so old callbacks cannot discard recovery. Callbacks are stable. Session/privacy
invalidation always takes precedence and clears private metadata; storage/session
listeners, abort cleanup and 25-second read/write deadlines fence late replies.

Whole-page or route departure still loses the in-memory operation context; a
beforeunload warning is best effort, not durable recovery or cancellation. No
sensitive template data is persisted in browser storage. Other existing lesson
panels require their own fresh reads after confirmed application.

## Verification and limits

[BUILD-34](../../agent-context/BUSINESS-IMPLEMENTATION-2026-11-06-BUILD-34.md)
contains current commands/counts/logs. Tests invoke actual mounted parent,
source/application and Courses-dialog callbacks/effects using synthetic HTTP
through canonical transports, plus controller/parser tests. No real browser,
live API/schema/provider/device/load or independent acceptance is claimed. Earlier
system-Node registerHooks failures are superseded by the installed compatible
Node run, not treated as product defects.
