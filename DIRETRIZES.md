ESSAS SÃO INFORMAÇÕES ATUAIS E QUERO QUE A IA LEIA COM ATENÇÃO

# Prompt para concluir o Postador Pro

Você é um engenheiro sênior especializado em extensões Chrome Manifest V3, automação segura de interfaces React, filas de tarefas, UX e confiabilidade.

Preciso concluir profissionalmente uma extensão chamada **Postador Pro**, que publica campanhas autorizadas em grupos do Facebook. O projeto já foi parcialmente construído, mas precisa de auditoria técnica e de uma implementação confiável, sem travamentos, publicações em locais errados ou erros silenciosos.

## Objetivo principal

Concluir uma ferramenta profissional para criação e execução de campanhas em grupos do Facebook, com:

1. publicação somente como **nova postagem no grupo**;
2. nunca comentar em publicações de outras pessoas;
3. nunca responder comentários;
4. nunca curtir, reagir ou interagir artificialmente;
5. fila estável e sem execuções duplicadas;
6. delay configurável e aleatório;
7. limite diário seguro;
8. variações de conteúdo com Spintax;
9. status de execução claro;
10. erros visíveis e diagnosticáveis;
11. operação em segundo plano, sem bloquear o desktop;
12. comportamento previsível e fácil de usar.

A prioridade é **confiabilidade e segurança**, não quantidade de recursos.

## Problema crítico: nova postagem, nunca comentário

A ferramenta recebe uma URL de grupo, por exemplo:

```text
https://www.facebook.com/groups/123456789
```

Ela deve:

1. validar que a URL é realmente de um grupo;
2. abrir o grupo;
3. localizar o botão ou área de **nova publicação**;
4. abrir o compositor de nova postagem;
5. localizar o editor dentro desse compositor;
6. inserir o texto;
7. anexar imagem, se houver;
8. publicar somente dentro do compositor de nova postagem.

Se não for possível confirmar o compositor correto, não publique nada e mostre:

```text
Não foi possível confirmar o compositor de nova postagem. Nenhum comentário foi enviado.
```

Nunca usar como fallback um seletor global como:

```javascript
document.querySelector('[contenteditable="true"]')
```

Campos dentro de `<article>` devem ser rejeitados, exceto quando estiverem dentro de um diálogo comprovadamente aberto para nova postagem. Os elementos de texto, imagem e publicação devem estar dentro de um contêiner seguro, como `[role="dialog"]`.

## Segurança e ética

Não implementar:

- bypass de CAPTCHA;
- falsificação de navegador;
- evasão de bloqueios ou detecção;
- alteração de fingerprint;
- curtidas, comentários ou reações automáticas;
- spam agressivo;
- publicação sem permissão.

É aceitável utilizar uma aba inativa ou janela em segundo plano para não interromper o usuário, mas o Facebook ainda precisa estar carregado e conectado em algum contexto do navegador.

A ferramenta deve publicar apenas onde o usuário tem permissão, respeitar as regras de cada grupo e parar se o Facebook exibir qualquer aviso.

## Delay dinâmico obrigatório

O delay não pode ser fixo. A interface deve permitir configurar:

```text
mínimo em segundos
máximo em segundos
```

Configuração padrão:

```text
mínimo: 600 segundos
máximo: 1200 segundos
```

Isso representa um intervalo aleatório entre 10 e 20 minutos:

```javascript
const atraso = Math.floor(Math.random() * (maximo - minimo + 1)) + minimo;
```

Requisitos:

- nunca publicar duas postagens no mesmo minuto;
- nunca ignorar o delay;
- a primeira postagem pode começar imediatamente quando o usuário clicar em “Postar agora”;
- todas as seguintes devem respeitar o intervalo;
- exibir o próximo horário no status;
- impedir duas execuções concorrentes da mesma campanha;
- ao reabrir o navegador, continuar sem duplicar postagens.

## Limites diários

Plano Lite gratuito:

```text
máximo de 5 grupos por dia
```

Plano Pro:

```text
máximo recomendado de 10 grupos por dia
```

O limite deve ser validado no servidor e na extensão. Ao atingir o limite:

```text
Limite diário atingido. A fila foi pausada para proteger sua conta.
```

O contador deve sobreviver ao fechamento do navegador e reiniciar somente na mudança real do dia.

## Spintax e rotação de conteúdo

Aceitar mensagens como:

```text
{Confira essa oportunidade|Olha que oportunidade incrível|Veja isso}
```

A cada postagem, selecionar uma alternativa aleatória. Suportar:

