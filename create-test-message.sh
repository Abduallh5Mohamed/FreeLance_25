#!/bin/bash

# Get DB password from .env
DB_PASS=$(grep DB_PASSWORD /var/www/alqaed-api/.env | cut -d '=' -f2)

echo "🧪 Creating Test Unread Message..."
echo "===================================="

# Get admin and student IDs
ADMIN_ID="69fe1174-c98d-11f0-9d07-94e8d4b653c4"
STUDENT_ID="9b955922-4bca-4568-8683-a4cfb27e3a6e"

# Generate UUIDs for test message
TEST_MSG_ID=$(uuidgen)
TEST_CONV_ID=$(uuidgen)

echo "1️⃣ Creating conversation with unread count..."
mysql -u root -p"$DB_PASS" freelance <<EOF
-- First, check if conversation exists
SELECT id, unread_count_user1, unread_count_user2 
FROM conversations 
WHERE (user1_id = '$ADMIN_ID' AND user2_id = '$STUDENT_ID')
   OR (user1_id = '$STUDENT_ID' AND user2_id = '$ADMIN_ID');

-- Update unread count for existing conversation
UPDATE conversations 
SET unread_count_user1 = 5,
    last_message_at = NOW()
WHERE user1_id = '$ADMIN_ID' AND user2_id = '$STUDENT_ID';

-- Show updated conversation
SELECT id, user1_id, user2_id, unread_count_user1, unread_count_user2, last_message_at
FROM conversations 
WHERE user1_id = '$ADMIN_ID' AND user2_id = '$STUDENT_ID';
EOF

echo ""
echo "2️⃣ Verifying unread count..."
UNREAD=$(mysql -u root -p"$DB_PASS" -se "SELECT unread_count_user1 FROM conversations WHERE user1_id = '$ADMIN_ID' AND user2_id = '$STUDENT_ID' LIMIT 1" freelance)
echo "   Admin unread count: $UNREAD"

if [ "$UNREAD" -gt 0 ]; then
    echo ""
    echo "✅ SUCCESS! Test notification created!"
    echo "===================================="
    echo ""
    echo "📱 Now check the website:"
    echo "   1. Open: https://elka2d.cloud"
    echo "   2. Login as Admin"
    echo "   3. You should see a RED badge with number 5 on notification bell 🔔"
    echo ""
else
    echo "❌ Failed to create test notification"
fi
