#!/bin/bash

# ================================================================
# REALTIME DATABASE CLEANUP RUNNER
# ================================================================
# Script untuk menjalankan cleanup dengan PM2
# ================================================================

# chmod +x run-cleanup.sh && ./run-cleanup.sh

set -e

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
NC='\033[0m' # No Color
BOLD='\033[1m'

# Functions
print_header() {
    echo -e "${CYAN}${BOLD}"
    echo "================================================================"
    echo "$1"
    echo "================================================================"
    echo -e "${NC}"
}

print_info() {
    echo -e "${BLUE}ℹ️  $1${NC}"
}

print_success() {
    echo -e "${GREEN}✅ $1${NC}"
}

print_warning() {
    echo -e "${YELLOW}⚠️  $1${NC}"
}

print_error() {
    echo -e "${RED}❌ $1${NC}"
}

# Check if .env exists
check_env() {
    if [ ! -f .env ]; then
        print_error ".env file not found!"
        print_info "Please create .env file with Firebase credentials"
        exit 1
    fi
    
    print_success ".env file found"
}

# Check if node_modules exists
check_dependencies() {
    if [ ! -d node_modules ]; then
        print_warning "node_modules not found, installing dependencies..."
        npm install
        print_success "Dependencies installed"
    else
        print_success "Dependencies already installed"
    fi
}

# Check if PM2 is installed
check_pm2() {
    if ! command -v pm2 &> /dev/null; then
        print_warning "PM2 not found, installing globally..."
        npm install -g pm2
        print_success "PM2 installed"
    else
        print_success "PM2 is installed"
    fi
}

# Create logs directory
create_logs_dir() {
    if [ ! -d logs ]; then
        mkdir -p logs
        print_success "Logs directory created"
    fi
}

# Stop existing cleanup process
stop_existing() {
    if pm2 describe db-cleanup &> /dev/null; then
        print_warning "Stopping existing cleanup process..."
        pm2 stop db-cleanup
        pm2 delete db-cleanup
        print_success "Existing process stopped"
    fi
}

# Main function
main() {
    print_header "🗑️  REALTIME DATABASE CLEANUP RUNNER"
    
    print_info "Checking prerequisites..."
    check_env
    check_dependencies
    check_pm2
    create_logs_dir
    stop_existing
    
    echo ""
    print_header "⚠️  WARNING: DELETE ALL DATA"
    print_warning "This will DELETE ALL DATA in Firebase Realtime Database"
    print_warning "This action CANNOT be undone!"
    echo ""
    
    read -p "Are you sure you want to continue? Type 'DELETE ALL' to confirm: " confirm
    
    if [ "$confirm" != "DELETE ALL" ]; then
        print_error "Cleanup cancelled"
        exit 1
    fi
    
    echo ""
    print_header "🚀 STARTING CLEANUP PROCESS"
    
    # Start with PM2
    if [ -f ecosystem.cleanup.config.js ]; then
        print_info "Starting with ecosystem config..."
        pm2 start ecosystem.cleanup.config.js
    else
        print_info "Starting directly..."
        pm2 start cleanup-all-auto.js --name db-cleanup --no-autorestart
    fi
    
    print_success "Cleanup process started!"
    echo ""
    
    print_header "📊 MONITORING OPTIONS"
    echo -e "${CYAN}1. View live logs:${NC}"
    echo "   pm2 logs db-cleanup"
    echo ""
    echo -e "${CYAN}2. View last 100 lines:${NC}"
    echo "   pm2 logs db-cleanup --lines 100"
    echo ""
    echo -e "${CYAN}3. Check status:${NC}"
    echo "   pm2 status db-cleanup"
    echo ""
    echo -e "${CYAN}4. Stop cleanup (if needed):${NC}"
    echo "   pm2 stop db-cleanup"
    echo ""
    echo -e "${CYAN}5. View logs file:${NC}"
    echo "   tail -f logs/cleanup-out.log"
    echo ""
    
    print_info "Starting log monitoring in 3 seconds..."
    sleep 3
    
    # Auto-follow logs
    pm2 logs db-cleanup
}

# Run main
main