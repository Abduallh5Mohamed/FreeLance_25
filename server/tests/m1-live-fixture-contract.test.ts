import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

/**
 * Live-fixture contract for the M1 isolated stack.
 *
 * The M1 seed script (server/scripts/seed-m1.ts) and the live integration
 * suite (server/tests/integration/m1-tenant-isolation.test.ts) share a
 * fixture contract by ID and by insertion order. The suite executes against
 * a real MySQL database and API, so a drift between these two files can only
 * surface as a confusing live failure — or, worse, as a foreign-key
 * violation that tempts an operator to disable FK checks to hide it.
 *
 * This test locks the contract statically: it reads both sources and proves
 * they agree on every fixture identifier the suite depends on, and that the
 * seed inserts tenant rows only after the user rows their foreign keys
 * reference. It never reads environment files, connects to a database or
 * touches the network, so it belongs to the hermetic suite.
 */

const serverRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const seedPath = path.join(serverRoot, 'scripts', 'seed-m1.ts');
const integrationPath = path.join(serverRoot, 'tests', 'integration', 'm1-tenant-isolation.test.ts');

async function readSource(filePath: string): Promise<string> {
    return readFile(filePath, 'utf8');
}

/** Source index of the first statement matching `pattern`, or -1. */
function statementIndex(source: string, pattern: RegExp): number {
    const match = source.match(pattern);
    return match?.index ?? -1;
}

test('seed and integration suite agree on every shared fixture identifier', async () => {
    const [seed, integration] = await Promise.all([readSource(seedPath), readSource(integrationPath)]);

    // Tenant identifiers are the isolation anchors of the whole suite.
    for (const tenantId of ['a0000000-0000-4000-8000-000000000001', 'b0000000-0000-4000-8000-000000000001']) {
        assert.ok(seed.includes(`id: '${tenantId}'`), `seed must define tenant ${tenantId}`);
        assert.ok(integration.includes(`'${tenantId}'`), `integration suite must reference tenant ${tenantId}`);
    }

    // The suite authenticates as the canonical teacher of each tenant; the
    // seed must create exactly those user IDs with the instructor role the
    // API authorization derives from.
    for (const prefix of ['m1-a', 'm1-b']) {
        assert.ok(seed.includes(`prefix: '${prefix}'`), `seed must define a tenant with prefix ${prefix}`);
        assert.ok(
            seed.includes('const teacherId = `${tenant.prefix}-teacher`'),
            'seed must derive the teacher id from the tenant prefix'
        );
        assert.ok(
            seed.includes("[teacherId, `${tenant.name} Teacher`, `${tenant.prefix}-teacher@example.test`, 'instructor']"),
            `seed must create the ${prefix} teacher with the canonical instructor role`
        );
        assert.ok(integration.includes(`'${prefix}-teacher'`), `integration suite must authenticate as ${prefix}-teacher`);
    }

    // The suite seeds a cross-tenant payment request under Tenant B's
    // student, which the seed derives from the same prefix convention.
    assert.ok(
        seed.includes('const studentId = `${tenant.prefix}-student`'),
        'seed must derive the student id from the tenant prefix'
    );
    assert.ok(integration.includes("'m1-b-student'"), 'integration suite must reference m1-b-student');

    // Membership the suite asserts in its precondition: the teacher must be
    // an active instructor member of its own tenant, never of the other one.
    assert.ok(
        seed.includes("[teacherId, 'instructor']"),
        'seed must register each teacher as an active instructor member'
    );
});

test('seed creates users before the tenant rows that reference them', async () => {
    const seed = await readSource(seedPath);

    const firstUserInsert = statementIndex(seed, /INSERT INTO users /);
    const teacherUserInsert = statementIndex(seed, /INSERT INTO users \(id,name,email,password_hash,role,is_active\) VALUES/);
    const tenantInsert = statementIndex(seed, /INSERT INTO tenants /);

    assert.ok(firstUserInsert >= 0, 'seed must insert users');
    assert.ok(teacherUserInsert >= 0, 'seed must insert teacher/assistant/student users');
    assert.ok(tenantInsert >= 0, 'seed must insert tenants');

    // Foreign-key ordering: tenants.owner_user_id references users.id, so the
    // tenant row may only be written after every user it can own exists.
    assert.ok(
        tenantInsert > firstUserInsert && tenantInsert > teacherUserInsert,
        'tenants must be inserted after the user inserts they reference'
    );

    // The tenant owner must be the seeded teacher user, which the previous
    // ordering bug had written before the teacher row existed.
    const tenantInsertBlock = seed.slice(tenantInsert, tenantInsert + 400);
    assert.match(tenantInsertBlock, /\[tenant\.id, teacherId, tenant\.name\]/,
        'tenant owner must be the seeded teacher user');
});

test('seed refuses any target other than the isolated M1 stack before connecting', async () => {
    const seed = await readSource(seedPath);
    assert.match(seed, /assertSafeM1TestTarget\(/, 'seed must run the pure M1 target guard before creating a pool');
    assert.match(seed, /connectionLimit: 2/, 'seed must use a small bounded pool on the isolated database');
    // No FK suppression anywhere: ordering bugs must surface, not hide.
    assert.doesNotMatch(seed, /SET FOREIGN_KEY_CHECKS|foreign_key_checks\s*=\s*0/i,
        'seed must never disable foreign key checks');
});
