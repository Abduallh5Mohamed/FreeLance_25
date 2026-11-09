"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.createFinancialReadSnapshot = exports.createFinancialTransactionRunner = exports.createFinancialSourceComposition = void 0;
/**
 * Pure financial source composition. Construction performs no SQL or I/O.
 * This is not a production mount, schema verifier, provider or readiness grant.
 * Every member of a unit uses the exact connection supplied to one transaction.
 * Throwing aborts through the injected runner; normal returns follow its contract.
 * In particular callers must not return a refusal after writes expecting rollback.
 */
const billing_ledger_sql_1 = require("./billing-ledger-sql");
const billing_invoices_sql_1 = require("./billing-invoices-sql");
const billing_collection_sql_1 = require("./billing-collection-sql");
const payment_checkout_sql_1 = require("./payment-checkout-sql");
const billing_payouts_sql_1 = require("./billing-payouts-sql");
const billing_refunds_sql_1 = require("./billing-refunds-sql");
const billing_settlement_sql_1 = require("./billing-settlement-sql");
const billing_settlement_1 = require("./billing-settlement");
const billing_read_models_1 = require("./billing-read-models");
const createFinancialSourceComposition = (deps) => {
    if (!deps || typeof deps.transaction !== 'function' || !deps.audits) {
        throw new Error('Financial composition requires a transaction runner and sealed audit writers');
    }
    const auditNames = ['invoices', 'collection', 'checkout', 'payouts', 'refunds', 'disputes', 'settlement'];
    for (const name of auditNames) {
        if (typeof deps.audits[name] !== 'function') {
            throw new Error('Financial composition is missing its ' + name + ' sealed audit writer');
        }
    }
    // Capture callable identities and receivers once. Later dependency mutation
    // must not silently replace a runner or writer midway through a unit.
    const transaction = deps.transaction.bind(deps);
    const audits = Object.freeze({
        invoices: deps.audits.invoices.bind(deps.audits),
        collection: deps.audits.collection.bind(deps.audits),
        checkout: deps.audits.checkout.bind(deps.audits),
        payouts: deps.audits.payouts.bind(deps.audits),
        refunds: deps.audits.refunds.bind(deps.audits),
        disputes: deps.audits.disputes.bind(deps.audits),
        settlement: deps.audits.settlement.bind(deps.audits),
    });
    const stores = Object.freeze({
        ledger: (0, billing_ledger_sql_1.createBillingLedgerSqlStore)({ transaction }),
        invoices: (0, billing_invoices_sql_1.createBillingInvoiceSqlStore)({ transaction, audit: audits.invoices }),
        collection: (0, billing_collection_sql_1.createBillingCollectionSqlStore)({ transaction, audit: audits.collection }),
        checkout: (0, payment_checkout_sql_1.createPaymentCheckoutSqlStore)({ transaction, audit: audits.checkout }),
        payouts: (0, billing_payouts_sql_1.createBillingPayoutsSqlStore)({ transaction, audit: audits.payouts }),
        refunds: (0, billing_refunds_sql_1.createBillingRefundsSqlStore)({ transaction, audit: audits.refunds }),
        disputes: (0, billing_refunds_sql_1.createBillingDisputesSqlStore)({ transaction, audit: audits.disputes }),
        settlement: (0, billing_settlement_sql_1.createBillingSettlementSqlStore)({ transaction, audit: audits.settlement }),
    });
    const bindUnit = (connection) => {
        if (!connection || typeof connection.query !== 'function' || typeof connection.execute !== 'function') {
            throw new Error('Financial unit requires a connection-bound query/execute seam');
        }
        return Object.freeze({
            ledger: stores.ledger.inTransaction(connection),
            invoices: stores.invoices.inTransaction(connection),
            collection: stores.collection.inTransaction(connection),
            checkout: stores.checkout.inTransaction(connection),
            payouts: stores.payouts.inTransaction(connection),
            refunds: stores.refunds.inTransaction(connection),
            disputes: stores.disputes.inTransaction(connection),
            settlement: stores.settlement.inTransaction(connection),
        });
    };
    return Object.freeze({
        /** Separate store calls own separate units; use runAtomic for cross-store work. */
        stores,
        /** No nested runner: all cross-store work and audits share one connection. */
        runAtomic: (work) => {
            if (typeof work !== 'function')
                throw new Error('Financial unit requires a callback');
            return transaction((connection) => work(bindUnit(connection)));
        },
    });
};
exports.createFinancialSourceComposition = createFinancialSourceComposition;
/**
 * Adapt one caller-owned pool to the financial stores' row/header contracts.
 * The pool must preserve BIGINT/DECIMAL strings (mysql2 supportBigNumbers and
 * bigNumberStrings); construction does not verify that deployment requirement.
 * There is no autocommit, retry, schema probe, listener or readiness assertion.
 */
