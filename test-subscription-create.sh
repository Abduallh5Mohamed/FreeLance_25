#!/bin/bash

echo "=== Testing Subscription Plan Creation ==="
echo ""

echo "1. Creating a new test subscription plan..."
CREATE_RESULT=$(curl -s -X POST http://localhost:3001/api/subscription-plans \
  -H 'Content-Type: application/json' \
  -d '{"name":"باقة تجريبية","duration_months":1,"price":50,"description":"خطة تجريبية للاختبار"}')

echo "Create Result:"
echo "$CREATE_RESULT" | python3 -m json.tool 2>/dev/null || echo "$CREATE_RESULT"
echo ""

echo "2. Listing all subscription plans..."
LIST_RESULT=$(curl -s http://localhost:3001/api/subscription-plans)
echo "All Plans:"
echo "$LIST_RESULT" | python3 -m json.tool 2>/dev/null || echo "$LIST_RESULT"
echo ""

echo "3. Checking PM2 logs for errors..."
pm2 logs alqaed-api --lines 10 --nostream 2>&1
echo ""

echo "=== Test Complete ==="
