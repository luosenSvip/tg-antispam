import { Bot, GrammyError, InlineKeyboard } from "grammy";
import cron from "node-cron";
import * as db from "./db";
import { performDraw } from "./lottery";
import { ackZjmfExpiryNoticeBatch, fetchTgGuardMeta, pullZjmfExpiryNoticeBatches, syncTgGuardStatuses } from "./zjmf";

const UNVERIFIED_TIMEOUT_MINUTES = 2;
const REJOIN_COOLDOWN_MINUTES = 5;
const SUBSCRIPTION_EXPIRY_REMINDER_DAYS = 5;
const ZJMF_EXPIRY_NOTICE_PULL_LIMIT = 100;

function getCommercialConsoleUrl(): string {
  const raw = String(process.env.WEB_BASE_URL || "").trim();
  if (raw) return `${raw.replace(/\/$/, "")}/console`;
  return "https://bs.zi.us.ci/console";
}

function esc(text: string): string {
  return String(text || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function getChinaDateKey(nowMs: number = Date.now()): string {
  return new Date(nowMs + 8 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

function getChinaDayNumber(nowMs: number = Date.now()): number {
  return Math.floor((nowMs + 8 * 60 * 60 * 1000) / (24 * 60 * 60 * 1000));
}

function shouldRunGuardSync(lastRunAt: number, intervalValue: number, intervalUnit: string, nowMs: number = Date.now()): boolean {
  const safeValue = Math.max(1, Math.floor(intervalValue || 1));
  const unit = ["minute", "hour", "day", "week"].includes(intervalUnit) ? intervalUnit : "minute";
  const unitMs = unit === "minute" ? 60_000 : unit === "hour" ? 3_600_000 : unit === "day" ? 86_400_000 : 604_800_000;
  return nowMs - lastRunAt >= safeValue * unitMs;
}

function formatSubscriptionExpiryLeadText(endsAt: string, nowMs: number = Date.now()): string {
  const days = Math.max(0, getChinaDayNumber(new Date(`${String(endsAt || "").trim()}Z`).getTime()) - getChinaDayNumber(nowMs));
  if (days <= 0) return "将于今天到期";
  return `将于 ${days} 天后到期`;
}

function formatChinaDateTime(timestampSeconds: number): string {
  const ts = Math.floor(Number(timestampSeconds) || 0);
  if (ts <= 0) return "-";
  try {
    return new Date(ts * 1000).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", hour12: false });
  } catch {
    return "-";
  }
}

function isPrivateChatForbiddenError(error: unknown): boolean {
  if (!(error instanceof GrammyError)) return false;
  if (error.error_code !== 403) return false;
  const desc = String(error.description || error.message || "").toLowerCase();
  return (
    desc.includes("bot can't initiate conversation with a user") ||
    desc.includes("bot was blocked by the user")
  );
}

export function startCronJobs(bot: Bot) {
  const adminIdStr = process.env.ADMIN_USER_ID;
  const adminId = Number(adminIdStr || 0);
  let lastGuardSyncAt = 0;
  let guardSyncRunning = false;
  let expiryNoticeRunning = false;

  if (adminId > 0) {
    // 每天北京时间 08:00 触发
    cron.schedule("0 8 * * *", async () => {
      try {
        console.log("[Cron] 正在生成每日拦截汇总...");
        const stats = db.getGlobalDailyStats();

        if (stats.details.length === 0) {
          await bot.api.sendMessage(adminId, "📊 <b>每日汇总</b>\n\n过去 24 小时没有任何拦截记录。", { parse_mode: "HTML" });
          return;
        }

        await bot.api.sendMessage(adminId, `📊 <b>每日拦截汇总</b>\n\n过去 24 小时共拦截 <b>${stats.totalSpanned}</b> 次垃圾广告或违规发言。以下为各群组明细：`, { parse_mode: "HTML" });

        for (const group of stats.details) {
          let groupName = String(group.chatId);
          try {
            const chat = await bot.api.getChat(group.chatId);
            if (chat && 'title' in chat && chat.title) {
              groupName = chat.title;
            }
          } catch (e) {
            // 忽略获取群组名称失败的错误
          }

          const text = [
            `📝 <b>群组：</b> ${esc(groupName)}`,
            `💳 ID：<code>${group.chatId}</code>`,
            `🚨 拦截次数：<b>${group.count}</b>`
          ].join("\n");

          await bot.api.sendMessage(adminId, text, { parse_mode: "HTML" });

          // 稍微延时，防止触发 TG API 发送限制
          await new Promise(resolve => setTimeout(resolve, 300));
        }
      } catch (e) {
        console.error("[Cron] 发送每日汇总任务失败:", e);
      }
    }, {
      timezone: "Asia/Shanghai"
    });
  } else {
    console.log("[Cron] 未设置 ADMIN_USER_ID，跳过每日汇总任务。");
  }

  cron.schedule("0 10 * * *", async () => {
    try {
      const consoleUrl = getCommercialConsoleUrl();
      const targets = db.listCommercialChatsWithExpiringSubscriptions(SUBSCRIPTION_EXPIRY_REMINDER_DAYS);
      const remindDate = getChinaDateKey();
      const nowMs = Date.now();

      for (const target of targets) {
        const leadText = formatSubscriptionExpiryLeadText(target.ends_at, nowMs);
        const chatLabel = target.chat_type === "channel" ? "本频道" : "本群";
        const ownerName = target.owner_display_name || target.owner_username || String(target.owner_user_id);
        const text = [
          `⏰ <b>订阅到期提醒</b>`,
          "",
          `${chatLabel}绑定的订阅 <b>${esc(target.plan_code || "pro")}</b> ${leadText}。`,
          `到期时间: <code>${esc(target.ends_at)}</code>`,
          `绑定账号: <code>${target.owner_user_id}</code> (${esc(ownerName)})`,
          "",
          `请尽快私聊机器人发送 <code>/console</code> 进入订阅控制台续费，避免群内高级功能中断。`,
        ].join("\n");

        try {
          await bot.api.sendMessage(target.chat_id, text, {
            parse_mode: "HTML",
            reply_markup: new InlineKeyboard().url("订阅控制台", consoleUrl),
          });
          db.markCommercialSubscriptionExpiryReminder(target.chat_id, target.subscription_id, remindDate);
        } catch (error) {
          console.error(`[Cron] 发送订阅到期提醒失败: chat=${target.chat_id} sub=${target.subscription_id}`, error);
        }

        await new Promise(resolve => setTimeout(resolve, 300));
      }

      const expiredTargets = db.listCommercialChatsWithExpiredSubscriptionsNeedingReminder();
      for (const target of expiredTargets) {
        const ownerName = target.owner_display_name || target.owner_username || String(target.owner_user_id);
        const chatLabel = target.chat_type === "channel" ? "本频道" : "本群";
        const text = [
          `🚨 <b>订阅已到期</b>`,
          "",
          `${chatLabel}绑定的订阅 <b>${esc(target.plan_code || "pro")}</b> 已到期。`,
          `到期时间: <code>${esc(target.ends_at)}</code>`,
          `绑定账号: <code>${target.owner_user_id}</code> (${esc(ownerName)})`,
          "",
          `请尽快进入订阅控制台续费，否则本群高级功能将保持停用。`,
        ].join("\n");

        try {
          await bot.api.sendMessage(target.chat_id, text, {
            parse_mode: "HTML",
            reply_markup: new InlineKeyboard().url("立即续费", consoleUrl),
          });
          db.markCommercialSubscriptionExpiryReminder(target.chat_id, target.subscription_id, "expired_once");
        } catch (error) {
          console.error(`[Cron] 发送订阅已到期提醒失败: chat=${target.chat_id} sub=${target.subscription_id}`, error);
        }

        await new Promise(resolve => setTimeout(resolve, 300));
      }
    } catch (error) {
      console.error("[Cron] 处理订阅到期提醒失败:", error);
    }
  }, {
    timezone: "Asia/Shanghai"
  });

  cron.schedule("* * * * *", async () => {
    if (expiryNoticeRunning) return;
    expiryNoticeRunning = true;
    try {
      const batches = await pullZjmfExpiryNoticeBatches(ZJMF_EXPIRY_NOTICE_PULL_LIMIT);
      for (const batch of batches) {
        try {
          for (let index = 0; index < batch.reminders.length; index++) {
            const target = batch.reminders[index];
            const maxLines = 8;
            const hostLines = target.hosts.slice(0, maxLines).map((host) => {
              const productLabel = esc(host.productName || "VPS");
              const ipLabel = esc(host.dedicatedIp || "-");
              const deviceNo = esc(host.domain || `Host#${host.hostId}`);
              const dueDate = esc(formatChinaDateTime(host.nextDueDate));
              return [
                `• <b>${productLabel}</b>`,
                `• IP: <code>${ipLabel}</code>`,
                `• 设备号: <code>${deviceNo}</code>`,
                `• 到期: <code>${dueDate}</code>`,
              ].join("\n");
            }).join("\n\n");
            const remainCount = target.hosts.length - Math.min(target.hosts.length, maxLines);
            const tail = remainCount > 0 ? `\n… 还有 <b>${remainCount}</b> 台未展示` : "";
            const displayName = target.tgNickname || target.tgUsername || target.clientUsername || target.clientEmail || String(target.tgUserId);

            const text = [
              `⏰ <b>VPS 到期提醒</b>`,
              "",
              `${esc(displayName)}，你有 <b>${target.hosts.length}</b> 台 VPS 将于 <b>${Math.max(1, Math.floor(batch.leadDays || 5))} 天后</b>到期。`,
              "",
              hostLines + tail,
              "",
              "请尽快前往官网续费，避免服务中断。",
            ].join("\n");

            let sentOk = false;
            try {
              await bot.api.sendMessage(target.tgUserId, text, {
                parse_mode: "HTML",
                link_preview_options: { is_disabled: true },
              });
              db.markTelegramPrivateContact(target.tgUserId);
              sentOk = true;
            } catch (error) {
              if (isPrivateChatForbiddenError(error)) {
                console.warn(`[Cron] 跳过 VPS 到期 TG 提醒: tgUser=${target.tgUserId} client=${target.clientId}，用户未私聊或已屏蔽机器人`);
              } else {
                console.error(`[Cron] 发送 VPS 到期 TG 提醒失败: tgUser=${target.tgUserId} client=${target.clientId}`, error);
              }
            }

            const isLastInSlice = index === batch.reminders.length - 1;
            const shouldDone = !batch.hasMore && isLastInSlice;

            try {
              let acked = false;
              const ackPayload = {
                success: true,
                processedCount: 1,
                successCount: sentOk ? 1 : 0,
                failedCount: sentOk ? 0 : 1,
                successTargets: sentOk ? [{ clientId: target.clientId, tgUserId: target.tgUserId }] : [],
                failedTargets: sentOk ? [] : [{ clientId: target.clientId, tgUserId: target.tgUserId }],
                done: shouldDone,
                message: sentOk ? "发送并确认完成" : "发送失败，已记录为失败",
              };
              for (let retry = 0; retry < 3 && !acked; retry++) {
                try {
                  await ackZjmfExpiryNoticeBatch(
                    { endpoint: batch.endpoint, token: batch.token, batchId: batch.batchId },
                    ackPayload
                  );
                  acked = true;
                } catch (retryError) {
                  if (retry >= 2) throw retryError;
                  await new Promise(resolve => setTimeout(resolve, 250));
                }
              }
            } catch (ackError) {
              console.error(`[Cron] VPS 到期单条回执失败: batch=${batch.batchId} tgUser=${target.tgUserId}`, ackError);
            }

            await new Promise(resolve => setTimeout(resolve, 250));
          }
        } catch (error: any) {
          console.error(`[Cron] 处理 VPS 到期批次失败: batch=${batch.batchId}`, error);
          try {
            await ackZjmfExpiryNoticeBatch(
              { endpoint: batch.endpoint, token: batch.token, batchId: batch.batchId },
              {
                success: false,
                message: `发送分片异常: ${String(error?.message || error || "unknown error")}`.slice(0, 240),
              }
            );
          } catch (ackError) {
            console.error(`[Cron] VPS 到期批次失败回执异常: batch=${batch.batchId}`, ackError);
          }
        }
      }
    } catch (error) {
      console.error("[Cron] 处理 VPS 到期 TG 提醒失败:", error);
    } finally {
      expiryNoticeRunning = false;
    }
  });

  // 每分钟检查一次定时抽奖，以及未验证入群用户超时
  cron.schedule("* * * * *", async () => {
    try {
      // 1. 定时抽奖检查
      const activeLotteries = db.getActiveLotteries();
      const now = new Date();
      
      for (const lottery of activeLotteries) {
        if (lottery.draw_condition === "time" && lottery.target_value) {
          const targetTime = new Date(lottery.target_value);
          if (now >= targetTime) {
            console.log(`[Cron] 自动开奖: ${lottery.title} (ID: ${lottery.id})`);
            await performDraw(bot, lottery.id);
          }
        }
      }

      // 2. 未验证入群用户超时检查
      const expiredMembers = db.getExpiredUnverifiedMembers(UNVERIFIED_TIMEOUT_MINUTES);
      for (const member of expiredMembers) {
        console.log(`[Cron] 准入验证超时，准备临时封禁 ${REJOIN_COOLDOWN_MINUTES} 分钟: ${member.user_id} (群: ${member.chat_id})`);
        try {
          // 超时后临时封禁，限制其在冷却期内重新申请/入群
          const untilDate = Math.floor(Date.now() / 1000) + REJOIN_COOLDOWN_MINUTES * 60;
          await bot.api.banChatMember(member.chat_id, member.user_id, { until_date: untilDate });
          
          // 删除欢迎消息
          if (member.welcome_msg_id) {
            await bot.api.deleteMessage(member.chat_id, member.welcome_msg_id).catch(() => {});
          }
        } catch (e: any) {
          const desc = String(e?.description || e?.message || "").toLowerCase();
          const isUnavailable = desc.includes("chat not found") || desc.includes("bot was kicked") || desc.includes("not a member") || desc.includes("forbidden") || desc.includes("not enough rights");
          if (isUnavailable) {
            console.warn(`[Cron] 群组不可用或权限不足，自动关闭所有开关: ${member.chat_id}`);
            db.closeAllGroupSwitches(member.chat_id);
            // 清除该群所有待验证用户
            const allPending = db.getExpiredUnverifiedMembers(0).filter(m => m.chat_id === member.chat_id);
            for (const m of allPending) {
              db.removeUnverifiedMember(m.chat_id, m.user_id);
            }
          } else {
            console.error(`[Cron] 处理超时用户失败: ${member.user_id}`, e);
          }
        } finally {
          db.removeUnverifiedMember(member.chat_id, member.user_id);
        }
      }

    } catch (e) {
      console.error("[Cron] 每分钟定时任务检查失败:", e);
    }
  });

  cron.schedule("* * * * *", async () => {
    if (guardSyncRunning) {
      console.warn("[Cron] TG 守护同步仍在执行中，跳过本轮。");
      return;
    }
    guardSyncRunning = true;
    try {
      const meta = await fetchTgGuardMeta();
      const forceRunAtMs = Math.max(0, Math.floor(Number(meta.forceRunAt || 0) * 1000));
      const forceRunPending = forceRunAtMs > lastGuardSyncAt;
      if (!meta.enabled || !meta.groupId) {
        if (forceRunPending) {
          console.warn(`[Cron] TG 守护手动触发已收到，但守护未启用或群组ID为空，已跳过。enabled=${meta.enabled ? 1 : 0} groupId=${meta.groupId || "-"}`);
        }
        return;
      }
      if (!forceRunPending && !meta.bindings.length) {
        return;
      }
      if (!forceRunPending && !shouldRunGuardSync(lastGuardSyncAt, meta.intervalValue, meta.intervalUnit)) {
        return;
      }
      const groupId = Number(meta.groupId || 0);
      if (!Number.isFinite(groupId) || groupId === 0) {
        if (forceRunPending) {
          console.warn(`[Cron] TG 守护手动触发已收到，但群组ID无效: ${meta.groupId}`);
        }
        return;
      }
      console.log(`[Cron] TG 守护开始: force=${forceRunPending ? 1 : 0}, bindings=${meta.bindings.length}, group=${groupId}`);
      const items: Array<{ clientId: number; tgUserId: number; member: boolean; statusText: string; message: string; checkedAt: number }> = [];
      for (const binding of meta.bindings) {
        const checkedAt = Math.floor(Date.now() / 1000);
        if ((binding.tgUserId || 0) <= 0) {
          items.push({
            clientId: binding.clientId,
            tgUserId: 0,
            member: false,
            statusText: "not_bound",
            message: "用户未绑定 TG 账号，按不在群组处理",
            checkedAt,
          });
          continue;
        }
        try {
          const member = await bot.api.getChatMember(groupId, binding.tgUserId);
          const statusText = String((member as any)?.status || "unknown").trim() || "unknown";
          items.push({
            clientId: binding.clientId,
            tgUserId: binding.tgUserId,
            member: !["left", "kicked"].includes(statusText),
            statusText,
            message: !["left", "kicked"].includes(statusText) ? "用户仍在群内" : "用户已退群或不在群内",
            checkedAt,
          });
        } catch (error: any) {
          const text = String(error?.description || error?.message || error || "getChatMember 失败");
          items.push({
            clientId: binding.clientId,
            tgUserId: binding.tgUserId,
            member: false,
            statusText: "request_failed",
            message: text.slice(0, 250),
            checkedAt,
          });
        }
        await new Promise(resolve => setTimeout(resolve, 150));
      }
      if (items.length || forceRunPending) {
        await syncTgGuardStatuses(items, meta.syncConfig, {
          forceRunAt: forceRunPending ? Math.floor(forceRunAtMs / 1000) : 0,
          runTasksNow: forceRunPending,
        });
        console.log(`[Cron] TG 守护完成: checked=${items.length}, force=${forceRunPending ? 1 : 0}`);
        lastGuardSyncAt = Date.now();
      }
    } catch (error) {
      console.error("[Cron] TG 守护同步失败:", error);
    } finally {
      guardSyncRunning = false;
    }
  });
}
