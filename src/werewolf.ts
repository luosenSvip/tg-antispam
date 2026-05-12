import { Bot, Context, InlineKeyboard } from "grammy";
import { getUserName } from "./handlers";
import {
  creditWerewolfWinRewardPoints,
  getAIDisabledReason,
  getCommercialChatAccess,
  getWerewolfHistory,
  getWerewolfWinRewardDailyLimit,
  getWerewolfWinRewardPoints,
  isAIEnabled,
  isPointsAdminUser,
  isPointsEnabled,
  recordWerewolfPlayers,
  setAIEnabled,
  setWerewolfWinRewardDailyLimit,
  setWerewolfWinRewardPoints,
} from "./db";

export type Role = "werewolf" | "seer" | "villager" | "hunter" | "witch" | "guard" | "white_wolf_king" | "cupid";

export interface Player {
  id: number;
  name: string;
  role: Role;
  isAlive: boolean;
  position: number; // 进房间的序号
}

export type GamePhase = "lobby" | "night" | "day" | "discussion" | "voting" | "hunter_shot" | "guard" | "cupid";

export interface WWGame {
  chatId: number;
  phase: GamePhase;
  players: Map<number, Player>;
  lobbyMessageId?: number;
  dayCount: number;

  // Night actions
  wwVotes: Map<number, number>; // werewolfId -> targetId
  wolvesLockedThisNight: boolean; // Whether wolves can still change target this night
  seerCheckedTargets: Map<number, number>; // seerId -> targetId

  // Day voting
  dayVotes: Map<number, number>; // voterId -> targetId
  voteMessageId?: number;
  groupMessageIds: number[]; // Track all group messages for cleanup

  timeout?: NodeJS.Timeout;
  nightTimeoutToken: number;

  // Hunter ability
  firedHunterIds: number[]; // Hunter IDs who have already fired
  hunterShotQueue: number[];
  hunterShotNextPhase?: "night" | "day";
  pendingHunterShotId?: number; // The hunter who is currently shooting
  hunterShotMessageId?: number; // 群内猎人开枪面板消息ID（用于收起过期键盘）

  // Guard ability
  nightProtectedId?: number;
  lastProtectedId?: number;

  // Cupid ability
  lovers?: number[]; // [id1, id2]
  cupidTargetIds?: number[]; // Temp to store selections

  // Witch ability
  usedHealWitchIds: number[]; // Witch IDs who have used their heal
  usedPoisonWitchIds: number[]; // Witch IDs who have used their poison

  // Night tracking
  wolfKillId?: number;
  witchesActedThisNight: number[]; // Witch IDs who acted tonight
  nightHealIds: number[]; // People healed tonight
  nightPoisonIds: number[]; // People poisoned tonight
  witchesMessageSentThisNight: number[]; // Witch IDs who already received a private message tonight

  // White wolf king (day detonation before voting)
  dayWWKPendingId?: number;
  dayWWKChoosingTarget?: boolean;
  dayWWKTimeout?: NodeJS.Timeout;

  lastNightKilledIds: number[]; // 昨晚死掉的人
  graceMessageRemainingIds: Set<number>; // 昨晚死掉的人可以在今天白天讨论发一句言
  creatorId: number;
  creatorName: string;

  // Werewolf coordination
  wolfMessageIds: Map<number, number>; // werewolfId -> messageId in private chat
  witchMessageIds: Map<number, number>; // witchId -> messageId in private chat
  seerMessageIds: Map<number, number>; // seerId -> messageId in private chat
  guardMessageIds: Map<number, number>; // guardId -> messageId in private chat
  cupidMessageIds: Map<number, number>; // cupidId -> messageId in private chat
  dayWWKMessageIds: Map<number, number>; // white_wolf_king private message for day detonation

  // Lobby refresh
  lobbyRefreshTimeout?: NodeJS.Timeout;
  lastRecallMessageId?: number;
}


// 游戏时长配置 (秒)
const TIMEOUTS = {
  NIGHT: 40,
  DISCUSSION: 90,
  VOTING: 40,
  HUNTER: 30,
};

const activeGames = new Map<number, WWGame>();
const NONE_ID = 888888; // 独特标识符，用于弃票、平安夜或无目标，避免与真人(正数)或AI(负数)冲突
const WW_AI_RESTORE_DELAY_MS = 10 * 60 * 1000;
const aiRestoreTimers = new Map<number, NodeJS.Timeout>();

