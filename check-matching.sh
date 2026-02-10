#!/bin/bash
# Check student-fee matching
mysql -uroot -p'NewSecureP@ssw0rd2025!' freelance <<'EOF'
SELECT s.id, s.name, s.phone, sf.student_id as fee_student_id, sf.phone as fee_phone, sf.paid_amount
FROM students s
LEFT JOIN student_fees sf ON (sf.phone = s.phone OR sf.student_id = s.id)
WHERE s.name LIKE 'Baraa%'
LIMIT 5;
EOF
echo "---"
echo "All students phones:"
mysql -uroot -p'NewSecureP@ssw0rd2025!' freelance -e "SELECT id, name, phone FROM students LIMIT 5;"
