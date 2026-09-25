# Postador Pro — primeira versão comercial

## Arquivos

- `index.html` — interface, login, dashboard, campanhas, contas Facebook e assinatura.
- `server.js` — autenticação, trial, banco, campanhas, pagamentos, webhook e fila de execução.
- `facebook.js` — abre perfis isolados do navegador para o login manual do Facebook.
- `package.json` — dependências.
- `.env.example` — configurações.
- `.gitignore` — evita publicar bancos e credenciais.

## Instalação

```powershell
npm install
```

Copie `.env.example` para `.env` e preencha:

```text
INFINITEPAY_HANDLE=sua_infinite_tag
PUBLIC_BASE_URL=https://seu-dominio.com
```

Para testar apenas localmente:

```text
PUBLIC_BASE_URL=http://localhost:3000
```

Depois:

```powershell
npm start
```

Acesse `http://localhost:3000`.

## Planos

- Mensal: R$ 25,00
- Anual: R$ 249,00

A conta recebe 7 dias de avaliação no cadastro. O prazo fica armazenado no banco da conta, não no navegador.

Limites por plano (aplicados no servidor):

| Recurso | Avaliação (trial) | Assinante (pro) |
|---|---|---|
| Contas Facebook | 1 | 10 |
| Campanhas ativas | 3 | 200 |
| Destinos por campanha | 20 | 100 |

## InfinitePay

O servidor cria o checkout em `https://api.checkout.infinitepay.io/links` e recebe a confirmação em:

`POST /api/webhooks/infinitepay`

Em produção, `PUBLIC_BASE_URL` precisa ser uma URL pública HTTPS para a InfinitePay conseguir chamar o webhook.

## Facebook

O botão `Conectar Facebook` abre uma janela do Chromium com um perfil separado. O usuário faz o login diretamente no Facebook. O Postador não solicita a senha do Facebook no formulário da aplicação.

A integração do executor existente (`postador.js`) precisa reutilizar o mesmo diretório de perfil retornado por `facebook.js` para aproveitar a sessão conectada.

Para desconectar uma conta, acesse **Contas Facebook → Desconectar**. A janela é fechada, o perfil local é removido e o limite de contas do plano é liberado.

## Histórico

O histórico é paginado (`/api/history?page=1&perPage=25&accountId=...`) e pode ser filtrado por conta. O CSV (`/api/history/export.csv`) respeita o mesmo filtro `accountId`.

## Executor (anti-bot)

O servidor agrupa as publicações de uma mesma conta e as executa na mesma sessão do navegador:

- Cadência de digitação variável (pausas humanas).
- Rolagem natural antes de escrever e publicar.
- Espera aleatória entre postagens da mesma conta.
- Verifica login apenas na primeira postagem do grupo.

Ajustes via ambiente: `CADENCIA_MIN_MS`, `CADENCIA_MAX_MS`, `DELAY_ENTRE_POSTS_MIN`, `DELAY_ENTRE_POSTS_MAX`.

## Importante para produção

1. Colocar o servidor atrás de HTTPS (Nginx/Caddy/Cloudflare). Em `PUBLIC_BASE_URL` use a URL https do domínio — com HTTPS os cookies saem com `Secure`.
2. Ao usar proxy reverso, defina `TRUST_PROXY` (ex.: `TRUST_PROXY=1` para um único proxy) para o servidor enxergar o IP real e o esquema HTTP correto do cliente.
3. Configurar a InfinitePay e testar o webhook (`POST /api/webhooks/infinitepay`).
4. Revisar as permissões e regras atuais da Meta para os destinos de publicação usados pela ferramenta.
5. Não publicar `.env` nem os bancos `.db`.
6. Gerenciar o processo com PM2 ou systemd e monitorar os logs JSON estruturados emitidos pelo servidor (eventos `http`, `publicacao_sucesso`, `publicacao_falha`, `infinitepay_*`).

## Executor existente

Mantenha seu `postador.js` na mesma pasta. O servidor chama `dispararPostagens({ posts })` para cada grupo de destinos de uma conta. O objeto de cada post já inclui `grupoUrl`, `perfilId`, `accountId` e `profileDir` da conta conectada.
