import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";

test("macOS helper is universal, signed, and hash-pinned", { skip: process.platform !== "darwin" }, () => {
  const binary = path.resolve("bin/macos/lovart-credential-helper");
  const expected = readFileSync(`${binary}.sha256`, "utf8").trim();
  const actual = createHash("sha256").update(readFileSync(binary)).digest("hex");
  const version = execFileSync(binary, ["--version"], { encoding: "utf8" }).trim();
  const archs = execFileSync("xcrun", ["lipo", "-archs", binary], { encoding: "utf8" })
    .trim()
    .split(/\s+/)
    .sort();

  assert.deepEqual(archs, ["arm64", "x86_64"]);
  assert.equal(actual, expected);
  assert.equal(version, "1");
  execFileSync("codesign", ["--verify", "--strict", binary], { stdio: "pipe" });
});
