'use strict';

import { CONFIG } from '../lib/config.js';
import * as armazenamento from '../lib/armazenamento.js';
import * as licenca from '../lib/licenca.js';
import * as campanhas from '../lib/campanhas.js';
import { prepararImagemParaEnvio } from '../lib/imagem.js';

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
let janelaAutomacaoId = null;
const CHAVE_ABA_AUTOMACAO = 'postadorProAbaAutomacaoId';
const CHAVE_JANELA_AUTOMACAO = 'postadorProJanelaAutomacaoId';

function atrasoDoRitmo(estado) {
  const ritmo = estado.config && estado.config.ritmo;
  const min = Number(ritmo && ritmo.minMs) || 600000;
  const max = Number(ritmo && ritmo.maxMs) || 1200000;
  const minimoSeguro = Math.max(600000, min);
  const maximoSeguro = Math.max(minimoSeguro, Math.min(86400000, max));
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

    // A autorização de cada publicação precisa vir do servidor agora. Não
    // usamos o cache nem a carência offline para ultrapassar o vencimento.
    const acesso = await licenca.verificarLicenca(true, true);
    if (!acesso.permitido) return { ok: false, erro: 'Sua avaliação ou licença não permite publicar no momento.' };

    // Limite diário server-side: o servidor é a fonte da verdade. A extensão
    // consulta antes de publicar; o limite local abaixo é só um fail-fast para
    // não fazer requisição desnecessária quando já sabemos que estourou.
    const hoje = armazenamento.hojeChave();
    const limiteLocal = Number(estado.licenca?.limites?.gruposPorDia) || (estado.licenca?.plano === 'pro' ? 10 : 5);
    if (estado.contadoresDia && estado.contadoresDia.data === hoje && estado.contadoresDia.grupos >= limiteLocal) {
      estado.proximaPublicacaoEm = 0;
      estado.execucao = { ...(estado.execucao || {}), fase: 'parado', pausada: true, proximaEm: 0, mensagem: 'Limite diário atingido. A fila foi pausada para proteger sua conta.', atualizadoEm: Date.now() };
      await armazenamento.salvarEstado(estado);
      return { ok: false, erro: 'Limite diário atingido. A fila foi pausada para proteger sua conta.' };
    }

    const publicacaoHoje = await licenca.verificarPublicacaoHoje();
    if (!publicacaoHoje.pode) {
      estado.proximaPublicacaoEm = 0;
      estado.execucao = { ...(estado.execucao || {}), fase: 'parado', pausada: true, proximaEm: 0, mensagem: 'Limite diário atingido. A fila foi pausada para proteger sua conta.', atualizadoEm: Date.now() };
      await armazenamento.salvarEstado(estado);
      return { ok: false, erro: 'Limite diário atingido. A fila foi pausada para proteger sua conta.' };
    }

    const campanha = proximaCampanha(estado.campanhas);
    if (!campanha) return { ok: false, erro: 'Não há campanha ativa pronta para publicar.' };
    if (campanha.agendadoPara && new Date(campanha.agendadoPara).getTime() > Date.now()) {
      return { ok: false, erro: 'Essa campanha ainda está agendada para um horário futuro.' };
    }

    const destino = campanha.destinos[0];
    const totalDestinos = (campanha.destinosOriginais || campanha.destinos).length;
    const numeroDestino = Math.max(1, totalDestinos - campanha.destinos.length + 1);
    const idDestino = extrairIdGrupo(montarUrlGrupo(destino));
    await atualizarStatus('abrindo_grupo', `Abrindo destino ${numeroDestino} de ${totalDestinos} — grupo ${idDestino}.`, { campanhaId: campanha.id, destino, grupoId: idDestino, totalDestinos, numeroDestino });
    const resultado = await publicarEmDestino(campanha, destino).catch(erro => ({ ok: false, erro: String(erro?.message || erro || 'Falha ao executar a publicação.') }));
    if (resultado.cancelada) return { ok: false, erro: resultado.erro };

    if (resultado.ok) {
      await armazenamento.registrarPublicacao();
      try {
        await licenca.registrarPublicacaoHoje();
      } catch (_) {
        // Falha de rede ao avisar o servidor: a publicação já foi feita no
        // Facebook. O contador do servidor pode ficar defasado em até uma
        // publicação, mas nunca permite passar do limite (o incremento é
        // atômico e respeita o teto).
      }
    }
    await campanhas.registrarResultado(campanha.id, destino, resultado.ok ? 'publicado' : 'falhou', resultado.erro || '', resultado.textoUsado || '', {
      grupoId: resultado.grupoId || idDestino,
      grupoNome: resultado.grupoNome || '',
      variacaoIndice: resultado.variacaoIndice || 0,
      totalVariacoes: resultado.totalVariacoes || 0
    });

    // Recarrega depois dos contadores para não sobrescrever publicado/falhou
    // com uma cópia antiga do estado.
    const atualizado = await armazenamento.carregarEstado();
    const campanhaAtual = atualizado.campanhas.find(c => c.id === campanha.id);
    if (campanhaAtual) {
      // Cada grupo tentado recebe um resultado e sai da fila automática. Isso
      // impede que um erro local ou uma confirmação incerta trave os próximos
      // destinos ou provoque uma duplicação ao retomar.
      campanhaAtual.destinos.shift();
      const quantidadeTextos = (campanhaAtual.textos || []).filter(Boolean).length;
      if (quantidadeTextos && Number.isInteger(resultado.variacaoIndice) && resultado.variacaoIndice > 0) {
        campanhaAtual.proximoTextoIndice = resultado.variacaoIndice % quantidadeTextos;
      }
      const encerradaDuranteEnvio = campanhaAtual.status === 'encerrada';
      const pausadaDuranteEnvio = campanhaAtual.status === 'pausada' || atualizado.execucao?.pausada;
      if (encerradaDuranteEnvio) {
        atualizado.proximaPublicacaoEm = 0;
        atualizado.execucao = { fase: 'encerrada', pausada: true, mensagem: resultado.ok ? 'Campanha encerrada. A publicação que já estava em andamento terminou; nenhum novo grupo será iniciado.' : (resultado.erro || 'Campanha encerrada.'), campanhaId: campanha.id, destino, atualizadoEm: Date.now() };
      } else if (resultado.ok && !campanhaAtual.destinos.length) {
        campanhaAtual.status = 'concluida';
        atualizado.proximaPublicacaoEm = 0;
        atualizado.execucao = { fase: 'concluida', pausada: false, mensagem: 'Campanha concluída.', campanhaId: campanha.id, destino, atualizadoEm: Date.now() };
      } else if (resultado.interromperFila || pausadaDuranteEnvio) {
        campanhaAtual.status = 'pausada';
        atualizado.proximaPublicacaoEm = 0;
        atualizado.execucao = {
          fase: resultado.ok ? 'parado' : 'erro',
          pausada: true,
          mensagem: resultado.erro || 'Publicação atual concluída. Campanha pausada; nenhum novo grupo será iniciado.',
          campanhaId: campanha.id,
          destino,
          atualizadoEm: Date.now()
        };
      } else if (!campanhaAtual.destinos.length) {
        campanhaAtual.status = 'concluida';
        atualizado.proximaPublicacaoEm = 0;
        atualizado.execucao = { fase: 'concluida', pausada: false, mensagem: resultado.ok ? 'Campanha concluída.' : `Campanha concluída com falha(s). Último resultado: ${resultado.erro || 'publicação não confirmada.'}`, campanhaId: campanha.id, atualizadoEm: Date.now() };
      } else {
        atualizado.proximaPublicacaoEm = Date.now() + atrasoDoRitmo(atualizado);
        chrome.alarms.create('processar-fila-delay', { when: atualizado.proximaPublicacaoEm });
        atualizado.execucao = {
          fase: 'aguardando',
          pausada: false,
          mensagem: resultado.ok
            ? 'Grupo publicado. Aguardando o intervalo configurado.'
            : `Grupo registrado como falha${resultado.naoConfirmada ? ' (publicação não confirmada)' : ''}. A campanha continuará no próximo grupo após o intervalo. ${resultado.erro || ''}`,
          campanhaId: campanha.id,
          destino,
          atualizadoEm: Date.now(),
          proximaEm: atualizado.proximaPublicacaoEm
        };
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
  const indice = Number.isInteger(campanha.proximoTextoIndice)
    ? ((campanha.proximoTextoIndice % lista.length) + lista.length) % lista.length
    : 0;
  return { texto: sortearSpintax(lista[indice]), variacaoIndice: indice + 1, totalVariacoes: lista.length };
}

async function publicarEmDestino(campanha, destino) {
  // Uma única janela popup é reutilizada durante toda a campanha. Ela fica
  // sem foco para não interromper o trabalho do usuário, mas a página do
  // Facebook continua renderizada para que o compositor funcione.
  const url = montarUrlGrupo(destino);
  const aba = await abrirAbaFacebook(url);
  if (!aba) return { ok: false, erro: 'Não consegui abrir a janela de publicação do Facebook.' };

  // Espera a aba chegar de fato na página final do grupo (com os
  // redirecionamentos do Facebook concluídos) antes de injetar o content
  // script. Esperar só o "carregou" da navegação não bastava: o Facebook
  // redireciona a página do grupo logo depois e a injeção acontecia no meio
  // da navegação, falhando em alguns grupos da campanha.
  const navegacao = await navegarAteGrupo(aba.id, url, 60000);
  if (!navegacao.ok) return { ...navegacao, retentavel: true };

  let ativacao = await ativarPublicador(aba.id);
  if (!ativacao.ok) {
    // Segunda chance: recarrega o grupo do zero. Cobre páginas que ficaram
    // presas em um estado transitório de erro no Chrome.
    const recarga = await navegarAteGrupo(aba.id, url, 60000);
    ativacao = recarga.ok ? await ativarPublicador(aba.id) : recarga;
  }
  if (!ativacao.ok) return { ...ativacao, retentavel: true };

  // Carrega a cópia da imagem guardada no IndexedDB e converte para base64. O
  // canal de mensagens do Chrome entre o service worker e a página só
  // transporta JSON: bytes crus (ArrayBuffer/Blob) chegam vazios do outro
  // lado. Era isso que fazia o Facebook recusar toda imagem com "Não é
  // possível ler arquivo" — o arquivo chegava sem conteúdo. O base64 preserva
  // os bytes até a página.
  //
  // `prepararImagemParaEnvio` devolve `interromperFila` quando a cópia sumiu do
  // navegador: a fila para na hora, em vez de falhar em todos os destinos
  // restantes (foi o que aconteceu na campanha de 18/10/2026).
  let imagemBase64 = null;
  let imagemTipo = null;
  let imagemNome = null;
  if (campanha.imagemId) {
    const dados = await armazenamento.buscarImagemDados(campanha.imagemId).catch(() => null);
    const preparo = prepararImagemParaEnvio(dados);
    if (!preparo.ok) return preparo;
    imagemBase64 = preparo.base64;
    imagemTipo = preparo.tipo;
    imagemNome = preparo.nome;
  }

  const selecaoTexto = escolherTexto(campanha);
  const texto = selecaoTexto.texto;

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
    imagemBase64,
    imagemTipo,
    imagemNome,
    grupoEsperado: url,
    cadenciaMin: CONFIG.CADENCIA_MIN_MS,
    cadenciaMax: CONFIG.CADENCIA_MAX_MS
  }).catch(() => ({ ok: false, erro: 'Não consegui falar com a página do Facebook.' }));

  return { ...resposta, textoUsado: texto, variacaoIndice: selecaoTexto.variacaoIndice, totalVariacoes: selecaoTexto.totalVariacoes };
}

