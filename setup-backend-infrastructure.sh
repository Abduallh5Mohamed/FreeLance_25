#!/bin/bash

echo "🚀 Starting Backend Deployment Setup..."

# 1. Install MySQL
echo "📦 Installing MySQL Server..."
sudo apt update
sudo DEBIAN_FRONTEND=noninteractive apt install -y mysql-server

# Start MySQL service
sudo systemctl start mysql
sudo systemctl enable mysql

# 2. Create Database and User
echo "🔧 Configuring MySQL..."
sudo mysql <<MYSQL_SCRIPT
-- Create database
CREATE DATABASE IF NOT EXISTS freelance CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- Create user with password
CREATE USER IF NOT EXISTS 'alqaed_user'@'localhost' IDENTIFIED BY 'AlQaed2025!Strong';

-- Grant privileges
GRANT ALL PRIVILEGES ON freelance.* TO 'alqaed_user'@'localhost';
FLUSH PRIVILEGES;

-- Show databases
SHOW DATABASES;
MYSQL_SCRIPT

echo "✅ MySQL configured successfully!"

# 3. Install Node.js 20.x
echo "📦 Installing Node.js 20.x..."
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs

# Verify installation
node --version
npm --version

# 4. Install PM2 for process management
echo "📦 Installing PM2..."
sudo npm install -g pm2

# 5. Create backend directory
echo "📁 Creating backend directory..."
sudo mkdir -p /var/www/alqaed-platform/backend
sudo chown -R $USER:$USER /var/www/alqaed-platform/backend

echo "✅ Backend infrastructure setup complete!"
echo ""
echo "Next steps:"
echo "1. Upload backend files to /var/www/alqaed-platform/backend"
echo "2. Upload database SQL files"
echo "3. Create .env file with database credentials"
echo "4. Run npm install && npm run build"
echo "5. Start with PM2"
