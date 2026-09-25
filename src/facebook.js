'use strict';

const fs = require('fs');
const path = require('path');
const config = require('./config');
const log = require('./log');
const { abrirNavegador } = require('./navegador');

const navegadores = new Map();

function segmentoSeguro(valor) {
  return String(valor || '').replace(/[^a-zA-Z0-9_-]/g, '_');
}

function profileDir(userId, accountId) {
  return path.join(config.PROFILES_DIR, segmentoSeguro(userId), segmentoSeguro(accountId));
}

function chave(userId, accountId) {
  return `${userId}:${accountId}`;
}

function ehConectado(browser) {
  return Boolean(browser && browser.process && browser.process().connected);
}

async function abrirNavegadorFacebook(accountId, userId) {
  if (!accountId || !userId) {
    throw new Error('accountId e userId são obrigatórios.');
  }

  const k = chave(userId, accountId);
  const existente = navegadores.get(k);

  if (ehConectado(existente)) {
    existente.ultimoUso = Date.now();
    return existente;
  }

  if (navegadores.size >= config.MAX_NAVEGADORES_CONCORRENTES) {
    await fecharMaisAntigo();
  }

  const dir = profileDir(userId, accountId);
  fs.mkdirSync(dir, { recursive: true });

  const browser = await abrirNavegador(dir, { defaultViewport: null });

  const registro = { browser, dir, userId, accountId, abertoEm: Date.now(), ultimoUso: Date.now() };
  navegadores.set(k, registro);

  browser.on('disconnected', () => {
    if (navegadores.get(k)?.browser === browser) navegadores.delete(k);
  });

  const pages = await browser.pages();
  const page = pages[0] || (await browser.newPage());

  await page.goto('https://www.facebook.com/', { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(erro => {
    log.warn('facebook_abrir_home', { accountId, erro: erro.message });
  });

  log.info('facebook_janela_aberta', { accountId, userId });
  return registro;
}

async function fecharMaisAntigo() {
  let alvo = null;
  for (const registro of navegadores.values()) {
    if (!alvo || registro.ultimoUso < alvo.ultimoUso) alvo = registro;
  }
  if (alvo) {
    await fecharPorChave(chave(alvo.userId, alvo.accountId));
  }
}

async function fecharPorChave(k) {
  const registro = navegadores.get(k);
  if (!registro) return;
  navegadores.delete(k);
  try {
    await registro.browser.close();
  } catch (erro) {
    log.warn('facebook_fechar', { chave: k, erro: erro.message });
  }
}

async function fecharNavegadorFacebook(accountId, userId) {
  await fecharPorChave(chave(userId, accountId));
}

function listarAbertos() {
  return [...navegadores.values()].map(r => ({
    userId: r.userId,
    accountId: r.accountId,
    abertoEm: r.abertoEm,
    ultimoUso: r.ultimoUso
  }));
}

async function fecharTodos() {
  const chaves = [...navegadores.keys()];
  for (const k of chaves) {
    await fecharPorChave(k);
  }
}

async function encerrarOciosos() {
  const agora = Date.now();
  for (const [k, registro] of navegadores.entries()) {
    if (agora - registro.ultimoUso > config.NAVEGADOR_IDLE_MS) {
      log.info('facebook_janela_ociosa', { accountId: registro.accountId });
      await fecharPorChave(k);
    }
  }
}

// O cookie c_user só existe no perfil quando há sessão ativa do Facebook.
// Essa leitura funciona mesmo com a janela fechada, o que permite mostrar
// "Conectada" sem exigir o navegador aberto.
function sessaoSalvaNoPerfil(userId, accountId) {
  const dir = profileDir(userId, accountId);

  for (const relativo of ['Default/Cookies', 'Default/Network/Cookies']) {
    const arquivo = path.join(dir, ...relativo.split('/'));
    if (!fs.existsSync(arquivo)) continue;
    try {
      const conteudo = fs.readFileSync(arquivo);
      if (conteudo.includes('c_user') || conteudo.includes('xs')) {
        return true;
      }
    } catch (erro) {
      log.warn('facebook_ler_cookies', { accountId, erro: erro.message });
    }
  }

  return false;
}

const ROTAS_DE_LOGIN = /\/login|\/checkpoint|\/recover|\/confirmemail|\/logout/i;

async function statusFacebook(accountId, userId) {
  const registro = navegadores.get(chave(userId, accountId));
  const aberto = ehConectado(registro?.browser);
  let url = '';
  let conectado = sessaoSalvaNoPerfil(userId, accountId);

  if (aberto) {
    registro.ultimoUso = Date.now();
    try {
      const pages = await registro.browser.pages();
      const page = pages[0];
      if (page) {
        url = page.url();
        if (ROTAS_DE_LOGIN.test(url)) conectado = false;
        else {
          const temSessao = await page
            .evaluate(() => Boolean(document.cookie.includes('c_user') || document.querySelector('[data-testid="profile_photo"]')))
            .catch(() => false);
          if (temSessao) conectado = true;
        }
      }
    } catch (erro) {
      log.warn('facebook_status', { accountId, erro: erro.message });
    }
  }

  return { browserOpen: aberto, connected: conectado, url };
}

module.exports = {
  abrirNavegadorFacebook,
  fecharNavegadorFacebook,
  statusFacebook,
  sessaoSalvaNoPerfil,
  profileDir,
  fecharTodos,
  listarAbertos,
  encerrarOciosos
};
