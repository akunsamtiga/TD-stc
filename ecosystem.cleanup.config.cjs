/**
 * PM2 Ecosystem Configuration for Realtime DB Cleanup
 * 
 * Usage:
 * pm2 start ecosystem.cleanup.config.js
 * pm2 logs db-cleanup --lines 100
 * pm2 stop db-cleanup
 */

module.exports = {
  apps: [{
    name: 'db-cleanup',
    script: './cleanup-all-auto.js',
    
    // Execution mode
    instances: 1,
    exec_mode: 'fork',
    
    // Auto restart settings - DISABLED for cleanup task
    autorestart: false,
    watch: false,
    
    // Max memory before restart (increase for large datasets)
    max_memory_restart: '2G',
    
    // Environment variables
    env: {
      NODE_ENV: 'production',
      TZ: 'Asia/Jakarta',
    },
    
    // Logging
    error_file: './logs/cleanup-error.log',
    out_file: './logs/cleanup-out.log',
    log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
    merge_logs: true,
    
    // Time before killing the process (15 minutes)
    kill_timeout: 900000,
    
    // Restart settings
    wait_ready: false,
    listen_timeout: 10000,
    
    // Advanced settings
    max_restarts: 0, // No restart for cleanup task
    min_uptime: 1000,
    
    // Post-exec hook (optional)
    // post_update: ['echo "Cleanup completed"'],
  }],
};