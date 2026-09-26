# Postador Pro

Extensão de navegador para divulgar produtos em grupos do Facebook, com
assinatura mensal ou anual e cobrança pela InfinitePay.

O usuário instala a extensão, fica com a **conta do Facebook dele mesmo** já
logada no navegador dele, cria campanhas com texto, imagem, lista de grupos e
horário, e a extensão publica. A senha do Facebook nunca entra no produto.

## Como está dividido

**A extensão** (na máquina do cliente) faz toda a publicação. Campanhas, textos,
imagens, destino, horário, histórico, delay e agendamento vivem no navegador do
cliente. Ela publica na aba em que o próprio usuário está logado, com delay
aleatório entre um destino e outro, para não derrubar a conta.

**A API de licença** (o servidor) tem quatro funções: autenticar o usuário, dizer
se a assinatura está ativa e até quando, receber o webhook da InfinitePay para
liberar ou renovar, e servir o download da extensão. Ela não publica nada.

O webhook da InfinitePay só é chamado por HTTPS público, e extensão não tem URL.
Por isso existe servidor. O que ele não tem é navegador, display virtual nem
memória: uma VPS de 1 GB roda a API de licença com folga.

Agendamento depende do navegador aberto. No Manifest V3 o Chrome encerra o
service worker após inatividade e o `chrome.alarms` só dispara com o navegador
ligado. Isso está escrito na interface e nos termos de uso.

## Estrutura

```
extensao/                  a extensão (em construção)
  manifest.json            Manifest V3
  background/              service worker: alarmas, fila, orquestração
  content/                 DOM do Facebook: digita, anexa, publica
  popup/ options/          interface
  lib/                     armazenamento local, licença, imagens

server.js                  boot da API de licença
src/
  app.js                   middlewares, rotas e criação do Express
  http.js                  cookies, cabeçalhos, CSP, CORS e CORP
  config.js                .env, planos, limites, allowlist, validação de boot
  db.js                    NeDB, índices, compactação, backup
  auth.js                  sessões, token da extensão, hash, trava de conta
  security.js              CSRF, origem, rate limit, allowlist de extensão
  email.js                 SMTP: recuperação de senha
  log.js                   log JSON estruturado
  billing.js               checkout, webhook, idempotência
  routes/
    auth.js                cadastro, login, sessão, recuperação, exclusão
    billing.js             checkout, assinatura e webhook
    extensao.js            login por token, licença, checkout, reconciliação
    admin.js               rotas administrativas
    helpers.js             utilitários de rota
public/
  index.html               página de instalação e planos
  redefinir.html           recuperação de senha
  admin.html               painel administrativo
  termos.html              termos de uso e responsabilidade
  privacidade.html         política de dados
  assets/                  estilo e script das três telas
data/                      bancos e backups (nunca versionado)
tests/smoke.test.js        suíte de fumaça da API de licença
scripts/
  check-syntax.js          sintaxe de todos os .js
  check-modulos.js         chamadas entre módulos e funções do próprio arquivo
  preflight.js             o que impede a subida em produção
  backup.js                criar, listar e restaurar backup
  testar-backup.js         prova de que o backup volta
```

## Como a extensão fala com o servidor

A extensão não tem cookie jar, e cookie `SameSite` não atravessa a fronteira
`chrome-extension://`. Autenticação por sessão, portanto, não funcionaria. O
caminho é token:

```
POST /api/extensao/login        { email, senha }  ->  { token, licenca }
GET  /api/extensao/licenca      Authorization: Bearer <token>
POST /api/extensao/checkout     Authorization: Bearer <token>
POST /api/extensao/reconciliar  Authorization: Bearer <token>
GET  /api/extensao/planos       público: preços e limites
```

O token fica guardado no servidor apenas como SHA-256 e vale
`TOKEN_EXTENSAO_DIAS` dias. O navegador nunca anexa `Authorization` sozinho numa
requisição de outro site, então as rotas `/extensao/*` dispensam CSRF: onde o
token falta, quem responde é 401.

Dois ajustes que a extensão exige e a API precisava:

- `EXTENSAO_IDS` lista os IDs liberados. Só `chrome-extension://<ID>` da lista
  passa na verificação de origem e só eles recebem cabeçalho de CORS.
- `Cross-Origin-Resource-Policy` é `cross-origin` em `/api/` e `same-origin` no
  HTML. Com `same-origin` em todo lugar, o navegador descartaria a resposta
  antes de a extensão conseguir ler.

O ID da extensão só existe depois que o `extensao/manifest.json` tiver uma
`key` fixa. Pegue em `chrome://extensions`, na página da extensão, campo "ID".

## Instalação local

```bash
npm install
cp .env.example .env
npm run lint
npm test
npm start
```

O servidor sobe em `http://localhost:3000`.

## Verificação

```bash
npm run lint   # sintaxe de todos os .js e nomes chamados
npm test       # 60 verificações da API de licença
npm run preflight
npm run backup -- listar
npm run verificar:backup
```

O `preflight` sai com código 1 quando algo impede o serviço: disco cheio, pasta
sem escrita, SMTP ausente em produção, URL sem HTTPS. É o filtro entre "rodei o
deploy" e "descobri com cliente esperando que nada funciona".

## Deploy

```bash
bash deploy-vps.sh <dominio> <email_admin> <infinitepay_handle>
bash update.sh    # em atualizações, na VPS
```

`update.sh` faz backup antes do `git pull` e não reinicia se a configuração
estiver inválida.

## O que o servidor guarda

Só a conta do cliente: e-mail, nome, hash da senha, plano, vencimento e histórico
de pagamento. Campanha, publicação, imagem e destino **não vão para o servidor**:
ficam no navegador do cliente, e o cliente os exporta e apaga de lá.

## Licença

`instances: 1` no PM2. A reserva de cobrança idempotente depende de um processo
só: com duas instâncias, dois webhooks simultâneos poderiam liberar a mesma
compra duas vezes.
