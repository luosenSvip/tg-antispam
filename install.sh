#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$ROOT_DIR"

echo "=== tg-antispam 一键安装 ==="

read -rp "机器人 TOKEN (必填): " BOT_TOKEN
read -rp "你的 Chat ID (必填): " ADMIN_USER_ID
read -rp "授权服务器地址(可选, 直接回车跳过): " AUTH_SERVER_URL
read -rp "授权码(可选, 直接回车跳过): " AUTH_LICENSE_KEY
read -rp "Webhook HTTPS 地址(可选): " WEBHOOK_URL
read -rp "是否自定义 AI 接口? (y/N): " USE_CUSTOM_AI

AI_POOL_1_DEFAULT="https://api.openai.com/v1|sk-xxx|gpt-4o-mini"
AI_POOL_1="$AI_POOL_1_DEFAULT"
if [[ "${USE_CUSTOM_AI,,}" == "y" ]]; then
  read -rp "AI 接口1 (格式: 接口|key|模型|模式，可留空): " AI_INPUT
  if [[ -n "${AI_INPUT:-}" ]]; then AI_POOL_1="$AI_INPUT"; fi
fi

cat > .env <<ENV
BOT_TOKEN=${BOT_TOKEN}
ADMIN_USER_ID=${ADMIN_USER_ID}
AI_POOL_1=${AI_POOL_1}
WEBHOOK_URL=${WEBHOOK_URL}
AUTH_REQUIRED=1
AUTHORIZED_USER_IDS=${ADMIN_USER_ID}
AUTH_SERVER_URL=${AUTH_SERVER_URL}
AUTH_LICENSE_KEY=${AUTH_LICENSE_KEY}
ENV

npm install
npm run build

echo "安装完成，已生成 .env"
echo "启动命令: npm start"
echo "或使用: bash deploy.sh (Docker)"
