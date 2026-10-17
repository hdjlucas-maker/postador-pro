import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const fonte = await readFile(new URL('../extensao/content/facebook.js', import.meta.url), 'utf8');

function iniciarContent({ document, date = Date, setTimeoutFn = setTimeout, extras = {} }) {
  let listener;
  const chrome = {
    runtime: {
      onMessage: { addListener(fn) { listener = fn; } },
      sendMessage: async () => ({ ok: true })
    }
  };
  vm.runInNewContext(fonte, { chrome, document, location: { pathname: '/groups/123456789', href: 'https://www.facebook.com/groups/123456789', origin: 'https://www.facebook.com' }, URL, Date: date, setTimeout: setTimeoutFn, console, ...extras });
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
  const resultado = await receber({ tipo: 'publicar', texto: 'Mensagem de teste', grupoEsperado: 'https://www.facebook.com/groups/123456789' });
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
  const publicacoesNoFeed = [];
  const botaoComentario = elemento({ artigo: {}, texto: 'Post' });
  let cliquesNoPublicar = 0;
  const botaoPublicar = elemento({ dialogo, texto: 'Post', click: () => {
    cliquesNoPublicar += 1;
    dialogo.isConnected = false;
    publicacoesNoFeed.push(elemento({ texto: 'Nova publicação segura' }));
  } });
  const document = {
    body: { innerText: '' },
    execCommand(acao, _ui, valor) {
      if (acao === 'insertText') editorPublicacao.textContent = valor;
      return true;
    },
    querySelectorAll(seletor) {
      if (seletor.includes('article')) return publicacoesNoFeed;
      if (seletor.includes('contenteditable') || seletor.includes('aria-label="Escreva"')) return [comentario, editorPublicacao];
      if (seletor.includes('aria-label="Publicar"') || seletor.includes('button[type="submit"]')) return [botaoPublicar];
      if (seletor === '[role="button"], button, [aria-label]') return [botaoComentario, botaoPublicar];
      return [];
    }
  };
  let now = 0;
  class DateAcelerada extends Date { static now() { now += 20000; return now; } }
  const receber = iniciarContent({ document, date: DateAcelerada, setTimeoutFn: fn => { fn(); return 0; } });
  const resultado = await receber({ tipo: 'publicar', texto: 'Nova publicação segura', cadenciaMin: 1, cadenciaMax: 1, grupoEsperado: 'https://www.facebook.com/groups/123456789' });
  console.log('resultado simulado:', resultado);
  assert.equal(resultado.ok, true, resultado.erro);
  assert.equal(editorPublicacao.textContent, 'Nova publicação segura');
  assert.equal(cliquesNoPublicar, 1);
  assert.equal(botaoComentario.isConnected, true);
});

test('não clica em Publicar quando o editor não aceita o texto', async () => {
  const dialogo = {
    innerText: 'Create post',
    isConnected: true,
    querySelector: () => ({ textContent: 'Create post' })
  };
  const editorPublicacao = elemento({ dialogo, texto: '' });
  let cliquesNoPublicar = 0;
  const botaoPublicar = elemento({ dialogo, texto: 'Post', click: () => { cliquesNoPublicar += 1; } });
  const document = {
    body: { innerText: '' },
    execCommand: () => false,
    querySelectorAll(seletor) {
      if (seletor.includes('contenteditable') || seletor.includes('aria-label="Escreva"')) return [editorPublicacao];
      if (seletor.includes('aria-label="Publicar"') || seletor.includes('button[type="submit"]')) return [botaoPublicar];
      return [];
    }
  };
  const receber = iniciarContent({ document, setTimeoutFn: fn => { fn(); return 0; } });
  const resultado = await receber({ tipo: 'publicar', texto: 'Texto que o editor recusa', cadenciaMin: 1, cadenciaMax: 1, grupoEsperado: 'https://www.facebook.com/groups/123456789' });
  assert.equal(resultado.ok, false);
  assert.match(resultado.erro, /não aceitou o texto/);
  assert.match(resultado.erro, /Nenhuma publicação foi enviada/);
  assert.equal(cliquesNoPublicar, 0);
});

test('restrição do grupo: janela "Criar post" sem campo de texto explica o motivo', async () => {
  // Cenário real de produção: o grupo abre a janela "Criar post" mas sem
  // contenteditable (publicação sob aprovação, somente administradores ou
  // membro impedido). A mensagem precisa dizer que é restrição do grupo e
  // mostrar o que a janela exibe, em vez de deixar dúvida se foi a extensão.
  let abriuJanela = false;
  const textoJanela = 'Criar post. A publicação neste grupo precisa ser aprovada por um administrador antes de aparecer para os membros.';
  const janela = {
    innerText: textoJanela,
    textContent: textoJanela,
    isConnected: true,
    getAttribute: () => null,
    getBoundingClientRect: () => ({ width: 100, height: 100 }),
    closest: () => null,
    querySelector(seletor) {
      if (String(seletor).includes('heading')) return { textContent: 'Criar post' };
      return null;
    },
    querySelectorAll: () => []
  };
  const gatilho = elemento({ texto: 'Escreva algo...', click: () => { abriuJanela = true; } });
  const document = {
    body: { innerText: '' },
    querySelectorAll(seletor) {
      if (seletor === '[role="dialog"]' || seletor.includes('[role="alert"]')) return abriuJanela ? [janela] : [];
      if (seletor.includes('contenteditable')) return [];
      if (seletor === '[role="button"], button, [aria-label]') return [gatilho];
      return [];
    }
  };
  let now = 0;
  class DateAcelerada extends Date { static now() { now += 20000; return now; } }
  const receber = iniciarContent({ document, date: DateAcelerada, setTimeoutFn: fn => { fn(); return 0; } });
  const resultado = await receber({ tipo: 'publicar', texto: 'Mensagem de teste', grupoEsperado: 'https://www.facebook.com/groups/123456789' });

  assert.equal(resultado.ok, false);
  assert.equal(resultado.retentavel, true);
  assert.match(resultado.erro, /sem o campo de texto/);
  assert.match(resultado.erro, /restrição do grupo/);
  assert.match(resultado.erro, /precisa ser aprovada por um administrador/);
  assert.match(resultado.erro, /Nenhuma publicação foi enviada/);
});

