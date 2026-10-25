-- =============================================================================
-- B3-C-SCHEMA (PATH-C1) — checkout orders and provider events (FIN8)
-- Task:    path-C1-schema
-- Date:    2026-10-22
-- Purpose: storage for the accepted domain contract
--   `server/src/services/payment-checkout.ts` (CheckoutStore /
--                                              CHECKOUT_STORE_SQL_CONTRACT)
--   Contract: docs/contracts/B3-SCHEMA-CONTRACT-20261022.md
--
-- DESIGN
--   1. `checkout_orders`: the neutral vendor-agnostic checkout order. The
--      required `UNIQUE (tenant_id, order_id)` IS the primary key, so the
--      version CAS (`... WHERE version = expected` in one statement,
--      incrementing version by one) plus the FOR UPDATE lock the adapter
--      takes are race-proof at the exact natural key. Only `status`,
--      `confirmed_at`, `confirmed_provider_event_id`, `last_event_at`,
--      `last_provider_event_id` and `version` change after insert; order
--      amount, currency, payer reference and purpose are immutable.
--      CHECK constraints pin the paid/confirmed pairing and the paired
--      last-event columns. Money: BIGINT UNSIGNED minor units, bound
--      MAX_CHECKOUT_AMOUNT_MINOR = 10^15, CHAR(3) currency.
--   2. `checkout_provider_events`: the append-only provider event log.
--      UNIQUE (provider, provider_event_id) is the dedupe arbiter; it is
--      global ACROSS tenants by design — the domain's findProviderEvent
--      dedupes by (provider, providerEventId) without a tenant, and a
--      payload conflict on the same id must be detectable regardless of
--      tenant. The row still carries tenant_id + a tenant FK. There is NO
--      FK into checkout_orders INTENTIONALLY: provider events that name a
--      missing order (order-not-found) are quarantined/ignored AND STILL
--      STORED, so an enforcing FK would break quarantine. There is no
--      UPDATE/DELETE path for provider events; the recorded `outcome` and
--      `reason` keep the full ignored/rejected/quarantined trail that
--      reconciliation and discrepancy support need.
--   3. Caller-supplied instants (createdAt/expiresAt/occurredAt are ISO
--      timestamp strings in the domain) are stored as DATETIME(3) to keep
--      full millisecond precision out of the MySQL TIMESTAMP 2038 range
--      restriction; only the pure server bookkeeping `updated_at` uses the
--      TIMESTAMP(3) convention. This is a recorded interpretation, not a
--      settled contract item.
--
-- NOT IN THIS SCHEMA (held, do not invent): PSP/vendor identity, signature
--   material (the verifier is injected and never stored), cash/offline
--   receipts (cash never creates merchant_available), ledger journals or
--   balances (this domain writes none), payout/refund/dispute tables.
--
-- APPEND-ONLY OBLIGATION (DDL limit): UPDATE/DELETE on
--   `checkout_provider_events` MUST be denied by the application privilege
--   layer; `checkout_orders` mutates ONLY through the version CAS.
--
-- OWNERSHIP / IDEMPOTENCY
--   Both tables carry tenant_id; FK references only the proven tenants(id)
--   PK. Every statement is guarded by INFORMATION_SCHEMA probes +
--   PREPARE/EXECUTE (idempotent re-runs). No DROP, no TRUNCATE, no
--   DELETE/UPDATE of data, no FOREIGN_KEY_CHECKS manipulation, no backfill.
--
-- !! THIS FILE IS AUTHORING-ONLY SOURCE DDL. No statement here is executed,
--    no database is connected to. Manifest registration is Codex's.
-- =============================================================================

SET @c3_db = DATABASE();

-- -----------------------------------------------------------------------------
-- Step 1: checkout_orders — one row per (tenant, order id), version CAS.
-- -----------------------------------------------------------------------------
SET @c3_has_checkout_orders = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.TABLES
    WHERE TABLE_SCHEMA = @c3_db AND TABLE_NAME = 'checkout_orders');

