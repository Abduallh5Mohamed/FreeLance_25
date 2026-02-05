#!/bin/bash

# Create a simple text file as placeholder receipt
cat > /root/backend/uploads/receipts/receipt-1770149063509-683291647.jpg << 'EOF'
Receipt Image Placeholder
Student: Baraa wael
Amount: 50 EGP
Date: 2026-02-03
EOF

# Set permissions
chmod 644 /root/backend/uploads/receipts/receipt-1770149063509-683291647.jpg

echo "Receipt placeholder created!"
ls -la /root/backend/uploads/receipts/
