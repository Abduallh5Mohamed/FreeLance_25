/*
 * Run the M1 seed, API, and live integration suite only against an explicitly
 * owned isolated stack. This script is intentionally not part of `npm test`.
 * It reads only the supplied private env file and ownership metadata.
 */
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const { spawn, spawnSync } = require('node:child_process');
const dotenv = require('dotenv');

const EXPECTED = Object.freeze({
  database: 'tabweb_m1_test',
  mysqlPort: '13316',
  apiPort: '3188',
  minioApiPort: '19000',
  minioConsolePort: '19001',
  // MinIO image built locally from the pinned official source release
  // RELEASE.2025-10-15T17-29-55Z (upstream minio/minio commit
  // 9e49d5e7a648f00e26f2246f4dc28e6b07f8c84a). No floating tag and no
  // prebuilt release binary is accepted here.
  minioImage: 'minio-m1-isolated:RELEASE.2025-10-15T17-29-55Z',
});

function fail(message) { throw new Error(`M1 isolated validation refused: ${message}`); }

function parseArgs(argv) {
  const result = {};
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    if (!['--run-dir', '--env-file', '--metadata'].includes(key) || result[key]) {
      fail(`unexpected or repeated argument ${key}`);
    }
    const value = argv[i + 1];
    if (!value || value.startsWith('--')) fail(`missing value for ${key}`);
    result[key] = value;
    i += 1;
  }
  for (const key of ['--run-dir', '--env-file', '--metadata']) {
    if (!result[key]) fail(`required argument ${key} is missing`);
    if (!path.isAbsolute(result[key])) fail(`${key} must be an absolute path`);
  }
  return result;
}

function inside(parent, child) {
  const relative = path.relative(parent, child);
  return relative !== '' && !relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative);
}

function readPrivateInputs(args) {
  const runDir = fs.realpathSync(args['--run-dir']);
  const envPath = fs.realpathSync(args['--env-file']);
  const metadataPath = fs.realpathSync(args['--metadata']);
  if (!inside(runDir, envPath) || path.basename(envPath) !== '.env.m1') fail('env file must be .env.m1 inside the supplied private run directory');
  if (!inside(runDir, metadataPath) || path.basename(metadataPath) !== 'run-metadata.json') fail('metadata must be run-metadata.json inside the private run directory');
  if (!/^m1-isolated-[A-Za-z0-9_-]+$/.test(path.basename(runDir))) fail('run directory name must be m1-isolated-<run>');

  const envBytes = fs.readFileSync(envPath);
  const env = dotenv.parse(envBytes);
  const metadata = JSON.parse(fs.readFileSync(metadataPath, 'utf8'));
  if (metadata.envSha256 !== crypto.createHash('sha256').update(envBytes).digest('hex')) fail('env checksum does not match owned compose metadata');
  if (metadata.runPath !== runDir || metadata.envPath !== envPath) fail('metadata runPath/envPath do not match the supplied private paths');
  if (metadata.dbName !== EXPECTED.database) fail('metadata does not declare the isolated test database');
  if (path.resolve(metadata.composeFile || '') !== path.join(runDir, 'compose.yaml')) fail('metadata compose file must be the run-owned compose.yaml');
  const expectedBindings = {
    mysql: '127.0.0.1:13316->3306/tcp',
    minio: '127.0.0.1:19000->9000/tcp',
    minioConsole: '127.0.0.1:19001->9001/tcp',
  };
  const actualBindingKeys = Object.keys(metadata.portBindings || {}).sort();
  const expectedBindingKeys = Object.keys(expectedBindings).sort();
  if (JSON.stringify(actualBindingKeys) !== JSON.stringify(expectedBindingKeys) || expectedBindingKeys.some((key) => metadata.portBindings[key] !== expectedBindings[key])) {
    fail('metadata port bindings do not match the isolated loopback-only stack');
  }
  const requiredMetadata = ['composeProject', 'mysqlContainerId', 'minioContainerId'];
  for (const key of requiredMetadata) {
    if (typeof metadata[key] !== 'string' || metadata[key].trim() === '') fail(`metadata is missing ${key}`);
  }

  const required = ['DB_NAME', 'DB_PORT', 'DB_HOST', 'DB_USER', 'DB_PASSWORD', 'MYSQL_ROOT_PASSWORD', 'JWT_SECRET', 'M1_SEED_PASSWORD', 'MINIO_ROOT_USER', 'MINIO_ROOT_PASSWORD'];
  for (const key of required) if (!env[key]) fail(`private env file is missing ${key}`);
  if (env.DB_NAME !== EXPECTED.database || env.DB_PORT !== EXPECTED.mysqlPort || env.DB_HOST !== '127.0.0.1') {
    fail('database target must be tabweb_m1_test on loopback port 13316');
  }
  if (env.JWT_SECRET.length < 32 || env.M1_SEED_PASSWORD.length < 16) fail('private test secrets do not meet minimum lengths');
  if (env.M1_API_BASE_URL !== `http://127.0.0.1:${EXPECTED.apiPort}`) fail('M1_API_BASE_URL must be the isolated loopback API origin');
  return { runDir, envPath, envBytes, env, metadata };
}

