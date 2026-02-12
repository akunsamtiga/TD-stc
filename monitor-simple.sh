#!/bin/bash
###############################################################################
# SIMPLE AUTO RESTART MONITOR - Trading Simulator
# Version: 1.0.0 (Super Simple Edition)
# 
# Cara pakai:
# 1. Edit KONFIGURASI di bawah sesuai dengan setup Anda
# 2. chmod +x monitor-simple.sh
# 3. ./monitor-simple.sh
# 
# Atau jalankan dengan PM2:
# pm2 start ./monitor-simple.sh --name monitor
###############################################################################

# ============================================================================
# KONFIGURASI - Edit sesuai dengan setup Anda
# ============================================================================

# Nama app di PM2 (lihat dengan: pm2 list)
BACKEND_NAME="binary-backend"
SIMULATOR_NAME="multi-asset-simulator"

# Threshold: Restart kalau tidak ada write selama X detik
NO_WRITE_THRESHOLD=120

# Check setiap X detik
CHECK_INTERVAL=30

# Cooldown: Jeda antar restart (detik)
RESTART_COOLDOWN=120

# ============================================================================
# JANGAN EDIT DI BAWAH INI (kecuali tahu apa yang dilakukan)
# ============================================================================

# Warna
R='\033[0;31m'
G='\033[0;32m'
Y='\033[1;33m'
B='\033[0;34m'
N='\033[0m'

# State
LAST_RESTART=0
WARN_COUNT=0

# Fungsi log
info() { echo -e "${B}[$(date +%H:%M:%S)]${N} $1"; }
warn() { echo -e "${Y}[$(date +%H:%M:%S)] WARNING:${N} $1"; }
err()  { echo -e "${R}[$(date +%H:%M:%S)] ERROR:${N} $1"; }
ok()   { echo -e "${G}[$(date +%H:%M:%S)]${N} $1"; }

# Header
clear
echo "=============================================="
echo "  🤖 Auto Restart Monitor (Simple Mode)"
echo "=============================================="
echo ""
info "Config:"
echo "  Backend:  $BACKEND_NAME"
echo "  Simulator: $SIMULATOR_NAME"
echo "  Threshold: ${NO_WRITE_THRESHOLD}s"
echo "  Interval:  ${CHECK_INTERVAL}s"
echo ""
echo "=============================================="
echo "  Press Ctrl+C to stop"
echo "=============================================="
echo ""

# Cek PM2
if ! command -v pm2 &> /dev/null; then
    err "PM2 tidak ditemukan! Install dulu: npm i -g pm2"
    exit 1
fi

# Fungsi restart
restart_all() {
    local reason="$1"
    local now=$(date +%s)
    local since_last=$((now - LAST_RESTART))
    
    # Cek cooldown
    if [ $since_last -lt $RESTART_COOLDOWN ]; then
        warn "Cooldown aktif. Tunggu $((RESTART_COOLDOWN - since_last))s lagi..."
        return
    fi
    
    LAST_RESTART=$now
    WARN_COUNT=0
    
    echo ""
    warn "🔄 RESTART DIMULAI!"
    warn "   Alasan: $reason"
    echo ""
    
    # 1. Stop simulator
    info "⏹️  Stop simulator..."
    pm2 stop "$SIMULATOR_NAME" 2>/dev/null || true
    sleep 2
    
    # 2. Stop backend
    info "⏹️  Stop backend..."
    pm2 stop "$BACKEND_NAME" 2>/dev/null || true
    sleep 3
    
    # 3. Start backend
    info "▶️  Start backend..."
    pm2 start "$BACKEND_NAME" 2>/dev/null || pm2 restart "$BACKEND_NAME"
    sleep 5
    
    # 4. Start simulator
    info "▶️  Start simulator..."
    pm2 start "$SIMULATOR_NAME" 2>/dev/null || pm2 restart "$SIMULATOR_NAME"
    
    echo ""
    ok "✅ Restart selesai!"
    echo ""
}

# Fungsi cek log
check_logs() {
    # Ambil log simulator (100 baris terakhir)
    local logs=$(pm2 logs "$SIMULATOR_NAME" --lines 100 --nostream 2>/dev/null)
    
    # Cek "No successful writes"
    local no_write=$(echo "$logs" | grep -oP 'No successful writes in \K\d+' | tail -1)
    
    # Cek "PRICE STUCK"
    local stuck_count=$(echo "$logs" | grep -c 'PRICE STUCK DETECTED')
    
    # Cek apakah process running
    local backend_status=$(pm2 describe "$BACKEND_NAME" 2>/dev/null | grep "status" | awk '{print $4}')
    local sim_status=$(pm2 describe "$SIMULATOR_NAME" 2>/dev/null | grep "status" | awk '{print $4}')
    
    # Jika process mati, restart
    if [ "$backend_status" != "online" ] || [ "$sim_status" != "online" ]; then
        warn "Process tidak running! (Backend: $backend_status, Sim: $sim_status)"
        restart_all "Process offline"
        return
    fi
    
    # Jika no write terlalu lama
    if [ -n "$no_write" ] && [ "$no_write" -gt "$NO_WRITE_THRESHOLD" ]; then
        WARN_COUNT=$((WARN_COUNT + 1))
        warn "⚠️  Tidak ada write selama ${no_write}s (warning #$WARN_COUNT)"
        
        # Restart setelah 2x warning
        if [ $WARN_COUNT -ge 2 ]; then
            restart_all "Tidak ada write selama ${no_write} detik"
        fi
    else
        # Reset counter jika sudah normal
        if [ $WARN_COUNT -gt 0 ]; then
            ok "✅ Write normal kembali. Reset counter."
            WARN_COUNT=0
        fi
    fi
    
    # Log status setiap beberapa check
    local mod=$((CHECK_INTERVAL * 2))
    if [ $(($(date +%s) % mod)) -lt $CHECK_INTERVAL ]; then
        info "Status OK - Backend: $backend_status, Sim: $sim_status"
    fi
}

# Trap Ctrl+C
trap 'echo ""; info "Monitor dihentikan."; exit 0' INT TERM

# Loop utama
while true; do
    check_logs
    sleep $CHECK_INTERVAL
done