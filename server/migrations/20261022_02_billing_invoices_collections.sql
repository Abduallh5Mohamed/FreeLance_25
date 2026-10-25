-- =============================================================================
-- B3-C-SCHEMA (PATH-C1) — invoices, price/offer snapshots, difference requests
-- Task:    path-C1-schema
-- Date:    2026-10-22
-- Purpose: storage for the accepted domain contracts
--   `server/src/services/billing-invoices.ts`    (INVOICE_STORE_SQL_CONTRACT)
--   `server/src/services/billing-snapshots.ts`   (immutable snapshot containers)
--   `server/src/services/billing-collection.ts`  (CollectionStore /
--                                                  COLLECTION_STORE_SQL_CONTRACT)
--   Contract: docs/contracts/B3-SCHEMA-CONTRACT-20261022.md
--
-- DESIGN (all money is EXACT integer minor units — EGP minor unit = piaster)
--   1. `billing_price_version_snapshots`: frozen price-version snapshots.
--      The captured content (currency, minorUnitsPerMajor, teacher/center
--      schedules with tier definitions) is stored BY VALUE as canonical JSON
--      and hashed with SHA-256 (`content_hash`); a later price-version change
--      creates a NEW row and never updates a stored snapshot. No money
--      columns outside the captured JSON content; the JSON stores amounts as
--      decimal strings exactly as the domain serializes BigInt values.
--   2. `billing_offer_snapshots`: the offer snapshot container. docs/19 leaves
--      the arithmetic pricing effect of an offer HELD, so `pricing_effect` can
--      only ever be 'held_not_settled': this container records a validated,
--      bounded, re-hashable payload and no pricing field beyond that.
--   3. `billing_invoices`: issued invoices. UNIQUE (tenant_id, org_kind,
--      cycle_start) is the cycle key to never have two invoices for the same
--      organization/cycle. Issued rows are INSERT-ONLY (no updated_at): a
--      correction is a new document, never a rewrite. BigDecimal minor-unit
--      totals, CHAR(3) currency, SHA-256 payload hash, and the price/offer
--      snapshot refs are all copied from the immutable snapshot rows the
--      invoice was computed from.
--   4. `billing_invoice_lines`: child of the invoice, keyed by
--      (tenant_id, invoice_id, line_id) with a composite tenant FK into
--      billing_invoices(id, tenant_id). Rational numerators/denominators are
--      BIGINT (HK2: reads convert with BigInt(), never Number).
--   5. `billing_difference_requests`: subscription difference requests.
--      UNIQUE (tenant_id, request_key) + payload_hash is HK1 issuance
--      idempotency on the request table itself (contract primary clause;
--      registering a collection scope in billing_idempotency_keys is the
--      documented alternative and is NOT required). UNIQUE (tenant_id,
--      basis_key): ordinary requests carry a 64-char SHA-256 basis key,
--      authorized corrections carry SQL NULL (MySQL permits many NULLs). The
--      96-hour grace is computed ONCE at issue: fairness CHECKs enforce
--      deadline_at = issued_at + 345600 for ordinary rows; corrections carry
--      explicit caller-supplied instants and correction metadata, never a
--      basis key. UNIQUE (tenant_id, settled_payment_id) (NULLs allowed)
--      prevents one verified payment from settling two requests. Only
--      status/paid_at/settled_payment_id/version move after insert, via the
--      version CAS; deadline_at/issued_at/amount/currency/identity columns
--      are immutable.
--   6. `billing_idempotency_keys` EXTENSION (additive on the FROZEN FIN3
--      table, this is a NEW file not an edit of 20261021_02): invoice
--      issuance follows HK1 through the canonical registry — a guarded ADD
--      COLUMN invoice_id CHAR(36) NULL, a NON-UNIQUE index on the invoice
--      target, a composite FK into billing_invoices(id, tenant_id), and a
--      guarded CONSTRAINT EVOLUTION of the frozen exactly-one-target CHECK.
--      EVIDENCE for the non-unique target (server/src/services/
--      billing-invoices.ts:791-805 and :817-834): when an identical invoice
--      already exists for the same (tenant, org, cycle), issueInvoice still
--      INSERTS an idempotency registry row for the newly supplied request
--      key that points at the SAME invoiceId. Several request-key ALIASES
--      therefore legitimately reference one canonical invoice, so a UNIQUE
--      (invoice_id) would reject valid aliases. The registry row remains
--      unique by PK (tenant_id, scope, idempotency_key); the invoice itself
--      remains unique by uq_billing_invoice_cycle (tenant, org, cycle).
--      The replacement index is reconciled by EXISTENCE (COUNT(DISTINCT
--      INDEX_NAME)) plus an INDEPENDENT structural probe: it must be
--      NON_UNIQUE=1 with columns exactly invoice_id (SEQ_IN_INDEX 1) then
--      tenant_id (SEQ_IN_INDEX 2). A same-named index with any other
--      shape/uniqueness is never accepted and aborts the migration via a
--      guarded SIGNAL. On a partially upgraded catalog where the legacy
--      unique uq_billing_idem_invoice coexists with the new index, ONLY the
--      old unique is dropped, and only after the new index is verified; the
--      new index is added BEFORE the old unique is dropped so the
--      (invoice_id, tenant_id) FK always has a supporting index.
--      The frozen CHECK chk_billing_idem_target (journal XOR reservation) is
--      REPLACED in ONE ALTER by the superset invariant 'exactly one of
--      journal_id / reservation_id / invoice_id' on the clean path, so every
--      row that satisfied the old check (invoice_id NULL, exactly one old
--      target) still satisfies the new one. A CHECK that only constrains
--      invoice rows is added as before; it is implied by the target check and
--      remains consistent with it. A PRE-EXISTING replacement found by name
--      is accepted ONLY when its normalized CHECK_CLAUSE equals one of the
--      small explicit EXACT renderings documented in Step 7 (parentheses are
--      NEVER stripped, because stripping them cannot tell the canonical
--      grouping from a weak one); anything else is left in place (and the old
--      CHECK is retained) with a guarded SIGNAL that fails the migration
--      closed. When THIS file adds the replacement itself (atomic DROP+ADD, or
--      ADD when neither exists) its own output is authoritative and is not
--      re-recognised.
--
-- NOT IN THIS SCHEMA (held, do not invent): partial/over payment allocation,
--   payout/refund/dispute tables (their domain does not exist yet), provider
--   codes, tax/fees. The legacy `instructor_wallets` / service-credit tables
--   are NOT reinterpreted as merchant money: no backfill, no mapping.
--
-- APPEND-ONLY OBLIGATION (DDL limit, cannot be expressed here)
--   UPDATE/DELETE on `billing_price_version_snapshots`,
--   `billing_offer_snapshots`, `billing_invoices`, `billing_invoice_lines`
--   MUST be denied by the application privilege layer; only
--   `billing_difference_requests` mutates through the CAS contract. Deletes
--   are denied everywhere. Enforcement is a live-deployment step.
--
-- OWNERSHIP / IDEMPOTENCY
--   Every table carries tenant_id with FK to the proven tenants(id) PK.
--   Composite FKs only target keys proven inside THIS file or the FIN3 file
--   (billing_(id, tenant_id) UNIQUE keys). Every statement is guarded by
--   INFORMATION_SCHEMA probes + PREPARE/EXECUTE (idempotent re-runs); any
--   guard depending on a column added earlier in this file probes the
--   catalog AGAIN after that ADD (`*_after` variables). The only DROPs are
--   guarded and only target objects this migration replaces or creates (the
--   legacy index/CHECK and the throwaway SIGNAL procedures); no data object is
--   dropped, no TRUNCATE, no DELETE/UPDATE of data, no FOREIGN_KEY_CHECKS
--   manipulation.
--   No data backfill: the FK on snapshot refs means an adapter MUST persist
--   the referenced snapshot rows in the issuing transaction (they carry the
--   full snapshot objects anyway; interpretation recorded in the contract).
--
-- PRIVILEGES / RUNNER SUPPORT (fail-closed guards)
--   SIGNAL, RESIGNAL and GET DIAGNOSTICS are NOT preparable in MySQL, and
--   MySQL 8.0 ALSO rejects CREATE PROCEDURE / DROP PROCEDURE inside a prepared
--   statement (only CALL among routine statements is preparable). The two
--   fail-closed guards therefore use a LITERAL top-level CREATE PROCEDURE with
--   a unique migration-specific name:
--     c2_20261022_02_guard_idx_fail    (invoice-target index shape guard)
--     c2_20261022_02_guard_target_fail (target CHECK guard)
--   Both carry the marker characteristic
--   COMMENT 'tabweb 20261022_02 guard helper (safe to drop)'. The body is ONE
--   `SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = '...'` statement: no BEGIN/END,
--   no internal separator and no DELIMITER, so a runner that splits statements
--   on semicolons still works. Only the dispatch is prepared
--   (`PREPARE ... FROM @sql; EXECUTE; DEALLOCATE PREPARE`), which MySQL
--   supports for CALL.
--   The CREATE is literal and UNCONDITIONAL, so EVERY run -- including a clean
--   run that never dispatches the CALL -- needs CREATE ROUTINE and the DROP
--   privilege (ALTER ROUTINE) in addition to the DDL rights. No explicit
--   DEFINER is written: the routine is created by the connecting account and
--   SQL SECURITY DEFINER (the default) resolves to that account. Environment
--   assumptions to verify live: that account's SQL_MODE/defaults and, when
--   binary logging is enabled, log_bin_trust_function_creators for stored
--   routines.
--   COLLISION PROTECTION: there is deliberately NO `DROP PROCEDURE IF EXISTS`
--   before the CREATE. A literal CREATE fails with MySQL error 1304 if any
--   routine of that name already exists, so nothing is ever overwritten. A
--   leftover helper of OUR marker from a previous drift failure also blocks a
--   rerun until the operator drops that exact helper manually after
--   reconciling the drift; the helper name is stated in its SIGNAL message.
--   CLEANUP: on the non-drift path a literal `DROP PROCEDURE <helper>` runs
--   immediately after the dispatch. It is safe because that point is reachable
--   only when this run's CREATE of that exact name succeeded, so it can only
--   drop our own helper. After a drift failure the CALL aborts the script and
--   the helper remains BY DESIGN; manual cleanup after reconciling is:
--     DROP PROCEDURE c2_20261022_02_guard_idx_fail;
--     DROP PROCEDURE c2_20261022_02_guard_target_fail;
--   See the CL report for the live-privilege assumptions.
--
-- !! THIS FILE IS AUTHORING-ONLY SOURCE DDL. No statement here is executed,
--    no database is connected to. Manifest registration is Codex's.
-- =============================================================================

