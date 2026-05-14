#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$ROOT_DIR"

echo "=== tg-antispam 更新 ==="

if [ -d .git ]; then
  git pull --ff-only || true
fi

npm install
npm run build

echo "更新完成。请按你的运行方式重启："
echo "- PM2: pm2 restart tg-antispam"
echo "- Docker: docker compose up -d --build"
