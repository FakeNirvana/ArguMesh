import { and, asc, desc, eq, lt } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import { createDatabase } from "../db/client";
import { projectExists } from "../db/projects";
import { aiActions, aiConversations, aiMessages } from "../db/schema";
import { AgentConfigurationError, type AgentTurnInput } from "../services/research-agent";
import { disposePiAgentSession, runPiAgentTurn, type PiAgentStreamEvent } from "../services/pi-agent";
import { AgentSkillError, getAvailableAgentSkills } from "../services/agent-skills";
import type { AgentSkillSnapshot } from "../../shared/agent-skills";
import type { AppEnv } from "../types";

/** Canonical Research Agent mode (legacy aliases accepted on create). */
const conversationModeSchema = z
  .enum(["research_agent", "pi_research", "research_orchestrator"])
  .transform(() => "research_agent" as const);

function parseJson<T>(value: string, fallback: T): T {
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}
function toMessage(row: typeof aiMessages.$inferSelect) {
  return {
    ...row, error: row.error ? normalizeAgentTransportError(row.error) : "",
    citations: parseJson(row.citationsJson, []), citationsJson: undefined,
    skills: parseJson<AgentSkillSnapshot[]>(row.skillsJson, []).map(({ id, name, source, version, loadedAt }) => ({ id, name, source, version, loadedAt })),
    skillSelection: parseJson<string[] | null>(row.skillSelectionJson, null),
    skillsJson: undefined, skillSelectionJson: undefined,
  };
}
function toAction(row: typeof aiActions.$inferSelect) {
  return {
    ...row,
    input: parseJson(row.inputJson, {}),
    output: parseJson(row.outputJson, {}),
    inputJson: undefined,
    outputJson: undefined,
  };
}

function encodeSse(event: string, data: unknown) {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

/** Map undici / proxy / provider transport failures into a stable Chinese message. */
export function normalizeAgentTransportError(raw: string): string {
  const message = raw.trim();
  if (!message) return "Research Agent 暂时无法完成此回合";
  if (/agent is already processing|streamingBehavior|AGENT_TURN_BUSY/i.test(message)) return "上一回合仍在处理，请稍后重试。若连接已中断，重新加载会话后可继续。";
  if (/TimeoutError|timed out|回合超时/i.test(message)) return "本回合超时（5 分钟），已停止运行；保留已有消息和动作记录，请重试。";
  if (/network error|failed to fetch|fetch failed|econnreset|econnrefused|socket hang up|und_err_connect|und_err_headers_timeout|und_err_body_timeout/i.test(message)) {
    return "网络连接中断（开发热重载、Vite 代理断开，或模型 API 不可达）。请确认 API 仍在运行后重试。";
  }
  return message.slice(0, 500);
}

export const conversationRoutes = new Hono<AppEnv>();
// Ownership tokens cover setup as well as SDK execution, preventing double submissions from mutating a live session.
const activeTurns = new Map<string, AbortController>();

function interruptTurn(conversationId: string, reason = "回合连接中断，请重试") {
  const turn = activeTurns.get(conversationId);
  turn?.abort(new DOMException(reason, "AbortError"));
  disposePiAgentSession(conversationId);
  if (activeTurns.get(conversationId) === turn) activeTurns.delete(conversationId);
}

conversationRoutes.get("/projects/:projectId/ai/conversations", async (c) => {
  const projectId = c.req.param("projectId");
  if (!(await projectExists(c.env, projectId))) return c.json({ error: "PROJECT_NOT_FOUND" }, 404);
  const rows = await createDatabase(c.env)
    .select()
    .from(aiConversations)
    .where(eq(aiConversations.projectId, projectId))
    .orderBy(desc(aiConversations.updatedAt));
  return c.json({ conversations: rows });
});

conversationRoutes.post("/projects/:projectId/ai/conversations", async (c) => {
  const projectId = c.req.param("projectId");
  if (!(await projectExists(c.env, projectId))) return c.json({ error: "PROJECT_NOT_FOUND" }, 404);
  const parsed = z
    .object({
      title: z.string().min(1).max(200).default("新研究对话"),
      mode: conversationModeSchema.default("research_agent"),
    })
    .safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) return c.json({ error: "INVALID_CONVERSATION", issues: parsed.error.issues }, 400);
  const now = new Date().toISOString();
  const conversation = {
    id: crypto.randomUUID(),
    projectId,
    title: parsed.data.title,
    mode: parsed.data.mode,
    status: "active" as const,
    createdAt: now,
    updatedAt: now,
  };
  await createDatabase(c.env).insert(aiConversations).values(conversation);
  return c.json({ conversation }, 201);
});

