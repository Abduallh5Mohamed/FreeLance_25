-- =============================================================================
-- B3-C-SCHEMA (PATH-C1) — student relation event log + identity handoff columns
--   + payment_requests duplicate-pending guard
-- Task:    path-C1-schema
-- Date:    2026-10-22
-- Purpose: storage for the accepted domain contracts
--   `server/src/services/student-relations.ts`      (StudentRelationStore)
--   implemented identity/handoff workers managing `subscription_requests`
--   implemented legacy-payment workers managing `payment_requests`
--   Contract: docs/contracts/B3-SCHEMA-CONTRACT-20261022.md
--
-- DESIGN
--   1. `student_relation_events`: the append-only employee of
--      `StudentRelationStore`. One immutable row per appended
--      relation event. `(tenant_id, event_key)` is the HK1 idempotency
--      arbiter inside the tenant (the same key with a different
--      payload_hash is a typed conflict, replayed otherwise); `event_id`
--      is globally unique (the PK). `payload_hash` is the lowercase
--      SHA-256 the domain computes per append. `recorded_seq` is an
--      AUTO_INCREMENT server sequence used as the tie-breaker for equal
--      `effective_at` instants: the deterministic read order
--      `(effective_at ASC, recorded_seq ASC)` required by the domain is
--      served by idx_relation_tenant_pair / idx_relation_tenant_window.
--      There is NO update/delete path: corrections are NEW events that
--      supersede an earlier event; `supersedes_event_id` FKs to the
--      proven-unique `event_id` of this same table. The correction
--      invariants (mandatory reason/supersedes/mode on corrections;
--      forbidden on activated/deactivated) are CHECK-enforced.
--      `UNIQUE (tenant_id, supersedes_event_id)` (nullable, so non-correction
--      rows never collide) allows at most ONE superseder per event inside a
--      tenant. The key is declared in CREATE TABLE and re-added by a guarded
--      ALTER for catalogs that already created this table (idempotent).
--   2. `subscription_requests.user_id` / `decided_by` — handoff columns for
--      the implemented identity workers: `user_id` receives the unified
--      global student user identity resolved at approval time
--      (users.id; NULL for legacy/unresolved rows), `decided_by` receives
--      the principal that approved/rejected the request. Both nullable,
--      both indexed, FKs to the already-proven `users(id)` PK with
--      ON DELETE SET NULL.
--   3. `payment_requests` duplicate-pending guard: MySQL has no partial
--      unique index, so a STORED generated column `pending_guard` is NULL
--      unless status = 'pending' (then 1). A UNIQUE index over
--      (tenant_id, student_id, grade_id, group_id, amount, pending_guard)
--      then makes exactly two things true:
--        - two pending duplicates with an identical key collide
--          (guard 1 = 1) — the duplicate-pending write fails loudly;
--        - non-pending rows all carry NULL and never collide (MySQL
--          uniqueness permits any number of NULLs), so approve/reject
--          flows keep full history.
--      Verified against the baseline (20260929_payment_requests_tenant.sql):
--      every indexed column is NOT NULL and indexable
--      (CHAR(36)/CHAR(36)/CHAR(36)/CHAR(36)/DECIMAL(10,2)); the DECIMAL
--      touched here is the pre-existing legacy `amount` column, which this
--      migration indexes but never recreates.
--
-- APPEND-ONLY OBLIGATION (DDL limit, cannot be expressed here)
--   UPDATE/DELETE on `student_relation_events` (and DELETE everywhere)
--   MUST be denied by the application privilege layer. Corrections are new
--   rows. The invoice/ledger append-only obligations live in the FIN3
--   contract. Enforcement is a live-deployment step, separately approved.
--
-- OWNERSHIP
--   Every new table carries tenant_id. FKs reference tables/columns whose
--   uniqueness is already proven (tenants.id, users.id, and the PK
--   `event_id` of this same table). No legacy row, column or table is
--   rebuilt, moved or deleted; the only ALTERs on existing tables are the
--   guarded ADD COLUMN / ADD INDEX / ADD CONSTRAINT statements below.
--
-- IDEMPOTENCY / PROBE-RECOMPUTE RULE
--   Every statement is wrapped in an INFORMATION_SCHEMA probe + PREPARE/
--   EXECUTE so a re-run is a no-op. Any guard that depends on a column
--   added EARLIER IN THE SAME FILE probes the catalog AGAIN after that ADD
--   (the `*_after` variables) — this is the corrected B2 migration-01
--   FK-skip rule: a stale probe silently skipped the FK on first
--   application. No DROP, no TRUNCATE, no DELETE/UPDATE of data, no
--   FOREIGN_KEY_CHECKS manipulation, no runtime DDL.
--
-- !! THIS FILE IS AUTHORING-ONLY SOURCE DDL. No statement here is executed,
--    no database is connected to, and the manifest registration is owned by
--    Codex. Live bootstrap validation requires a separately approved step.
-- =============================================================================

