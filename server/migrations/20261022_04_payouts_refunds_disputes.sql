-- =============================================================================
-- B3-C-SCHEMA (PATH-C) — payouts, refunds and dispute cases
-- Task:    path-C-schema
-- Date:    2026-10-22
-- Purpose: storage for the accepted domain contracts
--   `server/src/services/billing-payouts.ts`  (PAYOUT_STORE_SQL_CONTRACT)
--   `server/src/services/billing-refunds.ts`  (REFUND_STORE_SQL_CONTRACT and
--                                               DISPUTE_STORE_SQL_CONTRACT)
--   Contract: docs/contracts/B3-SCHEMA-CONTRACT-20261022.md
--
-- DESIGN (all money is EXACT integer minor units)
--   1. `payout_requests`: one row per (tenant, payout id). The contract
--      UNIQUE (tenant_id, payout_id) is the PRIMARY KEY, which is also the
--      exact natural key of the version CAS (`... WHERE tenant_id = ?
--      AND payout_id = ? AND version = ? AND status = ?`, incrementing
--      version by one). UNIQUE (tenant_id, idempotency_key) plus the stored
--      payload_hash implements HK1: same key + same hash replays, same key +
--      another hash is a typed conflict. Amount is BIGINT UNSIGNED minor
--      units bounded by the ledger MAX_AMOUNT_MINOR = 10^15; currency is
--      CHAR(3). `reservation_id` is the FIN3 reservation that backs the
--      payout (nullable before reservation) with a composite tenant FK to
--      `billing_reservations(id, tenant_id)`. `provider_reference` is
--      opaque and is only written after proof; it is never a PAN.
--   2. `payout_transitions`: append-only audit/state history. PK id,
--      UNIQUE (tenant_id, idempotency_key) plus payload_hash implements HK1
--      for the transition itself. Composite tenant FKs point at the request,
--      the FIN3 reservation and the FIN3 journal. It is never updated.
--   3. `refund_requests`: one row per (tenant, refund id). UNIQUE
--      (tenant_id, refund_id) is the PRIMARY KEY and the CAS key;
--      UNIQUE (tenant_id, idempotency_key) plus payload_hash implements HK1.
--      Both amount_minor and original_amount_minor are exact BIGINT minor
--      units; the CHECK original_amount_minor >= amount_minor mirrors the
--      domain remainder check. `funding_source_kind` is the closed enum
--      from REFUND_FUNDING_SOURCES ('merchant_available' only). The
--      original payment is an OPAQUE reference (no FK), because the domain
--      treats it as caller/provider identity and never requires it to be a
--      checkout row.
--   4. `refund_transitions`: append-only transition history, same HK1 and
--      tenant-composite shape as payout transitions.
--   5. `dispute_cases`: one row per (tenant, dispute id). UNIQUE
--      (tenant_id, dispute_id) is the PRIMARY KEY and the CAS key;
--      UNIQUE (tenant_id, idempotency_key) plus payload_hash implements HK1.
--      The financial consequence is HELD only (docs/19 lines 84 and 105
--      leave chargeback responsibility/reserve to a contract); the basis
--      text is stored verbatim. This table never moves money and has no
--      ledger foreign key.
--   6. `dispute_transitions`: append-only transition history for disputes.
--      `action` includes the domain's `open` plus every DISPUTE_STATUS
--      (the domain type is DisputeStatus | 'open'); from_status is nullable
--      because a first transition may have no prior status in the type.
--
-- APPEND-ONLY OBLIGATION (DDL limit, cannot be expressed here)
--   UPDATE/DELETE on `payout_transitions`, `refund_transitions` and
--   `dispute_transitions` MUST be denied by the application privilege
--   layer. The request/case tables mutate ONLY through their version CAS.
--   Deletes are denied everywhere. Enforcement is a live-deployment step.
--
-- OWNERSHIP / IDEMPOTENCY
--   Every table carries tenant_id with FK to the proven tenants(id) PK.
--   Composite FKs only target keys proven in this file or the FIN3 file:
--     payout_requests (tenant_id, payout_id) PRIMARY KEY
--     refund_requests (tenant_id, refund_id) PRIMARY KEY
--     dispute_cases  (tenant_id, dispute_id) PRIMARY KEY
--     billing_reservations (id, tenant_id) UNIQUE KEY
--     billing_journals     (id, tenant_id) UNIQUE KEY
--   Every statement is guarded by INFORMATION_SCHEMA probes +
--   PREPARE/EXECUTE so a re-run is a no-op. The idempotency UNIQUE keys are
--   additionally reconciled on the already-created path with an INDEPENDENT
--   structural probe (exact columns, order, uniqueness and no prefix
--   SUB_PART); a same-named index with any other shape is never accepted (the
--   guarded ADD then fails loudly with a duplicate-index-name error). No DROP,
--   no TRUNCATE, no DELETE/UPDATE of data, no FOREIGN_KEY_CHECKS manipulation,
--   no backfill.
--
-- PRE-EXISTING TABLE SHAPE (Step 6a, fail closed)
--   A table that ALREADY EXISTS is never trusted by name alone. Immediately
--   after the six CREATE guards (and before any idempotency ADD), structural
--   probes require, for each 04 table:
--     * PRIMARY KEY with the exact ordered columns declared below;
--     * every named CHECK constraint present (TABLE_CONSTRAINTS, by name);
--     * every named FOREIGN KEY constraint present (TABLE_CONSTRAINTS, by
--       name; referential targets are not re-verified here);
--     * the exact column COLLATION_NAME for every identity/hash/currency
--       column and every FK column (collation is a creation-time property and
--       cannot be repaired by an ALTER in this authoring-only file).
--   If any probe fails the migration aborts via a per-table literal stored
--   procedure whose one statement is SIGNAL (same design as migration 02).
--   HONEST LIMIT: the CHECK and FK probes are NAME-ONLY, so a pre-existing
--   constraint with the right name but a weaker/different definition is NOT
--   detected here. Only the PK/unique-index column shape, SUB_PART and the
--   column collations are checked structurally.
--
-- COLLATION
--   Identity/lookup columns and the hash/currency columns use
--   `utf8mb4_0900_bin` (binary, case-sensitive, NO PAD), so 'K'/'k' and
--   'k'/'k ' never collide in a unique key. The review note suggested
--   `utf8mb4_bin`; the legacy `utf8mb4_bin` is PAD SPACE and would still
--   collide on trailing spaces, so the NO PAD `utf8mb4_0900_bin` (MySQL 8.0)
--   is used deliberately. Columns that are FOREIGN KEYs to FIN3/tenant tables
--   keep the referenced column's `utf8mb4_unicode_ci` (verified in
--   `20260921_saas_foundation.sql:12` tenants, `20261021_02_internal_financial_
--   ledger.sql:86,120,201` and this file); changing those would break the FK.
--
-- PRIVILEGES FOR THE STRUCTURAL GUARDS
--   Step 6a uses six literal top-level CREATE PROCEDURE helpers (one per 04
--   table), each with a one-statement SIGNAL body and a name unique to this
--   migration. MySQL 8.0 does NOT allow CREATE/DROP PROCEDURE inside a
--   prepared statement, so the CREATE is literal and UNCONDITIONAL on EVERY
--   run (including clean runs): the connecting account therefore needs
--   CREATE ROUTINE and ALTER ROUTINE (for the literal DROP) in addition to
--   the DDL rights. These are PERSISTENT stored routines, not temporary
--   objects. There is NO `DROP PROCEDURE IF EXISTS` before the CREATE: error
--   1304 on an existing name is the fail-closed collision protection, so a
--   leftover helper from a previous drift failure blocks a rerun until the
--   operator drops that exact helper manually after reconciling the drift
--   (the SIGNAL message names it). On the non-drift path the literal DROP
--   after the dispatch can only remove this run's own freshly created helper.
--   No explicit DEFINER is written; the routine is created by the connecting
--   account (SQL SECURITY DEFINER default resolves to that account). Live
--   assumptions to verify: that account's SQL_MODE and, when binary logging
--   is enabled, log_bin_trust_function_creators.
--
-- PREREQUISITE
--   FIN3 (`20261021_02_internal_financial_ledger.sql`) must already be
--   applied: the reservation/journal composite FKs reference its proven
--   `(id, tenant_id)` unique keys. A missing FIN3 table makes the CREATE
--   fail closed rather than storing an unverifiable reference.
--
-- !! THIS FILE IS AUTHORING-ONLY SOURCE DDL. No statement here is executed,
--    no database is connected to. Manifest registration is Codex's.
-- =============================================================================

