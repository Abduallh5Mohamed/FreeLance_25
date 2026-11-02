# Fees correction C implemented, tested and reported

Task: `audit-20261026-fees-workflow-correction-01`
(worker `opencode-native-fees-correction-20261026-01`, correction lane).
Supervisor alone decides acceptance. No Git/GitHub command was used; no DB,
provider, network, package install or migration was used.

## Changed paths (exact, within allowedPaths)

- `src/features/fees/payment-workflow.ts`
- `src/pages/Fees.tsx`
- `src/tests/fees-payment-workflow.test.ts`
- `src/tests/fees-page-workflow.test.ts` (new)
- `docs/agent-context/FEES-BACKEND-RISK-2026-10-26.md` (new, read-only risk report)

## Behavior before → after

1. Amount gate (`parsePaymentAmount`)
   - Before: `parseFloat` accepted a numeric prefix and excess precision
     (`12abc` → 12, `1.234` → 1.234, `1e3` → 1000).
   - After: the whole trimmed string must match `^\d+(?:\.\d{1,2})?$`, then be
     finite and strictly positive. Malformed, >2dp, scientific, non-finite and
     non-positive amounts return `null`, so `runPaymentFlow` returns
     `invalid-amount` with zero transport writes. Valid cents (`12.34`, `0.5`,
     `0.01`) remain accepted.
2. Real page refresh wiring (`src/pages/Fees.tsx`)
   - Before: `loadFeesFromDB` caught and swallowed every error, so the page's
     `refresh: () => loadFeesFromDB()` could never make `runPaymentFlow` return
     `saved-refresh-failed`.
   - After: `loadFeesFromDB` logs and rethrows. The initial `useEffect` attaches
     `.catch(() => undefined)`; the approve/delete callers already wrap it in
     try/catch, so no caller gains an unhandled rejection. The payment refresh
     now reaches the distinct `saved-refresh-failed` toast and does not describe
     a stale list as refreshed.
3. Page-level regression test
   - `src/tests/fees-page-workflow.test.ts` loads the REAL `Fees.tsx` (owned
     hooks/transport/toast only), captures the REAL payment form `onSubmit`,
     and drives the REAL `processPayment` + `runPaymentFlow` + `loadFeesFromDB`.
     It proves: confirmed write + failed list read → "تم حفظ الدفعة" and no
     `setFees` update; confirmed write + successful read → normal success toast
     and refreshed partial row; `12abc`/`1.234`/`1e3` → zero writes and the
     invalid-amount toast.
4. Server risk report
   - `docs/agent-context/FEES-BACKEND-RISK-2026-10-26.md` documents, from a
     read-only inspection of `server/src/routes/fees.ts:516`: absolute
     client-supplied `paid_amount` (lost update), no idempotency key, no
     ledger/audit row or before/after within the UPDATE transaction, and
     client-supplied status. No server money logic was changed.

## Verification (exact commands / results)

| Command | Result |
|---|---|
| `npx tsx --test src/tests/fees-payment-workflow.test.ts src/tests/fees-page-workflow.test.ts` | 15/15 pass, 0 fail |
| `npm run typecheck` | exit 0, no diagnostics |
| `npm run build` | exit 0; only the pre-existing dynamic/static import and >500 kB chunk warnings |
| `npx eslint src/features/fees/payment-workflow.ts src/tests/fees-payment-workflow.test.ts src/tests/fees-page-workflow.test.ts` | exit 0 |
| `npx eslint src/pages/Fees.tsx` | 4 pre-existing `no-explicit-any` errors at the page's existing `any` usages (unchanged by this correction) |

## Limits

- No production payment acceptance or server financial behavior is claimed; the
  fees journey remains "locally corrected UI only".
- The new page test is Node-only (real component/function code, owned hooks and
  a stubbed transport), not a DOM/RTL or real-HTTP/DB run.
- `server/src/routes/fees.ts` was inspected read-only only.
- Build regenerated `dist/` artifacts; no source outside allowedPaths was edited.
