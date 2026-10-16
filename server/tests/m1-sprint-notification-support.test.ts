/**
 * M1 sprint regressions — notifications and support ticket access boundaries
 * (hermetic: no MySQL, no network, no real env keys, no Docker).
 *
 * Strategy: the leaf primitives `dotenv` and `mysql2/promise` are replaced in
 * the require cache BEFORE any application module loads, so the REAL
 * src/db.ts (with a pool that never connects), the real principal-repository,
 * the real admin-permissions checks and the REAL route handlers all run
 * unmodified. Callers authenticate with real signed JWTs through the real
 * authenticateToken middleware; every SQL statement is answered by an
 * in-memory interpreter that mirrors the emitted predicates. No pool is ever
 * connected, no .env file is read, and no external service is contacted.
 *
 * The SQL interpreter mirrors semantics only well enough for these routes
 * (owner-scoped filters, permission lookups, affectedRows). It is not a
 * database emulator; the point is to prove the production authorization,
 * ownership, input-bound and failure-handling decisions, not a MySQL engine.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { createServer, type Server } from 'node:http';
import express from 'express';
import jwt from 'jsonwebtoken';

process.env.JWT_SECRET ??= 'hermetic-test-jwt-secret-not-a-real-key';

const TEST_JWT_SECRET = process.env.JWT_SECRET!;

// ---------------------------------------------------------------------------
// Hermetic leaf fakes: `dotenv` (no .env read) and `mysql2/promise` (a pool
// that never connects). With these two primed in the require cache, the REAL
// src/db.ts, principal-repository, admin-permissions and route modules load
// and run unmodified; every SQL statement is answered by the in-memory
// interpreter below. No MySQL server, no network, no .env file is touched.
// ---------------------------------------------------------------------------

type Row = Record<string, unknown>;

interface FakeState {
  users: Row[];
  notifications: Row[];
  tickets: Row[];
  replies: Row[];
  /** Active platform permission grants (admin_role_permissions view). */
  permissions: Record<string, string[]>;
  /** super_admin role holders (admin_user_roles). */
  superAdmins: Set<string>;
  executed: { sql: string; params: unknown[] }[];
  failWith: Error | null;
}

const makeState = (): FakeState => ({
  users: [],
  notifications: [],
  tickets: [],
  replies: [],
  permissions: {},
  superAdmins: new Set<string>(),
  executed: [],
  failWith: null,
});

let state: FakeState = makeState();

const limitOf = (sql: string): number => {
  const match = /LIMIT (\d+)/.exec(sql);
  return match ? Number(match[1]) : Number.POSITIVE_INFINITY;
};

const interpolateLimit = (rows: Row[], sql: string): Row[] => rows.slice(0, limitOf(sql));

