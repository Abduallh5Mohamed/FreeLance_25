# M2-02 exact equality fixed; observed session lifetime still incomplete

UTC2026-10-18T16:31:55Z / Cairo19:31:55. Branch codex/human-client verified.
Read handoff, README,056, worker037 and actual sanitized checkpoint/report for
client-m2-02-exact-session-fence-20261018-03, worker
wb-m2-02-exact-session-fence-03a, reported16:25:05.649Z. Report protocol requires
stop. SessionId=null; no native run mapping. Initial active/ready/blocked empty.

Independent managed Node22.22.2/local tsx: **464/464 client tests pass**, no
failures/skips/cancellations; exact064 collision probe **1/1 pass** and061 target
probes **2/2 pass**. Frontend tsc: **zero scoped errors,11 outside diagnostics**,
overall nonzero. Reviewed production registry, reader, actual page integration
and added tests. The lossy hash defect is fixed; preserve those working changes.

## Remaining requested064 observed-incarnation case

Worker037 asks whether A→B→A should mint a new incarnation. **Yes for an observed
transition, as064 already explicitly required.** The new module-wide registry
assigns each historical identity a stable ID, so returning to A restores its old
ID. Existing A→B→A test fires session-bus notifications and passes because those
invalidate controller generation; it does not test the silent observed transition.

Independent outside-repo probe:
`C:/Users/BaraaWael/TabwebClientSupervisor/065-course-session-incarnation.mts`.
Injects the ACTUAL production storage reader into the real controller. Start a
deferred save in A; switch storage silently to B; run actual loadOptions, which
observes B through the same reader; return storage to A; resolve the first save.
Actual **created**, expected **blocked**. One selected test: **0 pass /1 fail**.
No real tokens, services or duplicated identity implementation involved.

Decision: **not accepted**. Prepared finite correction
client-m2-02-observed-session-lifetime-20261018-04 after predecessor reported/stopped,
same four056 paths and human provenance. One ready, no active/blocked. Codex did
not claim or edit worker source/tests. No replacement based on elapsed lease.

Keep exact comparison private and consecutive unchanged reads stable; an observed
transition including logout/null advances lifetime, and returning to a previously
seen token gets a new incarnation. A small per-reader/page closure with latest
comparison + counter is sufficient; no historical-session registry, crypto or new
framework needed. Test actual page reader/controller, A→B→A and A→null→A, plus
stable-current positive controls. If API shape changes, transparently adapt probes
to the actual reader while preserving blocked assertions. No requirement to detect
an intermediate state never observed by code; no speculative polling or services.

All061 dialog/form/target fixes stay. No rendered-DOM harness/dependency requested.
subscription gap remains documented, OTP deferred060, M1/039 and M2-01/055 closed.
Hourly ACTIVE remains worker acknowledgement, not independently guaranteed liveness.
No429/new human blocker; supervisor task Ready, last result0, next19:45:09 Cairo,
STOP absent. No later batch. Clear only own marker:
queuedAtUtc2026-10-18T16:30:11.3787882Z.
