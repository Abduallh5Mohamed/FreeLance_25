-- Migration: Add phone column to users table for phone-based authentication
-- Run this migration to update existing database schema

USE Freelance;

-- Add phone column (allow null for existing records)
ALTER TABLE users 
ADD COLUMN IF NOT EXISTS phone VARCHAR(50) UNIQUE AFTER email;

-- Add phone_verified flag
ALTER TABLE users 
ADD COLUMN IF NOT EXISTS phone_verified BOOLEAN DEFAULT FALSE AFTER email_verified;

-- Create index on phone for faster lookups
CREATE INDEX IF NOT EXISTS idx_phone ON users(phone);

-- Make email nullable (was NOT NULL before)
ALTER TABLE users 
MODIFY COLUMN email VARCHAR(255) UNIQUE;

-- Success message
SELECT 'Migration completed: phone column added to users table' AS status;
