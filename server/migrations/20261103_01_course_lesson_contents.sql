-- J02 owner preparation only. FILE ONLY: do not apply without explicit authorization.
-- Multiple existing course materials per lesson. No delivery, backfill or progress merge.
-- Parent/source charset, collation and engine must be checked against the target catalog
-- before application; the legacy baseline inherits the database default for materials.
CREATE TABLE IF NOT EXISTS course_lesson_contents (
  id CHAR(36) PRIMARY KEY,
  lesson_id CHAR(36) NOT NULL,
  material_id CHAR(36) NOT NULL,
  display_order INT NOT NULL,
  CONSTRAINT fk_lesson_contents_lesson FOREIGN KEY (lesson_id) REFERENCES course_lessons(id),
  CONSTRAINT fk_lesson_contents_material FOREIGN KEY (material_id) REFERENCES course_materials(id),
  CONSTRAINT chk_lesson_contents_order CHECK (display_order >= 0),
  UNIQUE KEY uq_lesson_contents_source (lesson_id,material_id),
  UNIQUE KEY uq_lesson_contents_order (lesson_id,display_order)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
