import assert from 'node:assert/strict';
import test, { before, after } from 'node:test';
import type { Router, Response, NextFunction } from 'express';
import {
    EXPORT_COOLDOWN_SECONDS,
    EXPORT_DOWNLOAD_TOKEN_TTL_SECONDS,
    EXPORT_MANIFEST_VERSION,
    EXPORT_OWNERSHIP_CONTRADICTION,
    EXPORT_OWNERSHIP_OWNED,
    EXPORT_SECRET_MIN_BYTES,
    EXPORT_TABLE_PLAN,
    downloadTenantExport,
    issueExportDownloadToken,
    processTenantExport,
    requestTenantExport,
    sha256Hex,
    signExportToken,
    verifyExportDownloadToken,
} from '../src/services/tenant-export';
import type { ExportManifest, TenantExportDataAccess, TenantExportDeps } from '../src/services/tenant-export';
import { createTenantExportRouter } from '../src/routes/tenant-export';
import { createAuthenticateToken } from '../src/middleware/auth';
import { TEST_SECRET, invokeRoute, makeRepository, tokenFor } from './helpers/m2-harness';

const originalSecret = process.env.JWT_SECRET;
before(() => { process.env.JWT_SECRET = TEST_SECRET; });
after(() => {
    if (originalSecret === undefined) delete process.env.JWT_SECRET;
    else process.env.JWT_SECRET = originalSecret;
});

const VALID_SECRET = 't'.repeat(40);
const NOW = 1_700_000_000_000;

/**
 * A row as the ownership statement returns it: the CASE classification is part
 * of the result set, and the tenant pins are the statement's own parameters.
 */
const owned = (row: Record<string, unknown>): Record<string, unknown> => ({
    ...row,
    __ownership: EXPORT_OWNERSHIP_OWNED,
});

const contradicted = (row: Record<string, unknown>): Record<string, unknown> => ({
    ...row,
    __ownership: EXPORT_OWNERSHIP_CONTRADICTION,
});

/**
 * Every ownership pin a page statement binds must be the export tenant; the
 * only other bound values are the keyset cursor (a row id from this export's
 * own result set) and the numeric page size.
 */
const assertTenantPinned = (
    query: { sql: string; params: unknown[] },
    tenantId: string,
    knownIds: readonly string[] = [],
): void => {
    const cursorBound = query.sql.includes('AND t.id > ?');
    const pageSize = query.params[query.params.length - 1];
    assert.equal(typeof pageSize, 'number', 'the page size is bound, never interpolated');
    const withoutPaging = query.params.slice(0, cursorBound ? -2 : -1);
    assert.ok(withoutPaging.length >= 1, 'every table load pins the tenant in SQL');
    for (const pin of withoutPaging) {
        assert.equal(pin, tenantId, 'every ownership authority is pinned to the export tenant');
    }
    if (cursorBound) {
        const cursor = query.params[query.params.length - 2];
        assert.equal(typeof cursor, 'string');
        assert.ok(knownIds.includes(cursor as string), 'the cursor is an id from this export, not a foreign key');
    }
};

// ---------------------------------------------------------------------------
// Hermetic service fixtures
// ---------------------------------------------------------------------------

interface ServiceFixture {
    deps: TenantExportDeps;
    storage: Map<string, string>;
    audits: Array<{ action: string; resourceId: string; reason?: string }>;
    executed: Array<{ sql: string; params: unknown[]; kind: string }>;
    setActiveJob: (id: string | null) => void;
    setLastCompleted: (createdAt: string | null) => void;
    failPlanQuery: (table: string) => void;
}

const makeServiceFixture = (overrides: { secret?: string } = {}): ServiceFixture => {
    const storage = new Map<string, string>();
    const audits: ServiceFixture['audits'] = [];
    const executed: ServiceFixture['executed'] = [];
    let activeJob: string | null = null;
    let lastCompleted: string | null = null;
    const failingTables = new Set<string>();
    const tableRows: Record<string, Array<Record<string, unknown>>> = {
        courses: [
            owned({ id: 'c-1', name: 'Math', tenant_id: 'tenant-a', is_active: 1 }),
            owned({ id: 'c-2', name: 'Physics', tenant_id: 'tenant-a', is_active: 1 }),
        ],
        lectures: [owned({ id: 'l-1', title: 'Algebra', course_id: 'c-1', tenant_id: 'tenant-a' })],
        announcements: [owned({ id: 'a-1', title: 'Welcome', tenant_id: 'tenant-a' })],
        schedules: [],
        groups: [owned({ id: 'g-1', name: 'Grade 1', tenant_id: 'tenant-a' })],
        branches: [owned({ id: 'br-1', name: 'Main', tenant_id: 'tenant-a' })],
        branch_memberships: [owned({ id: 'bm-1', branch_id: 'br-1', user_id: 'owner-a' })],
        grades: [owned({ id: 'gr-1', name: 'Grade 1', tenant_id: 'tenant-a' })],
        students: [owned({ id: 's-1', name: 'Student One', email: 's1@example.com', tenant_id: 'tenant-a' })],
        student_courses: [owned({ id: 'sc-1', student_id: 's-1', course_id: 'c-1' })],
        course_materials: [],
        exams: [owned({ id: 'e-1', title: 'Midterm', tenant_id: 'tenant-a' })],
        exam_questions: [],
        question_bank_questions: [owned({ id: 'q-1', question_text: '2+2?', tenant_id: 'tenant-a' })],
        question_bank_versions: [],
        assignments: [owned({ id: 'as-1', title: 'Homework 1', tenant_id: 'tenant-a' })],
        assignment_submissions: [],
    };
    const deps: TenantExportDeps = {
        db: {
            query: async <T = Record<string, unknown>>(sql: string, params: unknown[] = []) => {
                executed.push({ sql, params, kind: 'query' });
                if (sql.includes("AND status = 'pending' LIMIT 1")) {
                    return (activeJob ? [{ id: activeJob, status: 'pending' }] : []) as unknown as T[];
                }
                if (sql.includes('ORDER BY created_at DESC LIMIT 1')) {
                    return (lastCompleted ? [{ created_at: lastCompleted }] : []) as unknown as T[];
                }
                const plan = EXPORT_TABLE_PLAN.find((entry) => sql === entry.sql);
                if (plan) {
                    if (failingTables.has(plan.table)) throw new Error(`table ${plan.table} unavailable`);
                    return (tableRows[plan.table] ?? []) as unknown as T[];
                }
                if (sql.includes('FROM tenant_data_exports WHERE id = ?')) {
                    return [] as unknown as T[];
                }
                return [] as unknown as T[];
            },
            queryOne: async <T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T | null> => {
                executed.push({ sql, params, kind: 'queryOne' });
                if (sql.includes("AND status = 'pending' LIMIT 1")) {
                    return (activeJob ? { id: activeJob, status: 'pending' } : null) as T | null;
                }
                if (sql.includes("AND status = 'completed'") && sql.includes('ORDER BY created_at DESC LIMIT 1')) {
                    return (lastCompleted ? { created_at: lastCompleted } : null) as T | null;
                }
                return null;
            },
            execute: async (sql: string, params: unknown[] = []) => {
                executed.push({ sql, params, kind: 'execute' });
                return { affectedRows: 1, insertId: 0 };
            },
        },
        storage: {
            write: async (key: string, body: string) => { storage.set(key, body); },
            read: async (key: string) => {
                const body = storage.get(key);
                if (body === undefined) throw new Error('object not found');
                return body;
            },
        },
        secret: 'secret' in overrides ? overrides.secret : VALID_SECRET,
        audit: async (input) => { audits.push({ action: input.action, resourceId: input.resourceId, reason: input.reason }); },
        now: () => NOW,
        newId: () => 'exp-fixed',
    };
    return {
        deps,
        storage,
        audits,
        executed,
        setActiveJob: (id) => { activeJob = id; },
        setLastCompleted: (createdAt) => { lastCompleted = createdAt; },
        failPlanQuery: (table) => { failingTables.add(table); },
    };
};

// ---------------------------------------------------------------------------
// Request gating: fail closed, one active per tenant, cooldown
// ---------------------------------------------------------------------------

test('tenant export request fails closed with 503 when the secret is missing or too short', async () => {
    for (const secret of [undefined, 'short', 'x'.repeat(EXPORT_SECRET_MIN_BYTES - 1)]) {
        const fixture = makeServiceFixture({ secret });
        const result = await requestTenantExport(fixture.deps, { tenantId: 'tenant-a', actorUserId: 'owner-a' });
        assert.equal(result.ok, false);
        if (!result.ok) {
            assert.equal(result.status, 503);
            assert.match(result.error, /not configured/);
        }
        const inserts = fixture.executed.filter((e) => e.kind === 'execute' && e.sql.includes('INSERT INTO tenant_data_exports'));
        assert.equal(inserts.length, 0, 'no job may be created while unconfigured');
        assert.ok(fixture.audits.some((a) => a.action === 'tenant_export.request_denied'), 'the denial is audited');
    }
});

