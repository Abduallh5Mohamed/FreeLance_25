#!/bin/bash

echo "🔍 Checking Premium Lectures on VPS..."

# Check PM2 status
echo ""
echo "=== PM2 Status ==="
pm2 list

# Check recent logs
echo ""
echo "=== Recent Server Logs (last 30 lines) ==="
pm2 logs alqaed-backend --lines 30 --nostream

# Check if tables exist
echo ""
echo "=== Checking Premium Tables ==="
mysql -u alqaed_user -p'Q@ed2024Secure#DB!' alqaed -e "SHOW TABLES LIKE 'premium%';"

# Check table counts
echo ""
echo "=== Table Counts ==="
mysql -u alqaed_user -p'Q@ed2024Secure#DB!' alqaed -e "
SELECT 
  (SELECT COUNT(*) FROM premium_lectures) as lectures_count,
  (SELECT COUNT(*) FROM premium_lecture_payments) as payments_count,
  (SELECT COUNT(*) FROM premium_lecture_access) as access_count;
"

# Test the problematic query
echo ""
echo "=== Testing Main Query ==="
mysql -u alqaed_user -p'Q@ed2024Secure#DB!' alqaed -e "
SELECT 
  pl.id,
  pl.title,
  pl.price,
  gr.name as grade_name,
  g.name as group_name
FROM premium_lectures pl
LEFT JOIN grades gr ON pl.grade_id = gr.id
LEFT JOIN \`groups\` g ON pl.group_id = g.id
LIMIT 2;
" 2>&1

# Check if the route file exists
echo ""
echo "=== Checking Route File ==="
ls -la /root/alqaed/server/dist/routes/premium-lectures.js

# Check server .env
echo ""
echo "=== Server Environment ==="
grep "DB_" /root/alqaed/server/.env

echo ""
echo "✅ Check complete!"