SET @c4_db = DATABASE();

-- -----------------------------------------------------------------------------
-- Step 1: payout_requests — one row per (tenant, payout id), version CAS.
-- -----------------------------------------------------------------------------
SET @c4_has_payout_requests = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.TABLES
    WHERE TABLE_SCHEMA = @c4_db AND TABLE_NAME = 'payout_requests');

SET @c4_sql_payout_requests = IF(@c4_has_payout_requests = 0,
    "CREATE TABLE payout_requests (
        tenant_id CHAR(36) NOT NULL,
        payout_id VARCHAR(64) COLLATE utf8mb4_0900_bin NOT NULL COMMENT 'Opaque caller payout identity (MAX_PAYOUT_ID_LENGTH = 64); unique per tenant and the natural CAS key',
        destination_ref VARCHAR(200) COLLATE utf8mb4_0900_bin NOT NULL COMMENT 'Opaque bounded destination authority reference; never a card/PAN (MAX_DESTINATION_LENGTH = 200)',
        amount_minor BIGINT UNSIGNED NOT NULL COMMENT 'Exact positive integer minor units, <= 1000000000000000 (MAX_PAYOUT_AMOUNT_MINOR = ledger MAX_AMOUNT_MINOR)',
        currency CHAR(3) COLLATE utf8mb4_0900_bin NOT NULL COMMENT 'Uppercase ISO-4217 code',
        status ENUM('requested','reserved','processing','confirmed','failed','cancelled') NOT NULL DEFAULT 'requested' COMMENT 'PayoutStatus; terminal states confirmed/failed/cancelled are immutable',
        reservation_id CHAR(36) NULL COMMENT 'FIN3 billing_reservations.id backing the payout; NULL before reservation',
        version INT UNSIGNED NOT NULL DEFAULT 1 COMMENT 'Safe-integer CAS version; every transition increments by exactly one',
        idempotency_key VARCHAR(128) COLLATE utf8mb4_0900_bin NOT NULL COMMENT 'HK1 key (MAX_IDEMPOTENCY_KEY_LENGTH = 128); unique per tenant',
        payload_hash CHAR(64) COLLATE utf8mb4_0900_bin NOT NULL COMMENT 'Lowercase SHA-256 of the canonical request payload; decides replay vs conflict',
        requested_by VARCHAR(128) NULL COMMENT 'Authenticated principal that requested the payout (MAX_ACTOR_LENGTH = 128)',
        provider_reference VARCHAR(128) COLLATE utf8mb4_0900_bin NULL COMMENT 'Opaque provider transfer reference, recorded only after proof (MAX_ACTOR_LENGTH = 128)',
        failure_reason VARCHAR(500) NULL COMMENT 'Reason recorded on failure (MAX_REASON_LENGTH = 500)',
        cancellation_reason VARCHAR(500) NULL COMMENT 'Reason recorded on cancellation (MAX_REASON_LENGTH = 500)',
        created_at DATETIME(3) NOT NULL COMMENT 'Domain ISO created instant; milliseconds kept, out of the TIMESTAMP 2038 range',
        updated_at DATETIME(3) NOT NULL COMMENT 'Domain ISO last-mutation instant supplied by the CAS; milliseconds kept',
        PRIMARY KEY (tenant_id, payout_id),
        UNIQUE KEY uq_payout_requests_idem (tenant_id, idempotency_key),
        KEY idx_payout_requests_status (tenant_id, status, created_at),
        KEY idx_payout_requests_reservation (reservation_id, tenant_id),
        CONSTRAINT fk_payout_requests_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id),
        CONSTRAINT fk_payout_requests_reservation FOREIGN KEY (reservation_id, tenant_id) REFERENCES billing_reservations (id, tenant_id),
        CONSTRAINT chk_payout_requests_amount CHECK (amount_minor > 0 AND amount_minor <= 1000000000000000),
        CONSTRAINT chk_payout_requests_version CHECK (version >= 1),
        CONSTRAINT chk_payout_requests_currency CHECK (currency REGEXP '^[A-Z]{3}$'),
        CONSTRAINT chk_payout_requests_payload_hash CHECK (payload_hash REGEXP '^[0-9a-f]{64}$')
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
      COMMENT 'B3 payout requests: HK1 on the request row, exact BIGINT minor units, CAS on (tenant, payout, version, status)'",
    'SELECT 1');
PREPARE c4_stmt_payout_requests FROM @c4_sql_payout_requests;
EXECUTE c4_stmt_payout_requests;
DEALLOCATE PREPARE c4_stmt_payout_requests;

-- -----------------------------------------------------------------------------
-- Step 2: payout_transitions — append-only payout state history (HK1).
-- -----------------------------------------------------------------------------
SET @c4_has_payout_transitions = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.TABLES
    WHERE TABLE_SCHEMA = @c4_db AND TABLE_NAME = 'payout_transitions');

SET @c4_sql_payout_transitions = IF(@c4_has_payout_transitions = 0,
    "CREATE TABLE payout_transitions (
        id CHAR(36) NOT NULL COMMENT 'Transition identity minted by the domain',
        tenant_id CHAR(36) NOT NULL,
        payout_id VARCHAR(64) COLLATE utf8mb4_0900_bin NOT NULL COMMENT 'Owning payout (MAX_PAYOUT_ID_LENGTH = 64)',
        action ENUM('request','reserve','process','confirm','fail','cancel') NOT NULL COMMENT 'PayoutAction applied by this transition',
        idempotency_key VARCHAR(128) COLLATE utf8mb4_0900_bin NOT NULL COMMENT 'HK1 key (MAX_IDEMPOTENCY_KEY_LENGTH = 128); unique per tenant',
        payload_hash CHAR(64) COLLATE utf8mb4_0900_bin NOT NULL COMMENT 'Lowercase SHA-256 of the canonical transition payload; decides replay vs conflict',
        from_status ENUM('requested','reserved','processing','confirmed','failed','cancelled') NOT NULL,
        to_status ENUM('requested','reserved','processing','confirmed','failed','cancelled') NOT NULL,
        version_after INT UNSIGNED NOT NULL COMMENT 'Request version after the CAS (safe integer)',
        reservation_id CHAR(36) NULL COMMENT 'FIN3 reservation referenced by this transition',
        journal_id CHAR(36) NULL COMMENT 'FIN3 journal posted by this transition, when applicable',
        actor_id VARCHAR(128) NULL COMMENT 'Authenticated principal that caused the transition (MAX_ACTOR_LENGTH = 128)',
        reason VARCHAR(500) NULL COMMENT 'Optional transition reason (MAX_REASON_LENGTH = 500)',
        created_at DATETIME(3) NOT NULL COMMENT 'Domain ISO transition instant; milliseconds kept',
        PRIMARY KEY (id),
        UNIQUE KEY uq_payout_transitions_idem (tenant_id, idempotency_key),
        KEY idx_payout_transitions_request (tenant_id, payout_id, created_at),
        KEY idx_payout_transitions_reservation (reservation_id, tenant_id),
        KEY idx_payout_transitions_journal (journal_id, tenant_id),
        CONSTRAINT fk_payout_transitions_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id),
        CONSTRAINT fk_payout_transitions_request FOREIGN KEY (tenant_id, payout_id) REFERENCES payout_requests (tenant_id, payout_id),
        CONSTRAINT fk_payout_transitions_reservation FOREIGN KEY (reservation_id, tenant_id) REFERENCES billing_reservations (id, tenant_id),
        CONSTRAINT fk_payout_transitions_journal FOREIGN KEY (journal_id, tenant_id) REFERENCES billing_journals (id, tenant_id),
        CONSTRAINT chk_payout_transitions_version CHECK (version_after >= 1),
        CONSTRAINT chk_payout_transitions_payload_hash CHECK (payload_hash REGEXP '^[0-9a-f]{64}$')
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
      COMMENT 'B3 append-only payout transitions; HK1 on (tenant, idempotency key), never updated'",
    'SELECT 1');