test('tenant export request is 409 while another export of the same tenant is active', async () => {
    const fixture = makeServiceFixture();
    fixture.setActiveJob('exp-running');
    const result = await requestTenantExport(fixture.deps, { tenantId: 'tenant-a', actorUserId: 'owner-a' });
    assert.deepEqual(result, { ok: false, status: 409, error: 'An export for this tenant is already in progress' });
});

test('tenant export request respects the post-completion cooldown', async () => {
    const fixture = makeServiceFixture();
    fixture.setLastCompleted(new Date(NOW - EXPORT_COOLDOWN_SECONDS * 1000 + 30_000).toISOString());
    const cooling = await requestTenantExport(fixture.deps, { tenantId: 'tenant-a', actorUserId: 'owner-a' });
    assert.equal(cooling.ok, false);
    if (!cooling.ok) assert.equal(cooling.status, 409);

    fixture.setLastCompleted(new Date(NOW - EXPORT_COOLDOWN_SECONDS * 1000 - 1).toISOString());
    const afterCooldown = await requestTenantExport(fixture.deps, { tenantId: 'tenant-a', actorUserId: 'owner-a' });
    assert.equal(afterCooldown.ok, true);
});

test('tenant export request inserts a pending job and audits the request', async () => {
    const fixture = makeServiceFixture();
    const result = await requestTenantExport(fixture.deps, {
        tenantId: 'tenant-a',
        actorUserId: 'owner-a',
        reason: 'Monthly backup',
    });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.deepEqual(result.job, { id: 'exp-fixed', tenantId: 'tenant-a', status: 'pending', createdAt: new Date(NOW).toISOString() });
    const insert = fixture.executed.find((e) => e.kind === 'execute' && e.sql.includes('INSERT INTO tenant_data_exports'));
    assert.ok(insert);
    assert.deepEqual(insert.params, ['exp-fixed', 'tenant-a', 'owner-a']);
    const requested = fixture.audits.find((a) => a.action === 'tenant_export.requested');
    assert.ok(requested);
    assert.equal(requested.resourceId, 'exp-fixed');
    assert.equal(requested.reason, 'Monthly backup');
});

test('tenant export request recovers a committed pending job when its audit fails', async () => {
    const fixture = makeServiceFixture();
    fixture.deps.audit = async () => { throw new Error('audit store unavailable'); };

    await assert.rejects(
        () => requestTenantExport(fixture.deps, { tenantId: 'tenant-a', actorUserId: 'owner-a' }),
        /audit store unavailable/,
    );

    const insert = fixture.executed.find((e) => e.kind === 'execute' && e.sql.includes('INSERT INTO tenant_data_exports'));
    assert.ok(insert, 'the job insert was attempted');
    const recovered = fixture.executed.find((e) => e.kind === 'execute' && e.sql.includes("SET status = 'failed'"));
    assert.ok(recovered, 'the committed pending row is not left stuck');
    assert.deepEqual(
        recovered.params,
        ['The export request was not audited: audit store unavailable', 'exp-fixed', 'tenant-a'],
        'the recovery is guarded by the exact job and tenant',
    );
    assert.ok(recovered.sql.includes("AND status = 'pending'"));
    assert.equal(fixture.audits.length, 0, 'no success audit was recorded');
});

test('tenant export request relies on the transaction seam instead of a compensating write', async () => {
    const fixture = makeServiceFixture();
    const base = fixture.deps.db;
    let committed = false;
    let rolledBack = false;
    fixture.deps.db = {
        ...base,
        transaction: async <T>(fn: (tx: typeof base) => Promise<T>): Promise<T> => {
            try {
                const result = await fn(base);
                committed = true;
                return result;
            } catch (error) {
                rolledBack = true;
                throw error;
            }
        },
    };
    fixture.deps.audit = async () => { throw new Error('audit store unavailable'); };

    await assert.rejects(
        () => requestTenantExport(fixture.deps, { tenantId: 'tenant-a', actorUserId: 'owner-a' }),
        /audit store unavailable/,
    );

    assert.equal(rolledBack, true, 'the failed audit rolled the insert back');
    assert.equal(committed, false);
    assert.equal(
        fixture.executed.filter((e) => e.kind === 'execute' && e.sql.includes("SET status = 'failed'")).length,
        0,
        'a rollback leaves no row to compensate',
    );
});

test('tenant export request maps the active-tenant INSERT race to 409', async () => {
    const fixture = makeServiceFixture();
    const baseExecute = fixture.deps.db.execute;
    fixture.deps.db.execute = async (sql: string, params: unknown[] = []) => {
        if (sql.includes('INSERT INTO tenant_data_exports')) {
            const duplicate = new Error('Duplicate entry for key uq_tenant_data_exports_active') as Error & {
                code?: string;
                errno?: number;
            };
            duplicate.code = 'ER_DUP_ENTRY';
            duplicate.errno = 1062;
            throw duplicate;
        }
        return baseExecute(sql, params);
    };

    const result = await requestTenantExport(fixture.deps, { tenantId: 'tenant-a', actorUserId: 'owner-a' });
    assert.deepEqual(result, {
        ok: false,
        status: 409,
        error: 'An export for this tenant is already in progress',
    });
    assert.equal(fixture.audits.length, 0, 'the losing request is not audited as a success');
    assert.equal(
        fixture.executed.filter((e) => e.kind === 'execute' && e.sql.includes("SET status = 'failed'")).length,
        0,
        'no row was created by the losing request',
    );
});

// ---------------------------------------------------------------------------
// Processing: tenant-pinned loads, completeness manifest, checksums
// ---------------------------------------------------------------------------

test('processTenantExport writes every table tenant-pinned with a verifiable completeness manifest', async () => {
    const fixture = makeServiceFixture();
    fixture.deps.db.queryOne = async <T = Record<string, unknown>>(sql: string): Promise<T | null> => {
        fixture.executed.push({ sql, params: [], kind: 'queryOne' });
        return { id: 'exp-fixed', tenant_id: 'tenant-a', status: 'pending' } as unknown as T;
    };
    const manifest = await processTenantExport(fixture.deps, 'exp-fixed');

    const planQueries = fixture.executed.filter((e) => e.kind === 'query' && EXPORT_TABLE_PLAN.some((p) => p.sql === e.sql));
    assert.equal(planQueries.length, EXPORT_TABLE_PLAN.length, 'every planned table is queried');
    for (const query of planQueries) {
        assertTenantPinned(query, 'tenant-a');
    }
    for (const statement of fixture.executed) {
        assert.ok(!statement.sql.includes('password_hash'), 'credential material is never selected');
        assert.ok(!/SELECT\s+\*/i.test(statement.sql), 'SELECT * is forbidden');
    }

    // One storage object per table plus the manifest object.
    assert.equal(fixture.storage.size, EXPORT_TABLE_PLAN.length + 1);
    let totalRows = 0;
    let totalBytes = 0;
    for (const table of manifest.tables) {
        const body = fixture.storage.get(`tenant-exports/tenant-a/exp-fixed/${table.table}.jsonl`);
        assert.ok(body !== undefined, `missing storage object for ${table.table}`);
        assert.equal(table.rows, body === '' ? 0 : body.trimEnd().split('\n').length);
        assert.equal(table.bytes, Buffer.byteLength(body as string, 'utf8'));
        assert.equal(table.checksum, sha256Hex(body as string), 'the manifest checksum matches the stored bytes');
        totalRows += table.rows;
        totalBytes += table.bytes;
    }
    assert.equal(manifest.version, EXPORT_MANIFEST_VERSION);
    assert.equal(manifest.tenant_id, 'tenant-a');
    assert.equal(manifest.total_rows, totalRows);
    assert.equal(manifest.total_bytes, totalBytes);
    assert.ok(manifest.excluded.some((entry) => entry.includes('password_hash')));

    const completed = fixture.executed.find((e) => e.kind === 'execute' && e.sql.includes("SET status = 'completed'"));
    assert.ok(completed);
    assert.ok(completed.sql.includes('WHERE id = ? AND status = \'pending\''));
    assert.ok(fixture.audits.some((a) => a.action === 'tenant_export.completed'));
});

test('processTenantExport marks the job failed and audits when a table load fails', async () => {
    const fixture = makeServiceFixture();
    fixture.deps.db.queryOne = async <T = Record<string, unknown>>(sql: string): Promise<T | null> => {
        fixture.executed.push({ sql, params: [], kind: 'queryOne' });
        return { id: 'exp-fixed', tenant_id: 'tenant-a', status: 'pending' } as unknown as T;
    };
    fixture.failPlanQuery('lectures');
    await assert.rejects(() => processTenantExport(fixture.deps, 'exp-fixed'), /lectures unavailable/);

    const failed = fixture.executed.find((e) => e.kind === 'execute' && e.sql.includes("SET status = 'failed'"));
    assert.ok(failed);
    assert.ok(failed.params[0] === 'table lectures unavailable');
    assert.ok(fixture.audits.some((a) => a.action === 'tenant_export.failed'));
    assert.ok(!fixture.storage.has('tenant-exports/tenant-a/exp-fixed/manifest.json'), 'no manifest is published on failure');
});

