'use strict';

/**
 * Verifica chamadas entre módulos internos: todo `modulo.funcao(...)` usado em
 * src/ precisa existir no objeto exportado pelo módulo. Erros de digitação em
 * nomes de exportação não quebram a sintaxe e só aparecem em tempo de
 * execução — este script os encontra antes do deploy.
 *
 * A segunda metade confere as chamadas a funções do próprio arquivo
 * (`algumaCoisa(...)`), que têm o mesmo problema: `addMinutos` no lugar de
 * `addMinutes` compila e só explode quando a linha é alcançada.
 */

const fs = require('fs');
const path = require('path');

const RAIZ = path.resolve(__dirname, '..');
const SRC = path.join(RAIZ, 'src');
const IGNORAR = new Set(['node_modules', 'data']);

// Módulos com chaves dinâmicas (coleções e configuração): as propriedades não
// são funções nomeadas, então não dá para conferir estaticamente.
const DINAMICOS = new Set(['db', 'config']);

// Métodos nativos de String/Array/Object: nomes locais podem sombrear um
// import, então não dá para tratá-los como erro.
const NATIVOS = new Set([
  'length', 'map', 'filter', 'forEach', 'find', 'findIndex', 'some', 'every',
  'reduce', 'push', 'pop', 'shift', 'unshift', 'slice', 'splice', 'concat',
  'includes', 'indexOf', 'join', 'split', 'replace', 'replaceAll', 'trim',
  'toUpperCase', 'toLowerCase', 'padStart', 'padEnd', 'repeat', 'sort',
  'keys', 'values', 'entries', 'has', 'get', 'set', 'then', 'catch', 'stringify',
  'parse', 'assign', 'freeze', 'toString', 'valueOf', 'startsWith', 'endsWith',
  'match', 'matchAll', 'test', 'exec', 'flat', 'from', 'of', 'getTime'
]);

// Globais disponíveis em Node e nos módulos do projeto.
const GLOBAIS = new Set([
  'require', 'module', 'exports', 'process', 'console', 'Buffer', 'setTimeout',
  'clearTimeout', 'setInterval', 'clearInterval', 'setImmediate', 'queueMicrotask',
  'fetch', 'URL', 'URLSearchParams', 'AbortController', 'AbortSignal', 'TextEncoder',
  'TextDecoder', 'crypto', 'performance', 'structuredClone', 'JSON', 'Math', 'Date',
  'Object', 'Array', 'String', 'Number', 'Boolean', 'Promise', 'Map', 'Set', 'Symbol',
  'Error', 'TypeError', 'RangeError', 'SyntaxError', 'ReferenceError', 'RegExp',
  'Intl', 'parseInt', 'parseFloat', 'isNaN', 'isFinite', 'encodeURIComponent',
  'decodeURIComponent', 'encodeURI', 'decodeURI', 'undefined', 'NaN', 'Infinity',
  'globalThis', '__dirname', '__filename', 'Proxy', 'Reflect', 'WeakMap', 'WeakSet'
]);

// Palavras que precedem `(` sem serem chamadas.
const NAO_CHAMADA = new Set([
  'if', 'for', 'while', 'switch', 'catch', 'function', 'return', 'typeof',
  'new', 'await', 'do', 'else', 'async', 'constructor'
]);

const arquivos = [];

function varrer(diretorio) {
  for (const entrada of fs.readdirSync(diretorio, { withFileTypes: true })) {
    if (IGNORAR.has(entrada.name)) continue;
    const caminho = path.join(diretorio, entrada.name);
    if (entrada.isDirectory()) varrer(caminho);
    else if (entrada.name.endsWith('.js')) arquivos.push(caminho);
  }
}

varrer(SRC);

const modulos = new Map();
for (const arquivo of arquivos) modulos.set(arquivo, require(arquivo));

function resolver(base) {
  if (modulos.has(base)) return base;
  const comExtensao = `${base}.js`;
  if (modulos.has(comExtensao)) return comExtensao;
  const comoPasta = path.join(base, 'index.js');
  if (modulos.has(comoPasta)) return comoPasta;
  return null;
}

/**
 * Substitui comentários e strings por espaços, mantendo o tamanho do texto para
 * os números de linha continuarem certos. Sem isso, uma frase em comentário
 * como "o nome() da função" vira falso positivo.
 */
function limpar(texto) {
  let saida = '';
  let i = 0;

  while (i < texto.length) {
    const dois = texto.slice(i, i + 2);

    if (dois === '//') {
      const quebra = texto.indexOf('\n', i);
      const ate = quebra === -1 ? texto.length : quebra;
      saida += ' '.repeat(ate - i);
      i = ate;
      continue;
    }

    if (dois === '/*') {
      const fecha = texto.indexOf('*/', i + 2);
      const ate = fecha === -1 ? texto.length : fecha + 2;
      saida += texto.slice(i, ate).replace(/[^\n]/g, ' ');
      i = ate;
      continue;
    }

    const aspas = texto[i];
    if (aspas === "'" || aspas === '"' || aspas === '`') {
      let j = i + 1;
      while (j < texto.length) {
        if (texto[j] === '\\') {
          j += 2;
          continue;
        }
        if (texto[j] === aspas) {
          j += 1;
          break;
        }
        j += 1;
      }
      saida += ' '.repeat(j - i);
      i = j;
      continue;
    }

    saida += aspas;
    i += 1;
  }

  return saida;
}

