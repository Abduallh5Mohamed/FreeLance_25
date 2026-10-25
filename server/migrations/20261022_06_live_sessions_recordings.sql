-- =============================================================================
-- WL — live sessions, participants, callbacks, recording ingests, presence
-- Task:    WL (sole writer; source DDL only, never executed)
-- Date:    2026-10-22
-- Purpose: storage for the WorkBuddy live contract v2:
--   live_sessions, live_session_participants, live_session_callbacks,
--   live_recording_ingests, live_session_presence_intervals.
--
-- SCOPE / PROVENANCE
--   Every timestamp is a BIGINT UTC epoch in milliseconds. Every table carries
--   tenant_id and a FK to the proven tenants(id) CHAR(36) PK. Child tables use
--   composite tenant FKs into live_sessions (tenant_id, id); the presence table
--   uses a composite tenant/session FK into live_session_participants
--   (tenant_id, session_id, id). All identifiers are CHAR(36) like the frozen
--   tenant tables; the charset/collation matches them (utf8mb4 /
--   utf8mb4_unicode_ci).
--
--   R13 is ADAPTER SQL, not DDL: claimPending and the guarded finalize CAS
--   statements are documented in
--   docs/streams/server/CL-E-LIVE-SCHEMA-20261022.md, never executed here.
--   The CHECKs below make an owner-without-expiry lease and a terminal row
--   that still holds a lease unrepresentable.
--
-- OWNERSHIP
--   No legacy table is altered, dropped, renamed or backfilled. No branch or
--   course scope is invented: the v2 contract does not declare one, so the
--   question is held in CL-E instead of being guessed.
--
-- IDEMPOTENCY / PROBE-RECOMPUTE RULE
--   CREATE TABLE IF NOT EXISTS covers the clean path. Every additive mutation
--   on a partially created catalog is guarded by an INFORMATION_SCHEMA probe
--   and PREPARE/EXECUTE, so a re-run is a no-op. Index existence uses
--   COUNT(DISTINCT INDEX_NAME) because INFORMATION_SCHEMA.STATISTICS holds one
--   row PER INDEX COLUMN. Any guard that depends on a column added earlier in
--   this file re-probes the catalog AFTER that ADD (the `*_a` variables).
--   There is NO SIGNAL, no DROP, no TRUNCATE, no DELETE/UPDATE of data, no
--   FOREIGN_KEY_CHECKS manipulation and no runtime DDL. Column TYPES of a
--   pre-existing partial table are not rewritten; only absent columns,
--   checks, indexes and FKs are added.
--
-- !! THIS FILE IS AUTHORING-ONLY SOURCE DDL. No statement here is executed,
--    no database is connected to, and manifest registration is owned by Codex.
--    The registered test file server/tests/live-schema-contract.test.ts is NOT
--    written here (source-only correction gate).
-- =============================================================================

SET @wl_db = DATABASE();

-- -----------------------------------------------------------------------------
-- Table 1: live_sessions — one host-owned live room.
--   ended_at_ms is written ONLY together with state='ended' (CHECK).
--   UNIQUE (provider, provider_room_id) permits repeated NULL pairs.
--   UNIQUE (tenant_id, id) is the parent key for every composite tenant FK and
--   is deliberately redundant with the PK for tenant-safe references.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS live_sessions (
    id CHAR(36) NOT NULL COMMENT 'Live session identity',
    tenant_id CHAR(36) NOT NULL COMMENT 'Tenant scope',
    host_user_id CHAR(36) NOT NULL COMMENT 'Host principal (users.id); FK intentionally not declared by contract v2',
    title VARCHAR(200) NOT NULL,
    state ENUM('scheduled','live','ended','cancelled') NOT NULL DEFAULT 'scheduled',
    provider VARCHAR(128) NULL COMMENT 'Live provider name; NULL until a room is provisioned',
    provider_room_id VARCHAR(128) NULL COMMENT 'Provider room identity; NULL until provisioned',
    starts_at_ms BIGINT NOT NULL COMMENT 'UTC epoch milliseconds',
    ended_at_ms BIGINT NULL COMMENT 'UTC epoch milliseconds; non-NULL iff state = ended',
    max_participants INT UNSIGNED NOT NULL,
    created_at_ms BIGINT NOT NULL COMMENT 'UTC epoch milliseconds',
    PRIMARY KEY (id),
    UNIQUE KEY uq_live_session_id_tenant (tenant_id, id),
    UNIQUE KEY uq_live_session_room (provider, provider_room_id),
    KEY idx_live_sessions_tenant (tenant_id, state, starts_at_ms),
    CONSTRAINT fk_live_session_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id),
    CONSTRAINT chk_live_session_ended CHECK ((state = 'ended') = (ended_at_ms IS NOT NULL)),
    CONSTRAINT chk_live_session_max_participants CHECK (max_participants BETWEEN 1 AND 5000)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  COMMENT 'WL live session header; ended_at_ms is bound to state=ended';

SET @ls_has = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.TABLES
    WHERE TABLE_SCHEMA = @wl_db AND TABLE_NAME = 'live_sessions');

-- Missing-column guards (clean path: all present, each guard is SELECT 1).
SET @ls_c_id = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA = @wl_db AND TABLE_NAME = 'live_sessions' AND COLUMN_NAME = 'id');
SET @wl_sql = IF(@ls_has = 1 AND @ls_c_id = 0,
    'ALTER TABLE live_sessions ADD COLUMN id CHAR(36) NOT NULL',
    'SELECT 1');
PREPARE wl_stmt FROM @wl_sql;
EXECUTE wl_stmt;
DEALLOCATE PREPARE wl_stmt;

SET @ls_c_tenant = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA = @wl_db AND TABLE_NAME = 'live_sessions' AND COLUMN_NAME = 'tenant_id');
SET @wl_sql = IF(@ls_has = 1 AND @ls_c_tenant = 0,
    'ALTER TABLE live_sessions ADD COLUMN tenant_id CHAR(36) NOT NULL',
    'SELECT 1');
PREPARE wl_stmt FROM @wl_sql;
EXECUTE wl_stmt;
DEALLOCATE PREPARE wl_stmt;

SET @ls_c_host = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA = @wl_db AND TABLE_NAME = 'live_sessions' AND COLUMN_NAME = 'host_user_id');
SET @wl_sql = IF(@ls_has = 1 AND @ls_c_host = 0,
    'ALTER TABLE live_sessions ADD COLUMN host_user_id CHAR(36) NOT NULL',
    'SELECT 1');
PREPARE wl_stmt FROM @wl_sql;
EXECUTE wl_stmt;
DEALLOCATE PREPARE wl_stmt;

SET @ls_c_title = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA = @wl_db AND TABLE_NAME = 'live_sessions' AND COLUMN_NAME = 'title');
SET @wl_sql = IF(@ls_has = 1 AND @ls_c_title = 0,
    'ALTER TABLE live_sessions ADD COLUMN title VARCHAR(200) NOT NULL',
    'SELECT 1');
PREPARE wl_stmt FROM @wl_sql;
EXECUTE wl_stmt;
DEALLOCATE PREPARE wl_stmt;

SET @ls_c_state = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA = @wl_db AND TABLE_NAME = 'live_sessions' AND COLUMN_NAME = 'state');
SET @wl_sql = IF(@ls_has = 1 AND @ls_c_state = 0,
    "ALTER TABLE live_sessions ADD COLUMN state ENUM('scheduled','live','ended','cancelled') NOT NULL DEFAULT 'scheduled'",
    'SELECT 1');
PREPARE wl_stmt FROM @wl_sql;
EXECUTE wl_stmt;
DEALLOCATE PREPARE wl_stmt;

SET @ls_c_provider = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA = @wl_db AND TABLE_NAME = 'live_sessions' AND COLUMN_NAME = 'provider');
SET @wl_sql = IF(@ls_has = 1 AND @ls_c_provider = 0,
    'ALTER TABLE live_sessions ADD COLUMN provider VARCHAR(128) NULL',
    'SELECT 1');
PREPARE wl_stmt FROM @wl_sql;
EXECUTE wl_stmt;
DEALLOCATE PREPARE wl_stmt;

SET @ls_c_room = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA = @wl_db AND TABLE_NAME = 'live_sessions' AND COLUMN_NAME = 'provider_room_id');
SET @wl_sql = IF(@ls_has = 1 AND @ls_c_room = 0,
    'ALTER TABLE live_sessions ADD COLUMN provider_room_id VARCHAR(128) NULL',
    'SELECT 1');
PREPARE wl_stmt FROM @wl_sql;
EXECUTE wl_stmt;
DEALLOCATE PREPARE wl_stmt;

