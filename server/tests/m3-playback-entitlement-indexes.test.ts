/**
 * Static (no-DB) tests for the playback_entitlements session-index migration.
 *
 * The secure delivery path reads entitlement records by session id on every
 * manifest / media / segment / key request, so the table must index the
 * columns those lookups filter and sort on. These tests read the migration,
 * the owning table definition and the two production sources as text: they
 * prove the migration is INFORMATION_SCHEMA-guarded and non-destructive, that
 * it is registered in the reviewed M1 manifest, and that every WHERE column
 * used by the secure-video entitlement lookups is the leftmost column of some
 * index.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

const read = (relative: string): string => readFileSync(join(__dirname, relative), 'utf8');

const migrationName = '20261018_15_playback_entitlement_indexes.sql';
const migration = read(`../migrations/${migrationName}`);
const baseTable = read('../migrations/20261018_06_video_assets_entitlements.sql');
const entitlementSource = read('../src/services/playback-entitlement.ts');
const deliverySource = read('../src/routes/secure-video.ts');
const reviewedManifest = JSON.parse(
    readFileSync(join(__dirname, '..', 'bootstrap', 'm1', 'manifest.json'), 'utf8'),
) as { sourceSha256?: Record<string, string> };

/** SQL with `--` and block comments removed, so keyword checks see statements only. */
const stripComments = (sql: string): string =>
    sql.replace(/--[^\r\n]*/g, ' ').replace(/\/\*[\s\S]*?\*\//g, ' ');

const statements = stripComments(migration);

interface IndexDefinition {
    name: string;
    columns: string[];
}

const declaredIndexes: IndexDefinition[] = [...migration.matchAll(/ADD INDEX\s+`?([A-Za-z0-9_]+)`?\s*\(([^)]*)\)/gi)]
    .map((match) => ({
        name: match[1],
        columns: match[2]
            .split(',')
            .map((column) => column.trim().split(/\s+/)[0].replace(/`/g, ''))
            .filter(Boolean),
    }));

const primaryKeyColumns: string[] = (() => {
    const block = /CREATE TABLE playback_entitlements[\s\S]*?PRIMARY KEY \(([^)]+)\)/.exec(baseTable);
    return block ? block[1].split(',').map((column) => column.trim().replace(/`/g, '')) : [];
})();

/** Leftmost column of every declared index plus the primary key. */
const coveredPrefixes = new Set<string>(
    [
        ...declaredIndexes.map((index) => index.columns[0]),
        primaryKeyColumns[0],
    ].filter((column): column is string => Boolean(column)),
);

/** Every column named in a WHERE clause that reads playback_entitlements. */
const whereColumns: string[] = (() => {
    const columns = new Set<string>();
    const source = `${entitlementSource}\n${deliverySource}`;
    const statementRegex = /(?:FROM|UPDATE|INTO)\s+playback_entitlements\b([\s\S]*?)(?=`|'|;)/gi;
    for (const match of source.matchAll(statementRegex)) {
        const where = /WHERE\s+([A-Za-z_][A-Za-z0-9_]*)/i.exec(match[1]);
        if (where) columns.add(where[1].toLowerCase());
    }
    return [...columns];
})();

test('the migration is registered in the reviewed M1 manifest with a matching SHA-256', () => {
    const hash = createHash('sha256').update(migration, 'utf8').digest('hex');
    assert.ok(reviewedManifest.sourceSha256, 'the reviewed manifest must carry sourceSha256');
    assert.equal(reviewedManifest.sourceSha256![migrationName], hash);
});

test('every index addition is INFORMATION_SCHEMA-guarded and idempotent', () => {
    assert.ok(declaredIndexes.length >= 2, 'the session and tenant/session indexes must both be declared');
    for (const index of declaredIndexes) {
        assert.ok(
            migration.includes(`INDEX_NAME = '${index.name}'`),
            `${index.name} must be probed in INFORMATION_SCHEMA.STATISTICS`,
        );
    }
    assert.match(migration, /INFORMATION_SCHEMA\.TABLES[\s\S]*?TABLE_NAME = 'playback_entitlements'/i);
    assert.match(migration, /INFORMATION_SCHEMA\.STATISTICS[\s\S]*?TABLE_NAME = 'playback_entitlements'/i);

    const prepares = migration.match(/PREPARE\s+\w+\s+FROM/g) ?? [];
    const executes = migration.match(/EXECUTE\s+\w+/g) ?? [];
    const deallocates = migration.match(/DEALLOCATE\s+PREPARE/g) ?? [];
    assert.equal(prepares.length, executes.length, 'every PREPARE must be executed');
    assert.equal(prepares.length, deallocates.length, 'every PREPARE must be deallocated');
    assert.ok(prepares.length >= declaredIndexes.length, 'one guarded statement per index');
});

test('the migration is non-destructive and only adds indexes', () => {
    assert.doesNotMatch(statements, /\b(DROP|TRUNCATE|DELETE|UPDATE|REPLACE)\b/i);
    assert.doesNotMatch(statements, /\b(ADD COLUMN|MODIFY COLUMN|CHANGE COLUMN|RENAME)\b/i);
    assert.match(statements, /ALTER TABLE playback_entitlements/);
    for (const index of declaredIndexes) {
        assert.match(statements, new RegExp(`ADD INDEX\\s+${index.name}\\s*\\(`));
    }
});

test('every WHERE column used by the secure-video entitlement lookups is covered by an index prefix', () => {
    assert.ok(whereColumns.includes('session_id'), 'the delivery lookup filters on session_id');
    assert.ok(whereColumns.includes('jti'), 'load / isRevoked / revoke filter on jti');
    for (const column of whereColumns) {
        assert.ok(
            coveredPrefixes.has(column),
            `${column} must be the leftmost column of some index or the primary key`,
        );
    }

    const sessionIndex = declaredIndexes.find((index) => index.name === 'idx_playback_entitlements_session');
    assert.deepEqual(sessionIndex?.columns, ['session_id', 'issued_at'], 'the session index must filter then sort');
});
