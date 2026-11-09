# BUILD-36 — group/window evidence from final automatic quiz answers

7 November 2026. Codex implementation under the owner's direct continuation.
Schedule remains disabled; no OpenCode dispatch. Partial J05 advancement, not
independent/live acceptance or completion of the whole business strategy.

## Result for the teacher

After selecting a lesson in course details, the teacher can select an authorized
current group from bounded pages and an explicit UTC day range (end excluded,
maximum 31 days). The new panel reads final automatic-answer evidence for the
currently pinned published quiz version and that lesson's exact catalog context.

It suggests at most two **question tags**, based on immutable pinned bank-version
provenance. It does not infer concepts from arbitrary text or join mutable question
heads. The teacher can open question previews/counts and accept/dismiss a suggestion
as an explicitly memory-only preparation choice. No grading, plan, delivery,
notification or learner access is changed.

The local heuristic is explained: at least five final attempts; at least 40% of
answers on a tag's questions not flagged fully correct; rank by fraction, then
count, then tag. Partial credit can count as not fully correct. Multiple tags
can share a question, so denominators overlap. This is not a validated learning
diagnosis, unique-student count, mastery assessment or demonstrated time saving.

## Changed source and architecture

- `server/src/services/lesson-learning-evidence.ts` (new): exact UTC/group selector
  policy, bounded course-group discovery with branch integrity, current quiz source/
  audience and published pin proof, required schema/JSON/engine checks, immutable
  tag provenance, final-attempt/context proof, complete automatic ledger validation
  and pure aggregation. No student identity/raw response/key appears in output.
- `server/src/routes/lesson-preparation.ts`: adds `/groups` and `/learning` suffixes
  to the existing preparation router. Both reuse its active owner/caller/course/
  exact lesson-unit authority and connection/cleanup protocol. Base preparation
  keeps its original no-query contract. New selectors are explicit, not authority.
- `src/features/catalog/lesson-learning.ts` (new): strict bound DTO/group/window
  parsers, canonical private transports and lifecycle controller; loaded-group
  admission, page replacement, empty/uncomputed states, deadline and supersession,
  identity/event/storage boundaries and memory-only editorial decisions.
- `src/features/catalog/LessonLearningEvidence.tsx` (new): actual paged group/UTC
  selection, read action, cohort/version/rule disclosures, suggestion evidence
  details and local use/dismiss controls. Text is rendered escaped.
- `src/features/catalog/LessonPreparation.tsx`: mounts the keyed learning panel
  beside source preparation under the selected lesson. Session invalidation from
  either child hides the outer chosen-lesson picker as well.
- `server/tests/lesson-learning-evidence.test.ts` (new): 17 tests through actual
  route SQL protocol plus the pure reducer, exact parameters, final/cohort predicates,
  privacy, insufficient data, source pin/audience boundaries, cap/error handling,
  context mismatch and missing/duplicate/manual ledger rejection.
- `src/tests/lesson-learning.test.ts` (new): 9 parser/controller/actual mounted UI
  tests including canonical HTTP, loaded-group admission, UTC dates, hidden old
  results, local choices, escaped stems/tags and session/storage/deadline fences.

Updated queue, README, FEATURE_MATRIX and server/client J05 contracts. Existing
source preparation and saved-template regression tests still pass. Old WorkBuddy
reserved files and unrelated local changes were preserved.

## Data integrity and honest missing-data behavior

The eligible set is current stored student group membership, not historical
membership at submission and not a claim of active attendance. Owner scope is
not expanded to assigned staff. Restricted quiz audiences must include the group.
No mixing of other lessons, generic/legacy attempts, tenants or old pinned versions.
Catalog identity fields are parsed and checked against the actual enrollment/user
and resource rows even after the SQL context filter.

Only graded attempts with submitted_at in [from,to) are used. In-progress,
pending_review and expired attempts are excluded. Essays/manual answers are not
converted from temporary zeros. Every eligible final attempt must contain exactly
one valid nonmanual automatic answer per included question; missing/duplicated/
invalid rows fail the whole read. No silent incomplete denominator.

