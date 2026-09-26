import { defineWorkersConfig } from '@cloudflare/vitest-pool-workers/config';

// Os testes rodam no mesmo runtime do deploy (`workerd`), não em Node. Isso
// importa por dois motivos que não apareceriam num `supertest` comum:
//
// - `crypto.subtle` (PBKDF2) só existe no Web Crypto, e é ele que a senha usa.
// - O D1 é SQLite com as restrições de API do Miniflare: `batch` é transacional
//   de verdade e `RETURNING` devolve a linha. Um mock em memória passaria no
//   teste e quebraria no deploy.
//
// O banco de cada teste nasce das migrações de `worker/migrations`, aplicadas
// por `applyD1Migrations` no `beforeAll` de `test/setup.js`.

// O binding do D1 (inclusive `migrations_dir`) vem do `wrangler.jsonc`, indicado
// em `wrangler.configPath`. Declarar de novo aqui sobrescreveria a config com
// outra identidade de banco e as migrações não seriam aplicadas.

export default defineWorkersConfig({
  test: {
    setupFiles: ['./test/setup.js'],
    poolOptions: {
      workers: {
        wrangler: { configPath: './wrangler.jsonc' },
        miniflare: {
          bindings: {
            // Um e-mail de administrador e uma extensão fictícia com 32 letras,
            // que é o formato que o Chrome gera.
            ADMIN_EMAILS: 'admin@postador.pro',
            EXTENSAO_IDS: 'abcdefghijklmnopabcdefghijklmnop',
            EMAIL_FROM: 'nao-responda@postador.pro',
            // 1000 iterações em vez de 100000: o objetivo do teste é o
            // comportamento, não medir o custo de PBKDF2. O valor real está no
            // `wrangler.jsonc` e é medido à parte.
            PBKDF2_ITERACOES: '1000',
            IS_PROD: '0'
          }
        }
      }
    }
  }
});
