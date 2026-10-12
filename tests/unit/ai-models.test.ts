import { afterEach, expect, it, vi } from "vitest";
import { getAiModels } from "../../src/api";

afterEach(() => vi.unstubAllGlobals());

const envProviders = [{ id: "stepfun", label: "StepFun", models: ["step-3.7-flash", "other-model"] }];
function mockConfig(config: Record<string, unknown>) {
  const request = vi.fn().mockResolvedValue(new Response(JSON.stringify(config)));
  vi.stubGlobal("fetch", request);
  return request;
}

it("已保存的模型完全覆盖环境模型列表", async () => {
  const request = mockConfig({ configured: true, model: "step-5-preview", envProviders });
  expect(await getAiModels()).toEqual({ model: "step-5-preview", models: ["step-5-preview"], providers: [{ id: "account", label: "自定义配置", models: ["step-5-preview"] }] });
  expect(request).toHaveBeenCalledWith("/api/ai/config", expect.any(Object));
});

it("未保存自定义配置时使用第一个环境厂商的默认模型", async () => {
  mockConfig({ configured: false, model: "", envProviders });
  expect(await getAiModels()).toEqual({ model: "step-3.7-flash", models: envProviders[0].models, providers: envProviders });
});

it("已保存配置缺模型时不回退到环境模型", async () => {
  mockConfig({ configured: true, model: "", envProviders });
  expect(await getAiModels()).toMatchObject({ model: "", models: [] });
});

it.each([new Response("", { status: 200 }), new Response("offline", { status: 502 }), new Response("not json")])("读取配置失败时不编造默认模型", async (response) => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response));
  expect(await getAiModels()).toEqual({ model: "", models: [], providers: [] });
});
