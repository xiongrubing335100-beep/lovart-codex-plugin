#!/usr/bin/env node
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import {
  confirmArgs,
  defaultOutputDir,
  generationArgs,
  resultArgs,
  runLovart,
} from "./lovart-cli.js";

const server = new McpServer({ name: "lovart-mcp", version: "0.1.0" });
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function response(data) {
  return {
    content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
    structuredContent: data && typeof data === "object" && !Array.isArray(data) ? data : { result: data },
  };
}

function failure(error) {
  return {
    isError: true,
    content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }],
  };
}

async function call(args) {
  try {
    return response(await runLovart(args));
  } catch (error) {
    return failure(error);
  }
}

function openCredentialSetup() {
  const scriptPath = path.join(projectRoot, "scripts", "configure-lovart-credentials.ps1");
  const powershell = path.join(
    process.env.SystemRoot || "C:\\Windows",
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe",
  );
  const child = spawn(
    powershell,
    ["-NoProfile", "-ExecutionPolicy", "Bypass", "-STA", "-WindowStyle", "Hidden", "-File", scriptPath],
    { detached: true, stdio: "ignore", windowsHide: true },
  );
  child.unref();
  return response({ opened: true, message: "Lovart key setup window opened." });
}

const generationSchema = {
  prompt: z.string().min(1).describe("Pass the user's original Lovart request without rewriting it."),
  project_id: z.string().optional().describe("Lovart project ID. Omit to use the active local project."),
  thread_id: z.string().optional().describe("Reuse a Lovart thread to continue editing with context."),
  attachments: z.array(z.string()).optional().describe("Lovart CDN URLs returned by lovart_upload."),
  reasoning_mode: z.enum(["fast", "thinking"]).optional(),
  prefer_models: z.record(z.array(z.string())).optional().describe("Soft model preferences keyed by IMAGE or VIDEO."),
  include_tools: z.array(z.string()).optional().describe("Hard constraint to specific Lovart tools/models."),
};

server.registerTool(
  "lovart_generate",
  {
    description:
      "Generate or edit images, videos, audio, or 3D assets with Lovart. Downloads completed artifacts. If final_status is pending_confirmation, do not confirm automatically; show the estimated credit cost and ask the user first.",
    inputSchema: generationSchema,
  },
  async (input) => call(generationArgs(input, process.env.LOVART_OUTPUT_DIR || defaultOutputDir)),
);

server.registerTool(
  "lovart_confirm",
  {
    description:
      "Confirm a pending high-cost Lovart operation and download its result. Call only after the user explicitly accepts the displayed credit cost.",
    inputSchema: { thread_id: z.string().min(1) },
  },
  async ({ thread_id }) => call(confirmArgs(thread_id, process.env.LOVART_OUTPUT_DIR || defaultOutputDir)),
);

server.registerTool(
  "lovart_status",
  {
    description: "Check the status of a Lovart generation thread.",
    inputSchema: { thread_id: z.string().min(1) },
  },
  async ({ thread_id }) => call(["status", "--thread-id", thread_id]),
);

server.registerTool(
  "lovart_result",
  {
    description: "Retrieve and download the latest artifacts for a Lovart thread.",
    inputSchema: { thread_id: z.string().min(1) },
  },
  async ({ thread_id }) => call(resultArgs(thread_id, process.env.LOVART_OUTPUT_DIR || defaultOutputDir)),
);

server.registerTool(
  "lovart_upload",
  {
    description: "Upload a local image or video to Lovart and return a CDN URL for use as an attachment.",
    inputSchema: { file_path: z.string().min(1) },
  },
  async ({ file_path }) => call(["upload", "--file", path.resolve(file_path)]),
);

server.registerTool(
  "lovart_config",
  {
    description: "Read local Lovart state, including the active project. Does not expose credentials.",
    inputSchema: {},
  },
  async () => call(["config", "--json"]),
);

server.registerTool(
  "lovart_configure_credentials",
  {
    description:
      "Open a simple password-style window for adding or replacing Lovart AK/SK credentials. Keys stay local and are never returned to chat. No Codex restart is required after saving.",
    inputSchema: {},
  },
  async () => openCredentialSetup(),
);

server.registerTool(
  "lovart_projects",
  {
    description: "List locally known Lovart projects and the active project.",
    inputSchema: {},
  },
  async () => call(["projects", "--json"]),
);

server.registerTool(
  "lovart_project_add",
  {
    description: "Add an existing Lovart project to local state and make it active.",
    inputSchema: { project_id: z.string().min(1), name: z.string().optional() },
  },
  async ({ project_id, name }) => call(["project-add", "--project-id", project_id, ...(name ? ["--name", name] : [])]),
);

server.registerTool(
  "lovart_create_project",
  {
    description: "Create a new Lovart project and make it active.",
    inputSchema: {},
  },
  async () => call(["create-project"]),
);

server.registerTool(
  "lovart_threads",
  {
    description: "List saved Lovart conversation threads, optionally filtered by project.",
    inputSchema: { project_id: z.string().optional() },
  },
  async ({ project_id }) => call(["threads", "--json", ...(project_id ? ["--project-id", project_id] : [])]),
);

server.registerTool(
  "lovart_set_billing_mode",
  {
    description: "Set Lovart account billing mode. fast costs credits; unlimited may queue.",
    inputSchema: { mode: z.enum(["fast", "unlimited"]) },
  },
  async ({ mode }) => call(["set-mode", mode === "fast" ? "--fast" : "--unlimited"]),
);

server.registerTool(
  "lovart_query_billing_mode",
  {
    description: "Query the current persistent Lovart billing mode.",
    inputSchema: {},
  },
  async () => call(["query-mode"]),
);

await server.connect(new StdioServerTransport());
