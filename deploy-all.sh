#!/bin/bash
echo "=== Deploying Frontend ==="
# Remove old build files
rm -f /var/www/alqaed/dist/assets/index-*.js /var/www/alqaed/dist/assets/index-*.css

# Copy new files
cp /tmp/index.html /var/www/alqaed/dist/index.html
cp /tmp/index-1770824935853.js /var/www/alqaed/dist/assets/
cp /tmp/index-BJ4fcJtK.css /var/www/alqaed/dist/assets/

echo "Frontend files:"
ls -la /var/www/alqaed/dist/assets/index-*

echo ""
echo "=== Deploying Backend ==="
cp /tmp/videos.js /var/www/alqaed-api/dist/routes/videos.js

echo ""
echo "=== Restarting Services ==="
systemctl restart nginx
pm2 stop alqaed-api 2>/dev/null
sleep 2
fuser -k 3001/tcp 2>/dev/null
sleep 1
pm2 start alqaed-api
sleep 3
pm2 list

echo ""
echo "=== Current Video Status ==="
mysql freelance -e "SELECT status, processing_progress FROM videos ORDER BY created_at DESC LIMIT 10;"

echo ""
echo "=== Done ==="
