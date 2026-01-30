module.exports = {
  apps: [{
    name: 'db-cleanup',
    script: './cleanup-all-auto.js',
    node_args: '--max-old-space-size=8192',
    instances: 1,
    exec_mode: 'fork',
    autorestart: false,
    watch: false,
    log_file: './logs/cleanup-combined.log',
    out_file: './logs/cleanup-out.log',
    error_file: './logs/cleanup-error.log',
    log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
    merge_logs: true,
    env: {
      NODE_ENV: 'production',
      TZ: 'Asia/Jakarta'
    },
    max_memory_restart: '8G',
    kill_timeout: 300000,
    wait_ready: false
  }]
};