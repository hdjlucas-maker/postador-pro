'use strict';

const config = require('./config');

const REDACT = new Set([
  'senhaHash',
  'senha',
  'password',
  'passwordHash',
  'token',
  'csrfToken',
  'SMTP_PASS',
  'authorization'
]);

function sanitizar(valor, profundidade = 0) {
  if (profundidade > 4) return '[...]';
  if (valor === null || valor === undefined) return valor;
  if (valor instanceof Date) return valor.toISOString();
  if (Array.isArray(valor)) return valor.slice(0, 50).map(item => sanitizar(item, profundidade + 1));
  if (typeof valor === 'object') {
    const out = {};
    for (const [chave, item] of Object.entries(valor)) {
      out[chave] = REDACT.has(chave) ? '[redigido]' : sanitizar(item, profundidade + 1);
    }
    return out;
  }
  return valor;
}

function log(nivel, evento, extras) {
  const entry = {
    ts: new Date().toISOString(),
    nivel,
    evento,
    ...sanitizar(extras || {})
  };

  const linha = JSON.stringify(entry);

  if (nivel === 'error') console.error(linha);
  else console.log(linha);
}

const info = (evento, extras) => log('info', evento, extras);
const warn = (evento, extras) => log('warn', evento, extras);
const erro = (evento, extras) => log('error', evento, extras);
const debug = (evento, extras) => {
  if (!config.IS_PROD) log('info', evento, extras);
};

// `error` é o alias usado pelas chamadas; `erro` permanece disponível.
module.exports = { log, info, warn, erro, error: erro, debug, sanitizar };
