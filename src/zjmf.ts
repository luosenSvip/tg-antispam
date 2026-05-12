import axios from "axios";
import * as db from "./db";
import type { CommercialPointsMallConfig, CommercialPointsMallItem } from "./db";

export interface ZjmfProductOption {
  id: number;
  name: string;
  gid: number;
}

export interface ZjmfCatalog {
  configured: boolean;
  endpoint: string;
  products: ZjmfProductOption[];
  cycles: Record<string, string>;
  promoTypes: Array<{ value: string; label: string }>;
}

export interface ZjmfCreatedPromoResult {
  exchangeNo: string;
  promoId: number;
  promoCode: string;
  redeemStatus: string;
  promoExpirationTime: string;
}

export interface ZjmfIntegrationConfig {
  provider?: string;
  apiUrl?: string;
  apiToken?: string;
}

export interface GuardBindingMeta {
  clientId: number;
  tgUserId: number;
}

export interface GuardMetaPayload {
  enabled: boolean;
  groupId: string;
  intervalValue: number;
  intervalUnit: string;
  forceRunAt: number;
  bindings: GuardBindingMeta[];
  syncConfig: GuardSyncConfig | null;
}

export interface ZjmfExpiryReminderHost {
  hostId: number;
  productName: string;
  domain: string;
  dedicatedIp: string;
  domainStatus: string;
  billingCycle: string;
  nextDueDate: number;
}

export interface ZjmfExpiryReminderTarget {
  clientId: number;
  tgUserId: number;
  tgUsername: string;
  tgNickname: string;
  clientUsername: string;
  clientEmail: string;
  hosts: ZjmfExpiryReminderHost[];
}

interface GuardSyncConfig {
  chatId: number;
  endpoint: string;
  token: string;
}

function resolveIntegrationConfig(input?: ZjmfIntegrationConfig): { provider: string; endpoint: string; token: string } {
  const provider = String(input?.provider || "zjmf").trim() || "zjmf";
  const endpoint = String(input?.apiUrl || "").trim().replace(/\/$/, "");
  const token = String(input?.apiToken || "").trim();
  return { provider, endpoint, token };
}

function normalizeGuardConfig(config: CommercialPointsMallConfig): GuardSyncConfig {
  return {
    chatId: Math.floor(Number(config.chat_id) || 0),
    endpoint: String(config.custom_api_url || "").trim().replace(/\/$/, ""),
    token: String(config.custom_api_token || "").trim(),
  };
}

function getGuardSyncConfigs(): GuardSyncConfig[] {
  const listConfigs = (db as any).listPointsMallConfigs as undefined | (() => CommercialPointsMallConfig[]);
  return (listConfigs ? listConfigs() : [])
    .map(normalizeGuardConfig)
    .filter((item: GuardSyncConfig) => item.chatId !== 0 && !!item.endpoint && !!item.token);
}

export function getZjmfIntegrationStatus(input?: ZjmfIntegrationConfig): { configured: boolean; endpoint: string; message: string; provider: string } {
  const { provider, endpoint, token } = resolveIntegrationConfig(input);
  if (provider === "off") {
    return {
      configured: false,
      endpoint,
      provider,
      message: "当前群组已关闭积分商城接口",
    };
  }
  if (provider !== "zjmf") {
    return {
      configured: false,
      endpoint,
      provider,
      message: `暂不支持接口类型: ${provider}`,
    };
  }
  if (!endpoint || !token) {
    return {
      configured: false,
      endpoint,
      provider,
      message: "请先在积分商城页面配置接口地址和密令",
    };
  }
  return {
    configured: true,
    endpoint,
    provider,
    message: "已配置魔方积分商城接口",
  };
}

function getAuthHeaders(token: string): Record<string, string> {
  return token
    ? {
        Authorization: `Bearer ${token}`,
        "X-TG-Points-Token": token,
      }
    : {};
}

function buildApiUrl(base: string, action: "meta" | "create_promo" | "expiry_reminders" | "expiry_notify_pull" | "expiry_notify_ack"): string {
  return `${base}/${action}`;
}

