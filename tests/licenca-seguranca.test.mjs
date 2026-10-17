import test from 'node:test';
import assert from 'node:assert/strict';

// Segurança da licença no lado do cliente. O servidor é a fonte da verdade e o
// relógio do computador não pode esticar avaliação nem carência offline:
// - "deixar a data atrasada" anula cache e carência (só o servidor decide);
// - a publicação nunca usa carência (falha fechado sem servidor);
// - resposta de vencido (402 acesso_expirado) bloqueia e fica gravada, mesmo
//   que o estado local diga "permitido".
// O módulo real (extensao/lib/licenca.js) roda com chrome.storage e fetch
// simulados, sem tocar em rede.

let armazenado = {};

globalThis.chrome = {
  storage: {
    local: {
      get(chaves, cb) {
        const resultado = {};
        for (const chave of [].concat(chaves)) {
          if (chave in armazenado) resultado[chave] = armazenado[chave];
        }
        cb(resultado);
      },
      set(objeto, cb) {
        Object.assign(armazenado, objeto);
        if (cb) cb();
      },
      remove(chaves, cb) {
        for (const chave of [].concat(chaves)) delete armazenado[chave];
        if (cb) cb();
      }
    }
  }
};

const licenca = await import('../extensao/lib/licenca.js');

// Estado local "bonito" (como o que um cliente adulterado tentaria manter):
// token válido, acesso permitido e avaliação no futuro.
function estadoLocal(extras = {}) {
  return {
    token: 'token-de-teste',
    acesso: { permitido: true, status: 'trial' },
    licenca: { plano: 'trial', avaliacaoAte: new Date(Date.now() + 86400000).toISOString() },
    ultimaVerificacao: Date.now(),
    ...extras
  };
}

function semRede() {
  globalThis.fetch = async () => { throw new Error('sem rede'); };
}

function servidor(corpo, status = 200) {
  globalThis.fetch = async () => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => corpo
  });
}

test('carência offline vale com o relógio normal (regressão do comportamento atual)', async () => {
  armazenado = estadoLocal();
  semRede();

  const resultado = await licenca.verificarLicenca(true);
  assert.equal(resultado.permitido, true);
  assert.equal(resultado.carencia, true);
});

test('relógio atrasado anula a carência offline: rede fora bloqueia em vez de liberar', async () => {
  // O usuário atrasou o relógio; a última verificação ficou "no futuro".
  armazenado = estadoLocal({ ultimaVerificacao: Date.now() + 60 * 60 * 1000 });
  semRede();

  assert.equal(licenca.permaneceCarencia(armazenado), false);
  await assert.rejects(() => licenca.verificarLicenca(), /sem rede/);
});

test('relógio atrasado obriga consulta ao servidor mesmo com cache recente', async () => {
  armazenado = estadoLocal({ ultimaVerificacao: Date.now() + 60 * 60 * 1000 });

  let consultas = 0;
  globalThis.fetch = async () => {
    consultas += 1;
    return {
      ok: true,
      status: 200,
      json: async () => ({
        acesso: { permitido: true, status: 'trial' },
        licenca: { plano: 'trial', avaliacaoAte: new Date(Date.now() + 86400000).toISOString() }
      })
    };
  };

  const resultado = await licenca.verificarLicenca();
  assert.equal(consultas, 1, 'com relógio atrasado, o cache local não pode responder sozinho');
  assert.equal(resultado.permitido, true);
});

test('servidor vencido bloqueia mesmo com o estado local dizendo "permitido"', async () => {
  armazenado = estadoLocal();
  servidor({ erro: 'Sua avaliação ou licença venceu.', codigo: 'acesso_expirado' }, 402);

  const resultado = await licenca.verificarLicenca(true);
  assert.equal(resultado.permitido, false);
  assert.equal(resultado.status, 'expirado');
  assert.equal(armazenado.acesso.permitido, false, 'a decisão do servidor precisa ficar gravada');
});

test('caminho da publicação falha fechado sem servidor, mesmo com o relógio normal', async () => {
  // `exigirServidor = true` é o que o service worker usa antes de cada grupo:
  // carência offline nunca autoriza publicação.
  armazenado = estadoLocal();
  semRede();

  await assert.rejects(() => licenca.verificarLicenca(true, true), /sem rede/);
});

test('resposta antiga sem código de vencimento não vira permissão offline', async () => {
  armazenado = estadoLocal({ ultimaVerificacao: Date.now() - 10 * 60 * 1000 });
  globalThis.fetch = async () => ({
    ok: false,
    status: 401,
    json: async () => ({ erro: 'sessão inválida' })
  });

  const resultado = await licenca.verificarLicenca(true);
  assert.equal(resultado.permitido, false);
  assert.equal(resultado.status, 'nao_autenticado');
});
