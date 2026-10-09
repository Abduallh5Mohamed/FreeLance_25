import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

const root = process.cwd();

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
    const files = await sourceFiles(path.join(root, 'src'));
    for (const file of files) {
        const text = await readFile(file, 'utf8');
        assert.doesNotMatch(text, /\b(?:CREATE|ALTER|DROP|TRUNCATE)\s+TABLE\b/i, path.relative(root, file));
        assert.doesNotMatch(text, /\bCREATE\s+(?:UNIQUE\s+)?INDEX\b/i, path.relative(root, file));
    }
});

test('P0: imports route cannot drop data tables', async () => {
    const text = await readFile(path.join(root, 'src/routes/imports.ts'), 'utf8');
    assert.doesNotMatch(text, /\bDROP\s+TABLE\b/i);
    assert.doesNotMatch(text, /CREATE\s+TABLE/i);
});

test('P0: user uploads have no public static mount and downloads require tenant match', async () => {
    const index = await readFile(path.join(root, 'src/index.ts'), 'utf8');
    const files = await readFile(path.join(root, 'src/routes/files.ts'), 'utf8');
    assert.doesNotMatch(index, /express\.static\([^)]*uploads|app\.use\(['"]\/uploads/);
    assert.match(files, /authenticateToken/);
    assert.match(files, /tenant_id=\?/);
});

test('P0: permanent instructor deletion is absent from runtime and UI sources', async () => {
    const codeRoots = [path.resolve(root, '../src'), path.join(root, 'src')];
    const files = (await Promise.all(codeRoots.map(sourceFiles))).flat();
    for (const file of files) {
        const text = await readFile(file, 'utf8');
        assert.doesNotMatch(text, /TEMP_ENABLE_INSTRUCTOR_HARD_DELETE|permanentlyDeletePlatformTenant|\/tenants\/:id\/permanent/);
    }
});

test('P0: JWT signing key has no source fallback', async () => {
    const auth = await readFile(path.join(root, 'src/middleware/auth.ts'), 'utf8');
    assert.match(auth, /process\.env\.JWT_SECRET/);
    assert.match(auth, /throw new Error\('JWT_SECRET is required'\)/);
    assert.doesNotMatch(auth, /JWT_SECRET\s*\|\|/);
});
