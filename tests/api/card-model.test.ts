// @vitest-environment node
import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
import app from "../../server/index";
import { createDatabase } from "../../server/db/client";
import { papers } from "../../server/db/schema";
import { createTestContext, jsonHeaders, type TestContext } from "./helpers";

let ctx: TestContext;
beforeAll(async () => {
  ctx = await createTestContext();
  await createDatabase(ctx.bindings).insert(papers).values({ id: "paper-model", title: "Test paper", shortName: "Test", venue: "Test", year: 2026, createdAt: new Date().toISOString() });
});
afterEach(() => vi.unstubAllGlobals());
afterAll(() => ctx.cleanup());

it("Paper Card 实际请求与返回的模型均使用已保存的 step-5-preview，覆盖旧环境及客户端模型", async () => {
  const bindings = { ...ctx.bindings, STEPFUN_BASE_URL: "https://env.example/v1", STEPFUN_API_KEY: "env-key", STEPFUN_MODEL: "step-3.7-flash" };
  await app.request("http://localhost/api/ai/config", { method: "PUT", headers: jsonHeaders(), body: JSON.stringify({ baseUrl: "https://saved.example/v1", apiKey: "saved-key", model: "step-5-preview" }) }, bindings);
  const card = { problem: "问题", method: "方法", data: "数据", findings: "发现", limitations: "局限", sources: { problem: "出处", method: "出处", data: "出处", findings: "出处", limitations: "出处" } };
  const request = vi.fn().mockResolvedValue(new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(card) } }] })));
  vi.stubGlobal("fetch", request);
  const response = await app.request("http://localhost/api/papers/paper-model/card", { method: "POST", headers: jsonHeaders(), body: JSON.stringify({ title: "Test paper", text: "Research evidence. ".repeat(10), model: "step-3.7-flash" }) }, bindings);
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ model: "step-5-preview", card: { problem: "问题" } });
  expect(request).toHaveBeenCalledTimes(1);
  const [url, init] = request.mock.calls[0] as [string, RequestInit];
  expect(url).toBe("https://saved.example/v1/chat/completions");
  expect(init.headers).toMatchObject({ authorization: "Bearer saved-key" });
  expect(JSON.parse(init.body as string)).toMatchObject({ model: "step-5-preview" });
});
