#!/bin/bash
echo "=== ALL FEES ==="
mysql -uroot -p'NewSecureP@ssw0rd2025!' freelance -e "SELECT id, student_name, phone, paid_amount, amount, status, payment_year, payment_month FROM student_fees ORDER BY created_at DESC LIMIT 20;"
echo ""
echo "=== FEBRUARY 2026 FEES ==="
mysql -uroot -p'NewSecureP@ssw0rd2025!' freelance -e "SELECT student_name, phone, paid_amount, amount, status, payment_year, payment_month FROM student_fees WHERE payment_year=2026 AND payment_month=2;"
echo ""
echo "=== FEES API RESPONSE ==="
curl -s http://localhost:3001/api/fees | python3 -c "
import sys,json
data=json.load(sys.stdin)
print(f'Total fee records: {len(data)}')
for f in data:
    print(f'  Name: {f.get(\"student_name\")}, Phone: {f.get(\"phone\")}, Amount: {f.get(\"amount\")}, Paid: {f.get(\"paid_amount\")}, Status: {f.get(\"status\")}, Year: {f.get(\"payment_year\")}, Month: {f.get(\"payment_month\")}')
"
echo ""
echo "=== STUDENTS COUNT ==="
mysql -uroot -p'NewSecureP@ssw0rd2025!' freelance -e "SELECT COUNT(*) as total_students FROM students;"
echo "=== DONE ==="
