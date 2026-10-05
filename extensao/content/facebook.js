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
    'div[role="dialog"] div[aria-label*="Write"]',
    'form[method="POST"] div[contenteditable="true"]'
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

function seguroParaPublicacao(elemento) {
  if (!elemento) return false;
  // Nunca usar editor, botão ou anexo dentro de um post existente: ali o
  // Facebook publica comentário/resposta, não uma nova publicação do grupo.
  if (elemento.closest('article') && !elemento.closest('[role="dialog"]')) return false;
  return visivel(elemento);
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

// Digita o texto com cadência aleatória, simulando digitação humana para não
// parecer automação.
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
    if (!seguroParaPublicacao(elemento)) continue;
    if (somenteDialogo && !elemento.closest('[role="dialog"]')) continue;
    const texto = `${elemento.getAttribute('aria-label') || ''} ${elemento.textContent || ''}`.toLowerCase();
    if (textos.some(alvo => texto.includes(alvo))) return elemento;
  }
  return null;
}

async function anexarImagem(dados, tipo) {
  let input = document.querySelector(SELETORES.inputArquivo);
  if (!input) {
    const foto = primeiro(SELETORES.botaoFoto) || elementoPorTexto(['foto/vídeo', 'photo/video', 'adicionar foto'], true);
    if (foto) foto.click();
    input = await esperarElemento([SELETORES.inputArquivo], 5000);
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
  const sinais = ['temporariamente bloquead', 'conta foi suspensa', 'sua conta foi restringida', 'you’re temporarily blocked', 'you are temporarily blocked', 'account has been suspended', 'we limit how often'];
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
    return { ok: false, erro: 'Não encontrei o compositor do Facebook. Confirme que está logado e com a página aberta.' };
  }

  await digitarTexto(compositor, texto, cadenciaMin, cadenciaMax);

  if (imagemDados) {
    const anexou = await anexarImagem(imagemDados, imagemTipo);
    if (!anexou) {
      return { ok: false, erro: 'Não encontrei o botão de anexar imagem.' };
    }
    // Espera o upload da imagem.
    await esperar(3000);
  }

  let botao = await esperarElemento(SELETORES.botaoPublicar, 10000);
  if (!botao) botao = elementoPorTexto(['publicar', 'post'], true);
  if (!botao || !botao.closest('[role="dialog"]')) {
    return { ok: false, erro: 'Não encontrei o botão Publicar da nova postagem do grupo. Nenhum comentário será enviado.' };
  }

  botao.click();
  // Espera a publicação concluir.
  await esperar(4000);
  if (detectarAvisoFacebook()) return { ok: false, pausar: true, erro: 'O Facebook exibiu um aviso após a operação. A fila foi pausada para proteger a conta.' };

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
