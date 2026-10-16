-- Migração 0002: contagem de publicações diárias por usuário no servidor.
--
-- Fecha o buraco de quem edita a extensão localmente para passar do limite
-- diário do plano (5 trial / 10 pro). O servidor agora é a fonte da verdade:
-- antes de publicar, a extensão consulta se o usuário ainda tem vaga hoje; após
-- publicar com sucesso, o servidor incrementa o contador.
--
-- Uma linha por (usuario, data UTC). O `contador` só sobe pelo endpoint
-- `/api/extensao/publicacao`, que confere o limite do plano e incrementa de
-- forma atômica (`UPDATE ... WHERE contador < limite`).
CREATE TABLE IF NOT EXISTS publicacoes_dia (
  user_id  TEXT NOT NULL,
  data     TEXT NOT NULL, -- ISO 8601 apenas a data, ex: 2026-10-16
  contador INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, data),
  FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_publicacoes_dia_data ON publicacoes_dia (data);
