/** Explicit, read-only catalog measurement. Import and construction perform no I/O. */
import type { TenantExportDataAccess } from './tenant-export';

const VERSION = 'tenant-export-ownership-20261025-1';
const MAX_AGE_MS = 15 * 60_000;
export interface TenantExportSchemaReport {
    readonly contract: typeof VERSION;
    readonly status: 'verified' | 'unavailable';
    readonly checkedAtMs: number;
    readonly reason: string | null;
}
const issuers = new WeakMap<object, object>();

/** Recognize boolean structure, preserving parentheses and operator precedence. */
const expression = (source: string): string | null => {
    if (source.length > 4096) return null;
    const tokens: string[] = [];
    const lexer = /\s+|`[a-z_][a-z0-9_]*`|[a-z_][a-z0-9_]*|\d+|<=|>=|<>|!=|[=><(),]/giy;
    let offset = 0;
    while (offset < source.length) {
        lexer.lastIndex = offset;
        const next = lexer.exec(source);
        if (!next) return null;
        offset = lexer.lastIndex;
        if (!/^\s+$/.test(next[0])) tokens.push(next[0].replace(/`/g, '').toLowerCase());
    }
    let cursor = 0;
    const precedence: Record<string, number> = { or: 1, and: 2, '=': 3, '<=': 3, '>': 3 };
    const parse = (minimum = 0): string => {
        let left: string;
        const token = tokens[cursor++];
        if (token === '(') {
            left = parse();
            if (tokens[cursor++] !== ')') throw new Error('parentheses');
        } else if (token === 'char_length') {
            if (tokens[cursor++] !== '(') throw new Error('function');
            left = `char_length(${parse()})`;
            if (tokens[cursor++] !== ')') throw new Error('function');
        } else if (token && /^[a-z_][a-z0-9_]*$|^\d+$/.test(token) && !['and', 'or', 'is', 'null'].includes(token)) {
            left = token;
        } else throw new Error('atom');
        if (tokens[cursor] === 'is') {
            cursor += 1;
            if (tokens[cursor++] !== 'null') throw new Error('null');
            left = `isnull(${left})`;
        }
        while (cursor < tokens.length) {
            const operator = tokens[cursor];
            const priority = precedence[operator];
            if (priority === undefined || priority < minimum) break;
            cursor += 1;
            left = `${operator}(${left},${parse(priority + 1)})`;
        }
        return left;
    };
    try { const value = parse(); return cursor === tokens.length ? value : null; }
    catch { return null; }
};

const catalogInteger = (value: unknown): number | null => {
    if (typeof value !== 'number' && !(typeof value === 'string' && /^\d+$/.test(value))) return null;
    const number = Number(value);
    return Number.isSafeInteger(number) && number >= 0 ? number : null;
};

const checks: Record<string, string> = {
    chk_tenant_export_owner_pair: '(export_owner IS NULL) = (owner_lease_until_ms IS NULL)',
    chk_tenant_export_owner_epoch: 'owner_epoch <= 9007199254740991',
    chk_tenant_export_owner_lease: 'owner_lease_until_ms IS NULL OR owner_lease_until_ms <= 9007199254740991',
    chk_tenant_export_owner_claim: 'export_owner IS NULL OR (CHAR_LENGTH(export_owner) > 0 AND owner_epoch > 0)',
};

/** Caller must invoke explicitly before construction; a typed object cannot impersonate this result. */
export const verifyTenantExportOwnershipSchema = async (
    db: TenantExportDataAccess,
    now: () => number = Date.now,
): Promise<TenantExportSchemaReport> => {
    let status: TenantExportSchemaReport['status'] = 'unavailable';
    let reason: string | null = 'catalog verification did not complete';
    let checkedAtMs = 0;
    try {
        if (!db || typeof db.transaction !== 'function') throw new Error('transaction');
        await db.transaction(async tx => {
            const current = await tx.queryOne<{ db: string }>('SELECT DATABASE() AS db');
            if (!current || typeof current.db !== 'string' || !current.db) throw new Error('database');
            const table = await tx.queryOne<{ ENGINE: string }>(
                'SELECT ENGINE FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?',
                [current.db, 'tenant_data_exports'],
            );
            if (table?.ENGINE?.toLowerCase() !== 'innodb') throw new Error('engine');
            const columns = await tx.query<Record<string, unknown>>(
                'SELECT COLUMN_NAME, DATA_TYPE, COLUMN_TYPE, IS_NULLABLE, CHARACTER_MAXIMUM_LENGTH, CHARACTER_SET_NAME, COLLATION_NAME, COLUMN_DEFAULT, EXTRA FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?',
                [current.db, 'tenant_data_exports'],
            );
            const byName = new Map(columns.map(row => [String(row.COLUMN_NAME), row]));
            const owner = byName.get('export_owner');
            if (!owner || owner.DATA_TYPE !== 'varchar' || catalogInteger(owner.CHARACTER_MAXIMUM_LENGTH) !== 128
                || owner.IS_NULLABLE !== 'YES' || owner.CHARACTER_SET_NAME !== 'utf8mb4'
                || owner.COLLATION_NAME !== 'utf8mb4_0900_bin' || owner.COLUMN_DEFAULT !== null || owner.EXTRA !== '') throw new Error('owner');
            for (const name of ['owner_epoch', 'owner_lease_until_ms']) {
                const column = byName.get(name);
                if (!column || column.DATA_TYPE !== 'bigint' || !/^bigint(?:\(\d+\))? unsigned$/i.test(String(column.COLUMN_TYPE))
                    || column.IS_NULLABLE !== (name === 'owner_epoch' ? 'NO' : 'YES') || column.EXTRA !== ''
                    || (name === 'owner_epoch' ? String(column.COLUMN_DEFAULT) !== '0' : column.COLUMN_DEFAULT !== null)) throw new Error('integer');
            }
            const pad = await tx.queryOne<{ PAD_ATTRIBUTE: string }>(
                'SELECT PAD_ATTRIBUTE FROM information_schema.COLLATIONS WHERE COLLATION_NAME = ?', ['utf8mb4_0900_bin'],
            );
            if (pad?.PAD_ATTRIBUTE !== 'NO PAD') throw new Error('collation');
            const constraints = await tx.query<{ CONSTRAINT_NAME: string; ENFORCED: string; CHECK_CLAUSE: string }>(
                'SELECT tc.CONSTRAINT_NAME, tc.ENFORCED, cc.CHECK_CLAUSE FROM information_schema.TABLE_CONSTRAINTS tc INNER JOIN information_schema.CHECK_CONSTRAINTS cc ON cc.CONSTRAINT_SCHEMA = tc.CONSTRAINT_SCHEMA AND cc.CONSTRAINT_NAME = tc.CONSTRAINT_NAME WHERE tc.TABLE_SCHEMA = ? AND tc.TABLE_NAME = ? AND tc.CONSTRAINT_TYPE = ?',
                [current.db, 'tenant_data_exports', 'CHECK'],
            );
            for (const [name, expected] of Object.entries(checks)) {
                const rows = constraints.filter(row => row.CONSTRAINT_NAME === name);
                if (expression(expected) === null || rows.length !== 1 || rows[0].ENFORCED !== 'YES' || typeof rows[0].CHECK_CLAUSE !== 'string'
                    || expression(rows[0].CHECK_CLAUSE) !== expression(expected)) throw new Error('constraint');
            }
            const primary = await tx.query<{ COLUMN_NAME: string; SEQ_IN_INDEX: number | string; SUB_PART: number | null; NON_UNIQUE: number | string }>(
                'SELECT COLUMN_NAME, SEQ_IN_INDEX, SUB_PART, NON_UNIQUE FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND INDEX_NAME = ?',
                [current.db, 'tenant_data_exports', 'PRIMARY'],
            );
            if (primary.length !== 1 || primary[0].COLUMN_NAME !== 'id' || catalogInteger(primary[0].SEQ_IN_INDEX) !== 1
                || primary[0].SUB_PART !== null || catalogInteger(primary[0].NON_UNIQUE) !== 0) throw new Error('primary');
        });
        checkedAtMs = now();
        if (!Number.isSafeInteger(checkedAtMs) || checkedAtMs <= 0) throw new Error('clock');
        status = 'verified'; reason = null;
    } catch { reason = 'ownership schema could not be proven: catalog unavailable or required shape/constraint differs'; }
    const report = Object.freeze({ contract: VERSION, status, checkedAtMs, reason });
    if (status === 'verified') issuers.set(report, db);
    return report;
};

export const isTenantExportSchemaReportFor = (report: unknown, db: TenantExportDataAccess, nowMs: number): report is TenantExportSchemaReport => {
    if (!report || typeof report !== 'object' || issuers.get(report) !== db) return false;
    const value = report as TenantExportSchemaReport;
    const age = nowMs - value.checkedAtMs;
    return value.contract === VERSION && value.status === 'verified' && Number.isFinite(age) && age >= 0 && age <= MAX_AGE_MS;
};
