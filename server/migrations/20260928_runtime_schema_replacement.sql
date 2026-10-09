-- Static replacement for schema DDL formerly executed from HTTP routes.
ALTER TABLE `groups`
  ADD COLUMN instructor_id CHAR(36) NULL AFTER grade_id,
  ADD INDEX idx_group_instructor (instructor_id);

ALTER TABLE expenses
  ADD COLUMN tenant_id CHAR(36) NULL AFTER id,
  ADD INDEX idx_expenses_tenant_date (tenant_id,date);

ALTER TABLE imports
  ADD COLUMN tenant_id CHAR(36) NULL AFTER id,
  ADD INDEX idx_imports_tenant_created (tenant_id,created_at);

CREATE TABLE student_fees (
  id CHAR(36) PRIMARY KEY DEFAULT (UUID()),
  tenant_id CHAR(36) NOT NULL,
  student_id CHAR(36) NULL,
  student_name VARCHAR(255) NOT NULL,
  phone VARCHAR(50) NULL,
  guardian_phone VARCHAR(50) NULL,
  grade_id CHAR(36) NULL,
  grade_name VARCHAR(255) NULL,
  group_id CHAR(36) NULL,
  group_name VARCHAR(255) NULL,
  barcode VARCHAR(50) NULL,
  amount DECIMAL(10,2) NOT NULL DEFAULT 0,
  paid_amount DECIMAL(10,2) NOT NULL DEFAULT 0,
  remaining_amount DECIMAL(10,2) GENERATED ALWAYS AS (amount-paid_amount) STORED,
  status ENUM('pending','partial','paid','overdue') NOT NULL DEFAULT 'pending',
  payment_method ENUM('cash','bank','card','online') NOT NULL DEFAULT 'cash',
  is_offline BOOLEAN NOT NULL DEFAULT FALSE,
  notes TEXT NULL,
  due_date DATE NULL,
  payment_date DATE NULL,
  payment_year INT NULL,
  payment_month INT NULL,
  receipt_image_url TEXT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_student_fees_tenant (tenant_id,student_id),
  INDEX idx_student_fees_tenant_status (tenant_id,status),
  UNIQUE KEY uq_student_fee_month (tenant_id,student_id,payment_year,payment_month),
  FOREIGN KEY (tenant_id) REFERENCES tenants(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE revenues (
  id CHAR(36) PRIMARY KEY DEFAULT (UUID()),
  tenant_id CHAR(36) NOT NULL,
  amount DECIMAL(10,2) NOT NULL,
  source VARCHAR(255) NOT NULL,
  description TEXT NULL,
  date DATE NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_revenues_tenant_date (tenant_id,date),
  INDEX idx_revenues_tenant_source (tenant_id,source),
  FOREIGN KEY (tenant_id) REFERENCES tenants(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE import_items (
  id CHAR(36) PRIMARY KEY DEFAULT (UUID()),
  import_id CHAR(36) NOT NULL,
  item_code VARCHAR(100) NULL,
  item_name VARCHAR(255) NOT NULL,
  quantity INT NOT NULL,
  unit_price DECIMAL(10,2) NOT NULL,
  total_price DECIMAL(10,2) GENERATED ALWAYS AS (quantity*unit_price) STORED,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (import_id) REFERENCES imports(id) ON DELETE CASCADE,
  INDEX idx_import_items_import (import_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
