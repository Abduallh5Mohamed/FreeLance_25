-- Recover tables referenced by the tracked server source but absent from
-- tracked migration DDL. This file is declarative only; do not run from app code.
-- MySQL 8 / utf8mb4_unicode_ci matches the tracked legacy baseline.

SET @schema_name = DATABASE();

SET @table_exists = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_SCHEMA=@schema_name AND TABLE_NAME='lectures');
SET @ddl = IF(@table_exists=0, 'CREATE TABLE lectures (id CHAR(36) NOT NULL PRIMARY KEY, course_id CHAR(36) NOT NULL, grade_id CHAR(36) NULL, group_id CHAR(36) NULL, instructor_id CHAR(36) NULL, title VARCHAR(255) NOT NULL, description TEXT NULL, video_url TEXT NULL, duration_minutes INT NULL, price DECIMAL(10,2) NULL DEFAULT 0, display_order INT NOT NULL DEFAULT 0, is_free BOOLEAN NOT NULL DEFAULT FALSE, is_published BOOLEAN NOT NULL DEFAULT FALSE, archived_at TIMESTAMP NULL, created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP, INDEX idx_lectures_course (course_id), INDEX idx_lectures_instructor (instructor_id), INDEX idx_lectures_visibility (is_published, grade_id, group_id)) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci', 'SELECT 1');
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @table_exists = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_SCHEMA=@schema_name AND TABLE_NAME='messages');
-- A legacy messages table may use UUID text keys. Never treat CREATE IF NOT
-- EXISTS as proof of the numeric contract: fail closed and require a separately
-- approved data reconciliation when an existing key or reference differs.
SET @messages_id_type = (SELECT COLUMN_TYPE FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA=@schema_name AND TABLE_NAME='messages' AND COLUMN_NAME='id' LIMIT 1);
SET @messages_id_extra = (SELECT EXTRA FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA=@schema_name AND TABLE_NAME='messages' AND COLUMN_NAME='id' LIMIT 1);
SET @status_id_type = (SELECT COLUMN_TYPE FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA=@schema_name AND TABLE_NAME='message_status' AND COLUMN_NAME='message_id' LIMIT 1);
SET @status_table_exists = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_SCHEMA=@schema_name AND TABLE_NAME='message_status');
SET @conversation_id_type = (SELECT COLUMN_TYPE FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA=@schema_name AND TABLE_NAME='conversations' AND COLUMN_NAME='last_message_id' LIMIT 1);
SET @conversation_table_exists = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_SCHEMA=@schema_name AND TABLE_NAME='conversations');
SET @deletion_id_type = (SELECT COLUMN_TYPE FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA=@schema_name AND TABLE_NAME='message_deletions' AND COLUMN_NAME='message_id' LIMIT 1);
SET @deletion_table_exists = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_SCHEMA=@schema_name AND TABLE_NAME='message_deletions');
SET @message_contract_invalid = (@table_exists > 0 AND (LOWER(COALESCE(@messages_id_type, '')) <> 'bigint unsigned' OR LOWER(COALESCE(@messages_id_extra, '')) NOT LIKE '%auto_increment%'))
  OR (@status_table_exists > 0 AND (LOWER(COALESCE(@status_id_type, '')) <> 'bigint unsigned'))
  OR (@conversation_table_exists > 0 AND (LOWER(COALESCE(@conversation_id_type, '')) <> 'bigint unsigned'))
  OR (@deletion_table_exists > 0 AND (LOWER(COALESCE(@deletion_id_type, '')) <> 'bigint unsigned'));
