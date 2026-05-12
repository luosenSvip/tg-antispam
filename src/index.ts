import "dotenv/config";
import { Bot, GrammyError } from "grammy";
import type { Update } from "grammy/types";
import { autoRetry } from "@grammyjs/auto-retry";
import { registerHandlers } from "./handlers";
import { registerWerewolfHandlers } from "./werewolf";
import { registerSpyHandlers } from "./spy";
import { startCronJobs } from "./cron";
import { registerLotteryHandlers } from "./lottery";
import { registerGameHandlers } from "./games";
import { registerAdsExtraHandlers } from "./tool";
import { startCommercialWebServer } from "./web";
import { createSessionSerialMiddleware, createUpdateIngressQueue } from "./chatQueue";
import * as db from "./db";

const ALLOWED_UPDATES: Array<"message" | "callback_query" | "chat_member" | "my_chat_member"> = [
  "message",
  "callback_query",
  "chat_member",
  "my_chat_member",
];

const BOT_TOKEN = String(process.env.BOT_TOKEN || "").trim();
if (!BOT_TOKEN) {
  console.error("❌ 请在 .env 文件中设置 BOT_TOKEN");
  process.exit(1);
}

const hasAIConfig = process.env.AI_API_KEY || process.env.AI_API_KEYS || process.env.AI_POOL_1;
if (!hasAIConfig) {
  console.warn("⚠️ 未配置平台默认 AI 接口。机器人仍会启动，但相关 AI 功能需要用户自行在订阅控制台中配置 AI。");
}

const WEBHOOK_URL = String(process.env.WEBHOOK_URL || "").trim();
const WEBHOOK_SECRET = String(process.env.WEBHOOK_SECRET || "").trim();

function readIntEnv(name: string, fallback: number, min: number, max: number): number {
  const raw = Number(process.env[name]);
  if (!Number.isFinite(raw)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(raw)));
}

const SESSION_QUEUE_MAX_PER_KEY = readIntEnv("SESSION_QUEUE_MAX_PER_KEY", 400, 1, 20000);
const SESSION_QUEUE_MAX_GLOBAL = readIntEnv("SESSION_QUEUE_MAX_GLOBAL", 6000, 10, 200000);
const WEBHOOK_WORKERS = readIntEnv("WEBHOOK_WORKERS", 8, 1, 128);
const WEBHOOK_QUEUE_MAX = readIntEnv("WEBHOOK_QUEUE_MAX", 10000, 100, 500000);
const COMMAND_AUTO_DELETE = String(process.env.COMMAND_AUTO_DELETE ?? "1").trim() !== "0";

const BOT_COMMANDS = [
  { command: "start", description: "开始使用机器人" },
  { command: "ads", description: "打开反垃圾广告面板" },
  { command: "assistant", description: "管理群 AI 助手开关" },
  { command: "jf", description: "查看我的积分" },
  { command: "jfph", description: "查看积分排行榜" },
  { command: "shop", description: "打开积分商城" },
  { command: "dh", description: "兑换商城物品" },
  { command: "yq", description: "查看邀请信息" },
  { command: "console", description: "生成订阅后台登录码" },
  { command: "groups", description: "查看你管理的群" },
  { command: "sub", description: "查询当前群订阅信息" },
  { command: "claim", description: "领取群订阅" },
  { command: "unbind", description: "解绑群订阅" },
] as const;

function isCommandMessage(ctx: any): boolean {
  const message = ctx?.message;
  if (!message) return false;
  const entities = message.entities || message.caption_entities;
  if (!Array.isArray(entities) || entities.length === 0) return false;
  return entities.some((entity: any) => entity?.type === "bot_command" && Number(entity?.offset) === 0);
}

function getMigratedChatIdFromError(error: GrammyError): number | null {
  if (error.error_code !== 400) return null;
  const desc = String(error.description || error.message || "").toLowerCase();
  if (!desc.includes("group chat was upgraded to a supergroup chat")) return null;
  const migrated = Number((error as any)?.parameters?.migrate_to_chat_id || 0);
  return Number.isFinite(migrated) && migrated !== 0 ? migrated : null;
}

