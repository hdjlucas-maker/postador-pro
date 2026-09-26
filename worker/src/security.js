'use strict';

// Segurança de requisição: CORS, origem, CSRF, cookies e limite de taxa.
//
// ## O que mudou em relação ao servidor Express
//
// - `req.ip` virou `CF-Connecting-IP`, que a Cloudflare preenche com o cliente
//   real. É mais confiável que `TRUST_PROXY`, que não existe mais.
// - O limitador em memória virou dois mecanismos: o binding nativo do edge para
//   o teto geral, e uma janela fixa no D1 para as rotas cujas janelas (15 min,
//   1 h) o edge não aceita. O ganho real: a trava por tentativa de login
//   continua valendo depois de um deploy, quando a versão em memória zerava.
// - `timingSafeEqual` do Node foi reimplementado sobre Web Crypto em
//   `crypto.igualBytes`.

const crypto = require('./crypto');
const configMod = require('./config');
const db = require('./db');
const log = require('./log');

const CSP = [
  "default-src 'self'",
  "base-uri 'none'",
  "object-src 'none'",
  "frame-ancestors 'none'",
  "form-action 'self'",
  "img-src 'self' data: blob:",
  // A interface ajusta barras de progresso e visibilidade por atributo
  // `style`, então o estilo inline precisa ser liberado. `script-src` continua
  // estrito: estilo inline não executa JavaScript.
  "style-src 'self' 'unsafe-inline'",
  "script-src 'self'",
  "connect-src 'self'",
  "font-src 'self'",
  "manifest-src 'self'",
  'upgrade-insecure-requests'
].join('; ');

const METODOS_SEGUROS = new Set(['GET', 'HEAD', 'OPTIONS']);

// O Chrome gera IDs de extensão com os caracteres de a até p. Qualquer outra
// coisa é rejeitada antes de comparar com a allowlist.
const RE_EXTENSAO = /^chrome-extension:\/\/([a-p]{32})$/;

function idDaExtensao(origem) {
  const achado = RE_EXTENSAO.exec(String(origem || ''));
  return achado ? achado[1] : null;
}

function origemExtensaoPermitida(origem, env) {
  const id = idDaExtensao(origem);
  return Boolean(id) && configMod.config(env).EXTENSAO_IDS.includes(id);
}

/**
 * `Authorization: Bearer` só chega aqui se o navegador aprovou a origem no
 * preflight CORS. Uma página comum não consegue forjar esse cabeçalho numa
 * requisição cross-site, então quem tem token não precisa de CSRF por cookie.
 */
function temTokenBearer(c) {
  return /^Bearer\s+\S+/i.test(c.req.header('authorization') || '');
}

function extrairBearer(c) {
  const achado = /^Bearer\s+(\S+)$/i.exec(c.req.header('authorization') || '');
  return achado ? achado[1] : null;
}

function clientIp(c) {
  return c.req.header('cf-connecting-ip') || c.req.header('x-forwarded-for')?.split(',')[0]?.trim() || 'desconhecido';
}

// Estas duas funções recebem o caminho JÁ COM O PREFIXO `/api`, porque é assim
// que a requisição chega no middleware. O predicado é deliberadamente
// "contém" e não "começa com": ele precisa continuar valendo se o app for
// montado em outro prefixo, e é o que impede o webhook e o login da extensão de
// caírem na trava de CSRF por usarem um caminho diferente do esperado.
function ehRotaDeExtensao(path) {
  return path === '/api/extensao' || path.includes('/extensao/');
}

function ehWebhook(path) {
  return path.includes('/webhooks/');
}

/**
 * CORS só para as extensões autorizadas. Uma página comum não ganha cabeçalho
 * nenhum daqui e continua validada por `aplicarOrigem` mais CSRF.
 *
 * O `env` vem de `c.env`, e não de um argumento: o app é montado uma única vez
 * no módulo, e o objeto de ambiente só existe por requisição. Passar `env` na
 * criação obrigaria a montar o app inteiro a cada requisição.
 */