PREPARE c4_stmt_payout_transitions FROM @c4_sql_payout_transitions;
EXECUTE c4_stmt_payout_transitions;
DEALLOCATE PREPARE c4_stmt_payout_transitions;

-- -----------------------------------------------------------------------------
-- Step 3: refund_requests — one row per (tenant, refund id), version CAS.
-- -----------------------------------------------------------------------------
SET @c4_has_refund_requests = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.TABLES
    WHERE TABLE_SCHEMA = @c4_db AND TABLE_NAME = 'refund_requests');

SET @c4_sql_refund_requests = IF(@c4_has_refund_requests = 0,
    "CREATE TABLE refund_requests (
        tenant_id CHAR(36) NOT NULL,
        refund_id VARCHAR(64) COLLATE utf8mb4_0900_bin NOT NULL COMMENT 'Opaque refund identity (MAX_REFUND_ID_LENGTH = 64); unique per tenant and the natural CAS key',
        original_reference VARCHAR(128) COLLATE utf8mb4_0900_bin NOT NULL COMMENT 'Opaque original order/payment identity; never a card/PAN (MAX_ORIGINAL_REFERENCE_LENGTH = 128)',
        original_amount_minor BIGINT UNSIGNED NOT NULL COMMENT 'Full refundable amount of the original payment copied for exact remainder checks',
        amount_minor BIGINT UNSIGNED NOT NULL COMMENT 'Exact positive integer minor units, <= original_amount_minor (MAX_REFUND_AMOUNT_MINOR = 10^15)',
        currency CHAR(3) COLLATE utf8mb4_0900_bin NOT NULL COMMENT 'Uppercase ISO-4217 code; must match the original payment',
        funding_source_kind ENUM('merchant_available') NOT NULL COMMENT 'REFUND_FUNDING_SOURCES; the only settled funding source',
        status ENUM('requested','funded','processing','completed','failed','cancelled') NOT NULL DEFAULT 'requested' COMMENT 'RefundStatus; terminal states completed/failed/cancelled are immutable',
        reservation_id CHAR(36) NULL COMMENT 'FIN3 billing_reservations.id backing the refund; NULL before funding',
        version INT UNSIGNED NOT NULL DEFAULT 1 COMMENT 'Safe-integer CAS version; every transition increments by exactly one',
        idempotency_key VARCHAR(128) COLLATE utf8mb4_0900_bin NOT NULL COMMENT 'HK1 key (MAX_IDEMPOTENCY_KEY_LENGTH = 128); unique per tenant',
        payload_hash CHAR(64) COLLATE utf8mb4_0900_bin NOT NULL COMMENT 'Lowercase SHA-256 of the canonical request payload; decides replay vs conflict',
        requested_by VARCHAR(128) NULL COMMENT 'Authenticated principal that requested the refund (MAX_ACTOR_LENGTH = 128)',
        provider_reference VARCHAR(128) COLLATE utf8mb4_0900_bin NULL COMMENT 'Opaque provider refund reference, recorded only after proof (MAX_ACTOR_LENGTH = 128)',
        failure_reason VARCHAR(500) NULL COMMENT 'Reason recorded on failure (MAX_REASON_LENGTH = 500)',
        cancellation_reason VARCHAR(500) NULL COMMENT 'Reason recorded on cancellation (MAX_REASON_LENGTH = 500)',
        created_at DATETIME(3) NOT NULL COMMENT 'Domain ISO created instant; milliseconds kept, out of the TIMESTAMP 2038 range',
        updated_at DATETIME(3) NOT NULL COMMENT 'Domain ISO last-mutation instant supplied by the CAS; milliseconds kept',
        PRIMARY KEY (tenant_id, refund_id),
        UNIQUE KEY uq_refund_requests_idem (tenant_id, idempotency_key),
        KEY idx_refund_requests_original (tenant_id, original_reference, currency, status),
        KEY idx_refund_requests_status (tenant_id, status, created_at),
        KEY idx_refund_requests_reservation (reservation_id, tenant_id),
        CONSTRAINT fk_refund_requests_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id),
        CONSTRAINT fk_refund_requests_reservation FOREIGN KEY (reservation_id, tenant_id) REFERENCES billing_reservations (id, tenant_id),
        CONSTRAINT chk_refund_requests_amount CHECK (amount_minor > 0 AND amount_minor <= 1000000000000000),
        CONSTRAINT chk_refund_requests_original_amount CHECK (original_amount_minor > 0 AND original_amount_minor <= 1000000000000000),
        CONSTRAINT chk_refund_requests_remainder CHECK (amount_minor <= original_amount_minor),
        CONSTRAINT chk_refund_requests_version CHECK (version >= 1),
        CONSTRAINT chk_refund_requests_currency CHECK (currency REGEXP '^[A-Z]{3}$'),
        CONSTRAINT chk_refund_requests_payload_hash CHECK (payload_hash REGEXP '^[0-9a-f]{64}$')
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
      COMMENT 'B3 refund requests: HK1, exact BIGINT minor units bounded by the original payment, CAS on (tenant, refund, version, status)'",
    'SELECT 1');
PREPARE c4_stmt_refund_requests FROM @c4_sql_refund_requests;
EXECUTE c4_stmt_refund_requests;
DEALLOCATE PREPARE c4_stmt_refund_requests;

-- -----------------------------------------------------------------------------
-- Step 4: refund_transitions — append-only refund state history (HK1).
-- -----------------------------------------------------------------------------
SET @c4_has_refund_transitions = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.TABLES
    WHERE TABLE_SCHEMA = @c4_db AND TABLE_NAME = 'refund_transitions');

