# M2-01 report reviewed: stale mutation completions still commit

UTC: 2026-10-17T19:16:59Z (22:16 Cairo). Branch codex/human-client verified.
Read M2-HANDOFF, coordination README and actual reported result for
client-m2-01-enrollment-workflows-20261017-01, worker wb-m2-01-01a.
Initial dispatch active=[], ready=[], blocked=[]; reported protocol requires stop.
Native mapping not available; no invented run IDs. Worker MD still030 at initial
inspection, but result JSON is real and was consumed independently of MD.

## Independent source/test/type review

Managed existing Node22.22.2 + local tsx, both new M2 suites: **36/36 pass**.
Frontend tsc: same11 existing outside errors, zero new scoped errors, overall
nonzero. No live services/DB/network/browser, installs or Git writes. Supervisor
did not edit any worker-owned production/test files.

All three pages actually delegate to workflows.ts with injected production APIs.
Contract inventory distinguishes current pending-approval behavior from absent
OTP/checkout/entitlement. Profile-only retry after a rotated-token profile failure
is reasonable; no forced re-selection requested. Preserve existing invitation
fragment format; source is the authority, no guessed email/query fallback.
Message classification must not become authority or fake numeric status support.

However loaders' sequence guards do not protect mutations:

- Join controller submit awaits API and unconditionally patches submitted=true;
  reset similarly patches resetSent/errors/busy. Neither captures token incarnation
  or checks disposal after await. dispose only stops future calls/load generations.
- Tenant activate awaits redeem and unconditionally commits activated/failure.
  syncToken changes token without a mutation generation; dispose does not fence
  pending completion. Page activation effect then removes the CURRENT fragment.

## Production counterexamples, not source speculation

Saved outside repository:
C:/Users/BaraaWael/TabwebClientSupervisor/049-m2-mutation-races.mts.
Imports actual production controllers; injected fixtures/deferred transport only.
Managed Node22.22.2 + tsx --test: **2 tests, 0 pass, 2 fail**:

1. Load inviteA; start deferred submitA; load inviteB; resolve submitA. Actual
   B state submitted=true, expected false. Page shows success for wrong invitation.
2. Start deferred activationA; set fragmentB and syncToken; resolveA success.
   Actual B state activated, expected superseded/no activation. Current link can
   be removed despite the success belonging to A.

Original36 tests prove loader behavior, not these mutation pathways. NOT accepted.

## Bounded correction within the existing approved batch

Prepared client-m2-01-mutation-lifecycle-20261017-02 with the SAME seven047 paths
and same original approval provenance. Predecessor reported/stopped first; one
ready task and no active owners at creation. This is acceptance correction, not a
new M2 batch or scope expansion. Codex did not claim/start a worker.

WorkBuddy: fence submit/reset/activation success,error,busy and disposal by captured
token/form incarnation; includeA->B->A, reversed completion, current failure/retry
and unmount in actual production tests. Guard releases must not let an old finally
reset a newer operation. Handle empty-route token invalidation (page currently
skips load when token empty). Keep input when current request fails.

Audit the already required identity boundary too: Join currentUser is memoized
once, and StudentSpaces controller guards operation order but not external session
changes. A late profile must not persist oldidentity after logout/token change;
use existing session contract within owned paths, carefully distinguishing own
legitimate rotation from an external identity change. Do not mutate api-http.
Join form labels need real input associations and reset phone accessible name;
visual labels alone are insufficient under original accessibility criterion.

Keep server-authoritative status, truthful errors, current API contract and all
accepted M1 work. No OTP/payment policy, status-propagation API rewrite, services,
backend/router/package edits or M3. No artificial duration or self-acceptance.
No new task just for cosmetic cleanup; finish the finite original lifecycle guards.

Schedule continues; next22:30:09 Cairo. No429/new human blocker observed. M2-01
is incomplete; wholeM2 is not inferred from this batch. Clear own pending marker.
