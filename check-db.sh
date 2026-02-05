#!/bin/bash
# Check database status

echo "=== Users ==="
mysql -u root -p'NewSecureP@ssw0rd2025!' freelance -e "SELECT id, name, phone, role FROM users;"

echo ""
echo "=== Exams Count ==="
mysql -u root -p'NewSecureP@ssw0rd2025!' freelance -e "SELECT COUNT(*) as exam_count FROM exams;"

echo ""
echo "=== Groups ==="
mysql -u root -p'NewSecureP@ssw0rd2025!' freelance -e "SELECT id, name FROM \`groups\`;"

echo ""
echo "=== Students ==="
mysql -u root -p'NewSecureP@ssw0rd2025!' freelance -e "SELECT id, name, phone, group_id FROM students;"

echo ""
echo "=== Exam Groups ==="
mysql -u root -p'NewSecureP@ssw0rd2025!' freelance -e "SELECT * FROM exam_groups;"

echo ""
echo "=== Exam Results ==="
mysql -u root -p'NewSecureP@ssw0rd2025!' freelance -e "SELECT COUNT(*) FROM exam_results;"

echo ""
echo "=== Exam Attempts ==="
mysql -u root -p'NewSecureP@ssw0rd2025!' freelance -e "SELECT COUNT(*) FROM exam_attempts;"
