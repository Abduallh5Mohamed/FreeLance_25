USE Freelance;

-- Get grade IDs and insert groups directly
INSERT INTO `groups` (name, description, grade_id, is_active, max_students) 
SELECT 
  'مجموعة A - الصف الأول',
  'المجموعة الأولى للصف الأول الثانوي',
  g.id,
  TRUE,
  30
FROM grades g 
WHERE g.name = 'الصف الأول الثانوي' AND g.is_active = TRUE
LIMIT 1;

INSERT INTO `groups` (name, description, grade_id, is_active, max_students) 
SELECT 
  'مجموعة B - الصف الأول',
  'المجموعة الثانية للصف الأول الثانوي',
  g.id,
  TRUE,
  30
FROM grades g 
WHERE g.name = 'الصف الأول الثانوي' AND g.is_active = TRUE
LIMIT 1;

INSERT INTO `groups` (name, description, grade_id, is_active, max_students) 
SELECT 
  'مجموعة A - الصف الثاني',
  'المجموعة الأولى للصف الثاني الثانوي',
  g.id,
  TRUE,
  30
FROM grades g 
WHERE g.name = 'الصف الثاني الثانوي' AND g.is_active = TRUE
LIMIT 1;

INSERT INTO `groups` (name, description, grade_id, is_active, max_students) 
SELECT 
  'مجموعة B - الصف الثاني',
  'المجموعة الثانية للصف الثاني الثانوي',
  g.id,
  TRUE,
  30
FROM grades g 
WHERE g.name = 'الصف الثاني الثانوي' AND g.is_active = TRUE
LIMIT 1;

INSERT INTO `groups` (name, description, grade_id, is_active, max_students) 
SELECT 
  'مجموعة A - الصف الثالث',
  'المجموعة الأولى للصف الثالث الثانوي',
  g.id,
  TRUE,
  30
FROM grades g 
WHERE g.name = 'الصف الثالث الثانوي' AND g.is_active = TRUE
LIMIT 1;

INSERT INTO `groups` (name, description, grade_id, is_active, max_students) 
SELECT 
  'مجموعة B - الصف الثالث',
  'المجموعة الثانية للصف الثالث الثانوي',
  g.id,
  TRUE,
  30
FROM grades g 
WHERE g.name = 'الصف الثالث الثانوي' AND g.is_active = TRUE
LIMIT 1;

-- Verify
SELECT 'Groups inserted successfully!' as status;
SELECT g.name as group_name, gr.name as grade_name, g.is_active
FROM `groups` g
LEFT JOIN grades gr ON g.grade_id = gr.id
WHERE g.is_active = TRUE
ORDER BY gr.display_order, g.name;
