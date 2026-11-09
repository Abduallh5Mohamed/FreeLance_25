-- Additive operation receipts only; no activation, account or historical backfill.
CREATE TABLE student_offline_setup_operations (
 tenant_id VARCHAR(64) NOT NULL,
 operation_id CHAR(36) NOT NULL,
 actor_user_id VARCHAR(64) NOT NULL,
 student_id CHAR(36) NOT NULL,
 group_id CHAR(36) NOT NULL,
 course_id CHAR(36) NOT NULL,
 request_hash CHAR(64) NOT NULL,
 created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
 PRIMARY KEY (tenant_id,operation_id),
 UNIQUE KEY uq_offline_setup_student (tenant_id,student_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;