const runSelect = (sql: string, params: unknown[]): Row[] => {
  state.executed.push({ sql, params });
  if (!isAuthLookup(sql) && state.failWith) throw state.failWith;

  // --- auth / permission lookups -----------------------------------------
  if (sql.includes('permission_key')) {
    return (state.permissions[String(params[0])] ?? []).map((key) => ({ permission_key: key }));
  }
  if (sql.includes("role_code='super_admin'")) {
    return state.superAdmins.has(String(params[0])) ? [{ user_id: params[0] }] : [];
  }
  if (sql.includes('suspension_active')) {
    const user = state.users.find((u) => u.id === params[0]);
    return user
      ? [{ is_active: user.is_active, token_version: user.token_version ?? 0, suspension_active: 0 }]
      : [];
  }
  if (sql.includes('FROM students')) return [];

  // --- notifications -------------------------------------------------------
  // No stored preference row: the route falls back to quiet defaults.
  if (sql.includes('FROM notification_preferences')) return [];
  // Production binds the server-derived principal namespace (user_type) on
  // every owner-scoped predicate: params are [userId, user_type] plus the
  // optional is_read flag. The interpreter mirrors that shape so the real
  // authorization decision is exercised, not a legacy user_id-only filter.
  if (sql.startsWith('SELECT COUNT(*)') && sql.includes('FROM notifications')) {
    const userId = String(params[0]);
    const userType = String(params[1]);
    const count = state.notifications.filter((n) => n.user_id === userId && n.user_type === userType && !n.is_read).length;
    return [{ count }];
  }
  if (sql.includes('FROM notifications') && sql.includes('ORDER BY created_at DESC')) {
    const userId = String(params[0]);
    const userType = String(params[1]);
    let rows = state.notifications.filter((n) => n.user_id === userId && n.user_type === userType);
    if (sql.includes('AND is_read = ?')) {
      const wanted = Number(params[2]) === 1;
      rows = rows.filter((n) => Boolean(n.is_read) === wanted);
    }
    rows = [...rows].sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
    return interpolateLimit(rows, sql);
  }

  // --- support tickets ------------------------------------------------------
  if (sql.includes('user_id, status FROM support_tickets WHERE id')) {
    const ticket = state.tickets.find((t) => t.id === params[0]);
    return ticket ? [{ id: ticket.id, ticket_number: ticket.ticket_number, user_id: ticket.user_id, status: ticket.status }] : [];
  }
  if (sql.includes('SELECT * FROM support_tickets WHERE id')) {
    const ticket = state.tickets.find((t) => t.id === params[0]);
    return ticket ? [{ ...ticket }] : [];
  }
  if (sql.includes('SELECT id, ticket_number, category, subject, status, priority, created_at, updated_at')) {
    // GET /mine
    const userId = String(params[0]);
    const rows = state.tickets
      .filter((t) => t.user_id === userId)
      .sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at)));
    return interpolateLimit(rows, sql);
  }
  if (sql.includes('u.phone AS user_phone')) {
    // ticket detail projection (WHERE t.id = ?) or the admin queue listing
    if (sql.includes('WHERE t.id = ?')) {
      const ticket = state.tickets.find((t) => t.id === params[0]);
      if (!ticket) return [];
      const owner = state.users.find((u) => u.id === ticket.user_id);
      return [{ ...ticket, user_name: owner?.name ?? null, user_phone: owner?.phone ?? null }];
    }
    const rows = state.tickets.map((t) => {
      const owner = state.users.find((u) => u.id === t.user_id);
      return { ...t, user_name: owner?.name ?? null, user_phone: owner?.phone ?? null };
    });
    const limit = limitOf(sql);
    return rows.slice(0, limit);
  }

  // --- support ticket replies ------------------------------------------------
  if (sql.includes('FROM support_ticket_replies')) {
    if (sql.includes('WHERE r.id = ?')) {
      const reply = state.replies.find((r) => r.id === params[0]);
      if (!reply) return [];
      const sender = state.users.find((u) => u.id === reply.sender_id);
      return [{ ...reply, sender_name: sender?.name ?? null, sender_role: sender?.role ?? null }];
    }
    const ticketId = String(params[0]);
    return state.replies
      .filter((r) => r.ticket_id === ticketId)
      .map((r): Row => {
        const sender = state.users.find((u) => u.id === r.sender_id);
        return { ...r, sender_name: sender?.name ?? null, sender_role: sender?.role ?? null };
      })
      .sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)));
  }

  throw new Error(`fake db: unhandled SELECT: ${sql}`);
};

// Identity/permission/workspace lookups stay answerable while a data outage
// is simulated, so failures surface at the handler (500) and not at
// authentication (401).
const isAuthLookup = (sql: string): boolean =>
  sql.includes('suspension_active') ||
  sql.includes('permission_key') ||
  sql.includes("role_code='super_admin'") ||
  sql.includes('FROM students') ||
  sql.includes('FROM tenant_memberships') ||
  sql.includes('FROM staff');

