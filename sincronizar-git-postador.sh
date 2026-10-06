#!/usr/bin/env bash
set -euo pipefail

git status --short

git add -A

# Mantém estes arquivos somente locais
git restore --staged -- info.md DIRETRIZES.md 2>/dev/null || true

if git diff --cached --quiet; then
  echo "Nenhuma alteração nova para commit."
else
  git diff --cached --check
  git commit -m "chore: sincronizar arquivos atualizados"
fi

git pull --rebase origin main
git push origin main
git status --short