SET @c4_sql_refund_transitions = IF(@c4_has_refund_transitions = 0,
    "CREATE TABLE refund_transitions (
        id CHAR(36) NOT NULL COMMENT 'Transition identity minted by the domain',
        tenant_id CHAR(36) NOT NULL,
        refund_id VARCHAR(64) COLLATE utf8mb4_0900_bin NOT NULL COMMENT 'Owning refund (MAX_REFUND_ID_LENGTH = 64)',
        action ENUM('request','fund','process','complete','fail','cancel') NOT NULL COMMENT 'RefundAction applied by this transition',
        idempotency_key VARCHAR(128) COLLATE utf8mb4_0900_bin NOT NULL COMMENT 'HK1 key (MAX_IDEMPOTENCY_KEY_LENGTH = 128); unique per tenant',
        payload_hash CHAR(64) COLLATE utf8mb4_0900_bin NOT NULL COMMENT 'Lowercase SHA-256 of the canonical transition payload; decides replay vs conflict',
        from_status ENUM('requested','funded','processing','completed','failed','cancelled') NOT NULL,
        to_status ENUM('requested','funded','processing','completed','failed','cancelled') NOT NULL,
        version_after INT UNSIGNED NOT NULL COMMENT 'Request version after the CAS (safe integer)',
        reservation_id CHAR(36) NULL COMMENT 'FIN3 reservation referenced by this transition',
        journal_id CHAR(36) NULL COMMENT 'FIN3 journal posted by this transition, when applicable',
        actor_id VARCHAR(128) NULL COMMENT 'Authenticated principal that caused the transition (MAX_ACTOR_LENGTH = 128)',
        reason VARCHAR(500) NULL COMMENT 'Optional transition reason (MAX_REASON_LENGTH = 500)',
        created_at DATETIME(3) NOT NULL COMMENT 'Domain ISO transition instant; milliseconds kept',
        PRIMARY KEY (id),
        UNIQUE KEY uq_refund_transitions_idem (tenant_id, idempotency_key),
        KEY idx_refund_transitions_request (tenant_id, refund_id, created_at),
        KEY idx_refund_transitions_reservation (reservation_id, tenant_id),
        KEY idx_refund_transitions_journal (journal_id, tenant_id),
        CONSTRAINT fk_refund_transitions_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id),
        CONSTRAINT fk_refund_transitions_request FOREIGN KEY (tenant_id, refund_id) REFERENCES refund_requests (tenant_id, refund_id),
        CONSTRAINT fk_refund_transitions_reservation FOREIGN KEY (reservation_id, tenant_id) REFERENCES billing_reservations (id, tenant_id),
        CONSTRAINT fk_refund_transitions_journal FOREIGN KEY (journal_id, tenant_id) REFERENCES billing_journals (id, tenant_id),
        CONSTRAINT chk_refund_transitions_version CHECK (version_after >= 1),
        CONSTRAINT chk_refund_transitions_payload_hash CHECK (payload_hash REGEXP '^[0-9a-f]{64}$')
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
      COMMENT 'B3 append-only refund transitions; HK1 on (tenant, idempotency key), never updated'",
    'SELECT 1');
PREPARE c4_stmt_refund_transitions FROM @c4_sql_refund_transitions;
EXECUTE c4_stmt_refund_transitions;
DEALLOCATE PREPARE c4_stmt_refund_transitions;

-- -----------------------------------------------------------------------------
-- Step 5: dispute_cases — one row per (tenant, dispute id), consequence HELD.
-- -----------------------------------------------------------------------------
SET @c4_has_dispute_cases = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.TABLES
    WHERE TABLE_SCHEMA = @c4_db AND TABLE_NAME = 'dispute_cases');

SET @c4_sql_dispute_cases = IF(@c4_has_dispute_cases = 0,
    "CREATE TABLE dispute_cases (
        tenant_id CHAR(36) NOT NULL,
        dispute_id VARCHAR(64) COLLATE utf8mb4_0900_bin NOT NULL COMMENT 'Opaque dispute identity (MAX_DISPUTE_ID_LENGTH = 64); unique per tenant and the natural CAS key',
        reference VARCHAR(128) COLLATE utf8mb4_0900_bin NOT NULL COMMENT 'Opaque order/payment/provider reference; never a card/PAN (MAX_ORIGINAL_REFERENCE_LENGTH = 128)',
        amount_minor BIGINT UNSIGNED NOT NULL COMMENT 'Exact positive integer minor units, <= 1000000000000000 (ledger MAX_AMOUNT_MINOR)',
        currency CHAR(3) COLLATE utf8mb4_0900_bin NOT NULL COMMENT 'Uppercase ISO-4217 code',
        status ENUM('opened','evidence','won','lost','closed') NOT NULL DEFAULT 'opened' COMMENT 'DisputeStatus; won/lost/closed are terminal',
        version INT UNSIGNED NOT NULL DEFAULT 1 COMMENT 'Safe-integer CAS version; every transition increments by exactly one',
        idempotency_key VARCHAR(128) COLLATE utf8mb4_0900_bin NOT NULL COMMENT 'HK1 key (MAX_IDEMPOTENCY_KEY_LENGTH = 128); unique per tenant',
        payload_hash CHAR(64) COLLATE utf8mb4_0900_bin NOT NULL COMMENT 'Lowercase SHA-256 of the canonical case payload; decides replay vs conflict',
        opened_by VARCHAR(128) NULL COMMENT 'Authenticated principal that opened the case (MAX_ACTOR_LENGTH = 128)',
        financial_consequence ENUM('held') NOT NULL DEFAULT 'held' COMMENT 'Only HELD is settled; no chargeback reserve/debit is invented',
        financial_consequence_basis VARCHAR(500) NOT NULL COMMENT 'Verbatim basis for the HELD consequence (docs/19 lines 84 and 105)',
        created_at DATETIME(3) NOT NULL COMMENT 'Domain ISO created instant; milliseconds kept, out of the TIMESTAMP 2038 range',
        updated_at DATETIME(3) NOT NULL COMMENT 'Domain ISO last-mutation instant supplied by the CAS; milliseconds kept',
        PRIMARY KEY (tenant_id, dispute_id),
        UNIQUE KEY uq_dispute_cases_idem (tenant_id, idempotency_key),
        KEY idx_dispute_cases_status (tenant_id, status, created_at),
        KEY idx_dispute_cases_reference (tenant_id, reference),
        CONSTRAINT fk_dispute_cases_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id),
        CONSTRAINT chk_dispute_cases_amount CHECK (amount_minor > 0 AND amount_minor <= 1000000000000000),
        CONSTRAINT chk_dispute_cases_version CHECK (version >= 1),
        CONSTRAINT chk_dispute_cases_consequence CHECK (financial_consequence = 'held'),
        CONSTRAINT chk_dispute_cases_currency CHECK (currency REGEXP '^[A-Z]{3}$'),
        CONSTRAINT chk_dispute_cases_payload_hash CHECK (payload_hash REGEXP '^[0-9a-f]{64}$')
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
      COMMENT 'B3 dispute cases: case record only, financial consequence HELD, no ledger or balance write'",
    'SELECT 1');
PREPARE c4_stmt_dispute_cases FROM @c4_sql_dispute_cases;
EXECUTE c4_stmt_dispute_cases;
DEALLOCATE PREPARE c4_stmt_dispute_cases;

-- -----------------------------------------------------------------------------
-- Step 6: dispute_transitions — append-only dispute state history (HK1).
-- -----------------------------------------------------------------------------
SET @c4_has_dispute_transitions = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.TABLES
    WHERE TABLE_SCHEMA = @c4_db AND TABLE_NAME = 'dispute_transitions');

