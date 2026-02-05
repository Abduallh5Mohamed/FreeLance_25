#!/bin/bash

# This script updates only the changed JS/CSS files on the server

# Stop nginx
systemctl stop nginx

# Backup old files
cp -r /var/www/alqaed/assets /var/www/alqaed/assets.bak.$(date +%Y%m%d%H%M%S)

# Remove old JS/CSS files (keeping images)
find /var/www/alqaed/assets -name "index-*.js" -delete
find /var/www/alqaed/assets -name "index-*.css" -delete

# Copy new files from /tmp
cp /tmp/index-*.js /var/www/alqaed/assets/
cp /tmp/index-*.css /var/www/alqaed/assets/
cp /tmp/index.html /var/www/alqaed/

# Set permissions
chown -R www-data:www-data /var/www/alqaed
chmod -R 755 /var/www/alqaed

# Restart nginx
systemctl start nginx

echo "✅ Deploy complete!"
ls -la /var/www/alqaed/assets/*.js /var/www/alqaed/assets/*.css
