-- Tables and columns required by tenant-scoped file delivery and legacy
-- subscription-request flows. This runs after 20260921_saas_foundation.sql.
CREATE TABLE IF NOT EXISTS subscription_requests (
  id CHAR(36) PRIMARY KEY,
  tenant_id CHAR(36) NOT NULL,
  student_name VARCHAR(255) NOT NULL,
  phone VARCHAR(30) NOT NULL,
  guardian_phone VARCHAR(30) NULL,
  grade_id CHAR(36) NULL,
  grade_name VARCHAR(255) NULL,
  group_id CHAR(36) NULL,
  group_name VARCHAR(255) NULL,
  subscription_plan_id CHAR(36) NULL,
  subscription_plan_name VARCHAR(255) NULL,
  amount DECIMAL(12,2) NULL,
  notes TEXT NULL,
  receipt_image_url VARCHAR(1000) NULL,
  status ENUM('pending','approved','rejected') NOT NULL DEFAULT 'pending',
  rejection_reason VARCHAR(1000) NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (tenant_id) REFERENCES tenants(id),
  INDEX idx_subscription_requests_tenant_status (tenant_id,status,created_at),
  INDEX idx_subscription_requests_guardian_phone (guardian_phone)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS tenant_media_files (
  id CHAR(36) PRIMARY KEY,
  tenant_id CHAR(36) NOT NULL,
  uploaded_by CHAR(36) NOT NULL,
  storage_path VARCHAR(1000) NOT NULL,
  original_name VARCHAR(255) NOT NULL,
  mime_type VARCHAR(150) NOT NULL,
  byte_size BIGINT UNSIGNED NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (tenant_id) REFERENCES tenants(id),
  FOREIGN KEY (uploaded_by) REFERENCES users(id),
  INDEX idx_tenant_media_owner (tenant_id,created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

ALTER TABLE videos ADD COLUMN tenant_id CHAR(36) NULL AFTER course_id;
ALTER TABLE videos ADD INDEX idx_videos_tenant_status (tenant_id,status);
ALTER TABLE videos ADD CONSTRAINT fk_videos_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id);

ALTER TABLE video_processing_queue ADD COLUMN tenant_id CHAR(36) NULL AFTER video_id;
ALTER TABLE video_processing_queue ADD INDEX idx_video_queue_tenant (tenant_id,status,created_at);
