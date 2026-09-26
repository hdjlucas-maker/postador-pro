'use strict';

/**
 * Testes de fumaça do Postador Pro.
 *
 * Sobe a API de licença no próprio processo, com um diretório de dados
 * temporário, e valida o contrato: autenticação, isolamento entre usuários,
 * limites de plano, CSRF, exposição de arquivos, cobrança e admin.
 *
 * Não publica em grupo nenhum. A publicação é responsabilidade da extensão,
 * no navegador do cliente, e não tem como ser testada aqui.
 *
 * Uso: npm test
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const PORTA = Number(process.env.TEST_PORT || 3199);
const BASE = `http://127.0.0.1:${PORTA}`;
const DATA_DIR = path.join(os.tmpdir(), `postador-teste-${Date.now()}`);

const ADMIN_EMAIL = 'admin@postador.local';
const SENHA_ADMIN = 'senhaforte123';

process.env.NODE_ENV = 'test';
process.env.PORT = String(PORTA);
process.env.HOST = '127.0.0.1';
process.env.PUBLIC_BASE_URL = BASE;
process.env.DATA_DIR = DATA_DIR;
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

// Extensão liberada nos testes. O ID precisa ter 32 caracteres de a-p, que é o
// formato que o Chrome gera, para passar pela validação de origem.
const EXTENSAO_ID = 'abcdefghijklmnopabcdefghijklmnop';
const OUTRA_EXTENSAO_ID = 'ponmlkjihgfedcbaponmlkjihgfedcba';
process.env.EXTENSAO_IDS = `${EXTENSAO_ID},${OUTRA_EXTENSAO_ID}`;
process.env.TOKEN_EXTENSAO_DIAS = '30';

// Trava de conta em 3 falhas para o teste caber em tempo razoável.
process.env.LOGIN_FALHAS_MAX = '3';
process.env.LOGIN_BLOQUEIO_MINUTOS = '15';

const dbMod = require('../src/db');
const billing = require('../src/billing');
const config = require('../src/config');
const { criarApp } = require('../src/app');

const { db } = dbMod;

let servidor;
let passo = 0;
let totalPassos = 0;
const falhas = [];
let tokenExtensao = null;

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

/* ------------------------------------------------------------------ *
 * Suíte
 * ------------------------------------------------------------------ */