function corsExtensao() {
  return async function cors(c, next) {
    const env = c.env;
    const origem = c.req.header('origin');
    const ehPreflight = c.req.method === 'OPTIONS';

    if (origem && origemExtensaoPermitida(origem, env)) {
      c.res.headers.set('Access-Control-Allow-Origin', origem);
      c.res.headers.set('Vary', 'Origin');
      c.res.headers.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      c.res.headers.set('Access-Control-Allow-Headers', 'Content-Type, Authorization');
      c.res.headers.set('Access-Control-Max-Age', '600');
    }

    if (ehPreflight) {
      // O preflight responde aqui, sem passar pelo roteador. Sem o
      // `Access-Control-Allow-Origin` acima, o navegador bloqueia de qualquer
      // jeito — mas responder 204 deixa claro o motivo no painel.
      return c.body(null, 204);
    }

    return next();
  };
}

/**
 * Rejeita requisição que altera estado e não vem de lugar nenhum: nem a própria
 * web, nem uma extensão autorizada, nem um portador de token.
 */
function aplicarOrigem() {
  return async function origem(c, next) {
    if (METODOS_SEGUROS.has(c.req.method)) return next();
    if (temTokenBearer(c)) return next();

    const env = c.env;
    const path = new URL(c.req.url).pathname;
    if (ehWebhook(path)) return next();

    const origem = c.req.header('origin');
    const permitido = configMod.baseUrl(env, c.req.raw);
    const cfg = configMod.config(env);

    if (origem && origemExtensaoPermitida(origem, env)) return next();

    if (!origem) {
      const referer = c.req.header('referer');
      if (!referer) {
        return c.json(
          { erro: 'Requisição bloqueada: origem não identificada. Recarregue a página e tente de novo.', codigo: 'origem_desconhecida' },
          403
        );
      }
      try {
        if (new URL(referer).origin !== permitido) {
          return c.json({ erro: 'Requisição bloqueada.', codigo: 'origem_invalida' }, 403);
        }
      } catch {
        return c.json({ erro: 'Requisição bloqueada.', codigo: 'origem_invalida' }, 403);
      }
      return next();
    }

    if (origem === permitido) return next();

    // `null` vem de `file://`, `data:` ou de um sandbox. Também pode ser o
    // resultado de uma requisição sem `Origin` em que o navegador omitiu o
    // cabeçalho; nos dois casos não é a nossa web.
    if (origem === 'null' || !/^https?:\/\//.test(origem)) {
      return c.json({ erro: 'Requisição bloqueada.', codigo: 'origem_invalida' }, 403);
    }

    // A URL pública pode estar atrás de um host diferente do configurado, por
    // exemplo o subdomínio `workers.dev` com `PUBLIC_BASE_URL` fixado. O
    // `Host` do request é a referência correta nessa situação.
    if (origem === new URL(c.req.url).origin) return next();

    log.warn('origem_bloqueada', { origem, path, host: cfg.PUBLIC_BASE_URL || 'derivada' });
    return c.json({ erro: 'Requisição bloqueada.', codigo: 'origem_invalida' }, 403);
  };
}

/**
 * CSRF por cookie, padrão double-submit: o navegador precisa ler o cookie
 * `postador_csrf` e devolvê-lo no header `x-csrf-token`. Um site externo não
 * consegue ler o cookie do Postador, então não consegue forjar o header.
 */
function aplicarCsrf() {
  return async function csrf(c, next) {
    if (METODOS_SEGUROS.has(c.req.method)) return next();
    if (temTokenBearer(c)) return next();

    const path = new URL(c.req.url).pathname;
    if (ehWebhook(path)) return next();
    // A extensão não tem cookie jar: ela não tem como ter o par cookie+header.
    // Onde o token falta, quem responde é `exigirToken` com 401 — um 403 de CSRF
    // aqui só confundiria o diagnóstico. A allowlist de origem, o rate limit e a
    // trava de conta continuam valendo.
    if (ehRotaDeExtensao(path)) return next();

    const cfg = configMod.config(c.env);
    const cookie = c.req.cookie(cfg.CSRF_COOKIE);
    const header = c.req.header(cfg.CSRF_HEADER);

    if (!cookie || !header) {
      log.warn('csrf_bloqueado', { path, ip: clientIp(c) });
      return c.json({ erro: 'Sessão expirada no navegador. Atualize a página e tente novamente.', codigo: 'csrf_invalido' }, 403);
    }

    if (!crypto.igualBytes(crypto.enc.encode(cookie), crypto.enc.encode(header))) {
      log.warn('csrf_bloqueado', { path, ip: clientIp(c) });
      return c.json({ erro: 'Sessão expirada no navegador.', codigo: 'csrf_invalido' }, 403);
    }

    return next();
  };
}

