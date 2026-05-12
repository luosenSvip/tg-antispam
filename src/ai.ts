import axios from "axios";

type ApiStyle = "chat" | "responses";
type ApiStylePreference = "auto" | ApiStyle;

export interface AIProviderConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
  apiStyle?: ApiStylePreference;
}

// ==================== 1. 多接口池化配置 (带成功锁定) ====================
interface ApiEndpoint {
  baseUrl: string;
  apiKey: string;
  model: string;
  apiStyle: ApiStylePreference;
  authMode: "auto" | "bearer" | "x-api-key" | "dual";
  cooldownUntil: number;
  successCount: number;
  failCount: number;
  lastSuccess: number;
}

const SPAM_SIGNAL_KEYS = [
  "spam", "is_spam", "isSpam", "ad", "is_ad", "advertisement", "isAdvertisement", "is_advertisement",
  "argue", "abuse", "toxic", "insult", "is_toxic", "is_abuse", "is_insult",
  "confidence", "score", "probability", "spam_score", "risk_score", "risk",
  "reason", "analysis", "explanation", "detail", "desc", "description", "why"
];

let endpointGroups: Map<string, ApiEndpoint[]> = new Map();
// 记录上一次成功的接口（优选模式）
let favoredEndpoint: ApiEndpoint | null = null;

function parseApiStyle(raw?: string): ApiStylePreference {
  const s = (raw || "").trim().toLowerCase();
  if (s === "chat" || s === "chat_completions" || s === "chat-completions") return "chat";
  if (s === "responses" || s === "response") return "responses";
  return "auto";
}

function buildSingleProviderEndpoint(config: AIProviderConfig): ApiEndpoint | null {
  const baseUrl = String(config?.baseUrl || "").trim().replace(/\/$/, "");
  const apiKey = String(config?.apiKey || "").trim();
  const model = String(config?.model || "").trim();
  if (!baseUrl || !apiKey || !model) return null;
  return {
    baseUrl,
    apiKey,
    model,
    apiStyle: parseApiStyle(config.apiStyle),
    authMode: "auto",
    cooldownUntil: 0,
    successCount: 0,
    failCount: 0,
    lastSuccess: 0,
  };
}

function initEndpoints() {
  endpointGroups.clear();
  const globalStyle = parseApiStyle(process.env.AI_API_STYLE);
  for (let i = 1; i <= 20; i++) {
    const poolConfig = process.env[`AI_POOL_${i}`];
    if (!poolConfig) continue;
    const parts = poolConfig.split("|").map(s => s.trim());
    if (parts.length < 2) continue;
    const url = parts[0].replace(/\/$/, "");
    const keys = parts[1].split(",").map(s => s.trim().replace(/\s/g, "")).filter(Boolean);
    const models = (parts[2] || "gpt-4o-mini").split(",").map(s => s.trim()).filter(Boolean);
    const poolStyle = parseApiStyle(parts[3]) === "auto" ? globalStyle : parseApiStyle(parts[3]);
    if (!endpointGroups.has(url)) endpointGroups.set(url, []);
    const group = endpointGroups.get(url)!;
    for (const key of keys) {
      for (const model of models) {
        group.push({
          baseUrl: url,
          apiKey: key,
          model: model,
          apiStyle: poolStyle,
          authMode: "auto",
          cooldownUntil: 0,
          successCount: 0,
          failCount: 0,
          lastSuccess: 0
        });
      }
    }
  }

  // 兼容旧版单接口配置：AI_API_KEY / AI_API_KEYS + AI_BASE_URL + AI_MODEL
  if (endpointGroups.size === 0) {
    const legacyKeysRaw = (process.env.AI_API_KEYS || process.env.AI_API_KEY || "").trim();
    if (legacyKeysRaw) {
      const legacyBase = (process.env.AI_BASE_URL || "https://api.openai.com/v1").trim().replace(/\/$/, "");
      const legacyModels = (process.env.AI_MODEL || "grok-4.1-thinking")
        .split(",")
        .map(s => s.trim())
        .filter(Boolean);
      const legacyStyle = globalStyle;
      const legacyKeys = legacyKeysRaw
        .split(",")
        .map(s => s.trim().replace(/\s/g, ""))
        .filter(Boolean);
      endpointGroups.set(legacyBase, []);
      const group = endpointGroups.get(legacyBase)!;
      for (const key of legacyKeys) {
        for (const model of legacyModels) {
          group.push({
            baseUrl: legacyBase,
            apiKey: key,
            model,
            apiStyle: legacyStyle,
            authMode: "auto",
            cooldownUntil: 0,
            successCount: 0,
            failCount: 0,
            lastSuccess: 0
          });
        }
      }
    }
  }
}
initEndpoints();

