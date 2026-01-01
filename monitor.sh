#!/bin/bash

# ============================================
# REAL-TIME SIMULATOR MONITOR
# ============================================
# Live monitoring dashboard for 24/7 operation

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
MAGENTA='\033[0;35m'
CYAN='\033[0;36m'
BOLD='\033[1m'
NC='\033[0m'

# Configuration
REFRESH_INTERVAL=2
LOG_FILE="simulator.log"
PM2_APP_NAME="multi-asset-simulator"

# Functions
clear_screen() {
    clear
    printf '\033[2J\033[H'
}

get_timestamp() {
    date '+%Y-%m-%d %H:%M:%S'
}

format_uptime() {
    local seconds=$1
    local days=$((seconds / 86400))
    local hours=$(((seconds % 86400) / 3600))
    local minutes=$(((seconds % 3600) / 60))
    
    if [ $days -gt 0 ]; then
        echo "${days}d ${hours}h ${minutes}m"
    elif [ $hours -gt 0 ]; then
        echo "${hours}h ${minutes}m"
    else
        echo "${minutes}m"
    fi
}

# ============================================
# MAIN MONITOR LOOP
# ============================================
monitor_loop() {
    while true; do
        clear_screen
        
        # ============================================
        # HEADER
        # ============================================
        echo -e "${BOLD}${CYAN}╔══════════════════════════════════════════════════════════════╗${NC}"
        echo -e "${BOLD}${CYAN}║     📊 MULTI-ASSET SIMULATOR - REAL-TIME MONITOR v8.0     ║${NC}"
        echo -e "${BOLD}${CYAN}╚══════════════════════════════════════════════════════════════╝${NC}"
        echo ""
        echo -e "${BLUE}📅 $(get_timestamp) WIB${NC}"
        echo ""
        
        # ============================================
        # PM2 STATUS
        # ============================================
        echo -e "${BOLD}${GREEN}━━━ PM2 Process Status ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
        
        if pm2 list | grep -q "$PM2_APP_NAME.*online"; then
            echo -e "  Status: ${GREEN}●${NC} ${BOLD}ONLINE${NC}"
            
            # Get process info from PM2
            local pm2_json=$(pm2 jlist 2>/dev/null | jq -r ".[] | select(.name==\"$PM2_APP_NAME\")" 2>/dev/null)
            
            if [ ! -z "$pm2_json" ]; then
                local uptime=$(echo "$pm2_json" | jq -r '.pm2_env.pm_uptime' 2>/dev/null)
                local restart_count=$(echo "$pm2_json" | jq -r '.pm2_env.restart_time' 2>/dev/null)
                local memory=$(echo "$pm2_json" | jq -r '.monit.memory' 2>/dev/null)
                local cpu=$(echo "$pm2_json" | jq -r '.monit.cpu' 2>/dev/null)
                
                # Calculate uptime
                if [ ! -z "$uptime" ] && [ "$uptime" != "null" ]; then
                    local current_time=$(date +%s)
                    local uptime_seconds=$((current_time - uptime / 1000))
                    local uptime_formatted=$(format_uptime $uptime_seconds)
                    echo -e "  Uptime: ${CYAN}$uptime_formatted${NC}"
                fi
                
                # Restart count
                if [ ! -z "$restart_count" ] && [ "$restart_count" != "null" ]; then
                    if [ $restart_count -lt 5 ]; then
                        echo -e "  Restarts: ${GREEN}$restart_count${NC}"
                    elif [ $restart_count -lt 15 ]; then
                        echo -e "  Restarts: ${YELLOW}$restart_count${NC} ⚠️"
                    else
                        echo -e "  Restarts: ${RED}$restart_count${NC} ❌"
                    fi
                fi
                
                # Memory
                if [ ! -z "$memory" ] && [ "$memory" != "null" ]; then
                    local memory_mb=$((memory / 1024 / 1024))
                    if [ $memory_mb -lt 200 ]; then
                        echo -e "  Memory: ${GREEN}${memory_mb}MB${NC}"
                    elif [ $memory_mb -lt 300 ]; then
                        echo -e "  Memory: ${YELLOW}${memory_mb}MB${NC}"
                    else
                        echo -e "  Memory: ${RED}${memory_mb}MB${NC} ⚠️"
                    fi
                fi
                
                # CPU
                if [ ! -z "$cpu" ] && [ "$cpu" != "null" ]; then
                    if (( $(echo "$cpu < 30" | bc -l 2>/dev/null || echo "0") )); then
                        echo -e "  CPU: ${GREEN}${cpu}%${NC}"
                    elif (( $(echo "$cpu < 60" | bc -l 2>/dev/null || echo "0") )); then
                        echo -e "  CPU: ${YELLOW}${cpu}%${NC}"
                    else
                        echo -e "  CPU: ${RED}${cpu}%${NC} ⚠️"
                    fi
                fi
            fi
        else
            echo -e "  Status: ${RED}●${NC} ${BOLD}OFFLINE${NC}"
            echo -e "  ${YELLOW}Process not running!${NC}"
            echo -e "  ${YELLOW}Start with: pm2 start ecosystem.config.cjs${NC}"
        fi
        echo ""
        
        # ============================================
        # LOGS & ACTIVITY
        # ============================================
        echo -e "${BOLD}${GREEN}━━━ Recent Activity (Last 15 lines) ━━━━━━━━━━━━━━━━━━━━${NC}"
        
        if [ -f "$LOG_FILE" ]; then
            # Extract relevant log lines
            tail -15 "$LOG_FILE" 2>/dev/null | while IFS= read -r line; do
                # Color code based on content
                if echo "$line" | grep -q "ERROR\|error\|Error"; then
                    echo -e "  ${RED}$line${NC}"
                elif echo "$line" | grep -q "WARN\|warn\|Warning"; then
                    echo -e "  ${YELLOW}$line${NC}"
                elif echo "$line" | grep -q "INFO\|info\|OHLC\|Asset"; then
                    echo -e "  ${GREEN}$line${NC}"
                elif echo "$line" | grep -q "DEBUG\|debug"; then
                    echo -e "  ${BLUE}$line${NC}"
                else
                    echo "  $line"
                fi
            done
        else
            echo -e "  ${YELLOW}No log file found${NC}"
        fi
        echo ""
        
        # ============================================
        # STATISTICS
        # ============================================
        echo -e "${BOLD}${GREEN}━━━ Statistics ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
        
        if [ -f "$LOG_FILE" ]; then
            # Count errors in recent logs
            local error_count=$(tail -100 "$LOG_FILE" 2>/dev/null | grep -i "error" | wc -l)
            local warning_count=$(tail -100 "$LOG_FILE" 2>/dev/null | grep -i "warn" | wc -l)
            
            echo -e "  Recent Errors: ${RED}$error_count${NC}"
            echo -e "  Recent Warnings: ${YELLOW}$warning_count${NC}"
            
            # Check for specific patterns
            if tail -50 "$LOG_FILE" 2>/dev/null | grep -q "Firebase.*connected"; then
                echo -e "  Firebase: ${GREEN}✓ Connected${NC}"
            else
                echo -e "  Firebase: ${YELLOW}? Unknown${NC}"
            fi
            
            # Log file size
            if [ -f "$LOG_FILE" ]; then
                local log_size=$(du -h "$LOG_FILE" 2>/dev/null | cut -f1)
                echo -e "  Log Size: ${CYAN}$log_size${NC}"
            fi
        fi
        echo ""
        
        # ============================================
        # SYSTEM RESOURCES
        # ============================================
        echo -e "${BOLD}${GREEN}━━━ System Resources ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
        
        # Disk space
        local disk_usage=$(df -h . | awk 'NR==2 {print $5}' | sed 's/%//')
        local disk_avail=$(df -h . | awk 'NR==2 {print $4}')
        
        if [ "$disk_usage" -lt 70 ]; then
            echo -e "  Disk: ${GREEN}${disk_usage}%${NC} used (${disk_avail} free)"
        elif [ "$disk_usage" -lt 85 ]; then
            echo -e "  Disk: ${YELLOW}${disk_usage}%${NC} used (${disk_avail} free) ⚠️"
        else
            echo -e "  Disk: ${RED}${disk_usage}%${NC} used (${disk_avail} free) ❌"
        fi
        
        # System load
        if command -v uptime &> /dev/null; then
            local load_avg=$(uptime | awk -F'load average:' '{print $2}' | xargs)
            echo -e "  Load Avg: ${CYAN}$load_avg${NC}"
        fi
        echo ""
        
        # ============================================
        # FOOTER
        # ============================================
        echo -e "${BOLD}${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
        echo -e "${BLUE}🔄 Refreshing every ${REFRESH_INTERVAL}s | Press Ctrl+C to exit${NC}"
        echo ""
        
        # Quick commands hint
        echo -e "${MAGENTA}Quick Commands:${NC}"
        echo -e "  ${CYAN}pm2 logs $PM2_APP_NAME${NC}    - View full logs"
        echo -e "  ${CYAN}./health-check.sh${NC}         - Run health check"
        echo -e "  ${CYAN}pm2 restart $PM2_APP_NAME${NC} - Restart simulator"
        
        # Sleep before next iteration
        sleep $REFRESH_INTERVAL
    done
}

# ============================================
# STARTUP
# ============================================
echo "🚀 Starting Real-Time Monitor..."
echo ""
echo "Checking dependencies..."

# Check if PM2 is installed
if ! command -v pm2 &> /dev/null; then
    echo -e "${RED}❌ PM2 is not installed${NC}"
    echo "Install with: npm install -g pm2"
    exit 1
fi

# Check if jq is installed (optional but recommended)
if ! command -v jq &> /dev/null; then
    echo -e "${YELLOW}⚠️  jq is not installed (recommended for better formatting)${NC}"
    echo "Install with: sudo apt-get install jq  (Ubuntu/Debian)"
    echo "            or: sudo yum install jq      (CentOS/RHEL)"
    echo ""
    echo "Continuing without jq..."
    sleep 2
fi

# Check if log file exists
if [ ! -f "$LOG_FILE" ]; then
    echo -e "${YELLOW}⚠️  Log file not found: $LOG_FILE${NC}"
    echo "The simulator may not be running yet."
    echo ""
fi

echo -e "${GREEN}✅ Starting monitor...${NC}"
sleep 1

# Trap Ctrl+C for graceful exit
trap 'echo ""; echo "👋 Monitor stopped"; exit 0' INT TERM

# Start monitoring
monitor_loop