- vários blocos Spintax na mesma mensagem;
- acentos e emojis;
- prevenção de repetição imediata quando houver alternativas;
- registro do texto efetivamente usado;
- aviso amigável para chaves malformadas;
- texto fixo sem fingir que possui variações.

Não alterar o sentido da mensagem de forma enganosa.

## Avisos do Facebook

Antes e depois de publicar, verificar sinais de conta suspensa, bloqueio temporário, limitação de frequência, atividade restrita ou aviso de spam.

Ao detectar aviso:

1. não publicar;
2. pausar toda a fila;
3. salvar o motivo;
4. mostrar:

```text
O Facebook exibiu um aviso. A fila foi pausada para proteger sua conta.
```

5. não tentar contornar o aviso automaticamente.

## Status de execução

Criar um painel dentro da extensão com estados como:

```text
Parado
Preparando
Abrindo grupo
Compositor encontrado
Inserindo mensagem
Anexando imagem
Publicando
Aguardando intervalo
Concluída
Pausada por aviso
Erro
```

O painel deve exibir campanha, grupo atual, quantidade concluída, quantidade restante, último resultado, próximo horário e erro detalhado.

O usuário deve acompanhar somente o status da ferramenta. A tela principal não pode ser tomada, redirecionada ou travada.

## Tratamento de erros

Nenhum erro pode ser engolido silenciosamente. Salvar e exibir o erro, o grupo afetado e se a fila foi pausada.

Exemplos:

```text
Não foi possível abrir o grupo.
```

```text
O Facebook não exibiu o compositor de nova postagem. Nenhum comentário foi enviado.
```

```text
O botão Publicar não foi confirmado. A fila foi interrompida por segurança.
```

Não mostrar apenas “Erro desconhecido” quando houver uma causa identificável.

## Campanhas

Cada campanha deve permitir:

- criar;
- editar;
- excluir;
- reutilizar;
- publicar agora;
- agendar;
- pausar;
- retomar somente após confirmação do usuário;
- visualizar status, publicados e falhas.

Reutilizar uma campanha deve criar um novo identificador, preservando grupos, imagem, texto/Spintax e delay, sem misturar históricos.

## Proteção contra duplicação

Impedir:

- duas execuções simultâneas;
- postagem duplicada no mesmo grupo;
- clique duplo em “Postar agora”;
- reprocessamento após timeout sem verificar o estado;
- sobrescrita de contadores com estado antigo.

## Testes obrigatórios

Criar testes para:

### Spintax

- uma alternativa;
- várias alternativas;
- múltiplos blocos;
- emojis e acentos;
- chaves incompletas;
- prevenção de repetição imediata.

### Delay

- mínimo e máximo;
- sorteio aleatório;
- próximo horário;
- fechamento e reabertura do navegador;
- clique duplo em “Postar agora”.

### Segurança do DOM

Simular HTML com campo de comentário dentro de `<article>`, compositor dentro de `[role="dialog"]`, vários botões “Publicar” e vários `contenteditable`. O código deve selecionar somente o compositor correto.

### Limites e erros

Testar 5 grupos no Lite, tentativa do sexto, 10 grupos no Pro, mudança de dia, grupo inválido, usuário desconectado, compositor ausente, botão desabilitado, aviso do Facebook e aba fechada.

## Critérios de aceitação

A implementação somente está concluída quando:

- uma URL de grupo gera somente uma nova postagem;
- nenhum comentário é criado;
- nenhum post de outra pessoa é alterado;
- o delay aleatório de 600 a 1200 segundos é respeitado;
- o Spintax gera variações válidas;
- o Lite bloqueia no quinto grupo;
- a fila pausa diante de aviso;
- o usuário vê somente o status da extensão;
- o desktop não é tomado pela automação;
- erros aparecem no painel;
- não existem erros silenciosos;
- os testes passam;
- o fluxo é validado primeiro com um único grupo;
- a documentação de instalação está atualizada.

## Ordem de trabalho

1. auditar o código atual;
2. listar problemas encontrados;
3. corrigir o fluxo de uma única postagem;
4. criar testes do DOM;
5. validar que comentários nunca são selecionados;
6. implementar a fila;
7. implementar delay aleatório;
8. implementar Spintax;
9. implementar limites;
10. implementar status;
11. executar testes;
12. gerar nova versão somente após evidência;
13. informar exatamente o que foi testado;
14. declarar limitações quando for necessário testar com uma conta real do Facebook.

Não crie versões apenas para parecer que houve progresso. Cada versão deve corrigir um problema verificável.

