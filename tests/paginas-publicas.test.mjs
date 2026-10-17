import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

// O painel admin ficou fora do ar por um conflito de nomes globais: scripts
// clássicos compartilham o escopo global. O comum.js declarava
// `function chamar...` como global e o admin.js fazia
// `const { chamar } = window.Postador` — o navegador matava o admin.js
// inteiro com "Identifier 'chamar' has already been declared" e o botão
// Entrar virava envio nativo de formulário (recarregava e limpava os campos,
// sem erro visível). Estes testes rodam os scripts de cada página pública em
// ordem, no mesmo contexto, com os MESMOS ids do HTML (getElementById devolve
// null para id inexistente, como o navegador) e disparam o DOMContentLoaded.

const PASTA_PUBLICA = new URL('../public/', import.meta.url);

function lerHtml(nome) {
  return readFileSync(new URL(nome, PASTA_PUBLICA), 'utf8');
}

function scriptsDaPagina(nome) {
  return [...lerHtml(nome).matchAll(/<script[^>]*src="([^"]+)"/g)].map(captura => captura[1]);
}

function idsDaPagina(nome) {
  return new Set([...lerHtml(nome).matchAll(/id="([^"]+)"/g)].map(captura => captura[1]));
}

function caminhoLocal(url) {
  const limpo = url.split('?')[0];
  if (/^https?:/i.test(limpo)) return null;
  return new URL(limpo.replace(/^\//, ''), PASTA_PUBLICA);
}

function criarContexto(idsExistentes) {
  // Elemento genérico por id, com os eventos registrados à parte para as
  // verificações. Ids que não existem no HTML devolvem null, igual ao
  // navegador — é o que pega erro de elemento removido do HTML.
  const elementos = new Map();
  const eventosPorId = new Map();
  const eventosWindow = [];

  function elemento(id) {
    if (!elementos.has(id)) {
      const registrados = [];
      eventosPorId.set(id, registrados);
      elementos.set(id, {
        id,
        hidden: false,
        disabled: false,
        value: '',
        textContent: '',
        innerHTML: '',
        className: '',
        checked: false,
        style: {},
        addEventListener(evento) { registrados.push(evento); },
        removeEventListener() {},
        getAttribute() { return null; },
        setAttribute() {},
        closest() { return null; },
        querySelector() { return elemento(`seletor:${id}`); },
        querySelectorAll() { return []; },
        focus() {},
        click() {}
      });
    }
    return elementos.get(id);
  }

  const sandbox = {
    document: {
      cookie: '',
      getElementById: id => (idsExistentes.has(id) ? elemento(id) : null),
      querySelector: seletor => elemento(`seletor:${seletor}`),
      querySelectorAll: () => [],
      addEventListener() {},
      createElement: () => elemento('elemento-novo')
    },
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    fetch: async () => ({ ok: true, status: 200, text: async () => '{}' }),
    setTimeout,
    clearTimeout,
    console,
    URL,
    Date,
    JSON,
    Math
  };
  sandbox.window = sandbox;
  sandbox.window.addEventListener = (evento, fn) => { eventosWindow.push({ evento, fn }); };

  return { contexto: vm.createContext(sandbox), sandbox, eventosPorId, eventosWindow };
}

async function carregarPagina(pagina) {
  const ambiente = criarContexto(idsDaPagina(pagina.nome));
  const carregados = [];

  for (const url of pagina.scripts) {
    const caminho = caminhoLocal(url);
    assert.ok(caminho, `script externo inesperado em ${pagina.nome}: ${url}`);
    const codigo = readFileSync(caminho, 'utf8');
    const arquivo = path.posix.basename(caminho.pathname);
    assert.doesNotThrow(
      () => new vm.Script(codigo, { filename: arquivo }).runInContext(ambiente.contexto),
      `${arquivo} quebrou a página ${pagina.nome} ao carregar (conflito de nomes globais ou erro de sintaxe?)`
    );
    carregados.push(arquivo);
  }

  // O navegador dispara o DOMContentLoaded depois dos scripts; é nesse
  // momento que a landing carrega os planos e o painel confere a sessão.
  let falhaDoDom = null;
  for (const ouvinte of ambiente.eventosWindow) {
    if (ouvinte.evento !== 'DOMContentLoaded') continue;
    try {
      await ouvinte.fn();
    } catch (erro) {
      falhaDoDom = falhaDoDom || erro;
    }
  }
  assert.equal(falhaDoDom, null, `DOMContentLoaded de ${pagina.nome} falhou: ${falhaDoDom && falhaDoDom.message}`);

  return { ...ambiente, carregados };
}

const paginas = readdirSync(PASTA_PUBLICA)
  .filter(nome => nome.endsWith('.html'))
  .map(nome => ({ nome, scripts: scriptsDaPagina(nome) }))
  .filter(pagina => pagina.scripts.length);

test('encontra as páginas públicas com script (admin e landing)', () => {
  const nomes = paginas.map(pagina => pagina.nome).sort();
  assert.deepEqual(nomes, ['admin.html', 'index.html']);
});

for (const pagina of paginas) {
  test(`scripts de ${pagina.nome} carregam e inicializam sem erro`, async () => {
    const { sandbox, carregados } = await carregarPagina(pagina);

    if (carregados.includes('comum.js')) {
      assert.equal(typeof sandbox.Postador?.chamar, 'function', 'window.Postador não foi definido pelo comum.js');
      // O comum.js não pode criar funções globais: é o que matava os scripts
      // seguintes que desestruturam os mesmos nomes.
      assert.equal(typeof sandbox.chamar, 'undefined', 'comum.js vazou a função global chamar');
      assert.equal(typeof sandbox.mostrar, 'undefined', 'comum.js vazou a função global mostrar');
    }
  });
}

test('o formulário de login do painel admin registra o envio (submit)', async () => {
  const pagina = paginas.find(item => item.nome === 'admin.html');
  assert.ok(pagina, 'admin.html não encontrado');

  const { eventosPorId } = await carregarPagina(pagina);
  const eventosDoFormulario = eventosPorId.get('form-login') || [];
  assert.ok(
    eventosDoFormulario.includes('submit'),
    'o submit do formulário de login não foi registrado — o botão Entrar recarregaria a página sem fazer login'
  );
});
