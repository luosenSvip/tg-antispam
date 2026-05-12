import { Bot, Context } from "grammy";
import Database from "better-sqlite3";
import path from "path";

type DcTargetResult = { dcId: number; name: string; source: "user" | "chat"; link?: string };

interface KwRule {
  id: number;
  chat_id: number;
  keyword: string;
  reply_text: string;
  match_mode: "include" | "exact" | "regexp";
  case_sensitive: number;
  ignore_forward: number;
  delete_source: number;
  delay_delete: number;
  source_delay_delete: number;
  ban_seconds: number;
  restrict_seconds: number;
  enabled: number;
  created_by: number;
  created_at: string;
}

const toolDb = new Database(path.join(process.cwd(), "antispam.db"));
toolDb.pragma("journal_mode = WAL");
toolDb.exec(`
  CREATE TABLE IF NOT EXISTS kw_rules (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    chat_id INTEGER NOT NULL,
    keyword TEXT NOT NULL,
    reply_text TEXT NOT NULL,
    match_mode TEXT DEFAULT 'include',
    case_sensitive INTEGER DEFAULT 0,
    ignore_forward INTEGER DEFAULT 0,
    delete_source INTEGER DEFAULT 0,
    delay_delete INTEGER DEFAULT 0,
    source_delay_delete INTEGER DEFAULT 0,
    ban_seconds INTEGER DEFAULT 0,
    restrict_seconds INTEGER DEFAULT 0,
    enabled INTEGER DEFAULT 1,
    created_by INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_kw_rules_chat ON kw_rules(chat_id, enabled, id);
`);
try { toolDb.exec(`ALTER TABLE kw_rules ADD COLUMN match_mode TEXT DEFAULT 'include'`); } catch {}
try { toolDb.exec("ALTER TABLE kw_rules ADD COLUMN case_sensitive INTEGER DEFAULT 0"); } catch {}
try { toolDb.exec("ALTER TABLE kw_rules ADD COLUMN ignore_forward INTEGER DEFAULT 0"); } catch {}
try { toolDb.exec("ALTER TABLE kw_rules ADD COLUMN delete_source INTEGER DEFAULT 0"); } catch {}
try { toolDb.exec("ALTER TABLE kw_rules ADD COLUMN delay_delete INTEGER DEFAULT 0"); } catch {}
try { toolDb.exec("ALTER TABLE kw_rules ADD COLUMN source_delay_delete INTEGER DEFAULT 0"); } catch {}
try { toolDb.exec("ALTER TABLE kw_rules ADD COLUMN ban_seconds INTEGER DEFAULT 0"); } catch {}
try { toolDb.exec("ALTER TABLE kw_rules ADD COLUMN restrict_seconds INTEGER DEFAULT 0"); } catch {}