const problemas = [];

/* --- 1. Propriedades de módulos internos --- */
for (const arquivo of arquivos) {
  const texto = fs.readFileSync(arquivo, 'utf8');
  const relativo = path.relative(RAIZ, arquivo);

  // Mapeia `const nome = require('./x')` para o caminho do módulo.
  const vinculos = new Map();
  const padraoVinculo = /const\s+\{?\s*([A-Za-z0-9_$,\s]+?)\s*\}?\s*=\s*require\(\s*'(\.[^']+)'\s*\)/g;
  let m;
  while ((m = padraoVinculo.exec(texto))) {
    const destino = resolver(path.resolve(path.dirname(arquivo), m[2]));
    if (!destino) continue;
    for (const nome of m[1].split(',').map(s => s.trim().split(':').pop().trim())) {
      if (/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(nome)) vinculos.set(nome, destino);
    }
  }

  if (!vinculos.size) continue;

  for (const [alias, destino] of vinculos) {
    if (DINAMICOS.has(alias)) continue;

    const exportado = modulos.get(destino);
    if (typeof exportado !== 'object' || exportado === null) continue;

    const uso = new RegExp(`\\b${alias}\\.([A-Za-z_$][A-Za-z0-9_$]*)`, 'g');
    let u;
    while ((u = uso.exec(texto))) {
      const propriedade = u[1];
      if (propriedade in exportado) continue;
      if (NATIVOS.has(propriedade)) continue;
      problemas.push({
        arquivo: relativo,
        linha: texto.slice(0, u.index).split(/\r?\n/).length,
        detalhe: `${alias}.${propriedade} não existe no módulo ${path.basename(destino)}`
      });
    }
  }
}

/* --- 2. Funções chamadas e não definidas no próprio arquivo --- */
for (const arquivo of arquivos) {
  const texto = limpar(fs.readFileSync(arquivo, 'utf8'));
  const relativo = path.relative(RAIZ, arquivo);

  // Tudo que este arquivo declara: funções, variáveis, parâmetros e métodos.
  const disponiveis = new Set(GLOBAIS);

  for (const d of texto.matchAll(/(?:^|\s)(?:async\s+)?function\s*\*?\s*([A-Za-z_$][A-Za-z0-9_$]*)/g)) {
    disponiveis.add(d[1]);
  }
  for (const d of texto.matchAll(/(?:^|[\s;{,(])(?:const|let|var)\s+([A-Za-z_$][A-Za-z0-9_$]*)/g)) {
    disponiveis.add(d[1]);
  }
  for (const d of texto.matchAll(/(?:const|let|var)\s*\{([^}]*)\}\s*=/g)) {
    for (const parte of d[1].split(',')) {
      const nome = parte.split(':').pop().split('=')[0].trim();
      if (/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(nome)) disponiveis.add(nome);
    }
  }
  for (const d of texto.matchAll(/\(([^()]*)\)\s*(?:=>|\{)/g)) {
    for (const parte of d[1].split(',')) {
      const nome = parte.split('=')[0].replace(/[.\[\]]/g, '').trim();
      if (/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(nome)) disponiveis.add(nome);
    }
  }
  // Parâmetros desestruturados: `criarRateLimit({ nome, chave = fn })`.
  for (const d of texto.matchAll(/\(\s*\{([^}]*)\}/g)) {
    for (const parte of d[1].split(',')) {
      const nome = parte.split(':').pop().split('=')[0].replace(/[.\[\]]/g, '').trim();
      if (/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(nome)) disponiveis.add(nome);
    }
  }
  for (const d of texto.matchAll(/\b([A-Za-z_$][A-Za-z0-9_$]*)\s*\([^)]*\)\s*\{/g)) {
    disponiveis.add(d[1]);
  }
  for (const d of texto.matchAll(/\bcatch\s*\(\s*([A-Za-z_$][A-Za-z0-9_$]*)/g)) {
    disponiveis.add(d[1]);
  }

  for (const c of texto.matchAll(/(^|[^.\w$])([A-Za-z_$][A-Za-z0-9_$]*)\s*\(/g)) {
    const nome = c[2];
    if (c[1] === '.') continue;
    if (NAO_CHAMADA.has(nome)) continue;
    if (disponiveis.has(nome)) continue;
    if (/function\s*$/.test(texto.slice(Math.max(0, c.index - 16), c.index + 1))) continue;

    problemas.push({
      arquivo: relativo,
      linha: texto.slice(0, c.index).split(/\r?\n/).length,
      detalhe: `${nome}() é chamada mas não está definida neste arquivo nem é global`
    });
  }
}

if (problemas.length) {
  console.error(`\n${problemas.length} chamada(s) interna(s) inválida(s):`);
  for (const p of problemas) console.error(`  ${p.arquivo}:${p.linha}  ${p.detalhe}`);
  process.exit(1);
}

console.log(`Chamadas internas conferidas: ${modulos.size} módulos, nenhum nome inválido.`);
