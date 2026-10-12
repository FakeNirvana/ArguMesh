// @vitest-environment node
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import app from "../../server/index";
import { createTestContext, jsonHeaders, type TestContext } from "./helpers";

let ctx: TestContext;
const key = "sk-private-connection-check";
const baseUrl = "https://model.example/v1";
const check = () => app.request("http://localhost/api/ai/config/test", { method: "POST" }, ctx.bindings);
const save = (url = baseUrl, model = "test-model") => app.request("http://localhost/api/ai/config", {
  method: "PUT", headers: jsonHeaders(), body: JSON.stringify({ baseUrl: url, apiKey: key, model }),
}, ctx.bindings);

beforeAll(async () => { ctx = await createTestContext(); });
beforeEach(async () => { await app.request("http://localhost/api/ai/config", { method: "DELETE" }, ctx.bindings); });
afterEach(() => vi.unstubAllGlobals());
afterAll(() => ctx.cleanup());

describe("模型连接自检", () => {
  it("未配置时不发起模型请求", async () => {
    const request = vi.fn(); vi.stubGlobal("fetch", request);
    const response = await check();
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: "AI_NOT_CONFIGURED" });
    expect(request).not.toHaveBeenCalled();
  });

  it.each(["openai", "anthropic"])("通过 %s 的真实调用路径验证已保存配置，不写入数据或回传密钥", async (format) => {
    await save(format === "anthropic" ? "https://model.example/anthropic" : baseUrl);
    const request = vi.fn().mockResolvedValue(new Response(JSON.stringify(format === "anthropic"
      ? { content: [{ type: "text", text: "OK" }] }
      : { choices: [{ message: { content: "OK" } }] })));
    vi.stubGlobal("fetch", request);
    const before = await (await app.request("http://localhost/api/ai/config", {}, ctx.bindings)).json();
    const response = await check();
    expect(response.status).toBe(200);
    const result = await response.json();
    expect(result).toMatchObject({ ok: true, model: "test-model", provider: "自定义配置", apiFormat: format, latencyMs: expect.any(Number), checkedAt: expect.any(String) });
    expect(JSON.stringify(result)).not.toContain(key);
    expect(request).toHaveBeenCalledTimes(1);
    const [url, init] = request.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(format === "anthropic" ? "https://model.example/anthropic/v1/messages" : `${baseUrl}/chat/completions`);
    expect(init.headers).toMatchObject(format === "anthropic" ? { "x-api-key": key } : { authorization: `Bearer ${key}` });
    expect(JSON.parse(init.body as string)).toMatchObject({ model: "test-model", max_tokens: 128, messages: [{ role: "user", content: "Connection check. Reply with OK only." }] });
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(await (await app.request("http://localhost/api/ai/config", {}, ctx.bindings)).json()).toEqual(before);
  });

  it("环境 AI_PROVIDERS 无需 STEPFUN 变量，自定义配置仍优先且缺模型不回退", async () => {
    const bindings = { ...ctx.bindings, AI_PROVIDERS: JSON.stringify([{ id: "env", label: "Environment", baseUrl, apiKey: "env-key", models: ["env-model"] }]) };
    const request = vi.fn().mockImplementation(() => Promise.resolve(new Response(JSON.stringify({ choices: [{ message: { content: "OK" } }] }))));
    vi.stubGlobal("fetch", request);
    const config = await (await app.request("http://localhost/api/ai/config", {}, bindings)).json();
    expect(config.envProviders).toEqual([{ id: "env", label: "Environment", models: ["env-model"] }]);
    expect(await (await app.request("http://localhost/api/ai/config/test", { method: "POST" }, bindings)).json()).toMatchObject({ provider: "Environment", model: "env-model" });
    await save();
    expect(await (await app.request("http://localhost/api/ai/config/test", { method: "POST" }, bindings)).json()).toMatchObject({ provider: "自定义配置", model: "test-model" });
    await app.request("http://localhost/api/ai/config", { method: "DELETE" }, bindings);
    await save(baseUrl, "");
    request.mockClear();
    const incomplete = await app.request("http://localhost/api/ai/config/test", { method: "POST" }, bindings);
    expect(incomplete.status).toBe(400);
    expect(request).not.toHaveBeenCalled();
  });

  it.each([[401, "API Key"], [403, "访问权限"], [404, "接口路径或模型"], [429, "额度"], [400, "接口兼容性"], [503, "暂时不可用"]])("HTTP %i 给出可操作提示并隐藏上游敏感错误", async (status, hint) => {
    await save();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: { message: `Authorization: Bearer ${key}` } }), { status: Number(status) })));
    const response = await check();
    expect(response.status).toBe(502);
    const result = await response.json();
    expect(result.message).toContain(hint);
    expect(result.message).toContain(`HTTP ${status}`);
    expect(JSON.stringify(result)).not.toContain(key);
  });

  it.each([
    [new DOMException("timeout", "TimeoutError"), "30 秒"],
    [new DOMException("aborted", "AbortError"), "取消"],
    [new TypeError("fetch failed"), "网络"],
  ])("处理调用异常 %s", async (error, hint) => {
    await save();
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(error));
    expect(await (await check()).json()).toMatchObject({ message: expect.stringContaining(hint) });
  });

  it.each([{}, { choices: [{ message: { content: "" } }] }])("无有效模型回复时不能报告连接成功", async (body) => {
    await save();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify(body))));
    const response = await check();
    expect(response.status).toBe(502);
    expect(await response.json()).toMatchObject({ message: expect.stringContaining("有效的模型回复") });
  });
});
