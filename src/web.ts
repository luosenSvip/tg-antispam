import { Bot } from "grammy";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import crypto from "node:crypto";
import * as db from "./db";
import { callAI, type AIProviderConfig } from "./ai";
import { renderMarkdownToWebHtml } from "./markdown";
import { fetchZjmfCatalog, getZjmfIntegrationStatus } from "./zjmf";

const WEB_PORT = Math.max(1, Number(process.env.WEB_PORT || 8787));
const SESSION_COOKIE = "bot_console_session";
const SESSION_TTL_DAYS = 30;
const SESSION_PROOF_HEADER = "x-console-session-proof";
const SESSION_TOKEN_HEADER = "x-console-session-token";
const HTML_PATH = path.join(process.cwd(), "web", "console.html");
const BLACKJACK_HTML_PATH = path.join(process.cwd(), "web", "blackjack.html");
const NIUNIU_HTML_PATH = path.join(process.cwd(), "web", "niuniu.html");
const USER_GUIDE_MD_PATH = path.join(process.cwd(), "docs", "subscription-console.md");
const PRO_CHAT_LIMIT = 5;
const AI_TEST_MAX_MESSAGES = 12;
const AI_TEST_MAX_MESSAGE_CHARS = 4000;

function getWebBaseUrl(): string {
  const raw = String(process.env.WEB_BASE_URL || "").trim();
  if (raw) return raw.replace(/\/$/, "");

  const webhookUrl = String(process.env.WEBHOOK_URL || "").trim();
  if (webhookUrl) {
    try {
      const parsed = new URL(webhookUrl);
      return parsed.origin;
    } catch {
      // ignore invalid WEBHOOK_URL and fall back to local URL
    }
  }

  return `http://127.0.0.1:${WEB_PORT}`;
}

function getSuperAdminUserId(): number {
  return Number(process.env.ADMIN_USER_ID || 0);
}

function isSuperAdminUser(userId: number): boolean {
  const adminId = getSuperAdminUserId();
  return adminId > 0 && userId === adminId;
}

function parseCookies(header: string | undefined): Record<string, string> {
  const cookies: Record<string, string> = {};
  for (const part of String(header || "").split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (!key) continue;
    cookies[key] = decodeURIComponent(rest.join("=") || "");
  }
  return cookies;
}

function sendJson(res: http.ServerResponse, status: number, payload: unknown, headers: Record<string, string> = {}) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    ...headers,
  });
  res.end(JSON.stringify(payload));
}

function sendHtml(res: http.ServerResponse, html: string) {
  res.writeHead(200, {
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "no-store, no-cache, must-revalidate",
    Pragma: "no-cache",
    Expires: "0",
  });
  res.end(html);
}

function sendText(res: http.ServerResponse, status: number, text: string, headers: Record<string, string> = {}) {
  res.writeHead(status, {
    "Content-Type": "text/plain; charset=utf-8",
    ...headers,
  });
  res.end(text);
}

function stringifyWelcomeButtonsSpec(buttons: unknown): string {
  if (!Array.isArray(buttons)) return "";
  return buttons
    .map((row) => {
      if (!Array.isArray(row)) return "";
      return row
        .map((button) => {
          if (!button || typeof button !== "object") return "";
          const text = String((button as any).text || "").trim();
          const url = String((button as any).url || "").trim();
          return text && url ? `${text} | ${url}` : "";
        })
        .filter(Boolean)
        .join("\n");
    })
    .filter(Boolean)
    .join("\n\n");
}

function normalizeChatRef(raw: string): string | number {
  const value = String(raw || "").trim();
  if (!value) throw new Error("请填写群组或频道标识");
  if (/^-?\d+$/.test(value)) return Number(value);
  if (/^https?:\/\/t\.me\//i.test(value)) {
    const cleaned = value.replace(/^https?:\/\/t\.me\//i, "").split(/[/?#]/)[0].trim();
    if (!cleaned) throw new Error("无法识别该 t.me 链接");
    return `@${cleaned.replace(/^@+/, "")}`;
  }
  return value.startsWith("@") ? value : `@${value.replace(/^@+/, "")}`;
}

function readConsoleHtml(): string {
  try {
    return fs.readFileSync(HTML_PATH, "utf8");
  } catch {
    return "<h1>console.html not found</h1>";
  }
}

function readBlackjackHtml(): string {
  try {
    return fs.readFileSync(BLACKJACK_HTML_PATH, "utf8");
  } catch {
    return "<h1>blackjack.html not found</h1>";
  }
}

function readNiuNiuHtml(): string {
  try {
    return fs.readFileSync(NIUNIU_HTML_PATH, "utf8");
  } catch {
    return "<h1>niuniu.html not found</h1>";
  }
}

function readUserGuideMarkdown(): string {
  try {
    return fs.readFileSync(USER_GUIDE_MD_PATH, "utf8");
  } catch {
    return "# 使用文档暂不可用\n\n请稍后再试。";
  }
}

function randomToken(size = 24): string {
  return crypto.randomBytes(size).toString("hex");
}

function hashSessionProof(proof: string): string {
  return crypto.createHash("sha256").update(String(proof || "")).digest("hex");
}

function randomLoginCode(): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789!@#$%^&*_-+=?";
  const bytes = crypto.randomBytes(16);
  let code = "";
  for (let i = 0; i < 16; i++) {
    code += alphabet[bytes[i] % alphabet.length];
  }
  return code;
}

async function readJsonBody(req: http.IncomingMessage): Promise<any> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (!raw) return {};
  return JSON.parse(raw);
}

async function readUrlEncodedBody(req: http.IncomingMessage): Promise<Record<string, string>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const raw = Buffer.concat(chunks).toString("utf8").trim();
  const params = new URLSearchParams(raw);
  const result: Record<string, string> = {};
  for (const [key, value] of params.entries()) {
    result[key] = value;
  }
  return result;
}

function getRequestClientIp(req: http.IncomingMessage): string {
  const forwarded = String(req.headers["x-forwarded-for"] || "").split(",")[0].trim();
  const remote = String(req.socket.remoteAddress || "").trim();
  const ip = forwarded || remote || "127.0.0.1";
  return ip.startsWith("::ffff:") ? ip.slice(7) : ip;
}

function detectDeviceType(req: http.IncomingMessage): "pc" | "mobile" | "qq" | "wechat" | "alipay" {
  const ua = String(req.headers["user-agent"] || "").toLowerCase();
  if (ua.includes("micromessenger")) return "wechat";
  if (ua.includes("alipayclient")) return "alipay";
  if (ua.includes(" qq/") || ua.includes("mqqbrowser")) return "qq";
  if (/iphone|ipad|android|mobile/.test(ua)) return "mobile";
  return "pc";
}

function buildXPaySign(params: Record<string, string>, key: string): string {
  const entries = Object.entries(params)
    .filter(([paramKey, value]) => paramKey !== "sign" && paramKey !== "sign_type" && String(value || "") !== "")
    .sort(([a], [b]) => a.localeCompare(b));
  const raw = entries.map(([paramKey, value]) => `${paramKey}=${value}`).join("&") + String(key || "");
  return crypto.createHash("md5").update(raw).digest("hex");
}

function verifyXPaySign(params: Record<string, string>, key: string): boolean {
  const incoming = String(params.sign || "").trim().toLowerCase();
  if (!incoming) return false;
  return buildXPaySign(params, key) === incoming;
}

function joinUrl(baseUrl: string, pathName: string): string {
  const normalizedBase = String(baseUrl || "").trim().replace(/\/$/, "");
  const normalizedPath = String(pathName || "").trim();
  if (!normalizedPath) return normalizedBase;
  return `${normalizedBase}${normalizedPath.startsWith("/") ? normalizedPath : `/${normalizedPath}`}`;
}

function normalizePathname(rawPath: string): string {
  const text = String(rawPath || "").trim();
  if (!text) return "";
  return text.startsWith("/") ? text : `/${text}`;
}

function getPaymentMethodLabel(method: string): string {
  const normalized = String(method || "").trim().toLowerCase();
  if (normalized === "alipay") return "支付宝";
  if (normalized === "wxpay") return "微信支付";
  if (normalized === "balance") return "余额支付";
  if (normalized === "manual") return "人工处理";
  return normalized || "未知方式";
}

