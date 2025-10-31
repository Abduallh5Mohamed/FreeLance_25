USE Freelance;
ALTER TABLE `groups` ADD COLUMN grade_id CHAR(36);
ALTER TABLE `groups` ADD CONSTRAINT fk_groups_grade_id FOREIGN KEY (grade_id) REFERENCES grades(id) ON DELETE SET NULL;
