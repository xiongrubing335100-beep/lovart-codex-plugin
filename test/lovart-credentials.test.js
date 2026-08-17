import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import {
  configureCredentialsForPlatform,
  openCredentialSetup,
} from "../src/lovart-credentials.js";

test("routes macOS configuration to the local-only helper", () => {
  const calls = [];
  const result = configureCredentialsForPlatform({
    platform: "darwin",
    projectRoot: "/plugin",
    configureMacCredentials: (options) => {
      calls.push(options);
      return { configured: true, message: "Lovart credentials saved on this Mac." };
    },
  });

  assert.equal(result.configured, true);
  assert.deepEqual(calls, [{ projectRoot: "/plugin" }]);
  assert.equal(JSON.stringify(result).includes("LOVART_ACCESS_KEY"), false);
  assert.equal(JSON.stringify(result).includes("LOVART_SECRET_KEY"), false);
});

test("launches Windows credential setup without changing its behavior", () => {
  const calls = [];
  const result = openCredentialSetup({
    platform: "win32",
    projectRoot: "C:\\plugin",
    systemRoot: "C:\\Windows",
    spawnProcess: (command, args, options) => {
      calls.push({ command, args, options });
      return { unref() {} };
    },
  });

  assert.deepEqual(result, { opened: true, message: "Lovart key setup window opened." });
  assert.equal(
    calls[0].command,
    path.join("C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
  );
  assert.deepEqual(calls[0].args.slice(0, 5), [
    "-NoProfile",
    "-ExecutionPolicy",
    "Bypass",
    "-STA",
    "-WindowStyle",
  ]);
  assert.equal(
    calls[0].args.at(-1),
    path.join("C:\\plugin", "scripts", "configure-lovart-credentials.ps1"),
  );
  assert.equal(calls[0].options.detached, true);
  assert.equal(calls[0].options.windowsHide, true);
});

test("leaves unsupported platform credential setup unchanged", () => {
  assert.deepEqual(openCredentialSetup({ platform: "linux", projectRoot: "/plugin" }), {
    opened: false,
    message: "Lovart key setup is supported on macOS and Windows only.",
  });
});
