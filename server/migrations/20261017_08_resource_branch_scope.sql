-- Resource-derived branch scope (S1 resource contract).
--
-- Design note: branch ownership is authoritative on the trusted parent row.
-- Only `groups` carries a branch assignment; lectures, materials, exams,
-- premium lectures, attendance, files and videos derive their branch from the
-- group / course chain that the server itself wrote. No redundant branch
-- column is added to child tables, and no FK check is ever disabled.
--
-- `groups.branch_scope` is the explicit classification:
--   'branch'     -> branch-owned; branch_id is REQUIRED (a missing id is
--                   ambiguous and is denied/quarantined, never defaulted).
--   'tenant'     -> explicitly tenant-level (independent instructor or
--                   tenant-wide content); branch_id must be NULL.
--   'unassigned' -> legacy row created before the branch model. It keeps its
--                   pre-existing tenant/exact-resource access, is reported by
--                   the quarantine workflow, and can never satisfy a branch
--                   context. Whether legacy rows become branch-owned is a
--                   product decision, not a schema default.
--
-- Safe to re-run. This file is only executed by the owned isolated validation
-- stack; historical migrations are immutable.

-- ---------------------------------------------------------------------------
-- groups.branch_id
-- ---------------------------------------------------------------------------
SET @m1_groups_branch_id_exists = (
    SELECT COUNT(*) FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'groups' AND COLUMN_NAME = 'branch_id'
);
SET @m1_groups_branch_id_ddl = IF(
    @m1_groups_branch_id_exists = 0,
    'ALTER TABLE `groups` ADD COLUMN branch_id CHAR(36) NULL AFTER course_id',
    'SELECT 1'
);
PREPARE m1_groups_branch_id_stmt FROM @m1_groups_branch_id_ddl;
EXECUTE m1_groups_branch_id_stmt;
DEALLOCATE PREPARE m1_groups_branch_id_stmt;

-- ---------------------------------------------------------------------------
-- groups.branch_scope
-- ---------------------------------------------------------------------------
SET @m1_groups_branch_scope_exists = (
    SELECT COUNT(*) FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'groups' AND COLUMN_NAME = 'branch_scope'
);
SET @m1_groups_branch_scope_ddl = IF(
    @m1_groups_branch_scope_exists = 0,
    'ALTER TABLE `groups` ADD COLUMN branch_scope VARCHAR(16) NOT NULL DEFAULT ''unassigned'' AFTER branch_id',
    'SELECT 1'
);
PREPARE m1_groups_branch_scope_stmt FROM @m1_groups_branch_scope_ddl;
EXECUTE m1_groups_branch_scope_stmt;
DEALLOCATE PREPARE m1_groups_branch_scope_stmt;

-- ---------------------------------------------------------------------------
-- Index for branch filtering and quarantine reporting.
-- ---------------------------------------------------------------------------
SET @m1_groups_branch_index_exists = (
    SELECT COUNT(*) FROM information_schema.STATISTICS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'groups' AND INDEX_NAME = 'idx_groups_branch_scope'
);
SET @m1_groups_branch_index_ddl = IF(
    @m1_groups_branch_index_exists = 0,
    'ALTER TABLE `groups` ADD INDEX idx_groups_branch_scope (branch_scope, branch_id)',
    'SELECT 1'
);
PREPARE m1_groups_branch_index_stmt FROM @m1_groups_branch_index_ddl;
EXECUTE m1_groups_branch_index_stmt;
DEALLOCATE PREPARE m1_groups_branch_index_stmt;

-- ---------------------------------------------------------------------------
-- Foreign key groups.branch_id -> branches.id. Added only when absent, and
-- only after both columns exist. FK checks are never disabled.
-- ---------------------------------------------------------------------------
SET @m1_groups_branch_fk_exists = (
    SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS
    WHERE CONSTRAINT_SCHEMA = DATABASE() AND TABLE_NAME = 'groups'
      AND CONSTRAINT_NAME = 'fk_groups_branch' AND CONSTRAINT_TYPE = 'FOREIGN KEY'
);
SET @m1_groups_branch_fk_ddl = IF(
    @m1_groups_branch_fk_exists = 0,
    'ALTER TABLE `groups` ADD CONSTRAINT fk_groups_branch FOREIGN KEY (branch_id) REFERENCES branches(id)',
    'SELECT 1'
);
PREPARE m1_groups_branch_fk_stmt FROM @m1_groups_branch_fk_ddl;
EXECUTE m1_groups_branch_fk_stmt;
DEALLOCATE PREPARE m1_groups_branch_fk_stmt;

-- ---------------------------------------------------------------------------
-- Audited branch/membership lifecycle and quarantine workflow.
-- No client-supplied actor id is stored; the API writes the verified principal.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS branch_audit_log (
    id CHAR(36) NOT NULL,
    tenant_id CHAR(36) NULL,
    branch_id CHAR(36) NULL,
    actor_user_id CHAR(36) NULL,
    action VARCHAR(96) NOT NULL,
    resource_type VARCHAR(64) NULL,
    resource_id CHAR(36) NULL,
    detail JSON NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    KEY idx_branch_audit_tenant_created (tenant_id, created_at),
    KEY idx_branch_audit_branch_created (branch_id, created_at),
    KEY idx_branch_audit_action_created (action, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