const createFinancialTransactionRunner = (pool, options) => {
    if (!pool || typeof pool.getConnection !== 'function') {
        throw new Error('Financial runner requires an injected connection pool');
    }
    const acquire = pool.getConnection.bind(pool);
    const readOnlySnapshot = options?.readOnlySnapshot === true;
    return async (work) => {
        if (typeof work !== 'function')
            throw new Error('Financial transaction requires a callback');
        const raw = await acquire();
        const required = ['query', 'execute', 'beginTransaction', 'commit', 'rollback', 'release', 'destroy'];
        if (!raw || required.some(method => typeof raw[method] !== 'function')) {
            try {
                raw?.destroy?.();
            }
            catch { /* do not hide admission failure */ }
            throw new Error('Financial pool returned an incomplete transaction connection');
        }
        let active = false;
        let began = false;
        let outstanding = 0;
        let reusable = true;
        const assertActive = () => {
            if (!active)
                throw new Error('Financial connection is outside its transaction lifetime');
        };
        const connection = Object.freeze({
            query: async (sql, params) => {
                assertActive();
                outstanding += 1;
                try {
                    const [rows] = await raw.query(sql, params === undefined ? undefined : [...params]);
                    if (!Array.isArray(rows))
                        throw new Error('Financial SELECT returned no row array');
                    return rows;
                }
                finally {
                    outstanding -= 1;
                }
            },
            execute: async (sql, params) => {
                assertActive();
                outstanding += 1;
                try {
                    const [header] = await raw.execute(sql, params === undefined ? undefined : [...params]);
                    if (!header || typeof header !== 'object' || Array.isArray(header)) {
                        throw new Error('Financial mutation returned no result header');
                    }
                    const result = header;
                    const count = result.affectedRows;
                    const parsed = typeof count === 'string' && /^\d+$/.test(count) ? Number(count) : count;
                    if (typeof parsed !== 'number' || !Number.isSafeInteger(parsed) || parsed < 0) {
                        throw new Error('Financial mutation returned unreadable affectedRows');
                    }
                    const insertId = typeof result.insertId === 'string' || typeof result.insertId === 'number'
                        ? result.insertId : undefined;
                    return { affectedRows: parsed, insertId };
                }
                finally {
                    outstanding -= 1;
                }
            },
        });
        try {
            if (readOnlySnapshot) {
                // Next-transaction characteristics only: do not alter the pool's
                // session defaults or trust a deployment isolation assumption.
                await raw.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY');
            }
            await raw.beginTransaction();
            began = true;
            active = true;
            const result = await work(connection);
            active = false;
            if (outstanding !== 0)
                throw new Error('Financial callback returned with unawaited datastore operations');
            await raw.commit();
            return result;
        }
        catch (error) {
            active = false;
            try {
                await raw.rollback();
            }
            catch {
                reusable = false;
                try {
                    raw.destroy();
                }
                catch { /* preserve callback/commit failure */ }
            }
            // Failed SET/BEGIN may leave next-transaction characteristics on
            // the session even when ROLLBACK itself succeeds. Do not recycle it.
            if (!began && reusable) {
                reusable = false;
                try {
                    raw.destroy();
                }
                catch { /* preserve admission failure */ }
            }
            // COMMIT failure is still unknown, never transformed into success.
            throw error;
        }
        finally {
            active = false;
            if (reusable) {
                try {
                    raw.release();
                }
                catch {
                    try {
                        raw.destroy();
                    }
                    catch { /* cleanup has no authority to replace result */ }
                }
            }
        }
    };
};
exports.createFinancialTransactionRunner = createFinancialTransactionRunner;
/**
 * Display-only models and their debt reader share ONE repeatable-read unit.
 * Neither available balance nor display debt is authority to release money.
 * There is no provider/SQL call until the caller explicitly invokes withSnapshot.
 */
const createFinancialReadSnapshot = (deps) => {
    if (!deps || typeof deps.settlementAudit !== 'function') {
        throw new Error('Financial snapshot requires a pool and real settlement audit binding');
    }
    const transaction = (0, exports.createFinancialTransactionRunner)(deps.pool, { readOnlySnapshot: true });
    const audit = deps.settlementAudit.bind(deps);
    return Object.freeze({
        withSnapshot: (work) => {
            if (typeof work !== 'function')
                throw new Error('Financial snapshot requires a callback');
            return transaction(async (connection) => {
                // Bound signature: (conn, deps) — billing-settlement-sql.ts
                // `createBoundBillingSettlementSqlTransaction`. Both the read
                // models and the debt reader below use THIS connection, so
                // they share one repeatable-read snapshot.
                const settlement = (0, billing_settlement_sql_1.createBoundBillingSettlementSqlTransaction)(connection, { transaction, audit });
                const reader = settlement.asSnapshotDebtReader();
                const models = (0, billing_read_models_1.createBillingReadModels)({
                    read: callback => callback(connection),
                    debtSource: {
                        listInvoiceOutstanding: (tenantId, query) => (0, billing_settlement_1.listInvoiceOutstanding)(reader, tenantId, query),
                    },
                });
                return work(models);
            });
        },
    });
};
exports.createFinancialReadSnapshot = createFinancialReadSnapshot;