---

# ESTADO REAL DO PROJETO (atualizado em 12/10/2026)

> Esta parte substitui a seção antiga. O bloco acima (regras da extensão)
> continua valendo. Se algo aqui estiver errado, corrija o arquivo em vez de
> ignorar. Este documento vale mais que a memória de qualquer sessão.

Repositório: https://github.com/hdjlucas-maker/postador-pro

## 1. O que é o produto

Uma **extensão de navegador (Chrome, Manifest V3)** que o cliente instala na
própria máquina. Com a conta do Facebook **dele** já logada, ele cria campanhas
(texto, imagem, lista de grupos, horário) e a extensão publica. A senha do
Facebook nunca entra no produto.

Não é SaaS, não tem navegador em servidor e não guarda perfil de navegador.

## 2. Como está dividido

**Extensão (`extensao/`)**: toda a publicação. Campanhas, textos, imagens,
histórico, delay, agendamento e contador diário vivem no navegador do cliente.

**API de licença (`worker/`)**: Cloudflare Workers + Hono + D1. Publicada em
`https://postador.hdjlucas.workers.dev`. Faz só quatro coisas: autenticar,
informar se a assinatura está ativa e até quando, receber o webhook da
InfinitePay e servir a landing e o download da extensão. Não publica nada.

**Landing e telas (`public/`)**: servidas pelo binding de assets do Worker:
`index.html` (instalação e planos), `redefinir.html`, `admin.html`,
`termos.html`, `privacidade.html` e `downloads/postador-pro.zip`.

O servidor antigo (Express + NeDB + PM2 em VPS) foi **removido**. Não recriar:
`src/`, `server.js`, `deploy-vps.sh`, `update.sh`, `ecosystem.config.js`.

## 3. Estrutura

```
extensao/                  a extensão (versão no manifest.json)
  manifest.json            Manifest V3, com "key" fixa (ID estável)
  background/              service worker: alarmes, fila, orquestração
  content/facebook.js      DOM do Facebook (injetado via chrome.scripting)
  popup/ options/          interface
  lib/                     armazenamento, campanhas, licença, config
  assets/                  imagem de boas-vindas (webp)
worker/
  src/index.js             app Hono, cabeçalhos, cron, 404 em JSON
  src/routes/              auth, extensao, billing, admin
  src/auth.js billing.js security.js db.js crypto.js email.js config.js log.js
  schema.sql               esquema completo
  migrations/0001_inicial.sql  mesmo esquema (só difere pela linha PRAGMA)
  test/api.test.js         22 testes (vitest + pool do Workers)
  wrangler.jsonc           bindings, cron e variáveis de ambiente
public/                    landing, telas e download do zip
scripts/empacotar-extensao.js  verifica a extensão e gera o zip
tests/                     testes da extensão (Spintax/validação e DOM)
```

## 4. Regras inegociáveis

1. **Não reescreva a estrutura.** Mude só o que a tarefa pedir.
2. **Uma coisa por vez.** Cada mudança termina com os testes passando.
3. **Mexeu em `extensao/`?** Suba o `version` do `manifest.json`, rode
   `npm run empacotar` e commite o `public/downloads/postador-pro.zip`. Sem
   isso o cliente baixa uma versão velha (já aconteceu: o zip publicado estava
   na 1.0.23 com a extensão na 1.0.24).
4. **Não versionar:** `.env`, `data/`, `*.db`, `.wrangler/`, `node_modules/` e
   `info.md` (tem credenciais de administrador). Tudo já está no `.gitignore`.
5. **Toda mudança precisa de verificação.** Se não deu para rodar, diga que não
   foi verificado. Nunca declare pronto o que não testou.
6. **Português** nos comentários e nos textos de interface.
7. **Sem emoji** em código ou arquivo, salvo pedido explícito.
8. **Não apague código antes de o substituto existir e funcionar.**
9. **Segredos só no painel do Cloudflare** (`wrangler secret`), nunca no
   repositório.
10. `host_permissions` da extensão: só Facebook e o host exato da API. Nada de
    `*.workers.dev` nem `<all_urls>`. O `npm run verificar:extensao` barra isso.

## 5. O que está verificado

- `npm test` (raiz): 10 testes da extensão passam (validação de campos, Spintax,
  e seleção do compositor de nova postagem no DOM simulado, rejeitando campo de
  comentário dentro de `<article>`).
- `npm run test:worker`: 23 testes da API passam (precisa de
  `cd worker && npm install` antes).
