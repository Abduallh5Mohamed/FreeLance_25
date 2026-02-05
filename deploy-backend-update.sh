#!/bin/bash
# Deploy backend update script

echo "=== 1. Adding Subscription Plan Columns ==="
mysql -u root -p'NewSecureP@ssw0rd2025!' freelance -e "
ALTER TABLE subscription_requests 
ADD COLUMN subscription_plan_id VARCHAR(36) NULL,
ADD COLUMN subscription_plan_name VARCHAR(255) NULL;
" 2>&1 || echo "Note: Columns may already exist or error occurred"

echo ""
echo "=== 2. Checking Table Structure ==="
mysql -u root -p'NewSecureP@ssw0rd2025!' freelance -e "DESCRIBE subscription_requests;"

echo ""
echo "=== 3. Restarting PM2 ==="
pm2 restart alqaed-api

echo ""
echo "=== 4. PM2 Status ==="
pm2 status

echo ""
echo "=== 5. Recent Backend Logs (last 30 lines) ==="
pm2 logs alqaed-api --lines 30 --nostream

echo ""
echo "=== DONE! ==="
