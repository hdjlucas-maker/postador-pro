#!/usr/bin/env bash
# Deploy do Postador Pro em VPS Ubuntu/Debian.
#
# Uso (na VPS, após clonar o repo):
#   bash deploy-vps.sh <dominio> <email>
#
# Exemplo:
#   bash deploy-vps.sh postador.seudominio.com voce@email.com

set -euo pipefail

DOMINIO="${1:?Informe o domínio público (ex.: postador.seudominio.com)}"
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
sudo apt-get install -y \
  xvfb \
  libnss3 libnspr4 libatk1.0-0 libatk-bridge2.0-0 libcups2 libdrm2 \
  libxkbcommon0 libatspi2.0-0 libxcomposite1 libxdamage1 libxfixes3 \
  libxrandr2 libgbm1 libpango-1.0-0 libcairo2 libasound2 fonts-liberation

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
npm install --omit=dev

# Garante o Chromium baixado pelo puppeteer
npx puppeteer browsers install chrome

if [ ! -f .env ]; then
  cp .env.example .env
fi

sed -i "s|^PUBLIC_BASE_URL=.*|PUBLIC_BASE_URL=https://$DOMINIO|" .env
if ! grep -q '^TRUST_PROXY=' .env; then
  echo "TRUST_PROXY=1" >> .env
fi

echo "==> [7/7] Subindo com PM2"
pm2 delete postador-pro 2>/dev/null || true
pm2 start ecosystem.config.js
pm2 save
pm2 startup systemd -u "$(whoami)" --hp "$HOME" | sed 's/^sudo //' | bash || true

echo ""
echo "App instalado. Ainda precisa:"
echo "  1) No painel Cloudflare: criar o Tunnel e rotear $DOMINIO -> http://localhost:3000"
echo "  2) Na VPS: sudo cloudflared service install <TOKEN_DO_TUNNEL>"
echo "  3) Editar o .env: nano .env -> preencher INFINITEPAY_HANDLE e conferir o resto"
echo "  4) pm2 restart postador-pro"
echo "  5) Testar: curl -I https://$DOMINIO"
echo ""
echo "Logs: pm2 logs postador-pro"