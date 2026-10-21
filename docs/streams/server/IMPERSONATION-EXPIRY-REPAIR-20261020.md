# Impersonation approval expiry — repair — 2026-10-20

Task: `server-impersonation-expiry-repair-20261020-01` (team `security`, batch
`expiry-and-independent-reviews-20261020`).
Branch: `codex/workbuddy-server`. Worker
`wb-impersonation-expiry-repair-20261020-01`.

## Status

- **Repaired.** `createSqlImpersonationStore.transitionToActive` now binds
  `expires_at` as a `Date`, the same convention `insertSession` already used
  for that column, so the driver applies the pool offset on both sides.
- **Proven before and after.** The new hermetic regression failed on the
  unrepaired code (`expires_at must be bound as a Date … received string`) and
  passes after it.
- **Live rerun is PENDING, not proven.** This task forbids starting any
  database, container, native `mysqld` or listener, and forbids running the
  live suite. The repair is verified hermetically against the real SQL store
  and the real verifier only; the end-to-end re-validation on a real engine is
  an explicit follow-up.
- No other production file, no `src/db.ts`, no global timezone, no migration,
  no frontend file and no Git state was touched.

## 1. The defect

`server/src/services/impersonation.ts`, `createSqlImpersonationStore`, before
this change:

```ts
transitionToActive: async (sessionId, approverId, expiresAt, now) => {
    const result = await db.execute(
        `UPDATE impersonation_sessions
         SET approved_by = ?, status = 'active', expires_at = ?, updated_at = ?
         WHERE id = ? AND status = 'pending_approval' AND started_by <> ?`,
        [approverId, expiresAt.toISOString().slice(0, 19).replace('T', ' '),
         rowStamp(now), sessionId, approverId],
    );
```

`expires_at` is a `TIMESTAMP` column
(`server/migrations/20261018_19_platform_mfa_impersonation.sql`). Three parties
meet on it:

| Party | Convention |
| --- | --- |
| `insertSession` | binds a `Date`; the driver formats it with the pool's `timezone` |
| `src/db.ts` pool | `timezone: '+02:00'` — formats bound `Date`s and decodes columns with that offset |
| `transitionToActive` | pre-formatted the value as a **UTC wall clock string** and bound the string |

A bound `Date` and a bound string therefore take opposite paths through the same
column. Measured on the isolated engine in
`IMPERSONATION-LIVE-VALIDATION-20261020.md` §8:

```
announced by the route (UTC ISO)      2026-10-19T23:30:12.000Z
literal column value                  2026-10-19 23:30:12
instant the +02:00 read path yields   2026-10-19T21:30:12.000Z   (drift −7200s)
verifier verdict                      { ok: false, reason: 'expired' }
surface response                      HTTP 403, reason 'expired'
```

Every approved support session was dead on arrival: approval returned `200`
with a signed context and the first impersonated request was refused as
`expired` before any allowlist, scope or tenant rule could run.

## 2. The repair

```ts
transitionToActive: async (sessionId, approverId, expiresAt, now) => {
    // `expires_at` is bound as a Date, exactly like `insertSession` does
    // for the same column: the driver formats it with the pool's
    // `timezone` and decodes the column with the same offset, so the
    // instant survives the write/read pair. Pre-formatting it here (a UTC
    // wall-clock string, as this once did) used the opposite convention
    // and stored an expiry two hours in the past, which made every
    // activated session unusable.
    const result = await db.execute(
        `UPDATE impersonation_sessions
         SET approved_by = ?, status = 'active', expires_at = ?, updated_at = ?
         WHERE id = ? AND status = 'pending_approval' AND started_by <> ?`,
        [approverId, expiresAt, rowStamp(now), sessionId, approverId],
    );
    return result.affectedRows ?? 0;
},
```

One parameter binding plus its rationale comment. Deliberately unchanged:

- the SQL text, the `status = 'pending_approval'` predicate and the
  `started_by <> ?` self-approval guard (audit atomicity and target-row
  serialization are untouched: the transition still runs inside the caller's
  single transaction with its sealed audit);
- `expiresAt` computation and the 30-minute clamp in `approve` — the signed
  expiry bound and the live-row bound are unchanged;
- `src/db.ts` and its `timezone: '+02:00'`;
- every other timestamp write (`updated_at`, `revoked_at`).

