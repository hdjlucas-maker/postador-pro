# DIRETRIZES — Postador Pro

> Leia antes de tocar em qualquer coisa. Se algo aqui estiver errado, corrija o
> arquivo em vez de ignorar.

Repositório: https://github.com/hdjlucas-maker/postador-pro

---

## 1. O que é o produto

Uma **extensão de navegador** que o usuário instala na própria máquina.

O usuário instala a extensão, já com a **conta do Facebook dele** logada no
navegador dele, cria campanhas com texto, imagem, lista de grupos e horário, e a
extensão publica. A senha do Facebook nunca entra no produto, em nenhuma
hipótese.

Não é SaaS. Não é painel web. Não é página pública. Não há navegador aberto em
servidor. Não há perfil de navegador guardado em servidor.

## 2. Para que serve

Divulgar produtos em grupos do Facebook em massa, com limite de tempo e custo
mensal ou anual, dentro de um ritmo que não derruba a conta do usuário.

Funções do produto:

- publicar texto e imagem em vários grupos;
- agendar a publicação por horário;
- delay aleatório entre publicações, para evitar bloqueio de conta;
- histórico do que foi publicado e do que falhou;
- teste limitado, plano mensal e plano anual;
- cobrança pela InfinitePay.

## 3. Como está dividido

Dois pedaços, com uma fronteira clara entre eles.

**A extensão** (na máquina do cliente) — toda a publicação. Campanhas, textos,
imagens, destino, horário, histórico, delay, agendamento e contadores de uso
vivem no navegador do cliente. A extensão publica na aba em que o próprio
usuário está logado.

**O servidor mínimo** — só a assinatura. Quatro funções: autenticar o usuário,
dizer se a assinatura está ativa e até quando, receber o webhook da InfinitePay
para liberar ou renovar, e servir o arquivo de download da extensão. Nada mais.

### Por que o servidor não some inteiro

O webhook da InfinitePay só é chamado por HTTPS público, e extensão não tem
URL. Logo existe uma URL pública em algum lugar. O que muda é o tamanho do que
fica atrás dela: uma API pequena, sem navegador, sem display virtual, sem 4 GB
de RAM.

### Agendamento depende do navegador aberto

No Manifest V3 o Chrome encerra o service worker após inatividade, e
`chrome.alarms` só dispara com o navegador ligado. Uma publicação programada
para as 3h acontece se o Chrome estiver aberto às 3h. Isso é o comportamento do
produto e está escrito na interface e nos termos, não escondido.

## 4. Arquitetura atual

```
extensao/                  A SER CRIADA (etapa A). Nada existe ainda.
  manifest.json            Manifest V3
  background/              service worker: alarmas, fila, orquestração
  content/                 DOM do Facebook: digita, anexa, publica
  popup/ options/          interface
  lib/                     armazenamento local, licença, imagens

server.js                  boot da API de licença
src/
  app.js                   middlewares, rotas, criação do Express
  http.js                  cookies, cabeçalhos de segurança, CSP
  config.js                .env, planos, limites, validação de boot
  db.js                    NeDB, índices, compactação, backup
  log.js                   log JSON estruturado
  auth.js                  sessões, hash de senha, tokens de redefinição
  security.js              CSRF, verificação de origem, rate limit
  email.js                 SMTP: recuperação de senha
  billing.js               checkout, webhook, idempotência
  admin.js                 painel administrativo
  routes/
    auth.js                cadastro, login, sessão, recuperação
    billing.js             checkout e status de pagamento
    admin.js               rotas administrativas
public/
  termos.html              termos de uso e responsabilidade
  privacidade.html         política de dados
  index.html               vira a interface da extensão
  assets/
tests/smoke.test.js        suíte de fumaça do servidor
scripts/                   check-syntax, check-modulos, backup, preflight
data/                      bancos e backups (NÃO versionar)
```

## 5. Regras inegociáveis

1. **Não reescreva a estrutura.** Os módulos em `src/` estão prontos e
   testados. Só mude o que a tarefa pedir.
2. **`instances: 1` no PM2.** A reserva de cobrança idempotente depende de um
   processo só. Duas instâncias = mesma compra liberada duas vezes.
3. **Não versione `data/`.** Tem sessões, e-mails e hashes de senha. Já está no
   `.gitignore`.
4. **Antes de criar arquivo, verifique se já existe.** Use `grep`/`glob` antes
   de `write`.
5. **Toda mudança precisa de verificação.** Se não deu para rodar, diga
   explicitamente que não foi verificado. Não declare pronto o que não testou.
6. **Português nos comentários e nos textos de interface.** Sem exceção.
7. **Nada de emoji em código ou arquivo**, salvo pedido explícito.
8. **Não apague código antes de o substituto existir e funcionar.** Remoção vem
   depois da verificação, nunca antes.

