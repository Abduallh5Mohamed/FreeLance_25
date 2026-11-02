# Fees backend money risk — 2026-10-26 (read-only review)

Scope: `server/src/routes/fees.ts` (especially the `PUT /:id` handler at
`server/src/routes/fees.ts:516`). This report is a review artifact only: no
server financial code was changed, no database/provider/network call was made,
and this is **not** acceptance of a production collection journey.

## Current write shape

- `PUT /:id` accepts `paid_amount` (and `amount`, `status`, dates) directly from
  the request body. `isValidMoney` (`server/src/routes/fees.ts:53`) rejects
  non-numbers, non-finite values, negatives and >2 decimal places, so the
  transport must send a JSON number. It does **not** reject `paid_amount >
  amount`, an arbitrary `status` string, or a backward move of paid amount.
- The row is updated with absolute values (`paid_amount = COALESCE(?, ...)`,
  `server/src/routes/fees.ts:593`), not by a delta. The new value is computed in
  the browser from the fee row the page currently holds
  (`src/features/fees/payment-workflow.ts`, `computePaymentWrite`).
- Authority/tenant scoping is server-derived before the UPDATE
  (`server/src/routes/fees.ts:549-571`), which is good; it does not solve the
  accounting gaps below.

## Risks

1. **Absolute amount from the client (lost update).** Two windows/devices that
   both loaded the same row can each send an absolute `paid_amount`; the later
   UPDATE silently overwrites the earlier one. Example: row paid 100, A pays
   50 (sends 150), B pays 40 (sends 140) → final 140, one payment disappears.
   The server never recomputes from a stored balance or a per-payment row.
2. **No idempotency contract.** There is no idempotency key, request id or
   unique payment reference, so a retried/replayed request cannot be
   distinguished from a new payment. This matters especially if any future
   client adds retry-on-timeout. (The current page does not auto-retry, and the
   local latch only blocks duplicate clicks in one tab.)
3. **No ledger/transactional audit.** The write is a single `UPDATE` of the
   aggregate row, followed by a `SELECT` (`server/src/routes/fees.ts:582-636`).
   There is no immutable payment/ledger row, no before/after snapshot, no actor
   id, no amount delta and no audit record in the same transaction. `updated_at`
   is the only trace. Accrual/refund/settlement can therefore not be
   reconstructed or reconciled from this path.
4. **Status is client-supplied.** `status` is written from the body without an
   enum/transition check, so a caller can set `paid` while `paid_amount` does
   not cover `amount`, or move a paid fee backwards.
5. **Read-modify-write race inside the request.** Authorization probes and the
   UPDATE are separate statements with no row lock/version check; concurrent
   callers are serialized only by the last write. The final `SELECT` can also
   return a row another request just changed, weakening the response as proof
   of "the payment I made".

## Recommended contract before production collection

- Write payments as append-only ledger rows with a server-generated idempotency
  key per attempt and a uniqueness constraint; derive `paid_amount`/`status`
  from the ledger in one transaction.
- Reject replay, enforce an explicit status state machine, and bound overpay /
  reversal with an explicit policy.
- Emit an atomic audit record (actor, tenant, fee, delta, before/after,
  timestamp) in the same transaction, and lock/version the fee row.
- Then, and only then, reconsider wiring a real provider; the current UI remains
  a locally corrected interface over the legacy aggregate write.
