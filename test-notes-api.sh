#!/bin/bash
# Test notes API
echo "=== Test PUT notes ==="
curl -s -X PUT -H "Content-Type: application/json" -d '{"notes":"test note from API"}' http://localhost:3001/api/students/cd5edab1-4f57-4eb0-b0e0-6fb2ee9191ca/notes
echo ""
echo "=== Test GET notes ==="
curl -s http://localhost:3001/api/students/cd5edab1-4f57-4eb0-b0e0-6fb2ee9191ca/notes
echo ""
echo "=== Test fees data ==="
curl -s http://localhost:3001/api/fees | python3 -c "import sys,json; data=json.load(sys.stdin); print('Total fees:', len(data)); [print(f'  {f.get(\"student_name\")}: {f.get(\"paid_amount\")} - Year:{f.get(\"payment_year\")} Month:{f.get(\"payment_month\")} Status:{f.get(\"status\")}') for f in data]"
echo ""
echo "=== DONE ==="
