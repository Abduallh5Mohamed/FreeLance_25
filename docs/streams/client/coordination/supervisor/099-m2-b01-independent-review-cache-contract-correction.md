# M2-B01 independently reviewed: narrow cache-header correction required

Manual review2026-10-19, after human reports WorkBuddy finished. Read worker050,
actual scoped diff, production module, new tests and contract. Original task
client-m2-b01-tenant-profile-20261019-01 reported04:35:03Z; worker050 states
stopped before report. Worker workbuddy-m2b01-20261019T0425Z, native mapping not
available. No replacement until stopped evidence; do not infer liveness.

Independent checks: new isolated suite19/19 pass, server tsc exit0/no diagnostics.
Tests import real auth/selector/student middleware/router with injected data and
intercepted forbidden leaves. No listener/network/DB/provider started by Codex.
Full/selected legacy server test counts in050 were NOT independently rerun:
previously inspected suites include env/service/listener side effects and are not
safe evidence to reproduce under this batch. No claim of fresh120-test verification.

Architecture deviation decision: accept narrow optional profile projection in
getOwnedTenant within current scope. Source confirms existing tests match the
legacy SELECT substring; preserving it plus minimal profile projection uses one
authority path and one query, no additional roundtrip or untrusted SQL fragments.
No need to widen scope to the legacy test or force a cosmetic global projection.
Explicit DTO strips extra row fields; server-selected authority remains unchanged.

NOT ACCEPTED YET: original047 contract§3.3/§7.16 requires no-store on this handler's
200,404,500, but route sets it only after successful resolution. Two new independent
production assertions reproduce missing header on404 and500. External artifact:
C:/Users/BaraaWael/TabwebClientSupervisor/099-m2-profile-review.test.ts
(snapshot of isolated harness with absolute module references plus two assertions;
unchanged production handler import). Result19pass/2fail; original19 still pass.

Correction within same three paths: set no-store before the first await/denial in
profile handler; test own404, data500 and authority500 headers and200. Do not edit
global401/400/auth policy or weaken contract. Update contract doc honestly.

Verification corrections: worker reports an unisolated import counter-check that
evaluated DB/env/MinIO bootstrap, contrary to096 isolation boundary. Do NOT repeat
that counter-check or legacy unsafe suites. Positive intercepted module identities,
cache absence, forbidden default calls, restored loader are sufficient evidence;
no need to run unsafe code to prove unsafe code is unsafe. Assert sentinel non-use
after the whole suite as well as import, so later caught calls cannot evade proof.
Keep test-only fixture authority clearly labelled, not live SQL/production lookup
execution. No fixture data/real credentials in logs. Use only installed local tools.

Prepare client-m2-b01-profile-cache-correction-20261019-01 after dispatch confirms
no active owners, same three exact paths. WorkBuddy natively claims, preserves
implementation/tests/accepted work, checkpoints and stops before report. No scope
expansion, Codex product edits, schema/shared/services/Git or self-acceptance.
Continuous075 observation remains; no batch STOP. OTP deferred060, M2 incomplete.
