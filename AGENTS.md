# AGENTS.md — Postador Pro

Extensão de navegador (Chrome, Manifest V3) que publica campanhas em grupos do Facebook, mais uma API de licença em Cloudflare Workers + Hono + D1 e a landing em `public/`. A senha do Facebook nunca entra no produto.

## Comandos essenciais (raiz)

| Comando | O que faz |
|---|---|
| `npm test` | 11 testes da extensão (validação de campos, Spintax, seleção do compositor no DOM simulado e transporte da imagem em base64). |
| `npm run verificar:extensao` | Confere manifesto, permissões, `key`, arquivos citados, sintaxe de todos os `.js`, referências dos HTML e elementos do DOM usados no JS. Não gera nada. |
| `npm run empacotar` | Verifica e gera `public/downloads/postador-pro.zip`. |
| `npm run test:worker` | `cd worker && npm install` (uma vez) + `npm test` (27 testes da API, vitest + pool do Workers). |

## Ordem quando mexer na extensão

1. Faça a mudança em `extensao/`.
2. Suba o `version` de `extensao/manifest.json` (formato `1.2.3`).
3. Rode `npm run empacotar`.
4. Comite `public/downloads/postador-pro.zip` junto com a mudança.

Sem isso, o cliente baixa uma versão antiga do zip (já aconteceu). Não versionar `.env`, `data/`, `*.db`, `.wrangler/`, `node_modules/` nem `info.md` (contém credenciais de administrador; já está no `.gitignore`).

## Testes

- Um teste só: `node tests/<arquivo>.test.mjs` na raiz (usa `node:test` built-in).
- Extensão: `npm test`.
- Worker: `cd worker && npm install && npm test` (vitest run, atualmente 27 testes).
- Antes de mudar algo: `npm test` e `npm run verificar:extensao` devem passar.
- Os testes da extensão usam DOM simulado. Publicação real em grupo do Facebook **não está verificada**; se o Facebook mudar o DOM, revisar seletores em `extensao/content/facebook.js`.
- Pagamento real com InfinitePay e envio de e-mail também não estão verificados.

## Estrutura e pontos de entrada

- `extensao/manifest.json` — Manifest V3, tem `"key"` fixa (ID da extensão estável; a allowlist `EXTENSAO_IDS` do servidor depende disso).
- `extensao/background/service-worker.js` — service worker: alarmes, fila, orquestração.
- `extensao/content/facebook.js` — DOM do Facebook (injetado via `chrome.scripting`).
- `extensao/lib/` — `armazenamento.js`, `campanhas.js`, `config.js`, `licenca.js`.
- `extensao/popup/`, `extensao/options/` — interface.
- `worker/src/index.js` — ponto de entrada do Worker (Hono). O app é montado **uma vez** e lê o ambiente de `c.env` por requisição; não montar `criarApp(env)` no topo do módulo (o `env` só existe durante a requisição).
- `worker/src/routes/` — `auth.js`, `extensao.js`, `billing.js`, `admin.js`.
- `worker/src/` — `auth.js`, `billing.js`, `security.js`, `db.js`, `crypto.js`, `email.js`, `config.js`, `log.js`.
- `worker/schema.sql` + `worker/migrations/0001_inicial.sql` — esquema D1. Migrações novas: adicionar arquivo, nunca editar o existente.
- `public/` — landing, `admin.html`, `redefinir.html`, `termos.html`, `privacidade.html` e `downloads/postador-pro.zip`. Servidos pelo binding de assets do Worker; só `/api/*` e o webhook chegam ao Worker.

## Extensão ↔ API

O cookie `SameSite` não atravessa `chrome-extension://`, então a extensão usa token Bearer:

- `POST /api/extensao/login` `{email, senha}` → `{token, licenca}`
- `POST /api/extensao/cadastro` `{nome, email, senha}`
- `GET /api/extensao/licenca` `Authorization: Bearer <token>`
- `POST /api/extensao/checkout`, `/reconciliar`, `/sair` `Authorization: Bearer <token>`
- `GET /api/extensao/planos` — público (preços e limites)
- `GET /api/extensao/avaliacoes` — público (só as aprovadas, exibidas na janela "Avaliar ferramenta")
- `POST /api/extensao/avaliacao` `{nota, comentario}` `Authorization: Bearer <token>`

`EXTENSAO_IDS` (em `worker/wrangler.jsonc`) lista os IDs liberados. Somente `chrome-extension://<ID>` da lista passa na verificação de origem e recebe CORS. Não adicionar `*.workers.dev` nem `<all_urls>` a `host_permissions` do manifest — `npm run verificar:extensao` barra isso.

## Worker / D1 / deploy

