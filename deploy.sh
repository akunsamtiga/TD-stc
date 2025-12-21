#!/bin/bash

echo "🚀 IDX-STC Simulator Deployment Script"
echo "========================================"
echo ""

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Check if running as correct user
if [ "$USER" != "stcautotrade" ]; then
    echo -e "${YELLOW}⚠️  Warning: Not running as stcautotrade user${NC}"
fi

# Create backup directory
BACKUP_DIR="./backups/$(date +%Y%m%d_%H%M%S)"
mkdir -p "$BACKUP_DIR"

echo "📦 Creating backup..."
cp index.js "$BACKUP_DIR/" 2>/dev/null || true
cp package.json "$BACKUP_DIR/" 2>/dev/null || true
cp .env "$BACKUP_DIR/" 2>/dev/null || true
echo -e "${GREEN}✅ Backup created at $BACKUP_DIR${NC}"
echo ""

# Check PM2 status
echo "🔍 Checking PM2 status..."
if pm2 list | grep -q "idx-stc-simulator"; then
    echo -e "${GREEN}✅ PM2 process found${NC}"
    PM2_RUNNING=true
else
    echo -e "${YELLOW}⚠️  PM2 process not found${NC}"
    PM2_RUNNING=false
fi
echo ""

# Stop the current process
if [ "$PM2_RUNNING" = true ]; then
    echo "⏸️  Stopping current process..."
    pm2 stop idx-stc-simulator
    echo -e "${GREEN}✅ Process stopped${NC}"
    echo ""
fi

# Install dependencies
echo "📥 Installing dependencies..."
npm install
if [ $? -eq 0 ]; then
    echo -e "${GREEN}✅ Dependencies installed${NC}"
else
    echo -e "${RED}❌ Failed to install dependencies${NC}"
    exit 1
fi
echo ""

# Create logs directory if not exists
mkdir -p logs

# Test configuration
echo "🧪 Testing configuration..."
npm run test
if [ $? -eq 0 ]; then
    echo -e "${GREEN}✅ Configuration test passed${NC}"
else
    echo -e "${RED}❌ Configuration test failed${NC}"
    echo ""
    echo "Restoring backup..."
    cp "$BACKUP_DIR/index.js" ./index.js 2>/dev/null || true
    exit 1
fi
echo ""

# Start with PM2
echo "🚀 Starting simulator with PM2..."
if [ "$PM2_RUNNING" = true ]; then
    pm2 restart idx-stc-simulator
else
    pm2 start ecosystem.config.cjs
fi

if [ $? -eq 0 ]; then
    echo -e "${GREEN}✅ Simulator started successfully${NC}"
else
    echo -e "${RED}❌ Failed to start simulator${NC}"
    exit 1
fi
echo ""

# Save PM2 configuration
pm2 save

echo "📊 Current PM2 Status:"
pm2 list
echo ""

echo "💾 Memory usage:"
pm2 show idx-stc-simulator | grep -E "memory|cpu|restart"
echo ""

echo -e "${GREEN}✅ Deployment completed successfully!${NC}"
echo ""
echo "Useful commands:"
echo "  pm2 logs idx-stc-simulator   - View logs"
echo "  pm2 monit                    - Monitor in real-time"
echo "  pm2 restart idx-stc-simulator - Restart"
echo "  pm2 stop idx-stc-simulator    - Stop"
echo ""