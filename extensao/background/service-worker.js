'use strict';

import { CONFIG, cadenciaDigito as cadenciaTexto, delayEntrePosts } from '../lib/config.js';
import * as armazenamento from '../lib/armazenamento.js';
import * as licenca from '../lib/licenca.js';
import * as campanhas from '../lib/campanhas.js';

chrome.runtime.onInstalled.addListener(async () => {
  chrome.alarms.create('verificar-licenca', { periodInMinutes: CONFIG.VERIFICAR_LICENCA_MINUTOS });
  chrome.alarms.create('processar-fila', { periodInMinutes: 1 });
  await restaurarAlarmes();
});

chrome.alarms.onAlarm.addListener(async alarme => {
  if (alarme.name === 'verificar-licenca') return verificarLicencaPeriodicamente();
  if (alarme.name === 'processar-fila' || (alarme.name && alarme.name.startsWith('campanha-'))) return processarFila();
}
);

async function verificarLicencaPeriodicamente() {
  try { await licenca.verificarLicenca(); } catch (_) {}
}

let processando = false;

async function processarFila() {
  if (processando) return;
  processando = true;
  try {
    const estado = await armazenamento.carregarEstado();
    migrarCampanhasAntigas(estado);
    const acesso = await licenca.verificarLicenca();
    if (!acesso.permitido) return;

    const campanha = proximaCampanha(estado.campanhas);
    if (!campanha) return;
    if (campanha.status === 'pausada') return;

    const agora = Date.now();
    if (campanha.agendadoPara && new Date(campanha.agendadoPara).getTime() > agora) {
      campanha.proximaPublicacaoEm = new Date(campanha.agendadoPara).getTime();
      await armazenamento.salvarEstado(estado);
      return;
    }
    if (campanha.proximaPublicacaoEm && campanha.proximaPublicacaoEm > agora) return;

    const limite = estado.licenca?.limites?.gruposPorDia ?? 10;
    const hoje = armazenamento.hojeChave();
    if (estado.contadoresDia?.data === hoje && estado.contadoresDia.grupos >= limite) return;

    const item = campanha.fila?.find(d => d.status === 'pendente');
    if (!item) {
      finalizarSeNecessario(campanha);
      await armazenamento.salvarEstado(estado);
      return;
    }

    item.status = 'preparando';
    item.iniciadoEm = Date.now();
    campanha.atual = item.destino;
    await armazenamento.salvarEstado(estado);

    item.status = 'publicando';
    await armazenamento.salvarEstado(estado);
    const resultado = await publicarEmDestino(campanha, item.destino);

    if (resultado.ok) {
      item.status = 'publicado';
      item.confirmadoEm = Date.now();
      item.erro = null;
      campanha.publicado = (campanha.publicado || 0) + 1;
      await armazenamento.registrarPublicacao();
      await campanhas.registrarResultado(campanha.id, item.destino, 'publicado');
    } else if (resultado.naoConfirmado) {
      item.status = 'nao_confirmado';
      item.erro = resultado.erro || 'O botão Publicar não pôde ser confirmado.';
      item.finalizadoEm = Date.now();
      campanha.naoConfirmado = (campanha.naoConfirmado || 0) + 1;
      await campanhas.registrarResultado(campanha.id, item.destino, 'nao_confirmado', item.erro);
    } else {
      item.status = 'falhou';
      item.erro = resultado.erro || 'Falha na publicação.';
      item.finalizadoEm = Date.now();
      campanha.falhou = (campanha.falhou || 0) + 1;
      await campanhas.registrarResultado(campanha.id, item.destino, 'falhou', item.erro);
    }

    campanha.atual = null;
    campanha.agendadoPara = null;
    finalizarSeNecessario(campanha);

    if (campanha.status === 'ativa' && campanha.fila.some(d => d.status === 'pendente')) {
      campanha.proximaPublicacaoEm = Date.now() + delayEntrePosts();
      await armazenamento.salvarEstado(estado);
      await agendarProxima(campanha);
    } else {
      campanha.proximaPublicacaoEm = null;
      await armazenamento.salvarEstado(estado);
    }
  } finally {
    processando = false;
  }
}

function proximaCampanha(lista) {
  return (lista || [])
    .filter(c => c.status === 'ativa' && Array.isArray(c.fila) && c.fila.some(d => d.status === 'pendente'))
    .sort((a, b) => (a.proximaPublicacaoEm || a.agendadoPara || 0) - (b.proximaPublicacaoEm || b.agendadoPara || 0))[0] || null;
}