function opcoesCookie(cfg, base) {
  const partes = { path: '/', sameSite: 'Lax', secure: true };
  if (base) partes.domain = base;
  return partes;
}

/**
 * No `workers.dev` e em qualquer host da Cloudflare o TLS é obrigatório, então
 * `Secure` é sempre ligado. A URL pública é HTTPS por definição agora — não
 * existe mais o caso de `http://localhost:3000` do servidor local.
 */
function definirCookie(c, nome, valor, maxAgeSegundos) {
  c.setCookie(nome, valor, { ...opcoesCookie(), httpOnly: true, maxAge: maxAgeSegundos });
}

function definirCookieLegivel(c, nome, valor, maxAgeSegundos) {
  c.setCookie(nome, valor, { ...opcoesCookie(), httpOnly: false, maxAge: maxAgeSegundos });
}

function emitirCsrf(c) {
  const cfg = configMod.config(c.env);
  const token = crypto.novoToken(24);
  definirCookieLegivel(c, cfg.CSRF_COOKIE, token, cfg.SESSION_DAYS * 86400);
  return token;
}

function rotacionarCsrf(c) {
  return emitirCsrf(c);
}

function assegurarCsrf(c) {
  const cfg = configMod.config(c.env);
  if (c.req.cookie(cfg.CSRF_COOKIE)) return;
  emitirCsrf(c);
}

function encerrarCookie(c, nome) {
  c.setCookie(nome, '', { ...opcoesCookie(), httpOnly: true, maxAge: 0 });
}

/**
 * Teto geral da API pelo binding nativo do edge: nenhuma escrita no banco,
 * nenhuma latência. `key` é o IP, e o contador vive no próprio datacenter que
 * atendeu a requisição.
 */
async function limiteGeral(c) {
  const env = c.env;
  if (!env.RL_GERAL) return;
  const { success } = await env.RL_GERAL.limit({ key: clientIp(c) });
  if (success) return;

  c.header('Retry-After', '60');
  throw Object.assign(new Error('Muitas tentativas. Aguarde alguns minutos e tente novamente.'), { status: 429 });
}

/**
 * Janela longa no D1, para as rotas que o edge não cobre. Devolve um middleware
 * Hono que barra com 429 quando o orçamento da janela acaba.
 *
 * `sucesso` é assíncrono e o middleware do Hono é `await`ado, então uma falha
 * de escrita no D1 não pode derrubar a requisição inteira: aqui o erro é
 * registrado e a requisição passa. Um rate limit indisponível não pode virar
 * indisponibilidade do produto; quem protege a conta é a trava de tentativas.
 */
function limiteD1(nome, { max, janelaMs, chave } = {}) {
  return async function limit(c, next) {
    const cfg = configMod.config(c.env);
    const limite = max ?? cfg.RATE_LIMITS[nome] ?? 10;
    const janela = janelaMs ?? cfg.JANELAS_RATE_LIMIT[nome] ?? 15 * 60 * 1000;
    const identificador = chave ? chave(c) : clientIp(c);

    try {
      const resultado = await db.rateLimit_atingir(c.env, nome, identificador, janela, limite);
      if (!resultado.permitido) {
        c.header('Retry-After', String(Math.max(1, Math.ceil(resultado.expiraEm - Date.now() / 1000))));
        log.warn('rate_limit', { limite: nome, path: new URL(c.req.url).pathname });
        return c.json({ erro: 'Muitas tentativas. Aguarde alguns minutos e tente novamente.' }, 429);
      }
    } catch (erro) {
      log.error('rate_limit_indisponivel', { limite: nome, erro: erro.message });
    }

    return next();
  };
}

module.exports = {
  CSP,
  METODOS_SEGUROS,
  RE_EXTENSAO,
  hashToken: crypto.sha256Hex,
  novoToken: crypto.novoToken,
  idDaExtensao,
  origemExtensaoPermitida,
  temTokenBearer,
  extrairBearer,
  clientIp,
  ehRotaDeExtensao,
  ehWebhook,
  corsExtensao,
  aplicarOrigem,
  aplicarCsrf,
  definirCookie,
  definirCookieLegivel,
  emitirCsrf,
  rotacionarCsrf,
  assegurarCsrf,
  encerrarCookie,
  limiteGeral,
  limiteD1
};
