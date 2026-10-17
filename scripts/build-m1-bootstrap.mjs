import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, writeFile, lstat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const migrationDir = path.join(repoRoot, 'server', 'migrations');
const preludePath = path.join(repoRoot, 'server', 'bootstrap', 'm1', 'prelude.sql');
const databaseCollationPath = path.join(repoRoot, 'server', 'bootstrap', 'm1', 'database-collation.sql');
const reviewedGroupAlter = /ALTER TABLE `groups`\r?\n  ADD COLUMN instructor_id CHAR\(36\) NULL AFTER grade_id,\r?\n  ADD INDEX idx_group_instructor \(instructor_id\);/;
const preludeName = '20260920_00z_m1_prelude.sql';
const databaseCollationName = '20260920_00_a_m1_database_collation.sql';

const sha256 = (value) => createHash('sha256').update(value).digest('hex');

function assertSafeSql(sql, name) {
  const stripped = sql.replace(/--[^\r\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
  if (/\bDROP\s+DATABASE\b|\bUSE\s+[`\w-]+/i.test(stripped)) throw new Error(`Unsafe database-level statement in ${name}`);
  if (/\bDELETE\s+FROM\s+(?:users|students)\b/i.test(stripped)) throw new Error(`Unsafe user-row deletion in ${name}`);
}

export async function buildM1Bootstrap(destination) {
  if (!destination) throw new Error('An explicit destination directory is required.');
  const target = path.resolve(destination);
  try {
    await lstat(target);
    throw new Error(`Destination already exists; refusing to overwrite: ${target}`);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const names = (await readdir(migrationDir)).filter((name) => /^\d{8}_.*\.sql$/.test(name)).sort();
  const reviewedManifest = JSON.parse(await readFile(path.join(repoRoot, 'server', 'bootstrap', 'm1', 'manifest.json'), 'utf8'));
  const sourceHashes = {};
  const staged = [];
  for (const name of names) {
    const original = await readFile(path.join(migrationDir, name), 'utf8');
    assertSafeSql(original, name);
    sourceHashes[name] = sha256(original);
    if (reviewedManifest.sourceSha256?.[name] !== sourceHashes[name]) {
      throw new Error(`Source hash differs from reviewed manifest for ${name}; review and update the plan explicitly.`);
    }
    let content = original;
    if (name === '20260928_runtime_schema_replacement.sql') {
      if (!reviewedGroupAlter.test(content)) throw new Error('Expected reviewed groups ALTER was not found exactly; refusing silent transform.');
      content = content.replace(reviewedGroupAlter, '-- Moved unchanged to reviewed prelude.sql before 20260925 enrollment dependency.');
    }
    staged.push({ name, content });
  }
  if (Object.keys(reviewedManifest.sourceSha256 ?? {}).sort().join('\n') !== names.join('\n')) {
    throw new Error('Migration inventory differs from reviewed manifest; refusing an incomplete or expanded plan.');
  }
  const prelude = await readFile(preludePath, 'utf8');
  assertSafeSql(prelude, 'prelude.sql');
  const databaseCollation = await readFile(databaseCollationPath, 'utf8');
  assertSafeSql(databaseCollation, 'database-collation.sql');
  const databaseCollationHash = sha256(databaseCollation);
  if (reviewedManifest.databaseCollationSha256 !== databaseCollationHash) {
    throw new Error('Database-collation prelude hash differs from the reviewed manifest; review and update the plan explicitly.');
  }
  const outputFiles = [
    ...staged,
    { name: databaseCollationName, content: databaseCollation },
    { name: preludeName, content: prelude },
  ].sort((a, b) => a.name.localeCompare(b.name));
  const collationIndex = outputFiles.findIndex(({ name }) => name === databaseCollationName);
  const baselineIndex = outputFiles.findIndex(({ name }) => name === '20260920_00_legacy_baseline.sql');
  const preludeIndex = outputFiles.findIndex(({ name }) => name === preludeName);
  if (collationIndex !== 0 || baselineIndex !== 1) {
    throw new Error('Staged lexical order must place the database-collation prelude first, before the legacy baseline.');
  }
  if (!(baselineIndex < preludeIndex && preludeIndex < outputFiles.findIndex(({ name }) => name === '20260920_01_expand_user_roles.sql'))) {
    throw new Error('Staged lexical order does not place the prelude after baseline and before migration 01.');
  }
  await mkdir(target, { recursive: false });
  try {
    for (const { name, content } of outputFiles) await writeFile(path.join(target, name), content, { flag: 'wx' });
    const manifest = {
      format: 2,
      generatedAt: new Date().toISOString(),
      sourceDirectory: 'server/migrations',
      stagedDirectory: target,
      sourceSha256: sourceHashes,
      databaseCollationSha256: databaseCollationHash,
      stagedOrder: outputFiles.map(({ name }) => name),
      transformations: [
        { source: 'server/bootstrap/m1/database-collation.sql', action: 'staged as 20260920_00_a_m1_database_collation.sql before the legacy baseline; sets the database default to utf8mb4/utf8mb4_unicode_ci so every table without an explicit charset matches the explicit utf8mb4_unicode_ci tables and their foreign keys to users(id) (fixes fresh-bootstrap ERROR 3780); edits no migration and disables no foreign-key check' },
        { source: '20260920_00_legacy_baseline.sql', action: 'unchanged copy; canonical legacy schema base' },
        { source: '20261017_02_missing_core_tables.sql', action: 'unchanged copy; dynamic guard skips lectures after reviewed early creation' },
        { source: '20260928_runtime_schema_replacement.sql', action: 'one exact reviewed groups ALTER moved to prelude; all remaining bytes retained' },
        { source: '20260920_05_instructor_system.sql', action: 'unchanged copy; early lectures table satisfies FK references; adds instructor_id' },
        { source: '20260924_instructor_video_exchange.sql', action: 'unchanged copy; owns addition of lectures.price and archived_at' }
      ],
      unresolved: [
        'This plan has not been executed against MySQL. Runtime failures or schema-contract conflicts must be resolved with a reviewed migration-specific repair; the generator intentionally does not suppress unknown SQL.'
      ]
    };
    await writeFile(path.join(target, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, { flag: 'wx' });
    return manifest;
  } catch (error) {
    throw new Error(`Bootstrap staging failed at ${target}; partial directory preserved for inspection: ${error.message}`, { cause: error });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const destination = process.argv[2];
  if (!destination) {
    console.error('Usage: node scripts/build-m1-bootstrap.mjs <new-empty-destination>');
    process.exitCode = 2;
  } else {
    try { await buildM1Bootstrap(destination); console.log(`Staged M1 bootstrap at ${path.resolve(destination)}`); }
    catch (error) { console.error(error.message); process.exitCode = 1; }
  }
}
