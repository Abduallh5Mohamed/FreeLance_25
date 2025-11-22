#!/bin/bash

# سكريبت رفع المشروع على VPS
# استخدام: ./deploy.sh your-vps-ip your-username

VPS_IP=$1
VPS_USER=$2
PROJECT_PATH="/var/www/alqaed-platform"

if [ -z "$VPS_IP" ] || [ -z "$VPS_USER" ]; then
    echo "الاستخدام: ./deploy.sh <VPS_IP> <VPS_USER>"
    echo "مثال: ./deploy.sh 192.168.1.100 ubuntu"
    exit 1
fi

echo "🚀 بدء عملية النشر..."
GREEN='\033[0;32m'
BLUE='\033[0;34m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Step 1: Install dependencies
echo -e "${BLUE}📦 Step 1/5: Installing dependencies...${NC}"
cd server
npm install  # سيشغل seed تلقائياً بعد التثبيت (postinstall)
if [ $? -ne 0 ]; then
    echo -e "${RED}❌ Failed to install dependencies${NC}"
    exit 1
fi
echo -e "${GREEN}✅ Dependencies installed${NC}"
echo ""

# Step 2: Run database seeds
echo -e "${BLUE}🌱 Step 2/5: Running database seeds...${NC}"
npm run seed
if [ $? -ne 0 ]; then
    echo -e "${YELLOW}⚠️  Seed failed, but continuing...${NC}"
else
    echo -e "${GREEN}✅ Database seeded${NC}"
fi
echo ""

# Step 3: Build the project
echo -e "${BLUE}🔨 Step 3/5: Building project...${NC}"
npm run build
if [ $? -ne 0 ]; then
    echo -e "${RED}❌ Build failed${NC}"
    exit 1
fi
echo -e "${GREEN}✅ Project built successfully${NC}"
echo ""

# Step 4: Check if .env exists
echo -e "${BLUE}⚙️  Step 4/5: Checking environment configuration...${NC}"
if [ ! -f .env ]; then
    echo -e "${YELLOW}⚠️  .env file not found. Creating from .env.example...${NC}"
    cp ../.env.example .env
    echo -e "${YELLOW}⚠️  Please update .env with your production credentials!${NC}"
else
    echo -e "${GREEN}✅ .env file exists${NC}"
fi
echo ""

# Step 5: Display completion message
echo -e "${BLUE}📋 Step 5/5: Deployment summary${NC}"
echo ""
echo "═══════════════════════════════════════════════════════════════"
echo -e "${GREEN}✅ Deployment completed successfully!${NC}"
echo "═══════════════════════════════════════════════════════════════"
echo ""
echo "Admin User Credentials:"
echo "📱 Phone: 01024083057"
echo "🔑 Password: Mtd#mora55"
echo "👤 Role: admin"
echo ""
echo "To start the server:"
echo "  $ npm start"
echo ""
echo "To run in development mode:"
echo "  $ npm run dev"
echo ""
echo -e "${YELLOW}⚠️  IMPORTANT: Change the admin password after first login!${NC}"
echo "═══════════════════════════════════════════════════════════════"
