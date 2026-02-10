#!/bin/bash
echo "=== CHECK FEE FIELD TYPES ==="
curl -s http://localhost:3001/api/fees | python3 -c "
import sys, json
data = json.load(sys.stdin)
for f in data:
    py = f.get('payment_year')
    pm = f.get('payment_month')
    pa = f.get('paid_amount')
    print(f'payment_year={py} type={type(py).__name__}, payment_month={pm} type={type(pm).__name__}, paid_amount={pa} type={type(pa).__name__}')
    print(f'  payment_year === 2026: {py == 2026}, payment_month === 2: {pm == 2}')
    print(f'  payment_year === \"2026\": {py == \"2026\"}, payment_month === \"2\": {pm == \"2\"}')
"
echo ""
echo "=== CHECK student_fees COLUMNS ==="
mysql -uroot -p'NewSecureP@ssw0rd2025!' freelance -e "DESCRIBE student_fees" 2>/dev/null | grep -E 'payment_year|payment_month|paid_amount|amount'
echo "=== DONE ==="
