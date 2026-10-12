import { env, applyD1Migrations } from 'cloudflare:test';

// Aplica `worker/migrations` no D1 local antes de qualquer teste.
// `TEST_MIGRATIONS` vem pronto do `vitest.config.mjs` (lido do disco com
// `readD1Migrations`). O `await` é necessário: sem ele os testes começam antes
// de a migração terminar e a primeira consulta bate em "no such table".
await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);

export { env };
