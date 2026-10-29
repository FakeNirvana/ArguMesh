import { loadBundledNatureSkills } from "./nature-bundle";
import type { AgentSkillFile } from "../../shared/agent-skills";

export interface BuiltinAgentSkill {
  name: string;
  description: string;
  /** Complete root document, retained for SDK and preview compatibility. */
  content: string;
  files: AgentSkillFile[];
}

/** User-provided third-party Nature workflows, shipped as read-only text resources. */
export const BUILTIN_AGENT_SKILLS: BuiltinAgentSkill[] = loadBundledNatureSkills();
