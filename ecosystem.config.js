module.exports = {
  apps: [
    {
      name: 'al-qaed-platform',
      script: 'npx',
      args: 'serve -s dist -l 8080',
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: '1G',
      env: {
        NODE_ENV: 'production',
        PORT: 8080
      }
    }
  ]
};