test('processTenantExport never publishes an unaudited completion', async () => {
    const fixture = makeServiceFixture();
    fixture.deps.db.queryOne = async <T = Record<string, unknown>>(sql: string): Promise<T | null> => {
        fixture.executed.push({ sql, params: [], kind: 'queryOne' });
        return { id: 'exp-fixed', tenant_id: 'tenant-a', status: 'pending' } as unknown as T;
    };
    fixture.deps.audit = async (input) => {
        if (input.action === 'tenant_export.completed') throw new Error('audit store unavailable');
        fixture.audits.push({ action: input.action, resourceId: input.resourceId, reason: input.reason });
    };

    await assert.rejects(() => processTenantExport(fixture.deps, 'exp-fixed'), /audit store unavailable/);

    const completed = fixture.executed.find((e) => e.kind === 'execute' && e.sql.includes("SET status = 'completed'"));
    assert.ok(completed, 'the guarded completion write was attempted');
    const demoted = fixture.executed.find((e) => e.kind === 'execute' && e.sql.includes("SET status = 'failed'"));
    assert.ok(demoted, 'the completed row is demoted when its audit cannot be written');
    assert.ok(demoted.sql.includes("status IN ('pending', 'completed')"));
    assert.deepEqual(demoted.params.slice(1), ['exp-fixed', 'tenant-a']);
    assert.ok(!fixture.audits.some((a) => a.action === 'tenant_export.completed'));
});

test('processTenantExport refuses a job that is not pending', async () => {
    const fixture = makeServiceFixture();
    fixture.deps.db.queryOne = async <T = Record<string, unknown>>(sql: string): Promise<T | null> => {
        fixture.executed.push({ sql, params: [], kind: 'queryOne' });
        return { id: 'exp-fixed', tenant_id: 'tenant-a', status: 'completed' } as unknown as T;
    };
    await assert.rejects(() => processTenantExport(fixture.deps, 'exp-fixed'), /not pending/);
});

test('processTenantExport rejects an unknown job', async () => {
    const fixture = makeServiceFixture();
    await assert.rejects(() => processTenantExport(fixture.deps, 'exp-nope'), /does not exist/);
});

// ---------------------------------------------------------------------------
// W2 — ownership inferred from the proven parent, contradiction denial,
// declared coverage, and paged reads.
// ---------------------------------------------------------------------------

const planForSql = (sql: string): (typeof EXPORT_TABLE_PLAN)[number] | undefined =>
    EXPORT_TABLE_PLAN.find((plan) => sql.includes(`FROM \`${plan.table}\` t`) || sql.includes(`FROM ${plan.table} t`));

interface OwnershipFixture {
    deps: TenantExportDeps;
    storage: Map<string, string>;
    executed: Array<{ sql: string; params: unknown[]; kind: string }>;
    audits: string[];
    ids: string[];
    seed: (table: string, rows: Array<Record<string, unknown>>) => void;
}

/**
 * Data access that behaves like the ownership statement: it returns the seeded
 * rows for a planned table, honours the keyset cursor and the bound page size,
 * and classifies nothing itself — `__ownership` is part of the seeded result
 * set, exactly as the statement's CASE would return it.
 */
const makeOwnershipFixture = (
    seedRows: Record<string, Array<Record<string, unknown>>>,
    options: { pageSize?: number; maxRowsPerTable?: number; maxTotalBytes?: number } = {},
): OwnershipFixture => {
    const storage = new Map<string, string>();
    const executed: OwnershipFixture['executed'] = [];
    const audits: string[] = [];
    const seed = new Map<string, Array<Record<string, unknown>>>(
        Object.entries(seedRows).map(([table, rows]) => [table, [...rows]]),
    );
    const ids = [...seed.values()].flat().map((row) => String(row.id));
    const deps: TenantExportDeps = {
        db: {
            query: async <T = Record<string, unknown>>(sql: string, params: unknown[] = []) => {
                executed.push({ sql, params, kind: 'query' });
                const plan = planForSql(sql);
                if (!plan) {
                    if (sql.startsWith('SELECT COUNT(*) AS n FROM')) return [{ n: 0 }] as unknown as T[];
                    return [] as unknown as T[];
                }
                const cursorBound = sql.includes('AND t.id > ?');
                const pageSize = Number(params[params.length - 1]);
                const cursor = cursorBound ? String(params[params.length - 2]) : null;
                const rows = [...(seed.get(plan.table) ?? [])]
                    .sort((left, right) => String(left.id).localeCompare(String(right.id)))
                    .filter((row) => cursor === null || String(row.id) > cursor)
                    .slice(0, pageSize);
                return rows as unknown as T[];
            },
            queryOne: async <T = Record<string, unknown>>() =>
                ({ id: 'exp-fixed', tenant_id: 'tenant-a', status: 'pending' }) as unknown as T,
            execute: async () => ({ affectedRows: 1, insertId: 0 }),
        },
        storage: {
            write: async (key: string, body: string) => { storage.set(key, body); },
            read: async (key: string) => {
                const body = storage.get(key);
                if (body === undefined) throw new Error('object not found');
                return body;
            },
        },
        secret: VALID_SECRET,
        audit: async (input) => { audits.push(input.action); },
        now: () => NOW,
        newId: () => 'exp-fixed',
        limits: {
            ...(options.pageSize === undefined ? {} : { pageSize: options.pageSize }),
            ...(options.maxRowsPerTable === undefined ? {} : { maxRowsPerTable: options.maxRowsPerTable }),
            ...(options.maxTotalBytes === undefined ? {} : { maxTotalBytes: options.maxTotalBytes }),
        },
    };
    return {
        deps,
        storage,
        executed,
        audits,
        ids,
        seed: (table, rows) => { seed.set(table, rows); },
    };
};

const bodyOf = (fixture: OwnershipFixture, table: string): string => {
    const body = fixture.storage.get(`tenant-exports/tenant-a/exp-fixed/${table}.jsonl`);
    assert.ok(body !== undefined, `missing storage object for ${table}`);
    return body as string;
};

const tableCoverage = (manifest: ExportManifest, table: string) => {
    const entry = manifest.coverage.included.find((candidate) => candidate.table === table);
    assert.ok(entry, `missing coverage entry for ${table}`);
    return entry;
};

test('a row with a NULL tenant_id but a proven parent is exported (core regression)', async () => {
    const fixture = makeOwnershipFixture({
        courses: [owned({ id: 'c-1', name: 'Math', tenant_id: 'tenant-a' })],
        lectures: [owned({ id: 'l-null', course_id: 'c-1', group_id: null, tenant_id: null, title: 'Created after the backfill' })],
    });
    const manifest = await processTenantExport(fixture.deps, 'exp-fixed');

    const body = bodyOf(fixture, 'lectures');
    assert.equal(body.trimEnd().split('\n').length, 1, 'the NULL-tenant lecture is exported');
    const [row] = body.trimEnd().split('\n').map((line) => JSON.parse(line) as Record<string, unknown>);
    assert.equal(row.id, 'l-null');
    assert.equal(row.tenant_id, null, 'the row keeps its unset tenant_id; ownership came from the parent');
    assert.equal(row.__ownership, undefined, 'the classification column is never written to the export');

    const coverage = tableCoverage(manifest, 'lectures');
    assert.equal(coverage.rows, 1);
    assert.equal(coverage.basis, 'parent');
    assert.equal(coverage.parent, 'courses.id = lectures.course_id');
    assert.equal(manifest.incomplete, false);
    assert.equal(manifest.coverage.complete, false, 'the extract is still a declared subset, never a full snapshot');

    const lecturesPlan = EXPORT_TABLE_PLAN.find((plan) => plan.table === 'lectures');
    assert.ok(lecturesPlan);
    assert.ok(
        lecturesPlan.sql.includes('LEFT JOIN courses pc ON pc.id = t.course_id'),
        'ownership is proven through the course parent',
    );
    assert.ok(
        lecturesPlan.sql.includes('WHERE ((t.tenant_id = ?) OR (pc.tenant_id = ?))'),
        'a NULL direct tenant is resolved by the parent instead of being dropped by SQL =',
    );
    assert.ok(
        lecturesPlan.sql.includes('(t.tenant_id <> ?)'),
        'a direct tenant that contradicts the parent is detected',
    );
});