const runWrite = (sql: string, params: unknown[]): { affectedRows: number; insertId: number } => {
  state.executed.push({ sql, params });
  if (state.failWith) throw state.failWith;

  if (sql.includes('UPDATE notifications SET is_read = TRUE WHERE id = ? AND user_id = ?')) {
    const [id, userId, userType] = params;
    const row = state.notifications.find((n) => n.id === id && n.user_id === userId && n.user_type === userType);
    if (!row) return { affectedRows: 0, insertId: 0 };
    row.is_read = 1;
    return { affectedRows: 1, insertId: 0 };
  }
  if (sql.includes('UPDATE notifications SET is_read = TRUE WHERE user_id = ?')) {
    const userId = String(params[0]);
    const userType = String(params[1]);
    let affected = 0;
    for (const row of state.notifications) {
      if (row.user_id === userId && row.user_type === userType && !row.is_read) {
        row.is_read = 1;
        affected += 1;
      }
    }
    return { affectedRows: affected, insertId: 0 };
  }
  if (sql.includes('INSERT INTO support_tickets')) {
    const [id, number, userId, category, subject, description] = params;
    state.tickets.push({
      id,
      ticket_number: number,
      user_id: userId,
      category,
      subject,
      description,
      status: 'open',
      priority: 'normal',
      assigned_to: null,
      resolved_at: null,
      closed_at: null,
      created_at: '2026-10-16T10:00:00Z',
      updated_at: '2026-10-16T10:00:00Z',
    });
    return { affectedRows: 1, insertId: 0 };
  }
  if (sql.includes('INSERT INTO support_ticket_replies')) {
    const [id, ticketId, senderId, body] = params;
    state.replies.push({
      id,
      ticket_id: ticketId,
      sender_id: senderId,
      body,
      created_at: `2026-10-16T11:00:${String(state.replies.length).padStart(2, '0')}Z`,
    });
    return { affectedRows: 1, insertId: 0 };
  }
  if (/UPDATE support_tickets\s+SET status = \?,\s+resolved_at = CASE/.test(sql)) {
    // PATCH /:id/status — params [status, status, status, id]
    const ticket = state.tickets.find((t) => t.id === params[3]);
    if (!ticket) return { affectedRows: 0, insertId: 0 };
    ticket.status = params[0];
    if (params[0] === 'resolved') ticket.resolved_at = '2026-10-16T12:00:00Z';
    if (params[0] === 'closed') ticket.closed_at = '2026-10-16T12:00:00Z';
    return { affectedRows: 1, insertId: 0 };
  }
  if (/UPDATE support_tickets\s+SET status = \?, updated_at/.test(sql)) {
    // reply side-effect — params [status, id]
    const ticket = state.tickets.find((t) => t.id === params[1]);
    if (!ticket) return { affectedRows: 0, insertId: 0 };
    ticket.status = params[0];
    return { affectedRows: 1, insertId: 0 };
  }
  throw new Error(`fake db: unhandled WRITE: ${sql}`);
};

// The only two primitives faked: a dotenv that reads nothing and a mysql2
// pool that never connects.
const seedModule = (request: string, exports: unknown) => {
  const id = require.resolve(request);
  require.cache[id] = {
    id,
    filename: id,
    loaded: true,
    children: [],
    paths: [],
    exports,
  } as unknown as NodeModule;
};

const fakePool = {
  execute: async (sql: string, params?: unknown[]) => {
    if (sql.trimStart().toUpperCase().startsWith('SELECT')) {
      return [runSelect(sql, params ?? []), []] as const;
    }
    return [runWrite(sql, params ?? []), []] as const;
  },
  query: async (sql: string, params?: unknown[]) =>
    [runSelect(sql, params ?? []), []] as const,
  getConnection: async () => fakePool,
  release: () => undefined,
  end: async () => undefined,
};

seedModule('dotenv', { config: () => ({ parsed: {} }) });
seedModule('mysql2/promise', {
  createPool: () => fakePool,
  createConnection: async () => fakePool,
});

// Real db.ts / routes / auth / permission modules — loaded only AFTER the
// leaf fakes are in place.
const notificationsRouter = require('../src/routes/notifications').default as import('express').Router;
const supportRouter = require('../src/routes/support-tickets').default as import('express').Router;

