-- =============================================================================
-- B3-C-SCHEMA (settlement closure) — settlement obligations, checkout
-- idempotency, payment allocations and invoice-issuance journal links
-- Task:    S1 (sole schema writer)
-- Date:    2026-10-23
-- Purpose: additive, authoring-only storage for the settled financial rules:
--   R1 explicit financial-idempotency table for checkout creation
--   R2 verified merchant receipt and settlement obligations (outbox)
--   R3 single debt source + allocation ledger for platform invoices
--   R4 checkout idempotency key shape (tenant, key, payload hash, order)
--   R8 invoice issuance must link its receivable journal
--   R9 immutable payout destination snapshot (verified, no new column)
--   Contract: docs/contracts/B3-SCHEMA-CONTRACT-20261022.md
--   Inventory: docs/streams/server/CL-C-SCHEMA-20261022.md
--
-- DESIGN (all money is EXACT integer minor units; MAX_AMOUNT_MINOR = 10^15)
--   1. `financial_settlement_obligations`: the durable obligation/outbox for
--      one verified checkout payment. It stores the verified gross amount,
--      the canonical order/purpose/provider identities, the payload hash used
--      to decide replay versus conflict, the optional proved fee/tax/net, the
--      status, the reconciliation state and (only when completed) the FIN3
--      journal that posted the money. Unknown fee/tax/net stays NULL and is
--      NEVER replaced by 0. `status='awaiting_allocation'` is the settled
--      decision for "verified payment but fee/net not proved"; it is a valid
--      resting state, not an error. `completed` requires a journal and a
--      proved net. Replaying the same provider event is prevented by
--      UNIQUE (tenant_id, provider, provider_event_id); one obligation per
--      (tenant, order, purpose) prevents double-counting a checkout.
--   2. `checkout_order_idempotency_keys`: R4/R1. A dedicated table keyed
--      (tenant_id, scope, idempotency_key) storing the canonical payload hash
--      and the order created by the first request. The scope is required by
--      `CheckoutOrderIdempotencyRecord` (checkout creation uses
--      'payment.checkout.order_create'). Same key + same hash replays;
--      same key + another hash is a typed conflict. It is deliberately NOT a
--      row in `billing_idempotency_keys`: that table's exactly-one-of
--      journal/reservation/invoice target CHECK belongs to the frozen
--      20261022_02 source and its target set cannot be extended additively.
--      This table keeps the SAME key/hash/replay shape (tenant, key,
--      payload hash) and only adds the checkout order target.
--   3. `billing_payment_allocations`: R3. One row per applied debt reduction
--      on a platform invoice. The invoice is the single outstanding-debt
--      source; there is no stored outstanding column. `amount_minor` is
--      exact, positive and capped at 10^15. A `payment` allocation MUST name
--      the verified obligation and the journal that posted it; `credit` and
--      `reversal` allocations name their journal too. Double allocation is
--      prevented by UNIQUE (tenant_id, payment_reference, invoice_id, kind).
--      A composite FK (invoice_id, tenant_id, currency) proves that the
--      allocation currency is the invoice currency, so an allocation can
--      never apply an amount of another currency. The FK target is the
--      guarded UNIQUE (id, tenant_id, currency) added to `billing_invoices`
--      below.
--   4. `billing_invoice_journals`: R8. One row per issued invoice, linking the
--      invoice to the FIN3 journal that recorded its receivable. Both sides
--      are unique, so neither an invoice nor a journal can be linked twice.
--      Ledger account kinds are FIN3-owned; this file changes NO account
--      kind. The income-side account proposal (`platform_revenue`, normal side
--      credit) is recorded in CL-C only and is a written proposal, not DDL.
--   5. `billing_difference_requests.invoice_ref_id` (additive nullable shadow
--      column): the existing `invoice_id` is an opaque VARCHAR(128) caller
--      reference, while `billing_invoices.id` is CHAR(36). Re-typing the
--      existing column would be destructive, so the FK-capable link is a new
--      nullable CHAR(36) column + guarded UNIQUE on the invoice side +
--      orphan/currency preflight. A row with `invoice_ref_id` set must point
--      at an existing invoice of the same tenant and currency; NULL means
--      "not linked yet" (legacy/opaque reference only). Population of the new
--      column by the difference-request writer is a CONTRACT REQUEST, not a
--      schema change.
--
-- HELD (not represented as DDL; reported in the task summary)
--   * An explicit invoice due instant has no column in `billing_invoices`
--     (20261022_02) and no domain field. Not invented here.
--   * Payout destination "version" is not a domain concept
--     (`PayoutRequest` has `destinationRef` only). The existing immutable
--     request-time `destination_ref` snapshot is preserved by the payout CAS
--     column set, so no new column is added.
--   * Provider failure evidence reference (R5) is not present in
--     `billing-payouts.ts` (`failureReason` only). Not invented here.
--   * Income-side account kind (`platform_revenue`) is a proposal only.
--
-- PRE-EXISTING TABLE SHAPE (fail closed)
--   A pre-existing table is never trusted by name alone. Structural probes
--   require the exact ordered PRIMARY KEY columns, every expected named CHECK
--   and named FOREIGN KEY, the exact UNIQUE-key shape (columns, order,
--   uniqueness, no prefix SUB_PART), and the exact COLLATION_NAME for every
--   probed identity/currency/FK column. A failure aborts before mutation via
--   a migration-unique literal helper procedure whose single statement is
--   SIGNAL. HONEST LIMIT: CHECK/FK probes on the new tables and on the
--   pre-existing tables are NAME-ONLY (as in migration 04); a same-named but
--   weaker constraint is not detected. PK/UNIQUE/SUB_PART/COLLATION are
--   checked structurally. The difference-request link FK is checked by
--   columns and referenced columns because it is the one critical additive
--   link.
--
-- IDEMPOTENCY OF THIS FILE
--   Every CREATE TABLE is probed with INFORMATION_SCHEMA.TABLES and issued
--   via PREPARE/EXECUTE, so a re-run is a no-op. Every ADD is probed for the
--   exact index/column name AND its shape before it is issued; after every
--   mutation the probe is recomputed independently. A same-named object with
--   another shape is NEVER accepted: the guarded ADD then fails loudly (or
--   the post-mutation drift guard signals). No DROP TABLE, no TRUNCATE, no
--   DELETE/UPDATE of data, no FOREIGN_KEY_CHECKS manipulation, no backfill,
--   no column type change, no data rewrite.
--
-- COLLATION
--   New identity/lookup/hash/currency columns use `utf8mb4_0900_bin`
--   (binary, case-sensitive, NO PAD). Columns that are FOREIGN KEYs to
--   legacy/FIN3 tables keep the referenced `utf8mb4_unicode_ci` so the FK
--   remains valid (tenants, checkout_orders, checkout_provider_events,
--   billing_invoices, billing_journals, and the parent obligation id are
--   verified/probed here). `purpose` is byte-exact 0900_bin because it is a
--   canonical opaque code, not a FK.
--
-- PRIVILEGES FOR THE STRUCTURAL GUARDS
--   This file uses NINE literal top-level CREATE PROCEDURE helpers, each with
--   a one-statement SIGNAL body and a name unique to this migration. MySQL
--   8.0 does NOT allow CREATE/DROP PROCEDURE inside a prepared statement, so
--   each CREATE is literal and UNCONDITIONAL on EVERY run (including clean
--   runs): the connecting account needs CREATE ROUTINE and ALTER ROUTINE (for
--   the literal DROP) in addition to DDL rights. These are PERSISTENT stored
--   routines, not temporary objects. There is NO `DROP PROCEDURE IF EXISTS`
--   before the CREATE: error 1304 on an existing name is the fail-closed
--   collision protection; a leftover helper from a drift failure blocks the
--   rerun until the operator drops that exact helper manually after
--   reconciling the drift (the SIGNAL text names it). On the non-drift path
--   the literal DROP after the dispatch can only remove this run's own
--   freshly created helper. No explicit DEFINER is written; the routine is
--   created by the connecting account (SQL SECURITY DEFINER default resolves
--   to that account). Live assumptions to verify: that account's SQL_MODE
--   and, when binary logging is enabled, log_bin_trust_function_creators.
--
-- PREREQUISITE
--   FIN3 (`20261021_02_internal_financial_ledger.sql`) must already be
--   applied: `billing_journals` and its `(id, tenant_id)` key are referenced,
--   and `billing_accounts` must already carry UNIQUE (tenant_id, kind,
--   currency). Migrations 20261022_02 (invoices/difference requests) and
--   20261022_03 (checkout orders/provider events) must already be applied.
--   All prerequisites are probed; a missing/divergent one aborts before any
--   mutation.
--
-- !! THIS FILE IS AUTHORING-ONLY SOURCE DDL. No statement here is executed,
--    no database is connected to. Manifest registration is Codex's.
-- =============================================================================

