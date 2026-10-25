import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, writeFile, lstat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { TextDecoder } from 'node:util';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const migrationDir = path.join(repoRoot, 'server', 'migrations');
const preludePath = path.join(repoRoot, 'server', 'bootstrap', 'm1', 'prelude.sql');
const databaseCollationPath = path.join(repoRoot, 'server', 'bootstrap', 'm1', 'database-collation.sql');
const reviewedGroupAlter = /ALTER TABLE `groups`\r?\n  ADD COLUMN instructor_id CHAR\(36\) NULL AFTER grade_id,\r?\n  ADD INDEX idx_group_instructor \(instructor_id\);/;
const preludeName = '20260920_00z_m1_prelude.sql';
const databaseCollationName = '20260920_00_a_m1_database_collation.sql';

const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const contentHashEncoding = 'utf8-crlf-to-lf-v1';

async function readSqlUtf8(sourcePath) {
  const bytes = await readFile(sourcePath);
  // Preserve an existing BOM and reject malformed UTF-8 rather than silently
  // replacing it before hashing. Raw provenance hashes always cover real bytes.
  const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  return { text, rawSha256: sha256(bytes) };
}

// Only transport line endings are canonicalized. Preserve BOM, final newline,
// whitespace, comments and all SQL tokens so content changes still fail review.
function canonicalSql(value, name) {
  const canonical = value.replace(/\r\n/g, '\n');
  if (canonical.includes('\r')) throw new Error(`Unsupported bare CR in ${name}; review the source encoding explicitly.`);
  return canonical;
}

