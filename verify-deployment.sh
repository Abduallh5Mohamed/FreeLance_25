#!/bin/bash

echo "================================"
echo "🔍 Post-Upload Verification"
echo "================================"
echo ""

# Colors
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# File to check
FILE="/var/www/alqaed/assets/index-1770302450944.js"

# Test 1: File exists and size
echo "Test 1: File Existence and Size"
if [ -f "$FILE" ]; then
    SIZE=$(stat -f%z "$FILE" 2>/dev/null || stat -c%s "$FILE" 2>/dev/null)
    SIZE_MB=$(echo "scale=2; $SIZE/1024/1024" | bc)
    echo -e "${GREEN}✓${NC} File exists: $FILE"
    echo -e "${GREEN}✓${NC} Size: ${SIZE_MB} MB"
else
    echo -e "${RED}✗${NC} File NOT found: $FILE"
    exit 1
fi

echo ""

# Test 2: Version checker code present
echo "Test 2: Version Checker Code"
if grep -q "__APP_VERSION_CHECK_ENABLED__" "$FILE"; then
    echo -e "${GREEN}✓${NC} Version checker code found"
else
    echo -e "${RED}✗${NC} Version checker code MISSING"
    exit 1
fi

echo ""

# Test 3: Console log messages
echo "Test 3: Debug Console Logs"
if grep -q "App mounted - Starting version checker" "$FILE"; then
    echo -e "${GREEN}✓${NC} Debug log messages found"
else
    echo -e "${RED}✗${NC} Debug log messages MISSING"
    exit 1
fi

echo ""

# Test 4: index.html references new file
echo "Test 4: index.html Reference"
if grep -q "index-1770302450944.js" "/var/www/alqaed/index.html"; then
    echo -e "${GREEN}✓${NC} index.html references new build"
else
    echo -e "${YELLOW}⚠${NC} index.html may reference old build"
fi

echo ""

# Test 5: File permissions
echo "Test 5: File Permissions"
PERMS=$(stat -f%Lp "$FILE" 2>/dev/null || stat -c%a "$FILE" 2>/dev/null)
if [ "$PERMS" = "644" ] || [ "$PERMS" = "755" ]; then
    echo -e "${GREEN}✓${NC} Permissions OK: $PERMS"
else
    echo -e "${YELLOW}⚠${NC} Permissions: $PERMS (expected 644 or 755)"
fi

echo ""

# Test 6: Web server can access
echo "Test 6: Web Server Access Test"
if curl -s -o /dev/null -w "%{http_code}" "https://elka2d.cloud/assets/index-1770302450944.js" | grep -q "200"; then
    echo -e "${GREEN}✓${NC} File accessible via web server"
else
    echo -e "${RED}✗${NC} File NOT accessible via web (try: systemctl restart nginx)"
fi

echo ""
echo "================================"
echo "📊 Summary"
echo "================================"
echo ""
echo "Next Step: Open browser and check console for:"
echo "   🚀 App mounted - Starting version checker"
echo "   📋 Current build version: 1770302450944"
echo ""
echo "If you see these messages, deployment is SUCCESS! ✅"
echo ""
