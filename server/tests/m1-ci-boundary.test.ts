import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';

/**
 * Static/unit M1 CI boundary checks for scripts/check-conflict-markers.mjs.
 *
 * Classification: STATIC. Every test builds disposable fixtures under the OS
 * temp directory and drives the checker's exported detection routine against
 * them; the CLI exit-propagation test spawns the checker over fixtures. No
 * database, no object storage, no Docker, no network and no live services are
 * involved, and nothing is written inside the real repository.
 */

const repoRoot = path.resolve(__dirname, '..', '..');
const checkerScript = path.join(repoRoot, 'scripts', 'check-conflict-markers.mjs');

// The checker is a plain ESM script without type declarations; it is loaded
// through a runtime URL so the untyped module boundary is narrowed once, here.
interface ConflictMarkerChecker {
    findConflictMarkers: (scanRoot?: string) => Promise<string[]>;
    formatFindings: (findings: string[]) => string;
    exitCodeFor: (findings: string[]) => number;
}

async function loadChecker(): Promise<ConflictMarkerChecker> {
    const moduleUrl = pathToFileURL(checkerScript).href;
    return (await import(moduleUrl)) as unknown as ConflictMarkerChecker;
}

// Marker literals are assembled at runtime so that this source file never
// contains a line the detector itself would flag: the CI conflict-marker check
// scans untracked sources (including this test) as well.
const OPEN = '<'.repeat(7);
const SEPARATOR = '='.repeat(7);
const CLOSE = '>'.repeat(7);

function conflictBlock(head = 'HEAD', branch = 'feature-branch'): string {
    return [
        `${OPEN} ${head}`,
        '  return "ours";',
        SEPARATOR,
        '  return "theirs";',
        `${CLOSE} ${branch}`,
    ].join('\n');
}

interface Fixture {
    root: string;
    cleanup: () => Promise<void>;
}

async function createFixture(): Promise<Fixture> {
    const root = await mkdtemp(path.join(os.tmpdir(), 'm1-conflict-fixture-'));
    return { root, cleanup: () => rm(root, { recursive: true, force: true }) };
}

async function writeFixtureFile(root: string, relativePath: string, contents: string | Buffer): Promise<void> {
    const absolute = path.join(root, relativePath);
    await mkdir(path.dirname(absolute), { recursive: true });
    await writeFile(absolute, contents);
}

async function installCheckerCopy(root: string): Promise<string> {
    const copy = path.join(root, 'scripts', 'check-conflict-markers.mjs');
    await writeFixtureFile(root, 'scripts/check-conflict-markers.mjs', await readFile(checkerScript));
    return copy;
}

function spawnAvailable(): boolean {
    const probe = spawnSync(process.execPath, ['--version'], { encoding: 'utf8' });
    return probe.error === undefined && probe.status === 0;
}

// path.relative is platform-native; normalize for stable assertions.
function toPosix(findings: string[]): string[] {
    return findings.map((finding) => finding.split(path.sep).join('/'));
}

test('fails on real unresolved merge conflict markers in untracked sources (positive detection)', async () => {
    const checker = await loadChecker();
    const fixture = await createFixture();
    try {
        // No .git exists in the fixture: every file is untracked, proving the
        // check covers untracked sources, not only committed ones.
        await writeFixtureFile(
            fixture.root,
            'src/greeting.ts',
            [
                'export const greeting = () => {',
                conflictBlock(),
                '};',
                'const token = "SUPER_SECRET_TOKEN_DO_NOT_PRINT";',
            ].join('\n')
        );

        const findings = toPosix(await checker.findConflictMarkers(fixture.root));

        assert.deepEqual(findings, ['src/greeting.ts:2', 'src/greeting.ts:4', 'src/greeting.ts:6']);
        // Redaction invariant: findings are `path:line` only and never carry
        // file contents, so secret-bearing lines cannot leak through them.
        for (const finding of findings) {
            assert.match(finding, /^[^:]+:\d+$/);
        }
        assert.ok(!findings.some((finding) => finding.includes('SUPER_SECRET_TOKEN_DO_NOT_PRINT')));
    } finally {
        await fixture.cleanup();
    }
});

test('passes on clean files, decorative dividers and the detector’s own literals (negative detection)', async () => {
    const checker = await loadChecker();
    const fixture = await createFixture();
    try {
        await writeFixtureFile(
            fixture.root,
            'src/clean.ts',
            [
                'export const ok = true;',
                '======', // six equals: too short to be a marker
                '========', // eight equals: too long to be a marker
                '<<<<<<', // six
                '>>>>>>>>', // eight
                '-------', // hyphen divider, never a marker
                '='.repeat(34), // decorative markdown setext underline
                '    <<<<<<< indented example inside a documentation block',
                '======= trailing text after seven equals',
                'echo "======= mid-line only"',
            ].join('\n')
        );
        // The detector's own source literals must not flag themselves.
        await writeFixtureFile(
            fixture.root,
            'scripts/notes.txt',
            [
                'The checker accepts these markers only at column zero:',
                'const marker = /^(<<<<<<<(?:\\s|$)|=======$|>>>>>>>(?:\\s|$))/m;',
                'A standalone seven-equals line would be reported by that regex.',
            ].join('\n')
        );

        assert.deepEqual(await checker.findConflictMarkers(fixture.root), []);
    } finally {
        await fixture.cleanup();
    }
});

