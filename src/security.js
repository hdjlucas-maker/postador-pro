'use strict';

const crypto = require('crypto');
const config = require('./config');
const log = require('./log');

function hashToken(token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex');
}

function novoToken(bytes = 32) {
  return crypto.randomBytes(bytes).toString('hex');
}

function gerarSenha(tamanho = 12) {
  const alfabeto = 'abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = crypto.randomBytes(tamanho);
  let senha = '';
  for (const byte of bytes) {
    senha += alfabeto[byte % alfabeto.length];
  }
  return senha;
}

function criarRateLimit({ nome, max, janelaMs, chave }) {
  const registros = new Map();

  const limpar = () => {
    const agora = Date.now();
    for (const [chaveLimite, lista] of registros) {
      const vivos = lista.filter(ts => agora - ts < janelaMs);
      if (vivos.length) registros.set(chaveLimite, vivos);
      else registros.delete(chaveLimite);
    }
  };

  const timer = setInterval(limpar, janelaMs);
  timer.unref?.();

  return (req, res, next) => {
    const identificador = chave ? chave(req) : req.ip || 'desconhecido';
    const chaveLimite = `${nome}:${identificador}`;
    const agora = Date.now();

    const lista = (registros.get(chaveLimite) || []).filter(ts => agora - ts < janelaMs);

    if (lista.length >= max) {
      log.warn('rate_limit', { limite: nome, rota: req.originalUrl });
      res.setHeader('Retry-After', String(Math.ceil(janelaMs / 1000)));
      return res.status(429).json({
        erro: 'Muitas tentativas. Aguarde alguns minutos e tente novamente.'
      });
    }

    lista.push(agora);
    registros.set(chaveLimite, lista);
    next();
  };
}

function clienteIp(req) {
  return req.ip || req.socket?.remoteAddress || 'desconhecido';
}

function usuarioId(req) {
  return req.user?._id || 'anonimo';
}

const METODOS_SEGUROS = new Set(['GET', 'HEAD', 'OPTIONS']);

const RE_EXTENSAO = /^chrome-extension:\/\/([a-p]{32})$/;

function idDaExtensao(origem) {
  const achado = RE_EXTENSAO.exec(String(origem || ''));
  return achado ? achado[1] : null;
}

function origemExtensaoPermitida(origem) {
  const id = idDaExtensao(origem);
  return Boolean(id) && config.EXTENSAO_IDS.includes(id);
}

// `Authorization: Bearer` só chega aqui se o navegador aprovou a origem via
// CORS. Uma página comum não consegue forjar esse cabeçalho numa requisição
// cross-site, então quem tem token não precisa de CSRF por cookie.
function temTokenBearer(req) {
  return /^Bearer\s+\S+/i.test(String(req.get('authorization') || ''));
}

function aplicarOrigem(req, res, next) {
  if (METODOS_SEGUROS.has(req.method)) return next();
  if (temTokenBearer(req)) return next();

  const origem = req.get('origin');
  const permitido = config.PUBLIC_BASE_URL;

  if (origem && origemExtensaoPermitida(origem)) return next();

  if (!origem) {
    const referer = req.get('referer');
    if (!referer) {
      return res.status(403).json({
        erro: 'Requisição bloqueada: origem não identificada. Recarregue a página e tente de novo.',
        codigo: 'origem_desconhecida'
      });
    }
    try {
      if (new URL(referer).origin !== permitido) {
        return res.status(403).json({ erro: 'Requisição bloqueada.', codigo: 'origem_invalida' });
      }
    } catch {
      return res.status(403).json({ erro: 'Requisição bloqueada.', codigo: 'origem_invalida' });
    }
    return next();
  }

  if (origem === permitido) return next();

  if (origem === 'null' || !/^https?:\/\//.test(origem)) {
    return res.status(403).json({ erro: 'Requisição bloqueada.', codigo: 'origem_invalida' });
  }

  return res.status(403).json({ erro: 'Requisição bloqueada.', codigo: 'origem_invalida' });
}

function aplicarCsrf(req, res, next) {
  if (METODOS_SEGUROS.has(req.method)) return next();
  // Token da extensão: não há cookie nem cabeçalho CSRF para conferir.
  if (temTokenBearer(req)) return next();

  const cookie = req.cookies?.[config.CSRF_COOKIE];
  const header = req.get(config.CSRF_HEADER);

  if (!cookie || !header || cookie.length !== header.length) {
    if (!cookie || !header) {
      log.warn('csrf_bloqueado', { rota: req.originalUrl, ip: clienteIp(req) });
    }
    return res.status(403).json({
      erro: 'Sessão expirada no navegador. Atualize a página e tente novamente.',
      codigo: 'csrf_invalido'
    });
  }

  const a = Buffer.from(cookie);
  const b = Buffer.from(header);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    log.warn('csrf_bloqueado', { rota: req.originalUrl, ip: clienteIp(req) });
    return res.status(403).json({ erro: 'Sessão expirada no navegador.', codigo: 'csrf_invalido' });
  }

  next();
}

function definirCookie(res, nome, valor, maxAgeSegundos) {
  const partes = [
    `${nome}=${valor}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${maxAgeSegundos}`
  ];
  if (config.COOKIE_SECURE) partes.push('Secure');
  res.append('Set-Cookie', partes.join('; '));
}

function definirCookieLegivel(res, nome, valor, maxAgeSegundos) {
  const partes = [`${nome}=${valor}`, 'Path=/', 'SameSite=Lax', `Max-Age=${maxAgeSegundos}`];
  if (config.COOKIE_SECURE) partes.push('Secure');
  res.append('Set-Cookie', partes.join('; '));
}

// Token de CSRF fica em cookie legível (padrão double-submit): o navegador
// precisa ler esse cookie e enviá-lo de volta no header. Um site externo não
// consegue ler o cookie do Postador, então não consegue forjar o header.
function emitirCsrf(res) {
  const token = novoToken(24);
  definirCookieLegivel(res, config.CSRF_COOKIE, token, config.SESSION_DAYS * 86400);
  return token;
}

function rotacionarCsrf(res) {
  return emitirCsrf(res);
}

function assegurarCsrf(req, res) {
  if (req.cookies?.[config.CSRF_COOKIE]) return;
  emitirCsrf(res);
}

module.exports = {
  hashToken,
  novoToken,
  gerarSenha,
  criarRateLimit,
  clienteIp,
  usuarioId,
  definirCookie,
  definirCookieLegivel,
  emitirCsrf,
  rotacionarCsrf,
  assegurarCsrf,
  aplicarOrigem,
  aplicarCsrf,
  idDaExtensao,
  origemExtensaoPermitida,
  temTokenBearer,
  METODOS_SEGUROS
};
