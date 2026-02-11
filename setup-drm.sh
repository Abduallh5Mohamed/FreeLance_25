#!/bin/bash
# ============================================
# DRM Setup Script for Al-Qaed Platform
# Automates FFmpeg installation and .env config
# Run on VPS: bash setup-drm.sh
# ============================================

set -e

echo "🔒 Al-Qaed DRM Setup Script"
echo "=========================="

# 1. Install FFmpeg
echo ""
echo "📦 Step 1: Installing FFmpeg..."
if command -v ffmpeg &> /dev/null; then
    echo "✅ FFmpeg already installed: $(ffmpeg -version 2>&1 | head -1)"
else
    apt update -y && apt install ffmpeg -y
    echo "✅ FFmpeg installed: $(ffmpeg -version 2>&1 | head -1)"
fi

# 2. Find the .env file
echo ""
echo "🔍 Step 2: Finding .env file..."
ENV_FILE=""

# Check common locations
POSSIBLE_PATHS=(
    "/var/www/alqaed/server/.env"
    "/var/www/alqaed/.env"
    "/root/server/.env"
    "/root/alqaed/server/.env"
    "/home/node/server/.env"
)

for p in "${POSSIBLE_PATHS[@]}"; do
    if [ -f "$p" ]; then
        ENV_FILE="$p"
        echo "✅ Found .env at: $ENV_FILE"
        break
    fi
done

# If not found, search
if [ -z "$ENV_FILE" ]; then
    echo "⚠️  .env not found in common paths, searching..."
    FOUND=$(find / -name ".env" -path "*/server/.env" 2>/dev/null | head -1)
    if [ -n "$FOUND" ]; then
        ENV_FILE="$FOUND"
        echo "✅ Found .env at: $ENV_FILE"
    else
        FOUND=$(find / -name ".env" 2>/dev/null | grep -v node_modules | grep -v ".git" | head -1)
        if [ -n "$FOUND" ]; then
            ENV_FILE="$FOUND"
            echo "✅ Found .env at: $ENV_FILE"
        else
            echo "❌ No .env file found! Please specify path:"
            read -p "Enter .env path: " ENV_FILE
        fi
    fi
fi

if [ ! -f "$ENV_FILE" ]; then
    echo "❌ .env file does not exist at: $ENV_FILE"
    exit 1
fi

echo ""
echo "📄 Current .env contents:"
echo "---"
cat "$ENV_FILE"
echo ""
echo "---"

# 3. Update FFMPEG_PATH
echo ""
echo "🔧 Step 3: Updating FFmpeg paths..."

FFMPEG_ACTUAL=$(which ffmpeg 2>/dev/null || echo "/usr/bin/ffmpeg")
FFPROBE_ACTUAL=$(which ffprobe 2>/dev/null || echo "/usr/bin/ffprobe")

# Remove old FFMPEG paths and add new ones
if grep -q "FFMPEG_PATH" "$ENV_FILE"; then
    sed -i "s|FFMPEG_PATH=.*|FFMPEG_PATH=$FFMPEG_ACTUAL|g" "$ENV_FILE"
    echo "✅ Updated FFMPEG_PATH to $FFMPEG_ACTUAL"
else
    echo "FFMPEG_PATH=$FFMPEG_ACTUAL" >> "$ENV_FILE"
    echo "✅ Added FFMPEG_PATH=$FFMPEG_ACTUAL"
fi

if grep -q "FFPROBE_PATH" "$ENV_FILE"; then
    sed -i "s|FFPROBE_PATH=.*|FFPROBE_PATH=$FFPROBE_ACTUAL|g" "$ENV_FILE"
    echo "✅ Updated FFPROBE_PATH to $FFPROBE_ACTUAL"
else
    echo "FFPROBE_PATH=$FFPROBE_ACTUAL" >> "$ENV_FILE"
    echo "✅ Added FFPROBE_PATH=$FFPROBE_ACTUAL"
fi

# 4. Enable encryption
echo ""
echo "🔐 Step 4: Enabling video encryption..."

if grep -q "ENABLE_VIDEO_ENCRYPTION" "$ENV_FILE"; then
    sed -i "s|ENABLE_VIDEO_ENCRYPTION=.*|ENABLE_VIDEO_ENCRYPTION=true|g" "$ENV_FILE"
    echo "✅ Updated ENABLE_VIDEO_ENCRYPTION=true"
else
    echo "ENABLE_VIDEO_ENCRYPTION=true" >> "$ENV_FILE"
    echo "✅ Added ENABLE_VIDEO_ENCRYPTION=true"
fi

# 5. Set API_BASE_URL
echo ""
echo "🌐 Step 5: Setting API_BASE_URL..."

# Get server IP
SERVER_IP=$(hostname -I 2>/dev/null | awk '{print $1}' || echo "72.62.35.177")
API_URL="http://${SERVER_IP}:3001"

if grep -q "API_BASE_URL" "$ENV_FILE"; then
    sed -i "s|API_BASE_URL=.*|API_BASE_URL=$API_URL|g" "$ENV_FILE"
    echo "✅ Updated API_BASE_URL=$API_URL"
else
    echo "API_BASE_URL=$API_URL" >> "$ENV_FILE"
    echo "✅ Added API_BASE_URL=$API_URL"
fi

# 6. Verify
echo ""
echo "📋 Step 6: Verifying updated .env..."
echo "---"
grep -E "(FFMPEG|FFPROBE|ENCRYPTION|API_BASE)" "$ENV_FILE"
echo "---"

# 7. Restart backend
echo ""
echo "🔄 Step 7: Restarting backend..."

# Find the server directory
SERVER_DIR=$(dirname "$ENV_FILE")
echo "Server directory: $SERVER_DIR"

if command -v pm2 &> /dev/null; then
    cd "$SERVER_DIR"
    pm2 restart all
    echo "✅ PM2 restarted"
    pm2 status
else
    echo "⚠️  PM2 not found. Please restart the backend manually."
fi

echo ""
echo "============================================"
echo "🎉 DRM Setup Complete!"
echo "============================================"
echo ""
echo "Next steps:"
echo "1. Upload a NEW video through the platform"
echo "2. The video will be automatically encrypted"
echo "3. Test by trying to screenshot - should be black!"
echo ""
echo "Note: Existing videos are NOT encrypted."
echo "To encrypt existing videos, use the reprocess API."
echo "============================================"
