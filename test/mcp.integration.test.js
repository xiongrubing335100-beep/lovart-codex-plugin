import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = process.env.LOVART_TEST_PROJECT_ROOT
  ? path.resolve(process.env.LOVART_TEST_PROJECT_ROOT)
  : path.resolve(here, "..");

test("Codex-style stdio client discovers Lovart tools", async () => {
  const testHome = mkdtempSync(path.join(tmpdir(), "lovart-mcp-home-"));
  const testOutputDir = mkdtempSync(path.join(tmpdir(), "lovart-mcp-output-"));
  const forbiddenTestState = path.join(projectRoot, ".lovart-test-state");
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [
      "--import",
      pathToFileURL(path.join(projectRoot, "fixtures", "macos-helper-not-configured.mjs")).href,
      path.join(projectRoot, "src", "index.js"),
    ],
    cwd: projectRoot,
    env: {
      ...process.env,
      HOME: testHome,
      LOVART_ACCESS_KEY: "fixture-ak",
      LOVART_SECRET_KEY: "fixture-sk",
      LOVART_OUTPUT_DIR: process.env.LOVART_TEST_OUTPUT_DIR || testOutputDir,
    },
    stderr: "pipe",
  });
  const client = new Client({ name: "lovart-mcp-test", version: "0.1.0" });

  try {
    await client.connect(transport);
    const packageVersion = JSON.parse(readFileSync(path.join(projectRoot, "package.json"), "utf8")).version;
    const pluginRoot = path.join(projectRoot, "plugin-build", "lovart");
    const pluginVersion = JSON.parse(readFileSync(path.join(pluginRoot, ".codex-plugin", "plugin.json"), "utf8")).version;
    const pluginPackageVersion = JSON.parse(readFileSync(path.join(pluginRoot, "package.json"), "utf8")).version;
    assert.equal(client.getServerVersion()?.version, packageVersion);
    assert.equal(pluginVersion, packageVersion);
    assert.equal(pluginPackageVersion, packageVersion);
    const tools = await client.listTools();
    const names = tools.tools.map((tool) => tool.name);

    assert.ok(names.includes("lovart_generate"));
    assert.ok(names.includes("lovart_confirm"));
    assert.ok(names.includes("lovart_upload"));
    assert.ok(names.includes("lovart_config"));
    assert.ok(names.includes("lovart_configure_credentials"));

    if (process.platform === "darwin") {
      const opened = await client.callTool({
        name: "lovart_configure_credentials",
        arguments: {},
      });
      assert.equal(opened.isError, undefined);
      assert.deepEqual(opened.structuredContent, {
        opened: true,
        message: "Lovart credential setup window opened.",
      });
      assert.equal(JSON.stringify(opened).includes("fixture-ak"), false);
      assert.equal(JSON.stringify(opened).includes("fixture-sk"), false);
      assert.equal(JSON.stringify(opened).includes("accessKey"), false);
      assert.equal(JSON.stringify(opened).includes("secretKey"), false);

      const config = await client.callTool({ name: "lovart_config", arguments: {} });
      assert.equal(config.isError, true);
      assert.deepEqual(config.content, [{
        type: "text",
        text: "Lovart credentials are not configured on this Mac. Run Lovart credential setup.",
      }]);
      assert.equal(JSON.stringify(config).includes("fixture-ak"), false);
      assert.equal(JSON.stringify(config).includes("fixture-sk"), false);
    }

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
    try {
      await client.close();
    } finally {
      rmSync(testHome, { recursive: true, force: true });
      rmSync(testOutputDir, { recursive: true, force: true });
      assert.equal(
        existsSync(forbiddenTestState),
        false,
        "MCP integration tests must not leave plugin-local test state",
      );
    }
  }
});