- `cd worker && npx wrangler dev` — desenvolvimento local (cria `.wrangler/`; nunca versionar).
- `cd worker && npx wrangler deploy` — produção (`https://postador.hdjlucas.workers.dev`).
- `cd worker && npx wrangler d1 migrations apply DB --remote` — só quando houver migração nova.
- `cd worker && npx wrangler tail` — logs em produção.
- Segredos (token da InfinitePay, etc.): `wrangler secret put` no painel do Cloudflare, **nunca no repositório**. Variáveis não secretas ficam em `worker/wrangler.jsonc` (`vars`).
- O rate limit geral de edge (`RL_GERAL`, `RL_WEBHOOK`) está **desligado** (o Wrangler 4.x recusa o campo). Só vale o limite em D1.
- Cron: `17 3 * * *` (limpeza de sessões, resets, janelas de rate limit).

## Regras inegociáveis (DIRETRIZES.md)

1. Não reescrever a estrutura; mudar só o que a tarefa pede.
2. Uma coisa por vez; cada mudança termina com os testes passando.
3. Mexeu em `extensao/`? Bump de versão + `npm run empacotar` + commit do zip.
4. Não versionar `.env`, `data/`, `*.db`, `.wrangler/`, `node_modules/`, `info.md`.
5. Toda mudança precisa de verificação. Se não deu para rodar, dizer que não foi verificado.
6. Português nos comentários e textos de interface.
7. Sem emoji em código ou arquivo, salvo pedido explícito.
8. Não apagar código antes de o substituto existir e funcionar.
9. Segredos só no painel do Cloudflare (`wrangler secret`).

## Planos e limites (vêm de `wrangler.jsonc`)

- Avaliação: `TRIAL_DAYS` (hoje **7 dias**), 5 grupos/dia, 3 campanhas ativas, 5 destinos por campanha.
- Pro: 10 grupos/dia, 50 campanhas ativas, 100 destinos por campanha.
- Delay padrão entre postagens: 600 a 1200 segundos, sorteado.
- Mensal R$ 25,00; anual R$ 249,00.

Mudar `TRIAL_DAYS` exige editar `worker/wrangler.jsonc` e fazer `wrangler deploy` para valer em produção. Contas já cadastradas mantêm a `trialFim` gravada; a alteração afeta novos cadastros e avaliações reiniciadas pelo admin.

Contas de administrador (`ADMIN_EMAILS`: hoje `hdjlucas@gmail.com` e `aservicos17@gmail.com`) nunca expiram: `estadoDeAcesso` as trata como Pro permanente, com os limites do Pro, tanto na extensão quanto no painel.

## Pagamento, checkout e bloqueio após vencimento (ponto crítico)

- Conta é obrigatória: cadastro com `{nome, email, senha}` via `POST /api/extensao/cadastro`. Não há uso sem conta.
- Avaliação começa no cadastro (`trialFim`). Quando vence, o servidor responde `permitido: false` em `GET /api/extensao/licenca` e a extensão mostra a tela de assinatura; não publica.
- Checkout: `POST /api/extensao/checkout {plano}` retorna a URL da InfinitePay. O usuário paga lá. Cobrança é **manual** (não há débito automático recorrente configurado): após a avaliação, o usuário escolhe e paga um plano.
- Liberação é pelo **webhook da InfinitePay** (`POST /webhooks/infinitepay`), que confirma o pagamento com a InfinitePay e compara o valor, não confia no corpo da requisição. Só então o servidor muda o usuário para `pro` com `dataExpiracao`.
- Se o webhook se perder, a extensão pode chamar `POST /api/extensao/reconciliar` para consultar o servidor e atualizar a licença.
- Bloqueio por vencimento é decidido pelo servidor. A extensão consulta o servidor antes de cada grupo (`licenca.js` falha fechada sem conexão; a carência offline serve só para exibir estado no popup, nunca para iniciar publicação). Alterar a licença localmente no navegador **não** libera uso após vencimento.
- Preços estão em `wrangler.jsonc` (`PLAN_MONTHLY_PRICE: 2500`, `PLAN_ANNUAL_PRICE: 24900`, em centavos = R$ 25,00 / R$ 249,00) e expostos por `GET /api/extensao/planos`.
- Pagamento real ponta a ponta com a InfinitePay **não está verificado**; teste com cuidado antes de confiar em produção.

## Gotchas que um agente provavelmente perderia

