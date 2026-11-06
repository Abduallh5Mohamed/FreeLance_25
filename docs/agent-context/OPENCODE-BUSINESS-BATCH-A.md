# OpenCode batch A — saved lesson templates and explicit destination timing

Owner instruction: 6 November 2026. OpenCode implements; Codex supervises and
independently reviews. This is a large complete user journey, not a proposal-only
task or permission to mark the entire strategy complete today.

Task ID: `business-20261106-a-templates-timing`.
Read AGENTS.md, agent-context/README.md, ENGINEERING_RULES.md,
BUSINESS-EXECUTION-QUEUE.md, strategy 22 J02, BUILD-32/33 and their named contracts,
then actual source/tests before editing. The exact external mailbox task's
allowedPaths is authoritative. Claim ONLY this task using tabweb_supervisor MCP.

The current user explicitly delegates NEW business implementation to OpenCode,
superseding the old correction-only role/cadence wording in OPENCODE-WORKER.md.
It does not authorize another worker's reserved paths, automatic acceptance,
model/account switching, paid fallback or prohibited external actions.

## Delivery: one complete course-owner journey

Deliver working backend, actual course-owner UI, failure handling, tests and a
report for saving a selected lesson package as a named reusable template,
creating immutable template revisions, browsing/archiving templates, reviewing a
chosen revision against one destination lesson, explicitly choosing destination
timing and applying the selected references atomically with audit/idempotency.
Do not stop at standalone factories, markdown, mocked UI or an unmounted router.

### Domain and architecture

1. Stay with Express/TypeScript/MySQL and existing React/TypeScript/Vite controls.
   No packages, ORM, service extraction, queues, AI model, cron or new provider.
   Inject the existing transactional connection; no database/provider imports or
   listeners on module import. Mount a separate owner template router from
   `server/src/routes/tenant-self.ts`; do not edit reserved course-lessons/index
   files. Mount the actual panel in the private owner course view in Courses.tsx,
   preserving anonymous/public and student behavior.
2. Templates are private to one tenant and one course. Store a bounded named
   head and immutable version rows containing selected reference kinds, source
   IDs and original media positions. At most 20 mixed media plus homework/quiz/
   announcement singleton slots. Name 1..120 trimmed characters. Source lesson
   is provenance, not a permanent dependency: changing its bindings later must
   not silently change a saved version. Do not store content bodies, URLs/keys,
   student records, quiz pins, publication or grants in templates. Keep applied
   destination references independent of future template edits/archive.
3. Saving/revising requires current owner/course/source proof and current source
   eligibility. Derive tenant/identity from live server authority. Reuse existing
   video, activity and announcement source readers and their group/branch checks.
   A template snapshot never authorizes stale/foreign/deleted sources on apply.
   Verify actual columns/types, transactional engines, uniqueness and needed
   relationships; fail closed if schema is absent/incompatible. Add migration
   FILES only; do not apply them, even on a supposedly local DB.
4. Use parameterized bounded queries and explicit DTOs. Lists default 25, max 50;
   opaque bounded keyset cursors, no automatic full-course scan. Version creation
   uses parent locks and optimistic expected revision; archive is explicit and
   does not delete source content or already applied references. History is
   bounded/paged. Do not silently overwrite another revision or replace a slot.
5. Refactor/reuse the final-state and source-proof logic in
   `server/src/services/lesson-package-reuse.ts` into a shared internal engine
   where necessary. Do not duplicate a weaker template copy path. Preserve the
   existing BUILD-32 route/body/response compatibility. Source template snapshots
   must be loaded from verified server storage, never accepted as authoritative
   source rows from a request. Check material/video shared positions/count,
   singleton conflicts and exact source eligibility before ANY write.
6. Server review binds actor/tenant/course/template revision/destination, selected
   refs, current source/audience facts, current destination state and explicit
   timing choice. Apply recomputes under parent locks; changed review yields 409
   and NO writes. A current preview is not proof that a human read it or a student
   is entitled. Show original source audience remains in force, not a copied or
   enlarged group membership. Preserve original positions; conflicts require
   manual repair, with no automatic renumbering/replacement.
