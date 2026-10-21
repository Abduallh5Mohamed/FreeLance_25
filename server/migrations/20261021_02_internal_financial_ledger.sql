-- =============================================================================
-- B2-C-SCHEMA — internal financial ledger storage (Part C)
-- Task:    b2-c-schema-20261021-02
-- Batch:   batch2-claude-20261021
-- Date:    2026-10-21
-- Purpose: exact storage for the contract
--   docs/contracts/BILLING-LEDGER-INTERNAL-CONTRACT.md (written by B2-C-LEDGER)
--   served by domain code:
--   `server/src/services/billing-ledger.ts`      (LedgerStore/LedgerTransaction)
--   `server/src/services/billing-reservations.ts`(ReservationTransaction)
--
-- DESIGN (all money is EXACT integer minor units — EGP minor unit = piaster)
--   1. `billing_accounts`: one row per (tenant_id, kind, currency).
--      `balance_minor` is the signed BIGINT normal-side balance; CHECK >= 0.
--      `version` is the CAS counter for balance updates. Accounts are
--      provisioned explicitly; nothing auto-creates them.
--   2. `billing_journals`: append-only journal header. A correction is a NEW
--      reversal journal; a journal is reversed at most once per tenant
--      (UNIQUE (tenant_id, reversal_of_journal_id); MySQL allows many NULLs).
--   3. `billing_journal_lines`: PK (journal_id, line_no) keeps the posting
--      order; `amount_minor BIGINT UNSIGNED` strictly > 0; `account_kind` is
--      a snapshot at posting time. The composite FKs pin every line to its
--      own tenant's journal and account — a line cannot reach another
--      tenant's money, proven by existing UNIQUE keys, without a rebuild.
--   4. `billing_idempotency_keys`: canonical replay registry for journals and
--      reservations. PK (tenant_id, scope, idempotency_key) is the race
--      arbiter; `payload_hash` (lowercase SHA-256 hex) decides replay vs
--      conflict; journal_id/reservation_id is exactly one non-NULL target.
--   5. `billing_reservations`: exactly-once reserve/release/consume state,
--      CAS via `version`; immutable after insert except the transition
--      columns. Reservation replay keys live in the idempotency registry
--      (scope='reservation'), per contract §4.4 — not duplicated on the row.
--   6. `billing_reservation_events`: append-only transition log; every event
--      carries its journal and version_after.
--
-- APPEND-ONLY OBLIGATION (cannot be fully expressed in DDL)
--   UPDATE/DELETE on billing_journals, billing_journal_lines and
--   billing_reservation_events (and deletes on the other tables) MUST be
--   denied by the application privilege layer. Corrections are reversal
--   journals only. No triggers are used: nothing in this migration can
--   create them safely proven, and the contract does not require them.
--
-- NOT IN THIS SCHEMA (held, do not invent): fees, commission (approved rate
--   zero), dispute/cooling, refunds, payouts, invoices, tax, provider codes.
--   The legacy `instructor_wallets` / service-credit balances are NOT
--   reinterpreted as merchant money: no backfill, no mapping, no migration.
--
-- OWNERSHIP: every table carries tenant_id. FKs reference only tables/columns
--   whose uniqueness is already proven by this same file (composite
--   (id, tenant_id) UNIQUE keys) or the existing tenants(id) PK.
--
-- IDEMPOTENCY: every CREATE is guarded by an INFORMATION_SCHEMA probe +
--   PREPARE/EXECUTE so a re-run is a no-op. No DROP, no TRUNCATE, no
--   DELETE/UPDATE of data, no FOREIGN_KEY_CHECKS manipulation, no runtime DDL,
--   no backfill.
--
-- !! THIS FILE IS AUTHORING-ONLY. SQL EXECUTION and live bootstrap validation
--    are OUT OF SCOPE for this batch and require a separately approved
--    isolated bootstrap + live verification step before deployment.
-- =============================================================================

SET @b2c2_db = DATABASE();

-- -----------------------------------------------------------------------------
-- Step 1: billing_accounts — one balance row per (tenant, kind, currency).
-- -----------------------------------------------------------------------------
SET @b2c2_has_accounts = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.TABLES
    WHERE TABLE_SCHEMA = @b2c2_db AND TABLE_NAME = 'billing_accounts');

