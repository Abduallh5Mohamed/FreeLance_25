#!/bin/bash

echo "=== Creating message_deletions table ==="

# Use correct credentials
DB_USER="root"
DB_PASS="123580"
DB_NAME="Freelance"

echo "Database: $DB_NAME"

# Create table
mysql -u "$DB_USER" -p"$DB_PASS" "$DB_NAME" << 'EOF'
CREATE TABLE IF NOT EXISTS message_deletions (
  id INT AUTO_INCREMENT PRIMARY KEY,
  message_id INT NOT NULL,
  user_id VARCHAR(36) NOT NULL,
  deleted_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY unique_message_user (message_id, user_id),
  FOREIGN KEY (message_id) REFERENCES messages(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
EOF

echo ""
echo "=== Verifying table ==="
mysql -u "$DB_USER" -p"$DB_PASS" "$DB_NAME" -e "DESCRIBE message_deletions;"

if [ $? -eq 0 ]; then
    echo ""
    echo "✅ Table created successfully!"
    echo "Restarting PM2..."
    pm2 restart alqaed-api
    pm2 logs alqaed-api --lines 5
    echo ""
    echo "Done!"
else
    echo "❌ Table creation failed"
    exit 1
fi
