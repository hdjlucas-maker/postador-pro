# Publicação na Chrome Web Store

Guia do que preencher no painel da Chrome Web Store e o que já está pronto no repositório.
Atualizado em 17/10/2026.

## Situação

- Conta de desenvolvedor criada e taxa de US$ 5 paga (17/10/2026).
- Declaração de comerciante (DSA/UE): **"Negociante — com meus dados"** (escolhida em 17/10/2026).
  Preencher com nome legal, endereço, telefone (com SMS) e e-mail de verdade — tudo aparece
  no rodapé público da ficha. A confirmação pode levar alguns dias e a escolha pode ser
  alterada depois.
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
- Política de privacidade: `https://postador.hdjlucas.workers.dev/privacidade.html`
- Termos de uso (referência): `https://postador.hdjlucas.workers.dev/termos.html`
- Suporte: `https://postador.hdjlucas.workers.dev/` (e-mail e WhatsApp também estão na extensão)

## Justificativas (aba de privacidade)

**Propósito único**:

```
Publicar, em grupos do Facebook onde o usuário é membro, as divulgações que ele mesmo escreve, com agendamento e intervalos controlados entre os grupos.
```

**Código remoto**: Não. Todo o JavaScript da extensão vem dentro do pacote; o servidor da API
troca apenas dados (conta, licença e contador diário de publicações).

**Permissões** (uma justificativa para cada):

- `storage`: guardar campanhas, textos, imagens, grupos, histórico e preferências no próprio navegador do usuário.
- `alarms`: disparar publicações agendadas e esperar o intervalo aleatório entre um grupo e outro sem manter a aba ocupada.
- `tabs`: abrir ou localizar a aba do grupo do Facebook em que a publicação será inserida e acompanhar o carregamento da página.
- `scripting`: injetar o script que preenche o compositor de publicação somente quando o usuário inicia uma campanha.
- Host `facebook.com` (www, web e m): preencher e publicar no compositor do Facebook, nos grupos abertos pelo próprio app durante uma campanha ativa.
- Host `postador.hdjlucas.workers.dev`: validar a conta e a licença e registrar o contador diário de publicações do plano contratado.

**Uso de dados** (marcar e explicar):

- Informações de identificação pessoal (nome e e-mail): criar a conta, identificar o login e dar suporte.
- Informações de autenticação (senha): usada apenas no login; o servidor guarda só o hash, nunca a senha em si.
- Informações de pagamento e financeiras: histórico dos pagamentos (valor, data, status e identificador da transação) para liberar e renovar o plano. Os dados do cartão são processados somente pela InfinitePay e nunca passam pela extensão nem pelo servidor.
- Atividade do usuário (contador de publicações por dia): aplicar o limite do plano.

Não marcar saúde, comunicações pessoais, localização, histórico da web nem conteúdo de sites:
a extensão lê a página do grupo apenas para operar a publicação (nada disso é coletado ou
transmitido). As mensagens das campanhas ficam no navegador do usuário.

**Perguntas de sim/não**: dados criptografados em trânsito (HTTPS) — sim; vendidos a terceiros —
não; usados para finalidade não relacionada ao propósito único — não; usados para avaliar
crédito ou empréstimo — não.

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

## Depois de publicado

- [ ] Copiar o Item ID (aba Package) e ajustar `EXTENSAO_IDS` no worker + deploy.
- [ ] Decidir se a landing ganha botão "Adicionar ao Chrome" apontando para a loja.
- [ ] Lembrar: cada versão nova na loja exige `version` maior no `manifest.json` e um novo
      `npm run empacotar:loja`; o zip antigo do site continua com a `key` de sempre.
