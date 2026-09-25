'use strict';

const path = require('path');
const express = require('express');
const config = require('./config');
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
  "upgrade-insecure-requests"
].join('; ');

function parseCookies(req, res, next) {
  const header = req.headers.cookie;
  req.cookies = {};

  if (header) {
    for (const parte of header.split(';')) {
      const indice = parte.indexOf('=');
      if (indice < 1) continue;
      const nome = parte.slice(0, indice).trim();
      const valor = parte.slice(indice + 1).trim();
      if (!nome) continue;
      try {
        req.cookies[nome] = decodeURIComponent(valor);
      } catch {
        req.cookies[nome] = valor;
      }
    }
  }

  next();
}

function cabecalhosSeguranca(req, res, next) {
  res.setHeader('Content-Security-Policy', CSP);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'geolocation=(), microphone=(), camera=(), payment=()');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  if (config.COOKIE_SECURE) {
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  }
  res.removeHeader('X-Powered-By');
  next();
}

function naoCacheApi(req, res, next) {
  if (req.path.startsWith('/api/')) {
    res.setHeader('Cache-Control', 'no-store');
  }
  next();
}

function loggerHttp(req, res, next) {
  if (!req.path.startsWith('/api/')) return next();

  const inicio = Date.now();
  res.on('finish', () => {
    log.info('http', {
      metodo: req.method,
      rota: req.originalUrl,
      status: res.statusCode,
      ms: Date.now() - inicio,
      ip: req.ip || req.socket?.remoteAddress,
      userId: req.user?._id
    });
  });

  next();
}

// Somente a pasta public/ é servida. Nada do projeto (fontes, .env, bancos,
// perfis do Facebook) fica exposto pela raiz do repositório.
function estaticos() {
  return express.static(path.join(config.ROOT_DIR, 'public'), {
    index: false,
    dotfiles: 'deny',
    etag: true,
    maxAge: config.IS_PROD ? '1h' : 0,
    setHeaders(res, filePath) {
      if (filePath.endsWith('.html')) {
        res.setHeader('Cache-Control', 'no-store');
      }
    }
  });
}

function naoEncontrado(req, res) {
  if (req.path.startsWith('/api/')) {
    return res.status(404).json({ erro: 'Recurso não encontrado.' });
  }
  res.status(404).type('text/plain; charset=utf-8').send('Não encontrado');
}

module.exports = {
  CSP,
  parseCookies,
  cabecalhosSeguranca,
  naoCacheApi,
  loggerHttp,
  estaticos,
  naoEncontrado
};
