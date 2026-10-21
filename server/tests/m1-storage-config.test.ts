import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

/**
 * Static M1 storage security configuration regression checks.
 *
 * These tests parse the canonical deployment configuration files and assert
 * the private-by-default security contract. They read files from disk only:
 * no environment variables, no database, no network, no cloud services.
 */

// Resolved from the test file location, not the process working directory,
// so the suite passes from the repo root (`npx tsx --test
// server/tests/m1-storage-config.test.ts`) and from server/ alike.
const repoRoot = path.resolve(__dirname, '..', '..');

async function readRepoFile(relativePath: string): Promise<string> {
    return readFile(path.join(repoRoot, relativePath), 'utf8');
}

/** Remove full-line nginx comments so directives, not prose, are asserted. */
function stripNginxComments(config: string): string {
    return config
        .split(/\r?\n/)
        .filter((line) => !line.trimStart().startsWith('#'))
        .join('\n');
}

function expectRecord(value: unknown, label: string): Record<string, unknown> {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        throw new TypeError(`${label} must be a JSON object`);
    }
    return value as Record<string, unknown>;
}

function isAnonymousPrincipal(statement: Record<string, unknown>): boolean {
    const principal = expectRecord(statement.Principal ?? {}, 'statement.Principal');
    const aws = principal.AWS;
    return aws === '*' || (Array.isArray(aws) && aws.includes('*'));
}

test('MinIO bucket policy grants nothing to anonymous principals', async () => {
    const policy = JSON.parse(await readRepoFile('minio-policy.json')) as unknown;
    const root = expectRecord(policy, 'minio-policy.json');
    assert.equal(root.Version, '2012-10-17');

    const statements = root.Statement;
    assert.ok(Array.isArray(statements), 'Statement must be a list');
    assert.equal(
        statements.length,
        0,
        'video buckets must be private by default: the anonymous read/write policy is removed'
    );

    for (const raw of statements as unknown[]) {
        const statement = expectRecord(raw, 'statement');
        if (statement.Effect === 'Allow') {
            assert.equal(
                isAnonymousPrincipal(statement),
                false,
                'anonymous Allow statements would make buckets publicly readable/writable'
            );
        }
    }
});

test('canonical nginx config removes public storage and upload proxies', async () => {
    const directives = stripNginxComments(await readRepoFile('nginx-hardened-v4.conf'));

    // No public edge proxy to object storage exists anymore.
    assert.doesNotMatch(directives, /proxy_pass\s+http:\/\/minio/, 'direct MinIO proxy must be removed');
    assert.doesNotMatch(directives, /\balias\s/, 'disk-backed public uploads must be removed');

    // Public media regex locations are gone; delivery is backend-only.
    assert.doesNotMatch(directives, /location\s+~\*[^\n]*\.m3u8/, 'public playlist location must be removed');
    assert.doesNotMatch(directives, /location\s+~\*[^\n]*\.ts/, 'public segment location must be removed');

    // Private prefixes are denied at the edge with ^~ (see precedence test below).
    assert.match(directives, /location\s+\^~\s+\/storage\/\s*\{[^}]*deny\s+all/, '/storage/ must deny all');
    assert.match(directives, /location\s+\^~\s+\/uploads\/\s*\{[^}]*deny\s+all/, '/uploads/ must deny all');
});

test('private deny prefixes stay authoritative over regex locations (^~ precedence)', async () => {
    const directives = stripNginxComments(await readRepoFile('nginx-hardened-v4.conf'));

    // Precondition: the config really contains competing regex locations
    // (e.g. the nested SPA static-asset matcher under `location /`).
    assert.match(
        directives,
        /location\s+~\*/,
        'regex locations exist, so deny prefixes need explicit precedence protection'
    );

    for (const prefix of ['/storage/', '/uploads/']) {
        const escaped = prefix.replace(/\//g, '\\/');

        // The deny block must carry the ^~ modifier: without it nginx prefers a
        // matching regex location (such as the SPA static-asset matcher) over
        // a plain prefix location, which would serve private object paths.
        assert.match(
            directives,
            new RegExp(`location\\s+\\^~\\s+${escaped}\\s*\\{[^}]*deny\\s+all`),
            `${prefix} deny location must use ^~ so regex locations cannot override it`
        );

        // No plain-prefix variant of the same path may exist either.
        assert.doesNotMatch(
            directives,
            new RegExp(`location\\s+(?!\\^~)${escaped}`),
            `${prefix} must not be declared without ^~: regex locations would win over it`
        );
    }
});

test('authenticated video delivery contract and public static assets are retained', async () => {
    const directives = stripNginxComments(await readRepoFile('nginx-hardened-v4.conf'));

    // Authenticated delivery contract: backend-served, token-bound streaming.
    assert.match(directives, /location\s+\/api\/secure-video\//);
    assert.match(directives, /proxy_pass\s+http:\/\/backend\/api\/secure-video\//);

    // Proven public classification: SPA build assets under the frontend root.
    assert.match(directives, /location\s+\/\s*\{[^}]*try_files/, 'SPA fallback must be retained');
    assert.match(directives, /expires\s+1y/, 'static SPA asset caching must be retained');
    assert.match(directives, /\.well-known\/acme-challenge\//, 'ACME renewal path must be retained');
});

test('M1 security config workflow is static only', async () => {
    const workflow = await readRepoFile('.github/workflows/m1-security-config.yml');

    // Static regression classification: no containers, databases or live services.
    assert.doesNotMatch(workflow, /docker/i);
    assert.doesNotMatch(workflow, /mysql|minio|redis|mongodb|postgres/i);
    assert.doesNotMatch(workflow, /\.env|env-file/i);
    assert.doesNotMatch(workflow, /npm run (dev|start|seed)/i);

    // It must exercise the storage security configuration regression tests.
    assert.match(workflow, /m1-storage-config\.test\.ts/);
    assert.match(workflow, /tsx --test/);
});

test('assignment bucket wiring: the private bucket is provisioned and matches the object adapter default', async () => {
    const minioSource = await readRepoFile('server/src/services/minio.ts');

    assert.match(
        minioSource,
        /ASSIGNMENTS:\s*process\.env\.MINIO_BUCKET_ASSIGNMENTS\s*\|\|\s*'assignment-submissions'/,
        'provisioning must wire the private assignment bucket with its documented default',
    );
    assert.doesNotMatch(
        minioSource,
        /\.\s*setBucketPolicy\s*\(/,
        'a bucket policy is how a bucket becomes public: no policy call may exist, so every bucket stays private',
    );

    const adapterSource = await readRepoFile('server/src/services/assignment-storage.ts');
    assert.match(
        adapterSource,
        /MINIO_BUCKET_ASSIGNMENTS\s*\|\|\s*'assignment-submissions'/,
        'the object adapter must target the same bucket default as provisioning',
    );
});
