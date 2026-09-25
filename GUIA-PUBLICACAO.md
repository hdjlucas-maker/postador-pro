# Guia de publicação — VPS, domínio e InfinitePay

Passo a passo para colocar o Postador Pro no ar e começar a vender.

Leia do começo. A ordem importa.

---

## 1. Sobre a URL do Cloudflare (leia antes de tudo)

A Cloudflare tem dois produtos diferentes, e essa confusão é comum:

| Produto | O que é | serve para |
|---|---|---|
| **Cloudflare Tunnel** | Conecta a VPS à internet sem abrir porta | Publicar o site. É o que você quer. |
| **Cloudflare Registrar** | Vende domínio | Comprar o seu domínio. |
| **Cloudflare Pages/Workers** | Hospedagem | Não é servidor. Não serve aqui. |

**A Cloudflare não aluga VPS.** Você precisa contratar a VPS em outro lugar
(Hetzner, Contabo, Vultr, Locaweb, Hostinger...). O túnel da Cloudflare é só
o caminho até ela.

### A URL `trycloudflare.com` não serve para vender

Existe um modo de teste, o **Quick Tunnel**, que gera uma URL aleatória tipo
`https://aleatorio-xyz.trycloudflare.com`. Ela serve para testar 5 minutos.

**Não dá para vender nela.** A URL muda toda vez que a tunnel cai ou o
servidor reinicia. Significa: cliente paga, recebe o link, e o link está
morto. Você perderia a venda e a confiança.

Para vender, a URL precisa ser fixa. Isso vem com um **domínio seu**.

### Custo do domínio

Um domínio `.com` ou `.com.br` custa em torno de **R$ 40 a R$ 70 por ano** na
renovação. É o custo de ter endereço fixo para um produto pago. Some isso ao
custo da VPS e é o investimento mínimo para operar.

Onde comprar:
- **Cloudflare Registrar** — vende a preço de custo, sem markup. Exige que o
  domínio já use o DNS da Cloudflare.
- **Namecheap, Hostinger, Locaweb** — vendem o domínio e você configura o DNS
  para apontar para a Cloudflare depois.

Sugestão prática: compre `.com.br` num registrador brasileiro (Hostinger ou
Locaweb,processando rápido), e use a Cloudflare só para DNS + túnel + HTTPS
gratuito.

---

## 2. Qual VPS comprar

O Postador Pro roda o Chrome do Facebook de verdade, com janela aberta
(headful). Isso pesa: **cada publicação simultânea consome cerca de 1 a 1,5 GB
de RAM**.

O app abre até `MAX_NAVEGADORES_CONCORRENTES=2` navegadores ao mesmo tempo.

| RAM | Aguenta | Serve para |
|---|---|---|
| 2 GB | 1 navegador | Só teste. Vai travar com 2 clientes. |
| **4 GB** | 2 navegadores | **Mínimo para começar a vender.** |
| 8 GB | 4-5 navegadores | Cresce com o número de clientes. |

Requisitos mínimos: **Ubuntu 22.04 ou 24.04, 4 GB RAM, 2 vCPU, 40 GB disco.**

Mais disco é melhor: cada perfil do Facebook do cliente ocupa centenas de MB
em `data/facebook-profiles/`.

Provedores que costumam funcionar bem com esse perfil:

- **Hetzner** (mais barato em EUR, datacenter na Europa, boa rede)
- **Contabo** (barato, servidores no Brasil e EUA)
- **Vultr / DigitalOcean** (fácil, mais caro, cobrança por hora)
- **Locaweb / Hostinger** (servidor BR, suporte em português, mais caro)

**Antes de pagar, confira o preço atual no site deles.** Os valores mudam e não
consigo garantir o número daqui.

### Criando a VPS

1. Crie conta no provedor escolhido
2. Escolha: **Ubuntu 24.04 LTS**, **4 GB RAM**, **2 vCPU**, **40 GB SSD**
3. Escolha a região: **São Paulo** se houver, senão **Virginia/EUA** (menor
   latência para o Brasil costuma ser São Paulo)
4. Defina a senha de root
5. Escolha **chave SSH** (mais seguro) ou senha, e **não desligue** a tela de
   resumo — anote o **IP do servidor**

---

## 3. Conectar na VPS

No Windows, abra o PowerShell:

```powershell
ssh root@SEU_IP_DO_SERVIDOR
```

Vai pedir a senha. Digite a que você definiu. Se aparecer algo como
`root@ip:~#`, está dentro.

Para quem usa Windows e quer copiar/colar com segurança, use o **MobaXterm**
ou **Termius** (gratuito).

O terminal exibe o prompt como `root@ip:~#`. Todos os comandos abaixo são
digitados **dentro** da VPS.

---

## 4. Instalar o app

Dentro da VPS, o instalador faz tudo:

```bash
git clone https://github.com/hdjlucas-maker/postador-pro.git ~/postador-pro
cd ~/postador-pro
bash deploy-vps.sh postador.seudominio.com seu@email.com servicoslucas
```

Substitua:
- `postador.seudominio.com` → seu domínio
- `seu@email.com` → o e-mail que será administrador
- `servicoslucas` → sua InfiniteTag, **sem o `$`**

O que o instalador faz: instala Node.js 20, as bibliotecas do Chrome, PM2,
cloudflared, configura o Xvfb como serviço, baixa o Chromium, ajusta o `.env`
e sobe com PM2.

**No final ele avisa que falta o SMTP.** É o passo 6.

---

## 5. Configurar o domínio e o túnel

### 5.1 Apontar o DNS

No painel da Cloudflare → **DNS** → **Adicionar registro**:

| Tipo | Nome | Conteúdo |
|---|---|---|
| A | `@` | IP da sua VPS |
| A | `www` | IP da sua VPS |