function buildGuardApiUrl(base: string, action: "guard_meta" | "guard_sync"): string {
  return `${base}/${action}`;
}

async function requestGuardMeta(config: GuardSyncConfig): Promise<GuardMetaPayload> {
  const response = await axios.get(buildGuardApiUrl(config.endpoint, "guard_meta"), {
    headers: getAuthHeaders(config.token),
    timeout: 15000,
  });
  const payload = response.data || {};
  if (Number(payload.status || 0) !== 200 || !payload.data) {
    throw new Error(String(payload.msg || payload.error || "获取 TG 守护配置失败"));
  }
  return {
    enabled: payload.data.enabled === true,
    groupId: String(payload.data.groupId || "").trim(),
    intervalValue: Math.max(1, Math.floor(Number(payload.data.intervalValue) || 15)),
    intervalUnit: ["minute", "hour", "day", "week"].includes(String(payload.data.intervalUnit || "")) ? String(payload.data.intervalUnit || "minute") : "minute",
    forceRunAt: Math.max(0, Math.floor(Number(payload.data.forceRunAt) || 0)),
    bindings: Array.isArray(payload.data.bindings)
      ? payload.data.bindings
          .map((item: any) => ({ clientId: Math.floor(Number(item?.clientId) || 0), tgUserId: Math.floor(Number(item?.tgUserId) || 0) }))
          .filter((item: GuardBindingMeta) => item.clientId > 0)
      : [],
    syncConfig: config,
  };
}

function parseExpiryReminderTargets(input: any): ZjmfExpiryReminderTarget[] {
  if (!Array.isArray(input)) return [];
  return input
    .map((item: any) => ({
      clientId: Math.max(0, Math.floor(Number(item?.clientId) || 0)),
      tgUserId: Math.max(0, Math.floor(Number(item?.tgUserId) || 0)),
      tgUsername: String(item?.tgUsername || "").trim(),
      tgNickname: String(item?.tgNickname || "").trim(),
      clientUsername: String(item?.clientUsername || "").trim(),
      clientEmail: String(item?.clientEmail || "").trim(),
      hosts: Array.isArray(item?.hosts)
        ? item.hosts
            .map((host: any) => ({
              hostId: Math.max(0, Math.floor(Number(host?.hostId) || 0)),
              productName: String(host?.productName || "").trim(),
              domain: String(host?.domain || "").trim(),
              dedicatedIp: String(host?.dedicatedIp || host?.dedicated_ip || "").trim(),
              domainStatus: String(host?.domainStatus || "").trim(),
              billingCycle: String(host?.billingCycle || "").trim(),
              nextDueDate: Math.max(0, Math.floor(Number(host?.nextDueDate) || 0)),
            }))
            .filter((host: ZjmfExpiryReminderHost) => host.hostId > 0)
        : [],
    }))
    .filter((item: ZjmfExpiryReminderTarget) => item.clientId > 0 && item.tgUserId > 0 && item.hosts.length > 0);
}

async function requestExpiryReminders(config: GuardSyncConfig, leadDays: number): Promise<ZjmfExpiryReminderTarget[]> {
  const response = await axios.get(buildApiUrl(config.endpoint, "expiry_reminders"), {
    headers: getAuthHeaders(config.token),
    params: { days: Math.max(1, Math.floor(leadDays || 5)) },
    timeout: 20000,
  });
  const payload = response.data || {};
  if (Number(payload.status || 0) !== 200) {
    throw new Error(String(payload.msg || payload.error || "获取到期提醒数据失败"));
  }
  return parseExpiryReminderTargets(payload.data?.reminders);
}