function dockerInspect(containerId) {
  const result = spawnSync('docker', ['inspect', containerId], { encoding: 'utf8', windowsHide: true, timeout: 15000 });
  if (result.error || result.status !== 0) fail(`Docker could not inspect the declared container ${containerId}`);
  let rows;
  try { rows = JSON.parse(result.stdout); } catch { fail('Docker returned invalid inspection data'); }
  if (!Array.isArray(rows) || rows.length !== 1) fail('declared container identity is ambiguous');
  return rows[0];
}

function verifyContainer(container, metadata, service, image, bindings) {
  const labels = container.Config && container.Config.Labels || {};
  if (!container.State || container.State.Status !== 'running') fail(`${service} container is not running`);
  if (labels['com.docker.compose.project'] !== metadata.composeProject || labels['com.docker.compose.service'] !== service) fail(`${service} container is not owned by the declared compose project`);
  if (path.resolve(labels['com.docker.compose.project.working_dir'] || '') !== metadata.runPath || path.resolve(labels['com.docker.compose.project.config_files'] || '') !== metadata.composeFile) fail(`${service} compose ownership labels do not identify the private run files`);
  if (!container.Config || container.Config.Image !== image) fail(`${service} container image does not match the isolated stack`);
  const ports = container.NetworkSettings && container.NetworkSettings.Ports || {};
  const expectedKeys = Object.keys(bindings).sort();
  const publishedKeys = Object.keys(ports).filter((key) => ports[key] !== null).sort();
  if (JSON.stringify(expectedKeys) !== JSON.stringify(publishedKeys)) fail(`${service} publishes unexpected container ports`);
  for (const [containerPort, hostPort] of Object.entries(bindings)) {
    const records = ports[containerPort];
    if (!Array.isArray(records) || records.length !== 1 || records[0].HostIp !== '127.0.0.1' || records[0].HostPort !== hostPort) {
      fail(`${service} ${containerPort} must bind exactly to 127.0.0.1:${hostPort}`);
    }
  }
}

function verifyOwnedStack(metadata) {
  if (!/^[0-9a-f]{64}$/i.test(metadata.mysqlContainerId) || !/^[0-9a-f]{64}$/i.test(metadata.minioContainerId)) fail('metadata must contain full Docker container IDs');
  const mysql = dockerInspect(metadata.mysqlContainerId);
  const minio = dockerInspect(metadata.minioContainerId);
  if (mysql.Id !== metadata.mysqlContainerId || minio.Id !== metadata.minioContainerId) fail('container IDs differ from the ownership record');
  verifyContainer(mysql, metadata, 'mysql', 'mysql:8.0', { '3306/tcp': EXPECTED.mysqlPort });
  verifyContainer(minio, metadata, 'minio', EXPECTED.minioImage, { '9000/tcp': EXPECTED.minioApiPort, '9001/tcp': EXPECTED.minioConsolePort });
}

function assertPortFree(port) {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', () => reject(new Error(`M1 isolated validation refused: API port ${port} is already occupied`)));
    server.listen({ host: '0.0.0.0', port, exclusive: true }, () => server.close((error) => error ? reject(error) : resolve()));
  });
}

