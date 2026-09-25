'use strict';

const fs = require('fs');
const path = require('path');
const config = require('./config');
const { db } = require('./db');
const auth = require('./auth');
const facebook = require('./facebook');
const log = require('./log');
const { dispararPostagens } = require('./postador');

const STATUS = {
  PENDENTE: 'pendente',
  PROCESSANDO: 'processando',
  CONCLUIDO: 'concluido',
  FALHOU: 'falhou',
  CANCELADO: 'cancelado',
  INTERROMPIDO: 'interrompido'
};

const ERROS_SEM_RETRY = /Sessão do Facebook expirou|editor de publicação não apareceu/i;

const emExecucao = new Map();
let rodando = false;
let encerrando = false;
let timer = null;

function chaveGrupo(userId, accountId) {
  return `${userId}::${accountId}`;
}

function emAndamento() {
  return emExecucao.size;
}

function podeIniciar(userId) {
  const doUsuario = [...emExecucao.values()].filter(t => t.userId === userId).length;
  return doUsuario < config.MAX_NAVEGADORES_POR_USUARIO && emExecucao.size < config.MAX_NAVEGADORES_CONCORRENTES;
}

function minutosDeEspera(tentativas) {
  const base = config.RETRY_BASE_MINUTES * Math.pow(2, Math.max(0, tentativas - 1));
  const limite = Math.min(base, config.RETRY_MAX_MINUTES);
  const jitter = limite * 0.2 * Math.random();
  return limite + jitter;
}

async function atualizarStatusCampanha(campanhaId) {
  const itens = await db.posts.find({ campanhaId });
  const campanha = await db.campaigns.findOne({ _id: campanhaId });
  if (!campanha) return;

  if (!itens.length) {
    await db.campaigns.update({ _id: campanhaId }, { $set: { status: STATUS.CONCLUIDO, atualizadoEm: new Date() } });
    return;
  }

  const total = itens.length;
  const concluidos = itens.filter(p => p.status === STATUS.CONCLUIDO).length;
  const falhas = itens.filter(p => [STATUS.FALHOU, STATUS.INTERROMPIDO].includes(p.status)).length;
  const cancelados = itens.filter(p => p.status === STATUS.CANCELADO).length;
  const pendentes = itens.filter(p => [STATUS.PENDENTE, STATUS.PROCESSANDO].includes(p.status)).length;

  let status;

  if (pendentes > 0) {
    status = itens.some(p => p.status === STATUS.PROCESSANDO) ? STATUS.PROCESSANDO : STATUS.PENDENTE;
  } else if (concluidos === total) {
    status = STATUS.CONCLUIDO;
  } else if (cancelados === total) {
    status = STATUS.CANCELADO;
  } else if (concluidos === 0) {
    status = STATUS.FALHOU;
  } else {
    status = 'parcial';
  }

  if (status !== campanha.status) {
    await db.campaigns.update(
      { _id: campanhaId },
      { $set: { status, atualizadoEm: new Date(), concluidos, falhas } }
    );
  }
}

async function finalizarGrupos(grupos) {
  for (const campanhaId of grupos) {
    try {
      await atualizarStatusCampanha(campanhaId);
    } catch (erro) {
      log.error('fila_atualizar_campanha', { campanhaId, erro: erro.message });
    }
  }
}

async function registrarResultado(post, resultado) {
  const agora = new Date();

  if (resultado.sucesso) {
    await db.posts.update(
      { _id: post._id },
      { $set: { status: STATUS.CONCLUIDO, executadoEm: agora, motivo: null, tentativas: (post.tentativas || 0) + 1 } }
    );
    log.info('publicacao_sucesso', { conta: post.perfilId, destino: post.grupoUrl, campanhaId: post.campanhaId });
    return;
  }

  const motivo = String(resultado.erro || 'Falha ao publicar no destino.');
  const tentativas = (post.tentativas || 0) + 1;
  const retryAutomatico = tentativas < config.MAX_TENTATIVAS && !ERROS_SEM_RETRY.test(motivo);

  await db.posts.update(
    { _id: post._id },
    {
      $set: {
        status: retryAutomatico ? STATUS.PENDENTE : STATUS.FALHOU,
        executadoEm: agora,
        motivo,
        tentativas,
        proximaTentativaEm: retryAutomatico
          ? new Date(agora.getTime() + minutosDeEspera(tentativas) * 60000)
          : null
      }
    }
  );

  log.warn('publicacao_falha', {
    conta: post.perfilId,
    destino: post.grupoUrl,
    campanhaId: post.campanhaId,
    tentativas,
    retryAutomatico,
    erro: motivo
  });
}

