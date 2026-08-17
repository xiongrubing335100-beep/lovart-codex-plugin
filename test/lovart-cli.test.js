import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import {
  confirmArgs,
  generationArgs,
  resolveLovartChildEnv,
  resolveLovartEnv,
  resolvePython,
  resultArgs,
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

test("resolveLovartEnv uses macOS Keychain credentials", () => {
  const values = {
    LOVART_ACCESS_KEY: "keychain-ak",
    LOVART_SECRET_KEY: "keychain-sk",
  };
  const resolved = resolveLovartEnv(
    { LOVART_ACCESS_KEY: "old-ak", PATH: "test-path" },
    { platform: "darwin", readMacVariable: (name) => values[name] || "" },
  );

  assert.equal(resolved.LOVART_ACCESS_KEY, "keychain-ak");
  assert.equal(resolved.LOVART_SECRET_KEY, "keychain-sk");
  assert.equal(resolved.PATH, "test-path");
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