function assertSafeSql(sql, name) {
  const stripped = sql.replace(/--[^\r\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
  if (/\bDROP\s+DATABASE\b|\bUSE\s+[`\w-]+/i.test(stripped)) throw new Error(`Unsafe database-level statement in ${name}`);
  if (/\bDELETE\s+FROM\s+(?:users|students)\b/i.test(stripped)) throw new Error(`Unsafe user-row deletion in ${name}`);
}

/** Source-plan checks do not confer SQL execution or source-review approval. */
function validatePlatformSourcePlan(plan, names, sourceHashes) {
  if (plan?.format !== 1 || !Array.isArray(plan.entries)
      || typeof plan.state !== 'string' || !plan.state.trim()
      || !Array.isArray(plan.requirements)
      || plan.requirements.some((item) => typeof item !== 'string' || !item.trim())) {
    throw new Error('Invalid platform migration source plan.');
  }
  const positions = new Map(names.map((name, index) => [name, index]));
  const seen = new Set();
  for (const entry of plan.entries) {
    if (!entry || typeof entry.name !== 'string'
        || !/^\d{8}_[A-Za-z0-9_-]+\.sql$/.test(entry.name)
        || seen.has(entry.name) || !positions.has(entry.name)
        || !Array.isArray(entry.requires)
        || typeof entry.state !== 'string' || !entry.state.trim()
        || typeof entry.executionVerified !== 'boolean'
        || typeof entry.sourceSha256 !== 'string'
        || !/^[0-9a-f]{64}$/.test(entry.sourceSha256)) {
      throw new Error('Invalid, duplicate or missing platform migration entry.');
    }
    seen.add(entry.name);
    for (const [kind, dependencies] of [
      ['requires', entry.requires],
      ['compositionRequires', entry.compositionRequires === undefined ? [] : entry.compositionRequires],
    ]) {
      if (!Array.isArray(dependencies) || new Set(dependencies).size !== dependencies.length) {
        throw new Error('Invalid or duplicate ' + kind + ' prerequisites for ' + entry.name);
      }
      for (const dependency of dependencies) {
        if (typeof dependency !== 'string' || !positions.has(dependency)
            || positions.get(dependency) >= positions.get(entry.name)) {
          throw new Error('Missing or out-of-order ' + kind + ' prerequisite for ' + entry.name);
        }
      }
    }
    if (sourceHashes && sourceHashes[entry.name] !== entry.sourceSha256) {
      throw new Error('Platform source plan hash drift for ' + entry.name);
    }
  }
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
  if (reviewedManifest.contentHashEncoding !== contentHashEncoding) {
    throw new Error('Reviewed manifest must explicitly declare the canonical SQL hash encoding.');
  }
  const platformPlanSource = await readFile(path.join(repoRoot, 'server', 'bootstrap', 'm1', 'platform-source-plan.json'), 'utf8');
  const platformPlan = JSON.parse(platformPlanSource);
  validatePlatformSourcePlan(platformPlan, names);
  // New platform migrations are inventoried separately until source review
  // integrates their hashes. Never silently bless all current checkout files.
  const unreviewed = names.filter((name) => !Object.hasOwn(reviewedManifest.sourceSha256 ?? {}, name));
  if (unreviewed.length > 0) {
    throw new Error(
      'Bootstrap source review required for: ' + unreviewed.join(', ')
      + '. See server/bootstrap/m1/platform-source-plan.json; no files staged and no SQL executed.',
    );
  }
  const sourceHashes = {};
  const sourceRawHashes = {};
  const staged = [];
  for (const name of names) {
    const source = await readSqlUtf8(path.join(migrationDir, name));
    const original = canonicalSql(source.text, name);
    assertSafeSql(original, name);
    sourceRawHashes[name] = source.rawSha256;
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
  validatePlatformSourcePlan(platformPlan, names, sourceHashes);
  if (Object.keys(reviewedManifest.sourceSha256 ?? {}).sort().join('\n') !== names.join('\n')) {
    throw new Error('Migration inventory differs from reviewed manifest; refusing an incomplete or expanded plan.');
  }
  const prelude = canonicalSql((await readSqlUtf8(preludePath)).text, 'prelude.sql');
  assertSafeSql(prelude, 'prelude.sql');
  const preludeHash = sha256(prelude);
  if (reviewedManifest.preludeSha256 !== preludeHash) {
    throw new Error('Prelude hash differs from the reviewed manifest; review and update the plan explicitly.');
  }
  const databaseCollation = canonicalSql((await readSqlUtf8(databaseCollationPath)).text, 'database-collation.sql');
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
      format: 3,
      contentHashEncoding,
      generatedAt: new Date().toISOString(),
      sourceDirectory: 'server/migrations',
      stagedDirectory: target,
      sourceSha256: sourceHashes,
      platformSourcePlan: {
        source: 'server/bootstrap/m1/platform-source-plan.json',
        sourceSha256: sha256(platformPlanSource.replace(/\r\n/g, '\n')),
        entries: platformPlan.entries,
        state: platformPlan.state,
        requirements: platformPlan.requirements,
        executionVerified: false,
      },
      sourceRawSha256: sourceRawHashes,
      preludeSha256: preludeHash,
      databaseCollationSha256: databaseCollationHash,
      stagedSha256: Object.fromEntries(outputFiles.map(({ name, content }) => [name, sha256(content)])),
      stagedOrder: outputFiles.map(({ name }) => name),
      transformations: [
        { source: 'server/bootstrap/m1/database-collation.sql', action: 'staged as 20260920_00_a_m1_database_collation.sql before the legacy baseline; sets the database default to utf8mb4/utf8mb4_unicode_ci so every table without an explicit charset matches the explicit utf8mb4_unicode_ci tables and their foreign keys to users(id) (fixes fresh-bootstrap ERROR 3780); edits no migration and disables no foreign-key check' },
        { source: '*', action: 'canonical UTF-8 SQL with CRLF converted to LF only; no trimming or SQL token rewriting; source and staged hashes describe canonical content, sourceRawSha256 records checkout bytes' },
        { source: '20260920_00_legacy_baseline.sql', action: 'canonical line-ending copy; legacy schema base' },
        { source: '20261017_02_missing_core_tables.sql', action: 'canonical line-ending copy; dynamic guard skips lectures after reviewed early creation' },
        { source: '20260928_runtime_schema_replacement.sql', action: 'one exact reviewed groups ALTER moved to prelude after line-ending canonicalization; all remaining canonical content retained' },
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