// ==================== 2. 调度逻辑 (跨池轮询) ====================
function getNextEndpoint(excludeEndpoints: Set<ApiEndpoint>, lastTriedBaseUrl?: string): ApiEndpoint | null {
  const now = Date.now();
  if (favoredEndpoint && favoredEndpoint.cooldownUntil <= now && !excludeEndpoints.has(favoredEndpoint)) {
    return favoredEndpoint;
  }
  const allGroups = Array.from(endpointGroups.keys());
  const prioritizedGroups = lastTriedBaseUrl ? allGroups.sort((a, b) => (a === lastTriedBaseUrl ? 1 : -1)) : allGroups;
  for (const url of prioritizedGroups) {
    const available = endpointGroups.get(url)!.filter(ep => ep.cooldownUntil <= now && !excludeEndpoints.has(ep));
    if (available.length > 0) return available[Math.floor(Math.random() * available.length)];
  }
  return null;
}

function cooldownEndpoint(ep: ApiEndpoint, reason: string, status?: number) {
  ep.failCount++;
  const isAuthErr = status === 401 || status === 403;
  const cooldownMs = isAuthErr ? 10 * 60_000 : 30_000;
  ep.cooldownUntil = Date.now() + cooldownMs;
  if (favoredEndpoint === ep) favoredEndpoint = null;
  console.warn(`[AI] 接口 ${ep.baseUrl} (${ep.model}) 冷却${Math.round(cooldownMs / 1000)}s: ${reason}`);
}

function buildUrl(baseUrl: string, style: ApiStyle): string {
  const base = baseUrl.replace(/\/$/, "");
  const hasChatPath = base.endsWith("/chat/completions");
  const hasResponsesPath = base.endsWith("/responses");

  if (style === "chat") {
    if (hasChatPath) return base;
    if (hasResponsesPath) return `${base.slice(0, -"/responses".length)}/chat/completions`;
    if (base.endsWith("/v1")) return `${base}/chat/completions`;
    return `${base}/v1/chat/completions`;
  }

  if (hasResponsesPath) return base;
  if (hasChatPath) return `${base.slice(0, -"/chat/completions".length)}/responses`;
  if (base.endsWith("/v1")) return `${base}/responses`;
  return `${base}/v1/responses`;
}

function getEndpointCount(): number {
  let total = 0;
  for (const group of endpointGroups.values()) total += group.length;
  return total;
}

function getApiStyleCandidates(ep: ApiEndpoint): ApiStyle[] {
  if (ep.apiStyle === "chat") return ["chat"];
  if (ep.apiStyle === "responses") return ["responses"];

  const base = ep.baseUrl.replace(/\/$/, "").toLowerCase();
  if (base.endsWith("/responses")) return ["responses", "chat"];
  if (base.endsWith("/chat/completions")) return ["chat", "responses"];

  const globalStyle = parseApiStyle(process.env.AI_API_STYLE);
  if (globalStyle === "responses") return ["responses", "chat"];
  if (globalStyle === "chat") return ["chat", "responses"];
  return ["chat", "responses"];
}

function normalizeTextFromAny(value: any): string {
  if (value == null) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) return value.map(v => normalizeTextFromAny(v)).filter(Boolean).join("");

  if (typeof value === "object") {
    if (typeof value.text === "string") return value.text;
    if (typeof value.output_text === "string") return value.output_text;
    if (typeof value.reasoning_content === "string") return value.reasoning_content;
    if (typeof value.content === "string") return value.content;
    if (value.content && typeof value.content === "object") return normalizeTextFromAny(value.content);
    if (Array.isArray(value.content)) return normalizeTextFromAny(value.content);
    if (Array.isArray(value.output)) return normalizeTextFromAny(value.output);
    if (Array.isArray(value.choices)) return normalizeTextFromAny(value.choices);
    if (typeof value.message === "object") return normalizeTextFromAny(value.message);
  }
  return "";
}

function extractTextFromResponseObject(data: any): string {
  const choices = Array.isArray(data?.choices) ? data.choices : [];
  if (choices.length > 0) {
    const merged = choices
      .map((c: any) =>
        normalizeTextFromAny(
          c?.message?.content ??
          c?.delta?.content ??
          c?.text ??
          c?.message
        )
      )
      .filter(Boolean)
      .join("");
    if (merged) return merged;
  }

  if (typeof data?.output_text === "string") {
    return data.output_text;
  }

  const output = normalizeTextFromAny(data?.output);
  if (output) return output;

  const normalized = normalizeTextFromAny(data);
  if (normalized) return normalized;
  return "";
}

