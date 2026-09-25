'use strict';

/**
 * Testes de fumaça do Postador Pro.
 *
 * Sobe a aplicação no próprio processo, com um diretório de dados temporário,
 * e valida o contrato da API: autenticação, isolamento entre usuários, limites
 * de plano, CSRF, exposição de arquivos, fila, uploads, cobrança e admin.
 *
 * Uso: npm test
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const PORTA = Number(process.env.TEST_PORT || 3199);
const BASE = `http://127.0.0.1:${PORTA}`;
const RAIZ = path.resolve(__dirname, '..');
const DATA_DIR = path.join(os.tmpdir(), `postador-teste-${Date.now()}`);

const ADMIN_EMAIL = 'admin@postador.local';

process.env.NODE_ENV = 'test';
process.env.PORT = String(PORTA);
process.env.HOST = '127.0.0.1';
process.env.PUBLIC_BASE_URL = BASE;
process.env.DATA_DIR = DATA_DIR;
process.env.FILA_INTERVALO_SEGUNDOS = '2';
process.env.MAX_NAVEGADORES_CONCORRENTES = '1';
process.env.ADMIN_EMAILS = ADMIN_EMAIL;
process.env.EXPOSIR_LINK_REDEFINICAO = '1';
process.env.INFINITEPAY_HANDLE = '';
process.env.SMTP_HOST = '';

// A suíte cria dezenas de usuários e faz vários logins a partir do mesmo IP,
// então os limites por IP sobem. O comportamento do limitador é verificado à
// parte, num app isolado, para não deixar a suíte sem orçamento de requisições.
process.env.RATE_LIMIT_REGISTRO = '1000';
process.env.RATE_LIMIT_RECUPERAR = '1000';
process.env.RATE_LIMIT_TROCA_SENHA = '1000';
process.env.RATE_LIMIT_REDEFINIR = '1000';
process.env.RATE_LIMIT_EXCLUIR_CONTA = '1000';
process.env.RATE_LIMIT_LOGIN = '500';

const dbMod = require('../src/db');
const billing = require('../src/billing');
const queue = require('../src/queue');
const config = require('../src/config');
const cron = require('node-cron');
const { expressaoACadaMinutos } = require('../src/cron-agenda');
const { criarApp } = require('../src/app');

const { db } = dbMod;

let servidor;
let passo = 0;
let totalPassos = 0;
const falhas = [];

function log(mensagem) {
  console.log(mensagem);
}

function ok(descricao) {
  passo += 1;
  totalPassos += 1;
  log(`  ok  ${descricao}`);
}

function registrarFalha(descricao, erro) {
  totalPassos += 1;
  falhas.push({ descricao, erro: erro && erro.message ? erro.message : String(erro) });
  log(`  FALHOU  ${descricao}`);
  log(`          ${erro && erro.message ? erro.message : erro}`);
}

async function checar(descricao, fn) {
  try {
    await fn();
    ok(descricao);
  } catch (erro) {
    registrarFalha(descricao, erro);
  }
}

function afirmar(condicao, mensagem) {
  if (!condicao) throw new Error(mensagem);
}

function afirmarIgual(atual, esperado, mensagem) {
  if (atual !== esperado) {
    throw new Error(`${mensagem} (esperado: ${esperado}, recebido: ${atual})`);
  }
}

/* ------------------------------------------------------------------ *
 * Cliente HTTP com jar de cookies e token de CSRF
 * ------------------------------------------------------------------ */

function novoCliente() {
  const jar = new Map();

  return {
    jar,
    async req(metodo, rota, { body, csrf = true, headers = {}, semJar = false } = {}) {
      const finalHeaders = { ...headers };
      if (body !== undefined) finalHeaders['Content-Type'] = 'application/json';

      // O navegador envia Origin nas requisições que alteram estado; o servidor
      // usa esse cabeçalho para rejeitar chamadas de outra origem. É independente
      // do jar de cookies.
      if (metodo !== 'GET' && metodo !== 'HEAD') {
        if (!finalHeaders.Origin && !finalHeaders.origin) finalHeaders.Origin = BASE;
      }

      if (!semJar) {
        const cookies = [...jar.entries()].map(([nome, valor]) => `${nome}=${valor}`).join('; ');
        if (cookies) finalHeaders.Cookie = cookies;
        if (csrf && !finalHeaders['x-csrf-token']) {
          const token = jar.get('postador_csrf');
          if (token) finalHeaders['x-csrf-token'] = token;
        }
      }

      const resposta = await fetch(`${BASE}${rota}`, {
        method: metodo,
        headers: finalHeaders,
        body: body === undefined ? undefined : JSON.stringify(body),
        redirect: 'manual'
      });

      const lista = resposta.headers.getSetCookie ? resposta.headers.getSetCookie() : [];
      for (const cookie of lista) {
        const [par] = cookie.split(';');
        const indice = par.indexOf('=');
        const nome = par.slice(0, indice).trim();
        const valor = par.slice(indice + 1).trim();
        if (valor === '') jar.delete(nome);
        else jar.set(nome, valor);
      }

      const tipo = resposta.headers.get('content-type') || '';
      const dados = tipo.includes('application/json')
        ? await resposta.json().catch(() => ({}))
        : await resposta.text();

      return { status: resposta.status, dados, headers: resposta.headers };
    },

    async texto(rota) {
      const cookies = [...jar.entries()].map(([nome, valor]) => `${nome}=${valor}`).join('; ');
      const resposta = await fetch(`${BASE}${rota}`, { headers: { Cookie: cookies } });
      return { status: resposta.status, corpo: await resposta.text() };
    }
  };
}

function emailUnico(prefixo = 'teste') {
  return `${prefixo}-${Date.now()}-${Math.floor(Math.random() * 10000)}@postador.local`;
}

async function novoClienteComConta(nome = 'Cliente Teste', { email } = {}) {
  const cliente = novoCliente();
  await cliente.req('GET', '/api/config');

  const r = await cliente.req('POST', '/api/register', {
    body: { nome, email: email || emailUnico(), senha: 'senhaforte123' }
  });

  afirmar(r.status === 201, `cadastro falhou (${r.status}): ${JSON.stringify(r.dados)}`);
  return { cliente, user: r.dados };
}

