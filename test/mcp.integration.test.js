import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = process.env.LOVART_TEST_PROJECT_ROOT
  ? path.resolve(process.env.LOVART_TEST_PROJECT_ROOT)
  : path.resolve(here, "..");

test("Codex-style stdio client discovers Lovart tools", async () => {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(projectRoot, "src", "index.js")],
    cwd: projectRoot,
    env: {
      ...process.env,
      LOVART_OUTPUT_DIR:
        process.env.LOVART_TEST_OUTPUT_DIR
        || path.join(projectRoot, ".lovart-test-state", "downloads"),
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

    if (process.env.LOVART_TEST_UPLOAD_FILE) {
      const upload = await client.callTool({
        name: "lovart_upload",
        arguments: { file_path: process.env.LOVART_TEST_UPLOAD_FILE },
      });
      assert.equal(upload.isError, undefined);
      assert.match(upload.structuredContent.url, /^https:\/\//);
    }

    if (process.env.LOVART_TEST_RESULT_THREAD_ID) {
      const result = await client.callTool({
        name: "lovart_result",
        arguments: { thread_id: process.env.LOVART_TEST_RESULT_THREAD_ID },
      });
      assert.equal(result.isError, undefined, JSON.stringify(result.content));
      assert.ok(result.structuredContent);
      assert.ok(Array.isArray(result.structuredContent.downloaded));
    }
  } finally {
    await client.close();
  }
});