test('a direct tenant_id that contradicts the proven parent is rejected, not exported', async () => {
    const fixture = makeOwnershipFixture({
        courses: [owned({ id: 'c-1', tenant_id: 'tenant-a' })],
        lectures: [
            owned({ id: 'l-ok', course_id: 'c-1', tenant_id: 'tenant-a', title: 'Consistent' }),
            contradicted({ id: 'l-bad', course_id: 'c-1', tenant_id: 'tenant-b', title: 'Contradicting' }),
        ],
    });
    const manifest = await processTenantExport(fixture.deps, 'exp-fixed');

    const body = bodyOf(fixture, 'lectures');
    assert.ok(body.includes('l-ok'));
    assert.ok(!body.includes('l-bad'), 'the contradicting row is not exported');
    assert.ok(!body.includes('Contradicting'));

    const coverage = tableCoverage(manifest, 'lectures');
    assert.equal(coverage.rows, 1);
    assert.equal(coverage.rejected_contradictions, 1);
    assert.deepEqual(manifest.coverage.rejected.map((entry) => [entry.table, entry.rows]), [['lectures', 1]]);
    assert.match(manifest.coverage.rejected[0].reason, /another ownership authority/);
    assert.equal(manifest.incomplete, true, 'a rejected contradiction is a declared gap');
    assert.equal(manifest.total_rows, 2, 'one course plus one lecture; the rejected row never counts as exported');
});

