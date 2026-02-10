#!/bin/bash

echo "=== Creating message_deletions table ==="

# Get DB credentials from .env
cd /var/www/alqaed-api
source .env

echo "Using database: $DB_NAME"
echo "Using user: $DB_USER"

# Create table
mysql -u "$DB_USER" -p"$DB_PASSWORD" "$DB_NAME" << 'EOF'
CREATE TABLE IF NOT EXISTS message_deletions (
  id INT AUTO_INCREMENT PRIMARY KEY,
  message_id INT NOT NULL,
  user_id VARCHAR(36) NOT NULL,
  deleted_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY unique_message_user (message_id, user_id),
  FOREIGN KEY (message_id) REFERENCES messages(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
EOF

# Verify
echo ""
echo "=== Verifying table ==="
mysql -u "$DB_USER" -p"$DB_PASSWORD" "$DB_NAME" -e "DESCRIBE message_deletions;"

if [ $? -eq 0 ]; then
    echo ""
    echo "✅ Table created successfully!"
    echo "Restarting PM2..."
    pm2 restart alqaed-api
    echo "Done!"
else
    echo "❌ Table creation failed"
    exit 1
fi
