// @vitest-environment node
import { build } from "esbuild";
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { expect, it } from "vitest";

it("bundled server loads all Nature resources beside its module from another working directory", async () => {
  const root = fileURLToPath(new URL("../../", import.meta.url));
  const temporaryRoot = mkdtempSync(join(tmpdir(), "argumesh-skill-bundle-"));
  const output = join(temporaryRoot, "sidecar", "server.mjs");
  try {
    await build({ entryPoints: [join(root, "server", "skills", "builtin.ts")], outfile: output,
      bundle: true, platform: "node", format: "esm", target: "node20", logLevel: "silent" });
    cpSync(join(root, "server", "skills", "nature"), join(temporaryRoot, "sidecar", "nature"), { recursive: true });
    const otherDirectory = join(temporaryRoot, "different-cwd");
    mkdirSync(otherDirectory);
    const result = spawnSync(process.execPath, ["--input-type=module", "-e", `
      import assert from "node:assert/strict";
      const { BUILTIN_AGENT_SKILLS: skills } = await import(${JSON.stringify(pathToFileURL(output).href)});
      assert.equal(skills.length, 11);
      assert(skills.every(skill => skill.files.some(file => file.path === "SKILL.md" && file.content === skill.content)));
      const reviewer = skills.find(skill => skill.name === "nature-reviewer");
      assert(reviewer.files.some(file => file.path === "references/review-axes.md" && file.content.length > 0));
      const citation = skills.find(skill => skill.name === "nature-citation");
      assert(citation.files.some(file => file.path === "scripts/nature-citation-source-part-1.txt"));
      console.log(JSON.stringify({ count: skills.length, resources: skills.reduce((count, skill) => count + skill.files.length, 0) }));
    `], { cwd: otherDirectory, encoding: "utf8", timeout: 15_000, windowsHide: true });
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
    const summary = JSON.parse(result.stdout.trim());
    expect(summary.count).toBe(11);
    expect(summary.resources).toBeGreaterThan(200);
  } finally {
    if (dirname(temporaryRoot) === resolve(tmpdir()) && basename(temporaryRoot).startsWith("argumesh-skill-bundle-")) {
      rmSync(temporaryRoot, { recursive: true, force: true });
    }
  }
});
