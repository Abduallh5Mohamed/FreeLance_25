# Immediate user-requested review; begin-failure connection leak remains

UTC: 2026-10-16T22:40Z (2026-10-17 01:40 Cairo).
Human explicitly requested immediate review rather than waiting01:45. Performed
that review now. Branch codex/human-client; actual task result and worker/026
confirm client-m1-offline-transaction-evidence-20261017-02 reported/stopped.
Dispatch initially active=[], ready=[], blocked=[]. No native run IDs fabricated.

Independent existing managed Node22.22.2 + tsx scoped backend test: **27/27 pass**.
Server tsc: **exit0**. Transaction source binds both POST/PUT to the extracted
runner. Prior failure/locking/rollback improvements preserved, not rewritten.

However036's resource-boundary finding remains in submitted production code:
beginTransaction executes BEFORE try/finally. A rejected begin skips release.
External probe, importing the ACTUAL production runner, saved outside repository:
C:/Users/BaraaWael/TabwebClientSupervisor/037-transaction-begin-probe.mts.
Actual output: released=0, bodyCalls=0, rollbacks=0, originalErrorPreserved=true;
expected release=1. Injected failure only, no DB/env/network startup. Initial
probe import needed CJS/default interop correction; after correction the actual
behavior was reproduced, not inferred from a module-load failure.

NOT accepted yet. Prepared bounded continuation
client-m1-offline-begin-release-20261017-02, ONLY:
- server/src/lib/offline-student-courses.ts
- server/tests/m1-offline-course-contract.test.ts

Prior worker reported/stopped before task creation. Sanitized dispatch: one ready,
no active/blocked tasks. Codex did not start/claim a replacement worker or edit any
worker source. No fake receipt, accepted state or reissued secret.

WorkBuddy: minimum fix moves begin inside the release boundary, tracks successful
begin for rollback eligibility, guarantees release once even when begin/rollback
reject, preserves original body/commit error when rollback also fails. Add real
runner tests of begin/body/commit/rollback rejection and success, exact ordering,
release count and error identity. Preserve existing27 tests/transaction semantics;
no route rewrite, unrelated cleanup, auth/billing/admission change or new phase.
Run scoped tests/server types, report actual receipt promptly and stop.

Quarter-hour schedule is already Ready, next01:45:09; no STOP/pending marker was
present for this manually requested review. Keep schedule enabled under user's
explicit instruction. This immediate review does not create a second schedule or
new cadence. No source edits, live services, installs, Git writes or M2 by Codex.
The finite remaining set is this resource-release correction and final stable
disposition; session/calendar acceptances from035 stand.
