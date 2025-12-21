module.exports = {
  apps: [{
    name: 'idx-stc-simulator',
    script: './index.js',
    instances: 1,
    exec_mode: 'fork',
    
    // Restart configuration
    autorestart: true,
    watch: false,
    max_restarts: 10,
    min_uptime: '30s',
    restart_delay: 5000,
    
    // Memory management
    max_memory_restart: '150M',
    
    // Logging
    error_file: './logs/error.log',
    out_file: './logs/out.log',
    log_date_format: 'YYYY-MM-DD HH:mm:ss',
    merge_logs: true,
    
    // Environment
    env: {
      NODE_ENV: 'production',
      NODE_OPTIONS: '--dns-result-order=ipv4first'
    },
    
    // Graceful shutdown
    kill_timeout: 5000,
    wait_ready: true,
    listen_timeout: 10000,
    
    // Monitoring
    instance_var: 'INSTANCE_ID',
    
    // Cron restart (optional - restart daily at 3 AM)
    cron_restart: '0 3 * * *',
    
    // Error handling
    exp_backoff_restart_delay: 100,
    
    // Process management
    vizion: false,
    post_update: ['npm install']
  }]
};