SET @c5_db = DATABASE();

-- -----------------------------------------------------------------------------
-- Step 1: prerequisite + FIN3 shape guard (fail closed, no mutation).
--   billing_accounts: UNIQUE (tenant_id, kind, currency) exactly, account
--     kinds owned by FIN3 and unchanged here.
--   billing_journals: (id, tenant_id) UNIQUE exists and is referenced.
-- -----------------------------------------------------------------------------
SET @c5_has_accounts = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.TABLES
    WHERE TABLE_SCHEMA = @c5_db AND TABLE_NAME = 'billing_accounts');

SET @c5_has_journals = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.TABLES
    WHERE TABLE_SCHEMA = @c5_db AND TABLE_NAME = 'billing_journals');

SET @c5_accounts_uq_shape = (SELECT COUNT(*) FROM (
    SELECT INDEX_NAME
    FROM INFORMATION_SCHEMA.STATISTICS
    WHERE TABLE_SCHEMA = @c5_db AND TABLE_NAME = 'billing_accounts'
      AND INDEX_NAME = 'uq_billing_account_tenant_kind_currency'
    GROUP BY INDEX_NAME
    HAVING COUNT(*) = 3
       AND MIN(NON_UNIQUE) = 0
       AND MAX(SUB_PART) IS NULL
       AND GROUP_CONCAT(COLUMN_NAME ORDER BY SEQ_IN_INDEX) = 'tenant_id,kind,currency'
) AS c5_accounts_uq_probe);

SET @c5_accounts_collation_ok = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA = @c5_db AND TABLE_NAME = 'billing_accounts'
      AND COLUMN_NAME IN ('tenant_id','kind','currency')
      AND COLLATION_NAME = 'utf8mb4_unicode_ci');

SET @c5_accounts_columns_ok = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA = @c5_db AND TABLE_NAME = 'billing_accounts'
      AND COLUMN_NAME IN ('id','tenant_id','kind','normal_side','currency',
          'balance_minor','version'));

SET @c5_journals_pk_ok = (SELECT COUNT(*) FROM (
    SELECT INDEX_NAME
    FROM INFORMATION_SCHEMA.STATISTICS
    WHERE TABLE_SCHEMA = @c5_db AND TABLE_NAME = 'billing_journals'
      AND INDEX_NAME = 'PRIMARY'
    GROUP BY INDEX_NAME
    HAVING COUNT(*) = 1
       AND GROUP_CONCAT(COLUMN_NAME ORDER BY SEQ_IN_INDEX) = 'id'
) AS c5_journals_pk_probe);

SET @c5_journals_uq_shape = (SELECT COUNT(*) FROM (
    SELECT INDEX_NAME
    FROM INFORMATION_SCHEMA.STATISTICS
    WHERE TABLE_SCHEMA = @c5_db AND TABLE_NAME = 'billing_journals'
      AND INDEX_NAME = 'uq_billing_journal_id_tenant'
    GROUP BY INDEX_NAME
    HAVING COUNT(*) = 2
       AND MIN(NON_UNIQUE) = 0
       AND MAX(SUB_PART) IS NULL
       AND GROUP_CONCAT(COLUMN_NAME ORDER BY SEQ_IN_INDEX) = 'id,tenant_id'
) AS c5_journals_uq_probe);

SET @c5_journals_collation_ok = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA = @c5_db AND TABLE_NAME = 'billing_journals'
      AND COLUMN_NAME IN ('id','tenant_id')
      AND COLLATION_NAME = 'utf8mb4_unicode_ci');

SET @c5_fin3_drift = IF(@c5_has_accounts = 1
    AND @c5_has_journals = 1
    AND @c5_accounts_uq_shape = 1
    AND @c5_accounts_collation_ok = 3
    AND @c5_accounts_columns_ok = 7
    AND @c5_journals_pk_ok = 1
    AND @c5_journals_uq_shape = 1
    AND @c5_journals_collation_ok = 2, 0, 1);

CREATE PROCEDURE c5_20261023_01_guard_fin3()
    COMMENT 'tabweb 20261023_01 guard helper (safe to drop)'
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Schema drift; reconcile, remove helper c5_20261023_01_guard_fin3, then rerun.';

SET @c5_sql_fin3_call = IF(@c5_fin3_drift = 1,
    'CALL c5_20261023_01_guard_fin3()',
    'SELECT 1');
PREPARE c5_stmt_fin3_call FROM @c5_sql_fin3_call;
EXECUTE c5_stmt_fin3_call;
DEALLOCATE PREPARE c5_stmt_fin3_call;

DROP PROCEDURE c5_20261023_01_guard_fin3;

-- -----------------------------------------------------------------------------
-- Step 2: pre-existing billing_invoices shape (before adding the currency key).
--   PK (id); CHECKs total/minor_units/offer_pair; FKs tenant/price/offer
--   snapshot; UNIQUE (id, tenant_id); unicode_ci id/tenant_id/currency.
-- -----------------------------------------------------------------------------
SET @c5_has_invoices = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.TABLES
    WHERE TABLE_SCHEMA = @c5_db AND TABLE_NAME = 'billing_invoices');

SET @c5_invoices_pk_ok = (SELECT COUNT(*) FROM (
    SELECT INDEX_NAME
    FROM INFORMATION_SCHEMA.STATISTICS
    WHERE TABLE_SCHEMA = @c5_db AND TABLE_NAME = 'billing_invoices'
      AND INDEX_NAME = 'PRIMARY'
    GROUP BY INDEX_NAME
    HAVING COUNT(*) = 1
       AND GROUP_CONCAT(COLUMN_NAME ORDER BY SEQ_IN_INDEX) = 'id'
) AS c5_invoices_pk_probe);

SET @c5_invoices_uq_shape = (SELECT COUNT(*) FROM (
    SELECT INDEX_NAME
    FROM INFORMATION_SCHEMA.STATISTICS
    WHERE TABLE_SCHEMA = @c5_db AND TABLE_NAME = 'billing_invoices'
      AND INDEX_NAME = 'uq_billing_invoice_id_tenant'
    GROUP BY INDEX_NAME
    HAVING COUNT(*) = 2
       AND MIN(NON_UNIQUE) = 0
       AND MAX(SUB_PART) IS NULL
       AND GROUP_CONCAT(COLUMN_NAME ORDER BY SEQ_IN_INDEX) = 'id,tenant_id'
) AS c5_invoices_uq_probe);

SET @c5_invoices_checks_ok = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.TABLE_CONSTRAINTS
    WHERE CONSTRAINT_SCHEMA = @c5_db AND TABLE_NAME = 'billing_invoices'
      AND CONSTRAINT_TYPE = 'CHECK'
      AND CONSTRAINT_NAME IN ('chk_billing_invoice_total',
          'chk_billing_invoice_minor_units','chk_billing_invoice_offer_pair'));

SET @c5_invoices_fks_ok = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.TABLE_CONSTRAINTS
    WHERE CONSTRAINT_SCHEMA = @c5_db AND TABLE_NAME = 'billing_invoices'
      AND CONSTRAINT_TYPE = 'FOREIGN KEY'
      AND CONSTRAINT_NAME IN ('fk_billing_invoice_tenant',
          'fk_billing_invoice_price_snapshot','fk_billing_invoice_offer_snapshot'));

SET @c5_invoices_collation_ok = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA = @c5_db AND TABLE_NAME = 'billing_invoices'
      AND COLUMN_NAME IN ('id','tenant_id','currency')
      AND COLLATION_NAME = 'utf8mb4_unicode_ci');

SET @c5_invoices_drift = IF(@c5_has_invoices = 1
    AND @c5_invoices_pk_ok = 1
    AND @c5_invoices_uq_shape = 1
    AND @c5_invoices_checks_ok = 3
    AND @c5_invoices_fks_ok = 3
    AND @c5_invoices_collation_ok = 3, 0, 1);

CREATE PROCEDURE c5_20261023_01_guard_invoice_shape()
    COMMENT 'tabweb 20261023_01 guard helper (safe to drop)'
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'billing_invoices shape drift: DROP PROCEDURE c5_20261023_01_guard_invoice_shape, rerun';

SET @c5_sql_invoice_shape_call = IF(@c5_invoices_drift = 1,
    'CALL c5_20261023_01_guard_invoice_shape()',
    'SELECT 1');
