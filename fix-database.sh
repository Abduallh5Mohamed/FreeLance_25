#!/bin/bash
mysql -u root -p123580 -e "SHOW DATABASES;"
echo ""
echo "=== Checking freelance_platform ==="
mysql -u root -p123580 -e "SELECT COUNT(*) AS table_count FROM information_schema.tables WHERE table_schema='freelance_platform';"
echo ""
echo "=== Checking Freelance ==="
mysql -u root -p123580 -e "SELECT COUNT(*) AS table_count FROM information_schema.tables WHERE table_schema='Freelance';"
echo ""
echo "=== Copying tables if needed ==="
mysql -u root -p123580 <<SQL
CREATE DATABASE IF NOT EXISTS Freelance CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
SQL

# Check which DB has students table
HAS_TABLES=\$(mysql -u root -p123580 -se "SELECT COUNT(*) FROM information_schema.tables WHERE table_schema='freelance_platform' AND table_name='students';")

if [ "\$HAS_TABLES" -gt 0 ]; then
  echo "✅ Tables found in freelance_platform, copying to Freelance..."
  mysqldump -u root -p123580 freelance_platform | mysql -u root -p123580 Freelance
  echo "✅ Copy complete!"
else
  echo "⚠️  No tables in freelance_platform"
fi

echo ""
echo "=== Final check - Freelance tables ==="
mysql -u root -p123580 Freelance -e "SHOW TABLES;" | head -20