SET @c2_db = DATABASE();

-- -----------------------------------------------------------------------------
-- Step 1: billing_price_version_snapshots — immutable captured price versions.
-- -----------------------------------------------------------------------------
SET @c2_has_price_snapshots = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.TABLES
    WHERE TABLE_SCHEMA = @c2_db AND TABLE_NAME = 'billing_price_version_snapshots');

SET @c2_sql_price_snapshots = IF(@c2_has_price_snapshots = 0,
    "CREATE TABLE billing_price_version_snapshots (
        tenant_id CHAR(36) NOT NULL,
        snapshot_id VARCHAR(128) NOT NULL COMMENT 'PriceVersionSnapshot.id (MAX_SNAPSHOT_ID_LENGTH = 128)',
        model_version INT NOT NULL COMMENT 'SNAPSHOT_MODEL_VERSION at capture time',
        version_label VARCHAR(128) NOT NULL COMMENT 'Price version label (MAX_VERSION_LABEL_LENGTH = 128)',
        effective_from BIGINT UNSIGNED NOT NULL COMMENT 'Non-negative safe integer UTC epoch second',
        content_hash CHAR(64) NOT NULL COMMENT 'Lowercase SHA-256 of the canonical captured content',
        content JSON NOT NULL COMMENT 'Frozen captured content; BIGINT amounts serialized as decimal strings exactly as the domain writes them',
        created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
        PRIMARY KEY (tenant_id, snapshot_id),
        KEY idx_price_snapshots_version (tenant_id, version_label),
        CONSTRAINT fk_price_snapshot_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
      COMMENT 'B3 immutable price-version snapshots; capture by value, never overwritten'",
    'SELECT 1');
PREPARE c2_stmt_price_snapshots FROM @c2_sql_price_snapshots;
EXECUTE c2_stmt_price_snapshots;
DEALLOCATE PREPARE c2_stmt_price_snapshots;

-- -----------------------------------------------------------------------------
-- Step 2: billing_offer_snapshots — immutable offer container, effect HELD.
-- -----------------------------------------------------------------------------
SET @c2_has_offer_snapshots = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.TABLES
    WHERE TABLE_SCHEMA = @c2_db AND TABLE_NAME = 'billing_offer_snapshots');

SET @c2_sql_offer_snapshots = IF(@c2_has_offer_snapshots = 0,
    "CREATE TABLE billing_offer_snapshots (
        tenant_id CHAR(36) NOT NULL,
        snapshot_id VARCHAR(128) NOT NULL COMMENT 'OfferSnapshot.id (MAX_SNAPSHOT_ID_LENGTH = 128)',
        model_version INT NOT NULL,
        version_label VARCHAR(128) NULL COMMENT 'Nullable offer version label',
        effective_from BIGINT UNSIGNED NOT NULL COMMENT 'Non-negative safe integer UTC epoch second',
        effective_until BIGINT UNSIGNED NULL COMMENT 'Non-negative; >= effective_from when present',
        payload JSON NOT NULL COMMENT 'Validated bounded offer payload (MAX_OFFER_PAYLOAD_LENGTH = 8192 chars); re-hashable',
        payload_hash CHAR(64) NOT NULL COMMENT 'Lowercase SHA-256 of the payload; decides integrity',
        pricing_effect ENUM('held_not_settled') NOT NULL DEFAULT 'held_not_settled' COMMENT 'docs/19 leaves the offer pricing effect HELD; this column can never carry a settled pricing rule',
        created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
        PRIMARY KEY (tenant_id, snapshot_id),
        KEY idx_offer_snapshots_window (tenant_id, effective_from),
        CONSTRAINT fk_offer_snapshot_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id),
        CONSTRAINT chk_offer_snapshot_window CHECK (effective_until IS NULL OR effective_until >= effective_from)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
      COMMENT 'B3 immutable offer snapshots; payload recorded, pricing effect stays held_not_settled'",
    'SELECT 1');
PREPARE c2_stmt_offer_snapshots FROM @c2_sql_offer_snapshots;
EXECUTE c2_stmt_offer_snapshots;
DEALLOCATE PREPARE c2_stmt_offer_snapshots;

-- -----------------------------------------------------------------------------
-- Step 3: billing_invoices — one issued invoice per (tenant, org kind, cycle).
-- INSERT-ONLY: no updated_at; corrections are new documents.
-- -----------------------------------------------------------------------------
SET @c2_has_invoices = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.TABLES
    WHERE TABLE_SCHEMA = @c2_db AND TABLE_NAME = 'billing_invoices');

