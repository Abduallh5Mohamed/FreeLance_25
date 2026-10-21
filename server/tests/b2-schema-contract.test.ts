import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * B2-C-SCHEMA contract test — STATIC TEXT ONLY.
 *
 * This file proves the migration sources match the injected store contracts
 * (services/exam-manual-grading.ts, services/progress-publication.ts),
 * the ledger domain types (services/billing-ledger.ts,
 * services/billing-reservations.ts) and the ledger data contract
 * (docs/contracts/BILLING-LEDGER-INTERNAL-CONTRACT.md).
 *
 * It is NOT a MySQL run: nothing is executed, no database is touched, and a
 * passing regex is not live schema evidence (see the stream report limits).
 */

const root = join(__dirname, '..', '..');
const read = (relativePath: string): string => readFileSync(join(root, relativePath), 'utf8');

const migration01 = read('server/migrations/20261021_01_exam_manual_publication.sql');
const migration02 = read('server/migrations/20261021_02_internal_financial_ledger.sql');
const baseline09 = read('server/migrations/20261018_09_exam_snapshots_grading.sql');
const storeContract = read('docs/contracts/B2-SCHEMA-CONTRACT-20261021.md');
const ledgerContract = read('docs/contracts/BILLING-LEDGER-INTERNAL-CONTRACT.md');
const manualGradingSource = read('server/src/services/exam-manual-grading.ts');
const publicationSource = read('server/src/services/progress-publication.ts');
const ledgerSource = read('server/src/services/billing-ledger.ts');
const reservationsSource = read('server/src/services/billing-reservations.ts');

/** Scheme/comment-stripped code view (lines that start with -- are removed). */
const codeOnly = (sql: string): string =>
    sql
        .split('\n')
        .filter((line) => !line.trimStart().startsWith('--'))
        .join('\n');
const code01 = codeOnly(migration01);
const code02 = codeOnly(migration02);

/** Whitespace-collapsed view so key/column matching tolerates layout. */
const flat = (text: string): string => text.replace(/\s+/g, ' ');

const flat01 = flat(code01);
const flat02 = flat(code02);

interface CreateTableBlock {
    table: string;
    body: string;
    tail: string;
}

const createTableBlocks = (sql: string): CreateTableBlock[] => {
    const blocks: CreateTableBlock[] = [];
    const pattern = /CREATE TABLE (\w+) \(([\s\S]*?)\) ENGINE=InnoDB([\s\S]*?)(?:",|')/g;
    for (const match of sql.matchAll(pattern)) {
        blocks.push({ table: match[1], body: match[2], tail: match[3] });
    }
    return blocks;
};

const blocks01 = createTableBlocks(migration01);
const blocks02 = createTableBlocks(migration02);
const blockOf = (blocks: CreateTableBlock[], table: string): string => {
    const found = blocks.find((block) => block.table === table);
    assert.ok(found, `expected a CREATE TABLE block for ${table}`);
    return flat(found.body);
};

const manualRevisionBlock = blockOf(blocks01, 'exam_manual_answer_revisions');
const publicationsBlock = blockOf(blocks01, 'progress_report_publications');
const accountsBlock = blockOf(blocks02, 'billing_accounts');
const journalsBlock = blockOf(blocks02, 'billing_journals');
const linesBlock = blockOf(blocks02, 'billing_journal_lines');
const idempotencyBlock = blockOf(blocks02, 'billing_idempotency_keys');
const reservationsBlock = blockOf(blocks02, 'billing_reservations');
const eventsBlock = blockOf(blocks02, 'billing_reservation_events');

/* Parse the injected store contracts and domain types as text. */
const quotedList = (source: string, marker: string): string[] => {
    const escaped = marker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const match = source.match(new RegExp(escaped + '\\s*=\\s*\\[([\\s\\S]*?)\\]'));
    assert.ok(match, `expected ${marker} list in the TS sources`);
    return Array.from(match[1].matchAll(/'([^']+)'/g)).map((item) => item[1]);
};

const accountKinds = quotedList(ledgerSource, 'ACCOUNT_KINDS');
const reservationStatuses = quotedList(reservationsSource, 'RESERVATION_STATUSES');
const numberBound = (source: string, constant: string): string => {
    const match = source.match(new RegExp(`(?:export const )?${constant}\\s*=\\s*([\\d_]+)n?;`));
    assert.ok(match, `expected constant ${constant} in the TS sources`);
    return match[1].replace(/_/g, '');
};
const maxAmountMinor = numberBound(ledgerSource, 'MAX_AMOUNT_MINOR');
const maxJournalLines = numberBound(ledgerSource, 'MAX_JOURNAL_LINES');
const maxIdempotencyKey = numberBound(ledgerSource, 'MAX_IDEMPOTENCY_KEY_LENGTH');
const maxReference = numberBound(ledgerSource, 'MAX_REFERENCE_LENGTH');
const maxDescription = numberBound(ledgerSource, 'MAX_DESCRIPTION_LENGTH');
const maxFeedback = numberBound(manualGradingSource, 'MAX_MANUAL_FEEDBACK_LENGTH');

/* ------------------------------------------------------------------------- */
/* Migration 01 — Part B (exam manual grading + progress publication)         */
/* ------------------------------------------------------------------------- */

test('migration 01: both Part B tables exist with the canonical contract names', () => {
    const names = blocks01.map((block) => block.table).sort();
    assert.deepEqual(names, ['exam_manual_answer_revisions', 'progress_report_publications']);
    assert.match(flat01, /UNIQUE KEY uq_manual_answer_revision \(attempt_id, question_ref, revision\)/);
    assert.match(
        flat01,
        /UNIQUE KEY uq_progress_publication \(tenant_id, student_enrollment_id, course_id\)/,
    );
    assert.match(flat01, /KEY idx_manual_revisions_tenant \(tenant_id, attempt_id\)/);
    assert.match(flat01, /KEY idx_progress_publications_course \(tenant_id, course_id\)/);
});

test('migration 01: revision columns and units match the ManualGradingStore contract', () => {
    for (const column of [
        `question_ref CHAR(36) NOT NULL`,
        `revision INT NOT NULL DEFAULT 1`,
        `awarded_hundredths INT NOT NULL`,
        `reviewer_user_id CHAR(36) NOT NULL`,
        `feedback VARCHAR(${maxFeedback}) NULL`,
        `created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP`,
    ]) {
        assert.ok(manualRevisionBlock.includes(column), `missing column ${column}`);
    }
    assert.match(manualRevisionBlock, /CHECK \(awarded_hundredths >= 0\)/);
    assert.equal(maxFeedback, '2000');
    for (const field of ['question_ref', 'revision', 'awarded_hundredths', 'reviewer_user_id', 'feedback']) {
        assert.ok(manualGradingSource.includes(field), `ManualGradeRevisionRow expects ${field}`);
    }
    assert.match(manualGradingSource, /export interface ManualGradeRevisionRow/);
    assert.match(manualGradingSource, /duplicate_revision/);
});

test('migration 01: publication columns match the PublicationStore contract', () => {
    for (const column of [
        `tenant_id CHAR(36) NOT NULL`,
        `student_enrollment_id CHAR(36) NOT NULL`,
        `course_id CHAR(36) NOT NULL`,
        `state ENUM('draft','published') NOT NULL DEFAULT 'draft'`,
        `published_by CHAR(36) NULL`,
        `published_at DATETIME NULL`,
        `version INT NOT NULL DEFAULT 0`,
    ]) {
        assert.ok(publicationsBlock.includes(column), `missing column ${column}`);
    }
    assert.match(publicationSource, /export type PublicationState = 'draft' \| 'published';/);
    for (const field of ['studentEnrollmentId', 'courseId', 'publishedBy', 'publishedAt', 'version']) {
        assert.ok(publicationSource.includes(field), `PublicationRecord expects ${field}`);
    }
    assert.match(flat01, /student_enrollment_id\) REFERENCES students\(id\)/);
    assert.match(flat01, /course_id\) REFERENCES courses\(id\)/);
    assert.match(flat01, /reviewer_user_id CHAR\(36\) NULL/);
    assert.match(flat01, /fk_exam_attempts_reviewer FOREIGN KEY \(reviewer_user_id\) REFERENCES users\(id\) ON DELETE SET NULL/);
});

