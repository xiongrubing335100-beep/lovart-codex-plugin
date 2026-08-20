import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import {
  confirmArgs,
  generationArgs,
  resolveLovartChildEnv,
  resolveLovartEnv,
  resolvePython,
  resultArgs,
  runLovart,
} from "../src/lovart-cli.js";

const outputDir = path.resolve("downloads-test");

test("generationArgs preserves the prompt and maps optional controls", () => {
  const args = generationArgs(
    {
      prompt: "生成一段海浪视频",
      project_id: "project-1",
      thread_id: "thread-1",
      attachments: ["https://example.test/reference.png"],
      reasoning_mode: "thinking",
      prefer_models: { VIDEO: ["generate_video_seedance_v2_5"] },
      include_tools: ["generate_video_seedance_v2_5"],
    },
    outputDir,
  );

  assert.deepEqual(args, [
    "chat",
    "--prompt",
    "生成一段海浪视频",
    "--json",
    "--download",
    "--output-dir",
    outputDir,
    "--project-id",
    "project-1",
    "--thread-id",
    "thread-1",
    "--attachments",
    "https://example.test/reference.png",
    "--mode",
    "thinking",
    "--prefer-models",
    '{"VIDEO":["generate_video_seedance_v2_5"]}',
    "--include-tools",
    "generate_video_seedance_v2_5",
  ]);
});

test("generationArgs does not add absent optional controls", () => {
  assert.deepEqual(generationArgs({ prompt: "draw a cat" }, outputDir), [
    "chat",
    "--prompt",
    "draw a cat",
    "--json",
    "--download",
    "--output-dir",
    outputDir,
  ]);
});

test("confirmation and result always download artifacts", () => {
  assert.deepEqual(confirmArgs("thread-1", outputDir), [
    "confirm",
    "--thread-id",
    "thread-1",
    "--json",
    "--download",
    "--output-dir",
    outputDir,
  ]);
  assert.deepEqual(resultArgs("thread-1", outputDir), [
    "result",
    "--thread-id",
    "thread-1",
    "--json",
    "--download",
    "--output-dir",
    outputDir,
  ]);
});

test("resolveLovartEnv uses the latest Windows user credentials", () => {
  const values = {
    LOVART_ACCESS_KEY: "new-ak",
    LOVART_SECRET_KEY: "new-sk",
  };
  const resolved = resolveLovartEnv(
    { LOVART_ACCESS_KEY: "old-ak", LOVART_SECRET_KEY: "old-sk", PATH: "test-path" },
    { platform: "win32", readUserVariable: (name) => values[name] },
  );

  assert.equal(resolved.LOVART_ACCESS_KEY, "new-ak");
  assert.equal(resolved.LOVART_SECRET_KEY, "new-sk");
  assert.equal(resolved.PATH, "test-path");
});

test("resolveLovartEnv reads the latest macOS helper credentials for each child", () => {
  let pair = { accessKey: "ak-one", secretKey: "sk-one" };
  const readMacCredentials = () => pair;

  assert.equal(
    resolveLovartEnv({}, { platform: "darwin", readMacCredentials }).LOVART_ACCESS_KEY,
    "ak-one",
  );

  pair = { accessKey: "ak-two", secretKey: "sk-two" };
  assert.equal(
    resolveLovartEnv({}, { platform: "darwin", readMacCredentials }).LOVART_ACCESS_KEY,
    "ak-two",
  );
});

test("resolveLovartEnv ignores stale macOS process credentials", () => {
  const resolved = resolveLovartEnv(
    { LOVART_ACCESS_KEY: "stale-ak", LOVART_SECRET_KEY: "stale-sk", PATH: "test-path" },
    {
      platform: "darwin",
      readMacCredentials: () => ({ accessKey: "keychain-ak", secretKey: "keychain-sk" }),
    },
  );

  assert.equal(resolved.LOVART_ACCESS_KEY, "keychain-ak");
  assert.equal(resolved.LOVART_SECRET_KEY, "keychain-sk");
  assert.equal(resolved.PATH, "test-path");
});

test("resolveLovartEnv installs then reads the same helper path for every macOS operation", () => {
  const calls = [];
  const options = {
    platform: "darwin",
    installMacCredentialHelper: () => {
      calls.push(["install"]);
      return "/installed/lovart-credential-helper";
    },
    invokeMacCredentialHelper: (readOptions = {}) => {
      calls.push(["read", readOptions.helperPath]);
      return { accessKey: "fresh-ak", secretKey: "fresh-sk" };
    },
  };

  resolveLovartEnv({}, options);
  resolveLovartEnv({}, options);

  assert.deepEqual(calls, [
    ["install"],
    ["read", "/installed/lovart-credential-helper"],
    ["install"],
    ["read", "/installed/lovart-credential-helper"],
  ]);
});

