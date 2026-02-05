#!/bin/bash
# Add subscription plan columns to subscription_requests table

echo "=== Adding Subscription Plan Columns ==="

mysql -u root -p'NewSecureP@ssw0rd2025!' freelance -e "
-- Add subscription_plan_id and subscription_plan_name columns if they don't exist
ALTER TABLE subscription_requests 
ADD COLUMN IF NOT EXISTS subscription_plan_id VARCHAR(36) NULL,
ADD COLUMN IF NOT EXISTS subscription_plan_name VARCHAR(255) NULL;
" 2>/dev/null || true

# If the IF NOT EXISTS fails (older MySQL), try alternative method
mysql -u root -p'NewSecureP@ssw0rd2025!' freelance -e "
-- Check and add columns manually
SET @exist_plan_id := (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS 
    WHERE TABLE_SCHEMA = 'freelance' 
    AND TABLE_NAME = 'subscription_requests' 
    AND COLUMN_NAME = 'subscription_plan_id');

SET @exist_plan_name := (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS 
    WHERE TABLE_SCHEMA = 'freelance' 
    AND TABLE_NAME = 'subscription_requests' 
    AND COLUMN_NAME = 'subscription_plan_name');

SET @sql_plan_id := IF(@exist_plan_id = 0, 
    'ALTER TABLE subscription_requests ADD COLUMN subscription_plan_id VARCHAR(36) NULL', 
    'SELECT 1');
    
SET @sql_plan_name := IF(@exist_plan_name = 0, 
    'ALTER TABLE subscription_requests ADD COLUMN subscription_plan_name VARCHAR(255) NULL', 
    'SELECT 1');

PREPARE stmt1 FROM @sql_plan_id;
EXECUTE stmt1;
DEALLOCATE PREPARE stmt1;

PREPARE stmt2 FROM @sql_plan_name;
EXECUTE stmt2;
DEALLOCATE PREPARE stmt2;
" 2>/dev/null

echo ""
echo "Checking table structure:"
mysql -u root -p'NewSecureP@ssw0rd2025!' freelance -e "DESCRIBE subscription_requests;"

echo ""
echo "=== Done! ==="