SET @contract_guard_sql = IF(@message_contract_invalid, 'SELECT * FROM __M1_REVIEW_REQUIRED_existing_message_id_contract', 'SELECT 1');
PREPARE message_contract_guard FROM @contract_guard_sql;
EXECUTE message_contract_guard;
DEALLOCATE PREPARE message_contract_guard;
SET @ddl = IF(@table_exists=0, 'CREATE TABLE messages (id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY, sender_id CHAR(36) NOT NULL, receiver_id CHAR(36) NOT NULL, content TEXT NULL, message_type VARCHAR(32) NOT NULL DEFAULT ''text'', image_url TEXT NULL, is_edited BOOLEAN NOT NULL DEFAULT FALSE, edited_at DATETIME NULL, created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP, INDEX idx_messages_sender_receiver_created (sender_id, receiver_id, created_at), INDEX idx_messages_receiver_created (receiver_id, created_at)) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci', 'SELECT 1');
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @table_exists = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_SCHEMA=@schema_name AND TABLE_NAME='message_status');
SET @ddl = IF(@table_exists=0, 'CREATE TABLE message_status (message_id BIGINT UNSIGNED NOT NULL PRIMARY KEY, is_delivered BOOLEAN NOT NULL DEFAULT FALSE, delivered_at DATETIME NULL, is_read BOOLEAN NOT NULL DEFAULT FALSE, read_at DATETIME NULL, INDEX idx_message_status_read (is_read, message_id), CONSTRAINT fk_message_status_message FOREIGN KEY (message_id) REFERENCES messages(id) ON DELETE CASCADE) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci', 'SELECT 1');
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @table_exists = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_SCHEMA=@schema_name AND TABLE_NAME='conversations');
SET @ddl = IF(@table_exists=0, 'CREATE TABLE conversations (id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY, user1_id CHAR(36) NOT NULL, user2_id CHAR(36) NOT NULL, last_message_id BIGINT UNSIGNED NULL, unread_count_user1 INT UNSIGNED NOT NULL DEFAULT 0, unread_count_user2 INT UNSIGNED NOT NULL DEFAULT 0, created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP, UNIQUE KEY uq_conversation_pair (user1_id, user2_id), INDEX idx_conversations_user2_updated (user2_id, updated_at), CONSTRAINT fk_conversations_last_message FOREIGN KEY (last_message_id) REFERENCES messages(id) ON DELETE SET NULL) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci', 'SELECT 1');
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @table_exists = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_SCHEMA=@schema_name AND TABLE_NAME='user_online_status');
SET @ddl = IF(@table_exists=0, 'CREATE TABLE user_online_status (user_id CHAR(36) NOT NULL PRIMARY KEY, is_online BOOLEAN NOT NULL DEFAULT FALSE, socket_id VARCHAR(255) NULL, last_seen DATETIME NULL, updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci', 'SELECT 1');
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @table_exists = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_SCHEMA=@schema_name AND TABLE_NAME='message_deletions');
SET @ddl = IF(@table_exists=0, 'CREATE TABLE message_deletions (id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY, message_id BIGINT UNSIGNED NOT NULL, user_id CHAR(36) NOT NULL, deleted_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP, UNIQUE KEY uq_message_deletion_user (message_id, user_id), INDEX idx_message_deletions_user (user_id), CONSTRAINT fk_message_deletions_message FOREIGN KEY (message_id) REFERENCES messages(id) ON DELETE CASCADE) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci', 'SELECT 1');
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @table_exists = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_SCHEMA=@schema_name AND TABLE_NAME='subscription_plans');
SET @ddl = IF(@table_exists=0, 'CREATE TABLE subscription_plans (id CHAR(36) NOT NULL PRIMARY KEY, name VARCHAR(255) NOT NULL, duration_months INT UNSIGNED NOT NULL, price DECIMAL(10,2) NOT NULL, description TEXT NULL, is_active BOOLEAN NOT NULL DEFAULT TRUE, created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci', 'SELECT 1');
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @table_exists = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_SCHEMA=@schema_name AND TABLE_NAME='tenant_custom_domains');
SET @ddl = IF(@table_exists=0, 'CREATE TABLE tenant_custom_domains (hostname VARCHAR(253) NOT NULL PRIMARY KEY, tenant_id CHAR(36) NOT NULL, status ENUM(''pending'',''verified'') NOT NULL, verification_token VARCHAR(255) NOT NULL, txt_name VARCHAR(255) NOT NULL, created_at DATETIME NOT NULL, updated_at DATETIME NOT NULL, verified_at DATETIME NULL, UNIQUE KEY uq_tenant_domain (tenant_id, hostname), INDEX idx_tenant_domains_tenant (tenant_id), CONSTRAINT fk_tenant_domains_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci', 'SELECT 1');
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;
