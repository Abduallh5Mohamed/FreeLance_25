-- Additive source file only. Do not apply without explicit deployment approval.
-- Existing tickets remain context-free; references never grant content access.
ALTER TABLE support_tickets
  ADD COLUMN context_kind ENUM('catalog_lesson') NULL DEFAULT NULL,
  ADD COLUMN context_tenant_id CHAR(36) NULL DEFAULT NULL,
  ADD COLUMN context_enrollment_id CHAR(36) NULL DEFAULT NULL,
  ADD COLUMN context_course_id CHAR(36) NULL DEFAULT NULL,
  ADD COLUMN context_lesson_id CHAR(36) NULL DEFAULT NULL,
  ADD CONSTRAINT chk_support_lesson_context CHECK (
    (context_kind IS NULL AND context_tenant_id IS NULL AND context_enrollment_id IS NULL AND context_course_id IS NULL AND context_lesson_id IS NULL)
    OR (context_kind IS NOT NULL AND context_kind='catalog_lesson' AND context_tenant_id IS NOT NULL AND context_enrollment_id IS NOT NULL AND context_course_id IS NOT NULL AND context_lesson_id IS NOT NULL)
  );