async function abrirAbaFacebook(urlInicial = 'https://www.facebook.com/') {
  // O service worker MV3 pode ser encerrado entre publicações; os IDs ficam
  // persistidos para reutilizar a mesma janela durante toda a campanha.
  const dados = await new Promise(resolve => chrome.storage.local.get(
    [CHAVE_ABA_AUTOMACAO, CHAVE_JANELA_AUTOMACAO], resolve
  ));
  const idJanelaSalvo = Number.isInteger(dados[CHAVE_JANELA_AUTOMACAO])
    ? dados[CHAVE_JANELA_AUTOMACAO] : janelaAutomacaoId;
  const idAbaSalvo = Number.isInteger(dados[CHAVE_ABA_AUTOMACAO])
    ? dados[CHAVE_ABA_AUTOMACAO] : abaAutomacaoId;

  if (idJanelaSalvo !== null && idJanelaSalvo !== undefined) {
    try {
      const janela = await chrome.windows.get(idJanelaSalvo, { populate: true });
      const aba = janela.tabs?.find(item => item.id === idAbaSalvo) || janela.tabs?.[0];
      if (aba && !['minimized'].includes(janela.state)) {
        janelaAutomacaoId = janela.id;
        abaAutomacaoId = aba.id;
        return aba;
      }
    } catch (_) {
      janelaAutomacaoId = null;
      abaAutomacaoId = null;
    }
  }

  // Migra uma aba antiga criada em background para a janela dedicada, se ela
  // ainda existir. Isso evita deixar a aba escondida antiga aberta no Chrome.
  if (idAbaSalvo !== null && idAbaSalvo !== undefined) {
    try {
      const abaAntiga = await chrome.tabs.get(idAbaSalvo);
      const host = new URL(abaAntiga.url || '').hostname.toLowerCase();
      if (HOSTS_FACEBOOK.includes(host)) {
        const janela = await chrome.windows.create({
          tabId: abaAntiga.id,
          type: 'popup',
          focused: false,
          width: 1000,
          height: 800
        });
        const aba = janela.tabs?.[0] || await chrome.tabs.get(abaAntiga.id);
        await salvarIdsAutomacao(janela.id, aba.id);
        return aba;
      }
    } catch (_) {
      // A aba antiga pode ter sido fechada ou não ser mais acessível.
    }
  }

  const janela = await chrome.windows.create({
    url: urlInicial,
    type: 'popup',
    focused: false,
    width: 1000,
    height: 800
  });
  const aba = janela.tabs?.[0];
  if (!aba) throw new Error('O Chrome não criou a aba do Facebook na janela de publicação.');
  await salvarIdsAutomacao(janela.id, aba.id);
  return aba;
}