function tryReadPayloadChatId(payload: unknown): number | null {
  if (!payload || typeof payload !== "object") return null;
  const raw = (payload as any).chat_id;
  const value = Number(raw);
  return Number.isFinite(value) ? value : null;
}

function isTelegramUpdate(payload: unknown): payload is Update {
  if (!payload || typeof payload !== "object") return false;
  const updateId = Number((payload as any).update_id);
  return Number.isFinite(updateId);
}

const bot = new Bot(BOT_TOKEN);

bot.api.config.use(autoRetry());
bot.api.config.use(async (prev, method, payload, signal) => {
  try {
    return await prev(method, payload, signal);
  } catch (error) {
    if (!(error instanceof GrammyError)) throw error;
    const oldChatId = tryReadPayloadChatId(payload);
    const newChatId = getMigratedChatIdFromError(error);
    if (!oldChatId || !newChatId || oldChatId === newChatId) throw error;

    try {
      db.migrateChatId(oldChatId, newChatId);
      if (payload && typeof payload === "object") {
        (payload as any).chat_id = newChatId;
      }
      console.warn(`[Bot] 检测到群组升级，已自动迁移 chat_id: ${oldChatId} -> ${newChatId}，method=${method}`);
      return await prev(method, payload, signal);
    } catch (migrationError) {
      console.error(`[Bot] 自动迁移 supergroup 失败: ${oldChatId} -> ${newChatId}`, migrationError);
      throw error;
    }
  }
});

bot.api.config.use(async (prev, method, payload, signal) => {
  if ((method === "sendMessage" || method === "editMessageText") && payload && typeof payload === "object") {
    const body = payload as Record<string, any>;
    if (!("disable_web_page_preview" in body)) {
      const current = body.link_preview_options;
      if (!current || typeof current !== "object") {
        body.link_preview_options = { is_disabled: true };
      } else if (!("is_disabled" in current)) {
        body.link_preview_options = { ...current, is_disabled: true };
      } else if (current.is_disabled !== true) {
        body.link_preview_options = { ...current, is_disabled: true };
      }
    }
  }
  return prev(method, payload, signal);
});

bot.use(async (ctx, next) => {
  const message: any = ctx.msg;
  const oldChatId = message?.migrate_from_chat_id;
  const newChatId = message?.migrate_to_chat_id || ctx.chat?.id;
  if (Number.isFinite(Number(oldChatId)) && Number.isFinite(Number(newChatId)) && Number(oldChatId) !== Number(newChatId)) {
    db.migrateChatId(Number(oldChatId), Number(newChatId));
    console.warn(`[Bot] 收到群升级事件，已迁移 chat_id: ${oldChatId} -> ${newChatId}`);
  }
  await next();
});

bot.use(async (ctx, next) => {
  await next();

  if (!COMMAND_AUTO_DELETE) return;
  if (!isCommandMessage(ctx)) return;
  if (ctx.chat?.type === "private") return;

  const chatId = ctx.chat?.id;
  const messageId = ctx.message?.message_id;
  if (!chatId || !messageId) return;
  await ctx.api.deleteMessage(chatId, messageId).catch(() => { });
});

bot.use(
  createSessionSerialMiddleware({
    maxPendingPerSession: SESSION_QUEUE_MAX_PER_KEY,
    maxPendingGlobal: SESSION_QUEUE_MAX_GLOBAL,
  })
);

registerWerewolfHandlers(bot);
registerSpyHandlers(bot);
registerLotteryHandlers(bot);
registerGameHandlers(bot);
registerAdsExtraHandlers(bot);
registerHandlers(bot);

startCronJobs(bot);

function isStaleCallbackQueryError(error: GrammyError): boolean {
  if (error.method !== "answerCallbackQuery") return false;
  const desc = String(error.description || error.message || "").toLowerCase();
  return (
    error.error_code === 400 &&
    (desc.includes("query is too old") ||
      desc.includes("response timeout expired") ||
      desc.includes("query id is invalid"))
  );
}

