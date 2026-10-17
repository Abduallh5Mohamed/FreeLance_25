-- Tenant-owned branch ownership and branch-membership model (S1 closure).
-- Safe to re-run. This FILE is never executed by this task outside the owned
-- isolated validation stack, and historical migrations are untouched.
--
-- The database-collation prelude sets utf8mb4/utf8mb4_unicode_ci as the server
-- default before the baseline, so these tables match the rest of the schema.

-- ---------------------------------------------------------------------------
-- branches: tenant-owned branch records with status/version lifecycle.
-- ---------------------------------------------------------------------------
SET @m1_branches_exists = (
    SELECT COUNT(*)
    FROM information_schema.TABLES
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME = 'branches'
);
SET @m1_branches_ddl = IF(
    @m1_branches_exists = 0,
    'CREATE TABLE branches (
        id CHAR(36) NOT NULL,
        tenant_id CHAR(36) NOT NULL,
        name VARCHAR(190) NOT NULL,
        status VARCHAR(32) NOT NULL DEFAULT ''active'',
        version INT NOT NULL DEFAULT 0,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        PRIMARY KEY (id),
        UNIQUE KEY uniq_branches_tenant_name (tenant_id, name),
        KEY idx_branches_tenant_status (tenant_id, status),
        CONSTRAINT fk_branches_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci',
    'SELECT 1'
);
PREPARE m1_branches_stmt FROM @m1_branches_ddl;
EXECUTE m1_branches_stmt;
DEALLOCATE PREPARE m1_branches_stmt;

-- ---------------------------------------------------------------------------
-- branch_memberships: versioned principal membership per branch. No row is
-- inferred from a client selector; rows are created by server-side flows and
-- revoked via status, never deleted, so revocation fails closed.
-- ---------------------------------------------------------------------------
SET @m1_branch_memberships_exists = (
    SELECT COUNT(*)
    FROM information_schema.TABLES
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME = 'branch_memberships'
);
SET @m1_branch_memberships_ddl = IF(
    @m1_branch_memberships_exists = 0,
    'CREATE TABLE branch_memberships (
        id CHAR(36) NOT NULL,
        branch_id CHAR(36) NOT NULL,
        user_id CHAR(36) NOT NULL,
        role VARCHAR(64) NOT NULL,
        status VARCHAR(32) NOT NULL DEFAULT ''active'',
        version INT NOT NULL DEFAULT 0,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        PRIMARY KEY (id),
        UNIQUE KEY uniq_branch_membership_branch_user (branch_id, user_id),
        KEY idx_branch_memberships_user_status (user_id, status),
        CONSTRAINT fk_branch_memberships_branch FOREIGN KEY (branch_id) REFERENCES branches(id),
        CONSTRAINT fk_branch_memberships_user FOREIGN KEY (user_id) REFERENCES users(id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci',
    'SELECT 1'
);
PREPARE m1_branch_memberships_stmt FROM @m1_branch_memberships_ddl;
EXECUTE m1_branch_memberships_stmt;
DEALLOCATE PREPARE m1_branch_memberships_stmt;
