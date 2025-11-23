module.exports = {
  apps: [{
    name: 'alqaed-api',
    script: './dist/index.js',
    cwd: '/var/www/alqaed-platform/backend',
    instances: 1,
    autorestart: true,
    watch: false,
    max_memory_restart: '1G',
    env: {
      NODE_ENV: 'production',
      PORT: 3001,
      DB_HOST: 'localhost',
      DB_USER: 'root',
      DB_PASSWORD: '123580',
      DB_NAME: 'Freelance',
      DB_PORT: 3306,
      JWT_SECRET: 'your-super-secret-jwt-key-change-this-in-production',
      JWT_EXPIRES_IN: '7d',
      CORS_ORIGIN: 'http://localhost:8081',
      TWILIO_ACCOUNT_SID: 'your_twilio_account_sid_here',
      TWILIO_AUTH_TOKEN: 'your_twilio_auth_token_here',
      TWILIO_WHATSAPP_FROM: 'whatsapp:+14155238886'
    },
    error_file: '/root/.pm2/logs/alqaed-api-error.log',
    out_file: '/root/.pm2/logs/alqaed-api-out.log',
    log_date_format: 'YYYY-MM-DD HH:mm:ss Z'
  }]
};