PREPARE c5_stmt_invoice_shape_call FROM @c5_sql_invoice_shape_call;
EXECUTE c5_stmt_invoice_shape_call;
DEALLOCATE PREPARE c5_stmt_invoice_shape_call;

DROP PROCEDURE c5_20261023_01_guard_invoice_shape;

-- -----------------------------------------------------------------------------
-- Step 3: pre-existing billing_difference_requests shape (before adding the
--   shadow invoice_ref_id link). Opaque invoice_id stays VARCHAR(128).
-- -----------------------------------------------------------------------------
SET @c5_has_difference = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.TABLES
    WHERE TABLE_SCHEMA = @c5_db AND TABLE_NAME = 'billing_difference_requests');

SET @c5_difference_pk_ok = (SELECT COUNT(*) FROM (
    SELECT INDEX_NAME
    FROM INFORMATION_SCHEMA.STATISTICS
    WHERE TABLE_SCHEMA = @c5_db AND TABLE_NAME = 'billing_difference_requests'
      AND INDEX_NAME = 'PRIMARY'
    GROUP BY INDEX_NAME
    HAVING COUNT(*) = 1
       AND GROUP_CONCAT(COLUMN_NAME ORDER BY SEQ_IN_INDEX) = 'id'
) AS c5_difference_pk_probe);

SET @c5_difference_uq_shape = (SELECT COUNT(*) FROM (
    SELECT INDEX_NAME
    FROM INFORMATION_SCHEMA.STATISTICS
    WHERE TABLE_SCHEMA = @c5_db AND TABLE_NAME = 'billing_difference_requests'
      AND INDEX_NAME = 'uq_billing_diff_request_id_tenant'
    GROUP BY INDEX_NAME
    HAVING COUNT(*) = 2
       AND MIN(NON_UNIQUE) = 0
       AND MAX(SUB_PART) IS NULL
       AND GROUP_CONCAT(COLUMN_NAME ORDER BY SEQ_IN_INDEX) = 'id,tenant_id'
) AS c5_difference_uq_probe);

SET @c5_difference_checks_ok = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.TABLE_CONSTRAINTS
    WHERE CONSTRAINT_SCHEMA = @c5_db AND TABLE_NAME = 'billing_difference_requests'
      AND CONSTRAINT_TYPE = 'CHECK'
      AND CONSTRAINT_NAME IN ('chk_billing_diff_request_amount',
          'chk_billing_diff_request_order','chk_billing_diff_request_grace',
          'chk_billing_diff_request_settled','chk_billing_diff_request_version'));

SET @c5_difference_fks_ok = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.TABLE_CONSTRAINTS
    WHERE CONSTRAINT_SCHEMA = @c5_db AND TABLE_NAME = 'billing_difference_requests'
      AND CONSTRAINT_TYPE = 'FOREIGN KEY'
      AND CONSTRAINT_NAME IN ('fk_billing_diff_request_tenant',
          'fk_billing_diff_request_correction_of'));

SET @c5_difference_columns_ok = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA = @c5_db AND TABLE_NAME = 'billing_difference_requests'
      AND COLUMN_NAME IN ('id','tenant_id','org_kind','invoice_id','cycle_start',
          'difference_basis','basis_key','amount_minor','currency','issued_at',
          'deadline_at','status','version','request_key','payload_hash',
          'paid_at','settled_payment_id','correction_of_request_id',
          'correction_reason','corrected_by_actor_id','created_at','updated_at'));

SET @c5_difference_collation_ok = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA = @c5_db AND TABLE_NAME = 'billing_difference_requests'
      AND COLUMN_NAME IN ('tenant_id','invoice_id','currency')
      AND COLLATION_NAME = 'utf8mb4_unicode_ci');

SET @c5_difference_drift = IF(@c5_has_difference = 1
    AND @c5_difference_pk_ok = 1
    AND @c5_difference_uq_shape = 1
    AND @c5_difference_checks_ok = 5
    AND @c5_difference_fks_ok = 2
    AND @c5_difference_columns_ok = 22
    AND @c5_difference_collation_ok = 3, 0, 1);

CREATE PROCEDURE c5_20261023_01_guard_difference_shape()
    COMMENT 'tabweb 20261023_01 guard helper (safe to drop)'
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'billing_difference_requests shape drift: DROP PROCEDURE c5_20261023_01_guard_difference_shape, rerun';

SET @c5_sql_difference_shape_call = IF(@c5_difference_drift = 1,
    'CALL c5_20261023_01_guard_difference_shape()',
    'SELECT 1');
PREPARE c5_stmt_difference_shape_call FROM @c5_sql_difference_shape_call;
EXECUTE c5_stmt_difference_shape_call;
DEALLOCATE PREPARE c5_stmt_difference_shape_call;

DROP PROCEDURE c5_20261023_01_guard_difference_shape;

-- -----------------------------------------------------------------------------
-- Step 4: pre-existing checkout_orders / checkout_provider_events shape.
--   checkout_orders.purpose is VARCHAR(64) (opaque), NOT an ENUM/CHECK; a
--   'student_tuition' code is therefore already admissible (verified, no
--   ALTER here).
-- -----------------------------------------------------------------------------
SET @c5_has_orders = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.TABLES
    WHERE TABLE_SCHEMA = @c5_db AND TABLE_NAME = 'checkout_orders');

SET @c5_has_provider_events = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.TABLES
    WHERE TABLE_SCHEMA = @c5_db AND TABLE_NAME = 'checkout_provider_events');

SET @c5_orders_pk_ok = (SELECT COUNT(*) FROM (
    SELECT INDEX_NAME
    FROM INFORMATION_SCHEMA.STATISTICS
    WHERE TABLE_SCHEMA = @c5_db AND TABLE_NAME = 'checkout_orders'
      AND INDEX_NAME = 'PRIMARY'
    GROUP BY INDEX_NAME
    HAVING COUNT(*) = 2
       AND GROUP_CONCAT(COLUMN_NAME ORDER BY SEQ_IN_INDEX) = 'tenant_id,order_id'
) AS c5_orders_pk_probe);

SET @c5_orders_checks_ok = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.TABLE_CONSTRAINTS
    WHERE CONSTRAINT_SCHEMA = @c5_db AND TABLE_NAME = 'checkout_orders'
      AND CONSTRAINT_TYPE = 'CHECK'
      AND CONSTRAINT_NAME IN ('chk_checkout_orders_amount',
          'chk_checkout_orders_confirmation','chk_checkout_orders_last_event'));

SET @c5_orders_fks_ok = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.TABLE_CONSTRAINTS
    WHERE CONSTRAINT_SCHEMA = @c5_db AND TABLE_NAME = 'checkout_orders'
      AND CONSTRAINT_TYPE = 'FOREIGN KEY'
      AND CONSTRAINT_NAME IN ('fk_checkout_orders_tenant'));

SET @c5_orders_collation_ok = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA = @c5_db AND TABLE_NAME = 'checkout_orders'
      AND COLUMN_NAME IN ('tenant_id','order_id','purpose','currency')
      AND COLLATION_NAME = 'utf8mb4_unicode_ci');

SET @c5_orders_purpose_ok = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA = @c5_db AND TABLE_NAME = 'checkout_orders'
      AND COLUMN_NAME = 'purpose'
      AND COLUMN_TYPE = 'varchar(64)');

SET @c5_events_pk_ok = (SELECT COUNT(*) FROM (
    SELECT INDEX_NAME
    FROM INFORMATION_SCHEMA.STATISTICS
    WHERE TABLE_SCHEMA = @c5_db AND TABLE_NAME = 'checkout_provider_events'
      AND INDEX_NAME = 'PRIMARY'
    GROUP BY INDEX_NAME
    HAVING COUNT(*) = 2
       AND GROUP_CONCAT(COLUMN_NAME ORDER BY SEQ_IN_INDEX) = 'provider,provider_event_id'
) AS c5_events_pk_probe);

SET @c5_events_checks_ok = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.TABLE_CONSTRAINTS
    WHERE CONSTRAINT_SCHEMA = @c5_db AND TABLE_NAME = 'checkout_provider_events'
      AND CONSTRAINT_TYPE = 'CHECK'
      AND CONSTRAINT_NAME IN ('chk_provider_events_amount'));

SET @c5_events_fks_ok = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.TABLE_CONSTRAINTS
    WHERE CONSTRAINT_SCHEMA = @c5_db AND TABLE_NAME = 'checkout_provider_events'
      AND CONSTRAINT_TYPE = 'FOREIGN KEY'
      AND CONSTRAINT_NAME IN ('fk_provider_events_tenant'));

