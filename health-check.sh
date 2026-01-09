echo "🏥 Multi-Asset Simulator Health Check"
echo "======================================"
echo ""

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
BOLD='\033[1m'
NC='\033[0m'

# Counters
FAILED=0
WARNINGS=0

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

check_warning() {
    echo -e "${YELLOW}⚠️  WARNING${NC}"
    WARNINGS=$((WARNINGS + 1))
}

# ============================================
# 1. PM2 PROCESS STATUS
# ============================================
echo -n "1. PM2 Process Status: "
if pm2 list | grep -q "multi-asset-simulator.*online"; then
    check_status 0
else
    check_status 1
    FAILED=$((FAILED + 1))
    echo "   ${RED}Process not running! Start with: pm2 start ecosystem.config.cjs${NC}"
fi

# ============================================
# 2. RESTART COUNT
# ============================================
echo -n "2. Restart Count: "
RESTART_COUNT=$(pm2 jlist | grep -A 30 "multi-asset-simulator" | grep "restart_time" | grep -o '[0-9]*' | head -1)
if [ -z "$RESTART_COUNT" ]; then
    RESTART_COUNT=0
fi

echo -n "$RESTART_COUNT "
if [ "$RESTART_COUNT" -lt 10 ]; then
    check_status 0
elif [ "$RESTART_COUNT" -lt 20 ]; then
    check_warning
    echo "   ${YELLOW}High restart count - check logs for issues${NC}"
else
    check_status 1
    FAILED=$((FAILED + 1))
    echo "   ${RED}Critical: Too many restarts - check configuration${NC}"
fi

# ============================================
# 3. MEMORY USAGE
# ============================================
echo -n "3. Memory Usage: "
MEMORY=$(pm2 jlist | grep -A 30 "multi-asset-simulator" | grep '"memory"' | grep -o '[0-9]*' | head -1)
if [ -z "$MEMORY" ]; then
    echo -e "${YELLOW}Cannot determine${NC}"
    check_warning
else
    MEMORY_MB=$((MEMORY / 1024 / 1024))
    echo -n "${MEMORY_MB}MB "
    
    if [ "$MEMORY_MB" -lt 200 ]; then
        check_status 0
    elif [ "$MEMORY_MB" -lt 300 ]; then
        check_warning
        echo "   ${YELLOW}Memory usage moderate${NC}"
    else
        check_status 1
        FAILED=$((FAILED + 1))
        echo "   ${RED}Memory usage high - may restart soon${NC}"
    fi
fi

# ============================================
# 4. CPU USAGE
# ============================================
echo -n "4. CPU Usage: "
CPU=$(pm2 jlist | grep -A 30 "multi-asset-simulator" | grep '"cpu"' | grep -o '[0-9.]*' | head -1)
if [ -z "$CPU" ]; then
    echo -e "${YELLOW}Cannot determine${NC}"
    check_warning
else
    echo -n "${CPU}% "
    
    if (( $(echo "$CPU < 30" | bc -l 2>/dev/null || echo "0") )); then
        check_status 0
    elif (( $(echo "$CPU < 60" | bc -l 2>/dev/null || echo "0") )); then
        check_warning
        echo "   ${YELLOW}CPU usage moderate${NC}"
    else
        check_status 1
        FAILED=$((FAILED + 1))
        echo "   ${RED}CPU usage high${NC}"
    fi
fi

# ============================================
# 5. UPTIME
# ============================================
echo -n "5. Uptime: "
UPTIME=$(pm2 jlist | grep -A 30 "multi-asset-simulator" | grep "pm_uptime" | grep -o '[0-9]*' | head -1)
if [ -n "$UPTIME" ]; then
    UPTIME_SECONDS=$(($(date +%s) - UPTIME / 1000))
    UPTIME_MINUTES=$((UPTIME_SECONDS / 60))
    UPTIME_HOURS=$((UPTIME_MINUTES / 60))
    UPTIME_DAYS=$((UPTIME_HOURS / 24))
    
    echo -n ""
    if [ "$UPTIME_DAYS" -gt 0 ]; then
        echo -n "${UPTIME_DAYS}d ${UPTIME_HOURS}h "
    elif [ "$UPTIME_HOURS" -gt 0 ]; then
        echo -n "${UPTIME_HOURS}h ${UPTIME_MINUTES}m "
    else
        echo -n "${UPTIME_MINUTES}m "
    fi
    
    if [ "$UPTIME_MINUTES" -gt 10 ]; then
        check_status 0
    else
        check_warning
        echo "   ${YELLOW}Recently started/restarted${NC}"
    fi
else
    check_status 1
    FAILED=$((FAILED + 1))
fi

# ============================================
# 6. LOG FILE SIZE
# ============================================
echo -n "6. Log File Size: "
if [ -f "simulator.log" ]; then
    LOG_SIZE=$(du -h simulator.log 2>/dev/null | cut -f1)
    echo -n "$LOG_SIZE "
    LOG_SIZE_KB=$(du -k simulator.log 2>/dev/null | cut -f1)
    
    if [ "$LOG_SIZE_KB" -lt 5120 ]; then
        check_status 0
    elif [ "$LOG_SIZE_KB" -lt 10240 ]; then
        check_warning
        echo "   ${YELLOW}Log file getting large, consider rotation${NC}"
    else
        check_status 1
        FAILED=$((FAILED + 1))
        echo "   ${RED}Log file too large (>10MB)${NC}"
        echo "   ${YELLOW}Rotate with: npm run clean${NC}"
    fi
else
    echo -e "${YELLOW}No log file found${NC}"
    check_warning
fi

