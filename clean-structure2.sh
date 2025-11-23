#!/bin/bash
set -e

echo "🧹 Cleaning grades, groups, and subscription plans..."

mysql -u root -p123580 Freelance <<SQL
SET FOREIGN_KEY_CHECKS = 0;
DELETE FROM grades;
DELETE FROM groups;
DELETE FROM subscription_plans;
DELETE FROM courses;
SET FOREIGN_KEY_CHECKS = 1;
SQL

echo ""
echo "✅ Done!"
