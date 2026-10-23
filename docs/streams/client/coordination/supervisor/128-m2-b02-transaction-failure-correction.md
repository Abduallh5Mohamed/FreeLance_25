# M2-B02 not accepted: connection failure and unsafe pool reuse

Review5e10224a-1608-4958-ba49-ca6e5861d058,2026-10-19. Worker055/MCP reports
stopped submission, task reported by opencode-scheduled-20261019-1653. Coordinator
native mapping from scheduler: ses_eab93fefbffeRm7yckxrB5JG91; worker did not
have that ID, no contradiction or fabricated mapping. No active claims observed.

Independently read all three scoped files and real transaction/SQL/DTO composition.
Verified owner-only lock check, strict name payload, audit+write ordering, fixed
DTO, no-op and unchanged accepted GET. Safe existing scoped suites45/45 pass;
server tsc exits0. These do not cover the verified failure defects below.

External artifact128-m2-b02-review-probes.test.ts in supervisor directory snapshots
the isolated worker harness, resolves original production imports absolutely and
adds injected acquisition failure/destroy observation. Baseline25 pass, THREE
new production-handler probes fail. No live DB/network/provider/default adapter.

## F1: acquisition escapes error handling

tenant-self.ts PATCH /profile: getConnection at174 is before try. A rejected pool
acquisition rejects the handler rather than sending the documented safe500 body.
Probe reproduces fixture pool unavailable escaping runChain. Express here is4;
do not rely on the harness promise catch as application handling.

Move acquisition inside the protected lifecycle, track connection availability,
return safe500/no-store for acquisition failure, and avoid cleanup on a nonexistent
connection. Test real handler pool rejection and beginTransaction failure, not only
SQL/update failures. No global error/router/auth change.

## F2: uncertain transaction returned to shared pool

PATCH catch ignores rollback errors and always calls release in finally, also
after commitAttempted failure. Local mysql2/lib/base/pool_connection.js release
only calls pool.releaseConnection; pool.js immediately makes it reusable, without
rolling back/resetting the transaction. A failed rollback can therefore leak an
open transaction/locks/uncommitted name+audit into a later request. Commit failure
likewise has uncertain transaction state. Two probes reproduce release with no
destroy after audit+rollback failure and commit acknowledgement failure.

Track transaction/connection certainty explicitly. Use actual existing mysql2
connection discard/destroy capability for failed cleanup or uncertain commit;
never return such a connection to pool. Clean committed/no-op/confirmed rollback
paths release exactly once; uncertain paths discard exactly once and do not release.
Do not automatically retry rollback/commit or claim rollback of an uncertain commit.
Keep a narrow injected capability seam in tenant-self.ts without shared edits;
preserve existing GET/other callers and isolated default-adapter sentinels.

Required tests: acquire/begin/lock-query failure; successful rollback vs rollback
failure; commit uncertainty; denial/no-op cleanup failure; exactly one release OR
discard, no false success. Existing tests currently assert release even for dirty
connections: replace those expectations with correct disposal assertions, retaining
all successful/known-clean release checks. Do not relax error/SQL/authority tests.
Run external128 with --test-name-pattern=supervisor: (three added probes only;
snapshot baseline contains the predecessor's now-invalid release assertions).
Contract must describe discard/uncertainty and safe acquisition failure, not claim
all paths release. Fix placeholder UTC in B02 contract and report actual timestamps.

## Dispatch / next owner

Fresh same-three-path task client-m2-b02-name-transaction-correction-20261019-01
under existing124 correction delegation, after predecessor reported/stopped.
OpenCode preserves partial implementation, fixes F1/F2, safe isolated regressions
and server types, then stops/reports. Codex independently re-reviews. No new product
approval, no active-source edits by Codex, no schema/services/Git/installs or broader
policy. Both timers continue; no per-batch STOP, no whole-M2 acceptance, OTP deferred.
No acknowledgment-only reply: actual corrective evidence required.
