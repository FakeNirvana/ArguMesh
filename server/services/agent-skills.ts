import { createHash } from "node:crypto";
import { extname } from "node:path";
import { eq } from "drizzle-orm";
import { parseFrontmatter } from "@earendil-works/pi-coding-agent";
import { z } from "zod";
import type { AgentSkill, AgentSkillFile, AgentSkillSummary } from "../../shared/agent-skills";
import { createDatabase } from "../db/client";
import { agentSkills } from "../db/schema";
import { BUILTIN_AGENT_SKILLS } from "../skills/builtin";
import type { AppBindings } from "../types";

export const AGENT_SKILL_LIMITS = {
  files: 64,
  fileBytes: 64 * 1024,
  packageBytes: 512 * 1024,
  bodyCharacters: 32_000,
  installed: 50,
} as const;

export class AgentSkillError extends Error {
  constructor(public readonly code: string, message: string, public readonly status: 400 | 404 | 409 | 413 = 400) {
    super(message);
  }
}

const textExtensions = new Set([".md", ".txt", ".json", ".jsonl", ".yaml", ".yml", ".csv", ".tsv", ".rst", ".bib", ".tex", ".toml", ".ini", ".py", ".sh", ".bash", ".ps1", ".js", ".mjs", ".cjs", ".ts", ".tsx", ".r", ".ipynb"]);
const scriptExtensions = new Set([".py", ".sh", ".bash", ".ps1", ".js", ".mjs", ".cjs", ".ts", ".tsx", ".r", ".ipynb"]);
const skillNameSchema = z.string().trim().min(1).max(64).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
const metadataSchema = z.object({ name: skillNameSchema, description: z.string().trim().min(1).max(1024) });
const installSchema = z.array(z.object({ path: z.string().min(1).max(240), content: z.string() }).strict()).min(1).max(AGENT_SKILL_LIMITS.files);

/** Logical package paths only. This is never a path on the host filesystem. */
export function validateSkillResourcePath(path: string): boolean {
  return path.length > 0 && path.length <= 240 && path.split("/").every((part) =>
    part.length > 0 && part !== "." && part !== ".." && !part.startsWith(".") &&
    /^[\p{L}\p{N}_ .()-]+$/u.test(part),
  ) && textExtensions.has(extname(path).toLowerCase());
}

export function skillInstructions(content: string): string {
  const normalized = content.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
  const header = /^---\n([\s\S]*?)\n---(?:\n|$)/.exec(normalized);
  if (!header || Buffer.byteLength(header[1], "utf8") > 8192) {
    throw new AgentSkillError("INVALID_SKILL", "SKILL.md 必须包含有效的 YAML 开头信息（name、description）。");
  }
  try {
    const parsed = parseFrontmatter(normalized);
    if (!parsed.body.trim() || parsed.body.length > AGENT_SKILL_LIMITS.bodyCharacters) {
      throw new AgentSkillError("INVALID_SKILL", "技能正文不能为空，且最多 32000 个字符。");
    }
    return parsed.body.trim();
  } catch (error) {
    if (error instanceof AgentSkillError) throw error;
    throw new AgentSkillError("INVALID_SKILL", "无法解析 SKILL.md 的 YAML 开头信息。");
  }
}

export function skillPackageVersion(files: AgentSkillFile[]): string {
  return createHash("sha256").update(JSON.stringify(files)).digest("hex");
}

function packageWarnings(files: AgentSkillFile[]): string[] {
  return files.some((file) => file.path.startsWith("scripts/") || scriptExtensions.has(extname(file.path).toLowerCase()))
    ? ["此技能包含脚本；Research Agent 仅使用说明与文本资料，不执行这些脚本。"] : [];
}