function childEnv(env, privateEnvPath, mode, overrides = {}) {
  const safeHostEnv = {};
  for (const key of ['PATH', 'Path', 'SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'USERPROFILE']) {
    if (process.env[key]) safeHostEnv[key] = process.env[key];
  }
  return {
    ...safeHostEnv,
    NODE_ENV: 'test',
    M1_TEST_ENV_FILE: privateEnvPath,
    M1_NETWORK_MODE: mode,
    DB_NAME: env.DB_NAME,
    DB_PORT: env.DB_PORT,
    DB_HOST: env.DB_HOST,
    DB_USER: env.DB_USER,
    DB_PASSWORD: env.DB_PASSWORD,
    MYSQL_ROOT_PASSWORD: env.MYSQL_ROOT_PASSWORD,
    JWT_SECRET: env.JWT_SECRET,
    M1_SEED_PASSWORD: env.M1_SEED_PASSWORD,
    M1_API_BASE_URL: env.M1_API_BASE_URL,
    PORT: EXPECTED.apiPort,
    MINIO_ENDPOINT: '127.0.0.1',
    MINIO_PORT: EXPECTED.minioApiPort,
    MINIO_ACCESS_KEY: env.MINIO_ROOT_USER,
    MINIO_SECRET_KEY: env.MINIO_ROOT_PASSWORD,
    SKIP_DB_ON_START: 'false',
    SAAS_LIFECYCLE_JOBS_ENABLED: 'false',
    VIDEO_QUEUE_POLL_SECONDS: '3600',
    ...overrides,
  };
}

function spawnLogged(command, args, options, label) {
  const child = spawn(command, args, { ...options, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.on('data', (chunk) => { output += chunk.toString(); process.stdout.write(`[${label}] ${chunk}`); });
  child.stderr.on('data', (chunk) => { output += chunk.toString(); process.stderr.write(`[${label}] ${chunk}`); });
  child.outputText = () => output;
  return child;
}

function waitExit(child, timeoutMs, label) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      reject(new Error(`${label} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    child.once('error', (error) => { clearTimeout(timer); reject(error); });
    child.once('exit', (code, signal) => {
      clearTimeout(timer);
      if (code !== 0) reject(new Error(`${label} failed (code=${code}, signal=${signal})`));
      else resolve();
    });
  });
}

async function waitForHealth(baseUrl, child, timeoutMs = 60000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`API exited before health check (code=${child.exitCode})`);
    try {
      const response = await fetch(`${baseUrl}/health`, { redirect: 'manual', signal: AbortSignal.timeout(1500) });
      if (response.status === 200) return;
    } catch { /* Continue bounded local readiness polling. */ }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error('API did not become healthy within 60 seconds');
}

async function run() {
  const args = parseArgs(process.argv.slice(2));
  const inputs = readPrivateInputs(args);
  verifyOwnedStack(inputs.metadata);
  await assertPortFree(Number(EXPECTED.apiPort));

  const serverRoot = path.resolve(__dirname, '..');
  const tsxLoader = path.join(serverRoot, 'node_modules', 'tsx', 'dist', 'loader.mjs');
  const networkGuard = path.resolve(serverRoot, '..', 'scripts', 'm1-network-guard.cjs');
  const seedScript = path.join(serverRoot, 'scripts', 'seed-m1.ts');
  const apiScript = path.join(serverRoot, 'src', 'index.ts');
  const integrationTests = [
    path.join(serverRoot, 'tests', 'integration', 'm1-tenant-isolation.test.ts'),
    path.join(serverRoot, 'tests', 'integration', 'm1-branch-resource-live.test.ts'),
  ];
  for (const file of [tsxLoader, networkGuard, seedScript, apiScript, ...integrationTests]) if (!fs.existsSync(file)) fail(`required source/runtime file is missing: ${file}`);

  const base = childEnv(inputs.env, inputs.envPath, 'isolated-api');
  const loaderUrl = require('node:url').pathToFileURL(tsxLoader).href;
  const cwd = inputs.runDir;
  const node = process.execPath;
  let apiChild;
  try {
    const preload = ['--require', networkGuard, '--import', loaderUrl];
    const seed = spawnLogged(node, [...preload, seedScript], { cwd, env: base }, 'seed');
    await waitExit(seed, 120000, 'M1 seed');

    apiChild = spawnLogged(node, [...preload, apiScript], { cwd, env: base }, 'api');
    await waitForHealth(inputs.env.M1_API_BASE_URL, apiChild);

    const integrationEnv = childEnv(inputs.env, inputs.envPath, 'isolated-test');
    for (const integrationTest of integrationTests) {
      const integration = spawnLogged(node, [...preload, '--test', integrationTest], { cwd, env: integrationEnv }, 'integration');
      await waitExit(integration, 180000, `M1 live integration suite (${path.basename(integrationTest)})`);
    }
    process.stdout.write('M1 isolated validation completed successfully.\n');
  } finally {
    if (apiChild && apiChild.exitCode === null) {
      apiChild.kill('SIGTERM');
      await new Promise((resolve) => apiChild.once('exit', resolve));
    }
  }
}

run().catch((error) => {
  console.error(error && error.stack || error);
  process.exitCode = 1;
});
