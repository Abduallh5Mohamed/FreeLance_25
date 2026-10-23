# M2-02 dialog fixes verified; new lossy session fence not accepted

UTC2026-10-18T16:16:59Z / Cairo19:16:59. Branch codex/human-client verified.
Read handoff, README,056 and new worker036 plus actual sanitized bridge report.
client-m2-02-dialog-target-lifecycle-20261018-02 reported/stopped under protocol;
worker wb-m2-02-dialog-target-02a, sessionId=null, no native run mapping.
Initial dispatch active=[],ready=[],blocked=[].

Independent installed Node22.22.2/tsx verification: **454/454 client tests pass**,
no failures/skips/cancellations. Exact selected061 target-race probes **2/2 pass**.
Frontend tsc still **zero scoped errors,11 outside errors**, overall nonzero.
Reviewed actual controller/page changes: target/form incarnations now fence old
success/error, new form survives old completion, plain Button replaces Radix Close
action, page-owned forms/details clear on session events. These061 fixes work and
must be preserved. No DOM/browser runtime validation claimed.

## New verified regression in the corrective implementation

`digestSessionToken` uses **32-bit djb2**; buildCoursePrincipal uses that value as
session equality. The page now relies on this lossy fingerprint instead of exact
canonical token equality. Comments incorrectly call it non-reversible and claim it
changes on every rotation. Distinct inputs can produce identical keys.

Outside-repo reproduction:
`C:/Users/BaraaWael/TabwebClientSupervisor/064-course-session-collision.mts`.
Uses actual production buildCoursePrincipal and controller, fixture tokens only,
deferred transport. A pending create under fixture sessionA, then a distinct
colliding fixture sessionB with same user/role, returns **created** instead of
**blocked**. One selected test, **0 pass /1 fail**. This proves failed stale-result
fencing, not a demonstrated server authentication bypass or real JWT exploit.

**Decision: not accepted.** Prepared
client-m2-02-exact-session-fence-20261018-03 after predecessor reported/stopped;
same four056 paths and human provenance. Dispatch one ready, no active/blocked.
Codex did not claim/edit production source/tests or start replacement workers.

WorkBuddy: replace the lossy equality boundary with exact session comparison in a
private closure, or an opaque monotonic incarnation driven by exact equality.
No token in React state/logs/public key, no extra crypto/dependency/framework.
Test the actual reader used by the page: colliding fixtures, same-token stability,
different/silent replacement and observed A→B→A lifetime. Preserve meaning of the
counterexample if the helper API changes; do not weaken it or duplicate code in
tests. Keep all working061/454-test behavior. This is a finite correction of an
introduced regression, no expanded product scope.

## Worker036 questions and scheduling evidence

Installed dependency source plus actual production-seam tests are sufficient for
this no-DOM-harness review limit; no package/install blocker requested. Blocking
archive dismissal during a genuine in-flight archive is acceptable here; clearing
dialogs on all session notifications is an acceptable conservative boundary.
No request to undo those fixes. subscription_id gap stays documented, OTP deferred060.

Worker036 reports hourly automation ACTIVE, FREQ=HOURLY;INTERVAL=1 at this cwd;
this is now a worker acknowledgement, not independent access to its scheduler or
proof of continuing model liveness. Its schedule-control limitation is recorded;
Codex does not change the worker's account/runtime. Supervisor timer Ready, last
result0, next19:30:09 Cairo, STOP absent. No429/new human blocker; continue bounded
correction. M1/039 and M2-01/055 closed; no later batch authorized.
Clear only own pending marker queuedAtUtc2026-10-18T16:15:11.9265242Z.
