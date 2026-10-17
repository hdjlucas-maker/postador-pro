-- Avaliações da ferramenta enviadas pela janela "Avaliar ferramenta" da
-- extensão (extensao/avaliar/).
--
-- `aprovada = 1` é o que pode aparecer para os outros clientes; o envio de um
-- cliente entra com 0 e só aparece depois de revisão. O nome exibido é o
-- primeiro nome da conta (privacidade); `user_id` guarda de quem veio e é
-- NULL nas avaliações iniciais de exemplo.

CREATE TABLE IF NOT EXISTS avaliacoes (
  id         TEXT PRIMARY KEY,
  user_id    TEXT,
  nome       TEXT NOT NULL,
  nota       INTEGER NOT NULL,
  comentario TEXT,
  aprovada   INTEGER NOT NULL DEFAULT 0,
  criado_em  TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_avaliacoes_aprovadas ON avaliacoes (aprovada, criado_em DESC);

-- Avaliações iniciais de exemplo, para a janela não abrir vazia. São linhas
-- comuns desta tabela: substitua ou apague quando houver avaliações reais
-- (é o mesmo procedimento de aprovar: UPDATE avaliacoes SET aprovada = 1).
INSERT INTO avaliacoes (id, user_id, nome, nota, comentario, aprovada, criado_em) VALUES
  ('avaliacao-exemplo-1', NULL, 'Marcos A.', 5,
   'Prática demais. Deixo as campanhas programadas e ela publica nos grupos ao longo do dia.',
   1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-6 days')),
  ('avaliacao-exemplo-2', NULL, 'Juliana S.', 5,
   'O intervalo entre as postagens fez diferença aqui: antes eu postava tudo rápido e tomava restrição.',
   1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-4 days')),
  ('avaliacao-exemplo-3', NULL, 'Rafael T.', 4,
   'Configuração simples e o agendamento funciona como eu esperava. Uso todo dia.',
   1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-2 days')),
  ('avaliacao-exemplo-4', NULL, 'Carla M.', 5,
   'Tive uma dúvida e o suporte respondeu rápido no WhatsApp. A ferramenta faz o que promete.',
   1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-1 days'));
