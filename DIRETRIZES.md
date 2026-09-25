# DIRETRIZES — Postador Pro

> **Leia este arquivo ANTES de tocar em qualquer coisa.**
> Ele existe para você não redescrever o projeto de novo.
> Se algo aqui estiver errado, corrija o arquivo — não ignore.

---

## 1. O que é este projeto

SaaS que resolve um problema específico: **divulgar produtos em grupos do
Facebook em massa**. O usuário conecta uma conta do Facebook (login manual na
janela do Chromium, a senha nunca passa pelo app), cria campanhas com texto,
imagens, destinos e horário, e o servidor publica no horário marcado.

Cobrança por assinatura (InfinitePay), painel administrativo e página pública.

**O produto não é o código. O produto é a publicação funcionando.** Se o
executor quebrar, tudo quebra — inclusive a venda.

---

## 2. Regras inegociáveis

Estas regras existem porque descumpri-las já custou tempo e risco:

1. **Não reescreva a estrutura.** A arquitetura em `src/` já está pronta e
   testada. Não crie módulos novos, não renomeie, não mova arquivos sem um
   motivo concreto e escrito aqui.
2. **Não toque no `src/postador.js`.** É o executor de publicação. Se precisar
   de mudança lá, leia o original no git antes:
   `git show HEAD:postador.js`.
3. **`instances: 1` no PM2. Point final.** A fila e a reserva de cobrança
   idempotente vivem na memória do processo. Duas instâncias = compra liberada
   duas vezes e campanha publicada em paralelo. Escalar exige banco
   compartilhado e bloqueio distribuído — não é ajuste de configuração.
4. **Não versione `data/`.** Contém sessões, e-mails, hashes de senha e os
   perfis do navegador do cliente. Já está no `.gitignore`.
5. **Antes de criar arquivo, verifique se já existe.** Use `grep`/`glob` antes
   de `write`. Duplicar função é como a suíte começa a divergir da realidade.
6. **Toda mudança precisa de verificação.** Se não tem como rodar, diga
   explicitamente que não foi verificado. Não declare pronto o que não testou.
7. **Não delete arquivo sem confirmar que foi movido.** Use `git mv` para
   mover, para o histórico preservar a origem.
8. **Português nos comentários e nos textos de interface.** Sem exceção.
9. **Nada de emoji em código ou arquivo**, salvo pedido explícito.

---

## 3. Arquitetura atual

```
server.js              boot: HTTP, fila, agendamentos, shutdown
ecosystem.config.js    PM2 (instances:1, kill_timeout, DISPLAY)
src/
  app.js               middlewares, rotas, criação do Express
  http.js              cookies, cabeçalhos de segurança, CSP
  config.js            .env, planos, limites, validação de boot
  db.js                NeDB, índices, compactação, backup
  log.js               log JSON estruturado (info/warn/error/debug)
  auth.js              sessões, hash de senha, tokens de redefinição
  security.js          CSRF, verificação de origem, rate limit, sanitização
  email.js             SMTP: recuperação de senha e confirmação de pagamento
  cron-agenda.js       intervalo em minutos -> expressão cron válida
  navegador.js         abertura do Chromium (Chrome do puppeteer ou CHROME_PATH)
  queue.js             agrupamento, concorrência por conta, retentativas
  facebook.js          perfis isolados, ciclo de vida, janela de login
  postador.js          EXECUTOR: digita, rola, publica no grupo
  billing.js           checkout, webhook, idempotência
  accounts.js          contas Facebook conectadas
  admin.js             painel administrativo
  routes/
    auth.js            cadastro, login, sessão, recuperação, redefinição
    campaigns.js       campanhas, posts, histórico
    accounts.js        conectar/desconectar Facebook
    billing.js         checkout e status de pagamento
    uploads.js         imagens
    helpers.js         utilitários de rota
    admin.js           rotas administrativas
public/                index.html, termos.html, privacidade.html, assets/
data/                  bancos, perfis, uploads, backups (NÃO versionar)
tests/smoke.test.js    69 verificações
scripts/               check-syntax.js, check-modulos.js, preflight.js,
                       backup.js, testar-navegador.js, testar-backup.js
```

