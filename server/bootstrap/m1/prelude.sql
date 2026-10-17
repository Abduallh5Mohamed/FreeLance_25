-- Reviewed M1 fresh-install dependency prelude. Generated before tracked
-- migrations so instructor_system can reference lectures and enrollment can
-- reference groups.instructor_id. The later source migration retains ownership
-- of lectures.price and lectures.archived_at.
CREATE TABLE lectures (
  id CHAR(36) NOT NULL PRIMARY KEY,
  course_id CHAR(36) NOT NULL,
  grade_id CHAR(36) NULL,
  group_id CHAR(36) NULL,
  title VARCHAR(255) NOT NULL,
  description TEXT NULL,
  video_url TEXT NULL,
  duration_minutes INT NULL,
  display_order INT NOT NULL DEFAULT 0,
  is_free BOOLEAN NOT NULL DEFAULT FALSE,
  is_published BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_lectures_course (course_id),
  INDEX idx_lectures_visibility (is_published, grade_id, group_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

ALTER TABLE `groups`
  ADD COLUMN instructor_id CHAR(36) NULL AFTER grade_id,
  ADD INDEX idx_group_instructor (instructor_id);