function esc(text: string): string {
  return (text || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function escAttr(text: string): string {
  return (text || "")
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;");
}

const ID_DATA_POINTS: [number, number][] = [
  [0, 1376438400], [50000000, 1400000000], [150000000, 1451606400],
  [350000000, 1483228800], [500000000, 1514764800], [900000000, 1559347200],
  [1100000000, 1585699200], [1450000000, 1609459200], [2150000000, 1640995200],
  [5100000000, 1654041600], [5600000000, 1672531200], [6800000000, 1704067200],
  [7800000000, 1735689600], [8500000000, 1767225600]
];

function estimateRegDate(userId: number): string {
  if (!Number.isFinite(userId) || userId <= 0) return "未知";
  let lower = ID_DATA_POINTS[0];
  let upper = ID_DATA_POINTS[ID_DATA_POINTS.length - 1];
  for (let i = 0; i < ID_DATA_POINTS.length - 1; i++) {
    const a = ID_DATA_POINTS[i];
    const b = ID_DATA_POINTS[i + 1];
    if (userId >= a[0] && userId <= b[0]) {
      lower = a;
      upper = b;
      break;
    }
  }
  const ts = lower[1] + (userId - lower[0]) * (upper[1] - lower[1]) / (upper[0] - lower[0]);
  const d = new Date(ts * 1000);
  return `${d.getFullYear()}年${d.getMonth() + 1}月`;
}

function formatUtcSqlToChina(sqlTime: string): string | null {
  const raw = (sqlTime || "").trim();
  if (!raw) return null;
  const d = new Date(raw.replace(" ", "T") + "Z");
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleString("zh-CN", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).replace(/\//g, "-");
}

function getApproxJoinedAt(chatId: number, userId: number): string | null {
  const pending = toolDb.prepare(`
    SELECT joined_at
    FROM unverified_members
    WHERE chat_id = ? AND user_id = ?
    LIMIT 1
  `).get(chatId, userId) as any;
  const fromPending = formatUtcSqlToChina(pending?.joined_at || "");
  if (fromPending) return fromPending;

  const firstPointLog = toolDb.prepare(`
    SELECT MIN(created_at) AS ts
    FROM point_logs
    WHERE chat_id = ? AND user_id = ?
  `).get(chatId, userId) as any;
  const fromPointLog = formatUtcSqlToChina(firstPointLog?.ts || "");
  if (fromPointLog) return fromPointLog;

  const firstSpamLog = toolDb.prepare(`
    SELECT MIN(created_at) AS ts
    FROM logs
    WHERE chat_id = ? AND user_id = ?
  `).get(chatId, userId) as any;
  const fromSpamLog = formatUtcSqlToChina(firstSpamLog?.ts || "");
  if (fromSpamLog) return fromSpamLog;

  const firstActiveDay = toolDb.prepare(`
    SELECT MIN(date) AS d
    FROM user_daily_messages
    WHERE chat_id = ? AND user_id = ?
  `).get(chatId, userId) as any;
  const d = String(firstActiveDay?.d || "").trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(d)) return `${d} 00:00`;

  return null;
}

function base64UrlDecode(input: string): Buffer {
  const pad = input.length % 4 === 0 ? "" : "=".repeat(4 - (input.length % 4));
  const normalized = input.replace(/-/g, "+").replace(/_/g, "/") + pad;
  return Buffer.from(normalized, "base64");
}

// Telegram file_id 使用了 RLE 压缩，先解压再读取字段。
function rleDecode(buffer: Buffer): Buffer {
  const out: number[] = [];
  for (let i = 0; i < buffer.length; i++) {
    const v = buffer[i];
    if (v === 0) {
      const count = buffer[i + 1] ?? 0;
      if (count === 0) {
        out.push(0);
      } else {
        for (let j = 0; j < count; j++) out.push(0);
      }
      i++;
      continue;
    }
    out.push(v);
  }
  return Buffer.from(out);
}

class BufferReader {
  private offset = 0;
  constructor(private readonly buf: Buffer) {}
  readInt8(): number {
    const v = this.buf.readInt8(this.offset);
    this.offset += 1;
    return v;
  }
  readInt32(): number {
    const v = this.buf.readInt32LE(this.offset);
    this.offset += 4;
    return v;
  }
}

function pickDcIdFromDecodedBuffer(buf: Buffer): number | null {
  const pushIfValid = (arr: number[], n: number) => {
    if (Number.isFinite(n) && n > 0 && n <= 20) arr.push(n);
  };
  const candidates: number[] = [];

  // 常见 file_id 结构中，前 4 字节是 type/flags，紧接着 4 字节往往是 dc_id。
  if (buf.length >= 8) {
    pushIfValid(candidates, buf.readInt32LE(4));
    pushIfValid(candidates, Number(buf.readUInt32LE(4)));
  }

  // 兼容部分历史/差异结构的兜底偏移。
  if (buf.length >= 5) {
    pushIfValid(candidates, buf.readInt32LE(1));
  }
  if (buf.length >= 9) {
    pushIfValid(candidates, buf.readInt32LE(5));
  }

  return candidates[0] ?? null;
}

// 基于 file_id 解析 dc_id（Bot API 未直接提供 dc_id 字段）
function extractDcIdFromFileId(fileId: string): number | null {
  try {
    const raw = base64UrlDecode(fileId);
    const decoded = rleDecode(raw);

    // 优先尝试 RLE 解压后的结构；失败再尝试原始缓冲区。
    const dcFromDecoded = pickDcIdFromDecodedBuffer(decoded);
    if (dcFromDecoded) return dcFromDecoded;

    return pickDcIdFromDecodedBuffer(raw);
  } catch {
    return null;
  }
}

function getUserName(u: { first_name?: string; last_name?: string; username?: string }): string {
  const full = `${u.first_name || ""}${u.last_name ? ` ${u.last_name}` : ""}`.trim();
  return full || (u.username ? `@${u.username}` : "未知用户");
}

async function isAdmin(ctx: Context, chatId: number, userId: number): Promise<boolean> {
  try {
    const member = await ctx.api.getChatMember(chatId, userId);
    return member.status === "creator" || member.status === "administrator";
  } catch {
    return false;
  }
}

async function botCanRestrictMembers(ctx: Context, chatId: number): Promise<boolean> {
  try {
    const member = await ctx.api.getChatMember(chatId, ctx.me.id);
    if (member.status === "creator") return true;
    if (member.status !== "administrator") return false;
    return Boolean(member.can_restrict_members);
  } catch {
    return false;
  }
}

function getKwRules(chatId: number): KwRule[] {
  return toolDb.prepare(`
    SELECT id, chat_id, keyword, reply_text, match_mode, case_sensitive, ignore_forward, delete_source, delay_delete, source_delay_delete, ban_seconds, restrict_seconds, enabled, created_by, created_at
    FROM kw_rules
    WHERE chat_id = ? AND enabled = 1
    ORDER BY id ASC
  `).all(chatId) as KwRule[];
}

function addKwRule(
  chatId: number,
  userId: number,
  keyword: string,
  replyText: string,
  options?: {
    matchMode?: "include" | "exact" | "regexp";
    caseSensitive?: boolean;
    ignoreForward?: boolean;
    deleteSource?: boolean;
    delayDelete?: number;
    sourceDelayDelete?: number;
    banSeconds?: number;
    restrictSeconds?: number;
  }
): number {
  const matchMode = options?.matchMode ?? "include";
  const caseSensitive = options?.caseSensitive ? 1 : 0;
  const ignoreForward = options?.ignoreForward ? 1 : 0;
  const deleteSource = options?.deleteSource ? 1 : 0;
  const delayDelete = Math.max(0, Math.floor(options?.delayDelete ?? 0));
  const sourceDelayDelete = Math.max(0, Math.floor(options?.sourceDelayDelete ?? 0));
  const banSeconds = Math.max(0, Math.floor(options?.banSeconds ?? 0));
  const restrictSeconds = Math.max(0, Math.floor(options?.restrictSeconds ?? 0));

  const result = toolDb.prepare(`
    INSERT INTO kw_rules (
      chat_id, keyword, reply_text, match_mode, case_sensitive, ignore_forward,
      delete_source, delay_delete, source_delay_delete, ban_seconds, restrict_seconds, enabled, created_by
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)
  `).run(
    chatId,
    keyword,
    replyText,
    matchMode,
    caseSensitive,
    ignoreForward,
    deleteSource,
    delayDelete,
    sourceDelayDelete,
    banSeconds,
    restrictSeconds,
    userId
  );
  return Number(result.lastInsertRowid);
}

function deleteKwRules(chatId: number, ids: number[]): number {
  if (!ids.length) return 0;
  const placeholders = ids.map(() => "?").join(",");
  const stmt = toolDb.prepare(`DELETE FROM kw_rules WHERE chat_id = ? AND id IN (${placeholders})`);
  const result = stmt.run(chatId, ...ids);
  return result.changes;
}

function clearKwRules(chatId: number): number {
  const result = toolDb.prepare("DELETE FROM kw_rules WHERE chat_id = ?").run(chatId);
  return result.changes;
}

function parseAdsDcArg(text: string): { ok: boolean; arg: string; err?: string } {
  const t = (text || "").trim();
  if (!t) return { ok: false, arg: "", err: "命令为空" };

  const patterns = [
    /^\/dc(?:@\w+)?(?:\s+(.+))?$/i,
    /^\/adsdc(?:@\w+)?(?:\s+(.+))?$/i,
    /^\/ads(?:@\w+)?\s+dc(?:\s+(.+))?$/i,
  ];
  for (const pattern of patterns) {
    const m = t.match(pattern);
    if (!m) continue;
    const raw = (m[1] || "").trim();
    const parts = raw ? raw.split(/\s+/) : [];
    if (parts.length > 1) return { ok: false, arg: "", err: "参数错误，最多只能指定一个对象" };
    return { ok: true, arg: parts[0] || "" };
  }

  return { ok: false, arg: "", err: "命令不匹配" };
}

function parseAdsIdArg(text: string): { ok: boolean; arg: string; err?: string } {
  const t = (text || "").trim();
  if (!t) return { ok: false, arg: "", err: "命令为空" };

  const patterns = [
    /^\/id(?:@\w+)?(?:\s+(.+))?$/i,
    /^\/ads(?:@\w+)?\s+id(?:\s+(.+))?$/i,
  ];
  for (const pattern of patterns) {
    const m = t.match(pattern);
    if (!m) continue;
    const raw = (m[1] || "").trim();
    const parts = raw ? raw.split(/\s+/) : [];
    if (parts.length > 1) return { ok: false, arg: "", err: "参数错误，最多只能指定一个对象" };
    return { ok: true, arg: parts[0] || "" };
  }
  return { ok: false, arg: "", err: "命令不匹配" };
}

async function resolveFromUserPhoto(ctx: Context, userId: number, name: string): Promise<DcTargetResult | null> {
  // 1) 先用 getChat(userId).photo（通常更稳定）
  try {
    const chat = await ctx.api.getChat(userId);
    if ("photo" in chat && chat.photo) {
      const fromChat = extractDcIdFromFileId(chat.photo.big_file_id || chat.photo.small_file_id);
      if (fromChat) {
        let displayName = name;
        if ("first_name" in chat && chat.first_name) {
          const full = `${chat.first_name}${"last_name" in chat && chat.last_name ? ` ${chat.last_name}` : ""}`.trim();
          if (full) displayName = full;
        }
        return { dcId: fromChat, name: displayName, source: "user", link: `tg://user?id=${userId}` };
      }
    }
  } catch {
    // 忽略并回退
  }

  // 2) 回退到 getUserProfilePhotos
  const photos = await ctx.api.getUserProfilePhotos(userId, { limit: 1 });
  if (!photos.photos.length || !photos.photos[0].length) return null;
  const best = photos.photos[0][photos.photos[0].length - 1];
  const dcId = extractDcIdFromFileId(best.file_id);
  if (!dcId) return null;
  return { dcId, name, source: "user", link: `tg://user?id=${userId}` };
}

async function resolveFromChatPhoto(ctx: Context, chatRef: number | string, fallbackName: string): Promise<DcTargetResult | null> {
  const chat = await ctx.api.getChat(chatRef);
  if (!("photo" in chat) || !chat.photo) return null;
  const dcId = extractDcIdFromFileId(chat.photo.big_file_id || chat.photo.small_file_id);
  if (!dcId) return null;

  let name = fallbackName;
  let link = "";
  if ("title" in chat && chat.title) name = chat.title;
  if ("first_name" in chat && chat.first_name) {
    const full = `${chat.first_name}${"last_name" in chat && chat.last_name ? ` ${chat.last_name}` : ""}`.trim();
    if (full) name = full;
  }
  if ("username" in chat && chat.username) {
    link = `https://t.me/${chat.username}`;
  } else if ("id" in chat && Number.isFinite(chat.id)) {
    const id = Number(chat.id);
    if (id > 0) {
      link = `tg://user?id=${id}`;
    } else {
      const s = String(id);
      if (s.startsWith("-100")) link = `https://t.me/c/${s.slice(4)}/1`;
    }
  }
  return { dcId, name, source: "chat", link };
}

function formatDcResult(target: DcTargetResult): string {
  const namePart = target.link
    ? `<a href="${escAttr(target.link)}"><b>${esc(target.name)}</b></a>`
    : `<b>${esc(target.name)}</b>`;
  return `📍 ${namePart} 所在数据中心为: <b>DC${target.dcId}</b>`;
}

async function replyDc(ctx: Context, text: string): Promise<void> {
  const sent = await ctx.reply(text, {
    parse_mode: "HTML",
    link_preview_options: { is_disabled: true },
  }).catch(() => null);
  if (!sent || !ctx.chat) return;
  const chatId = ctx.chat.id;
  const messageId = sent.message_id;
  setTimeout(() => {
    ctx.api.deleteMessage(chatId, messageId).catch(() => { });
  }, 30_000);
}

async function handleAdsDc(ctx: Context): Promise<void> {
  if (!ctx.message || !("text" in ctx.message) || !ctx.from) return;
  const parsed = parseAdsDcArg(ctx.message.text || "");
  if (!parsed.ok) {
    if (parsed.err && parsed.err !== "命令不匹配") {
      await ctx.reply(`❌ ${parsed.err}`);
    }
    return;
  }

  const arg = parsed.arg;
  try {
    // 1) 优先：回复某人消息时，查该用户
    const replyMsg = ctx.message.reply_to_message;
    if (replyMsg?.from) {
      const targetName = getUserName(replyMsg.from);
      const byUser = await resolveFromUserPhoto(ctx, replyMsg.from.id, targetName);
      if (byUser) {
        await replyDc(ctx, formatDcResult(byUser));
        return;
      }
      await replyDc(ctx, "❌ 目标用户没有可用头像，无法解析 DC。");
      return;
    }

    // 2) 指定参数：支持 user_id 或 @username
    if (arg) {
      const cleaned = arg.trim();
      const isNum = /^-?\d+$/.test(cleaned);
      if (isNum) {
        const uid = Number(cleaned);
        if (!Number.isFinite(uid)) {
          await ctx.reply("❌ 用户ID无效。");
          return;
        }
        const byUser = await resolveFromUserPhoto(ctx, uid, `用户 ${uid}`);
        if (byUser) {
          await replyDc(ctx, formatDcResult(byUser));
          return;
        }
        const byChat = await resolveFromChatPhoto(ctx, uid, `对象 ${uid}`).catch(() => null);
        if (byChat) {
          await replyDc(ctx, formatDcResult(byChat));
          return;
        }
        await replyDc(ctx, "❌ 找不到该对象，或其头像不可用，无法解析 DC。");
        return;
      }

      const uname = cleaned.startsWith("@") ? cleaned : `@${cleaned}`;
      const byChat = await resolveFromChatPhoto(ctx, uname, uname).catch(() => null);
      if (byChat) {
        await replyDc(ctx, formatDcResult(byChat));
        return;
      }
      await replyDc(ctx, "❌ 找不到该用户名，或其头像不可用，无法解析 DC。");
      return;
    }

    // 3) 无参数：群里查当前群，私聊查当前用户
    if (ctx.chat?.type === "private") {
      const byUser = await resolveFromUserPhoto(ctx, ctx.from.id, getUserName(ctx.from));
      if (byUser) {
        await replyDc(ctx, formatDcResult(byUser));
        return;
      }
      await replyDc(ctx, "❌ 当前账号没有可用头像，无法解析 DC。");
      return;
    }

    if (!ctx.chat) {
      await replyDc(ctx, "❌ 当前上下文无聊天信息。");
      return;
    }
    const byChat = await resolveFromChatPhoto(ctx, ctx.chat.id, "当前聊天");
    if (byChat) {
      await replyDc(ctx, formatDcResult(byChat));
      return;
    }
    await replyDc(ctx, "❌ 当前群组没有可用头像，无法解析 DC。");
  } catch (error) {
    const msg = String(error);
    await replyDc(ctx, `❌ DC 查询失败：${esc(msg.length > 140 ? `${msg.slice(0, 140)}...` : msg)}`);
  }
}

type IdTarget = { userId: number; user?: any };

async function resolveAdsIdTarget(ctx: Context, arg: string): Promise<IdTarget> {
  const msg = ctx.message;
  if (msg?.reply_to_message?.from) {
    return { userId: msg.reply_to_message.from.id, user: msg.reply_to_message.from };
  }

  const cleaned = (arg || "").trim();
  if (!cleaned) {
    if (!ctx.from) throw new Error("缺少用户信息");
    return { userId: ctx.from.id, user: ctx.from };
  }

  if (/^\d+$/.test(cleaned)) {
    const userId = Number(cleaned);
    if (!Number.isFinite(userId) || userId <= 0) throw new Error("用户ID无效");
    return { userId };
  }

  const uname = cleaned.startsWith("@") ? cleaned : `@${cleaned}`;
  const chat = await ctx.api.getChat(uname);
  if (!("id" in chat) || Number(chat.id) <= 0) {
    throw new Error("该对象不是可查询用户");
  }
  const user = {
    id: Number(chat.id),
    first_name: ("first_name" in chat && chat.first_name) ? chat.first_name : "",
    last_name: ("last_name" in chat && chat.last_name) ? chat.last_name : "",
    username: ("username" in chat && chat.username) ? chat.username : "",
  };
  return { userId: Number(chat.id), user };
}

async function fillTargetUser(ctx: Context, chatId: number | undefined, target: IdTarget): Promise<any> {
  if (target.user) return target.user;

  if (Number.isFinite(chatId)) {
    try {
      const member = await ctx.api.getChatMember(Number(chatId), target.userId);
      if (member?.user) return member.user;
    } catch { }
  }

  try {
    const chat = await ctx.api.getChat(target.userId);
    if ("id" in chat && Number(chat.id) > 0) {
      return {
        id: Number(chat.id),
        first_name: ("first_name" in chat && chat.first_name) ? chat.first_name : "",
        last_name: ("last_name" in chat && chat.last_name) ? chat.last_name : "",
        username: ("username" in chat && chat.username) ? chat.username : "",
      };
    }
  } catch { }

  return { id: target.userId };
}

async function handleAdsId(ctx: Context): Promise<void> {
  if (!ctx.message || !("text" in ctx.message) || !ctx.chat) return;

  const parsed = parseAdsIdArg(ctx.message.text || "");
  if (!parsed.ok) {
    if (parsed.err && parsed.err !== "命令不匹配") {
      const sent = await ctx.reply(`❌ ${parsed.err}`).catch(() => null);
      if (sent && ctx.chat) {
        setTimeout(() => {
          ctx.api.deleteMessage(ctx.chat!.id, sent.message_id).catch(() => { });
        }, 30_000);
      }
    }
    return;
  }

  try {
    const target = await resolveAdsIdTarget(ctx, parsed.arg);
    if (target.userId <= 0) {
      const sent = await ctx.reply("❌ 仅支持查询普通用户。").catch(() => null);
      if (sent && ctx.chat) {
        setTimeout(() => {
          ctx.api.deleteMessage(ctx.chat!.id, sent.message_id).catch(() => { });
        }, 30_000);
      }
      return;
    }

    const user = await fillTargetUser(ctx, ctx.chat.id, target);
    const displayName = getUserName(user);
    const usernameText = user?.username ? `@${user.username}` : "无用户名";
    const regDate = estimateRegDate(target.userId);
    const joinedAt = getApproxJoinedAt(ctx.chat.id, target.userId) || "未知";
    const dc = await resolveFromUserPhoto(ctx, target.userId, displayName).catch(() => null);
    const dcText = dc ? `DC${dc.dcId}` : "未知";

    const text = [
      `👤 <a href="tg://user?id=${target.userId}"><b>${esc(displayName)}</b></a>`,
      ``,
      `基本信息：`,
      `• 用户名：<code>${esc(usernameText)}</code>`,
      `• 用户ID：<code>${target.userId}</code>`,
      `• 群ID：<code>${ctx.chat.id}</code>`,
      `• 注册时间：<code>${regDate} (±2月)</code>`,
      `• 入群时间：<code>${joinedAt}</code>`,
      `• DC：<code>${dcText}</code>`,
    ].join("\n");

    const sent = await ctx.reply(text, { parse_mode: "HTML", link_preview_options: { is_disabled: true } }).catch(() => null);
    if (sent && ctx.chat) {
      setTimeout(() => {
        ctx.api.deleteMessage(ctx.chat!.id, sent.message_id).catch(() => { });
      }, 30_000);
    }
  } catch (error) {
    const sent = await ctx.reply(`❌ 查询失败：${esc(String(error))}`, { parse_mode: "HTML" }).catch(() => null);
    if (sent && ctx.chat) {
      setTimeout(() => {
        ctx.api.deleteMessage(ctx.chat!.id, sent.message_id).catch(() => { });
      }, 30_000);
    }
  }
}

function parseKwIds(raw: string): number[] {
  return raw
    .split(",")
    .map(s => Number(s.trim()))
    .filter(n => Number.isFinite(n) && n > 0);
}

function parseAdsKwSubCommand(text: string): string {
  const m =
    text.match(/^\/kw(?:@\w+)?(?:\s+([\s\S]+))?$/i) ||
    text.match(/^\/ads(?:@\w+)?\s+kw(?:\s+([\s\S]+))?$/i);
  return (m?.[1] || "").trim();
}

function parseTaskOptions(raw: string): {
  matchMode: "include" | "exact" | "regexp";
  caseSensitive: boolean;
  ignoreForward: boolean;
} {
  const result = {
    matchMode: "include" as "include" | "exact" | "regexp",
    caseSensitive: false,
    ignoreForward: false,
  };
  if (!raw.trim()) return result;

  for (const token of raw.trim().split(/\s+/)) {
    const t = token.trim().toLowerCase();
    if (!t) continue;
    if (t === "include") result.matchMode = "include";
    else if (t === "exact") result.matchMode = "exact";
    else if (t === "regexp") result.matchMode = "regexp";
    else if (t === "case") result.caseSensitive = true;
    else if (t === "ignore_forward") result.ignoreForward = true;
    else throw new Error(`未知匹配选项: ${token}`);
  }
  return result;
}

function parseTaskActions(raw: string): {
  deleteSource: boolean;
  banSeconds: number;
  restrictSeconds: number;
} {
  const result = {
    deleteSource: false,
    banSeconds: 0,
    restrictSeconds: 0,
  };
  if (!raw.trim()) return result;

  for (const token of raw.trim().split(/\s+/)) {
    const t = token.trim().toLowerCase();
    if (!t) continue;
    if (t === "delete") result.deleteSource = true;
    else if (t === "reply") {
      // 当前实现固定直接发送，不额外处理 reply 标志，保留兼容语法。
    } else if (t.startsWith("ban")) {
      const m = t.match(/^ban(\d+)$/);
      if (!m) throw new Error(`ban 格式无效: ${token}`);
      result.banSeconds = Math.max(0, parseInt(m[1], 10) || 0);
    } else if (t.startsWith("restrict")) {
      const m = t.match(/^restrict(\d+)$/);
      if (!m) throw new Error(`restrict 格式无效: ${token}`);
      result.restrictSeconds = Math.max(0, parseInt(m[1], 10) || 0);
    } else {
      throw new Error(`未知执行动作: ${token}`);
    }
  }
  return result;
}

function parseKwTaskFormat(sub: string): {
  keyword: string;
  replyText: string;
  matchMode: "include" | "exact" | "regexp";
  caseSensitive: boolean;
  ignoreForward: boolean;
  deleteSource: boolean;
  banSeconds: number;
  restrictSeconds: number;
  delayDelete: number;
  sourceDelayDelete: number;
} | null {
  const parts = sub.split(/\n\s*\+\+\+\s*\n/);
  if (parts.length < 2) return null;

  const keyword = (parts[0] || "").trim();
  const replyText = (parts[1] || "").trim();
  if (!keyword || !replyText) throw new Error("任务格式无效：关键词和回复内容不能为空");

  const options = parseTaskOptions(parts[2] || "");
  const actions = parseTaskActions(parts[3] || "");
  const delayDelete = Math.max(0, parseInt((parts[4] || "0").trim(), 10) || 0);
  const sourceDelayDelete = Math.max(0, parseInt((parts[5] || "0").trim(), 10) || 0);

  return {
    keyword,
    replyText,
    matchMode: options.matchMode,
    caseSensitive: options.caseSensitive,
    ignoreForward: options.ignoreForward,
    deleteSource: actions.deleteSource,
    banSeconds: actions.banSeconds,
    restrictSeconds: actions.restrictSeconds,
    delayDelete,
    sourceDelayDelete,
  };
}

async function handleAdsKw(ctx: Context): Promise<void> {
  if (!ctx.message || !("text" in ctx.message) || !ctx.chat || !ctx.from) return;
  if (ctx.chat.type === "private") {
    await ctx.reply("⚠️ 请在群组中使用此命令。");
    return;
  }

  const chatId = ctx.chat.id;
  const sub = parseAdsKwSubCommand(ctx.message.text || "");

  if (!sub || /^help$/i.test(sub)) {
    await ctx.reply(
      [
        "🔧 <b>关键词自动回复</b>",
        "",
        "<code>/kw list</code> - 查看本群规则",
        "<code>/kw add 关键词 | 回复内容</code> - 添加规则（管理员）",
        "<code>/kw add 关键词</code> + 回复一条消息 - 添加规则（管理员）",
        "<code>/kw del 1,2</code> - 删除规则（管理员）",
        "<code>/kw clear</code> - 清空本群规则（管理员）",
        "",
        "<b>高级任务格式（支持 +++）</b>",
        "<code>/kw 关键词",
        "+++",
        "回复内容",
        "+++",
        "include|exact|regexp case ignore_forward",
        "+++",
        "delete ban3600 restrict600",
        "+++",
        "回复延迟删除秒数",
        "+++",
        "原消息延迟删除秒数</code>",
        "",
        "<b>变量</b>: <code>@username</code> / <code>$mention</code> 会替换为触发用户",
      ].join("\n"),
      { parse_mode: "HTML" }
    );
    return;
  }

  if (/^list$/i.test(sub)) {
    const rows = toolDb.prepare(`
      SELECT id, keyword, reply_text, match_mode, case_sensitive, ignore_forward, delete_source, delay_delete, source_delay_delete, ban_seconds, restrict_seconds, created_at
      FROM kw_rules
      WHERE chat_id = ?
      ORDER BY id ASC
      LIMIT 200
    `).all(chatId) as Array<{
      id: number;
      keyword: string;
      reply_text: string;
      match_mode: "include" | "exact" | "regexp";
      case_sensitive: number;
      ignore_forward: number;
      delete_source: number;
      delay_delete: number;
      source_delay_delete: number;
      ban_seconds: number;
      restrict_seconds: number;
      created_at: string;
    }>;

    if (!rows.length) {
      await ctx.reply("ℹ️ 本群还没有关键词自动回复规则。");
      return;
    }

    const lines = rows.map((r) => {
      const replyPreview = r.reply_text.length > 36 ? `${r.reply_text.slice(0, 36)}...` : r.reply_text;
      const tags = [
        r.match_mode,
        r.case_sensitive ? "case" : "",
        r.ignore_forward ? "ignore_forward" : "",
        r.delete_source ? "delete" : "",
        r.ban_seconds > 0 ? `ban:${r.ban_seconds}` : "",
        r.restrict_seconds > 0 ? `restrict:${r.restrict_seconds}` : "",
        r.delay_delete > 0 ? `delay:${r.delay_delete}` : "",
        r.source_delay_delete > 0 ? `src_delay:${r.source_delay_delete}` : "",
      ].filter(Boolean).join(" ");
      return `• <code>${r.id}</code> | <b>${esc(r.keyword)}</b> → ${esc(replyPreview)}\n  <i>${esc(tags || "include")}</i>`;
    });
    await ctx.reply(`📋 <b>本群关键词规则 (${rows.length})</b>\n\n${lines.join("\n")}`, { parse_mode: "HTML" });
    return;
  }

  const admin = await isAdmin(ctx, chatId, ctx.from.id);
  if (!admin) {
    await ctx.reply("🚫 仅管理员可配置关键词自动回复。");
    return;
  }

  if (/^clear$/i.test(sub)) {
    const removed = clearKwRules(chatId);
    await ctx.reply(`✅ 已清空本群关键词规则（${removed} 条）。`);
    return;
  }

  const delMatch = sub.match(/^(?:del|rm)\s+(.+)$/i);
  if (delMatch) {
    const ids = parseKwIds(delMatch[1] || "");
    if (!ids.length) {
      await ctx.reply("❌ 参数错误。用法：<code>/kw del 1,2</code>", { parse_mode: "HTML" });
      return;
    }
    const removed = deleteKwRules(chatId, ids);
    await ctx.reply(`✅ 已删除 ${removed} 条规则。`);
    return;
  }

  const addMatch = sub.match(/^add\s+([\s\S]+)$/i);
  if (addMatch) {
    const payload = (addMatch[1] || "").trim();
    let keyword = "";
    let replyText = "";

    const splitAt = payload.indexOf("|");
    if (splitAt >= 0) {
      keyword = payload.slice(0, splitAt).trim();
      replyText = payload.slice(splitAt + 1).trim();
    } else {
      keyword = payload.trim();
      const r = ctx.message.reply_to_message;
      if (r && "text" in r && r.text) replyText = r.text.trim();
      if (!replyText && r && "caption" in r && r.caption) replyText = r.caption.trim();
    }

    if (!keyword || !replyText) {
      await ctx.reply(
        "❌ 参数不足。用法：<code>/kw add 关键词 | 回复内容</code>\n或回复一条消息后发送 <code>/kw add 关键词</code>",
        { parse_mode: "HTML" }
      );
      return;
    }
    if (keyword.length > 120) {
      await ctx.reply("❌ 关键词太长（最多120字符）。");
      return;
    }
    if (replyText.length > 1000) {
      await ctx.reply("❌ 回复内容太长（最多1000字符）。");
      return;
    }

    const id = addKwRule(chatId, ctx.from.id, keyword, replyText, { matchMode: "include" });
    await ctx.reply(`✅ 已添加关键词规则，ID: <code>${id}</code>`, { parse_mode: "HTML" });
    return;
  }

  try {
    const task = parseKwTaskFormat(sub);
    if (task) {
      if (task.keyword.length > 180) {
        await ctx.reply("❌ 关键词太长（最多180字符）。");
        return;
      }
      if (task.replyText.length > 3500) {
        await ctx.reply("❌ 回复内容太长（最多3500字符）。");
        return;
      }
      if ((task.banSeconds > 0 || task.restrictSeconds > 0) && !(await botCanRestrictMembers(ctx, chatId))) {
        await ctx.reply("❌ 该规则包含禁言/封禁动作，机器人需要管理员且具备“限制成员”权限。");
        return;
      }
      const id = addKwRule(chatId, ctx.from.id, task.keyword, task.replyText, {
        matchMode: task.matchMode,
        caseSensitive: task.caseSensitive,
        ignoreForward: task.ignoreForward,
        deleteSource: task.deleteSource,
        banSeconds: task.banSeconds,
        restrictSeconds: task.restrictSeconds,
        delayDelete: task.delayDelete,
        sourceDelayDelete: task.sourceDelayDelete,
      });
      await ctx.reply(
        `✅ 已添加高级关键词规则，ID: <code>${id}</code>\n匹配: <b>${task.matchMode}</b>${task.caseSensitive ? " case" : ""}${task.ignoreForward ? " ignore_forward" : ""}${task.deleteSource ? " delete" : ""}${task.banSeconds > 0 ? ` ban:${task.banSeconds}` : ""}${task.restrictSeconds > 0 ? ` restrict:${task.restrictSeconds}` : ""}`,
        { parse_mode: "HTML" }
      );
      return;
    }
  } catch (e) {
    await ctx.reply(`❌ 任务格式错误：${esc(String(e))}`, { parse_mode: "HTML" });
    return;
  }

  await ctx.reply("❌ 未识别的子命令。发送 <code>/kw help</code> 查看用法。", { parse_mode: "HTML" });
}

function extractMessageText(ctx: Context): string {
  const msg = ctx.message;
  if (!msg) return "";
  if ("text" in msg && msg.text) return msg.text;
  if ("caption" in msg && msg.caption) return msg.caption;
  return "";
}

function isForwardMessage(ctx: Context): boolean {
  const m = ctx.message as any;
  return !!(m?.forward_origin || m?.forward_from || m?.forward_from_chat || m?.forward_date);
}

function matchesKwRule(text: string, rule: KwRule): boolean {
  const source = rule.case_sensitive ? text : text.toLowerCase();
  const rawKeyword = rule.keyword || "";

  if (rule.match_mode === "regexp") {
    try {
      const re = new RegExp(rawKeyword, rule.case_sensitive ? "g" : "gi");
      return re.test(text);
    } catch {
      return false;
    }
  }

  const keys = rawKeyword
    .split("|")
    .map(k => k.trim())
    .filter(Boolean);

  for (const k0 of keys) {
    const k = rule.case_sensitive ? k0 : k0.toLowerCase();
    if (rule.match_mode === "exact") {
      if (source === k) return true;
    } else {
      if (source.includes(k)) return true;
    }
  }
  return false;
}

function renderKwReplyText(ctx: Context, rule: KwRule): string {
  if (!ctx.from) return rule.reply_text;

  const from = ctx.from;
  const displayName =
    `${from.first_name || ""}${from.last_name ? ` ${from.last_name}` : ""}`.trim() ||
    (from.username ? `@${from.username}` : `用户${from.id}`);
  const mention = `<a href="tg://user?id=${from.id}">${esc(displayName)}</a>`;

  let text = rule.reply_text || "";
  text = text.replace(/\$mention/g, mention);
  text = text.replace(/@username/g, mention);
  text = text.replace(/\$code_id/g, String(from.id));
  text = text.replace(/\$code_name/g, esc(displayName));
  text = text.replace(/\$delay_delete/g, rule.delay_delete > 0 ? String(rule.delay_delete) : "");
  return text;
}

function kwRuleHasPrivilegedModeration(rule: KwRule): boolean {
  return rule.ban_seconds > 0 || rule.restrict_seconds > 0;
}

async function applyKwModerationAction(ctx: Context, rule: KwRule): Promise<void> {
  if (!ctx.chat || !ctx.from) return;
  if (!kwRuleHasPrivilegedModeration(rule)) return;
  if (await isAdmin(ctx, ctx.chat.id, ctx.from.id)) return;
  if (!(await botCanRestrictMembers(ctx, ctx.chat.id))) return;

  const now = Math.floor(Date.now() / 1000);
  const targetUserId = ctx.from.id;

  if (rule.ban_seconds > 0) {
    const until = now + rule.ban_seconds;
    await ctx.api.banChatMember(ctx.chat.id, targetUserId, { until_date: until }).catch(() => { });
    return;
  }

  if (rule.restrict_seconds > 0) {
    const until = now + rule.restrict_seconds;
    await ctx.api.restrictChatMember(
      ctx.chat.id,
      targetUserId,
      { can_send_messages: false },
      { until_date: until }
    ).catch(() => { });
  }
}

export function registerAdsExtraHandlers(bot: Bot): void {
  bot.command("dc", handleAdsDc);
  bot.command("id", handleAdsId);
  bot.command("kw", handleAdsKw);

  // 兼容旧命令
  bot.command("adsdc", handleAdsDc);
  bot.hears(/^\/ads(?:@\w+)?\s+id(?:\s+.+)?$/i, handleAdsId);
  bot.hears(/^\/ads(?:@\w+)?\s+dc(?:\s+.+)?$/i, handleAdsDc);
  bot.hears(/^\/ads(?:@\w+)?\s+kw(?:\s+[\s\S]+)?$/i, handleAdsKw);

  // 关键词自动回复触发器：只做群组消息，允许命令消息参与匹配。
  bot.on("message", async (ctx, next) => {
    try {
      if (!ctx.chat || ctx.chat.type === "private" || !ctx.from) {
        await next();
        return;
      }
      if (ctx.from.is_bot) {
        await next();
        return;
      }

      const text = extractMessageText(ctx).trim();
      if (!text) {
        await next();
        return;
      }

      const rules = getKwRules(ctx.chat.id);
      let triggerUserIsAdmin: boolean | null = null;
      for (const r of rules) {
        if (r.ignore_forward && isForwardMessage(ctx)) continue;
        if (matchesKwRule(text, r)) {
          if (kwRuleHasPrivilegedModeration(r)) {
            if (triggerUserIsAdmin === null) {
              triggerUserIsAdmin = await isAdmin(ctx, ctx.chat.id, ctx.from.id);
            }
            if (triggerUserIsAdmin) continue;
          }

          const sent = await ctx.reply(renderKwReplyText(ctx, r), { parse_mode: "HTML" }).catch(() => null);
          await applyKwModerationAction(ctx, r);

          if (r.delete_source) {
            const deleteSource = async () => {
              if (!ctx.chat || !ctx.message) return;
              await ctx.api.deleteMessage(ctx.chat.id, ctx.message.message_id).catch(() => { });
            };
            if (r.source_delay_delete > 0) {
              setTimeout(() => void deleteSource(), r.source_delay_delete * 1000);
            } else {
              await deleteSource();
            }
          }

          if (r.delay_delete > 0 && sent?.message_id && ctx.chat) {
            const chatId = ctx.chat.id;
            const msgId = sent.message_id;
            setTimeout(() => {
              ctx.api.deleteMessage(chatId, msgId).catch(() => { });
            }, r.delay_delete * 1000);
          }
          break;
        }
      }
    } catch (e) {
      console.error("[Tool] 关键词自动回复执行失败:", e);
    }
    await next();
  });
}
