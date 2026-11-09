-- Additive operation/lineage storage. No media copy, grant or publication.
CREATE TABLE season_template_import_operations (
 tenant_id VARCHAR(64) COLLATE utf8mb4_bin NOT NULL,
 operation_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
 actor_user_id VARCHAR(64) COLLATE utf8mb4_bin NOT NULL,
 source_template_id CHAR(36) NOT NULL,
 source_revision INT NOT NULL,
 source_course_id CHAR(36) NOT NULL,
 target_course_id CHAR(36) NOT NULL,
 target_template_id CHAR(36) NOT NULL,
 request_hash CHAR(64) NOT NULL,
 result JSON NOT NULL,
 created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
 PRIMARY KEY(tenant_id,operation_id),
 UNIQUE KEY uq_season_template_revision(tenant_id,target_course_id,source_template_id,source_revision)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;