async function requestExpiryNotifyPull(
  config: GuardSyncConfig,
  limit: number
): Promise<{
  batchId: number;
  noticeDate: string;
  leadDays: number;
  cursor: number;
  nextCursor: number;
  totalCount: number;
  successCount: number;
  failedCount: number;
  hasMore: boolean;
  reminders: ZjmfExpiryReminderTarget[];
}> {
  const response = await axios.get(buildApiUrl(config.endpoint, "expiry_notify_pull"), {
    headers: getAuthHeaders(config.token),
    params: { limit: Math.max(1, Math.floor(limit || 100)) },
    timeout: 20000,
  });
  const payload = response.data || {};
  if (Number(payload.status || 0) !== 200) {
    throw new Error(String(payload.msg || payload.error || "获取到期提醒批次失败"));
  }
  return {
    batchId: Math.max(0, Math.floor(Number(payload.data?.batchId) || 0)),
    noticeDate: String(payload.data?.noticeDate || "").trim(),
    leadDays: Math.max(1, Math.floor(Number(payload.data?.leadDays) || 5)),
    cursor: Math.max(0, Math.floor(Number(payload.data?.cursor) || 0)),
    nextCursor: Math.max(0, Math.floor(Number(payload.data?.nextCursor) || 0)),
    totalCount: Math.max(0, Math.floor(Number(payload.data?.totalCount) || 0)),
    successCount: Math.max(0, Math.floor(Number(payload.data?.successCount) || 0)),
    failedCount: Math.max(0, Math.floor(Number(payload.data?.failedCount) || 0)),
    hasMore: payload.data?.hasMore === true,
    reminders: parseExpiryReminderTargets(payload.data?.reminders),
  };
}

async function requestExpiryNotifyAck(
  config: GuardSyncConfig,
  ackPayload: {
    batchId: number;
    success: boolean;
    message?: string;
    processedCount?: number;
    successCount?: number;
    failedCount?: number;
    done?: boolean;
    successTargets?: Array<{ clientId: number; tgUserId: number }>;
    failedTargets?: Array<{ clientId: number; tgUserId: number }>;
  }
): Promise<void> {
  const response = await axios.post(
    buildApiUrl(config.endpoint, "expiry_notify_ack"),
    {
      batchId: Math.max(0, Math.floor(Number(ackPayload.batchId) || 0)),
      success: ackPayload.success ? 1 : 0,
      message: String(ackPayload.message || "").trim().slice(0, 250),
      processedCount: Math.max(0, Math.floor(Number(ackPayload.processedCount) || 0)),
      successCount: Math.max(0, Math.floor(Number(ackPayload.successCount) || 0)),
      failedCount: Math.max(0, Math.floor(Number(ackPayload.failedCount) || 0)),
      done: ackPayload.done ? 1 : 0,
      successTargets: Array.isArray(ackPayload.successTargets)
        ? ackPayload.successTargets
            .map((item) => ({
              clientId: Math.max(0, Math.floor(Number(item?.clientId) || 0)),
              tgUserId: Math.max(0, Math.floor(Number(item?.tgUserId) || 0)),
            }))
            .filter((item) => item.clientId > 0 && item.tgUserId > 0)
        : [],
      failedTargets: Array.isArray(ackPayload.failedTargets)
        ? ackPayload.failedTargets
            .map((item) => ({
              clientId: Math.max(0, Math.floor(Number(item?.clientId) || 0)),
              tgUserId: Math.max(0, Math.floor(Number(item?.tgUserId) || 0)),
            }))
            .filter((item) => item.clientId > 0 && item.tgUserId > 0)
        : [],
    },
    {
      headers: {
        "Content-Type": "application/json",
        ...getAuthHeaders(config.token),
      },
      timeout: 15000,
    }
  );
  const responsePayload = response.data || {};
  if (Number(responsePayload.status || 0) !== 200) {
    throw new Error(String(responsePayload.msg || responsePayload.error || "确认到期提醒批次失败"));
  }
}

function getUniqueZjmfConfigs(): GuardSyncConfig[] {
  const map = new Map<string, GuardSyncConfig>();
  for (const item of getGuardSyncConfigs()) {
    const key = `${item.endpoint}|${item.token}`;
    if (!map.has(key)) map.set(key, item);
  }
  return Array.from(map.values());
}

const catalogCache = new Map<string, { expiresAt: number; data: ZjmfCatalog }>();

