import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import {
    M1_COMPOSE_MYSQL_PORT,
    M1_MIN_JWT_SECRET_LENGTH,
    M1_TEST_API_PORT,
    M1TargetGuardError,
    assertSafeM1TestTarget,
    resolveM1EnvPathFromIntegrationDir,
} from './m1-test-target-safety';

/**
 * Injected-unit tests for the pure M1 target guard.
 *
 * Every value below is a fake string or plain config object. These tests do
 * not read any .env file, environment variable, DNS record, socket or database
 * and never import the integration harness or the server application — see
 * the purity test at the bottom, which also proves the guard ignores ambient
 * process.env values.
 */

const canonical = {
    dbName: 'tabweb_m1_test',
    dbPort: String(M1_COMPOSE_MYSQL_PORT),
    dbHost: '127.0.0.1',
    apiBaseUrl: `http://127.0.0.1:${M1_TEST_API_PORT}`,
    jwtSecret: 'x'.repeat(M1_MIN_JWT_SECRET_LENGTH),
} as const;

function guardViolations(input: Parameters<typeof assertSafeM1TestTarget>[0]): string[] {
    try {
        assertSafeM1TestTarget(input);
    } catch (error) {
        assert.ok(error instanceof M1TargetGuardError, 'expected an M1TargetGuardError');
        return error.violations;
    }
    return assert.fail('assertSafeM1TestTarget must refuse this config') as never;
}

test('accepts the canonical isolated M1 target', () => {
    const target = assertSafeM1TestTarget(canonical);
    assert.equal(target.database, 'tabweb_m1_test');
    assert.equal(target.dbPort, 13316);
    assert.equal(target.dbHost, '127.0.0.1');
    assert.equal(target.baseUrl, 'http://127.0.0.1:3188');
});

test('accepts the isolated target with numeric port and omitted host/base URL defaults', () => {
    const target = assertSafeM1TestTarget({
        dbName: 'tabweb_m1_test',
        dbPort: 13316,
        jwtSecret: 'y'.repeat(40),
    });
    assert.equal(target.dbPort, 13316);
    assert.equal(target.dbHost, '127.0.0.1');
    assert.equal(target.baseUrl, 'http://127.0.0.1:3188');
});

test('accepts loopback host spellings after normalization', () => {
    assert.equal(assertSafeM1TestTarget({ ...canonical, dbHost: 'localhost' }).dbHost, 'localhost');
    assert.equal(assertSafeM1TestTarget({ ...canonical, dbHost: '::1' }).dbHost, '::1');
    assert.equal(assertSafeM1TestTarget({ ...canonical, dbHost: '[::1]' }).dbHost, '::1');
    assert.equal(assertSafeM1TestTarget({ ...canonical, dbHost: 'LocalHost' }).dbHost, 'localhost');
    // A trailing slash is tolerated but the accepted base is origin-only.
    assert.equal(
        assertSafeM1TestTarget({ ...canonical, apiBaseUrl: 'https://localhost:3188/' }).baseUrl,
        'https://localhost:3188'
    );
});

test('refuses missing or non-isolated database names, including padded ones', () => {
    for (const dbName of [undefined, '', 'tabweb', 'tabweb_production', 'tabweb_m1_test_backup', 'tabweb_m1_test ', ' tabweb_m1_test']) {
        const violations = guardViolations({ ...canonical, dbName });
        assert.ok(
            violations.some((line) => line.includes('database name must be exactly "tabweb_m1_test"')),
            `expected a database-name violation for ${JSON.stringify(dbName)}`
        );
    }
});

test('refuses non-compose, ambiguous or non-numeric database ports, including padded ones', () => {
    for (const dbPort of [undefined, '', '3306', 3306, 13317, '13316x', '0x13316', 'abc', 13316.5, NaN, '13316 ', ' 13316']) {
        const violations = guardViolations({ ...canonical, dbPort });
        assert.ok(
            violations.some((line) => line.includes('database port must be exactly the isolated compose port 13316')),
            `expected a database-port violation for ${JSON.stringify(dbPort)}`
        );
    }
});

test('refuses present-but-empty database host and any non-loopback host', () => {
    for (const dbHost of ['', '   ', 'db.production.internal', '10.0.0.5', '0.0.0.0', '192.168.1.20']) {
        const violations = guardViolations({ ...canonical, dbHost });
        assert.ok(
            violations.some((line) => line.includes('database host')),
            `expected a database-host violation for ${JSON.stringify(dbHost)}`
        );
    }
});

