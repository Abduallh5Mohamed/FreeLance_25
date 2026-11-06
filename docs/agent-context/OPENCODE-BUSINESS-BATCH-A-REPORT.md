# OpenCode Batch A report — 2026-11-06

Task: `business-20261106-a-templates-timing`
Worker: `opencode-business-a-20261106`
Status: implementation complete in source, pending independent Codex review.

## Delivered journey

Owner (verified server-side) can save a selected lesson package as a named
same-course private template, list/browse its persisted immutable revisions,
append a revision from a selected source lesson, archive it without deleting
history, choose a destination lesson, review the current factual state, choose
explicit timing (keep / UTC set / clear), confirm, and apply references plus
destination timing in one audited transaction. Lost write acknowledgements are
recovered through the durable operation receipt, never by blind retry.

## Changed paths

### Created

- `server/src/services/lesson-package-timing.ts`
- `server/src/services/lesson-package-templates.ts`
- `server/src/routes/lesson-package-templates.ts`
- `server/migrations/20261106_10_lesson_package_templates.sql`
- `server/migrations/20261106_11_lesson_template_operations.sql`
- `server/tests/lesson-package-templates.test.ts`
- `server/tests/lesson-package-timing.test.ts`
- `src/features/catalog/lesson-template-timing.ts`
- `src/features/catalog/lesson-package-templates.ts`
- `src/features/catalog/LessonTemplateTiming.tsx`
- `src/features/catalog/LessonPackageTemplates.tsx`
- `src/tests/lesson-package-templates.test.ts`
- `src/tests/lesson-template-timing.test.ts`
- `docs/streams/server/J02-LESSON-PACKAGE-TEMPLATES.md`
- `docs/streams/client/J02-LESSON-PACKAGE-TEMPLATES.md`
- `docs/agent-context/OPENCODE-BUSINESS-BATCH-A-REPORT.md`
- `output/opencode-business-batch-a/SUMMARY.md`

### Modified

- `server/src/services/lesson-package-reuse.ts` — exported the existing binding/
  source/insertion primitives and moved the shared reference-insert statement
  into `insertLessonPackageReference`; direct reuse now calls that path.
- `server/src/routes/tenant-self.ts` — mounts the new router under `/catalog`.
- `src/pages/Courses.tsx` — mounts the template panel inside the private owner
  course-details dialog, keyed by course id.

No WorkBuddy M2-23 reserved path was touched.

## Behaviour before/after

Before: owner could reuse a source package directly into a destination, but
could not save named templates, browse immutable revisions, archive them, or
review/apply a stored revision with explicit destination timing.

After: the complete allocated journey exists in the real router and real UI.
The reuse engine's final-state/source proof is shared, not copied. Apply writes
references, destination `release_at`, audit and an idempotency receipt on one
transaction. Schema absence fails closed. Authority is re-derived from the
session/tenant owner and course/unit/lesson relationships on every request;
selector headers are rejected.

## Validation actually run

- `cd server && npx tsc -p tsconfig.json --noEmit` — pass, no output.
- `npx tsc -p tsconfig.app.json --noEmit` — pass, no output.
- `cd server && npx tsx --test tests/lesson-package-templates.test.ts tests/lesson-package-timing.test.ts tests/lesson-package-reuse.test.ts` — 35/35 pass.
- `npx tsx --test src/tests/lesson-package-templates.test.ts src/tests/lesson-template-timing.test.ts` — 16/16 pass.
- `npm run build` — pass; only existing Browserslist/chunk-size/dynamic-import
  warnings.
- `npm run test:src` — 1872 pass, 5 fail. All five are pre-existing M1 UI suites
  failing with `SyntaxError: The requested module 'node:module' does not provide
  an export named 'registerHooks'` in this runtime; none imports the new files.
- Focused `eslint` on the changed files reports only
  `@typescript-eslint/no-explicit-any`; the analogous existing package-reuse
  files report the same rule, so this matches the repository baseline. No other
  lint rule fails in the changed files.

## Contracts and safety

- Wire timing: `keep` accepts `{mode:"keep"}` or `release_at:null`; `clear`
  requires `release_at:null`; `set` requires an explicit UTC ISO instant with
  `Z` and is normalized to millisecond precision. The client sends canonical
  values only; Cairo is a display label.
- Review token binds actor, tenant, course, destination, template revision,
  stored references, source facts, items and timing.
- Unknown/corrupt template schema or shared reference schema returns
  `LESSON_TEMPLATES_UNAVAILABLE`; no partial creation/apply is reported.
- Migrations are file-only. They were not applied, no live DB/provider/browser
  was used, and no external deployment or Git write occurred.

## Limitations / follow-up for reviewer

- The route tests invoke the real Express router with a supplied authenticated
  principal and the hermetic SQL fixture; full auth/boundary middleware is
  covered by existing suites, not by these route tests.
- The source/edit UI is intentionally bounded to five reference kinds and one
  page at a time; archived templates are removed from the active list (their
  revisions remain stored).
- No real MySQL execution or migration application was performed, so index/
  engine compatibility is asserted from the migration text and schema fixture,
  not from a live database.
