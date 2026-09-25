'use strict';

const path = require('path');
const config = require('./config');
const log = require('./log');
const { abrirNavegador } = require('./navegador');

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const esperar = (min, max) => sleep(Math.floor(Math.random() * (max - min + 1) + min) * 1000);
const esperarMs = (min, max) => sleep(Math.floor(Math.random() * (max - min + 1) + min));

const SELETOR_ESCREVER = 'div[role="button"]::-p-text(Escreva algo...)';
const CAIXA_TEXTO = 'div[role="textbox"]';
const BOTAO_PUBLICAR = 'div[aria-label="Publicar"]';
const BOTAO_MIDIA = 'div[aria-label="Foto/vídeo"]';

const MOTIVO_DESLOGADO = 'Sessão do Facebook expirou. Reconecte a conta em Contas Facebook.';

async function rolarPaginaNatural(page) {
  const voltas = 2 + Math.floor(Math.random() * 3);

  for (let i = 0; i < voltas; i++) {
    const passos = 2 + Math.floor(Math.random() * 4);
    for (let s = 0; s < passos; s++) {
      await page.mouse.wheel({ deltaY: 130 + Math.floor(Math.random() * 220) });
      await esperarMs(140, 420);
    }
    await esperarMs(550, 1300);
  }

  await page.evaluate(() => window.scrollTo({ top: 0 }));
  await esperarMs(400, 900);
}

async function digitarComCadencia(page, caixaTexto, texto) {
  await page.focus(caixaTexto);
  let desdePausa = 0;

  for (const caractere of texto) {
    await page.type(caixaTexto, caractere);
    await esperarMs(config.CADENCIA_MIN_MS, config.CADENCIA_MAX_MS);
    desdePausa++;

    if (desdePausa >= 14 + Math.floor(Math.random() * 8)) {
      await esperarMs(700, 1900);
      desdePausa = 0;
    }
  }

  await page.evaluate(selector => {
    const elemento = document.querySelector(selector);
    if (elemento) elemento.dispatchEvent(new Event('input', { bubbles: true }));
  }, caixaTexto);
}

async function publicarNoGrupo(browser, post, verificarLogin) {
  const page = await browser.newPage();

  try {
    await page.setViewport({ width: 1366, height: 768 });
    page.setDefaultTimeout(30000);

    const pool = Array.isArray(post.textos) && post.textos.length ? post.textos : [''];
    const textoEscolhido = pool[Math.floor(Math.random() * pool.length)];
    const imagens = Array.isArray(post.imagens) ? post.imagens.filter(Boolean) : [];
    const imagemEscolhida = imagens.length ? imagens[Math.floor(Math.random() * imagens.length)] : null;

    await page.goto(post.grupoUrl, { waitUntil: 'networkidle2', timeout: 60000 });
    await esperar(6, 10);
    await rolarPaginaNatural(page);

    const editorVisivel = await page
      .waitForSelector(SELETOR_ESCREVER, { timeout: verificarLogin ? 10000 : 6000 })
      .then(() => true)
      .catch(() => false);

    if (!editorVisivel) {
      const urlAtual = page.url();
      if (/login|checkpoint|recover|confirmemail/i.test(urlAtual)) {
        throw new Error(MOTIVO_DESLOGADO);
      }
      throw new Error('O editor de publicação não apareceu neste destino (permissão ou grupo indisponível).');
    }

    await page.click(SELETOR_ESCREVER);
    await esperar(4, 6);

    await page.waitForSelector(CAIXA_TEXTO);
    await digitarComCadencia(page, CAIXA_TEXTO, textoEscolhido);
    await esperar(3, 5);

    if (imagemEscolhida) {
      const [fileChooser] = await Promise.all([
        page.waitForFileChooser({ timeout: 15000 }),
        page.click(BOTAO_MIDIA)
      ]);
      await fileChooser.accept([imagemEscolhida]);
      await esperar(8, 12);
    }

    await page.mouse.wheel({ deltaY: 240 + Math.floor(Math.random() * 120) });
    await esperar(500, 1200);

    await page.click(BOTAO_PUBLICAR);
    await esperar(10, 15);

    const editorFechou = await page
      .waitForSelector(CAIXA_TEXTO, { hidden: true, timeout: 20000 })
      .then(() => true)
      .catch(() => false);

    return { sucesso: true, confirmacaoVisual: editorFechou };
  } catch (erro) {
    return { sucesso: false, erro: String(erro.message || erro) };
  } finally {
    await page.close().catch(() => {});
  }
}

function resultadosVazios(total, erro, ate) {
  const lista = [];
  for (let i = ate; i < total; i++) {
    lista.push({ sucesso: false, erro });
  }
  return lista;
}

async function dispararPostagens({ posts }) {
  if (!posts || !posts.length) {
    throw new Error('Nenhum destino para publicar.');
  }

  const primeiro = posts[0];
  const pastaPerfilIsolado = primeiro.profileDir || path.join(config.PROFILES_DIR, primeiro.perfilId);

  let browser = null;
  const resultados = [];

  try {
    browser = await abrirNavegador(pastaPerfilIsolado);

    for (let i = 0; i < posts.length; i++) {
      const post = posts[i];
      const resultado = await publicarNoGrupo(browser, post, i === 0);
      resultados.push(resultado);

      if (i < posts.length - 1 && resultado.sucesso) {
        await esperar(config.DELAY_ENTRE_POSTS_MIN, config.DELAY_ENTRE_POSTS_MAX);
      }
    }
  } catch (erro) {
    const mensagem = String(erro.message || erro);
    log.error('executor_falha', { erro: mensagem, publicacoes: posts.length });
    resultados.push(...resultadosVazios(posts.length, mensagem, resultados.length));
  } finally {
    if (browser) {
      try {
        await browser.close();
      } catch (erro) {
        log.warn('executor_fechar', { erro: erro.message });
      }
    }
  }

  return resultados;
}

async function dispararPostagem(post) {
  const resultados = await dispararPostagens({ posts: [post] });
  return resultados[0];
}

module.exports = { dispararPostagem, dispararPostagens };