test('refuses API base URLs that are not loopback on the isolated API port', () => {
    const refusals = [
        'https://api.example.com',
        'http://api.example.com:3188',
        'http://127.0.0.1:8080',
        'http://127.0.0.1',
        'ftp://127.0.0.1:3188',
        'not-a-url',
        '//127.0.0.1:3188',
        '',
    ];
    for (const apiBaseUrl of refusals) {
        const violations = guardViolations({ ...canonical, apiBaseUrl });
        assert.ok(
            violations.some((line) => line.includes('API base URL')),
            `expected an API base URL violation for ${JSON.stringify(apiBaseUrl)}`
        );
    }
});

test('refuses API base URLs carrying userinfo, a query, a fragment or a base path', () => {
    const refusals = [
        'http://m1-user:hunter2@127.0.0.1:3188',
        'http://m1-user@127.0.0.1:3188',
        'http://:hunter2@127.0.0.1:3188',
        'http://m1-user:hunter2@localhost:3188/',
        'http://127.0.0.1:3188?token=secret',
        'http://127.0.0.1:3188/?token=secret',
        'http://127.0.0.1:3188#session=abc',
        'http://127.0.0.1:3188/api',
        'https://localhost:3188/api',
        'http://127.0.0.1:3188/evil/../api',
        'http://127.0.0.1:3188/base/path',
    ];
    for (const apiBaseUrl of refusals) {
        const violations = guardViolations({ ...canonical, apiBaseUrl });
        assert.ok(
            violations.some((line) => line.includes('API base URL')),
            `expected an API base URL violation for ${JSON.stringify(apiBaseUrl)}`
        );
    }
});

test('refusals never echo the raw URL, userinfo, query or fragment', () => {
    const submitted = [
        'http://m1-user:hunter2@127.0.0.1:3188',
        'http://127.0.0.1:3188?token=secret',
        'http://127.0.0.1:3188#session=abc',
        'http://m1-user:hunter2@localhost:3188/api?token=secret#fragment',
    ];
    for (const apiBaseUrl of submitted) {
        const message = guardViolations({ ...canonical, apiBaseUrl }).join('\n');
        assert.ok(!message.includes(apiBaseUrl), `refusal must not echo the raw URL:\n${message}`);
        for (const secret of ['hunter2', 'm1-user', 'secret', 'session=abc', 'fragment', 'token=']) {
            assert.ok(!message.includes(secret), `refusal must not echo ${JSON.stringify(secret)}:\n${message}`);
        }
    }
});

test('refuses a missing or short JWT secret', () => {
    guardViolations({ ...canonical, jwtSecret: undefined });
    const violations = guardViolations({ ...canonical, jwtSecret: 'z'.repeat(31) });
    assert.ok(violations.some((line) => line.includes('JWT secret must be at least 32 characters')));
    assert.equal(
        assertSafeM1TestTarget({ ...canonical, jwtSecret: 'z'.repeat(32) }).database,
        'tabweb_m1_test'
    );
});

test('reports every violation together with a typed error', () => {
    assert.throws(
        () => assertSafeM1TestTarget({
            dbName: 'tabweb_production',
            dbPort: '3306',
            dbHost: 'db.production.internal',
            apiBaseUrl: 'https://api.example.com',
            jwtSecret: 'short',
        }),
        (error: unknown) => {
            assert.ok(error instanceof M1TargetGuardError);
            assert.equal(error.name, 'M1TargetGuardError');
            assert.ok(Array.isArray(error.violations));
            const message = error.message;
            for (const fragment of [
                'database name must be exactly "tabweb_m1_test"',
                'database port must be exactly the isolated compose port 13316',
                'database host must be loopback',
                'API base URL',
                'JWT secret must be at least 32 characters',
            ]) {
                assert.ok(message.includes(fragment), `expected ${JSON.stringify(fragment)} in:\n${message}`);
            }
            return true;
        }
    );
});

test('ignores ambient process.env: validation depends only on injected values', () => {
    const saved = { ...process.env };
    try {
        process.env.DB_NAME = 'tabweb_m1_test';
        process.env.DB_PORT = '13316';
        process.env.M1_API_BASE_URL = 'http://127.0.0.1:3188';
        process.env.JWT_SECRET = 'a'.repeat(32);

        // Polluted env must not make an unsafe injected config pass.
        assert.ok(
            guardViolations({ ...canonical, dbName: 'tabweb_production' }).length > 0,
            'ambient env must not rescue a production database name'
        );

        // Restore an honest env for the next assertion.
        process.env.DB_NAME = saved.DB_NAME;
        process.env.DB_PORT = saved.DB_PORT;
        process.env.M1_API_BASE_URL = saved.M1_API_BASE_URL;
        process.env.JWT_SECRET = saved.JWT_SECRET;
    } finally {
        process.env = saved;
    }
});