SET @ls_c_starts = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA = @wl_db AND TABLE_NAME = 'live_sessions' AND COLUMN_NAME = 'starts_at_ms');
SET @wl_sql = IF(@ls_has = 1 AND @ls_c_starts = 0,
    'ALTER TABLE live_sessions ADD COLUMN starts_at_ms BIGINT NOT NULL',
    'SELECT 1');
PREPARE wl_stmt FROM @wl_sql;
EXECUTE wl_stmt;
DEALLOCATE PREPARE wl_stmt;

SET @ls_c_ended = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA = @wl_db AND TABLE_NAME = 'live_sessions' AND COLUMN_NAME = 'ended_at_ms');
SET @wl_sql = IF(@ls_has = 1 AND @ls_c_ended = 0,
    'ALTER TABLE live_sessions ADD COLUMN ended_at_ms BIGINT NULL',
    'SELECT 1');
PREPARE wl_stmt FROM @wl_sql;
EXECUTE wl_stmt;
DEALLOCATE PREPARE wl_stmt;

SET @ls_c_max = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA = @wl_db AND TABLE_NAME = 'live_sessions' AND COLUMN_NAME = 'max_participants');
SET @wl_sql = IF(@ls_has = 1 AND @ls_c_max = 0,
    'ALTER TABLE live_sessions ADD COLUMN max_participants INT UNSIGNED NOT NULL',
    'SELECT 1');
PREPARE wl_stmt FROM @wl_sql;
EXECUTE wl_stmt;
DEALLOCATE PREPARE wl_stmt;

SET @ls_c_created = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA = @wl_db AND TABLE_NAME = 'live_sessions' AND COLUMN_NAME = 'created_at_ms');
SET @wl_sql = IF(@ls_has = 1 AND @ls_c_created = 0,
    'ALTER TABLE live_sessions ADD COLUMN created_at_ms BIGINT NOT NULL',
    'SELECT 1');
PREPARE wl_stmt FROM @wl_sql;
EXECUTE wl_stmt;
DEALLOCATE PREPARE wl_stmt;

-- Fresh column probes AFTER every ADD above (probe-recompute rule).
SET @ls_a_id = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA = @wl_db AND TABLE_NAME = 'live_sessions' AND COLUMN_NAME = 'id');
SET @ls_a_tenant = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA = @wl_db AND TABLE_NAME = 'live_sessions' AND COLUMN_NAME = 'tenant_id');
SET @ls_a_state = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA = @wl_db AND TABLE_NAME = 'live_sessions' AND COLUMN_NAME = 'state');
SET @ls_a_starts = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA = @wl_db AND TABLE_NAME = 'live_sessions' AND COLUMN_NAME = 'starts_at_ms');
SET @ls_a_ended = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA = @wl_db AND TABLE_NAME = 'live_sessions' AND COLUMN_NAME = 'ended_at_ms');
SET @ls_a_max = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA = @wl_db AND TABLE_NAME = 'live_sessions' AND COLUMN_NAME = 'max_participants');
SET @ls_a_provider = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA = @wl_db AND TABLE_NAME = 'live_sessions' AND COLUMN_NAME = 'provider');
SET @ls_a_room = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA = @wl_db AND TABLE_NAME = 'live_sessions' AND COLUMN_NAME = 'provider_room_id');

-- Primary key (only when the partial catalog has none).
SET @ls_has_pk = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.STATISTICS
    WHERE TABLE_SCHEMA = @wl_db AND TABLE_NAME = 'live_sessions' AND INDEX_NAME = 'PRIMARY');
SET @wl_sql = IF(@ls_has = 1 AND @ls_a_id = 1 AND @ls_has_pk = 0,
    'ALTER TABLE live_sessions ADD PRIMARY KEY (id)',
    'SELECT 1');
PREPARE wl_stmt FROM @wl_sql;
EXECUTE wl_stmt;
DEALLOCATE PREPARE wl_stmt;

-- Parent key for composite tenant FKs.
SET @ls_has_uq_id_tenant = (SELECT COUNT(DISTINCT INDEX_NAME) FROM INFORMATION_SCHEMA.STATISTICS
    WHERE TABLE_SCHEMA = @wl_db AND TABLE_NAME = 'live_sessions'
      AND INDEX_NAME = 'uq_live_session_id_tenant');
SET @wl_sql = IF(@ls_has = 1 AND @ls_a_id = 1 AND @ls_a_tenant = 1 AND @ls_has_uq_id_tenant = 0,
    'ALTER TABLE live_sessions ADD UNIQUE KEY uq_live_session_id_tenant (tenant_id, id)',
    'SELECT 1');
PREPARE wl_stmt FROM @wl_sql;
EXECUTE wl_stmt;
DEALLOCATE PREPARE wl_stmt;

-- Provider room uniqueness; repeated NULL pairs are permitted by MySQL.
SET @ls_has_uq_room = (SELECT COUNT(DISTINCT INDEX_NAME) FROM INFORMATION_SCHEMA.STATISTICS
    WHERE TABLE_SCHEMA = @wl_db AND TABLE_NAME = 'live_sessions'
      AND INDEX_NAME = 'uq_live_session_room');
SET @wl_sql = IF(@ls_has = 1 AND @ls_a_provider = 1 AND @ls_a_room = 1 AND @ls_has_uq_room = 0,
    'ALTER TABLE live_sessions ADD UNIQUE KEY uq_live_session_room (provider, provider_room_id)',
    'SELECT 1');
PREPARE wl_stmt FROM @wl_sql;
EXECUTE wl_stmt;
DEALLOCATE PREPARE wl_stmt;

-- Tenant/state/time read path.
SET @ls_has_idx_tenant = (SELECT COUNT(DISTINCT INDEX_NAME) FROM INFORMATION_SCHEMA.STATISTICS
    WHERE TABLE_SCHEMA = @wl_db AND TABLE_NAME = 'live_sessions'
      AND INDEX_NAME = 'idx_live_sessions_tenant');
SET @wl_sql = IF(@ls_has = 1 AND @ls_a_tenant = 1 AND @ls_a_state = 1 AND @ls_a_starts = 1 AND @ls_has_idx_tenant = 0,
    'ALTER TABLE live_sessions ADD INDEX idx_live_sessions_tenant (tenant_id, state, starts_at_ms)',
    'SELECT 1');
PREPARE wl_stmt FROM @wl_sql;
EXECUTE wl_stmt;
DEALLOCATE PREPARE wl_stmt;

-- Tenant FK.
SET @ls_has_fk_tenant = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.TABLE_CONSTRAINTS
    WHERE CONSTRAINT_SCHEMA = @wl_db AND TABLE_NAME = 'live_sessions'
      AND CONSTRAINT_NAME = 'fk_live_session_tenant');
SET @wl_sql = IF(@ls_has = 1 AND @ls_a_tenant = 1 AND @ls_has_fk_tenant = 0,
    'ALTER TABLE live_sessions ADD CONSTRAINT fk_live_session_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id)',
    'SELECT 1');
PREPARE wl_stmt FROM @wl_sql;
EXECUTE wl_stmt;
DEALLOCATE PREPARE wl_stmt;

-- ended_at_ms is non-NULL iff the state is ended.
SET @ls_has_chk_ended = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.TABLE_CONSTRAINTS
    WHERE CONSTRAINT_SCHEMA = @wl_db AND TABLE_NAME = 'live_sessions'
      AND CONSTRAINT_NAME = 'chk_live_session_ended');
SET @wl_sql = IF(@ls_has = 1 AND @ls_a_state = 1 AND @ls_a_ended = 1 AND @ls_has_chk_ended = 0,
    "ALTER TABLE live_sessions ADD CONSTRAINT chk_live_session_ended CHECK ((state = 'ended') = (ended_at_ms IS NOT NULL))",
    'SELECT 1');
PREPARE wl_stmt FROM @wl_sql;
EXECUTE wl_stmt;
DEALLOCATE PREPARE wl_stmt;

-- Bounded participant count.
SET @ls_has_chk_max = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.TABLE_CONSTRAINTS
    WHERE CONSTRAINT_SCHEMA = @wl_db AND TABLE_NAME = 'live_sessions'
      AND CONSTRAINT_NAME = 'chk_live_session_max_participants');
SET @wl_sql = IF(@ls_has = 1 AND @ls_a_max = 1 AND @ls_has_chk_max = 0,
    'ALTER TABLE live_sessions ADD CONSTRAINT chk_live_session_max_participants CHECK (max_participants BETWEEN 1 AND 5000)',
    'SELECT 1');
PREPARE wl_stmt FROM @wl_sql;
EXECUTE wl_stmt;
DEALLOCATE PREPARE wl_stmt;