test('ambiguous ownership (two parents disagree) is denied, never resolved by the first parent', async () => {
    const fixture = makeOwnershipFixture({
        courses: [owned({ id: 'c-1', tenant_id: 'tenant-a' })],
        groups: [owned({ id: 'g-other', tenant_id: 'tenant-b' })],
        lectures: [
            // No direct tenant_id: the course says tenant-a, the group says
            // tenant-b. Neither authority may be preferred.
            contradicted({ id: 'l-ambiguous', course_id: 'c-1', group_id: 'g-other', tenant_id: null, title: 'Ambiguous' }),
        ],
    });
    const manifest = await processTenantExport(fixture.deps, 'exp-fixed');

    const body = bodyOf(fixture, 'lectures');
    assert.equal(body, '', 'the ambiguous row is withheld');
    assert.ok(!body.includes('g-other'));
    assert.ok(!body.includes('Ambiguous'));

    const coverage = tableCoverage(manifest, 'lectures');
    assert.equal(coverage.rows, 0);
    assert.equal(coverage.rejected_contradictions, 1);
    assert.equal(coverage.authorities.length, 3, 'every authority is declared, none is dropped');
    assert.ok(coverage.authorities.includes('groups.tenant_id = lectures.group_id'));
    assert.equal(manifest.incomplete, true);

    const lecturesPlan = EXPORT_TABLE_PLAN.find((plan) => plan.table === 'lectures');
    assert.ok(lecturesPlan);
    assert.ok(lecturesPlan.sql.includes('(pg.tenant_id <> ?)'), 'the group authority can only deny');
    assert.ok(!lecturesPlan.sql.includes('LIMIT 1'), 'there is no first-row/first-parent selection');
    assert.ok(!/MIN\(|MAX\(/i.test(lecturesPlan.sql), 'no aggregation picks a winner among authorities');
});

test('the manifest publishes an explicit included/omitted coverage list with reasons', async () => {
    const fixture = makeOwnershipFixture({
        courses: [owned({ id: 'c-1', tenant_id: 'tenant-a' })],
    });
    const manifest = await processTenantExport(fixture.deps, 'exp-fixed');
    const { coverage } = manifest;

    assert.match(coverage.scope, /EXPORT_TABLE_PLAN/);
    assert.deepEqual(
        coverage.included.map((entry) => entry.table),
        EXPORT_TABLE_PLAN.map((plan) => plan.table),
        'every planned table is declared exactly once, in plan order',
    );
    assert.equal(new Set(coverage.included.map((entry) => entry.table)).size, EXPORT_TABLE_PLAN.length);
    for (const entry of coverage.included) {
        assert.ok(entry.basis === 'direct' || entry.basis === 'parent');
        assert.ok(entry.authorities.length >= 1);
        if (entry.basis === 'parent') assert.ok(entry.parent && entry.parent.length > 0);
        assert.equal(typeof entry.truncated, 'boolean');
        assert.ok(entry.pages >= 1);
    }

    assert.equal(coverage.omitted.length, 63, 'every tenant-scoped table outside the plan is named');
    assert.equal(new Set(coverage.omitted.map((entry) => entry.table)).size, 63);
    const includedTables = new Set(coverage.included.map((entry) => entry.table));
    for (const entry of coverage.omitted) {
        assert.ok(!includedTables.has(entry.table), `${entry.table} cannot be both included and omitted`);
        assert.ok(entry.reason.length > 20, `the omission of ${entry.table} carries a reason`);
    }
    const omittedNames = new Set(coverage.omitted.map((entry) => entry.table));
    assert.ok(omittedNames.has('audit_events'));
    assert.ok(omittedNames.has('attendance_records'));
    assert.ok(omittedNames.has('student_fees'));
    assert.ok(omittedNames.has('identity_otp_challenges'));

    const probed = coverage.omitted.find((entry) => entry.table === 'attendance_records');
    assert.ok(probed);
    assert.equal(probed.provable_rows, 0, 'the omission is proven, not guessed');
    assert.equal(probed.evidence, 'attendance_records.tenant_id IS NOT NULL');

    assert.deepEqual(
        coverage.omitted_children.map((entry) => entry.table),
        ['exam_results', 'group_courses', 'student_materials'],
        'children of exported rows are proven to exist through their planned parent',
    );
    for (const child of coverage.omitted_children) {
        assert.ok(child.evidence.includes('->'));
        assert.equal(child.provable_rows, 0);
    }

    assert.equal(coverage.complete, false);
    assert.ok(coverage.limitations.length >= 3);
    assert.ok(coverage.limitations.some((entry) => entry.includes('cannot be proven')));
    assert.ok(coverage.limitations.some((entry) => entry.includes('not a consistent point-in-time snapshot')));
    assert.ok(coverage.limitations.some((entry) => entry.includes('never reclaimed on age alone')));
});

test('certificates is declared as product-excluded, not as tenant content awaiting a decision', async () => {
    const fixture = makeOwnershipFixture({
        courses: [owned({ id: 'c-1', tenant_id: 'tenant-a' })],
    });
    const manifest = await processTenantExport(fixture.deps, 'exp-fixed');

    const certificates = manifest.coverage.omitted.find((entry) => entry.table === 'certificates');
    assert.ok(certificates, 'certificates stays declared as omitted');
    assert.equal(
        certificates.category,
        'product_excluded',
        'the manifest reason is the recorded product decision (owner, 2026-10-19)',
    );
    assert.ok(
        !manifest.coverage.included.some((entry) => entry.table === 'certificates'),
        'the product exclusion is not re-enabled as an export',
    );
    assert.equal(certificates.provable_rows, null, 'a product-excluded table is not probed and carries no count');
    assert.equal(certificates.evidence, null);

    const pendingDecision = manifest.coverage.omitted.find((entry) => entry.table === 'attendance_records');
    assert.ok(pendingDecision);
    assert.equal(pendingDecision.category, 'outside_plan', 'undecided tenant content keeps its own category');
    assert.notEqual(certificates.category, pendingDecision.category);
});

test('the coverage enumeration names every table at most once across all three lists', async () => {
    const fixture = makeOwnershipFixture({
        courses: [owned({ id: 'c-1', tenant_id: 'tenant-a' })],
    });
    const manifest = await processTenantExport(fixture.deps, 'exp-fixed');
    const { coverage } = manifest;

    const enumerated = [
        ...coverage.included.map((entry) => entry.table),
        ...coverage.omitted.map((entry) => entry.table),
        ...coverage.omitted_children.map((entry) => entry.table),
    ];
    assert.equal(new Set(enumerated).size, enumerated.length, 'no table appears twice in the enumerated coverage');
    assert.equal(enumerated.length, EXPORT_TABLE_PLAN.length + 63 + 3);

    // The certificates move must relocate the table, never duplicate it.
    assert.equal(coverage.omitted.filter((entry) => entry.table === 'certificates').length, 1);

    const perCategory = new Map<string, number>();
    for (const entry of coverage.omitted) {
        perCategory.set(entry.category, (perCategory.get(entry.category) ?? 0) + 1);
    }
    assert.deepEqual([...perCategory.entries()].sort(), [
        ['credential_secret', 6],
        ['operational_state', 13],
        ['outside_plan', 32],
        ['platform_finance', 11],
        ['product_excluded', 1],
    ]);
});

test('a row proven to belong to another tenant never appears in the output', async () => {
    const fixture = makeOwnershipFixture({
        courses: [owned({ id: 'c-1', tenant_id: 'tenant-a' })],
        students: [owned({ id: 's-1', tenant_id: 'tenant-a' })],
        lectures: [
            // A direct tenant_id claims the exporter while the proven parent
            // belongs to another institution: the content must be withheld.
            contradicted({ id: 'l-foreign', course_id: 'c-theirs', tenant_id: 'tenant-a', title: 'Other institution lecture' }),
        ],
    });
    await processTenantExport(fixture.deps, 'exp-fixed');

    for (const [key, body] of fixture.storage) {
        if (!key.endsWith('.jsonl')) continue;
        assert.ok(!body.includes('c-theirs'), `foreign course id leaked into ${key}`);
        assert.ok(!body.includes('Other institution lecture'), `foreign content leaked into ${key}`);
        assert.ok(!body.includes('tenant-b'), `foreign tenant id leaked into ${key}`);
    }
    assert.ok(!bodyOf(fixture, 'lectures').includes('l-foreign'));
    assert.ok(bodyOf(fixture, 'students').includes('s-1'), 'the tenant\'s own row is still exported');

    for (const statement of fixture.executed) {
        assert.ok(!statement.sql.includes('password_hash'));
        assert.ok(!/SELECT\s+\*/i.test(statement.sql));
    }
    for (const query of fixture.executed.filter((entry) => planForSql(entry.sql) !== undefined)) {
        assertTenantPinned(query, 'tenant-a', fixture.ids);
    }
});

test('a large table is read in keyset pages, not loaded whole', async () => {
    const lectures = Array.from({ length: 7 }, (_value, index) => owned({
        id: `l-0${index + 1}`,
        course_id: 'c-1',
        tenant_id: index % 2 === 0 ? 'tenant-a' : null,
        title: `Lecture ${index + 1}`,
    }));
    const fixture = makeOwnershipFixture({
        courses: [owned({ id: 'c-1', tenant_id: 'tenant-a' })],
        lectures,
    }, { pageSize: 3 });
    const manifest = await processTenantExport(fixture.deps, 'exp-fixed');

    const coverage = tableCoverage(manifest, 'lectures');
    assert.equal(coverage.rows, 7);
    assert.equal(coverage.pages, 3, 'seven rows at a page size of three need three reads');
    assert.equal(coverage.truncated, false);

    const pageQueries = fixture.executed.filter((entry) => entry.kind === 'query' && planForSql(entry.sql)?.table === 'lectures');
    assert.equal(pageQueries.length, 3);
    assert.equal(pageQueries[0].sql.includes('AND t.id > ?'), false, 'the first page has no cursor');
    assert.equal(pageQueries[1].sql.includes('AND t.id > ?'), true);
    assert.equal(pageQueries[2].sql.includes('AND t.id > ?'), true);
    assert.equal(pageQueries[1].params[pageQueries[1].params.length - 2], 'l-03');
    assert.equal(pageQueries[2].params[pageQueries[2].params.length - 2], 'l-06');
    for (const query of pageQueries) {
        assert.equal(query.params[query.params.length - 1], 3, 'the page size is bound per read');
        assertTenantPinned(query, 'tenant-a', fixture.ids);
    }

    const body = bodyOf(fixture, 'lectures');
    const ids = body.trimEnd().split('\n').map((line) => (JSON.parse(line) as { id: string }).id);
    assert.deepEqual(ids, ['l-01', 'l-02', 'l-03', 'l-04', 'l-05', 'l-06', 'l-07'], 'every page is written once, in keyset order');
});

test('the row and byte caps declare truncation instead of failing or over-reading', async () => {
    const lectures = Array.from({ length: 5 }, (_value, index) => owned({
        id: `l-0${index + 1}`,
        course_id: 'c-1',
        tenant_id: 'tenant-a',
    }));
    const fixture = makeOwnershipFixture({
        courses: [owned({ id: 'c-1', tenant_id: 'tenant-a' })],
        lectures,
    }, { pageSize: 2, maxRowsPerTable: 3 });
    const manifest = await processTenantExport(fixture.deps, 'exp-fixed');

    const coverage = tableCoverage(manifest, 'lectures');
    assert.equal(coverage.truncated, true, 'the row cap is declared, not hidden');
    assert.equal(coverage.rows, 3, 'the read stops at the cap instead of loading the table');
    assert.equal(manifest.incomplete, true);
    assert.equal(fixture.audits.includes('tenant_export.completed'), true, 'a declared truncation is not a failed job');
});

test('the total byte budget is a hard bound that never exceeds the cap', async () => {
    const fixture = makeOwnershipFixture({
        courses: [owned({ id: 'c-1', tenant_id: 'tenant-a', name: 'x'.repeat(200) })],
    }, { maxTotalBytes: 64 });
    const manifest = await processTenantExport(fixture.deps, 'exp-fixed');

    assert.ok(manifest.total_bytes <= 64, `wrote ${manifest.total_bytes} bytes against a 64-byte cap`);
    assert.equal(manifest.incomplete, true);
    assert.ok(manifest.coverage.included.some((entry) => entry.truncated));
});

// ---------------------------------------------------------------------------
// Download tokens and downloads
// ---------------------------------------------------------------------------

interface SeededJobState {
    tokenHash: string | null;
    status: string;
}

const seedCompletedJob = (
    fixture: ServiceFixture,
    overrides: { tenantId?: string; expiresAt?: number; exportId?: string } = {},
): SeededJobState => {
    const tenantId = overrides.tenantId ?? 'tenant-a';
    const exportId = overrides.exportId ?? 'exp-fixed';
    const expiresAt = overrides.expiresAt ?? NOW + 3_600_000;
    const state: SeededJobState = { tokenHash: null, status: 'completed' };
    const baseExecute = fixture.deps.db.execute;
    fixture.deps.db.execute = async (sql: string, params: unknown[] = []) => {
        const result = await baseExecute(sql, params);
        if (sql.includes('SET token_hash = ?')) state.tokenHash = String(params[0]);
        if (sql.includes("SET status = 'failed'")) state.status = 'failed';
        return result;
    };
    fixture.deps.db.queryOne = async <T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T | null> => {
        fixture.executed.push({ sql, params, kind: 'queryOne' });
        if (sql.includes('FROM tenant_data_exports')) {
            return {
                id: exportId,
                tenant_id: tenantId,
                status: state.status,
                storage_key: `tenant-exports/${tenantId}/${exportId}/manifest.json`,
                file_size: 128,
                manifest: null,
                expires_at: new Date(expiresAt).toISOString(),
                token_hash: state.tokenHash,
            } as unknown as T;
        }
        return null as T;
    };
    fixture.storage.set(`tenant-exports/${tenantId}/${exportId}/manifest.json`, '{"tables":[]}');
    return state;
};

test('issueExportDownloadToken signs an expiring token, stores only its hash and audits', async () => {
    const fixture = makeServiceFixture();
    seedCompletedJob(fixture);
    const issued = await issueExportDownloadToken(fixture.deps, {
        tenantId: 'tenant-a',
        exportId: 'exp-fixed',
        actorUserId: 'owner-a',
    });
    assert.equal(issued.ok, true);
    if (!issued.ok) return;
    assert.equal(issued.expiresAt, new Date((Math.floor(NOW / 1000) + EXPORT_DOWNLOAD_TOKEN_TTL_SECONDS) * 1000).toISOString());
    const [body, signature] = issued.token.split('.');
    assert.ok(body && signature && !signature.includes('.'));
    const hashUpdate = fixture.executed.find((e) => e.kind === 'execute' && e.sql.includes('SET token_hash = ?'));
    assert.ok(hashUpdate);
    assert.equal(hashUpdate.params[0], sha256Hex(issued.token), 'only the token hash is persisted');
    assert.ok(hashUpdate.sql.includes('AND tenant_id = ?'), 'the rotation is bound to the exact tenant');
    assert.ok(hashUpdate.sql.includes("AND status = 'completed'"));
    assert.deepEqual(hashUpdate.params.slice(1), ['exp-fixed', 'tenant-a'], 'the rotation is bound to the exact job');
    assert.ok(fixture.audits.some((a) => a.action === 'tenant_export.download_issued'));
});

test('issueExportDownloadToken is 404 for an unknown job and 410 after the window closed', async () => {
    const fixture = makeServiceFixture();
    seedCompletedJob(fixture, { expiresAt: NOW - 1000 });
    const expired = await issueExportDownloadToken(fixture.deps, {
        tenantId: 'tenant-a',
        exportId: 'exp-fixed',
        actorUserId: 'owner-a',
    });
    assert.equal(expired.ok, false);
    if (!expired.ok) assert.equal(expired.status, 410);

    fixture.deps.db.queryOne = async () => null;
    const missing = await issueExportDownloadToken(fixture.deps, {
        tenantId: 'tenant-a',
        exportId: 'exp-nope',
        actorUserId: 'owner-a',
    });
    assert.equal(missing.ok, false);
    if (!missing.ok) assert.equal(missing.status, 404);
});

test('issueExportDownloadToken rotates the persisted hash so the previous token stops verifying', async () => {
    const fixture = makeServiceFixture();
    let clock = NOW;
    fixture.deps.now = () => clock;
    seedCompletedJob(fixture);

    const first = await issueExportDownloadToken(fixture.deps, {
        tenantId: 'tenant-a',
        exportId: 'exp-fixed',
        actorUserId: 'owner-a',
    });
    assert.equal(first.ok, true);
    if (!first.ok) return;

    clock += 1_000;
    const second = await issueExportDownloadToken(fixture.deps, {
        tenantId: 'tenant-a',
        exportId: 'exp-fixed',
        actorUserId: 'owner-a',
    });
    assert.equal(second.ok, true);
    if (!second.ok) return;
    assert.notEqual(first.token, second.token);

    const rotated = await verifyExportDownloadToken(fixture.deps, { token: first.token, tenantId: 'tenant-a' });
    assert.equal(rotated.ok, false, 'the superseded token is invalidated');
    if (!rotated.ok) assert.equal(rotated.status, 403);

    const current = await verifyExportDownloadToken(fixture.deps, { token: second.token, tenantId: 'tenant-a' });
    assert.deepEqual(current, { ok: true, exportId: 'exp-fixed', tenantId: 'tenant-a' });
});

test('issueExportDownloadToken refuses to rotate a job that stopped being completed', async () => {
    const fixture = makeServiceFixture();
    seedCompletedJob(fixture);
    const baseExecute = fixture.deps.db.execute;
    fixture.deps.db.execute = async (sql: string, params: unknown[] = []) => {
        if (sql.includes('SET token_hash = ?')) return { affectedRows: 0 };
        return baseExecute(sql, params);
    };

    const result = await issueExportDownloadToken(fixture.deps, {
        tenantId: 'tenant-a',
        exportId: 'exp-fixed',
        actorUserId: 'owner-a',
    });
    assert.deepEqual(result, { ok: false, status: 409, error: 'The export is no longer available' });
    assert.ok(!fixture.audits.some((a) => a.action === 'tenant_export.download_issued'));
});

test('downloadTenantExport rejects a token whose signed export id differs from the requested id', async () => {
    const fixture = makeServiceFixture();
    seedCompletedJob(fixture);
    const issued = await issueExportDownloadToken(fixture.deps, {
        tenantId: 'tenant-a',
        exportId: 'exp-fixed',
        actorUserId: 'owner-a',
    });
    assert.equal(issued.ok, true);
    if (!issued.ok) return;

    const result = await downloadTenantExport(fixture.deps, {
        token: issued.token,
        tenantId: 'tenant-a',
        exportId: 'exp-other',
        actorUserId: 'owner-a',
    });
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.status, 403);
    assert.ok(
        fixture.audits.some((a) => a.action === 'tenant_export.download_denied' && a.reason?.includes('does not match')),
        'the id mismatch is audited',
    );
    assert.ok(!fixture.audits.some((a) => a.action === 'tenant_export.downloaded'));
});

test('verifyExportDownloadToken accepts a valid token and rejects tampered, wrong-secret, expired and cross-tenant tokens', async () => {
    const fixture = makeServiceFixture();
    seedCompletedJob(fixture);
    const issued = await issueExportDownloadToken(fixture.deps, {
        tenantId: 'tenant-a',
        exportId: 'exp-fixed',
        actorUserId: 'owner-a',
    });
    assert.equal(issued.ok, true);
    if (!issued.ok) return;
    const valid = issued.token;

    const accepted = await verifyExportDownloadToken(fixture.deps, { token: valid, tenantId: 'tenant-a' });
    assert.deepEqual(accepted, { ok: true, exportId: 'exp-fixed', tenantId: 'tenant-a' });

    const tampered = `${valid.slice(0, -2)}zz`;
    const wrongSignature = await verifyExportDownloadToken(fixture.deps, { token: tampered, tenantId: 'tenant-a' });
    assert.equal(wrongSignature.ok, false);
    if (!wrongSignature.ok) assert.equal(wrongSignature.status, 403);

    const wrongSecret = await verifyExportDownloadToken(
        { ...fixture.deps, secret: 'y'.repeat(40) },
        { token: valid, tenantId: 'tenant-a' },
    );
    assert.equal(wrongSecret.ok, false);
    if (!wrongSecret.ok) assert.equal(wrongSecret.status, 403);

    const expired = signExportToken(VALID_SECRET, { v: 1, e: 'exp-fixed', t: 'tenant-a', x: Math.floor(NOW / 1000) - 1 });
    const expiredResult = await verifyExportDownloadToken(fixture.deps, { token: expired, tenantId: 'tenant-a' });
    assert.equal(expiredResult.ok, false);
    if (!expiredResult.ok) assert.equal(expiredResult.status, 410);

    const crossTenant = signExportToken(VALID_SECRET, { v: 1, e: 'exp-fixed', t: 'tenant-b', x: Math.floor(NOW / 1000) + 600 });
    const crossTenantResult = await verifyExportDownloadToken(fixture.deps, { token: crossTenant, tenantId: 'tenant-a' });
    assert.equal(crossTenantResult.ok, false);
    if (!crossTenantResult.ok) assert.equal(crossTenantResult.status, 403);

    const malformed = await verifyExportDownloadToken(fixture.deps, { token: 'not-a-token', tenantId: 'tenant-a' });
    assert.equal(malformed.ok, false);
    if (!malformed.ok) assert.equal(malformed.status, 403);
});

test('verifyExportDownloadToken fails closed when unconfigured', async () => {
    const fixture = makeServiceFixture({ secret: undefined });
    const result = await verifyExportDownloadToken(fixture.deps, { token: 'a.b', tenantId: 'tenant-a' });
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.status, 503);
});