export async function fetchZjmfCatalog(config?: ZjmfIntegrationConfig, force: boolean = false): Promise<ZjmfCatalog> {
  const status = getZjmfIntegrationStatus(config);
  if (!status.configured) {
    return {
      configured: false,
      endpoint: status.endpoint,
      products: [],
      cycles: {},
      promoTypes: [],
    };
  }
  const resolved = resolveIntegrationConfig(config);
  const cacheKey = `${resolved.provider}|${resolved.endpoint}|${resolved.token}`;
  const cached = catalogCache.get(cacheKey) || null;
  if (!force && cached && cached.expiresAt > Date.now()) {
    return cached.data;
  }

  const response = await axios.get(buildApiUrl(resolved.endpoint, "meta"), {
    headers: getAuthHeaders(resolved.token),
    timeout: 15000,
  });
  const payload = response.data || {};
  if (Number(payload.status || 0) !== 200) {
    throw new Error(String(payload.msg || payload.error || "获取魔方商品目录失败"));
  }

  const data: ZjmfCatalog = {
    configured: true,
    endpoint: status.endpoint,
    products: Array.isArray(payload.data?.products)
      ? payload.data.products.map((item: any) => ({
          id: Math.floor(Number(item?.id) || 0),
          name: String(item?.name || "").trim(),
          gid: Math.floor(Number(item?.gid) || 0),
        })).filter((item: ZjmfProductOption) => item.id > 0 && !!item.name)
      : [],
    cycles: payload.data?.cycles && typeof payload.data.cycles === "object" ? payload.data.cycles : {},
    promoTypes: Array.isArray(payload.data?.promoTypes)
      ? payload.data.promoTypes
          .map((item: any) => ({ value: String(item?.value || ""), label: String(item?.label || "") }))
          .filter((item: { value: string; label: string }) => !!item.value)
      : [],
  };

  catalogCache.set(cacheKey, { expiresAt: Date.now() + 60_000, data });
  return data;
}

export async function createZjmfPromoFromPointsMall(payload: {
  chatId: number;
  userId: number;
  username?: string;
  displayName?: string;
  item: CommercialPointsMallItem;
  pointsCost: number;
  integration?: ZjmfIntegrationConfig;
}): Promise<ZjmfCreatedPromoResult> {
  const status = getZjmfIntegrationStatus(payload.integration);
  if (!status.configured) {
    throw new Error(status.message);
  }
  const resolved = resolveIntegrationConfig(payload.integration);
  const promoWindow = db.resolvePointsMallPromoWindow(payload.item);

  const response = await axios.post(
    buildApiUrl(resolved.endpoint, "create_promo"),
    {
      chatId: Math.floor(Number(payload.chatId) || 0),
      userId: Math.floor(Number(payload.userId) || 0),
      username: String(payload.username || "").trim(),
      displayName: String(payload.displayName || "").trim(),
      pointsCost: Math.max(0, Math.floor(Number(payload.pointsCost) || 0)),
      item: {
        id: Math.floor(Number(payload.item.id) || 0),
        sourceProductId: Math.floor(Number(payload.item.source_product_id) || 0),
        title: String(payload.item.title || "").trim(),
        description: String(payload.item.description || "").trim(),
        promoScene: String(payload.item.promo_scene || "purchase").trim(),
        promoType: String(payload.item.promo_type || "percent"),
        promoValue: Number(payload.item.promo_value || 0),
        promoCycles: payload.item.promo_cycles || [],
        promoAppliesTo: payload.item.promo_appliesto || [],
        promoRequires: payload.item.promo_requires || [],
        promoRecurring: Number(payload.item.promo_recurring || 0) !== 0,
        promoRecurfor: Math.max(0, Number(payload.item.promo_recurfor || 0)),
        promoRequiresExist: Number(payload.item.promo_requires_exist || 0) !== 0,
        promoMaxTimes: Math.max(0, Number(payload.item.promo_max_times || 0)),
        promoLifelong: Number(payload.item.promo_lifelong || 0) !== 0,
        promoOneTime: Number(payload.item.promo_one_time || 0) !== 0,
        promoOnlyNewClient: Number(payload.item.promo_only_new_client || 0) !== 0,
        promoOnlyOldClient: Number(payload.item.promo_only_old_client || 0) !== 0,
        promoOncePerClient: Number(payload.item.promo_once_per_client || 0) !== 0,
        promoStartTime: promoWindow.promoStartTime,
        promoExpirationTime: promoWindow.promoExpirationTime,
        promoNotes: String(payload.item.promo_notes || "").trim(),
      },
    },
    {
      headers: {
        "Content-Type": "application/json",
        ...getAuthHeaders(resolved.token),
      },
      timeout: 15000,
    }
  );

  const data = response.data || {};
  if (Number(data.status || 0) !== 200 || !data.data) {
    throw new Error(String(data.msg || data.error || "创建魔方优惠码失败"));
  }

  return {
    exchangeNo: String(data.data.exchangeNo || "").trim(),
    promoId: Math.max(0, Math.floor(Number(data.data.promoId) || 0)),
    promoCode: String(data.data.promoCode || "").trim(),
    redeemStatus: String(data.data.redeemStatus || "issued").trim() || "issued",
    promoExpirationTime: String(promoWindow.promoExpirationTime || "").trim(),
  };
}

