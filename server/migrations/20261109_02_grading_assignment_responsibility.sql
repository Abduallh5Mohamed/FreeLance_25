-- No inferred/backfilled grants. Existing assignments require explicit teacher renewal.
ALTER TABLE exam_grading_assignments
  ADD COLUMN responsible_user_id VARCHAR(64) COLLATE utf8mb4_bin NULL;
