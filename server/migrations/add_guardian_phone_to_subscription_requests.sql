-- Add guardian_phone column to subscription_requests table

ALTER TABLE subscription_requests 
ADD COLUMN IF NOT EXISTS guardian_phone VARCHAR(20) AFTER phone;

-- Add index for faster searches
CREATE INDEX IF NOT EXISTS idx_subscription_requests_guardian_phone 
ON subscription_requests(guardian_phone);
