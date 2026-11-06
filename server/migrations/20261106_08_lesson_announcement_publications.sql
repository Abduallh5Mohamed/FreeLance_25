-- FILE ONLY. Explicit catalog publication, independent of group management state.
CREATE TABLE course_lesson_announcement_publications (
  id CHAR(36) NOT NULL,
  content_id CHAR(36) NOT NULL,
  group_id CHAR(36) NOT NULL,
  source_fingerprint CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  published_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_lesson_announcement_publication (content_id),
  CONSTRAINT fk_lesson_announcement_publication_content FOREIGN KEY (content_id)
    REFERENCES course_lesson_announcements(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
