#!/bin/bash

echo "=========================================="
echo "Database Cleanup - Keep Admin Only"
echo "=========================================="

# First get admin info
echo "Admin info before cleanup:"
MYSQL_PWD='NewSecureP@ssw0rd2025!' mysql -u root freelance -e "SELECT id, phone, name, role FROM users WHERE phone = '01024083057';"

# Disable FK and clean each table individually (ignore errors for non-existent tables)
MYSQL_PWD='NewSecureP@ssw0rd2025!' mysql -u root freelance -e "SET FOREIGN_KEY_CHECKS = 0;"

# Clean tables one by one
for table in account_statement ai_chat_history attendance attendance_qr_codes conversations course_materials courses exam_attempts exam_groups exam_questions exam_results exam_student_answers exams expenses financial_summary grades group_courses groups import_items imports lecture_purchases lectures material_groups message_status messages online_meetings premium_lecture_access premium_lecture_payments premium_lectures staff student_courses student_fees student_materials student_registration_requests student_statistics students subscription_plans subscription_requests subscriptions teacher_messages user_online_status video_access_logs video_processing_queue video_uploads videos; do
    MYSQL_PWD='NewSecureP@ssw0rd2025!' mysql -u root freelance -e "TRUNCATE TABLE $table;" 2>/dev/null && echo "Cleaned: $table" || echo "Skipped: $table (not exists)"
done

# Delete non-admin users
echo ""
echo "Deleting non-admin users..."
MYSQL_PWD='NewSecureP@ssw0rd2025!' mysql -u root freelance -e "DELETE FROM users WHERE phone != '01024083057';"
echo "Deleted non-admin users."

# Update admin password
echo ""
echo "Updating admin password..."
MYSQL_PWD='NewSecureP@ssw0rd2025!' mysql -u root freelance -e "UPDATE users SET password = '\$2b\$10\$d49pUjJJ9Pxb37R/Z832m.Loy2U6WHJCOEu7DR5ZfF1UuQFItjPHe', role = 'admin', is_active = 1, updated_at = NOW() WHERE phone = '01024083057';"
echo "Admin password updated!"

# Re-enable FK
MYSQL_PWD='NewSecureP@ssw0rd2025!' mysql -u root freelance -e "SET FOREIGN_KEY_CHECKS = 1;"

# Show final status
echo ""
echo "=========================================="
echo "CLEANUP COMPLETE - Final Status:"
echo "=========================================="
MYSQL_PWD='NewSecureP@ssw0rd2025!' mysql -u root freelance -e "SELECT COUNT(*) as total_users FROM users;"
MYSQL_PWD='NewSecureP@ssw0rd2025!' mysql -u root freelance -e "SELECT id, phone, name, role, is_active FROM users;"
