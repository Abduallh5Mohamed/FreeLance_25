-- Check student and enrollment
SELECT 'Student Info:' as section;
SELECT id, name, phone FROM students WHERE phone='01029290728';

SELECT 'Student Courses:' as section;
SELECT sc.student_id, sc.course_id, c.name as course_name 
FROM student_courses sc 
LEFT JOIN courses c ON sc.course_id = c.id 
WHERE sc.student_id = (SELECT id FROM students WHERE phone='01029290728' LIMIT 1);

SELECT 'Exam Courses:' as section;
SELECT e.id, e.title, e.course_id, c.name as course_name 
FROM exams e 
LEFT JOIN courses c ON e.course_id = c.id 
WHERE e.is_active = 1;