SET @c4_sql_dispute_transitions = IF(@c4_has_dispute_transitions = 0,
    "CREATE TABLE dispute_transitions (
        id CHAR(36) NOT NULL COMMENT 'Transition identity minted by the domain',
        tenant_id CHAR(36) NOT NULL,
        dispute_id VARCHAR(64) COLLATE utf8mb4_0900_bin NOT NULL COMMENT 'Owning dispute (MAX_DISPUTE_ID_LENGTH = 64)',
        action ENUM('open','opened','evidence','won','lost','closed') NOT NULL COMMENT 'DisputeStatus | open, exactly as the domain transition record types it',
        idempotency_key VARCHAR(128) COLLATE utf8mb4_0900_bin NOT NULL COMMENT 'HK1 key (MAX_IDEMPOTENCY_KEY_LENGTH = 128); unique per tenant',
        payload_hash CHAR(64) COLLATE utf8mb4_0900_bin NOT NULL COMMENT 'Lowercase SHA-256 of the canonical transition payload; decides replay vs conflict',
        from_status ENUM('opened','evidence','won','lost','closed') NULL COMMENT 'Prior status; NULL only for an opening transition',
        to_status ENUM('opened','evidence','won','lost','closed') NOT NULL,
        version_after INT UNSIGNED NOT NULL COMMENT 'Case version after the CAS (safe integer)',
        actor_id VARCHAR(128) NULL COMMENT 'Authenticated principal that caused the transition (MAX_ACTOR_LENGTH = 128)',
        reason VARCHAR(500) NULL COMMENT 'Optional transition reason (MAX_REASON_LENGTH = 500)',
        created_at DATETIME(3) NOT NULL COMMENT 'Domain ISO transition instant; milliseconds kept',
        PRIMARY KEY (id),
        UNIQUE KEY uq_dispute_transitions_idem (tenant_id, idempotency_key),
        KEY idx_dispute_transitions_case (tenant_id, dispute_id, created_at),
        CONSTRAINT fk_dispute_transitions_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id),
        CONSTRAINT fk_dispute_transitions_case FOREIGN KEY (tenant_id, dispute_id) REFERENCES dispute_cases (tenant_id, dispute_id),
        CONSTRAINT chk_dispute_transitions_version CHECK (version_after >= 1),
        CONSTRAINT chk_dispute_transitions_payload_hash CHECK (payload_hash REGEXP '^[0-9a-f]{64}$')
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
      COMMENT 'B3 append-only dispute transitions; HK1 on (tenant, idempotency key), never updated'",
    'SELECT 1');
PREPARE c4_stmt_dispute_transitions FROM @c4_sql_dispute_transitions;
EXECUTE c4_stmt_dispute_transitions;
DEALLOCATE PREPARE c4_stmt_dispute_transitions;

-- -----------------------------------------------------------------------------
-- Step 6a: structural drift guards for PRE-EXISTING 04 tables.
-- The CREATE probes above only test presence by name. Here the catalog is
-- re-read AFTER all six CREATEs and each table must prove:
--   * exact ordered PRIMARY KEY columns;
--   * every named CHECK constraint present;
--   * every named FK constraint present;
--   * exact COLLATION_NAME on identity/hash/currency and FK columns
--     (utf8mb4_0900_bin for identity/hash/currency, utf8mb4_unicode_ci for
--     columns that must match a referenced FIN3/tenant column).
-- CHECK/FK definitions themselves are NAME-ONLY (see the honest limit in the
-- header). A drift aborts the migration before any idempotency ALTER, using the
-- literal stored-procedure + prepared-CALL design of migration 02.
-- -----------------------------------------------------------------------------

-- payout_requests ------------------------------------------------------------
SET @c4_payout_requests_pk_ok = (SELECT COUNT(*) FROM (
    SELECT INDEX_NAME
    FROM INFORMATION_SCHEMA.STATISTICS
    WHERE TABLE_SCHEMA = @c4_db AND TABLE_NAME = 'payout_requests'
      AND INDEX_NAME = 'PRIMARY'
    GROUP BY INDEX_NAME
    HAVING COUNT(*) = 2
       AND GROUP_CONCAT(COLUMN_NAME ORDER BY SEQ_IN_INDEX) = 'tenant_id,payout_id'
) AS c4_payout_requests_pk_probe);

SET @c4_payout_requests_checks_ok = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.TABLE_CONSTRAINTS
    WHERE CONSTRAINT_SCHEMA = @c4_db AND TABLE_NAME = 'payout_requests'
      AND CONSTRAINT_TYPE = 'CHECK'
      AND CONSTRAINT_NAME IN ('chk_payout_requests_amount','chk_payout_requests_version',
          'chk_payout_requests_currency','chk_payout_requests_payload_hash'));

SET @c4_payout_requests_fks_ok = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.TABLE_CONSTRAINTS
    WHERE CONSTRAINT_SCHEMA = @c4_db AND TABLE_NAME = 'payout_requests'
      AND CONSTRAINT_TYPE = 'FOREIGN KEY'
      AND CONSTRAINT_NAME IN ('fk_payout_requests_tenant','fk_payout_requests_reservation'));

SET @c4_payout_requests_collation_ok = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA = @c4_db AND TABLE_NAME = 'payout_requests'
      AND ((COLUMN_NAME IN ('payout_id','idempotency_key','payload_hash','currency',
              'destination_ref','provider_reference')
            AND COLLATION_NAME = 'utf8mb4_0900_bin')
        OR (COLUMN_NAME IN ('tenant_id','reservation_id')
            AND COLLATION_NAME = 'utf8mb4_unicode_ci')));

SET @c4_payout_requests_drift = IF(@c4_payout_requests_pk_ok = 1
    AND @c4_payout_requests_checks_ok = 4
    AND @c4_payout_requests_fks_ok = 2
    AND @c4_payout_requests_collation_ok = 8, 0, 1);

CREATE PROCEDURE c4_20261022_04_guard_payout_requests_drift()
    COMMENT 'tabweb 20261022_04 guard helper (safe to drop)'
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'payout_requests shape drift: DROP PROCEDURE c4_20261022_04_guard_payout_requests_drift, rerun';

SET @c4_sql_payout_requests_drift_call = IF(@c4_payout_requests_drift = 1,
    'CALL c4_20261022_04_guard_payout_requests_drift()',
    'SELECT 1');
PREPARE c4_stmt_payout_requests_drift_call FROM @c4_sql_payout_requests_drift_call;
EXECUTE c4_stmt_payout_requests_drift_call;
DEALLOCATE PREPARE c4_stmt_payout_requests_drift_call;

DROP PROCEDURE c4_20261022_04_guard_payout_requests_drift;

-- payout_transitions ---------------------------------------------------------
SET @c4_payout_transitions_pk_ok = (SELECT COUNT(*) FROM (
    SELECT INDEX_NAME
    FROM INFORMATION_SCHEMA.STATISTICS
    WHERE TABLE_SCHEMA = @c4_db AND TABLE_NAME = 'payout_transitions'
      AND INDEX_NAME = 'PRIMARY'
    GROUP BY INDEX_NAME
    HAVING COUNT(*) = 1
       AND GROUP_CONCAT(COLUMN_NAME ORDER BY SEQ_IN_INDEX) = 'id'
) AS c4_payout_transitions_pk_probe);

SET @c4_payout_transitions_checks_ok = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.TABLE_CONSTRAINTS
    WHERE CONSTRAINT_SCHEMA = @c4_db AND TABLE_NAME = 'payout_transitions'
      AND CONSTRAINT_TYPE = 'CHECK'
      AND CONSTRAINT_NAME IN ('chk_payout_transitions_version','chk_payout_transitions_payload_hash'));

SET @c4_payout_transitions_fks_ok = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.TABLE_CONSTRAINTS
    WHERE CONSTRAINT_SCHEMA = @c4_db AND TABLE_NAME = 'payout_transitions'
      AND CONSTRAINT_TYPE = 'FOREIGN KEY'
      AND CONSTRAINT_NAME IN ('fk_payout_transitions_tenant','fk_payout_transitions_request',
          'fk_payout_transitions_reservation','fk_payout_transitions_journal'));

SET @c4_payout_transitions_collation_ok = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA = @c4_db AND TABLE_NAME = 'payout_transitions'
      AND ((COLUMN_NAME IN ('payout_id','idempotency_key','payload_hash')
            AND COLLATION_NAME = 'utf8mb4_0900_bin')
        OR (COLUMN_NAME IN ('tenant_id','reservation_id','journal_id')
            AND COLLATION_NAME = 'utf8mb4_unicode_ci')));

