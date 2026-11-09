"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.CreditAdjustmentError = void 0;
exports.postServiceCreditEntry = postServiceCreditEntry;
exports.postServiceCreditAdjustment = postServiceCreditAdjustment;
exports.adjustServiceCredit = adjustServiceCredit;
const db_1 = require("../db");
class CreditAdjustmentError extends Error {
    constructor(status, message) {
        super(message);
        this.status = status;
    }
}
exports.CreditAdjustmentError = CreditAdjustmentError;
// Money crosses the API as a decimal string; MySQL DECIMAL does the arithmetic.
async function postServiceCreditEntry(connection, input) {
    const amount = String(input.amount ?? '').trim();
    const reason = String(input.reason ?? '').trim();
    if (!/^(?:0|[1-9]\d{0,9})(?:\.\d{1,2})?$/.test(amount) || Number(amount) <= 0) {
        throw new CreditAdjustmentError(400, 'المبلغ يجب أن يكون موجبًا وبدقتين عشريتين كحد أقصى');
    }
    if (reason.length < 3 || reason.length > 500) {
        throw new CreditAdjustmentError(400, 'سبب التعديل مطلوب (من 3 إلى 500 حرف)');
    }
    {
        const [owners] = await connection.execute('SELECT id FROM users WHERE id = ? AND role = ? LIMIT 1', [input.instructorId, 'instructor']);
        if (!Array.isArray(owners) || owners.length === 0) {
            throw new CreditAdjustmentError(404, 'المدرس غير موجود');
        }
        await connection.execute('INSERT IGNORE INTO instructor_wallets (instructor_id, balance) VALUES (?, 0.00)', [input.instructorId]);
        const [rows] = await connection.execute('SELECT balance FROM instructor_wallets WHERE instructor_id = ? FOR UPDATE', [input.instructorId]);
        const current = rows[0]?.balance;
        if (current === undefined)
            throw new Error('Service credit row missing');
        if (input.type === 'debit' && Number(current) < Number(amount)) {
            throw new CreditAdjustmentError(409, 'رصيد الخدمات أقل من مبلغ الخصم');
        }
        await connection.execute(`UPDATE instructor_wallets SET balance = balance ${input.type === 'credit' ? '+' : '-'} ? WHERE instructor_id = ?`, [amount, input.instructorId]);
        const [updatedRows] = await connection.execute('SELECT balance FROM instructor_wallets WHERE instructor_id = ?', [input.instructorId]);
        const updated = updatedRows[0].balance;
        const [transactionResult] = await connection.execute(`INSERT INTO instructor_wallet_transactions
             (instructor_id, type, amount, balance_after, description, created_by, reference_type, reference_uuid)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, [input.instructorId, input.type, amount, updated, reason, input.actorId,
            input.referenceType || null, input.referenceUuid || null]);
        return { balance: updated, transactionId: Number(transactionResult.insertId) };
    }
}
async function postServiceCreditAdjustment(connection, input) {
    return (await postServiceCreditEntry(connection, input)).balance;
}
async function adjustServiceCredit(input) {
    const connection = await (0, db_1.getPool)().getConnection();
    try {
        await connection.beginTransaction();
        const updated = await postServiceCreditAdjustment(connection, input);
        await connection.commit();
        return updated;
    }
    catch (error) {
        await connection.rollback();
        throw error;
    }
    finally {
        connection.release();
    }
}