Caps are 200 questions, 100 attempts, 20,000 automatic ledger rows. Queries request
one extra; excess returns unavailable/incomplete rather than sampled success.
Missing supporting catalog/JSON/schema fails closed. No quiz/current published pin
returns insufficient with **null (uncomputed) counts**, not invented zero counts.
Fewer than five final attempts or no mapped automatic tags also reports insufficient.
Available evidence without a crossing tag does not prove mastery.

Counts use all bounded eligible rows. Evidence details include at most the first
five question previews per suggested tag, at most 1000 characters per stem; that
preview limit is disclosed. The inline details are from the timestamped read,
not another authorization request; refresh explicitly reads the same scope again.
No raw answers/options/explanations, keys, learner names/IDs or family grade DTOs.

## Verification commands

Repository root, installed compatible Node v24.19.0. No installs. Final commands
below exit 0; focused checks were also repeated after the missing-data count fix.

```powershell
$businessNode='C:/Users/BaraaWael/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node.exe'
& $businessNode --import ./node_modules/tsx/dist/loader.mjs --import ./server/tests/helpers/isolated-io-guard.ts --test --test-reporter=spec server/tests/lesson-learning-evidence.test.ts server/tests/lesson-preparation.test.ts server/tests/lesson-package-templates.test.ts server/tests/lesson-package-reuse.test.ts server/tests/lesson-package-timing.test.ts server/tests/m2-course-units.test.ts server/tests/m2-course-lessons.test.ts server/tests/m2-course-lessons-reorder.test.ts server/tests/m2-lesson-release.test.ts server/tests/m2-public-catalog-composition.test.ts
$frontendTests=@(Get-ChildItem src/tests/*.test.ts | ForEach-Object {$_.FullName}) + @('src/auth/access-control.test.ts')
& $businessNode --import ./node_modules/tsx/dist/loader.mjs --test --test-reporter=spec @frontendTests
& $businessNode ./node_modules/typescript/bin/tsc -p tsconfig.app.json --noEmit
& $businessNode ./server/node_modules/typescript/bin/tsc -p server/tsconfig.json
& $businessNode ./node_modules/vite/bin/vite.js build
```

| Check | Result | Evidence |
|---|---|---|
| Listed backend regressions | 338 pass / 0 fail | `output/build36-backend.log` |
| Full frontend command | 2155 pass / 0 fail | `output/build36-frontend.log` |
| Final focused backend | 36 pass / 0 fail | `output/build36-focused-server.log` |
| Final focused frontend | 18 pass / 0 fail | `output/build36-focused-client.log` |
| Frontend types / server compilation | pass | `output/build36-{client,server}-types.log` |
| Vite | pass; existing chunk warning | `output/build36-vite.log` |

The main chunk is about 3,800 kB minified / 1,080 kB gzip. This remains a real
performance concern, not a measured browser latency. The independently documented
premium-lecture failure was not fixed/reclassified; the whole backend is not
declared green from these scoped suites.

## Limits and next

No DB/migration execution, provider, external AI, messages, package install,
deployment, Git/GitHub or actual browser/device/load/field measurement occurred.
Required tables are not proved deployed. Query plans, JSON filtering/index cost,
locks and real MySQL isolation/schema must be accepted separately; bounds limit
returned work but do not prove indexed scan cost. Grading/source snapshot services
remain responsible for their own immutable-content guarantees.

J05 still needs pedagogically validated concepts, recurring questions, separately
reviewed manual-answer evidence, assigned-staff authority and usefulness measurement.
No durable feedback is claimed. Next independent journey in the queue is J07: a
small teacher-reviewed return plan using actual attendance and catalog progress,
without treating video incompletion as absence or widening access. Other journeys
and external gates remain open. Schedule stays stopped.
