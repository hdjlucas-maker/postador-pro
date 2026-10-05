'use strict';
const NOME_BANCO='postador-pro';const VERSAO=1;const LOJA='imagens';
function abrir(){return new Promise((resolve,reject)=>{const p=indexedDB.open(NOME_BANCO,VERSAO);p.onupgradeneeded=()=>{if(!p.result.objectStoreNames.contains(LOJA))p.result.createObjectStore(LOJA,{keyPath:'id'});};p.onsuccess=()=>resolve(p.result);p.onerror=()=>reject(p.error);});}
async function salvar(id,arquivo){const b=await abrir();await new Promise((ok,err)=>{const t=b.transaction(LOJA,'readwrite');t.objectStore(LOJA).put({id,nome:arquivo.name,tipo:arquivo.type,dados:arquivo});t.oncomplete=ok;t.onerror=()=>err(t.error);});b.close();}
async function ler(id){const b=await abrir();const r=await new Promise((ok,err)=>{const t=b.transaction(LOJA,'readonly');const p=t.objectStore(LOJA).get(id);p.onsuccess=()=>ok(p.result||null);p.onerror=()=>err(p.error);});b.close();return r;}
async function remover(id){const b=await abrir();await new Promise((ok,err)=>{const t=b.transaction(LOJA,'readwrite');t.objectStore(LOJA).delete(id);t.oncomplete=ok;t.onerror=()=>err(t.error);});b.close();}
globalThis.postadorImagens={salvar,ler,remover};