export async function fetchTgGuardMeta(): Promise<GuardMetaPayload> {
  const candidates = getGuardSyncConfigs();
  if (!candidates.length) {
    return { enabled: false, groupId: "", intervalValue: 15, intervalUnit: "minute", forceRunAt: 0, bindings: [], syncConfig: null };
  }

  const successes: GuardMetaPayload[] = [];
  let lastError: Error | null = null;

  for (const candidate of candidates) {
    try {
      successes.push(await requestGuardMeta(candidate));
    } catch (error: any) {
      lastError = error instanceof Error ? error : new Error(String(error || "获取 TG 守护配置失败"));
    }
  }

  if (!successes.length) {
    throw lastError || new Error("获取 TG 守护配置失败");
  }

  const enabledMatched = successes.find((item) => item.enabled && item.syncConfig && Number(item.groupId || 0) === item.syncConfig.chatId);
  const enabledOnly = successes.find((item) => item.enabled);
  const matched = successes.find((item) => item.syncConfig && Number(item.groupId || 0) === item.syncConfig.chatId);
  return enabledMatched || enabledOnly || matched || successes[0];
}

export async function fetchZjmfExpiryReminders(leadDays: number = 5): Promise<ZjmfExpiryReminderTarget[]> {
  const candidates = getUniqueZjmfConfigs();
  if (!candidates.length) return [];

  const merged = new Map<string, ZjmfExpiryReminderTarget>();
  for (const candidate of candidates) {
    let list: ZjmfExpiryReminderTarget[] = [];
    try {
      list = await requestExpiryReminders(candidate, leadDays);
    } catch (error: any) {
      console.warn(`[Zjmf] 获取到期提醒失败: ${candidate.endpoint}`, String(error?.message || error || "unknown error"));
      continue;
    }

    for (const item of list) {
      const key = `${item.clientId}:${item.tgUserId}`;
      const exists = merged.get(key);
      if (!exists) {
        merged.set(key, {
          ...item,
          hosts: [...item.hosts],
        });
        continue;
      }
      const hostMap = new Map<number, ZjmfExpiryReminderHost>();
      for (const host of exists.hosts) {
        hostMap.set(host.hostId, host);
      }
      for (const host of item.hosts) {
        if (!hostMap.has(host.hostId)) {
          hostMap.set(host.hostId, host);
        }
      }
      exists.hosts = Array.from(hostMap.values()).sort((a, b) => a.nextDueDate - b.nextDueDate || a.hostId - b.hostId);
      merged.set(key, exists);
    }
  }

  return Array.from(merged.values()).sort((a, b) => a.tgUserId - b.tgUserId || a.clientId - b.clientId);
}

