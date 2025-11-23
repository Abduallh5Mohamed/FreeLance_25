#!/bin/bash
set -e

echo "🔧 Configuring MySQL root authentication..."
sudo mysql --defaults-file=/etc/mysql/debian.cnf -e "ALTER USER 'root'@'localhost' IDENTIFIED WITH mysql_native_password BY '123580';"
sudo mysql --defaults-file=/etc/mysql/debian.cnf -e "FLUSH PRIVILEGES;"

echo "🗄️ Creating Freelance database if not exists..."
sudo mysql --defaults-file=/etc/mysql/debian.cnf -e "CREATE DATABASE IF NOT EXISTS Freelance CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;"

echo "✅ Verifying root user plugin..."
sudo mysql --defaults-file=/etc/mysql/debian.cnf -e "SELECT user, host, plugin FROM mysql.user WHERE user='root';"

echo "🧪 Testing root login with password..."
mysql -u root -p123580 -e "SELECT 'Connection OK' AS status;"

echo "✅ MySQL root authentication configured successfully!"
