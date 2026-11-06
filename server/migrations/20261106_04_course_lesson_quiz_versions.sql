-- FILE ONLY: not applied. No snapshot publication or attempt creation.
CREATE TABLE course_lesson_quiz_versions (
    content_id CHAR(36) NOT NULL,
    exam_id CHAR(36) NOT NULL,
    exam_version_id CHAR(36) NOT NULL,
    PRIMARY KEY (content_id),
    CONSTRAINT fk_lesson_quiz_version_content FOREIGN KEY (content_id) REFERENCES course_lesson_activities(id) ON DELETE CASCADE,
    CONSTRAINT fk_lesson_quiz_version_exam FOREIGN KEY (exam_id) REFERENCES exams(id) ON DELETE RESTRICT,
    CONSTRAINT fk_lesson_quiz_version_snapshot FOREIGN KEY (exam_version_id) REFERENCES exam_versions(id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