test('migration 01: composite revision FK targets the EXISTING unique answer key from 20261018_09', () => {
    assert.match(
        flat01,
        /FOREIGN KEY \(attempt_id, question_ref\) REFERENCES exam_versioned_answers\(attempt_id, question_ref\)/,
    );
    assert.match(flat(baseline09), /UNIQUE KEY uq_exam_answer \(attempt_id, question_ref\)/);
    assert.match(flat(baseline09), /question_ref CHAR\(36\) NOT NULL/);
});

test('migration 01: every statement is guarded, idempotent and additive', () => {
    assert.equal(blocks01.length, 2);
    for (const table of ['exam_manual_answer_revisions', 'progress_report_publications']) {
        assert.match(code01, new RegExp(`SET @\\w+_has_\\w+ = \\(SELECT COUNT\\(\\*\\) FROM INFORMATION_SCHEMA\\.TABLES[\\s\\S]*?TABLE_NAME = '${table}'`));
    }
    assert.match(code01, /SELECT COUNT\(\*\) FROM INFORMATION_SCHEMA\.COLUMNS[\s\S]*?COLUMN_NAME = 'reviewer_user_id'/);
    assert.match(code01, /SELECT COUNT\(\*\) FROM INFORMATION_SCHEMA\.TABLE_CONSTRAINTS[\s\S]*?CONSTRAINT_NAME = 'fk_exam_attempts_reviewer'/);
    const prepares = code01.match(/^PREPARE .* FROM @.*;$/gm) ?? [];
    const executes = code01.match(/^EXECUTE .*;$/gm) ?? [];
    const deallocates = code01.match(/^DEALLOCATE PREPARE .*;$/gm) ?? [];
    assert.equal(prepares.length, 4);
    assert.equal(executes.length, prepares.length);
    assert.equal(deallocates.length, prepares.length);
    for (const forbidden of [/\bDROP\b/i, /\bTRUNCATE\b/i, /\bDELETE\s+FROM\b/i, /\bUPDATE\s+\S+\s+SET\b/i, /foreign_key_checks/i]) {
        assert.doesNotMatch(code01, forbidden);
    }
});

/* ------------------------------------------------------------------------- */
/* Migration 02 — Part C (internal financial ledger)                          */
/* ------------------------------------------------------------------------- */

test('migration 02: all six ledger tables exist with the ledger contract names', () => {
    const names = blocks02.map((block) => block.table).sort();
    assert.deepEqual(names, [
        'billing_accounts',
        'billing_idempotency_keys',
        'billing_journal_lines',
        'billing_journals',
        'billing_reservation_events',
        'billing_reservations',
    ]);
    for (const table of names) {
        assert.ok(ledgerContract.includes(table), `ledger contract must name ${table}`);
        assert.match(flat02, new RegExp(`CREATE TABLE ${table} `));
    }
});