SET @c4_payout_transitions_drift = IF(@c4_payout_transitions_pk_ok = 1
    AND @c4_payout_transitions_checks_ok = 2
    AND @c4_payout_transitions_fks_ok = 4
    AND @c4_payout_transitions_collation_ok = 6, 0, 1);

CREATE PROCEDURE c4_20261022_04_guard_payout_transitions_drift()
    COMMENT 'tabweb 20261022_04 guard helper (safe to drop)'
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'payout_transitions shape drift: DROP PROCEDURE c4_20261022_04_guard_payout_transitions_drift, rerun';

SET @c4_sql_payout_transitions_drift_call = IF(@c4_payout_transitions_drift = 1,
    'CALL c4_20261022_04_guard_payout_transitions_drift()',
    'SELECT 1');
PREPARE c4_stmt_payout_transitions_drift_call FROM @c4_sql_payout_transitions_drift_call;
EXECUTE c4_stmt_payout_transitions_drift_call;
DEALLOCATE PREPARE c4_stmt_payout_transitions_drift_call;

DROP PROCEDURE c4_20261022_04_guard_payout_transitions_drift;

-- refund_requests ------------------------------------------------------------
SET @c4_refund_requests_pk_ok = (SELECT COUNT(*) FROM (
    SELECT INDEX_NAME
    FROM INFORMATION_SCHEMA.STATISTICS
    WHERE TABLE_SCHEMA = @c4_db AND TABLE_NAME = 'refund_requests'
      AND INDEX_NAME = 'PRIMARY'
    GROUP BY INDEX_NAME
    HAVING COUNT(*) = 2
       AND GROUP_CONCAT(COLUMN_NAME ORDER BY SEQ_IN_INDEX) = 'tenant_id,refund_id'
) AS c4_refund_requests_pk_probe);

SET @c4_refund_requests_checks_ok = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.TABLE_CONSTRAINTS
    WHERE CONSTRAINT_SCHEMA = @c4_db AND TABLE_NAME = 'refund_requests'
      AND CONSTRAINT_TYPE = 'CHECK'
      AND CONSTRAINT_NAME IN ('chk_refund_requests_amount','chk_refund_requests_original_amount',
          'chk_refund_requests_remainder','chk_refund_requests_version',
          'chk_refund_requests_currency','chk_refund_requests_payload_hash'));

SET @c4_refund_requests_fks_ok = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.TABLE_CONSTRAINTS
    WHERE CONSTRAINT_SCHEMA = @c4_db AND TABLE_NAME = 'refund_requests'
      AND CONSTRAINT_TYPE = 'FOREIGN KEY'
      AND CONSTRAINT_NAME IN ('fk_refund_requests_tenant','fk_refund_requests_reservation'));

SET @c4_refund_requests_collation_ok = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA = @c4_db AND TABLE_NAME = 'refund_requests'
      AND ((COLUMN_NAME IN ('refund_id','original_reference','currency','idempotency_key',
              'payload_hash','provider_reference')
            AND COLLATION_NAME = 'utf8mb4_0900_bin')
        OR (COLUMN_NAME IN ('tenant_id','reservation_id')
            AND COLLATION_NAME = 'utf8mb4_unicode_ci')));

SET @c4_refund_requests_drift = IF(@c4_refund_requests_pk_ok = 1
    AND @c4_refund_requests_checks_ok = 6
    AND @c4_refund_requests_fks_ok = 2
    AND @c4_refund_requests_collation_ok = 8, 0, 1);

CREATE PROCEDURE c4_20261022_04_guard_refund_requests_drift()
    COMMENT 'tabweb 20261022_04 guard helper (safe to drop)'
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'refund_requests shape drift: DROP PROCEDURE c4_20261022_04_guard_refund_requests_drift, rerun';

SET @c4_sql_refund_requests_drift_call = IF(@c4_refund_requests_drift = 1,
    'CALL c4_20261022_04_guard_refund_requests_drift()',
    'SELECT 1');
PREPARE c4_stmt_refund_requests_drift_call FROM @c4_sql_refund_requests_drift_call;
EXECUTE c4_stmt_refund_requests_drift_call;
DEALLOCATE PREPARE c4_stmt_refund_requests_drift_call;

DROP PROCEDURE c4_20261022_04_guard_refund_requests_drift;

-- refund_transitions ---------------------------------------------------------
SET @c4_refund_transitions_pk_ok = (SELECT COUNT(*) FROM (
    SELECT INDEX_NAME
    FROM INFORMATION_SCHEMA.STATISTICS
    WHERE TABLE_SCHEMA = @c4_db AND TABLE_NAME = 'refund_transitions'
      AND INDEX_NAME = 'PRIMARY'
    GROUP BY INDEX_NAME
    HAVING COUNT(*) = 1
       AND GROUP_CONCAT(COLUMN_NAME ORDER BY SEQ_IN_INDEX) = 'id'
) AS c4_refund_transitions_pk_probe);

SET @c4_refund_transitions_checks_ok = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.TABLE_CONSTRAINTS
    WHERE CONSTRAINT_SCHEMA = @c4_db AND TABLE_NAME = 'refund_transitions'
      AND CONSTRAINT_TYPE = 'CHECK'
      AND CONSTRAINT_NAME IN ('chk_refund_transitions_version','chk_refund_transitions_payload_hash'));

SET @c4_refund_transitions_fks_ok = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.TABLE_CONSTRAINTS
    WHERE CONSTRAINT_SCHEMA = @c4_db AND TABLE_NAME = 'refund_transitions'
      AND CONSTRAINT_TYPE = 'FOREIGN KEY'
      AND CONSTRAINT_NAME IN ('fk_refund_transitions_tenant','fk_refund_transitions_request',
          'fk_refund_transitions_reservation','fk_refund_transitions_journal'));

SET @c4_refund_transitions_collation_ok = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA = @c4_db AND TABLE_NAME = 'refund_transitions'
      AND ((COLUMN_NAME IN ('refund_id','idempotency_key','payload_hash')
            AND COLLATION_NAME = 'utf8mb4_0900_bin')
        OR (COLUMN_NAME IN ('tenant_id','reservation_id','journal_id')
            AND COLLATION_NAME = 'utf8mb4_unicode_ci')));

SET @c4_refund_transitions_drift = IF(@c4_refund_transitions_pk_ok = 1
    AND @c4_refund_transitions_checks_ok = 2
    AND @c4_refund_transitions_fks_ok = 4
    AND @c4_refund_transitions_collation_ok = 6, 0, 1);

CREATE PROCEDURE c4_20261022_04_guard_refund_transitions_drift()
    COMMENT 'tabweb 20261022_04 guard helper (safe to drop)'
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'refund_transitions shape drift: DROP PROCEDURE c4_20261022_04_guard_refund_transitions_drift, rerun';

SET @c4_sql_refund_transitions_drift_call = IF(@c4_refund_transitions_drift = 1,
    'CALL c4_20261022_04_guard_refund_transitions_drift()',
    'SELECT 1');
PREPARE c4_stmt_refund_transitions_drift_call FROM @c4_sql_refund_transitions_drift_call;
EXECUTE c4_stmt_refund_transitions_drift_call;
DEALLOCATE PREPARE c4_stmt_refund_transitions_drift_call;

DROP PROCEDURE c4_20261022_04_guard_refund_transitions_drift;

