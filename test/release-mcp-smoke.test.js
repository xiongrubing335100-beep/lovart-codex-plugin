import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const root = process.env.LOVART_RELEASE_EXTRACTED_ROOT;

function writeRegistryPreload(preload, marker) {
  writeFileSync(preload, `
import childProcess from "node:child_process";
import { writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
const marker = ${JSON.stringify(marker)};
const original = childProcess.execFileSync;
childProcess.execFileSync = (command, ...args) => {
  if (String(command).toLowerCase().endsWith("reg.exe")) {
    writeFileSync(marker, "registry access");
    throw new Error("registry credential access blocked by smoke tripwire");
  }
  return original(command, ...args);
};
syncBuiltinESMExports();
`, "utf8");
}

test("registry preload blocks named-import reg.exe control", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "lovart-registry-control-"));
  const marker = path.join(directory, "marker");
  const preload = path.join(directory, "preload.mjs");
  try {
    writeRegistryPreload(preload, marker);
    assert.throws(() => execFileSync(process.execPath, ["--input-type=module", "--eval", "import { execFileSync } from 'node:child_process'; execFileSync('reg.exe', ['query']);"], {
      env: { ...process.env, NODE_OPTIONS: `--import ${pathToFileURL(preload).href}` },
      stdio: "pipe",
    }));
    assert.equal(existsSync(marker), true);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("extracted release starts MCP and lists tools without credentials", {
  skip: !root && "set LOVART_RELEASE_EXTRACTED_ROOT to run extracted-release smoke coverage",
}, async () => {
  const pluginRoot = path.join(root, "plugins", "lovart");
  const isolatedHome = mkdtempSync(path.join(tmpdir(), "lovart-release-smoke-home-"));
  const isolatedAppData = mkdtempSync(path.join(tmpdir(), "lovart-release-smoke-appdata-"));
  const tripwire = path.join(isolatedHome, "credential-accessed");
  const registryTripwire = path.join(isolatedAppData, "credential-accessed");
  const preload = path.join(isolatedAppData, "registry-tripwire.mjs");
  const helperPath = path.join(
    isolatedHome,
    "Library", "Application Support", "Lovart Codex", "credential-helper", "1", "lovart-credential-helper",
  );
  mkdirSync(path.dirname(helperPath), { recursive: true });
  writeFileSync(helperPath, `#!/bin/sh\ntouch ${JSON.stringify(tripwire)}\nexit 99\n`, { mode: 0o700 });
  writeRegistryPreload(preload, registryTripwire);
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(pluginRoot, "scripts", "start-mcp.mjs")],
    cwd: pluginRoot,
    env: {
      ...process.env,
      HOME: isolatedHome,
      USERPROFILE: isolatedHome,
      APPDATA: isolatedAppData,
      LOCALAPPDATA: isolatedAppData,
      SystemRoot: path.join(isolatedAppData, "Windows-tripwire"),
      NODE_OPTIONS: `${process.env.NODE_OPTIONS || ""} --import ${pathToFileURL(preload).href}`.trim(),
      LOVART_ACCESS_KEY: "",
      LOVART_SECRET_KEY: "",
    },
    stderr: "pipe",
  });
  const client = new Client({ name: "lovart-release-smoke", version: "0.2.0" });

  try {
    await client.connect(transport);
    const names = (await client.listTools()).tools.map(({ name }) => name);
    assert.ok(names.includes("lovart_generate"));
    assert.ok(names.includes("lovart_configure_credentials"));
  } finally {
    try {
      await client.close();
    } finally {
      await transport.close();
      assert.equal(existsSync(tripwire), false, "startup/listTools must not access the macOS helper");
      assert.equal(existsSync(registryTripwire), false, "startup/listTools must not access Windows credentials");
      rmSync(isolatedHome, { recursive: true, force: true });
      rmSync(isolatedAppData, { recursive: true, force: true });
    }
  }
});
