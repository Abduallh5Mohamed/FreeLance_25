# J05 — owner lesson preparation evidence, v1

BUILD-61 supersedes owner-only authority below: preparation/base/groups/learning now requires the live responsible course teacher, even when not institution owner; ownership alone and platform/operational roles grant nothing. Read J05-J07-TEACHING-WORKSPACE.md. Source/evidence DTOs and bounded original readers remain unchanged. Older BUILD-35/36 owner wording is historical.

BUILD-36 adds separate bounded group/window tag-evidence endpoints under the same
owner/parent proof. See [learning evidence](J05-LESSON-LEARNING-EVIDENCE.md).
The original base preparation endpoint below still rejects query selectors and
continues to report insufficient evidence for pedagogical concept diagnosis.

Implemented locally in BUILD-35. J05 remains partial; this is preparation-source
evidence, not concept analytics, student diagnoses, publication or delivery proof.

GET `/api/tenants/me/catalog/courses/:courseId/units/:unitId/lessons/:lessonId/preparation`
is mounted from tenant-self after authentication. It accepts no body/query or
tenant/student/enrollment/instructor selector headers. Billing-only is denied.
Each read proves the current active tenant owner/caller, active course ownership
and exact lesson/unit/course relation on the same transaction connection. Assigned
staff/instructors who are not the actual owner have no new grant.

The route uses the existing reference schema gates and source-policy readers.
At most 23 references: 20 combined material/video positions plus one homework,
quiz and announcement. Corrupt/oversized sets fail closed. A quiz uses the existing
explicit published-version reader; missing supporting schema is unavailable,
not a positive readiness indication. Missing table/column is HTTP 503; corrupt
evidence is 500. No stale or partial success is returned on those failures.

All responses are no-store. Projection: exact lowercase resource context,
checked_at, lesson title/status/unit status/release, rule_version preparation-v1,
items and learning_evidence=insufficient. Each item contains binding_id, kind,
current title (null if unavailable), position, source state, audience class,
quiz-version state and one deterministic issue. No source IDs, object/stream
URLs, bodies, questions, grades, group/student identifiers or contacts are emitted.

Per-item issue priority: unavailable source, missing/unavailable quiz version,
draft source, restricted audience, then null. These are evidence of preparation
conditions only. Empty/no-issue is not a grant, a completed lesson or a learner zero.
The server never identifies two weak concepts without a validated concept/result
source. Group/period selectors are rejected until their separate analytics contract.

The transaction performs SELECTs only, using the shared preparation locking
protocol. It always rolls back, never commits or audits. Errors or failed cleanup
discard the connection. No migration or provider is added. Read locks/query plans,
actual schema/DB isolation and performance remain to be accepted on a real system.

Client evidence buttons re-read this same authorized endpoint; removed bindings
lose their evidence rather than retaining old source details. That read is still
not access to protected bytes or proof of student eligibility.
