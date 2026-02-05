#!/bin/bash

echo "Deploying new frontend..."

# Backup current
cp -r /var/www/alqaed /var/www/alqaed.backup.$(date +%Y%m%d%H%M%S)

# Extract and deploy
cd /tmp
tar -xzf dist.tar.gz
rm -rf /var/www/alqaed/*
cp -r dist/* /var/www/alqaed/

# Set permissions
chown -R root:root /var/www/alqaed
chmod -R 755 /var/www/alqaed
find /var/www/alqaed -type f -exec chmod 644 {} \;

# Clear old backups (keep last 3)
ls -dt /var/www/alqaed.backup.* 2>/dev/null | tail -n +4 | xargs rm -rf 2>/dev/null

echo "Frontend deployed successfully!"

# Show what's deployed
echo ""
echo "=== Deployed Files ==="
ls -la /var/www/alqaed/
