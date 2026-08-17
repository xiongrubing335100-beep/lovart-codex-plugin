import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { appendFileSync, chmodSync, copyFileSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path, { join } from "node:path";
import { verifyMacOSCredentialHelper } from "../scripts/verify-macos-credential-helper.mjs";

test("macOS helper is universal, signed, hash-pinned, and staged before execution", { skip: process.platform !== "darwin" }, () => {
  const binary = path.resolve("bin/macos/lovart-credential-helper");
  const temporaryDirectory = mkdtempSync(join(tmpdir(), "lovart-helper-stage-"));
  const checkoutModeBinary = join(temporaryDirectory, "lovart-credential-helper");
  let stagedMode;

  try {
    copyFileSync(binary, checkoutModeBinary);
    copyFileSync(`${binary}.sha256`, `${checkoutModeBinary}.sha256`);
    chmodSync(checkoutModeBinary, 0o755);

    const result = verifyMacOSCredentialHelper({
      binary: checkoutModeBinary,
      execFile: (...args) => {
        if (args[0] !== "xcrun" && args[0] !== "codesign") {
          stagedMode = statSync(args[0]).mode & 0o777;
        }
        return execFileSync(...args);
      },
    });

    assert.deepEqual(result.archs, ["arm64", "x86_64"]);
    assert.equal(result.version, "1");
    assert.equal(statSync(checkoutModeBinary).mode & 0o777, 0o755);
    assert.equal(stagedMode, 0o700);
  } finally {
    rmSync(temporaryDirectory, { force: true, recursive: true });
  }
});

test("tampered macOS helper bytes are never executed", { skip: process.platform !== "darwin" }, () => {
  const binary = path.resolve("bin/macos/lovart-credential-helper");
  const temporaryDirectory = mkdtempSync(join(tmpdir(), "lovart-helper-tampered-"));
  const tamperedBinary = join(temporaryDirectory, "lovart-credential-helper");
  const invocations = [];

  try {
    copyFileSync(binary, tamperedBinary);
    copyFileSync(`${binary}.sha256`, `${tamperedBinary}.sha256`);
    appendFileSync(tamperedBinary, "x");

    assert.throws(
      () => verifyMacOSCredentialHelper({
        binary: tamperedBinary,
        execFile: (...args) => {
          invocations.push(args);
          return "1\n";
        },
      }),
      /SHA-256 mismatch/
    );
    assert.deepEqual(invocations, []);
  } finally {
    rmSync(temporaryDirectory, { force: true, recursive: true });
  }
});

test("macOS helper rejects a malformed raw hash manifest before execution", { skip: process.platform !== "darwin" }, () => {
  const binary = path.resolve("bin/macos/lovart-credential-helper");
  const temporaryDirectory = mkdtempSync(join(tmpdir(), "lovart-helper-manifest-"));
  const manifest = join(temporaryDirectory, "lovart-credential-helper.sha256");
  const invocations = [];

  try {
    writeFileSync(manifest, "f254b328a2c1fbf4665c3733173539b3620e88a0f047d8fc52bc17f9e6531b25");

    assert.throws(
      () => verifyMacOSCredentialHelper({
        binary,
        manifest,
        execFile: (...args) => {
          invocations.push(args);
          return "1\n";
        },
      }),
      /manifest must contain one lowercase SHA-256 digest followed by one newline/
    );
    assert.deepEqual(invocations, []);
  } finally {
    rmSync(temporaryDirectory, { force: true, recursive: true });
  }
});

test("macOS helper verifier binds every check to a private staged copy", { skip: process.platform !== "darwin" }, () => {
  const binary = path.resolve("bin/macos/lovart-credential-helper");
  const temporaryDirectory = mkdtempSync(join(tmpdir(), "lovart-helper-binding-"));
  const mutableBinary = join(temporaryDirectory, "lovart-credential-helper");
  const checkedPaths = [];

  try {
    copyFileSync(binary, mutableBinary);
    copyFileSync(`${binary}.sha256`, `${mutableBinary}.sha256`);

    const result = verifyMacOSCredentialHelper({
      binary: mutableBinary,
      execFile: (command, args, options) => {
        if (command === "xcrun") {
          appendFileSync(mutableBinary, "changed after staging");
          checkedPaths.push(args.at(-1));
        } else if (command === "codesign") {
          checkedPaths.push(args.at(-1));
        } else {
          checkedPaths.push(command);
        }
        return execFileSync(command, args, options);
      },
    });

    assert.equal(result.version, "1");
    assert.deepEqual(result.bytes, readFileSync(binary));
    assert.equal(checkedPaths.every((candidate) => candidate !== mutableBinary), true);
  } finally {
    rmSync(temporaryDirectory, { force: true, recursive: true });
  }
});
