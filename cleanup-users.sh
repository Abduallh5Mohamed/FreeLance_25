#!/bin/bash

MYSQL_CMD="mysql -u root -pNewSecureP@ssw0rd2025! freelance"

echo "=== STEP 1: Current User Count by Role ==="
$MYSQL_CMD -e "SELECT COUNT(*) as total, role FROM users GROUP BY role;"

echo ""
echo "=== STEP 2: Confirm Admin User Exists ==="
$MYSQL_CMD -e "SELECT id, name, phone, role FROM users WHERE phone = '01024083057';"

echo ""
echo "=== STEP 3: Delete All Users Except Admin ==="
$MYSQL_CMD -e "DELETE FROM users WHERE phone != '01024083057';"
echo "Users deleted (except admin)"

echo ""
echo "=== STEP 4: Clean Up Related Tables ==="

echo "Cleaning students..."
$MYSQL_CMD -e "DELETE FROM students WHERE user_id NOT IN (SELECT id FROM users);"

echo "Cleaning student_courses..."
$MYSQL_CMD -e "DELETE FROM student_courses WHERE student_id NOT IN (SELECT id FROM students);"

echo "Cleaning student_lectures..."
$MYSQL_CMD -e "DELETE FROM student_lectures WHERE student_id NOT IN (SELECT id FROM students);"

echo "Cleaning exam_attempts..."
$MYSQL_CMD -e "DELETE FROM exam_attempts WHERE student_id NOT IN (SELECT id FROM students);"

echo "Cleaning payments..."
$MYSQL_CMD -e "DELETE FROM payments WHERE student_id NOT IN (SELECT id FROM students);"

echo "Cleaning subscription_requests..."
$MYSQL_CMD -e "DELETE FROM subscription_requests;"

echo ""
echo "=== STEP 5: Final Verification - Remaining Users ==="
$MYSQL_CMD -e "SELECT id, name, phone, role FROM users;"

echo ""
echo "=== CLEANUP COMPLETE ==="