async function criarContaFake(userId, nome = 'Conta FB') {
  const accountId = `acc-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
  await db.accounts.insert({ _id: accountId, userId, nome, conectada: true, criadoEm: new Date() });
  return accountId;
}

function daqui(horas = 2) {
  return new Date(Date.now() + horas * 3600000).toISOString();
}

const PNG_1PX =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

/* ------------------------------------------------------------------ *
 * Suíte
 * ------------------------------------------------------------------ */

async function suite() {
  log('\n== Agendamentos ==');

  await checar('gera expressões de cron aceitas pelo node-cron', async () => {
    for (const minutos of [1, 5, 15, 30, 45, 60, 90, 120, 360, 720, 1440]) {
      const expressao = expressaoACadaMinutos(minutos);
      afirmar(
        cron.validate(expressao),
        `${minutos} min virou "${expressao}", que o node-cron não aceita`
      );
    }
  });

  await checar('a expression de 6 horas é válida (o bug do */360)', async () => {
    // `*/360 * * * *` nunca casa com nada: o backup simplesmente não rodava.
    const expressao = expressaoACadaMinutos(360);
    afirmar(expressao === '0 */6 * * *', `expressão inesperada: ${expressao}`);
    afirmar(cron.validate(expressao), 'node-cron recusou a expressão de 6 horas');
  });

  await checar('o padrão de backup do app vira uma expressão válida', async () => {
    for (const [nome, minutos] of [
      ['BACKUP_MINUTOS', config.BACKUP_MINUTOS],
      ['COMPACTACAO_MINUTOS', config.COMPACTACAO_MINUTOS]
    ]) {
      afirmar(
        cron.validate(expressaoACadaMinutos(minutos)),
        `${nome}=${minutos} não gera uma expressão válida`
      );
    }
  });

  await checar('recusa intervalo de manutenção impossível', async () => {
    for (const invalido of [0, -10, 1441, 99999, 'abc']) {
      let lancou = false;
      try {
        expressaoACadaMinutos(invalido);
      } catch (erro) {
        lancou = erro instanceof RangeError;
      }
      afirmar(lancou, `aceitou intervalo inválido: ${invalido}`);
    }
  });

  log('\n== Exposição de arquivos ==');

  await checar('não serve sessions.db', async () => {
    const r = await fetch(`${BASE}/sessions.db`);
    afirmar(r.status === 404, `respondeu ${r.status}`);
  });

  await checar('não serve users.db', async () => {
    const r = await fetch(`${BASE}/users.db`);
    afirmar(r.status === 404, `respondeu ${r.status}`);
  });

  await checar('não serve o código-fonte', async () => {
    const r = await fetch(`${BASE}/server.js`);
    afirmar(r.status === 404, `respondeu ${r.status}`);
  });

  await checar('não serve o package.json', async () => {
    const r = await fetch(`${BASE}/package.json`);
    afirmar(r.status === 404, `respondeu ${r.status}`);
  });

  await checar('não serve o .env', async () => {
    const r = await fetch(`${BASE}/.env`);
    afirmar(r.status === 404, `respondeu ${r.status}`);
  });

  await checar('não serve o diretório de dados', async () => {
    for (const alvo of ['/data/', '/data/users.db', '/facebook-profiles/', '/data/facebook-profiles/']) {
      const r = await fetch(`${BASE}${alvo}`);
      afirmar(r.status === 404, `${alvo} respondeu ${r.status}`);
    }
  });

  await checar('serve a interface em /', async () => {
    const r = await fetch(`${BASE}/`);
    const corpo = await r.text();
    afirmar(r.status === 200, `respondeu ${r.status}`);
    afirmar(corpo.includes('POSTADOR'), 'interface sem a marca do produto');
  });

  await checar('envolve tudo com CSP estrita para scripts', async () => {
    const r = await fetch(`${BASE}/`);
    const csp = r.headers.get('content-security-policy') || '';

    afirmar(csp.includes("default-src 'self'"), 'CSP sem default-src self');
    afirmar(csp.includes("object-src 'none'"), 'CSP permite object-src');
    afirmar(csp.includes("frame-ancestors 'none'"), 'CSP permite frame-ancestors');
    afirmar(csp.includes("base-uri 'none'"), 'CSP permite base-uri');

    // O que realmente protege contra XSS é o script-src: estilo inline é
    // liberado de propósito porque a interface usa atributo `style`.
    const scriptSrc = (csp.match(/script-src [^;]*/) || [''])[0];
    afirmar(scriptSrc === "script-src 'self'", `script-src inesperado: ${scriptSrc}`);

    afirmar(r.headers.get('x-content-type-options') === 'nosniff', 'sem nosniff');
    afirmar(r.headers.get('referrer-policy'), 'sem Referrer-Policy');
    afirmar(r.headers.get('x-frame-options'), 'sem X-Frame-Options');
  });

  await checar('a interface não tem script nem style inline', async () => {
    const corpo = await (await fetch(`${BASE}/`)).text();
    afirmar(!/<script[^>]*>[\s\S]*?\S[\s\S]*?<\/script>/.test(corpo), 'há script inline no HTML');
    afirmar(!/<style[\s\S]*\S[\s\S]*<\/style>/.test(corpo), 'há style inline no HTML');
  });

  log('\n== Proteção de requisições ==');
  // O teste de limite de login fica no fim da suíte: ele esgota o orçamento de
  // tentativas por IP e, se rodar antes, bloquearia os logins dos testes
  // seguintes.

  await checar('bloqueia POST sem cookie de CSRF', async () => {
    const r = await fetch(`${BASE}/api/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: BASE },
      body: JSON.stringify({ nome: 'X', email: emailUnico('csrf'), senha: 'senhaforte123' })
    });
    afirmar(r.status === 403, `respondeu ${r.status}`);
  });

  await checar('bloqueia POST de origem externa', async () => {
    const cliente = novoCliente();
    await cliente.req('GET', '/api/config');
    const r = await cliente.req('POST', '/api/register', {
      body: { nome: 'X', email: emailUnico('origem'), senha: 'senhaforte123' },
      headers: { Origin: 'https://malicioso.example' }
    });
    afirmar(r.status === 403, `respondeu ${r.status}`);
  });

  await checar('bloqueia POST com token de CSRF errado', async () => {
    const cliente = novoCliente();
    await cliente.req('GET', '/api/config');
    const r = await cliente.req('POST', '/api/register', {
      body: { nome: 'X', email: emailUnico('token'), senha: 'senhaforte123' },
      headers: { 'x-csrf-token': 'token-falso' }
    });
    afirmar(r.status === 403, `respondeu ${r.status}`);
  });

  log('\n== Credenciais ==');

  await checar('guarda a senha como hash bcrypt', async () => {
    const { user } = await novoClienteComConta('Hash');
    const salvo = await db.users.findOne({ _id: user.id });
    afirmar(String(salvo.senhaHash).startsWith('$2'), 'hash fora do formato bcrypt');
    afirmar(!salvo.senhaHash.includes('senhaforte123'), 'senha em texto puro no banco');
  });

  await checar('guarda o token de sessão só como resumo', async () => {
    const { cliente, user } = await novoClienteComConta('Sessao');
    const sessoes = await db.sessions.find({ userId: user.id });
    afirmar(sessoes.length === 1, `esperava 1 sessão, vieram ${sessoes.length}`);
    afirmar(!sessoes[0].token, 'token de sessão está em texto puro no banco');
    afirmar(String(sessoes[0].tokenHash).length === 64, 'hash da sessão fora do tamanho esperado');

    const cookie = cliente.jar.get('postador_session');
    afirmar(cookie, 'cookie de sessão não foi emitido');
    afirmar(sessoes[0].tokenHash !== cookie, 'o cookie traz o mesmo valor guardado no banco');
    afirmar(
      require('crypto').createHash('sha256').update(cookie).digest('hex') === sessoes[0].tokenHash,
      'o hash guardado não corresponde ao cookie emitido'
    );
  });

  await checar('limita sessões por conta', async () => {
    const email = emailUnico('sessoes');
    const { user } = await novoClienteComConta('Multi', { email });
    for (let i = 0; i < 7; i++) {
      const cliente = novoCliente();
      await cliente.req('GET', '/api/config');
      await cliente.req('POST', '/api/login', { body: { email, senha: 'senhaforte123' } });
    }
    const total = await db.sessions.count({ userId: user.id });
    afirmar(total <= 5, `esperava no máximo 5 sessões, existem ${total}`);
  });

  log('\n== Cadastro, login e recuperação ==');

  await checar('cadastra com 7 dias de avaliação', async () => {
    const { user } = await novoClienteComConta('Avaliacao');
    afirmarIgual(user.statusPagamento, 'trial', 'status inicial errado');
    const dias = Math.round((new Date(user.trialFim) - Date.now()) / 86400000);
    afirmar(dias === 7, `esperava 7 dias de avaliação, veio ${dias}`);
    afirmar(user.limites.contas === 1, 'limite de contas do trial errado');
    afirmar(user.limites.campanhasAtivas === 3, 'limite de campanhas do trial errado');
  });

  await checar('recusa senha com menos de 8 caracteres', async () => {
    const cliente = novoCliente();
    await cliente.req('GET', '/api/config');
    const r = await cliente.req('POST', '/api/register', {
      body: { nome: 'Curto', email: emailUnico(), senha: '1234567' }
    });
    afirmar(r.status === 400, `respondeu ${r.status}`);
  });

  await checar('recusa e-mail inválido', async () => {
    const cliente = novoCliente();
    await cliente.req('GET', '/api/config');
    const r = await cliente.req('POST', '/api/register', {
      body: { nome: 'Ruim', email: 'nao-e-email', senha: 'senhaforte123' }
    });
    afirmar(r.status === 400, `respondeu ${r.status}`);
  });

  await checar('recusa e-mail duplicado', async () => {
    const email = emailUnico('dup');
    const cliente = novoCliente();
    await cliente.req('GET', '/api/config');
    const primeiro = await cliente.req('POST', '/api/register', {
      body: { nome: 'Primeira Conta', email, senha: 'senhaforte123' }
    });
    afirmar(primeiro.status === 201, `primeiro cadastro respondeu ${primeiro.status}`);

    const r = await cliente.req('POST', '/api/register', {
      body: { nome: 'Segunda Conta', email, senha: 'senhaforte123' }
    });
    afirmar(r.status === 409, `respondeu ${r.status}`);
  });

  await checar('faz e desfaz login', async () => {
    const email = emailUnico('login');
    const { cliente } = await novoClienteComConta('Login', { email });

    const me = await cliente.req('GET', '/api/me');
    afirmar(me.status === 200, 'sessão não reconhecida');

    await cliente.req('POST', '/api/logout', { body: {} });
    const depois = await cliente.req('GET', '/api/me');
    afirmar(depois.status === 401, `esperava 401 após logout, veio ${depois.status}`);
  });

  await checar('recusa senha errada com a mesma mensagem de e-mail inexistente', async () => {
    const email = emailUnico('errada');
    const cliente = novoCliente();
    await cliente.req('GET', '/api/config');
    await cliente.req('POST', '/api/register', { body: { nome: 'E', email, senha: 'senhaforte123' } });

    const errada = await cliente.req('POST', '/api/login', { body: { email, senha: 'outrasenha1' } });
    const inexistente = await cliente.req('POST', '/api/login', { body: { email: emailUnico('sumiu'), senha: 'outrasenha1' } });
    afirmar(errada.dados.erro === inexistente.dados.erro, 'a resposta revela se o e-mail existe');
  });

  await checar('recuperação de senha não revela se o e-mail existe', async () => {
    const cliente = novoCliente();
    await cliente.req('GET', '/api/config');
    const r = await cliente.req('POST', '/api/recuperar-senha', { body: { email: 'fantasma@postador.local' } });
    afirmar(r.status === 200, `respondeu ${r.status}`);
    afirmar(!r.dados.erro, 'respondeu com erro para e-mail inexistente');
  });

  await checar('redefine a senha e derruba as sessões', async () => {
    const email = emailUnico('reset');
    const { cliente } = await novoClienteComConta('Reset', { email });

    const pedido = await cliente.req('POST', '/api/recuperar-senha', { body: { email } });
    const link = pedido.dados.linkDev;
    afirmar(link, 'sem SMTP o link deve vir em linkDev para desenvolvimento');

    const token = new URL(link).searchParams.get('token');

    // O fluxo real: a pessoa abre o link do e-mail numa janela anônima. A página
    // `/redefinir` entrega o cookie de CSRF e só então o POST é aceito.
    const anonimo = novoCliente();
    const pagina = await anonimo.req('GET', `/redefinir?token=${token}`);
    afirmar(pagina.status === 200, `a página de redefinição respondeu ${pagina.status}`);
    afirmar(anonimo.jar.get('postador_csrf'), 'a página de redefinição não entregou o token de CSRF');

    const redefinir = await anonimo.req('POST', '/api/redefinir-senha', {
      body: { token, novaSenha: 'novasenha456' }
    });
    afirmar(redefinir.status === 200, `esperava 200, veio ${redefinir.status}: ${JSON.stringify(redefinir.dados)}`);

    const antiga = await cliente.req('GET', '/api/me');
    afirmar(antiga.status === 401, 'a sessão antiga continuou válida');

    const novo = novoCliente();
    await novo.req('GET', '/api/config');
    const login = await novo.req('POST', '/api/login', { body: { email, senha: 'novasenha456' } });
    afirmar(login.status === 200, 'não conseguiu entrar com a senha nova');

    const reutilizar = await novo.req('POST', '/api/redefinir-senha', { body: { token, novaSenha: 'outrasenha789' } });
    afirmar(reutilizar.status === 400, 'aceitou reutilizar o mesmo token');
  });

  await checar('recusa token de redefinição expirado', async () => {
    const email = emailUnico('expirado');
    const { cliente } = await novoClienteComConta('Expirado', { email });
    const pedido = await cliente.req('POST', '/api/recuperar-senha', { body: { email } });
    const token = new URL(pedido.dados.linkDev).searchParams.get('token');

    await db.resets.update({ tokenHash: require('crypto').createHash('sha256').update(token).digest('hex') }, { $set: { expiraEm: new Date(Date.now() - 1000) } });

    const r = await cliente.req('POST', '/api/redefinir-senha', { body: { token, novaSenha: 'novasenha456' } });
    afirmar(r.status === 400, `respondeu ${r.status}`);
  });

  log('\n== Limites de plano e expiração ==');

  await checar('bloqueia campanha acima do limite de destinos do trial', async () => {
    const { cliente, user } = await novoClienteComConta('Limite');
    const accountId = await criarContaFake(user.id);

    const destinos = Array.from({ length: 21 }, (_, i) => `https://facebook.com/groups/g${i}`);
    const r = await cliente.req('POST', '/api/campaigns', {
      body: { nome: 'Grande', accountId, destinos, textos: ['oi'], imagens: [], dataExecucao: daqui() }
    });
    afirmar(r.status === 403, `esperava 403, veio ${r.status}: ${JSON.stringify(r.dados)}`);
  });

  await checar('bloqueia excesso de campanhas ativas no trial', async () => {
    const { cliente, user } = await novoClienteComConta('Ativas');
    const accountId = await criarContaFake(user.id);

    for (let i = 0; i < 3; i++) {
      const r = await cliente.req('POST', '/api/campaigns', {
        body: { nome: `Ativa ${i}`, accountId, destinos: ['https://facebook.com/groups/x'], textos: ['oi'], imagens: [], dataExecucao: daqui() }
      });
      afirmar(r.status === 201, `campanha ${i} falhou: ${JSON.stringify(r.dados)}`);
    }

    const extra = await cliente.req('POST', '/api/campaigns', {
      body: { nome: 'Extra', accountId, destinos: ['https://facebook.com/groups/x'], textos: ['oi'], imagens: [], dataExecucao: daqui() }
    });
    afirmar(extra.status === 403, `esperava 403, veio ${extra.status}`);
  });

  await checar('recusa destino fora do Facebook', async () => {
    const { cliente, user } = await novoClienteComConta('Destino');
    const accountId = await criarContaFake(user.id);

    const r = await cliente.req('POST', '/api/campaigns', {
      body: {
        nome: 'Ruim',
        accountId,
        destinos: ['https://exemplo-malicioso.example/grupo'],
        textos: ['oi'],
        imagens: [],
        dataExecucao: daqui()
      }
    });
    afirmar(r.status === 400, `respondeu ${r.status}`);
  });

  await checar('recusa agendamento no passado', async () => {
    const { cliente, user } = await novoClienteComConta('Passado');
    const accountId = await criarContaFake(user.id);

    const r = await cliente.req('POST', '/api/campaigns', {
      body: {
        nome: 'Passado',
        accountId,
        destinos: ['https://facebook.com/groups/x'],
        textos: ['oi'],
        imagens: [],
        dataExecucao: new Date(Date.now() - 3600000).toISOString()
      }
    });
    afirmar(r.status === 400, `respondeu ${r.status}`);
  });

  await checar('recusa conta do Facebook de outro usuário', async () => {
    const { user } = await novoClienteComConta('Dono');
    const intruso = await novoClienteComConta('Intruso');
    const contaDoDono = await criarContaFake(user.id);

    const criar = await intruso.cliente.req('POST', '/api/campaigns', {
      body: {
        nome: 'Invasão',
        accountId: contaDoDono,
        destinos: ['https://facebook.com/groups/x'],
        textos: ['oi'],
        imagens: [],
        dataExecucao: daqui()
      }
    });
    afirmar(criar.status === 404, `esperava 404, veio ${criar.status}`);
  });

  await checar('expira o acesso quando a avaliação termina', async () => {
    const { cliente, user } = await novoClienteComConta('Expirado');
    await db.users.update({ _id: user.id }, { $set: { trialFim: new Date(Date.now() - 1000) } });

    const dash = await cliente.req('GET', '/api/dashboard');
    afirmar(dash.status === 402, `dashboard deveria responder 402, veio ${dash.status}`);

    const sub = await cliente.req('GET', '/api/subscription');
    afirmarIgual(sub.dados.status, 'expirado', 'status de acesso errado');
  });

  await checar('usuário pro vê os limites do plano pago', async () => {
    const { cliente, user } = await novoClienteComConta('Pro');
    await db.users.update(
      { _id: user.id },
      { $set: { plano: 'pro', tipoPlano: 'monthly', dataExpiracao: new Date(Date.now() + 30 * 86400000) } }
    );

    const me = await cliente.req('GET', '/api/me');
    afirmarIgual(me.dados.statusPagamento, 'pro', 'status pro errado');
    afirmarIgual(me.dados.limites.contas, 10, 'limite de contas do pro errado');
    afirmarIgual(me.dados.limites.destinosPorCampanha, 100, 'limite de destinos do pro errado');
  });

  log('\n== Campanhas ==');

  await checar('cria campanha e gera um destino por grupo, sem repetir', async () => {
    const { cliente, user } = await novoClienteComConta('Cria');
    const accountId = await criarContaFake(user.id);

    const r = await cliente.req('POST', '/api/campaigns', {
      body: {
        nome: 'Válida',
        accountId,
        destinos: ['https://facebook.com/groups/a', 'https://facebook.com/groups/b', 'https://facebook.com/groups/a'],
        textos: ['um', 'dois'],
        imagens: [],
        dataExecucao: daqui()
      }
    });

    afirmar(r.status === 201, `esperava 201, veio ${r.status}: ${JSON.stringify(r.dados)}`);
    afirmarIgual(r.dados.destinos, 2, 'destino repetido não foi eliminado');

    const posts = await db.posts.find({ userId: user.id });
    afirmarIgual(posts.length, 2, 'fila não criou um item por destino');

    const lista = await cliente.req('GET', '/api/campaigns');
    afirmarIgual(lista.dados.campanhas[0].status, 'pendente', 'status inicial errado');
    afirmar(lista.dados.campanhas[0].listaDestinos.length === 2, 'lista de destinos incorreta');
  });

  await checar('edita campanha pendente e recria os destinos', async () => {
    const { cliente, user } = await novoClienteComConta('Edita');
    const accountId = await criarContaFake(user.id);

    const criada = await cliente.req('POST', '/api/campaigns', {
      body: { nome: 'Antes', accountId, destinos: ['https://facebook.com/groups/a'], textos: ['um'], imagens: [], dataExecucao: daqui() }
    });

    const r = await cliente.req('PUT', `/api/campaigns/${criada.dados.id}`, {
      body: {
        nome: 'Depois',
        accountId,
        destinos: ['https://facebook.com/groups/c', 'https://facebook.com/groups/d'],
        textos: ['dois'],
        imagens: [],
        dataExecucao: daqui()
      }
    });

    afirmar(r.status === 200, `esperava 200, veio ${r.status}: ${JSON.stringify(r.dados)}`);

    const posts = await db.posts.find({ userId: user.id });
    afirmarIgual(posts.length, 2, 'destinos não foram recriados');
    afirmar(posts.every(p => p.campanhaNome === 'Depois'), 'posts continuam com o nome antigo');
  });

  await checar('não edita campanha já executada', async () => {
    const { cliente, user } = await novoClienteComConta('Travada');
    const accountId = await criarContaFake(user.id);

    const criada = await cliente.req('POST', '/api/campaigns', {
      body: { nome: 'Travada', accountId, destinos: ['https://facebook.com/groups/a'], textos: ['um'], imagens: [], dataExecucao: daqui() }
    });

    await db.campaigns.update({ _id: criada.dados.id }, { $set: { status: 'concluido' } });

    const r = await cliente.req('PUT', `/api/campaigns/${criada.dados.id}`, {
      body: { nome: 'Mudou', accountId, destinos: ['https://facebook.com/groups/z'], textos: ['um'], imagens: [], dataExecucao: daqui() }
    });
    afirmar(r.status === 400, `esperava 400, veio ${r.status}`);
  });

  await checar('cancela campanha e cancela os destinos pendentes', async () => {
    const { cliente, user } = await novoClienteComConta('Cancela');
    const accountId = await criarContaFake(user.id);

    const criada = await cliente.req('POST', '/api/campaigns', {
      body: { nome: 'Cancelar', accountId, destinos: ['https://facebook.com/groups/a', 'https://facebook.com/groups/b'], textos: ['um'], imagens: [], dataExecucao: daqui() }
    });

    const r = await cliente.req('POST', `/api/campaigns/${criada.dados.id}/cancel`, { body: {} });
    afirmar(r.status === 200, `veio ${r.status}`);

    const posts = await db.posts.find({ userId: user.id });
    afirmar(posts.every(p => p.status === 'cancelado'), 'destinos ficaram pendentes');
    afirmarPosts(posts, 'cancelado');
  });

  await checar('reprocessa apenas destinos com falha', async () => {
    const { cliente, user } = await novoClienteComConta('Reprocessa');
    const accountId = await criarContaFake(user.id);

    const criada = await cliente.req('POST', '/api/campaigns', {
      body: { nome: 'Reprocessar', accountId, destinos: ['https://facebook.com/groups/a', 'https://facebook.com/groups/b'], textos: ['um'], imagens: [], dataExecucao: daqui() }
    });

    await db.posts.update({ userId: user.id }, { $set: { status: 'concluido' } });
    await db.posts.update({ userId: user.id, grupoUrl: 'https://facebook.com/groups/b' }, { $set: { status: 'falhou', motivo: 'erro' } });

    const r = await cliente.req('POST', `/api/campaigns/${criada.dados.id}/retry`, { body: {} });
    afirmar(r.status === 200, `veio ${r.status}`);
    afirmarIgual(r.dados.reenviados, 1, 'reenviou destinos que já tinham sido publicados');

    const posts = await db.posts.find({ userId: user.id });
    const republicado = posts.find(p => p.grupoUrl === 'https://facebook.com/groups/a');
    afirmarIgual(republicado.status, 'concluido', 'publicação concluída foi sobrescrita');
  });

  await checar('exclui campanha e remove destinos e imagens', async () => {
    const { cliente, user } = await novoClienteComConta('Exclui');
    const accountId = await criarContaFake(user.id);

    const up = await cliente.req('POST', '/api/uploads', { body: { data: `data:image/png;base64,${PNG_1PX}` } });
    afirmar(up.status === 201, `upload falhou: ${JSON.stringify(up.dados)}`);

    const criada = await cliente.req('POST', '/api/campaigns', {
      body: {
        nome: 'Excluir',
        accountId,
        destinos: ['https://facebook.com/groups/a'],
        textos: ['um'],
        imagens: [up.dados.nome],
        dataExecucao: daqui()
      }
    });

    const r = await cliente.req('DELETE', `/api/campaigns/${criada.dados.id}`);
    afirmar(r.status === 200, `veio ${r.status}`);
    afirmarIgual((await db.campaigns.find({ userId: user.id })).length, 0, 'campanha sobrou');
    afirmarIgual((await db.posts.find({ userId: user.id })).length, 0, 'destinos sobraram');
  });

  await checar('isola campanhas entre usuários', async () => {
    const dono = await novoClienteComConta('Dono');
    const intruso = await novoClienteComConta('Intruso');
    const accountId = await criarContaFake(dono.user.id);

    const criada = await dono.cliente.req('POST', '/api/campaigns', {
      body: { nome: 'Privada', accountId, destinos: ['https://facebook.com/groups/a'], textos: ['um'], imagens: [], dataExecucao: daqui() }
    });

    const ver = await intruso.cliente.req('GET', `/api/campaigns/${criada.dados.id}`);
    afirmar(ver.status === 404, `esperava 404, veio ${ver.status}`);

    const apagar = await intruso.cliente.req('DELETE', `/api/campaigns/${criada.dados.id}`);
    afirmar(apagar.status === 404, `esperava 404 no delete, veio ${apagar.status}`);

    const lista = await intruso.cliente.req('GET', '/api/campaigns');
    afirmar(lista.dados.campanhas.every(c => c.id !== criada.dados.id), 'vazou campanha na lista');
  });

  log('\n== Contas do Facebook ==');

  await checar('aplica o limite de contas do plano', async () => {
    const { cliente, user } = await novoClienteComConta('Contas');
    await criarContaFake(user.id, 'Conta 1');

    const r = await cliente.req('POST', '/api/facebook/accounts', { body: { nome: 'Conta 2' } });
    afirmar(r.status === 403, `esperava 403 no trial com 1 conta, veio ${r.status}`);
  });

  await checar('renomeia a conta e propaga para o histórico', async () => {
    const { cliente, user } = await novoClienteComConta('Renomeia');
    const accountId = await criarContaFake(user.id, 'Nome Antigo');

    const criada = await cliente.req('POST', '/api/campaigns', {
      body: { nome: 'Com conta', accountId, destinos: ['https://facebook.com/groups/a'], textos: ['um'], imagens: [], dataExecucao: daqui() }
    });
    afirmar(criada.status === 201, 'campanha não criada');

    const r = await cliente.req('PATCH', `/api/facebook/accounts/${accountId}`, { body: { nome: 'Nome Novo' } });
    afirmar(r.status === 200, `veio ${r.status}: ${JSON.stringify(r.dados)}`);

    const campanha = await db.campaigns.findOne({ _id: criada.dados.id });
    afirmarIgual(campanha.perfilId, 'Nome Novo', 'campanha ficou com o nome antigo');
    const post = await db.posts.findOne({ userId: user.id });
    afirmarIgual(post.perfilId, 'Nome Novo', 'histórico ficou com o nome antigo');
  });

  await checar('não deixa desconectar conta com campanha ativa', async () => {
    const { cliente, user } = await novoClienteComConta('Desconecta');
    const accountId = await criarContaFake(user.id);

    await cliente.req('POST', '/api/campaigns', {
      body: { nome: 'Ativa', accountId, destinos: ['https://facebook.com/groups/a'], textos: ['um'], imagens: [], dataExecucao: daqui() }
    });

    const r = await cliente.req('DELETE', `/api/facebook/accounts/${accountId}`);
    afirmar(r.status === 400, `esperava 400, veio ${r.status}`);
  });

  log('\n== Uploads ==');

  await checar('recusa arquivo disfarçado de imagem', async () => {
    const { cliente } = await novoClienteComConta('Falso');
    const r = await cliente.req('POST', '/api/uploads', { body: { data: 'data:image/png;base64,aGVsbG8gd29ybGQ=' } });
    afirmar(r.status === 400, `esperava 400, veio ${r.status}`);
  });

  await checar('salva imagem válida e protege o acesso de terceiros', async () => {
    const dono = await novoClienteComConta('DonoImg');
    const outro = await novoClienteComConta('OutroImg');

    const up = await dono.cliente.req('POST', '/api/uploads', { body: { data: `data:image/png;base64,${PNG_1PX}` } });
    afirmar(up.status === 201, `esperava 201, veio ${up.status}: ${JSON.stringify(up.dados)}`);

    const url = up.dados.url;
    afirmar(url.startsWith('/api/uploads/'), 'URL de upload inesperada');

    const donoAcessa = await dono.cliente.texto(url);
    afirmar(donoAcessa.status === 200, `dono recebeu ${donoAcessa.status}`);

    const terceiro = await outro.cliente.texto(url);
    afirmar(terceiro.status === 403, `terceiro recebeu ${terceiro.status}`);

    const anonimo = await fetch(`${BASE}${url}`);
    afirmar(anonimo.status === 401, `anônimo recebeu ${anonimo.status}`);
  });

  await checar('impede travessia de caminho na leitura de upload', async () => {
    const dono = await novoClienteComConta('Travessia');
    for (const tentativa of ['..%2F..%2Fpackage.json', '..%2Fusers.db', 'package.json']) {
      const r = await dono.cliente.texto(`/api/uploads/${tentativa}`);
      afirmar(r.status === 404 || r.status === 403, `${tentativa} respondeu ${r.status}`);
    }
  });

  log('\n== Histórico ==');

  await checar('pagina, filtra e exporta o histórico', async () => {
    const { cliente, user } = await novoClienteComConta('Historico');

    const campanhaId = `camp-${Date.now()}`;
    for (let i = 0; i < 7; i++) {
      await db.posts.insert({
        _id: `post-${Date.now()}-${i}-${Math.random()}`,
        userId: user.id,
        campanhaId,
        campanhaNome: 'Histórico',
        perfilId: 'Conta',
        accountId: `acc-${i}`,
        profileDir: 'x',
        grupoUrl: `https://facebook.com/groups/g${i}`,
        textos: ['t'],
        imagens: [],
        dataExecucao: new Date(),
        status: i % 2 ? 'concluido' : 'falhou',
        tentativas: 1,
        criadoEm: new Date()
      });
    }

    const pagina1 = await cliente.req('GET', '/api/history?page=1&perPage=3');
    afirmarIgual(pagina1.dados.posts.length, 3, 'tamanho de página errado');
    afirmarIgual(pagina1.dados.total, 7, 'total errado');
    afirmarIgual(pagina1.dados.totalPages, 3, 'total de páginas errado');

    const filtrado = await cliente.req('GET', '/api/history?status=falhou');
    afirmar(filtrado.dados.posts.length === 4, `filtro de status não filtrou (${filtrado.dados.posts.length})`);
    afirmar(filtrado.dados.posts.every(p => p.status === 'falhou'), 'filtro trouxe status errado');

    const porConta = await cliente.req('GET', '/api/history?accountId=acc-1');
    afirmarIgual(porConta.dados.posts.length, 1, 'filtro por conta não filtrou');

    const csv = await cliente.texto('/api/history/export.csv');
    afirmar(csv.status === 200, `CSV respondeu ${csv.status}`);
    afirmar(csv.corpo.includes('Destino'), 'CSV sem cabeçalho');
    afirmar(csv.corpo.split('\r\n').length >= 8, 'CSV sem todas as linhas');
  });

  log('\n== Fila de publicação ==');

  await checar('não publica nada de usuário sem acesso', async () => {
    const { user } = await novoClienteComConta('SemAcesso');
    const accountId = await criarContaFake(user.id);

    await db.users.update({ _id: user.id }, { $set: { trialFim: new Date(Date.now() - 1000) } });

    await db.posts.insert({
      _id: `post-expirado-${Date.now()}`,
      userId: user.id,
      campanhaId: `camp-${Date.now()}`,
      campanhaNome: 'Expirada',
      perfilId: 'Conta',
      accountId,
      profileDir: 'x',
      grupoUrl: 'https://facebook.com/groups/a',
      textos: ['t'],
      imagens: [],
      dataExecucao: new Date(Date.now() - 1000),
      status: 'pendente',
      tentativas: 0,
      criadoEm: new Date()
    });

    await queue.processar();
    await new Promise(resolve => setTimeout(resolve, 300));

    const post = await db.posts.findOne({ userId: user.id });
    afirmar(post.status === 'interrompido', `esperava interrompido, veio ${post.status}`);
  });

  await checar('publicação em processing vira interrompida na recuperação', async () => {
    const id = `post-orfa-${Date.now()}`;
    await db.posts.insert({
      _id: id,
      userId: 'fantasma',
      campanhaId: `camp-orfa-${Date.now()}`,
      campanhaNome: 'Órfã',
      perfilId: 'Conta',
      accountId: 'acc',
      profileDir: 'x',
      grupoUrl: 'https://facebook.com/groups/a',
      textos: ['t'],
      imagens: [],
      dataExecucao: new Date(),
      status: 'processando',
      tentativas: 1,
      criadoEm: new Date()
    });

    await queue.recuperarNoBoot();

    const orfa = await db.posts.findOne({ _id: id });
    afirmarIgual(orfa.status, 'interrompido', 'a órfã não foi marcada como interrompida');
    afirmar(/reinício|Reprocessar/.test(orfa.motivo || ''), 'motivo não orienta o usuário');
  });

  await checar('não reexecuta a mesma publicação em paralelo', async () => {
    const { user } = await novoClienteComConta('Paralelo');
    const accountId = await criarContaFake(user.id);
    const campanhaId = `camp-${Date.now()}`;

    for (let i = 0; i < 3; i++) {
      await db.posts.insert({
        _id: `post-par-${Date.now()}-${i}`,
        userId: user.id,
        campanhaId,
        campanhaNome: 'Paralela',
        perfilId: 'Conta',
        accountId,
        profileDir: 'x',
        grupoUrl: `https://facebook.com/groups/g${i}`,
        textos: ['t'],
        imagens: [],
        dataExecucao: new Date(Date.now() - 60000),
        status: 'pendente',
        tentativas: 0,
        criadoEm: new Date()
      });
    }

    // Neste ambiente não há Chrome, então o executor falha e a fila agenda a
    // retentativa. O que importa aqui é a atomicidade do grupo: os três
    // destinos são tratados como uma execução só, cada um é tentado uma única
    // vez e nenhum fica preso em "processando".
    await queue.processar();

    const inicio = Date.now();
    let posts = [];
    let processando = true;

    while (Date.now() - inicio < 30000) {
      posts = await db.posts.find({ userId: user.id, campanhaId });
      processando = posts.some(p => p.status === queue.STATUS.PROCESSANDO);
      if (!processando && posts.length === 3) break;
      await new Promise(resolve => setTimeout(resolve, 250));
    }

    afirmar(posts.length === 3, `destinos sumiram da fila (${posts.length})`);
    afirmar(!processando, 'o grupo ficou preso em processando');

    const estados = new Set(posts.map(p => p.status));
    afirmar(estados.size === 1, `destinos do mesmo grupo ficaram com estados diferentes: ${[...estados].join(', ')}`);

    const tentativas = posts.map(p => p.tentativas || 0);
    afirmar(
      tentativas.every(t => t === 1),
      `cada destino deveria ter sido tentado uma vez, vieram ${tentativas.join(', ')}`
    );

    const agendamentos = posts.map(p => p.proximaTentativaEm);
    if (posts.every(p => p.status === queue.STATUS.PENDENTE)) {
      // O grupo inteiro foi reagendado para o futuro. O jitter existe de
      // propósito, então os horários não são idênticos.
      afirmar(
        agendamentos.every(a => a && new Date(a) > new Date()),
        `nem todo o grupo foi reagendado: ${JSON.stringify(agendamentos)}`
      );
    }
  });

  await checar('respeita o intervalo mínimo de agendamento', async () => {
    const { cliente, user } = await novoClienteComConta('Intervalo');
    const accountId = await criarContaFake(user.id);

    const r = await cliente.req('POST', '/api/campaigns', {
      body: {
        nome: 'Imediata',
        accountId,
        destinos: ['https://facebook.com/groups/a'],
        textos: ['um'],
        imagens: [],
        dataExecucao: new Date(Date.now() + 30000).toISOString()
      }
    });
    afirmar(r.status === 400, `esperava 400 para agendamento em 30s, veio ${r.status}`);
  });

  log('\n== Cobrança ==');

  await checar('recusa plano inexistente', async () => {
    const { cliente } = await novoClienteComConta('Plano');
    const r = await cliente.req('POST', '/api/billing/checkout', { body: { plano: 'trimestral' } });
    afirmar(r.status === 400, `veio ${r.status}`);
  });

  await checar('recusa checkout sem a InfinitePay configurada', async () => {
    const { cliente } = await novoClienteComConta('SemPay');
    const r = await cliente.req('POST', '/api/billing/checkout', { body: { plano: 'monthly' } });
    afirmar(r.status === 500, `esperava 500 sem handle, veio ${r.status}`);
  });

  await checar('recusa pagamento com valor divergente', async () => {
    const userId = `user-cob-${Date.now()}`;
    await db.users.insert({
      _id: userId,
      nome: 'Comprador',
      email: emailUnico('cob'),
      senhaHash: 'x',
      plano: 'trial',
      trialFim: new Date(Date.now() + 86400000)
    });

    const order_nsu = `ord-${Date.now()}`;
    await db.payments.insert({
      _id: `pay-${Date.now()}`,
      order_nsu,
      userId,
      plan: 'monthly',
      amount: 2500,
      status: 'pending',
      criadoEm: new Date()
    });

    const r = await billing.webhook({ order_nsu, transaction_nsu: 'tx', invoice_slug: 'sl', amount: 1 });
    afirmar(r.status === 400, `esperava 400, veio ${r.status}`);

    const user = await db.users.findOne({ _id: userId });
    afirmarIgual(user.plano, 'trial', 'liberou acesso com pagamento inválido');

    const semPedido = await billing.webhook({ order_nsu: 'inexistente', transaction_nsu: 't', invoice_slug: 's', amount: 2500 });
    afirmar(semPedido.status === 400, 'aceitou pedido inexistente');

    const semTransacao = await billing.webhook({ order_nsu, amount: 2500 });
    afirmar(semTransacao.status === 400, 'aceitou webhook sem transaction_nsu');
  });

  await checar('concede o plano uma única vez, mesmo com reenvio', async () => {
    const userId = `user-paga-${Date.now()}`;
    await db.users.insert({
      _id: userId,
      nome: 'Paga',
      email: emailUnico('paga'),
      senhaHash: 'x',
      plano: 'trial',
      trialFim: new Date(Date.now() - 1000)
    });

    const payment = {
      _id: `pay-${Date.now()}`,
      order_nsu: `ord-${Date.now()}`,
      userId,
      plan: 'monthly',
      amount: 2500,
      status: 'pending',
      criadoEm: new Date()
    };
    await db.payments.insert(payment);

    await billing.aplicarPagamento(payment);
    const primeira = new Date((await db.users.findOne({ _id: userId })).dataExpiracao).getTime();
    const dias = Math.round((primeira - Date.now()) / 86400000);
    afirmar(Math.abs(dias - 30) <= 1, `esperava ~30 dias, veio ${dias}`);

    await billing.aplicarPagamento(payment);
    const segunda = new Date((await db.users.findOne({ _id: userId })).dataExpiracao).getTime();
    afirmar(primeira === segunda, 'o reenvio do webhook estendeu o acesso de novo');
  });

  await checar('empilha prazo em pagamento renovação', async () => {
    const userId = `user-renova-${Date.now()}`;
    const vencimento = new Date(Date.now() + 10 * 86400000);
    await db.users.insert({
      _id: userId,
      nome: 'Renova',
      email: emailUnico('renova'),
      senhaHash: 'x',
      plano: 'pro',
      tipoPlano: 'monthly',
      dataExpiracao: vencimento
    });

    const payment = {
      _id: `pay-${Date.now()}`,
      order_nsu: `ord-${Date.now()}`,
      userId,
      plan: 'monthly',
      amount: 2500,
      status: 'pending',
      criadoEm: new Date()
    };
    await db.payments.insert(payment);

    await billing.aplicarPagamento(payment);
    const dias = Math.round((new Date((await db.users.findOne({ _id: userId })).dataExpiracao).getTime() - vencimento.getTime()) / 86400000);
    afirmar(Math.abs(dias - 30) <= 1, `esperava +30 dias sobre o vencimento, veio +${dias}`);
  });

  await checar('reenvio de webhook já pago responde sucesso sem cobrar de novo', async () => {
    const userId = `user-reenvio-${Date.now()}`;
    await db.users.insert({
      _id: userId,
      nome: 'Reenvio',
      email: emailUnico('reenvio'),
      senhaHash: 'x',
      plano: 'pro',
      tipoPlano: 'monthly',
      dataExpiracao: new Date(Date.now() + 86400000)
    });

    const order_nsu = `ord-${Date.now()}`;
    await db.payments.insert({
      _id: `pay-${Date.now()}`,
      order_nsu,
      userId,
      plan: 'monthly',
      amount: 2500,
      status: 'paid',
      aplicadoEm: new Date(),
      criadoEm: new Date()
    });

    const antes = new Date((await db.users.findOne({ _id: userId })).dataExpiracao).getTime();
    const r = await billing.webhook({ order_nsu, transaction_nsu: 't', invoice_slug: 's', amount: 2500 });
    const depois = new Date((await db.users.findOne({ _id: userId })).dataExpiracao).getTime();

    afirmar(r.status === 200, `esperava 200, veio ${r.status}`);
    afirmar(r.body.success === true, 'não respondeu sucesso');
    afirmar(antes === depois, 'o reenvio alterou o vencimento');
  });

  log('\n== Administração ==');

  await checar('usuário comum não entra no painel', async () => {
    const { cliente } = await novoClienteComConta('Comum');
    for (const rota of ['/api/admin/overview', '/api/admin/users', '/api/admin/payments']) {
      const r = await cliente.req('GET', rota);
      afirmar(r.status === 403, `${rota} respondeu ${r.status}`);
    }
  });

  await checar('admin na lista do ambiente vira administrador no cadastro', async () => {
    const cliente = novoCliente();
    await cliente.req('GET', '/api/config');
    const r = await cliente.req('POST', '/api/register', {
      body: { nome: 'Administrador', email: ADMIN_EMAIL, senha: 'senhaforte123' }
    });
    afirmar(r.status === 201, `cadastro falhou: ${JSON.stringify(r.dados)}`);
    afirmar(r.dados.admin === true, 'o e-mail da lista de administradores não virou admin');
  });

  await checar('admin concede acesso, bloqueia e exclui', async () => {
    const admin = novoCliente();
    await admin.req('GET', '/api/config');
    const loginAdmin = await admin.req('POST', '/api/login', { body: { email: ADMIN_EMAIL, senha: 'senhaforte123' } });
    afirmar(loginAdmin.status === 200, 'admin não entrou');

    const overview = await admin.req('GET', '/api/admin/overview');
    afirmar(overview.status === 200, `overview respondeu ${overview.status}`);
    afirmar(overview.dados.usuarios.total > 0, 'contagem de usuários zerada');

    const alvo = await novoClienteComConta('Alvo');

    const conceder = await admin.req('POST', `/api/admin/users/${alvo.user.id}/acesso`, {
      body: { dias: 30, plano: 'monthly', motivo: 'teste automatizado' }
    });
    afirmar(conceder.status === 200, `concessão falhou: ${JSON.stringify(conceder.dados)}`);
    afirmarIgual((await db.users.findOne({ _id: alvo.user.id })).plano, 'pro', 'a concessão não virou pro');

    const pagamentoManual = await db.payments.findOne({ userId: alvo.user.id, origem: 'admin' });
    afirmar(pagamentoManual, 'a concessão não ficou registrada nos pagamentos');

    const bloquear = await admin.req('POST', `/api/admin/users/${alvo.user.id}/bloqueio`, {
      body: { bloqueado: true }
    });
    afirmar(bloquear.status === 200, 'bloqueio falhou');
    afirmarIgual((await db.sessions.count({ userId: alvo.user.id })), 0, 'o bloqueio não encerrou as sessões');

    const acessoBloqueado = await alvo.cliente.req('GET', '/api/me');
    afirmar(acessoBloqueado.status === 401, 'conta bloqueada ainda tem sessão');

    const excluir = await admin.req('DELETE', `/api/admin/users/${alvo.user.id}`);
    afirmar(excluir.status === 200, 'exclusão falhou');
    afirmar(!(await db.users.findOne({ _id: alvo.user.id })), 'usuário continua no banco');
  });

  await checar('admin não pode se bloquear nem se excluir', async () => {
    const admin = novoCliente();
    await admin.req('GET', '/api/config');
    await admin.req('POST', '/api/login', { body: { email: ADMIN_EMAIL, senha: 'senhaforte123' } });
    const me = await admin.req('GET', '/api/me');

    const bloquear = await admin.req('POST', `/api/admin/users/${me.dados.id}/bloqueio`, { body: { bloqueado: true } });
    afirmar(bloquear.status === 400, `permitiu se bloquear: ${bloquear.status}`);

    const excluir = await admin.req('DELETE', `/api/admin/users/${me.dados.id}`);
    afirmar(excluir.status === 400, `permitiu se excluir: ${excluir.status}`);
  });

  await checar('exportação de dados não vaza para outro usuário', async () => {
    const dono = await novoClienteComConta('Exporta');
    const outro = await novoClienteComConta('Espia');

    const exportado = await outro.cliente.texto('/api/me/dados');
    afirmar(exportado.status === 200, 'exportação falhou');
    afirmar(!exportado.corpo.includes(dono.user.email), 'a exportação trouxe dados de outro usuário');
  });

  await checar('exclusão de conta apaga tudo do usuário', async () => {
    const { cliente, user } = await novoClienteComConta('Some');
    const accountId = await criarContaFake(user.id);
    await db.campaigns.insert({
      _id: `camp-${Date.now()}`,
      userId: user.id,
      nome: 'X',
      perfilId: 'Conta',
      accountId,
      destinos: ['https://facebook.com/groups/a'],
      textos: ['um'],
      imagens: [],
      dataExecucao: new Date(),
      totalDestinos: 1,
      status: 'concluido',
      criadoEm: new Date()
    });

    const senhaErrada = await cliente.req('POST', '/api/me/excluir', { body: { senha: 'errada' } });
    afirmar(senhaErrada.status === 400, 'excluiu com senha errada');

    const r = await cliente.req('POST', '/api/me/excluir', { body: { senha: 'senhaforte123' } });
    afirmar(r.status === 200, `veio ${r.status}: ${JSON.stringify(r.dados)}`);

    afirmar(!(await db.users.findOne({ _id: user.id })), 'usuário sobrou');
    afirmarIgual((await db.campaigns.find({ userId: user.id })).length, 0, 'campanhas sobraram');
    afirmarIgual((await db.accounts.find({ userId: user.id })).length, 0, 'contas do Facebook sobraram');
  });

  await checar('limita requisições repetidas por IP', async () => {
    // App mínimo com o mesmo limitador usado pelas rotas, para provar o
    // comportamento sem consumir o orçamento de IP da suíte inteira.
    const express = require('express');
    const security = require('../src/security');
    const mini = express();
    mini.use(security.criarRateLimit({ nome: 'teste', max: 3, janelaMs: 60000 }));
    mini.get('/ping', (req, res) => res.json({ ok: true }));

    const porta = PORTA + 1;
    const servidorMini = await new Promise((resolve, reject) => {
      const s = mini.listen(porta, '127.0.0.1', () => resolve(s));
      s.once('error', reject);
    });

    try {
      const estados = [];
      for (let i = 0; i < 5; i++) {
        const r = await fetch(`http://127.0.0.1:${porta}/ping`);
        estados.push(r.status);
      }

      afirmar(
        estados.slice(0, 3).every(s => s === 200),
        `as três primeiras deveriam passar, vieram ${estados.join(',')}`
      );
      afirmar(estados.slice(3).every(s => s === 429), `as seguintes deveriam ser 429, vieram ${estados.join(',')}`);

      const bloqueado = await fetch(`http://127.0.0.1:${porta}/ping`);
      afirmar(bloqueado.headers.get('Retry-After'), 'a resposta 429 não informa Retry-After');
    } finally {
      await new Promise(resolve => servidorMini.close(resolve));
    }
  });

  log('\n== Saúde ==');

  await checar('health responde com o estado do sistema', async () => {
    const r = await fetch(`${BASE}/api/health`);
    const dados = await r.json();
    afirmar(r.status === 200, `respondeu ${r.status}`);
    afirmar(dados.ok === true, 'sem ok');
    afirmar(typeof dados.uptime === 'number', 'sem uptime');
  });

  await checar('rota de API inexistente devolve 404 em JSON', async () => {
    const r = await fetch(`${BASE}/api/nao-existe`);
    afirmar(r.status === 404, `respondeu ${r.status}`);
    afirmar((r.headers.get('content-type') || '').includes('json'), '404 sem JSON');
  });

  await checar('corpo malformado não derruba o servidor', async () => {
    const r = await fetch(`${BASE}/api/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{quebrado'
    });
    afirmar(r.status === 400, `respondeu ${r.status}`);

    const health = await fetch(`${BASE}/api/health`);
    afirmar(health.status === 200, 'o servidor caiu com corpo malformado');
  });
}

function afirmarPosts(posts, statusEsperado) {
  for (const post of posts) {
    afirmarIgual(post.status, statusEsperado, `destino ${post.grupoUrl} ficou com status inesperado`);
  }
}

async function main() {
  log('Postador Pro — testes de fumaça');
  log(`porta ${PORTA} | dados em ${DATA_DIR}`);

  const { problemas } = config.validarConfig();
  if (problemas.length) {
    throw new Error(`configuração inválida para o teste: ${problemas.join('; ')}`);
  }

  await dbMod.iniciar();

  const app = criarApp();
  servidor = app.listen(PORTA, '127.0.0.1');

  await new Promise((resolve, reject) => {
    servidor.once('listening', resolve);
    servidor.once('error', reject);
  });

  try {
    await suite();
  } finally {
    await new Promise(resolve => servidor.close(resolve));
    try { fs.rmSync(DATA_DIR, { recursive: true, force: true }); } catch { /* ignora */ }
  }

  log(`\n${passo}/${totalPassos} verificações passaram.`);

  if (falhas.length) {
    log(`\n${falhas.length} FALHA(S):`);
    for (const f of falhas) log(`  - ${f.descricao}: ${f.erro}`);
    process.exit(1);
  }

  log('Tudo certo.\n');
  process.exit(0);
}

main().catch(erro => {
  log(`\nErro na execução dos testes: ${erro.stack || erro.message}`);
  if (servidor) servidor.close();
  try { fs.rmSync(DATA_DIR, { recursive: true, force: true }); } catch { /* ignora */ }
  process.exit(1);
});

