# Publicação na Chrome Web Store

Guia do que preencher no painel da Chrome Web Store e o que já está pronto no repositório.
Atualizado em 17/10/2026.

## Situação

- Conta de desenvolvedor criada e taxa de US$ 5 paga (17/10/2026).
- Declaração de comerciante (DSA/UE): **"Negociante — com meus dados"** (escolhida em 17/10/2026).
  Preencher com nome legal, endereço, telefone (com SMS) e e-mail de verdade — tudo aparece
  no rodapé público da ficha. A confirmação pode levar alguns dias e a escolha pode ser
  alterada depois.
- Item criado na loja em 17/10/2026 (rascunho): pacote 1.0.53 enviado com sucesso. **Item ID: `bcgeojfhaipebhjfadchndghefmkmjca`** — diferente do ID da instalação manual (`aaegnkekaabiomfkpmpbhodliomgkdna`); os dois já estão em `EXTENSAO_IDS` no worker, com deploy feito e conferido em produção.
- Pacote de upload pronto: `npm run empacotar:loja` gera `dist/postador-pro-loja.zip`
  (manifest.json na raiz, sem a `key` de desenvolvimento; `dist/` não é versionado).
- Prints 1280x800 prontos em `public/loja/` (gerados com a extensão real e dados de exemplo).

## Passo a passo no painel

1. Concluir a verificação de negociante (SMS + perfil do Google Payments).
2. `npm run empacotar:loja` e subir `dist/postador-pro-loja.zip` em **Add new item**.
3. Preencher a ficha com os textos abaixo (descrição, categoria, idioma, URLs e prints).
4. Preencher a aba de privacidade (propósito único, permissões, código remoto, uso de dados).
5. Publicar para revisão e aguardar (costuma levar de 1 a alguns dias).
6. **Assim que o item existir**: abrir a aba **Package** e copiar o **Item ID** do painel.
   Me passe o ID — se for diferente de `aaegnkekaabiomfkpmpbhodliomgkdna`, eu adiciono em
   `EXTENSAO_IDS` do `worker/wrangler.jsonc` e faço o deploy. Sem isso, a extensão instalada
   pela loja não conversa com a API.

## Textos da ficha

**Nome** (vem do `manifest.json`, não se preenche no painel): `Postador Pro`

**Categoria**: Redes sociais (alternativa aceitável: Produtividade)

**Idioma**: Português (Brasil)

**Descrição** (colar no campo Description):

```
O Postador Pro organiza a divulgação em grupos do Facebook onde você já é membro: você escreve a mensagem, escolhe os grupos e a extensão publica um grupo por vez, com intervalos aleatórios, enquanto você acompanha tudo pelo painel.

Como funciona:
1. Crie a campanha com uma ou mais mensagens (usadas em rodízio entre os grupos).
2. Anexe uma imagem (opcional; PNG, JPEG, WebP ou GIF até 8 MB).
3. Cole os links ou IDs dos grupos de destino, um por linha.
4. Inicie na hora ou agende data e hora.

Recursos:
- Intervalos aleatórios entre os grupos (padrão de 10 a 20 minutos), num ritmo mais parecido com o de uma pessoa do que o de um robô.
- Painel com progresso grupo a grupo: publicados, falhas e restantes, com pausa, retomada e encerramento a qualquer momento.
- "Usar novamente": refaça uma campanha concluída com os mesmos textos e destinos.
- Limites por plano: avaliação com 5 grupos por dia e até 5 destinos por campanha; Pro com 10 grupos por dia e até 100 destinos por campanha.
- Seus dados ficam no seu navegador: campanhas, textos, grupos e histórico não saem do seu computador. O servidor cuida apenas da sua conta, da licença e do contador diário de publicações.

Como começar:
- Crie a conta no próprio app: são 7 dias de avaliação, sem cobrança automática. Para continuar depois, assine o plano mensal (R$ 25,00) ou o anual (R$ 249,00), direto na extensão, com pagamento pela InfinitePay.

Bom saber:
- Basta estar logado no Facebook no navegador em que a extensão está instalada.
- Para o agendamento acontecer, deixe o navegador aberto no horário escolhido.
- A extensão publica somente em grupos em que você é membro; não curte, não comenta e não envia mensagens diretas por você.
- O Postador Pro não é afiliado ao Facebook/Meta. A publicação em cada grupo depende das regras do próprio grupo e da sua participação.

Suporte: botão de WhatsApp e e-mail dentro da extensão.
```