## 6. O que já está feito

**No servidor**

- API de Express com middlewares de segurança, rotas separadas e shutdown limpo.
- Autenticação com hash bcrypt e salt, sessão em cookie `httpOnly` + `SameSite`
  + `Secure` em HTTPS, e recuperação de senha por SMTP.
- **Token para a extensão**: `Authorization: Bearer` com o valor guardado só
  como SHA-256. A extensão não tem cookie jar — cookie `SameSite` não atravessa
  a fronteira da extensão, então sessão por cookie não funcionaria.
- Allowlist de origem da extensão: só `chrome-extension://<ID>` listados em
  `EXTENSAO_IDS` passam, e só eles recebem cabeçalho de CORS. Página comum não
  ganha CORS nenhum.
- `Cross-Origin-Resource-Policy: cross-origin` só nas rotas `/api/`; o HTML
  continua `same-origin`. Com `same-origin` em todo lugar, o navegador
  descartaria a resposta antes de a extensão ler.
- Proteção CSRF por token em cookie com header obrigatório em escrita, mais
  verificação de `Origin`/`Referer`. As rotas `/extensao/*` ficam de fora: elas
  autenticam por token, e sem token quem responde é 401, não 403 de CSRF.
- Rate limit por IP nas rotas sensíveis, mais trava de conta por tentativas
  erradas em sequência (`LOGIN_FALHAS_MAX`), que segura o ataque vindo de IPs
  diferentes.
- `/api/estado` exige login e `ADMIN_EMAILS`: ele revelava se o SMTP e a
  InfinitePay estavam configurados.
- Isolamento entre usuários em toda leitura de dado.
- Somente `public/` é servido; `.env`, `data/`, `*.db` e código-fonte retornam
  404.
- CSP com `script-src 'self'` estrito, `object-src 'none'` e
  `frame-ancestors 'none'`.
- Painel administrativo restrito a `ADMIN_EMAILS`.
- App não sobe com SMTP ausente em produção.

**Cobrança**

- Checkout da InfinitePay com o handle configurável.
- Webhook com escrita condicional (`aplicadoEm: { $exists: false }`): dois
  webhooks simultâneos não concedem a mesma compra duas vezes.
- Renovação acumula sobre a data atual.
- Validação de plano acontece antes de reclamar a configuração de pagamento,
  então entrada inválida devolve 400 mesmo sem handle.

**Infraestrutura**

- NeDB com índices, compactação periódica e backup com retenção
  configurável (`BACKUPS_MAXIMOS`, padrão 30).
- `scripts/backup.js` cria, lista e **restaura** backup pela linha de comando.
- `scripts/preflight.js` confere disco, permissões de escrita e configuração
  antes de subir, e sai com código 1 se algo impedir o serviço.
- `scripts/check-syntax.js` e `scripts/check-modulos.js` conferem sintaxe de
  todos os `.js`, as chamadas entre módulos e as chamadas a funções do próprio
  arquivo. Um erro de digitação como `addMinutos` no lugar de `addMinutes` tem
  sintaxe válida e só quebra em tempo de execução; o lint pega antes.
- `.gitignore` cobre `data/`, logs e uploads. `.gitattributes` força LF em
  tudo, senão os scripts bash chegam na máquina errada com CRLF.

**Interface no servidor**

- Três telas, e só três: a página de instalação (`/`), a recuperação de senha
  (`/redefinir`) e o painel do administrador (`/admin`). Visual no azul do
  Facebook, para o cliente não confundir com o Facebook nem com um painel
  quebrado.
- O painel SaaS antigo foi apagado. Ele abria, mas cada botão chamava rota que
  não existe mais: o usuário via um menu de campanha e não acontecia nada.
- Termos e privacidade reescritos para o modelo real: dados locais na
  extensão, servidor só com conta e licença.

**Testes**

- Suíte de fumaça em processo próprio, com `DATA_DIR` temporário: 60
  verificações cobrindo auth, isolamento entre usuários, limites de plano, CSRF,
  origem, exposição de arquivos, cobrança, admin, rate limit, token da
  extensão, trava de conta e CORP. Inclui a prova de que as rotas da antiga
  arquitetura (`/api/campaigns`, `/api/dashboard`,
  `/api/facebook/accounts`, `/api/uploads`) respondem 404.

## 7. O que falta

Uma etapa por vez, na ordem. Cada etapa termina com `npm run lint && npm test`
passando e esta seção atualizada.

**Etapa A — Enxugar o servidor até sobrar só a licença** (FEITA)
- [x] Remover o executor, os perfis de navegador e a fila de publicação
- [x] Remover as rotas de campanha, conta conectada e upload
- [x] Tirar `puppeteer` e `node-cron`; trocar o cron de backup por relógio de
      intervalo, sem os dois campos de hora e minuto