### Fluxo de uma publicação (não quebrar)

```
cron/agendamento → queue.js agrupa por conta → postador.js abrir perfil
→ publica em cada destino → resultado volta → ok ou retentativa
```

- `postador.js` abre o navegador com o perfil isolado da conta
  (`config.PROFILES_DIR` + `profileDir` do post).
- Publicações da **mesma conta** vão no mesmo navegador, em sequência, com
  espera aleatória entre elas. Só a primeira verifica login.
- `queue.js` garante uma execução por conta por vez e retoma o que ficou
  pendente quando o servidor reinicia.

---

## 4. Segurança — o que já está feito

| Proteção | Onde |
|---|---|
| Senha com hash + salt | `auth.js` |
| Cookie de sessão `httpOnly` + `SameSite` + `Secure` em HTTPS | `http.js`, `config.js` |
| CSRF: token em cookie + header obrigatório em escrita | `security.js` |
| Verificação de `Origin`/`Referer` | `security.js` |
| Rate limit por IP nas rotas de auth | `security.js` |
| Só `public/` é servido; `.env`, `data/`, `*.db` e fonte retornam 404 | `app.js` |
| Upload: tipo, tamanho, nome e dono validados | `routes/uploads.js` |
| Sanitização de entrada | `security.js` |
| CSP: `script-src 'self'` (estrito), `object-src 'none'`, `frame-ancestors 'none'` | `http.js` |
| Isolamento entre usuários em toda leitura de dado | `routes/*` |
| Link de redefinição nunca exposto em produção | `config.js` |
| Admin só para `ADMIN_EMAILS` | `config.js`, `routes/admin.js` |
| App não sobe com SMTP ausente em produção | `config.js` |

### Pagamento idempotente

`billing.js` reivindica o registro com escrita condicional
(`aplicadoEm: { $exists: false }`). Dois webhooks simultâneos não concedem a
mesma compra duas vezes. Renovação acumula sobre a data atual.

> Isso só é seguro com **um processo** (regra 3).

---

## 5. Verificação

```bash
npm run lint   # sintaxe de todos os .js + chamadas entre módulos
npm test       # 69 verificações: auth, isolamento, CSRF, fila, cobrança, admin
```

O estado atual é **69/69 passando** e lint limpo. Não aceito regressão.

A suíte sobe o app no próprio processo, com `DATA_DIR` temporário, e **não
publica de verdade** (não há Chrome no ambiente de teste). A publicação real
é a Etapa 5, com o produto no ar.

Verificações além da suíte:

```bash
npm run preflight           # o que impede a subida em produção
npm run verificar:navegador # Chrome sobe, navega e digita
npm run verificar:backup    # cria backup, apaga o banco, restaura e confere
npm run backup -- listar    # backups disponíveis na VPS
```

`preflight` sai com código 1 se algo impedir a publicação (navegador
ausente, disco cheio, pasta sem escrita, display virtual parado, SMTP
faltando em produção). Ele é exatamente o filtro que faltava entre "rodei o
deploy" e "descobri no meio da campanha que nada funciona".

---

## 6. Correções já feitas (não é preciso reverificar)

**Núcleo**
- Reescrita do `server.js` monolith (1.534 → 109 linhas) em `src/`, com
  módulos por responsabilidade e rotas separadas.
- Removidos da raiz: `index.html` (29 KB, interface antiga), `facebook.js` e
  `postador.js`. O executor foi para `src/postador.js` e o login para
  `src/facebook.js`.

**Bugs corrigidos**
- `postador.js` usava `grupo` antes da declaração — a fila nunca publicava
  nada e o erro era engolido. Corrigido em `queue.js`.
- `log.error` não existia (só `log.erro`): 13 chamadas lançavam `TypeError` e
  mascaravam o erro real. Adicionado alias `error` em `log.js`.
- `security.js`: função `assegurarCsrf` estava com nome diferente do que os
  chamadores usavam. `Origin`ava uma variável inexistente. Ambos corrigidos.
