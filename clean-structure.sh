#!/bin/bash
set -e

echo "🧹 Cleaning grades, groups, and subscription plans..."

mysql -u root -p123580 Freelance <<'SQL'
-- Disable foreign key checks temporarily
SET FOREIGN_KEY_CHECKS = 0;

-- Delete all grades
DELETE FROM grades;

-- Delete all groups
DELETE FROM groups;

-- Delete all subscription plans
DELETE FROM subscription_plans;

-- Delete all courses
DELETE FROM courses;

-- Re-enable foreign key checks
SET FOREIGN_KEY_CHECKS = 1;

-- Show counts
SELECT 
  (SELECT COUNT(*) FROM grades) as grades_count,
  (SELECT COUNT(*) FROM groups) as groups_count,
  (SELECT COUNT(*) FROM subscription_plans) as plans_count,
  (SELECT COUNT(*) FROM courses) as courses_count;

SQL

echo ""
echo "✅ Grades, groups, and subscription plans deleted successfully!"
