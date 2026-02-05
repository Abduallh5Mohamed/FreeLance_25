#!/bin/bash
echo "=== Checking subscription_plans table ==="
MYSQL_PWD='NewSecureP@ssw0rd2025!' mysql -u root freelance -e "DESCRIBE subscription_plans;"

echo ""
echo "=== Current subscription plans ==="
MYSQL_PWD='NewSecureP@ssw0rd2025!' mysql -u root freelance -e "SELECT * FROM subscription_plans;"

echo ""
echo "=== Checking subscription_requests table ==="
MYSQL_PWD='NewSecureP@ssw0rd2025!' mysql -u root freelance -e "DESCRIBE subscription_requests;" 2>/dev/null || echo "Table does not exist"
