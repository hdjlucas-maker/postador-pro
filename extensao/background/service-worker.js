'use strict';

import { CONFIG, cadenciaDigito as cadenciaTexto } from '../lib/config.js';
import * as armazenamento from '../lib/armazenamento.js';
import * as licenca from '../lib/licenca.js';
import * as campanhas from '../lib/campanhas.js';

// Service worker: orquestra a fila de publicação, os alarmes de agendamento e
// a verificação periódica da licença. No Manifest V3 o Chrome encerra este
// worker após inatividade; os alarmes só disparam com o navegador ligado.



// --- alarmes ---

chrome.runtime.onInstalled.addListener(() => {
  chrome.alarms.create('verificar-licenca', { periodInMinutes: CONFIG.VERIFICAR_LICENCA_MINUTOS });
  chrome.alarms.create('processar-fila', { periodInMinutes: 1 });
});

chrome.alarms.onAlarm.addListener(async alarme => {
  if (alarme.name === 'verificar-licenca') {
    await verificarLicencaPeriodicamente();
  } else if (alarme.name === 'processar-fila') {
    await processarFila();
  } else if (alarme.name && alarme.name.startsWith('campanha-')) {
    // Chegou a hora de uma campanha agendada.
    await processarFila();
  }
});

async function verificarLicencaPeriodicamente() {
  try {
    await licenca.verificarLicenca();
  } catch (_) {
    // Sem rede: a carência offline decide.
  }
}

// --- fila de publicação ---

let processando = false;

async function processarFila() {
  if (processando) return;
  processando = true;
  try {
    const estado = await armazenamento.carregarEstado();

    // Sem acesso, não publica.
    const acesso = await licenca.verificarLicenca();
    if (!acesso.permitido) return;

    // Limite diário de grupos.
    const hoje = armazenamento.hojeChave();
    if (estado.contadoresDia && estado.contadoresDia.data === hoje) {
      const limite = estado.licenca && estado.licenca.limites ? estado.licenca.limites.gruposPorDia : 10;
      if (estado.contadoresDia.grupos >= limite) return;
    }

    // Encontra a próxima campanha com destino pendente.
    const campanha = proximaCampanha(estado.campanhas);
    if (!campanha) return;

    // Agendamento: só publica se chegou a hora.
    if (campanha.agendadoPara && new Date(campanha.agendadoPara).getTime() > Date.now()) return;

    const destino = campanha.destinos[0];
    const resultado = await publicarEmDestino(campanha, destino);

    if (resultado.ok) {
      await armazenamento.registrarPublicacao();
      await campanhas.registrarResultado(campanha.id, destino, 'publicado');
      campanha.destinos.shift();
      if (!campanha.destinos.length) campanha.status = 'concluida';
      await armazenamento.salvarEstado(estado);
    } else {
      await campanhas.registrarResultado(campanha.id, destino, 'falhou');
      campanha.destinos.shift();
      if (!campanha.destinos.length) campanha.status = 'concluida';
      await armazenamento.salvarEstado(estado);
    }
  } finally {
    processando = false;
  }
}

function proximaCampanha(campanhas) {
  return campanhas
    .filter(c => c.status === 'ativa' && c.destinos && c.destinos.length)
    .sort((a, b) => (a.agendadoPara || 0) - (b.agendadoPara || 0))[0] || null;
}

async function publicarEmDestino(campanha, destino) {
  // Abre (ou reutiliza) uma aba do Facebook.
  const aba = await abrirAbaFacebook();
  if (!aba) return { ok: false, erro: 'Não consegui abrir o Facebook.' };

  // Injeta o content script se ainda não estiver.
  try {
    await chrome.scripting.executeScript({ target: { tabId: aba.id }, files: ['content/facebook.js'] });
  } catch (_) {
    // Já injetado.
  }

  // Navega para o grupo.
  const url = montarUrlGrupo(destino);
  await chrome.tabs.update(aba.id, { url });
  await esperar(6000);

  // Busca a imagem no IndexedDB.
  let imagemDados = null;
  let imagemTipo = null;
  if (campanha.imagemId) {
    const blob = await armazenamento.buscarImagem(campanha.imagemId);
    if (blob) {
      imagemDados = await blob.arrayBuffer();
      imagemTipo = blob.type || 'image/png';
    }
  }

  const texto = campanha.textos[0];

  // ArrayBuffer atravessa o messaging de extensão de forma confiável; Blob não.
  const resposta = await chrome.tabs.sendMessage(aba.id, {
    tipo: 'publicar',
    texto,
    imagemDados,
    imagemTipo,
    cadencia: cadenciaTexto
  }).catch(() => ({ ok: false, erro: 'Não consegui falar com a página do Facebook.' }));

  return resposta;
}

async function abrirAbaFacebook() {
  const abas = await chrome.tabs.query({ url: ['https://www.facebook.com/*', 'https://web.facebook.com/*', 'https://m.facebook.com/*'] });
  if (abas.length) return abas[0];
  return chrome.tabs.create({ url: 'https://www.facebook.com/' });
}

function montarUrlGrupo(destino) {
  const limpo = String(destino).trim();
  if (/^https?:\/\//.test(limpo)) return limpo;
  // Aceita nome de grupo ou ID.
  return `https://www.facebook.com/groups/${limpo}`;
}

function esperar(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Mensagens do popup/options.
chrome.runtime.onMessage.addListener((mensagem, _sender, enviarResposta) => {
  if (mensagem && mensagem.tipo === 'processar-agora') {
    processarFila().then(() => enviarResposta({ ok: true })).catch(erro => enviarResposta({ ok: false, erro: String(erro) }));
    return true;
  }
  if (mensagem && mensagem.tipo === 'agendar-campanha') {
    agendarCampanha(mensagem.campanhaId)
      .then(() => enviarResposta({ ok: true }))
      .catch(erro => enviarResposta({ ok: false, erro: String(erro) }));
    return true;
  }
  return false;
});

async function agendarCampanha(campanhaId) {
  const estado = await armazenamento.carregarEstado();
  const campanha = estado.campanhas.find(c => c.id === campanhaId);
  if (!campanha || !campanha.agendadoPara) return;

  const quando = new Date(campanha.agendadoPara).getTime();
  if (quando <= Date.now()) return;

  // O alarme de campanha dispara uma vez na hora marcada. Depois disso, a
  // fila de 1 minuto segue publicando os destinos restantes.
  await chrome.alarms.create(`campanha-${campanhaId}`, { when: quando });
}
