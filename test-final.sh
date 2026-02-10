#!/bin/bash
echo "=== FEES API DATA ==="
curl -s http://localhost:3001/api/fees | python3 -c "
import sys, json
data = json.load(sys.stdin)
print(f'Total fee records: {len(data)}')
for f in data:
    name = f.get('student_name', '?')
    paid = f.get('paid_amount', 0)
    year = f.get('payment_year')
    month = f.get('payment_month')
    status = f.get('status')
    print(f'  {name}: paid={paid}, year={year}, month={month}, status={status}, type_paid={type(paid).__name__}, type_year={type(year).__name__}')
"

echo ""
echo "=== STUDENTS COUNT ==="
mysql -uroot -p'NewSecureP@ssw0rd2025!' freelance -e "SELECT COUNT(*) as cnt FROM students" 2>/dev/null

echo ""
echo "=== FEB 2026 PAYMENTS ==="
mysql -uroot -p'NewSecureP@ssw0rd2025!' freelance -e "SELECT student_name, paid_amount, payment_year, payment_month, status FROM student_fees WHERE payment_year=2026 AND payment_month=2" 2>/dev/null

echo ""
echo "=== SUM TEST (should be 400) ==="
mysql -uroot -p'NewSecureP@ssw0rd2025!' freelance -e "SELECT SUM(paid_amount) as total_feb FROM student_fees WHERE payment_year=2026 AND payment_month=2 AND status='paid'" 2>/dev/null

echo "=== DONE ==="
