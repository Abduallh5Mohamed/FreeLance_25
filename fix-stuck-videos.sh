#!/bin/bash
echo "=== Fixing stuck uploading videos ==="

# These videos have files in MinIO but never got "complete" called
STUCK_VIDS="f7b2377e-5b3d-4b26-8d3b-69f66d647b16 f82ce9b3-3096-4caa-836a-545fa840ed92 4d166cfa-885e-471b-b130-7ed7c58f4845 d6fad027-2825-4f49-a051-75222d43c82d"

for vid in $STUCK_VIDS; do
    echo "Triggering processing for: $vid"
    curl -s -X POST http://localhost:3001/api/videos/upload/complete \
        -H "Content-Type: application/json" \
        -d "{\"videoId\": \"$vid\"}"
    echo ""
    sleep 1
done

echo ""
echo "=== Resetting failed videos ==="

# Reset failed videos that had encryption_key column error
mysql -u root -p'NewSecureP@ssw0rd2025!' freelance -e "UPDATE videos SET status='uploading', processing_progress=0, processing_error=NULL WHERE id IN ('bcbb7947-e3ea-4042-8ad6-d4a46c9eb285','cc664620-a908-405a-9cb8-416f05241b40');" 2>/dev/null

FAILED_VIDS="bcbb7947-e3ea-4042-8ad6-d4a46c9eb285 cc664620-a908-405a-9cb8-416f05241b40"

for vid in $FAILED_VIDS; do
    echo "Re-processing: $vid"
    curl -s -X POST http://localhost:3001/api/videos/upload/complete \
        -H "Content-Type: application/json" \
        -d "{\"videoId\": \"$vid\"}"
    echo ""
    sleep 1
done

echo ""
echo "=== Checking status after 10 seconds ==="
sleep 10

mysql -u root -p'NewSecureP@ssw0rd2025!' freelance -e "SELECT id, title, status, processing_progress, processing_error FROM videos ORDER BY created_at DESC LIMIT 10;" 2>/dev/null

echo "Done!"
