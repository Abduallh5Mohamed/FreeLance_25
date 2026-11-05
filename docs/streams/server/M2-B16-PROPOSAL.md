# M2-B16 proposal: binding a course lesson to deliverable content, and who owns progression

**Implementation follow-up — 2026-11-03:** a narrower owner-only material
attach/list/detach slice and its owner UI/selector are now implemented locally under the existing catalog
mount. Its controlling contract is [J02 material binding](J02-LESSON-MATERIAL-BINDING-CONTRACT.md).
The migration is an unapplied file. The historical proposal below is not a
claim that direct video-asset binding or the student delivery path exists.

**Product decision update — 2026-11-03:** the owner chose several deliverables
per lesson and separate catalog/legacy progression ledgers for now, with that
difference explained to users. The two product questions in §4.3/§5 below are
therefore resolved. This does not accept every detail of the historical proposal
or prove an asset-to-course authority/delivery mapping. No content-binding
implementation or migration application is claimed by this update. See the
[local implementation record](../../agent-context/BUSINESS-IMPLEMENTATION-2026-11-03.md).

**PROPOSAL ONLY — not approved, not queued, not implemented, not executed.**
Prepared 2026-10-26 after the local source review (`AUDIT-2026-10-26.md`, work
order item 6) and the batch 5 corrections. Nothing in this document authorizes a
migration to be applied, a provider to be contacted, a service to be started, or
code to be written. It records the evidence found in this checkout, the exact
paths a bounded batch would touch, the dependencies it needs, the tests that
would have to exist, and the product decisions that must be taken **before** any
of it is written.

## 1. Why a contract is needed at all

The catalog learning path (M2-23) and the legacy content pipeline are two
independent systems that share no key. That is verified, not inferred:

| Concern | Catalog path (M2-23) | Legacy content path |
| --- | --- | --- |
| Lesson entity | `course_lessons` (`server/migrations/20261021_01_course_lessons.sql`, plus `release_at` / `prerequisite_lesson_id` from `20261023_04`) | `lectures` (`20261017_02_missing_core_tables.sql`: `video_url`, `course_id`, `is_published`, `archived_at`) and `course_materials` (`20260920_00_legacy_baseline.sql`: `material_type`, `file_url`, `is_free`, `is_published`) |
| Release / order rule | `course_lessons.release_at`, `prerequisite_lesson_id` | `lesson_release_policies` (`lecture_id`, `release_mode`, `release_at`, `release_timezone`, `prerequisite_lecture_id`) |
| Progress ledger | `course_lesson_completions` (`student_enrollment_id`, `lesson_id`, `completed_at`) | `lesson_completions` (`lecture_id`), `student_materials` (`viewed_at`, `download_count`) |
| Read surface | `server/src/routes/student-course-access.ts` | `server/src/routes/content-access.ts`, `lectures.ts`, `materials.ts` |

`course_lessons` has **no content column at all**. `video_assets`
(`20261018_06_video_assets_entitlements.sql`) carries `tenant_id`,
`owner_user_id`, `provider`, `provider_asset_id`, `status` — and **no**
`course_id` or lesson reference. So today a lesson can be scheduled, ordered,
completed and audited while pointing at nothing a student can open. That is
exactly what the review recorded as an open gap, and `StudentContent.tsx` renders
metadata plus a manual completion control and nothing else.

### 1.1 The existing binding is explicitly non-unique, and must not be imitated

The legacy world already links video to teaching content in **two directions**,
and `server/src/routes/secure-video.ts:574-588` documents the consequence
verbatim:

> The schema carries TWO independent link directions: `videos.course_id` /
> `videos.lecture_id` / `videos.material_id` … and `lectures.video_url =
> 'video://<id>'` / `course_materials.file_url = 'video://<id>'`. Neither
> direction is unique and `videos.lecture_id` / `material_id` have no foreign
> key, so a video can be reachable from several lectures/materials, from none, or
> from rows that disagree about the course/tenant. This resolver reports the
> shape instead of picking a row.

That resolver is correct to refuse to pick a row. The point of this proposal is
that the catalog path must **not** repeat the pattern: no `video://` string
convention, no join by title, no join by `display_order`, no implicit "the first
material of the course".

## 2. Before / after of the proposed batch

**Before:** a lesson is schedulable, orderable and completable, and its content
is unbound. A student can mark a lesson complete without any server-known
deliverable existing, and the UI has no control that would open one.

**After (if approved and executed):** one lesson may reference **zero or more**
explicitly bound deliverables, each of which is a row of exactly one kind
(`material` or `video_asset`) belonging to the same tenant and the same course.
The student path reports a bounded list per lesson, withholds the locator for a
lesson the student cannot open, and progression still lives in
`course_lesson_completions` alone. **No** legacy table is unified, migrated or
backfilled, and no legacy progress row is reinterpreted as a catalog completion.

## 3. Proposed paths (bounded, five)

1. `server/migrations/20261027_01_course_lesson_contents.sql` — additive schema
   FILE only, never applied by the batch.
2. `server/src/routes/course-lessons.ts` — owner-only attach/detach/list of the
   bindings, inside the existing transaction/audit/`no-store` pattern.
3. `server/src/routes/student-course-access.ts` — extend the path DTO with a
   bounded `contents` list per lesson.
4. `server/src/routes/tenant-self.ts` — mount only, if a separate sub-resource
   path is chosen instead of a field on the lesson (see §4.1).