- Recuperação de senha: o backend gerava `?token=` e o frontend lia
  `?token` (sem valor). Corrigido.
- `linkDev` vazava o link de redefinição. Agora só funciona fora de
  produção **e** só com `EXPOSIR_LINK_REDEFINICAO=1`.
- Idempotência de pagamento: o NeDB retornava contagem numérica e a reserva
  falhava silenciosamente. Corrigido para tratar os dois formatos.
- Checkout validava o plano **depois** de reclamar a configuração da
  InfinitePay. Invertido: entrada inválida devolve 400 mesmo sem handle.
- Exposição de arquivos: `.env`, `data/`, `*.db` e fonte eram servidos. Agora
  404.
- Token de CSRF: dois cookies com o mesmo nome faziam o servidor ler o
  valor errado.

**Infraestrutura**
- `*/360 * * * *` no cron do backup: **inválido** — o campo de minutos vai de
  0 a 59, então o backup nunca rodava em produção. Criado `src/cron-agenda.js`
  para distribuir o intervalo entre hora e minuto (`0 */6 * * *`), com
  validação no boot e testes.
- CSP: havia 23 atributos `style=` inline que seriam bloqueados. Liberado
  `style-src 'unsafe-inline'` (estilo não executa JS). `script-src` continua
  estrito.
- `ecosystem.config.js`: `kill_timeout: 60000` (o PM2 matava o processo no
  meio de uma publicação), `restart_delay`, logs.
- `update.sh` e `deploy-vps.sh` reescritos: backup antes do `git pull`,
  validação de configuração antes de reiniciar, `startOrReload` para reler o
  ecosystem, `mkdir` de `data/backups` e `logs/`.
- `.env.example` reescrito (estava com texto corrompido) com todas as
  variáveis que `config.js` realmente lê, comentadas.
- `.gitignore`: `data/` inteiro, logs e `uploads/`.
- `README.md` reescrito com a estrutura real.

**Testes**
- Suíte de fumaça em processo próprio: 69 verificações cobrindo auth,
  isolamento multi-tenant, limites de plano, CSRF, origem, exposição de
  arquivos, upload, fila, cobrança, admin, agendamentos e rate limit.

---

## 7. Estado do git

- Commit `e251cfd` em `main`, enviado para `origin/main`.
- `.env` e `data/` **não** são versionados (`.gitignore`).
- `.gitattributes` força LF em tudo. Sem ele os scripts bash iam para a VPS
  com CRLF e o servidor falharia com `bad interpreter: /bin/bash^M`.
- Ao commitar, confira sempre com `git status --porcelain` que nenhum `.env`,
  `data/` ou `*.db` entrou na lista.

---

## 8. Plano por etapas

O objetivo é **publicar o produto online** e vendê-lo. O teste de publicação
real no Facebook é o **último** passo, com o produto no ar e usuário de
verdade — não é tarefa de agora. Não travou a etapa atual.

### Etapa 1 — Publicação online (atual)
- [x] Código modular, segurança fechada, 69/69 testes
- [x] `deploy-vps.sh` e `update.sh` prontos
- [x] `ecosystem.config.js` com `instances: 1` e `kill_timeout`
- [x] Navegador com `CHROME_PATH` configurável
- [x] `scripts/preflight.js`: confere navegador, disco, permissões, display
      virtual e configuração antes de subir
- [x] `scripts/backup.js`: criar, listar e **restaurar** backup pela linha de
      comando (antes não havia como restaurar)
- [x] Retenção de backup configurável (`BACKUPS_MAXIMOS`, padrão 30)
- [x] `preflight` ligado ao `deploy-vps.sh` e ao `update.sh`
- [ ] Subir na VPS, domínio, HTTPS e túnel
- [ ] Smoke test da instância no ar

### Etapa 2 — Pagamento real
- [ ] InfinitePay: conta ationada e `INFINITEPAY_HANDLE` preenchido
- [ ] Compra de teste real de ponta a ponta (checkout → webhook → acesso)
- [ ] Conferir que o acesso libera no prazo esperado
- [ ] Conferir estorno/cancelamento (o que acontece com quem cancela)

