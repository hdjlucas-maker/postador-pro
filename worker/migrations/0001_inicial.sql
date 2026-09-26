-- Migração 0001: esquema inicial da API de licença.
--
-- Espelha `worker/schema.sql`. O arquivo `.sql` sozinho não serve: o Wrangler
-- aplica migrações por arquivo numerado em `migrations_dir`, e é o conjunto
-- deles que ele registra na tabela `d1_migrations` para saber o que já rodou.
-- Os dois arquivos precisam ficar em sincronia — `schema.sql` é a referência de
-- leitura, este é o que o Wrangler executa.

-- ---------------------------------------------------------------- contas
CREATE TABLE IF NOT EXISTS users (
  id                  TEXT PRIMARY KEY,
  nome                TEXT NOT NULL,
  email               TEXT NOT NULL,
  senha_hash          TEXT NOT NULL,
  plano               TEXT NOT NULL DEFAULT 'trial',
  tipo_plano          TEXT,
  status_pagamento    TEXT NOT NULL DEFAULT 'trial',
  trial_inicio        TEXT,
  trial_fim           TEXT,
  data_inicio         TEXT,
  data_expiracao      TEXT,
  ultimo_acesso_em    TEXT,
  ultimo_pagamento_em TEXT,
  senha_alterada_em   TEXT,
  login_falhas        INTEGER NOT NULL DEFAULT 0,
  bloqueado_ate       TEXT,
  bloqueado           INTEGER NOT NULL DEFAULT 0,
  admin               INTEGER NOT NULL DEFAULT 0,
  criado_em           TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email ON users (lower(email));
CREATE INDEX IF NOT EXISTS idx_users_plano ON users (plano);

-- -------------------------------------------------------------- sessões
CREATE TABLE IF NOT EXISTS sessions (
  id         TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL,
  user_id    TEXT NOT NULL,
  escopo     TEXT NOT NULL DEFAULT 'web',
  criado_em  TEXT NOT NULL,
  expira_em  TEXT NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_sessions_token ON sessions (token_hash);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions (user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_expira ON sessions (expira_em);
CREATE INDEX IF NOT EXISTS idx_sessions_escopo ON sessions (escopo, user_id);

-- ------------------------------------------------------------- pagamentos
CREATE TABLE IF NOT EXISTS payments (
  id                       TEXT PRIMARY KEY,
  order_nsu                TEXT NOT NULL,
  user_id                  TEXT NOT NULL,
  plan                     TEXT NOT NULL,
  amount                   INTEGER NOT NULL,
  status                   TEXT NOT NULL DEFAULT 'pending',
  checkout_url             TEXT,
  transaction_nsu          TEXT,
  invoice_slug             TEXT,
  receipt_url              TEXT,
  origem                   TEXT,
  admin_email              TEXT,
  motivo                   TEXT,
  erro                     TEXT,
  data_expiracao_concedida TEXT,
  criado_em                TEXT NOT NULL,
  pago_em                  TEXT,
  aplicado_em              TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_payments_order ON payments (order_nsu);
CREATE INDEX IF NOT EXISTS idx_payments_user ON payments (user_id);
CREATE INDEX IF NOT EXISTS idx_payments_status ON payments (status);
CREATE INDEX IF NOT EXISTS idx_payments_criado ON payments (criado_em DESC);
CREATE INDEX IF NOT EXISTS idx_payments_pendentes ON payments (user_id, status, criado_em DESC);

-- --------------------------------------------------------- redefine senha
CREATE TABLE IF NOT EXISTS resets (
  id         TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL,
  user_id    TEXT NOT NULL,
  criado_em  TEXT NOT NULL,
  expira_em  TEXT NOT NULL,
  usado_em   TEXT,
  FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_resets_token ON resets (token_hash);
CREATE INDEX IF NOT EXISTS idx_resets_user ON resets (user_id);
CREATE INDEX IF NOT EXISTS idx_resets_expira ON resets (expira_em);

-- ------------------------------------------------------------ rate limit
CREATE TABLE IF NOT EXISTS rate_limits (
  chave      TEXT PRIMARY KEY,
  janela     INTEGER NOT NULL,
  contagem   INTEGER NOT NULL,
  expira_em  TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_ratelimits_expira ON rate_limits (expira_em);

-- --------------------------------------------------------------- sistema
CREATE TABLE IF NOT EXISTS sistema (
  id              INTEGER PRIMARY KEY CHECK (id = 1),
  instalado_em    TEXT NOT NULL,
  ultima_limpeza  TEXT,
  versao          TEXT
);
