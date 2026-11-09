# Responsible course teacher workspace — BUILD-61

BUILD-62: teaching-authority now locks the common active tenant row BEFORE actor/teacher rows, matching grading-authority. This fixes a reproduced teacher/grader deadlock without granting new resources or caching authority. Native mixed-role reads remain bounded smoke, not all-writer/production acceptance. Read BUILD-62 and OPERATING-ACCEPTANCE-CHECKLIST.md for measured scopes.

Mounted by authenticated tenant-self under `/api/tenants/me/catalog`.

Current academic responsibility is `courses.instructor_id`. `teaching-authority`
re-proves active live teaching user/session, non-suspended status, active teaching
membership and tenant, no center-only account and no platform-admin membership.
Billing-only, staff identities and impersonation are denied. Ownership alone is
not teaching responsibility. Missing identity/schema evidence fails closed.

GET `/teaching/courses?cursor=<lowercase uuid>` selects active courses for this
teacher/tenant only. GET `/teaching/courses/:courseId/lessons?cursor=<uuid>` first
re-proves the course and returns active units' active lessons. Both use id keyset
pages25/read26, strict DTOs (`id,name` or `id,unit_id,title`, plus next_cursor).
Ordering is discovery keyset ordering, not an asserted educational progression.
No arbitrary selector headers/body/extra query keys. Reads use no-store and one
read-only transaction, always rolled back; failed cleanup discards the connection.

Existing lesson-preparation base/groups/learning and course-return-plan routes
now use the same responsible-teacher proof. Their existing evidence/rubric,
student eligibility, attendance/time, CAS, audit and operation engines remain.
Every receipt read also re-proves current course responsibility. Course handover
invalidates old teacher access; historical receipts do not grant current scope.

GET `/courses/:courseId/return-plan/follow-up/:enrollmentId` accepts no query/body.
Teacher -> current student/group/branch -> live active enrollment/course -> saved
plan schema -> current head/revision -> each lesson's existing access proof.
An active plan also requires the existing attendance/completion schema gate.
Projection: exact course/enrollment context, checked_at, plan null or id/version/
status/steps. No student name or answer content is added to this response.
Withdrawn steps are empty; no older revision fallback. At most3 current steps:

- available: position, available=true, lesson_id, title, minutes, completed;
- unavailable: position, available=false only; identity/title/completion omitted.

Completion reads only `course_lesson_completions`, never legacy completion.
An unavailable lesson is not zero progress. Recorded completion does not prove
study-start, understanding or return-plan completion. The endpoint writes nothing.

Season reuse/template import retains actual institution-owner scope and explicit
rights/review/operation contracts, now also requires live teaching identity and
excludes mixed platform roles. Being responsible for a course grants no reuse
right. No new schema, provider, financial/access grant or source copying.

Native synthetic MySQL/HTTP/Chrome evidence and precise boundaries:
[BUILD-61](../../agent-context/BUSINESS-IMPLEMENTATION-2026-11-09-BUILD-61.md).
