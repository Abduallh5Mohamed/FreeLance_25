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
import { quietConsole, restoreConsole } from './helpers/quiet-console';

test.beforeEach(quietConsole);
test.afterEach(restoreConsole);
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { createServer, type Server } from 'node:http';
import express from 'express';
import jwt from 'jsonwebtoken';
import { randomUUID } from 'node:crypto';

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
  privateNotes: Row[];
  privateNotesSchema: boolean;
  assignmentSchema: boolean;
  assignedIndex: boolean;
  assignmentAttempts: Row[];
  audits: Row[];
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
  privateNotes: [],
  privateNotesSchema: false,
  assignmentSchema: false,
  assignedIndex: true,
  assignmentAttempts: [],
  audits: [],
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
  if(sql.includes("INDEX_NAME='idx_support_assignee_id'"))return state.assignedIndex?['assigned_to','id'].map((column_name,index)=>({column_name,seq_in_index:index+1})):[];
  if(sql.includes('FROM support_tickets t WHERE t.assigned_to=?')){
    assert.match(sql,/ORDER BY t.id ASC LIMIT 26/);
    return state.tickets.filter(row=>row.assigned_to===params[0]&&(params.length===1||String(row.id)>String(params[1]))).sort((a,b)=>String(a.id).localeCompare(String(b.id))).slice(0,26)
      .map(row=>({id:row.id,ticket_number:row.ticket_number,category:row.category,subject:row.subject,status:row.status,priority:row.priority,created_at_epoch:Date.parse(String(row.created_at))/1000,updated_at_epoch:Date.parse(String(row.updated_at))/1000}));
  }
  if(sql.startsWith('SELECT users.id,users.name')){
    assert.match(sql,/users.is_active=1/);assert.match(sql,/users.suspended_until > UTC_TIMESTAMP\(\)/);assert.match(sql,/rp.permission_key='support.read'/);assert.match(sql,/LIMIT 26/);
    return state.users.filter(row=>Number(row.is_active)===1&&!(row.suspended_until&&Date.parse(String(row.suspended_until))>Date.now())
      &&(state.superAdmins.has(String(row.id))||(state.permissions[String(row.id)]??[]).includes('support.read'))&&(!params.length||String(row.id)>String(params[0])))
      .sort((a,b)=>String(a.id).localeCompare(String(b.id))).slice(0,26).map(row=>({id:row.id,name:row.name}));
  }
  if(sql.includes("TABLE_NAME='support_assignment_attempts'")){
    if(!state.assignmentSchema)return [];
    return sql.includes('information_schema.TABLES')?[{engine:'InnoDB'}]:[{column_name:'id',seq_in_index:1}];
  }
  if(sql.includes('information_schema.COLUMNS')&&sql.includes("'support_assignment_attempts'"))return state.assignmentSchema?[
    ...['assigned_to','assignment_version'].map(column_name=>({table_name:'support_tickets',column_name})),
    ...['id','ticket_id','actor_user_id','assigned_to','expected_version','result_version','changed'].map(column_name=>({table_name:'support_assignment_attempts',column_name})),
  ]:[];
  if(sql.startsWith('SELECT id,assigned_to,assignment_version'))return state.tickets.filter(row=>row.id===params[0]).map(row=>({id:row.id,assigned_to:row.assigned_to??null,assignment_version:row.assignment_version??0}));
  if(sql.startsWith('SELECT id,ticket_id,actor_user_id,assigned_to'))return state.assignmentAttempts.filter(row=>row.id===params[0]&&row.ticket_id===params[1]).map(row=>({...row}));
  if(sql.includes("TABLE_NAME='support_ticket_private_notes'")){
    if(!state.privateNotesSchema)return [];
    if(sql.includes('information_schema.TABLES'))return [{engine:'InnoDB'}];
    if(sql.includes('information_schema.COLUMNS'))return ['id','ticket_id','author_user_id','body','created_at'].map(column_name=>({column_name}));
    if(sql.includes("INDEX_NAME='PRIMARY'"))return [{column_name:'id',seq_in_index:1}];
    return ['ticket_id','created_at','id'].map((column_name,index)=>({column_name,seq_in_index:index+1}));
  }
  if(sql.includes('information_schema.TABLES'))return ['users','support_tickets','support_ticket_replies','audit_events','admin_user_roles','admin_role_permissions'].map(table_name=>({table_name,engine:'InnoDB'}));
  if(sql.includes('information_schema.STATISTICS'))return ['users','support_tickets','support_ticket_replies','audit_events'].map(table_name=>({table_name,column_name:'id',seq_in_index:1}));
  if(sql.includes('information_schema.COLUMNS'))return [];
  if(sql.includes('FROM users WHERE id=? LIMIT 1 FOR UPDATE')){
    const user=state.users.find(row=>row.id===params[0]);return user?[{...user,suspension_active:0}]:[];
  }
  if(sql.startsWith('SELECT ur.user_id,rp.permission_key'))return state.superAdmins.has(String(params[0]))||(state.permissions[String(params[0])]??[]).includes('support.read')?[{user_id:params[0],permission_key:'support.read'}]:[];

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
  if(sql.startsWith('SELECT id,ticket_number,user_id,category')){const row=state.tickets.find(row=>row.id===params[0]);return row?[{...row}]:[];}
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
    return interpolateLimit(rows, sql).map(row=>({id:row.id,ticket_number:row.ticket_number,category:row.category,subject:row.subject,status:row.status,priority:row.priority,created_at:row.created_at,updated_at:row.updated_at}));
  }
  if (sql.includes('u.name AS user_name') && sql.includes('FROM support_tickets t')) {
    // ticket detail projection (WHERE t.id = ?) or the admin queue listing
    if (sql.includes('WHERE t.id = ?')) {
      const ticket = state.tickets.find((t) => t.id === params[0]);
      if (!ticket) return [];
      if (sql.includes('AND t.user_id = ?') && ticket.user_id !== params[1]) return [];
      const owner = state.users.find((u) => u.id === ticket.user_id);
      if (!sql.includes('u.phone AS user_phone')) return [{
        id: ticket.id, ticket_number: ticket.ticket_number, user_id: ticket.user_id, category: ticket.category,
        subject: ticket.subject, description: ticket.description, status: ticket.status, priority: ticket.priority,
        created_at: ticket.created_at, updated_at: ticket.updated_at, user_name: owner?.name ?? null,
      }];
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
  if(sql.includes('FROM support_ticket_private_notes n')){
    const project=(row:Row)=>({id:row.id,ticket_id:row.ticket_id,author_id:row.author_user_id,author_name:state.users.find(user=>user.id===row.author_user_id)?.name??'',body:row.body,created_at_epoch:Date.parse(String(row.created_at))/1000});
    if(sql.includes('WHERE n.id=?'))return state.privateNotes.filter(row=>row.id===params[0]&&row.ticket_id===params[1]).map(project);
    const anchored=sql.includes('support_ticket_private_notes anchor'),ticketId=params[anchored?1:0],anchor=anchored?state.privateNotes.find(row=>row.id===params[0]&&row.ticket_id===ticketId):null;
    return state.privateNotes.filter(row=>row.ticket_id===ticketId&&(!anchored||anchor&&(String(row.created_at)<String(anchor.created_at)||row.created_at===anchor.created_at&&String(row.id)<String(anchor.id))))
      .sort((a,b)=>String(b.created_at).localeCompare(String(a.created_at))||String(b.id).localeCompare(String(a.id))).slice(0,101).map(project);
  }
  if (sql.includes('FROM support_ticket_replies')) {
    if(sql.startsWith('SELECT id,ticket_id,sender_id,body')){const row=state.replies.find(row=>row.id===params[0]);return row?[{...row}]:[];}
    if (sql.startsWith('SELECT id FROM support_ticket_replies WHERE ticket_id')) {
      const anchor=state.replies.find(r=>r.ticket_id===params[0]&&r.id===params[1]);return anchor?[{id:anchor.id}]:[];
    }
    if (sql.includes('WHERE r.id = ?')||sql.includes('WHERE r.id=?')) {
      const reply = state.replies.find((r) => r.id === params[0]);
      if (!reply) return [];
      const sender = state.users.find((u) => u.id === reply.sender_id);
      return [{ ...reply, sender_name: sender?.name ?? null, sender_role: sender?.role ?? null }];
    }
    const anchored=sql.includes('INNER JOIN support_ticket_replies anchor');
    const ticketId = String(params[anchored?1:0]);
    const anchor=anchored?state.replies.find(r=>r.id===params[0]&&r.ticket_id===ticketId):null;
    const rows = state.replies
      .filter((r) => r.ticket_id === ticketId)
      .filter(r=>!anchored||!!anchor&&(String(r.created_at)<String(anchor.created_at)||r.created_at===anchor.created_at&&String(r.id)<String(anchor.id)))
      .map((r): Row => {
        const sender = state.users.find((u) => u.id === r.sender_id);
        return { id:r.id,body:r.body,created_at:r.created_at,sender_id:r.sender_id, sender_name: sender?.name ?? null, sender_role: sender?.role ?? null };
      })
      .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)) || String(b.id).localeCompare(String(a.id)));
    return interpolateLimit(rows, sql);
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
  if(sql.startsWith('UPDATE support_tickets SET assigned_to=')){
    const row=state.tickets.find(row=>row.id===params[2]&&(row.assignment_version??0)===params[3]);if(!row)return {affectedRows:0,insertId:0};
    Object.assign(row,{assigned_to:params[0],assignment_version:params[1]});return {affectedRows:1,insertId:0};
  }
  if(sql.startsWith('INSERT INTO support_assignment_attempts')){
    if(state.assignmentAttempts.some(row=>row.id===params[0]))throw Object.assign(Error('duplicate'),{code:'ER_DUP_ENTRY'});
    state.assignmentAttempts.push({id:params[0],ticket_id:params[1],actor_user_id:params[2],assigned_to:params[3],expected_version:params[4],result_version:params[5],changed:params[6]});return {affectedRows:1,insertId:0};
  }
  if(sql.includes('INSERT INTO support_ticket_private_notes')){
    if(state.privateNotes.some(row=>row.id===params[0]))throw Object.assign(Error('duplicate'),{code:'ER_DUP_ENTRY'});
    state.privateNotes.push({id:params[0],ticket_id:params[1],author_user_id:params[2],body:params[3],created_at:'2026-11-05T10:00:00Z'});return{affectedRows:1,insertId:0};
  }
  if(sql.includes('INSERT INTO audit_events')){state.audits.push({params});return {affectedRows:1,insertId:0};}

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
  if (/UPDATE support_tickets\s+SET status\s*=\s*\?,\s*updated_at/.test(sql)) {
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
  getConnection: async () => {
    let before: {tickets:Row[];replies:Row[];privateNotes:Row[];audits:Row[];assignmentAttempts:Row[]}|null=null;
    return {...fakePool,beginTransaction:async()=>{before=structuredClone({tickets:state.tickets,replies:state.replies,privateNotes:state.privateNotes,audits:state.audits,assignmentAttempts:state.assignmentAttempts});},
      commit:async()=>{},rollback:async()=>{if(before)Object.assign(state,before);},destroy:()=>{}};
  },
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
  extraHeaders: Record<string,string> = {},
): Promise<ApiResult> => {
  const res = await fetch(`${h.base}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(method==='POST'&&path.startsWith('/api/support-tickets')?{'Idempotency-Key':randomUUID()}:{}),
      ...extraHeaders,
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
test('support write routes require a key and reconcile the same actor attempt without duplicating',async()=>{
  await withState(seedTickets,async h=>{
    const key='a1000000-0000-4000-8000-000000000001',headers={'Idempotency-Key':key};
    const body={category:'technical',subject:'Synthetic duplicate',description:'Synthetic request content'};
    assert.equal((await api(h,'POST','/api/support-tickets',sign(userA),body,{'Idempotency-Key':''})).status,400);
    const first=await api(h,'POST','/api/support-tickets',sign(userA),body,headers);assert.equal(first.status,201);
    const repeat=await api(h,'POST','/api/support-tickets',sign(userA),body,headers);assert.equal(repeat.status,200);assert.equal(repeat.body.unchanged,true);
    assert.equal(repeat.body.ticket.id,first.body.ticket.id);
    const check=await api(h,'GET',`/api/support-tickets/attempts/create/${key}`,sign(userA));assert.equal(check.status,200);assert.equal(check.body.ticket.id,first.body.ticket.id);
    assert.equal((await api(h,'GET',`/api/support-tickets/attempts/create/${key}`,sign(userB))).status,404);
    assert.equal((await api(h,'POST','/api/support-tickets',sign(userA),{...body,subject:'Different input'},headers)).status,409);
    const reply=await api(h,'POST',`/api/support-tickets/${first.body.ticket.id}/replies`,sign(userA),{body:'Synthetic reply'},headers);assert.equal(reply.status,201);
    const ack=await api(h,'GET',`/api/support-tickets/attempts/reply/${key}`,sign(userA));assert.equal(ack.status,200);assert.equal(ack.body.reply.id,reply.body.reply.id);assert.equal(ack.body.ticket_id,first.body.ticket.id);
  });
});
test('ticket context is scoped and a client body cannot supply its missing workspace authority',async()=>{
  await withState(seedTickets,async h=>{
    const own=await api(h,'GET','/api/support-tickets/ticket-a/context',sign(userA));assert.equal(own.status,200);assert.deepEqual(own.body,{state:'unconfigured',context:null});
    assert.equal((await api(h,'GET','/api/support-tickets/ticket-a/context',sign(userB))).status,404);
    const request={category:'technical',subject:'Synthetic lesson issue',description:'Synthetic support description',tenant_id:'tenant-a',student_enrollment_id:'foreign',context:{kind:'catalog_lesson',course_id:'b1000000-0000-4000-8000-000000000001',lesson_id:'c1000000-0000-4000-8000-000000000001'}};
    assert.equal((await api(h,'POST','/api/support-tickets',sign(userA),request)).status,403);
    assert.equal(state.tickets.length,2);
  });
});
test('assignment routes require current support authority and actual schema, without exposing state to owners',async()=>{
  await withState(seedTickets,async h=>{
    const base='/api/support-tickets/ticket-a/assignment',key='a1000000-0000-4000-8000-000000000001';
    for(const token of [sign(userA),sign({...userA,role:'admin'})]){
      assert.equal((await api(h,'GET',base,token)).status,404);
      assert.equal((await api(h,'POST',base,token,{assigned_to:'admin-support',expected_version:0})).status,404);
      assert.equal((await api(h,'GET',`${base}/attempts/${key}`,token)).status,404);
    }
    assert.equal((await api(h,'GET',base,sign(supportAdmin))).body.code,'SUPPORT_ASSIGNMENT_UNAVAILABLE');
    assert.equal((await api(h,'GET',base,null)).status,401);
    assert.equal(state.assignmentAttempts.length,0);assert.ok(!state.executed.some(row=>row.sql.startsWith('SELECT id,assigned_to')));
  });
});
test('assignment mounted routes claim, transfer, reject stale decisions and recover historical receipts privately',async()=>{
  await withState(seedTickets,async h=>{
    state.assignmentSchema=true;state.superAdmins.add('super-1');
    const base='/api/support-tickets/ticket-a/assignment',token=sign(supportAdmin),key='a1000000-0000-4000-8000-000000000001',headers={'Idempotency-Key':key};
    const original=structuredClone(state.tickets[0]);
    const before=await api(h,'GET',base,token);assert.deepEqual(before.body,{assignment:{ticket_id:'ticket-a',assigned_to:null,version:0},assignee:null});
    const first=await api(h,'POST',base,token,{assigned_to:'admin-support',expected_version:0},headers);assert.equal(first.status,201);
    assert.deepEqual(first.body,{assignment:{ticket_id:'ticket-a',assigned_to:'admin-support',version:1},changed:true,unchanged:false});
    assert.equal((await api(h,'POST',base,token,{assigned_to:'admin-support',expected_version:0},headers)).body.unchanged,true);
    const secondHeaders={'Idempotency-Key':'a1000000-0000-4000-8000-000000000002'};
    assert.equal((await api(h,'POST',base,token,{assigned_to:'super-1',expected_version:0},secondHeaders)).body.code,'SUPPORT_ASSIGNMENT_STALE');
    assert.equal((await api(h,'POST',base,token,{assigned_to:'super-1',expected_version:1},secondHeaders)).status,201);
    assert.equal((await api(h,'GET',base,token)).body.assignee.name,'name-super-1');
    const writes=state.audits.length;
    assert.equal((await api(h,'GET',`${base}/attempts/${key}`,token)).body.assignment.assigned_to,'admin-support');
    assert.equal((await api(h,'GET',`${base}/attempts/${key}`,sign(superAdmin))).body.code,'SUPPORT_ATTEMPT_NOT_FOUND');
    assert.equal(state.audits.length,writes);assert.equal(state.assignmentAttempts.length,2);
    assert.deepEqual({...state.tickets[0],assigned_to:original.assigned_to,assignment_version:undefined},{...original,assignment_version:undefined});
    for(const path of ['/api/support-tickets/ticket-a','/api/support-tickets/mine']){
      const response=await api(h,'GET',path,sign(userA));assert.ok(!JSON.stringify(response.body).includes('assigned_to'));assert.ok(!JSON.stringify(response.body).includes('assignment_version'));
    }
    state.superAdmins.delete('super-1');assert.equal((await api(h,'GET',base,token)).body.assignee,null);
    delete state.permissions['admin-support'];assert.equal((await api(h,'GET',base,token)).status,404);
    assert.equal((await api(h,'GET',`${base}/attempts/${key}`,token)).status,404);
  });
});
test('assignment HTTP paths reject extra selectors and every success/error is no-store',async()=>{
  await withState(seedTickets,async h=>{
    state.assignmentSchema=true;
    const base='/api/support-tickets/ticket-a/assignment';
    for(const [path,token,status] of [[base,sign(supportAdmin),200],[base,sign(userA),404],[base,null,401],[`${base}?tenant_id=forged`,sign(supportAdmin),400],[`${base}/attempts/bad`,sign(supportAdmin),400]] as const){
      const response=await fetch(`${h.base}${path}`,{headers:token?{Authorization:`Bearer ${token}`}:{}});assert.equal(response.status,status);assert.equal(response.headers.get('cache-control'),'no-store');await response.arrayBuffer();
    }
    assert.equal((await api(h,'POST',base,sign(supportAdmin),{assigned_to:null,expected_version:0,tenant_id:'forged'})).status,400);
    assert.equal((await api(h,'POST',`${base}?target=forged`,sign(supportAdmin),{assigned_to:null,expected_version:0})).status,400);
  });
});
test('assignment candidate route exposes only eligible identities to verified support and refuses caller selectors',async()=>{
  await withState(seedTickets,async h=>{
    state.assignmentSchema=true;state.superAdmins.add('super-1');
    const path='/api/support-tickets/ticket-a/assignment/candidates';
    assert.equal((await api(h,'GET',path,sign(userA))).status,404);assert.equal((await api(h,'GET',path,null)).status,401);
    const result=await api(h,'GET',path,sign(supportAdmin));assert.deepEqual(result.body,{candidates:[{id:'admin-support',name:'name-admin-support'},{id:'super-1',name:'name-super-1'}],next_cursor:null});
    assert.equal((await api(h,'GET',`${path}?after=admin-support`,sign(supportAdmin))).body.candidates.length,1);
    assert.equal((await api(h,'GET',`${path}?after=a&after=b`,sign(supportAdmin))).status,400);
    assert.equal((await api(h,'GET',`${path}?tenant_id=forged`,sign(supportAdmin))).status,400);
    state.users.find(row=>row.id==='super-1')!.is_active=0;assert.equal((await api(h,'GET',path,sign(supportAdmin))).body.candidates.length,1);
    const response=await fetch(`${h.base}${path}`,{headers:{Authorization:`Bearer ${sign(supportAdmin)}`}});assert.equal(response.headers.get('cache-control'),'no-store');await response.arrayBuffer();
  });
});
test('assigned route takes identity only from the server and removes transferred tickets on refreshed reads',async()=>{
  await withState(seedTickets,async h=>{
    state.assignmentSchema=true;const path='/api/support-tickets/assigned',token=sign(supportAdmin);
    assert.equal((await api(h,'GET',path,sign(userA))).status,404);assert.equal((await api(h,'GET',path,null)).status,401);
    state.tickets[0].assigned_to='admin-support';state.tickets[1].assigned_to='super-1';
    const first=await api(h,'GET',path,token);assert.equal(first.status,200);assert.deepEqual(first.body.tickets.map((row:Row)=>row.id),['ticket-a']);assert.equal(first.body.next_cursor,null);
    assert.deepEqual(Object.keys(first.body.tickets[0]),['id','ticket_number','category','subject','status','priority','created_at','updated_at']);
    const transferred=await api(h,'POST','/api/support-tickets/ticket-a/assignment',token,{assigned_to:null,expected_version:0});assert.equal(transferred.status,201);
    assert.deepEqual((await api(h,'GET',path,token)).body,{tickets:[],next_cursor:null});
    assert.equal((await api(h,'GET',`${path}?assigned_to=super-1`,token)).status,400);assert.equal((await api(h,'GET',`${path}?after=a&after=b`,token)).status,400);
    state.assignedIndex=false;assert.equal((await api(h,'GET',path,token)).body.code,'SUPPORT_ASSIGNED_UNAVAILABLE');state.assignedIndex=true;
    const response=await fetch(`${h.base}${path}`,{headers:{Authorization:`Bearer ${token}`}});assert.equal(response.headers.get('cache-control'),'no-store');await response.arrayBuffer();
    delete state.permissions['admin-support'];assert.equal((await api(h,'GET',path,token)).status,404);
  });
});

test('private-note routes deny requesters and role-only callers, and fail closed before schema readiness',async()=>{
  await withState(seedTickets,async h=>{
    const base='/api/support-tickets/ticket-a/private-notes',key='a1000000-0000-4000-8000-000000000001';
    for(const token of [sign(userA),sign({...userA,role:'admin'})]){
      assert.equal((await api(h,'GET',base,token)).status,404);
      assert.equal((await api(h,'POST',base,token,{body:'PRIVATE-NOTE-SYNTHETIC'})).status,404);
      assert.equal((await api(h,'GET',`${base}/attempts/${key}`,token)).status,404);
    }
    assert.equal((await api(h,'GET',base,sign(supportAdmin))).status,503);
    assert.equal(state.privateNotes.length,0);assert.ok(!state.executed.some(row=>row.sql.includes('FROM support_ticket_private_notes n')));
    assert.equal((await api(h,'GET',base,null)).status,401);
  });
});
test('verified private notes never enter public detail, reply history, queue or generic attempt responses',async()=>{
  await withState(seedTickets,async h=>{
    state.privateNotesSchema=true;const body='PRIVATE-NOTE-SYNTHETIC',key='a1000000-0000-4000-8000-000000000001',headers={'Idempotency-Key':key},base='/api/support-tickets/ticket-a/private-notes';
    const previous=structuredClone(state.tickets[0]);
    const created=await api(h,'POST',base,sign(supportAdmin),{body},headers);assert.equal(created.status,201);
    const repeat=await api(h,'POST',base,sign(supportAdmin),{body},headers);assert.equal(repeat.status,200);assert.equal(repeat.body.unchanged,true);
    assert.deepEqual(state.tickets[0],previous);assert.equal(state.privateNotes.length,1);assert.equal(state.replies.length,1);assert.ok(!JSON.stringify(state.audits).includes(body));
    const receipt=await api(h,'GET',`${base}/attempts/${key}`,sign(supportAdmin));assert.equal(receipt.body.note.body,body);
    assert.equal((await api(h,'GET',base,sign(supportAdmin))).body.notes.length,1);
    const start=state.executed.length;
    for(const [path,token] of [['/api/support-tickets/ticket-a',sign(userA)],['/api/support-tickets/ticket-a',sign(supportAdmin)],['/api/support-tickets/mine',sign(userA)],['/api/support-tickets',sign(supportAdmin)],['/api/support-tickets/ticket-a/replies?before=reply-a-1',sign(userA)], [`/api/support-tickets/attempts/reply/${key}`,sign(supportAdmin)]]){
      const response=await api(h,'GET',path,token);assert.ok(!JSON.stringify(response.body).includes(body));
    }
    assert.ok(!state.executed.slice(start).some(row=>row.sql.includes('FROM support_ticket_private_notes n')));
    delete state.permissions['admin-support'];assert.equal((await api(h,'GET',base,sign(supportAdmin))).status,404);
    assert.equal((await api(h,'GET',`${base}/attempts/${key}`,sign(supportAdmin))).status,404);
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
      state.executed.filter((e) => e.sql.includes('u.name AS user_name') && e.sql.includes('WHERE t.id = ?') && e.params[0] === 'ticket-a').length,
      1,
      'a rejected caller must not reach the PII-projection query',
    );
  });
});
test('ticket detail exposes a fixed owner view and marks bounded older replies', async () => {
  await withState(seedTickets, async (h) => {
    for (let n = 2; n <= 105; n++) state.replies.push({ id: `reply-a-${String(n).padStart(3,'0')}`, ticket_id:'ticket-a',
      sender_id:'user-a', body:`reply ${n}`, created_at:`2026-10-16T11:${String(Math.floor(n / 60)).padStart(2,'0')}:${String(n % 60).padStart(2,'0')}Z` });
    const result = await api(h, 'GET', '/api/support-tickets/ticket-a', sign(userA));
    assert.equal(result.status, 200);assert.equal(result.body.has_more_replies, true);assert.equal(result.body.replies.length, 100);
    assert.equal(result.body.replies.at(-1).id,'reply-a-105');
    assert.equal('user_phone' in result.body.ticket,false);assert.equal('assigned_to' in result.body.ticket,false);
    const detailSql=state.executed.find(e=>e.sql.includes('FROM support_tickets t')&&e.sql.includes('WHERE t.id = ?'))!;
    assert.ok(!detailSql.sql.includes('SELECT t.*'));assert.match(detailSql.sql,/AND t.user_id = \?/);
    const repliesSql=state.executed.find(e=>e.sql.includes('FROM support_ticket_replies r')&&e.sql.includes('LIMIT 101'))!;
    assert.match(repliesSql.sql,/ORDER BY r.created_at DESC, r.id DESC LIMIT 101/);
  });
});
test('support reply keyset pages preserve timestamp ties and exclude concurrent new replies',async()=>{
  await withState(seedTickets,async h=>{
    state.replies=[];
    for(let n=1;n<=251;n++)state.replies.push({id:`reply-${String(n).padStart(3,'0')}`,ticket_id:'ticket-a',sender_id:'user-a',body:`message ${n}`,created_at:'2026-10-16T10:00:00Z'});
    const first=await api(h,'GET','/api/support-tickets/ticket-a',sign(userA));
    assert.equal(first.status,200);assert.equal(first.body.replies.length,100);assert.equal(first.body.next_cursor,'reply-152');
    state.replies.push({id:'reply-999',ticket_id:'ticket-a',sender_id:'user-a',body:'new after first page',created_at:'2026-10-16T11:00:00Z'});
    const second=await api(h,'GET',`/api/support-tickets/ticket-a/replies?before=${first.body.next_cursor}`,sign(userA));
    assert.equal(second.status,200);assert.equal(second.body.next_cursor,'reply-052');
    const third=await api(h,'GET',`/api/support-tickets/ticket-a/replies?before=${second.body.next_cursor}`,sign(userA));
    assert.equal(third.status,200);assert.equal(third.body.next_cursor,null);assert.equal(third.body.replies.length,51);
    const all=[...third.body.replies,...second.body.replies,...first.body.replies];
    assert.equal(all.length,251);assert.equal(new Set(all.map(r=>r.id)).size,251);assert.equal(all[0].id,'reply-001');assert.equal(all.at(-1).id,'reply-251');
    assert.ok(state.executed.filter(e=>e.sql.includes('INNER JOIN support_ticket_replies anchor')).every(e=>e.sql.includes('anchor.ticket_id = r.ticket_id')&&e.sql.includes('LIMIT 101')));
  });
});
test('older support replies recheck ticket authority and constrain cursor to that ticket',async()=>{
  await withState(seedTickets,async h=>{
    const before=state.executed.length;
    assert.equal((await api(h,'GET','/api/support-tickets/ticket-a/replies?before=reply-a-1',sign(userB))).status,404);
    assert.ok(!state.executed.slice(before).some(e=>e.sql.includes('FROM support_ticket_replies')));
    for(const suffix of ['','?before=missing','?before=reply-a-1&before=repeat','?before=reply-a-1&user_id=user-b','?before=%27%20OR%201=1']){
      assert.equal((await api(h,'GET',`/api/support-tickets/ticket-a/replies${suffix}`,sign(userA))).status,400);
    }
    assert.equal((await api(h,'GET','/api/support-tickets/ticket-b/replies?before=reply-a-1',sign(userB))).status,400);
    assert.equal((await api(h,'GET','/api/support-tickets/ticket-a/replies?before=reply-a-1',sign(supportAdmin))).status,200);
    delete state.permissions['admin-support'];
    assert.equal((await api(h,'GET','/api/support-tickets/ticket-a/replies?before=reply-a-1',sign(supportAdmin))).status,404);
    assert.equal((await api(h,'GET','/api/support-tickets/ticket-a/replies?before=reply-a-1',null)).status,401);
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

test('follow-up HTTP mount rechecks real JWT/grants, rejects selectors and fails closed without its schema', async () => {
  await withState(seedTickets, async h => {
    const path='/api/support-tickets/follow-up';
    assert.equal((await api(h,'GET',path,null)).status,401);
    const denied=await api(h,'GET',path,sign(userA));assert.equal(denied.status,404);assert.equal(denied.body.code,'SUPPORT_FOLLOWUP_NOT_FOUND');
    assert.equal((await api(h,'GET',path+'?assigned_to=foreign',sign(supportAdmin))).status,400);
    assert.equal((await api(h,'GET',path,sign(supportAdmin),undefined,{'x-assignee-id':'foreign'})).status,400);
    const missing=await api(h,'GET',path,sign(supportAdmin));assert.equal(missing.status,503);assert.equal(missing.body.code,'SUPPORT_FOLLOWUP_UNAVAILABLE');
    const response=await fetch(h.base+path,{headers:{Authorization:'Bearer '+sign(supportAdmin)}});assert.equal(response.headers.get('cache-control'),'no-store');await response.arrayBuffer();
  });
});