function extractTextFromSsePayload(raw: string): string {
  const parts: string[] = [];
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("data:")) continue;
    const payload = trimmed.slice(5).trim();
    if (!payload || payload === "[DONE]") continue;
    try {
      const obj = JSON.parse(payload);
      const text = extractTextFromResponseObject(obj);
      if (text) parts.push(text);
    } catch { }
  }
  return parts.join("").trim();
}

function extractResponseText(data: any): string {
  if (typeof data === "string") {
    const sseText = extractTextFromSsePayload(data);
    if (sseText) return sseText;

    const parsed = extractFirstJsonObject(data);
    if (parsed) {
      const fromParsed = extractTextFromResponseObject(parsed);
      if (fromParsed) return fromParsed;
    }
    return data;
  }

  const fromObject = extractTextFromResponseObject(data);
  if (fromObject) return fromObject;
  if (data && typeof data === "object") {
    try { return JSON.stringify(data); } catch { }
  }
  return String(data ?? "");
}

function toResponsesContent(content: any, role: string = "user"): any[] {
  const textType = role === "assistant" ? "output_text" : "input_text";
  if (typeof content === "string") {
    return [{ type: textType, text: content }];
  }
  if (Array.isArray(content)) {
    const mapped = content.flatMap((part: any) => {
      if (!part) return [];
      if (part.type === "text") {
        return [{ type: textType, text: String(part.text ?? "") }];
      }
      if (part.type === "image_url") {
        const imageUrl = typeof part.image_url === "string"
          ? part.image_url
          : part.image_url?.url;
        if (!imageUrl) return [];
        return [{ type: "input_image", image_url: imageUrl }];
      }
      if (part.type === "input_text" || part.type === "input_image") {
        return [part];
      }
      if (part.type === "output_text" || part.type === "refusal") {
        return [part];
      }
      return [{ type: textType, text: typeof part === "string" ? part : JSON.stringify(part) }];
    });
    return mapped.length > 0 ? mapped : [{ type: textType, text: "" }];
  }
  if (content && typeof content === "object") {
    return [{ type: textType, text: JSON.stringify(content) }];
  }
  return [{ type: textType, text: String(content ?? "") }];
}

function convertMessagesToResponsesInput(messages: any[]): any[] {
  return messages.map((m: any) => {
    const role = m?.role === "system" || m?.role === "assistant" || m?.role === "developer" ? m.role : "user";
    return {
      role,
      content: toResponsesContent(m?.content, role),
    };
  });
}

function shouldStripImageForModel(model: string): boolean {
  const m = (model || "").toLowerCase();
  return m.includes("grok-3-think");
}

function adaptMessagesForModel(messages: any[], model: string): any[] {
  if (!shouldStripImageForModel(model)) return messages;
  return messages.map((m: any) => ({
    ...m,
    content: (() => {
      const content = m?.content;
      if (!Array.isArray(content)) return content;

      let removedImage = false;
      let hasReadableText = false;
      const filtered = content.filter((part: any) => {
        if (!part || typeof part !== "object") return true;
        const type = String(part.type || "").toLowerCase();
        if (type === "image_url" || type === "input_image") {
          removedImage = true;
          return false;
        }
        if (type === "text" || type === "input_text") {
          const txt = String(part.text ?? "").trim();
          if (txt.length > 0) hasReadableText = true;
        }
        return true;
      });

      const baseParts = filtered.length > 0 ? filtered : [{ type: "text", text: "" }];
      if (!removedImage) return baseParts;

      const noteText = hasReadableText
        ? "【仅文本检测模式】图片输入已被禁用。你必须严格只根据文字内容判定，禁止根据图片、截图、头像、卡片样式做任何推断。"
        : "【仅文本检测模式】该消息仅包含图片且无可用文字，图片内容已被忽略。请按无文本可判定处理，不要臆测图片细节。";
      return [...baseParts, { type: "text", text: noteText }];
    })(),
  }));
}

function buildRequestBody(style: ApiStyle, model: string, messages: any[], maxTokens: number, temperature: number, stream: boolean = false): any {
  if (style === "responses") {
    return {
      model,
      input: convertMessagesToResponsesInput(messages),
      max_output_tokens: maxTokens,
      temperature,
    };
  }
  return {
    model,
    messages,
    max_tokens: maxTokens,
    temperature,
    stream,
  };
}

function buildAuthHeaders(apiKey: string, mode: "bearer" | "x-api-key" | "dual", stream: boolean = false) {
  const accept = stream ? "text/event-stream, application/json" : "application/json";
  if (mode === "x-api-key") {
    return { "X-API-Key": apiKey, "Content-Type": "application/json", "Accept": accept };
  }
  if (mode === "dual") {
    return { "Authorization": `Bearer ${apiKey}`, "X-API-Key": apiKey, "Content-Type": "application/json", "Accept": accept };
  }
  return { "Authorization": `Bearer ${apiKey}`, "Content-Type": "application/json", "Accept": accept };
}