-- -----------------------------------------------------------------------------
-- Table 2: live_session_participants — one row per (session, user).
--   left_at_ms NULL means active. The composite FK is tenant-safe, so a
--   participant can never point at another tenant's session.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS live_session_participants (
    id CHAR(36) NOT NULL,
    tenant_id CHAR(36) NOT NULL,
    session_id CHAR(36) NOT NULL,
    user_id CHAR(36) NOT NULL,
    role ENUM('host','cohost','participant') NOT NULL,
    ticket_fingerprint CHAR(64) NOT NULL COMMENT 'Lowercase SHA-256 of the join ticket; the raw ticket is never stored',
    joined_at_ms BIGINT NOT NULL COMMENT 'UTC epoch milliseconds',
    last_seen_at_ms BIGINT NOT NULL COMMENT 'UTC epoch milliseconds',
    left_at_ms BIGINT NULL COMMENT 'UTC epoch milliseconds; NULL while active',
    PRIMARY KEY (id),
    UNIQUE KEY uq_live_participant (session_id, user_id),
    UNIQUE KEY uq_live_participant_tenant (tenant_id, session_id, id),
    KEY idx_live_participant_active (session_id, left_at_ms),
    CONSTRAINT fk_live_participant_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id),
    CONSTRAINT fk_live_participant_session FOREIGN KEY (tenant_id, session_id) REFERENCES live_sessions (tenant_id, id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  COMMENT 'WL session participants; ticket fingerprint only, composite tenant FK to the session';

SET @lp_has = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.TABLES
    WHERE TABLE_SCHEMA = @wl_db AND TABLE_NAME = 'live_session_participants');

SET @lp_c_id = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA = @wl_db AND TABLE_NAME = 'live_session_participants' AND COLUMN_NAME = 'id');
SET @wl_sql = IF(@lp_has = 1 AND @lp_c_id = 0,
    'ALTER TABLE live_session_participants ADD COLUMN id CHAR(36) NOT NULL',
    'SELECT 1');
PREPARE wl_stmt FROM @wl_sql;
EXECUTE wl_stmt;
DEALLOCATE PREPARE wl_stmt;

SET @lp_c_tenant = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA = @wl_db AND TABLE_NAME = 'live_session_participants' AND COLUMN_NAME = 'tenant_id');
SET @wl_sql = IF(@lp_has = 1 AND @lp_c_tenant = 0,
    'ALTER TABLE live_session_participants ADD COLUMN tenant_id CHAR(36) NOT NULL',
    'SELECT 1');
PREPARE wl_stmt FROM @wl_sql;
EXECUTE wl_stmt;
DEALLOCATE PREPARE wl_stmt;

SET @lp_c_session = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA = @wl_db AND TABLE_NAME = 'live_session_participants' AND COLUMN_NAME = 'session_id');
SET @wl_sql = IF(@lp_has = 1 AND @lp_c_session = 0,
    'ALTER TABLE live_session_participants ADD COLUMN session_id CHAR(36) NOT NULL',
    'SELECT 1');
PREPARE wl_stmt FROM @wl_sql;
EXECUTE wl_stmt;
DEALLOCATE PREPARE wl_stmt;

SET @lp_c_user = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA = @wl_db AND TABLE_NAME = 'live_session_participants' AND COLUMN_NAME = 'user_id');
SET @wl_sql = IF(@lp_has = 1 AND @lp_c_user = 0,
    'ALTER TABLE live_session_participants ADD COLUMN user_id CHAR(36) NOT NULL',
    'SELECT 1');
PREPARE wl_stmt FROM @wl_sql;
EXECUTE wl_stmt;
DEALLOCATE PREPARE wl_stmt;

SET @lp_c_role = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA = @wl_db AND TABLE_NAME = 'live_session_participants' AND COLUMN_NAME = 'role');
SET @wl_sql = IF(@lp_has = 1 AND @lp_c_role = 0,
    "ALTER TABLE live_session_participants ADD COLUMN role ENUM('host','cohost','participant') NOT NULL",
    'SELECT 1');
PREPARE wl_stmt FROM @wl_sql;
EXECUTE wl_stmt;
DEALLOCATE PREPARE wl_stmt;

SET @lp_c_ticket = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA = @wl_db AND TABLE_NAME = 'live_session_participants' AND COLUMN_NAME = 'ticket_fingerprint');
SET @wl_sql = IF(@lp_has = 1 AND @lp_c_ticket = 0,
    'ALTER TABLE live_session_participants ADD COLUMN ticket_fingerprint CHAR(64) NOT NULL',
    'SELECT 1');
PREPARE wl_stmt FROM @wl_sql;
EXECUTE wl_stmt;
DEALLOCATE PREPARE wl_stmt;

SET @lp_c_joined = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA = @wl_db AND TABLE_NAME = 'live_session_participants' AND COLUMN_NAME = 'joined_at_ms');
SET @wl_sql = IF(@lp_has = 1 AND @lp_c_joined = 0,
    'ALTER TABLE live_session_participants ADD COLUMN joined_at_ms BIGINT NOT NULL',
    'SELECT 1');
PREPARE wl_stmt FROM @wl_sql;
EXECUTE wl_stmt;
DEALLOCATE PREPARE wl_stmt;

SET @lp_c_seen = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA = @wl_db AND TABLE_NAME = 'live_session_participants' AND COLUMN_NAME = 'last_seen_at_ms');
SET @wl_sql = IF(@lp_has = 1 AND @lp_c_seen = 0,
    'ALTER TABLE live_session_participants ADD COLUMN last_seen_at_ms BIGINT NOT NULL',
    'SELECT 1');
PREPARE wl_stmt FROM @wl_sql;
EXECUTE wl_stmt;
DEALLOCATE PREPARE wl_stmt;

SET @lp_c_left = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA = @wl_db AND TABLE_NAME = 'live_session_participants' AND COLUMN_NAME = 'left_at_ms');
SET @wl_sql = IF(@lp_has = 1 AND @lp_c_left = 0,
    'ALTER TABLE live_session_participants ADD COLUMN left_at_ms BIGINT NULL',
    'SELECT 1');
PREPARE wl_stmt FROM @wl_sql;
EXECUTE wl_stmt;
DEALLOCATE PREPARE wl_stmt;

-- Fresh column probes AFTER every ADD above.
SET @lp_a_id = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA = @wl_db AND TABLE_NAME = 'live_session_participants' AND COLUMN_NAME = 'id');
SET @lp_a_tenant = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA = @wl_db AND TABLE_NAME = 'live_session_participants' AND COLUMN_NAME = 'tenant_id');
SET @lp_a_session = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA = @wl_db AND TABLE_NAME = 'live_session_participants' AND COLUMN_NAME = 'session_id');
SET @lp_a_user = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA = @wl_db AND TABLE_NAME = 'live_session_participants' AND COLUMN_NAME = 'user_id');
SET @lp_a_left = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA = @wl_db AND TABLE_NAME = 'live_session_participants' AND COLUMN_NAME = 'left_at_ms');

SET @lp_has_pk = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.STATISTICS
    WHERE TABLE_SCHEMA = @wl_db AND TABLE_NAME = 'live_session_participants' AND INDEX_NAME = 'PRIMARY');
SET @wl_sql = IF(@lp_has = 1 AND @lp_a_id = 1 AND @lp_has_pk = 0,
    'ALTER TABLE live_session_participants ADD PRIMARY KEY (id)',
    'SELECT 1');
PREPARE wl_stmt FROM @wl_sql;
EXECUTE wl_stmt;
DEALLOCATE PREPARE wl_stmt;

SET @lp_has_uq = (SELECT COUNT(DISTINCT INDEX_NAME) FROM INFORMATION_SCHEMA.STATISTICS
    WHERE TABLE_SCHEMA = @wl_db AND TABLE_NAME = 'live_session_participants'
      AND INDEX_NAME = 'uq_live_participant');
SET @wl_sql = IF(@lp_has = 1 AND @lp_a_session = 1 AND @lp_a_user = 1 AND @lp_has_uq = 0,
    'ALTER TABLE live_session_participants ADD UNIQUE KEY uq_live_participant (session_id, user_id)',
    'SELECT 1');
PREPARE wl_stmt FROM @wl_sql;
EXECUTE wl_stmt;
DEALLOCATE PREPARE wl_stmt;

SET @lp_has_uq_tenant = (SELECT COUNT(DISTINCT INDEX_NAME) FROM INFORMATION_SCHEMA.STATISTICS
    WHERE TABLE_SCHEMA = @wl_db AND TABLE_NAME = 'live_session_participants'
      AND INDEX_NAME = 'uq_live_participant_tenant');
SET @wl_sql = IF(@lp_has = 1 AND @lp_a_tenant = 1 AND @lp_a_session = 1 AND @lp_a_id = 1 AND @lp_has_uq_tenant = 0,
    'ALTER TABLE live_session_participants ADD UNIQUE KEY uq_live_participant_tenant (tenant_id, session_id, id)',
    'SELECT 1');
