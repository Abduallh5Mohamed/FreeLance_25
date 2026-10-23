# M2-04 not accepted: production lifetime regressions independently reproduced

Review UTC2026-10-18T20:46Z, branch codex/human-client. Consumed worker043/044.
Original task client-m2-04-instructor-students-20261018-01 is reported at20:42:41Z;
worker044 explicitly states all activity stopped before report. Sanitized dispatch
active=[],ready=[],blocked=[] before correction creation. No owner was retired or
replaced by age. Native sessionId unavailable; workerId is
wb-m2-04-instructor-students-01a, not a fabricated native run ID.

## Independent evidence and decision

Read actual controller, page integration, scoped tests/contracts and page diff.
Production orchestration is separated from React with injected transport and
per-section request generations, synchronous mutation latches and ticket-owned
busy entries. Those are useful improvements, but lifetime coverage is incomplete.
All563 client tests independently pass. Frontend tsc still exits1 with exactly11
outside diagnostics, zero scoped. No DOM/browser/HTTP/DB/provider/performance
claim. Fifteen accepted055/067/074 checkpoint hashes unchanged.

Three independent tests importing the unchanged production controller ALL FAIL:
external artifact C:/Users/BaraaWael/TabwebClientSupervisor/078-m2-04-review-probes.test.ts.
Fixtures only; no real credentials or student data. These are acceptance failures,
not reasons to weaken assertions or accept the worker's passing count.

1. Silent principal replacement is observed but never adopted. Load confirmed
   students and an invite under A; start a read, replace principal with B without
   a notifier, finish read. isCurrent merely returns false; old confirmed rows
   and private invite remain. Mutation paths likewise compare without retiring
   cached state. Centralize observed identity adoption/retirement within this
   feature at operation entry and every post-await commit; clear private state,
   invalidate form/operations and release only correct tickets. Preserve observed
   A-B-A incarnations, disposal and usable retries; no polling/shared edits.
2. Decision completes server write under A then awaits runRequestsRead. Switch
   session to B during that read; resolve it. decideRequest still returns
   'approved', so the page publishes A's success in B. Recheck operation/session/
   scope after EVERY awaited refresh and before page effects. Audit analogous
   submit/reset/suspend and stale-error refresh branches, including A-B-A and
   disposal. Do not convert confirmed server writes into retryable write failures.
3. Invite copy and rotation have independent latches without link incarnation.
   Start copying old link, rotate to new link whose clipboard write rejects,
   finish old copy successfully. inviteCopied becomes true for the NEW link that
   was never copied. Fence copy state/outcome to exact link incarnation (or safely
   serialize conflicting operations); test both completion orders and failures.
   Clipboard retry must never rotate; preserve confirmed new link.

Keep corrections narrow; add actual production regressions in the approved test
file and update contracts honestly. No whole-controller rewrite or cross-feature
refactor. Existing manual recovery/video/wallet policies remain unchanged.

## Bounded correction and continuing coordination

Create client-m2-04-instructor-students-correction-20261018-01 under the existing
human M2-04 authorization, only its same four allowedPaths. Original submission
remains reported/not accepted; no active worker files edited by Codex. WorkBuddy
claims/implements natively and reports after stopping. Original tests must stay
green plus these regressions; rerun appropriate client tests and scoped types.

Worker044 backend/shared-reader questions: M2-B01 remains a prepared proposal,
not approved implementation; this correction grants neither server ownership nor
shared session-reader edits. Team clarification076 already resolves the external
developer question; no outside developer delivery is awaited.

Continuous supervision075 remains in force: no STOP for these bounded defects or
individual batch completion. Timer observed Ready; no429. M2 overall incomplete,
OTP deferred060. Clear only this review's exact20:45:12.3213345Z pending marker
after posting and verifying correction dispatch; no schedule/account changes.