test('migration 02: money is exact BIGINT minor units, no float types anywhere', () => {
    assert.equal(maxAmountMinor, '1000000000000000');
    for (const block of [linesBlock, reservationsBlock, eventsBlock]) {
        assert.ok(block.includes('amount_minor BIGINT UNSIGNED NOT NULL'), 'amount columns must be BIGINT UNSIGNED');
        assert.match(
            block,
            new RegExp(`CHECK \\(amount_minor > 0 AND amount_minor <= ${maxAmountMinor}\\)`),
        );
    }
    assert.match(accountsBlock, /balance_minor BIGINT NOT NULL DEFAULT 0/);
    assert.match(accountsBlock, /CHECK \(balance_minor >= 0\)/);
    for (const forbidden of [
        /\bFLOAT\s*\(/i,
        /\bDOUBLE\s*(?:PRECISION)?\s*\(/i,
        /\b(?:DECIMAL|NUMERIC)\s*\(/i,
    ]) {
        assert.doesNotMatch(code02, forbidden, 'no approximate or fractional money type may appear in the ledger DDL');
    }
    assert.match(ledgerSource, /export function serializeMoneyMinor/);
    assert.match(ledgerSource, /return value\.toString\(\);/);
});

test('migration 02: every table carries tenant_id and the baseline engine/charset/collation', () => {
    for (const block of [accountsBlock, journalsBlock, linesBlock, idempotencyBlock, reservationsBlock, eventsBlock]) {
        assert.ok(block.includes('tenant_id CHAR(36) NOT NULL'), 'tenant_id on every new table');
    }
    assert.equal((migration01.match(/ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci/g) ?? []).length, 2);
    assert.equal((migration02.match(/ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci/g) ?? []).length, 6);
    assert.match(flat02, /REFERENCES tenants\(id\)/);
});

test('migration 02: timestamp precision, currency and width bounds match the domain constants', () => {
    assert.equal(maxIdempotencyKey, '128');
    assert.equal(maxReference, '200');
    assert.equal(maxDescription, '500');
    assert.equal(maxJournalLines, '100');
    assert.ok(idempotencyBlock.includes('idempotency_key VARCHAR(128) NOT NULL'));
    assert.ok(eventsBlock.includes('idempotency_key VARCHAR(128) NOT NULL'));
    assert.ok(journalsBlock.includes(`reference VARCHAR(${maxReference}) NULL`));
    assert.ok(journalsBlock.includes(`description VARCHAR(${maxDescription}) NULL`));
    assert.ok(linesBlock.includes('100 lines'));
    for (const block of [accountsBlock, journalsBlock, linesBlock, idempotencyBlock, reservationsBlock, eventsBlock]) {
        assert.match(block, /created_at TIMESTAMP\(3\) NOT NULL DEFAULT CURRENT_TIMESTAMP\(3\)/);
    }
    assert.ok(journalsBlock.includes('currency CHAR(3) NOT NULL'));
    assert.ok(accountsBlock.includes('currency CHAR(3) NOT NULL'));
    assert.ok(reservationsBlock.includes('currency CHAR(3) NOT NULL'));
    assert.match(linesBlock, /PRIMARY KEY \(journal_id, line_no\)/);
    assert.match(linesBlock, /KEY idx_billing_line_tenant_account \(tenant_id, account_id\)/);
    assert.match(ledgerSource, /createHash\('sha256'\)/);
    assert.match(idempotencyBlock, /payload_hash CHAR\(64\) NOT NULL/);
});

test('migration 02: account journals lines and events carry the exact contract/domain enums', () => {
    const enumOf = (block: string, column: string): string => {
        const match = block.match(new RegExp(`${column} ENUM\\(([^)]*)\\) NOT NULL`));
        assert.ok(match, `expected ENUM on ${column}`);
        return match[1].split(',').map((value) => value.trim().replaceAll("'", ''));
    };
    assert.deepEqual(enumOf(accountsBlock, 'kind'), accountKinds);
    assert.deepEqual(enumOf(linesBlock, 'account_kind'), accountKinds);
    assert.deepEqual(enumOf(journalsBlock, 'journal_type'), ['standard', 'reversal']);
    assert.deepEqual(enumOf(reservationsBlock, 'status'), reservationStatuses);
    assert.match(ledgerSource, /export type LineDirection/);
    assert.deepEqual(enumOf(linesBlock, 'direction'), quotedList(ledgerSource, 'LINE_DIRECTIONS'));
    for (const kind of ['platform_receivable', 'merchant_pending', 'merchant_available', 'merchant_reserved', 'subscription_credit']) {
        assert.ok(ledgerSource.includes(kind), `domain expects account kind ${kind}`);
    }
    assert.match(flat02, /normal_side ENUM\('debit','credit'\) NOT NULL/);
});

test('migration 02: idempotency registry is the canonical per-tenant race arbiter', () => {
    assert.match(flat02, /PRIMARY KEY \(tenant_id, scope, idempotency_key\)/);
    assert.match(flat02, /UNIQUE KEY uq_billing_idem_journal \(journal_id\)/);
    assert.match(flat02, /UNIQUE KEY uq_billing_idem_reservation \(reservation_id\)/);
    assert.match(
        flat02,
        /CHECK \(\(journal_id IS NULL\) <> \(reservation_id IS NULL\)\)/,
    );
    assert.match(idempotencyBlock, /scope VARCHAR\(32\) NOT NULL/);
    assert.ok(idempotencyBlock.includes("'journal | reservation'"));
    assert.match(ledgerSource, /findJournalByIdempotencyKey/);
    assert.match(reservationsSource, /findReservationByKey/);
    assert.match(reservationsSource, /payloadHash/);
    assert.match(ledgerContract, /Canonical key registry for journals and reservations/);
    assert.doesNotMatch(reservationsBlock, /reservation_key/);
    assert.doesNotMatch(reservationsBlock, /payload_hash/);
});

test('migration 02: append-only journals/reversals and reservation CAS columns per contract', () => {
    assert.match(flat02, /UNIQUE KEY uq_billing_idem_journal/);
    assert.match(journalsBlock, /journal_type ENUM\('standard','reversal'\) NOT NULL DEFAULT 'standard'/);
    assert.match(journalsBlock, /UNIQUE KEY uq_billing_journal_reversal \(tenant_id, reversal_of_journal_id\)/);
    assert.match(journalsBlock, /UNIQUE KEY uq_billing_journal_id_tenant \(id, tenant_id\)/);
    assert.match(
        journalsBlock,
        /CHECK \(\(journal_type = 'reversal'\) = \(reversal_of_journal_id IS NOT NULL\)\)/,
    );
    assert.match(journalsBlock, /FOREIGN KEY \(reversal_of_journal_id, tenant_id\) REFERENCES billing_journals \(id, tenant_id\)/);
    assert.doesNotMatch(journalsBlock, /updated_at/);
    assert.doesNotMatch(linesBlock, /updated_at/);
    assert.doesNotMatch(eventsBlock, /updated_at/);

    assert.match(reservationsBlock, /status ENUM\('reserved','released','consumed'\) NOT NULL DEFAULT 'reserved'/);
    assert.match(reservationsBlock, /version BIGINT UNSIGNED NOT NULL DEFAULT 0/);
    assert.match(reservationsBlock, /CHECK \(available_account_id <> reserved_account_id\)/);
    assert.match(reservationsBlock, /CHECK \(\(status <> 'released'\) OR \(release_journal_id IS NOT NULL\)\)/);
    assert.match(reservationsBlock, /CHECK \(\(status <> 'consumed'\) OR \(consume_journal_id IS NOT NULL\)\)/);
    for (const journalColumn of ['reserve_journal_id', 'release_journal_id', 'consume_journal_id']) {
        assert.match(
            flat02,
            new RegExp(`FOREIGN KEY \\(${journalColumn}, tenant_id\\) REFERENCES billing_journals \\(id, tenant_id\\)`),
        );
    }
    for (const accountColumn of ['available_account_id', 'reserved_account_id', 'consume_counter_account_id']) {
        assert.match(
            flat02,
            new RegExp(`FOREIGN KEY \\(${accountColumn}, tenant_id\\) REFERENCES billing_accounts \\(id, tenant_id\\)`),
        );
    }
    assert.equal(reservationStatuses.join(','), 'reserved,released,consumed');
});

test('migration 02: reservation events are the append-only transition log', () => {
    for (const column of [
        'reservation_id CHAR(36) NOT NULL',
        "event_type ENUM('reserve','release','consume','reversal') NOT NULL",
        'journal_id CHAR(36) NOT NULL',
        'version_after BIGINT UNSIGNED NOT NULL',
        'idempotency_key VARCHAR(128) NOT NULL',
    ]) {
        assert.ok(eventsBlock.includes(column), `missing events column ${column}`);
    }
    assert.match(eventsBlock, /UNIQUE KEY uq_billing_reservation_event_key \(tenant_id, idempotency_key\)/);
    assert.match(
        eventsBlock,
        /UNIQUE KEY uq_billing_reservation_event_type \(reservation_id, event_type, idempotency_key\)/,
    );
    assert.match(eventsBlock, /KEY idx_billing_reservation_event \(tenant_id, reservation_id, created_at\)/);
    assert.match(flat02, /FOREIGN KEY \(reservation_id, tenant_id\) REFERENCES billing_reservations \(id, tenant_id\)/);
    assert.match(flat02, /FOREIGN KEY \(journal_id, tenant_id\) REFERENCES billing_journals \(id, tenant_id\)/);
    assert.match(reservationsSource, /export type ReservationEventType = 'reserve' \| 'release' \| 'consume' \| 'reversal';/);
});

test('migration 02: every statement is guarded, idempotent and strictly additive', () => {
    assert.equal(blocks02.length, 6);
    for (const table of ['billing_accounts', 'billing_journals', 'billing_journal_lines', 'billing_reservations', 'billing_idempotency_keys', 'billing_reservation_events']) {
        assert.match(code02, new RegExp(`SET @\\w+_has_\\w+ = \\(SELECT COUNT\\(\\*\\) FROM INFORMATION_SCHEMA\\.TABLES[\\s\\S]*?TABLE_NAME = '${table}'`));
    }
    const prepares = code02.match(/^PREPARE .* FROM @.*;$/gm) ?? [];
    const executes = code02.match(/^EXECUTE .*;$/gm) ?? [];
    const deallocates = code02.match(/^DEALLOCATE PREPARE .*;$/gm) ?? [];
    assert.equal(prepares.length, 6);
    assert.equal(executes.length, prepares.length);
    assert.equal(deallocates.length, prepares.length);
    for (const destructive of [/\bDROP\b/i, /\bTRUNCATE\b/i, /\bDELETE\s+FROM\b/i, /\bUPDATE\s+\S+\s+SET\b/i, /foreign_key_checks/i, /\bTRIGGER\b/i]) {
        assert.doesNotMatch(code02, destructive);
        assert.doesNotMatch(code01, destructive);
    }
    assert.doesNotMatch(code02, /\bALTER\b/i, 'the ledger migration creates only new tables; nothing is altered here');
    assert.doesNotMatch(
        code01,
        /\bALTER\b(?!\s+TABLE\s+exam_versioned_attempts\s+ADD\s+(?:COLUMN\s+reviewer_user_id|CONSTRAINT\s+fk_exam_attempts_reviewer))/i,
        'the only ALTERs in 01 are the guarded reviewer column and its FK',
    );
    assert.match(code02, /CREATE TABLE billing_accounts/);
    assert.doesNotMatch(code02, /instructor_wallets/);
    assert.doesNotMatch(code02, /service[-_]credit/);
    assert.doesNotMatch(code02, /invoice/i);
    assert.doesNotMatch(code02, /refund/i);
    assert.doesNotMatch(code02, /payout/i);
});

/* ------------------------------------------------------------------------- */
/* Contract documents agree with what the migrations define                   */
/* ------------------------------------------------------------------------- */

test('schema contract records the canonical migration 01 letter-for-letter names', () => {
    assert.match(flat(storeContract), /uq_manual_answer_revision \(attempt_id, question_ref, revision\)/);
    assert.match(flat(storeContract), /uq_progress_publication \(tenant_id, student_enrollment_id,/);
    assert.match(flat(storeContract), /awarded_hundredths \| INT NOT NULL \| integer hundredths; CHECK >= 0/);
    assert.match(flat(storeContract), /state \| ENUM\('draft','published'\) NOT NULL DEFAULT 'draft'/);
    assert.match(storeContract, /THIS FILE IS AUTHORING-ONLY|nothing was executed|Nothing in this file is executed/i);
});

test('ledger contract names are all implemented by migration 02 without reinterpretation', () => {
    for (const keyName of [
        'uq_billing_account_tenant_kind_currency',
        'uq_billing_account_id_tenant',
        'uq_billing_journal_id_tenant',
        'uq_billing_journal_reversal',
        'uq_billing_idem_journal',
        'uq_billing_idem_reservation',
        'uq_billing_reservation_id_tenant',
        'uq_billing_reservation_event_key',
        'uq_billing_reservation_event_type',
        'idx_billing_account_tenant',
        'idx_billing_journal_tenant_created',
        'idx_billing_line_tenant_account',
        'idx_billing_reservation_tenant_status',
        'idx_billing_reservation_event',
    ]) {
        assert.match(flat02, new RegExp(`${keyName} `), `migration 02 must declare ${keyName}`);
        assert.ok(ledgerContract.includes(keyName), `ledger contract must name ${keyName}`);
    }
    assert.match(ledgerContract, /instructor_wallets/);
    assert.match(ledgerContract, /must never be mapped into these tables/);
});

/* ========================================================================= */
/* SEQUENCE HARNESS — a test-only interpreter over an in-memory catalog.      */
/*                                                                           */
/* It executes the REAL migration text (no duplicate SQL logic): it parses   */
/* the exact statement forms these two files use and applies the resulting   */
/* DDL to a model of INFORMATION_SCHEMA (tables -> columns/constraints/      */
/* indexes). Any statement form it does not recognise throws, so a silent    */
/* skip can never make a scenario pass.                                      */
/*                                                                           */
/* This is a MODEL of MySQL semantics, NOT a MySQL run. FK/CHECK enforcement,*/
/* privilege behaviour and the real bootstrap remain unproven here.          */
/* ========================================================================= */

type SqlValue = string | number;

interface TableState {
    readonly columns: Set<string>;
    readonly constraints: Set<string>;
    readonly indexes: Set<string>;
}

type Catalog = Map<string, TableState>;

const cloneCatalog = (source: Catalog): Catalog => {
    const copy: Catalog = new Map<string, TableState>();
    for (const [name, state] of source) {
        copy.set(name, {
            columns: new Set(state.columns),
            constraints: new Set(state.constraints),
            indexes: new Set(state.indexes),
        });
    }
    return copy;
};

const tableState = (catalog: Catalog, table: string): TableState => {
    const state = catalog.get(table);
    if (!state) throw new Error(`interpreter: table ${table} is absent from the modeled catalog`);
    return state;
};

const hasColumn = (catalog: Catalog, table: string, column: string): boolean =>
    catalog.get(table)?.columns.has(column) ?? false;

const hasConstraint = (catalog: Catalog, table: string, constraint: string): boolean =>
    catalog.get(table)?.constraints.has(constraint) ?? false;

const countColumn = (catalog: Catalog, table: string, column: string): number =>
    [...(catalog.get(table)?.columns ?? [])].filter((name) => name === column).length;

const countConstraint = (catalog: Catalog, table: string, constraint: string): number =>
    [...(catalog.get(table)?.constraints ?? [])].filter((name) => name === constraint).length;

const splitTopLevel = (text: string, delimiter: ',' | ';'): string[] => {
    const parts: string[] = [];
    let depth = 0;
    let quote: "'" | '"' | null = null;
    let start = 0;
    for (let i = 0; i < text.length; i += 1) {
        const ch = text[i];
        if (quote !== null) {
            if (ch === quote) {
                if (text[i + 1] === quote) i += 1;
                else quote = null;
            }
            continue;
        }
        if (ch === "'" || ch === '"') {
            quote = ch;
            continue;
        }
        if (ch === '(') {
            depth += 1;
            continue;
        }
        if (ch === ')') {
            depth -= 1;
            continue;
        }
        if (ch === delimiter && depth === 0) {
            parts.push(text.slice(start, i));
            start = i + 1;
        }
    }
    parts.push(text.slice(start));
    return parts;
};

const splitTopLevelAnd = (text: string): string[] => {
    const parts: string[] = [];
    let depth = 0;
    let quote: "'" | '"' | null = null;
    let start = 0;
    for (let i = 0; i < text.length; i += 1) {
        const ch = text[i];
        if (quote !== null) {
            if (ch === quote) {
                if (text[i + 1] === quote) i += 1;
                else quote = null;
            }
            continue;
        }
        if (ch === "'" || ch === '"') {
            quote = ch;
            continue;
        }
        if (ch === '(') {
            depth += 1;
            continue;
        }
        if (ch === ')') {
            depth -= 1;
            continue;
        }
        if (depth === 0 && (ch === 'A' || ch === 'a')) {
            const word = text.slice(i, i + 3);
            const before = i === 0 ? '' : text[i - 1];
            const after = text[i + 3] ?? '';
            if (word.toUpperCase() === 'AND' && !/\w/.test(before) && !/\w/.test(after)) {
                parts.push(text.slice(start, i));
                start = i + 3;
                i += 2;
            }
        }
    }
    parts.push(text.slice(start));
    return parts;
};

const stripOuterParens = (text: string): string => {
    let value = text.trim();
    for (;;) {
        if (!value.startsWith('(') || !value.endsWith(')')) return value;
        let depth = 0;
        let quote: "'" | '"' | null = null;
        let closesAtEnd = false;
        for (let i = 0; i < value.length; i += 1) {
            const ch = value[i];
            if (quote !== null) {
                if (ch === quote) {
                    if (value[i + 1] === quote) i += 1;
                    else quote = null;
                }
                continue;
            }
            if (ch === "'" || ch === '"') {
                quote = ch;
                continue;
            }
            if (ch === '(') depth += 1;
            else if (ch === ')') {
                depth -= 1;
                if (depth === 0) {
                    closesAtEnd = i === value.length - 1;
                    break;
                }
            }
        }
        if (!closesAtEnd) return value;
        value = value.slice(1, -1).trim();
    }
};

const evaluateGuard = (condition: string, vars: Map<string, SqlValue>): boolean => {
    const text = stripOuterParens(condition);
    const clauses = splitTopLevelAnd(text)
        .map((clause) => stripOuterParens(clause))
        .filter((clause) => clause.length > 0);
    if (clauses.length > 1) return clauses.every((clause) => evaluateGuard(clause, vars));
    const match = text.match(/^(@\w+)\s*=\s*(-?\d+)$/);
    if (!match) throw new Error(`interpreter: cannot evaluate guard "${condition}"`);
    const raw = vars.get(match[1]);
    if (raw === undefined) throw new Error(`interpreter: guard references unset variable ${match[1]}`);
    return Number(raw) === Number(match[2]);
};

const unquoteSqlString = (raw: string): string => {
    const text = raw.trim();
    if (text.length >= 2 && text.startsWith('"') && text.endsWith('"')) {
        return text.slice(1, -1).replace(/""/g, '"');
    }
    if (text.length >= 2 && text.startsWith("'") && text.endsWith("'")) {
        return text.slice(1, -1).replace(/''/g, "'");
    }
    throw new Error(`interpreter: expected a quoted SQL string, got "${text.slice(0, 60)}"`);
};

const parseTableBody = (state: TableState, body: string): void => {
    for (const rawDefinition of splitTopLevel(body, ',')) {
        const definition = rawDefinition.trim();
        if (definition.length === 0) continue;
        const named = definition.match(/^CONSTRAINT\s+(\w+)\s+/i);
        if (named) {
            state.constraints.add(named[1]);
            continue;
        }
        const uniqueKey = definition.match(/^UNIQUE\s+(?:KEY|INDEX)\s+(\w+)/i);
        if (uniqueKey) {
            state.indexes.add(uniqueKey[1]);
            state.constraints.add(uniqueKey[1]);
            continue;
        }
        const key = definition.match(/^(?:KEY|INDEX)\s+(\w+)/i);
        if (key) {
            state.indexes.add(key[1]);
            continue;
        }
        if (/^PRIMARY\s+KEY\b/i.test(definition)) continue;
        if (/^FOREIGN\s+KEY\b/i.test(definition)) {
            throw new Error(`interpreter: unnamed FOREIGN KEY is not modelled: "${definition.slice(0, 80)}"`);
        }
        if (/^CHECK\b/i.test(definition)) continue;
        const column = definition.match(/^(\w+)\s+/);
        if (!column) {
            throw new Error(`interpreter: cannot parse table definition "${definition.slice(0, 80)}"`);
        }
        state.columns.add(column[1]);
    }
};

const applyDdl = (catalog: Catalog, ddl: string): void => {
    const text = ddl.trim();
    if (/^SELECT\s+1$/i.test(text)) return;
    const create = text.match(/^CREATE\s+TABLE\s+(\w+)\s*\(([\s\S]*)\)\s*ENGINE\s*=/i);
    if (create) {
        if (catalog.has(create[1])) {
            throw new Error(`interpreter: CREATE TABLE ${create[1]} but the table already exists`);
        }
        const state: TableState = { columns: new Set(), constraints: new Set(), indexes: new Set() };
        parseTableBody(state, create[2]);
        catalog.set(create[1], state);
        return;
    }
    const alter = text.match(/^ALTER\s+TABLE\s+(\w+)\s+([\s\S]+)$/i);
    if (alter) {
        const state = tableState(catalog, alter[1]);
        const action = alter[2].trim();
        const addColumn = action.match(/^ADD\s+COLUMN\s+(\w+)/i);
        if (addColumn) {
            state.columns.add(addColumn[1]);
            return;
        }
        const addConstraint = action.match(/^ADD\s+CONSTRAINT\s+(\w+)/i);
        if (addConstraint) {
            state.constraints.add(addConstraint[1]);
            return;
        }
        const addIndex = action.match(/^ADD\s+(?:UNIQUE\s+)?(?:INDEX|KEY)\s+(\w+)/i);
        if (addIndex) {
            state.indexes.add(addIndex[1]);
            return;
        }
        throw new Error(`interpreter: unsupported ALTER TABLE action "${action.slice(0, 80)}"`);
    }
    throw new Error(`interpreter: unsupported DDL "${text.slice(0, 80)}"`);
};

const countProbe = (catalog: Catalog, view: string, where: string): number => {
    const tableName = where.match(/TABLE_NAME\s*=\s*'([^']+)'/i);
    if (!tableName) throw new Error(`interpreter: probe has no TABLE_NAME: "${where.slice(0, 80)}"`);
    if (/\bOR\b/i.test(where)) throw new Error(`interpreter: OR in a probe is not modelled`);
    const state = catalog.get(tableName[1]);
    switch (view.toUpperCase()) {
        case 'TABLES':
            return state ? 1 : 0;
        case 'COLUMNS': {
            const column = where.match(/COLUMN_NAME\s*=\s*'([^']+)'/i);
            if (!column) throw new Error(`interpreter: COLUMNS probe has no COLUMN_NAME`);
            return state && state.columns.has(column[1]) ? 1 : 0;
        }
        case 'TABLE_CONSTRAINTS': {
            const constraint = where.match(/CONSTRAINT_NAME\s*=\s*'([^']+)'/i);
            if (!constraint) throw new Error(`interpreter: TABLE_CONSTRAINTS probe has no CONSTRAINT_NAME`);
            return state && state.constraints.has(constraint[1]) ? 1 : 0;
        }
        case 'STATISTICS': {
            const index = where.match(/(?:INDEX_NAME)\s*=\s*'([^']+)'/i);
            if (!index) throw new Error(`interpreter: STATISTICS probe has no INDEX_NAME`);
            return state && state.indexes.has(index[1]) ? 1 : 0;
        }
        default:
            throw new Error(`interpreter: unsupported INFORMATION_SCHEMA view ${view}`);
    }
};

