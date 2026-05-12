import { Bot, Context, GrammyError, InlineKeyboard } from "grammy";
import { getUserName } from "./handlers";
import * as db from "./db";
// import { recordWerewolfPlayers, getWerewolfHistory } from "./db"; // Can extend if needed

export interface SpyPlayer {
  id: number;
  name: string;
  word: string;
  isSpy: boolean;
  isAlive: boolean;
  hasVoted: boolean;
  position: number;
}

export type SpyPhase = "lobby" | "description" | "voting" | "ended";

export interface SpyGame {
  chatId: number;
  phase: SpyPhase;
  players: Map<number, SpyPlayer>;
  spyWord: string;
  humanWord: string;
  currentTurnIndex: number; // For description phase
  turnOrder: number[]; // Array of player IDs
  votes: Map<number, number>; // voterId -> targetId
  lobbyMsgId?: number;
  mainMsgId?: number;
  groupMsgIds: number[]; // Track all group messages for cleanup
  roundNumber: number;
  descriptions: { round: number; playerId: number; text: string }[];
  creatorId: number;
  timeout?: NodeJS.Timeout;
}

const activeSpyGames = new Map<number, SpyGame>();

const WORD_PAIRS: [string, string][] = [
  // 基础 & 水果
  ["苹果", "梨子"], ["电脑", "笔记本"], ["医生", "护士"], ["老师", "教授"],
  ["玫瑰", "牡丹"], ["香蕉", "大蕉"], ["牛奶", "豆奶"], ["面包", "蛋糕"],
  ["足球", "篮球"], ["电影", "电视剧"], ["游泳", "潜水"], ["纸巾", "湿纸巾"],
  ["辣椒", "花椒"], ["咖啡", "茶"], ["月亮", "星星"], ["森林", "丛林"],
  ["手机", "平板"], ["猫", "狗"], ["大海", "河流"], ["太阳", "月亮"],
  ["雨伞", "雨衣"], ["桌子", "椅子"], ["钢笔", "铅笔"], ["眼镜", "隐形眼镜"],
  ["榴莲", "菠萝蜜"], ["柠檬", "青柠"], ["西瓜", "哈密瓜"], ["草莓", "桑葚"],
  ["火龙果", "仙人掌果"], ["葡萄", "提子"], ["柚子", "橙子"], ["山竹", "桂圆"],

  // 食物 & 饮品
  ["油条", "麻花"], ["包子", "饺子"], ["馒头", "花卷"], ["面条", "米粉"],
  ["汉堡", "三明治"], ["披萨", "馅饼"], ["炸鸡", "烤鸡"], ["牛排", "羊排"],
  ["火锅", "麻辣烫"], ["寿司", "饭团"], ["拉面", "打卤面"], ["混沌", "云吞"],
  ["可乐", "雪碧"], ["果汁", "奶昔"], ["红茶", "绿茶"], ["白酒", "啤酒"],
  ["香槟", "气泡酒"], ["冰激凌", "雪糕"], ["薯条", "薯片"], ["巧克力", "糖果"],
  ["爆米花", "棉花糖"], ["酸奶", "纯牛奶"], ["豆浆", "燕麦奶"], ["蜂蜜", "枫糖"],
  ["胡椒", "孜然"], ["芥末", "辣椒酱"], ["蚝油", "酱油"], ["食醋", "料酒"],

  // 生活用品 & 电器
  ["牙刷", "电动牙刷"], ["毛巾", "浴巾"], ["梳子", "发卡"], ["镜子", "透镜"],
  ["肥皂", "洗手液"], ["洗发水", "沐浴露"], ["洗衣粉", "柔顺剂"], ["地毯", "垫子"],
  ["窗帘", "遮光布"], ["枕头", "抱枕"], ["被子", "毯子"], ["床铺", "沙发"],
  ["电视", "投影仪"], ["冰箱", "冷柜"], ["洗衣机", "烘干机"], ["空调", "风扇"],
  ["微波炉", "烤箱"], ["电饭煲", "压力锅"], ["烧水壶", "咖啡机"], ["吸尘器", "扫地机"],
  ["吹风机", "卷发棒"], ["刮胡刀", "理发器"], ["手电筒", "台灯"], ["电池", "充电宝"],
  ["键盘", "鼠标"], ["打印机", "扫描仪"], ["耳机", "音箱"], ["相机", "摄像机"],

  // 服饰 & 美妆
  ["衬衫", "T恤"], ["牛仔裤", "休闲裤"], ["裙子", "短裤"], ["西装", "夹克"],
  ["大衣", "风衣"], ["毛衣", "卫衣"], ["内衣", "背心"], ["睡衣", "浴袍"],
  ["皮鞋", "运动鞋"], ["凉鞋", "拖鞋"], ["高跟鞋", "平底鞋"], ["靴子", "雨鞋"],
  ["帽子", "头盔"], ["围巾", "披肩"], ["手套", "袖套"], ["袜子", "丝袜"],
  ["领带", "领结"], ["腰带", "皮带"], ["书包", "手提包"], ["钱包", "卡包"],
  ["戒指", "耳环"], ["项链", "手链"], ["手表", "手镯"], ["香水", "古龙水"],
  ["口红", "唇彩"], ["粉底", "遮瑕"], ["睫毛膏", "眼线笔"], ["指甲油", "贴纸"],

  // 自然 & 景观
  ["高山", "丘陵"], ["平原", "盆地"], ["草原", "荒漠"], ["湿地", "沼泽"],
  ["瀑布", "小溪"], ["湖泊", "水库"], ["海洋", "海湾"], ["冰川", "冰山"],
  ["火山", "熔岩洞"], ["地震", "海啸"], ["台风", "飓风"], ["彩虹", "晚霞"],
  ["雷电", "轰鸣"], ["大雪", "冰雹"], ["大雨", "暴雨"], ["微风", "狂风"],
  ["春天", "秋天"], ["夏天", "冬天"], ["晨曦", "黄昏"], ["深夜", "黎明"],
  ["沙漠", "戈壁"], ["浮世", "红尘"], ["田野", "园林"], ["溶洞", "地道"],

  // 生物 & 动植物
  ["老虎", "狮子"], ["大象", "犀牛"], ["长颈鹿", "斑马"], ["熊猫", "考拉"],
  ["袋鼠", "鸵鸟"], ["河马", "鳄鱼"], ["猴子", "猩猩"], ["松鼠", "仓鼠"],
  ["老鼠", "蝙蝠"], ["兔子", "龙猫"], ["骏马", "驴子"], ["骆驼", "羊驼"],
  ["孔雀", "凤凰"], ["老鹰", "秃鹫"], ["鸽子", "麻雀"], ["天鹅", "鸭子"],
  ["企鹅", "海豹"], ["鲸鱼", "海豚"], ["鲨鱼", "章鱼"], ["螃蟹", "龙虾"],
  ["蜜蜂", "蝴蝶"], ["蜻蜓", "萤火虫"], ["蚊子", "苍蝇"], ["蚂蚁", "蜘蛛"],
  ["玫瑰", "月季"], ["向日葵", "菊花"], ["郁金香", "百合"], ["薰衣草", "薄荷"],
  ["松树", "柏树"], ["杨树", "柳树"], ["枫树", "银杏"], ["竹子", "甘蔗"],

  // 社会 & 职业
  ["警察", "特工"], ["军人", "保安"], ["医生", "药剂师"], ["教师", "辅导员"],
  ["律师", "法官"], ["记者", "编辑"], ["导游", "翻译"], ["厨师", "糕点师"],
  ["司机", "机长"], ["快递员", "外卖员"], ["清洁工", "修理工"], ["程序员", "测试员"],
  ["画家", "设计师"], ["歌手", "乐手"], ["演员", "模特"], ["诗人", "作家"],
  ["老板", "经理"], ["秘书", "助理"], ["会计", "审计"], ["销售", "客服"],
  ["农民", "渔民"], ["木工", "瓦工"], ["学生", "学霸"], ["邻居", "路人"],
  ["超市", "商场"], ["银行", "邮局"], ["电影院", "剧院"], ["图书馆", "书店"],
  ["公元", "史前"], ["古代", "现代"], ["中国", "外国"], ["城市", "乡村"],

  // 交通 & 科技
  ["自行车", "摩托车"], ["汽车", "公交车"], ["火车", "高铁"], ["飞机", "直升机"],
  ["轮船", "快艇"], ["潜艇", "航母"], ["火箭", "卫星"], ["坦克", "装甲车"],
  ["地铁", "轻轨"], ["索道", "电梯"], ["公路", "铁轨"], ["桥梁", "隧道"],
  ["互联网", "局域网"], ["宽带", "5G"], ["邮件", "短信"], ["电话", "视频"],
  ["软件", "硬件"], ["主板", "显卡"], ["屏幕", "显示器"], ["程序", "代码"],
  ["圆球", "方块"], ["直线", "曲线"], ["红色", "粉色"], ["蓝色", "青色"],
  ["绿色", "黄绿色"], ["黑色", "灰色"], ["白色", "米色"], ["紫色", "咖啡色"],

  // 抽象 & 情感
  ["梦想", "理想"], ["目标", "目的"], ["希望", "愿望"], ["机会", "机遇"],
  ["成功", "成就"], ["失败", "失误"], ["聪明", "智慧"], ["勇敢", "大胆"],
  ["快乐", "幸福"], ["悲伤", "痛苦"], ["愤怒", "生气"], ["害怕", "恐惧"],
  ["惊讶", "好奇"], ["尴尬", "羞愧"], ["骄傲", "自豪"], ["温柔", "体贴"],
  ["诚信", "信用"], ["善良", "仁慈"], ["公平", "正义"], ["自由", "自主"],
  ["青春", "童年"], ["老年", "晚年"], ["友谊", "亲情"], ["爱情", "恩情"],
  ["工作", "学业"], ["休闲", "运动"], ["旅游", "探险"], ["阅读", "写作"],
  ["记忆", "回忆"], ["风景", "美景"], ["规则", "法律"], ["道德", "品性"]
];

