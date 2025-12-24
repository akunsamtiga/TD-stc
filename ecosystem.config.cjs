// ============================================
// PM2 ECOSYSTEM CONFIGURATION
// For IDX_STC Multi-Timeframe Simulator v2.0
// ============================================

module.exports = {
  apps: [{
    name: 'idx-stc-simulator',
    script: './index.js',
    
    // Instance configuration
    instances: 1,
    exec_mode: 'fork',
    
    // Environment variables
    env_production: {
      NODE_ENV: 'production',
      NODE_OPTIONS: '--dns-result-order=ipv4first',
      LOG_LEVEL: 'info'
    },
    env_development: {
      NODE_ENV: 'development',
      NODE_OPTIONS: '--dns-result-order=ipv4first',
      LOG_LEVEL: 'debug'
    },
    
    // Restart configuration
    autorestart: true,
    watch: false, // Set true for development
    max_restarts: 10,
    min_uptime: '30s',
    restart_delay: 5000,
    
    // Memory management
    max_memory_restart: '200M',
    
    // Logging
    error_file: './logs/error.log',
    out_file: './logs/out.log',
    log_date_format: 'YYYY-MM-DD HH:mm:ss',
    merge_logs: true,
    
    // Graceful shutdown
    kill_timeout: 5000,
    wait_ready: true,
    listen_timeout: 10000,
    
    // Error handling
    exp_backoff_restart_delay: 100,
    
    // Cron restart (optional - restart daily at 3 AM)
    // cron_restart: '0 3 * * *',
    
    // Process management
    vizion: false,
    
    // Monitoring
    instance_var: 'INSTANCE_ID',
    
    // Post-update hooks
    post_update: ['npm install'],
    
    // Time configuration
    time: true,
    
    // Watch options (if watch: true)
    watch_options: {
      followSymlinks: false,
      usePolling: false,
      interval: 1000
    },
    
    // Ignore watch
    ignore_watch: [
      'node_modules',
      'logs',
      '*.log',
      '.git'
    ]
  }]
};