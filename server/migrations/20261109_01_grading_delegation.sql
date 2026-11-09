-- Additive; apply only to an explicitly authorized environment.
CREATE TABLE exam_grading_assignments (
 id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
 tenant_id VARCHAR(64) COLLATE utf8mb4_bin NOT NULL,
 question_ref CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
 assignee_user_id VARCHAR(64) COLLATE utf8mb4_bin NOT NULL,
 rubric_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
 status ENUM('active','revoked') NOT NULL,
 version INT UNSIGNED NOT NULL DEFAULT 0,
 PRIMARY KEY(id), UNIQUE KEY uq_grading_assignment_question(tenant_id,question_ref),
 KEY idx_grading_assignment_actor(tenant_id,assignee_user_id,status,id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;
CREATE TABLE exam_rubric_awards (
 tenant_id VARCHAR(64) COLLATE utf8mb4_bin NOT NULL,
 attempt_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
 question_ref CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
 revision INT UNSIGNED NOT NULL,
 assignment_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
 assignment_version INT UNSIGNED NOT NULL,
 rubric_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
 actor_user_id VARCHAR(64) COLLATE utf8mb4_bin NOT NULL,
 marks JSON NOT NULL,
 PRIMARY KEY(tenant_id,attempt_id,question_ref,revision)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;
CREATE TABLE exam_grading_control_operations (
 tenant_id VARCHAR(64) COLLATE utf8mb4_bin NOT NULL,
 operation_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
 actor_user_id VARCHAR(64) COLLATE utf8mb4_bin NOT NULL,
 course_id VARCHAR(64) COLLATE utf8mb4_bin NOT NULL,
 request_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
 result JSON NOT NULL,
 PRIMARY KEY(tenant_id,operation_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;