5. `docs/streams/server/M2-B16-CONTRACT.md` — the exact DTO, error table and
   limitations once approved.

Tests (not implementation): `server/tests/m2-lesson-content-binding.test.ts`,
`server/tests/m2-student-course-content.test.ts`, plus a `src/tests/` suite if
the student page gains a control.

No client, auth, middleware, provider, package, config or CI change is proposed
here.

## 4. Proposed policy — to be approved, not existing policy

### 4.1 Shape of the binding

A single table, not a column on `course_lessons` and not a JSON blob:

```
course_lesson_contents(
  id            CHAR(36) PRIMARY KEY,
  lesson_id     CHAR(36) NOT NULL,   -- FK course_lessons(id)
  kind          ENUM('material','video_asset') NOT NULL,
  material_id   CHAR(36) NULL,       -- FK course_materials(id)
  video_asset_id CHAR(36) NULL,      -- FK video_assets(id)
  display_order INT NOT NULL DEFAULT 0,
  created_at    TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_course_lesson_contents_order (lesson_id, display_order)
)
```

- **Exactly one of the two ids is set.** MySQL has no portable CHECK on older
  versions, so the invariant is enforced by the handler and asserted by a test
  that reads the migration file, exactly as the M2-23 suite already does for its
  own "additive only, no backfill" rules.
- **No `tenant_id` and no `course_id` are duplicated.** Both are derived through
  `lesson_id → course_lessons → course_units → courses`, the same rule the
  completion ledger already follows, so a row cannot disagree with its parent.
- **Tenant and course agreement is proved by the handler on the same
  connection**: the referenced material's `course_id` (and through it the
  tenant) must equal the lesson's. A material of another course, another tenant
  or no course is the identical refusal.

### 4.2 Ordering and release

- `display_order` orders deliverables **within one lesson only**. It does not
  participate in the learning-path order, so it cannot affect the prerequisite
  invariant batch 5 established. A tie is broken by `id`.
- **A binding grants nothing.** Release, prerequisite and accessibility stay
  exactly as `20261023_04` defines them. A bound deliverable is not a second
  unlock rule, and an unbound lesson is still releasable and completable.

### 4.3 Progression ownership — the decision that must be made first

Two ledgers exist and they must not be merged by assumption. The proposal is
that `course_lesson_completions` remains the **only** progression ledger for the
catalog path, and that legacy `lesson_completions` / `lesson_release_policies`
keep owning the legacy `lectures` surface until a separate, explicit
decommission decision. Consequences to approve:

- a legacy completion is **never** read as a catalog completion, and the reverse;
- opening a deliverable is **not** a completion. Completion stays the explicit
  student action it is today;
- unifying the two journeys (or retiring the legacy one) is a **separate**
  contract with its own data-migration decision, which this proposal deliberately
  does not take.

### 4.4 Student projection

- `contents` is bounded (proposal: at most 20 per lesson) and carries only
  `{ content_id, kind, display_order, title }` plus, **only for an accessible
  lesson**, the locator the delivery route already issues.
- A locked or unreleased lesson carries **no** locator, for the same reason the
  M2-23 DTO withholds `description`: the absence must be in the serialized body,
  not merely hidden by the renderer.
- No provider URL, bucket, key, token or signed URL is ever stored in, or
  returned from, the catalog surface.

## 5. Dependencies this batch would need

| Dependency | State today | Needed for |
| --- | --- | --- |
| `20261023_04_lesson_release_progress.sql` applied | **not applied** (file only) | the whole catalog path already fails closed without it |
| `course_materials` rows owned by the same tenant | exists in the legacy baseline | the `material` kind |
| `video_assets` + a delivery route that can issue a playable locator | table and lifecycle exist; the resolver refuses to guess a parent | the `video_asset` kind |
| A product decision on §4.3 | **open** | progression ownership |
| A product decision on whether a lesson may have several deliverables | **open** | the table shape |

The last two are the reason this stops here: neither can be settled from the
source, and guessing either one is precisely the speculative binding the review
forbids.

## 6. Tests the batch would have to carry

- **Schema file**: additive only, no `ALTER` of an existing table, no `DROP`, no
  `UPDATE`/`INSERT` backfill, one FK per id column, the order uniqueness, and a
  statement that the file was not applied.
- **Owner surface**: attach/detach/list; a material or asset of another course or
  tenant refused identically; exactly-one-of enforced in both directions; a
  duplicate `display_order` for one lesson refused; a pure no-op retry writes and
  audits nothing; the write and its sanitized audit event share one transaction;
  an uncertain commit destroys the connection (the existing disposal matrix).
- **Student surface**: bounded `contents`; no locator on a locked lesson; a
  content row of another course never appears; a lesson with zero contents still
  reports an empty list rather than `null`; the path statement stays one bounded
  query (no N+1).
- **Isolation**: the new suites must pass under the connection-blocking barrier
  with no database, no provider and no listener, and must import
  `server/tests/helpers/isolated-io-guard.ts` so that stays true.

## 7. What this document does NOT claim

- It does not claim the content journey is complete, or that a student can watch
  or download anything today.
- It does not claim the legacy and catalog progress ledgers are equivalent, or
  that either one is correct.
- It does not claim the M3 video surface is accepted: the audit's DRM/device/
  offline matrix remains open and independent of this binding.
- It does not authorize applying a migration, contacting a provider, starting a
  service, deploying, or any Git action.
- It is not an approval. A human decision on §4.3 and §4.4 is required before a
  contract file and any source change are written.
