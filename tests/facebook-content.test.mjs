import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const fonte = await readFile(new URL('../extensao/content/facebook.js', import.meta.url), 'utf8');

function iniciarContent({ document, date = Date, setTimeoutFn = setTimeout }) {
  let listener;
  const chrome = {
    runtime: {
      onMessage: { addListener(fn) { listener = fn; } },
      sendMessage: async () => ({ ok: true })
    }
  };
  vm.runInNewContext(fonte, { chrome, document, location: { pathname: '/groups/123456789' }, Date: date, setTimeout: setTimeoutFn, console });
  return mensagem => new Promise(resolve => listener(mensagem, {}, resolve));
}

function elemento({ artigo = null, dialogo = null, texto = '', click = () => {} } = {}) {
  return {
    textContent: texto,
    innerText: texto,
    disabled: false,
    isConnected: true,
    getAttribute: () => null,
    getBoundingClientRect: () => ({ width: 10, height: 10 }),
    closest(seletor) {
      if (seletor === 'article') return artigo;
      if (seletor === '[role="dialog"]') return dialogo;
      return null;
    },
    focus() {},
    click
  };
}

test('ignora editor de comentário dentro de article quando não há compositor seguro', async () => {
  const article = {};
  const editorComentario = elemento({ artigo: article, texto: 'Escreva um comentário' });
  const document = {
    body: { innerText: '' },
    querySelectorAll(seletor) {
      if (seletor.includes('contenteditable') || seletor.includes('aria-label')) return [editorComentario];
      return [];
    }
  };
  let now = 0;
  class DateAcelerada extends Date { static now() { now += 20000; return now; } }
  const receber = iniciarContent({ document, date: DateAcelerada, setTimeoutFn: fn => { fn(); return 0; } });
  const resultado = await receber({ tipo: 'publicar', texto: 'Mensagem de teste' });
  assert.equal(resultado.ok, false);
  assert.match(resultado.erro, /Nenhuma publicação foi enviada|Nenhum comentário foi enviado/);
  assert.equal(editorComentario.isConnected, true);
});

test('usa somente o editor e o botão dentro do diálogo de nova publicação', async () => {
  const dialogo = {
    innerText: 'Create post',
    isConnected: true,
    querySelector: () => ({ textContent: 'Create post' })
  };
  const comentario = elemento({ artigo: {}, texto: 'Comentário' });
  const editorPublicacao = elemento({ dialogo, texto: '' });
  const botaoComentario = elemento({ artigo: {}, texto: 'Post' });
  let cliquesNoPublicar = 0;
  const botaoPublicar = elemento({ dialogo, texto: 'Post', click: () => { cliquesNoPublicar += 1; dialogo.isConnected = false; } });
  const document = {
    body: { innerText: '' },
    execCommand(acao, _ui, valor) {
      if (acao === 'insertText') editorPublicacao.textContent = valor;
      return true;
    },
    querySelectorAll(seletor) {
      if (seletor.includes('contenteditable') || seletor.includes('aria-label="Escreva"')) return [comentario, editorPublicacao];
      if (seletor.includes('aria-label="Publicar"') || seletor.includes('button[type="submit"]')) return [botaoPublicar];
      if (seletor === '[role="button"], button, [aria-label]') return [botaoComentario, botaoPublicar];
      return [];
    }
  };
  const receber = iniciarContent({ document, setTimeoutFn: fn => { fn(); return 0; } });
  const resultado = await receber({ tipo: 'publicar', texto: 'Nova publicação segura', cadenciaMin: 1, cadenciaMax: 1 });
  assert.equal(resultado.ok, true);
  assert.equal(editorPublicacao.textContent, 'Nova publicação segura');
  assert.equal(cliquesNoPublicar, 1);
  assert.equal(botaoComentario.isConnected, true);
});