/** Validate the complete upload before any database write. Never inspect local paths. */
export function prepareSkillInstall(input: unknown): AgentSkill {
  const parsed = installSchema.safeParse(input);
  if (!parsed.success) throw new AgentSkillError("INVALID_SKILL_FILES", "请选择 1–64 个文本文件，并保留技能目录结构。");
  let files = parsed.data;
  let bytes = 0;
  const seen = new Set<string>();
  for (const file of files) {
    if (!validateSkillResourcePath(file.path)) throw new AgentSkillError("INVALID_SKILL_PATH", "技能文件路径无效，或文件类型不受支持。");
    const key = file.path.toLowerCase();
    if (seen.has(key)) throw new AgentSkillError("DUPLICATE_SKILL_PATH", "技能包中存在重复文件路径。");
    seen.add(key);
    const size = Buffer.byteLength(file.content, "utf8");
    if (size > AGENT_SKILL_LIMITS.fileBytes) throw new AgentSkillError("SKILL_TOO_LARGE", "每个技能文件最多 64 KiB。", 413);
    bytes += size;
    if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\uFFFD]/.test(file.content)) {
      throw new AgentSkillError("BINARY_SKILL_FILE", "技能包仅接受有效的 UTF-8 文本文件。");
    }
  }
  if (bytes > AGENT_SKILL_LIMITS.packageBytes) throw new AgentSkillError("SKILL_TOO_LARGE", "技能包文本总大小最多 512 KiB。", 413);
  if (!files.some((file) => file.path === "SKILL.md")) {
    const prefix = `${files[0].path.split("/")[0]}/`;
    if (files.every((file) => file.path.startsWith(prefix)) && files.some((file) => file.path === `${prefix}SKILL.md`)) {
      files = files.map((file) => ({ ...file, path: file.path.slice(prefix.length) }));
    }
  }
  const documents = files.filter((file) => file.path.split("/").at(-1)?.toLowerCase() === "skill.md");
  if (documents.length !== 1 || documents[0].path !== "SKILL.md") {
    throw new AgentSkillError("INVALID_SKILL_ROOT", "请选择一个技能的文件夹，根目录必须有且仅有一份 SKILL.md。");
  }
  const content = documents[0].content;
  skillInstructions(content);
  let metadata: z.infer<typeof metadataSchema>;
  try {
    metadata = metadataSchema.parse(parseFrontmatter(content).frontmatter);
  } catch {
    throw new AgentSkillError("INVALID_SKILL_METADATA", "技能 name 需为小写英文、数字和单连字符，最长 64 字符；description 需为 1–1024 字符的文字。");
  }
  files.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  return {
    id: `user:${metadata.name}`, ...metadata, source: "user", enabled: true,
    version: skillPackageVersion(files), installedAt: new Date().toISOString(),
    fileCount: files.length, files, warnings: packageWarnings(files),
  };
}

function builtinSkill(name: string, enabled: boolean): AgentSkill | null {
  const builtin = BUILTIN_AGENT_SKILLS.find((skill) => skill.name === name);
  if (!builtin) return null;
  const files = builtin.files.map((file) => ({ ...file }));
  return { id: `builtin:${name}`, name, description: builtin.description, source: "builtin", enabled,
    version: skillPackageVersion(files), installedAt: null, fileCount: files.length, files, warnings: packageWarnings(files) };
}

function userSkill(row: typeof agentSkills.$inferSelect): AgentSkill {
  let files: AgentSkillFile[];
  try {
    files = installSchema.parse(JSON.parse(row.filesJson));
  } catch {
    throw new AgentSkillError("INVALID_SKILL_STORAGE", "已安装技能内容损坏，请卸载后重新安装。", 409);
  }
  return { id: row.id, name: row.name, description: row.description, source: "user", enabled: row.enabled,
    version: row.version, installedAt: row.installedAt, fileCount: files.length, files, warnings: packageWarnings(files) };
}

export async function listAgentSkills(env: AppBindings): Promise<AgentSkillSummary[]> {
  const rows = await createDatabase(env).select().from(agentSkills);
  const overrides = new Map(rows.filter((row) => row.source === "builtin").map((row) => [row.id, row.enabled]));
  const userNames = new Set(rows.filter((row) => row.source === "user").map((row) => row.name));
  const skills = [
    ...BUILTIN_AGENT_SKILLS.filter((skill) => !userNames.has(skill.name)).map((skill) => builtinSkill(skill.name, overrides.get(`builtin:${skill.name}`) ?? true)!),
    ...rows.filter((row) => row.source === "user").map(userSkill).sort((a, b) => a.name.localeCompare(b.name)),
  ];
  return skills.map(({ files: _files, ...summary }) => summary);
}

export async function getAgentSkill(env: AppBindings, id: string): Promise<AgentSkill | null> {
  const row = await createDatabase(env).select().from(agentSkills).where(eq(agentSkills.id, id)).get();
  if (id.startsWith("builtin:")) {
    const name = id.slice("builtin:".length);
    const installed = await createDatabase(env).select({ source: agentSkills.source }).from(agentSkills).where(eq(agentSkills.name, name)).get();
    // Existing user content, including a disabled installation, must never be bypassed.
    if (installed?.source === "user") return null;
    return builtinSkill(name, row?.enabled ?? true);
  }
  return row?.source === "user" ? userSkill(row) : null;
}

export async function getAvailableAgentSkills(env: AppBindings, ids?: string[]): Promise<AgentSkill[]> {
  if (ids && new Set(ids).size !== ids.length) throw new AgentSkillError("INVALID_SKILL_SELECTION", "请勿重复选择同一个技能。");
  const selected = ids ?? (await listAgentSkills(env)).filter((skill) => skill.enabled).map((skill) => skill.id);
  const skills = await Promise.all(selected.map((id) => getAgentSkill(env, id)));
  for (let index = 0; index < skills.length; index++) {
    if (!skills[index]) throw new AgentSkillError("SKILL_NOT_FOUND", "所选技能不存在或已卸载，请重新选择。", 404);
    if (!skills[index]!.enabled) throw new AgentSkillError("SKILL_DISABLED", "所选技能已停用，请启用后再使用。", 409);
  }
  return skills as AgentSkill[];
}