SET @b2c2_sql_accounts = IF(@b2c2_has_accounts = 0,
    "CREATE TABLE billing_accounts (
        id CHAR(36) NOT NULL,
        tenant_id CHAR(36) NOT NULL,
        kind ENUM('platform_receivable','platform_cash','merchant_pending','merchant_available','merchant_reserved','subscription_credit','cash_receipt_clearing') NOT NULL,
        normal_side ENUM('debit','credit') NOT NULL COMMENT 'Derived from kind at creation; normal-side balance convention',
        currency CHAR(3) NOT NULL COMMENT 'ISO-4217 uppercase; approved default EGP',
        balance_minor BIGINT NOT NULL DEFAULT 0 COMMENT 'Normal-side balance in exact integer minor units (EGP: piaster); never a float',
        version BIGINT UNSIGNED NOT NULL DEFAULT 0 COMMENT 'CAS counter incremented by every successful posting',
        created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
        updated_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
        PRIMARY KEY (id),
        UNIQUE KEY uq_billing_account_tenant_kind_currency (tenant_id, kind, currency),
        UNIQUE KEY uq_billing_account_id_tenant (id, tenant_id),
        KEY idx_billing_account_tenant (tenant_id, kind),
        CONSTRAINT fk_billing_account_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id),
        CONSTRAINT chk_billing_account_balance CHECK (balance_minor >= 0)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
      COMMENT 'B2 internal financial ledger: account per (tenant, kind, currency)'",
    'SELECT 1');
PREPARE b2c2_stmt_accounts FROM @b2c2_sql_accounts;
EXECUTE b2c2_stmt_accounts;
DEALLOCATE PREPARE b2c2_stmt_accounts;

-- -----------------------------------------------------------------------------
-- Step 2: billing_journals — append-only double-entry journal header.
-- The self-composite FK (reversal_of_journal_id, tenant_id) needs the
-- (id, tenant_id) UNIQUE key defined in this same statement. No updated_at:
-- the row is INSERT-only, corrections are new reversal journals.
-- -----------------------------------------------------------------------------
SET @b2c2_has_journals = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.TABLES
    WHERE TABLE_SCHEMA = @b2c2_db AND TABLE_NAME = 'billing_journals');

SET @b2c2_sql_journals = IF(@b2c2_has_journals = 0,
    "CREATE TABLE billing_journals (
        id CHAR(36) NOT NULL,
        tenant_id CHAR(36) NOT NULL,
        currency CHAR(3) NOT NULL COMMENT 'One journal has exactly one currency',
        journal_type ENUM('standard','reversal') NOT NULL DEFAULT 'standard',
        reversal_of_journal_id CHAR(36) NULL COMMENT 'Set only on reversal journals; original journal is never edited',
        reference VARCHAR(200) NULL,
        description VARCHAR(500) NULL,
        created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
        PRIMARY KEY (id),
        UNIQUE KEY uq_billing_journal_id_tenant (id, tenant_id),
        UNIQUE KEY uq_billing_journal_reversal (tenant_id, reversal_of_journal_id),
        KEY idx_billing_journal_tenant_created (tenant_id, created_at),
        CONSTRAINT fk_billing_journal_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id),
        CONSTRAINT fk_billing_journal_reversal_of FOREIGN KEY (reversal_of_journal_id, tenant_id) REFERENCES billing_journals (id, tenant_id),
        CONSTRAINT chk_billing_journal_reversal CHECK ((journal_type = 'reversal') = (reversal_of_journal_id IS NOT NULL))
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
      COMMENT 'B2 append-only double-entry journal header'",
    'SELECT 1');
PREPARE b2c2_stmt_journals FROM @b2c2_sql_journals;
EXECUTE b2c2_stmt_journals;
DEALLOCATE PREPARE b2c2_stmt_journals;

-- -----------------------------------------------------------------------------
-- Step 3: billing_journal_lines — ordered, balanced-debit/credit lines of one
-- journal. PK (journal_id, line_no) keeps posting order; the tenant composite
-- FKs make a foreign journal/account impossible; amount_minor is an exact
-- positive integer of minor units bounded by the domain MAX_AMOUNT_MINOR.
-- -----------------------------------------------------------------------------
SET @b2c2_has_lines = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.TABLES
    WHERE TABLE_SCHEMA = @b2c2_db AND TABLE_NAME = 'billing_journal_lines');

SET @b2c2_sql_lines = IF(@b2c2_has_lines = 0,
    "CREATE TABLE billing_journal_lines (
        journal_id CHAR(36) NOT NULL,
        line_no SMALLINT UNSIGNED NOT NULL COMMENT '1-based posting order within the journal (domain bound: <= 100 lines)',
        tenant_id CHAR(36) NOT NULL,
        account_id CHAR(36) NOT NULL,
        account_kind ENUM('platform_receivable','platform_cash','merchant_pending','merchant_available','merchant_reserved','subscription_credit','cash_receipt_clearing') NOT NULL COMMENT 'Snapshot of the account kind at posting time',
        direction ENUM('debit','credit') NOT NULL,
        amount_minor BIGINT UNSIGNED NOT NULL COMMENT 'Exact positive integer minor units; <= 1000000000000000 (MAX_AMOUNT_MINOR)',
        created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
        PRIMARY KEY (journal_id, line_no),
        KEY idx_billing_line_tenant_account (tenant_id, account_id),
        CONSTRAINT fk_billing_line_journal FOREIGN KEY (journal_id, tenant_id) REFERENCES billing_journals (id, tenant_id),
        CONSTRAINT fk_billing_line_account FOREIGN KEY (account_id, tenant_id) REFERENCES billing_accounts (id, tenant_id),
        CONSTRAINT chk_billing_line_no CHECK (line_no >= 1),
        CONSTRAINT chk_billing_line_amount CHECK (amount_minor > 0 AND amount_minor <= 1000000000000000)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
      COMMENT 'B2 append-only journal lines; debits==credits per journal currency'",
    'SELECT 1');
