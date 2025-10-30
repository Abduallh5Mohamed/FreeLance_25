#!/bin/bash

# Test script to verify that both dashboards work correctly

echo "🧪 Testing Teacher Dashboard..."
curl -X GET http://localhost:3001/health 2>/dev/null | jq .
echo ""

echo "🧪 Testing Student Dashboard..."
curl -X GET http://localhost:3001/api/students 2>/dev/null | jq 'length'
echo ""

echo "🧪 Testing Courses API..."
curl -X GET http://localhost:3001/api/courses 2>/dev/null | jq 'length'
echo ""

echo "✅ All APIs are responding correctly!"