PREPARE wl_stmt FROM @wl_sql;
EXECUTE wl_stmt;
DEALLOCATE PREPARE wl_stmt;

SET @lp_has_idx_active = (SELECT COUNT(DISTINCT INDEX_NAME) FROM INFORMATION_SCHEMA.STATISTICS
    WHERE TABLE_SCHEMA = @wl_db AND TABLE_NAME = 'live_session_participants'
      AND INDEX_NAME = 'idx_live_participant_active');
SET @wl_sql = IF(@lp_has = 1 AND @lp_a_session = 1 AND @lp_a_left = 1 AND @lp_has_idx_active = 0,
    'ALTER TABLE live_session_participants ADD INDEX idx_live_participant_active (session_id, left_at_ms)',
    'SELECT 1');
PREPARE wl_stmt FROM @wl_sql;
EXECUTE wl_stmt;
DEALLOCATE PREPARE wl_stmt;

SET @lp_has_fk_tenant = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.TABLE_CONSTRAINTS
    WHERE CONSTRAINT_SCHEMA = @wl_db AND TABLE_NAME = 'live_session_participants'
      AND CONSTRAINT_NAME = 'fk_live_participant_tenant');
SET @wl_sql = IF(@lp_has = 1 AND @lp_a_tenant = 1 AND @lp_has_fk_tenant = 0,
    'ALTER TABLE live_session_participants ADD CONSTRAINT fk_live_participant_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id)',
    'SELECT 1');
PREPARE wl_stmt FROM @wl_sql;
EXECUTE wl_stmt;
DEALLOCATE PREPARE wl_stmt;

SET @lp_has_fk_session = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.TABLE_CONSTRAINTS
    WHERE CONSTRAINT_SCHEMA = @wl_db AND TABLE_NAME = 'live_session_participants'
      AND CONSTRAINT_NAME = 'fk_live_participant_session');
SET @wl_sql = IF(@lp_has = 1 AND @lp_a_tenant = 1 AND @lp_a_session = 1 AND @lp_has_fk_session = 0,
    'ALTER TABLE live_session_participants ADD CONSTRAINT fk_live_participant_session FOREIGN KEY (tenant_id, session_id) REFERENCES live_sessions (tenant_id, id) ON DELETE RESTRICT',
    'SELECT 1');
PREPARE wl_stmt FROM @wl_sql;
EXECUTE wl_stmt;
DEALLOCATE PREPARE wl_stmt;

-- -----------------------------------------------------------------------------
-- Table 3: live_session_callbacks — durable, tenant-scoped callback ledger.
--   (tenant_id, provider, event_id) is the replay arbiter ('pending' is the
--   transient state; the four terminal outcomes are enforced by CHECK).
--   tenant_id is the SESSION row's tenant, enforced by the composite FK.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS live_session_callbacks (
    id CHAR(36) NOT NULL,
    tenant_id CHAR(36) NOT NULL,
    session_id CHAR(36) NOT NULL,
    provider VARCHAR(128) NOT NULL,
    event_id VARCHAR(128) NOT NULL,
    kind VARCHAR(32) NOT NULL,
    occurred_at_ms BIGINT NOT NULL COMMENT 'UTC epoch milliseconds',
    outcome VARCHAR(48) NOT NULL COMMENT 'pending is transient; terminal values are applied, rejected:illegal-transition, ignored:unknown-participant, ignored:malformed',
    PRIMARY KEY (id),
    UNIQUE KEY uq_live_callback (tenant_id, provider, event_id),
    KEY idx_live_callback_session (tenant_id, session_id),
    CONSTRAINT fk_live_callback_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id),
    CONSTRAINT fk_live_callback_session FOREIGN KEY (tenant_id, session_id) REFERENCES live_sessions (tenant_id, id) ON DELETE RESTRICT,
    CONSTRAINT chk_live_callback_outcome CHECK (outcome IN ('pending','applied','rejected:illegal-transition','ignored:unknown-participant','ignored:malformed'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  COMMENT 'WL durable provider callback ledger; dedupe per (tenant, provider, event)';

SET @lc_has = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.TABLES
    WHERE TABLE_SCHEMA = @wl_db AND TABLE_NAME = 'live_session_callbacks');

SET @lc_c_id = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA = @wl_db AND TABLE_NAME = 'live_session_callbacks' AND COLUMN_NAME = 'id');
SET @wl_sql = IF(@lc_has = 1 AND @lc_c_id = 0,
    'ALTER TABLE live_session_callbacks ADD COLUMN id CHAR(36) NOT NULL',
    'SELECT 1');
PREPARE wl_stmt FROM @wl_sql;
EXECUTE wl_stmt;
DEALLOCATE PREPARE wl_stmt;

SET @lc_c_tenant = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA = @wl_db AND TABLE_NAME = 'live_session_callbacks' AND COLUMN_NAME = 'tenant_id');
SET @wl_sql = IF(@lc_has = 1 AND @lc_c_tenant = 0,
    'ALTER TABLE live_session_callbacks ADD COLUMN tenant_id CHAR(36) NOT NULL',
    'SELECT 1');
PREPARE wl_stmt FROM @wl_sql;
EXECUTE wl_stmt;
DEALLOCATE PREPARE wl_stmt;

SET @lc_c_session = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA = @wl_db AND TABLE_NAME = 'live_session_callbacks' AND COLUMN_NAME = 'session_id');
SET @wl_sql = IF(@lc_has = 1 AND @lc_c_session = 0,
    'ALTER TABLE live_session_callbacks ADD COLUMN session_id CHAR(36) NOT NULL',
    'SELECT 1');
PREPARE wl_stmt FROM @wl_sql;
EXECUTE wl_stmt;
DEALLOCATE PREPARE wl_stmt;

SET @lc_c_provider = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA = @wl_db AND TABLE_NAME = 'live_session_callbacks' AND COLUMN_NAME = 'provider');
SET @wl_sql = IF(@lc_has = 1 AND @lc_c_provider = 0,
    'ALTER TABLE live_session_callbacks ADD COLUMN provider VARCHAR(128) NOT NULL',
    'SELECT 1');
PREPARE wl_stmt FROM @wl_sql;
EXECUTE wl_stmt;
DEALLOCATE PREPARE wl_stmt;

SET @lc_c_event = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA = @wl_db AND TABLE_NAME = 'live_session_callbacks' AND COLUMN_NAME = 'event_id');
SET @wl_sql = IF(@lc_has = 1 AND @lc_c_event = 0,
    'ALTER TABLE live_session_callbacks ADD COLUMN event_id VARCHAR(128) NOT NULL',
    'SELECT 1');
PREPARE wl_stmt FROM @wl_sql;
EXECUTE wl_stmt;
DEALLOCATE PREPARE wl_stmt;

SET @lc_c_kind = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA = @wl_db AND TABLE_NAME = 'live_session_callbacks' AND COLUMN_NAME = 'kind');
SET @wl_sql = IF(@lc_has = 1 AND @lc_c_kind = 0,
    'ALTER TABLE live_session_callbacks ADD COLUMN kind VARCHAR(32) NOT NULL',
    'SELECT 1');
PREPARE wl_stmt FROM @wl_sql;
EXECUTE wl_stmt;
DEALLOCATE PREPARE wl_stmt;

SET @lc_c_occurred = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA = @wl_db AND TABLE_NAME = 'live_session_callbacks' AND COLUMN_NAME = 'occurred_at_ms');
SET @wl_sql = IF(@lc_has = 1 AND @lc_c_occurred = 0,
    'ALTER TABLE live_session_callbacks ADD COLUMN occurred_at_ms BIGINT NOT NULL',
    'SELECT 1');
PREPARE wl_stmt FROM @wl_sql;
EXECUTE wl_stmt;
DEALLOCATE PREPARE wl_stmt;

SET @lc_c_outcome = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA = @wl_db AND TABLE_NAME = 'live_session_callbacks' AND COLUMN_NAME = 'outcome');
SET @wl_sql = IF(@lc_has = 1 AND @lc_c_outcome = 0,
    'ALTER TABLE live_session_callbacks ADD COLUMN outcome VARCHAR(48) NOT NULL',
    'SELECT 1');
PREPARE wl_stmt FROM @wl_sql;
EXECUTE wl_stmt;
DEALLOCATE PREPARE wl_stmt;

