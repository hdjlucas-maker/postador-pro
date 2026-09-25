'use strict';

/**
 * Verificação de sintaxe de todos os arquivos JavaScript do projeto.
 * Usa o compilador do próprio Node, sem depender de dependências externas.
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const RAIZ = path.resolve(__dirname, '..');
const IGNORAR = new Set(['node_modules', '.git', 'data', 'uploads', 'facebook-profiles', '.backup']);
const EXTENSOES = new Set(['.js', '.cjs', '.mjs']);

const arquivos = [];

function varrer(diretorio) {
  for (const entrada of fs.readdirSync(diretorio, { withFileTypes: true })) {
    if (IGNORAR.has(entrada.name)) continue;
    const caminho = path.join(diretorio, entrada.name);
    if (entrada.isDirectory()) varrer(caminho);
    else if (EXTENSOES.has(path.extname(entrada.name))) arquivos.push(caminho);
  }
}

varrer(RAIZ);

let falhas = 0;
for (const arquivo of arquivos) {
  try {
    execFileSync(process.execPath, ['--check', arquivo], { stdio: 'pipe' });
  } catch (erro) {
    falhas += 1;
    const relativo = path.relative(RAIZ, arquivo);
    console.error(`\nERRO  ${relativo}`);
    console.error(erro.stderr ? erro.stderr.toString().trim() : erro.message);
  }
}

console.log(`${arquivos.length - falhas}/${arquivos.length} arquivos com sintaxe válida.`);
process.exit(falhas ? 1 : 0);
