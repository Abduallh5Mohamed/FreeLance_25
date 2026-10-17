import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';

/**
 * Synthetic fail-closed tests for the two tracked secret literals that were
 * removed. No real credential is read, written, printed or compared: the
 * injected values below are obviously synthetic, and assertions only check
 * presence/equality of the injected value, never log it.
 */

const requireFromHere = createRequire(import.meta.url);
const repoRoot = join(__dirname, '..', '..');
const backendConfig = join(repoRoot, 'backend-ecosystem.config.js');
const minioScript = join(repoRoot, 'server', 'start-minio.ps1');

const SYNTHETIC_JWT = 'synthetic-jwt-value-for-env-test-0001';
const SYNTHETIC_DB = 'synthetic-db-value-for-env-test-0001';
const SYNTHETIC_MINIO_USER = 'synthetic-minio-user-0001';
const SYNTHETIC_MINIO_PASSWORD = 'synthetic-minio-password-0001';

const loadBackendConfigAsCjs = (dir: string): string => {
    // The repository is ESM ("type": "module"), so a .js file with
    // module.exports is not a reliable CJS probe. A temporary .cjs copy loads
    // the exact production text through the CommonJS loader the PM2 config
    // expects.
    const target = join(dir, 'backend-ecosystem.config.cjs');
    copyFileSync(backendConfig, target);
    return target;
};

test('backend-ecosystem.config.js fails closed when required secrets are absent', () => {
    const dir = mkdtempSync(join(tmpdir(), 'm1-backend-config-'));
    const saved = {
        JWT_SECRET: process.env.JWT_SECRET,
        DB_PASSWORD: process.env.DB_PASSWORD,
    };
    try {
        const target = loadBackendConfigAsCjs(dir);
        delete process.env.JWT_SECRET;
        delete process.env.DB_PASSWORD;
        assert.throws(
            () => requireFromHere(target),
            /(DB_PASSWORD|JWT_SECRET) is required/,
        );
    } finally {
        if (saved.JWT_SECRET === undefined) delete process.env.JWT_SECRET;
        else process.env.JWT_SECRET = saved.JWT_SECRET;
        if (saved.DB_PASSWORD === undefined) delete process.env.DB_PASSWORD;
        else process.env.DB_PASSWORD = saved.DB_PASSWORD;
        rmSync(dir, { recursive: true, force: true });
    }
});

test('backend-ecosystem.config.js uses injected environment values and never a source default', () => {
    const dir = mkdtempSync(join(tmpdir(), 'm1-backend-config-'));
    const saved = {
        JWT_SECRET: process.env.JWT_SECRET,
        DB_PASSWORD: process.env.DB_PASSWORD,
    };
    try {
        const target = loadBackendConfigAsCjs(dir);
        process.env.JWT_SECRET = SYNTHETIC_JWT;
        process.env.DB_PASSWORD = SYNTHETIC_DB;
        const loaded = requireFromHere(target) as {
            apps: Array<{ env: Record<string, unknown> }>;
        };
        assert.equal(loaded.apps.length, 1);
        assert.equal(loaded.apps[0].env.JWT_SECRET, SYNTHETIC_JWT);
        assert.equal(loaded.apps[0].env.DB_PASSWORD, SYNTHETIC_DB);
        // The source must not contain a quoted literal on either assignment.
        const source = readFileSync(backendConfig, 'utf8');
        assert.match(source, /JWT_SECRET:\s*requiredEnv\('JWT_SECRET'\)/);
        assert.match(source, /DB_PASSWORD:\s*requiredEnv\('DB_PASSWORD'\)/);
        assert.doesNotMatch(source, /JWT_SECRET:\s*['"][^'"]+['"]/);
        assert.doesNotMatch(source, /DB_PASSWORD:\s*['"][^'"]+['"]/);
    } finally {
        if (saved.JWT_SECRET === undefined) delete process.env.JWT_SECRET;
        else process.env.JWT_SECRET = saved.JWT_SECRET;
        if (saved.DB_PASSWORD === undefined) delete process.env.DB_PASSWORD;
        else process.env.DB_PASSWORD = saved.DB_PASSWORD;
        rmSync(dir, { recursive: true, force: true });
    }
});

const extractMinioGuard = (): string => {
    const lines = readFileSync(minioScript, 'utf8').split(/\r?\n/);
    const start = lines.findIndex((line) => line.includes('$minioRootUser = $env:MINIO_ROOT_USER'));
    const end = lines.findIndex((line, index) => index > start && line.includes('$env:MINIO_ROOT_PASSWORD = $minioRootPassword'));
    assert.ok(start >= 0 && end > start, 'the required-env guard block is present');
    return [...lines.slice(start, end + 1), 'Write-Output "guard-ok"', ''].join('\n');
};

const runPowerShell = (scriptPath: string, env: NodeJS.ProcessEnv) => {
    const candidates = ['powershell', 'pwsh'];
    for (const executable of candidates) {
        const result = spawnSync(
            executable,
            ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', scriptPath],
            { encoding: 'utf8', env, timeout: 30_000 },
        );
        if (result.error && (result.error as NodeJS.ErrnoException).code === 'ENOENT') continue;
        return { executable, ...result };
    }
    return null;
};

test('start-minio.ps1 fails closed when MinIO credentials are absent', (t) => {
    const dir = mkdtempSync(join(tmpdir(), 'm1-minio-guard-'));
    try {
        const target = join(dir, 'guard.ps1');
        writeFileSync(target, extractMinioGuard(), 'utf8');
        const env = { ...process.env, MINIO_ROOT_USER: '', MINIO_ROOT_PASSWORD: '' };
        const result = runPowerShell(target, env);
        if (!result) {
            t.skip('PowerShell is not available in this environment');
            return;
        }
        assert.notEqual(result.status, 0);
        assert.match(String(result.stderr || ''), /MINIO_ROOT_(USER|PASSWORD) is required/);
        assert.doesNotMatch(String(result.stdout || ''), /guard-ok/);
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test('start-minio.ps1 accepts injected MinIO credentials without a source literal', (t) => {
    const dir = mkdtempSync(join(tmpdir(), 'm1-minio-guard-'));
    try {
        const target = join(dir, 'guard.ps1');
        writeFileSync(target, extractMinioGuard(), 'utf8');
        const env = {
            ...process.env,
            MINIO_ROOT_USER: SYNTHETIC_MINIO_USER,
            MINIO_ROOT_PASSWORD: SYNTHETIC_MINIO_PASSWORD,
        };
        const result = runPowerShell(target, env);
        if (!result) {
            t.skip('PowerShell is not available in this environment');
            return;
        }
        assert.equal(result.status, 0, String(result.stderr || ''));
        assert.match(String(result.stdout || ''), /guard-ok/);
        const source = readFileSync(minioScript, 'utf8');
        assert.match(source, /\$minioRootUser = \$env:MINIO_ROOT_USER/);
        assert.match(source, /\$minioRootPassword = \$env:MINIO_ROOT_PASSWORD/);
        assert.doesNotMatch(source, /\$env:MINIO_ROOT_PASSWORD\s*=\s*['"][^'"]+['"]/);
        assert.doesNotMatch(source, /\$env:MINIO_ROOT_USER\s*=\s*['"][^'"]+['"]/);
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});
