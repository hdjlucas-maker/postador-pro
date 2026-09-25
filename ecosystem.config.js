// Config do PM2. O app é executado dentro de um display virtual (Xvfb :99),
// necessário porque o puppeteer do executor abre o Chromium em modo headful.
module.exports = {
  apps: [
    {
      name: 'postador-pro',
      script: 'server.js',
      instances: 1,
      max_memory_restart: '500M',
      env: {
        NODE_ENV: 'production',
        DISPLAY: ':99'
      }
    }
  ]
};