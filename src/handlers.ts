import { Bot, Context, GrammyError, InlineKeyboard } from "grammy";
import { callAI, checkSpam, SpamSample } from "./ai";
import * as db from "./db";
import axios from "axios";
import { createLotteryFromSpec, LotteryCreationSpec } from "./lottery";
import { createConsoleLoginCodeForUser } from "./web";
import { renderMarkdownToPlainText, renderMarkdownToTelegramHtml } from "./markdown";
import { createZjmfPromoFromPointsMall } from "./zjmf";

let LunarSolar: any = null;
try {
  LunarSolar = require("lunar-javascript")?.Solar || null;
} catch (error) {
  console.warn("[Almanac] lunar-javascript 未安装，黄历功能将暂时不可用。");
}

// ==================== 管理员缓存 ====================
const adminCache = new Map<number, { admins: Set<number>; expireAt: number }>();
const ADMIN_CACHE_TTL = 5 * 60 * 1000; // 5 分钟

// ==================== 聊天历史缓存 (用于提供上下文) ====================
const chatHistoryCache = new Map<number, { userName: string; text: string }[]>();
const MAX_HISTORY = 10;
const recentUserMessages = new Map<string, { messageId: number; createdAt: number }[]>();
const RECENT_USER_MESSAGES_TTL_MS = 48 * 60 * 60 * 1000;
const MAX_RECENT_USER_MESSAGES = 100;
const recentDuplicateTexts = new Map<string, { text: string; createdAt: number }[]>();
const DUPLICATE_TEXT_WINDOW_MS = 45_000;
const DUPLICATE_TEXT_THRESHOLD = 3;
const DUPLICATE_TEXT_MAX_TRACK = 20;
const duplicateFloodPenaltyState = new Map<string, { firstAt: number; count: number }>();
const DUPLICATE_FLOOD_PENALTY_WINDOW_MS = 6 * 60 * 60 * 1000;
const DUPLICATE_FLOOD_MUTE_MINUTES = 10;

// ==================== 群内回复机器人对话冷却 ====================
const groupAiReplyCooldown = new Map<number, number>();
const GROUP_AI_REPLY_COOLDOWN_MS = 10_000;
const groupChatAiBackoffUntil = new Map<number, number>();
const GROUP_CHAT_AI_BACKOFF_MS = 30_000;
const GROUP_CHAT_LOCAL_FALLBACK_DELAY_MS = 2_000;
const GROUP_CHAT_LOCAL_FALLBACK_REPLY = "别催，爷缓两秒就回来。";
const COMMERCIAL_WELCOME_AUTO_DELETE_MS = 60_000;
const PASS_NOTICE_AUTO_DELETE_MS = 60_000;

type PendingReplyMessage = {
  chatId: number;
  messageId: number;
  replyToMessageId: number;
};

type PendingReplyOptions = {
  parse_mode?: "HTML";
  link_preview_options?: { is_disabled?: boolean };
  reply_markup?: InlineKeyboard;
};

function getPromoTypeLabel(promoType: string): string {
  if (promoType === "fixed") return "固定金额";
  if (promoType === "override") return "覆盖价格";
  if (promoType === "free") return "免费/免安装";
  return "百分比";
}

function shouldSkipGroupAiReply(chatId: number): boolean {
  const last = groupAiReplyCooldown.get(chatId);
  if (last && Date.now() - last < GROUP_AI_REPLY_COOLDOWN_MS) return true;
  groupAiReplyCooldown.set(chatId, Date.now());
  return false;
}

async function sendGroupLocalFallback(ctx: Context, messageId: number, pending?: PendingReplyMessage | null) {
  await new Promise((resolve) => setTimeout(resolve, GROUP_CHAT_LOCAL_FALLBACK_DELAY_MS));
  await sendOrEditPendingReply(ctx, pending, GROUP_CHAT_LOCAL_FALLBACK_REPLY, {
    link_preview_options: { is_disabled: true },
  });
}

async function createPendingReplyMessage(
  ctx: Context,
  chatId: number,
  replyToMessageId: number,
  text: string = "⏳ 正在思考中..."
): Promise<PendingReplyMessage | null> {
  try {
    const msg = await ctx.api.sendMessage(chatId, text, {
      reply_parameters: { message_id: replyToMessageId },
      link_preview_options: { is_disabled: true },
    });
    return { chatId, messageId: msg.message_id, replyToMessageId };
  } catch {
    return null;
  }
}

async function deletePendingReplyMessage(ctx: Context, pending: PendingReplyMessage | null | undefined): Promise<void> {
  if (!pending) return;
  await ctx.api.deleteMessage(pending.chatId, pending.messageId).catch(() => { });
}

async function sendOrEditPendingReply(
  ctx: Context,
  pending: PendingReplyMessage | null | undefined,
  text: string,
  options: PendingReplyOptions = {}
): Promise<void> {
  if (pending) {
    try {
      await ctx.api.editMessageText(pending.chatId, pending.messageId, text, options);
      return;
    } catch (error) {
      if (!isMessageEditUnavailableError(error)) {
        console.warn("[Assistant] 更新占位回复失败，改为发送新消息:", error);
      }
    }
  }

  if (!ctx.message?.message_id) return;
  await ctx.reply(text, {
    ...options,
    reply_parameters: { message_id: ctx.message.message_id },
  }).catch(() => { });
}

function scheduleAutoDeleteMessage(ctx: Context, chatId: number, messageId: number, delayMs: number): void {
  const safeDelayMs = Math.max(1_000, Math.floor(delayMs || 0));
  setTimeout(() => {
    ctx.api.deleteMessage(chatId, messageId).catch(() => { });
  }, safeDelayMs);
}

function isForwardedTelegramMessage(message: any): boolean {
  return !!(
    message?.forward_origin ||
    message?.forward_date ||
    message?.forward_from ||
    message?.forward_from_chat ||
    message?.is_automatic_forward
  );
}

async function tryDeleteSourceMessage(ctx: Context): Promise<void> {
  const chatId = ctx.chat?.id;
  const messageId = ctx.message?.message_id;
  if (!chatId || !messageId || ctx.chat?.type === "private") return;
  await ctx.api.deleteMessage(chatId, messageId).catch(() => { });
}

function buildRecentUserMessagesKey(chatId: number, userId: number): string {
  return `${chatId}:${userId}`;
}

function trackRecentUserMessage(chatId: number, userId: number, messageId: number): void {
  if (!Number.isFinite(chatId) || !Number.isFinite(userId) || !Number.isFinite(messageId)) return;
  const key = buildRecentUserMessagesKey(chatId, userId);
  const now = Date.now();
  const rows = (recentUserMessages.get(key) || [])
    .filter((item) => now - item.createdAt <= RECENT_USER_MESSAGES_TTL_MS && item.messageId !== messageId);
  rows.push({ messageId, createdAt: now });
  recentUserMessages.set(key, rows.slice(-MAX_RECENT_USER_MESSAGES));
}

function normalizeDuplicateText(text: string): string {
  return String(text || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/[^\p{L}\p{N}\s]/gu, "");
}

function trackDuplicateTextAndCheckFlood(chatId: number, userId: number, text: string): boolean {
  const normalized = normalizeDuplicateText(text);
  if (!normalized || normalized.length < 2) return false;
  const key = buildRecentUserMessagesKey(chatId, userId);
  const now = Date.now();
  const rows = (recentDuplicateTexts.get(key) || [])
    .filter((item) => now - item.createdAt <= DUPLICATE_TEXT_WINDOW_MS);
  rows.push({ text: normalized, createdAt: now });
  recentDuplicateTexts.set(key, rows.slice(-DUPLICATE_TEXT_MAX_TRACK));
  const hits = rows.filter((item) => item.text === normalized).length;
  return hits >= DUPLICATE_TEXT_THRESHOLD;
}

function trackDuplicateFloodPenalty(chatId: number, userId: number): { count: number; shouldMute: boolean } {
  const key = buildRecentUserMessagesKey(chatId, userId);
  const now = Date.now();
  const prev = duplicateFloodPenaltyState.get(key);
  const next = (!prev || now - prev.firstAt > DUPLICATE_FLOOD_PENALTY_WINDOW_MS)
    ? { firstAt: now, count: 1 }
    : { firstAt: prev.firstAt, count: prev.count + 1 };
  duplicateFloodPenaltyState.set(key, next);
  return { count: next.count, shouldMute: next.count >= 2 };
}

async function deleteRecentUserMessages(api: Context["api"], chatId: number, userId: number): Promise<number> {
  const key = buildRecentUserMessagesKey(chatId, userId);
  const rows = recentUserMessages.get(key) || [];
  recentUserMessages.delete(key);
  if (!rows.length) return 0;

  let deletedCount = 0;
  for (const row of rows) {
    try {
      await api.deleteMessage(chatId, row.messageId);
      deletedCount += 1;
    } catch { }
  }
  return deletedCount;
}

function getPermanentBanUntilDate(): number {
  return Math.floor(Date.now() / 1000) + 400 * 24 * 60 * 60;
}

async function banUserPermanently(api: Context["api"], chatId: number, userId: number): Promise<void> {
  await api.banChatMember(chatId, userId, { until_date: getPermanentBanUntilDate() });
}

function pickRandom<T>(items: T[]): T {
  return items[Math.floor(Math.random() * items.length)];
}

setInterval(() => {
  const now = Date.now();
  for (const [key, ts] of groupAiReplyCooldown.entries()) {
    if (now - ts > GROUP_AI_REPLY_COOLDOWN_MS * 3) {
      groupAiReplyCooldown.delete(key);
    }
  }
}, 60_000);

setInterval(() => {
  const now = Date.now();
  for (const [key, state] of duplicateFloodPenaltyState.entries()) {
    if (now - state.firstAt > DUPLICATE_FLOOD_PENALTY_WINDOW_MS) {
      duplicateFloodPenaltyState.delete(key);
    }
  }
}, 10 * 60_000);

setInterval(() => {
  const now = Date.now();
  for (const [key, rows] of recentUserMessages.entries()) {
    const kept = rows.filter((item) => now - item.createdAt <= RECENT_USER_MESSAGES_TTL_MS);
    if (kept.length > 0) recentUserMessages.set(key, kept.slice(-MAX_RECENT_USER_MESSAGES));
    else recentUserMessages.delete(key);
  }
}, 10 * 60_000);

setInterval(() => {
  const now = Date.now();
  for (const [key, rows] of recentDuplicateTexts.entries()) {
    const kept = rows.filter((item) => now - item.createdAt <= DUPLICATE_TEXT_WINDOW_MS);
    if (kept.length > 0) recentDuplicateTexts.set(key, kept.slice(-DUPLICATE_TEXT_MAX_TRACK));
    else recentDuplicateTexts.delete(key);
  }
}, 60_000);

// ==================== 投票阈值 ====================
const POLL_VOTES_THRESHOLD = 2;

function getMigratedChatIdFromError(error: unknown): number | null {
  if (!(error instanceof GrammyError)) return null;
  if (error.error_code !== 400) return null;
  const desc = String(error.description || error.message || "").toLowerCase();
  if (!desc.includes("group chat was upgraded to a supergroup chat")) return null;
  const migrated = Number((error as any)?.parameters?.migrate_to_chat_id || 0);
  return Number.isFinite(migrated) && migrated !== 0 ? migrated : null;
}

async function getAdmins(ctx: Context, chatId: number): Promise<Set<number>> {
  const cached = adminCache.get(chatId);
  if (cached && Date.now() < cached.expireAt) {
    return cached.admins;
  }

  try {
    const members = await ctx.api.getChatAdministrators(chatId);
    const admins = new Set(members.map((m) => m.user.id));
    adminCache.set(chatId, { admins, expireAt: Date.now() + ADMIN_CACHE_TTL });
    return admins;
  } catch (error) {
    const migratedChatId = getMigratedChatIdFromError(error);
    if (migratedChatId && migratedChatId !== chatId) {
      try {
        db.migrateChatId(chatId, migratedChatId);
        const members = await ctx.api.getChatAdministrators(migratedChatId);
        const admins = new Set(members.map((m) => m.user.id));
        adminCache.delete(chatId);
        adminCache.set(migratedChatId, { admins, expireAt: Date.now() + ADMIN_CACHE_TTL });
        console.warn(`[Admin] 管理员缓存已自动迁移 chat_id: ${chatId} -> ${migratedChatId}`);
        return admins;
      } catch (retryError) {
        console.error(`[Admin] 迁移 supergroup 后重新获取管理员失败: ${chatId} -> ${migratedChatId}`, retryError);
      }
    }
    if (isGroupUnavailableError(error)) {
      console.warn(`[Admin] 群组不可用，自动关闭所有开关: ${chatId}`);
      db.closeAllGroupSwitches(chatId);
      adminCache.delete(chatId);
      return new Set();
    }
    console.error("[Admin] 获取管理员列表失败:", error);
    return cached?.admins ?? new Set();
  }
}

function isGroupUnavailableError(error: any): boolean {
  const desc = String(
    error instanceof GrammyError
      ? (error.description || error.message || "")
      : (error?.description || error?.message || "")
  ).toLowerCase();

  return (
    desc.includes("chat not found") ||
    desc.includes("bot was kicked") ||
    desc.includes("not a member") ||
    desc.includes("forbidden")
  );
}

function isMessageEditUnavailableError(error: unknown): boolean {
  if (!(error instanceof GrammyError)) return false;
  const desc = String(error.description || error.message || "").toLowerCase();
  return (
    desc.includes("message to edit not found") ||
    desc.includes("message_id_invalid") ||
    desc.includes("message id invalid") ||
    desc === "bad request: not found" ||
    desc.includes("message can't be edited")
  );
}

function isMessageNotModifiedError(error: unknown): boolean {
  if (!(error instanceof GrammyError)) return false;
  const desc = String(error.description || error.message || "").toLowerCase();
  return desc.includes("message is not modified");
}

function isReplyTargetMissingError(error: unknown): boolean {
  if (!(error instanceof GrammyError)) return false;
  const desc = String(error.description || error.message || "").toLowerCase();
  return (
    desc.includes("message to be replied not found") ||
    desc.includes("replied message not found")
  );
}

function isMessageDeleteUnavailableError(error: unknown): boolean {
  if (!(error instanceof GrammyError)) return false;
  const desc = String(error.description || error.message || "").toLowerCase();
  return (
    desc.includes("message to delete not found") ||
    desc.includes("message can't be deleted") ||
    desc.includes("message can not be deleted")
  );
}

async function safeEditCallbackMessageText(
  ctx: Context,
  text: string,
  options: Parameters<Context["editMessageText"]>[1],
  expiredHint: string
): Promise<boolean> {
  try {
    await ctx.editMessageText(text, options);
    return true;
  } catch (error) {
    if (isMessageNotModifiedError(error)) {
      await ctx.answerCallbackQuery().catch(() => { });
      return false;
    }
    if (isMessageEditUnavailableError(error)) {
      await ctx.answerCallbackQuery({ text: expiredHint, show_alert: true }).catch(() => { });
      return false;
    }
    throw error;
  }
}

function isAdmin(chatId: number, userId: number): boolean {
  const cached = adminCache.get(chatId);
  return cached?.admins.has(userId) ?? false;
}

// ==================== 管理员检测（全群组豁免） ====================
function isAnyGroupAdmin(userId: number): boolean {
  for (const { admins } of adminCache.values()) {
    if (admins.has(userId)) return true;
  }
  return false;
}

async function refreshAllAdminCaches(bot: Bot) {
  const allGroups = db.getAllEnabledGroups();
  console.log(`[Admin] 开始全量刷新 ${allGroups.length} 个群组的管理员缓存...`);
  const staleGroupIds: number[] = [];
  for (const chatId of allGroups) {
    try {
      const members = await bot.api.getChatAdministrators(chatId);
      const admins = new Set(members.map((m) => m.user.id));
      adminCache.set(chatId, { admins, expireAt: Date.now() + ADMIN_CACHE_TTL });
    } catch (e) {
      const migratedChatId = getMigratedChatIdFromError(e);
      if (migratedChatId && migratedChatId !== chatId) {
        try {
          db.migrateChatId(chatId, migratedChatId);
          const members = await bot.api.getChatAdministrators(migratedChatId);
          const admins = new Set(members.map((m) => m.user.id));
          adminCache.delete(chatId);
          adminCache.set(migratedChatId, { admins, expireAt: Date.now() + ADMIN_CACHE_TTL });
          console.warn(`[Admin] 全量刷新时已自动迁移 chat_id: ${chatId} -> ${migratedChatId}`);
          await new Promise(r => setTimeout(r, 100));
          continue;
        } catch (retryError) {
          console.error(`[Admin] 全量刷新迁移 supergroup 后仍失败: ${chatId} -> ${migratedChatId}`, retryError);
        }
      }
      if (isGroupUnavailableError(e)) {
        staleGroupIds.push(chatId);
      }
    }
    // 强制休眠 100ms 避免触发 Telegram 的全局 API 频率限制 (429 Too Many Requests)
    await new Promise(r => setTimeout(r, 100));
  }

  if (staleGroupIds.length > 0) {
    for (const gid of staleGroupIds) {
      db.closeAllGroupSwitches(gid);
      adminCache.delete(gid);
    }
    console.log(`[Admin] 已自动清理 ${staleGroupIds.length} 个失效群组缓存: ${staleGroupIds.join(", ")}`);
  }
}

// 防频繁检测：同一用户 30s 内只检测 1 次
const recentlyChecked = new Map<string, number>();
const CHECK_COOLDOWN = 30_000;

function shouldSkipCheck(chatId: number, userId: number): boolean {
  const key = `${chatId}:${userId}`;
  const last = recentlyChecked.get(key);
  if (last && Date.now() - last < CHECK_COOLDOWN) return true;
  recentlyChecked.set(key, Date.now());
  return false;
}

// 定期清理冷却缓存
setInterval(() => {
  const now = Date.now();
  for (const [key, time] of recentlyChecked) {
    if (now - time > CHECK_COOLDOWN * 2) recentlyChecked.delete(key);
  }
}, 60_000);

// ==================== 刷屏口令过滤（抽奖等） ====================
// 已检测到抽奖 Bot 的群（无时间限制，直到重启）
const lotteryActiveGroups = new Set<number>();

// 抽奖关键词正则
const LOTTERY_BOT_REGEX = /抽奖|口令|奖品|开奖|新抽奖活动|参与口令|参与方法|抽奖条件|giveaway/i;

// 短消息去重跟踪：key = chatId:normalizedText, value = Set<userId>
const messageDedup = new Map<string, { users: Set<number>; firstSeen: number }>();
const DEDUP_WINDOW = 10 * 60 * 1000; // 10 分钟窗口
const DEDUP_THRESHOLD = 3; // 3 个不同用户发相同消息即确认为刷屏口令

// 已确认的刷屏口令集合：key = chatId:text
const confirmedLotteryKeywords = new Set<string>();

// 定期清理去重跟踪数据（已确认的口令不清理）
setInterval(() => {
  const now = Date.now();
  for (const [key, data] of messageDedup) {
    if (now - data.firstSeen > DEDUP_WINDOW) {
      messageDedup.delete(key);
    }
  }
}, 60_000);

// ==================== HTML 转义 ====================
function esc(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function joinMessageLines(lines: Array<string | null | undefined | false>): string {
  return lines.filter((line) => line !== null && line !== undefined && line !== false).join("\n");
}

function formatDateOnly(text: string): string {
  const value = String(text || "").trim();
  if (!value) return "";
  const match = value.match(/^(\d{4}-\d{2}-\d{2})/);
  return match ? match[1] : value;
}

function buildPointsMallConditionLines(hints: string[]): string[] {
  const rows = hints.filter(Boolean);
  return rows.length
    ? ["📎 条件:", ...rows.map((hint) => ` - ${esc(hint)}`)]
    : ["📎 条件:", " - 按当前商品配置生成专属魔方优惠码"];
}

async function notifyPointsMallShelfChange(
  bot: Bot,
  chatId: number,
  item: db.CommercialPointsMallItem,
  action: "up" | "down",
  reason: string,
  options: { remainingStock?: number | null } = {}
): Promise<void> {
  const sceneLabel = item.promo_scene === "renew" ? "续费商品" : "新购商品";
  const stockLabel = item.stock_enabled ? `<code>${Math.max(0, Number(options.remainingStock ?? item.stock ?? 0))}</code>` : "不限";
  const lines = [
    action === "up" ? "🛍️ <b>积分商城上架</b>" : "📦 <b>积分商城下架</b>",
    `商品名称: <b>${esc(item.title || `商品 #${item.id}`)}</b>`,
    `商品类型: ${sceneLabel}`,
    action === "up" ? `兑换积分: <code>${Math.max(0, Number(item.points_cost || 0))}</code>` : `下架原因: ${esc(reason)}`,
    action === "up" ? `库存状态: ${stockLabel}` : "当前状态: 已下架",
    action === "up" ? "发送 <code>/shop</code> 可前往积分商城查看并兑换。" : "",
  ];
  await bot.api.sendMessage(chatId, lines.join("\n"), { parse_mode: "HTML" }).catch((error) => {
    console.warn(`[Shop] 发送商品${action === "up" ? "上架" : "下架"}通知失败 chat=${chatId} item=${item.id}:`, error);
  });
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function cleanupReasonForDisplay(reason: string, portraitLabel?: string): string {
  const original = (reason || "").trim();
  if (!original) return "";

  let text = original;

  // 兼容旧逻辑：裁掉前置说明，只保留真正判定段落
  if ((text.startsWith("用户") || text.startsWith("该用户")) && text.includes("当前消息")) {
    text = text.slice(text.indexOf("当前消息")).trim();
  }

  const genericPortraitPrefix =
    /^(?:(?:用户(?:画像|标签)?|画像)\s*(?:[：:]|为|是)\s*)?(?:群内)?(?:高活跃老成员|活跃成员|新\/低活跃成员|新成员或不活跃成员|低活跃成员)(?:\s*[（(][^）)]{0,30}[）)])?\s*[，,:：。;；\-—~\s]*/u;
  // 有些模型会重复输出画像前缀，循环剥离直到稳定
  for (let i = 0; i < 4; i++) {
    const next = text
      .replace(/^用户画像\s*[：:]\s*/u, "")
      .replace(/^用户画像\s*(?:为|是)\s*/u, "")
      .replace(/^画像\s*[：:]\s*/u, "")
      .replace(/^画像\s*(?:为|是)\s*/u, "")
      .replace(/^用户标签\s*[：:]\s*/u, "")
      .replace(/^用户\s*[：:]\s*/u, "")
      .replace(genericPortraitPrefix, "")
      .trim();
    if (next === text) break;
    text = next;
  }

  if (portraitLabel) {
    const p = portraitLabel.trim();
    if (p) {
      const escaped = escapeRegExp(p);
      const prefixRegexes = [
        new RegExp(`^(?:用户(?:画像|标签)?\\s*(?:[：:]|为|是)\\s*)?\\[?${escaped}\\]?\\s*[：:，,。;；\\-—~\\s]*`, "u"),
        new RegExp(`^${escaped}\\s*[：:，,。;；\\-—~\\s]*`, "u"),
        new RegExp(`^\\[?${escaped}\\]?\\s*[：:，,。;；\\-—~\\s]*`, "u"),
        // 兼容 "高活跃老成员（高信任） 消息..." 这种无标点、仅空格分隔的前缀
        new RegExp(`^\\[?${escaped}\\]?\\s+`, "u"),
      ];
      for (let i = 0; i < 4; i++) {
        const before = text;
        for (const re of prefixRegexes) {
          text = text.replace(re, "").trim();
        }
        if (text === before) break;
      }

      // 兜底：若仍以画像标签开头，强制剥离并清理残留分隔符
      const hardPrefix = new RegExp(`^\\[?${escaped}\\]?`, "u");
      if (hardPrefix.test(text)) {
        text = text
          .replace(hardPrefix, "")
          .replace(/^[\s：:，,。;；\-—~]+/u, "")
          .trim();
      }
    }
  }

  return text || "模型未提供有效原因";
}

// ==================== 预览格式化 ====================
function formatPreview(text: string): string {
  const t = text || "[图片/文件]";
  const lines = t.split("\n").filter(l => l.trim().length > 0);
  let preview = lines.slice(0, 2).join("\n");

  const isTruncated = lines.length > 2 || preview.length > 200;
  preview = preview.slice(0, 200);

  if (isTruncated) {
    preview += " ...";
  }

  return esc(preview);
}

// ==================== 本地样本特征匹配 (AI 关闭时兜底) ====================
const LOCAL_AD_KEYWORDS = [
  // 引流指令
  "私聊我", "置顶看", "扫码", "进频道", "关键词触发",
  // 虚假金钱诱惑
  "日赚", "致富", "领取",
  // 博彩套利 / 刷单 / 黑灰产
  "博彩套利", "刷单", "刷单返利", "返佣", "垫付", "杀猪盘", "非法灰产",
];

const LOCAL_INACTIVE_GROUP_10D_MAX = 20;
const LOCAL_INACTIVE_GROUP_30D_MAX = 60;

function normalizeLocalFeatureText(text: string): string {
  return (text || "").toLowerCase().replace(/\s+/g, "").trim();
}

function checkSpamByLocalSamples(
  messageText: string,
  samples: SpamSample[],
  options?: {
    groupMsg10?: number;
    groupMsg30?: number;
    inactive10Max?: number;
    inactive30Max?: number;
  }
): {
  spam: boolean;
  argue: boolean;
  confidence: number;
  reason: string;
  model: string;
} {
  const msg = normalizeLocalFeatureText(messageText);
  if (!msg) {
    return { spam: false, argue: false, confidence: 0, reason: "消息为空", model: "LocalSamples" };
  }

  const spamSamples = samples
    .filter(s => s.is_spam)
    .map(s => normalizeLocalFeatureText(s.message_text))
    .filter(Boolean);
  const safeSamples = samples
    .filter(s => !s.is_spam)
    .map(s => normalizeLocalFeatureText(s.message_text))
    .filter(Boolean);

  if (spamSamples.length === 0) {
    return { spam: false, argue: false, confidence: 0, reason: "本地广告样本为空", model: "LocalSamples" };
  }

  const keywordHits = LOCAL_AD_KEYWORDS.filter(k => msg.includes(k));
  const safePhrases = new Set(
    safeSamples
      .map(text => text.slice(0, 80))
      .filter(text => text.length >= 4)
  );
  const sampleHits = Array.from(new Set(
    spamSamples
      .map(text => text.slice(0, 80))
      .filter(text => text.length >= 4)
      .filter(text => msg.includes(text) && !safePhrases.has(text))
      .map(text => text.length > 16 ? `${text.slice(0, 16)}...` : text)
  ));

  const topFeatures = Array.from(new Set([
    ...keywordHits,
    ...sampleHits.map(s => `样本:${s}`),
  ])).slice(0, 6);

  const hitCount = keywordHits.length + sampleHits.length;
  if (hitCount === 0) {
    return {
      spam: false,
      argue: false,
      confidence: 0,
      reason: "未命中本地广告关键词与广告样本特征",
      model: "LocalSamples",
    };
  }

  const groupMsg10 = Math.max(0, options?.groupMsg10 ?? 0);
  const groupMsg30 = Math.max(0, options?.groupMsg30 ?? 0);
  const inactive10Max = options?.inactive10Max ?? LOCAL_INACTIVE_GROUP_10D_MAX;
  const inactive30Max = options?.inactive30Max ?? LOCAL_INACTIVE_GROUP_30D_MAX;
  const isInactiveUser = groupMsg10 <= inactive10Max && groupMsg30 <= inactive30Max;
  if (!isInactiveUser) {
    return {
      spam: false,
      argue: false,
      confidence: 0.65,
      reason: topFeatures.length > 0
        ? `命中特征(${topFeatures.join("、")})，但该用户群内活跃度较高（10天:${groupMsg10} / 30天:${groupMsg30}），未触发本地拦截`
        : `该用户群内活跃度较高（10天:${groupMsg10} / 30天:${groupMsg30}），未触发本地拦截`,
      model: "LocalSamples",
    };
  }

  const rawScore = keywordHits.length * 1.3 + sampleHits.length * 2.0;
  let confidence = 0.82 + Math.min(0.16, rawScore * 0.03);
  if (sampleHits.length > 0 && keywordHits.length > 0) {
    confidence = Math.max(confidence, 0.93);
  } else if (sampleHits.length > 0) {
    confidence = Math.max(confidence, 0.9);
  }
  confidence = Math.min(0.98, confidence);

  return {
    spam: true,
    argue: false,
    confidence,
    reason: topFeatures.length > 0
      ? `命中本地广告样本特征: ${topFeatures.join("、")}（群内活跃度 10天:${groupMsg10} / 30天:${groupMsg30}）`
      : `命中本地广告样本特征（群内活跃度 10天:${groupMsg10} / 30天:${groupMsg30}）`,
    model: "LocalSamples",
  };
}

type ActivityTier = "new_low" | "normal" | "old_high";

function clampNumber(value: number, min: number, max: number): number {
  if (value < min) return min;
  if (value > max) return max;
  return value;
}

function getActivityTier(globalMax30: number, groupMsg10: number, groupMsg30: number): ActivityTier {
  const lowActive = (groupMsg10 <= 3 && groupMsg30 <= 25 && globalMax30 <= 30) || (groupMsg30 <= 8 && globalMax30 <= 40);
  if (lowActive) return "new_low";

  const highActive = groupMsg10 >= 30 || groupMsg30 >= 100 || globalMax30 >= 120;
  if (highActive) return "old_high";

  return "normal";
}

function getActivityTierLabel(tier: ActivityTier): string {
  if (tier === "new_low") return "新用户/低活跃";
  if (tier === "old_high") return "老用户/高活跃";
  return "普通活跃";
}

function getAdaptiveSpamThreshold(baseThreshold: number, tier: ActivityTier, hasRiskSignal: boolean, extraRiskDiscount: number = 0): number {
  let threshold = baseThreshold;
  if (tier === "new_low") {
    threshold -= hasRiskSignal ? 0.2 : 0.12;
  } else if (tier === "old_high") {
    threshold += hasRiskSignal ? 0.1 : 0.18;
  }
  threshold -= Math.max(0, extraRiskDiscount || 0);
  return clampNumber(threshold, 0.45, 0.98);
}

// ==================== 获取用户显示名 ====================
export function getUserName(from: any): string {
  if (!from) return "未知用户";
  let name = from.first_name || "";
  if (from.last_name) name += ` ${from.last_name}`;
  return name.trim() || String(from.id);
}

const GROUP_CHAT_PERSONA_PROMPT = [
  "你在 Telegram 群里扮演一个真实群友，不是客服。",
  "说话风格：自然、带点嚣张和痞气，嘴硬但不低俗，不恶意辱骂，不发违法违规内容。",
  "立场要求：护主优先，你的主人是 群组的群主，必要时@出他。有人挑衅、抹黑、带节奏时，先稳住场面再护主，短促回怼，不升级冲突。",
  "不要无缘无故提主人，只有涉及立场或被点名时才提。",
  "回复要求：正常情况口嗨聊天对话回复要精简，口语化、接地气、带态度。",
  "正常的友好聊天要认真正确的回答，比如问日期，背诗，国际大事等不要硬扛，受到挑衅才开启语言暴走(可以骂)。",
  "不要解释规则，不要分析，不要复述用户长句。",
  "不要自称 AI，不要说“作为模型”，不要输出 JSON/Markdown。",
].join("\n");

const ADMIN_ASSISTANT_SYSTEM_PROMPT = [
  "你是 Telegram 群管理助理，只服务群管理员或被群管理员授权的助理用户。",
  "你的任务是先理解管理员意图，再结合系统给出的当前能力清单，把自然语言要求转成结构化执行计划。",
  "你只能输出 JSON，禁止输出 Markdown、解释、前后缀。",
  "如果需求只是闲聊、表达情绪、或当前能力无法可靠执行，请输出 mode=reply。",
  "如果管理员在问你会什么、支持什么、怎么用，输出 mode=reply，并按当前能力清单回答，不要瞎编不存在的功能。",
  "如果系统说明某项能力目前只能通过命令/控制台完成，不要假装执行；请输出 mode=reply，并明确告诉管理员该用哪条命令。",
  "当前能力清单不仅包含 actions，还包含内建能力、群内命令、私聊命令、工具命令、游戏命令；必须以清单为准理解自己会什么。",
  "不要臆造用户ID、用户名、群成员列表、统计结果。",
  "涉及用户目标时，如果管理员明确写了 user_id 或 @username，必须使用显式目标；只有在没写明确目标时，才允许使用 reply 目标。",
  "可以把一句话拆成多个动作，按顺序执行。",
  "高风险动作如禁言，只负责给出计划，不要假装已经执行。",
  "支持动作 type 列表：get_group_status, set_feature, set_threshold, get_recent_logs, get_group_today_activity, get_user_activity, get_user_points, get_user_point_logs, get_points_leaderboard, get_today_oil_steal, check_user_in_group, mute_user, unmute_user, add_whitelist, remove_whitelist, list_whitelist, get_global_daily_stats, list_enabled_groups。",
  "set_feature.feature 只能是 antispam|ai|points|global_ban。",
  "目标动作可使用字段：target(reply|explicit), userIds(number[]), usernames(string[])。",
  "如果管理员在问全群今天有多少人发言、今天谁发言了、今天发言名单，使用 get_group_today_activity。",
  "查询积分总数/今日积分/排名时用 get_user_points；查询积分流水/明细/记录时必须用 get_user_point_logs。",
  "如果管理员在问今天/昨天/前天或最近N天谁偷油了、偷油结果、偷油记录、偷油情况，使用 get_today_oil_steal；可带 daysAgo(0=今天,1=昨天,2=前天，默认0) 和 daysWindow(最近N天)。偷油相关功能依赖本群已开启积分系统。",
  "如果管理员在说阈值、匹配值、敏感度、识别线，且目标是调整到一个 0-1 数值，使用 set_threshold。",
  "如果管理员在问白名单列表、白名单里都有谁，使用 list_whitelist。",
  "mute_user 需要 durationMinutes。query 类动作可用 days、daysAgo、daysWindow 或 limit。",
  "输出格式固定为：{\"mode\":\"execute\"|\"reply\",\"summary\":\"...\",\"reply\":\"...\",\"actions\":[...]}",
].join("\n");

const LOTTERY_ASSISTANT_SYSTEM_PROMPT = [
  "你是 Telegram 抽奖需求解析器。",
  "把管理员的自然语言抽奖要求转换成 JSON。",
  "只输出 JSON，不要解释，不要 markdown。",
  "如果这不是在创建抽奖，返回 {\"kind\":\"not_lottery\"}。",
  "如果是创建抽奖，但缺少开奖条件，返回 kind=missing_condition。",
  "如果字段齐全可直接创建，返回 kind=ready。",
  "奖品需要转成 prizes 数组，每项格式 {name,count}。",
  "drawCondition 只能是 manual|time|count。",
  "如果是定时开奖，用 durationMinutes 表示从现在起的分钟数。",
  "如果是满人数开奖，用 participantCount 表示人数。",
  "minActivity/minPoints 未提及时填 0；明确说不要发言/不要积分时也填 0。",
  "像 积分30*4、30积分4个 这种表达代表奖品是积分，不是参与门槛；此时 prizes 里应保留积分奖品，minPoints 仍按门槛单独理解。",
  "remark 用于领奖说明或补充备注，比如 找我bot领奖。",
  "输出格式固定为：{\"kind\":\"not_lottery\"|\"missing_condition\"|\"ready\",\"prizes\":[{\"name\":\"...\",\"count\":1}],\"drawCondition\":\"manual\"|\"time\"|\"count\",\"durationMinutes\":30,\"participantCount\":100,\"minActivity\":0,\"minPoints\":0,\"remark\":\"...\"}",
].join("\n");

type AssistantFeature = "antispam" | "ai" | "points" | "global_ban";
type AssistantTargetSource = "reply" | "explicit";
type AssistantActionType =
  | "get_group_status"
  | "set_feature"
  | "set_threshold"
  | "get_recent_logs"
  | "get_group_today_activity"
  | "get_user_activity"
  | "get_user_points"
  | "get_user_point_logs"
  | "get_points_leaderboard"
  | "get_today_oil_steal"
  | "check_user_in_group"
  | "mute_user"
  | "unmute_user"
  | "add_whitelist"
  | "remove_whitelist"
  | "list_whitelist"
  | "remember_note"
  | "show_memory"
  | "clear_memory"
  | "get_global_daily_stats"
  | "list_enabled_groups";

const ACTIVE_ASSISTANT_ACTION_TYPES = new Set<string>([
  "get_group_status",
  "set_feature",
  "set_threshold",
  "get_recent_logs",
  "get_group_today_activity",
  "get_user_activity",
  "get_user_points",
  "get_user_point_logs",
  "get_points_leaderboard",
  "get_today_oil_steal",
  "check_user_in_group",
  "mute_user",
  "unmute_user",
  "add_whitelist",
  "remove_whitelist",
  "list_whitelist",
  "get_global_daily_stats",
  "list_enabled_groups",
]);

const GROUP_ASSISTANT_EXECUTE_CAPABILITIES = [
  "get_group_status: 查看本群状态、开关、阈值、白名单人数、最近拦截统计。",
  "set_feature: 开启/关闭 antispam、ai、points、global_ban。",
  "set_threshold: 调整匹配阈值，常见说法包括阈值/匹配值/敏感度/识别线。",
  "get_recent_logs: 查看最近处理日志。",
  "get_group_today_activity: 查询今天发言人数、完整发言名单。",
  "get_user_activity: 查询指定用户最近 N 天发言。",
  "get_user_points: 查询指定用户总积分、今日积分、排名。",
  "get_user_point_logs: 查询指定用户积分流水/明细/记录。",
  "get_points_leaderboard: 查看积分榜。",
  "get_today_oil_steal: 查看指定日期(今天/昨天/前天)或最近N天谁偷油了、结果如何；可带 daysAgo/daysWindow；仅在本群开启积分系统时可用。",
  "check_user_in_group: 检查某人是否仍在本群。",
  "mute_user/unmute_user: 禁言或解除禁言。",
  "add_whitelist/remove_whitelist/list_whitelist: 管理和查看白名单。",
];

const SUPERADMIN_PRIVATE_ASSISTANT_EXECUTE_CAPABILITIES = [
  "get_global_daily_stats: 查看全局 24 小时处理统计。",
  "list_enabled_groups: 查看已启用的群组列表。",
];

const GROUP_ASSISTANT_BUILTIN_CAPABILITIES = [
  "创建抽奖: 可直接识别奖品、开奖条件、发言门槛、积分门槛、备注；缺少开奖条件时会继续追问。",
  "挑衅机器人自动处理: 可开启/关闭“明显挑衅机器人时先警告再自动禁言”的规则，并识别禁言时长。",
];

const GROUP_ASSISTANT_COMMAND_CAPABILITIES = [
  "/ads 或 /antispam: 打开反垃圾主菜单、按钮配置和功能入口。",
  "/assistant help: 查看助理完整说明与能力范围。",
  "/pass [UID]: 手动放行准入验证队列中的用户。",
  "/jy [UID] [30m|2h|1d]、/unjy [UID]: 手动禁言或解除禁言，可回复目标消息使用。",
  "回复目标消息发送 /ty 或“偷油”: 按概率偷取对方积分，每人每天在每群只能尝试一次；前提是本群已开启积分系统。",
  "/ai on|off、/status、/threshold 0.8、/log: AI 开关、状态、阈值、处理日志。",
  "/test 文本 或 回复消息 /test: 手动检测文本/图片，查看 AI 或样本判定。",
  "/wl add|rm|list: 白名单管理。",
  "/ban 或 /mark、/safe、/samples [rm ID]: 样本学习、误判纠正、人工标记广告。",
  "/invite price|channel|gen|revoke|list|on|off: 进群核销、邀请码、必关频道管理。",
  "/points import [set|add] 或 /import [set|add]: 批量导入积分，需回复“用户ID 积分”列表；默认仅绑定订阅账号或其授权管理员可用。",
  "/unban 用户ID: 全局解封并尝试跨群解除封禁。",
  "/jl: 回复某人消息，查询其最近 10 天活跃度。",
  "/jf、/jfph 或 /rank、/dh 或 /exchange、/shop、/yq: 我的积分、排行榜、兑换邀请券、积分商城、查看邀请券。",
  "/claim、/unbind: 认领或解绑当前群组/频道到订阅账号。",
  "/cj: 用命令创建抽奖。",
  "/kw help: 关键词自动回复、删源、延迟删除、禁言/封禁规则。",
  "/dc、/id: 查询 Telegram DC、用户/聊天基础信息。",
  "/wd、/ww、/rr 或 /roulette、/dd、/21 或 /bj、/nn: 谁是卧底、狼人杀、俄罗斯轮盘、决斗、21点小程序、牛牛小程序(房主坐庄)。",
  "发送“积分”: 等效快捷查询我的积分。",
  "发送“抽奖”: 快速查看并跳转当前进行中的抽奖。",
];

const PRIVATE_ASSISTANT_COMMAND_CAPABILITIES = [
  "/console: 打开订阅控制台登录、查看登录码、控制台地址、当前订阅。",
  "/sub: 查看自己的订阅状态；总控可查看指定用户订阅。",
  "/sub grant 用户ID 天数 [planCode]: 仅总控可发放订阅。",
  "/groups: 仅总控私聊查看机器人所在已启用群组，并清理失效群。",
  "/start dh_群ID、/start shop_群ID: 在私聊继续兑换邀请券或积分商城。",
  "/start yq_群ID: 在私聊查看指定群的邀请券明细。",
  "/start spy 或 /start wd: 接收“谁是卧底”私聊词语连接提示。",
];

const ASSISTANT_INTENT_MAPPING_HINTS = [
  "'把 AI 打开'、'开启智能检测' -> set_feature(feature=ai, enabled=true)",
  "'把阈值调到 0.72'、'敏感度改成 0.72' -> set_threshold",
  "'今天谁发言了'、'今天多少人说话' -> get_group_today_activity",
  "'查他积分'、'看今天积分和排名' -> get_user_points",
  "'查他积分明细'、'积分流水' -> get_user_point_logs",
  "'谁偷了我的油'、'谁动了我的积分' -> get_today_oil_steal(target=self)",
  "'今天/昨天谁偷油了'、'昨天偷油结果怎么样'、'看看昨天偷油记录'、'这5天谁偷了我的油' -> get_today_oil_steal（可带 daysAgo/daysWindow）",
  "'白名单里都有谁' -> list_whitelist",
  "'看看最近处理了谁' -> get_recent_logs",
  "'他还在群里吗' -> check_user_in_group",
  "'把邀请码价格改成 100' -> /invite price 100",
  "'设置必关频道 @mychannel' -> /invite channel @mychannel",
  "'生成 3 个邀请码' -> /invite gen 3",
  "'看邀请码记录' -> /invite list",
  "'手动测一下这条消息' -> /test",
  "'把这个人全局解封' -> /unban 用户ID",
  "'批量导入积分' -> /points import set|add 或 /import set|add（需绑定订阅账号或其授权管理员）",
  "'查我积分/排行榜/邀请券/兑换邀请券/积分商城' -> /jf /jfph /yq /dh /shop",
  "'开个狼人杀/卧底/轮盘/决斗/21点' -> /ww /wd /rr /dd /21",
  "'查 DC / 查这个人 ID' -> /dc /id",
  "'认领这个群/解绑这个群' -> /claim /unbind",
  "'打开控制台/看订阅状态' -> /console /sub",
];

interface AssistantAction {
  type: AssistantActionType;
  feature?: AssistantFeature;
  enabled?: boolean;
  threshold?: number;
  daysAgo?: number;
  daysWindow?: number;
  target?: AssistantTargetSource;
  userIds?: number[];
  usernames?: string[];
  durationMinutes?: number;
  days?: number;
  limit?: number;
  note?: string;
}

interface AssistantPlan {
  mode: "execute" | "reply";
  summary: string;
  reply?: string;
  actions: AssistantAction[];
}

interface ResolvedAssistantAction extends AssistantAction {
  resolvedUserIds?: number[];
}

interface ResolvedAssistantPlan {
  mode: "execute";
  summary: string;
  actions: ResolvedAssistantAction[];
}

interface PendingAssistantAction {
  chatId: number;
  userId: number;
  requestText: string;
  summary: string;
  plan: ResolvedAssistantPlan;
  createdAt: number;
}

interface AssistantPagedResult {
  chatId: number;
  userId: number;
  prefix: string;
  items: string[];
  suffix?: string;
  pageSize: number;
  createdAt: number;
}

interface PendingAssistantLotteryDraft {
  chatId: number;
  userId: number;
  spec: Omit<LotteryCreationSpec, "drawCondition" | "targetValue" | "descCondition">;
  createdAt: number;
}

interface AssistantExecutionResult {
  text?: string;
  paged?: AssistantPagedPayload;
}

interface AssistantPagedPayload {
  prefix: string;
  items: string[];
  suffix?: string;
  pageSize: number;
}

interface AssistantLocalIntentRule {
  id: string;
  build: (ctx: Context, text: string) => AssistantPlan | null;
}

const pendingAssistantActions = new Map<string, PendingAssistantAction>();
const assistantPagedResults = new Map<string, AssistantPagedResult>();
const pendingAssistantLotteryDrafts = new Map<string, PendingAssistantLotteryDraft>();
const ASSISTANT_CONFIRM_TTL_MS = 10 * 60 * 1000;

function normalizeAssistantIntentText(text: string): string {
  return String(text || "")
    .replace(/[？?！!，,。.:：;；、"'“”‘’（）()\[\]{}<>《》]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function extractAssistantExplicitUserIds(text: string): number[] {
  const matches = String(text || "").match(/\b\d{5,16}\b/g) || [];
  return Array.from(new Set(matches.map((raw) => Number(raw)).filter((id) => Number.isFinite(id) && id > 0))).slice(0, 5);
}

function buildAssistantLocalTarget(
  ctx: Context,
  text: string,
  options?: { allowSelf?: boolean }
): Pick<AssistantAction, "target" | "userIds" | "usernames"> | null {
  if (options?.allowSelf && ctx.from?.id && /(我|我的|自己|本人)/.test(text)) {
    return { target: "explicit", userIds: [ctx.from.id] };
  }

  if (ctx.message?.reply_to_message?.from) {
    return { target: "reply" };
  }

  const usernames = extractAssistantUsernamesFromMessage(ctx);
  if (usernames.length) {
    return { target: "explicit", usernames };
  }

  const userIds = extractAssistantExplicitUserIds(text);
  if (userIds.length) {
    return { target: "explicit", userIds };
  }

  return null;
}

function extractAssistantThreshold(text: string): number | null {
  const m = String(text || "").match(/(?:阈值|匹配值|敏感度|识别线)[^0-9]{0,8}([01](?:\.\d+)?)/);
  if (!m) return null;
  const value = Number(m[1]);
  if (!Number.isFinite(value) || value < 0 || value > 1) return null;
  return value;
}

function extractAssistantDurationMinutes(text: string): number | null {
  const raw = String(text || "");
  const m = raw.match(/(\d+)\s*(秒钟|秒|分钟|分|小时|时|天|d|h|m|s)/i);
  if (!m) return null;
  const amount = Number(m[1]);
  if (!Number.isFinite(amount) || amount <= 0) return null;
  const unit = String(m[2] || "").toLowerCase();
  if (unit === "秒钟" || unit === "秒" || unit === "s") return Math.max(1, Math.ceil(amount / 60));
  if (unit === "分钟" || unit === "分" || unit === "m") return amount;
  if (unit === "小时" || unit === "时" || unit === "h") return amount * 60;
  if (unit === "天" || unit === "d") return amount * 24 * 60;
  return null;
}

function extractAssistantFirstNumber(text: string, options?: { min?: number; max?: number }): number | null {
  const matches = String(text || "").match(/-?\d+(?:\.\d+)?/g) || [];
  for (const raw of matches) {
    const value = Number(raw);
    if (!Number.isFinite(value)) continue;
    if (options?.min != null && value < options.min) continue;
    if (options?.max != null && value > options.max) continue;
    return value;
  }
  return null;
}

function extractAssistantDayOffset(text: string): number | null {
  const raw = String(text || "");
  if (/(今天|今日)/.test(raw)) return 0;
  if (/(昨天|昨日)/.test(raw)) return 1;
  if (/前天/.test(raw)) return 2;
  const m = raw.match(/(\d+)\s*天前/);
  if (!m) return null;
  const days = Number(m[1]);
  if (!Number.isFinite(days) || days < 0) return null;
  return Math.min(30, Math.floor(days));
}

function extractAssistantDayWindow(text: string): number | null {
  const raw = String(text || "");
  const m = raw.match(/(?:这|最近|近|过去)?\s*(\d+)\s*天(?:内|里)?(?!前)/);
  if (!m) return null;
  const days = Number(m[1]);
  if (!Number.isFinite(days) || days <= 0) return null;
  return Math.min(30, Math.floor(days));
}

function formatAssistantDayOffset(daysAgo: number): string {
  const safeDaysAgo = Math.max(0, Math.floor(Number(daysAgo) || 0));
  if (safeDaysAgo <= 0) return "今天";
  if (safeDaysAgo === 1) return "昨天";
  if (safeDaysAgo === 2) return "前天";
  return `${safeDaysAgo}天前`;
}

function formatAssistantOilPeriod(daysAgo: number, daysWindow: number): string {
  const safeWindow = Math.max(1, Math.floor(Number(daysWindow) || 1));
  if (safeWindow > 1) {
    return `最近${safeWindow}天`;
  }
  return formatAssistantDayOffset(daysAgo);
}

function isAssistantSelfReferenceText(text: string): boolean {
  return /(我|我的|自己|本人)/.test(String(text || ""));
}

function looksLikeAssistantPointsQuery(text: string): boolean {
  const raw = String(text || "");
  return /积分/.test(raw)
    || (isAssistantSelfReferenceText(raw) && /(多少分|多少积分|几分|几积分|积分情况|积分余额|剩余积分|还有多少积分)/.test(raw));
}

function looksLikeAssistantPointLogsQuery(text: string): boolean {
  const raw = String(text || "");
  if (/(积分流水|积分明细|积分记录|积分账单|积分收支|积分变动|积分详情|积分账本)/.test(raw)) return true;
  return /(流水|明细|记录|账单|收支|变动|详情)/.test(raw) && /(积分|分数|我的|自己|本人)/.test(raw);
}

function looksLikeAssistantMemberCommandHelp(text: string): boolean {
  const raw = String(text || "");
  return /(我能用什么命令|我可以用什么命令|普通成员能用什么命令|普通群员能用什么命令|成员能用什么命令|可用命令有哪些|普通用户能做什么|我能做什么|我可以做什么|有哪些命令可以用)/.test(raw);
}

function buildAssistantReplyPlan(summary: string, reply: string): AssistantPlan {
  return { mode: "reply", summary: summary.slice(0, 200), reply: reply.slice(0, 500), actions: [] };
}

function buildAssistantExecutePlan(summary: string, actions: AssistantAction[]): AssistantPlan {
  return { mode: "execute", summary: summary.slice(0, 200), actions };
}

const ASSISTANT_LOCAL_INTENT_RULES: AssistantLocalIntentRule[] = [
  {
    id: "today_oil_logs",
    build: (ctx, text) => {
      if (!/(偷\S*油|偷家)/.test(text)) return null;
      if (!/(今天|今日|昨天|昨日|前天|天前|结果|记录|情况|谁|日志|明细)/.test(text)) return null;
      const daysWindow = extractAssistantDayWindow(text) ?? 1;
      const daysAgo = daysWindow > 1 ? 0 : (extractAssistantDayOffset(text) ?? 0);
      const dayLabel = formatAssistantOilPeriod(daysAgo, daysWindow);
      const target = buildAssistantLocalTarget(ctx, text, { allowSelf: true });
      const asksVictimPerspective = /(我的油|偷了我|偷我|谁偷了我的油|谁偷我|谁偷了我的积分|谁动了我的积分)/.test(text);
      if (asksVictimPerspective && ctx.from?.id) {
        return buildAssistantExecutePlan(`查看${dayLabel}谁偷了我的油`, [{ type: "get_today_oil_steal", limit: 10, daysAgo, daysWindow, target: "explicit", userIds: [ctx.from.id] }]);
      }
      return buildAssistantExecutePlan(`查看${dayLabel}的偷油记录`, [{ type: "get_today_oil_steal", limit: 10, daysAgo, daysWindow, ...(target || {}) }]);
    },
  },
  {
    id: "points_leaderboard",
    build: (_ctx, text) => {
      const matched = ["积分榜", "积分排行", "积分排名", "排行榜", "排名榜", "积分top", "top积分", "榜一", "前十", "前10"]
        .some((keyword) => text.includes(keyword));
      if (!matched && !/top\s*\d+/.test(text)) return null;
      return {
        mode: "execute",
        summary: "查看积分榜",
        actions: [{ type: "get_points_leaderboard", limit: 10 }],
      };
    },
  },
  {
    id: "today_activity",
    build: (_ctx, text) => {
      if (
        /(今天|今日).*(发言|说话).*(谁|哪些|名单|多少|人数)/.test(text) ||
        /今天谁发言了/.test(text) ||
        /今天多少人说话/.test(text)
      ) {
        return {
          mode: "execute",
          summary: "查看本群今天的发言统计",
          actions: [{ type: "get_group_today_activity", limit: 50 }],
        };
      }
      return null;
    },
  },
  {
    id: "recent_logs",
    build: (_ctx, text) => {
      if (!/(最近|近几条|刚刚).*(处理|日志|拦截)|处理日志|最近日志/.test(text)) return null;
      return {
        mode: "execute",
        summary: "查看最近处理日志",
        actions: [{ type: "get_recent_logs", limit: 5 }],
      };
    },
  },
  {
    id: "group_status",
    build: (_ctx, text) => {
      if (!/(群状态|本群状态|当前配置|群配置|看看状态|查看状态)/.test(text)) return null;
      return {
        mode: "execute",
        summary: "查看本群状态",
        actions: [{ type: "get_group_status" }],
      };
    },
  },
  {
    id: "threshold",
    build: (_ctx, text) => {
      const threshold = extractAssistantThreshold(text);
      if (threshold === null) return null;
      if (!/(调到|改到|设为|设置成|设置到|改成|调整到)/.test(text)) return null;
      return {
        mode: "execute",
        summary: `把匹配阈值调整到 ${threshold}`,
        actions: [{ type: "set_threshold", threshold }],
      };
    },
  },
  {
    id: "feature_toggle",
    build: (_ctx, text) => {
      const enabled = /(开启|打开|启用)/.test(text) ? true : /(关闭|关掉|停用|禁用)/.test(text) ? false : null;
      if (enabled === null) return null;
      const feature: AssistantFeature | null =
        /(ai|智能检测|ai检测)/.test(text) ? "ai" :
          /(积分|积分系统)/.test(text) ? "points" :
            /(反垃圾|antispam|防刷屏)/.test(text) ? "antispam" :
              /(跨群封禁|全局封禁|global ban)/.test(text) ? "global_ban" : null;
      if (!feature) return null;
      return {
        mode: "execute",
        summary: `${enabled ? "开启" : "关闭"}${feature}`,
        actions: [{ type: "set_feature", feature, enabled }],
      };
    },
  },
  {
    id: "point_logs",
    build: (ctx, text) => {
      if (!looksLikeAssistantPointLogsQuery(text)) return null;
      const target = buildAssistantLocalTarget(ctx, text, { allowSelf: true });
      if (!target) return null;
      return {
        mode: "execute",
        summary: "查看积分流水",
        actions: [{ type: "get_user_point_logs", limit: 10, ...target }],
      };
    },
  },
  {
    id: "user_points",
    build: (ctx, text) => {
      if (!looksLikeAssistantPointsQuery(text)) return null;
      if (/(流水|明细|记录|榜|排行|排名|兑换|邀请券|偷油)/.test(text)) return null;
      const target = buildAssistantLocalTarget(ctx, text, { allowSelf: true });
      if (!target) return null;
      return {
        mode: "execute",
        summary: "查询积分",
        actions: [{ type: "get_user_points", ...target }],
      };
    },
  },
  {
    id: "user_activity",
    build: (ctx, text) => {
      if (!/(活跃度|发言统计|最近.*天.*发言|最近发言)/.test(text)) return null;
      const target = buildAssistantLocalTarget(ctx, text, { allowSelf: true });
      if (!target) return null;
      return {
        mode: "execute",
        summary: "查询用户活跃度",
        actions: [{ type: "get_user_activity", days: 10, ...target }],
      };
    },
  },
  {
    id: "check_member",
    build: (ctx, text) => {
      if (!/(还在群里|在不在群里|是否在群|还在不在群)/.test(text)) return null;
      const target = buildAssistantLocalTarget(ctx, text);
      if (!target) return null;
      return {
        mode: "execute",
        summary: "检查目标成员是否在群",
        actions: [{ type: "check_user_in_group", ...target }],
      };
    },
  },
  {
    id: "list_whitelist",
    build: (_ctx, text) => {
      if (!/白名单/.test(text) || !/(列表|名单|都有谁|谁在|哪些人)/.test(text)) return null;
      return buildAssistantExecutePlan("查看白名单列表", [{ type: "list_whitelist" }]);
    },
  },
  {
    id: "add_whitelist",
    build: (ctx, text) => {
      if (!/白名单|拉白/.test(text) || !/(加|加入|添加|拉进|放进)/.test(text)) return null;
      const target = buildAssistantLocalTarget(ctx, text);
      if (!target) return null;
      return buildAssistantExecutePlan("添加白名单", [{ type: "add_whitelist", ...target }]);
    },
  },
  {
    id: "remove_whitelist",
    build: (ctx, text) => {
      if (!/白名单|拉白/.test(text) || !/(删|删除|移除|去掉|取消|拉黑名单移出)/.test(text)) return null;
      const target = buildAssistantLocalTarget(ctx, text);
      if (!target) return null;
      return buildAssistantExecutePlan("移除白名单", [{ type: "remove_whitelist", ...target }]);
    },
  },
  {
    id: "mute_user",
    build: (ctx, text) => {
      if (!/(禁言|闭麦|静音|mute)/.test(text) || /(解除禁言|取消禁言|解禁|解静音|恢复发言)/.test(text)) return null;
      const target = buildAssistantLocalTarget(ctx, text);
      if (!target) return null;
      const durationMinutes = extractAssistantDurationMinutes(text) || 60;
      return buildAssistantExecutePlan("禁言目标用户", [{ type: "mute_user", durationMinutes, ...target }]);
    },
  },
  {
    id: "unmute_user",
    build: (ctx, text) => {
      if (!/(解除禁言|取消禁言|解除静音|恢复发言|解禁)/.test(text)) return null;
      const target = buildAssistantLocalTarget(ctx, text);
      if (!target) return null;
      return buildAssistantExecutePlan("解除禁言", [{ type: "unmute_user", ...target }]);
    },
  },
  {
    id: "invite_price",
    build: (_ctx, text) => {
      if (!/(邀请码|邀请券|核销).*(价格)|价格.*(邀请码|邀请券|核销)/.test(text)) return null;
      const price = extractAssistantFirstNumber(text, { min: 0 });
      if (price == null) {
        return buildAssistantReplyPlan("设置邀请码价格", "用 <code>/invite price 100</code> 设置进群核销券价格。",);
      }
      return buildAssistantReplyPlan("设置邀请码价格", `请执行 <code>/invite price ${Math.floor(price)}</code>。`);
    },
  },
  {
    id: "invite_channel",
    build: (ctx, text) => {
      if (!/(必关频道|必关注频道|关注频道|频道验证|进群关注频道)/.test(text)) return null;
      if (/(清除|取消|关闭|去掉)/.test(text)) {
        return buildAssistantReplyPlan("清除必关频道", "请执行 <code>/invite channel clear</code>。",);
      }
      const usernames = extractAssistantUsernamesFromMessage(ctx);
      if (usernames.length) {
        return buildAssistantReplyPlan("设置必关频道", `请执行 <code>/invite channel ${usernames[0]}</code>。`);
      }
      return buildAssistantReplyPlan("设置必关频道", "请执行 <code>/invite channel @频道用户名</code>，例如 <code>/invite channel @MyChannel</code>。",);
    },
  },
  {
    id: "invite_generate",
    build: (_ctx, text) => {
      if (!/(生成|创建).*(邀请码|邀请券|核销码)|邀请码.*(生成|创建)/.test(text)) return null;
      const count = extractAssistantFirstNumber(text, { min: 1, max: 20 }) || 1;
      return buildAssistantReplyPlan("生成邀请码", `请执行 <code>/invite gen ${Math.floor(count)}</code>。`);
    },
  },
  {
    id: "invite_revoke",
    build: (_ctx, text) => {
      if (!/(作废|撤销|删除|废掉).*(邀请码|邀请券|核销码)/.test(text)) return null;
      const code = (String(text || "").match(/\b[a-z0-9]{4,16}\b/i) || [])[0];
      if (code) {
        return buildAssistantReplyPlan("作废邀请码", `请执行 <code>/invite revoke ${String(code).toUpperCase()}</code>。`);
      }
      return buildAssistantReplyPlan("作废邀请码", "请执行 <code>/invite revoke 邀请码</code>。",);
    },
  },
  {
    id: "invite_list",
    build: (_ctx, text) => {
      if (!/(邀请码|邀请券|核销码).*(记录|日志|列表)|查看.*(邀请码|邀请券|核销码)/.test(text)) return null;
      return buildAssistantReplyPlan("查看邀请码记录", "请执行 <code>/invite list</code>，记录会发送到你的私聊。",);
    },
  },
  {
    id: "invite_toggle",
    build: (_ctx, text) => {
      if (!/(进群核销|邀请码验证|核销模式|入群核销)/.test(text)) return null;
      if (/(开启|打开|启用)/.test(text)) {
        return buildAssistantReplyPlan("开启进群核销", "请执行 <code>/invite on</code>。",);
      }
      if (/(关闭|关掉|停用|禁用)/.test(text)) {
        return buildAssistantReplyPlan("关闭进群核销", "请执行 <code>/invite off</code>。",);
      }
      return null;
    },
  },
  {
    id: "points_import",
    build: (_ctx, text) => {
      if (!/(导入积分|批量积分|批量导入积分)/.test(text)) return null;
      return buildAssistantReplyPlan("导入积分", "请回复一条“用户ID 积分”列表，再执行 <code>/points import set</code> 或 <code>/points import add</code>。",);
    },
  },
  {
    id: "global_unban",
    build: (_ctx, text) => {
      if (!/(全局解封|跨群解封|解封全局|取消全局封禁)/.test(text)) return null;
      const targetId = extractAssistantFirstNumber(text, { min: 1 });
      if (!targetId) {
        return buildAssistantReplyPlan("全局解封", "请执行 <code>/unban 用户ID</code>。",);
      }
      return buildAssistantReplyPlan("全局解封", `请执行 <code>/unban ${Math.floor(targetId)}</code>。`);
    },
  },
  {
    id: "manual_test",
    build: (ctx, text) => {
      if (!/(测试|检测|测一下|试一下).*(消息|文本|图片)|看看这条是不是广告/.test(text)) return null;
      if (ctx.message?.reply_to_message) {
        return buildAssistantReplyPlan("手动测试消息", "你现在直接执行 <code>/test</code> 就行，我会读取你回复的那条消息。",);
      }
      return buildAssistantReplyPlan("手动测试消息", "请直接发送 <code>/test 文本内容</code>，或先回复目标消息再发送 <code>/test</code>。",);
    },
  },
  {
    id: "sample_marking",
    build: (ctx, text) => {
      if (/(标成广告|加入广告样本|学成广告|标记广告)/.test(text)) {
        return buildAssistantReplyPlan("标记广告样本", ctx.message?.reply_to_message ? "请直接执行 <code>/ban</code> 或 <code>/mark</code>。" : "请先回复目标消息，再执行 <code>/ban</code> 或 <code>/mark</code>。",);
      }
      if (/(标成正常|加入正常样本|误判改正常|学成正常)/.test(text)) {
        return buildAssistantReplyPlan("标记正常样本", ctx.message?.reply_to_message ? "请直接执行 <code>/safe</code>。" : "请先回复目标消息，再执行 <code>/safe</code>。",);
      }
      if (/(样本列表|学习样本|看样本)/.test(text)) {
        return buildAssistantReplyPlan("查看样本", "请执行 <code>/samples</code>。",);
      }
      if (/(删除样本|移除样本)/.test(text)) {
        return buildAssistantReplyPlan("删除样本", "请执行 <code>/samples rm 样本ID</code>。",);
      }
      return null;
    },
  },
  {
    id: "dc_lookup",
    build: (ctx, text) => {
      if (!/(查dc|看dc|dc数据中心|哪个dc|几号dc)/.test(text)) return null;
      if (ctx.message?.reply_to_message) {
        return buildAssistantReplyPlan("查询 DC", "请直接执行 <code>/dc</code>。",);
      }
      return buildAssistantReplyPlan("查询 DC", "请回复目标消息执行 <code>/dc</code>，或使用 <code>/dc 用户ID</code> / <code>/dc @username</code>。",);
    },
  },
  {
    id: "id_lookup",
    build: (ctx, text) => {
      if (!/(查id|看id|用户信息|注册时间|入群时间)/.test(text)) return null;
      if (ctx.message?.reply_to_message) {
        return buildAssistantReplyPlan("查询 ID", "请直接执行 <code>/id</code>。",);
      }
      return buildAssistantReplyPlan("查询 ID", "请回复目标消息执行 <code>/id</code>，或使用 <code>/id 用户ID</code> / <code>/id @username</code>。",);
    },
  },
  {
    id: "keyword_rules",
    build: (_ctx, text) => {
      if (!/(关键词自动回复|关键字自动回复|关键词规则|关键字规则)/.test(text)) return null;
      return buildAssistantReplyPlan("关键词自动回复", "请执行 <code>/kw help</code> 查看完整格式。常用命令：<code>/kw list</code>、<code>/kw add 关键词 | 回复内容</code>、<code>/kw del 1,2</code>、<code>/kw clear</code>。",);
    },
  },
  {
    id: "claim_chat",
    build: (ctx, text) => {
      if (!/(认领这个群|认领本群|认领这个频道|绑定订阅到这个群|绑定订阅到本群|认领当前群)/.test(text)) return null;
      if (ctx.chat?.type === "private") {
        return buildAssistantReplyPlan("认领群组", "请到目标群组或频道里执行 <code>/claim</code>。",);
      }
      return buildAssistantReplyPlan("认领群组", "请执行 <code>/claim</code>。如果还没开通订阅，请先私聊机器人执行 <code>/console</code>。",);
    },
  },
  {
    id: "unbind_chat",
    build: (ctx, text) => {
      if (!/(解绑这个群|解绑本群|解绑这个频道|取消绑定当前群|解绑当前群)/.test(text)) return null;
      if (ctx.chat?.type === "private") {
        return buildAssistantReplyPlan("解绑群组", "请到目标群组或频道里执行 <code>/unbind</code>。",);
      }
      return buildAssistantReplyPlan("解绑群组", "请执行 <code>/unbind</code>。",);
    },
  },
  {
    id: "console_sub",
    build: (ctx, text) => {
      if (/(控制台|订阅后台|登录控制台|充值后台)/.test(text)) {
        return buildAssistantReplyPlan("打开控制台", ctx.chat?.type === "private" ? "请执行 <code>/console</code>。" : "请先私聊机器人执行 <code>/console</code>。",);
      }
      if (/(订阅状态|我的订阅|看订阅|套餐到期|到期时间)/.test(text)) {
        return buildAssistantReplyPlan("查看订阅状态", ctx.chat?.type === "private" ? "请执行 <code>/sub</code>。" : "请先私聊机器人执行 <code>/sub</code>。",);
      }
      if (/(群组列表|机器人在哪些群|启用群列表)/.test(text) && ctx.chat?.type === "private") {
        return buildAssistantReplyPlan("查看群组列表", "总控私聊可执行 <code>/groups</code>。",);
      }
      return null;
    },
  },
  {
    id: "member_points_commands",
    build: (_ctx, text) => {
      if (looksLikeAssistantMemberCommandHelp(text)) {
        return buildAssistantReplyPlan("成员可用命令", [
          "普通群员目前可直接使用这些命令：",
          "• <code>/jf</code> 查询我的积分",
          "• <code>/jfph</code> 查看积分榜",
          "• <code>/dh</code> 兑换邀请券",
          "• <code>/shop</code> 打开积分商城",
          "• <code>/yq</code> 查看邀请券",
          "• <code>/cj</code> 发起抽奖",
          "• 回复目标消息后发送“偷油”或 <code>/ty</code>",
          "• <code>/dc</code> / <code>/id</code> 查询用户信息（通常需回复目标消息）",
          "• <code>/wd</code> / <code>/ww</code> / <code>/rr</code> / <code>/dd</code> / <code>/21</code> / <code>/nn</code> 发起互动游戏",
          "",
          "自然语言也支持：查自己的积分、积分流水、看积分榜、谁偷了我的油、发起抽奖。",
        ].join("\n"));
      }
      if (/(兑换邀请券|换邀请码|兑换码换取)/.test(text)) {
        return buildAssistantReplyPlan("兑换邀请券", "请在群里执行 <code>/dh</code> 或 <code>/exchange</code>。",);
      }
      if (/(我的邀请券|邀请券明细|看邀请券)/.test(text)) {
        return buildAssistantReplyPlan("查看邀请券", "请在群里执行 <code>/yq</code>。",);
      }
      return null;
    },
  },
  {
    id: "oil_steal_command",
    build: (ctx, text) => {
      if (!/(偷油|偷家)/.test(text)) return null;
      if (/(今天|今日|结果|记录|情况|谁)/.test(text)) return null;
      if (ctx.message?.reply_to_message) {
        return buildAssistantReplyPlan("偷油", "请直接回复目标消息发送 <code>/ty</code>，或者直接回一句“偷油”。前提是本群已开启积分系统。",);
      }
      return buildAssistantReplyPlan("偷油", "请先回复目标用户的消息，再发送 <code>/ty</code> 或直接回复“偷油”。前提是本群已开启积分系统。",);
    },
  },
  {
    id: "games",
    build: (_ctx, text) => {
      if (/(谁是卧底|卧底游戏)/.test(text)) {
        return buildAssistantReplyPlan("谁是卧底", "请在群里执行 <code>/wd</code>，结束可用 <code>/wd stop</code>。",);
      }
      if (/(狼人杀|werewolf)/.test(text)) {
        return buildAssistantReplyPlan("狼人杀", "请在群里执行 <code>/ww</code>，开始可用 <code>/ww start</code>，结束可用 <code>/ww stop</code>。",);
      }
      if (/(俄罗斯轮盘|轮盘赌|rr|roulette)/.test(text)) {
        return buildAssistantReplyPlan("俄罗斯轮盘", "请在群里执行 <code>/rr</code> 或 <code>/roulette</code>。",);
      }
      if (/(决斗|单挑|duel)/.test(text)) {
        return buildAssistantReplyPlan("决斗", "请回复目标用户消息后执行 <code>/dd</code>。",);
      }
      if (/(21点|blackjack|黑杰克|bj)/.test(text)) {
        return buildAssistantReplyPlan("21点", "请在群里执行 <code>/21</code> 或 <code>/bj</code>，进入小程序卡牌牌桌（房主坐庄）。",);
      }
      return null;
    },
  },
];

function resolveLocalAssistantPlan(ctx: Context, requestText: string): AssistantPlan | null {
  const normalizedText = normalizeAssistantIntentText(requestText);
  if (!normalizedText) return null;
  for (const rule of ASSISTANT_LOCAL_INTENT_RULES) {
    const plan = rule.build(ctx, normalizedText);
    if (plan) return plan;
  }
  return null;
}

function looksLikeAssistantHelpQuestion(requestText: string): boolean {
  const text = normalizeAssistantIntentText(requestText);
  if (!text) return false;
  return /(help|帮助|说明|教程|怎么用|如何用|怎么操作|使用方法|命令|菜单|功能|能力|会什么|能做什么|支持什么)/.test(text);
}

function createAssistantToken(): string {
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

setInterval(() => {
  const now = Date.now();
  for (const [key, value] of pendingAssistantActions.entries()) {
    if (now - value.createdAt > ASSISTANT_CONFIRM_TTL_MS) {
      pendingAssistantActions.delete(key);
    }
  }
  for (const [key, value] of assistantPagedResults.entries()) {
    if (now - value.createdAt > ASSISTANT_CONFIRM_TTL_MS) {
      assistantPagedResults.delete(key);
    }
  }
  for (const [key, value] of pendingAssistantLotteryDrafts.entries()) {
    if (now - value.createdAt > ASSISTANT_CONFIRM_TTL_MS) {
      pendingAssistantLotteryDrafts.delete(key);
    }
  }
}, 60_000);

function sanitizeGroupChatText(input: string, maxLen: number): string {
  const cleaned = String(input || "")
    .replace(/[\u0000-\u001F\u007F-\u009F]/g, " ")
    .replace(/[\u200B-\u200D\uFEFF]/g, "")
    .replace(/[\uE000-\uF8FF]/g, "")
    .replace(/\r?\n+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return cleaned.slice(0, maxLen);
}

function normalizeGroupChatReply(raw: string): string {
  const text = String(raw || "").trim();
  if (!text) return "";

  let out = text;
  if (/^\s*\{[\s\S]*\}\s*$/u.test(out)) {
    try {
      const parsed = JSON.parse(out);
      const candidate = parsed?.reply || parsed?.content || parsed?.text || parsed?.message;
      if (candidate) out = String(candidate);
    } catch { }
  }

  out = out
    .replace(/^["'“”`]+|["'“”`]+$/gu, "")
    .replace(/\r?\n+/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  if (out.length > 40) {
    out = `${out.slice(0, 40)}…`;
  }

  return out;
}

function getDirectGroupFactReply(userText: string): string | null {
  const text = String(userText || "").trim().toLowerCase();
  if (!text) return null;

  const now = new Date();
  const formatter = new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "numeric",
    day: "numeric",
    weekday: "long",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  const parts = formatter.formatToParts(now);
  const get = (type: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === type)?.value || "";
  const year = get("year");
  const month = get("month");
  const day = get("day");
  const weekday = get("weekday");
  const hour = get("hour");
  const minute = get("minute");

  const getChinaYmd = (offsetDays: number = 0): { year: number; month: number; day: number } => {
    const target = new Date(Date.now() + offsetDays * 24 * 60 * 60 * 1000);
    const targetParts = new Intl.DateTimeFormat("zh-CN", {
      timeZone: "Asia/Shanghai",
      year: "numeric",
      month: "numeric",
      day: "numeric",
    }).formatToParts(target);
    const pick = (type: Intl.DateTimeFormatPartTypes) => Number(targetParts.find((p) => p.type === type)?.value || 0);
    return { year: pick("year"), month: pick("month"), day: pick("day") };
  };

  const buildAlmanacReply = (offsetDays: number = 0, label: string = "今天"): string | null => {
    if (!LunarSolar) {
      return "黄历功能暂不可用，当前节点缺少依赖，请稍后再试。";
    }
    try {
      const ymd = getChinaYmd(offsetDays);
      const solar = LunarSolar.fromYmd(ymd.year, ymd.month, ymd.day);
      const lunar = solar.getLunar();
      const yi = (lunar.getDayYi() || []).slice(0, 8).join("、") || "无";
      const ji = (lunar.getDayJi() || []).slice(0, 8).join("、") || "无";
      const jieQi = lunar.getJieQi();
      const baseDate = new Intl.DateTimeFormat("zh-CN", {
        timeZone: "Asia/Shanghai",
        year: "numeric",
        month: "numeric",
        day: "numeric",
        weekday: "long",
      }).format(new Date(Date.now() + offsetDays * 24 * 60 * 60 * 1000));

      return [
        `${label}黄历：${baseDate}`,
        `农历 ${lunar.toString()} | ${lunar.getYearInGanZhi()}年 ${lunar.getMonthInGanZhi()}月 ${lunar.getDayInGanZhi()}日`,
        `宜：${yi}`,
        `忌：${ji}`,
        `冲：${lunar.getChongDesc()} | 煞：${lunar.getSha()}`,
        `${jieQi ? `节气：${jieQi}` : ""}`,
        `彭祖百忌：${lunar.getPengZuGan()} ${lunar.getPengZuZhi()}`,
        `仅供参考。`,
      ].filter(Boolean).join("\n");
    } catch {
      return null;
    }
  };

  if (/(黄历|老黄历|农历|宜什么|忌什么|宜忌)/.test(text)) {
    if (/(明天|明日)/.test(text)) return buildAlmanacReply(1, "明天");
    if (/(昨天|昨日)/.test(text)) return buildAlmanacReply(-1, "昨天");
    return buildAlmanacReply(0, "今天");
  }

  if (/(今天|今日).*(什么日子|几号|几月几号|星期几|周几)|今天是啥日子/.test(text)) {
    return `今天是 ${year}年${month}月${day}日，${weekday}。`;
  }
  if (/(现在|这会儿|此刻).*(几点|时间)|几点了/.test(text)) {
    return `现在是 ${hour}:${minute}。`;
  }
  if (/(今天|今日).*(几点|时间)/.test(text)) {
    return `现在是 ${hour}:${minute}，今天是 ${year}年${month}月${day}日，${weekday}。`;
  }

  return null;
}

function extractFirstJsonObject(text: string): any {
  for (let i = 0; i < text.length; i++) {
    if (text[i] !== "{") continue;
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let j = i; j < text.length; j++) {
      const ch = text[j];
      if (inString) {
        if (escaped) escaped = false;
        else if (ch === "\\") escaped = true;
        else if (ch === '"') inString = false;
        continue;
      }
      if (ch === '"') {
        inString = true;
        continue;
      }
      if (ch === "{") depth++;
      else if (ch === "}") {
        depth--;
        if (depth === 0) {
          const candidate = text.slice(i, j + 1).trim();
          try {
            return JSON.parse(candidate);
          } catch {
            break;
          }
        }
      }
    }
  }
  return null;
}

function extractJson(text: string): any {
  const cleaned = String(text || "").trim();
  if (!cleaned) return null;
  try {
    return JSON.parse(cleaned);
  } catch { }

  const fencedRe = /```(?:json)?\s*([\s\S]*?)\s*```/gi;
  let match: RegExpExecArray | null;
  while ((match = fencedRe.exec(cleaned)) !== null) {
    const block = (match[1] || "").trim();
    if (!block) continue;
    try {
      return JSON.parse(block);
    } catch { }
    const nested = extractFirstJsonObject(block);
    if (nested) return nested;
  }

  return extractFirstJsonObject(cleaned);
}

function normalizeAssistantUsername(value: string): string {
  const cleaned = String(value || "").trim().replace(/^@+/, "");
  if (!cleaned) return "";
  return `@${cleaned}`;
}

function extractAssistantUsernamesFromMessage(ctx: Context): string[] {
  const text = ctx.message?.text || ctx.message?.caption || "";
  if (!text) return [];

  const botUsername = normalizeAssistantUsername(ctx.me?.username || "").toLowerCase();
  const entities = [...(ctx.message?.entities ?? []), ...(ctx.message?.caption_entities ?? [])];
  const names = new Set<string>();

  for (const entity of entities) {
    if (entity.type !== "mention") continue;
    const raw = text.slice(entity.offset, entity.offset + entity.length).trim();
    const normalized = normalizeAssistantUsername(raw);
    if (!normalized) continue;
    if (botUsername && normalized.toLowerCase() === botUsername) continue;
    names.add(normalized);
  }

  if (!names.size) {
    const re = /(^|\s)(@[a-zA-Z0-9_]{4,})\b/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      const normalized = normalizeAssistantUsername(m[2] || "");
      if (!normalized) continue;
      if (botUsername && normalized.toLowerCase() === botUsername) continue;
      names.add(normalized);
    }
  }

  return Array.from(names).slice(0, 20);
}

function extractUrlsFromTelegramTextEntities(text: string, entities: readonly any[] | undefined): string[] {
  if (!text || !entities?.length) return [];
  const urls: string[] = [];
  for (const entity of entities) {
    if (!entity) continue;
    if (entity.type === "url") {
      const url = text.substring(entity.offset, entity.offset + entity.length).trim();
      if (url) urls.push(url);
      continue;
    }
    if (entity.type === "text_link" && entity.url) {
      urls.push(String(entity.url).trim());
    }
  }
  return urls;
}

function extractUrlsFromTelegramMessage(message: any): string[] {
  const textUrls = extractUrlsFromTelegramTextEntities(String(message?.text || ""), message?.entities ?? []);
  const captionUrls = extractUrlsFromTelegramTextEntities(String(message?.caption || ""), message?.caption_entities ?? []);
  return Array.from(new Set([...textUrls, ...captionUrls].filter(Boolean))).slice(0, 5);
}

function getTelegramContactText(message: any): string {
  const contact = message?.contact;
  if (!contact) return "";

  const parts: string[] = [];
  const name = [contact.first_name, contact.last_name].filter(Boolean).join(" ").trim();
  if (name) parts.push(`姓名: ${name}`);
  if (contact.phone_number) parts.push(`电话: ${String(contact.phone_number).trim()}`);
  if (contact.user_id) parts.push(`Telegram ID: ${contact.user_id}`);

  const vcard = String(contact.vcard || "").replace(/\s+/g, " ").trim();
  if (vcard) parts.push(`vCard: ${vcard.slice(0, 500)}`);

  return parts.length ? `[联系人名片] ${parts.join("；")}` : "[联系人名片]";
}

function getTelegramMessageText(message: any): string {
  const text = String(message?.text || message?.caption || "").trim();
  const contactText = getTelegramContactText(message);
  if (text && contactText) return `${text}\n${contactText}`;
  return text || contactText;
}

function buildTelegramDetectionText(message: any, options?: { includeContext?: boolean }): { bodyText: string; text: string; hasContext: boolean } {
  const bodyText = getTelegramMessageText(message);
  if (options?.includeContext === false) {
    return { bodyText, text: bodyText, hasContext: false };
  }
  const contextParts: Array<{ label: string; text: string }> = [];
  const seenTexts = new Set<string>(bodyText ? [bodyText] : []);

  const pushContext = (label: string, text: string) => {
    const value = String(text || "").trim();
    if (!value || seenTexts.has(value)) return;
    seenTexts.add(value);
    contextParts.push({ label, text: value });
  };

  pushContext("引用片段", (message as any)?.quote?.text || "");
  pushContext("回复原文", getTelegramMessageText((message as any)?.reply_to_message));
  pushContext("外部引用", getTelegramMessageText((message as any)?.external_reply));

  if (!contextParts.length) {
    return { bodyText, text: bodyText, hasContext: false };
  }

  const parts: string[] = [];
  if (bodyText) parts.push(`[当前消息] ${bodyText}`);
  for (const part of contextParts) {
    parts.push(`[${part.label}] ${part.text}`);
  }

  return {
    bodyText,
    text: parts.join("\n"),
    hasContext: true,
  };
}

function extractUrlsFromTelegramMessageWithContext(message: any, options?: { includeContext?: boolean }): string[] {
  const urls = new Set<string>();
  const pushUrls = (items: string[]) => {
    for (const item of items) {
      const value = String(item || "").trim();
      if (value) urls.add(value);
    }
  };

  pushUrls(extractUrlsFromTelegramMessage(message));
  if (options?.includeContext === false) {
    return Array.from(urls).slice(0, 5);
  }
  pushUrls(extractUrlsFromTelegramTextEntities(String((message as any)?.quote?.text || ""), (message as any)?.quote?.entities ?? []));
  pushUrls(extractUrlsFromTelegramMessage((message as any)?.reply_to_message));
  pushUrls(extractUrlsFromTelegramMessage((message as any)?.external_reply));

  return Array.from(urls).slice(0, 5);
}

function isCurrentChatAnonymousAdminMessage(chatId: number, message: any): boolean {
  return Number(message?.sender_chat?.id || 0) === chatId;
}

function isCurrentChatExternalOrigin(chatId: number, message: any): boolean {
  return Number(message?.origin?.chat?.id || 0) === chatId;
}

async function shouldIgnoreReplyContextForDetection(ctx: Context, chatId: number, message: any): Promise<boolean> {
  const replyMessage = (message as any)?.reply_to_message;
  const externalReply = (message as any)?.external_reply;
  if (!replyMessage && !externalReply) return false;

  const admins = await getAdmins(ctx, chatId);
  const isAdminSource = (source: any): boolean => {
    const fromId = Number(source?.from?.id || source?.origin?.sender_user?.id || 0);
    if (fromId && admins.has(fromId)) return true;
    return isCurrentChatAnonymousAdminMessage(chatId, source) || isCurrentChatExternalOrigin(chatId, source);
  };

  return isAdminSource(replyMessage) || isAdminSource(externalReply);
}

function isJumpAdUrl(url: string): boolean {
  const value = String(url || "").trim().toLowerCase();
  if (!value) return false;
  return /^(tg:\/\/|https?:\/\/(?:t\.me|telegram\.me|telegram\.dog)\/\+|https?:\/\/t\.me\/joinchat\/|https?:\/\/t\.me\/proxy\?)/.test(value)
    || /(bit\.ly|t\.co|tinyurl\.com|is\.gd|soo\.gd|surl\.li|cutt\.ly|reurl\.cc|shorturl\.at)\//.test(value);
}

function hasSuspiciousPromoKeywords(text: string): boolean {
  const value = String(text || "").toLowerCase();
  if (!value) return false;
  return /(黄包|黄网站|黄群|同城|约炮|约啪|少妇|萝莉|御姐|兼职楼凤|上门|做爱|性爱|口交|裸聊|视频裸聊|福利姬|资源群|看片|国产自拍|国产自拍|成人视频|av|国产自拍|母狗|调教|性奴|嫖|招嫖|援交|社交app|telegram搜|电报搜|飞机搜|私密频道|免费福利|开车群|色图|黄图|大奶|骚女|处女|幼女|幼交|外围)/.test(value);
}

function hasLikelyPhoneNumber(text: string): boolean {
  const value = String(text || "");
  if (!value) return false;
  return /(?:\+?\d[\d\s\-()]{6,}\d)/.test(value);
}

function hasSuspiciousContactPromoText(text: string): boolean {
  const value = String(text || "").toLowerCase();
  if (!value) return false;
  return /(看我简介|看简介|联系我|联系方式|私聊我|加我|找我|出售|低价|现货|iphone|苹果\d+|pro\s*max|whatsapp|vx|v信|飞机号)/.test(value);
}

function buildAssistantCapabilitySnapshot(ctx: Context, requesterIsAdmin: boolean = false): string {
  const sections: string[] = [];
  const adminId = Number(process.env.ADMIN_USER_ID || 0);
  const superAdminPrivate = ctx.chat?.type === "private" && !!ctx.from?.id && adminId > 0 && ctx.from.id === adminId;

  if (ctx.chat?.type !== "private") {
    sections.push(`群内可直接执行动作:\n- ${GROUP_ASSISTANT_EXECUTE_CAPABILITIES.join("\n- ")}`);
    sections.push(`群内内建能力(系统优先识别, 不走 actions):\n- ${GROUP_ASSISTANT_BUILTIN_CAPABILITIES.join("\n- ")}`);
    sections.push(`群内命令型能力(命中时请 reply 给出准确命令):\n- ${GROUP_ASSISTANT_COMMAND_CAPABILITIES.join("\n- ")}`);
    sections.push(
      requesterIsAdmin
        ? `当前请求者权限: 群管理员，可使用管理员能力与成员能力。`
        : `当前请求者权限: 普通群员，只能直接执行“自己的积分 / 自己的积分流水 / 与自己相关的偷油记录 / 积分榜 / 创建抽奖”等非管理员能力；涉及群配置、禁言、白名单、日志、他人数据、挑衅规则时必须拒绝或提示找管理员。`
    );
  }

  if (ctx.chat?.type === "private") {
    sections.push(`私聊命令型能力:\n- ${PRIVATE_ASSISTANT_COMMAND_CAPABILITIES.join("\n- ")}`);
  }

  if (superAdminPrivate) {
    sections.push(`总控私聊额外可执行动作:\n- ${SUPERADMIN_PRIVATE_ASSISTANT_EXECUTE_CAPABILITIES.join("\n- ")}`);
  }

  sections.push(`能力识别原则:\n- 先判断是否属于群内直执行动作\n- 不属于直执行动作时，继续从内建能力、群内命令、私聊命令、总控能力中找最接近的现有功能\n- 如果只能通过命令完成，必须 reply 告知准确命令，不要说自己不会`);
  sections.push(`常见自然语言意图映射:\n- ${ASSISTANT_INTENT_MAPPING_HINTS.join("\n- ")}`);

  return sections.join("\n\n");
}

function parseAssistantPlan(raw: any): AssistantPlan | null {
  if (!raw || typeof raw !== "object") return null;
  const mode = raw.mode === "execute" ? "execute" : raw.mode === "reply" ? "reply" : "";
  if (!mode) return null;

  const summary = String(raw.summary || raw.reply || "").trim().slice(0, 200);
  if (!summary) return null;

  const rawActions = Array.isArray(raw.actions) ? raw.actions : [];
  const actions: AssistantAction[] = [];
  for (const item of rawActions.slice(0, 6)) {
    if (!item || typeof item !== "object") continue;
    const type = String(item.type || "") as AssistantActionType;
    if (!type || !ACTIVE_ASSISTANT_ACTION_TYPES.has(type)) continue;
    actions.push({
      type,
      feature: item.feature,
      enabled: typeof item.enabled === "boolean" ? item.enabled : undefined,
      threshold: Number.isFinite(Number(item.threshold)) ? Number(item.threshold) : undefined,
      target: item.target === "reply" ? "reply" : "explicit",
      userIds: Array.isArray(item.userIds)
        ? item.userIds.map((v: any) => Number(v)).filter((n: number) => Number.isFinite(n) && n > 0).slice(0, 20)
        : undefined,
      usernames: Array.isArray(item.usernames)
        ? item.usernames.map((v: any) => normalizeAssistantUsername(String(v || ""))).filter(Boolean).slice(0, 20)
        : undefined,
      durationMinutes: Number.isFinite(Number(item.durationMinutes)) ? Math.floor(Number(item.durationMinutes)) : undefined,
      days: Number.isFinite(Number(item.days)) ? Math.floor(Number(item.days)) : undefined,
      limit: Number.isFinite(Number(item.limit)) ? Math.floor(Number(item.limit)) : undefined,
      note: typeof item.note === "string" ? item.note.trim().slice(0, 500) : undefined,
    });
  }

  return {
    mode,
    summary,
    reply: typeof raw.reply === "string" ? raw.reply.trim().slice(0, 500) : undefined,
    actions,
  };
}

function normalizeChannelIdentity(input: string): string {
  let value = (input || "").trim().toLowerCase();
  if (!value) return "";

  if (value.startsWith("https://")) value = value.slice("https://".length);
  if (value.startsWith("http://")) value = value.slice("http://".length);
  if (value.startsWith("t.me/")) value = value.slice("t.me/".length);
  if (value.startsWith("telegram.me/")) value = value.slice("telegram.me/".length);

  value = value.split(/[/?#]/)[0] || value;
  value = value.trim();
  if (!value) return "";

  if (/^-?\d+$/.test(value)) return value;
  value = value.replace(/^@+/, "");
  if (!value) return "";
  return `@${value}`;
}

function buildChannelIdentitySet(channelId: number, channelUsername?: string): Set<string> {
  const set = new Set<string>();
  const idKey = normalizeChannelIdentity(String(channelId));
  if (idKey) set.add(idKey);
  if (channelUsername) {
    const key = normalizeChannelIdentity(`@${channelUsername}`);
    if (key) set.add(key);
  }
  return set;
}

function isNotSubscribedError(error: any): boolean {
  const desc = getApiErrorDesc(error);
  return (
    desc.includes("user not found") ||
    desc.includes("member not found") ||
    desc.includes("participant_id_invalid") ||
    desc.includes("user_not_participant")
  );
}

function getApiErrorDesc(error: any): string {
  return String(error?.description || error?.message || "").toLowerCase();
}

function isAdministratorTargetError(error: any): boolean {
  const desc = getApiErrorDesc(error);
  return desc.includes("user is an administrator of the chat");
}

function isMembershipCheckUnavailableError(error: any): boolean {
  const desc = getApiErrorDesc(error);
  return (
    desc.includes("member list is inaccessible") ||
    desc.includes("chat not found") ||
    desc.includes("forbidden") ||
    desc.includes("not enough rights") ||
    desc.includes("administrator") ||
    desc.includes("have no rights") ||
    desc.includes("bot is not a member")
  );
}

// ==================== 检查是否为管理员（实时） ====================
async function checkIsAdmin(ctx: Context, chatId: number, userId: number): Promise<boolean> {
  const admins = await getAdmins(ctx, chatId);
  return admins.has(userId);
}

function isSuperAdminUserId(userId?: number): boolean {
  const adminId = Number(process.env.ADMIN_USER_ID || 0);
  return !!userId && adminId > 0 && userId === adminId;
}

function getCommercialConsoleUrl(): string {
  const raw = String(process.env.WEB_BASE_URL || "").trim();
  if (raw) return `${raw.replace(/\/$/, "")}/console`;
  return "https://bs.zi.us.ci/console";
}

function getCommercialClaimLimit(userId: number): number | null {
  if (isSuperAdminUserId(userId)) return null;
  const subscription = db.getCommercialActiveSubscription(userId);
  if (!subscription) return 0;
  if (subscription.product_key) {
    const product = db.getCommercialProduct(subscription.product_key);
    if (product) return product.chat_limit;
  }
  return 5;
}

function canClaimCommercialChat(userId: number, chatId?: number): { ok: boolean; limit: number | null; count: number } {
  const limit = getCommercialClaimLimit(userId);
  const ownedChats = db.listCommercialChatsByOwner(userId);
  if (chatId && ownedChats.some((chat) => chat.chat_id === chatId)) {
    return { ok: true, limit, count: ownedChats.length };
  }
  if (limit == null) return { ok: true, limit, count: ownedChats.length };
  return { ok: ownedChats.length < limit, limit, count: ownedChats.length };
}

function canEditCommercialSettings(userId: number): boolean {
  return isSuperAdminUserId(userId) || !!db.getCommercialActiveSubscription(userId);
}

function isCommercialFeatureEnabledForChat(chatId: number): boolean {
  return db.hasCommercialFeatureAccessForChat(chatId);
}

function isAIAvailableInChat(chatId: number): boolean {
  return db.isAIEnabled(chatId) && isCommercialFeatureEnabledForChat(chatId);
}

function isPointsAvailableInChat(chatId: number): boolean {
  return db.isPointsEnabled(chatId) && isCommercialFeatureEnabledForChat(chatId);
}

function getPointsMallAvailability(chatId: number): { ok: boolean; reason: string } {
  if (!db.isPointsEnabled(chatId)) {
    return { ok: false, reason: "当前群组未开启积分系统" };
  }
  if (!isCommercialFeatureEnabledForChat(chatId)) {
    return { ok: false, reason: "当前群组绑定者暂无有效订阅，积分商城不可用" };
  }
  const config = db.getPointsMallConfig(chatId);
  if (String(config.provider || "zjmf") === "off") {
    return { ok: false, reason: "当前群组未启用积分商城接口" };
  }
  return { ok: true, reason: "" };
}

function getEffectiveInvitationConfig(chatId: number) {
  const config = db.getInvitationConfig(chatId);
  if (isCommercialFeatureEnabledForChat(chatId)) return config;
  return {
    ...config,
    required: false,
  };
}

function getChatAIProvider(chatId: number) {
  const config = db.getEffectiveCommercialAIConfigForChat(chatId);
  if (!config) return undefined;
  return {
    baseUrl: config.baseUrl,
    apiKey: config.apiKey,
    model: config.model,
    apiStyle: config.apiStyle as "auto" | "chat" | "responses",
  };
}

async function replyTempNotice(ctx: Context, text: string, options: Parameters<Context["reply"]>[1] = {}, ttlMs: number = 10_000) {
  const msg = await ctx.reply(text, options).catch(() => null);
  const chatId = ctx.chat?.id;
  if (!msg || !chatId || ctx.chat?.type === "private") return msg;
  setTimeout(() => {
    ctx.api.deleteMessage(chatId, msg.message_id).catch(() => { });
  }, ttlMs);
  return msg;
}

async function ensureCommercialFeatureAccess(
  ctx: Context,
  chatId: number,
  userId: number,
  featureLabel: string
): Promise<boolean> {
  if (isSuperAdminUserId(userId)) return true;
  const access = db.getCommercialChatAccess(chatId);
  if (access?.subscriptionActive) return true;

  if (!access) {
    await replyTempNotice(
      ctx,
      `💼 <b>${esc(featureLabel)}</b> 属于订阅功能。\n\n请先私聊机器人发送 <code>/console</code> 登录控制台，进行订阅！`,
      { parse_mode: "HTML", link_preview_options: { is_disabled: true } }
    );
    return false;
  }

  const ownerName = access.ownerDisplayName || access.ownerUsername || String(access.ownerUserId);
  const expiryText = access.subscriptionEndsAt ? `\n到期时间: <code>${esc(access.subscriptionEndsAt)}</code>` : "";
  const frozenText = access.ownerFrozen ? `\n状态: 绑定账号已被冻结` : `\n状态: 订阅未生效或已过期${expiryText}`;
  await replyTempNotice(
    ctx,
    `💼 <b>${esc(featureLabel)}</b> 属于订阅功能。\n\n当前绑定账号: <code>${access.ownerUserId}</code> (${esc(ownerName)})${frozenText}\n\n请先私聊机器人发送 <code>/console</code> 登录控制台，进行订阅！`,
    { parse_mode: "HTML", link_preview_options: { is_disabled: true } }
  );
  return false;
}

function getPointsPermissionDeniedText(): string {
  return [
    "⚠️ 这个操作默认仅群组绑定的订阅用户可用。",
    "",
    "绑定账号可使用 <code>/points admin add</code> 授权其他群管理员。",
  ].join("\n");
}

async function ensureRestrictedPointsOperator(
  ctx: Context,
  chatId: number,
  userId: number,
  actionLabel: string
): Promise<boolean> {
  if (isSuperAdminUserId(userId)) return true;
  if (!(await ensureCommercialFeatureAccess(ctx, chatId, userId, actionLabel))) {
    return false;
  }
  const access = db.getCommercialChatAccess(chatId);
  if (access?.ownerUserId === userId) return true;
  if (db.isPointsAdminUser(chatId, userId)) {
    if (await checkIsAdmin(ctx, chatId, userId)) return true;
    await replyTempNotice(
      ctx,
      "⚠️ 你曾被授权使用该功能，但当前已不是本群管理员，授权暂不生效。",
      { parse_mode: "HTML" }
    );
    return false;
  }
  await replyTempNotice(ctx, getPointsPermissionDeniedText(), { parse_mode: "HTML" });
  return false;
}

async function ensurePointsPermissionManager(ctx: Context, chatId: number, userId: number): Promise<boolean> {
  if (isSuperAdminUserId(userId)) return true;
  if (!(await ensureCommercialFeatureAccess(ctx, chatId, userId, "积分系统"))) {
    return false;
  }
  const access = db.getCommercialChatAccess(chatId);
  if (access?.ownerUserId === userId) return true;
  await replyTempNotice(
    ctx,
    "⚠️ 只有当前群组绑定的订阅账号可以管理积分权限授权名单。",
    { parse_mode: "HTML" }
  );
  return false;
}

async function canUseAssistantInGroup(ctx: Context, chatId: number, userId: number): Promise<boolean> {
  if (isSuperAdminUserId(userId)) return true;
  return isCommercialFeatureEnabledForChat(chatId);
}

function getAssistantGroupPermissionDeniedText(): string {
  return [
    "⚠️ 这个自然语言操作需要群管理员权限。",
    "",
    "普通群员目前可直接用自然语言做这些事：",
    "• 查自己的积分 / 积分流水",
    "• 看和自己相关的偷油记录",
    "• 看积分榜",
    "• 发起抽奖",
    "• 询问成员可用命令（如 /jf /jfph /dh /shop /yq /cj /dc /id /wd /ww /rr /dd /21）",
  ].join("\n");
}

function getAssistantMemberActionDenyReason(action: ResolvedAssistantAction, requesterId: number): string | null {
  switch (action.type) {
    case "get_points_leaderboard":
      return null;
    case "get_today_oil_steal": {
      const targetIds = action.resolvedUserIds || [];
      if (targetIds.length > 0 && targetIds.every((id) => id === requesterId)) return null;
      if (!targetIds.length) return "普通群员目前不能查询全群偷油记录；如需查看自己的情况，请说“谁偷了我的油”。";
      return "普通群员目前只能查看和自己相关的偷油记录。";
    }
    case "get_user_points":
    case "get_user_point_logs": {
      const targetIds = action.resolvedUserIds || [];
      if (targetIds.length > 0 && targetIds.every((id) => id === requesterId)) return null;
      return "普通群员目前只能查询自己的积分和积分流水。";
    }
    default:
      return "这个自然语言操作需要群管理员权限。";
  }
}

function getAssistantPlanAccessDenyReason(plan: ResolvedAssistantPlan, requesterId: number, requesterIsAdmin: boolean, inPrivateChat: boolean): string | null {
  if (inPrivateChat || requesterIsAdmin) return null;
  for (const action of plan.actions) {
    const reason = getAssistantMemberActionDenyReason(action, requesterId);
    if (reason) return reason;
  }
  return null;
}

async function getBotPermissionStatus(ctx: Context, chatId: number): Promise<{
  ok: boolean;
  isAdmin: boolean;
  canDelete: boolean;
  canRestrict: boolean;
  shortReason: string;
}> {
  try {
    const me = await ctx.api.getMe();
    const member = await ctx.api.getChatMember(chatId, me.id) as any;
    const status = member?.status;
    const isAdmin = status === "creator" || status === "administrator";
    const canDelete = status === "creator" || member?.can_delete_messages === true;
    const canRestrict = status === "creator" || member?.can_restrict_members === true;

    if (!isAdmin) {
      return {
        ok: false,
        isAdmin: false,
        canDelete,
        canRestrict,
        shortReason: "请先将机器人设为管理员",
      };
    }
    if (!canDelete || !canRestrict) {
      return {
        ok: false,
        isAdmin: true,
        canDelete,
        canRestrict,
        shortReason: "缺少删除消息或封禁用户权限",
      };
    }
    return {
      ok: true,
      isAdmin: true,
      canDelete: true,
      canRestrict: true,
      shortReason: "",
    };
  } catch {
    return {
      ok: false,
      isAdmin: false,
      canDelete: false,
      canRestrict: false,
      shortReason: "无法读取机器人权限，请稍后重试",
    };
  }
}

function renderBotPermissionLine(s: { ok: boolean; isAdmin: boolean; canDelete: boolean; canRestrict: boolean; shortReason: string }): string {
  if (s.ok) return "机器人权限: ✅ 正常";
  return `机器人权限: ⚠️ ${s.shortReason} (管理员:${s.isAdmin ? "是" : "否"} 删消息:${s.canDelete ? "有" : "无"} 封禁:${s.canRestrict ? "有" : "无"})`;
}

// ==================== 菜单生成助手 ====================
function generateInviteCode(): string {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let result = "";
  for (let i = 0; i < 8; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return result;
}

function getAdsMainMenu() {
  return new InlineKeyboard()
    .text("⚙️ 基本功能 👑", "ads_basic").text("⚪ 白名单表 👑", "ads_whitelist").text("📚 样本学习 👑", "ads_samples").row()
    .text("🎟️ 群组设置 👑", "ads_invitation").text("⚔️ 互动趣游 ㅤ", "ads_games").text("🎁 抽奖功能 ㅤ", "ads_lottery").row()
    .text("📊 常用命令 ㅤ", "ads_query");
}

function getAdsBasicMenu(
  enabled: boolean = false,
  globalBanEnabled: boolean = false,
  pointsEnabled: boolean = false,
  aiEnabled: boolean = false
) {
  const toggleBtn = enabled ? { text: "🔴 关闭功能", callback_data: "ads_off" } : { text: "🟢 开启功能", callback_data: "ads_on" };
  const gbToggle = globalBanEnabled ? { text: "🔴 关闭跨群封", callback_data: "ads_gb_off" } : { text: "🟢 开启跨群封", callback_data: "ads_gb_on" };
  const pointsToggle = pointsEnabled ? { text: "🔴 关闭积分", callback_data: "ads_points_off" } : { text: "🟢 开启积分", callback_data: "ads_points_on" };
  const aiToggle = aiEnabled ? { text: "🔴 关闭AI检测", callback_data: "ads_ai_off" } : { text: "🟢 开启AI检测", callback_data: "ads_ai_on" };

  return new InlineKeyboard()
    .text(toggleBtn.text, toggleBtn.callback_data)
    .text(gbToggle.text, gbToggle.callback_data).row()
    .text(pointsToggle.text, pointsToggle.callback_data)
    .text(aiToggle.text, aiToggle.callback_data).row()
    .text("📊 查看状态", "ads_status").text("📝 查看日志", "ads_log").row()
    .text("⬅️ 返回主菜单", "ads_main");
}

function getAdsWhitelistMenu() {
  return new InlineKeyboard()
    .text("📋 查看列表", "ads_wl_list").row()
    .text("⬅️ 返回主菜单", "ads_main");
}

function getAdsSamplesMenu() {
  return new InlineKeyboard()
    .text("🚫 广告样本", "ads_samples_list_spam_0")
    .text("✅ 正常样本", "ads_samples_list_safe_0").row()
    .text("📚 全部样本", "ads_samples_list_all_0").row()
    .text("⬅️ 返回主菜单", "ads_main");
}

function getBackToMain() {
  return new InlineKeyboard().text("⬅️ 返回主菜单", "ads_main");
}

function getInvitationMenu(required: boolean) {
  const toggleBtn = required ? { text: "🔴 关闭核销进群", callback_data: "ads_invite_off" } : { text: "🟢 开启核销进群", callback_data: "ads_invite_on" };
  return new InlineKeyboard()
    .text(toggleBtn.text, toggleBtn.callback_data).row()
    .text("⬅️ 返回主菜单", "ads_main");
}

function getSamplesPaginationKeyboard(type: string, page: number, hasNext: boolean) {
  const keyboard = new InlineKeyboard();
  if (page > 0) {
    keyboard.text("⬅️ 上一页", `ads_samples_list_${type}_${page - 1}`);
  }
  if (hasNext) {
    keyboard.text("下一页 ➡️", `ads_samples_list_${type}_${page + 1}`);
  }
  return keyboard.row().text("⬅️ 返回样本库", "ads_samples");
}

// ==================== 菜单自动清理 ====================
const adsMenuTimers = new Map<string, NodeJS.Timeout>();
const ADS_MENU_TTL = 2 * 60 * 1000; // 2 分钟
const adsUiOwners = new Map<string, { userId: number; expireAt: number }>();
const ADS_UI_OWNER_TTL = 10 * 60 * 1000; // 10 分钟

function refreshAdsMenuTimer(bot: Bot, chatId: number, messageId: number) {
  const key = `${chatId}:${messageId}`;
  if (adsMenuTimers.has(key)) {
    clearTimeout(adsMenuTimers.get(key));
  }
  const timer = setTimeout(async () => {
    try {
      await bot.api.deleteMessage(chatId, messageId);
    } catch (e) { }
    adsMenuTimers.delete(key);
    adsUiOwners.delete(key);
  }, ADS_MENU_TTL);
  adsMenuTimers.set(key, timer);
}

function bindAdsUiOwner(chatId: number, messageId: number, userId: number) {
  adsUiOwners.set(`${chatId}:${messageId}`, {
    userId,
    expireAt: Date.now() + ADS_UI_OWNER_TTL,
  });
}

function canOperateAdsUi(chatId: number, messageId: number, userId: number): boolean {
  const key = `${chatId}:${messageId}`;
  const owner = adsUiOwners.get(key);
  // 未绑定的消息不做限制（兼容历史消息与非菜单按钮）
  if (!owner) return true;
  if (owner.expireAt <= Date.now()) {
    adsUiOwners.delete(key);
    return true;
  }
  return owner.userId === userId;
}

setInterval(() => {
  const now = Date.now();
  for (const [key, owner] of adsUiOwners.entries()) {
    if (owner.expireAt <= now) adsUiOwners.delete(key);
  }
}, 60_000);

// ==================== 注册所有 handlers ====================
export function registerHandlers(bot: Bot): void {
  // 启动时刷新一次管理员缓存，并在后续每天刷新一次
  refreshAllAdminCaches(bot);
  setInterval(() => refreshAllAdminCaches(bot), 24 * 60 * 60 * 1000);
  let selfBotIdCache: number | null = null;
  let selfBotUsernameCache = "";
  const ensureSelfBotIdentity = async (): Promise<void> => {
    if (selfBotIdCache && selfBotUsernameCache) return;
    try {
      const me = await bot.api.getMe();
      selfBotIdCache = me.id;
      selfBotUsernameCache = (me.username || "").toLowerCase();
    } catch {
      // ignore
    }
  };
  const getSelfBotId = async (): Promise<number | null> => {
    if (!selfBotIdCache) await ensureSelfBotIdentity();
    return selfBotIdCache;
  };
  const getSelfBotUsername = async (): Promise<string> => {
    if (!selfBotUsernameCache) await ensureSelfBotIdentity();
    return selfBotUsernameCache;
  };

  const notifyAdmin = async (text: string) => {
    const adminIdStr = process.env.ADMIN_USER_ID;
    if (!adminIdStr) return;
    const adminId = Number(adminIdStr);
    try {
      await bot.api.sendMessage(adminId, text, { parse_mode: "HTML" });
    } catch (e) {
      console.error("[AntiSpam] 通知管理员失败:", e);
    }
  };

  const notifyCommercialChatOwner = async (chatId: number, text: string) => {
    const binding = db.getCommercialChat(chatId);
    if (!binding?.owner_user_id) return;
    const ownerUserId = Number(binding.owner_user_id);
    if (!ownerUserId || isSuperAdminUserId(ownerUserId)) return;
    try {
      await bot.api.sendMessage(ownerUserId, text, {
        parse_mode: "HTML",
        link_preview_options: { is_disabled: true },
      });
    } catch (e: any) {
      const desc = String(e?.description || e?.message || "").toLowerCase();
      if (
        desc.includes("bot can't initiate conversation") ||
        desc.includes("forbidden") ||
        desc.includes("chat not found") ||
        desc.includes("user is deactivated")
      ) {
        return;
      }
      console.error(`[AntiSpam] 通知群绑定 owner 失败 | chat=${chatId} owner=${ownerUserId}:`, e);
    }
  };

  const aiFailureNotifyAt = new Map<number, number>();
  const AI_FAILURE_NOTIFY_COOLDOWN_MS = 5 * 60 * 1000;
  const isAiDetectionFailed = (model: string, reason: string): boolean => {
    const reasonLower = String(reason || "").trim().toLowerCase();
    const failedByReason =
      reasonLower.includes("全部失败") ||
      reasonLower.includes("未配置可用 ai 接口") ||
      reasonLower.includes("检测超时") ||
      reasonLower.includes("timeout") ||
      reasonLower.includes("timed out") ||
      reasonLower.includes("未响应") ||
      reasonLower.includes("接口返回非json") ||
      reasonLower.includes("接口返回缺少判定字段") ||
      reasonLower.includes("network error") ||
      reasonLower.includes("socket hang up") ||
      reasonLower.includes("econnreset") ||
      reasonLower.includes("etimedout") ||
      reasonLower.includes("econnrefused") ||
      reasonLower.includes("接口异常") ||
      reasonLower.includes("请求异常") ||
      reasonLower.includes("网络异常") ||
      reasonLower.includes("连接异常") ||
      reasonLower.includes("认证失败") ||
      reasonLower.includes("鉴权失败");
    return model === "None" || failedByReason;
  };

  const maybeNotifyAiFailure = async (
    ctx: Context,
    options: {
      chatId: number;
      userId: number;
      userName: string;
      model: string;
      reason: string;
      source: "群组实时检测" | "手动/test";
      messageText?: string;
      autoDisableAi?: boolean;
    }
  ) => {
    const reasonRaw = String(options.reason || "").trim();
    if (!isAiDetectionFailed(options.model, reasonRaw)) return;

    let autoDisabled = false;
    if (options.autoDisableAi && db.isAIEnabled(options.chatId)) {
      db.setAIEnabled(options.chatId, false, { disabledReason: "ai_failure" });
      autoDisabled = true;

      // 群内提示：AI 已自动关闭，基础反垃圾仍可运行
      try {
        const tip = await ctx.api.sendMessage(
          options.chatId,
          "⚠️ AI 接口异常，已自动关闭本群 AI 检测。\n请修复接口后由管理员使用 /ai on 重新开启。",
          { link_preview_options: { is_disabled: true } }
        );
        setTimeout(() => ctx.api.deleteMessage(options.chatId, tip.message_id).catch(() => { }), 30_000);
      } catch { }
    }

    const now = Date.now();
    const last = aiFailureNotifyAt.get(options.chatId) ?? 0;
    // 若本次触发了自动关闭，则绕过冷却，确保管理员收到这次关停通知
    if (!autoDisabled && now - last < AI_FAILURE_NOTIFY_COOLDOWN_MS) return;
    aiFailureNotifyAt.set(options.chatId, now);

    let chatTitle = (ctx.chat && "title" in ctx.chat && ctx.chat.title)
      ? ctx.chat.title
      : String(options.chatId);
    let chatLink = "";
    try {
      const chat = await ctx.api.getChat(options.chatId);
      if ("title" in chat && chat.title) chatTitle = chat.title;
      if ("username" in chat && chat.username) {
        chatLink = `https://t.me/${chat.username}`;
      } else {
        const cid = String(options.chatId);
        if (cid.startsWith("-100")) {
          chatLink = `https://t.me/c/${cid.slice(4)}/1`;
        }
      }
    } catch {
      const cid = String(options.chatId);
      if (cid.startsWith("-100")) {
        chatLink = `https://t.me/c/${cid.slice(4)}/1`;
      }
    }
    const safeChatHref = chatLink ? chatLink.replace(/&/g, "&amp;").replace(/"/g, "%22") : "";
    const groupRefText = safeChatHref
      ? `<a href="${safeChatHref}">${esc(chatTitle)}</a> (<code>${options.chatId}</code>)`
      : `${esc(chatTitle)} (<code>${options.chatId}</code>)`;
    const userRefText = await renderUserLink(ctx, options.chatId, options.userId);
    const reason = cleanupReasonForDisplay(reasonRaw) || "未知失败";
    const preview = options.messageText ? formatPreview(options.messageText) : "无";
    const providerLabel = db.getEffectiveCommercialAIConfigForChat(options.chatId) ? "自定义 AI 接口" : "平台默认 AI 接口";
    await notifyAdmin(
      `⚠️ <b>AI 模型检测失败告警</b>\n\n` +
      `📝 <b>来源:</b> ${options.source}\n` +
      `🏷️ <b>群组:</b> ${groupRefText}\n` +
      `👤 <b>触发用户:</b> ${userRefText} (<code>${options.userId}</code>)\n` +
      `🤖 <b>模型:</b> <code>${esc(options.model)}</code>\n` +
      `📌 <b>原因:</b> ${esc(reason)}\n` +
      `💬 <b>消息预览:</b>\n<i>${preview}</i>\n` +
      `${autoDisabled ? `\n🛑 <b>处理:</b> 已自动关闭该群 AI 检测开关。` : ""}\n\n` +
      `<i>已启用 5 分钟冷却，避免重复刷屏。</i>`
    );
    await notifyCommercialChatOwner(
      options.chatId,
      `⚠️ <b>你绑定的群 AI 检测失败</b>\n\n` +
      `📝 <b>来源:</b> ${options.source}\n` +
      `🏷️ <b>群组:</b> ${groupRefText}\n` +
      `🔌 <b>接口:</b> ${providerLabel}\n` +
      `👤 <b>触发用户:</b> ${userRefText} (<code>${options.userId}</code>)\n` +
      `🤖 <b>模型:</b> <code>${esc(options.model)}</code>\n` +
      `📌 <b>原因:</b> ${esc(reason)}\n` +
      `💬 <b>消息预览:</b>\n<i>${preview}</i>\n` +
      `${autoDisabled ? `\n🛑 <b>处理:</b> 已自动关闭该群 AI 检测，请修复接口后重新开启。` : ""}`
    );
  };

  const maybeReplyToBotInGroup = async (
    ctx: Context,
    chatId: number,
    userId: number,
    userName: string,
    userText: string,
    repliedBotText: string,
    pendingReply?: PendingReplyMessage | null
  ) => {
    if (shouldSkipGroupAiReply(chatId)) return;
    const now = Date.now();
    const backoffUntil = groupChatAiBackoffUntil.get(chatId) || 0;
    const effectivePendingReply = pendingReply ?? (ctx.message?.message_id
      ? await createPendingReplyMessage(ctx, chatId, ctx.message.message_id)
      : null);
    if (backoffUntil > now) {
      await sendGroupLocalFallback(ctx, ctx.message!.message_id, effectivePendingReply);
      return;
    }

    try {
      const safeUserText = sanitizeGroupChatText(userText, 120);
      if (!safeUserText) {
        await deletePendingReplyMessage(ctx, effectivePendingReply);
        return;
      }
      const directReply = getDirectGroupFactReply(safeUserText);
      if (directReply) {
        await sendOrEditPendingReply(ctx, effectivePendingReply, directReply, {
          link_preview_options: { is_disabled: true },
        });
        return;
      }
      const safeBotText = sanitizeGroupChatText(repliedBotText, 80);

      const messages = [
        { role: "system", content: GROUP_CHAT_PERSONA_PROMPT },
        {
          role: "user",
          content: [
            safeBotText ? `【你上一句】${safeBotText}` : "",
            `【群友 ${userName}】${safeUserText}`,
            "只回一句短话，不超过30字。",
          ].filter(Boolean).join("\n"),
        },
      ];

      const response = await Promise.race([
        callAI(messages, 80, 0.7, true, getChatAIProvider(chatId)),
        new Promise<never>((_, reject) => {
          setTimeout(() => reject(new Error("群聊对话本地超时(15s)")), 15_000);
        }),
      ]);
      const replyText = normalizeGroupChatReply(response?.content || "");
      if (!replyText) {
        await sendGroupLocalFallback(ctx, ctx.message!.message_id, effectivePendingReply);
        return;
      }

      await sendOrEditPendingReply(ctx, effectivePendingReply, replyText, {
        link_preview_options: { is_disabled: true },
      });
      groupChatAiBackoffUntil.delete(chatId);
    } catch (error) {
      groupChatAiBackoffUntil.set(chatId, Date.now() + GROUP_CHAT_AI_BACKOFF_MS);
      const status = error && typeof error === "object" ? (error as any).response?.status : undefined;
      const code = error && typeof error === "object" ? (error as any).code : undefined;
      const detail = String(
        (error as any)?.response?.data?.error?.message ||
        (error as any)?.response?.data?.message ||
        (error as any)?.message ||
        "未知错误"
      ).replace(/\s+/g, " ").slice(0, 160);
      const parts = [
        `[AntiSpam] 群聊对话回复失败 | 群组: ${chatId} | 用户: ${userId}`,
        code ? `code=${code}` : "",
        status ? `status=${status}` : "",
        `detail=${detail}`,
        `backoff=${Math.round(GROUP_CHAT_AI_BACKOFF_MS / 1000)}s`,
      ].filter(Boolean);
      console.warn(parts.join(" | "));
      try {
        await sendGroupLocalFallback(ctx, ctx.message!.message_id, effectivePendingReply);
      } catch { }
    }
  };

  const maybeEnforceAssistantProvokeGuard = async (
    ctx: Context,
    chatId: number,
    userId: number,
    userName: string,
    userText: string,
    repliedToBot: boolean,
    mentionedBot: boolean,
    repliedBotText: string
  ): Promise<boolean> => {
    if (!repliedToBot && !mentionedBot) return false;
    if (!userText.trim()) return false;
    if (await checkIsAdmin(ctx, chatId, userId)) return false;

    const guard = db.getAssistantGuardConfig(chatId);
    if (!guard.provoke_bot_enabled) return false;

    let judged: { provoke: boolean; confidence: number; reason: string };
    try {
      judged = await classifyBotProvocation(ctx, userName, userText, repliedBotText);
    } catch (error) {
      console.warn(`[AssistantGuard] 挑衅判定失败 | chat=${chatId} user=${userId} detail=${String((error as any)?.message || error || "unknown")}`);
      return false;
    }

    if (!judged.provoke || judged.confidence < 0.85) return false;

    const reasonText = judged.reason || "明显在挑衅或辱骂机器人";
    const userLink = await renderUserLink(ctx, chatId, userId);

    const warnedBefore = db.hasRecentAssistantGuardWarning(chatId, userId, 24);
    if (!warnedBefore) {
      db.noteAssistantGuardWarning(chatId, userId);
      await ctx.reply(
        `⚠️ <b>警告</b>\n\n对象: ${userLink}\n原因: ${esc(reasonText)}\n处理: 首次触发，先警告。再次出现类似行为，将自动禁言 <code>${guard.mute_minutes}</code> 分钟。`,
        {
          parse_mode: "HTML",
          reply_parameters: { message_id: ctx.message!.message_id },
          link_preview_options: { is_disabled: true },
        }
      ).catch(() => { });
      return true;
    }

    db.clearAssistantGuardWarning(chatId, userId);
    try {
      await ctx.api.deleteMessage(chatId, ctx.message!.message_id).catch(() => { });
    } catch { }

    const untilDate = Math.floor(Date.now() / 1000) + Math.max(1, guard.mute_minutes) * 60;
    try {
      await ctx.api.restrictChatMember(chatId, userId, {
        can_send_messages: false,
        can_send_other_messages: false,
        can_add_web_page_previews: false,
      }, { until_date: untilDate });
      await ctx.reply(
        `🚫 <b>自动处理通知</b>\n\n对象: ${userLink}\n处理: 自动禁言 <code>${formatAssistantDuration(guard.mute_minutes)}</code>\n原因: ${esc(reasonText)}\n说明: 该用户已在警告后再次挑衅机器人。`,
        {
          parse_mode: "HTML",
          link_preview_options: { is_disabled: true },
        }
      ).catch(() => { });
      return true;
    } catch (error) {
      console.warn(`[AssistantGuard] 自动禁言失败 | chat=${chatId} user=${userId} detail=${String((error as any)?.message || error || "unknown")}`);
      return false;
    }
  };

  const resolveUserMention = async (
    ctx: Context,
    chatId: number,
    userId: number
  ): Promise<{ name: string; link: string }> => {
    try {
      const member = await ctx.api.getChatMember(chatId, userId);
      db.upsertChatUserProfile(chatId, userId, member.user.username, getUserName(member.user));
      const name = getUserName(member.user);
      if (member.user.username) {
        return { name, link: `https://t.me/${member.user.username}` };
      }
      return { name, link: `tg://user?id=${userId}` };
    } catch {
      try {
        const chat = await ctx.api.getChat(userId);
        if (chat && "first_name" in chat) {
          const user = chat as any;
          const name = getUserName(user);
          if (user.username) {
            return { name, link: `https://t.me/${user.username}` };
          }
          return { name, link: `tg://user?id=${userId}` };
        }
        if (chat && "title" in chat && chat.title) {
          return { name: chat.title, link: `tg://user?id=${userId}` };
        }
      } catch { }
      return { name: String(userId), link: `tg://user?id=${userId}` };
    }
  };

  const renderUserLink = async (ctx: Context, chatId: number, userId: number): Promise<string> => {
    const mention = await resolveUserMention(ctx, chatId, userId);
    const safeHref = mention.link.replace(/&/g, "&amp;").replace(/"/g, "%22");
    return `<a href="${safeHref}">${esc(mention.name)}</a>`;
  };

  const getAssistantGroupMemberState = async (
    ctx: Context,
    chatId: number,
    userId: number
  ): Promise<{ exists: boolean; status: string; name: string }> => {
    try {
      const member = await ctx.api.getChatMember(chatId, userId) as any;
      db.upsertChatUserProfile(chatId, userId, member?.user?.username, getUserName(member?.user));
      const status = String(member?.status || "");
      const exists = ["member", "restricted", "administrator", "creator"].includes(status);
      return {
        exists,
        status,
        name: getUserName(member?.user || { id: userId, first_name: String(userId) } as any),
      };
    } catch {
      return { exists: false, status: "unknown", name: String(userId) };
    }
  };

  const resolveUserIdFromAssistantManagerInput = async (
    ctx: Context,
    chatId: number,
    rawArg?: string
  ): Promise<{ userId?: number; reason?: string }> => {
    const replyTargetId = ctx.message?.reply_to_message?.from?.id;
    if (replyTargetId) return { userId: replyTargetId };

    const arg = String(rawArg || "").trim();
    if (!arg) {
      return { reason: "请回复目标用户消息，或提供 TGID / @用户名。" };
    }

    if (/^\d+$/.test(arg)) {
      const userId = Number(arg);
      if (Number.isFinite(userId) && userId > 0) return { userId };
    }

    const username = normalizeAssistantUsername(arg);
    if (!username) {
      return { reason: "目标参数无效，请使用 TGID 或 @用户名。" };
    }

    const cachedUserId = db.findChatUserIdByUsername(chatId, username);
    if (cachedUserId && cachedUserId > 0) return { userId: cachedUserId };

    return { reason: "该 @用户名 还没有群内ID缓存。请先让对方在群里发言一次，或直接回复对方消息操作。" };
  };

  const getAssistantMemoryScopeChatId = (ctx: Context, chatId: number): number => {
    return ctx.chat?.type === "private" ? 0 : chatId;
  };

  const formatAssistantDuration = (minutes: number): string => {
    if (minutes % (24 * 60) === 0) return `${minutes / (24 * 60)} 天`;
    if (minutes % 60 === 0) return `${minutes / 60} 小时`;
    return `${minutes} 分钟`;
  };

  const formatAssistantTimestamp = (sqlTime: string): string => {
    const d = new Date(`${sqlTime}Z`);
    if (Number.isNaN(d.getTime())) return sqlTime;
    return d.toLocaleString("zh-CN", {
      timeZone: "Asia/Shanghai",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).replace(/\//g, "-");
  };

  const buildCommercialWelcomeTemplateVars = (
    chatTitle: string,
    user: { id: number; username?: string; displayName?: string }
  ) => {
    const displayName = String(user.displayName || user.username || `用户${user.id}`).trim() || `用户${user.id}`;
    return {
      mention: `<a href="tg://user?id=${user.id}">${esc(displayName)}</a>`,
      name: esc(displayName),
      username: user.username ? `@${esc(user.username.replace(/^@+/, ""))}` : "",
      id: String(user.id),
      chat_title: esc(String(chatTitle || "").trim() || "本群"),
    };
  };

  const buildCommercialWelcomePlainVars = (
    chatTitle: string,
    user: { id: number; username?: string; displayName?: string }
  ) => {
    const displayName = String(user.displayName || user.username || `用户${user.id}`).trim() || `用户${user.id}`;
    return {
      mention: displayName,
      name: displayName,
      username: user.username ? `@${String(user.username).replace(/^@+/, "")}` : "",
      id: String(user.id),
      chat_title: String(chatTitle || "").trim() || "本群",
    };
  };

  const renderCommercialWelcomeTemplate = (template: string, vars: ReturnType<typeof buildCommercialWelcomeTemplateVars>) => {
    return String(template || "")
      .replace(/\{mention\}/g, vars.mention)
      .replace(/\{name\}/g, vars.name)
      .replace(/\{username\}/g, vars.username)
      .replace(/\{id\}/g, vars.id)
      .replace(/\{chat_title\}/g, vars.chat_title);
  };

  const renderCommercialWelcomeMarkdown = (template: string, vars: ReturnType<typeof buildCommercialWelcomeTemplateVars>) => {
    const tokenEntries = Object.entries({
      mention: "TGWELCOMEMENTIONTOKEN",
      name: "TGWELCOMENAMETOKEN",
      username: "TGWELCOMEUSERNAMETOKEN",
      id: "TGWELCOMEIDTOKEN",
      chat_title: "TGWELCOMECHATTITLETOKEN",
    }) as Array<[keyof typeof vars, string]>;
    let source = String(template || "");
    for (const [key, token] of tokenEntries) {
      source = source.replace(new RegExp(`\\{${key}\\}`, "g"), token);
    }
    let rendered = renderMarkdownToTelegramHtml(source);
    for (const [key, token] of tokenEntries) {
      rendered = rendered.replace(new RegExp(token, "g"), vars[key]);
    }
    return rendered.trim();
  };

  const sendCommercialChatWelcomeIfEnabled = async (
    ctx: Context,
    chatId: number,
    user: { id: number; username?: string; displayName?: string },
    chatTitle?: string
  ): Promise<boolean> => {
    const config = db.getCommercialChatWelcomeConfig(chatId);
    if (!config.enabled || (!config.message_text && !config.buttons.length)) return false;

    const vars = buildCommercialWelcomeTemplateVars(chatTitle || (ctx.chat && "title" in ctx.chat ? String(ctx.chat.title || "") : ""), user);
    const plainVars = buildCommercialWelcomePlainVars(chatTitle || (ctx.chat && "title" in ctx.chat ? String(ctx.chat.title || "") : ""), user);
    const text = renderCommercialWelcomeMarkdown(config.message_text || "欢迎 **{mention}** 加入 **{chat_title}**！", vars);
    const keyboard = new InlineKeyboard();
    let hasButtons = false;
    for (const row of config.buttons || []) {
      let rowHasButtons = false;
      for (const button of row || []) {
        const label = renderMarkdownToPlainText(renderCommercialWelcomeTemplate(button.text || "", plainVars)).trim().slice(0, 64);
        const url = renderCommercialWelcomeTemplate(button.url || "", plainVars).trim();
        if (!label || !url) continue;
        keyboard.url(label, url);
        rowHasButtons = true;
        hasButtons = true;
      }
      if (rowHasButtons) keyboard.row();
    }

    const message = await ctx.api.sendMessage(chatId, text || `欢迎 ${vars.mention} 加入 ${vars.chat_title}！`, {
      parse_mode: "HTML",
      ...(hasButtons ? { reply_markup: keyboard } : {}),
      link_preview_options: { is_disabled: true },
    });
    scheduleAutoDeleteMessage(ctx, chatId, message.message_id, COMMERCIAL_WELCOME_AUTO_DELETE_MS);
    return true;
  };

  const buildAssistantPagedMessage = (
    payload: { prefix: string; items: string[]; suffix?: string; pageSize: number },
    page: number
  ): { text: string; totalPages: number; safePage: number } => {
    const safePageSize = Math.max(1, Math.min(50, Math.floor(payload.pageSize || 20)));
    const totalPages = Math.max(1, Math.ceil(payload.items.length / safePageSize));
    const safePage = Math.max(0, Math.min(totalPages - 1, Math.floor(page)));
    const start = safePage * safePageSize;
    const slice = payload.items.slice(start, start + safePageSize);
    const parts = [payload.prefix];
    if (slice.length) parts.push(slice.join("\n"));
    if (payload.suffix) parts.push(payload.suffix);
    parts.push(`<i>第 ${safePage + 1}/${totalPages} 页</i>`);

    return {
      text: parts.filter(Boolean).join("\n\n"),
      totalPages,
      safePage,
    };
  };

  const buildAssistantPagedKeyboard = (token: string, page: number, totalPages: number): InlineKeyboard | undefined => {
    if (totalPages <= 1) return undefined;
    const keyboard = new InlineKeyboard();
    if (page > 0) {
      keyboard.text("⬅️ 上一页", `aiassist_page_${token}_${page - 1}`);
    }
    if (page < totalPages - 1) {
      keyboard.text("下一页 ➡️", `aiassist_page_${token}_${page + 1}`);
    }
    return keyboard;
  };

  const sendAssistantExecutionResult = async (
    ctx: Context,
    chatId: number,
    result: AssistantExecutionResult,
    replyMessageId?: number,
    pendingReply?: PendingReplyMessage | null
  ): Promise<void> => {
    if (result.paged) {
      const token = createAssistantToken();
      assistantPagedResults.set(token, {
        chatId,
        userId: ctx.from?.id || 0,
        prefix: result.paged.prefix,
        items: result.paged.items,
        suffix: result.paged.suffix,
        pageSize: result.paged.pageSize,
        createdAt: Date.now(),
      });
      const firstPage = buildAssistantPagedMessage(result.paged, 0);
      const keyboard = buildAssistantPagedKeyboard(token, firstPage.safePage, firstPage.totalPages);
      if (pendingReply) {
        try {
          await ctx.api.editMessageText(chatId, pendingReply.messageId, firstPage.text, {
            parse_mode: "HTML",
            ...(keyboard ? { reply_markup: keyboard } : {}),
            link_preview_options: { is_disabled: true },
          });
          return;
        } catch (error) {
          if (!isMessageEditUnavailableError(error)) {
            console.warn("[Assistant] 更新分页执行结果失败，改为发送新消息:", error);
          }
        }
      }
      await ctx.api.sendMessage(chatId, firstPage.text, {
        parse_mode: "HTML",
        ...(keyboard ? { reply_markup: keyboard } : {}),
        ...(replyMessageId ? { reply_parameters: { message_id: replyMessageId } } : {}),
        link_preview_options: { is_disabled: true },
      });
      return;
    }

    await sendOrEditPendingReply(ctx, pendingReply, result.text || "", {
      parse_mode: "HTML",
      link_preview_options: { is_disabled: true },
    });
  };

  const assistantExecutionResultToAuditText = (result: AssistantExecutionResult): string => {
    if (result.text) return result.text;
    if (result.paged) {
      return [result.paged.prefix, ...result.paged.items, result.paged.suffix || ""]
        .filter(Boolean)
        .join("\n")
        .slice(0, 4000);
    }
    return "";
  };

  const normalizeAssistantPointReason = (reason: string, amount: number): string => {
    const r = String(reason || "").trim();
    if (r.includes("中奖入账")) return "中奖入账";
    if (r.includes("活跃发言")) return "活跃发言";
    if (r.includes("小鼠偷家")) return "小鼠偷家";
    if (r.includes("关门打鼠")) return "关门打鼠";
    if (r.includes("被偷油")) return "小鼠偷家";
    if (r.includes("偷油达人")) return amount >= 0 ? "小鼠偷家" : "关门打鼠";
    if (r.includes("兑换邀请券") || r.includes("邀请兑换")) return "邀请兑换";
    if (r.includes("积分商城兑换")) return "商城兑换";
    if (r.includes("抽奖") || (amount < 0 && r.includes("积分支出"))) return "群组抽奖";
    if (
      r.includes("管理调整") ||
      r.includes("管理员调整") ||
      r.includes("手动调整") ||
      r.includes("积分导入") ||
      r.includes("批量导入")
    ) return "管理调整";
    return r || (amount >= 0 ? "积分增加" : "积分扣除");
  };

  const buildAssistantPointLedgerRows = (
    rawLogs: { amount: number; reason: string; created_at: string }[],
    currentTotal: number,
    recentDays: number = 20
  ): Array<{ dayLabel: string; amount: number; reason: string; balanceAfter: number }> => {
    const CHINA_TZ_OFFSET_MS = 8 * 60 * 60 * 1000;
    const DAY_MS = 24 * 60 * 60 * 1000;
    const getChinaDayKey = (ms: number): string => new Date(ms + CHINA_TZ_OFFSET_MS).toISOString().slice(0, 10);
    const cutoffDayKey = getChinaDayKey(Date.now() - (Math.max(1, recentDays) - 1) * DAY_MS);
    const rows: Array<{ dayKey: string; dayLabel: string; amount: number; reason: string; balanceAfter: number }> = [];
    const activeDayIndex = new Map<string, number>();
    let newerAmountSum = 0;

    for (const log of rawLogs) {
      const d = new Date(`${log.created_at}Z`);
      const dayKey = getChinaDayKey(d.getTime());
      if (dayKey < cutoffDayKey) break;
      const dayLabel = d.toLocaleDateString("zh-CN", {
        timeZone: "Asia/Shanghai",
        month: "numeric",
        day: "numeric",
      });
      const balanceAfter = currentTotal - newerAmountSum;
      newerAmountSum += log.amount;
      const reason = normalizeAssistantPointReason(log.reason, log.amount);

      if (reason === "活跃发言" && log.amount > 0) {
        const index = activeDayIndex.get(dayKey);
        if (index === undefined) {
          activeDayIndex.set(dayKey, rows.length);
          rows.push({ dayKey, dayLabel, amount: log.amount, reason, balanceAfter });
        } else {
          rows[index].amount += log.amount;
        }
      } else {
        rows.push({ dayKey, dayLabel, amount: log.amount, reason, balanceAfter });
      }
    }

    return rows.map(({ dayLabel, amount, reason, balanceAfter }) => ({ dayLabel, amount, reason, balanceAfter }));
  };

  const isSuperAdminPrivate = (ctx: Context): boolean => {
    const adminId = Number(process.env.ADMIN_USER_ID || 0);
    return ctx.chat?.type === "private" && !!ctx.from?.id && adminId > 0 && ctx.from.id === adminId;
  };

  const getAssistantReplyContextTarget = (ctx: Context): { directReplyTargetId?: number; originalReplyTargetId?: number } => {
    const directReply = ctx.message?.reply_to_message as any;
    const directReplyUser = directReply?.from as any;
    const originalReplyUser = directReply?.reply_to_message?.from as any;
    const meId = ctx.me?.id;
    const meUsername = String(ctx.me?.username || "").toLowerCase();
    const replyIsBot = !!(
      directReplyUser?.is_bot && (
        (!!meId && directReplyUser.id === meId) ||
        (!!meUsername && String(directReplyUser.username || "").toLowerCase() === meUsername)
      )
    );

    return {
      directReplyTargetId: directReplyUser?.id,
      originalReplyTargetId: replyIsBot ? originalReplyUser?.id : undefined,
    };
  };

  const parseAssistantDurationMinutes = (text: string, fallbackMinutes: number = 10): number => {
    const raw = String(text || "");
    const compact = raw.replace(/\s+/g, "");
    const short = compact.match(/(\d+)([smhd])/i);
    if (short) {
      const num = Number(short[1]);
      const unit = short[2].toLowerCase();
      if (Number.isFinite(num) && num > 0) {
        if (unit === "s") return Math.max(1, Math.ceil(num / 60));
        if (unit === "m") return num;
        if (unit === "h") return num * 60;
        if (unit === "d") return num * 24 * 60;
      }
    }

    const zh = compact.match(/(\d+)\s*(分钟|分|小时|时|天)/);
    if (zh) {
      const num = Number(zh[1]);
      const unit = zh[2];
      if (Number.isFinite(num) && num > 0) {
        if (unit.includes("天")) return num * 24 * 60;
        if (unit.includes("小时") || unit === "时") return num * 60;
        return num;
      }
    }

    return fallbackMinutes;
  };

  const parseAssistantProvokeGuardCommand = (requestText: string): { enabled: boolean; muteMinutes: number } | null => {
    const text = String(requestText || "").trim();
    if (!text) return null;
    const compact = text.replace(/[，。！？、,.!?\s]+/g, "");

    const disable = /(关闭|取消|停用|停止|撤销).*(挑衅|骂|喷|怼).*(禁言|处理|规则|自动)/.test(text)
      || /(别再|不要再).*(挑衅|骂|喷|怼).*(禁言|处理)/.test(text);
    if (disable) return { enabled: false, muteMinutes: 10 };

    const enable = (
      /(接下来|以后|之后|从现在开始|后面).*(谁|有人).*(挑衅|骂|喷|怼).*(你|机器人).*(禁言|处理)/.test(text) ||
      /(谁|有人).*(挑衅|骂|喷|怼).*(你|机器人).*(就|都|直接).*(禁言|处理)/.test(text) ||
      /(开启|启用|打开).*(挑衅|骂|喷|怼).*(自动|规则).*(禁言|处理)/.test(text) ||
      /(把|将).*(挑衅|骂|喷|怼).*(你|机器人).*(都|就).*(禁言|处理)/.test(text) ||
      /(记住|记忆|记录).*(规则|规矩|策略).*(挑衅|骂|喷|怼).*(你|机器人).*(禁言|处理)/.test(text) ||
      /谁挑衅你你就禁言谁/.test(compact) ||
      /把挑衅你的都禁言掉/.test(compact)
    );
    if (!enable) return null;

    return {
      enabled: true,
      muteMinutes: parseAssistantDurationMinutes(text, 10),
    };
  };

  const parseAssistantLotteryRequest = (requestText: string):
    | { kind: "not_lottery" }
    | { kind: "missing_condition"; spec: Omit<LotteryCreationSpec, "drawCondition" | "targetValue" | "descCondition"> }
    | { kind: "ready"; spec: LotteryCreationSpec } => {
    const text = String(requestText || "").trim();
    if (!text) return { kind: "not_lottery" };
    if (!/(抽奖|发个抽奖|开个抽奖|建个抽奖|搞个抽奖)/.test(text)) {
      return { kind: "not_lottery" };
    }

    const prizeMatches = Array.from(text.matchAll(/([A-Za-z0-9\u4e00-\u9fa5_+\-]+?)\s*(\d+)\s*个/g));
    const prizes = prizeMatches
      .map((m) => ({
        name: String(m[1] || "").replace(/^(奖品|来个|发个|搞个|开个)+/, "").trim(),
        count: Number(m[2] || 0),
      }))
      .filter((item) => item.name && Number.isFinite(item.count) && item.count > 0);

    if (!prizes.length) {
      return { kind: "not_lottery" };
    }

    const requirementText = text.replace(/([A-Za-z0-9\u4e00-\u9fa5_+\-]+?)\s*(\d+)\s*个/g, " ");
    const noActivityRequired = /(不要|不用|无须|不需要).*(发言|活跃)|(发言|活跃).*(不要|不用|无须|不需要)/.test(requirementText);
    const noPointsRequired = /(不要|不用|无须|不需要).*(积分)|(积分).*(不要|不用|无须|不需要)/.test(requirementText);
    const minActivity = noActivityRequired ? 0 : Number((requirementText.match(/(?:发言|活跃)(?:满|要|要求|至少)?\s*(\d+)/)?.[1] || 0));
    const minPoints = noPointsRequired ? 0 : Number((requirementText.match(/(?:积分)(?:门槛|要求|至少|扣除|参与|需要|消耗)?\s*(\d+)/)?.[1] || 0));

    let remark = "";
    const remarkMatch = text.match(/((?:找我|联系我|私聊我|找我bot|联系bot|私聊bot)[^，。]*)/i);
    if (remarkMatch?.[1]) remark = remarkMatch[1].trim();

    const countMatch = text.match(/(?:满|达到)\s*(\d+)\s*人(?:开奖|开)?|(\d+)\s*[人rR](?:开奖|开)?/);
    if (countMatch) {
      const count = Number(countMatch[1] || countMatch[2] || 0);
      if (count > 0) {
        return {
          kind: "ready",
          spec: {
            prizes,
            drawCondition: "count",
            targetValue: String(count),
            descCondition: `满 ${count} 人自动开奖`,
            remark,
            minActivity: Number.isFinite(minActivity) ? minActivity : 0,
            minPoints: Number.isFinite(minPoints) ? minPoints : 0,
          },
        };
      }
    }

    if (/(手动开奖|我手动开奖|先发.*手动开奖|先发.*我来开奖)/.test(text)) {
      return {
        kind: "ready",
        spec: {
          prizes,
          drawCondition: "manual",
          targetValue: "",
          descCondition: "手动开奖（由发起人决定开奖时间）",
          remark,
          minActivity: Number.isFinite(minActivity) ? minActivity : 0,
          minPoints: Number.isFinite(minPoints) ? minPoints : 0,
        },
      };
    }

    const timeMatch = text.match(/(\d+)\s*(分钟|分|小时|时|天|m|h|d)(?:后)?(?:开奖|开)?/i);
    if (timeMatch) {
      const num = Number(timeMatch[1] || 0);
      const unit = String(timeMatch[2] || "").toLowerCase();
      if (num > 0) {
        let ms = num * 60 * 1000;
        if (unit === "小时" || unit === "时" || unit === "h") ms = num * 60 * 60 * 1000;
        else if (unit === "天" || unit === "d") ms = num * 24 * 60 * 60 * 1000;
        const targetDate = new Date(Date.now() + ms);
        const locDateStr = targetDate.toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" });
        return {
          kind: "ready",
          spec: {
            prizes,
            drawCondition: "time",
            targetValue: targetDate.toISOString(),
            descCondition: `于 ${locDateStr} 自动开奖`,
            remark,
            minActivity: Number.isFinite(minActivity) ? minActivity : 0,
            minPoints: Number.isFinite(minPoints) ? minPoints : 0,
          },
        };
      }
    }

    return {
      kind: "missing_condition",
      spec: {
        prizes,
        remark,
        minActivity: Number.isFinite(minActivity) ? minActivity : 0,
        minPoints: Number.isFinite(minPoints) ? minPoints : 0,
      },
    };
  };

  const parseAssistantLotteryRequestByAI = async (requestText: string, chatIdForAI?: number): Promise<
    | { kind: "not_lottery" }
    | { kind: "missing_condition"; spec: Omit<LotteryCreationSpec, "drawCondition" | "targetValue" | "descCondition"> }
    | { kind: "ready"; spec: LotteryCreationSpec }
    | null
  > => {
    const text = String(requestText || "").trim();
    if (!text) return null;

    let parsed: any;
    try {
      const response = await callAI([
        { role: "system", content: LOTTERY_ASSISTANT_SYSTEM_PROMPT },
        { role: "user", content: text },
      ], 260, 0.1, true, chatIdForAI ? getChatAIProvider(chatIdForAI) : undefined);
      parsed = extractJson(response.content || "");
    } catch {
      return null;
    }

    if (!parsed || typeof parsed !== "object") return null;
    const kind = String(parsed.kind || "").trim();
    if (!kind || !["not_lottery", "missing_condition", "ready"].includes(kind)) return null;
    if (kind === "not_lottery") return { kind: "not_lottery" };

    const prizes = Array.isArray(parsed.prizes)
      ? parsed.prizes
        .map((item: any) => ({
          name: String(item?.name || "").trim().replace(/[,*]/g, " ").replace(/\s+/g, " ").trim(),
          count: Math.floor(Number(item?.count || 0)),
        }))
        .filter((item: { name: string; count: number }) => item.name && Number.isFinite(item.count) && item.count > 0)
      : [];
    if (!prizes.length) return null;

    const baseSpec = {
      prizes,
      remark: String(parsed.remark || "").trim().slice(0, 200),
      minActivity: Math.max(0, Math.floor(Number(parsed.minActivity || 0))),
      minPoints: Math.max(0, Math.floor(Number(parsed.minPoints || 0))),
    };

    if (kind === "missing_condition") {
      return { kind: "missing_condition", spec: baseSpec };
    }

    const drawCondition = String(parsed.drawCondition || "").trim();
    if (drawCondition === "manual") {
      return {
        kind: "ready",
        spec: {
          ...baseSpec,
          drawCondition: "manual",
          targetValue: "",
          descCondition: "手动开奖（由发起人决定开奖时间）",
        },
      };
    }

    if (drawCondition === "count") {
      const participantCount = Math.max(1, Math.floor(Number(parsed.participantCount || 0)));
      if (!participantCount) return { kind: "missing_condition", spec: baseSpec };
      return {
        kind: "ready",
        spec: {
          ...baseSpec,
          drawCondition: "count",
          targetValue: String(participantCount),
          descCondition: `满 ${participantCount} 人自动开奖`,
        },
      };
    }

    if (drawCondition === "time") {
      const durationMinutes = Math.max(1, Math.floor(Number(parsed.durationMinutes || 0)));
      if (!durationMinutes) return { kind: "missing_condition", spec: baseSpec };
      const targetDate = new Date(Date.now() + durationMinutes * 60 * 1000);
      const locDateStr = targetDate.toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" });
      return {
        kind: "ready",
        spec: {
          ...baseSpec,
          drawCondition: "time",
          targetValue: targetDate.toISOString(),
          descCondition: `于 ${locDateStr} 自动开奖`,
        },
      };
    }

    return null;
  };

  const buildAssistantLotteryDraftPrompt = (
    spec: Omit<LotteryCreationSpec, "drawCondition" | "targetValue" | "descCondition">,
    followupText: string
  ): string => {
    const prizeText = spec.prizes.map((p) => `${p.name}${p.count}个`).join("，");
    const extras: string[] = [];
    if ((spec.minActivity || 0) > 0) extras.push(`要发言${spec.minActivity}`);
    else extras.push("不要发言门槛");
    if ((spec.minPoints || 0) > 0) extras.push(`要积分${spec.minPoints}`);
    else extras.push("不要积分门槛");
    if (spec.remark) extras.push(spec.remark);
    return `发个抽奖，奖品${prizeText}，${extras.join("，")}，${followupText}`;
  };

  const resolveAssistantLotteryIntent = async (requestText: string, chatIdForAI?: number) => {
    const aiParsed = await parseAssistantLotteryRequestByAI(requestText, chatIdForAI);
    if (aiParsed && aiParsed.kind !== "not_lottery") return aiParsed;
    return parseAssistantLotteryRequest(requestText);
  };

  const PROVOKE_GUARD_SYSTEM_PROMPT = [
    "你是 Telegram 群聊执法判定器。",
    "判断一条群员消息是否在明显挑衅、辱骂、攻击机器人本人。",
    "只有在对象明确是机器人本人时才判定 provoke=true。",
    "普通聊天、正常质疑、让机器人给证据、问问题、抱怨别人，不算挑衅机器人。",
    "输出 JSON：{\"provoke\":true|false,\"confidence\":0-1,\"reason\":\"...\"}",
  ].join("\n");

  const classifyBotProvocation = async (ctx: Context, userName: string, userText: string, repliedBotText: string): Promise<{ provoke: boolean; confidence: number; reason: string }> => {
    const safeUserText = sanitizeGroupChatText(userText, 200);
    const safeBotText = sanitizeGroupChatText(repliedBotText, 120);
    const response = await callAI([
      { role: "system", content: PROVOKE_GUARD_SYSTEM_PROMPT },
      {
        role: "user",
        content: [
          safeBotText ? `【机器人上一句】${safeBotText}` : "【机器人上一句】无",
          `【群员 ${userName}】${safeUserText}`,
          "请只返回 JSON。",
        ].join("\n"),
      },
    ], 120, 0.1, true, getChatAIProvider(ctx.chat!.id));
    const parsed = extractJson(response.content || "") || {};
    return {
      provoke: parsed?.provoke === true,
      confidence: Number.isFinite(Number(parsed?.confidence)) ? Number(parsed.confidence) : 0,
      reason: String(parsed?.reason || "").trim().slice(0, 120),
    };
  };

  const resolveAssistantTargets = async (ctx: Context, action: AssistantAction): Promise<number[]> => {
    const resolved = new Set<number>();
    const targetChatId = ctx.chat?.id;
    const replyContext = getAssistantReplyContextTarget(ctx);
    const replyTargetId = replyContext.originalReplyTargetId || replyContext.directReplyTargetId;
    const inferredUsernames = !action.userIds?.length && !(action.usernames?.length) ? extractAssistantUsernamesFromMessage(ctx) : [];
    const effectiveUsernames = [...(action.usernames || []), ...inferredUsernames]
      .map((value) => normalizeAssistantUsername(value))
      .filter(Boolean)
      .filter((value, index, arr) => arr.indexOf(value) === index);
    const hasExplicitTarget = !!(action.userIds?.length || effectiveUsernames.length);

    // 显式目标优先于回复目标，避免管理员写了 @username 仍误伤被回复对象。
    if (!hasExplicitTarget && (action.target === "reply" || replyTargetId)) {
      if (!replyTargetId) {
        throw new Error("该操作需要你回复目标用户的消息，或明确提供用户ID/@用户名。");
      }
      resolved.add(replyTargetId);
    }

    for (const userId of action.userIds || []) {
      if (Number.isFinite(userId) && userId > 0) resolved.add(Math.floor(userId));
    }

    for (const rawUsername of effectiveUsernames) {
      const username = normalizeAssistantUsername(rawUsername);
      if (!username) continue;
      if (ctx.chat?.type !== "private" && targetChatId != null) {
        const cachedUserId = db.findChatUserIdByUsername(targetChatId, username);
        if (cachedUserId && cachedUserId > 0) {
          resolved.add(cachedUserId);
          continue;
        }
      }
      try {
        const chat = await ctx.api.getChat(username);
        const targetId = Number((chat as any)?.id || 0);
        if (targetId > 0) resolved.add(targetId);
      } catch {
        // ignore single target resolution failure; caller will see empty result if all fail
      }
    }

    if (!resolved.size && effectiveUsernames.length > 0 && ctx.chat?.type !== "private") {
      throw new Error("已识别到 @用户名，但机器人暂时没有该用户的群内ID缓存。请让对方先在群里发一条消息、直接回复对方消息操作，或使用TGID。");
    }

    return Array.from(resolved).slice(0, 20);
  };

  const materializeAssistantPlan = async (
    ctx: Context,
    chatId: number,
    plan: AssistantPlan
  ): Promise<ResolvedAssistantPlan> => {
    if (plan.mode !== "execute") {
      throw new Error("内部错误：仅可执行 execute 计划。");
    }

    const actions: ResolvedAssistantAction[] = [];
    for (const action of plan.actions) {
      switch (action.type) {
        case "get_group_status":
        case "show_memory":
        case "clear_memory":
        case "get_global_daily_stats":
        case "list_enabled_groups":
          actions.push({ type: action.type });
          break;

        case "set_feature": {
          if (!["antispam", "ai", "points", "global_ban"].includes(String(action.feature || ""))) {
            throw new Error("功能开关参数无效。");
          }
          if (typeof action.enabled !== "boolean") {
            throw new Error("功能开关缺少 on/off 参数。");
          }
          actions.push({ type: "set_feature", feature: action.feature, enabled: action.enabled });
          break;
        }

        case "set_threshold": {
          if (!Number.isFinite(action.threshold)) {
            throw new Error("阈值参数无效，请提供 0 到 1 之间的数值。");
          }
          actions.push({ type: "set_threshold", threshold: Math.max(0, Math.min(1, Number(action.threshold))) });
          break;
        }

        case "get_recent_logs":
          actions.push({ type: "get_recent_logs", limit: Math.max(1, Math.min(10, action.limit || 5)) });
          break;

        case "get_group_today_activity":
          actions.push({ type: "get_group_today_activity", limit: Math.max(1, Math.min(100, action.limit || 30)) });
          break;

        case "get_user_point_logs": {
          let resolvedUserIds = await resolveAssistantTargets(ctx, action);
          if (!resolvedUserIds.length && !action.userIds?.length && !(action.usernames?.length) && action.target !== "reply" && ctx.from?.id) {
            resolvedUserIds = [ctx.from.id];
          }
          if (!resolvedUserIds.length) {
            throw new Error("没有找到可查询积分流水的目标用户，请回复对方消息或提供用户ID/@用户名。");
          }
          actions.push({
            type: "get_user_point_logs",
            resolvedUserIds,
            limit: Math.max(1, Math.min(20, action.limit || 10)),
          });
          break;
        }

        case "get_points_leaderboard":
          actions.push({ type: "get_points_leaderboard", limit: Math.max(1, Math.min(20, action.limit || 10)) });
          break;

        case "get_today_oil_steal": {
          let resolvedUserIds: number[] | undefined;
          if (action.target === "reply" || action.userIds?.length || action.usernames?.length) {
            resolvedUserIds = await resolveAssistantTargets(ctx, action);
          }
          const safeDaysAgo = Math.max(0, Math.min(30, Math.floor(Number(action.daysAgo) || 0)));
          const safeDaysWindow = Math.max(1, Math.min(30, Math.floor(Number(action.daysWindow) || 1)));
          actions.push({
            type: "get_today_oil_steal",
            limit: Math.max(1, Math.min(30, action.limit || 10)),
            daysAgo: safeDaysAgo,
            daysWindow: safeDaysWindow,
            ...(resolvedUserIds?.length ? { resolvedUserIds } : {}),
          });
          break;
        }

        case "list_whitelist":
          actions.push({ type: "list_whitelist" });
          break;

        case "check_user_in_group": {
          const resolvedUserIds = await resolveAssistantTargets(ctx, action);
          if (!resolvedUserIds.length) {
            throw new Error("没有找到可检查的目标用户，请回复对方消息或提供用户ID/@用户名。");
          }
          actions.push({ type: "check_user_in_group", resolvedUserIds });
          break;
        }

        case "remember_note": {
          throw new Error("记忆规则已停用，请直接使用明确的管理规则或执行要求。");
        }

        case "show_memory":
        case "clear_memory":
          throw new Error("记忆功能已停用，请直接描述你要执行的规则或操作。");

        case "get_user_activity":
        case "mute_user":
        case "unmute_user":
        case "add_whitelist":
        case "remove_whitelist": {
          const resolvedUserIds = await resolveAssistantTargets(ctx, action);
          if (!resolvedUserIds.length) {
            throw new Error("没有找到可执行的目标用户，请回复对方消息或提供用户ID/@用户名。");
          }
          const nextAction: ResolvedAssistantAction = {
            type: action.type,
            resolvedUserIds,
          };
          if (action.type === "mute_user") {
            nextAction.durationMinutes = Math.max(1, Math.min(7 * 24 * 60, action.durationMinutes || 60));
          }
          if (action.type === "get_user_activity") {
            nextAction.days = Math.max(1, Math.min(30, action.days || 10));
          }
          actions.push(nextAction);
          break;
        }

        case "get_user_points": {
          let resolvedUserIds = await resolveAssistantTargets(ctx, action);
          if (!resolvedUserIds.length && !action.userIds?.length && !(action.usernames?.length) && action.target !== "reply" && ctx.from?.id) {
            resolvedUserIds = [ctx.from.id];
          }
          if (!resolvedUserIds.length) {
            throw new Error("没有找到可查询积分的目标用户，请回复对方消息或提供用户ID/@用户名。");
          }
          actions.push({
            type: "get_user_points",
            resolvedUserIds,
          });
          break;
        }

        default:
          throw new Error(`暂不支持动作: ${action.type}`);
      }
    }

    if (!actions.length) {
      throw new Error("没有可执行动作。");
    }

    return {
      mode: "execute",
      summary: plan.summary.slice(0, 200),
      actions,
    };
  };

  const describeAssistantAction = async (
    ctx: Context,
    chatId: number,
    action: ResolvedAssistantAction
  ): Promise<string> => {
    switch (action.type) {
      case "get_group_status":
        return "查看本群状态";
      case "set_feature": {
        const featureLabel =
          action.feature === "antispam" ? "基础反垃圾" :
            action.feature === "ai" ? "AI 检测" :
              action.feature === "points" ? "积分系统" : "跨群封禁";
        return `${action.enabled ? "开启" : "关闭"}${featureLabel}`;
      }
      case "set_threshold":
        return `把匹配阈值调整到 ${action.threshold ?? 0.8}`;
      case "get_recent_logs":
        return `查看最近 ${action.limit || 5} 条处理日志`;
      case "get_group_today_activity":
        return `统计本群今天发言人数和名单`;
      case "get_user_activity": {
        const users = await Promise.all((action.resolvedUserIds || []).slice(0, 5).map((id) => renderUserLink(ctx, chatId, id)));
        return `查询 ${users.join("、")} 最近 ${action.days || 10} 天发言`;
      }
      case "get_user_points": {
        const users = await Promise.all((action.resolvedUserIds || []).slice(0, 5).map((id) => renderUserLink(ctx, chatId, id)));
        return `查询 ${users.join("、")} 的积分`;
      }
      case "get_user_point_logs": {
        const users = await Promise.all((action.resolvedUserIds || []).slice(0, 5).map((id) => renderUserLink(ctx, chatId, id)));
        return `查看 ${users.join("、")} 的积分流水明细`;
      }
      case "get_points_leaderboard":
        return `查看积分榜前 ${action.limit || 10}`;
      case "get_today_oil_steal": {
        const dayLabel = formatAssistantOilPeriod(action.daysAgo || 0, action.daysWindow || 1);
        if (action.resolvedUserIds?.length) {
          const users = await Promise.all((action.resolvedUserIds || []).slice(0, 5).map((id) => renderUserLink(ctx, chatId, id)));
          return `查看${dayLabel}谁偷了 ${users.join("、")} 的油（最近 ${action.limit || 10} 条）`;
        }
        return `查看${dayLabel}的偷油记录（最近 ${action.limit || 10} 条）`;
      }
      case "check_user_in_group": {
        const users = await Promise.all((action.resolvedUserIds || []).slice(0, 5).map((id) => renderUserLink(ctx, chatId, id)));
        return `检查 ${users.join("、")} 是否在本群`;
      }
      case "mute_user": {
        const users = await Promise.all((action.resolvedUserIds || []).slice(0, 5).map((id) => renderUserLink(ctx, chatId, id)));
        return `禁言 ${users.join("、")} ${formatAssistantDuration(action.durationMinutes || 60)}`;
      }
      case "unmute_user": {
        const users = await Promise.all((action.resolvedUserIds || []).slice(0, 5).map((id) => renderUserLink(ctx, chatId, id)));
        return `解除 ${users.join("、")} 的禁言`;
      }
      case "add_whitelist": {
        const users = await Promise.all((action.resolvedUserIds || []).slice(0, 5).map((id) => renderUserLink(ctx, chatId, id)));
        return `把 ${users.join("、")} 加入白名单`;
      }
      case "remove_whitelist": {
        const users = await Promise.all((action.resolvedUserIds || []).slice(0, 5).map((id) => renderUserLink(ctx, chatId, id)));
        return `把 ${users.join("、")} 移出白名单`;
      }
      case "list_whitelist":
        return "查看当前白名单列表";
      case "remember_note":
        return `记住偏好：${esc(String(action.note || "").slice(0, 60))}`;
      case "show_memory":
        return "查看当前记忆";
      case "clear_memory":
        return "清空当前记忆";
      case "get_global_daily_stats":
        return "查看全局 24 小时数据";
      case "list_enabled_groups":
        return "查看启用中的群组列表";
      default:
        return action.type;
    }
  };

  const planNeedsConfirmation = (plan: ResolvedAssistantPlan): boolean => {
    return plan.actions.some((action) => action.type === "mute_user");
  };

  const executeAssistantPlan = async (
    ctx: Context,
    chatId: number,
    requesterId: number,
    plan: ResolvedAssistantPlan
  ): Promise<AssistantExecutionResult> => {
    const leadingBlocks: string[] = [];
    const trailingBlocks: string[] = [];
    let pagedResult: AssistantPagedPayload | undefined;
    const memoryChatId = getAssistantMemoryScopeChatId(ctx, chatId);

    const pushResultBlock = (text: string) => {
      if (!pagedResult) leadingBlocks.push(text);
      else trailingBlocks.push(text);
    };

    const setPagedResult = (payload: AssistantPagedPayload) => {
      if (!payload || !payload.items.length) {
        pushResultBlock(payload?.prefix || "");
        return;
      }
      if (pagedResult) {
        pushResultBlock([payload.prefix, ...payload.items, payload.suffix || ""].filter(Boolean).join("\n\n"));
        return;
      }
      pagedResult = payload;
    };

    for (const action of plan.actions) {
      switch (action.type) {
        case "get_group_status": {
          if (ctx.chat?.type === "private") {
            pushResultBlock("ℹ️ 私聊里没有当前群状态，请在群里使用，或让我列出全局群组。");
            break;
          }
          const config = db.getGroupConfig(chatId);
          const stats = db.getStats(chatId);
          const wl = db.getWhitelist(chatId);
          const botPerm = await getBotPermissionStatus(ctx, chatId);
          pushResultBlock([
            `📊 <b>本群状态</b>`,
            `• 基础反垃圾: ${config?.enabled ? "🟢 已开启" : "🔴 已关闭"}`,
            `• AI 检测: ${(config?.aiEnabled ?? false) ? "🟢 已开启" : "🔴 已关闭"}`,
            `• 跨群封禁: ${(config?.globalBanEnabled ?? false) ? "🟢 已开启" : "🔴 已关闭"}`,
            `• 积分系统: ${(config?.pointsEnabled ?? false) ? "🟢 已开启" : "🔴 已关闭"}`,
            `• 阈值: <code>${config?.threshold ?? 0.8}</code>`,
            `• 白名单人数: <code>${wl.length}</code>`,
            `• 累计拦截: <code>${stats.total}</code>`,
            `• 24h 拦截: <code>${stats.today}</code>`,
            `• ${renderBotPermissionLine(botPerm)}`,
          ].join("\n"));
          break;
        }

        case "set_feature": {
          if (ctx.chat?.type === "private") {
            pushResultBlock("⚠️ 功能开关只能在目标群组里操作。");
            break;
          }
          const botPerm = await getBotPermissionStatus(ctx, chatId);
          const feature = action.feature!;
          if (action.enabled && ["ai", "points", "global_ban"].includes(feature)) {
            const ok = await ensureCommercialFeatureAccess(
              ctx,
              chatId,
              requesterId,
              feature === "ai" ? "AI 检测助理" : feature === "points" ? "积分系统" : "跨群同步封禁"
            );
            if (!ok) {
              pushResultBlock(`⚠️ 无法开启${feature === "ai" ? "AI 检测" : feature === "points" ? "积分系统" : "跨群封禁"}：当前聊天未绑定有效订阅。`);
              break;
            }
          }
          if (action.enabled && (feature === "antispam" || feature === "ai") && !botPerm.ok) {
            pushResultBlock(`❌ 无法开启 ${feature === "ai" ? "AI 检测" : "基础反垃圾"}：${esc(botPerm.shortReason)}`);
            break;
          }
          if (feature === "antispam") {
            action.enabled ? db.enableGroup(chatId) : db.disableGroup(chatId);
          } else if (feature === "ai") {
            db.setAIEnabled(chatId, !!action.enabled, action.enabled ? undefined : { disabledReason: "manual" });
          } else if (feature === "points") {
            db.setPointsEnabled(chatId, !!action.enabled);
          } else if (feature === "global_ban") {
            db.setGlobalBanEnabled(chatId, !!action.enabled);
          }
          const featureLabel =
            feature === "antispam" ? "基础反垃圾" :
              feature === "ai" ? "AI 检测" :
                feature === "points" ? "积分系统" : "跨群封禁";
          pushResultBlock(`✅ 已${action.enabled ? "开启" : "关闭"}${featureLabel}。`);
          break;
        }

        case "set_threshold": {
          if (ctx.chat?.type === "private") {
            pushResultBlock("⚠️ 阈值只能在目标群组里调整。");
            break;
          }
          const nextThreshold = Math.max(0, Math.min(1, Number(action.threshold ?? 0.8)));
          db.setThreshold(chatId, nextThreshold);
          pushResultBlock(`✅ 已将匹配阈值调整为 <code>${nextThreshold}</code>。`);
          break;
        }

        case "get_recent_logs": {
          if (ctx.chat?.type === "private") {
            pushResultBlock("⚠️ 最近处理日志属于群内维度，请在群里使用，或让我做全局汇总。");
            break;
          }
          const logs = db.getRecentLogs(chatId, action.limit || 5);
          if (!logs.length) {
            pushResultBlock("📭 最近没有处理日志。");
            break;
          }
          const lines = await Promise.all(logs.map(async (log, idx) => {
            const userLink = await renderUserLink(ctx, chatId, log.user_id);
            return `${idx + 1}. ${userLink} | <code>${formatAssistantTimestamp(log.created_at)}</code> | ${esc(log.action || "ban")}\n<i>${formatPreview(log.message_text || log.reason || "")}</i>`;
          }));
          pushResultBlock(`🧾 <b>最近 ${logs.length} 条处理日志</b>\n\n${lines.join("\n\n")}`);
          break;
        }

        case "get_group_today_activity": {
          if (ctx.chat?.type === "private") {
            pushResultBlock("⚠️ 今日发言统计属于群维度，请在目标群里使用。");
            break;
          }
          const total = db.getTodayActiveSpeakerCount(chatId);
          const speakers = db.getTodayActiveSpeakers(chatId, 5000);
          if (!total || !speakers.length) {
            pushResultBlock("📭 本群今天还没有发言记录。");
            break;
          }
          const lines = await Promise.all(speakers.map(async (row, idx) => {
            const userLink = await renderUserLink(ctx, chatId, row.user_id);
            return `${idx + 1}. ${userLink} - <code>${row.count}</code> 条`;
          }));
          setPagedResult({
            prefix: [
              `🗣️ <b>本群今日发言统计</b>`,
              `• 发言人数: <code>${total}</code>`,
              `• 完整名单: <code>${speakers.length}</code>`,
            ].join("\n"),
            items: lines,
            pageSize: 20,
          });
          break;
        }

        case "get_user_activity": {
          if (ctx.chat?.type === "private") {
            pushResultBlock("⚠️ 发言统计依赖群维度，请在目标群里使用。");
            break;
          }
          const days = action.days || 10;
          const lines = await Promise.all((action.resolvedUserIds || []).map(async (targetId) => {
            const state = await getAssistantGroupMemberState(ctx, chatId, targetId);
            const userLink = await renderUserLink(ctx, chatId, targetId);
            if (!state.exists) {
              return `• ${userLink}: ❌ 不在本群，已跳过查询`;
            }
            const count = db.getUserMessageCount(chatId, targetId, days);
            const otherMax = db.getUserMaxMessageCountAcrossGroups(targetId, days, chatId);
            return `• ${userLink}: 本群 <code>${count}</code> 条 / 它群最高 <code>${otherMax}</code> 条`;
          }));
          pushResultBlock(`📈 <b>最近 ${days} 天发言统计</b>\n\n${lines.join("\n")}`);
          break;
        }

        case "get_user_points": {
          if (ctx.chat?.type === "private") {
            pushResultBlock("⚠️ 积分属于群维度，请在目标群里使用。");
            break;
          }
          const lines = await Promise.all((action.resolvedUserIds || []).map(async (targetId) => {
            const state = await getAssistantGroupMemberState(ctx, chatId, targetId);
            const userLink = await renderUserLink(ctx, chatId, targetId);
            if (!state.exists) {
              return `• ${userLink}: ❌ 不在本群，已跳过查询`;
            }
            const points = db.getUserPoints(chatId, targetId);
            const rank = db.getUserPointsRank(chatId, targetId);
            return `• ${userLink}: 总积分 <code>${points.total}</code> / 今日 <code>${points.today}</code>${rank ? ` / 排名 <code>#${rank}</code>` : ""}`;
          }));
          pushResultBlock(`💰 <b>积分查询</b>\n\n${lines.join("\n")}`);
          break;
        }

        case "get_user_point_logs": {
          if (ctx.chat?.type === "private") {
            pushResultBlock("⚠️ 积分流水属于群维度，请在目标群里使用。");
            break;
          }
          const limit = Math.max(1, Math.min(20, action.limit || 10));
          const blocks = await Promise.all((action.resolvedUserIds || []).map(async (targetId) => {
            const state = await getAssistantGroupMemberState(ctx, chatId, targetId);
            const userLink = await renderUserLink(ctx, chatId, targetId);
            if (!state.exists) {
              return `📒 <b>积分流水</b>\n\n• ${userLink}: ❌ 不在本群，已跳过查询`;
            }

            const rawLogs = db.getPointLogs(chatId, targetId, 2000, 0);
            const currentTotal = db.getUserPoints(chatId, targetId).total;
            const rows = buildAssistantPointLedgerRows(rawLogs, currentTotal, 20).slice(0, limit);
            if (!rows.length) {
              return `📒 <b>${userLink} 的积分流水</b>\n\n最近 20 天暂无记录。`;
            }

            const lines = rows.map((row) => {
              const symbol = row.amount > 0 ? "+" : "";
              return `• ${row.dayLabel} | <b>${symbol}${row.amount}</b> | ${esc(row.reason)} (<code>${row.balanceAfter}</code>)`;
            });
            return `📒 <b>${userLink} 的积分流水</b>\n\n${lines.join("\n")}`;
          }));
          pushResultBlock(blocks.join("\n\n"));
          break;
        }

        case "get_points_leaderboard": {
          if (ctx.chat?.type === "private") {
            pushResultBlock("⚠️ 积分榜属于群维度，请在目标群里使用。");
            break;
          }
          const rows = db.getPointsLeaderboard(chatId, action.limit || 10, 0);
          if (!rows.length) {
            pushResultBlock("📭 本群暂无积分榜数据。");
            break;
          }
          const lines = await Promise.all(rows.map(async (row, idx) => {
            const userLink = await renderUserLink(ctx, chatId, row.user_id);
            return `${idx + 1}. ${userLink} - <code>${row.points}</code>`;
          }));
          pushResultBlock(`🏆 <b>积分榜 Top ${rows.length}</b>\n\n${lines.join("\n")}`);
          break;
        }

        case "get_today_oil_steal": {
          if (ctx.chat?.type === "private") {
            pushResultBlock("⚠️ 偷油记录属于群维度，请在目标群里使用。");
            break;
          }
          if (!isPointsAvailableInChat(chatId)) {
            pushResultBlock("⚠️ 当前群组未开启积分系统，偷油功能和偷油记录都不可用。");
            break;
          }
          const daysAgo = Math.max(0, Math.min(30, Math.floor(Number(action.daysAgo) || 0)));
          const daysWindow = Math.max(1, Math.min(30, Math.floor(Number(action.daysWindow) || 1)));
          const dayLabel = formatAssistantOilPeriod(daysAgo, daysWindow);
          const filterTargetId = action.resolvedUserIds?.[0];
          const attempts = db.getTodayOilStealAttempts(chatId, action.limit || 10, filterTargetId, daysAgo, daysWindow);
          if (!attempts.length) {
            if (filterTargetId) {
              const targetLink = await renderUserLink(ctx, chatId, filterTargetId);
              pushResultBlock(`📭 ${dayLabel}还没有人偷 ${targetLink} 的油。`);
            } else {
              pushResultBlock(`📭 ${dayLabel}还没有偷油记录。`);
            }
            break;
          }
          const lines = await Promise.all(attempts.map(async (row, idx) => {
            const thiefLink = await renderUserLink(ctx, chatId, row.thief_user_id);
            const targetLink = await renderUserLink(ctx, chatId, row.target_user_id);
            const time = formatAssistantTimestamp(row.created_at);
            let resultText = "扑空";
            if (row.outcome === "success") {
              resultText = `成功偷到 <code>${row.actual_points}</code> 分`;
            } else if (row.outcome === "backfire") {
              resultText = row.actual_points > 0
                ? `关门打鼠，反赔 <code>${row.actual_points}</code> 分`
                : "关门打鼠，但没分可赔";
            }
            return `${idx + 1}. ${thiefLink} -> ${targetLink} | <code>${time}</code> | ${resultText}`;
          }));
          if (filterTargetId) {
            const targetLink = await renderUserLink(ctx, chatId, filterTargetId);
            pushResultBlock(`🛢️ <b>${dayLabel}谁偷了 ${targetLink} 的油</b>\n\n${lines.join("\n")}`);
          } else {
            pushResultBlock(`🛢️ <b>${dayLabel}偷油记录</b>\n\n${lines.join("\n")}`);
          }
          break;
        }

        case "check_user_in_group": {
          if (ctx.chat?.type === "private") {
            pushResultBlock("⚠️ 成员检查属于群维度，请在目标群里使用。");
            break;
          }
          const lines = await Promise.all((action.resolvedUserIds || []).map(async (targetId) => {
            const state = await getAssistantGroupMemberState(ctx, chatId, targetId);
            const userLink = await renderUserLink(ctx, chatId, targetId);
            return `• ${userLink}: ${state.exists ? `✅ 在群内 (${esc(state.status)})` : "❌ 不在本群"}`;
          }));
          pushResultBlock(`👥 <b>成员检查</b>\n\n${lines.join("\n")}`);
          break;
        }

        case "mute_user": {
          if (ctx.chat?.type === "private") {
            pushResultBlock("⚠️ 禁言只能在群里执行。");
            break;
          }
          const botPerm = await getBotPermissionStatus(ctx, chatId);
          if (!botPerm.ok || !botPerm.canRestrict) {
            pushResultBlock(`❌ 无法执行禁言：${esc(botPerm.shortReason)}`);
            break;
          }
          const untilDate = Math.floor(Date.now() / 1000) + (action.durationMinutes || 60) * 60;
          const success: string[] = [];
          const skipped: string[] = [];
          for (const targetId of action.resolvedUserIds || []) {
            const state = await getAssistantGroupMemberState(ctx, chatId, targetId);
            if (!state.exists) {
              skipped.push(`<code>${targetId}</code> (不在本群)`);
              continue;
            }
            if (await checkIsAdmin(ctx, chatId, targetId)) {
              skipped.push(`<code>${targetId}</code> (管理员)`);
              continue;
            }
            try {
              await ctx.api.restrictChatMember(chatId, targetId, {
                can_send_messages: false,
                can_send_other_messages: false,
                can_add_web_page_previews: false,
              }, { until_date: untilDate });
              success.push(await renderUserLink(ctx, chatId, targetId));
            } catch {
              skipped.push(`<code>${targetId}</code> (失败)`);
            }
          }
          const lines = [`🚫 <b>禁言结果</b>`, `• 时长: <code>${formatAssistantDuration(action.durationMinutes || 60)}</code>`];
          if (success.length) lines.push(`• 成功: ${success.join("、")}`);
          if (skipped.length) lines.push(`• 跳过/失败: ${skipped.join("、")}`);
          pushResultBlock(lines.join("\n"));
          break;
        }

        case "unmute_user": {
          if (ctx.chat?.type === "private") {
            pushResultBlock("⚠️ 解禁言只能在群里执行。");
            break;
          }
          const botPerm = await getBotPermissionStatus(ctx, chatId);
          if (!botPerm.ok || !botPerm.canRestrict) {
            pushResultBlock(`❌ 无法解除禁言：${esc(botPerm.shortReason)}`);
            break;
          }
          const success: string[] = [];
          const skipped: string[] = [];
          for (const targetId of action.resolvedUserIds || []) {
            const state = await getAssistantGroupMemberState(ctx, chatId, targetId);
            if (!state.exists) {
              skipped.push(`<code>${targetId}</code> (不在本群)`);
              continue;
            }
            try {
              await ctx.api.restrictChatMember(chatId, targetId, {
                can_send_messages: true,
                can_send_other_messages: true,
                can_add_web_page_previews: true,
              });
              success.push(await renderUserLink(ctx, chatId, targetId));
            } catch {
              skipped.push(`<code>${targetId}</code> (失败)`);
            }
          }
          const lines = [`✅ <b>解除禁言结果</b>`];
          if (success.length) lines.push(`• 成功: ${success.join("、")}`);
          if (skipped.length) lines.push(`• 失败: ${skipped.join("、")}`);
          pushResultBlock(lines.join("\n"));
          break;
        }

        case "add_whitelist": {
          if (ctx.chat?.type === "private") {
            pushResultBlock("⚠️ 白名单属于群维度，请在目标群里使用。");
            break;
          }
          const added: string[] = [];
          const skipped: string[] = [];
          for (const targetId of action.resolvedUserIds || []) {
            const state = await getAssistantGroupMemberState(ctx, chatId, targetId);
            if (!state.exists) {
              skipped.push(`<code>${targetId}</code> (不在本群)`);
              continue;
            }
            db.addWhitelist(chatId, targetId);
            added.push(await renderUserLink(ctx, chatId, targetId));
          }
          const lines = [`✅ <b>白名单添加结果</b>`];
          if (added.length) lines.push(`• 已加入: ${added.join("、")}`);
          if (skipped.length) lines.push(`• 跳过: ${skipped.join("、")}`);
          pushResultBlock(lines.join("\n"));
          break;
        }

        case "remove_whitelist": {
          if (ctx.chat?.type === "private") {
            pushResultBlock("⚠️ 白名单属于群维度，请在目标群里使用。");
            break;
          }
          const removed: string[] = [];
          const missed: string[] = [];
          for (const targetId of action.resolvedUserIds || []) {
            const state = await getAssistantGroupMemberState(ctx, chatId, targetId);
            if (!state.exists) {
              missed.push(`<code>${targetId}</code> (不在本群)`);
              continue;
            }
            if (db.removeWhitelist(chatId, targetId)) removed.push(await renderUserLink(ctx, chatId, targetId));
            else missed.push(`<code>${targetId}</code>`);
          }
          const lines = [`🧹 <b>白名单移除结果</b>`];
          if (removed.length) lines.push(`• 已移除: ${removed.join("、")}`);
          if (missed.length) lines.push(`• 不在白名单: ${missed.join("、")}`);
          pushResultBlock(lines.join("\n"));
          break;
        }

        case "list_whitelist": {
          if (ctx.chat?.type === "private") {
            pushResultBlock("⚠️ 白名单属于群维度，请在目标群里使用。");
            break;
          }
          const list = db.getWhitelist(chatId);
          if (!list.length) {
            pushResultBlock("📋 当前白名单为空。");
            break;
          }
          const lines = await Promise.all(
            list.slice(0, 200).map(async (targetId, idx) => `${idx + 1}. ${await renderUserLink(ctx, chatId, targetId)} (<code>${targetId}</code>)`)
          );
          setPagedResult({
            prefix: [`📋 <b>当前白名单</b>`, `• 总人数: <code>${list.length}</code>`].join("\n"),
            items: lines,
            pageSize: 20,
          });
          break;
        }

        case "remember_note": {
          const saved = db.appendAssistantMemory(memoryChatId, requesterId, action.note || "");
          pushResultBlock(`🧠 已记住。当前记忆：\n<i>${esc(saved || "(空)")}</i>`);
          break;
        }

        case "show_memory": {
          const note = db.getAssistantMemory(memoryChatId, requesterId);
          pushResultBlock(note
            ? `🧠 <b>当前记忆</b>\n\n<i>${esc(note)}</i>`
            : "🧠 当前还没有记忆内容。");
          break;
        }

        case "clear_memory": {
          db.clearAssistantMemory(memoryChatId, requesterId);
          pushResultBlock("🧠 已清空当前记忆。");
          break;
        }

        case "get_global_daily_stats": {
          if (!isSuperAdminPrivate(ctx)) {
            pushResultBlock("🚫 全局统计仅管理员总控私聊可用。");
            break;
          }
          const stats = db.getGlobalDailyStats();
          const details = [...stats.details].sort((a, b) => b.count - a.count);
          const lines = await Promise.all(details.map(async (item) => {
            const chat = await resolveChatDisplay(item.chatId);
            return `• <a href="${chat.chatLink.replace(/&/g, "&amp;").replace(/"/g, "%22")}">${esc(chat.chatName)}</a>: <code>${item.count}</code>`;
          }));
          if (!lines.length) {
            pushResultBlock([`🌐 <b>全局 24h 处理统计</b>`, `• 总处理量: <code>${stats.totalSpanned}</code>`, ``, `暂无明细`].join("\n"));
            break;
          }
          setPagedResult({
            prefix: [`🌐 <b>全局 24h 处理统计</b>`, `• 总处理量: <code>${stats.totalSpanned}</code>`].join("\n"),
            items: lines,
            pageSize: 20,
          });
          break;
        }

        case "list_enabled_groups": {
          if (!isSuperAdminPrivate(ctx)) {
            pushResultBlock("🚫 群组列表仅管理员总控私聊可用。");
            break;
          }
          const groupIds = db.getAllEnabledGroups();
          if (!groupIds.length) {
            pushResultBlock("📭 当前没有开启基础反垃圾的群组。");
            break;
          }
          const lines = await Promise.all(groupIds.map(async (gid) => {
            const chat = await resolveChatDisplay(gid);
            const href = chat.chatLink.replace(/&/g, "&amp;").replace(/"/g, "%22");
            return `• <a href="${href}">${esc(chat.chatName)}</a> (<code>${gid}</code>)`;
          }));
          setPagedResult({
            prefix: `🏘️ <b>已启用群组 (${groupIds.length})</b>`,
            items: lines,
            pageSize: 20,
          });
          break;
        }
      }
    }

    if (pagedResult) {
      const paged: AssistantPagedPayload = pagedResult;
      return {
        paged: {
          prefix: [leadingBlocks.join("\n\n"), paged.prefix].filter(Boolean).join("\n\n"),
          items: paged.items,
          suffix: trailingBlocks.join("\n\n") || undefined,
          pageSize: paged.pageSize,
        },
      };
    }

    return { text: leadingBlocks.join("\n\n") };
  };

  const handleAdminAssistantRequest = async (
    ctx: Context,
    chatId: number,
    userId: number,
    requestText: string,
    pendingReply?: PendingReplyMessage | null
  ): Promise<boolean> => {
    const reusedPendingReply = pendingReply !== undefined;
    const lotteryDraftKey = `${chatId}:${userId}`;
    const isForwardedRequest = ctx.chat?.type !== "private" && isForwardedTelegramMessage(ctx.message as any);
    const replyTarget = ctx.message?.reply_to_message?.from;
    const originalReplyTarget = (ctx.message?.reply_to_message as any)?.reply_to_message?.from;
    const repliedMessageText = ctx.message?.reply_to_message?.text || ctx.message?.reply_to_message?.caption || "";
    const groupConfig = ctx.chat?.type === "private" ? null : db.getGroupConfig(chatId);
    const requesterIsAdmin = ctx.chat?.type === "private" ? isSuperAdminPrivate(ctx) : await checkIsAdmin(ctx, chatId, userId);

    if (ctx.chat?.type !== "private") {
      const pendingLotteryDraft = pendingAssistantLotteryDrafts.get(lotteryDraftKey);
      if (pendingLotteryDraft && Date.now() - pendingLotteryDraft.createdAt <= ASSISTANT_CONFIRM_TTL_MS) {
        const resumedLotteryIntent = await resolveAssistantLotteryIntent(buildAssistantLotteryDraftPrompt(pendingLotteryDraft.spec, requestText), chatId);
        if (resumedLotteryIntent.kind === "ready") {
          if (isForwardedRequest) {
            await deletePendingReplyMessage(ctx, pendingReply);
            pendingAssistantLotteryDrafts.delete(lotteryDraftKey);
            await replyTempNotice(ctx,
              "⚠️ 为防止转发复用，抽奖自然语言不接受转发消息，请直接重新发送抽奖要求。",
              {
                ...(ctx.message ? { reply_parameters: { message_id: ctx.message.message_id } } : {}),
              },
              15_000
            );
            await tryDeleteSourceMessage(ctx);
            return true;
          }
          try {
            await createLotteryFromSpec(ctx, resumedLotteryIntent.spec);
          } catch (error: any) {
            await deletePendingReplyMessage(ctx, pendingReply);
            await ctx.reply(`⚠️ ${esc(String(error?.message || error || "创建抽奖失败"))}`, {
              parse_mode: "HTML",
              ...(ctx.message ? { reply_parameters: { message_id: ctx.message.message_id } } : {}),
            });
            pendingAssistantLotteryDrafts.delete(lotteryDraftKey);
            return true;
          }
          await deletePendingReplyMessage(ctx, pendingReply);
          await tryDeleteSourceMessage(ctx);
          pendingAssistantLotteryDrafts.delete(lotteryDraftKey);
          db.addAssistantAuditLog(chatId, userId, requestText, JSON.stringify({ action: "create_lottery_from_draft", spec: resumedLotteryIntent.spec }), "executed", `created lottery: ${resumedLotteryIntent.spec.descCondition}`);
          return true;
        }
      }

      const provokeRule = parseAssistantProvokeGuardCommand(requestText);
      if (provokeRule) {
        if (!requesterIsAdmin) {
          await ctx.reply(getAssistantGroupPermissionDeniedText(), {
            parse_mode: "HTML",
            ...(ctx.message ? { reply_parameters: { message_id: ctx.message.message_id } } : {}),
          });
          return true;
        }
        db.setAssistantProvokeGuard(chatId, provokeRule.enabled, "warn_then_mute", provokeRule.muteMinutes, userId);
        const replyText = provokeRule.enabled
          ? `🛡️ 已开启“挑衅机器人自动处理”规则。\n\n当前模式：先警告，再次挑衅自动禁言 <code>${provokeRule.muteMinutes}</code> 分钟。\n<i>仅对明显在挑衅/辱骂机器人的消息生效。</i>`
          : "🛡️ 已关闭“挑衅机器人自动处理”规则。";
        db.addAssistantAuditLog(chatId, userId, requestText, JSON.stringify({ action: "set_provoke_guard", enabled: provokeRule.enabled, muteMinutes: provokeRule.muteMinutes }), "executed", replyText);
        await ctx.reply(replyText, {
          parse_mode: "HTML",
          ...(ctx.message ? { reply_parameters: { message_id: ctx.message.message_id } } : {}),
        });
        return true;
      }

      const lotteryIntent = await resolveAssistantLotteryIntent(requestText, chatId);
      if (lotteryIntent.kind !== "not_lottery" && isForwardedRequest) {
        await deletePendingReplyMessage(ctx, pendingReply);
        pendingAssistantLotteryDrafts.delete(lotteryDraftKey);
        await replyTempNotice(ctx,
          "⚠️ 为防止转发复用，抽奖自然语言不接受转发消息，请直接重新发送抽奖要求。",
          {
            ...(ctx.message ? { reply_parameters: { message_id: ctx.message.message_id } } : {}),
          },
          15_000
        );
        await tryDeleteSourceMessage(ctx);
        return true;
      }
      if (lotteryIntent.kind === "missing_condition") {
        await deletePendingReplyMessage(ctx, pendingReply);
        pendingAssistantLotteryDrafts.set(lotteryDraftKey, {
          chatId,
          userId,
          spec: lotteryIntent.spec,
          createdAt: Date.now(),
        });
        const prizeText = lotteryIntent.spec.prizes.map((p) => `${p.name}*${p.count}`).join("，");
        const extra: string[] = [];
        if ((lotteryIntent.spec.minActivity || 0) > 0) extra.push(`发言要求 ${lotteryIntent.spec.minActivity}`);
        if ((lotteryIntent.spec.minPoints || 0) > 0) extra.push(`积分要求 ${lotteryIntent.spec.minPoints}`);
        if (lotteryIntent.spec.remark) extra.push(`备注：${lotteryIntent.spec.remark}`);
        await ctx.reply(
          [
            "🎁 我已经识别到这是一条创建抽奖的要求。",
            `奖品：${prizeText}`,
            ...(extra.length ? [extra.join(" | ")] : []),
            "",
            "还缺少开奖条件，请补充其中一种：",
            "• 定时开奖：例如 <code>2小时后开</code> / <code>30分钟后开</code>",
            "• 满人数开奖：例如 <code>满100人开</code>",
            "• 手动开奖：例如 <code>先发，我手动开奖</code>",
          ].join("\n"),
          {
            parse_mode: "HTML",
            ...(ctx.message ? { reply_parameters: { message_id: ctx.message.message_id } } : {}),
          }
        );
        return true;
      }

      if (lotteryIntent.kind === "ready") {
        try {
          await createLotteryFromSpec(ctx, lotteryIntent.spec);
        } catch (error: any) {
          await deletePendingReplyMessage(ctx, pendingReply);
          await ctx.reply(`⚠️ ${esc(String(error?.message || error || "创建抽奖失败"))}`, {
            parse_mode: "HTML",
            ...(ctx.message ? { reply_parameters: { message_id: ctx.message.message_id } } : {}),
          });
          pendingAssistantLotteryDrafts.delete(lotteryDraftKey);
          return true;
        }
        await deletePendingReplyMessage(ctx, pendingReply);
        await tryDeleteSourceMessage(ctx);
        pendingAssistantLotteryDrafts.delete(lotteryDraftKey);
        db.addAssistantAuditLog(chatId, userId, requestText, JSON.stringify({ action: "create_lottery", spec: lotteryIntent.spec }), "executed", `created lottery: ${lotteryIntent.spec.descCondition}`);
        return true;
      }
    }

    const effectivePendingReply = pendingReply ?? (ctx.chat?.type !== "private" && ctx.message?.message_id
      ? await createPendingReplyMessage(ctx, chatId, ctx.message.message_id)
      : null);

    const prompt = [
      `场景: ${ctx.chat?.type === "private" ? "私聊" : "群组"}`,
      `是否总控私聊: ${isSuperAdminPrivate(ctx) ? "是" : "否"}`,
      `请求者角色: ${ctx.chat?.type === "private" ? (requesterIsAdmin ? "总控私聊" : "私聊用户") : requesterIsAdmin ? "群管理员" : "普通群员"}`,
      `当前 chat_id: ${chatId}`,
      `回复目标: ${replyTarget ? `${getUserName(replyTarget)} (${replyTarget.id})${replyTarget.username ? ` @${replyTarget.username}` : ""}` : "无"}`,
      `回复链原始目标: ${originalReplyTarget ? `${getUserName(originalReplyTarget)} (${originalReplyTarget.id})${originalReplyTarget.username ? ` @${originalReplyTarget.username}` : ""}` : "无"}`,
      `被回复消息内容: ${repliedMessageText || "无"}`,
      `当前群配置: ${groupConfig ? JSON.stringify(groupConfig) : "private"}`,
      `当前助理能力:\n${buildAssistantCapabilitySnapshot(ctx, requesterIsAdmin)}`,
      `权限要求: ${ctx.chat?.type === "private" || requesterIsAdmin ? "可使用当前能力清单里的全部适用能力" : "普通群员不能使用群配置、禁言、白名单、日志、他人积分/活跃、全群偷油记录、挑衅规则等管理员能力；只能使用成员本来就有权限的自然语言能力"}`,
      `请求者原话: ${requestText}`,
    ].join("\n");

    let parsedPlan: AssistantPlan | null = resolveLocalAssistantPlan(ctx, requestText);
    const usedLocalPlan = !!parsedPlan;
    if (!parsedPlan) {
      try {
        const response = await callAI([
          { role: "system", content: ADMIN_ASSISTANT_SYSTEM_PROMPT },
          { role: "user", content: prompt },
        ], 900, 0.2, true, ctx.chat?.type === "private" ? undefined : getChatAIProvider(chatId));
        parsedPlan = parseAssistantPlan(extractJson(response.content || ""));
      } catch (error) {
        if (ctx.chat?.type !== "private" && !requesterIsAdmin) {
          if (!reusedPendingReply) {
            await deletePendingReplyMessage(ctx, effectivePendingReply);
          }
          return false;
        }
        const reason = String((error as any)?.message || error || "未知错误");
        db.addAssistantAuditLog(chatId, userId, requestText, "", "parse_failed", reason);
        await sendOrEditPendingReply(ctx, effectivePendingReply, `⚠️ 管理助理暂时不可用：${esc(reason)}`, {
          parse_mode: "HTML",
        });
        return true;
      }
    }

    if (!parsedPlan) {
      if (ctx.chat?.type !== "private" && !requesterIsAdmin) {
        if (!reusedPendingReply) {
          await deletePendingReplyMessage(ctx, effectivePendingReply);
        }
        return false;
      }
      db.addAssistantAuditLog(chatId, userId, requestText, "", "invalid_plan", "模型未返回有效计划");
      await sendOrEditPendingReply(ctx, effectivePendingReply, "⚠️ 我没能稳定理解这条要求。你可以换个说法，或直接回复目标用户再说一次。");
      return true;
    }

    if (
      ctx.chat?.type !== "private" &&
      !requesterIsAdmin &&
      !usedLocalPlan &&
      parsedPlan.mode === "reply" &&
      !looksLikeAssistantHelpQuestion(requestText)
    ) {
      if (!reusedPendingReply) {
        await deletePendingReplyMessage(ctx, effectivePendingReply);
      }
      return false;
    }

    const planJson = JSON.stringify(parsedPlan);
    if (parsedPlan.mode === "reply") {
      const replyText = parsedPlan.reply || parsedPlan.summary;
      db.addAssistantAuditLog(chatId, userId, requestText, planJson, "reply", replyText);
      await sendOrEditPendingReply(ctx, effectivePendingReply, replyText, {
        link_preview_options: { is_disabled: true },
      });
      return true;
    }

    let resolvedPlan: ResolvedAssistantPlan;
    try {
      resolvedPlan = await materializeAssistantPlan(ctx, chatId, parsedPlan);
    } catch (error) {
      const reason = String((error as any)?.message || error || "无法执行");
      db.addAssistantAuditLog(chatId, userId, requestText, planJson, "validation_failed", reason);
      await sendOrEditPendingReply(ctx, effectivePendingReply, `⚠️ 这个要求我理解到了，但当前还没法安全执行：${esc(reason)}`, {
        parse_mode: "HTML",
      });
      return true;
    }

    const accessDeniedReason = getAssistantPlanAccessDenyReason(resolvedPlan, userId, requesterIsAdmin, ctx.chat?.type === "private");
    if (accessDeniedReason) {
      db.addAssistantAuditLog(chatId, userId, requestText, planJson, "permission_denied", accessDeniedReason);
      await sendOrEditPendingReply(ctx, effectivePendingReply, `${getAssistantGroupPermissionDeniedText()}\n\n<i>${esc(accessDeniedReason)}</i>`, {
        parse_mode: "HTML",
      });
      return true;
    }

    if (planNeedsConfirmation(resolvedPlan)) {
      const token = createAssistantToken();
      pendingAssistantActions.set(token, {
        chatId,
        userId,
        requestText,
        summary: resolvedPlan.summary,
        plan: resolvedPlan,
        createdAt: Date.now(),
      });
      const actionLines = await Promise.all(resolvedPlan.actions.map((action) => describeAssistantAction(ctx, chatId, action)));
      const keyboard = new InlineKeyboard()
        .text("✅ 确认执行", `aiassist_confirm_${token}`)
        .text("❌ 取消", `aiassist_cancel_${token}`);
      const text = [
        `🧠 <b>管理助理执行确认</b>`,
        ``,
        `我理解你的意思是：${esc(resolvedPlan.summary)}`,
        ``,
        ...actionLines.map((line) => `• ${line}`),
        ``,
        `<i>高风险动作需要你点按钮确认，10 分钟后失效。</i>`,
      ].join("\n");
      db.addAssistantAuditLog(chatId, userId, requestText, planJson, "pending_confirm", resolvedPlan.summary);
      await sendOrEditPendingReply(ctx, effectivePendingReply, text, {
        parse_mode: "HTML",
        reply_markup: keyboard,
      });
      return true;
    }

    const result = await executeAssistantPlan(ctx, chatId, userId, resolvedPlan);
    db.addAssistantAuditLog(chatId, userId, requestText, planJson, "executed", assistantExecutionResultToAuditText(result));
    await sendAssistantExecutionResult(ctx, chatId, result, ctx.message?.message_id, effectivePendingReply);
    return true;
  };

  type PointsImportParseResult =
    | { kind: "empty" }
    | { kind: "invalid" }
    | { kind: "ok"; userId: number; points: number };

  const parsePointsImportLine = (line: string): PointsImportParseResult => {
    const raw = (line || "").trim();
    if (!raw || raw.startsWith("#") || raw.startsWith("//")) return { kind: "empty" };

    // 支持:
    // 1) 123456 100
    // 2) 123456,100
    // 3) 1. 123456 100
    const m = raw.match(/^(?:\d+[.)、]\s*)?(-?\d+)\s*[,，:：;；|\t ]+\s*(-?\d+)\s*$/);
    if (!m) return { kind: "invalid" };

    const userId = Number(m[1]);
    const points = Number(m[2]);
    if (!Number.isFinite(userId) || !Number.isFinite(points) || userId <= 0) return { kind: "invalid" };
    return { kind: "ok", userId: Math.trunc(userId), points: Math.trunc(points) };
  };

  type InviteVoucherLog = { code: string; status: string; creator_id: number; used_by_id: number | null; created_at: string };
  const INVITE_LOG_USERS_PER_PAGE = 10;

  const inviteVoucherStatusText = (status: string): string => {
    if (status === "active") return "未使用";
    if (status === "used") return "已使用";
    if (status === "revoked") return "已作废";
    return status;
  };

  const inviteVoucherStatusIcon = (status: string): string => {
    if (status === "active") return "✅";
    if (status === "used") return "☑️";
    if (status === "revoked") return "❌";
    return inviteVoucherStatusText(status);
  };

  const formatInviteVoucherTime = (createdAt: string): string => {
    return new Date(createdAt + "Z").toLocaleString("zh-CN", {
      timeZone: "Asia/Shanghai",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).replace(/\//g, "-");
  };

  const formatInviteVoucherDate = (createdAt: string): string => {
    return new Date(createdAt + "Z").toLocaleDateString("zh-CN", {
      timeZone: "Asia/Shanghai",
      month: "2-digit",
      day: "2-digit",
    }).replace(/\//g, "-");
  };

  const CHAT_DISPLAY_CACHE_TTL = 5 * 60_000;
  const chatDisplayCache = new Map<number, { expiresAt: number; chatName: string; chatLink: string }>();

  const resolveChatDisplay = async (chatId: number): Promise<{ chatName: string; chatLink: string }> => {
    const cached = chatDisplayCache.get(chatId);
    if (cached && cached.expiresAt > Date.now()) {
      return { chatName: cached.chatName, chatLink: cached.chatLink };
    }

    let chatName = String(chatId);
    let chatLink = "";
    try {
      const chat = await bot.api.getChat(chatId);
      if (chat && "title" in chat && chat.title) chatName = chat.title;
      if (chat && "username" in chat && chat.username) {
        chatLink = `https://t.me/${chat.username}`;
      } else if (chat && "invite_link" in chat && chat.invite_link) {
        chatLink = chat.invite_link;
      }
    } catch { }

    if (!chatLink) {
      const chatIdStr = String(chatId);
      chatLink = chatIdStr.startsWith("-100")
        ? `https://t.me/c/${chatIdStr.slice(4)}/1`
        : `tg://resolve?id=${Math.abs(chatId)}`;
    }

    chatDisplayCache.set(chatId, {
      expiresAt: Date.now() + CHAT_DISPLAY_CACHE_TTL,
      chatName,
      chatLink,
    });

    return { chatName, chatLink };
  };

  const renderChatReference = async (chatId: number, options?: { includeId?: boolean }): Promise<string> => {
    const { chatName, chatLink } = await resolveChatDisplay(chatId);
    const safeChatLink = chatLink.replace(/&/g, "&amp;").replace(/"/g, "%22");
    return `<a href="${safeChatLink}">${esc(chatName)}</a>${options?.includeId ? ` (<code>${chatId}</code>)` : ""}`;
  };

  const getGlobalBanSyncGroupIds = (sourceChatId?: number): number[] => {
    const ids = new Set<number>(db.getGlobalBanEnabledGroups());
    if (sourceChatId !== undefined) ids.add(sourceChatId);
    return [...ids];
  };

  const VOUCHER_DETAIL_PAGE_SIZE = 20;

  const buildUserVoucherDetailPage = async (
    chatId: number,
    userId: number,
    userName: string,
    page: number
  ): Promise<null | { text: string; keyboard?: InlineKeyboard; page: number; totalPages: number }> => {
    const vouchers = db.getUserVouchers(chatId, userId);
    if (vouchers.length === 0) return null;

    const { chatName, chatLink } = await resolveChatDisplay(chatId);
    const safeChatLink = chatLink.replace(/&/g, "&amp;").replace(/"/g, "%22");
    const totalPages = Math.max(1, Math.ceil(vouchers.length / VOUCHER_DETAIL_PAGE_SIZE));
    const safePage = Math.min(Math.max(page, 0), totalPages - 1);
    const start = safePage * VOUCHER_DETAIL_PAGE_SIZE;
    const rows = vouchers.slice(start, start + VOUCHER_DETAIL_PAGE_SIZE);
    const lines = rows.map((v, idx) => {
      const status = inviteVoucherStatusIcon(v.status);
      const time = formatInviteVoucherTime(v.created_at);
      return `• <code>${v.code}</code> [${status}] <code>${time}</code>`;
    });

    const text = [
      `📋 <b>我的邀请券明细</b>`,
      ``,
      `👤 用户: <a href="tg://user?id=${userId}">${esc(userName)}</a>`,
      `🏢 群组: <b><a href="${safeChatLink}">${esc(chatName)}</a></b>`,
      `📦 总记录: <code>${vouchers.length}</code>（第 ${safePage + 1}/${totalPages} 页）`,
      ``,
      ...lines,
      ``,
      `<i>✅:可用  ☑️:已核  ❌:无效</i>`,
    ].join("\n");

    let keyboard: InlineKeyboard | undefined;
    if (totalPages > 1) {
      keyboard = new InlineKeyboard();
      if (safePage > 0) {
        keyboard.text("⬅️ 上一页", `yq_page_${chatId}_${safePage - 1}`);
      }
      if (safePage < totalPages - 1) {
        keyboard.text("下一页 ➡️", `yq_page_${chatId}_${safePage + 1}`);
      }
    }

    return {
      text,
      keyboard,
      page: safePage,
      totalPages,
    };
  };

  const buildInviteVoucherLogsPage = async (
    ctx: Context,
    chatId: number,
    page: number
  ): Promise<null | { text: string; keyboard: InlineKeyboard; page: number; totalPages: number }> => {
    const logs = db.getInviteVoucherLogs(chatId) as InviteVoucherLog[];
    if (logs.length === 0) return null;

    const grouped = new Map<number, InviteVoucherLog[]>();
    for (const log of logs) {
      const list = grouped.get(log.creator_id) || [];
      list.push(log);
      grouped.set(log.creator_id, list);
    }

    const creatorGroups = Array.from(grouped.entries());
    const totalPages = Math.max(1, Math.ceil(creatorGroups.length / INVITE_LOG_USERS_PER_PAGE));
    const safePage = Math.min(Math.max(page, 0), totalPages - 1);
    const start = safePage * INVITE_LOG_USERS_PER_PAGE;
    const pageGroups = creatorGroups.slice(start, start + INVITE_LOG_USERS_PER_PAGE);

    const groupLines = await Promise.all(pageGroups.map(async ([creatorId, creatorLogs], idx) => {
      const creator = await renderUserLink(ctx, chatId, creatorId);
      const detailLines = await Promise.all(creatorLogs.map(async (log) => {
        const status = inviteVoucherStatusIcon(log.status);
        const date = formatInviteVoucherDate(log.created_at);
        let usedBySuffix = "";
        if (log.status === "used" && log.used_by_id) {
          const usedByLink = await renderUserLink(ctx, chatId, log.used_by_id);
          usedBySuffix = ` [${usedByLink}]`;
        }
        return `• <code>${esc(log.code)}</code> [${status}] - 时间: ${date}${usedBySuffix}`;
      }));

      return [
        `${start + idx + 1}. 发放: ${creator}（${creatorLogs.length} 条）`,
        ...detailLines,
      ].join("\n");
    }));

    const text = `<b>🎟️ 邀请码记录</b>（共 ${logs.length} 条 / ${creatorGroups.length} 位发放人，第 ${safePage + 1}/${totalPages} 页）\n\n${groupLines.join("\n\n")}`;
    const keyboard = new InlineKeyboard();
    if (safePage > 0) {
      keyboard.text("⬅️ 上一页", `ads_invite_logs_${chatId}_${safePage - 1}`);
    }
    if (safePage < totalPages - 1) {
      keyboard.text("下一页 ➡️", `ads_invite_logs_${chatId}_${safePage + 1}`);
    }
    keyboard.row().text("⬅️ 返回群组设置", "ads_invitation");

    return { text, keyboard, page: safePage, totalPages };
  };

  const POINTS_RANK_PAGE_SIZE = 20;
  const POINTS_LEDGER_PAGE_SIZE = 20;
  const POINTS_LEDGER_RECENT_DAYS_LIMIT = 20;
  const CHINA_TZ_OFFSET_MS = 8 * 60 * 60 * 1000;
  const DAY_MS = 24 * 60 * 60 * 1000;
  const getChinaDayKey = (ms: number): string => {
    return new Date(ms + CHINA_TZ_OFFSET_MS).toISOString().slice(0, 10);
  };

  const normalizePointReason = (reason: string, amount: number): string => {
    const r = (reason || "").trim();
    if (r.includes("中奖入账")) return "中奖入账";
    if (r.includes("活跃发言")) return "活跃发言";
    if (r.includes("小鼠偷家")) return "小鼠偷家";
    if (r.includes("关门打鼠")) return "关门打鼠";
    if (r.includes("被偷油")) return "小鼠偷家";
    if (r.includes("偷油达人")) return amount >= 0 ? "小鼠偷家" : "关门打鼠";
    if (r.includes("兑换邀请券") || r.includes("邀请兑换")) return "邀请兑换";
    if (r.includes("积分商城兑换")) return "商城兑换";
    if (r.includes("抽奖") || (amount < 0 && r.includes("积分支出"))) return "群组抽奖";
    if (
      r.includes("管理调整") ||
      r.includes("管理员调整") ||
      r.includes("手动调整") ||
      r.includes("积分导入") ||
      r.includes("批量导入")
    ) return "管理调整";
    return r || (amount >= 0 ? "积分增加" : "积分扣除");
  };

  const buildPointsLedgerPage = async (
    ctx: Context,
    chatId: number,
    userId: number,
    page: number
  ): Promise<null | { text: string; keyboard: InlineKeyboard; page: number; totalPages: number }> => {
    const cutoffDayKey = getChinaDayKey(Date.now() - (POINTS_LEDGER_RECENT_DAYS_LIMIT - 1) * DAY_MS);
    const rawLogs = db.getPointLogs(chatId, userId, 2000, 0);
    const currentTotal = db.getUserPoints(chatId, userId).total;

    const ledgerRows: Array<{
      dayKey: string;
      dayLabel: string;
      amount: number;
      reason: string;
      balanceAfter: number;
    }> = [];
    const activeDayIndex = new Map<string, number>();
    let newerAmountSum = 0;

    for (const log of rawLogs) {
      const d = new Date(log.created_at + "Z");
      const dayKey = getChinaDayKey(d.getTime());
      if (dayKey < cutoffDayKey) break;
      const dayLabel = d.toLocaleDateString("zh-CN", {
        timeZone: "Asia/Shanghai",
        month: "numeric",
        day: "numeric"
      });

      const balanceAfter = currentTotal - newerAmountSum;
      newerAmountSum += log.amount;

      const reason = normalizePointReason(log.reason, log.amount);

      if (reason === "活跃发言" && log.amount > 0) {
        const index = activeDayIndex.get(dayKey);
        if (index === undefined) {
          activeDayIndex.set(dayKey, ledgerRows.length);
          ledgerRows.push({
            dayKey,
            dayLabel,
            amount: log.amount,
            reason: "活跃发言",
            balanceAfter,
          });
        } else {
          ledgerRows[index].amount += log.amount;
        }
      } else {
        ledgerRows.push({
          dayKey,
          dayLabel,
          amount: log.amount,
          reason,
          balanceAfter,
        });
      }
    }

    if (ledgerRows.length === 0) return null;

    const totalPages = Math.max(1, Math.ceil(ledgerRows.length / POINTS_LEDGER_PAGE_SIZE));
    const safePage = Math.min(Math.max(page, 0), totalPages - 1);
    const offset = safePage * POINTS_LEDGER_PAGE_SIZE;
    const displayLogs = ledgerRows.slice(offset, offset + POINTS_LEDGER_PAGE_SIZE);

    let text = `📊 <b>积分历史流水 (最近20天，第 ${safePage + 1}/${totalPages} 页)</b>\n\n`;
    displayLogs.forEach(log => {
      const symbol = log.amount > 0 ? "+" : "";
      text += `📅 ${log.dayLabel} | <b>${symbol}${log.amount}</b> | ${esc(log.reason)} (${log.balanceAfter})\n`;
    });

    const keyboard = new InlineKeyboard();
    if (safePage > 0) {
      keyboard.text("⬅️ 上一页", `ads_jf_logs_${chatId}_${safePage - 1}`);
    }
    if (safePage < totalPages - 1) {
      keyboard.text("下一页 ➡️", `ads_jf_logs_${chatId}_${safePage + 1}`);
    }
    keyboard.row().text("⬅️ 返回", `ads_jf_back_${chatId}`);

    return { text, keyboard, page: safePage, totalPages };
  };

  const buildPointsRankPage = async (
    ctx: Context,
    chatId: number,
    page: number
  ): Promise<null | { text: string; keyboard: InlineKeyboard; page: number; totalPages: number }> => {
    const totalUsers = db.getPointsLeaderboardCount(chatId);
    if (totalUsers <= 0) return null;

    const totalPages = Math.max(1, Math.ceil(totalUsers / POINTS_RANK_PAGE_SIZE));
    const safePage = Math.min(Math.max(page, 0), totalPages - 1);
    const offset = safePage * POINTS_RANK_PAGE_SIZE;
    const rows = db.getPointsLeaderboard(chatId, POINTS_RANK_PAGE_SIZE, offset);

    const lines = await Promise.all(rows.map(async (row, idx) => {
      const rank = offset + idx + 1;
      const user = await renderUserLink(ctx, chatId, row.user_id);
      return `${rank}. ${user} — <code>${row.points}</code>`;
    }));

    const currentUserId = ctx.from?.id;
    const myLine = currentUserId
      ? (() => {
        const myPoints = db.getUserPoints(chatId, currentUserId).total;
        const myRank = db.getUserPointsRank(chatId, currentUserId);
        return myRank
          ? `👤 我的排名: <b>#${myRank}</b> | 积分: <code>${myPoints}</code>`
          : `👤 我的积分: <code>${myPoints}</code>（未上榜）`;
      })()
      : `👤 当前积分: <code>0</code>`;

    const text = [
      `🏆 <b>积分排行榜 (第 ${safePage + 1}/${totalPages} 页)</b>`,
      ``,
      ...lines,
      ``,
      myLine,
    ].join("\n");

    const keyboard = new InlineKeyboard();
    if (safePage > 0) {
      keyboard.text("⬅️ 上一页", `ads_jf_rank_${chatId}_${safePage - 1}`);
    }
    if (safePage < totalPages - 1) {
      keyboard.text("下一页 ➡️", `ads_jf_rank_${chatId}_${safePage + 1}`);
    }
    keyboard.row().text("⬅️ 返回", `ads_jf_back_${chatId}`);

    return { text, keyboard, page: safePage, totalPages };
  };

  // ==================== 投票封禁状态管理 ====================
  interface PollData {
    chatId: number;
    userMessageId: number;
    pollMessageId: number;
    userId: number;
    userName: string;
    text: string;
    confidence: number;
    reason: string;
    detector: string;
    votesNotAd: Set<number>;
    votesIsAd: Set<number>;
    timeout: NodeJS.Timeout;
  }
  const activePolls = new Map<string, PollData>();
  const activePollsByUser = new Map<string, string>();

  function buildActivePollUserKey(chatId: number, userId: number): string {
    return `${chatId}:${userId}`;
  }

  function getActivePollForUser(chatId: number, userId: number): PollData | null {
    const pollKey = activePollsByUser.get(buildActivePollUserKey(chatId, userId));
    if (!pollKey) return null;
    const poll = activePolls.get(pollKey);
    if (poll) return poll;
    activePollsByUser.delete(buildActivePollUserKey(chatId, userId));
    return null;
  }

  function registerActivePoll(pollKey: string, poll: PollData): void {
    activePolls.set(pollKey, poll);
    activePollsByUser.set(buildActivePollUserKey(poll.chatId, poll.userId), pollKey);
  }

  function unregisterActivePoll(poll: PollData): void {
    activePolls.delete(`${poll.chatId}:${poll.pollMessageId}`);
    const userKey = buildActivePollUserKey(poll.chatId, poll.userId);
    const mappedPollKey = activePollsByUser.get(userKey);
    if (mappedPollKey === `${poll.chatId}:${poll.pollMessageId}`) {
      activePollsByUser.delete(userKey);
    }
  }

  function findRelatedPolls(chatId: number, options: { userId?: number; userMessageId?: number; pollMessageId?: number }): PollData[] {
    const polls: PollData[] = [];
    for (const poll of activePolls.values()) {
      if (poll.chatId !== chatId) continue;
      if (options.pollMessageId && poll.pollMessageId === options.pollMessageId) {
        polls.push(poll);
        continue;
      }
      if (options.userMessageId && poll.userMessageId === options.userMessageId) {
        polls.push(poll);
        continue;
      }
      if (options.userId && poll.userId === options.userId) {
        polls.push(poll);
      }
    }
    return polls;
  }

  async function dismissPoll(poll: PollData): Promise<void> {
    clearTimeout(poll.timeout);
    unregisterActivePoll(poll);
    try {
      await bot.api.deleteMessage(poll.chatId, poll.pollMessageId);
    } catch (e: any) {
      if (!(e instanceof GrammyError) || e.description !== "Bad Request: message to delete not found") {
        console.error("[AntiSpam] 删除投票消息失败:", e);
      }
    }
  }

  async function executeBan(poll: PollData, ctx: Context, banReasonOverride?: string) {
    clearTimeout(poll.timeout);
    unregisterActivePoll(poll);

    const { chatId, userId, userName, text, confidence, reason, userMessageId, detector } = poll;
    const finalReason = banReasonOverride ? `${reason} (${banReasonOverride})` : reason;
    const detectLabel = detector === "LocalSamples" ? "本地样本匹配" : "AI 检测";

    // 查找邀请人 (报备问责)
    const inviterInfo = db.getInviterInfo(chatId, userId);
    let inviterText = "";
    if (inviterInfo) {
      const inviterLink = await renderUserLink(ctx, chatId, inviterInfo.id);
      inviterText = `\n👤 <b>邀请人:</b> ${inviterLink} (<code>${inviterInfo.id}</code>)`;
    }

    let sourceMessageRemoved = false;
    try {
      await bot.api.deleteMessage(chatId, userMessageId);
      sourceMessageRemoved = true;
    } catch (e: any) {
      if (isMessageDeleteUnavailableError(e)) {
        sourceMessageRemoved = true;
      } else {
        console.error("[AntiSpam] 投票后删除消息失败:", e);
      }
    }

    let bannedInCurrentChat = false;
    try {
      await banUserPermanently(bot.api, chatId, userId);
      bannedInCurrentChat = true;
    } catch (e) {
      console.error("[AntiSpam] 投票后封禁用户失败:", e);
    }

    let deletedRecentCount = 0;
    if (bannedInCurrentChat) {
      deletedRecentCount = await deleteRecentUserMessages(bot.api, chatId, userId);
    }
    if (sourceMessageRemoved) deletedRecentCount += 1;

    db.addSample(chatId, text || "[纯图片]", true, 0);
    db.addLog(chatId, userId, userName, text || "[纯图片]", confidence, finalReason);
    db.addGlobalBan(userId, userName, finalReason, confidence, chatId);

    const allGroups = getGlobalBanSyncGroupIds(chatId);
    const staleGroupIds: number[] = [];
    for (const gid of allGroups) {
      if (gid === chatId) continue;
      try {
        await banUserPermanently(bot.api, gid, userId);
        await deleteRecentUserMessages(bot.api, gid, userId);
        const crossNotice = await bot.api.sendMessage(
          gid,
          [
            `🚫 <b>跨群联动封禁</b>`,
            ``,
            `👤 用户: <b><a href="tg://user?id=${userId}">${esc(userName)}</a></b> (<code>${userId}</code>)`,
            `📊 匹配值: <code>${(confidence * 100).toFixed(1)}%</code>`,
            `📝 原因: ${esc(finalReason)}`,
            `📍 来源: 该用户在其他群组被${detectLabel}判定为广告，且投票未通过并封禁`,
            ``,
            `<i>已自动同步封禁。</i>`,
          ].join("\n"),
          { parse_mode: "HTML" }
        );
        setTimeout(async () => {
          try { await bot.api.deleteMessage(gid, crossNotice.message_id); } catch { }
        }, 15_000);
      } catch (e: any) {
        if (e instanceof GrammyError && e.description.includes("user is an administrator")) {
          // 忽略管理员报错
        } else if (isGroupUnavailableError(e)) {
          staleGroupIds.push(gid);
        } else {
          console.error(`[AntiSpam] 跨群封禁失败 (群 ${gid}):`, e);
        }
      }
    }
    if (staleGroupIds.length > 0) {
      for (const gid of staleGroupIds) {
        db.closeAllGroupSwitches(gid);
        adminCache.delete(gid);
      }
      console.warn(`[AntiSpam] 已自动清理 ${staleGroupIds.length} 个失效跨群封禁群组: ${staleGroupIds.join(", ")}`);
    }

    const chatRef = await renderChatReference(chatId);
    const ownerChatRef = await renderChatReference(chatId, { includeId: true });

    notifyAdmin(
      `🚨 <b>${detectLabel}封禁通知</b>\n\n` +
      `📝 <b>群组:</b> ${chatRef}\n` +
      `👤 <b>用户:</b> <a href="tg://user?id=${userId}">${esc(userName)}</a> (<code>${userId}</code>)${inviterText}`
    );
    await notifyCommercialChatOwner(
      chatId,
      `🚨 <b>你绑定的群已确认封禁广告用户</b>\n\n` +
      `📝 <b>群组:</b> ${ownerChatRef}\n` +
      `👤 <b>用户:</b> <a href="tg://user?id=${userId}">${esc(userName)}</a> (<code>${userId}</code>)\n` +
      `📊 <b>匹配度:</b> ${(confidence * 100).toFixed(1)}%\n` +
      `🤖 <b>检测方式:</b> ${detectLabel}\n` +
      `📌 <b>原因:</b> ${esc(finalReason)}\n${inviterText ? inviterText + "\n" : ""}` +
      `💬 <b>消息内容:</b>\n<i>${formatPreview(text)}</i>`
    );

    try {
      await bot.api.editMessageText(
        chatId,
        poll.pollMessageId,
        `🚫 <b>已确认拦截垃圾广告</b>\n\n` +
        `👤 用户: <b><a href="tg://user?id=${userId}">${esc(userName)}</a></b> (<code>${userId}</code>)\n` +
        `📝 结果: ${banReasonOverride ? banReasonOverride : "投票超时，维持原判"}\n\n` +
        `<i>用户已被永久封禁！</i>`,
        { parse_mode: "HTML" }
      );

      // 通知消息 3 分钟后自动删除
      setTimeout(() => {
        bot.api.deleteMessage(chatId, poll.pollMessageId).catch(() => { });
      }, 3 * 60 * 1000);
    } catch (e) {
      console.error("[AntiSpam] 更新投票消息失败:", e);
    }
  }

  async function executeUnmute(poll: PollData, ctx: Context, byWhom: string) {
    clearTimeout(poll.timeout);
    unregisterActivePoll(poll);

    const { chatId, userId, userName, text } = poll;

    try {
      await bot.api.restrictChatMember(chatId, userId, {
        can_send_messages: true,
        can_send_audios: true,
        can_send_documents: true,
        can_send_photos: true,
        can_send_videos: true,
        can_send_video_notes: true,
        can_send_voice_notes: true,
        can_send_polls: true,
        can_send_other_messages: true,
        can_add_web_page_previews: true,
      });
    } catch (e) {
      console.error("[AntiSpam] 解除禁言失败:", e);
    }

    db.addSample(chatId, text || "[纯图片]", false, 0);

    const detectLabel = poll.detector === "LocalSamples" ? "本地样本匹配" : "AI 检测";
    const chatRef = await renderChatReference(chatId);
    notifyAdmin(
      `✅ <b>${detectLabel}误判已恢复通知</b>\n\n` +
      `📝 <b>群组:</b> ${chatRef}\n` +
      `👤 <b>用户:</b> <a href="tg://user?id=${userId}">${esc(userName)}</a> (<code>${userId}</code>)\n` +
      `📌 <b>恢复方式:</b> ${byWhom}\n` +
      `💬 <b>消息内容:</b>\n<i>${formatPreview(text)}</i>`
    );

    try {
      await bot.api.editMessageText(
        chatId,
        poll.pollMessageId,
        `✅ <b>已解除禁言</b>\n\n` +
        `👤 用户: <b><a href="tg://user?id=${userId}">${esc(userName)}</a></b> (<code>${userId}</code>)\n` +
        `📝 结果: 被 ${byWhom} 确认为正常消息\n\n` +
        `<i>已恢复发言权限，并已将其作为正常消息样本入库。</i>`,
        { parse_mode: "HTML" }
      );

      // 通知消息 3 分钟后自动删除
      setTimeout(() => {
        bot.api.deleteMessage(chatId, poll.pollMessageId).catch(() => { });
      }, 3 * 60 * 1000);
    } catch (e) {
      console.error("[AntiSpam] 更新投票消息失败:", e);
    }
  }

  async function createSuspiciousSpamPoll(
    ctx: Context,
    payload: {
      chatId: number;
      userId: number;
      userName: string;
      userMessageId: number;
      text: string;
      confidence: number;
      reason: string;
      detector: string;
      activityLabel: string;
      spamThreshold: number;
      replyToMessageId?: number;
      ownerNoticePrefix?: string;
    }
  ): Promise<boolean> {
    const {
      chatId,
      userId,
      userName,
      userMessageId,
      text,
      confidence,
      reason,
      detector,
      activityLabel,
      spamThreshold,
      replyToMessageId,
      ownerNoticePrefix,
    } = payload;

    const existingPoll = getActivePollForUser(chatId, userId);
    if (existingPoll) {
      if (userMessageId !== existingPoll.userMessageId) {
        try {
          await ctx.api.deleteMessage(chatId, userMessageId);
        } catch (e: any) {
          if (!isMessageDeleteUnavailableError(e)) {
            console.error("[AntiSpam] 删除活跃投票期间的后续消息失败:", e);
          }
        }
      }
      return false;
    }

    try {
      await ctx.api.restrictChatMember(chatId, userId, {
        can_send_messages: false,
        can_send_audios: false,
        can_send_documents: false,
        can_send_photos: false,
        can_send_videos: false,
        can_send_video_notes: false,
        can_send_voice_notes: false,
        can_send_polls: false,
        can_send_other_messages: false,
        can_add_web_page_previews: false,
      });
    } catch (e) {
      console.error("[AntiSpam] 创建投票前禁言用户失败:", e);
    }

    const alertTitle = detector === "LocalSamples"
      ? "🚨 <b>本地样本匹配到疑似广告</b> 🚨"
      : "🚨 <b>AI 检测到疑似广告</b> 🚨";

    const pollText =
      `${alertTitle}\n\n` +
      `👤 用户: <b><a href="tg://user?id=${userId}">${esc(userName)}</a></b> (<code>${userId}</code>)\n` +
      `📊 匹配度: <code>${(confidence * 100).toFixed(1)}%</code>\n` +
      `🎯 审查分层: <code>${esc(activityLabel)}</code>（阈值 <code>${spamThreshold.toFixed(2)}</code>）\n\n` +
      `<i>(需 ${POLL_VOTES_THRESHOLD} 名非本人的群友，或 1 名管理员投票)</i>\n` +
      `<i>❗如果在 2 分钟内未达标，将执行永久封禁。</i>`;
    const pollOptions = {
      parse_mode: "HTML" as const,
      link_preview_options: { is_disabled: true },
      reply_markup: {
        inline_keyboard: [[
          { text: `✅ 这是误杀 (0/${POLL_VOTES_THRESHOLD})`, callback_data: `vote_safe` },
          { text: `🚫 干掉广告 (0/${POLL_VOTES_THRESHOLD})`, callback_data: `vote_spam` }
        ]]
      }
    };

    let pollMsg: Awaited<ReturnType<typeof ctx.reply>>;
    try {
      pollMsg = await ctx.reply(pollText, {
        ...pollOptions,
        ...(replyToMessageId ? { reply_parameters: { message_id: replyToMessageId } } : {}),
      });
    } catch (e) {
      if (replyToMessageId && isReplyTargetMissingError(e)) {
        console.warn(`[AntiSpam] 投票发起前原消息已不存在，已跳过投票 | 群组: ${chatId} | 用户: ${userId}`);
        return false;
      }
      throw e;
    }

    const pollKey = `${chatId}:${pollMsg.message_id}`;
    registerActivePoll(pollKey, {
      chatId,
      userMessageId,
      pollMessageId: pollMsg.message_id,
      userId,
      userName,
      text,
      confidence,
      reason,
      detector,
      votesNotAd: new Set<number>(),
      votesIsAd: new Set<number>(),
      timeout: setTimeout(() => {
        const p = activePolls.get(pollKey);
        if (p) void executeBan(p, ctx, "投票超时，维持原判");
      }, 2 * 60 * 1000),
    });

    const detectorLabel = detector === "LocalSamples" ? "本地样本匹配" : "AI 检测";
    const chatRef = await renderChatReference(chatId);
    const ownerChatRef = await renderChatReference(chatId, { includeId: true });
    notifyAdmin(
      `⏳ <b>${detectorLabel}疑似广告等待投票中</b>\n\n` +
      `📝 <b>群组:</b> ${chatRef}\n` +
      `👤 <b>用户:</b> <a href="tg://user?id=${userId}">${esc(userName)}</a> (<code>${userId}</code>)\n` +
      `📊 <b>匹配度:</b> ${(confidence * 100).toFixed(1)}%\n` +
      `🎯 <b>审查分层:</b> ${esc(activityLabel)} (阈值 ${spamThreshold.toFixed(2)})\n` +
      `📌 <b>原因:</b> ${esc(reason)}\n` +
      `💬 <b>消息内容:</b>\n<i>${formatPreview(text)}</i>`
    );
    await notifyCommercialChatOwner(
      chatId,
      `${ownerNoticePrefix || "⏳ <b>你绑定的群检测到疑似广告</b>"}\n\n` +
      `📝 <b>群组:</b> ${ownerChatRef}\n` +
      `👤 <b>用户:</b> <a href="tg://user?id=${userId}">${esc(userName)}</a> (<code>${userId}</code>)\n` +
      `📊 <b>匹配度:</b> ${(confidence * 100).toFixed(1)}%\n` +
      `🎯 <b>审查分层:</b> ${esc(activityLabel)} (阈值 ${spamThreshold.toFixed(2)})\n` +
      `🤖 <b>检测方式:</b> ${detectorLabel}\n` +
      `📌 <b>原因:</b> ${esc(reason)}\n` +
      `💬 <b>消息内容:</b>\n<i>${formatPreview(text)}</i>\n\n` +
      `<i>群内当前正在进行投票处置。</i>`
    );
    return true;
  }

  async function summonAdminsForReportedMessage(ctx: Context, chatId: number, reporterId: number, reply: any): Promise<void> {
    const me = await ctx.api.getMe().catch(() => null);
    const adminMembers = await ctx.api.getChatAdministrators(chatId).catch(() => []);
    const targetId = reply.from.id;
    const humanAdminIds = adminMembers
      .map((m: any) => m?.user)
      .filter((u: any) => u && !u.is_bot)
      .map((u: any) => Number(u.id))
      .filter((id: number) => Number.isFinite(id));
    const preferredPool = humanAdminIds.filter((id) => id !== (me?.id ?? 0) && id !== reporterId && id !== targetId);
    const fallbackPool = humanAdminIds.filter((id) => id !== (me?.id ?? 0) && id !== reporterId);
    const adminPool = preferredPool.length > 0 ? preferredPool : fallbackPool;

    if (adminPool.length === 0) {
      const warn = await ctx.reply("⚠️ 暂时无法获取可呼叫的管理员，请稍后重试。");
      setTimeout(() => ctx.api.deleteMessage(chatId, warn.message_id).catch(() => { }), 20_000);
      return;
    }

    const shuffledAdmins = [...adminPool].sort(() => Math.random() - 0.5);
    const pickedAdminIds = shuffledAdmins.slice(0, Math.min(2, shuffledAdmins.length));
    const adminLinks = await Promise.all(pickedAdminIds.map((id) => renderUserLink(ctx, chatId, id)));
    const adminMentionText = adminLinks.join("、");
    const reporterLink = await renderUserLink(ctx, chatId, reporterId);
    const targetLink = await renderUserLink(ctx, chatId, targetId);
    const reportText = (reply.text || reply.caption || "").trim();
    const reportPreview = reportText ? `\n📝 可疑内容: <i>${formatPreview(reportText)}</i>` : "";

    await ctx.reply(
      `📣 <b>群员举报提醒</b>\n\n` +
      `${adminMentionText} 请处理这条可疑消息。\n` +
      `举报人: ${reporterLink}\n` +
      `被举报: ${targetLink} (<code>${targetId}</code>)` +
      `${reportPreview}`,
      {
        parse_mode: "HTML",
        reply_parameters: { message_id: reply.message_id },
        link_preview_options: { is_disabled: true },
      }
    );
  }

  async function tryHandleMemberBanReportWithAI(ctx: Context, chatId: number, reporterId: number, reply: any): Promise<"spam" | "clean" | "uncertain"> {
    if (!isAIAvailableInChat(chatId) || !reply?.from?.id) return "uncertain";

    let imageUrl: string | undefined;
    try {
      if (reply.photo && reply.photo.length > 0) {
        const highestRes = reply.photo[reply.photo.length - 1];
        const file = await ctx.api.getFile(highestRes.file_id);
        if (file.file_path) {
          const fileUrl = `https://api.telegram.org/file/bot${process.env.BOT_TOKEN}/${file.file_path}`;
          const response = await axios.get(fileUrl, { responseType: "arraybuffer" });
          imageUrl = `data:image/jpeg;base64,${Buffer.from(response.data, "binary").toString("base64")}`;
        }
      }
    } catch { }

    const targetId = reply.from.id;
    const targetUserName = getUserName(reply.from);
    const includeContext = !(await shouldIgnoreReplyContextForDetection(ctx, chatId, reply));
    const detectionText = buildTelegramDetectionText(reply, { includeContext });
    const messageText = detectionText.text;
    const trimmedMessageText = detectionText.bodyText.trim();
    const hasContactCard = !!reply?.contact;
    const extractedUrls = extractUrlsFromTelegramMessageWithContext(reply, { includeContext });
    const hasEmbeddedUrl = extractedUrls.length > 0;
    const hasRawUrlText = /(https?:\/\/|tg:\/\/|t\.me\/|www\.)/i.test(messageText);
    const hasJumpRiskUrl = extractedUrls.some((url) => isJumpAdUrl(url));

    let linkPreviewText = "";
    const linkPreviewSignals: string[] = [];
    const normalizedUrls = extractedUrls.map((raw) => raw.startsWith("http") ? raw : `https://${raw}`);
    if (normalizedUrls.length > 0) {
      linkPreviewText += `\n[消息内链接]: ${normalizedUrls.join(" | ")}`;
      for (const url of normalizedUrls) {
        try {
          const res = await axios.get(url, {
            timeout: 3000,
            maxRedirects: 2,
            maxContentLength: 500 * 1024,
            responseType: "text",
            headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)" }
          });
          const finalUrl = String((res.request as any)?.res?.responseUrl || "").trim();
          if (finalUrl && finalUrl !== url) linkPreviewSignals.push(`最终跳转: ${finalUrl}`);
          const html = res.data;
          if (typeof html !== "string") continue;
          let title = "";
          let desc = "";
          const metaRegex = /<meta[^>]+>/ig;
          let match;
          while ((match = metaRegex.exec(html)) !== null) {
            const tag = match[0];
            if (/property=["']og:title["']/i.test(tag) || /name=["']twitter:title["']/i.test(tag) || /property=["']twitter:title["']/i.test(tag)) {
              const cMatch = tag.match(/content=["']([^"']+)["']/i);
              if (cMatch && !title) title = cMatch[1];
            }
            if (/property=["']og:description["']/i.test(tag) || /name=["']description["']/i.test(tag) || /name=["']twitter:description["']/i.test(tag) || /property=["']twitter:description["']/i.test(tag)) {
              const cMatch = tag.match(/content=["']([^"']+)["']/i);
              if (cMatch && !desc) desc = cMatch[1];
            }
          }
          const decodeHtmlEntities = (s: string) => s.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
          const metaText = [decodeHtmlEntities(title), decodeHtmlEntities(desc)].filter(Boolean).join("\n");
          if (metaText) linkPreviewText += `\n[链接预览内容]: ${metaText}`;
        } catch { }
      }
      if (linkPreviewSignals.length > 0) linkPreviewText += `\n[链接跳转]: ${linkPreviewSignals.join(" | ")}`;
    }

    const suspiciousPromoText = hasSuspiciousPromoKeywords(`${messageText}\n${linkPreviewText}`);
    const suspiciousContactPromoText = hasContactCard && hasSuspiciousContactPromoText(messageText);
    const contactHasPhoneNumber = hasContactCard && hasLikelyPhoneNumber(messageText);
    const suspiciousShortJumpAd = hasJumpRiskUrl && suspiciousPromoText;
    const highRiskHints: string[] = [];
    if (hasJumpRiskUrl) highRiskHints.push("存在短链/Telegram跳转链接");
    if (suspiciousPromoText) highRiskHints.push("命中黄推/导流高风险词");
    if (hasContactCard) highRiskHints.push("发送联系人名片");
    if (contactHasPhoneNumber) highRiskHints.push("联系人名片包含手机号");
    if (suspiciousContactPromoText) highRiskHints.push("联系人名片包含交易或引流词");
    if (trimmedMessageText.length <= 12 && (hasEmbeddedUrl || hasRawUrlText)) highRiskHints.push("短文本携带外链或隐藏链接");
    const finalMessageText = `${messageText}${linkPreviewText}${highRiskHints.length ? `\n[高风险信号]: ${highRiskHints.join("；")}` : ""}`.trim() || "[纯媒体内容]";

    const globalMax30 = db.getUserMaxMessageCountAcrossGroups(targetId, 30);
    const groupMsg10 = db.getUserMessageCount(chatId, targetId, 10);
    const groupMsg30 = db.getUserMessageCount(chatId, targetId, 30);
    const activityTier = getActivityTier(globalMax30, groupMsg10, groupMsg30);
    const activityLabel = getActivityTierLabel(activityTier);
    const senderPortrait = [
      `用户 ID: ${targetId}, 昵称: "${targetUserName}"。`,
      `活跃分层: ${activityLabel}。`,
      `活跃数据: 本群10天发言 ${groupMsg10} 次，本群30天发言 ${groupMsg30} 次，全群最高30天发言 ${globalMax30} 次。`,
      activityTier === "new_low"
        ? "该用户属于重点审查对象，广告判定可适当从严。"
        : activityTier === "old_high"
          ? "该用户属于高信任老成员，除非出现明显引流/广告特征，否则应从宽处理。"
          : "该用户活跃度中等，按常规标准处理。"
    ].join(" ");
    const history = chatHistoryCache.get(chatId) || [];
    const historyText = history.map((h) => `${h.userName}: ${h.text}`).join("\n");
    const samples: SpamSample[] = db.getSamples(chatId, 20).map((s) => ({ message_text: s.message_text, is_spam: s.is_spam }));

    let result: { spam: boolean; argue: boolean; confidence: number; reason: string; model: string };
    try {
      result = await checkSpam(finalMessageText, samples, historyText, imageUrl, senderPortrait, false, getChatAIProvider(chatId));
    } catch (error) {
      return "uncertain";
    }

    await maybeNotifyAiFailure(ctx, {
      chatId,
      userId: targetId,
      userName: targetUserName,
      model: result.model,
      reason: result.reason,
      source: "手动/test",
      messageText: finalMessageText,
      autoDisableAi: true,
    });

    const threshold = db.getThreshold(chatId);
    const hasRiskSignal = hasEmbeddedUrl || hasRawUrlText || hasContactCard || !!reply.photo?.length || !!reply.animation || !!reply.document?.mime_type?.startsWith("image/");
    const extraRiskDiscount =
      (suspiciousShortJumpAd ? 0.12 : hasJumpRiskUrl ? 0.06 : 0)
      + (suspiciousContactPromoText ? 0.12 : contactHasPhoneNumber ? 0.08 : hasContactCard ? 0.04 : 0);
    const spamThreshold = getAdaptiveSpamThreshold(threshold, activityTier, hasRiskSignal, extraRiskDiscount);
    const displayReason = cleanupReasonForDisplay(result.reason || "");

    if (!result.spam && !result.argue) {
      const cleanRoasts = [
        "🤖 人家正常聊天碍着你什么事了。",
        "🤖 这都要 ban？你是来巡逻空气的吧。",
        "🤖 别紧张，这条看着比你还正常。",
        "🤖 我看了半天，这是聊天，不是广告。",
        "🤖 收收刀，这位暂时不像坏人。",
      ];
      const cleanTipText = cleanRoasts[Math.floor(Math.random() * cleanRoasts.length)] || cleanRoasts[0];
      const cleanTip = await ctx.reply(`${cleanTipText}\n<i>AI 看了一眼：${esc(displayReason || "未见明显广告特征")}</i>`, {
        parse_mode: "HTML",
        reply_parameters: { message_id: reply.message_id },
      }).catch(() => null);
      if (cleanTip) setTimeout(() => ctx.api.deleteMessage(chatId, cleanTip.message_id).catch(() => { }), 20_000);
      return "clean";
    }

    if (!result.spam || result.confidence < spamThreshold) {
      return "uncertain";
    }

    const pollCreated = await createSuspiciousSpamPoll(ctx, {
      chatId,
      userId: targetId,
      userName: targetUserName,
      userMessageId: reply.message_id,
      text: finalMessageText,
      confidence: result.confidence,
      reason: displayReason,
      detector: result.model,
      activityLabel,
      spamThreshold,
      replyToMessageId: reply.message_id,
      ownerNoticePrefix: "⏳ <b>群员举报后，AI 已判定该消息为疑似广告</b>",
    });
    if (!pollCreated) {
      return "spam";
    }
    const tip = await ctx.reply("🤖 AI 已初步判定这条消息疑似广告，已进入群内投票处理流程。", {
      reply_parameters: { message_id: reply.message_id },
    }).catch(() => null);
    if (tip) setTimeout(() => ctx.api.deleteMessage(chatId, tip.message_id).catch(() => { }), 20_000);
    return "spam";
  }

  // ========== 核心 0A: 私聊核销优先级 (独占/互不干扰模式) ==========
  bot.on("message:text", async (ctx, next) => {
    // 门票：如果不满足私聊+有待验证任务，立即交给下家
    if (ctx.chat.type !== "private" || !ctx.from) return next();

    // 关键修复：如果是指令消息 (以 / 开头)，直接跳过，给后续的 bot.command 处理器
    if (ctx.message.text?.startsWith("/")) return next();

    const userId = ctx.from.id;
    const pendingChatId = db.getUnverifiedMemberChatId(userId);
    if (!pendingChatId) return next();

    const botPerm = await getBotPermissionStatus(ctx, pendingChatId);
    if (!botPerm.ok) {
      await ctx.reply(`❌ 当前群组机器人权限不足，暂不可核销邀请码。\n原因：${botPerm.shortReason}`);
      return;
    }

    const config = getEffectiveInvitationConfig(pendingChatId);

    // --- 强制订阅检查 ---
    const requiredChannel = (config.requiredChannel || "").trim();
    if (requiredChannel) {
      let link = requiredChannel;
      let title = requiredChannel;
      try {
        const chat = await ctx.api.getChat(requiredChannel);
        if ("title" in chat && chat.title) title = chat.title;
        if ("username" in chat && chat.username) {
          link = `https://t.me/${chat.username}`;
        } else if ("invite_link" in chat && chat.invite_link) {
          link = chat.invite_link;
        }
      } catch { }
      if (link.startsWith("@")) {
        link = `https://t.me/${link.slice(1)}`;
      } else if (!/^https?:\/\//i.test(link) && !link.startsWith("tg://")) {
        link = `https://t.me/${link.replace(/^@/, "")}`;
      }

      let checkOk = false;
      let isMember = false;
      try {
        const member = await ctx.api.getChatMember(requiredChannel, userId);
        checkOk = true;
        isMember = ["member", "administrator", "creator"].includes(member.status);
      } catch (err: any) {
        if (isNotSubscribedError(err)) {
          checkOk = true;
          isMember = false;
        } else if (isMembershipCheckUnavailableError(err)) {
          console.warn(`[AntiSpam] 订阅检查不可用: ${getApiErrorDesc(err)}`);
          await ctx.reply(
            "❌ <b>系统配置错误</b>\n\n机器人当前无法完成频道关注校验，请联系群管处理（常见原因：机器人不在频道内、未设为频道管理员，或频道成员列表不可访问）。",
            { parse_mode: "HTML" }
          );
          return;
        } else {
          console.error(`[AntiSpam] 订阅检查失败: ${getApiErrorDesc(err)}`);
          await ctx.reply(
            "❌ <b>系统配置错误</b>\n\n机器人当前无法完成频道关注校验，请联系群管处理。",
            { parse_mode: "HTML" }
          );
          return;
        }
      }

      if (!checkOk || !isMember) {
        await ctx.reply(`⚠️ <b>请先订阅频道</b>\n\n本群开启了强制阅览验证，请先订阅频道：\n👉 <b><a href="${link}">${esc(title)}</a></b>\n\n订阅完成后，请再次发送验证码进行核销。`, { parse_mode: "HTML" });
        return;
      }
    }

    // 到这里说明确定是来核销的用户
    const text = ctx.message.text || "";
    const code = text.trim();
    console.log(`[AntiSpam] High-priority redemption | User: ${userId} | Code: ${code} | Group: ${pendingChatId}`);

    if (code.length >= 6) {
      const success = db.verifyAndUseVoucher(pendingChatId, userId, code);
      if (success) {
        if (requiredChannel) {
          db.markChannelGuardMember(pendingChatId, userId);
        }
        const info = db.removeUnverifiedMember(pendingChatId, userId);

        let chatName = String(pendingChatId);
        let chatLink = "";
        try {
          const chat = await ctx.api.getChat(pendingChatId);
          if (chat && "title" in chat) chatName = chat.title || String(pendingChatId);
          if (chat && "username" in chat && chat.username) {
            chatLink = `https://t.me/${chat.username}`;
          } else if (chat && "invite_link" in chat && chat.invite_link) {
            chatLink = chat.invite_link;
          } else {
            chatLink = pendingChatId.toString().startsWith("-100")
              ? `https://t.me/c/${pendingChatId.toString().slice(4)}/1`
              : `tg://resolve?id=${Math.abs(pendingChatId)}`;
          }
        } catch { }

        // 解除群里禁言
        try {
          await ctx.api.restrictChatMember(pendingChatId, userId, {
            can_send_messages: true,
            can_send_audios: true,
            can_send_documents: true,
            can_send_photos: true,
            can_send_videos: true,
            can_send_video_notes: true,
            can_send_voice_notes: true,
            can_send_polls: true,
            can_send_other_messages: true,
            can_add_web_page_previews: true,
          });
          if (info?.welcomeMsgId) {
            await ctx.api.deleteMessage(pendingChatId, info.welcomeMsgId).catch(() => { });
          }
          await ctx.reply(`✅ <b>核销成功！</b>\n\n您已获得入群许可，禁言已解除。请点击返回 <b><a href="${chatLink}">${esc(chatName)}</a></b> 畅所欲言吧！`, { parse_mode: "HTML" });
          const sent = await sendCommercialChatWelcomeIfEnabled(ctx, pendingChatId, {
            id: userId,
            username: ctx.from.username || "",
            displayName: getUserName(ctx.from),
          }, chatName).catch((error) => {
            console.error("[CommercialWelcome] 发送欢迎语失败:", error);
            return false;
          });
          if (!sent) {
            const passNotice = await ctx.api.sendMessage(pendingChatId, `🎉 用户 <a href="tg://user?id=${userId}">${esc(getUserName(ctx.from))}</a> 已成功通过邀请码核销。`, { parse_mode: "HTML" });
            scheduleAutoDeleteMessage(ctx, pendingChatId, passNotice.message_id, PASS_NOTICE_AUTO_DELETE_MS);
          }
        } catch (err) {
          console.error("[AntiSpam] 私聊核销后解除禁言失败:", err);
          await ctx.reply("✅ 核销完成，但由于机器人权限问题，请联系群管手动为您解禁。");
        }
      } else {
        await ctx.reply("❌ <b>核销失败</b>\n\n验证码不正确或已被使用。请检查后重新发送，或联系群内成员获取新券。", { parse_mode: "HTML" });
      }
    } else {
      await ctx.reply("⚠️ <b>格式不符</b>\n\n邀请码长度通常在 6 位以上。请重新发送正确的验证码。", { parse_mode: "HTML" });
    }
  });

  // ========== 核心 0B: 拦截群组内未验证用户的非法消息 (独占模式) ==========
  bot.on("message", async (ctx, next) => {
    if (ctx.chat.type === "private" || !ctx.from) return next();
    const chatId = ctx.chat.id;
    const userId = ctx.from.id;

    if (db.isUnverifiedMember(chatId, userId)) {
      // 允许命令继续流转到后续 command handlers，避免“命令被秒删但无响应”
      const text = ctx.message?.text || "";
      if (text.trim().startsWith("/")) {
        return next();
      }
      try { await ctx.deleteMessage(); } catch { }
      return;
    }

    // 必关频道兜底复检：已在群内的成员若取消关注，自动移出群组
    // 跳过系统账号/机器人/匿名发言场景，避免误处理
    if (!ctx.from.is_bot && !ctx.senderChat && userId !== 777000) {
      const requiredChannel = (getEffectiveInvitationConfig(chatId).requiredChannel || "").trim();
      const shouldEnforce = requiredChannel.length > 0 && db.isChannelGuardMember(chatId, userId);
      if (shouldEnforce) {
        const isAdminUser = await checkIsAdmin(ctx, chatId, userId);
        if (!isAdminUser) {
          let subscribed = false;
          let checkOk = false;
          try {
            const channelMember = await ctx.api.getChatMember(requiredChannel, userId);
            checkOk = true;
            subscribed = ["member", "administrator", "creator"].includes(channelMember.status);
          } catch (error: any) {
            if (isNotSubscribedError(error)) {
              checkOk = true;
              subscribed = false;
            } else if (isMembershipCheckUnavailableError(error)) {
              console.warn(`[AntiSpam] 群内必关频道复检不可用，自动清除必关频道: ${getApiErrorDesc(error)}`);
              db.setRequiredChannel(chatId, "");
            } else {
              console.error(`[AntiSpam] 群内必关频道复检失败: ${getApiErrorDesc(error)}`);
            }
          }

          if (checkOk && !subscribed) {
            const info = db.removeUnverifiedMember(chatId, userId);
            db.unmarkChannelGuardMember(chatId, userId);
            if (info?.welcomeMsgId) {
              await ctx.api.deleteMessage(chatId, info.welcomeMsgId).catch(() => { });
            }

            await ctx.api.banChatMember(chatId, userId).catch(() => { });
            await ctx.api.unbanChatMember(chatId, userId).catch(() => { });

            try { await ctx.deleteMessage(); } catch { }

            const userLink = await renderUserLink(ctx, chatId, userId);
            const notice = await ctx.api.sendMessage(
              chatId,
              `🗑️ <b>退订移除</b>\n用户 ${userLink} 已取消必关频道关注，已被自动移出群组。\n<i>请重新关注频道后再入群。</i>`,
              { parse_mode: "HTML" }
            ).catch(() => null);
            if (notice) {
              setTimeout(() => ctx.api.deleteMessage(chatId, notice.message_id).catch(() => { }), 3 * 60 * 1000);
            }
            return;
          }
        }
      }
    }

    await next();
  });

  bot.on("callback_query:data", async (ctx, next) => {
    const data = ctx.callbackQuery.data;
    if (data !== "vote_safe" && data !== "vote_spam") {
      await next();
      return;
    }

    const chatId = ctx.chat?.id;
    const pollMsgId = ctx.callbackQuery.message?.message_id;
    if (!chatId || !pollMsgId) return;

    const pollKey = `${chatId}:${pollMsgId}`;
    const poll = activePolls.get(pollKey);

    if (!poll) {
      await ctx.answerCallbackQuery({ text: "该投票已过期或结束。", show_alert: true }).catch(() => { });
      return;
    }

    const voterId = ctx.from.id;

    if (voterId === poll.userId) {
      await ctx.answerCallbackQuery({ text: "不能给自己投票哦！", show_alert: true }).catch(() => { });
      return;
    }

    const isAdminUser = await checkIsAdmin(ctx, chatId, voterId);

    if (poll.votesNotAd.has(voterId) || poll.votesIsAd.has(voterId)) {
      if (!isAdminUser) {
        await ctx.answerCallbackQuery({ text: "您已经投过票了！", show_alert: true }).catch(() => { });
        return;
      }
    }

    if (data === "vote_spam") {
      if (isAdminUser) {
        await executeBan(poll, ctx, "管理员确认为广告");
        await ctx.answerCallbackQuery({ text: "已确认广告并执行封禁" }).catch(() => { });
        return;
      }

      poll.votesIsAd.add(voterId);

      if (poll.votesIsAd.size >= POLL_VOTES_THRESHOLD) {
        await executeBan(poll, ctx, `${POLL_VOTES_THRESHOLD}名群友确认为广告`);
        await ctx.answerCallbackQuery({ text: "投票达标，已确认广告并执行封禁" }).catch(() => { });
      } else {
        try {
          await ctx.api.editMessageReplyMarkup(chatId, pollMsgId, {
            reply_markup: {
              inline_keyboard: [[
                { text: `✅ 这是误杀 (${poll.votesNotAd.size}/${POLL_VOTES_THRESHOLD})`, callback_data: `vote_safe` },
                { text: `🚫 干掉广告 (${poll.votesIsAd.size}/${POLL_VOTES_THRESHOLD})`, callback_data: `vote_spam` }
              ]]
            }
          });
        } catch (e) { }
        await ctx.answerCallbackQuery({ text: "投票成功！" }).catch(() => { });
      }
      return;
    }

    if (data === "vote_safe") {
      if (isAdminUser) {
        await executeUnmute(poll, ctx, "管理员");
        await ctx.answerCallbackQuery({ text: "管理员一票否决，已解除禁言" }).catch(() => { });
        return;
      }

      poll.votesNotAd.add(voterId);

      if (poll.votesNotAd.size >= POLL_VOTES_THRESHOLD) {
        await executeUnmute(poll, ctx, `${POLL_VOTES_THRESHOLD}名群友投票`);
        await ctx.answerCallbackQuery({ text: "投票达标，已解除禁言" }).catch(() => { });
      } else {
        try {
          await ctx.api.editMessageReplyMarkup(chatId, pollMsgId, {
            reply_markup: {
              inline_keyboard: [[
                { text: `✅ 这是误杀 (${poll.votesNotAd.size}/${POLL_VOTES_THRESHOLD})`, callback_data: `vote_safe` },
                { text: `🚫 干掉广告 (${poll.votesIsAd.size}/${POLL_VOTES_THRESHOLD})`, callback_data: `vote_spam` }
              ]]
            }
          });
        } catch (e) { }
        await ctx.answerCallbackQuery({ text: "投票成功！" }).catch(() => { });
      }
    }
  });

  // ========== 命令处理 ==========
  // 兼容前置空白、零宽字符、全角斜杠，以及 @botname 形式
  const ADS_CMD_REGEX = /^[\s\u200B\u200C\u200D\uFEFF]*[\/／](?:ads|antispam)(?:@[A-Za-z0-9_]+)?(?:\s+([\s\S]*))?$/i;
  const ADS_DIRECT_SUB_CMD_REGEX = /^[\s\u200B\u200C\u200D\uFEFF]*[\/／](pass|unjy|jy|ai|status|test|log|wl|threshold|ban|mark|safe|samples|invite|import|points|unban|importset|importadd|wladd|wlrm)(?:@[A-Za-z0-9_]+)?(?:\s+([\s\S]*))?$/i;
  const ASSISTANT_CMD_REGEX = /^[\s\u200B\u200C\u200D\uFEFF]*[\/／]assistant(?:@[A-Za-z0-9_]+)?(?:\s+([\s\S]*))?$/i;
  const DEBUG_COMMAND_TRACE = process.env.DEBUG_COMMAND_TRACE === "1";

  if (DEBUG_COMMAND_TRACE) {
    bot.on("message:text", async (ctx, next) => {
      const t = (ctx.message?.text || "").trim();
      if (t.startsWith("/") || t.startsWith("／")) {
        console.log(`[CmdTrace] receive | chat=${ctx.chat.id} | from=${ctx.from?.id ?? "anonymous"} | text=${t}`);
      }
      await next();
    });
  }

  const runAdsCommand = async (ctx: Context, forcedArgText?: string) => {
    if (!ctx.chat || ctx.chat.type === "private") {
      await ctx.reply("⚠️ 此命令仅在群组中可用。");
      return;
    }

    const chatId = ctx.chat.id;
    const userId = ctx.from?.id;
    if (!userId) {
      const warn = await ctx.reply("⚠️ 请关闭“匿名管理员/以频道身份发送”后再使用指令。");
      setTimeout(() => ctx.api.deleteMessage(chatId, warn.message_id).catch(() => { }), 20_000);
      return;
    }

    // 自动删除用户指令消息，保持公屏整洁
    try {
      await ctx.deleteMessage();
    } catch (e) { }

    const text = ctx.message?.text || "";
    if (DEBUG_COMMAND_TRACE) {
      console.log(`[CmdTrace] ads-cmd-entry | chat=${chatId} | from=${userId} | text=${text}`);
    }
    const m = text.match(ADS_CMD_REGEX);
    const argText = (forcedArgText || m?.[1] || "").trim();
    const parts = argText ? argText.split(/\s+/) : [];
    let sub = parts[0]?.toLowerCase();

    // 命令别名映射
    if (sub === "importset") {
      parts[0] = "import";
      parts.splice(1, 0, "set");
      sub = "import";
    } else if (sub === "importadd") {
      parts[0] = "import";
      parts.splice(1, 0, "add");
      sub = "import";
    } else if (sub === "wladd") {
      parts[0] = "wl";
      parts.splice(1, 0, "add");
      sub = "wl";
    } else if (sub === "wlrm") {
      parts[0] = "wl";
      parts.splice(1, 0, "rm");
      sub = "wl";
    }

    // 如果没有子命令，显示主菜单给所有人
    if (!sub) {
      let msg: { message_id: number } | null = null;
      try {
        msg = await ctx.reply(
          `🛡️ <b>AI去广告机器人</b>\n\n将机器人设为管理员（删除消息+封禁用户权限）后使用`,
          { parse_mode: "HTML", reply_markup: getAdsMainMenu() }
        );
      } catch (e) {
        console.error("[AntiSpam] /ads 主菜单发送失败(HTML)，降级纯文本重试:", e);
        try {
          msg = await ctx.reply(
            `🛡️ AI去广告机器人\n\n将机器人设为管理员（删除消息+封禁用户权限）后使用`,
            { reply_markup: getAdsMainMenu() }
          );
        } catch (e2) {
          console.error("[AntiSpam] /ads 主菜单发送失败(纯文本):", e2);
        }
      }
      if (msg) {
        // 设置自动删除计时器
        refreshAdsMenuTimer(bot, chatId, msg.message_id);
        bindAdsUiOwner(chatId, msg.message_id, userId);
        if (DEBUG_COMMAND_TRACE) {
          console.log(`[CmdTrace] /ads-menu-sent | chat=${chatId} | msg=${msg.message_id}`);
        }
      }
      return;
    }

    // 群组内对 /ads check 与 /ads help 保持静默（仅删除指令，不反馈）
    if (sub === "check" || sub === "help") {
      return;
    }

    // 只有管理员可以使用具体子命令 (/ads on/off 或 /wl 等)
    // 例外：普通成员可在“回复目标消息”时使用 /ban 触发随机管理员处理提醒
    const isAdminUser = await checkIsAdmin(ctx, chatId, userId);
    if (!isAdminUser && sub && sub !== "import" && sub !== "points") {
      if (sub === "ban") {
        const reply = ctx.message?.reply_to_message;
        if (!reply?.from?.id) {
          const tip = await ctx.reply(
            "⚠️ 普通成员使用 <code>/ban</code> 必须回复目标用户的消息，不能直接使用。",
            { parse_mode: "HTML" }
          );
          setTimeout(() => ctx.api.deleteMessage(chatId, tip.message_id).catch(() => { }), 20_000);
          return;
        }
        if (isAIAvailableInChat(chatId)) {
          const aiDecision = await tryHandleMemberBanReportWithAI(ctx, chatId, userId, reply);
          if (aiDecision !== "uncertain") {
            return;
          }
        }

        await summonAdminsForReportedMessage(ctx, chatId, userId, reply);
        return;
      }

      await ctx.reply("🚫 仅管理员可执行具体的管理指令。");
      return;
    }

    const handlePointsImport = async (modeArgRaw?: string) => {
      if (!(await ensureRestrictedPointsOperator(ctx, chatId, userId, "积分导入"))) {
        return;
      }
      const modeArg = (modeArgRaw || "set").toLowerCase();
      if (modeArg !== "set" && modeArg !== "add") {
        await ctx.reply(
          "用法:\n<code>/import [set|add]</code>\n或 <code>/points import [set|add]</code>\n\n" +
          "请回复一条文本消息，内容每行一个 <code>用户ID 积分</code>。",
          { parse_mode: "HTML" }
        );
        return;
      }

      const reply = ctx.message?.reply_to_message;
      const rawText = (reply?.text || reply?.caption || "").trim();
      if (!rawText) {
        await ctx.reply(
          "请先回复要导入的积分文本，再执行导入。\n\n" +
          "示例:\n<code>123456789 100\n987654321 250</code>",
          { parse_mode: "HTML" }
        );
        return;
      }

      const lines = rawText.split(/\r?\n/);
      let success = 0;
      let changed = 0;
      let unchanged = 0;
      let invalid = 0;
      let netDelta = 0;
      const invalidLineNos: number[] = [];

      for (let i = 0; i < lines.length; i++) {
        const parsed = parsePointsImportLine(lines[i]);
        if (parsed.kind === "empty") continue;
        if (parsed.kind === "invalid") {
          invalid++;
          if (invalidLineNos.length < 10) invalidLineNos.push(i + 1);
          continue;
        }

        try {
          const result = db.importUserPoints(
            chatId,
            parsed.userId,
            parsed.points,
            modeArg,
            "管理调整"
          );
          success++;
          if (result.delta === 0) unchanged++;
          else changed++;
          netDelta += result.delta;
        } catch {
          invalid++;
          if (invalidLineNos.length < 10) invalidLineNos.push(i + 1);
        }
      }

      if (success === 0) {
        await ctx.reply(
          "❌ 未导入任何有效记录。\n\n" +
          "请使用格式：每行 <code>用户ID 积分</code>\n" +
          "例如:\n<code>123456789 100\n987654321 250</code>",
          { parse_mode: "HTML" }
        );
        return;
      }

      const invalidText = invalid > 0
        ? `\n⚠️ 无效行: <code>${invalid}</code>${invalidLineNos.length > 0 ? ` (行号: ${invalidLineNos.join(", ")})` : ""}`
        : "";
      const modeText = modeArg === "add" ? "追加模式" : "覆盖模式";
      await ctx.reply(
        `✅ <b>积分导入完成</b>\n\n` +
        `• 模式: <b>${modeText}</b>\n` +
        `• 成功: <code>${success}</code>\n` +
        `• 产生变更: <code>${changed}</code>\n` +
        `• 无变化: <code>${unchanged}</code>\n` +
        `• 积分净变动: <code>${netDelta >= 0 ? "+" : ""}${netDelta}</code>` +
        `${invalidText}`,
        { parse_mode: "HTML" }
      );
    };

    switch (sub) {
      case "pass": {
        let targetId: number | undefined;
        if (parts[1]) targetId = parseInt(parts[1]);
        else if (ctx.message?.reply_to_message?.from?.id) targetId = ctx.message.reply_to_message.from.id;

        if (!targetId) {
          await ctx.reply("用法: <code>/pass [UID]</code>（回复用户消息或指定 ID）", { parse_mode: "HTML" });
          return;
        }

        const unverified = db.removeUnverifiedMember(chatId, targetId);
        if (unverified) {
          const inviteConfig = getEffectiveInvitationConfig(chatId);
          if ((inviteConfig.requiredChannel || "").trim()) {
            db.markChannelGuardMember(chatId, targetId);
          }
          try { await ctx.api.deleteMessage(chatId, unverified.welcomeMsgId); } catch { }
          const passNotice = await ctx.reply(`✅ 已手动放行用户 <code>${targetId}</code>。`, { parse_mode: "HTML" });
          scheduleAutoDeleteMessage(ctx, chatId, passNotice.message_id, PASS_NOTICE_AUTO_DELETE_MS);
          const profile = db.getChatUserProfile(chatId, targetId);
          await sendCommercialChatWelcomeIfEnabled(ctx, chatId, {
            id: targetId,
            username: profile?.username || "",
            displayName: profile?.display_name || "",
          }).catch((error) => {
            console.error("[CommercialWelcome] 发送欢迎语失败:", error);
          });
        } else {
          await ctx.reply(`ℹ️ 用户 <code>${targetId}</code> 当前不在准入验证队列中。`, { parse_mode: "HTML" });
        }
        break;
      }

      case "unjy": {
        let targetId: number | undefined;

        // 方案 1: 直接从指令后面获取 ID
        if (parts[1]) {
          targetId = parseInt(parts[1]);
        }
        // 方案 2: 通过回复消息获取被回复人的 ID
        else if (ctx.message?.reply_to_message?.from?.id) {
          targetId = ctx.message.reply_to_message.from.id;
        }

        if (!targetId || isNaN(targetId)) {
          ctx.reply("⚠️ 请在指令后跟随用户 ID，或直接<b>回复</b>该用户的消息使用。", { parse_mode: "HTML" })
            .then(m => setTimeout(() => ctx.api.deleteMessage(chatId, m.message_id).catch(() => { }), 60000));
          return;
        }

        if (await checkIsAdmin(ctx, chatId, targetId)) {
          await ctx.reply("ℹ️ 目标用户是群管理员，无需解除禁言，且不能对管理员执行该操作。", { parse_mode: "HTML" });
          return;
        }

        try {
          await ctx.api.restrictChatMember(chatId, targetId, {
            can_send_messages: true,
            can_send_other_messages: true,
            can_add_web_page_previews: true,
          });

          const targetUserLink = await renderUserLink(ctx, chatId, targetId);
          const msg = await ctx.reply(`✅ 已成功解除用户 ${targetUserLink} (<code>${targetId}</code>) 的封禁/禁言限制。`, { parse_mode: "HTML" });
          // 3分钟后删除通知
          setTimeout(() => ctx.api.deleteMessage(chatId, msg.message_id).catch(() => { }), 180000);
        } catch (error) {
          if (isAdministratorTargetError(error)) {
            await ctx.reply("ℹ️ 目标用户是群管理员，Telegram 不允许对管理员执行解除禁言/封禁操作。", { parse_mode: "HTML" });
            return;
          }
          console.error("[Unjy] 失败:", error);
          await ctx.reply(`❌ 解除禁言失败，请检查机器人权限或用户 ID 是否正确。`);
        }
        break;
      }

      case "jy": {
        let targetId: number | undefined;
        let timeStr: string | undefined;

        // 解析逻辑：识别是否提供了 ID 或 时间字符串
        if (parts[1]) {
          const val = parseInt(parts[1]);
          // 如果第一个参数是很大的数字，通常是用户 ID
          if (!isNaN(val) && val > 10000) {
            targetId = val;
            timeStr = parts[2];
          } else {
            // 否则可能是时间字符串 (如 30s)
            timeStr = parts[1];
          }
        }

        // 如果没有显式提供 ID，尝试从回复中获取
        if (!targetId && ctx.message?.reply_to_message?.from?.id) {
          targetId = ctx.message.reply_to_message.from.id;
        }

        if (!targetId) {
          ctx.reply("⚠️ 请回复某人的消息，或在指令后跟用户 ID。用法：<code>/jy [UID] [时长]</code>", { parse_mode: "HTML" })
            .then(m => setTimeout(() => ctx.api.deleteMessage(chatId, m.message_id).catch(() => { }), 30000));
          return;
        }

        if (await checkIsAdmin(ctx, chatId, targetId)) {
          await ctx.reply("ℹ️ 目标用户是群管理员，不能对管理员执行禁言。", { parse_mode: "HTML" });
          return;
        }

        let untilDate: number | undefined;
        let durationText = "永久";
        if (timeStr) {
          const match = timeStr.match(/^(\d+)([smhd]?)$/i);
          if (match) {
            const num = parseInt(match[1]);
            const unit = (match[2] || "m").toLowerCase();
            let seconds = num;
            if (unit === "m") { seconds = num * 60; durationText = `${num} 分钟`; }
            else if (unit === "h") { seconds = num * 3600; durationText = `${num} 小时`; }
            else if (unit === "d") { seconds = num * 86400; durationText = `${num} 天`; }
            else if (unit === "s") { seconds = num; durationText = `${num} 秒`; }

            // Telegram until_date 必须在 30 秒到 366 天之间
            // 如果小于 30 秒，实际上表现为永久禁言；如果大于 366 天，也是永久
            untilDate = Math.floor(Date.now() / 1000) + seconds;
          }
        }

        try {
          await ctx.api.restrictChatMember(chatId, targetId, {
            can_send_messages: false,
            can_send_other_messages: false,
            can_add_web_page_previews: false,
          }, untilDate ? { until_date: untilDate } : {});

          const targetUserLink = await renderUserLink(ctx, chatId, targetId);
          const msgText = `🚫 已将用户 ${targetUserLink} (<code>${targetId}</code>) 禁言。\n<b>时长:</b> ${durationText}`;
          const msg = await ctx.reply(msgText, { parse_mode: "HTML" });
          // 3分钟后删除通知
          setTimeout(() => ctx.api.deleteMessage(chatId, msg.message_id).catch(() => { }), 180000);
        } catch (error) {
          if (isAdministratorTargetError(error)) {
            await ctx.reply("ℹ️ 目标用户是群管理员，Telegram 不允许对管理员执行禁言。", { parse_mode: "HTML" });
            return;
          }
          console.error("[Jy] 失败:", error);
          await ctx.reply(`❌ 禁言失败，请检查机器人权限或用户 ID 是否正确。`);
        }
        break;
      }

      case "on": {
        const botPerm = await getBotPermissionStatus(ctx, chatId);
        if (!botPerm.ok) {
          await ctx.reply(`❌ 无法开启反垃圾：${botPerm.shortReason}`);
          return;
        }
        db.enableGroup(chatId);
        await ctx.reply("✅ 已开启反垃圾广告检测。\n\n机器人将自动监控群组消息，发现广告即封禁并删除。", { parse_mode: "HTML" });
        break;
      }

      case "off": {
        db.disableGroup(chatId);
        await ctx.reply("⏸️ 已关闭反垃圾广告检测。");
        break;
      }

      case "ai": {
        const action = (parts[1] || "").toLowerCase();
        if (action !== "on" && action !== "off") {
          await ctx.reply("用法: <code>/ai on</code> 或 <code>/ai off</code>", { parse_mode: "HTML" });
          return;
        }
        if (action === "on") {
          if (!(await ensureCommercialFeatureAccess(ctx, chatId, userId, "AI 检测助理"))) {
            return;
          }
          const botPerm = await getBotPermissionStatus(ctx, chatId);
          if (!botPerm.ok) {
            await ctx.reply(`❌ 无法开启 AI 检测：${botPerm.shortReason}`);
            return;
          }
          db.setAIEnabled(chatId, true);
          await ctx.reply("✅ 已开启 AI 检测助理。");
          return;
        }
        db.setAIEnabled(chatId, false, { disabledReason: "manual" });
        await ctx.reply("⏸️ 已关闭 AI 检测助理。");
        break;
      }

      case "status": {
        const config = db.getGroupConfig(chatId);
        const stats = db.getStats(chatId);
        const wl = db.getWhitelist(chatId);
        const botPerm = await getBotPermissionStatus(ctx, chatId);
        const statusText = config?.enabled ? "🟢 已开启" : "🔴 已关闭";
        const pointsStatus = (config?.pointsEnabled ?? false) ? "🟢 已开启" : "🔴 已关闭";
        const aiStatus = (config?.aiEnabled ?? false) ? "🟢 已开启" : "🔴 已关闭";
        const gbStatus = (config?.globalBanEnabled ?? false) ? "🟢 已开启" : "🔴 已关闭";
        const result = [
          `<b>📊 反垃圾状态</b>`,
          ``,
          `• 基本功能开关: ${statusText}`,
          `• AI 检测助理: ${aiStatus}`,
          `• 跨群同步封禁: ${gbStatus}`,
          `• 群组积分系统: ${pointsStatus}`,
          `• ${renderBotPermissionLine(botPerm)}`,
          `• 匹配值阈值: <code>${config?.threshold ?? 0.8}</code>`,
          `• 白名单人数: <code>${wl.length}</code>`,
          `• 累计拦截: <code>${stats.total}</code>`,
          `• 24h 拦截: <code>${stats.today}</code>`,
        ].join("\n");
        await ctx.reply(result, { parse_mode: "HTML" });
        break;
      }

      case "test": {
        const aiEnabled = isAIAvailableInChat(chatId);

        let testText = parts.slice(1).join(" ");

        const reply = ctx.message?.reply_to_message;
        if (reply) {
          testText = testText || reply.text || reply.caption || "";
        }

        const hasReplyPhoto = !!reply?.photo?.length;
        if (!testText && !hasReplyPhoto) {
          await ctx.reply("用法: <code>/test 要测试的文本内容</code> 或直接回复含有文字与图片的消息", { parse_mode: "HTML" });
          return;
        }

        const msg = await ctx.reply(aiEnabled ? "🔍 AI 分析中..." : "🔍 本地样本匹配中...");
        // 后台异步执行，避免 /test 阻塞后续命令处理
        void (async () => {
          let imageUrl: string | undefined;
          try {
            if (reply?.photo && reply.photo.length > 0) {
              const highestRes = reply.photo[reply.photo.length - 1];
              const file = await ctx.api.getFile(highestRes.file_id);
              if (file.file_path) {
                const fileUrl = `https://api.telegram.org/file/bot${process.env.BOT_TOKEN}/${file.file_path}`;
                const response = await axios.get(fileUrl, { responseType: "arraybuffer" });
                const base64 = Buffer.from(response.data, "binary").toString("base64");
                imageUrl = `data:image/jpeg;base64,${base64}`;
              }
            }
          } catch { }

          let loadedSamplesCount = 0;
          let testPortrait = "未知活跃度";
          try {
            if (reply?.from) {
              const globalMaxCount = db.getUserMaxMessageCountAcrossGroups(reply.from.id, 30); // 全局最高

              testPortrait = globalMaxCount > 50
                ? `高活跃老成员（高信任）`
                : globalMaxCount > 20
                  ? `活跃成员（中高信任）`
                  : `新/低活跃成员（低历史）`;
            }

            const samples = db.getSamples(chatId, aiEnabled ? 20 : 80).map((s) => ({
              message_text: s.message_text,
              is_spam: s.is_spam,
            }));
            loadedSamplesCount = samples.length;
            let result: { spam: boolean; argue: boolean; confidence: number; reason: string; model: string };
            if (aiEnabled) {
              // /test 走快速单次检测，并设置硬超时，避免接口异常时阻塞命令队列
              // 超时时返回结构化结果，保持展示风格一致
              const testTimeoutMs = 30_000;
              const timeoutReason = "AI 检测超时，请检查接口配置或稍后重试。";
              result = await Promise.race([
                checkSpam(testText, samples, "", imageUrl, testPortrait, true, getChatAIProvider(chatId)),
                new Promise<{ spam: boolean; argue: boolean; confidence: number; reason: string; model: string }>((resolve) => {
                  setTimeout(() => resolve({
                    spam: false,
                    argue: false,
                    confidence: 0,
                    reason: timeoutReason,
                    model: "None",
                  }), testTimeoutMs);
                }),
              ]);
            } else {
              const targetActivityUserId = reply?.from?.id || userId;
              const groupMsg10 = db.getUserMessageCount(chatId, targetActivityUserId, 10);
              const groupMsg30 = db.getUserMessageCount(chatId, targetActivityUserId, 30);
              result = checkSpamByLocalSamples(testText, samples, {
                groupMsg10,
                groupMsg30,
              });
            }
            if (aiEnabled) {
              const targetUser = reply?.from ?? ctx.from;
              await maybeNotifyAiFailure(ctx, {
                chatId,
                userId: targetUser?.id || userId,
                userName: getUserName(targetUser),
                model: result.model,
                reason: result.reason,
                source: "手动/test",
                messageText: testText,
              });
            }
            const reasonText = cleanupReasonForDisplay(result.reason || "", testPortrait);
            const emoji = result.spam ? "🚨" : result.argue ? "⚠️" : "✅";
            const modeTitle = aiEnabled ? "AI 检测结果" : "本地样本检测结果";
            const resText = [
              `${emoji} <b>${modeTitle}</b>`,
              "",
              `判定: ${result.spam ? "⛔ 垃圾广告" : (result.argue ? "⚠️ 吵架/辱骂" : "✅ 正常消息")}`,
              `匹配值: <code>${(result.confidence * 100).toFixed(1)}%</code>`,
              `原因: ${esc(reasonText)}`,
              `画像: <code>${esc(testPortrait)}</code>`,
              `${aiEnabled ? "AI 模型" : "检测模式"}: <code>${result.model}</code>`,
              `📚 已加载 ${loadedSamplesCount} 条学习样本`,
            ].join("\n");
            await ctx.api.editMessageText(chatId, msg.message_id, resText, {
              parse_mode: "HTML",
              link_preview_options: { is_disabled: true }
            });
          } catch (error: any) {
            const modeTitle = aiEnabled ? "AI 检测结果" : "本地样本检测结果";
            await ctx.api.editMessageText(
              chatId,
              msg.message_id,
              [
                `❌ <b>${modeTitle}</b>`,
                ``,
                ``,
                `判定: ✅ 正常消息`,
                `匹配值: <code>0.0%</code>`,
                `原因: ${esc(error?.message || "未知错误")}`,
                `画像: <code>${esc(testPortrait)}</code>`,
                `${aiEnabled ? "AI 模型" : "检测模式"}: <code>None</code>`,
                `📚 已加载 ${loadedSamplesCount} 条学习样本`,
              ].join("\n"),
              {
                parse_mode: "HTML",
                link_preview_options: { is_disabled: true }
              }
            );
          }
        })();
        break;
      }

      case "log": {
        const logs = db.getRecentLogs(chatId, 10);
        if (logs.length === 0) {
          await ctx.reply("📝 暂无拦截记录。");
          return;
        }
        const lines = logs.map((log, i) => {
          const time = log.created_at.replace("T", " ").slice(0, 16);
          const preview = log.message_text.length > 30 ? log.message_text.slice(0, 30) + "..." : log.message_text;
          return `${i + 1}. <b>${esc(log.user_name)}</b> [${(log.confidence * 100).toFixed(0)}%]\n   ${esc(preview)}\n   <i>${time}</i>`;
        });
        await ctx.reply(`<b>📝 最近拦截记录</b>\n\n${lines.join("\n\n")}`, { parse_mode: "HTML" });
        break;
      }

      case "wl": {
        const wlAction = parts[1]?.toLowerCase();
        if (wlAction === "add") {
          const reply = ctx.message?.reply_to_message;
          if (!reply?.from) {
            await ctx.reply("请回复目标用户的消息来添加白名单。");
            return;
          }
          const targetId = reply.from.id;
          const targetName = getUserName(reply.from);
          db.addWhitelist(chatId, targetId);
          await ctx.reply(`✅ 已将 <b><a href="tg://user?id=${targetId}">${esc(targetName)}</a></b> 添加到白名单。`, { parse_mode: "HTML" });
          break;
        }
        if (wlAction === "rm" || wlAction === "del") {
          const reply = ctx.message?.reply_to_message;
          if (!reply?.from) {
            await ctx.reply("请回复目标用户的消息来移除白名单。");
            return;
          }
          const targetId = reply.from.id;
          const targetName = getUserName(reply.from);
          const removed = db.removeWhitelist(chatId, targetId);
          if (removed) await ctx.api.sendMessage(chatId, `✅ 已将 <b><a href="tg://user?id=${targetId}">${esc(targetName)}</a></b> 从白名单移除。`, { parse_mode: "HTML" });
          else await ctx.api.sendMessage(chatId, `ℹ️ <b><a href="tg://user?id=${targetId}">${esc(targetName)}</a></b> 不在本群白名单中。`, { parse_mode: "HTML" });
          break;
        }
        if (wlAction === "list" || !wlAction) {
          const wlList = db.getWhitelist(chatId);
          if (wlList.length === 0) await ctx.reply("📋 白名单为空。");
          else {
            const lines = await Promise.all(
              wlList.map(async (id, i) => `${i + 1}. ${await renderUserLink(ctx, chatId, id)} (<code>${id}</code>)`)
            );
            const listText = lines.join("\n");
            await ctx.reply(`<b>📋 白名单</b>\n\n${listText}`, { parse_mode: "HTML" });
          }
          break;
        }
        await ctx.reply("用法: <code>/wl add|rm|list</code>（回复消息使用）", { parse_mode: "HTML" });
        break;
      }

      case "threshold": {
        const val = parseFloat(parts[1]);
        if (isNaN(val) || val < 0 || val > 1) {
          const current = db.getThreshold(chatId);
          await ctx.reply(`当前阈值: <code>${current}</code>\n用法: <code>/threshold 0.8</code>（取值 0-1）`, { parse_mode: "HTML" });
          return;
        }
        db.setThreshold(chatId, val);
        await ctx.reply(`✅ 已设置匹配值阈值为 <code>${val}</code>`, { parse_mode: "HTML" });
        break;
      }

      case "ban":
      case "mark": {
        const reply = ctx.message?.reply_to_message;
        if (!reply) {
          await ctx.reply("请回复一条包含文字或图片的消息来标记为广告样本。");
          return;
        }
        const directPoll = activePolls.get(`${chatId}:${reply.message_id}`);
        const relatedPolls = directPoll
          ? [directPoll]
          : findRelatedPolls(chatId, {
            userMessageId: reply.message_id,
            userId: reply.from?.is_bot ? undefined : reply.from?.id,
          });
        const primaryPoll = relatedPolls[0];
        const targetMessageId = primaryPoll?.userMessageId ?? reply.message_id;
        const replyText = primaryPoll?.text ?? reply.text ?? reply.caption ?? "";
        const logText = replyText || "[纯图片]";
        const spamUserId = primaryPoll?.userId ?? reply.from?.id;
        const spamUserName = primaryPoll?.userName ?? getUserName(reply.from);
        const targetIsBot = primaryPoll ? false : !!reply.from?.is_bot;
        const spamUserLink = spamUserId
          ? await renderUserLink(ctx, chatId, spamUserId)
          : `<b>${esc(spamUserName)}</b>`;
        let inviterText = "";
        if (spamUserId) {
          const inviterInfo = db.getInviterInfo(chatId, spamUserId);
          if (inviterInfo) {
            const inviterLink = await renderUserLink(ctx, chatId, inviterInfo.id);
            inviterText = `\n👤 <b>邀请人:</b> ${inviterLink} (<code>${inviterInfo.id}</code>)`;
          }
        }
        db.addSample(chatId, logText, true, userId);
        const sc = db.getSampleCount(chatId);
        let sourceMessageRemoved = false;
        try {
          await ctx.api.deleteMessage(chatId, targetMessageId);
          sourceMessageRemoved = true;
        } catch (e: any) {
          if (isMessageDeleteUnavailableError(e)) {
            sourceMessageRemoved = true;
          }
        }
        if (spamUserId && !targetIsBot && !(await checkIsAdmin(ctx, chatId, spamUserId))) {
          let banned = false;
          let deletedRecentCount = 0;
          try {
            await banUserPermanently(ctx.api, chatId, spamUserId);
            banned = true;
          } catch { }
          if (banned) {
            deletedRecentCount = await deleteRecentUserMessages(ctx.api, chatId, spamUserId);
          }
          if (sourceMessageRemoved) deletedRecentCount += 1;
          for (const poll of relatedPolls) {
            await dismissPoll(poll);
          }
          db.addLog(chatId, spamUserId, spamUserName, logText, 1.0, "管理员手动标记为广告");
          db.addGlobalBan(spamUserId, spamUserName, "管理员手动标记为广告", 1.0, chatId);
          const staleGroupIds: number[] = [];
          for (const gid of getGlobalBanSyncGroupIds(chatId)) {
            if (gid === chatId) continue;
            try {
              await banUserPermanently(ctx.api, gid, spamUserId);
              await deleteRecentUserMessages(ctx.api, gid, spamUserId);
            } catch (e: any) {
              if (e instanceof GrammyError && e.description.includes("user is an administrator")) {
                continue;
              }
              if (isGroupUnavailableError(e)) {
                staleGroupIds.push(gid);
              } else {
                console.error(`[AntiSpam] 管理员手动封禁跨群同步失败 (群 ${gid}):`, e);
              }
            }
          }
          if (staleGroupIds.length > 0) {
            for (const gid of staleGroupIds) {
              db.closeAllGroupSwitches(gid);
              adminCache.delete(gid);
            }
            console.warn(`[AntiSpam] 已自动清理 ${staleGroupIds.length} 个失效跨群封禁群组: ${staleGroupIds.join(", ")}`);
          }
          const chatRef = await renderChatReference(chatId);
          notifyAdmin(`🚨 <b>管理员手动封禁通知</b>\n\n群组: ${chatRef}\n用户: <a href="tg://user?id=${spamUserId}"><b>${esc(spamUserName)}</b></a> (<code>${spamUserId}</code>)\n原因: 管理员手动标记为广告${inviterText}\n内容:\n<i>${formatPreview(logText)}</i>`);
          const notice = await ctx.reply(`🚫 <b>已手动标记并封禁</b>\n\n用户: ${spamUserLink} (<code>${spamUserId}</code>)${inviterText}\n🧹 已删除其近期发言 ${deletedRecentCount} 条\n📚 当前样本: 广告 ${sc.spam} 条 / 正常 ${sc.safe} 条`, { parse_mode: "HTML" });
          setTimeout(async () => { try { await ctx.api.deleteMessage(chatId, notice.message_id); } catch { } }, 10_000);
        } else {
          const targetText = spamUserId ? `${spamUserLink} (<code>${spamUserId}</code>)` : `<b>${esc(spamUserName)}</b>`;
          await ctx.reply(`✅ 已标记为 <b>广告样本</b>（目标用户为管理员，未封禁）\n用户: ${targetText}\n📚 当前样本: 广告 ${sc.spam} 条 / 正常 ${sc.safe} 条`, { parse_mode: "HTML" });
        }
        break;
      }

      case "safe": {
        const reply = ctx.message?.reply_to_message;
        if (!reply) {
          await ctx.reply("请回复一条包含文字或被误判的图片消息来标记为正常。");
          return;
        }
        const replyText = reply.text || reply.caption || "";
        db.addSample(chatId, replyText || "[纯图片]", false, userId);
        const sc = db.getSampleCount(chatId);
        await ctx.reply(`✅ 已标记为 <b>正常消息</b>\n📚 当前样本: 广告 ${sc.spam} 条 / 正常 ${sc.safe} 条`, { parse_mode: "HTML" });
        break;
      }

      case "samples": {
        const action = parts[1]?.toLowerCase();
        if (action === "rm" || action === "del") {
          const sampleId = parseInt(parts[2]);
          if (isNaN(sampleId)) {
            await ctx.reply("用法: <code>/samples rm 样本ID</code>", { parse_mode: "HTML" });
            return;
          }
          const removed = db.removeSample(sampleId);
          await ctx.reply(removed ? "✅ 已删除样本" : "❌ 样本不存在");
          break;
        }
        const samples = db.getSamples(chatId, 15);
        if (samples.length === 0) {
          await ctx.reply("📚 暂无学习样本。\n\n回复消息使用 <code>/ban</code> 标记广告 或 <code>/safe</code> 标记正常消息。", { parse_mode: "HTML" });
          return;
        }
        const sc = db.getSampleCount(chatId);
        const lines = samples.map(s => `${s.id}. ${s.is_spam ? "🚫广告" : "✅正常"} ${esc(s.message_text.slice(0, 40))}`);
        await ctx.reply(`<b>📚 学习样本</b> (广告 ${sc.spam} / 正常 ${sc.safe})\n\n${lines.join("\n")}\n\n删除: <code>/samples rm ID</code>`, { parse_mode: "HTML" });
        break;
      }

      case "invite": {
        if (!(await checkIsAdmin(ctx, chatId, userId))) {
          await ctx.reply("🚫 仅管理员可使用 <code>/invite</code> 系列命令。", { parse_mode: "HTML" });
          return;
        }
        const action = parts[1]?.toLowerCase();
        const commercialInviteActions = new Set(["price", "gen", "create", "revoke", "rm", "del", "list", "logs", "log", "on"]);
        if (action && commercialInviteActions.has(action) && !(await ensureCommercialFeatureAccess(ctx, chatId, userId, "进群核销"))) {
          return;
        }
        if (action === "price") {
          const price = parseInt(parts[2]);
          if (isNaN(price) || price < 0) {
            await ctx.reply("用法: <code>/invite price 100</code>", { parse_mode: "HTML" });
            return;
          }
          db.setVoucherPrice(chatId, price);
          await ctx.reply(`✅ 已设置进群核销券价格为 <code>${price}</code> 积分。`, { parse_mode: "HTML" });
        } else if (action === "channel") {
          const channelRaw = (parts[2] || "").trim();
          const channelArg = channelRaw.toLowerCase();
          if (!channelRaw) {
            return ctx.reply(
              "❌ 请指定频道 ID 或 @用户名。\n用法：<code>/invite channel @MyChannel</code>\n清除：<code>/invite channel clear</code>",
              { parse_mode: "HTML" }
            );
          }
          if (channelArg === "clear" || channelArg === "off" || channelArg === "none") {
            db.setRequiredChannel(chatId, "");
            return ctx.reply("✅ 已清除必关注频道设置。");
          }
          // 检查机器人是否在该频道并拥有管理员权限
          try {
            const me = await ctx.api.getMe();
            const botMember = await ctx.api.getChatMember(channelRaw, me.id);
            const botStatus = String((botMember as any)?.status || "");
            if (botStatus !== "administrator" && botStatus !== "creator") {
              return ctx.reply(
                `❌ 机器人在频道 <code>${esc(channelRaw)}</code> 中不是管理员。\n\n请先将机器人添加到该频道并设置为管理员，然后再设置必关频道。`,
                { parse_mode: "HTML" }
              );
            }
          } catch (err: any) {
            const desc = String(err?.description || err?.message || "").toLowerCase();
            if (desc.includes("chat not found")) {
              return ctx.reply(
                `❌ 找不到频道 <code>${esc(channelRaw)}</code>。\n\n请检查频道 ID 或用户名是否正确。`,
                { parse_mode: "HTML" }
              );
            }
            if (desc.includes("not a member") || desc.includes("forbidden") || desc.includes("bot was kicked")) {
              return ctx.reply(
                `❌ 机器人不在频道 <code>${esc(channelRaw)}</code> 中。\n\n请先将机器人添加到该频道并设置为管理员。`,
                { parse_mode: "HTML" }
              );
            }
            return ctx.reply(
              `❌ 无法检查频道 <code>${esc(channelRaw)}</code> 的权限：${esc(String(err?.description || err?.message || "未知错误"))}`,
              { parse_mode: "HTML" }
            );
          }
          db.setRequiredChannel(chatId, channelRaw);
          return ctx.reply(`✅ 已设置必关注频道为：<code>${esc(channelRaw)}</code>`, { parse_mode: "HTML" });
        } else if (action === "gen" || action === "create") {
          const botPerm = await getBotPermissionStatus(ctx, chatId);
          if (!botPerm.ok) {
            await ctx.reply(`❌ 无法生成邀请码：${botPerm.shortReason}`);
            return;
          }
          const countArg = parts[2];
          const count = countArg ? parseInt(countArg) : 1;
          if (isNaN(count) || count <= 0 || count > 20) {
            await ctx.reply("用法: <code>/invite gen [数量]</code>（数量 1-20，默认 1）", { parse_mode: "HTML" });
            return;
          }

          const codes: string[] = [];
          const maxAttempts = count * 20;
          let attempts = 0;

          while (codes.length < count && attempts < maxAttempts) {
            attempts++;
            const code = generateInviteCode();
            const ok = db.createInviteVoucher(chatId, userId, code);
            if (ok) codes.push(code);
          }

          if (codes.length === 0) {
            await ctx.reply("❌ 生成邀请码失败，请稍后重试。");
            return;
          }

          const list = codes.map((c, i) => `${i + 1}. <code>${c}</code>`).join("\n");
          const suffix = codes.length < count ? `\n\n⚠️ 目标 ${count} 个，实际生成 ${codes.length} 个。` : "";
          await ctx.reply(`✅ 已生成 <b>${codes.length}</b> 个邀请码：\n\n${list}${suffix}\n\n<i>请私发给待入群成员使用。</i>`, { parse_mode: "HTML" });
        } else if (action === "revoke" || action === "rm" || action === "del") {
          const codeRaw = parts[2];
          const code = codeRaw?.trim().toUpperCase();
          if (!code) {
            await ctx.reply("用法: <code>/invite revoke 邀请码</code>", { parse_mode: "HTML" });
            return;
          }

          const result = db.revokeInviteVoucher(chatId, code);
          if (result === "revoked") {
            await ctx.reply(`✅ 邀请码 <code>${code}</code> 已作废。`, { parse_mode: "HTML" });
          } else if (result === "used") {
            await ctx.reply(`ℹ️ 邀请码 <code>${code}</code> 已被使用，无法作废。`, { parse_mode: "HTML" });
          } else if (result === "already_revoked") {
            await ctx.reply(`ℹ️ 邀请码 <code>${code}</code> 已是作废状态。`, { parse_mode: "HTML" });
          } else {
            await ctx.reply(`❌ 未找到邀请码 <code>${code}</code>。`, { parse_mode: "HTML" });
          }
        } else if (action === "list" || action === "logs" || action === "log") {
          if (!(await checkIsAdmin(ctx, chatId, userId))) {
            await ctx.reply("🚫 仅管理员可使用 <code>/invite list</code>。", { parse_mode: "HTML" });
            return;
          }
          const pageArg = parseInt(parts[2] || "1");
          const page = isNaN(pageArg) ? 0 : Math.max(0, pageArg - 1);
          const pageData = await buildInviteVoucherLogsPage(ctx, chatId, page);
          if (!pageData) {
            await ctx.reply("📭 暂无邀请码记录。");
            return;
          }
          const totalPages = pageData.totalPages;
          const dmText = totalPages > 1
            ? `${pageData.text}\n\n<i>查看更多请在群内使用：</i> <code>/invite list 页码</code>`
            : pageData.text;
          try {
            await ctx.api.sendMessage(userId, dmText, {
              parse_mode: "HTML",
              link_preview_options: { is_disabled: true },
            });
          } catch (e: any) {
            const desc = String(e?.description || e?.message || "");
            if (/can't initiate|forbidden|blocked/i.test(desc)) {
              await ctx.reply("⚠️ 无法发送到私聊，请先私聊机器人并发送 <code>/start</code>，再回来执行 <code>/invite list</code>。", { parse_mode: "HTML" });
            } else {
              await ctx.reply("❌ 发送私聊失败，请稍后再试。");
            }
            return;
          }

          const ack = await ctx.reply("✅ 邀请码记录已发送到你的私聊，请查收。");
          setTimeout(() => ctx.api.deleteMessage(chatId, ack.message_id).catch(() => { }), 20_000);
        } else if (action === "on") {
          const botPerm = await getBotPermissionStatus(ctx, chatId);
          if (!botPerm.ok) {
            await ctx.reply(`❌ 无法开启进群核销：${botPerm.shortReason}`);
            return;
          }
          db.setInvitationRequired(chatId, true);
          await ctx.reply("✅ 已开启进群核销模式。新成员必须通过私聊验证方可入群。");
        } else if (action === "off") {
          db.setInvitationRequired(chatId, false);
          await ctx.reply("🔴 已关闭进群核销模式。");
        } else {
          await ctx.reply("用法: <code>/invite channel &lt;@频道ID|clear&gt;|price|gen|revoke|list [页码]|on|off</code>", { parse_mode: "HTML" });
        }
        break;
      }

      case "import": {
        await handlePointsImport(parts[1]);
        break;
      }

      case "points": {
        const action = (parts[1] || "").toLowerCase();
        if (action === "import") {
          await handlePointsImport(parts[2]);
          break;
        }
        if (action === "admin") {
          if (!(await ensurePointsPermissionManager(ctx, chatId, userId))) {
            return;
          }
          const adminAction = (parts[2] || "list").toLowerCase();
          const access = db.getCommercialChatAccess(chatId);
          const ownerUserId = Number(access?.ownerUserId || 0);
          if (adminAction === "list") {
            const delegated = db.getPointsAdminUsers(chatId);
            const lines = delegated.length > 0
              ? await Promise.all(delegated.map(async (item, index) => {
                const userLink = await renderUserLink(ctx, chatId, item.user_id);
                const addedBy = item.added_by > 0 ? ` / 授权人 <code>${item.added_by}</code>` : "";
                return `${index + 1}. ${userLink} (<code>${item.user_id}</code>)${addedBy}`;
              }))
              : ["暂无额外授权管理员。"];
            const ownerText = ownerUserId > 0
              ? `${await renderUserLink(ctx, chatId, ownerUserId)} (<code>${ownerUserId}</code>)`
              : "未找到绑定账号";
            await ctx.reply(
              [
                "<b>🔐 积分权限名单</b>",
                "",
                `默认权限账号: ${ownerText}`,
                "",
                "额外授权管理员:",
                ...lines,
                "",
                "授权命令: <code>/points admin add [用户ID]</code>（或回复管理员消息执行）",
                "移除命令: <code>/points admin rm [用户ID]</code>",
              ].join("\n"),
              { parse_mode: "HTML" }
            );
            break;
          }

          const explicitTargetId = Number(parts[3] || 0);
          const targetId = explicitTargetId > 0 ? explicitTargetId : (ctx.message?.reply_to_message?.from?.id || 0);
          if (!targetId) {
            await ctx.reply(
              "用法:\n<code>/points admin add [用户ID]</code>\n<code>/points admin rm [用户ID]</code>\n\n也可以直接回复目标管理员的消息执行。",
              { parse_mode: "HTML" }
            );
            return;
          }

          if (["add", "allow"].includes(adminAction)) {
            if (targetId === ownerUserId) {
              await ctx.reply("ℹ️ 当前绑定的订阅账号默认已有该权限，无需重复授权。", { parse_mode: "HTML" });
              return;
            }
            if (!(await checkIsAdmin(ctx, chatId, targetId))) {
              await ctx.reply("⚠️ 只能授权当前仍在本群的管理员。", { parse_mode: "HTML" });
              return;
            }
            db.addPointsAdminUser(chatId, targetId, userId);
            const targetUserLink = await renderUserLink(ctx, chatId, targetId);
            await ctx.reply(`✅ 已授权 ${targetUserLink} (<code>${targetId}</code>) 使用积分导入与积分奖品抽奖。`, { parse_mode: "HTML" });
            return;
          }

          if (["rm", "del", "remove"].includes(adminAction)) {
            const removed = db.removePointsAdminUser(chatId, targetId);
            if (!removed) {
              await ctx.reply(`ℹ️ 用户 <code>${targetId}</code> 不在积分权限授权名单中。`, { parse_mode: "HTML" });
              return;
            }
            const targetUserLink = await renderUserLink(ctx, chatId, targetId);
            await ctx.reply(`✅ 已移除 ${targetUserLink} (<code>${targetId}</code>) 的积分权限授权。`, { parse_mode: "HTML" });
            return;
          }

          await ctx.reply(
            "用法:\n<code>/points import [set|add]</code>\n<code>/points admin list</code>\n<code>/points admin add [用户ID]</code>\n<code>/points admin rm [用户ID]</code>",
            { parse_mode: "HTML" }
          );
          return;
        }
        await ctx.reply(
          "用法:\n<code>/points import [set|add]</code>\n<code>/points admin list</code>\n<code>/points admin add [用户ID]</code>\n<code>/points admin rm [用户ID]</code>",
          { parse_mode: "HTML" }
        );
        break;
      }

      case "unban": {
        const targetId = parseInt(parts[1]);
        if (isNaN(targetId)) {
          await ctx.reply("用法: <code>/unban 用户ID</code>", { parse_mode: "HTML" });
          return;
        }
        const removed = db.removeGlobalBan(targetId);
        const targetUserLink = await renderUserLink(ctx, chatId, targetId);
        let unbanCount = 0;
        const allGroups = db.getAllTrackedGroups();
        for (const gid of allGroups) {
          try {
            await ctx.api.unbanChatMember(gid, targetId);
            unbanCount++;
          } catch (e) {
            // 忽略未被封禁的群组或无权限情况
          }
        }

        if (removed || unbanCount > 0) {
          await ctx.reply(`✅ 已尝试将用户 ${targetUserLink} (<code>${targetId}</code>) 解封。\n(从全局黑名单移除，并在 ${unbanCount} 个群组中执行了解封指令)`, { parse_mode: "HTML" });
        } else {
          await ctx.reply(`ℹ️ 未找到用户 ${targetUserLink} (<code>${targetId}</code>) 的相关跨群拦截和全局封禁日志，已执行 ${unbanCount} 个群组的安全解封。您也可以直接在发生封禁的群组设置里尝试手动将其解封。`, { parse_mode: "HTML" });
        }
        break;
      }

    }
  };

  const handleAssistantManageCommand = async (ctx: Context) => {
    if (!ctx.chat || ctx.chat.type === "private") {
      await ctx.reply("⚠️ 此命令仅在群组中可用。");
      return;
    }

    const chatId = ctx.chat.id;
    const userId = ctx.from?.id;
    if (!userId) {
      await ctx.reply("⚠️ 请关闭匿名管理员后再使用此命令。");
      return;
    }

    try {
      await ctx.deleteMessage();
    } catch { }

    if (!(await checkIsAdmin(ctx, chatId, userId))) {
      await ctx.reply("🚫 只有群管理员可以查看助理说明。群管理员默认拥有助理使用权限。", { parse_mode: "HTML" });
      return;
    }

    const text = ctx.message?.text || "";
    const m = text.match(ASSISTANT_CMD_REGEX);
    const argText = (m?.[1] || "").trim();
    const [subRaw, ...restParts] = argText.split(/\s+/).filter(Boolean);
    const sub = (subRaw || "help").toLowerCase();
    const targetArg = restParts.join(" ").trim();

    if (sub === "help" || !argText) {
      await ctx.reply(
        [
          "🧠 <b>助理权限管理</b>",
          "",
          "群管理员默认拥有 AI 检测助理使用权限，无需单独添加名单。",
          "开启 AI 后，管理员可直接回复机器人或 @机器人 使用自然语言执行管理操作。",
          "普通群员也可以回复机器人或 @机器人 使用非管理员权限的自然语言能力，例如查自己的积分、看积分榜、发起抽奖。",
          "",
          "<b>[自然语言可直接执行]</b>",
          "• 查看群状态、最近处理日志、今天发言名单",
          "• 开关 antispam / AI / 积分 / 跨群封禁",
          "• 调整阈值、查看白名单、加减白名单",
          "• 查用户发言、积分、积分流水、积分榜、是否在群",
          "• 禁言 / 解除禁言（高风险动作会二次确认）",
          "• 创建抽奖、开启/关闭挑衅机器人自动处理",
          "",
          "<b>[群内命令能力]</b>",
          "• <code>/ads</code> / <code>/antispam</code> 配置主菜单",
          "• <code>/pass</code> <code>/jy</code> <code>/unjy</code> <code>/ai on|off</code> <code>/status</code> <code>/threshold</code> <code>/log</code>",
          "• 回复目标消息发送 <code>/ty</code> 或“偷油”可偷积分（每日一次）",
          "• <code>/test</code> <code>/wl add|rm|list</code> <code>/ban</code> <code>/safe</code> <code>/samples</code>",
          "• <code>/invite ...</code> <code>/points import ...</code> <code>/points admin ...</code> <code>/import ...</code> <code>/unban</code>",
          "• <code>/jl</code> <code>/jf</code> <code>/jfph</code> <code>/dh</code> <code>/yq</code>",
          "• <code>/claim</code> <code>/unbind</code> <code>/cj</code> <code>/kw help</code> <code>/dc</code> <code>/id</code>",
          "• <code>/wd</code> <code>/ww</code> <code>/rr</code> <code>/dd</code> <code>/21</code>",
          "• 发送“积分”可快捷查积分，发送“抽奖”可跳转当前抽奖",
          "",
          "<b>[私聊/订阅能力]</b>",
          "• <code>/console</code> 打开订阅控制台",
          "• <code>/sub</code> 查看订阅状态",
          "• 总控可用 <code>/sub grant</code>、<code>/groups</code>",
          "",
          "<b>[挑衅规则示例]</b>",
          "• <code>@机器人 把挑衅你的都禁言掉</code>",
          "• <code>@机器人 开启挑衅机器人自动处理</code>",
          "• <code>@机器人 关闭挑衅机器人自动处理</code>",
        ].join("\n"),
        { parse_mode: "HTML" }
      );
      return;
    }

    if (["list", "add", "allow", "rm", "del", "remove"].includes(sub)) {
      await ctx.reply(
        "ℹ️ 现在无需单独维护助理名单，群管理员默认可使用 AI 检测助理。",
        { parse_mode: "HTML" }
      );
      return;
    }

    if (sub !== "help") {
      await ctx.reply("❌ 未识别的子命令。发送 <code>/assistant help</code> 查看用法。", { parse_mode: "HTML" });
      return;
    }
  };

  const handleAdsCommand = async (ctx: Context) => {
    await runAdsCommand(ctx);
  };

  // 标准命令入口
  bot.command(["antispam", "ads"], handleAdsCommand);
  bot.command("assistant", handleAssistantManageCommand);
  bot.command(
    ["pass", "unjy", "jy", "ai", "status", "test", "log", "wl", "threshold", "ban", "mark", "safe", "samples", "invite", "import", "points", "unban", "importset", "importadd", "wladd", "wlrm"],
    async (ctx) => {
      const text = ctx.message?.text || "";
      const m = text.match(ADS_DIRECT_SUB_CMD_REGEX);
      const sub = (m?.[1] || "").trim().toLowerCase();
      if (!sub) return;
      const rest = (m?.[2] || "").trim();
      const forcedArgText = rest ? `${sub} ${rest}` : sub;
      await runAdsCommand(ctx, forcedArgText);
    }
  );

  // 兜底入口：某些环境下 bot.command 未命中时，按纯文本 /ads(/antispam) 仍可触发
  bot.hears(ADS_CMD_REGEX, async (ctx) => {
    await handleAdsCommand(ctx);
  });
  bot.hears(ASSISTANT_CMD_REGEX, async (ctx) => {
    await handleAssistantManageCommand(ctx);
  });
  bot.hears(ADS_DIRECT_SUB_CMD_REGEX, async (ctx) => {
    const text = ctx.message?.text || "";
    const m = text.match(ADS_DIRECT_SUB_CMD_REGEX);
    const sub = (m?.[1] || "").trim().toLowerCase();
    if (!sub) return;
    const rest = (m?.[2] || "").trim();
    const forcedArgText = rest ? `${sub} ${rest}` : sub;
    await runAdsCommand(ctx, forcedArgText);
  });

  // ==================== 菜单回调处理 (Callback Handlers) ====================
  bot.on("callback_query:data", async (ctx, next) => {
    const data = ctx.callbackQuery.data;
    if (!data.startsWith("ads_")) return await next();

    const chatId = ctx.chat?.id;
    const userId = ctx.from.id;
    if (!chatId) return;

    const cbMsgId = ctx.callbackQuery.message?.message_id;
    if (cbMsgId && !canOperateAdsUi(chatId, cbMsgId, userId)) {
      await ctx.answerCallbackQuery({ text: "这个菜单是别人打开的，请自己发送命令打开。", show_alert: true }).catch(() => { });
      return;
    }

    // 权限策略：默认 ads_ 回调都需要管理员，仅少量“查看说明”入口允许普通成员
    const publicDataPrefixes = [
      "ads_main",
      "ads_games",
      "ads_lottery",
      "ads_query",
      "ads_jf_logs_",
      "ads_jf_back_",
      "ads_jf_rank_",
      "ads_recheck_join_",
    ];
    const isPublicAction = publicDataPrefixes.some(prefix => data.startsWith(prefix));
    if (!isPublicAction && !(await checkIsAdmin(ctx, chatId, userId))) {
      await ctx.answerCallbackQuery({ text: "🚫 仅管理员可进行此项配置。", show_alert: true }).catch(() => { });
      return;
    }

    // 每次点击按钮，刷新自动删除计时器
    if (ctx.callbackQuery.message) {
      refreshAdsMenuTimer(bot, chatId, ctx.callbackQuery.message.message_id);
    }

    const switchMenu = async (text: string, keyboard: InlineKeyboard) => {
      try {
        await ctx.api.editMessageText(chatId, ctx.callbackQuery.message!.message_id, text, {
          parse_mode: "HTML",
          reply_markup: keyboard,
        });
      } catch (e) { }
    };

    // 纯菜单切换先快速应答，避免客户端按钮长时间转圈
    const fastAckActions = new Set([
      "ads_main",
      "ads_basic",
      "ads_status",
      "ads_whitelist",
      "ads_wl_list",
      "ads_samples",
      "ads_invitation",
      "ads_games",
      "ads_lottery",
      "ads_query",
    ]);
    if (fastAckActions.has(data)) {
      await ctx.answerCallbackQuery().catch(() => { });
    }

    switch (data) {
      case "ads_main":
        await switchMenu(`🛡️ <b>反垃圾广告机器人</b>\n\n将机器人设为管理员（删除消息+封禁用户权限）后使用`, getAdsMainMenu());
        break;

      case "ads_basic": {
        const config = db.getGroupConfig(chatId);
        const botPerm = await getBotPermissionStatus(ctx, chatId);
        const isEnabled = config?.enabled ?? false;
        const isGbEnabled = config?.globalBanEnabled ?? false;
        const isPointsEnabled = config?.pointsEnabled ?? false;
        const isAiEnabled = config?.aiEnabled ?? false;
        const statusText = isEnabled ? "🟢 已开启" : "🔴 已关闭";
        const gbStatus = isGbEnabled ? "🟢 已开启" : "🔴 已关闭";
        const pointsStatus = isPointsEnabled ? "🟢 已开启" : "🔴 已关闭";
        const aiStatus = isAiEnabled ? "🟢 已开启" : "🔴 已关闭";
        await switchMenu(
          `⚙️ <b>基本功能控制</b>\n\n` +
          `• 基本功能开关: ${statusText}\n` +
          `• AI 检测助理: ${aiStatus}\n` +
          `• 跨群同步封禁: ${gbStatus}\n` +
          `• 群组积分系统: ${pointsStatus}\n` +
          `• ${renderBotPermissionLine(botPerm)}\n\n` +
          `<b>[文字指令]</b>\n• <code>/ban</code> — 标记并封禁(需回复被拦截消息)\n• <code>/unban 用户ID</code> — 全局解封用户(或回复消息使用)\n• <code>/jy 用户ID</code> — 手动禁言(或回复使用/可带时间)\n• <code>/unjy 用户ID</code> — 解除禁言(或回复消息使用)\n• <code>/threshold 0.8</code> — 设置匹配阈值\n• <code>/test 文本内容</code> — 手动测试 (或回复消息使用)\n• <code>/assistant help</code> — 查看 AI 检测助理说明\n• <code>/claim</code> — 将当前群/频道认领到你的订阅账号\n• 私聊 <code>/console</code> — 打开订阅控制台并申请订阅\n<i>开启 AI 后，已绑定有效订阅的群管理员可通过回复机器人或 @机器人 直接说自然语言执行管理操作。</i>\n<i>挑衅规则示例：<code>@机器人 把挑衅你的都禁言掉</code></i>\n\n<b>[积分管理] - 批量导入</b>\n• <code>/import set</code> — 覆盖积分(回复“用户ID 积分”文本)\n• <code>/import add</code> — 追加积分(回复“用户ID 积分”文本)\n• <code>/points admin add</code> — 绑定账号授权其他群管理员使用积分导入/积分奖品抽奖\n• <code>/points admin list</code> — 查看已授权管理员\n<i>[文本模版]</i>\n<code>123456789 100</code>\n<code>987654321 250</code>`,
          getAdsBasicMenu(
            config?.enabled ?? false,
            config?.globalBanEnabled ?? false,
            config?.pointsEnabled ?? false,
            config?.aiEnabled ?? false
          )
        );
        break;
      }

      case "ads_gb_on": {
        if (!(await ensureCommercialFeatureAccess(ctx, chatId, userId, "跨群同步封禁"))) {
          await ctx.answerCallbackQuery({ text: "需要有效订阅后才能开启", show_alert: true }).catch(() => { });
          return;
        }
        const botPerm = await getBotPermissionStatus(ctx, chatId);
        if (!botPerm.ok) {
          await ctx.answerCallbackQuery({ text: `无法开启：${botPerm.shortReason}`, show_alert: true }).catch(() => { });
          return;
        }
        const config = db.getGroupConfig(chatId);
        db.setGlobalBanEnabled(chatId, true);
        await ctx.answerCallbackQuery({ text: "✅ 跨群封禁已开启" }).catch(() => { });
        const text = `⚙️ <b>基本功能控制</b>\n\n• 基本功能开关: ${config?.enabled ? "🟢 已开启" : "🔴 已关闭"}\n• AI 检测助理: ${(config?.aiEnabled ?? false) ? "🟢 已开启" : "🔴 已关闭"}\n• 跨群同步封禁: 🟢 已开启\n• 群组积分系统: ${(config?.pointsEnabled ?? false) ? "🟢 已开启" : "🔴 已关闭"}\n\n✅ 已开启跨群封禁。机器人将自动踢出在其他群组有严重违规记录的用户。`;
        await switchMenu(text, getAdsBasicMenu(config?.enabled ?? false, true, config?.pointsEnabled ?? false, config?.aiEnabled ?? false));
        break;
      }

      case "ads_gb_off": {
        const config = db.getGroupConfig(chatId);
        db.setGlobalBanEnabled(chatId, false);
        await ctx.answerCallbackQuery({ text: "🔴 跨群封禁已关闭" }).catch(() => { });
        const text = `⚙️ <b>基本功能控制</b>\n\n• 基本功能开关: ${config?.enabled ? "🟢 已开启" : "🔴 已关闭"}\n• AI 检测助理: ${(config?.aiEnabled ?? false) ? "🟢 已开启" : "🔴 已关闭"}\n• 跨群同步封禁: 🔴 已关闭\n• 群组积分系统: ${(config?.pointsEnabled ?? false) ? "🟢 已开启" : "🔴 已关闭"}\n\n🔴 已关闭跨群封禁。机器人将不再自动踢出全局封禁名单中的用户。`;
        await switchMenu(text, getAdsBasicMenu(config?.enabled ?? false, false, config?.pointsEnabled ?? false, config?.aiEnabled ?? false));
        break;
      }

      case "ads_points_on": {
        if (!(await ensureCommercialFeatureAccess(ctx, chatId, userId, "积分系统"))) {
          await ctx.answerCallbackQuery({ text: "需要有效订阅后才能开启", show_alert: true }).catch(() => { });
          return;
        }
        const botPerm = await getBotPermissionStatus(ctx, chatId);
        if (!botPerm.ok) {
          await ctx.answerCallbackQuery({ text: `无法开启：${botPerm.shortReason}`, show_alert: true }).catch(() => { });
          return;
        }
        const config = db.getGroupConfig(chatId);
        db.setPointsEnabled(chatId, true);
        await ctx.answerCallbackQuery({ text: "✅ 积分系统已开启" }).catch(() => { });
        const text = `⚙️ <b>基本功能控制</b>\n\n• 基本功能开关: ${config?.enabled ? "🟢 已开启" : "🔴 已关闭"}\n• AI 检测助理: ${(config?.aiEnabled ?? false) ? "🟢 已开启" : "🔴 已关闭"}\n• 跨群同步封禁: ${config?.globalBanEnabled ? "🟢 已开启" : "🔴 已关闭"}\n• 群组积分系统: 🟢 已开启\n\n✅ 已开启积分系统。群成员发言将累计积分，可用于兑换/抽奖。`;
        await switchMenu(text, getAdsBasicMenu(config?.enabled ?? false, config?.globalBanEnabled ?? false, true, config?.aiEnabled ?? false));
        break;
      }

      case "ads_points_off": {
        const config = db.getGroupConfig(chatId);
        db.setPointsEnabled(chatId, false);
        await ctx.answerCallbackQuery({ text: "🔴 积分系统已关闭" }).catch(() => { });
        const text = `⚙️ <b>基本功能控制</b>\n\n• 基本功能开关: ${config?.enabled ? "🟢 已开启" : "🔴 已关闭"}\n• AI 检测助理: ${(config?.aiEnabled ?? false) ? "🟢 已开启" : "🔴 已关闭"}\n• 跨群同步封禁: ${config?.globalBanEnabled ? "🟢 已开启" : "🔴 已关闭"}\n• 群组积分系统: 🔴 已关闭\n\n🔴 已关闭积分系统。将停止积分累计，并禁用积分兑换/查询。`;
        await switchMenu(text, getAdsBasicMenu(config?.enabled ?? false, config?.globalBanEnabled ?? false, false, config?.aiEnabled ?? false));
        break;
      }

      case "ads_ai_on": {
        if (!(await ensureCommercialFeatureAccess(ctx, chatId, userId, "AI 检测助理"))) {
          await ctx.answerCallbackQuery({ text: "需要有效订阅后才能开启", show_alert: true }).catch(() => { });
          return;
        }
        const botPerm = await getBotPermissionStatus(ctx, chatId);
        if (!botPerm.ok) {
          await ctx.answerCallbackQuery({ text: `无法开启：${botPerm.shortReason}`, show_alert: true }).catch(() => { });
          return;
        }
        const config = db.getGroupConfig(chatId);
        db.setAIEnabled(chatId, true);
        await ctx.answerCallbackQuery({ text: "✅ AI检测助理已开启" }).catch(() => { });
        const text = `⚙️ <b>基本功能控制</b>\n\n• 基本功能开关: ${config?.enabled ? "🟢 已开启" : "🔴 已关闭"}\n• AI 检测助理: 🟢 已开启\n• 跨群同步封禁: ${config?.globalBanEnabled ? "🟢 已开启" : "🔴 已关闭"}\n• 群组积分系统: ${(config?.pointsEnabled ?? false) ? "🟢 已开启" : "🔴 已关闭"}\n\n✅ 已开启 AI 检测助理。机器人将调用 AI 接口进行广告分析，并允许管理员使用自然语言助理。`;
        await switchMenu(text, getAdsBasicMenu(config?.enabled ?? false, config?.globalBanEnabled ?? false, config?.pointsEnabled ?? false, true));
        break;
      }

      case "ads_ai_off": {
        const config = db.getGroupConfig(chatId);
        db.setAIEnabled(chatId, false, { disabledReason: "manual" });
        await ctx.answerCallbackQuery({ text: "⏸️ AI检测助理已关闭" }).catch(() => { });
        const text = `⚙️ <b>基本功能控制</b>\n\n• 基本功能开关: ${config?.enabled ? "🟢 已开启" : "🔴 已关闭"}\n• AI 检测助理: 🔴 已关闭\n• 跨群同步封禁: ${config?.globalBanEnabled ? "🟢 已开启" : "🔴 已关闭"}\n• 群组积分系统: ${(config?.pointsEnabled ?? false) ? "🟢 已开启" : "🔴 已关闭"}\n\n⏸️ 已关闭 AI 检测助理。不会再调用 AI 接口进行广告分析，群内自然语言助理也会停用。`;
        await switchMenu(text, getAdsBasicMenu(config?.enabled ?? false, config?.globalBanEnabled ?? false, config?.pointsEnabled ?? false, false));
        break;
      }

      case "ads_on": {
        const botPerm = await getBotPermissionStatus(ctx, chatId);
        if (!botPerm.ok) {
          await ctx.answerCallbackQuery({ text: `无法开启：${botPerm.shortReason}`, show_alert: true }).catch(() => { });
          return;
        }
        const config = db.getGroupConfig(chatId);
        db.enableGroup(chatId);
        await ctx.answerCallbackQuery({ text: "✅ 反垃圾已开启" }).catch(() => { });
        const text = `⚙️ <b>基本功能控制</b>\n\n• 基本功能开关: 🟢 已开启\n• AI 检测助理: ${(config?.aiEnabled ?? false) ? "🟢 已开启" : "🔴 已关闭"}\n• 跨群同步封禁: ${config?.globalBanEnabled ? "🟢 已开启" : "🔴 已关闭"}\n• 群组积分系统: ${(config?.pointsEnabled ?? false) ? "🟢 已开启" : "🔴 已关闭"}\n\n✅ 已开启基础防护功能。`;
        await switchMenu(text, getAdsBasicMenu(true, config?.globalBanEnabled ?? false, config?.pointsEnabled ?? false, config?.aiEnabled ?? false));
        break;
      }

      case "ads_off": {
        const config = db.getGroupConfig(chatId);
        db.disableGroup(chatId);
        await ctx.answerCallbackQuery({ text: "⏸️ 反垃圾已关闭" }).catch(() => { });
        const text = `⚙️ <b>基本功能控制</b>\n\n• 基本功能开关: 🔴 已关闭\n• AI 检测助理: ${(config?.aiEnabled ?? false) ? "🟢 已开启" : "🔴 已关闭"}\n• 跨群同步封禁: ${config?.globalBanEnabled ? "🟢 已开启" : "🔴 已关闭"}\n• 群组积分系统: ${(config?.pointsEnabled ?? false) ? "🟢 已开启" : "🔴 已关闭"}\n\n⏸️ 已关闭基础反垃圾流程（AI开关独立）。`;
        await switchMenu(text, getAdsBasicMenu(false, config?.globalBanEnabled ?? false, config?.pointsEnabled ?? false, config?.aiEnabled ?? false));
        break;
      }

      case "ads_status": {
        const config = db.getGroupConfig(chatId);
        const stats = db.getStats(chatId);
        const wl = db.getWhitelist(chatId);
        const botPerm = await getBotPermissionStatus(ctx, chatId);
        const isEnabled = config?.enabled ?? false;
        const isGbEnabled = config?.globalBanEnabled ?? false;
        const isPointsEnabled = config?.pointsEnabled ?? false;
        const isAiEnabled = config?.aiEnabled ?? false;
        const statusText = isEnabled ? "🟢 已开启" : "🔴 已关闭";
        const gbStatus = isGbEnabled ? "🟢 已开启" : "🔴 已关闭";
        const pointsStatus = isPointsEnabled ? "🟢 已开启" : "🔴 已关闭";
        const aiStatus = isAiEnabled ? "🟢 已开启" : "🔴 已关闭";
        const res = [
          `<b>📊 本群反垃圾状态</b>`,
          `• 基本功能开关: ${statusText}`,
          `• AI 检测助理: ${aiStatus}`,
          `• 跨群同步封禁: ${gbStatus}`,
          `• 群组积分系统: ${pointsStatus}`,
          `• ${renderBotPermissionLine(botPerm)}`,
          `• 阈值: <code>${config?.threshold ?? 0.8}</code>`,
          `• 白名单: <code>${wl.length}</code> 人`,
          `• 累计拦截: <code>${stats.total}</code>`,
          `• 24h 拦截: <code>${stats.today}</code>`,
        ].join("\n");
        await switchMenu(res, getAdsBasicMenu(isEnabled, isGbEnabled, isPointsEnabled, isAiEnabled));
        break;
      }

      case "ads_log": {
        const logs = db.getRecentLogs(chatId, 5);
        if (logs.length === 0) {
          await ctx.answerCallbackQuery({ text: "暂无拦截记录" }).catch(() => { });
          return;
        }
        const config = db.getGroupConfig(chatId);
        const lines = logs.map((log, i) => {
          const preview = log.message_text.length > 20 ? log.message_text.slice(0, 20) + "..." : log.message_text;
          return `${i + 1}. <b>${esc(log.user_name)}</b> [${(log.confidence * 100).toFixed(0)}%]\n   ${esc(preview)}`;
        });
        await switchMenu(
          `<b>📝 最近拦截 (Top 5)</b>\n\n${lines.join("\n")}`,
          getAdsBasicMenu(
            config?.enabled ?? false,
            config?.globalBanEnabled ?? false,
            config?.pointsEnabled ?? false,
            config?.aiEnabled ?? false
          )
        );
        break;
      }

      case "ads_whitelist":
        await switchMenu(
          `⚪ <b>白名单列表管理</b>\n\n• 点击下方按钮查看当前列表内容\n\n<b>[文字指令]</b>\n• <code>/wl add</code> — 将用户加入白名单(需回复人消息)\n• <code>/wl rm</code> — 从白名单移除(需回复人消息)`,
          getAdsWhitelistMenu()
        );
        break;

      case "ads_wl_list": {
        const list = db.getWhitelist(chatId);
        let res = "📋 白名单为空。";
        if (list.length > 0) {
          const lines = await Promise.all(
            list.map(async (id, i) => `${i + 1}. ${await renderUserLink(ctx, chatId, id)} (<code>${id}</code>)`)
          );
          res = `<b>📋 白名单</b>\n\n${lines.join("\n")}`;
        }
        await switchMenu(res, getAdsWhitelistMenu());
        break;
      }

      case "ads_samples": {
        const sc = db.getSampleCount(chatId);
        await switchMenu(
          `📚 <b>样本学习库</b> (广告 ${sc.spam} / 正常 ${sc.safe})\n\n<b>[文字指令]</b>\n• <code>/safe</code> — 标记为正常(需回复被误删消息)\n• <code>/samples rm 样本ID</code> — 删除指定 ID 样本`,
          getAdsSamplesMenu()
        );
        break;
      }
      case "ads_invitation": {
        const config = getEffectiveInvitationConfig(chatId);
        let channelStatusText = `<code>${config.requiredChannel || "未设置"}</code>`;
        if (config.requiredChannel) {
          try {
            const me = await ctx.api.getMe();
            const botMember = await ctx.api.getChatMember(config.requiredChannel, me.id);
            const botStatus = String((botMember as any)?.status || "");
            if (botStatus === "administrator" || botStatus === "creator") {
              channelStatusText = `<code>${esc(config.requiredChannel)}</code> 🟢`;
            } else {
              channelStatusText = `<code>${esc(config.requiredChannel)}</code> ⚠️`;
            }
          } catch {
            channelStatusText = `<code>${esc(config.requiredChannel)}</code> ⚠️`;
          }
        }
        const res = [
          `🎟️ <b>邀请核销管理</b>`,
          ``,
          `• 当前状态: ${config.required ? "🟢 已开启" : "🔴 已关闭"}`,
          `• 当前价格: <code>${config.price}</code> 积分`,
          `• 必关频道: ${channelStatusText}`,
          ``,
          `💡 <b>修改价格指令</b>:`,
          `<code>/invite price ${config.price}</code>`,
          ``,
          `💡 <b>设置必关频道</b>:`,
          `<code>/invite channel @频道ID</code>`,
          `<code>/invite channel clear</code>`,
          `<i>(设置后，新成员将被校验是否已关注该频道)</i>`,
          ``,
          `💡 <b>管理员邀请码</b>:`,
          `<code>/invite gen 1</code>`,
          `<code>/invite revoke 邀请码</code>`,
          `<code>/invite list</code>`,
          `<i>(按发放人分页展示，每页最多 10 人)</i>`,
          ``,
          `<i>开启后，新成员将被强制禁言，直到在私聊完成邀请码核销。</i>`,
        ].join("\n");
        await switchMenu(res, getInvitationMenu(config.required));
        break;
      }

      case "ads_invite_on": {
        if (!(await ensureCommercialFeatureAccess(ctx, chatId, userId, "进群核销"))) {
          return;
        }
        const botPerm = await getBotPermissionStatus(ctx, chatId);
        if (!botPerm.ok) {
          await ctx.answerCallbackQuery({ text: `无法开启：${botPerm.shortReason}`, show_alert: true }).catch(() => { });
          return;
        }
        db.setInvitationRequired(chatId, true);
        const config = getEffectiveInvitationConfig(chatId);
        await ctx.answerCallbackQuery({ text: "✅ 核销进群功能已开启" }).catch(() => { });
        const res = [
          `🎟️ <b>邀请核销管理</b>`,
          ``,
          `• 当前状态: 🟢 已开启`,
          `• 当前价格: <code>${config.price}</code> 积分`,
          ``,
          `💡 <b>修改价格指令</b> (点击复制):`,
          `<code>/invite price ${config.price}</code>`,
        ].join("\n");
        await switchMenu(res, getInvitationMenu(true));
        break;
      }

      case "ads_invite_off": {
        db.setInvitationRequired(chatId, false);
        const config = getEffectiveInvitationConfig(chatId);
        await ctx.answerCallbackQuery({ text: "🔴 核销进群功能已关闭" }).catch(() => { });
        const res = [
          `🎟️ <b>邀请核销管理</b>`,
          ``,
          `• 当前状态: 🔴 已关闭`,
          `• 当前价格: <code>${config.price}</code> 积分`,
          ``,
          `💡 <b>修改价格指令</b> (点击复制):`,
          `<code>/invite price ${config.price}</code>`,
        ].join("\n");
        await switchMenu(res, getInvitationMenu(false));
        break;
      }

      case "ads_invite_price_prompt": {
        await ctx.answerCallbackQuery({ text: "请使用指令修改价格：/invite price 金额", show_alert: true }).catch(() => { });
        break;
      }

      default: {
        // 处理管理员手动放行/封禁新人
        if (data.startsWith("ads_pass_join_")) {
          const targetUserId = Number(data.replace("ads_pass_join_", ""));
          const isAdmin = await checkIsAdmin(ctx, chatId, ctx.from.id);
          if (!isAdmin) {
            await ctx.answerCallbackQuery({ text: "🚫 只有管理员可以操作。", show_alert: true }).catch(() => { });
            return;
          }

          let targetName = String(targetUserId);
          try {
            const chat = await ctx.api.getChat(targetUserId);
            if (chat && "first_name" in chat) {
              targetName = chat.first_name + (chat.last_name ? ` ${chat.last_name}` : "");
            } else if (chat && "title" in chat) {
              targetName = chat.title;
            }
          } catch { }

          const info = db.removeUnverifiedMember(chatId, targetUserId);
          try {
            const inviteConfig = getEffectiveInvitationConfig(chatId);
            if ((inviteConfig.requiredChannel || "").trim()) {
              db.markChannelGuardMember(chatId, targetUserId);
            }
            await ctx.api.restrictChatMember(chatId, targetUserId, {
              can_send_messages: true,
              can_send_audios: true,
              can_send_documents: true,
              can_send_photos: true,
              can_send_videos: true,
              can_send_video_notes: true,
              can_send_voice_notes: true,
              can_send_polls: true,
              can_send_other_messages: true,
              can_add_web_page_previews: true,
            });
            if (info?.welcomeMsgId) {
              await ctx.api.deleteMessage(chatId, info.welcomeMsgId).catch(() => { });
            }
            await ctx.answerCallbackQuery({ text: "✅ 已允许该用户加入并解除禁言。" }).catch(() => { });
            const manualPassNotice = await ctx.reply(`✅ <b>放行通知</b>\n管理员已手动允许用户 <a href="tg://user?id=${targetUserId}">${esc(targetName)}</a> 入群。`, { parse_mode: "HTML" });
            scheduleAutoDeleteMessage(ctx, chatId, manualPassNotice.message_id, PASS_NOTICE_AUTO_DELETE_MS);
          } catch (e) {
            await ctx.answerCallbackQuery({ text: "❌ 操作失败，请检查机器人权限。", show_alert: true }).catch(() => { });
          }
          return;
        }

        if (data.startsWith("ads_ban_join_")) {
          const targetUserId = Number(data.replace("ads_ban_join_", ""));
          const isAdmin = await checkIsAdmin(ctx, chatId, ctx.from.id);
          if (!isAdmin) {
            await ctx.answerCallbackQuery({ text: "🚫 只有管理员可以操作。", show_alert: true }).catch(() => { });
            return;
          }

          let targetName = String(targetUserId);
          try {
            const chat = await ctx.api.getChat(targetUserId);
            if (chat && "first_name" in chat) {
              targetName = chat.first_name + (chat.last_name ? ` ${chat.last_name}` : "");
            } else if (chat && "title" in chat) {
              targetName = chat.title;
            }
          } catch { }

          db.removeUnverifiedMember(chatId, targetUserId);
          try {
            await ctx.api.banChatMember(chatId, targetUserId);
            await ctx.answerCallbackQuery({ text: "🚫 已强制拒绝并封禁该用户。" }).catch(() => { });
            await ctx.editMessageText(`🚫 <b>人工拒绝通知</b>\n管理员已拒绝用户 <a href="tg://user?id=${targetUserId}">${esc(targetName)}</a> 的加入请求并将其封禁。`, { parse_mode: "HTML" }).catch(() => { });
          } catch (e) {
            await ctx.answerCallbackQuery({ text: "❌ 操作失败，请检查机器人权限。", show_alert: true }).catch(() => { });
          }
          return;
        }
        // 处理分页回调: ads_samples_list_(spam|safe|all)_PAGE
        if (data.startsWith("ads_samples_list_")) {
          const parts = data.split("_");
          const type = parts[3]; // spam, safe, all
          const page = parseInt(parts[4] || "0");
          const limit = 15;
          const offset = page * limit;

          let isSpam: boolean | undefined = undefined;
          let title = "📚 全部样本库";
          let icon = "📋";

          if (type === "spam") { isSpam = true; title = "🚫 广告样本库"; icon = "🚫"; }
          else if (type === "safe") { isSpam = false; title = "✅ 正常样本库"; icon = "✅"; }

          const samples = db.getSamples(chatId, limit + 1, isSpam, offset);
          const hasNext = samples.length > limit;
          const displaySamples = samples.slice(0, limit);

          const lines = displaySamples.map(s => `${s.id}. ${icon} ${esc(s.message_text.slice(0, 40))}`);
          const res = `<b>${title}</b> (第 ${page + 1} 页)\n\n${lines.join("\n") || "暂无样本"}`;

          await switchMenu(res, getSamplesPaginationKeyboard(type, page, hasNext));
          return;
        }

        if (data.startsWith("ads_invite_logs_")) {
          const parts = data.split("_");
          const targetChatId = Number(parts[3]);
          const page = parseInt(parts[4] || "0");
          if (!Number.isFinite(targetChatId) || targetChatId !== chatId) {
            await ctx.answerCallbackQuery({ text: "会话已失效，请重新打开菜单。", show_alert: true }).catch(() => { });
            return;
          }

          const pageData = await buildInviteVoucherLogsPage(ctx, chatId, isNaN(page) ? 0 : Math.max(0, page));
          if (!pageData) {
            await switchMenu("📭 暂无邀请码记录。", new InlineKeyboard().text("⬅️ 返回群组设置", "ads_invitation"));
            await ctx.answerCallbackQuery({ text: "暂无邀请码记录。", show_alert: true }).catch(() => { });
            return;
          }

          await switchMenu(pageData.text, pageData.keyboard);
          await ctx.answerCallbackQuery().catch(() => { });
          return;
        }
        break;
      }

      case "ads_games":
        await switchMenu(
          `⚔️ <b>互动趣游</b>\n\n• <code>/wd</code> — 开启“谁是卧底”游戏\n• <code>/ww</code> — 开启“狼人杀”游戏大厅\n• <code>/ww points</code> — 查看积分设置\n• <code>/ww points 20</code> — 胜利阵营每人 +20 积分\n• <code>/ww points limit 5</code> — 每人每天最多入账 5 次\n• <code>/ww points 0</code> — 关闭自动入账\n• <code>/rr</code> — 俄罗斯轮盘 (赌禁言)\n• <code>/dd</code> — 离线决斗 (未开积分=赌禁言，已开积分=赌 5 分，双方需≥100分)\n• <code>/21</code> / <code>/bj</code> — 21点小程序（房主坐庄，卡牌牌面）\n• <code>/nn</code> — 牛牛小程序（房主坐庄，牛1-7可赢，牛8起翻倍）`,
          getBackToMain()
        );
        break;

      case "ads_lottery":
        await switchMenu(
          `🎁 <b>内置抽奖功能</b>\n\n<b>用法:</b>\n<code>/cj &lt;奖品*数量&gt; [开奖条件] [f/j条件(可选)] [备注(可选)]</code>\n\n<b>示例:</b>\n<code>/cj 苹果手机*1</code> (手动开奖)\n<code>/cj 积分30*4 f30 2h</code> (4个中奖名额，每人自动入账30积分)\n<code>/cj 键盘*2 2h j50</code> (2小时后开奖 + 需50积分)\n<code>/cj 键盘*2 2h f10</code> (2小时后开奖 + 需10条发言)\n<code>/cj 键盘*2 2h f10 j10 记得领奖 </code>  (2小时后开奖 + 需10条发言 + 需50积分)\n<code>/cj 苹果*1,华为*2 100r</code> (满100人开奖 + 多奖品)`,
          getBackToMain()
        );
        break;

      case "ads_query":
        await switchMenu(
          `📊 <b>常用查询命令</b>\n\n<b>用法:</b>\n<code>/jl</code> — 查询目标用户最近 10 天发言数\n<i>必须回复目标用户的消息。</i>\n\n<b>其他命令:</b>\n<code>/jf</code> — 查询积分\n<code>/dh</code> — 积分兑换邀请券\n<code>/shop</code> — 打开积分商城\n<code>/yq</code> — 查看邀请券\n<code>/ty</code> / 回复“偷油” — 回复目标消息偷积分\n<code>/dc</code> — 查询DC数据中心\n<code>/id</code> — 查询用户信息\n<code>/kw help</code> — 关键字自动回复(管理员)`,
          getBackToMain()
        );
        break;
    }

    // 如果都没有匹配到，交给下家处理器（如正则匹配的 callbackQuery）
    return await next();
  });


  bot.command("jl", async (ctx) => {
    if (!ctx.chat || ctx.chat.type === "private") {
      await ctx.reply("⚠️ 此命令仅在群组中可用。");
      return;
    }

    const reply = ctx.message?.reply_to_message;
    if (!reply || !reply.from) {
      const promptMsg = await ctx.reply("💡 请 **回复某人的消息** 使用此命令，查询其最近 10 天的活跃情况。");
      try { await ctx.deleteMessage(); } catch (e) { }
      setTimeout(() => {
        ctx.api.deleteMessage(ctx.chat.id, promptMsg.message_id).catch(() => { });
      }, 10 * 1000);
      return;
    }

    const chatId = ctx.chat.id;
    const targetUserId = reply.from.id;
    const targetUserName = getUserName(reply.from);

    const count = db.getUserMessageCountLast10Days(chatId, targetUserId);
    const maxOther10 = db.getUserMaxMessageCountAcrossGroups(targetUserId, 10, chatId); // 排除当前群

    // 显式指定时区为北京时间 (Asia/Shanghai)，并包含日期与 24 小时制时间
    const now = new Date();
    const timeStr = now.toLocaleString("zh-CN", {
      timeZone: "Asia/Shanghai",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false
    }).replace(/\//g, "-");

    const response = [
      `📜 <b>活跃发言查询(最近 10 天)</b>`,
      ``,
      `👤 目标: <a href="tg://user?id=${targetUserId}">${esc(targetUserName)}</a> (<code>${targetUserId}</code>)`,
      `📊 本群最近发言: <code>${count}</code> 条`,
      maxOther10 > 0 ? `🌐 它群最高发言: <code>${maxOther10}</code> 条` : "",
      ``,
      `<i>(注: 已剔除指令、签到以及“偷油”快捷词)</i>`,
      `<code style="float: right">已更新 ${timeStr}</code>`,
    ].filter(line => line !== "").join("\n");

    const replyMsg = await ctx.reply(response, { parse_mode: "HTML" });

    // 立即删除用户的指令
    try { await ctx.deleteMessage(); } catch (e) { }

    // 30 秒后自动删除查询结果
    setTimeout(async () => {
      try {
        await ctx.api.deleteMessage(chatId, replyMsg.message_id);
      } catch (e) { }
    }, 30_000);
  });

  // ========== 私聊管理员命令 ==========
  bot.command("groups", async (ctx) => {
    if (ctx.chat?.type !== "private") return; // 仅在私聊中可用（自动忽略群组）

    const adminIdStr = process.env.ADMIN_USER_ID;
    if (!adminIdStr || ctx.from?.id !== Number(adminIdStr)) {
      await ctx.reply("⛔ 您没有权限执行此操作。");
      return;
    }

    const msg = await ctx.reply("⏳ 正在获取群组列表...");
    try {
      const gids = db.getAllEnabledGroups();
      if (gids.length === 0) {
        await ctx.api.editMessageText(ctx.chat.id, msg.message_id, "🤖 机器人目前没有在任何已开启反垃圾功能的群组中。");
        return;
      }

      const me = await bot.api.getMe();
      const lines: string[] = [];
      const staleGroupIds: number[] = [];
      for (const gid of gids) {
        try {
          const member = await bot.api.getChatMember(gid, me.id) as any;
          const status = member?.status;
          if (status === "left" || status === "kicked") {
            staleGroupIds.push(gid);
            continue;
          }

          let name = String(gid);
          let chatLink = "";
          try {
            const chat = await bot.api.getChat(gid);
            if (chat && "title" in chat && chat.title) {
              name = chat.title;
            }
            if (chat && "username" in chat && chat.username) {
              chatLink = `https://t.me/${chat.username}`;
            } else if (chat && "invite_link" in chat && chat.invite_link) {
              chatLink = chat.invite_link;
            }
          } catch {
            // 名称获取失败不影响展示
          }
          if (!chatLink) {
            const gidStr = String(gid);
            chatLink = gidStr.startsWith("-100")
              ? `https://t.me/c/${gidStr.slice(4)}/1`
              : `tg://resolve?id=${Math.abs(gid)}`;
          }
          const href = chatLink.replace(/&/g, "&amp;").replace(/"/g, "%22");
          lines.push(`▪️ <a href="${href}"><b>${esc(name)}</b></a> (<code>${gid}</code>)`);
        } catch (err) {
          if (isGroupUnavailableError(err)) {
            staleGroupIds.push(gid);
            continue;
          }
          // 临时错误时保留该群，避免误清理
          lines.push(`▪️ <b>未知群组</b> (<code>${gid}</code>)`);
        }
      }

      if (staleGroupIds.length > 0) {
        for (const gid of staleGroupIds) {
          db.closeAllGroupSwitches(gid);
          adminCache.delete(gid);
        }
      }

      const text = [
        `📋 <b>机器人所在的监控群组 (${lines.length} 个)</b>`,
        ``,
        ...(lines.length > 0 ? lines : ["（暂无有效群组）"]),
        ...(staleGroupIds.length > 0
          ? [
            ``,
            `🧹 已自动清理失效群组: <code>${staleGroupIds.length}</code> 个`
          ]
          : []),
      ].join("\n");

      await ctx.api.editMessageText(ctx.chat.id, msg.message_id, text, { parse_mode: "HTML" });
    } catch (err) {
      console.error("[AntiSpam] 获取群组列表失败:", err);
      await ctx.api.editMessageText(ctx.chat.id, msg.message_id, "❌ 获取群组列表失败。");
    }
  });

  bot.command("console", async (ctx) => {
    if (ctx.chat.type !== "private" || !ctx.from) {
      await replyTempNotice(ctx, `请先私聊机器人发送 <code>/console</code> 登录控制台，进行订阅！`, { parse_mode: "HTML" });
      return;
    }
    const user = db.upsertCommercialUser(ctx.from.id, ctx.from.username || "", getUserName(ctx.from));
    if (Number(user.frozen || 0) !== 0) {
      const reason = String(user.frozen_note || "").trim();
      await ctx.reply(`🚫 你的订阅账号当前已被冻结，请联系超级管理员处理。${reason ? `\n原因: <code>${esc(reason)}</code>` : ""}`, { parse_mode: "HTML" });
      return;
    }
    const { code, loginUrl } = createConsoleLoginCodeForUser(user.user_id);
    const quickLoginUrl = `${loginUrl}?code=${encodeURIComponent(code)}`;
    const sub = db.getCommercialActiveSubscription(user.user_id);
    const claimLimit = getCommercialClaimLimit(user.user_id);
    const claimCount = db.listCommercialChatsByOwner(user.user_id).length;
    const lines = [
      `💼 <b>订阅控制台登录</b>`,
      ``,
      `账号: <code>${user.user_id}</code>${user.username ? ` (@${esc(user.username)})` : ""}`,
      `余额: <code>${((user.balance_cents || 0) / 100).toFixed(2)}</code>`,
      claimLimit == null
        ? `认领上限: <code>无限</code>，当前已认领 <code>${claimCount}</code>`
        : `认领上限: <code>${claimLimit}</code>，当前已认领 <code>${claimCount}</code>`,
      `登录码: <code>${esc(code)}</code>`,
      `控制台: <code>${esc(loginUrl)}</code>`,
      sub
        ? `当前订阅: <b>${esc(sub.plan_code)}</b>，到期 <code>${esc(sub.ends_at)}</code>`
        : `当前订阅: <b>未生效</b>`,
      ``,
      `<i>登录码 15 分钟内有效，只能使用一次。</i>`,
      `<i>登录后可申请订阅、认领群/频道、配置自己的 AI 接口。</i>`,
    ];
    await ctx.reply(lines.join("\n"), {
      parse_mode: "HTML",
      link_preview_options: { is_disabled: true },
      reply_markup: new InlineKeyboard().url("订阅控制台", quickLoginUrl),
    });
  });

  bot.command("claim", async (ctx) => {
    if (!ctx.chat || ctx.chat.type === "private" || !ctx.from) {
      await ctx.reply("⚠️ 请在要认领的群组或频道里使用 /claim。", { parse_mode: "HTML" });
      return;
    }
    const chatId = ctx.chat.id;
    const userId = ctx.from.id;
    if (!isSuperAdminUserId(userId) && !(await checkIsAdmin(ctx, chatId, userId))) {
      await ctx.reply("🚫 只有该群组/频道的管理员可以认领。", { parse_mode: "HTML" });
      return;
    }
    if (!canEditCommercialSettings(userId)) {
      await replyTempNotice(ctx, `🚫 请先私聊机器人发送 <code>/console</code> 开通订阅后再绑定！`, { parse_mode: "HTML" });
      return;
    }
    db.upsertCommercialUser(userId, ctx.from.username || "", getUserName(ctx.from));
    const existingBinding = db.getCommercialChat(chatId);
    if (existingBinding && existingBinding.owner_user_id !== userId && !isSuperAdminUserId(userId)) {
      await ctx.reply(
        `🚫 当前${ctx.chat.type === "channel" ? "频道" : "群组"}已绑定到账号 <code>${existingBinding.owner_user_id}</code>。只有原绑定账号或 ADMIN_USER_ID 可以重新绑定。`,
        { parse_mode: "HTML" }
      );
      return;
    }
    const claimQuota = canClaimCommercialChat(userId, chatId);
    if (!claimQuota.ok) {
      await ctx.reply(
        `🚫 当前 Pro 套餐最多认领 <code>${claimQuota.limit}</code> 个群组/频道，你已认领 <code>${claimQuota.count}</code> 个。请先解绑不用的聊天后再继续认领。`,
        { parse_mode: "HTML" }
      );
      return;
    }
    const title = "title" in ctx.chat ? (ctx.chat.title || String(chatId)) : String(chatId);
    const username = "username" in ctx.chat ? (ctx.chat.username || "") : "";
    db.claimCommercialChat(chatId, userId, ctx.chat.type, title, username);
    const sub = db.getCommercialActiveSubscription(userId);
    await ctx.reply(
      sub
        ? `✅ 已将当前${ctx.chat.type === "channel" ? "频道" : "群组"}绑定到你的订阅账号。\n订阅到期: <code>${esc(sub.ends_at)}</code>`
        : `✅ 已将当前${ctx.chat.type === "channel" ? "频道" : "群组"}绑定到你的订阅账号。\n\n当前你还没有有效订阅。请先私聊机器人发送 <code>/console</code> 进行订阅！`,
      { parse_mode: "HTML" }
    );
  });

  bot.command("unbind", async (ctx) => {
    if (!ctx.chat || ctx.chat.type === "private" || !ctx.from) {
      await ctx.reply("⚠️ 请在要解绑的群组或频道里使用 /unbind。", { parse_mode: "HTML" });
      return;
    }
    const chatId = ctx.chat.id;
    const userId = ctx.from.id;
    if (!isSuperAdminUserId(userId) && !(await checkIsAdmin(ctx, chatId, userId))) {
      await ctx.reply("🚫 只有该群组/频道的管理员可以解绑。", { parse_mode: "HTML" });
      return;
    }
    const existingBinding = db.getCommercialChat(chatId);
    if (!existingBinding) {
      await ctx.reply("ℹ️ 当前群组/频道还没有绑定订阅账号。", { parse_mode: "HTML" });
      return;
    }
    if (existingBinding.owner_user_id !== userId && !isSuperAdminUserId(userId)) {
      await ctx.reply(
        `🚫 当前${ctx.chat.type === "channel" ? "频道" : "群组"}绑定到账号 <code>${existingBinding.owner_user_id}</code>。只有当前绑定账号或 ADMIN_USER_ID 可以解绑。`,
        { parse_mode: "HTML" }
      );
      return;
    }
    db.removeCommercialChat(chatId);
    await ctx.reply(`✅ 已解绑当前${ctx.chat.type === "channel" ? "频道" : "群组"}的订阅账号关联。`, { parse_mode: "HTML" });
  });

  bot.command("sub", async (ctx) => {
    if (!ctx.from || ctx.chat.type !== "private") {
      await ctx.reply("⚠️ /sub 仅支持私聊使用。", { parse_mode: "HTML" });
      return;
    }
    const text = ctx.message?.text || "";
    const parts = text.trim().split(/\s+/).slice(1);
    const action = (parts[0] || "status").toLowerCase();
    const isSuperAdmin = isSuperAdminUserId(ctx.from.id);

    if (action === "grant") {
      if (!isSuperAdmin) {
        await ctx.reply("🚫 仅 ADMIN_USER_ID 可发放订阅。", { parse_mode: "HTML" });
        return;
      }
      const targetUserId = Number(parts[1] || 0);
      const days = Number(parts[2] || 0);
      const planCode = String(parts[3] || "pro").trim() || "pro";
      if (!targetUserId || !days) {
        await ctx.reply("用法: <code>/sub grant 用户ID 天数 [planCode]</code>", { parse_mode: "HTML" });
        return;
      }
      const sub = db.grantCommercialSubscription(targetUserId, days, planCode, `bot_admin:${ctx.from.id}`);
      await ctx.reply(`✅ 已发放订阅\n用户: <code>${targetUserId}</code>\n套餐: <code>${esc(sub.plan_code)}</code>\n到期: <code>${esc(sub.ends_at)}</code>`, { parse_mode: "HTML" });
      return;
    }

    const targetUserId = isSuperAdmin && parts[1] ? Number(parts[1] || 0) : ctx.from.id;
    const user = db.getCommercialUser(targetUserId) || db.upsertCommercialUser(targetUserId, targetUserId === ctx.from.id ? (ctx.from.username || "") : "", targetUserId === ctx.from.id ? getUserName(ctx.from) : String(targetUserId));
    const sub = db.getCommercialActiveSubscription(targetUserId);
    const chats = db.listCommercialChatsByOwner(targetUserId);
    await ctx.reply(
      [
        `💼 <b>订阅状态</b>`,
        `账号: <code>${user.user_id}</code>${user.username ? ` (@${esc(user.username)})` : ""}`,
        `当前状态: ${sub ? "🟢 已生效" : "🔴 未生效"}`,
        sub ? `套餐: <code>${esc(sub.plan_code)}</code>` : `套餐: <code>none</code>`,
        sub ? `到期: <code>${esc(sub.ends_at)}</code>` : `到期: <code>-</code>`,
        `余额: <code>${((user.balance_cents || 0) / 100).toFixed(2)}</code>`,
        `已认领聊天: <code>${chats.length}</code>${getCommercialClaimLimit(targetUserId) == null ? " / 无上限" : ` / ${getCommercialClaimLimit(targetUserId)}`}`,
      ].join("\n"),
      { parse_mode: "HTML" }
    );
  });

  async function buildPointsMallHomePage(chatId: number, userId: number, userName: string, pageIndex: number = 0, scene: string = "all"): Promise<{
    text: string;
    keyboard: InlineKeyboard;
  } | null> {
    const PAGE_SIZE = 8;
    const safeScene = ["all", "purchase", "renew"].includes(scene) ? scene : "all";
    const allItems = db.listPointsMallItemsByChat(chatId, true);
    if (!allItems.length) return null;
    const points = db.getUserPoints(chatId, userId);
    const { chatName, chatLink } = await resolveChatDisplay(chatId);
    const safeChatLink = chatLink.replace(/&/g, "&amp;").replace(/"/g, "%22");
    const keyboard = new InlineKeyboard();

    if (safeScene === "all") {
      // 默认不显示商品列表，只显示场景选择按钮
      const purchaseCount = allItems.filter(i => i.promo_scene === "purchase").length;
      const renewCount = allItems.filter(i => i.promo_scene === "renew").length;
      keyboard.text("🛒 购买", `shop_scene_${chatId}_purchase`).text("🔄 续费", `shop_scene_${chatId}_renew`).row();
      keyboard.url("⬅️ 返回群组", chatLink);
      return {
        text: [
          `🛍️ <b>积分商城</b>`,
          "",
          `👤 账户: <b><a href="tg://user?id=${userId}">${esc(userName)}</a></b>`,
          `🏢 群组: <b><a href="${safeChatLink}">${esc(chatName)}</a></b>`,
          `💰 当前积分: <code>${points.total}</code>`,
          `📦 可购商品: <code>${purchaseCount}</code>`,
          `🏷️ 续费商品: <code>${renewCount}</code>`,
        ].join("\n"),
        keyboard,
      };
    }

    // 已选择具体场景，展示对应商品
    const items = allItems.filter(i => i.promo_scene === safeScene);
    const totalPages = Math.max(1, Math.ceil(items.length / PAGE_SIZE));
    const safePageIndex = Math.max(0, Math.min(totalPages - 1, Math.floor(pageIndex)));
    const pageItems = items.slice(safePageIndex * PAGE_SIZE, (safePageIndex + 1) * PAGE_SIZE);
    for (const item of pageItems) {
      keyboard.text(`${item.title} · ${item.points_cost}分`, `shop_view_${chatId}_${item.id}_${safePageIndex}_${safeScene}`).row();
    }
    if (totalPages > 1) {
      if (safePageIndex > 0) keyboard.text("⬅️ 上一页", `shop_page_${chatId}_${safePageIndex - 1}_${safeScene}`);
      if (safePageIndex < totalPages - 1) keyboard.text("下一页 ➡️", `shop_page_${chatId}_${safePageIndex + 1}_${safeScene}`);
      if ((safePageIndex > 0) || (safePageIndex < totalPages - 1)) keyboard.row();
    }
    keyboard.text("⬅️ 返回商城", `shop_scene_${chatId}_all`);
    const sceneLabel = safeScene === "purchase" ? "购买" : "续费";
    return {
      text: [
        `🛍️ <b>积分商城</b>`,
        "",
        `👤 账户: <b><a href="tg://user?id=${userId}">${esc(userName)}</a></b>`,
        `🏢 群组: <b><a href="${safeChatLink}">${esc(chatName)}</a></b>`,
        `💰 当前积分: <code>${points.total}</code>`,
        `📦 在售商品: <code>${items.length}</code> (${sceneLabel})`,
        totalPages > 1 ? `📄 当前页: <code>${safePageIndex + 1}/${totalPages}</code>` : "",
      ].join("\n"),
      keyboard,
    };
  }

  async function buildPointsMallItemPage(chatId: number, itemId: number, userId: number, userName: string, pageIndex: number = 0, scene: string = "all"): Promise<{
    text: string;
    keyboard: InlineKeyboard;
  }> {
    const safeScene = ["all", "purchase", "renew"].includes(scene) ? scene : "all";
    const item = db.getPointsMallItem(chatId, itemId);
    if (!item || !item.enabled) {
      throw new Error("该商品不存在或已下架");
    }
    const points = db.getUserPoints(chatId, userId);
    const canRedeem = db.canRedeemPointsMallItem(chatId, itemId, userId);
    const effectivePointsCost = canRedeem.effectivePointsCost || item.points_cost;
    const { chatName, chatLink } = await resolveChatDisplay(chatId);
    const safeChatLink = chatLink.replace(/&/g, "&amp;").replace(/"/g, "%22");
    const keyboard = new InlineKeyboard();
    if (canRedeem.ok && points.total >= effectivePointsCost) {
      keyboard.text("立即兑换", `shop_confirm_${chatId}_${itemId}_${Math.max(0, Math.floor(pageIndex))}_${safeScene}`).row();
    }
    keyboard.text("返回商城", `shop_back_${chatId}_${Math.max(0, Math.floor(pageIndex))}_${safeScene}`).row();

    const limitHints: string[] = [];
    if (item.promo_once_per_client) limitHints.push("每位用户限兑 1 次");
    if (item.redeem_cycle !== "none") {
      limitHints.push(`每${canRedeem.redeemCycleLabel}标准价 1 次`);
      if (item.repeat_markup_percent > 0) limitHints.push(`同周期再次兑换加价 ${item.repeat_markup_percent}%`);
    }
    if (item.stock_enabled) limitHints.push(`剩余库存 ${canRedeem.remainingStock ?? 0}`);
    if (item.promo_only_new_client) limitHints.push("仅限魔方新用户使用");
    if (item.promo_only_old_client) limitHints.push("仅限魔方老用户使用");
    if (item.promo_max_times > 0) limitHints.push(`优惠码最大使用次数 ${item.promo_max_times}`);
    const stockHint = item.stock_enabled ? `📦 剩余库存: ${esc(String(canRedeem.remainingStock ?? 0))}` : "";
    const detailLines = String(item.description || "")
      .split(/\r?\n/)
      .map((line) => line.trimEnd())
      .filter(Boolean);
    const detailHintLines = detailLines.map((line, index) => `${index === 0 ? "📌 " : ""}${esc(line)}`);
    const conditionHints = limitHints.filter((hint) => !hint.startsWith("剩余库存 "));
    const conditionLines = buildPointsMallConditionLines(conditionHints);
    const groupLine = `🏢 群组: <a href="${safeChatLink}">${esc(chatName)}</a>`;
    const accountLine = `👤 账户: <a href="tg://user?id=${userId}">${esc(userName)}</a>`;
    const purchaseAccountLine = accountLine;
    const commonDetailLines = [
      `💰 当前积分: ${esc(String(points.total))}`,
      `🪙 兑换所需: ${esc(String(effectivePointsCost))}`,
      `🧭 场景: ${esc(item.promo_scene === "renew" ? "续费" : "购买")}`,
      `🎁 优惠类型: ${esc(getPromoTypeLabel(item.promo_type))}`,
      item.promo_type === "free" ? "🎯 优惠值: 免安装/免费项" : `🎯 优惠值: ${esc(String(item.promo_value))}`,
    ];
    const renewLastRedeemedLine = canRedeem.lastRedeemedAt ? `🕒 上次兑换: ${esc(canRedeem.lastRedeemedAt)}` : null;

    return {
      text: joinMessageLines([
        `🧾 ${esc(item.title)}`,
        "",
        groupLine,
        item.promo_scene === "renew" ? accountLine : purchaseAccountLine,
        ...commonDetailLines,
        item.promo_scene === "renew" ? null : stockHint,
        item.promo_scene === "renew" ? null : (detailHintLines.length ? detailHintLines.join("\n") : null),
        ...conditionLines,
        item.promo_scene === "renew" ? renewLastRedeemedLine : null,
        "",
        canRedeem.ok
          ? (points.total >= effectivePointsCost ? "确认后会立即扣除积分！" : `当前积分不足，暂时无法兑换该商品，还差 ${esc(String(Math.max(0, effectivePointsCost - points.total)))} 积分。`)
          : `当前不可兑换：${esc(canRedeem.reason || "条件不满足")}`,
      ]),
      keyboard,
    };
  }

  bot.command("start", async (ctx) => {
    if (ctx.chat.type !== "private" || !ctx.from) return;
    const userId = ctx.from.id;
    const userName = getUserName(ctx.from);
    const payload = ctx.match || "";
    db.markTelegramPrivateContact(userId);

    if (payload.startsWith("shop_")) {
      const chatId = Number(payload.split("_")[1]);
      if (!Number.isFinite(chatId)) {
        await ctx.reply("❌ 参数无效，请返回群组重新点击兑换。\n");
        return;
      }
      const mallAvailability = getPointsMallAvailability(chatId);
      if (!mallAvailability.ok) {
        await ctx.reply(`🔴 ${mallAvailability.reason}。`);
        return;
      }
      const page = await buildPointsMallHomePage(chatId, userId, userName, 0, "all");
      if (!page) {
        const { chatName, chatLink } = await resolveChatDisplay(chatId);
        const safeChatLink = chatLink.replace(/&/g, "&amp;").replace(/"/g, "%22");
        await ctx.reply(
          `📭 群组 <b><a href="${safeChatLink}">${esc(chatName)}</a></b> 暂未上架任何积分商品。`,
          { parse_mode: "HTML", link_preview_options: { is_disabled: true } }
        );
        return;
      }
      await ctx.reply(page.text, {
        parse_mode: "HTML",
        reply_markup: page.keyboard,
        link_preview_options: { is_disabled: true }
      });
      return;
    }

    if (payload.startsWith("yq_")) {
      const chatId = Number(payload.split("_")[1]);
      if (!Number.isFinite(chatId)) {
        await ctx.reply("❌ 参数无效，请返回群组重新点击查看。");
        return;
      }
      if (!isPointsAvailableInChat(chatId)) {
        await ctx.reply("🔴 当前群组未开启积分系统，暂无邀请券明细可查。");
        return;
      }

      const vouchers = db.getUserVouchers(chatId, userId);
      if (vouchers.length === 0) {
        const { chatName, chatLink } = await resolveChatDisplay(chatId);
        const safeChatLink = chatLink.replace(/&/g, "&amp;").replace(/"/g, "%22");
        await ctx.reply(
          `📭 您在群组 <b><a href="${safeChatLink}">${esc(chatName)}</a></b> 还没有邀请券记录。`,
          { parse_mode: "HTML", link_preview_options: { is_disabled: true } }
        );
        return;
      }

      const pageData = await buildUserVoucherDetailPage(chatId, userId, userName, 0);
      if (!pageData) {
        await ctx.reply("📭 暂无邀请券记录。");
        return;
      }
      await ctx.reply(pageData.text, {
        parse_mode: "HTML",
        ...(pageData.keyboard ? { reply_markup: pageData.keyboard } : {}),
        link_preview_options: { is_disabled: true }
      });
      return;
    }

    if (payload.startsWith("dh_")) {
      const chatId = Number(payload.split("_")[1]);
      const botPerm = await getBotPermissionStatus(ctx, chatId);
      if (!botPerm.ok) {
        await ctx.reply(`❌ 当前群组机器人权限不足，暂不可兑换邀请码。\n原因：${botPerm.shortReason}`);
        return;
      }
      if (!isPointsAvailableInChat(chatId)) {
        await ctx.reply("🔴 当前群组未开启积分系统，暂不可兑换邀请券。");
        return;
      }
      const config = getEffectiveInvitationConfig(chatId);
      const points = db.getUserPoints(chatId, userId);

      let chatName = String(chatId);
      let chatLink = "";
      try {
        const chat = await ctx.api.getChat(chatId);
        if (chat && "title" in chat) chatName = chat.title || String(chatId);

        // 尝试获取跳转链接
        if (chat && "username" in chat && chat.username) {
          chatLink = `https://t.me/${chat.username}`;
        } else if (chat && "invite_link" in chat && chat.invite_link) {
          chatLink = chat.invite_link;
        } else {
          // 私有群组备选方案
          chatLink = chatId.toString().startsWith("-100")
            ? `https://t.me/c/${chatId.toString().slice(4)}/1`
            : `tg://resolve?id=${Math.abs(chatId)}`;
        }
      } catch { }

      const text = [
        `🎟️ <b>积分兑换邀请券</b>`,
        ``,
        `👤 账户: <b><a href="tg://user?id=${userId}">${esc(userName)}</a></b>`,
        `🏢 群组: <b><a href="${chatLink}">${esc(chatName)}</a></b>`,
        `💰 总积分: <code>${points.total}</code>`,
        `🎫 券价格: <code>${config.price}</code> 积分`,
        ``,
        points.total >= config.price
          ? `您可以点击下方按钮兑换一张验证码。`
          : `您的积分不足以兑换邀请券。`,
      ].join("\n");

      const keyboard = new InlineKeyboard();
      if (points.total >= config.price) {
        keyboard.text("💎 立即兑换", `dh_confirm_${chatId}`).row();
      }
      keyboard.text("⬅️ 返回", "start_main");

      await ctx.reply(text, {
        parse_mode: "HTML",
        reply_markup: keyboard,
        link_preview_options: { is_disabled: true }
      });
      return;
    }

    if (payload.startsWith("verify_")) {
      const chatId = Number(payload.split("_")[1]);
      const botPerm = await getBotPermissionStatus(ctx, chatId);
      if (!botPerm.ok) {
        await ctx.reply(`❌ 当前群组机器人权限不足，暂不可核销邀请码。\n原因：${botPerm.shortReason}`);
        return;
      }
      let chatName = String(chatId);
      let chatLink = "";
      try {
        const chat = await ctx.api.getChat(chatId);
        if (chat && "title" in chat) chatName = chat.title || String(chatId);
        if (chat && "username" in chat && chat.username) {
          chatLink = `https://t.me/${chat.username}`;
        } else if (chat && "invite_link" in chat && chat.invite_link) {
          chatLink = chat.invite_link;
        } else {
          chatLink = chatId.toString().startsWith("-100")
            ? `https://t.me/c/${chatId.toString().slice(4)}/1`
            : `tg://resolve?id=${Math.abs(chatId)}`;
        }
      } catch { }

      await ctx.reply(
        `🛡️ <b>新人准入核销</b>\n\n您正在尝试通过核销邀请码进入群组: <b><a href="${chatLink}">${esc(chatName)}</a></b>\n\n请直接在这里<b>发送你的邀请码</b>进行自动核销。`,
        { parse_mode: "HTML", link_preview_options: { is_disabled: true } }
      );
      return;
    }

    await ctx.reply(`🛡️ 您好 <b><a href="tg://user?id=${userId}">${esc(userName)}</a></b>！我是反垃圾管理助手。请在群组中使用相关指令：/ads。`, {
      parse_mode: "HTML",
      link_preview_options: { is_disabled: true }
    });
  });

  bot.callbackQuery(/^dh_confirm_-?\d+$/, async (ctx) => {
    const chatId = Number(ctx.callbackQuery.data.split("_")[2]);
    const userId = ctx.from.id;
    const config = getEffectiveInvitationConfig(chatId);
    const botPerm = await getBotPermissionStatus(ctx, chatId);

    if (!botPerm.ok) {
      await ctx.answerCallbackQuery({ text: `无法兑换：${botPerm.shortReason}`, show_alert: true }).catch(() => { });
      return;
    }

    if (!isPointsAvailableInChat(chatId)) {
      await ctx.answerCallbackQuery({ text: "当前群组未开启积分系统", show_alert: true }).catch(() => { });
      return;
    }

    const success = db.consumePoints(chatId, userId, config.price, "邀请兑换");
    if (!success) {
      await ctx.answerCallbackQuery({ text: "积分不足！", show_alert: true }).catch(() => { });
      return;
    }

    const code = generateInviteCode();
    db.createInviteVoucher(chatId, userId, code);
    const { chatName, chatLink } = await resolveChatDisplay(chatId);
    const safeChatLink = chatLink.replace(/&/g, "&amp;").replace(/"/g, "%22");

    const edited = await safeEditCallbackMessageText(
      ctx,
      `✅ 积分兑换成功\n\n` +
      ` 邀请码：【<code>${esc(code)}</code>】\n` +
      ` - 仅限【<a href="${safeChatLink}">${esc(chatName)}</a>】群组使用\n\n` +
      `• 请将此邀请码私下发给您的朋友。\n` +
      `• 入群后按群内机器人提示完成验证。\n` +
      `• 每个代码仅可使用一次。`,
      { parse_mode: "HTML", link_preview_options: { is_disabled: true } },
      "兑换面板已失效，请重新发送 /dh。"
    );
    if (!edited) return;
    await ctx.answerCallbackQuery().catch(() => { });
  });

  bot.callbackQuery(/^shop_scene_-?\d+_(all|purchase|renew)$/, async (ctx) => {
    const parts = ctx.callbackQuery.data.split("_");
    const chatId = Number(parts[2]);
    const scene = parts[3] || "all";
    const mallAvailability = getPointsMallAvailability(chatId);
    if (!mallAvailability.ok) {
      await ctx.answerCallbackQuery({ text: mallAvailability.reason, show_alert: true }).catch(() => { });
      return;
    }
    const page = await buildPointsMallHomePage(chatId, ctx.from.id, getUserName(ctx.from), 0, scene);
    if (!page) {
      await ctx.answerCallbackQuery({ text: "当前筛选条件下没有可兑换商品", show_alert: true }).catch(() => { });
      return;
    }
    const edited = await safeEditCallbackMessageText(
      ctx,
      page.text,
      { parse_mode: "HTML", reply_markup: page.keyboard, link_preview_options: { is_disabled: true } },
      "商城页面已失效，请重新发送 /shop。"
    );
    if (!edited) return;
    await ctx.answerCallbackQuery().catch(() => { });
  });

  bot.callbackQuery(/^shop_back_-?\d+(?:_\d+)?(?:_(all|purchase|renew))?$/, async (ctx) => {
    const parts = ctx.callbackQuery.data.split("_");
    const chatId = Number(parts[2]);
    const pageIndex = Number(parts[3] || 0);
    const scene = ["all", "purchase", "renew"].includes(parts[4]) ? parts[4] : "all";
    const mallAvailability = getPointsMallAvailability(chatId);
    if (!mallAvailability.ok) {
      await ctx.answerCallbackQuery({ text: mallAvailability.reason, show_alert: true }).catch(() => { });
      return;
    }
    const page = await buildPointsMallHomePage(chatId, ctx.from.id, getUserName(ctx.from), pageIndex, scene);
    if (!page) {
      await ctx.answerCallbackQuery({ text: "当前没有可兑换商品", show_alert: true }).catch(() => { });
      return;
    }
    const edited = await safeEditCallbackMessageText(
      ctx,
      page.text,
      { parse_mode: "HTML", reply_markup: page.keyboard, link_preview_options: { is_disabled: true } },
      "商城页面已失效，请重新发送 /shop。"
    );
    if (!edited) return;
    await ctx.answerCallbackQuery().catch(() => { });
  });

  bot.callbackQuery(/^shop_page_-?\d+_\d+(?:_(all|purchase|renew))?$/, async (ctx) => {
    const parts = ctx.callbackQuery.data.split("_");
    const chatId = Number(parts[2]);
    const pageIndex = Number(parts[3] || 0);
    const scene = ["all", "purchase", "renew"].includes(parts[4]) ? parts[4] : "all";
    const mallAvailability = getPointsMallAvailability(chatId);
    if (!mallAvailability.ok) {
      await ctx.answerCallbackQuery({ text: mallAvailability.reason, show_alert: true }).catch(() => { });
      return;
    }
    const page = await buildPointsMallHomePage(chatId, ctx.from.id, getUserName(ctx.from), pageIndex, scene);
    if (!page) {
      await ctx.answerCallbackQuery({ text: "当前没有可兑换商品", show_alert: true }).catch(() => { });
      return;
    }
    const edited = await safeEditCallbackMessageText(
      ctx,
      page.text,
      { parse_mode: "HTML", reply_markup: page.keyboard, link_preview_options: { is_disabled: true } },
      "商城页面已失效，请重新发送 /shop。"
    );
    if (!edited) return;
    await ctx.answerCallbackQuery().catch(() => { });
  });

  bot.callbackQuery(/^shop_view_-?\d+_\d+(?:_\d+)?(?:_(all|purchase|renew))?$/, async (ctx) => {
    const parts = ctx.callbackQuery.data.split("_");
    const chatId = Number(parts[2]);
    const itemId = Number(parts[3]);
    const pageIndex = Number(parts[4] || 0);
    const scene = ["all", "purchase", "renew"].includes(parts[5]) ? parts[5] : "all";
    if (!chatId || !itemId) {
      await ctx.answerCallbackQuery({ text: "商品参数无效", show_alert: true }).catch(() => { });
      return;
    }
    const mallAvailability = getPointsMallAvailability(chatId);
    if (!mallAvailability.ok) {
      await ctx.answerCallbackQuery({ text: mallAvailability.reason, show_alert: true }).catch(() => { });
      return;
    }
    try {
      const page = await buildPointsMallItemPage(chatId, itemId, ctx.from.id, getUserName(ctx.from), pageIndex, scene);
      const edited = await safeEditCallbackMessageText(
        ctx,
        page.text,
        { parse_mode: "HTML", reply_markup: page.keyboard, link_preview_options: { is_disabled: true } },
        "商品页面已失效，请重新发送 /shop。"
      );
      if (!edited) return;
      await ctx.answerCallbackQuery().catch(() => { });
    } catch (error: any) {
      await ctx.answerCallbackQuery({ text: String(error?.message || error || "打开商品失败"), show_alert: true }).catch(() => { });
    }
  });

  bot.callbackQuery(/^shop_confirm_-?\d+_\d+(?:_\d+)?(?:_(all|purchase|renew))?$/, async (ctx) => {
    const parts = ctx.callbackQuery.data.split("_");
    const chatId = Number(parts[2]);
    const itemId = Number(parts[3]);
    const pageIndex = Number(parts[4] || 0);
    const scene = ["all", "purchase", "renew"].includes(parts[5]) ? parts[5] : "all";
    const userId = ctx.from.id;
    const userName = getUserName(ctx.from);
    if (!chatId || !itemId) {
      await ctx.answerCallbackQuery({ text: "商品参数无效", show_alert: true }).catch(() => { });
      return;
    }
    const mallAvailability = getPointsMallAvailability(chatId);
    if (!mallAvailability.ok) {
      await ctx.answerCallbackQuery({ text: mallAvailability.reason, show_alert: true }).catch(() => { });
      return;
    }

    const canRedeem = db.canRedeemPointsMallItem(chatId, itemId, userId);
    if (!canRedeem.ok || !canRedeem.item) {
      const timing = [
        canRedeem.lastRedeemedAt ? `上次兑换：${canRedeem.lastRedeemedAt}` : "",
        canRedeem.nextRedeemAt ? `下次恢复：${canRedeem.nextRedeemAt}` : "",
      ].filter(Boolean).join("\n");
      await ctx.answerCallbackQuery({ text: `${canRedeem.reason || "当前不可兑换"}${timing ? `\n${timing}` : ""}`, show_alert: true }).catch(() => { });
      return;
    }
    const item = canRedeem.item;
    const effectivePointsCost = canRedeem.effectivePointsCost || item.points_cost;
    const myPoints = db.getUserPoints(chatId, userId).total;
    if (myPoints < effectivePointsCost) {
      await ctx.answerCallbackQuery({ text: "积分不足", show_alert: true }).catch(() => { });
      return;
    }
    const botPerm = await getBotPermissionStatus(ctx, chatId);
    if (!botPerm.ok) {
      await ctx.answerCallbackQuery({ text: `无法兑换：${botPerm.shortReason}`, show_alert: true }).catch(() => { });
      return;
    }

    const consumed = db.consumePoints(chatId, userId, effectivePointsCost, `积分商城兑换:${item.title}`);
    if (!consumed) {
      await ctx.answerCallbackQuery({ text: "积分不足或状态已变化，请重试", show_alert: true }).catch(() => { });
      return;
    }

    const reservedStock = db.reservePointsMallItemStock(chatId, itemId);
    if (!reservedStock.ok) {
      db.importUserPoints(chatId, userId, effectivePointsCost, "add", `积分商城库存不足回退:${item.title}`);
      await ctx.answerCallbackQuery({ text: reservedStock.reason || "商品库存不足", show_alert: true }).catch(() => { });
      return;
    }

    try {
      const result = await createZjmfPromoFromPointsMall({
        chatId,
        userId,
        username: ctx.from.username || "",
        displayName: userName,
        item,
        pointsCost: effectivePointsCost,
        integration: {
          provider: db.getPointsMallConfig(chatId).provider,
          apiUrl: db.getPointsMallConfig(chatId).custom_api_url,
          apiToken: db.getPointsMallConfig(chatId).custom_api_token,
        },
      });
      db.createPointsMallOrder({
        chatId,
        itemId: item.id,
        itemTitle: item.title,
        userId,
        username: ctx.from.username || "",
        displayName: userName,
        pointsCost: effectivePointsCost,
        zjmfExchangeNo: result.exchangeNo,
        zjmfPromoId: result.promoId,
        zjmfPromoCode: result.promoCode,
        status: result.redeemStatus,
        resultJson: JSON.stringify(result),
      });
      if (reservedStock.shouldAutoDisable && db.autoDisablePointsMallItemWhenOutOfStock(chatId, itemId)) {
        await notifyPointsMallShelfChange(bot, chatId, { ...item, enabled: 0 }, "down", "商品库存已耗尽，系统已自动下架", {
          remainingStock: reservedStock.remainingStock,
        });
      }
      const { chatName, chatLink } = await resolveChatDisplay(chatId);
      const edited = await safeEditCallbackMessageText(
        ctx,
        joinMessageLines([
          `✅ 兑换成功`,
          "",
          `🛍️ 商品: ${esc(item.title)}`,
          chatLink ? `🏢 群组: <a href="${chatLink.replace(/&/g, "&amp;").replace(/"/g, "%22")}">${esc(chatName)}</a>` : `🏢 群组: ${esc(chatName)}`,
          `💳 已扣积分: ${effectivePointsCost}`,
          canRedeem.lastRedeemedAt ? `🕒 上次兑换: ${esc(formatDateOnly(canRedeem.lastRedeemedAt))}` : "",
          item.promo_validity_mode !== "default" && result.promoExpirationTime
            ? `⏰ 失效日期: ${esc(formatDateOnly(result.promoExpirationTime))}`
            : "",
          result.exchangeNo ? `🔗 兑换流水: ${esc(result.exchangeNo)}` : "",
          `🎟️ 魔方优惠码: ${esc(result.promoCode)}`,
          "",
          `可直接前往官网 下单/使用。`,
        ]),
        { parse_mode: "HTML", link_preview_options: { is_disabled: true } },
        "兑换面板已失效，请重新发送 /shop。"
      );
      if (!edited) return;
      await ctx.answerCallbackQuery({ text: "兑换成功" }).catch(() => { });
    } catch (error: any) {
      if (reservedStock.reserved) {
        db.restorePointsMallItemStock(chatId, itemId);
      }
      db.importUserPoints(chatId, userId, effectivePointsCost, "add", `积分商城兑换失败回退:${item.title}`);
      await ctx.answerCallbackQuery({ text: String(error?.message || error || "兑换失败，积分已退回"), show_alert: true }).catch(() => { });
    }
  });

  bot.callbackQuery(/^yq_page_-?\d+_\d+$/, async (ctx) => {
    if (ctx.chat?.type !== "private") {
      await ctx.answerCallbackQuery({ text: "请在私聊中查看邀请券明细。", show_alert: true }).catch(() => { });
      return;
    }

    const parts = ctx.callbackQuery.data.split("_");
    const chatId = Number(parts[2]);
    const page = Number(parts[3]);
    if (!Number.isFinite(chatId) || !Number.isFinite(page)) {
      await ctx.answerCallbackQuery({ text: "分页参数无效。", show_alert: true }).catch(() => { });
      return;
    }

    if (!isPointsAvailableInChat(chatId)) {
      await ctx.answerCallbackQuery({ text: "当前群组未开启积分系统。", show_alert: true }).catch(() => { });
      return;
    }

    const userId = ctx.from.id;
    const userName = getUserName(ctx.from);
    const pageData = await buildUserVoucherDetailPage(chatId, userId, userName, page);
    if (!pageData) {
      await ctx.answerCallbackQuery({ text: "暂无邀请券记录。", show_alert: true }).catch(() => { });
      return;
    }

    const edited = await safeEditCallbackMessageText(
      ctx,
      pageData.text,
      {
        parse_mode: "HTML",
        ...(pageData.keyboard ? { reply_markup: pageData.keyboard } : {}),
        link_preview_options: { is_disabled: true }
      },
      "邀请券列表已失效，请重新发送 /yq。"
    );
    if (!edited) return;
    await ctx.answerCallbackQuery().catch(() => { });
  });

  bot.callbackQuery(/^aiassist_page_[a-z0-9]+_\d+$/i, async (ctx) => {
    const m = ctx.callbackQuery.data.match(/^aiassist_page_([a-z0-9]+)_(\d+)$/i);
    const token = m?.[1] || "";
    const page = Number(m?.[2] || 0);
    const payload = assistantPagedResults.get(token);

    if (!payload) {
      await ctx.answerCallbackQuery({ text: "这个结果分页已失效。", show_alert: true }).catch(() => { });
      return;
    }
    if (payload.userId && payload.userId !== ctx.from.id) {
      await ctx.answerCallbackQuery({ text: "只能由发起查询的人翻页。", show_alert: true }).catch(() => { });
      return;
    }
    if (Date.now() - payload.createdAt > ASSISTANT_CONFIRM_TTL_MS) {
      assistantPagedResults.delete(token);
      await ctx.answerCallbackQuery({ text: "结果分页已超时，请重新查询。", show_alert: true }).catch(() => { });
      return;
    }

    const pageData = buildAssistantPagedMessage(payload, page);
    const keyboard = buildAssistantPagedKeyboard(token, pageData.safePage, pageData.totalPages);
    const edited = await safeEditCallbackMessageText(
      ctx,
      pageData.text,
      {
        parse_mode: "HTML",
        ...(keyboard ? { reply_markup: keyboard } : {}),
        link_preview_options: { is_disabled: true },
      },
      "这个结果分页已失效。"
    );
    if (!edited) return;
    await ctx.answerCallbackQuery().catch(() => { });
  });

  bot.callbackQuery(/^aiassist_(confirm|cancel)_[a-z0-9]+$/i, async (ctx) => {
    const m = ctx.callbackQuery.data.match(/^aiassist_(confirm|cancel)_([a-z0-9]+)$/i);
    const action = (m?.[1] || "").toLowerCase();
    const token = m?.[2] || "";
    const pending = pendingAssistantActions.get(token);

    if (!pending) {
      await ctx.answerCallbackQuery({ text: "这个确认面板已失效。", show_alert: true }).catch(() => { });
      return;
    }
    if (pending.userId !== ctx.from.id) {
      await ctx.answerCallbackQuery({ text: "只能由发起这次请求的管理员确认。", show_alert: true }).catch(() => { });
      return;
    }
    if (Date.now() - pending.createdAt > ASSISTANT_CONFIRM_TTL_MS) {
      pendingAssistantActions.delete(token);
      await ctx.answerCallbackQuery({ text: "确认已超时，请重新发起。", show_alert: true }).catch(() => { });
      return;
    }

    if (action === "cancel") {
      pendingAssistantActions.delete(token);
      db.addAssistantAuditLog(pending.chatId, pending.userId, pending.requestText, JSON.stringify(pending.plan), "cancelled", pending.summary);
      const edited = await safeEditCallbackMessageText(
        ctx,
        `🧠 <b>管理助理</b>\n\n已取消：${esc(pending.summary)}`,
        { parse_mode: "HTML" },
        "确认面板已失效。"
      );
      if (!edited) return;
      await ctx.answerCallbackQuery({ text: "已取消" }).catch(() => { });
      return;
    }

    pendingAssistantActions.delete(token);
    try {
      const result = await executeAssistantPlan(ctx, pending.chatId, pending.userId, pending.plan);
      db.addAssistantAuditLog(pending.chatId, pending.userId, pending.requestText, JSON.stringify(pending.plan), "confirmed_execute", assistantExecutionResultToAuditText(result));
      const edited = await safeEditCallbackMessageText(
        ctx,
        `🧠 <b>管理助理</b>\n\n已确认执行：${esc(pending.summary)}`,
        { parse_mode: "HTML" },
        "确认面板已失效。"
      );
      if (!edited) return;
      await sendAssistantExecutionResult(ctx, pending.chatId, result, ctx.callbackQuery.message?.message_id);
      await ctx.answerCallbackQuery({ text: "已执行" }).catch(() => { });
    } catch (error) {
      const reason = String((error as any)?.message || error || "执行失败");
      db.addAssistantAuditLog(pending.chatId, pending.userId, pending.requestText, JSON.stringify(pending.plan), "confirm_execute_failed", reason);
      await ctx.answerCallbackQuery({ text: "执行失败", show_alert: true }).catch(() => { });
      await ctx.api.sendMessage(pending.chatId, `❌ 管理助理执行失败：${esc(reason)}`, {
        parse_mode: "HTML",
        ...(ctx.callbackQuery.message ? { reply_parameters: { message_id: ctx.callbackQuery.message.message_id } } : {}),
      }).catch(() => { });
    }
  });

  // 积分流水查询回调
  bot.callbackQuery(/^ads_jf_logs_-?\d+_\d+$/, async (ctx) => {
    const parts = ctx.callbackQuery.data.split("_");
    const chatId = Number(parts[3]);
    const page = Number(parts[4]);
    const userId = ctx.from.id;

    if (!isPointsAvailableInChat(chatId)) {
      await ctx.answerCallbackQuery({ text: "当前群组未开启积分系统", show_alert: true }).catch(() => { });
      return;
    }

    const pageData = await buildPointsLedgerPage(ctx, chatId, userId, isNaN(page) ? 0 : Math.max(0, page));
    if (!pageData) {
      await ctx.answerCallbackQuery({ text: "最近20天暂无积分流水记录。", show_alert: true }).catch(() => { });
      return;
    }

    const edited = await safeEditCallbackMessageText(
      ctx,
      pageData.text,
      { parse_mode: "HTML", reply_markup: pageData.keyboard },
      "积分面板已失效，请重新发送 /jf。"
    );
    if (!edited) return;
    await ctx.answerCallbackQuery().catch(() => { });
  });

  bot.callbackQuery(/^ads_jf_rank_-?\d+_\d+$/, async (ctx) => {
    const parts = ctx.callbackQuery.data.split("_");
    const chatId = Number(parts[3]);
    const page = Number(parts[4]);

    if (!isPointsAvailableInChat(chatId)) {
      await ctx.answerCallbackQuery({ text: "当前群组未开启积分系统", show_alert: true }).catch(() => { });
      return;
    }

    const pageData = await buildPointsRankPage(ctx, chatId, isNaN(page) ? 0 : Math.max(0, page));
    if (!pageData) {
      await ctx.answerCallbackQuery({ text: "暂无积分数据。", show_alert: true }).catch(() => { });
      return;
    }

    const edited = await safeEditCallbackMessageText(
      ctx,
      pageData.text,
      {
        parse_mode: "HTML",
        reply_markup: pageData.keyboard,
        link_preview_options: { is_disabled: true },
      },
      "积分面板已失效，请重新发送 /jf。"
    );
    if (!edited) return;
    await ctx.answerCallbackQuery().catch(() => { });
  });

  bot.callbackQuery(/^ads_jf_back_-?\d+$/, async (ctx) => {
    const chatId = Number(ctx.callbackQuery.data.split("_")[3]);
    if (!isPointsAvailableInChat(chatId)) {
      await ctx.answerCallbackQuery({ text: "当前群组未开启积分系统", show_alert: true }).catch(() => { });
      return;
    }
    const userId = ctx.from.id;
    const points = db.getUserPoints(chatId, userId);
    const userName = getUserName(ctx.from);

    const keyboard = new InlineKeyboard()
      .text("📊 积分流水", `ads_jf_logs_${chatId}_0`)
      .text("🏆 积分排行", `ads_jf_rank_${chatId}_0`).row();

    const edited = await safeEditCallbackMessageText(
      ctx,
      `💰 <b><a href="tg://user?id=${userId}">${esc(userName)}</a> 的积分账户</b>\n\n` +
      `• 当前总积分: <code>${points.total}</code>\n` +
      `• 今日已获取: <code>${points.today}</code> / 10\n\n` +
      `<i>通过在群内活跃聊天可以赚取积分（每天上限 10 分）。\n积分可用于兑换进群邀请券。</i>`,
      { parse_mode: "HTML", reply_markup: keyboard },
      "积分面板已失效，请重新发送 /jf。"
    );
    if (!edited) return;
    await ctx.answerCallbackQuery().catch(() => { });
  });

  // ========== 新人入群关注验证：用户自助复检 ==========
  bot.callbackQuery(/^ads_recheck_join_-?\d+$/, async (ctx) => {
    const chatId = ctx.chat?.id;
    if (!chatId) return;

    const targetUserId = Number(ctx.callbackQuery.data.replace("ads_recheck_join_", ""));
    const isAdminUser = await checkIsAdmin(ctx, chatId, ctx.from.id);
    if (ctx.from.id !== targetUserId && !isAdminUser) {
      await ctx.answerCallbackQuery({ text: "仅目标用户或管理员可操作。", show_alert: true }).catch(() => { });
      return;
    }

    if (!db.isUnverifiedMember(chatId, targetUserId)) {
      await ctx.answerCallbackQuery({ text: "该验证已结束。", show_alert: true }).catch(() => { });
      return;
    }

    const inviteConfig = getEffectiveInvitationConfig(chatId);
    const requiredChannel = (inviteConfig.requiredChannel || "").trim();
    if (!requiredChannel) {
      await ctx.answerCallbackQuery({ text: "当前未设置必关频道。", show_alert: true }).catch(() => { });
      return;
    }

    let checkOk = false;
    let isSubscribed = false;
    try {
      const channelMember = await ctx.api.getChatMember(requiredChannel, targetUserId);
      checkOk = true;
      isSubscribed = ["member", "administrator", "creator"].includes(channelMember.status);
    } catch (err: any) {
      if (isNotSubscribedError(err)) {
        checkOk = true;
        isSubscribed = false;
      } else if (isMembershipCheckUnavailableError(err)) {
        console.warn(`[AntiSpam] 关注复检不可用: ${getApiErrorDesc(err)}`);
      } else {
        console.error(`[AntiSpam] 关注复检失败: ${getApiErrorDesc(err)}`);
      }
    }

    if (!checkOk) {
      await ctx.answerCallbackQuery({ text: "暂时无法自动校验，请联系管理员手动放行。", show_alert: true }).catch(() => { });
      return;
    }

    if (!isSubscribed) {
      await ctx.answerCallbackQuery({ text: "尚未检测到已关注，请先关注频道后再试。", show_alert: true }).catch(() => { });
      return;
    }

    const info = db.removeUnverifiedMember(chatId, targetUserId);
    try {
      db.markChannelGuardMember(chatId, targetUserId);
      await ctx.api.restrictChatMember(chatId, targetUserId, {
        can_send_messages: true,
        can_send_audios: true,
        can_send_documents: true,
        can_send_photos: true,
        can_send_videos: true,
        can_send_video_notes: true,
        can_send_voice_notes: true,
        can_send_polls: true,
        can_send_other_messages: true,
        can_add_web_page_previews: true,
      });
      if (info?.welcomeMsgId) {
        await ctx.api.deleteMessage(chatId, info.welcomeMsgId).catch(() => { });
      }
      const passedUserLink = await renderUserLink(ctx, chatId, targetUserId);
      await ctx.answerCallbackQuery({ text: "✅ 已通过关注验证并放行。" }).catch(() => { });
      const autoPassNotice = await ctx.api.sendMessage(
        chatId,
        `✅ <b>放行通知</b>\n用户 ${passedUserLink} 已通过关注验证并自动放行。`,
        { parse_mode: "HTML" }
      ).catch(() => { });
      if (autoPassNotice) {
        scheduleAutoDeleteMessage(ctx, chatId, autoPassNotice.message_id, PASS_NOTICE_AUTO_DELETE_MS);
      }
      const profile = db.getChatUserProfile(chatId, targetUserId);
      await sendCommercialChatWelcomeIfEnabled(ctx, chatId, {
        id: targetUserId,
        username: profile?.username || "",
        displayName: profile?.display_name || "",
      }).catch((error) => {
        console.error("[CommercialWelcome] 发送欢迎语失败:", error);
      });
    } catch (e) {
      console.error("[AntiSpam] 关注复检后放行失败:", e);
      await ctx.answerCallbackQuery({ text: "放行失败，请联系管理员处理。", show_alert: true }).catch(() => { });
    }
  });

  // ========== 新人入群一键放通/封禁回调 ==========
  bot.callbackQuery(/^ads_(pass|ban)_join_-?\d+$/, async (ctx) => {
    const data = ctx.callbackQuery.data;
    const parts = data.split("_");
    const action = parts[1]; // pass or ban
    const targetUserId = Number(parts[3]);
    const chatId = ctx.chat?.id;

    if (!chatId) return;

    // 1. 严格校验管理员权限
    if (!(await checkIsAdmin(ctx, chatId, ctx.from.id))) {
      await ctx.answerCallbackQuery({ text: "⚠️ 只有管理员能执行此操作哦！", show_alert: true }).catch(() => { });
      return;
    }

    // 2. 执行逻辑
    if (action === "pass") {
      const unverified = db.removeUnverifiedMember(chatId, targetUserId);
      if (unverified) {
        const inviteConfig = getEffectiveInvitationConfig(chatId);
        if ((inviteConfig.requiredChannel || "").trim()) {
          db.markChannelGuardMember(chatId, targetUserId);
        }
        try { await ctx.api.deleteMessage(chatId, unverified.welcomeMsgId); } catch { }
        const passNotice = await ctx.reply(`✅ 管理员放行：用户 <code>${targetUserId}</code> 已通过准入验证。`, { parse_mode: "HTML" });
        scheduleAutoDeleteMessage(ctx, chatId, passNotice.message_id, PASS_NOTICE_AUTO_DELETE_MS);
        const profile = db.getChatUserProfile(chatId, targetUserId);
        await sendCommercialChatWelcomeIfEnabled(ctx, chatId, {
          id: targetUserId,
          username: profile?.username || "",
          displayName: profile?.display_name || "",
        }).catch((error) => {
          console.error("[CommercialWelcome] 发送欢迎语失败:", error);
        });
      } else {
        await ctx.answerCallbackQuery({ text: "该用户已不在验证队列中。" }).catch(() => { });
      }
    } else if (action === "ban") {
      db.removeUnverifiedMember(chatId, targetUserId); // 先从队列移除
      try {
        await ctx.api.banChatMember(chatId, targetUserId);
        const userName = "被拦截用户"; // 无法直接拿到被封禁人的名字，标记占位
        db.addLog(chatId, targetUserId, userName, "[准入环节被管理员手动封禁]", 1, "管理员手动封禁");

        await ctx.answerCallbackQuery({ text: "已强制封禁该用户" }).catch(() => { });
        try { await ctx.deleteMessage(); } catch { }
        await ctx.reply(`🚫 管理员拒绝并封禁了用户 <code>${targetUserId}</code>。`, { parse_mode: "HTML" });
      } catch (e) {
        await ctx.answerCallbackQuery({ text: "封禁失败，请检查机器人权限" }).catch(() => { });
      }
    }
  });

  const handleOilSteal = async (ctx: Context, options?: { deleteTriggerMessage?: boolean }) => {
    if (!ctx.chat || ctx.chat.type === "private" || !ctx.from) {
      await ctx.reply("💡 请在群组中回复目标用户的消息后使用 <code>/ty</code> 或直接发送“偷油”。", { parse_mode: "HTML" });
      return;
    }

    const chatId = ctx.chat.id;
    const thiefId = ctx.from.id;
    const shouldDeleteTrigger = options?.deleteTriggerMessage ?? false;
    const reply = ctx.message?.reply_to_message;
    const targetUser = reply?.from;

    if (shouldDeleteTrigger) {
      try { await ctx.deleteMessage(); } catch { }
    }

    if (!isPointsAvailableInChat(chatId)) {
      const msg = await ctx.reply("🔴 当前群组未开启积分系统，暂时无法偷油。");
      setTimeout(() => ctx.api.deleteMessage(chatId, msg.message_id).catch(() => { }), 20_000);
      return;
    }

    if (!targetUser) {
      const msg = await ctx.reply("⚠️ 请先回复目标用户的消息，再发送 <code>/ty</code> 或“偷油”。", { parse_mode: "HTML" });
      setTimeout(() => ctx.api.deleteMessage(chatId, msg.message_id).catch(() => { }), 20_000);
      return;
    }

    if (targetUser.is_bot) {
      const msg = await ctx.reply("🤖 机器人身上没有油，换个人偷吧。");
      setTimeout(() => ctx.api.deleteMessage(chatId, msg.message_id).catch(() => { }), 20_000);
      return;
    }

    if (targetUser.id === thiefId) {
      const msg = await ctx.reply("🪞 你不能偷自己，这叫左右手互倒。", { parse_mode: "HTML" });
      setTimeout(() => ctx.api.deleteMessage(chatId, msg.message_id).catch(() => { }), 20_000);
      return;
    }

    const thiefLink = await renderUserLink(ctx, chatId, thiefId);
    const targetLink = await renderUserLink(ctx, chatId, targetUser.id);
    const result = db.performOilSteal(chatId, thiefId, targetUser.id);

    let text = "";
    if (result.kind === "daily_limited") {
      text = [
        `⏳ ${thiefLink} 今天已经在本群偷过一次油了。`,
        `明天再来吧。`,
      ].join("\n");
    } else if (result.kind === "thief_points_too_low") {
      text = [
        `⛽ ${thiefLink} 当前积分不足 <code>100</code>，暂时不能偷油。`,
        `• 你的当前积分: <code>${result.thiefPoints}</code>`,
      ].join("\n");
    } else if (result.kind === "target_points_too_low") {
      text = [
        `🛡️ ${targetLink} 当前积分不足 <code>100</code>，不能作为偷油目标。`,
        `• 对方当前积分: <code>${result.targetPoints}</code>`,
      ].join("\n");
    } else if (result.kind === "target_protected") {
      text = [
        `🛡️ ${targetLink} 今天已经被偷满 <code>8</code> 次，已进入保护状态。`,
        `今天先放过他吧。`,
      ].join("\n");
    } else if (result.kind === "failed") {
      text = [
        `😮‍💨 ${thiefLink} 悄悄摸向了 ${targetLink} 的油桶，结果空手而归。`,
        `• 今日该用户已被偷: <code>${result.targetAttemptsToday}</code> / 8`,
      ].join("\n");
    } else if (result.kind === "success") {
      text = result.actualPoints > 0
        ? [
          `🛢️ <b>偷油成功</b>`,
          `${thiefLink} 从 ${targetLink} 身上顺走了 <code>${result.actualPoints}</code> 分。`,
          `• 你的当前积分: <code>${result.thiefPointsAfter}</code>`,
          `• 对方当前积分: <code>${result.targetPointsAfter}</code>`,
          `• 今日该用户已被偷: <code>${result.targetAttemptsToday}</code> / 8`,
        ].join("\n")
        : [
          `🛢️ ${thiefLink} 明明摸到了 ${targetLink} 的油桶，但对方今天已经见底了。`,
          `一分都没薅到。`,
          `• 今日该用户已被偷: <code>${result.targetAttemptsToday}</code> / 8`,
        ].join("\n");
    } else {
      text = result.actualPoints > 0
        ? [
          `💥 <b>关门打鼠</b>`,
          `${thiefLink} 偷油失手，反被 ${targetLink} 反抢了 <code>${result.actualPoints}</code> 分。`,
          `• 你的当前积分: <code>${result.thiefPointsAfter}</code>`,
          `• 对方当前积分: <code>${result.targetPointsAfter}</code>`,
          `• 今日该用户已被偷: <code>${result.targetAttemptsToday}</code> / 8`,
        ].join("\n")
        : [
          `💥 ${targetLink} 当场关门打鼠，但 ${thiefLink} 身上也没分可赔。`,
          `• 今日该用户已被偷: <code>${result.targetAttemptsToday}</code> / 8`,
        ].join("\n");
    }

    const msg = await ctx.reply(text, {
      parse_mode: "HTML",
      ...(!shouldDeleteTrigger && ctx.message ? { reply_parameters: { message_id: ctx.message.message_id } } : {}),
    });
    setTimeout(() => ctx.api.deleteMessage(chatId, msg.message_id).catch(() => { }), 30_000);
  };

  const replyPointsLeaderboard = async (ctx: Context, options?: { deleteTriggerMessage?: boolean }) => {
    if (!ctx.chat || ctx.chat.type === "private" || !ctx.from) {
      await ctx.reply("💡 请在群组内使用 <code>/jfph</code> 查看该群积分排行榜。", { parse_mode: "HTML" });
      return;
    }

    const chatId = ctx.chat.id;
    const shouldDeleteTrigger = options?.deleteTriggerMessage ?? false;
    if (!isPointsAvailableInChat(chatId)) {
      if (shouldDeleteTrigger) {
        try { await ctx.deleteMessage(); } catch (e) { }
      }
      const msg = await ctx.reply("🔴 当前群组未开启积分系统。");
      setTimeout(() => ctx.api.deleteMessage(chatId, msg.message_id).catch(() => { }), 20_000);
      return;
    }

    const pageData = await buildPointsRankPage(ctx, chatId, 0);
    if (shouldDeleteTrigger) {
      try { await ctx.deleteMessage(); } catch (e) { }
    }

    if (!pageData) {
      const msg = await ctx.reply("📭 暂无积分排行榜数据。");
      setTimeout(() => ctx.api.deleteMessage(chatId, msg.message_id).catch(() => { }), 20_000);
      return;
    }

    const msg = await ctx.reply(pageData.text, {
      parse_mode: "HTML",
      reply_markup: pageData.keyboard,
      link_preview_options: { is_disabled: true },
    });
    bindAdsUiOwner(chatId, msg.message_id, ctx.from.id);
    setTimeout(() => ctx.api.deleteMessage(chatId, msg.message_id).catch(() => { }), 60_000);
  };

  bot.command(["jfph", "rank"], async (ctx) => {
    await replyPointsLeaderboard(ctx, { deleteTriggerMessage: true });
  });

  bot.hears(/^积分排行榜$/, async (ctx) => {
    if (!ctx.chat || ctx.chat.type === "private" || !ctx.from || ctx.from.is_bot) return;
    await replyPointsLeaderboard(ctx, { deleteTriggerMessage: true });
  });

  const replyMyPoints = async (ctx: Context, options?: { deleteTriggerMessage?: boolean }) => {
    if (!ctx.chat || ctx.chat.type === "private" || !ctx.from) {
      await ctx.reply("💡 请在群组内使用 <code>/jf</code> 查询该群的积分。", { parse_mode: "HTML" });
      return;
    }

    const chatId = ctx.chat.id;
    const shouldDeleteTrigger = options?.deleteTriggerMessage ?? false;

    if (!isPointsAvailableInChat(chatId)) {
      if (shouldDeleteTrigger) {
        try { await ctx.deleteMessage(); } catch (e) { }
      }
      const msg = await ctx.reply("🔴 当前群组未开启积分系统。");
      setTimeout(() => ctx.api.deleteMessage(chatId, msg.message_id).catch(() => { }), 20_000);
      return;
    }

    const userId = ctx.from.id;
    const points = db.getUserPoints(chatId, userId);

    if (shouldDeleteTrigger) {
      try { await ctx.deleteMessage(); } catch (e) { }
    }

    const userName = getUserName(ctx.from);
    const keyboard = new InlineKeyboard()
      .text("📊 积分流水", `ads_jf_logs_${chatId}_0`)
      .text("🏆 积分排行", `ads_jf_rank_${chatId}_0`).row();

    const msg = await ctx.reply(
      `💰 <b><a href="tg://user?id=${userId}">${esc(userName)}</a> 的积分账户</b>\n\n` +
      `• 当前总积分: <code>${points.total}</code>\n` +
      `• 今日已获取: <code>${points.today}</code> / 10\n\n` +
      `<i>通过在群内活跃聊天可以赚取积分（每天上限 10 分）。\n积分可用于兑换进群邀请券和积分商城商品。</i>`,
      { parse_mode: "HTML", reply_markup: keyboard }
    );
    bindAdsUiOwner(chatId, msg.message_id, userId);
    setTimeout(() => ctx.api.deleteMessage(chatId, msg.message_id).catch(() => { }), 60_000);
  };

  const replyMyPointLogs = async (ctx: Context, options?: { deleteTriggerMessage?: boolean }) => {
    if (!ctx.chat || ctx.chat.type === "private" || !ctx.from) {
      await ctx.reply("💡 请在群组内使用“积分流水”查询该群流水。", { parse_mode: "HTML" });
      return;
    }

    const chatId = ctx.chat.id;
    const shouldDeleteTrigger = options?.deleteTriggerMessage ?? false;
    if (!isPointsAvailableInChat(chatId)) {
      if (shouldDeleteTrigger) {
        try { await ctx.deleteMessage(); } catch (e) { }
      }
      const msg = await ctx.reply("🔴 当前群组未开启积分系统。");
      setTimeout(() => ctx.api.deleteMessage(chatId, msg.message_id).catch(() => { }), 20_000);
      return;
    }

    const userId = ctx.from.id;
    const pageData = await buildPointsLedgerPage(ctx, chatId, userId, 0);

    if (shouldDeleteTrigger) {
      try { await ctx.deleteMessage(); } catch (e) { }
    }

    if (!pageData) {
      const msg = await ctx.reply("📭 最近20天暂无积分流水记录。");
      setTimeout(() => ctx.api.deleteMessage(chatId, msg.message_id).catch(() => { }), 20_000);
      return;
    }

    const msg = await ctx.reply(pageData.text, {
      parse_mode: "HTML",
      reply_markup: pageData.keyboard,
    });
    bindAdsUiOwner(chatId, msg.message_id, userId);
    setTimeout(() => ctx.api.deleteMessage(chatId, msg.message_id).catch(() => { }), 60_000);
  };

  bot.command("jf", async (ctx) => {
    await replyMyPoints(ctx, { deleteTriggerMessage: true });
  });

  bot.command("ty", async (ctx) => {
    await handleOilSteal(ctx, { deleteTriggerMessage: true });
  });

  // 群内发送“积分”两个字，等效触发 /jf（不计入活跃度和积分）
  bot.hears(/^积分$/, async (ctx) => {
    if (!ctx.chat || ctx.chat.type === "private" || !ctx.from || ctx.from.is_bot) return;
    await replyMyPoints(ctx, { deleteTriggerMessage: true });
  });

  bot.hears(/^积分流水$/, async (ctx) => {
    if (!ctx.chat || ctx.chat.type === "private" || !ctx.from || ctx.from.is_bot) return;
    await replyMyPointLogs(ctx, { deleteTriggerMessage: true });
  });

  bot.hears(/^偷油$/, async (ctx) => {
    if (!ctx.chat || ctx.chat.type === "private" || !ctx.from || ctx.from.is_bot) return;
    await handleOilSteal(ctx, { deleteTriggerMessage: false });
  });

  // 群内发送“抽奖”两个字，精准查询当前是否有进行中的抽奖，并跳转到抽奖消息
  bot.hears(/^抽奖$/, async (ctx) => {
    if (!ctx.chat || ctx.chat.type === "private" || !ctx.from || ctx.from.is_bot) return;
    const chatId = ctx.chat.id;

    const active = db.getLatestActiveLotteryByChat(chatId);
    if (!active) {
      const msg = await ctx.reply("📭 当前暂无进行中的抽奖活动。");
      setTimeout(() => ctx.api.deleteMessage(chatId, msg.message_id).catch(() => { }), 20_000);
      return;
    }

    const jumpLink = (() => {
      if ("username" in ctx.chat && ctx.chat.username) {
        return `https://t.me/${ctx.chat.username}/${active.message_id}`;
      }
      const cid = String(chatId);
      if (cid.startsWith("-100")) {
        return `https://t.me/c/${cid.slice(4)}/${active.message_id}`;
      }
      return "";
    })();

    const text = jumpLink
      ? `🎁 当前有进行中的抽奖：<b>${esc(active.title)}</b>\n👉 <a href="${jumpLink}">点击跳转抽奖消息</a>`
      : `🎁 当前有进行中的抽奖：<b>${esc(active.title)}</b>\n⚠️ 当前群组暂无可用跳转链接，请手动查看置顶消息。`;
    const msg = await ctx.reply(text, { parse_mode: "HTML", link_preview_options: { is_disabled: true } });
    setTimeout(() => ctx.api.deleteMessage(chatId, msg.message_id).catch(() => { }), 30_000);
  });

  const replyPointsMall = async (ctx: Context, options?: { deleteTriggerMessage?: boolean }) => {
    if (!ctx.chat || ctx.chat.type === "private") {
      await ctx.reply("💡 此命令需在群组中使用。", { parse_mode: "HTML" });
      return;
    }
    const chatId = ctx.chat.id;
    const shouldDeleteTrigger = options?.deleteTriggerMessage ?? false;
    const mallAvailability = getPointsMallAvailability(chatId);
    if (!mallAvailability.ok) {
      if (shouldDeleteTrigger) {
        try { await ctx.deleteMessage(); } catch (e) { }
      }
      const msg = await ctx.reply(`🔴 ${mallAvailability.reason}。`);
      setTimeout(() => ctx.api.deleteMessage(chatId, msg.message_id).catch(() => { }), 20_000);
      return;
    }
    const items = db.listPointsMallItemsByChat(chatId, true);
    if (!items.length) {
      if (shouldDeleteTrigger) {
        try { await ctx.deleteMessage(); } catch (e) { }
      }
      const msg = await ctx.reply("📭 当前群组暂未上架任何积分商品。");
      setTimeout(() => ctx.api.deleteMessage(chatId, msg.message_id).catch(() => { }), 20_000);
      return;
    }
    const botUser = await ctx.api.getMe();
    if (shouldDeleteTrigger) {
      try { await ctx.deleteMessage(); } catch (e) { }
    }
    const url = `https://t.me/${botUser.username}?start=shop_${chatId}`;
    const keyboard = new InlineKeyboard().url("🛍 前去私聊兑换", url);
    const purchaseCount = items.filter(i => i.promo_scene === "purchase").length;
    const renewCount = items.filter(i => i.promo_scene === "renew").length;
    const msg = await ctx.reply(
      `🛍️ <b>积分商城</b>\n\n当前群组已上架 <code>${purchaseCount}</code> 个可购商品 / <code>${renewCount}</code> 个续费商品。\n为保护隐私，请点击下方按钮前往私聊查看并兑换。`,
      { parse_mode: "HTML", reply_markup: keyboard }
    );
    setTimeout(() => ctx.api.deleteMessage(chatId, msg.message_id).catch(() => { }), 60_000);
  };

  bot.command(["shop", "mall"], async (ctx) => {
    await replyPointsMall(ctx, { deleteTriggerMessage: true });
  });

  bot.hears(/^商城$/, async (ctx) => {
    if (!ctx.chat || ctx.chat.type === "private" || !ctx.from || ctx.from.is_bot) return;
    await replyPointsMall(ctx, { deleteTriggerMessage: true });
  });

  bot.command(["dh", "exchange"], async (ctx) => {
    if (!ctx.chat || ctx.chat.type === "private") {
      await ctx.reply("💡 此命令需在群组中使用。");
      return;
    }
    const chatId = ctx.chat.id;
    const botPerm = await getBotPermissionStatus(ctx, chatId);
    if (!botPerm.ok) {
      try { await ctx.deleteMessage(); } catch (e) { }
      const msg = await ctx.reply(`❌ 当前群组机器人权限不足，暂不可兑换邀请码。\n原因：${botPerm.shortReason}`);
      setTimeout(() => ctx.api.deleteMessage(chatId, msg.message_id).catch(() => { }), 20_000);
      return;
    }
    if (!isPointsAvailableInChat(chatId)) {
      try { await ctx.deleteMessage(); } catch (e) { }
      const msg = await ctx.reply("🔴 当前群组未开启积分系统，无法兑换邀请券。");
      setTimeout(() => ctx.api.deleteMessage(chatId, msg.message_id).catch(() => { }), 20_000);
      return;
    }
    const botUser = await ctx.api.getMe();

    // 立即删除用户的指令
    try { await ctx.deleteMessage(); } catch (e) { }

    const url = `https://t.me/${botUser.username}?start=dh_${chatId}`;
    const keyboard = new InlineKeyboard().url("🎫 前去私聊兑换", url);

    const msg = await ctx.reply(
      `🎟️ <b>积分兑换邀请券</b>\n\n为了保护隐私并减少干扰，请点击下方按钮前往私聊机器人进行兑换。`,
      { parse_mode: "HTML", reply_markup: keyboard }
    );
    setTimeout(() => ctx.api.deleteMessage(chatId, msg.message_id).catch(() => { }), 60_000);
  });

  bot.command("yq", async (ctx) => {
    if (!ctx.chat || ctx.chat.type === "private" || !ctx.from) return;
    const chatId = ctx.chat.id;
    if (!isPointsAvailableInChat(chatId)) {
      try { await ctx.deleteMessage(); } catch (e) { }
      const msg = await ctx.reply("🔴 当前群组未开启积分系统。");
      setTimeout(() => ctx.api.deleteMessage(chatId, msg.message_id).catch(() => { }), 20_000);
      return;
    }
    const userId = ctx.from.id;
    const userName = getUserName(ctx.from);

    // 立即删除用户的指令
    try { await ctx.deleteMessage(); } catch (e) { }

    const pageData = await buildUserVoucherDetailPage(chatId, userId, userName, 0);
    if (!pageData) {
      const msg = await ctx.reply("📋 您还没有兑换过邀请券。使用 <code>/dh</code> 兑换。", { parse_mode: "HTML" });
      setTimeout(() => ctx.api.deleteMessage(chatId, msg.message_id).catch(() => { }), 30_000);
      return;
    }

    try {
      await ctx.api.sendMessage(userId, pageData.text, {
        parse_mode: "HTML",
        ...(pageData.keyboard ? { reply_markup: pageData.keyboard } : {}),
        link_preview_options: { is_disabled: true }
      });
      const msg = await ctx.reply("✅ 邀请券明细已发送到私聊（每页20条），请注意查收。");
      setTimeout(() => ctx.api.deleteMessage(chatId, msg.message_id).catch(() => { }), 20_000);
    } catch {
      const botUsername = ctx.me.username;
      const deepLink = `https://t.me/${botUsername}?start=yq_${chatId}`;
      const keyboard = new InlineKeyboard().url("📩 打开私聊查看明细", deepLink);
      const msg = await ctx.reply(
        "⚠️ 还无法直接私聊发送明细，请先点击下方按钮打开机器人私聊后查看（每页20条）。",
        { reply_markup: keyboard }
      );
      setTimeout(() => ctx.api.deleteMessage(chatId, msg.message_id).catch(() => { }), 60_000);
    }
  });

  bot.on("message:text", async (ctx, next) => {
    if (ctx.chat?.type !== "private" || !ctx.from) return next();
    if (ctx.message.text.startsWith("/") || ctx.message.text.startsWith("／")) return next();
    const adminId = Number(process.env.ADMIN_USER_ID || 0);
    if (!adminId || ctx.from.id !== adminId) return next();
    await handleAdminAssistantRequest(ctx, ctx.chat.id, ctx.from.id, ctx.message.text.trim());
  });

  // ========== 消息监听 ==========
  bot.on("message", async (ctx) => {
    try {
      // 仅处理群组消息，且必须有发送人
      if (!ctx.chat || ctx.chat.type === "private" || !ctx.from) return;

      // 跳过频道发言 (777000 为 Telegram 代表频道显示的 ID)
      if (ctx.from?.id === 777000 || ctx.senderChat?.type === "channel" || ctx.message.is_automatic_forward) {
        return;
      }

      const chatId = ctx.chat.id;
      const userId = ctx.from?.id;
      if (userId && ctx.message?.message_id) {
        trackRecentUserMessage(chatId, userId, ctx.message.message_id);
      }
      const includeContext = !(await shouldIgnoreReplyContextForDetection(ctx, chatId, ctx.message));
      const detectionText = buildTelegramDetectionText(ctx.message, { includeContext });
      const bodyMessageText = detectionText.bodyText;
      const messageText = detectionText.text;
      const trimmedMessageText = bodyMessageText.trim();
      const hasQuotedContext = detectionText.hasContext;
      const hasContactCard = !!ctx.message?.contact;
      const hasPhoto = !!ctx.message?.photo?.length;
      const hasAnimation = !!ctx.message?.animation;
      const hasSticker = !!ctx.message?.sticker;
      const hasImageDocument = !!ctx.message?.document?.mime_type?.startsWith("image/");
      const hasScoringMedia = hasPhoto || hasAnimation || hasSticker || hasImageDocument;

      db.upsertChatUserProfile(chatId, userId, ctx.from?.username, getUserName(ctx.from));

      if (!userId || (!messageText && !hasScoringMedia)) return;

      // 统计用户发言（用于抽奖活动等条件过滤，支持文本/图片/贴纸，排除指令、签到与快捷词）
      const isCommand = trimmedMessageText.startsWith("/") || trimmedMessageText.startsWith("／");
      const isQiandao = trimmedMessageText === "签到";
      const isPointsShortcut = bodyMessageText === "积分";
      const isPointsLogsShortcut = trimmedMessageText === "积分流水";
      const isPointsLeaderboardShortcut = trimmedMessageText === "积分排行榜";
      const isShopShortcut = trimmedMessageText === "商城";
      const isOilStealShortcut = trimmedMessageText === "偷油";
      const isLotteryShortcut = trimmedMessageText === "抽奖";
      if (!isCommand && !isQiandao && !isPointsShortcut && !isPointsLogsShortcut && !isPointsLeaderboardShortcut && !isShopShortcut && !isOilStealShortcut && !isLotteryShortcut && !ctx.from?.is_bot) {
        db.incrementUserMessageCount(chatId, userId);
        if (isPointsAvailableInChat(chatId)) {
          db.addUserPoints(chatId, userId, 1);
        }
      }

      const groupEnabled = db.isGroupEnabled(chatId);
      const aiEnabled = isAIAvailableInChat(chatId);

      // === 抽奖 Bot 检测：Bot 消息含抽奖关键词 → 标记该群启用口令过滤 ===
      if (ctx.from?.is_bot && LOTTERY_BOT_REGEX.test(bodyMessageText)) {
        if (!lotteryActiveGroups.has(chatId)) {
          lotteryActiveGroups.add(chatId);
          console.log(`[AntiSpam] 检测到抽奖 Bot 消息，群 ${chatId} 启用口令刷屏过滤`);
        }
        return; // Bot 消息不检测
      }

      // 跳过机器人自己的消息
      if (ctx.from?.is_bot) return;

      const repliedFrom = ctx.message?.reply_to_message?.from;
      const messageEntities = [...(ctx.message?.entities ?? []), ...(ctx.message?.caption_entities ?? [])];
      const extractedUrls = extractUrlsFromTelegramMessageWithContext(ctx.message, { includeContext });
      const hasEmbeddedUrl = extractedUrls.length > 0;
      const hasRawUrlText = /(https?:\/\/|tg:\/\/|t\.me\/|www\.)/i.test(messageText);
      const hasJumpRiskUrl = extractedUrls.some((url) => isJumpAdUrl(url));
      const myBotId = ctx.me?.id ?? await getSelfBotId();
      const ctxBotUsername = (ctx.me?.username || "").toLowerCase();
      const myBotUsername = ctxBotUsername || await getSelfBotUsername();
      const repliedToBot = !!(
        repliedFrom &&
        repliedFrom.is_bot &&
        (
          (!!myBotId && repliedFrom.id === myBotId) ||
          (!!myBotUsername && !!repliedFrom.username && repliedFrom.username.toLowerCase() === myBotUsername)
        )
      );
      const mentionedBot = messageEntities.some((entity) => {
        if (entity.type === "text_mention") {
          const mentionUserId = (entity as any).user?.id as number | undefined;
          return !!myBotId && mentionUserId === myBotId;
        }
        if (entity.type !== "mention") return false;
        const mentionText = bodyMessageText
          .substring(entity.offset, entity.offset + entity.length)
          .trim()
          .replace(/^@+/, "")
          .toLowerCase();
        return !!myBotUsername && mentionText === myBotUsername;
      });
      const repliedBotText = ctx.message?.reply_to_message?.text || ctx.message?.reply_to_message?.caption || "";

      if (aiEnabled && !isCommand && trimmedMessageText.length > 0) {
        const provokeHandled = await maybeEnforceAssistantProvokeGuard(
          ctx,
          chatId,
          userId,
          getUserName(ctx.from),
          bodyMessageText,
          repliedToBot,
          mentionedBot,
          repliedBotText
        );
        if (provokeHandled) return;
      }

      const shouldAssistantChat = (repliedToBot || mentionedBot) && !isCommand && trimmedMessageText.length > 0;
      const requesterIsAdmin = await checkIsAdmin(ctx, chatId, userId);
      if (shouldAssistantChat && !isSuperAdminUserId(userId) && !isCommercialFeatureEnabledForChat(chatId)) {
        const tipText = requesterIsAdmin
          ? `💼 <b>AI 管理助理</b> 属于订阅功能。\n\n请先私聊机器人发送 <code>/console</code> 登录控制台，进行订阅！`
          : `💼 <b>AI 助理</b> 当前还未在本群开通。\n\n请联系群管理员先私聊机器人发送 <code>/console</code> 订阅，并在群里完成绑定。`;
        await replyTempNotice(
          ctx,
          tipText,
          {
            parse_mode: "HTML",
            reply_parameters: { message_id: ctx.message.message_id },
          }
        );
        return;
      }
      if (shouldAssistantChat && await canUseAssistantInGroup(ctx, chatId, userId)) {
        if (!aiEnabled) {
          const tip = await ctx.reply(requesterIsAdmin
            ? "⚠️ 当前群组未开启 AI 开关，管理助理暂不可用。请先执行 <code>/ai on</code>。"
            : "⚠️ 当前群组未开启 AI 助理。请联系群管理员先执行 <code>/ai on</code>。", {
            parse_mode: "HTML",
            reply_parameters: { message_id: ctx.message.message_id },
          }).catch(() => null);
          if (tip) {
            setTimeout(() => ctx.api.deleteMessage(chatId, tip.message_id).catch(() => { }), 30_000);
          }
          return;
        }
        const sharedPendingReply = ctx.message?.message_id
          ? await createPendingReplyMessage(ctx, chatId, ctx.message.message_id)
          : null;
        const handled = await handleAdminAssistantRequest(ctx, chatId, userId, trimmedMessageText, sharedPendingReply);
        if (handled) return;
        await maybeReplyToBotInGroup(
          ctx,
          chatId,
          userId,
          getUserName(ctx.from),
          bodyMessageText || (hasSticker ? "（发了贴纸）" : hasPhoto ? "（发了图片）" : hasAnimation ? "（发了动图）" : hasImageDocument ? "（发了图片文件）" : ""),
          repliedBotText,
          sharedPendingReply
        );
        return;
      }

      const shouldGroupChat = aiEnabled && (repliedToBot || mentionedBot) && !isCommand && (trimmedMessageText.length > 0 || hasScoringMedia);

      // 纯短文本通常噪声很高，但带隐藏链接/跳转链接的短消息仍需要继续检测。
      if (!hasScoringMedia && trimmedMessageText.length < 5 && !repliedToBot && !mentionedBot && !hasEmbeddedUrl && !hasRawUrlText && !hasQuotedContext) return;

      // 回复机器人或 @机器人 时走快速通道：优先短回复，不等待后续广告检测链路
      if (shouldGroupChat) {
        await maybeReplyToBotInGroup(
          ctx,
          chatId,
          userId,
          getUserName(ctx.from),
          bodyMessageText || (hasSticker ? "（发了贴纸）" : hasPhoto ? "（发了图片）" : hasAnimation ? "（发了动图）" : hasImageDocument ? "（发了图片文件）" : ""),
          repliedBotText
        );
        return;
      }

      // 检查群组是否开启反垃圾（仅影响反垃圾链路，不影响上面的回复机器人对话）
      if (!groupEnabled) return;

      if (!isCommand && trimmedMessageText.length > 0) {
        const duplicateFlood = trackDuplicateTextAndCheckFlood(chatId, userId, trimmedMessageText);
        if (duplicateFlood) {
          await tryDeleteSourceMessage(ctx);
          const penalty = trackDuplicateFloodPenalty(chatId, userId);
          if (penalty.shouldMute) {
            const untilDate = Math.floor(Date.now() / 1000) + DUPLICATE_FLOOD_MUTE_MINUTES * 60;
            await ctx.api.restrictChatMember(chatId, userId, {
              can_send_messages: false,
              can_send_other_messages: false,
              can_add_web_page_previews: false,
            }, { until_date: untilDate }).catch(() => { });
          }
          await replyTempNotice(
            ctx,
            penalty.shouldMute
              ? `🚫 ${await renderUserLink(ctx, chatId, userId)} 重复刷屏（6小时内第 ${penalty.count} 次），已删除并禁言 ${DUPLICATE_FLOOD_MUTE_MINUTES} 分钟。`
              : `⚠️ ${await renderUserLink(ctx, chatId, userId)} 疑似重复刷屏，消息已删除。`,
            {
              parse_mode: "HTML",
              link_preview_options: { is_disabled: true },
            }
          );
          return;
        }
      }

      // === 刷屏口令过滤：仅在检测到抽奖 Bot 的群启用 ===
      if (lotteryActiveGroups.has(chatId) && bodyMessageText.length <= 30 && !hasPhoto) {
        const normalizedText = bodyMessageText.trim();
        const dedupKey = `${chatId}:${normalizedText}`;

        // 已确认的刷屏口令，直接跳过
        if (confirmedLotteryKeywords.has(dedupKey)) {
          return;
        }

        // 跟踪不同用户发送相同消息
        let dedupData = messageDedup.get(dedupKey);
        if (!dedupData) {
          dedupData = { users: new Set(), firstSeen: Date.now() };
          messageDedup.set(dedupKey, dedupData);
        }
        dedupData.users.add(userId);

        // 3 个不同用户发相同消息 → 确认为刷屏口令，跳过 AI 检测
        if (dedupData.users.size >= DEDUP_THRESHOLD) {
          confirmedLotteryKeywords.add(dedupKey);
          console.log(`[AntiSpam] 确认刷屏口令: "${normalizedText}" (群 ${chatId}, ${dedupData.users.size} 人发送)`);
          return;
        }
      }

      // 检查白名单
      if (db.isWhitelisted(chatId, userId)) return;

      // == 检查管理员 (全群免杀) ==
      if (isAnyGroupAdmin(userId)) return;
      // 如果当前群还没在缓存里抓过，为了保险起见，再查一遍当前群
      if (!adminCache.has(chatId)) {
        const admins = await getAdmins(ctx, chatId);
        if (admins.has(userId)) return;
      }

      const existingPoll = getActivePollForUser(chatId, userId);
      if (existingPoll && ctx.message.message_id !== existingPoll.userMessageId) {
        try {
          await ctx.api.deleteMessage(chatId, ctx.message.message_id);
        } catch (e: any) {
          if (!isMessageDeleteUnavailableError(e)) {
            console.error("[AntiSpam] 删除活跃投票期间的后续消息失败:", e);
          }
        }
        return;
      }

      // 防频繁检测
      if (shouldSkipCheck(chatId, userId)) return;

      // ====== 提取图片 ======
      let imageUrl: string | undefined;
      if (aiEnabled && hasPhoto) {
        const photo = ctx.message?.photo!;
        const highestRes = photo[photo.length - 1];
        try {
          const file = await ctx.api.getFile(highestRes.file_id);
          if (file.file_path) {
            const fileUrl = `https://api.telegram.org/file/bot${process.env.BOT_TOKEN}/${file.file_path}`;
            const response = await axios.get(fileUrl, { responseType: "arraybuffer" });
            const base64 = Buffer.from(response.data, "binary").toString("base64");
            imageUrl = `data:image/jpeg;base64,${base64}`;
          }
        } catch (err) {
          console.error("[AntiSpam] 获取图片内容失败:", err);
        }
      }

      // ====== 获取聊天历史上下文 ======
      const history = chatHistoryCache.get(chatId) || [];
      const historyText = history.map((h) => `${h.userName}: ${h.text}`).join("\n");

      // ====== 提取链接预览 (防止通过单纯发链接发黄推) ======
      let linkPreviewText = "";
      const linkPreviewSignals: string[] = [];
      if (aiEnabled && extractedUrls.length > 0) {
        const normalizedUrls = extractedUrls.map((raw) => raw.startsWith("http") ? raw : `https://${raw}`);
        linkPreviewText += `\n[消息内链接]: ${normalizedUrls.join(" | ")}`;
        for (const url of normalizedUrls) {
          try {
            const res = await axios.get(url, {
              timeout: 3000,
              maxRedirects: 2,
              maxContentLength: 500 * 1024,
              responseType: "text",
              headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)" }
            });
            const finalUrl = String((res.request as any)?.res?.responseUrl || "").trim();
            if (finalUrl && finalUrl !== url) {
              linkPreviewSignals.push(`最终跳转: ${finalUrl}`);
            }
            const html = res.data;
            if (typeof html !== "string") continue;
            let title = "";
            let desc = "";
            const metaRegex = /<meta[^>]+>/ig;
            let match;
            while ((match = metaRegex.exec(html)) !== null) {
              const tag = match[0];
              if (/property=["']og:title["']/i.test(tag) || /name=["']twitter:title["']/i.test(tag) || /property=["']twitter:title["']/i.test(tag)) {
                const cMatch = tag.match(/content=["']([^"']+)["']/i);
                if (cMatch && !title) title = cMatch[1];
              }
              if (/property=["']og:description["']/i.test(tag) || /name=["']description["']/i.test(tag) || /name=["']twitter:description["']/i.test(tag) || /property=["']twitter:description["']/i.test(tag)) {
                const cMatch = tag.match(/content=["']([^"']+)["']/i);
                if (cMatch && !desc) desc = cMatch[1];
              }
            }
            const decodeHtmlEntities = (s: string) => s.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
            const metaText = [decodeHtmlEntities(title), decodeHtmlEntities(desc)].filter(Boolean).join("\n");
            if (metaText) {
              linkPreviewText += `\n[链接预览内容]: ${metaText}`;
            }
          } catch {
            // 忽略抓取失败，但原始链接仍会进入检测文本
          }
        }
        if (linkPreviewSignals.length > 0) {
          linkPreviewText += `\n[链接跳转]: ${linkPreviewSignals.join(" | ")}`;
        }
      }

      const suspiciousPromoText = hasSuspiciousPromoKeywords(`${messageText}\n${linkPreviewText}`);
      const suspiciousContactPromoText = hasContactCard && hasSuspiciousContactPromoText(messageText);
      const contactHasPhoneNumber = hasContactCard && hasLikelyPhoneNumber(messageText);
      const suspiciousShortJumpAd = hasJumpRiskUrl && suspiciousPromoText;
      const highRiskHints: string[] = [];
      if (hasJumpRiskUrl) highRiskHints.push("存在短链/Telegram跳转链接");
      if (suspiciousPromoText) highRiskHints.push("命中黄推/导流高风险词");
      if (hasContactCard) highRiskHints.push("发送联系人名片");
      if (contactHasPhoneNumber) highRiskHints.push("联系人名片包含手机号");
      if (suspiciousContactPromoText) highRiskHints.push("联系人名片包含交易或引流词");
      if (trimmedMessageText.length <= 12 && (hasEmbeddedUrl || hasRawUrlText)) highRiskHints.push("短文本携带外链或隐藏链接");
      const finalMessageText = aiEnabled
        ? `${messageText}${linkPreviewText}${highRiskHints.length ? `\n[高风险信号]: ${highRiskHints.join("；")}` : ""}`
        : messageText;

      // ====== 加载学习样本 + 获取用户画像 + AI/本地检测 ======
      const globalMax30 = db.getUserMaxMessageCountAcrossGroups(userId, 30); // 全局最高
      const groupMsg10 = db.getUserMessageCount(chatId, userId, 10);
      const groupMsg30 = db.getUserMessageCount(chatId, userId, 30);
      const activityTier = getActivityTier(globalMax30, groupMsg10, groupMsg30);
      const activityLabel = getActivityTierLabel(activityTier);
      const userNameStr = getUserName(ctx.from);
      const senderPortrait = [
        `用户 ID: ${userId}, 昵称: "${userNameStr}"。`,
        `活跃分层: ${activityLabel}。`,
        `活跃数据: 本群10天发言 ${groupMsg10} 次，本群30天发言 ${groupMsg30} 次，全群最高30天发言 ${globalMax30} 次。`,
        activityTier === "new_low"
          ? "该用户属于重点审查对象，广告判定可适当从严。"
          : activityTier === "old_high"
            ? "该用户属于高信任老成员，除非出现明显引流/广告特征，否则应从宽处理。"
            : "该用户活跃度中等，按常规标准处理。"
      ].join(" ");

      const samples: SpamSample[] = db.getSamples(chatId, aiEnabled ? 20 : 80).map((s) => ({
        message_text: s.message_text,
        is_spam: s.is_spam,
      }));
      const result = aiEnabled
        ? await checkSpam(finalMessageText, samples, historyText, imageUrl, senderPortrait, false, getChatAIProvider(chatId))
        : checkSpamByLocalSamples(finalMessageText, samples, {
          groupMsg10,
          groupMsg30,
        });

      if (aiEnabled) {
        await maybeNotifyAiFailure(ctx, {
          chatId,
          userId,
          userName: userNameStr,
          model: result.model,
          reason: result.reason,
          source: "群组实时检测",
          messageText: finalMessageText,
          autoDisableAi: true,
        });
      }

      // 更新历史缓存
      const userName = getUserName(ctx.from);
      if (finalMessageText) {
        history.push({ userName, text: finalMessageText });
        if (history.length > MAX_HISTORY) history.shift();
        chatHistoryCache.set(chatId, history);
      }

      // 获取该群组的阈值
      const threshold = db.getThreshold(chatId);
      const hasLinkEntity = hasEmbeddedUrl;
      const hasRiskLink = hasLinkEntity || hasRawUrlText;
      const hasRiskSignal = hasRiskLink || hasContactCard || hasPhoto || hasAnimation || hasImageDocument;
      const extraRiskDiscount =
        (suspiciousShortJumpAd ? 0.12 : hasJumpRiskUrl ? 0.06 : 0)
        + (suspiciousContactPromoText ? 0.12 : contactHasPhoneNumber ? 0.08 : hasContactCard ? 0.04 : 0);
      const spamThreshold = aiEnabled
        ? getAdaptiveSpamThreshold(threshold, activityTier, hasRiskSignal, extraRiskDiscount)
        : threshold;
      const detectorLabel = result.model === "LocalSamples" ? "本地样本匹配" : "AI 检测";
      const displayReason = cleanupReasonForDisplay(result.reason || "");

      if (result.spam && result.confidence >= spamThreshold) {
        const userName = getUserName(ctx.from);

        console.log(
          `[AntiSpam] ${detectorLabel}命中广告 | 群组: ${chatId} | 用户: ${userName}(${userId}) | 匹配值: ${result.confidence} | 阈值: ${spamThreshold.toFixed(2)} | 分层: ${activityLabel} | 原因: ${displayReason}`
        );

        try {
          await createSuspiciousSpamPoll(ctx, {
            chatId,
            userId,
            userName,
            userMessageId: ctx.message.message_id,
            text: finalMessageText,
            confidence: result.confidence,
            reason: displayReason,
            detector: result.model,
            activityLabel,
            spamThreshold,
            replyToMessageId: ctx.message.message_id,
          });
        } catch (e) {
          console.error("[AntiSpam] 发送投票消息失败:", e);
        }
      } else if (result.argue && result.confidence >= threshold) {
        const userName = getUserName(ctx.from);

        console.log(
          `[AntiSpam] 检测到吵架/骂人 | 群组: ${chatId} | 用户: ${userName}(${userId}) | 匹配值: ${result.confidence} | 原因: ${displayReason}`
        );

        // 1. 删除消息
        try {
          await ctx.api.deleteMessage(chatId, ctx.message.message_id);
        } catch (e: any) {
          if (e instanceof GrammyError && e.description === "Bad Request: message to delete not found") {
            // 消息已被删除，忽略
          } else {
            console.error("[AntiSpam] 删除吵架消息失败:", e);
          }
        }

        // 2. 禁言 10 分钟
        try {
          const untilDate = Math.floor(Date.now() / 1000) + 10 * 60;
          await ctx.api.restrictChatMember(
            chatId,
            userId,
            {
              can_send_messages: false,
              can_send_other_messages: false,
              can_add_web_page_previews: false
            },
            { until_date: untilDate }
          );
        } catch (e) {
          console.error(`[AntiSpam] 禁言用户失败 (群 ${chatId}, 用户 ${userId}):`, e);
        }

        // 3. 发送通知
        try {
          const chatRef = await renderChatReference(chatId);
          notifyAdmin(
            `⚠️ <b>AI 禁言通知 (吵架/辱骂)</b>\n\n` +
            `📝 <b>群组:</b> ${chatRef}\n` +
            `👤 <b>用户:</b> <a href="tg://user?id=${userId}">${esc(userName)}</a> (<code>${userId}</code>)\n` +
            `📌 <b>原因:</b> ${esc(displayReason)}\n` +
            `⏱️ <b>时长:</b> 10分钟`
          );

          const notice = await ctx.api.sendMessage(
            chatId,
            [
              `⚠️ <b>警告：禁止辱骂与激烈争吵</b>`,
              ``,
              `👤 用户: <b><a href="tg://user?id=${userId}">${esc(userName)}</a></b> (<code>${userId}</code>)`,
              `📊 匹配值: <code>${(result.confidence * 100).toFixed(1)}%</code>`,
              `📝 原因: ${esc(displayReason)}`,
              ``,
              `<i>已被禁言 10 分钟。请保持群内友好交流。</i>`,
            ].join("\n"),
            { parse_mode: "HTML" }
          );

          // 3 分钟后自动删除通知 (对齐用户之前要求的 3 分钟清理时间)
          setTimeout(async () => {
            try { await ctx.api.deleteMessage(chatId, notice.message_id); } catch { }
          }, 3 * 60 * 1000);
        } catch (e) {
          console.error("[AntiSpam] 发送吵架通知失败:", e);
        }
      }
    } catch (error) {
      // 静默处理，不影响群组正常使用
      console.error("[AntiSpam] 消息处理出错:", error);
    }
  });

  // ========== 新成员加入监听（跨群封禁检查） ==========
  // ==================== 共享进群处理逻辑 ====================
  async function processUserJoin(ctx: Context, chatId: number, member: any, triggerSource: string) {
    if (member.is_bot) return;
    const userId = member.id;
    const userName = getUserName(member);

    console.log(`[AntiSpam] ${triggerSource} | 群组: ${chatId} | 用户: ${userName}(${userId}) | 处理开始`);

    // 获取群组配置
    const config = db.getGroupConfig(chatId);
    const inviteConfig = getEffectiveInvitationConfig(chatId);
    const basicEnabled = config?.enabled ?? false;
    const globalBanEnabled = config?.globalBanEnabled ?? false;
    const requiredChannel = typeof inviteConfig.requiredChannel === "string" ? inviteConfig.requiredChannel.trim() : "";
    const channelGateEnabled = requiredChannel.length > 0;
    if (!basicEnabled && !inviteConfig.required && !channelGateEnabled) {
      console.log(`[AntiSpam] 群组 ${chatId} 基础防护关闭且未开启核销验证，跳过进群处理。`);
      return;
    }

    const resolveRequiredChannelDisplay = async (): Promise<{ link: string; title: string }> => {
      let link = requiredChannel;
      let title = requiredChannel;
      if (!requiredChannel) return { link, title };

      try {
        const chat = await ctx.api.getChat(requiredChannel);
        if ("title" in chat && chat.title) title = chat.title;
        if ("username" in chat && chat.username) {
          link = `https://t.me/${chat.username}`;
        } else if ("invite_link" in chat && chat.invite_link) {
          link = chat.invite_link;
        }
      } catch { }

      if (link.startsWith("@")) {
        link = `https://t.me/${link.slice(1)}`;
      } else if (!/^https?:\/\//i.test(link) && !link.startsWith("tg://")) {
        link = `https://t.me/${link.replace(/^@/, "")}`;
      }

      return { link, title };
    };

    // 1. 开启跨群封禁时执行全局黑名单拦截
    if (globalBanEnabled) {
      const banInfo = db.getGlobalBanInfo(userId);
      if (banInfo) {
        console.log(`[AntiSpam] 黑名单进群强制拦截 | 用户: ${userName}(${userId}) | 原因: ${banInfo.reason}`);
        try {
          await banUserPermanently(ctx.api, chatId, userId);
          const notice = await ctx.api.sendMessage(
            chatId,
            `🚫 <b>全局黑名单强制拦截通知</b>\n\n用户: <b>${esc(userName)}</b> (<code>${userId}</code>)\n原因: ${esc(banInfo.reason)}`,
            { parse_mode: "HTML" }
          );
          setTimeout(() => ctx.api.deleteMessage(chatId, notice.message_id).catch(() => { }), 3 * 60 * 1000);
          return; // 既然已经封禁了，就不处理后续逻辑
        } catch (e) {
          console.error("[AntiSpam] 进群强制封禁失败:", e);
        }
      }
    }

    // 2. 仅启用必关频道时：入群校验关注状态（未通过则进入关注验证窗口）
    if (!inviteConfig.required && channelGateEnabled) {
      console.log(`[AntiSpam] 必关频道校验 | 用户: ${userName}(${userId}) | 频道: ${requiredChannel}`);
      let checkOk = false;
      let isSubscribed = false;
      try {
        const channelMember = await ctx.api.getChatMember(requiredChannel, userId);
        checkOk = true;
        isSubscribed = ["member", "administrator", "creator"].includes(channelMember.status);
      } catch (err: any) {
        if (isNotSubscribedError(err)) {
          checkOk = true;
          isSubscribed = false;
        } else if (isMembershipCheckUnavailableError(err)) {
          console.warn(`[AntiSpam] 必关频道订阅检查不可用，自动清除必关频道: ${getApiErrorDesc(err)}`);
          db.setRequiredChannel(chatId, "");
        } else {
          console.error(`[AntiSpam] 必关频道订阅检查失败: ${getApiErrorDesc(err)}`);
        }
      }

      // 校验成功且已订阅：直接放行
      if (checkOk && isSubscribed) {
        db.markChannelGuardMember(chatId, userId);
        const joinedChatTitle = ctx.chat && "title" in ctx.chat ? String(ctx.chat.title || "") : "";
        await sendCommercialChatWelcomeIfEnabled(ctx, chatId, {
          id: userId,
          username: member.username || "",
          displayName: userName,
        }, joinedChatTitle).catch((error) => {
          console.error("[CommercialWelcome] 发送欢迎语失败:", error);
        });
        return;
      }

      try {
        await ctx.api.restrictChatMember(chatId, userId, {
          can_send_messages: false,
          can_send_audios: false,
          can_send_documents: false,
          can_send_photos: false,
          can_send_videos: false,
          can_send_video_notes: false,
          can_send_voice_notes: false,
          can_send_polls: false,
          can_send_other_messages: false,
          can_add_web_page_previews: false,
        }).catch(e => console.error("[AntiSpam] 必关频道校验禁言失败:", e));

        const { link, title } = await resolveRequiredChannelDisplay();
        const keyboard = new InlineKeyboard()
          .url("📢 订阅群频道", link)
          .text("🔄 完成并验证", `ads_recheck_join_${userId}`)
          .row()
          .text("✅ 管理员放行", `ads_pass_join_${userId}`)
          .text("🚫 拒绝且封禁", `ads_ban_join_${userId}`);

        const guideLine = checkOk
          ? `请先订阅频道 <b><a href="${link}">${esc(title)}</a></b>，然后点击下方按钮前往频道完成关注。`
          : `请先订阅频道 <b><a href="${link}">${esc(title)}</a></b>，然后点击下方按钮前往频道完成关注（当前无法实时自动校验，可能是机器人不在频道或无管理员权限，需管理员放行）。`;

        const verifyMsg = await ctx.api.sendMessage(
          chatId,
          `🛡️ <b>进群门票验证</b>\n\n` +
          `👤 用户: <b><a href="tg://user?id=${userId}">${esc(userName)}</a></b> (<code>${userId}</code>)\n\n` +
          `群组已开启<b>【关注进群】</b>。请在<b>2分钟内</b>完成频道关注验证，超时 <b>封禁 5 分钟入群申请</b>。\n` +
          `${guideLine}\n` +
          `完成后点击“完成并验证”自动放行。`,
          {
            parse_mode: "HTML",
            reply_markup: keyboard,
            link_preview_options: { is_disabled: true },
          }
        );
        db.addUnverifiedMember(chatId, userId, verifyMsg.message_id);
      } catch (e) {
        console.error("[AntiSpam] 必关频道验证窗口初始化失败:", e);
      }
      return;
    }

    // 3. 邀请券核销系统 (核销进群阶段)
    if (inviteConfig.required) {
      console.log(`[AntiSpam] 开启核销验证 | 用户: ${userName}(${userId})`);
      try {
        // 立即执行全禁言
        await ctx.api.restrictChatMember(chatId, userId, {
          can_send_messages: false,
          can_send_audios: false,
          can_send_documents: false,
          can_send_photos: false,
          can_send_videos: false,
          can_send_video_notes: false,
          can_send_voice_notes: false,
          can_send_polls: false,
          can_send_other_messages: false,
          can_add_web_page_previews: false,
        }).catch(e => console.error("[AntiSpam] 进群禁言失败:", e));

        let link = "";
        let title = "";
        if (channelGateEnabled) {
          const display = await resolveRequiredChannelDisplay();
          link = display.link;
          title = display.title;
        }

        const verifyGuideText = channelGateEnabled
          ? `请先订阅 <b><a href="${link}">${esc(title)}</a></b> 频道，然后通过<b>邀请码</b>进行身份核销。`
          : `本群未设置必关频道，请直接通过<b>邀请码</b>进行身份核销。`;

        const keyboard = new InlineKeyboard();
        if (channelGateEnabled) {
          keyboard.url(`📢 订阅群频道`, link);
        }
        keyboard.url("🎫 核销邀请码", `https://t.me/${ctx.me.username}?start=verify_${chatId}`).row()
          .text("✅ 管理员放行", `ads_pass_join_${userId}`)
          .text("🚫 拒绝且封禁", `ads_ban_join_${userId}`);

        const welcomeMsg = await ctx.api.sendMessage(
          chatId,
          `🛡️ <b>进群门票验证</b>\n\n` +
          `👤 用户: <b><a href="tg://user?id=${userId}">${esc(userName)}</a></b> (<code>${userId}</code>)\n\n` +
          `群组已开启<b>【邀请进群】</b>。请在<b>2分钟内</b>完成券码核销，超时 <b>封禁 5 分钟入群申请</b>。\n${verifyGuideText}`,
          {
            parse_mode: "HTML",
            reply_markup: keyboard,
            link_preview_options: { is_disabled: true },
          }
        );
        db.addUnverifiedMember(chatId, userId, welcomeMsg.message_id);
      } catch (e) {
        console.error("[AntiSpam] 邀请核销初始化失败:", e);
      }
    }
  }

  // ========== 机器人自身状态监听 (管理员变更/进群初始化) ==========
  bot.on("my_chat_member", async (ctx) => {
    try {
      if (!ctx.chat || ctx.chat.type === "private") return;
      const chatId = ctx.chat.id;
      const oldStatus = ctx.myChatMember.old_chat_member.status;
      const newStatus = ctx.myChatMember.new_chat_member.status;

      console.log(`[AntiSpam] my_chat_member status change: ${oldStatus} -> ${newStatus} | Chat: ${chatId}`);

      const activeStatuses = new Set(["member", "restricted", "administrator", "creator"]);
      const oldActive = activeStatuses.has(oldStatus);
      const newActive = activeStatuses.has(newStatus);
      const oldAdmin = oldStatus === "administrator" || oldStatus === "creator";
      const newAdmin = newStatus === "administrator" || newStatus === "creator";

      // 机器人刚加入群：所有开关默认关闭
      if (!oldActive && newActive) {
        db.closeAllGroupSwitches(chatId);
        adminCache.delete(chatId);
        console.log(`[AntiSpam] 机器人加入群组 ${chatId}，已初始化为全开关关闭。`);
      }

      // 机器人失去管理员或被移出群：自动关闭全部开关
      if (!newAdmin && (oldAdmin || !newActive)) {
        db.closeAllGroupSwitches(chatId);
        adminCache.delete(chatId);
        console.log(`[AntiSpam] 群组 ${chatId} 机器人非管理员，已自动关闭全部开关。`);

        // 仅在机器人仍在群内时尝试发提示
        if (newActive) {
          await ctx.api.sendMessage(
            chatId,
            "⚠️ 检测到机器人已不是管理员，本群所有开关已自动关闭。请重新设为管理员后再手动开启。"
          ).catch(() => { });
        }
      }
    } catch (error) {
      console.error("[AntiSpam] my_chat_member 处理失败:", error);
    }
  });

  // ========== 成员加入检测 (主监听：chat_member 确保重进 100% 触发) ==========
  bot.on("chat_member", async (ctx) => {
    try {
      if (!ctx.chat || ctx.chat.type === "private") return;
      const oldStatus = ctx.chatMember.old_chat_member.status;
      const newStatus = ctx.chatMember.new_chat_member.status;
      const member = ctx.chatMember.new_chat_member.user;

      const activeStatuses = new Set(["member", "restricted", "administrator", "creator"]);

      // 频道成员变更：若检测到退订，则同步移出绑定了该频道的群成员
      if (ctx.chat.type === "channel") {
        if (oldStatus !== newStatus) {
          console.log(`[AntiSpam] channel chat_member status change: ${oldStatus} -> ${newStatus} | User: ${member.id} | Channel: ${ctx.chat.id}`);
        }

        const leftChannel = activeStatuses.has(oldStatus) && (newStatus === "left" || newStatus === "kicked");
        if (!leftChannel) return;

        const channelKeys = buildChannelIdentitySet(
          ctx.chat.id,
          "username" in ctx.chat ? (ctx.chat.username || undefined) : undefined
        );
        const mappings = db.getGroupsWithRequiredChannel()
          .filter(m => channelKeys.has(normalizeChannelIdentity(m.requiredChannel)));
        if (mappings.length === 0) return;

        for (const mapping of mappings) {
          const gid = mapping.chatId;
          try {
            if (!db.isChannelGuardMember(gid, member.id)) continue;
            const gm = await ctx.api.getChatMember(gid, member.id);
            const inGroup = activeStatuses.has(gm.status);
            const isAdminUser = gm.status === "administrator" || gm.status === "creator";
            if (!inGroup || isAdminUser) continue;

            const info = db.removeUnverifiedMember(gid, member.id);
            db.unmarkChannelGuardMember(gid, member.id);
            if (info?.welcomeMsgId) {
              await ctx.api.deleteMessage(gid, info.welcomeMsgId).catch(() => { });
            }

            await ctx.api.banChatMember(gid, member.id).catch(() => { });
            await ctx.api.unbanChatMember(gid, member.id).catch(() => { });

            const userLink = await renderUserLink(ctx, gid, member.id);
            const notice = await ctx.api.sendMessage(
              gid,
              `🗑️ <b>退订移除</b>\n用户 ${userLink} 已取消必关频道关注，已被自动移出群组。`,
              { parse_mode: "HTML" }
            ).catch(() => null);
            if (notice) {
              setTimeout(() => ctx.api.deleteMessage(gid, notice.message_id).catch(() => { }), 3 * 60 * 1000);
            }
          } catch (error) {
            const desc = String((error as any)?.description || (error as any)?.message || "");
            if (!/member|not found|chat not found|forbidden|have no rights/i.test(desc)) {
              console.error(`[AntiSpam] 频道退订联动移出失败 | 群: ${gid} | 用户: ${member.id}`, error);
            }
          }
        }
        return;
      }

      const chatId = ctx.chat.id;

      if (oldStatus !== newStatus) {
        console.log(`[AntiSpam] chat_member status change: ${oldStatus} -> ${newStatus} | User: ${member.id}`);
      }

      // 判定条件：只要新状态是正在入群（member/restricted）且之前不是入群状态
      const isJoining =
        (newStatus === "member" || newStatus === "restricted") &&
        (oldStatus !== "member" && oldStatus !== "restricted");

      if (isJoining) {
        await processUserJoin(ctx, chatId, member, "TRACKER:chat_member");
      }

      // 判定条件：离开群组 (从活跃状态变为了 left 或 kicked)
      const isLeaving =
        activeStatuses.has(oldStatus) &&
        (newStatus === "left" || newStatus === "kicked");

      if (isLeaving) {
        console.log(`[AntiSpam] TRACKER:Member Left | 群组: ${chatId} | 用户: ${member.id}`);
        const info = db.removeUnverifiedMember(chatId, member.id);
        db.unmarkChannelGuardMember(chatId, member.id);
        if (info?.welcomeMsgId) {
          await ctx.api.deleteMessage(chatId, info.welcomeMsgId).catch(() => { });
        }
      }
    } catch (error) {
      console.error("[AntiSpam] chat_member 检测器报错:", error);
    }
  });

  // ========== 成员加入监听 (兜底：传统 new_chat_members) ==========
  bot.on("message:new_chat_members", async (ctx) => {
    try {
      const chatId = ctx.chat.id;
      const newMembers = ctx.message?.new_chat_members || [];
      console.log(`[AntiSpam] new_chat_members service message | count: ${newMembers.length}`);
      for (const member of newMembers) {
        await processUserJoin(ctx, chatId, member, "TRACKER:new_chat_members");
      }
    } catch (error) {
      console.error("[AntiSpam] new_chat_members 兜底检测器报错:", error);
    }
  });
}
