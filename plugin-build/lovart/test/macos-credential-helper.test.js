import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  MacOSCredentialError,
  configureMacOSCredentials,
  getMacOSCredentialStatus,
  helperRelativeInstallPath,
  installMacOSCredentialHelper,
  readMacOSCredentials,
} from "../src/macos-credential-helper.js";

function createHelperFixture() {
  const temporaryDirectory = mkdtempSync(path.join(tmpdir(), "lovart-helper-node-test-"));
  const projectRoot = path.join(temporaryDirectory, "plugin");
  const homeDir = path.join(temporaryDirectory, "home");
  const binary = path.join(projectRoot, "bin", "macos", "lovart-credential-helper");
  const binaryBytes = Buffer.from("fixture helper bytes");
  mkdirSync(path.dirname(binary), { recursive: true });
  writeFileSync(binary, binaryBytes, { mode: 0o700 });
  writeFileSync(
    `${binary}.sha256`,
    `${createHash("sha256").update(binaryBytes).digest("hex")}\n`,
  );

  return {
    temporaryDirectory,
    projectRoot,
    homeDir,
    binaryBytes,
    verifyHelper({ binary, manifest, expectedVersion }) {
      assert.equal(manifest, `${binary}.sha256`);
      assert.equal(expectedVersion, "1");
      return { bytes: readFileSync(binary) };
    },
  };
}

function withFixture(fn) {
  const fixture = createHelperFixture();
  try {
    fn(fixture);
  } finally {
    rmSync(fixture.temporaryDirectory, { force: true, recursive: true });
  }
}

test("installs a verified helper atomically with owner-only permissions", () => {
  withFixture((fixture) => {
    const installed = installMacOSCredentialHelper(fixture);

    assert.equal(installed, path.join(fixture.homeDir, helperRelativeInstallPath));
    assert.equal(statSync(path.dirname(installed)).mode & 0o777, 0o700);
    assert.equal(statSync(installed).mode & 0o777, 0o700);
    assert.deepEqual(readFileSync(installed), fixture.binaryBytes);
    assert.equal(
      readdirSync(path.dirname(installed)).some((entry) => entry.endsWith(".tmp")),
      false,
    );
  });
});

test("preserves a valid v1 helper and rejects a changed one", () => {
  withFixture((fixture) => {
    const installed = installMacOSCredentialHelper(fixture);
    const originalMtime = new Date("2020-01-01T00:00:00.000Z");
    utimesSync(installed, originalMtime, originalMtime);
    const firstMtime = statSync(installed).mtimeMs;

    assert.equal(installMacOSCredentialHelper(fixture), installed);
    assert.equal(statSync(installed).mtimeMs, firstMtime);

    writeFileSync(installed, "tampered");
    assert.throws(
      () => installMacOSCredentialHelper(fixture),
      (error) => error instanceof MacOSCredentialError && error.code === "helper_missing_or_invalid",
    );
  });
});

test("rejects a changed packaged helper before creating an install", () => {
  withFixture((fixture) => {
    writeFileSync(
      path.join(fixture.projectRoot, "bin", "macos", "lovart-credential-helper"),
      "changed packaged helper",
    );

    assert.throws(
      () => installMacOSCredentialHelper(fixture),
      (error) => error instanceof MacOSCredentialError && error.code === "helper_missing_or_invalid",
    );
    assert.equal(existsSync(path.join(fixture.homeDir, helperRelativeInstallPath)), false);
  });
});

test("rejects symlinked helper destinations and symlinked install directories", () => {
  withFixture((fixture) => {
    const installed = path.join(fixture.homeDir, helperRelativeInstallPath);
    const victim = path.join(fixture.temporaryDirectory, "victim");
    mkdirSync(path.dirname(installed), { recursive: true });
    writeFileSync(victim, "do not follow");
    symlinkSync(victim, installed);

    assert.throws(
      () => installMacOSCredentialHelper(fixture),
      (error) => error instanceof MacOSCredentialError && error.code === "helper_missing_or_invalid",
    );
    assert.equal(readFileSync(victim, "utf8"), "do not follow");

    rmSync(fixture.homeDir, { force: true, recursive: true });
    const redirectedLibrary = path.join(fixture.temporaryDirectory, "redirected-library");
    mkdirSync(redirectedLibrary);
    mkdirSync(fixture.homeDir);
    symlinkSync(redirectedLibrary, path.join(fixture.homeDir, "Library"));

    assert.throws(
      () => installMacOSCredentialHelper(fixture),
      (error) => error instanceof MacOSCredentialError && error.code === "helper_missing_or_invalid",
    );
    assert.equal(existsSync(path.join(redirectedLibrary, "Application Support")), false);

    rmSync(fixture.homeDir, { force: true, recursive: true });
    const redirectedHome = path.join(fixture.temporaryDirectory, "redirected-home");
    mkdirSync(redirectedHome);
    symlinkSync(redirectedHome, fixture.homeDir);

    assert.throws(
      () => installMacOSCredentialHelper(fixture),
      (error) => error instanceof MacOSCredentialError && error.code === "helper_missing_or_invalid",
    );
    assert.equal(existsSync(path.join(redirectedHome, "Library")), false);
  });
});

test("does not clobber a race winner and validates the published inode", () => {
  withFixture((fixture) => {
    const installed = path.join(fixture.homeDir, helperRelativeInstallPath);
    let raceHookCalled = false;
    const result = installMacOSCredentialHelper({
      ...fixture,
      beforePublish() {
        raceHookCalled = true;
        writeFileSync(installed, fixture.binaryBytes, { mode: 0o700 });
      },
    });

    assert.equal(result, installed);
    assert.equal(raceHookCalled, true);
    assert.deepEqual(readFileSync(installed), fixture.binaryBytes);
    assert.equal(lstatSync(installed).isFile(), true);
    assert.equal(statSync(installed).nlink >= 1, true);
  });
});

