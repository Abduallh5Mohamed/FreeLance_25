#!/bin/bash

echo "🧪 Creating Test Notification..."
echo "===================================="
echo ""

# Get DB credentials
DB_PASS=$(grep "DB_PASSWORD" /var/www/alqaed-api/.env 2>/dev/null | cut -d'=' -f2 | tr -d '"' | tr -d "'")
DB_NAME="freelance"
DB_USER="root"

# Get two users (sender and receiver)
SENDER_ID=$(mysql -u "$DB_USER" -p"$DB_PASS" "$DB_NAME" -sN -e "SELECT id FROM users WHERE role='student' LIMIT 1;" 2>/dev/null)
RECEIVER_ID=$(mysql -u "$DB_USER" -p"$DB_PASS" "$DB_NAME" -sN -e "SELECT id FROM users WHERE role='admin' OR role='teacher' LIMIT 1;" 2>/dev/null)

if [ -z "$SENDER_ID" ] || [ -z "$RECEIVER_ID" ]; then
    echo "❌ Could not find users for testing"
    exit 1
fi

SENDER_NAME=$(mysql -u "$DB_USER" -p"$DB_PASS" "$DB_NAME" -sN -e "SELECT name FROM users WHERE id='$SENDER_ID';" 2>/dev/null)  
RECEIVER_NAME=$(mysql -u "$DB_USER" -p"$DB_PASS" "$DB_NAME" -sN -e "SELECT name FROM users WHERE id='$RECEIVER_ID';" 2>/dev/null)

echo "👤 Sender: $SENDER_NAME ($SENDER_ID)"
echo "👤 Receiver: $RECEIVER_NAME ($RECEIVER_ID)"
echo ""

# Generate UUIDs
MSG_ID=$(uuidgen)
STATUS_ID=$(uuidgen)
CONV_ID=$(uuidgen)

echo "1️⃣ Creating conversation..."
# Check if conversation exists
EXISTING_CONV=$(mysql -u "$DB_USER" -p"$DB_PASS" "$DB_NAME" -sN -e "
SELECT id FROM conversations 
WHERE (user1_id='$SENDER_ID' AND user2_id='$RECEIVER_ID')
   OR (user1_id='$RECEIVER_ID' AND user2_id='$SENDER_ID')
LIMIT 1;
" 2>/dev/null)

if [ -n "$EXISTING_CONV" ]; then
    CONV_ID="$EXISTING_CONV"
    echo "   Using existing conversation: $CONV_ID"
else
    mysql -u "$DB_USER" -p"$DB_PASS" "$DB_NAME" -e "
    INSERT INTO conversations (id, user1_id, user2_id, unread_count_user1, unread_count_user2, created_at, updated_at)
    VALUES ('$CONV_ID', '$SENDER_ID', '$RECEIVER_ID', 0, 1, NOW(), NOW());
    " 2>&1 | grep -v "Warning"
    echo "   ✓ Created new conversation"
fi
echo ""

echo "2️⃣ Creating test message..."
mysql -u "$DB_USER" -p"$DB_PASS" "$DB_NAME" -e "
INSERT INTO messages (id, conversation_id, sender_id, receiver_id, content, message_type, created_at, updated_at)
VALUES ('$MSG_ID', '$CONV_ID', '$SENDER_ID', '$RECEIVER_ID', '🔔 TEST NOTIFICATION - هذه رسالة اختبار للإشعارات', 'text', NOW(), NOW());
" 2>&1 | grep -v "Warning"
echo "   ✓ Message created"
echo ""

echo "3️⃣ Creating message status (UNREAD)..."
mysql -u "$DB_USER" -p"$DB_PASS" "$DB_NAME" -e "
INSERT INTO message_status (id, message_id, user_id, is_read, read_at)
VALUES ('$STATUS_ID', '$MSG_ID', '$RECEIVER_ID', 0, NULL);
" 2>&1 | grep -v "Warning"
echo "   ✓ Status created (is_read=0)"
echo ""

echo "4️⃣ Updating conversation unread count..."
mysql -u "$DB_USER" -p"$DB_PASS" "$DB_NAME" -e "
UPDATE conversations 
SET unread_count_user2 = unread_count_user2 + 1,
    last_message_id = '$MSG_ID',
    last_message_at = NOW()
WHERE id = '$CONV_ID' AND user2_id = '$RECEIVER_ID';

UPDATE conversations 
SET unread_count_user1 = unread_count_user1 + 1,
    last_message_id = '$MSG_ID',
    last_message_at = NOW()
WHERE id = '$CONV_ID' AND user1_id = '$RECEIVER_ID';
" 2>&1 | grep -v "Warning"
echo "   ✓ Unread count updated"
echo ""

echo "5️⃣ Verifying..."
mysql -u "$DB_USER" -p"$DB_PASS" "$DB_NAME" -e "
SELECT 
    CONCAT('   Receiver unread count: ', 
        COALESCE((SELECT unread_count_user1 FROM conversations WHERE id='$CONV_ID' AND user1_id='$RECEIVER_ID'), 0) +
        COALESCE((SELECT unread_count_user2 FROM conversations WHERE id='$CONV_ID' AND user2_id='$RECEIVER_ID'), 0)
    ) as result;
" 2>&1 | grep -v "Warning" | tail -2
echo ""

echo "===================================="
echo "✅ Test Notification Created!"
echo "===================================="
echo ""
echo "📱 Next Step:"
echo "   1. Login as: $RECEIVER_NAME"
echo "   2. Look at notification bell (top right)"
echo "   3. Should show: 🔔 with badge number"
echo "   4. Click it to see the test message"
echo ""
echo "🌐 Or test API directly:"
echo "   curl http://localhost:3001/api/messages/unread-total \\"
echo "        -H 'Authorization: Bearer YOUR_TOKEN'"
echo ""