O proxy deve estar **laranja** (proxi ligado) para o Cloudflare emitir o HTTPS.

### 5.2 Criar o túnel

Você mencionou já ter algo chamado `$servicoslucas`. Se é um túnel da
Cloudflare, o passo é:

1. Painel Cloudflare → **Zero Trust** → **Networks** → **Tunnels**
2. Se `$servicoslucas` já existe: **Configure** nele
3. Se não existe: **Create a tunnel**, nomeie `servicoslucas`
4. Em **Public Hostname**, adicione:

| Subdomain | Domain | Service |
|---|---|---|
| `postador` | `seudominio.com` | `http://localhost:3000` |

5. Copie o comando de instalação que aparece na tela (é um `sudo cloudflared
   service install eyJhIjoi...`) e rode na VPS

Rode na VPS:
```bash
sudo cloudflared service install COLE_AQUI_O_TOKEN
sudo systemctl restart cloudflared
```

Confirme que a VPS responde pelo domínio:
```bash
curl -I https://postador.seudominio.com
```

Se aparecer `HTTP/2 200` ou `301`, o túnel está funcionando.

---

## 6. SMTP (obrigatório, senão o app não sobe)

Sem SMTP o cliente não consegue recuperar a senha, e o app **recusa a
inicialização** em produção. Isso é proposital.

Precisa de uma conta de envio. Opções:

- **Resend** — ~ US$ 20/mês por 50 mil e-mails, interface simples
- **Amazon SES** — muito barato, mas tem mais configuração
- **Brevo (Sendinblue)** — 300 e-mails/dia grátis
- **Mailgun** — plano grátis limitado

Anote: host, porta, usuário, senha. Depois:

```bash
cd ~/postador-pro
nano .env
```

Preencha:
```
SMTP_HOST=smtp.resend.com
SMTP_PORT=465
SMTP_SECURE=true
SMTP_USER=resend
SMTP_PASS=re_sua_chave
SMTP_FROM=Postador Pro <nao-responda@seudominio.com>
```

Reinicie:
```bash
pm2 restart postador-pro
pm2 logs postador-pro --lines 20
```

---

## 7. InfinitePay

Você já tem a conta válida com a InfiniteTag `$servicoslucas`. No `.env`:

```
INFINITEPAY_HANDLE=servicoslucas
```

**Sem o `$`.** O código tira o símbolo.

O `.env.example` já vem preenchido pelo `deploy-vps.sh` com o valor que você
passou no argumento.

### O que o app faz sozinho

Ao clicar em "Assinar", o servidor chama a InfinitePay e cria o link de
pagamento com dois endereços:

- `redirect_url`: `https://seudominio.com/?pagamento=retorno` (volta o cliente
  para o site)
- `webhook_url`: `https://seudominio.com/api/webhooks/infinitepay` (a
  InfinitePay avisa que o pagamento foi feito)

**O `webhook_url` precisa ser público e HTTPS.** É por isso que o domínio
precisa estar no ar antes de testar cobrança.

### O que falta configurar na InfinitePay

No painel da InfinitePay, confira se a conta está com:

- **Recebimento habilitado** (a conta recém-criada pode precisar de
  verificação/limite)
- **Chave de API** criada, se o painel exigir para criar checkout
- **Seus dados e do produto preenchidos** — a InfinitePay pode segurar o
  saque até a análise de perfil

### Testar a cobrança de verdade (Etapa 2 do plano)

1. Crie uma conta no seu site
2. Clique em "Assinar"
3. Pague com um Pix de valor real baixo (o plano mensal tem o valor que você
   definir em `PLAN_MONTHLY_PRICE`)
4. Confirme que o acesso libera e que o pagamento aparece no painel admin
5. Confira o log: `pm2 logs postador-pro | grep infinitepay`

Se o pagamento rodar mas o acesso não liberar, o problema **não** é do
pagamento: é do webhook. Aí olhe o log e me mande.

---

## 8. Conferir se está tudo no ar

```bash
cd ~/postador-pro
node scripts/preflight.js
```

Resposta esperada: `Pode subir.` Se houver erro, ele diz o que é.

Depois, do seu computador (não da VPS):

```bash
node scripts/smoke-online.js https://postador.seudominio.com
```

Resposta esperada: `28/28 verificações passaram.`

Só então o link está pronto para o primeiro cliente.

---

## 9. Operação depois de publicado

```bash
pm2 logs postador-pro --lines 50        # ver o que está acontecendo
pm2 restart postador-pro                # reiniciar
pm2 stop postador-pro                   # parar (antes de restaurar backup)

npm run backup -- listar                # backups disponíveis
npm run backup -- criar                 # backup agora
npm run backup -- restaurar backup-2026-09-25T18-00-00-000Z   # restaurar
```

Backup: roda sozinho a cada 6 horas, fica em `~/postador-pro/data/backups`,
mantém as 30 últimas cópias. **Copie para fora da máquina** — se o disco
morrer, o backup vai junto.

Atualizar o código depois:

```bash
cd ~/postador-pro
bash update.sh
```

Faz backup, baixa a versão nova, confere a configuração e reinicia.

---

## 10. Checklist final

- [ ] Domínio comprado
- [ ] DNS apontando para a VPS
- [ ] Túnel configurado, `curl -I` respondendo 200
- [ ] `deploy-vps.sh` executado
- [ ] SMTP preenchido no `.env`
- [ ] `INFINITEPAY_HANDLE=servicoslucas` no `.env`
- [ ] `pm2 logs` sem erro
- [ ] `node scripts/preflight.js` → "Pode subir"
- [ ] `node scripts/smoke-online.js https://...` → 28/28
- [ ] Backup externo configurado
- [ ] Termos e privacidade revisados por advogado