SET @c2_sql_invoices = IF(@c2_has_invoices = 0,
    "CREATE TABLE billing_invoices (
        id CHAR(36) NOT NULL COMMENT 'inv_<32 hex> = exactly 36 chars, generated by the domain',
        tenant_id CHAR(36) NOT NULL,
        org_kind ENUM('teacher','center') NOT NULL,
        billing_phase ENUM('first','recurring') NOT NULL,
        cycle_start BIGINT UNSIGNED NOT NULL COMMENT 'Inclusive UTC epoch second of the cycle start; the window is exactly start..start+2592000',
        total_minor BIGINT NOT NULL COMMENT 'Exact integer minor units, >= 0; HALF_UP applied once upstream at the end',
        minor_units_per_major BIGINT UNSIGNED NOT NULL COMMENT 'Positive minor units per major currency unit',
        currency CHAR(3) NOT NULL COMMENT 'Uppercase ISO-4217 code',
        invoice_number VARCHAR(128) NOT NULL COMMENT 'INV-<org>-<yyyymmdd>-<8 hex> format minted by the domain',
        model_version INT NOT NULL COMMENT 'INVOICE_MODEL_VERSION at issuance',
        payload_hash CHAR(64) NOT NULL COMMENT 'Lowercase SHA-256 of the canonical invoice payload',
        price_snapshot_id VARCHAR(128) NOT NULL COMMENT 'PriceVersionSnapshot.id used for this invoice',
        price_version_id VARCHAR(128) NOT NULL COMMENT 'Snapshot price version label',
        price_content_hash CHAR(64) NOT NULL COMMENT 'Snapshot SHA-256 content hash at issuance',
        offer_snapshot_id VARCHAR(128) NULL COMMENT 'OfferSnapshot.id, or NULL when no offer was issued',
        offer_version_label VARCHAR(128) NULL,
        offer_payload_hash CHAR(64) NULL,
        offer_effective_from BIGINT UNSIGNED NULL,
        offer_pricing_effect ENUM('held_not_settled') NULL COMMENT 'Only invoices WITH an offer snapshot carry the held effect marker',
        created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
        PRIMARY KEY (id),
        UNIQUE KEY uq_billing_invoice_id_tenant (id, tenant_id),
        UNIQUE KEY uq_billing_invoice_cycle (tenant_id, org_kind, cycle_start),
        UNIQUE KEY uq_billing_invoice_number (tenant_id, invoice_number),
        KEY idx_billing_invoice_tenant_cycles (tenant_id, cycle_start, id),
        CONSTRAINT fk_billing_invoice_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id),
        CONSTRAINT fk_billing_invoice_price_snapshot FOREIGN KEY (tenant_id, price_snapshot_id) REFERENCES billing_price_version_snapshots (tenant_id, snapshot_id),
        CONSTRAINT fk_billing_invoice_offer_snapshot FOREIGN KEY (tenant_id, offer_snapshot_id) REFERENCES billing_offer_snapshots (tenant_id, snapshot_id),
        CONSTRAINT chk_billing_invoice_total CHECK (total_minor >= 0),
        CONSTRAINT chk_billing_invoice_minor_units CHECK (minor_units_per_major > 0),
        CONSTRAINT chk_billing_invoice_offer_pair CHECK ((offer_snapshot_id IS NULL AND offer_version_label IS NULL AND offer_payload_hash IS NULL AND offer_effective_from IS NULL AND offer_pricing_effect IS NULL) OR (offer_snapshot_id IS NOT NULL AND offer_pricing_effect = 'held_not_settled'))
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
      COMMENT 'B3 issued invoices, immutable per cycle; BIGINT minor units, CHAR(3) currency'",
    'SELECT 1');
PREPARE c2_stmt_invoices FROM @c2_sql_invoices;
EXECUTE c2_stmt_invoices;
DEALLOCATE PREPARE c2_stmt_invoices;

-- -----------------------------------------------------------------------------
-- Step 4: billing_invoice_lines — child lines of one invoice, composite
-- tenant FK into (id, tenant_id). Rational numerators/denominators BIGINT.
-- -----------------------------------------------------------------------------
SET @c2_has_invoice_lines = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.TABLES
    WHERE TABLE_SCHEMA = @c2_db AND TABLE_NAME = 'billing_invoice_lines');

SET @c2_sql_invoice_lines = IF(@c2_has_invoice_lines = 0,
    "CREATE TABLE billing_invoice_lines (
        tenant_id CHAR(36) NOT NULL,
        invoice_id CHAR(36) NOT NULL COMMENT 'billing_invoices.id',
        line_id VARCHAR(128) NOT NULL COMMENT 'base_subscription or registration_step:<segment start epochs>',
        kind ENUM('base_subscription','registration_step') NOT NULL,
        segment_start BIGINT UNSIGNED NULL COMMENT 'Inclusive UTC epoch second of the segment; NULL only for the base line',
        segment_end BIGINT UNSIGNED NULL COMMENT 'Exclusive UTC epoch second of the segment; > segment_start for step lines',
        registration_count INT UNSIGNED NULL COMMENT 'Non-negative safe-integer count in the segment; NULL for the base line',
        numerator_minor_seconds BIGINT UNSIGNED NOT NULL COMMENT 'Exact integer numerator (minor units x seconds); >= 0',
        denominator_seconds BIGINT UNSIGNED NOT NULL COMMENT 'Exact integer denominator (seconds); > 0',
        created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
        PRIMARY KEY (tenant_id, invoice_id, line_id),
        KEY idx_billing_line_invoice_tenant (invoice_id, tenant_id),
        CONSTRAINT fk_billing_line_invoice FOREIGN KEY (invoice_id, tenant_id) REFERENCES billing_invoices (id, tenant_id),
        CONSTRAINT chk_billing_line_denominator CHECK (denominator_seconds > 0),
        CONSTRAINT chk_billing_line_base CHECK (kind <> 'base_subscription' OR (segment_start IS NULL AND segment_end IS NULL AND registration_count IS NULL)),
        CONSTRAINT chk_billing_line_step CHECK (kind <> 'registration_step' OR (segment_start IS NOT NULL AND segment_end IS NOT NULL AND segment_end > segment_start AND registration_count IS NOT NULL))
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
      COMMENT 'B3 immutable invoice lines; BIGINT rationals, no inexact arithmetic anywhere'",
    'SELECT 1');
PREPARE c2_stmt_invoice_lines FROM @c2_sql_invoice_lines;
EXECUTE c2_stmt_invoice_lines;
DEALLOCATE PREPARE c2_stmt_invoice_lines;

-- -----------------------------------------------------------------------------
-- Step 5: billing_difference_requests — FIN5 difference-payment requests.
-- status open/paid/expired/cancelled; version CAS; deadline computed once.
-- -----------------------------------------------------------------------------
SET @c2_has_difference_requests = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.TABLES
    WHERE TABLE_SCHEMA = @c2_db AND TABLE_NAME = 'billing_difference_requests');

