-- Additive SaaS foundation. Back up and test against a copy of each environment
-- before applying. Legacy student subscriptions and wallet rows are untouched.

CREATE TABLE IF NOT EXISTS tenants (
  id CHAR(36) PRIMARY KEY,
  owner_user_id CHAR(36) NOT NULL UNIQUE,
  business_name VARCHAR(255) NOT NULL,
  status ENUM('pending','active','suspended','archived') NOT NULL DEFAULT 'pending',
  legacy_compat BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (owner_user_id) REFERENCES users(id),
  INDEX idx_tenants_status (status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS tenant_memberships (
  id CHAR(36) PRIMARY KEY,
  tenant_id CHAR(36) NOT NULL,
  user_id CHAR(36) NOT NULL,
  role_key VARCHAR(40) NOT NULL,
  status ENUM('active','inactive') NOT NULL DEFAULT 'active',
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_tenant_user (tenant_id,user_id),
  FOREIGN KEY (tenant_id) REFERENCES tenants(id),
  FOREIGN KEY (user_id) REFERENCES users(id),
  INDEX idx_tenant_memberships_user (user_id,status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS platform_plans (
  id CHAR(36) PRIMARY KEY,
  code VARCHAR(60) NOT NULL UNIQUE,
  name VARCHAR(255) NOT NULL,
  duration_months SMALLINT NOT NULL,
  price DECIMAL(12,2) NOT NULL,
  currency CHAR(3) NOT NULL DEFAULT 'EGP',
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK (duration_months > 0),
  CHECK (price >= 0)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS tenant_subscriptions (
  id CHAR(36) PRIMARY KEY,
  tenant_id CHAR(36) NOT NULL,
  plan_id CHAR(36) NOT NULL,
  status ENUM('pending','active','past_due','grace_period','expired','cancelled') NOT NULL DEFAULT 'pending',
  agreed_price DECIMAL(12,2) NOT NULL,
  discount_amount DECIMAL(12,2) NOT NULL DEFAULT 0,
  currency CHAR(3) NOT NULL DEFAULT 'EGP',
  starts_at DATETIME NULL,
  period_ends_at DATETIME NULL,
  grace_until DATETIME NULL,
  cancel_at_period_end BOOLEAN NOT NULL DEFAULT FALSE,
  created_by CHAR(36) NOT NULL,
  approved_by CHAR(36) NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (tenant_id) REFERENCES tenants(id),
  FOREIGN KEY (plan_id) REFERENCES platform_plans(id),
  FOREIGN KEY (created_by) REFERENCES users(id),
  FOREIGN KEY (approved_by) REFERENCES users(id),
  INDEX idx_tenant_subscription (tenant_id,status),
  INDEX idx_subscription_expiry (status,period_ends_at),
  CHECK (agreed_price >= 0),
  CHECK (discount_amount >= 0 AND discount_amount <= agreed_price)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS platform_payment_attempts (
  id CHAR(36) PRIMARY KEY,
  subscription_id CHAR(36) NOT NULL,
  amount DECIMAL(12,2) NOT NULL,
  currency CHAR(3) NOT NULL DEFAULT 'EGP',
  method VARCHAR(40) NOT NULL,
  reference_number VARCHAR(160) NULL,
  proof_object_key VARCHAR(500) NULL,
  status ENUM('submitted','verified','rejected') NOT NULL DEFAULT 'submitted',
  submitted_by CHAR(36) NOT NULL,
  reviewed_by CHAR(36) NULL,
  reviewed_at DATETIME NULL,
  rejection_reason VARCHAR(500) NULL,
  idempotency_key VARCHAR(120) NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (subscription_id) REFERENCES tenant_subscriptions(id),
  FOREIGN KEY (submitted_by) REFERENCES users(id),
  FOREIGN KEY (reviewed_by) REFERENCES users(id),
  UNIQUE KEY uq_platform_payment_key (subscription_id,idempotency_key),
  INDEX idx_platform_payment_status (status,created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS tenant_invitations (
  id CHAR(36) PRIMARY KEY,
  tenant_id CHAR(36) NOT NULL,
  user_id CHAR(36) NOT NULL,
  token_hash CHAR(64) NOT NULL UNIQUE,
  expires_at DATETIME NOT NULL,
  used_at DATETIME NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (tenant_id) REFERENCES tenants(id),
  FOREIGN KEY (user_id) REFERENCES users(id),
  INDEX idx_invitation_user (user_id,used_at)
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

CREATE TABLE IF NOT EXISTS admin_roles (
  code VARCHAR(40) PRIMARY KEY,
  name VARCHAR(100) NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS admin_role_permissions (
  role_code VARCHAR(40) NOT NULL,
  permission_key VARCHAR(100) NOT NULL,
  PRIMARY KEY (role_code,permission_key),
  FOREIGN KEY (role_code) REFERENCES admin_roles(code)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS admin_user_roles (
  user_id CHAR(36) NOT NULL,
  role_code VARCHAR(40) NOT NULL,
  assigned_by CHAR(36) NULL,
  assigned_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (user_id,role_code),
  FOREIGN KEY (user_id) REFERENCES users(id),
  FOREIGN KEY (role_code) REFERENCES admin_roles(code),
  FOREIGN KEY (assigned_by) REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS audit_events (
  id CHAR(36) PRIMARY KEY,
  actor_user_id CHAR(36) NULL,
  tenant_id CHAR(36) NULL,
  action VARCHAR(100) NOT NULL,
  resource_type VARCHAR(60) NOT NULL,
  resource_id VARCHAR(100) NOT NULL,
  old_value JSON NULL,
  new_value JSON NULL,
  reason VARCHAR(1000) NULL,
  request_id VARCHAR(100) NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (actor_user_id) REFERENCES users(id),
  FOREIGN KEY (tenant_id) REFERENCES tenants(id),
  INDEX idx_audit_resource (resource_type,resource_id,created_at),
  INDEX idx_audit_actor (actor_user_id,created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

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

CREATE TABLE IF NOT EXISTS admin_teams (
  id CHAR(36) PRIMARY KEY,
  code VARCHAR(40) NOT NULL UNIQUE,
  name VARCHAR(100) NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS admin_team_memberships (
  team_id CHAR(36) NOT NULL,
  user_id CHAR(36) NOT NULL,
  PRIMARY KEY (team_id,user_id),
  FOREIGN KEY (team_id) REFERENCES admin_teams(id),
  FOREIGN KEY (user_id) REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS admin_work_items (
  id CHAR(36) PRIMARY KEY,
  type VARCHAR(50) NOT NULL,
  title VARCHAR(200) NOT NULL,
  description TEXT NULL,
  priority ENUM('low','normal','high','urgent','critical') NOT NULL DEFAULT 'normal',
  status ENUM('open','in_progress','waiting','blocked','pending_approval','escalated','resolved','closed','cancelled') NOT NULL DEFAULT 'open',
  created_by CHAR(36) NOT NULL,
  assigned_team_id CHAR(36) NULL,
  assigned_admin_id CHAR(36) NULL,
  tenant_id CHAR(36) NULL,
  resource_type VARCHAR(60) NULL,
  resource_id VARCHAR(100) NULL,
  due_at DATETIME NULL,
  sla_due_at DATETIME NULL,
  resolved_at DATETIME NULL,
  closed_at DATETIME NULL,
  resolution TEXT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (created_by) REFERENCES users(id),
  FOREIGN KEY (assigned_team_id) REFERENCES admin_teams(id),
  FOREIGN KEY (assigned_admin_id) REFERENCES users(id),
  FOREIGN KEY (tenant_id) REFERENCES tenants(id),
  INDEX idx_work_queue (assigned_team_id,status,due_at),
  INDEX idx_work_assignee (assigned_admin_id,status,due_at),
  INDEX idx_work_tenant (tenant_id,created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS admin_work_item_events (
  id CHAR(36) PRIMARY KEY,
  work_item_id CHAR(36) NOT NULL,
  actor_user_id CHAR(36) NOT NULL,
  event_type VARCHAR(50) NOT NULL,
  body TEXT NULL,
  old_value JSON NULL,
  new_value JSON NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (work_item_id) REFERENCES admin_work_items(id),
  FOREIGN KEY (actor_user_id) REFERENCES users(id),
  INDEX idx_work_events (work_item_id,created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS admin_approval_requests (
  id CHAR(36) PRIMARY KEY,
  action_key VARCHAR(100) NOT NULL,
  resource_type VARCHAR(60) NOT NULL,
  resource_id VARCHAR(100) NOT NULL,
  requested_value JSON NOT NULL,
  old_value JSON NULL,
  reason VARCHAR(1000) NOT NULL,
  status ENUM('pending','approved','rejected','cancelled','expired') NOT NULL DEFAULT 'pending',
  requested_by CHAR(36) NOT NULL,
  decided_by CHAR(36) NULL,
  decided_at DATETIME NULL,
  decision_reason VARCHAR(1000) NULL,
  work_item_id CHAR(36) NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (requested_by) REFERENCES users(id),
  FOREIGN KEY (decided_by) REFERENCES users(id),
  FOREIGN KEY (work_item_id) REFERENCES admin_work_items(id),
  INDEX idx_approval_queue (status,created_at),
  INDEX idx_approval_resource (resource_type,resource_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

INSERT IGNORE INTO admin_roles (code,name) VALUES
 ('super_admin','Super Admin'),('operations_admin','Operations Admin'),
 ('billing_admin','Billing Admin'),('support_admin','Support Admin'),
 ('security_admin','Security Admin'),('analyst','Analyst');

INSERT IGNORE INTO admin_teams (id,code,name) VALUES
 ('85aa5ef3-d05e-41bb-a61b-1d490cecd0c1','operations','Operations'),
 ('85aa5ef3-d05e-41bb-a61b-1d490cecd0c2','billing','Billing'),
 ('85aa5ef3-d05e-41bb-a61b-1d490cecd0c3','support','Support'),
 ('85aa5ef3-d05e-41bb-a61b-1d490cecd0c4','security','Security'),
 ('85aa5ef3-d05e-41bb-a61b-1d490cecd0c5','management','Management');

INSERT IGNORE INTO admin_role_permissions (role_code,permission_key) VALUES
 ('super_admin','admin.dashboard.read'),('super_admin','admin_roles.manage'),
 ('super_admin','instructor.read'),('super_admin','instructor.detail.read'),('super_admin','instructor.create'),('super_admin','instructor.update'),('super_admin','instructor.suspend'),('super_admin','instructor.delete'),
 ('super_admin','subscription.read'),('super_admin','subscription.create'),('super_admin','subscription.verify'),('super_admin','subscription.extend'),
 ('super_admin','platform_payment.read'),('super_admin','platform_payment.submit'),('super_admin','platform_payment.verify'),
 ('super_admin','student_payment.read'),('super_admin','finance.read'),('super_admin','finance.export'),
 ('super_admin','billing_profile.manage'),
 ('super_admin','service_credit.read'),('super_admin','service_credit.adjust'),
 ('super_admin','task.read'),('super_admin','task.create'),('super_admin','task.assign'),('super_admin','task.close'),
 ('super_admin','approval.read'),('super_admin','approval.approve'),('super_admin','support.read'),('super_admin','support.manage'),
 ('super_admin','audit.read'),('super_admin','security.read'),('super_admin','security.manage'),('super_admin','analytics.calculate'),('super_admin','analytics.export_pdf'),
 ('operations_admin','admin.dashboard.read'),('operations_admin','instructor.read'),('operations_admin','instructor.create'),
 ('operations_admin','instructor.update'),('operations_admin','instructor.suspend'),('operations_admin','subscription.read'),
 ('operations_admin','platform_payment.read'),('operations_admin','platform_payment.submit'),
 ('operations_admin','task.read'),('operations_admin','task.create'),('operations_admin','task.assign'),('operations_admin','task.close'),
 ('support_admin','admin.dashboard.read'),('support_admin','instructor.read'),('support_admin','instructor.detail.read'),('support_admin','subscription.read'),
 ('support_admin','student_payment.read'),('support_admin','task.read'),('support_admin','task.create'),
 ('support_admin','support.read'),('support_admin','support.manage'),
 ('billing_admin','admin.dashboard.read'),('billing_admin','instructor.read'),('billing_admin','subscription.read'),('billing_admin','subscription.create'),
 ('billing_admin','subscription.verify'),('billing_admin','platform_payment.read'),('billing_admin','platform_payment.submit'),('billing_admin','platform_payment.verify'),
 ('billing_admin','student_payment.read'),('billing_admin','finance.read'),('billing_admin','finance.export'),
 ('billing_admin','billing_profile.manage'),
 ('billing_admin','service_credit.read'),('billing_admin','task.read'),('billing_admin','task.create'),
 ('security_admin','admin.dashboard.read'),('security_admin','security.read'),('security_admin','security.manage'),
 ('security_admin','audit.read'),('security_admin','task.read'),
 ('analyst','admin.dashboard.read'),('analyst','finance.read'),('analyst','finance.export'),('analyst','analytics.calculate'),('analyst','analytics.export_pdf');

-- Only existing users whose role is already admin receive the bootstrap role.
-- Staff accounts are never promoted automatically.
INSERT IGNORE INTO admin_user_roles (user_id,role_code)
SELECT id,'super_admin' FROM users WHERE role = 'admin';

-- Put administrative roles in their operational queue automatically.
INSERT IGNORE INTO admin_team_memberships (team_id,user_id)
SELECT t.id,r.user_id FROM admin_user_roles r
INNER JOIN admin_teams t ON t.code=CASE r.role_code
  WHEN 'operations_admin' THEN 'operations'
  WHEN 'billing_admin' THEN 'billing'
  WHEN 'support_admin' THEN 'support'
  WHEN 'security_admin' THEN 'security'
  ELSE 'management' END;

-- Preserve existing instructor accounts without requiring a payment retroactively.
INSERT IGNORE INTO tenants (id,owner_user_id,business_name,status,legacy_compat)
SELECT UUID(),id,name,IF(is_active=1,'active','suspended'),TRUE
FROM users WHERE role='instructor';

INSERT IGNORE INTO tenant_memberships (id,tenant_id,user_id,role_key)
SELECT UUID(),id,owner_user_id,'owner' FROM tenants;
