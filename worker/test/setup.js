import { env, applyD1Migrations } from 'cloudflare:test';

// Aplica `worker/migrations` no D1 local antes de qualquer teste. Sem isto a
// primeira consulta bateria em "no such table: users".
applyD1Migrations(env.DB, 'migrations');

export { env };
