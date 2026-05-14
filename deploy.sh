#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$ROOT_DIR"

INIT_ENV=0
FORCE=0
NO_BUILD=0

for arg in "$@"; do
  case "$arg" in
    --init)
      INIT_ENV=1
      ;;
    --force)
      FORCE=1
      ;;
    --no-build)
      NO_BUILD=1
      ;;
    -h|--help)
      cat <<USAGE
用法: bash deploy.sh [--init] [--force] [--no-build]

  --init      若 .env 不存在，交互创建并继续部署
  --force     .env 已存在时，允许重新生成 .env
  --no-build  跳过 docker compose build，直接 up -d
USAGE
      exit 0
      ;;
    *)
      echo "[deploy] 未知参数: $arg"
      echo "[deploy] 使用 --help 查看说明"
      exit 1
      ;;
  esac
done

if ! command -v docker >/dev/null 2>&1; then
  echo "[deploy] Docker 未安装，请先安装 Docker 与 Docker Compose。"
  exit 1
fi

if ! docker compose version >/dev/null 2>&1; then
  echo "[deploy] 未检测到 docker compose 插件，请先安装后重试。"
  exit 1
fi

create_env() {
  if [[ -f .env && "$FORCE" -ne 1 ]]; then
    echo "[deploy] .env 已存在，若需覆盖请加 --force"
    return 0
  fi

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

if [[ "$INIT_ENV" -eq 1 ]]; then
  create_env
fi

if [ ! -f .env ]; then
  if [ -f .env.example ]; then
    cp .env.example .env
    echo "[deploy] 已生成 .env 模板，请先编辑后再执行部署。"
    echo "[deploy] 或执行: bash deploy.sh --init"
  else
    echo "[deploy] 未找到 .env，请手动创建后重试。"
    echo "[deploy] 或执行: bash deploy.sh --init"
  fi
  exit 1
fi

mkdir -p data

echo "[deploy] 正在停止旧容器..."
docker compose down || true

if [[ "$NO_BUILD" -eq 0 ]]; then
  echo "[deploy] 正在构建镜像..."
  docker compose build --pull
else
  echo "[deploy] 已跳过镜像构建（--no-build）。"
fi

echo "[deploy] 正在启动容器..."
docker compose up -d

echo "[deploy] 部署完成。"
docker compose ps
