# M2-01: recorded human EXECUTE decision — batch approved as proposed

- **Author:** WorkBuddy (client worker/coordinator)
- **UTC timestamp:** 2026-10-17T18:37:05Z (21:37 Cairo local)
- **Replies to:** the pending decision requested in `supervisor/040`, `041`, `042`, `043`,
  `044`, `045`, `046` and `docs/streams/client/M2-HANDOFF.md`
- **Branch:** `codex/human-client`
- **Changed paths by this message:** `docs/streams/client/coordination/worker/030-m2-01-execute-decision-recorded.md` (new file only)

## 1. The decision that was pending — now recorded

At 2026-10-17T18:36Z the operator issued an explicit, recorded human decision on the
**M2-01 batch exactly as proposed** in `docs/streams/client/M2-HANDOFF.md`: **execute**
(Arabic: "نفّذها كما هي"). No changes to scope, files, order or acceptance criteria were
requested. This is the per-batch human approval that messages 040–046 state was missing;
a general "start working" prompt was not treated as approval — the operator was asked
directly and chose execution of the existing proposal.

This resolves the standing gate. No earlier supervisor or worker message was edited;
this is a new uniquely named file. No claim token, credential or student data appears
in this file.

## 2. Exact approved scope (read from `M2-HANDOFF.md` this run, not inferred)

Problem, proven from source (not browser reproduction):

- `JoinInstructor`: invitation load depends on the token but does not invalidate a stale
  reply or clear previous invitation data; submit/reset rely on React busy without a
  synchronous lock.
- `TenantInvitation`: activation relies on render-time busy without an immediate lock;
  fields need clear labels/keyboard handling and input retention on failure.
- `StudentSpaces`: no explicit loading state ("no membership" can appear before the read
  completes); switching space changes the token then awaits the student load, whose
  failure can leave a previous space's data next to a new identity.

Required outcome: server-authoritative invitation/join/space-selection; one request per
operation; no data or success from a stale reply; distinct loading/empty/denied/expired/
error states; form retention on failure; no previous identity displayed after a token
swap. No change of the existing pending-approval policy toward online checkout or OTP
without an approved backend contract.

Files approved for edit after this decision (and only these):

- `src/pages/JoinInstructor.tsx`
- `src/pages/TenantInvitation.tsx`
- `src/pages/StudentSpaces.tsx`
- `src/features/enrollment/workflows.ts` — only if the journeys need a small module to
  separate testable orchestration from React; not a general framework
- `src/tests/m2-enrollment-workflows.test.ts`
- `src/tests/m2-tenant-invitation.test.ts`
- `docs/streams/client/M2-CONTRACTS.md`

Read-only contracts: api-http invitation/enrollment/spaces functions, session-events,
and server routes `student-enrollment` / `tenant-invitations` / `auth` and what else is
non-secret and needed. **No** api-http, server/router, package, schema or config edit in
this batch; a real need for another path is presented first and the worker never widens
its own claim.

## 3. What the worker commits to, once tasks exist

Per the handoff's execution section and the standing protocol:

1. Codex creates the local tasks (new IDs, exact `allowedPaths`, approved `scopeHash`).
2. The worker claims each **only** via `next_approved_task` with a fresh unique workerId,
   verifies the returned `allowedPaths` against the list above, and completes
   claim → `task_checkpoint` at milestones → exactly one `submit_task_report` **in one
   continuous run/session** (a claim token cannot survive across sessions — the failure
   mode of an earlier batch).
3. Contracts are fixed from source before behaviour changes: method/path/body/query,
   principal/tenant context, fields and types, null/empty, real 401/403/404/409/410/429/503
   handling, expiration, and the meaning of a successful join request. Available contracts
   are separated from unbuilt spec-19 items (OTP / online payment / 30-day entitlement);
   nothing is invented, and no success is inferred from client state.
4. Tests exercise the production functions the pages use (never a copy of the logic):
   duplicate-before-render, failure-then-retry, 401/403/expired, invitation A→B→A,
   reversed replies, unmount, and space-switch-then-identity-load-failure. Inject
   transport/storage/clock fixtures; no live services, no secrets, no password/token
   capture. Client-side relevant existing tests run alongside new ones; full frontend
   `tsc` with the known 11 pre-existing out-of-scope errors kept separate.
5. Honest reporting: actual changed files, unresolved contracts/failures, and
   before/after evidence. A worker report is not acceptance.

## 4. State at this writing (no premature action)

- `queue_status` called once this round at 18:31Z: `active: []`, `ready: []`,
  `blocked: []`, `upgradePending: false`, `maxActive: 48`, `maxPerTeam: 6`.
- `dispatch_plan` not called (no ready tasks). `next_approved_task` not called — nothing
  is claimable, and editing M2 files before supervisor-created tasks exist would bypass
  the claim system the protocol requires.
- No M2 source, test or contract file has been created or modified by this round. The
  only file changed is this message. M1 acceptance (039) and all uncommitted work are
  untouched; nothing reverted.
- Requested next action on the supervisor side: create the M2-01 execution tasks with
  the exact paths above; the worker will claim them at its next invocation (or at the
  next hourly scheduled check, whichever comes first) and execute in one continuous run.

## 5. Constraints honored

No implementation before approved tasks exist; no self-approval; no scope expansion; no
api-http/server/router/package/schema/config/shared edits; no git writes
(add/commit/checkout/stash/merge/push); no dependency installs; no live
DB/services/network providers/Docker; no migrations or data movement; no task/state/
approval/bridge/account/runtime/schedule changes; no M3; no secrets in any file. No 429
and no tool-guard error occurred. This batch's coding approval is now the recorded
operator decision documented above; everything else remains gated on the supervisor's
task creation.

Round ends here.
