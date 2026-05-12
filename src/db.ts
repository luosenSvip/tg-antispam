import Database from "better-sqlite3";
import path from "path";

const DB_PATH = path.join(process.cwd(), "antispam.db");
const db = new Database(DB_PATH);
const COMMERCIAL_SUPER_ADMIN_ID = Math.max(0, Number(process.env.ADMIN_USER_ID || 0));
const COMMERCIAL_SUPER_ADMIN_PRODUCT_KEY = "pro_forever";
const COMMERCIAL_SUPER_ADMIN_ENDS_AT = "永久";
export const COMMERCIAL_WELCOME_TEXT_LIMIT = 400;
export const COMMERCIAL_WELCOME_BUTTONS_LIMIT = 200;

// 启用 WAL 模式提升性能
db.pragma("journal_mode = WAL");

// ==================== 初始化表结构 ====================
db.exec(`
  CREATE TABLE IF NOT EXISTS groups (
    chat_id INTEGER PRIMARY KEY,
    enabled INTEGER DEFAULT 0,
    threshold REAL DEFAULT 0.8,
    ai_enabled INTEGER DEFAULT 0,
    ai_disabled_reason TEXT DEFAULT '',
    points_enabled INTEGER DEFAULT 0,
    werewolf_win_reward_points INTEGER DEFAULT 0,
    werewolf_win_reward_daily_limit INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS whitelist (
    chat_id INTEGER NOT NULL,
    user_id INTEGER NOT NULL,
    added_at TEXT DEFAULT (datetime('now')),
    PRIMARY KEY (chat_id, user_id)
  );

  CREATE TABLE IF NOT EXISTS logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    chat_id INTEGER NOT NULL,
    user_id INTEGER NOT NULL,
    user_name TEXT DEFAULT '',
    message_text TEXT DEFAULT '',
    confidence REAL DEFAULT 0,
    reason TEXT DEFAULT '',
    action TEXT DEFAULT 'ban',
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS samples (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    chat_id INTEGER NOT NULL,
    message_text TEXT NOT NULL,
    is_spam INTEGER NOT NULL,
    added_by INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_logs_chat ON logs(chat_id);
  CREATE INDEX IF NOT EXISTS idx_logs_time ON logs(created_at);
  CREATE INDEX IF NOT EXISTS idx_samples_chat ON samples(chat_id);

  CREATE TABLE IF NOT EXISTS global_bans (
    user_id INTEGER PRIMARY KEY,
    user_name TEXT DEFAULT '',
    reason TEXT DEFAULT '',
    confidence REAL DEFAULT 0,
    source_chat_id INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS user_daily_messages (
    chat_id INTEGER NOT NULL,
    user_id INTEGER NOT NULL,
    date TEXT NOT NULL,
    count INTEGER DEFAULT 1,
    PRIMARY KEY(chat_id, user_id, date)
  );

  CREATE TABLE IF NOT EXISTS lotteries (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    chat_id INTEGER NOT NULL,
    creator_id INTEGER NOT NULL,
    title TEXT NOT NULL,
    winner_count INTEGER NOT NULL,
    prizes_json TEXT DEFAULT '[]',
    message_id INTEGER DEFAULT 0,
    status TEXT DEFAULT 'active',
    draw_condition TEXT DEFAULT 'manual',
    target_value TEXT DEFAULT '',
    remark TEXT DEFAULT '',
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS lottery_participants (
    lottery_id INTEGER NOT NULL,
    user_id INTEGER NOT NULL,
    username TEXT DEFAULT '',
    fullname TEXT DEFAULT '',
    joined_at TEXT DEFAULT (datetime('now')),
    PRIMARY KEY(lottery_id, user_id)
  );

  CREATE TABLE IF NOT EXISTS werewolf_history (
    chat_id INTEGER PRIMARY KEY,
    players_json TEXT NOT NULL,
    updated_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS user_points (
    chat_id INTEGER NOT NULL,
    user_id INTEGER NOT NULL,
    points INTEGER DEFAULT 0,
    PRIMARY KEY(chat_id, user_id)
  );

  CREATE TABLE IF NOT EXISTS werewolf_reward_daily (
    chat_id INTEGER NOT NULL,
    user_id INTEGER NOT NULL,
    date TEXT NOT NULL,
    reward_count INTEGER DEFAULT 0,
    PRIMARY KEY (chat_id, user_id, date)
  );

  CREATE TABLE IF NOT EXISTS oil_steal_attempts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    chat_id INTEGER NOT NULL,
    thief_user_id INTEGER NOT NULL,
    target_user_id INTEGER NOT NULL,
    date TEXT NOT NULL,
    outcome TEXT NOT NULL,
    desired_points INTEGER DEFAULT 0,
    actual_points INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_oil_steal_thief ON oil_steal_attempts(chat_id, thief_user_id, date);
  CREATE INDEX IF NOT EXISTS idx_oil_steal_target ON oil_steal_attempts(chat_id, target_user_id, date);

  CREATE TABLE IF NOT EXISTS invite_vouchers (
    code TEXT PRIMARY KEY,
    chat_id INTEGER NOT NULL,
    creator_id INTEGER NOT NULL,
    used_by_id INTEGER,
    status TEXT DEFAULT 'active',
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS unverified_members (
    chat_id INTEGER NOT NULL,
    user_id INTEGER NOT NULL,
    welcome_msg_id INTEGER,
    joined_at TEXT DEFAULT (datetime('now')),
    PRIMARY KEY (chat_id, user_id)
  );

  CREATE TABLE IF NOT EXISTS channel_guard_members (
    chat_id INTEGER NOT NULL,
    user_id INTEGER NOT NULL,
    joined_at TEXT DEFAULT (datetime('now')),
    PRIMARY KEY (chat_id, user_id)
  );

  CREATE TABLE IF NOT EXISTS chat_user_profiles (
    chat_id INTEGER NOT NULL,
    user_id INTEGER NOT NULL,
    username TEXT DEFAULT '',
    display_name TEXT DEFAULT '',
    updated_at TEXT DEFAULT (datetime('now')),
    PRIMARY KEY (chat_id, user_id)
  );

  CREATE TABLE IF NOT EXISTS points_admin_users (
    chat_id INTEGER NOT NULL,
    user_id INTEGER NOT NULL,
    added_by INTEGER NOT NULL DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now')),
    PRIMARY KEY (chat_id, user_id)
  );

  CREATE TABLE IF NOT EXISTS assistant_allowed_users (
    chat_id INTEGER NOT NULL,
    user_id INTEGER NOT NULL,
    added_by INTEGER NOT NULL DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now')),
    PRIMARY KEY (chat_id, user_id)
  );

  CREATE TABLE IF NOT EXISTS assistant_guard_configs (
    chat_id INTEGER PRIMARY KEY,
    provoke_bot_enabled INTEGER NOT NULL DEFAULT 0,
    provoke_mode TEXT NOT NULL DEFAULT '',
    mute_minutes INTEGER NOT NULL DEFAULT 10,
    updated_by INTEGER NOT NULL DEFAULT 0,
    updated_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS assistant_guard_warnings (
    chat_id INTEGER NOT NULL,
    user_id INTEGER NOT NULL,
    warned_at TEXT DEFAULT (datetime('now')),
    PRIMARY KEY (chat_id, user_id)
  );

  CREATE TABLE IF NOT EXISTS assistant_memories (
    chat_id INTEGER NOT NULL,
    user_id INTEGER NOT NULL,
    note TEXT NOT NULL DEFAULT '',
    updated_at TEXT DEFAULT (datetime('now')),
    PRIMARY KEY (chat_id, user_id)
  );

  CREATE TABLE IF NOT EXISTS assistant_audit_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    chat_id INTEGER NOT NULL,
    user_id INTEGER NOT NULL,
    request_text TEXT NOT NULL DEFAULT '',
    parsed_action TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT '',
    result_text TEXT NOT NULL DEFAULT '',
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_assistant_audit_chat_time
    ON assistant_audit_logs(chat_id, created_at DESC);

  CREATE INDEX IF NOT EXISTS idx_chat_user_profiles_lookup
    ON chat_user_profiles(chat_id, username, updated_at DESC);

  CREATE INDEX IF NOT EXISTS idx_points_admin_users_chat
    ON points_admin_users(chat_id, created_at DESC);

  CREATE INDEX IF NOT EXISTS idx_assistant_allowed_users_chat
    ON assistant_allowed_users(chat_id, created_at DESC);

  CREATE INDEX IF NOT EXISTS idx_assistant_guard_warnings_time
    ON assistant_guard_warnings(chat_id, warned_at DESC);
`);

// 数据库迁移：为旧数据库添加 prizes_json 列
try {
  db.exec("ALTER TABLE lotteries ADD COLUMN prizes_json TEXT DEFAULT '[]'");
} catch (e) {
  // 列已存在或表不存在（忽略错误）
}

try {
  db.exec("ALTER TABLE lotteries ADD COLUMN remark TEXT DEFAULT ''");
} catch (e) {
  // 列已存在或表不存在（忽略错误）
}

try {
  db.exec("ALTER TABLE lotteries ADD COLUMN min_activity INTEGER DEFAULT 0");
} catch (e) {
  // 列已存在或表不存在
}

try {
  db.exec("ALTER TABLE lotteries ADD COLUMN min_points INTEGER DEFAULT 0");
} catch (e) {
  // 列已存在或表不存在
}

// 数据库迁移：为旧数据库添加 global_ban_enabled 列 (默认关闭)
try {
  db.exec("ALTER TABLE groups ADD COLUMN global_ban_enabled INTEGER DEFAULT 0");
} catch (e) {
  // 列已存在或表不存在
}
try {
  db.exec("ALTER TABLE groups ADD COLUMN points_enabled INTEGER DEFAULT 0");
} catch (e) {
  // 列已存在或表不存在
}
try {
  db.exec("ALTER TABLE groups ADD COLUMN ai_enabled INTEGER DEFAULT 0");
} catch (e) {
  // 列已存在或表不存在
}
try {
  db.exec("ALTER TABLE groups ADD COLUMN ai_disabled_reason TEXT DEFAULT ''");
} catch (e) {
  // 列已存在或表不存在
}
try {
  db.exec("ALTER TABLE groups ADD COLUMN werewolf_win_reward_points INTEGER DEFAULT 0");
} catch (e) {
  // 列已存在或表不存在
}
try {
  db.exec("ALTER TABLE groups ADD COLUMN werewolf_win_reward_daily_limit INTEGER DEFAULT 0");
} catch (e) {
  // 列已存在或表不存在
}

// 数据库迁移：积分与邀请系统
try {
  db.exec("ALTER TABLE user_daily_messages ADD COLUMN points_earned INTEGER DEFAULT 0");
} catch (e) {}
try {
  db.exec("ALTER TABLE groups ADD COLUMN invitation_required INTEGER DEFAULT 0");
} catch (e) {}
try {
  db.exec("ALTER TABLE groups ADD COLUMN voucher_price INTEGER DEFAULT 100");
} catch (e) {}
try {
  db.exec("ALTER TABLE groups ADD COLUMN required_channel TEXT DEFAULT ''");
} catch (e) {}

try {
  db.exec("ALTER TABLE invite_vouchers ADD COLUMN used_by_id INTEGER");
} catch (e) {}

// 数据库迁移：积分流水表
db.exec(`
  CREATE TABLE IF NOT EXISTS point_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    chat_id INTEGER NOT NULL,
    user_id INTEGER NOT NULL,
    amount INTEGER NOT NULL,
    reason TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_point_logs_user ON point_logs(chat_id, user_id);
`);

const CHINA_TZ_OFFSET_MS = 8 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

function getChinaDateStr(nowMs: number = Date.now()): string {
  return new Date(nowMs + CHINA_TZ_OFFSET_MS).toISOString().slice(0, 10);
}

function getChinaDayNumber(nowMs: number = Date.now()): number {
  return Math.floor((nowMs + CHINA_TZ_OFFSET_MS) / DAY_MS);
}

function getChinaDateWindowStart(days: number): string {
  const safeDays = Math.max(1, Math.floor(days));
  return getChinaDateStr(Date.now() - (safeDays - 1) * DAY_MS);
}

function ensureGroupRow(chatId: number): void {
  db.prepare(`
    INSERT OR IGNORE INTO groups (
      chat_id,
      enabled,
      threshold,
      global_ban_enabled,
      points_enabled,
      ai_enabled,
      invitation_required,
      voucher_price,
      required_channel,
      ai_disabled_reason,
      werewolf_win_reward_points,
      werewolf_win_reward_daily_limit
    )
    VALUES (?, 0, 0.8, 0, 0, 0, 0, 100, '', '', 0, 0)
  `).run(chatId);
}

export function migrateChatId(oldChatId: number, newChatId: number): void {
  const oldId = Math.trunc(oldChatId);
  const newId = Math.trunc(newChatId);
  if (!Number.isFinite(oldId) || !Number.isFinite(newId) || oldId === newId) return;

  const tx = db.transaction(() => {
    db.prepare(`
      INSERT OR REPLACE INTO groups (
        chat_id, enabled, threshold, ai_enabled, ai_disabled_reason, points_enabled,
        created_at, global_ban_enabled, invitation_required, voucher_price, required_channel,
        werewolf_win_reward_points, werewolf_win_reward_daily_limit
      )
      SELECT ?, enabled, threshold, ai_enabled, ai_disabled_reason, points_enabled,
             created_at, global_ban_enabled, invitation_required, voucher_price, required_channel,
             werewolf_win_reward_points, werewolf_win_reward_daily_limit
      FROM groups
      WHERE chat_id = ?
    `).run(newId, oldId);
    db.prepare(`DELETE FROM groups WHERE chat_id = ?`).run(oldId);

    db.prepare(`INSERT OR REPLACE INTO whitelist (chat_id, user_id, added_at) SELECT ?, user_id, added_at FROM whitelist WHERE chat_id = ?`).run(newId, oldId);
    db.prepare(`DELETE FROM whitelist WHERE chat_id = ?`).run(oldId);

    db.prepare(`UPDATE logs SET chat_id = ? WHERE chat_id = ?`).run(newId, oldId);
    db.prepare(`UPDATE samples SET chat_id = ? WHERE chat_id = ?`).run(newId, oldId);
    db.prepare(`UPDATE global_bans SET source_chat_id = ? WHERE source_chat_id = ?`).run(newId, oldId);

    db.prepare(`
      INSERT OR REPLACE INTO user_daily_messages (chat_id, user_id, date, count, points_earned)
      SELECT ?, user_id, date, count, points_earned
      FROM user_daily_messages
      WHERE chat_id = ?
    `).run(newId, oldId);
    db.prepare(`DELETE FROM user_daily_messages WHERE chat_id = ?`).run(oldId);

    db.prepare(`UPDATE lotteries SET chat_id = ? WHERE chat_id = ?`).run(newId, oldId);

    db.prepare(`
      INSERT OR REPLACE INTO werewolf_history (chat_id, players_json, updated_at)
      SELECT ?, players_json, updated_at FROM werewolf_history WHERE chat_id = ?
    `).run(newId, oldId);
    db.prepare(`DELETE FROM werewolf_history WHERE chat_id = ?`).run(oldId);

    db.prepare(`
      INSERT OR REPLACE INTO user_points (chat_id, user_id, points)
      SELECT ?, user_id, points FROM user_points WHERE chat_id = ?
    `).run(newId, oldId);
    db.prepare(`DELETE FROM user_points WHERE chat_id = ?`).run(oldId);

    db.prepare(`UPDATE point_logs SET chat_id = ? WHERE chat_id = ?`).run(newId, oldId);
    db.prepare(`
      INSERT OR REPLACE INTO werewolf_reward_daily (chat_id, user_id, date, reward_count)
      SELECT ?, user_id, date, reward_count
      FROM werewolf_reward_daily
      WHERE chat_id = ?
    `).run(newId, oldId);
    db.prepare(`DELETE FROM werewolf_reward_daily WHERE chat_id = ?`).run(oldId);
    db.prepare(`UPDATE oil_steal_attempts SET chat_id = ? WHERE chat_id = ?`).run(newId, oldId);
    db.prepare(`UPDATE invite_vouchers SET chat_id = ? WHERE chat_id = ?`).run(newId, oldId);

    db.prepare(`
      INSERT OR REPLACE INTO unverified_members (chat_id, user_id, welcome_msg_id, joined_at)
      SELECT ?, user_id, welcome_msg_id, joined_at FROM unverified_members WHERE chat_id = ?
    `).run(newId, oldId);
    db.prepare(`DELETE FROM unverified_members WHERE chat_id = ?`).run(oldId);

    db.prepare(`
      INSERT OR REPLACE INTO channel_guard_members (chat_id, user_id, joined_at)
      SELECT ?, user_id, joined_at FROM channel_guard_members WHERE chat_id = ?
    `).run(newId, oldId);
    db.prepare(`DELETE FROM channel_guard_members WHERE chat_id = ?`).run(oldId);

    db.prepare(`
      INSERT OR REPLACE INTO chat_user_profiles (chat_id, user_id, username, display_name, updated_at)
      SELECT ?, user_id, username, display_name, updated_at FROM chat_user_profiles WHERE chat_id = ?
    `).run(newId, oldId);
    db.prepare(`DELETE FROM chat_user_profiles WHERE chat_id = ?`).run(oldId);

    db.prepare(`
      INSERT OR REPLACE INTO points_admin_users (chat_id, user_id, added_by, created_at)
      SELECT ?, user_id, added_by, created_at FROM points_admin_users WHERE chat_id = ?
    `).run(newId, oldId);
    db.prepare(`DELETE FROM points_admin_users WHERE chat_id = ?`).run(oldId);

    db.prepare(`
      INSERT OR REPLACE INTO assistant_allowed_users (chat_id, user_id, added_by, created_at)
      SELECT ?, user_id, added_by, created_at FROM assistant_allowed_users WHERE chat_id = ?
    `).run(newId, oldId);
    db.prepare(`DELETE FROM assistant_allowed_users WHERE chat_id = ?`).run(oldId);

    db.prepare(`
      INSERT OR REPLACE INTO assistant_guard_configs (chat_id, provoke_bot_enabled, provoke_mode, mute_minutes, updated_by, updated_at)
      SELECT ?, provoke_bot_enabled, provoke_mode, mute_minutes, updated_by, updated_at
      FROM assistant_guard_configs WHERE chat_id = ?
    `).run(newId, oldId);
    db.prepare(`DELETE FROM assistant_guard_configs WHERE chat_id = ?`).run(oldId);

    db.prepare(`
      INSERT OR REPLACE INTO assistant_guard_warnings (chat_id, user_id, warned_at)
      SELECT ?, user_id, warned_at FROM assistant_guard_warnings WHERE chat_id = ?
    `).run(newId, oldId);
    db.prepare(`DELETE FROM assistant_guard_warnings WHERE chat_id = ?`).run(oldId);

    db.prepare(`
      INSERT OR REPLACE INTO assistant_memories (chat_id, user_id, note, updated_at)
      SELECT ?, user_id, note, updated_at FROM assistant_memories WHERE chat_id = ?
    `).run(newId, oldId);
    db.prepare(`DELETE FROM assistant_memories WHERE chat_id = ?`).run(oldId);

    db.prepare(`UPDATE assistant_audit_logs SET chat_id = ? WHERE chat_id = ?`).run(newId, oldId);

    db.prepare(`
      INSERT OR REPLACE INTO commercial_chats (
        chat_id, owner_user_id, chat_type, title, username, claimed_at, updated_at
      )
      SELECT ?, owner_user_id, chat_type, title, username, claimed_at, updated_at
      FROM commercial_chats
      WHERE chat_id = ?
    `).run(newId, oldId);
    db.prepare(`DELETE FROM commercial_chats WHERE chat_id = ?`).run(oldId);

    db.prepare(`
      INSERT OR REPLACE INTO commercial_chat_welcome_configs (
        chat_id, enabled, message_text, buttons_json, updated_at
      )
      SELECT ?, enabled, message_text, buttons_json, updated_at
      FROM commercial_chat_welcome_configs
      WHERE chat_id = ?
    `).run(newId, oldId);
    db.prepare(`DELETE FROM commercial_chat_welcome_configs WHERE chat_id = ?`).run(oldId);

    db.prepare(`
      INSERT OR REPLACE INTO commercial_points_mall_configs (
        chat_id, provider, custom_api_url, custom_api_token, updated_at
      )
      SELECT ?, provider, custom_api_url, custom_api_token, updated_at
      FROM commercial_points_mall_configs
      WHERE chat_id = ?
    `).run(newId, oldId);
    db.prepare(`DELETE FROM commercial_points_mall_configs WHERE chat_id = ?`).run(oldId);

    db.prepare(`UPDATE commercial_points_mall_items SET chat_id = ? WHERE chat_id = ?`).run(newId, oldId);
    db.prepare(`UPDATE commercial_points_mall_orders SET chat_id = ? WHERE chat_id = ?`).run(newId, oldId);
  });

  tx();
}

export function closeAllGroupSwitches(chatId: number): void {
  ensureGroupRow(chatId);
  db.prepare(`
    UPDATE groups
    SET
      enabled = 0,
      global_ban_enabled = 0,
      points_enabled = 0,
      ai_enabled = 0,
      ai_disabled_reason = '',
      invitation_required = 0
    WHERE chat_id = ?
  `).run(chatId);
}


// ==================== 群组管理 ====================
export function enableGroup(chatId: number): void {
  ensureGroupRow(chatId);
  db.prepare("UPDATE groups SET enabled = 1 WHERE chat_id = ?").run(chatId);
}

export function disableGroup(chatId: number): void {
  ensureGroupRow(chatId);
  db.prepare("UPDATE groups SET enabled = 0 WHERE chat_id = ?").run(chatId);
}

export function isGroupEnabled(chatId: number): boolean {
  const row = db.prepare("SELECT enabled FROM groups WHERE chat_id = ?").get(chatId) as any;
  return row?.enabled === 1;
}

export function getGroupConfig(chatId: number): { enabled: boolean; threshold: number; globalBanEnabled: boolean; pointsEnabled: boolean; aiEnabled: boolean } | null {
  const row = db.prepare("SELECT enabled, threshold, global_ban_enabled, points_enabled, ai_enabled FROM groups WHERE chat_id = ?").get(chatId) as any;
  if (!row) return null;
  return { 
    enabled: row.enabled === 1, 
    threshold: row.threshold,
    globalBanEnabled: row.global_ban_enabled === 1,
    pointsEnabled: row.points_enabled !== 0,
    aiEnabled: row.ai_enabled !== 0,
  };
}

export function setGlobalBanEnabled(chatId: number, enabled: boolean): void {
  ensureGroupRow(chatId);
  db.prepare("UPDATE groups SET global_ban_enabled = ? WHERE chat_id = ?").run(enabled ? 1 : 0, chatId);
}

