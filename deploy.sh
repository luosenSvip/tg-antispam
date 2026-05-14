#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$ROOT_DIR"

INIT_ENV=0
if [[ "${1:-}" == "--init" ]]; then
  INIT_ENV=1
fi

if ! command -v docker >/dev/null 2>&1; then
  echo "[deploy] Docker 未安装，请先安装 Docker 与 Docker Compose。"
  exit 1
fi

create_env() {
  echo "[deploy] 开始初始化 .env"
  read -rp "BOT_TOKEN (必填): " BOT_TOKEN
  if [[ -z "${BOT_TOKEN:-}" ]]; then
    echo "[deploy] BOT_TOKEN 不能为空。"
    exit 1
  fi

  read -rp "ADMIN_USER_ID (选填): " ADMIN_USER_ID
  read -rp "AI_POOL_1 (留空使用默认 OpenAI 配置模板): " AI_POOL_1
  AI_POOL_1="${AI_POOL_1:-https://api.openai.com/v1|sk-xxx|gpt-4o-mini}"

  cat > .env <<ENV
BOT_TOKEN=${BOT_TOKEN}
ADMIN_USER_ID=${ADMIN_USER_ID}
AI_POOL_1=${AI_POOL_1}
AUTH_REQUIRED=0
AUTHORIZED_USER_IDS=${ADMIN_USER_ID}
ENV
  echo "[deploy] .env 初始化完成。"
}

if [ ! -f .env ]; then
  if [ "$INIT_ENV" -eq 1 ]; then
    create_env
  elif [ -f .env.example ]; then
    cp .env.example .env
    echo "[deploy] 已生成 .env 模板，请编辑 BOT_TOKEN / AI 配置后重试。"
    echo "[deploy] 或直接执行: bash deploy.sh --init"
  else
    echo "[deploy] 未找到 .env，请手动创建后重试。"
    echo "[deploy] 或直接执行: bash deploy.sh --init"
  fi
  exit 1
fi

mkdir -p data

docker compose down || true
docker compose build --pull
docker compose up -d

echo "[deploy] 部署完成。"
docker compose ps