SET @c2_sql_difference_requests = IF(@c2_has_difference_requests = 0,
    "CREATE TABLE billing_difference_requests (
        id CHAR(36) NOT NULL COMMENT 'DifferenceRequest.requestId (UUID minted by the domain)',
        tenant_id CHAR(36) NOT NULL,
        org_kind ENUM('teacher','center') NOT NULL,
        invoice_id VARCHAR(128) NOT NULL COMMENT 'Invoice identity the difference is anchored to (opaque domain string)',
        cycle_start BIGINT UNSIGNED NOT NULL COMMENT 'UTC epoch second of the invoiced cycle start',
        difference_basis VARCHAR(64) NOT NULL COMMENT 'Opaque difference basis code (MAX_DIFFERENCE_BASIS_LENGTH = 64)',
        basis_key CHAR(64) NULL COMMENT 'SHA-256 of (tenant, org, invoice, cycle, basis) for ordinary requests; SQL NULL for authorized corrections',
        amount_minor BIGINT UNSIGNED NOT NULL COMMENT 'Exact positive integer minor units, <= 1000000000000000 (MAX_AMOUNT_MINOR)',
        currency CHAR(3) NOT NULL,
        issued_at BIGINT UNSIGNED NOT NULL COMMENT 'Inclusive UTC epoch second the request was issued; 96h grace counts from here',
        deadline_at BIGINT UNSIGNED NOT NULL COMMENT 'issued_at + 345600 for ordinary requests; computed ONCE and never moved; explicit caller value on authorized corrections',
        status ENUM('open','paid','expired','cancelled') NOT NULL DEFAULT 'open',
        version INT UNSIGNED NOT NULL DEFAULT 1 COMMENT 'Safe-integer CAS version; every transition increments by exactly one',
        request_key VARCHAR(128) NOT NULL COMMENT 'Idempotency key (MAX_REQUEST_KEY_LENGTH = 128)',
        payload_hash CHAR(64) NOT NULL COMMENT 'Lowercase SHA-256 of the canonical issue payload; same key + other hash = conflict',
        paid_at BIGINT UNSIGNED NULL COMMENT 'Verified payment instant; only set with status = paid',
        settled_payment_id VARCHAR(128) NULL COMMENT 'Verified payment id; unique among non-NULL values per tenant',
        correction_of_request_id CHAR(36) NULL COMMENT 'Unchanged expired request this authorized correction replaces',
        correction_reason VARCHAR(500) NULL COMMENT 'Mandatory on corrections (MAX_REASON_LENGTH = 500)',
        corrected_by_actor_id VARCHAR(128) NULL COMMENT 'Mandatory on corrections: the authorized principal',
        created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
        updated_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
        PRIMARY KEY (id),
        UNIQUE KEY uq_billing_diff_request_id_tenant (id, tenant_id),
        UNIQUE KEY uq_billing_diff_request_key (tenant_id, request_key),
        UNIQUE KEY uq_billing_diff_request_basis (tenant_id, basis_key),
        UNIQUE KEY uq_billing_diff_request_settlement (tenant_id, settled_payment_id),
        KEY idx_billing_diff_request_open (tenant_id, status, deadline_at, id),
        CONSTRAINT fk_billing_diff_request_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id),
        CONSTRAINT fk_billing_diff_request_correction_of FOREIGN KEY (correction_of_request_id, tenant_id) REFERENCES billing_difference_requests (id, tenant_id),
        CONSTRAINT chk_billing_diff_request_amount CHECK (amount_minor > 0 AND amount_minor <= 1000000000000000),
        CONSTRAINT chk_billing_diff_request_order CHECK (deadline_at >= issued_at),
        CONSTRAINT chk_billing_diff_request_grace CHECK ((correction_of_request_id IS NULL AND deadline_at - issued_at = 345600 AND basis_key IS NOT NULL AND correction_reason IS NULL AND corrected_by_actor_id IS NULL) OR (correction_of_request_id IS NOT NULL AND basis_key IS NULL AND correction_reason IS NOT NULL AND corrected_by_actor_id IS NOT NULL)),
        CONSTRAINT chk_billing_diff_request_settled CHECK ((status = 'paid' AND paid_at IS NOT NULL AND settled_payment_id IS NOT NULL AND paid_at >= issued_at) OR (status <> 'paid' AND paid_at IS NULL AND settled_payment_id IS NULL)),
        CONSTRAINT chk_billing_diff_request_version CHECK (version >= 1)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
      COMMENT 'B3 difference requests: HK1 issuance, one basis per tenant, settlement uniqueness, CAS transitions'",
    'SELECT 1');
PREPARE c2_stmt_difference_requests FROM @c2_sql_difference_requests;
EXECUTE c2_stmt_difference_requests;
DEALLOCATE PREPARE c2_stmt_difference_requests;

-- -----------------------------------------------------------------------------
-- Step 6: billing_idempotency_keys EXTENSION — invoice issuance through the
-- canonical HK1 registry. Additive ALTERs on the FROZEN FIN3 table:
-- guarded ADD COLUMN, then re-probed UNIQUE key / composite FK / CHECK.
-- -----------------------------------------------------------------------------
SET @c2_has_idempotency = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.TABLES
    WHERE TABLE_SCHEMA = @c2_db AND TABLE_NAME = 'billing_idempotency_keys');

SET @c2_has_idem_invoice_col = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA = @c2_db AND TABLE_NAME = 'billing_idempotency_keys'
      AND COLUMN_NAME = 'invoice_id');

SET @c2_sql_idem_invoice_col = IF(@c2_has_idempotency = 1 AND @c2_has_idem_invoice_col = 0,
    "ALTER TABLE billing_idempotency_keys ADD COLUMN invoice_id CHAR(36) NULL COMMENT 'billing_invoices.id target for the invoice-issuance scope (HK1); exactly one target per registry row'",
    'SELECT 1');
PREPARE c2_stmt_idem_invoice_col FROM @c2_sql_idem_invoice_col;
EXECUTE c2_stmt_idem_invoice_col;
DEALLOCATE PREPARE c2_stmt_idem_invoice_col;

-- Re-probe AFTER the ADD COLUMN (probe-recompute rule), then reconcile the
-- invoice-target index.
SET @c2_has_idem_invoice_col_after = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA = @c2_db AND TABLE_NAME = 'billing_idempotency_keys'
      AND COLUMN_NAME = 'invoice_id');

-- The invoice target is deliberately NON-UNIQUE. `issueInvoice` persists a
-- registry row for EVERY caller key that resolves to an already-issued
-- invoice (server/src/services/billing-invoices.ts: after findInvoiceByKey
-- finds the canonical row it calls insertIdempotencyRecord with the SAME
-- invoiceId under the new key; the duplicate-key race path does the same), so
-- several (tenant, scope, key) aliases legitimately point at one invoice. ONE
-- canonical invoice per (tenant, org_kind, cycle_start) is still enforced by
-- uq_billing_invoice_cycle, and ONE registry row per
-- (tenant, scope, idempotency_key) is the FIN3 PK. The legacy name
-- uq_billing_idem_invoice (unique) is therefore a defect and is replaced by a
-- non-unique (invoice_id, tenant_id) index, which also backs the composite FK.
--
-- EXISTENCE + STRUCTURE are probed separately:
--   * existence uses COUNT(DISTINCT INDEX_NAME) because STATISTICS holds one
--     row PER INDEX COLUMN; COUNT(*) over the composite index is 2, so the
--     former `= 1`/`= 0` comparisons silently misread an existing index.
--   * structure is not assumed from the name: the new index must be
--     NON_UNIQUE = 1 and its ordered columns must be exactly
--     'invoice_id,tenant_id' (SEQ_IN_INDEX 1 then 2), via GROUP_CONCAT.
-- Re-runnable states (probes are recomputed after each earlier statement):
--   1. legacy unique present, new index absent -> ADD the new index FIRST,
--      re-probe/verify it, then drop ONLY the legacy unique;
--   2. both present (partially evolved catalog) -> drop ONLY the legacy unique
--      after the new index is verified;
--   3. neither present (fresh/clean path) -> add and verify the non-unique
--      index.
-- Any same-named index with a different shape/uniqueness, or an unrecognised
-- uq_billing_idem_invoice, is NEVER silently accepted: the guarded SIGNAL at
-- the end of this section aborts the migration. The FK's supporting index is
-- therefore present at every moment (ADD before DROP).
SET @c2_idem_invoice_idx_exists = (SELECT COUNT(DISTINCT INDEX_NAME) FROM INFORMATION_SCHEMA.STATISTICS
    WHERE TABLE_SCHEMA = @c2_db AND TABLE_NAME = 'billing_idempotency_keys'
      AND INDEX_NAME = 'idx_billing_idem_invoice');

