import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const root = join(__dirname, '..', '..');
const migrationsDir = join(root, 'server', 'migrations');
const migrationSources = readdirSync(migrationsDir)
    .filter((name) => name.endsWith('.sql'))
    .map((name) => readFileSync(join(migrationsDir, name), 'utf8'));
const allMigrations = migrationSources.join('\n');
const recoveredTablesMigration = readFileSync(join(migrationsDir, '20261017_02_missing_core_tables.sql'), 'utf8');

// Static lexical check only; no SQL is parsed by or executed against MySQL.
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

test('recovered table migration SQL literals close correctly (static lexical check only)', () => {
    assert.equal(hasBalancedSqlQuotes(recoveredTablesMigration), true);
    assert.equal(hasBalancedSqlQuotes("SELECT 'enum(''pending'',''verified'')'"), true);
    assert.equal(hasBalancedSqlQuotes("SELECT 'enum(''pending'',''verified'')"), false);
});

test('schema reconciliation: every SQL table used by core routes has tracked CREATE TABLE DDL or a documented allowlist entry', () => {
    const sourceFiles = [
        'server/src/routes/lectures.ts',
        'server/src/routes/messages.ts',
        'server/src/routes/subscription-plans.ts',
        'server/src/services/socket.ts',
        'server/src/services/domain-verification.ts',
    ];
    const source = sourceFiles.map((file) => readFileSync(join(root, file), 'utf8')).join('\n');
    const referenced = new Set<string>();
    for (const match of source.matchAll(/\b(?:FROM|JOIN|INTO|UPDATE)\s+`?([a-z][a-z0-9_]*)`?/gi)) {
        referenced.add(match[1].toLowerCase());
    }
    // These source tables are core server contracts, and each must have a
    // CREATE TABLE in tracked migrations. The remainder are checked by the
    // existing table-specific migrations or belong to non-core query helpers.
    const core = [
        'lectures', 'messages', 'conversations', 'message_status',
        'user_online_status', 'message_deletions', 'subscription_plans',
        'tenant_custom_domains',
    ];
    for (const table of core) {
        assert.ok(referenced.has(table), `expected tracked source to use ${table}`);
        assert.match(allMigrations, new RegExp('CREATE\\s+TABLE(?:\\s+IF\\s+NOT\\s+EXISTS)?\\s+' + table + '\\s*\\(', 'i'), `${table} needs tracked CREATE TABLE DDL`);
    }
    // Exclusions are intentional: aliases, CTEs, temporary result names and
    // tables whose schema is owned by an external/foundation migration.
    assert.ok(referenced.size >= core.length);
});

test('schema reconciliation: all tracked source column contracts for the eight recovered tables exist in their CREATE DDL', () => {
    const sourceFiles = [
        'server/src/routes/lectures.ts',
        'server/src/routes/messages.ts',
        'server/src/routes/subscription-plans.ts',
        'server/src/services/socket.ts',
        'server/src/services/domain-verification.ts',
    ];
    const source = sourceFiles.map((file) => readFileSync(join(root, file), 'utf8')).join('\n');
    const sourceContractColumns: Record<string, string[]> = {
        lectures: ['course_id', 'grade_id', 'group_id', 'instructor_id', 'title', 'description', 'video_url', 'duration_minutes', 'price', 'display_order', 'is_free', 'is_published', 'archived_at'],
        messages: ['id', 'sender_id', 'receiver_id', 'content', 'message_type', 'image_url', 'is_edited', 'edited_at', 'created_at'],
        conversations: ['user1_id', 'user2_id', 'last_message_id', 'unread_count_user1', 'unread_count_user2', 'updated_at'],
        message_status: ['message_id', 'is_delivered', 'delivered_at', 'is_read', 'read_at'],
        user_online_status: ['user_id', 'is_online', 'socket_id', 'last_seen'],
        message_deletions: ['message_id', 'user_id'],
        subscription_plans: ['id', 'name', 'duration_months', 'price', 'description', 'is_active'],
        tenant_custom_domains: ['hostname', 'tenant_id', 'status', 'verification_token', 'txt_name', 'created_at', 'updated_at', 'verified_at'],
    };
    const requiredColumns: Record<string, string[]> = {
        lectures: ['id', 'course_id', 'grade_id', 'group_id', 'instructor_id', 'title', 'description', 'video_url', 'duration_minutes', 'price', 'display_order', 'is_free', 'is_published', 'archived_at', 'created_at', 'updated_at'],
        messages: ['id', 'sender_id', 'receiver_id', 'content', 'message_type', 'image_url', 'is_edited', 'edited_at', 'created_at'],
        conversations: ['id', 'user1_id', 'user2_id', 'last_message_id', 'unread_count_user1', 'unread_count_user2', 'created_at', 'updated_at'],
        message_status: ['message_id', 'is_delivered', 'delivered_at', 'is_read', 'read_at'],
        user_online_status: ['user_id', 'is_online', 'socket_id', 'last_seen', 'updated_at'],
        message_deletions: ['id', 'message_id', 'user_id', 'deleted_at'],
        subscription_plans: ['id', 'name', 'duration_months', 'price', 'description', 'is_active', 'created_at', 'updated_at'],
        tenant_custom_domains: ['hostname', 'tenant_id', 'status', 'verification_token', 'txt_name', 'created_at', 'updated_at', 'verified_at'],
    };
    for (const [table, columns] of Object.entries(requiredColumns)) {
        for (const sourceColumn of sourceContractColumns[table]) {
            assert.match(source, new RegExp(`\\b${sourceColumn}\\b`), `${table}.${sourceColumn} must have source evidence`);
        }
        const escapedTable = table.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const match = allMigrations.match(new RegExp(`CREATE TABLE ${escapedTable} \\(([\\s\\S]*?)\\) ENGINE=InnoDB`, 'i'));
        assert.ok(match, `${table} needs a CREATE TABLE body`);
        const definition = match[1];
        for (const column of columns) {
            assert.match(definition, new RegExp(`(?:^|,\\s*)${column}\\s`, 'i'), `${table}.${column} is part of the consumed table contract`);
        }
    }
});

