const puppeteer = require('puppeteer');
const path = require('path');
const fs = require('fs');

const browsers = new Map();

function safeSegment(value) {
  return String(value || '').replace(/[^a-zA-Z0-9_-]/g, '_');
}

function profileDir(userId, accountId) {
  return path.join(
    __dirname,
    'facebook-profiles',
    safeSegment(userId),
    safeSegment(accountId)
  );
}

async function abrirNavegadorFacebook(accountId, userId) {
  if (!accountId || !userId) {
    throw new Error('accountId e userId são obrigatórios.');
  }

  const key = `${userId}:${accountId}`;

  const existing = browsers.get(key);

  if (
    existing &&
    existing.process &&
    existing.process() &&
    existing.process().connected
  ) {
    return existing;
  }

  const dir = profileDir(userId, accountId);
  fs.mkdirSync(dir, { recursive: true });

  const browser = await puppeteer.launch({
    headless: false,
    userDataDir: dir,
    defaultViewport: null,
    args: ['--start-maximized']
  });

  browsers.set(key, browser);

  browser.on('disconnected', () => {
    browsers.delete(key);
  });

  const pages = await browser.pages();
  const page = pages[0] || await browser.newPage();

  await page.goto('https://www.facebook.com/', {
    waitUntil: 'domcontentloaded',
    timeout: 60000
  });

  return browser;
}

async function statusFacebook(accountId, userId) {
  const key = `${userId}:${accountId}`;
  const browser = browsers.get(key);

  if (
    !browser ||
    !browser.process ||
    !browser.process() ||
    !browser.process().connected
  ) {
    return {
      browserOpen: false,
      connected: false
    };
  }

  const pages = await browser.pages();
  const page = pages[0];

  if (!page) {
    return {
      browserOpen: true,
      connected: false,
      url: ''
    };
  }

  const url = page.url();

  const looksLikeLoginPage =
    /\/login|\/checkpoint|\/recover|\/confirmemail/i.test(url);

  return {
    browserOpen: true,
    connected: !looksLikeLoginPage,
    url
  };
}

async function fecharNavegadorFacebook(accountId, userId) {
  const key = `${userId}:${accountId}`;
  const browser = browsers.get(key);

  if (!browser) return;

  try {
    await browser.close();
  } finally {
    browsers.delete(key);
  }
}

module.exports = {
  abrirNavegadorFacebook,
  statusFacebook,
  fecharNavegadorFacebook,
  profileDir
};