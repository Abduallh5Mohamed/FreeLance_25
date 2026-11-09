-- FILE ONLY. No authorization to apply this migration to any database.
-- One current plan per tenant/course/enrollment, immutable revisions/receipts.
CREATE TABLE course_return_plans (
  id CHAR(36) NOT NULL,
  tenant_id VARCHAR(64) NOT NULL,
  course_id CHAR(36) NOT NULL,
  enrollment_id VARCHAR(64) NOT NULL,
  version INT NOT NULL,
  status ENUM('active','withdrawn') NOT NULL,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_return_plan_scope (tenant_id,course_id,enrollment_id),
  KEY ix_return_plan_student (tenant_id,enrollment_id,status,id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;
CREATE TABLE course_return_plan_revisions (
  plan_id CHAR(36) NOT NULL,
  version INT NOT NULL,
  actor_user_id VARCHAR(64) NOT NULL,
  from_at DATETIME NOT NULL,
  to_at DATETIME NOT NULL,
  steps JSON NOT NULL,
  status ENUM('active','withdrawn') NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (plan_id,version),
  CONSTRAINT fk_return_revision_plan FOREIGN KEY (plan_id) REFERENCES course_return_plans(id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;
CREATE TABLE course_return_plan_operations (
  tenant_id VARCHAR(64) NOT NULL,
  operation_id CHAR(36) NOT NULL,
  actor_user_id VARCHAR(64) NOT NULL,
  course_id CHAR(36) NOT NULL,
  enrollment_id VARCHAR(64) NOT NULL,
  request_hash CHAR(64) NOT NULL,
  plan_id CHAR(36) NOT NULL,
  version INT NOT NULL,
  status ENUM('active','withdrawn') NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (tenant_id,operation_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;