-- dispute_cases --------------------------------------------------------------
SET @c4_dispute_cases_pk_ok = (SELECT COUNT(*) FROM (
    SELECT INDEX_NAME
    FROM INFORMATION_SCHEMA.STATISTICS
    WHERE TABLE_SCHEMA = @c4_db AND TABLE_NAME = 'dispute_cases'
      AND INDEX_NAME = 'PRIMARY'
    GROUP BY INDEX_NAME
    HAVING COUNT(*) = 2
       AND GROUP_CONCAT(COLUMN_NAME ORDER BY SEQ_IN_INDEX) = 'tenant_id,dispute_id'
) AS c4_dispute_cases_pk_probe);

SET @c4_dispute_cases_checks_ok = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.TABLE_CONSTRAINTS
    WHERE CONSTRAINT_SCHEMA = @c4_db AND TABLE_NAME = 'dispute_cases'
      AND CONSTRAINT_TYPE = 'CHECK'
      AND CONSTRAINT_NAME IN ('chk_dispute_cases_amount','chk_dispute_cases_version',
          'chk_dispute_cases_consequence','chk_dispute_cases_currency',
          'chk_dispute_cases_payload_hash'));

SET @c4_dispute_cases_fks_ok = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.TABLE_CONSTRAINTS
    WHERE CONSTRAINT_SCHEMA = @c4_db AND TABLE_NAME = 'dispute_cases'
      AND CONSTRAINT_TYPE = 'FOREIGN KEY'
      AND CONSTRAINT_NAME IN ('fk_dispute_cases_tenant'));

SET @c4_dispute_cases_collation_ok = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA = @c4_db AND TABLE_NAME = 'dispute_cases'
      AND ((COLUMN_NAME IN ('dispute_id','reference','currency','idempotency_key','payload_hash')
            AND COLLATION_NAME = 'utf8mb4_0900_bin')
        OR (COLUMN_NAME IN ('tenant_id')
            AND COLLATION_NAME = 'utf8mb4_unicode_ci')));

SET @c4_dispute_cases_drift = IF(@c4_dispute_cases_pk_ok = 1
    AND @c4_dispute_cases_checks_ok = 5
    AND @c4_dispute_cases_fks_ok = 1
    AND @c4_dispute_cases_collation_ok = 6, 0, 1);

CREATE PROCEDURE c4_20261022_04_guard_dispute_cases_drift()
    COMMENT 'tabweb 20261022_04 guard helper (safe to drop)'
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'dispute_cases shape drift: DROP PROCEDURE c4_20261022_04_guard_dispute_cases_drift, rerun';

SET @c4_sql_dispute_cases_drift_call = IF(@c4_dispute_cases_drift = 1,
    'CALL c4_20261022_04_guard_dispute_cases_drift()',
    'SELECT 1');
PREPARE c4_stmt_dispute_cases_drift_call FROM @c4_sql_dispute_cases_drift_call;
EXECUTE c4_stmt_dispute_cases_drift_call;
DEALLOCATE PREPARE c4_stmt_dispute_cases_drift_call;

DROP PROCEDURE c4_20261022_04_guard_dispute_cases_drift;

-- dispute_transitions --------------------------------------------------------
SET @c4_dispute_transitions_pk_ok = (SELECT COUNT(*) FROM (
    SELECT INDEX_NAME
    FROM INFORMATION_SCHEMA.STATISTICS
    WHERE TABLE_SCHEMA = @c4_db AND TABLE_NAME = 'dispute_transitions'
      AND INDEX_NAME = 'PRIMARY'
    GROUP BY INDEX_NAME
    HAVING COUNT(*) = 1
       AND GROUP_CONCAT(COLUMN_NAME ORDER BY SEQ_IN_INDEX) = 'id'
) AS c4_dispute_transitions_pk_probe);

SET @c4_dispute_transitions_checks_ok = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.TABLE_CONSTRAINTS
    WHERE CONSTRAINT_SCHEMA = @c4_db AND TABLE_NAME = 'dispute_transitions'
      AND CONSTRAINT_TYPE = 'CHECK'
      AND CONSTRAINT_NAME IN ('chk_dispute_transitions_version','chk_dispute_transitions_payload_hash'));

SET @c4_dispute_transitions_fks_ok = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.TABLE_CONSTRAINTS
    WHERE CONSTRAINT_SCHEMA = @c4_db AND TABLE_NAME = 'dispute_transitions'
      AND CONSTRAINT_TYPE = 'FOREIGN KEY'
      AND CONSTRAINT_NAME IN ('fk_dispute_transitions_tenant','fk_dispute_transitions_case'));

SET @c4_dispute_transitions_collation_ok = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA = @c4_db AND TABLE_NAME = 'dispute_transitions'
      AND ((COLUMN_NAME IN ('dispute_id','idempotency_key','payload_hash')
            AND COLLATION_NAME = 'utf8mb4_0900_bin')
        OR (COLUMN_NAME IN ('tenant_id')
            AND COLLATION_NAME = 'utf8mb4_unicode_ci')));

SET @c4_dispute_transitions_drift = IF(@c4_dispute_transitions_pk_ok = 1
    AND @c4_dispute_transitions_checks_ok = 2
    AND @c4_dispute_transitions_fks_ok = 2
    AND @c4_dispute_transitions_collation_ok = 4, 0, 1);

CREATE PROCEDURE c4_20261022_04_guard_dispute_transitions_drift()
    COMMENT 'tabweb 20261022_04 guard helper (safe to drop)'
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'dispute_transitions shape drift: DROP PROCEDURE c4_20261022_04_guard_dispute_transitions_drift, rerun';

SET @c4_sql_dispute_transitions_drift_call = IF(@c4_dispute_transitions_drift = 1,
    'CALL c4_20261022_04_guard_dispute_transitions_drift()',
    'SELECT 1');
PREPARE c4_stmt_dispute_transitions_drift_call FROM @c4_sql_dispute_transitions_drift_call;
EXECUTE c4_stmt_dispute_transitions_drift_call;
DEALLOCATE PREPARE c4_stmt_dispute_transitions_drift_call;

DROP PROCEDURE c4_20261022_04_guard_dispute_transitions_drift;

-- -----------------------------------------------------------------------------
-- Step 7: idempotency unique keys on the ALREADY-CREATED path.
-- This step reconciles ONLY the idempotency UNIQUE key, not the whole table
-- shape: Step 6a above already probed the PK, named CHECK/FK presence and
-- column collations. Each guard re-reads the table AFTER the CREATE above,
-- then checks the exact index shape (column set, column order, uniqueness and
-- no prefix `SUB_PART`) independently of its name. A same-named index with
-- another shape leaves the guard at 0, so the ADD fails loudly instead of
-- accepting drift by name. No destructive dedup: existing duplicate keys make
-- the ADD fail and the live owner resolves the data; this file never deletes
-- rows. The two-step scope (Step 6a table shape, Step 7 idempotency key) is
-- weaker than migration 02's full CHECK-clause recognition and is documented
-- as such.
-- -----------------------------------------------------------------------------
SET @c4_has_payout_requests_after = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.TABLES
    WHERE TABLE_SCHEMA = @c4_db AND TABLE_NAME = 'payout_requests');

SET @c4_payout_requests_idem_shape = (SELECT COUNT(*) FROM (
    SELECT INDEX_NAME
    FROM INFORMATION_SCHEMA.STATISTICS
    WHERE TABLE_SCHEMA = @c4_db AND TABLE_NAME = 'payout_requests'
      AND INDEX_NAME = 'uq_payout_requests_idem'
    GROUP BY INDEX_NAME
    HAVING COUNT(*) = 2
       AND MIN(NON_UNIQUE) = 0
       AND MAX(SUB_PART) IS NULL
       AND GROUP_CONCAT(COLUMN_NAME ORDER BY SEQ_IN_INDEX) = 'tenant_id,idempotency_key'
) AS shape_probe);

