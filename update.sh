#!/usr/bin/env bash
# Atualiza o Postador Pro a partir do Git e reinicia (na VPS).
# Uso (na VPS): bash update.sh
#
# Fluxo: você edita -> git push -> na VPS: bash update.sh
#
# O backup roda ANTES do pull: se a versão nova quebrar na validação de
# configuração, ainda existe uma cópia para voltar atrás.

set -euo pipefail

REPO_DIR="$HOME/postador-pro"
cd "$REPO_DIR"

echo "==> [1/5] Backup antes de mexer"
node scripts/backup.js criar

echo "==> [2/5] Baixando a versão nova"
git pull --ff-only

echo "==> [3/5] Dependências"
if [ -f package-lock.json ]; then
  npm ci --omit=dev
else
  npm install --omit=dev
fi

echo "==> [4/5] Conferindo a configuração"
# Não sobe o servidor: o preflight e a validação abortam em caso de
# configuração inválida (SMTP ausente, URL sem HTTPS).
node scripts/preflight.js
node -e "
const { problemas } = require('./src/config').validarConfig();
if (problemas.length) { for (const p of problemas) console.error('problema:', p); process.exit(1); }
"

echo "==> [5/5] Reiniciando"
# update --force é o que faz o PM2 reler o ecosystem.config.js (kill_timeout,
# logs, etc). Um restart puro manteria a configuração antiga em memória.
pm2 startOrReload ecosystem.config.js --update-env
pm2 save
pm2 logs postador-pro --lines 20 --nostream

echo ""
echo "Atualizado. Se algo estiver errado, os backups estão em data/backups."
