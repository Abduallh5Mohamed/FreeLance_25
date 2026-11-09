-- Additive. Apply only with authorization for the exact target environment.
-- Immutable criteria snapshots; never edits exam snapshots or prior grades.
CREATE TABLE exam_grading_rubrics (
  id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  tenant_id VARCHAR(64) COLLATE utf8mb4_bin NOT NULL,
  question_ref CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  revision INT UNSIGNED NOT NULL,
  criteria JSON NOT NULL,
  total_points DECIMAL(10,2) NOT NULL,
  created_by VARCHAR(64) COLLATE utf8mb4_bin NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_grading_rubric_revision (tenant_id,question_ref,revision)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;
CREATE TABLE exam_rubric_operations (
  tenant_id VARCHAR(64) COLLATE utf8mb4_bin NOT NULL,
  operation_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  actor_user_id VARCHAR(64) COLLATE utf8mb4_bin NOT NULL,
  request_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  result JSON NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (tenant_id,operation_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;