conversationRoutes.get("/projects/:projectId/ai/conversations/:conversationId", async (c) => {
  const projectId = c.req.param("projectId");
  const conversationId = c.req.param("conversationId");
  const db = createDatabase(c.env);
  const conversation = await db
    .select()
    .from(aiConversations)
    .where(and(eq(aiConversations.id, conversationId), eq(aiConversations.projectId, projectId)))
    .get();
  if (!conversation) return c.json({ error: "CONVERSATION_NOT_FOUND" }, 404);
  // Heal interrupted SSE turns. `healPending=1` clears all pending (client reported disconnect);
  // otherwise only rows older than 25s (hot-reload leftovers) so in-flight turns are not raced.
  const healAllPending = c.req.query("healPending") === "1";
  if (healAllPending) interruptTurn(conversationId);
  const staleBefore = new Date(Date.now() - 25_000).toISOString();
  if (!activeTurns.has(conversationId)) await db
    .update(aiMessages)
    .set({ status: "failed", error: "回合连接中断，请重试" })
    .where(
      and(
        eq(aiMessages.conversationId, conversationId),
        eq(aiMessages.status, "pending"),
        ...(healAllPending ? [] : [lt(aiMessages.createdAt, staleBefore)]),
      ),
    );
  const [messages, actions] = await Promise.all([
    db.select().from(aiMessages).where(eq(aiMessages.conversationId, conversationId)).orderBy(asc(aiMessages.createdAt)),
    db.select().from(aiActions).where(eq(aiActions.conversationId, conversationId)).orderBy(asc(aiActions.createdAt)),
  ]);
  return c.json({ conversation, messages: messages.map(toMessage), actions: actions.map(toAction) });
});

conversationRoutes.get("/projects/:projectId/ai/conversations/:conversationId/messages/:messageId/skills/:skillId", async (c) => {
  const row = await createDatabase(c.env).select().from(aiMessages).where(and(
    eq(aiMessages.id, c.req.param("messageId")),
    eq(aiMessages.projectId, c.req.param("projectId")),
    eq(aiMessages.conversationId, c.req.param("conversationId")),
    eq(aiMessages.role, "assistant"),
  )).get();
  const skill = row && parseJson<AgentSkillSnapshot[]>(row.skillsJson, []).find((item) => item.id === c.req.param("skillId"));
  if (!skill) return c.json({ error: "SKILL_SNAPSHOT_NOT_FOUND", message: "没有找到本回合的技能快照。" }, 404);
  return c.json({ skill });
});

