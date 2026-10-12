import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import { createDatabase } from "../db/client";
import { aiSettings } from "../db/schema";
import { getAiProviders, LOCAL_AI_ACCOUNT_ID, resolveAiForRequest } from "../services/ai";
import { AiRequestError, createStepFunCompletion, inferAiApiFormat } from "../services/stepfun";
import type { AppBindings, AppEnv } from "../types";

/**
 * 全局 AI 配置(单用户本地版):设置页表单(Base URL / API Key / 模型名称)。
 * 单行表(固定 account_id="local"),优先于环境变量里的厂商配置;GET 永不回传完整密钥,只给掩码。
 */

const saveSchema = z.object({
  baseUrl: z.string().trim().min(1).max(500).refine((value) => /^https?:\/\//i.test(value), { message: "Base URL 需以 http(s):// 开头" }),
  // 留空 = 保留已保存的密钥(表单回显只显示掩码,避免每次保存都要重输密钥)。
  apiKey: z.string().trim().max(500).optional(),
  model: z.string().trim().max(200).optional(),
});

/** 密钥掩码:保留前 3 位 + 后 4 位,如 sk-…a1b2。短密钥只显示占位符。 */
function maskApiKey(key: string): string {
  if (key.length <= 8) return "••••••";
  return `${key.slice(0, 3)}…${key.slice(-4)}`;
}

function configPayload(env: AppBindings, row: typeof aiSettings.$inferSelect | null) {
  return {
    configured: Boolean(row?.apiKey),
    baseUrl: row?.baseUrl ?? "",
    model: row?.model ?? "",
    apiKeyMasked: row ? maskApiKey(row.apiKey) : null,
    // 环境变量里的厂商列表只作信息展示(未配置全局配置时生效),不含密钥。
    envProviders: getAiProviders(env).map((p) => ({ id: p.id, label: p.label, models: p.models })),
  };
}

const LOCAL_ID = LOCAL_AI_ACCOUNT_ID;

export const aiRoutes = new Hono<AppEnv>();

/** GET /ai/config — 返回全局 AI 配置掩码(密钥永不回传)。 */
aiRoutes.get("/ai/config", async (c) => {
  const db = createDatabase(c.env);
  const row = await db.select().from(aiSettings).where(eq(aiSettings.accountId, LOCAL_ID)).get();
  return c.json(configPayload(c.env, row ?? null));
});

/** POST /ai/config/test — 用实际生效的配置发送固定短消息，不发送研究内容或写入数据库。 */
aiRoutes.post("/ai/config/test", async (c) => {
  const resolution = await resolveAiForRequest(c.env, {});
  if ("error" in resolution) return c.json({ error: resolution.error.code, message: resolution.error.message }, 400);
  const { provider, model } = resolution;
  const startedAt = Date.now();
  try {
    await createStepFunCompletion(c.env, [{ role: "user", content: "Connection check. Reply with OK only." }], {
      providerConfig: provider, model, maxTokens: 128, thinkingMode: false, timeoutMs: 30_000, signal: c.req.raw.signal,
    });
    return c.json({ ok: true, model, provider: provider.label, apiFormat: inferAiApiFormat(provider.baseUrl), latencyMs: Date.now() - startedAt, checkedAt: new Date().toISOString() });
  } catch (error) {
    // 不回显厂商原始错误：其中可能包含请求头、密钥或其他敏感信息。
    let message = "连接失败：无法访问模型服务，请检查 Base URL、网络与代理。";
    if (error instanceof AiRequestError) {
      const status = error.status;
      if (status === 401 || status === 403) message = `连接失败（HTTP ${status}）：API Key 无效或没有该模型的访问权限。`;
      else if (status === 429) message = "连接失败（HTTP 429）：服务限流或额度不足，请检查余额并稍后重试。";
      else if (status === 404) message = "连接失败（HTTP 404）：接口路径或模型不存在，请检查 Base URL 与模型名称。";
      else message = `连接失败（HTTP ${status}）：${status >= 500 ? "模型服务暂时不可用，请稍后重试。" : "服务拒绝请求，请检查模型名称与接口兼容性。"}`;
    } else if (error instanceof Error && error.name === "TimeoutError") {
      message = "连接超时：模型服务在 30 秒内未返回结果，请检查网络或稍后重试。";
    } else if (error instanceof Error && error.name === "AbortError") {
      message = "连接自检已取消。";
    } else if (error instanceof Error && error.message === "AI returned an empty response") {
      message = "连接失败：服务未返回有效的模型回复，请检查模型与接口兼容性。";
    }
    return c.json({ error: "AI_CONNECTION_FAILED", message }, 502);
  }
});

/** PUT /ai/config — 保存全局 AI 配置(apiKey 留空则保留已保存的密钥)。 */
aiRoutes.put("/ai/config", async (c) => {
  const parsed = saveSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) {
    return c.json({ error: "INVALID_AI_CONFIG", message: "AI 配置不完整:Base URL 需为 http(s) 地址", issues: parsed.error.issues }, 400);
  }
  const db = createDatabase(c.env);
  const existing = await db.select().from(aiSettings).where(eq(aiSettings.accountId, LOCAL_ID)).get();
  const apiKey = parsed.data.apiKey || existing?.apiKey || "";
  if (!apiKey) {
    return c.json({ error: "INVALID_AI_CONFIG", message: "请输入 API Key" }, 400);
  }
  const baseUrl = parsed.data.baseUrl.replace(/\/+$/, "");
  const model = parsed.data.model?.trim() || existing?.model || "";
  const now = new Date().toISOString();
  // 单行表:有则更新,无则插入(accountId 用表默认值 "local")。
  await db
    .insert(aiSettings)
    .values({ accountId: LOCAL_ID, baseUrl, apiKey, model, updatedAt: now })
    .onConflictDoUpdate({ target: aiSettings.accountId, set: { baseUrl, apiKey, model, updatedAt: now } });
  const saved = await db.select().from(aiSettings).where(eq(aiSettings.accountId, LOCAL_ID)).get();
  return c.json(configPayload(c.env, saved ?? null));
});

/** DELETE /ai/config — 清除全局 AI 配置(回退到环境变量厂商配置)。 */
aiRoutes.delete("/ai/config", async (c) => {
  const db = createDatabase(c.env);
  await db.delete(aiSettings).where(eq(aiSettings.accountId, LOCAL_ID));
  return c.json({ cleared: true });
});
