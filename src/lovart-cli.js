import { execFileSync, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(here, "..");

export const defaultScriptPath = path.join(
  projectRoot,
  "vendor",
  "lovart-skill",
  "scripts",
  "agent_skill.py",
);

export const defaultOutputDir = path.join(projectRoot, "downloads");

export function resolvePython(
  env = process.env,
  { platform = process.platform, fileExists = existsSync } = {},
) {
  if (env.LOVART_PYTHON) return env.LOVART_PYTHON;

  if (platform === "win32") {
    if (env.USERPROFILE) {
      const bundledPython = path.join(
        env.USERPROFILE,
        ".cache",
        "codex-runtimes",
        "codex-primary-runtime",
        "dependencies",
        "python",
        "python.exe",
      );
      if (fileExists(bundledPython)) return bundledPython;
    }
    return "py";
  }

  return "python3";
}

export function readWindowsUserVariable(name) {
  try {
    const output = execFileSync("reg.exe", ["query", "HKCU\\Environment", "/v", name], {
      encoding: "utf8",
      windowsHide: true,
      stdio: ["ignore", "pipe", "ignore"],
    });
    const line = output.split(/\r?\n/).find((candidate) => candidate.includes(name));
    const match = line?.match(/^\s*\S+\s+REG_\w+\s+(.*)$/);
    return match?.[1]?.trim() || "";
  } catch {
    return "";
  }
}

export function resolveLovartEnv(
  env = process.env,
  { platform = process.platform, readUserVariable = readWindowsUserVariable } = {},
) {
  const resolved = { ...env };
  if (platform !== "win32") return resolved;

  for (const name of ["LOVART_ACCESS_KEY", "LOVART_SECRET_KEY"]) {
    const currentUserValue = readUserVariable(name);
    if (currentUserValue) resolved[name] = currentUserValue;
  }
  return resolved;
}

export function resolveLovartChildEnv(env = process.env, options = {}) {
  return {
    ...resolveLovartEnv(env, options),
    PYTHONUTF8: "1",
    PYTHONIOENCODING: "utf-8",
  };
}

function parseOutput(stdout) {
  const text = stdout.trim();
  if (!text) return {};

  try {
    return JSON.parse(text);
  } catch {
    return { output: text };
  }
}

export async function runLovart(
  args,
  {
    python,
    scriptPath = process.env.LOVART_SKILL_SCRIPT || defaultScriptPath,
    outputDir = process.env.LOVART_OUTPUT_DIR || defaultOutputDir,
    env = process.env,
  } = {},
) {
  await mkdir(outputDir, { recursive: true });
  const pythonCommand = python || resolvePython(env);

  return new Promise((resolve, reject) => {
    const child = spawn(pythonCommand, [scriptPath, ...args], {
      env: resolveLovartChildEnv(env),
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve(parseOutput(stdout));
        return;
      }

      const message = stderr.trim() || stdout.trim() || `Lovart command exited with code ${code}`;
      reject(new Error(message));
    });
  });
}

export function generationArgs(input, outputDir = defaultOutputDir) {
  const args = ["chat", "--prompt", input.prompt, "--json", "--download", "--output-dir", outputDir];

  if (input.project_id) args.push("--project-id", input.project_id);
  if (input.thread_id) args.push("--thread-id", input.thread_id);
  if (input.attachments?.length) args.push("--attachments", ...input.attachments);
  if (input.reasoning_mode) args.push("--mode", input.reasoning_mode);
  if (input.prefer_models) args.push("--prefer-models", JSON.stringify(input.prefer_models));
  if (input.include_tools?.length) args.push("--include-tools", ...input.include_tools);

  return args;
}

export function confirmArgs(threadId, outputDir = defaultOutputDir) {
  return ["confirm", "--thread-id", threadId, "--json", "--download", "--output-dir", outputDir];
}

export function resultArgs(threadId, outputDir = defaultOutputDir) {
  return ["result", "--thread-id", threadId, "--json", "--download", "--output-dir", outputDir];
}
