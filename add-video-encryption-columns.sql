-- Add encryption columns to videos table
-- Run this to enable AES-128 HLS encryption

ALTER TABLE videos 
ADD COLUMN IF NOT EXISTS encryption_key VARCHAR(64) DEFAULT NULL COMMENT 'AES-128 encryption key (hex)',
ADD COLUMN IF NOT EXISTS encryption_iv VARCHAR(64) DEFAULT NULL COMMENT 'Initialization vector (hex)',
ADD COLUMN IF NOT EXISTS is_encrypted TINYINT(1) DEFAULT 0 COMMENT 'Whether video is encrypted';

-- Add index for faster lookups
ALTER TABLE videos ADD INDEX IF NOT EXISTS idx_is_encrypted (is_encrypted);

-- Show result
SELECT 'Encryption columns added successfully!' as message;
DESCRIBE videos;