export function setPointsEnabled(chatId: number, enabled: boolean): void {
  ensureGroupRow(chatId);
  db.prepare("UPDATE groups SET points_enabled = ? WHERE chat_id = ?").run(enabled ? 1 : 0, chatId);
}

export function setWerewolfWinRewardPoints(chatId: number, points: number): void {
  ensureGroupRow(chatId);
  const safePoints = Math.max(0, Math.floor(Number(points) || 0));
  db.prepare("UPDATE groups SET werewolf_win_reward_points = ? WHERE chat_id = ?").run(safePoints, chatId);
}

export function getWerewolfWinRewardPoints(chatId: number): number {
  const row = db.prepare("SELECT werewolf_win_reward_points FROM groups WHERE chat_id = ?").get(chatId) as any;
  return Math.max(0, Math.floor(Number(row?.werewolf_win_reward_points || 0)));
}

export function setWerewolfWinRewardDailyLimit(chatId: number, limit: number): void {
  ensureGroupRow(chatId);
  const safeLimit = Math.max(0, Math.floor(Number(limit) || 0));
  db.prepare("UPDATE groups SET werewolf_win_reward_daily_limit = ? WHERE chat_id = ?").run(safeLimit, chatId);
}

export function getWerewolfWinRewardDailyLimit(chatId: number): number {
  const row = db.prepare("SELECT werewolf_win_reward_daily_limit FROM groups WHERE chat_id = ?").get(chatId) as any;
  return Math.max(0, Math.floor(Number(row?.werewolf_win_reward_daily_limit || 0)));
}

export function creditWerewolfWinRewardPoints(
  chatId: number,
  userId: number,
  amount: number,
  reason: string = "游戏入账"
): { credited: boolean; reachedDailyLimit: boolean } {
  const safeAmount = Math.max(0, Math.floor(Number(amount) || 0));
  if (safeAmount <= 0) return { credited: false, reachedDailyLimit: false };
  ensureGroupRow(chatId);
  ensureUserPointsRow(chatId, userId);

  const tx = db.transaction((safeChatId: number, safeUserId: number, safeReward: number) => {
    const dailyLimit = getWerewolfWinRewardDailyLimit(safeChatId);
    if (dailyLimit > 0) {
      const dateStr = getChinaDateStr();
      const row = db.prepare(`
        SELECT reward_count
        FROM werewolf_reward_daily
        WHERE chat_id = ? AND user_id = ? AND date = ?
      `).get(safeChatId, safeUserId, dateStr) as any;
      const rewardCount = Math.max(0, Math.floor(Number(row?.reward_count || 0)));
      if (rewardCount >= dailyLimit) {
        return { credited: false, reachedDailyLimit: true };
      }

      db.prepare(`
        INSERT INTO werewolf_reward_daily (chat_id, user_id, date, reward_count)
        VALUES (?, ?, ?, 1)
        ON CONFLICT(chat_id, user_id, date) DO UPDATE SET reward_count = reward_count + 1
      `).run(safeChatId, safeUserId, dateStr);
    }

    db.prepare(`
      UPDATE user_points
      SET points = points + ?
      WHERE chat_id = ? AND user_id = ?
    `).run(safeReward, safeChatId, safeUserId);
    logPointChange(safeChatId, safeUserId, safeReward, reason);
    return { credited: true, reachedDailyLimit: false };
  });

  return tx(chatId, userId, safeAmount);
}

export function isPointsEnabled(chatId: number): boolean {
  const row = db.prepare("SELECT points_enabled FROM groups WHERE chat_id = ?").get(chatId) as any;
  if (!row) return false;
  return row.points_enabled !== 0;
}

export type AIDisableReason = "" | "manual" | "ai_failure" | "werewolf_game";

export function setAIEnabled(
  chatId: number,
  enabled: boolean,
  options?: { disabledReason?: Exclude<AIDisableReason, ""> }
): void {
  ensureGroupRow(chatId);
  if (enabled) {
    db.prepare("UPDATE groups SET ai_enabled = 1, ai_disabled_reason = '' WHERE chat_id = ?").run(chatId);
    return;
  }
  const reason = options?.disabledReason ?? "manual";
  db.prepare("UPDATE groups SET ai_enabled = 0, ai_disabled_reason = ? WHERE chat_id = ?").run(reason, chatId);
}

export function isAIEnabled(chatId: number): boolean {
  const row = db.prepare("SELECT ai_enabled FROM groups WHERE chat_id = ?").get(chatId) as any;
  if (!row) return false;
  return row.ai_enabled !== 0;
}

export function getAIDisabledReason(chatId: number): AIDisableReason {
  const row = db.prepare("SELECT ai_disabled_reason FROM groups WHERE chat_id = ?").get(chatId) as any;
  const reason = String(row?.ai_disabled_reason || "").trim();
  if (reason === "manual" || reason === "ai_failure" || reason === "werewolf_game") return reason;
  return "";
}

export function setThreshold(chatId: number, threshold: number): void {
  ensureGroupRow(chatId);
  db.prepare("UPDATE groups SET threshold = ? WHERE chat_id = ?").run(threshold, chatId);
}

export function getThreshold(chatId: number): number {
  const row = db.prepare("SELECT threshold FROM groups WHERE chat_id = ?").get(chatId) as any;
  return row?.threshold ?? 0.8;
}

// ==================== 白名单 ====================
export function addWhitelist(chatId: number, userId: number): void {
  db.prepare(
    "INSERT OR IGNORE INTO whitelist (chat_id, user_id) VALUES (?, ?)"
  ).run(chatId, userId);
}

export function removeWhitelist(chatId: number, userId: number): boolean {
  const result = db.prepare(
    "DELETE FROM whitelist WHERE chat_id = ? AND user_id = ?"
  ).run(chatId, userId);
  return result.changes > 0;
}

export function isWhitelisted(chatId: number, userId: number): boolean {
  const row = db.prepare(
    "SELECT 1 FROM whitelist WHERE chat_id = ? AND user_id = ?"
  ).get(chatId, userId);
  return !!row;
}

export function getWhitelist(chatId: number): number[] {
  const rows = db.prepare(
    "SELECT user_id FROM whitelist WHERE chat_id = ?"
  ).all(chatId) as any[];
  return rows.map((r) => r.user_id);
}

// ==================== 日志 ====================
export interface LogEntry {
  id: number;
  chat_id: number;
  user_id: number;
  user_name: string;
  message_text: string;
  confidence: number;
  reason: string;
  action: string;
  created_at: string;
}

