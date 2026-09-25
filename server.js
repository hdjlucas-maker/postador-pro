'use strict';

require('dotenv').config();

const cron = require('node-cron');
const config = require('./src/config');
const log = require('./src/log');
const db = require('./src/db');
const auth = require('./src/auth');
const queue = require('./src/queue');
const facebook = require('./src/facebook');
const { criarApp } = require('./src/app');
const { expressaoACadaMinutos } = require('./src/cron-agenda');

const { problemas, avisos } = config.validarConfig();

for (const aviso of avisos) log.warn('config_aviso', { aviso });
for (const problema of problemas) log.error('config_problema', { problema });

if (problemas.length) {
  log.error('servidor_nao_iniciado', {
    motivo: 'Corrija a configuração acima e reinicie.',
    comoCorrigir: 'Edite o arquivo .env na raiz do projeto.'
  });
  process.exit(1);
}

let servidor;
let encerrando = false;
let timerManutencao;

async function iniciar() {
  await db.iniciar();

  await queue.recuperarNoBoot();

  const app = criarApp();
  servidor = app.listen(config.PORT, config.HOST, () => {
    log.info('servidor_iniciado', {
      porta: config.PORT,
      url: config.PUBLIC_BASE_URL,
      seguro: config.COOKIE_SECURE,
      producao: config.IS_PROD,
      limites: config.PLAN_LIMITS
    });
  });

  servidor.keepAliveTimeout = 65000;
  servidor.headersTimeout = 66000;

  queue.iniciar();

  timerManutencao = setInterval(() => {
    auth.limparExpiradas().catch(erro => log.warn('manutencao_sessoes', { erro: erro.message }));
    facebook.encerrarOculosos().catch(erro => log.warn('manutencao_navegadores', { erro: erro.message }));
  }, 5 * 60 * 1000);
  timerManutencao.unref?.();

  const agendaCompactacao = expressaoACadaMinutos(config.COMPACTACAO_MINUTOS);
  const agendaBackup = expressaoACadaMinutos(config.BACKUP_MINUTOS);

  log.info('agendamentos', {
    compactacao: agendaCompactacao,
    backup: agendaBackup,
    backup_ativo: config.IS_PROD
  });

  cron.schedule(agendaCompactacao, () => {
    db.compactarTodas().catch(erro => log.warn('compactacao_ciclo', { erro: erro.message }));
  });

  cron.schedule(agendaBackup, () => {
    if (config.IS_PROD) {
      db.backup().catch(erro => log.warn('backup_ciclo', { erro: erro.message }));
    }
  });
}

async function encerrar(sinal) {
  if (encerrando) return;
  encerrando = true;

  log.info('encerrando', { sinal });

  if (timerManutencao) clearInterval(timerManutencao);
  cron.getTasks().forEach(tarefa => tarefa.stop());

  if (servidor) {
    await new Promise(resolve => servidor.close(resolve));
  }

  const esvaziou = await queue.parar();
  if (!esvaziou) {
    log.warn('fila_nao_esvaziou', { emExecucao: queue.emAndamento() });
  }

  await facebook.fecharTodos();
  await db.compactarTodas().catch(() => {});

  log.info('encerrado', { sinal });
  process.exit(0);
}

process.on('SIGTERM', () => encerrar('SIGTERM'));
process.on('SIGINT', () => encerrar('SIGINT'));

process.on('unhandledRejection', motivo => {
  log.error('promise_nao_tratada', { erro: String((motivo && motivo.message) || motivo) });
});

process.on('uncaughtException', erro => {
  log.error('excecao_nao_tratada', { erro: String(erro.message || erro), pilha: erro.stack });
  encerrar('uncaughtException');
});

iniciar().catch(erro => {
  log.error('falha_na_inicializacao', { erro: String(erro.message || erro), pilha: erro.stack });
  process.exit(1);
});