- [x] Deixar o banco com quatro coleções: usuários, sessões, pagamentos e
      tokens de redefinição
- [x] Reescrever a suíte de testes para o que ficou
- [x] Atualizar `README.md`, `.env.example`, `ecosystem.config.js` e os scripts
      de deploy

**Etapa A2 — Fechar a superfície da API e matar a interface inerte** (FEITA)
- [x] Token `Authorization: Bearer` para a extensão, sem depender de cookie
- [x] `EXTENSAO_IDS` como allowlist de origem, com CORS só para elas
- [x] `Cross-Origin-Resource-Policy` liberada em `/api/` e mantida restrita no
      HTML
- [x] CSRF liberado nas rotas `/extensao/*`, que não têm cookie jar
- [x] `/api/estado` fechado para administradores
- [x] Trava de conta por falhas de login, além do rate limit por IP
- [x] Apagar o painel SaaS inerte e deixar três telas: instalação, redefinição
      de senha e administração
- [x] Reescrever termos e privacidade para o modelo de dados local
- [x] 60 verificações cobrindo o que acima

**Etapa B — Esqueleto da extensão**
- [ ] `extensao/manifest.json` no Manifest V3
- [ ] Popup mínimo que abre, com versão e botão de login
- [ ] `lib/armazenamento.js`: IndexedDB para imagem, `storage` para o resto
- [ ] Carregar em `chrome://extensions` sem erro no console

**Etapa C — Publicação real em um grupo**
- [ ] `content/facebook.js`: abrir o compositor, digitar, anexar imagem,
      publicar
- [ ] Teste em um grupo de verdade, com print do resultado
- [ ] Só aqui o produto passa a existir

**Etapa D — Campanhas, destinos e delay**
- [ ] Criar campanha: texto, imagem, lista de grupos, horário
- [ ] Fila sequencial com delay aleatório entre destinos
- [ ] Agendamento por `chrome.alarms`, avisando que exige o navegador aberto
- [ ] Histórico local: publicado, falhou, pulou

**Etapa E — Licença e limites**
- [ ] `lib/licenca.js`: consulta o servidor, guarda o estado, tem carência
      offline para não cobrar o usuário por falha nossa
- [ ] Plano mensal e anual, período de teste, limites por plano
- [ ] Ao vencer, a extensão para de publicar
- [ ] Decidir como a extensão se autentica: cookie com `SameSite` não é enviado
      em requisição de outra origem, então provavelmente token, não sessão

**Etapa F — Cobrança no servidor mínimo**
- [ ] Rota de licença que a extensão consulta
- [ ] Webhook da InfinitePay com a idempotência que já existe
- [ ] Servir o `.zip` da extensão
- [ ] Liberação automática e conferida

**Etapa G — Termos, responsabilidade e dados**
- [ ] `termos.html` e `privacidade.html` reescritos para extensão: o que fica
      só no navegador, o que sai do servidor, e que publicar em grupo é
      responsabilidade do usuário
- [ ] Consentimento explícito no primeiro uso
- [ ] Aviso sobre regra do Facebook e risco de bloqueio de conta

**Etapa H — Empacotar e entregar**
- [ ] Empacotador que gera o `.zip` instalável
- [ ] Instrução de instalação para o cliente leigo
- [ ] `verificar:extensao`: confere manifesto, permissões e sintaxe

## 8. Regras do código da extensão

- **Manifest V3.** `host_permissions` para `facebook.com` e `web.facebook.com`.
  Permissões: `storage`, `alarms`, `tabs`, `scripting`.
- **Imagens em `IndexedDB`**, não em `storage`. A cota do `storage` estoura com
  imagem.
- **Delay aleatório entre publicações.** É o que evita bloqueio de conta. Os
  valores já existem em `config.js` (`DELAY_ENTRE_POSTS_MIN`/`MAX`,
  `CADENCIA_MIN_MS`/`MAX`) e são levados para a extensão.
- **Nenhum acesso a senha ou cookie do Facebook.** A extensão publica na aba em
  que o usuário já está logado. Ela não lê credencial nenhuma.

## 9. Verificação

```bash
npm run lint   # sintaxe de todos os .js e chamadas entre módulos
npm test       # suíte de fumaça do servidor
npm run preflight
npm run backup -- listar
```

`preflight` sai com código 1 se algo impedir o serviço. É o filtro entre "rodei
o deploy" e "descobri no meio da campanha que nada funciona".

## 10. Como seguir no próximo dia

1. Leia este arquivo.
2. `npm run lint && npm test` — confirme antes de mudar qualquer coisa.
3. Faça **uma** coisa da seção 7.
4. Atualize a seção 6 com o que mudou.
5. `npm run lint && npm test` de novo.

Se algo aqui estiver desatualizado, corrija o arquivo. Este documento vale
mais que a memória de qualquer sessão.
