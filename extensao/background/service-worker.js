'use strict';

import { CONFIG } from '../lib/config.js';
import * as armazenamento from '../lib/armazenamento.js';
import * as licenca from '../lib/licenca.js';
import * as campanhas from '../lib/campanhas.js';

// Service worker: orquestra a fila de publicação, os alarmes de agendamento e
// a verificação periódica da licença. No Manifest V3 o Chrome encerra este
// worker após inatividade; os alarmes só disparam com o navegador ligado.



// --- alarmes ---

async function configurarAlarmes() {
  await chrome.alarms.create('verificar-licenca', { periodInMinutes: CONFIG.VERIFICAR_LICENCA_MINUTOS });
  await chrome.alarms.create('processar-fila', { periodInMinutes: 1 });
}

chrome.runtime.onInstalled.addListener(() => { configurarAlarmes().catch(() => {}); });
chrome.runtime.onStartup.addListener(() => { configurarAlarmes().catch(() => {}); });
// Garante os alarmes também quando o Chrome apenas reativa/recarrega o worker
// da extensão já instalada.
configurarAlarmes().catch(() => {});

chrome.alarms.onAlarm.addListener(async alarme => {
  if (alarme.name === 'verificar-licenca') {
    await verificarLicencaPeriodicamente();
  } else if (alarme.name === 'processar-fila' || alarme.name === 'processar-fila-delay') {
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
let abaAutomacaoId = null;

function atrasoDoRitmo(estado) {
  const ritmo = estado.config && estado.config.ritmo;
  const min = Number(ritmo && ritmo.minMs) || 600000;
  const max = Number(ritmo && ritmo.maxMs) || 1200000;
  const minimoSeguro = Math.max(600000, min);
  const maximoSeguro = Math.max(minimoSeguro, Math.min(7200000, max));
  return Math.floor(Math.random() * (maximoSeguro - minimoSeguro + 1)) + minimoSeguro;
}

async function atualizarStatus(fase, mensagem, extras = {}) {
  const estado = await armazenamento.carregarEstado().catch(() => null);
  if (!estado) return;
  estado.execucao = { ...(estado.execucao || {}), fase, mensagem, atualizadoEm: Date.now(), ...extras };
  await armazenamento.salvarEstado(estado).catch(() => {});
}

async function processarFila(forcar = false) {
  if (processando) return { ok: false, erro: 'A publicação anterior ainda está em andamento.' };
  processando = true;
  try {
    const estado = await armazenamento.carregarEstado();
    if (estado.execucao && estado.execucao.pausada) return { ok: false, erro: 'A fila está pausada porque o Facebook exibiu um aviso. Verifique o Facebook antes de retomar.' };
    if (estado.execucao?.fase === 'publicando') {
      estado.execucao = { ...estado.execucao, fase: 'erro', pausada: true, confirmacaoPendente: true, mensagem: '⚠ Publicação não confirmada. Verifique o grupo no Facebook antes de retomar. Este grupo não será reprocessado automaticamente.', atualizadoEm: Date.now() };
      await armazenamento.salvarEstado(estado);
      return { ok: false, erro: estado.execucao.mensagem };
    }

    // Um clique explícito em Postar agora inicia a primeira publicação. Depois
    // dela, o intervalo escolhido continua sendo respeitado.
    if (estado.proximaPublicacaoEm && Date.now() < estado.proximaPublicacaoEm) {
      return { ok: false, erro: 'Aguarde o intervalo entre publicações antes do próximo grupo.' };
    }
    if (forcar && estado.ultimaPublicacao && Date.now() - estado.ultimaPublicacao < 600000) {
      return { ok: false, erro: 'Aguarde o intervalo entre publicações antes de iniciar outro grupo.' };
    }

    const acesso = await licenca.verificarLicenca();
    if (!acesso.permitido) return { ok: false, erro: 'Sua avaliação ou licença não permite publicar no momento.' };

    const hoje = armazenamento.hojeChave();
    if (estado.contadoresDia && estado.contadoresDia.data === hoje) {
      const limite = Number(estado.licenca?.limites?.gruposPorDia) || (estado.licenca?.plano === 'pro' ? 10 : 5);
      if (estado.contadoresDia.grupos >= limite) {
        estado.proximaPublicacaoEm = 0;
        estado.execucao = { ...(estado.execucao || {}), fase: 'parado', pausada: true, proximaEm: 0, mensagem: 'Limite diário atingido. A fila foi pausada para proteger sua conta.', atualizadoEm: Date.now() };
        await armazenamento.salvarEstado(estado);
        return { ok: false, erro: 'Limite diário atingido. A fila foi pausada para proteger sua conta.' };
      }
    }

    const campanha = proximaCampanha(estado.campanhas);
    if (!campanha) return { ok: false, erro: 'Não há campanha ativa pronta para publicar.' };
    if (campanha.agendadoPara && new Date(campanha.agendadoPara).getTime() > Date.now()) {
      return { ok: false, erro: 'Essa campanha ainda está agendada para um horário futuro.' };
    }

    const destino = campanha.destinos[0];
    await atualizarStatus('abrindo_grupo', `Abrindo o grupo ${destino}.`, { campanhaId: campanha.id, destino });
    const resultado = await publicarEmDestino(campanha, destino).catch(erro => ({ ok: false, pausar: true, erro: String(erro?.message || erro || 'Falha ao executar a publicação.') }));
    if (resultado.cancelada) return { ok: false, erro: resultado.erro };

    if (resultado.ok) await armazenamento.registrarPublicacao();
    await campanhas.registrarResultado(campanha.id, destino, resultado.ok ? 'publicado' : 'falhou', resultado.erro || '', resultado.textoUsado || '');

    // Recarrega depois dos contadores para não sobrescrever publicado/falhou
    // com uma cópia antiga do estado.
    const atualizado = await armazenamento.carregarEstado();
    const campanhaAtual = atualizado.campanhas.find(c => c.id === campanha.id);
    if (campanhaAtual) {
      campanhaAtual.destinos.shift();
      const encerradaDuranteEnvio = campanhaAtual.status === 'encerrada';
      const pausadaDuranteEnvio = campanhaAtual.status === 'pausada' || atualizado.execucao?.pausada;
      if (encerradaDuranteEnvio) {
        atualizado.proximaPublicacaoEm = 0;
        atualizado.execucao = { fase: 'encerrada', pausada: true, mensagem: resultado.ok ? 'Campanha encerrada. A publicação que já estava em andamento terminou; nenhum novo grupo será iniciado.' : (resultado.erro || 'Campanha encerrada.'), campanhaId: campanha.id, destino, atualizadoEm: Date.now() };
      } else if (resultado.ok && !campanhaAtual.destinos.length) {
        campanhaAtual.status = 'concluida';
        atualizado.proximaPublicacaoEm = 0;
        atualizado.execucao = { fase: 'concluida', pausada: false, mensagem: 'Campanha concluída.', campanhaId: campanha.id, destino, atualizadoEm: Date.now() };
      } else if (resultado.pausar || !resultado.ok || pausadaDuranteEnvio) {
        campanhaAtual.status = 'pausada';
        if (resultado.ok && campanhaAtual.destinos.length) atualizado.proximaPublicacaoEm = Date.now() + atrasoDoRitmo(atualizado);
        atualizado.execucao = {
          fase: resultado.ok ? 'parado' : 'erro',
          pausada: true,
          mensagem: !resultado.ok ? resultado.erro : 'Publicação atual concluída. Campanha pausada; nenhum novo grupo será iniciado.',
          campanhaId: campanha.id,
          destino,
          atualizadoEm: Date.now(),
          ...(resultado.ok && campanhaAtual.destinos.length ? { proximaEm: atualizado.proximaPublicacaoEm } : {})
        };
      } else if (!campanhaAtual.destinos.length) {
        campanhaAtual.status = 'concluida';
        atualizado.proximaPublicacaoEm = 0;
        atualizado.execucao = { fase: 'concluida', mensagem: 'Campanha concluída. O Facebook foi usado em uma aba inativa.', campanhaId: campanha.id, atualizadoEm: Date.now() };
      } else {
        atualizado.proximaPublicacaoEm = Date.now() + atrasoDoRitmo(atualizado);
        chrome.alarms.create('processar-fila-delay', { when: atualizado.proximaPublicacaoEm });
        atualizado.execucao = { fase: 'aguardando', mensagem: 'Grupo publicado. Aguardando o intervalo configurado.', campanhaId: campanha.id, atualizadoEm: Date.now(), proximaEm: atualizado.proximaPublicacaoEm };
      }
      campanhaAtual.ultimoTextoUsado = resultado.textoUsado || campanhaAtual.ultimoTextoUsado || '';
      atualizado.ultimoErroPublicacao = resultado.ok ? '' : String(resultado.erro || 'O Facebook não confirmou a publicação.');
      await armazenamento.salvarEstado(atualizado);
    }

    return resultado.ok ? { ok: true, mensagem: 'Publicação enviada ao Facebook.' } : { ok: false, erro: atualizado.ultimoErroPublicacao };
  } catch (erro) {
    const estado = await armazenamento.carregarEstado().catch(() => null);
    if (estado) {
      estado.ultimoErroPublicacao = String(erro?.message || erro || 'Falha desconhecida na publicação.');
      const envioIncerto = estado.execucao?.fase === 'publicando';
      estado.execucao = {
        ...(estado.execucao || {}),
        fase: 'erro',
        pausada: true,
        ...(envioIncerto ? { confirmacaoPendente: true } : {}),
        mensagem: envioIncerto ? '⚠ Publicação não confirmada. Verifique o grupo no Facebook antes de retomar. Este grupo não será reprocessado automaticamente.' : estado.ultimoErroPublicacao,
        atualizadoEm: Date.now()
      };
      await armazenamento.salvarEstado(estado).catch(() => {});
    }
    throw erro;
  } finally {
    processando = false;
  }
}
function proximaCampanha(campanhas) {
  return campanhas
    .filter(c => c.status === 'ativa' && c.destinos && c.destinos.length)
    .sort((a, b) => (a.agendadoPara || 0) - (b.agendadoPara || 0))[0] || null;
}

function sortearSpintax(texto) {
  let resultado = String(texto || '');
  const padrao = /\{([^{}]+)\}/;
  let rodada = 0;
  while (padrao.test(resultado) && rodada < 20) {
    resultado = resultado.replace(padrao, (_inteiro, opcoes) => {
      const alternativas = opcoes.split('|').map(item => item.trim()).filter(Boolean);
      return alternativas.length ? alternativas[Math.floor(Math.random() * alternativas.length)] : opcoes;
    });
    rodada += 1;
  }
  return resultado;
}

function escolherTexto(campanha) {
  const modelos = (campanha.textos || []).filter(Boolean);
  const lista = modelos.length ? modelos : [''];
  let escolhido = '';
  for (let tentativa = 0; tentativa < 8; tentativa += 1) {
    const modelo = lista[Math.floor(Math.random() * lista.length)];
    escolhido = sortearSpintax(modelo);
    if (lista.length === 1 && !/[{}]/.test(modelo)) break;
    if (escolhido !== campanha.ultimoTextoUsado) break;
  }
  return escolhido;
}

async function publicarEmDestino(campanha, destino) {
  // Abre (ou reutiliza) uma aba do Facebook.
  const aba = await abrirAbaFacebook();
  if (!aba) return { ok: false, erro: 'Não consegui abrir o Facebook.' };

  // Navega primeiro. Injetar antes da navegação perde o script quando o
  // Facebook troca a página — era por isso que a fila não encontrava o
  // compositor.
  const url = montarUrlGrupo(destino);
  await chrome.tabs.update(aba.id, { url });
  await esperar(6000);

  try {
    await chrome.scripting.executeScript({ target: { tabId: aba.id }, files: ['content/facebook.js'] });
  } catch (erro) {
    return { ok: false, erro: 'Não consegui ativar a publicação nesta página do Facebook.' };
  }

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

  const texto = escolherTexto(campanha);

  // ArrayBuffer atravessa o messaging de extensão de forma confiável; Blob não.
  await atualizarStatus('publicando', `Enviando a nova postagem para ${destino}.`, { campanhaId: campanha.id, destino, textoUsado: texto });
  const controle = await armazenamento.carregarEstado();
  const campanhaControle = controle.campanhas.find(item => item.id === campanha.id);
  if (controle.execucao?.pausada || campanhaControle?.status !== 'ativa') {
    const encerrada = campanhaControle?.status === 'encerrada';
    const mensagem = encerrada
      ? 'Campanha encerrada antes do envio. Nenhuma publicação foi iniciada.'
      : 'Campanha pausada antes do envio. Nenhuma publicação foi iniciada.';
    await atualizarStatus(encerrada ? 'encerrada' : 'parado', mensagem, { pausada: true, campanhaId: campanha.id, destino });
    return { ok: false, cancelada: true, erro: mensagem };
  }
  const resposta = await chrome.tabs.sendMessage(aba.id, {
    tipo: 'publicar',
    texto,
    imagemDados,
    imagemTipo,
    cadenciaMin: CONFIG.CADENCIA_MIN_MS,
    cadenciaMax: CONFIG.CADENCIA_MAX_MS
  }).catch(() => ({ ok: false, erro: 'Não consegui falar com a página do Facebook.' }));

  return { ...resposta, textoUsado: texto };
}

async function abrirAbaFacebook() {
  if (abaAutomacaoId !== null) {
    try {
      const existente = await chrome.tabs.get(abaAutomacaoId);
      if (existente) return existente;
    } catch (_) {
      abaAutomacaoId = null;
    }
  }
  // Não usa a aba ativa do usuário. A publicação roda em uma aba inativa,
  // sem tomar a tela ou a navegação que a pessoa está usando.
  const aba = await chrome.tabs.create({ url: 'https://www.facebook.com/', active: false });
  abaAutomacaoId = aba.id;
  return aba;
}

function montarUrlGrupo(destino) {
  const limpo = String(destino).trim();
  const url = /^https?:\/\//i.test(limpo) ? new URL(limpo) : new URL(`https://www.facebook.com/groups/${encodeURIComponent(limpo)}`);
  if (!['www.facebook.com', 'facebook.com', 'web.facebook.com', 'm.facebook.com'].includes(url.hostname.toLowerCase()) || !/^\/groups\/[^/]+/.test(url.pathname)) {
    throw new Error('Destino inválido: informe um link de grupo do Facebook ou o ID do grupo.');
  }
  return `https://www.facebook.com${url.pathname}${url.search}`;
}

function esperar(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Mensagens do popup/options.
chrome.runtime.onMessage.addListener((mensagem, _sender, enviarResposta) => {
  if (mensagem && mensagem.tipo === 'processar-agora') {
    if (processando) {
      enviarResposta({ ok: false, erro: 'A fila já está processando uma campanha.' });
      return false;
    }
    processarFila(true).then(async resultado => {
      if (!resultado?.ok && resultado?.erro) {
        const estado = await armazenamento.carregarEstado().catch(() => null);
        if (estado?.execucao?.pausada) {
          // A fila já guardou o erro ou o motivo da pausa.
        } else if (resultado.erro.includes('intervalo entre publicações')) {
          await atualizarStatus('aguardando', resultado.erro, { proximaEm: estado?.proximaPublicacaoEm || 0 });
        } else {
          await atualizarStatus('erro', resultado.erro, { pausada: true, campanhaId: estado?.campanhas.find(c => c.status === 'ativa')?.id });
        }
      }
      enviarResposta(resultado);
    }).catch(erro => enviarResposta({ ok: false, erro: String(erro?.message || erro) }));
    return true;
  }
  if (mensagem && mensagem.tipo === 'pausar-campanha') {
    pausarFila().then(() => enviarResposta({ ok: true })).catch(erro => enviarResposta({ ok: false, erro: String(erro) }));
    return true;
  }
  if (mensagem && mensagem.tipo === 'retomar-campanha') {
    retomarFila().then(() => enviarResposta({ ok: true })).catch(erro => enviarResposta({ ok: false, erro: String(erro) }));
    return true;
  }
  if (mensagem && mensagem.tipo === 'encerrar-campanha') {
    encerrarFila().then(() => enviarResposta({ ok: true })).catch(erro => enviarResposta({ ok: false, erro: String(erro) }));
    return true;
  }
  if (mensagem && mensagem.tipo === 'agendar-campanha') {
    agendarCampanha(mensagem.campanhaId)
      .then(() => enviarResposta({ ok: true }))
      .catch(erro => enviarResposta({ ok: false, erro: String(erro) }));
    return true;
  }
  if (mensagem && mensagem.tipo === 'status-publicacao') {
    atualizarStatus(mensagem.fase, mensagem.mensagem, {}).then(() => enviarResposta({ ok: true }));
    return true;
  }
  return false;
});

async function pausarFila() {
  const estado = await armazenamento.carregarEstado();
  const campanha = estado.campanhas.find(c => c.id === estado.execucao?.campanhaId) || estado.campanhas.find(c => c.status === 'ativa');
  if (campanha) campanha.status = 'pausada';
  estado.execucao = { ...(estado.execucao || {}), fase: 'parado', pausada: true, mensagem: 'Campanha pausada. A publicação atual pode terminar; nenhum novo grupo será iniciado.', atualizadoEm: Date.now() };
  await armazenamento.salvarEstado(estado);
  await chrome.alarms.clear('processar-fila-delay');
}

async function retomarFila() {
  const estado = await armazenamento.carregarEstado();
  if (estado.execucao?.fase === 'encerrada') return;
  const campanha = estado.campanhas.find(c => c.id === estado.execucao?.campanhaId) || estado.campanhas.find(c => c.status === 'pausada');
  if (estado.execucao?.confirmacaoPendente && campanha) {
    const destinoIncerto = estado.execucao.destino || campanha.destinos[0];
    if (destinoIncerto && campanha.destinos[0] === destinoIncerto) {
      campanha.destinos.shift();
      await armazenamento.salvarEstado(estado);
      await campanhas.registrarResultado(campanha.id, destinoIncerto, 'falhou', '⚠ Publicação não confirmada. O grupo foi ignorado após confirmação do usuário para evitar duplicação.', estado.execucao.textoUsado || '');
    }
  }
  const atualizado = await armazenamento.carregarEstado();
  const campanhaAtual = atualizado.campanhas.find(c => c.id === atualizado.execucao?.campanhaId) || atualizado.campanhas.find(c => c.status === 'pausada');
  if (campanhaAtual) campanhaAtual.status = 'ativa';
  if (campanhaAtual && !campanhaAtual.destinos.length) {
    campanhaAtual.status = 'concluida';
    atualizado.proximaPublicacaoEm = 0;
    atualizado.execucao = { ...(atualizado.execucao || {}), fase: 'concluida', pausada: false, confirmacaoPendente: false, mensagem: 'Campanha concluída. O grupo com resultado incerto foi ignorado para evitar duplicação.', atualizadoEm: Date.now() };
    await armazenamento.salvarEstado(atualizado);
    return;
  }
  if (atualizado.proximaPublicacaoEm && atualizado.proximaPublicacaoEm > Date.now()) {
    atualizado.execucao = { ...(atualizado.execucao || {}), fase: 'aguardando', pausada: false, confirmacaoPendente: false, mensagem: 'Campanha retomada. O próximo grupo será iniciado no horário previsto.', atualizadoEm: Date.now(), proximaEm: atualizado.proximaPublicacaoEm };
    await armazenamento.salvarEstado(atualizado);
    await chrome.alarms.create('processar-fila-delay', { when: atualizado.proximaPublicacaoEm });
    return;
  }
  atualizado.execucao = { ...(atualizado.execucao || {}), fase: 'preparando', pausada: false, confirmacaoPendente: false, mensagem: 'Campanha retomada. A fila será processada com o intervalo configurado.', atualizadoEm: Date.now() };
  await armazenamento.salvarEstado(atualizado);
  await processarFila();
}

async function encerrarFila() {
  const estado = await armazenamento.carregarEstado();
  const campanha = estado.campanhas.find(c => c.id === estado.execucao?.campanhaId) || estado.campanhas.find(c => c.status === 'ativa' || c.status === 'pausada');
  if (campanha) campanha.status = 'encerrada';
  estado.execucao = { ...(estado.execucao || {}), fase: 'encerrada', pausada: true, proximaEm: 0, mensagem: 'Campanha encerrada. Nenhum novo grupo será iniciado.', atualizadoEm: Date.now() };
  estado.proximaPublicacaoEm = 0;
  await armazenamento.salvarEstado(estado);
  await chrome.alarms.clear('processar-fila-delay');
}

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