SET @c5_events_collation_ok = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA = @c5_db AND TABLE_NAME = 'checkout_provider_events'
      AND COLUMN_NAME IN ('provider','provider_event_id','tenant_id','order_ref','currency')
      AND COLLATION_NAME = 'utf8mb4_unicode_ci');

SET @c5_checkout_drift = IF(@c5_has_orders = 1
    AND @c5_has_provider_events = 1
    AND @c5_orders_pk_ok = 1
    AND @c5_orders_checks_ok = 3
    AND @c5_orders_fks_ok = 1
    AND @c5_orders_collation_ok = 4
    AND @c5_orders_purpose_ok = 1
    AND @c5_events_pk_ok = 1
    AND @c5_events_checks_ok = 1
    AND @c5_events_fks_ok = 1
    AND @c5_events_collation_ok = 5, 0, 1);

CREATE PROCEDURE c5_20261023_01_guard_checkout_shape()
    COMMENT 'tabweb 20261023_01 guard helper (safe to drop)'
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'checkout_orders/checkout_provider_events shape drift: DROP PROCEDURE c5_20261023_01_guard_checkout_shape, rerun';

SET @c5_sql_checkout_shape_call = IF(@c5_checkout_drift = 1,
    'CALL c5_20261023_01_guard_checkout_shape()',
    'SELECT 1');
PREPARE c5_stmt_checkout_shape_call FROM @c5_sql_checkout_shape_call;
EXECUTE c5_stmt_checkout_shape_call;
DEALLOCATE PREPARE c5_stmt_checkout_shape_call;

DROP PROCEDURE c5_20261023_01_guard_checkout_shape;

-- -----------------------------------------------------------------------------
-- Step 5: financial_settlement_obligations (R2 obligation/outbox).
-- -----------------------------------------------------------------------------
SET @c5_has_obligations = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.TABLES
    WHERE TABLE_SCHEMA = @c5_db AND TABLE_NAME = 'financial_settlement_obligations');

SET @c5_sql_obligations = IF(@c5_has_obligations = 0,
    "CREATE TABLE financial_settlement_obligations (
        id CHAR(36) COLLATE utf8mb4_0900_bin NOT NULL COMMENT 'Obligation identity minted by the settlement domain',
        tenant_id CHAR(36) NOT NULL,
        order_id VARCHAR(64) NOT NULL COMMENT 'Canonical checkout_orders.order_id of the same tenant; immutable',
        purpose VARCHAR(64) COLLATE utf8mb4_0900_bin NOT NULL COMMENT 'Canonical business purpose code, e.g. student_tuition',
        amount_minor BIGINT UNSIGNED NOT NULL COMMENT 'Verified gross amount in exact minor units; 0 < amount <= 10^15',
        currency CHAR(3) COLLATE utf8mb4_0900_bin NOT NULL COMMENT 'Uppercase ISO-4217 code',
        provider VARCHAR(64) NOT NULL COMMENT 'Verified provider identity (matches checkout_provider_events.provider)',
        provider_event_id VARCHAR(128) NOT NULL COMMENT 'Verified provider event identity (matches checkout_provider_events.provider_event_id)',
        payload_hash CHAR(64) COLLATE utf8mb4_0900_bin NOT NULL COMMENT 'Lowercase SHA-256 of the canonical obligation payload; replay vs conflict',
        status ENUM('pending','awaiting_allocation','completed') NOT NULL DEFAULT 'pending' COMMENT 'pending = recorded; awaiting_allocation = fee/net/tax not proved (unknown stays NULL); completed = journal posted',
        fee_minor BIGINT UNSIGNED NULL COMMENT 'Provider fee in exact minor units; NULL when not proved (never a zero substitute)',
        tax_minor BIGINT UNSIGNED NULL COMMENT 'Tax in exact minor units; NULL when not proved (never a zero substitute)',
        net_minor BIGINT UNSIGNED NULL COMMENT 'Proved net amount in exact minor units; NULL when not proved',
        journal_id CHAR(36) NULL COMMENT 'FIN3 billing_journals.id that posted the completed obligation',
        provider_receipt_reference VARCHAR(128) COLLATE utf8mb4_0900_bin NULL COMMENT 'Opaque provider receipt reference preserved for reconciliation',
        provider_settlement_reference VARCHAR(128) COLLATE utf8mb4_0900_bin NULL COMMENT 'Opaque provider settlement reference preserved for reconciliation',
        reconciliation_status ENUM('unreconciled','reconciled','discrepancy') NOT NULL DEFAULT 'unreconciled' COMMENT 'Reconciliation state preserved with the obligation',
        version BIGINT UNSIGNED NOT NULL DEFAULT 0 COMMENT 'CAS version; completion is a conditional write on version',
        created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
        updated_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
        PRIMARY KEY (id),
        UNIQUE KEY uq_settlement_obligation_id_tenant (id, tenant_id),
        UNIQUE KEY uq_settlement_obligation_payment (tenant_id, provider, provider_event_id),
        UNIQUE KEY uq_settlement_obligation_order (tenant_id, order_id, purpose),
        UNIQUE KEY uq_settlement_obligation_journal (journal_id),
        KEY idx_settlement_obligation_journal_tenant (journal_id, tenant_id),
        KEY idx_settlement_obligation_provider_event (provider, provider_event_id),
        KEY idx_settlement_obligation_status (tenant_id, status, created_at),
        CONSTRAINT fk_settlement_obligation_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id),
        CONSTRAINT fk_settlement_obligation_order FOREIGN KEY (tenant_id, order_id) REFERENCES checkout_orders (tenant_id, order_id),
        CONSTRAINT fk_settlement_obligation_provider_event FOREIGN KEY (provider, provider_event_id) REFERENCES checkout_provider_events (provider, provider_event_id),
        CONSTRAINT fk_settlement_obligation_journal FOREIGN KEY (journal_id, tenant_id) REFERENCES billing_journals (id, tenant_id),
        CONSTRAINT chk_settlement_obligation_amount CHECK (amount_minor > 0 AND amount_minor <= 1000000000000000),
        CONSTRAINT chk_settlement_obligation_net CHECK (net_minor IS NULL OR (net_minor > 0 AND net_minor <= amount_minor)),
        CONSTRAINT chk_settlement_obligation_status CHECK ((status = 'completed' AND journal_id IS NOT NULL AND net_minor IS NOT NULL) OR (status <> 'completed' AND journal_id IS NULL)),
        CONSTRAINT chk_settlement_obligation_hash CHECK (payload_hash REGEXP '^[0-9a-f]{64}$'),
        CONSTRAINT chk_settlement_obligation_version CHECK (version >= 0)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
      COMMENT 'Settlement obligations/outbox: verified payment, unknown fee/net/tax stays NULL, completed requires a journal'",
    'SELECT 1');
PREPARE c5_stmt_obligations FROM @c5_sql_obligations;
EXECUTE c5_stmt_obligations;
DEALLOCATE PREPARE c5_stmt_obligations;

-- -----------------------------------------------------------------------------
-- Step 6: checkout_order_idempotency_keys (R1/R4).
-- -----------------------------------------------------------------------------
SET @c5_has_checkout_idem = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.TABLES
    WHERE TABLE_SCHEMA = @c5_db AND TABLE_NAME = 'checkout_order_idempotency_keys');

SET @c5_sql_checkout_idem = IF(@c5_has_checkout_idem = 0,
    "CREATE TABLE checkout_order_idempotency_keys (
        tenant_id CHAR(36) NOT NULL,
        scope VARCHAR(64) COLLATE utf8mb4_0900_bin NOT NULL COMMENT 'Idempotency namespace; checkout creation uses payment.checkout.order_create (MAX_IDEMPOTENCY_SCOPE_LENGTH = 64)',
        idempotency_key VARCHAR(128) COLLATE utf8mb4_0900_bin NOT NULL COMMENT 'Canonical caller idempotency key (MAX_IDEMPOTENCY_KEY_LENGTH = 128)',
        payload_hash CHAR(64) COLLATE utf8mb4_0900_bin NOT NULL COMMENT 'Lowercase SHA-256 of the canonical financial payload; same key + other hash = conflict',
        order_id VARCHAR(64) NOT NULL COMMENT 'checkout_orders.order_id created by the first request under this key',
        created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
        PRIMARY KEY (tenant_id, scope, idempotency_key),
        KEY idx_checkout_idem_order (tenant_id, order_id),
        CONSTRAINT fk_checkout_idem_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id),
        CONSTRAINT fk_checkout_idem_order FOREIGN KEY (tenant_id, order_id) REFERENCES checkout_orders (tenant_id, order_id),
        CONSTRAINT chk_checkout_idem_hash CHECK (payload_hash REGEXP '^[0-9a-f]{64}$')
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
      COMMENT 'Checkout creation idempotency (R4): tenant + key + payload hash -> order; same key + other hash is a conflict'",
    'SELECT 1');