function finalizarSeNecessario(campanha) {
  if (!campanha.fila?.some(d => d.status === 'pendente' || d.status === 'preparando' || d.status === 'publicando')) {
    campanha.status = 'concluida';
  }
}

async function agendarProxima(campanha) {
  if (!campanha.proximaPublicacaoEm) return;
  await chrome.alarms.create(`campanha-${campanha.id}`, { when: campanha.proximaPublicacaoEm });
}

async function publicarEmDestino(campanha, destino) {
  const aba = await abrirAbaFacebook();
  if (!aba) return { ok: false, erro: 'Não consegui abrir o Facebook.' };

  try { await chrome.scripting.executeScript({ target: { tabId: aba.id }, files: ['content/facebook.js'] }); } catch (_) {}

  await chrome.tabs.update(aba.id, { url: montarUrlGrupo(destino) });
  await esperar(6000);

  let imagemDados = null;
  let imagemTipo = null;
  if (campanha.imagemId) {
    const blob = await armazenamento.buscarImagem(campanha.imagemId);
    if (blob) {
      imagemDados = await blob.arrayBuffer();
      imagemTipo = blob.type || 'image/png';
    }
  }

  const texto = campanha.textos?.[0] || '';
  return chrome.tabs.sendMessage(aba.id, {
    tipo: 'publicar', texto, imagemDados, imagemTipo, cadencia: cadenciaTexto
  }).catch(() => ({ ok: false, naoConfirmado: true, erro: 'Não consegui falar com a página do Facebook.' }));
}

async function abrirAbaFacebook() {
  const abas = await chrome.tabs.query({ url: ['https://www.facebook.com/*', 'https://web.facebook.com/*', 'https://m.facebook.com/*'] });
  if (abas.length) return abas[0];
  return chrome.tabs.create({ url: 'https://www.facebook.com/' });
}

function montarUrlGrupo(destino) {
  const limpo = String(destino).trim();
  if (/^https?:\/\//.test(limpo)) return limpo;
  return `https://www.facebook.com/groups/${limpo}`;
}

function esperar(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

async function restaurarAlarmes() {
  const estado = await armazenamento.carregarEstado();
  migrarCampanhasAntigas(estado);
  await armazenamento.salvarEstado(estado);
  for (const campanha of estado.campanhas || []) {
    if (campanha.status === 'ativa' && campanha.proximaPublicacaoEm) await agendarProxima(campanha);
    if (campanha.status === 'ativa' && campanha.agendadoPara) await agendarProxima({ ...campanha, proximaPublicacaoEm: new Date(campanha.agendadoPara).getTime() });
  }
}

chrome.runtime.onStartup?.addListener(restaurarAlarmes);

chrome.runtime.onMessage.addListener((mensagem, _sender, enviarResposta) => {
  if (mensagem?.tipo === 'processar-agora') {
    processarFila().then(() => enviarResposta({ ok: true })).catch(erro => enviarResposta({ ok: false, erro: String(erro) }));
    return true;
  }
  if (mensagem?.tipo === 'iniciar-campanha') {
    iniciarCampanha(mensagem.campanhaId).then(() => enviarResposta({ ok: true })).catch(erro => enviarResposta({ ok: false, erro: String(erro) }));
    return true;
  }
  if (mensagem?.tipo === 'pausar-campanha') {
    alterarPausa(mensagem.campanhaId, true).then(() => enviarResposta({ ok: true })).catch(erro => enviarResposta({ ok: false, erro: String(erro) }));
    return true;
  }
  if (mensagem?.tipo === 'retomar-campanha') {
    alterarPausa(mensagem.campanhaId, false).then(() => enviarResposta({ ok: true })).catch(erro => enviarResposta({ ok: false, erro: String(erro) }));
    return true;
  }
  return false;
});

async function iniciarCampanha(id) {
  const estado = await armazenamento.carregarEstado();
  const campanha = estado.campanhas.find(c => c.id === id);
  if (!campanha) throw new Error('Campanha não encontrada.');
  campanha.status = 'ativa';
  campanha.proximaPublicacaoEm = Date.now();
  campanha.atual = null;
  await armazenamento.salvarEstado(estado);
  await processarFila();
}

async function alterarPausa(id, pausar) {
  const estado = await armazenamento.carregarEstado();
  const campanha = estado.campanhas.find(c => c.id === id);
  if (!campanha) throw new Error('Campanha não encontrada.');
  if (pausar) {
    campanha.status = 'pausada';
    campanha.proximaPublicacaoEm = null;
  } else {
    campanha.status = 'ativa';
    campanha.proximaPublicacaoEm = Date.now();
    await agendarProxima(campanha);
  }
  await armazenamento.salvarEstado(estado);
}

