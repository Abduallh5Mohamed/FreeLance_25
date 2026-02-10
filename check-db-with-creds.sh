#!/bin/bash

echo "🗄️ Checking Database Configuration..."
echo "===================================="
echo ""

# Check backend .env for DB credentials
echo "1️⃣ Checking backend configuration:"
if [ -f "/var/www/alqaed/server/.env" ]; then
    echo "✓ .env file found"
    grep "DB_" /var/www/alqaed/server/.env | grep -v "PASSWORD"
else
    echo "❌ .env file not found"
fi
echo ""

# Try to get DB password from PM2 env
echo "2️⃣ Getting DB credentials from PM2:"
DB_PASS=$(pm2 env 0 2>/dev/null | grep DB_PASSWORD | cut -d'=' -f2)
if [ -n "$DB_PASS" ]; then
    echo "✓ Found DB password in PM2"
else
    # Try from .env file
    if [ -f "/var/www/alqaed/server/.env" ]; then
        DB_PASS=$(grep "DB_PASSWORD" /var/www/alqaed/server/.env | cut -d'=' -f2 | tr -d '"' | tr -d "'")
        echo "✓ Found DB password in .env"
    fi
fi
echo ""

# Get DB name
DB_NAME=$(grep "DB_NAME" /var/www/alqaed/server/.env 2>/dev/null | cut -d'=' -f2 | tr -d '"' | tr -d "'" || echo "alqaed_db")
DB_USER=$(grep "DB_USER" /var/www/alqaed/server/.env 2>/dev/null | cut -d'=' -f2 | tr -d '"' | tr -d "'" || echo "root")

echo "3️⃣ Database Info:"
echo "   Database: $DB_NAME"
echo "   User: $DB_USER"
echo ""

# Now test with credentials
if [ -n "$DB_PASS" ]; then
    echo "4️⃣ Testing connection with credentials:"
    mysql -u "$DB_USER" -p"$DB_PASS" -e "SELECT 'Connection OK' as status;" 2>&1 | head -3
    echo ""
    
    echo "5️⃣ Checking tables:"
    mysql -u "$DB_USER" -p"$DB_PASS" "$DB_NAME" -e "SHOW TABLES LIKE '%message%' OR SHOW TABLES LIKE '%conversation%';" 2>&1
    echo ""
    
    echo "6️⃣ Checking conversations count:"
    mysql -u "$DB_USER" -p"$DB_PASS" "$DB_NAME" -e "SELECT COUNT(*) as total FROM conversations;" 2>&1
    echo ""
    
    echo "7️⃣ Checking messages count:"
    mysql -u "$DB_USER" -p"$DB_PASS" "$DB_NAME" -e "SELECT COUNT(*) as total FROM messages;" 2>&1
    echo ""
    
    echo "8️⃣ Sample unread counts:"
    mysql -u "$DB_USER" -p"$DB_PASS" "$DB_NAME" -e "
    SELECT 
        id,
        CONCAT(user1_id, ' <-> ', user2_id) as conversation,
        unread_count_user1,
        unread_count_user2,
        last_message_at
    FROM conversations 
    WHERE unread_count_user1 > 0 OR unread_count_user2 > 0
    LIMIT 5;
    " 2>&1
else
    echo "❌ Could not find database password"
    echo ""
    echo "Please check:"
    echo "  • /var/www/alqaed/server/.env"
    echo "  • PM2 environment variables"
fi

echo ""
echo "===================================="
echo "✅ Check complete"
echo "===================================="
