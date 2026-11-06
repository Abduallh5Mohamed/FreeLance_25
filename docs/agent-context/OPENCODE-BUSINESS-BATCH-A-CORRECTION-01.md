# Batch A — independent review: correction required

Task: `business-20261106-a-correction-01`. OpenCode implements; Codex reviews.
Read original batch A architecture and this correction before editing. Deliver
ALL corrections as one complete owner journey with meaningful route/UI tests.
Do not stop at isolated helper fixes. Exact mailbox allowedPaths apply; preserve
the old WorkBuddy reservation and all unrelated local work. No Git/GitHub,
packages, live DB/migrations/providers/deploy, account/model fallback or guard bypass.

## Independent evidence (stopped original snapshot)

Original worker exited 0 but did not submit MCP. One same-native-session recovery
was restricted to reporting; it exited 0 and stated original claim context was
unavailable, without submitting. Both original and recovery processes were
verified absent. This is not quota/permission rejection, expiration or acceptance.
Supervisor formally fences that terminated claim and allocates this NEW scoped
correction; never reuse or recover its secret/token from private files.

Codex independently ran installed compatible Node with tsx + backend isolated-I/O
guard: 35 scoped backend tests pass; full frontend 2118 pass; both type checks
and Vite build pass (existing chunk warning). This corrects the original report's
system-Node registerHooks failures; those five failures are not a code defect.
Passing current suites does not cover the findings below. Existing template
backend fixture begin/commit/rollback are no-ops, so it does NOT prove rollback.
Current frontend tests do NOT exercise the mounted template UI callbacks.

Supervisor-only diagnostic probes against real controllers and actual component
callbacks (synthetic inputs, no DB/browser) reproduced:

- Create dependency increments a synthetic durable creation counter then rejects
  as a lost reply. Controller clears saving and says «لم تُنشأ مراجعة جديدة»
  even though the counter is one.
- After library refresh returns one owner-A template and next-page read starts,
  change readPrincipal from A to B without firing an event, then resolve. State
  remains loading with one old-A template. Principal guard made invalidation
  unreachable rather than clearing private state.
- With application child uncertain, actual parent's «حفظ قالب من حصة» has no
  disabled guard and its callback changes panel to create, discarding recovery.
  Actual application's close button is also enabled in uncertain state.
- With the shared reference schema isolated as valid, the new template schema
  gate returns true when ALL new columns are nullable VARCHAR(1), as long as
  names/engines/unique-index names match. It does not inspect returned data types,
  required lengths/collation/nullability or needed FK relationships.

These observations are concrete required corrections, not production verification.

## C1 — truthful, recoverable library writes

`createTemplateLibrary.save/archive` must distinguish confirmed, definite rejected
and uncertain outcomes. A timeout, lost/malformed response or 5xx cannot assert
that no template/revision was saved or unlock blind retry. Add bounded timeout
to archive too. Preserve operation identity, freeze further conflicting writes,
and provide read-only recovery under current owner/course authority.

Add durable payload-bound idempotency for create/revise/archive as needed in the
allocated UNAPPLIED migration files. Atomic writes/audit/receipt, matching replay,
changed-payload conflict and unknown-commit connection discard apply to library
writes as well as applying a template. Receipt is historical evidence; missing
receipt is not cancellation proof. Do not solve uncertainty by trying another
name/revision or treating a generic failure as a confirmed rollback.

## C2 — preserve pending context across real UI navigation

Wire library and application busy/uncertain state to the parent and source picker.
Ordinary refresh/paging/template/revision/source/panel/close controls must not
discard a pending library/apply operation. Enforce admission in controllers or
handlers too, not only disabled markup. Reuse stable lock callbacks/patterns
already used by BUILD-33. Do not implicitly unmount recovery when active template
lists change. Whole-page navigation remains a separately disclosed memory-only
limitation unless safely implemented; clearly warn without claiming cancellation.

## C3 — principal/session/privacy fences and bounded lists

Separate flight-liveness checks from principal equality: on an otherwise-current
response or error with changed principal, invalidate and clear private rows and
selectors. Current `if(current()) if(principal changed)` cannot execute because
current already requires equality. Apply to all library operations and manual
revision/source reads, including failed reads and silent identity/storage changes.
After session invalidation hide/clear parent revising/destination/source metadata,
not merely the library array. Prevent late `.then(setSnapshot/setRevisions)` from
restoring old-context data. Use event/storage cleanup and deadlines consistently.

