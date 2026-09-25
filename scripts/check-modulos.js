'use strict';

/**
 * Verifica chamadas entre módulos internos: todo `modulo.funcao(...)` usado em
 * src/ precisa existir no objeto exportado pelo módulo. Erros de digitação em
 * nomes de exportação não quebram a sintaxe e só aparecem em tempo de
 * execução — este script os encontra antes do deploy.
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

const problemas = [];

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

if (problemas.length) {
  console.error(`\n${problemas.length} chamada(s) interna(s) inválida(s):`);
  for (const p of problemas) console.error(`  ${p.arquivo}:${p.linha}  ${p.detalhe}`);
  process.exit(1);
}

console.log(`Chamadas internas conferidas: ${modulos.size} módulos, nenhum nome inválido.`);
