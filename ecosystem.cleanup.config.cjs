/**
 * PM2 Ecosystem Configuration for Realtime DB Cleanup
 * UPDATED: Added memory optimization
 * 
 * Usage:
 * pm2 start ecosystem.cleanup.config.cjs
 * pm2 logs db-cleanup --lines 100
 * pm2 stop db-cleanup
 */

module.exports = {
  apps: [{
    name: 'db-cleanup',
    script: './cleanup-all-auto.js',
    
    // ADDED: Node.js arguments for memory optimization
    node_args: '--max-old-space-size=4096',
    
    // Execution mode
    instances: 1,
    exec_mode: 'fork',
    
    // Auto restart settings - DISABLED for cleanup task
    autorestart: false,
    watch: false,
    
    // Max memory before restart (increased for large datasets)
    max_memory_restart: '4G',
    
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
    
    // Time before killing the process (30 minutes for large DB)
    kill_timeout: 1800000,
    
    // Restart settings
    wait_ready: false,
    listen_timeout: 10000,
    
    // Advanced settings
    max_restarts: 0,
    min_uptime: 1000,
  }],
};