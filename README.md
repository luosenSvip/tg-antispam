# 🛡️ TG 反垃圾广告机器人

Telegram 群组 AI 反垃圾广告机器人，基于 AI 自动识别并封禁垃圾广告用户。

## 功能

- 🤖 AI 智能识别垃圾广告（支持 OpenAI 兼容 API）
- ⚡ 自动删除广告消息 + 封禁用户
- 📋 白名单管理、管理员自动豁免
- 📊 拦截统计和日志查看
- 🔧 可调节匹配值阈值
- 🚀 支持 Webhook + 队列并发模型（按会话串行，不同会话并行）

## 跨设备安装：哪些文件必须带

### 必须带（最小可运行）
- `src/`
- `package.json`
- `package-lock.json`（推荐，保证依赖版本一致）
- `tsconfig.json`
- `.env`（或在新设备手动新建）

### 可选带（看你是否要保留历史数据）
- `antispam.db`（保留白名单、样本、积分、邀请码等历史）
- `antispam.db-shm`、`antispam.db-wal`（如果迁移时数据库仍在 WAL 活跃状态，建议一起带）

### 不需要带（可删除/不打包）
- `node_modules/`
- `dist/`
- `tsconfig.tsbuildinfo`


## 命令

### 群成员可用

| 命令 | 说明 |
|------|------|
| `/ads` 或 `/antispam` | 打开主菜单 |
| `/jl` | 查询被回复用户最近 10 天发言数（需回复消息） |
| `/jf` | 查询自己的积分账户 |
| `积分` | 快捷查询积分（等效 `/jf`） |
| `/jfph` 或 `/rank` | 查看积分排行榜 |
| `/dh` 或 `/exchange` | 前往私聊兑换邀请券 |
| `/yq` | 查看我的邀请券明细（发送到私聊） |
| `/ads id [@用户名/用户ID]` | 查询用户信息（也可回复消息使用） |
| `/ads dc [@用户名/用户ID]` | 查询用户/群头像所属 DC |
| `/ads kw list` | 查看本群关键词自动回复规则 |
| `/ads kw help` | 查看关键词自动回复帮助 |
| `/cj` | 发起抽奖 |
| `/wd` | 开启“谁是卧底”游戏（`/wd stop` 结束） |
| `/ww` | 开启狼人杀大厅（支持 `/ww start`、`/ww stop`） |
| `/rr` 或 `/roulette` | 俄罗斯轮盘 |
| `/dd` | 离线决斗 |
| `/21` 或 `/bj` | 21 点小程序（房主坐庄，卡片牌面） |

### 管理员命令（`/ads` 子命令）

| 命令 | 说明 |
|------|------|
| `/ads on` / `/ads off` | 开关反垃圾主功能 |
| `/ads status` | 查看当前群防护状态 |
| `/ads ai on|off` | AI 检测开关（目前 `on` 已标记维护中） |
| `/ads test 文本` | 测试检测（可回复含图文消息） |
| `/ads log` | 查看最近拦截记录 |
| `/ads threshold 0.8` | 设置匹配阈值（0~1） |
| `/ads wl add|rm|list` | 白名单管理（add/rm 需回复目标消息） |
| `/ads ban` / `/ads safe` | 学习样本标注（需回复目标消息） |
| `/ads samples` / `/ads samples rm ID` | 查看/删除样本 |
| `/ads jy [UID] [时长]` | 禁言（支持回复消息） |
| `/ads unjy [UID]` | 解除禁言（支持回复消息） |
| `/ads pass [UID]` | 手动放行准入验证用户 |
| `/ads unban UID` | 全局解封用户 |
| `/ads invite ...` | 邀请核销配置：`price/channel/gen/revoke/list/on/off` |
| `/ads import set|add` | 批量导入积分（需回复“用户ID 积分”文本） |
| `/ads points import set|add` | 同上，积分导入别名 |
| `/ads kw add|del|clear` | 关键词自动回复规则管理 |

### 私聊命令

| 命令 | 说明 |
|------|------|
| `/start` | 机器人私聊入口（含深链：兑换/核销/明细） |
| `/groups` | 查看机器人所在监控群组（仅 `ADMIN_USER_ID`） |

