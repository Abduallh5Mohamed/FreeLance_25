# J05 — teacher preparation panel, v1

BUILD-61 mounts original preparation and tag-evidence panels in /teacher-workspace with strict own-course/active-lesson discovery. Backend academic scope is current responsible course teacher, not institution ownership. Choices are bounded, session/epoch fenced and deadline-limited. Existing editorial notes remain memory-only. New source authority: ../server/J05-J07-TEACHING-WORKSPACE.md.

BUILD-36 mounts a separate [tag-evidence panel](J05-LESSON-LEARNING-EVIDENCE.md)
beside this original source-preparation panel, scoped to the chosen lesson.

Mounted inside the open keyed course-details dialog in Courses.tsx. Reuses the
bounded course unit/lesson picker; each selected lesson has its own keyed panel.
Backend contract: [owner preparation evidence](../server/J05-LESSON-PREPARATION.md).

The panel auto-reads current preparation facts, shows the check time in Cairo,
bound reference count, archive/schedule caveats and deterministic preparation
issues with concrete next actions. It explicitly reports insufficient evidence
for concept rankings, repeated questions, absence and individual learning needs.
There is no inference of ability, intent, laziness or predicted student behavior.

Open evidence performs a fresh canonical authenticated/no-store read and replaces
the summary. A removed binding disappears; missing/schema/permission failures
remove the old summary. Evidence displays fixed private preparation metadata,
not content URLs, student data or questions. Editing/publishing the original
source remains in its existing editor, independently authorized.

The teacher can mark a signal useful/dismissed and enter up to 500 characters
of correction. These are explicitly memory-only drafts. Every refreshed snapshot,
lesson change, session loss or disposal clears them. No storage, telemetry,
notification or product mutation is performed. They do not prove measured benefit.

The controller aborts superseded work, enforces a 25-second deadline and separates
flight liveness from principal equality. Session/storage changes or silent identity
change at reply/error time clear private data; child invalidation hides the outer
selected-lesson picker as well. Late replies cannot restore a former lesson/account.

Current local tests include strict DTO/identity/rule/capacity checks, actual panel
effects and callbacks through synthetic HTTP, escaped titles, read-only local
decisions, fresh evidence and storage fences. Real browser/accessibility/device/
field time-saving validation and group/period educational evidence remain open.