test('skips binary files so marker-like bytes cannot cause false positives', async () => {
    const checker = await loadChecker();
    const fixture = await createFixture();
    try {
        const binary = Buffer.concat([
            Buffer.from([0x00, 0x01, 0x02]),
            Buffer.from(`${OPEN} HEAD\n${SEPARATOR}\n${CLOSE} main\n`),
            Buffer.from([0xff, 0xfe, 0x00]),
        ]);
        await writeFixtureFile(fixture.root, 'assets/logo.dat', binary);

        assert.deepEqual(await checker.findConflictMarkers(fixture.root), []);
    } finally {
        await fixture.cleanup();
    }
});

test('does not scan ignored build/vendor metadata directories', async () => {
    const checker = await loadChecker();
    const fixture = await createFixture();
    try {
        const conflicted = `const generated = true;\n${conflictBlock()}\n`;
        for (const ignoredPath of [
            '.git/MERGE_MSG',
            'node_modules/left-pad/index.js',
            'dist/bundle.js',
            'coverage/lcov.info',
            '.next/BUILD_ID',
        ]) {
            await writeFixtureFile(fixture.root, ignoredPath, conflicted);
        }

        assert.deepEqual(await checker.findConflictMarkers(fixture.root), []);
    } finally {
        await fixture.cleanup();
    }
});

test('does not follow symlinks out of the scan root', async () => {
    const checker = await loadChecker();
    const fixture = await createFixture();
    const outsideRoot = await mkdtemp(path.join(os.tmpdir(), 'm1-conflict-outside-'));
    try {
        await writeFixtureFile(outsideRoot, 'elsewhere/index.js', `const a = 1;\n${conflictBlock()}\n`);
        await symlink(outsideRoot, path.join(fixture.root, 'escape-link'), 'junction');

        assert.deepEqual(await checker.findConflictMarkers(fixture.root), []);
    } finally {
        await fixture.cleanup();
        await rm(outsideRoot, { recursive: true, force: true });
    }
});

test('scans the repository that contains the checker, not the caller working directory', async () => {
    const checker = await loadChecker();
    const fixture = await createFixture();
    const originalCwd = process.cwd();
    try {
        await writeFixtureFile(fixture.root, 'src/buried.ts', `const buried = true;\n${conflictBlock('HEAD', 'topic')}\n`);
        // The caller works inside a directory that itself contains markers;
        // the default root must stay the repository that contains the checker.
        process.chdir(fixture.root);

        assert.deepEqual(await checker.findConflictMarkers(), []);
    } finally {
        process.chdir(originalCwd);
        await fixture.cleanup();
    }
});

test('report and exit-code contract: any finding fails, none passes', async () => {
    const checker = await loadChecker();

    assert.equal(checker.formatFindings([]), 'No merge conflict markers found.');
    assert.equal(checker.exitCodeFor([]), 0);

    const findings = ['src/a.ts:2', 'src/a.ts:4'];
    const report = checker.formatFindings(findings);
    assert.match(report, /Unresolved merge conflict markers found/);
    for (const finding of findings) {
        assert.ok(report.includes(finding));
    }
    assert.equal(checker.exitCodeFor(findings), 1);
});

test('CLI exit propagation: markers exit 1, clean exits 0', async (t) => {
    if (!spawnAvailable()) {
        t.skip('child process spawning is unavailable in this environment');
        return;
    }
    const conflicted = await createFixture();
    const clean = await createFixture();
    try {
        // Each checker copy resolves its scan root from its own location, so
        // it scans the fixture it was installed into. Both are invoked from
        // the unrelated clean directory, proving the caller working directory
        // cannot change what is scanned.
        const conflictedChecker = await installCheckerCopy(conflicted.root);
        const cleanChecker = await installCheckerCopy(clean.root);
        await writeFixtureFile(conflicted.root, 'src/a.ts', `const a = 1;\n${conflictBlock()}\n`);
        await writeFixtureFile(clean.root, 'src/b.ts', 'export const b = 2;\n');

        const failed = spawnSync(process.execPath, [conflictedChecker], {
            cwd: clean.root,
            encoding: 'utf8',
        });
        assert.equal(failed.status, 1, 'markers must exit non-zero');
        assert.match(failed.stderr, /Unresolved merge conflict markers found/);
        assert.ok(
            toPosix([failed.stderr]).some((line) => line.includes('src/a.ts:2')),
            'findings are relative to the checker-rooted repository'
        );

        const passed = spawnSync(process.execPath, [cleanChecker], {
            cwd: clean.root,
            encoding: 'utf8',
        });
        assert.equal(passed.status, 0, 'clean tree must exit zero');
        assert.match(passed.stdout, /No merge conflict markers found/);
    } finally {
        await conflicted.cleanup();
        await clean.cleanup();
    }
});