-- Fresh column probes AFTER every ADD above.
SET @lc_a_id = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA = @wl_db AND TABLE_NAME = 'live_session_callbacks' AND COLUMN_NAME = 'id');
SET @lc_a_tenant = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA = @wl_db AND TABLE_NAME = 'live_session_callbacks' AND COLUMN_NAME = 'tenant_id');
SET @lc_a_session = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA = @wl_db AND TABLE_NAME = 'live_session_callbacks' AND COLUMN_NAME = 'session_id');
SET @lc_a_provider = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA = @wl_db AND TABLE_NAME = 'live_session_callbacks' AND COLUMN_NAME = 'provider');
SET @lc_a_event = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA = @wl_db AND TABLE_NAME = 'live_session_callbacks' AND COLUMN_NAME = 'event_id');
SET @lc_a_outcome = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA = @wl_db AND TABLE_NAME = 'live_session_callbacks' AND COLUMN_NAME = 'outcome');

SET @lc_has_pk = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.STATISTICS
    WHERE TABLE_SCHEMA = @wl_db AND TABLE_NAME = 'live_session_callbacks' AND INDEX_NAME = 'PRIMARY');
SET @wl_sql = IF(@lc_has = 1 AND @lc_a_id = 1 AND @lc_has_pk = 0,
    'ALTER TABLE live_session_callbacks ADD PRIMARY KEY (id)',
    'SELECT 1');
PREPARE wl_stmt FROM @wl_sql;
EXECUTE wl_stmt;
DEALLOCATE PREPARE wl_stmt;

SET @lc_has_uq = (SELECT COUNT(DISTINCT INDEX_NAME) FROM INFORMATION_SCHEMA.STATISTICS
    WHERE TABLE_SCHEMA = @wl_db AND TABLE_NAME = 'live_session_callbacks'
      AND INDEX_NAME = 'uq_live_callback');
SET @wl_sql = IF(@lc_has = 1 AND @lc_a_tenant = 1 AND @lc_a_provider = 1 AND @lc_a_event = 1 AND @lc_has_uq = 0,
    'ALTER TABLE live_session_callbacks ADD UNIQUE KEY uq_live_callback (tenant_id, provider, event_id)',
    'SELECT 1');
PREPARE wl_stmt FROM @wl_sql;
EXECUTE wl_stmt;
DEALLOCATE PREPARE wl_stmt;

SET @lc_has_idx = (SELECT COUNT(DISTINCT INDEX_NAME) FROM INFORMATION_SCHEMA.STATISTICS
    WHERE TABLE_SCHEMA = @wl_db AND TABLE_NAME = 'live_session_callbacks'
      AND INDEX_NAME = 'idx_live_callback_session');
SET @wl_sql = IF(@lc_has = 1 AND @lc_a_tenant = 1 AND @lc_a_session = 1 AND @lc_has_idx = 0,
    'ALTER TABLE live_session_callbacks ADD INDEX idx_live_callback_session (tenant_id, session_id)',
    'SELECT 1');
PREPARE wl_stmt FROM @wl_sql;
EXECUTE wl_stmt;
DEALLOCATE PREPARE wl_stmt;

SET @lc_has_fk_tenant = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.TABLE_CONSTRAINTS
    WHERE CONSTRAINT_SCHEMA = @wl_db AND TABLE_NAME = 'live_session_callbacks'
      AND CONSTRAINT_NAME = 'fk_live_callback_tenant');
SET @wl_sql = IF(@lc_has = 1 AND @lc_a_tenant = 1 AND @lc_has_fk_tenant = 0,
    'ALTER TABLE live_session_callbacks ADD CONSTRAINT fk_live_callback_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id)',
    'SELECT 1');
PREPARE wl_stmt FROM @wl_sql;
EXECUTE wl_stmt;
DEALLOCATE PREPARE wl_stmt;

SET @lc_has_fk_session = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.TABLE_CONSTRAINTS
    WHERE CONSTRAINT_SCHEMA = @wl_db AND TABLE_NAME = 'live_session_callbacks'
      AND CONSTRAINT_NAME = 'fk_live_callback_session');
SET @wl_sql = IF(@lc_has = 1 AND @lc_a_tenant = 1 AND @lc_a_session = 1 AND @lc_has_fk_session = 0,
    'ALTER TABLE live_session_callbacks ADD CONSTRAINT fk_live_callback_session FOREIGN KEY (tenant_id, session_id) REFERENCES live_sessions (tenant_id, id) ON DELETE RESTRICT',
    'SELECT 1');
PREPARE wl_stmt FROM @wl_sql;
EXECUTE wl_stmt;
DEALLOCATE PREPARE wl_stmt;

SET @lc_has_chk = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.TABLE_CONSTRAINTS
    WHERE CONSTRAINT_SCHEMA = @wl_db AND TABLE_NAME = 'live_session_callbacks'
      AND CONSTRAINT_NAME = 'chk_live_callback_outcome');
SET @wl_sql = IF(@lc_has = 1 AND @lc_a_outcome = 1 AND @lc_has_chk = 0,
    "ALTER TABLE live_session_callbacks ADD CONSTRAINT chk_live_callback_outcome CHECK (outcome IN ('pending','applied','rejected:illegal-transition','ignored:unknown-participant','ignored:malformed'))",
    'SELECT 1');
PREPARE wl_stmt FROM @wl_sql;
EXECUTE wl_stmt;
DEALLOCATE PREPARE wl_stmt;

-- -----------------------------------------------------------------------------
-- Table 4: live_recording_ingests — recording callback ingest with a fencing
--   lease (R12). claim_owner and claim_expires_at_ms are ALWAYS written
--   together: the two CHECKs make an owner without expiry unrepresentable and
--   force a terminal row to release the lease.
--   (tenant_id, provider, event_id) dedupes the callback; (tenant_id, provider,
--   provider_recording_id) dedupes the recording itself (R15 ingest-level key).
--   idx_live_ingest_pending is the R14 recovery path for the future sweep.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS live_recording_ingests (
    id CHAR(36) NOT NULL,
    tenant_id CHAR(36) NOT NULL,
    session_id CHAR(36) NOT NULL,
    provider VARCHAR(128) NOT NULL,
    event_id VARCHAR(128) NOT NULL,
    provider_recording_id VARCHAR(128) NOT NULL,
    duration_seconds INT UNSIGNED NOT NULL,
    storage_bytes BIGINT UNSIGNED NOT NULL,
    occurred_at_ms BIGINT NOT NULL COMMENT 'UTC epoch milliseconds',
    outcome VARCHAR(32) NOT NULL COMMENT 'pending is transient; terminal values are written by the adapter',
    claim_owner VARCHAR(64) NULL COMMENT 'R12 lease owner; NULL iff claim_expires_at_ms is NULL',
    claim_expires_at_ms BIGINT NULL COMMENT 'R12 lease expiry in UTC epoch milliseconds; NULL iff claim_owner is NULL',
    PRIMARY KEY (id),
    UNIQUE KEY uq_ingest_event (tenant_id, provider, event_id),
    UNIQUE KEY uq_ingest_recording (tenant_id, provider, provider_recording_id),
    KEY idx_live_ingest_pending (outcome, claim_expires_at_ms),
    KEY idx_live_ingest_session (tenant_id, session_id),
    CONSTRAINT fk_live_ingest_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id),
    CONSTRAINT fk_live_ingest_session FOREIGN KEY (tenant_id, session_id) REFERENCES live_sessions (tenant_id, id) ON DELETE RESTRICT,
    CONSTRAINT chk_live_ingest_lease_pair CHECK ((claim_owner IS NULL) = (claim_expires_at_ms IS NULL)),
    CONSTRAINT chk_live_ingest_terminal_release CHECK (outcome = 'pending' OR (claim_owner IS NULL AND claim_expires_at_ms IS NULL))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  COMMENT 'WL recording ingest ledger with R12 fencing lease and R14 pending index';

SET @li_has = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.TABLES
    WHERE TABLE_SCHEMA = @wl_db AND TABLE_NAME = 'live_recording_ingests');

SET @li_c_id = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA = @wl_db AND TABLE_NAME = 'live_recording_ingests' AND COLUMN_NAME = 'id');
SET @wl_sql = IF(@li_has = 1 AND @li_c_id = 0,
    'ALTER TABLE live_recording_ingests ADD COLUMN id CHAR(36) NOT NULL',
    'SELECT 1');
PREPARE wl_stmt FROM @wl_sql;
EXECUTE wl_stmt;
DEALLOCATE PREPARE wl_stmt;

SET @li_c_tenant = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA = @wl_db AND TABLE_NAME = 'live_recording_ingests' AND COLUMN_NAME = 'tenant_id');
SET @wl_sql = IF(@li_has = 1 AND @li_c_tenant = 0,
    'ALTER TABLE live_recording_ingests ADD COLUMN tenant_id CHAR(36) NOT NULL',
    'SELECT 1');
PREPARE wl_stmt FROM @wl_sql;
EXECUTE wl_stmt;
DEALLOCATE PREPARE wl_stmt;

