'use strict';

// Content script: publica no Facebook na aba em que o usuário já está logado.
// Nunca lê senha nem cookie do Facebook. Recebe instruções do service worker
// via chrome.runtime.onMessage e responde com o resultado.

// Seletores do Facebook. O Facebook muda o DOM com frequência; estes são os
// pontos de ancoragem atuais e devem ser revisados se quebrarem.
const SELETORES = {
  compositor: [
    'div[role="dialog"] div[contenteditable="true"]',
    'div[role="dialog"] div[aria-label*="Escreva"]',
    'div[role="dialog"] div[aria-label*="Write"]'
  ],
  botaoPublicar: [
    'div[role="dialog"] div[aria-label="Publicar"]',
    'div[role="dialog"] div[aria-label="Post"]',
    'div[role="dialog"] div[aria-label="Publicar, 1"]',
    'div[role="dialog"] div[aria-label="Post, 1"]',
    'div[role="dialog"] button[type="submit"]'
  ],
  botaoFoto: [
    'div[role="dialog"] div[aria-label="Foto/vídeo"]',
    'div[role="dialog"] div[aria-label="Photo/video"]',
    'div[role="dialog"] input[type="file"]',
    'div[role="dialog"] [aria-label*="Foto/vídeo"]',
    'div[role="dialog"] [aria-label*="Photo/video"]'
  ],
  inputArquivo: 'div[role="dialog"] input[type="file"]'
};

function esperar(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function reportarStatus(fase, mensagem) {
  chrome.runtime.sendMessage({ tipo: 'status-publicacao', fase, mensagem }).catch(() => {});
}

function seguroParaPublicacao(elemento) {
  if (!elemento) return false;
  const dialogo = elemento.closest('[role="dialog"]');
  if (!dialogo || elemento.closest('article') || !dialogoNovaPublicacao(dialogo)) return false;
  return visivel(elemento);
}

function dialogoNovaPublicacao(dialogo) {
  if (!dialogo) return false;
  const texto = (dialogo.innerText || '').toLowerCase();
  const titulo = dialogo.querySelector('[role="heading"], h1, h2, h3');
  const nome = (titulo?.innerText || titulo?.textContent || '').toLowerCase();
  return /criar publica[cç][aã]o|create post|create a post|nova publica[cç][aã]o|new post/.test(`${nome} ${texto}`);
}

function primeiro(seletores) {
  for (const sel of seletores) {
    for (const el of document.querySelectorAll(sel)) {
      if (seguroParaPublicacao(el)) return el;
    }
  }
  return null;
}

async function esperarElemento(seletores, timeoutMs = 15000) {
  const inicio = Date.now();
  while (Date.now() - inicio < timeoutMs) {
    const el = primeiro(seletores);
    if (el) return el;
    await esperar(300);
  }
  return null;
}

// Insere o texto no editor do compositor confirmado.
async function digitarTexto(elemento, texto, cadenciaMin = 35, cadenciaMax = 95) {
  elemento.focus();
  // O editor do Facebook é controlado por React: alterar apenas textContent
  // muda a tela, mas pode não atualizar o estado interno do compositor.
  // execCommand gera a mesma entrada que o editor reconhece.
  document.execCommand('selectAll', false, null);
  document.execCommand('delete', false, null);
  const inserido = document.execCommand('insertText', false, texto);
  if (!inserido || !(elemento.textContent || '').includes(String(texto).slice(0, 20))) {
    elemento.textContent = texto;
    elemento.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: texto }));
  }
  // Mantém uma pequena cadência antes de procurar o botão, permitindo que o
  // Facebook processe a entrada e habilite Publicar.
  await esperar(Math.floor(Math.random() * (cadenciaMax - cadenciaMin + 1)) + cadenciaMin);
  return true;
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

async function anexarImagem(dados, tipo) {
  const editor = primeiro(SELETORES.compositor);
  const dialogo = editor?.closest('[role="dialog"]');
  if (!dialogo || !dialogoNovaPublicacao(dialogo)) return false;
  let input = dialogo.querySelector(SELETORES.inputArquivo);
  if (!input) {
    const foto = Array.from(dialogo.querySelectorAll(SELETORES.botaoFoto.join(','))).find(seguroParaPublicacao) || elementoPorTexto(['foto/vídeo', 'photo/video', 'adicionar foto'], true);
    if (foto) foto.click();
    const inicio = Date.now();
    while (!input && Date.now() - inicio < 5000) {
      input = dialogo.querySelector(SELETORES.inputArquivo);
      if (!input) await esperar(250);
    }
  }
  if (!input) return false;

  const blob = new Blob([dados], { type: tipo || 'image/png' });
  const arquivo = new File([blob], 'postador.png', { type: blob.type || 'image/png' });
  const transfer = new DataTransfer();
  transfer.items.add(arquivo);
  input.files = transfer.files;
  input.dispatchEvent(new Event('change', { bubbles: true }));
  return true;
}

