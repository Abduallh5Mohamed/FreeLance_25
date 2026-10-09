import { readFile, writeFile } from 'node:fs/promises';

let sql = await readFile('database/mysql-schema.sql', 'utf8');
sql = sql
  .replace(/^DROP DATABASE IF EXISTS Freelance;\r?\n/m, '')
  .replace(/^CREATE DATABASE Freelance CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;\r?\n/m, '')
  .replace(/^USE Freelance;\r?\n/m, '');

for (const insertPrefix of ['INSERT INTO users', 'INSERT INTO grades', 'INSERT INTO `groups`']) {
  const start = sql.indexOf(insertPrefix);
  if (start === -1) continue;
  const end = sql.indexOf(';', start);
  if (end === -1) throw new Error(`Unterminated seed statement: ${insertPrefix}`);
  let next = end + 1;
  while (sql[next] === '\r' || sql[next] === '\n') next++;
  sql = sql.slice(0, start) + sql.slice(next);
}

if (/^(DROP DATABASE|CREATE DATABASE|USE Freelance|INSERT INTO)/m.test(sql)) {
  throw new Error('Unsafe database or seed statements remain in baseline');
}

await writeFile(
  'server/migrations/20260920_00_legacy_baseline.sql',
  '-- Fresh-install baseline extracted from database/mysql-schema.sql; schema DDL only.\n' + sql,
  'utf8',
);
console.log('Generated schema-only legacy baseline migration.');
