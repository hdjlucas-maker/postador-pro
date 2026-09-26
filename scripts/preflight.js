'use strict';

// Verificação antes de subir para produção.
//
//   node scripts/preflight.js
//
// O servidor é a API de licença, então o que precisa existir aqui é espaço em
// disco, permissão de escrita e configuração válida. Não há navegador para
// conferir: a publicação acontece no navegador do cliente.

const fs = require('fs');
const path = require('path');

const config = require('../src/config');

const erros = [];
const avisos = [];
const infos = [];

function erro(mensagem) {
  erros.push(mensagem);
}
function aviso(mensagem) {
  avisos.push(mensagem);
}
function info(mensagem) {
  infos.push(mensagem);
}

// --- Configuração -----------------------------------------------------------

const { problemas, avisos: avisosConfig } = config.validarConfig();
for (const p of problemas) erro(p);
for (const a of avisosConfig) aviso(a);

if (!config.IS_PROD) {
  aviso('NODE_ENV não é production: o app vai rodar sem as travas de produção.');
}

// --- Sistema de arquivos ----------------------------------------------------

for (const [nome, dir] of [
  ['DATA_DIR', config.DATA_DIR],
  ['BACKUP_DIR', config.BACKUP_DIR]
]) {
  try {
    fs.mkdirSync(dir, { recursive: true });
    const teste = path.join(dir, `.escrita-${process.pid}`);
    fs.writeFileSync(teste, 'ok');
    fs.unlinkSync(teste);
  } catch (falha) {
    erro(`${nome} sem permissão de escrita (${dir}): ${falha.message}`);
  }
}

// O limite é do filesystem onde fica o DATA_DIR, que pode ser outro mount.
const raizDados = path.parse(config.DATA_DIR).root;

function bytesLivres(dir) {
  try {
    const stat = fs.statfsSync(dir);
    return stat.bavail * stat.bsize;
  } catch {
    return null;
  }
}

const livres = bytesLivres(raizDados);
if (livres !== null) {
  const gb = livres / 1024 ** 3;
  if (gb < 1) {
    erro(`Disco com ${gb.toFixed(1)} GB livres (em ${raizDados}). O banco e os backups precisam de espaço.`);
  } else if (gb < 5) {
    aviso(`Disco com ${gb.toFixed(1)} GB livres. Considere mais espaço para o histórico de backup.`);
  } else {
    info(`Disco: ${gb.toFixed(1)} GB livres`);
  }
}

// --- Execução ---------------------------------------------------------------

info(`Node ${process.version} | NODE_ENV=${process.env.NODE_ENV || '(vazio)'}`);
info(`URL pública: ${config.PUBLIC_BASE_URL}`);
info(`Backup a cada ${config.BACKUP_MINUTOS} min, mantendo ${config.BACKUPS_MAXIMOS} cópias`);

// --- Resultado --------------------------------------------------------------

for (const i of infos) console.log(`  info    ${i}`);
for (const a of avisos) console.warn(`  AVISO   ${a}`);
for (const e of erros) console.error(`  ERRO    ${e}`);

if (erros.length) {
  console.error(`\n${erros.length} erro(s) que impedem a subida.`);
  process.exit(1);
}

console.log(`\nPode subir.${avisos.length ? ` ${avisos.length} aviso(s) para conferir.` : ''}`);
