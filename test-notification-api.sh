#!/bin/bash

echo "🧪 Testing Notification API..."
echo "===================================="

# Get auth token for admin user
ADMIN_USER='69fe1174-c98d-11f0-9d07-94e8d4b653c4'

echo "1️⃣ Testing /api/messages/unread-total endpoint..."
echo ""

# Create a test token (simplified - in production this would be JWT)
echo "   Checking PM2 logs for API calls..."
pm2 logs alqaed-api --lines 5 --nostream | grep unread-total | tail -3

echo ""
echo "2️⃣ Checking database directly..."
DB_PASS=$(grep DB_PASSWORD /var/www/alqaed-api/.env | cut -d '=' -f2)

mysql -u root -p"$DB_PASS" -se "
SELECT 
    'Admin ID: $ADMIN_USER' as info,
    COALESCE((SELECT SUM(unread_count_user1) FROM freelance.conversations WHERE user1_id = '$ADMIN_USER'), 0) +
    COALESCE((SELECT SUM(unread_count_user2) FROM freelance.conversations WHERE user2_id = '$ADMIN_USER'), 0) 
    as total_unread
" 2>/dev/null

echo ""
echo "3️⃣ Recent conversations:"
mysql -u root -p"$DB_PASS" -se "
SELECT 
    CONCAT('User1: ', SUBSTRING(user1_id, 1, 8), '...') as user1,
    CONCAT('User2: ', SUBSTRING(user2_id, 1, 8), '...') as user2,
    unread_count_user1,
    unread_count_user2,
    last_message_at
FROM freelance.conversations 
WHERE user1_id = '$ADMIN_USER' OR user2_id = '$ADMIN_USER'
ORDER BY last_message_at DESC
LIMIT 3
" 2>/dev/null

echo ""
echo "===================================="
echo "✅ Database check complete!"
echo ""
echo "📱 NOW TEST IN BROWSER:"
echo "   1. Open: https://elka2d.cloud"
echo "   2. Hard refresh: Ctrl+Shift+R"
echo "   3. Login as Admin (69fe1174-c98d-11f0-9d07-94e8d4b653c4)"
echo "   4. Look at notification bell 🔔"
echo "   5. Check F12 Console for logs"
echo ""
echo "Expected: RED badge with number '5'"
echo "===================================="