SET @li_c_session = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA = @wl_db AND TABLE_NAME = 'live_recording_ingests' AND COLUMN_NAME = 'session_id');
SET @wl_sql = IF(@li_has = 1 AND @li_c_session = 0,
    'ALTER TABLE live_recording_ingests ADD COLUMN session_id CHAR(36) NOT NULL',
    'SELECT 1');
PREPARE wl_stmt FROM @wl_sql;
EXECUTE wl_stmt;
DEALLOCATE PREPARE wl_stmt;

SET @li_c_provider = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA = @wl_db AND TABLE_NAME = 'live_recording_ingests' AND COLUMN_NAME = 'provider');
SET @wl_sql = IF(@li_has = 1 AND @li_c_provider = 0,
    'ALTER TABLE live_recording_ingests ADD COLUMN provider VARCHAR(128) NOT NULL',
    'SELECT 1');
PREPARE wl_stmt FROM @wl_sql;
EXECUTE wl_stmt;
DEALLOCATE PREPARE wl_stmt;

SET @li_c_event = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA = @wl_db AND TABLE_NAME = 'live_recording_ingests' AND COLUMN_NAME = 'event_id');
SET @wl_sql = IF(@li_has = 1 AND @li_c_event = 0,
    'ALTER TABLE live_recording_ingests ADD COLUMN event_id VARCHAR(128) NOT NULL',
    'SELECT 1');
PREPARE wl_stmt FROM @wl_sql;
EXECUTE wl_stmt;
DEALLOCATE PREPARE wl_stmt;

SET @li_c_recording = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA = @wl_db AND TABLE_NAME = 'live_recording_ingests' AND COLUMN_NAME = 'provider_recording_id');
SET @wl_sql = IF(@li_has = 1 AND @li_c_recording = 0,
    'ALTER TABLE live_recording_ingests ADD COLUMN provider_recording_id VARCHAR(128) NOT NULL',
    'SELECT 1');
PREPARE wl_stmt FROM @wl_sql;
EXECUTE wl_stmt;
DEALLOCATE PREPARE wl_stmt;

SET @li_c_duration = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA = @wl_db AND TABLE_NAME = 'live_recording_ingests' AND COLUMN_NAME = 'duration_seconds');
SET @wl_sql = IF(@li_has = 1 AND @li_c_duration = 0,
    'ALTER TABLE live_recording_ingests ADD COLUMN duration_seconds INT UNSIGNED NOT NULL',
    'SELECT 1');
PREPARE wl_stmt FROM @wl_sql;
EXECUTE wl_stmt;
DEALLOCATE PREPARE wl_stmt;

SET @li_c_bytes = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA = @wl_db AND TABLE_NAME = 'live_recording_ingests' AND COLUMN_NAME = 'storage_bytes');
SET @wl_sql = IF(@li_has = 1 AND @li_c_bytes = 0,
    'ALTER TABLE live_recording_ingests ADD COLUMN storage_bytes BIGINT UNSIGNED NOT NULL',
    'SELECT 1');
PREPARE wl_stmt FROM @wl_sql;
EXECUTE wl_stmt;
DEALLOCATE PREPARE wl_stmt;

SET @li_c_occurred = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA = @wl_db AND TABLE_NAME = 'live_recording_ingests' AND COLUMN_NAME = 'occurred_at_ms');
SET @wl_sql = IF(@li_has = 1 AND @li_c_occurred = 0,
    'ALTER TABLE live_recording_ingests ADD COLUMN occurred_at_ms BIGINT NOT NULL',
    'SELECT 1');
PREPARE wl_stmt FROM @wl_sql;
EXECUTE wl_stmt;
DEALLOCATE PREPARE wl_stmt;

SET @li_c_outcome = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA = @wl_db AND TABLE_NAME = 'live_recording_ingests' AND COLUMN_NAME = 'outcome');
SET @wl_sql = IF(@li_has = 1 AND @li_c_outcome = 0,
    'ALTER TABLE live_recording_ingests ADD COLUMN outcome VARCHAR(32) NOT NULL',
    'SELECT 1');
PREPARE wl_stmt FROM @wl_sql;
EXECUTE wl_stmt;
DEALLOCATE PREPARE wl_stmt;

SET @li_c_owner = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA = @wl_db AND TABLE_NAME = 'live_recording_ingests' AND COLUMN_NAME = 'claim_owner');
SET @wl_sql = IF(@li_has = 1 AND @li_c_owner = 0,
    'ALTER TABLE live_recording_ingests ADD COLUMN claim_owner VARCHAR(64) NULL',
    'SELECT 1');
PREPARE wl_stmt FROM @wl_sql;
EXECUTE wl_stmt;
DEALLOCATE PREPARE wl_stmt;

SET @li_c_expiry = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA = @wl_db AND TABLE_NAME = 'live_recording_ingests' AND COLUMN_NAME = 'claim_expires_at_ms');
SET @wl_sql = IF(@li_has = 1 AND @li_c_expiry = 0,
    'ALTER TABLE live_recording_ingests ADD COLUMN claim_expires_at_ms BIGINT NULL',
    'SELECT 1');
PREPARE wl_stmt FROM @wl_sql;
EXECUTE wl_stmt;
DEALLOCATE PREPARE wl_stmt;

-- Fresh column probes AFTER every ADD above.
SET @li_a_id = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA = @wl_db AND TABLE_NAME = 'live_recording_ingests' AND COLUMN_NAME = 'id');
SET @li_a_tenant = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA = @wl_db AND TABLE_NAME = 'live_recording_ingests' AND COLUMN_NAME = 'tenant_id');
SET @li_a_session = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA = @wl_db AND TABLE_NAME = 'live_recording_ingests' AND COLUMN_NAME = 'session_id');
SET @li_a_provider = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA = @wl_db AND TABLE_NAME = 'live_recording_ingests' AND COLUMN_NAME = 'provider');
SET @li_a_event = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA = @wl_db AND TABLE_NAME = 'live_recording_ingests' AND COLUMN_NAME = 'event_id');
SET @li_a_recording = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA = @wl_db AND TABLE_NAME = 'live_recording_ingests' AND COLUMN_NAME = 'provider_recording_id');
SET @li_a_outcome = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA = @wl_db AND TABLE_NAME = 'live_recording_ingests' AND COLUMN_NAME = 'outcome');
SET @li_a_owner = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA = @wl_db AND TABLE_NAME = 'live_recording_ingests' AND COLUMN_NAME = 'claim_owner');
SET @li_a_expiry = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA = @wl_db AND TABLE_NAME = 'live_recording_ingests' AND COLUMN_NAME = 'claim_expires_at_ms');

SET @li_has_pk = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.STATISTICS
    WHERE TABLE_SCHEMA = @wl_db AND TABLE_NAME = 'live_recording_ingests' AND INDEX_NAME = 'PRIMARY');
SET @wl_sql = IF(@li_has = 1 AND @li_a_id = 1 AND @li_has_pk = 0,
    'ALTER TABLE live_recording_ingests ADD PRIMARY KEY (id)',
    'SELECT 1');
PREPARE wl_stmt FROM @wl_sql;
EXECUTE wl_stmt;
DEALLOCATE PREPARE wl_stmt;

SET @li_has_uq_event = (SELECT COUNT(DISTINCT INDEX_NAME) FROM INFORMATION_SCHEMA.STATISTICS
    WHERE TABLE_SCHEMA = @wl_db AND TABLE_NAME = 'live_recording_ingests'
      AND INDEX_NAME = 'uq_ingest_event');
SET @wl_sql = IF(@li_has = 1 AND @li_a_tenant = 1 AND @li_a_provider = 1 AND @li_a_event = 1 AND @li_has_uq_event = 0,
    'ALTER TABLE live_recording_ingests ADD UNIQUE KEY uq_ingest_event (tenant_id, provider, event_id)',
    'SELECT 1');
PREPARE wl_stmt FROM @wl_sql;
EXECUTE wl_stmt;
DEALLOCATE PREPARE wl_stmt;

SET @li_has_uq_recording = (SELECT COUNT(DISTINCT INDEX_NAME) FROM INFORMATION_SCHEMA.STATISTICS
    WHERE TABLE_SCHEMA = @wl_db AND TABLE_NAME = 'live_recording_ingests'
      AND INDEX_NAME = 'uq_ingest_recording');
SET @wl_sql = IF(@li_has = 1 AND @li_a_tenant = 1 AND @li_a_provider = 1 AND @li_a_recording = 1 AND @li_has_uq_recording = 0,
    'ALTER TABLE live_recording_ingests ADD UNIQUE KEY uq_ingest_recording (tenant_id, provider, provider_recording_id)',
    'SELECT 1');
PREPARE wl_stmt FROM @wl_sql;
EXECUTE wl_stmt;
DEALLOCATE PREPARE wl_stmt;

