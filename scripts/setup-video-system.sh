#!/bin/bash

# =====================================================
# MinIO + FFmpeg Setup Script for VPS
# Run this on your Hostinger VPS
# =====================================================

set -e

echo "🚀 Starting Video System Setup..."

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Configuration
MINIO_ROOT_USER="minioadmin"
MINIO_ROOT_PASSWORD=""
MINIO_DATA_DIR="/data/minio"
MINIO_PORT=9000
MINIO_CONSOLE_PORT=9001

# Prompt for MinIO password if not set
if [ -z "$MINIO_ROOT_PASSWORD" ]; then
    echo -e "${YELLOW}Enter a secure password for MinIO:${NC}"
    read -s MINIO_ROOT_PASSWORD
    echo ""
fi

# Check if running as root
if [ "$EUID" -ne 0 ]; then
    echo -e "${RED}Please run as root (sudo)${NC}"
    exit 1
fi

echo -e "${GREEN}Step 1: Updating system packages...${NC}"
apt update && apt upgrade -y

echo -e "${GREEN}Step 2: Installing FFmpeg...${NC}"
apt install -y ffmpeg
ffmpeg -version

echo -e "${GREEN}Step 3: Downloading and installing MinIO...${NC}"
# Download MinIO binary
wget -q https://dl.min.io/server/minio/release/linux-amd64/minio -O /usr/local/bin/minio
chmod +x /usr/local/bin/minio

# Create data directory
mkdir -p $MINIO_DATA_DIR
chown -R $SUDO_USER:$SUDO_USER $MINIO_DATA_DIR 2>/dev/null || true

echo -e "${GREEN}Step 4: Creating MinIO systemd service...${NC}"
cat > /etc/systemd/system/minio.service << EOF
[Unit]
Description=MinIO Object Storage
Documentation=https://docs.min.io
After=network-online.target
Wants=network-online.target

[Service]
User=root
Group=root
Environment="MINIO_ROOT_USER=${MINIO_ROOT_USER}"
Environment="MINIO_ROOT_PASSWORD=${MINIO_ROOT_PASSWORD}"
ExecStart=/usr/local/bin/minio server ${MINIO_DATA_DIR} --console-address ":${MINIO_CONSOLE_PORT}"
Restart=always
RestartSec=10
LimitNOFILE=65536

[Install]
WantedBy=multi-user.target
EOF

echo -e "${GREEN}Step 5: Starting MinIO service...${NC}"
systemctl daemon-reload
systemctl enable minio
systemctl start minio

# Wait for MinIO to start
sleep 5

echo -e "${GREEN}Step 6: Installing MinIO client (mc)...${NC}"
wget -q https://dl.min.io/client/mc/release/linux-amd64/mc -O /usr/local/bin/mc
chmod +x /usr/local/bin/mc

# Configure mc alias
mc alias set local http://localhost:${MINIO_PORT} ${MINIO_ROOT_USER} ${MINIO_ROOT_PASSWORD}

echo -e "${GREEN}Step 7: Creating MinIO buckets...${NC}"
mc mb local/videos-original --ignore-existing
mc mb local/videos-hls --ignore-existing
mc mb local/videos-thumbnails --ignore-existing

# Set bucket policies (private by default)
echo -e "${GREEN}Step 8: Configuring bucket policies...${NC}"
# All buckets are private by default - access via presigned URLs only

echo -e "${GREEN}Step 9: Creating video processing temp directory...${NC}"
mkdir -p /tmp/video-processing
chmod 777 /tmp/video-processing

echo ""
echo -e "${GREEN}✅ Setup Complete!${NC}"
echo ""
echo "=================================================="
echo "MinIO Access Information:"
echo "=================================================="
echo "API URL:      http://localhost:${MINIO_PORT}"
echo "Console URL:  http://localhost:${MINIO_CONSOLE_PORT}"
echo "Username:     ${MINIO_ROOT_USER}"
echo "Password:     ${MINIO_ROOT_PASSWORD}"
echo ""
echo "Buckets created:"
echo "  - videos-original"
echo "  - videos-hls"
echo "  - videos-thumbnails"
echo ""
echo "=================================================="
echo "Next Steps:"
echo "=================================================="
echo "1. Add these to your .env file:"
echo ""
echo "MINIO_ENDPOINT=localhost"
echo "MINIO_PORT=${MINIO_PORT}"
echo "MINIO_USE_SSL=false"
echo "MINIO_ACCESS_KEY=${MINIO_ROOT_USER}"
echo "MINIO_SECRET_KEY=${MINIO_ROOT_PASSWORD}"
echo "MINIO_BUCKET_ORIGINALS=videos-original"
echo "MINIO_BUCKET_HLS=videos-hls"
echo "MINIO_BUCKET_THUMBNAILS=videos-thumbnails"
echo ""
echo "2. Configure Nginx to proxy MinIO (optional for external access)"
echo ""
echo "3. Run the database migration:"
echo "   mysql -u root -p your_database < database/video-system-migration.sql"
echo ""
echo "=================================================="

# Check services
echo -e "${GREEN}Service Status:${NC}"
systemctl status minio --no-pager || true
