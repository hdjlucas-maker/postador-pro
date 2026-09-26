#!/usr/bin/env bash
# Deploy do Postador Pro em VPS Ubuntu/Debian.
#
# Uso (na VPS, após clonar o repositório):
#   bash deploy-vps.sh <dominio> <email_admin> <infinitepay_handle>
#
# Exemplo:
#   bash deploy-vps.sh postador.seudominio.com voce@email.com sua_infinite_tag

set -euo pipefail

DOMINIO="${1:?Informe o domínio público (ex.: postador.seudominio.com)}"
EMAIL_ADMIN="${2:?Informe o e-mail que será administrador}"
HANDLE="${3:?Informe sua InfiniteTag (sem o \$)}"

REPO_DIR="$HOME/postador-pro"

echo "==> [1/5] Atualizando o sistema"
sudo apt-get update -y
sudo apt-get install -y curl git build-essential ca-certificates gnupg lsb-release

echo "==> [2/5] Node.js 20 + npm"
if ! command -v node >/dev/null 2>&1; then
  curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
  sudo apt-get install -y nodejs
fi
echo "node: $(node -v) | npm: $(npm -v)"

# A API de licença é um Express com NeDB. Ela não abre navegador e não precisa
# de display virtual, de Chromium nem das bibliotecas gráficas do puppeteer.
# Uma VPS de 1 GB de RAM com isso.
echo "==> [3/5] PM2 + cloudflared"
sudo npm install -g pm2
if ! command -v cloudflared >/dev/null 2>&1; then
  curl -fsSL https://pkg.cloudflare.com/cloudflare-main.gpg | sudo gpg --dearmor -o /usr/share/keyrings/cloudflare-warp-archive-keyring.gpg
  echo "deb [signed-by=/usr/share/keyrings/cloudflare-warp-archive-keyring.gpg] https://pkg.cloudflare.com/cloudflared $(lsb_release -cs) main" | sudo tee /etc/apt/sources.list.d/cloudflared.list
  sudo apt-get update -y
  sudo apt-get install -y cloudflared
fi

echo "==> [4/5] Instalando o app"
cd "$REPO_DIR"
if [ -f package-lock.json ]; then
  npm ci --omit=dev
else
  npm install --omit=dev
fi

mkdir -p data/backups logs

if [ ! -f .env ]; then
  cp .env.example .env
fi

# Ajusta o que depende do domínio e da instalação. O resto (SMTP, planos,
# limites) fica para o operador preencher no passo final.
sed -i "s|^PUBLIC_BASE_URL=.*|PUBLIC_BASE_URL=https://$DOMINIO|" .env
sed -i "s|^ADMIN_EMAILS=.*|ADMIN_EMAILS=$EMAIL_ADMIN|" .env
sed -i "s|^INFINITEPAY_HANDLE=.*|INFINITEPAY_HANDLE=$HANDLE|" .env
sed -i "s|^TRUST_PROXY=.*|TRUST_PROXY=1|" .env

# O app não sobe sem SMTP. Falhar aqui é muito melhor do que descobrir isso com
# cliente esperando.
echo "==> [5/5] Conferindo antes de subir"
# O SMTP ainda não foi preenchido nesta instalação nova, então a checagem
# apontará o que falta. Ela não aborta por SMTP ausente neste ponto: quem
# preencheu o passo anterior recebe a lista do que falta.
node scripts/preflight.js || true

pm2 delete postador-pro 2>/dev/null || true
pm2 start ecosystem.config.js
pm2 save
pm2 startup systemd -u "$(whoami)" --hp "$HOME" | sed 's/^sudo //' | bash || true

cat <<EOF

Instalado. Ainda falta, nesta ordem:

  1) Preencher o SMTP no .env (sem isso o app nem sobe em produção):
       nano $REPO_DIR/.env
     -> SMTP_HOST, SMTP_PORT, SMTP_SECURE, SMTP_USER, SMTP_PASS, SMTP_FROM
  2) Criar o Tunnel no painel da Cloudflare apontando $DOMINIO -> http://localhost:3000
  3) Instalar o túnel na VPS:
       sudo cloudflared service install <TOKEN_DO_TUNNEL>
  4) Reiniciar para pegar o SMTP:
       pm2 restart postador-pro
  5) Conferir:
       pm2 logs postador-pro --lines 50
       curl -I https://$DOMINIO

Na primeira execução, confira no log a linha "agendamentos": é ela que diz
quando o backup vai rodar. Backup só acontece com NODE_ENV=production.
EOF