function summarizeResponseShape(data: any): string {
  if (data == null) return "empty-response";
  if (typeof data === "string") {
    const trimmed = data.trim();
    return trimmed ? `string:${trimmed.slice(0, 120)}` : "empty-string";
  }
  if (typeof data !== "object") return `primitive:${String(data)}`;
  const topKeys = Object.keys(data).slice(0, 8);
  const choice = Array.isArray((data as any).choices) ? (data as any).choices[0] : undefined;
  const message = choice?.message;
  const details = [
    topKeys.length ? `keys=${topKeys.join(",")}` : "keys=none",
    choice ? `choiceKeys=${Object.keys(choice).slice(0, 6).join(",")}` : "choiceKeys=none",
    message ? `messageKeys=${Object.keys(message).slice(0, 6).join(",")}` : "messageKeys=none",
  ];
  return details.join(" | ");
}

function hasSignalFields(payload: any): boolean {
  if (!payload || typeof payload !== "object") return false;
  return SPAM_SIGNAL_KEYS.some((key) => Object.prototype.hasOwnProperty.call(payload, key) && payload[key] != null);
}

function hasMeaningfulModelOutput(data: any): boolean {
  if (typeof data === "string") return !!extractResponseText(data).trim();
  if (!data || typeof data !== "object") return false;

  if (hasSignalFields(data)) return true;

  for (const key of ["result", "data", "output", "judgment", "judgement"]) {
    const child = (data as any)?.[key];
    if (hasSignalFields(child)) return true;
  }

  return !!extractTextFromResponseObject(data).trim();
}

function createEmptyModelResponseError(url: string, mode: "bearer" | "x-api-key" | "dual", data: any) {
  const error = new Error(`接口返回空内容 (${mode} @ ${url}): ${summarizeResponseShape(data)}`) as Error & { code?: string; retryableEmptyResponse?: boolean; response?: { status: number; data: any } };
  error.code = "EMPTY_MODEL_RESPONSE";
  error.retryableEmptyResponse = true;
  error.response = { status: 200, data };
  return error;
}

function isRetryableEmptyResponseError(error: any): boolean {
  return error?.code === "EMPTY_MODEL_RESPONSE" || error?.retryableEmptyResponse === true;
}

async function postWithAuthFallback(
  ep: ApiEndpoint,
  url: string,
  body: any,
  timeout: number,
  validateResponse?: (response: any, mode: "bearer" | "x-api-key" | "dual") => void
) {
  const isStreaming = body?.stream === true;
  const modeOrder: ("bearer" | "x-api-key" | "dual")[] = ["bearer", "x-api-key", "dual"];
  const tryModes: ("bearer" | "x-api-key" | "dual")[] =
    ep.authMode === "auto"
      ? modeOrder
      : [ep.authMode, ...modeOrder.filter(m => m !== ep.authMode)];

  let lastErr: any;
  for (const mode of tryModes) {
    try {
      const res = await axios.post(url, body, {
        headers: buildAuthHeaders(ep.apiKey.trim(), mode, isStreaming),
        timeout,
        responseType: isStreaming ? "text" : "json",
        transitional: isStreaming ? { forcedJSONParsing: false } : undefined,
      });
      if (validateResponse) validateResponse(res, mode);
      ep.authMode = mode;
      return res;
    } catch (e: any) {
      lastErr = e;
      const status = e.response?.status;
      // 200 但正文为空时，也继续切换认证头尝试兼容不同网关行为。
      if (status !== 401 && status !== 403 && !isRetryableEmptyResponseError(e)) break;
    }
  }
  throw lastErr;
}

function shouldTryNextStyle(err: any): boolean {
  if (isRetryableEmptyResponseError(err)) return true;
  const status = err?.response?.status;
  if (status === 400 || status === 404 || status === 405 || status === 415 || status === 422 || status === 500 || status === 501) {
    return true;
  }
  const msg = String(
    err?.response?.data?.error?.message ||
    err?.response?.data?.message ||
    err?.message ||
    ""
  ).toLowerCase();
  if (!msg) return false;
  return (
    msg.includes("not found") ||
    msg.includes("unsupported") ||
    msg.includes("unknown") ||
    msg.includes("invalid endpoint") ||
    msg.includes("chat.completions") ||
    msg.includes("responses")
  );
}