export interface ZjmfExpiryNoticeBatch {
  endpoint: string;
  token: string;
  batchId: number;
  noticeDate: string;
  leadDays: number;
  cursor: number;
  nextCursor: number;
  totalCount: number;
  successCount: number;
  failedCount: number;
  hasMore: boolean;
  reminders: ZjmfExpiryReminderTarget[];
}

export async function pullZjmfExpiryNoticeBatches(limit: number = 100): Promise<ZjmfExpiryNoticeBatch[]> {
  const candidates = getUniqueZjmfConfigs();
  if (!candidates.length) return [];

  const safeLimit = Math.max(1, Math.min(500, Math.floor(Number(limit) || 100)));

  const batches: ZjmfExpiryNoticeBatch[] = [];
  for (const candidate of candidates) {
    try {
      const data = await requestExpiryNotifyPull(candidate, safeLimit);
      if (data.batchId <= 0 || !data.reminders.length) {
        continue;
      }
      batches.push({
        endpoint: candidate.endpoint,
        token: candidate.token,
        batchId: data.batchId,
        noticeDate: data.noticeDate,
        leadDays: data.leadDays,
        cursor: data.cursor,
        nextCursor: data.nextCursor,
        totalCount: data.totalCount,
        successCount: data.successCount,
        failedCount: data.failedCount,
        hasMore: data.hasMore,
        reminders: data.reminders,
      });
    } catch (error: any) {
      console.warn(`[Zjmf] 拉取到期提醒批次失败: ${candidate.endpoint}`, String(error?.message || error || "unknown error"));
    }
  }

  return batches;
}

export async function ackZjmfExpiryNoticeBatch(
  batch: { endpoint: string; token: string; batchId: number },
  payload: {
    success: boolean;
    message?: string;
    processedCount?: number;
    successCount?: number;
    failedCount?: number;
    done?: boolean;
    successTargets?: Array<{ clientId: number; tgUserId: number }>;
    failedTargets?: Array<{ clientId: number; tgUserId: number }>;
  }
): Promise<void> {
  const endpoint = String(batch?.endpoint || "").trim().replace(/\/$/, "");
  const token = String(batch?.token || "").trim();
  const batchId = Math.max(0, Math.floor(Number(batch?.batchId) || 0));
  if (!endpoint || !token || batchId <= 0) {
    throw new Error("到期提醒批次回执参数无效");
  }
  await requestExpiryNotifyAck(
    { chatId: 0, endpoint, token },
    {
      batchId,
      success: payload.success === true,
      message: String(payload.message || ""),
      processedCount: Math.max(0, Math.floor(Number(payload.processedCount) || 0)),
      successCount: Math.max(0, Math.floor(Number(payload.successCount) || 0)),
      failedCount: Math.max(0, Math.floor(Number(payload.failedCount) || 0)),
      done: payload.done === true,
      successTargets: Array.isArray(payload.successTargets) ? payload.successTargets : [],
      failedTargets: Array.isArray(payload.failedTargets) ? payload.failedTargets : [],
    }
  );
}

export async function syncTgGuardStatuses(
  items: Array<{ clientId: number; tgUserId: number; member: boolean; statusText: string; message: string; checkedAt: number }>,
  config?: GuardSyncConfig | null,
  options?: { forceRunAt?: number; runTasksNow?: boolean }
): Promise<void> {
  const resolved = config && config.endpoint && config.token ? config : null;
  if (!resolved) {
    return;
  }
  const response = await axios.post(
    buildGuardApiUrl(resolved.endpoint, "guard_sync"),
    {
      items,
      forceRunAt: Math.max(0, Math.floor(Number(options?.forceRunAt) || 0)),
      runTasksNow: options?.runTasksNow === true,
    },
    {
      headers: {
        "Content-Type": "application/json",
        ...getAuthHeaders(resolved.token),
      },
      timeout: 30000,
    }
  );
  const payload = response.data || {};
  if (Number(payload.status || 0) !== 200) {
    throw new Error(String(payload.msg || payload.error || "同步 TG 守护状态失败"));
  }
}
