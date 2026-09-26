// Config do PM2 para a API de licença. Não há navegador nem display virtual:
// a publicação acontece na máquina do cliente, dentro da extensão.
//
// `instances: 1` continua obrigatório, e por um motivo que não mudou: a
// reserva de cobrança idempotente depende de um processo só. Duas instâncias
// poderiam liberar a mesma compra duas vezes.
module.exports = {
  apps: [
    {
      name: 'postador-pro',
      script: 'server.js',
      instances: 1,
      exec_mode: 'fork',
      max_memory_restart: '512M',

      // O SIGTERM espera as conexões fecharem e o banco compactar. Sem folga,
      // o processo morre no meio de um webhook e o pedido fica sem resposta.
      kill_timeout: 20000,
      restart_delay: 5000,
      exp_backoff_restart_delay: 2000,

      // O .env é carregado pelo próprio app (dotenv) no boot.
      env: {
        NODE_ENV: 'production'
      },

      // PM2 mantém o .env fora do dump; as senhas não ficam no repositório.
      out_file: 'logs/pm2-out.log',
      error_file: 'logs/pm2-error.log',
      merge_logs: true,
      time: true
    }
  ]
};