function isMessageNotModifiedError(error: GrammyError): boolean {
  if (error.method !== "editMessageText") return false;
  const desc = String(error.description || error.message || "").toLowerCase();
  return error.error_code === 400 && desc.includes("message is not modified");
}

bot.catch((err) => {
  const updateId = err.ctx?.update?.update_id;
  if (err.error instanceof GrammyError) {
    if (isStaleCallbackQueryError(err.error)) return;
    if (isMessageNotModifiedError(err.error)) return;
    console.error(
      `[Bot] 未捕获的 GrammyError: method=${err.error.method} update_id=${updateId ?? "unknown"} code=${err.error.error_code} desc=${err.error.description}`
    );
    return;
  }
  console.error(`[Bot] 未捕获的错误: update_id=${updateId ?? "unknown"}`, err.error);
});

let webServer: ReturnType<typeof startCommercialWebServer> | null = null;

async function bootstrap() {
  console.log("🛡️ TG 反垃圾广告机器人启动中...");
  console.log(`🤖 AI 模型: ${process.env.AI_MODEL || "gpt-4o-mini"}`);

  await bot.init();
  await bot.api.setMyCommands(BOT_COMMANDS as any).catch((error) => {
    console.warn("[Bot] 设置机器人命令菜单失败:", error);
  });

  if (WEBHOOK_URL) {
    const webhookUrl = new URL(WEBHOOK_URL);
    const webhookPath = webhookUrl.pathname || "/";
    const ingressQueue = createUpdateIngressQueue(
      async (update) => {
        await bot.handleUpdate(update);
      },
      {
        workerCount: WEBHOOK_WORKERS,
        maxQueueSize: WEBHOOK_QUEUE_MAX,
      }
    );

    webServer = startCommercialWebServer(bot, {
      telegramWebhook: {
        path: webhookPath,
        secretToken: WEBHOOK_SECRET || undefined,
        onUpdate: (update) => {
          if (!isTelegramUpdate(update)) return true;
          return ingressQueue.enqueue(update);
        },
      },
    });

    await bot.api.setWebhook(webhookUrl.toString(), {
      allowed_updates: ALLOWED_UPDATES,
      secret_token: WEBHOOK_SECRET || undefined,
    });

    console.log(`✅ 机器人已启动(Webhook): @${bot.botInfo.username}`);
    console.log(`🌐 Webhook 地址: ${webhookUrl.toString()}`);
    console.log(`⚙️ Webhook workers=${WEBHOOK_WORKERS}, queue_max=${WEBHOOK_QUEUE_MAX}`);

    setInterval(() => {
      const stats = ingressQueue.getStats();
      if (stats.queued > 0 || stats.activeWorkers > 0 || stats.dropped > 0) {
        console.log(`[WebhookQueue] queued=${stats.queued} active=${stats.activeWorkers} dropped=${stats.dropped}`);
      }
    }, 15000).unref();
    return;
  }

  await bot.api.deleteWebhook({ drop_pending_updates: false }).catch(() => {
    return;
  });

  webServer = startCommercialWebServer(bot);

  bot.start({
    allowed_updates: ALLOWED_UPDATES,
    onStart: (botInfo) => {
      console.log(`✅ 机器人已启动(Polling): @${botInfo.username}`);
      console.log("📌 将机器人添加到群组并设为管理员（需要删除消息+封禁用户权限）");
      console.log("📌 在群组中发送 /ads on 开启反垃圾检测");
    },
  });
}

bootstrap().catch((error) => {
  console.error("❌ 启动失败:", error);
  process.exit(1);
});

process.once("SIGINT", () => {
  console.log("\n🛑 正在关闭机器人...");
  try {
    webServer?.close();
  } catch {
    // ignore
  }
  bot.stop();
});

process.once("SIGTERM", () => {
  try {
    webServer?.close();
  } catch {
    // ignore
  }
  bot.stop();
});
