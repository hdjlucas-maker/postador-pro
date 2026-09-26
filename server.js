'use strict';

require('dotenv').config();

const config = require('./src/config');
const log = require('./src/log');
const db = require('./src/db');
const auth = require('./src/auth');
const { criarApp } = require('./src/app');

// O servidor é a API de licença: autenticar, dizer se a assinatura está
// ativa, receber o webhook da InfinitePay e servir o download da extensão.
// Nada de publicação acontece aqui.
//
// Compactação e backup rodam por intervalo em minutos. Um agendamento por
// expressão cron exigiria traduzir o intervalo em hora e minuto, e um valor
// inválido ali significa backup que nunca roda em silêncio. O relógio de uma
// minuto com contagem de tempo decorrido não tem esse modo de falha.

const TICKS_POR_MINUTO = 60 * 1000;
const MINUTOS_VALIDOS = 1440;

function validarIntervalo(nome, valor) {
  if (!Number.isInteger(valor) || valor < 1 || valor > MINUTOS_VALIDOS) {
    throw new Error(`${nome} precisa ser um número inteiro entre 1 e ${MINUTOS_VALIDOS} minutos.`);
  }
  return valor;
}

// Agenda uma tarefa por intervalo em minutos. O relógio roda a cada minuto e a
// tarefa dispara quando o tempo decorrido alcanza o intervalo. `ultimaExecucao`
// começa em null para que a primeira passagem ocorra depois do intervalo cheio,
// e não logo no boot.
function agendarACadaMinutos({ nome, minutos, aoExecutar, imediato = false }) {
  const intervalo = validarIntervalo(nome, minutos) * TICKS_POR_MINUTO;
  const estado = { ultimaExecucao: imediato ? Date.now() : null };
  const relogio = setInterval(() => {
    const agora = Date.now();
    const decorrido = agora - (estado.ultimaExecucao ?? agora);
    if (decorrido < intervalo) return;
    estado.ultimaExecucao = agora;
    Promise.resolve()
      .then(aoExecutar)
      .catch(erro => log.warn(nome, { erro: erro.message }));
  }, TICKS_POR_MINUTO);
  relogio.unref?.();
  return relogio;
}

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
let relogios = [];

async function iniciar() {
  await db.iniciar();

  const app = criarApp();
  servidor = app.listen(config.PORT, config.HOST, () => {
    log.info('servidor_iniciado', {
      porta: config.PORT,
      url: config.PUBLIC_BASE_URL,
      seguro: config.COOKIE_SECURE,
      producao: config.IS_PROD
    });
  });

  servidor.keepAliveTimeout = 65000;
  servidor.headersTimeout = 66000;

  relogios.push(
    agendarACadaMinutos({
      nome: 'manutencao_sessoes',
      minutos: 5,
      aoExecutar: () => auth.limparExpiradas()
    })
  );

  relogios.push(
    agendarACadaMinutos({
      nome: 'compactacao_ciclo',
      minutos: config.COMPACTACAO_MINUTOS,
      aoExecutar: () => db.compactarTodas()
    })
  );

  relogios.push(
    agendarACadaMinutos({
      nome: 'backup_ciclo',
      minutos: config.BACKUP_MINUTOS,
      aoExecutar: () => {
        if (!config.IS_PROD) return null;
        return db.backup();
      }
    })
  );

  log.info('agendamentos', {
    compactacaoMinutos: config.COMPACTACAO_MINUTOS,
    backupMinutos: config.BACKUP_MINUTOS,
    backupAtivo: config.IS_PROD
  });
}

async function encerrar(sinal) {
  if (encerrando) return;
  encerrando = true;

  log.info('encerrando', { sinal });

  for (const relogio of relogios) clearInterval(relogio);
  relogios = [];

  if (servidor) {
    await new Promise(resolve => servidor.close(resolve));
  }

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