SET @c2_idem_invoice_uq_exists = (SELECT COUNT(DISTINCT INDEX_NAME) FROM INFORMATION_SCHEMA.STATISTICS
    WHERE TABLE_SCHEMA = @c2_db AND TABLE_NAME = 'billing_idempotency_keys'
      AND INDEX_NAME = 'uq_billing_idem_invoice');

SET @c2_idem_invoice_idx_non_unique = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.STATISTICS
    WHERE TABLE_SCHEMA = @c2_db AND TABLE_NAME = 'billing_idempotency_keys'
      AND INDEX_NAME = 'idx_billing_idem_invoice'
      AND NON_UNIQUE = 1);

SET @c2_idem_invoice_idx_cols = (SELECT GROUP_CONCAT(COLUMN_NAME ORDER BY SEQ_IN_INDEX SEPARATOR ',')
    FROM INFORMATION_SCHEMA.STATISTICS
    WHERE TABLE_SCHEMA = @c2_db AND TABLE_NAME = 'billing_idempotency_keys'
      AND INDEX_NAME = 'idx_billing_idem_invoice');

SET @c2_idem_invoice_idx_shape_ok = IF(@c2_idem_invoice_idx_exists = 1
    AND @c2_idem_invoice_idx_non_unique = 2
    AND @c2_idem_invoice_idx_cols = 'invoice_id,tenant_id', 1, 0);

-- The legacy index is only dropped when it is recognisably the old
-- UNIQUE(invoice_id): a same-named different index is left untouched and
-- reported by the guarded SIGNAL below.
SET @c2_idem_invoice_uq_non_unique = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.STATISTICS
    WHERE TABLE_SCHEMA = @c2_db AND TABLE_NAME = 'billing_idempotency_keys'
      AND INDEX_NAME = 'uq_billing_idem_invoice'
      AND NON_UNIQUE = 0);

SET @c2_idem_invoice_uq_cols = (SELECT GROUP_CONCAT(COLUMN_NAME ORDER BY SEQ_IN_INDEX SEPARATOR ',')
    FROM INFORMATION_SCHEMA.STATISTICS
    WHERE TABLE_SCHEMA = @c2_db AND TABLE_NAME = 'billing_idempotency_keys'
      AND INDEX_NAME = 'uq_billing_idem_invoice');

SET @c2_idem_invoice_uq_is_legacy = IF(@c2_idem_invoice_uq_exists = 1
    AND @c2_idem_invoice_uq_non_unique = 1
    AND @c2_idem_invoice_uq_cols = 'invoice_id', 1, 0);

-- Step 6a: install the non-unique index FIRST when absent. This covers both
-- the clean path and the legacy-unique path, so the FK keeps a supporting
-- index before any DROP.
SET @c2_sql_idem_invoice_idx_add = IF(@c2_has_idempotency = 1
    AND @c2_has_idem_invoice_col_after = 1
    AND @c2_idem_invoice_idx_exists = 0,
    'ALTER TABLE billing_idempotency_keys ADD INDEX idx_billing_idem_invoice (invoice_id, tenant_id)',
    'SELECT 1');
PREPARE c2_stmt_idem_invoice_idx_add FROM @c2_sql_idem_invoice_idx_add;
EXECUTE c2_stmt_idem_invoice_idx_add;
DEALLOCATE PREPARE c2_stmt_idem_invoice_idx_add;

-- Re-probe the new index AFTER the possible ADD (probe-recompute rule).
SET @c2_idem_invoice_idx_exists_after = (SELECT COUNT(DISTINCT INDEX_NAME) FROM INFORMATION_SCHEMA.STATISTICS
    WHERE TABLE_SCHEMA = @c2_db AND TABLE_NAME = 'billing_idempotency_keys'
      AND INDEX_NAME = 'idx_billing_idem_invoice');

SET @c2_idem_invoice_idx_non_unique_after = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.STATISTICS
    WHERE TABLE_SCHEMA = @c2_db AND TABLE_NAME = 'billing_idempotency_keys'
      AND INDEX_NAME = 'idx_billing_idem_invoice'
      AND NON_UNIQUE = 1);

SET @c2_idem_invoice_idx_cols_after = (SELECT GROUP_CONCAT(COLUMN_NAME ORDER BY SEQ_IN_INDEX SEPARATOR ',')
    FROM INFORMATION_SCHEMA.STATISTICS
    WHERE TABLE_SCHEMA = @c2_db AND TABLE_NAME = 'billing_idempotency_keys'
      AND INDEX_NAME = 'idx_billing_idem_invoice');

SET @c2_idem_invoice_idx_shape_ok_after = IF(@c2_idem_invoice_idx_exists_after = 1
    AND @c2_idem_invoice_idx_non_unique_after = 2
    AND @c2_idem_invoice_idx_cols_after = 'invoice_id,tenant_id', 1, 0);

-- Step 6b: drop ONLY the legacy unique, and only once the replacement index
-- is structurally valid. The old CHECK/index name is never touched when its
-- shape is unknown.
SET @c2_sql_idem_invoice_uq_drop = IF(@c2_has_idempotency = 1
    AND @c2_has_idem_invoice_col_after = 1
    AND @c2_idem_invoice_uq_exists = 1
    AND @c2_idem_invoice_uq_is_legacy = 1
    AND @c2_idem_invoice_idx_exists_after = 1
    AND @c2_idem_invoice_idx_shape_ok_after = 1,
    'ALTER TABLE billing_idempotency_keys DROP INDEX uq_billing_idem_invoice',
    'SELECT 1');
PREPARE c2_stmt_idem_invoice_uq_drop FROM @c2_sql_idem_invoice_uq_drop;
EXECUTE c2_stmt_idem_invoice_uq_drop;
DEALLOCATE PREPARE c2_stmt_idem_invoice_uq_drop;

-- Re-probe AFTER the possible DROP (probe-recompute rule), then fail closed on
-- every unresolved or weak state. SIGNAL is not preparable and MySQL 8.0 does
-- not allow CREATE/DROP PROCEDURE in a prepared statement, so the failure is
-- raised from a LITERAL, unconditional top-level stored procedure of ONE SIGNAL
-- statement (no BEGIN/END, no internal separator, no DELIMITER). It has a
-- unique migration-specific name and the marker COMMENT below. There is no
-- `DROP PROCEDURE IF EXISTS` before the CREATE: a literal CREATE fails with
-- error 1304 when the name exists, so an unrelated routine is never overwritten
-- and a leftover helper of ours blocks a rerun until the operator drops that
-- exact helper (named in the SIGNAL message). The CALL dispatch is prepared
-- (supported); the literal DROP after it is reachable only when this run's own
-- CREATE succeeded, so it can only drop our helper.
SET @c2_idem_invoice_uq_exists_final = (SELECT COUNT(DISTINCT INDEX_NAME) FROM INFORMATION_SCHEMA.STATISTICS
    WHERE TABLE_SCHEMA = @c2_db AND TABLE_NAME = 'billing_idempotency_keys'
      AND INDEX_NAME = 'uq_billing_idem_invoice');

