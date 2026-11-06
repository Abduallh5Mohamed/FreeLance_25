-- FILE ONLY: no application, source publication or student access authorized.
-- Two independent preparation slots, separate from the 20 material/video positions.
CREATE TABLE course_lesson_activities (
    id CHAR(36) NOT NULL,
    lesson_id CHAR(36) NOT NULL,
    kind ENUM('homework','quiz') NOT NULL,
    assignment_id CHAR(36) NULL,
    exam_id CHAR(36) NULL,
    PRIMARY KEY (id),
    UNIQUE KEY uq_lesson_activity_kind (lesson_id,kind),
    CONSTRAINT fk_lesson_activity_lesson FOREIGN KEY (lesson_id) REFERENCES course_lessons(id) ON DELETE CASCADE,
    CONSTRAINT fk_lesson_activity_assignment FOREIGN KEY (assignment_id) REFERENCES assignments(id) ON DELETE RESTRICT,
    CONSTRAINT fk_lesson_activity_exam FOREIGN KEY (exam_id) REFERENCES exams(id) ON DELETE RESTRICT,
    CONSTRAINT ck_lesson_activity_source CHECK (
      (kind='homework' AND assignment_id IS NOT NULL AND exam_id IS NULL) OR
      (kind='quiz' AND exam_id IS NOT NULL AND assignment_id IS NULL)
    )
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
