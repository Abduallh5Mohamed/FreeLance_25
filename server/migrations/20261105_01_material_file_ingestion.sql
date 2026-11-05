-- BUILD-06, 2026-11-05, FILE ONLY, not applied. Requires verified source schema.
-- Existing unclassified rows cannot be resumed as an owner upload (request/actor NULL).
ALTER TABLE course_material_files
  ADD COLUMN upload_request_id CHAR(36) NULL,
  ADD COLUMN uploaded_by CHAR(36) NULL,
  ADD COLUMN upload_status ENUM('reserved','stored','complete') NULL DEFAULT NULL,
  ADD UNIQUE KEY uq_material_file_upload_request (tenant_id,upload_request_id);
-- A committed reservation is the durable recovery root before any object write.
-- Never delete an ambiguous object on commit failure; reconcile the same request/key.