test('downloadTenantExport streams the stored manifest, audits the download and rejects invalid tokens', async () => {
    const fixture = makeServiceFixture();
    seedCompletedJob(fixture);
    const issued = await issueExportDownloadToken(fixture.deps, {
        tenantId: 'tenant-a',
        exportId: 'exp-fixed',
        actorUserId: 'owner-a',
    });
    assert.equal(issued.ok, true);
    if (!issued.ok) return;
    const valid = issued.token;

    const ok = await downloadTenantExport(fixture.deps, {
        token: valid,
        tenantId: 'tenant-a',
        exportId: 'exp-fixed',
        actorUserId: 'owner-a',
    });
    assert.equal(ok.ok, true);
    if (ok.ok) {
        assert.equal(ok.body, '{"tables":[]}');
        assert.equal(ok.byteSize, Buffer.byteLength('{"tables":[]}', 'utf8'));
    }
    const downloaded = fixture.audits.find((a) => a.action === 'tenant_export.downloaded');
    assert.ok(downloaded);
    assert.equal(downloaded.resourceId, 'exp-fixed');

    const forged = await downloadTenantExport(fixture.deps, {
        token: `${valid.slice(0, -2)}zz`,
        tenantId: 'tenant-a',
        exportId: 'exp-fixed',
        actorUserId: 'owner-a',
    });
    assert.equal(forged.ok, false);
    if (!forged.ok) assert.equal(forged.status, 403);
    assert.ok(fixture.audits.some((a) => a.action === 'tenant_export.download_denied'), 'denials are audied too');
});

test('downloadTenantExport is 410 when the stored object is gone', async () => {
    const fixture = makeServiceFixture();
    seedCompletedJob(fixture);
    const issued = await issueExportDownloadToken(fixture.deps, {
        tenantId: 'tenant-a',
        exportId: 'exp-fixed',
        actorUserId: 'owner-a',
    });
    assert.equal(issued.ok, true);
    if (!issued.ok) return;
    fixture.storage.clear();
    const result = await downloadTenantExport(fixture.deps, {
        token: issued.token,
        tenantId: 'tenant-a',
        exportId: 'exp-fixed',
        actorUserId: 'owner-a',
    });
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.status, 410);
    assert.ok(fixture.audits.some((a) => a.action === 'tenant_export.download_denied'), 'the missing object is audited');
});

// ---------------------------------------------------------------------------
// Route: allow / deny / platform scope / validation / failure
// ---------------------------------------------------------------------------

const OWNER = tokenFor({ id: 'owner-a', role: 'instructor', tv: 0 });
const OWNER_B = tokenFor({ id: 'owner-b', role: 'instructor', tv: 0 });
const PLATFORM = tokenFor({ id: 'admin-a', role: 'admin', tv: 0 });
const STAFF = tokenFor({ id: 'staff-a', role: 'instructor', tv: 0 });

const COMPLETED_JOB = {
    id: 'exp-1',
    tenant_id: 'tenant-a',
    status: 'completed',
    storage_key: 'tenant-exports/tenant-a/exp-1/manifest.json',
    file_size: 256,
    manifest: { version: 1, tables: [{ table: 'courses', rows: 1, bytes: 10, checksum: 'x' }] },
    expires_at: new Date(Date.now() + 3_600_000).toISOString(),
    created_at: new Date(Date.now() - 600_000).toISOString(),
    completed_at: new Date(Date.now() - 300_000).toISOString(),
    error: null,
};

interface RouteFixture {
    router: Router;
    db: TenantExportDataAccess;
    storage: Map<string, string>;
    audits: string[];
    executed: Array<{ sql: string; params: unknown[]; kind: string }>;
    setSecret: (secret: string | undefined) => void;
    tenants: Record<string, string>;
    jobs: Map<string, Record<string, unknown>>;
    seedJob: (job: Record<string, unknown>) => void;
}

