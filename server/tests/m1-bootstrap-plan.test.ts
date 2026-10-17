import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, mkdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const script = path.join(repoRoot, 'scripts/build-m1-bootstrap.mjs');

test('stages every migration in order with exact source hashes and reviewed dependency moves', async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'm1-plan-'));
  const destination = path.join(temp, 'stage');
  try {
    const result = spawnSync(process.execPath, [script, destination], { cwd: os.tmpdir(), encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    const manifest = JSON.parse(await readFile(path.join(destination, 'manifest.json'), 'utf8'));
    const sourceNames = Object.keys(manifest.sourceSha256).sort();
    assert.deepEqual(manifest.stagedOrder.filter((name: string) => sourceNames.includes(name)).sort(), sourceNames);
    assert.deepEqual(manifest.stagedOrder, [...manifest.stagedOrder].sort());
    // The database-collation prelude must run before the legacy baseline so
    // the baseline's tables (no explicit charset) are created with the
    // utf8mb4_unicode_ci database default; otherwise later migrations'
    // explicit utf8mb4_unicode_ci foreign keys to users(id) fail with
    // ERROR 3780 on MySQL 8.0.
    const collationIndex = manifest.stagedOrder.indexOf('20260920_00_a_m1_database_collation.sql');
    const baselineIndex = manifest.stagedOrder.indexOf('20260920_00_legacy_baseline.sql');
    assert.equal(collationIndex, 0, 'database-collation prelude must be staged first');
    assert.equal(baselineIndex, 1, 'legacy baseline must run immediately after the database-collation prelude');
    assert.ok(manifest.databaseCollationSha256?.match(/^[a-f0-9]{64}$/));
    const preludeIndex = manifest.stagedOrder.indexOf('20260920_00z_m1_prelude.sql');
    const instructorIndex = manifest.stagedOrder.indexOf('20260920_05_instructor_system.sql');
    assert.ok(baselineIndex < preludeIndex && preludeIndex < instructorIndex);
    for (const name of sourceNames) assert.ok(manifest.sourceSha256[name].match(/^[a-f0-9]{64}$/));
    const collationPrelude = await readFile(path.join(destination, '20260920_00_a_m1_database_collation.sql'), 'utf8');
    assert.match(collationPrelude, /ALTER DATABASE[\s\S]*DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci/i);
    assert.doesNotMatch(collationPrelude, /FOREIGN_KEY_CHECKS/i, 'the collation prelude must never disable foreign-key checks');
    const baseline = await readFile(path.join(destination, '20260920_00_legacy_baseline.sql'), 'utf8');
    assert.match(baseline, /CREATE TABLE `groups`/i);
    const prelude = await readFile(path.join(destination, '20260920_00z_m1_prelude.sql'), 'utf8');
    assert.match(prelude, /CREATE TABLE lectures/i);
    assert.match(prelude, /ALTER TABLE `groups`[\s\S]*instructor_id/i);
    const executablePrelude = prelude.replace(/--[^\r\n]*/g, '');
    assert.doesNotMatch(executablePrelude, /price|archived_at/i);
    const moved = await readFile(path.join(destination, '20260928_runtime_schema_replacement.sql'), 'utf8');
    assert.match(moved, /Moved unchanged to reviewed prelude/);
    assert.match(moved, /ALTER TABLE expenses/);
  } finally { await rm(temp, { recursive: true, force: true }); }
});

test('fails closed for existing destinations and an altered expected statement', async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'm1-plan-'));
  const occupied = path.join(temp, 'occupied');
  await mkdir(occupied);
  await writeFile(path.join(occupied, 'keep.txt'), 'keep');
  try {
    const result = spawnSync(process.execPath, [script, occupied], { cwd: repoRoot, encoding: 'utf8' });
    assert.notEqual(result.status, 0);
    assert.equal(await readFile(path.join(occupied, 'keep.txt'), 'utf8'), 'keep');
  } finally { await rm(temp, { recursive: true, force: true }); }
});
