#!/bin/bash
echo "=== Checking which database has tables ==="
echo "freelance (lowercase):"
mysql -u root -p123580 <<SQL
USE freelance;
SHOW TABLES LIMIT 5;
SQL

echo ""
echo "=== Copying freelance to Freelance ==="
mysqldump -u root -p123580 freelance | mysql -u root -p123580 Freelance

echo ""
echo "✅ Done! Verifying Freelance database..."
mysql -u root -p123580 <<SQL
USE Freelance;
SHOW TABLES LIMIT 10;
SQL
