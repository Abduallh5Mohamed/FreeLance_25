import dotenv from 'dotenv';
import bcrypt from 'bcryptjs';
import { randomUUID } from 'crypto';
import mysql from 'mysql2/promise';
import path from 'node:path';
import { assertSafeM1TestTarget, resolveM1EnvPath } from '../tests/m1-test-target-safety';

const envPath = process.env.M1_TEST_ENV_FILE === undefined
    ? path.resolve(__dirname, '..', '..', '.env.m1')
    : resolveM1EnvPath(__dirname, process.env.M1_TEST_ENV_FILE);
dotenv.config({ path: envPath, override: true });

const password = process.env.M1_SEED_PASSWORD;
if (!password || password.length < 16) throw new Error('M1_SEED_PASSWORD (16+ chars) must be set in .env.m1');

// Complete pure target validation before a pool can be created.
const target = assertSafeM1TestTarget({
    dbName: process.env.DB_NAME,
    dbPort: process.env.DB_PORT,
    dbHost: process.env.DB_HOST,
    apiBaseUrl: process.env.M1_API_BASE_URL,
    jwtSecret: process.env.JWT_SECRET,
});

const pool = mysql.createPool({
    host: target.dbHost,
    port: target.dbPort,
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || process.env.MYSQL_ROOT_PASSWORD,
    database: target.database,
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
            const users = [
                // API teaching authorization derives from canonical instructor
                // identity plus an active tenant instructor membership.
                [teacherId, `${tenant.name} Teacher`, `${tenant.prefix}-teacher@example.test`, 'instructor'],
                [assistantId, `${tenant.name} Assistant`, `${tenant.prefix}-assistant@example.test`, 'staff'],
                [studentId, `${tenant.name} Student`, `${tenant.prefix}-student@example.test`, 'student'],
            ] as const;
            for (const [id, name, email, role] of users) {
                await connection.execute(
                    'INSERT INTO users (id,name,email,password_hash,role,is_active) VALUES (?,?,?,?,?,1) ON DUPLICATE KEY UPDATE name=VALUES(name),password_hash=VALUES(password_hash),role=VALUES(role),is_active=1',
                    [id, name, email, hash, role]
                );
            }
            // Create the tenant only after its instructor owner exists: the
            // SaaS schema enforces owner_user_id as a foreign key to users.
            await connection.execute(
                `INSERT INTO tenants (id,owner_user_id,business_name,status,legacy_compat)
                 VALUES (?,?,?,'active',TRUE) ON DUPLICATE KEY UPDATE owner_user_id=VALUES(owner_user_id),status='active',legacy_compat=TRUE`,
                [tenant.id, teacherId, tenant.name]
            );
            const members = [[ownerId, 'owner'], [teacherId, 'instructor'], [assistantId, 'assistant']] as const;
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

            // Branch-owned live fixture: one active branch per tenant, an
            // active membership for each seeded identity, and one explicit
            // branch-scoped course/group. The deterministic ids let the live
            // branch route tests address the rows without printing secrets.
            const branchId = tenant.prefix === 'm1-a'
                ? 'd0000000-0000-4000-8000-000000000001'
                : 'd0000000-0000-4000-8000-000000000002';
            const courseId = tenant.prefix === 'm1-a'
                ? 'e0000000-0000-4000-8000-000000000001'
                : 'e0000000-0000-4000-8000-000000000002';
            const groupId = tenant.prefix === 'm1-a'
                ? 'f0000000-0000-4000-8000-000000000001'
                : 'f0000000-0000-4000-8000-000000000002';
            ids.set(`${tenant.prefix}-branch`, branchId);
            ids.set(`${tenant.prefix}-course`, courseId);
            ids.set(`${tenant.prefix}-group`, groupId);
            await connection.execute(
                `INSERT INTO branches (id,tenant_id,name,status,version)
                 VALUES (?,?,?,'active',0)
                 ON DUPLICATE KEY UPDATE name=VALUES(name),status='active'`,
                [branchId, tenant.id, `${tenant.name} Main Branch`]
            );
            for (const [userId, role] of [[ownerId, 'owner'], [teacherId, 'instructor'], [studentId, 'student']] as const) {
                await connection.execute(
                    `INSERT INTO branch_memberships (id,branch_id,user_id,role,status,version)
                     VALUES (?,?,?,?,'active',0)
                     ON DUPLICATE KEY UPDATE role=VALUES(role),status='active'`,
                    [randomUUID(), branchId, userId, role]
                );
            }
            await connection.execute(
                `INSERT INTO courses (id,tenant_id,instructor_id,name,subject,description,is_active)
                 VALUES (?,?,?,?,?,?,TRUE)
                 ON DUPLICATE KEY UPDATE tenant_id=VALUES(tenant_id),instructor_id=VALUES(instructor_id),is_active=TRUE`,
                [courseId, tenant.id, teacherId, `${tenant.name} Branch Course`, 'عام', 'M1 branch live fixture']
            );
            await connection.execute(
                `INSERT INTO \`groups\` (id,name,description,course_id,instructor_id,max_students,is_active,branch_id,branch_scope)
                 VALUES (?,?,?,?,?,30,TRUE,?,'branch')
                 ON DUPLICATE KEY UPDATE course_id=VALUES(course_id),instructor_id=VALUES(instructor_id),is_active=TRUE,branch_id=VALUES(branch_id),branch_scope='branch'`,
                [groupId, `${tenant.name} Branch Group`, 'M1 branch live fixture', courseId, teacherId, branchId]
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
