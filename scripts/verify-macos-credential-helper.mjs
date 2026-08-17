import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, copyFileSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const manifestPattern = /^[0-9a-f]{64}\n$/;

export function verifyMacOSCredentialHelper({
  binary,
  manifest = `${binary}.sha256`,
  expectedVersion = "1",
  execFile = execFileSync,
}) {
  const rawManifest = readFileSync(manifest, "utf8");
  if (!manifestPattern.test(rawManifest)) {
    throw new Error("manifest must contain one lowercase SHA-256 digest followed by one newline");
  }

  const expectedHash = rawManifest.slice(0, -1);
  const actualHash = createHash("sha256").update(readFileSync(binary)).digest("hex");
  if (actualHash !== expectedHash) {
    throw new Error("SHA-256 mismatch");
  }

  const archs = execFile("xcrun", ["lipo", "-archs", binary], { encoding: "utf8" })
    .trim()
    .split(/\s+/)
    .sort();
  if (archs.length !== 2 || archs[0] !== "arm64" || archs[1] !== "x86_64") {
    throw new Error("helper must contain arm64 and x86_64 architectures");
  }

  execFile("codesign", ["--verify", "--strict", binary], { stdio: "pipe" });

  const stagingDirectory = mkdtempSync(join(tmpdir(), "lovart-helper-verified-"));
  const stagedBinary = join(stagingDirectory, "lovart-credential-helper");
  try {
    copyFileSync(binary, stagedBinary);
    chmodSync(stagedBinary, 0o700);
    if ((statSync(stagedBinary).mode & 0o777) !== 0o700) {
      throw new Error("staged helper must have mode 0700");
    }

    const version = execFile(stagedBinary, ["--version"], { encoding: "utf8" }).trim();
    if (version !== expectedVersion) {
      throw new Error(`helper version must be ${expectedVersion}`);
    }
    return { archs, version };
  } finally {
    rmSync(stagingDirectory, { force: true, recursive: true });
  }
}
