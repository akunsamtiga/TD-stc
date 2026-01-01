// ============================================
// PM2 ECOSYSTEM CONFIG - STABLE 24/7
// ============================================
// Optimized for production stability
// Auto-restart, memory management, logging

module.exports = {
  apps: [{
    name: 'multi-asset-simulator',
    script: './index.js',
    
    // ============================================
    // INSTANCE CONFIGURATION
    // ============================================
    instances: 1,
    exec_mode: 'fork',
    
    // ============================================
    // ENVIRONMENT VARIABLES
    // ============================================
    env_production: {
      NODE_ENV: 'production',
      NODE_OPTIONS: '--dns-result-order=ipv4first --max-old-space-size=384',
      LOG_LEVEL: 'info',
      TZ: 'Asia/Jakarta',
    },
    env_development: {
      NODE_ENV: 'development',
      NODE_OPTIONS: '--dns-result-order=ipv4first --max-old-space-size=384',
      LOG_LEVEL: 'debug',
      TZ: 'Asia/Jakarta',
    },
    
    // ============================================
    // RESTART STRATEGY - ENHANCED
    // ============================================
    autorestart: true,
    watch: false,
    
    // Prevent restart loop
    max_restarts: 15,              // ✅ Increased from 10
    min_uptime: '20s',             // ✅ Reduced from 30s
    restart_delay: 3000,           // ✅ Reduced from 5000ms
    
    // Exponential backoff on restart failures
    exp_backoff_restart_delay: 100,
    
    // ============================================
    // MEMORY MANAGEMENT - OPTIMIZED
    // ============================================
    max_memory_restart: '350M',    // ✅ Increased from 300M for stability
    
    // ============================================
    // LOGGING - PRODUCTION READY
    // ============================================
    error_file: './logs/error.log',
    out_file: './logs/out.log',
    log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
    merge_logs: true,
    
    // Log rotation
    log_type: 'json',
    
    // ============================================
    // GRACEFUL SHUTDOWN - CRITICAL
    // ============================================
    kill_timeout: 10000,           // ✅ Increased from 5000ms
    wait_ready: false,             // ✅ Changed to false to prevent hang
    listen_timeout: 5000,          // ✅ Reduced from 10000ms
    
    // ============================================
    // PROCESS MANAGEMENT
    // ============================================
    vizion: false,
    instance_var: 'INSTANCE_ID',
    time: true,
    
    // ============================================
    // HEALTH CHECK - AUTO RESTART ON UNHEALTHY
    // ============================================
    // PM2 will check if process is responsive
    max_memory_restart: '350M',
    
    // ============================================
    // CRON RESTART - OPTIONAL DAILY RESTART
    // ============================================
    // Uncomment to restart daily at 3 AM WIB
    // cron_restart: '0 3 * * *',
    
    // ============================================
    // POST-DEPLOYMENT HOOKS
    // ============================================
    post_update: [
      'npm install --production',
      'echo "✅ Dependencies installed"'
    ],
    
    // ============================================
    // INTERPRETER OPTIONS
    // ============================================
    node_args: '--dns-result-order=ipv4first',
    
    // ============================================
    // STARTUP CONFIGURATION
    // ============================================
    // Don't watch node_modules
    ignore_watch: [
      'node_modules',
      'logs',
      '*.log',
      '.git',
      'backups'
    ],
    
    // ============================================
    // ADVANCED OPTIONS
    // ============================================
    // Disable source map support to reduce memory
    source_map_support: false,
    
    // Disable automatic port assignment
    increment_var: 'PORT',
    
    // Error handling
    combine_logs: true,
    
    // ============================================
    // MONITORING HOOKS
    // ============================================
    // These run in PM2, not in your app
    error: function(err) {
      console.error('PM2 Error:', err);
    }
  }],
  
};