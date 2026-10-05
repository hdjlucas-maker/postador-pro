'use strict';

// Armazenamento local da extensão.
//
// Regra do projeto: imagens vão para o IndexedDB (a cota do chrome.storage
// estoura com imagem); o resto (campanhas, histórico, licença, configuração)
// vai para o chrome.storage.local.

const DB_NOME = 'postador-pro';
const DB_VERSAO = 1;
const STORE_IMAGENS = 'imagens';

function abrirBanco() {
  return new Promise((resolve, reject) => {
    const pedido = indexedDB.open(DB_NOME, DB_VERSAO);
    pedido.onupgradeneeded = () => {
      const db = pedido.result;
      if (!db.objectStoreNames.contains(STORE_IMAGENS)) {
        db.createObjectStore(STORE_IMAGENS, { keyPath: 'id' });
      }
    };
    pedido.onsuccess = () => resolve(pedido.result);
    pedido.onerror = () => reject(pedido.error);
  });
}

async function imagemSalvar(id, blob) {
  const db = await abrirBanco();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_IMAGENS, 'readwrite');
    tx.objectStore(STORE_IMAGENS).put({ id, blob, salvoEm: Date.now() });
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function imagemBuscar(id) {
  const db = await abrirBanco();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_IMAGENS, 'readonly');
    const req = tx.objectStore(STORE_IMAGENS).get(id);
    req.onsuccess = () => resolve(req.result ? req.result.blob : null);
    req.onerror = () => reject(req.error);
  });
}

async function imagemApagar(id) {
  const db = await abrirBanco();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_IMAGENS, 'readwrite');
    tx.objectStore(STORE_IMAGENS).delete(id);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

// --- chrome.storage.local (dados pequenos) ---

function storageGet(chaves) {
  return new Promise(resolve => chrome.storage.local.get(chaves, resolve));
}

function storageSet(objeto) {
  return new Promise(resolve => chrome.storage.local.set(objeto, resolve));
}

function storageRemove(chaves) {
  return new Promise(resolve => chrome.storage.local.remove(chaves, resolve));
}

async function carregarEstado() {
  const dados = await storageGet([
    'token', 'licenca', 'acesso', 'campanhas', 'historico', 'config',
    'ultimaVerificacao', 'ultimaPublicacao', 'contadoresDia', 'consentimento'
  ]);
  return {
    token: dados.token || null,
    licenca: dados.licenca || null,
    acesso: dados.acesso || null,
    campanhas: dados.campanhas || [],
    historico: dados.historico || [],
    config: dados.config || null,
    ultimaVerificacao: dados.ultimaVerificacao || 0,
    ultimaPublicacao: dados.ultimaPublicacao || 0,
    contadoresDia: dados.contadoresDia || { data: null, grupos: 0 },
    consentimento: dados.consentimento || false
  };
}

async function salvarEstado(estado) {
  await storageSet({
    token: estado.token,
    licenca: estado.licenca,
    acesso: estado.acesso,
    campanhas: estado.campanhas,
    historico: estado.historico,
    config: estado.config,
    ultimaVerificacao: estado.ultimaVerificacao,
    ultimaPublicacao: estado.ultimaPublicacao,
    contadoresDia: estado.contadoresDia,
    consentimento: estado.consentimento
  });
}

async function registrarPublicacao() {
  const estado = await carregarEstado();
  const hoje = hojeChave();
  if (!estado.contadoresDia || estado.contadoresDia.data !== hoje) {
    estado.contadoresDia = { data: hoje, grupos: 0 };
  }
  estado.contadoresDia.grupos += 1;
  estado.ultimaPublicacao = Date.now();
  await salvarEstado(estado);
  return estado.contadoresDia.grupos;
}

function hojeChave() {
  return new Date().toISOString().slice(0, 10);
}

export {
  salvarImagem: imagemSalvar,
  buscarImagem: imagemBuscar,
  apagarImagem: imagemApagar,
  carregarEstado,
  salvarEstado,
  registrarPublicacao,
  hojeChave
};
