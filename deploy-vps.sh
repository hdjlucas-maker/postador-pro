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

echo "==> [1/7] Atualizando o sistema"
sudo apt-get update -y
sudo apt-get install -y curl git build-essential ca-certificates gnupg lsb-release

echo "==> [2/7] Node.js 20 + npm"
if ! command -v node >/dev/null 2>&1; then
  curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
  sudo apt-get install -y nodejs
fi
echo "node: $(node -v) | npm: $(npm -v)"

echo "==> [3/7] Dependências do Chromium (puppeteer) + Xvfb (display virtual)"
# Sem estas bibliotecas o Chromium abre e morre na hora, e a fila de publicação
# fica repetindo a mesma falha indefinidamente.
sudo apt-get install -y \
  xvfb \
  libnss3 libnspr4 libatk1.0-0 libatk-bridge2.0-0 libcups2 libdrm2 \
  libxkbcommon0 libatspi2.0-0 libxcomposite1 libxdamage1 libxfixes3 \
  libxrandr2 libgbm1 libpango-1.0-0 libcairo2 libasound2 fonts-liberation \
  libu2f-udev xdg-utils

echo "==> [4/7] PM2 + cloudflared"
sudo npm install -g pm2
if ! command -v cloudflared >/dev/null 2>&1; then
  curl -fsSL https://pkg.cloudflare.com/cloudflare-main.gpg | sudo gpg --dearmor -o /usr/share/keyrings/cloudflare-warp-archive-keyring.gpg
  echo "deb [signed-by=/usr/share/keyrings/cloudflare-warp-archive-keyring.gpg] https://pkg.cloudflare.com/cloudflared $(lsb_release -cs) main" | sudo tee /etc/apt/sources.list.d/cloudflared.list
  sudo apt-get update -y
  sudo apt-get install -y cloudflared
fi

echo "==> [5/7] Xvfb como serviço (display :99)"
sudo tee /etc/systemd/system/xvfb.service >/dev/null <<'EOF'
[Unit]
Description=Xvfb Virtual Display :99
After=network.target

[Service]
ExecStart=/usr/bin/Xvfb :99 -screen 0 1366x768x24 -ac
Restart=always
RestartSec=2

[Install]
WantedBy=multi-user.target
EOF
sudo systemctl daemon-reload
sudo systemctl enable --now xvfb

echo "==> [6/7] Instalando o app"
cd "$REPO_DIR"
if [ -f package-lock.json ]; then
  npm ci --omit=dev
else
  npm install --omit=dev
fi

# O Chromium do puppeteer fica fora do node_modules e precisa ser baixado.
npx puppeteer browsers install chrome

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

echo "==> [7/7] Subindo com PM2"
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