7. Timing is explicit for this one destination: keep its current release_at, or
   set a deliberately chosen canonical UTC instant/null using existing release
   semantics. Show current/proposed values and clear timezone labels (including
   Cairo display); validate full input server-side. Never infer/copy timing from
   the template, auto-publish, change prerequisites/order, or add a scheduler.
   Changing release time can affect availability and needs explicit approval.
   Include timing in review and request identity; its update plus references,
   shared audit and receipt are ONE transaction or none. Preserve unrelated
   lesson metadata; no clobbering on concurrent edit.
8. Keep durable idempotency receipts and exact replay identity, including version,
   destination and timing. Verify authority before returning a historical receipt.
   Same operation/payload never duplicates refs/audit; changed payload is rejected.
   Unknown commit destroys the connection and reports uncertainty. Read-only
   recovery checks the SAME operation; no blind retry, no fake success on absent
   receipt. Reuse existing receipt design where compatible; additive new tables
   belong in the allocated migration files if necessary.

### Actual UI

Reuse the bounded cross-unit source picker and existing material/activity
controls. Owner can select references, name/save a template, choose an exact
revision, select a destination from this course, compare current conflicts and
timing, explicitly approve and apply. Show draft/unavailable/restricted sources;
do not label a bound reference as deliverable. Render text escaped. Selection,
course/unit/revision/page/session changes invalidate stale reviews and responses.
Write/uncertainty states freeze replacement of pending context; receipt recovery
must not be lost by ordinary selector changes. Distinguish confirmed saving from
fresh lists: refresh or clearly mark stale panels. Keep close/navigation warning.
Do not claim cross-reload recovery unless you actually implement/test it safely.

## Strict boundaries and reserved paths

NO Git/GitHub at all, including status/diff/log. NO live DB, migration execution,
providers, packages, deployment, credentials, payments, notifications, access
expansion, enrollment changes or student history/allowance reset. Never inspect
claim-token files or print tokens. Use MCP normally and keep claimToken private.
No auto-approval/bypass flags or editing tool guards. Stop and report on genuine
quota/permission/tool rejection; do not switch model/account or retry around it.

The old WorkBuddy M2-23 reservation remains untouched. In particular do not edit
server/src/routes/course-lessons.ts, student-course-access.ts, server/src/index.ts,
src/lib/api-http.ts, src/features/catalog/course-lessons.ts,
CourseLessonManager.tsx or StudentContent.tsx. Read them as needed. Add local
feature transport through authenticatedApiFetch/readAuthenticatedApiJson rather
than editing api-http. Exact disjoint allowedPaths are in the mailbox task; if a
real dependency cannot fit, checkpoint/report that specific dependency without
editing outside the allocation. Do not manufacture a blocker from old role text.

## Verification and delivery report

Use installed compatible Node:
`C:/Users/BaraaWael/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node.exe`.
Do not use the system Node 22.14 registerHooks failure as a product defect.
Backend tests: --import ./node_modules/tsx/dist/loader.mjs --import
./server/tests/helpers/isolated-io-guard.ts --test --test-reporter=spec <tests>.
Frontend tests: same tsx loader, --test --test-reporter=spec <tests>.
Types: node_modules/typescript/bin/tsc -p tsconfig.app.json --noEmit and
server/node_modules/typescript/bin/tsc -p server/tsconfig.json. Build: local Vite.

Test actual mounted routes and actual UI callbacks, not only pure injected seams.
Required cases: owner/tenant/course/source mismatch; missing/invalid schema;
immutable version and concurrent revision; archived template; changed source/
audience/timing/destination after review; position/count/singleton conflicts;
atomic rollback on any write/audit/receipt failure; duplicate/changed operation;
lost commit and read-only recovery; no pin/publication/history/access copying;
malformed/late/session-switched UI responses; timezones and keep/set/null timing.
Then run full frontend tests and relevant existing catalog/package reuse/source
suites. Preserve meaningful authority assertions and use synthetic I/O isolation.
Known premium-lecture failure is separate; do not claim entire backend green.

Checkpoint through MCP after contract, backend, UI and verification milestones.
Write `docs/agent-context/OPENCODE-BUSINESS-BATCH-A-REPORT.md` containing exact
changed files, actual routes/UI mount, schema files not applied, architectural
decisions, commands/exit codes/pass/fail counts and log paths, concurrency/cleanup
semantics, remaining limits and any precise blockers. No baseline counts reused
as new evidence. Submit that substantive report through MCP as reported/blocked,
then STOP all edits/activity on this task. Do not accept yourself or start batch B.
Codex independently inspects changes and reruns tests before deciding acceptance.
