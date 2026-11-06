-- FILE ONLY: no application, historical backfill, provider or student UI activation.
ALTER TABLE assignment_submissions
  ADD COLUMN catalog_context JSON NULL,
  ADD COLUMN catalog_request_key CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  ADD UNIQUE KEY uq_catalog_homework_request (tenant_id,student_enrollment_id,catalog_request_key);