- `npm run verificar:extensao`: confere manifesto, permissões, `key`, arquivos
  citados, sintaxe de todos os `.js` e referências dos HTML.
- API no ar: `GET /api/config` responde com os planos e limites abaixo.
- Limite diário server-side: `GET /api/extensao/publicacao/hoje` e
  `POST /api/extensao/publicacao` contam e bloqueiam quando o usuário atinge o
  teto do plano (5 trial / 10 Pro).
- Imagem com nome acentuado: o nome é sanitizado (acentos removidos) antes de
  enviar ao Facebook, e o tipo MIME é validado pelos "magic bytes" do arquivo.
- Versão da extensão: 1.0.35; ZIP gerado em `public/downloads/postador-pro.zip`.

## 6. O que NÃO está verificado

- **Publicação real em grupo do Facebook.** Os testes usam DOM simulado. A
  etapa "um grupo de verdade, com print" continua sem evidência registrada.
  O Facebook muda o DOM com frequência; os seletores de
  `content/facebook.js` precisam ser revisados se quebrarem.
- Pagamento real ponta a ponta com a InfinitePay.
- Envio de e-mail de recuperação de senha (veja pendência 2).
- Monitoramento automático de queda da API (veja pendência 6).

## 7. Planos e limites em produção (vêm do `wrangler.jsonc`)

- Mensal R$ 25,00 e anual R$ 249,00.
- Avaliação de **7 dias** (`TRIAL_DAYS`). A landing também diz 7 dias.
- Avaliação: 5 grupos por dia, 3 campanhas ativas, 5 destinos por campanha.
- Pro: 10 grupos por dia, 50 campanhas ativas, 100 destinos por campanha.
- Delay padrão entre postagens: 600 a 1200 segundos, sorteado.

## 8. Pendências conhecidas (nesta ordem de impacto na venda)

1. **Botão "Gerar 3 variações" não funciona.** `options.js` chama
   `POST /api/extensao/gerar-textos`, rota que não existe no worker (responde
   404). Decidir: implementar a rota ou esconder o painel de IA.
2. **Recuperação de senha não envia e-mail.** Sem o binding `EMAIL` (exige
   domínio próprio habilitado no Cloudflare Email Sending), o link só vai para
   o log. Cliente que esquece a senha fica sem caminho de recuperação, salvo
   pelo painel de administração.
3. ~~Limite diário só na extensão.~~ **RESOLVIDO:** o servidor agora conta e
   bloqueia quando o usuário atinge o teto do plano (`POST /api/extensao/
   publicacao`, atômico, respeita o limite). A extensão consulta antes de
   publicar e registra após sucesso.
4. **Duração da avaliação.** O código e a configuração versionada estão em 7
   dias. A configuração só passa a valer na API de produção depois do deploy
   do Worker. Contas já cadastradas mantêm a data `trialFim` gravada; alterar
   `TRIAL_DAYS` afeta novos cadastros e avaliações reiniciadas pelo admin.
5. **Distribuição.** Hoje o cliente instala por "Carregar sem compactação"
   com o Modo do desenvolvedor ligado, e o Chrome mostra aviso a cada abertura.
   Publicar na Chrome Web Store muda isso, mas está sujeito à revisão da loja.
6. **Rate limit geral no edge** (`RL_GERAL` e `RL_WEBHOOK`) está desligado
   porque o Wrangler 4.x recusa o campo. Hoje só vale o limite em D1.
7. **Monitoramento automático.** Não há alerta se a API cair ou se o webhook
   da InfinitePay parar de funcionar. Usar `npx wrangler tail` para logs ou um
   serviço externo que faça `GET /api/health` periodicamente.
8. **Seletores do Facebook.** `content/facebook.js` depende do DOM do
   Facebook, que muda com frequência. Revisar se o compositor, o botão
   "Publicar" e o campo de foto/vídeo ainda batem se a publicação parar de
   funcionar.

## 9. Comandos

```bash
npm test                    # testes da extensão
npm run verificar:extensao  # confere a extensão sem gerar nada
npm run empacotar           # verifica e gera public/downloads/postador-pro.zip
cd worker && npm install    # uma vez
cd worker && npm test       # 22 testes da API
cd worker && npx wrangler deploy
cd worker && npx wrangler d1 migrations apply DB --remote
```

## 10. Como seguir no próximo dia

1. Leia este arquivo inteiro.
2. `npm test` e `npm run verificar:extensao`: confirme antes de mudar algo.
3. Faça **uma** coisa da seção 8.
4. Atualize as seções 5, 6 e 8 com o que mudou.
5. Rode os testes de novo.