SET @c3_sql_checkout_orders = IF(@c3_has_checkout_orders = 0,
    "CREATE TABLE checkout_orders (
        tenant_id CHAR(36) NOT NULL,
        order_id VARCHAR(64) NOT NULL COMMENT 'Opaque caller code (MAX_ORDER_ID_LENGTH = 64); unique per tenant and the natural key of the CAS',
        payer_reference VARCHAR(128) NOT NULL COMMENT 'Opaque payer reference from the checkout flow; never a card/PAN (MAX_PAYER_REFERENCE_LENGTH = 128)',
        purpose VARCHAR(64) NOT NULL COMMENT 'Opaque business purpose code, e.g. subscription_difference (MAX_PURPOSE_LENGTH = 64)',
        amount_minor BIGINT UNSIGNED NOT NULL COMMENT 'Exact positive integer minor units, <= 1000000000000000 (MAX_CHECKOUT_AMOUNT_MINOR)',
        currency CHAR(3) NOT NULL COMMENT 'Uppercase ISO-4217 code',
        status ENUM('created','pending','paid','failed','expired','cancelled') NOT NULL DEFAULT 'created' COMMENT 'Terminal states paid/failed/expired/cancelled are immutable',
        created_at DATETIME(3) NOT NULL COMMENT 'Domain ISO instant (caller or server clock), milliseconds kept',
        expires_at DATETIME(3) NOT NULL COMMENT 'Domain ISO instant; must be later than created_at (domain-checked)',
        confirmed_at DATETIME(3) NULL COMMENT 'Set only on the transition to paid (= the applied event occurredAt)',
        confirmed_provider_event_id VARCHAR(128) NULL COMMENT 'Applied paid event id, set only with confirmed_at',
        last_event_at DATETIME(3) NULL COMMENT 'Last applied provider event instant (out-of-order handling)',
        last_provider_event_id VARCHAR(128) NULL COMMENT 'Last applied provider event id, always paired with last_event_at',
        version INT UNSIGNED NOT NULL DEFAULT 0 COMMENT 'Safe-integer CAS version; increment by exactly one per transition',
        updated_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
        PRIMARY KEY (tenant_id, order_id),
        KEY idx_checkout_orders_expiry (tenant_id, expires_at, status),
        CONSTRAINT fk_checkout_orders_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id),
        CONSTRAINT chk_checkout_orders_amount CHECK (amount_minor > 0 AND amount_minor <= 1000000000000000),
        CONSTRAINT chk_checkout_orders_confirmation CHECK ((status = 'paid' AND confirmed_at IS NOT NULL AND confirmed_provider_event_id IS NOT NULL) OR (status <> 'paid' AND confirmed_at IS NULL AND confirmed_provider_event_id IS NULL)),
        CONSTRAINT chk_checkout_orders_last_event CHECK ((last_event_at IS NULL AND last_provider_event_id IS NULL) OR (last_event_at IS NOT NULL AND last_provider_event_id IS NOT NULL))
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
      COMMENT 'B3 checkout orders: neutral vendor-agnostic order state machine, amount in exact BIGINT minor units'",
    'SELECT 1');
PREPARE c3_stmt_checkout_orders FROM @c3_sql_checkout_orders;
EXECUTE c3_stmt_checkout_orders;
DEALLOCATE PREPARE c3_stmt_checkout_orders;

-- -----------------------------------------------------------------------------
-- Step 2: checkout_provider_events — append-only deduped provider events.
-- -----------------------------------------------------------------------------
SET @c3_has_provider_events = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.TABLES
    WHERE TABLE_SCHEMA = @c3_db AND TABLE_NAME = 'checkout_provider_events');

SET @c3_sql_provider_events = IF(@c3_has_provider_events = 0,
    "CREATE TABLE checkout_provider_events (
        provider VARCHAR(64) NOT NULL COMMENT 'Opaque provider code (MAX_PROVIDER_LENGTH = 64)',
        provider_event_id VARCHAR(128) NOT NULL COMMENT 'Provider event id (MAX_PROVIDER_EVENT_ID_LENGTH = 128); UNIQUE with provider across tenants BY DESIGN',
        tenant_id CHAR(36) NOT NULL COMMENT 'Tenant the event names; kept even when the order is absent',
        order_ref VARCHAR(64) NOT NULL COMMENT 'Order identity this event names within the tenant (MAX_ORDER_ID_LENGTH = 64); may name a missing order (quarantine path has no FK)',
        amount_minor BIGINT UNSIGNED NOT NULL COMMENT 'Exact positive integer minor units, <= 1000000000000000 (MAX_CHECKOUT_AMOUNT_MINOR)',
        currency CHAR(3) NOT NULL,
        status ENUM('paid','failed') NOT NULL COMMENT 'Provider-declared payment status',
        outcome ENUM('paid','failed','ignored','rejected','quarantined') NOT NULL COMMENT 'Recorded application outcome',
        reason VARCHAR(32) NULL COMMENT 'CheckoutEventReason label; NULL when cleanly applied',
        occurred_at DATETIME(3) NOT NULL COMMENT 'Domain ISO instant from the provider, milliseconds kept',
        raw_payload_hash VARCHAR(128) NOT NULL COMMENT 'Raw payload identifier (MAX_PAYLOAD_HASH_LENGTH = 128); payload conflict detection',
        recorded_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) COMMENT 'Server recording instant, milliseconds kept',
        PRIMARY KEY (provider, provider_event_id),
        KEY idx_provider_events_order (tenant_id, order_ref),
        KEY idx_provider_events_tenant_recorded (tenant_id, recorded_at),
        CONSTRAINT fk_provider_events_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id),
        CONSTRAINT chk_provider_events_amount CHECK (amount_minor > 0 AND amount_minor <= 1000000000000000)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
      COMMENT 'B3 append-only provider events; dedupe by (provider, provider_event_id), quarantine/discrepancy trail kept'",
    'SELECT 1');
PREPARE c3_stmt_provider_events FROM @c3_sql_provider_events;
EXECUTE c3_stmt_provider_events;
DEALLOCATE PREPARE c3_stmt_provider_events;
