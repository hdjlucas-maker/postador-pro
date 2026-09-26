-- Esquema da API de licença do Postador Pro (Cloudflare D1 / SQLite).
--
-- Só o que é da conta e do pagamento vive aqui. Campanha, publicação, imagem e
-- histórico NÃO têm tabela: isso vive no `chrome.storage` e no IndexedDB do
-- navegador do cliente, e nunca chega ao servidor.
--
-- Datas são TEXT em ISO 8601 UTC. O SQLite não tem tipo de data, e string em
-- ISO ordena lexicograficamente na mesma ordem do tempo, então
-- `data_expiracao > '2026-09-25T00:00:00.000Z'` compara corretamente.

PRAGMA foreign_keys = ON;

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

-- `lower(email)` porque o cadastro normaliza para minúsculas, mas a unicidade
-- precisa sobreviver a um dado importado ou editado direto no painel.
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email ON users (lower(email));
CREATE INDEX IF NOT EXISTS idx_users_plano ON users (plano);

-- -------------------------------------------------------------- sessões
-- Web e extensão dividem a tabela. A extensão manda `Authorization: Bearer` e
-- recebe `escopo = 'extensao'`; a web usa cookie e recebe `escopo = 'web'`.
-- O token nunca é gravado: entra só o SHA-256.
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

-- `order_nsu` único é o que torna o webhook idempotente na prática: a
-- InfinitePay reenvia o mesmo pedido e a segunda entrega não cria outra linha.
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
-- Janela fixa, não deslizante. O binding nativo do Cloudflare só aceita
-- janela de 10s ou 60s, e o cadastro precisa segurar uma hora. Esta tabela
-- cobre as janelas longas (15 min, 1 h) das rotas sensíveis.
--
-- Uma linha por (chave, tamanho de janela). A janela atual é o
-- `floor(agora / janelaSegundos)`, e a chave já inclui o tamanho, então
-- "login" e "registro" nunca disputam a mesma linha.
--
-- `expira_em` (ISO 8601 UTC) é o que a limpeza usa. O índice `janela` sozinho
-- não serve: ele é um bucket em unidades da própria janela, e comparar buckets
-- de tamanhos diferentes não quer dizer nada.
CREATE TABLE IF NOT EXISTS rate_limits (
  chave      TEXT PRIMARY KEY,
  janela     INTEGER NOT NULL,
  contagem   INTEGER NOT NULL,
  expira_em  TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_ratelimits_expira ON rate_limits (expira_em);

-- --------------------------------------------------------------- sistema
-- Uma linha só. O cron diário marca a última limpeza e guarda o instante de
-- instalação, que substitui o "uptime" do processo.
CREATE TABLE IF NOT EXISTS sistema (
  id              INTEGER PRIMARY KEY CHECK (id = 1),
  instalado_em    TEXT NOT NULL,
  ultima_limpeza  TEXT,
  versao          TEXT
);
