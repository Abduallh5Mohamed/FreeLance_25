-- Additive schema only. Applying this file is a separate environment action.
-- No imported row, account, enrollment, course or verification is backfilled.
CREATE TABLE student_account_link_requests (
 id CHAR(36) NOT NULL PRIMARY KEY,
 tenant_id VARCHAR(64) NOT NULL,
 user_id VARCHAR(64) NOT NULL,
 invite_id CHAR(36) NOT NULL,
 challenge_id VARCHAR(64) NOT NULL,
 contact_hash CHAR(64) NOT NULL,
 request_hash CHAR(64) NOT NULL,
 status ENUM('pending','linked','withdrawn') NOT NULL DEFAULT 'pending',
 expires_at DATETIME NOT NULL,
 created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
 UNIQUE KEY uq_account_link_challenge (challenge_id),
 INDEX idx_account_link_owner (tenant_id,status,id),
 INDEX idx_account_link_identity (tenant_id,user_id,status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;

CREATE TABLE student_account_link_operations (
 tenant_id VARCHAR(64) NOT NULL,
 operation_id CHAR(36) NOT NULL,
 actor_user_id VARCHAR(64) NOT NULL,
 request_id CHAR(36) NOT NULL,
 student_id CHAR(36) NOT NULL,
 user_id VARCHAR(64) NOT NULL,
 request_hash CHAR(64) NOT NULL,
 created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
 PRIMARY KEY (tenant_id,operation_id),
 UNIQUE KEY uq_account_link_request (tenant_id,request_id),
 UNIQUE KEY uq_account_link_student (tenant_id,student_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;