SET @c2_idem_invoice_idx_exists_final = (SELECT COUNT(DISTINCT INDEX_NAME) FROM INFORMATION_SCHEMA.STATISTICS
    WHERE TABLE_SCHEMA = @c2_db AND TABLE_NAME = 'billing_idempotency_keys'
      AND INDEX_NAME = 'idx_billing_idem_invoice');

SET @c2_idem_invoice_idx_non_unique_final = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.STATISTICS
    WHERE TABLE_SCHEMA = @c2_db AND TABLE_NAME = 'billing_idempotency_keys'
      AND INDEX_NAME = 'idx_billing_idem_invoice'
      AND NON_UNIQUE = 1);

SET @c2_idem_invoice_idx_cols_final = (SELECT GROUP_CONCAT(COLUMN_NAME ORDER BY SEQ_IN_INDEX SEPARATOR ',')
    FROM INFORMATION_SCHEMA.STATISTICS
    WHERE TABLE_SCHEMA = @c2_db AND TABLE_NAME = 'billing_idempotency_keys'
      AND INDEX_NAME = 'idx_billing_idem_invoice');

SET @c2_idem_invoice_idx_shape_ok_final = IF(@c2_idem_invoice_idx_exists_final = 1
    AND @c2_idem_invoice_idx_non_unique_final = 2
    AND @c2_idem_invoice_idx_cols_final = 'invoice_id,tenant_id', 1, 0);

SET @c2_idem_invoice_drift = IF(@c2_has_idempotency = 1
    AND @c2_has_idem_invoice_col_after = 1
    AND (@c2_idem_invoice_idx_exists_final = 0
      OR @c2_idem_invoice_idx_shape_ok_final = 0
      OR @c2_idem_invoice_uq_exists_final = 1), 1, 0);

CREATE PROCEDURE c2_20261022_02_guard_idx_fail()
    COMMENT 'tabweb 20261022_02 guard helper (safe to drop)'
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'billing_idempotency_keys index drift: DROP PROCEDURE c2_20261022_02_guard_idx_fail after reconciling, then rerun';

SET @c2_sql_idem_invoice_signal_call = IF(@c2_idem_invoice_drift = 1,
    'CALL c2_20261022_02_guard_idx_fail()',
    'SELECT 1');
PREPARE c2_stmt_idem_invoice_signal_call FROM @c2_sql_idem_invoice_signal_call;
EXECUTE c2_stmt_idem_invoice_signal_call;
DEALLOCATE PREPARE c2_stmt_idem_invoice_signal_call;

DROP PROCEDURE c2_20261022_02_guard_idx_fail;

-- A FRESH probe for billing_invoices too: the FK references a table created
-- earlier in this file, and @c2_has_invoices was evaluated BEFORE those CREATE
-- statements ran, so it is stale at this point by design of the probe
-- ordering. @c2_has_invoices_after reads the catalog as it stands now.
SET @c2_has_invoices_after = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.TABLES
    WHERE TABLE_SCHEMA = @c2_db AND TABLE_NAME = 'billing_invoices');

SET @c2_has_idem_invoice_fk = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.TABLE_CONSTRAINTS
    WHERE CONSTRAINT_SCHEMA = @c2_db AND TABLE_NAME = 'billing_idempotency_keys'
      AND CONSTRAINT_NAME = 'fk_billing_idem_invoice');

SET @c2_sql_idem_invoice_fk = IF(@c2_has_idempotency = 1 AND @c2_has_idem_invoice_col_after = 1 AND @c2_has_idem_invoice_fk = 0 AND @c2_has_invoices_after = 1,
    'ALTER TABLE billing_idempotency_keys ADD CONSTRAINT fk_billing_idem_invoice FOREIGN KEY (invoice_id, tenant_id) REFERENCES billing_invoices (id, tenant_id)',
    'SELECT 1');
PREPARE c2_stmt_idem_invoice_fk FROM @c2_sql_idem_invoice_fk;
EXECUTE c2_stmt_idem_invoice_fk;
DEALLOCATE PREPARE c2_stmt_idem_invoice_fk;

SET @c2_has_idem_invoice_chk = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.TABLE_CONSTRAINTS
    WHERE CONSTRAINT_SCHEMA = @c2_db AND TABLE_NAME = 'billing_idempotency_keys'
      AND CONSTRAINT_NAME = 'chk_billing_idem_invoice');

SET @c2_sql_idem_invoice_chk = IF(@c2_has_idempotency = 1 AND @c2_has_idem_invoice_col_after = 1 AND @c2_has_idem_invoice_chk = 0,
    'ALTER TABLE billing_idempotency_keys ADD CONSTRAINT chk_billing_idem_invoice CHECK (invoice_id IS NULL OR (journal_id IS NULL AND reservation_id IS NULL))',
    'SELECT 1');
PREPARE c2_stmt_idem_invoice_chk FROM @c2_sql_idem_invoice_chk;
EXECUTE c2_stmt_idem_invoice_chk;
DEALLOCATE PREPARE c2_stmt_idem_invoice_chk;

