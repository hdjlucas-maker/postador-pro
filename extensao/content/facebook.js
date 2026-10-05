'use strict';

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
  inputArquivo: 'div[role="dialog"] input[type="file"]'
};

function esperar(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }
function primeiro(seletores) { for (const sel of seletores) { const el = document.querySelector(sel); if (el) return el; } return null; }
async function esperarElemento(seletores, timeoutMs = 15000) {
  const inicio = Date.now();
  while (Date.now() - inicio < timeoutMs) { const el = primeiro(seletores); if (el) return el; await esperar(300); }
  return null;
}

async function digitarTexto(elemento, texto, cadencia) {
  elemento.focus();
  elemento.textContent = '';
  elemento.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'deleteContentBackward' }));
  for (const caractere of texto) {
    elemento.textContent += caractere;
    elemento.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: caractere }));
    await esperar(cadencia());
  }
}

async function anexarImagem(dados, tipo) {
  const input = document.querySelector(SELETORES.inputArquivo);
  if (!input || !dados) return false;
  const blob = new Blob([dados], { type: tipo || 'image/png' });
  const arquivo = new File([blob], 'postador.png', { type: blob.type });
  const transfer = new DataTransfer();
  transfer.items.add(arquivo);
  input.files = transfer.files;
  input.dispatchEvent(new Event('change', { bubbles: true }));
  return true;
}

function dialogoExiste() { return !!document.querySelector('div[role="dialog"]'); }
function textoSucesso() {
  const texto = document.body?.innerText || '';
  return /publicad[oa]|postad[oa]|your post was published|published successfully/i.test(texto);
}

async function publicar({ texto, imagemDados, imagemTipo, cadencia }) {
  const compositor = await esperarElemento(SELETORES.compositor);
  if (!compositor) return { ok: false, erro: 'Compositor não encontrado.' };

  await digitarTexto(compositor, texto || '', cadencia);

  if (imagemDados) {
    const anexou = await anexarImagem(imagemDados, imagemTipo);
    if (!anexou) return { ok: false, erro: 'Não encontrei o campo para anexar imagem.' };
    await esperar(3000);
  }

  const botao = await esperarElemento(SELETORES.botaoPublicar, 10000);
  if (!botao) return { ok: false, erro: 'Botão Publicar não encontrado.' };

  botao.click();

  const inicio = Date.now();
  while (Date.now() - inicio < 12000) {
    await esperar(500);
    if (textoSucesso()) return { ok: true };
    if (!dialogoExiste()) return { ok: true };
  }

  return { ok: false, naoConfirmado: true, erro: 'O botão "Publicar" não pôde ser confirmado. Este grupo não será reprocessado automaticamente.' };
}

chrome.runtime.onMessage.addListener((mensagem, _sender, enviarResposta) => {
  if (mensagem?.tipo !== 'publicar') return false;
  publicar(mensagem).then(enviarResposta).catch(erro => enviarResposta({ ok: false, naoConfirmado: true, erro: String(erro?.message || erro) }));
  return true;
});
