-- =============================================================================
-- M2 fix — monotonic audit chain sequence + anchored head
-- Task:    m2-fix-audit-chain-seq-20261018-22
-- Batch:   m7-server-super-admin-20261018
-- Date:    2026-10-19
-- Scope:
--   Adds the missing total-order primitives for the M7 tamper-evident audit
--   chain (review finding M2 in docs/agent-reports/review-m6-m7.md):
--     1. audit_events.chain_seq — a monotonic append sequence assigned by the
--        sealed writer under a single-row head lock, so the leaf read and the
--        verification walk share one total order even when two sealed rows
--        land in the same TIMESTAMP second (id is a random UUID and must
--        never decide chain order).
--     2. audit_chain_head — a single-row anchored head (head_seq,
--        head_entry_hash, head_row_id) that the sealed writer advances under
--        SELECT ... FOR UPDATE serialization; verification compares it to the
--        current leaf so deleting the newest rows (tail truncation) is
--        detected.
--   Legacy sealed rows keep chain_seq = 0 and stay ordered by
--   (created_at, id) exactly as before; new appends start at the highest
--   existing chain_seq + 1, so no historical row is rewritten.
--
-- QUERIES SERVED (read-only source; this file is authoring-only and does not
-- run them)
--   server/src/services/audit-log.ts
--     locked head read (SELECT ... FOR UPDATE), head bootstrap seed,
--     sealed INSERT with chain_seq, head advance,
--     chain verification walk ORDER BY chain_seq ASC, leaf/head anchor check
--
-- IDEMPOTENCY
--   Every statement is wrapped in an INFORMATION_SCHEMA probe plus
--   PREPARE/EXECUTE, so re-running this file is a no-op. No destructive DDL,
--   no row rewrite of existing audit payload, no foreign-key check disable.
--
-- !! AUTHORING-ONLY. SQL EXECUTION and live/bootstrap validation are OUT OF
--    SCOPE for this batch and require a separately approved isolated
--    bootstrap + live verification step. Do not run here.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Step 1: monotonic chain sequence column on audit_events. Legacy rows keep
-- the DEFAULT 0; the sealed writer assigns strictly increasing values.
-- -----------------------------------------------------------------------------
SET @m2_has_audit_events = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.TABLES
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'audit_events');

SET @m2_has_chain_seq = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'audit_events'
    AND COLUMN_NAME = 'chain_seq');

SET @m2_add_chain_seq_sql = IF(@m2_has_audit_events = 1 AND @m2_has_chain_seq = 0,
  'ALTER TABLE audit_events ADD COLUMN chain_seq BIGINT UNSIGNED NOT NULL DEFAULT 0',
  'SELECT 1');
PREPARE m2_stmt_add_chain_seq FROM @m2_add_chain_seq_sql;
EXECUTE m2_stmt_add_chain_seq;
DEALLOCATE PREPARE m2_stmt_add_chain_seq;

-- -----------------------------------------------------------------------------
-- Step 2: index backing both the ascending verification walk and the
-- descending leaf read over the shared (chain_seq, created_at, id) order.
-- -----------------------------------------------------------------------------
SET @m2_idx_chain_seq_exists = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.STATISTICS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'audit_events'
    AND INDEX_NAME = 'idx_audit_chain_seq');

SET @m2_sql_chain_seq_idx = IF(@m2_has_audit_events = 1 AND @m2_idx_chain_seq_exists = 0,
  'ALTER TABLE audit_events ADD INDEX idx_audit_chain_seq (chain_seq, created_at, id)',
  'SELECT 1');
PREPARE m2_stmt_chain_seq_idx FROM @m2_sql_chain_seq_idx;
EXECUTE m2_stmt_chain_seq_idx;
DEALLOCATE PREPARE m2_stmt_chain_seq_idx;

-- -----------------------------------------------------------------------------
-- Step 3: single-row anchored head. The sealed writer holds the row lock
-- (SELECT ... FOR UPDATE) across leaf resolution + append + head advance, so
-- concurrent writers cannot fork the chain.
-- -----------------------------------------------------------------------------
SET @m2_has_chain_head = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.TABLES
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'audit_chain_head');

SET @m2_sql_chain_head = IF(@m2_has_chain_head = 0,
  'CREATE TABLE audit_chain_head (
    id VARCHAR(36) NOT NULL PRIMARY KEY,
    head_seq BIGINT UNSIGNED NOT NULL DEFAULT 0,
    head_entry_hash CHAR(64) NULL,
    head_row_id CHAR(36) NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NULL
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci',
  'SELECT 1');
PREPARE m2_stmt_chain_head FROM @m2_sql_chain_head;
EXECUTE m2_stmt_chain_head;
DEALLOCATE PREPARE m2_stmt_chain_head;

-- -----------------------------------------------------------------------------
-- Step 4: seed the singleton head row (idempotent). When entry_hash exists
-- (migration 20261018_17), anchor it to the current legacy leaf using the same
-- (chain_seq, created_at, id) order the verification walk uses; otherwise the
-- chain starts empty at seq 0.
-- -----------------------------------------------------------------------------
SET @m2_has_entry_hash = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'audit_events'
    AND COLUMN_NAME = 'entry_hash');

SET @m2_head_hash_expr = IF(@m2_has_audit_events = 1 AND @m2_has_entry_hash = 1,
  '(SELECT t.entry_hash FROM audit_events t WHERE t.entry_hash IS NOT NULL ORDER BY t.chain_seq DESC, t.created_at DESC, t.id DESC LIMIT 1)',
  'NULL');

SET @m2_head_row_expr = IF(@m2_has_audit_events = 1 AND @m2_has_entry_hash = 1,
  '(SELECT t.id FROM audit_events t WHERE t.entry_hash IS NOT NULL ORDER BY t.chain_seq DESC, t.created_at DESC, t.id DESC LIMIT 1)',
  'NULL');

-- The table now exists (step 3), so the singleton row can be probed directly;
-- this also seeds when the table pre-existed without its head row.
SET @m2_has_head_row = (SELECT COUNT(*) FROM audit_chain_head
  WHERE id = 'audit-chain-head');

SET @m2_seed_head_sql = IF(@m2_has_head_row = 0,
  CONCAT('INSERT INTO audit_chain_head (id, head_seq, head_entry_hash, head_row_id)
    SELECT ''audit-chain-head'', 0, ', @m2_head_hash_expr, ', ', @m2_head_row_expr),
  'SELECT 1');
PREPARE m2_stmt_seed_head FROM @m2_seed_head_sql;
EXECUTE m2_stmt_seed_head;
DEALLOCATE PREPARE m2_stmt_seed_head;
