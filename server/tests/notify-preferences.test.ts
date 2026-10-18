/**
 * M6 P3 — per-user notification preferences (hermetic, no MySQL/network).
 *
 * Same leaf-fake strategy as m1-sprint-notification-support.test.ts: `dotenv`
 * and `mysql2/promise` are primed in the require cache BEFORE app modules
 * load, so the REAL src/db.ts, principal-repository and notifications router
 * run unmodified with real signed JWTs. An in-memory interpreter answers only
 * the predicates these routes emit.
 */
import { test } from 'node:test';
import { quietConsole, restoreConsole } from './helpers/quiet-console';

test.beforeEach(quietConsole);
test.afterEach(restoreConsole);
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { createServer, type Server } from 'node:http';
import express from 'express';
import jwt from 'jsonwebtoken';

process.env.JWT_SECRET ??= 'hermetic-test-jwt-secret-not-a-real-key';

const TEST_JWT_SECRET = process.env.JWT_SECRET!;

type Row = Record<string, unknown>;

interface FakeState {
  users: Row[];
  notifications: Row[];
  prefs: Row[];
  executed: { sql: string; params: unknown[] }[];
  failWith: Error | null;
}

const makeState = (): FakeState => ({
  users: [],
  notifications: [],
  prefs: [],
  executed: [],
  failWith: null,
});

let state: FakeState = makeState();

const isAuthLookup = (sql: string): boolean =>
  sql.includes('suspension_active') ||
  sql.includes('permission_key') ||
  sql.includes("role_code='super_admin'") ||
  sql.includes('FROM students') ||
  sql.includes('FROM tenant_memberships') ||
  sql.includes('FROM staff');

const runSelect = (sql: string, params: unknown[]): Row[] => {
  state.executed.push({ sql, params });
  if (!isAuthLookup(sql) && state.failWith) throw state.failWith;

  if (sql.includes('suspension_active')) {
    const user = state.users.find((u) => u.id === params[0]);
    return user
      ? [{ is_active: user.is_active, token_version: user.token_version ?? 0, suspension_active: 0 }]
      : [];
  }
  if (sql.includes('FROM students')) return [];

  if (sql.includes('FROM notification_preferences')) {
    const row = state.prefs.find((p) => p.user_id === params[0] && p.user_type === params[1]);
    return row ? [{ ...row }] : [];
  }

  if (sql.startsWith('SELECT COUNT(*)') && sql.includes('FROM notifications')) {
    const count = state.notifications.filter(
      (n) => n.user_id === params[0] && n.user_type === params[1] && !n.is_read,
    ).length;
    return [{ count }];
  }
  if (sql.includes('FROM notifications')) {
    let rows = state.notifications.filter((n) => n.user_id === params[0] && n.user_type === params[1]);
    if (sql.includes('AND is_read = ?')) {
      const wanted = Number(params[2]) === 1;
      rows = rows.filter((n) => Boolean(n.is_read) === wanted);
    }
    return [...rows].sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
  }

  throw new Error(`fake db: unhandled SELECT: ${sql}`);
};

const runWrite = (sql: string, params: unknown[]): { affectedRows: number; insertId: number } => {
  state.executed.push({ sql, params });
  if (state.failWith) throw state.failWith;

  if (sql.includes('INSERT INTO notification_preferences')) {
    const [userId, userType, inApp, email, whatsapp, sms] = params;
    const existing = state.prefs.find((p) => p.user_id === userId && p.user_type === userType);
    if (existing) {
      existing.in_app = inApp;
      existing.email = email;
      existing.whatsapp = whatsapp;
      existing.sms = sms;
    } else {
      state.prefs.push({
        user_id: userId, user_type: userType,
        in_app: inApp, email, whatsapp, sms,
      });
    }
    return { affectedRows: 1, insertId: 0 };
  }
  if (sql.includes('UPDATE notifications SET is_read = TRUE WHERE id = ?')) {
    const row = state.notifications.find(
      (n) => n.id === params[0] && n.user_id === params[1] && n.user_type === params[2],
    );
    if (!row) return { affectedRows: 0, insertId: 0 };
    row.is_read = 1;
    return { affectedRows: 1, insertId: 0 };
  }
  throw new Error(`fake db: unhandled WRITE: ${sql}`);
};

const seedModule = (request: string, exports: unknown) => {
  const id = require.resolve(request);
  require.cache[id] = {
    id, filename: id, loaded: true, children: [], paths: [], exports,
  } as unknown as NodeModule;
};

