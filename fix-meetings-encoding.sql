-- Fix encoding issue for meetings table
-- This script converts the corrupted UTF-8 data back to proper Arabic

-- First, check current data
SELECT 'Before Fix:' as Status;
SELECT id, title, description FROM online_meetings;

-- If the title is showing as question marks, it means the data is stored incorrectly
-- We need to correct it by re-inserting with proper encoding

-- For now, let's check what we have
SHOW FULL COLUMNS FROM online_meetings;