async function requestWithStyleFallback(
  ep: ApiEndpoint,
  messages: any[],
  maxTokens: number,
  temperature: number,
  timeout: number
): Promise<{ data: any; text: string; style: ApiStyle }> {
  const styles = getApiStyleCandidates(ep);
  const preparedMessages = adaptMessagesForModel(messages, ep.model);
  let lastErr: any;

  for (const style of styles) {
    const streamModes = style === "chat" ? [true, false] : [false];
    for (const stream of streamModes) {
      const url = buildUrl(ep.baseUrl, style);
      const body = buildRequestBody(style, ep.model, preparedMessages, maxTokens, temperature, stream);
      try {
        const response = await postWithAuthFallback(ep, url, body, timeout, (res, mode) => {
          if (!hasMeaningfulModelOutput(res.data)) {
            throw createEmptyModelResponseError(`${url}${stream ? " [stream]" : ""}`, mode, res.data);
          }
        });
        const text = extractResponseText(response.data);
        ep.apiStyle = style;
        return { data: response.data, text, style };
      } catch (e: any) {
        lastErr = e;
        if (!shouldTryNextStyle(e)) break;
      }
    }
  }
  throw lastErr;
}

// ==================== 3. 核心工具 ====================
function extractFirstJsonObject(text: string): any {
  for (let i = 0; i < text.length; i++) {
    if (text[i] !== "{") continue;
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let j = i; j < text.length; j++) {
      const ch = text[j];
      if (inString) {
        if (escaped) {
          escaped = false;
        } else if (ch === "\\") {
          escaped = true;
        } else if (ch === "\"") {
          inString = false;
        }
        continue;
      }
      if (ch === "\"") {
        inString = true;
        continue;
      }
      if (ch === "{") {
        depth++;
      } else if (ch === "}") {
        depth--;
        if (depth === 0) {
          const candidate = text.slice(i, j + 1).trim();
          try { return JSON.parse(candidate); } catch { break; }
        }
      }
    }
  }
  return null;
}

function extractJson(text: string): any {
  if (!text) return null;
  const cleaned = text.trim();
  try { return JSON.parse(cleaned); } catch { }

  const fencedRe = /```(?:json)?\s*([\s\S]*?)\s*```/gi;
  let m: RegExpExecArray | null;
  while ((m = fencedRe.exec(cleaned)) !== null) {
    const block = (m[1] || "").trim();
    if (!block) continue;
    try { return JSON.parse(block); } catch { }
    const nested = extractFirstJsonObject(block);
    if (nested) return nested;
  }

  return extractFirstJsonObject(cleaned);
}

function pickFirstDefined(obj: any, keys: string[]): any {
  if (!obj || typeof obj !== "object") return undefined;
  for (const key of keys) {
    if (Object.prototype.hasOwnProperty.call(obj, key) && obj[key] != null) {
      return obj[key];
    }
  }
  return undefined;
}

function toBoolLike(value: any): boolean | undefined {
  if (typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value !== 0;
  if (typeof value !== "string") return undefined;
  const v = value.trim().toLowerCase();
  if (!v) return undefined;
  if (["true", "1", "yes", "y", "是", "垃圾", "广告", "spam", "违规", "恶意"].includes(v)) return true;
  if (["false", "0", "no", "n", "否", "正常", "clean", "ham", "safe"].includes(v)) return false;
  return undefined;
}

function toConfidence(value: any): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    if (value <= 1 && value >= 0) return value;
    if (value > 1 && value <= 100) return value / 100;
    if (value < 0) return 0;
    return 1;
  }
  if (typeof value !== "string") return undefined;
  const m = value.match(/-?\d+(?:\.\d+)?/);
  if (!m) return undefined;
  const n = Number(m[0]);
  if (!Number.isFinite(n)) return undefined;
  if (value.includes("%")) return Math.max(0, Math.min(1, n / 100));
  if (n <= 1 && n >= 0) return n;
  if (n > 1 && n <= 100) return n / 100;
  if (n < 0) return 0;
  return 1;
}

function cleanText(v: any): string {
  if (v == null) return "";
  const s = typeof v === "string" ? v : normalizeTextFromAny(v);
  return String(s || "").replace(/\s+/g, " ").trim();
}

function containsAny(text: string, needles: string[]): boolean {
  return needles.some((needle) => text.includes(needle));
}

function extractConfidenceFromNaturalLanguage(text: string): number | undefined {
  const m = text.match(/(?:confidence|置信度|可信度|概率|把握|可能性)\s*[:：]?\s*([0-9]+(?:\.[0-9]+)?%?)/i);
  if (!m) return undefined;
  return toConfidence(m[1]);
}