PREPARE c5_stmt_checkout_idem FROM @c5_sql_checkout_idem;
EXECUTE c5_stmt_checkout_idem;
DEALLOCATE PREPARE c5_stmt_checkout_idem;

-- -----------------------------------------------------------------------------
-- Step 6b: guarded additive UNIQUE (id, tenant_id, currency) on billing_invoices
--   This is the composite FK target for allocations (same-invoice currency)
--   and for the guarded difference-request link. It MUST exist before the
--   allocation CREATE below.
-- -----------------------------------------------------------------------------
SET @c5_invoice_currency_uq_exists = (SELECT COUNT(DISTINCT INDEX_NAME)
    FROM INFORMATION_SCHEMA.STATISTICS
    WHERE TABLE_SCHEMA = @c5_db AND TABLE_NAME = 'billing_invoices'
      AND INDEX_NAME = 'uq_billing_invoice_id_tenant_currency');

SET @c5_invoice_currency_uq_shape = (SELECT COUNT(*) FROM (
    SELECT INDEX_NAME
    FROM INFORMATION_SCHEMA.STATISTICS
    WHERE TABLE_SCHEMA = @c5_db AND TABLE_NAME = 'billing_invoices'
      AND INDEX_NAME = 'uq_billing_invoice_id_tenant_currency'
    GROUP BY INDEX_NAME
    HAVING COUNT(*) = 3
       AND MIN(NON_UNIQUE) = 0
       AND MAX(SUB_PART) IS NULL
       AND GROUP_CONCAT(COLUMN_NAME ORDER BY SEQ_IN_INDEX) = 'id,tenant_id,currency'
) AS c5_invoice_currency_uq_probe);

SET @c5_sql_invoice_currency_uq = IF(@c5_invoice_currency_uq_exists = 0,
    'ALTER TABLE billing_invoices ADD UNIQUE KEY uq_billing_invoice_id_tenant_currency (id, tenant_id, currency)',
    'SELECT 1');
PREPARE c5_stmt_invoice_currency_uq FROM @c5_sql_invoice_currency_uq;
EXECUTE c5_stmt_invoice_currency_uq;
DEALLOCATE PREPARE c5_stmt_invoice_currency_uq;

SET @c5_invoice_currency_uq_exists = (SELECT COUNT(DISTINCT INDEX_NAME)
    FROM INFORMATION_SCHEMA.STATISTICS
    WHERE TABLE_SCHEMA = @c5_db AND TABLE_NAME = 'billing_invoices'
      AND INDEX_NAME = 'uq_billing_invoice_id_tenant_currency');

SET @c5_invoice_currency_uq_shape = (SELECT COUNT(*) FROM (
    SELECT INDEX_NAME
    FROM INFORMATION_SCHEMA.STATISTICS
    WHERE TABLE_SCHEMA = @c5_db AND TABLE_NAME = 'billing_invoices'
      AND INDEX_NAME = 'uq_billing_invoice_id_tenant_currency'
    GROUP BY INDEX_NAME
    HAVING COUNT(*) = 3
       AND MIN(NON_UNIQUE) = 0
       AND MAX(SUB_PART) IS NULL
       AND GROUP_CONCAT(COLUMN_NAME ORDER BY SEQ_IN_INDEX) = 'id,tenant_id,currency'
) AS c5_invoice_currency_uq_probe);

-- -----------------------------------------------------------------------------
-- Step 7: billing_payment_allocations (R3).
-- -----------------------------------------------------------------------------
SET @c5_has_allocations = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.TABLES
    WHERE TABLE_SCHEMA = @c5_db AND TABLE_NAME = 'billing_payment_allocations');

SET @c5_sql_allocations = IF(@c5_has_allocations = 0,
    "CREATE TABLE billing_payment_allocations (
        allocation_id CHAR(36) COLLATE utf8mb4_0900_bin NOT NULL COMMENT 'Allocation identity minted by the billing domain',
        tenant_id CHAR(36) NOT NULL,
        invoice_id CHAR(36) NOT NULL COMMENT 'billing_invoices.id of the single outstanding-debt source',
        obligation_id CHAR(36) COLLATE utf8mb4_0900_bin NULL COMMENT 'financial_settlement_obligations.id funding this allocation; required for kind = payment',
        payment_reference VARCHAR(128) COLLATE utf8mb4_0900_bin NOT NULL COMMENT 'Exact payment/obligation reference; with invoice+kind prevents double allocation',
        amount_minor BIGINT UNSIGNED NOT NULL COMMENT 'Applied amount in exact minor units; 0 < amount <= 10^15',
        currency CHAR(3) NOT NULL COMMENT 'Must equal the invoice currency (composite FK proves it)',
        kind ENUM('payment','credit','reversal') NOT NULL COMMENT 'Debt-reduction kind; payment requires obligation_id',
        journal_id CHAR(36) NOT NULL COMMENT 'FIN3 journal that posted this allocation',
        created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
        PRIMARY KEY (allocation_id),
        UNIQUE KEY uq_billing_allocation_id_tenant (allocation_id, tenant_id),
        UNIQUE KEY uq_billing_allocation_payment_invoice (tenant_id, payment_reference, invoice_id, kind),
        KEY idx_billing_allocation_invoice (invoice_id, tenant_id, currency),
        KEY idx_billing_allocation_obligation (obligation_id, tenant_id),
        KEY idx_billing_allocation_journal (journal_id, tenant_id),
        CONSTRAINT fk_billing_allocation_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id),
        CONSTRAINT fk_billing_allocation_invoice FOREIGN KEY (invoice_id, tenant_id, currency) REFERENCES billing_invoices (id, tenant_id, currency),
        CONSTRAINT fk_billing_allocation_obligation FOREIGN KEY (obligation_id, tenant_id) REFERENCES financial_settlement_obligations (id, tenant_id),
        CONSTRAINT fk_billing_allocation_journal FOREIGN KEY (journal_id, tenant_id) REFERENCES billing_journals (id, tenant_id),
        CONSTRAINT chk_billing_allocation_amount CHECK (amount_minor > 0 AND amount_minor <= 1000000000000000),
        CONSTRAINT chk_billing_allocation_payment CHECK (kind <> 'payment' OR obligation_id IS NOT NULL)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
      COMMENT 'Invoice allocation ledger (R3): invoice is the single debt source, no stored outstanding, exact minor units'",
    'SELECT 1');
PREPARE c5_stmt_allocations FROM @c5_sql_allocations;
EXECUTE c5_stmt_allocations;
DEALLOCATE PREPARE c5_stmt_allocations;

-- -----------------------------------------------------------------------------
-- Step 8: billing_invoice_journals (R8 invoice issuance -> receivable journal).
-- -----------------------------------------------------------------------------
SET @c5_has_invoice_journals = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.TABLES
    WHERE TABLE_SCHEMA = @c5_db AND TABLE_NAME = 'billing_invoice_journals');

SET @c5_sql_invoice_journals = IF(@c5_has_invoice_journals = 0,
    "CREATE TABLE billing_invoice_journals (
        invoice_id CHAR(36) NOT NULL,
        tenant_id CHAR(36) NOT NULL,
        journal_id CHAR(36) NOT NULL COMMENT 'FIN3 journal that recorded the invoice receivable on issuance',
        created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
        PRIMARY KEY (invoice_id),
        UNIQUE KEY uq_billing_invoice_journal_invoice (invoice_id, tenant_id),
        UNIQUE KEY uq_billing_invoice_journal_journal (journal_id, tenant_id),
        CONSTRAINT fk_billing_invoice_journal_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id),
        CONSTRAINT fk_billing_invoice_journal_invoice FOREIGN KEY (invoice_id, tenant_id) REFERENCES billing_invoices (id, tenant_id),
        CONSTRAINT fk_billing_invoice_journal_journal FOREIGN KEY (journal_id, tenant_id) REFERENCES billing_journals (id, tenant_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
      COMMENT 'R8: one receivable journal per issued invoice; both invoice and journal are unique'",
    'SELECT 1');
PREPARE c5_stmt_invoice_journals FROM @c5_sql_invoice_journals;
EXECUTE c5_stmt_invoice_journals;
DEALLOCATE PREPARE c5_stmt_invoice_journals;