# ============================================
# 7. RECENT ERRORS
# ============================================
echo -n "7. Recent Errors (last 50 lines): "
if [ -f "simulator.log" ]; then
    ERROR_COUNT=$(tail -50 simulator.log 2>/dev/null | grep -i "error\|fail\|crash" | wc -l)
    echo -n "$ERROR_COUNT errors "
    
    if [ "$ERROR_COUNT" -lt 3 ]; then
        check_status 0
    elif [ "$ERROR_COUNT" -lt 10 ]; then
        check_warning
        echo "   ${YELLOW}Some errors detected${NC}"
    else
        check_status 1
        FAILED=$((FAILED + 1))
        echo "   ${RED}Many errors - check logs immediately${NC}"
    fi
else
    echo -e "${YELLOW}Cannot check${NC}"
    check_warning
fi

# ============================================
# 8. FIREBASE CONNECTION
# ============================================
echo -n "8. Firebase Connection: "
if [ -f "simulator.log" ]; then
    if tail -100 simulator.log 2>/dev/null | grep -q "Firebase.*initialized\|Firebase.*ready"; then
        # Check for recent disconnection
        if tail -50 simulator.log 2>/dev/null | grep -q "disconnected\|connection.*failed"; then
            check_warning
            echo "   ${YELLOW}Recent connection issues detected${NC}"
        else
            check_status 0
        fi
    else
        check_status 1
        FAILED=$((FAILED + 1))
        echo "   ${RED}Firebase may not be connected${NC}"
    fi
else
    echo -e "${YELLOW}Cannot check${NC}"
    check_warning
fi

# ============================================
# 9. WRITE SUCCESS RATE
# ============================================
echo -n "9. Write Operations: "
if [ -f "simulator.log" ]; then
    RECENT_LOGS=$(tail -100 simulator.log 2>/dev/null)
    
    # Check for write success
    if echo "$RECENT_LOGS" | grep -q "Write.*success\|success.*write"; then
        check_status 0
    else
        check_warning
        echo "   ${YELLOW}No recent successful writes detected${NC}"
    fi
else
    echo -e "${YELLOW}Cannot check${NC}"
    check_warning
fi

# ============================================
# 10. DISK SPACE
# ============================================
echo -n "10. Disk Space: "
DISK_USAGE=$(df -h . | awk 'NR==2 {print $5}' | sed 's/%//')
DISK_AVAIL=$(df -h . | awk 'NR==2 {print $4}')

echo -n "${DISK_USAGE}% used (${DISK_AVAIL} free) "

if [ "$DISK_USAGE" -lt 70 ]; then
    check_status 0
elif [ "$DISK_USAGE" -lt 85 ]; then
    check_warning
    echo "   ${YELLOW}Disk space getting low${NC}"
else
    check_status 1
    FAILED=$((FAILED + 1))
    echo "   ${RED}Disk space critical${NC}"
fi

# ============================================
# SUMMARY
# ============================================
echo ""
echo "======================================"
if [ $FAILED -eq 0 ] && [ $WARNINGS -eq 0 ]; then
    echo -e "${GREEN}${BOLD}🎉 Perfect Health!${NC}"
    echo -e "${GREEN}All systems operational${NC}"
elif [ $FAILED -eq 0 ]; then
    echo -e "${YELLOW}${BOLD}⚠️  Minor Issues Detected${NC}"
    echo -e "${YELLOW}Warnings: $WARNINGS${NC}"
    echo -e "${YELLOW}System is running but needs attention${NC}"
else
    echo -e "${RED}${BOLD}❌ Health Check Failed${NC}"
    echo -e "${RED}Failed: $FAILED | Warnings: $WARNINGS${NC}"
    echo -e "${RED}System needs immediate attention${NC}"
fi
echo ""

# ============================================
# RECENT ACTIVITY
# ============================================
echo "📊 Recent Activity (last 10 log entries):"
echo "---------------------------------------"
if [ -f "simulator.log" ]; then
    tail -10 simulator.log 2>/dev/null | grep -E "OHLC|Asset|Simulator|Update" || echo "No recent activity"
else
    echo "No log file found"
fi
echo ""

# ============================================
# PM2 STATUS DETAILS
# ============================================
echo "📋 PM2 Process Details:"
echo "---------------------------------------"
if pm2 list | grep -q "multi-asset-simulator"; then
    pm2 show multi-asset-simulator 2>/dev/null | grep -E "status|uptime|restart|memory|cpu|created" || echo "Cannot get PM2 details"
else
    echo "Process not running"
fi
echo ""

# ============================================
# RECOMMENDATIONS
# ============================================
if [ $FAILED -gt 0 ] || [ $WARNINGS -gt 0 ]; then
    echo "💡 Recommended Actions:"
    echo "---------------------------------------"
    
    if [ $FAILED -gt 0 ]; then
        echo "  ${RED}Critical:${NC}"
        echo "    1. Check logs: tail -f simulator.log"
        echo "    2. Restart: pm2 restart multi-asset-simulator"
        echo "    3. Check .env configuration"
    fi
    
    if [ $WARNINGS -gt 0 ]; then
        echo "  ${YELLOW}Maintenance:${NC}"
        echo "    1. Monitor logs: pm2 logs multi-asset-simulator"
        echo "    2. Rotate logs if large: npm run clean"
        echo "    3. Consider restart if uptime low"
    fi
    
    echo ""
fi

# ============================================
# USEFUL COMMANDS
# ============================================
echo "🔧 Useful Commands:"
echo "---------------------------------------"
echo "  pm2 logs multi-asset-simulator       - View live logs"
echo "  pm2 monit                            - Real-time monitoring"
echo "  pm2 restart multi-asset-simulator    - Restart process"
echo "  pm2 flush                            - Clear PM2 logs"
echo "  tail -f simulator.log                - Follow application log"
echo "  ./monitor.sh                         - Start monitoring script"
echo ""

exit $FAILED