import test from "node:test";
import assert from "node:assert/strict";
import {
  openCredentialSetup,
  readMacOSKeychainVariable,
} from "../src/lovart-credentials.js";

test("reads a trimmed value from the macOS Keychain command", () => {
  const calls = [];
  const value = readMacOSKeychainVariable("LOVART_ACCESS_KEY", {
    run: (command, args) => {
      calls.push({ command, args });
      return "keychain-ak\n";
    },
  });

  assert.equal(value, "keychain-ak");
  assert.deepEqual(calls, [{
    command: "security",
    args: ["find-generic-password", "-s", "com.lovart.codex", "-a", "LOVART_ACCESS_KEY", "-w"],
  }]);
});

test("launches the macOS Keychain setup AppleScript", () => {
  const calls = [];
  const result = openCredentialSetup({
    platform: "darwin",
    projectRoot: "/plugin",
    spawnProcess: (command, args, options) => {
      calls.push({ command, args, options });
      return { unref() {} };
    },
  });

  assert.deepEqual(result, { opened: true, message: "Lovart key setup window opened." });
  assert.equal(calls[0].command, "osascript");
  assert.deepEqual(calls[0].args, ["/plugin/scripts/configure-lovart-credentials.applescript"]);
  assert.equal(calls[0].options.detached, true);
  assert.deepEqual(calls[0].options.stdio, "ignore");
});

test("does not expose credentials in the setup result", () => {
  const result = openCredentialSetup({
    platform: "darwin",
    projectRoot: "/plugin",
    spawnProcess: () => ({ unref() {} }),
  });

  assert.deepEqual(Object.keys(result).sort(), ["message", "opened"]);
});
