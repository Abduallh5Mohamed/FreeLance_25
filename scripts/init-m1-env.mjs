import { randomBytes } from 'node:crypto';
import { writeFile } from 'node:fs/promises';

const hex = (bytes) => randomBytes(bytes).toString('hex');
const minioUser = `m1_${hex(8)}`;
const minioPassword = hex(32);
const rootPassword = hex(32);
const jwtSecret = hex(48);

const content = [
  `MYSQL_ROOT_PASSWORD=${rootPassword}`,
  `MINIO_ROOT_USER=${minioUser}`,
  `MINIO_ROOT_PASSWORD=${minioPassword}`,
  `M1_DB_HOST=127.0.0.1`,
  `M1_DB_PORT=13316`,
  `M1_DB_NAME=tabweb_m1_test`,
  `DB_HOST=127.0.0.1`,
  `DB_PORT=13316`,
  `DB_NAME=tabweb_m1_test`,
  `DB_USER=root`,
  `M1_SEED_PASSWORD=${hex(24)}`,
  `M1_TEST_PASSWORD=${hex(24)}`,
  `JWT_SECRET=${jwtSecret}`,
  `MINIO_ENDPOINT=127.0.0.1`,
  `MINIO_PORT=19000`,
  `MINIO_ACCESS_KEY=${minioUser}`,
  `MINIO_SECRET_KEY=${minioPassword}`,
  `MINIO_USE_SSL=false`,
  `PORT=3188`,
].join('\n') + '\n';

await writeFile('.env.m1', content, { flag: 'wx', mode: 0o600 });
console.log('Created ignored .env.m1 with random local-only credentials.');
