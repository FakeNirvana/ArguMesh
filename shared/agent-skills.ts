/** Skills are instruction packages. They never grant additional execution tools. */
export interface AgentSkillFile {
  path: string;
  content: string;
}

export interface AgentSkillSummary {
  id: string;
  name: string;
  description: string;
  source: "builtin" | "user";
  enabled: boolean;
  version: string;
  installedAt: string | null;
  fileCount: number;
  warnings: string[];
}

export interface AgentSkill extends AgentSkillSummary {
  files: AgentSkillFile[];
}

/** Content is captured on use so uninstalling a skill cannot rewrite a past turn. */
export interface AgentSkillSnapshot {
  id: string;
  name: string;
  description: string;
  source: AgentSkillSummary["source"];
  version: string;
  files: AgentSkillFile[];
  loadedAt: string;
}

export type AgentSkillUsage = Omit<AgentSkillSnapshot, "files" | "description">;
