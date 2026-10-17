'use strict';

(function instalarPostadorProContentScript() {

// Content script: publica no Facebook na aba em que o usuário já está logado.
// Nunca lê senha nem cookie do Facebook. Recebe instruções do service worker
// via chrome.runtime.onMessage e responde com o resultado.

// Seletores do Facebook. O Facebook muda o DOM com frequência; estes são os
// pontos de ancoragem atuais e devem ser revisados se quebrarem.
const SELETORES = {
  compositor: [
    '[role="dialog"] [contenteditable="true"]',
    '[role="dialog"] [aria-label*="Escreva"]',
    '[role="dialog"] [aria-label*="Write"]'
  ],
  botaoPublicar: [
    '[role="dialog"] [aria-label="Publicar"]',
    '[role="dialog"] [aria-label="Post"]',
    '[role="dialog"] [aria-label="Publicar, 1"]',
    '[role="dialog"] [aria-label="Post, 1"]',
    '[role="dialog"] button[type="submit"]'
  ],
  botaoFoto: [
    '[role="dialog"] [aria-label="Foto/vídeo"]',
    '[role="dialog"] [aria-label="Photo/video"]',
    '[role="dialog"] input[type="file"]',
    '[role="dialog"] [aria-label*="Foto/vídeo"]',
    '[role="dialog"] [aria-label*="Photo/video"]'
  ],
  inputArquivo: '[role="dialog"] input[type="file"]'
};

let identidadeGrupoAtual = {};

function esperar(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Remonta os bytes originais da imagem a partir do base64. O service worker
// envia base64 porque o messaging do Chrome só transporta JSON; bytes crus
// chegavam vazios e o Facebook recusava com "Não é possível ler arquivo".
function base64ParaBytes(base64) {
  const binario = atob(base64);
  const bytes = new Uint8Array(binario.length);
  for (let i = 0; i < binario.length; i += 1) bytes[i] = binario.charCodeAt(i);
  return bytes;
}

// Cria um aviso visual "aguarde" próximo ao botão de publicar para o usuário
// saber que a imagem está sendo processada e não clicar prematuramente.
function criarAvisoAguarde(dialogo, botao) {
  if (!dialogo || !botao) return null;
  // Remove aviso anterior se existir
  removerAvisoAguarde();
  const aviso = document.createElement('div');
  aviso.id = 'postador-pro-aguarde';
  aviso.style.cssText = `
    position: absolute;
    background: #fff3cd;
    border: 1px solid #ffc107;
    color: #856404;
    padding: 8px 12px;
    border-radius: 6px;
    font-size: 13px;
    font-weight: 600;
    z-index: 999999;
    pointer-events: none;
    white-space: nowrap;
  `;
  aviso.textContent = 'Processando imagem, aguarde...';
  // Posiciona acima do botão de publicar
  const rect = botao.getBoundingClientRect();
  const dialogoRect = dialogo.getBoundingClientRect();
  aviso.style.top = (rect.top - dialogoRect.top - 40) + 'px';
  aviso.style.left = (rect.left - dialogoRect.left) + 'px';
  dialogo.appendChild(aviso);
  return aviso;
}

function removerAvisoAguarde() {
  const aviso = document.querySelector('#postador-pro-aguarde');
  if (aviso) aviso.remove();
}

function desabilitarBotaoPublicar(botao) {
  if (!botao) return;
  botao.disabled = true;
  botao.setAttribute('aria-disabled', 'true');
  botao.style.opacity = '0.6';
  botao.style.cursor = 'not-allowed';
}

function reabilitarBotaoPublicar(botao) {
  if (!botao) return;
  botao.disabled = false;
  botao.removeAttribute('aria-disabled');
  botao.style.opacity = '';
  botao.style.cursor = '';
}

function reportarStatus(fase, mensagem) {
  chrome.runtime.sendMessage({ tipo: 'status-publicacao', fase, mensagem, extras: identidadeGrupoAtual }).catch(() => {});
}

function seguroParaPublicacao(elemento) {
  if (!elemento) return false;
  const dialogo = elemento.closest('[role="dialog"]');
  // O compositor atual do Facebook pode colocar o editor e o botão dentro de
  // um <article>. A segurança vem do diálogo de nova publicação confirmado;
  // descartar qualquer descendente de article ocultava o editor válido.
  if (!dialogo || !dialogoNovaPublicacao(dialogo)) return false;
  return visivel(elemento);
}

function dialogoNovaPublicacao(dialogo) {
  if (!dialogo) return false;
  const texto = (dialogo.innerText || '').toLowerCase();
  const titulo = dialogo.querySelector('[role="heading"], h1, h2, h3');
  const nome = (titulo?.innerText || titulo?.textContent || '').toLowerCase();
  return /criar post|criar publica[cç][aã]o|create post|create a post|nova publica[cç][aã]o|new post/.test(`${nome} ${texto}`);
}

function primeiro(seletores) {
  for (const sel of seletores) {
    // O modal mais recente costuma ser o que está por cima quando o Facebook
    // deixou diálogos antigos no DOM. Percorre os candidatos de trás para frente.
    for (const el of Array.from(document.querySelectorAll(sel)).reverse()) {
      if (seguroParaPublicacao(el)) return el;
    }
  }
  return null;
}

// Faz uma busca síncrona imediata antes do loop de polling: se o elemento ja
// esta no DOM (e e seguro), nao ha motivo para esperar. Isso tambem protege
// contra relogios que saltam (por exemplo em testes com Date simulado) de
// fazerem a janela de timeout expirar antes da primeira checagem.
async function esperarElemento(seletores, timeoutMs = 15000) {
  let el = primeiro(seletores);
  if (el) return el;
  const inicio = Date.now();
  while (Date.now() - inicio < timeoutMs) {
    await esperar(300);
    el = primeiro(seletores);
    if (el) return el;
  }
  return null;
}

// O editor do Facebook é controlado por React/Lexical: alterar apenas
// textContent muda a tela, mas não o estado interno, e o botão Publicar
// continua desabilitado. Por isso o texto só conta como inserido depois de
// conferir que ele apareceu no editor.
function textoNoEditor(elemento, texto) {
  const linha = String(texto || '').split('\n').find(parte => parte.trim()) || '';
  const amostra = linha.trim().slice(0, 20);
  return !amostra || String(elemento.textContent || '').includes(amostra);
}

function selecionarConteudo(elemento) {
  try {
    const selecao = typeof getSelection === 'function' ? getSelection() : null;
    if (!selecao || typeof document.createRange !== 'function') return;
    const faixa = document.createRange();
    faixa.selectNodeContents(elemento);
    selecao.removeAllRanges();
    selecao.addRange(faixa);
  } catch (_) {
    // A seleção é só um reforço; as estratégias abaixo continuam valendo.
  }
}

// Tenta três formas de entrada, da mais simples à que não depende de a aba
// estar com foco, e confere o resultado depois de cada uma.
async function digitarTexto(elemento, texto, cadenciaMin = 35, cadenciaMax = 95) {
  const pausa = () => esperar(Math.floor(Math.random() * (cadenciaMax - cadenciaMin + 1)) + cadenciaMin);
  elemento.focus();
  selecionarConteudo(elemento);

  // 1. execCommand: a mesma entrada que o editor reconhece, exige foco na aba.
  try {
    document.execCommand('selectAll', false, null);
    document.execCommand('delete', false, null);
    document.execCommand('insertText', false, texto);
  } catch (_) {
    // Segue para a próxima estratégia.
  }
  await pausa();
  if (textoNoEditor(elemento, texto)) return { ok: true, metodo: 'execCommand' };

  // 2. Colar: o editor trata o evento paste mesmo sem a aba em foco.
  if (typeof DataTransfer === 'function' && typeof ClipboardEvent === 'function' && elemento.dispatchEvent) {
    try {
      const transferencia = new DataTransfer();
      transferencia.setData('text/plain', texto);
      selecionarConteudo(elemento);
      elemento.dispatchEvent(new ClipboardEvent('paste', { clipboardData: transferencia, bubbles: true, cancelable: true, composed: true }));
    } catch (_) {
      // Segue para a próxima estratégia.
    }
    await esperar(400);
    if (textoNoEditor(elemento, texto)) return { ok: true, metodo: 'paste' };
  }

  // 3. beforeinput: o evento que o Lexical usa para inserir texto.
  if (typeof InputEvent === 'function' && elemento.dispatchEvent) {
    try {
      selecionarConteudo(elemento);
      elemento.dispatchEvent(new InputEvent('beforeinput', { inputType: 'insertText', data: texto, bubbles: true, cancelable: true, composed: true }));
    } catch (_) {
      // Sem mais estratégias.
    }
    await esperar(400);
    if (textoNoEditor(elemento, texto)) return { ok: true, metodo: 'beforeinput' };
  }

  return { ok: false };
}

function visivel(elemento) {
  return Boolean(elemento && elemento.getBoundingClientRect().width && elemento.getBoundingClientRect().height);
}

function elementoPorTexto(textos, somenteDialogo = false) {
  const candidatos = document.querySelectorAll('[role="button"], button, [aria-label]');
  for (const elemento of candidatos) {
    if (somenteDialogo) {
      if (!seguroParaPublicacao(elemento)) continue;
    } else if (elemento.closest('article') || !visivel(elemento)) {
      // Este caminho serve apenas para abrir o compositor na página do grupo.
      // Campos e ações de publicação continuam restritos ao diálogo confirmado.
      continue;
    }
    const texto = `${elemento.getAttribute('aria-label') || ''} ${elemento.textContent || ''}`.toLowerCase();
    if (textos.some(alvo => texto.includes(alvo))) return elemento;
  }
  return null;
}

function botaoPublicarDoDialog(dialogo) {
  return Array.from(dialogo.querySelectorAll('button, [role="button"]')).find(elemento => {
    if (!seguroParaPublicacao(elemento) || elemento.closest('[role="dialog"]') !== dialogo) return false;
    const rotulo = String(elemento.getAttribute('aria-label') || elemento.innerText || elemento.textContent || '')
      .trim().toLowerCase().replace(/\s+/g, ' ');
    return /^(publicar|postar|post)$/.test(rotulo) && !elemento.disabled && elemento.getAttribute('aria-disabled') !== 'true';
  }) || null;
}

function extensaoDaImagem(tipo) {
  return ({ 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp', 'image/gif': '.gif' })[String(tipo || '').toLowerCase()] || '.img';
}

function nomeSeguroDaImagem(nome, tipo) {
  const extensao = extensaoDaImagem(tipo);
  // Remove acentos e diacríticos: o Facebook rejeita nomes com caracteres
  // especiais (ex: "negócio.png" dá "Não é possível ler arquivo").
  const semAcento = String(nome || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
  let seguro = semAcento.split(/[\\/]/).pop().replace(/[^\p{L}\p{N}._-]/gu, '_');
  if (!seguro || seguro === '.' || seguro === '..') seguro = 'imagem';
  const ponto = seguro.lastIndexOf('.');
  const atual = ponto > 0 ? seguro.slice(ponto).toLowerCase() : '';
  const extensoesSuportadas = ['.jpg', '.jpeg', '.png', '.webp', '.gif'];
  if (extensoesSuportadas.includes(atual)) seguro = seguro.slice(0, ponto);
  return `${seguro}${extensao}`;
}

function erroDeUpload(dialogo) {
  const texto = (dialogo?.innerText || '').replace(/\s+/g, ' ').trim();
  return /(?:não é possível|nao e possivel|não foi possível|nao foi possivel|falha ao|erro ao).{0,100}(?:carregar|enviar|arquivo|imagem)|(?:could not|couldn't|can't|cannot).{0,80}(?:upload|load|file)/i.exec(texto)?.[0] || '';
}

function assinaturaDasPrevias(dialogo) {
  return new Set(Array.from(dialogo.querySelectorAll('img, video'))
    .filter(visivel)
    .map(el => `${el.tagName}:${el.currentSrc || el.src || ''}:${el.getAttribute('alt') || ''}`));
}

async function aguardarUploadImagem(dialogo, nome, previasAntes) {
  const inicio = Date.now();
  let previaEstavelDesde = 0;
  let assinaturaPrevia = '';
  while (Date.now() - inicio < 30000) {
    const erro = erroDeUpload(dialogo);
    if (erro) return { ok: false, erro: `O Facebook recusou a imagem “${nome}”: ${erro}.` };
    const enviando = dialogo.querySelector('[aria-busy="true"], [role="progressbar"]') ||
      Array.from(dialogo.querySelectorAll('[aria-label], [role="status"]')).some(el => /upload|carregando|enviando/i.test(`${el.getAttribute('aria-label') || ''} ${el.textContent || ''}`));
    const textoDoDialogo = normalizarTextoComparacao(dialogo.innerText || '');
    const nomeConfirmado = Boolean(nome && textoDoDialogo.includes(normalizarTextoComparacao(nome)));
    const previaNova = Array.from(dialogo.querySelectorAll('img, video')).filter(visivel).find(el => {
      const atual = `${el.tagName}:${el.currentSrc || el.src || ''}:${el.getAttribute('alt') || ''}`;
      return !previasAntes.has(atual) && Boolean(el.currentSrc || el.src || el.getAttribute('alt'));
    });
    const assinaturaAtual = previaNova
      ? `${previaNova.tagName}:${previaNova.currentSrc || previaNova.src || ''}:${previaNova.getAttribute('alt') || ''}`
      : nomeConfirmado ? `nome:${nome}` : '';
    if (assinaturaAtual && assinaturaAtual === assinaturaPrevia && !enviando) {
      if (!previaEstavelDesde) previaEstavelDesde = Date.now();
      if (Date.now() - previaEstavelDesde >= 1200) return { ok: true };
    } else {
      assinaturaPrevia = assinaturaAtual;
      previaEstavelDesde = 0;
    }
    await esperar(400);
  }
  return { ok: false, erro: `O Facebook não mostrou a prévia da imagem “${nome}” após 30 segundos. A publicação não foi enviada.` };
}

async function anexarImagem(dados, tipo, nomeOriginal) {
  const editor = primeiro(SELETORES.compositor);
  const dialogo = editor?.closest('[role="dialog"]');
  if (!dialogo || !dialogoNovaPublicacao(dialogo)) return { ok: false };
  const previasAntes = assinaturaDasPrevias(dialogo);

  const mime = String(tipo || '').toLowerCase();
  if (!['image/jpeg', 'image/png', 'image/webp', 'image/gif'].includes(mime)) return { ok: false };
  if (!dados || !dados.byteLength) return { ok: false };
  const nome = nomeSeguroDaImagem(nomeOriginal, mime);
  const arquivo = new File([dados], nome, { type: mime, lastModified: Date.now() });
  if (!arquivo.size || arquivo.type !== mime) return { ok: false };

  // Estratégia 1: Simular evento de "drop" (arrastar e soltar) na zona de texto/compositor.
  // O Facebook aceita drop nativamente na caixa de postagem e dispara o listener
  // global do React que faz o upload correto da imagem.
  try {
    const dt = new DataTransfer();
    dt.items.add(arquivo);
    // A zona de drop pode ser o contenteditable ou o dialog inteiro.
    const zonaDeDrop = editor || dialogo.querySelector('[role="textbox"], [contenteditable="true"]') || dialogo;
    const dropEvent = new DragEvent('drop', {
      bubbles: true,
      cancelable: true,
      composed: true,
      dataTransfer: dt
    });
    zonaDeDrop.dispatchEvent(dropEvent);
    // Delay obrigatório: o Facebook precisa de tempo para processar o upload
    // da imagem internamente antes de qualquer outra ação. Cada máquina/internet
    // demora um tempo diferente, então usamos 5 segundos como base segura.
    await esperar(5000);
    const previaNova = Array.from(dialogo.querySelectorAll('img, video')).filter(visivel).find(el => {
      const atual = `${el.tagName}:${el.currentSrc || el.src || ''}:${el.getAttribute('alt') || ''}`;
      return !previasAntes.has(atual) && Boolean(el.currentSrc || el.src || el.getAttribute('alt'));
    });
    if (previaNova) {
      return { ok: true, nome, previasAntes };
    }
  } catch (_) {
    // Segue para a próxima estratégia.
  }

  // Estratégia 2: Tentar injetar no input[type=file] via DataTransfer + eventos.
  let input = dialogo.querySelector(SELETORES.inputArquivo);
  if (!input) {
    const foto = Array.from(dialogo.querySelectorAll(SELETORES.botaoFoto.join(','))).find(seguroParaPublicacao) || elementoPorTexto(['foto/vídeo', 'photo/video', 'adicionar foto'], true);
    if (foto) {
      foto.click();
      const inicio = Date.now();
      while (!input && Date.now() - inicio < 5000) {
        input = dialogo.querySelector(SELETORES.inputArquivo);
        if (!input) await esperar(250);
      }
    }
  }
  if (input) {
    try {
      const transfer = new DataTransfer();
      transfer.items.add(arquivo);
      input.files = transfer.files;
      const anexado = input.files?.[0];
      if (anexado && anexado.name === nome && anexado.size === arquivo.size && anexado.type === mime) {
        ['focus', 'input', 'change', 'blur'].forEach(nomeEvento => {
          try { input.dispatchEvent(new Event(nomeEvento, { bubbles: true, cancelable: true })); } catch (_) {}
        });
        await esperar(5000);
        const previaNova2 = Array.from(dialogo.querySelectorAll('img, video')).filter(visivel).find(el => {
          const atual = `${el.tagName}:${el.currentSrc || el.src || ''}:${el.getAttribute('alt') || ''}`;
          return !previasAntes.has(atual) && Boolean(el.currentSrc || el.src || el.getAttribute('alt'));
        });
        if (previaNova2) {
          return { ok: true, nome, previasAntes };
        }
      }
    } catch (_) {
      // Segue para a próxima estratégia.
    }
  }

  // Estratégia 3: definir FileList via defineProperty (fallback).
  if (input) {
    try {
      const descriptor = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'files');
      if (descriptor && descriptor.set) {
        descriptor.set.call(input, [arquivo]);
        const anexado = input.files?.[0];
        if (anexado && anexado.name === nome && anexado.size === arquivo.size) {
          ['focus', 'input', 'change', 'blur'].forEach(nomeEvento => {
            try { input.dispatchEvent(new Event(nomeEvento, { bubbles: true, cancelable: true })); } catch (_) {}
          });
          await esperar(5000);
          const previaNova3 = Array.from(dialogo.querySelectorAll('img, video')).filter(visivel).find(el => {
            const atual = `${el.tagName}:${el.currentSrc || el.src || ''}:${el.getAttribute('alt') || ''}`;
            return !previasAntes.has(atual) && Boolean(el.currentSrc || el.src || el.getAttribute('alt'));
          });
          if (previaNova3) {
            return { ok: true, nome, previasAntes };
          }
        }
      }
    } catch (_) {
      // Não conseguiu definir files de forma direta.
    }
  }

  // Nenhuma estratégia conseguiu injetar a imagem.
  return { ok: false, erroInjecao: true };
}

function detectarAvisoFacebook() {
  // Examinar a página inteira gerava falsos positivos quando o próprio
  // anúncio mencionava termos como “bloqueio”. Limita a checagem a avisos e
  // diálogos visíveis que o Facebook apresenta como mensagem da interface.
  const seletores = '[role="alert"], [role="dialog"], [aria-live="assertive"]';
  const corpo = Array.from(document.querySelectorAll(seletores))
    .filter(visivel)
    .map(elemento => elemento.innerText || elemento.textContent || '')
    .join(' ')
    .toLowerCase();
  const sinais = ['temporariamente bloquead', 'conta foi suspensa', 'sua conta foi restringida', 'atividade restrita', 'atividade suspeita', 'aviso de spam', 'you’re temporarily blocked', 'you are temporarily blocked', 'account has been suspended', 'we limit how often', 'restricted activity', 'spam warning'];
  return sinais.some(sinal => corpo.includes(sinal));
}

function rotuloDe(elemento) {
  try {
    return String((elemento.getAttribute && elemento.getAttribute('aria-label')) || elemento.innerText || elemento.textContent || '')
      .replace(/\s+/g, ' ').trim().slice(0, 50);
  } catch (_) {
    return '';
  }
}

async function esperarPaginaPronta(timeoutMs = 10000) {
  const inicio = Date.now();
  while (document.readyState && document.readyState !== 'complete' && Date.now() - inicio < timeoutMs) {
    await esperar(250);
  }
}

// Quando a janela "Criar post" abre e não traz campo de texto, o Facebook
// normalmente está avisando uma restrição do grupo (publicação sob aprovação,
// somente administradores, membro impedido). Guarda um trecho do que a janela
// mostra para a mensagem de falha explicar o motivo sem depender do console.
function trechoDaJanelaDePublicacao() {
  try {
    const janelas = Array.from(document.querySelectorAll('[role="dialog"]'))
      .filter(dialogo => dialogoNovaPublicacao(dialogo))
      .reverse();
    for (const janela of janelas) {
      const texto = (janela.innerText || janela.textContent || '').replace(/\s+/g, ' ').trim();
      if (texto) return texto.slice(0, 160);
    }
    return '';
  } catch (_) {
    return '';
  }
}

// Resumo do que a página mostra, anexado ao erro quando o compositor não é
// encontrado. Serve para descobrir o que mudou no Facebook sem abrir o
// console. Guarda só rótulos curtos de botões e títulos de diálogo.
function diagnosticarPagina(rotuloGatilho) {
  try {
    const dialogos = Array.from(document.querySelectorAll('[role="dialog"]') || []).slice(-5).map(dialogo => {
      const titulo = dialogo.querySelector && dialogo.querySelector('[role="heading"], h1, h2, h3');
      const editaveis = dialogo.querySelectorAll ? Array.from(dialogo.querySelectorAll('[contenteditable="true"]')).map(el => {
        const role = el.getAttribute('role') || '';
        const rotulo = el.getAttribute('aria-label') || '';
        return `${el.tagName.toLowerCase()}${role ? `[role=${role}]` : ''}${rotulo ? `[aria-label=${rotulo.slice(0, 24)}]` : ''}${visivel(el) ? ':visível' : ':oculto'}`;
      }).join(',') : '';
      return `"${titulo ? rotuloDe(titulo) : ''}" editáveis=[${editaveis}]`;
    });
    const rotulos = [];
    for (const botao of document.querySelectorAll('[role="button"], button')) {
      if (botao.closest && botao.closest('article')) continue;
      const rotulo = rotuloDe(botao);
      if (rotulo && /escrev|write|publica|post|cri|create|discuss|foto|photo/i.test(rotulo) && !rotulos.includes(rotulo)) rotulos.push(rotulo);
      if (rotulos.length >= 12) break;
    }
    return `Diagnóstico: visibilidade=${document.visibilityState || 'n/d'}; foco=${typeof document.hasFocus === 'function' ? document.hasFocus() : 'n/d'}; pronto=${document.readyState || 'n/d'}; ` +
      `gatilho="${rotuloGatilho || 'nenhum'}"; diálogos=[${dialogos.join(' | ')}]; botões=[${rotulos.join(' | ')}]`.slice(0, 700);
  } catch (erro) {
    return `Diagnóstico indisponível: ${String(erro && erro.message || erro)}`;
  }
}

function normalizarTextoComparacao(valor) {
  return String(valor || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();
}

function trechoDeConfirmacao(texto) {
  return String(texto || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 6)
    .join(' ');
}

function contarCorrespondenciasNoFeed(texto) {
  const trecho = trechoDeConfirmacao(texto);
  if (trecho.replace(/\s/g, '').length < 12) return 0;
  const itens = new Set(document.querySelectorAll(
    'article, [role="article"], [data-ad-preview="message"], [data-ad-comet-preview="message"]'
  ));
  return Array.from(itens)
    .filter(item => visivel(item) && !item.closest('[role="dialog"]'))
    .filter(item => trechoDeConfirmacao(item.innerText || item.textContent).includes(trecho))
    .length;
}

function lerAvisosDePublicacao() {
  return Array.from(document.querySelectorAll('[role="alert"], [role="status"], [aria-live]'))
    .filter(visivel)
    .map(item => item.innerText || item.textContent || '')
    .join(' ');
}

function statusDePublicacaoConfirmado(textoAvisos) {
  const texto = normalizarTextoComparacao(textoAvisos);
  return /(?:sua|your|the) (?:nova )?(?:publicacao|post) (?:foi|esta) (?:publicada|publicado|compartilhada|compartilhado)|(?:your|the) post (?:has been|was) (?:published|shared)|publicacao compartilhada no grupo|post shared to the group/.test(texto);
}

function statusAguardandoAprovacao(textoAvisos) {
  return /pendente (?:de|da) aprovacao|aguardando aprovacao|awaiting (?:admin )?approval|pending approval|being reviewed|under review/.test(normalizarTextoComparacao(textoAvisos));
}

function segmentoDoGrupo(urlOuCaminho) {
  try {
    const url = new URL(urlOuCaminho, location.origin);
    const match = url.pathname.match(/^\/groups\/([^/]+)/i);
    return match ? decodeURIComponent(match[1]) : '';
  } catch (_) { return ''; }
}

function nomeGrupoVisivel() {
  const titulos = Array.from(document.querySelectorAll('[role="main"] h1, main h1, h1')).filter(visivel);
  for (const titulo of titulos) {
    const nome = (titulo.innerText || titulo.textContent || '').trim().replace(/\s+/g, ' ');
    if (nome && !/^(facebook|criar post|create post)$/i.test(nome)) return nome.slice(0, 120);
  }
  return '';
}

async function publicar({ texto, imagemBase64, imagemTipo, imagemNome, cadenciaMin, cadenciaMax, grupoEsperado }) {
  if (!location.pathname.includes('/groups/')) {
    return { ok: false, retentavel: true, erro: 'A aba atual não é uma página de grupo do Facebook.' };
  }
  const grupoAtualId = segmentoDoGrupo(location.href);
  const esperadoId = segmentoDoGrupo(grupoEsperado || '');
  const grupoNome = nomeGrupoVisivel() || `Grupo ${grupoAtualId || 'desconhecido'}`;
  identidadeGrupoAtual = { grupoId: grupoAtualId, grupoNome };
  if (!esperadoId || grupoAtualId !== esperadoId) {
    return { ok: false, pausar: true, interromperFila: true, retentavel: true, ...identidadeGrupoAtual,
      erro: `Destino incorreto ou não identificado: esperado ${esperadoId || 'desconhecido'}, aberto “${grupoNome}” (ID ${grupoAtualId || 'desconhecido'}). Nenhuma publicação foi enviada.` };
  }
  reportarStatus('grupo_confirmado', `Destino confirmado: ${grupoNome} (ID ${grupoAtualId}).`);
  if (detectarAvisoFacebook()) return { ok: false, pausar: true, interromperFila: true, retentavel: true, erro: 'O Facebook mostrou um aviso explícito de restrição na interface. A campanha foi pausada para você conferir a mensagem.' };
  // Na página de grupo o campo de texto só aparece depois de clicar em
  // "Escreva algo...". Primeiro tenta o campo já aberto; se não existir,
  // abre o compositor e só então procura o contenteditable.
  await esperarPaginaPronta();
  let compositor = primeiro(SELETORES.compositor);
  let rotuloGatilho = '';
  if (!compositor) {
    const dialogoJaAberto = Array.from(document.querySelectorAll('[role="dialog"]')).some(dialogoNovaPublicacao);
    if (!dialogoJaAberto) {
      const gatilho = elementoPorTexto(['escreva algo', 'write something', 'criar publicação', 'criar post', 'create post']);
      if (gatilho) {
        rotuloGatilho = rotuloDe(gatilho);
        gatilho.click();
      }
    }
    // Só abre o compositor uma vez: clicar de novo quando um modal já abriu
    // deixava diálogos duplicados e confundia a busca do campo de texto.
    compositor = await esperarElemento(SELETORES.compositor, 12000);
  }
  if (!compositor) {
    // A janela abriu sem campo de texto: o diagnóstico real dos grupos que
    // falharam em produção. Confirma a restrição do grupo e mostra o trecho da
    // janela para o usuário conferir pelo próprio Facebook.
    const trecho = trechoDaJanelaDePublicacao();
    const avisoRestricao = trecho
      ? ` A janela "Criar post" abriu, mas veio sem o campo de texto (a extensão aguardou 12 segundos). Isso normalmente indica restrição do grupo — publicação sob aprovação, somente administradores ou perfil impedido. Confira se você consegue publicar neste grupo pelo próprio Facebook. O que a janela mostra: "${trecho}".`
      : '';
    return { ok: false, retentavel: true, erro: `Compositor não encontrado neste grupo.${avisoRestricao} Nenhuma publicação foi enviada; este destino será registrado como falha e a fila seguirá após o intervalo. ${diagnosticarPagina(rotuloGatilho)}` };
  }

  if (!dialogoNovaPublicacao(compositor.closest('[role="dialog"]'))) {
    return { ok: false, retentavel: true, erro: 'Não foi possível confirmar o compositor de nova postagem neste grupo. Nenhuma publicação foi enviada; a fila seguirá após o intervalo.' };
  }
  reportarStatus('compositor_encontrado', 'Compositor de nova postagem confirmado.');
  reportarStatus('inserindo_mensagem', 'Inserindo a mensagem no grupo.');
  const digitacao = await digitarTexto(compositor, texto, cadenciaMin, cadenciaMax);
  if (!digitacao.ok) {
    return { ok: false, retentavel: true, erro: `O Facebook não aceitou o texto no campo de nova publicação. Nenhuma publicação foi enviada; este grupo será registrado como falha. ${diagnosticarPagina('')}` };
  }

  const dialogo = compositor.closest('[role="dialog"]');

  let botao = null;

  if (imagemBase64) {
    reportarStatus('anexando_imagem', 'Anexando imagem à nova postagem.');
    const anexo = await anexarImagem(base64ParaBytes(imagemBase64), imagemTipo, imagemNome);
    if (!anexo.ok) {
      if (anexo.erroInjecao) {
        return { ok: false, retentavel: true, erro: 'Não foi possível anexar a imagem ao compositor do Facebook. Nenhuma publicação foi enviada; o grupo pode ser tentado novamente. Se o erro continuar, publique sem imagem ou fale com o suporte pelo WhatsApp.' };
      }
      return { ok: false, retentavel: true, erro: 'Não consegui selecionar a imagem no compositor. Confira o arquivo e tente novamente; nenhuma publicação foi enviada.' };
    }
    // Aguarda o Facebook processar internamente o upload da imagem antes de
    // seguir para a prévia e o clique em Publicar. Sem esse intervalo, o React
    // pode não reconhecer o arquivo como um upload válido e o Facebook rejeita
    // com "Não é possível ler arquivo".
    await esperar(3000);
    const envioImagem = await aguardarUploadImagem(compositor.closest('[role="dialog"]'), anexo.nome, anexo.previasAntes);
    if (!envioImagem.ok) return { ok: false, retentavel: true, erro: envioImagem.erro };

    // Exibe aviso visual e desabilita o botão "Publicar" para o usuário não
    // clicar prematuramente. Cada máquina/internet demora um tempo diferente,
    // então usamos 5 segundos como base segura após a confirmação da prévia.
    const dialogo = compositor.closest('[role="dialog"]');
    const botaoPublicar = await esperarElemento(SELETORES.botaoPublicar, 10000);
    if (botaoPublicar && botaoPublicar.closest('[role="dialog"]') === dialogo) {
      const aviso = criarAvisoAguarde(dialogo, botaoPublicar);
      desabilitarBotaoPublicar(botaoPublicar);
      reportarStatus('processando_imagem', 'Processando imagem, aguarde antes de publicar.');
      await esperar(5000);
      removerAvisoAguarde();
      reabilitarBotaoPublicar(botaoPublicar);
    }
  }
  let botaoFinal = await esperarElemento(SELETORES.botaoPublicar, 10000);
  if (!botaoFinal || botaoFinal.closest('[role="dialog"]') !== dialogo) botaoFinal = botaoPublicarDoDialog(dialogo);
  botao = botaoFinal;
  if (!botao || botao.closest('[role="dialog"]') !== dialogo || !dialogoNovaPublicacao(dialogo) || botao.disabled || botao.getAttribute('aria-disabled') === 'true') {
    return { ok: false, retentavel: true, erro: 'Não foi possível confirmar o botão “Publicar”. Nenhuma publicação foi enviada; o grupo pode ser tentado novamente.' };
  }

  const correspondenciasAntes = contarCorrespondenciasNoFeed(texto);
  const avisosAntes = normalizarTextoComparacao(lerAvisosDePublicacao());
  botao.click();
  const inicioConfirmacao = Date.now();
  while (Date.now() - inicioConfirmacao < 25000) {
    const avisos = lerAvisosDePublicacao();
    const avisosNormalizados = normalizarTextoComparacao(avisos);
    const avisoNovo = avisosNormalizados && avisosNormalizados !== avisosAntes;
    if (avisoNovo && statusAguardandoAprovacao(avisos)) {
      return { ok: false, naoConfirmada: true, ...identidadeGrupoAtual,
        erro: `No grupo “${grupoNome}” (ID ${grupoAtualId}), o Facebook informou que a publicação aguarda aprovação. Ela não será marcada como publicada nem reenviada automaticamente.` };
    }
    if (avisoNovo && statusDePublicacaoConfirmado(avisos)) return { ok: true, ...identidadeGrupoAtual, confirmacao: 'facebook' };
    if (detectarAvisoFacebook()) return { ok: false, naoConfirmada: true, pausar: true, interromperFila: true, ...identidadeGrupoAtual,
      erro: `O Facebook mostrou um aviso explícito após o envio ao grupo “${grupoNome}” (ID ${grupoAtualId}). A publicação não foi confirmada; confira a mensagem antes de continuar.` };
    if (contarCorrespondenciasNoFeed(texto) > correspondenciasAntes) return { ok: true, ...identidadeGrupoAtual, confirmacao: 'feed' };
    await esperar(500);
  }
  return { ok: false, naoConfirmada: true, ...identidadeGrupoAtual,
    erro: `Publicação não confirmada no grupo “${grupoNome}” (ID ${grupoAtualId}). O Facebook fechou a janela, mas não mostrou confirmação nem encontrei o texto novo no feed. Este destino não será reenviado automaticamente.` };
}

// Facebook pode navegar entre grupos sem recarregar o documento, e o service
// worker injeta este arquivo novamente. Instala um único listener por aba.
if (!globalThis.__postadorProListenerPublicadorInstalado) {
  globalThis.__postadorProListenerPublicadorInstalado = true;
  chrome.runtime.onMessage.addListener((mensagem, _sender, enviarResposta) => {
    if (mensagem && mensagem.tipo === 'publicar') {
      publicar(mensagem)
        .then(enviarResposta)
        .catch(erro => enviarResposta({ ok: false, erro: String(erro && erro.message || erro) }));
      return true;
    }
    return false;
  });
}
})();
