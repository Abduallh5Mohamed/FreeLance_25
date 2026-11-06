-- FILE ONLY. Verify target types/engines and authorize separately before application.
-- Private same-course saved lesson-package templates with immutable revisions.
-- Stores reference kinds, source ids and original media positions only: no
-- content bodies, URLs/keys, student records, quiz pins, publication or grants.
CREATE TABLE lesson_package_templates (
  id CHAR(36) NOT NULL,
  tenant_id VARCHAR(64) NOT NULL,
  course_id CHAR(36) NOT NULL,
  name VARCHAR(120) NOT NULL,
  status ENUM('active','archived') NOT NULL DEFAULT 'active',
  head_revision INT NOT NULL,
  created_by VARCHAR(64) NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  archived_at TIMESTAMP NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_lesson_template_name (tenant_id,course_id,name),
  KEY ix_lesson_template_list (tenant_id,course_id,status,id),
  CONSTRAINT ck_lesson_template_head CHECK (head_revision>=1)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;

CREATE TABLE lesson_package_template_revisions (
  id CHAR(36) NOT NULL,
  template_id CHAR(36) NOT NULL,
  tenant_id VARCHAR(64) NOT NULL,
  course_id CHAR(36) NOT NULL,
  revision_number INT NOT NULL,
  source_lesson_id CHAR(36) NOT NULL,
  created_by VARCHAR(64) NOT NULL,
  reference_count INT NOT NULL,
  media_count INT NOT NULL,
  content_hash CHAR(64) NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_template_revision_number (template_id,revision_number),
  KEY ix_template_revision_tenant (tenant_id,course_id,template_id,revision_number),
  CONSTRAINT fk_template_revision_template FOREIGN KEY (template_id) REFERENCES lesson_package_templates (id) ON DELETE RESTRICT,
  CONSTRAINT ck_lesson_template_revision_counts CHECK (revision_number>=1 AND reference_count BETWEEN 1 AND 23 AND media_count BETWEEN 0 AND 20)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;

CREATE TABLE lesson_package_template_references (
  id CHAR(36) NOT NULL,
  revision_id CHAR(36) NOT NULL,
  kind ENUM('material','video','homework','quiz','announcement') NOT NULL,
  source_id CHAR(36) NOT NULL,
  display_order INT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_template_reference (revision_id,kind,source_id),
  KEY ix_template_reference_order (revision_id,display_order,id),
  CONSTRAINT fk_template_reference_revision FOREIGN KEY (revision_id) REFERENCES lesson_package_template_revisions (id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;
