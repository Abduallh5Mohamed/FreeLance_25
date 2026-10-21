# C4a: remaining source-level correction — same approved batch

Codex reviewed the stopped C4 code on 2026-10-21. This is a correction of existing C4 exact-assignment/publication acceptance, not a new feature or a changed product policy. Scope remains the same new C4 files: `server/src/routes/progress-reports.ts`, `server/src/services/progress-publication.ts`, `server/tests/m4-progress-reports.test.ts`, and C4's own report. No shared auth/index/schema or current parent routes.

## 1. Test the production authority factory, not just an injected permission mock

`createSqlCourseAuthority` in routes/progress-reports.ts currently allows `mayActOnEnrollment` to return `exact` merely because the student's group branch equals the actor branch and `verifiedBranch(scope)` succeeds. `readableScope` likewise appends `OR (g.branch_id=? AND g.branch_scope='branch')`. Branch membership alone must not grant access to every teacher's groups/students in that branch. The prior Codex correction expressly required separate groups in one branch to be isolated; the current abstract-authority tests do not establish the SQL factory meets it.

Remove that membership-only grant. Branch membership constrains access, it does not create a teaching assignment. Reuse server-proven owner/course/group/enrollment relation semantics already available, without inventing new capabilities or canonical enrollment policy. Ambiguous relation denies. Verify `courseId`, enrollment and group/course relation consistently, not merely actor relation to an arbitrary group. Any owner/explicit assignment positive remains available. Query-scope calculation may be an over-approximation only if the exact per-row gate still denies unauthorized rows before projection; prefer it not to request peers' data unnecessarily.

Add regressions instantiating **createSqlCourseAuthority over a recording DB seam**, using actual SQL/bindings, combined with real router: one tenant, one branch, same course if applicable, different assigned teachers/groups; teacherA cannot list/export/publish/unpublish studentB even with omitted/forged selectors. Owner and explicitly assigned teacher positive. Tests returning `none` from a custom authority mock are insufficient to prove the production factory. Report SQL not run on MySQL honestly.

## 2. Remove scalar publication bypass

`parentProjection` currently executes `if (state === 'published') return projectProgressForParent(...)` before identity comparison, and existing test calls `parentProjection(record(), 'published')` without identity and expects data. This bypasses the key binding required by the prior correction.

Require a publication record matching tenant/enrollment/course identity (and the report's enrollment/course). Bare `published`, missing identity, mismatched record or ambiguous proof must yield null or be rejected by a narrower type and runtime guard. Do not retain a success overload merely to preserve an unsafe test of new code. Update the legitimate positive projection test to provide a matching publication record and identity, retaining the field allowlist assertions. Add negatives for scalar marker, forged identity, missing identity and every key mismatch. No new fields/cadence policy and no legacy parent-views changes.

Keep the corrected mandatory transaction seam and actual rollback callback tests intact. Do not weaken other assertions or touch C1/W5. Claude may run one correction worker after confirming previous writer stopped, review diff and focused tests/typecheck, then report stopped state. No live DB/network/listener/provider/Git mutation. This artifact is not final C4 or milestone acceptance.