async function suspenderGrupo(grupo, motivo) {
  const ids = grupo.map(p => p._id);
  if (!ids.length) return;

  await db.posts.update(
    { _id: { $in: ids } },
    { $set: { status: STATUS.INTERROMPIDO, executadoEm: new Date(), motivo, proximaTentativaEm: null } },
    { multi: true }
  );
  log.warn('grupo_interrompido', { destinos: ids.length, motivo });
}

// As campanhas guardam apenas o nome do arquivo. O caminho absoluto é
// resolvido aqui, dentro do diretório de uploads, e nunca vem do cliente.
function prepararGrupo(grupo) {
  return grupo.map(post => {
    const imagens = (Array.isArray(post.imagens) ? post.imagens : [])
      .map(nome => path.basename(String(nome || '')))
      .filter(Boolean)
      .map(nome => path.join(config.UPLOADS_DIR, nome))
      .filter(arquivo => fs.existsSync(arquivo));

    return { ...post, imagens };
  });
}

async function executarGrupo(grupoOriginal) {
  const accountId = grupoOriginal[0].accountId;
  const userId = grupoOriginal[0].userId;
  const campanhas = new Set(grupoOriginal.map(p => p.campanhaId));
  const chave = chaveGrupo(userId, accountId);

  // Precisa existir antes de qualquer uso: `grupo` é a versão com os caminhos
  // absolutos das imagens e é lida logo abaixo, inclusive nos retornos
  // antecipados.
  const grupo = prepararGrupo(grupoOriginal);

  const controle = { userId, accountId, iniciadaEm: Date.now() };
  emExecucao.set(chave, controle);

  try {
    await db.posts.update(
      { _id: { $in: grupo.map(p => p._id) } },
      { $set: { status: STATUS.PROCESSANDO, motivo: null } },
      { multi: true }
    );

    await db.campaigns.update(
      { _id: { $in: [...campanhas] } },
      { $set: { status: STATUS.PROCESSANDO, atualizadoEm: new Date() } },
      { multi: true }
    );

    try {
      await facebook.fecharNavegadorFacebook(accountId, userId);
    } catch (erro) {
      log.warn('fila_fechar_navegador', { accountId, erro: erro.message });
    }

    const user = await db.users.findOne({ _id: userId });
    const acesso = await auth.estadoDeAcesso(user);

    if (!acesso.permitido) {
      await suspenderGrupo(grupo, 'Acesso expirado. Renove a assinatura para publicar.');
      return;
    }

    const conta = await db.accounts.findOne({ _id: accountId, userId });
    if (!conta) {
      await suspenderGrupo(grupo, 'Conta Facebook não encontrada.');
      return;
    }

    log.info('fila_grupo_inicio', {
      conta: grupo[0].perfilId,
      accountId,
      publicacoes: grupo.length,
      destinos: grupo.map(p => p.grupoUrl)
    });

    const execucao = dispararPostagens({ posts: grupo });

    execucao.catch(erro => log.error('fila_executor_promessa', { accountId, erro: erro.message }));

    const watchdog = setTimeout(() => {
      log.warn('fila_grupo_lento', {
        accountId,
        minutos: Math.round((Date.now() - controle.iniciadaEm) / 60000),
        destinos: grupo.length
      });
    }, config.EXECUTOR_TIMEOUT_MS);
    watchdog.unref?.();

    let resultados;
    try {
      resultados = await execucao;
    } finally {
      clearTimeout(watchdog);
    }

    for (let i = 0; i < grupo.length; i++) {
      const post = grupo[i];
      const resultado = resultados[i] || { sucesso: false, erro: 'Executor não retornou resultado.' };
      await registrarResultado(post, resultado);

      const sessaoExpirou = !resultado.sucesso && ERROS_SEM_RETRY.test(String(resultado.erro || ''));
      if (sessaoExpirou && i < grupo.length - 1) {
        const restantes = grupo.slice(i + 1);
        if (restantes.length) {
          await suspenderGrupo(restantes, 'Interrompido: a sessão do Facebook foi encerrada no destino anterior.');
        }
        break;
      }
    }
  } catch (erro) {
    log.error('fila_grupo', { accountId, erro: String(erro.message || erro) });
    await suspenderGrupo(grupo, `Erro interno na execução: ${String(erro.message || erro)}`).catch(() => {});
  } finally {
    emExecucao.delete(chave);
    await finalizarGrupos(campanhas);
  }
}

