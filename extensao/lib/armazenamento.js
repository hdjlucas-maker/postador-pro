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

async function imagemSalvar(id, dados) {
  const db = await abrirBanco();
  // Os bytes ficam no próprio registro (ArrayBuffer). O formato antigo guardava
  // um Blob, que o Chrome pode liberar separadamente do registro — a imagem
  // "sumia" do armazenamento e a publicação falhava no meio da campanha.
  const registro = {
    id,
    bytes: dados.bytes,
    tipo: dados.tipo || '',
    nome: dados.nome || '',
    salvoEm: Date.now()
  };
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_IMAGENS, 'readwrite');
    tx.objectStore(STORE_IMAGENS).put(registro);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function imagemLerRegistro(id) {
  const db = await abrirBanco();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_IMAGENS, 'readonly');
    const pedido = tx.objectStore(STORE_IMAGENS).get(id);
    pedido.onsuccess = () => resolve(pedido.result || null);
    pedido.onerror = () => reject(pedido.error);
  });
}

async function imagemBuscarDados(id) {
  const registro = await imagemLerRegistro(id).catch(() => null);
  if (!registro) return null;

  if (registro.bytes) {
    return { bytes: registro.bytes, tipo: registro.tipo || '', nome: registro.nome || '' };
  }

  // Formato antigo ({ blob }): converte na primeira leitura para o formato
  // durável. Se o Chrome já tiver liberado o blob, devolve null — é o caso que
  // aparece como "a imagem selecionada não está mais disponível".
  if (registro.blob && registro.blob.size) {
    try {
      const dados = {
        bytes: await registro.blob.arrayBuffer(),
        tipo: registro.blob.type || registro.tipo || '',
        nome: registro.blob.name || registro.nome || ''
      };
      await imagemSalvar(id, dados).catch(() => {});
      return dados;
    } catch (_) {
      return null;
    }
  }

  return null;
}

async function imagemBuscar(id) {
  const dados = await imagemBuscarDados(id);
  if (!dados || !dados.bytes || !dados.bytes.byteLength) return null;
  // A prévia das telas continua recebendo um Blob; o envio usa os bytes.
  return new Blob([dados.bytes], { type: dados.tipo || '' });
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
    'ultimaVerificacao', 'ultimaPublicacao', 'proximaPublicacaoEm', 'ultimoErroPublicacao', 'execucao', 'contadoresDia', 'consentimento'
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
    proximaPublicacaoEm: dados.proximaPublicacaoEm || 0,
    ultimoErroPublicacao: dados.ultimoErroPublicacao || '',
    execucao: dados.execucao || { fase: 'parado', mensagem: 'Nenhuma execução em andamento.' },
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
    proximaPublicacaoEm: estado.proximaPublicacaoEm || 0,
    ultimoErroPublicacao: estado.ultimoErroPublicacao || '',
    execucao: estado.execucao || { fase: 'parado', mensagem: 'Nenhuma execução em andamento.' },
    contadoresDia: estado.contadoresDia,
    consentimento: estado.consentimento
  });
}

function hojeChave() {
  const agora = new Date();
  return `${agora.getFullYear()}-${String(agora.getMonth() + 1).padStart(2, '0')}-${String(agora.getDate()).padStart(2, '0')}`;
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

export {
  imagemSalvar as salvarImagem,
  imagemBuscar as buscarImagem,
  imagemBuscarDados as buscarImagemDados,
  imagemApagar as apagarImagem,
  carregarEstado,
  salvarEstado,
  registrarPublicacao,
  hojeChave
};
