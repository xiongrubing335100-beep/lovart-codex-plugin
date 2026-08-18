import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import {
  configureCredentialsForPlatform,
} from "../src/lovart-credentials.js";
import { MacOSCredentialError } from "../src/macos-credential-helper.js";

test("opens verified macOS configuration independently of the public request", () => {
  const installCalls = [];
  const spawnCalls = [];
  let unrefCalls = 0;
  const result = configureCredentialsForPlatform({
    platform: "darwin",
    projectRoot: "/plugin",
    installMacHelper: (options) => {
      installCalls.push(options);
      return "/verified/lovart-credential-helper";
    },
    spawnProcess: (command, args, options) => {
      spawnCalls.push({ command, args, options });
      return { unref: () => { unrefCalls += 1; } };
    },
  });

  assert.deepEqual(result, {
    opened: true,
    message: "Lovart credential setup window opened.",
  });
  assert.deepEqual(installCalls, [{ projectRoot: "/plugin" }]);
  assert.deepEqual(spawnCalls, [{
    command: "/verified/lovart-credential-helper",
    args: ["configure"],
    options: { detached: true, stdio: "ignore" },
  }]);
  assert.equal(unrefCalls, 1);
  assert.equal(JSON.stringify(result).includes("LOVART_ACCESS_KEY"), false);
  assert.equal(JSON.stringify(result).includes("LOVART_SECRET_KEY"), false);
  assert.equal(JSON.stringify(result).includes("accessKey"), false);
  assert.equal(JSON.stringify(result).includes("secretKey"), false);
});

test("fails closed when the verified macOS helper cannot be spawned", () => {
  let spawnCalls = 0;

  assert.throws(
    () => configureCredentialsForPlatform({
      platform: "darwin",
      projectRoot: "/plugin",
      installMacHelper: () => "/verified/lovart-credential-helper",
      spawnProcess: () => {
        spawnCalls += 1;
        throw new Error("synthetic private spawn failure");
      },
    }),
    (error) =>
      error instanceof MacOSCredentialError &&
      error.code === "helper_missing_or_invalid" &&
      !error.message.includes("synthetic private spawn failure"),
  );
  assert.equal(spawnCalls, 1);
});

test("launches Windows credential setup without changing its behavior", () => {
  const calls = [];
  let unrefCalls = 0;
  const result = configureCredentialsForPlatform({
    platform: "win32",
    projectRoot: "C:\\plugin",
    systemRoot: "C:\\Windows",
    spawnProcess: (command, args, options) => {
      calls.push({ command, args, options });
      return { unref: () => { unrefCalls += 1; } };
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
  assert.equal(unrefCalls, 1);
});

test("leaves unsupported platform credential setup unchanged", () => {
  assert.deepEqual(configureCredentialsForPlatform({ platform: "linux", projectRoot: "/plugin" }), {
    opened: false,
    message: "Lovart key setup is supported on macOS and Windows only.",
  });
});
