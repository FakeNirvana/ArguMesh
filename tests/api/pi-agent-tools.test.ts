// @vitest-environment node
/** Real Pi SDK integration against a scripted loopback provider; never calls an external model. */
import assert from "node:assert/strict";
import { createServer, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, expect, it } from "vitest";
import app from "../../server/index";
import { disposePiAgentSession } from "../../server/services/pi-agent";
import type { AgentSkill, AgentSkillSnapshot, AgentSkillUsage } from "../../shared/agent-skills";
import { createTestContext, jsonHeaders, type TestContext } from "./helpers";

interface ModelMessage { role: string; content?: unknown }
interface CompletionRequest {
  model?: string;
  stream?: boolean;
  messages?: ModelMessage[];
  tools?: Array<{ function?: { name?: string } }>;
}
interface ConversationDetail {
  messages: Array<{ id: string; role: string; status: string; model: string | null; content: string; skills: AgentSkillUsage[]; skillSelection: string[] | null }>;
  actions: Array<{ toolName: string; status: string; output: { id?: string } }>;
}

const projectId = "pi-tools-nature-project";
const model = "local-scripted-pi-integration";
const dummyKey = "local-provider-test-key";
const question = "合成验收：现有项目证据是否足以支持该研究问题？";
const finalReply = "已读取 Nature 技能、参考资料和项目上下文，创建一份待核验草稿；第二次写入被每轮限制拒绝。";
const expectedToolSequence = ["skill_load", "skill_read", "project_context", "research_question_create_draft", "research_question_create_draft"];
let context: TestContext;
let skill: AgentSkill;
let conversationId = "";
let providerStep = 0;
const providerErrors: string[] = [];
const passed: string[] = [];

function text(content: unknown): string {
  if (typeof content === "string") return content;
  return Array.isArray(content) ? content.map((entry) => entry && typeof entry === "object" && "text" in entry ? String(entry.text) : "").join("\n") : "";
}
function toolResult(messages: ModelMessage[]): string {
  return text([...messages].reverse().find((message) => message.role === "tool")?.content);
}
function respond(response: ServerResponse, step: number, tool?: { name: string; arguments: unknown }) {
  response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
  const chunk = (delta: unknown, finishReason: string | null) => response.write(`data: ${JSON.stringify({
    id: `chatcmpl-local-${step}`, object: "chat.completion.chunk", created: 1, model,
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  })}\n\n`);
  if (tool) {
    chunk({ role: "assistant", tool_calls: [{ index: 0, id: `call_local_${step}`, type: "function", function: { name: tool.name, arguments: JSON.stringify(tool.arguments) } }] }, null);
    chunk({}, "tool_calls");
  } else {
    chunk({ role: "assistant", content: finalReply }, null);
    chunk({}, "stop");
  }
  response.end("data: [DONE]\n\n");
}

const provider = createServer((request, response) => {
  let raw = "";
  request.on("data", (chunk) => { raw += chunk; });
  request.on("end", () => {
    const step = providerStep++;
    try {
      assert.equal(request.method, "POST");
      assert.equal(request.url, "/v1/chat/completions");
      assert.equal(request.headers.authorization, `Bearer ${dummyKey}`);
      const body = JSON.parse(raw || "{}") as CompletionRequest;
      const messages = body.messages ?? [];
      assert.equal(body.model, model); assert.equal(body.stream, true);
      if (step === 0) {
        const system = messages.filter((message) => message.role === "system" || message.role === "developer").map((message) => text(message.content)).join("\n");
        assert(system.includes(skill.name)); assert(system.includes(skill.version));
        const names = (body.tools ?? []).map((tool) => tool.function?.name);
        for (const name of ["skill_load", "skill_read", "project_context", "research_question_create_draft"]) assert(names.includes(name), `Missing ${name}`);
        for (const name of ["read", "bash", "write", "edit"]) assert(!names.includes(name), `Unexpected host tool ${name}`);
        passed.push("model-visible catalog");
        respond(response, step, { name: "skill_load", arguments: { skillId: skill.id } });
      } else if (step === 1) {
        const result = JSON.parse(toolResult(messages));
        assert.equal(result.id, skill.id); assert.equal(result.version, skill.version);
        assert(result.instructions.length > 100); assert(result.resources.includes("references/review-axes.md"));
        passed.push("skill body reaches model");
        respond(response, step, { name: "skill_read", arguments: { skillId: skill.id, path: "references/review-axes.md", startLine: 1, maxLines: 30 } });
      } else if (step === 2) {
        const result = JSON.parse(toolResult(messages));
        const resource = skill.files.find((file) => file.path === "references/review-axes.md")!;
        assert.equal(result.path, resource.path);
        assert(result.text.includes(resource.content.split(/\r?\n/).find((line) => line.trim())));
        assert(result.text.length > 30);
        passed.push("bundled resource reaches model");
        respond(response, step, { name: "project_context", arguments: {} });
      } else if (step === 3) {
        const result = JSON.parse(toolResult(messages));
        assert.equal(result.project.id, projectId);
        assert(result.literature.some((paper: { id: string }) => paper.id === "pi-tools-synthetic-paper"));
        passed.push("project context reaches model");
        respond(response, step, { name: "research_question_create_draft", arguments: { question, goal: "验证本地工具循环，不作真实科研判断。" } });
      } else if (step === 4) {
        const result = JSON.parse(toolResult(messages));
        assert.equal(result.status, "completed"); assert.equal(result.toolName, "research_question_create_draft");
        assert.equal(typeof result.output.id, "string");
        passed.push("draft write completes");
        respond(response, step, { name: "research_question_create_draft", arguments: { question: "第二笔写入必须被拒绝", goal: "测试单轮写入上限" } });
      } else if (step === 5) {
        assert(toolResult(messages).includes("本回合已执行一个写入动作"));
        passed.push("second write rejected");
        respond(response, step);
      } else throw new Error(`Unexpected model request ${step}`);
    } catch (error) {
      providerErrors.push(error instanceof Error ? error.message : String(error));
      response.writeHead(400, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { message: "Local scripted provider assertion failed" } }));
    }
  });
});

