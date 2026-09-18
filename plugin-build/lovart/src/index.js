#!/usr/bin/env node
import path from 'node:path';
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { runLovart } from "./lovart-cli.js";
import { createCredentialSetup } from './credential-setup.js';

import { createProbeServer } from "./server.js";
import { GenerationCards } from "./generation-cards.js";
import { cardStateDir, mediaOutputDir } from "./paths.js";
const {server,store,drafts} = createProbeServer(cardStateDir, new McpServer({ name: "lovart-mcp", version: "0.1.0" }));
const cards = new GenerationCards({store,drafts,execute:runLovart,outputDir:mediaOutputDir,stateDir:cardStateDir});
async function cardCall(action) {try {return response(await action());} catch (error) {return failure(error);}}

const credentialSetup = createCredentialSetup();

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

const generationSchema = {
  request_id: z.string().uuid().optional(),
  prompt: z.string().min(1).max(20000).describe("Only the image/video creative prompt, verbatim. Exclude model selection, delivery instructions, and wrapper text such as '提示词如下'."),
  requested_model: z.string().min(1).max(200).optional().describe("User-requested model name and version, e.g. MJ v8.2. Kept separate from the creative prompt; not evidence of the actual output model."),
  execution_instructions: z.string().min(1).max(5000).optional().describe("Agent execution/delivery requirements, e.g. return every original output without selection. Never put these in prompt."),
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
  async (input) => cardCall(() => cards.generate(input)),
);

server.registerTool(
  "lovart_confirm",
  {
    description:
      "Confirm a pending high-cost Lovart operation and download its result. Call only after the user explicitly accepts the displayed credit cost.",
    inputSchema: { thread_id: z.string().min(1) },
  },
  async ({ thread_id }) => cardCall(() => cards.resume(thread_id,true)),
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
  async ({ thread_id }) => cardCall(() => cards.resume(thread_id)),
);

server.registerTool(
  "lovart_upload",
  {
    description: "Upload a local image or video to Lovart and return a CDN URL for use as an attachment.",
    inputSchema: { file_path: z.string().min(1) },
  },
  async ({ file_path }) => cardCall(async () => cards.rememberUpload(path.resolve(file_path), await runLovart(["upload", "--file", path.resolve(file_path)]))),
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
      "On Windows or macOS, when the user says 配置lovart的密钥, 配置 Lovart 的密钥, or asks to set/change Lovart API keys, call this directly with {} to return a temporary local webpage URL. No prior credentials, authentication check or project lookup is needed. Show the returned URL as a clickable link; its password fields support Ctrl+V on Windows and Command+V on Mac, plus right-click paste. Keys stay local and are never returned to chat. Saving needs no Codex restart.",
    inputSchema: {},
  },
  async () => cardCall(() => credentialSetup.start()),
);

server.registerTool('lovart_credential_status',{
  description:'Read whether this local credential setup session is awaiting input, saved or expired. Does not read or reveal keys, and does not verify Lovart authentication.',
  inputSchema:{},annotations:{readOnlyHint:true,openWorldHint:false},
},async()=>response(credentialSetup.status()));

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

server.registerTool("lovart_run_execute", {
  description: "Execute a saved Recreate draft once. Preserves its original prompt, reference order, project and model preferences. Returns saved cards; call lovart_display for each probe_id. Never automatically confirms credit costs.",
  inputSchema: {run_id:z.string().uuid()},
}, async ({run_id}) => cardCall(() => cards.executeDraft(run_id)));

await server.connect(new StdioServerTransport());