conversationRoutes.post("/projects/:projectId/ai/conversations/:conversationId/messages", async (c) => {
  const projectId = c.req.param("projectId");
  const conversationId = c.req.param("conversationId");
  const parsed = z.object({
    content: z.string().trim().min(1).max(12_000),
    skillIds: z.array(z.string().min(1).max(160)).max(3).optional(),
  }).safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: "INVALID_MESSAGE", issues: parsed.error.issues }, 400);
  const db = createDatabase(c.env);
  const conversation = await db
    .select()
    .from(aiConversations)
    .where(and(eq(aiConversations.id, conversationId), eq(aiConversations.projectId, projectId)))
    .get();
  if (!conversation) return c.json({ error: "CONVERSATION_NOT_FOUND" }, 404);
  if (conversation.status !== "active") {
    return c.json({ error: "CONVERSATION_CANCELLED", message: "该会话已结束，请新建会话后继续" }, 409);
  }
  if (activeTurns.has(conversationId)) return c.json({ error: "AGENT_TURN_BUSY", message: "上一回合仍在处理，请等待完成或结束会话。" }, 409);
  const turnController = new AbortController();
  activeTurns.set(conversationId, turnController);
  try {
    let selectedSkillIds = parsed.data.skillIds ? [...new Set(parsed.data.skillIds)] : undefined;
    let availableSkills = await getAvailableAgentSkills(c.env, selectedSkillIds);
    let message = parsed.data.content;
    if (message.startsWith("/skill:")) {
      const command = /^\/skill:([a-z0-9]+(?:-[a-z0-9]+)*)(?:\s+([\s\S]*))?$/.exec(message);
      const skill = command && availableSkills.find((item) => item.name === command[1]);
      if (!skill) {
        activeTurns.delete(conversationId);
        return c.json({ error: "SKILL_NOT_AVAILABLE", message: "技能不存在、已停用或不在本轮选择中，请重新选择技能。" }, 400);
      }
      selectedSkillIds = [skill.id];
      availableSkills = [skill];
      message = command[2]?.trim() || "请按所选技能的工作流程，结合当前项目证据提供分析。";
    }
    const skillSelectionJson = JSON.stringify(selectedSkillIds ?? null);

    // Heal turns left pending when SSE was aborted (Vite proxy / API hot-reload).
    await db
      .update(aiMessages)
      .set({ status: "failed", error: "上一回合连接中断，请重试" })
      .where(and(eq(aiMessages.conversationId, conversationId), eq(aiMessages.status, "pending")));

    const historyRows = await db
      .select({ role: aiMessages.role, content: aiMessages.content })
      .from(aiMessages)
      .where(and(eq(aiMessages.conversationId, conversationId), eq(aiMessages.status, "completed")))
      .orderBy(desc(aiMessages.createdAt))
      .limit(12);
    const now = new Date().toISOString();
    const userId = crypto.randomUUID();
    const assistantId = crypto.randomUUID();
    await db.insert(aiMessages).values([
      {
        id: userId,
        conversationId,
        projectId,
        role: "user",
        content: parsed.data.content,
        skillSelectionJson,
        citationsJson: "[]",
        model: null,
        status: "completed",
        error: "",
        createdAt: now,
      },
      {
        id: assistantId,
        conversationId,
        projectId,
        role: "assistant",
        content: "",
        skillSelectionJson,
        citationsJson: "[]",
        model: null,
        status: "pending",
        error: "",
        createdAt: new Date(Date.now() + 1).toISOString(),
      },
    ]);
    const title = conversation.title === "新研究对话" ? parsed.data.content.slice(0, 40) : conversation.title;
    await db.update(aiConversations).set({ title, updatedAt: now }).where(eq(aiConversations.id, conversationId));

    const turn: AgentTurnInput = {
      projectId,
      conversationId,
      assistantMessageId: assistantId,
      message,
      availableSkills,
      selectedSkillIds,
      history: historyRows.reverse().map((row) => ({ role: row.role as "user" | "assistant", content: row.content })),
    };

    const encoder = new TextEncoder();
    let settled = false;
    const markFailed = async (message: string, status: "failed" | "cancelled" = "failed") => {
      if (settled) return;
      settled = true;
      await db
        .update(aiMessages)
        .set({ content: "", status, error: message })
        .where(and(eq(aiMessages.id, assistantId), eq(aiMessages.status, "pending")));
    };

    const abortSignal = AbortSignal.any([c.req.raw.signal, turnController.signal, AbortSignal.timeout(300_000)]);
    const loadedSkills = new Map<string, AgentSkillSnapshot>();
    let skillWrites = Promise.resolve();
    turn.onSkillLoaded = (skill) => {
      abortSignal.throwIfAborted();
      loadedSkills.set(skill.id, skill);
      const skillsJson = JSON.stringify([...loadedSkills.values()]);
      skillWrites = skillWrites.then(async () => {
        abortSignal.throwIfAborted();
        const saved = await db.update(aiMessages).set({ skillsJson })
          .where(and(eq(aiMessages.id, assistantId), eq(aiMessages.status, "pending")))
          .returning({ id: aiMessages.id });
        if (saved.length !== 1) throw new Error("无法保存本回合技能快照，技能未加载，请重试。");
      });
      return skillWrites;
    };
    const onAbort = () => {
      if (activeTurns.get(conversationId) === turnController) {
        disposePiAgentSession(conversationId);
        activeTurns.delete(conversationId);
      }
      const cancelled = abortSignal.reason?.message === "用户取消";
      void markFailed(cancelled ? "用户取消" : abortSignal.reason?.name === "TimeoutError" ? normalizeAgentTransportError("回合超时") : "回合连接中断，请重试", cancelled ? "cancelled" : "failed").catch(() => {});
    };
    abortSignal.addEventListener("abort", onAbort, { once: true });
    if (abortSignal.aborted) onAbort();

    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        const heartbeat = setInterval(() => {
          try { controller.enqueue(encoder.encode(": keepalive\n\n")); } catch { /* disconnected */ }
        }, 15_000);
        const send = (event: string, data: unknown) => {
          try {
            controller.enqueue(encoder.encode(encodeSse(event, data)));
          } catch {
            // Client already disconnected.
          }
        };
        try {
          const result = await runPiAgentTurn(c.env, turn, (event: PiAgentStreamEvent) => {
            send(event.type, event);
          }, abortSignal);
          if (abortSignal.aborted) {
            await markFailed("连接中断（开发热重载、代理断开或浏览器取消）。请新建对话或重试。");
            return;
          }
          const completedAt = new Date().toISOString();
          const citationsJson = JSON.stringify(result.citations ?? []);
          await db
            .update(aiMessages)
            .set({
              content: result.reply,
              citationsJson,
              model: result.model,
              status: "completed",
              error: "",
            })
            .where(and(eq(aiMessages.id, assistantId), eq(aiMessages.status, "pending")));
          settled = true;
          await db.update(aiConversations).set({ updatedAt: completedAt }).where(eq(aiConversations.id, conversationId));
          const assistant = await db.select().from(aiMessages).where(eq(aiMessages.id, assistantId)).get();
          send("done", {
            message: toMessage(assistant!),
            actions: result.actions,
            mode: "research_agent",
          });
        } catch (error) {
          const code = error instanceof AgentConfigurationError ? error.code : "PI_AGENT_FAILED";
          const raw = error instanceof Error ? error.message : "Research Agent 暂时无法完成此回合";
          const message = normalizeAgentTransportError(abortSignal.aborted
            ? abortSignal.reason?.name === "TimeoutError" ? "回合超时" : abortSignal.reason?.message === "用户取消" ? "用户取消" : "回合连接中断，请重试"
            : raw);
          await markFailed(message);
          send("error", { code, message, assistantMessageId: assistantId, retryable: true });
        } finally {
          clearInterval(heartbeat);
          if (activeTurns.get(conversationId) === turnController) activeTurns.delete(conversationId);
          abortSignal.removeEventListener("abort", onAbort);
          try {
            controller.close();
          } catch {
            // already closed
          }
        }
      },
      cancel() {
        turnController.abort(new DOMException("回合连接中断，请重试", "AbortError"));
      },
    });

    return c.newResponse(stream, {
      status: 200,
      headers: {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      },
    });
  } catch (error) {
    if (activeTurns.get(conversationId) === turnController) activeTurns.delete(conversationId);
    if (error instanceof AgentSkillError) return c.json({ error: error.code, message: error.message }, error.status);
    throw error;
  }
});

