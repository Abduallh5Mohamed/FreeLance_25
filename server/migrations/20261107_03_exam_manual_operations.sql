-- Additive FILE ONLY. Applying it requires its own environment authorization.
-- Receipts contain only grading outcome metadata, never answers/feedback.
CREATE INDEX idx_manual_question_queue ON exam_versioned_attempts (tenant_id,exam_version_id,status,id);
CREATE TABLE exam_manual_operations (
    tenant_id VARCHAR(64) COLLATE utf8mb4_bin NOT NULL,
    operation_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    actor_user_id VARCHAR(64) COLLATE utf8mb4_bin NOT NULL,
    attempt_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    request_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    result JSON NOT NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (tenant_id,operation_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;
