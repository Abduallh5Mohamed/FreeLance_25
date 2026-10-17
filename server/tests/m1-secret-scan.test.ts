import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * S9 evidence: the tracked-source secret scanner is exercised end-to-end with
 * synthetic temporary repositories. Every fixture value below is fake and
 * exists only to prove detection, redaction, allowlist and exit-code
 * behaviour; the scanner itself is bounded to tracked text files.
 */

const SCANNER = join(__dirname, '..', '..', 'scripts', 'scan-m1-tracked-secrets.cjs');
const FAKE_AWS_KEY = ['AKIA', 'QYLPMN5HH7QTESTX'].join(''); // synthetic 20-char shape, split so this file stays clean
const FAKE_DB_PASSWORD = 'synthetic-fixture-password-1234';

const makeRepo = () => {
    const dir = mkdtempSync(join(tmpdir(), 'm1-secret-scan-'));
    execFileSync('git', ['init', '-q'], { cwd: dir });
    execFileSync('git', ['config', 'user.email', 'scan@example.test'], { cwd: dir });
    execFileSync('git', ['config', 'user.name', 'scan fixture'], { cwd: dir });
    return dir;
};

const writeAndTrack = (dir: string, relativePath: string, content: string) => {
    const absolute = join(dir, relativePath);
    mkdirSync(join(absolute, '..'), { recursive: true });
    writeFileSync(absolute, content);
    execFileSync('git', ['add', '-f', relativePath], { cwd: dir });
};

const runScanner = (dir: string, args: string[] = []) => {
    const result = spawnSync(process.execPath, [SCANNER, ...args], { cwd: dir, encoding: 'utf8' });
    return { status: result.status, stdout: result.stdout, stderr: result.stderr };
};

test('S9 scan: a tracked credential is detected and the matched value is never printed', () => {
    const dir = makeRepo();
    try {
        writeAndTrack(dir, 'server/src/config.ts', `export const AWS_KEY = '${FAKE_AWS_KEY}';\n`);
        const result = runScanner(dir);
        assert.equal(result.status, 1);
        assert.match(result.stdout, /server\/src\/config\.ts:1 aws-access-key-id/);
        assert.doesNotMatch(result.stdout, new RegExp(FAKE_AWS_KEY));
        assert.doesNotMatch(result.stdout + result.stderr, /AKIA/);
    } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('S9 scan: a clean tracked tree exits 0', () => {
    const dir = makeRepo();
    try {
        writeAndTrack(dir, 'server/src/clean.ts', 'export const answer = 42;\n');
        const result = runScanner(dir);
        assert.equal(result.status, 0);
        assert.match(result.stdout, /findings=0/);
    } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('S9 scan: synthetic test fixtures under server/tests are explicitly allowlisted', () => {
    const dir = makeRepo();
    try {
        writeAndTrack(dir, 'server/tests/fixture.test.ts', `const JWT_SECRET = 'synthetic-test-secret-value-1234';\nconst DB_PASSWORD = '${FAKE_DB_PASSWORD}';\n`);
        const result = runScanner(dir);
        assert.equal(result.status, 0);
        assert.match(result.stdout, /allowlisted=2/);
    } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('S9 scan: env files, archives and build output are outside the bounded scope', () => {
    const dir = makeRepo();
    try {
        writeAndTrack(dir, '.env', `DB_PASSWORD='${FAKE_DB_PASSWORD}'\n`);
        writeAndTrack(dir, 'node_modules/pkg/index.js', `const key='${FAKE_AWS_KEY}';\n`);
        writeAndTrack(dir, 'handoff/retired-claims/archive.json', `{"token":"${FAKE_AWS_KEY}"}\n`);
        const result = runScanner(dir);
        assert.equal(result.status, 0, result.stdout);
    } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('S9 scan: --changed adds task-owned paths under the same exclusion rules', () => {
    const dir = makeRepo();
    try {
        writeAndTrack(dir, 'server/src/base.ts', 'export const base = true;\n');
        writeFileSync(join(dir, 'server', 'src', 'extra.ts'), `const key = '${FAKE_AWS_KEY}';\n`);
        const result = runScanner(dir, ['--changed', 'server/src/extra.ts']);
        assert.equal(result.status, 1);
        assert.match(result.stdout, /server\/src\/extra\.ts:1 aws-access-key-id/);
        const missingValue = runScanner(dir, ['--changed']);
        assert.equal(missingValue.status, 2);
    } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('S9 scan: usage errors exit 2 instead of pretending a clean scan', () => {
    const dir = makeRepo();
    try {
        const result = spawnSync(process.execPath, [SCANNER, '--changed'], { cwd: dir, encoding: 'utf8' });
        assert.equal(result.status, 2);
    } finally { rmSync(dir, { recursive: true, force: true }); }
});