SET @li_has_idx_pending = (SELECT COUNT(DISTINCT INDEX_NAME) FROM INFORMATION_SCHEMA.STATISTICS
    WHERE TABLE_SCHEMA = @wl_db AND TABLE_NAME = 'live_recording_ingests'
      AND INDEX_NAME = 'idx_live_ingest_pending');
SET @wl_sql = IF(@li_has = 1 AND @li_a_outcome = 1 AND @li_a_expiry = 1 AND @li_has_idx_pending = 0,
    'ALTER TABLE live_recording_ingests ADD INDEX idx_live_ingest_pending (outcome, claim_expires_at_ms)',
    'SELECT 1');
PREPARE wl_stmt FROM @wl_sql;
EXECUTE wl_stmt;
DEALLOCATE PREPARE wl_stmt;

SET @li_has_idx_session = (SELECT COUNT(DISTINCT INDEX_NAME) FROM INFORMATION_SCHEMA.STATISTICS
    WHERE TABLE_SCHEMA = @wl_db AND TABLE_NAME = 'live_recording_ingests'
      AND INDEX_NAME = 'idx_live_ingest_session');
SET @wl_sql = IF(@li_has = 1 AND @li_a_tenant = 1 AND @li_a_session = 1 AND @li_has_idx_session = 0,
    'ALTER TABLE live_recording_ingests ADD INDEX idx_live_ingest_session (tenant_id, session_id)',
    'SELECT 1');
PREPARE wl_stmt FROM @wl_sql;
EXECUTE wl_stmt;
DEALLOCATE PREPARE wl_stmt;

SET @li_has_fk_tenant = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.TABLE_CONSTRAINTS
    WHERE CONSTRAINT_SCHEMA = @wl_db AND TABLE_NAME = 'live_recording_ingests'
      AND CONSTRAINT_NAME = 'fk_live_ingest_tenant');
SET @wl_sql = IF(@li_has = 1 AND @li_a_tenant = 1 AND @li_has_fk_tenant = 0,
    'ALTER TABLE live_recording_ingests ADD CONSTRAINT fk_live_ingest_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id)',
    'SELECT 1');
PREPARE wl_stmt FROM @wl_sql;
EXECUTE wl_stmt;
DEALLOCATE PREPARE wl_stmt;

SET @li_has_fk_session = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.TABLE_CONSTRAINTS
    WHERE CONSTRAINT_SCHEMA = @wl_db AND TABLE_NAME = 'live_recording_ingests'
      AND CONSTRAINT_NAME = 'fk_live_ingest_session');
SET @wl_sql = IF(@li_has = 1 AND @li_a_tenant = 1 AND @li_a_session = 1 AND @li_has_fk_session = 0,
    'ALTER TABLE live_recording_ingests ADD CONSTRAINT fk_live_ingest_session FOREIGN KEY (tenant_id, session_id) REFERENCES live_sessions (tenant_id, id) ON DELETE RESTRICT',
    'SELECT 1');
PREPARE wl_stmt FROM @wl_sql;
EXECUTE wl_stmt;
DEALLOCATE PREPARE wl_stmt;

SET @li_has_chk_pair = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.TABLE_CONSTRAINTS
    WHERE CONSTRAINT_SCHEMA = @wl_db AND TABLE_NAME = 'live_recording_ingests'
      AND CONSTRAINT_NAME = 'chk_live_ingest_lease_pair');
SET @wl_sql = IF(@li_has = 1 AND @li_a_owner = 1 AND @li_a_expiry = 1 AND @li_has_chk_pair = 0,
    'ALTER TABLE live_recording_ingests ADD CONSTRAINT chk_live_ingest_lease_pair CHECK ((claim_owner IS NULL) = (claim_expires_at_ms IS NULL))',
    'SELECT 1');
PREPARE wl_stmt FROM @wl_sql;
EXECUTE wl_stmt;
DEALLOCATE PREPARE wl_stmt;

SET @li_has_chk_release = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.TABLE_CONSTRAINTS
    WHERE CONSTRAINT_SCHEMA = @wl_db AND TABLE_NAME = 'live_recording_ingests'
      AND CONSTRAINT_NAME = 'chk_live_ingest_terminal_release');
SET @wl_sql = IF(@li_has = 1 AND @li_a_outcome = 1 AND @li_a_owner = 1 AND @li_a_expiry = 1 AND @li_has_chk_release = 0,
    "ALTER TABLE live_recording_ingests ADD CONSTRAINT chk_live_ingest_terminal_release CHECK (outcome = 'pending' OR (claim_owner IS NULL AND claim_expires_at_ms IS NULL))",
    'SELECT 1');
PREPARE wl_stmt FROM @wl_sql;
EXECUTE wl_stmt;
DEALLOCATE PREPARE wl_stmt;

-- -----------------------------------------------------------------------------
-- Table 5: live_session_presence_intervals — append-only presence intervals.
--   left_at_ms NULL means the interval is still open; close_reason is present
--   iff the interval is closed (CHECK). The composite tenant/session FK into
--   participants makes it impossible to attach a presence interval to another
--   tenant's participant or to a participant of a different session.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS live_session_presence_intervals (
    id CHAR(36) NOT NULL,
    tenant_id CHAR(36) NOT NULL,
    session_id CHAR(36) NOT NULL,
    participant_id CHAR(36) NOT NULL,
    user_id CHAR(36) NOT NULL,
    joined_at_ms BIGINT NOT NULL COMMENT 'UTC epoch milliseconds',
    left_at_ms BIGINT NULL COMMENT 'UTC epoch milliseconds; NULL while the interval is open',
    close_reason ENUM('leave','callback','session-ended') NULL COMMENT 'Non-NULL iff left_at_ms is non-NULL',
    PRIMARY KEY (id),
    UNIQUE KEY uq_presence_interval (session_id, user_id, joined_at_ms),
    KEY idx_presence_open (session_id, user_id, left_at_ms),
    KEY idx_presence_participant (tenant_id, session_id, participant_id),
    CONSTRAINT fk_presence_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id),
    CONSTRAINT fk_presence_participant FOREIGN KEY (tenant_id, session_id, participant_id) REFERENCES live_session_participants (tenant_id, session_id, id) ON DELETE RESTRICT,
    CONSTRAINT chk_presence_left_reason CHECK ((left_at_ms IS NULL) = (close_reason IS NULL))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  COMMENT 'WL presence intervals; closed interval iff close_reason present';

SET @lpi_has = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.TABLES
    WHERE TABLE_SCHEMA = @wl_db AND TABLE_NAME = 'live_session_presence_intervals');

SET @lpi_c_id = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA = @wl_db AND TABLE_NAME = 'live_session_presence_intervals' AND COLUMN_NAME = 'id');
SET @wl_sql = IF(@lpi_has = 1 AND @lpi_c_id = 0,
    'ALTER TABLE live_session_presence_intervals ADD COLUMN id CHAR(36) NOT NULL',
    'SELECT 1');
PREPARE wl_stmt FROM @wl_sql;
EXECUTE wl_stmt;
DEALLOCATE PREPARE wl_stmt;

SET @lpi_c_tenant = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA = @wl_db AND TABLE_NAME = 'live_session_presence_intervals' AND COLUMN_NAME = 'tenant_id');
SET @wl_sql = IF(@lpi_has = 1 AND @lpi_c_tenant = 0,
    'ALTER TABLE live_session_presence_intervals ADD COLUMN tenant_id CHAR(36) NOT NULL',
    'SELECT 1');
PREPARE wl_stmt FROM @wl_sql;
EXECUTE wl_stmt;
DEALLOCATE PREPARE wl_stmt;

SET @lpi_c_session = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA = @wl_db AND TABLE_NAME = 'live_session_presence_intervals' AND COLUMN_NAME = 'session_id');
SET @wl_sql = IF(@lpi_has = 1 AND @lpi_c_session = 0,
    'ALTER TABLE live_session_presence_intervals ADD COLUMN session_id CHAR(36) NOT NULL',
    'SELECT 1');
PREPARE wl_stmt FROM @wl_sql;
EXECUTE wl_stmt;
DEALLOCATE PREPARE wl_stmt;

SET @lpi_c_participant = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA = @wl_db AND TABLE_NAME = 'live_session_presence_intervals' AND COLUMN_NAME = 'participant_id');
SET @wl_sql = IF(@lpi_has = 1 AND @lpi_c_participant = 0,
    'ALTER TABLE live_session_presence_intervals ADD COLUMN participant_id CHAR(36) NOT NULL',
    'SELECT 1');
PREPARE wl_stmt FROM @wl_sql;
EXECUTE wl_stmt;
DEALLOCATE PREPARE wl_stmt;

SET @lpi_c_user = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA = @wl_db AND TABLE_NAME = 'live_session_presence_intervals' AND COLUMN_NAME = 'user_id');
SET @wl_sql = IF(@lpi_has = 1 AND @lpi_c_user = 0,
    'ALTER TABLE live_session_presence_intervals ADD COLUMN user_id CHAR(36) NOT NULL',
    'SELECT 1');