const runMigrationSql = (sqlText: string, initial: Catalog): Catalog => {
    const catalog = cloneCatalog(initial);
    const statements = splitTopLevel(
        sqlText
            .split('\n')
            .filter((line) => !line.trimStart().startsWith('--'))
            .join('\n'),
        ';',
    )
        .map((statement) => statement.trim())
        .filter((statement) => statement.length > 0);
    const vars = new Map<string, SqlValue>();
    const prepared = new Map<string, string>();
    for (const statement of statements) {
        const setDatabase = statement.match(/^SET\s+(@\w+)\s*=\s*DATABASE\(\)$/i);
        if (setDatabase) {
            vars.set(setDatabase[1], 'b2c_test_schema');
            continue;
        }
        const setProbe = statement.match(
            /^SET\s+(@\w+)\s*=\s*\(\s*(?:SELECT\s+COUNT\(\*\)\s+FROM\s+INFORMATION_SCHEMA\.(\w+)\s+WHERE\s+([\s\S]+))\)$/i,
        );
        if (setProbe) {
            vars.set(setProbe[1], countProbe(catalog, setProbe[2], setProbe[3]));
            continue;
        }
        const setIf = statement.match(/^SET\s+(@\w+)\s*=\s*IF\(([\s\S]*)\)$/i);
        if (setIf) {
            const args = splitTopLevel(setIf[2], ',');
            if (args.length !== 3) {
                throw new Error(`interpreter: IF expects 3 arguments, got ${args.length}`);
            }
            const chosen = evaluateGuard(args[0], vars) ? args[1] : args[2];
            vars.set(setIf[1], unquoteSqlString(chosen));
            continue;
        }
        const prepare = statement.match(/^PREPARE\s+(\w+)\s+FROM\s+(@\w+)$/i);
        if (prepare) {
            const value = vars.get(prepare[2]);
            if (typeof value !== 'string') {
                throw new Error(`interpreter: PREPARE ${prepare[1]} has no statement string`);
            }
            prepared.set(prepare[1], value);
            continue;
        }
        const execute = statement.match(/^EXECUTE\s+(\w+)$/i);
        if (execute) {
            const ddl = prepared.get(execute[1]);
            if (ddl === undefined) throw new Error(`interpreter: EXECUTE ${execute[1]} was never prepared`);
            applyDdl(catalog, ddl);
            continue;
        }
        const deallocate = statement.match(/^DEALLOCATE\s+PREPARE\s+(\w+)$/i);
        if (deallocate) {
            if (!prepared.delete(deallocate[1])) {
                throw new Error(`interpreter: DEALLOCATE ${deallocate[1]} was never prepared`);
            }
            continue;
        }
        throw new Error(`interpreter: unrecognised statement "${statement.slice(0, 100)}"`);
    }
    if (prepared.size > 0) {
        throw new Error(`interpreter: leaked PREPARE handles: ${[...prepared.keys()].join(', ')}`);
    }
    return catalog;
};

