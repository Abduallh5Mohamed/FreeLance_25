-- Tenant-owned payment request records used by the legacy payment workflow.
CREATE TABLE payment_requests (
  id CHAR(36) PRIMARY KEY,
  tenant_id CHAR(36) NOT NULL,
  student_id CHAR(36) NOT NULL,
  student_name VARCHAR(255) NOT NULL,
  phone VARCHAR(50) NULL,
  email VARCHAR(255) NULL,
  grade_id CHAR(36) NOT NULL,
  grade_name VARCHAR(255) NOT NULL DEFAULT '',
  group_id CHAR(36) NOT NULL,
  group_name VARCHAR(255) NOT NULL DEFAULT '',
  amount DECIMAL(10,2) NOT NULL,
  payment_method VARCHAR(40) NOT NULL DEFAULT 'cash',
  receipt_image_url VARCHAR(1000) NULL,
  notes TEXT NULL,
  status ENUM('pending','approved','rejected') NOT NULL DEFAULT 'pending',
  rejection_reason TEXT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (tenant_id) REFERENCES tenants(id),
  INDEX idx_payment_requests_tenant_status (tenant_id,status,created_at),
  INDEX idx_payment_requests_student (tenant_id,student_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