function esc(text: string): string {
  return String(text || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

type BlackjackCardRank = "A" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9" | "10" | "J" | "Q" | "K";
type BlackjackCardSuit = "♠" | "♥" | "♦" | "♣";
type BlackjackPlayerStatus = "active" | "stood" | "busted" | "blackjack";
type BlackjackPlayerOutcome = "pending" | "win" | "lose" | "push";

type BlackjackCard = {
  rank: BlackjackCardRank;
  suit: BlackjackCardSuit;
};

type BlackjackPlayer = {
  id: number;
  name: string;
  cards: BlackjackCard[];
  status: BlackjackPlayerStatus;
  outcome: BlackjackPlayerOutcome;
};

type BlackjackRoom = {
  chatId: number;
  dealerId: number;
  dealerName: string;
  dealerCards: BlackjackCard[];
  players: BlackjackPlayer[];
  finalDealerCards: BlackjackCard[];
  finalPlayers: BlackjackPlayer[];
  phase: "lobby" | "playing" | "finished";
  dealerTurn: boolean;
  turnPlayerIndex: number;
  lastAction: string;
  resultLines: string[];
  createdAt: number;
  updatedAt: number;
};

type NiuNiuCardRank = "A" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9" | "10" | "J" | "Q" | "K";
type NiuNiuCardSuit = "♠" | "♥" | "♦" | "♣";
type NiuNiuPlayerOutcome = "pending" | "win" | "lose";
type NiuNiuHandType = "no_niu" | "niu1" | "niu2" | "niu3" | "niu4" | "niu5" | "niu6" | "niu7" | "niu8" | "niu9" | "niuniu" | "bomb" | "golden" | "five_small";

type NiuNiuCard = {
  rank: NiuNiuCardRank;
  suit: NiuNiuCardSuit;
};

type NiuNiuPlayer = {
  id: number;
  name: string;
  cards: NiuNiuCard[];
  handType: NiuNiuHandType;
  handLabel: string;
  outcome: NiuNiuPlayerOutcome;
  multiplier: number;
};

type NiuNiuRoom = {
  chatId: number;
  dealerId: number;
  dealerName: string;
  dealerCards: NiuNiuCard[];
  dealerHandType: NiuNiuHandType;
  dealerHandLabel: string;
  players: NiuNiuPlayer[];
  phase: "lobby" | "finished";
  lastAction: string;
  resultLines: string[];
  resultNotifiedAt: number;
  resultNotifyScheduledAt: number;
  createdAt: number;
  updatedAt: number;
};

const BLACKJACK_ROOM_MAX_TOTAL = 6;
const BLACKJACK_ROOM_MIN_TOTAL = 2;
const BLACKJACK_ROOM_IDLE_MS = 2 * 60 * 60 * 1000;
const BLACKJACK_LAUNCH_TOKEN_TTL_MS = 30 * 60 * 1000;
const BLACKJACK_RESULT_MESSAGE_TTL_MS = 2 * 60 * 1000;
const BLACKJACK_POINTS_STAKE = 2;
const BLACKJACK_JOIN_MIN_POINTS_INCLUSIVE = 50;
const BLACKJACK_POINTS_REASON = "游戏入账";
const BLACKJACK_RANKS: BlackjackCardRank[] = ["A", "2", "3", "4", "5", "6", "7", "8", "9", "10", "J", "Q", "K"];
const BLACKJACK_SUITS: BlackjackCardSuit[] = ["♠", "♥", "♦", "♣"];
const NIUNIU_ROOM_MAX_TOTAL = 0;
const NIUNIU_ROOM_MIN_TOTAL = 2;
const NIUNIU_ROOM_IDLE_MS = 2 * 60 * 60 * 1000;
const NIUNIU_LAUNCH_TOKEN_TTL_MS = 30 * 60 * 1000;
const NIUNIU_RESULT_MESSAGE_TTL_MS = 30 * 1000;
const NIUNIU_RESULT_NOTIFY_BASE_MS = 320;
const NIUNIU_RESULT_NOTIFY_STEP_MS = 260;
const NIUNIU_RESULT_NOTIFY_MAX_DELAY_MS = 20 * 1000;
const NIUNIU_POINTS_STAKE = 2;
const NIUNIU_POINTS_REASON = "牛牛入账";
const NIUNIU_RANKS: NiuNiuCardRank[] = ["A", "2", "3", "4", "5", "6", "7", "8", "9", "10", "J", "Q", "K"];
const NIUNIU_SUITS: NiuNiuCardSuit[] = ["♠", "♥", "♦", "♣"];

const blackjackRooms = new Map<number, BlackjackRoom>();
const blackjackLaunchMessages = new Map<number, { messageId: number; createdAt: number }>();
const blackjackPrivateEntryMessages = new Map<number, Array<{ privateChatId: number; messageId: number; createdAt: number }>>();
const blackjackConsumedLaunches = new Map<string, number>();
const niuniuRooms = new Map<number, NiuNiuRoom>();
const niuniuLaunchMessages = new Map<number, { messageId: number; createdAt: number }>();
const niuniuPrivateEntryMessages = new Map<number, Array<{ privateChatId: number; messageId: number; createdAt: number }>>();
const niuniuConsumedLaunches = new Map<string, number>();

export function registerBlackjackLaunchMessage(chatId: number, messageId: number): void {
  const safeChatId = Number(chatId);
  const safeMessageId = Number(messageId);
  if (!Number.isFinite(safeChatId) || !Number.isFinite(safeMessageId) || safeMessageId <= 0) return;
  blackjackLaunchMessages.set(safeChatId, { messageId: safeMessageId, createdAt: Date.now() });
}

export function registerBlackjackPrivateEntryMessage(chatId: number, privateChatId: number, messageId: number): void {
  const safeChatId = Number(chatId);
  const safePrivateChatId = Number(privateChatId);
  const safeMessageId = Number(messageId);
  if (!Number.isFinite(safeChatId) || !Number.isFinite(safePrivateChatId) || !Number.isFinite(safeMessageId) || safeMessageId <= 0) return;

  const rows = blackjackPrivateEntryMessages.get(safeChatId) || [];
  const filtered = rows.filter((row) => !(row.privateChatId === safePrivateChatId && row.messageId === safeMessageId));
  filtered.push({ privateChatId: safePrivateChatId, messageId: safeMessageId, createdAt: Date.now() });
  blackjackPrivateEntryMessages.set(safeChatId, filtered.slice(-50));
}

export function registerNiuNiuLaunchMessage(chatId: number, messageId: number): void {
  const safeChatId = Number(chatId);
  const safeMessageId = Number(messageId);
  if (!Number.isFinite(safeChatId) || !Number.isFinite(safeMessageId) || safeMessageId <= 0) return;
  niuniuLaunchMessages.set(safeChatId, { messageId: safeMessageId, createdAt: Date.now() });
}

export function registerNiuNiuPrivateEntryMessage(chatId: number, privateChatId: number, messageId: number): void {
  const safeChatId = Number(chatId);
  const safePrivateChatId = Number(privateChatId);
  const safeMessageId = Number(messageId);
  if (!Number.isFinite(safeChatId) || !Number.isFinite(safePrivateChatId) || !Number.isFinite(safeMessageId) || safeMessageId <= 0) return;

  const rows = niuniuPrivateEntryMessages.get(safeChatId) || [];
  const filtered = rows.filter((row) => !(row.privateChatId === safePrivateChatId && row.messageId === safeMessageId));
  filtered.push({ privateChatId: safePrivateChatId, messageId: safeMessageId, createdAt: Date.now() });
  niuniuPrivateEntryMessages.set(safeChatId, filtered.slice(-50));
}

function getBlackjackBotToken(): string {
  return String(process.env.BOT_TOKEN || "").trim();
}

function getBlackjackLaunchSig(chatId: number, dealerId: number, issuedAt: number): string {
  const token = getBlackjackBotToken();
  if (!token) return "";
  const payload = `${chatId}:${dealerId}:${issuedAt}`;
  return crypto.createHmac("sha256", token).update(payload).digest("hex").slice(0, 24);
}

function getBlackjackLaunchKey(chatId: number, dealerId: number, launchTs: number, launchSig: string): string {
  return `${Number(chatId) || 0}:${Number(dealerId) || 0}:${Number(launchTs) || 0}:${String(launchSig || "").trim().toLowerCase()}`;
}

function isBlackjackLaunchConsumed(launchInfo: { chatId: number; dealerId: number; launchTs: number; launchSig: string }): boolean {
  const key = getBlackjackLaunchKey(launchInfo.chatId, launchInfo.dealerId, launchInfo.launchTs, launchInfo.launchSig);
  return blackjackConsumedLaunches.has(key);
}

function markBlackjackLaunchConsumed(launchInfo: { chatId: number; dealerId: number; launchTs: number; launchSig: string }): void {
  const key = getBlackjackLaunchKey(launchInfo.chatId, launchInfo.dealerId, launchInfo.launchTs, launchInfo.launchSig);
  blackjackConsumedLaunches.set(key, Date.now());
}

function verifyBlackjackLaunchSig(chatId: number, dealerId: number, issuedAt: number, sig: string): boolean {
  if (!Number.isFinite(chatId) || !Number.isFinite(dealerId) || !Number.isFinite(issuedAt)) return false;
  const safeSig = String(sig || "").trim().toLowerCase();
  if (!safeSig) return false;
  if (Math.abs(Date.now() - issuedAt) > BLACKJACK_LAUNCH_TOKEN_TTL_MS) return false;

  const expected = getBlackjackLaunchSig(chatId, dealerId, issuedAt);
  if (!expected) return false;
  const expectedBuffer = Buffer.from(expected, "utf8");
  const actualBuffer = Buffer.from(safeSig, "utf8");
  if (expectedBuffer.length !== actualBuffer.length) return false;
  return crypto.timingSafeEqual(expectedBuffer, actualBuffer);
}

function getNiuNiuLaunchSig(chatId: number, dealerId: number, issuedAt: number): string {
  const token = getBlackjackBotToken();
  if (!token) return "";
  const payload = `${chatId}:${dealerId}:${issuedAt}:niuniu`;
  return crypto.createHmac("sha256", token).update(payload).digest("hex").slice(0, 24);
}

function verifyNiuNiuLaunchSig(chatId: number, dealerId: number, issuedAt: number, sig: string): boolean {
  if (!Number.isFinite(chatId) || !Number.isFinite(dealerId) || !Number.isFinite(issuedAt)) return false;
  const safeSig = String(sig || "").trim().toLowerCase();
  if (!safeSig) return false;
  if (Math.abs(Date.now() - issuedAt) > NIUNIU_LAUNCH_TOKEN_TTL_MS) return false;

  const expected = getNiuNiuLaunchSig(chatId, dealerId, issuedAt);
  if (!expected) return false;
  const expectedBuffer = Buffer.from(expected, "utf8");
  const actualBuffer = Buffer.from(safeSig, "utf8");
  if (expectedBuffer.length !== actualBuffer.length) return false;
  return crypto.timingSafeEqual(expectedBuffer, actualBuffer);
}

function getNiuNiuLaunchKey(chatId: number, dealerId: number, launchTs: number, launchSig: string): string {
  return `${Number(chatId) || 0}:${Number(dealerId) || 0}:${Number(launchTs) || 0}:${String(launchSig || "").trim().toLowerCase()}`;
}

function isNiuNiuLaunchConsumed(launchInfo: { chatId: number; dealerId: number; launchTs: number; launchSig: string }): boolean {
  const key = getNiuNiuLaunchKey(launchInfo.chatId, launchInfo.dealerId, launchInfo.launchTs, launchInfo.launchSig);
  return niuniuConsumedLaunches.has(key);
}

function markNiuNiuLaunchConsumed(launchInfo: { chatId: number; dealerId: number; launchTs: number; launchSig: string }): void {
  const key = getNiuNiuLaunchKey(launchInfo.chatId, launchInfo.dealerId, launchInfo.launchTs, launchInfo.launchSig);
  niuniuConsumedLaunches.set(key, Date.now());
}

function verifyTelegramWebAppInitData(initDataRaw: string): { ok: true; userId: number; userName: string } | { ok: false; error: string } {
  const initData = String(initDataRaw || "").trim();
  if (!initData) return { ok: false, error: "缺少 Telegram initData" };

  const token = getBlackjackBotToken();
  if (!token) return { ok: false, error: "服务器未配置 BOT_TOKEN" };

  const params = new URLSearchParams(initData);
  const hash = String(params.get("hash") || "").trim().toLowerCase();
  if (!hash) return { ok: false, error: "initData 缺少 hash" };

  params.delete("hash");
  const dataCheckString = Array.from(params.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}=${value}`)
    .join("\n");

  const secret = crypto.createHmac("sha256", "WebAppData").update(token).digest();
  const expected = crypto.createHmac("sha256", secret).update(dataCheckString).digest("hex");
  const expectedBuffer = Buffer.from(expected, "utf8");
  const actualBuffer = Buffer.from(hash, "utf8");
  if (expectedBuffer.length !== actualBuffer.length || !crypto.timingSafeEqual(expectedBuffer, actualBuffer)) {
    return { ok: false, error: "initData 校验失败" };
  }

  const authDate = Number(params.get("auth_date") || 0);
  if (!Number.isFinite(authDate) || authDate <= 0) {
    return { ok: false, error: "initData 缺少 auth_date" };
  }
  if (Math.abs(Math.floor(Date.now() / 1000) - authDate) > 86400) {
    return { ok: false, error: "initData 已过期，请重新打开小程序" };
  }

  let userId = 0;
  let userName = "Telegram 用户";
  try {
    const userRaw = String(params.get("user") || "").trim();
    const user = userRaw ? JSON.parse(userRaw) : null;
    userId = Number(user?.id || 0);
    const firstName = String(user?.first_name || "").trim();
    const lastName = String(user?.last_name || "").trim();
    const username = String(user?.username || "").trim();
    userName = [firstName, lastName].filter(Boolean).join(" ") || (username ? `@${username}` : "Telegram 用户");
  } catch {
    return { ok: false, error: "initData 用户信息解析失败" };
  }

  if (!Number.isFinite(userId) || userId <= 0) {
    return { ok: false, error: "initData 用户无效" };
  }
  return { ok: true, userId, userName };
}

async function isUserMemberOfChat(bot: Bot, chatId: number, userId: number): Promise<boolean> {
  try {
    const member = await bot.api.getChatMember(chatId, userId);
    const status = String((member as any)?.status || "").toLowerCase();
    return status !== "left" && status !== "kicked";
  } catch {
    return false;
  }
}

function drawBlackjackCard(): BlackjackCard {
  const rank = BLACKJACK_RANKS[Math.floor(Math.random() * BLACKJACK_RANKS.length)];
  const suit = BLACKJACK_SUITS[Math.floor(Math.random() * BLACKJACK_SUITS.length)];
  return { rank, suit };
}

function getBlackjackHandValue(cards: BlackjackCard[]): number {
  let total = 0;
  let aces = 0;
  for (const card of cards) {
    if (card.rank === "A") {
      total += 1;
      aces += 1;
    } else if (card.rank === "J" || card.rank === "Q" || card.rank === "K") {
      total += 10;
    } else {
      total += Number(card.rank);
    }
  }
  while (aces > 0 && total + 10 <= 21) {
    total += 10;
    aces -= 1;
  }
  return total;
}

function getUserPointsTotal(chatId: number, userId: number): number {
  return Math.max(0, Number(db.getUserPoints(chatId, userId).total || 0));
}

function hasEnoughPointsToJoinBlackjack(chatId: number, userId: number): boolean {
  return getUserPointsTotal(chatId, userId) >= BLACKJACK_JOIN_MIN_POINTS_INCLUSIVE;
}

function getBlackjackLowPointUserNames(room: BlackjackRoom): string[] {
  const rows: Array<{ id: number; name: string }> = [{ id: room.dealerId, name: room.dealerName }];
  for (const player of room.players) rows.push({ id: player.id, name: player.name });
  const unique = new Map<number, string>();
  for (const row of rows) {
    if (!unique.has(row.id)) unique.set(row.id, row.name);
  }

  const low: string[] = [];
  for (const [id, name] of unique.entries()) {
    if (getUserPointsTotal(room.chatId, id) < BLACKJACK_JOIN_MIN_POINTS_INCLUSIVE) {
      low.push(name || String(id));
    }
  }
  return low;
}

function applyBlackjackPointsSettlement(room: BlackjackRoom): string[] {
  if (!db.isPointsEnabled(room.chatId)) {
    return ["积分系统已关闭，本局未进行积分结算。"];
  }

  const deltas = new Map<number, number>();
  const names = new Map<number, string>();
  names.set(room.dealerId, room.dealerName);
  for (const player of room.players) {
    names.set(player.id, player.name);
  }

  const addDelta = (userId: number, delta: number) => {
    deltas.set(userId, Number(deltas.get(userId) || 0) + delta);
  };

  for (const player of room.players) {
    if (player.outcome === "win") {
      addDelta(player.id, BLACKJACK_POINTS_STAKE);
      addDelta(room.dealerId, -BLACKJACK_POINTS_STAKE);
      continue;
    }
    if (player.outcome === "lose") {
      addDelta(player.id, -BLACKJACK_POINTS_STAKE);
      addDelta(room.dealerId, BLACKJACK_POINTS_STAKE);
    }
  }

  const needPay = Array.from(deltas.entries()).filter(([, delta]) => delta < 0);
  const insufficient = needPay.find(([userId, delta]) => getUserPointsTotal(room.chatId, userId) < Math.abs(delta));
  if (insufficient) {
    const [userId] = insufficient;
    const who = names.get(userId) || String(userId);
    return [`积分结算失败：${who} 积分不足，已跳过本局积分结算。`];
  }

  for (const [userId, delta] of deltas.entries()) {
    if (delta < 0) {
      const ok = db.consumePoints(room.chatId, userId, Math.abs(delta), BLACKJACK_POINTS_REASON);
      if (!ok) {
        const who = names.get(userId) || String(userId);
        return [`积分结算失败：${who} 扣分失败，已停止结算。`];
      }
    }
  }
  for (const [userId, delta] of deltas.entries()) {
    if (delta > 0) {
      const ok = db.creditUserPoints(room.chatId, userId, delta, BLACKJACK_POINTS_REASON);
      if (!ok) {
        const who = names.get(userId) || String(userId);
        return [`积分结算失败：${who} 入账失败，请管理员核对积分流水。`];
      }
    }
  }

  const lines: string[] = [];
  for (const [userId, delta] of deltas.entries()) {
    if (!delta) continue;
    const who = names.get(userId) || String(userId);
    lines.push(`${who} ${delta > 0 ? `+${delta}` : String(delta)} 积分`);
  }
  if (!lines.length) return ["积分结算：本局和局，无积分变化。"];
  return [`积分结算：${lines.join("；")}。`];
}

function isBlackjack(cards: BlackjackCard[]): boolean {
  return cards.length === 2 && getBlackjackHandValue(cards) === 21;
}

function purgeExpiredBlackjackRooms(): void {
  const now = Date.now();
  for (const [chatId, room] of blackjackRooms.entries()) {
    if (now - room.updatedAt > BLACKJACK_ROOM_IDLE_MS) {
      blackjackRooms.delete(chatId);
      blackjackLaunchMessages.delete(chatId);
      blackjackPrivateEntryMessages.delete(chatId);
    }
  }

  for (const [chatId, launch] of blackjackLaunchMessages.entries()) {
    if (now - launch.createdAt > BLACKJACK_ROOM_IDLE_MS) {
      blackjackLaunchMessages.delete(chatId);
    }
  }

  for (const [chatId, rows] of blackjackPrivateEntryMessages.entries()) {
    const kept = rows.filter((row) => now - row.createdAt <= BLACKJACK_ROOM_IDLE_MS);
    if (kept.length > 0) blackjackPrivateEntryMessages.set(chatId, kept);
    else blackjackPrivateEntryMessages.delete(chatId);
  }

  for (const [key, consumedAt] of blackjackConsumedLaunches.entries()) {
    if (now - consumedAt > BLACKJACK_ROOM_IDLE_MS) {
      blackjackConsumedLaunches.delete(key);
    }
  }
}

function touchBlackjackRoom(room: BlackjackRoom): void {
  room.updatedAt = Date.now();
}

function shouldResetRoomByLaunch(room: BlackjackRoom, launchTs: number): boolean {
  const safeLaunchTs = Number(launchTs || 0);
  return Number.isFinite(safeLaunchTs) && safeLaunchTs > room.createdAt;
}

async function tryDeleteBlackjackLaunchMessage(bot: Bot, chatId: number): Promise<void> {
  const launch = blackjackLaunchMessages.get(chatId);
  blackjackLaunchMessages.delete(chatId);
  if (launch) {
    try {
      await bot.api.deleteMessage(chatId, launch.messageId);
    } catch {
      // ignore delete failures (message may already be deleted or missing permission)
    }
  }

  const privateRows = blackjackPrivateEntryMessages.get(chatId) || [];
  blackjackPrivateEntryMessages.delete(chatId);
  for (const row of privateRows) {
    try {
      await bot.api.deleteMessage(row.privateChatId, row.messageId);
    } catch {
      // ignore delete failures
    }
  }
}

function createBlackjackRoom(chatId: number, dealerId: number, dealerName: string): BlackjackRoom {
  const now = Date.now();
  const room: BlackjackRoom = {
    chatId,
    dealerId,
    dealerName,
    dealerCards: [],
    players: [],
    finalDealerCards: [],
    finalPlayers: [],
    phase: "lobby",
    dealerTurn: false,
    turnPlayerIndex: -1,
    lastAction: "房间已创建，等待玩家入座。",
    resultLines: [],
    createdAt: now,
    updatedAt: now,
  };
  blackjackRooms.set(chatId, room);
  return room;
}

function getNextActiveBlackjackPlayerIndex(room: BlackjackRoom, fromIndex: number): number {
  if (!room.players.length) return -1;
  for (let offset = 1; offset <= room.players.length; offset += 1) {
    const index = (fromIndex + offset) % room.players.length;
    if (room.players[index].status === "active") return index;
  }
  return -1;
}

function startBlackjackRound(room: BlackjackRoom): void {
  room.dealerCards = [drawBlackjackCard(), drawBlackjackCard()];
  room.finalDealerCards = [];
  room.finalPlayers = [];
  room.phase = "playing";
  room.dealerTurn = false;
  room.resultLines = [];
  for (const player of room.players) {
    player.cards = [drawBlackjackCard(), drawBlackjackCard()];
    player.status = isBlackjack(player.cards) ? "blackjack" : "active";
    player.outcome = "pending";
  }
  room.turnPlayerIndex = getNextActiveBlackjackPlayerIndex(room, -1);
  room.lastAction = room.turnPlayerIndex === -1
    ? "所有闲家已完成操作，轮到庄家手动补牌或停牌。"
    : `轮到 ${room.players[room.turnPlayerIndex].name} 操作。`;
  touchBlackjackRoom(room);
}

function settleBlackjackRound(room: BlackjackRoom): void {
  for (const player of room.players) {
    if (player.status === "active") player.status = "stood";
  }

  const dealerNatural = isBlackjack(room.dealerCards);

  const dealerValue = getBlackjackHandValue(room.dealerCards);
  const dealerBusted = dealerValue > 21;

  room.resultLines = room.players.map((player) => {
    const playerValue = getBlackjackHandValue(player.cards);
    const playerNatural = isBlackjack(player.cards);

    if (player.status === "busted") {
      player.outcome = "lose";
      return `${player.name}：${playerValue} 点，爆牌，负。`;
    }
    if (playerNatural && dealerNatural) {
      player.outcome = "push";
      return `${player.name}：Blackjack，对庄家 Blackjack，和。`;
    }
    if (playerNatural && !dealerNatural) {
      player.outcome = "win";
      return `${player.name}：Blackjack，胜。`;
    }
    if (!playerNatural && dealerNatural) {
      player.outcome = "lose";
      return `${player.name}：${playerValue} 点，庄家 Blackjack，负。`;
    }
    if (dealerBusted) {
      player.outcome = "win";
      return `${player.name}：${playerValue} 点，庄家爆牌，胜。`;
    }
    if (playerValue > dealerValue) {
      player.outcome = "win";
      return `${player.name}：${playerValue} 点，大于庄家 ${dealerValue} 点，胜。`;
    }
    if (playerValue < dealerValue) {
      player.outcome = "lose";
      return `${player.name}：${playerValue} 点，小于庄家 ${dealerValue} 点，负。`;
    }
    player.outcome = "push";
    return `${player.name}：${playerValue} 点，和庄。`;
  });

  room.resultLines.push(...applyBlackjackPointsSettlement(room));

  room.finalDealerCards = room.dealerCards.map((card) => ({ ...card }));
  room.finalPlayers = room.players.map((player) => ({
    id: player.id,
    name: player.name,
    cards: player.cards.map((card) => ({ ...card })),
    status: player.status,
    outcome: player.outcome,
  }));
  room.players = [];

  room.phase = "finished";
  room.dealerTurn = false;
  room.turnPlayerIndex = -1;
  room.lastAction = "本局已结算。";
  touchBlackjackRoom(room);
}

function settleBlackjackDealerForfeit(room: BlackjackRoom): void {
  for (const player of room.players) {
    if (player.status === "active") player.status = "stood";
    player.outcome = "win";
  }

  room.resultLines = room.players.map((player) => {
    const playerValue = getBlackjackHandValue(player.cards);
    return `${player.name}：${playerValue} 点，庄家离场通赔，胜。`;
  });
  room.resultLines.push(...applyBlackjackPointsSettlement(room));

  room.finalDealerCards = room.dealerCards.map((card) => ({ ...card }));
  room.finalPlayers = room.players.map((player) => ({
    id: player.id,
    name: player.name,
    cards: player.cards.map((card) => ({ ...card })),
    status: player.status,
    outcome: player.outcome,
  }));
  room.players = [];

  room.phase = "finished";
  room.dealerTurn = false;
  room.turnPlayerIndex = -1;
  room.lastAction = `庄家 ${room.dealerName} 中途离场，已按通赔结算。`;
  touchBlackjackRoom(room);
}

function formatBlackjackCards(cards: BlackjackCard[]): string {
  if (!Array.isArray(cards) || cards.length === 0) return "-";
  return cards.map((card) => `${card.rank}${card.suit}`).join(" ");
}

function buildBlackjackRoundResultMessage(room: BlackjackRoom): string {
  const dealerCards = room.finalDealerCards.length ? room.finalDealerCards : room.dealerCards;
  const players = room.finalPlayers.length ? room.finalPlayers : room.players;
  const dealerValue = getBlackjackHandValue(dealerCards);
  const lines = [
    "🧾 <b>21点本局结算</b>",
    `庄家：<b>${esc(room.dealerName)}</b>`,
    `庄家手牌：<code>${esc(formatBlackjackCards(dealerCards))}</code>（${dealerValue} 点）`,
    "",
    "<b>闲家手牌</b>",
    ...players.map((player) => {
      const value = getBlackjackHandValue(player.cards);
      return `• ${esc(player.name)}：<code>${esc(formatBlackjackCards(player.cards))}</code>（${value} 点）`;
    }),
    "",
    "<b>本局结果</b>",
    ...room.resultLines.map((line) => `• ${esc(line)}`),
  ];
  return lines.join("\n");
}

async function notifyBlackjackRoundFinished(bot: Bot, room: BlackjackRoom): Promise<void> {
  try {
    const sent = await bot.api.sendMessage(room.chatId, buildBlackjackRoundResultMessage(room), {
      parse_mode: "HTML",
      link_preview_options: { is_disabled: true },
    });

    const timer = setTimeout(async () => {
      try {
        await bot.api.deleteMessage(room.chatId, sent.message_id);
      } catch {
        // ignore delete failures (message may already be deleted or missing permission)
      }
    }, BLACKJACK_RESULT_MESSAGE_TTL_MS);
    if (typeof (timer as any).unref === "function") {
      (timer as any).unref();
    }
  } catch (error) {
    console.warn(`[Blackjack] 发送本局结算消息失败 chat=${room.chatId}:`, error);
  }
}

function startDealerTurn(room: BlackjackRoom): void {
  for (const player of room.players) {
    if (player.status === "blackjack") {
      player.status = "stood";
    }
  }
  room.dealerTurn = true;
  room.turnPlayerIndex = -1;
  room.lastAction = `轮到庄家 ${room.dealerName} 操作：要牌或停牌。`;
  touchBlackjackRoom(room);
}

function advanceBlackjackTurn(room: BlackjackRoom): void {
  room.turnPlayerIndex = getNextActiveBlackjackPlayerIndex(room, room.turnPlayerIndex);
  if (room.turnPlayerIndex === -1) {
    startDealerTurn(room);
    return;
  }
  room.dealerTurn = false;
  room.lastAction = `轮到 ${room.players[room.turnPlayerIndex].name} 操作。`;
  touchBlackjackRoom(room);
}

function maskDealerCards(room: BlackjackRoom, viewerUserId: number): Array<{ rank: string; suit: string; hidden: boolean }> {
  if (!room.dealerCards.length) return [];
  const viewerIsDealer = Number(viewerUserId) === Number(room.dealerId);
  if (room.phase === "playing") {
    if (viewerIsDealer) {
      return room.dealerCards.map((card) => ({ rank: card.rank, suit: card.suit, hidden: false }));
    }
    return room.dealerCards.map((card, index) => {
      if (index === 0) return { rank: card.rank, suit: card.suit, hidden: false };
      return { rank: "?", suit: "?", hidden: true };
    });
  }
  return room.dealerCards.map((card) => ({ rank: card.rank, suit: card.suit, hidden: false }));
}

function getDealerPointsText(room: BlackjackRoom, viewerUserId: number): string {
  if (!room.dealerCards.length) return "--";
  const viewerIsDealer = Number(viewerUserId) === Number(room.dealerId);
  if (room.phase === "playing") {
    if (viewerIsDealer) {
      return String(getBlackjackHandValue(room.dealerCards));
    }
    return `${getBlackjackHandValue([room.dealerCards[0]])}+?`;
  }
  return String(getBlackjackHandValue(room.dealerCards));
}

function buildBlackjackStatePayload(
  room: BlackjackRoom | null,
  viewer: { id: number; name: string },
  launchInfo: { chatId: number; dealerId: number; launchTs: number; launchSig: string }
) {
  const launchValid =
    verifyBlackjackLaunchSig(launchInfo.chatId, launchInfo.dealerId, launchInfo.launchTs, launchInfo.launchSig)
    && !isBlackjackLaunchConsumed(launchInfo);
  const isDealer = room ? viewer.id === room.dealerId : launchValid && viewer.id === launchInfo.dealerId;
  const joinedIndex = room ? room.players.findIndex((player) => player.id === viewer.id) : -1;
  const isJoined = joinedIndex >= 0;
  const pointsEnabled = db.isPointsEnabled(launchInfo.chatId);
  const viewerPoints = viewer.id > 0 ? getUserPointsTotal(launchInfo.chatId, viewer.id) : 0;
  const viewerEnoughToJoin = viewer.id > 0 ? hasEnoughPointsToJoinBlackjack(launchInfo.chatId, viewer.id) : false;
  const lowPointUserNames = room && pointsEnabled ? getBlackjackLowPointUserNames(room) : [];
  const currentTurnPlayerId = room && room.phase === "playing"
    ? (room.dealerTurn ? room.dealerId : (room.turnPlayerIndex >= 0 ? room.players[room.turnPlayerIndex]?.id || 0 : 0))
    : 0;
  const isCurrentTurn = Boolean(currentTurnPlayerId && currentTurnPlayerId === viewer.id);

  const maxPlayers = BLACKJACK_ROOM_MAX_TOTAL - 1;
  const displayDealerCards = room
    ? ((room.phase === "finished" && room.finalDealerCards.length)
        ? room.finalDealerCards
        : room.dealerCards)
    : [];
  const displayPlayers = room
    ? ((room.phase === "finished" && room.finalPlayers.length)
        ? room.finalPlayers
        : room.players)
    : [];

  return {
    stateKey: room
      ? `${room.updatedAt}|${room.phase}|${room.dealerTurn ? 1 : 0}|${room.turnPlayerIndex}|${viewer.id}|${pointsEnabled ? 1 : 0}|${viewer.id > 0 ? viewerPoints : "-"}|${lowPointUserNames.join(",")}`
      : `none|${launchInfo.chatId}|${launchInfo.dealerId}|${launchInfo.launchTs}|${viewer.id}|${pointsEnabled ? 1 : 0}|${viewer.id > 0 ? viewerPoints : "-"}`,
    roomExists: Boolean(room),
    chatId: launchInfo.chatId,
    phase: room?.phase || "none",
    launch: {
      dealerId: launchInfo.dealerId,
      launchValid,
    },
    limits: {
      minTotal: BLACKJACK_ROOM_MIN_TOTAL,
      maxTotal: BLACKJACK_ROOM_MAX_TOTAL,
      maxPlayers,
    },
    requirements: {
      points: {
        enabled: pointsEnabled,
        stake: BLACKJACK_POINTS_STAKE,
        joinMinInclusive: BLACKJACK_JOIN_MIN_POINTS_INCLUSIVE,
        reason: BLACKJACK_POINTS_REASON,
        viewerPoints: viewer.id > 0 ? viewerPoints : null,
        viewerEnoughToJoin: viewer.id > 0 ? viewerEnoughToJoin : false,
        lowPointUsers: lowPointUserNames,
      },
    },
    viewer: {
      id: viewer.id,
      name: viewer.name,
      authenticated: viewer.id > 0,
      isDealer,
      isJoined,
      isCurrentTurn,
    },
    actions: {
      canCreate: !room && isDealer && launchValid && pointsEnabled && viewerEnoughToJoin,
      canJoin: Boolean(room && room.phase === "lobby" && !isDealer && !isJoined && room.players.length < maxPlayers && pointsEnabled && viewerEnoughToJoin),
      canLeave: Boolean(room && room.phase === "lobby" && isJoined),
      canStart: Boolean(room && room.phase === "lobby" && isDealer && room.players.length >= 1 && pointsEnabled && lowPointUserNames.length === 0),
      canHit: Boolean(
        room && room.phase === "playing" &&
        ((!room.dealerTurn && isCurrentTurn) || (room.dealerTurn && isDealer))
      ),
      canStand: Boolean(
        room && room.phase === "playing" &&
        ((!room.dealerTurn && isCurrentTurn) || (room.dealerTurn && isDealer))
      ),
      canClose: Boolean(room && isDealer && room.phase !== "playing"),
      canRestart: Boolean(room && room.phase === "finished" && isDealer && pointsEnabled && viewerEnoughToJoin),
    },
    room: room
      ? {
          dealer: {
            id: room.dealerId,
            name: room.dealerName,
            cards: room.phase === "finished"
              ? displayDealerCards.map((card) => ({ rank: card.rank, suit: card.suit, hidden: false }))
              : maskDealerCards(room, viewer.id),
            pointsText: room.phase === "finished"
              ? String(getBlackjackHandValue(displayDealerCards))
              : getDealerPointsText(room, viewer.id),
          },
          players: displayPlayers.map((player) => {
            const revealPlayerDetail = room.phase === "finished" || player.id === viewer.id;
            return {
              id: player.id,
              name: player.name,
              cards: revealPlayerDetail
                ? player.cards.map((card) => ({ rank: card.rank, suit: card.suit, hidden: false }))
                : player.cards.map((card, index) => (
                    index === 1
                      ? { rank: "?", suit: "?", hidden: true }
                      : { rank: card.rank, suit: card.suit, hidden: false }
                  )),
              points: revealPlayerDetail
                ? (player.cards.length ? getBlackjackHandValue(player.cards) : 0)
                : "?",
              status: player.status,
              outcome: player.outcome,
            };
          }),
          currentTurnPlayerId,
          dealerTurn: room.dealerTurn,
          lastAction: room.lastAction,
          resultLines: room.resultLines,
          createdAt: room.createdAt,
          updatedAt: room.updatedAt,
        }
      : null,
  };
}

function drawNiuNiuCard(): NiuNiuCard {
  const rank = NIUNIU_RANKS[Math.floor(Math.random() * NIUNIU_RANKS.length)];
  const suit = NIUNIU_SUITS[Math.floor(Math.random() * NIUNIU_SUITS.length)];
  return { rank, suit };
}

function getNiuNiuCardPoint(card: NiuNiuCard): number {
  if (card.rank === "A") return 1;
  if (card.rank === "J" || card.rank === "Q" || card.rank === "K" || card.rank === "10") return 10;
  return Number(card.rank);
}

function getNiuNiuFiveCardValue(cards: NiuNiuCard[]): number {
  return cards.reduce((sum, card) => sum + getNiuNiuCardPoint(card), 0);
}

function isNiuNiuFiveSmall(cards: NiuNiuCard[]): boolean {
  if (cards.length !== 5) return false;
  return cards.every((card) => getNiuNiuCardPoint(card) <= 4) && getNiuNiuFiveCardValue(cards) <= 10;
}

function isNiuNiuGolden(cards: NiuNiuCard[]): boolean {
  if (cards.length !== 5) return false;
  return cards.every((card) => card.rank === "J" || card.rank === "Q" || card.rank === "K");
}

function isNiuNiuBomb(cards: NiuNiuCard[]): boolean {
  if (cards.length !== 5) return false;
  const counts = new Map<NiuNiuCardRank, number>();
  for (const card of cards) {
    counts.set(card.rank, Number(counts.get(card.rank) || 0) + 1);
  }
  return Array.from(counts.values()).some((count) => count === 4);
}

function getNiuNiuPointValue(cards: NiuNiuCard[]): number {
  if (cards.length !== 5) return 0;
  const points = cards.map((card) => getNiuNiuCardPoint(card));
  const total = points.reduce((sum, value) => sum + value, 0);
  let best = 0;
  for (let i = 0; i < points.length; i += 1) {
    for (let j = i + 1; j < points.length; j += 1) {
      for (let k = j + 1; k < points.length; k += 1) {
        const tri = points[i] + points[j] + points[k];
        if (tri % 10 !== 0) continue;
        const rest = (total - tri) % 10;
        const value = rest === 0 ? 10 : rest;
        if (value > best) best = value;
      }
    }
  }
  return best;
}

function evaluateNiuNiuHand(cards: NiuNiuCard[]): { type: NiuNiuHandType; label: string; multiplier: number } {
  if (isNiuNiuFiveSmall(cards)) {
    return { type: "five_small", label: "五小牛", multiplier: 7 };
  }
  if (isNiuNiuGolden(cards)) {
    return { type: "golden", label: "金花牛", multiplier: 6 };
  }
  if (isNiuNiuBomb(cards)) {
    return { type: "bomb", label: "炸弹牛", multiplier: 5 };
  }

  const niuValue = getNiuNiuPointValue(cards);
  if (niuValue === 10) {
    return { type: "niuniu", label: "牛牛", multiplier: 4 };
  }
  if (niuValue === 9) {
    return { type: "niu9", label: "牛九", multiplier: 3 };
  }
  if (niuValue === 8) {
    return { type: "niu8", label: "牛八", multiplier: 2 };
  }
  if (niuValue >= 1 && niuValue <= 7) {
    return { type: `niu${niuValue}` as NiuNiuHandType, label: `牛${niuValue}`, multiplier: 1 };
  }
  return { type: "no_niu", label: "无牛", multiplier: 1 };
}

function getNiuNiuTypeWeight(type: NiuNiuHandType): number {
  if (type === "five_small") return 13;
  if (type === "golden") return 12;
  if (type === "bomb") return 11;
  if (type === "niuniu") return 10;
  if (type === "niu9") return 9;
  if (type === "niu8") return 8;
  if (type === "niu7") return 7;
  if (type === "niu6") return 6;
  if (type === "niu5") return 5;
  if (type === "niu4") return 4;
  if (type === "niu3") return 3;
  if (type === "niu2") return 2;
  if (type === "niu1") return 1;
  return 0;
}

function getNiuNiuCardRankWeight(card: NiuNiuCard): number {
  if (card.rank === "A") return 1;
  if (card.rank === "J") return 11;
  if (card.rank === "Q") return 12;
  if (card.rank === "K") return 13;
  return Number(card.rank);
}

function getNiuNiuCardSuitWeight(card: NiuNiuCard): number {
  if (card.suit === "♠") return 4;
  if (card.suit === "♥") return 3;
  if (card.suit === "♣") return 2;
  return 1; // ♦
}

function getNiuNiuTopCard(cards: NiuNiuCard[]): { rankWeight: number; suitWeight: number } {
  let topRankWeight = 0;
  let topSuitWeight = 0;
  for (const card of cards) {
    const rankWeight = getNiuNiuCardRankWeight(card);
    const suitWeight = getNiuNiuCardSuitWeight(card);
    if (rankWeight > topRankWeight) {
      topRankWeight = rankWeight;
      topSuitWeight = suitWeight;
      continue;
    }
    if (rankWeight === topRankWeight && suitWeight > topSuitWeight) {
      topSuitWeight = suitWeight;
    }
  }
  return { rankWeight: topRankWeight, suitWeight: topSuitWeight };
}

function getNiuNiuMaxRankWeight(cards: NiuNiuCard[]): number {
  let max = 0;
  for (const card of cards) {
    const rankWeight = getNiuNiuCardRankWeight(card);
    if (rankWeight > max) max = rankWeight;
  }
  return max;
}

function isNiuNiuMaxCardBelowTen(cards: NiuNiuCard[]): boolean {
  return getNiuNiuMaxRankWeight(cards) < 10;
}

function decideNiuNiuWinner(
  playerCards: NiuNiuCard[],
  playerEval: { type: NiuNiuHandType; label: string; multiplier: number },
  dealerCards: NiuNiuCard[],
  dealerEval: { type: NiuNiuHandType; label: string; multiplier: number }
): "player" | "dealer" {
  if (
    playerEval.type === "no_niu" &&
    dealerEval.type === "no_niu" &&
    isNiuNiuMaxCardBelowTen(playerCards) &&
    isNiuNiuMaxCardBelowTen(dealerCards)
  ) {
    return "dealer";
  }

  const playerWeight = getNiuNiuTypeWeight(playerEval.type);
  const dealerWeight = getNiuNiuTypeWeight(dealerEval.type);
  if (playerWeight > dealerWeight) return "player";
  if (playerWeight < dealerWeight) return "dealer";

  const playerTop = getNiuNiuTopCard(playerCards);
  const dealerTop = getNiuNiuTopCard(dealerCards);
  if (playerTop.rankWeight > dealerTop.rankWeight) return "player";
  if (playerTop.rankWeight < dealerTop.rankWeight) return "dealer";
  if (playerTop.suitWeight > dealerTop.suitWeight) return "player";
  if (playerTop.suitWeight < dealerTop.suitWeight) return "dealer";

  return "dealer";
}

function createNiuNiuRoom(chatId: number, dealerId: number, dealerName: string): NiuNiuRoom {
  const now = Date.now();
  const room: NiuNiuRoom = {
    chatId,
    dealerId,
    dealerName,
    dealerCards: [],
    dealerHandType: "no_niu",
    dealerHandLabel: "--",
    players: [],
    phase: "lobby",
    lastAction: "房间已创建，等待玩家入座。",
    resultLines: [],
    resultNotifiedAt: 0,
    resultNotifyScheduledAt: 0,
    createdAt: now,
    updatedAt: now,
  };
  niuniuRooms.set(chatId, room);
  return room;
}

function touchNiuNiuRoom(room: NiuNiuRoom): void {
  room.updatedAt = Date.now();
}

function shouldResetNiuNiuRoomByLaunch(room: NiuNiuRoom, launchTs: number): boolean {
  const safeLaunchTs = Number(launchTs || 0);
  return Number.isFinite(safeLaunchTs) && safeLaunchTs > room.createdAt;
}

function getNiuNiuLowPointUserNames(room: NiuNiuRoom): string[] {
  const rows: Array<{ id: number; name: string }> = [{ id: room.dealerId, name: room.dealerName }];
  for (const player of room.players) rows.push({ id: player.id, name: player.name });
  const unique = new Map<number, string>();
  for (const row of rows) {
    if (!unique.has(row.id)) unique.set(row.id, row.name);
  }

  const low: string[] = [];
  for (const [id, name] of unique.entries()) {
    if (!hasEnoughPointsToJoinBlackjack(room.chatId, id)) {
      low.push(name || String(id));
    }
  }
  return low;
}

function applyNiuNiuPointsSettlement(room: NiuNiuRoom): string[] {
  if (!db.isPointsEnabled(room.chatId)) {
    return ["积分系统已关闭，本局未进行积分结算。"];
  }

  const deltas = new Map<number, number>();
  const names = new Map<number, string>();
  names.set(room.dealerId, room.dealerName);
  for (const player of room.players) {
    names.set(player.id, player.name);
  }

  const addDelta = (userId: number, delta: number) => {
    deltas.set(userId, Number(deltas.get(userId) || 0) + delta);
  };

  for (const player of room.players) {
    const loseAmount = NIUNIU_POINTS_STAKE * Math.max(1, Number(player.multiplier || 1));
    const winAmount = NIUNIU_POINTS_STAKE * Math.max(1, Number(player.multiplier || 1));
    if (player.outcome === "win") {
      addDelta(player.id, winAmount);
      addDelta(room.dealerId, -winAmount);
    } else if (player.outcome === "lose") {
      addDelta(player.id, -loseAmount);
      addDelta(room.dealerId, loseAmount);
    }
  }

  const needPay = Array.from(deltas.entries()).filter(([, delta]) => delta < 0);
  const insufficient = needPay.find(([userId, delta]) => getUserPointsTotal(room.chatId, userId) < Math.abs(delta));
  if (insufficient) {
    const [userId] = insufficient;
    const who = names.get(userId) || String(userId);
    return [`积分结算失败：${who} 积分不足，已跳过本局积分结算。`];
  }

  for (const [userId, delta] of deltas.entries()) {
    if (delta < 0) {
      const ok = db.consumePoints(room.chatId, userId, Math.abs(delta), NIUNIU_POINTS_REASON);
      if (!ok) {
        const who = names.get(userId) || String(userId);
        return [`积分结算失败：${who} 扣分失败，已停止结算。`];
      }
    }
  }
  for (const [userId, delta] of deltas.entries()) {
    if (delta > 0) {
      const ok = db.creditUserPoints(room.chatId, userId, delta, NIUNIU_POINTS_REASON);
      if (!ok) {
        const who = names.get(userId) || String(userId);
        return [`积分结算失败：${who} 入账失败，请管理员核对积分流水。`];
      }
    }
  }

  const lines: string[] = [];
  for (const [userId, delta] of deltas.entries()) {
    if (!delta) continue;
    const who = names.get(userId) || String(userId);
    lines.push(`${who} ${delta > 0 ? `+${delta}` : String(delta)} 积分`);
  }
  if (!lines.length) return ["积分结算：本局无积分变化。"];
  return [`积分结算：${lines.join("；")}。`];
}

function startNiuNiuRound(room: NiuNiuRoom): void {
  room.resultNotifiedAt = 0;
  room.resultNotifyScheduledAt = 0;
  room.dealerCards = [drawNiuNiuCard(), drawNiuNiuCard(), drawNiuNiuCard(), drawNiuNiuCard(), drawNiuNiuCard()];
  const dealerEval = evaluateNiuNiuHand(room.dealerCards);
  room.dealerHandType = dealerEval.type;
  room.dealerHandLabel = dealerEval.label;

  room.resultLines = [];
  for (const player of room.players) {
    player.cards = [drawNiuNiuCard(), drawNiuNiuCard(), drawNiuNiuCard(), drawNiuNiuCard(), drawNiuNiuCard()];
    const evaluated = evaluateNiuNiuHand(player.cards);
    player.handType = evaluated.type;
    player.handLabel = evaluated.label;
    const winner = decideNiuNiuWinner(player.cards, evaluated, room.dealerCards, dealerEval);
    if (winner === "player") {
      player.outcome = "win";
      player.multiplier = Math.max(1, evaluated.multiplier);
      room.resultLines.push(`${player.name}：${player.handLabel}，胜（x${player.multiplier}）。`);
    } else {
      player.outcome = "lose";
      player.multiplier = Math.max(1, dealerEval.multiplier);
      if (
        evaluated.type === "no_niu" &&
        dealerEval.type === "no_niu" &&
        isNiuNiuMaxCardBelowTen(player.cards) &&
        isNiuNiuMaxCardBelowTen(room.dealerCards)
      ) {
        room.resultLines.push(`${player.name}：双方无牛且最大牌小于 10，庄家默认胜。`);
      } else {
        room.resultLines.push(`${player.name}：${player.handLabel}，庄家${dealerEval.label}胜（x${player.multiplier}）。`);
      }
    }
  }
  room.resultLines.push(...applyNiuNiuPointsSettlement(room));
  room.phase = "finished";
  room.lastAction = "本局已结算，庄家可选择再来一局。";
  touchNiuNiuRoom(room);
}

function purgeExpiredNiuNiuRooms(): void {
  const now = Date.now();
  for (const [chatId, room] of niuniuRooms.entries()) {
    if (now - room.updatedAt > NIUNIU_ROOM_IDLE_MS) {
      niuniuRooms.delete(chatId);
      niuniuLaunchMessages.delete(chatId);
      niuniuPrivateEntryMessages.delete(chatId);
    }
  }
  for (const [chatId, launch] of niuniuLaunchMessages.entries()) {
    if (now - launch.createdAt > NIUNIU_ROOM_IDLE_MS) {
      niuniuLaunchMessages.delete(chatId);
    }
  }
  for (const [chatId, rows] of niuniuPrivateEntryMessages.entries()) {
    const kept = rows.filter((row) => now - row.createdAt <= NIUNIU_ROOM_IDLE_MS);
    if (kept.length > 0) niuniuPrivateEntryMessages.set(chatId, kept);
    else niuniuPrivateEntryMessages.delete(chatId);
  }

  for (const [key, consumedAt] of niuniuConsumedLaunches.entries()) {
    if (now - consumedAt > NIUNIU_ROOM_IDLE_MS) {
      niuniuConsumedLaunches.delete(key);
    }
  }
}

async function tryDeleteNiuNiuLaunchMessage(bot: Bot, chatId: number): Promise<void> {
  const launch = niuniuLaunchMessages.get(chatId);
  niuniuLaunchMessages.delete(chatId);
  if (launch) {
    try {
      await bot.api.deleteMessage(chatId, launch.messageId);
    } catch {
      // ignore delete failures
    }
  }

  const privateRows = niuniuPrivateEntryMessages.get(chatId) || [];
  niuniuPrivateEntryMessages.delete(chatId);
  for (const row of privateRows) {
    try {
      await bot.api.deleteMessage(row.privateChatId, row.messageId);
    } catch {
      // ignore delete failures
    }
  }
}

function formatNiuNiuCards(cards: NiuNiuCard[]): string {
  if (!Array.isArray(cards) || cards.length === 0) return "-";
  return cards.map((card) => `${card.rank}${card.suit}`).join(" ");
}

function buildNiuNiuRoundResultMessage(room: NiuNiuRoom): string {
  const lines = [
    "🐮 <b>牛牛本局结算</b>",
    `庄家：<b>${esc(room.dealerName)}</b>`,
    `庄家手牌：<code>${esc(formatNiuNiuCards(room.dealerCards))}</code>（${esc(room.dealerHandLabel)}）`,
    "",
    "<b>闲家手牌</b>",
    ...room.players.map((player) => {
      return `• ${esc(player.name)}：<code>${esc(formatNiuNiuCards(player.cards))}</code>（${esc(player.handLabel)}）`;
    }),
    "",
    "<b>本局结果</b>",
    ...room.resultLines.map((line) => `• ${esc(line)}`),
  ];
  return lines.join("\n");
}

async function notifyNiuNiuRoundFinished(bot: Bot, room: NiuNiuRoom): Promise<void> {
  if (room.resultNotifiedAt > 0 || room.resultNotifyScheduledAt > 0) return;
  room.resultNotifyScheduledAt = Date.now();

  const participants = 1 + Math.max(0, Number(room.players.length || 0));
  const estimatedDelay = NIUNIU_RESULT_NOTIFY_BASE_MS + participants * 5 * NIUNIU_RESULT_NOTIFY_STEP_MS + 300;
  const notifyDelayMs = Math.min(NIUNIU_RESULT_NOTIFY_MAX_DELAY_MS, Math.max(1500, estimatedDelay));

  const timer = setTimeout(async () => {
    try {
      if (room.phase !== "finished") return;
      const sent = await bot.api.sendMessage(room.chatId, buildNiuNiuRoundResultMessage(room), {
        parse_mode: "HTML",
        link_preview_options: { is_disabled: true },
      });
      room.resultNotifiedAt = Date.now();

      const deleteTimer = setTimeout(async () => {
        try {
          await bot.api.deleteMessage(room.chatId, sent.message_id);
        } catch {
          // ignore delete failures
        }
      }, NIUNIU_RESULT_MESSAGE_TTL_MS);
      if (typeof (deleteTimer as any).unref === "function") {
        (deleteTimer as any).unref();
      }
    } catch (error) {
      console.warn(`[NiuNiu] 发送本局结算消息失败 chat=${room.chatId}:`, error);
    } finally {
      room.resultNotifyScheduledAt = 0;
    }
  }, notifyDelayMs);
  if (typeof (timer as any).unref === "function") {
    (timer as any).unref();
  }
}

function buildNiuNiuStatePayload(
  room: NiuNiuRoom | null,
  viewer: { id: number; name: string },
  launchInfo: { chatId: number; dealerId: number; launchTs: number; launchSig: string }
) {
  const launchValid =
    verifyNiuNiuLaunchSig(launchInfo.chatId, launchInfo.dealerId, launchInfo.launchTs, launchInfo.launchSig)
    && !isNiuNiuLaunchConsumed(launchInfo);
  const isDealer = room ? viewer.id === room.dealerId : launchValid && viewer.id === launchInfo.dealerId;
  const joinedIndex = room ? room.players.findIndex((player) => player.id === viewer.id) : -1;
  const isJoined = joinedIndex >= 0;
  const pointsEnabled = db.isPointsEnabled(launchInfo.chatId);
  const viewerPoints = viewer.id > 0 ? getUserPointsTotal(launchInfo.chatId, viewer.id) : 0;
  const viewerEnoughToJoin = viewer.id > 0 ? hasEnoughPointsToJoinBlackjack(launchInfo.chatId, viewer.id) : false;
  const lowPointUserNames = room && pointsEnabled ? getNiuNiuLowPointUserNames(room) : [];
  return {
    stateKey: room
      ? `${room.updatedAt}|${room.phase}|${viewer.id}|${pointsEnabled ? 1 : 0}|${viewer.id > 0 ? viewerPoints : "-"}|${lowPointUserNames.join(",")}`
      : `none|${launchInfo.chatId}|${launchInfo.dealerId}|${launchInfo.launchTs}|${viewer.id}|${pointsEnabled ? 1 : 0}|${viewer.id > 0 ? viewerPoints : "-"}`,
    roomExists: Boolean(room),
    chatId: launchInfo.chatId,
    phase: room?.phase || "none",
    launch: {
      dealerId: launchInfo.dealerId,
      launchValid,
    },
    limits: {
      minTotal: NIUNIU_ROOM_MIN_TOTAL,
      maxTotal: NIUNIU_ROOM_MAX_TOTAL,
      maxPlayers: NIUNIU_ROOM_MAX_TOTAL,
    },
    requirements: {
      points: {
        enabled: pointsEnabled,
        stake: NIUNIU_POINTS_STAKE,
        joinMinInclusive: BLACKJACK_JOIN_MIN_POINTS_INCLUSIVE,
        reason: NIUNIU_POINTS_REASON,
        viewerPoints: viewer.id > 0 ? viewerPoints : null,
        viewerEnoughToJoin: viewer.id > 0 ? viewerEnoughToJoin : false,
        lowPointUsers: lowPointUserNames,
      },
    },
    viewer: {
      id: viewer.id,
      name: viewer.name,
      authenticated: viewer.id > 0,
      isDealer,
      isJoined,
      isCurrentTurn: false,
    },
    actions: {
      canCreate: !room && isDealer && launchValid && pointsEnabled && viewerEnoughToJoin,
      canJoin: Boolean(room && room.phase === "lobby" && !isDealer && !isJoined && pointsEnabled && viewerEnoughToJoin),
      canLeave: Boolean(room && room.phase === "lobby" && isJoined),
      canStart: Boolean(room && room.phase === "lobby" && isDealer && room.players.length >= 1 && pointsEnabled && lowPointUserNames.length === 0),
      canHit: false,
      canStand: false,
      canClose: Boolean(room && isDealer),
      canRestart: Boolean(room && room.phase === "finished" && isDealer && pointsEnabled && viewerEnoughToJoin),
    },
    room: room
      ? {
          dealer: {
            id: room.dealerId,
            name: room.dealerName,
            cards: room.phase === "finished"
              ? room.dealerCards.map((card) => ({ rank: card.rank, suit: card.suit, hidden: false }))
              : [],
            pointsText: room.phase === "finished" ? String(getNiuNiuFiveCardValue(room.dealerCards)) : "--",
            handLabel: room.phase === "finished" ? room.dealerHandLabel : "--",
          },
          players: room.players.map((player) => ({
            id: player.id,
            name: player.name,
            cards: room.phase === "finished"
              ? player.cards.map((card) => ({ rank: card.rank, suit: card.suit, hidden: false }))
              : [],
            points: room.phase === "finished" ? getNiuNiuFiveCardValue(player.cards) : "?",
            status: room.phase === "finished" ? (player.outcome === "win" ? "已结算" : "已结算") : "等待开局",
            outcome: room.phase === "finished" ? player.outcome : "pending",
            handLabel: room.phase === "finished" ? player.handLabel : "--",
            multiplier: room.phase === "finished" ? player.multiplier : 0,
          })),
          currentTurnPlayerId: 0,
          dealerTurn: false,
          lastAction: room.lastAction,
          resultLines: room.resultLines,
          createdAt: room.createdAt,
          updatedAt: room.updatedAt,
        }
      : null,
  };
}

async function notifyPointsMallShelfChange(
  bot: Bot,
  chatId: number,
  item: db.CommercialPointsMallItem,
  action: "up" | "down",
  reason: string
): Promise<void> {
  const sceneLabel = item.promo_scene === "renew" ? "续费商品" : "新购商品";
  const stockLabel = item.stock_enabled ? `<code>${Math.max(0, Number(item.stock || 0))}</code>` : "不限";
  const lines = [
    action === "up" ? "🛍️ <b>积分商城上架</b>" : "📦 <b>积分商城下架</b>",
    `商品名称: <b>${esc(item.title || `商品 #${item.id}`)}</b>`,
    `商品类型: ${sceneLabel}`,
    action === "up" ? `兑换积分: <code>${Math.max(0, Number(item.points_cost || 0))}</code>` : `下架原因: ${esc(reason)}`,
    action === "up" ? `库存状态: ${stockLabel}` : "当前状态: 已下架",
    action === "up" ? "发送 <code>/shop</code> 可前往积分商城查看并兑换。" : "",
  ];
  await bot.api.sendMessage(chatId, lines.join("\n"), { parse_mode: "HTML" }).catch((error) => {
    console.warn(`[WebShop] 发送商品${action === "up" ? "上架" : "下架"}通知失败 chat=${chatId} item=${item.id}:`, error);
  });
}

function isSupportedOnlinePayType(value: string): boolean {
  return ["alipay", "wxpay"].includes(String(value || "").trim().toLowerCase());
}

function getEnabledOnlinePayTypes(config: db.CommercialPaymentConfig): string[] {
  const mode = String(config.payment_methods || "all").trim().toLowerCase();
  if (mode === "alipay") return ["alipay"];
  if (mode === "wxpay") return ["wxpay"];
  return ["alipay", "wxpay"];
}

function isAllowedOnlinePayType(config: db.CommercialPaymentConfig, payType: string): boolean {
  const normalized = String(payType || "").trim().toLowerCase();
  return getEnabledOnlinePayTypes(config).includes(normalized);
}

function getOrderDisplayTitle(order: db.CommercialOrder): string {
  if (order.order_type === "recharge") {
    return order.note || "余额充值";
  }
  return order.note || order.product_key || order.plan_code || "订阅套餐";
}

function formatCommercialUserLabel(user: db.CommercialUser): string {
  const displayName = String(user.display_name || "").trim();
  const username = String(user.username || "").trim();
  if (displayName && username) return `${displayName} (@${username})`;
  if (displayName) return displayName;
  if (username) return `@${username}`;
  return String(user.user_id);
}

async function notifyAdminPaidOrder(
  bot: Bot,
  payload: { order: db.CommercialOrder; user: db.CommercialUser; subscription?: db.CommercialSubscription | null; source: string }
) {
  const adminId = getSuperAdminUserId();
  if (!adminId) return;
  const { order, user, subscription, source } = payload;
  const lines = [
    `<b>${order.order_type === "recharge" ? "新充值订单支付成功" : "新订单支付成功"}</b>`,
    "",
    `来源: ${esc(source)}`,
    `订单号: <code>${esc(order.order_no)}</code>`,
    `用户: ${esc(formatCommercialUserLabel(user))} (<code>${user.user_id}</code>)`,
    `标题: ${esc(getOrderDisplayTitle(order))}`,
    `类型: ${esc(order.order_type === "recharge" ? "余额充值" : "订阅购买")}`,
    `金额: <b>${(Number(order.amount_cents || 0) / 100).toFixed(2)} 元</b>`,
    `支付方式: ${esc(getPaymentMethodLabel(order.payment_method))}`,
  ];
  if (order.plan_code) lines.push(`套餐: <code>${esc(order.plan_code)}</code>`);
  if (order.product_key) lines.push(`产品: <code>${esc(order.product_key)}</code>`);
  if (subscription?.ends_at) lines.push(`到期时间: <code>${esc(subscription.ends_at)}</code>`);
  if (order.gateway_trade_no) lines.push(`流水号: <code>${esc(order.gateway_trade_no)}</code>`);

  try {
    await bot.api.sendMessage(adminId, lines.join("\n"), {
      parse_mode: "HTML",
      link_preview_options: { is_disabled: true },
    });
  } catch (error) {
    console.error("[WebPayment] 通知管理员新订单失败:", error);
  }
}

async function notifyAdminFirstConsoleLogin(
  bot: Bot,
  payload: { user: db.CommercialUser; req: http.IncomingMessage }
) {
  const adminId = getSuperAdminUserId();
  if (!adminId) return;
  const { user, req } = payload;
  const lines = [
    `<b>新账号登录控制台</b>`,
    "",
    `用户: ${esc(formatCommercialUserLabel(user))} (<code>${user.user_id}</code>)`,
    `IP: <code>${esc(getRequestClientIp(req))}</code>`,
    `时间: <code>${esc(new Date().toISOString().replace("T", " ").slice(0, 19))}</code>`,
  ];
  try {
    await bot.api.sendMessage(adminId, lines.join("\n"), {
      parse_mode: "HTML",
      link_preview_options: { is_disabled: true },
    });
  } catch (error) {
    console.error("[WebConsole] 通知管理员新账号登录失败:", error);
  }
}

function getSessionUser(req: http.IncomingMessage): db.CommercialUser | null {
  const cookies = parseCookies(req.headers.cookie);
  const headerToken = String(req.headers[SESSION_TOKEN_HEADER] || "").trim();
  const token = headerToken || cookies[SESSION_COOKIE] || "";
  const proof = String(req.headers[SESSION_PROOF_HEADER] || "").trim();
  if (proof) {
    return db.getCommercialUserBySession(token, hashSessionProof(proof));
  }
  return db.getCommercialUserBySessionToken(token);
}

function shouldUseSecureCookie(req: http.IncomingMessage): boolean {
  const forwardedProto = String(req.headers["x-forwarded-proto"] || "").split(",")[0].trim().toLowerCase();
  if (forwardedProto) return forwardedProto === "https";
  return !!(req.socket as any)?.encrypted;
}

function buildSessionCookie(req: http.IncomingMessage, token: string): string {
  const secure = shouldUseSecureCookie(req) ? "; Secure" : "";
  return `${SESSION_COOKIE}=${encodeURIComponent(token)}; HttpOnly; Path=/; SameSite=Strict${secure}`;
}

function buildExpiredSessionCookie(req: http.IncomingMessage): string {
  return `${SESSION_COOKIE}=; HttpOnly; Path=/; Max-Age=0; SameSite=Strict${shouldUseSecureCookie(req) ? "; Secure" : ""}`;
}

function refreshSessionFromRequest(req: http.IncomingMessage, res: http.ServerResponse): db.CommercialUser | null {
  const cookies = parseCookies(req.headers.cookie);
  const headerToken = String(req.headers[SESSION_TOKEN_HEADER] || "").trim();
  const token = headerToken || cookies[SESSION_COOKIE] || "";
  const proof = String(req.headers[SESSION_PROOF_HEADER] || "").trim();
  if (!token) return null;
  const proofHash = proof ? hashSessionProof(proof) : "";
  const user = proofHash ? db.getCommercialUserBySession(token, proofHash) : db.getCommercialUserBySessionToken(token);
  if (!user) return null;
  if (proofHash) db.extendCommercialSession(token, proofHash, SESSION_TTL_DAYS);
  else db.extendCommercialSessionByToken(token, SESSION_TTL_DAYS);
  res.setHeader("Set-Cookie", buildSessionCookie(req, token));
  return user;
}

function requireSessionUser(req: http.IncomingMessage, res: http.ServerResponse): db.CommercialUser | null {
  const user = refreshSessionFromRequest(req, res);
  if (!user) {
    sendJson(res, 401, { error: "请先登录控制台" });
    return null;
  }
  return user;
}

function buildAdminOverviewPayload() {
  const announcement = db.getConsoleAnnouncement();
  return {
    announcement,
    announcementHtml: renderMarkdownToWebHtml(announcement),
    products: db.listCommercialProducts(false),
    orders: db.listAllCommercialOrders(200),
    financeLogs: db.listAllCommercialFinanceLogs(300),
    users: db.listAllCommercialUsers(200),
    chats: db.listAllCommercialChats(200),
    paymentConfig: db.getCommercialPaymentConfig(),
  };
}

function buildDashboardPayload(userId: number) {
  const user = db.getCommercialUser(userId);
  const isAdmin = isSuperAdminUser(userId);
  const subscription = db.getCommercialActiveSubscription(userId);
  const announcement = db.getConsoleAnnouncement();
  const paymentConfig = db.getCommercialPaymentConfig();
  const chats = db.listCommercialChatsByOwner(userId).map((chat) => ({
    ...chat,
    welcomeConfig: db.getCommercialChatWelcomeConfig(chat.chat_id),
    pointsMallItems: db.listPointsMallItemsByChat(chat.chat_id),
    pointsMallConfig: db.getPointsMallConfig(chat.chat_id),
  }));
  const adminOverview = isAdmin ? buildAdminOverviewPayload() : null;
  const products = db.listCommercialProducts(true);
  const zjmfIntegration = getZjmfIntegrationStatus();
  return {
    user,
    subscription,
    subscriptions: db.listCommercialSubscriptions(userId, 10),
    orders: db.listCommercialOrders(userId, 20),
    financeLogs: db.listCommercialFinanceLogs(userId, 20),
    chats,
    products,
    aiConfig: db.getCommercialAIConfig(userId),
    publicAnnouncement: announcement,
    publicAnnouncementHtml: renderMarkdownToWebHtml(announcement),
    balanceLogs: db.listCommercialBalanceLogs(userId, 20),
    isAdmin,
    adminOverview,
    claimLimit: isAdmin
      ? null
      : (subscription?.product_key ? (db.getCommercialProduct(subscription.product_key)?.chat_limit ?? PRO_CHAT_LIMIT) : 0),
    claimCount: chats.length,
    canEditPremiumSettings: isSuperAdminUser(userId) || !!subscription,
    paymentNote: String(process.env.SUBSCRIPTION_PAYMENT_NOTE || "新人用户请先阅读用户使用文档，避免少走设置弯路。"),
    onlinePaymentEnabled: paymentConfig.enabled === 1 && !!paymentConfig.base_url && !!paymentConfig.pid && !!paymentConfig.key,
    paymentMethods: getEnabledOnlinePayTypes(paymentConfig),
    webBaseUrl: getWebBaseUrl(),
    zjmfIntegration,
  };
}

function normalizeAiTestMessages(rawMessages: unknown): { role: "user" | "assistant"; content: string }[] {
  if (!Array.isArray(rawMessages)) return [];
  return rawMessages
    .map((item) => {
      const role = String((item as any)?.role || "").trim().toLowerCase();
      const content = String((item as any)?.content || "").trim().slice(0, AI_TEST_MAX_MESSAGE_CHARS);
      if (!content) return null;
      if (role !== "user" && role !== "assistant") return null;
      return { role, content } as { role: "user" | "assistant"; content: string };
    })
    .filter((item): item is { role: "user" | "assistant"; content: string } => !!item)
    .slice(-AI_TEST_MAX_MESSAGES);
}

function resolveAiTestProvider(body: any): { provider?: AIProviderConfig; providerLabel: string } {
  const enabled = body?.enabled === true;
  if (!enabled) {
    return { provider: undefined, providerLabel: "平台默认接口" };
  }

  const baseUrl = String(body?.baseUrl || "").trim();
  const apiKey = String(body?.apiKey || "").trim();
  const model = String(body?.model || "").trim();
  const apiStyle = (String(body?.apiStyle || "auto").trim() || "auto") as AIProviderConfig["apiStyle"];
  if (!baseUrl || !apiKey || !model) {
    throw new Error("请先完整填写 Base URL、API Key、模型名，再测试自定义 AI");
  }

  return {
    provider: { baseUrl, apiKey, model, apiStyle },
    providerLabel: "当前表单里的自定义接口",
  };
}

function buildXPayPaymentUrl(payload: {
  order: db.CommercialOrder;
  req: http.IncomingMessage;
  name: string;
}): string {
  const config = db.getCommercialPaymentConfig();
  if (config.enabled !== 1) throw new Error("在线支付尚未开启");
  if (!config.base_url || !config.pid || !config.key) throw new Error("支付配置不完整，请联系管理员");
  if (!isSupportedOnlinePayType(payload.order.payment_method)) throw new Error("暂不支持该在线支付方式");
  if (!isAllowedOnlinePayType(config, payload.order.payment_method)) throw new Error("当前支付网关未开启该支付方式");
  const params: Record<string, string> = {
    pid: config.pid,
    type: String(payload.order.payment_method || "alipay").trim() || "alipay",
    out_trade_no: payload.order.order_no,
    notify_url: joinUrl(getWebBaseUrl(), config.notify_path),
    return_url: joinUrl(getWebBaseUrl(), config.return_path),
    name: String(payload.name || "在线支付").trim().slice(0, 127) || "在线支付",
    money: (Number(payload.order.amount_cents || 0) / 100).toFixed(2),
    sitename: config.site_name || "Telegram Bot 控制台",
    clientip: getRequestClientIp(payload.req),
    device: detectDeviceType(payload.req),
    param: JSON.stringify({ orderNo: payload.order.order_no, orderType: payload.order.order_type }).slice(0, 180),
  };
  params.sign = buildXPaySign(params, config.key);
  params.sign_type = "MD5";
  return `${joinUrl(config.base_url, "/xpay/epay/submit.php")}?${new URLSearchParams(params).toString()}`;
}

function buildPaymentReturnHtml(message: string): string {
  const safeMessage = String(message || "支付处理完成，请返回控制台查看最新状态。").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>支付结果</title><style>body{margin:0;font-family:system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:#0b1020;color:#e5eefc;display:flex;min-height:100vh;align-items:center;justify-content:center;padding:20px}.card{width:min(560px,100%);background:rgba(17,24,39,.95);border:1px solid rgba(148,163,184,.18);border-radius:24px;padding:24px;box-shadow:0 24px 60px rgba(0,0,0,.28)}a{display:inline-block;margin-top:16px;padding:12px 18px;border-radius:999px;background:#68d5ff;color:#04111f;text-decoration:none;font-weight:700}</style></head><body><div class="card"><h1>支付结果</h1><p style="line-height:1.7;white-space:pre-wrap;">${safeMessage}</p><a href="/console">返回控制台</a></div></body></html>`;
}

function assertClaimQuota(userId: number, chatId?: number): void {
  if (isSuperAdminUser(userId)) return;
  const ownedChats = db.listCommercialChatsByOwner(userId);
  if (chatId && ownedChats.some((chat) => chat.chat_id === chatId)) return;
  const subscription = db.getCommercialActiveSubscription(userId);
  const limit = subscription?.product_key ? (db.getCommercialProduct(subscription.product_key)?.chat_limit ?? PRO_CHAT_LIMIT) : 0;
  if (ownedChats.length >= limit) {
    throw new Error(`当前套餐最多认领 ${limit} 个群组/频道，请先解绑不用的聊天后再继续认领`);
  }
}

function hasCommercialWriteAccess(userId: number): boolean {
  return isSuperAdminUser(userId) || !!db.getCommercialActiveSubscription(userId);
}

function getEditableCommercialChat(chatId: number, requesterUserId: number): db.CommercialChat {
  const chat = db.getCommercialChat(chatId);
  if (!chat) throw new Error("绑定记录不存在");
  if (chat.owner_user_id !== requesterUserId && !isSuperAdminUser(requesterUserId)) {
    throw new Error("只有当前绑定账号或 ADMIN_USER_ID 可以修改积分商城");
  }
  return chat;
}

function assertClaimAllowed(chatId: number, requesterUserId: number): void {
  const existing = db.getCommercialChat(chatId);
  if (!existing) return;
  if (existing.owner_user_id === requesterUserId) return;
  if (isSuperAdminUser(requesterUserId)) return;
  throw new Error(`该群组/频道已绑定到账号 ${existing.owner_user_id}，只有原绑定账号或 ADMIN_USER_ID 才能重新绑定`);
}

async function verifyUserOwnsChat(bot: Bot, userId: number, chatRefRaw: string) {
  const chatRef = normalizeChatRef(chatRefRaw);
  const chat = await bot.api.getChat(chatRef as any);
  if (isSuperAdminUser(userId)) {
    return chat;
  }
  const member = await bot.api.getChatMember((chat as any).id, userId);
  if (!(member.status === "administrator" || member.status === "creator")) {
    throw new Error("你不是该群组/频道的管理员，无法认领");
  }
  return chat;
}

export function createConsoleLoginCodeForUser(userId: number): { code: string; loginUrl: string } {
  let code = randomLoginCode();
  for (let i = 0; i < 3; i++) {
    try {
      db.createCommercialLoginCode(userId, code, 15);
      return { code, loginUrl: `${getWebBaseUrl()}/console` };
    } catch {
      code = randomLoginCode();
    }
  }
  code = randomLoginCode();
  db.createCommercialLoginCode(userId, code, 15);
  return { code, loginUrl: `${getWebBaseUrl()}/console` };
}

async function parseXPayCallbackParams(req: http.IncomingMessage, url: URL): Promise<Record<string, string>> {
  const queryParams: Record<string, string> = {};
  url.searchParams.forEach((value, key) => {
    queryParams[key] = value;
  });
  if (req.method === "GET") return queryParams;
  const bodyParams = await readUrlEncodedBody(req);
  return { ...queryParams, ...bodyParams };
}

function finalizeXPayOrderIfPossible(params: Record<string, string>): {
  ok: boolean;
  message: string;
  order?: db.CommercialOrder;
  user?: db.CommercialUser;
  subscription?: db.CommercialSubscription | null;
  newlyPaid?: boolean;
} {
  const config = db.getCommercialPaymentConfig();
  if (!config.key) {
    return { ok: false, message: "支付密钥未配置" };
  }
  if (!verifyXPaySign(params, config.key)) {
    return { ok: false, message: "签名校验失败" };
  }
  if (String(params.trade_status || "") !== "TRADE_SUCCESS") {
    return { ok: false, message: `支付状态未成功: ${String(params.trade_status || "unknown")}` };
  }
  const outTradeNo = String(params.out_trade_no || "").trim();
  if (!outTradeNo) {
    return { ok: false, message: "缺少商户订单号" };
  }
  const result = db.completeCommercialOrderPayment(outTradeNo, String(params.trade_no || ""));
  return {
    ok: true,
    message: "支付成功",
    order: result.order,
    user: result.user,
    subscription: result.subscription,
    newlyPaid: result.newlyPaid,
  };
}

export interface TelegramWebhookServerOptions {
  path: string;
  secretToken?: string;
  onUpdate: (update: unknown) => boolean | Promise<boolean>;
}

export interface StartCommercialWebServerOptions {
  telegramWebhook?: TelegramWebhookServerOptions;
}

export function startCommercialWebServer(bot: Bot, options?: StartCommercialWebServerOptions) {
  const webhookPath = normalizePathname(options?.telegramWebhook?.path || "");
  const webhookSecret = String(options?.telegramWebhook?.secretToken || "").trim();

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url || "/", getWebBaseUrl());

      if (req.method === "POST" && webhookPath && url.pathname === webhookPath) {
        if (webhookSecret) {
          const incoming = String(req.headers["x-telegram-bot-api-secret-token"] || "").trim();
          if (incoming !== webhookSecret) {
            sendText(res, 403, "forbidden");
            return;
          }
        }

        let update: unknown = null;
        try {
          update = await readJsonBody(req);
        } catch {
          sendText(res, 400, "bad request");
          return;
        }

        if (!options?.telegramWebhook?.onUpdate) {
          sendText(res, 503, "webhook handler not ready");
          return;
        }

        const accepted = await options.telegramWebhook.onUpdate(update);
        if (!accepted) {
          sendText(res, 503, "queue full");
          return;
        }

        sendText(res, 200, "ok");
        return;
      }

      if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/console")) {
        sendHtml(res, readConsoleHtml());
        return;
      }

      if (req.method === "GET" && url.pathname === "/blackjack") {
        sendHtml(res, readBlackjackHtml());
        return;
      }

      if (req.method === "GET" && url.pathname === "/niuniu") {
        sendHtml(res, readNiuNiuHtml());
        return;
      }

      if (req.method === "POST" && url.pathname === "/api/blackjack/state") {
        const body = await readJsonBody(req);
        const initDataRaw = String(body.initData || "").trim();
        const chatId = Number(body.chatId || 0);
        const dealerId = Number(body.dealerId || 0);
        const launchTs = Number(body.launchTs || 0);
        const launchSig = String(body.launchSig || "").trim();

        if (!chatId || !dealerId || !launchTs || !launchSig) {
          sendJson(res, 400, { error: "缺少牌桌参数，请从群内命令重新打开。" });
          return;
        }

        const launchInfo = { chatId, dealerId, launchTs, launchSig };
        if (isBlackjackLaunchConsumed(launchInfo)) {
          sendJson(res, 403, { error: "本局牌桌已结束并关闭，请回群里重新发送 /21。" });
          return;
        }

        const launchValid = verifyBlackjackLaunchSig(chatId, dealerId, launchTs, launchSig);
        if (!launchValid) {
          sendJson(res, 403, { error: "牌桌入口已失效，请回群里重新发送 /21。" });
          return;
        }

        let viewer = { id: 0, name: "浏览器访客" };
        if (initDataRaw) {
          const verified = verifyTelegramWebAppInitData(initDataRaw);
          if (!verified.ok) {
            sendJson(res, 401, { error: verified.error });
            return;
          }
          viewer = { id: verified.userId, name: verified.userName };
        }

        purgeExpiredBlackjackRooms();
        let room = blackjackRooms.get(chatId) || null;
        if (room && viewer.id > 0 && viewer.id === dealerId && shouldResetRoomByLaunch(room, launchTs)) {
          if (db.isPointsEnabled(chatId) && hasEnoughPointsToJoinBlackjack(chatId, viewer.id)) {
            room = createBlackjackRoom(chatId, viewer.id, viewer.name);
            room.lastAction = `房间已创建，${room.dealerName} 为庄家。`;
          }
        }

        const state = buildBlackjackStatePayload(room, viewer, launchInfo);
        sendJson(res, 200, { ok: true, state });
        return;
      }

      if (req.method === "POST" && url.pathname === "/api/blackjack/action") {
        const body = await readJsonBody(req);
        const initDataRaw = String(body.initData || "").trim();
        if (!initDataRaw) {
          sendJson(res, 401, { error: "浏览器模式仅支持查看，不支持操作。请从 Telegram 小程序按钮打开后再操作。" });
          return;
        }

        const verified = verifyTelegramWebAppInitData(initDataRaw);
        if (!verified.ok) {
          sendJson(res, 401, { error: verified.error });
          return;
        }

        const action = String(body.action || "").trim().toLowerCase();
        const chatId = Number(body.chatId || 0);
        const dealerId = Number(body.dealerId || 0);
        const launchTs = Number(body.launchTs || 0);
        const launchSig = String(body.launchSig || "").trim();

        if (!chatId || !dealerId || !launchTs || !launchSig) {
          sendJson(res, 400, { error: "缺少牌桌参数，请从群内命令重新打开。" });
          return;
        }

        const launchInfo = { chatId, dealerId, launchTs, launchSig };
        const viewer = { id: verified.userId, name: verified.userName };

        if (isBlackjackLaunchConsumed(launchInfo)) {
          sendJson(res, 403, { error: "本局牌桌已结束并关闭，请回群里重新发送 /21。" });
          return;
        }

        purgeExpiredBlackjackRooms();
        let room = blackjackRooms.get(chatId) || null;

        const requireMemberCheck = ["create", "join", "leave", "start", "hit", "stand", "close"].includes(action);
        if (requireMemberCheck) {
          const inChat = await isUserMemberOfChat(bot, chatId, viewer.id);
          if (!inChat) {
            sendJson(res, 403, { error: "你已不在该群，无法操作牌桌。" });
            return;
          }
        }

        if (action === "create") {
          if (!db.isPointsEnabled(chatId)) {
            sendJson(res, 400, { error: "本群未开启积分系统，无法创建 21 点牌桌。" });
            return;
          }
          if (!hasEnoughPointsToJoinBlackjack(chatId, viewer.id)) {
            const myPoints = getUserPointsTotal(chatId, viewer.id);
            sendJson(res, 400, { error: `创建牌桌需积分不少于 ${BLACKJACK_JOIN_MIN_POINTS_INCLUSIVE}，你当前为 ${myPoints}。` });
            return;
          }
          if (room) {
            if (viewer.id === dealerId && shouldResetRoomByLaunch(room, launchTs)) {
              room = createBlackjackRoom(chatId, viewer.id, viewer.name);
              room.lastAction = `房间已创建，${room.dealerName} 为庄家。`;
            }
            const state = buildBlackjackStatePayload(room, viewer, launchInfo);
            sendJson(res, 200, { ok: true, state });
            return;
          }
          const launchValid = verifyBlackjackLaunchSig(chatId, dealerId, launchTs, launchSig);
          if (!launchValid || viewer.id !== dealerId) {
            sendJson(res, 403, { error: "只有房主可创建牌桌，请从群内 /21 重新打开。" });
            return;
          }
          room = createBlackjackRoom(chatId, viewer.id, viewer.name);
          room.lastAction = `房间已创建，${room.dealerName} 为庄家。`;
          const state = buildBlackjackStatePayload(room, viewer, launchInfo);
          sendJson(res, 200, { ok: true, state });
          return;
        }

        if (!room) {
          sendJson(res, 404, { error: "牌桌不存在或已关闭。" });
          return;
        }

        if (action === "join") {
          if (room.phase !== "lobby") {
            sendJson(res, 400, { error: "牌局已开始，当前无法加入。" });
            return;
          }
          if (!db.isPointsEnabled(room.chatId)) {
            sendJson(res, 400, { error: "本群未开启积分系统，无法加入 21 点牌桌。" });
            return;
          }
          if (viewer.id === room.dealerId) {
            sendJson(res, 400, { error: "房主是庄家，不作为闲家加入。" });
            return;
          }
          if (room.players.some((player) => player.id === viewer.id)) {
            sendJson(res, 400, { error: "你已经在牌桌中了。" });
            return;
          }
          if (!hasEnoughPointsToJoinBlackjack(room.chatId, viewer.id)) {
            const myPoints = getUserPointsTotal(room.chatId, viewer.id);
            sendJson(res, 400, { error: `加入牌桌需积分不少于 ${BLACKJACK_JOIN_MIN_POINTS_INCLUSIVE}，你当前为 ${myPoints}。` });
            return;
          }
          if (room.players.length >= BLACKJACK_ROOM_MAX_TOTAL - 1) {
            sendJson(res, 400, { error: "牌桌已满（最多 6 人同桌）。" });
            return;
          }
          room.players.push({
            id: viewer.id,
            name: viewer.name,
            cards: [],
            status: "active",
            outcome: "pending",
          });
          room.lastAction = `${viewer.name} 已入座。`;
          touchBlackjackRoom(room);
        } else if (action === "leave") {
          if (room.phase !== "lobby") {
            sendJson(res, 400, { error: "牌局已开始，无法退出。" });
            return;
          }
          const index = room.players.findIndex((player) => player.id === viewer.id);
          if (index < 0) {
            sendJson(res, 400, { error: "你当前不在牌桌中。" });
            return;
          }
          room.players.splice(index, 1);
          room.lastAction = `${viewer.name} 已离桌。`;
          touchBlackjackRoom(room);
        } else if (action === "start") {
          if (viewer.id !== room.dealerId) {
            sendJson(res, 403, { error: "只有庄家可开始发牌。" });
            return;
          }
          if (room.phase !== "lobby") {
            sendJson(res, 400, { error: "当前不是可开局状态。" });
            return;
          }
          if (room.players.length < BLACKJACK_ROOM_MIN_TOTAL - 1) {
            sendJson(res, 400, { error: "至少还需要 1 名闲家才能开局。" });
            return;
          }
          if (!db.isPointsEnabled(room.chatId)) {
            sendJson(res, 400, { error: "本群未开启积分系统，无法开始 21 点对局。" });
            return;
          }
          const lowPointUsers = getBlackjackLowPointUserNames(room);
          if (lowPointUsers.length > 0) {
            sendJson(res, 400, {
              error: `以下成员积分需不少于 ${BLACKJACK_JOIN_MIN_POINTS_INCLUSIVE} 才能开局：${lowPointUsers.join("、")}`,
            });
            return;
          }
          startBlackjackRound(room);
          if (room.turnPlayerIndex === -1) {
            startDealerTurn(room);
          }
        } else if (action === "hit" || action === "stand") {
          if (room.phase !== "playing") {
            sendJson(res, 400, { error: "当前不在进行中的牌局。" });
            return;
          }

          if (room.dealerTurn) {
            if (viewer.id !== room.dealerId) {
              sendJson(res, 403, { error: "当前轮到庄家操作。" });
              return;
            }

            if (action === "hit") {
              room.dealerCards.push(drawBlackjackCard());
              const dealerValue = getBlackjackHandValue(room.dealerCards);
              if (dealerValue > 21) {
                room.lastAction = `庄家 ${room.dealerName} 要牌后爆牌，开始结算。`;
                settleBlackjackRound(room);
              } else {
                room.lastAction = `庄家 ${room.dealerName} 选择要牌，可继续要牌或停牌。`;
                touchBlackjackRoom(room);
              }
            } else {
              room.lastAction = `庄家 ${room.dealerName} 选择停牌，开始结算。`;
              settleBlackjackRound(room);
            }
          } else if (room.turnPlayerIndex < 0 || room.turnPlayerIndex >= room.players.length) {
            startDealerTurn(room);
          } else {
            const current = room.players[room.turnPlayerIndex];
            if (viewer.id !== current.id) {
              sendJson(res, 403, { error: "还没轮到你操作。" });
              return;
            }
            if (action === "hit") {
              current.cards.push(drawBlackjackCard());
              const value = getBlackjackHandValue(current.cards);
              if (value > 21) {
                current.status = "busted";
                room.lastAction = `${current.name} 要牌后爆牌。`;
                advanceBlackjackTurn(room);
              } else if (value === 21) {
                current.status = "stood";
                room.lastAction = `${current.name} 要牌后自动停牌。`;
                advanceBlackjackTurn(room);
              } else {
                room.lastAction = `${current.name} 选择要牌，继续操作。`;
                touchBlackjackRoom(room);
              }
            } else {
              current.status = "stood";
              room.lastAction = `${current.name} 选择停牌。`;
              advanceBlackjackTurn(room);
            }
          }
        } else if (action === "restart") {
          if (viewer.id !== room.dealerId) {
            sendJson(res, 403, { error: "只有庄家可重新开局。" });
            return;
          }
          if (room.phase !== "finished") {
            sendJson(res, 400, { error: "只有结算后才能重新开局。" });
            return;
          }
          if (!db.isPointsEnabled(room.chatId)) {
            sendJson(res, 400, { error: "本群未开启积分系统，无法重新开局。" });
            return;
          }
          if (!hasEnoughPointsToJoinBlackjack(room.chatId, room.dealerId)) {
            const dealerPoints = getUserPointsTotal(room.chatId, room.dealerId);
            sendJson(res, 400, { error: `庄家积分不足，需不少于 ${BLACKJACK_JOIN_MIN_POINTS_INCLUSIVE} 才能再来一局。当前为 ${dealerPoints}。` });
            return;
          }
          room.players = [];
          room.dealerCards = [];
          room.finalDealerCards = [];
          room.finalPlayers = [];
          room.phase = "lobby";
          room.dealerTurn = false;
          room.turnPlayerIndex = -1;
          room.resultLines = [];
          room.lastAction = "上局已结束，闲家已自动离桌。请玩家重新加入后开始发牌。";
          touchBlackjackRoom(room);
        } else if (action === "close") {
          if (viewer.id !== room.dealerId) {
            sendJson(res, 403, { error: "只有庄家可关闭牌桌。" });
            return;
          }
          if (room.phase === "playing") {
            settleBlackjackDealerForfeit(room);
          } else {
            markBlackjackLaunchConsumed(launchInfo);
            blackjackRooms.delete(chatId);
            await tryDeleteBlackjackLaunchMessage(bot, chatId);
            const state = buildBlackjackStatePayload(null, viewer, launchInfo);
            sendJson(res, 200, { ok: true, state, closed: true });
            return;
          }
        } else {
          sendJson(res, 400, { error: "未知操作" });
          return;
        }

        if (String(room.phase) === "finished") {
          await tryDeleteBlackjackLaunchMessage(bot, chatId);
          const state = buildBlackjackStatePayload(room, viewer, launchInfo);
          sendJson(res, 200, { ok: true, state, finished: true });
          return;
        }

        const state = buildBlackjackStatePayload(room, viewer, launchInfo);
        sendJson(res, 200, { ok: true, state });
        return;
      }

      if (req.method === "POST" && url.pathname === "/api/niuniu/state") {
        const body = await readJsonBody(req);
        const initDataRaw = String(body.initData || "").trim();
        const chatId = Number(body.chatId || 0);
        const dealerId = Number(body.dealerId || 0);
        const launchTs = Number(body.launchTs || 0);
        const launchSig = String(body.launchSig || "").trim();

        if (!chatId || !dealerId || !launchTs || !launchSig) {
          sendJson(res, 400, { error: "缺少牌桌参数，请从群内命令重新打开。" });
          return;
        }

        const launchInfo = { chatId, dealerId, launchTs, launchSig };
        if (isNiuNiuLaunchConsumed(launchInfo)) {
          const state = buildNiuNiuStatePayload(null, { id: 0, name: "浏览器访客" }, launchInfo);
          sendJson(res, 200, { ok: true, state, closed: true });
          return;
        }

        const launchValid = verifyNiuNiuLaunchSig(chatId, dealerId, launchTs, launchSig);
        if (!launchValid) {
          sendJson(res, 403, { error: "牌桌入口已失效，请回群里重新发送 /nn。" });
          return;
        }

        let viewer = { id: 0, name: "浏览器访客" };
        if (initDataRaw) {
          const verified = verifyTelegramWebAppInitData(initDataRaw);
          if (!verified.ok) {
            sendJson(res, 401, { error: verified.error });
            return;
          }
          viewer = { id: verified.userId, name: verified.userName };
        }

        purgeExpiredNiuNiuRooms();
        let room = niuniuRooms.get(chatId) || null;
        if (room && viewer.id > 0 && viewer.id === dealerId && shouldResetNiuNiuRoomByLaunch(room, launchTs)) {
          if (db.isPointsEnabled(chatId) && hasEnoughPointsToJoinBlackjack(chatId, viewer.id)) {
            room = createNiuNiuRoom(chatId, viewer.id, viewer.name);
            room.lastAction = `房间已创建，${room.dealerName} 为庄家。`;
          }
        }

        const state = buildNiuNiuStatePayload(room, viewer, launchInfo);
        sendJson(res, 200, { ok: true, state });
        return;
      }

      if (req.method === "POST" && url.pathname === "/api/niuniu/action") {
        const body = await readJsonBody(req);
        const initDataRaw = String(body.initData || "").trim();
        if (!initDataRaw) {
          sendJson(res, 401, { error: "浏览器模式仅支持查看，不支持操作。请从 Telegram 小程序按钮打开后再操作。" });
          return;
        }

        const verified = verifyTelegramWebAppInitData(initDataRaw);
        if (!verified.ok) {
          sendJson(res, 401, { error: verified.error });
          return;
        }

        const action = String(body.action || "").trim().toLowerCase();
        const chatId = Number(body.chatId || 0);
        const dealerId = Number(body.dealerId || 0);
        const launchTs = Number(body.launchTs || 0);
        const launchSig = String(body.launchSig || "").trim();

        if (!chatId || !dealerId || !launchTs || !launchSig) {
          sendJson(res, 400, { error: "缺少牌桌参数，请从群内命令重新打开。" });
          return;
        }

        const launchValid = verifyNiuNiuLaunchSig(chatId, dealerId, launchTs, launchSig);
        if (!launchValid) {
          sendJson(res, 403, { error: "牌桌入口已失效，请回群里重新发送 /nn。" });
          return;
        }

        const launchInfo = { chatId, dealerId, launchTs, launchSig };
        const viewer = { id: verified.userId, name: verified.userName };

        if (isNiuNiuLaunchConsumed(launchInfo)) {
          const state = buildNiuNiuStatePayload(null, viewer, launchInfo);
          sendJson(res, 200, { ok: true, state, closed: true });
          return;
        }

        purgeExpiredNiuNiuRooms();
        let room = niuniuRooms.get(chatId) || null;

        const requireMemberCheck = ["create", "join", "leave", "start", "restart", "close"].includes(action);
        if (requireMemberCheck) {
          const inChat = await isUserMemberOfChat(bot, chatId, viewer.id);
          if (!inChat) {
            sendJson(res, 403, { error: "你已不在该群，无法操作牌桌。" });
            return;
          }
        }

        if (action === "create") {
          if (!db.isPointsEnabled(chatId)) {
            sendJson(res, 400, { error: "本群未开启积分系统，无法创建 牛牛 牌桌。" });
            return;
          }
          if (!hasEnoughPointsToJoinBlackjack(chatId, viewer.id)) {
            const myPoints = getUserPointsTotal(chatId, viewer.id);
            sendJson(res, 400, { error: `创建牌桌需积分不少于 ${BLACKJACK_JOIN_MIN_POINTS_INCLUSIVE}，你当前为 ${myPoints}。` });
            return;
          }
          if (room) {
            if (viewer.id === dealerId && shouldResetNiuNiuRoomByLaunch(room, launchTs)) {
              room = createNiuNiuRoom(chatId, viewer.id, viewer.name);
              room.lastAction = `房间已创建，${room.dealerName} 为庄家。`;
            }
            const state = buildNiuNiuStatePayload(room, viewer, launchInfo);
            sendJson(res, 200, { ok: true, state });
            return;
          }
          if (viewer.id !== dealerId) {
            sendJson(res, 403, { error: "只有房主可创建牌桌，请从群内 /nn 重新打开。" });
            return;
          }
          room = createNiuNiuRoom(chatId, viewer.id, viewer.name);
          room.lastAction = `房间已创建，${room.dealerName} 为庄家。`;
          const state = buildNiuNiuStatePayload(room, viewer, launchInfo);
          sendJson(res, 200, { ok: true, state });
          return;
        }

        if (!room) {
          sendJson(res, 404, { error: "牌桌不存在或已关闭。" });
          return;
        }

        if (action === "join") {
          if (room.phase !== "lobby") {
            sendJson(res, 400, { error: "牌局已开始，当前无法加入。" });
            return;
          }
          if (!db.isPointsEnabled(room.chatId)) {
            sendJson(res, 400, { error: "本群未开启积分系统，无法加入 牛牛 牌桌。" });
            return;
          }
          if (viewer.id === room.dealerId) {
            sendJson(res, 400, { error: "房主是庄家，不作为闲家加入。" });
            return;
          }
          if (room.players.some((player) => player.id === viewer.id)) {
            sendJson(res, 400, { error: "你已经在牌桌中了。" });
            return;
          }
          if (!hasEnoughPointsToJoinBlackjack(room.chatId, viewer.id)) {
            const myPoints = getUserPointsTotal(room.chatId, viewer.id);
            sendJson(res, 400, { error: `加入牌桌需积分不少于 ${BLACKJACK_JOIN_MIN_POINTS_INCLUSIVE}，你当前为 ${myPoints}。` });
            return;
          }
          room.players.push({
            id: viewer.id,
            name: viewer.name,
            cards: [],
            handType: "no_niu",
            handLabel: "--",
            outcome: "pending",
            multiplier: 1,
          });
          room.lastAction = `${viewer.name} 已入座。`;
          touchNiuNiuRoom(room);
        } else if (action === "leave") {
          if (room.phase !== "lobby") {
            sendJson(res, 400, { error: "牌局已开始，无法退出。" });
            return;
          }
          const index = room.players.findIndex((player) => player.id === viewer.id);
          if (index < 0) {
            sendJson(res, 400, { error: "你当前不在牌桌中。" });
            return;
          }
          room.players.splice(index, 1);
          room.lastAction = `${viewer.name} 已离桌。`;
          touchNiuNiuRoom(room);
        } else if (action === "start") {
          if (viewer.id !== room.dealerId) {
            sendJson(res, 403, { error: "只有庄家可开始发牌。" });
            return;
          }
          if (room.phase !== "lobby") {
            sendJson(res, 400, { error: "当前不是可开局状态。" });
            return;
          }
          if (room.players.length < NIUNIU_ROOM_MIN_TOTAL - 1) {
            sendJson(res, 400, { error: "至少还需要 1 名闲家才能开局。" });
            return;
          }
          if (!db.isPointsEnabled(room.chatId)) {
            sendJson(res, 400, { error: "本群未开启积分系统，无法开始 牛牛 对局。" });
            return;
          }
          const lowPointUsers = getNiuNiuLowPointUserNames(room);
          if (lowPointUsers.length > 0) {
            sendJson(res, 400, {
              error: `以下成员积分需不少于 ${BLACKJACK_JOIN_MIN_POINTS_INCLUSIVE} 才能开局：${lowPointUsers.join("、")}`,
            });
            return;
          }
          startNiuNiuRound(room);
        } else if (action === "restart") {
          if (viewer.id !== room.dealerId) {
            sendJson(res, 403, { error: "只有庄家可重新开局。" });
            return;
          }
          if (room.phase !== "finished") {
            sendJson(res, 400, { error: "只有结算后才能重新开局。" });
            return;
          }
          if (!db.isPointsEnabled(room.chatId)) {
            sendJson(res, 400, { error: "本群未开启积分系统，无法重新开局。" });
            return;
          }
          if (!hasEnoughPointsToJoinBlackjack(room.chatId, room.dealerId)) {
            const dealerPoints = getUserPointsTotal(room.chatId, room.dealerId);
            sendJson(res, 400, { error: `庄家积分不足，需不少于 ${BLACKJACK_JOIN_MIN_POINTS_INCLUSIVE} 才能再来一局。当前为 ${dealerPoints}。` });
            return;
          }
          room.players = [];
          room.dealerCards = [];
          room.dealerHandType = "no_niu";
          room.dealerHandLabel = "--";
          room.phase = "lobby";
          room.resultLines = [];
          room.resultNotifiedAt = 0;
          room.resultNotifyScheduledAt = 0;
          room.lastAction = "上局已结束，闲家已自动离桌。请玩家重新加入后开始发牌。";
          touchNiuNiuRoom(room);
        } else if (action === "close") {
          if (viewer.id !== room.dealerId) {
            sendJson(res, 403, { error: "只有庄家可关闭牌桌。" });
            return;
          }
          markNiuNiuLaunchConsumed(launchInfo);
          niuniuRooms.delete(chatId);
          await tryDeleteNiuNiuLaunchMessage(bot, chatId);
          const state = buildNiuNiuStatePayload(null, viewer, launchInfo);
          sendJson(res, 200, { ok: true, state, closed: true });
          return;
        } else {
          sendJson(res, 400, { error: "未知操作" });
          return;
        }

        if (String(room.phase) === "finished") {
        }

        const state = buildNiuNiuStatePayload(room, viewer, launchInfo);
        sendJson(res, 200, { ok: true, state, finished: String(room.phase) === "finished" });
        return;
      }

      if ((req.method === "GET" || req.method === "POST") && url.pathname === "/api/payment/xpay/notify") {
        const params = await parseXPayCallbackParams(req, url);
        try {
          const result = finalizeXPayOrderIfPossible(params);
          if (!result.ok) {
            console.warn(`[WebPayment] notify ignored: ${result.message}`);
            sendText(res, 200, "fail");
            return;
          }
          if (result.newlyPaid && result.order && result.user) {
            await notifyAdminPaidOrder(bot, {
              order: result.order,
              user: result.user,
              subscription: result.subscription,
              source: "在线支付回调",
            });
          }
          sendText(res, 200, "success");
          return;
        } catch (error: any) {
          console.error("[WebPayment] notify error:", error);
          sendText(res, 200, "fail");
          return;
        }
      }

      if ((req.method === "GET" || req.method === "POST") && url.pathname === "/payment/xpay/return") {
        const params = await parseXPayCallbackParams(req, url);
        try {
          const result = finalizeXPayOrderIfPossible(params);
          const orderNo = String(params.out_trade_no || "").trim();
          const fallbackOrder = orderNo ? db.getCommercialOrderByOrderNo(orderNo) : null;
          const order = result.order || fallbackOrder;
          const title = order ? getOrderDisplayTitle(order) : "订单";
          const message = result.ok
            ? `${title} 已支付成功。\n订单号：${order?.order_no || orderNo}\n请返回控制台查看最新状态。`
            : `${result.message}\n如已付款但页面未刷新，可稍后回到控制台查看或联系管理员。`;
          sendHtml(res, buildPaymentReturnHtml(message));
          return;
        } catch (error: any) {
          sendHtml(res, buildPaymentReturnHtml(String(error?.message || error || "支付回调处理失败，请返回控制台查看。")));
          return;
        }
      }

      if (req.method === "GET" && url.pathname === "/api/public-config") {
        const announcement = db.getConsoleAnnouncement();
        sendJson(res, 200, { announcement, announcementHtml: renderMarkdownToWebHtml(announcement) });
        return;
      }

      if (req.method === "GET" && url.pathname === "/api/docs/user-guide") {
        const markdown = readUserGuideMarkdown();
        sendJson(res, 200, { markdown, html: renderMarkdownToWebHtml(markdown) });
        return;
      }

      if (req.method === "POST" && url.pathname === "/api/auth/code") {
        const body = await readJsonBody(req);
        const user = db.consumeCommercialLoginCode(String(body.code || ""));
        if (!user) {
          sendJson(res, 400, { error: "登录码无效或已过期，请重新私聊机器人发送 /console" });
          return;
        }
        if (Number(user.frozen || 0) !== 0) {
          const reason = String(user.frozen_note || "").trim();
          sendJson(res, 403, { error: `该账号已被冻结，请联系管理员处理${reason ? `。原因：${reason}` : ""}` });
          return;
        }
        const token = randomToken(24);
        const sessionProof = randomToken(18);
        db.createCommercialSession(user.user_id, token, hashSessionProof(sessionProof), SESSION_TTL_DAYS);
        const isFirstConsoleLogin = db.markCommercialUserFirstConsoleLogin(user.user_id);
        if (isFirstConsoleLogin) {
          await notifyAdminFirstConsoleLogin(bot, { user, req });
        }
        sendJson(
          res,
          200,
          { ok: true, sessionProof, sessionToken: token },
          {
            "Set-Cookie": buildSessionCookie(req, token),
          }
        );
        return;
      }

      if (req.method === "POST" && url.pathname === "/api/auth/logout") {
        const cookies = parseCookies(req.headers.cookie);
        const headerToken = String(req.headers[SESSION_TOKEN_HEADER] || "").trim();
        const token = headerToken || cookies[SESSION_COOKIE] || "";
        if (token) {
          db.revokeCommercialSession(token);
        }
        sendJson(res, 200, { ok: true }, { "Set-Cookie": buildExpiredSessionCookie(req) });
        return;
      }

      if (req.method === "POST" && url.pathname === "/api/auth/keepalive") {
        const user = requireSessionUser(req, res);
        if (!user) return;
        sendJson(res, 200, { ok: true, userId: user.user_id });
        return;
      }

      if (req.method === "GET" && url.pathname === "/api/me") {
        const user = requireSessionUser(req, res);
        if (!user) return;
        sendJson(res, 200, buildDashboardPayload(user.user_id));
        return;
      }

      if (req.method === "GET" && url.pathname === "/api/points-mall/catalog") {
        const user = requireSessionUser(req, res);
        if (!user) return;
        const chatId = Number(url.searchParams.get("chatId") || 0);
        let integrationConfig: { provider?: string; apiUrl?: string; apiToken?: string } | undefined;
        if (chatId) {
          try {
            getEditableCommercialChat(chatId, user.user_id);
            const config = db.getPointsMallConfig(chatId);
            integrationConfig = {
              provider: config.provider,
              apiUrl: config.custom_api_url,
              apiToken: config.custom_api_token,
            };
          } catch (error: any) {
            sendJson(res, 400, { error: String(error?.message || error || "读取积分商城接口配置失败") });
            return;
          }
        }
        try {
          const catalog = await fetchZjmfCatalog(integrationConfig, url.searchParams.get("refresh") === "1");
          sendJson(res, 200, { ok: true, catalog });
        } catch (error: any) {
          sendJson(res, 200, {
            ok: false,
            catalog: {
              ...getZjmfIntegrationStatus(integrationConfig),
              products: [],
              cycles: {},
              promoTypes: [],
            },
            error: String(error?.message || error || "获取魔方目录失败"),
          });
        }
        return;
      }

      if (req.method === "POST" && url.pathname === "/api/chats/points-mall/config") {
        const user = requireSessionUser(req, res);
        if (!user) return;
        if (!hasCommercialWriteAccess(user.user_id)) {
          sendJson(res, 403, { error: "积分商城属于订阅功能，订阅生效后才能修改" });
          return;
        }
        const body = await readJsonBody(req);
        const chatId = Number(body.chatId || 0);
        if (!chatId) {
          sendJson(res, 400, { error: "缺少有效的 chatId" });
          return;
        }
        try {
          getEditableCommercialChat(chatId, user.user_id);
          const config = db.setPointsMallConfig(chatId, {
            provider: String(body.provider || "zjmf").trim(),
            customApiUrl: String(body.customApiUrl || "").trim(),
            customApiToken: String(body.customApiToken || "").trim(),
          });
          sendJson(res, 200, { ok: true, config });
        } catch (error: any) {
          sendJson(res, 400, { error: String(error?.message || error || "保存接口配置失败") });
        }
        return;
      }

      if (req.method === "POST" && url.pathname === "/api/subscription/request") {
        const user = requireSessionUser(req, res);
        if (!user) return;
        const body = await readJsonBody(req);
        const productKey = String(body.productKey || body.planCode || "").trim();
        const paymentMethod = String(body.paymentMethod || "balance").trim().toLowerCase();
        const payType = String(body.payType || "alipay").trim().toLowerCase();
        const product = db.getCommercialProduct(productKey);
        if (!product || !product.active) {
          sendJson(res, 400, { error: "未知的订阅套餐" });
          return;
        }
        if (paymentMethod === "online") {
          if (!isSupportedOnlinePayType(payType)) {
            sendJson(res, 400, { error: "暂不支持该在线支付方式" });
            return;
          }
          if (!isAllowedOnlinePayType(db.getCommercialPaymentConfig(), payType)) {
            sendJson(res, 400, { error: "当前支付网关未开启该支付方式" });
            return;
          }
          try {
            const order = db.createCommercialOnlineSubscriptionOrder({
              userId: user.user_id,
              productKey: product.product_key,
              planCode: product.plan_code,
              months: product.months,
              amountCents: product.amount_cents,
              paymentMethod: payType,
              note: product.title,
            });
            const redirectUrl = buildXPayPaymentUrl({ order, req, name: product.title });
            sendJson(res, 200, {
              ok: true,
              mode: "online_payment",
              order,
              redirectUrl,
            });
          } catch (error: any) {
            sendJson(res, 400, { error: String(error?.message || error || "在线支付创建失败") });
          }
          return;
        }
        try {
          const purchased = db.purchaseCommercialSubscriptionWithBalance(
            user.user_id,
            product.product_key,
            product.plan_code,
            product.months,
            product.amount_cents,
            product.title
          );
          await notifyAdminPaidOrder(bot, {
            order: purchased.order,
            user: purchased.user,
            subscription: purchased.subscription,
            source: "余额购买",
          });
          sendJson(res, 200, {
            ok: true,
            mode: "balance_purchase",
            order: purchased.order,
            subscription: purchased.subscription,
            user: purchased.user,
          });
        } catch (error: any) {
          const message = String(error?.message || error || "购买失败");
          sendJson(res, 400, { error: message.includes("余额不足") ? `余额不足，当前无法直接购买 ${product.title}` : message });
        }
        return;
      }

      if (req.method === "POST" && url.pathname === "/api/balance/recharge") {
        const user = requireSessionUser(req, res);
        if (!user) return;
        const body = await readJsonBody(req);
        const amount = Math.round(Number(body.amount || 0) * 100);
        const payType = String(body.payType || "alipay").trim().toLowerCase();
        if (amount <= 0) {
          sendJson(res, 400, { error: "充值金额必须大于 0" });
          return;
        }
        if (!isSupportedOnlinePayType(payType)) {
          sendJson(res, 400, { error: "暂不支持该在线支付方式" });
          return;
        }
        if (!isAllowedOnlinePayType(db.getCommercialPaymentConfig(), payType)) {
          sendJson(res, 400, { error: "当前支付网关未开启该支付方式" });
          return;
        }
        try {
          const order = db.createCommercialRechargeOrder(user.user_id, amount, payType, `余额充值 ${((amount || 0) / 100).toFixed(2)} 元`);
          const redirectUrl = buildXPayPaymentUrl({ order, req, name: order.note || "余额充值" });
          sendJson(res, 200, { ok: true, order, redirectUrl });
        } catch (error: any) {
          sendJson(res, 400, { error: String(error?.message || error || "创建充值订单失败") });
        }
        return;
      }

      if (req.method === "POST" && url.pathname === "/api/chats/claim") {
        const user = requireSessionUser(req, res);
        if (!user) return;
        if (!hasCommercialWriteAccess(user.user_id)) {
          sendJson(res, 403, { error: "认领群组/频道需要有效订阅后才能修改" });
          return;
        }
        const body = await readJsonBody(req);
        const rawRef = String(body.chatRef || "").trim();
        if (!rawRef) {
          sendJson(res, 400, { error: "请填写群组或频道标识" });
          return;
        }
        const chat = await verifyUserOwnsChat(bot, user.user_id, rawRef);
        assertClaimAllowed(chat.id, user.user_id);
        assertClaimQuota(user.user_id, chat.id);
        const title = "title" in chat ? String(chat.title || chat.id) : String(chat.id);
        const username = "username" in chat ? String(chat.username || "") : "";
        db.claimCommercialChat(chat.id, user.user_id, chat.type, title, username);
        sendJson(res, 200, { ok: true });
        return;
      }

      if (req.method === "POST" && url.pathname === "/api/chats/unbind") {
        const user = requireSessionUser(req, res);
        if (!user) return;
        const body = await readJsonBody(req);
        const chatId = Number(body.chatId || 0);
        if (!chatId) {
          sendJson(res, 400, { error: "缺少有效的 chatId" });
          return;
        }
        const chat = db.getCommercialChat(chatId);
        if (!chat) {
          sendJson(res, 404, { error: "绑定记录不存在" });
          return;
        }
        if (chat.owner_user_id !== user.user_id && !isSuperAdminUser(user.user_id)) {
          sendJson(res, 403, { error: "只有当前绑定账号或 ADMIN_USER_ID 可以解绑" });
          return;
        }
        db.removeCommercialChat(chatId);
        sendJson(res, 200, { ok: true });
        return;
      }

      if (req.method === "POST" && url.pathname === "/api/chats/welcome-config") {
        const user = requireSessionUser(req, res);
        if (!user) return;
        if (!hasCommercialWriteAccess(user.user_id)) {
          sendJson(res, 403, { error: "新人欢迎语属于订阅功能，订阅生效后才能修改" });
          return;
        }
        const body = await readJsonBody(req);
        const chatId = Number(body.chatId || 0);
        if (!chatId) {
          sendJson(res, 400, { error: "缺少有效的 chatId" });
          return;
        }
        const chat = db.getCommercialChat(chatId);
        if (!chat) {
          sendJson(res, 404, { error: "绑定记录不存在" });
          return;
        }
        if (chat.owner_user_id !== user.user_id && !isSuperAdminUser(user.user_id)) {
          sendJson(res, 403, { error: "只有当前绑定账号或 ADMIN_USER_ID 可以修改欢迎语" });
          return;
        }
        const messageText = String(body.messageText || "").trim();
        const buttons = Array.isArray(body.buttons) ? body.buttons : [];
        if (messageText.length > db.COMMERCIAL_WELCOME_TEXT_LIMIT) {
          sendJson(res, 400, { error: `欢迎文本最多 ${db.COMMERCIAL_WELCOME_TEXT_LIMIT} 个字符` });
          return;
        }
        if (stringifyWelcomeButtonsSpec(buttons).length > db.COMMERCIAL_WELCOME_BUTTONS_LIMIT) {
          sendJson(res, 400, { error: `按钮布局最多 ${db.COMMERCIAL_WELCOME_BUTTONS_LIMIT} 个字符` });
          return;
        }
        let config: db.CommercialChatWelcomeConfig;
        try {
          config = db.setCommercialChatWelcomeConfig(chatId, {
            enabled: body.enabled === true,
            messageText,
            buttons,
          });
        } catch (error: any) {
          sendJson(res, 400, { error: String(error?.message || error || "保存欢迎语失败") });
          return;
        }
        sendJson(res, 200, { ok: true, config });
        return;
      }

      if (req.method === "POST" && url.pathname === "/api/chats/points-mall/item/upsert") {
        const user = requireSessionUser(req, res);
        if (!user) return;
        if (!hasCommercialWriteAccess(user.user_id)) {
          sendJson(res, 403, { error: "积分商城属于订阅功能，订阅生效后才能修改" });
          return;
        }
        const body = await readJsonBody(req);
        const chatId = Number(body.chatId || 0);
        if (!chatId) {
          sendJson(res, 400, { error: "缺少有效的 chatId" });
          return;
        }
        try {
          getEditableCommercialChat(chatId, user.user_id);
          const previousItem = Number(body.id || 0) > 0 ? db.getPointsMallItem(chatId, Number(body.id || 0)) : null;
          const item = db.upsertPointsMallItem(chatId, {
            id: Number(body.id || 0),
            sourceProductId: Number(body.sourceProductId || 0),
            title: String(body.title || "").trim(),
            description: String(body.description || "").trim(),
            pointsCost: Number(body.pointsCost || 0),
            redeemCycle: String(body.redeemCycle || "none").trim(),
            repeatMarkupPercent: Number(body.repeatMarkupPercent || 0),
            stock: Number(body.stock || 0),
            enabled: body.enabled !== false,
            sortOrder: Number(body.sortOrder || 0),
            promoScene: String(body.promoScene || "purchase").trim(),
            promoType: String(body.promoType || "percent").trim(),
            promoValue: Number(body.promoValue || 0),
            promoCycles: Array.isArray(body.promoCycles) ? body.promoCycles : [],
            promoAppliesTo: Array.isArray(body.promoAppliesTo) ? body.promoAppliesTo : [],
            promoRequires: Array.isArray(body.promoRequires) ? body.promoRequires : [],
            promoRecurring: body.promoRecurring === true,
            promoRecurfor: Number(body.promoRecurfor || 0),
            promoRequiresExist: body.promoRequiresExist === true,
            promoMaxTimes: body.promoMaxTimes === "" || body.promoMaxTimes == null ? 1 : Number(body.promoMaxTimes || 0),
            promoLifelong: body.promoLifelong === true,
            promoOneTime: body.promoOneTime !== false,
            promoOnlyNewClient: body.promoOnlyNewClient === true,
            promoOnlyOldClient: body.promoOnlyOldClient === true,
            promoOncePerClient: body.promoOncePerClient !== false,
            promoStartTime: String(body.promoStartTime || "").trim(),
            promoExpirationTime: String(body.promoExpirationTime || "").trim(),
            promoValidityMode: String(body.promoValidityMode || "default").trim(),
            promoNotes: String(body.promoNotes || "").trim(),
          });
          const wasEnabled = previousItem ? Number(previousItem.enabled || 0) !== 0 : false;
          const isEnabled = Number(item.enabled || 0) !== 0;
          if (!previousItem && isEnabled) {
            await notifyPointsMallShelfChange(bot, chatId, item, "up", "管理员已创建并上架商品");
          } else if (previousItem && wasEnabled !== isEnabled) {
            await notifyPointsMallShelfChange(bot, chatId, item, isEnabled ? "up" : "down", isEnabled ? "管理员已手动上架商品" : "管理员已手动下架商品");
          }
          sendJson(res, 200, { ok: true, item, items: db.listPointsMallItemsByChat(chatId) });
        } catch (error: any) {
          sendJson(res, 400, { error: String(error?.message || error || "保存积分商城商品失败") });
        }
        return;
      }

      if (req.method === "POST" && url.pathname === "/api/chats/points-mall/item/delete") {
        const user = requireSessionUser(req, res);
        if (!user) return;
        if (!hasCommercialWriteAccess(user.user_id)) {
          sendJson(res, 403, { error: "积分商城属于订阅功能，订阅生效后才能修改" });
          return;
        }
        const body = await readJsonBody(req);
        const chatId = Number(body.chatId || 0);
        const itemId = Number(body.itemId || 0);
        if (!chatId || !itemId) {
          sendJson(res, 400, { error: "缺少有效的 chatId 或 itemId" });
          return;
        }
        try {
          getEditableCommercialChat(chatId, user.user_id);
        } catch (error: any) {
          sendJson(res, 400, { error: String(error?.message || error || "删除商品失败") });
          return;
        }
        const removed = db.removePointsMallItem(chatId, itemId);
        if (!removed) {
          sendJson(res, 404, { error: "商品不存在或已删除" });
          return;
        }
        sendJson(res, 200, { ok: true, items: db.listPointsMallItemsByChat(chatId) });
        return;
      }

      if (req.method === "POST" && url.pathname === "/api/ai-config") {
        const user = requireSessionUser(req, res);
        if (!user) return;
        if (!hasCommercialWriteAccess(user.user_id)) {
          sendJson(res, 403, { error: "自定义 AI 配置需要有效订阅后才能修改" });
          return;
        }
        const body = await readJsonBody(req);
        const enabled = body.enabled === true;
        const baseUrl = String(body.baseUrl || "").trim();
        const apiKey = String(body.apiKey || "").trim();
        const model = String(body.model || "").trim();
        const apiStyle = String(body.apiStyle || "auto").trim() || "auto";
        if (enabled && (!baseUrl || !apiKey || !model)) {
          sendJson(res, 400, { error: "启用自定义 AI 前，请完整填写 Base URL、API Key、模型名" });
          return;
        }
        db.setCommercialAIConfig(user.user_id, { enabled, baseUrl, apiKey, model, apiStyle });
        sendJson(res, 200, { ok: true });
        return;
      }

      if (req.method === "POST" && url.pathname === "/api/ai-config/test-chat") {
        const user = requireSessionUser(req, res);
        if (!user) return;
        if (!hasCommercialWriteAccess(user.user_id)) {
          sendJson(res, 403, { error: "AI 测试对话需要有效订阅后才能使用" });
          return;
        }

        const body = await readJsonBody(req);
        const messages = normalizeAiTestMessages(body.messages);
        if (!messages.length) {
          sendJson(res, 400, { error: "请先输入一条测试消息" });
          return;
        }

        try {
          const { provider, providerLabel } = resolveAiTestProvider(body);
          const response = await callAI(
            [
              {
                role: "system",
                content: "你是一个简洁、自然的 AI 助手。用户正在测试接口连通性与基础对话能力，请直接正常对话，不要输出多余免责声明。",
              },
              ...messages,
            ],
            600,
            0.7,
            true,
            provider
          );
          sendJson(res, 200, {
            ok: true,
            reply: String(response.content || "").trim(),
            model: String(response.model || provider?.model || "unknown"),
            providerLabel,
          });
        } catch (error: any) {
          sendJson(res, 400, { error: String(error?.message || error || "AI 测试失败") });
        }
        return;
      }

      if (req.method === "POST" && url.pathname === "/api/admin/subscription/grant") {
        const user = requireSessionUser(req, res);
        if (!user) return;
        if (!isSuperAdminUser(user.user_id)) {
          sendJson(res, 403, { error: "仅 ADMIN_USER_ID 可操作" });
          return;
        }
        const body = await readJsonBody(req);
        const targetUserId = Number(body.userId || 0);
        const days = Number(body.days || 0);
        const planCode = String(body.planCode || "pro").trim() || "pro";
        if (!targetUserId || !days) {
          sendJson(res, 400, { error: "缺少 userId 或 days" });
          return;
        }
        const sub = db.grantCommercialSubscription(targetUserId, days, planCode, "web_admin");
        sendJson(res, 200, { ok: true, subscription: sub });
        return;
      }

      if (req.method === "POST" && url.pathname === "/api/admin/announcement") {
        const user = requireSessionUser(req, res);
        if (!user) return;
        if (!isSuperAdminUser(user.user_id)) {
          sendJson(res, 403, { error: "仅 ADMIN_USER_ID 可操作" });
          return;
        }
        const body = await readJsonBody(req);
        const announcement = db.setConsoleAnnouncement(String(body.announcement || ""));
        sendJson(res, 200, { ok: true, announcement, announcementHtml: renderMarkdownToWebHtml(announcement) });
        return;
      }

      if (req.method === "GET" && url.pathname === "/api/admin/overview") {
        const user = requireSessionUser(req, res);
        if (!user) return;
        if (!isSuperAdminUser(user.user_id)) {
          sendJson(res, 403, { error: "仅 ADMIN_USER_ID 可操作" });
          return;
        }
        sendJson(res, 200, {
          ...buildAdminOverviewPayload(),
        });
        return;
      }

      if (req.method === "POST" && url.pathname === "/api/admin/payment/config") {
        const user = requireSessionUser(req, res);
        if (!user) return;
        if (!isSuperAdminUser(user.user_id)) {
          sendJson(res, 403, { error: "仅 ADMIN_USER_ID 可操作" });
          return;
        }
        const body = await readJsonBody(req);
        const config = db.setCommercialPaymentConfig({
          enabled: body.enabled === true,
          baseUrl: String(body.baseUrl || "").trim(),
          pid: String(body.pid || "").trim(),
          key: String(body.key || "").trim(),
          siteName: String(body.siteName || "Telegram Bot 控制台").trim(),
          paymentMethods: String(body.paymentMethods || "all").trim(),
          notifyPath: String(body.notifyPath || "/api/payment/xpay/notify").trim(),
          returnPath: String(body.returnPath || "/payment/xpay/return").trim(),
        });
        sendJson(res, 200, {
          ok: true,
          paymentConfig: config,
          overview: buildAdminOverviewPayload(),
        });
        return;
      }

      if (req.method === "POST" && url.pathname === "/api/admin/balance/adjust") {
        const user = requireSessionUser(req, res);
        if (!user) return;
        if (!isSuperAdminUser(user.user_id)) {
          sendJson(res, 403, { error: "仅 ADMIN_USER_ID 可操作" });
          return;
        }
        const body = await readJsonBody(req);
        const targetUserId = Number(body.userId || 0);
        const deltaAmount = Number(body.deltaAmount || 0);
        const note = String(body.note || "后台余额调整").trim();
        if (!targetUserId || !Number.isFinite(deltaAmount) || deltaAmount === 0) {
          sendJson(res, 400, { error: "请提供有效的 userId 和调整金额" });
          return;
        }
        const updatedUser = db.adjustCommercialUserBalance(
          targetUserId,
          Math.round(deltaAmount * 100),
          user.user_id,
          note
        );
        sendJson(res, 200, {
          ok: true,
          user: updatedUser,
          balanceLogs: db.listCommercialBalanceLogs(targetUserId, 20),
        });
        return;
      }

      if (req.method === "POST" && url.pathname === "/api/admin/users/freeze-toggle") {
        const user = requireSessionUser(req, res);
        if (!user) return;
        if (!isSuperAdminUser(user.user_id)) {
          sendJson(res, 403, { error: "仅 ADMIN_USER_ID 可操作" });
          return;
        }
        const body = await readJsonBody(req);
        const targetUserId = Number(body.userId || 0);
        const frozen = body.frozen === true;
        const reason = String(body.reason || "").trim();
        if (!targetUserId) {
          sendJson(res, 400, { error: "缺少有效的 userId" });
          return;
        }
        try {
          const updatedUser = db.setCommercialUserFrozen(targetUserId, frozen, reason);
          sendJson(res, 200, {
            ok: true,
            user: updatedUser,
            overview: {
              ...buildAdminOverviewPayload(),
            },
          });
        } catch (error: any) {
          sendJson(res, 400, { error: String(error?.message || error || "操作失败") });
        }
        return;
      }

      if (req.method === "POST" && url.pathname === "/api/admin/orders/approve") {
        const user = requireSessionUser(req, res);
        if (!user) return;
        if (!isSuperAdminUser(user.user_id)) {
          sendJson(res, 403, { error: "仅 ADMIN_USER_ID 可操作" });
          return;
        }
        const body = await readJsonBody(req);
        const orderId = Number(body.orderId || 0);
        if (!orderId) {
          sendJson(res, 400, { error: "缺少有效的 orderId" });
          return;
        }
        const result = db.approveCommercialOrder(orderId, user.user_id);
        if (result.newlyPaid) {
          const targetUser = db.getCommercialUser(result.order.user_id);
          if (targetUser) {
            await notifyAdminPaidOrder(bot, {
              order: result.order,
              user: targetUser,
              subscription: result.subscription,
              source: "后台审核通过",
            });
          }
        }
        sendJson(res, 200, {
          ok: true,
          order: result.order,
          subscription: result.subscription,
          overview: buildAdminOverviewPayload(),
        });
        return;
      }

      if (req.method === "POST" && url.pathname === "/api/admin/orders/cancel") {
        const user = requireSessionUser(req, res);
        if (!user) return;
        if (!isSuperAdminUser(user.user_id)) {
          sendJson(res, 403, { error: "仅 ADMIN_USER_ID 可操作" });
          return;
        }
        const body = await readJsonBody(req);
        const orderId = Number(body.orderId || 0);
        if (!orderId) {
          sendJson(res, 400, { error: "缺少有效的 orderId" });
          return;
        }
        const order = db.rejectCommercialOrder(orderId);
        sendJson(res, 200, {
          ok: true,
          order,
          overview: buildAdminOverviewPayload(),
        });
        return;
      }

      if (req.method === "POST" && url.pathname === "/api/admin/chats/reassign") {
        const user = requireSessionUser(req, res);
        if (!user) return;
        if (!isSuperAdminUser(user.user_id)) {
          sendJson(res, 403, { error: "仅 ADMIN_USER_ID 可操作" });
          return;
        }
        const body = await readJsonBody(req);
        const chatId = Number(body.chatId || 0);
        const targetUserId = Number(body.targetUserId || 0);
        if (!chatId || !targetUserId) {
          sendJson(res, 400, { error: "缺少有效的 chatId 或 targetUserId" });
          return;
        }
        const chat = db.reassignCommercialChat(chatId, targetUserId);
        sendJson(res, 200, {
          ok: true,
          chat,
          overview: buildAdminOverviewPayload(),
        });
        return;
      }

      if (req.method === "POST" && url.pathname === "/api/admin/chats/unbind") {
        const user = requireSessionUser(req, res);
        if (!user) return;
        if (!isSuperAdminUser(user.user_id)) {
          sendJson(res, 403, { error: "仅 ADMIN_USER_ID 可操作" });
          return;
        }
        const body = await readJsonBody(req);
        const chatId = Number(body.chatId || 0);
        if (!chatId) {
          sendJson(res, 400, { error: "缺少有效的 chatId" });
          return;
        }
        const removed = db.removeCommercialChat(chatId);
        if (!removed) {
          sendJson(res, 404, { error: "绑定记录不存在" });
          return;
        }
        sendJson(res, 200, {
          ok: true,
          overview: buildAdminOverviewPayload(),
        });
        return;
      }

      if (req.method === "POST" && url.pathname === "/api/admin/products/upsert") {
        const user = requireSessionUser(req, res);
        if (!user) return;
        if (!isSuperAdminUser(user.user_id)) {
          sendJson(res, 403, { error: "仅 ADMIN_USER_ID 可操作" });
          return;
        }
        const body = await readJsonBody(req);
        const product = db.upsertCommercialProduct({
          productKey: String(body.productKey || "").trim(),
          title: String(body.title || "").trim(),
          planCode: String(body.planCode || "pro").trim() || "pro",
          months: Number(body.months || 1),
          amountCents: Math.round(Number(body.amount || 0) * 100),
          chatLimit: Number(body.chatLimit || 0),
          description: String(body.description || "").trim(),
          active: body.active !== false,
          sortOrder: Number(body.sortOrder || 0),
        });
        sendJson(res, 200, {
          ok: true,
          product,
          overview: buildAdminOverviewPayload(),
        });
        return;
      }

      sendJson(res, 404, { error: "Not Found" });
    } catch (error: any) {
      sendJson(res, 500, { error: String(error?.message || error || "服务器错误") });
    }
  });

  server.listen(WEB_PORT, () => {
    console.log(`[Web] 订阅控制台已启动: ${getWebBaseUrl()}/console`);
  });

  return server;
}
