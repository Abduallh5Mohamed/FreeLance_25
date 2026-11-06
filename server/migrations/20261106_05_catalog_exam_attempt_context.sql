-- FILE ONLY. No application, historical backfill or attempt activation.
-- Immutable binding is inserted with its attempt, never attached afterwards.
ALTER TABLE exam_versioned_attempts ADD COLUMN catalog_context JSON NULL;
