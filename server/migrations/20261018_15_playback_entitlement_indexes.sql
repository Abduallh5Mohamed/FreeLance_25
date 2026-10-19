-- =============================================================================
-- M3 V3 — playback_entitlements session lookup indexes
-- Task:    m3-server-playback-entitlement-indexes-20261018-15
-- Batch:   m3-server-video-20261018
-- Date:    2026-10-18
-- Scope:   Delivery-time entitlement reads hit playback_entitlements by
--          session_id on every manifest / media / segment / key request, but
--          the owning migration (20261018_06_video_assets_entitlements.sql)
--          indexes only (tenant_id) and (expires_at, revoked_at). This file
--          adds the indexes the lookups actually use.
--
-- QUERIES SERVED (read-only source; this file is authoring-only and does not
-- run them)
--   server/src/services/playback-entitlement.ts
--     findBySessionId: SELECT ... FROM playback_entitlements
--                      WHERE session_id = ? ORDER BY issued_at DESC LIMIT 100
--     load / isRevoked: WHERE jti = ?             (PRIMARY KEY covers jti)
--     revoke:           WHERE jti = ? AND revoked_at IS NULL
--
-- INDEXES
--   idx_playback_entitlements_session (session_id, issued_at)
--     The leftmost prefix session_id serves the equality filter; the trailing
--     issued_at serves ORDER BY issued_at DESC, avoiding a filesort.
--   idx_playback_entitlements_tenant_session (tenant_id, session_id, revoked_at)
--     Tenant-scoped session / revocation sweeps.
--
-- IDEMPOTENCY
--   Every statement is wrapped in an INFORMATION_SCHEMA probe plus
--   PREPARE/EXECUTE, so re-running this file is a no-op. It performs no
--   destructive DDL, rewrites no row, and touches no existing index.
--
-- !! AUTHORING-ONLY. SQL EXECUTION and live/bootstrap validation are OUT OF
--    SCOPE for this batch and require a separately approved isolated
--    bootstrap + live verification step. Do not run here.
-- =============================================================================

SET @m3_has_playback_entitlements = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.TABLES
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'playback_entitlements');

-- -----------------------------------------------------------------------------
-- Step 1: delivery-time session lookup (session_id equality + issued_at sort).
-- -----------------------------------------------------------------------------
SET @m3_idx_session_exists = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.STATISTICS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'playback_entitlements'
    AND INDEX_NAME = 'idx_playback_entitlements_session');

SET @m3_sql_session = IF(@m3_has_playback_entitlements = 1 AND @m3_idx_session_exists = 0,
  'ALTER TABLE playback_entitlements ADD INDEX idx_playback_entitlements_session (session_id, issued_at)',
  'SELECT 1');
PREPARE m3_stmt_session FROM @m3_sql_session;
EXECUTE m3_stmt_session;
DEALLOCATE PREPARE m3_stmt_session;

-- -----------------------------------------------------------------------------
-- Step 2: tenant-scoped session/revocation sweep index.
-- -----------------------------------------------------------------------------
SET @m3_idx_tenant_session_exists = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.STATISTICS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'playback_entitlements'
    AND INDEX_NAME = 'idx_playback_entitlements_tenant_session');

SET @m3_sql_tenant_session = IF(@m3_has_playback_entitlements = 1 AND @m3_idx_tenant_session_exists = 0,
  'ALTER TABLE playback_entitlements ADD INDEX idx_playback_entitlements_tenant_session (tenant_id, session_id, revoked_at)',
  'SELECT 1');
PREPARE m3_stmt_tenant_session FROM @m3_sql_tenant_session;
EXECUTE m3_stmt_tenant_session;
DEALLOCATE PREPARE m3_stmt_tenant_session;
