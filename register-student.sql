-- Register student in History course
INSERT INTO student_courses (
    id, 
    student_id, 
    course_id, 
    status
) VALUES (
    UUID(),
    '077af498-5f78-49de-97a9-ab3d47c1e9fe',  -- Student ID
    'ddaad939-c2fe-11f0-a978-94e8d4b653c4',  -- History course ID
    'active'
);

-- Verify registration
SELECT 'Verification:' as section;
SELECT sc.student_id, s.name, sc.course_id, c.name as course_name
FROM student_courses sc
LEFT JOIN students s ON sc.student_id = s.id
LEFT JOIN courses c ON sc.course_id = c.id
WHERE sc.student_id = '077af498-5f78-49de-97a9-ab3d47c1e9fe';
