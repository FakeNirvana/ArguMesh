import { readFileSync, realpathSync, statSync } from "node:fs";
import { relative, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import type { BuiltinAgentSkill } from "./builtin";
import type { AgentSkillFile } from "../../shared/agent-skills";

interface NatureCatalogEntry {
  name: string;
  description: string;
  resources: string[];
}

/** Only the source-controlled index supplies these paths; no host scanning or execution. */
export function loadBundledNatureSkills(): BuiltinAgentSkill[] {
  const root = new URL("./nature/", import.meta.url);
  const rootPath = realpathSync(fileURLToPath(root));
  const catalog: unknown = JSON.parse(readFileSync(new URL("catalog.json", root), "utf8"));
  if (!Array.isArray(catalog)) throw new Error("Bundled Nature skill catalog is invalid.");
  const names = new Set<string>();
  return catalog.map((raw: unknown): BuiltinAgentSkill => {
    const entry = raw as NatureCatalogEntry | null;
    if (!entry || typeof entry.name !== "string" || !/^nature-[a-z0-9]+(?:-[a-z0-9]+)*$/.test(entry.name) || names.has(entry.name) ||
      typeof entry.description !== "string" || !entry.description.trim() || entry.description.length > 1024 ||
      !Array.isArray(entry.resources) || !entry.resources.length || entry.resources.length > 64) {
      throw new Error("Bundled Nature skill metadata is invalid.");
    }
    names.add(entry.name);
    const paths = new Set<string>();
    let bytes = 0;
    const files = entry.resources.map((path): AgentSkillFile => {
      if (typeof path !== "string" || path.length > 240 || paths.has(path.toLowerCase()) ||
        !path.split("/").every((part) => part && part !== "." && part !== ".." && !part.startsWith(".") && /^[\p{L}\p{N}_ .()-]+$/u.test(part))) {
        throw new Error("Bundled Nature skill resource path is invalid.");
      }
      paths.add(path.toLowerCase());
      const resource = new URL(`${entry.name}/${path.split("/").map(encodeURIComponent).join("/")}`, root);
      const actualPath = realpathSync(fileURLToPath(resource));
      const withinRoot = relative(rootPath, actualPath);
      if (!withinRoot || withinRoot.startsWith("..") || isAbsolute(withinRoot) || !statSync(actualPath).isFile()) {
        throw new Error("Bundled Nature skill resource is outside its asset directory.");
      }
      const content = readFileSync(actualPath, "utf8").replace(/\r\n?/g, "\n");
      const size = Buffer.byteLength(content, "utf8");
      if (size > 64 * 1024) throw new Error("Bundled Nature skill resource exceeds its text limit.");
      bytes += size;
      return { path, content };
    }).sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
    const document = files.find((file) => file.path === "SKILL.md");
    if (!document || bytes > 512 * 1024) throw new Error("Bundled Nature skill package is incomplete or exceeds its limit.");
    return { name: entry.name, description: entry.description, content: document.content, files };
  });
}
