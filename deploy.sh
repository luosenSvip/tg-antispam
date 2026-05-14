#!/usr/bin/env bash
set -euo pipefail

if ! command -v docker >/dev/null 2>&1; then
  echo "[deploy] Docker 未安装，请先安装 Docker 与 Docker Compose。"
  exit 1
fi

if [ ! -f .env ]; then
  if [ -f .env.example ]; then
    cp .env.example .env
    echo "[deploy] 已生成 .env，请先编辑 BOT_TOKEN / AI 配置后重试。"
  else
    echo "[deploy] 未找到 .env，请手动创建后重试。"
  fi
  exit 1
fi

mkdir -p data

docker compose down || true
docker compose build --pull
docker compose up -d

echo "[deploy] 部署完成。"
docker compose ps