SET @c1_db = DATABASE();

-- -----------------------------------------------------------------------------
-- Step 1: student_relation_events — append-only relation activation log.
-- -----------------------------------------------------------------------------
SET @c1_has_relation_events = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.TABLES
    WHERE TABLE_SCHEMA = @c1_db AND TABLE_NAME = 'student_relation_events');

SET @c1_sql_relation_events = IF(@c1_has_relation_events = 0,
    "CREATE TABLE student_relation_events (
        event_id CHAR(36) NOT NULL COMMENT 'Globally unique append-only event identity (StudentRelationEvent.eventId)',
        tenant_id CHAR(36) NOT NULL COMMENT 'Tenant scope; relation events are never deduplicated across tenants',
        user_id CHAR(36) NOT NULL COMMENT 'Unified global user identity (users.id) of the student side',
        teacher_id CHAR(36) NOT NULL COMMENT 'Global user identity (users.id) of the teacher side',
        event_key VARCHAR(128) NOT NULL COMMENT 'Caller-supplied idempotency key, unique per tenant (MAX_EVENT_KEY_LENGTH = 128)',
        kind ENUM('activated','deactivated','correction') NOT NULL,
        effective_at BIGINT UNSIGNED NOT NULL COMMENT 'Inclusive UTC epoch second (safe integer, exact)',
        recorded_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) COMMENT 'Server recording instant (ISO string in the domain); milliseconds kept',
        recorded_seq BIGINT UNSIGNED NOT NULL AUTO_INCREMENT COMMENT 'Monotonic server sequence; tie-breaker for equal (effective_at, recorded_at)',
        actor_id VARCHAR(128) NOT NULL COMMENT 'Real authenticated principal supplied by the caller (opaque, MAX_IDENTIFIER_LENGTH = 128)',
        cause VARCHAR(64) NOT NULL COMMENT 'Opaque caller-supplied business event code (MAX_CAUSE_LENGTH = 64); never interpreted by the domain',
        reason VARCHAR(500) NULL COMMENT 'Mandatory for corrections (MAX_REASON_LENGTH = 500)',
        supersedes_event_id CHAR(36) NULL COMMENT 'event_id of the earlier event a correction supersedes; forbidden on non-corrections',
        correction_mode ENUM('retime','void') NULL COMMENT 'Correction mode; defaults to retime in the domain, NULL for activated/deactivated',
        payload_hash CHAR(64) NOT NULL COMMENT 'Lowercase SHA-256 of the canonical append payload; decides replay vs conflict',
        PRIMARY KEY (event_id),
        UNIQUE KEY uq_relation_event_key (tenant_id, event_key),
        UNIQUE KEY uq_relation_event_single_superseder (tenant_id, supersedes_event_id),
        UNIQUE KEY uq_relation_recorded_seq (recorded_seq),
        KEY idx_relation_tenant_pair (tenant_id, user_id, teacher_id, effective_at, recorded_seq),
        KEY idx_relation_tenant_window (tenant_id, effective_at, recorded_seq),
        CONSTRAINT fk_relation_event_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id),
        CONSTRAINT fk_relation_event_user FOREIGN KEY (user_id) REFERENCES users(id),
        CONSTRAINT fk_relation_event_teacher FOREIGN KEY (teacher_id) REFERENCES users(id),
        CONSTRAINT fk_relation_event_supersedes FOREIGN KEY (supersedes_event_id) REFERENCES student_relation_events(event_id),
        CONSTRAINT chk_relation_event_correction CHECK ((kind <> 'correction' AND correction_mode IS NULL AND reason IS NULL AND supersedes_event_id IS NULL) OR (kind = 'correction' AND correction_mode IS NOT NULL AND reason IS NOT NULL AND supersedes_event_id IS NOT NULL))
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
      COMMENT 'B3 append-only student relation activation log (FIN2); never updated or deleted'",
    'SELECT 1');
PREPARE c1_stmt_relation_events FROM @c1_sql_relation_events;
EXECUTE c1_stmt_relation_events;
DEALLOCATE PREPARE c1_stmt_relation_events;

