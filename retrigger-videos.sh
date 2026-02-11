#!/bin/bash
# Check current status
echo "=== Current Status ==="
mysql -u root -pNewSecureP@ssw0rd2025! freelance 2>/dev/null -e "SELECT id, status, processing_progress FROM videos WHERE status IN ('processing','uploading') ORDER BY created_at DESC;"

# Reset and re-trigger processing for stuck videos
echo ""
echo "=== Re-triggering stuck processing videos ==="
mysql -u root -pNewSecureP@ssw0rd2025! freelance 2>/dev/null -e "UPDATE videos SET status='uploading', processing_progress=0 WHERE status='processing';"

STUCK=$(mysql -u root -pNewSecureP@ssw0rd2025! freelance 2>/dev/null -N -e "SELECT id FROM videos WHERE status='uploading';")

for vid in $STUCK; do
    echo "Re-processing: $vid"
    curl -s -X POST http://localhost:3001/api/videos/upload/complete \
        -H "Content-Type: application/json" \
        -d "{\"videoId\": \"$vid\"}"
    echo ""
    sleep 1
done

echo ""
echo "=== Status after re-trigger ==="
sleep 5
mysql -u root -pNewSecureP@ssw0rd2025! freelance 2>/dev/null -e "SELECT id, status, processing_progress FROM videos ORDER BY created_at DESC LIMIT 10;"
