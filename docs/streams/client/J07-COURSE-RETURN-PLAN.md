# J07 — return-plan draft UI

BUILD-38 adds [owner save/recovery and the student panel](J07-SAVED-RETURN-PLANS.md).
The draft/preview/review behavior below remains; a separate explicit save is now
available when the required storage is actually present. Review is not saving.

`CourseReturnPlan` is mounted only in the open keyed course-details dialog beside
the existing preparation/template panels. It is owner-scoped by the backend;
course/enrollment UI selectors are resources, never grants.

Journey: page through active course students, choose a UTC period, read actual
attendance and separate catalog progress, select up to three eligible incomplete
lessons and optional teacher estimates, preview, explicitly confirm review. The
review call rechecks server facts and token; changed data discards the old draft
and requires another read/review. HTML inputs are not the only validators.

The UI preserves excused/unrecorded states and clearly says that attendance has
no automatic lesson mapping, completion is not understanding and missing marks
are not absence. Lesson display uses local pages of 25 from the bounded complete
server path. Selecting a locked/completed lesson is refused in handlers as well
as disabled markup. Estimates accept only integral 1..180 minutes or unknown.

Every student/date/page change aborts requests and clears private evidence, selected
steps, review and confirmation. Editing steps/estimates clears previous review.
Failed/deadline reads remove old data; there is no stale-success or saved-plan
message. Epoch/abort checks fence late replies, separately from principal checks.
Session/storage/silent identity change invalidates names, records and drafts.

All requests use canonical authenticated no-store transport. Preview/review POSTs
are read-only; there is no student impersonation, auth/tenant selector header,
storage, publishing, sharing, copying or automatic notification. Closed dialogs
retire requests and lose this memory-only draft.

Review success explicitly says no durable plan was saved or sent. Content source
delivery must still use the original fresh student authorization; this panel
offers no direct media/quiz link or expanded eligibility. Durable reviewed-plan
storage and authorized student/family delivery remain later work.
