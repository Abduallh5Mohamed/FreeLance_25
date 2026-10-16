import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

/**
 * Static P0 source-code checklist — static evidence only.
 *
 * Every case below reads source files from disk and inspects their text. It
 * never executes the server, so it proves nothing about runtime request
 * handling: runtime P0 behaviour lives in the M1 integration suite, which is
 * not imported here. No environment variables, database, network or cloud
 * services are used.
 */

// Roots are resolved from this file's location, not the process working
// directory, so the suite passes identically from the repo root
// (`npx tsx --test server/tests/p0-checklist.test.ts`) and from server/.
const repoRoot = path.resolve(__dirname, '..', '..');
const serverRoot = path.resolve(__dirname, '..');

async function sourceFiles(directory: string): Promise<string[]> {
    const files: string[] = [];
    for (const entry of await readdir(directory, { withFileTypes: true })) {
        const target = path.join(directory, entry.name);
        if (entry.isDirectory()) files.push(...await sourceFiles(target));
        else if (entry.isFile() && /\.(ts|tsx|js|jsx)$/.test(entry.name)) files.push(target);
    }
    return files;
}

test('P0: server runtime source contains no DDL statements', async () => {
    const files = await sourceFiles(path.join(serverRoot, 'src'));
    for (const file of files) {
        const text = await readFile(file, 'utf8');
        assert.doesNotMatch(text, /\b(?:CREATE|ALTER|DROP|TRUNCATE)\s+TABLE\b/i, path.relative(repoRoot, file));
        assert.doesNotMatch(text, /\bCREATE\s+(?:UNIQUE\s+)?INDEX\b/i, path.relative(repoRoot, file));
    }
});

test('P0: imports route cannot drop data tables', async () => {
    const text = await readFile(path.join(serverRoot, 'src/routes/imports.ts'), 'utf8');
    assert.doesNotMatch(text, /\bDROP\s+TABLE\b/i);
    assert.doesNotMatch(text, /CREATE\s+TABLE/i);
});

test('P0: user uploads have no public static mount and downloads require tenant match', async () => {
    const index = await readFile(path.join(serverRoot, 'src/index.ts'), 'utf8');
    const files = await readFile(path.join(serverRoot, 'src/routes/files.ts'), 'utf8');
    assert.doesNotMatch(index, /express\.static\([^)]*uploads|app\.use\(['"]\/uploads/);
    assert.match(files, /authenticateToken/);
    assert.match(files, /tenant_id=\?/);
});

test('P0: permanent instructor deletion is absent from runtime and UI sources', async () => {
    const codeRoots = [path.join(repoRoot, 'src'), path.join(serverRoot, 'src')];
    const files = (await Promise.all(codeRoots.map(sourceFiles))).flat();
    for (const file of files) {
        const text = await readFile(file, 'utf8');
        assert.doesNotMatch(text, /TEMP_ENABLE_INSTRUCTOR_HARD_DELETE|permanentlyDeletePlatformTenant|\/tenants\/:id\/permanent/);
    }
});

test('P0: JWT signing key has no source fallback', async () => {
    const auth = await readFile(path.join(serverRoot, 'src/middleware/auth.ts'), 'utf8');
    assert.match(auth, /process\.env\.JWT_SECRET/);
    assert.match(auth, /throw new Error\('JWT_SECRET is required'\)/);
    assert.doesNotMatch(auth, /JWT_SECRET\s*\|\|/);
});