> 提示：`/21` 小程序需要可访问的 Web 地址（建议 HTTPS），请正确配置 `WEB_BASE_URL` 或 `WEBHOOK_URL`。

---

## VPS 部署教程

## 一键部署（Docker）

```bash
cp .env.example .env
# 编辑 .env 填入 BOT_TOKEN / AI_POOL_1 / AUTHORIZED_USER_IDS
bash ./deploy.sh
```

部署脚本会自动执行：`docker compose build` + `docker compose up -d`。

## 一键安装（参考版）

```bash
bash <(curl -Ls https://raw.githubusercontent.com/<你的用户名>/<你的仓库>/main/install.sh)
```

安装脚本会交互询问：
- 机器人 TOKEN
- 你的 Chat ID
- 授权服务器地址 / 授权码（可选）
- Webhook HTTPS 地址（可选）
- 是否自定义 AI 接口

安装后会自动生成 `.env`、安装依赖并编译。

## 授权访问（只允许白名单用户）

在 `.env` 中配置：

```bash
AUTH_REQUIRED=1
AUTHORIZED_USER_IDS=12345678,87654321
```

- `AUTH_REQUIRED=1`：开启授权校验。
- 未授权用户在私聊中无法使用机器人；群里发送命令也会被拦截提示。
- 未授权用户的普通群消息不会影响反垃圾被动检测链路。
- 管理员（`ADMIN_USER_ID`）可私聊使用：
  - `/auth list`
  - `/auth add <tgid>`
  - `/auth rm <tgid>`
  - `/update check`（检查是否有新版本）
  - `/update now`（执行 `update.sh` 一键更新）
  > 以上是运行时内存名单，重启后会恢复为 `.env` 里的 `AUTHORIZED_USER_IDS`。
- 若配置 `AUTH_SERVER_URL` + `AUTH_LICENSE_KEY`，机器人启动前会请求授权服务校验，失败则拒绝启动。

### 1. 准备工作

