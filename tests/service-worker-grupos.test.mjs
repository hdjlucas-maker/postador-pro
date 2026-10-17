import test from 'node:test';
import assert from 'node:assert/strict';

// Regressão do erro "Não consegui ativar a publicação nesta página do
// Facebook": a extensão injetava o content script logo após o primeiro
// "complete" da navegação, mas o Facebook redireciona a página do grupo em
// seguida e a injeção era recusada no meio do redirecionamento. O service
// worker agora espera a página final do grupo (estável em duas leituras) e
// insiste na injeção antes de registrar a falha.
//
// O módulo do service worker é carregado com um chrome simulado porque ele
// registra alarmes e listeners já na carga.

const URL_GRUPO = 'https://www.facebook.com/groups/1454247262310175';

let filaAbas = [];
let ultimaLeitura = null;
let execucaoScript = null;
let chamadasUpdate = [];

globalThis.chrome = {
  runtime: {
    onInstalled: { addListener() {} },
    onStartup: { addListener() {} },
    onMessage: { addListener() {} }
  },
  alarms: {
    create: async () => {},
    onAlarm: { addListener() {} }
  },
  tabs: {
    update: async (tabId, info) => { chamadasUpdate.push({ tabId, ...info }); },
    get: async () => {
      const leitura = filaAbas.length ? filaAbas.shift() : ultimaLeitura;
      if (leitura) ultimaLeitura = leitura;
      return leitura;
    }
  },
  scripting: {
    executeScript: (...args) => execucaoScript(...args)
  }
};

const serviceWorker = await import('../extensao/background/service-worker.js');

function leitura(url, extras = {}) {
  return { id: 7, url, status: 'complete', ...extras };
}

function prepararAbas(leituras) {
  filaAbas = leituras.slice();
  ultimaLeitura = null;
  chamadasUpdate = [];
}

test('só considera a aba no grupo esperado quando o endereço confere', () => {
  const pertence = serviceWorker.urlDaAbaPertenceAoGrupo;
  // O Facebook completa o endereço com barra e parâmetros extras.
  assert.equal(pertence(`${URL_GRUPO}/`, URL_GRUPO), true);
  assert.equal(pertence(`${URL_GRUPO}?ref=share`, URL_GRUPO), true);
  assert.equal(pertence('https://web.facebook.com/groups/1454247262310175', URL_GRUPO), true);
  // Grupo com apelido: compara sem diferenciar maiúsculas de minúsculas.
  assert.equal(
    pertence('https://www.facebook.com/groups/DivulgueAqui77/', 'https://www.facebook.com/groups/divulgueaqui77'),
    true
  );
  // Grupo diferente, página de login e páginas internas do Chrome não valem.
  assert.equal(pertence('https://www.facebook.com/groups/999999999', URL_GRUPO), false);
  assert.equal(pertence('https://www.facebook.com/login/?next=%2Fgroups%2F1454247262310175', URL_GRUPO), false);
  assert.equal(pertence('chrome-error://chromewebdata/', URL_GRUPO), false);
  assert.equal(pertence('', URL_GRUPO), false);
  assert.equal(pertence(undefined, URL_GRUPO), false);
});

test('navegarAteGrupo espera o redirecionamento final do grupo antes de liberar', async () => {
  prepararAbas([
    // A aba antiga (grupo anterior) ainda se reporta como completa logo após
    // o tabs.update: era essa leitura que fazia a injeção acontecer cedo.
    leitura('https://www.facebook.com/groups/999999999'),
    // Nova navegação em andamento.
    leitura(URL_GRUPO, { status: 'loading', pendingUrl: URL_GRUPO }),
    // Primeiro carregamento concluído, mas o Facebook ainda vai redirecionar.
    leitura(URL_GRUPO, { pendingUrl: `${URL_GRUPO}/` }),
    // Redirecionamento do Facebook em andamento.
    leitura(`${URL_GRUPO}/`, { status: 'loading', pendingUrl: `${URL_GRUPO}/` }),
    // Página final estável em duas leituras seguidas.
    leitura(`${URL_GRUPO}/`),
    leitura(`${URL_GRUPO}/`)
  ]);
  const resultado = await serviceWorker.navegarAteGrupo(7, URL_GRUPO, 8000);
  assert.equal(resultado.ok, true);
  assert.equal(chamadasUpdate.length, 1);
  assert.equal(chamadasUpdate[0].url, URL_GRUPO);
});

test('navegarAteGrupo desiste com o aviso de carregamento quando o grupo nunca abre', async () => {
  prepararAbas([leitura('https://www.facebook.com/groups/999999999')]);
  const resultado = await serviceWorker.navegarAteGrupo(7, URL_GRUPO, 1200);
  assert.equal(resultado.ok, false);
  assert.match(resultado.erro, /não terminou de carregar em 60 segundos/);
});

test('navegarAteGrupo pausa a campanha quando o Facebook pede login', async () => {
  prepararAbas([
    leitura(`https://www.facebook.com/login/?next=${encodeURIComponent(URL_GRUPO)}`),
    leitura(`https://www.facebook.com/login/?next=${encodeURIComponent(URL_GRUPO)}`)
  ]);
  const resultado = await serviceWorker.navegarAteGrupo(7, URL_GRUPO, 8000);
  assert.equal(resultado.ok, false);
  assert.equal(resultado.pausar, true);
  assert.equal(resultado.interromperFila, true);
  assert.match(resultado.erro, /login ou verificação de segurança/);
});

test('navegarAteGrupo avisa quando a aba de publicação foi fechada', async () => {
  prepararAbas([]);
  const resultado = await serviceWorker.navegarAteGrupo(7, URL_GRUPO, 8000);
  assert.equal(resultado.ok, false);
  assert.match(resultado.erro, /aba de publicação do Facebook foi fechada/);
});

test('ativarPublicador tenta de novo quando o Chrome recusa a injeção no meio da navegação', async () => {
  let tentativas = 0;
  execucaoScript = async () => {
    tentativas += 1;
    if (tentativas === 1) throw new Error('Cannot access contents of the page.');
  };
  prepararAbas([leitura(`${URL_GRUPO}/`), leitura(`${URL_GRUPO}/`)]);
  const resultado = await serviceWorker.ativarPublicador(7);
  assert.equal(resultado.ok, true);
  assert.equal(tentativas, 2);
});

test('ativarPublicador registra o motivo técnico quando a injeção falha de vez', async () => {
  let tentativas = 0;
  execucaoScript = async () => {
    tentativas += 1;
    throw new Error('Cannot access contents of the page.');
  };
  prepararAbas([leitura(`${URL_GRUPO}/`)]);
  const resultado = await serviceWorker.ativarPublicador(7);
  assert.equal(resultado.ok, false);
  assert.equal(tentativas, 3);
  assert.match(resultado.erro, /Não consegui ativar a publicação/);
  assert.match(resultado.erro, /Motivo técnico: Cannot access contents of the page\./);
});

test('ativarPublicador não insiste quando a aba de publicação foi fechada', async () => {
  let tentativas = 0;
  execucaoScript = async () => { tentativas += 1; };
  prepararAbas([]);
  const resultado = await serviceWorker.ativarPublicador(7);
  assert.equal(resultado.ok, false);
  assert.equal(tentativas, 0);
  assert.match(resultado.erro, /aba de publicação do Facebook foi fechada/);
});
