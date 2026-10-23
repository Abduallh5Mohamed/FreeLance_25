# M2-05: correction required; stopped native claim recovery

UTC2026-10-19T07:00Z / Cairo10:00. Branch codex/human-client.
Task client-m2-05-dashboard-profile-20261019-01, owner wb-m2-05-dashboard-profile-01a.

## Worker evidence / actual termination basis

New worker053 explicitly states previous automation was interrupted after partial
edits, its in-memory token lost; resumed implementation is complete and final disk
state STOPPED. It documents failed reclaim (worker already owns task), no native
session mapping, no MCP checkpoint/report possible. This is substantive stopped
handoff evidence, not age or inferred liveness. Accept053 as offline stopped
submission for SOURCE REVIEW ONLY, not implementation acceptance or fabricated
MCP report. Keep original claim evidence/reference, fence it through supervisor
retire API with053 termination evidence and create fresh bounded recovery task.
Never read/export private claim token, recover it from files or silently recycle ID.

## Independent checks and decision

Read actual five-path source/diff/tests/contracts. api-http change is additive
DTO/getMyTenantProfile only. Page uses tested controller and existing canonical
transport. New isolated tests27/27 pass independently. Frontend tsc nonzero:
zero scoped diagnostics/same11 outside. Worker610 full-test claim not independently
rerun this interval because verified defects already require correction. All22
prior accepted checkpoint hashes unchanged. NOT ACCEPTED.

Four independent production probes FAIL, artifact:
C:/Users/BaraaWael/TabwebClientSupervisor/113-m2-05-review-probes.test.ts.
No copied implementation, live services or real private data.

### F1: error code substituted for transported error message

profile.ts classifyTenantProfileFailure uses TOKEN_EXPIRED/SESSION_REVOKED/
TENANT_SUSPENDED/STUDENT_SPACE_REQUIRED as Error.message. Actual request() throws
response.error, discarding response.code/status. auth.ts:218/254 sends error
'Token expired', :122/127/131 'Session revoked', :160 'Selected workspace is no
longer active', :138 'Instructor account is administratively suspended'; student
boundary:17 sends 'Select an instructor workspace first'. All currently fall
into generic retryable error. Three probe groups reproduce misclassification.

Fix exact actual transported messages; do not change shared request/auth contract
or fake codes/status. Add production transport-to-controller regressions using
real response bodies (including error+code) so isolated classifier tests cannot
bless unreachable strings. Test403 session teardown event plus late failure and
logout with no stale identity/extra uncontrolled reads. Correct contract wording:
distinguish code field from error message. Preserve unknown-error fail closed.

### F2: observed silent principal replacement only drops reply

Load confirmed A profile, start refresh, replace principal with B without event,
resolve old reply. isCurrent compares and returns false but does not retire cached
profile or loading phase. Independent probe sees A's private identity retained,
loading stuck. Adopt observed principal changes at entry and completion: invalidate
old generation, clear identity/error/loading, release correct latch, permit usable
retry/new load. Cover A-B-A, silent error/success, old finally vs newer busy and
normal session notifications. Do not suppress this regression by adding a notifier
to the silent-change scenario. No polling/history-key map/lossy hash needed.

## Required bounded recovery

Fresh task client-m2-05-profile-correction-recovery-20261019-01, SAME five105 paths.
First inventory actual disk, preserve all completed partial work and27 tests;
targeted corrections, no rewrite. Meaningful integrated regressions, external113
probes pass, appropriate client regression/type checks, truthful contract and
stopped native MCP report. Performance evidence is bounded request counts/latch
and listener cleanup, not latency/scalability claims. No unrelated feature/auth/
backend/shared policy changes. Existing human105 authorizes corrections, no new gate.

WorkBuddy claims natively; Codex does not implement. Retirement is justified by
actual stopped053 handoff, not elapsed time; no replacement while known activity
continues. No human action currently required: authorized supervisor retirement
and fresh task provide recovery path, no STOP. Continuous075 timer persists;
OTP deferred060, M2 incomplete. Remove only own07:00:11.9707983Z pending marker.

Recovery verified: old claim fenced by supervisor retire API using explicit053
stopped evidence; fresh recovery approval hash valid, dispatch active=[],ready=
[client-m2-05-profile-correction-recovery-20261019-01],blocked=[]. No token read or
printed. A preparation string check first failed due to shell encoding before
any mutation; corrected escaped evidence check then succeeded. Timer Ready/result0,
next10:15:09 Cairo, STOP absent. All22 accepted checkpoint files unchanged.
