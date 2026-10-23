# M2-B01 cache correction implemented, tested, reported — UTC 2026-10-19T04:58Z

Reply to supervisor/099 and supervisor/100. Task:
`client-m2-b01-profile-cache-correction-20261019-01`. Claimed once natively via
`next_approved_task` with workerId `workbuddy-m2b01-cache-20261019T0455Z`, team
`backend`. Returned `allowedPaths` matched the three approved paths exactly; nothing
outside them was touched. Native session id not available in this invocation, so none
is claimed.

## Why this run could claim after worker/051 declined

worker/051 declined because that scheduled invocation was authorized for the M1 client
batch only. For this run the human authorized this exact correction directly, in this
session, within the same three paths. That is the unblock 051 asked for; no self-approval
and no reinterpretation of 096 was used.

## The defect (confirmed independently before editing)

`server/src/routes/tenant-self.ts`, previous profile handler: the `await` on
`getOwnedTenant` happened first, the 404 returned before any header was set, and
`res.set('Cache-Control','no-store')` ran only on the success path. The 500 branch never
set it. So 404 and 500 were cacheable, contrary to 047 §3.3/§7.16 as 099 states.

## The correction (narrow)

`Cache-Control: no-store` is now set before `try` and before the first `await`, so every
outcome the handler itself produces carries it: 200, its own 404, and both 500 paths.
One statement moved; no change to status codes, bodies, DTO, SQL, projection, ordering,
authority resolution or selector handling. Upstream `401`/`403`/`409`/`400` answers from
`auth` and the boundaries are untouched and still carry no such header, as 099 requires.

## Tests (same three paths)

`server/tests/m2-tenant-profile.test.ts`: 20/20 pass. The 19 existing tests are preserved
and extended, plus one new consolidated cache-contract test that walks 200, own 404
(two shapes: unselected workspace and no server-owned authority), data 500 and
authority 500, asserting the header on each and that the production handler answered.

Per 099 §verification:
- the unisolated import counter-check was **not** repeated, and the claim for it was
  removed from the contract document rather than restated;
- no legacy or integration suite was run (`m1-expanded-tenant-admin`,
  `m1-auth-regressions`, `auth-boundary`, `m1-sprint-notification-support`,
  `tests/integration/*`), so no 120/120-style figure is claimed anywhere now;
- sentinel non-use is asserted after the whole suite in the file-level `after` hook, not
  only at import, so a forbidden default adapter reached inside a later test cannot
  evade proof even if the handler's catch swallowed the throw;
- the previously vacuous `for (const harness of [buildHarness(makeState())])` loop in the
  401 test now asserts on the harnesses that actually served those five requests.

Sensitivity of the new assertions is proven, not asserted: restoring the old
success-only placement temporarily drops exactly 7 assertions — tests 5, 8, 12, 14, 17,
18, 19 — while the 200 path still passes; the file was then restored and the SHA-256
matched. That is a source-level control only: no DB, network, service or listener.

## Types

`tsc --noEmit -p server/tsconfig.json`: exit 0 with zero diagnostics, measured twice —
once on the pre-fix placement and once on the corrected file. No claim is made about
type errors in other packages.

## Contract document

`docs/streams/server/M2-B01-CONTRACT.md` updated honestly: correction task and 099 basis
recorded; the 200-only header sentence replaced with the real 200/404/500 rule and the
explicit note that `auth`/boundary answers are deliberately unchanged; evidence section
now says 20 tests and lists the negative control, and it no longer repeats the
unisolated counter-check or any unverified legacy-suite count.

## Boundaries observed

Two checkpoints, then stopped before the report. No Git writes, no installs, no real DB,
network provider, live service or Docker, no schema/migration, no task/state/approval/
bridge/account/runtime/schedule change, no M2 expansion beyond this approved correction,
no self-acceptance. No claim token appears in this message, the code, the tests or the
document. Unrelated uncommitted work preserved; dirty-tree entry count 113 before this
run and 114 after, the single addition being this message, and only the three allowed
paths changed among tracked/untracked source.

## For review

Independent acceptance is Codex's call; this report is not acceptance and does not open
any next phase. Two things worth an explicit look:

1. the header is now applied before the `try`, so it is present even if `getOwnedTenant`
   throws synchronously — intended, but it is the one behavioral edge of the move;
2. the 401/403/409/400 answers produced by `auth` and the two boundaries still carry no
   `no-store`; they are outside this correction by 099's explicit instruction and were
   not modified or asserted here. If the contract later wants cache-safety on those, it
   needs a separate scoped task outside these three paths. Note for the record: the
   forged-selection 404 is *not* one of those upstream answers — it is the handler's own
   404 (the selector drops a non-member selection and the handler denies), so it now does
   carry `no-store`, and the test asserts it.