**Descrição curta** (a do `manifest.json`, 132 caracteres, já em uso):
`Divulgue seus produtos em grupos do Facebook com agendamento e ritmo controlado.`

**URLs**:

- Página inicial / site: `https://postador.hdjlucas.workers.dev/`
- Política de privacidade: `https://postador.hdjlucas.workers.dev/privacidade` (o endereço `.html` redireciona para essa URL final)
- Termos de uso (referência): `https://postador.hdjlucas.workers.dev/termos`
- Suporte: `https://postador.hdjlucas.workers.dev/` (e-mail e WhatsApp também estão na extensão)

## Justificativas (aba Privacidade) — textos prontos

Todos os campos aceitam até 1.000 caracteres; os textos abaixo cabem com folga.

**Descrição do único propósito**:

```
O Postador Pro tem um único propósito: publicar, em grupos do Facebook onde o usuário já é membro, as divulgações que ele mesmo escreve, com agendamento e intervalos controlados entre os grupos. O usuário monta a campanha (mensagens, imagem opcional e lista dos grupos), inicia ou agenda, e a extensão abre um grupo por vez, preenche o compositor de publicação do próprio Facebook e publica, respeitando os limites diários do plano. A extensão não curte, não comenta, não envia mensagens diretas nem interage em nome do usuário fora das publicações que ele mesmo criou.
```

**Justificativa de storage**:

```
Guardar no próprio navegador do usuário o que a campanha precisa: mensagens, links dos grupos de destino, imagem da publicação, histórico de resultados por grupo, preferências e o estado local da licença (para mostrar plano e limites). São dados do próprio usuário, usados apenas para o funcionamento do produto — nada é coletado para publicidade ou perfilamento.
```

**Justificativa de alarms**:

```
Disparar as publicações nos horários que o usuário escolher e aguardar o intervalo aleatório entre um grupo e outro (padrão de 10 a 20 minutos) sem manter abas ocupadas ou em execução contínua. Os alarmes só são criados quando o usuário inicia ou agenda uma campanha.
```

**Justificativa de tabs**:

```
Abrir ou localizar a aba do grupo do Facebook escolhido pelo usuário, navegar até o grupo durante a campanha e acompanhar o carregamento da página antes de preencher a publicação. Não é usada para ler, coletar ou alterar conteúdo de outras abas.
```

**Justificativa de scripting**:

```
Injetar o script que preenche o compositor de publicação do Facebook (texto e imagem) e lê o resultado da operação, somente quando uma campanha do usuário está em andamento e apenas na página do grupo que será publicado. O script injetado vem do próprio pacote da extensão; nenhum código remoto é baixado ou executado.
```

**Justificativa de Permissão do host**:

```
O acesso ao facebook.com (www, web e m) é necessário para operar a publicação na página do grupo, apenas durante uma campanha ativa iniciada pelo usuário. O acesso a postador.hdjlucas.workers.dev é necessário para o servidor do produto criar e autenticar a conta, validar a licença do usuário e registrar o contador diário de publicações do plano. Nenhum dos acessos é usado para coletar o histórico de navegação do usuário.
```

**Código remoto**: marcar "Não, não estou usando Código remoto". Se o campo de justificativa for pedido mesmo assim:

```
Não. Todo o JavaScript da extensão está dentro do pacote enviado. A comunicação com o servidor do produto é apenas de dados (conta, licença e contador diário de publicações); nada recebido do servidor é avaliado ou executado como código.
```

**Uso de dados** (marcar estas quatro):

- Informações de identificação pessoal — nome e e-mail, para criar a conta e dar suporte.
- Informações financeiras e de pagamento — histórico dos pagamentos (valor, data, status e identificador da transação), para liberar e renovar o plano. Dados do cartão são processados somente pela InfinitePay e nunca passam pela extensão nem pelo servidor.
- Informações de autenticação — senha usada no login; o servidor guarda apenas o hash, nunca a senha em si.
- Atividade do usuário — contador de publicações por dia, para aplicar o limite do plano.

Não marcar: saúde, comunicações pessoais, local, histórico da Web nem conteúdo do site. A extensão lê a página do grupo apenas para operar a publicação (nada é armazenado ou transmitido), e as mensagens das campanhas ficam no navegador do usuário.

**Declarações**: marcar as três (não vende dados; não usa para fins fora do propósito único; não usa para crédito ou empréstimo).

**URL da Política de Privacidade**: `https://postador.hdjlucas.workers.dev/privacidade` (o endereço `.html` redireciona para essa URL final).

## Prints (1280x800)

Arquivos em `public/loja/`, todos 1280x800. Sugestão de ordem (a loja aceita até 5):

1. `campanhas.png` — progresso da campanha, fila grupo a grupo e lista de campanhas.
2. `campanha.png` — criação da campanha com mensagens, imagem, destinos e pré-visualização.
3. `assinar.png` — assinatura e renovação dentro do app, com os preços reais do servidor.
4. `painel.png` — visão geral do painel com atalhos e status.
5. `popup.png` — popup com o estado da licença.

Extra: `avaliar.png` (janela "Avaliar ferramenta"). **Não usar na ficha enquanto a avaliação de
teste da conta `aservicos17` estiver pública** — o texto "deixe seu comentario para poder resolver
as falhas da ferramenta" não deve aparecer para clientes. Apague ou edite pelo painel admin e
regenere o print (ou use como está para uso interno).

Os prints saem de dados de exemplo (extensão real carregada num Chrome de teste, com as
chamadas de licença bloqueadas — nada é criado ou alterado no servidor). O gerador fica em
`dist/ferramentas/prints-loja.mjs` (roda com `puppeteer-core`; regenerar quando a interface mudar).

## Recursos globais (subseção da ficha)

- Vídeo promocional global: opcional — deixar vazio.
- Prints: arrastar de `public/loja/` (todos 1280x800, PNG 24 bits sem alfa — conferido byte a byte): `campanhas.png`, `campanha.png`, `assinar.png`, `painel.png`, `popup.png`. Não subir `avaliar.png` enquanto a avaliação de teste estiver pública (ver aviso acima).
- Bloco promocional pequeno (440x280): `public/loja/promo-440x280.png`.
- Bloco promocional de letreiro (1400x560): `public/loja/promo-1400x560.png`.
- URL oficial: deixar "Nenhum" (exigiria verificar o domínio no Google Search Console).
- URL da página inicial: `https://postador.hdjlucas.workers.dev/` (já preenchida).
- URL do suporte: `https://postador.hdjlucas.workers.dev/#suporte` (a seção existe na landing).
- Conteúdo adulto: Não.

## Depois de publicado

- [x] Item ID copiado (`bcgeojfhaipebhjfadchndghefmkmjca`, aba Package) e `EXTENSAO_IDS` do worker ajustada + deploy (17/10/2026; o ID manual continua na lista).
- [ ] Decidir se a landing ganha botão "Adicionar ao Chrome" apontando para a loja.
- [ ] Lembrar: cada versão nova na loja exige `version` maior no `manifest.json` e um novo
      `npm run empacotar:loja`; o zip antigo do site continua com a `key` de sempre.
