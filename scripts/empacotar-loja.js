#!/usr/bin/env node
'use strict';

// Gera dist/postador-pro-loja.zip: o pacote para subir no painel da Chrome Web
// Store (Add new item).
//
// Diferenças em relação ao zip do site (npm run empacotar):
//   - o manifest.json fica na RAIZ do zip (formato pedido no envio);
//   - a "key" é removida: a loja gera o ID/chave do item no primeiro envio, e
//     a chave atual é a da instalação manual/desenvolvimento. O fluxo oficial
//     é justamente o contrário — depois de criar o item, o painel mostra a
//     chave pública da loja (Aba Package) e essa chave pode ser adotada no
//     manifesto, se um dia valer a pena unificar os dois IDs.
//
// Antes de gerar, roda a mesma verificação do pacote normal. O zip é
// determinístico (data fixa), então reempacotar o mesmo código gera o mesmo
// arquivo. dist/ não é versionado.

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { listarArquivos, montarZip, PASTA_EXTENSAO } = require('./empacotar-extensao.js');

const RAIZ = path.resolve(__dirname, '..');
const SAIDA = path.join(RAIZ, 'dist', 'postador-pro-loja.zip');

const verificacao = spawnSync(process.execPath, [path.join(__dirname, 'empacotar-extensao.js'), '--verificar'], { stdio: 'inherit' });
if (verificacao.status !== 0) {
  console.error('Verificação da extensão falhou; o pacote da loja não foi gerado.');
  process.exit(1);
}

const arquivos = listarArquivos(PASTA_EXTENSAO);
const entradas = arquivos.map(arquivo => {
  const dados = fs.readFileSync(path.join(PASTA_EXTENSAO, arquivo));
  if (arquivo !== 'manifest.json') return { nome: arquivo, dados };

  const manifesto = JSON.parse(dados.toString('utf8'));
  delete manifesto.key;
  return { nome: arquivo, dados: Buffer.from(`${JSON.stringify(manifesto, null, 2)}\n`, 'utf8') };
});

const zip = montarZip(entradas);
fs.mkdirSync(path.dirname(SAIDA), { recursive: true });
fs.writeFileSync(SAIDA, zip);

const manifesto = JSON.parse(fs.readFileSync(path.join(PASTA_EXTENSAO, 'manifest.json'), 'utf8'));
console.log(`Pacote da loja ${manifesto.version}: ${entradas.length} arquivos, manifest.json na raiz e sem "key".`);
console.log(`Gerado: ${path.relative(RAIZ, SAIDA)} (${Math.round(zip.length / 1024)} KB)`);
console.log('Suba esse arquivo em Chrome Web Store > Add new item e me passe o ID do item que o painel mostrar.');