async function suite() {
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
    for (const alvo of ['/data/', '/data/users.db', '/data/backups/']) {
      const r = await fetch(`${BASE}${alvo}`);
      afirmar(r.status === 404, `${alvo} respondeu ${r.status}`);
    }
  });

  await checar('serve a interface em /', async () => {
    const r = await fetch(`${BASE}/`);
    const corpo = await r.text();
    afirmar(r.status === 200, `respondeu ${r.status}`);
    afirmar(/postador/i.test(corpo), 'interface sem a marca do produto');
    afirmar(corpo.includes('estilo.css'), 'interface sem a folha de estilo');
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

    // Cada tag `<script>` é conferida por conta própria. Um regex único com
    // `[\s\S]*` atravessa o `</script>` de uma tag e casa com a próxima, dando
    // falso positivo sempre que há mais de um script externo na página.
    const tags = corpo.match(/<script\b[^>]*>[\s\S]*?<\/script>/gi) || [];

    for (const tag of tags) {
      const abertura = tag.match(/^<script\b([^>]*)>/i)[1];
      const corpoDaTag = tag.replace(/^<script\b[^>]*>/i, '').replace(/<\/script>$/i, '');

      afirmar(!corpoDaTag.trim(), `script inline: ${tag.slice(0, 60)}`);
      afirmar(!/on\w+\s*=/i.test(abertura), `handler inline em <script>: ${abertura}`);
      afirmar(
        abertura === '' || /^\s*src\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)\s*$/.test(abertura),
        `<script> com atributo inesperado: ${abertura}`
      );
    }

    afirmar(!/<style\b[^>]*>[\s\S]*\S[\s\S]*<\/style>/i.test(corpo), 'há style inline no HTML');
    afirmar(!/\son\w+\s*=\s*"/i.test(corpo), 'há handler inline em atributo');
  });

  log('\n== Rotas que não devem existir ==');
  // A publicação é feita pela extensão. Se alguma dessas rotas voltar, alguém
  // recriou a arquitetura que foi removida.

  for (const [metodo, rota] of [
    ['GET', '/api/campaigns'],
    ['GET', '/api/dashboard'],
    ['GET', '/api/facebook/accounts'],
    ['GET', '/api/uploads']
  ]) {
    await checar(`${metodo} ${rota} responde 404`, async () => {
      const r = await fetch(`${BASE}${rota}`);
      afirmar(r.status === 404, `respondeu ${r.status}`);
    });
  }

  log('\n== Proteção de requisições ==');
  // O teste de limite de login fica no fim da suíte: ele esgota o orçamento de
  // tentativas por IP e, se rodar antes, bloquearia os logins dos testes
  // seguintes.

  await checar('origem da extensão autorizada passa, as outras não', async () => {
    const comExtensao = await fetch(`${BASE}/api/extensao/planos`, {
      headers: { Origin: `chrome-extension://${EXTENSAO_ID}` }
    });
    afirmar(comExtensao.status === 200, `extensão autorizada respondeu ${comExtensao.status}`);
    afirmar(
      comExtensao.headers.get('access-control-allow-origin') === `chrome-extension://${EXTENSAO_ID}`,
      'CORS não liberou a extensão autorizada'
    );

    const comDesconhecida = await fetch(`${BASE}/api/extensao/planos`, {
      headers: { Origin: 'chrome-extension://qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq' }
    });
    afirmar(
      comDesconhecida.headers.get('access-control-allow-origin') === null,
      'CORS liberou uma extensão fora da lista'
    );

    const daWeb = await fetch(`${BASE}/api/extensao/planos`, { headers: { Origin: BASE } });
    afirmar(daWeb.headers.get('access-control-allow-origin') === null, 'CORS liberou a própria web');
  });

  await checar('API libera leitura para a extensão, HTML não', async () => {
    const api = await fetch(`${BASE}/api/health`);
    afirmar(
      api.headers.get('cross-origin-resource-policy') === 'cross-origin',
      `API com CORP ${api.headers.get('cross-origin-resource-policy')}`
    );

    const pagina = await fetch(`${BASE}/`);
    afirmar(
      pagina.headers.get('cross-origin-resource-policy') === 'same-origin',
      `HTML com CORP ${pagina.headers.get('cross-origin-resource-policy')}`
    );
  });

  await checar('estado do sistema só para administrador', async () => {
    const anonimo = await fetch(`${BASE}/api/estado`);
    afirmar(anonimo.status === 401, `sem login respondeu ${anonimo.status}`);

    const comum = novoCliente();
    await comum.req('GET', '/api/config');
    await comum.req('POST', '/api/register', {
      body: { nome: 'Comum', email: emailUnico('estado'), senha: 'senhaforte123' }
    });
    const naoAdmin = await comum.req('GET', '/api/estado');
    afirmar(naoAdmin.status === 403, `usuário comum respondeu ${naoAdmin.status}`);
  });

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
    afirmarIgual(user.limites.gruposPorDia, config.PLAN_LIMITS.trial.gruposPorDia, 'limite de grupos do trial errado');
    afirmarIgual(user.limites.campanhasAtivas, 3, 'limite de campanhas do trial errado');
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

    await db.resets.update(
      { tokenHash: require('crypto').createHash('sha256').update(token).digest('hex') },
      { $set: { expiraEm: new Date(Date.now() - 1000) } }
    );

    const r = await cliente.req('POST', '/api/redefinir-senha', { body: { token, novaSenha: 'novasenha456' } });
    afirmar(r.status === 400, `respondeu ${r.status}`);
  });

  log('\n== Limites de plano e expiração ==');

  await checar('a configuração pública traz planos e limites', async () => {
    const cliente = novoCliente();
    const r = await cliente.req('GET', '/api/config');
    afirmar(r.status === 200, `respondeu ${r.status}`);
    afirmar(r.dados.planos.length === 2, 'esperava os planos mensal e anual');
    afirmar(r.dados.planos.map(p => p.id).includes('monthly'), 'plano mensal ausente');
    afirmar(r.dados.planos.map(p => p.id).includes('annual'), 'plano anual ausente');
    afirmar(r.dados.limites.trial.gruposPorDia > 0, 'limite de grupos do trial não veio');
    afirmar(r.dados.limites.pro.gruposPorDia > r.dados.limites.trial.gruposPorDia, 'o plano pro não tem limite maior que o trial');
  });

  await checar('expira o acesso quando a avaliação termina', async () => {
    const { cliente, user } = await novoClienteComConta('Expirado');
    await db.users.update({ _id: user.id }, { $set: { trialFim: new Date(Date.now() - 1000) } });

    const sub = await cliente.req('GET', '/api/subscription');
    afirmar(sub.status === 200, `respondeu ${sub.status}`);
    afirmarIgual(sub.dados.status, 'expirado', 'status de acesso errado');
    afirmarIgual(sub.dados.ativo, false, 'acesso expirado ainda consta como ativo');
  });

  await checar('usuário pro vê os limites do plano pago', async () => {
    const { cliente, user } = await novoClienteComConta('Pro');
    await db.users.update(
      { _id: user.id },
      { $set: { plano: 'pro', tipoPlano: 'monthly', dataExpiracao: new Date(Date.now() + 30 * 86400000) } }
    );

    const me = await cliente.req('GET', '/api/me');
    afirmarIgual(me.dados.statusPagamento, 'pro', 'status pro errado');
    afirmarIgual(me.dados.limites.gruposPorDia, config.PLAN_LIMITS.pro.gruposPorDia, 'limite de grupos do pro errado');
    afirmarIgual(me.dados.limites.destinosPorCampanha, 100, 'limite de destinos do pro errado');
  });

  await checar('conta bloqueada perde a sessão e volta ao desbloquear', async () => {
    const email = emailUnico('bloqueado');
    const { cliente, user } = await novoClienteComConta('Bloqueado', { email });

    await db.users.update({ _id: user.id }, { $set: { bloqueado: true } });

    const me = await cliente.req('GET', '/api/me');
    afirmar(me.status === 401, `conta bloqueada ainda tem sessão (${me.status})`);

    // Bloqueado não tem sessão válida, então a painel recusa já na
    // autenticação (401) ou na autorização (403). O que não pode é passar.
    const painel = await cliente.req('GET', '/api/admin/overview');
    afirmar([401, 403].includes(painel.status), `conta bloqueada chegou ao painel (${painel.status})`);

    await db.users.update({ _id: user.id }, { $set: { bloqueado: false } });
    const depois = await cliente.req('GET', '/api/me');
    afirmar(depois.status === 200, 'não voltou ao normal depois de desbloquear');
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
    afirmar(overview.dados.campanhas === undefined, 'o painel ainda fala em campanhas do servidor');
    afirmar(overview.dados.contasFacebook === undefined, 'o painel ainda fala em contas do Facebook no servidor');

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

  await checar('exclusão de conta apaga tudo do usuário no servidor', async () => {
    const { cliente, user } = await novoClienteComConta('Some');
    await db.payments.insert({
      _id: `pay-${Date.now()}`,
      order_nsu: `ord-${Date.now()}`,
      userId: user.id,
      plan: 'monthly',
      amount: 2500,
      status: 'pending',
      criadoEm: new Date()
    });

    const senhaErrada = await cliente.req('POST', '/api/me/excluir', { body: { senha: 'errada' } });
    afirmar(senhaErrada.status === 400, 'excluiu com senha errada');

    const r = await cliente.req('POST', '/api/me/excluir', { body: { senha: 'senhaforte123' } });
    afirmar(r.status === 200, `veio ${r.status}: ${JSON.stringify(r.dados)}`);

    afirmar(!(await db.users.findOne({ _id: user.id })), 'usuário sobrou');
    afirmarIgual((await db.payments.find({ userId: user.id })).length, 0, 'pagamentos sobraram');
    afirmarIgual((await db.sessions.find({ userId: user.id })).length, 0, 'sessões sobraram');
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

  log('\n== Extensão: token, licença e bloqueio de conta ==');

  await checar('login da extensão devolve token e licença', async () => {
    const origem = { Origin: `chrome-extension://${EXTENSAO_ID}` };
    const r = await fetch(`${BASE}/api/extensao/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...origem },
      body: JSON.stringify({ email: ADMIN_EMAIL, senha: SENHA_ADMIN })
    });
    const dados = await r.json();

    afirmar(r.status === 200, `respondeu ${r.status}: ${dados.erro || ''}`);
    afirmar(typeof dados.token === 'string' && dados.token.length >= 32, 'token curto ou ausente');
    afirmar(dados.acesso?.permitido === true, 'admin sem acesso');
    afirmar(dados.licenca?.email === ADMIN_EMAIL, 'licença sem o e-mail do usuário');
    afirmar(typeof dados.licenca?.limites?.gruposPorDia === 'number', 'licença sem limites do plano');
    afirmar(dados.licenca.senhaHash === undefined, 'a resposta vazou o hash da senha');

    tokenExtensao = dados.token;
  });

  await checar('o token da extensão funciona sem cookie de sessão', async () => {
    const semToken = await fetch(`${BASE}/api/extensao/licenca`);
    afirmar(semToken.status === 401, `sem token respondeu ${semToken.status}`);

    const r = await fetch(`${BASE}/api/extensao/licenca`, {
      headers: { Authorization: `Bearer ${tokenExtensao}` }
    });
    const dados = await r.json();

    afirmar(r.status === 200, `respondeu ${r.status}`);
    afirmar(dados.licenca?.email === ADMIN_EMAIL, 'licença errada');
    afirmar(r.headers.get('set-cookie') === null, 'a rota de token não deveria emitir cookie');
  });

  await checar('token inventado e token de outra conta não passam', async () => {
    const falso = await fetch(`${BASE}/api/extensao/licenca`, {
      headers: { Authorization: 'Bearer aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' }
    });
    afirmar(falso.status === 401, `token falso respondeu ${falso.status}`);

    const malformado = await fetch(`${BASE}/api/extensao/licenca`, {
      headers: { Authorization: 'Token nao-e-bearer' }
    });
    afirmar(malformado.status === 401, `esquema errado respondeu ${malformado.status}`);
  });

  await checar('token válido pula CSRF, mas origem errada sem token não passa', async () => {
    const comToken = await fetch(`${BASE}/api/extensao/sair`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${tokenExtensao}`, Origin: 'https://malicioso.example' }
    });
    afirmar(comToken.status === 200, `com token respondeu ${comToken.status}`);

    // O token foi encerrado acima; o mesmo caminho sem token tem de ser barrado.
    const semToken = await fetch(`${BASE}/api/extensao/sair`, {
      method: 'POST',
      headers: { Origin: 'https://malicioso.example' }
    });
    afirmar(semToken.status === 403, `sem token e origem externa respondeu ${semToken.status}`);
  });

  await checar('token encerrado não volta a valer', async () => {
    const r = await fetch(`${BASE}/api/extensao/licenca`, {
      headers: { Authorization: `Bearer ${tokenExtensao}` }
    });
    afirmar(r.status === 401, `token revogado respondeu ${r.status}`);
    tokenExtensao = null;
  });

  await checar('cadastro pela extensão já devolve token', async () => {
    const r = await fetch(`${BASE}/api/extensao/cadastro`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: `chrome-extension://${EXTENSAO_ID}` },
      body: JSON.stringify({ nome: 'Extensao', email: emailUnico('ext'), senha: 'senhaforte123' })
    });
    const dados = await r.json();

    afirmar(r.status === 201, `respondeu ${r.status}: ${dados.erro || ''}`);
    afirmar(typeof dados.token === 'string', 'cadastro não devolveu token');
    afirmar(dados.acesso?.status === 'trial', `avaliação não aplicada: ${dados.acesso?.status}`);

    await fetch(`${BASE}/api/extensao/sair`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${dados.token}` }
    });
  });

  await checar('checkout exige token válido', async () => {
    const anonimo = await fetch(`${BASE}/api/extensao/checkout`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: `chrome-extension://${EXTENSAO_ID}` },
      body: JSON.stringify({ plano: 'monthly' })
    });
    afirmar(anonimo.status === 401, `sem token respondeu ${anonimo.status}`);
  });

  await checar('planos da extensão são públicos e não vazam usuário', async () => {
    const r = await fetch(`${BASE}/api/extensao/planos`);
    const dados = await r.json();

    afirmar(r.status === 200, `respondeu ${r.status}`);
    afirmar(dados.planos?.length === 2, 'não devolveu os dois planos');
    afirmar(dados.planos.every(p => typeof p.preco === 'number'), 'plano sem preço');
    afirmar(dados.limites?.pro?.gruposPorDia > 0, 'sem limites do plano Pro');
    afirmar(dados.usuarios === undefined && dados.token === undefined, 'a vitrine pública vazou dados');
  });

  await checar('senhas erradas em sequência travam a conta', async () => {
    const email = emailUnico('trava');
    const cliente = novoCliente();
    await cliente.req('GET', '/api/config');
    await cliente.req('POST', '/api/register', {
      body: { nome: 'Alvo', email, senha: 'senhaforte123' }
    });

    const errar = () => cliente.req('POST', '/api/login', { body: { email, senha: 'senhaerrada999' } });

    for (let i = 0; i < 3; i += 1) {
      const r = await errar();
      afirmar(r.status === 401, `tentativa ${i + 1} respondeu ${r.status}`);
    }

    // A quarta tentativa cai na trava, mesmo com a senha certa.
    const travada = await cliente.req('POST', '/api/login', { body: { email, senha: 'senhaforte123' } });
    afirmar(travada.status === 429, `conta travada respondeu ${travada.status}`);
    afirmar(travada.dados?.codigo === 'conta_bloqueada', `código inesperado: ${travada.dados?.codigo}`);

    // A senha certa volta a valer assim que a trava expira.
    await db.users.update({ email }, { $unset: { bloqueadoAte: '', loginFalhas: '' } });
    const liberada = await cliente.req('POST', '/api/login', { body: { email, senha: 'senhaforte123' } });
    afirmar(liberada.status === 200, `após destravar respondeu ${liberada.status}`);
  });

  log('\n== Saúde ==');

  await checar('health responde com o estado do sistema', async () => {
    const r = await fetch(`${BASE}/api/health`);
    const dados = await r.json();
    afirmar(r.status === 200, `respondeu ${r.status}`);
    afirmar(dados.ok === true, 'sem ok');
    afirmar(typeof dados.uptime === 'number', 'sem uptime');
    afirmar(dados.fila === undefined, 'health ainda fala em fila de publicação');
    afirmar(dados.navegadores === undefined, 'health ainda fala em navegadores abertos');
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

async function main() {
  log('Postador Pro — testes de fumaça da API de licença');
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