-- -----------------------------------------------------------------------------
-- Step 10: guarded additive difference-request link.
--   10a column, 10b index, 10c orphan/currency preflight, 10d FK, 10e guard.
-- -----------------------------------------------------------------------------
SET @c5_diff_invoice_ref_exists = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA = @c5_db AND TABLE_NAME = 'billing_difference_requests'
      AND COLUMN_NAME = 'invoice_ref_id');

SET @c5_sql_diff_invoice_ref = IF(@c5_diff_invoice_ref_exists = 0,
    "ALTER TABLE billing_difference_requests ADD COLUMN invoice_ref_id CHAR(36) NULL COMMENT 'Guarded link to billing_invoices.id; NULL = opaque legacy invoice_id only. Populated by the difference-request writer (contract request)'",
    'SELECT 1');
PREPARE c5_stmt_diff_invoice_ref FROM @c5_sql_diff_invoice_ref;
EXECUTE c5_stmt_diff_invoice_ref;
DEALLOCATE PREPARE c5_stmt_diff_invoice_ref;

SET @c5_diff_invoice_ref_exists = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA = @c5_db AND TABLE_NAME = 'billing_difference_requests'
      AND COLUMN_NAME = 'invoice_ref_id');

SET @c5_diff_invoice_ref_index_exists = (SELECT COUNT(DISTINCT INDEX_NAME)
    FROM INFORMATION_SCHEMA.STATISTICS
    WHERE TABLE_SCHEMA = @c5_db AND TABLE_NAME = 'billing_difference_requests'
      AND INDEX_NAME = 'idx_billing_diff_request_invoice_ref');

SET @c5_sql_diff_invoice_ref_index = IF(@c5_diff_invoice_ref_index_exists = 0,
    'ALTER TABLE billing_difference_requests ADD INDEX idx_billing_diff_request_invoice_ref (invoice_ref_id, tenant_id, currency)',
    'SELECT 1');
PREPARE c5_stmt_diff_invoice_ref_index FROM @c5_sql_diff_invoice_ref_index;
EXECUTE c5_stmt_diff_invoice_ref_index;
DEALLOCATE PREPARE c5_stmt_diff_invoice_ref_index;

SET @c5_diff_invoice_ref_index_shape = (SELECT COUNT(*) FROM (
    SELECT INDEX_NAME
    FROM INFORMATION_SCHEMA.STATISTICS
    WHERE TABLE_SCHEMA = @c5_db AND TABLE_NAME = 'billing_difference_requests'
      AND INDEX_NAME = 'idx_billing_diff_request_invoice_ref'
    GROUP BY INDEX_NAME
    HAVING COUNT(*) = 3
       AND MAX(SUB_PART) IS NULL
       AND GROUP_CONCAT(COLUMN_NAME ORDER BY SEQ_IN_INDEX) = 'invoice_ref_id,tenant_id,currency'
) AS c5_diff_invoice_ref_index_probe);

SET @c5_diff_invoice_orphans = (SELECT COUNT(*)
    FROM billing_difference_requests d
    LEFT JOIN billing_invoices i
      ON i.id = d.invoice_ref_id
     AND i.tenant_id = d.tenant_id
     AND i.currency = d.currency
    WHERE d.invoice_ref_id IS NOT NULL
      AND i.id IS NULL);

SET @c5_diff_invoice_fk_exists = (SELECT COUNT(DISTINCT CONSTRAINT_NAME)
    FROM INFORMATION_SCHEMA.TABLE_CONSTRAINTS
    WHERE CONSTRAINT_SCHEMA = @c5_db AND TABLE_NAME = 'billing_difference_requests'
      AND CONSTRAINT_TYPE = 'FOREIGN KEY'
      AND CONSTRAINT_NAME = 'fk_billing_diff_invoice_ref');

SET @c5_sql_diff_invoice_fk = IF(@c5_diff_invoice_fk_exists = 0 AND @c5_diff_invoice_orphans = 0,
    'ALTER TABLE billing_difference_requests ADD CONSTRAINT fk_billing_diff_invoice_ref FOREIGN KEY (invoice_ref_id, tenant_id, currency) REFERENCES billing_invoices (id, tenant_id, currency)',
    'SELECT 1');
PREPARE c5_stmt_diff_invoice_fk FROM @c5_sql_diff_invoice_fk;
EXECUTE c5_stmt_diff_invoice_fk;
DEALLOCATE PREPARE c5_stmt_diff_invoice_fk;

SET @c5_diff_invoice_fk_exists = (SELECT COUNT(DISTINCT CONSTRAINT_NAME)
    FROM INFORMATION_SCHEMA.TABLE_CONSTRAINTS
    WHERE CONSTRAINT_SCHEMA = @c5_db AND TABLE_NAME = 'billing_difference_requests'
      AND CONSTRAINT_TYPE = 'FOREIGN KEY'
      AND CONSTRAINT_NAME = 'fk_billing_diff_invoice_ref');

SET @c5_diff_invoice_fk_shape = (SELECT COUNT(*) FROM (
    SELECT CONSTRAINT_NAME
    FROM INFORMATION_SCHEMA.KEY_COLUMN_USAGE
    WHERE CONSTRAINT_SCHEMA = @c5_db AND TABLE_NAME = 'billing_difference_requests'
      AND CONSTRAINT_NAME = 'fk_billing_diff_invoice_ref'
    GROUP BY CONSTRAINT_NAME
    HAVING COUNT(*) = 3
       AND GROUP_CONCAT(COLUMN_NAME ORDER BY ORDINAL_POSITION) = 'invoice_ref_id,tenant_id,currency'
       AND MIN(REFERENCED_TABLE_NAME) = 'billing_invoices'
       AND MAX(REFERENCED_TABLE_NAME) = 'billing_invoices'
       AND GROUP_CONCAT(REFERENCED_COLUMN_NAME ORDER BY ORDINAL_POSITION) = 'id,tenant_id,currency'
) AS c5_diff_invoice_fk_probe);

SET @c5_diff_invoice_orphans = (SELECT COUNT(*)
    FROM billing_difference_requests d
    LEFT JOIN billing_invoices i
      ON i.id = d.invoice_ref_id
     AND i.tenant_id = d.tenant_id
     AND i.currency = d.currency
    WHERE d.invoice_ref_id IS NOT NULL
      AND i.id IS NULL);

SET @c5_invoice_link_drift = IF(@c5_invoice_currency_uq_exists = 1
    AND @c5_invoice_currency_uq_shape = 1
    AND @c5_diff_invoice_ref_exists = 1
    AND @c5_diff_invoice_ref_index_shape = 1
    AND @c5_diff_invoice_fk_exists = 1
    AND @c5_diff_invoice_fk_shape = 1
    AND @c5_diff_invoice_orphans = 0, 0, 1);

CREATE PROCEDURE c5_20261023_01_guard_invoice_link()
    COMMENT 'tabweb 20261023_01 guard helper (safe to drop)'
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'difference-request invoice link drift/orphans: DROP PROCEDURE c5_20261023_01_guard_invoice_link, fix invoice_ref_id rows, rerun';

SET @c5_sql_invoice_link_call = IF(@c5_invoice_link_drift = 1,
    'CALL c5_20261023_01_guard_invoice_link()',
    'SELECT 1');
PREPARE c5_stmt_invoice_link_call FROM @c5_sql_invoice_link_call;
EXECUTE c5_stmt_invoice_link_call;
DEALLOCATE PREPARE c5_stmt_invoice_link_call;

DROP PROCEDURE c5_20261023_01_guard_invoice_link;

-- -----------------------------------------------------------------------------
-- Step 11: independent drift guards for the four new tables (replay safety).
-- -----------------------------------------------------------------------------
-- financial_settlement_obligations -------------------------------------------
SET @c5_obligations_pk_ok = (SELECT COUNT(*) FROM (
    SELECT INDEX_NAME
    FROM INFORMATION_SCHEMA.STATISTICS
    WHERE TABLE_SCHEMA = @c5_db AND TABLE_NAME = 'financial_settlement_obligations'
      AND INDEX_NAME = 'PRIMARY'
    GROUP BY INDEX_NAME
    HAVING COUNT(*) = 1
       AND GROUP_CONCAT(COLUMN_NAME ORDER BY SEQ_IN_INDEX) = 'id'
) AS c5_obligations_pk_probe);

