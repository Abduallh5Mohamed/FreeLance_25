# J08 — responsible teacher, delegated questions and final revision

BUILD-62: teaching/grading identity proofs acquire the common active tenant row before actor/user locks. Assigned-page service proves actor/schema once per SAME transaction, then every assignment and responsible teacher live; no cross-request cache or public skip option. Scoped standalone writes/receipt reads still prove full authority. Real25-row page81 vs180 queries; role/revocation/schema boundaries remain. See BUSINESS-IMPLEMENTATION BUILD-62 for real deadlock reproduction/fix and precise native COMMIT ACK test, one retained same-grant renewal, and open production/load/TCP/reconciliation limits.

9 November2026, BUILD-60. Owner clarification supersedes the BUILD-59 proposal:
Tabweb administrators operate Tabweb's business; they are not academic graders.
Institution ownership is not course teaching responsibility. The responsible
teacher defines reference criteria, assigns graders and owns final approval and
reasoned reopening. No automatic center-staff or platform-admin marking grant.

## Authority

`grading-authority.ts` checks current users-table identity, active institution,
active teaching membership, live token_version, role teacher/instructor, no
center-only marker and no platform-role membership. Responsibility requires
`courses.instructor_id` to match the caller, not tenants.owner_user_id. Missing
identity/schema/proof fails closed. Impersonation and billing-only sessions are
denied. Tenant/workspace and all object authority come from server rows.

`question-grading.ts` and `grading-rubrics.ts` now use that responsibility for
selectors, answer reads, writes and historical receipt recovery. No institution-
wide exam picker granted by ownership. The rubric save creates an immutable
revision; it does not change a pinned exam or old grade.

## Explicit question assignments

Mounted through tenant-self under `/api/tenants/me/catalog`:

| Suffix | Authority and effect |
|---|---|
| GET `/grading/questions/:questionRef/assignment` | Responsible teacher; current assignment, active in-tenant teaching candidates and20 saved rubric revisions |
| POST same | Explicit assignee/rubric UUID, expected assignment version; create or transfer/renew one current assignment per tenant/question |
| POST same + `/revoke` | Teacher versioned revocation |
| GET `/grading-work/assignments` | Only the caller's live assignments,25+lookahead/keyset |
| GET `/grading-work/:assignmentId/questions/:questionRef/answers` | Current assignee and exact assigned question only; anonymous answer page |
| POST `/grading-work/:assignmentId/attempts/:attemptId/grade` | Current assignee, assignment/attempt versions, complete criterion marks and bounded optional feedback |
| GET `/grading-work/:assignmentId/operations/:operationId` | Actor-owned historical grade receipt, with current assignment/course proof |
| GET `/grading/control-operations/:operationId` | Responsible teacher's own control receipt with live current course responsibility |

Assignment pins one immutable rubric revision. It is also bound to the
responsible teacher that explicitly issued it. Teacher suspension, membership
loss, platform-role membership, course handover, transfer/revoke or assignee
revocation removes access. A replacement course teacher must explicitly renew
the assignment; an old grant never follows course ownership automatically.
The nullable responsibility-column migration backfills no grant. Binary UUID
assignment/control keys require canonical lowercase spelling to prevent aliases.

The assignee cannot select another question, read other answer pages/final
management, freely submit a total, finalize or reopen. Complete criterion marks
are summed in integer hundredths, bounded by the pinned rubric and question.
No AI grading or new assessment engine. The optional assignment mode of the
existing question router reuses its canonical planner/CAS/revision store and
sealed audit. `exam_rubric_awards` stores criterion marks, rubric and assignment
version/actor alongside that revision, in the same transaction. Responsible
teachers retain explicit manual-review authority; old freeform grades are not
claimed to have used criteria that were added later.

## Reopening a canonical final result

| Suffix | Effect |
|---|---|
| GET `/grading/versions/:versionId/finalized` | Responsible teacher only, bounded own-course results; student name is purpose-scoped here, never added to assigned answer DTOs |
| GET `/grading/attempts/:attemptId/reopen-preview` | Proves current final/projection and issues a deterministic impact token |
| POST `/grading/attempts/:attemptId/reopen` | Operation UUID, expected version, fresh impact token and mandatory bounded reason |

Reopening is limited to manual versioned attempts finalized by the canonical
question workflow with one matching finalization receipt. Actual unique
exam/enrollment identity must exist. Projection ID, tenant/enrollment/course/
exam source, exact score/max, original reviewer and linked/unlinked outcome
must agree. SQL DECIMAL scale4 zero padding is accepted exactly; non-cent stored
values are never rounded. A customized category or explicit weight is refused:
this flow must not silently discard gradebook policy metadata on re-finalization.
Unknown/changed provenance or absent expected projection returns409, not a
guessed deletion. Legacy/unversioned results are not reinterpreted as these
attempts.

Under the same locks/connection, pending_review replaces graded, version
increments, score/passed/reviewer/graded_at are cleared and exactly the proven
canonical gradebook projection is removed. The reason, old final state and
projection facts are preserved in sealed audit; immutable operation receipts
preserve historical outcomes. Prior answer revisions remain. Later teacher
approval recomputes all current revisions through the original finalizer and
creates one deterministic gradebook projection again. It does not edit the
pinned exam/question/key, publish to a family or release lesson progress.

## Transactions, recovery and compatibility

Normal live proof/resource locks and attempt CAS prevent silent lost updates.
Actual simultaneous native same-version writes demonstrated one201 and one409.
New mutations, criterion provenance, sealed audit/head and receipts commit on
one connection. Faults roll them back; commit/cleanup uncertainty never reports
success and discards the connection. Reads/schema checks are bounded; actual
InnoDB/JSON/unique-index metadata is required. No provider or money operation.

Only exact actor/intent operation replay is permitted. Receipts are historical;
current lists are separate reads. Browser markers contain only typed opaque IDs,
kind and expected version, no marks, answers, feedback or reasons. Unknown ACK
locks writes and survives reload; GET recovery never repeats POST. Missing
receipt/current authority loss keeps the lock, not an elapsed-time unlock.
Resolving an absent receipt/actual uncertain commit operationally is not proven
by the lost-ACK tests. No-grade/provider fallback.

Classic `/api/manual-grading` loses the platform-admin bypass and scopes actual
teaching to the course. Production `/api/exam-manual-grading` has compatibility
reads restricted to the responsible course teacher; its mutations are explicitly
closed with409 directing to the scoped question workbench. Its existing global
reporting readiness guard can run earlier: on this demo it returns generic503.
Healthy composition tests prove role denial/409, but native legacy readiness/
native409 acceptance is **not** claimed. Current React code uses the scoped
workbench, not that compatibility writer. Existing exam-version management also
denies platform-admin/impersonation contexts at its staff scope boundary.

Additive migrations: `20261109_01_grading_delegation.sql` (3 CREATEs),
`20261109_02_grading_assignment_responsibility.sql` (1 ALTER). Applied only to
the authorized synthetic loopback demo after separate private snapshots. No
source/production migration, provider, external delivery, role fallback or Git.

The local scoped journey has native auth/SQL/Chrome evidence. Human grading
consistency, real student lifecycle for these seeded answer fixtures, mixed-load
deadlocks/timeouts/uncertain commits, devices, production schema and global
reporting readiness remain separate acceptance work. Historical unit factory
success is never production authority or independent acceptance.
