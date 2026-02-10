#!/bin/bash
echo "Checking videos in database..."
mysql -u root alqaed_db -se "SELECT COUNT(*) as total FROM lectures WHERE video_url IS NOT NULL;"
echo ""
echo "Sample video URLs:"
mysql -u root alqaed_db -se "SELECT video_url FROM lectures WHERE video_url IS NOT NULL LIMIT 3;"
echo ""
echo "Sample lecture with video:"
mysql -u root alqaed_db -se "SELECT id, title, video_type FROM lectures WHERE video_url IS NOT NULL LIMIT 1;"
