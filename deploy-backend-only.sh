#!/bin/bash
echo "=== Deploying backend ==="
cp /tmp/index.js /var/www/alqaed-api/dist/index.js
cp /tmp/videos.js /var/www/alqaed-api/dist/routes/videos.js

# Don't restart now - let current processing complete
echo "Backend files updated."
echo ""
echo "=== Current Processing Status ==="
mysql -u root -pNewSecureP@ssw0rd2025! freelance 2>/dev/null -e "SELECT id, status, processing_progress FROM videos ORDER BY created_at DESC LIMIT 10;"
echo "Done. Will restart PM2 after videos finish."
