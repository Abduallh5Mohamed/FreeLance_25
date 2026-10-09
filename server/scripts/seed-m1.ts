import dotenv from 'dotenv';
import bcrypt from 'bcryptjs';
import { randomUUID } from 'crypto';
import mysql from 'mysql2/promise';
import path from 'node:path';

dotenv.config({ path: path.resolve(process.cwd(), '../.env.m1') });

if (process.env.DB_NAME !== 'tabweb_m1_test' || process.env.DB_PORT !== '13316') {
    throw new Error('Refusing to seed: DB_NAME must be tabweb_m1_test and DB_PORT must target the isolated M1 compose database.');
}
const password = process.env.M1_SEED_PASSWORD;
if (!password || password.length < 16) throw new Error('M1_SEED_PASSWORD (16+ chars) must be set in .env.m1');

const pool = mysql.createPool({
    host: process.env.DB_HOST || '127.0.0.1',
    port: Number(process.env.DB_PORT),
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || process.env.MYSQL_ROOT_PASSWORD,
    database: process.env.DB_NAME,
    connectionLimit: 2,
});

const tenants = [
    { id: 'a0000000-0000-4000-8000-000000000001', name: 'M1 Tenant A', prefix: 'm1-a' },
    { id: 'b0000000-0000-4000-8000-000000000001', name: 'M1 Tenant B', prefix: 'm1-b' },
];
const ids = new Map<string, string>();

async function run() {
    const connection = await pool.getConnection();
    try {
        await connection.beginTransaction();
        const hash = await bcrypt.hash(password, 12);
        for (const tenant of tenants) {
            const ownerId = `${tenant.prefix}-owner`;
            const teacherId = `${tenant.prefix}-teacher`;
            const assistantId = `${tenant.prefix}-assistant`;
            const studentId = `${tenant.prefix}-student`;
            ids.set(`${tenant.prefix}-owner`, ownerId);
            ids.set(`${tenant.prefix}-teacher`, teacherId);
            ids.set(`${tenant.prefix}-assistant`, assistantId);
            ids.set(`${tenant.prefix}-student`, studentId);

            await connection.execute(
                `INSERT INTO users (id,name,email,phone,password_hash,role,is_active)
                 VALUES (?,?,?,?,?,'instructor',1) ON DUPLICATE KEY UPDATE name=VALUES(name),password_hash=VALUES(password_hash),role='instructor',is_active=1`,
                [ownerId, `${tenant.name} Owner`, `${tenant.prefix}-owner@example.test`, `+2010000000${tenant.prefix === 'm1-a' ? '1' : '2'}1`, hash]
            );
            await connection.execute(
                `INSERT INTO tenants (id,owner_user_id,business_name,status,legacy_compat)
                 VALUES (?,?,?,'active',TRUE) ON DUPLICATE KEY UPDATE status='active',legacy_compat=TRUE`,
                [tenant.id, ownerId, tenant.name]
            );
            const users = [
                [teacherId, `${tenant.name} Teacher`, `${tenant.prefix}-teacher@example.test`, 'teacher'],
                [assistantId, `${tenant.name} Assistant`, `${tenant.prefix}-assistant@example.test`, 'staff'],
                [studentId, `${tenant.name} Student`, `${tenant.prefix}-student@example.test`, 'student'],
            ] as const;
            for (const [id, name, email, role] of users) {
                await connection.execute(
                    'INSERT INTO users (id,name,email,password_hash,role,is_active) VALUES (?,?,?,?,?,1) ON DUPLICATE KEY UPDATE name=VALUES(name),password_hash=VALUES(password_hash),role=VALUES(role),is_active=1',
                    [id, name, email, hash, role]
                );
            }
            const members = [[ownerId, 'owner'], [teacherId, 'teacher'], [assistantId, 'assistant']] as const;
            for (const [userId, role] of members) {
                await connection.execute(
                    `INSERT INTO tenant_memberships (id,tenant_id,user_id,role_key,status)
                     VALUES (?,?,?,?, 'active') ON DUPLICATE KEY UPDATE role_key=VALUES(role_key),status='active'`,
                    [randomUUID(), tenant.id, userId, role]
                );
            }
            await connection.execute(
                `INSERT INTO students (id,user_id,tenant_id,instructor_id,name,phone,is_offline,approval_status,is_active)
                 VALUES (?,?,?,?,?,?,FALSE,'approved',TRUE)
                 ON DUPLICATE KEY UPDATE user_id=VALUES(user_id),tenant_id=VALUES(tenant_id),instructor_id=VALUES(instructor_id),is_active=TRUE`,
                [studentId, studentId, tenant.id, ownerId, `${tenant.name} Student`, `+2010000000${tenant.prefix === 'm1-a' ? '3' : '4'}1`]
            );
        }

        const adminId = 'c0000000-0000-4000-8000-000000000001';
        await connection.execute(
            `INSERT INTO users (id,name,email,password_hash,role,is_active)
             VALUES (?, 'M1 Super Admin', 'm1-admin@example.test', ?, 'admin', 1)
             ON DUPLICATE KEY UPDATE password_hash=VALUES(password_hash),role='admin',is_active=1`, [adminId, hash]
        );
        await connection.execute(
            `INSERT INTO admin_user_roles (user_id,role_code) VALUES (?, 'super_admin')
             ON DUPLICATE KEY UPDATE role_code=VALUES(role_code)`, [adminId]
        );
        await connection.commit();
        console.log('M1 seed completed: two isolated tenants, six tenant users, and one super-admin. Password values were not printed.');
    } catch (error) {
        await connection.rollback();
        throw error;
    } finally {
        connection.release();
        await pool.end();
    }
}

void run();
