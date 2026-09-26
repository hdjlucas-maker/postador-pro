'use strict';

// Log em JSON, uma linha por evento.
//
// No `wrangler dev` e no `wrangler tail` o Worker escreve em `console`, e o
// runtime transforma cada chamada em uma linha de log com timestamp próprio. A
// sanitização abaixo é o que importa: sem ela, um `log.info` com o corpo da
// requisição vazaria senha ou token para o log da plataforma.

const REDACT = new Set([
  'senhaHash',
  'senha',
  'senhaAtual',
  'novaSenha',
  'password',
  'passwordHash',
  'token',
  'csrfToken',
  'authorization',
  'SMTP_PASS',
  'link',
  'linkDev'
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
  const entry = { ts: new Date().toISOString(), nivel, evento, ...sanitizar(extras || {}) };
  const linha = JSON.stringify(entry);
  if (nivel === 'error') console.error(linha);
  else console.log(linha);
}

const info = (evento, extras) => log('info', evento, extras);
const warn = (evento, extras) => log('warn', evento, extras);
const erro = (evento, extras) => log('error', evento, extras);
const debug = (evento, extras) => log('info', evento, extras);

module.exports = { log, info, warn, erro, error: erro, debug, sanitizar };
