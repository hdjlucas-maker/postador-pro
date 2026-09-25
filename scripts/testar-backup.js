'use strict';

// Verifica o ciclo de backup: cria um backup com dados, apaga o banco, restaura
// e confere que o registro voltou. Roda num DATA_DIR temporário.

const fs = require('fs');
const os = require('os');
const path = require('path');

const DATA_DIR = path.join(os.tmpdir(), `pp-backup-teste-${Date.now()}`);
process.env.DATA_DIR = DATA_DIR;
// A config é lida no boot, então o limite precisa vir antes do require.
process.env.BACKUPS_MAXIMOS = '2';

const dbMod = require('../src/db');
const { db, iniciar, backup, restaurar, listarBackups } = dbMod;

const falhou = [];
function afirmar(condicao, mensagem) {
  console.log(`  ${condicao ? 'ok  ' : 'FALHOU'}  ${mensagem}`);
  if (!condicao) falhou.push(mensagem);
}

(async () => {
  console.log('\n== Backup e restauracao ==');

  await iniciar();

  await db.users.insert({ nome: 'Cliente Teste', email: 'cliente@teste.local', senha: 'hash' });
  afirmar((await db.users.count({})) === 1, 'usuario inserido');

  const destino = await backup();
  afirmar(fs.existsSync(path.join(destino, 'users.db')), 'backup contem users.db');
  afirmar(listarBackups().length === 1, `listagem devolve ${listarBackups().length} backup`);

  // Simula perda de dados.
  await db.users.remove({}, { multi: true });
  afirmar((await db.users.count({})) === 0, 'banco apagado (perda simulada)');

  const conteudoOriginal = fs.readFileSync(path.join(destino, 'users.db'), 'utf8');

  const resultado = restaurar(path.basename(destino));
  afirmar(resultado.arquivos.includes('users.db'), `restaurou: ${resultado.arquivos.join(', ')}`);

  const conteudoRestaurado = fs.readFileSync(path.join(DATA_DIR, 'users.db'), 'utf8');
  afirmar(conteudoRestaurado === conteudoOriginal, 'users.db voltou identico ao do backup');
  afirmar(conteudoRestaurado.includes('Cliente Teste'), 'o registro do cliente voltou');

  // Retencao: com BACKUPS_MAXIMOS=2, o terceiro backup deve remover o mais
  // antigo. Sem isso os backups acumulam e enchem o disco da VPS.
  const destino2 = await backup();
  const destino3 = await backup();
  const restantes = listarBackups();

  afirmar(restantes.length === 2, `retencao deixou ${restantes.length} backup (esperado 2)`);
  afirmar(!fs.existsSync(path.join(DATA_DIR, 'backups', path.basename(destino))), 'apagou o mais antigo');
  afirmar(fs.existsSync(path.join(DATA_DIR, 'backups', path.basename(destino3))), 'manteve o mais novo');
  afirmar(restantes.includes(path.basename(destino2)), 'manteve o do meio');

  // Recusa nome que nao existe: sem isso, um erro de digitacao apaga o banco.
  let recusou = false;
  try {
    restaurar('backup-inexistente');
  } catch (erro) {
    recusou = erro.message.includes('não encontrado');
  }
  afirmar(recusou, 'recusa restaurar backup inexistente');

  fs.rmSync(DATA_DIR, { recursive: true, force: true });

  console.log(falhou.length ? `\n${falhou.length} FALHA(S)` : '\nTudo certo.');
  process.exit(falhou.length ? 1 : 0);
})().catch(erro => {
  console.error('erro:', erro.message);
  fs.rmSync(DATA_DIR, { recursive: true, force: true });
  process.exit(1);
});