SET @c5_obligations_checks_ok = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.TABLE_CONSTRAINTS
    WHERE CONSTRAINT_SCHEMA = @c5_db AND TABLE_NAME = 'financial_settlement_obligations'
      AND CONSTRAINT_TYPE = 'CHECK'
      AND CONSTRAINT_NAME IN ('chk_settlement_obligation_amount',
          'chk_settlement_obligation_net','chk_settlement_obligation_status',
          'chk_settlement_obligation_hash','chk_settlement_obligation_version'));

SET @c5_obligations_fks_ok = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.TABLE_CONSTRAINTS
    WHERE CONSTRAINT_SCHEMA = @c5_db AND TABLE_NAME = 'financial_settlement_obligations'
      AND CONSTRAINT_TYPE = 'FOREIGN KEY'
      AND CONSTRAINT_NAME IN ('fk_settlement_obligation_tenant',
          'fk_settlement_obligation_order','fk_settlement_obligation_provider_event',
          'fk_settlement_obligation_journal'));

SET @c5_obligations_collation_ok = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA = @c5_db AND TABLE_NAME = 'financial_settlement_obligations'
      AND ((COLUMN_NAME IN ('id','purpose','currency','payload_hash',
              'provider_receipt_reference','provider_settlement_reference')
            AND COLLATION_NAME = 'utf8mb4_0900_bin')
        OR (COLUMN_NAME IN ('tenant_id','order_id','provider','provider_event_id','journal_id')
            AND COLLATION_NAME = 'utf8mb4_unicode_ci')));

SET @c5_obligations_uq_shapes_ok = (
    (SELECT COUNT(*) FROM (
        SELECT INDEX_NAME FROM INFORMATION_SCHEMA.STATISTICS
        WHERE TABLE_SCHEMA = @c5_db AND TABLE_NAME = 'financial_settlement_obligations'
          AND INDEX_NAME = 'uq_settlement_obligation_id_tenant'
        GROUP BY INDEX_NAME
        HAVING COUNT(*) = 2 AND MIN(NON_UNIQUE) = 0 AND MAX(SUB_PART) IS NULL
           AND GROUP_CONCAT(COLUMN_NAME ORDER BY SEQ_IN_INDEX) = 'id,tenant_id'
    ) AS c5_obligations_uq_id_probe)
  + (SELECT COUNT(*) FROM (
        SELECT INDEX_NAME FROM INFORMATION_SCHEMA.STATISTICS
        WHERE TABLE_SCHEMA = @c5_db AND TABLE_NAME = 'financial_settlement_obligations'
          AND INDEX_NAME = 'uq_settlement_obligation_payment'
        GROUP BY INDEX_NAME
        HAVING COUNT(*) = 3 AND MIN(NON_UNIQUE) = 0 AND MAX(SUB_PART) IS NULL
           AND GROUP_CONCAT(COLUMN_NAME ORDER BY SEQ_IN_INDEX) = 'tenant_id,provider,provider_event_id'
    ) AS c5_obligations_uq_payment_probe)
  + (SELECT COUNT(*) FROM (
        SELECT INDEX_NAME FROM INFORMATION_SCHEMA.STATISTICS
        WHERE TABLE_SCHEMA = @c5_db AND TABLE_NAME = 'financial_settlement_obligations'
          AND INDEX_NAME = 'uq_settlement_obligation_order'
        GROUP BY INDEX_NAME
        HAVING COUNT(*) = 3 AND MIN(NON_UNIQUE) = 0 AND MAX(SUB_PART) IS NULL
           AND GROUP_CONCAT(COLUMN_NAME ORDER BY SEQ_IN_INDEX) = 'tenant_id,order_id,purpose'
    ) AS c5_obligations_uq_order_probe)
  + (SELECT COUNT(*) FROM (
        SELECT INDEX_NAME FROM INFORMATION_SCHEMA.STATISTICS
        WHERE TABLE_SCHEMA = @c5_db AND TABLE_NAME = 'financial_settlement_obligations'
          AND INDEX_NAME = 'uq_settlement_obligation_journal'
        GROUP BY INDEX_NAME
        HAVING COUNT(*) = 1 AND MIN(NON_UNIQUE) = 0 AND MAX(SUB_PART) IS NULL
           AND GROUP_CONCAT(COLUMN_NAME ORDER BY SEQ_IN_INDEX) = 'journal_id'
    ) AS c5_obligations_uq_journal_probe)
);

SET @c5_obligations_drift = IF(@c5_obligations_pk_ok = 1
    AND @c5_obligations_uq_shapes_ok = 4
    AND @c5_obligations_checks_ok = 5
    AND @c5_obligations_fks_ok = 4
    AND @c5_obligations_collation_ok = 11, 0, 1);

CREATE PROCEDURE c5_20261023_01_guard_obligations_drift()
    COMMENT 'tabweb 20261023_01 guard helper (safe to drop)'
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'financial_settlement_obligations shape drift: DROP PROCEDURE c5_20261023_01_guard_obligations_drift, rerun';

SET @c5_sql_obligations_drift_call = IF(@c5_obligations_drift = 1,
    'CALL c5_20261023_01_guard_obligations_drift()',
    'SELECT 1');
PREPARE c5_stmt_obligations_drift_call FROM @c5_sql_obligations_drift_call;
EXECUTE c5_stmt_obligations_drift_call;
DEALLOCATE PREPARE c5_stmt_obligations_drift_call;

DROP PROCEDURE c5_20261023_01_guard_obligations_drift;

-- checkout_order_idempotency_keys --------------------------------------------
SET @c5_checkout_idem_pk_ok = (SELECT COUNT(*) FROM (
    SELECT INDEX_NAME
    FROM INFORMATION_SCHEMA.STATISTICS
    WHERE TABLE_SCHEMA = @c5_db AND TABLE_NAME = 'checkout_order_idempotency_keys'
      AND INDEX_NAME = 'PRIMARY'
    GROUP BY INDEX_NAME
    HAVING COUNT(*) = 3
       AND GROUP_CONCAT(COLUMN_NAME ORDER BY SEQ_IN_INDEX) = 'tenant_id,scope,idempotency_key'
) AS c5_checkout_idem_pk_probe);

SET @c5_checkout_idem_checks_ok = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.TABLE_CONSTRAINTS
    WHERE CONSTRAINT_SCHEMA = @c5_db AND TABLE_NAME = 'checkout_order_idempotency_keys'
      AND CONSTRAINT_TYPE = 'CHECK'
      AND CONSTRAINT_NAME IN ('chk_checkout_idem_hash'));

SET @c5_checkout_idem_fks_ok = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.TABLE_CONSTRAINTS
    WHERE CONSTRAINT_SCHEMA = @c5_db AND TABLE_NAME = 'checkout_order_idempotency_keys'
      AND CONSTRAINT_TYPE = 'FOREIGN KEY'
      AND CONSTRAINT_NAME IN ('fk_checkout_idem_tenant','fk_checkout_idem_order'));

SET @c5_checkout_idem_collation_ok = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA = @c5_db AND TABLE_NAME = 'checkout_order_idempotency_keys'
      AND ((COLUMN_NAME IN ('scope','idempotency_key','payload_hash')
            AND COLLATION_NAME = 'utf8mb4_0900_bin')
        OR (COLUMN_NAME IN ('tenant_id','order_id')
            AND COLLATION_NAME = 'utf8mb4_unicode_ci')));

SET @c5_checkout_idem_drift = IF(@c5_checkout_idem_pk_ok = 1
    AND @c5_checkout_idem_checks_ok = 1
    AND @c5_checkout_idem_fks_ok = 2
    AND @c5_checkout_idem_collation_ok = 5, 0, 1);

CREATE PROCEDURE c5_20261023_01_guard_checkout_idem_drift()
    COMMENT 'tabweb 20261023_01 guard helper (safe to drop)'
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'checkout_order_idempotency_keys shape drift: DROP PROCEDURE c5_20261023_01_guard_checkout_idem_drift, rerun';

SET @c5_sql_checkout_idem_drift_call = IF(@c5_checkout_idem_drift = 1,
    'CALL c5_20261023_01_guard_checkout_idem_drift()',
    'SELECT 1');
PREPARE c5_stmt_checkout_idem_drift_call FROM @c5_sql_checkout_idem_drift_call;
EXECUTE c5_stmt_checkout_idem_drift_call;
DEALLOCATE PREPARE c5_stmt_checkout_idem_drift_call;

DROP PROCEDURE c5_20261023_01_guard_checkout_idem_drift;

