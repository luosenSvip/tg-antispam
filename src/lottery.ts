import { Bot, Context } from "grammy";
import * as db from "./db";

// ==================== 帮助函数 ====================
// 获取管理员列表的函数与 handlers.ts 类似，为了简单起见，我们重新获取
async function checkIsAdmin(ctx: Context, chatId: number, userId: number): Promise<boolean> {
  try {
    const members = await ctx.api.getChatAdministrators(chatId);
    return members.some((m) => m.user.id === userId);
  } catch (error) {
    console.error("[Lottery] 获取管理员列表失败:", error);
    return false;
  }
}

function isSuperAdminUserId(userId?: number): boolean {
  const adminId = Number(process.env.ADMIN_USER_ID || 0);
  return !!userId && adminId > 0 && userId === adminId;
}

// 获取用户显示名 (全名)
function getUserFullName(from: any): string {
  if (!from) return "未知用户";
  let name = from.first_name || "";
  if (from.last_name) name += ` ${from.last_name}`;
  return name.trim() || String(from.id);
}

// 统一过滤和转义 HTML 文本
function esc(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

export interface LotteryPrize {
  name: string;
  count: number;
  pointsReward?: number;
}

function parsePointsPrizeValue(name: string): number {
  const compact = String(name || "").replace(/\s+/g, "").toLowerCase();
  const matched = compact.match(/^(?:积分|points?)(\d+)$/i) || compact.match(/^(\d+)(?:积分|points?)$/i);
  return matched ? Math.max(0, Math.floor(Number(matched[1] || 0))) : 0;
}

function hasPointsPrize(prizes: LotteryPrize[]): boolean {
  return prizes.some((prize) => Math.max(0, Math.floor(Number(prize.pointsReward || parsePointsPrizeValue(prize.name) || 0))) > 0);
}

function normalizePrizes(prizes: LotteryPrize[]): LotteryPrize[] {
  return prizes
    .map((prize) => {
      const name = String(prize.name || "").trim();
      const count = Math.max(0, Math.floor(Number(prize.count || 0)));
      const pointsReward = Math.max(0, Math.floor(Number(prize.pointsReward || parsePointsPrizeValue(name) || 0)));
      return {
        name,
        count,
        ...(pointsReward > 0 ? { pointsReward } : {}),
      };
    })
    .filter((prize) => prize.name && prize.count > 0);
}

function getPrizeDisplayName(prize: LotteryPrize | { name: string; pointsReward?: number }): string {
  const pointsReward = Math.max(0, Math.floor(Number(prize.pointsReward || 0)));
  if (pointsReward > 0) return `${pointsReward}积分`;
  return String(prize.name || "").trim();
}

async function getPointsPrizeLotteryDenyReason(ctx: Context, chatId: number, userId: number): Promise<string | null> {
  if (isSuperAdminUserId(userId)) return null;
  if (!db.isPointsEnabled(chatId)) {
    return "⚠️ 当前群组未开启积分系统，暂时不能创建积分奖品抽奖。";
  }
  const access = db.getCommercialChatAccess(chatId);
  if (!access?.subscriptionActive) {
    return "⚠️ 积分奖品抽奖属于订阅功能，请先绑定有效订阅并开启积分系统。";
  }
  if (access.ownerUserId === userId) return null;
  if (db.isPointsAdminUser(chatId, userId) && await checkIsAdmin(ctx, chatId, userId)) {
    return null;
  }
  return "⚠️ 积分奖品抽奖默认仅群组绑定的订阅用户可创建。绑定账号可使用 <code>/points admin add</code> 授权其他群管理员。";
}

// 解析多奖品格式: 奖品1*1,奖品2*2
function parsePrizes(input: string): LotteryPrize[] {
  return input.split(/[,，]/).map(item => {
    const parts = item.split('*');
    const name = parts[0].trim();
    const count = parts.length > 1 ? parseInt(parts[1]) : 1;
    const pointsReward = parsePointsPrizeValue(name);
    return {
      name,
      count: isNaN(count) ? 1 : count,
      ...(pointsReward > 0 ? { pointsReward } : {}),
    };
  }).filter(p => p.name);
}

export interface LotteryCreationSpec {
  prizes: LotteryPrize[];
  drawCondition: "manual" | "time" | "count";
  targetValue: string;
  descCondition: string;
  remark?: string;
  minActivity?: number;
  minPoints?: number;
}

export async function createLotteryFromSpec(ctx: Context, spec: LotteryCreationSpec): Promise<number> {
  if (!ctx.chat || ctx.chat.type === "private" || !ctx.from) {
    throw new Error("抽奖只能在群组中创建。");
  }

  const chatId = ctx.chat.id;
  const userId = ctx.from.id;
  const prizes = normalizePrizes(spec.prizes);
  const winnerCount = prizes.reduce((sum, p) => sum + p.count, 0);
  if (!prizes.length || winnerCount <= 0) {
    throw new Error("未检测到有效奖品或中奖人数。");
  }
  if (hasPointsPrize(prizes)) {
    const denyReason = await getPointsPrizeLotteryDenyReason(ctx, chatId, userId);
    if (denyReason) throw new Error(denyReason.replace(/<[^>]+>/g, ""));
  }

  const title = prizes.map(p => p.count > 1 ? `${p.name}*${p.count}` : p.name).join(", ");
  const prizesJson = JSON.stringify(prizes);
  const remark = String(spec.remark || "").trim();
  const minActivity = Math.max(0, Math.floor(spec.minActivity || 0));
  const minPoints = Math.max(0, Math.floor(spec.minPoints || 0));

  const lotteryId = db.createLottery(
    chatId,
    userId,
    title,
    winnerCount,
    prizesJson,
    spec.drawCondition,
    spec.targetValue,
    remark,
    minActivity,
    minPoints
  );

  let prizesListText = "";
  prizes.forEach(p => {
    prizesListText += `• ${esc(getPrizeDisplayName(p))} x ${p.count}\n`;
  });

  let announcement = `🎁 <b>群组抽奖活动</b> 🎁\n` +
    `👤 <b>发起人:</b> <a href="tg://user?id=${userId}">${esc(getUserFullName(ctx.from))}</a>\n\n` +
    `🎉 <b>奖品清单:</b>\n${prizesListText}\n` +
    `🎯 <b>中奖人数:</b> ${winnerCount} 人\n` +
    `⏰ <b>开奖条件:</b> ${esc(spec.descCondition)}`;

  if (minActivity > 0) {
    announcement += `\n📊 <b>活跃要求:</b> 最近10天发言满 ${minActivity} 条`;
  }
  if (minPoints > 0) {
    announcement += `\n💰 <b>积分要求:</b> 需扣除 <code>${minPoints}</code> 积分`;
  }
  if (hasPointsPrize(prizes)) {
    announcement += `\n🏦 <b>积分奖品:</b> 开奖后自动入账`;
  }
  if (remark) {
    announcement += `\n📝 <b>备注:</b> ${esc(remark)}`;
  }

  announcement += `\n\n👇 <i>点击下方按钮参与抽奖，必须设置名字且私聊过机器人才能参与！</i>`;

  const msg = await ctx.reply(announcement, {
    parse_mode: "HTML",
    reply_markup: {
      inline_keyboard: [
        [{ text: `🎁 参与抽奖 (0人)`, callback_data: `lottery_join:${lotteryId}` }],
        [{ text: `⚙️ 立即开奖 (本人)`, callback_data: `lottery_draw:${lotteryId}` }]
      ]
    }
  });

  db.updateLotteryMessageId(lotteryId, msg.message_id);

  try {
    await ctx.api.pinChatMessage(chatId, msg.message_id);
  } catch (e) {
    console.error("[Lottery] 置顶抽奖消息失败:", e);
    await ctx.reply("⚠️ 置顶抽奖消息失败，请确保机器人有置顶消息的权限。");
  }

  return lotteryId;
}

// 获取群组链接 (优先用户名，其次邀请链接)
async function getChatLink(bot: Bot, chatId: number): Promise<{ name: string; link: string }> {
  try {
    const chat = await bot.api.getChat(chatId);
    if ("title" in chat) {
      const name = chat.title || "原群组";
      let link = "";
      if (chat.username) {
        link = `https://t.me/${chat.username}`;
      } else if (chat.invite_link) {
        link = chat.invite_link;
      } else {
        // 兜底：尝试生成一个点击跳转 (仅限已在群内的用户)
        const cleanId = chatId.toString().replace("-100", "");
        link = `https://t.me/c/${cleanId}/1`;
      }
      return { name, link };
    }
  } catch (e) {
    console.error(`[Lottery] 获取群组信息失败 (${chatId}):`, e);
  }
  return { name: "原群组", link: "" };
}

// ==================== 抽奖开奖核心逻辑 ====================

// 防止并发开奖的锁
const drawingLocks = new Set<number>();

// 引导私聊消息的冷却 (防止 429)
const noticeCooldowns = new Map<number, number>(); // chatId -> timestamp
const NOTICE_COOLDOWN_MS = 10000;

async function sendTemporaryNotice(ctx: Context, chatId: number, htmlText: string, ttlMs: number = 20_000): Promise<void> {
  try {
    const notice = await ctx.api.sendMessage(chatId, htmlText, {
      parse_mode: "HTML",
      link_preview_options: { is_disabled: true },
    });
    setTimeout(async () => {
      try {
        await ctx.api.deleteMessage(chatId, notice.message_id);
      } catch {
      }
    }, ttlMs);
  } catch {
  }
}

type WinnerNotificationTask = {
  userId: number;
  htmlText: string;
};

async function notifyWinnersInBackground(bot: Bot, tasks: WinnerNotificationTask[]): Promise<void> {
  for (const task of tasks) {
    try {
      await bot.api.sendMessage(task.userId, task.htmlText, {
        parse_mode: "HTML",
        link_preview_options: { is_disabled: true },
      });
    } catch (e: any) {
      console.warn(`[Lottery] 私聊通知中奖者失败 (${task.userId}):`, e?.message || e);
    }
  }
}

/**
 * 安全地回应回调查询，忽略超时错误
 */
async function safeAnswer(ctx: Context, options?: string | Record<string, any>) {
  const payload =
    typeof options === "string"
      ? { text: options }
      : options;
  try {
    await ctx.answerCallbackQuery(payload);
  } catch (err: any) {
    const desc = String(err?.description || err?.message || "").toLowerCase();
    // 忽略超时或无效查询错误，不中断后续逻辑
    if (
      !desc.includes("query is too old") &&
      !desc.includes("response timeout expired") &&
      !desc.includes("query id is invalid")
    ) {
      console.warn("[Lottery] safeAnswer warning:", err?.message || err);
    }
  }
}

export async function performDraw(bot: Bot, lotteryId: number) {
  if (drawingLocks.has(lotteryId)) {
    console.log(`[Lottery] 抽奖 ${lotteryId} 已经在开奖中，忽略重复请求。`);
    return;
  }

  drawingLocks.add(lotteryId);
  try {
    console.log(`[Lottery] 开始为抽奖 ${lotteryId} 进行结算...`);
    const lottery = db.getLottery(lotteryId);
    if (!lottery || lottery.status !== "active") {
      console.log(`[Lottery] 抽奖结算中止: 状态为 ${lottery?.status || 'null'}`);
      return;
    }

    const participants = db.getLotteryParticipants(lotteryId);
    const totalJoined = participants.length;
    console.log(`[Lottery] 群组: ${lottery.chat_id}, 参与人数: ${totalJoined}`);

    // 1. 抽取中奖者
    let winners = [];
    if (totalJoined <= lottery.winner_count) {
      winners = [...participants];
    } else {
      // 随机打乱并抽取
      const shuffled = [...participants].sort(() => 0.5 - Math.random());
      winners = shuffled.slice(0, lottery.winner_count);
    }

    // 2. 标记抽奖结束
    console.log(`[Lottery] 正在标记抽奖已结束，删除置顶...`);
    db.finishLottery(lotteryId);

    // 取消置顶：如果失败说明没权限或没置顶，可忽略
    try {
      await bot.api.unpinChatMessage(lottery.chat_id, lottery.message_id);
    } catch (err: any) {
      console.warn(`[Lottery] 取消置顶原抽奖消息失败 (可能无权限):`, err.message);
    }

    // 修改原抽奖消息的状态
    try {
      await bot.api.editMessageText(
        lottery.chat_id,
        lottery.message_id,
        `🎁 <b>【已结束】抽奖: ${esc(lottery.title)}</b>\n\n🎯 中奖人数: ${lottery.winner_count} 人\n👥 参与人数: ${totalJoined} 人\n\n<i>抽奖已结束，开奖结果见最新消息。</i>`,
        { parse_mode: "HTML" }
      );
    } catch (e: any) {
      console.warn(`[Lottery] 编辑大厅消息失败 (可能重复点击或无权限):`, e.message);
    }

    // 3. 构建中奖者名单
    console.log(`[Lottery] 抽取成功，共 ${winners.length} 名中奖者，正在整理开奖结果...`);
    let winnersText = "";
    const winnerNotificationTasks: WinnerNotificationTask[] = [];
    let creditedPointsWinnerCount = 0;
    let pointsCreditFailedCount = 0;

    if (winners.length === 0) {
      winnersText = "没有人参与本次抽奖 🥲";
    } else {
      // 解析奖品并铺平
      let prizes: LotteryPrize[] = [];
      try {
        prizes = JSON.parse(lottery.prizes_json || "[]");
      } catch { }

      const flatPrizes = prizes.length > 0
        ? prizes.flatMap((p) => Array.from({ length: p.count }, () => ({
          name: p.name,
          pointsReward: Math.max(0, Math.floor(Number(p.pointsReward || parsePointsPrizeValue(p.name) || 0))),
        })))
        : Array.from({ length: lottery.winner_count }, () => ({
          name: lottery.title,
          pointsReward: parsePointsPrizeValue(lottery.title),
        }));

      const lines = [];
      const chatInfo = await getChatLink(bot, lottery.chat_id);
      const chatLink = chatInfo.link ? `【<a href="${chatInfo.link}">${esc(chatInfo.name)}</a>】` : `【<b>${esc(chatInfo.name)}</b>】`;

      for (let i = 0; i < winners.length; i++) {
        const w = winners[i];
        const prize = flatPrizes[i] || { name: lottery.title, pointsReward: parsePointsPrizeValue(lottery.title) };
        const prizeName = getPrizeDisplayName(prize);
        const prizePoints = Math.max(0, Math.floor(Number(prize.pointsReward || 0)));
        const msgCount = db.getUserMessageCountLast10Days(lottery.chat_id, Number(w.user_id));
        let warning = "";
        const threshold = lottery.min_activity > 0 ? lottery.min_activity : 5;
        if (msgCount < threshold) {
          warning = " ⚠️";
        }
        let autoCreditText = "";
        if (prizePoints > 0) {
          creditedPointsWinnerCount += 1;
          const credited = db.creditUserPoints(lottery.chat_id, Number(w.user_id), prizePoints, `中奖入账:${lottery.title}`);
          if (!credited) {
            pointsCreditFailedCount += 1;
            autoCreditText = "（积分入账失败）";
          }
        }
        lines.push(`• <a href="tg://user?id=${w.user_id}">${esc(w.fullname)}</a> - <b>${esc(prizeName)}</b>${autoCreditText}${warning}`);
        winnerNotificationTasks.push({
          userId: Number(w.user_id),
          htmlText: `🎉🎉 恭喜！你在群组 ${chatLink} 的抽奖 <b>[${esc(lottery.title)}]</b> 中奖了！\n\n🎁 你的奖品是：<b>${esc(prizeName)}</b>${prizePoints > 0 ? `\n🏦 奖励积分已自动入账：<code>+${prizePoints}</code>` : ""}`,
        });
      }
      winnersText = lines.join("\n");
    }

    // 获取发起人信息以显示显示名
    let creatorInfo = "";
    try {
      const member = await bot.api.getChatMember(lottery.chat_id, lottery.creator_id);
      creatorInfo = `\n👤 发起人: <a href="tg://user?id=${lottery.creator_id}">${esc(getUserFullName(member.user))}</a>    👥 参与人数: ${totalJoined} 人`;
    } catch (e) {
      creatorInfo = `\n👤 发起人: <code>${lottery.creator_id}</code>\n<i>👥 参与人数: ${totalJoined} 人</i>`;
    }

    // 4. 发送开奖结果并置顶
    let remarkText = "";
    if (lottery.remark) {
      remarkText = `\n\n📝 <b>备注:</b>\n${esc(lottery.remark)}`;
    }

    const pointsCreditNotice = creditedPointsWinnerCount > 0
      ? pointsCreditFailedCount > 0
        ? `\n\n<b>中奖积分已自动入账（其中 ${pointsCreditFailedCount} 人入账失败，请管理员核查）。</b>`
        : `\n\n<b>中奖积分已自动入账！</b>`
      : "";

    const resultMessageText = `🎉 <b>抽奖结束开奖啦！</b> 🎉${creatorInfo}\n\n🎯 <b>中奖名单:</b>\n${winnersText}${remarkText}${pointsCreditNotice}\n\n<b>说明：名单带⚠️为群组表现不活跃。</b>\n<i>恭喜以上中奖用户！具体奖品已标注。</i>`;

    console.log(`[Lottery] 正在群里发送开奖结果...`);
    try {
      const resultMsg = await bot.api.sendMessage(lottery.chat_id, resultMessageText, { parse_mode: "HTML" });
      try {
        await bot.api.pinChatMessage(lottery.chat_id, resultMsg.message_id);
      } catch (e: any) {
        console.warn(`[Lottery] 置顶开奖结果失败 (可能无权限):`, e.message);
      }
      if (winnerNotificationTasks.length > 0) {
        console.log(`[Lottery] 开奖主流程完成，后台通知 ${winnerNotificationTasks.length} 位中奖者...`);
        void notifyWinnersInBackground(bot, winnerNotificationTasks);
      }
    } catch (e: any) {
      console.error(`[Lottery] 发送开奖结果失败:`, e.message);
      throw e; // 如果大群通知失败，向上抛出以显示给点击按钮的管理员
    }
  } finally {
    drawingLocks.delete(lotteryId);
  }
}

// ==================== 注册 Handlers ====================
export function registerLotteryHandlers(bot: Bot): void {
  // --- 发起抽奖命令 ---
  bot.command("cj", async (ctx) => {
    if (!ctx.chat || ctx.chat.type === "private") {
      await ctx.reply("⚠️ 此命令仅在群组中可用。");
      return;
    }

    // 删除命令本身
    try {
      await ctx.deleteMessage();
    } catch { }

    const chatId = ctx.chat.id;
    const userId = ctx.from?.id;
    if (!userId) return;


    const text = ctx.message?.text || "";
    const parts = text.split(/\s+/).slice(1);

    if (parts.length < 1) {
      await ctx.reply(
        `<b>用法:</b> <code>/cj &lt;奖品*数量&gt; [开奖条件] [f/j要求] [备注]</code>\n\n` +
        `<b>示例:</b>\n` +
        `• 满人开奖: <code>/cj 苹果*1 10r</code> (10人开奖)\n` +
        `• 定时开奖: <code>/cj 键盘*2 2h</code> (2小时后开奖)\n` +
        `• 积分奖品: <code>/cj 积分30*4 f30 2h</code> (4个中奖名额，每人自动入账30积分)\n` +
        `• 活跃要求: <code>/cj 键盘*2 2h f10</code> (检测10条发言)\n` +
        `• 积分扣除: <code>/cj 键盘*2 2h j50</code> (扣除50积分)\n` +
        `• 组合模式: <code>/cj 键盘*2 2h f10 j10 记得领奖 </code>  (检测10条发言 + 扣除10积分)\n` +
        `• 多奖品: <code>/cj 苹果*1,华为*2 100r</code>`,
        { parse_mode: "HTML" }
      );
      return;
    }

    const prizes = parsePrizes(parts[0]);
    const winnerCount = prizes.reduce((sum, p) => sum + p.count, 0);
    const actualConditionStr = parts[1] || "";

    if (prizes.length === 0 || winnerCount <= 0) {
      await ctx.reply("⚠️ 未检测到有效奖品或人数。请务必使用 <code>苹果手机*1</code> 的格式！", { parse_mode: "HTML" });
      return;
    }
    if (hasPointsPrize(prizes)) {
      const denyReason = await getPointsPrizeLotteryDenyReason(ctx, chatId, userId);
      if (denyReason) {
        await ctx.reply(denyReason, { parse_mode: "HTML" });
        return;
      }
    }

    const title = prizes.map(p => p.count > 1 ? `${p.name}*${p.count}` : p.name).join(", ");
    const prizesJson = JSON.stringify(prizes);

    let drawCondition = "manual";
    let targetValue = "";
    let descCondition = "手动开奖（由发起人决定开奖时间）";
    let remark = "";
    let minActivity = 0;
    let minPoints = 0;

    // 支持顺序无关解析：
    // /cj 奖品*数量 [10r|2h] [f10] [j50] [备注...]
    // 例如：/cj 大阪*2 f10 2h 找我bot领奖
    const argTokens = parts.slice(1);
    const remarkTokens: string[] = [];
    let hasDrawCond = false;
    let hasActivityCond = false;
    let hasPointsCond = false;

    for (const tokenRaw of argTokens) {
      const token = tokenRaw.trim();
      if (!token) continue;

      if (!hasDrawCond && /^\d+[r人]$/i.test(token)) {
        drawCondition = "count";
        targetValue = token.replace(/[r人]/ig, "");
        descCondition = `满 ${targetValue} 人自动开奖`;
        hasDrawCond = true;
        continue;
      }

      if (!hasDrawCond && /^\d+[mhd]$/i.test(token)) {
        drawCondition = "time";
        const val = parseInt(token.substring(0, token.length - 1), 10);
        const unit = token.slice(-1).toLowerCase();
        let ms = val * 60 * 1000;
        if (unit === "h") ms = val * 60 * 60 * 1000;
        if (unit === "d") ms = val * 24 * 60 * 60 * 1000;

        const targetDate = new Date(Date.now() + ms);
        targetValue = targetDate.toISOString();
        const locDateStr = targetDate.toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" });
        descCondition = `于 ${locDateStr} 自动开奖`;
        hasDrawCond = true;
        continue;
      }

      const matchJ = token.match(/^j(\d+)$/i);
      if (matchJ && !hasPointsCond) {
        minPoints = parseInt(matchJ[1], 10);
        hasPointsCond = true;
        continue;
      }

      const matchF = token.match(/^f?(\d+)$/i);
      if (matchF && !hasActivityCond) {
        minActivity = parseInt(matchF[1], 10);
        hasActivityCond = true;
        continue;
      }

      // 无法识别或重复参数，统一归入备注
      remarkTokens.push(tokenRaw);
    }

    remark = remarkTokens.join(" ").trim();

    const lotteryId = db.createLottery(chatId, userId, title, winnerCount, prizesJson, drawCondition, targetValue, remark, minActivity, minPoints);

    let prizesListText = "";
    prizes.forEach(p => {
      prizesListText += `• ${esc(getPrizeDisplayName(p))} x ${p.count}\n`;
    });

    let announcement = `🎁 <b>群组抽奖活动</b> 🎁\n` +
      `👤 <b>发起人:</b> <a href="tg://user?id=${userId}">${esc(getUserFullName(ctx.from))}</a>\n\n` +
      `🎉 <b>奖品清单:</b>\n${prizesListText}\n` +
      `🎯 <b>中奖人数:</b> ${winnerCount} 人\n` +
      `⏰ <b>开奖条件:</b> ${esc(descCondition)}`;

    if (minActivity > 0) {
      announcement += `\n📊 <b>活跃要求:</b> 最近10天发言满 ${minActivity} 条`;
    }

    if (minPoints > 0) {
      announcement += `\n💰 <b>积分要求:</b> 需扣除 <code>${minPoints}</code> 积分`;
    }
    if (hasPointsPrize(prizes)) {
      announcement += `\n🏦 <b>积分奖品:</b> 开奖后自动入账`;
    }

    if (remark) {
      announcement += `\n📝 <b>备注:</b> ${esc(remark)}`;
    }

    announcement += `\n\n👇 <i>点击下方按钮参与抽奖，必须设置名字且私聊过机器人才能参与！</i>`;

    const msg = await ctx.reply(announcement, {
      parse_mode: "HTML",
      reply_markup: {
        inline_keyboard: [
          [{ text: `🎁 参与抽奖 (0人)`, callback_data: `lottery_join:${lotteryId}` }],
          [{ text: `⚙️ 立即开奖 (本人)`, callback_data: `lottery_draw:${lotteryId}` }]
        ]
      }
    });

    db.updateLotteryMessageId(lotteryId, msg.message_id);

    try {
      await ctx.api.pinChatMessage(chatId, msg.message_id);
    } catch (e) {
      console.error("[Lottery] 置顶抽奖消息失败:", e);
      await ctx.reply("⚠️ 置顶抽奖消息失败，请确保机器人有置顶消息的权限。");
    }
  });

  // --- 按钮回调处理 ---
  bot.on("callback_query:data", async (ctx, next) => {
    const data = ctx.callbackQuery.data;
    if (!data.startsWith("lottery_")) {
      await next();
      return;
    }

    // 1. 参与抽奖
    if (data.startsWith("lottery_join:")) {
      const lotteryIdStr = data.split(":")[1];
      const lotteryId = parseInt(lotteryIdStr);
      if (isNaN(lotteryId)) return;

      const lottery = db.getLottery(lotteryId);
      if (!lottery || lottery.status !== "active") {
        await safeAnswer(ctx, { text: "此抽奖已结束或不存在。", show_alert: true });
        return;
      }

      const userId = ctx.from.id;
      const username = ctx.from.username || "";
      const fullname = getUserFullName(ctx.from);

      if (!username && !fullname) {
        await safeAnswer(ctx, { text: "⚠️ 您必须设置名字才能参与抽奖！", show_alert: true });
        return;
      }

      // 如果已经参与过了
      if (db.getLotteryParticipants(lotteryId).some((participant) => participant.user_id === userId)) {
        await safeAnswer(ctx, { text: "您已经参与过本次抽奖啦！", show_alert: true });
        return;
      }

      // 检查活跃要求
      if (lottery.min_activity > 0) {
        const msgCount = db.getUserMessageCountLast10Days(lottery.chat_id, userId);
        if (msgCount < lottery.min_activity) {
          await safeAnswer(ctx, {
            text: `⚠️ 参与失败：本抽奖要求最近10天发言满 ${lottery.min_activity} 条，您当前仅有 ${msgCount} 条。`,
            show_alert: true
          });
          return;
        }
      }

      // 检查积分要求
      if (lottery.min_points > 0) {
        if (!db.isPointsEnabled(lottery.chat_id)) {
          await safeAnswer(ctx, {
            text: "⚠️ 当前群组未开启积分系统，无法参与积分抽奖。",
            show_alert: true
          });
          return;
        }
        const points = db.getUserPoints(lottery.chat_id, userId);
        if (points.total < lottery.min_points) {
          await safeAnswer(ctx, {
            text: `⚠️ 积分不足：参与本抽奖需要扣除 ${lottery.min_points} 积分，您当前只有 ${points.total} 积分。`,
            show_alert: true
          });
          return;
        }
      }

      await safeAnswer(ctx, "正在处理参与请求...");

      const chatTitle = ctx.chat!.title || "原群组";
      const chatLink = ctx.chat?.username
        ? `https://t.me/${ctx.chat.username}`
        : `https://t.me/c/${ctx.chat!.id.toString().replace("-100", "")}/1`;
      const userLink = `<a href="tg://user?id=${userId}">${esc(fullname)}</a>`;

      // 尝试私发消息以验证是否私聊过机器人
      let dmSuccess = false;
      try {
        await ctx.api.sendMessage(
          userId,
          `✅ <b>参与成功通知</b>\n\n你已成功参与群组 【<a href="${chatLink}">${esc(chatTitle)}</a>】 的抽奖 <b>[${esc(lottery.title)}]</b>！\n\n如果你中奖了，我在这里通知你。祝你好运！ 🍀`,
          { parse_mode: "HTML", link_preview_options: { is_disabled: true } }
        );
        dmSuccess = true;
      } catch (err: any) {
        // 如果是 bot 无法发起私聊等错误
        dmSuccess = false;
      }

      if (!dmSuccess) {
        // 在群内下发临时引导消息 (带冷却时间防止 429)
        const now = Date.now();
        const lastNotice = noticeCooldowns.get(lottery.chat_id) || 0;
        if (now - lastNotice > NOTICE_COOLDOWN_MS) {
          noticeCooldowns.set(lottery.chat_id, now);
          await sendTemporaryNotice(
            ctx,
            lottery.chat_id,
            `${userLink} ⚠️ 参与抽奖失败。请先点击 👉 <a href="t.me/${ctx.me.username}?start=lottery">前往私聊机器人</a>，点击“开始”激活机器人后，再回来点击参与！`
          );
        }

        return;
      }

      // DM 成功，计入参与名单
      // 如果有积分要求，先扣除
      if (lottery.min_points > 0) {
        const success = db.consumePoints(lottery.chat_id, userId, lottery.min_points, "群组抽奖");
        if (!success) {
          await sendTemporaryNotice(ctx, lottery.chat_id, `${userLink} ❌ 扣除积分失败，请检查账户余额后重试。`);
          return;
        }
      }

      const joined = db.joinLottery(lotteryId, userId, username, fullname);
      if (joined) {
        const count = db.getLotteryParticipantCount(lotteryId);

        // 更新按钮人数
        try {
          await ctx.api.editMessageReplyMarkup(lottery.chat_id, lottery.message_id, {
            reply_markup: {
              inline_keyboard: [
                [{ text: `🎁 参与抽奖 (${count}人)`, callback_data: `lottery_join:${lotteryId}` }],
                [{ text: `⚙️ 立即开奖 (本人)`, callback_data: `lottery_draw:${lotteryId}` }]
              ]
            }
          });
        } catch (e) {
          // 忽略消息未改变的报错
        }

        // 检查满人条件
        if (lottery.draw_condition === "count") {
          const target = parseInt(lottery.target_value);
          if (count >= target) {
            // 达到设定人数，立刻开奖
            await performDraw(bot, lotteryId);
          }
        }
      } else {
        if (lottery.min_points > 0) {
          db.creditUserPoints(lottery.chat_id, userId, lottery.min_points, `群组抽奖重复参与回退:${lottery.title}`);
        }
        await sendTemporaryNotice(ctx, lottery.chat_id, `${userLink} ℹ️ 你已经参与过本次抽奖啦。`);
      }
      return;
    }

    // 2. 立即开奖
    if (data.startsWith("lottery_draw:")) {
      console.log(`[Lottery] 收到立即开奖回调: ${data}`);
      const lotteryIdStr = data.split(":")[1];
      const lotteryId = parseInt(lotteryIdStr);
      if (isNaN(lotteryId)) {
        console.error(`[Lottery] 无效的 lotteryId: ${lotteryIdStr}`);
        return;
      }

      const lottery = db.getLottery(lotteryId);
      if (!lottery || lottery.status !== "active") {
        console.log(`[Lottery] 抽奖已不存在或已结束: ${lotteryId}`);
        await safeAnswer(ctx, { text: "此抽奖已结束或不存在。", show_alert: true });
        return;
      }

      const userId = ctx.from.id;
      // 检查权限：允许发起人或群管理员点击
      const isAdminUser = await checkIsAdmin(ctx, lottery.chat_id, userId);
      const isCreator = (Number(userId) === Number(lottery.creator_id));

      console.log(`[Lottery] 开奖权限检查 - 用户: ${userId}, 发起人: ${lottery.creator_id}, 是否管理员: ${isAdminUser}, 是否发起人: ${isCreator}`);

      if (!isCreator && !isAdminUser) {
        await safeAnswer(ctx, { text: "🚫 只有抽奖发起人或管理员可以手动开奖。", show_alert: true });
        return;
      }

      try {
        await safeAnswer(ctx, { text: "正在开奖，请稍候..." });
        await performDraw(bot, lotteryId);
      } catch (err: any) {
        console.error("[Lottery] 手动开奖失败:", err);
        await ctx.api.sendMessage(lottery.chat_id, `❌ 开奖过程发生错误: ${err.message}`);
      }
      return;
    }

    // Explicitly call next() to let other handlers (like anti-spam) process their callbacks
    await next();
  });
}