test('imagem: base64 chega íntegro e é injetada como arquivo real no compositor', async () => {
  // Bytes de um JPEG mínimo (cabeçalho FF D8 FF). O que este teste protege:
  // o service worker envia a imagem em base64 porque o messaging do Chrome só
  // transporta JSON; se voltar a mandar bytes crus (ArrayBuffer/Blob), o
  // conteúdo chega vazio e o Facebook recusa com "Não é possível ler arquivo".
  const bytesImagem = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01]);
  const base64 = bytesImagem.toString('base64');

  const previas = [];
  const input = {
    files: null,
    dispatchEvent(evento) {
      if (evento && evento.type === 'change' && previas.length === 0) {
        previas.push({
          tagName: 'IMG',
          src: 'blob:previa-teste',
          currentSrc: '',
          getAttribute: () => '',
          getBoundingClientRect: () => ({ width: 10, height: 10 })
        });
      }
      return true;
    },
    focus() {}
  };
  const dialogo = {
    innerText: 'Create post',
    isConnected: true,
    getBoundingClientRect: () => ({ top: 0, left: 0, width: 100, height: 100 }),
    appendChild() {},
    querySelector(seletor) {
      if (seletor.includes('heading') || seletor.includes('h1')) return { textContent: 'Create post' };
      if (seletor.includes('input[type="file"]')) return input;
      return null;
    },
    querySelectorAll(seletor) {
      if (seletor === 'img, video') return previas;
      return [];
    }
  };
  const editor = elemento({ dialogo, texto: '' });
  const feed = [];
  const botaoPublicar = elemento({ dialogo, texto: 'Post', click: () => { feed.push(elemento({ texto: 'Oferta especial de teste' })); } });
  botaoPublicar.style = {};
  botaoPublicar.setAttribute = () => {};
  botaoPublicar.removeAttribute = () => {};
  const document = {
    body: { innerText: '' },
    createElement: () => ({ style: {}, textContent: '' }),
    querySelector: () => null,
    execCommand(acao, _ui, valor) {
      if (acao === 'insertText') editor.textContent = valor;
      return true;
    },
    querySelectorAll(seletor) {
      if (seletor.includes('contenteditable') || seletor.includes('aria-label*="Escreva"') || seletor.includes('aria-label*="Write"')) return [editor];
      if (seletor.includes('aria-label="Publicar"') || seletor.includes('aria-label="Post"') || seletor.includes('button[type="submit"]')) return [botaoPublicar];
      if (seletor.includes('[role="article"]')) return feed;
      return [];
    }
  };

  class ArquivoFalso {
    constructor(partes, nome, opcoes = {}) {
      this.name = nome;
      this.type = opcoes.type || '';
      this.partes = partes;
      this.size = partes.reduce((soma, parte) => soma + (parte && typeof parte.byteLength === 'number' ? parte.byteLength : String(parte).length), 0);
    }
  }
  class TransferenciaFalsa {
    constructor() {
      this.items = { add: arquivo => { this.files = [arquivo]; } };
    }
  }
  class EventoFalso {
    constructor(tipo) { this.type = tipo; }
  }
  let agora = 0;
  class DateImagem extends Date {
    static now() { agora += 500; return agora; }
  }

  const receber = iniciarContent({
    document,
    date: DateImagem,
    setTimeoutFn: fn => { fn(); return 0; },
    extras: { atob, DataTransfer: TransferenciaFalsa, File: ArquivoFalso, Event: EventoFalso }
  });
  const resultado = await receber({
    tipo: 'publicar',
    texto: 'Oferta especial de teste',
    imagemBase64: base64,
    imagemTipo: 'image/jpeg',
    imagemNome: 'foto.jpg',
    cadenciaMin: 1,
    cadenciaMax: 1,
    grupoEsperado: 'https://www.facebook.com/groups/123456789'
  });

  assert.equal(resultado.ok, true, resultado.erro);
  assert.equal(resultado.confirmacao, 'feed');
  assert.equal(editor.textContent, 'Oferta especial de teste');
  assert.ok(input.files && input.files[0], 'a imagem deveria ter sido injetada no input do compositor');
  assert.equal(input.files[0].name, 'foto.jpg');
  assert.equal(input.files[0].type, 'image/jpeg');
  assert.equal(input.files[0].size, bytesImagem.length);
  assert.deepEqual(Array.from(input.files[0].partes[0]), Array.from(bytesImagem));
});
