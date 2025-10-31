import mysql from 'mysql2/promise';

// MySQL connection configuration
const dbConfig = {
    host: process.env.DB_HOST || 'localhost',
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    database: process.env.DB_NAME || 'educational_platform',
    port: parseInt(process.env.DB_PORT || '3306'),
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0,
    enableKeepAlive: true,
    keepAliveInitialDelay: 0,
};

// Create connection pool
let pool: mysql.Pool | null = null;

export const getPool = (): mysql.Pool => {
    if (!pool) {
        pool = mysql.createPool(dbConfig);
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

export const transaction = async <T>(
    callback: (connection: mysql.PoolConnection) => Promise<T>
): Promise<T> => {
    const connection = await getPool().getConnection();
    await connection.beginTransaction();

    try {
        const result = await callback(connection);
        await connection.commit();
        return result;
    } catch (error) {
        await connection.rollback();
        throw error;
    } finally {
        connection.release();
    }
};

// Test database connection
export const testConnection = async (): Promise<boolean> => {
    try {
        const connection = await getPool().getConnection();
        await connection.ping();
        connection.release();
        console.log('✅ Database connection successful');
        return true;
    } catch (error) {
        console.error('❌ Database connection failed:', error);
        return false;
    }
};

// Close all connections
export const closePool = async (): Promise<void> => {
    if (pool) {
        await pool.end();
        pool = null;
    }
};

export default {
    query,
    queryOne,
    execute,
    transaction,
    testConnection,
    closePool,
    getPool,
};
