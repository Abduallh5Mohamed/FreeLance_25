#!/bin/bash

echo "🗄️ Checking Notifications Database..."
echo "===================================="
echo ""

# Get DB credentials from actual backend location
DB_PASS=$(grep "DB_PASSWORD" /var/www/alqaed-api/.env 2>/dev/null | cut -d'=' -f2 | tr -d '"' | tr -d "'")
DB_NAME=$(grep "DB_NAME" /var/www/alqaed-api/.env 2>/dev/null | cut -d'=' -f2 | tr -d '"' | tr -d "'" || echo "freelance")
DB_USER=$(grep "DB_USER" /var/www/alqaed-api/.env 2>/dev/null | cut -d'=' -f2 | tr -d '"' | tr -d "'" || echo "root")

echo "Database: $DB_NAME"
echo "User: $DB_USER"
echo ""

# 1. Check conversations table
echo "1️⃣ Conversations Table:"
mysql -u "$DB_USER" -p"$DB_PASS" "$DB_NAME" -e "SELECT COUNT(*) as total FROM conversations;" 2>&1 | grep -E "total|ERROR"
echo ""

# 2. Check messages table
echo "2️⃣ Messages Table:"
mysql -u "$DB_USER" -p"$DB_PASS" "$DB_NAME" -e "SELECT COUNT(*) as total FROM messages;" 2>&1 | grep -E "total|ERROR"
echo ""

# 3. Check message_status table
echo "3️⃣ Message Status Table:"
mysql -u "$DB_USER" -p"$DB_PASS" "$DB_NAME" -e "SELECT COUNT(*) as total, SUM(is_read=0) as unread FROM message_status;" 2>&1 | grep -E "total|unread|ERROR"
echo ""

# 4. Sample unread conversations
echo "4️⃣ Sample Unread Conversations:"
mysql -u "$DB_USER" -p"$DB_PASS" "$DB_NAME" -e "
SELECT 
    id,
    user1_id,
    user2_id,
    unread_count_user1,
    unread_count_user2,
    last_message_at
FROM conversations 
WHERE unread_count_user1 > 0 OR unread_count_user2 > 0
ORDER BY last_message_at DESC
LIMIT 5;
" 2>&1
echo ""

# 5. Get users with unread messages
echo "5️⃣ Users with Unread Messages:"
mysql -u "$DB_USER" -p"$DB_PASS" "$DB_NAME" -e "
SELECT 
    u.id,
    u.name,
    u.role,
    (
        SELECT SUM(unread_count_user1) 
        FROM conversations 
        WHERE user1_id = u.id
    ) as unread_as_user1,
    (
        SELECT SUM(unread_count_user2) 
        FROM conversations 
        WHERE user2_id = u.id
    ) as unread_as_user2
FROM users u
WHERE EXISTS (
    SELECT 1 FROM conversations 
    WHERE (user1_id = u.id AND unread_count_user1 > 0)
       OR (user2_id = u.id AND unread_count_user2 > 0)
)
LIMIT 10;
" 2>&1
echo ""

# 6. Test API request
echo "6️⃣ Testing API Endpoints:"
echo "   Backend health:"
curl -s http://localhost:3001/health | head -3
echo ""
echo ""

# 7. Check PM2 logs
echo "7️⃣ Recent Backend Logs (last 20 lines):"
pm2 logs --nostream --lines 20 2>&1 | tail -20
echo ""

echo "===================================="
echo "✅ Diagnostic Complete"
echo "===================================="