// 延时函数
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export function registerWerewolfHandlers(bot: Bot) {
  // ================= 辅助函数 =================
  function clearAiRestoreTimer(chatId: number) {
    const timer = aiRestoreTimers.get(chatId);
    if (!timer) return;
    clearTimeout(timer);
    aiRestoreTimers.delete(chatId);
  }

  function disableAiForWerewolfLobby(chatId: number): boolean {
    clearAiRestoreTimer(chatId);
    if (!isAIEnabled(chatId)) return false;
    setAIEnabled(chatId, false, { disabledReason: "werewolf_game" });
    return true;
  }

  function scheduleAiRestoreAfterGame(chatId: number) {
    clearAiRestoreTimer(chatId);
    const timer = setTimeout(async () => {
      aiRestoreTimers.delete(chatId);
      if (activeGames.has(chatId)) return;
      if (isAIEnabled(chatId)) return;
      if (getAIDisabledReason(chatId) !== "werewolf_game") return;

      setAIEnabled(chatId, true);
      try {
        const tip = await bot.api.sendMessage(
          chatId,
          "✅ 狼人杀已结束，且 10 分钟内未创建新大厅，已自动恢复本群 AI 检测。"
        );
        setTimeout(() => bot.api.deleteMessage(chatId, tip.message_id).catch(() => { }), 30_000);
      } catch { }
    }, WW_AI_RESTORE_DELAY_MS);
    aiRestoreTimers.set(chatId, timer);
  }

  function esc(text: string): string {
    return String(text)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
  }

  function getAlivePlayers(game: WWGame): Player[] {
    return Array.from(game.players.values()).filter(p => p.isAlive);
  }

  function getPlayersByRole(game: WWGame, role: Role, aliveOnly = true): Player[] {
    return Array.from(game.players.values()).filter(p => p.role === role && (!aliveOnly || p.isAlive));
  }

  function getPLabel(p: Player): string {
    const circled = [
      "", "①", "②", "③", "④", "⑤", "⑥", "⑦", "⑧", "⑨", "⑩",
      "⑪", "⑫", "⑬", "⑭", "⑮", "⑯", "⑰", "⑱", "⑲", "⑳",
      "㉑", "㉒", "㉓", "㉔", "㉕", "㉖", "㉗", "㉘", "㉙", "㉚",
      "㉛", "㉜", "㉝", "㉞", "㉟", "㊱", "㊲", "㊳", "㊴", "㊵",
      "㊶", "㊷", "㊸", "㊹", "㊺", "㊻", "㊼", "㊽", "㊾", "㊿"
    ];
    const prefix = p.position < circled.length ? circled[p.position] : `${p.position}.`;
    return `${prefix} ${p.name}`;
  }

  function getPName(p: Player): string {
    return esc(getPLabel(p));
  }

  function mentionUser(userId: number, name: string): string {
    return `<a href="tg://user?id=${userId}">${esc(name)}</a>`;
  }

  function isSuperAdminUserId(userId?: number): boolean {
    const adminId = Number(process.env.ADMIN_USER_ID || 0);
    return !!userId && adminId > 0 && userId === adminId;
  }

  async function checkIsAdmin(ctx: Context, chatId: number, userId: number): Promise<boolean> {
    try {
      const members = await ctx.api.getChatAdministrators(chatId);
      return members.some((m) => m.user.id === userId);
    } catch {
      return false;
    }
  }

  function getWinningPlayers(game: WWGame, winner: "werewolves" | "villagers" | "lovers"): Player[] {
    const players = Array.from(game.players.values());
    if (winner === "lovers") {
      const loverIds = new Set((game.lovers || []).map((id) => Number(id)));
      return players.filter((p) => loverIds.has(p.id));
    }
    if (winner === "werewolves") {
      return players.filter((p) => isWolfRole(p.role));
    }
    return players.filter((p) => !isWolfRole(p.role));
  }

  function settleWerewolfWinPoints(game: WWGame, winner: "werewolves" | "villagers" | "lovers"): string | null {
    const rewardPoints = getWerewolfWinRewardPoints(game.chatId);
    const dailyLimit = getWerewolfWinRewardDailyLimit(game.chatId);
    const dailyLimitText = dailyLimit > 0 ? `${dailyLimit} 次/人/日` : "不限";
    if (rewardPoints <= 0) return null;

    if (!isPointsEnabled(game.chatId)) {
      return `💰 <b>胜利积分配置:</b> 每人 <code>+${rewardPoints}</code>
📈 <b>每日入账次数上限:</b> <code>${dailyLimitText}</code>
⚠️ 群积分系统未开启，本局未自动入账。`;
    }

    const access = getCommercialChatAccess(game.chatId);
    if (!access?.subscriptionActive) {
      return `💰 <b>胜利积分配置:</b> 每人 <code>+${rewardPoints}</code>
📈 <b>每日入账次数上限:</b> <code>${dailyLimitText}</code>
⚠️ 当前群组订阅未生效，本局未自动入账。`;
    }

    const winners = getWinningPlayers(game, winner).filter((p) => p.id > 0);
    if (winners.length <= 0) {
      return `💰 <b>胜利积分配置:</b> 每人 <code>+${rewardPoints}</code>
📈 <b>每日入账次数上限:</b> <code>${dailyLimitText}</code>
⚠️ 本局胜方无可入账真人玩家。`;
    }

    let credited = 0;
    let limited = 0;
    for (const player of winners) {
      const result = creditWerewolfWinRewardPoints(game.chatId, player.id, rewardPoints, "游戏入账");
      if (result.credited) {
        credited += 1;
      } else if (result.reachedDailyLimit) {
        limited += 1;
      }
    }

    const limitTail = dailyLimit > 0
      ? `，达上限未入账 <code>${limited}</code> 人`
      : "";
    return `💰 <b>胜利积分:</b> 每人 <code>+${rewardPoints}</code>
📈 <b>每日入账次数上限:</b> <code>${dailyLimitText}</code>
✅ <b>本局入账:</b> 已入账 <code>${credited}</code> 人${limitTail}`;
  }

  async function getWerewolfRewardPermissionDenyReason(ctx: Context, chatId: number, userId: number): Promise<string | null> {
    if (isSuperAdminUserId(userId)) return null;
    const access = getCommercialChatAccess(chatId);
    if (!access?.subscriptionActive) {
      return "⚠️ 狼人杀胜利积分属于订阅功能，请先绑定有效订阅。";
    }
    if (access.ownerUserId === userId) {
      if (await checkIsAdmin(ctx, chatId, userId)) return null;
      return "⚠️ 仅当前群管理员可设置狼人杀胜利积分。";
    }
    if (isPointsAdminUser(chatId, userId) && await checkIsAdmin(ctx, chatId, userId)) {
      return null;
    }
    return "⚠️ 仅群组绑定的订阅用户可设置。绑定账号可使用 <code>/points admin add</code> 授权其他群管理员。";
  }

  function getHostLine(game: WWGame): string {
    return `👑 <b>房主:</b> ${mentionUser(game.creatorId, game.creatorName)}`;
  }

  function getLobbyPlayersText(game: WWGame): string {
    const text = Array.from(game.players.values())
      .sort((a, b) => a.position - b.position)
      .map((p) => getPName(p))
      .join(", ");
    return text || "暂无玩家";
  }

  function rebalanceLobbyPlayerPositions(game: WWGame): void {
    const sorted = Array.from(game.players.values()).sort((a, b) => a.position - b.position);
    sorted.forEach((player, index) => {
      player.position = index + 1;
    });
  }

  function isIgnorableEditError(error: any): boolean {
    const desc = String(error?.description || error?.message || "").toLowerCase();
    return (
      desc.includes("message is not modified") ||
      desc.includes("message to edit not found") ||
      desc.includes("message can't be edited") ||
      desc.includes("message_id_invalid") ||
      desc === "bad request: not found"
    );
  }

  function getActiveWolvesForVoting(game: WWGame): Player[] {
    return getPlayersByRole(game, "werewolf", true)
      .concat(getPlayersByRole(game, "white_wolf_king", true));
  }

  function isWolfRole(role: Role): boolean {
    return role === "werewolf" || role === "white_wolf_king";
  }

  function isNightLikePhase(phase: GamePhase): boolean {
    return phase === "night" || phase === "guard" || phase === "cupid";
  }

  function getWWKillStatusText(game: WWGame) {
    const wolves = getActiveWolvesForVoting(game);
    const votesText: string[] = [];

    wolves.forEach(wolf => {
      const targetId = game.wwVotes.get(wolf.id);
      const wolfName = getPName(wolf);
      if (targetId === undefined) {
        votesText.push(`- ${wolfName}: ⏳ 思考中...`);
      } else if (targetId === NONE_ID) {
        votesText.push(`- ${wolfName}: 🏳️ 【空刀/弃权】`);
      } else {
        const target = game.players.get(targetId);
        votesText.push(`- ${wolfName}: 🔪 【选择袭击 ${target ? getPName(target) : "未知"}】`);
      }
    });

    const allWolvesVoted = wolves.every(w => game.wwVotes.has(w.id));
    const isWolvesUnified = wolves.length <= 1
      || wolves.every(w => game.wwVotes.get(w.id) === game.wwVotes.get(wolves[0].id));

    const hint = game.wolvesLockedThisNight
      ? "🧷 本夜狼队已锁票，等待后续流程。"
      : (allWolvesVoted && !isWolvesUnified)
        ? "⚠️ 尚未统一目标，请继续改票；统一后将自动锁票。"
        : "请与队友配合，共同选择袭击目标：";
    return `🌙 <b>狼人行动 (第 ${game.dayCount} 夜)</b>\n\n${votesText.join("\n")}\n\n${hint}`;
  }

  async function updateWolfMessages(game: WWGame) {
    if (game.wolfMessageIds.size === 0) return;
    const wwText = getWWKillStatusText(game);
    for (const [wId, msgId] of game.wolfMessageIds.entries()) {
      try {
        const wwKeyboard = getWWKillKeyboard(game, wId);
        await bot.api.editMessageText(wId, msgId, wwText, { parse_mode: "HTML", reply_markup: wwKeyboard });
      } catch (e: any) {
        if (isIgnorableEditError(e)) continue;
      }
    }
  }

  function getLatestGroupMessageId(game: WWGame): number | undefined {
    if (game.groupMessageIds.length === 0) return undefined;
    return game.groupMessageIds[game.groupMessageIds.length - 1];
  }

  function getGroupReturnLink(game: WWGame): string {
    if (game.chatId.toString().startsWith("-100")) {
      const groupMsgId = getLatestGroupMessageId(game) || game.lobbyMessageId || 1;
      return `https://t.me/c/${game.chatId.toString().slice(4)}/${groupMsgId}`;
    }
    return `tg://resolve?id=${Math.abs(game.chatId)}`;
  }

  function getReturnKeyboard(game: WWGame): InlineKeyboard {
    return new InlineKeyboard().url("🔙 返回群组", getGroupReturnLink(game));
  }

  async function upsertPrivateActionMessage(
    userId: number,
    messageIds: Map<number, number>,
    text: string,
    keyboard: InlineKeyboard
  ) {
    const msgId = messageIds.get(userId);
    if (msgId) {
      try {
        await bot.api.editMessageText(userId, msgId, text, { parse_mode: "HTML", reply_markup: keyboard });
        return;
      } catch (e: any) {
        if (isIgnorableEditError(e)) return;
      }
    }

    const sent = await bot.api.sendMessage(userId, text, { parse_mode: "HTML", reply_markup: keyboard });
    messageIds.set(userId, sent.message_id);
  }

  async function closePrivateActionMessage(
    game: WWGame,
    userId: number,
    messageIds: Map<number, number>,
    text: string
  ) {
    const msgId = messageIds.get(userId);
    if (!msgId) return;
    try {
      await bot.api.editMessageText(userId, msgId, text, { parse_mode: "HTML", reply_markup: getReturnKeyboard(game) });
    } catch { }
  }

  async function retractPrivateActionButtons(game: WWGame, messageIds: Map<number, number>) {
    for (const [userId, msgId] of messageIds.entries()) {
      try {
        await bot.api.editMessageReplyMarkup(userId, msgId, { reply_markup: getReturnKeyboard(game) });
      } catch { }
    }
  }

  async function retractAllNightActionButtons(game: WWGame) {
    await retractPrivateActionButtons(game, game.wolfMessageIds);
    await retractPrivateActionButtons(game, game.seerMessageIds);
    await retractPrivateActionButtons(game, game.guardMessageIds);
    await retractPrivateActionButtons(game, game.cupidMessageIds);
    await retractPrivateActionButtons(game, game.witchMessageIds);
  }

  async function retractCurrentCallbackButtons(ctx: Context, game?: WWGame) {
    const fromId = ctx.from?.id;
    const msgId = ctx.callbackQuery?.message?.message_id;
    if (!msgId || !fromId) return;
    try {
      if (game) {
        await ctx.api.editMessageReplyMarkup(fromId, msgId, { reply_markup: getReturnKeyboard(game) });
      } else {
        await ctx.api.editMessageReplyMarkup(fromId, msgId, { reply_markup: undefined });
      }
    } catch { }
  }

  function scheduleNightTimeout(game: WWGame) {
    game.nightTimeoutToken += 1;
    const token = game.nightTimeoutToken;
    if (game.timeout) clearTimeout(game.timeout);
    game.timeout = setTimeout(() => handleNightTimeout(game, token), TIMEOUTS.NIGHT * 1000);
  }

  function clearDayWWKState(game: WWGame) {
    if (game.dayWWKTimeout) {
      clearTimeout(game.dayWWKTimeout);
      game.dayWWKTimeout = undefined;
    }
    game.dayWWKPendingId = undefined;
    game.dayWWKChoosingTarget = false;
  }

  function getWWKillKeyboard(game: WWGame, viewerId?: number) {

    const keyboard = new InlineKeyboard();

    // 锁票后不再展示可点选的玩家名单，避免误导“仍可改票”。
    if (!game.wolvesLockedThisNight) {
      const alive = getAlivePlayers(game);

      // 统计票数
      const counts = new Map<number, number>();
      game.wwVotes.forEach(targetId => {
        counts.set(targetId, (counts.get(targetId) || 0) + 1);
      });

      const targets = alive;
      targets.forEach((p, index) => {
        const count = counts.get(p.id) || 0;
        const label = count > 0 ? `${getPName(p)} (${count})` : getPName(p);
        keyboard.text(label, `ww_kill_${game.chatId}_${p.id}`);
        if ((index + 1) % 2 === 0) keyboard.row();
      });

      if (targets.length % 2 !== 0) keyboard.row();
      const skipCount = counts.get(NONE_ID) || 0;
      keyboard.text(skipCount > 0 ? `⏭️ 空刀 (${skipCount})` : "⏭️ 空刀", `ww_kill_${game.chatId}_${NONE_ID}`);
    }

    // 返回群组按钮
    keyboard.row().url("🔙 返回群组", getGroupReturnLink(game));

    return keyboard;
  }


  async function cleanupGameMessages(game: WWGame) {
    for (const msgId of game.groupMessageIds) {
      try {
        await bot.api.deleteMessage(game.chatId, msgId);
      } catch (e) {
        // Ignore deletion errors (e.g. message too old or already deleted)
      }
    }
    game.groupMessageIds = [];
  }

  async function muteGamePlayers(game: WWGame) {
    for (const p of game.players.values()) {
      if (p.id < 0) continue; // 跳过 AI 玩家
      try {
        const chatMember = await bot.api.getChatMember(game.chatId, p.id);
        const isAdmin = ["administrator", "creator"].includes(chatMember.status);
        if (!isAdmin) {
          await bot.api.restrictChatMember(game.chatId, p.id, {
            can_send_messages: false
          });
        }
      } catch (e) { }
    }
  }

  async function unmuteGamePlayers(game: WWGame, forceAll = false) {
    for (const p of game.players.values()) {
      if (p.id < 0) continue; // 跳过 AI 玩家

      // 如果不是强制解禁全员，则检查是否可以说话（存活或有遗言）
      if (!forceAll) {
        const canSpeak = p.isAlive || game.graceMessageRemainingIds.has(p.id);
        if (!canSpeak) continue;
      }

      try {
        await bot.api.restrictChatMember(game.chatId, p.id, {
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
      } catch (e) { }
    }
  }

  function checkWinCondition(game: WWGame): "werewolves" | "villagers" | "lovers" | null {
    const alive = getAlivePlayers(game);

    // 情侣独赢：仅当情侣双方都存活，且场上只剩他们两人，且为跨阵营情侣。
    if (game.lovers?.length === 2) {
      const [loverAId, loverBId] = game.lovers;
      const loverA = game.players.get(loverAId);
      const loverB = game.players.get(loverBId);
      if (loverA?.isAlive && loverB?.isAlive && alive.length === 2) {
        const crossCampLovers = isWolfRole(loverA.role) !== isWolfRole(loverB.role);
        if (crossCampLovers) return "lovers";
      }
    }

    const wolves = alive.filter(p => isWolfRole(p.role)).length;
    const goods = alive.length - wolves;

    if (wolves === 0) return "villagers";
    // 狼人数量大于等于好人数量，且没有丘比特局（或者丘比特局且狼人优势很大）
    // 为了简单，遵循基础规则：狼人 >= 好人 则狼胜
    if (wolves >= goods) return "werewolves";
    return null;
  }

  async function announceWin(game: WWGame, winner: "werewolves" | "villagers" | "lovers") {
    let text = winner === "werewolves"
      ? "🐺 <b>狼人阵营胜利！</b>\n天黑请闭眼，狼人们统治了村庄。"
      : winner === "villagers"
        ? "🌻 <b>好人阵营胜利！</b>\n所有的狼人都被消灭了，村庄恢复了宁静。"
        : "💘 <b>情侣独赢！</b>\n乱世中，爱情笑到了最后。";

    // 公布身份
    text += "\n\n<b>🎪 玩家身份：</b>\n";
    game.players.forEach(p => {
      const roleStr = p.role === "werewolf" ? "🐺 狼人" :
        p.role === "white_wolf_king" ? "👹 白狼王" :
          p.role === "seer" ? "👁️ 预言家" :
            p.role === "hunter" ? "🔫 猎人" :
              p.role === "witch" ? "🧪 女巫" :
                p.role === "guard" ? "🛡️ 守卫" :
                  p.role === "cupid" ? "💘 丘比特" : "🧑‍🌾 平民";
      const statusStr = p.isAlive ? "✅存活" : "❌阵亡";
      const loverStr = game.lovers?.includes(p.id) ? " (💘 情侣)" : "";
      text += `- ${getPName(p)}: ${roleStr}${loverStr} (${statusStr})\n`;
    });

    const pointsSettlementText = settleWerewolfWinPoints(game, winner);
    if (pointsSettlementText) {
      text += `\n${pointsSettlementText}`;
    }

    try {
      await bot.api.sendMessage(game.chatId, text, { parse_mode: "HTML" });
    } catch { }

    // 对所有参与过游戏的玩家解除禁言
    await unmuteGamePlayers(game, true);

    // 清理所有中间过程消息
    await cleanupGameMessages(game);

    clearDayWWKState(game);
    if (game.timeout) clearTimeout(game.timeout);
    if (game.lobbyRefreshTimeout) clearTimeout(game.lobbyRefreshTimeout);

    // 记录人类玩家历史
    const humans = Array.from(game.players.values())
      .filter(p => p.id > 0)
      .map(p => ({ id: p.id, name: p.name }));
    if (humans.length > 0) {
      recordWerewolfPlayers(game.chatId, humans);
    }

    activeGames.delete(game.chatId);
    scheduleAiRestoreAfterGame(game.chatId);
  }

  /**
   * 使用“本地剧本”生成剧情化的游戏播报（移除 AI 以保证绝对速度）
   */
  async function generateWerewolfNarrative(game: WWGame, event: "night_death" | "day_execution", deadPlayer?: Player): Promise<string> {
    const eventDesc = event === "night_death"
      ? (deadPlayer ? `昨晚，【<b>${getPName(deadPlayer)}</b>】死了。` : "昨晚是平安夜，没有人死亡。")
      : (deadPlayer ? `今天，大家投票处决了 【<b>${getPName(deadPlayer)}</b>】。` : "今天没有人被处决。");

    // 本地剧本库
    const templates = event === "night_death"
      ? (deadPlayer ? [
        `黑夜降临，血月当空。【<b>${getPName(deadPlayer)}</b>】倒在了血泊之中，再也没有睁开眼。`,
        `凄风苦雨中，狼啸震天。众人在惊恐中发现【<b>${getPName(deadPlayer)}</b>】已经化作了冰冷的尸体。`,
        `黎明的第一缕光照在了【<b>${getPName(deadPlayer)}</b>】门前，门锁被利爪撕裂，屋内只剩下破碎的噩梦。`,
        `死神在黑暗中徘徊，【<b>${getPName(deadPlayer)}</b>】没能见到今天的太阳。`,
        `村庄的宁静被惨叫打破，【<b>${getPName(deadPlayer)}</b>】成为了昨夜的祭品。`
      ] : [
        `昨晚是平静的一夜，似乎死神也暂时停下了脚步。平安夜。`,
        `晨雾弥漫，昨晚无人在这片森林中迷离，黎明静悄悄地到来了。`,
        `月光温柔，昨夜无事发生，希望这不是暴风雨前的宁静。`
      ])
      : (deadPlayer ? [
        `审判的时刻已到，众人的指责最终汇聚成了绞索。【<b>${getPName(deadPlayer)}</b>】被放逐，正义抑或罪恶，都将随他而去。`,
        `村庄的愤怒在沸腾，矛头直指【<b>${getPName(deadPlayer)}</b>】。他倒在了审判台上，真相却依然在迷雾中。`,
        `法律的严惩就在眼前，【<b>${getPName(deadPlayer)}</b>】被拖向了绝路。`,
        `众目睽睽之下，【<b>${getPName(deadPlayer)}</b>】结束了他的旅程。`
      ] : [
        `今天大家似乎陷入了犹豫，没有人被送上审判台。僵局依旧。`,
        `由于无法达成共识，审判以流票告终。恐惧依然笼罩着这个小镇。`,
        `大家选择了沉默，没有人被处决。但这会让接下来的黑夜更加恐怖吗？`
      ]);

    return templates[Math.floor(Math.random() * templates.length)];
  }

  /**
   * 纯本地决策逻辑 - 代替 AI 以保证速度与稳定
   */
  async function makeAIDecision(
    game: WWGame,
    player: Player,
    actionType: "vote" | "kill" | "check" | "protect" | "witch_heal" | "witch_poison" | "cupid" | "hunter_shoot",
    options?: { killedPlayer?: Player; }
  ): Promise<any> {
    const alivePlayers = getAlivePlayers(game);

    if (actionType === "vote" || actionType === "kill" || actionType === "check" || actionType === "protect") {
      const targets = actionType === "kill"
        ? alivePlayers.filter(p => p.role !== "werewolf" && p.role !== "white_wolf_king")
        : (actionType === "check" ? alivePlayers.filter(p => p.id !== player.id) : alivePlayers);

      const target = targets[Math.floor(Math.random() * targets.length)];
      return target ? target.id : "skip";
    }

    if (actionType === "witch_heal") {
      return Math.random() < 0.3 ? options?.killedPlayer?.id : "skip";
    }

    if (actionType === "witch_poison") {
      if (Math.random() < 0.1) {
        const potential = alivePlayers.filter(p => p.id !== player.id);
        return potential[Math.floor(Math.random() * potential.length)]?.id || "skip";
      }
      return "skip";
    }

    if (actionType === "cupid") {
      const allPlayers = Array.from(game.players.values());
      const p1Idx = Math.floor(Math.random() * allPlayers.length);
      let p2Idx = Math.floor(Math.random() * allPlayers.length);
      while (p2Idx === p1Idx && allPlayers.length > 1) {
        p2Idx = Math.floor(Math.random() * allPlayers.length);
      }
      return [allPlayers[p1Idx].id, allPlayers[p2Idx].id];
    }

    if (actionType === "hunter_shoot") {
      if (Math.random() < 0.8) {
        const targets = alivePlayers.filter(p => p.id !== player.id);
        return targets[Math.floor(Math.random() * targets.length)]?.id || "skip";
      }
      return "skip";
    }

    return "skip";
  }

  /**
   * 立即触发 AI 玩家的操作，避免一直等待超时
   */
  async function triggerAIAction(game: WWGame, player: Player, phaseWhenTriggered: GamePhase, dayCountWhenTriggered: number) {
    if (player.id >= 0) return;

    // 正常决策需要玩家存活；但猎人开枪阶段，玩家其实已经死了 (isAlive=false)
    if (!player.isAlive && !(game.phase === "hunter_shot" && game.pendingHunterShotId === player.id)) {
      return;
    }

    // 随机延迟，猎人开枪阶段可以快一些 (1-3s)，其他阶段保持 (3-10s) 拟人感
    const delay = (game.phase === "hunter_shot") ? (1000 + Math.random() * 2000) : (3000 + Math.random() * 7000);
    await sleep(delay);

    // 关键校验：如果在延迟期间游戏已经进入了下一阶段或下一天，则本异步操作已无效，必须退出！
    // 夜晚的并发子阶段 (night/guard/cupid) 视作同一夜，允许 AI 在子阶段切换后继续完成该夜动作。
    const sameNightFamily = isNightLikePhase(phaseWhenTriggered) && isNightLikePhase(game.phase);
    if (!sameNightFamily && game.phase !== phaseWhenTriggered) return;
    if (game.dayCount !== dayCountWhenTriggered) return;

    if (game.phase === "voting") {
      if (!game.dayVotes.has(player.id)) {
        const res = await makeAIDecision(game, player, "vote");
        game.dayVotes.set(player.id, typeof res === 'number' ? res : -1);

        const alive = getAlivePlayers(game);
        if (game.dayVotes.size === alive.length) {
          await endVotingPhase(game);
        } else if (game.voteMessageId) {
          try {
            await bot.api.editMessageText(game.chatId, game.voteMessageId, getVoteStatusText(game), {
              parse_mode: "HTML", reply_markup: getVoteKeyboard(game)
            });
          } catch (e: any) {
            if (isIgnorableEditError(e)) return;
          }
        }
      }
      return;
    }

    // 黑夜相关阶段 (night, cupid, guard, hunter_shot)
    if (player.role === "werewolf" || player.role === "white_wolf_king") {
      if (!game.wwVotes.has(player.id)) {
        const res = await makeAIDecision(game, player, "kill");
        game.wwVotes.set(player.id, typeof res === 'number' ? res : NONE_ID);
        await updateWolfMessages(game); // AI 操作也实时同步给真人队友
        await checkNightPhaseCompletion(game);
      }
    } else if (player.role === "seer") {

      if (!game.seerCheckedTargets.has(player.id)) {
        const res = await makeAIDecision(game, player, "check");
        game.seerCheckedTargets.set(player.id, typeof res === 'number' ? res : NONE_ID);
        await checkNightPhaseCompletion(game);
      }
    } else if (player.role === "guard") {
      if (game.nightProtectedId === undefined) {
        const res = await makeAIDecision(game, player, "protect");
        game.nightProtectedId = typeof res === 'number' ? res : NONE_ID;
        await checkNightPhaseCompletion(game);
      }
    } else if (player.role === "witch") {
      if (!game.witchesActedThisNight.includes(player.id)) {
        // 女巫必须等狼人杀完人才能行动
        if (game.wolfKillId === undefined) return;

        // AI 女巫尝试救人
        const killedPlayer = game.wolfKillId && game.wolfKillId !== NONE_ID ? game.players.get(game.wolfKillId) : null;
        const firstNightSelfHealBlocked = game.dayCount === 1 && killedPlayer?.id === player.id;

        // AI 女巫尝试救人
        if (
          killedPlayer &&
          !firstNightSelfHealBlocked &&
          !game.usedHealWitchIds.includes(player.id) &&
          !game.nightHealIds.includes(killedPlayer.id)
        ) {
          const res = await makeAIDecision(game, player, "witch_heal", { killedPlayer });
          if (typeof res === 'number') {
            game.nightHealIds.push(res);
            game.usedHealWitchIds.push(player.id);
            game.witchesActedThisNight.push(player.id);
            await checkNightPhaseCompletion(game);
            return;
          }
        }
        // AI 女巫从不救人或救不了时，尝试毒人
        if (!game.usedPoisonWitchIds.includes(player.id)) {
          const res = await makeAIDecision(game, player, "witch_poison");
          if (typeof res === 'number') {
            game.nightPoisonIds.push(res);
            game.usedPoisonWitchIds.push(player.id);
            game.witchesActedThisNight.push(player.id);
            await checkNightPhaseCompletion(game);
            return;
          }
        }

        game.witchesActedThisNight.push(player.id);
        await checkNightPhaseCompletion(game);
      }
    } else if (player.role === "cupid") {
      // 丘比特在 checkNightPhaseCompletion 中会被 startCupidPhase 激活，这里不需要额外触发逻辑
      // 但如果是超时兜底，makeAIDecision 会处理。主动触发时我们通过 checkNightPhaseCompletion -> triggerAIAction 进来。
      if (game.phase === "cupid" && !game.lovers) {
        const res = await makeAIDecision(game, player, "cupid");
        if (Array.isArray(res) && res.length >= 2) {
          game.lovers = res;
          const l1 = game.players.get(res[0]);
          const l2 = game.players.get(res[1]);
          if (l1 && l1.id > 0) try { await bot.api.sendMessage(l1.id, `💘 <b>你坠入爱河了！</b>\n你的爱人是：<b>${l2 ? getPName(l2) : "未知"}</b>。`, { parse_mode: "HTML" }); } catch { }
          if (l2 && l2.id > 0) try { await bot.api.sendMessage(l2.id, `💘 <b>你坠入爱河了！</b>\n你的爱人是：<b>${l1 ? getPName(l1) : "未知"}</b>。`, { parse_mode: "HTML" }); } catch { }
          await checkNightPhaseCompletion(game);
        }
      }
    } else if (game.phase === "hunter_shot" && game.pendingHunterShotId === player.id) {
      const res = await makeAIDecision(game, player, "hunter_shoot");
      await endHunterShotPhase(game, res === "skip" ? "skip" : res);
    }
  }

  async function handleDeath(game: WWGame, player: Player, source: "night" | "day") {
    player.isAlive = false;

    // 发送死亡私聊通知
    if (player.id > 0) {
      try {
        await bot.api.sendMessage(player.id, `💀 很遗憾，<b>${getPName(player)}</b> 你在这场狼人杀中死亡了！`, { parse_mode: "HTML" });
      } catch (e) {
        // 忽略发送失败
      }
    }

    // 如果是夜晚被杀，允许白天发一句言
    if (source === "night") {
      game.graceMessageRemainingIds.add(player.id);
    } else {
      // 白天处决或自爆，直接禁言
      if (player.id > 0) {
        try {
          const chatMember = await bot.api.getChatMember(game.chatId, player.id);
          const isActuallyAdmin = ["administrator", "creator"].includes(chatMember.status);

          if (!isActuallyAdmin) {
            await bot.api.restrictChatMember(game.chatId, player.id, {
              can_send_messages: false
            });
          }
        } catch (e) { }
      }
    }

    // 记录本次死亡是否触发了猎人待开枪
    let hunterTriggered = false;
    if (player.role === "hunter" && !game.firedHunterIds.includes(player.id)) {
      if (!game.hunterShotQueue.includes(player.id)) {
        game.hunterShotQueue.push(player.id);
      }
      hunterTriggered = true;
    }

    // 处理连情逻辑
    if (game.lovers?.includes(player.id)) {
      const otherId = game.lovers.find(id => id !== player.id);
      const other = otherId ? game.players.get(otherId) : null;
      if (other && other.isAlive) {
        await bot.api.sendMessage(game.chatId, `💘 <b>情比金坚！</b>\n玩家 <b>${getPName(player)}</b> 离去，其爱人 <b>${getPName(other)}</b> 也随之殉情。`, { parse_mode: "HTML" });
        if (await handleDeath(game, other, source)) {
          hunterTriggered = true;
        }
      }
    }

    return hunterTriggered;
  }

  async function processHunterQueue(game: WWGame, nextPhase: "night" | "day") {
    if (game.hunterShotQueue.length > 0) {
      game.hunterShotNextPhase = nextPhase;
      const nextHunterId = game.hunterShotQueue.shift()!;
      const hunter = game.players.get(nextHunterId);
      if (hunter) {
        await startHunterShotPhase(game, hunter);
        return true;
      }
    }
    return false;
  }

  async function startHunterShotPhase(game: WWGame, hunter: Player) {
    game.phase = "hunter_shot";
    game.pendingHunterShotId = hunter.id;

    if (game.timeout) clearTimeout(game.timeout);

    const alive = getAlivePlayers(game);
    const shotKeyboard = new InlineKeyboard();
    alive.forEach(p => {
      shotKeyboard.text(getPLabel(p), `ww_hunter_shoot_${game.chatId}_${p.id}`).row();
    });

    const msg = await bot.api.sendMessage(game.chatId, `🔫 <b>猎人【<b>${getPName(hunter)}</b>】在临死前扣动了扳机！</b>\n\n请 【<b>${getPName(hunter)}</b>】 在 ${TIMEOUTS.HUNTER} 秒内选择一个目标带走：`, { parse_mode: "HTML", reply_markup: shotKeyboard });
    game.groupMessageIds.push(msg.message_id);
    game.hunterShotMessageId = msg.message_id;

    game.timeout = setTimeout(() => endHunterShotPhase(game), TIMEOUTS.HUNTER * 1000);

    // AI 猎人立即触发
    if (hunter.id < 0) triggerAIAction(game, hunter, game.phase, game.dayCount);
  }

  async function endHunterShotPhase(game: WWGame, targetId?: number | "skip") {
    if (game.phase !== "hunter_shot") return;
    if (game.timeout) clearTimeout(game.timeout);

    // 收起过期的开枪键盘（超时或已处理后都不应保留名单按钮）
    if (game.hunterShotMessageId) {
      try {
        await bot.api.editMessageReplyMarkup(game.chatId, game.hunterShotMessageId, { reply_markup: undefined });
      } catch { }
      game.hunterShotMessageId = undefined;
    }

    if (targetId === undefined && game.pendingHunterShotId) {
      const hunter = game.players.get(game.pendingHunterShotId);
      if (hunter) {
        targetId = "skip";
      }
    }

    if (targetId && targetId !== "skip") {
      const target = game.players.get(targetId as number);
      if (target && target.isAlive) {
        if (game.pendingHunterShotId) game.firedHunterIds.push(game.pendingHunterShotId);
        const msg = await bot.api.sendMessage(game.chatId, `💥 <b>砰！</b>\n猎人临死前的一枪精准命中了 【<b>${getPName(target)}</b>】！\n【<b>${getPName(target)}</b>】 倒在了血泊中。`, { parse_mode: "HTML" });
        game.groupMessageIds.push(msg.message_id);

        // 调用 handleDeath 处理死亡逻辑 (通知、禁言、连带死亡等)
        // 猎人若因白天死亡触发开枪，则其带走目标也应按白天死亡处理（不应获得夜死遗言权）。
        const shotSource: "night" | "day" = game.hunterShotNextPhase === "night" ? "day" : "night";
        await handleDeath(game, target, shotSource);
      }
    } else {
      if (game.pendingHunterShotId) game.firedHunterIds.push(game.pendingHunterShotId);
      const msg = await bot.api.sendMessage(game.chatId, "🥀 猎人最终没有扣动扳机，或者子弹卡壳了...", { parse_mode: "HTML" });
      game.groupMessageIds.push(msg.message_id);
    }

    game.pendingHunterShotId = undefined;

    // 检查胜负
    const win = checkWinCondition(game);
    if (win) {
      await announceWin(game, win);
      return;
    }

    // 检查是否有下一个猎人
    const moreHunters = await processHunterQueue(game, game.hunterShotNextPhase || "night");
    if (moreHunters) return;

    // 队列清空，进入下一阶段
    const nextPhase = game.hunterShotNextPhase;
    game.hunterShotNextPhase = undefined;

    await sleep(2000);
    if (nextPhase === "day") {
      await startDiscussionPhase(game);
    } else {
      startNightPhase(game);
    }
  }

  // ================= 核心流程 =================

  async function startNightPhase(game: WWGame) {
    // 新夜开始前，再次收回上一阶段遗留的技能按钮（保留文字记录）
    await retractAllNightActionButtons(game);
    await retractPrivateActionButtons(game, game.dayWWKMessageIds);

    // 新夜开始即关闭上一白天的遗言窗口，避免夜里继续发言。
    game.graceMessageRemainingIds.clear();

    game.phase = "night";
    game.dayCount++;
    game.wwVotes.clear();
    game.wolvesLockedThisNight = false;
    game.seerCheckedTargets.clear();
    game.wolfKillId = undefined;
    game.nightHealIds = [];
    game.nightPoisonIds = [];
    game.witchesActedThisNight = [];
    game.witchesMessageSentThisNight = [];
    game.hunterShotMessageId = undefined;
    clearDayWWKState(game);

    const botInfo = await bot.api.getMe();
    const groupKeyboard = new InlineKeyboard()
      .url("💬 私聊操作", `https://t.me/${botInfo.username}`);

    const msg = await bot.api.sendMessage(game.chatId, `🌙 <b>第 ${game.dayCount} 天夜里...</b>\n\n天黑请闭眼。【狼人】与【神职】玩家请在与我的私聊中进行操作。`, {
      parse_mode: "HTML",
      reply_markup: groupKeyboard,
      link_preview_options: { is_disabled: true }
    });
    game.groupMessageIds.push(msg.message_id);

    // 夜间全员禁言
    await muteGamePlayers(game);

    const alive = getAlivePlayers(game);
    const wolves = getPlayersByRole(game, "werewolf").concat(getPlayersByRole(game, "white_wolf_king"));
    const seers = getPlayersByRole(game, "seer");

    // 新夜晚一律下发新消息，保留上一夜私聊记录
    game.wolfMessageIds.clear();
    game.seerMessageIds.clear();
    game.witchMessageIds.clear();
    game.guardMessageIds.clear();
    game.cupidMessageIds.clear();
    game.dayWWKMessageIds.clear();

    // 发送狼人私聊键盘
    const wwText = getWWKillStatusText(game);

    for (const w of wolves) {
      if (w.id < 0) continue; // 跳过 AI 玩家
      try {
        const wwKeyboard = getWWKillKeyboard(game, w.id);
        const msg = await bot.api.sendMessage(w.id, wwText, { parse_mode: "HTML", reply_markup: wwKeyboard });
        game.wolfMessageIds.set(w.id, msg.message_id);
      } catch {
        const errMsg = await bot.api.sendMessage(game.chatId, `⚠️ 狼人 ${getPLabel(w)} 无法接收私聊，他可能没有启动 Bot。夜晚流程可能会卡住！`);
        game.groupMessageIds.push(errMsg.message_id);
      }
    }


    // 发送预言家私聊键盘
    if (seers.length > 0) {
      for (const s of seers) {
        if (s.id < 0) continue; // 跳过 AI 玩家
        const seerKeyboard = new InlineKeyboard();
        alive.filter(p => p.id !== s.id).forEach(p => {
          seerKeyboard.text(getPLabel(p), `ww_seer_${game.chatId}_${p.id}`).row();
        });

        try {
          seerKeyboard.row().url("🔙 返回群组", getGroupReturnLink(game));
          await upsertPrivateActionMessage(
            s.id,
            game.seerMessageIds,
            `👁️ <b>预言家行动 (第 ${game.dayCount} 夜)</b>\n请选择你要查验的目标：`,
            seerKeyboard
          );
        } catch {
          const errMsg = await bot.api.sendMessage(game.chatId, `⚠️ 预言家 ${getPLabel(s)} 无法接收私聊。夜晚流程可能会卡住！`);
          game.groupMessageIds.push(errMsg.message_id);
        }
      }
    }

    // 立即触发 AI 狼人和预言家的操作
    const concurrentRoles = ["werewolf", "white_wolf_king", "seer"];
    getAlivePlayers(game).filter(p => p.id < 0 && concurrentRoles.includes(p.role)).forEach(p => triggerAIAction(game, p, game.phase, game.dayCount));

    // 设置超时保护，防止玩家掉线卡住流程
    scheduleNightTimeout(game);

    // 首先进入守卫环节 (如果有)
    await checkNightPhaseCompletion(game);
  }

  async function handleNightTimeout(game: WWGame, token?: number) {
    if (game.phase !== "night" && game.phase !== "cupid" && game.phase !== "guard") return;
    if (token !== undefined && token !== game.nightTimeoutToken) return;

    // 丘比特和守卫并发阶段超时：同时填充两者的默认值
    if (game.phase === "cupid" || game.phase === "guard") {
      const cupids = getPlayersByRole(game, "cupid");
      const guards = getPlayersByRole(game, "guard");

      if (!game.lovers && cupids.length > 0 && game.dayCount === 1) {
        game.lovers = [];
        for (const c of cupids) {
          if (c.id > 0) {
            await closePrivateActionMessage(
              game,
              c.id,
              game.cupidMessageIds,
              `💘 <b>丘比特行动 (第 ${game.dayCount} 夜)</b>\n\n⏱️ 你超时未完成连线，本夜未连接情侣。`
            );
          }
        }
      }

      if (game.nightProtectedId === undefined && guards.length > 0) {
        game.nightProtectedId = NONE_ID;
        for (const g of guards) {
          if (g.id > 0) {
            await closePrivateActionMessage(
              game,
              g.id,
              game.guardMessageIds,
              `🛡️ <b>守卫行动 (第 ${game.dayCount} 夜)</b>\n\n⏱️ 你超时未守护，系统已按【空守】处理。`
            );
          }
        }
      }
    } else if (game.phase === "night") {
      // 狼人
      const aliveWolves = getActiveWolvesForVoting(game);
      for (const w of aliveWolves) {
        if (!game.wwVotes.has(w.id)) game.wwVotes.set(w.id, NONE_ID);
      }
      // 超时后强制锁票，避免因分票长期停留在狼人阶段
      if (!game.wolvesLockedThisNight) {
        game.wolvesLockedThisNight = true;
        await updateWolfMessages(game);
      }
      // 预言家
      const seers = getPlayersByRole(game, "seer");
      for (const s of seers) {
        if (!game.seerCheckedTargets.has(s.id)) {
          game.seerCheckedTargets.set(s.id, NONE_ID);
          if (s.id > 0) {
            await closePrivateActionMessage(
              game,
              s.id,
              game.seerMessageIds,
              `👁️ <b>预言家行动 (第 ${game.dayCount} 夜)</b>\n\n⏱️ 你超时未查验，本夜已自动结束行动。`
            );
          }
        }
      }
      // 女巫只有在本夜面板已经发出后，才允许按超时跳过。
      // 否则应先补发女巫面板，而不是直接吞掉本夜行动。
      const witches = getPlayersByRole(game, "witch");
      const currentWitch = witches.find(w => !game.witchesActedThisNight.includes(w.id));
      if (currentWitch && game.witchesMessageSentThisNight.includes(currentWitch.id)) {
        game.witchesActedThisNight.push(currentWitch.id);
        if (currentWitch.id > 0) {
          await closePrivateActionMessage(
            game,
            currentWitch.id,
            game.witchMessageIds,
            `🧪 <b>女巫行动 (第 ${game.dayCount} 夜)</b>\n\n⏱️ 你超时未操作，本夜已自动结束行动。`
          );
        }
      }
    }
    await checkNightPhaseCompletion(game);
  }

  async function startGuardPhase(game: WWGame, guard: Player) {
    const alive = getAlivePlayers(game);
    const keyboard = new InlineKeyboard();
    alive.forEach(p => {
      // 不能连守
      if (p.id !== game.lastProtectedId) {
        keyboard.text(getPLabel(p), `ww_guard_${game.chatId}_${game.dayCount}_${p.id}`).row();
      }
    });

    try {
      scheduleNightTimeout(game);

      keyboard.row().url("🔙 返回群组", getGroupReturnLink(game));
      await upsertPrivateActionMessage(
        guard.id,
        game.guardMessageIds,
        `🛡️ <b>守卫行动 (第 ${game.dayCount} 夜)</b>\n请选择你要守护的目标（不可连续两晚守护同一人）：`,
        keyboard
      );
    } catch {
      await bot.api.sendMessage(game.chatId, `⚠️ 守卫 ${getPLabel(guard)} 无法接收私聊。`);
      game.nightProtectedId = NONE_ID; // 视为没守
      await checkNightPhaseCompletion(game);
    }
  }

  async function startCupidPhase(game: WWGame, cupid: Player) {
    game.cupidTargetIds = [];
    const alive = Array.from(game.players.values()); // 可以选任何人，包含自己
    const keyboard = new InlineKeyboard();
    alive.forEach(p => {
      keyboard.text(getPLabel(p), `ww_cupid_${game.chatId}_${game.dayCount}_${p.id}`).row();
    });

    try {
      scheduleNightTimeout(game);

      keyboard.row().url("🔙 返回群组", getGroupReturnLink(game));
      await upsertPrivateActionMessage(
        cupid.id,
        game.cupidMessageIds,
        `💘 <b>丘比特行动 (第 ${game.dayCount} 夜)</b>\n请依次选择两名玩家作为【情侣】：`,
        keyboard
      );
    } catch {
      await bot.api.sendMessage(game.chatId, `⚠️ 丘比特 ${getPLabel(cupid)} 无法接收私聊。`);
      game.lovers = []; // 没连成功
      await checkNightPhaseCompletion(game);
    }

    // AI 丘比特立即触发
    if (cupid.id < 0) triggerAIAction(game, cupid, game.phase, game.dayCount);
  }

  async function endNightPhase(game: WWGame) {
    if (game.phase !== "night") return;
    if (game.timeout) clearTimeout(game.timeout);

    game.lastNightKilledIds = [];

    game.phase = "day"; // 标记为白天，防止重复触发
    if (game.timeout) clearTimeout(game.timeout);
    await retractAllNightActionButtons(game);

    // 如果狼人还没杀人（比如超时极端情况），按空刀处理
    if (game.wolfKillId === undefined) {
      const deathCounts = new Map<number, number>();
      game.wwVotes.forEach(targetId => {
        deathCounts.set(targetId, (deathCounts.get(targetId) || 0) + 1);
      });

      let maxVotes = 0;
      let deadId: number | undefined;
      deathCounts.forEach((count, targetId) => {
        if (count > maxVotes) {
          maxVotes = count;
          deadId = targetId;
        } else if (count === maxVotes) {
          if (Math.random() > 0.5) deadId = targetId;
        }
      });

      if (!deadId) deadId = NONE_ID;
      game.wolfKillId = deadId;
    }

    // 计算最终死亡名单
    let deadPlayers: Player[] = [];

    // 1. 狼人杀人
    let killId: number | undefined = game.wolfKillId === NONE_ID ? undefined : game.wolfKillId;

    // 守卫保护逻辑
    if (killId !== undefined && killId === game.nightProtectedId) {
      // 检查奶穿：如果女巫也救了，则死；否则救活
      if (game.nightHealIds.includes(killId)) {
        // 奶穿，此人必死
      } else {
        killId = undefined; // 被守卫救活
      }
    } else {
      // 没被守，检查女巫救人
      if (killId !== undefined && game.nightHealIds.includes(killId)) {
        killId = undefined; // 被女巫救活
      }
    }

    if (killId !== undefined) {
      const p = game.players.get(killId);
      if (p) deadPlayers.push(p);
    }

    for (const poisonId of game.nightPoisonIds) {
      const p = game.players.get(poisonId);
      if (p && !deadPlayers.includes(p)) deadPlayers.push(p);
    }

    // 记录昨晚死掉的人，用于稍后播报遗言
    game.lastNightKilledIds = deadPlayers.map(p => p.id);

    // 生成剧情
    let narrative = "";
    if (deadPlayers.length === 0) {
      narrative = await generateWerewolfNarrative(game, "night_death");
    } else {
      // 如果有多个人死，目前的 generateWerewolfNarrative 只支持一个，简单处理
      for (const p of deadPlayers) {
        narrative += await generateWerewolfNarrative(game, "night_death", p) + "\n";
      }
    }

    const msg = await bot.api.sendMessage(game.chatId, `☀️ <b>天亮了！</b>\n\n${narrative}`, { parse_mode: "HTML" });
    game.groupMessageIds.push(msg.message_id);

    // 4. 处理死亡 (带猎人技能)
    let hunterTriggered = false;
    for (const p of deadPlayers) {
      if (await handleDeath(game, p, "night")) {
        hunterTriggered = true;
      }
    }

    // 夜晚结算点：无论后续是否进入猎人开枪，都要先固化本夜守卫状态，
    // 否则在“夜晚死亡触发猎人”分支会提前 return，导致下一夜误判守卫已行动（掉夜）。
    game.lastProtectedId = game.nightProtectedId;
    game.nightProtectedId = undefined;

    if (hunterTriggered) {
      await processHunterQueue(game, "day");
      return;
    }

    const win = checkWinCondition(game);
    if (win) {
      await announceWin(game, win);
      return;
    }

    // 进入自由讨论阶段 (90秒)
    await startDiscussionPhase(game);
  }

  async function checkNightPhaseCompletion(game: WWGame) {
    if (game.phase !== "night" && game.phase !== "cupid" && game.phase !== "guard") return;

    const aliveWolves = getActiveWolvesForVoting(game);
    const seers = getPlayersByRole(game, "seer");
    const witches = getPlayersByRole(game, "witch");
    const guards = getPlayersByRole(game, "guard");
    const cupids = getPlayersByRole(game, "cupid");

    // 1. 丘比特 & 守卫（并发）
    const needCupid = game.dayCount === 1 && cupids.length > 0 && !game.lovers;
    const needGuard = guards.length > 0 && game.nightProtectedId === undefined;

    if (needCupid || needGuard) {
      // 首次进入：同时启动丘比特和守卫
      if (game.phase !== "cupid" && game.phase !== "guard") {
        game.phase = needCupid ? "cupid" : "guard"; // 用任一标记即可
        scheduleNightTimeout(game);

        if (needCupid) {
          for (const c of cupids) {
            if (c.id > 0) await startCupidPhase(game, c);
            else triggerAIAction(game, c, game.phase, game.dayCount);
          }
        }
        if (needGuard) {
          for (const g of guards) {
            if (g.id > 0) await startGuardPhase(game, g);
            else triggerAIAction(game, g, game.phase, game.dayCount);
          }
        }
      }
      return; // 等两者都完成
    }

    // 2. 狼人 & 预言家
    if (game.phase !== "night") {
      game.phase = "night";
      scheduleNightTimeout(game);
    }

    if (game.wwVotes.size < aliveWolves.length) return;
    const wolfVoteTargets = aliveWolves.map(w => game.wwVotes.get(w.id) ?? NONE_ID);
    const isWolvesUnified = wolfVoteTargets.length <= 1 || wolfVoteTargets.every(t => t === wolfVoteTargets[0]);
    if (!game.wolvesLockedThisNight) {
      if (!isWolvesUnified) return; // 未统一目标，继续等待狼人改票
      game.wolvesLockedThisNight = true; // 狼人统一目标后自动锁票
      await updateWolfMessages(game);
    }

    // 狼人投完票了，计算 wolfKillId
    if (game.wolfKillId === undefined) {
      const deathCounts = new Map<number, number>();
      game.wwVotes.forEach(targetId => {
        deathCounts.set(targetId, (deathCounts.get(targetId) || 0) + 1);
      });
      let maxVotes = 0;
      let deadId: number | undefined;
      deathCounts.forEach((count, targetId) => {
        if (count > maxVotes) {
          maxVotes = count;
          deadId = targetId;
        } else if (count === maxVotes) {
          if (Math.random() > 0.5) deadId = targetId;
        }
      });
      game.wolfKillId = deadId || NONE_ID;
    }

    if (seers.some(s => !game.seerCheckedTargets.has(s.id))) return;

    // 4. 女巫
    const nextWitch = witches.find(w => !game.witchesActedThisNight.includes(w.id));
    if (nextWitch) {
      if (nextWitch.id > 0) {
        // 真人女巫：无论是否已发过消息，都刷新一次女巫面板。
        // startWitchPhase 内部会优先 edit 原消息，避免刷屏；这样狼人改票后，
        // 女巫看到的“被刀目标/救人按钮”能实时同步。
        if (!game.witchesMessageSentThisNight.includes(nextWitch.id)) {
          game.witchesMessageSentThisNight.push(nextWitch.id);
        }
        await startWitchPhase(game, nextWitch);
      } else {
        // AI 女巫：直接触发 (AI 内部逻辑会检查是否已行动)
        triggerAIAction(game, nextWitch, game.phase, game.dayCount);
      }
      return;
    }

    // 所有人都行动完了
    await endNightPhase(game);
  }

  async function startWitchPhase(game: WWGame, witch: Player) {
    const killedPlayer = game.wolfKillId && game.wolfKillId !== NONE_ID ? game.players.get(game.wolfKillId) : null;
    let text = `🧪 <b>女巫行动 (第 ${game.dayCount} 夜)</b>\n\n`;

    if (killedPlayer) {
      text += `昨晚被狼人杀害的是：<b>${getPName(killedPlayer)}</b>\n`;
    } else {
      text += `昨晚是平安夜。\n`;
    }

    const keyboard = new InlineKeyboard();

    // 解药
    const canHeal = !game.usedHealWitchIds.includes(witch.id);
    const targetIsKill = killedPlayer && !game.nightHealIds.includes(killedPlayer.id);
    const firstNightSelfHealBlocked = game.dayCount === 1 && killedPlayer?.id === witch.id;
    if (firstNightSelfHealBlocked) {
      text += `⚠️ 首夜不可自救，但你仍可使用毒药。\n`;
    }
    if (canHeal && targetIsKill && killedPlayer && !firstNightSelfHealBlocked) {
      keyboard.text(`💊 救活 ${getPLabel(killedPlayer)}`, `ww_witch_heal_${game.chatId}_${killedPlayer.id}`).row();
    }

    // 毒药
    if (!game.usedPoisonWitchIds.includes(witch.id)) {
      keyboard.text("🧪 使用毒药...", `ww_witch_poison_menu_${game.chatId}`).row();
    }

    keyboard.text("⏭️ 结束行动", `ww_witch_skip_${game.chatId}`).row();

    keyboard.row().url("🔙 返回群组", getGroupReturnLink(game));

    try {
      // 女巫面板发出后，切换到这一轮独立的完整倒计时。
      scheduleNightTimeout(game);

      await upsertPrivateActionMessage(witch.id, game.witchMessageIds, text, keyboard);
    } catch {
      const errMsg = await bot.api.sendMessage(game.chatId, `⚠️ 女巫 ${getPLabel(witch)} 无法接收私聊。夜晚流程可能会卡住！`);
      game.groupMessageIds.push(errMsg.message_id);
      if (!game.witchesActedThisNight.includes(witch.id)) {
        game.witchesActedThisNight.push(witch.id);
      }
      await checkNightPhaseCompletion(game);
    }
  }

  async function startDiscussionPhase(game: WWGame) {
    game.phase = "discussion";

    // 天亮了，解除禁言 (包括拥有发言权的死者)
    await unmuteGamePlayers(game);

    const aliveNames = getAlivePlayers(game).map(p => `<b>${getPName(p)}</b>`).join(", ");
    const msg = await bot.api.sendMessage(game.chatId, `📢 <b>现在开始 ${TIMEOUTS.DISCUSSION} 秒的自由讨论时间！</b>\n请村民们踊跃交流，找出 [ ${aliveNames} ] 当中的狼人。`, { parse_mode: "HTML" });
    game.groupMessageIds.push(msg.message_id);

    if (game.timeout) clearTimeout(game.timeout);
    game.timeout = setTimeout(() => {
      if (game.phase === "discussion") startVotingPhase(game);
    }, TIMEOUTS.DISCUSSION * 1000);

    // 白狼王白天自爆窗口（60 秒，超时默认潜伏）
    await startDayWWKDecision(game);
  }

  async function resolveDayWWKBoom(game: WWGame, king: Player, target: Player) {
    clearDayWWKState(game);

    // 立即终止白天讨论，跳过投票，直接结算自爆死亡
    if (game.timeout) clearTimeout(game.timeout);
    game.phase = "day";

    const detonationMsg = await bot.api.sendMessage(
      game.chatId,
      `💥 <b>白狼王自爆！</b>\n玩家 <b>${getPName(king)}</b> 自爆并带走了 <b>${getPName(target)}</b>。\n<i>本轮跳过投票，直接进入黑夜。</i>`,
      { parse_mode: "HTML" }
    );
    game.groupMessageIds.push(detonationMsg.message_id);

    const deadSet = new Map<number, Player>();
    if (king.isAlive) deadSet.set(king.id, king);
    if (target.isAlive) deadSet.set(target.id, target);

    let hunterTriggered = false;
    for (const p of deadSet.values()) {
      if (await handleDeath(game, p, "day")) {
        hunterTriggered = true;
      }
    }

    if (hunterTriggered) {
      await processHunterQueue(game, "night");
      return;
    }

    const win = checkWinCondition(game);
    if (win) {
      await announceWin(game, win);
      return;
    }

    await sleep(2000);
    startNightPhase(game);
  }

  async function startDayWWKDecision(game: WWGame) {
    const whiteWolfKing = getPlayersByRole(game, "white_wolf_king").find(p => p.isAlive);
    if (!whiteWolfKing) {
      clearDayWWKState(game);
      return;
    }

    clearDayWWKState(game);
    game.dayWWKMessageIds.clear();
    game.dayWWKPendingId = whiteWolfKing.id;
    game.dayWWKChoosingTarget = false;

    // AI 白狼王：白天讨论开始后自动决策（可能自爆，也可能潜伏）
    if (whiteWolfKing.id < 0) {
      const aiDelay = 3000 + Math.floor(Math.random() * 4000);
      game.dayWWKTimeout = setTimeout(async () => {
        if (activeGames.get(game.chatId) !== game) return;
        if (game.phase !== "discussion") return;
        if (game.dayWWKPendingId !== whiteWolfKing.id) return;

        const aliveOthers = getAlivePlayers(game).filter(p => p.id !== whiteWolfKing.id);
        const shouldBoom = aliveOthers.length > 0 && Math.random() < 0.35;
        if (!shouldBoom) {
          clearDayWWKState(game); // 默认潜伏
          return;
        }

        const target = aliveOthers[Math.floor(Math.random() * aliveOthers.length)];
        await resolveDayWWKBoom(game, whiteWolfKing, target);
      }, aiDelay);
      return;
    }

    const keyboard = new InlineKeyboard()
      .text("💥 自爆", `ww_day_wwk_boom_${game.chatId}`)
      .text("🫥 潜伏", `ww_day_wwk_hide_${game.chatId}`).row()
      .url("🔙 返回群组", getGroupReturnLink(game));

    try {
      await upsertPrivateActionMessage(
        whiteWolfKing.id,
        game.dayWWKMessageIds,
        `👹 <b>白狼王抉择</b>\n\n当前进入白天讨论阶段，你有 <b>60 秒</b> 选择：\n- 💥 自爆并带走 1 名玩家（将直接跳过本轮投票）\n- 🫥 潜伏，正常进入投票`,
        keyboard
      );
    } catch {
      clearDayWWKState(game);
      return;
    }

    game.dayWWKTimeout = setTimeout(async () => {
      // 若局已结束或已做出决策，则无需处理
      if (activeGames.get(game.chatId) !== game) return;
      if (game.phase !== "discussion") return;
      if (game.dayWWKPendingId !== whiteWolfKing.id) return;

      clearDayWWKState(game);
      await closePrivateActionMessage(
        game,
        whiteWolfKing.id,
        game.dayWWKMessageIds,
        "👹 <b>白狼王抉择</b>\n\n⏱️ 你超时未选择，系统已按【潜伏】处理，本轮将正常进入投票。"
      );
    }, 60_000);
  }

  function getVoteStatusText(game: WWGame) {
    const alive = getAlivePlayers(game);
    const votesText: string[] = [];

    alive.forEach(voter => {
      const targetId = game.dayVotes.get(voter.id);
      const voterName = getPName(voter);
      if (targetId === undefined) {
        votesText.push(`- ${voterName}: ⏳ 正在考虑...`);
      } else if (targetId === NONE_ID) {
        votesText.push(`- ${voterName}: 🏳️ 【弃票】`);
      } else {
        const target = game.players.get(targetId);
        votesText.push(`- ${voterName}: 🗳️ 【投票给 ${target ? getPName(target) : "未知"}】`);
      }
    });

    return `⚖️ <b>本轮投票动态：</b>\n${votesText.join("\n")}\n\n请在下方点击按钮进行投票：`;
  }

  function getVoteKeyboard(game: WWGame): InlineKeyboard {
    const alive = getAlivePlayers(game);
    const voteKeyboard = new InlineKeyboard();

    // 保持按钮静态，不要在 Label 里加 (数字)，否则并发 editMessage 会导致按钮失效
    alive.forEach((p, index) => {
      voteKeyboard.text(getPLabel(p), `ww_vote_${game.chatId}_${p.id}`);
      if ((index + 1) % 3 === 0) voteKeyboard.row();
    });

    if (alive.length % 3 !== 0) voteKeyboard.row();
    voteKeyboard.text("⏭️ 弃权跳过", `ww_vote_${game.chatId}_skip`);

    return voteKeyboard;
  }

  async function startVotingPhase(game: WWGame) {
    if (game.phase !== "discussion") return;
    await retractPrivateActionButtons(game, game.dayWWKMessageIds);
    clearDayWWKState(game);
    game.phase = "voting";
    game.dayVotes.clear();

    const voteKeyboard = getVoteKeyboard(game);

    const statusText = getVoteStatusText(game);
    const msg = await bot.api.sendMessage(game.chatId, statusText, { parse_mode: "HTML", reply_markup: voteKeyboard });
    game.voteMessageId = msg.message_id;
    game.groupMessageIds.push(msg.message_id);

    if (game.timeout) clearTimeout(game.timeout);
    game.timeout = setTimeout(() => endVotingPhase(game), TIMEOUTS.VOTING * 1000);

    // 立即触发 AI 玩家投票
    getAlivePlayers(game).filter(p => p.id < 0).forEach(p => triggerAIAction(game, p, game.phase, game.dayCount));
  }

  async function endVotingPhase(game: WWGame) {
    if (game.phase !== "voting") return;
    clearDayWWKState(game);
    game.phase = "day"; // 立即更新阶段，防止重入/双重结算
    if (game.timeout) clearTimeout(game.timeout);

    // 超时未投票玩家：视为弃票
    const alive = getAlivePlayers(game);
    for (const p of alive) {
      if (game.dayVotes.get(p.id) === undefined) {
        game.dayVotes.set(p.id, NONE_ID);
      }
    }

    try {
      const eVoteMsg = await bot.api.sendMessage(game.chatId, "⏳ <b>投票已结束，未投票玩家已视为弃票。</b>", { parse_mode: "HTML" });
      game.groupMessageIds.push(eVoteMsg.message_id);
    } catch { }

    if (game.voteMessageId) {
      try {
        // 在结束前最后更新一次文本，确保显示所有人的投票状态
        await bot.api.editMessageText(game.chatId, game.voteMessageId, getVoteStatusText(game), { parse_mode: "HTML" });
        await bot.api.editMessageReplyMarkup(game.chatId, game.voteMessageId);
      } catch { }
    }

    const voteCounts = new Map<number | 'skip', number>();
    game.dayVotes.forEach(targetId => {
      voteCounts.set(targetId, (voteCounts.get(targetId) || 0) + 1);
    });

    let maxVotes = 0;
    let candidates: (number | 'skip')[] = [];

    voteCounts.forEach((count, target) => {
      if (count > maxVotes) {
        maxVotes = count;
        candidates = [target];
      } else if (count === maxVotes) {
        candidates.push(target);
      }
    });

    let executeId: number | 'skip' | undefined;
    if (candidates.length === 1) {
      executeId = candidates[0];
    } else if (candidates.length > 1) {
      // 平票，没有人被处决
      executeId = undefined;
    }

    let executedPlayer: Player | undefined;
    if (executeId && executeId !== NONE_ID && executeId !== 'skip') {
      executedPlayer = game.players.get(executeId as number);
    }

    const narrative = await generateWerewolfNarrative(game, "day_execution", executedPlayer);
    const msg = await bot.api.sendMessage(game.chatId, `⚖️ <b>审判结果：</b>\n\n${narrative}`, { parse_mode: "HTML" });
    game.groupMessageIds.push(msg.message_id);

    let hunterTriggered = false;
    if (executedPlayer) {
      if (await handleDeath(game, executedPlayer, "day")) {
        hunterTriggered = true;
      }
    }

    if (hunterTriggered) {
      await processHunterQueue(game, "night");
      return;
    }

    const win = checkWinCondition(game);
    if (win) {
      await announceWin(game, win);
      return;
    }

    await sleep(2000);
    startNightPhase(game);
  }

  // ================= 命令处理 =================

  bot.command(["ww", "werewolf"], async (ctx) => {
    if (!ctx.chat || ctx.chat.type === "private") {
      await ctx.reply("⚠️ 此命令仅在群组可用。");
      return;
    }

    // 删除命令本身
    try {
      await ctx.deleteMessage();
    } catch { }

    const chatId = ctx.chat.id;
    const cmdArgs = ctx.message?.text?.split(/\s+/).slice(1) || [];

    if (cmdArgs[0] === "points") {
      const currentPoints = getWerewolfWinRewardPoints(chatId);
      const currentLimit = getWerewolfWinRewardDailyLimit(chatId);
      const limitText = currentLimit > 0 ? `${currentLimit} 次/人/日` : "不限";
      if (!cmdArgs[1]) {
        const statusText = currentPoints > 0
          ? `✅ 已开启：胜利阵营每位成员自动入账 <code>+${currentPoints}</code> 积分。`
          : "⏸️ 当前未开启狼人杀胜利积分自动入账。";
        await ctx.reply(
          [
            "💰 <b>狼人杀胜利积分设置</b>",
            "",
            statusText,
            `📈 每日入账次数上限：<code>${limitText}</code>`,
            "",
            "用法:",
            "• <code>/ww points 20</code> — 设置胜利阵营每人 +20",
            "• <code>/ww points 0</code> — 关闭自动入账",
            "• <code>/ww points limit 5</code> — 每人每天最多入账 5 次",
            "• <code>/ww points limit 0</code> — 取消次数上限(不限)",
          ].join("\n"),
          { parse_mode: "HTML" }
        );
        return;
      }

      const pointsSubCommand = String(cmdArgs[1] || "").trim().toLowerCase();
      if (["limit", "daily", "cap", "上限", "次数上限"].includes(pointsSubCommand)) {
        if (!cmdArgs[2]) {
          await ctx.reply(
            [
              "📈 <b>狼人杀胜利积分-每日次数上限</b>",
              "",
              `当前设置：<code>${limitText}</code>`,
              "",
              "用法:",
              "• <code>/ww points limit 5</code> — 每人每天最多入账 5 次",
              "• <code>/ww points limit 0</code> — 取消次数上限(不限)",
            ].join("\n"),
            { parse_mode: "HTML" }
          );
          return;
        }

        const denyReason = await getWerewolfRewardPermissionDenyReason(ctx, chatId, ctx.from!.id);
        if (denyReason) {
          await ctx.reply(denyReason, { parse_mode: "HTML" });
          return;
        }

        const limit = Math.floor(Number(cmdArgs[2]));
        if (!Number.isFinite(limit) || limit < 0 || limit > 1000) {
          await ctx.reply("⚠️ 次数上限无效，请输入 0~1000 的整数。", { parse_mode: "HTML" });
          return;
        }

        setWerewolfWinRewardDailyLimit(chatId, limit);
        await ctx.reply(
          limit > 0
            ? `✅ 已设置狼人杀胜利积分每日次数上限：每人每天最多入账 <code>${limit}</code> 次。`
            : "✅ 已取消狼人杀胜利积分每日次数上限（当前为不限）。",
          { parse_mode: "HTML" }
        );
        return;
      }

      const denyReason = await getWerewolfRewardPermissionDenyReason(ctx, chatId, ctx.from!.id);
      if (denyReason) {
        await ctx.reply(denyReason, { parse_mode: "HTML" });
        return;
      }

      const rawValue = pointsSubCommand;
      if (["0", "off", "close", "disable", "关闭"].includes(rawValue)) {
        setWerewolfWinRewardPoints(chatId, 0);
        await ctx.reply("✅ 已关闭狼人杀胜利积分自动入账。", { parse_mode: "HTML" });
        return;
      }

      const points = Math.floor(Number(rawValue));
      if (!Number.isFinite(points) || points <= 0 || points > 10000) {
        await ctx.reply("⚠️ 积分数值无效，请输入 1~10000 的整数。", { parse_mode: "HTML" });
        return;
      }

      setWerewolfWinRewardPoints(chatId, points);
      const warning = isPointsEnabled(chatId)
        ? ""
        : "\n⚠️ 当前群积分系统未开启，请先开启积分系统，否则不会自动入账。";
      await ctx.reply(
        `✅ 已设置狼人杀胜利积分：胜利阵营每位成员 <code>+${points}</code> 积分。\n📈 当前每日入账次数上限：<code>${limitText}</code>${warning}`,
        { parse_mode: "HTML" }
      );
      return;
    }

    if (cmdArgs[0] === "stop" || cmdArgs[0] === "end") {
      const game = activeGames.get(chatId);
      const admins = await ctx.getChatAdministrators();
      const isAdmin = admins.some(a => a.user.id === ctx.from?.id);
      const isCreator = !!game && ctx.from?.id === game.creatorId;
      if (!isAdmin && !isCreator) {
        await ctx.reply("🚫 仅管理员或本局创建者可以提前结束游戏。");
        return;
      }
      if (game) {
        await unmuteGamePlayers(game, true);
        await cleanupGameMessages(game);
        // 强制终止时清理消息
        clearDayWWKState(game);
        if (game.timeout) clearTimeout(game.timeout);
        if (game.lobbyRefreshTimeout) clearTimeout(game.lobbyRefreshTimeout);

        // 记录人类玩家历史 (即使是被强制结束)
        const humans = Array.from(game.players.values())
          .filter(p => p.id > 0)
          .map(p => ({ id: p.id, name: p.name }));
        if (humans.length > 0) {
          recordWerewolfPlayers(chatId, humans);
        }

        activeGames.delete(chatId);
        scheduleAiRestoreAfterGame(chatId);
        await ctx.reply("✅ 狼人杀大厅/游戏已被管理员强制结束，记录已清理且已解除禁言。")
          .then(m => setTimeout(() => ctx.api.deleteMessage(chatId, m.message_id).catch(() => { }), 180_000));
      } else {
        await ctx.reply("当前没有进行中的狼人杀游戏。");
      }
      return;
    }

    // 处理 /ww start
    if (cmdArgs[0] === "start") {
      const game = activeGames.get(chatId);
      if (!game || game.phase !== "lobby") {
        await ctx.reply("游戏尚未建立大厅，请先输入 `/ww` 创建大厅。");
        return;
      }

      if (game.players.size < 3) {
        await ctx.reply(`⚠️ 人数不足，最少需要 3 人才能开始游戏（当前 ${game.players.size} 人）。`);
        return;
      }

      // 权限检查
      const admins = await ctx.api.getChatAdministrators(chatId);
      const isCreator = ctx.from?.id === game.creatorId;
      const isAdmin = admins.some(a => a.user.id === ctx.from?.id);

      if (!isCreator && !isAdmin) {
        await ctx.reply("🚫 只有游戏创建者或大群管理员可以开始游戏。");
        return;
      }

      // 触发游戏开始
      await handleGameStart(ctx, chatId, game);
      return;
    }

    if (activeGames.has(chatId)) {
      await ctx.reply("⏳ 本群已经有一个进行中的狼人杀大厅/游戏！");
      return;
    }

    const game: WWGame = {
      chatId,
      phase: "lobby",
      players: new Map(),
      dayCount: 0,
      wwVotes: new Map(),
      wolvesLockedThisNight: false,
      seerCheckedTargets: new Map(),
      dayVotes: new Map(),
      groupMessageIds: [],
      nightTimeoutToken: 0,
      firedHunterIds: [],
      hunterShotQueue: [],
      usedHealWitchIds: [],
      usedPoisonWitchIds: [],
      witchesActedThisNight: [],
      nightHealIds: [],
      nightPoisonIds: [],
      witchesMessageSentThisNight: [],
      lastNightKilledIds: [],
      graceMessageRemainingIds: new Set(),
      creatorId: ctx.from!.id,
      creatorName: getUserName(ctx.from),
      wolfMessageIds: new Map(),
      witchMessageIds: new Map(),
      seerMessageIds: new Map(),
      guardMessageIds: new Map(),
      cupidMessageIds: new Map(),
      dayWWKMessageIds: new Map(),
    };

    const aiDisabledForWerewolf = disableAiForWerewolfLobby(chatId);
    activeGames.set(chatId, game);

    // 发送大厅消息
    const botInfo = await ctx.api.getMe();
    const keyboard = new InlineKeyboard()
      .text("⚔️ 加入游戏", `ww_join_${chatId}`)
      .text("🚪 退出大厅", `ww_leave_${chatId}`).row()
      .url("🤖 新人点我", `https://t.me/${botInfo.username}?start=ww`).row()
      .text("🚀 开始游戏", `ww_start_${chatId}`)
      .text("🛑 结束游戏", `ww_stop_${chatId}`).row();

    const msg = await ctx.reply(
      `🐺 <b>狼人杀大厅已开启！</b> 🐺\n\n` +
      `${getHostLine(game)}\n` +
      `等待玩家加入...\n\n` +
      `<i>【重要】如果您是第一次使用本机器人，请务必先点击"新人点我"按钮，否则无法给您暗发身份牌！</i>\n\n` +
      `人数够了（最少 8 人）之后，点击下方按钮即可开始游戏。`,
      { parse_mode: "HTML", reply_markup: keyboard }
    );
    game.lobbyMessageId = msg.message_id;
    game.groupMessageIds.push(msg.message_id);

    if (aiDisabledForWerewolf) {
      const tip = await ctx.api.sendMessage(
        chatId,
        "⚠️ 检测到狼人杀大厅创建，已自动关闭本群 AI 检测；游戏结束后 10 分钟内若未创建新大厅将自动恢复。"
      ).catch(() => null);
      if (tip) setTimeout(() => ctx.api.deleteMessage(chatId, tip.message_id).catch(() => { }), 30_000);
    }

    // 自动提醒 7 名随机历史玩家
    await sendLobbyRecall(ctx, game);

    // 启动 3 分钟自动刷新
    scheduleLobbyRefresh(ctx, game);
  });

  async function sendLobbyRecall(ctx: Context, game: WWGame) {
    const history = getWerewolfHistory(game.chatId);
    if (history.length > 0) {
      // 过滤掉已经在房间里的玩家
      const activeIds = new Set(game.players.keys());
      const filteredHistory = history.filter(p => !activeIds.has(p.id));

      if (filteredHistory.length === 0) return;

      // 随机选 7 个
      const shuffled = filteredHistory.sort(() => Math.random() - 0.5);
      const chosen = shuffled.slice(0, 7);
      const mentions = chosen.map(p => mentionUser(p.id, p.name)).join(" ");
      const reminderMsg = await ctx.api.sendMessage(game.chatId, `🔔 <b>历史玩家召回 (随机抽选)：</b>\n${mentions}`, { parse_mode: "HTML" });
      game.groupMessageIds.push(reminderMsg.message_id);
      game.lastRecallMessageId = reminderMsg.message_id;
    }
  }

  function scheduleLobbyRefresh(ctx: Context, game: WWGame) {
    if (game.lobbyRefreshTimeout) clearTimeout(game.lobbyRefreshTimeout);

    game.lobbyRefreshTimeout = setTimeout(async () => {
      // 如果游戏还在 lobby 阶段且人数不足 8 人
      if (game.phase === "lobby" && game.players.size < 8) {
        try {
          // 删除旧大厅和邀请消息，保持公屏整洁
          if (game.lobbyMessageId) {
            await ctx.api.deleteMessage(game.chatId, game.lobbyMessageId).catch(() => { });
            game.groupMessageIds = game.groupMessageIds.filter(id => id !== game.lobbyMessageId);
          }
          if (game.lastRecallMessageId) {
            await ctx.api.deleteMessage(game.chatId, game.lastRecallMessageId).catch(() => { });
            game.groupMessageIds = game.groupMessageIds.filter(id => id !== game.lastRecallMessageId);
          }

          // 发送新大厅消息
          const botInfo = await ctx.api.getMe();
          const keyboard = new InlineKeyboard()
            .text("⚔️ 加入游戏", `ww_join_${game.chatId}`)
            .text("🚪 退出大厅", `ww_leave_${game.chatId}`).row()
            .url("🤖 新人点我", `https://t.me/${botInfo.username}?start=ww`).row()
            .text("🚀 开始游戏", `ww_start_${game.chatId}`)
            .text("🛑 结束游戏", `ww_stop_${game.chatId}`).row();

          const playerList = getLobbyPlayersText(game);

          const msg = await ctx.api.sendMessage(game.chatId,
            `🐺 <b>狼人杀大厅仍在等待中...</b> 🐺\n` +
            `${getHostLine(game)}\n` +
            `👥 <b>当前玩家 (${game.players.size}/8):</b>\n${playerList}\n\n` +
            `继续召回一波历史玩家！`,
            {
              parse_mode: "HTML",
              reply_markup: keyboard,
              link_preview_options: { is_disabled: true }
            }
          );
          game.lobbyMessageId = msg.message_id;
          game.groupMessageIds.push(msg.message_id);

          // 换一批新玩家召回
          await sendLobbyRecall(ctx, game);

          // 继续循环
          scheduleLobbyRefresh(ctx, game);
        } catch (e) {
          console.error("[WW Lobby Refresh] 失败:", e);
        }
      }
    }, 180 * 1000); // 3 分钟
  }

  // ================= 游戏启动助手 =================
  async function handleGameStart(ctx: Context, chatId: number, game: WWGame) {
    if (game.phase !== "lobby") return;

    // 检查权限：只能由创建者开始
    const isCreator = ctx.from?.id === game.creatorId;
    const admins = await ctx.api.getChatAdministrators(chatId);
    const isAdmin = admins.some(a => a.user.id === ctx.from?.id);

    if (!isCreator && !isAdmin) {
      const text = "🚫 只有游戏创建者或管理员可以开始游戏。";
      if (ctx.callbackQuery) {
        await ctx.answerCallbackQuery({ text, show_alert: true }).catch(() => { });
      } else {
        await ctx.reply(text);
      }
      return;
    }

    // 1. 验证所有玩家是否已启动机器人
    const vMsg = await ctx.reply("🎲 正在验证玩家私聊状态...", { parse_mode: "HTML" });
    game.groupMessageIds.push(vMsg.message_id);

    const playerArray = Array.from(game.players.values());
    const kicked: string[] = [];

    for (const p of playerArray) {
      try {
        await bot.api.sendMessage(p.id, "🎲 <b>狼人杀游戏即将开始！</b>\n请保持私聊窗口打开，在此接收身份牌与操作指令。", { parse_mode: "HTML" });
      } catch (e) {
        game.players.delete(p.id);
        kicked.push(getPName(p));
      }
    }

    if (kicked.length > 0) {
      const kMsg = await ctx.reply(`⚠️ 以下玩家因未启动 Bot 被移出游戏：${kicked.join(", ")}`, { parse_mode: "HTML" });
      game.groupMessageIds.push(kMsg.message_id);
    }

    if (game.players.size < 3) {
      const fMsg = await ctx.reply("⚠️ 至少需要 3 名真人玩家启动机器人后才能开始游戏。请邀请更多人加入并确保都已启动机器人。");
      await cleanupGameMessages(game);
      activeGames.delete(chatId);
      scheduleAiRestoreAfterGame(chatId);
      return;
    }

    // 如果不足 8 人，补齐 AI 虚拟玩家
    if (game.players.size < 8) {
      const aiCount = 8 - game.players.size;
      const namePool = ["李慕婉", "王麻子", "藤化元", "红蝶", "司徒南", "天运子", "拓森", "柳眉", "云雀子", "古魔", "周武泰", "周佚", "凌天侯", "十三", "韩立", "厉飞雨"];
      const shuffledNames = namePool.sort(() => Math.random() - 0.5);

      for (let i = 1; i <= aiCount; i++) {
        const aiId = -i; // 使用负数 ID 标识 AI 玩家
        const aiName = shuffledNames[i - 1] || `AI 玩家 ${i}`;
        const aiPlayer: Player = {
          id: aiId,
          name: aiName,
          role: "villager",
          isAlive: true,
          position: 0 // 暂时占位，稍后统一分配
        };
        game.players.set(aiId, aiPlayer);
      }
      const aiMsg = await ctx.reply(`🤖 <b>检测到真人玩家不足 8 人，系统已自动加入 ${aiCount} 名 AI 虚拟玩家补位。</b>`, { parse_mode: "HTML" });
      game.groupMessageIds.push(aiMsg.message_id);
    }

    // 重新统一分配序号，确保连续且没有重复 (处理因踢人或加AI导致的序号混乱)
    let currentPos = 1;
    for (const p of game.players.values()) {
      p.position = currentPos++;
    }


    // 2. 清除大厅按钮和定时器
    try {
      if (game.lobbyRefreshTimeout) clearTimeout(game.lobbyRefreshTimeout);
      if (game.lobbyMessageId) await ctx.api.editMessageReplyMarkup(chatId, game.lobbyMessageId);
    } catch { }

    game.phase = "night";

    // 3. 分配身份
    const remainingPlayers = Array.from(game.players.values());
    // 洗牌
    for (let i = remainingPlayers.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [remainingPlayers[i], remainingPlayers[j]] = [remainingPlayers[j], remainingPlayers[i]];
    }

    let wolvesCount = 2;
    let seersCount = 1;
    let witchesCount = 1;
    let huntersCount = 1;
    let guardsCount = 0;
    let wwkCount = 0;
    let cupidsCount = 0;

    const playerCount = remainingPlayers.length;
    if (playerCount >= 12) {
      wolvesCount = 3;
      wwkCount = 1;
      seersCount = 1;
      witchesCount = 1;
      huntersCount = 1;
      guardsCount = 1;
      cupidsCount = 1;
    } else if (playerCount >= 10) {
      wolvesCount = 3;
      wwkCount = 1;
      seersCount = 1;
      witchesCount = 1;
      huntersCount = 1;
      guardsCount = 1;
    } else if (playerCount >= 9) {
      wolvesCount = 2;
      wwkCount = 1;
      seersCount = 1;
      witchesCount = 1;
      huntersCount = 1;
    } else {
      wolvesCount = 2;
      wwkCount = 1;
      seersCount = 1;
      witchesCount = 1;
      huntersCount = 1;
    }

    let nextIdx = 0;
    // 1. 分配狼人 (含白狼王)
    for (let i = 0; i < wolvesCount; i++) {
      const p = remainingPlayers[nextIdx];
      if (i === 0 && wwkCount > 0) p.role = "white_wolf_king";
      else p.role = "werewolf";
      nextIdx++;
    }
    // 2. 分配预言家
    for (let i = 0; i < seersCount; i++) { remainingPlayers[nextIdx].role = "seer"; nextIdx++; }
    // 3. 分配女巫
    for (let i = 0; i < witchesCount; i++) { remainingPlayers[nextIdx].role = "witch"; nextIdx++; }
    // 4. 分配猎人
    for (let i = 0; i < huntersCount; i++) { remainingPlayers[nextIdx].role = "hunter"; nextIdx++; }
    // 5. 分配守卫
    for (let i = 0; i < guardsCount; i++) { remainingPlayers[nextIdx].role = "guard"; nextIdx++; }
    // 6. 分配丘比特
    for (let i = 0; i < cupidsCount; i++) { remainingPlayers[nextIdx].role = "cupid"; nextIdx++; }
    // 7. 其余平民
    for (let i = nextIdx; i < remainingPlayers.length; i++) { remainingPlayers[i].role = "villager"; }

    // 4. 下发身份
    const iMsg = await ctx.reply("🎭 <b>身份牌已通过私聊下发！</b>", { parse_mode: "HTML" });
    game.groupMessageIds.push(iMsg.message_id);

    const wolfTeamNames = remainingPlayers.filter(rp => (rp.role === "werewolf" || rp.role === "white_wolf_king")).map(rp => getPName(rp));

    for (const p of remainingPlayers) {
      let roleTitle = "";
      let roleBody = "";
      if (p.role === "werewolf") {
        roleTitle = "🐺 狼人";
        roleBody = `夜晚可以与其他狼人商量杀害一名玩家。\n你的狼队友有：${wolfTeamNames.filter(n => n !== getPName(p)).join(", ") || "无"}`;
      } else if (p.role === "white_wolf_king") {
        roleTitle = "👹 白狼王";
        roleBody = `你是狼人阵营的首领。你的狼队友有：${wolfTeamNames.filter(n => n !== getPName(p)).join(", ") || "无"}\n白天自由讨论开始时，你会收到 60 秒的【自爆/潜伏】私聊指令。若选择自爆并带走目标，将直接跳过当轮投票进入黑夜。`;
      } else if (p.role === "seer") {
        roleTitle = "👁️ 预言家";
        roleBody = "每晚可以查验一名玩家，得知其是【狼人】还是【好人】。";
      } else if (p.role === "witch") {
        roleTitle = "🧪 女巫";
        roleBody = "你有一瓶解药（救人）和一瓶毒药（杀人）。";
      } else if (p.role === "hunter") {
        roleTitle = "🔫 猎人";
        roleBody = "你死亡时（被处决或被狼人杀害）可以开枪带走一名玩家。";
      } else if (p.role === "guard") {
        roleTitle = "🛡️ 守卫";
        roleBody = "每晚可以守护一名玩家不被狼害，不可连续两晚守护同一人。";
      } else if (p.role === "cupid") {
        roleTitle = "💘 丘比特";
        roleBody = "第一晚可以指定两名玩家成为情侣。";
      } else {
        roleTitle = "🧑‍🌾 平民";
        roleBody = "你没有任何特殊技能，请在白天通过讨论找出狼人。";
      }

      try {
        if (p.id > 0) await bot.api.sendMessage(p.id, `🎭 身份下发，你的身份是：【<b>${roleTitle}</b>】。\n\n${roleBody}`, { parse_mode: "HTML" });
      } catch { }
    }

    const humanMentions = remainingPlayers
      .filter(p => p.id > 0)
      .sort((a, b) => a.position - b.position)
      .map(p => `<a href="tg://user?id=${p.id}">${getPName(p)}</a>`)
      .join(" ");
    const sMsg = await ctx.reply(`🎭 <b>身份已下发！</b>\n游戏正式开始，请各位玩家各就各位：\n\n${humanMentions}`, { parse_mode: "HTML" });
    game.groupMessageIds.push(sMsg.message_id);
    await sleep(2000);
    startNightPhase(game);
  }

  // ================= 回调处理 =================

  bot.on("callback_query:data", async (ctx, next) => {
    const data = ctx.callbackQuery.data;
    if (!data.startsWith("ww_")) {
      await next();
      return;
    }

    const userId = ctx.from.id;
    const userName = getUserName(ctx.from);

    // 加入大厅
    if (data.startsWith("ww_join_")) {
      const chatId = parseInt(data.replace("ww_join_", ""));
      const game = activeGames.get(chatId);
      if (!game || game.phase !== "lobby") {
        await ctx.answerCallbackQuery({ text: "游戏不在加入阶段或大厅已关闭。", show_alert: true }).catch(() => { });
        return;
      }

      if (game.players.has(userId)) {
        await ctx.answerCallbackQuery({ text: "你已经加入游戏了！" }).catch(() => { });
        return;
      }

      game.players.set(userId, {
        id: userId,
        name: userName,
        role: "villager", // 暂时代位
        isAlive: true,
        position: game.players.size + 1
      });

      // 人数达到 8 人提醒房主
      if (game.players.size === 8) {
        try {
          await bot.api.sendMessage(game.creatorId, `🔔 <b>狼人杀提醒</b>\n\n您的房间在群 <b>${esc(ctx.chat?.title || "未知群聊")}</b> 中人数已满 8 人，可以点击下方按钮开始游戏！`, {
            parse_mode: "HTML"
          });
        } catch (e) { }
      }

      await ctx.answerCallbackQuery({ text: "成功加入游戏！" }).catch(() => { });

      const ps = getLobbyPlayersText(game);
      try {
        const botInfo = await ctx.api.getMe();
        const keyboard = new InlineKeyboard()
          .text("⚔️ 加入游戏", `ww_join_${chatId}`)
          .text("🚪 退出大厅", `ww_leave_${chatId}`).row()
          .url("🤖 新人点我", `https://t.me/${botInfo.username}?start=ww`).row()
          .text("🚀 开始游戏", `ww_start_${chatId}`)
          .text("🛑 结束游戏", `ww_stop_${chatId}`).row();

        await ctx.api.editMessageText(
          chatId,
          game.lobbyMessageId!,
          `🐺 <b>狼人杀大厅已开启！</b> 🐺\n\n` +
          `${getHostLine(game)}\n` +
          `👥 <b>当前玩家 (${game.players.size}人):</b>\n${ps}\n\n` +
          `<i>【重要】如果您是第一次使用本机器人，请务必先点击"新人点我"按钮，否则无法给您暗发身份牌！</i>\n\n` +
          `人数够了之后，点击下方按钮即可开始游戏。`,
          {
            parse_mode: "HTML",
            reply_markup: keyboard,
            link_preview_options: { is_disabled: true }
          }
        );
      } catch { }
      return;
    }

    // 退出大厅
    if (data.startsWith("ww_leave_")) {
      const chatId = parseInt(data.replace("ww_leave_", ""));
      const game = activeGames.get(chatId);
      if (!game || game.phase !== "lobby") {
        await ctx.answerCallbackQuery({ text: "游戏不在加入阶段或大厅已关闭。", show_alert: true }).catch(() => { });
        return;
      }

      if (!game.players.has(userId)) {
        await ctx.answerCallbackQuery({ text: "你当前不在大厅玩家列表。" }).catch(() => { });
        return;
      }

      game.players.delete(userId);
      rebalanceLobbyPlayerPositions(game);
      await ctx.answerCallbackQuery({ text: "你已退出大厅。" }).catch(() => { });

      const ps = getLobbyPlayersText(game);
      try {
        const botInfo = await ctx.api.getMe();
        const keyboard = new InlineKeyboard()
          .text("⚔️ 加入游戏", `ww_join_${chatId}`)
          .text("🚪 退出大厅", `ww_leave_${chatId}`).row()
          .url("🤖 新人点我", `https://t.me/${botInfo.username}?start=ww`).row()
          .text("🚀 开始游戏", `ww_start_${chatId}`)
          .text("🛑 结束游戏", `ww_stop_${chatId}`).row();

        await ctx.api.editMessageText(
          chatId,
          game.lobbyMessageId!,
          `🐺 <b>狼人杀大厅已开启！</b> 🐺\n\n` +
          `${getHostLine(game)}\n` +
          `👥 <b>当前玩家 (${game.players.size}人):</b>\n${ps}\n\n` +
          `<i>【重要】如果您是第一次使用本机器人，请务必先点击"新人点我"按钮，否则无法给您暗发身份牌！</i>\n\n` +
          `人数够了之后，点击下方按钮即可开始游戏。`,
          {
            parse_mode: "HTML",
            reply_markup: keyboard,
            link_preview_options: { is_disabled: true }
          }
        );
      } catch { }
      return;
    }

    // 开始游戏 (按钮点击)
    if (data.startsWith("ww_start_")) {
      await ctx.answerCallbackQuery().catch(() => { });
      const chatId = parseInt(data.replace("ww_start_", ""));
      const game = activeGames.get(chatId);
      if (!game || game.phase !== "lobby") {
        await ctx.api.sendMessage(userId, "⚠️ 游戏不在加入阶段或大厅已关闭。").catch(() => { });
        return;
      }

      if (game.players.size < 3) {
        await ctx.api.sendMessage(chatId, `⚠️ 人数不足，最少需要 3 人才能开始游戏（当前 ${game.players.size} 人）。`).catch(() => { });
        return;
      }

      // 权限检查
      const admins = await ctx.api.getChatAdministrators(chatId);
      const isCreator = userId === game.creatorId;
      const isAdmin = admins.some(a => a.user.id === userId);

      if (!isCreator && !isAdmin) {
        await ctx.api.sendMessage(userId, "🚫 只有游戏创建者或管理员可以开始游戏。").catch(() => { });
        return;
      }

      await handleGameStart(ctx, chatId, game);
      return;
    }


    // 停止游戏 (按钮点击)
    if (data.startsWith("ww_stop_")) {
      await ctx.answerCallbackQuery().catch(() => { });
      const chatId = parseInt(data.replace("ww_stop_", ""));
      const game = activeGames.get(chatId);

      const admins = await ctx.api.getChatAdministrators(chatId);
      const isAdmin = admins.some(a => a.user.id === userId);
      const isCreator = !!game && userId === game.creatorId;
      if (!isAdmin && !isCreator) {
        await ctx.api.sendMessage(userId, "🚫 仅管理员或本局创建者可以提前结束游戏。").catch(() => { });
        return;
      }

      if (game) {
        await unmuteGamePlayers(game, true);
        await cleanupGameMessages(game);
        clearDayWWKState(game);
        if (game.timeout) clearTimeout(game.timeout);
        if (game.lobbyRefreshTimeout) clearTimeout(game.lobbyRefreshTimeout);

        // 记录人类玩家历史
        const humans = Array.from(game.players.values())
          .filter(p => p.id > 0)
          .map(p => ({ id: p.id, name: p.name }));
        if (humans.length > 0) {
          recordWerewolfPlayers(chatId, humans);
        }

        activeGames.delete(chatId);
        scheduleAiRestoreAfterGame(chatId);
        await ctx.api.sendMessage(chatId, "✅ 狼人杀大厅/游戏已被管理员强制结束，记录已清理且已解除禁言。")
          .then(m => setTimeout(() => ctx.api.deleteMessage(chatId, m.message_id).catch(() => { }), 180_000));
      } else {
        await ctx.api.sendMessage(userId, "当前没有进行中的狼人杀游戏。").catch(() => { });
      }
      return;
    }

    // 夜晚：守卫行动
    if (data.startsWith("ww_guard_")) {
      const parts = data.split("_");
      const chatId = parseInt(parts[2]);
      const actionNight = parseInt(parts[3]); // 回调携带的夜次，防止旧按钮串夜
      const targetId = parseInt(parts[4]);

      const game = activeGames.get(chatId);
      if (!game || (game.phase !== "night" && game.phase !== "guard" && game.phase !== "cupid")) {
        await ctx.answerCallbackQuery({ text: "现在不是夜晚的守护时间！", show_alert: true }).catch(() => { });
        return;
      }
      if (!Number.isFinite(actionNight) || actionNight !== game.dayCount) {
        await ctx.answerCallbackQuery({ text: `这条守护操作已过期（当前第 ${game.dayCount} 夜）。`, show_alert: true }).catch(() => { });
        return;
      }
      if (!Number.isFinite(targetId)) {
        await ctx.answerCallbackQuery({ text: "守护目标无效。", show_alert: true }).catch(() => { });
        return;
      }

      const p = game.players.get(userId);
      if (!p || p.role !== "guard" || !p.isAlive) {
        await ctx.answerCallbackQuery({ text: "你不是存活的守卫！", show_alert: true }).catch(() => { });
        return;
      }
      const target = game.players.get(targetId);
      if (!target || !target.isAlive) {
        await ctx.answerCallbackQuery({ text: "目标不存在或已死亡。", show_alert: true }).catch(() => { });
        return;
      }
      if (targetId === game.lastProtectedId) {
        await ctx.answerCallbackQuery({ text: "不能连续两晚守护同一人！", show_alert: true }).catch(() => { });
        return;
      }

      if (game.nightProtectedId !== undefined) {
        await ctx.answerCallbackQuery({ text: "你今晚已经守过人了！", show_alert: true }).catch(() => { });
        return;
      }

      game.nightProtectedId = targetId;
      await ctx.answerCallbackQuery({ text: "守护指令已确认。" }).catch(() => { });

      try {
        const link = getGroupReturnLink(game);
        const returnKeyboard = new InlineKeyboard().url("🔙 返回群组", link);

        await ctx.api.editMessageText(userId, ctx.callbackQuery.message!.message_id, `🛡️ <b>守卫行动 (第 ${game.dayCount} 夜)</b>\n\n你今晚守护了：<b>${game.players.get(targetId) ? getPName(game.players.get(targetId)!) : "未知"}</b>`, {
          parse_mode: "HTML",
          reply_markup: returnKeyboard
        });
      } catch { }

      await checkNightPhaseCompletion(game);
      return;
    }

    // 夜晚：丘比特连人
    if (data.startsWith("ww_cupid_")) {
      const parts = data.split("_");
      const chatId = parseInt(parts[2]);
      const actionNight = parseInt(parts[3]);
      const targetId = parseInt(parts[4]);

      const game = activeGames.get(chatId);
      if (!game || (game.phase !== "cupid" && game.phase !== "guard")) {
        await ctx.answerCallbackQuery({ text: "现在不是连人的时间！", show_alert: true }).catch(() => { });
        return;
      }
      if (!Number.isFinite(actionNight) || actionNight !== game.dayCount) {
        await ctx.answerCallbackQuery({ text: `这条连人操作已过期（当前第 ${game.dayCount} 夜）。`, show_alert: true }).catch(() => { });
        return;
      }
      if (!Number.isFinite(targetId) || !game.players.has(targetId)) {
        await ctx.answerCallbackQuery({ text: "连人目标无效。", show_alert: true }).catch(() => { });
        return;
      }

      const p = game.players.get(userId);
      if (!p || p.role !== "cupid" || !p.isAlive) {
        await ctx.answerCallbackQuery({ text: "你不是存活的丘比特！", show_alert: true }).catch(() => { });
        return;
      }

      if (!game.cupidTargetIds) game.cupidTargetIds = [];
      if (game.cupidTargetIds.includes(targetId)) {
        await ctx.answerCallbackQuery({ text: "你已经选过这个玩家了！", show_alert: true }).catch(() => { });
        return;
      }

      game.cupidTargetIds.push(targetId);

      if (game.cupidTargetIds.length < 2) {
        await ctx.answerCallbackQuery({ text: "请选择第二个人。" }).catch(() => { });
        return;
      }

      game.lovers = [game.cupidTargetIds[0], game.cupidTargetIds[1]];
      await ctx.answerCallbackQuery({ text: "连人成功！" }).catch(() => { });

      const l1 = game.players.get(game.lovers[0]);
      const l2 = game.players.get(game.lovers[1]);

      try {
        const link = getGroupReturnLink(game);
        const returnKeyboard = new InlineKeyboard().url("🔙 返回群组", link);

        await ctx.api.editMessageText(userId, ctx.callbackQuery.message!.message_id, `💘 <b>丘比特行动 (第 ${game.dayCount} 夜)</b>\n\n你连接了 <b>${l1 ? esc(l1.name) : "未知"}</b> 和 <b>${l2 ? esc(l2.name) : "未知"}</b>。`, {
          parse_mode: "HTML",
          reply_markup: returnKeyboard
        });

        // 分别通知情侣（AI 玩家没有私聊，不发送）
        if (l1 && l1.id > 0) {
          try {
            await bot.api.sendMessage(l1.id, `💘 <b>你坠入爱河了！</b>\n你的爱人是：<b>${l2 ? esc(l2.name) : "未知"}</b>。\n生死与共，一人离去，另一人也将殉情。`, { parse_mode: "HTML" });
          } catch { }
        }
        if (l2 && l2.id > 0) {
          try {
            await bot.api.sendMessage(l2.id, `💘 <b>你坠入爱河了！</b>\n你的爱人是：<b>${l1 ? esc(l1.name) : "未知"}</b>。\n生死与共，一人离去，另一人也将殉情。`, { parse_mode: "HTML" });
          } catch { }
        }
      } catch { }

      await checkNightPhaseCompletion(game);
      return;
    }

    // 白天讨论：白狼王潜伏
    if (data.startsWith("ww_day_wwk_hide_")) {
      const chatId = parseInt(data.replace("ww_day_wwk_hide_", ""));
      const game = activeGames.get(chatId);
      if (!game || game.phase !== "discussion") {
        await ctx.answerCallbackQuery({ text: "当前不是白狼王白天决策时间。", show_alert: true }).catch(() => { });
        return;
      }

      const king = game.players.get(userId);
      if (!king || king.role !== "white_wolf_king" || !king.isAlive) {
        await ctx.answerCallbackQuery({ text: "你不是存活的白狼王！", show_alert: true }).catch(() => { });
        return;
      }
      if (game.dayWWKPendingId !== userId) {
        await ctx.answerCallbackQuery({ text: "你的白狼王决策已处理。", show_alert: true }).catch(() => { });
        return;
      }

      clearDayWWKState(game);
      await ctx.answerCallbackQuery({ text: "已选择潜伏，本轮将正常进入投票。" }).catch(() => { });

      const link = getGroupReturnLink(game);
      const returnKeyboard = new InlineKeyboard().url("🔙 返回群组", link);
      try {
        await ctx.api.editMessageText(userId, ctx.callbackQuery.message!.message_id, "👹 <b>白狼王抉择</b>\n\n你已选择【潜伏】，本轮将正常进入投票。", {
          parse_mode: "HTML",
          reply_markup: returnKeyboard
        });
      } catch { }
      return;
    }

    // 白天讨论：白狼王自爆（进入选人）
    if (data.startsWith("ww_day_wwk_boom_")) {
      const chatId = parseInt(data.replace("ww_day_wwk_boom_", ""));
      const game = activeGames.get(chatId);
      if (!game || game.phase !== "discussion") {
        await ctx.answerCallbackQuery({ text: "当前不是白狼王白天决策时间。", show_alert: true }).catch(() => { });
        return;
      }

      const king = game.players.get(userId);
      if (!king || king.role !== "white_wolf_king" || !king.isAlive) {
        await ctx.answerCallbackQuery({ text: "你不是存活的白狼王！", show_alert: true }).catch(() => { });
        return;
      }
      if (game.dayWWKPendingId !== userId) {
        await ctx.answerCallbackQuery({ text: "你的白狼王决策已处理。", show_alert: true }).catch(() => { });
        return;
      }

      game.dayWWKChoosingTarget = true;
      await ctx.answerCallbackQuery({ text: "请选择你要带走的目标。" }).catch(() => { });

      const aliveOthers = getAlivePlayers(game).filter(ap => ap.id !== userId);
      const keyboard = new InlineKeyboard();
      aliveOthers.forEach(ao => {
        keyboard.text(getPLabel(ao), `ww_day_wwk_kill_${chatId}_${ao.id}`).row();
      });
      keyboard.row().url("🔙 返回群组", getGroupReturnLink(game));

      try {
        await ctx.api.editMessageText(userId, ctx.callbackQuery.message!.message_id, "💥 <b>白狼王自爆</b>\n\n请选择你要带走的目标：", {
          parse_mode: "HTML",
          reply_markup: keyboard
        });
      } catch { }
      return;
    }

    // 白天讨论：白狼王确认自爆目标（立即结算并跳过投票）
    if (data.startsWith("ww_day_wwk_kill_")) {
      const parts = data.split("_");
      const chatId = parseInt(parts[4]);
      const targetId = parseInt(parts[5]);

      const game = activeGames.get(chatId);
      if (!game || game.phase !== "discussion") {
        await ctx.answerCallbackQuery({ text: "现在不能执行白狼王自爆。", show_alert: true }).catch(() => { });
        return;
      }

      const king = game.players.get(userId);
      const target = game.players.get(targetId);
      if (!king || king.role !== "white_wolf_king" || !king.isAlive) {
        await ctx.answerCallbackQuery({ text: "你不是存活的白狼王！", show_alert: true }).catch(() => { });
        return;
      }
      if (game.dayWWKPendingId !== userId || !game.dayWWKChoosingTarget) {
        await ctx.answerCallbackQuery({ text: "请先点击【自爆】再选择目标。", show_alert: true }).catch(() => { });
        return;
      }
      if (!target || !target.isAlive || target.id === userId) {
        await ctx.answerCallbackQuery({ text: "目标无效，请重新选择。", show_alert: true }).catch(() => { });
        return;
      }

      await ctx.answerCallbackQuery({ text: "自爆已确认，正在结算..." }).catch(() => { });

      const returnKeyboard = new InlineKeyboard().url("🔙 返回群组", getGroupReturnLink(game));
      try {
        await ctx.api.editMessageText(userId, ctx.callbackQuery.message!.message_id, `💥 你已自爆并锁定目标：<b>${getPName(target)}</b>`, {
          parse_mode: "HTML",
          reply_markup: returnKeyboard
        });
      } catch { }

      await resolveDayWWKBoom(game, king, target);
      return;
    }

    // 夜晚：狼人杀人
    if (data.startsWith("ww_kill_")) {
      const parts = data.split("_");
      const chatId = parseInt(parts[2]);
      const targetId = parseInt(parts[3]);

      const game = activeGames.get(chatId);
      if (!game || (game.phase !== "night" && game.phase !== "guard" && game.phase !== "cupid")) {
        await ctx.answerCallbackQuery({ text: "现在不是夜晚的杀人时间！", show_alert: true }).catch(() => { });
        return;
      }

      const wolvesObj = getPlayersByRole(game, "werewolf").concat(getPlayersByRole(game, "white_wolf_king"));
      if (!wolvesObj.find(w => w.id === userId)) {
        await ctx.answerCallbackQuery({ text: "你不是存活的狼人！", show_alert: true }).catch(() => { });
        return;
      }
      if (game.wolvesLockedThisNight) {
        await ctx.answerCallbackQuery({ text: "🧷 本夜狼队已锁票，不能再改目标。", show_alert: true }).catch(() => { });
        return;
      }
      if (!Number.isFinite(targetId)) {
        await ctx.answerCallbackQuery({ text: "目标无效。", show_alert: true }).catch(() => { });
        return;
      }
      if (targetId !== NONE_ID) {
        const target = game.players.get(targetId);
        if (!target || !target.isAlive) {
          await ctx.answerCallbackQuery({ text: "目标不存在或已死亡。", show_alert: true }).catch(() => { });
          return;
        }
      }

      game.wwVotes.set(userId, targetId);
      // 狼人允许在夜晚反复改票；每次改票后都要让击杀结果重新计算，
      // 否则女巫阶段可能看到过期的狼刀目标（甚至误判为平安夜）。
      game.wolfKillId = undefined;
      await ctx.answerCallbackQuery({ text: "杀人目标已同步至队友。" }).catch(() => { });

      // 更新所有狼人的消息 (共享投票状态)
      await updateWolfMessages(game);

      // 检查夜晚是否可以结束（或进入女巫回合）
      await checkNightPhaseCompletion(game);


      return;
    }

    // 夜晚：预言家查验
    if (data.startsWith("ww_seer_")) {
      const parts = data.split("_");
      const chatId = parseInt(parts[2]);
      const targetId = parseInt(parts[3]);

      const game = activeGames.get(chatId);
      if (!game || (game.phase !== "night" && game.phase !== "guard" && game.phase !== "cupid")) {
        await ctx.answerCallbackQuery({ text: "现在不是夜晚的查验时间！", show_alert: true }).catch(() => { });
        return;
      }

      const p = game.players.get(userId);
      if (!p || p.role !== "seer" || !p.isAlive) {
        await ctx.answerCallbackQuery({ text: "你不是存活的预言家！", show_alert: true }).catch(() => { });
        return;
      }

      if (game.seerCheckedTargets.has(userId)) {
        await ctx.answerCallbackQuery({ text: "你今晚已经查验过了！", show_alert: true }).catch(() => { });
        return;
      }
      if (!Number.isFinite(targetId)) {
        await ctx.answerCallbackQuery({ text: "查验目标无效。", show_alert: true }).catch(() => { });
        return;
      }
      const targetPlayer = game.players.get(targetId);
      if (!targetPlayer || !targetPlayer.isAlive || targetId === userId) {
        await ctx.answerCallbackQuery({ text: "目标不存在、已死亡或不可查验。", show_alert: true }).catch(() => { });
        return;
      }

      game.seerCheckedTargets.set(userId, targetId);
      const targetRole = targetPlayer.role;
      const identify = (targetRole === "werewolf" || targetRole === "white_wolf_king") ? "🐺 坏人 (狼人)" : "🧑‍🌾 好人";

      await ctx.answerCallbackQuery({ text: "查验成功！详见消息。" }).catch(() => { });

      try {
        const link = getGroupReturnLink(game);
        const returnKeyboard = new InlineKeyboard().url("🔙 返回群组", link);

        await ctx.api.editMessageText(userId, ctx.callbackQuery.message!.message_id, `👁️ <b>预言家行动 (第 ${game.dayCount} 夜)</b>\n\n你查验了 <b>${game.players.get(targetId) ? getPName(game.players.get(targetId)!) : "未知"}</b>，他的身份是：<b>${identify}</b>`, {
          parse_mode: "HTML",
          reply_markup: returnKeyboard
        });
      } catch { }

      // 检查夜晚是否可以进入下一阶段
      await checkNightPhaseCompletion(game);
      return;
    }

    // 白天投票
    if (data.startsWith("ww_vote_")) {
      const parts = data.split("_");
      const chatId = parseInt(parts[2]);
      const target = parts[3];

      const game = activeGames.get(chatId);
      if (!game || game.phase !== "voting") {
        await ctx.answerCallbackQuery({ text: "现在不是白天的投票时间！", show_alert: true }).catch(() => { });
        return;
      }

      const voter = game.players.get(userId);
      if (!voter || !voter.isAlive) {
        await ctx.answerCallbackQuery({ text: "死人是不能投票的 👻", show_alert: true }).catch(() => { });
        return;
      }

      if (game.dayVotes.has(userId)) {
        await ctx.answerCallbackQuery({ text: "你已经投过票了！", show_alert: true }).catch(() => { });
        return;
      }
      if (target === "skip") {
        game.dayVotes.set(userId, NONE_ID);
      } else {
        const targetId = parseInt(target);
        if (!Number.isFinite(targetId)) {
          await ctx.answerCallbackQuery({ text: "投票目标无效。", show_alert: true }).catch(() => { });
          return;
        }
        const targetPlayer = game.players.get(targetId);
        if (!targetPlayer || !targetPlayer.isAlive) {
          await ctx.answerCallbackQuery({ text: "投票目标不存在或已死亡。", show_alert: true }).catch(() => { });
          return;
        }
        game.dayVotes.set(userId, targetId);
      }

      const alive = getAlivePlayers(game);
      const votedCount = game.dayVotes.size;

      // 立即通过 answerCallbackQuery 反馈进度，不依赖 editMessageText
      await ctx.answerCallbackQuery({
        text: `投票成功！当前进度：${votedCount}/${alive.length}`,
        show_alert: false
      }).catch(() => { });

      if (votedCount === alive.length) {
        // 全员投完，立即进入结算
        endVotingPhase(game);
      } else {
        // 只有在人数过半或者特定节点才更新消息，或者干脆不带键盘地更新显示
        // 这里为了体验，我们尝试平滑更新（带上之前的静态键盘）
        try {
          await ctx.editMessageText(getVoteStatusText(game), {
            parse_mode: "HTML",
            reply_markup: getVoteKeyboard(game) // 此时返回的是一样的静态键盘
          });
        } catch (e: any) {
          if (isIgnorableEditError(e)) return;
        }
      }
      return;
    }

    // 猎人开枪
    if (data.startsWith("ww_hunter_shoot_")) {
      const parts = data.split("_");
      const chatId = parseInt(parts[3]);
      const targetId = parts[4];

      const game = activeGames.get(chatId);
      if (!game || game.phase !== "hunter_shot") {
        await ctx.answerCallbackQuery({ text: "现在不是开枪时间！", show_alert: true }).catch(() => { });
        return;
      }

      if (game.pendingHunterShotId !== userId) {
        await ctx.answerCallbackQuery({ text: "你不是正在开枪的猎人！", show_alert: true }).catch(() => { });
        return;
      }

      await ctx.answerCallbackQuery({ text: "开枪目标已确认。" }).catch(() => { });

      try {
        if (ctx.callbackQuery.message) {
          const link = getGroupReturnLink(game);
          const returnKeyboard = new InlineKeyboard().url("🔙 返回群组", link);
          await ctx.api.editMessageReplyMarkup(chatId, ctx.callbackQuery.message.message_id, { reply_markup: returnKeyboard });
        }
      } catch { }

      await endHunterShotPhase(game, targetId === "skip" ? "skip" : parseInt(targetId));
      return;
    }

    // 女巫：救人
    if (data.startsWith("ww_witch_heal_")) {
      const parts = data.split("_");
      const chatId = parseInt(parts[3]);
      const targetId = parseInt(parts[4]);

      const game = activeGames.get(chatId);
      if (!game || game.phase !== "night") {
        await ctx.answerCallbackQuery({ text: "当前不是女巫行动时间。", show_alert: true }).catch(() => { });
        await retractCurrentCallbackButtons(ctx, game);
        return;
      }

      const witch = game.players.get(userId);
      if (!witch || witch.role !== "witch" || !witch.isAlive) {
        await ctx.answerCallbackQuery({ text: "你不是存活的女巫！", show_alert: true }).catch(() => { });
        return;
      }

      if (game.usedHealWitchIds.includes(userId)) {
        await ctx.answerCallbackQuery({ text: "你已经用过解药了！", show_alert: true }).catch(() => { });
        return;
      }
      if (!Number.isFinite(targetId)) {
        await ctx.answerCallbackQuery({ text: "救人目标无效。", show_alert: true }).catch(() => { });
        return;
      }
      const currentKillId = game.wolfKillId && game.wolfKillId !== NONE_ID ? game.wolfKillId : undefined;
      if (currentKillId === undefined) {
        await ctx.answerCallbackQuery({ text: "今晚没有可救目标。", show_alert: true }).catch(() => { });
        return;
      }
      if (targetId !== currentKillId) {
        await ctx.answerCallbackQuery({ text: "该救人按钮已过期，请使用当前夜晚面板。", show_alert: true }).catch(() => { });
        return;
      }
      const healTarget = game.players.get(targetId);
      if (!healTarget || !healTarget.isAlive) {
        await ctx.answerCallbackQuery({ text: "目标不存在或已死亡。", show_alert: true }).catch(() => { });
        return;
      }
      if (game.dayCount === 1 && targetId === userId) {
        await ctx.answerCallbackQuery({ text: "首夜不可自救，但你可以使用毒药。", show_alert: true }).catch(() => { });
        return;
      }

      game.nightHealIds.push(targetId);
      game.usedHealWitchIds.push(userId);

      if (!game.witchesActedThisNight.includes(userId)) game.witchesActedThisNight.push(userId);

      try {
        await ctx.answerCallbackQuery({ text: "你救活了他！" }).catch(() => { });

        const link = getGroupReturnLink(game);
        const returnKeyboard = new InlineKeyboard().url("🔙 返回群组", link);

        await ctx.api.editMessageText(userId, ctx.callbackQuery.message!.message_id, `💊 你救活了 <b>${game.players.get(targetId) ? getPName(game.players.get(targetId)!) : "未知"}</b>。`, {
          parse_mode: "HTML",
          reply_markup: returnKeyboard
        });
      } catch { }

      await checkNightPhaseCompletion(game);
      return;
    }

    // 女巫：毒人菜单
    if (data.startsWith("ww_witch_poison_menu_")) {
      const chatId = parseInt(data.replace("ww_witch_poison_menu_", ""));
      const game = activeGames.get(chatId);
      if (!game || game.phase !== "night") {
        await ctx.answerCallbackQuery({ text: "当前不是女巫行动时间。", show_alert: true }).catch(() => { });
        await retractCurrentCallbackButtons(ctx, game);
        return;
      }

      const witch = game.players.get(userId);
      if (!witch || witch.role !== "witch" || !witch.isAlive) {
        await ctx.answerCallbackQuery({ text: "你不是存活的女巫！", show_alert: true }).catch(() => { });
        return;
      }

      if (game.usedPoisonWitchIds.includes(userId)) {
        await ctx.answerCallbackQuery({ text: "你已经用过毒药了！", show_alert: true }).catch(() => { });
        return;
      }

      const alive = getAlivePlayers(game);
      const keyboard = new InlineKeyboard();
      alive.forEach(p => {
        keyboard.text(getPLabel(p), `ww_witch_poison_do_${chatId}_${p.id}`).row();
      });
      keyboard.text("🔙 返回", `ww_witch_back_${chatId}`).row();

      try {
        // 返回群组按钮
        const link = getGroupReturnLink(game);
        keyboard.row().url("🔙 返回群组", link);

        await ctx.answerCallbackQuery().catch(() => { });
        await ctx.api.editMessageText(userId, ctx.callbackQuery.message!.message_id, "🧪 请选择你要毒杀的目标：", { reply_markup: keyboard });
      } catch { }
      return;
    }

    // 女巫：执行毒人
    if (data.startsWith("ww_witch_poison_do_")) {
      const parts = data.split("_");
      const chatId = parseInt(parts[4]);
      const targetId = parseInt(parts[5]);

      const game = activeGames.get(chatId);
      if (!game || game.phase !== "night") {
        await ctx.answerCallbackQuery({ text: "当前不是女巫行动时间。", show_alert: true }).catch(() => { });
        await retractCurrentCallbackButtons(ctx, game);
        return;
      }

      const witch = game.players.get(userId);
      if (!witch || witch.role !== "witch" || !witch.isAlive) {
        await ctx.answerCallbackQuery({ text: "你不是存活的女巫！", show_alert: true }).catch(() => { });
        return;
      }

      if (game.usedPoisonWitchIds.includes(userId)) {
        await ctx.answerCallbackQuery({ text: "你已经用过毒药了！", show_alert: true }).catch(() => { });
        return;
      }
      if (!Number.isFinite(targetId)) {
        await ctx.answerCallbackQuery({ text: "毒杀目标无效。", show_alert: true }).catch(() => { });
        return;
      }
      const poisonTarget = game.players.get(targetId);
      if (!poisonTarget || !poisonTarget.isAlive) {
        await ctx.answerCallbackQuery({ text: "目标不存在或已死亡。", show_alert: true }).catch(() => { });
        return;
      }

      game.nightPoisonIds.push(targetId);
      game.usedPoisonWitchIds.push(userId);

      if (!game.witchesActedThisNight.includes(userId)) game.witchesActedThisNight.push(userId);

      try {
        await ctx.answerCallbackQuery({ text: "已执行毒杀！" }).catch(() => { });

        const link = getGroupReturnLink(game);
        const returnKeyboard = new InlineKeyboard().url("🔙 返回群组", link);

        const targetPlayer = game.players.get(targetId);
        await ctx.api.editMessageText(userId, ctx.callbackQuery.message!.message_id, `🧪 你毒杀了 <b>${targetPlayer ? getPName(targetPlayer) : "未知"}</b>。`, {
          parse_mode: "HTML",
          reply_markup: returnKeyboard
        });
      } catch { }

      await checkNightPhaseCompletion(game);
      return;
    }

    // 女巫：返回菜单
    if (data.startsWith("ww_witch_back_")) {
      const chatId = parseInt(data.replace("ww_witch_back_", ""));
      const game = activeGames.get(chatId);
      if (!game || game.phase !== "night") {
        await ctx.answerCallbackQuery({ text: "当前不是女巫行动时间。", show_alert: true }).catch(() => { });
        await retractCurrentCallbackButtons(ctx, game);
        return;
      }

      const witch = game.players.get(userId);
      await ctx.answerCallbackQuery().catch(() => { });
      if (witch && witch.role === "witch") await startWitchPhase(game, witch);
      return;
    }

    // 女巫：跳过/结束
    if (data.startsWith("ww_witch_skip_")) {
      const chatId = parseInt(data.replace("ww_witch_skip_", ""));
      const game = activeGames.get(chatId);
      if (!game || game.phase !== "night") {
        await ctx.answerCallbackQuery({ text: "当前不是女巫行动时间。", show_alert: true }).catch(() => { });
        await retractCurrentCallbackButtons(ctx, game);
        return;
      }

      const witch = game.players.get(userId);
      if (!witch || witch.role !== "witch" || !witch.isAlive) {
        await ctx.answerCallbackQuery({ text: "你不是存活的女巫！", show_alert: true }).catch(() => { });
        return;
      }

      if (!game.witchesActedThisNight.includes(userId)) game.witchesActedThisNight.push(userId);

      try {
        await ctx.answerCallbackQuery({ text: "已跳过本轮行动。" }).catch(() => { });

        const link = getGroupReturnLink(game);
        const returnKeyboard = new InlineKeyboard().url("🔙 返回群组", link);

        await ctx.api.editMessageText(userId, ctx.callbackQuery.message!.message_id, "🌙 你结束了今晚的行动。", {
          reply_markup: returnKeyboard
        });
      } catch { }

      await checkNightPhaseCompletion(game);
      return;
    }

    // If no werewolf callbacks match, explicitly call next()
    await next();
  });

  // ================= 死亡后发言管理 (一言禁言) =================
  bot.on("message", async (ctx, next) => {
    const userId = ctx.from.id;
    const game = activeGames.get(ctx.chat.id);

    // 1. 处理群组中的“一言禁言”
    if (game && (ctx.chat.type === "group" || ctx.chat.type === "supergroup")) {
      if (game.graceMessageRemainingIds.has(userId)) {
        game.graceMessageRemainingIds.delete(userId);

        // 发完这一句后，立即禁言
        try {
          const chatMember = await bot.api.getChatMember(game.chatId, userId);
          const isActuallyAdmin = ["administrator", "creator"].includes(chatMember.status);
          if (!isActuallyAdmin) {
            await bot.api.restrictChatMember(game.chatId, userId, {
              can_send_messages: false
            });
          }
        } catch (e) { }

        // 允许此条消息发送
        return await next();
      }
    }

    await next();
  });

  // /ww start 已全部合并至 bot.command("ww") 中处理
}