test("rejects a destination symlink swapped in during publication", () => {
  withFixture((fixture) => {
    const installed = path.join(fixture.homeDir, helperRelativeInstallPath);
    const victim = path.join(fixture.temporaryDirectory, "publication-victim");
    writeFileSync(victim, "untouched victim");

    assert.throws(
      () => installMacOSCredentialHelper({
        ...fixture,
        beforePublish() {
          symlinkSync(victim, installed);
        },
      }),
      (error) => error instanceof MacOSCredentialError && error.code === "helper_missing_or_invalid",
    );
    assert.equal(readFileSync(victim, "utf8"), "untouched victim");
    assert.equal(lstatSync(installed).isSymbolicLink(), true);
  });
});

test("does not remove a colliding temporary entry it did not create", () => {
  withFixture((fixture) => {
    const installDirectory = path.join(fixture.homeDir, path.dirname(helperRelativeInstallPath));
    mkdirSync(installDirectory, { recursive: true });
    const collision = path.join(
      installDirectory,
      `.lovart-credential-helper.${process.pid}.test-collision.tmp`,
    );
    writeFileSync(collision, "someone else's temporary file");

    assert.throws(
      () => installMacOSCredentialHelper({ ...fixture, randomId: () => "test-collision" }),
      (error) => error instanceof MacOSCredentialError && error.code === "helper_missing_or_invalid",
    );
    assert.equal(readFileSync(collision, "utf8"), "someone else's temporary file");
  });
});

test("publishes the verifier's staged bytes when the packaged path changes later", () => {
  withFixture((fixture) => {
    const expectedBytes = Buffer.from(fixture.binaryBytes);
    const installed = installMacOSCredentialHelper({
      ...fixture,
      verifyHelper({ binary }) {
        writeFileSync(binary, "changed after staged verification");
        return { bytes: expectedBytes };
      },
    });

    assert.deepEqual(readFileSync(installed), expectedBytes);
  });
});

test("configure returns status without credentials", () => {
  const result = configureMacOSCredentials({
    helperPath: "/fixture/helper",
    run: () => JSON.stringify({ status: "ok", configured: true }),
  });

  assert.deepEqual(result, {
    configured: true,
    message: "Lovart credentials saved on this Mac.",
  });
  assert.equal(JSON.stringify(result).includes("accessKey"), false);
});

test("read maps private helper payload and never includes it in errors", () => {
  const value = readMacOSCredentials({
    helperPath: "/fixture/helper",
    run: () => JSON.stringify({
      status: "ok",
      credentials: { accessKey: "ak-private", secretKey: "sk-private" },
    }),
  });
  assert.deepEqual(value, { accessKey: "ak-private", secretKey: "sk-private" });

  assert.throws(
    () => readMacOSCredentials({
      helperPath: "/fixture/helper",
      run: () => {
        throw Object.assign(new Error("failed"), { stdout: "ak-private sk-private" });
      },
    }),
    (error) =>
      error instanceof MacOSCredentialError &&
      !error.message.includes("ak-private") &&
      !error.message.includes("sk-private"),
  );
});

test("invokes only an installed helper command with private pipe options", () => {
  const calls = [];
  const result = getMacOSCredentialStatus({
    helperPath: "/fixture/helper",
    run: (command, args, options) => {
      calls.push({ command, args, options });
      return JSON.stringify({
        status: "ok",
        credentialStatus: {
          configured: true,
          synchronizable: false,
          accessibility: "when_unlocked_this_device_only",
        },
      });
    },
  });

  assert.deepEqual(result, {
    configured: true,
    synchronizable: false,
    accessibility: "when_unlocked_this_device_only",
  });
  assert.deepEqual(calls, [{
    command: "/fixture/helper",
    args: ["status"],
    options: { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 30_000 },
  }]);
});

test("rejects malformed, multiple, or credential-bearing status responses", () => {
  for (const output of [
    "",
    "{",
    '{"status":"ok","configured":true}\n{"status":"ok","configured":true}',
    JSON.stringify({ status: "ok", credentialStatus: { configured: true }, credentials: {} }),
  ]) {
    assert.throws(
      () => getMacOSCredentialStatus({ helperPath: "/fixture/helper", run: () => output }),
      (error) => error instanceof MacOSCredentialError && error.code === "invalid_payload",
    );
  }
});

test("maps typed helper failures without exposing helper output", () => {
  assert.throws(
    () => readMacOSCredentials({
      helperPath: "/fixture/helper",
      run: () => JSON.stringify({ status: "error", errorCode: "keychain_read_failed", osStatus: -25308 }),
    }),
    (error) =>
      error instanceof MacOSCredentialError &&
      error.code === "keychain_read_failed" &&
      error.osStatus === -25308 &&
      error.message === "Lovart could not read credentials from the login Keychain.",
  );
});

test("rejects unsafe OSStatus values", () => {
  for (const osStatus of [2 ** 53, 2 ** 31, -(2 ** 31) - 1]) {
    assert.throws(
      () => readMacOSCredentials({
        helperPath: "/fixture/helper",
        run: () => JSON.stringify({ status: "error", errorCode: "keychain_read_failed", osStatus }),
      }),
      (error) => error instanceof MacOSCredentialError && error.code === "invalid_payload",
    );
  }
});
