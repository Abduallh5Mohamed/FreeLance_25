# J02/J03 — student lesson material visibility, BUILD-04

Current follow-up: [BUILD-07](J03-PDF-ADAPTERS-DOWNLOAD-CONTRACT.md) widens only the
delivery-status enum to `unavailable | pdf_available` and supplies conditional
authenticated PDF download UI. DTO keys and authority remain unchanged. This
document otherwise records BUILD-04's metadata-only scope; default unconfigured
runtime still reports unavailable.

Local implementation date: 2026-11-04. Follows the owner's request to continue
the remaining plan and the owner material preparation contract
[BUILD-02/03](J02-LESSON-MATERIAL-BINDING-CONTRACT.md).

## Runtime and request

`GET /api/student-course-access/courses/:courseId/lessons/:lessonId/contents`
uses the existing authenticated student router and middleware mount. No query
or nonempty body is accepted. Authority selectors in body/query/headers are
refused before taking a connection. Missing authentication, wrong role and
missing workspace retain the existing student scope responses.

The existing learning-path and completion DTOs are unchanged. This is a
separate, explicitly opened read, avoiding automatic requests for each lesson.

## Authority and bounded data

One read transaction verifies:

1. Own active, approved, in-window enrollment and active tenant from server rows.
2. Active student-course enrollment plus active, published, same-tenant course.
3. Active lesson in an active unit of that course. Release uses the database's
   epoch clock; prerequisite completion belongs to this exact enrollment.
4. Actual required binding columns in the schema catalog (the existing minimal
   availability gate). Missing columns/table → 503 `LESSON_CONTENTS_UNAVAILABLE`.
5. At most 20 bindings (21-row probe), existing same-course published materials,
   and explicit valid projected metadata. Overflow/corrupt projection → 409.
6. Current group from the enrollment row, and explicit material assignment to
   that group. No client `groupId`, tenant membership or course enrollment alone
   grants material access. No assignment means no visible material.
7. All material parent-group links must have a resolved group, matching course
   and tenant. Up to 200 links total are prefetched (201-row probe); overflow
   refuses the whole request. `branches` / caller `branch_memberships` are joined
   in that same bulk read. The existing `createSqlResourceScopeLoader` and
   `resolveResourceBranchAccess` consume these prefetched rows in memory, with
   no per-material database query and no student platform/owner bypass.

Unknown/unassigned branch intent, conflicting branches, inactive/foreign branch,
missing/revoked membership or a scoped membership version mismatch withhold
the material. Ambiguous data is withheld without performing quarantine writes
or repairs. This read does not change the existing policy or its shared code.

Foreign/unpublished/unassigned/branch-inaccessible materials contribute no DTO,
URL or private title to the student response. Foreign/unpublished/unenrolled
course and archived/foreign lesson retain generic 404 responses. A lesson that
is now locked returns 409 `LESSON_LOCKED`, without querying its bindings.

Every handler response is `Cache-Control: no-store`. Read transactions roll
back and release; failure cleanup uses the existing lifecycle. No INSERT,
UPDATE, completion, access grant, payment or provider call occurs.

For a nonempty valid lesson the fixture verifies eight SQL statements total,
including all scope checks, schema probe and the bulk link read. Twenty
materials still use exactly one group/branch query. This is a bounded-query
contract, not a measured MySQL latency or query-plan result. Separate requests
see subsequent publication/assignment changes; no push-based revocation or
cross-request snapshot is claimed.

## Response and student UI

```json
{
  "lesson_id": "<UUID>",
  "contents": [{
    "content_id": "<UUID>",
    "title": "<material title>",
    "material_type": "pdf",
    "display_order": 0,
    "delivery_status": "unavailable"
  }]
}
```

Exactly these keys; at most 20 sorted rows. No `material_id`, `file_url`, provider
locator, storage key, student/contact/tenant data or invented playable state.
An empty list means no currently visible, published and assigned materials.

`StudentContent.tsx` mounts `StudentLessonMaterials` only for an accessible
lesson. The collapsed control makes no request until opened. Its bound child,
`StudentLessonMaterialList`, uses the strict parser/controller in
`student-lesson-contents.ts` and the existing canonical HTTP helper.
Reads are single flight, clear old private rows on refresh/failure, and are
fenced by principal, session event, cross-tab storage, target key and disposal.
The UI labels empty, locked, denied, unavailable and failed states. Material
titles/types appear with an explicit opening-unavailable message, without fake
play controls, anchors or iframe/video embeds.

The page explains that catalog completion remains separate from the old
content ledger. Viewing these references never marks a lesson complete; the
existing explicit completion action retains its contract.

## Delivery is still a separate gate

BUILD-05 follow-up: a conditional private PDF binary endpoint and server-owned
source schema file are now implemented under the [PDF boundary contract](J03-PRIVATE-MATERIAL-PDF-CONTRACT.md).
The default runtime remains unconfigured, the schema is unapplied and no trusted
ingestion/scan writer exists in that slice. This metadata DTO and UI still
report opening unavailable; the following evidence remains a delivery-readiness
limitation, not a claim that the new conditional boundary is absent.

This batch provides **metadata visibility only**. Current `course_materials`
stores legacy `file_url` strings. The legacy generic file route authorizes
chat/exam/receipt parent relationships; it does not prove a catalog lesson
file relationship or a trusted malware verdict. Assignment scanning applies
to assignment submissions, not these material rows. `video_assets` has no
course relationship, while legacy playback resolves other lesson identities.
None of those are silently reinterpreted as catalog delivery authority.

Next delivery contract must define an exact material-to-file/video relation,
same-course/tenant ownership, actual private storage/scanner evidence, safe
stream lifecycle and request-time lesson/material/branch revalidation. External
provider activation and applying schema remain separately authorized actions.
No migration was authored or applied in BUILD-04, and no live data/provider
was used. Local tests and static rendering are not production acceptance.

Evidence/commands: [implementation record](../../agent-context/BUSINESS-IMPLEMENTATION-2026-11-04.md).