function esc(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function isSpyPrivateChatForbiddenError(error: unknown): boolean {
  if (!(error instanceof GrammyError)) return false;
  if (error.error_code !== 403) return false;
  const desc = String(error.description || error.message || "").toLowerCase();
  return desc.includes("bot can't initiate conversation with a user");
}

export function registerSpyHandlers(bot: Bot) {
  let botUsernamePromise: Promise<string> | null = null;

  async function getBotUsername(): Promise<string> {
    if (!botUsernamePromise) {
      botUsernamePromise = bot.api.getMe().then((me) => me.username);
    }
    return botUsernamePromise;
  }

  async function buildSpyPrivateStartKeyboard(): Promise<InlineKeyboard> {
    return new InlineKeyboard().url("🤖 启动私聊", `https://t.me/${await getBotUsername()}?start=spy`);
  }

  // ================= 私聊反馈 =================
  bot.command("start", async (ctx, next) => {
    if (ctx.chat.type !== "private") return await next();
    if (ctx.from?.id) db.markTelegramPrivateContact(ctx.from.id);
    if (ctx.match === "spy" || ctx.match === "wd") {
      await ctx.reply("👋 <b>“谁是卧底”私聊已连接！</b>\n\n当游戏开始后，我会在这里私发给你的词语。请关注此处的提示。", { parse_mode: "HTML" });
      return;
    }
    await next();
  });

  // ================= 辅助函数 =================

  const MIN_PLAYERS = 3;
  const MAX_PLAYERS = 6;

  const CIRCLED = ["", "①", "②", "③", "④", "⑤", "⑥"];

  function getAlivePlayers(game: SpyGame): SpyPlayer[] {
    return Array.from(game.players.values()).filter(p => p.isAlive);
  }

  function getPName(p: SpyPlayer): string {
    const prefix = p.position < CIRCLED.length ? CIRCLED[p.position] : `${p.position}.`;
    return `${prefix} ${esc(p.name)}`;
  }

  function getPBNo(p: SpyPlayer): string {
    return p.position < CIRCLED.length ? CIRCLED[p.position] : `${p.position}`;
  }

  function getMention(p: SpyPlayer): string {
    const prefix = p.position < CIRCLED.length ? CIRCLED[p.position] : `${p.position}.`;
    return `<a href="tg://user?id=${p.id}">${prefix} ${esc(p.name)}</a>`;
  }

  async function safeAnswer(ctx: Context, options?: string | Record<string, any>) {
    const payload = typeof options === "string" ? { text: options } : options;
    try {
      await ctx.answerCallbackQuery(payload);
    } catch (err: any) {
      const desc = String(err?.description || err?.message || "").toLowerCase();
      if (
        !desc.includes("query is too old") &&
        !desc.includes("response timeout expired") &&
        !desc.includes("query id is invalid")
      ) {
        console.warn("[Spy] answerCallbackQuery failed:", err?.message || err);
      }
    }
  }

  function getAliveTurnOrder(game: SpyGame): SpyPlayer[] {
    return game.turnOrder
      .map(id => game.players.get(id))
      .filter((p): p is SpyPlayer => !!p && p.isAlive);
  }

  function getDescriptionsText(game: SpyGame): string {
    if (game.descriptions.length === 0) return "";
    const roundGroups = new Map<number, string[]>();

    for (const entry of game.descriptions) {
      const p = game.players.get(entry.playerId);
      if (p) {
        if (!roundGroups.has(entry.round)) roundGroups.set(entry.round, []);
        roundGroups.get(entry.round)!.push(`${getPName(p)}: ${esc(entry.text)}`);
      }
    }

    const lines: string[] = [];
    const rounds = Array.from(roundGroups.keys()).sort((a, b) => a - b);
    for (const r of rounds) {
      lines.push(`<b>第 ${r} 轮：</b>`);
      lines.push(...roundGroups.get(r)!);
    }

    return lines.length > 0 ? `\n\n<b>往期描述：</b>\n${lines.join("\n")}` : "";
  }

  async function cleanupLobby(game: SpyGame) {
    if (game.lobbyMsgId) {
      try { await bot.api.deleteMessage(game.chatId, game.lobbyMsgId); } catch { }
    }
  }

  function clearSpyTimeout(game: SpyGame) {
    if (game.timeout) {
      clearTimeout(game.timeout);
      game.timeout = undefined;
    }
  }

  async function cleanupSpyMessages(game: SpyGame) {
    if (game.lobbyMsgId) {
      try { await bot.api.deleteMessage(game.chatId, game.lobbyMsgId); } catch { }
      game.lobbyMsgId = undefined;
    }
    for (const msgId of game.groupMsgIds) {
      try {
        await bot.api.deleteMessage(game.chatId, msgId);
      } catch (e) { }
    }
    game.groupMsgIds = [];
  }

  function checkWin(game: SpyGame): "humans" | "spy" | null {
    const alive = getAlivePlayers(game);
    const spyAlive = alive.some(p => p.isSpy);

    if (!spyAlive) return "humans";
    if (alive.length <= 2) return "spy"; // 剩下 2 个人且包含卧底，卧底胜
    return null;
  }

  // ================= 命令处理 =================

  bot.command("wd", async (ctx) => {
    if (!ctx.chat || ctx.chat.type === "private") {
      await ctx.reply("⚠️ 此命令仅在群组可用。");
      return;
    }

    const text = ctx.message?.text || "";
    const parts = text.split(/\s+/).slice(1);
    const sub = parts[0]?.toLowerCase();

    const chatId = ctx.chat.id;
    const userId = ctx.from!.id;

    // 终止逻辑
    if (sub === "stop") {
      const game = activeSpyGames.get(chatId);
      if (!game) {
        await ctx.reply("❌ 当前没有正在进行的“谁是卧底”游戏。");
        return;
      }

      // 权限检查：发起人或管理
      const admins = await ctx.api.getChatAdministrators(chatId);
      const isAdmin = admins.some(a => a.user.id === userId);
      const isCreator = userId === game.creatorId;

      if (!isAdmin && !isCreator) {
        await ctx.reply("🚫 只有游戏发起者或管理员可以强制停止游戏。");
        return;
      }

      clearSpyTimeout(game);
      await cleanupSpyMessages(game);
      activeSpyGames.delete(chatId);
      await ctx.reply("🛑 <b>“谁是卧底”游戏已被管理员/发起人强制结束。</b>", { parse_mode: "HTML" });
      return;
    }

    if (activeSpyGames.has(chatId)) {
      await ctx.reply("⏳ 已经有一个进行中的游戏了，可用 <code>/wd stop</code> 强制结束。", { parse_mode: "HTML" });
      return;
    }

    const creatorName = getUserName(ctx.from);

    const game: SpyGame = {
      chatId,
      phase: "lobby",
      players: new Map(),
      spyWord: "",
      humanWord: "",
      currentTurnIndex: 0,
      turnOrder: [],
      votes: new Map(),
      groupMsgIds: [],
      roundNumber: 1,
      descriptions: [],
      creatorId: userId
    };

    game.players.set(userId, {
      id: userId,
      name: creatorName,
      word: "",
      isSpy: false,
      isAlive: true,
      hasVoted: false,
      position: 1
    });

    const botUsername = await getBotUsername();
    const keyboard = new InlineKeyboard()
      .text("🤝 加入游戏", `spy_join_${chatId}`)
      .url("🤖 启动私聊", `https://t.me/${botUsername}?start=spy`).row()
      .text("🚀 开始游戏", `spy_start_${chatId}`)
      .text("🗑️ 关闭房间", `spy_close_${chatId}`);

    const playerList = Array.from(game.players.values()).map(p => getPName(p)).join(", ");
    const msg = await ctx.reply(
      `🕵️‍♂️ <b>谁是卧底！</b> 🕵️‍♂️\n\n` +
      `发起人：<b>${esc(creatorName)}</b>\n` +
      `当前人数：1 (需 ${MIN_PLAYERS}-${MAX_PLAYERS} 人)\n` +
      `玩家列表：${playerList}\n\n` +
      `大家请先点击“启动私聊”确保能收到词语，然后加入游戏！\n\n` +
      `💡 可用 <code>/wd stop</code> 随时停止游戏。`,
      {
        parse_mode: "HTML",
        reply_markup: keyboard,
        link_preview_options: { is_disabled: true }
      }
    );
    game.lobbyMsgId = msg.message_id;
    activeSpyGames.set(chatId, game);
  });

  // ================= 回调处理 =================

  bot.on("callback_query:data", async (ctx, next) => {
    const data = ctx.callbackQuery.data;
    if (!data.startsWith("spy_")) {
      await next();
      return;
    }

    const userId = ctx.from.id;
    const userName = getUserName(ctx.from);
    const parts = data.split("_");
    const action = parts[1];
    const chatId = parseInt(parts[2]);
    const game = activeSpyGames.get(chatId);

    if (!game) {
      await safeAnswer(ctx, { text: "这局游戏已经失效了。", show_alert: true });
      return;
    }

    // 加入
    if (action === "join") {
      if (game.phase !== "lobby") return;
      if (game.players.has(userId)) {
        await safeAnswer(ctx, { text: "你已经在房间里了。" });
        return;
      }
      if (game.players.size >= MAX_PLAYERS) {
        await safeAnswer(ctx, { text: `房间已满 (最多 ${MAX_PLAYERS} 人)。`, show_alert: true });
        return;
      }

      game.players.set(userId, {
        id: userId,
        name: userName,
        word: "",
        isSpy: false,
        isAlive: true,
        hasVoted: false,
        position: game.players.size + 1
      });

      const playerList = Array.from(game.players.values()).map(p => getPName(p)).join(", ");
      const botUsername = await getBotUsername();
      const keyboard = new InlineKeyboard()
        .text("🤝 加入游戏", `spy_join_${chatId}`)
        .url("🤖 启动私聊", `https://t.me/${botUsername}?start=spy`).row()
        .text("🚀 开始游戏", `spy_start_${chatId}`)
        .text("🗑️ 关闭房间", `spy_close_${chatId}`);

      await ctx.editMessageText(
        `🕵️‍♂️ <b>谁是卧底！</b> 🕵️‍♂️\n\n` +
        `当前人数：${game.players.size} (需 ${MIN_PLAYERS}-${MAX_PLAYERS} 人)\n` +
        `玩家列表：${playerList}\n\n` +
        `请确保已启动私聊！`,
        {
          parse_mode: "HTML",
          reply_markup: keyboard,
          link_preview_options: { is_disabled: true }
        }
      ).catch(() => { });
      await safeAnswer(ctx, { text: "成功加入！" });
    }

    // 关闭
    if (action === "close") {
      if (game.creatorId !== userId) {
        await safeAnswer(ctx, { text: "只有发起者能关闭房间。", show_alert: true });
        return;
      }
      clearSpyTimeout(game);
      await cleanupSpyMessages(game);
      activeSpyGames.delete(chatId);
      await ctx.editMessageText("🚪 <b>房间已由发起者关闭。</b>", { parse_mode: "HTML" }).catch(() => { });
    }

    // 开始
    if (action === "start") {
      if (game.creatorId !== userId) {
        await safeAnswer(ctx, { text: "只有发起者能开始游戏。", show_alert: true });
        return;
      }
      if (game.players.size < MIN_PLAYERS) {
        await safeAnswer(ctx, { text: `至少需要 ${MIN_PLAYERS} 人参与！`, show_alert: true });
        return;
      }
      if (game.players.size > MAX_PLAYERS) {
        await safeAnswer(ctx, { text: `人数超出限制 (最多 ${MAX_PLAYERS} 人)！`, show_alert: true });
        return;
      }

      // 分配词语
      const pair = WORD_PAIRS[Math.floor(Math.random() * WORD_PAIRS.length)];
      const isSwapped = Math.random() > 0.5;
      game.humanWord = isSwapped ? pair[1] : pair[0];
      game.spyWord = isSwapped ? pair[0] : pair[1];

      const playerArray = Array.from(game.players.values());
      const blockedPlayers = playerArray.filter((p) => !db.hasTelegramPrivateContact(p.id));
      if (blockedPlayers.length > 0) {
        await safeAnswer(ctx, { text: "有人还没启动私聊，暂时不能开始。", show_alert: true });
        await ctx.reply(
          `⚠️ 还有玩家没有先私聊机器人，当前不能开始游戏。\n\n请以下玩家先点击下方按钮完成私聊连接：\n${blockedPlayers.map((p) => getMention(p)).join("\n")}`,
          {
            parse_mode: "HTML",
            reply_markup: await buildSpyPrivateStartKeyboard(),
            link_preview_options: { is_disabled: true },
          }
        );
        return;
      }
      const spyIndex = Math.floor(Math.random() * playerArray.length);
      const spyId = playerArray[spyIndex].id;

      const failedPlayers: string[] = [];
      for (const p of playerArray) {
        p.isSpy = (p.id === spyId);
        p.word = p.isSpy ? game.spyWord : game.humanWord;

        try {
          const groupLink = chatId.toString().startsWith("-100")
            ? `https://t.me/c/${chatId.toString().slice(4)}/${game.lobbyMsgId}`
            : `tg://resolve?id=${Math.abs(chatId)}`;

          await bot.api.sendMessage(p.id,
            `🕵️‍♂️ 你的词语是：【<b>${p.word}</b>】\n\n请按顺序在群里进行描述，不要说出词语本身！`,
            { parse_mode: "HTML", reply_markup: new InlineKeyboard().url("🔙 返回群组", groupLink) }
          );
        } catch (e) {
          failedPlayers.push(getPName(p));
          if (isSpyPrivateChatForbiddenError(e)) {
            console.warn(`[Spy] 玩家未开启私聊，无法发送词语: ${p.id} ${p.name}`);
          } else {
            console.error(`[Spy] 无法给 ${p.name} 发送词语:`, e);
          }
        }
      }

      if (failedPlayers.length > 0) {
        await ctx.reply(
          `⚠️ 以下玩家还没有启动过与机器人的私聊，暂时无法接收词语：\n${failedPlayers.join("、")}\n\n本轮已取消，不会进入发言阶段。请这些玩家先点击下方“启动私聊”，再重新点击“开始游戏”。`,
          {
            parse_mode: "HTML",
            reply_markup: await buildSpyPrivateStartKeyboard(),
            link_preview_options: { is_disabled: true },
          }
        );
        return;
      }

      game.phase = "description";
      game.turnOrder = playerArray.map(p => p.id).sort(() => Math.random() - 0.5);
      game.currentTurnIndex = 0;

      await ctx.editMessageText("🎭 <b>游戏开始！词语已私发。</b>\n按顺序发言，简短一句话 (60s)。", { parse_mode: "HTML" }).catch(() => { });

      const turnOrder = getAliveTurnOrder(game);
      const firstPlayer = turnOrder[0];
      const descText = getDescriptionsText(game);
      await bot.api.sendMessage(game.chatId, `📢 请 <b>${getMention(firstPlayer)}</b> 描述，简短一句话 (60s)！${descText}`, { parse_mode: "HTML" })
        .then(m => game.groupMsgIds.push(m.message_id));
      startTurnTimeout(game);
    }

    // 投票逻辑
    if (action === "vote") {
      const targetId = parseInt(parts[3]);
      if (game.phase !== "voting") return;
      const voter = game.players.get(userId);
      if (!voter || !voter.isAlive) {
        await safeAnswer(ctx, { text: "你没在玩或者已经出局了。", show_alert: true });
        return;
      }
      if (targetId !== 0 && userId === targetId) {
        await safeAnswer(ctx, { text: "不能投给自己！", show_alert: true });
        return;
      }

      game.votes.set(userId, targetId);
      await safeAnswer(ctx, { text: "投票成功！" });

      // 更新投票状态消息
      await updateVoteMessage(game);

      // 检查是否全员投完
      const aliveCount = getAlivePlayers(game).length;
      if (game.votes.size === aliveCount) {
        await processVotingResult(game);
      }
    }
  });

  async function updateVoteMessage(game: SpyGame) {
    const alive = getAlivePlayers(game);
    const keyboard = new InlineKeyboard();
    const statusText: string[] = [];

    alive.forEach((p) => {
      const voteTargetId = game.votes.get(p.id);
      let voteStatus = "🕒 正在思考...";

      if (voteTargetId !== undefined) {
        if (voteTargetId === 0) {
          voteStatus = "🏳️ 弃票";
        } else {
          const target = game.players.get(voteTargetId);
          voteStatus = `🗳️ 投给 ${target ? getPName(target) : "未知"}`;
        }
      }

      statusText.push(`${getPName(p)}: ${voteStatus}`);
      keyboard.text(getPBNo(p), `spy_vote_${game.chatId}_${p.id}`);
      if ((statusText.length) % 5 === 0) keyboard.row();
    });

    if (alive.length % 5 !== 0) keyboard.row();
    keyboard.text("🏳️ 弃票", `spy_vote_${game.chatId}_0`);

    try {
      if (game.mainMsgId) {
        await bot.api.editMessageText(game.chatId, game.mainMsgId,
          `⚖️ <b>投票环节</b>\n请选择你认为的卧底：\n\n` + statusText.join("\n"),
          { parse_mode: "HTML", reply_markup: keyboard }
        );
      }
    } catch { }
  }

  async function processVotingResult(game: SpyGame) {
    if (game.phase !== "voting") return;
    clearSpyTimeout(game);

    const voteCounts = new Map<number, number>();
    game.votes.forEach(targetId => {
      if (targetId === 0) return; // 忽略弃票
      voteCounts.set(targetId, (voteCounts.get(targetId) || 0) + 1);
    });

    let maxVotes = 0;
    let candidates: number[] = [];
    voteCounts.forEach((count, id) => {
      if (count > maxVotes) {
        maxVotes = count;
        candidates = [id];
      } else if (count === maxVotes) {
        candidates.push(id);
      }
    });

    if (candidates.length === 0 || candidates.length > 1) {
      const msgText = candidates.length === 0 ? "⚖️ 全员弃票！本轮无人出局。" : "⚖️ 平票！本轮无人出局。";
      await bot.api.sendMessage(game.chatId, msgText)
        .then(m => game.groupMsgIds.push(m.message_id));

      // 继续下一轮
      game.phase = "description";
      game.currentTurnIndex = 0;
      game.votes.clear();
      game.roundNumber++;
      const turnOrder = getAliveTurnOrder(game);
      const nextPlayer = turnOrder[0];
      const descText = getDescriptionsText(game);
      await bot.api.sendMessage(game.chatId, `📢 请活着的玩家开始新一轮描述，简短一句话 (60s)!\n从 <b>${getMention(nextPlayer)}</b> 开始！${descText}`, { parse_mode: "HTML" })
        .then(m => game.groupMsgIds.push(m.message_id));
      startTurnTimeout(game);
      return;
    }

    const targetId = candidates[0];

    const target = game.players.get(targetId)!;
    target.isAlive = false;

    await bot.api.sendMessage(game.chatId, `💀 经过大家的审判，<b>${getPName(target)}</b> 最终出局！\n他是：【<b>${target.isSpy ? "卧底" : "平民"}</b>】`, { parse_mode: "HTML" })
      .then(m => game.groupMsgIds.push(m.message_id));

    const win = checkWin(game);
    if (win) {
      game.phase = "ended"; // 防止重复进入结算
      const resultText = win === "spy"
        ? `🏁 <b>游戏结束！卧底获胜！</b>\n\n卧底是：<b>${getPName(Array.from(game.players.values()).find(p => p.isSpy)!)}</b>\n词语分别是：[ ${game.humanWord} ] 和 [ ${game.spyWord} ]`
        : `🏁 <b>游戏结束！平民获胜！</b>\n\n卧底已被揪出：<b>${getPName(target)}</b>\n词语分别是：[ ${game.humanWord} ] 和 [ ${game.spyWord} ]`;

      await bot.api.sendMessage(game.chatId, resultText, { parse_mode: "HTML" });

      // 清理过程消息
      await cleanupSpyMessages(game);
      activeSpyGames.delete(game.chatId);
    } else {
      // 继续下一轮描述
      game.phase = "description";
      game.currentTurnIndex = 0;
      game.votes.clear();
      game.roundNumber++;
      const turnOrder = getAliveTurnOrder(game);
      const nextPlayer = turnOrder[0];
      const descText = getDescriptionsText(game);
      await bot.api.sendMessage(game.chatId, `📢 请活着的玩家开始新一轮描述，简短一句话 (60s)！\n从 <b>${getMention(nextPlayer)}</b> 开始！${descText}`, { parse_mode: "HTML" })
        .then(m => game.groupMsgIds.push(m.message_id));
      startTurnTimeout(game);
    }
  }

  // 描述阶段倒计时
  function startTurnTimeout(game: SpyGame) {
    clearSpyTimeout(game);
    const turnIndexAtStart = game.currentTurnIndex;
    game.timeout = setTimeout(async () => {
      if (game.phase !== "description") return;
      if (game.currentTurnIndex !== turnIndexAtStart) return;

      const turnOrder = getAliveTurnOrder(game);
      if (game.currentTurnIndex >= turnOrder.length) return;

      const currentPlayer = turnOrder[game.currentTurnIndex];

      await bot.api.sendMessage(game.chatId, `⏰ <b>${getPName(currentPlayer)}</b> 描述超时。`, { parse_mode: "HTML" })
        .then(m => game.groupMsgIds.push(m.message_id));

      game.descriptions.push({
        round: game.roundNumber,
        playerId: currentPlayer.id,
        text: "(超时)"
      });

      game.currentTurnIndex++;
      if (game.currentTurnIndex >= turnOrder.length) {
        await enterVotingPhase(game);
      } else {
        const nextPlayer = turnOrder[game.currentTurnIndex];
        const descText = getDescriptionsText(game);
        await bot.api.sendMessage(game.chatId, `📢 请 <b>${getMention(nextPlayer)}</b> 描述，简短一句话 (60s)！${descText}`, { parse_mode: "HTML" })
          .then(m => game.groupMsgIds.push(m.message_id));
        startTurnTimeout(game);
      }
    }, 60 * 1000);
  }

  // 进入投票
  async function enterVotingPhase(game: SpyGame) {
    clearSpyTimeout(game);
    game.phase = "voting";
    game.votes.clear();

    const alive = getAlivePlayers(game);
    const keyboard = new InlineKeyboard();
    const statusText: string[] = [];

    alive.forEach((p, idx) => {
      statusText.push(`${getPName(p)}: 🕒 正在思考...`);
      keyboard.text(getPBNo(p), `spy_vote_${game.chatId}_${p.id}`);
      if ((idx + 1) % 5 === 0) keyboard.row(); // 每行 5 个按钮，适配手机屏幕
    });

    if (alive.length % 5 !== 0) keyboard.row();
    keyboard.text("🏳️ 弃票", `spy_vote_${game.chatId}_0`);

    const msg = await bot.api.sendMessage(game.chatId, 
      `⚖️ <b>投票环节</b>\n请选择你认为的卧底：\n\n` + statusText.join("\n"), 
      { parse_mode: "HTML", reply_markup: keyboard }
    );
    game.mainMsgId = msg.message_id;
    game.groupMsgIds.push(msg.message_id);

    // 投票倒计时
    game.timeout = setTimeout(async () => {
      if (game.phase === "voting") {
        await bot.api.sendMessage(game.chatId, "⏰ 投票时间到！强制结算。")
          .then(m => game.groupMsgIds.push(m.message_id));
        await processVotingResult(game);
      }
    }, 60 * 1000);
  }

  // 监听消息用于描述
  bot.on("message:text", async (ctx, next) => {
    const chatId = ctx.chat.id;
    const game = activeSpyGames.get(chatId);
    if (!game || game.phase !== "description") {
      await next();
      return;
    }

    const userId = ctx.from.id;
    const turnOrder = getAliveTurnOrder(game);
    if (game.currentTurnIndex >= turnOrder.length) {
      await next();
      return;
    }
    const currentPlayer = turnOrder[game.currentTurnIndex];

    if (userId !== currentPlayer.id) {
      await next();
      return;
    }

    // 正确的描述
    clearSpyTimeout(game); // 停掉计时器
    game.descriptions.push({
      round: game.roundNumber,
      playerId: userId,
      text: ctx.message.text || ""
    });
    game.currentTurnIndex++;
    if (game.currentTurnIndex >= turnOrder.length) {
      await enterVotingPhase(game);
    } else {
      const nextPlayer = turnOrder[game.currentTurnIndex];
      const descText = getDescriptionsText(game);
      await bot.api.sendMessage(game.chatId, `📢 请 <b>${getMention(nextPlayer)}</b> 描述，简短一句话 (60s)！${descText}`, { parse_mode: "HTML" })
        .then(m => game.groupMsgIds.push(m.message_id));
      startTurnTimeout(game);
    }
  });

}
