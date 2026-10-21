# Impersonation audit follow-up — R2 atomicity for start/revoke (2026-10-19)

Task: `server-impersonation-audit-followup-20261019-01` (team `security`,
workerId `wb-impersonation-audit-followup-20261019-01`).
Branch: `codex/workbuddy-server`.
Scoped follow-up of the approved impersonation hardening record
(`docs/streams/server/IMPERSONATION-HARDENING-20261019.md`). The approval
signing/transaction fixes from that task are preserved unchanged; nothing was
redone from scratch.

## Scope

Reproduce and fix **R2** of the hardening record: *start and revoke mutations
audit outside their write transaction*. Extend the existing production
single-connection transaction seam to `start` and `revoke` so the mutation and
its sealed audit commit or roll back together, with guarded
state/`affectedRows`, preserved fail-closed revocation behaviour and
idempotency. No rootauth/index integration, no new roles or write allowlist,
no schema/shared-helper/provider changes.

## Files (all inside allowedPaths)

- `server/src/services/impersonation.ts`
- `server/src/routes/impersonation.ts`
- `server/tests/m7-impersonation.test.ts`
- `server/tests/m7-impersonation-hardening.test.ts`
- this document

## 1. The defect, reproduced

Before this change only approval ran on the one-transaction seam:

- `start` inserted the `pending_approval` row on the plain pool store and the
  route then wrote the audit through a SEPARATE `withTransaction`. A failing
  audit sink therefore left a **phantom pending session** (an approval-worthy
  request with no audit record) while the client received `500`; a retry then
  created a second session for the same target.
- `revoke` performed an unlocked read + guarded conditional
  `UPDATE ... WHERE status IN ('pending_approval','active')` on the plain
  store and the route then audited separately. A failing audit left the row
  `revoked` but **unaudited**; the route also hardcoded `oldValue.status =
  'active'` even when a `pending_approval` row was revoked.

The old tests only asserted the `500` status, not the mutated state, so the
divergence was invisible.

## 2. The fix

### General transaction seam (`services/impersonation.ts`)

- `ImpersonationApprovalTransaction` (approval-only surface:
  `lockSession`/`transitionToActive`/`readSession`/`recordAudit`) is replaced
  by `ImpersonationTransaction` = the **whole store plus `recordAudit`**. The
  production adapter binds every method to ONE connection, so any unit of
  work on it commits or rolls back as a whole.
- `ImpersonationTransactionRunner` keeps its name/shape; the work callback
  now receives the full store seam.
- `createImpersonationService` deps: `approvalTransaction` -> **`transaction`**
  (still required; still no non-transactional fallback).

### `start` — one unit of work

`countActiveForTargetUser` -> `insertSession` -> `recordAudit(
'impersonation.session_requested')` all run inside the transaction. The audit
payload is identical to the previous route-level record. On audit failure the
insert rolls back: no phantom row, no unaudited request, `500` to the caller,
retry safe.

### `revoke` — locked, guarded, atomic

`lockSession` (`SELECT ... FOR UPDATE` in the SQL store) -> status guard
(`active`/`pending_approval` only) -> `transitionToRevoked` with
`affectedRows === 1` required (`besides_transition` on 0) -> re-read ->
`recordAudit('impersonation.session_revoked')` **on the same connection**. The
audit `oldValue.status` now reports the row's real prior status instead of a
hardcoded `'active'`. A failed audit rolls the revocation back (the session
stays active; the caller retries) instead of leaving a revoked, unaudited row.

### `approve` — unchanged behaviour

Same one-transaction unit of work (lock -> guarded transition -> sealed
audit), now through the renamed seam and `tx.findSession`. The dedicated
signing key is still resolved and validated BEFORE the transaction; no null
token path exists.

### Route (`routes/impersonation.ts`)

- `ImpersonationRouteDeps.recordAudit` is removed: audits are no longer
  written outside the mutation.
- `approvalTransaction` -> `transaction`; `start`/`revoke` handlers lose
  their separate audit blocks (the service owns the unit of work).
- Production wiring binds the whole SQL store plus
  `recordSealedAuditEvent(txDb, input)` to one `withTransaction`, so start,
  approve and revoke each commit mutation + audit atomically and the
  audit-chain head lock serializes with the mutation on the same connection.

## 3. Tests

`server/tests/m7-impersonation-hardening.test.ts` (fixture upgraded to expose
the whole store plus the sealed audit with row-lock serialization and
snapshot-restore rollback):

| Test | Covers |
| --- | --- |
| `a failed audit rolls the start back instead of leaving a phantom pending session` | R2 start: 500 + zero rows + zero audits |
| `a failed audit rolls the revoke back instead of leaving a revoked, unaudited row` | R2 revoke: 500 + still `active`, no `revoked_by`/`revoked_at`, no audit |
| `simultaneous revokes revoke exactly once with exactly one audit` | concurrent retry/revoke: `[200, 409]`, one audit, one notification |
| `a start retried for a target with a live session is refused inside the transaction` | concurrent start retries: `[409, 409]`, one requested audit |
| `exact tenant boundary: a foreign-tenant target resolves to nothing and an unrelated actor cannot revoke` | exact tenant (404, nothing written) + exact actor (403) + starter allowed (200, one audit) |
| `valid control: start, approve and revoke each commit their mutation and audit atomically` | positive control: three mutations, three audits in order, token minted, notifications |

`server/tests/m7-impersonation.test.ts`:

- Fixture `makeApprovalTransaction` -> `makeTransaction` (whole store +
  audit, snapshot-restore rollback); service/router call sites updated.
- `impersonation start: audit failure aborts with 500` strengthened: the
  rolled-back state is now asserted (zero rows, zero audits).

## 4. Verification evidence

Focused (root cwd):

```
M1_NETWORK_MODE=hermetic node --require ./scripts/m1-network-guard.cjs \
  --import tsx --test server/tests/m7-impersonation.test.ts \
  server/tests/m7-impersonation-hardening.test.ts
# tests 40 / pass 40 / fail 0      (before this change: 34/34)
```

Typecheck:

```
cd server && node node_modules/typescript/bin/tsc --noEmit
# exit 0
```

Full hermetic suites (both cwds) and the diff check are recorded in the task
report; they include the extra six tests above.

## 5. Residual gaps (not faked)

1. **R1 still open — not mounted.** `server/src/index.ts` is unchanged
   (comment only); no live request is enforced and end-to-end impersonation
   is NOT complete. The integration contract stays in the hardening record.
2. **Start dedupe is count-then-insert inside one transaction.** Two
   concurrent transactions can still both count 0 and both insert for the
   same target because there is no unique constraint or gap lock on the
   target (no schema change is in this scope). The audit atomicity fix does
   not depend on it; a future migration with a partial unique index plus a
   `SELECT ... FOR UPDATE`/gap lock on `target_user_id` would close it.
3. **No live MySQL verification.** `FOR UPDATE`, `affectedRows` and rollback
   semantics are exercised through the injected seam, not a real InnoDB
   instance; no SQL was executed and no migration was authored.
4. **Route revoke permission read is still outside the transaction** (one
   `findSession` before the service call). The status guard + `affectedRows`
   inside the transaction keep the mutation safe; a stale read can only turn
   a would-be revoke into a `besides_transition` conflict, never an
   unauthorized revocation of a different row.
5. **Rate limiting remains in-process** (unchanged; R5 of the hardening
   record).
