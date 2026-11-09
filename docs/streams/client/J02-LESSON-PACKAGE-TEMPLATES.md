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

BUILD-45: application operations persist a strictly validated account/course
scoped sessionStorage marker before POST: operation/destination/template/revision,
count and canonical expected timing only. No content, credential or review token.
Reopening the course restores destination and GET-only recovery without first
loading the template list. Missing/mismatched receipts keep writing locked;
storage refusal prevents POST. Confirmed receipt plus failed marker removal stays
visibly confirmed and locked for cleanup. Receipt timing is historical.
BUILD-47 also persists create/revise/archive context through a separate strict
account/course-scoped library marker: operation ID/kind, optional target template,
expected revision and counts only; no name, source selection, body or credential.
Reload restores GET-only recovery before listing or writing. Bad storage blocks
writes; failed cleanup after confirmation retains the receipt and locks new work.
Failed status keeps confirmed evidence; fresh list reads remain explicit and
separate. Archive receipts are labelled as archive, and all receipts historical.
The production parent always supplies this store and preserves its navigation
lock. Actual Chrome/MySQL create/revise/archive lost-ACK/reload tests each issued
one write. See [BUILD-47](../../agent-context/BUSINESS-IMPLEMENTATION-2026-11-08-BUILD-47.md).
sessionStorage is not cross-browser durability; other panels need fresh reads.
Actual synthetic-demo Chrome lost-ACK/reload/GET and student metadata proof:
[BUILD-45](../../agent-context/BUSINESS-IMPLEMENTATION-2026-11-07-BUILD-45.md).
Other kinds/providers/devices/load/production remain unaccepted.

## Verification and limits

[BUILD-34](../../agent-context/BUSINESS-IMPLEMENTATION-2026-11-06-BUILD-34.md)
contains current commands/counts/logs. Tests invoke actual mounted parent,
source/application and Courses-dialog callbacks/effects using synthetic HTTP
through canonical transports, plus controller/parser tests. No real browser,
live API/schema/provider/device/load or independent acceptance is claimed. Earlier
system-Node registerHooks failures are superseded by the installed compatible
Node run, not treated as product defects.