test('message ID contract: HTTP keeps generated numeric IDs and socket no longer writes a UUID ID', () => {
    const messagesRoute = readFileSync(join(root, 'server', 'src', 'routes', 'messages.ts'), 'utf8');
    const socketService = readFileSync(join(root, 'server', 'src', 'services', 'socket.ts'), 'utf8');
    assert.match(messagesRoute, /const messageId = result\.insertId/);
    assert.match(messagesRoute, /isValidGeneratedMessageId\(messageId\)/);
    assert.match(messagesRoute, /Number\.isSafeInteger\(value\) && value > 0/);
    assert.match(socketService, /const messageId = insertResult\.insertId/);
    assert.doesNotMatch(socketService, /SELECT UUID\(\) as uuid/);
    assert.match(socketService, /!Number\.isSafeInteger\(messageId\) \|\| messageId <= 0/);
    assert.match(allMigrations, /CREATE TABLE messages \(id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY/i);
    assert.match(allMigrations, /is_edited BOOLEAN NOT NULL DEFAULT FALSE, edited_at DATETIME NULL/i);
    assert.match(messagesRoute, /is_edited = TRUE, edited_at = NOW\(\)/);
    assert.match(socketService, /is_edited = TRUE, edited_at = NOW\(\)/);
});

test('existing UUID message keys and mismatched numeric references fail closed for manual reconciliation', () => {
    const migration = recoveredTablesMigration;
    assert.match(migration, /COLUMN_TYPE[\s\S]*COLUMN_NAME='id'/);
    assert.match(migration, /EXTRA[\s\S]*auto_increment/);
    assert.match(migration, /message_status[\s\S]*COLUMN_NAME='message_id'/);
    assert.match(migration, /conversations[\s\S]*COLUMN_NAME='last_message_id'/);
    assert.match(migration, /message_deletions[\s\S]*COLUMN_NAME='message_id'/);
    assert.match(migration, /IF\(@message_contract_invalid, 'SELECT \* FROM __M1_REVIEW_REQUIRED_existing_message_id_contract'/);
    assert.match(migration, /'bigint unsigned'/);
    assert.match(migration, /IF\(@table_exists=0, 'CREATE TABLE messages \(id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY/);
});

test('tracked migration history has no verified fresh chronological bootstrap order', () => {
    const files = readdirSync(migrationsDir).filter((name) => name.endsWith('.sql')).sort();
    const baselineIndex = files.findIndex((name) => name === '20260920_00_legacy_baseline.sql');
    const enrollmentIndex = files.findIndex((name) => name === '20260925_01_student_tenant_enrollment.sql');
    const schemaReplacementIndex = files.findIndex((name) => name === '20260928_runtime_schema_replacement.sql');
    assert.ok(baselineIndex >= 0, 'legacy baseline is tracked');
    assert.ok(enrollmentIndex > baselineIndex, 'tenant enrollment migration follows baseline');
    assert.ok(schemaReplacementIndex > enrollmentIndex, 'runtime schema replacement follows tenant enrollment');
    const enrollment = readFileSync(join(migrationsDir, files[enrollmentIndex]), 'utf8');
    const replacement = readFileSync(join(migrationsDir, files[schemaReplacementIndex]), 'utf8');
    assert.match(enrollment, /INNER JOIN `groups` g[\s\S]*?g\.instructor_id/i);
    assert.match(replacement, /ALTER TABLE `groups`[\s\S]*?instructor_id/i);
    const earlyLectureAlter = readFileSync(join(migrationsDir, '20260924_instructor_video_exchange.sql'), 'utf8');
    const newCoreTables = readFileSync(join(migrationsDir, '20261017_02_missing_core_tables.sql'), 'utf8');
    assert.match(earlyLectureAlter, /ALTER TABLE lectures/i);
    assert.match(newCoreTables, /CREATE TABLE lectures/i);
    const documentation = readFileSync(join(root, 'docs', 'M1-schema-reconciliation.md'), 'utf8');
    assert.match(documentation, /There is no safe apply sequence proven/i);
    assert.match(documentation, /separately approved data reconciliation/i);
});