Library next currently accumulates arbitrarily many rows despite page-sized
requests. Use bounded page replacement/history or an explicit finite cap with
honest navigation; reject repeated cursors/duplicate IDs and stale target pages.

## C4 — exact revision selection and timing/review binding

Revision history currently fetches only its first page and automatically assigns
the last returned revision. A late response can change the displayed revision
after a different revision was reviewed, without clearing the controller review.
Old revisions remain displayed while a new template's history is loading/failed.
Provide bounded first/next history controls and only allow a confirmed loaded
revision of the selected template. Invalidate review/approval on every actual
selection/page/timing change, including programmatic response-driven changes;
never change selection during a pending apply/recovery. Fence late history reads.

Bind strict review/receipt DTOs to the requested template/revision/destination/
timing where relevant; do not present a mismatched response as a current reviewed
selection. Preserve the existing explicit keep/set/clear UTC semantics and Cairo
display. No copied publication, pin, student history or allowance changes.

## C5 — actual schema and stored-version integrity

Check new columns' required data types, lengths, nullability, binary identity/hash
collations and transactional engines. Verify necessary unique indexes and FK
relationships against actual catalog. Missing/incompatible schema must fail
closed before writes; migration text or a names-only fixture is insufficient.

Validate stored references before planning/writing: correct per-kind null/non-null
position, integer [0,2147483647], unique mixed positions, singleton/source count,
actual media/reference counts and the stored content hash/revision identity.
Reject malformed/corrupt saved state before any mutation. Extract/reuse one
bounded shared final-state planner for direct reuse and templates, not a weaker
duplicated copy policy. Preserve BUILD-32 route contracts and original positions.

## C6 — prove the failure paths through actual wiring

Use a transactional synthetic fixture with snapshots restored on rollback and
an explicit lost-commit mode; a no-op rollback cannot prove atomicity. Test all
five reference kinds, stale source/audience/destination/timing, archived template,
missing/invalid schema (types/FKs/index), optimistic revision race, position/count/
singleton conflicts, reference/timing/audit/receipt failures, duplicate/changed
operation, missing/failed recovery and unknown commit/destroy. No-write assertions
must inspect actual stored references, release time, audit and receipt state.

Add tests invoking actual mounted template UI callbacks/effects with canonical
transport and synthetic HTTP, like existing lesson-package-reuse/source suites.
Cover parent navigation during pending/uncertain writes; library unknown outcomes;
principal/session/storage change; late revision pages; review/apply mismatch;
archive deadline; escaped titles; absence of any pin/publication/history grant.
Controller-only seam tests remain useful but do not replace these actual callbacks.

## Runtime, milestone reporting and stop

Task allocation must be obtained ONLY through the intended tabweb_supervisor
MCP tools. Do NOT read external `TabwebClientBridge/tasks/*.json`, state,
claim or supervisor runtime files. A native permission review rejected those
administrative file reads; that rejection remains in force. Do not reissue them,
copy their contents, change configuration/permissions or seek a shell workaround.
`next_approved_task` for this explicitly approved ID is the authorized claim/scope
interface. If that intended MCP operation itself is denied, stop and report once.

Use this executable explicitly for EVERY test/type/build command, not npx or
the system Node: `C:/Users/BaraaWael/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node.exe`.
Backend: --import ./node_modules/tsx/dist/loader.mjs --import
./server/tests/helpers/isolated-io-guard.ts --test --test-reporter=spec <files>.
Frontend: same tsx loader --test --test-reporter=spec <files>. Run focused tests,
full frontend, relevant existing catalog/package suites, both types and Vite.
Keep actual command/exit/count/log evidence under the allocated output directory.

Immediately after claiming, submit a natural MCP checkpoint with your own token;
repeat at backend/UI/verification milestones to preserve native claim context.
Never write/print the token or inspect private claim files. If context is lost,
stop and report that blocker rather than fabricating authority. Before exiting,
write `docs/agent-context/OPENCODE-BUSINESS-BATCH-A-CORRECTION-REPORT.md`, then
ACTUALLY call submit_task_report for this exact claim (reported/blocked), and stop
all product work. A Markdown file alone is not a submitted report. Do not alter
the original batch report or self-accept. Codex independently reviews next.
