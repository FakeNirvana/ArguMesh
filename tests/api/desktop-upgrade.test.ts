// @vitest-environment node
import { createClient } from "@libsql/client";
import { expect, it } from "vitest";
import app from "../../server/index";
import { createTestContext } from "./helpers";

it("upgrades a desktop database without skills during concurrent first requests and preserves user data", async () => {
  const context = await createTestContext();
  const client = createClient({ url: context.dbUrl });
  const bindings = { ...context.bindings, ARGUMESH_DESKTOP: "1" };
  try {
    const savedConfig = await app.request("/api/ai/config", {
      method: "PUT", headers: { "content-type": "application/json" },
      body: JSON.stringify({ baseUrl: "http://127.0.0.1:19999/v1", apiKey: "upgrade-fixture-key", model: "local-upgrade-test" }),
    }, context.bindings);
    expect(savedConfig.status).toBe(200);
    await client.execute("INSERT INTO projects (id, name, created_at) VALUES ('upgrade-project', 'Preserved project', '2026-10-29')");
    await client.execute("INSERT INTO ai_conversations (id, project_id, created_at, updated_at) VALUES ('upgrade-conversation', 'upgrade-project', '2026-10-29', '2026-10-29')");
    await client.execute("INSERT INTO ai_messages (id, project_id, conversation_id, role, content, created_at) VALUES ('upgrade-message', 'upgrade-project', 'upgrade-conversation', 'user', 'Preserved message', '2026-10-29')");
    await client.execute("DROP TABLE agent_skills");
    await client.execute("ALTER TABLE ai_messages DROP COLUMN skills_json");
    await client.execute("ALTER TABLE ai_messages DROP COLUMN skill_selection_json");
    await client.execute("DELETE FROM __drizzle_migrations WHERE hash = '0015_agent_skills'");
    const configuration = await client.execute("SELECT * FROM ai_settings");

    const responses = await Promise.all([
      app.request("/api/agent/skills", {}, bindings),
      app.request("/api/projects/upgrade-project/ai/conversations/upgrade-conversation", {}, bindings),
    ]);
    expect(responses.map((response) => response.status)).toEqual([200, 200]);
    const skills = await responses[0].json() as { skills: Array<{ source: string }> };
    expect(skills.skills.filter((skill) => skill.source === "builtin")).toHaveLength(11);
    const message = await client.execute("SELECT content, skills_json, skill_selection_json FROM ai_messages WHERE id = 'upgrade-message'");
    expect(message.rows[0]).toMatchObject({ content: "Preserved message", skills_json: "[]", skill_selection_json: "null" });
    expect((await client.execute("SELECT name FROM projects WHERE id = 'upgrade-project'")).rows[0].name).toBe("Preserved project");
    expect((await client.execute("SELECT * FROM ai_settings")).rows).toEqual(configuration.rows);
    expect((await app.request("/api/agent/skills", {}, bindings)).status).toBe(200);
    // A distinct connection key for the same Windows file exercises a fresh migration cache.
    const reopened = { ...bindings, DATABASE_URL: context.dbUrl.replaceAll("\\", "/") };
    expect((await app.request("/api/agent/skills", {}, reopened)).status).toBe(200);
    expect((await client.execute("SELECT count(*) AS total FROM __drizzle_migrations WHERE hash = '0015_agent_skills'")).rows[0].total).toBe(1);
  } finally {
    client.close();
    context.cleanup();
  }
});
