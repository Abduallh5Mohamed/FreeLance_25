"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.closePool = exports.testConnection = exports.execute = exports.queryOne = exports.query = exports.getPool = void 0;
const promise_1 = __importDefault(require("mysql2/promise"));
const dotenv_1 = __importDefault(require("dotenv"));
dotenv_1.default.config();
const dbConfig = {
    host: process.env.DB_HOST || 'localhost',
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    database: process.env.DB_NAME || 'freelance',
    port: parseInt(process.env.DB_PORT || '3306'),
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0,
    enableKeepAlive: true,
    keepAliveInitialDelay: 0,
    charset: 'utf8mb4',
    timezone: '+00:00'
};
let pool = null;
const getPool = () => {
    if (!pool) {
        pool = promise_1.default.createPool(dbConfig);
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
    try {
        const connection = await (0, exports.getPool)().getConnection();
        await connection.ping();
        connection.release();
        console.log('✅ Database connection successful');
        return true;
    }
    catch (error) {
        console.error('❌ Database connection failed:', error);
        return false;
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
exports.default = {
    query: exports.query,
    queryOne: exports.queryOne,
    execute: exports.execute,
    testConnection: exports.testConnection,
    closePool: exports.closePool,
    getPool: exports.getPool,
};