-- -----------------------------------------------------------------------------
-- Step 7: evolve the FROZEN FIN3 target CHECK so an invoice target is legal.
-- The frozen `chk_billing_idem_target` is `(journal_id IS NULL) <>
-- (reservation_id IS NULL)`: exactly one of the two ORIGINAL targets. An
-- invoice registry row has journal_id = NULL AND reservation_id = NULL, so
-- every invoice row would violate the old CHECK on a real database. The
-- replacement is exactly one of journal_id / reservation_id / invoice_id.
--
-- Atomicity: on the clean path the old name is dropped and the replacement name
-- added in ONE ALTER TABLE statement, so there is no instant at which the table
-- has no target check. Every row that satisfied the old CHECK also satisfies the
-- new one (invoice_id is NULL on those rows), so the conversion cannot reject
-- existing valid data. No FK/CHECK disabling and no row/table deletion.
--
-- The replacement is NEVER classified by name alone and never by
-- `LIKE '%invoice_id%'`. MySQL stores the canonical CHECK text in
-- INFORMATION_SCHEMA.CHECK_CONSTRAINTS.CHECK_CLAUSE. Normalization removes ONLY
-- backticks and whitespace (space/tab/LF/CR) and applies LOWER(); EVERY
-- parenthesis is preserved. Deleting parentheses is NOT semantic validation:
--   canonical: ((journal_id IS NULL)+(reservation_id IS NULL)+(invoice_id IS NULL))=2
--   weak:      (journal_id IS NULL)+(reservation_id IS NULL)+((invoice_id IS NULL)=2)
-- become the SAME text once parentheses are deleted, yet with all three
-- targets NULL the canonical is false (3 = 2) and the weak form is true.
-- Parenthesis preservation keeps those groupings apart, so the weak form below
-- can never be accepted.
--
-- Recognition is required ONLY for a PRE-EXISTING replacement found by name
-- (states B and D). When THIS file adds the replacement itself -- the atomic
-- DROP old + ADD canonical of state A, or the ADD of state F -- the statement
-- we issued is authoritative and its own output is NOT re-recognised (so the
-- file does not depend on guessing MySQL's rendering for its own DDL).
--
-- For a pre-existing replacement the normalized clause must equal one of the
-- following EXACT renderings. They were derived from this file's ADD text as
-- the renderings MySQL 8.0 may produce; every one is ASSUMED, TO BE VERIFIED
-- ON A LIVE SERVER. Only these exact strings are accepted; anything else fails
-- closed (the old CHECK is retained).
--   canonical sum, parentheses exactly as written:
--     ((journal_idisnull)+(reservation_idisnull)+(invoice_idisnull)=2)
--   canonical sum, INFORMATION_SCHEMA outer pair omitted:
--     (journal_idisnull)+(reservation_idisnull)+(invoice_idisnull)=2
--   canonical sum, comparison left side additionally wrapped:
--     (((journal_idisnull)+(reservation_idisnull)+(invoice_idisnull))=2)
--   canonical sum, redundant term parentheses removed, left side wrapped:
--     ((journal_idisnull+reservation_idisnull+invoice_idisnull)=2)
--   canonical sum, outer pair kept and term parentheses removed:
--     (journal_idisnull+reservation_idisnull+invoice_idisnull=2)
--   canonical sum, every redundant pair removed:
--     journal_idisnull+reservation_idisnull+invoice_idisnull=2
--   earlier revision's semantically equivalent IF form, outer pair kept:
--     (if(journal_idisnull,0,1)+if(reservation_idisnull,0,1)+if(invoice_idisnull,0,1)=1)
--   earlier IF form, INFORMATION_SCHEMA outer pair omitted:
--     if(journal_idisnull,0,1)+if(reservation_idisnull,0,1)+if(invoice_idisnull,0,1)=1
-- NOT recognised (dangerous weak renderings): any text containing
-- `+((invoice_idisnull)=2)` or otherwise moving `=2` inside the invoice term.
--
-- Partial-application states (all re-runnable; the probes are recomputed AFTER
-- every earlier statement):
--   A. old present, replacement absent -> atomic DROP old + ADD canonical
--      (our own output, no recognition required).
--   B. old absent, replacement present and recognised -> no-op.
--   C. old absent, replacement unrecognised -> SIGNAL, never accept drift.
--   D. both present, replacement recognised -> drop ONLY the old CHECK.
--   E. both present, replacement unrecognised -> keep the old CHECK, SIGNAL.
--   F. neither present (clean/partial catalog) -> ADD canonical, re-probe
--      (our own output, no recognition required).
-- -----------------------------------------------------------------------------
SET @c2_has_idem_target_old = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.TABLE_CONSTRAINTS
    WHERE CONSTRAINT_SCHEMA = @c2_db AND TABLE_NAME = 'billing_idempotency_keys'
      AND CONSTRAINT_NAME = 'chk_billing_idem_target');

SET @c2_has_idem_target_new = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.TABLE_CONSTRAINTS
    WHERE CONSTRAINT_SCHEMA = @c2_db AND TABLE_NAME = 'billing_idempotency_keys'
      AND CONSTRAINT_NAME = 'chk_billing_idem_target_combined');

-- Normalize the stored CHECK_CLAUSE once: lowercase and remove backticks,
-- ordinary spaces, tab/newline/carriage-return. Parentheses are NEVER removed.
SET @c2_idem_target_combined_clause = (SELECT
    REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(
        LOWER(CHECK_CLAUSE),
        '`', ''),
        ' ', ''),
        CHAR(9), ''),
        CHAR(10), ''),
        CHAR(13), '')
    FROM INFORMATION_SCHEMA.CHECK_CONSTRAINTS
    WHERE CONSTRAINT_SCHEMA = @c2_db
      AND CONSTRAINT_NAME = 'chk_billing_idem_target_combined'
      AND EXISTS (SELECT 1 FROM INFORMATION_SCHEMA.TABLE_CONSTRAINTS enforced_check
          WHERE enforced_check.CONSTRAINT_SCHEMA = @c2_db
            AND enforced_check.CONSTRAINT_NAME = 'chk_billing_idem_target_combined'
            AND enforced_check.CONSTRAINT_TYPE = 'CHECK' AND enforced_check.ENFORCED = 'YES'));

-- Explicit recognised renderings (all ASSUMED; verify on a live server). They
-- preserve the grouping that makes 'exactly one non-NULL target' true.
SET @c2_idem_target_clause_canonical_paren = '((journal_idisnull)+(reservation_idisnull)+(invoice_idisnull)=2)';
SET @c2_idem_target_clause_canonical_no_outer = '(journal_idisnull)+(reservation_idisnull)+(invoice_idisnull)=2';
SET @c2_idem_target_clause_canonical_lhs_wrapped = '(((journal_idisnull)+(reservation_idisnull)+(invoice_idisnull))=2)';
SET @c2_idem_target_clause_canonical_flat_terms = '((journal_idisnull+reservation_idisnull+invoice_idisnull)=2)';
SET @c2_idem_target_clause_canonical_flat_terms_outer = '(journal_idisnull+reservation_idisnull+invoice_idisnull=2)';
SET @c2_idem_target_clause_canonical_flat_all = 'journal_idisnull+reservation_idisnull+invoice_idisnull=2';
SET @c2_idem_target_clause_legacy_if_paren = '(if(journal_idisnull,0,1)+if(reservation_idisnull,0,1)+if(invoice_idisnull,0,1)=1)';
SET @c2_idem_target_clause_legacy_if_no_outer = 'if(journal_idisnull,0,1)+if(reservation_idisnull,0,1)+if(invoice_idisnull,0,1)=1';

-- State A: exactly one atomic statement drops the old CHECK and adds the
-- replacement. The canonical expression allows only exactly one non-NULL
-- target (sum of IS NULL flags = 2). This is OUR OWN output: no recognition is
-- applied to it later.
SET @c2_idem_target_evolve_needed = IF(@c2_has_idempotency = 1
    AND @c2_has_idem_invoice_col_after = 1
    AND @c2_has_idem_target_old = 1
    AND @c2_has_idem_target_new = 0, 1, 0);

SET @c2_sql_idem_target_evolve = IF(@c2_idem_target_evolve_needed = 1,
    'ALTER TABLE billing_idempotency_keys DROP CHECK chk_billing_idem_target, ADD CONSTRAINT chk_billing_idem_target_combined CHECK ((journal_id IS NULL) + (reservation_id IS NULL) + (invoice_id IS NULL) = 2)',
    'SELECT 1');
PREPARE c2_stmt_idem_target_evolve FROM @c2_sql_idem_target_evolve;
EXECUTE c2_stmt_idem_target_evolve;
DEALLOCATE PREPARE c2_stmt_idem_target_evolve;

-- Re-probe AFTER State A (probe-recompute rule) and reclassify.
SET @c2_has_idem_target_old_after = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.TABLE_CONSTRAINTS
    WHERE CONSTRAINT_SCHEMA = @c2_db AND TABLE_NAME = 'billing_idempotency_keys'
      AND CONSTRAINT_NAME = 'chk_billing_idem_target');

SET @c2_has_idem_target_new_after = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.TABLE_CONSTRAINTS
    WHERE CONSTRAINT_SCHEMA = @c2_db AND TABLE_NAME = 'billing_idempotency_keys'
      AND CONSTRAINT_NAME = 'chk_billing_idem_target_combined');

-- State F: neither present: install the replacement exactly once. This is OUR
-- OWN output, so it is not re-recognised below.
SET @c2_idem_target_add_needed = IF(@c2_has_idempotency = 1
    AND @c2_has_idem_invoice_col_after = 1
    AND @c2_has_idem_target_old_after = 0
    AND @c2_has_idem_target_new_after = 0, 1, 0);

