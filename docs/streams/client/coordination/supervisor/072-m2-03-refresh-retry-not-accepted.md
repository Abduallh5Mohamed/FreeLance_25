# M2-03:070 fixes pass, but the actual refresh Retry path still clears data

UTC2026-10-18T18:16:54Z / Cairo21:16:54. Branch codex/human-client verified.
Read handoff, remaining inventory, README,068, worker040 and actual sanitized
report for client-m2-03-course-transition-preview-20261018-02, worker
wb-m2-03-course-transition-preview-02a, reported18:02:21.063Z. Stopped under report
protocol; initial active/ready/blocked empty. SessionId=null, native run unavailable.

Independent managed Node22.22.2/local tsx: **508/508 client tests pass**, no fail/
skip/cancel; exact selected070 production probes **2/2 pass**. Frontend tsc:
**zero scoped diagnostics**, same11 outside errors, command nonzero.

Read actual controller/page diffs, ticket retirement, malformed refresh handling,
preview state/resolver/rendering and new tests. Fixed scope latch now safely
releases old ownership; ticket-finally cannot release newer work. Controller owns
preview ID and current-list resolver; scope/session retirement no longer leaves a
page-owned stale URL mounted. These fixes are accepted as resolved findings, not
acceptance of the whole batch. No player/provider/shared edits requested.

## Remaining already-requested070 current retry case

Automatic write-followup calls runMaterialsLoad(...,'refresh') and now preserves
confirmed rows on malformed data. But public **refresh()**, which the page's Retry
button calls, still unconditionally passes **'list'**. A second malformed/rejected
read after a confirmed write therefore destroys that preservation guarantee.

Outside-repo probe:
C:/Users/BaraaWael/TabwebClientSupervisor/072-material-refresh-retry.mts.
Actual production controller with injected transport: load known rows; create
confirmed; automatic refresh returns non-array (rows correctly retained); invoke
actual refresh() retry with same malformed body. Expected confirmed rows plus
refreshError; actual rows **[]**, initial-load error path. **1 selected test,
0 pass /1 fail**. No duplicate implementation or browser claim. Worker tests
cover a successful retry, missing the repeated-failure branch.

**Decision: not accepted.** Prepared finite correction
client-m2-03-refresh-retry-preservation-20261018-03 only after reported/stopped
predecessor; same four068 paths and human provenance. One ready, no active/blocked.
Codex did not claim or edit worker production/tests. Keep changes focused on
initial-load versus refresh intent, no new framework or lifecycle rewrite.

Cover actual method used by Retry: repeated malformed/rejected refresh preserves
last confirmed rows/separate error, createError stays null, no extra create;
successful recovery replaces rows/clears refreshError; genuine initial error and
empty-confirmed list remain honest; old course/session replies stay fenced.

Worker040 replies: source plus actual production preview seam is sufficient for
the current documented no-DOM limit; no dependency/install task requested and no
runtime RTL/a11y claim. Upload/provider/conversion contracts remain developer1
deliverables, tracked as narrow068 future blockers; this client stream must not
invent them. OTP deferred060. M1/039,055,067 remain closed; no later batch.

No429/new human blocker while bounded correction proceeds. Timer Ready, last
result0, next21:30:09 Cairo, STOP absent. Clear only this review's marker:
queuedAtUtc2026-10-18T18:15:11.3508246Z.
