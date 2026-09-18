import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import {mkdtemp,rm} from "node:fs/promises";
import {randomUUID} from "node:crypto";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = process.env.LOVART_TEST_PROJECT_ROOT
  ? path.resolve(process.env.LOVART_TEST_PROJECT_ROOT)
  : path.resolve(here, "..");

test("Codex-style stdio client discovers tools and can call local config", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(),"lovart-integration-"));
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(projectRoot, "scripts", "start-mcp.mjs")],
    cwd: projectRoot,
    env: {
      ...process.env,
      LOVART_CARD_STATE_DIR:directory,
      LOVART_SKILL_SCRIPT:path.join(projectRoot,"test","fixtures","provider.py"),
      LOVART_OUTPUT_DIR:
        path.join(directory,"downloads"),
    },
    stderr: "pipe",
  });
  const client = new Client({ name: "lovart-mcp-test", version: "0.1.0" });

  try {
    await client.connect(transport);
    const tools = await client.listTools();
    const names = tools.tools.map((tool) => tool.name);

    assert.ok(names.includes("lovart_generate"));
    assert.ok(names.includes("lovart_confirm"));
    assert.ok(names.includes("lovart_upload"));
    assert.ok(names.includes("lovart_config"));
    assert.ok(names.includes("lovart_configure_credentials"));
    assert.ok(names.includes("lovart_credential_status"));
    const setup=await client.callTool({name:'lovart_configure_credentials',arguments:{}});
    assert.equal(setup.isError,undefined);assert.match(setup.structuredContent.url,/^http:\/\/127\.0\.0\.1:\d+\/setup#token=/);
    const credentialsPage=await fetch(setup.structuredContent.url);
    assert.equal(credentialsPage.status,200);assert.match(await credentialsPage.text(),/Ctrl\+V/);
    const setupStatus=await client.callTool({name:'lovart_credential_status',arguments:{}});
    assert.equal(setupStatus.structuredContent.status,'awaiting_input');

    const result = await client.callTool({ name: "lovart_config", arguments: {} });
    assert.equal(result.isError, undefined, JSON.stringify(result.content));
    assert.ok(Array.isArray(result.content));

    const threads = await client.callTool({ name: "lovart_threads", arguments: {} });
    assert.equal(threads.isError, undefined, JSON.stringify(threads.content));
    assert.ok(threads.structuredContent && !Array.isArray(threads.structuredContent));
    assert.ok(Array.isArray(threads.structuredContent.result));

    const generated=await client.callTool({name:"lovart_generate",arguments:{request_id:randomUUID(),prompt:"原始 16:9 角色描述",project_id:"fixture-project"}});
    assert.equal(generated.isError,undefined,JSON.stringify(generated.content));
    assert.equal(generated.structuredContent.cards.length,1,JSON.stringify(generated.structuredContent));
    const id=generated.structuredContent.cards[0].probe_id;
    const displayed=await client.callTool({name:"lovart_display",arguments:{probe_id:id}});
    assert.equal(displayed.structuredContent.presentation_pending,true);
    const data=await client.callTool({name:"lovart_card_get",arguments:{probe_id:id}});
    assert.equal(JSON.parse(data.structuredContent.presentation_json).prompt,"原始 16:9 角色描述");
    assert.equal(data.structuredContent.actions.recreate,true);
    const html=await client.readResource({uri:"ui://lovart/result-card-v1.html"});
    assert.match(html.contents[0].text,/lovart_card_get/);

  } finally {
    await client.close();
    await rm(directory,{recursive:true,force:true});
  }
});
