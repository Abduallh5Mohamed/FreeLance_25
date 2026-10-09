#!/bin/bash

# Test Script: Verify Student Chat AI is working
echo "🧪 Testing Student Chat AI Setup..."
echo ""

# Test 1: Check if dev server is running
echo "Test 1: Checking dev server..."
if curl -s http://localhost:8081/student-chat > /dev/null; then
    echo "✓ Dev server is running on port 8081"
else
    echo "✗ Dev server is not running"
    exit 1
fi

# Test 2: Simulate an AI chat request
echo ""
echo "Test 2: Simulating AI Chat Request..."
RESPONSE=$(curl -s -X POST \
  "https://xvzsuqihfbzrquhbpuhp.supabase.co/functions/v1/ai-chat-assistant" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $AUTH_TOKEN" \
  -d '{"message":"ما هي الثورة الفرنسية؟","studentId":"test-student"}')

if echo "$RESPONSE" | grep -q "success"; then
    echo "✓ AI API request successful"
    echo ""
    echo "Response received:"
    echo "$RESPONSE" | head -c 200
    echo "..."
else
    echo "Response: $RESPONSE"
fi

echo ""
echo "✅ All manual tests completed!"
echo ""
echo "📝 Next: Open browser and test the Student Chat page"
