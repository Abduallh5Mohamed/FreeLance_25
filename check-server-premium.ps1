# Connect to VPS and check premium lectures API
$password = "NewSecureP@ssw0rd2025!"

Write-Host "🔍 Connecting to VPS and checking premium lectures..." -ForegroundColor Cyan

# Create commands to run on server
$commands = @"
echo '=== Checking if server is running ==='
pm2 list

echo ''
echo '=== Checking server logs for errors ==='
pm2 logs alqaed-backend --lines 50 --nostream | grep -i "premium\|error\|500" || echo 'No recent errors found'

echo ''
echo '=== Testing database connection ==='
cd /root/alqaed
mysql -u alqaed_user -p'Q@ed2024Secure#DB!' alqaed -e "SELECT COUNT(*) as count FROM premium_lectures; SELECT COUNT(*) as count FROM premium_lecture_payments; SELECT COUNT(*) as count FROM premium_lecture_access;"

echo ''
echo '=== Checking if premium tables exist ==='
mysql -u alqaed_user -p'Q@ed2024Secure#DB!' alqaed -e "SHOW TABLES LIKE 'premium%';"

echo ''
echo '=== Testing the main query ==='
mysql -u alqaed_user -p'Q@ed2024Secure#DB!' alqaed -e "SELECT pl.id, pl.title, pl.price, gr.name as grade_name, g.name as group_name FROM premium_lectures pl LEFT JOIN grades gr ON pl.grade_id = gr.id LEFT JOIN \\\`groups\\\` g ON pl.group_id = g.id LIMIT 2;"

echo ''
echo '=== Checking Node.js build ==='
ls -la /root/alqaed/server/dist/routes/premium-lectures.js

echo ''
echo '=== Restarting server ==='
pm2 restart alqaed-backend

echo ''
echo '=== Waiting 3 seconds ==='
sleep 3

echo ''
echo '=== Checking new logs ==='
pm2 logs alqaed-backend --lines 20 --nostream
"@

# Execute via SSH
echo $password | ssh -o StrictHostKeyChecking=no root@72.62.35.177 $commands