function detectarAvisoFacebook() {
  const corpo = (document.body?.innerText || '').toLowerCase();
  const sinais = ['temporariamente bloquead', 'conta foi suspensa', 'sua conta foi restringida', 'atividade restrita', 'atividade suspeita', 'aviso de spam', 'you’re temporarily blocked', 'you are temporarily blocked', 'account has been suspended', 'we limit how often', 'restricted activity', 'spam warning'];
  return sinais.some(sinal => corpo.includes(sinal));
}

async function publicar({ texto, imagemDados, imagemTipo, cadenciaMin, cadenciaMax }) {
  if (!location.pathname.includes('/groups/')) {
    return { ok: false, erro: 'A aba atual não é uma página de grupo do Facebook.' };
  }
  if (detectarAvisoFacebook()) return { ok: false, pausar: true, erro: 'O Facebook exibiu um aviso ou limitação. A fila foi pausada para proteger a conta.' };
  // Na página de grupo o campo de texto só aparece depois de clicar em
  // "Escreva algo...". Primeiro tenta o campo já aberto; se não existir,
  // abre o compositor e só então procura o contenteditable.
  let compositor = primeiro(SELETORES.compositor);
  if (!compositor) {
    const gatilho = elementoPorTexto(['escreva algo', 'write something', 'criar publicação', 'create post']);
    if (gatilho) gatilho.click();
    compositor = await esperarElemento(SELETORES.compositor, 15000);
  }
  if (!compositor) {
    return { ok: false, erro: 'Compositor não encontrado. Nenhuma publicação foi enviada. A fila foi pausada.' };
  }

  if (!dialogoNovaPublicacao(compositor.closest('[role="dialog"]'))) {
    return { ok: false, erro: 'Não foi possível confirmar o compositor de nova postagem. Nenhum comentário foi enviado. A fila foi pausada.' };
  }
  reportarStatus('compositor_encontrado', 'Compositor de nova postagem confirmado.');
  reportarStatus('inserindo_mensagem', 'Inserindo a mensagem no grupo.');
  await digitarTexto(compositor, texto, cadenciaMin, cadenciaMax);

  if (imagemDados) {
    reportarStatus('anexando_imagem', 'Anexando imagem à nova postagem.');
    const anexou = await anexarImagem(imagemDados, imagemTipo);
    if (!anexou) {
      return { ok: false, erro: 'Não encontrei o botão de anexar imagem.' };
    }
    // Espera o upload da imagem.
    await esperar(3000);
  }

  const dialogo = compositor.closest('[role="dialog"]');
  let botao = await esperarElemento(SELETORES.botaoPublicar, 10000);
  if (!botao || botao.closest('[role="dialog"]') !== dialogo) botao = botaoPublicarDoDialog(dialogo);
  if (!botao || botao.closest('[role="dialog"]') !== dialogo || !dialogoNovaPublicacao(dialogo) || botao.disabled || botao.getAttribute('aria-disabled') === 'true') {
    return { ok: false, naoConfirmada: true, erro: '⚠ Publicação não confirmada. O botão “Publicar” não pôde ser confirmado. Este grupo não será reprocessado automaticamente.' };
  }

  botao.click();
  // Espera a publicação concluir.
  await esperar(4000);
  if (detectarAvisoFacebook()) return { ok: false, pausar: true, erro: 'O Facebook exibiu um aviso após a operação. A fila foi pausada para proteger a conta.' };
  if (dialogo.isConnected) return { ok: false, naoConfirmada: true, erro: '⚠ Publicação não confirmada. O Facebook não confirmou o envio. Este grupo não será reprocessado automaticamente.' };
  return { ok: true };
}

chrome.runtime.onMessage.addListener((mensagem, _sender, enviarResposta) => {
  if (mensagem && mensagem.tipo === 'publicar') {
    publicar(mensagem)
      .then(enviarResposta)
      .catch(erro => enviarResposta({ ok: false, erro: String(erro && erro.message || erro) }));
    return true; // resposta assíncrona
  }
  return false;
});
