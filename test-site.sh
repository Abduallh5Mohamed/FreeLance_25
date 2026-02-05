#!/bin/bash
echo "=== Testing Website ==="
curl -sI https://elka2d.cloud | head -15

echo ""
echo "=== Testing API ==="
curl -s https://elka2d.cloud/api/auth/me 2>/dev/null | head -5

echo ""
echo "=== All Systems Status ==="
echo "Nginx: $(systemctl is-active nginx)"
echo "Backend: $(pm2 status | grep online | wc -l) apps online"
echo "MySQL: $(systemctl is-active mysql)"
echo "MinIO: $(ps aux | grep minio | grep -v grep | wc -l) process"