async function coletarGrupos() {
  const devidos = await db.posts
    .find({
      status: STATUS.PENDENTE,
      dataExecucao: { $lte: new Date() },
      $or: [{ proximaTentativaEm: null }, { proximaTentativaEm: { $exists: false } }, { proximaTentativaEm: { $lte: new Date() } }]
    })
    .sort({ dataExecucao: 1 })
    .limit(500);

  if (!devidos.length) return [];

  const userIds = [...new Set(devidos.map(p => p.userId))];
  const users = await db.users.find({ _id: { $in: userIds } });
  const userMap = new Map(users.map(u => [u._id, u]));

  const expirados = new Set();
  for (const user of users) {
    const acesso = await auth.estadoDeAcesso(user);
    if (!acesso.permitido) expirados.add(user._id);
  }

  if (expirados.size) {
    await db.posts.update(
      { _id: { $in: devidos.filter(p => expirados.has(p.userId)).map(p => p._id) } },
      { $set: { status: STATUS.INTERROMPIDO, motivo: 'Acesso expirado. Renove a assinatura para publicar.', executadoEm: new Date() } },
      { multi: true }
    );
    log.info('fila_acesso_expirado', { usuarios: expirados.size });
  }

  const grupos = new Map();
  for (const post of devidos) {
    if (expirados.has(post.userId)) continue;
    if (emExecucao.has(chaveGrupo(post.userId, post.accountId))) continue;

    const chave = chaveGrupo(post.userId, post.accountId);
    if (!grupos.has(chave)) grupos.set(chave, []);
    grupos.get(chave).push(post);
  }

  return [...grupos.values()];
}

async function processar() {
  if (rodando || encerrando) return;
  rodando = true;

  try {
    const grupos = await coletarGrupos();
    if (!grupos.length) return;

    for (const grupo of grupos) {
      if (encerrando) break;
      if (!podeIniciar(grupo[0].userId)) {
        log.debug('fila_aguardando_vaga', { userId: grupo[0].userId, emExecucao: emExecucao.size });
        continue;
      }
      executarGrupo(grupo).catch(erro =>
        log.error('fila_grupo_promessa', { erro: String(erro.message || erro) })
      );
    }
  } catch (erro) {
    log.error('fila_execucao', { erro: String(erro.message || erro) });
  } finally {
    rodando = false;
  }
}

// Publicações que estavam em processamento quando o processo caiu NÃO voltam
// para a fila: republicar automaticamente geraria postagens duplicadas nos
// grupos. Elas ficam como "interrompido" e o usuário decide por "Reprocessar".
async function recuperarNoBoot() {
  const orphans = await db.posts.find({ status: STATUS.PROCESSANDO });

  if (orphans.length) {
    await db.posts.update(
      { _id: { $in: orphans.map(p => p._id) } },
      {
        $set: {
          status: STATUS.INTERROMPIDO,
          motivo: 'Execução interrompida por reinício do servidor. Use Reprocessar se ainda não foi publicado.'
        }
      },
      { multi: true }
    );

    const campanhas = [...new Set(orphans.map(p => p.campanhaId))];
    for (const campanhaId of campanhas) {
      await atualizarStatusCampanha(campanhaId);
    }
  }

  log.info('fila_recuperada', { interrompidas: orphans.length });
}

function iniciar() {
  if (timer) return;

  timer = setInterval(() => {
    processar().catch(erro => log.error('fila_ciclo', { erro: String(erro.message || erro) }));
  }, config.FILA_INTERVALO_SEGUNDOS * 1000);
  timer.unref?.();

  processar().catch(erro => log.error('fila_inicial', { erro: String(erro.message || erro) }));
  log.info('fila_iniciada', { intervaloSegundos: config.FILA_INTERVALO_SEGUNDOS });
}

async function aguardarFila(timeoutMs = 120000) {
  const inicio = Date.now();
  while (emExecucao.size > 0 && Date.now() - inicio < timeoutMs) {
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  return emExecucao.size === 0;
}

async function parar() {
  encerrando = true;
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
  const esvaziou = await aguardarFila();
  log.info('fila_parada', { esvaziou, emExecucao: emExecucao.size });
  return esvaziou;
}

module.exports = {
  STATUS,
  iniciar,
  parar,
  processar,
  recuperarNoBoot,
  atualizarStatusCampanha,
  emAndamento,
  minutosDeEspera
};