async function salvarIdsAutomacao(windowId, tabId) {
  janelaAutomacaoId = windowId;
  abaAutomacaoId = tabId;
  await new Promise(resolve => chrome.storage.local.set({
    [CHAVE_ABA_AUTOMACAO]: tabId,
    [CHAVE_JANELA_AUTOMACAO]: windowId
  }, resolve));
}

// Endereços aceitos do Facebook: o host pode variar (www/web/m) e o ID do
// grupo, no caminho, é o que identifica a página.
const HOSTS_FACEBOOK = ['www.facebook.com', 'facebook.com', 'web.facebook.com', 'm.facebook.com'];

function ehHostFacebook(endereco) {
  try {
    return HOSTS_FACEBOOK.includes(new URL(String(endereco || '')).hostname.toLowerCase());
  } catch (_) {
    return false;
  }
}

// Compara o endereço atual da aba com o link do grupo esperado. O Facebook
// costuma completar o endereço (barra no final, parâmetros extras) ou trocar
// entre www/web/m; o que identifica o grupo é o segmento depois de /groups/.
export function urlDaAbaPertenceAoGrupo(urlAba, urlEsperada) {
  if (!ehHostFacebook(urlAba)) return false;
  const idAtual = extrairIdGrupo(urlAba).toLowerCase();
  const idEsperado = extrairIdGrupo(urlEsperada).toLowerCase();
  return Boolean(idAtual && idEsperado) && idAtual === idEsperado;
}