SET @c2_sql_idem_target_add = IF(@c2_idem_target_add_needed = 1,
    'ALTER TABLE billing_idempotency_keys ADD CONSTRAINT chk_billing_idem_target_combined CHECK ((journal_id IS NULL) + (reservation_id IS NULL) + (invoice_id IS NULL) = 2)',
    'SELECT 1');
PREPARE c2_stmt_idem_target_add FROM @c2_sql_idem_target_add;
EXECUTE c2_stmt_idem_target_add;
DEALLOCATE PREPARE c2_stmt_idem_target_add;

-- Re-probe AFTER State F.
SET @c2_has_idem_target_old_final = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.TABLE_CONSTRAINTS
    WHERE CONSTRAINT_SCHEMA = @c2_db AND TABLE_NAME = 'billing_idempotency_keys'
      AND CONSTRAINT_NAME = 'chk_billing_idem_target');

SET @c2_has_idem_target_new_final = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.TABLE_CONSTRAINTS
    WHERE CONSTRAINT_SCHEMA = @c2_db AND TABLE_NAME = 'billing_idempotency_keys'
      AND CONSTRAINT_NAME = 'chk_billing_idem_target_combined');

SET @c2_idem_target_combined_clause_final = (SELECT
    REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(
        LOWER(CHECK_CLAUSE),
        '`', ''),
        ' ', ''),
        CHAR(9), ''),
        CHAR(10), ''),
        CHAR(13), '')
    FROM INFORMATION_SCHEMA.CHECK_CONSTRAINTS
    WHERE CONSTRAINT_SCHEMA = @c2_db
      AND CONSTRAINT_NAME = 'chk_billing_idem_target_combined'
      AND EXISTS (SELECT 1 FROM INFORMATION_SCHEMA.TABLE_CONSTRAINTS enforced_check
          WHERE enforced_check.CONSTRAINT_SCHEMA = @c2_db
            AND enforced_check.CONSTRAINT_NAME = 'chk_billing_idem_target_combined'
            AND enforced_check.CONSTRAINT_TYPE = 'CHECK' AND enforced_check.ENFORCED = 'YES'));

SET @c2_idem_target_new_recognised_final = IF(@c2_has_idem_target_new_final = 1
    AND @c2_idem_target_combined_clause_final IN (
        @c2_idem_target_clause_canonical_paren,
        @c2_idem_target_clause_canonical_no_outer,
        @c2_idem_target_clause_canonical_lhs_wrapped,
        @c2_idem_target_clause_canonical_flat_terms,
        @c2_idem_target_clause_canonical_flat_terms_outer,
        @c2_idem_target_clause_canonical_flat_all,
        @c2_idem_target_clause_legacy_if_paren,
        @c2_idem_target_clause_legacy_if_no_outer), 1, 0);

-- True when THIS run added the replacement itself (state A or F). Our own
-- output is authoritative and is not required to match the assumed renderings
-- above; only a PRE-EXISTING replacement must be recognised.
SET @c2_idem_target_added_here = IF(@c2_idem_target_evolve_needed = 1
    OR @c2_idem_target_add_needed = 1, 1, 0);

-- State D: old and a RECOGNISED replacement both present -> drop ONLY the old
-- CHECK. An unrecognised replacement never triggers this statement.
SET @c2_sql_idem_target_old_drop = IF(@c2_has_idempotency = 1
    AND @c2_has_idem_target_old_final = 1
    AND @c2_has_idem_target_new_final = 1
    AND @c2_idem_target_new_recognised_final = 1,
    'ALTER TABLE billing_idempotency_keys DROP CHECK chk_billing_idem_target',
    'SELECT 1');
PREPARE c2_stmt_idem_target_old_drop FROM @c2_sql_idem_target_old_drop;
EXECUTE c2_stmt_idem_target_old_drop;
DEALLOCATE PREPARE c2_stmt_idem_target_old_drop;

-- Re-probe AFTER State D, then fail closed on any state that is not exactly
-- "old CHECK absent + replacement present (recognised when it pre-existed, or
-- added by this run)". Same literal, unconditional, non-prepared helper design
-- as the index-shape guard above: one SIGNAL statement, a unique
-- migration-specific name, the marker COMMENT, no DROP IF EXISTS before the
-- CREATE (error 1304 is the fail-closed collision protection), a prepared CALL
-- dispatch, and a literal DROP after it that can only remove this run's own
-- helper when the CALL did not abort the script.
SET @c2_has_idem_target_old_end = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.TABLE_CONSTRAINTS
    WHERE CONSTRAINT_SCHEMA = @c2_db AND TABLE_NAME = 'billing_idempotency_keys'
      AND CONSTRAINT_NAME = 'chk_billing_idem_target');

SET @c2_has_idem_target_new_end = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.TABLE_CONSTRAINTS
    WHERE CONSTRAINT_SCHEMA = @c2_db AND TABLE_NAME = 'billing_idempotency_keys'
      AND CONSTRAINT_NAME = 'chk_billing_idem_target_combined');

SET @c2_idem_target_combined_clause_end = (SELECT
    REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(
        LOWER(CHECK_CLAUSE),
        '`', ''),
        ' ', ''),
        CHAR(9), ''),
        CHAR(10), ''),
        CHAR(13), '')
    FROM INFORMATION_SCHEMA.CHECK_CONSTRAINTS
    WHERE CONSTRAINT_SCHEMA = @c2_db
      AND CONSTRAINT_NAME = 'chk_billing_idem_target_combined'
      AND EXISTS (SELECT 1 FROM INFORMATION_SCHEMA.TABLE_CONSTRAINTS enforced_check
          WHERE enforced_check.CONSTRAINT_SCHEMA = @c2_db
            AND enforced_check.CONSTRAINT_NAME = 'chk_billing_idem_target_combined'
            AND enforced_check.CONSTRAINT_TYPE = 'CHECK' AND enforced_check.ENFORCED = 'YES'));

SET @c2_idem_target_new_recognised_end = IF(@c2_has_idem_target_new_end = 1
    AND @c2_idem_target_combined_clause_end IN (
        @c2_idem_target_clause_canonical_paren,
        @c2_idem_target_clause_canonical_no_outer,
        @c2_idem_target_clause_canonical_lhs_wrapped,
        @c2_idem_target_clause_canonical_flat_terms,
        @c2_idem_target_clause_canonical_flat_terms_outer,
        @c2_idem_target_clause_canonical_flat_all,
        @c2_idem_target_clause_legacy_if_paren,
        @c2_idem_target_clause_legacy_if_no_outer), 1, 0);

SET @c2_idem_target_drift = IF(@c2_has_idempotency = 1
    AND @c2_has_idem_invoice_col_after = 1
    AND (@c2_has_idem_target_old_end = 1
      OR @c2_has_idem_target_new_end = 0
      OR (@c2_idem_target_new_recognised_end = 0
        AND @c2_idem_target_added_here = 0)), 1, 0);

CREATE PROCEDURE c2_20261022_02_guard_target_fail()
    COMMENT 'tabweb 20261022_02 guard helper (safe to drop)'
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'billing_idempotency_keys CHECK drift: DROP PROCEDURE c2_20261022_02_guard_target_fail after reconciling, then rerun';

SET @c2_sql_idem_target_signal_call = IF(@c2_idem_target_drift = 1,
    'CALL c2_20261022_02_guard_target_fail()',
    'SELECT 1');
PREPARE c2_stmt_idem_target_signal_call FROM @c2_sql_idem_target_signal_call;
EXECUTE c2_stmt_idem_target_signal_call;
DEALLOCATE PREPARE c2_stmt_idem_target_signal_call;

DROP PROCEDURE c2_20261022_02_guard_target_fail;