function normalizeNaturalLanguageSpamOutput(rawText: string): {
  valid: boolean;
  spam: boolean;
  argue: boolean;
  confidence: number;
  reason: string;
} {
  const text = cleanText(rawText);
  if (!text) return { valid: false, spam: false, argue: false, confidence: 0, reason: "" };

  const lowered = text.toLowerCase();
  const spamNegative = containsAny(text, [
    "正常消息", "普通消息", "普通测试消息", "正常文本", "正常互动", "不是广告", "非广告", "未发现明显异常", "未发现明显风险", "未发现垃圾信息", "不包含明显违规", "无明显广告"
  ]);
  const spamPositive = containsAny(text, [
    "垃圾消息", "广告消息", "引流", "推广", "营销", "违规消息", "高风险", "可判定为广告", "属于广告", "建议封禁", "建议删除", "spam"
  ]);
  const argueNegative = containsAny(text, [
    "无明显攻击性", "未发现争吵", "未发现辱骂", "无辱骂", "无明显争执", "正常互动"
  ]);
  const arguePositive = containsAny(text, [
    "争吵", "辱骂", "攻击性", "人身攻击", "谩骂", "侮辱", "恶毒攻击", "威胁"
  ]);

  let spam: boolean | undefined;
  let argue: boolean | undefined;

  if (spamPositive && !spamNegative) spam = true;
  else if (spamNegative) spam = false;

  if (arguePositive && !argueNegative) argue = true;
  else if (argueNegative) argue = false;

  const hasSignal = spam !== undefined || argue !== undefined;
  if (!hasSignal) {
    return { valid: false, spam: false, argue: false, confidence: 0, reason: "" };
  }

  const confidence = extractConfidenceFromNaturalLanguage(text) ?? (spam === true || argue === true ? 0.72 : 0.65);
  return {
    valid: true,
    spam: spam ?? false,
    argue: argue ?? false,
    confidence: Math.max(0, Math.min(1, confidence)),
    reason: text.slice(0, 240),
  };
}

function normalizeSpamPayload(payload: any, rawText: string): {
  valid: boolean;
  spam: boolean;
  argue: boolean;
  confidence: number;
  reason: string;
} {
  if (!payload || typeof payload !== "object") {
    return { valid: false, spam: false, argue: false, confidence: 0, reason: "" };
  }

  const candidates: any[] = [payload];
  const nestedKeys = ["result", "data", "output", "judgment", "judgement"];
  for (const key of nestedKeys) {
    const child = (payload as any)?.[key];
    if (child && typeof child === "object") candidates.push(child);
  }

  let spam: boolean | undefined;
  let argue: boolean | undefined;
  let confidence: number | undefined;
  let reason = "";

  for (const c of candidates) {
    if (spam === undefined) {
      spam = toBoolLike(pickFirstDefined(c, [
        "spam", "is_spam", "isSpam", "ad", "is_ad", "advertisement", "isAdvertisement", "is_advertisement"
      ]));
    }
    if (argue === undefined) {
      argue = toBoolLike(pickFirstDefined(c, [
        "argue", "abuse", "toxic", "insult", "is_toxic", "is_abuse", "is_insult"
      ]));
    }
    if (confidence === undefined) {
      confidence = toConfidence(pickFirstDefined(c, [
        "confidence", "score", "probability", "spam_score", "risk_score", "risk"
      ]));
    }
    if (!reason) {
      reason = cleanText(pickFirstDefined(c, [
        "reason", "analysis", "explanation", "detail", "desc", "description", "why"
      ]));
    }
  }

  const hasSignal = spam !== undefined || argue !== undefined || confidence !== undefined || !!reason;
  if (!hasSignal) {
    return { valid: false, spam: false, argue: false, confidence: 0, reason: "" };
  }

  if (!reason) {
    const preview = cleanText(
      String(rawText || "")
        .replace(/```(?:json)?/gi, "")
        .replace(/```/g, "")
    ).slice(0, 120);
    reason = preview ? `模型未返回分析字段，原始输出: ${preview}` : "模型未返回分析字段";
  }

  return {
    valid: true,
    spam: spam ?? false,
    argue: argue ?? false,
    confidence: Math.max(0, Math.min(1, confidence ?? 0)),
    reason,
  };
}