// Login ou verificação de segurança: a publicação não tem como seguir e a
// campanha inteira depende dessa sessão, então é melhor avisar do que esperar.
function paginaDeLoginOuVerificacao(endereco) {
  try {
    const caminho = new URL(String(endereco || '')).pathname.toLowerCase();
    return /^\/(login|checkpoint|recover)(\/|$)/.test(caminho);
  } catch (_) {
    return false;
  }
}

// Navega até o grupo e só retorna quando a aba estiver realmente na página do
// grupo, com o carregamento terminado e estável em duas leituras seguidas.
// Exigir o endereço final evita injetar o content script no meio de um
// redirecionamento, que é o que fazia a publicação falhar em alguns grupos.
export async function navegarAteGrupo(tabId, url, timeoutMs) {
  await chrome.tabs.update(tabId, { url }).catch(() => null);
  const inicio = Date.now();
  let leiturasNoGrupo = 0;
  let leiturasDeLogin = 0;
  while (Date.now() - inicio < timeoutMs) {
    const aba = await chrome.tabs.get(tabId).catch(() => null);
    if (!aba) return { ok: false, erro: 'A aba de publicação do Facebook foi fechada antes de abrir o grupo. Nenhuma publicação foi iniciada.' };
    const endereco = String(aba.url || '');
    const parada = aba.status === 'complete' && !aba.pendingUrl;
    if (parada && urlDaAbaPertenceAoGrupo(endereco, url)) {
      leiturasNoGrupo += 1;
      leiturasDeLogin = 0;
      if (leiturasNoGrupo >= 2) return { ok: true };
    } else {
      leiturasNoGrupo = 0;
      if (parada && ehHostFacebook(endereco) && paginaDeLoginOuVerificacao(endereco)) {
        leiturasDeLogin += 1;
        if (leiturasDeLogin >= 2) {
          return { ok: false, pausar: true, interromperFila: true, erro: 'O Facebook pediu login ou verificação de segurança nesta janela de publicação. Entre na conta do Facebook na janela que a extensão abriu e retome a campanha. Nenhuma publicação foi iniciada.' };
        }
      } else {
        leiturasDeLogin = 0;
      }
    }
    await esperar(500);
  }
  return { ok: false, erro: 'O grupo do Facebook não terminou de carregar em 60 segundos. Nenhuma publicação foi iniciada; esse grupo foi registrado como falha e a fila seguirá para o próximo após o intervalo.' };
}