interface CatalogSnapshot {
    table: string;
    columns: string[];
    constraints: string[];
    indexes: string[];
}

const snapshot = (catalog: Catalog): CatalogSnapshot[] =>
    [...catalog.entries()]
        .map(([table, state]) => ({
            table,
            columns: [...state.columns].sort(),
            constraints: [...state.constraints].sort(),
            indexes: [...state.indexes].sort(),
        }))
        .sort((left, right) => left.table.localeCompare(right.table));

const seededAttempts = (withReviewerColumn: boolean): Catalog => {
    const catalog: Catalog = new Map();
    const columns = new Set(['id', 'tenant_id', 'exam_id', 'status', 'version', 'graded_at', 'passed']);
    if (withReviewerColumn) columns.add('reviewer_user_id');
    catalog.set('exam_versioned_attempts', {
        columns,
        constraints: new Set(),
        indexes: new Set(),
    });
    return catalog;
};

const attemptsWithoutReviewer = (): Catalog => seededAttempts(false);

const PRE_FIX_STALE_PROBE_SQL = `
SET @b2c_db = DATABASE();
SET @b2c_has_attempts = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.TABLES
    WHERE TABLE_SCHEMA = @b2c_db AND TABLE_NAME = 'exam_versioned_attempts');
SET @b2c_has_reviewer_col = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA = @b2c_db AND TABLE_NAME = 'exam_versioned_attempts'
      AND COLUMN_NAME = 'reviewer_user_id');
SET @b2c_sql_add_reviewer = IF(@b2c_has_attempts = 1 AND @b2c_has_reviewer_col = 0,
    'ALTER TABLE exam_versioned_attempts ADD COLUMN reviewer_user_id CHAR(36) NULL AFTER passed',
    'SELECT 1');
PREPARE b2c_stmt_add_reviewer FROM @b2c_sql_add_reviewer;
EXECUTE b2c_stmt_add_reviewer;
DEALLOCATE PREPARE b2c_stmt_add_reviewer;
SET @b2c_has_reviewer_fk = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.TABLE_CONSTRAINTS
    WHERE CONSTRAINT_SCHEMA = @b2c_db AND TABLE_NAME = 'exam_versioned_attempts'
      AND CONSTRAINT_NAME = 'fk_exam_attempts_reviewer');
SET @b2c_sql_reviewer_fk = IF(@b2c_has_attempts = 1 AND @b2c_has_reviewer_col = 1 AND @b2c_has_reviewer_fk = 0,
    'ALTER TABLE exam_versioned_attempts ADD CONSTRAINT fk_exam_attempts_reviewer FOREIGN KEY (reviewer_user_id) REFERENCES users(id) ON DELETE SET NULL',
    'SELECT 1');
PREPARE b2c_stmt_reviewer_fk FROM @b2c_sql_reviewer_fk;
EXECUTE b2c_stmt_reviewer_fk;
DEALLOCATE PREPARE b2c_stmt_reviewer_fk;
`;

