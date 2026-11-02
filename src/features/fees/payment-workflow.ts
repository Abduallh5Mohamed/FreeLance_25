/**
 * Fees payment workflow — the pure decision seam behind the payment form.
 *
 * The page (`src/pages/Fees.tsx`) owns only presentation: dialogs, toasts and
 * the single-write latch. Every DECISION the payment journey makes lives here
 * as a pure function or a function over injected seams, so the behaviours the
 * 2026-10-26 audit pinned (finding C) are testable without a DOM, a browser, a
 * network call or a database:
 *
 *   - an invalid amount is refused LOCALLY, before any request is sent;
 *   - the paid amount and the resulting status are computed from the held fee
 *     row, never re-fetched or guessed;
 *   - a confirmed write is never reclassified as a failure by a failed list
 *     refresh: the refresh is a SEPARATE, lesser outcome;
 *   - a duplicate submission never sends a second write;
 *   - the write goes through the canonical `updateFee` transport only, and a
 *     rejection propagates as the transport's own error (no retry, no
 *     invented success, no wallet/balance policy change).
 *
 * This module performs no I/O of its own: the caller injects the transport
 * seam and the refresh seam.
 */

export interface PaymentFeeRow {
    id: string;
    amount: number;
    paidAmount: number;
}

export interface PaymentWriteBody {
    paid_amount: number;
    status: 'paid' | 'partial';
    payment_date: string;
    payment_method: string;
    notes: string;
}

export interface PaymentSeams {
    /** The canonical transport write. Rejections are the caller's to classify. */
    updateFee: (id: string, body: PaymentWriteBody) => Promise<unknown>;
    /** The best-effort list refresh. Its failure never fails the payment. */
    refresh: () => Promise<void>;
    /** Injectable clock so the persisted date is observable in tests. */
    today: () => string;
}

export type PaymentFlowOutcome =
    | { kind: 'duplicate' }
    | { kind: 'no-fee' }
    | { kind: 'invalid-amount' }
    | { kind: 'saved' }
    | { kind: 'saved-refresh-failed' }
    | { kind: 'failed' };

/**
 * The local amount gate. The WHOLE trimmed string must be a plain non-negative
 * decimal number with at most two fraction digits (the shape the server money
 * columns and `isValidMoney` accept), and the parsed value must be finite and
 * strictly positive. Anything else — an empty string, a numeric prefix with a
 * suffix (`12abc`), excess precision (`1.234`), scientific notation (`1e3`),
 * `Infinity`/`NaN`, zero or a negative value — is `null`, so no request is
 * sent. DOM input attributes are not treated as the financial guard.
 */
const MONEY_AMOUNT_PATTERN = /^\d+(?:\.\d{1,2})?$/;

export const parsePaymentAmount = (raw: string): number | null => {
    if (typeof raw !== 'string') return null;
    const text = raw.trim();
    if (!MONEY_AMOUNT_PATTERN.test(text)) return null;
    const value = Number(text);
    if (!Number.isFinite(value) || value <= 0) return null;
    return value;
};

/**
 * The write body for one payment: the new paid amount and the documented
 * status transition. Overpaying marks the fee paid (the existing behaviour);
 * no balance, wallet or refund policy is decided here.
 */
export const computePaymentWrite = (
    fee: PaymentFeeRow,
    paymentAmount: number,
    paymentMethod: string,
    notes: string,
    today: string,
): PaymentWriteBody => {
    const paidAmount = fee.paidAmount + paymentAmount;
    return {
        paid_amount: paidAmount,
        status: paidAmount >= fee.amount ? 'paid' : 'partial',
        payment_date: today,
        payment_method: paymentMethod,
        notes,
    };
};

/**
 * Runs one payment attempt end to end against injected seams. The page owns a
 * synchronous latch as the authoritative duplicate guard; `busy` is the
 * seam-level equivalent for callers that prefer to delegate the check, and a
 * held value refuses the attempt with no write.
 */
export const runPaymentFlow = async (input: {
    fee: PaymentFeeRow | null;
    amount: string;
    paymentMethod: string;
    notes: string;
    busy?: boolean;
    seams: PaymentSeams;
}): Promise<PaymentFlowOutcome> => {
    if (input.busy === true) return { kind: 'duplicate' };
    if (!input.fee) return { kind: 'no-fee' };

    const paymentAmount = parsePaymentAmount(input.amount);
    if (paymentAmount === null) return { kind: 'invalid-amount' };

    try {
        await input.seams.updateFee(
            input.fee.id,
            computePaymentWrite(input.fee, paymentAmount, input.paymentMethod, input.notes, input.seams.today()),
        );
    } catch {
        return { kind: 'failed' };
    }

    // The payment is persisted. A failed refresh is reported separately and
    // never turns a confirmed save into a failure.
    try {
        await input.seams.refresh();
    } catch {
        return { kind: 'saved-refresh-failed' };
    }
    return { kind: 'saved' };
};
