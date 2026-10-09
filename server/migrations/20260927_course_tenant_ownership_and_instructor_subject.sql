-- Instructor course isolation and a free-text teaching subject on profiles.

ALTER TABLE tenants
  ADD COLUMN subject_type VARCHAR(80) NULL AFTER business_name;

ALTER TABLE courses
  ADD COLUMN tenant_id CHAR(36) NULL AFTER id,
  ADD COLUMN instructor_id CHAR(36) NULL AFTER tenant_id,
  ADD INDEX idx_courses_tenant_active (tenant_id,is_active),
  ADD INDEX idx_courses_instructor_active (instructor_id,is_active),
  ADD CONSTRAINT fk_courses_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE SET NULL,
  ADD CONSTRAINT fk_courses_instructor FOREIGN KEY (instructor_id) REFERENCES users(id) ON DELETE SET NULL;

-- Only backfill when every owned lecture under a course points to one instructor.
UPDATE courses c
INNER JOIN (
  SELECT course_id,MIN(instructor_id) instructor_id
  FROM lectures
  WHERE instructor_id IS NOT NULL
  GROUP BY course_id
  HAVING COUNT(DISTINCT instructor_id)=1
) owned ON owned.course_id=c.id
INNER JOIN tenants t ON t.owner_user_id=owned.instructor_id
SET c.instructor_id=owned.instructor_id,c.tenant_id=t.id
WHERE c.instructor_id IS NULL AND c.tenant_id IS NULL;
