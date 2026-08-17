import test from "node:test";
import assert from "node:assert/strict";
import {
  configureCredentialsForPlatform,
  configureMacOSSessionCredentials,
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

test("loads prompted macOS credentials into only the MCP process environment", () => {
  const env = {};
  const calls = [];
  const result = configureMacOSSessionCredentials({
    env,
    run: (command, args, options) => {
      calls.push({ command, args, options });
      return JSON.stringify({ accessKey: "session-ak", secretKey: "session-sk" });
    },
  });

  assert.deepEqual(result, {
    configured: true,
    message: "Lovart credentials loaded for this MCP session.",
  });
  assert.equal(env.LOVART_ACCESS_KEY, "session-ak");
  assert.equal(env.LOVART_SECRET_KEY, "session-sk");
  assert.equal(calls[0].command, "osascript");
  assert.deepEqual(calls[0].args.slice(0, 2), ["-l", "JavaScript"]);
  assert.equal(JSON.stringify(result).includes("session-ak"), false);
  assert.equal(JSON.stringify(result).includes("session-sk"), false);
});

test("leaves the environment unchanged when macOS credential setup is cancelled", () => {
  const env = { PATH: "test-path" };
  const result = configureMacOSSessionCredentials({
    env,
    run: () => {
      throw new Error("User canceled.");
    },
  });

  assert.deepEqual(result, {
    configured: false,
    message: "Lovart key setup cancelled.",
  });
  assert.deepEqual(env, { PATH: "test-path" });
});

test("routes macOS credential setup to the in-memory session prompt", () => {
  const env = {};
  const result = configureCredentialsForPlatform({
    platform: "darwin",
    env,
    run: () => JSON.stringify({ accessKey: "session-ak", secretKey: "session-sk" }),
  });

  assert.equal(result.configured, true);
  assert.equal(env.LOVART_ACCESS_KEY, "session-ak");
  assert.equal(env.LOVART_SECRET_KEY, "session-sk");
});