// ==================== 4. 深度判定提示词 (防误判强化版) ====================
const SPAM_DETECTION_PROMPT = `你是一个 Telegram 群组的高级风控专家，负责通过消息内容、用户画像和上下文来精准识别垃圾消息。你的目标是：**在绝对不误判正常群友互动的前提下，封杀专业广告号。**

### 一、 核心判定权重
1. **活跃度即信任度 (最高权重)**：
   - 必须优先参考【用户画像】。如果是管理层、活跃发言者或发言记录跨度很久的老用户，他们分享的任何链接、吐槽、口嗨默认视为【正常】。
   - 只有【画像为空/纯新人/复读机】发送的敏感内容才应判定为垃圾消息。

2. **互动倾向 (中权)**：
   - 如果该消息是在【回复 (Reply)】别人，或者是在与人正常的对话流中，通常不是广告。
   - 没有任何上下文、突兀空降发送消息且带引流信息的，大概率为广告。

### 二、 垃圾广告 (Spam) 判定细节
- **加分项 (更像广告)**：包含引流指令（私聊我、置顶看、扫码、进频道、关键词触发）、虚假金钱诱惑（日赚、致富、领取）、博彩套利、刷单返利、杀猪盘、非法灰产；新用户空降发送联系人名片、手机号、联系方式，并伴随“看简介/联系我/加我/出售”等导流或交易话术，也应视为明显广告信号。
- **减分项 (更像正常消息)**：正常的资源分享（GitHub、Google、Wikipedia）、技术细节讨论、针对群内话题的解答。

### 三、 激烈吵架 (Argue) 判定细节
- **严禁误判**：提及对方昵称或 ID 的行为【绝不属于】谩骂。
- **口嗨保护**：诸如“这垃圾游戏”、“卧槽”、“干他”等非针对性语气词、口头禅，属于【正常互动】。
- **严重程度**：只有出现连续的、针对特定人的恶毒攻击、人身威胁、极其不堪入目的脏话连篇，才判定为 true。

### 四、 避坑指南 (防误判红线)
- **链接不代表广告**：群友分享一张图、一个搞笑视频、一个知乎/B站链接，是正常的社交。
- **吐槽不代表攻击**：对群规、游戏、天气的吐槽是正常的。
- **隐私保护**：保护群友互动的多样性，允许非正式的交流风格。

请严格仅以 JSON 格式回复，严禁包含任何前导文本：
{"spam": true/false, "argue": true/false, "confidence": 0.0-1.0, "reason": "基于画像、互动和内容的综合研判分析"}`;

export interface SpamSample { message_text: string; is_spam: boolean; }
export interface SpamCheckResult { spam: boolean; argue: boolean; confidence: number; reason: string; model: string; }

function buildFewShotMessages(samples: SpamSample[]): { role: string; content: string }[] {
  return samples.slice(0, 10).flatMap(s => [
    { role: "user", content: s.message_text },
    { role: "assistant", content: JSON.stringify({ spam: s.is_spam, argue: false, confidence: 0.9, reason: "历史学习判定" }) }
  ]);
}

/**
 * 此时此刻的满血版：包含画像、上下文和重试逻辑
 */