-- -----------------------------------------------------------------------------
-- Step 1b: one superseder per event — UNIQUE (tenant_id, supersedes_event_id).
-- A NULL supersedes_event_id is not a value, so MySQL uniqueness permits any
-- number of non-correction rows; at most ONE correction may supersede a given
-- event inside a tenant. The key is also declared inside CREATE TABLE above;
-- this guarded ALTER covers the ALREADY-CREATED path (a catalog that applied
-- the earlier 20261022_01 without the key). Both the table probe and the index
-- probe are FRESH (the *_after rule): @c1_has_relation_events was evaluated
-- before the CREATE above. No destructive dedup: if the catalog already holds
-- two corrections superseding the same event, the ADD fails loudly and the
-- live owner resolves the data; this file never deletes rows.
-- Constraint names are untouched (only a new index name is added).
-- -----------------------------------------------------------------------------
SET @c1_has_relation_events_after = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.TABLES
    WHERE TABLE_SCHEMA = @c1_db AND TABLE_NAME = 'student_relation_events');

SET @c1_has_relation_superseder_index = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.STATISTICS
    WHERE TABLE_SCHEMA = @c1_db AND TABLE_NAME = 'student_relation_events'
      AND INDEX_NAME = 'uq_relation_event_single_superseder');

SET @c1_sql_relation_superseder_index = IF(@c1_has_relation_events_after = 1 AND @c1_has_relation_superseder_index = 0,
    'ALTER TABLE student_relation_events ADD UNIQUE KEY uq_relation_event_single_superseder (tenant_id, supersedes_event_id)',
    'SELECT 1');
PREPARE c1_stmt_relation_superseder_index FROM @c1_sql_relation_superseder_index;
EXECUTE c1_stmt_relation_superseder_index;
DEALLOCATE PREPARE c1_stmt_relation_superseder_index;

-- -----------------------------------------------------------------------------
-- Step 2: subscription_requests.user_id — guarded ADD COLUMN on the legacy
-- table (verified missing in 20260922_00_tenant_media_and_subscription_requests).
-- -----------------------------------------------------------------------------
SET @c1_has_subscription_requests = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.TABLES
    WHERE TABLE_SCHEMA = @c1_db AND TABLE_NAME = 'subscription_requests');

SET @c1_has_subreq_user_col = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA = @c1_db AND TABLE_NAME = 'subscription_requests'
      AND COLUMN_NAME = 'user_id');

SET @c1_sql_subreq_user_col = IF(@c1_has_subscription_requests = 1 AND @c1_has_subreq_user_col = 0,
    "ALTER TABLE subscription_requests ADD COLUMN user_id CHAR(36) NULL COMMENT 'Unified user identity (users.id) resolved for this request at approval time; NULL on legacy or unresolved rows'",
    'SELECT 1');
PREPARE c1_stmt_subreq_user_col FROM @c1_sql_subreq_user_col;
EXECUTE c1_stmt_subreq_user_col;
DEALLOCATE PREPARE c1_stmt_subreq_user_col;

-- -----------------------------------------------------------------------------
-- Step 3: subscription_requests.decided_by — guarded ADD COLUMN.
-- -----------------------------------------------------------------------------
SET @c1_has_subreq_decided_col = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA = @c1_db AND TABLE_NAME = 'subscription_requests'
      AND COLUMN_NAME = 'decided_by');

SET @c1_sql_subreq_decided_col = IF(@c1_has_subscription_requests = 1 AND @c1_has_subreq_decided_col = 0,
    "ALTER TABLE subscription_requests ADD COLUMN decided_by CHAR(36) NULL COMMENT 'Principal (users.id) that approved/rejected the request; NULL while pending and on legacy rows'",
    'SELECT 1');
PREPARE c1_stmt_subreq_decided_col FROM @c1_sql_subreq_decided_col;
EXECUTE c1_stmt_subreq_decided_col;
DEALLOCATE PREPARE c1_stmt_subreq_decided_col;

-- -----------------------------------------------------------------------------
-- Step 4: index for the new user_id column. The column probe MUST be re-read
-- AFTER Step 2 (probe-recompute rule): on the first run the Step-2 guard saw
-- the column absent while issuing the ADD; @c1_has_subreq_user_col_after
-- reads the catalog as it stands now, so this step can never silently skip.
-- -----------------------------------------------------------------------------
SET @c1_has_subreq_user_col_after = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA = @c1_db AND TABLE_NAME = 'subscription_requests'
      AND COLUMN_NAME = 'user_id');

