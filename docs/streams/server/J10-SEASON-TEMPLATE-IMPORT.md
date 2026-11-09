# J10 — Explicit template reference remapping, BUILD-44

BUILD-61 additionally proves live educational user/membership/session and excludes mixed platform-admin membership before owner context and historical recovery. Existing institution ownership, explicit mapping/rights and atomic receipts remain; course teacher assignment grants no content-copy right.

Owner approved named date-only seasons and owned course settings/templates reuse
after review without enrollment/finance/access transfer. This increment imports
a pinned template revision into the already-created season draft by explicitly
replacing each old reference with an existing same-kind source in that draft.
It does not copy binary content or turn old-course IDs into new-course authority.

## Mounted contract

Prefix `/api/tenants/me/catalog/season-template-import`:

- GET `/targets/:targetId/templates?after=<uuid>`: 25 active template headers
  from the source course derived from the season creation record.
- GET `/targets/:targetId/templates/:templateId?revision_number=<positive int>`:
  the explicitly selected persisted revision, at most 23 refs, with private
  title/state/audience projections only. No implicit newest revision.
- GET `/targets/:targetId/sources/:kind?after=<uuid>`: at most 25 authorized
  replacement headers for material/video/homework/quiz/announcement. A filtered
  source page may have fewer rows than its cursor's raw candidate page.
- POST `/review`: target_course_id, template_id, revision_number, name (1..120),
  rights_confirmed=true, mappings:[{kind,source_id,target_source_id}].
- POST `/apply`: the same fields plus operation_id UUID and review_token.
- GET `/operations/:operationId`: actor/tenant-scoped historical receipt or null.

Every request has no-store, exact selectors/bodies and live owner/token/status/
suspension proof on one transaction connection. Student/staff/billing-only and
impersonated sessions are refused. The target is derived from a server-owned
season reuse record and must remain active/draft in the same tenant as the old
active course. A resource selector never grants authority.

## Reference and revision proof

An active source template, explicit revision/hash/count and active origin
lesson/unit in the old course are re-proven. Every original ref and replacement
uses the existing `readLessonPackageSource` eligibility rules; selected kinds
also require their original schema gates. Material reads require InnoDB. No
source URL/storage key/question key/student data appears in DTOs or receipts.

Mappings are complete, one-to-one per kind, with no inferred matches by title.
Original media positions and singleton kinds are preserved. Each mapped source
must belong to the new course; old IDs fail unless the exact server proof says
they are current target sources. Rights confirmation is an audited attestation,
not independent legal ownership proof.

Review hash binds actor/tenant, season context, original revision/header, mapping,
name, source facts and target facts. Changed source/target facts require a new
review. Names already present refuse, and a unique tenant/target/source-template/
revision key prevents another operation key from importing the revision twice.

The import creates an independent ordinary template/revision-1/reference set.
Its content hash uses the target IDs and the original canonical package order.
`source_lesson_id` retains the old lesson as **historical provenance**, not an
apply target or access grant. The import ledger explicitly records both courses
and old template/revision. Existing application code proves the target course's
mapped references again; it does not treat the origin lesson ID as authority.
Future revisions created in the target use the normal target lesson contract.

Creation, sealed audit and import receipt share one transaction. Failures roll
all writes back before commit. Unknown commit acknowledgement destroys the
connection without rollback of an unknown committed outcome, returns uncertainty
and requires GET recovery. Matching canonical replay returns the original
receipt even if current sources later change; mismatched request/actor refuses.
New commit 201, replay 200. No automatic new key after missing receipt.

## Existing library metadata repair

Library list/revision reads now validate the exact five-table library schema
without demanding unrelated video/homework/announcement installations. All
create/revise/archive/apply/recovery source-dependent gates retain their original
default requirements. Reading a header is not proof that applying or delivering
its sources is operational.

Actual MySQL 8.0.44/mysql2 refused a JS number prepared LIMIT with
ER_WRONG_ARGUMENTS; a decimal string succeeds. Both metadata pages now validate
their service-level limit (1..50) and bind String(limit+1), preserving SQL
parameterization. Other parameters and cursor contracts remain unchanged.

## Readiness

`20261107_05_season_template_import.sql` and specific prerequisite migrations
were applied only to the authorized isolated synthetic demo after a private
before snapshot. Source DB and providers unchanged. Runtime verifies core
transactional tables, operation columns/JSON and relevant unique index shapes;
this is not verification of all deployed types/FKs/query plans.

Real HTTP/MySQL/Chrome evidence covers **material metadata references**. Other
kinds reuse shared source validators and mixed mapping has local tests; they
have no new real-provider/device/SQL acceptance from this batch. The demo PDF
metadata has no file URL and no fake clean/ready verdict. Automatic content
duplication, new-source preparation/import, lesson application, release dates,
prerequisites, progress, enrollment, finance, publishing and delivery are outside
this operation. Full J10 and whole-plan acceptance remain open.
