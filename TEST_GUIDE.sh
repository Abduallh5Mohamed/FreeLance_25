#!/bin/bash

# Online Student Registration Testing Script
# اختبار سير عمل تسجيل الطلاب الأونلاين

echo "========================================="
echo "   Online Registration Flow Testing"
echo "========================================="
echo ""

# Colors for output
GREEN='\033[0;32m'
BLUE='\033[0;34m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m' # No Color

echo -e "${BLUE}📝 Step 1: Frontend - Create Registration Request${NC}"
echo "URL: http://localhost:8080/auth"
echo "Action: Click 'إنشاء حساب جديد' → Select '🌐 أونلاين' → Fill form → Submit"
echo ""

echo -e "${BLUE}📝 Step 2: Backend - Save Registration Request${NC}"
echo "Database: MySQL - Freelance"
echo "Table: student_registration_requests"
echo "Fields: name, phone, grade_id, group_id, requested_courses, is_offline=0, status='pending'"
echo ""

echo -e "${BLUE}📝 Step 3: Admin - View Requests${NC}"
echo "URL: http://localhost:8080/registration-requests"
echo "Expected: Show all pending online registration requests"
echo "Columns: Name, Phone, Grade, Group, Courses, Date"
echo ""

echo -e "${GREEN}✅ Step 4: Admin - Approve Request${NC}"
echo "Action: Click 'قبول' button"
echo "Backend: POST /api/registration-requests/{id}/approve"
echo "Result: Create user, create student, enroll courses"
echo "User shows up in: /students page"
echo ""

echo -e "${RED}❌ Step 5: Admin - Reject Request${NC}"
echo "Action: Click 'رفض' button → Enter reason"
echo "Backend: POST /api/registration-requests/{id}/reject"
echo "Result: Save rejection reason, don't create user"
echo "User does NOT show up in: /students page"
echo ""

echo -e "${YELLOW}⚠️  Important Notes:${NC}"
echo "1. Online (أونلاين): Student sends request → Admin approves → Student created"
echo "2. Offline (أوفلاين): To be implemented later"
echo "3. Database: is_offline column (0=online, 1=offline)"
echo "4. All passwords are encrypted with bcrypt"
echo ""

echo -e "${BLUE}🧪 API Endpoints:${NC}"
echo ""
echo "1. Create Registration Request:"
echo "   POST /api/registration-requests"
echo "   Body: { name, phone, password, grade_id, group_id, requested_courses, is_offline }"
echo ""
echo "2. Get Registration Requests:"
echo "   GET /api/registration-requests?status=pending&is_offline=false"
echo "   Requires: Admin token"
echo ""
echo "3. Approve Request:"
echo "   POST /api/registration-requests/{id}/approve"
echo "   Requires: Admin token"
echo ""
echo "4. Reject Request:"
echo "   POST /api/registration-requests/{id}/reject"
echo "   Body: { reason: \"rejection reason\" }"
echo "   Requires: Admin token"
echo ""

echo -e "${GREEN}=========================================${NC}"
echo -e "${GREEN}Testing Guide Complete!${NC}"
echo -e "${GREEN}=========================================${NC}"