// Injeta o content script com novas tentativas. O Chrome recusa a injeção se
// a aba ainda estiver terminando de navegar; insistir alguns segundos resolve
// o caso comum e, quando não houver jeito, guarda o motivo técnico real para
// facilitar o suporte.
export async function ativarPublicador(tabId, tentativas = 3) {
  let motivo = '';
  for (let tentativa = 1; tentativa <= tentativas; tentativa += 1) {
    const aba = await chrome.tabs.get(tabId).catch(() => null);
    if (!aba) return { ok: false, erro: 'A aba de publicação do Facebook foi fechada antes de iniciar a publicação. Nenhuma publicação foi iniciada.' };
    try {
      await chrome.scripting.executeScript({ target: { tabId }, files: ['content/facebook.js'] });
      return { ok: true };
    } catch (erro) {
      motivo = String((erro && erro.message) || erro || '').slice(0, 160);
      if (tentativa < tentativas) await esperar(1500);
    }
  }
  const detalhe = motivo ? ` Motivo técnico: ${motivo}` : '';
  return { ok: false, erro: `Não consegui ativar a publicação nesta página do Facebook. Nenhuma publicação foi iniciada; o grupo será registrado como falha e a fila seguirá para o próximo após o intervalo.${detalhe}` };
}

function montarUrlGrupo(destino) {
  const limpo = String(destino).trim();
  const url = /^https?:\/\//i.test(limpo) ? new URL(limpo) : new URL(`https://www.facebook.com/groups/${encodeURIComponent(limpo)}`);
  if (!HOSTS_FACEBOOK.includes(url.hostname.toLowerCase()) || !/^\/groups\/[^/]+/.test(url.pathname)) {
    throw new Error('Destino inválido: informe um link de grupo do Facebook ou o ID do grupo.');
  }
  return `https://www.facebook.com${url.pathname}${url.search}`;
}

function extrairIdGrupo(urlOuDestino) {
  try {
    const url = new URL(urlOuDestino, 'https://www.facebook.com');
    const correspondencia = url.pathname.match(/^\/groups\/([^/]+)/i);
    return correspondencia ? decodeURIComponent(correspondencia[1]) : '';
  } catch (_) {
    return String(urlOuDestino || '').trim();
  }
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
        if (estado?.execucao?.pausada || ['aguardando', 'concluida'].includes(estado?.execucao?.fase)) {
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
    atualizarStatus(mensagem.fase, mensagem.mensagem, mensagem.extras || {}).then(() => enviarResposta({ ok: true }));
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
