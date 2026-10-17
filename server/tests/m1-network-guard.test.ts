import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const require = createRequire(import.meta.url);
const guard = require('../../scripts/m1-network-guard.cjs') as {
  decideConnect(mode: string, args: unknown[], hermeticPorts?: Set<number>): { allowed: boolean; reason?: string; port?: number };
  decideListen(mode: string, args: unknown[]): { allowed: boolean; reason?: string; port?: number; host?: string };
  installNetworkGuard(options: { mode: string }): { hermeticPorts: Set<number>; restore(): void };
};

test('isolated modes only admit explicitly approved loopback endpoints', () => {
  for (const mode of ['isolated-api', 'isolated-test']) {
    for (const port of [13316, 19000, 3188]) {
      assert.equal(guard.decideConnect(mode, [{ port, host: '127.0.0.1' }]).allowed, true);
      assert.equal(guard.decideConnect(mode, [{ port, host: 'localhost' }]).allowed, true);
      assert.equal(guard.decideConnect(mode, [[port, '::1']]).allowed, true);
    }
    assert.equal(guard.decideConnect(mode, [3306, 'localhost']).allowed, false);
    assert.equal(guard.decideConnect(mode, [13316, '192.0.2.44']).allowed, false);
    assert.equal(guard.decideConnect(mode, [3188, '203.0.113.17']).allowed, false);
    assert.equal(guard.decideConnect(mode, [13316, '127.0.0.1.evil']).allowed, false);
    assert.equal(guard.decideConnect(mode, [{ port: 13316, host: 'localhost', path: '\\\\.\\pipe\\db' }]).allowed, false);
    assert.equal(guard.decideConnect(mode, [{ port: 13316, host: '127.0.0.1', path: undefined }]).allowed, true);
    assert.equal(guard.decideConnect(mode, [{ port: 13316, host: '127.0.0.1', path: null }]).allowed, true);
    assert.equal(guard.decideListen(mode, [{ port: 3188, path: undefined }]).allowed, true);
    assert.equal(guard.decideListen(mode, [{ port: 3188, path: null }]).allowed, true);
    assert.equal(guard.decideListen(mode, [{ port: 3188, path: '\\\\.\\pipe\\http' }]).allowed, false);
    assert.equal(guard.decideConnect(mode, [{ port: 13316, host: 'localhost', lookup() {} }]).allowed, false);
    assert.equal(guard.decideConnect(mode, [{ port: '13316junk', host: 'localhost' }]).allowed, false);
    assert.equal(guard.decideListen(mode, [3188, '0.0.0.0']).allowed, true);
    assert.deepEqual(guard.decideListen(mode, [13316, '127.0.0.1']), { allowed: false, reason: 'port' });
  }
});

test('hermetic connects require a server registered in this process', () => {
  const ports = new Set([41234]);
  assert.equal(guard.decideConnect('hermetic', [41234, '127.0.0.1'], ports).allowed, true);
  assert.equal(guard.decideConnect('hermetic', [3306, '127.0.0.1'], ports).allowed, false);
  assert.equal(guard.decideConnect('hermetic', [41234, '198.51.100.22'], ports).allowed, false);
  assert.equal(guard.decideConnect('hermetic', [41234, 'localhost'], ports).allowed, true);
  assert.equal(guard.decideListen('hermetic', [0, '0.0.0.0']).host, '127.0.0.1');
  assert.equal(guard.decideConnect('unknown-mode', [41234, '127.0.0.1'], ports).allowed, false);
  assert.equal(guard.decideListen('unknown-mode', [3188]).allowed, false);
});

test('installed hermetic guard binds loopback and registers only its own ephemeral listener', async (t) => {
  const installed = guard.installNetworkGuard({ mode: 'hermetic' });
  const server = net.createServer((socket) => socket.end('ok'));
  t.after(() => {
    installed.restore();
    if (server.listening) server.close();
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '0.0.0.0', resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  assert.equal(address.address, '127.0.0.1');
  assert.equal(installed.hermeticPorts.has(address.port), true);

  const reply = await new Promise<string>((resolve, reject) => {
    const socket = net.connect(address.port, '127.0.0.1');
    let value = '';
    socket.setEncoding('utf8');
    socket.on('data', (chunk) => { value += chunk; });
    socket.once('end', () => resolve(value));
    socket.once('error', reject);
  });
  assert.equal(reply, 'ok');

  await new Promise<void>((resolve) => server.close(resolve));
  assert.equal(installed.hermeticPorts.has(address.port), false);
});

test('HTTP request succeeds over a hermetic-preloaded loopback listener with path undefined', () => {
  const preload = fileURLToPath(new URL('../../scripts/m1-network-guard.cjs', import.meta.url));
  const script = [
    "const http = require('node:http');",
    "const server = http.createServer((_req, res) => res.end('ok'));",
    "server.listen(0, '0.0.0.0', () => {",
    "  const port = server.address().port;",
    "  http.get({ hostname: '127.0.0.1', port, path: undefined }, (res) => {",
    "    let body = ''; res.setEncoding('utf8'); res.on('data', (chunk) => body += chunk);",
    "    res.on('end', () => { server.close(() => { if (res.statusCode !== 200 || body !== 'ok') process.exitCode = 1; }); });",
    "  }).on('error', () => { server.close(() => { process.exitCode = 1; }); });",
    '});',
  ].join('\n');

  assert.equal(execFileSync(process.execPath, ['--require', preload, '-e', script], {
    encoding: 'utf8',
    timeout: 10_000,
    env: { ...process.env, M1_NETWORK_MODE: 'hermetic' },
  }), '');
});

test('blocked operations throw a stable code without including endpoint details', () => {
  const installed = guard.installNetworkGuard({ mode: 'isolated-test' });
  try {
    assert.throws(() => net.connect(3306, 'secret.example'), (error: NodeJS.ErrnoException) => {
      assert.equal(error.code, 'M1_NETWORK_BLOCKED');
      assert.equal(error.message.includes('secret.example'), false);
      return true;
    });
  } finally {
    installed.restore();
  }
});
