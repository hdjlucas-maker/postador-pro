'use strict';

// Verificação antes de subir para produção.
//
//   node scripts/preflight.js
//
// Faz o que `deploy-vps.sh` e `update.sh` já checam, mais o que só quebra em
// produção: navegador, espaço em disco, permissões de escrita e o que o
// executor precisa para funcionar.

const fs = require('fs');
const os = require('os');
const path = require('path');

const config = require('../src/config');
const log = require('../src/log');

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

// --- Navegador --------------------------------------------------------------

const chromeDoPuppeteer = (() => {
  try {
    return require('puppeteer').executablePath();
  } catch (erro) {
    return null;
  }
})();

if (config.CHROME_PATH) {
  if (fs.existsSync(config.CHROME_PATH)) {
    info(`Navegador: CHROME_PATH -> ${config.CHROME_PATH}`);
  } else {
    erro(`CHROME_PATH aponta para arquivo inexistente: ${config.CHROME_PATH}`);
  }
} else if (chromeDoPuppeteer && fs.existsSync(chromeDoPuppeteer)) {
  info(`Navegador: Chromium do puppeteer -> ${chromeDoPuppeteer}`);
} else {
  erro(
    'Navegador não encontrado. O executor não abre navegador e a fila nunca ' +
      'publica. Rode "npx puppeteer browsers install chrome" ou defina CHROME_PATH no .env.'
  );
}

// --- Sistema de arquivos ----------------------------------------------------

for (const [nome, dir] of [
  ['DATA_DIR', config.DATA_DIR],
  ['UPLOADS_DIR', config.UPLOADS_DIR],
  ['PROFILES_DIR', config.PROFILES_DIR],
  ['BACKUP_DIR', config.BACKUP_DIR]
]) {
  try {
    fs.mkdirSync(dir, { recursive: true });
    const teste = path.join(dir, `.escrita-${process.pid}`);
    fs.writeFileSync(teste, 'ok');
    fs.unlinkSync(teste);
  } catch (erro) {
    erro(`${nome} sem permissão de escrita (${dir}): ${erro.message}`);
  }
}

// Os perfis do navegador crescem bastante e o Chromium ocupa meio gigabyte.
// O limite é do filesystem onde fica o DATA_DIR, que pode ser outro mount.
const raizDados = path.parse(config.DATA_DIR).root;

function bytesLivres(dir) {
  try {
    const stat = fs.statfsSync(dir);
    return stat.bavail * stat.bsize;
  } catch (erro) {
    return null;
  }
}

const livres = bytesLivres(raizDados);
if (livres !== null) {
  const gb = livres / 1024 ** 3;
  if (gb < 5) {
    erro(`Disco com ${gb.toFixed(1)} GB livres (em ${raizDados}). O Chromium e os perfis do Facebook precisam de espaço.`);
  } else if (gb < 10) {
    aviso(`Disco com ${gb.toFixed(1)} GB livres. Para atender mais clientes, considere mais espaço.`);
  } else {
    info(`Disco: ${gb.toFixed(1)} GB livres`);
  }
}

// --- Display virtual (Linux) ------------------------------------------------

if (os.platform() === 'linux') {
  if (!process.env.DISPLAY) {
    erro('DISPLAY vazio. O Chromium abre em modo headful e precisa do Xvfb (--display :99).');
  } else if (!fs.existsSync(`/tmp/.X11-unix/X${process.env.DISPLAY.replace(':', '')}`)) {
    erro(`DISPLAY=${process.env.DISPLAY} mas não há display virtual. Verifique o serviço do Xvfb.`);
  } else {
    info(`Display virtual: ${process.env.DISPLAY}`);
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