const makeRouteFixture = () => {
    const storage = new Map<string, string>([['tenant-exports/tenant-a/exp-1/manifest.json', '{"version":1}']]);
    const audits: string[] = [];
    const executed: RouteFixture['executed'] = [];
    const tenants: Record<string, string> = { 'tenant-a': 'active', 'tenant-b': 'active' };
    let secret: string | undefined = VALID_SECRET;
    const exportJobs = new Map<string, Record<string, unknown>>([
        ['exp-1', COMPLETED_JOB],
        ['exp-b', { ...COMPLETED_JOB, id: 'exp-b', tenant_id: 'tenant-b' }],
    ]);
    const tableRows: Record<string, Array<Record<string, unknown>>> = {
        courses: [owned({ id: 'c-1', name: 'Math', tenant_id: 'tenant-a' })],
        students: [owned({ id: 's-1', name: 'Student One', tenant_id: 'tenant-a' })],
    };
    const deps = {
        db: {
            query: async <T = Record<string, unknown>>(sql: string, params: unknown[] = []) => {
                executed.push({ sql, params, kind: 'query' });
                if (sql.includes('FROM tenants')) {
                    const id = String(params[0]);
                    return (tenants[id] ? [{ id, status: tenants[id] }] : []) as unknown as T[];
                }
                if (sql.includes("AND status = 'pending' LIMIT 1")) return [] as unknown as T[];
                if (sql.includes('ORDER BY created_at DESC LIMIT 1')) return [] as unknown as T[];
                if (sql.startsWith('SELECT id, tenant_id, status FROM tenant_data_exports')) {
                    const job = exportJobs.get(String(params[0]));
                    return (job ? [job] : []) as unknown as T[];
                }
                if (sql.includes('FROM tenant_data_exports WHERE id = ?')) {
                    const job = exportJobs.get(String(params[0]));
                    return (job ? [job] : []) as unknown as T[];
                }
                if (sql.includes('FROM tenant_data_exports')) {
                    if (sql.includes('ORDER BY created_at DESC LIMIT 50')) {
                        const tenantId = String(params[0]);
                        return [...exportJobs.values()].filter((job) => job.tenant_id === tenantId) as unknown as T[];
                    }
                    const id = String(params[0]);
                    const job = exportJobs.get(id);
                    return (job ? [job] : []) as unknown as T[];
                }
                const plan = EXPORT_TABLE_PLAN.find((entry) => sql === entry.sql);
                if (plan) return (tableRows[plan.table] ?? []) as unknown as T[];
                return [] as unknown as T[];
            },
            queryOne: async <T = Record<string, unknown>>(sql: string, params: unknown[] = []) => {
                executed.push({ sql, params, kind: 'queryOne' });
                if (sql.includes("AND status = 'pending' LIMIT 1")) return null;
                if (sql.includes('ORDER BY created_at DESC LIMIT 1')) return null;
                if (sql.includes('FROM tenants')) {
                    const id = String(params[0]);
                    return (tenants[id] ? { id, status: tenants[id] } : null) as unknown as T | null;
                }
                if (sql.startsWith('SELECT id, tenant_id, status FROM tenant_data_exports')) {
                    const job = exportJobs.get(String(params[0]));
                    return (job ?? null) as unknown as T | null;
                }
                if (sql.includes('FROM tenant_data_exports')) {
                    const job = exportJobs.get(String(params[0]));
                    return (job ?? null) as unknown as T | null;
                }
                return null;
            },
            execute: async (sql: string, params: unknown[] = []) => {
                executed.push({ sql, params, kind: 'execute' });
                if (sql.includes('INSERT INTO audit_events')) {
                    const action = String(params[3] ?? '');
                    audits.push(action);
                }
                if (sql.includes('INSERT INTO tenant_data_exports')) {
                    const [id, tenantId, actorUserId] = params.map(String);
                    exportJobs.set(id, {
                        id,
                        tenant_id: tenantId,
                        status: 'pending',
                        requested_by: actorUserId,
                        storage_key: null,
                        file_size: null,
                        manifest: null,
                        expires_at: null,
                        created_at: new Date(NOW).toISOString(),
                        completed_at: null,
                        error: null,
                    });
                }
                if (sql.includes("SET status = 'completed'")) {
                    const [storageKey, fileSize, manifest, expiresAt, id, tenantId] = params;
                    const existing = exportJobs.get(String(id));
                    if (existing?.status === 'pending' && existing.tenant_id === tenantId) {
                        Object.assign(existing, {
                            status: 'completed', storage_key: storageKey, file_size: fileSize,
                            manifest: JSON.parse(String(manifest)), expires_at: expiresAt,
                            completed_at: new Date(NOW).toISOString(),
                        });
                    }
                }
                if (sql.includes("SET status = 'failed'")) {
                    const [reason, id, tenantId] = params;
                    const existing = exportJobs.get(String(id));
                    if (existing && existing.tenant_id === tenantId) {
                        Object.assign(existing, { status: 'failed', error: reason });
                    }
                }
                if (sql.includes('SET token_hash = ?')) {
                    const [tokenHash, id, tenantId] = params;
                    const existing = exportJobs.get(String(id));
                    if (existing && existing.tenant_id === tenantId && existing.status === 'completed') {
                        existing.token_hash = tokenHash;
                    }
                }
                return { affectedRows: 1, insertId: 0 };
            },
        },
        authenticate: createAuthenticateToken(makeRepository({
            'owner-a': { is_active: 1, token_version: 0, suspension_active: 0, role: 'instructor' },
            'owner-b': { is_active: 1, token_version: 0, suspension_active: 0, role: 'instructor' },
            'admin-a': { is_active: 1, token_version: 0, suspension_active: 0, role: 'admin' },
            'staff-a': { is_active: 1, token_version: 0, suspension_active: 0, role: 'instructor' },
        }, {
            instructorAccounts: {
                'owner-a': { tenant_status: 'active', legacy_compat: 1, allowed: 1 },
                'owner-b': { tenant_status: 'active', legacy_compat: 1, allowed: 1 },
                'staff-a': { tenant_status: 'active', legacy_compat: 1, allowed: 1 },
            },
            memberships: {
                'owner-a': [{ tenant_id: 'tenant-a' }],
                'owner-b': [{ tenant_id: 'tenant-b' }],
                'staff-a': [{ tenant_id: 'tenant-a' }],
            },
        })),
        requirePlatformPermission: () => async (_req, _res, next) => next(),
        hasPlatformPermission: async (userId) => userId === 'admin-a',
        tenantOwnerTenantId: async (userId, tenantId) =>
            (userId === 'owner-a' && tenantId === 'tenant-a') || (userId === 'owner-b' && tenantId === 'tenant-b'),
        storage: {
            write: async (key: string, body: string) => { storage.set(key, body); },
            read: async (key: string) => {
                const body = storage.get(key);
                if (body === undefined) throw new Error('object not found');
                return body;
            },
        },
        get secret() { return secret; },
        set secret(value: string | undefined) { secret = value; },
    };
    // Routes use the system clock unless an injected service clock is available;
    // keep seeded download windows comfortably in the future for this fixture.
    const router: Router = createTenantExportRouter(deps);
    return {
        router,
        db: deps.db,
        storage,
        audits,
        executed,
        setSecret: (value: string | undefined) => { secret = value; },
        tenants,
        jobs: exportJobs,
        seedJob: (job) => { exportJobs.set(String(job.id), job); },
    };
};

const invoke = async (
    router: Router,
    request: { method: string; url: string; token?: string; body?: unknown; query?: Record<string, string> },
): Promise<{ statusCode?: number; body?: unknown; headers?: Record<string, string> }> => {
    // The shared route harness predates this Express download route and does
    // not model res.send; wrap the router to add the minimal equivalent before
    // its async handler starts.
    const sendCapableRouter = ((req: unknown, res: Response, next: NextFunction) => {
        if (typeof res.send !== 'function') {
            res.send = (payload: unknown) => res.json(payload);
        }
        return (router as unknown as (r: unknown, s: unknown, n: (error?: unknown) => void) => unknown)(req, res, next);
    }) as unknown as Router;
    return invokeRoute(sendCapableRouter, request as never);
};

test('tenant export route: an owner export is created, processed and audited tenant-pinned', async () => {
    const fixture = makeRouteFixture();
    const response = await invoke(fixture.router, { method: 'POST', url: '/', token: OWNER, body: {} });
    assert.equal(response.statusCode, 201);
    const body = response.body as { id: string; status: string; manifest: { tables: unknown[]; total_rows: number } };
    assert.equal(body.status, 'completed');
    assert.ok(body.manifest.tables.length >= 15, 'the completeness manifest covers the plan');

    const planQueries = fixture.executed.filter((e) => e.kind === 'query' && EXPORT_TABLE_PLAN.some((p) => p.sql === e.sql));
    assert.equal(planQueries.length, EXPORT_TABLE_PLAN.length);
    for (const query of planQueries) {
        assertTenantPinned(query, 'tenant-a');
    }
    for (const statement of fixture.executed) {
        assert.ok(!statement.sql.includes('password_hash'));
        assert.ok(!/SELECT\s+\*/i.test(statement.sql));
    }
    assert.ok(fixture.audits.includes('tenant_export.requested'));
    assert.ok(fixture.audits.includes('tenant_export.completed'));
});

