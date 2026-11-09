-- Additive. Apply only to an explicitly authorized environment.
-- The academic period remains the existing planning catalog; no enrollment,
-- payment, schedule, publication or access is copied or created here.
CREATE TABLE season_course_reuse_operations (
 tenant_id CHAR(36) NOT NULL,
 operation_id CHAR(36) NOT NULL,
 actor_user_id CHAR(36) NOT NULL,
 period_id CHAR(36) NOT NULL,
 source_course_id CHAR(36) NOT NULL,
 target_course_id CHAR(36) NOT NULL,
 request_hash CHAR(64) NOT NULL,
 target_name VARCHAR(255) NOT NULL,
 period_name VARCHAR(255) NOT NULL,
 starts_on DATE NOT NULL,
 ends_on DATE NOT NULL,
 created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
 PRIMARY KEY(tenant_id,operation_id),
 UNIQUE KEY uq_season_course_source(tenant_id,period_id,source_course_id),
 UNIQUE KEY uq_season_target(target_course_id),
 KEY idx_season_reuse_history(tenant_id,operation_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
