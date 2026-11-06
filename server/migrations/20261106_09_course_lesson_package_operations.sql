-- FILE ONLY. Verify target types/engines and authorize separately before application.
-- Durable idempotency receipt, independent of mutable lesson/source lifetimes.
-- No copied content, student identity, attempt, permission or publication payload.
CREATE TABLE course_lesson_package_operations (
  tenant_id VARCHAR(64) NOT NULL,
  operation_id CHAR(36) NOT NULL,
  actor_user_id VARCHAR(64) NOT NULL,
  course_id CHAR(36) NOT NULL,
  lesson_id CHAR(36) NOT NULL,
  request_hash CHAR(64) NOT NULL,
  created_count INT NOT NULL,
  existing_count INT NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (tenant_id,operation_id),
  CONSTRAINT ck_lesson_package_counts CHECK (created_count>=0 AND existing_count>=0 AND created_count+existing_count BETWEEN 1 AND 23)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;
