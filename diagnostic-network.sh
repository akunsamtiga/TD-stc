#!/bin/bash

# ============================================
# NETWORK DIAGNOSTIC SCRIPT FOR VPS
# ============================================
# Checks connectivity to Firebase services
# ============================================

echo "🔍 Network Diagnostic for Firebase Connection"
echo "=============================================="
echo ""

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

print_result() {
    if [ $1 -eq 0 ]; then
        echo -e "${GREEN}✅ PASS${NC}"
    else
        echo -e "${RED}❌ FAIL${NC}"
    fi
}

FIREBASE_URL="https://stc-autotrade-18f67-default-rtdb.asia-southeast1.firebasedatabase.app"
FIREBASE_DOMAIN="stc-autotrade-18f67-default-rtdb.asia-southeast1.firebasedatabase.app"

echo "Target: $FIREBASE_URL"
echo ""

# 1. DNS Resolution
echo -n "1. DNS Resolution: "
DNS_RESULT=$(nslookup $FIREBASE_DOMAIN 2>&1)
if [ $? -eq 0 ]; then
    print_result 0
    IP_ADDRESS=$(echo "$DNS_RESULT" | grep -A1 "Name:" | grep "Address:" | awk '{print $2}')
    echo "   Resolved to: $IP_ADDRESS"
else
    print_result 1
    echo "   Could not resolve domain"
fi
echo ""

# 2. Ping Test
echo -n "2. Ping Test (ICMP): "
if ping -c 3 -W 2 $FIREBASE_DOMAIN > /dev/null 2>&1; then
    print_result 0
    PING_TIME=$(ping -c 3 $FIREBASE_DOMAIN | tail -1 | awk '{print $4}' | cut -d '/' -f 2)
    echo "   Average: ${PING_TIME}ms"
else
    print_result 1
    echo "   Ping failed (may be blocked by firewall)"
fi
echo ""

# 3. TCP Connection (Port 443)
echo -n "3. TCP Connection (Port 443): "
timeout 5 bash -c "cat < /dev/null > /dev/tcp/$FIREBASE_DOMAIN/443" 2>/dev/null
if [ $? -eq 0 ]; then
    print_result 0
else
    print_result 1
    echo "   Cannot establish TCP connection"
fi
echo ""

# 4. HTTP/HTTPS Test
echo -n "4. HTTPS GET Test: "
HTTP_RESPONSE=$(curl -s -o /dev/null -w "%{http_code}" --max-time 5 "$FIREBASE_URL/.json")
if [ "$HTTP_RESPONSE" = "200" ] || [ "$HTTP_RESPONSE" = "401" ]; then
    print_result 0
    echo "   HTTP Status: $HTTP_RESPONSE"
else
    print_result 1
    echo "   HTTP Status: $HTTP_RESPONSE"
fi
echo ""

# 5. Firewall Rules Check
echo "5. Checking Firewall Rules:"
if command -v ufw > /dev/null 2>&1; then
    UFW_STATUS=$(sudo ufw status 2>/dev/null | head -1)
    echo "   UFW: $UFW_STATUS"
    
    if [[ $UFW_STATUS == *"active"* ]]; then
        echo -e "${YELLOW}   ⚠️  UFW is active. Ensure HTTPS (443) outbound is allowed.${NC}"
    fi
else
    echo "   UFW: Not installed"
fi

if command -v iptables > /dev/null 2>&1; then
    IPTABLES_RULES=$(sudo iptables -L OUTPUT -n 2>/dev/null | grep -c ACCEPT)
    echo "   iptables OUTPUT rules: $IPTABLES_RULES"
fi
echo ""

# 6. DNS Server Check
echo "6. DNS Configuration:"
cat /etc/resolv.conf | grep nameserver | while read -r line; do
    echo "   $line"
done
echo ""

# 7. Network Speed Test (to Firebase)
echo -n "7. Download Speed Test: "
START_TIME=$(date +%s.%N)
curl -s "$FIREBASE_URL/.json" > /dev/null
END_TIME=$(date +%s.%N)
DURATION=$(echo "$END_TIME - $START_TIME" | bc)
echo "${DURATION}s"
echo ""

# 8. MTU Check
echo "8. Network MTU:"
ip link show | grep mtu | head -1
echo ""

# 9. Route to Firebase
echo "9. Route Trace (first 5 hops):"
traceroute -m 5 -w 2 $FIREBASE_DOMAIN 2>/dev/null || echo "   traceroute not available"
echo ""

# 10. Active Connections
echo "10. Current Firebase Connections:"
CONNECTIONS=$(netstat -an 2>/dev/null | grep -i firebasedatabase | wc -l)
echo "    Active: $CONNECTIONS"
echo ""

# Summary
echo "=============================================="
echo "📊 SUMMARY"
echo "=============================================="

SUCCESS=0
FAILED=0

# Count results
DNS_RESULT=$(nslookup $FIREBASE_DOMAIN 2>&1)
[ $? -eq 0 ] && SUCCESS=$((SUCCESS+1)) || FAILED=$((FAILED+1))

ping -c 1 -W 2 $FIREBASE_DOMAIN > /dev/null 2>&1
[ $? -eq 0 ] && SUCCESS=$((SUCCESS+1)) || FAILED=$((FAILED+1))

timeout 5 bash -c "cat < /dev/null > /dev/tcp/$FIREBASE_DOMAIN/443" 2>/dev/null
[ $? -eq 0 ] && SUCCESS=$((SUCCESS+1)) || FAILED=$((FAILED+1))

HTTP_RESPONSE=$(curl -s -o /dev/null -w "%{http_code}" --max-time 5 "$FIREBASE_URL/.json")
[ "$HTTP_RESPONSE" = "200" ] || [ "$HTTP_RESPONSE" = "401" ]
[ $? -eq 0 ] && SUCCESS=$((SUCCESS+1)) || FAILED=$((FAILED+1))

echo "Tests Passed: $SUCCESS"
echo "Tests Failed: $FAILED"
echo ""

if [ $FAILED -eq 0 ]; then
    echo -e "${GREEN}✅ All network checks passed!${NC}"
    echo -e "${GREEN}   Firebase connection should work.${NC}"
elif [ $FAILED -lt 3 ]; then
    echo -e "${YELLOW}⚠️  Some checks failed but connection may still work.${NC}"
    echo -e "${YELLOW}   Try running the simulator to verify.${NC}"
else
    echo -e "${RED}❌ Multiple checks failed!${NC}"
    echo -e "${RED}   Network connectivity issues detected.${NC}"
    echo ""
    echo "Possible solutions:"
    echo "1. Check VPS firewall: sudo ufw status"
    echo "2. Add DNS servers: echo 'nameserver 8.8.8.8' | sudo tee -a /etc/resolv.conf"
    echo "3. Contact VPS provider about outbound HTTPS (443) access"
    echo "4. Try from different network/VPS"
fi
echo ""

# Save results
REPORT_FILE="network-diagnostic-$(date +%Y%m%d_%H%M%S).txt"
{
    echo "Network Diagnostic Report"
    echo "========================="
    echo "Date: $(date)"
    echo "Target: $FIREBASE_URL"
    echo ""
    echo "Results:"
    echo "  Success: $SUCCESS"
    echo "  Failed: $FAILED"
    echo ""
    echo "DNS: $DNS_RESULT"
} > "$REPORT_FILE"

echo "📝 Report saved to: $REPORT_FILE"
echo ""