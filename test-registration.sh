#!/bin/bash
# Script to test the online registration flow

echo "=== Testing Online Registration Flow ==="
echo ""

# Test 1: Create a registration request
echo "1️⃣  Creating online registration request..."
curl -X POST http://localhost:3001/api/registration-requests \
  -H "Content-Type: application/json" \
  -d '{
    "name": "أحمد محمد",
    "phone": "01012345678",
    "password": "Password123!",
    "grade_id": "grade-1",
    "group_id": "group-1",
    "requested_courses": ["course-1", "course-2"],
    "is_offline": false
  }' 2>/dev/null | jq .
echo ""
echo ""

# Test 2: Fetch registration requests (requires auth token)
echo "2️⃣  Fetching registration requests..."
echo "Note: This requires authentication token"
echo ""
echo "Example: curl -H 'Authorization: Bearer YOUR_TOKEN' http://localhost:3001/api/registration-requests?is_offline=false"
echo ""

echo "=== Test Complete ==="
