// Build a self-contained macOS Apple Silicon parser. Models stay in user data.
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

if (process.platform !== "darwin" || process.arch !== "arm64") {
  throw new Error("This parser build requires macOS arm64.");
}

const root = path.resolve(import.meta.dirname, "..");
const target = path.join(root, "build", "mineru-runtime");
const lock = path.join(root, "scripts", "mineru", "requirements-macos-arm64.lock");
const pythonVersion = "3.13.14";
const fingerprint = createHash("sha256").update(await readFile(lock)).update(pythonVersion).digest("hex");

async function run(command, args, capture = false) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: capture ? ["ignore", "pipe", "inherit"] : "inherit" });
    let output = "";
    if (capture) child.stdout.on("data", (chunk) => { output += chunk; });
    child.once("error", reject);
    child.once("close", (code) => code === 0 ? resolve(output.trim()) : reject(new Error(`${command} exited ${code}`)));
  });
}

const existing = await readFile(path.join(target, "runtime.json"), "utf8").then(JSON.parse).catch(() => null);
if (existing?.fingerprint !== fingerprint) {
  await run("uv", ["python", "install", pythonVersion]);
  const sourcePython = await run("uv", ["python", "find", pythonVersion], true);
  if (!path.isAbsolute(sourcePython)) throw new Error("uv did not return an absolute Python path");
  await rm(target, { recursive: true, force: true });
  await mkdir(path.dirname(target), { recursive: true });
  await cp(path.dirname(path.dirname(sourcePython)), target, { recursive: true });
  await run("uv", ["pip", "install", "--python", path.join(target, "bin", "python3.13"),
    "--target", path.join(target, "lib", "python3.13", "site-packages"),
    "--require-hashes", "--only-binary", ":all:", "-r", lock]);
}

await cp(path.join(root, "scripts", "mineru", "runner.py"), path.join(target, "runner.py"));
await cp(lock, path.join(target, "requirements.lock"));
await run(path.join(target, "bin", "python3.13"), ["-I", path.join(target, "runner.py"), "check"]);
await writeFile(path.join(target, "runtime.json"), JSON.stringify({
  python: pythonVersion, mineru: "3.4.2", torch: "2.8.0", fingerprint,
}, null, 2));
console.log("[mineru-runtime] macOS arm64 runtime ready (models and user data excluded)");
