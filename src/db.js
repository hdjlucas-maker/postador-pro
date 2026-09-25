'use strict';

const path = require('path');
const fs = require('fs');
const Datastore = require('nedb-promises');
const config = require('./config');
const log = require('./log');

const COLECOES = ['users', 'sessions', 'accounts', 'campaigns', 'posts', 'payments', 'resets', 'uploads'];

const db = {};

function criar(nome) {
  return Datastore.create({
    filename: path.join(config.DATA_DIR, `${nome}.db`),
    autoload: true
  });
}

async function iniciar() {
  for (const nome of COLECOES) {
    db[nome] = criar(nome);
  }

  await Promise.all([
    db.users.ensureIndex({ fieldName: 'email', unique: true }),
    db.sessions.ensureIndex({ fieldName: 'tokenHash' }),
    db.sessions.ensureIndex({ fieldName: 'userId' }),
    db.sessions.ensureIndex({ fieldName: 'expiresAt' }),
    db.accounts.ensureIndex({ fieldName: 'userId' }),
    db.campaigns.ensureIndex({ fieldName: 'userId' }),
    db.campaigns.ensureIndex({ fieldName: 'userId', fieldName2: 'status' }),
    db.posts.ensureIndex({ fieldName: 'userId' }),
    db.posts.ensureIndex({ fieldName: 'campanhaId' }),
    db.posts.ensureIndex({ fieldName: 'userId', fieldName2: 'status' }),
    db.posts.ensureIndex({ fieldName: 'userId', fieldName2: 'accountId' }),
    db.posts.ensureIndex({ fieldName: 'status', fieldName2: 'dataExecucao' }),
    db.payments.ensureIndex({ fieldName: 'order_nsu', unique: true }),
    db.payments.ensureIndex({ fieldName: 'userId' }),
    db.resets.ensureIndex({ fieldName: 'tokenHash' }),
    db.resets.ensureIndex({ fieldName: 'expiraEm' }),
    db.uploads.ensureIndex({ fieldName: 'userId' }),
    db.uploads.ensureIndex({ fieldName: 'userId', fieldName2: 'campaignIds' })
  ]);

  log.info('db_pronta', { dir: config.DATA_DIR, colecoes: COLECOES });
}

async function compactarTodas() {
  for (const nome of COLECOES) {
    try {
      await db[nome].compactDatafile();
    } catch (erro) {
      log.warn('db_compactacao', { colecao: nome, erro: erro.message });
    }
  }
  log.info('db_compactada', { colecoes: COLECOES.length });
}

function listarArquivos() {
  return COLECOES.map(nome => path.join(config.DATA_DIR, `${nome}.db`)).filter(file => fs.existsSync(file));
}

async function backup() {
  const carimbo = new Date().toISOString().replace(/[:.]/g, '-');
  const destino = path.join(config.BACKUP_DIR, `backup-${carimbo}`);
  fs.mkdirSync(destino, { recursive: true });

  const arquivos = listarArquivos();
  for (const arquivo of arquivos) {
    fs.copyFileSync(arquivo, path.join(destino, path.basename(arquivo)));
  }

  for (const nome of COLECOES) {
    try {
      await db[nome].compactDatafile();
      const arquivo = path.join(config.DATA_DIR, `${nome}.db`);
      if (fs.existsSync(arquivo)) {
        fs.copyFileSync(arquivo, path.join(destino, `${nome}.db`));
      }
    } catch (erro) {
      log.warn('backup_compactacao', { colecao: nome, erro: erro.message });
    }
  }

  manterBackups(10);
  log.info('backup_concluido', { destino, arquivos: arquivos.length });
  return destino;
}

function manterBackups(quantidade) {
  const entradas = fs
    .readdirSync(config.BACKUP_DIR, { withFileTypes: true })
    .filter(entry => entry.isDirectory() && entry.name.startsWith('backup-'))
    .map(entry => entry.name)
    .sort();

  while (entradas.length > quantidade) {
    const antigo = entradas.shift();
    fs.rmSync(path.join(config.BACKUP_DIR, antigo), { recursive: true, force: true });
  }
}

module.exports = { db, iniciar, compactarTodas, backup, COLECOES, listarArquivos };