// ---------------------------------------------------------------------------
// Hermetic HTTP harness: real express app, real routers, real JWT auth
// ---------------------------------------------------------------------------

interface Harness {
  base: string;
  close: () => Promise<void>;
}

const harness = async (): Promise<Harness> => {
  const app = express();
  app.use(express.json());
  app.use('/api/notifications', notificationsRouter);
  app.use('/api/support-tickets', supportRouter);
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
  body: any;
}

const api = async (
  h: Harness,
  method: string,
  path: string,
  token: string | null,
  body?: unknown,
): Promise<ApiResult> => {
  const res = await fetch(`${h.base}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
};

const sign = (user: { id: string; role: string }) =>
  jwt.sign({ id: user.id, role: user.role, tv: 0 }, TEST_JWT_SECRET);

const userA = { id: 'user-a', role: 'student' };
const userB = { id: 'user-b', role: 'student' };
const supportAdmin = { id: 'admin-support', role: 'admin' };
const superAdmin = { id: 'super-1', role: 'admin' };

const seedIdentity = (id: string, active = true) => {
  state.users.push({ id, name: `name-${id}`, phone: `+20100${id.slice(-3)}`, role: 'user', is_active: active ? 1 : 0, token_version: 0 });
};

const seedNotifications = () => {
  seedIdentity('user-a');
  seedIdentity('user-b');
  state.notifications.push(
    { id: 'note-a-1', user_id: 'user-a', user_type: 'student', title: 'A1', message: 'm', type: 'general', link: null, is_read: 0, created_at: '2026-10-16T09:00:00Z' },
    { id: 'note-a-2', user_id: 'user-a', user_type: 'student', title: 'A2', message: 'm', type: 'general', link: null, is_read: 1, created_at: '2026-10-16T08:00:00Z' },
    { id: 'note-b-1', user_id: 'user-b', user_type: 'student', title: 'B1', message: 'm', type: 'general', link: null, is_read: 0, created_at: '2026-10-16T09:30:00Z' },
  );
};

const seedTickets = () => {
  seedIdentity('user-a');
  seedIdentity('user-b');
  seedIdentity('admin-support');
  seedIdentity('super-1');
  state.permissions['admin-support'] = ['support.read'];
  state.tickets.push(
    {
      id: 'ticket-a', ticket_number: 'SUP-202610-A', user_id: 'user-a', category: 'technical',
      subject: 'A problem', description: 'long enough description', status: 'open', priority: 'normal',
      assigned_to: null, resolved_at: null, closed_at: null,
      created_at: '2026-10-15T10:00:00Z', updated_at: '2026-10-15T10:00:00Z',
    },
    {
      id: 'ticket-b', ticket_number: 'SUP-202610-B', user_id: 'user-b', category: 'billing',
      subject: 'B problem', description: 'long enough description', status: 'closed', priority: 'normal',
      assigned_to: null, resolved_at: null, closed_at: '2026-10-15T12:00:00Z',
      created_at: '2026-10-14T10:00:00Z', updated_at: '2026-10-15T12:00:00Z',
    },
  );
  state.replies.push(
    { id: 'reply-a-1', ticket_id: 'ticket-a', sender_id: 'user-a', body: 'first', created_at: '2026-10-15T10:30:00Z' },
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

// ---------------------------------------------------------------------------
// Notifications
// ---------------------------------------------------------------------------

test('notifications list returns only the caller\'s rows (cross-user rows never leak)', async () => {
  await withState(seedNotifications, async (h) => {
    const res = await api(h, 'GET', '/api/notifications', sign(userA));
    assert.equal(res.status, 200);
    assert.deepEqual(
      res.body.map((n: Row) => n.id).sort(),
      ['note-a-1', 'note-a-2'],
    );
    const listSql = state.executed.find((e) => e.sql.includes('FROM notifications'));
    assert.match(listSql!.sql, /user_id = \?/);
    assert.match(listSql!.sql, /user_type = \?/);
    assert.deepEqual(listSql!.params, ['user-a', 'student']);
  });
});

test('notifications list rejects an unparseable is_read filter instead of coercing it', async () => {
  await withState(seedNotifications, async (h) => {
    const res = await api(h, 'GET', '/api/notifications?is_read=maybe', sign(userA));
    assert.equal(res.status, 400);
    assert.match(res.body.error, /is_read/);
  });
});

test('notifications list rejects repeated is_read parameters (400, not coercion)', async () => {
  await withState(seedNotifications, async (h) => {
    const res = await api(h, 'GET', '/api/notifications?is_read=true&is_read=false', sign(userA));
    assert.equal(res.status, 400);
  });
});

test('notifications list is bounded: default 50, hard cap 100, invalid limits rejected', async () => {
  await withState(seedNotifications, async (h) => {
    const none = await api(h, 'GET', '/api/notifications', sign(userA));
    assert.equal(none.status, 200);
    assert.match(state.executed.at(-1)!.sql, /LIMIT 50\b/);

    const huge = await api(h, 'GET', '/api/notifications?limit=99999', sign(userA));
    assert.equal(huge.status, 200);
    assert.match(state.executed.at(-1)!.sql, /LIMIT 100\b/);

    assert.equal((await api(h, 'GET', '/api/notifications?limit=0', sign(userA))).status, 400);
    assert.equal((await api(h, 'GET', '/api/notifications?limit=abc', sign(userA))).status, 400);
    assert.equal((await api(h, 'GET', '/api/notifications?limit=-5', sign(userA))).status, 400);
    assert.equal((await api(h, 'GET', '/api/notifications?limit=2.5', sign(userA))).status, 400);
  });
});

test('notifications is_read=true filters to read rows only', async () => {
  await withState(seedNotifications, async (h) => {
    const res = await api(h, 'GET', '/api/notifications?is_read=true', sign(userA));
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.map((n: Row) => n.id), ['note-a-2']);
  });
});

test('notifications is_read=false filters to unread rows only (and never the other user\'s)', async () => {
  await withState(seedNotifications, async (h) => {
    const res = await api(h, 'GET', '/api/notifications?is_read=false', sign(userA));
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.map((n: Row) => n.id), ['note-a-1']);
    const listSql = state.executed.find((e) => e.sql.includes('FROM notifications') && e.sql.includes('AND is_read = ?'))!;
    assert.deepEqual(listSql.params, ['user-a', 'student', 0]);
  });
});

test('mark-as-read succeeds for the owner and persists is_read', async () => {
  await withState(seedNotifications, async (h) => {
    const res = await api(h, 'PUT', '/api/notifications/note-a-1/read', sign(userA));
    assert.equal(res.status, 200);
    const row = state.notifications.find((n) => n.id === 'note-a-1')!;
    assert.equal(row.is_read, 1);
  });
});

test('mark-as-read of another user\'s notification fails closed with 404 and no mutation', async () => {
  await withState(seedNotifications, async (h) => {
    const res = await api(h, 'PUT', '/api/notifications/note-b-1/read', sign(userA));
    assert.equal(res.status, 404);
    assert.equal(state.notifications.find((n) => n.id === 'note-b-1')!.is_read, 0);
  });
});

test('mark-as-read of an unknown id fails closed with 404 (no false success)', async () => {
  await withState(seedNotifications, async (h) => {
    const res = await api(h, 'PUT', '/api/notifications/does-not-exist/read', sign(userA));
    assert.equal(res.status, 404);
    assert.equal(state.notifications.filter((n) => n.is_read).length, 1); // only the pre-read row
  });
});

test('mark-as-read is idempotent for an already-read notification the caller owns', async () => {
  await withState(seedNotifications, async (h) => {
    // note-a-2 belongs to user-a and is already read. Because mysql2 connects
    // with FOUND_ROWS (affectedRows = matched rows), an owner re-marking it
    // must succeed instead of being misreported as missing.
    const res = await api(h, 'PUT', '/api/notifications/note-a-2/read', sign(userA));
    assert.equal(res.status, 200);
    assert.equal(state.notifications.find((n) => n.id === 'note-a-2')!.is_read, 1);
  });
});

test('mark-all-as-read touches only the caller\'s rows', async () => {
  await withState(seedNotifications, async (h) => {
    const res = await api(h, 'PUT', '/api/notifications/read-all', sign(userA));
    assert.equal(res.status, 200);
    assert.equal(state.notifications.find((n) => n.id === 'note-a-1')!.is_read, 1);
    assert.equal(state.notifications.find((n) => n.id === 'note-b-1')!.is_read, 0);
    const sql = state.executed.find((e) => e.sql.includes('WHERE user_id = ?'))!;
    assert.deepEqual(sql.params, ['user-a', 'student']);
  });
});

test('unread-count counts only the caller\'s unread rows', async () => {
  await withState(seedNotifications, async (h) => {
    const res = await api(h, 'GET', '/api/notifications/unread-count', sign(userA));
    assert.equal(res.status, 200);
    assert.equal(res.body.count, 1);
  });
});

test('notifications reject unauthenticated callers before touching data', async () => {
  await withState(seedNotifications, async (h) => {
    assert.equal((await api(h, 'GET', '/api/notifications', null)).status, 401);
    assert.equal((await api(h, 'PUT', '/api/notifications/note-a-1/read', null)).status, 401);
    assert.equal((await api(h, 'GET', '/api/notifications/unread-count', null)).status, 401);
    assert.equal(state.executed.length, 0);
  });
});

test('notifications surface a storage failure as 500, never as success', async () => {
  await withState(seedNotifications, async (h) => {
    state.failWith = new Error('simulated db outage');
    const read = await api(h, 'PUT', '/api/notifications/note-a-1/read', sign(userA));
    assert.equal(read.status, 500);
    const list = await api(h, 'GET', '/api/notifications', sign(userA));
    assert.equal(list.status, 500);
    const count = await api(h, 'GET', '/api/notifications/unread-count', sign(userA));
    assert.equal(count.status, 500);
  });
});

// ---------------------------------------------------------------------------
// Support tickets — creation and ownership
// ---------------------------------------------------------------------------

test('ticket creation ignores a client-supplied owner and binds the authenticated caller', async () => {
  await withState(seedTickets, async (h) => {
    const res = await api(h, 'POST', '/api/support-tickets', sign(userA), {
      category: 'technical',
      subject: 'Valid subject',
      description: 'A description long enough to pass validation.',
      user_id: 'admin-support', // must be ignored
    });
    assert.equal(res.status, 201);
    const insert = state.executed.find((e) => e.sql.includes('INSERT INTO support_tickets'))!;
    assert.equal(insert.params[2], 'user-a', 'owner must come from the verified principal');
    assert.equal(state.tickets.at(-1)!.user_id, 'user-a');
  });
});

test('ticket creation enforces category and length bounds', async () => {
  await withState(seedTickets, async (h) => {
    const base = { subject: 'Valid subject', description: 'A description long enough to pass validation.' };
    assert.equal((await api(h, 'POST', '/api/support-tickets', sign(userA), { ...base, category: 'nope' })).status, 400);
    assert.equal((await api(h, 'POST', '/api/support-tickets', sign(userA), { ...base, category: 'technical', subject: 'ab' })).status, 400);
    assert.equal((await api(h, 'POST', '/api/support-tickets', sign(userA), { ...base, category: 'technical', subject: 'x'.repeat(201) })).status, 400);
    assert.equal((await api(h, 'POST', '/api/support-tickets', sign(userA), { ...base, category: 'technical', description: 'short' })).status, 400);
  });
});

test('mine lists only the caller\'s tickets', async () => {
  await withState(seedTickets, async (h) => {
    const res = await api(h, 'GET', '/api/support-tickets/mine', sign(userA));
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.map((t: Row) => t.id), ['ticket-a']);
  });
});

test('mine rejects an invalid limit and caps an oversized one', async () => {
  await withState(seedTickets, async (h) => {
    assert.equal((await api(h, 'GET', '/api/support-tickets/mine?limit=nope', sign(userA))).status, 400);
    const capped = await api(h, 'GET', '/api/support-tickets/mine?limit=5000', sign(userA));
    assert.equal(capped.status, 200);
    assert.match(state.executed.at(-1)!.sql, /LIMIT 100\b/);
  });
});

test('support ticket routes reject unauthenticated callers before touching data', async () => {
  await withState(seedTickets, async (h) => {
    assert.equal((await api(h, 'GET', '/api/support-tickets', null)).status, 401);
    assert.equal((await api(h, 'GET', '/api/support-tickets/mine', null)).status, 401);
    assert.equal((await api(h, 'GET', '/api/support-tickets/ticket-a', null)).status, 401);
    assert.equal(
      (await api(h, 'POST', '/api/support-tickets/ticket-a/replies', null, { body: 'hello' })).status,
      401,
    );
    assert.equal(
      (await api(h, 'PATCH', '/api/support-tickets/ticket-a/status', null, { status: 'resolved' })).status,
      401,
    );
    assert.equal(state.executed.length, 0);
  });
});

// ---------------------------------------------------------------------------
// Support tickets — cross-user isolation
// ---------------------------------------------------------------------------

test('ticket detail is readable by its owner and 404 for any other user', async () => {
  await withState(seedTickets, async (h) => {
    const owner = await api(h, 'GET', '/api/support-tickets/ticket-a', sign(userA));
    assert.equal(owner.status, 200);
    assert.equal(owner.body.ticket.id, 'ticket-a');
    assert.equal(owner.body.replies.length, 1);

    const stranger = await api(h, 'GET', '/api/support-tickets/ticket-a', sign(userB));
    assert.equal(stranger.status, 404);
    assert.equal(
      state.executed.filter((e) => e.sql.includes('u.phone AS user_phone') && e.params[0] === 'ticket-a').length,
      1,
      'a rejected caller must not reach the PII-projection query',
    );
  });
});

test('ticket detail returns 404 for an unknown id', async () => {
  await withState(seedTickets, async (h) => {
    const res = await api(h, 'GET', '/api/support-tickets/nope', sign(userA));
    assert.equal(res.status, 404);
  });
});

test('a non-privileged user cannot reply to another user\'s ticket', async () => {
  await withState(seedTickets, async (h) => {
    const res = await api(h, 'POST', '/api/support-tickets/ticket-a/replies', sign(userB), { body: 'let me in' });
    assert.equal(res.status, 404);
    assert.equal(state.replies.length, 1);
  });
});

test('owner replies flip status to waiting_on_support; admin replies to waiting_on_user', async () => {
  await withState(seedTickets, async (h) => {
    const owner = await api(h, 'POST', '/api/support-tickets/ticket-a/replies', sign(userA), { body: 'still broken' });
    assert.equal(owner.status, 201);
    assert.equal(state.tickets.find((t) => t.id === 'ticket-a')!.status, 'waiting_on_support');

    const admin = await api(h, 'POST', '/api/support-tickets/ticket-a/replies', sign(supportAdmin), { body: 'we are on it' });
    assert.equal(admin.status, 201);
    assert.equal(state.tickets.find((t) => t.id === 'ticket-a')!.status, 'waiting_on_user');
  });
});

test('closed tickets reject new replies (409) and reply bodies are length-bounded', async () => {
  await withState(seedTickets, async (h) => {
    const closed = await api(h, 'POST', '/api/support-tickets/ticket-b/replies', sign(userB), { body: 'one more thing' });
    assert.equal(closed.status, 409);
    const empty = await api(h, 'POST', '/api/support-tickets/ticket-a/replies', sign(userA), { body: '   ' });
    assert.equal(empty.status, 400);
    const tooLong = await api(h, 'POST', '/api/support-tickets/ticket-a/replies', sign(userA), { body: 'x'.repeat(10001) });
    assert.equal(tooLong.status, 400);
    assert.equal(state.replies.length, 1);
  });
});

// ---------------------------------------------------------------------------
// Support tickets — administrative capability boundaries
// ---------------------------------------------------------------------------

test('the support queue denies users without the verified support.read capability', async () => {
  await withState(seedTickets, async (h) => {
    const res = await api(h, 'GET', '/api/support-tickets', sign(userA));
    assert.equal(res.status, 403);
    assert.equal(
      state.executed.some((e) => e.sql.includes('u.phone AS user_phone')),
      false,
      'a denied caller must not reach the queue projection',
    );
  });
});

test('the support queue serves a verified support.read holder', async () => {
  await withState(seedTickets, async (h) => {
    const res = await api(h, 'GET', '/api/support-tickets', sign(supportAdmin));
    assert.equal(res.status, 200);
    assert.equal(res.body.length, 2);
    assert.ok(res.body.every((t: Row) => 'user_name' in t && 'user_phone' in t));
  });
});

test('a verified support admin can read and act on any user\'s ticket', async () => {
  await withState(seedTickets, async (h) => {
    const detail = await api(h, 'GET', '/api/support-tickets/ticket-a', sign(supportAdmin));
    assert.equal(detail.status, 200);

    const reopened = await api(h, 'PATCH', '/api/support-tickets/ticket-a/status', sign(supportAdmin), { status: 'waiting_on_user' });
    assert.equal(reopened.status, 200);
    assert.equal(state.tickets.find((t) => t.id === 'ticket-a')!.status, 'waiting_on_user');
  });
});

test('an active super_admin without a mapped permission key still carries the platform capability', async () => {
  await withState(seedTickets, async (h) => {
    state.superAdmins.add('super-1');
    const detail = await api(h, 'GET', '/api/support-tickets/ticket-a', sign(superAdmin));
    assert.equal(detail.status, 200);
    const res = await api(h, 'PATCH', '/api/support-tickets/ticket-a/status', sign(superAdmin), { status: 'open' });
    assert.equal(res.status, 200);
  });
});

test('owners may resolve or close their own tickets but never an administrative status', async () => {
  await withState(seedTickets, async (h) => {
    assert.equal(
      (await api(h, 'PATCH', '/api/support-tickets/ticket-a/status', sign(userA), { status: 'open' })).status,
      403,
    );
    assert.equal(
      (await api(h, 'PATCH', '/api/support-tickets/ticket-a/status', sign(userA), { status: 'waiting_on_support' })).status,
      403,
    );
    assert.equal(
      (await api(h, 'PATCH', '/api/support-tickets/ticket-a/status', sign(userA), { status: 'bogus' })).status,
      400,
    );
    assert.equal(state.tickets.find((t) => t.id === 'ticket-a')!.status, 'open');

    const resolved = await api(h, 'PATCH', '/api/support-tickets/ticket-a/status', sign(userA), { status: 'resolved' });
    assert.equal(resolved.status, 200);
    assert.equal(state.tickets.find((t) => t.id === 'ticket-a')!.status, 'resolved');
  });
});

test('status changes on another user\'s ticket fail closed before any validation', async () => {
  await withState(seedTickets, async (h) => {
    const res = await api(h, 'PATCH', '/api/support-tickets/ticket-a/status', sign(userB), { status: 'resolved' });
    assert.equal(res.status, 404);
    assert.equal(state.tickets.find((t) => t.id === 'ticket-a')!.status, 'open');
  });
});

test('support ticket handlers surface a storage failure as 500', async () => {
  await withState(seedTickets, async (h) => {
    state.failWith = new Error('simulated db outage');
    assert.equal((await api(h, 'GET', '/api/support-tickets/ticket-a', sign(userA))).status, 500);
    assert.equal((await api(h, 'GET', '/api/support-tickets', sign(supportAdmin))).status, 500);
    assert.equal((await api(h, 'GET', '/api/support-tickets/mine', sign(userA))).status, 500);
  });
});