PREPARE wl_stmt FROM @wl_sql;
EXECUTE wl_stmt;
DEALLOCATE PREPARE wl_stmt;

SET @lpi_c_joined = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA = @wl_db AND TABLE_NAME = 'live_session_presence_intervals' AND COLUMN_NAME = 'joined_at_ms');
SET @wl_sql = IF(@lpi_has = 1 AND @lpi_c_joined = 0,
    'ALTER TABLE live_session_presence_intervals ADD COLUMN joined_at_ms BIGINT NOT NULL',
    'SELECT 1');
PREPARE wl_stmt FROM @wl_sql;
EXECUTE wl_stmt;
DEALLOCATE PREPARE wl_stmt;

SET @lpi_c_left = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA = @wl_db AND TABLE_NAME = 'live_session_presence_intervals' AND COLUMN_NAME = 'left_at_ms');
SET @wl_sql = IF(@lpi_has = 1 AND @lpi_c_left = 0,
    'ALTER TABLE live_session_presence_intervals ADD COLUMN left_at_ms BIGINT NULL',
    'SELECT 1');
PREPARE wl_stmt FROM @wl_sql;
EXECUTE wl_stmt;
DEALLOCATE PREPARE wl_stmt;

SET @lpi_c_reason = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA = @wl_db AND TABLE_NAME = 'live_session_presence_intervals' AND COLUMN_NAME = 'close_reason');
SET @wl_sql = IF(@lpi_has = 1 AND @lpi_c_reason = 0,
    "ALTER TABLE live_session_presence_intervals ADD COLUMN close_reason ENUM('leave','callback','session-ended') NULL",
    'SELECT 1');
PREPARE wl_stmt FROM @wl_sql;
EXECUTE wl_stmt;
DEALLOCATE PREPARE wl_stmt;

-- Fresh column probes AFTER every ADD above.
SET @lpi_a_id = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA = @wl_db AND TABLE_NAME = 'live_session_presence_intervals' AND COLUMN_NAME = 'id');
SET @lpi_a_tenant = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA = @wl_db AND TABLE_NAME = 'live_session_presence_intervals' AND COLUMN_NAME = 'tenant_id');
SET @lpi_a_session = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA = @wl_db AND TABLE_NAME = 'live_session_presence_intervals' AND COLUMN_NAME = 'session_id');
SET @lpi_a_participant = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA = @wl_db AND TABLE_NAME = 'live_session_presence_intervals' AND COLUMN_NAME = 'participant_id');
SET @lpi_a_user = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA = @wl_db AND TABLE_NAME = 'live_session_presence_intervals' AND COLUMN_NAME = 'user_id');
SET @lpi_a_joined = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA = @wl_db AND TABLE_NAME = 'live_session_presence_intervals' AND COLUMN_NAME = 'joined_at_ms');
SET @lpi_a_left = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA = @wl_db AND TABLE_NAME = 'live_session_presence_intervals' AND COLUMN_NAME = 'left_at_ms');
SET @lpi_a_reason = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA = @wl_db AND TABLE_NAME = 'live_session_presence_intervals' AND COLUMN_NAME = 'close_reason');

SET @lpi_has_pk = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.STATISTICS
    WHERE TABLE_SCHEMA = @wl_db AND TABLE_NAME = 'live_session_presence_intervals' AND INDEX_NAME = 'PRIMARY');
SET @wl_sql = IF(@lpi_has = 1 AND @lpi_a_id = 1 AND @lpi_has_pk = 0,
    'ALTER TABLE live_session_presence_intervals ADD PRIMARY KEY (id)',
    'SELECT 1');
PREPARE wl_stmt FROM @wl_sql;
EXECUTE wl_stmt;
DEALLOCATE PREPARE wl_stmt;

SET @lpi_has_uq = (SELECT COUNT(DISTINCT INDEX_NAME) FROM INFORMATION_SCHEMA.STATISTICS
    WHERE TABLE_SCHEMA = @wl_db AND TABLE_NAME = 'live_session_presence_intervals'
      AND INDEX_NAME = 'uq_presence_interval');
SET @wl_sql = IF(@lpi_has = 1 AND @lpi_a_session = 1 AND @lpi_a_user = 1 AND @lpi_a_joined = 1 AND @lpi_has_uq = 0,
    'ALTER TABLE live_session_presence_intervals ADD UNIQUE KEY uq_presence_interval (session_id, user_id, joined_at_ms)',
    'SELECT 1');
PREPARE wl_stmt FROM @wl_sql;
EXECUTE wl_stmt;
DEALLOCATE PREPARE wl_stmt;

SET @lpi_has_idx_open = (SELECT COUNT(DISTINCT INDEX_NAME) FROM INFORMATION_SCHEMA.STATISTICS
    WHERE TABLE_SCHEMA = @wl_db AND TABLE_NAME = 'live_session_presence_intervals'
      AND INDEX_NAME = 'idx_presence_open');
SET @wl_sql = IF(@lpi_has = 1 AND @lpi_a_session = 1 AND @lpi_a_user = 1 AND @lpi_a_left = 1 AND @lpi_has_idx_open = 0,
    'ALTER TABLE live_session_presence_intervals ADD INDEX idx_presence_open (session_id, user_id, left_at_ms)',
    'SELECT 1');
PREPARE wl_stmt FROM @wl_sql;
EXECUTE wl_stmt;
DEALLOCATE PREPARE wl_stmt;

SET @lpi_has_idx_participant = (SELECT COUNT(DISTINCT INDEX_NAME) FROM INFORMATION_SCHEMA.STATISTICS
    WHERE TABLE_SCHEMA = @wl_db AND TABLE_NAME = 'live_session_presence_intervals'
      AND INDEX_NAME = 'idx_presence_participant');
SET @wl_sql = IF(@lpi_has = 1 AND @lpi_a_tenant = 1 AND @lpi_a_session = 1 AND @lpi_a_participant = 1 AND @lpi_has_idx_participant = 0,
    'ALTER TABLE live_session_presence_intervals ADD INDEX idx_presence_participant (tenant_id, session_id, participant_id)',
    'SELECT 1');
PREPARE wl_stmt FROM @wl_sql;
EXECUTE wl_stmt;
DEALLOCATE PREPARE wl_stmt;

SET @lpi_has_fk_tenant = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.TABLE_CONSTRAINTS
    WHERE CONSTRAINT_SCHEMA = @wl_db AND TABLE_NAME = 'live_session_presence_intervals'
      AND CONSTRAINT_NAME = 'fk_presence_tenant');
SET @wl_sql = IF(@lpi_has = 1 AND @lpi_a_tenant = 1 AND @lpi_has_fk_tenant = 0,
    'ALTER TABLE live_session_presence_intervals ADD CONSTRAINT fk_presence_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id)',
    'SELECT 1');
PREPARE wl_stmt FROM @wl_sql;
EXECUTE wl_stmt;
DEALLOCATE PREPARE wl_stmt;

SET @lpi_has_fk_participant = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.TABLE_CONSTRAINTS
    WHERE CONSTRAINT_SCHEMA = @wl_db AND TABLE_NAME = 'live_session_presence_intervals'
      AND CONSTRAINT_NAME = 'fk_presence_participant');
SET @wl_sql = IF(@lpi_has = 1 AND @lpi_a_tenant = 1 AND @lpi_a_session = 1 AND @lpi_a_participant = 1 AND @lpi_has_fk_participant = 0,
    'ALTER TABLE live_session_presence_intervals ADD CONSTRAINT fk_presence_participant FOREIGN KEY (tenant_id, session_id, participant_id) REFERENCES live_session_participants (tenant_id, session_id, id) ON DELETE RESTRICT',
    'SELECT 1');
PREPARE wl_stmt FROM @wl_sql;
EXECUTE wl_stmt;
DEALLOCATE PREPARE wl_stmt;

SET @lpi_has_chk = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.TABLE_CONSTRAINTS
    WHERE CONSTRAINT_SCHEMA = @wl_db AND TABLE_NAME = 'live_session_presence_intervals'
      AND CONSTRAINT_NAME = 'chk_presence_left_reason');
SET @wl_sql = IF(@lpi_has = 1 AND @lpi_a_left = 1 AND @lpi_a_reason = 1 AND @lpi_has_chk = 0,
    'ALTER TABLE live_session_presence_intervals ADD CONSTRAINT chk_presence_left_reason CHECK ((left_at_ms IS NULL) = (close_reason IS NULL))',
    'SELECT 1');
PREPARE wl_stmt FROM @wl_sql;
EXECUTE wl_stmt;
DEALLOCATE PREPARE wl_stmt;
