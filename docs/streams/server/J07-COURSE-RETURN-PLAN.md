# J07 — owner-reviewed return draft (read-only)

BUILD-61 supersedes owner-only proof: all original course-return-plan reads, review/save/withdraw and receipt recovery require current responsible course teacher with live teaching/session/membership proof and no platform role. Same original student/attendance/access/CAS/audit engine. New read-only current-plan follow-up: J05-J07-TEACHING-WORKSPACE.md. Ownership alone grants nothing.

BUILD-46 verified this draft/review path and the separate saved-plan journey on
the isolated synthetic demo. Selected concrete-session/attendance table creation
and saved-plan schema were applied only there. Source attendance is an explicit
fixture, not proof of the attendance editor or educational history. Visible owner
counts retain present/absent/late/excused/unrecorded as distinct evidence.
See [BUILD-46](../../agent-context/BUSINESS-IMPLEMENTATION-2026-11-08-BUILD-46.md).

BUILD-38 adds [versioned persistence/student reads](J07-SAVED-RETURN-PLANS.md).
The three draft/discovery endpoints below remain read-only. Their response now
also reports conditional persistence readiness/current header; review alone is
still not a save. New save/withdraw operations own their separate atomic commits.

BUILD-37 mounts `createCourseReturnPlanRouter` under tenant-self `/catalog`,
after authentication. No student-role impersonation or reserved student route
changes. Current active owner/caller and exact active tenant-owned course are
re-proved on every call. Billing-only and authority selector headers are denied.

- GET `/courses/:courseId/return-plan/students`: 25 active approved enrolled
  course students per keyset page, cursor is the opaque enrollment identity.
  Active user/non-suspended status and current group/course/branch integrity
  are checked. DTO is enrollment_id and name only; no contact or user IDs.
- POST `.../preview`: exact `{enrollment_id,from,to,steps}`. UTC second instants,
  [from,to), positive window at most 31 days; steps may be empty for evidence
  discovery or up to three unique lesson IDs with `minutes:null|integer 1..180`.
- POST `.../review`: same body plus review_token; at least one step. Re-reads
  current evidence and rejects changed/locked/completed choices or changed token.

Student identity comes from server student rows, not actor/session replacement.
The selected live enrollment and active published course association are verified
using existing `verifyStudentEnrollment`/`resolveStudentCourse`. The shared
suspension predicate is reused for roster eligibility.

Attendance is limited to ended, noncancelled group-audience schedule sessions of
the student's **current group** in the selected tenant/window. It is not historical
membership reconstruction. Up to 100 sessions, queried with one extra. Explicit
present/absent/late/excused are preserved; no marking row means **unrecorded**, not
absent. No sessions means no evidence of absence. Reason/correction/health details
and staff identities are never emitted. Session DATETIME values are stored UTC
and rendered in SQL as UTC strings, not decoded through the pool timezone.

Catalog evidence reads at most 500 active lessons, queried with one extra. It
uses only `course_lesson_completions` keyed by this enrollment; never the legacy
lecture/video progress store. Release compares database epoch values; prerequisite
completion is enrollment-bound. Completed or blocked lessons cannot be selected.
Each selected lesson is independently re-proved by the existing shared
`proveStudentLesson` policy on preview and review, using server-derived scope.

These checks establish base learning-path conditions only. They do not grant a
media/activity source, branch audience, file download, exam attempt, subscription
extension or new completion. Actual delivery remains behind its existing fresh
student policy. No URLs, quiz content, answers or keys are projected.

There is no established schedule-session-to-catalog-lesson relation, so the owner
manually chooses steps. Absence never automatically selects a lesson or labels a
student as struggling. Time estimates are explicit owner input or unknown, not
inferred from videos or attendance. Order is the owner's selection order.

The SHA-256 review token binds actor/tenant/course/enrollment/window/current group,
attendance evidence and selected titled steps/estimates. It excludes the check
timestamp. A token is not authority; all live gates always run again. Changed
facts yield 409. Success includes `reviewed:true, delivery:'not_sent'`: evidence
of this read/review only, **not a saved or delivered plan**.

These three draft/discovery endpoints are private no-store and SELECT-only, including POST endpoints.
Transactions rollback and release, or destroy after read/cleanup errors. No audit
or commit, no migration, write, provider or notification is introduced. Missing
tables/columns/required engines, oversized/duplicate/corrupt source sets fail closed.
Actual schema/index/query-plan/locking acceptance remains separate.
