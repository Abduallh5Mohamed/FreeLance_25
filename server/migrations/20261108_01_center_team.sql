-- Explicit center workforce; never a platform staff identity or tenant-wide teaching grant.
ALTER TABLE users ADD COLUMN center_account TINYINT(1) NOT NULL DEFAULT 0;
CREATE TABLE center_team_members (
 id CHAR(36) NOT NULL PRIMARY KEY, tenant_id CHAR(36) NOT NULL, user_id CHAR(36) NOT NULL,
 permissions JSON NOT NULL, status ENUM('active','suspended') NOT NULL DEFAULT 'active', version INT NOT NULL DEFAULT 0,
 created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
 UNIQUE KEY uq_center_team_user(user_id), KEY idx_center_team_tenant(tenant_id,id),
 FOREIGN KEY (tenant_id) REFERENCES tenants(id), FOREIGN KEY (user_id) REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
CREATE TABLE center_team_branches (
 member_id CHAR(36) NOT NULL, branch_id CHAR(36) NOT NULL, PRIMARY KEY(member_id,branch_id),
 FOREIGN KEY(member_id) REFERENCES center_team_members(id), FOREIGN KEY(branch_id) REFERENCES branches(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
CREATE TABLE center_team_tasks (
 id CHAR(36) NOT NULL PRIMARY KEY, tenant_id CHAR(36) NOT NULL, branch_id CHAR(36) NOT NULL,
 assigned_member_id CHAR(36) NOT NULL, title VARCHAR(200) NOT NULL,
 status ENUM('open','in_progress','resolved') NOT NULL DEFAULT 'open', version INT NOT NULL DEFAULT 0,
 due_at DATETIME NULL, created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
 KEY idx_center_tasks_owner(tenant_id,id), KEY idx_center_tasks_assignee(assigned_member_id,status,id),
 FOREIGN KEY(tenant_id) REFERENCES tenants(id), FOREIGN KEY(branch_id) REFERENCES branches(id), FOREIGN KEY(assigned_member_id) REFERENCES center_team_members(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
CREATE TABLE center_team_operations (
 id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL PRIMARY KEY, tenant_id CHAR(36) NOT NULL,
 actor_user_id CHAR(36) NOT NULL, kind VARCHAR(32) NOT NULL, fingerprint CHAR(64) NOT NULL, result JSON NOT NULL,
 created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
 FOREIGN KEY(tenant_id) REFERENCES tenants(id), FOREIGN KEY(actor_user_id) REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