PREPARE b2c2_stmt_lines FROM @b2c2_sql_lines;
EXECUTE b2c2_stmt_lines;
DEALLOCATE PREPARE b2c2_stmt_lines;

-- -----------------------------------------------------------------------------
-- Step 4: billing_reservations — exactly-once amount held from available.
-- Mutable only through the version CAS (status/release/consume columns);
-- the reservation replay key and its payload hash live in
-- billing_idempotency_keys (scope='reservation'), per contract §4.4/§4.5.
-- -----------------------------------------------------------------------------
SET @b2c2_has_reservations = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.TABLES
    WHERE TABLE_SCHEMA = @b2c2_db AND TABLE_NAME = 'billing_reservations');

SET @b2c2_sql_reservations = IF(@b2c2_has_reservations = 0,
    "CREATE TABLE billing_reservations (
        id CHAR(36) NOT NULL,
        tenant_id CHAR(36) NOT NULL,
        currency CHAR(3) NOT NULL,
        amount_minor BIGINT UNSIGNED NOT NULL COMMENT 'Exact positive integer minor units; <= 1000000000000000 (MAX_AMOUNT_MINOR)',
        available_account_id CHAR(36) NOT NULL,
        reserved_account_id CHAR(36) NOT NULL,
        status ENUM('reserved','released','consumed') NOT NULL DEFAULT 'reserved',
        version BIGINT UNSIGNED NOT NULL DEFAULT 0 COMMENT 'CAS counter; release/consume filter status_reserved AND version',
        reserve_journal_id CHAR(36) NOT NULL,
        release_journal_id CHAR(36) NULL,
        consume_journal_id CHAR(36) NULL,
        consume_counter_account_id CHAR(36) NULL COMMENT 'Platform-side account the consumed amount was debited to, never a merchant wallet',
        reference VARCHAR(200) NULL,
        description VARCHAR(500) NULL,
        created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
        updated_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
        PRIMARY KEY (id),
        UNIQUE KEY uq_billing_reservation_id_tenant (id, tenant_id),
        KEY idx_billing_reservation_tenant_status (tenant_id, status),
        CONSTRAINT fk_billing_reservation_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id),
        CONSTRAINT fk_billing_reservation_available FOREIGN KEY (available_account_id, tenant_id) REFERENCES billing_accounts (id, tenant_id),
        CONSTRAINT fk_billing_reservation_reserved FOREIGN KEY (reserved_account_id, tenant_id) REFERENCES billing_accounts (id, tenant_id),
        CONSTRAINT fk_billing_reservation_counter FOREIGN KEY (consume_counter_account_id, tenant_id) REFERENCES billing_accounts (id, tenant_id),
        CONSTRAINT fk_billing_reservation_reserve_journal FOREIGN KEY (reserve_journal_id, tenant_id) REFERENCES billing_journals (id, tenant_id),
        CONSTRAINT fk_billing_reservation_release_journal FOREIGN KEY (release_journal_id, tenant_id) REFERENCES billing_journals (id, tenant_id),
        CONSTRAINT fk_billing_reservation_consume_journal FOREIGN KEY (consume_journal_id, tenant_id) REFERENCES billing_journals (id, tenant_id),
        CONSTRAINT chk_billing_reservation_amount CHECK (amount_minor > 0 AND amount_minor <= 1000000000000000),
        CONSTRAINT chk_billing_reservation_accounts CHECK (available_account_id <> reserved_account_id),
        CONSTRAINT chk_billing_reservation_release CHECK ((status <> 'released') OR (release_journal_id IS NOT NULL)),
        CONSTRAINT chk_billing_reservation_consume CHECK ((status <> 'consumed') OR (consume_journal_id IS NOT NULL)),
        CONSTRAINT chk_billing_reservation_version CHECK (version >= 0)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
      COMMENT 'B2 exactly-once reserve/release/consume state; CAS via version'",
    'SELECT 1');
