#!/bin/bash

echo "🗄️ Checking MySQL and Database..."
echo "===================================="
echo ""

# Check MySQL service
echo "1️⃣ MySQL Service Status:"
systemctl status mysql | grep "Active:" || echo "❌ MySQL not running"
echo ""

# Check if we can connect
echo "2️⃣ Testing MySQL Connection:"
mysql -u root -e "SELECT 'Connection OK' as status;" 2>&1 | head -5
echo ""

# List databases
echo "3️⃣ Available Databases:"
mysql -u root -e "SHOW DATABASES LIKE 'alqaed%';" 2>&1
echo ""

# Check alqaed_db specifically
echo "4️⃣ Checking alqaed_db tables:"
mysql -u root alqaed_db -e "SHOW TABLES;" 2>&1 | head -20
echo ""

# Check if conversations table exists
echo "5️⃣ Conversations Table Structure:"
mysql -u root alqaed_db -e "DESCRIBE conversations;" 2>&1 | head -20
echo ""

# Check if messages table exists
echo "6️⃣ Messages Table Structure:"
mysql -u root alqaed_db -e "DESCRIBE messages;" 2>&1 | head -20
echo ""

# Count records
echo "7️⃣ Record Counts:"
mysql -u root alqaed_db -e "
SELECT 
    (SELECT COUNT(*) FROM conversations) as conversations,
    (SELECT COUNT(*) FROM messages) as messages,
    (SELECT COUNT(*) FROM message_status) as message_status;
" 2>&1
echo ""

echo "===================================="
echo "✅ Database check complete"
echo "===================================="