SET @c4_sql_payout_requests_idem = IF(@c4_has_payout_requests_after = 1 AND @c4_payout_requests_idem_shape = 0,
    'ALTER TABLE payout_requests ADD UNIQUE KEY uq_payout_requests_idem (tenant_id, idempotency_key)',
    'SELECT 1');
PREPARE c4_stmt_payout_requests_idem FROM @c4_sql_payout_requests_idem;
EXECUTE c4_stmt_payout_requests_idem;
DEALLOCATE PREPARE c4_stmt_payout_requests_idem;

SET @c4_has_payout_transitions_after = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.TABLES
    WHERE TABLE_SCHEMA = @c4_db AND TABLE_NAME = 'payout_transitions');

SET @c4_payout_transitions_idem_shape = (SELECT COUNT(*) FROM (
    SELECT INDEX_NAME
    FROM INFORMATION_SCHEMA.STATISTICS
    WHERE TABLE_SCHEMA = @c4_db AND TABLE_NAME = 'payout_transitions'
      AND INDEX_NAME = 'uq_payout_transitions_idem'
    GROUP BY INDEX_NAME
    HAVING COUNT(*) = 2
       AND MIN(NON_UNIQUE) = 0
       AND MAX(SUB_PART) IS NULL
       AND GROUP_CONCAT(COLUMN_NAME ORDER BY SEQ_IN_INDEX) = 'tenant_id,idempotency_key'
) AS shape_probe);

SET @c4_sql_payout_transitions_idem = IF(@c4_has_payout_transitions_after = 1 AND @c4_payout_transitions_idem_shape = 0,
    'ALTER TABLE payout_transitions ADD UNIQUE KEY uq_payout_transitions_idem (tenant_id, idempotency_key)',
    'SELECT 1');
PREPARE c4_stmt_payout_transitions_idem FROM @c4_sql_payout_transitions_idem;
EXECUTE c4_stmt_payout_transitions_idem;
DEALLOCATE PREPARE c4_stmt_payout_transitions_idem;

SET @c4_has_refund_requests_after = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.TABLES
    WHERE TABLE_SCHEMA = @c4_db AND TABLE_NAME = 'refund_requests');

SET @c4_refund_requests_idem_shape = (SELECT COUNT(*) FROM (
    SELECT INDEX_NAME
    FROM INFORMATION_SCHEMA.STATISTICS
    WHERE TABLE_SCHEMA = @c4_db AND TABLE_NAME = 'refund_requests'
      AND INDEX_NAME = 'uq_refund_requests_idem'
    GROUP BY INDEX_NAME
    HAVING COUNT(*) = 2
       AND MIN(NON_UNIQUE) = 0
       AND MAX(SUB_PART) IS NULL
       AND GROUP_CONCAT(COLUMN_NAME ORDER BY SEQ_IN_INDEX) = 'tenant_id,idempotency_key'
) AS shape_probe);

SET @c4_sql_refund_requests_idem = IF(@c4_has_refund_requests_after = 1 AND @c4_refund_requests_idem_shape = 0,
    'ALTER TABLE refund_requests ADD UNIQUE KEY uq_refund_requests_idem (tenant_id, idempotency_key)',
    'SELECT 1');
PREPARE c4_stmt_refund_requests_idem FROM @c4_sql_refund_requests_idem;
EXECUTE c4_stmt_refund_requests_idem;
DEALLOCATE PREPARE c4_stmt_refund_requests_idem;

SET @c4_has_refund_transitions_after = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.TABLES
    WHERE TABLE_SCHEMA = @c4_db AND TABLE_NAME = 'refund_transitions');

SET @c4_refund_transitions_idem_shape = (SELECT COUNT(*) FROM (
    SELECT INDEX_NAME
    FROM INFORMATION_SCHEMA.STATISTICS
    WHERE TABLE_SCHEMA = @c4_db AND TABLE_NAME = 'refund_transitions'
      AND INDEX_NAME = 'uq_refund_transitions_idem'
    GROUP BY INDEX_NAME
    HAVING COUNT(*) = 2
       AND MIN(NON_UNIQUE) = 0
       AND MAX(SUB_PART) IS NULL
       AND GROUP_CONCAT(COLUMN_NAME ORDER BY SEQ_IN_INDEX) = 'tenant_id,idempotency_key'
) AS shape_probe);

SET @c4_sql_refund_transitions_idem = IF(@c4_has_refund_transitions_after = 1 AND @c4_refund_transitions_idem_shape = 0,
    'ALTER TABLE refund_transitions ADD UNIQUE KEY uq_refund_transitions_idem (tenant_id, idempotency_key)',
    'SELECT 1');
PREPARE c4_stmt_refund_transitions_idem FROM @c4_sql_refund_transitions_idem;
EXECUTE c4_stmt_refund_transitions_idem;
DEALLOCATE PREPARE c4_stmt_refund_transitions_idem;

SET @c4_has_dispute_cases_after = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.TABLES
    WHERE TABLE_SCHEMA = @c4_db AND TABLE_NAME = 'dispute_cases');

SET @c4_dispute_cases_idem_shape = (SELECT COUNT(*) FROM (
    SELECT INDEX_NAME
    FROM INFORMATION_SCHEMA.STATISTICS
    WHERE TABLE_SCHEMA = @c4_db AND TABLE_NAME = 'dispute_cases'
      AND INDEX_NAME = 'uq_dispute_cases_idem'
    GROUP BY INDEX_NAME
    HAVING COUNT(*) = 2
       AND MIN(NON_UNIQUE) = 0
       AND MAX(SUB_PART) IS NULL
       AND GROUP_CONCAT(COLUMN_NAME ORDER BY SEQ_IN_INDEX) = 'tenant_id,idempotency_key'
) AS shape_probe);

SET @c4_sql_dispute_cases_idem = IF(@c4_has_dispute_cases_after = 1 AND @c4_dispute_cases_idem_shape = 0,
    'ALTER TABLE dispute_cases ADD UNIQUE KEY uq_dispute_cases_idem (tenant_id, idempotency_key)',
    'SELECT 1');
PREPARE c4_stmt_dispute_cases_idem FROM @c4_sql_dispute_cases_idem;
EXECUTE c4_stmt_dispute_cases_idem;
DEALLOCATE PREPARE c4_stmt_dispute_cases_idem;

SET @c4_has_dispute_transitions_after = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.TABLES
    WHERE TABLE_SCHEMA = @c4_db AND TABLE_NAME = 'dispute_transitions');

SET @c4_dispute_transitions_idem_shape = (SELECT COUNT(*) FROM (
    SELECT INDEX_NAME
    FROM INFORMATION_SCHEMA.STATISTICS
    WHERE TABLE_SCHEMA = @c4_db AND TABLE_NAME = 'dispute_transitions'
      AND INDEX_NAME = 'uq_dispute_transitions_idem'
    GROUP BY INDEX_NAME
    HAVING COUNT(*) = 2
       AND MIN(NON_UNIQUE) = 0
       AND MAX(SUB_PART) IS NULL
       AND GROUP_CONCAT(COLUMN_NAME ORDER BY SEQ_IN_INDEX) = 'tenant_id,idempotency_key'
) AS shape_probe);

SET @c4_sql_dispute_transitions_idem = IF(@c4_has_dispute_transitions_after = 1 AND @c4_dispute_transitions_idem_shape = 0,
    'ALTER TABLE dispute_transitions ADD UNIQUE KEY uq_dispute_transitions_idem (tenant_id, idempotency_key)',
    'SELECT 1');
PREPARE c4_stmt_dispute_transitions_idem FROM @c4_sql_dispute_transitions_idem;
EXECUTE c4_stmt_dispute_transitions_idem;
DEALLOCATE PREPARE c4_stmt_dispute_transitions_idem;
