# Supervisor 040/041 — M2 proposal verified on disk; no claim, no scope substitution, awaiting human decision

UTC: 2026-10-17T17:29Z (2026-10-17 20:29 Cairo local).
Branch verified: `codex/human-client`. Read coordination README + WORKER-PROMPT-CLIENT.md.
Last worker reply before this one: `worker/028` (final-acceptance consumption).
New supervisor messages since `worker/028`: `040` and `041`. Read only those two.

## Correction of the record (041's factual point)
`docs/streams/client/M2-HANDOFF.md` **does exist** on disk and was read in this run
before writing anything. `supervisor/040` also exists. The earlier claim relayed in
041 — that no M2 batch proposal exists — is **not reproduced here and is withdrawn**.
What the file actually contains (read, not inferred):
- Status line: M2 source inspection and batch preparation only; **code execution not
  started**; no claims, no ready execution tasks, no services, no new tests, no
  rescheduling before the approval in 040/041.
- Batch **M2-01** = existing client workflows `JoinInstructor`, `TenantInvitation`,
  `StudentSpaces` (stale invitation response path, state-only submit/activation
  guards, missing loading state, incomplete identity after token swap).
- Proposed (post-approval only) allowed paths: `src/pages/JoinInstructor.tsx`,
  `src/pages/TenantInvitation.tsx`, `src/pages/StudentSpaces.tsx`, an optional small
  `src/features/enrollment/workflows.ts`, `src/tests/m2-enrollment-workflows.test.ts`,
  `src/tests/m2-tenant-invitation.test.ts`, `docs/streams/client/M2-CONTRACTS.md`.
  Read-only contracts: api-http invitation/enrollment/spaces functions,
  session-events, server routes `student-enrollment` / `tenant-invitations` / `auth`.
  Explicitly excluded from that batch: api-http, server/router, packages, schema, config.

## This run
- `queue_status` called exactly once at 17:29Z: `active []`, `ready []`, `blocked []`,
  `upgradePending false`, maxActive 48, maxPerTeam 6. Empty queue.
- `dispatch_plan` **NOT** called — no ready tasks exist, and 040/041 forbid claiming or
  starting M2 work before the human decision.
- No `next_approved_task`, no claim, no `task_checkpoint`, no `submit_task_report`
  (no active claim; a worker report is not acceptance).
- No 429, no tool-guard error.

## Position on the two new messages
1. **No M2 work is started and none is claimed.** 040 and 041 both state the concrete
   batch needs an explicit human execute/decline/changes decision, and that a general
   "start M2" instruction is not per-batch approval. I do not self-approve, do not
   create tasks, and do not treat `M2-HANDOFF.md` existing as execution permission.
2. **No scope substitution.** The public teacher/catalog slice raised earlier is a
   different slice; it is not presented as a replacement for M2-01 and no public
   projection/API contract is asserted by the worker. If a catalog slice is wanted,
   it needs its own presented proposal and human approval.
3. **M1 acceptance 039 stands.** M1 remains complete and accepted; nothing in this run
   touches M1 tasks, states, approvals or the uncommitted M1 work.
4. **What the worker needs to proceed:** a human decision on the M2-01 batch as
   described in `M2-HANDOFF.md` (execute / changes / decline), then supervisor-created
   fresh exact-path tasks with scopeHash. Only then will the worker claim via
   `next_approved_task`, verify each returned `allowedPaths`, and run
   claim → checkpoint → single report in one continuous run.

## Verification notes / limitations
- Both M2-01 defects and the proposed file list above are **read from source and the
  handoff document**, not from a browser or live service; no reproduction is claimed.
- Missing backend guarantees for OTP / online checkout / entitlements are recorded as
  gaps to document, never invented — consistent with 041.
- Timestamp hygiene: `worker/028` labelled 19:24 as UTC while it matches Cairo local
  time (16:24Z). This message uses true UTC; no prior message was edited.

## Constraints honored
No production code, tests, task/state/approval, bridge config, account, runtime or
schedule change. No git writes (no add/commit/checkout/stash/merge/push), no installs,
no live DB/services/network providers/Docker, no M2 implementation, no new phase, no
scope expansion, no self-acceptance. All uncommitted work preserved; nothing reverted.
Only this one new file was created; no existing message was overwritten or deleted.
