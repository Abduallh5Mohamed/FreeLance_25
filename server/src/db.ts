import mysql from 'mysql2/promise';
import dotenv from 'dotenv';

dotenv.config();

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
    timezone: '+02:00'  // Egypt timezone (EET)
};

let pool: mysql.Pool | null = null;

export const getPool = (): mysql.Pool => {
    if (!pool) {
        pool = mysql.createPool(dbConfig);
        console.log('✅ MySQL connection pool created');
    }
    return pool;
};

export const query = async <T = any>(
    sql: string,
    params?: any[]
): Promise<T[]> => {
    const connection = getPool();
    const [rows] = await connection.execute(sql, params);
    return rows as T[];
};

export const queryOne = async <T = any>(
    sql: string,
    params?: any[]
): Promise<T | null> => {
    const results = await query<T>(sql, params);
    return results.length > 0 ? results[0] : null;
};

export const execute = async (
    sql: string,
    params?: any[]
): Promise<mysql.ResultSetHeader> => {
    const connection = getPool();
    const [result] = await connection.execute(sql, params);
    return result as mysql.ResultSetHeader;
};

export const testConnection = async (): Promise<boolean> => {
    let connection: mysql.PoolConnection | null = null;
    try {
        connection = await getPool().getConnection();
        await connection.ping();
        console.log('✅ Database connection successful');
        return true;
    } catch (error) {
        console.error('❌ Database connection failed:', error);
        return false;
    } finally {
        connection?.release();
    }
};

export const closePool = async (): Promise<void> => {
    if (pool) {
        await pool.end();
        pool = null;
        console.log('🔌 Database connection pool closed');
    }
};

export const withTransaction = async <T>(
    fn: (connection: mysql.PoolConnection) => Promise<T>,
): Promise<T> => {
    const connection = await getPool().getConnection();
    let reusable = true;
    try {
        // BEGIN can reject too: cleanup must cover admission as well as work.
        await connection.beginTransaction();
        const result = await fn(connection);
        await connection.commit();
        return result;
    } catch (error) {
        try {
            await connection.rollback();
        } catch {
            // Never return a connection with unknown transaction state to the
            // pool, and never replace the callback/commit error with cleanup.
            reusable = false;
            try { connection.destroy(); } catch { /* retain the original failure */ }
        }
        // A rejected COMMIT remains ambiguous. No retry or compensation here.
        throw error;
    } finally {
        if (reusable) {
            // Cleanup has no authority to replace the unit's result or error:
            // a failed release must not be handed a poisoned connection back.
            try { connection.release(); }
            catch { try { connection.destroy(); } catch { /* retain the original failure */ } }
        }
    }
};

export default {
    query,
    queryOne,
    execute,
    testConnection,
    closePool,
    getPool,
    withTransaction,
};
