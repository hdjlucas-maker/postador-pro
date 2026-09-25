#!/usr/bin/env bash
# Atualiza o Postador Pro a partir do GitHub e reinicia (na VPS).
# Uso (na VPS): bash update.sh
# Você edita no VS Code -> git push -> aqui: bash update.sh

set -euo pipefail

cd "$HOME/postador-pro"

echo "==> git pull"
git pull --ff-only

echo "==> dependências"
if [ -f package-lock.json ]; then
  npm ci --omit=dev || npm install --omit=dev
else
  npm install --omit=dev
fi

echo "==> reiniciando o app"
pm2 restart postador-pro
pm2 logs postador-pro --lines 20 --nostream