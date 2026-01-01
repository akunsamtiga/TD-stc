module.exports = {
  apps: [{
    name: 'multi-asset-simulator',
    script: './index.js',
        node_args: '--expose-gc', 
    instances: 1,
    exec_mode: 'fork',
    
    env_production: {
      NODE_ENV: 'production',
      NODE_OPTIONS: '--dns-result-order=ipv4first',
      LOG_LEVEL: 'info',
      TZ: 'Asia/Jakarta',
    },
    env_development: {
      NODE_ENV: 'development',
      NODE_OPTIONS: '--dns-result-order=ipv4first',
      LOG_LEVEL: 'debug',
      TZ: 'Asia/Jakarta',
    },
    
    autorestart: true,
    watch: false,
    max_restarts: 10,
    min_uptime: '30s',
    restart_delay: 5000,
    
    max_memory_restart: '300M',
    
    error_file: './logs/error.log',
    out_file: './logs/out.log',
    log_date_format: 'YYYY-MM-DD HH:mm:ss',
    merge_logs: true,
    
    kill_timeout: 5000,
    wait_ready: true,
    listen_timeout: 10000,
    
    exp_backoff_restart_delay: 100,
    
    vizion: false,
    instance_var: 'INSTANCE_ID',
    time: true,
    
    watch_options: {
      followSymlinks: false,
      usePolling: false,
      interval: 1000
    },
    
    ignore_watch: [
      'node_modules',
      'logs',
      '*.log',
      '.git'
    ]
  }]
};