- 一台 VPS（Ubuntu/Debian/CentOS 等）
- 从 [@BotFather](https://t.me/BotFather) 获取 Bot Token
- AI API Key（OpenAI 或其他兼容接口）

### 2. 安装 Node.js

```bash
# Ubuntu/Debian
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs

# 验证
node -v   # v22.x
npm -v
```

### 3. 上传项目到 VPS

**方式一：直接上传**
```bash
# 在本地打包（不含依赖与构建缓存）
cd /Users/serok/Desktop
tar czf tg-antispam.tar.gz \
  --exclude='node_modules' \
  --exclude='dist' \
  --exclude='.DS_Store' \
  --exclude='tsconfig.tsbuildinfo' \
  --exclude='*.db-shm' \
  --exclude='*.db-wal' \
  tg-antispam/

# 上传到 VPS
scp tg-antispam.tar.gz user@your-vps-ip:~/
```

**方式二：用 Git（推荐）**
```bash
# 本地初始化并推送到 GitHub/Gitea 等
cd tg-antispam
git init && git add . && git commit -m "init"
git remote add origin https://github.com/you/tg-antispam.git
git push -u origin main

# VPS 上克隆
ssh user@your-vps-ip
git clone https://github.com/you/tg-antispam.git
```

### 4. 在 VPS 上安装运行

```bash
# 进入项目目录
cd ~/tg-antispam

# 解压（如果是方式一）
# tar xzf tg-antispam.tar.gz && cd tg-antispam

# 安装依赖
npm install

# 编译 TypeScript
npm run build

# 创建配置文件（项目默认没有 .env.example）
nano .env   # 填入你的 BOT_TOKEN 和 AI 配置
```

`.env` 内容示例（推荐：池化格式）：

```bash
# 必填
BOT_TOKEN=1234567890:AAxxxxxxxxxxxxxxxxxxxxxxxxxxxx

# 可选：私聊 /groups 管理员
ADMIN_USER_ID=123456789

# 至少配置一个 AI_POOL_1（可继续加 AI_POOL_2...AI_POOL_20）
# 格式:
# AI_POOL_n=BASE_URL|KEY1[,KEY2...]|MODEL1[,MODEL2...][|API_STYLE]
# API_STYLE 可选: auto / chat / responses
AI_POOL_1=https://api.openai.com/v1|sk-xxx,sk-yyy|gpt-5.4-mini,gpt-4o-mini
AI_POOL_2=https://example.com/v1|sk-zzz|grok-4.1-thinking|chat

# 可选：全局 API 风格（默认 auto）
AI_API_STYLE=auto

# 可选：命令追踪日志（1 开启）
DEBUG_COMMAND_TRACE=0

# ========== 运行模式（可选） ==========
# 留空 = 长轮询（Polling，默认）
# 填写 = Webhook 模式（推荐生产环境）
WEBHOOK_URL=https://your-domain.com/api/telegram/webhook/your-secret-path

# 可选：Webhook 请求头密钥（建议开启）
# 会校验 Telegram 的 x-telegram-bot-api-secret-token
WEBHOOK_SECRET=replace-with-a-long-random-string

# 可选：Webhook 入站 worker 并发数（默认 8）
WEBHOOK_WORKERS=8

# 可选：Webhook 入站队列长度上限（默认 10000）
WEBHOOK_QUEUE_MAX=10000

# 可选：全项目会话串行队列保护阈值
# 同一个会话（群/私聊）的最大等待数，默认 400
SESSION_QUEUE_MAX_PER_KEY=400
# 全局最大等待数，默认 6000
SESSION_QUEUE_MAX_GLOBAL=6000
```

### 4.1 运行模式说明（新增）

- **Polling 模式（默认）**：不设置 `WEBHOOK_URL`，进程会使用 `bot.start()` 长轮询。
- **Webhook 模式（推荐）**：设置 `WEBHOOK_URL` 后，进程会自动切到 Webhook，并启用入站队列。
- **全项目生效**：不是只针对狼人杀，反垃圾/抽奖/卧底/所有回调都会走同一套并发入口。
- **并发策略**：同一会话串行处理（避免乱序），不同会话并行处理（提升吞吐）。

> 注意：如果你使用反向代理（Nginx/Caddy），请确保把 `POST /api/telegram/webhook/...` 转发到 `WEB_PORT`。


### 5. 使用 PM2 后台运行（推荐）

```bash
# 安装 PM2
sudo npm install -g pm2

# 启动机器人
pm2 start dist/index.js --name antispam

# 查看状态/日志
pm2 status
pm2 logs antispam

# 设置开机自启
pm2 save
pm2 startup   # 按照提示执行输出的命令
```

Webhook 模式建议：

```bash
# 改完 .env 后重启
npm run build
pm2 restart antispam --update-env

# 查看 webhook/队列日志
pm2 logs antispam
```

PM2 常用命令：
```bash
npm run build && pm2 restart antispam   # 编译并重启
pm2 stop antispam      # 停止
pm2 delete antispam    # 删除
pm2 logs antispam      # 查看日志
```

### 6. 使用 systemd 后台运行（替代方案）

```bash
sudo nano /etc/systemd/system/antispam.service
```

写入：
```ini
[Unit]
Description=TG AntiSpam Bot
After=network.target

[Service]
Type=simple
User=root
WorkingDirectory=/root/tg-antispam
ExecStart=/usr/bin/node dist/index.js
Restart=always
RestartSec=5
EnvironmentFile=/root/tg-antispam/.env

[Install]
WantedBy=multi-user.target
```

启动：
```bash
sudo systemctl daemon-reload
sudo systemctl enable antispam
sudo systemctl start antispam

# 查看状态/日志
sudo systemctl status antispam
sudo journalctl -u antispam -f
```

### 7. 开始使用

1. 将机器人添加到群组
2. 将机器人设为 **管理员**（需要「删除消息」+「封禁用户」权限）
3. 在群组中发送 `/ads on` 开启反垃圾
4. 发送 `/ads status` 确认状态

---

## 更新部署

```bash
cd ~/tg-antispam
git pull                # 拉取最新代码
npm install             # 更新依赖
npm run build           # 重新编译
pm2 restart antispam    # 重启机器人
```
