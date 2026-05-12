import { Bot, Context, InlineKeyboard } from "grammy";
import crypto from "node:crypto";
// import { callAI } from "./ai"; // Removed AI dependency
import { getUserName } from "./handlers";
import * as db from "./db";
import {
  registerBlackjackLaunchMessage,
  registerBlackjackPrivateEntryMessage,
  registerNiuNiuLaunchMessage,
  registerNiuNiuPrivateEntryMessage,
} from "./web";

// 游戏状态管理
const DUEL_POINTS_STAKE = 5;
const DUEL_MIN_POINTS_TO_PLAY = 100;
const BLACKJACK_TIMEOUT_MS = 90 * 1000;

type ActiveDuelState = {
  challenger: number;
  target: number;
  challengerName: string;
  targetName: string;
  timeout: NodeJS.Timeout;
  commandMsgId: number;
  mode: "mute" | "points";
  stakePoints: number;
};

type BlackjackCard = {
  rank: "A" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9" | "10" | "J" | "Q" | "K";
  suit: "♠" | "♥" | "♦" | "♣";
};

type BlackjackPlayerStatus = "active" | "stood" | "busted" | "blackjack";

type BlackjackPlayerState = {
  id: number;
  name: string;
  cards: BlackjackCard[];
  status: BlackjackPlayerStatus;
};

type ActiveBlackjackState = {
  sessionId: string;
  chatId: number;
  creatorId: number;
  creatorName: string;
  players: BlackjackPlayerState[];
  dealerCards: BlackjackCard[];
  phase: "lobby" | "playing";
  currentPlayerIndex: number;
  messageId: number;
  timeout: NodeJS.Timeout;
};

const activeDuels = new Map<string, ActiveDuelState>();
const activeBlackjackRooms = new Map<number, ActiveBlackjackState>();
const activeBlackjackSessionToChat = new Map<string, number>();
const activeRoulettes = new Map<number, {
  players: { id: number; name: string }[];
  currentPlayerIndex: number;
  slots: boolean[];
  currentSlot: number;
  lobbyMsgId: number;
  timeout: NodeJS.Timeout;
  isStarted: boolean;
}>();