test('tenant export route: a platform actor may export another tenant by name', async () => {
    const fixture = makeRouteFixture();
    const response = await invoke(fixture.router, {
        method: 'POST',
        url: '/',
        token: PLATFORM,
        body: { tenant_id: 'tenant-b' },
    });
    assert.equal(response.statusCode, 201);
    const planQueries = fixture.executed.filter((e) => e.kind === 'query' && EXPORT_TABLE_PLAN.some((p) => p.sql === e.sql));
    for (const query of planQueries) {
        assertTenantPinned(query, 'tenant-b');
    }
});

test('tenant export route: platform requires a tenant target and rejects unknown tenants', async () => {
    const fixture = makeRouteFixture();
    const missing = await invoke(fixture.router, { method: 'POST', url: '/', token: PLATFORM, body: {} });
    assert.equal(missing.statusCode, 400);

    fixture.tenants['tenant-b'] = 'missing';
    const unknown = await invoke(fixture.router, {
        method: 'POST',
        url: '/',
        token: PLATFORM,
        body: { tenant_id: 'tenant-b' },
    });
    assert.equal(unknown.statusCode, 404);
});

test('tenant export route: a non-owner member is forbidden and the surface fails closed without a secret', async () => {
    const fixture = makeRouteFixture();
    const forbidden = await invoke(fixture.router, { method: 'POST', url: '/', token: STAFF, body: {} });
    assert.equal(forbidden.statusCode, 403);

    const ownTenant = await invoke(fixture.router, { method: 'POST', url: '/', token: OWNER_B, body: {} });
    assert.equal(ownTenant.statusCode, 201, 'owner-b is scoped to and may export tenant-b');
    const ownerBPlanQueries = fixture.executed.filter((e) => e.kind === 'query' && EXPORT_TABLE_PLAN.some((p) => p.sql === e.sql));
    assert.ok(ownerBPlanQueries.some((query) => query.params[0] === 'tenant-b'));

    const unconfiguredFixture = makeRouteFixture();
    unconfiguredFixture.setSecret(undefined);
    const unconfigured = await invoke(unconfiguredFixture.router, { method: 'POST', url: '/', token: OWNER, body: {} });
    assert.equal(unconfigured.statusCode, 503);
    assert.ok(unconfiguredFixture.audits.includes('tenant_export.request_denied'));
});

test('tenant export route: database failures surface as 500', async () => {
    const fixture = makeRouteFixture();
    fixture.router = createTenantExportRouter({
        db: {
            query: async () => { throw new Error('database unavailable'); },
            queryOne: async () => { throw new Error('database unavailable'); },
            execute: async () => ({ affectedRows: 1 }),
        },
        authenticate: createAuthenticateToken(makeRepository({
            'owner-a': { is_active: 1, token_version: 0, suspension_active: 0, role: 'instructor' },
        }, {
            instructorAccounts: { 'owner-a': { tenant_status: 'active', legacy_compat: 1, allowed: 1 } },
            memberships: { 'owner-a': [{ tenant_id: 'tenant-a' }] },
        })),
        requirePlatformPermission: () => async (_req, _res, next) => next(),
        hasPlatformPermission: async () => false,
        tenantOwnerTenantId: async () => true,
        storage: { write: async () => undefined, read: async () => '' },
        secret: VALID_SECRET,
    });
    const response = await invoke(fixture.router, { method: 'POST', url: '/', token: OWNER, body: {} });
    assert.equal(response.statusCode, 500);
});

test('tenant export route: status, download-token and signed download with audience checks', async () => {
    const fixture = makeRouteFixture();

    const anonStatus = await invoke(fixture.router, { method: 'GET', url: '/exp-1' });
    assert.equal(anonStatus.statusCode, 401);

    const status = await invoke(fixture.router, { method: 'GET', url: '/exp-1', token: OWNER });
    assert.equal(status.statusCode, 200);
    const statusBody = status.body as { id: string; status: string; manifest: unknown };
    assert.equal(statusBody.status, 'completed');
    assert.ok(statusBody.manifest, 'the completeness manifest is returned');

    const foreignStatus = await invoke(fixture.router, { method: 'GET', url: '/exp-1', token: OWNER_B });
    assert.equal(foreignStatus.statusCode, 403);

    const tokenResponse = await invoke(fixture.router, {
        method: 'POST',
        url: '/exp-1/download-token',
        token: OWNER,
        body: {},
    });
    assert.equal(tokenResponse.statusCode, 200);
    const tokenBody = tokenResponse.body as { token: string };
    assert.ok(tokenBody.token.includes('.'));

    const download = await invoke(fixture.router, {
        method: 'GET',
        url: `/exp-1/download?token=${encodeURIComponent(tokenBody.token)}`,
        token: OWNER,
        query: { token: tokenBody.token },
    });
    assert.equal(download.statusCode, 200);
    assert.match(download.headers?.['content-disposition'] ?? '', /attachment/);
    assert.equal(download.body, '{"version":1}');
    assert.ok(fixture.audits.includes('tenant_export.downloaded'));

    const forged = await invoke(fixture.router, {
        method: 'GET',
        url: '/exp-1/download?token=forged',
        token: OWNER,
        query: { token: 'forged' },
    });
    assert.equal(forged.statusCode, 403);
    assert.ok(fixture.audits.includes('tenant_export.download_denied'));

    const crossTenantDownload = await invoke(fixture.router, {
        method: 'GET',
        url: '/exp-1/download?token=x.y',
        token: OWNER_B,
        query: { token: 'x.y' },
    });
    assert.equal(crossTenantDownload.statusCode, 403, 'owner-b cannot download tenant-a exports');
});

test('tenant export route: a token for another export of the same tenant cannot download the requested id', async () => {
    const fixture = makeRouteFixture();
    fixture.seedJob({
        ...COMPLETED_JOB,
        id: 'exp-2',
        storage_key: 'tenant-exports/tenant-a/exp-2/manifest.json',
    });
    fixture.storage.set('tenant-exports/tenant-a/exp-2/manifest.json', '{"version":2}');

    const tokenResponse = await invoke(fixture.router, {
        method: 'POST',
        url: '/exp-2/download-token',
        token: OWNER,
        body: {},
    });
    assert.equal(tokenResponse.statusCode, 200);
    const token = (tokenResponse.body as { token: string }).token;

    const response = await invoke(fixture.router, {
        method: 'GET',
        url: `/exp-1/download?token=${encodeURIComponent(token)}`,
        token: OWNER,
        query: { token },
    });
    assert.equal(response.statusCode, 403);
    assert.ok(fixture.audits.includes('tenant_export.download_denied'));
    assert.ok(!fixture.audits.includes('tenant_export.downloaded'));
});

test('tenant export route: an audit failure does not leave a stuck pending job or a false success', async () => {
    const fixture = makeRouteFixture();
    const baseExecute = fixture.db.execute;
    fixture.db.execute = async (sql: string, params: unknown[] = []) => {
        if (sql.includes('INSERT INTO audit_events')) throw new Error('audit store unavailable');
        return baseExecute(sql, params);
    };

    const response = await invoke(fixture.router, { method: 'POST', url: '/', token: OWNER, body: {} });
    assert.equal(response.statusCode, 500);
    const jobs = [...fixture.jobs.values()].filter((job) => job.tenant_id === 'tenant-a');
    const recovered = jobs.filter((job) => job.status === 'failed');
    assert.equal(recovered.length, 1, 'the un-audited request is not left pending');
    assert.match(String(recovered[0].error), /not audited/);
    assert.ok(!fixture.audits.includes('tenant_export.requested'));
});

test('tenant export route: the owner lists only the jobs of the export tenant', async () => {
    const fixture = makeRouteFixture();
    const response = await invoke(fixture.router, { method: 'GET', url: '/', token: OWNER });
    assert.equal(response.statusCode, 200);
    const jobs = response.body as Array<{ tenant_id: string }>;
    assert.equal(jobs.length, 1);
    for (const job of jobs) assert.equal(job.tenant_id, 'tenant-a');

    const otherTenantResponse = await invoke(fixture.router, { method: 'GET', url: '/', token: OWNER_B });
    assert.equal(otherTenantResponse.statusCode, 200);
    const otherTenantJobs = otherTenantResponse.body as Array<{ tenant_id: string }>;
    assert.ok(otherTenantJobs.length > 0);
    for (const job of otherTenantJobs) assert.equal(job.tenant_id, 'tenant-b');
});
