# Postador Pro

Extensão de navegador para divulgar produtos em grupos do Facebook, com
assinatura mensal ou anual e cobrança pela InfinitePay.

O cliente instala a extensão, fica com a **conta do Facebook dele mesmo** já
logada no navegador, cria campanhas com texto, imagem, lista de grupos e
horário, e a extensão publica. A senha do Facebook nunca entra no produto.

## Como está dividido

**A extensão** (`extensao/`, na máquina do cliente) faz toda a publicação.
Campanhas, textos, imagens, destinos, horário, histórico, delay e agendamento
vivem no navegador do cliente. Ela publica na aba em que o próprio usuário está
logado, com intervalo aleatório entre um grupo e outro.

**A API de licença** (`worker/`, Cloudflare Workers + Hono + D1) autentica o
usuário, informa se a assinatura está ativa e até quando, recebe o webhook da
InfinitePay para liberar ou renovar, e serve a landing e o download da
extensão. Ela não publica nada. Endereço em produção:
`https://postador.hdjlucas.workers.dev`.

**A landing** (`public/`) é servida direto do edge: página de instalação e
planos, recuperação de senha, painel do administrador, termos e privacidade.

Agendamento depende do navegador aberto. No Manifest V3 o Chrome encerra o
service worker por inatividade e `chrome.alarms` só dispara com o navegador
ligado. Isso está escrito na interface e nos termos de uso.

## Estrutura

```
extensao/        a extensão (Manifest V3)
worker/          API de licença (Workers + D1), com testes
public/          landing, telas e downloads/postador-pro.zip
scripts/         empacotar-extensao.js
tests/           testes da extensão
DIRETRIZES.md    regras e estado atual do projeto (leia antes de mexer)
```

## Verificação

```bash
npm test                    # testes da extensão
npm run verificar:extensao  # manifesto, permissões, sintaxe e referências
cd worker && npm install && npm test   # 22 testes da API
```

## Gerar o zip que o cliente baixa

Depois de qualquer mudança em `extensao/`, suba o `version` do
`extensao/manifest.json` e rode:

```bash
npm run empacotar
```

O comando verifica a extensão e grava `public/downloads/postador-pro.zip`.
Commite o zip junto com a mudança.

## Publicar a API e a landing

```bash
cd worker
npx wrangler d1 migrations apply DB --remote   # só quando houver migração nova
npx wrangler deploy
```

Segredos (token da InfinitePay, se houver) ficam no painel do Cloudflare ou em
`wrangler secret put`, nunca no repositório. Variáveis não secretas, planos e
limites ficam em `worker/wrangler.jsonc`.

## Como a extensão fala com o servidor

Cookie `SameSite` não atravessa a fronteira `chrome-extension://`, então a
extensão usa token:

```
POST /api/extensao/login        { email, senha }  ->  { token, licenca }
POST /api/extensao/cadastro     { nome, email, senha }
GET  /api/extensao/licenca      Authorization: Bearer <token>
POST /api/extensao/checkout     Authorization: Bearer <token>
POST /api/extensao/reconciliar  Authorization: Bearer <token>
POST /api/extensao/sair         Authorization: Bearer <token>
GET  /api/extensao/planos       público: preços e limites
```

`EXTENSAO_IDS` (em `wrangler.jsonc`) lista os IDs liberados. Só
`chrome-extension://<ID>` da lista passa na verificação de origem e recebe CORS.
O ID é fixo porque o `manifest.json` tem uma `key`.

## O que o servidor guarda

Só a conta do cliente: e-mail, nome, hash da senha, plano, vencimento e
histórico de pagamento. Campanha, publicação, imagem e destino **não vão para
o servidor**: ficam no navegador do cliente.

## Fila em grupos

A extensão aceita um grupo por linha e faz uma nova postagem por destino. O
intervalo padrão é sorteado entre 10 e 20 minutos e o usuário pode configurar
entre 10 minutos e 2 horas. A fila pausa diante de falha de publicação ou aviso
do Facebook. Se o envio for incerto, pede confirmação antes de retomar e ignora
esse grupo para não duplicar. O navegador precisa permanecer aberto.

Limites por dia: 5 grupos na avaliação e 10 no plano Pro.