test("resolveLovartEnv rejects an incomplete macOS helper pair", () => {
  assert.throws(
    () => resolveLovartEnv({}, {
      platform: "darwin",
      readMacCredentials: () => ({ accessKey: "only-ak", secretKey: "" }),
    }),
    /invalid response/i,
  );
});

test("runLovart uses a rotated macOS pair on the next operation and isolates the parent env", async () => {
  const parentEnv = { PATH: "test-path", LOVART_ACCESS_KEY: "stale-ak", LOVART_SECRET_KEY: "stale-sk" };
  const originalParentEnv = { ...parentEnv };
  const childEnvironments = [];
  let pair = { accessKey: "ak-one", secretKey: "sk-one" };
  let reads = 0;
  const outputDir = mkdtempSync(path.join(tmpdir(), "lovart-child-env-"));

  const spawnProcess = (_command, _args, options) => {
    childEnvironments.push(options.env);
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    queueMicrotask(() => {
      child.stdout.end("{}\n");
      child.stderr.end();
      child.emit("close", 0);
    });
    return child;
  };

  try {
    const operationOptions = {
      python: "/fixture/python",
      scriptPath: "/fixture/agent_skill.py",
      outputDir,
      env: parentEnv,
      platform: "darwin",
      readMacCredentials: () => {
        reads += 1;
        return pair;
      },
      spawnProcess,
    };

    await runLovart(["config", "--json"], operationOptions);
    pair = { accessKey: "ak-two", secretKey: "sk-two" };
    await runLovart(["projects", "--json"], operationOptions);

    assert.equal(reads, 2);
    assert.equal(childEnvironments[0].LOVART_ACCESS_KEY, "ak-one");
    assert.equal(childEnvironments[0].LOVART_SECRET_KEY, "sk-one");
    assert.equal(childEnvironments[1].LOVART_ACCESS_KEY, "ak-two");
    assert.equal(childEnvironments[1].LOVART_SECRET_KEY, "sk-two");
    assert.deepEqual(parentEnv, originalParentEnv);
    assert.notEqual(childEnvironments[0], parentEnv);
    assert.notEqual(childEnvironments[1], parentEnv);
  } finally {
    rmSync(outputDir, { recursive: true, force: true });
  }
});

test("resolveLovartEnv leaves non-Windows environments unchanged", () => {
  const env = { LOVART_ACCESS_KEY: "ak", LOVART_SECRET_KEY: "sk" };
  assert.deepEqual(resolveLovartEnv(env, { platform: "linux" }), env);
});

test("resolveLovartChildEnv forces UTF-8 for Lovart's Python process", () => {
  const resolved = resolveLovartChildEnv(
    { LOVART_ACCESS_KEY: "ak", LOVART_SECRET_KEY: "sk", PYTHONUTF8: "0" },
    { platform: "linux" },
  );

  assert.equal(resolved.PYTHONUTF8, "1");
  assert.equal(resolved.PYTHONIOENCODING, "utf-8");
  assert.equal(resolved.LOVART_ACCESS_KEY, "ak");
});

test("resolvePython honors an explicit Lovart Python override", () => {
  assert.equal(
    resolvePython(
      { LOVART_PYTHON: "C:\\Python\\python.exe", USERPROFILE: "C:\\Users\\test" },
      { platform: "win32", fileExists: () => true },
    ),
    "C:\\Python\\python.exe",
  );
});

test("resolvePython prefers Codex's bundled Python on Windows", () => {
  const userProfile = "C:\\Users\\test";
  const expected = path.join(
    userProfile,
    ".cache",
    "codex-runtimes",
    "codex-primary-runtime",
    "dependencies",
    "python",
    "python.exe",
  );

  assert.equal(
    resolvePython(
      { USERPROFILE: userProfile },
      { platform: "win32", fileExists: (candidate) => candidate === expected },
    ),
    expected,
  );
});

test("resolvePython prefers Codex's bundled Python on macOS", () => {
  const candidate = path.join(
    "/Users/test",
    ".cache/codex-runtimes/codex-primary-runtime/dependencies/python/bin/python3",
  );
  assert.equal(
    resolvePython(
      { HOME: "/Users/test" },
      { platform: "darwin", fileExists: (value) => value === candidate },
    ),
    candidate,
  );
});

test("resolvePython falls back to python3 when the macOS bundle is absent", () => {
  assert.equal(
    resolvePython(
      { HOME: "/Users/test" },
      { platform: "darwin", fileExists: () => false },
    ),
    "python3",
  );
});

test("resolvePython falls back to the platform launcher", () => {
  assert.equal(
    resolvePython(
      { USERPROFILE: "C:\\Users\\test" },
      { platform: "win32", fileExists: () => false },
    ),
    "py",
  );
  assert.equal(resolvePython({}, { platform: "linux", fileExists: () => false }), "python3");
});
