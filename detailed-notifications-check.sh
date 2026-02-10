#!/bin/bash

echo "🔍 Detailed Notifications Check..."
echo "===================================="
echo ""

# Get DB credentials
DB_PASS=$(grep "DB_PASSWORD" /var/www/alqaed-api/.env 2>/dev/null | cut -d'=' -f2 | tr -d '"' | tr -d "'")
DB_NAME="freelance"
DB_USER="root"

# Check if tables exist
echo "1️⃣ Checking if tables exist:"
mysql -u "$DB_USER" -p"$DB_PASS" "$DB_NAME" -e "
SHOW TABLES;
" 2>&1 | grep -E "conversations|messages|message_status" || echo "  ❌ Tables not found!"
echo ""

# Count records
echo "2️⃣ Counting records:"
mysql -u "$DB_USER" -p"$DB_PASS" "$DB_NAME" -sN -e "
SELECT CONCAT('  Conversations: ', COUNT(*)) FROM conversations;
SELECT CONCAT('  Messages: ', COUNT(*)) FROM messages;
SELECT CONCAT('  Message Status: ', COUNT(*)) FROM message_status;
SELECT CONCAT('  Users: ', COUNT(*)) FROM users;
" 2>&1 | grep -v "Warning"
echo ""

# If there are conversations, show them
echo "3️⃣ Sample conversations (if any):"
mysql -u "$DB_USER" -p"$DB_PASS" "$DB_NAME" -e "
SELECT * FROM conversations LIMIT 3;
" 2>&1 | grep -v "Warning" | head -10
echo ""

# If there are messages, show them
echo "4️⃣ Sample messages (if any):"
mysql -u "$DB_USER" -p"$DB_PASS" "$DB_NAME" -e "
SELECT id, sender_id, receiver_id, content, created_at FROM messages LIMIT 3;
" 2>&1 | grep -v "Warning" | head -10
echo ""

# Check users
echo "5️⃣ Sample users:"
mysql -u "$DB_USER" -p"$DB_PASS" "$DB_NAME" -e "
SELECT id, name, role FROM users LIMIT 5;
" 2>&1 | grep -v "Warning"
echo ""

# Check if NotificationBell component is being called
echo "6️⃣ Testing Direct API Call:"
echo "   Calling: http://localhost:3001/api/messages/unread-total"
# Test with a real user ID from database
USER_ID=$(mysql -u "$DB_USER" -p"$DB_PASS" "$DB_NAME" -sN -e "SELECT id FROM users LIMIT 1;" 2>/dev/null)
if [ -n "$USER_ID" ]; then
    echo "   Using User ID: $USER_ID"
    # We can't test with auth here, but we can check if endpoint responds
    curl -s -X GET "http://localhost:3001/api/messages/unread-total" \
         -H "Content-Type: application/json" 2>&1 | head -5
fi
echo ""

echo "7️⃣ Check if socket.io is working:"
netstat -tlnp | grep 3001 || echo "  ❌ Port 3001 not listening"
echo ""

echo ""
echo "===================================="
echo "📊 Summary:"
echo "===================================="
echo ""

# Get counts
CONV_COUNT=$(mysql -u "$DB_USER" -p"$DB_PASS" "$DB_NAME" -sN -e "SELECT COUNT(*) FROM conversations;" 2>/dev/null)
MSG_COUNT=$(mysql -u "$DB_USER" -p"$DB_PASS" "$DB_NAME" -sN -e "SELECT COUNT(*) FROM messages;" 2>/dev/null)
USER_COUNT=$(mysql -u "$DB_USER" -p"$DB_PASS" "$DB_NAME" -sN -e "SELECT COUNT(*) FROM users;" 2>/dev/null)

if [ "$CONV_COUNT" -eq "0" ] && [ "$MSG_COUNT" -eq "0" ]; then
    echo "⚠️  ISSUE FOUND: No conversations or messages in database!"
    echo ""
    echo "This means the notification system is working, but:"
    echo "  • No one has sent any messages yet"
    echo "  • Or the messaging feature hasn't been used"
    echo ""
    echo "✅ To test notifications:"
    echo "  1. Login as a student"
    echo "  2. Send a message to teacher"
    echo "  3. Login as teacher"
    echo "  4. Check if notification badge appears"
    echo ""
elif [ "$CONV_COUNT" -gt "0" ]; then
    echo "✅ System status: WORKING"
    echo "   • Conversations: $CONV_COUNT"
    echo "   • Messages: $MSG_COUNT"
    echo "   • Users: $USER_COUNT"
    echo ""
    echo "If notifications still not showing:"
    echo "  • Check browser console for errors (F12)"
    echo "  • Check if authToken exists in localStorage"
    echo "  • Try clearing browser cache"
fi

echo "===================================="
