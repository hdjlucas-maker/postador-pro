#!/usr/bin/env node
'use strict';

// Verifica a extensão e gera public/downloads/postador-pro.zip.
//
//   node scripts/empacotar-extensao.js            verifica e gera o zip
//   node scripts/empacotar-extensao.js --verificar só verifica, não gera
//
// Sem dependências externas. O zip sai com data fixa para que dois
// empacotamentos do mesmo código gerem o mesmo arquivo.

const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const { spawnSync } = require('node:child_process');

const RAIZ = path.resolve(__dirname, '..');
const PASTA_EXTENSAO = path.join(RAIZ, 'extensao');
const SAIDA = path.join(RAIZ, 'public', 'downloads', 'postador-pro.zip');
const PASTA_NO_ZIP = 'postador-pro';
const SOMENTE_VERIFICAR = process.argv.includes('--verificar');

const PERMISSOES_PERMITIDAS = ['storage', 'alarms', 'tabs', 'scripting'];
const HOSTS_FACEBOOK = ['https://www.facebook.com/*', 'https://web.facebook.com/*', 'https://m.facebook.com/*'];

const erros = [];
function falha(mensagem) { erros.push(mensagem); }

function listarArquivos(pasta, base = pasta) {
  const resultado = [];
  for (const nome of fs.readdirSync(pasta).sort()) {
    const completo = path.join(pasta, nome);
    if (fs.statSync(completo).isDirectory()) resultado.push(...listarArquivos(completo, base));
    else resultado.push(path.relative(base, completo).split(path.sep).join('/'));
  }
  return resultado;
}

// --- manifesto ---

function verificarManifesto(arquivos) {
  let manifesto;
  try {
    manifesto = JSON.parse(fs.readFileSync(path.join(PASTA_EXTENSAO, 'manifest.json'), 'utf8'));
  } catch (erro) {
    falha(`manifest.json ilegível: ${erro.message}`);
    return null;
  }
  if (manifesto.manifest_version !== 3) falha('manifest_version precisa ser 3.');
  if (!/^\d+\.\d+\.\d+$/.test(String(manifesto.version || ''))) falha('version precisa ter o formato 1.2.3.');
  if (!manifesto.key) falha('Falta a "key": sem ela o ID da extensão muda e a allowlist EXTENSAO_IDS do servidor rejeita.');

  const permissoes = manifesto.permissions || [];
  for (const p of permissoes) if (!PERMISSOES_PERMITIDAS.includes(p)) falha(`Permissão não prevista: ${p}.`);

  const hosts = manifesto.host_permissions || [];
  for (const h of HOSTS_FACEBOOK) if (!hosts.includes(h)) falha(`host_permissions sem ${h}.`);
  for (const h of hosts) {
    if (/\*\.workers\.dev/.test(h)) falha(`host_permissions amplo demais: ${h}. Use o host exato da API.`);
    if (h === '<all_urls>' || h === '*://*/*') falha(`host_permissions amplo demais: ${h}.`);
  }

  const referenciados = [
    manifesto.background && manifesto.background.service_worker,
    manifesto.action && manifesto.action.default_popup,
    manifesto.options_page,
    ...Object.values(manifesto.icons || {}),
    'content/facebook.js' // injetado pelo service worker via chrome.scripting
  ].filter(Boolean);
  for (const arquivo of referenciados) if (!arquivos.includes(arquivo)) falha(`Arquivo citado e ausente: ${arquivo}.`);

  return manifesto;
}

// --- sintaxe ---

function ehModulo(codigo) {
  return /^\s*(import\s|export\s)/m.test(codigo);
}

function verificarSintaxe(arquivos) {
  for (const arquivo of arquivos.filter(a => a.endsWith('.js'))) {
    const caminho = path.join(PASTA_EXTENSAO, arquivo);
    const codigo = fs.readFileSync(caminho, 'utf8');
    const argumentos = ehModulo(codigo) ? ['--input-type=module', '--check'] : ['--check', caminho];
    const processo = spawnSync(process.execPath, argumentos, { input: ehModulo(codigo) ? codigo : undefined, encoding: 'utf8' });
    if (processo.status !== 0) falha(`Erro de sintaxe em ${arquivo}: ${(processo.stderr || '').split('\n').find(l => l.trim()) || 'desconhecido'}`);
  }
}

// --- referências locais nos HTML ---

