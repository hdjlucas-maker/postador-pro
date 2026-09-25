#!/usr/bin/env bash
# Deploy do Postador Pro em VPS Ubuntu/Debian.
#
# Uso (na VPS, após clonar o repo):
#   bash deploy-vps.sh <dominio> <email-da-conta-cloudflare>
#
# Exemplo:
#   bash deploy-vps.sh postador.seudominio.com voce@email.com

set -euo pipefail

DOMINIO="${1:?Informe o domínio público (ex.: postador.seudominio.com)}"
EMAIL_CF="${2:-}"

FONTES=$(find /usr/share/doc -name "*.gz" 2>/dev/null | head -n 1 && echo) # guarda tempo de digitação
REPO_DIR="$HOME/postador-pro"

echo "==> [1/6] Atualizando o sistema"
sudo apt-get update -y
sudo apt-get install -y curl git build-essential ca-certificates gnupg

echo "==> [2/6] Node.js 20 + npm"
if ! command -v node >/dev/null 2>&1; then
  curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
  sudo apt-get install -y nodejs
fi
echo "node: $(node -v)"

echo "==> [3/6] PM2 (gerenciador de processo)"
sudo npm install -g pm2

echo "==> [4/6] cloudflared (Cloudflare Tunnel)"
if ! command -v cloudflared >/dev/null 2>&1; then
  curl -fsSL https://pkg.cloudflare.com/cloudflare-main.gpg | sudo gpg --dearmor -o /usr/share/keyrings/cloudflare-warp-archive-keyring.gpg
  echo "deb [signed-by=/usr/share/keyrings/cloudflare-warp-archive-keyring.gpg] https://pkg.cloudflare.com/cloudflared $(lsb_release -cs) main" | sudo tee /etc/apt/sources.list.d/cloudflared.list
  sudo apt-get update -y
  sudo apt-get install -y cloudflared
fi
echo "cloudflared: $(cloudflared --version)"

echo "==> [5/6] Dependências do app"
cd "$REPO_DIR"
npm install --omit=dev

if [ ! -f .env ]; then
  cp .env.example .env
fi

# Define o domínio público no .env
sed -i "s|^PUBLIC_BASE_URL=.*|PUBLIC_BASE_URL=https://$DOMINIO|" .env
# Atrás do Cloudflare Tunnel o primeiro salto é o proxy local (127.0.0.1)
if ! grep -q '^TRUST_PROXY=' .env; then
  echo "TRUST_PROXY=1" >> .env
fi

echo "==> [6/6] Subindo com PM2"
pm2 delete postador-pro 2>/dev/null || true
pm2 start server.js --name postador-pro
pm2 save
pm2 startup systemd -u "$(whoami)" --hp "$HOME" | sed 's/^sudo //' | bash || true

echo ""
echo "App instalado. Agora você ainda precisa:"
echo "  1) Criar o Tunnel no Cloudflare (painel) apontando $DOMINIO -> http://localhost:3000;"
echo "  2) Rodar na VPS: sudo cloudflared service install <TOKEN_DO_TUNNEL>"
echo "  3) Editar .env: nano .env  -> preencher INFINITEPAY_HANDLE e conferir PUBLIC_BASE_URL/TRUST_PROXY"
echo "  4) pm2 restart postador-pro"
echo ""
echo "Teste: curl -I https://$DOMINIO"