conversationRoutes.post("/projects/:projectId/ai/conversations/:conversationId/cancel", async (c) => {
  const projectId = c.req.param("projectId");
  const conversationId = c.req.param("conversationId");
  const db = createDatabase(c.env);
  const conversation = await db
    .select({ id: aiConversations.id })
    .from(aiConversations)
    .where(and(eq(aiConversations.id, conversationId), eq(aiConversations.projectId, projectId)))
    .get();
  if (!conversation) return c.json({ error: "CONVERSATION_NOT_FOUND" }, 404);
  interruptTurn(conversationId, "用户取消");
  const now = new Date().toISOString();
  await db.update(aiConversations).set({ status: "cancelled", updatedAt: now }).where(eq(aiConversations.id, conversationId));
  await db
    .update(aiMessages)
    .set({ status: "cancelled", error: "用户取消" })
    .where(and(eq(aiMessages.conversationId, conversationId), eq(aiMessages.status, "pending")));
  return c.json({ id: conversationId, status: "cancelled" });
});

conversationRoutes.delete("/projects/:projectId/ai/conversations/:conversationId", async (c) => {
  const projectId = c.req.param("projectId");
  const conversationId = c.req.param("conversationId");
  const db = createDatabase(c.env);
  const conversation = await db
    .select({ id: aiConversations.id })
    .from(aiConversations)
    .where(and(eq(aiConversations.id, conversationId), eq(aiConversations.projectId, projectId)))
    .get();
  if (!conversation) return c.json({ error: "CONVERSATION_NOT_FOUND" }, 404);
  interruptTurn(conversationId, "用户取消");
  await db.delete(aiActions).where(eq(aiActions.conversationId, conversationId));
  await db.delete(aiMessages).where(eq(aiMessages.conversationId, conversationId));
  await db.delete(aiConversations).where(eq(aiConversations.id, conversationId));
  return c.json({ id: conversationId, deleted: true });
});
