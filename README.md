# Postador Pro

Ferramenta de publicação em grupos do Facebook, com login manual por perfil
isolado do navegador, fila de execução, cobrança via InfinitePay e painel
administrativo. Multi-tenant: cada conta tem seus próprios perfis, campanhas,
uploads e histórico, e só enxerga os próprios dados.

## Como funciona

O usuário conecta uma conta do Facebook, cria uma campanha com texto, imagens,
destinos e horário, e o servidor executa a publicação mais tarde, no perfil
navegador que ele mesmo conectou. O aplicativo nunca recebe a senha do
Facebook: o login acontece na janela do Chromium.

## Estrutura

```
server.js              boot: HTTP, fila, agendamentos, shutdown
src/
  app.js               middlewares e criação do Express
  http.js              cookies, cabeçalhos de segurança, CSP
  config.js            leitura do .env, planos, limites, validação
  db.js                NeDB, índices, compactação, backup
  auth.js              sessões, senha, tokens de redefinição
  security.js          CSRF, origem, rate limit, sanitização
  log.js               log JSON estruturado
  cron-agenda.js       intervalo em minutos -> expressão cron válida
  queue.js             agrupamento, concorrência, retentativas
  facebook.js          perfis isolados e ciclo de vida dos navegadores
  executor.js          digitação, rolagem e publicação no Facebook
  billing.js           checkout, webhook, idempotência
  routes/              auth, campanhas, contas, cobrança, admin, páginas
public/                interface, termos e privacidade
data/                  bancos, perfis, uploads e backups (nunca versionado)
tests/smoke.test.js    suíte de fumaça
scripts/               verificações de sintaxe e de chamadas entre módulos
```

## Instalação local

```bash
npm install
cp .env.example .env
npm start
```

Acesse `http://localhost:3000`. Rode `npm start` sem `INFINITEPAY_HANDLE` para
trabalhar com o checkout desativado; o resto do app funciona normalmente.

O Chromium do puppeteer é baixado automaticamente. Se faltar:

```bash
npx puppeteer browsers install chrome
```

## Verificação

```bash
npm run lint   # sintaxe de todos os arquivos + chamadas entre módulos
npm test       # suíte de fumaça
npm run preflight  # o que impede a subida em produção
```

A suíte sobe o app no próprio processo, com diretório de dados temporário, e
cobre autenticação, isolamento entre usuários, limites de plano, CSRF, origem,
exposição de arquivos, upload, fila, cobrança e admin.

`npm run preflight` confere o que só quebra em produção: navegador presente,
espaço em disco, permissão de escrita, display virtual (Xvfb) e a configuração
do `.env`. Ele sai com código 1 se algo impedir a publicação. Use antes de
`deploy-vps.sh` e de `update.sh` — os dois já chamam o preflight.

Depois de subir, confira a instância de fora:

```bash
node scripts/smoke-online.js https://seu-dominio
```

São 28 verificações: HTTPS, cabeçalhos de segurança, arquivos privados
(`.env`, `data/`, `*.db`, código-fonte), API, bloqueio de CSRF e páginas
públicas. Resposta `28/28` significa que dá para mostrar o link ao cliente.

## Backup

```bash
npm run backup -- listar                    # backups disponíveis
npm run backup -- criar                     # gera um agora
npm run backup -- restaurar backup-2026-... # restaura (pare o app antes)
```

O backup automático roda a cada `BACKUP_MINUTOS` (padrão: 6 horas), apenas com
`NODE_ENV=production`, e mantém as `BACKUPS_MAXIMOS` cópias mais recentes (30).
Os backups ficam em `data/backups`, **na mesma máquina**: copie para fora, senão
perder o disco é perder tudo.

> **Antes de publicar o produto, leia [`DIRETRIZES.md`](DIRETRIZES.md).**
> Ele registra as regras inegociáveis, a arquitetura atual, as correções já
> feitas e o plano por etapas para ir ao ar.
>
> Para colocar no ar: [`GUIA-PUBLICACAO.md`](GUIA-PUBLICACAO.md) tem o passo a
> passo de domínio, VPS, túnel, SMTP e InfinitePay.

## Configuração

Todas as variáveis estão documentadas e comentadas em `.env.example`. As que
mais costumam ser esquecidas:

| Variável | Por quê importa |
|---|---|
| `PUBLIC_BASE_URL` | Endereço usado no link de redefinição e na validação de origem. Precisa ser HTTPS em produção. |
| `TRUST_PROXY` | Quantos proxies vêm antes do Node. Sem isso o rate limit enxerga o IP do proxy e o cookie Secure sai errado. |
| `SMTP_*` | Sem SMTP o app **não sobe** em produção: o cliente não conseguiria recuperar a senha. |
| `ADMIN_EMAILS` | Sem isso ninguém entra em `/admin`. |
| `INFINITEPAY_HANDLE` | Sem isso o checkout responde que o pagamento está indisponível. |
| `DATA_DIR` | Banco, perfis e uploads. Faça backup deste diretório. |
| `MAX_NAVEGADORES_CONCORRENTES` | Cada navegador é um Chromium headful. Dimensione pela RAM da máquina. |

O servidor valida a configuração no boot: um problema (como SMTP ausente em
produção) impede a inicialização em vez de falhar mais tarde, no meio de uma
publicação.

## Planos

| Recurso | Avaliação (trial) | Assinante (pro) |
|---|---|---|
| Contas Facebook | 1 | 10 |
| Campanhas ativas | 3 | 200 |
| Destinos por campanha | 20 | 100 |

Todo cadastro começa com 7 dias de avaliação, guardados no banco da conta.
Preços e limites são ajustáveis por ambiente (`PLAN_*_PRICE`, `LIMIT_*`).

## Cobrança (InfinitePay)

O checkout é criado em `https://api.checkout.infinitepay.io/links` e a
confirmação chega em `POST /api/webhooks/infinitepay`.

A aplicação do pagamento é idempotente: o registro é reivindicado com uma
escrita condicional, de modo que dois webhooks simultâneos não concedem a
mesma compra duas vezes. Renovações acumulam sobre a data atual.

## Publicação

As publicações de uma mesma conta são agrupadas e executadas na mesma sessão
do navegador, com cadência de digitação variável, rolagem antes de escrever e
espera aleatória entre postagens. A fila reprocessa o que falhou até
`MAX_TENTATIVAS` e, ao reiniciar o servidor, retoma o que ficou pendente.

Erros permanentes (sessão expirada, perfil sem acesso, elemento não
encontrado) não são repetidos: repetir não resolve. Erros de infraestrutura
entram em retentativa com espera crescente.

O Chromium é aberto em modo headful. Em servidor Linux sem monitor, é
obrigatório um display virtual (Xvfb) — o `deploy-vps.sh` instala e habilita o
Xvfb como serviço.

## Produção

```bash
bash deploy-vps.sh <dominio> <email_admin> <infinitepay_handle>
```

O script instala Node, as bibliotecas do Chromium, PM2, cloudflared e o Xvfb;
depois exige que o SMTP seja preenchido no `.env` antes de o app conseguir
subir. Para atualizar uma instalação existente, use `bash update.sh`, que faz
backup antes do `git pull` e valida a configuração antes de reiniciar.

Pontos que importam em produção:

1. **HTTPS é obrigatório.** Com `PUBLIC_BASE_URL` em http o cookie de sessão
   não sai com `Secure`, e o link de redefinião chega errado ao cliente.
2. **`instances: 1` no PM2 é obrigatório.** A fila e a reserva de cobrança
   idempotente vivem na memória do processo. Duas instâncias poderiam
   publicar a mesma campanha em paralelo e liberar a mesma compra duas vezes.
3. **Nunca versionar `data/`.** Contém sessões, e-mails, hashes de senha e os
   perfis do navegador. O backup automático grava em `data/backups`; copie
   esse diretório para fora da máquina.
4. **O backup só roda com `NODE_ENV=production`**, na cadência de
   `BACKUP_MINUTOS`. O log de boot mostra a expressão gerada, no campo
   `agendamentos`.
5. Logs são JSON estruturados. Os eventos úteis: `http`, `servidor_iniciado`,
   `agendamentos`, `publicacao_sucesso`, `publicacao_falha`, `infinitepay_*`.

## Privacidade e termos

`public/termos.html` e `public/privacidade.html` são rascunhos. A ferramenta
automatiza o navegador do próprio usuário e publica em grupos do Facebook: os
dois textos precisam ser revisados por um advogado antes da venda, e o
operador precisa conferir as regras da Meta para os destinos usados.
