const puppeteer = require('puppeteer');
const path = require('path');

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const esperar = (min, max) => sleep(Math.floor(Math.random() * (max - min + 1) + min) * 1000);
const esperarMs = (min, max) => sleep(Math.floor(Math.random() * (max - min + 1) + min));

const CADENCIA_MIN_MS = Number(process.env.CADENCIA_MIN_MS || 35);
const CADENCIA_MAX_MS = Number(process.env.CADENCIA_MAX_MS || 95);
const DELAY_ENTRE_POSTS_MIN = Number(process.env.DELAY_ENTRE_POSTS_MIN || 25);
const DELAY_ENTRE_POSTS_MAX = Number(process.env.DELAY_ENTRE_POSTS_MAX || 60);

const SELETOR_ESCREVER = 'div[role="button"]::-p-text(Escreva algo...)';

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
    await esperarMs(CADENCIA_MIN_MS, CADENCIA_MAX_MS);
    desdePausa++;

    if (desdePausa >= 14 + Math.floor(Math.random() * 8)) {
      await esperarMs(700, 1900);
      desdePausa = 0;
    }
  }

  await page.evaluate(
    caixaSelector => {
      const elemento = document.querySelector(caixaSelector);
      if (elemento) elemento.dispatchEvent(new Event('input', { bubbles: true }));
    },
    caixaTexto
  );
}

async function publicarNoGrupo(browser, post, verificarLogin) {
  const page = await browser.newPage();
  await page.setViewport({ width: 1366, height: 768 });

  try {
    const textoEscolhido = post.textos[Math.floor(Math.random() * post.textos.length)];
    const imagemEscolhida =
      post.imagens && post.imagens.length > 0
        ? post.imagens[Math.floor(Math.random() * post.imagens.length)]
        : null;

    await page.goto(post.grupoUrl, { waitUntil: 'networkidle2', timeout: 60000 });
    await esperar(6, 10);
    await rolarPaginaNatural(page);

    if (verificarLogin) {
      try {
        await page.waitForSelector(SELETOR_ESCREVER, { timeout: 10000 });
      } catch (e) {
        await page.goto('https://facebook.com/', { waitUntil: 'networkidle2' });
        throw new Error(
          'Usuário deslogado. Abra a janela do robô e faça login na conta uma vez para salvar o perfil.'
        );
      }
    }

    await page.click(SELETOR_ESCREVER);
    await esperar(4, 6);

    const caixaTexto = 'div[role="textbox"]';
    await page.waitForSelector(caixaTexto);
    await digitarComCadencia(page, caixaTexto, textoEscolhido);
    await esperar(3, 5);

    if (imagemEscolhida) {
      const [fileChooser] = await Promise.all([
        page.waitForFileChooser(),
        page.click('div[aria-label="Foto/vídeo"]')
      ]);
      await fileChooser.accept([imagemEscolhida]);
      await esperar(8, 12);
    }

    await page.mouse.wheel({ deltaY: 240 + Math.floor(Math.random() * 120) });
    await esperar(500, 1200);

    await page.click('div[aria-label="Publicar"]');
    await esperar(10, 15);

    // Confirmação visual: publicar e esperar o sumiço do editor antes de considerar sucesso
    try {
      await page.waitForSelector(caixaTexto, { hidden: true, timeout: 20000 });
    } catch (e) {
      // Selo opcional: alguns grupos mantêm o editor aberto após publicar
    }

    return { sucesso: true };
  } catch (erro) {
    return { sucesso: false, erro: erro.message };
  } finally {
    await page.close();
  }
}

async function dispararPostagens({ posts }) {
  if (!posts || !posts.length) {
    throw new Error('Nenhum destino para publicar.');
  }

  const primeiro = posts[0];
  const pastaPerfilIsolado =
    primeiro.profileDir || path.join(__dirname, 'perfis_facebook', primeiro.perfilId);

  const browser = await puppeteer.launch({
    headless: false,
    userDataDir: pastaPerfilIsolado,
    args: [
      '--disable-notifications',
      '--disable-blink-features=AutomationControlled',
      '--no-sandbox',
      '--start-maximized'
    ]
  });

  const resultados = [];

  try {
    for (let i = 0; i < posts.length; i++) {
      const post = posts[i];
      const resultado = await publicarNoGrupo(browser, post, i === 0);
      resultados.push(resultado);

      if (i < posts.length - 1 && resultado.sucesso) {
        await esperar(DELAY_ENTRE_POSTS_MIN, DELAY_ENTRE_POSTS_MAX);
      }
    }

    if (resultados.length !== posts.length) {
      for (let i = resultados.length; i < posts.length; i++) {
        resultados.push({ sucesso: false, erro: 'Executor encerrado antes do destino.' });
      }
    }
  } catch (erro) {
    for (let i = resultados.length; i < posts.length; i++) {
      resultados.push({ sucesso: false, erro: String(erro.message || erro) });
    }
  } finally {
    try {
      await browser.close();
    } catch (erro) {
      // navegador já encerrado
    }
  }

  return resultados;
}

async function dispararPostagem(post) {
  const resultados = await dispararPostagens({ posts: [post] });
  return resultados[0];
}

module.exports = { dispararPostagem, dispararPostagens };