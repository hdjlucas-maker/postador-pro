'use strict';

// Operação de backup pela linha de comando.
//
//   node scripts/backup.js listar
//   node scripts/backup.js criar
//   node scripts/backup.js restaurar backup-2026-09-25T18-00-00-000Z
//
// Restaurar sobrescreve os bancos com a cópia escolhida. Pare o app antes
// (pm2 stop postador-pro), senão o servidor continua escrevendo por cima.

const db = require('../src/db');
const log = require('../src/log');
const config = require('../src/config');

const [comando, argumento] = process.argv.slice(2);

async function principal() {
  switch (comando) {
    case 'listar': {
      const backups = db.listarBackups();
      if (!backups.length) {
        console.log('Nenhum backup encontrado.');
        return;
      }
      console.log(`${backups.length} backup(s) em ${config.BACKUP_DIR}:`);
      for (const nome of backups) {
        const { size } = require('fs').statSync(`${config.BACKUP_DIR}/${nome}`);
        console.log(`  ${nome}  ${(size / 1024).toFixed(0)} KB`);
      }
      return;
    }

    case 'criar': {
      await db.iniciar();
      const destino = await db.backup();
      console.log(`Backup criado: ${destino}`);
      return;
    }

    case 'restaurar': {
      if (!argumento) {
        throw new Error('Informe o nome do backup. Use "listar" para ver as opções.');
      }
      const resultado = db.restaurar(argumento);
      console.log(`Restaurado de ${resultado.origem}: ${resultado.arquivos.join(', ')}`);
      console.log('Reinicie o app: pm2 restart postador-pro');
      return;
    }

    default:
      console.log('Uso: node scripts/backup.js <listar|criar|restaurar [nome]>');
  }
}

principal().catch(erro => {
  log.error('backup_cli_erro', { erro: erro.message });
  console.error(erro.message);
  process.exit(1);
});
