#!/bin/bash

echo "🏥 IDX-STC Simulator Health Check"
echo "================================="
echo ""

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

# Function to check status
check_status() {
    if [ $1 -eq 0 ]; then
        echo -e "${GREEN}✅ PASS${NC}"
        return 0
    else
        echo -e "${RED}❌ FAIL${NC}"
        return 1
    fi
}

FAILED=0

# 1. Check if PM2 process is running
echo -n "1. PM2 Process Status: "
if pm2 list | grep -q "idx-stc-simulator.*online"; then
    check_status 0
else
    check_status 1
    FAILED=$((FAILED + 1))
fi

# 2. Check restart count
echo -n "2. Restart Count: "
RESTART_COUNT=$(pm2 jlist | grep -A 20 "idx-stc-simulator" | grep "restart_time" | grep -o '[0-9]*' | head -1)
echo -n "$RESTART_COUNT "
if [ "$RESTART_COUNT" -lt 5 ]; then
    check_status 0
else
    echo -e "${YELLOW}⚠️  High restart count${NC}"
    FAILED=$((FAILED + 1))
fi

# 3. Check memory usage
echo -n "3. Memory Usage: "
MEMORY=$(pm2 jlist | grep -A 20 "idx-stc-simulator" | grep '"memory"' | grep -o '[0-9]*' | head -1)
MEMORY_MB=$((MEMORY / 1024 / 1024))
echo -n "${MEMORY_MB}MB "
if [ "$MEMORY_MB" -lt 120 ]; then
    check_status 0
else
    echo -e "${YELLOW}⚠️  High memory usage${NC}"
    FAILED=$((FAILED + 1))
fi

# 4. Check CPU usage
echo -n "4. CPU Usage: "
CPU=$(pm2 jlist | grep -A 20 "idx-stc-simulator" | grep '"cpu"' | grep -o '[0-9.]*' | head -1)
echo -n "${CPU}% "
if (( $(echo "$CPU < 50" | bc -l) )); then
    check_status 0
else
    echo -e "${YELLOW}⚠️  High CPU usage${NC}"
    FAILED=$((FAILED + 1))
fi

# 5. Check uptime
echo -n "5. Uptime: "
UPTIME=$(pm2 jlist | grep -A 20 "idx-stc-simulator" | grep "pm_uptime" | grep -o '[0-9]*' | head -1)
if [ -n "$UPTIME" ]; then
    UPTIME_SECONDS=$(($(date +%s) - UPTIME / 1000))
    UPTIME_MINUTES=$((UPTIME_SECONDS / 60))
    echo -n "${UPTIME_MINUTES}m "
    if [ "$UPTIME_MINUTES" -gt 5 ]; then
        check_status 0
    else
        echo -e "${YELLOW}⚠️  Recently restarted${NC}"
        FAILED=$((FAILED + 1))
    fi
else
    check_status 1
    FAILED=$((FAILED + 1))
fi

# 6. Check log file size
echo -n "6. Log File Size: "
if [ -f "simulator.log" ]; then
    LOG_SIZE=$(du -h simulator.log | cut -f1)
    echo -n "$LOG_SIZE "
    LOG_SIZE_KB=$(du -k simulator.log | cut -f1)
    if [ "$LOG_SIZE_KB" -lt 10240 ]; then  # Less than 10MB
        check_status 0
    else
        echo -e "${YELLOW}⚠️  Large log file${NC}"
    fi
else
    echo -e "${YELLOW}⚠️  Log file not found${NC}"
fi

# 7. Check error log for recent errors
echo -n "7. Recent Errors (last 10 lines): "
if [ -f "simulator.log" ]; then
    ERROR_COUNT=$(tail -10 simulator.log | grep -i "error" | wc -l)
    echo -n "$ERROR_COUNT errors "
    if [ "$ERROR_COUNT" -lt 3 ]; then
        check_status 0
    else
        echo -e "${YELLOW}⚠️  Multiple recent errors${NC}"
        FAILED=$((FAILED + 1))
    fi
else
    echo -e "${YELLOW}⚠️  Cannot check${NC}"
fi

# 8. Check Firebase connectivity
echo -n "8. Firebase Connection: "
if grep -q "Firebase connection successful" simulator.log; then
    check_status 0
else
    check_status 1
    FAILED=$((FAILED + 1))
fi

echo ""
echo "================================="
if [ $FAILED -eq 0 ]; then
    echo -e "${GREEN}🎉 All checks passed!${NC}"
    echo -e "${GREEN}System is healthy${NC}"
else
    echo -e "${RED}⚠️  $FAILED checks failed${NC}"
    echo -e "${YELLOW}System needs attention${NC}"
fi
echo ""

# Show recent activity
echo "📊 Recent Activity (last 5 log entries):"
echo "---------------------------------------"
tail -5 simulator.log | grep "OHLC"
echo ""

# Show PM2 status
echo "📋 PM2 Status:"
echo "---------------------------------------"
pm2 show idx-stc-simulator | grep -E "status|uptime|restart|memory|cpu"
echo ""

exit $FAILED