const B2_TABLE_NAMES = [
    'billing_accounts',
    'billing_idempotency_keys',
    'billing_journal_lines',
    'billing_journals',
    'billing_reservation_events',
    'billing_reservations',
] as const;

test('sequence harness: an unrecognised statement form fails loudly', () => {
    assert.throws(
        () => runMigrationSql('SET @x = 1;', new Map<string, TableState>()),
        /unrecognised statement/,
    );
    assert.throws(
        () => runMigrationSql('SET @x = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.VIEWS WHERE TABLE_NAME = \'t\');', new Map<string, TableState>()),
        /unsupported INFORMATION_SCHEMA view/,
    );
});

test('migration 01 sequence: first run adds the reviewer column AND its FK', () => {
    const catalog = runMigrationSql(migration01, attemptsWithoutReviewer());
    assert.ok(hasColumn(catalog, 'exam_versioned_attempts', 'reviewer_user_id'));
    assert.ok(hasConstraint(catalog, 'exam_versioned_attempts', 'fk_exam_attempts_reviewer'));
    assert.ok(catalog.has('exam_manual_answer_revisions'));
    assert.ok(catalog.has('progress_report_publications'));
});

test('migration 01 sequence: column present without FK gains exactly the FK', () => {
    const catalog = runMigrationSql(migration01, seededAttempts(true));
    assert.equal(countColumn(catalog, 'exam_versioned_attempts', 'reviewer_user_id'), 1);
    assert.equal(countConstraint(catalog, 'exam_versioned_attempts', 'fk_exam_attempts_reviewer'), 1);
    assert.ok(catalog.has('exam_manual_answer_revisions'));
    assert.ok(catalog.has('progress_report_publications'));
});

