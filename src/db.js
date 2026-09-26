'use strict';

const path = require('path');
const fs = require('fs');
const Datastore = require('nedb-promises');
const config = require('./config');
const log = require('./log');

// Coleções da API de licença. Campanha, publicação, conta conectada e upload
// não existem aqui: esses dados vivem no navegador do cliente.
const COLECOES = ['users', 'sessions', 'payments', 'resets'];

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
    db.payments.ensureIndex({ fieldName: 'order_nsu', unique: true }),
    db.payments.ensureIndex({ fieldName: 'userId' }),
    db.resets.ensureIndex({ fieldName: 'tokenHash' }),
    db.resets.ensureIndex({ fieldName: 'expiraEm' })
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

  manterBackups(config.BACKUPS_MAXIMOS);
  log.info('backup_concluido', { destino, arquivos: arquivos.length, mantidos: config.BACKUPS_MAXIMOS });
  return destino;
}

function manterBackups(quantidade) {
  const entradas = listarBackups();

  while (entradas.length > quantidade) {
    const antigo = entradas.shift();
    fs.rmSync(path.join(config.BACKUP_DIR, antigo), { recursive: true, force: true });
  }
}

// Os nomes seguem o formato ISO, então ordenar por nome equivale a ordenar por
// tempo. Mais antigo primeiro.
function listarBackups() {
  return fs
    .readdirSync(config.BACKUP_DIR, { withFileTypes: true })
    .filter(entry => entry.isDirectory() && entry.name.startsWith('backup-'))
    .map(entry => entry.name)
    .sort();
}

// Um backup que não pode ser restaurado não é backup. Copia os arquivos de uma
// cópia de volta para o diretório de dados, preservando o que não existir
// naquele backup.
function restaurar(nomeBackup) {
  const origem = path.join(config.BACKUP_DIR, path.basename(String(nomeBackup || '')));

  if (!listarBackups().includes(path.basename(origem))) {
    throw new Error(`Backup não encontrado: ${origem}`);
  }

  const arquivos = fs.readdirSync(origem).filter(nome => nome.endsWith('.db'));
  if (!arquivos.length) {
    throw new Error(`Backup sem arquivos de banco: ${origem}`);
  }

  const restaurados = [];
  for (const nome of arquivos) {
    const de = path.join(origem, nome);
    const para = path.join(config.DATA_DIR, nome);
    fs.copyFileSync(de, para);
    restaurados.push(nome);
  }

  log.warn('backup_restaurado', { origem, arquivos: restaurados.length, colecoes: restaurados });
  return { origem, arquivos: restaurados };
}

module.exports = {
  db,
  iniciar,
  compactarTodas,
  backup,
  restaurar,
  listarBackups,
  COLECOES,
  listarArquivos
};
