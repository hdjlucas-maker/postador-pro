import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineWorkersConfig, readD1Migrations } from '@cloudflare/vitest-pool-workers/config';

// Os testes rodam no mesmo runtime do deploy (`workerd`), não em Node. Isso
// importa por dois motivos que não apareceriam num `supertest` comum:
//
// - `crypto.subtle` (PBKDF2) só existe no Web Crypto, e é ele que a senha usa.
// - O D1 é SQLite com as restrições de API do Miniflare: `batch` é transacional
//   de verdade e `RETURNING` devolve a linha. Um mock em memória passaria no
//   teste e quebraria no deploy.
//
// O banco de cada teste nasce das migrações de `worker/migrations`. O
// `applyD1Migrations` (em `test/setup.js`) exige o array já lido de
// `{ name, queries }`, e não o caminho da pasta: por isso `readD1Migrations`
// lê os arquivos aqui, no Node, em tempo de configuração, e o resultado entra
// como binding de teste (`TEST_MIGRATIONS`).

// O binding do D1 vem do `wrangler.jsonc`, indicado em `wrangler.configPath`.
// Declarar de novo aqui sobrescreveria a config com outra identidade de banco.

const pastaDoWorker = path.dirname(fileURLToPath(import.meta.url));

export default defineWorkersConfig(async () => {
  const migrations = await readD1Migrations(path.join(pastaDoWorker, 'migrations'));

  return {
    test: {
      setupFiles: ['./test/setup.js'],
      poolOptions: {
        workers: {
          wrangler: { configPath: './wrangler.jsonc' },
          miniflare: {
            bindings: {
              // Dois e-mails de administrador (lista separada por vírgula, como
              // em produção) e uma extensão fictícia com 32 letras, que é o
              // formato que o Chrome gera.
              ADMIN_EMAILS: 'admin@postador.pro,segundo@postador.pro',
              EXTENSAO_IDS: 'abcdefghijklmnopabcdefghijklmnop',
              EMAIL_FROM: 'nao-responda@postador.pro',
              // 1000 iterações em vez de 100000: o objetivo do teste é o
              // comportamento, não medir o custo de PBKDF2. O valor real está no
              // `wrangler.jsonc` e é medido à parte.
              PBKDF2_ITERACOES: '1000',
              IS_PROD: '0',
              // Sem binding de e-mail, a rota de recuperação só devolve o link
              // quando esta flag existe. Ela fica só aqui: em produção o link
              // nunca pode sair na resposta da API.
              EXPOSIR_LINK_REDEFINICAO: '1',
              TEST_MIGRATIONS: migrations
            }
          }
        }
      }
    }
  };
});
