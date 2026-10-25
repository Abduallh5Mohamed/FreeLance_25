# Source integration handoff — 2026-10-25

This checkpoint combines the platform source campaign with main's M2 workflows. It is not runtime acceptance.

## Current integration

- Export ownership now requires a private verifier-issued catalog report tied to the exact data-access object. Column shape, enforced ownership CHECK expressions, InnoDB, NO PAD and the exact primary key are measured explicitly; caller metadata cannot activate ownership.
- Import/construction performs no catalog I/O. TENANT_EXPORT_VERIFY_ON_START=true opts into the explicit startup check. It defaults off. Failed verification retains audited 503. Proof expires after fifteen minutes; explicit re-verification is required and there is no automatic refresh loop. This verifies ownership fencing additions, not the entire application schema.
- The financial composition snapshot binds the settlement adapter using its real (connection, dependencies) signature. Transaction cleanup preserves the original outcome and destroys connections when release fails.
- Shutdown stops owned timers, socket admission and video admission with a bounded drain. Startup refuses an occupied port without killing its owner. Already-running privacy/exam/lifecycle passes lack individual drain ports; no complete-drain claim is made.

## Merge decisions

Main's controller-backed EditExam, InstructorStudents, ManualGrading, OnlineMeeting, StudentMeetings, StudentRegistrationRequests, StudentSpaces, Students and TeacherExams are retained. Their route/form incarnations, branch assignment, partial-load outcomes and session/action fences are more complete than the parallel page rewrites. Parallel source changes to those page implementations are not included as replacement implementations.

The shared protected response transport, MFA step-up, export schema gate and canonical M2 exports are combined. InstructorDashboard retains main's tenant profile/branch/branding/period panels alongside verified-session dashboard loading. Login retains session notifications and deferred-navigation fencing. Subscription retains exact minor-unit parsing and unavailable-money semantics.

## Held work

Financial and live production callers/provider bindings, assignment provenance/backfill/scanning/conditional deletion, notification contact authority and real environment schema application remain gated. Product publication/retention decisions have not been invented. Source migrations are included as source; their presence does not authorize application or reviewed bootstrap-manifest inclusion.

No tests, compiler, typecheck, build, DB/SQL execution, provider calls, services or deployment were performed for this integration. Push is a user-authorized source checkpoint only.
