#!/bin/bash
###############################################################################
# SIMPLE AUTO RESTART MONITOR - Trading Simulator
# Version: 2.0.0 (Restart hanya saat PRICE STUCK DETECTED)
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

# Berapa kali PRICE STUCK DETECTED harus muncul di log terbaru
# sebelum restart dilakukan (default: 3 kali dalam 50 baris terakhir)
STUCK_THRESHOLD=3

# Berapa baris log terakhir yang dicek
LOG_LINES=50

# Check setiap X detik
CHECK_INTERVAL=30

# Cooldown: Jeda minimum antar restart (detik)
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

# Fungsi log
info() { echo -e "${B}[$(date +%H:%M:%S)]${N} $1"; }
warn() { echo -e "${Y}[$(date +%H:%M:%S)] WARNING:${N} $1"; }
err()  { echo -e "${R}[$(date +%H:%M:%S)] ERROR:${N} $1"; }
ok()   { echo -e "${G}[$(date +%H:%M:%S)]${N} $1"; }

# Header
clear
echo "=============================================="
echo "  Auto Restart Monitor"
echo "  Trigger: PRICE STUCK DETECTED only"
echo "=============================================="
echo ""
info "Config:"
echo "  Backend  : $BACKEND_NAME"
echo "  Simulator: $SIMULATOR_NAME"
echo "  Stuck threshold : ${STUCK_THRESHOLD}x dalam ${LOG_LINES} baris log terakhir"
echo "  Check interval  : ${CHECK_INTERVAL}s"
echo "  Restart cooldown: ${RESTART_COOLDOWN}s"
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
        warn "Cooldown aktif. Tunggu $((RESTART_COOLDOWN - since_last))s lagi sebelum restart berikutnya..."
        return
    fi

    LAST_RESTART=$now

    echo ""
    warn "========================================"
    warn "  RESTART DIMULAI"
    warn "  Alasan: $reason"
    warn "========================================"
    echo ""

    # 1. Stop simulator
    info "Stop simulator..."
    pm2 stop "$SIMULATOR_NAME" 2>/dev/null || true
    sleep 2

    # 2. Stop backend
    info "Stop backend..."
    pm2 stop "$BACKEND_NAME" 2>/dev/null || true
    sleep 3

    # 3. Start backend
    info "Start backend..."
    pm2 start "$BACKEND_NAME" 2>/dev/null || pm2 restart "$BACKEND_NAME"
    sleep 5

    # 4. Start simulator
    info "Start simulator..."
    pm2 start "$SIMULATOR_NAME" 2>/dev/null || pm2 restart "$SIMULATOR_NAME"

    echo ""
    ok "Restart selesai! Akan mulai monitor lagi setelah cooldown ${RESTART_COOLDOWN}s..."
    echo ""
}

# Fungsi cek log — HANYA trigger restart jika PRICE STUCK DETECTED
check_logs() {
    # Ambil N baris log terbaru dari simulator
    local logs
    logs=$(pm2 logs "$SIMULATOR_NAME" --lines "$LOG_LINES" --nostream 2>/dev/null)

    # Hitung berapa kali PRICE STUCK DETECTED muncul
    local stuck_count
    stuck_count=$(echo "$logs" | grep -c 'PRICE STUCK DETECTED')

    if [ "$stuck_count" -ge "$STUCK_THRESHOLD" ]; then
        warn "PRICE STUCK DETECTED ditemukan ${stuck_count}x dalam ${LOG_LINES} baris log terakhir!"
        restart_all "PRICE STUCK DETECTED ${stuck_count}x"
    else
        # Tampilkan status OK setiap beberapa siklus
        if [ $(( $(date +%s) % (CHECK_INTERVAL * 4) )) -lt $CHECK_INTERVAL ]; then
            ok "Status OK - Stuck count: ${stuck_count}/${STUCK_THRESHOLD} (belum trigger restart)"
        fi
    fi
}

# Trap Ctrl+C
trap 'echo ""; info "Monitor dihentikan."; exit 0' INT TERM

# Loop utama
while true; do
    check_logs
    sleep $CHECK_INTERVAL
done