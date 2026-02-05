#!/bin/bash
# Test subscription API

echo "=== Testing Subscription Plans API ==="

# Test GET
echo -e "\n1. GET /api/subscription-plans:"
curl -s http://localhost:3001/api/subscription-plans

# Test POST - Create new subscription
echo -e "\n\n2. POST /api/subscription-plans (Creating new):"
curl -s -X POST http://localhost:3001/api/subscription-plans \
  -H "Content-Type: application/json" \
  -d '{"name":"اشتراك تجريبي","duration_months":1,"price":100,"description":"خطة تجريبية"}'

echo -e "\n\n3. Check database directly:"
mysql -u root -p'NewSecureP@ssw0rd2025!' freelance -e "SELECT id, name, price, duration_months, is_active FROM subscription_plans;"

echo -e "\n\n4. Check PM2 logs:"
pm2 logs backend --lines 20 --nostream 2>/dev/null || echo "PM2 not running"

echo -e "\n\nDone!"