-- billing_payment_allocations -------------------------------------------------
SET @c5_allocations_pk_ok = (SELECT COUNT(*) FROM (
    SELECT INDEX_NAME
    FROM INFORMATION_SCHEMA.STATISTICS
    WHERE TABLE_SCHEMA = @c5_db AND TABLE_NAME = 'billing_payment_allocations'
      AND INDEX_NAME = 'PRIMARY'
    GROUP BY INDEX_NAME
    HAVING COUNT(*) = 1
       AND GROUP_CONCAT(COLUMN_NAME ORDER BY SEQ_IN_INDEX) = 'allocation_id'
) AS c5_allocations_pk_probe);

SET @c5_allocations_checks_ok = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.TABLE_CONSTRAINTS
    WHERE CONSTRAINT_SCHEMA = @c5_db AND TABLE_NAME = 'billing_payment_allocations'
      AND CONSTRAINT_TYPE = 'CHECK'
      AND CONSTRAINT_NAME IN ('chk_billing_allocation_amount',
          'chk_billing_allocation_payment'));

SET @c5_allocations_fks_ok = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.TABLE_CONSTRAINTS
    WHERE CONSTRAINT_SCHEMA = @c5_db AND TABLE_NAME = 'billing_payment_allocations'
      AND CONSTRAINT_TYPE = 'FOREIGN KEY'
      AND CONSTRAINT_NAME IN ('fk_billing_allocation_tenant',
          'fk_billing_allocation_invoice','fk_billing_allocation_obligation',
          'fk_billing_allocation_journal'));

SET @c5_allocations_collation_ok = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA = @c5_db AND TABLE_NAME = 'billing_payment_allocations'
      AND ((COLUMN_NAME IN ('allocation_id','obligation_id','payment_reference')
            AND COLLATION_NAME = 'utf8mb4_0900_bin')
        OR (COLUMN_NAME IN ('tenant_id','invoice_id','currency','journal_id')
            AND COLLATION_NAME = 'utf8mb4_unicode_ci')));

SET @c5_allocations_uq_shapes_ok = (
    (SELECT COUNT(*) FROM (
        SELECT INDEX_NAME FROM INFORMATION_SCHEMA.STATISTICS
        WHERE TABLE_SCHEMA = @c5_db AND TABLE_NAME = 'billing_payment_allocations'
          AND INDEX_NAME = 'uq_billing_allocation_id_tenant'
        GROUP BY INDEX_NAME
        HAVING COUNT(*) = 2 AND MIN(NON_UNIQUE) = 0 AND MAX(SUB_PART) IS NULL
           AND GROUP_CONCAT(COLUMN_NAME ORDER BY SEQ_IN_INDEX) = 'allocation_id,tenant_id'
    ) AS c5_allocations_uq_id_probe)
  + (SELECT COUNT(*) FROM (
        SELECT INDEX_NAME FROM INFORMATION_SCHEMA.STATISTICS
        WHERE TABLE_SCHEMA = @c5_db AND TABLE_NAME = 'billing_payment_allocations'
          AND INDEX_NAME = 'uq_billing_allocation_payment_invoice'
        GROUP BY INDEX_NAME
        HAVING COUNT(*) = 4 AND MIN(NON_UNIQUE) = 0 AND MAX(SUB_PART) IS NULL
           AND GROUP_CONCAT(COLUMN_NAME ORDER BY SEQ_IN_INDEX) = 'tenant_id,payment_reference,invoice_id,kind'
    ) AS c5_allocations_uq_payment_probe)
);

SET @c5_allocations_drift = IF(@c5_allocations_pk_ok = 1
    AND @c5_allocations_uq_shapes_ok = 2
    AND @c5_allocations_checks_ok = 2
    AND @c5_allocations_fks_ok = 4
    AND @c5_allocations_collation_ok = 7, 0, 1);

CREATE PROCEDURE c5_20261023_01_guard_allocations_drift()
    COMMENT 'tabweb 20261023_01 guard helper (safe to drop)'
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'billing_payment_allocations shape drift: DROP PROCEDURE c5_20261023_01_guard_allocations_drift, rerun';

SET @c5_sql_allocations_drift_call = IF(@c5_allocations_drift = 1,
    'CALL c5_20261023_01_guard_allocations_drift()',
    'SELECT 1');
PREPARE c5_stmt_allocations_drift_call FROM @c5_sql_allocations_drift_call;
EXECUTE c5_stmt_allocations_drift_call;
DEALLOCATE PREPARE c5_stmt_allocations_drift_call;

DROP PROCEDURE c5_20261023_01_guard_allocations_drift;

-- billing_invoice_journals ----------------------------------------------------
SET @c5_invoice_journals_pk_ok = (SELECT COUNT(*) FROM (
    SELECT INDEX_NAME
    FROM INFORMATION_SCHEMA.STATISTICS
    WHERE TABLE_SCHEMA = @c5_db AND TABLE_NAME = 'billing_invoice_journals'
      AND INDEX_NAME = 'PRIMARY'
    GROUP BY INDEX_NAME
    HAVING COUNT(*) = 1
       AND GROUP_CONCAT(COLUMN_NAME ORDER BY SEQ_IN_INDEX) = 'invoice_id'
) AS c5_invoice_journals_pk_probe);

SET @c5_invoice_journals_fks_ok = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.TABLE_CONSTRAINTS
    WHERE CONSTRAINT_SCHEMA = @c5_db AND TABLE_NAME = 'billing_invoice_journals'
      AND CONSTRAINT_TYPE = 'FOREIGN KEY'
      AND CONSTRAINT_NAME IN ('fk_billing_invoice_journal_tenant',
          'fk_billing_invoice_journal_invoice','fk_billing_invoice_journal_journal'));

SET @c5_invoice_journals_collation_ok = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA = @c5_db AND TABLE_NAME = 'billing_invoice_journals'
      AND COLUMN_NAME IN ('invoice_id','tenant_id','journal_id')
      AND COLLATION_NAME = 'utf8mb4_unicode_ci');

SET @c5_invoice_journals_uq_shapes_ok = (
    (SELECT COUNT(*) FROM (
        SELECT INDEX_NAME FROM INFORMATION_SCHEMA.STATISTICS
        WHERE TABLE_SCHEMA = @c5_db AND TABLE_NAME = 'billing_invoice_journals'
          AND INDEX_NAME = 'uq_billing_invoice_journal_invoice'
        GROUP BY INDEX_NAME
        HAVING COUNT(*) = 2 AND MIN(NON_UNIQUE) = 0 AND MAX(SUB_PART) IS NULL
           AND GROUP_CONCAT(COLUMN_NAME ORDER BY SEQ_IN_INDEX) = 'invoice_id,tenant_id'
    ) AS c5_invoice_journals_uq_invoice_probe)
  + (SELECT COUNT(*) FROM (
        SELECT INDEX_NAME FROM INFORMATION_SCHEMA.STATISTICS
        WHERE TABLE_SCHEMA = @c5_db AND TABLE_NAME = 'billing_invoice_journals'
          AND INDEX_NAME = 'uq_billing_invoice_journal_journal'
        GROUP BY INDEX_NAME
        HAVING COUNT(*) = 2 AND MIN(NON_UNIQUE) = 0 AND MAX(SUB_PART) IS NULL
           AND GROUP_CONCAT(COLUMN_NAME ORDER BY SEQ_IN_INDEX) = 'journal_id,tenant_id'
    ) AS c5_invoice_journals_uq_journal_probe)
);

SET @c5_invoice_journals_drift = IF(@c5_invoice_journals_pk_ok = 1
    AND @c5_invoice_journals_uq_shapes_ok = 2
    AND @c5_invoice_journals_fks_ok = 3
    AND @c5_invoice_journals_collation_ok = 3, 0, 1);

CREATE PROCEDURE c5_20261023_01_guard_invoice_journals_drift()
    COMMENT 'tabweb 20261023_01 guard helper (safe to drop)'
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'billing_invoice_journals shape drift: DROP PROCEDURE c5_20261023_01_guard_invoice_journals_drift, rerun';

SET @c5_sql_invoice_journals_drift_call = IF(@c5_invoice_journals_drift = 1,
    'CALL c5_20261023_01_guard_invoice_journals_drift()',
    'SELECT 1');
PREPARE c5_stmt_invoice_journals_drift_call FROM @c5_sql_invoice_journals_drift_call;
EXECUTE c5_stmt_invoice_journals_drift_call;
DEALLOCATE PREPARE c5_stmt_invoice_journals_drift_call;

DROP PROCEDURE c5_20261023_01_guard_invoice_journals_drift;

-- =============================================================================
-- End of 20261023_01 — source only; never executed by authoring.
-- =============================================================================
