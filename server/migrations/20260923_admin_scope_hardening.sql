-- Adds an explicit permission for personally identifiable teaching detail.
-- Operations and Billing retain aggregate instructor counts; Support and Super
-- may drill into student/content rows when investigating a case.
INSERT IGNORE INTO admin_role_permissions (role_code,permission_key) VALUES
  ('super_admin','instructor.detail.read'),
  ('support_admin','instructor.detail.read'),
  ('analyst','finance.export'),
  ('super_admin','analytics.calculate'),
  ('super_admin','analytics.export_pdf'),
  ('analyst','analytics.calculate'),
  ('analyst','analytics.export_pdf'),
  ('super_admin','billing_profile.manage'),
  ('billing_admin','billing_profile.manage');

CREATE TABLE IF NOT EXISTS analyst_calculations (
  id CHAR(36) PRIMARY KEY,
  user_id CHAR(36) NOT NULL,
  name VARCHAR(100) NOT NULL,
  left_metric VARCHAR(80) NOT NULL,
  operator VARCHAR(30) NOT NULL,
  right_metric VARCHAR(80) NULL,
  constant_value DECIMAL(18,4) NULL,
  result_format ENUM('number','money','percent') NOT NULL DEFAULT 'number',
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  INDEX idx_analyst_calculation_user (user_id,created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS tenant_billing_profiles (
  tenant_id CHAR(36) PRIMARY KEY,
  billing_cycle_day TINYINT NOT NULL DEFAULT 1,
  reminder_days_before TINYINT NOT NULL DEFAULT 7,
  collection_status ENUM('good_standing','follow_up','overdue','disputed','exempt') NOT NULL DEFAULT 'good_standing',
  next_followup_at DATETIME NULL,
  updated_by CHAR(36) NULL,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (tenant_id) REFERENCES tenants(id),
  FOREIGN KEY (updated_by) REFERENCES users(id),
  CHECK (billing_cycle_day BETWEEN 1 AND 28),
  CHECK (reminder_days_before BETWEEN 0 AND 30),
  INDEX idx_billing_collection (collection_status,next_followup_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS tenant_account_notes (
  id CHAR(36) PRIMARY KEY,
  tenant_id CHAR(36) NOT NULL,
  note_type ENUM('general','collection','renewal','dispute','support') NOT NULL DEFAULT 'general',
  body VARCHAR(2000) NOT NULL,
  followup_at DATETIME NULL,
  created_by CHAR(36) NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (tenant_id) REFERENCES tenants(id),
  FOREIGN KEY (created_by) REFERENCES users(id),
  INDEX idx_account_notes_tenant (tenant_id,created_at),
  INDEX idx_account_notes_followup (followup_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