async function json<T>(path: string, input?: unknown, method = input === undefined ? "GET" : "POST"): Promise<T> {
  const response = await app.request(path, { method, ...(input === undefined ? {} : { headers: jsonHeaders(), body: JSON.stringify(input) }) }, context.bindings);
  const body = await response.text();
  assert(response.ok, `${method} ${path}: ${response.status} ${body.slice(0, 500)}`);
  return JSON.parse(body) as T;
}

beforeAll(async () => {
  context = await createTestContext();
  skill = (await json<{ skill: AgentSkill }>("/api/agent/skills/builtin%3Anature-reviewer")).skill;
  expect(skill.source).toBe("builtin");
  expect(skill.files.some((file) => file.path === "references/review-axes.md")).toBe(true);
  await new Promise<void>((resolve, reject) => { provider.once("error", reject); provider.listen(0, "127.0.0.1", resolve); });
  const port = (provider.address() as AddressInfo).port;
  await json("/api/ai/config", { baseUrl: `http://127.0.0.1:${port}/v1`, apiKey: dummyKey, model }, "PUT");
  await json(`/api/projects/${projectId}`, { name: "真实 SDK 本地合成验收", description: "Disposable fixture; no real user content." }, "PUT");
  await json(`/api/projects/${projectId}/papers/pi-tools-synthetic-paper`, { title: "Synthetic paper, not a real research claim", authors: "Local Test", year: 2026 }, "PUT");
  conversationId = (await json<{ conversation: { id: string } }>(`/api/projects/${projectId}/ai/conversations`, { title: "Nature tool loop" })).conversation.id;
}, 30_000);

afterAll(async () => {
  if (conversationId) disposePiAgentSession(conversationId);
  provider.closeAllConnections();
  if (provider.listening) await new Promise<void>((resolve) => provider.close(() => resolve()));
  context?.cleanup();
});

it("runs builtin Nature skills through the real SDK, SSE provider, controlled writes and persisted audit", async () => {
  const path = `/api/projects/${projectId}/ai/conversations/${conversationId}`;
  const response = await app.request(`${path}/messages`, {
    method: "POST", headers: jsonHeaders(), signal: AbortSignal.timeout(45_000),
    body: JSON.stringify({ content: "请自动选择 nature-reviewer，读取 references/review-axes.md，核对项目上下文并创建一份待核验研究问题草稿。此为合成验收。" }),
  }, context.bindings);
  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toContain("text/event-stream");
  const sse = await response.text();
  expect(providerErrors, sse).toEqual([]);
  expect(sse).not.toContain("event: error");
  expect(providerStep).toBe(6);
  expect(passed).toEqual(["model-visible catalog", "skill body reaches model", "bundled resource reaches model", "project context reaches model", "draft write completes", "second write rejected"]);
  const starts = [...sse.matchAll(/^event: tool_start\ndata: (.+)$/gm)].map((match) => JSON.parse(match[1]).toolName);
  expect(starts).toEqual(expectedToolSequence);
  expect(sse).toContain("event: text_delta"); expect(sse).toContain("event: done"); expect(sse).toContain(finalReply);

  const detail = await json<ConversationDetail>(path);
  const assistant = detail.messages.find((message) => message.role === "assistant")!;
  expect(assistant).toMatchObject({ status: "completed", model, content: finalReply, skillSelection: null });
  expect(assistant.skills).toEqual([expect.objectContaining({ id: skill.id, name: skill.name, version: skill.version, source: "builtin" })]);
  expect(detail.actions).toEqual([expect.objectContaining({ toolName: "research_question_create_draft", status: "completed" })]);
  const snapshot = (await json<{ skill: AgentSkillSnapshot }>(`${path}/messages/${assistant.id}/skills/${encodeURIComponent(skill.id)}`)).skill;
  expect(snapshot).toMatchObject({ id: skill.id, version: skill.version, source: "builtin", files: skill.files });
  const questions = (await json<{ researchQuestions: Array<{ id: string; question: string; source: string; status: string }> }>(`/api/projects/${projectId}/research-questions`)).researchQuestions;
  expect(questions).toEqual([expect.objectContaining({ id: detail.actions[0].output.id, question, source: "ai", status: "open" })]);
}, 60_000);
