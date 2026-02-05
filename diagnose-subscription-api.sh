#!/bin/bash

echo "========================================"
echo "SUBSCRIPTION API DIAGNOSTIC REPORT"
echo "========================================"
echo ""

echo "=== 1. PM2 STATUS ==="
pm2 list
echo ""

echo "=== 2. SUBSCRIPTION_PLANS TABLE CONTENTS ==="
MYSQL_PWD='NewSecureP@ssw0rd2025!' mysql -u root freelance -e "SELECT * FROM subscription_plans;" 2>/dev/null
echo ""

echo "=== 3. API ENDPOINT TEST ==="
echo "Testing: http://localhost:3001/api/subscription-plans"
curl -s http://localhost:3001/api/subscription-plans | head -c 2000
echo ""
echo ""

echo "=== 4. BACKEND ERROR LOGS (subscription-related) ==="
pm2 logs backend --lines 100 --nostream 2>&1 | grep -i 'subscription\|error' | tail -30
echo ""

echo "=== 5. BACKEND GENERAL LOGS (last 20 lines) ==="
pm2 logs backend --lines 20 --nostream 2>&1
echo ""

echo "========================================"
echo "DIAGNOSTIC COMPLETE"
echo "========================================"
