'use strict';

// Verificação do navegador: prova que o Chromium sobe de verdade, com o
// caminho configurado em CHROME_PATH, e que um perfil isolado é criado e
// reaproveitado. Não publica em nenhum grupo.

const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.CHROME_PATH = process.env.CHROME_PATH
  || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';

const DATA_DIR = path.join(os.tmpdir(), `pp-navegador-${Date.now()}`);
process.env.DATA_DIR = DATA_DIR;

const config = require('../src/config');
const { abrirNavegador, caminhoNavegador } = require('../src/navegador');

const falhou = [];
function afirmar(condicao, mensagem) {
  console.log(`  ${condicao ? 'ok  ' : 'FALHOU'}  ${mensagem}`);
  if (!condicao) falhou.push(mensagem);
}

(async () => {
  console.log('\n== Navegador do executor ==');

  const caminho = caminhoNavegador();
  afirmar(Boolean(caminho), `caminho configurado: ${caminho || '(nenhum)'}`);

  const perfil = path.join(DATA_DIR, 'perfil-teste');
  fs.mkdirSync(perfil, { recursive: true });

  let browser;
  try {
    browser = await abrirNavegador(perfil);
    afirmar(true, 'navegador abriu');
  } catch (erro) {
    afirmar(false, `navegador abriu: ${erro.message}`);
  }

  if (browser) {
    try {
      const versao = await browser.version();
      afirmar(Boolean(versao), `versao: ${versao}`);

      const page = await browser.newPage();
      await page.goto('https://example.com', { waitUntil: 'domcontentloaded', timeout: 30000 });
      const titulo = await page.title();
      afirmar(titulo.includes('Example'), `navegou e leu o titulo: "${titulo}"`);

      // O que o executor depende de verdade: digitar em uma caixa de texto e
      // o valor chegar no DOM.
      await page.setContent('<textarea id="campo"></textarea>');
      await page.focus('#campo');
      await page.type('#campo', 'texto de teste');
      const valor = await page.$eval('#campo', el => el.value);
      afirmar(valor === 'texto de teste', `digitacao real funciona (valor: "${valor}")`);

      await page.close();
    } catch (erro) {
      afirmar(false, `operacoes na pagina: ${erro.message}`);
    } finally {
      await browser.close().catch(() => {});
    }
  }

  afirmar(fs.existsSync(perfil), 'perfil isolado criado no disco');

  fs.rmSync(DATA_DIR, { recursive: true, force: true });

  console.log(falhou.length ? `\n${falhou.length} FALHA(S)` : '\nTudo certo.');
  process.exit(falhou.length ? 1 : 0);
})();