- Manifest V3: o Chrome encerra o service worker por inatividade; `chrome.alarms` só dispara com o navegador aberto. Agendamento depende do navegador ficar aberto (documentado na interface e nos termos).
- A extensão armazena campanhas, textos, grupos e histórico **no navegador do cliente**, não no servidor. O servidor guarda apenas a conta do cliente (e-mail, nome, hash da senha, plano, vencimento, histórico de pagamento) e agora também o **contador de publicações diárias** (tabela `publicacoes_dia` no D1).
- `info.md` tem credenciais de administrador e é **local apenas**; nunca commitar nem incluir no zip público.
- Botão "Gerar 3 variações" desabilitado: a rota `POST /api/extensao/gerar-textos` não existe no worker (404). O botão foi desabilitado na interface com aviso claro para não gerar expectativa. Para reativar, implementar a rota no worker ou remover o aviso.
- `DIRETRIZES.md` no GitHub é uma versão antiga; este arquivo só chega a outras IAs se for commitado de propósito.
- Rate limit de edge (`RL_GERAL`, `RL_WEBHOOK`) está **desligado** no `wrangler.jsonc` enquanto o Wrangler recusar o campo `ratelimits`. Até lá, o rate limit roda no D1 (tabela `rate_limits` + `security.limiteD1` nas rotas, incluindo `/publicacao`).
- **Imagem: o transporte é base64.** O canal de mensagens do Chrome (`chrome.tabs.sendMessage`) só transporta JSON: ArrayBuffer/Blob chegam vazios do outro lado — era isso que causava o "Não é possível ler arquivo" do Facebook, e não bloqueio do navegador. O service worker converte os bytes para base64 (`bytesParaBase64`), o content script remonta o arquivo real (`base64ParaBytes` + `new File`) e injeta no compositor via `DataTransfer`. **Não voltar a enviar bytes crus por `sendMessage`.** O teste `imagem: base64 chega íntegro...` em `tests/facebook-content.test.mjs` trava essa regressão.
- **Avaliar ferramenta:** o popup e as opções abrem `extensao/avaliar/avaliar.html` em janela própria (`chrome.windows.create`), sem sair da página. Nota 4 ou 5 entra **publicada direto** na listagem pública; nota 1 a 3 espera aprovação (`NOTA_PUBLICA_DIRETA` em `worker/src/routes/extensao.js`). A migração `0003` traz avaliações de exemplo (aparecem com etiqueta "exemplo" no painel; substituir/apagar quando houver reais). O painel admin tem a seção **"Avaliações"** (aprovar, ocultar, editar o texto e excluir, com cartão de pendentes no topo); o reenvio do cliente atualiza a avaliação e a devolve para revisão. Uma avaliação por conta. Os testes do worker usam armazenamento isolado por teste: cada teste precisa criar os próprios dados (a conta admin incluída).
- Recuperação de senha por e-mail **não funciona em produção sem domínio próprio**: precisa de `npx wrangler email sending enable SEUDOMINIO`, binding `EMAIL` no `wrangler.jsonc`, `EMAIL_FROM` nas vars e `wrangler deploy`. Sem isso, o link vai só para o log e o admin redefini a senha pelo painel.
- O botão "Agendar campanha" foi removido do rodapé do formulário. O agendamento se faz pelo checkbox "Agendar publicação": marcado, o botão principal vira "AGENDAR PUBLICAÇÃO" e salva para o horário escolhido; desmarcado, continua "INICIAR PUBLICAÇÃO" e publica na hora.
- Um `$('id')` no `options.js`/`popup.js` apontando para elemento inexistente no HTML correspondente quebra a interface inteira (a tela fica só em "Verificando…"). O `npm run verificar:extensao` agora detecta isso e barra o empacotamento.
- "Usar novamente" funciona para campanhas concluídas ou falhadas, criando uma nova execução com os mesmos textos e destinos.

## Seletores do Facebook (revisar se a publicação quebrar)

O Facebook muda o DOM com frequência. Se a extensão parar de publicar, revisar esses seletores em `extensao/content/facebook.js` (`SELETORES`):

- `compositor`: `[role="dialog"] [contenteditable="true"]`, `[role="dialog"] [aria-label*="Escreva"]`, `[role="dialog"] [aria-label*="Write"]`
- `botaoPublicar`: `[role="dialog"] [aria-label="Publicar"]`, `[role="dialog"] [aria-label="Post"]`, `[role="dialog"] button[type="submit"]`
- `botaoFoto`: `[role="dialog"] [aria-label="Foto/vídeo"]`, `[role="dialog"] [aria-label="Photo/video"]`, `[role="dialog"] input[type="file"]`

Função `diagnosticarPagina()` já captura rótulos de botões e diálogos quando o compositor não é encontrado — usar essa saída para ajustar os seletores.

## Monitoramento em produção

- Endpoint `GET /api/health` responde se a API está no ar (pode ser monitorado externamente, ex: UptimeRobot).
- `cd worker && npx wrangler tail` mostra logs em tempo real.
- Observabilidade já está ligada no `wrangler.jsonc` (`observability.enabled`).
- Não há alerta automático configurado (e-mail/WhatsApp quando algo quebra).