export function addLog(
  chatId: number,
  userId: number,
  userName: string,
  messageText: string,
  confidence: number,
  reason: string,
  action: string = "ban"
): void {
  db.prepare(
    `INSERT INTO logs (chat_id, user_id, user_name, message_text, confidence, reason, action)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(chatId, userId, userName, messageText.slice(0, 500), confidence, reason, action);
}

export function getRecentLogs(chatId: number, limit: number = 10): LogEntry[] {
  return db.prepare(
    "SELECT * FROM logs WHERE chat_id = ? ORDER BY created_at DESC LIMIT ?"
  ).all(chatId, limit) as LogEntry[];
}

export function getStats(chatId: number): { total: number; today: number } {
  const total = db.prepare(
    "SELECT COUNT(*) as c FROM logs WHERE chat_id = ?"
  ).get(chatId) as any;

  const today = db.prepare(
    "SELECT COUNT(*) as c FROM logs WHERE chat_id = ? AND created_at >= datetime('now', '-1 day')"
  ).get(chatId) as any;

  return { total: total?.c || 0, today: today?.c || 0 };
}

export function getGlobalDailyStats(): { totalSpanned: number; details: { chatId: number; count: number }[] } {
  const todayCount = db.prepare(
    "SELECT COUNT(*) as c FROM logs WHERE created_at >= datetime('now', '-1 day')"
  ).get() as any;

  const groupDetails = db.prepare(
    "SELECT chat_id, COUNT(*) as c FROM logs WHERE created_at >= datetime('now', '-1 day') GROUP BY chat_id"
  ).all() as any[];

  return {
    totalSpanned: todayCount?.c || 0,
    details: groupDetails.map((r) => ({ chatId: r.chat_id, count: r.c })),
  };
}

// ==================== 样本学习 ====================
export interface SampleEntry {
  id: number;
  chat_id: number;
  message_text: string;
  is_spam: boolean;
  added_by: number;
  created_at: string;
}

export function addSample(
  chatId: number,
  messageText: string,
  isSpam: boolean,
  addedBy: number = 0
): void {
  const trimmed = messageText.slice(0, 500);
  // 先删除同群组中相同文本的旧样本，避免重复标记导致冲突
  db.prepare(
    `DELETE FROM samples WHERE chat_id = ? AND message_text = ?`
  ).run(chatId, trimmed);
  db.prepare(
    `INSERT INTO samples (chat_id, message_text, is_spam, added_by) VALUES (?, ?, ?, ?)`
  ).run(chatId, trimmed, isSpam ? 1 : 0, addedBy);
}

export function removeSample(sampleId: number): boolean {
  const result = db.prepare("DELETE FROM samples WHERE id = ?").run(sampleId);
  return result.changes > 0;
}

export function getSamples(chatId: number, limit: number = 20, isSpam?: boolean, offset: number = 0): SampleEntry[] {
  let query = "SELECT * FROM samples WHERE chat_id = ?";
  const params: any[] = [chatId];
  
  if (isSpam !== undefined) {
    query += " AND is_spam = ?";
    params.push(isSpam ? 1 : 0);
  }
  
  query += " ORDER BY created_at DESC LIMIT ? OFFSET ?";
  params.push(limit, offset);
  
  const rows = db.prepare(query).all(...params) as any[];
  return rows.map((r) => ({
    ...r,
    is_spam: r.is_spam === 1,
  }));
}

export function getSampleCount(chatId: number): { spam: number; safe: number } {
  const spam = db.prepare(
    "SELECT COUNT(*) as c FROM samples WHERE chat_id = ? AND is_spam = 1"
  ).get(chatId) as any;
  const safe = db.prepare(
    "SELECT COUNT(*) as c FROM samples WHERE chat_id = ? AND is_spam = 0"
  ).get(chatId) as any;
  return { spam: spam?.c || 0, safe: safe?.c || 0 };
}

// ==================== 全局封禁 ====================
export interface GlobalBanEntry {
  user_id: number;
  user_name: string;
  reason: string;
  confidence: number;
  source_chat_id: number;
  created_at: string;
}

export function addGlobalBan(
  userId: number,
  userName: string,
  reason: string,
  confidence: number,
  sourceChatId: number
): void {
  db.prepare(
    `INSERT INTO global_bans (user_id, user_name, reason, confidence, source_chat_id)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(user_id) DO UPDATE SET
       user_name = excluded.user_name,
       reason = excluded.reason,
       confidence = excluded.confidence,
       source_chat_id = excluded.source_chat_id,
       created_at = excluded.created_at`
  ).run(userId, userName, reason, confidence, sourceChatId);
}

export function isGlobalBanned(userId: number): boolean {
  const row = db.prepare("SELECT 1 FROM global_bans WHERE user_id = ?").get(userId);
  return !!row;
}

export function getGlobalBanInfo(userId: number): GlobalBanEntry | null {
  return (db.prepare("SELECT * FROM global_bans WHERE user_id = ?").get(userId) as GlobalBanEntry) || null;
}

export function removeGlobalBan(userId: number): boolean {
  const result = db.prepare("DELETE FROM global_bans WHERE user_id = ?").run(userId);
  return result.changes > 0;
}

export function getAllEnabledGroups(): number[] {
  const rows = db.prepare("SELECT chat_id FROM groups WHERE enabled = 1").all() as any[];
  return rows.map((r) => r.chat_id);
}

export function getAllTrackedGroups(): number[] {
  const rows = db.prepare("SELECT chat_id FROM groups").all() as any[];
  return rows.map((r) => r.chat_id);
}

export function getGlobalBanEnabledGroups(): number[] {
  const rows = db.prepare("SELECT chat_id FROM groups WHERE global_ban_enabled = 1").all() as any[];
  return rows.map((r) => r.chat_id);
}

export function getGroupsWithRequiredChannel(): { chatId: number; requiredChannel: string }[] {
  const rows = db.prepare(`
    SELECT chat_id, required_channel
    FROM groups
    WHERE required_channel IS NOT NULL
      AND TRIM(required_channel) != ''
  `).all() as any[];
  return rows.map((r) => ({
    chatId: Number(r.chat_id),
    requiredChannel: String(r.required_channel || ""),
  }));
}

// ==================== 抽奖与活跃统计 ====================

// 增加用户每日发言计数
export function incrementUserMessageCount(chatId: number, userId: number): void {
  const dateStr = getChinaDateStr();
  db.prepare(`
    INSERT INTO user_daily_messages (chat_id, user_id, date, count)
    VALUES (?, ?, ?, 1)
    ON CONFLICT(chat_id, user_id, date) DO UPDATE SET count = count + 1
  `).run(chatId, userId, dateStr);
}

// 获取用户指定天数的发言总数
export function getUserMessageCount(chatId: number, userId: number, days: number): number {
  const fromDate = getChinaDateWindowStart(days);
  const row = db.prepare(`
    SELECT sum(count) as total
    FROM user_daily_messages
    WHERE chat_id = ? AND user_id = ? AND date >= ?
  `).get(chatId, userId, fromDate) as any;
  return row?.total || 0;
}

// 获取用户在“其他”群组中，指定天数内的最高发言总数
export function getUserMaxMessageCountAcrossGroups(userId: number, days: number, excludeChatId?: number): number {
  const fromDate = getChinaDateWindowStart(days);
  let query = `
    SELECT max(total_count) as max_count
    FROM (
      SELECT sum(count) as total_count
      FROM user_daily_messages
      WHERE user_id = ? AND date >= ?
  `;
  const params: any[] = [userId, fromDate];

  if (excludeChatId !== undefined) {
    query += ` AND chat_id != ? `;
    params.push(excludeChatId);
  }

  query += `
      GROUP BY chat_id
    )
  `;

  const row = db.prepare(query).get(...params) as any;
  return row?.max_count || 0;
}

// 获取用户在所有群组中的发言总数
export function getUserTotalMessageCountAcrossGroups(userId: number, days: number): number {
  const fromDate = getChinaDateWindowStart(days);
  const row = db.prepare(`
    SELECT sum(count) as total
    FROM user_daily_messages
    WHERE user_id = ? AND date >= ?
  `).get(userId, fromDate) as any;
  return row?.total || 0;
}

export function getTodayActiveSpeakerCount(chatId: number): number {
  const dateStr = getChinaDateStr();
  const row = db.prepare(`
    SELECT COUNT(*) AS total
    FROM user_daily_messages
    WHERE chat_id = ? AND date = ? AND count > 0
  `).get(chatId, dateStr) as any;
  return row?.total || 0;
}

export function getTodayActiveSpeakers(
  chatId: number,
  limit: number = 50
): { user_id: number; count: number }[] {
  const dateStr = getChinaDateStr();
  const safeLimit = Math.max(1, Math.min(5000, Math.floor(limit)));
  return db.prepare(`
    SELECT user_id, count
    FROM user_daily_messages
    WHERE chat_id = ? AND date = ? AND count > 0
    ORDER BY count DESC, user_id ASC
    LIMIT ?
  `).all(chatId, dateStr, safeLimit) as any[];
}

// 获取用户最近10天的发言总数
export function getUserMessageCountLast10Days(chatId: number, userId: number): number {
  return getUserMessageCount(chatId, userId, 10);
}

export interface Lottery {
  id: number;
  chat_id: number;
  creator_id: number;
  title: string;
  winner_count: number;
  prizes_json: string;
  message_id: number;
  status: 'active' | 'drawn';
  draw_condition: string;
  target_value: string;
  remark: string;
  min_activity: number;
  min_points: number;
  created_at: string;
}

export function createLottery(
  chatId: number,
  creatorId: number,
  title: string,
  winnerCount: number,
  prizesJson: string,
  drawCondition: string,
  targetValue: string,
  remark: string,
  minActivity: number,
  minPoints: number
): number {
  const result = db.prepare(`
    INSERT INTO lotteries (chat_id, creator_id, title, winner_count, prizes_json, draw_condition, target_value, remark, min_activity, min_points)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(chatId, creatorId, title, winnerCount, prizesJson, drawCondition, targetValue, remark, minActivity, minPoints);
  return result.lastInsertRowid as number;
}

export function updateLotteryMessageId(id: number, messageId: number): void {
  db.prepare(`UPDATE lotteries SET message_id = ? WHERE id = ?`).run(messageId, id);
}

export function finishLottery(id: number): void {
  db.prepare(`UPDATE lotteries SET status = 'drawn' WHERE id = ?`).run(id);
}

export function getLottery(id: number): Lottery | null {
  return (db.prepare(`SELECT * FROM lotteries WHERE id = ?`).get(id) as Lottery) || null;
}

export function getActiveLotteries(): Lottery[] {
  return db.prepare(`SELECT * FROM lotteries WHERE status = 'active'`).all() as Lottery[];
}

export function getLatestActiveLotteryByChat(chatId: number): Lottery | null {
  return (db.prepare(`
    SELECT *
    FROM lotteries
    WHERE chat_id = ? AND status = 'active'
    ORDER BY id DESC
    LIMIT 1
  `).get(chatId) as Lottery) || null;
}

export interface LotteryParticipant {
  lottery_id: number;
  user_id: number;
  username: string;
  fullname: string;
  joined_at: string;
}

export function joinLottery(lotteryId: number, userId: number, username: string, fullname: string): boolean {
  try {
    db.prepare(`
      INSERT INTO lottery_participants (lottery_id, user_id, username, fullname)
      VALUES (?, ?, ?, ?)
    `).run(lotteryId, userId, username, fullname);
    return true;
  } catch (error: any) {
    if (error.code === 'SQLITE_CONSTRAINT_PRIMARYKEY' || error.message.includes('UNIQUE')) {
      return false; // Already joined
    }
    throw error;
  }
}

export function hasLotteryParticipant(lotteryId: number, userId: number): boolean {
  const row = db.prepare(`
    SELECT 1
    FROM lottery_participants
    WHERE lottery_id = ? AND user_id = ?
    LIMIT 1
  `).get(lotteryId, userId);
  return !!row;
}

export function getLotteryParticipants(lotteryId: number): LotteryParticipant[] {
  return db.prepare(`SELECT * FROM lottery_participants WHERE lottery_id = ?`).all(lotteryId) as LotteryParticipant[];
}

export function getLotteryParticipantCount(lotteryId: number): number {
  const row = db.prepare(`SELECT count(*) as c FROM lottery_participants WHERE lottery_id = ?`).get(lotteryId) as any;
  return row?.c || 0;
}

// ==================== 狼人杀历史 ====================

export function recordWerewolfPlayers(chatId: number, players: { id: number; name: string }[]): void {
  // 1. 获取现有历史
  let history = getWerewolfHistory(chatId);

  // 2. 合并新玩家 (去重)
  const playerMap = new Map<number, { id: number; name: string }>();
  // 把旧的填进去
  history.forEach(p => playerMap.set(p.id, p));
  // 把新的覆盖或新增
  players.forEach(p => playerMap.set(p.id, p));

  // 3. 转换为数组并限制数量 (例如保留最近玩过的 100 个人)
  let updatedHistory = Array.from(playerMap.values());
  if (updatedHistory.length > 100) {
    updatedHistory = updatedHistory.slice(-100);
  }

  // 4. 写回数据库
  db.prepare(`
    INSERT INTO werewolf_history (chat_id, players_json, updated_at)
    VALUES (?, ?, datetime('now'))
    ON CONFLICT(chat_id) DO UPDATE SET
      players_json = excluded.players_json,
      updated_at = excluded.updated_at
  `).run(chatId, JSON.stringify(updatedHistory));
}

export function getWerewolfHistory(chatId: number): { id: number; name: string }[] {
  const row = db.prepare(`SELECT players_json FROM werewolf_history WHERE chat_id = ?`).get(chatId) as any;
  if (!row) return [];
  try {
    return JSON.parse(row.players_json);
  } catch {
    return [];
  }
}

// ==================== 积分与邀请系统 ====================

export function addUserPoints(chat_id: number, user_id: number, amount: number): number {
  if (!isPointsEnabled(chat_id)) return 0;
  const dateStr = getChinaDateStr();
  
  // 1. 检查今日已获积分
  const daily = db.prepare(`
    SELECT points_earned FROM user_daily_messages 
    WHERE chat_id = ? AND user_id = ? AND date = ?
  `).get(chat_id, user_id, dateStr) as any;
  
  const earnedToday = daily?.points_earned || 0;
  const canEarn = Math.max(0, 10 - earnedToday);
  const actualAmount = Math.min(amount, canEarn);
  
  if (actualAmount <= 0) return 0;

  // 2. 更新每日积分
  db.prepare(`
    UPDATE user_daily_messages SET points_earned = points_earned + ?
    WHERE chat_id = ? AND user_id = ? AND date = ?
  `).run(actualAmount, chat_id, user_id, dateStr);

  // 3. 更新总积分
  db.prepare(`
    INSERT INTO user_points (chat_id, user_id, points)
    VALUES (?, ?, ?)
    ON CONFLICT(chat_id, user_id) DO UPDATE SET points = points + ?
  `).run(chat_id, user_id, actualAmount, actualAmount);

  // 4. 记录流水
  logPointChange(chat_id, user_id, actualAmount, "活跃发言");

  return actualAmount;
}

export function logPointChange(chatId: number, userId: number, amount: number, reason: string): void {
  db.prepare(`
    INSERT INTO point_logs (chat_id, user_id, amount, reason)
    VALUES (?, ?, ?, ?)
  `).run(chatId, userId, amount, reason);
}

export function creditUserPoints(chatId: number, userId: number, amount: number, reason: string = "积分增加"): boolean {
  const safeAmount = Math.max(0, Math.floor(Number(amount) || 0));
  if (safeAmount <= 0) return false;
  ensureGroupRow(chatId);
  ensureUserPointsRow(chatId, userId);
  db.prepare(`
    UPDATE user_points
    SET points = points + ?
    WHERE chat_id = ? AND user_id = ?
  `).run(safeAmount, chatId, userId);
  logPointChange(chatId, userId, safeAmount, reason);
  return true;
}

function ensureUserPointsRow(chatId: number, userId: number): void {
  db.prepare(`
    INSERT OR IGNORE INTO user_points (chat_id, user_id, points)
    VALUES (?, ?, 0)
  `).run(chatId, userId);
}

function getRawUserPoints(chatId: number, userId: number): number {
  const row = db.prepare(`SELECT points FROM user_points WHERE chat_id = ? AND user_id = ?`).get(chatId, userId) as any;
  return Math.max(0, Number(row?.points || 0));
}

export type OilStealResult =
  | { kind: "daily_limited"; targetAttemptsToday: number }
  | { kind: "target_protected"; targetAttemptsToday: number }
  | { kind: "thief_points_too_low"; thiefPoints: number }
  | { kind: "target_points_too_low"; targetPoints: number }
  | {
      kind: "failed" | "success" | "backfire";
      desiredPoints: number;
      actualPoints: number;
      targetAttemptsToday: number;
      thiefPointsAfter: number;
      targetPointsAfter: number;
    };

export function performOilSteal(chatId: number, thiefUserId: number, targetUserId: number): OilStealResult {
  const tx = db.transaction((safeChatId: number, safeThiefId: number, safeTargetId: number): OilStealResult => {
    const dateStr = getChinaDateStr();
    const thiefTodayRow = db.prepare(`
      SELECT COUNT(*) AS cnt
      FROM oil_steal_attempts
      WHERE chat_id = ? AND thief_user_id = ? AND date = ?
    `).get(safeChatId, safeThiefId, dateStr) as any;
    if ((thiefTodayRow?.cnt || 0) >= 1) {
      const targetTodayRow = db.prepare(`
        SELECT COUNT(*) AS cnt
        FROM oil_steal_attempts
        WHERE chat_id = ? AND target_user_id = ? AND date = ?
      `).get(safeChatId, safeTargetId, dateStr) as any;
      return {
        kind: "daily_limited",
        targetAttemptsToday: Number(targetTodayRow?.cnt || 0),
      };
    }

    const targetTodayRow = db.prepare(`
      SELECT COUNT(*) AS cnt
      FROM oil_steal_attempts
      WHERE chat_id = ? AND target_user_id = ? AND date = ?
    `).get(safeChatId, safeTargetId, dateStr) as any;
    const targetAttemptsToday = Number(targetTodayRow?.cnt || 0);
    if (targetAttemptsToday >= 8) {
      return {
        kind: "target_protected",
        targetAttemptsToday,
      };
    }

    const thiefCurrentPoints = getRawUserPoints(safeChatId, safeThiefId);
    if (thiefCurrentPoints < 100) {
      return {
        kind: "thief_points_too_low",
        thiefPoints: thiefCurrentPoints,
      };
    }

    const targetCurrentPoints = getRawUserPoints(safeChatId, safeTargetId);
    if (targetCurrentPoints < 100) {
      return {
        kind: "target_points_too_low",
        targetPoints: targetCurrentPoints,
      };
    }

    const roll = Math.random();
    let kind: "failed" | "success" | "backfire" = "failed";
    let desiredPoints = 0;
    if (roll < 0.5) {
      kind = "failed";
    } else if (roll < 0.7) {
      kind = "success";
      desiredPoints = 1 + Math.floor(Math.random() * 3);
    } else if (roll < 0.9) {
      kind = "backfire";
      desiredPoints = 1 + Math.floor(Math.random() * 3);
    } else if (roll < 0.95) {
      kind = "success";
      desiredPoints = 4 + Math.floor(Math.random() * 2);
    } else {
      kind = "backfire";
      desiredPoints = 4 + Math.floor(Math.random() * 2);
    }

    let actualPoints = 0;
    let thiefPointsAfter = thiefCurrentPoints;
    let targetPointsAfter = targetCurrentPoints;

    if (kind === "success") {
      actualPoints = Math.min(desiredPoints, targetPointsAfter);
      if (actualPoints > 0) {
        ensureUserPointsRow(safeChatId, safeThiefId);
        ensureUserPointsRow(safeChatId, safeTargetId);
        db.prepare(`UPDATE user_points SET points = points + ? WHERE chat_id = ? AND user_id = ?`).run(actualPoints, safeChatId, safeThiefId);
        db.prepare(`UPDATE user_points SET points = points - ? WHERE chat_id = ? AND user_id = ?`).run(actualPoints, safeChatId, safeTargetId);
        logPointChange(safeChatId, safeThiefId, actualPoints, "小鼠偷家");
        logPointChange(safeChatId, safeTargetId, -actualPoints, "小鼠偷家");
        thiefPointsAfter += actualPoints;
        targetPointsAfter -= actualPoints;
      }
    } else if (kind === "backfire") {
      actualPoints = Math.min(desiredPoints, thiefPointsAfter);
      if (actualPoints > 0) {
        ensureUserPointsRow(safeChatId, safeThiefId);
        ensureUserPointsRow(safeChatId, safeTargetId);
        db.prepare(`UPDATE user_points SET points = points - ? WHERE chat_id = ? AND user_id = ?`).run(actualPoints, safeChatId, safeThiefId);
        db.prepare(`UPDATE user_points SET points = points + ? WHERE chat_id = ? AND user_id = ?`).run(actualPoints, safeChatId, safeTargetId);
        logPointChange(safeChatId, safeThiefId, -actualPoints, "关门打鼠");
        logPointChange(safeChatId, safeTargetId, actualPoints, "关门打鼠");
        thiefPointsAfter -= actualPoints;
        targetPointsAfter += actualPoints;
      }
    }

    db.prepare(`
      INSERT INTO oil_steal_attempts (chat_id, thief_user_id, target_user_id, date, outcome, desired_points, actual_points)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(safeChatId, safeThiefId, safeTargetId, dateStr, kind, desiredPoints, actualPoints);

    return {
      kind,
      desiredPoints,
      actualPoints,
      targetAttemptsToday: targetAttemptsToday + 1,
      thiefPointsAfter,
      targetPointsAfter,
    };
  });

  return tx(chatId, thiefUserId, targetUserId);
}

export function getTodayOilStealAttempts(
  chatId: number,
  limit: number = 20,
  targetUserId?: number,
  daysAgo: number = 0,
  daysWindow: number = 1
): Array<{
  thief_user_id: number;
  target_user_id: number;
  outcome: string;
  desired_points: number;
  actual_points: number;
  created_at: string;
}> {
  const safeDaysAgo = Math.max(0, Math.min(30, Math.floor(Number(daysAgo) || 0)));
  const safeDaysWindow = Math.max(1, Math.min(30, Math.floor(Number(daysWindow) || 1)));
  const endDateStr = getChinaDateStr(Date.now() - safeDaysAgo * DAY_MS);
  const startDateStr = getChinaDateStr(Date.now() - (safeDaysAgo + safeDaysWindow - 1) * DAY_MS);
  const safeLimit = Math.max(1, Math.min(100, Math.floor(limit)));
  if (Number.isFinite(targetUserId) && Number(targetUserId) > 0) {
    return db.prepare(`
      SELECT thief_user_id, target_user_id, outcome, desired_points, actual_points, created_at
      FROM oil_steal_attempts
      WHERE chat_id = ? AND date >= ? AND date <= ? AND target_user_id = ?
      ORDER BY created_at DESC, id DESC
      LIMIT ?
    `).all(chatId, startDateStr, endDateStr, Number(targetUserId), safeLimit) as any[];
  }
  return db.prepare(`
    SELECT thief_user_id, target_user_id, outcome, desired_points, actual_points, created_at
    FROM oil_steal_attempts
    WHERE chat_id = ? AND date >= ? AND date <= ?
    ORDER BY created_at DESC, id DESC
    LIMIT ?
  `).all(chatId, startDateStr, endDateStr, safeLimit) as any[];
}

export function getPointLogs(chatId: number, userId: number, limit: number = 10, offset: number = 0): { id: number; amount: number; reason: string; created_at: string }[] {
  return db.prepare(`
    SELECT id, amount, reason, created_at
    FROM point_logs
    WHERE chat_id = ? AND user_id = ?
    ORDER BY created_at DESC, id DESC
    LIMIT ? OFFSET ?
  `).all(chatId, userId, limit, offset) as any[];
}

export function getUserPoints(chatId: number, userId: number): { total: number; today: number } {
  const dateStr = getChinaDateStr();
  
  const totalRow = db.prepare(`SELECT points FROM user_points WHERE chat_id = ? AND user_id = ?`).get(chatId, userId) as any;
  const todayRow = db.prepare(`SELECT points_earned FROM user_daily_messages WHERE chat_id = ? AND user_id = ? AND date = ?`).get(chatId, userId, dateStr) as any;
  
  return {
    total: totalRow?.points || 0,
    today: todayRow?.points_earned || 0
  };
}

export function importUserPoints(
  chatId: number,
  userId: number,
  amount: number,
  mode: "set" | "add" = "set",
  reason?: string
): { oldPoints: number; newPoints: number; delta: number } {
  const safeUserId = Math.trunc(userId);
  const safeAmount = Math.trunc(amount);
  if (!Number.isFinite(safeUserId) || safeUserId <= 0) {
    throw new Error("invalid user id");
  }
  if (!Number.isFinite(safeAmount)) {
    throw new Error("invalid points");
  }

  ensureGroupRow(chatId);
  const row = db.prepare(`SELECT points FROM user_points WHERE chat_id = ? AND user_id = ?`).get(chatId, safeUserId) as any;
  const oldPoints = Math.max(0, Number(row?.points || 0));

  let newPoints = mode === "add" ? oldPoints + safeAmount : safeAmount;
  if (newPoints < 0) newPoints = 0;

  db.prepare(`
    INSERT INTO user_points (chat_id, user_id, points)
    VALUES (?, ?, ?)
    ON CONFLICT(chat_id, user_id) DO UPDATE SET points = excluded.points
  `).run(chatId, safeUserId, newPoints);

  const delta = newPoints - oldPoints;
  if (delta !== 0) {
    logPointChange(
      chatId,
      safeUserId,
      delta,
      reason || (mode === "add" ? "积分导入(追加)" : "积分导入(覆盖)")
    );
  }

  return { oldPoints, newPoints, delta };
}

export function getPointsLeaderboardCount(chatId: number): number {
  const row = db.prepare(`
    SELECT COUNT(*) AS cnt
    FROM user_points
    WHERE chat_id = ? AND points > 0
  `).get(chatId) as any;
  return row?.cnt || 0;
}

export function getPointsLeaderboard(
  chatId: number,
  limit: number = 10,
  offset: number = 0
): { user_id: number; points: number }[] {
  const safeLimit = Math.max(1, Math.min(100, Math.floor(limit)));
  const safeOffset = Math.max(0, Math.floor(offset));
  return db.prepare(`
    SELECT user_id, points
    FROM user_points
    WHERE chat_id = ? AND points > 0
    ORDER BY points DESC, user_id ASC
    LIMIT ? OFFSET ?
  `).all(chatId, safeLimit, safeOffset) as any[];
}

export function getUserPointsRank(chatId: number, userId: number): number | null {
  const me = db.prepare(`
    SELECT points
    FROM user_points
    WHERE chat_id = ? AND user_id = ?
  `).get(chatId, userId) as any;
  if (!me || me.points <= 0) return null;

  const row = db.prepare(`
    SELECT COUNT(*) AS higher_count
    FROM user_points
    WHERE chat_id = ?
      AND points > 0
      AND (
        points > ?
        OR (points = ? AND user_id < ?)
      )
  `).get(chatId, me.points, me.points, userId) as any;

  return (row?.higher_count || 0) + 1;
}

export function setInvitationRequired(chatId: number, required: boolean): void {
  ensureGroupRow(chatId);
  db.prepare("UPDATE groups SET invitation_required = ? WHERE chat_id = ?").run(required ? 1 : 0, chatId);
}

export function setVoucherPrice(chatId: number, price: number): void {
  ensureGroupRow(chatId);
  db.prepare("UPDATE groups SET voucher_price = ? WHERE chat_id = ?").run(price, chatId);
}

export function getInvitationConfig(chatId: number): { required: boolean; price: number; requiredChannel: string } {
  const row = db.prepare("SELECT invitation_required, voucher_price, required_channel FROM groups WHERE chat_id = ?").get(chatId) as any;
  return {
    required: row?.invitation_required === 1,
    price: row?.voucher_price ?? 100,
    requiredChannel: row?.required_channel || ""
  };
}

export function setRequiredChannel(chatId: number, channel: string): void {
  ensureGroupRow(chatId);
  db.prepare("UPDATE groups SET required_channel = ? WHERE chat_id = ?").run(channel, chatId);
}

export function createInviteVoucher(chatId: number, userId: number, code: string): boolean {
  try {
    db.prepare(`
      INSERT INTO invite_vouchers (code, chat_id, creator_id)
      VALUES (?, ?, ?)
    `).run(code, chatId, userId);
    return true;
  } catch {
    return false;
  }
}

export function revokeInviteVoucher(chatId: number, code: string): "revoked" | "used" | "not_found" | "already_revoked" {
  const row = db.prepare(`
    SELECT status FROM invite_vouchers
    WHERE chat_id = ? AND code = ?
  `).get(chatId, code) as any;

  if (!row) return "not_found";
  if (row.status === "used") return "used";
  if (row.status === "revoked") return "already_revoked";

  db.prepare(`
    UPDATE invite_vouchers
    SET status = 'revoked'
    WHERE chat_id = ? AND code = ? AND status = 'active'
  `).run(chatId, code);

  return "revoked";
}

export function consumePoints(chatId: number, userId: number, amount: number, reason: string = "积分支出"): boolean {
  if (!isPointsEnabled(chatId)) return false;
  const current = db.prepare(`SELECT points FROM user_points WHERE chat_id = ? AND user_id = ?`).get(chatId, userId) as any;
  if (!current || current.points < amount) return false;

  db.prepare(`UPDATE user_points SET points = points - ? WHERE chat_id = ? AND user_id = ?`).run(amount, chatId, userId);
  
  // 记录流水
  logPointChange(chatId, userId, -amount, reason);
  
  return true;
}

export function verifyAndUseVoucher(chatId: number, userId: number, code: string): boolean {
  const voucher = db.prepare(`SELECT * FROM invite_vouchers WHERE code = ? AND chat_id = ? AND status = 'active'`).get(code, chatId) as any;
  if (!voucher) return false;

  db.prepare(`UPDATE invite_vouchers SET status = 'used', used_by_id = ? WHERE code = ?`).run(userId, code);
  return true;
}

export function getInviterInfo(chatId: number, userId: number): { id: number; username?: string; name?: string } | null {
  const row = db.prepare(`
    SELECT v.creator_id as id 
    FROM invite_vouchers v
    WHERE v.chat_id = ? AND v.used_by_id = ?
    LIMIT 1
  `).get(chatId, userId) as any;
  
  if (!row) return null;
  return { id: row.id };
}

export function getUserVouchers(chatId: number, userId: number): { code: string; status: string; created_at: string }[] {
  return db.prepare(`
    SELECT code, status, created_at
    FROM invite_vouchers
    WHERE chat_id = ? AND creator_id = ?
    ORDER BY created_at DESC
  `).all(chatId, userId) as any[];
}

export function getInviteVoucherLogs(
  chatId: number,
  limit?: number
): { code: string; status: string; creator_id: number; used_by_id: number | null; created_at: string }[] {
  const safeLimit = Number(limit);
  if (Number.isFinite(safeLimit) && safeLimit > 0) {
    return db.prepare(`
      SELECT code, status, creator_id, used_by_id, created_at
      FROM invite_vouchers
      WHERE chat_id = ?
      ORDER BY created_at DESC
      LIMIT ?
    `).all(chatId, Math.floor(safeLimit)) as any[];
  }

  return db.prepare(`
    SELECT code, status, creator_id, used_by_id, created_at
    FROM invite_vouchers
    WHERE chat_id = ?
    ORDER BY created_at DESC
  `).all(chatId) as any[];
}

export function addUnverifiedMember(chatId: number, userId: number, welcomeMsgId: number): void {
  db.prepare(`
    INSERT INTO unverified_members (chat_id, user_id, welcome_msg_id)
    VALUES (?, ?, ?)
    ON CONFLICT(chat_id, user_id) DO UPDATE SET
      welcome_msg_id = excluded.welcome_msg_id,
      joined_at = datetime('now')
  `).run(chatId, userId, welcomeMsgId);
}

export function isUnverifiedMember(chatId: number, userId: number): boolean {
  const row = db.prepare(`SELECT 1 FROM unverified_members WHERE chat_id = ? AND user_id = ?`).get(chatId, userId);
  return !!row;
}

export function removeUnverifiedMember(chatId: number, userId: number): { welcomeMsgId: number } | null {
  const row = db.prepare(`SELECT welcome_msg_id FROM unverified_members WHERE chat_id = ? AND user_id = ?`).get(chatId, userId) as any;
  db.prepare(`DELETE FROM unverified_members WHERE chat_id = ? AND user_id = ?`).run(chatId, userId);
  return row ? { welcomeMsgId: row.welcome_msg_id } : null;
}

export function getUnverifiedMemberChatId(userId: number): number | null {
  const row = db.prepare(`SELECT chat_id FROM unverified_members WHERE user_id = ? ORDER BY joined_at DESC LIMIT 1`).get(userId) as any;
  return row ? Number(row.chat_id) : null;
}

export function getExpiredUnverifiedMembers(minutes: number): { chat_id: number; user_id: number; welcome_msg_id: number }[] {
  return db.prepare(`
    SELECT chat_id, user_id, welcome_msg_id 
    FROM unverified_members 
    WHERE joined_at < datetime('now', '-' || ? || ' minutes')
  `).all(minutes) as any[];
}

export function markChannelGuardMember(chatId: number, userId: number): void {
  db.prepare(`
    INSERT INTO channel_guard_members (chat_id, user_id)
    VALUES (?, ?)
    ON CONFLICT(chat_id, user_id) DO UPDATE SET joined_at = datetime('now')
  `).run(chatId, userId);
}

export function isChannelGuardMember(chatId: number, userId: number): boolean {
  const row = db.prepare(`
    SELECT 1
    FROM channel_guard_members
    WHERE chat_id = ? AND user_id = ?
  `).get(chatId, userId);
  return !!row;
}

export function unmarkChannelGuardMember(chatId: number, userId: number): void {
  db.prepare(`
    DELETE FROM channel_guard_members
    WHERE chat_id = ? AND user_id = ?
  `).run(chatId, userId);
}

export function upsertChatUserProfile(chatId: number, userId: number, username?: string, displayName?: string): void {
  const normalizedUsername = String(username || "").trim().replace(/^@+/, "").toLowerCase();
  const normalizedName = String(displayName || "").trim().slice(0, 200);

  if (normalizedUsername) {
    db.prepare(`
      DELETE FROM chat_user_profiles
      WHERE chat_id = ? AND username = ? AND user_id != ?
    `).run(chatId, normalizedUsername, userId);
  }

  db.prepare(`
    INSERT INTO chat_user_profiles (chat_id, user_id, username, display_name, updated_at)
    VALUES (?, ?, ?, ?, datetime('now'))
    ON CONFLICT(chat_id, user_id) DO UPDATE SET
      username = excluded.username,
      display_name = excluded.display_name,
      updated_at = excluded.updated_at
  `).run(chatId, userId, normalizedUsername, normalizedName);
}

export function findChatUserIdByUsername(chatId: number, username: string): number | null {
  const normalized = String(username || "").trim().replace(/^@+/, "").toLowerCase();
  if (!normalized) return null;
  const row = db.prepare(`
    SELECT user_id
    FROM chat_user_profiles
    WHERE chat_id = ? AND username = ?
    ORDER BY updated_at DESC
    LIMIT 1
  `).get(chatId, normalized) as any;
  return row ? Number(row.user_id) : null;
}

export function getChatUserProfile(chatId: number, userId: number): ChatUserProfile | null {
  const row = db.prepare(`
    SELECT chat_id, user_id, username, display_name, updated_at
    FROM chat_user_profiles
    WHERE chat_id = ? AND user_id = ?
    LIMIT 1
  `).get(chatId, userId) as ChatUserProfile | undefined;
  return row || null;
}

export function addPointsAdminUser(chatId: number, userId: number, addedBy: number): void {
  db.prepare(`
    INSERT INTO points_admin_users (chat_id, user_id, added_by)
    VALUES (?, ?, ?)
    ON CONFLICT(chat_id, user_id) DO UPDATE SET
      added_by = excluded.added_by,
      created_at = datetime('now')
  `).run(chatId, userId, addedBy);
}

export function removePointsAdminUser(chatId: number, userId: number): boolean {
  const result = db.prepare(`
    DELETE FROM points_admin_users
    WHERE chat_id = ? AND user_id = ?
  `).run(chatId, userId);
  return result.changes > 0;
}

export function isPointsAdminUser(chatId: number, userId: number): boolean {
  const row = db.prepare(`
    SELECT 1
    FROM points_admin_users
    WHERE chat_id = ? AND user_id = ?
  `).get(chatId, userId);
  return !!row;
}

export function getPointsAdminUsers(chatId: number): { user_id: number; added_by: number; created_at: string }[] {
  return db.prepare(`
    SELECT user_id, added_by, created_at
    FROM points_admin_users
    WHERE chat_id = ?
    ORDER BY created_at DESC, user_id ASC
  `).all(chatId) as any[];
}

export function addAssistantAllowedUser(chatId: number, userId: number, addedBy: number): void {
  db.prepare(`
    INSERT INTO assistant_allowed_users (chat_id, user_id, added_by)
    VALUES (?, ?, ?)
    ON CONFLICT(chat_id, user_id) DO UPDATE SET
      added_by = excluded.added_by,
      created_at = datetime('now')
  `).run(chatId, userId, addedBy);
}

export function removeAssistantAllowedUser(chatId: number, userId: number): boolean {
  const result = db.prepare(`
    DELETE FROM assistant_allowed_users
    WHERE chat_id = ? AND user_id = ?
  `).run(chatId, userId);
  return result.changes > 0;
}

export function isAssistantAllowedUser(chatId: number, userId: number): boolean {
  const row = db.prepare(`
    SELECT 1
    FROM assistant_allowed_users
    WHERE chat_id = ? AND user_id = ?
  `).get(chatId, userId);
  return !!row;
}

export function getAssistantAllowedUsers(chatId: number): { user_id: number; added_by: number; created_at: string }[] {
  return db.prepare(`
    SELECT user_id, added_by, created_at
    FROM assistant_allowed_users
    WHERE chat_id = ?
    ORDER BY created_at DESC, user_id ASC
  `).all(chatId) as any[];
}

export interface AssistantGuardConfig {
  chat_id: number;
  provoke_bot_enabled: number;
  provoke_mode: string;
  mute_minutes: number;
  updated_by: number;
  updated_at: string;
}

export function getAssistantGuardConfig(chatId: number): AssistantGuardConfig {
  const row = db.prepare(`
    SELECT chat_id, provoke_bot_enabled, provoke_mode, mute_minutes, updated_by, updated_at
    FROM assistant_guard_configs
    WHERE chat_id = ?
  `).get(chatId) as AssistantGuardConfig | undefined;

  return row || {
    chat_id: chatId,
    provoke_bot_enabled: 0,
    provoke_mode: "",
    mute_minutes: 10,
    updated_by: 0,
    updated_at: "",
  };
}

export function setAssistantProvokeGuard(chatId: number, enabled: boolean, mode: string, muteMinutes: number, updatedBy: number): void {
  const safeMode = String(mode || "").trim() || "warn_then_mute";
  const safeMinutes = Math.max(1, Math.min(24 * 60, Math.floor(muteMinutes) || 10));
  db.prepare(`
    INSERT INTO assistant_guard_configs (chat_id, provoke_bot_enabled, provoke_mode, mute_minutes, updated_by, updated_at)
    VALUES (?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(chat_id) DO UPDATE SET
      provoke_bot_enabled = excluded.provoke_bot_enabled,
      provoke_mode = excluded.provoke_mode,
      mute_minutes = excluded.mute_minutes,
      updated_by = excluded.updated_by,
      updated_at = excluded.updated_at
  `).run(chatId, enabled ? 1 : 0, safeMode, safeMinutes, updatedBy);
}

export function noteAssistantGuardWarning(chatId: number, userId: number): void {
  db.prepare(`
    INSERT INTO assistant_guard_warnings (chat_id, user_id, warned_at)
    VALUES (?, ?, datetime('now'))
    ON CONFLICT(chat_id, user_id) DO UPDATE SET
      warned_at = excluded.warned_at
  `).run(chatId, userId);
}

export function hasRecentAssistantGuardWarning(chatId: number, userId: number, withinHours: number = 24): boolean {
  const safeHours = Math.max(1, Math.min(24 * 30, Math.floor(withinHours) || 24));
  const row = db.prepare(`
    SELECT 1
    FROM assistant_guard_warnings
    WHERE chat_id = ? AND user_id = ? AND warned_at >= datetime('now', ?)
  `).get(chatId, userId, `-${safeHours} hours`);
  return !!row;
}

export function clearAssistantGuardWarning(chatId: number, userId: number): void {
  db.prepare(`
    DELETE FROM assistant_guard_warnings
    WHERE chat_id = ? AND user_id = ?
  `).run(chatId, userId);
}

export function getAssistantMemory(chatId: number, userId: number): string {
  const row = db.prepare(`
    SELECT note
    FROM assistant_memories
    WHERE chat_id = ? AND user_id = ?
  `).get(chatId, userId) as any;
  return String(row?.note || "").trim();
}

export function appendAssistantMemory(chatId: number, userId: number, note: string): string {
  const normalized = String(note || "").replace(/\s+/g, " ").trim();
  if (!normalized) return getAssistantMemory(chatId, userId);

  const current = getAssistantMemory(chatId, userId);
  const merged = [current, normalized].filter(Boolean).join("\n").slice(0, 2000);
  db.prepare(`
    INSERT INTO assistant_memories (chat_id, user_id, note, updated_at)
    VALUES (?, ?, ?, datetime('now'))
    ON CONFLICT(chat_id, user_id) DO UPDATE SET
      note = excluded.note,
      updated_at = excluded.updated_at
  `).run(chatId, userId, merged);
  return merged;
}

export function clearAssistantMemory(chatId: number, userId: number): void {
  db.prepare(`
    DELETE FROM assistant_memories
    WHERE chat_id = ? AND user_id = ?
  `).run(chatId, userId);
}

export interface AssistantAuditLogEntry {
  id: number;
  chat_id: number;
  user_id: number;
  request_text: string;
  parsed_action: string;
  status: string;
  result_text: string;
  created_at: string;
}

export function addAssistantAuditLog(
  chatId: number,
  userId: number,
  requestText: string,
  parsedAction: string,
  status: string,
  resultText: string
): void {
  db.prepare(`
    INSERT INTO assistant_audit_logs (
      chat_id, user_id, request_text, parsed_action, status, result_text
    )
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    chatId,
    userId,
    String(requestText || "").slice(0, 2000),
    String(parsedAction || "").slice(0, 4000),
    String(status || "").slice(0, 100),
    String(resultText || "").slice(0, 4000)
  );
}

export function getAssistantAuditLogs(chatId: number, limit: number = 10): AssistantAuditLogEntry[] {
  const safeLimit = Math.max(1, Math.min(50, Math.floor(limit)));
  return db.prepare(`
    SELECT id, chat_id, user_id, request_text, parsed_action, status, result_text, created_at
    FROM assistant_audit_logs
    WHERE chat_id = ?
    ORDER BY created_at DESC, id DESC
    LIMIT ?
  `).all(chatId, safeLimit) as AssistantAuditLogEntry[];
}

db.exec(`
  CREATE TABLE IF NOT EXISTS app_settings (
    key TEXT PRIMARY KEY,
    value TEXT DEFAULT '',
    updated_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS commercial_users (
    user_id INTEGER PRIMARY KEY,
    username TEXT DEFAULT '',
    display_name TEXT DEFAULT '',
    email TEXT DEFAULT '',
    frozen INTEGER NOT NULL DEFAULT 0,
    frozen_note TEXT DEFAULT '',
    balance_cents INTEGER NOT NULL DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS commercial_login_codes (
    code TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL,
    expires_at TEXT NOT NULL,
    consumed_at TEXT DEFAULT '',
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS commercial_sessions (
    session_token TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL,
    proof_hash TEXT NOT NULL DEFAULT '',
    expires_at TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS commercial_subscriptions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    product_key TEXT NOT NULL DEFAULT '',
    plan_code TEXT NOT NULL DEFAULT 'pro',
    status TEXT NOT NULL DEFAULT 'active',
    starts_at TEXT NOT NULL,
    ends_at TEXT NOT NULL,
    source TEXT DEFAULT '',
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS commercial_orders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    order_no TEXT NOT NULL DEFAULT '',
    user_id INTEGER NOT NULL,
    order_type TEXT NOT NULL DEFAULT 'subscription',
    product_key TEXT NOT NULL DEFAULT '',
    plan_code TEXT NOT NULL,
    months INTEGER NOT NULL DEFAULT 1,
    amount_cents INTEGER NOT NULL DEFAULT 0,
    payment_method TEXT NOT NULL DEFAULT '',
    gateway_trade_no TEXT DEFAULT '',
    paid_at TEXT DEFAULT '',
    meta_json TEXT DEFAULT '{}',
    status TEXT NOT NULL DEFAULT 'pending',
    note TEXT DEFAULT '',
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS commercial_chats (
    chat_id INTEGER PRIMARY KEY,
    owner_user_id INTEGER NOT NULL,
    chat_type TEXT NOT NULL DEFAULT 'group',
    title TEXT DEFAULT '',
    username TEXT DEFAULT '',
    claimed_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS commercial_chat_welcome_configs (
    chat_id INTEGER PRIMARY KEY,
    enabled INTEGER NOT NULL DEFAULT 0,
    message_text TEXT DEFAULT '',
    buttons_json TEXT DEFAULT '[]',
    updated_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS commercial_points_mall_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    chat_id INTEGER NOT NULL,
    source_product_id INTEGER NOT NULL DEFAULT 0,
    title TEXT NOT NULL DEFAULT '',
    description TEXT DEFAULT '',
    points_cost INTEGER NOT NULL DEFAULT 0,
    redeem_cycle TEXT NOT NULL DEFAULT 'none',
    repeat_markup_percent INTEGER NOT NULL DEFAULT 0,
    stock INTEGER NOT NULL DEFAULT 0,
    stock_enabled INTEGER NOT NULL DEFAULT 0,
    enabled INTEGER NOT NULL DEFAULT 1,
    sort_order INTEGER NOT NULL DEFAULT 0,
    promo_scene TEXT NOT NULL DEFAULT 'purchase',
    promo_type TEXT NOT NULL DEFAULT 'percent',
    promo_value REAL NOT NULL DEFAULT 0,
    promo_cycles TEXT DEFAULT '',
    promo_appliesto TEXT DEFAULT '',
    promo_requires TEXT DEFAULT '',
    promo_recurring INTEGER NOT NULL DEFAULT 0,
    promo_recurfor INTEGER NOT NULL DEFAULT 0,
    promo_requires_exist INTEGER NOT NULL DEFAULT 0,
    promo_max_times INTEGER NOT NULL DEFAULT 1,
    promo_lifelong INTEGER NOT NULL DEFAULT 0,
    promo_one_time INTEGER NOT NULL DEFAULT 1,
    promo_only_new_client INTEGER NOT NULL DEFAULT 0,
    promo_only_old_client INTEGER NOT NULL DEFAULT 0,
    promo_once_per_client INTEGER NOT NULL DEFAULT 1,
    promo_start_time TEXT DEFAULT '',
    promo_expiration_time TEXT DEFAULT '',
    promo_validity_mode TEXT NOT NULL DEFAULT 'default',
    promo_notes TEXT DEFAULT '',
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS commercial_points_mall_orders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    order_no TEXT NOT NULL DEFAULT '',
    chat_id INTEGER NOT NULL,
    item_id INTEGER NOT NULL,
    item_title TEXT NOT NULL DEFAULT '',
    user_id INTEGER NOT NULL,
    username TEXT DEFAULT '',
    display_name TEXT DEFAULT '',
    points_cost INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'issued',
    zjmf_exchange_no TEXT DEFAULT '',
    zjmf_promo_id INTEGER NOT NULL DEFAULT 0,
    zjmf_promo_code TEXT DEFAULT '',
    zjmf_redeemed INTEGER NOT NULL DEFAULT 0,
    zjmf_redeemed_at TEXT DEFAULT '',
    result_json TEXT DEFAULT '{}',
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS commercial_points_mall_configs (
    chat_id INTEGER PRIMARY KEY,
    provider TEXT NOT NULL DEFAULT 'zjmf',
    custom_api_url TEXT DEFAULT '',
    custom_api_token TEXT DEFAULT '',
    updated_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS commercial_ai_configs (
    user_id INTEGER PRIMARY KEY,
    enabled INTEGER NOT NULL DEFAULT 0,
    base_url TEXT DEFAULT '',
    api_key TEXT DEFAULT '',
    model TEXT DEFAULT '',
    api_style TEXT DEFAULT 'auto',
    updated_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS commercial_subscription_reminders (
    chat_id INTEGER NOT NULL,
    subscription_id INTEGER NOT NULL,
    remind_date TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now')),
    PRIMARY KEY (chat_id, subscription_id, remind_date)
  );

  CREATE TABLE IF NOT EXISTS commercial_products (
    product_key TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    plan_code TEXT NOT NULL DEFAULT 'pro',
    months INTEGER NOT NULL DEFAULT 1,
    amount_cents INTEGER NOT NULL DEFAULT 0,
    chat_limit INTEGER NOT NULL DEFAULT 5,
    description TEXT DEFAULT '',
    active INTEGER NOT NULL DEFAULT 1,
    sort_order INTEGER NOT NULL DEFAULT 0,
    updated_at TEXT DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_commercial_login_codes_user
    ON commercial_login_codes(user_id, created_at DESC);

  CREATE INDEX IF NOT EXISTS idx_commercial_sessions_user
    ON commercial_sessions(user_id, created_at DESC);

  CREATE INDEX IF NOT EXISTS idx_commercial_subscriptions_user_end
    ON commercial_subscriptions(user_id, ends_at DESC);

  CREATE INDEX IF NOT EXISTS idx_commercial_orders_user_time
    ON commercial_orders(user_id, created_at DESC);

  CREATE INDEX IF NOT EXISTS idx_commercial_chats_owner
    ON commercial_chats(owner_user_id, updated_at DESC);

  CREATE INDEX IF NOT EXISTS idx_commercial_points_mall_items_chat
    ON commercial_points_mall_items(chat_id, enabled, sort_order, id DESC);

  CREATE INDEX IF NOT EXISTS idx_commercial_points_mall_orders_chat
    ON commercial_points_mall_orders(chat_id, created_at DESC, id DESC);

  CREATE INDEX IF NOT EXISTS idx_commercial_points_mall_orders_user
    ON commercial_points_mall_orders(chat_id, user_id, created_at DESC, id DESC);
`);

const commercialUserColumns = db.prepare(`PRAGMA table_info(commercial_users)`).all() as Array<{ name: string }>;
if (!commercialUserColumns.some((column) => column.name === "frozen")) {
  db.exec(`ALTER TABLE commercial_users ADD COLUMN frozen INTEGER NOT NULL DEFAULT 0;`);
}
if (!commercialUserColumns.some((column) => column.name === "frozen_note")) {
  db.exec(`ALTER TABLE commercial_users ADD COLUMN frozen_note TEXT DEFAULT '';`);
}
if (!commercialUserColumns.some((column) => column.name === "balance_cents")) {
  db.exec(`ALTER TABLE commercial_users ADD COLUMN balance_cents INTEGER NOT NULL DEFAULT 0;`);
}
if (!commercialUserColumns.some((column) => column.name === "first_console_login_at")) {
  db.exec(`ALTER TABLE commercial_users ADD COLUMN first_console_login_at TEXT DEFAULT '';`);
}

const commercialSubscriptionColumns = db.prepare(`PRAGMA table_info(commercial_subscriptions)`).all() as Array<{ name: string }>;
if (!commercialSubscriptionColumns.some((column) => column.name === "product_key")) {
  db.exec(`ALTER TABLE commercial_subscriptions ADD COLUMN product_key TEXT NOT NULL DEFAULT '';`);
}

const commercialOrderColumns = db.prepare(`PRAGMA table_info(commercial_orders)`).all() as Array<{ name: string }>;
if (!commercialOrderColumns.some((column) => column.name === "product_key")) {
  db.exec(`ALTER TABLE commercial_orders ADD COLUMN product_key TEXT NOT NULL DEFAULT '';`);
}
if (!commercialOrderColumns.some((column) => column.name === "order_no")) {
  db.exec(`ALTER TABLE commercial_orders ADD COLUMN order_no TEXT NOT NULL DEFAULT '';`);
}
if (!commercialOrderColumns.some((column) => column.name === "order_type")) {
  db.exec(`ALTER TABLE commercial_orders ADD COLUMN order_type TEXT NOT NULL DEFAULT 'subscription';`);
}
if (!commercialOrderColumns.some((column) => column.name === "payment_method")) {
  db.exec(`ALTER TABLE commercial_orders ADD COLUMN payment_method TEXT NOT NULL DEFAULT '';`);
}
if (!commercialOrderColumns.some((column) => column.name === "gateway_trade_no")) {
  db.exec(`ALTER TABLE commercial_orders ADD COLUMN gateway_trade_no TEXT DEFAULT '';`);
}
if (!commercialOrderColumns.some((column) => column.name === "paid_at")) {
  db.exec(`ALTER TABLE commercial_orders ADD COLUMN paid_at TEXT DEFAULT '';`);
}
if (!commercialOrderColumns.some((column) => column.name === "meta_json")) {
  db.exec(`ALTER TABLE commercial_orders ADD COLUMN meta_json TEXT DEFAULT '{}';`);
}
db.exec(`CREATE INDEX IF NOT EXISTS idx_commercial_orders_order_no ON commercial_orders(order_no);`);

const commercialSessionColumns = db.prepare(`PRAGMA table_info(commercial_sessions)`).all() as Array<{ name: string }>;
if (!commercialSessionColumns.some((column) => column.name === "proof_hash")) {
  db.exec(`ALTER TABLE commercial_sessions ADD COLUMN proof_hash TEXT NOT NULL DEFAULT '';`);
}

const commercialPointsMallItemColumns = db.prepare(`PRAGMA table_info(commercial_points_mall_items)`).all() as Array<{ name: string }>;
if (!commercialPointsMallItemColumns.some((column) => column.name === "source_product_id")) {
  db.exec(`ALTER TABLE commercial_points_mall_items ADD COLUMN source_product_id INTEGER NOT NULL DEFAULT 0;`);
}
if (!commercialPointsMallItemColumns.some((column) => column.name === "redeem_cycle")) {
  db.exec(`ALTER TABLE commercial_points_mall_items ADD COLUMN redeem_cycle TEXT NOT NULL DEFAULT 'none';`);
}
if (!commercialPointsMallItemColumns.some((column) => column.name === "repeat_markup_percent")) {
  db.exec(`ALTER TABLE commercial_points_mall_items ADD COLUMN repeat_markup_percent INTEGER NOT NULL DEFAULT 0;`);
}
if (!commercialPointsMallItemColumns.some((column) => column.name === "promo_scene")) {
  db.exec(`ALTER TABLE commercial_points_mall_items ADD COLUMN promo_scene TEXT NOT NULL DEFAULT 'purchase';`);
}
if (!commercialPointsMallItemColumns.some((column) => column.name === "stock_enabled")) {
  db.exec(`ALTER TABLE commercial_points_mall_items ADD COLUMN stock_enabled INTEGER NOT NULL DEFAULT 0;`);
}
if (!commercialPointsMallItemColumns.some((column) => column.name === "promo_validity_mode")) {
  db.exec(`ALTER TABLE commercial_points_mall_items ADD COLUMN promo_validity_mode TEXT NOT NULL DEFAULT 'default';`);
}

migratePointsMallStockToRemaining();

const commercialPointsMallConfigColumns = db.prepare(`PRAGMA table_info(commercial_points_mall_configs)`).all() as Array<{ name: string }>;
if (commercialPointsMallConfigColumns.length > 0 && !commercialPointsMallConfigColumns.some((column) => column.name === "custom_api_token")) {
  db.exec(`ALTER TABLE commercial_points_mall_configs ADD COLUMN custom_api_token TEXT DEFAULT '';`);
}

db.prepare(`
  INSERT OR IGNORE INTO commercial_products (
    product_key, title, plan_code, months, amount_cents, chat_limit, description, active, sort_order, updated_at
  ) VALUES
    ('pro_monthly', 'Pro 月付', 'pro', 1, 2900, 5, '1 个月订阅，最多认领 5 个群组/频道。', 1, 10, datetime('now')),
    ('pro_quarterly', 'Pro 季付', 'pro', 3, 7900, 5, '3 个月订阅，适合稳定运营群。', 1, 20, datetime('now')),
    ('pro_yearly', 'Pro 年付', 'pro', 12, 29900, 5, '12 个月订阅，适合长期商用部署。', 1, 30, datetime('now'))
`).run();

db.exec(`
  CREATE TABLE IF NOT EXISTS commercial_balance_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    delta_cents INTEGER NOT NULL,
    balance_after_cents INTEGER NOT NULL,
    note TEXT DEFAULT '',
    operator_user_id INTEGER NOT NULL DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_commercial_balance_logs_user_time
    ON commercial_balance_logs(user_id, created_at DESC, id DESC);
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS commercial_finance_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    category TEXT NOT NULL DEFAULT '',
    amount_cents INTEGER NOT NULL DEFAULT 0,
    balance_after_cents INTEGER NOT NULL DEFAULT 0,
    order_id INTEGER NOT NULL DEFAULT 0,
    order_no TEXT DEFAULT '',
    payment_method TEXT DEFAULT '',
    operator_user_id INTEGER NOT NULL DEFAULT 0,
    note TEXT DEFAULT '',
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_commercial_finance_logs_user_time
    ON commercial_finance_logs(user_id, created_at DESC, id DESC);

  CREATE INDEX IF NOT EXISTS idx_commercial_finance_logs_category_time
    ON commercial_finance_logs(category, created_at DESC, id DESC);
`);

function toSqliteDateTime(date: Date): string {
  return date.toISOString().slice(0, 19).replace("T", " ");
}

function fromSqliteDateTime(value: string): Date {
  return new Date(`${String(value || "").trim()}Z`);
}

function formatChinaDateTime(date: Date): string {
  const chinaDate = new Date(date.getTime() + CHINA_TZ_OFFSET_MS);
  const year = chinaDate.getUTCFullYear();
  const month = String(chinaDate.getUTCMonth() + 1).padStart(2, "0");
  const day = String(chinaDate.getUTCDate()).padStart(2, "0");
  const hour = String(chinaDate.getUTCHours()).padStart(2, "0");
  const minute = String(chinaDate.getUTCMinutes()).padStart(2, "0");
  const second = String(chinaDate.getUTCSeconds()).padStart(2, "0");
  return `${year}-${month}-${day} ${hour}:${minute}:${second}`;
}

function getChinaDayStart(date: Date): Date {
  const chinaDate = new Date(date.getTime() + CHINA_TZ_OFFSET_MS);
  chinaDate.setUTCHours(0, 0, 0, 0);
  return new Date(chinaDate.getTime() - CHINA_TZ_OFFSET_MS);
}

function normalizePointsMallPromoValidityMode(input: unknown): string {
  const value = String(input || "").trim();
  return ["default", "1d", "1w", "1m", "1q", "6m", "1y"].includes(value) ? value : "default";
}

export function getPointsMallPromoValidityLabel(mode: string): string {
  const normalized = normalizePointsMallPromoValidityMode(mode);
  if (normalized === "1d") return "1天";
  if (normalized === "1w") return "1周";
  if (normalized === "1m") return "1个月";
  if (normalized === "1q") return "1季度";
  if (normalized === "6m") return "半年";
  if (normalized === "1y") return "1年";
  return "默认";
}

function addPointsMallPromoValidity(now: Date, mode: string): Date | null {
  const normalized = normalizePointsMallPromoValidityMode(mode);
  if (normalized === "default") return null;
  const chinaLocalDate = new Date(getChinaDayStart(now).getTime() + CHINA_TZ_OFFSET_MS);
  const endLocalDate = new Date(chinaLocalDate.getTime());
  if (normalized === "1d") endLocalDate.setUTCDate(endLocalDate.getUTCDate() + 1);
  else if (normalized === "1w") endLocalDate.setUTCDate(endLocalDate.getUTCDate() + 7);
  else if (normalized === "1m") endLocalDate.setUTCMonth(endLocalDate.getUTCMonth() + 1);
  else if (normalized === "1q") endLocalDate.setUTCMonth(endLocalDate.getUTCMonth() + 3);
  else if (normalized === "6m") endLocalDate.setUTCMonth(endLocalDate.getUTCMonth() + 6);
  else if (normalized === "1y") endLocalDate.setUTCFullYear(endLocalDate.getUTCFullYear() + 1);
  return new Date(endLocalDate.getTime() - CHINA_TZ_OFFSET_MS);
}

export function resolvePointsMallPromoWindow(
  item: Pick<CommercialPointsMallItem, "promo_start_time" | "promo_expiration_time" | "promo_validity_mode">,
  now: Date = new Date()
): { promoStartTime: string; promoExpirationTime: string } {
  const promoValidityMode = normalizePointsMallPromoValidityMode(item.promo_validity_mode);
  if (promoValidityMode === "default") {
    return {
      promoStartTime: normalizeSqliteDateTimeText(item.promo_start_time),
      promoExpirationTime: normalizeSqliteDateTimeText(item.promo_expiration_time),
    };
  }
  const startAt = getChinaDayStart(now);
  const endAt = addPointsMallPromoValidity(now, promoValidityMode);
  return {
    promoStartTime: formatChinaDateTime(startAt),
    promoExpirationTime: endAt ? formatChinaDateTime(endAt) : "",
  };
}

function getPointsMallRedeemCycleLabel(cycle: string): string {
  if (cycle === "month") return "月度";
  if (cycle === "quarter") return "季度";
  if (cycle === "year") return "年度";
  return "不限周期";
}

function getPointsMallRedeemCycleWindow(cycle: string, now: Date = new Date()): { start: Date; end: Date; label: string } | null {
  const normalizedCycle = String(cycle || "").trim();
  if (!["month", "quarter", "year"].includes(normalizedCycle)) return null;
  const chinaNow = new Date(now.getTime() + CHINA_TZ_OFFSET_MS);
  const year = chinaNow.getUTCFullYear();
  const month = chinaNow.getUTCMonth();
  let startLocal: Date;
  let endLocal: Date;
  if (normalizedCycle === "month") {
    startLocal = new Date(Date.UTC(year, month, 1, 0, 0, 0));
    endLocal = new Date(Date.UTC(year, month + 1, 1, 0, 0, 0));
  } else if (normalizedCycle === "quarter") {
    const quarterStartMonth = Math.floor(month / 3) * 3;
    startLocal = new Date(Date.UTC(year, quarterStartMonth, 1, 0, 0, 0));
    endLocal = new Date(Date.UTC(year, quarterStartMonth + 3, 1, 0, 0, 0));
  } else {
    startLocal = new Date(Date.UTC(year, 0, 1, 0, 0, 0));
    endLocal = new Date(Date.UTC(year + 1, 0, 1, 0, 0, 0));
  }
  return {
    start: new Date(startLocal.getTime() - CHINA_TZ_OFFSET_MS),
    end: new Date(endLocal.getTime() - CHINA_TZ_OFFSET_MS),
    label: getPointsMallRedeemCycleLabel(normalizedCycle),
  };
}

function isCommercialSuperAdminUser(userId: number): boolean {
  return COMMERCIAL_SUPER_ADMIN_ID > 0 && userId === COMMERCIAL_SUPER_ADMIN_ID;
}

function buildCommercialSuperAdminSubscription(userId: number): CommercialSubscription {
  return {
    id: 0,
    user_id: userId,
    product_key: COMMERCIAL_SUPER_ADMIN_PRODUCT_KEY,
    plan_code: "pro",
    status: "active",
    starts_at: "永久",
    ends_at: COMMERCIAL_SUPER_ADMIN_ENDS_AT,
    source: "system_super_admin",
    created_at: "永久",
    updated_at: "永久",
  };
}

function generateCommercialOrderNo(prefix: string = "CO"): string {
  const safePrefix = String(prefix || "CO").trim().replace(/[^A-Za-z0-9]/g, "").slice(0, 8) || "CO";
  const now = Date.now().toString();
  const random = Math.floor(Math.random() * 1_000_000).toString().padStart(6, "0");
  return `${safePrefix}${now}${random}`;
}

function recordCommercialFinanceLog(payload: {
  userId: number;
  category: string;
  amountCents: number;
  balanceAfterCents: number;
  orderId?: number;
  orderNo?: string;
  paymentMethod?: string;
  operatorUserId?: number;
  note?: string;
}): void {
  db.prepare(`
    INSERT INTO commercial_finance_logs (
      user_id, category, amount_cents, balance_after_cents, order_id, order_no,
      payment_method, operator_user_id, note, created_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
  `).run(
    Math.floor(Number(payload.userId) || 0),
    String(payload.category || "").trim().slice(0, 50),
    Math.floor(Number(payload.amountCents) || 0),
    Math.max(0, Math.floor(Number(payload.balanceAfterCents) || 0)),
    Math.max(0, Math.floor(Number(payload.orderId) || 0)),
    String(payload.orderNo || "").trim().slice(0, 64),
    String(payload.paymentMethod || "").trim().slice(0, 32),
    Math.floor(Number(payload.operatorUserId) || 0),
    String(payload.note || "").trim().slice(0, 500)
  );
}

function cleanupExpiredCommercialAuthArtifacts(): void {
  db.prepare(`
    DELETE FROM commercial_login_codes
    WHERE expires_at < datetime('now') OR consumed_at != ''
  `).run();
  db.prepare(`
    DELETE FROM commercial_sessions
    WHERE expires_at < datetime('now')
  `).run();
}

export interface CommercialUser {
  user_id: number;
  username: string;
  display_name: string;
  email: string;
  frozen: number;
  frozen_note: string;
  balance_cents: number;
  created_at: string;
  updated_at: string;
}

export interface CommercialSubscription {
  id: number;
  user_id: number;
  product_key: string;
  plan_code: string;
  status: string;
  starts_at: string;
  ends_at: string;
  source: string;
  created_at: string;
  updated_at: string;
}

export interface CommercialOrder {
  id: number;
  order_no: string;
  user_id: number;
  order_type: string;
  product_key: string;
  plan_code: string;
  months: number;
  amount_cents: number;
  payment_method: string;
  gateway_trade_no: string;
  paid_at: string;
  meta_json: string;
  status: string;
  note: string;
  created_at: string;
  updated_at: string;
}

export interface CommercialChat {
  chat_id: number;
  owner_user_id: number;
  chat_type: string;
  title: string;
  username: string;
  claimed_at: string;
  updated_at: string;
}

export interface CommercialSubscriptionExpiryReminderTarget {
  chat_id: number;
  chat_type: string;
  title: string;
  username: string;
  owner_user_id: number;
  owner_username: string;
  owner_display_name: string;
  subscription_id: number;
  plan_code: string;
  ends_at: string;
}

export interface CommercialSubscriptionExpiredReminderTarget extends CommercialSubscriptionExpiryReminderTarget {}

export interface CommercialChatWelcomeButton {
  text: string;
  url: string;
}

export interface CommercialChatWelcomeConfig {
  chat_id: number;
  enabled: number;
  message_text: string;
  buttons: CommercialChatWelcomeButton[][];
  updated_at: string;
}

export interface CommercialPointsMallItem {
  id: number;
  chat_id: number;
  source_product_id: number;
  title: string;
  description: string;
  points_cost: number;
  redeem_cycle: string;
  repeat_markup_percent: number;
  stock: number;
  stock_enabled: number;
  enabled: number;
  sort_order: number;
  promo_scene: string;
  promo_type: string;
  promo_value: number;
  promo_cycles: string[];
  promo_appliesto: number[];
  promo_requires: number[];
  promo_recurring: number;
  promo_recurfor: number;
  promo_requires_exist: number;
  promo_max_times: number;
  promo_lifelong: number;
  promo_one_time: number;
  promo_only_new_client: number;
  promo_only_old_client: number;
  promo_once_per_client: number;
  promo_start_time: string;
  promo_expiration_time: string;
  promo_validity_mode: string;
  promo_notes: string;
  created_at: string;
  updated_at: string;
}

export interface CommercialPointsMallOrder {
  id: number;
  order_no: string;
  chat_id: number;
  item_id: number;
  item_title: string;
  user_id: number;
  username: string;
  display_name: string;
  points_cost: number;
  status: string;
  zjmf_exchange_no: string;
  zjmf_promo_id: number;
  zjmf_promo_code: string;
  zjmf_redeemed: number;
  zjmf_redeemed_at: string;
  result_json: string;
  created_at: string;
  updated_at: string;
}

export interface PointsMallRedeemAvailability {
  ok: boolean;
  reason?: string;
  item?: CommercialPointsMallItem;
  remainingStock: number | null;
  effectivePointsCost: number;
  basePointsCost: number;
  repeatMarkupPercent: number;
  withinRepeatCycle: boolean;
  redeemCycle: string;
  redeemCycleLabel: string;
  lastRedeemedAt: string;
  nextRedeemAt: string;
}

export interface CommercialPointsMallConfig {
  chat_id: number;
  provider: string;
  custom_api_url: string;
  custom_api_token: string;
  updated_at: string;
}

export interface ChatUserProfile {
  chat_id: number;
  user_id: number;
  username: string;
  display_name: string;
  updated_at: string;
}

export interface CommercialAIConfig {
  user_id: number;
  enabled: number;
  base_url: string;
  api_key: string;
  model: string;
  api_style: string;
  updated_at: string;
}

export interface CommercialBalanceLog {
  id: number;
  user_id: number;
  delta_cents: number;
  balance_after_cents: number;
  note: string;
  operator_user_id: number;
  created_at: string;
}

export interface CommercialFinanceLog {
  id: number;
  user_id: number;
  category: string;
  amount_cents: number;
  balance_after_cents: number;
  order_id: number;
  order_no: string;
  payment_method: string;
  order_type: string;
  product_key: string;
  plan_code: string;
  operator_user_id: number;
  note: string;
  created_at: string;
}

export interface CommercialPaymentConfig {
  enabled: number;
  base_url: string;
  pid: string;
  key: string;
  site_name: string;
  payment_methods: string;
  notify_path: string;
  return_path: string;
  updated_at: string;
}

export interface CommercialProduct {
  product_key: string;
  title: string;
  plan_code: string;
  months: number;
  amount_cents: number;
  chat_limit: number;
  description: string;
  active: number;
  sort_order: number;
  updated_at: string;
}

export interface CommercialAdminOrder extends CommercialOrder {
  username: string;
  display_name: string;
  balance_cents: number;
}

export interface CommercialAdminUser extends CommercialUser {
  active_plan_code: string;
  active_subscription_ends_at: string;
  chat_count: number;
}

export interface CommercialAdminChat extends CommercialChat {
  owner_username: string;
  owner_display_name: string;
  owner_balance_cents: number;
  subscription_active: number;
  subscription_ends_at: string;
}

export function upsertCommercialUser(userId: number, username: string, displayName: string, email: string = ""): CommercialUser {
  const normalizedUserId = Math.floor(Number(userId) || 0);
  const normalizedUsername = String(username || "").trim();
  const rawDisplayName = String(displayName || "").trim();
  const normalizedDisplayName = rawDisplayName === String(normalizedUserId) ? "" : rawDisplayName;
  db.prepare(`
    INSERT INTO commercial_users (user_id, username, display_name, email, frozen, frozen_note, balance_cents, created_at, updated_at)
    VALUES (?, ?, ?, ?, 0, '', 0, datetime('now'), datetime('now'))
    ON CONFLICT(user_id) DO UPDATE SET
      username = CASE WHEN excluded.username != '' THEN excluded.username ELSE commercial_users.username END,
      display_name = CASE WHEN excluded.display_name != '' THEN excluded.display_name ELSE commercial_users.display_name END,
      email = CASE WHEN excluded.email != '' THEN excluded.email ELSE commercial_users.email END,
      updated_at = excluded.updated_at
  `).run(
    normalizedUserId,
    normalizedUsername,
    normalizedDisplayName,
    String(email || "").trim()
  );
  return getCommercialUser(normalizedUserId)!;
}

export function getCommercialUser(userId: number): CommercialUser | null {
  const row = db.prepare(`
    SELECT user_id, username, display_name, email, frozen, frozen_note, balance_cents, created_at, updated_at
    FROM commercial_users
    WHERE user_id = ?
  `).get(userId) as CommercialUser | undefined;
  return row || null;
}

export function isCommercialUserFrozen(userId: number): boolean {
  if (isCommercialSuperAdminUser(userId)) return false;
  return Number(getCommercialUser(userId)?.frozen || 0) !== 0;
}

export function createCommercialLoginCode(userId: number, code: string, ttlMinutes: number = 15): string {
  cleanupExpiredCommercialAuthArtifacts();
  const expiresAt = new Date(Date.now() + Math.max(1, ttlMinutes) * 60_000);
  db.prepare(`
    INSERT INTO commercial_login_codes (code, user_id, expires_at, consumed_at, created_at)
    VALUES (?, ?, ?, '', datetime('now'))
  `).run(code, userId, toSqliteDateTime(expiresAt));
  return code;
}

export function consumeCommercialLoginCode(code: string): CommercialUser | null {
  cleanupExpiredCommercialAuthArtifacts();
  const normalized = String(code || "").trim();
  if (!normalized) return null;
  const row = db.prepare(`
    SELECT code, user_id, expires_at, consumed_at
    FROM commercial_login_codes
    WHERE code = ?
  `).get(normalized) as any;
  if (!row) return null;
  if (String(row.consumed_at || "").trim()) return null;
  if (fromSqliteDateTime(String(row.expires_at || "")).getTime() < Date.now()) return null;
  const user = getCommercialUser(Number(row.user_id));
  if (!user) return null;
  if (Number(user.frozen || 0) !== 0) return user;
  db.prepare(`
    UPDATE commercial_login_codes
    SET consumed_at = datetime('now')
    WHERE code = ?
  `).run(normalized);
  return user;
}

export function createCommercialSession(userId: number, sessionToken: string, proofHash: string, ttlDays: number = 30): string {
  cleanupExpiredCommercialAuthArtifacts();
  const expiresAt = new Date(Date.now() + Math.max(1, ttlDays) * 24 * 60 * 60 * 1000);
  db.prepare(`
    INSERT INTO commercial_sessions (session_token, user_id, proof_hash, expires_at, created_at)
    VALUES (?, ?, ?, ?, datetime('now'))
  `).run(sessionToken, userId, String(proofHash || '').trim(), toSqliteDateTime(expiresAt));
  return sessionToken;
}

export function markCommercialUserFirstConsoleLogin(userId: number): boolean {
  const normalizedUserId = Math.floor(Number(userId) || 0);
  if (!normalizedUserId) return false;
  return db.transaction(() => {
    const row = db.prepare(`SELECT first_console_login_at FROM commercial_users WHERE user_id = ?`).get(normalizedUserId) as
      | { first_console_login_at?: string }
      | undefined;
    if (!row) return false;
    if (String(row.first_console_login_at || "").trim()) return false;
    db.prepare(`
      UPDATE commercial_users
      SET first_console_login_at = datetime('now'), updated_at = datetime('now')
      WHERE user_id = ?
    `).run(normalizedUserId);
    return true;
  })();
}

export function getCommercialUserBySession(sessionToken: string, proofHash: string): CommercialUser | null {
  cleanupExpiredCommercialAuthArtifacts();
  const normalized = String(sessionToken || "").trim();
  const normalizedProofHash = String(proofHash || "").trim();
  if (!normalized) return null;
  if (!normalizedProofHash) return null;
  const row = db.prepare(`
    SELECT u.user_id, u.username, u.display_name, u.email, u.frozen, u.frozen_note, u.balance_cents, u.created_at, u.updated_at
    FROM commercial_sessions s
    JOIN commercial_users u ON u.user_id = s.user_id
    WHERE s.session_token = ? AND s.proof_hash = ? AND s.expires_at >= datetime('now') AND u.frozen = 0
  `).get(normalized, normalizedProofHash) as CommercialUser | undefined;
  return row || null;
}

export function getCommercialUserBySessionToken(sessionToken: string): CommercialUser | null {
  cleanupExpiredCommercialAuthArtifacts();
  const normalized = String(sessionToken || "").trim();
  if (!normalized) return null;
  const row = db.prepare(`
    SELECT u.user_id, u.username, u.display_name, u.email, u.frozen, u.frozen_note, u.balance_cents, u.created_at, u.updated_at
    FROM commercial_sessions s
    JOIN commercial_users u ON u.user_id = s.user_id
    WHERE s.session_token = ? AND s.expires_at >= datetime('now') AND u.frozen = 0
  `).get(normalized) as CommercialUser | undefined;
  return row || null;
}

export function revokeCommercialAuthArtifactsForUser(userId: number): void {
  db.prepare(`DELETE FROM commercial_sessions WHERE user_id = ?`).run(userId);
  db.prepare(`DELETE FROM commercial_login_codes WHERE user_id = ?`).run(userId);
}

export function setCommercialUserFrozen(userId: number, frozen: boolean, note: string = ""): CommercialUser {
  if (!userId) throw new Error("缺少有效的 userId");
  if (isCommercialSuperAdminUser(userId)) {
    throw new Error("超级管理员账号不支持冻结");
  }
  upsertCommercialUser(userId, "", String(userId));
  const normalizedNote = frozen ? String(note || "").trim().slice(0, 200) : "";
  db.prepare(`
    UPDATE commercial_users
    SET frozen = ?, frozen_note = ?, updated_at = datetime('now')
    WHERE user_id = ?
  `).run(frozen ? 1 : 0, normalizedNote, userId);
  if (frozen) revokeCommercialAuthArtifactsForUser(userId);
  return getCommercialUser(userId)!;
}

export function extendCommercialSession(sessionToken: string, proofHash: string, ttlDays: number = 30): boolean {
  cleanupExpiredCommercialAuthArtifacts();
  const normalized = String(sessionToken || "").trim();
  const normalizedProofHash = String(proofHash || "").trim();
  if (!normalized) return false;
  if (!normalizedProofHash) return false;
  const expiresAt = new Date(Date.now() + Math.max(1, ttlDays) * 24 * 60 * 60 * 1000);
  const result = db.prepare(`
    UPDATE commercial_sessions
    SET expires_at = ?
    WHERE session_token = ? AND proof_hash = ? AND expires_at >= datetime('now')
  `).run(toSqliteDateTime(expiresAt), normalized, normalizedProofHash);
  return result.changes > 0;
}

export function extendCommercialSessionByToken(sessionToken: string, ttlDays: number = 30): boolean {
  cleanupExpiredCommercialAuthArtifacts();
  const normalized = String(sessionToken || "").trim();
  if (!normalized) return false;
  const expiresAt = new Date(Date.now() + Math.max(1, ttlDays) * 24 * 60 * 60 * 1000);
  const result = db.prepare(`
    UPDATE commercial_sessions
    SET expires_at = ?
    WHERE session_token = ? AND expires_at >= datetime('now')
  `).run(toSqliteDateTime(expiresAt), normalized);
  return result.changes > 0;
}

export function adjustCommercialUserBalance(userId: number, deltaCents: number, operatorUserId: number, note: string = ""): CommercialUser {
  upsertCommercialUser(userId, "", String(userId));
  const current = getCommercialUser(userId)!;
  const nextBalance = Math.max(0, Number(current.balance_cents || 0) + Math.floor(deltaCents || 0));
  db.prepare(`
    UPDATE commercial_users
    SET balance_cents = ?, updated_at = datetime('now')
    WHERE user_id = ?
  `).run(nextBalance, userId);
  db.prepare(`
    INSERT INTO commercial_balance_logs (user_id, delta_cents, balance_after_cents, note, operator_user_id, created_at)
    VALUES (?, ?, ?, ?, ?, datetime('now'))
  `).run(
    userId,
    Math.floor(deltaCents || 0),
    nextBalance,
    String(note || "").trim().slice(0, 500),
    operatorUserId
  );
  recordCommercialFinanceLog({
    userId,
    category: "admin_adjust",
    amountCents: Math.floor(deltaCents || 0),
    balanceAfterCents: nextBalance,
    operatorUserId,
    note,
  });
  return getCommercialUser(userId)!;
}

export function listCommercialBalanceLogs(userId: number, limit: number = 20): CommercialBalanceLog[] {
  const safeLimit = Math.max(1, Math.min(100, Math.floor(limit)));
  return db.prepare(`
    SELECT id, user_id, delta_cents, balance_after_cents, note, operator_user_id, created_at
    FROM commercial_balance_logs
    WHERE user_id = ?
    ORDER BY id DESC
    LIMIT ?
  `).all(userId, safeLimit) as CommercialBalanceLog[];
}

export function listCommercialFinanceLogs(userId: number, limit: number = 20): CommercialFinanceLog[] {
  const safeLimit = Math.max(1, Math.min(200, Math.floor(limit)));
  return db.prepare(`
    SELECT f.id, f.user_id, f.category, f.amount_cents, f.balance_after_cents, f.order_id, f.order_no, f.payment_method,
           COALESCE(o.order_type, '') AS order_type, COALESCE(o.product_key, '') AS product_key, COALESCE(o.plan_code, '') AS plan_code,
           f.operator_user_id, f.note, f.created_at
    FROM commercial_finance_logs f
    LEFT JOIN commercial_orders o ON o.id = f.order_id
    WHERE f.user_id = ?
      AND NOT (f.category = 'online_payment' AND COALESCE(o.order_type, '') = 'recharge')
    ORDER BY f.id DESC
    LIMIT ?
  `).all(userId, safeLimit) as CommercialFinanceLog[];
}

export function listAllCommercialFinanceLogs(limit: number = 200): CommercialFinanceLog[] {
  const safeLimit = Math.max(1, Math.min(1000, Math.floor(limit)));
  return db.prepare(`
    SELECT f.id, f.user_id, f.category, f.amount_cents, f.balance_after_cents, f.order_id, f.order_no, f.payment_method,
           COALESCE(o.order_type, '') AS order_type, COALESCE(o.product_key, '') AS product_key, COALESCE(o.plan_code, '') AS plan_code,
           f.operator_user_id, f.note, f.created_at
    FROM commercial_finance_logs f
    LEFT JOIN commercial_orders o ON o.id = f.order_id
    WHERE NOT (f.category = 'online_payment' AND COALESCE(o.order_type, '') = 'recharge')
    ORDER BY f.id DESC
    LIMIT ?
  `).all(safeLimit) as CommercialFinanceLog[];
}

export function revokeCommercialSession(sessionToken: string): void {
  db.prepare(`
    DELETE FROM commercial_sessions
    WHERE session_token = ?
  `).run(String(sessionToken || "").trim());
}

export function getCommercialActiveSubscription(userId: number): CommercialSubscription | null {
  if (isCommercialSuperAdminUser(userId)) {
    return buildCommercialSuperAdminSubscription(userId);
  }
  if (isCommercialUserFrozen(userId)) return null;
  const row = db.prepare(`
    SELECT id, user_id, product_key, plan_code, status, starts_at, ends_at, source, created_at, updated_at
    FROM commercial_subscriptions
    WHERE user_id = ?
      AND status = 'active'
      AND ends_at >= datetime('now')
    ORDER BY ends_at DESC, id DESC
    LIMIT 1
  `).get(userId) as CommercialSubscription | undefined;
  return row || null;
}

export function listCommercialSubscriptions(userId: number, limit: number = 10): CommercialSubscription[] {
  const safeLimit = Math.max(1, Math.min(50, Math.floor(limit)));
  const rows = db.prepare(`
    SELECT id, user_id, product_key, plan_code, status, starts_at, ends_at, source, created_at, updated_at
    FROM commercial_subscriptions
    WHERE user_id = ?
    ORDER BY ends_at DESC, id DESC
    LIMIT ?
  `).all(userId, safeLimit) as CommercialSubscription[];
  if (!isCommercialSuperAdminUser(userId)) {
    return rows;
  }
  return [buildCommercialSuperAdminSubscription(userId), ...rows].slice(0, safeLimit);
}

export function hasCommercialActiveSubscription(userId: number): boolean {
  return !!getCommercialActiveSubscription(userId);
}

export function grantCommercialSubscription(userId: number, days: number, planCode: string = "pro", source: string = "manual", productKey: string = ""): CommercialSubscription {
  const safeDays = Math.max(1, Math.floor(days) || 30);
  const now = new Date();
  const current = getCommercialActiveSubscription(userId);
  const currentEnd = current ? fromSqliteDateTime(current.ends_at) : null;
  const startBase = currentEnd && currentEnd.getTime() > now.getTime() ? currentEnd : now;
  const endAt = new Date(startBase.getTime() + safeDays * 24 * 60 * 60 * 1000);
  db.prepare(`
    INSERT INTO commercial_subscriptions (
      user_id, product_key, plan_code, status, starts_at, ends_at, source, created_at, updated_at
    )
    VALUES (?, ?, ?, 'active', ?, ?, ?, datetime('now'), datetime('now'))
  `).run(
    userId,
    String(productKey || "").trim(),
    String(planCode || "pro").trim() || "pro",
    toSqliteDateTime(now),
    toSqliteDateTime(endAt),
    String(source || "manual").trim()
  );
  return getCommercialActiveSubscription(userId)!;
}

export function purchaseCommercialSubscriptionWithBalance(
  userId: number,
  productKey: string,
  planCode: string,
  months: number,
  amountCents: number,
  note: string = ""
): { order: CommercialOrder; subscription: CommercialSubscription; user: CommercialUser } {
  const safeMonths = Math.max(1, Math.floor(months) || 1);
  const safeAmount = Math.max(0, Math.floor(amountCents) || 0);
  const normalizedPlan = String(planCode || "pro").trim() || "pro";
  const normalizedNote = String(note || "").trim().slice(0, 500);
  const orderNo = generateCommercialOrderNo("BAL");

  const result = db.transaction(() => {
    upsertCommercialUser(userId, "", String(userId));
    const currentUser = getCommercialUser(userId)!;
    const currentBalance = Math.max(0, Number(currentUser.balance_cents || 0));
    if (currentBalance < safeAmount) {
      throw new Error(`余额不足，当前余额 ${currentBalance} 分，购买需要 ${safeAmount} 分`);
    }

    const orderInsert = db.prepare(`
      INSERT INTO commercial_orders (
        order_no, user_id, order_type, product_key, plan_code, months, amount_cents,
        payment_method, gateway_trade_no, paid_at, meta_json, status, note, created_at, updated_at
      )
      VALUES (?, ?, 'subscription', ?, ?, ?, ?, 'balance', '', datetime('now'), '{}', 'paid', ?, datetime('now'), datetime('now'))
    `).run(orderNo, userId, String(productKey || "").trim(), normalizedPlan, safeMonths, safeAmount, normalizedNote || `余额购买 ${normalizedPlan}`);
    const orderId = Number(orderInsert.lastInsertRowid || 0);

    const nextBalance = currentBalance - safeAmount;
    db.prepare(`
      UPDATE commercial_users
      SET balance_cents = ?, updated_at = datetime('now')
      WHERE user_id = ?
    `).run(nextBalance, userId);
    db.prepare(`
      INSERT INTO commercial_balance_logs (user_id, delta_cents, balance_after_cents, note, operator_user_id, created_at)
      VALUES (?, ?, ?, ?, ?, datetime('now'))
    `).run(
      userId,
      -safeAmount,
      nextBalance,
      `购买套餐: ${normalizedNote || normalizedPlan} (#${orderId})`.slice(0, 500),
      userId
    );
    recordCommercialFinanceLog({
      userId,
      category: "balance_payment",
      amountCents: -safeAmount,
      balanceAfterCents: nextBalance,
      orderId,
      orderNo,
      paymentMethod: "balance",
      operatorUserId: userId,
      note: `余额支付购买套餐: ${normalizedNote || normalizedPlan}`,
    });

    const safeDays = safeMonths * 30;
    const now = new Date();
    const current = getCommercialActiveSubscription(userId);
    const currentEnd = current ? fromSqliteDateTime(current.ends_at) : null;
    const startBase = currentEnd && currentEnd.getTime() > now.getTime() ? currentEnd : now;
    const endAt = new Date(startBase.getTime() + safeDays * 24 * 60 * 60 * 1000);
    db.prepare(`
      INSERT INTO commercial_subscriptions (
        user_id, product_key, plan_code, status, starts_at, ends_at, source, created_at, updated_at
      )
      VALUES (?, ?, ?, 'active', ?, ?, ?, datetime('now'), datetime('now'))
    `).run(
      userId,
      String(productKey || "").trim(),
      normalizedPlan,
      toSqliteDateTime(now),
      toSqliteDateTime(endAt),
      `balance_order:${orderId}`
    );

    return {
      order: getCommercialOrder(orderId)!,
      subscription: getCommercialActiveSubscription(userId)!,
      user: getCommercialUser(userId)!,
    };
  });

  return result();
}

export function createCommercialOrder(userId: number, planCode: string, months: number, amountCents: number, note: string = ""): CommercialOrder {
  const safeMonths = Math.max(1, Math.floor(months) || 1);
  const safeAmount = Math.max(0, Math.floor(amountCents) || 0);
  const orderNo = generateCommercialOrderNo("ORD");
  const result = db.prepare(`
    INSERT INTO commercial_orders (
      order_no, user_id, order_type, product_key, plan_code, months, amount_cents,
      payment_method, gateway_trade_no, paid_at, meta_json, status, note, created_at, updated_at
    )
    VALUES (?, ?, 'subscription', '', ?, ?, ?, 'manual', '', '', '{}', 'pending', ?, datetime('now'), datetime('now'))
  `).run(
    orderNo,
    userId,
    String(planCode || "pro").trim() || "pro",
    safeMonths,
    safeAmount,
    String(note || "").trim().slice(0, 500)
  );
  return getCommercialOrder(Number(result.lastInsertRowid || 0))!;
}

export function createCommercialRechargeOrder(userId: number, amountCents: number, paymentMethod: string, note: string = "余额充值"): CommercialOrder {
  const safeAmount = Math.max(1, Math.floor(amountCents) || 0);
  if (!safeAmount) throw new Error("充值金额必须大于 0");
  const orderNo = generateCommercialOrderNo("TOP");
  const result = db.prepare(`
    INSERT INTO commercial_orders (
      order_no, user_id, order_type, product_key, plan_code, months, amount_cents,
      payment_method, gateway_trade_no, paid_at, meta_json, status, note, created_at, updated_at
    )
    VALUES (?, ?, 'recharge', '', 'balance', 0, ?, ?, '', '', '{}', 'pending', ?, datetime('now'), datetime('now'))
  `).run(
    orderNo,
    userId,
    safeAmount,
    String(paymentMethod || "online").trim() || "online",
    String(note || "余额充值").trim().slice(0, 500)
  );
  return getCommercialOrder(Number(result.lastInsertRowid || 0))!;
}

export function createCommercialOnlineSubscriptionOrder(payload: {
  userId: number;
  productKey: string;
  planCode: string;
  months: number;
  amountCents: number;
  paymentMethod: string;
  note?: string;
}): CommercialOrder {
  const safeMonths = Math.max(1, Math.floor(payload.months) || 1);
  const safeAmount = Math.max(1, Math.floor(payload.amountCents) || 0);
  if (!safeAmount) throw new Error("支付金额必须大于 0");
  const orderNo = generateCommercialOrderNo("PAY");
  const result = db.prepare(`
    INSERT INTO commercial_orders (
      order_no, user_id, order_type, product_key, plan_code, months, amount_cents,
      payment_method, gateway_trade_no, paid_at, meta_json, status, note, created_at, updated_at
    )
    VALUES (?, ?, 'subscription', ?, ?, ?, ?, ?, '', '', '{}', 'pending', ?, datetime('now'), datetime('now'))
  `).run(
    orderNo,
    payload.userId,
    String(payload.productKey || "").trim(),
    String(payload.planCode || "pro").trim() || "pro",
    safeMonths,
    safeAmount,
    String(payload.paymentMethod || "online").trim() || "online",
    String(payload.note || "在线支付购买套餐").trim().slice(0, 500)
  );
  return getCommercialOrder(Number(result.lastInsertRowid || 0))!;
}

export function listCommercialOrders(userId: number, limit: number = 20): CommercialOrder[] {
  const safeLimit = Math.max(1, Math.min(100, Math.floor(limit)));
  return db.prepare(`
    SELECT id, order_no, user_id, order_type, product_key, plan_code, months, amount_cents,
           payment_method, gateway_trade_no, paid_at, meta_json, status, note, created_at, updated_at
    FROM commercial_orders
    WHERE user_id = ?
    ORDER BY id DESC
    LIMIT ?
  `).all(userId, safeLimit) as CommercialOrder[];
}

export function updateCommercialOrderStatus(orderId: number, status: string): boolean {
  const result = db.prepare(`
    UPDATE commercial_orders
    SET status = ?, updated_at = datetime('now')
    WHERE id = ?
  `).run(String(status || "pending").trim(), orderId);
  return result.changes > 0;
}

export function getCommercialOrder(orderId: number): CommercialOrder | null {
  const row = db.prepare(`
    SELECT id, order_no, user_id, order_type, product_key, plan_code, months, amount_cents,
           payment_method, gateway_trade_no, paid_at, meta_json, status, note, created_at, updated_at
    FROM commercial_orders
    WHERE id = ?
  `).get(orderId) as CommercialOrder | undefined;
  return row || null;
}

export function getCommercialOrderByOrderNo(orderNo: string): CommercialOrder | null {
  const normalized = String(orderNo || "").trim();
  if (!normalized) return null;
  const row = db.prepare(`
    SELECT id, order_no, user_id, order_type, product_key, plan_code, months, amount_cents,
           payment_method, gateway_trade_no, paid_at, meta_json, status, note, created_at, updated_at
    FROM commercial_orders
    WHERE order_no = ?
    LIMIT 1
  `).get(normalized) as CommercialOrder | undefined;
  return row || null;
}

export function markCommercialOrderPaid(orderId: number, payload?: {
  paymentMethod?: string;
  gatewayTradeNo?: string;
  note?: string;
  metaJson?: string;
}): CommercialOrder {
  const order = getCommercialOrder(orderId);
  if (!order) throw new Error("订单不存在");
  const nextPaymentMethod = String(payload?.paymentMethod || order.payment_method || "").trim();
  const nextGatewayTradeNo = String(payload?.gatewayTradeNo || order.gateway_trade_no || "").trim();
  const nextNote = String(payload?.note || order.note || "").trim().slice(0, 500);
  const nextMetaJson = String(payload?.metaJson || order.meta_json || "{}").trim() || "{}";
  db.prepare(`
    UPDATE commercial_orders
    SET status = 'paid',
        payment_method = ?,
        gateway_trade_no = ?,
        paid_at = CASE WHEN paid_at = '' THEN datetime('now') ELSE paid_at END,
        note = ?,
        meta_json = ?,
        updated_at = datetime('now')
    WHERE id = ?
  `).run(nextPaymentMethod, nextGatewayTradeNo, nextNote, nextMetaJson, orderId);
  return getCommercialOrder(orderId)!;
}

export function completeCommercialOrderPayment(orderNo: string, gatewayTradeNo: string): {
  order: CommercialOrder;
  subscription: CommercialSubscription | null;
  user: CommercialUser;
  newlyPaid: boolean;
} {
  const normalizedOrderNo = String(orderNo || "").trim();
  const normalizedTradeNo = String(gatewayTradeNo || "").trim();
  if (!normalizedOrderNo) throw new Error("缺少有效的 orderNo");

  const tx = db.transaction(() => {
    const order = getCommercialOrderByOrderNo(normalizedOrderNo);
    if (!order) throw new Error("订单不存在");
    upsertCommercialUser(order.user_id, "", String(order.user_id));
    const currentUser = getCommercialUser(order.user_id)!;
    if (order.status === "paid") {
      return {
        order,
        subscription: order.order_type === "subscription" ? getCommercialActiveSubscription(order.user_id) : null,
        user: currentUser,
        newlyPaid: false,
      };
    }
    if (order.status !== "pending") {
      throw new Error(`当前订单状态为 ${order.status}，无法继续入账`);
    }

    const paidOrder = markCommercialOrderPaid(order.id, {
      paymentMethod: order.payment_method,
      gatewayTradeNo: normalizedTradeNo,
      note: order.note,
      metaJson: order.meta_json,
    });

    if (paidOrder.order_type === "recharge") {
      const nextBalance = Math.max(0, Number(currentUser.balance_cents || 0) + Number(paidOrder.amount_cents || 0));
      db.prepare(`
        UPDATE commercial_users
        SET balance_cents = ?, updated_at = datetime('now')
        WHERE user_id = ?
      `).run(nextBalance, paidOrder.user_id);
      db.prepare(`
        INSERT INTO commercial_balance_logs (user_id, delta_cents, balance_after_cents, note, operator_user_id, created_at)
        VALUES (?, ?, ?, ?, 0, datetime('now'))
      `).run(
        paidOrder.user_id,
        Number(paidOrder.amount_cents || 0),
        nextBalance,
        `在线充值到账: ${paidOrder.note || paidOrder.order_no}`.slice(0, 500)
      );
      recordCommercialFinanceLog({
        userId: paidOrder.user_id,
        category: "balance_recharge",
        amountCents: Number(paidOrder.amount_cents || 0),
        balanceAfterCents: nextBalance,
        orderId: paidOrder.id,
        orderNo: paidOrder.order_no,
        paymentMethod: paidOrder.payment_method,
        note: `余额充值到账: ${paidOrder.note || paidOrder.order_no}`,
      });
      return {
        order: getCommercialOrder(paidOrder.id)!,
        subscription: null,
        user: getCommercialUser(paidOrder.user_id)!,
        newlyPaid: true,
      };
    }

    const subscription = grantCommercialSubscription(
      paidOrder.user_id,
      Math.max(1, Number(paidOrder.months || 0)) * 30,
      paidOrder.plan_code,
      `online_order:${paidOrder.id}`,
      paidOrder.product_key || ""
    );
    recordCommercialFinanceLog({
      userId: paidOrder.user_id,
      category: "online_payment",
      amountCents: Number(paidOrder.amount_cents || 0),
      balanceAfterCents: Number(currentUser.balance_cents || 0),
      orderId: paidOrder.id,
      orderNo: paidOrder.order_no,
      paymentMethod: paidOrder.payment_method,
      note: `在线支付购买套餐: ${paidOrder.note || paidOrder.plan_code}`,
    });
    return {
      order: getCommercialOrder(paidOrder.id)!,
      subscription,
      user: getCommercialUser(paidOrder.user_id)!,
      newlyPaid: true,
    };
  });

  return tx();
}

export function listAllCommercialOrders(limit: number = 100, status?: string): CommercialAdminOrder[] {
  const safeLimit = Math.max(1, Math.min(500, Math.floor(limit)));
  const normalizedStatus = String(status || "").trim();
  if (normalizedStatus) {
    return db.prepare(`
      SELECT
        o.id, o.order_no, o.user_id, o.order_type, o.plan_code, o.months, o.amount_cents, o.status, o.note, o.created_at, o.updated_at,
        o.product_key AS product_key, o.payment_method, o.gateway_trade_no, o.paid_at, o.meta_json,
        COALESCE(u.username, '') AS username,
        COALESCE(u.display_name, '') AS display_name,
        COALESCE(u.balance_cents, 0) AS balance_cents
      FROM commercial_orders o
      LEFT JOIN commercial_users u ON u.user_id = o.user_id
      WHERE o.status = ?
      ORDER BY o.id DESC
      LIMIT ?
    `).all(normalizedStatus, safeLimit) as CommercialAdminOrder[];
  }
  return db.prepare(`
    SELECT
      o.id, o.order_no, o.user_id, o.order_type, o.plan_code, o.months, o.amount_cents, o.status, o.note, o.created_at, o.updated_at,
      o.product_key AS product_key, o.payment_method, o.gateway_trade_no, o.paid_at, o.meta_json,
      COALESCE(u.username, '') AS username,
      COALESCE(u.display_name, '') AS display_name,
      COALESCE(u.balance_cents, 0) AS balance_cents
    FROM commercial_orders o
    LEFT JOIN commercial_users u ON u.user_id = o.user_id
    ORDER BY o.id DESC
    LIMIT ?
  `).all(safeLimit) as CommercialAdminOrder[];
}

export function listAllCommercialUsers(limit: number = 100): CommercialAdminUser[] {
  const safeLimit = Math.max(1, Math.min(500, Math.floor(limit)));
  const rows = db.prepare(`
    SELECT
      u.user_id, u.username, u.display_name, u.email, u.frozen, u.balance_cents, u.created_at, u.updated_at,
      COALESCE(u.frozen_note, '') AS frozen_note,
      COALESCE(s.plan_code, '') AS active_plan_code,
      COALESCE(s.ends_at, '') AS active_subscription_ends_at,
      COALESCE(c.chat_count, 0) AS chat_count
    FROM commercial_users u
    LEFT JOIN (
      SELECT s1.user_id, s1.plan_code, s1.ends_at
      FROM commercial_subscriptions s1
      WHERE s1.status = 'active' AND s1.ends_at >= datetime('now')
      AND s1.id = (
        SELECT s2.id
        FROM commercial_subscriptions s2
        WHERE s2.user_id = s1.user_id AND s2.status = 'active' AND s2.ends_at >= datetime('now')
        ORDER BY s2.ends_at DESC, s2.id DESC
        LIMIT 1
      )
    ) s ON s.user_id = u.user_id
    LEFT JOIN (
      SELECT owner_user_id, COUNT(*) AS chat_count
      FROM commercial_chats
      GROUP BY owner_user_id
    ) c ON c.owner_user_id = u.user_id
    ORDER BY u.updated_at DESC, u.user_id DESC
    LIMIT ?
  `).all(safeLimit) as CommercialAdminUser[];
  return rows.map((row) => {
    if (!isCommercialSuperAdminUser(Number(row.user_id || 0))) {
      return row;
    }
    return {
      ...row,
      active_plan_code: "pro",
      active_subscription_ends_at: COMMERCIAL_SUPER_ADMIN_ENDS_AT,
    };
  });
}

export function listAllCommercialChats(limit: number = 100): CommercialAdminChat[] {
  const safeLimit = Math.max(1, Math.min(500, Math.floor(limit)));
  const rows = db.prepare(`
    SELECT
      c.chat_id, c.owner_user_id, c.chat_type, c.title, c.username, c.claimed_at, c.updated_at,
      COALESCE(u.username, '') AS owner_username,
      COALESCE(u.display_name, '') AS owner_display_name,
      COALESCE(u.balance_cents, 0) AS owner_balance_cents,
      CASE WHEN s.id IS NULL THEN 0 ELSE 1 END AS subscription_active,
      COALESCE(s.ends_at, '') AS subscription_ends_at
    FROM commercial_chats c
    LEFT JOIN commercial_users u ON u.user_id = c.owner_user_id
    LEFT JOIN commercial_subscriptions s
      ON s.user_id = c.owner_user_id
      AND s.status = 'active'
      AND s.ends_at >= datetime('now')
      AND s.id = (
        SELECT s2.id
        FROM commercial_subscriptions s2
        WHERE s2.user_id = c.owner_user_id AND s2.status = 'active' AND s2.ends_at >= datetime('now')
        ORDER BY s2.ends_at DESC, s2.id DESC
        LIMIT 1
      )
    ORDER BY c.updated_at DESC, c.chat_id DESC
    LIMIT ?
  `).all(safeLimit) as CommercialAdminChat[];
  return rows.map((row) => {
    if (!isCommercialSuperAdminUser(Number(row.owner_user_id || 0))) {
      return row;
    }
    return {
      ...row,
      subscription_active: 1,
      subscription_ends_at: COMMERCIAL_SUPER_ADMIN_ENDS_AT,
    };
  });
}

export function approveCommercialOrder(orderId: number, operatorUserId: number): {
  order: CommercialOrder;
  subscription: CommercialSubscription;
  newlyPaid: boolean;
} {
  const order = getCommercialOrder(orderId);
  if (!order) throw new Error("订单不存在");
  if (order.order_type !== "subscription") {
    throw new Error("只有订阅订单支持后台审核通过");
  }
  if (order.status === "paid") {
    const sub = getCommercialActiveSubscription(order.user_id);
    if (!sub) throw new Error("订单已标记为 paid，但未找到有效订阅");
    return { order, subscription: sub, newlyPaid: false };
  }
  if (order.status !== "pending") {
    throw new Error(`当前订单状态为 ${order.status}，无法审核通过`);
  }
  markCommercialOrderPaid(orderId, { paymentMethod: order.payment_method || "manual" });
  const subscription = grantCommercialSubscription(order.user_id, Math.max(1, order.months) * 30, order.plan_code, `order:${orderId}:approved_by:${operatorUserId}`, order.product_key || "");
  return { order: getCommercialOrder(orderId)!, subscription, newlyPaid: true };
}

export function rejectCommercialOrder(orderId: number): CommercialOrder {
  const order = getCommercialOrder(orderId);
  if (!order) throw new Error("订单不存在");
  if (order.status === "paid") throw new Error("已支付订单不能直接改为取消");
  updateCommercialOrderStatus(orderId, "cancelled");
  return getCommercialOrder(orderId)!;
}

export function listCommercialProducts(activeOnly: boolean = false): CommercialProduct[] {
  if (activeOnly) {
    return db.prepare(`
      SELECT product_key, title, plan_code, months, amount_cents, chat_limit, description, active, sort_order, updated_at
      FROM commercial_products
      WHERE active = 1
      ORDER BY sort_order ASC, product_key ASC
    `).all() as CommercialProduct[];
  }
  return db.prepare(`
    SELECT product_key, title, plan_code, months, amount_cents, chat_limit, description, active, sort_order, updated_at
    FROM commercial_products
    ORDER BY sort_order ASC, product_key ASC
  `).all() as CommercialProduct[];
}

export function getCommercialProduct(productKey: string): CommercialProduct | null {
  const row = db.prepare(`
    SELECT product_key, title, plan_code, months, amount_cents, chat_limit, description, active, sort_order, updated_at
    FROM commercial_products
    WHERE product_key = ?
  `).get(String(productKey || "").trim()) as CommercialProduct | undefined;
  return row || null;
}

export function upsertCommercialProduct(product: {
  productKey: string;
  title: string;
  planCode: string;
  months: number;
  amountCents: number;
  chatLimit: number;
  description?: string;
  active?: boolean;
  sortOrder?: number;
}): CommercialProduct {
  const productKey = String(product.productKey || "").trim();
  if (!productKey) throw new Error("productKey 不能为空");
  db.prepare(`
    INSERT INTO commercial_products (
      product_key, title, plan_code, months, amount_cents, chat_limit, description, active, sort_order, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(product_key) DO UPDATE SET
      title = excluded.title,
      plan_code = excluded.plan_code,
      months = excluded.months,
      amount_cents = excluded.amount_cents,
      chat_limit = excluded.chat_limit,
      description = excluded.description,
      active = excluded.active,
      sort_order = excluded.sort_order,
      updated_at = excluded.updated_at
  `).run(
    productKey,
    String(product.title || "").trim() || productKey,
    String(product.planCode || "pro").trim() || "pro",
    Math.max(1, Math.floor(product.months) || 1),
    Math.max(0, Math.floor(product.amountCents) || 0),
    Math.max(0, Math.floor(product.chatLimit) || 0),
    String(product.description || "").trim().slice(0, 500),
    product.active === false ? 0 : 1,
    Math.max(0, Math.floor(Number(product.sortOrder) || 0))
  );
  return getCommercialProduct(productKey)!;
}

export function claimCommercialChat(chatId: number, ownerUserId: number, chatType: string, title: string, username: string = ""): CommercialChat {
  db.prepare(`
    INSERT INTO commercial_chats (chat_id, owner_user_id, chat_type, title, username, claimed_at, updated_at)
    VALUES (?, ?, ?, ?, ?, datetime('now'), datetime('now'))
    ON CONFLICT(chat_id) DO UPDATE SET
      owner_user_id = excluded.owner_user_id,
      chat_type = excluded.chat_type,
      title = excluded.title,
      username = excluded.username,
      updated_at = excluded.updated_at
  `).run(
    chatId,
    ownerUserId,
    String(chatType || "group").trim() || "group",
    String(title || "").trim(),
    String(username || "").trim().replace(/^@+/, "")
  );
  return getCommercialChat(chatId)!;
}

export function getCommercialChat(chatId: number): CommercialChat | null {
  const row = db.prepare(`
    SELECT chat_id, owner_user_id, chat_type, title, username, claimed_at, updated_at
    FROM commercial_chats
    WHERE chat_id = ?
  `).get(chatId) as CommercialChat | undefined;
  return row || null;
}

export function reassignCommercialChat(chatId: number, ownerUserId: number): CommercialChat {
  upsertCommercialUser(ownerUserId, "", String(ownerUserId));
  const existing = getCommercialChat(chatId);
  if (!existing) {
    throw new Error("绑定记录不存在");
  }
  db.prepare(`
    UPDATE commercial_chats
    SET owner_user_id = ?, updated_at = datetime('now')
    WHERE chat_id = ?
  `).run(ownerUserId, chatId);
  return getCommercialChat(chatId)!;
}

export function removeCommercialChat(chatId: number): boolean {
  const result = db.prepare(`
    DELETE FROM commercial_chats
    WHERE chat_id = ?
  `).run(chatId);
  return result.changes > 0;
}

export function listCommercialChatsByOwner(ownerUserId: number): CommercialChat[] {
  return db.prepare(`
    SELECT chat_id, owner_user_id, chat_type, title, username, claimed_at, updated_at
    FROM commercial_chats
    WHERE owner_user_id = ?
    ORDER BY updated_at DESC, chat_id DESC
  `).all(ownerUserId) as CommercialChat[];
}

export function hasCommercialSubscriptionExpiryReminder(chatId: number, subscriptionId: number, remindDate: string): boolean {
  const row = db.prepare(`
    SELECT 1
    FROM commercial_subscription_reminders
    WHERE chat_id = ? AND subscription_id = ? AND remind_date = ?
    LIMIT 1
  `).get(chatId, subscriptionId, String(remindDate || "").trim()) as { 1: number } | undefined;
  return !!row;
}

export function markCommercialSubscriptionExpiryReminder(chatId: number, subscriptionId: number, remindDate: string): void {
  db.prepare(`
    INSERT OR IGNORE INTO commercial_subscription_reminders (chat_id, subscription_id, remind_date, created_at)
    VALUES (?, ?, ?, datetime('now'))
  `).run(chatId, subscriptionId, String(remindDate || "").trim());
}

export function listCommercialChatsWithExpiringSubscriptions(daysBefore: number = 5): CommercialSubscriptionExpiryReminderTarget[] {
  const safeDays = Math.max(1, Math.floor(daysBefore) || 5);
  const nowMs = Date.now();
  const todayKey = getChinaDateStr(nowMs);
  const todayDayNumber = getChinaDayNumber(nowMs);
  const rows = db.prepare(`
    SELECT
      c.chat_id,
      c.chat_type,
      c.title,
      c.username,
      c.owner_user_id,
      COALESCE(u.username, '') AS owner_username,
      COALESCE(u.display_name, '') AS owner_display_name,
      s.id AS subscription_id,
      s.plan_code,
      s.ends_at
    FROM commercial_chats c
    JOIN commercial_users u ON u.user_id = c.owner_user_id
    JOIN commercial_subscriptions s ON s.user_id = c.owner_user_id
    WHERE s.status = 'active'
      AND u.frozen = 0
      AND c.chat_type != 'channel'
      AND s.ends_at >= datetime('now')
      AND s.id = (
        SELECT s2.id
        FROM commercial_subscriptions s2
        WHERE s2.user_id = c.owner_user_id
          AND s2.status = 'active'
          AND s2.ends_at >= datetime('now')
        ORDER BY s2.ends_at DESC, s2.id DESC
        LIMIT 1
      )
    ORDER BY s.ends_at ASC, c.chat_id ASC
  `).all() as CommercialSubscriptionExpiryReminderTarget[];

  return rows.filter((row) => {
    const daysUntilExpiry = getChinaDayNumber(fromSqliteDateTime(row.ends_at).getTime()) - todayDayNumber;
    if (daysUntilExpiry < 0 || daysUntilExpiry > safeDays) return false;
    return !hasCommercialSubscriptionExpiryReminder(row.chat_id, row.subscription_id, todayKey);
  });
}

export function listCommercialChatsWithExpiredSubscriptionsNeedingReminder(): CommercialSubscriptionExpiredReminderTarget[] {
  const rows = db.prepare(`
    SELECT
      c.chat_id,
      c.chat_type,
      c.title,
      c.username,
      c.owner_user_id,
      COALESCE(u.username, '') AS owner_username,
      COALESCE(u.display_name, '') AS owner_display_name,
      s.id AS subscription_id,
      s.plan_code,
      s.ends_at
    FROM commercial_chats c
    JOIN commercial_users u ON u.user_id = c.owner_user_id
    JOIN commercial_subscriptions s ON s.user_id = c.owner_user_id
    WHERE u.frozen = 0
      AND c.chat_type != 'channel'
      AND s.status = 'active'
      AND s.ends_at < datetime('now')
      AND s.id = (
        SELECT s2.id
        FROM commercial_subscriptions s2
        WHERE s2.user_id = c.owner_user_id
          AND s2.status = 'active'
        ORDER BY s2.ends_at DESC, s2.id DESC
        LIMIT 1
      )
    ORDER BY s.ends_at DESC, c.chat_id ASC
  `).all() as CommercialSubscriptionExpiredReminderTarget[];

  return rows.filter((row) => !hasCommercialSubscriptionExpiryReminder(row.chat_id, row.subscription_id, "expired_once"));
}

function normalizeCommercialWelcomeButtons(input: unknown): CommercialChatWelcomeButton[][] {
  if (!Array.isArray(input)) return [];
  const rows: CommercialChatWelcomeButton[][] = [];
  for (const rawRow of input.slice(0, 8)) {
    if (!Array.isArray(rawRow)) continue;
    const row: CommercialChatWelcomeButton[] = [];
    for (const rawButton of rawRow.slice(0, 4)) {
      if (!rawButton || typeof rawButton !== "object") continue;
      const text = String((rawButton as any).text || "").trim().slice(0, 200);
      const url = String((rawButton as any).url || "").trim().slice(0, 2048);
      if (!text || !url) continue;
      row.push({ text, url });
    }
    if (row.length) rows.push(row);
  }
  return rows;
}

function serializeCommercialWelcomeButtons(buttons: CommercialChatWelcomeButton[][]): string {
  return buttons
    .map((row) => row.map((button) => `${button.text} | ${button.url}`).join("\n"))
    .filter(Boolean)
    .join("\n\n");
}

function parseCommercialWelcomeButtons(raw: string): CommercialChatWelcomeButton[][] {
  const text = String(raw || "").trim();
  if (!text) return [];
  try {
    return normalizeCommercialWelcomeButtons(JSON.parse(text));
  } catch {
    return [];
  }
}

function parseIdList(raw: string): number[] {
  return String(raw || "")
    .split(",")
    .map((item) => Math.floor(Number(item.trim() || 0)))
    .filter((item, index, list) => item > 0 && list.indexOf(item) === index);
}

function serializeIdList(items: number[]): string {
  return Array.from(new Set((items || []).map((item) => Math.floor(Number(item) || 0)).filter((item) => item > 0))).join(",");
}

function normalizeCycleList(input: unknown): string[] {
  if (!Array.isArray(input)) return [];
  return Array.from(
    new Set(
      input
        .map((item) => String(item || "").trim())
        .filter((item) => /^[a-z0-9_]+$/i.test(item))
    )
  );
}

function normalizeSqliteDateTimeText(input: unknown): string {
  const value = String(input || "").trim();
  if (!value) return "";
  const match = value.match(/^(\d{4}-\d{2}-\d{2})(?:[T\s](\d{2}:\d{2})(?::(\d{2}))?)?$/);
  if (!match) return "";
  return `${match[1]} 00:00:00`;
}

function hydratePointsMallItem(row: any): CommercialPointsMallItem {
  return {
    id: Number(row?.id || 0),
    chat_id: Number(row?.chat_id || 0),
    source_product_id: Math.max(0, Number(row?.source_product_id || 0)),
    title: String(row?.title || ""),
    description: String(row?.description || ""),
    points_cost: Math.max(0, Number(row?.points_cost || 0)),
    redeem_cycle: ["none", "month", "quarter", "year"].includes(String(row?.redeem_cycle || "")) ? String(row?.redeem_cycle || "none") : "none",
    repeat_markup_percent: Math.max(0, Math.floor(Number(row?.repeat_markup_percent || 0))),
    stock: Math.max(0, Number(row?.stock || 0)),
    stock_enabled: Number(row?.stock_enabled || 0) !== 0 ? 1 : 0,
    enabled: Number(row?.enabled || 0) !== 0 ? 1 : 0,
    sort_order: Math.max(0, Number(row?.sort_order || 0)),
    promo_scene: ["purchase", "renew"].includes(String(row?.promo_scene || "")) ? String(row?.promo_scene || "purchase") : "purchase",
    promo_type: String(row?.promo_type || "percent"),
    promo_value: Number(row?.promo_value || 0),
    promo_cycles: String(row?.promo_cycles || "")
      .split(",")
      .map((item: string) => item.trim())
      .filter(Boolean),
    promo_appliesto: parseIdList(String(row?.promo_appliesto || "")),
    promo_requires: parseIdList(String(row?.promo_requires || "")),
    promo_recurring: Number(row?.promo_recurring || 0) !== 0 ? 1 : 0,
    promo_recurfor: Math.max(0, Number(row?.promo_recurfor || 0)),
    promo_requires_exist: Number(row?.promo_requires_exist || 0) !== 0 ? 1 : 0,
    promo_max_times: Math.max(0, Number(row?.promo_max_times || 0)),
    promo_lifelong: Number(row?.promo_lifelong || 0) !== 0 ? 1 : 0,
    promo_one_time: Number(row?.promo_one_time || 0) !== 0 ? 1 : 0,
    promo_only_new_client: Number(row?.promo_only_new_client || 0) !== 0 ? 1 : 0,
    promo_only_old_client: Number(row?.promo_only_old_client || 0) !== 0 ? 1 : 0,
    promo_once_per_client: Number(row?.promo_once_per_client || 0) !== 0 ? 1 : 0,
    promo_start_time: String(row?.promo_start_time || ""),
    promo_expiration_time: String(row?.promo_expiration_time || ""),
    promo_validity_mode: normalizePointsMallPromoValidityMode(row?.promo_validity_mode),
    promo_notes: String(row?.promo_notes || ""),
    created_at: String(row?.created_at || ""),
    updated_at: String(row?.updated_at || ""),
  };
}

export function getCommercialChatWelcomeConfig(chatId: number): CommercialChatWelcomeConfig {
  const row = db.prepare(`
    SELECT chat_id, enabled, message_text, buttons_json, updated_at
    FROM commercial_chat_welcome_configs
    WHERE chat_id = ?
  `).get(chatId) as any;
  return {
    chat_id: chatId,
    enabled: Number(row?.enabled || 0),
    message_text: String(row?.message_text || ""),
    buttons: parseCommercialWelcomeButtons(String(row?.buttons_json || "[]")),
    updated_at: String(row?.updated_at || ""),
  };
}

export function setCommercialChatWelcomeConfig(
  chatId: number,
  config: { enabled?: boolean; messageText?: string; buttons?: CommercialChatWelcomeButton[][] }
): CommercialChatWelcomeConfig {
  const messageText = String(config.messageText || "").trim();
  if (messageText.length > COMMERCIAL_WELCOME_TEXT_LIMIT) {
    throw new Error(`欢迎文本最多 ${COMMERCIAL_WELCOME_TEXT_LIMIT} 个字符`);
  }
  const buttons = normalizeCommercialWelcomeButtons(config.buttons || []);
  if (serializeCommercialWelcomeButtons(buttons).length > COMMERCIAL_WELCOME_BUTTONS_LIMIT) {
    throw new Error(`按钮布局最多 ${COMMERCIAL_WELCOME_BUTTONS_LIMIT} 个字符`);
  }
  const enabled = config.enabled === true && (!!messageText || buttons.length > 0);
  db.prepare(`
    INSERT INTO commercial_chat_welcome_configs (chat_id, enabled, message_text, buttons_json, updated_at)
    VALUES (?, ?, ?, ?, datetime('now'))
    ON CONFLICT(chat_id) DO UPDATE SET
      enabled = excluded.enabled,
      message_text = excluded.message_text,
      buttons_json = excluded.buttons_json,
      updated_at = excluded.updated_at
  `).run(chatId, enabled ? 1 : 0, messageText, JSON.stringify(buttons));
  return getCommercialChatWelcomeConfig(chatId);
}

export function getPointsMallConfig(chatId: number): CommercialPointsMallConfig {
  const row = db.prepare(`
    SELECT chat_id, provider, custom_api_url, custom_api_token, updated_at
    FROM commercial_points_mall_configs
    WHERE chat_id = ?
    LIMIT 1
  `).get(chatId) as any;
  return {
    chat_id: chatId,
    provider: String(row?.provider || "zjmf"),
    custom_api_url: String(row?.custom_api_url || ""),
    custom_api_token: String(row?.custom_api_token || ""),
    updated_at: String(row?.updated_at || ""),
  };
}

export function listPointsMallConfigs(): CommercialPointsMallConfig[] {
  return (db.prepare(`
    SELECT chat_id, provider, custom_api_url, custom_api_token, updated_at
    FROM commercial_points_mall_configs
    WHERE provider = 'zjmf'
      AND trim(coalesce(custom_api_url, '')) <> ''
      AND trim(coalesce(custom_api_token, '')) <> ''
    ORDER BY updated_at DESC, chat_id DESC
  `).all() as any[]).map((row) => ({
    chat_id: Number(row?.chat_id || 0),
    provider: String(row?.provider || "zjmf"),
    custom_api_url: String(row?.custom_api_url || ""),
    custom_api_token: String(row?.custom_api_token || ""),
    updated_at: String(row?.updated_at || ""),
  }));
}

export function setPointsMallConfig(
  chatId: number,
  payload: { provider?: string; customApiUrl?: string; customApiToken?: string }
): CommercialPointsMallConfig {
  const provider = ["off", "zjmf"].includes(String(payload.provider || "").trim())
    ? String(payload.provider || "").trim()
    : "zjmf";
  const customApiUrl = String(payload.customApiUrl || "").trim().slice(0, 500);
  const customApiToken = String(payload.customApiToken || "").trim().slice(0, 500);
  db.prepare(`
    INSERT INTO commercial_points_mall_configs (chat_id, provider, custom_api_url, custom_api_token, updated_at)
    VALUES (?, ?, ?, ?, datetime('now'))
    ON CONFLICT(chat_id) DO UPDATE SET
      provider = excluded.provider,
      custom_api_url = excluded.custom_api_url,
      custom_api_token = excluded.custom_api_token,
      updated_at = excluded.updated_at
  `).run(chatId, provider, customApiUrl, customApiToken);
  return getPointsMallConfig(chatId);
}

export function listPointsMallItemsByChat(chatId: number, enabledOnly: boolean = false): CommercialPointsMallItem[] {
  const sql = `
    SELECT
      id, chat_id, source_product_id, title, description, points_cost, redeem_cycle, repeat_markup_percent, stock, stock_enabled, enabled, sort_order, promo_scene,
      promo_type, promo_value, promo_cycles, promo_appliesto, promo_requires,
      promo_recurring, promo_recurfor, promo_requires_exist, promo_max_times,
      promo_lifelong, promo_one_time, promo_only_new_client, promo_only_old_client,
      promo_once_per_client, promo_start_time, promo_expiration_time, promo_validity_mode, promo_notes,
      created_at, updated_at
    FROM commercial_points_mall_items
    WHERE chat_id = ? ${enabledOnly ? "AND enabled = 1" : ""}
    ORDER BY enabled DESC, sort_order ASC, id DESC
  `;
  return (db.prepare(sql).all(chatId) as any[]).map((row) => hydratePointsMallItem(row));
}

export function getPointsMallItem(chatId: number, itemId: number): CommercialPointsMallItem | null {
  const row = db.prepare(`
    SELECT
      id, chat_id, source_product_id, title, description, points_cost, redeem_cycle, repeat_markup_percent, stock, stock_enabled, enabled, sort_order, promo_scene,
      promo_type, promo_value, promo_cycles, promo_appliesto, promo_requires,
      promo_recurring, promo_recurfor, promo_requires_exist, promo_max_times,
      promo_lifelong, promo_one_time, promo_only_new_client, promo_only_old_client,
      promo_once_per_client, promo_start_time, promo_expiration_time, promo_validity_mode, promo_notes,
      created_at, updated_at
    FROM commercial_points_mall_items
    WHERE chat_id = ? AND id = ?
    LIMIT 1
  `).get(chatId, itemId) as any;
  return row ? hydratePointsMallItem(row) : null;
}

export function upsertPointsMallItem(
  chatId: number,
  payload: {
    id?: number;
    sourceProductId?: number;
    title: string;
    description?: string;
    pointsCost: number;
    redeemCycle?: string;
    repeatMarkupPercent?: number;
    stock?: number;
    enabled?: boolean;
    sortOrder?: number;
    promoScene?: string;
    promoType: string;
    promoValue: number;
    promoCycles?: string[];
    promoAppliesTo?: number[];
    promoRequires?: number[];
    promoRecurring?: boolean;
    promoRecurfor?: number;
    promoRequiresExist?: boolean;
    promoMaxTimes?: number;
    promoLifelong?: boolean;
    promoOneTime?: boolean;
    promoOnlyNewClient?: boolean;
    promoOnlyOldClient?: boolean;
    promoOncePerClient?: boolean;
    promoStartTime?: string;
    promoExpirationTime?: string;
    promoValidityMode?: string;
    promoNotes?: string;
  }
): CommercialPointsMallItem {
  const safeId = Math.max(0, Math.floor(Number(payload.id) || 0));
  const sourceProductId = Math.max(0, Math.floor(Number(payload.sourceProductId) || 0));
  const title = String(payload.title || "").trim().slice(0, 120);
  const description = String(payload.description || "").trim().slice(0, 500);
  const redeemCycle = ["none", "month", "quarter", "year"].includes(String(payload.redeemCycle || "").trim())
    ? String(payload.redeemCycle || "none").trim()
    : "none";
  const repeatMarkupPercent = Math.max(0, Math.floor(Number(payload.repeatMarkupPercent) || 0));
  const promoScene = ["purchase", "renew"].includes(String(payload.promoScene || "").trim()) ? String(payload.promoScene || "purchase").trim() : "purchase";
  const promoType = String(payload.promoType || "percent").trim();
  const promoValue = Number(payload.promoValue || 0);
  if (!title) throw new Error("商品标题不能为空");
  if (!Number.isFinite(Number(payload.pointsCost)) || Number(payload.pointsCost) <= 0) {
    throw new Error("所需积分必须大于 0");
  }
  if (!["percent", "fixed", "override", "free"].includes(promoType)) {
    throw new Error("优惠类型无效");
  }
  if (promoType !== "free" && !Number.isFinite(promoValue)) {
    throw new Error("优惠值无效");
  }

  const pointsCost = Math.max(1, Math.floor(Number(payload.pointsCost) || 0));
  const stock = Math.max(0, Math.floor(Number(payload.stock) || 0));
  const stockEnabled = stock > 0 ? 1 : 0;
  const sortOrder = Math.max(0, Math.floor(Number(payload.sortOrder) || 0));
  const promoCycles = normalizeCycleList(payload.promoCycles || []);
  const promoAppliesTo = Array.from(
    new Set((payload.promoAppliesTo || []).map((item) => Math.floor(Number(item) || 0)).filter((item) => item > 0))
  );
  const promoRequires = Array.from(
    new Set((payload.promoRequires || []).map((item) => Math.floor(Number(item) || 0)).filter((item) => item > 0))
  );
  const promoRecurfor = Math.max(0, Math.floor(Number(payload.promoRecurfor) || 0));
  const promoMaxTimes = payload.promoMaxTimes == null || String(payload.promoMaxTimes).trim() === ""
    ? 1
    : Math.max(0, Math.floor(Number(payload.promoMaxTimes) || 0));
  const promoStartTime = normalizeSqliteDateTimeText(payload.promoStartTime);
  const promoExpirationTime = normalizeSqliteDateTimeText(payload.promoExpirationTime);
  const promoValidityMode = normalizePointsMallPromoValidityMode(payload.promoValidityMode);
  const promoNotes = String(payload.promoNotes || "").trim().slice(0, 500);

  if (safeId > 0) {
    const existing = getPointsMallItem(chatId, safeId);
    if (!existing) throw new Error("商品不存在");
    db.prepare(`
      UPDATE commercial_points_mall_items
      SET
        title = ?,
        source_product_id = ?,
        description = ?,
        points_cost = ?,
        redeem_cycle = ?,
        repeat_markup_percent = ?,
        stock = ?,
        stock_enabled = ?,
        enabled = ?,
        sort_order = ?,
        promo_scene = ?,
        promo_type = ?,
        promo_value = ?,
        promo_cycles = ?,
        promo_appliesto = ?,
        promo_requires = ?,
        promo_recurring = ?,
        promo_recurfor = ?,
        promo_requires_exist = ?,
        promo_max_times = ?,
        promo_lifelong = ?,
        promo_one_time = ?,
        promo_only_new_client = ?,
        promo_only_old_client = ?,
        promo_once_per_client = ?,
        promo_start_time = ?,
        promo_expiration_time = ?,
        promo_validity_mode = ?,
        promo_notes = ?,
        updated_at = datetime('now')
      WHERE chat_id = ? AND id = ?
    `).run(
      title,
      sourceProductId,
      description,
      pointsCost,
      redeemCycle,
      repeatMarkupPercent,
      stock,
      stockEnabled,
      payload.enabled === false ? 0 : 1,
      sortOrder,
      promoScene,
      promoType,
      promoType === "free" ? 0 : promoValue,
      promoCycles.join(","),
      serializeIdList(promoAppliesTo),
      serializeIdList(promoRequires),
      payload.promoRecurring ? 1 : 0,
      promoRecurfor,
      payload.promoRequiresExist ? 1 : 0,
      promoMaxTimes,
      payload.promoLifelong ? 1 : 0,
      payload.promoOneTime === false ? 0 : 1,
      payload.promoOnlyNewClient ? 1 : 0,
      payload.promoOnlyOldClient ? 1 : 0,
      payload.promoOncePerClient === false ? 0 : 1,
      promoStartTime,
      promoExpirationTime,
      promoValidityMode,
      promoNotes,
      chatId,
      safeId
    );
    return getPointsMallItem(chatId, safeId)!;
  }

  const result = db.prepare(`
    INSERT INTO commercial_points_mall_items (
      chat_id, source_product_id, title, description, points_cost, redeem_cycle, repeat_markup_percent, stock, stock_enabled, enabled, sort_order, promo_scene,
      promo_type, promo_value, promo_cycles, promo_appliesto, promo_requires,
      promo_recurring, promo_recurfor, promo_requires_exist, promo_max_times,
      promo_lifelong, promo_one_time, promo_only_new_client, promo_only_old_client,
      promo_once_per_client, promo_start_time, promo_expiration_time, promo_validity_mode, promo_notes,
      created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))
  `).run(
    chatId,
    sourceProductId,
    title,
    description,
    pointsCost,
    redeemCycle,
    repeatMarkupPercent,
    stock,
    stockEnabled,
    payload.enabled === false ? 0 : 1,
    sortOrder,
    promoScene,
    promoType,
    promoType === "free" ? 0 : promoValue,
    promoCycles.join(","),
    serializeIdList(promoAppliesTo),
    serializeIdList(promoRequires),
    payload.promoRecurring ? 1 : 0,
    promoRecurfor,
    payload.promoRequiresExist ? 1 : 0,
    promoMaxTimes,
    payload.promoLifelong ? 1 : 0,
    payload.promoOneTime === false ? 0 : 1,
    payload.promoOnlyNewClient ? 1 : 0,
    payload.promoOnlyOldClient ? 1 : 0,
    payload.promoOncePerClient === false ? 0 : 1,
    promoStartTime,
    promoExpirationTime,
    promoValidityMode,
    promoNotes
  );
  return getPointsMallItem(chatId, Number(result.lastInsertRowid || 0))!;
}

export function removePointsMallItem(chatId: number, itemId: number): boolean {
  const result = db.prepare(`DELETE FROM commercial_points_mall_items WHERE chat_id = ? AND id = ?`).run(chatId, itemId);
  return result.changes > 0;
}

export function countPointsMallIssuedOrders(chatId: number, itemId: number): number {
  const row = db.prepare(`
    SELECT COUNT(*) AS cnt
    FROM commercial_points_mall_orders
    WHERE chat_id = ? AND item_id = ?
  `).get(chatId, itemId) as any;
  return Math.max(0, Number(row?.cnt || 0));
}

export function hasUserRedeemedPointsMallItem(chatId: number, itemId: number, userId: number): boolean {
  const row = db.prepare(`
    SELECT 1
    FROM commercial_points_mall_orders
    WHERE chat_id = ? AND item_id = ? AND user_id = ?
    LIMIT 1
  `).get(chatId, itemId, userId) as any;
  return !!row;
}

function getLatestPointsMallOrderByUser(chatId: number, itemId: number, userId: number): CommercialPointsMallOrder | null {
  const row = db.prepare(`
    SELECT
      id, order_no, chat_id, item_id, item_title, user_id, username, display_name,
      points_cost, status, zjmf_exchange_no, zjmf_promo_id, zjmf_promo_code,
      zjmf_redeemed, zjmf_redeemed_at, result_json, created_at, updated_at
    FROM commercial_points_mall_orders
    WHERE chat_id = ? AND item_id = ? AND user_id = ?
    ORDER BY created_at DESC, id DESC
    LIMIT 1
  `).get(chatId, itemId, userId) as CommercialPointsMallOrder | undefined;
  return row || null;
}

export function canRedeemPointsMallItem(
  chatId: number,
  itemId: number,
  userId: number
): PointsMallRedeemAvailability {
  const item = getPointsMallItem(chatId, itemId);
  if (!item) {
    return {
      ok: false,
      reason: "商品不存在",
      remainingStock: null,
      effectivePointsCost: 0,
      basePointsCost: 0,
      repeatMarkupPercent: 0,
      withinRepeatCycle: false,
      redeemCycle: "none",
      redeemCycleLabel: getPointsMallRedeemCycleLabel("none"),
      lastRedeemedAt: "",
      nextRedeemAt: "",
    };
  }
  if (!item.enabled) {
    return {
      ok: false,
      reason: "商品已下架",
      item,
      remainingStock: null,
      effectivePointsCost: item.points_cost,
      basePointsCost: item.points_cost,
      repeatMarkupPercent: item.repeat_markup_percent,
      withinRepeatCycle: false,
      redeemCycle: item.redeem_cycle,
      redeemCycleLabel: getPointsMallRedeemCycleLabel(item.redeem_cycle),
      lastRedeemedAt: "",
      nextRedeemAt: "",
    };
  }
  const remainingStock = item.stock_enabled ? Math.max(0, item.stock) : null;
  if (item.stock_enabled && item.stock <= 0) {
    return {
      ok: false,
      reason: "商品库存不足",
      item,
      remainingStock: 0,
      effectivePointsCost: item.points_cost,
      basePointsCost: item.points_cost,
      repeatMarkupPercent: item.repeat_markup_percent,
      withinRepeatCycle: false,
      redeemCycle: item.redeem_cycle,
      redeemCycleLabel: getPointsMallRedeemCycleLabel(item.redeem_cycle),
      lastRedeemedAt: "",
      nextRedeemAt: "",
    };
  }
  const latestOrder = getLatestPointsMallOrderByUser(chatId, itemId, userId);
  const cycleWindow = getPointsMallRedeemCycleWindow(item.redeem_cycle);
  const lastRedeemedAt = latestOrder?.created_at ? formatChinaDateTime(fromSqliteDateTime(latestOrder.created_at)) : "";
  const withinRepeatCycle = !!(latestOrder && cycleWindow && fromSqliteDateTime(latestOrder.created_at) >= cycleWindow.start && fromSqliteDateTime(latestOrder.created_at) < cycleWindow.end);
  const nextRedeemAt = withinRepeatCycle && cycleWindow ? formatChinaDateTime(cycleWindow.end) : "";
  const effectivePointsCost = withinRepeatCycle && item.repeat_markup_percent > 0
    ? Math.max(item.points_cost + 1, Math.ceil(item.points_cost * (1 + item.repeat_markup_percent / 100)))
    : item.points_cost;
  if (item.promo_once_per_client && hasUserRedeemedPointsMallItem(chatId, itemId, userId)) {
    return {
      ok: false,
      reason: "该商品每人仅可兑换一次",
      item,
      remainingStock,
      effectivePointsCost,
      basePointsCost: item.points_cost,
      repeatMarkupPercent: item.repeat_markup_percent,
      withinRepeatCycle,
      redeemCycle: item.redeem_cycle,
      redeemCycleLabel: getPointsMallRedeemCycleLabel(item.redeem_cycle),
      lastRedeemedAt,
      nextRedeemAt,
    };
  }
  return {
    ok: true,
    item,
    remainingStock,
    effectivePointsCost,
    basePointsCost: item.points_cost,
    repeatMarkupPercent: item.repeat_markup_percent,
    withinRepeatCycle,
    redeemCycle: item.redeem_cycle,
    redeemCycleLabel: getPointsMallRedeemCycleLabel(item.redeem_cycle),
    lastRedeemedAt,
    nextRedeemAt,
  };
}

function generatePointsMallOrderNo(): string {
  return `PM${Date.now()}${Math.floor(Math.random() * 1000000).toString().padStart(6, "0")}`;
}

export function createPointsMallOrder(payload: {
  chatId: number;
  itemId: number;
  itemTitle: string;
  userId: number;
  username?: string;
  displayName?: string;
  pointsCost: number;
  zjmfExchangeNo?: string;
  zjmfPromoId?: number;
  zjmfPromoCode?: string;
  zjmfRedeemed?: boolean;
  zjmfRedeemedAt?: string;
  resultJson?: string;
  status?: string;
}): CommercialPointsMallOrder {
  const orderNo = generatePointsMallOrderNo();
  const result = db.prepare(`
    INSERT INTO commercial_points_mall_orders (
      order_no, chat_id, item_id, item_title, user_id, username, display_name,
      points_cost, status, zjmf_exchange_no, zjmf_promo_id, zjmf_promo_code,
      zjmf_redeemed, zjmf_redeemed_at, result_json, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))
  `).run(
    orderNo,
    Math.floor(Number(payload.chatId) || 0),
    Math.floor(Number(payload.itemId) || 0),
    String(payload.itemTitle || "").trim().slice(0, 120),
    Math.floor(Number(payload.userId) || 0),
    String(payload.username || "").trim().slice(0, 120),
    String(payload.displayName || "").trim().slice(0, 120),
    Math.max(0, Math.floor(Number(payload.pointsCost) || 0)),
    String(payload.status || "issued").trim().slice(0, 30) || "issued",
    String(payload.zjmfExchangeNo || "").trim().slice(0, 80),
    Math.max(0, Math.floor(Number(payload.zjmfPromoId) || 0)),
    String(payload.zjmfPromoCode || "").trim().slice(0, 120),
    payload.zjmfRedeemed ? 1 : 0,
    String(payload.zjmfRedeemedAt || "").trim().slice(0, 30),
    String(payload.resultJson || "{}").slice(0, 4000)
  );
  return db.prepare(`
    SELECT
      id, order_no, chat_id, item_id, item_title, user_id, username, display_name,
      points_cost, status, zjmf_exchange_no, zjmf_promo_id, zjmf_promo_code,
      zjmf_redeemed, zjmf_redeemed_at, result_json, created_at, updated_at
    FROM commercial_points_mall_orders
    WHERE id = ?
    LIMIT 1
  `).get(Number(result.lastInsertRowid || 0)) as CommercialPointsMallOrder;
}

export function reservePointsMallItemStock(chatId: number, itemId: number): { ok: boolean; reserved: boolean; remainingStock: number | null; shouldAutoDisable?: boolean; reason?: string } {
  const item = getPointsMallItem(chatId, itemId);
  if (!item) {
    return { ok: false, reserved: false, remainingStock: null, reason: "商品不存在" };
  }
  if (!item.stock_enabled) {
    return { ok: true, reserved: false, remainingStock: null };
  }
  const result = db.prepare(`
    UPDATE commercial_points_mall_items
    SET stock = stock - 1, updated_at = datetime('now')
    WHERE chat_id = ? AND id = ? AND enabled = 1 AND stock_enabled = 1 AND stock > 0
  `).run(chatId, itemId);
  if (Number(result.changes || 0) <= 0) {
    return { ok: false, reserved: false, remainingStock: 0, reason: "商品库存不足" };
  }
  const row = db.prepare(`
    SELECT stock
    FROM commercial_points_mall_items
    WHERE chat_id = ? AND id = ?
    LIMIT 1
  `).get(chatId, itemId) as any;
  const remainingStock = Math.max(0, Number(row?.stock || 0));
  return { ok: true, reserved: true, remainingStock, shouldAutoDisable: remainingStock <= 0 };
}

export function restorePointsMallItemStock(chatId: number, itemId: number): void {
  db.prepare(`
    UPDATE commercial_points_mall_items
    SET stock = stock + 1, updated_at = datetime('now')
    WHERE chat_id = ? AND id = ? AND stock_enabled = 1
  `).run(chatId, itemId);
}

export function autoDisablePointsMallItemWhenOutOfStock(chatId: number, itemId: number): boolean {
  const result = db.prepare(`
    UPDATE commercial_points_mall_items
    SET enabled = 0, updated_at = datetime('now')
    WHERE chat_id = ? AND id = ? AND stock_enabled = 1 AND stock <= 0 AND enabled = 1
  `).run(chatId, itemId);
  return Number(result.changes || 0) > 0;
}

export function listPointsMallOrdersByUser(chatId: number, userId: number, limit: number = 20): CommercialPointsMallOrder[] {
  const safeLimit = Math.max(1, Math.min(100, Math.floor(limit)));
  return db.prepare(`
    SELECT
      id, order_no, chat_id, item_id, item_title, user_id, username, display_name,
      points_cost, status, zjmf_exchange_no, zjmf_promo_id, zjmf_promo_code,
      zjmf_redeemed, zjmf_redeemed_at, result_json, created_at, updated_at
    FROM commercial_points_mall_orders
    WHERE chat_id = ? AND user_id = ?
    ORDER BY created_at DESC, id DESC
    LIMIT ?
  `).all(chatId, userId, safeLimit) as CommercialPointsMallOrder[];
}

export function getCommercialChatAccess(chatId: number): {
  ownerUserId: number;
  ownerUsername: string;
  ownerDisplayName: string;
  ownerFrozen: boolean;
  subscriptionActive: boolean;
  subscriptionEndsAt: string;
} | null {
  const row = db.prepare(`
    SELECT
      c.owner_user_id AS ownerUserId,
      u.username AS ownerUsername,
      u.display_name AS ownerDisplayName,
      COALESCE(u.frozen, 0) AS ownerFrozen,
      CASE WHEN COALESCE(u.frozen, 0) != 0 THEN 0 WHEN s.id IS NULL THEN 0 ELSE 1 END AS subscriptionActive,
      COALESCE(s.ends_at, '') AS subscriptionEndsAt
    FROM commercial_chats c
    LEFT JOIN commercial_users u ON u.user_id = c.owner_user_id
    LEFT JOIN commercial_subscriptions s
      ON s.user_id = c.owner_user_id
      AND s.status = 'active'
      AND s.ends_at >= datetime('now')
    WHERE c.chat_id = ?
    ORDER BY s.ends_at DESC, s.id DESC
    LIMIT 1
  `).get(chatId) as any;
  if (!row) return null;
  const ownerUserId = Number(row.ownerUserId || 0);
  if (isCommercialSuperAdminUser(ownerUserId)) {
    return {
      ownerUserId,
      ownerUsername: String(row.ownerUsername || ""),
      ownerDisplayName: String(row.ownerDisplayName || ""),
      ownerFrozen: false,
      subscriptionActive: true,
      subscriptionEndsAt: COMMERCIAL_SUPER_ADMIN_ENDS_AT,
    };
  }
  return {
    ownerUserId,
    ownerUsername: String(row.ownerUsername || ""),
    ownerDisplayName: String(row.ownerDisplayName || ""),
    ownerFrozen: Number(row.ownerFrozen || 0) !== 0,
    subscriptionActive: Number(row.subscriptionActive || 0) !== 0,
    subscriptionEndsAt: String(row.subscriptionEndsAt || ""),
  };
}

function getAppSetting(key: string, fallback: string = ""): string {
  const row = db.prepare(`
    SELECT value
    FROM app_settings
    WHERE key = ?
    LIMIT 1
  `).get(String(key || "").trim()) as any;
  return row ? String(row.value || "") : fallback;
}

function setAppSetting(key: string, value: string): string {
  const normalizedKey = String(key || "").trim();
  const normalizedValue = String(value || "");
  db.prepare(`
    INSERT INTO app_settings (key, value, updated_at)
    VALUES (?, ?, datetime('now'))
    ON CONFLICT(key) DO UPDATE SET
      value = excluded.value,
      updated_at = excluded.updated_at
  `).run(normalizedKey, normalizedValue);
  return getAppSetting(normalizedKey, "");
}

function migratePointsMallStockToRemaining(): void {
  if (getAppSetting("points_mall_stock_mode", "") === "remaining_v1") {
    return;
  }
  const items = db.prepare(`
    SELECT id, chat_id, stock
    FROM commercial_points_mall_items
  `).all() as Array<{ id: number; chat_id: number; stock: number }>;
  const countStmt = db.prepare(`
    SELECT COUNT(*) AS cnt
    FROM commercial_points_mall_orders
    WHERE chat_id = ? AND item_id = ?
  `);
  const updateStmt = db.prepare(`
    UPDATE commercial_points_mall_items
    SET stock = ?, stock_enabled = ?, updated_at = datetime('now')
    WHERE id = ?
  `);
  const transaction = db.transaction((rows: Array<{ id: number; chat_id: number; stock: number }>) => {
    for (const row of rows) {
      const rawStock = Math.max(0, Math.floor(Number(row.stock) || 0));
      if (rawStock <= 0) {
        updateStmt.run(0, 0, row.id);
        continue;
      }
      const issuedRow = countStmt.get(row.chat_id, row.id) as any;
      const issuedCount = Math.max(0, Math.floor(Number(issuedRow?.cnt || 0)));
      updateStmt.run(Math.max(0, rawStock - issuedCount), 1, row.id);
    }
  });
  transaction(items);
  setAppSetting("points_mall_stock_mode", "remaining_v1");
}

export function getConsoleAnnouncement(): string {
  return getAppSetting("console_announcement", "");
}

export function setConsoleAnnouncement(value: string): string {
  return setAppSetting("console_announcement", String(value || "").trim().slice(0, 5000));
}

export function getCommercialPaymentConfig(): CommercialPaymentConfig {
  return {
    enabled: getAppSetting("payment_enabled", "0") === "1" ? 1 : 0,
    base_url: getAppSetting("payment_base_url", "").trim(),
    pid: getAppSetting("payment_pid", "").trim(),
    key: getAppSetting("payment_key", "").trim(),
    site_name: getAppSetting("payment_site_name", "Telegram Bot 控制台").trim() || "Telegram Bot 控制台",
    payment_methods: getAppSetting("payment_methods", "all").trim() || "all",
    notify_path: getAppSetting("payment_notify_path", "/api/payment/xpay/notify").trim() || "/api/payment/xpay/notify",
    return_path: getAppSetting("payment_return_path", "/payment/xpay/return").trim() || "/payment/xpay/return",
    updated_at: getAppSetting("payment_updated_at", ""),
  };
}

export function setCommercialPaymentConfig(payload: {
  enabled: boolean;
  baseUrl: string;
  pid: string;
  key: string;
  siteName?: string;
  paymentMethods?: string;
  notifyPath?: string;
  returnPath?: string;
}): CommercialPaymentConfig {
  const normalizedPaymentMethods = ["all", "alipay", "wxpay"].includes(String(payload.paymentMethods || "all").trim())
    ? String(payload.paymentMethods || "all").trim()
    : "all";
  setAppSetting("payment_enabled", payload.enabled ? "1" : "0");
  setAppSetting("payment_base_url", String(payload.baseUrl || "").trim().replace(/\/$/, ""));
  setAppSetting("payment_pid", String(payload.pid || "").trim());
  setAppSetting("payment_key", String(payload.key || "").trim());
  setAppSetting("payment_site_name", String(payload.siteName || "Telegram Bot 控制台").trim().slice(0, 100));
  setAppSetting("payment_methods", normalizedPaymentMethods);
  setAppSetting("payment_notify_path", String(payload.notifyPath || "/api/payment/xpay/notify").trim().slice(0, 200));
  setAppSetting("payment_return_path", String(payload.returnPath || "/payment/xpay/return").trim().slice(0, 200));
  setAppSetting("payment_updated_at", toSqliteDateTime(new Date()));
  return getCommercialPaymentConfig();
}

export function markTelegramPrivateContact(userId: number): void {
  const normalizedUserId = Math.floor(Number(userId) || 0);
  if (!normalizedUserId) return;
  setAppSetting(`tg_private_contact_${normalizedUserId}`, toSqliteDateTime(new Date()));
}

export function hasTelegramPrivateContact(userId: number): boolean {
  const normalizedUserId = Math.floor(Number(userId) || 0);
  if (!normalizedUserId) return false;
  return !!getAppSetting(`tg_private_contact_${normalizedUserId}`, "").trim();
}

export function hasCommercialFeatureAccessForChat(chatId: number): boolean {
  const access = getCommercialChatAccess(chatId);
  return !!access?.subscriptionActive;
}

export function setCommercialAIConfig(
  userId: number,
  config: { enabled: boolean; baseUrl: string; apiKey: string; model: string; apiStyle?: string }
): void {
  db.prepare(`
    INSERT INTO commercial_ai_configs (user_id, enabled, base_url, api_key, model, api_style, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(user_id) DO UPDATE SET
      enabled = excluded.enabled,
      base_url = excluded.base_url,
      api_key = excluded.api_key,
      model = excluded.model,
      api_style = excluded.api_style,
      updated_at = excluded.updated_at
  `).run(
    userId,
    config.enabled ? 1 : 0,
    String(config.baseUrl || "").trim().replace(/\/$/, ""),
    String(config.apiKey || "").trim(),
    String(config.model || "").trim(),
    String(config.apiStyle || "auto").trim() || "auto"
  );
}

export function getCommercialAIConfig(userId: number): CommercialAIConfig | null {
  const row = db.prepare(`
    SELECT user_id, enabled, base_url, api_key, model, api_style, updated_at
    FROM commercial_ai_configs
    WHERE user_id = ?
  `).get(userId) as CommercialAIConfig | undefined;
  return row || null;
}

export function getEffectiveCommercialAIConfigForChat(chatId: number): {
  ownerUserId: number;
  baseUrl: string;
  apiKey: string;
  model: string;
  apiStyle: string;
} | null {
  const row = db.prepare(`
    SELECT
      c.owner_user_id AS ownerUserId,
      a.base_url AS baseUrl,
      a.api_key AS apiKey,
      a.model AS model,
      a.api_style AS apiStyle
    FROM commercial_chats c
    JOIN commercial_ai_configs a ON a.user_id = c.owner_user_id
    JOIN commercial_users u ON u.user_id = c.owner_user_id
    WHERE c.chat_id = ?
      AND COALESCE(u.frozen, 0) = 0
      AND a.enabled = 1
      AND a.base_url != ''
      AND a.api_key != ''
      AND a.model != ''
    LIMIT 1
  `).get(chatId) as any;
  if (!row) return null;
  return {
    ownerUserId: Number(row.ownerUserId || 0),
    baseUrl: String(row.baseUrl || ""),
    apiKey: String(row.apiKey || ""),
    model: String(row.model || ""),
    apiStyle: String(row.apiStyle || "auto"),
  };
}

// db 仅内部使用，所有操作通过上方的函数导出
