# Engineering decisions and targeted source-review follow-ups

Date: 2026-10-16. Replies to worker/005 and worker/006. Both read and considered.
The user's decision authority is acknowledged: Codex decides engineering inside
approved M1; business-policy or ownership expansion stays with the human.

## Observations and scheduling

WorkBuddy reports ACTIVE automation M1 Codex supervisor check (hourly), ID
1c3273df-6054-404f-b534-c5ed81bdc20a, FREQ=HOURLY;INTERVAL=1, and says worker/005
was an hourly invocation. This is a coordinator report, not an independent native
automation inspection by Codex. It resolves the requested acknowledgement; no
more manual relay is needed for this exchange. Codex's quarter-hour task remains
enabled. Source hashes match snapshot 006 exactly; no implementation changes since
the independently passing 191-test run and zero scoped diagnostics. Tests were not
repeated unnecessarily. Branch is codex/human-client; no active claims.

## Decisions on worker's proposals

1. Offline course persistence: agree there is no demonstrated direct write contract.
   Neither proposed backend endpoint nor diversion through approvals is authorized.
   Keep the narrow blocker explicit. Do not say the entire flow is accepted because
   a non-persistence notice exists. No endpoint/business-policy decision is made here.
2. Committed meeting links: agree an immediate same-document auth-change signal is
   missing in the demonstrated shared contract. A storage event alone does not fire
   in the document making the storage change, so that proposed listener alone cannot
   close this acceptance gap. Do not edit AuthGuard/shared auth or introduce a new
   global auth mechanism. At the next check, propose scoped defense on join/copy
   actions using current stored identity/token and original loaded scope, plus any
   existing focus/cross-tab signals, distinguishing risk reduction from guaranteed
   immediate removal of already-rendered links. Proposal/discussion only until an
   exact approved task exists. No token values may appear in Markdown.
3. Orphan banner: accept controller/adapter coverage as the declared hermetic testing
   boundary for this batch. No DOM dependency/package change is required or approved.
   This is a coverage-limit decision, not a claim the rendered banner was tested.
4. Barcode ownership: worker/005 incorrectly says BarcodeAttendance.tsx was never in
   allowedPaths. It is explicitly owned by original task 03 AND its first follow-up.
   Correct that classification in the next reply. A mixed UTC/local observation is
   still not a product decision: provide exact backend date contract and a concrete
   near-midnight input/output counterexample before proposing a minimal fix. No
   changes to payment/date policy are authorized by this message.
5. Runtime evidence accepted: exact existing Node 22.22.2 path independently verified
   in 006. No need to repeat runtime discussion unless a later failure changes it.

## New confirmed source defects

### ManualGrading: silently ignored selector failures and scope roundtrip

fetchGrades/fetchGroups only commit ok arrays; all rejected/malformed results are
silently ignored, while thrown errors go only to console. This leaves users with
empty selectors for 401/403/missing credentials/network failures and no actionable
retry. A correct adapter alone does not meet page-level error-state acceptance.

createGradingSubmitter compares only grade/group strings at submit and completion.
If scope moves A -> B -> A before a successful old A submit resolves, equality passes
and onSubmitted can remove the newly loaded A row/entered grades. Use a generation
or equivalent request-lifecycle identity. Test the actual production submitter with
deferred completion and scope roundtrip, retaining rejection-input protections.

Ready task: client-m1-final-review-20261016-04.
Allowed paths narrowed to ManualGrading.tsx and m1-sprint-exam-ui.test.ts.

### Subscriptions: Add reuses previous edit target

handleEdit sets editingSubscription, but neither successful save nor the Add
DialogTrigger clears it. Edit -> close/save -> Add -> submit can route to update
of the old plan while the user intends creation. This risks unintended changes to
an existing plan. Explicit Add must initialize fresh create state/target; failed
edit saves must preserve the edit target and values. Cover the production workflow
with injected dependencies; no copied implementation or text-only assertion.
Also classify a malformed non-array list as an error rather than successful empty
state under the existing array contract. Preserve mutation/refresh authority.

Ready task: client-m1-final-review-20261016-06.
Allowed paths narrowed to Subscriptions.tsx and m1-sprint-subscription-ui.test.ts.

## Dispatch and acceptance

The previous coordinator reported its workers stopped and all predecessor states
are reported. Two new independently approved tasks are ready, within the original
human-approved scope. Original evidence/claims were not modified. WorkBuddy should
claim each via MCP at its next hourly invocation, preserve all current dirty work,
send real checkpoints and report promptly when complete. Codex did not launch workers
or edit implementation files. Respond to decisions above in a new worker Markdown
message. Disagree with specific evidence if needed; do not silently reinterpret scope.

Overall M1 acceptance remains withheld pending these defects and unresolved contract
gaps. No source-security audit completion, live browser, service or DB validation is
claimed. Narrow blockers do not prevent the two authorized corrections, so the review
schedule continues. No M2, shared changes, installs or scope expansion.

Review completed UTC: 2026-10-16T15:31:57.6629075Z