SET @c1_has_subreq_user_idx = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.STATISTICS
    WHERE TABLE_SCHEMA = @c1_db AND TABLE_NAME = 'subscription_requests'
      AND INDEX_NAME = 'idx_subscription_requests_user');

SET @c1_sql_subreq_user_idx = IF(@c1_has_subscription_requests = 1 AND @c1_has_subreq_user_col_after = 1 AND @c1_has_subreq_user_idx = 0,
    'ALTER TABLE subscription_requests ADD INDEX idx_subscription_requests_user (user_id)',
    'SELECT 1');
PREPARE c1_stmt_subreq_user_idx FROM @c1_sql_subreq_user_idx;
EXECUTE c1_stmt_subreq_user_idx;
DEALLOCATE PREPARE c1_stmt_subreq_user_idx;

-- -----------------------------------------------------------------------------
-- Step 5: index for the new decided_by column (same re-probe rule).
-- -----------------------------------------------------------------------------
SET @c1_has_subreq_decided_col_after = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA = @c1_db AND TABLE_NAME = 'subscription_requests'
      AND COLUMN_NAME = 'decided_by');

SET @c1_has_subreq_decided_idx = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.STATISTICS
    WHERE TABLE_SCHEMA = @c1_db AND TABLE_NAME = 'subscription_requests'
      AND INDEX_NAME = 'idx_subscription_requests_decider');

SET @c1_sql_subreq_decided_idx = IF(@c1_has_subscription_requests = 1 AND @c1_has_subreq_decided_col_after = 1 AND @c1_has_subreq_decided_idx = 0,
    'ALTER TABLE subscription_requests ADD INDEX idx_subscription_requests_decider (decided_by)',
    'SELECT 1');
PREPARE c1_stmt_subreq_decided_idx FROM @c1_sql_subreq_decided_idx;
EXECUTE c1_stmt_subreq_decided_idx;
DEALLOCATE PREPARE c1_stmt_subreq_decided_idx;

-- -----------------------------------------------------------------------------
-- Step 6: FK for user_id. Guarded on a FRESH column probe (the *_after
-- variable) plus the absent constraint name; users.id is the proven PK.
-- -----------------------------------------------------------------------------
SET @c1_has_subreq_user_fk = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.TABLE_CONSTRAINTS
    WHERE CONSTRAINT_SCHEMA = @c1_db AND TABLE_NAME = 'subscription_requests'
      AND CONSTRAINT_NAME = 'fk_subscription_requests_user');

SET @c1_sql_subreq_user_fk = IF(@c1_has_subscription_requests = 1 AND @c1_has_subreq_user_col_after = 1 AND @c1_has_subreq_user_fk = 0,
    'ALTER TABLE subscription_requests ADD CONSTRAINT fk_subscription_requests_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL',
    'SELECT 1');
PREPARE c1_stmt_subreq_user_fk FROM @c1_sql_subreq_user_fk;
EXECUTE c1_stmt_subreq_user_fk;
DEALLOCATE PREPARE c1_stmt_subreq_user_fk;

-- -----------------------------------------------------------------------------
-- Step 7: FK for decided_by (same re-probe rule; users.id proven PK).
-- -----------------------------------------------------------------------------
SET @c1_has_subreq_decided_fk = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.TABLE_CONSTRAINTS
    WHERE CONSTRAINT_SCHEMA = @c1_db AND TABLE_NAME = 'subscription_requests'
      AND CONSTRAINT_NAME = 'fk_subscription_requests_decider');

SET @c1_sql_subreq_decided_fk = IF(@c1_has_subscription_requests = 1 AND @c1_has_subreq_decided_col_after = 1 AND @c1_has_subreq_decided_fk = 0,
    'ALTER TABLE subscription_requests ADD CONSTRAINT fk_subscription_requests_decider FOREIGN KEY (decided_by) REFERENCES users(id) ON DELETE SET NULL',
    'SELECT 1');
PREPARE c1_stmt_subreq_decided_fk FROM @c1_sql_subreq_decided_fk;
EXECUTE c1_stmt_subreq_decided_fk;
DEALLOCATE PREPARE c1_stmt_subreq_decided_fk;

-- -----------------------------------------------------------------------------
-- Step 8: payment_requests.pending_guard — STORED generated column that is
-- NULL unless status = 'pending'. Verified baseline columns make this safe:
-- tenant_id/student_id/grade_id/group_id are CHAR(36) NOT NULL and amount is
-- DECIMAL(10,2) NOT NULL (20260929_payment_requests_tenant.sql). The DECIMAL
-- here is the pre-existing legacy column referenced by the index, NOT a new
-- money type; no fractional DECIMAL is created by this migration.
-- -----------------------------------------------------------------------------
SET @c1_has_payment_requests = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.TABLES
    WHERE TABLE_SCHEMA = @c1_db AND TABLE_NAME = 'payment_requests');

