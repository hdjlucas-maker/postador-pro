// Config do PM2. O app roda dentro de um display virtual (Xvfb :99), porque o
// puppeteer do executor abre o Chromium em modo headful.
//
// `instances: 1` é obrigatório, e não um detalhe de capacidade: a fila de
// publicação e a reserva de cobrança idempotente vivem na memória do processo.
// Com duas instâncias, duas requisições de checkout simultâneas poderiam
// liberar a mesma compra duas vezes, e a fila tentaria publicar a mesma
// campanha em paralelo. Para escalar, o app precisaria antes de um banco
// compartilhado e de um bloqueio distribuído.
module.exports = {
  apps: [
    {
      name: 'postador-pro',
      script: 'server.js',
      instances: 1,
      exec_mode: 'fork',
      max_memory_restart: '2G',

      // O SIGTERM espera a fila terminar a publicação em andamento e fechar os
      // navegadores. Sem folga, o PM2 mata o processo no meio de um post e o
      // Chromium fica órfão segurando memória e o perfil do Facebook.
      kill_timeout: 60000,
      restart_delay: 5000,
      exp_backoff_restart_delay: 2000,

      // O .env é carregado pelo próprio app (dotenv) no boot.
      env: {
        NODE_ENV: 'production',
        DISPLAY: ':99'
      },

      // PM2 mantém o .env fora do dump; as senhas não ficam no repositório.
      out_file: 'logs/pm2-out.log',
      error_file: 'logs/pm2-error.log',
      merge_logs: true,
      time: true
    }
  ]
};
