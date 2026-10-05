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
    'div[role="dialog"] input[type="file"]'
  ],
  inputArquivo: 'div[role="dialog"] input[type="file"]'
};

function esperar(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function primeiro(seletores) {
  for (const sel of seletores) {
    const el = document.querySelector(sel);
    if (el) return el;
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
async function digitarTexto(elemento, texto, cadencia) {
  elemento.focus();
  // Limpa o conteúdo existente.
  elemento.textContent = '';
  elemento.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'deleteContentBackward' }));

  for (const caractere of texto) {
    elemento.textContent += caractere;
    elemento.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: caractere }));
    await esperar(cadencia());
  }
  return true;
}

async function anexarImagem(dados, tipo) {
  const input = document.querySelector(SELETORES.inputArquivo);
  if (!input) return false;

  const blob = new Blob([dados], { type: tipo || 'image/png' });
  const arquivo = new File([blob], 'postador.png', { type: blob.type || 'image/png' });
  const transfer = new DataTransfer();
  transfer.items.add(arquivo);
  input.files = transfer.files;
  input.dispatchEvent(new Event('change', { bubbles: true }));
  return true;
}

async function publicar({ texto, imagemBlob, cadencia }) {
  // Abre o compositor clicando no campo de status.
  const compositor = await esperarElemento(SELETORES.compositor);
  if (!compositor) {
    return { ok: false, erro: 'Não encontrei o compositor do Facebook. Confirme que está logado e com a página aberta.' };
  }

  await digitarTexto(compositor, texto, cadencia);

  if (imagemBlob) {
    const anexou = await anexarImagem(imagemBlob);
    if (!anexou) {
      return { ok: false, erro: 'Não encontrei o botão de anexar imagem.' };
    }
    // Espera o upload da imagem.
    await esperar(3000);
  }

  const botao = await esperarElemento(SELETORES.botaoPublicar, 10000);
  if (!botao) {
    return { ok: false, erro: 'Não encontrei o botão Publicar.' };
  }

  botao.click();
  // Espera a publicação concluir.
  await esperar(4000);

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