export async function checkSpam(
  messageText: string,
  samples: SpamSample[] = [],
  historyText: string = "",
  imageUrl?: string,
  senderPortrait?: string,
  noRetry = false,
  provider?: AIProviderConfig
): Promise<SpamCheckResult> {
  const providerEndpoint = provider ? buildSingleProviderEndpoint(provider) : null;
  const endpointCount = providerEndpoint ? 1 : getEndpointCount();
  if (endpointCount <= 0 || (provider && !providerEndpoint)) {
    return { spam: false, argue: false, confidence: 0, reason: "未配置可用 AI 接口", model: "None" };
  }
  const normalizedMessageText = String(messageText || "").trim();

  // 构建综合内容
  let userContent = "";
  if (senderPortrait) userContent += `【用户画像】：\n${senderPortrait}\n\n`;
  if (historyText) userContent += `【近期群聊上下文】：\n${historyText}\n\n`;
  userContent += `【当前待检测消息】：\n${messageText}`;

  const finalContent: any = imageUrl 
    ? [{ type: "text", text: userContent }, { type: "image_url", image_url: { url: imageUrl } }]
    : userContent;

  const messages = [
    { role: "system", content: SPAM_DETECTION_PROMPT },
    ...buildFewShotMessages(samples),
    { role: "user", content: finalContent }
  ];

  let lastError: any;
  const startTime = Date.now();
  const excludeSet = new Set<ApiEndpoint>();
  let lastBaseUrl = "";

  // noRetry 模式用于“快速诊断”，但仍允许跨池兜底，避免首个接口失败导致整体假死
  const maxAttempts = noRetry ? Math.min(Math.max(1, endpointCount), 6) : 25;
  const maxDurationMs = noRetry ? 30_000 : 90_000;
  const requestTimeoutMs = noRetry ? 25_000 : 45_000;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    if (Date.now() - startTime > maxDurationMs) break;
    const ep = providerEndpoint
      ? (excludeSet.has(providerEndpoint) ? null : providerEndpoint)
      : getNextEndpoint(excludeSet, lastBaseUrl);
    if (!ep) break;
    excludeSet.add(ep);
    lastBaseUrl = ep.baseUrl;

    // grok-3-think* 已禁用图片输入：仅图片无文本时直接按“无法判定”返回，避免模型臆测图片内容
    if (imageUrl && normalizedMessageText.length === 0 && shouldStripImageForModel(ep.model)) {
      favoredEndpoint = ep;
      ep.successCount++;
      ep.lastSuccess = Date.now();
      return {
        spam: false,
        argue: false,
        confidence: 0,
        reason: "该模型已过滤图片输入，当前消息无文本可判定，按正常消息处理",
        model: ep.model
      };
    }

    try {
      const response = await requestWithStyleFallback(
        ep,
        messages,
        1000,
        0.1,
        requestTimeoutMs
      );
      const resData = response.text;
      const result = extractJson(resData);
      const normalized = result
        ? normalizeSpamPayload(result, resData)
        : normalizeNaturalLanguageSpamOutput(resData);
      if (!result && !normalized.valid) {
        const preview = String(resData || "").replace(/\s+/g, " ").slice(0, 160) || "空响应";
        lastError = new Error(`接口返回非JSON: ${preview}`);
        cooldownEndpoint(ep, "返回内容非 JSON 或为空（模型输出格式不兼容）");
        continue;
      }
      if (!normalized.valid) {
        const preview = String(resData || "").replace(/\s+/g, " ").slice(0, 160) || "空响应";
        lastError = new Error(`接口返回缺少判定字段: ${preview}`);
        cooldownEndpoint(ep, "返回 JSON 缺少 spam/argue/confidence/reason 关键字段");
        continue;
      }
      
      favoredEndpoint = ep; // 锁定成功接口
      ep.successCount++;
      ep.lastSuccess = Date.now();
      return { 
        spam: normalized.spam, 
        argue: normalized.argue, 
        confidence: normalized.confidence, 
        reason: normalized.reason, 
        model: ep.model 
      };
    } catch (e: any) {
      lastError = e;
      const status = e.response?.status;
      const remoteMsg = e.response?.data?.error?.message || e.response?.data?.message || e.message;
      cooldownEndpoint(ep, `(Status ${status ?? "?"}) ${remoteMsg}`, status);
    }
  }
  return { spam: false, argue: false, confidence: 0, reason: `全部失败: ${lastError?.message || "未响应"}`, model: "None" };
}

export async function callAI(
  messages: any[],
  maxTokens = 500,
  temperature = 0.8,
  noRetry = false,
  provider?: AIProviderConfig
) {
  const providerEndpoint = provider ? buildSingleProviderEndpoint(provider) : null;
  const endpointCount = providerEndpoint ? 1 : getEndpointCount();
  if (endpointCount <= 0 || (provider && !providerEndpoint)) {
    throw new Error("未配置可用 AI 接口");
  }
  let lastError: any;
  const startTime = Date.now();
  const excludeSet = new Set<ApiEndpoint>();
  let lastBaseUrl = "";
  const maxAttempts = noRetry ? Math.min(Math.max(1, endpointCount), 2) : 15;
  const maxDurationMs = noRetry ? 18_000 : 60_000;
  const requestTimeoutMs = noRetry ? 15_000 : 30_000;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    if (Date.now() - startTime > maxDurationMs) break;
    const ep = providerEndpoint
      ? (excludeSet.has(providerEndpoint) ? null : providerEndpoint)
      : getNextEndpoint(excludeSet, lastBaseUrl);
    if (!ep) break;
    excludeSet.add(ep);
    lastBaseUrl = ep.baseUrl;
    try {
      const r = await requestWithStyleFallback(
        ep,
        messages,
        maxTokens,
        temperature,
        requestTimeoutMs
      );
      favoredEndpoint = ep;
      return { content: r.text, model: ep.model };
    } catch (e: any) {
      lastError = e;
      const status = e.response?.status;
      const remoteMsg = e.response?.data?.error?.message || e.response?.data?.message || e.message;
      cooldownEndpoint(ep, `(Status ${status ?? "?"}) ${remoteMsg}`, status);
    }
  }
  if (lastError) {
    const status = lastError?.response?.status;
    const code = lastError?.code;
    const detail = String(
      lastError?.response?.data?.error?.message ||
      lastError?.response?.data?.message ||
      lastError?.message ||
      "未响应"
    ).replace(/\s+/g, " ").slice(0, 180);
    throw new Error(`AI 接口未响应${status ? ` (status ${status})` : ""}${code ? ` [${code}]` : ""}: ${detail}`);
  }
  throw new Error("AI 接口未响应");
}