export function registerGameHandlers(bot: Bot) {
  // ================= 辅助函数 =================

  function esc(text: any): string {
    if (text === undefined || text === null) return "";
    const str = String(text);
    return str
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
  }

  function getRouletteLobbyText(players: { name: string }[]) {
    const playerSymbols = ["①", "②", "③"];
    const playerList = players.map((p, i) => `${playerSymbols[i] || (i + 1) + "."} ${esc(p.name)}`).join("\n");
    const isInitiatorOnly = players.length === 1;
    const footer = isInitiatorOnly 
      ? "等待玩家加入... (立即开始)" 
      : "等待玩家加入... (需发起人点击“立即开始”)";

    return `🔫 <b>俄罗斯轮盘 (多人模式)</b>\n\n` +
      `发起人：<b>${esc(players[0].name)}</b>\n` +
      `当前人数：${players.length} / 3\n` +
      `玩家列表：\n${playerList}\n\n` +
      footer;
  }

  function mentionUser(userId: number, name: string): string {
    return `<a href="tg://user?id=${userId}"><b>${esc(name)}</b></a>`;
  }

  function pickRandom<T>(items: T[]): T {
    return items[Math.floor(Math.random() * items.length)];
  }

  function getWebBaseUrl(): string {
    const raw = String(process.env.WEB_BASE_URL || "").trim();
    if (raw) return raw.replace(/\/$/, "");

    const webhookUrl = String(process.env.WEBHOOK_URL || "").trim();
    if (webhookUrl) {
      try {
        return new URL(webhookUrl).origin;
      } catch { }
    }

    const port = Math.max(1, Number(process.env.WEB_PORT || 8787));
    return `http://127.0.0.1:${port}`;
  }

  function signBlackjackLaunch(chatId: number, dealerId: number, issuedAt: number): string {
    const botToken = String(process.env.BOT_TOKEN || "").trim();
    if (!botToken) return "";
    const payload = `${chatId}:${dealerId}:${issuedAt}`;
    return crypto.createHmac("sha256", botToken).update(payload).digest("hex").slice(0, 24);
  }

  function verifyBlackjackLaunchSig(chatId: number, dealerId: number, issuedAt: number, sig: string): boolean {
    const expected = signBlackjackLaunch(chatId, dealerId, issuedAt);
    if (!expected) return false;
    const incoming = String(sig || "").trim().toLowerCase();
    if (!incoming) return false;
    if (expected.length !== incoming.length) return false;
    return crypto.timingSafeEqual(Buffer.from(expected, "utf8"), Buffer.from(incoming, "utf8"));
  }

  function signNiuNiuLaunch(chatId: number, dealerId: number, issuedAt: number): string {
    const botToken = String(process.env.BOT_TOKEN || "").trim();
    if (!botToken) return "";
    const payload = `${chatId}:${dealerId}:${issuedAt}:niuniu`;
    return crypto.createHmac("sha256", botToken).update(payload).digest("hex").slice(0, 24);
  }

  function verifyNiuNiuLaunchSig(chatId: number, dealerId: number, issuedAt: number, sig: string): boolean {
    const expected = signNiuNiuLaunch(chatId, dealerId, issuedAt);
    if (!expected) return false;
    const incoming = String(sig || "").trim().toLowerCase();
    if (!incoming) return false;
    if (expected.length !== incoming.length) return false;
    return crypto.timingSafeEqual(Buffer.from(expected, "utf8"), Buffer.from(incoming, "utf8"));
  }

  function buildBlackjackWebAppUrl(chatId: number, dealerId: number, issuedAt: number = Date.now()): string {
    const baseUrl = getWebBaseUrl();
    const sig = signBlackjackLaunch(chatId, dealerId, issuedAt);
    const query = new URLSearchParams({
      chatId: String(chatId),
      dealerId: String(dealerId),
      ts: String(issuedAt),
      sig,
    });
    return `${baseUrl}/blackjack?${query.toString()}`;
  }

  function buildBlackjackStartPayload(chatId: number, dealerId: number, issuedAt: number): string {
    const sig = signBlackjackLaunch(chatId, dealerId, issuedAt);
    if (!sig) return "";
    const ts36 = Math.max(0, Math.floor(issuedAt)).toString(36);
    return `bj_${chatId}_${dealerId}_${ts36}_${sig}`;
  }

  function buildNiuNiuWebAppUrl(chatId: number, dealerId: number, issuedAt: number = Date.now()): string {
    const baseUrl = getWebBaseUrl();
    const sig = signNiuNiuLaunch(chatId, dealerId, issuedAt);
    const query = new URLSearchParams({
      chatId: String(chatId),
      dealerId: String(dealerId),
      ts: String(issuedAt),
      sig,
    });
    return `${baseUrl}/niuniu?${query.toString()}`;
  }

  function buildNiuNiuStartPayload(chatId: number, dealerId: number, issuedAt: number): string {
    const sig = signNiuNiuLaunch(chatId, dealerId, issuedAt);
    if (!sig) return "";
    const ts36 = Math.max(0, Math.floor(issuedAt)).toString(36);
    return `nn_${chatId}_${dealerId}_${ts36}_${sig}`;
  }

  let botUsernamePromise: Promise<string> | null = null;
  async function getBotUsername(): Promise<string> {
    if (!botUsernamePromise) {
      botUsernamePromise = bot.api.getMe().then((me) => String(me.username || "").trim());
    }
    return botUsernamePromise;
  }

  const BLACKJACK_RANKS: BlackjackCard["rank"][] = ["A", "2", "3", "4", "5", "6", "7", "8", "9", "10", "J", "Q", "K"];
  const BLACKJACK_SUITS: BlackjackCard["suit"][] = ["♠", "♥", "♦", "♣"];
  const BLACKJACK_MIN_PLAYERS = 2;
  const BLACKJACK_MAX_PLAYERS = 6;

  function createBlackjackSessionId(): string {
    let id = "";
    do {
      id = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
    } while (activeBlackjackSessionToChat.has(id));
    return id;
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

  function isBlackjack(cards: BlackjackCard[]): boolean {
    return cards.length === 2 && getBlackjackHandValue(cards) === 21;
  }

  function formatBlackjackCards(cards: BlackjackCard[]): string {
    return cards.map((card) => `${card.rank}${card.suit}`).join(" ");
  }

  function buildBlackjackLobbyKeyboard(sessionId: string): InlineKeyboard {
    return new InlineKeyboard()
      .text("🤝 加入牌桌", `bj2_join_${sessionId}`)
      .text("🎯 开始发牌", `bj2_start_${sessionId}`)
      .row()
      .text("🚪 退出房间", `bj2_leave_${sessionId}`)
      .text("🗑️ 关闭房间", `bj2_close_${sessionId}`);
  }

  function buildBlackjackTurnKeyboard(sessionId: string): InlineKeyboard {
    return new InlineKeyboard()
      .text("🃏 要牌", `bj2_hit_${sessionId}`)
      .text("✋ 停牌", `bj2_stand_${sessionId}`)
      .row()
      .text("🗑️ 结束本局", `bj2_close_${sessionId}`);
  }

  function getBlackjackRoomBySession(sessionId: string): ActiveBlackjackState | null {
    const chatId = activeBlackjackSessionToChat.get(sessionId);
    if (!chatId) return null;
    const room = activeBlackjackRooms.get(chatId);
    if (!room || room.sessionId !== sessionId) return null;
    return room;
  }

  function closeBlackjackRoom(chatId: number): ActiveBlackjackState | null {
    const room = activeBlackjackRooms.get(chatId);
    if (!room) return null;
    clearTimeout(room.timeout);
    activeBlackjackRooms.delete(chatId);
    activeBlackjackSessionToChat.delete(room.sessionId);
    return room;
  }

  function getBlackjackLobbyText(room: ActiveBlackjackState): string {
    const playerList = room.players
      .map((player, index) => `${index + 1}. ${esc(player.name)}`)
      .join("\n");
    return [
      "🃏 <b>21点（同桌比点）</b>",
      "",
      `发起人：${mentionUser(room.creatorId, room.creatorName)}`,
      `当前人数：<b>${room.players.length}</b> / ${BLACKJACK_MAX_PLAYERS}`,
      `开局条件：至少 <b>${BLACKJACK_MIN_PLAYERS}</b> 人`,
      "",
      `玩家列表：\n${playerList}`,
      "",
      "👇 先加入，再由发起者点击“开始发牌”。",
    ].join("\n");
  }

  function getBlackjackPlayerStatusText(player: BlackjackPlayerState, isCurrentTurn: boolean): string {
    if (player.status === "busted") return "💥 爆牌";
    if (player.status === "blackjack") return "🌟 Blackjack";
    if (player.status === "stood") return "✋ 已停牌";
    return isCurrentTurn ? "⏳ 操作中" : "⌛ 等待中";
  }

  function getBlackjackTableText(room: ActiveBlackjackState, revealDealer: boolean, statusText: string): string {
    const dealerCardsText = room.dealerCards.length === 0
      ? "--"
      : revealDealer
        ? formatBlackjackCards(room.dealerCards)
        : `${room.dealerCards[0].rank}${room.dealerCards[0].suit} 🂠`;

    const dealerPointsText = room.dealerCards.length === 0
      ? "--"
      : revealDealer
        ? String(getBlackjackHandValue(room.dealerCards))
        : `${getBlackjackHandValue([room.dealerCards[0]])}+?`;

    const playerLines = room.players.map((player, index) => {
      const points = player.cards.length > 0 ? getBlackjackHandValue(player.cards) : 0;
      const cardsText = player.cards.length > 0 ? formatBlackjackCards(player.cards) : "--";
      const isCurrentTurn = room.phase === "playing" && room.currentPlayerIndex === index && player.status === "active";
      const status = getBlackjackPlayerStatusText(player, isCurrentTurn);
      return `${index + 1}. ${mentionUser(player.id, player.name)} ｜ ${cardsText} ｜ <b>${points}</b> 点 ｜ ${status}`;
    }).join("\n");

    return [
      "🃏 <b>21点（同桌比点）</b>",
      "",
      `庄家手牌：${dealerCardsText}`,
      `庄家点数：<b>${dealerPointsText}</b>`,
      "",
      "玩家手牌：",
      playerLines,
      "",
      statusText,
    ].join("\n");
  }

  function findNextActiveBlackjackPlayer(room: ActiveBlackjackState, fromIndex: number): number {
    if (room.players.length === 0) return -1;
    for (let offset = 1; offset <= room.players.length; offset += 1) {
      const index = (fromIndex + offset) % room.players.length;
      if (room.players[index].status === "active") return index;
    }
    return -1;
  }

  function startBlackjackRoom(room: ActiveBlackjackState): void {
    room.phase = "playing";
    room.dealerCards = [drawBlackjackCard(), drawBlackjackCard()];
    for (const player of room.players) {
      player.cards = [drawBlackjackCard(), drawBlackjackCard()];
      player.status = isBlackjack(player.cards) ? "blackjack" : "active";
    }
    room.currentPlayerIndex = findNextActiveBlackjackPlayer(room, -1);
  }

  function settleBlackjackRoom(room: ActiveBlackjackState): string[] {
    for (const player of room.players) {
      if (player.status === "active") player.status = "stood";
    }

    const dealerNatural = isBlackjack(room.dealerCards);
    if (!dealerNatural) {
      while (getBlackjackHandValue(room.dealerCards) < 17) {
        room.dealerCards.push(drawBlackjackCard());
      }
    }

    const dealerValue = getBlackjackHandValue(room.dealerCards);
    const dealerBusted = dealerValue > 21;

    return room.players.map((player) => {
      const value = getBlackjackHandValue(player.cards);
      if (player.status === "busted") {
        return `• ${mentionUser(player.id, player.name)}：<b>${value}</b> 点，爆牌，负。`;
      }

      const playerNatural = player.status === "blackjack";
      if (playerNatural && dealerNatural) {
        return `• ${mentionUser(player.id, player.name)}：Blackjack，对庄家 Blackjack，平。`;
      }
      if (playerNatural && !dealerNatural) {
        return `• ${mentionUser(player.id, player.name)}：Blackjack，胜。`;
      }
      if (!playerNatural && dealerNatural) {
        return `• ${mentionUser(player.id, player.name)}：<b>${value}</b> 点，庄家 Blackjack，负。`;
      }

      if (dealerBusted) {
        return `• ${mentionUser(player.id, player.name)}：<b>${value}</b> 点，庄家爆牌，胜。`;
      }
      if (value > dealerValue) {
        return `• ${mentionUser(player.id, player.name)}：<b>${value}</b> 点，大于庄家 <b>${dealerValue}</b> 点，胜。`;
      }
      if (value < dealerValue) {
        return `• ${mentionUser(player.id, player.name)}：<b>${value}</b> 点，小于庄家 <b>${dealerValue}</b> 点，负。`;
      }
      return `• ${mentionUser(player.id, player.name)}：<b>${value}</b> 点，和庄。`;
    });
  }

  async function finishBlackjackRoom(chatId: number, prefixText: string) {
    const room = closeBlackjackRoom(chatId);
    if (!room) return;

    if (room.phase !== "playing" || room.dealerCards.length < 2) {
      try {
        await bot.api.editMessageText(
          room.chatId,
          room.messageId,
          getBlackjackTableText(room, true, prefixText),
          { parse_mode: "HTML" }
        );
      } catch { }
      return;
    }

    const settleLines = settleBlackjackRoom(room);
    const resultText = [prefixText, "", "<b>结算结果：</b>", ...settleLines].join("\n");

    try {
      await bot.api.editMessageText(
        room.chatId,
        room.messageId,
        getBlackjackTableText(room, true, resultText),
        { parse_mode: "HTML" }
      );
    } catch { }
  }

  function resetBlackjackRoomTimeout(chatId: number) {
    const room = activeBlackjackRooms.get(chatId);
    if (!room) return;
    clearTimeout(room.timeout);
    room.timeout = setTimeout(async () => {
      const current = activeBlackjackRooms.get(chatId);
      if (!current) return;
      if (current.phase === "lobby") {
        const closed = closeBlackjackRoom(chatId);
        if (!closed) return;
        try {
          await bot.api.editMessageText(
            closed.chatId,
            closed.messageId,
            getBlackjackLobbyText(closed) + "\n\n⏰ 房间超时未开始，已自动关闭。",
            { parse_mode: "HTML" }
          );
        } catch { }
        return;
      }

      await finishBlackjackRoom(chatId, "⏰ 本局长时间未操作，未操作玩家已自动停牌并直接结算。");
    }, BLACKJACK_TIMEOUT_MS);
  }

  function getPointsDuelNarration(winnerId: number, winnerName: string, loserId: number, loserName: string, stakePoints: number): string {
    const winner = mentionUser(winnerId, winnerName);
    const loser = mentionUser(loserId, loserName);
    const choices = [
      `${winner} 从 ${loser} 的尸体收刮了 <b>${stakePoints} 金圆券</b>。`,
      `${winner} 顺手把 ${loser} 的 <b>${stakePoints} 金圆券</b> 装进了自己的口袋。`,
      `${loser} 刚倒下，${winner} 已经摸走了 <b>${stakePoints} 金圆券</b>。`,
      `${winner} 技高一筹，收下了 ${loser} 的 <b>${stakePoints} 金圆券</b>。`,
    ];
    return pickRandom(choices);
  }

  async function checkPermissions(target: { api: any }, chatId: number, userId: number): Promise<boolean> {
    try {
      const chatMember = await target.api.getChatMember(chatId, userId);
      if (chatMember.status === "creator" || chatMember.status === "administrator") {
        return false; // 管理员不能被封禁
      }
      return true;
    } catch {
      return false;
    }
  }

  async function isAdmin(target: { api: any }, chatId: number, userId: number): Promise<boolean> {
    try {
      const chatMember = await target.api.getChatMember(chatId, userId);
      return chatMember.status === "creator" || chatMember.status === "administrator";
    } catch {
      return false;
    }
  }

  async function muteUser(target: { api: any }, chatId: number, userId: number, userName: string, durationMinutes: number) {
    if (!(await checkPermissions(target, chatId, userId))) {
      await target.api.sendMessage(chatId, `⚠️ 无法躺尸 <b>${esc(userName)}</b>，对方可能是管理员或机器人。`, { parse_mode: "HTML" });
      return false;
    }

    try {
      const untilDate = Math.floor(Date.now() / 1000) + durationMinutes * 60;
      await target.api.restrictChatMember(chatId, userId, { can_send_messages: false }, { until_date: untilDate });
      return true;
    } catch (e) {
      console.error("[Games] 禁言失败:", e);
      return false;
    }
  }

  function deleteAfter(chatId: number, messageId: number, seconds: number = 15) {
    setTimeout(async () => {
      try {
        await bot.api.deleteMessage(chatId, messageId);
      } catch { }
    }, seconds * 1000);
  }

  async function generateGameNarration(event: string, context: any): Promise<string> {
    const { userName, winnerName, loserName, targetName, challengerName } = context;

    if (event.includes("中弹")) {
      const choices = [
        `运气这种东西，看来今天没站在 <b>${esc(userName)}</b> 这边。`,
        `命运的小推车撞倒了 <b>${esc(userName)}</b>，砰的一声！`,
        `枪口冒着烟，<b>${esc(userName)}</b> 的眼前黑了下去。`,
        `这就叫“非”到家了，<b>${esc(userName)}</b> 喜提躺尸套餐一份。`
      ];
      return choices[Math.floor(Math.random() * choices.length)];
    }
    
    if (event.includes("空枪")) {
      const choices = [
        `死神刚才打了个哈欠，<b>${esc(userName)}</b> 逃过一劫。`,
        `咔哒一声，平安无事！<b>${esc(userName)}</b> 已经准备好了今晚的加餐。`,
        `虚惊一场，子弹看来并不想见 <b>${esc(userName)}</b>。`,
        `心脏都要跳出来了，还好是空枪。<b>${esc(userName)}</b> 长舒一口气。`
      ];
      return choices[Math.floor(Math.random() * choices.length)];
    }

    if (event.includes("击败")) {
      const choices = [
        `大漠风沙中，<b>${esc(winnerName)}</b> 的枪更快，<b>${esc(loserName)}</b> 应声而倒。`,
        `胜负已分！<b>${esc(winnerName)}</b> 展现了惊人的准度，<b>${esc(loserName)}</b> 只能遗憾离场。`,
        `<b>${esc(winnerName)}</b> 就像午后的阳光一样耀眼，而 <b>${esc(loserName)}</b> 则像影子里的一抹灰。`,
        `这是一场教科书式的决斗，<b>${esc(winnerName)}</b> 完胜，<b>${esc(loserName)}</b> 输得不冤。`
      ];
      return choices[Math.floor(Math.random() * choices.length)];
    }

    if (event.includes("挑战管理员")) {
      const choices = [
        `竟然敢挑战至高无上的管理员 <b>${esc(targetName)}</b>？<b>${esc(challengerName)}</b> 真是勇气可嘉。`,
        `法律面前人人平等，但管理员面前人人等死。<b>${esc(challengerName)}</b>深刻体会到了这一点。`,
        `这就叫以卵击石，<b>${esc(challengerName)}</b> 被 <b>${esc(targetName)}</b> 随手一挥就给处理了。`
      ];
      return choices[Math.floor(Math.random() * choices.length)];
    }

    return `事件发生了：${event}`;
  }

  // ================= 21 点 =================

  bot.command(["21", "bj", "blackjack"], async (ctx) => {
    if (!ctx.chat) {
      return;
    }

    if (ctx.chat.type === "private") {
      await ctx.reply("💡 请在目标群里发送 /21 发起牌桌。由于 Telegram 限制，群内发起后会引导你到私聊打开小程序。", {
        parse_mode: "HTML",
      });
      return;
    }

    const chatId = Number(ctx.chat.id);
    const userId = Number(ctx.from!.id);
    const baseUrl = getWebBaseUrl();
    let isHttpsBase = false;
    try {
      isHttpsBase = new URL(baseUrl).protocol === "https:";
    } catch {
      isHttpsBase = false;
    }

    if (!isHttpsBase) {
      await ctx.reply(
        `⚠️ <b>21点小程序暂时不可用</b>\n\n` +
        `当前 WEB 地址不是 HTTPS：\n<code>${esc(baseUrl)}</code>\n\n` +
        `请先把 <code>WEB_BASE_URL</code>（或 <code>WEBHOOK_URL</code>）配置为可公网访问的 HTTPS 域名，然后再试 <code>/21</code>。`,
        { parse_mode: "HTML" }
      );
      return;
    }

    const issuedAt = Date.now();
    const startPayload = buildBlackjackStartPayload(chatId, userId, issuedAt);
    if (!startPayload) {
      await ctx.reply("⚠️ BOT_TOKEN 未配置，无法生成 21点 小程序入口。", { parse_mode: "HTML" });
      return;
    }

    const botUsername = await getBotUsername().catch(() => "");
    if (!botUsername) {
      await ctx.reply("⚠️ 无法获取机器人用户名，暂时不能生成小程序入口。", { parse_mode: "HTML" });
      return;
    }

    const privateOpenUrl = `https://t.me/${botUsername}?start=${encodeURIComponent(startPayload)}`;
    const webAppUrl = buildBlackjackWebAppUrl(chatId, userId, issuedAt);

    const keyboard = new InlineKeyboard()
      .url("🃏 私聊打开牌桌", privateOpenUrl)
      .row()
      .url("🌐 浏览器围观", webAppUrl);

    try {
      const sent = await ctx.reply(
        `🃏 <b>21点（小程序版）</b>\n\n` +
        `• 房主(发起命令者)自动坐庄\n` +
        `• Telegram 限制：请先点按钮去私聊打开小程序\n` +
        `• 其他玩家也走同样流程进入牌桌\n` +
        `• 浏览器围观仅支持预览，无法操作\n` +
        `• 全程卡片牌面展示，不刷群聊\n\n` +
        `点击下方按钮进入牌桌。`,
        { parse_mode: "HTML", reply_markup: keyboard }
      );
      registerBlackjackLaunchMessage(chatId, sent.message_id);
      try { await ctx.deleteMessage(); } catch { }
    } catch (error) {
      console.error("[Blackjack] 发送小程序入口失败:", error);
      await ctx.reply(
        "⚠️ 21点小程序入口发送失败。请检查 WEB 地址是否可公网访问、证书是否有效，再重试 /21。"
      ).catch(() => { });
    }
  });

  bot.command(["nn", "niuniu", "bull"], async (ctx) => {
    if (!ctx.chat) return;

    if (ctx.chat.type === "private") {
      await ctx.reply("💡 请在目标群里发送 /nn 发起牛牛牌桌。由于 Telegram 限制，群内发起后会引导你到私聊打开小程序。", {
        parse_mode: "HTML",
      });
      return;
    }

    const chatId = Number(ctx.chat.id);
    const userId = Number(ctx.from!.id);
    const baseUrl = getWebBaseUrl();
    let isHttpsBase = false;
    try {
      isHttpsBase = new URL(baseUrl).protocol === "https:";
    } catch {
      isHttpsBase = false;
    }

    if (!isHttpsBase) {
      await ctx.reply(
        `⚠️ <b>牛牛小程序暂时不可用</b>\n\n` +
        `当前 WEB 地址不是 HTTPS：\n<code>${esc(baseUrl)}</code>\n\n` +
        `请先把 <code>WEB_BASE_URL</code>（或 <code>WEBHOOK_URL</code>）配置为可公网访问的 HTTPS 域名，然后再试 <code>/nn</code>。`,
        { parse_mode: "HTML" }
      );
      return;
    }

    const issuedAt = Date.now();
    const startPayload = buildNiuNiuStartPayload(chatId, userId, issuedAt);
    if (!startPayload) {
      await ctx.reply("⚠️ BOT_TOKEN 未配置，无法生成 牛牛 小程序入口。", { parse_mode: "HTML" });
      return;
    }

    const botUsername = await getBotUsername().catch(() => "");
    if (!botUsername) {
      await ctx.reply("⚠️ 无法获取机器人用户名，暂时不能生成小程序入口。", { parse_mode: "HTML" });
      return;
    }

    const privateOpenUrl = `https://t.me/${botUsername}?start=${encodeURIComponent(startPayload)}`;
    const webAppUrl = buildNiuNiuWebAppUrl(chatId, userId, issuedAt);
    const keyboard = new InlineKeyboard()
      .url("🐮 私聊打开牌桌", privateOpenUrl)
      .row()
      .url("🌐 浏览器围观", webAppUrl);

    try {
      const sent = await ctx.reply(
        `🐮 <b>牛牛（小程序版）</b>\n\n` +
        `• 房主(发起命令者)自动坐庄\n` +
        `• 闲家至少 1 人可开局\n` +
        `• 人数不限\n` +
        `• 结算倍率：牛8 x2、牛9 x3、牛牛 x4、炸弹 x5、金花 x6（10不算）、五小 x7\n` +
        `• 双方无牛且最大牌小于10时，庄家默认胜\n` +
        `• 再来一局时，闲家会自动离桌并需重新加入\n\n` +
        `点击下方按钮进入牌桌。`,
        { parse_mode: "HTML", reply_markup: keyboard }
      );
      registerNiuNiuLaunchMessage(chatId, sent.message_id);
      try { await ctx.deleteMessage(); } catch { }
    } catch (error) {
      console.error("[NiuNiu] 发送小程序入口失败:", error);
      await ctx.reply("⚠️ 牛牛小程序入口发送失败。请检查 WEB 地址是否可公网访问、证书是否有效，再重试 /nn。").catch(() => { });
    }
  });

  bot.command("start", async (ctx, next) => {
    if (ctx.chat?.type !== "private") {
      await next();
      return;
    }

    const payloadRaw = String((ctx as any).match || "").trim();
    const bjMatch = payloadRaw.match(/^bj_(-?\d+)_([0-9]{1,12})_([0-9a-z]{1,16})_([a-f0-9]{24})$/i);
    const nnMatch = payloadRaw.match(/^nn_(-?\d+)_([0-9]{1,12})_([0-9a-z]{1,16})_([a-f0-9]{24})$/i);
    const isNiuNiu = Boolean(nnMatch);
    const match = bjMatch || nnMatch;
    if (!match) {
      await next();
      return;
    }

    const commandMsgId = ctx.message?.message_id;

    try {
      const chatId = Number(match[1]);
      const dealerId = Number(match[2]);
      const issuedAt = parseInt(String(match[3] || "0"), 36);
      const sig = String(match[4] || "").toLowerCase();
      const viewerId = Number(ctx.from?.id || 0);

      if (!Number.isFinite(chatId) || !Number.isFinite(issuedAt) || !Number.isFinite(dealerId) || !viewerId) {
        await ctx.reply(`⚠️ 牌桌参数无效，请回群里重新发送 ${isNiuNiu ? "/nn" : "/21"}。`, { parse_mode: "HTML" });
        return;
      }

      if (Math.abs(Date.now() - issuedAt) > 30 * 60 * 1000) {
        await ctx.reply(`⏰ 这个牌桌入口已过期，请回群里重新发送 ${isNiuNiu ? "/nn" : "/21"}。`, { parse_mode: "HTML" });
        return;
      }

      const launchOk = isNiuNiu
        ? verifyNiuNiuLaunchSig(chatId, dealerId, issuedAt, sig)
        : verifyBlackjackLaunchSig(chatId, dealerId, issuedAt, sig);
      if (!launchOk) {
        await ctx.reply(`🚫 这个牌桌入口校验失败，请在群里重新发送 ${isNiuNiu ? "/nn" : "/21"}。`, { parse_mode: "HTML" });
        return;
      }

      const baseUrl = getWebBaseUrl();
      let isHttpsBase = false;
      try {
        isHttpsBase = new URL(baseUrl).protocol === "https:";
      } catch {
        isHttpsBase = false;
      }
      if (!isHttpsBase) {
        await ctx.reply(
          `⚠️ <b>${isNiuNiu ? "牛牛" : "21点"}小程序暂时不可用</b>\n\n` +
          `当前 WEB 地址不是 HTTPS：\n<code>${esc(baseUrl)}</code>\n\n` +
          `请让管理员先修正 HTTPS 后再试。`,
          { parse_mode: "HTML" }
        );
        return;
      }

      const webAppUrl = isNiuNiu
        ? buildNiuNiuWebAppUrl(chatId, dealerId, issuedAt)
        : buildBlackjackWebAppUrl(chatId, dealerId, issuedAt);
      const keyboard = new InlineKeyboard()
        .webApp(isNiuNiu ? "🐮 打开牛牛牌桌" : "🃏 打开卡牌牌桌", webAppUrl)
        .row()
        .url("🌐 浏览器围观", webAppUrl);

      const sent = await ctx.reply(
        `${isNiuNiu ? "🐮" : "🃏"} <b>牌桌入口已就绪</b>\n\n` +
        `${viewerId === dealerId ? "你是本局庄家。" : "你是本局闲家。"}点击按钮打开小程序。`,
        { parse_mode: "HTML", reply_markup: keyboard }
      );
      if (isNiuNiu) {
        registerNiuNiuPrivateEntryMessage(chatId, ctx.chat.id, sent.message_id);
      } else {
        registerBlackjackPrivateEntryMessage(chatId, ctx.chat.id, sent.message_id);
      }
    } finally {
      if (commandMsgId) {
        await ctx.api.deleteMessage(ctx.chat.id, commandMsgId).catch(() => { });
      }
    }
  });

  bot.on("callback_query:data", async (ctx, next) => {
    const data = ctx.callbackQuery.data;
    if (!data.startsWith("bj2_")) {
      await next();
      return;
    }

    await ctx.answerCallbackQuery({
      text: "21点已升级为小程序，请在群里重新发送 /21 打开卡牌牌桌。",
      show_alert: true,
    }).catch(() => { });
    return;
  });

  // ================= 俄罗斯轮盘 (多玩家版) =================

  bot.command(["rr", "roulette"], async (ctx) => {
    if (!ctx.chat || ctx.chat.type === "private") {
      await ctx.reply("⚠️ 此命令仅在群组可用。");
      return;
    }

    const chatId = ctx.chat.id;
    const pointsDuelEnabled = db.isPointsEnabled(chatId);
    const duelMode: "mute" | "points" = pointsDuelEnabled ? "points" : "mute";
    const userId = ctx.from!.id;
    const userName = getUserName(ctx.from);

    try { await ctx.deleteMessage(); } catch { }

    if (!(await checkPermissions(ctx, chatId, userId))) {
      await ctx.reply(`🚫 <b><a href="tg://user?id=${userId}">${esc(userName)}</a></b>，你是管理员，这种掉脑袋的游戏你还是别参加了，多危险啊！`, { parse_mode: "HTML" });
      return;
    }

    if (activeRoulettes.has(chatId)) {
      await ctx.reply("⏳ 这里的桌子上已经有一把枪了，等这一局结束再来吧。");
      return;
    }

    // 初始化 6 个弹巢，1 发子弹
    const slots = new Array(6).fill(false);
    slots[Math.floor(Math.random() * 6)] = true;

    const keyboard = new InlineKeyboard()
      .text("🤝 加入游戏", `rr_join_${chatId}`)
      .text("🎯 立即开始", `rr_start_${chatId}`)
      .row()
      .text("🚪 退出房间", `rr_leave_${chatId}`)
      .text("🗑️ 关闭房间", `rr_close_${chatId}`);

    const msg = await ctx.reply(
      getRouletteLobbyText([{ name: userName }]),
      { parse_mode: "HTML", reply_markup: keyboard }
    );

    activeRoulettes.set(chatId, {
      players: [{ id: userId, name: userName }],
      currentPlayerIndex: 0,
      slots,
      currentSlot: 0,
      lobbyMsgId: msg.message_id,
      timeout: null as any, // 移除自动开始定时器
      isStarted: false
    });
  });

  async function startRoulette(chatId: number) {
    const game = activeRoulettes.get(chatId);
    if (!game || game.isStarted) return;

    game.isStarted = true;

    const playerSymbols = ["①", "②", "③"];
    const playerList = game.players.map((p, i) => `${playerSymbols[i]} ${esc(p.name)}`).join("\n");

    await bot.api.editMessageText(chatId, game.lobbyMsgId,
      `🎲 <b>轮盘开始！</b>\n\n` +
      `参与玩家：\n${playerList}\n\n` +
      `准备好，审判即将开始...`,
      { parse_mode: "HTML" }
    ).catch(console.error);

    // 开始自动循环
    while (activeRoulettes.has(chatId)) {
      const g = activeRoulettes.get(chatId)!;
      const shooter = g.players[g.currentPlayerIndex];
      const symbol = playerSymbols[g.currentPlayerIndex];

      await new Promise(resolve => setTimeout(resolve, 2000));

      const isHit = g.slots[g.currentSlot];
      const narrative = await generateGameNarration(
        isHit ? "俄罗斯轮盘：扣动扳机，中弹了" : "俄罗斯轮盘：是空枪，换下一个人",
        { userName: shooter.name }
      );

      if (isHit) {
        const success = await muteUser(bot, chatId, shooter.id, shooter.name, 3);
        const resultText = success
          ? `💥 <b>第 ${g.currentSlot + 1} 枪：砰！</b>\n\n${narrative}\n\n💀 <b>${symbol} <a href="tg://user?id=${shooter.id}">${esc(shooter.name)}</a></b> 倒在了血泊中... (躺尸 3 分钟)`
          : `💥 <b>第 ${g.currentSlot + 1} 枪：砰！</b>\n\n${narrative}\n\n💀 <b>${symbol} <a href="tg://user?id=${shooter.id}">${esc(shooter.name)}</a></b> 竟然自带防弹衣？（躺尸失败）`;

        await bot.api.editMessageText(chatId, g.lobbyMsgId, resultText, { parse_mode: "HTML" }).catch(console.error);
        activeRoulettes.delete(chatId);
        deleteAfter(chatId, g.lobbyMsgId);
        break;
      } else {
        const text = `✨ <b>第 ${g.currentSlot + 1} 枪：嗒...</b>\n\n${narrative}\n\n` +
          `<b>${symbol} <a href="tg://user?id=${shooter.id}">${esc(shooter.name)}</a></b> 逃过一劫，枪传到了下一个人手中...`;

        await bot.api.editMessageText(chatId, g.lobbyMsgId, text, { parse_mode: "HTML" }).catch(console.error);

        g.currentSlot++;
        g.currentPlayerIndex = (g.currentPlayerIndex + 1) % g.players.length;
        // 继续循环
      }
    }
  }

  bot.on("callback_query:data", async (ctx, next) => {
    const data = ctx.callbackQuery.data;
    if (!data.startsWith("rr_")) {
      await next();
      return;
    }

    const chatId = ctx.chat?.id;
    if (!chatId) return;

    const parts = data.split("_");
    const action = parts[1];
    const targetChatId = parseInt(parts[2]);
    const game = activeRoulettes.get(targetChatId);

    if (!game) {
      await ctx.answerCallbackQuery({ text: "这局游戏已经结束了。", show_alert: true }).catch(() => { });
      return;
    }

    const userId = ctx.from.id;
    const userName = getUserName(ctx.from);

    if (action === "join") {
      if (game.isStarted) {
        await ctx.answerCallbackQuery({ text: "游戏已经开始了，等下一局吧。", show_alert: true }).catch(() => { });
        return;
      }
      if (game.players.some(p => p.id === userId)) {
        await ctx.answerCallbackQuery({ text: "你已经加入过这局游戏了。", show_alert: true }).catch(() => { });
        return;
      }
      if (game.players.length >= 3) {
        await ctx.answerCallbackQuery({ text: "由于桌子太小，最多只能 3 个人玩。", show_alert: true }).catch(() => { });
        return;
      }
      if (!(await checkPermissions(ctx, targetChatId, userId))) {
        await ctx.answerCallbackQuery({ text: "你是管理员，不准参加！", show_alert: true }).catch(() => { });
        return;
      }

      game.players.push({ id: userId, name: userName });

      const keyboard = new InlineKeyboard()
        .text("🤝 加入游戏", `rr_join_${targetChatId}`)
        .text("🎯 立即开始", `rr_start_${targetChatId}`)
        .row()
        .text("🚪 退出房间", `rr_leave_${targetChatId}`)
        .text("🗑️ 关闭房间", `rr_close_${targetChatId}`);

      await ctx.editMessageText(
        getRouletteLobbyText(game.players),
        { parse_mode: "HTML", reply_markup: keyboard }
      ).catch(() => { });

      await ctx.answerCallbackQuery({ text: "成功加入决斗台！" }).catch(() => { });
    }

    if (action === "start") {
      if (game.players[0].id !== userId) {
        await ctx.answerCallbackQuery({ text: "只有发起者才能手动提前开始游戏。", show_alert: true }).catch(() => { });
        return;
      }
      if (game.isStarted) return;
      await startRoulette(targetChatId);
      await ctx.answerCallbackQuery({ text: "准备开火！" }).catch(() => { });
    }

    if (action === "leave") {
      const playerIndex = game.players.findIndex(p => p.id === userId);
      if (playerIndex === -1) {
        await ctx.answerCallbackQuery({ text: "你还没加入这局游戏呢。", show_alert: true }).catch(() => { });
        return;
      }

      if (playerIndex === 0) {
        // 发起者离开，直接关闭房间
        activeRoulettes.delete(targetChatId);
        try {
          await ctx.editMessageText("🚪 <b>由于发起者离开，本局俄罗斯轮盘已关闭。</b>", { parse_mode: "HTML" });
          deleteAfter(targetChatId, ctx.callbackQuery.message!.message_id, 5);
        } catch { }
        await ctx.answerCallbackQuery({ text: "你离开了房间，游戏已取消。" }).catch(() => { });
        return;
      }

      // 其他人离开，更新列表
      game.players.splice(playerIndex, 1);
      const keyboard = new InlineKeyboard()
        .text("🤝 加入游戏", `rr_join_${targetChatId}`)
        .text("🎯 立即开始", `rr_start_${targetChatId}`)
        .row()
        .text("🚪 退出房间", `rr_leave_${targetChatId}`)
        .text("🗑️ 关闭房间", `rr_close_${targetChatId}`);

      await ctx.editMessageText(
        getRouletteLobbyText(game.players),
        { parse_mode: "HTML", reply_markup: keyboard }
      ).catch(() => { });

      await ctx.answerCallbackQuery({ text: "你已退出房间。" }).catch(() => { });
      return;
    }

    if (action === "close") {
      const isInitiator = game.players[0].id === userId;
      const admin = await isAdmin(ctx, targetChatId, userId);

      if (!isInitiator && !admin) {
        await ctx.answerCallbackQuery({ text: "只有发起者或管理员才能关闭房间。", show_alert: true }).catch(() => { });
        return;
      }

      activeRoulettes.delete(targetChatId);
      try {
        await ctx.editMessageText("🚪 <b>本局俄罗斯轮盘已由发起者或管理员关闭。</b>", { parse_mode: "HTML" });
        deleteAfter(targetChatId, ctx.callbackQuery.message!.message_id, 5);
      } catch { }
      await ctx.answerCallbackQuery({ text: "房间已关闭。" }).catch(() => { });
      return;
    }

    if (action === "shoot") {
      // 移除手动开枪逻辑，已改为自动进行
      await ctx.answerCallbackQuery({ text: "现在是全自动模式，坐稳扶好！", show_alert: true }).catch(() => { });
    }
  });

  // ================= 决斗 =================

  bot.command("dd", async (ctx) => {
    if (!ctx.chat || ctx.chat.type === "private") {
      await ctx.reply("⚠️ 此命令仅在群组可用。");
      return;
    }

    const reply = ctx.message?.reply_to_message;
    if (!reply || !reply.from) {
      await ctx.reply("💬 请回复一个你想挑战的用户的消息来发起决斗！\n用法：回复目标消息并输入 `/dd`", { parse_mode: "HTML" });
      return;
    }

    const challengerId = ctx.from!.id;
    const targetId = reply.from.id;
    const challengerName = getUserName(ctx.from);
    const targetName = getUserName(reply.from);

    if (challengerId === targetId) {
      await ctx.reply("😅 你不能和自己决斗，那是自残。");
      return;
    }

    if (reply.from.is_bot) {
      await ctx.reply("🤖 你不能挑战机器人，我们没有实体，免疫子弹。");
      return;
    }

    const chatId = ctx.chat.id;
    const pointsDuelEnabled = db.isPointsEnabled(chatId);
    const duelMode: "mute" | "points" = pointsDuelEnabled ? "points" : "mute";

    if (duelMode === "mute") {
      // 积分系统关闭时，保持原逻辑：管理员不可参与
      if (!(await checkPermissions(ctx, chatId, challengerId))) {
        await ctx.reply(`🚫 <b><a href="tg://user?id=${challengerId}">${esc(challengerName)}</a></b>，你是管理员，不能发起决斗！`, { parse_mode: "HTML" });
        return;
      }

      const targetIsAdmin = !(await checkPermissions(ctx, chatId, targetId));
      const challengerIsAdmin = !(await checkPermissions(ctx, chatId, challengerId));

      if (targetIsAdmin && !challengerIsAdmin) {
        const narrative = await generateGameNarration("决斗：由于挑战管理员而直接判输", { challengerName, targetName });
        const success = await muteUser(ctx, chatId, challengerId, challengerName, 3);

        let text = `🎯 <b>决斗结果</b>\n\n` +
          `🤠 <b><a href="tg://user?id=${challengerId}">${esc(challengerName)}</a></b> 竟然不知好歹地向 <a href="tg://user?id=${targetId}"><b>${esc(targetName)}</b></a> 发起了挑战！\n\n` +
          `🤜 <b>Big胆！管理员 不可战胜，权力不许挑衅！</b>\n\n` +
          `${narrative}\n\n`;

        if (success) {
          text += `💀 <b>${esc(challengerName)}</b> 已被处理（躺尸 3 分钟）。`;
        } else {
          text += `💀 <b>${esc(challengerName)}</b> 逃过一劫（由于权限不足无法躺尸）。`;
        }

        const msg = await ctx.reply(text, { parse_mode: "HTML" });
        deleteAfter(chatId, msg.message_id);
        deleteAfter(chatId, ctx.message!.message_id);
        return;
      }

      if (targetIsAdmin) {
        await ctx.reply(`🚫 <b><a href="tg://user?id=${targetId}">${esc(targetName)}</a></b> 是管理员，管理员之间可以通过内部协商解决问题，不必动武。`, { parse_mode: "HTML" });
        return;
      }
    } else {
      // 积分系统开启时，管理员可参与，赌注为积分
      const challengerPoints = db.getUserPoints(chatId, challengerId).total;
      const targetPoints = db.getUserPoints(chatId, targetId).total;
      if (challengerPoints < DUEL_MIN_POINTS_TO_PLAY) {
        await ctx.reply(`💸 <b><a href="tg://user?id=${challengerId}">${esc(challengerName)}</a></b> 的积分低于 <code>${DUEL_MIN_POINTS_TO_PLAY}</code>，暂时不能发起积分决斗。`, { parse_mode: "HTML" });
        return;
      }
      if (targetPoints < DUEL_MIN_POINTS_TO_PLAY) {
        await ctx.reply(`💸 <b><a href="tg://user?id=${targetId}">${esc(targetName)}</a></b> 的积分低于 <code>${DUEL_MIN_POINTS_TO_PLAY}</code>，本次积分决斗无法发起。`, { parse_mode: "HTML" });
        return;
      }
      if (challengerPoints < DUEL_POINTS_STAKE) {
        await ctx.reply(`💸 <b><a href="tg://user?id=${challengerId}">${esc(challengerName)}</a></b> 的积分不足 <code>${DUEL_POINTS_STAKE}</code>，暂时无法发起积分决斗。`, { parse_mode: "HTML" });
        return;
      }
      if (targetPoints < DUEL_POINTS_STAKE) {
        await ctx.reply(`💸 <b><a href="tg://user?id=${targetId}">${esc(targetName)}</a></b> 的积分不足 <code>${DUEL_POINTS_STAKE}</code>，本次积分决斗无法发起。`, { parse_mode: "HTML" });
        return;
      }
    }

    const duelKey = `${chatId}:${challengerId}:${targetId}`;

    if (activeDuels.has(duelKey)) {
      await ctx.reply("⏳ 你们之间已经有一个待定的决斗邀请了！");
      return;
    }

    const keyboard = new InlineKeyboard()
      .text("⚔️ 接受应战", `duel_accept_${chatId}_${challengerId}_${targetId}`)
      .text("🏳️ 认输拒绝", `duel_decline_${chatId}_${challengerId}_${targetId}`);

    const msg = await ctx.reply(
      `🎯 <b>决斗挑战！</b>\n\n` +
      `🤠 <b><a href="tg://user?id=${challengerId}">${esc(challengerName)}</a></b> 向 <a href="tg://user?id=${targetId}"><b>${esc(targetName)}</b></a> 发起了决斗挑战！\n\n` +
      `${duelMode === "points" ? `赌注：<b>${DUEL_POINTS_STAKE} 积分</b>（胜者 +${DUEL_POINTS_STAKE}，败者 -${DUEL_POINTS_STAKE}）\n参与门槛：双方积分需 ≥ <b>${DUEL_MIN_POINTS_TO_PLAY}</b>` : `赌注：<b>3 分钟躺尸</b>`}\n` +
      `请在 60 秒内决定是否接受应战。`,
      { parse_mode: "HTML", reply_markup: keyboard }
    );

    const timeout = setTimeout(async () => {
      if (activeDuels.has(duelKey)) {
        const duel = activeDuels.get(duelKey)!;
        activeDuels.delete(duelKey);
        try {
          await bot.api.editMessageText(
            chatId,
            msg.message_id,
            `⏰ 决斗时限已到，<b>${esc(duel.targetName)}</b> 看来并不想理会这次挑战。${duel.mode === "points" ? "\n💰 未开战，积分不变。" : ""}`,
            { parse_mode: "HTML" }
          );
          deleteAfter(chatId, msg.message_id);
          deleteAfter(chatId, duel.commandMsgId);
        } catch { }
      }
    }, 60 * 1000);

    activeDuels.set(duelKey, {
      challenger: challengerId,
      target: targetId,
      challengerName,
      targetName,
      timeout,
      commandMsgId: ctx.message!.message_id,
      mode: duelMode,
      stakePoints: DUEL_POINTS_STAKE,
    });
  });

  bot.on("callback_query:data", async (ctx, next) => {
    const data = ctx.callbackQuery.data;
    if (!data.startsWith("duel_")) {
      await next();
      return;
    }

    const userId = ctx.from.id;
    const parts = data.split("_");
    const action = parts[1];
    const chatId = parseInt(parts[2]);
    const challengerId = parseInt(parts[3]);
    const targetId = parseInt(parts[4]);

    const duelKey = `${chatId}:${challengerId}:${targetId}`;
    const duel = activeDuels.get(duelKey);

    if (!duel) {
      await ctx.answerCallbackQuery({ text: "该决斗邀请已失效或已结束。", show_alert: true }).catch(() => { });
      return;
    }

    if (userId !== targetId) {
      await ctx.answerCallbackQuery({ text: "这不是给你的挑战！", show_alert: true }).catch(() => { });
      return;
    }

    clearTimeout(duel.timeout);
    activeDuels.delete(duelKey);

    if (action === "decline") {
      await ctx.answerCallbackQuery({ text: "你拒绝了决斗。" }).catch(() => { });
      await ctx.api.editMessageText(chatId, ctx.callbackQuery.message!.message_id, `🏳️ <b><a href="tg://user?id=${duel.target}">${esc(duel.targetName)}</a></b> 选择了退避三舍，决斗取消。${duel.mode === "points" ? "\n💰 未开战，积分不变。" : ""}`, { parse_mode: "HTML" });
      deleteAfter(chatId, ctx.callbackQuery.message!.message_id);
      deleteAfter(chatId, duel.commandMsgId);
      return;
    }

    if (action === "accept") {
      if (duel.mode === "mute" && !(await checkPermissions(ctx, chatId, targetId))) {
        await ctx.answerCallbackQuery({ text: "你现在是管理员了，不能参与决斗！", show_alert: true }).catch(() => { });
        await ctx.api.editMessageText(chatId, ctx.callbackQuery.message!.message_id, `🚫 <b><a href="tg://user?id=${duel.target}">${esc(duel.targetName)}</a></b> 变成了管理员，决斗强制取消。`, { parse_mode: "HTML" });
        return;
      }

      if (duel.mode === "points") {
        if (!db.isPointsEnabled(chatId)) {
          await ctx.answerCallbackQuery({ text: "本群积分系统已关闭，决斗取消。", show_alert: true }).catch(() => { });
          await ctx.api.editMessageText(chatId, ctx.callbackQuery.message!.message_id, "⚠️ 本群积分系统已关闭，本次积分决斗取消，未发生积分变动。", { parse_mode: "HTML" });
          return;
        }
        const challengerPoints = db.getUserPoints(chatId, duel.challenger).total;
        const targetPoints = db.getUserPoints(chatId, duel.target).total;
        if (
          challengerPoints < DUEL_MIN_POINTS_TO_PLAY ||
          targetPoints < DUEL_MIN_POINTS_TO_PLAY ||
          challengerPoints < duel.stakePoints ||
          targetPoints < duel.stakePoints
        ) {
          await ctx.answerCallbackQuery({ text: "有人积分不足，决斗取消。", show_alert: true }).catch(() => { });
          await ctx.api.editMessageText(
            chatId,
            ctx.callbackQuery.message!.message_id,
            `⚠️ 积分决斗取消：双方都需要至少 <code>${DUEL_MIN_POINTS_TO_PLAY}</code> 积分才能开战。`,
            { parse_mode: "HTML" }
          );
          return;
        }
      }

      await ctx.answerCallbackQuery({ text: "接受挑战！准备开火..." }).catch(() => { });

      const msgId = ctx.callbackQuery.message!.message_id;
      await ctx.api.editMessageText(chatId, msgId, `🤠 <b>决斗开始！</b>\n\n两人背对背行走，10步之后，猛然转身...\n3... 2... 1...`, { parse_mode: "HTML" });

      // 等待 2 秒增加悬念
      await new Promise(resolve => setTimeout(resolve, 2000));

      const winnerIsChallenger = Math.random() > 0.5;
      const winnerId = winnerIsChallenger ? duel.challenger : duel.target;
      const loserId = winnerIsChallenger ? duel.target : duel.challenger;
      const winnerName = winnerIsChallenger ? duel.challengerName : duel.targetName;
      const loserName = winnerIsChallenger ? duel.targetName : duel.challengerName;

      const narrative = await generateGameNarration(
        `决斗结果：${winnerName} 击败了 ${loserName}`,
        { winnerName, loserName }
      );

      let resultText = "";
      if (duel.mode === "points") {
        const deducted = db.consumePoints(chatId, loserId, duel.stakePoints, "游戏入账");
        if (!deducted) {
          resultText = `⚠️ 决斗结算失败：<b><a href="tg://user?id=${loserId}">${esc(loserName)}</a></b> 积分不足或积分系统状态变化，未发生积分变动。`;
        } else {
          const credited = db.creditUserPoints(chatId, winnerId, duel.stakePoints, "游戏入账");
          if (!credited) {
            db.creditUserPoints(chatId, loserId, duel.stakePoints, "游戏入账");
            resultText = "⚠️ 决斗结算失败：积分入账异常，已回滚扣分。";
          } else {
            const pointsNarrative = getPointsDuelNarration(winnerId, winnerName, loserId, loserName, duel.stakePoints);
            resultText =
              `💥 <b>砰！</b>\n\n${narrative}\n\n` +
              `🏆 赢家：<b><a href="tg://user?id=${winnerId}"><b>${esc(winnerName)}</b></a></b>\n` +
              `💀 输家：<b><a href="tg://user?id=${loserId}"><b>${esc(loserName)}</b></a></b>\n` +
              `💰 ${pointsNarrative}`;
          }
        }
      } else {
        const success = await muteUser(ctx, chatId, loserId, loserName, 3);
        resultText = success
          ? `💥 <b>砰！</b>\n\n${narrative}\n\n🏆 赢家：<b><a href="tg://user?id=${winnerId}"><b>${esc(winnerName)}</b></a></b>\n💀 输家：<b><a href="tg://user?id=${loserId}"><b>${esc(loserName)}</b></a></b> (躺尸 3 分钟)`
          : `💥 <b>砰！</b>\n\n${narrative}\n\n🏆 赢家：<b><a href="tg://user?id=${winnerId}"><b>${esc(winnerName)}</b></a></b>\n💀 输家：<b><a href="tg://user?id=${loserId}"><b>${esc(loserName)}</b></a></b> (由于权限不足，未执行躺尸)`;
      }

      await ctx.api.editMessageText(chatId, msgId, resultText, { parse_mode: "HTML" });
      deleteAfter(chatId, msgId);
      deleteAfter(chatId, duel.commandMsgId);
    }
  });
}
