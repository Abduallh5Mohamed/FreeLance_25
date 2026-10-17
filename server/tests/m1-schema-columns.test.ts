import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

const readMigration = (fileName: string): string =>
    readFileSync(join(__dirname, '../migrations', fileName), 'utf8');

const columnsMigration = readMigration('20261017_03_missing_columns_enums.sql');
const tenantMigration = readMigration('20261017_04_tenant_columns_backfill.sql');

// Lexical validation only: this does not execute SQL or prove MySQL grammar.
// In particular it catches unterminated literals inside prepared statements.
const hasBalancedSqlQuotes = (sql: string): boolean => {
    let quote: string | null = null;
    for (let index = 0; index < sql.length; index += 1) {
        const char = sql[index];
        if (!quote && char === '-' && sql[index + 1] === '-') {
            const nextLine = sql.indexOf('\n', index);
            if (nextLine < 0) break;
            index = nextLine;
            continue;
        }
        if (quote && char === '\\') { index += 1; continue; }
        if (quote && char === quote) {
            if (sql[index + 1] === quote) index += 1;
            else quote = null;
        } else if (!quote && (char === "'" || char === '"' || char === '`')) {
            quote = char;
        }
    }
    return quote === null;
};

test('prepared migration SQL literals close correctly, including the enum comparison', () => {
    assert.equal(hasBalancedSqlQuotes(columnsMigration), true);
    assert.equal(hasBalancedSqlQuotes(tenantMigration), true);
    assert.equal(hasBalancedSqlQuotes("SELECT 'enum(''in_progress'',''abandoned'')'"), true);
    assert.equal(hasBalancedSqlQuotes("SELECT 'enum(''in_progress'',''abandoned'')"), false);
    for (const value of ['in_progress', 'completed', 'abandoned', 'passed', 'failed', 'pending_review']) {
        assert.ok(columnsMigration.includes(`AND LOCATE('''${value}''', @status_type) > 0`));
    }
});

test('missing route-used schema columns are guarded and preserve legacy meeting links', () => {
    const columns = [
        ['exams', 'grade_id'],
        ['exams', 'start_dt'],
        ['exams', 'end_dt'],
        ['online_meetings', 'meeting_link'],
        ['online_meetings', 'meeting_type'],
        ['online_meetings', 'grade_id'],
        ['videos', 'encryption_key'],
        ['videos', 'is_encrypted'],
        ['exam_attempts', 'essay_scores'],
    ] as const;

    for (const [table, column] of columns) {
        assert.ok(
            columnsMigration.includes(`TABLE_NAME = '${table}' AND COLUMN_NAME = '${column}'`),
            `${table}.${column} must have an INFORMATION_SCHEMA guard`,
        );
    }

    assert.match(columnsMigration, /UPDATE online_meetings\s+SET meeting_link = meeting_url\s+WHERE meeting_link IS NULL/);
    assert.ok(columnsMigration.includes("'ALTER TABLE online_meetings ADD COLUMN meeting_type VARCHAR(32) NOT NULL DEFAULT ''zoom'''"));
    assert.ok(columnsMigration.includes("WHEN @status_type = 'enum(''in_progress'',''completed'',''abandoned'')' THEN"));
    assert.ok(columnsMigration.includes('ALTER TABLE exam_attempts MODIFY COLUMN status ENUM'));
    for (const value of ['in_progress', 'completed', 'abandoned', 'passed', 'failed', 'pending_review']) {
        assert.ok(columnsMigration.includes(`''${value}''`), `exam_attempts.status must retain ${value}`);
    }
    assert.match(columnsMigration, /@status_has_required_values = @status_type IS NOT NULL[\s\S]*?WHEN @status_has_required_values THEN 'SELECT 1'/);
    assert.ok(columnsMigration.includes('SELECT m1_schema_review_required_for_exam_attempts_status_enum'));
    assert.ok(columnsMigration.includes('ADD COLUMN essay_scores JSON NULL'));
    assert.ok(columnsMigration.includes("TABLE_NAME = 'students' AND INDEX_NAME = 'idx_students_phone'"), `${join(__dirname, '../migrations')}\n${columnsMigration.slice(-500)}`);
    assert.ok(columnsMigration.includes("TABLE_NAME = 'students' AND INDEX_NAME = 'idx_students_tenant_phone'"));
    assert.ok(columnsMigration.includes('ADD INDEX idx_students_tenant_phone (tenant_id, phone)'));
    assert.match(columnsMigration, /INFORMATION_SCHEMA\.STATISTICS[\s\S]*?INDEX_NAME = 'idx_students_phone'[\s\S]*?PREPARE stmt FROM @sql;[\s\S]*?EXECUTE stmt;/);
});

test('tenant resource ownership is nullable, indexed, constrained, and safely backfilled', () => {
    for (const table of ['groups', 'lectures', 'exams']) {
        assert.ok(tenantMigration.includes(`TABLE_NAME = '${table}' AND COLUMN_NAME = 'tenant_id'`));
        assert.ok(tenantMigration.includes(`INDEX_NAME = 'idx_${table}_tenant'`));
        assert.ok(tenantMigration.includes(`CONSTRAINT_NAME = 'fk_${table}_tenant'`));
        assert.ok(tenantMigration.includes(`ALTER TABLE ${table === 'groups' ? '`groups`' : table} ADD COLUMN tenant_id CHAR(36) NULL`));
        assert.ok(tenantMigration.includes(`FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE RESTRICT`));
    }

    assert.match(tenantMigration, /UPDATE `groups` g\s+INNER JOIN courses c ON c\.id = g\.course_id\s+INNER JOIN tenants t ON t\.id = c\.tenant_id\s+SET g\.tenant_id = t\.id\s+WHERE g\.tenant_id IS NULL/);
    assert.match(tenantMigration, /UPDATE lectures l\s+INNER JOIN courses c ON c\.id = l\.course_id\s+INNER JOIN tenants t ON t\.id = c\.tenant_id\s+SET l\.tenant_id = t\.id\s+WHERE l\.tenant_id IS NULL/);
    assert.doesNotMatch(tenantMigration, /t\.owner_user_id\s*=\s*\w+\.instructor_id/);
    assert.match(tenantMigration, /LEFT JOIN courses c ON c\.id = g\.course_id\s+LEFT JOIN tenants t ON t\.id = c\.tenant_id/);
    assert.match(tenantMigration, /HAVING COUNT\(\*\) = COUNT\(t\.id\) AND COUNT\(DISTINCT t\.id\) = 1/);
    assert.match(tenantMigration, /SET e\.tenant_id = exam_owners\.tenant_id\s+WHERE e\.tenant_id IS NULL/);

    for (const table of ['groups', 'lectures', 'exams']) {
        assert.match(
            tenantMigration,
            new RegExp(`@orphan_count = \\(SELECT COUNT\\(\\*\\) FROM ${table === 'groups' ? '`groups`' : table}`),
            `${table} must be checked for orphan tenant IDs before adding its FK`,
        );
        assert.ok(
            tenantMigration.includes(`m1_orphan_${table}_tenant_ids_require_manual_review`),
            `${table} orphan IDs must fail closed for manual review`,
        );
    }
});
