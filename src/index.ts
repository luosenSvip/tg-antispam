import "dotenv/config";
import { Bot, GrammyError } from "grammy";
import type { Update } from "grammy/types";
import { autoRetry } from "@grammyjs/auto-retry";
import { exec as execCb } from "node:child_process";
import { promisify } from "node:util";
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
const AUTH_REQUIRED = ["1", "true", "yes", "on"].includes(String(process.env.AUTH_REQUIRED || "").trim().toLowerCase());
const AUTHORIZED_USER_IDS = new Set(
  String(process.env.AUTHORIZED_USER_IDS || "")
    .split(",")
    .map((raw) => Number(raw.trim()))
    .filter((id) => Number.isFinite(id) && id > 0)
);
const ROOT_ADMIN_USER_ID = Number(process.env.ADMIN_USER_ID || 0);
const AUTH_SERVER_URL = String(process.env.AUTH_SERVER_URL || "").trim();
const AUTH_LICENSE_KEY = String(process.env.AUTH_LICENSE_KEY || "").trim();
const ENABLE_TG_UPDATE = ["1", "true", "yes", "on"].includes(String(process.env.ENABLE_TG_UPDATE || "1").trim().toLowerCase());
const exec = promisify(execCb);

function escapeHtml(input: string): string {
  return String(input || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function readIntEnv(name: string, fallback: number, min: number, max: number): number {
  const raw = Number(process.env[name]);
  if (!Number.isFinite(raw)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(raw)));
}

const SESSION_QUEUE_MAX_PER_KEY = readIntEnv("SESSION_QUEUE_MAX_PER_KEY", 400, 1, 20000);
const SESSION_QUEUE_MAX_GLOBAL = readIntEnv("SESSION_QUEUE_MAX_GLOBAL", 6000, 10, 200000);
const WEBHOOK_WORKERS = readIntEnv("WEBHOOK_WORKERS", 8, 1, 128);
const WEBHOOK_QUEUE_MAX = readIntEnv("WEBHOOK_QUEUE_MAX", 10000, 100, 500000);

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

async function verifyLicenseIfConfigured(): Promise<void> {
  if (!AUTH_SERVER_URL || !AUTH_LICENSE_KEY) return;
  const endpoint = AUTH_SERVER_URL.replace(/\/+$/, "");
  const payload = {
    license_key: AUTH_LICENSE_KEY,
    bot_token_prefix: BOT_TOKEN.slice(0, 12),
    admin_user_id: ROOT_ADMIN_USER_ID || undefined,
  };
  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!response.ok) {
      throw new Error(`status=${response.status}`);
    }
    const data: any = await response.json().catch(() => ({}));
    if (data && data.ok === false) {
      throw new Error(String(data.message || "license rejected"));
    }
    console.log("✅ 授权校验通过");
  } catch (error) {
    console.error("❌ 授权校验失败，已拒绝启动。", error);
    process.exit(1);
  }
}

async function checkGitUpdateStatus(): Promise<{ supported: boolean; behind: boolean; local?: string; remote?: string; message: string }> {
  try {
    const { stdout: inRepo } = await exec("git rev-parse --is-inside-work-tree");
    if (!String(inRepo).trim().includes("true")) {
      return { supported: false, behind: false, message: "当前目录不是 Git 仓库，无法检查更新。" };
    }
  } catch {
    return { supported: false, behind: false, message: "当前环境不支持 Git 更新检测。" };
  }
  try {
    const { stdout: localOut } = await exec("git rev-parse HEAD");
    const { stdout: remoteOut } = await exec("git ls-remote --heads origin HEAD");
    const local = String(localOut).trim();
    const remote = String(remoteOut).trim().split(/\s+/)[0] || "";
    if (!local || !remote) return { supported: false, behind: false, message: "无法读取本地或远端版本。" };
    return {
      supported: true,
      behind: local !== remote,
      local,
      remote,
      message: local === remote ? "当前已是最新版本。" : "检测到新版本可更新。",
    };
  } catch {
    return { supported: false, behind: false, message: "更新检测失败（可能未配置 origin）。" };
  }
}

async function runUpdateScript(): Promise<{ ok: boolean; output: string }> {
  try {
    const { stdout, stderr } = await exec("bash ./update.sh", { maxBuffer: 1024 * 1024 * 8 });
    const combined = `${stdout || ""}${stderr || ""}`.trim();
    return { ok: true, output: combined.slice(-3500) || "update.sh 执行完成。" };
  } catch (error: any) {
    const output = String(error?.stdout || "") + String(error?.stderr || "") + String(error?.message || "");
    return { ok: false, output: output.trim().slice(-3500) || "update.sh 执行失败。" };
  }
}

