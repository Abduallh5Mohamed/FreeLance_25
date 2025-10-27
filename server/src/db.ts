import mysql from 'mysql2/promise';
import dotenv from 'dotenv';

dotenv.config();

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

export const closePool = async (): Promise<void> => {
    if (pool) {
        await pool.end();
        pool = null;
        console.log('🔌 Database connection pool closed');
    }
};

export default {
    query,
    queryOne,
    execute,
    testConnection,
    closePool,
    getPool,
};
