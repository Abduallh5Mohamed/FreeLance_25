-- FILE ONLY. No application, backfill or legacy pointer changes authorized.
-- Verify actual parent charset/collation/types/engine before application.
CREATE TABLE IF NOT EXISTS course_lesson_videos (
  id CHAR(36) PRIMARY KEY,
  lesson_id CHAR(36) NOT NULL,
  video_id VARCHAR(36) NOT NULL,
  display_order INT NOT NULL,
  CONSTRAINT fk_lesson_videos_lesson FOREIGN KEY (lesson_id) REFERENCES course_lessons(id),
  CONSTRAINT fk_lesson_videos_video FOREIGN KEY (video_id) REFERENCES videos(id),
  CONSTRAINT chk_lesson_videos_order CHECK (display_order >= 0),
  UNIQUE KEY uq_lesson_videos_source (lesson_id,video_id),
  UNIQUE KEY uq_lesson_videos_order (lesson_id,display_order)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