SET @c1_has_payreq_guard_col = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA = @c1_db AND TABLE_NAME = 'payment_requests'
      AND COLUMN_NAME = 'pending_guard');

SET @c1_sql_payreq_guard_col = IF(@c1_has_payment_requests = 1 AND @c1_has_payreq_guard_col = 0,
    "ALTER TABLE payment_requests ADD COLUMN pending_guard TINYINT(1) GENERATED ALWAYS AS (IF(status = 'pending', 1, NULL)) STORED NULL COMMENT 'Deterministic partial-unique arbiter: 1 while pending, NULL otherwise (pending_guard on non-pending rows never collides because MySQL uniqueness permits NULLs)'",
    'SELECT 1');
PREPARE c1_stmt_payreq_guard_col FROM @c1_sql_payreq_guard_col;
EXECUTE c1_stmt_payreq_guard_col;
DEALLOCATE PREPARE c1_stmt_payreq_guard_col;

-- -----------------------------------------------------------------------------
-- Step 9: UNIQUE guard over (tenant_id, student_id, grade_id, group_id,
-- amount, pending_guard). Re-probes the column added in Step 8 (probe-recompute
-- rule) plus the absent index name; the ADD fails loudly on any real catalog
-- that already holds pending duplicates, which is the intended fail-closed
-- behavior (never applied here: authoring-only).
-- -----------------------------------------------------------------------------
SET @c1_has_payreq_guard_col_after = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA = @c1_db AND TABLE_NAME = 'payment_requests'
      AND COLUMN_NAME = 'pending_guard');

SET @c1_has_payreq_pending_index = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.STATISTICS
    WHERE TABLE_SCHEMA = @c1_db AND TABLE_NAME = 'payment_requests'
      AND INDEX_NAME = 'uq_payment_requests_pending');

SET @c1_sql_payreq_pending_index = IF(@c1_has_payment_requests = 1 AND @c1_has_payreq_guard_col_after = 1 AND @c1_has_payreq_pending_index = 0,
    'ALTER TABLE payment_requests ADD UNIQUE KEY uq_payment_requests_pending (tenant_id, student_id, grade_id, group_id, amount, pending_guard)',
    'SELECT 1');
PREPARE c1_stmt_payreq_pending_index FROM @c1_sql_payreq_pending_index;
EXECUTE c1_stmt_payreq_pending_index;
DEALLOCATE PREPARE c1_stmt_payreq_pending_index;

-- -----------------------------------------------------------------------------
-- Step 10: uq_relation_event_single_superseder (tenant_id, supersedes_event_id).
-- This same key is part of the CREATE TABLE above (fresh path). This guarded
-- ALTER completes the ALREADY-CREATED path: the relation table is probed AGAIN
-- after Step 1 (probe-recompute rule), then the index name is probed. MySQL
-- uniqueness permits any number of NULLs, so every activated/deactivated row
-- (supersedes_event_id NULL) coexists freely while one earlier event can be
-- superseded at most once per tenant. If a pre-existing catalog already holds
-- two corrections superseding the same (tenant, event), the ADD fails loudly:
-- that is the intended fail-closed signal, never a destructive dedup. The
-- constraint name is the exact key the identity adapter maps; do not rename.
-- -----------------------------------------------------------------------------
SET @c1_has_relation_events_after = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.TABLES
    WHERE TABLE_SCHEMA = @c1_db AND TABLE_NAME = 'student_relation_events');

SET @c1_has_relation_single_superseder = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.STATISTICS
    WHERE TABLE_SCHEMA = @c1_db AND TABLE_NAME = 'student_relation_events'
      AND INDEX_NAME = 'uq_relation_event_single_superseder');

SET @c1_sql_relation_single_superseder = IF(@c1_has_relation_events_after = 1 AND @c1_has_relation_single_superseder = 0,
    'ALTER TABLE student_relation_events ADD UNIQUE KEY uq_relation_event_single_superseder (tenant_id, supersedes_event_id)',
    'SELECT 1');
PREPARE c1_stmt_relation_single_superseder FROM @c1_sql_relation_single_superseder;
EXECUTE c1_stmt_relation_single_superseder;
DEALLOCATE PREPARE c1_stmt_relation_single_superseder;