function isAuthorizedUser(userId: number | undefined): boolean {
  if (!AUTH_REQUIRED) return true;
  if (!userId) return false;
  if (AUTHORIZED_USER_IDS.size === 0) return false;
  if (AUTHORIZED_USER_IDS.has(userId)) return true;
  return Number.isFinite(ROOT_ADMIN_USER_ID) && ROOT_ADMIN_USER_ID > 0 && ROOT_ADMIN_USER_ID === userId;
}

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
  if (ENABLE_TG_UPDATE && ctx.chat?.type === "private" && ctx.from?.id && ctx.message?.text?.startsWith("/update")) {
    if (!Number.isFinite(ROOT_ADMIN_USER_ID) || ROOT_ADMIN_USER_ID <= 0 || ctx.from.id !== ROOT_ADMIN_USER_ID) {
      await ctx.reply("⛔ 仅 ADMIN_USER_ID 可执行更新操作。").catch(() => { });
      return;
    }
    const arg = ctx.message.text.trim().split(/\s+/)[1]?.toLowerCase() || "check";
    if (arg === "check") {
      const status = await checkGitUpdateStatus();
      await ctx.reply(
        `🔎 更新检测\n\n结果: ${status.message}\nlocal: <code>${(status.local || "-").slice(0, 12)}</code>\nremote: <code>${(status.remote || "-").slice(0, 12)}</code>`,
        { parse_mode: "HTML" }
      ).catch(() => { });
      return;
    }
    if (arg === "now" || arg === "run") {
      await ctx.reply("⏳ 开始执行 update.sh，请稍候...").catch(() => { });
      const result = await runUpdateScript();
      await ctx.reply(
        `${result.ok ? "✅ 更新脚本执行完成" : "❌ 更新脚本执行失败"}\n\n<pre>${escapeHtml(result.output || "-")}</pre>`,
        { parse_mode: "HTML" }
      ).catch(() => { });
      return;
    }
    await ctx.reply("用法：/update check 或 /update now").catch(() => { });
    return;
  }

  if (ctx.chat?.type === "private" && ctx.from?.id && ctx.message?.text?.startsWith("/auth")) {
    if (!Number.isFinite(ROOT_ADMIN_USER_ID) || ROOT_ADMIN_USER_ID <= 0 || ctx.from.id !== ROOT_ADMIN_USER_ID) {
      await ctx.reply("⛔ 仅 ADMIN_USER_ID 可管理授权名单。").catch(() => { });
      return;
    }
    const parts = ctx.message.text.trim().split(/\s+/);
    const action = (parts[1] || "").toLowerCase();
    const targetId = Number(parts[2] || 0);
    if (action === "list") {
      const ids = Array.from(AUTHORIZED_USER_IDS.values()).sort((a, b) => a - b);
      await ctx.reply(ids.length ? `✅ 当前授权用户：\n${ids.join("\n")}` : "⚠️ 当前授权列表为空。").catch(() => { });
      return;
    }
    if (!Number.isFinite(targetId) || targetId <= 0) {
      await ctx.reply("用法：/auth list 或 /auth add <tgid> 或 /auth rm <tgid>").catch(() => { });
      return;
    }
    if (action === "add") {
      AUTHORIZED_USER_IDS.add(targetId);
      await ctx.reply(`✅ 已授权：${targetId}`).catch(() => { });
      return;
    }
    if (action === "rm" || action === "del" || action === "remove") {
      AUTHORIZED_USER_IDS.delete(targetId);
      await ctx.reply(`✅ 已移除授权：${targetId}`).catch(() => { });
      return;
    }
    await ctx.reply("用法：/auth list 或 /auth add <tgid> 或 /auth rm <tgid>").catch(() => { });
    return;
  }

  if (!ctx.from) return next();
  const authorized = isAuthorizedUser(ctx.from.id);
  if (authorized) return next();

  const isPrivate = ctx.chat?.type === "private";
  const isInteractiveGroupCommand = !!ctx.message?.text?.trim().startsWith("/");
  if (!isPrivate && !isInteractiveGroupCommand) return next();

  const tip = "🔐 当前机器人已启用授权访问，请联系管理员添加你的 Telegram ID。";
  if (isPrivate) {
    await ctx.reply(tip).catch(() => { });
  } else if (ctx.chat?.id && ctx.message?.message_id) {
    await ctx.api.sendMessage(ctx.chat.id, tip, {
      reply_parameters: { message_id: ctx.message.message_id },
      link_preview_options: { is_disabled: true },
    }).catch(() => { });
  }
  return;
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
  await verifyLicenseIfConfigured();

  await bot.init();
  if (ENABLE_TG_UPDATE && Number.isFinite(ROOT_ADMIN_USER_ID) && ROOT_ADMIN_USER_ID > 0) {
    const status = await checkGitUpdateStatus();
    if (status.supported && status.behind) {
      await bot.api.sendMessage(
        ROOT_ADMIN_USER_ID,
        `📦 检测到机器人可更新版本。\nlocal: <code>${status.local?.slice(0, 12)}</code>\nremote: <code>${status.remote?.slice(0, 12)}</code>\n可私聊发送 <code>/update now</code> 一键更新。`,
        { parse_mode: "HTML", link_preview_options: { is_disabled: true } }
      ).catch(() => { });
    }
  }

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