### Etapa 3 — Jurídico
- [ ] `public/termos.html` e `public/privacidade.html` revisados por advogado
- [ ] Declarar no texto: quais dados são guardados, por quanto tempo e por quê
- [ ] Informar os terceiros: Meta (Facebook), InfinitePay, servidor de e-mail
- [ ] Base legal para o tratamento de dados e canal do titular
- [ ] Conferir as regras da Meta para publicação em grupos

### Etapa 4 — Operação
- [ ] Backup fora da máquina (o atual grava em `data/backups`, no mesmo disco)
- [ ] Alerta se o serviço cair
- [ ] Conferir uso de RAM: cada navegador é um Chromium headful

### Etapa 5 — Teste final de aceitação (com produto no ar)
Rodar **depois** das etapas acima, com o produto publicado e um usuário real.
Este é o teste que vale a venda.

- [ ] Conta de teste do Facebook em grupo de teste real
- [ ] Conectar conta → criar campanha → publicar em 1 grupo de verdade
- [ ] Conferir se o post apareceu, com texto e imagem corretos
- [ ] Conferir se os 4 seletores batem com o DOM real do Facebook:
  - `div[role="button"]::-p-text(Escreva algo...)`
  - `div[role="textbox"]`
  - `div[aria-label="Foto/vídeo"]` (com acento)
  - `div[aria-label="Publicar"]`
- [ ] Agendamento: deixar uma campanha para daqui a 10 minutos e confirmar
- [ ] Compra real e confirmação de que o acesso foi liberado
- [ ] Erro de seletores aparece como "O editor de publicação não apareceu neste
      destino", que é genérico demais: guardar print da tela

> Já validado: o navegador sobe, navega e digita
> (`node scripts/testar-navegador.js` — Chrome 153). O executor chegou a abrir
> o editor e digitar o texto numa cópia local do compositor. Falta só o DOM
> real do Facebook.

### Sobre o navegador

O download do Chromium do puppeteer falhou nesta máquina (a pasta
`win64-148.0.7778.97` ficou vazia). Por isso existe `CHROME_PATH`: aponte para
um Chrome já instalado e o app usa ele.

```bash
# Windows
CHROME_PATH=C:\Program Files\Google\Chrome\Application\chrome.exe
# Linux
CHROME_PATH=/usr/bin/google-chrome
```

`config.js` recusa o boot se o caminho não existir, em vez de falhar no meio
de uma publicação. Depois de uma tentativa de download interrompida, apague a
pasta antes de tentar de novo:

```bash
rm -rf ~/.cache/puppeteer/chrome/win64-148.0.7778.97
npx puppeteer browsers install chrome
```

---

## 9. Decisões tomadas (não desfazer sem motivo novo)

- **Arquitetura centralizada em um processo.** Decisão consciente, não
  descuido. Documentada na regra 3.
- **Chromium headful, não headless.** Headless é detectado pelo Facebook.
  Exige Xvfb no servidor — já automatizado no `deploy-vps.sh`.
- **Login manual na janela, sem senha.** A senha do Facebook nunca entra no
  app. É requisito de privacidade e de segurança.
- **NeDB.** Banco em arquivo. Simples, sem servidor extra. Limite: escala por
  usuário, não por empresa. Não é hora de trocar.
- **Estilo inline liberado na CSP.** A interface ajusta barras de progresso
  por atributo `style`. Scripts continuam estritos, que é o que importa para
  XSS.
- **Executor abre o navegador por grupo de postagens.** É o comportamento
  original, preservado de propósito. `facebook.js` cuida só da janela de
  login e do ciclo de vida dos perfis.

---

## 10. Como seguir no próximo dia

1. Leia este arquivo.
2. `npm run lint && npm test` — confirme 69/69 antes de mudar qualquer coisa.
3. Faça **uma** coisa da seção 8.
4. Atualize a seção 6 com o que mudou.
5. `npm run lint && npm test` de novo.

Se algo aqui estiver desatualizado, corrija o arquivo. Este documento vale
mais que a memória de qualquer sessão.
