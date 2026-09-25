'use strict';

const fs = require('fs');
const puppeteer = require('puppeteer');
const config = require('./config');
const log = require('./log');

// O puppeteer baixa o Chromium na instalação. Em máquina sem internet, ou
// quando o download é interrompido, o caminho do navegador pode vir de fora
// (um Chrome do sistema, por exemplo). Se o caminho configurado não existir,
// a publicação para com uma mensagem clara em vez de um erro genérico do
// puppeteer que ninguém entende.
function caminhoNavegador() {
  const caminho = config.CHROME_PATH;

  if (!caminho) return undefined;

  if (!fs.existsSync(caminho)) {
    throw new Error(
      `CHROME_PATH aponta para um arquivo que não existe: ${caminho}. ` +
        'Ajuste a variável ou rode "npx puppeteer browsers install chrome".'
    );
  }

  return caminho;
}

async function abrirNavegador(userDataDir, opcoes = {}) {
  const executablePath = caminhoNavegador();

  if (executablePath) {
    log.info('navegador_externo', { caminho: executablePath });
  }

  const navegador = await puppeteer.launch({
    headless: false,
    userDataDir,
    // Chrome do sistema não pode ser fechado pelo puppeteer sem travar o
    // perfil do usuário.
    ...(executablePath ? { executablePath } : {}),
    args: [
      '--start-maximized',
      '--no-sandbox',
      '--disable-notifications',
      '--disable-blink-features=AutomationControlled'
    ],
    ...opcoes
  });

  return navegador;
}

module.exports = { abrirNavegador, caminhoNavegador };
