import type { Client } from "@libsql/client";

export const AGENT_SKILLS_MIGRATION_HASH = "0015_agent_skills";

/** Shared by the custom migration runner and desktop upgrades; preserves existing rows. */
export async function applyAgentSkillsMigration(client: Pick<Client, "execute">): Promise<void> {
  const applied = await client.execute({ sql: "SELECT 1 FROM __drizzle_migrations WHERE hash = ? LIMIT 1", args: [AGENT_SKILLS_MIGRATION_HASH] });
  if (applied.rows.length) return;
  await client.execute(`CREATE TABLE IF NOT EXISTS agent_skills (
    id text PRIMARY KEY NOT NULL,
    name text NOT NULL,
    description text NOT NULL DEFAULT '',
    source text NOT NULL CHECK (source IN ('builtin', 'user')),
    files_json text NOT NULL DEFAULT '[]',
    enabled integer NOT NULL DEFAULT 1,
    version text NOT NULL DEFAULT '',
    installed_at text,
    updated_at text NOT NULL
  )`);
  await client.execute("CREATE UNIQUE INDEX IF NOT EXISTS agent_skills_name_uniq ON agent_skills (name)");
  const columns = await client.execute("PRAGMA table_info(ai_messages)");
  const names = new Set(columns.rows.map((column) => String(column.name)));
  if (!names.has("skills_json")) await client.execute("ALTER TABLE ai_messages ADD COLUMN skills_json text NOT NULL DEFAULT '[]'");
  if (!names.has("skill_selection_json")) await client.execute("ALTER TABLE ai_messages ADD COLUMN skill_selection_json text NOT NULL DEFAULT 'null'");
  await client.execute({ sql: "INSERT OR IGNORE INTO __drizzle_migrations (hash, created_at) VALUES (?, ?)", args: [AGENT_SKILLS_MIGRATION_HASH, 15] });
}
