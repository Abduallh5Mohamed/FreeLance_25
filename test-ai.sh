#!/bin/bash

# Get token
echo "Getting token..."
RESPONSE=$(curl -s -X POST http://localhost:3001/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"phone":"01024083057","password":"Mtd#mora55"}')

echo "Login response: $RESPONSE"

TOKEN=$(echo $RESPONSE | grep -o '"token":"[^"]*"' | cut -d'"' -f4)
echo "Token: ${TOKEN:0:50}..."

if [ -z "$TOKEN" ]; then
  echo "Failed to get token"
  exit 1
fi

# Test AI Chat
echo ""
echo "Testing AI Chat..."
AI_RESPONSE=$(curl -s -X POST http://localhost:3001/api/ai-chat/chat \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d '{"message":"مرحبا"}')

echo "AI Response: $AI_RESPONSE"
