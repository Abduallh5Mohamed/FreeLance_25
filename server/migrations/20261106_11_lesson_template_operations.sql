-- FILE ONLY. Verify target types/engines and authorize separately before application.
-- Durable idempotency receipt for applying one template revision to one
-- destination lesson with one explicit timing choice. Independent of mutable
-- template/source lifetimes; holds no copied content, identity or grant.
CREATE TABLE lesson_template_operations (
  tenant_id VARCHAR(64) NOT NULL,
  operation_id CHAR(36) NOT NULL,
  actor_user_id VARCHAR(64) NOT NULL,
  course_id CHAR(36) NOT NULL,
  lesson_id CHAR(36) NOT NULL,
  template_id CHAR(36) NOT NULL,
  revision_number INT NOT NULL,
  timing_mode ENUM('keep','set','clear') NOT NULL,
  release_at_epoch INT NULL,
  request_hash CHAR(64) NOT NULL,
  created_count INT NOT NULL,
  existing_count INT NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (tenant_id,operation_id),
  CONSTRAINT ck_lesson_template_operation_counts CHECK (created_count>=0 AND existing_count>=0 AND created_count+existing_count BETWEEN 1 AND 23)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;

-- Independent historical receipts for owner library writes; no cascading
-- deletion with mutable templates. Applying this file is NOT authorized here.
CREATE TABLE lesson_template_library_operations (
  tenant_id VARCHAR(64) NOT NULL,
  operation_id CHAR(36) NOT NULL,
  actor_user_id VARCHAR(64) NOT NULL,
  course_id CHAR(36) NOT NULL,
  operation_kind ENUM('create','revise','archive') NOT NULL,
  template_id CHAR(36) NULL,
  request_hash CHAR(64) NOT NULL,
  result_template_id CHAR(36) NOT NULL,
  result_name VARCHAR(120) NOT NULL,
  result_status ENUM('active','archived') NOT NULL,
  result_head_revision INT NOT NULL,
  result_revision_number INT NULL,
  result_reference_count INT NULL,
  result_media_count INT NULL,
  result_unchanged TINYINT NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (tenant_id,operation_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;