test('migration 01 sequence: fully migrated catalog is unchanged', () => {
    const migrated = runMigrationSql(migration01, attemptsWithoutReviewer());
    const before = snapshot(migrated);
    const after = runMigrationSql(migration01, migrated);
    assert.deepEqual(snapshot(after), before);
});

test('migration 01 sequence: double run adds no duplicate column or constraint', () => {
    const first = runMigrationSql(migration01, attemptsWithoutReviewer());
    const second = runMigrationSql(migration01, first);
    assert.equal(countColumn(second, 'exam_versioned_attempts', 'reviewer_user_id'), 1);
    assert.equal(countConstraint(second, 'exam_versioned_attempts', 'fk_exam_attempts_reviewer'), 1);
    assert.deepEqual(snapshot(second), snapshot(first));
});

test('migration 01 sequence: missing attempts table is skipped without crashing', () => {
    const catalog = runMigrationSql(migration01, new Map<string, TableState>());
    assert.equal(catalog.has('exam_versioned_attempts'), false);
    assert.ok(catalog.has('exam_manual_answer_revisions'));
    assert.ok(catalog.has('progress_report_publications'));
});

test('migration 01 sequence: pre-fix stale-probe ordering leaves the FK missing', () => {
    const catalog = runMigrationSql(PRE_FIX_STALE_PROBE_SQL, attemptsWithoutReviewer());
    assert.equal(hasColumn(catalog, 'exam_versioned_attempts', 'reviewer_user_id'), true);
    assert.equal(
        hasConstraint(catalog, 'exam_versioned_attempts', 'fk_exam_attempts_reviewer'),
        false,
        'the reconstructed pre-fix ordering must reproduce the silently skipped FK',
    );
});

test('migration 02 sequence: fresh catalog receives all six tables', () => {
    const catalog = runMigrationSql(migration02, new Map<string, TableState>());
    assert.deepEqual([...catalog.keys()].sort(), [...B2_TABLE_NAMES]);
});

test('migration 02 sequence: already migrated catalog is unchanged', () => {
    const migrated = runMigrationSql(migration02, new Map<string, TableState>());
    const before = snapshot(migrated);
    const after = runMigrationSql(migration02, migrated);
    assert.deepEqual(snapshot(after), before);
});

test('migration 02 sequence: double run is idempotent', () => {
    const first = runMigrationSql(migration02, new Map<string, TableState>());
    const second = runMigrationSql(migration02, first);
    assert.equal(second.size, 6);
    assert.deepEqual(snapshot(second), snapshot(first));
});