## 3. Before / after

New file `server/tests/m7-impersonation-expiry.test.ts`, run against the
**unrepaired** code:

```
not ok 1 - transitionToActive binds expires_at as a Date the driver round-trips unchanged
  error: 'expires_at must be bound as a Date (the driver converts it with the pool offset); received string'
ok 2 - insertSession binds the same column with the same Date convention
not ok 3 - an approval whose expiry is in the future is usable on the very next request
not ok 4 - the exact expiry instant is denied and one millisecond earlier is allowed
ok 5 - the previous string convention is refused as expired the moment it is approved
ok 6 - the guarded transition keeps its predicates and still reports a lost race
ok 7 - the pool offset this test models is still the one src/db.ts pins
# tests 7
# pass 4
# fail 3
```

Same file after the repair:

```
ok 1 - transitionToActive binds expires_at as a Date the driver round-trips unchanged
ok 2 - insertSession binds the same column with the same Date convention
ok 3 - an approval whose expiry is in the future is usable on the very next request
ok 4 - the exact expiry instant is denied and one millisecond earlier is allowed
ok 5 - the previous string convention is refused as expired the moment it is approved
ok 6 - the guarded transition keeps its predicates and still reports a lost race
ok 7 - the pool offset this test models is still the one src/db.ts pins
# tests 7
# pass 7
# fail 0
```

## 4. What the regression actually exercises

The task required the real SQL adapter, not a service mock. The test imports
`createSqlImpersonationStore` and `createImpersonationVerifier` from
`src/services/impersonation.ts` and passes a capturing `ImpersonationDb` that
records every `(sql, params)` pair, so the assertions run on the parameters the
production store really binds.

For the round-trip it uses **the driver's own codec**, resolved from the
installed package (`createRequire(...).resolve('mysql2')` → `lib/packets/packet.js`)
and not a hardcoded path:

- `Packet.writeDate(date, '+02:00')` is what `pool.execute` uses to encode a
  `Date` parameter (`lib/packets/execute.js` → `toParameter` →
  `writeDate(value, timezone)`);
- `Packet.readDateTime('+02:00')` is what the binary parser uses to decode a
  `DATETIME`/`TIMESTAMP` column (`lib/parsers/binary_parser.js`).

No hand-rolled offset arithmetic stands in for the driver, and no connection or
network is involved.

Assertions, by test:

1. **Binding type and instant.** The captured `expires_at` parameter is a
   `Date` whose `getTime()` equals the intended instant. The driver round-trip
   of that parameter returns the same instant. The previous convention is
   shown to lose exactly `7_200_000` ms.
2. **Symmetry.** `insertSession` binds the same column as a `Date`, and both
   writers survive the same round-trip — the invariant that was violated.
3. **Usable immediately.** An approval with a future expiry, read back through
   the driver codec, is accepted by the real verifier on the next request, with
   the actor/target/session facts intact.
4. **Exact boundary.** `expires_at − 1 ms` is accepted; `expires_at` exactly
   and `expires_at + 1 ms` are refused with `expired`.
5. **The old convention reproduced.** A row holding the legacy UTC-string value
   is refused as `expired` at approval time, so the defect stays documented as
   behaviour rather than as a comment.
6. **Guarded transition intact.** With `affectedRows = 0` the store reports `0`;
   the SQL still carries `status = 'pending_approval'` and `started_by <> ?`,
   and the approver/session ids are bound in the same positions.
7. **Offset coupling.** The test reads `src/db.ts` and fails if the pool stops
   pinning `+02:00`, so the modelled offset cannot silently drift.

## 5. Live integration test changes (not run here)

`server/tests/integration/m7-impersonation-live.test.ts`:

- the defect-characterization test (`DEFECT: approval stores an expires_at two
  hours behind the instant it announces`) was replaced by
  `the approved expiry is the announced instant and serves the context
  immediately`, which asserts the correct behaviour: persisted instant equals
  the announced instant (≤ 1 s for whole-second storage), the column literal is
  that instant in the pool offset, the production verifier returns `ok`, and
  `GET /api/students` answers `200` with `impersonated: true` and the target id;
- the `ensureUsableExpiry` workaround and all five of its call sites were
  removed, so the enforcement tests now run against the **unmodified** approved
  expiry;