const fakePool = {
  execute: async (sql: string, params?: unknown[]) => {
    if (sql.trimStart().toUpperCase().startsWith('SELECT')) {
      return [runSelect(sql, params ?? []), []] as const;
    }
    return [runWrite(sql, params ?? []), []] as const;
  },
  query: async (sql: string, params?: unknown[]) => [runSelect(sql, params ?? []), []] as const,
  getConnection: async () => fakePool,
  release: () => undefined,
  end: async () => undefined,
};

seedModule('dotenv', { config: () => ({ parsed: {} }) });
seedModule('mysql2/promise', {
  createPool: () => fakePool,
  createConnection: async () => fakePool,
});

const notificationsRouter = require('../src/routes/notifications').default as import('express').Router;
const prefsService = require('../src/services/notification-preferences') as typeof import('../src/services/notification-preferences');

interface Harness {
  base: string;
  close: () => Promise<void>;
}

const harness = async (): Promise<Harness> => {
  const app = express();
  app.use(express.json());
  app.use('/api/notifications', notificationsRouter);
  const server: Server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    base: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.closeAllConnections?.();
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
};

interface ApiResult {
  status: number;
  body: string | null;
}

const api = async (
  h: Harness, method: string, path: string, token: string | null, body?: unknown,
): Promise<ApiResult> => {
  const res = await fetch(`${h.base}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
};

const sign = (user: { id: string; role: string }) =>
  jwt.sign({ id: user.id, role: user.role, tv: 0 }, TEST_JWT_SECRET);

const userA = { id: 'user-a', role: 'student' };
const userB = { id: 'user-b', role: 'student' };
const parentU = { id: 'parent-1', role: 'parent' };

const seedBase = () => {
  for (const id of ['user-a', 'user-b', 'parent-1']) {
    state.users.push({ id, name: `name-${id}`, is_active: 1, token_version: 0 });
  }
  state.notifications.push(
    { id: 'note-a-1', user_id: 'user-a', user_type: 'student', title: 'A1', is_read: 0, created_at: '2026-10-16T09:00:00Z' },
    { id: 'note-b-1', user_id: 'user-b', user_type: 'student', title: 'B1', is_read: 0, created_at: '2026-10-16T09:30:00Z' },
  );
};

const withState = async <T>(seed: () => void, fn: (h: Harness) => Promise<T>): Promise<T> => {
  state = makeState();
  seed();
  const h = await harness();
  try {
    return await fn(h);
  } finally {
    await h.close();
  }
};

// --- pure service unit checks (no DB) ---

test('quiet defaults: in-app on, email/whatsapp/sms off; unknown channel denies', () => {
  const d = prefsService.defaultPreferences();
  assert.deepEqual(d, { in_app: true, email: false, whatsapp: false, sms: false });
  assert.equal(prefsService.canDeliver(null, 'in_app'), true);
  assert.equal(prefsService.canDeliver(null, 'email'), false);
  assert.equal(prefsService.canDeliver(null, 'whatsapp'), false);
  assert.equal(prefsService.canDeliver(null, 'sms'), false);
  assert.equal(prefsService.canDeliver(d, 'bogus'), false);
});

test('opt-out is honoured by the delivery gate even when defaults allow', () => {
  assert.equal(
    prefsService.canDeliver({ in_app: false, email: false, whatsapp: false, sms: false }, 'in_app'),
    false,
  );
  assert.equal(
    prefsService.canDeliver({ in_app: true, email: true, whatsapp: false, sms: false }, 'email'),
    true,
  );
  assert.equal(
    prefsService.canDeliver({ in_app: true, email: false, whatsapp: false, sms: false }, 'email'),
    false,
  );
});

test('input validation rejects non-boolean, unknown, and empty bodies', () => {
  assert.equal(prefsService.parsePreferencesInput({ email: 1 }).ok, false);
  assert.equal(prefsService.parsePreferencesInput({ email: 'true' }).ok, false);
  assert.equal(prefsService.parsePreferencesInput({ email: [true] }).ok, false);
  assert.equal(prefsService.parsePreferencesInput({ push: true }).ok, false);
  assert.equal(prefsService.parsePreferencesInput({}).ok, false);
  assert.equal(prefsService.parsePreferencesInput(null).ok, false);
  assert.equal(prefsService.parsePreferencesInput([]).ok, false);
  const good = prefsService.parsePreferencesInput({ email: true, sms: false });
  assert.equal(good.ok, true);
  if (good.ok) assert.deepEqual(good.value, { email: true, sms: false });
});

// --- route checks ---

test('GET preferences returns quiet defaults when no row exists', async () => {
  await withState(seedBase, async (h) => {
    const res = await api(h, 'GET', '/api/notifications/preferences', sign(userA));
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { in_app: true, email: false, whatsapp: false, sms: false });
  });
});

test('PUT preferences persists a partial opt-in and GET returns the merge', async () => {
  await withState(seedBase, async (h) => {
    const put = await api(h, 'PUT', '/api/notifications/preferences', sign(userA), { whatsapp: true });
    assert.equal(put.status, 200);
    assert.deepEqual(put.body, { in_app: true, email: false, whatsapp: true, sms: false });

    const get = await api(h, 'GET', '/api/notifications/preferences', sign(userA));
    assert.equal(get.status, 200);
    assert.deepEqual(get.body, { in_app: true, email: false, whatsapp: true, sms: false });

    // Other user's namespace row untouched (still defaults).
    const other = await api(h, 'GET', '/api/notifications/preferences', sign(userB));
    assert.deepEqual(other.body, { in_app: true, email: false, whatsapp: false, sms: false });
  });
});

test('PUT preferences rejects invalid input without writing', async () => {
  await withState(seedBase, async (h) => {
    assert.equal((await api(h, 'PUT', '/api/notifications/preferences', sign(userA), { email: 1 })).status, 400);
    assert.equal((await api(h, 'PUT', '/api/notifications/preferences', sign(userA), { email: 'true' })).status, 400);
    assert.equal((await api(h, 'PUT', '/api/notifications/preferences', sign(userA), { push: true })).status, 400);
    assert.equal((await api(h, 'PUT', '/api/notifications/preferences', sign(userA), {})).status, 400);
    assert.equal(state.prefs.length, 0);
  });
});

test('in-app opt-out suppresses the feed and unread count server-side', async () => {
  await withState(seedBase, async (h) => {
    const put = await api(h, 'PUT', '/api/notifications/preferences', sign(userA), { in_app: false });
    assert.equal(put.status, 200);

    state.executed.length = 0;
    const list = await api(h, 'GET', '/api/notifications', sign(userA));
    assert.equal(list.status, 200);
    assert.deepEqual(list.body, []);
    assert.equal(
      state.executed.some((e) => e.sql.includes('FROM notifications') && e.sql.includes('ORDER BY')),
      false,
      'opted-out feed must not reach the notifications table scan',
    );

    const count = await api(h, 'GET', '/api/notifications/unread-count', sign(userA));
    assert.equal(count.status, 200);
    assert.deepEqual(count.body, { count: 0 });

    // The other user stays unaffected.
    const otherList = await api(h, 'GET', '/api/notifications', sign(userB));
    assert.deepEqual(otherList.body.map((n: Row) => n.id), ['note-b-1']);
  });
});

test('preferences are namespaced by server role: parent accounts are ineligible', async () => {
  await withState(seedBase, async (h) => {
    // Rejected either by the auth layer (401) or the namespace gate (403); never served.
    const denied = [401, 403];
    assert.ok(denied.includes((await api(h, 'GET', '/api/notifications/preferences', sign(parentU))).status));
    assert.ok(
      denied.includes((await api(h, 'PUT', '/api/notifications/preferences', sign(parentU), { email: true })).status),
    );
    assert.equal(state.prefs.length, 0);
  });
});

test('preferences reject unauthenticated callers before touching data', async () => {
  await withState(seedBase, async (h) => {
    assert.equal((await api(h, 'GET', '/api/notifications/preferences', null)).status, 401);
    assert.equal((await api(h, 'PUT', '/api/notifications/preferences', null, { email: true })).status, 401);
    assert.equal(state.executed.length, 0);
  });
});

test('preferences surface a storage failure as 500', async () => {
  await withState(seedBase, async (h) => {
    state.failWith = new Error('simulated db outage');
    assert.equal((await api(h, 'GET', '/api/notifications/preferences', sign(userA))).status, 500);
    assert.equal(
      (await api(h, 'PUT', '/api/notifications/preferences', sign(userA), { email: true })).status,
      500,
    );
  });
});