PREPARE b2c2_stmt_reservations FROM @b2c2_sql_reservations;
EXECUTE b2c2_stmt_reservations;
DEALLOCATE PREPARE b2c2_stmt_reservations;

-- -----------------------------------------------------------------------------
-- Step 5: billing_idempotency_keys — canonical replay registry for journals
-- and reservations. Created AFTER both target tables so the composite FKs and
-- the exactly-one-target CHECK can be expressed in full (contract §10,
-- question 1, resolved by creation order, not scope split).
-- -----------------------------------------------------------------------------
SET @b2c2_has_idempotency = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.TABLES
    WHERE TABLE_SCHEMA = @b2c2_db AND TABLE_NAME = 'billing_idempotency_keys');

SET @b2c2_sql_idempotency = IF(@b2c2_has_idempotency = 0,
    "CREATE TABLE billing_idempotency_keys (
        tenant_id CHAR(36) NOT NULL,
        scope VARCHAR(32) NOT NULL COMMENT 'journal | reservation',
        idempotency_key VARCHAR(128) NOT NULL,
        payload_hash CHAR(64) NOT NULL COMMENT 'Lowercase SHA-256 hex of the canonical payload; decides replay vs conflict',
        journal_id CHAR(36) NULL,
        reservation_id CHAR(36) NULL,
        created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
        PRIMARY KEY (tenant_id, scope, idempotency_key),
        UNIQUE KEY uq_billing_idem_journal (journal_id),
        UNIQUE KEY uq_billing_idem_reservation (reservation_id),
        CONSTRAINT fk_billing_idem_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id),
        CONSTRAINT fk_billing_idem_journal FOREIGN KEY (journal_id, tenant_id) REFERENCES billing_journals (id, tenant_id),
        CONSTRAINT fk_billing_idem_reservation FOREIGN KEY (reservation_id, tenant_id) REFERENCES billing_reservations (id, tenant_id),
        CONSTRAINT chk_billing_idem_target CHECK ((journal_id IS NULL) <> (reservation_id IS NULL))
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
      COMMENT 'B2 canonical idempotency registry: PK is the per-tenant key arbiter'",
    'SELECT 1');
PREPARE b2c2_stmt_idempotency FROM @b2c2_sql_idempotency;
EXECUTE b2c2_stmt_idempotency;
DEALLOCATE PREPARE b2c2_stmt_idempotency;

-- -----------------------------------------------------------------------------
-- Step 6: billing_reservation_events — append-only transition log. The event
-- uniqueness uses (reservation_id, event_type, idempotency_key) per contract
-- §10 question 2, so a future reversal stream may carry distinct keys while
-- reserve/release/consume remain single events (their keys are derived
-- deterministically from the reservation identity).
-- -----------------------------------------------------------------------------
SET @b2c2_has_events = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.TABLES
    WHERE TABLE_SCHEMA = @b2c2_db AND TABLE_NAME = 'billing_reservation_events');

SET @b2c2_sql_events = IF(@b2c2_has_events = 0,
    "CREATE TABLE billing_reservation_events (
        id CHAR(36) NOT NULL,
        tenant_id CHAR(36) NOT NULL,
        reservation_id CHAR(36) NOT NULL,
        event_type ENUM('reserve','release','consume','reversal') NOT NULL,
        amount_minor BIGINT UNSIGNED NOT NULL COMMENT 'Exact positive integer minor units; <= 1000000000000000 (MAX_AMOUNT_MINOR)',
        journal_id CHAR(36) NOT NULL,
        version_after BIGINT UNSIGNED NOT NULL COMMENT 'Reservation version immediately after the transition',
        idempotency_key VARCHAR(128) NOT NULL,
        created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
        PRIMARY KEY (id),
        UNIQUE KEY uq_billing_reservation_event_key (tenant_id, idempotency_key),
        UNIQUE KEY uq_billing_reservation_event_type (reservation_id, event_type, idempotency_key),
        KEY idx_billing_reservation_event (tenant_id, reservation_id, created_at),
        CONSTRAINT fk_billing_reservation_event_reservation FOREIGN KEY (reservation_id, tenant_id) REFERENCES billing_reservations (id, tenant_id),
        CONSTRAINT fk_billing_reservation_event_journal FOREIGN KEY (journal_id, tenant_id) REFERENCES billing_journals (id, tenant_id),
        CONSTRAINT chk_billing_reservation_event_amount CHECK (amount_minor > 0 AND amount_minor <= 1000000000000000)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
      COMMENT 'B2 append-only reservation transition log; never updated/deleted'",
    'SELECT 1');
PREPARE b2c2_stmt_events FROM @b2c2_sql_events;
EXECUTE b2c2_stmt_events;
DEALLOCATE PREPARE b2c2_stmt_events;