function verificarHtml(arquivos) {
  for (const arquivo of arquivos.filter(a => a.endsWith('.html'))) {
    const pasta = path.posix.dirname(arquivo);
    const html = fs.readFileSync(path.join(PASTA_EXTENSAO, arquivo), 'utf8');
    for (const [, destino] of html.matchAll(/(?:src|href)="([^"#?]+)"/g)) {
      if (/^(https?:|data:|mailto:|tel:|\/\/)/.test(destino)) continue;
      const resolvido = path.posix.normalize(path.posix.join(pasta, destino));
      if (!arquivos.includes(resolvido)) falha(`${arquivo} cita ${destino}, que não existe.`);
    }
  }
}

// --- elementos do DOM usados pelo JS e presentes no HTML ---
// Um $('id') apontando para elemento inexistente quebra a interface inteira
// em tempo de execução; a checagem pega isso antes de empacotar.

function verificarElementos(arquivos) {
  const paginas = [
    ['options/options.js', 'options/options.html'],
    ['popup/popup.js', 'popup/popup.html'],
    ['avaliar/avaliar.js', 'avaliar/avaliar.html'],
    ['assinar/assinar.js', 'assinar/assinar.html']
  ];
  for (const [js, html] of paginas) {
    if (!arquivos.includes(js) || !arquivos.includes(html)) continue;
    const codigo = fs.readFileSync(path.join(PASTA_EXTENSAO, js), 'utf8');
    const marcacao = fs.readFileSync(path.join(PASTA_EXTENSAO, html), 'utf8');
    const idsNoHtml = new Set([...marcacao.matchAll(/id="([^"]+)"/g)].map(m => m[1]));
    for (const [, id] of codigo.matchAll(/\$\('([^']+)'\)/g)) {
      if (!idsNoHtml.has(id)) falha(`${js} usa o elemento #${id}, que não existe em ${html}.`);
    }
  }
}

// --- zip ---

const TABELA_CRC = (() => {
  const tabela = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    tabela[n] = c >>> 0;
  }
  return tabela;
})();

function crc32(buffer) {
  let c = 0xffffffff;
  for (const byte of buffer) c = TABELA_CRC[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function gerarZip(arquivos) {
  // Data fixa: 2026-01-01 00:00:00 no formato DOS.
  const dataDos = ((2026 - 1980) << 9) | (1 << 5) | 1;
  const horaDos = 0;
  const partes = [];
  const central = [];
  let deslocamento = 0;

  for (const arquivo of arquivos) {
    const nome = Buffer.from(`${PASTA_NO_ZIP}/${arquivo}`, 'utf8');
    const dados = fs.readFileSync(path.join(PASTA_EXTENSAO, arquivo));
    const comprimido = zlib.deflateRawSync(dados, { level: 9 });
    const crc = crc32(dados);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6); // nomes em UTF-8
    local.writeUInt16LE(8, 8);
    local.writeUInt16LE(horaDos, 10);
    local.writeUInt16LE(dataDos, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(comprimido.length, 18);
    local.writeUInt32LE(dados.length, 22);
    local.writeUInt16LE(nome.length, 26);
    local.writeUInt16LE(0, 28);
    partes.push(local, nome, comprimido);

    const entrada = Buffer.alloc(46);
    entrada.writeUInt32LE(0x02014b50, 0);
    entrada.writeUInt16LE(20, 4);
    entrada.writeUInt16LE(20, 6);
    entrada.writeUInt16LE(0x0800, 8);
    entrada.writeUInt16LE(8, 10);
    entrada.writeUInt16LE(horaDos, 12);
    entrada.writeUInt16LE(dataDos, 14);
    entrada.writeUInt32LE(crc, 16);
    entrada.writeUInt32LE(comprimido.length, 20);
    entrada.writeUInt32LE(dados.length, 24);
    entrada.writeUInt16LE(nome.length, 28);
    entrada.writeUInt32LE(deslocamento, 42);
    central.push(entrada, nome);

    deslocamento += local.length + nome.length + comprimido.length;
  }

  const tamanhoCentral = central.reduce((soma, b) => soma + b.length, 0);
  const fim = Buffer.alloc(22);
  fim.writeUInt32LE(0x06054b50, 0);
  fim.writeUInt16LE(arquivos.length, 8);
  fim.writeUInt16LE(arquivos.length, 10);
  fim.writeUInt32LE(tamanhoCentral, 12);
  fim.writeUInt32LE(deslocamento, 16);

  return Buffer.concat([...partes, ...central, fim]);
}

// --- execução ---

const arquivos = listarArquivos(PASTA_EXTENSAO);
const manifesto = verificarManifesto(arquivos);
verificarSintaxe(arquivos);
verificarHtml(arquivos);
verificarElementos(arquivos);

if (erros.length) {
  console.error('Verificação da extensão falhou:');
  for (const erro of erros) console.error(`  - ${erro}`);
  process.exit(1);
}

console.log(`Extensão ${manifesto.version}: ${arquivos.length} arquivos, manifesto, sintaxe e referências conferidos.`);

if (!SOMENTE_VERIFICAR) {
  fs.mkdirSync(path.dirname(SAIDA), { recursive: true });
  const zip = gerarZip(arquivos);
  fs.writeFileSync(SAIDA, zip);
  console.log(`Gerado: ${path.relative(RAIZ, SAIDA)} (${Math.round(zip.length / 1024)} KB)`);
}