- the file header records the new guarantee.

**This file was not executed.** No database, container, `mysqld` or listener was
started in this task, so the live suite has not been re-run against the repaired
code. It is expected to pass, and that expectation is explicitly **unverified**.

## 6. Verification actually run

```
# focused expiry regression + the three existing impersonation suites
cd server && M1_NETWORK_MODE=hermetic node --require ../scripts/m1-network-guard.cjs \
  --import tsx --test tests/m7-impersonation-expiry.test.ts tests/m7-impersonation.test.ts \
    tests/m7-impersonation-hardening.test.ts tests/m7-impersonation-integration.test.ts
# tests 82 / pass 82 / fail 0        (75 prior baseline + 7 new)

# server typecheck
cd server && node node_modules/typescript/bin/tsc --noEmit
# exit 0

# strict standalone typecheck of the two changed test files
cd server && node node_modules/typescript/bin/tsc --noEmit --strict --skipLibCheck \
  --module esnext --moduleResolution bundler --target es2022 --types node \
  tests/m7-impersonation-expiry.test.ts tests/integration/m7-impersonation-live.test.ts
# exit 0
```

The full hermetic suite was **not** run: other writers are active on this
worktree and the task restricts the run to the impersonation scope.

## 7. Files and hashes

```
3413c8b8b32b25248d0f1b2034023374222c566206a2716f0c93b0495e6f47f9  server/src/services/impersonation.ts
c5b2d0c53f9547435bb54e689aa8cf2b4e6bf43a55518d43cc5458576eda421e  server/tests/m7-impersonation-expiry.test.ts   (new)
f38bf68986e50b7fd4224b96ebf15300851b52d0ba621cf6c5a6fa7488d6ce0c  server/tests/integration/m7-impersonation-live.test.ts
7bb71f3a10b09f2481bb308ba0c6251fa96b7321315221b6ca227f4ec998e342  server/src/db.ts   (unchanged, hash recorded for reference)
```

`server/src/services/impersonation.ts` already carried uncommitted work from
earlier tasks before this one; the diff against `HEAD` therefore shows that
history too. **The only change made by this task** is the `expires_at` parameter
binding in `transitionToActive` and its explanatory comment.

## 8. Limitations and remaining risk

- **Live behaviour is not re-proven.** The hermetic evidence covers the write
  convention, the driver round-trip and the verifier; it does not cover a real
  `TIMESTAMP` column round-trip through a real server, real HTTP or the sealed
  audit. A live rerun is required before this can be called closed.
- The regression depends on mysql2's internal `lib/packets/packet.js`. It is
  resolved dynamically (not a hardcoded path) and is the only way to exercise
  the driver's real encoder/decoder without a connection; a mysql2 upgrade that
  moves that module will fail the test loudly rather than silently weaken it.
- **Same-class inconsistency left in place, out of scope:** `rowStamp(now)`
  still writes `updated_at` and `revoked_at` as UTC wall-clock strings, so those
  two `TIMESTAMP` columns are read back two hours early by the same `+02:00`
  pool. They carry no authorization decision, but the display of
  `revoked_at`/`updated_at` is wrong in the same way the expiry was. The task
  explicitly limited this change to expiry writes, so it was not touched — see
  the open question below.
- The 30-minute clamp, the pending-only transition guard, the
  `started_by <> approver` self-approval guard and the single-transaction audit
  are unchanged; their existing coverage (82/82 above) still passes, but this
  task added no new concurrency test for them.

## 9. Open questions

1. Should `rowStamp` be replaced by `Date` bindings for `updated_at` and
   `revoked_at` in a follow-up? Same defect class, currently out of scope.
2. When may the live suite be re-run against a fresh isolated engine to close
   the loop on the repaired approval path?

## 10. Reproduce

```bash
cd server
M1_NETWORK_MODE=hermetic node --require ../scripts/m1-network-guard.cjs \
  --import tsx --test tests/m7-impersonation-expiry.test.ts
node node_modules/typescript/bin/tsc --noEmit
```

To observe the pre-repair failure, restore
`[approverId, expiresAt.toISOString().slice(0, 19).replace('T', ' '), …]` in
`transitionToActive` and re-run the first command: tests 1, 3 and 4 fail.
