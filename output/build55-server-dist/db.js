"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.withTransaction = exports.closePool = exports.testConnection = exports.execute = exports.queryOne = exports.query = exports.getPool = void 0;
const promise_1 = __importDefault(require("mysql2/promise"));
const dotenv_1 = __importDefault(require("dotenv"));
const catalog_read_limit_1 = require("./services/catalog-read-limit");
dotenv_1.default.config();
// Debug: log database config (hide password)
console.log('🔧 DB Config:', {
    host: process.env.DB_HOST || 'localhost',
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD ? '***SET***' : 'EMPTY!',
    database: process.env.DB_NAME || 'freelance'
});
const dbConfig = {
    host: process.env.DB_HOST || 'localhost',
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || process.env.MYSQL_ROOT_PASSWORD || '',
    database: process.env.DB_NAME || 'Freelance',
    port: parseInt(process.env.DB_PORT || '3306'),
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0,
    enableKeepAlive: true,
    keepAliveInitialDelay: 0,
    charset: 'utf8mb4',
    timezone: '+02:00' // Egypt timezone (EET)
};
let pool = null;
const getPool = () => {
    if (!pool) {
        pool = (0, catalog_read_limit_1.withMysqlReadLimitBindings)(promise_1.default.createPool(dbConfig));
        console.log('✅ MySQL connection pool created');
    }
    return pool;
};
exports.getPool = getPool;
const query = async (sql, params) => {
    const connection = (0, exports.getPool)();
    const [rows] = await connection.execute(sql, params);
    return rows;
};
exports.query = query;
const queryOne = async (sql, params) => {
    const results = await (0, exports.query)(sql, params);
    return results.length > 0 ? results[0] : null;
};
exports.queryOne = queryOne;
const execute = async (sql, params) => {
    const connection = (0, exports.getPool)();
    const [result] = await connection.execute(sql, params);
    return result;
};
exports.execute = execute;
const testConnection = async () => {
    let connection = null;
    try {
        connection = await (0, exports.getPool)().getConnection();
        await connection.ping();
        console.log('✅ Database connection successful');
        return true;
    }
    catch (error) {
        console.error('❌ Database connection failed:', error);
        return false;
    }
    finally {
        connection?.release();
    }
};
exports.testConnection = testConnection;
const closePool = async () => {
    if (pool) {
        await pool.end();
        pool = null;
        console.log('🔌 Database connection pool closed');
    }
};
exports.closePool = closePool;
const withTransaction = async (fn) => {
    const connection = await (0, exports.getPool)().getConnection();
    // A COMMIT that rejected leaves the outcome AMBIGUOUS: the write may or may
    // not have landed on the server. A rollback that succeeds afterwards does
    // not resolve that ambiguity — the COMMIT may have been received before
    // the acknowledgement was lost — so the connection must be DESTROYED and
    // never released back to the pool. No success is reported and no automatic
    // retry or compensation is attempted; the caller decides what an uncertain
    // write means. (Repository rule: "Destroy connections with unknown
    // transaction state"; audit 2026-10-26 finding B.)
    let commitAttempted = false;
    let reusable = true;
    try {
        // BEGIN can reject too: cleanup must cover admission as well as work.
        await connection.beginTransaction();
        const result = await fn(connection);
        commitAttempted = true;
        await connection.commit();
        return result;
    }
    catch (error) {
        // An ambiguous COMMIT is the one outcome that can never be recycled,
        // even when the rollback that follows it succeeds.
        if (commitAttempted)
            reusable = false;
        try {
            await connection.rollback();
        }
        catch {
            // Never return a connection with unknown transaction state to the
            // pool, and never replace the callback/commit error with cleanup.
            reusable = false;
        }
        if (!reusable) {
            try {
                connection.destroy();
            }
            catch { /* retain the original failure */ }
        }
        // A rejected COMMIT remains ambiguous. No retry or compensation here.
        throw error;
    }
    finally {
        if (reusable) {
            // Cleanup has no authority to replace the unit's result or error:
            // a failed release must not be handed a poisoned connection back.
            try {
                connection.release();
            }
            catch {
                try {
                    connection.destroy();
                }
                catch { /* retain the original failure */ }
            }
        }
    }
};
exports.withTransaction = withTransaction;
exports.default = {
    query: exports.query,
    queryOne: exports.queryOne,
    execute: exports.execute,
    testConnection: exports.testConnection,
    closePool: exports.closePool,
    getPool: exports.getPool,
    withTransaction: exports.withTransaction,
};
