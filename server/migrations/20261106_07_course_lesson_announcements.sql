-- FILE ONLY. Owner preparation/preview, no delivery or student publication.
CREATE TABLE course_lesson_announcements (
  id CHAR(36) NOT NULL,
  lesson_id CHAR(36) NOT NULL,
  announcement_id CHAR(36) NOT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_lesson_announcement (lesson_id),
  CONSTRAINT fk_lesson_announcement_lesson FOREIGN KEY (lesson_id)
    REFERENCES course_lessons(id) ON DELETE CASCADE,
  CONSTRAINT fk_lesson_announcement_source FOREIGN KEY (announcement_id)
    REFERENCES group_announcements(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
