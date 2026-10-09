CREATE TABLE student_enrollment_backfill_reviews (
  id CHAR(36) PRIMARY KEY,
  student_id CHAR(36) NOT NULL,
  reason VARCHAR(255) NOT NULL,
  status ENUM('pending','resolved') NOT NULL DEFAULT 'pending',
  resolved_by CHAR(36) NULL,
  resolved_at DATETIME NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_student_backfill_review (student_id),
  INDEX idx_student_backfill_status (status,created_at),
  FOREIGN KEY (student_id) REFERENCES students(id),
  FOREIGN KEY (resolved_by) REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

INSERT INTO student_enrollment_backfill_reviews (id,student_id,reason)
SELECT UUID(),s.id,
  CASE
    WHEN s.user_id IS NULL AND s.tenant_id IS NULL THEN 'user_and_instructor_ambiguous'
    WHEN s.user_id IS NULL THEN 'user_identity_ambiguous'
    ELSE 'instructor_workspace_ambiguous'
  END
FROM students s
WHERE s.user_id IS NULL OR s.tenant_id IS NULL;
