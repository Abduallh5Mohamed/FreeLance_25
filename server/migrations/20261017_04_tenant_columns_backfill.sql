-- Add nullable tenant ownership to route-scoped resource tables.
-- Backfills are conservative and re-runnable; ambiguous exam ownership stays NULL.
-- Every DDL operation is guarded. This migration is authored only; do not execute it.

-- `groups`.tenant_id
SET @col_exists = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'groups' AND COLUMN_NAME = 'tenant_id');
SET @sql = IF(@col_exists = 0,
  'ALTER TABLE `groups` ADD COLUMN tenant_id CHAR(36) NULL',
  'SELECT 1');
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @idx_exists = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.STATISTICS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'groups' AND INDEX_NAME = 'idx_groups_tenant');
SET @sql = IF(@idx_exists = 0,
  'ALTER TABLE `groups` ADD INDEX idx_groups_tenant (tenant_id)',
  'SELECT 1');
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @fk_exists = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.TABLE_CONSTRAINTS
  WHERE CONSTRAINT_SCHEMA = DATABASE() AND TABLE_NAME = 'groups' AND CONSTRAINT_NAME = 'fk_groups_tenant');
SET @orphan_count = (SELECT COUNT(*) FROM `groups` g
  LEFT JOIN tenants t ON t.id = g.tenant_id
  WHERE g.tenant_id IS NOT NULL AND t.id IS NULL);
SET @sql = CASE
  WHEN @fk_exists > 0 THEN 'SELECT 1'
  WHEN @orphan_count = 0 THEN 'ALTER TABLE `groups` ADD CONSTRAINT fk_groups_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE RESTRICT'
  ELSE 'SELECT m1_orphan_groups_tenant_ids_require_manual_review'
END;
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- lectures.tenant_id
SET @col_exists = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'lectures' AND COLUMN_NAME = 'tenant_id');
SET @sql = IF(@col_exists = 0,
  'ALTER TABLE lectures ADD COLUMN tenant_id CHAR(36) NULL',
  'SELECT 1');
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @idx_exists = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.STATISTICS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'lectures' AND INDEX_NAME = 'idx_lectures_tenant');
SET @sql = IF(@idx_exists = 0,
  'ALTER TABLE lectures ADD INDEX idx_lectures_tenant (tenant_id)',
  'SELECT 1');
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @fk_exists = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.TABLE_CONSTRAINTS
  WHERE CONSTRAINT_SCHEMA = DATABASE() AND TABLE_NAME = 'lectures' AND CONSTRAINT_NAME = 'fk_lectures_tenant');
SET @orphan_count = (SELECT COUNT(*) FROM lectures l
  LEFT JOIN tenants t ON t.id = l.tenant_id
  WHERE l.tenant_id IS NOT NULL AND t.id IS NULL);
SET @sql = CASE
  WHEN @fk_exists > 0 THEN 'SELECT 1'
  WHEN @orphan_count = 0 THEN 'ALTER TABLE lectures ADD CONSTRAINT fk_lectures_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE RESTRICT'
  ELSE 'SELECT m1_orphan_lectures_tenant_ids_require_manual_review'
END;
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- exams.tenant_id
SET @col_exists = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'exams' AND COLUMN_NAME = 'tenant_id');
SET @sql = IF(@col_exists = 0,
  'ALTER TABLE exams ADD COLUMN tenant_id CHAR(36) NULL',
  'SELECT 1');
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @idx_exists = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.STATISTICS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'exams' AND INDEX_NAME = 'idx_exams_tenant');
SET @sql = IF(@idx_exists = 0,
  'ALTER TABLE exams ADD INDEX idx_exams_tenant (tenant_id)',
  'SELECT 1');
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @fk_exists = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.TABLE_CONSTRAINTS
  WHERE CONSTRAINT_SCHEMA = DATABASE() AND TABLE_NAME = 'exams' AND CONSTRAINT_NAME = 'fk_exams_tenant');
SET @orphan_count = (SELECT COUNT(*) FROM exams e
  LEFT JOIN tenants t ON t.id = e.tenant_id
  WHERE e.tenant_id IS NOT NULL AND t.id IS NULL);
SET @sql = CASE
  WHEN @fk_exists > 0 THEN 'SELECT 1'
  WHEN @orphan_count = 0 THEN 'ALTER TABLE exams ADD CONSTRAINT fk_exams_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE RESTRICT'
  ELSE 'SELECT m1_orphan_exams_tenant_ids_require_manual_review'
END;
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- Course provenance is authoritative. An instructor may teach in multiple tenants;
-- their separately owned tenant must never determine another course's ownership.
-- Rows with no valid course/tenant remain NULL for manual review.
UPDATE `groups` g
INNER JOIN courses c ON c.id = g.course_id
INNER JOIN tenants t ON t.id = c.tenant_id
SET g.tenant_id = t.id
WHERE g.tenant_id IS NULL;

UPDATE lectures l
INNER JOIN courses c ON c.id = l.course_id
INNER JOIN tenants t ON t.id = c.tenant_id
SET l.tenant_id = t.id
WHERE l.tenant_id IS NULL;

-- Exams inherit ownership only when every attached group resolves to the same tenant.
-- Exams with no groups, unowned groups, or groups spanning tenants remain NULL.
UPDATE exams e
INNER JOIN (
  SELECT eg.exam_id, MIN(t.id) AS tenant_id
  FROM exam_groups eg
  INNER JOIN `groups` g ON g.id = eg.group_id
  LEFT JOIN courses c ON c.id = g.course_id
  LEFT JOIN tenants t ON t.id = c.tenant_id
  GROUP BY eg.exam_id
  HAVING COUNT(*) = COUNT(t.id) AND COUNT(DISTINCT t.id) = 1
) exam_owners ON exam_owners.exam_id = e.id
SET e.tenant_id = exam_owners.tenant_id
WHERE e.tenant_id IS NULL;
