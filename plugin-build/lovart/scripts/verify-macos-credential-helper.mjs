import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  closeSync,
  constants as fsConstants,
  fchmodSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const manifestPattern = /^[0-9a-f]{64}\n$/;

function sameInode(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}

function readRegularFileNoFollow(file) {
  if (!Number.isInteger(fsConstants.O_NOFOLLOW)) {
    throw new Error("O_NOFOLLOW is required to verify the helper");
  }

  const named = lstatSync(file);
  if (!named.isFile() || named.isSymbolicLink()) {
    throw new Error("helper must be a regular file");
  }

  const descriptor = openSync(file, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  try {
    const opened = fstatSync(descriptor);
    if (!opened.isFile() || !sameInode(named, opened)) {
      throw new Error("helper changed while opening");
    }
    const bytes = readFileSync(descriptor);
    const closed = fstatSync(descriptor);
    const current = lstatSync(file);
    if (!sameInode(opened, closed) || !sameInode(opened, current)) {
      throw new Error("helper changed while reading");
    }
    return bytes;
  } finally {
    closeSync(descriptor);
  }
}

function writePrivateStage(file, bytes) {
  const descriptor = openSync(
    file,
    fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW,
    0o700,
  );
  try {
    writeFileSync(descriptor, bytes);
    fchmodSync(descriptor, 0o700);
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

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
  const sourceBytes = readRegularFileNoFollow(binary);
  const stagingDirectory = mkdtempSync(join(tmpdir(), "lovart-helper-verified-"));
  const stagedBinary = join(stagingDirectory, "lovart-credential-helper");
  try {
    writePrivateStage(stagedBinary, sourceBytes);
    const stagedBytes = readRegularFileNoFollow(stagedBinary);
    const actualHash = createHash("sha256").update(stagedBytes).digest("hex");
    if (actualHash !== expectedHash) {
      throw new Error("SHA-256 mismatch");
    }

    const archs = execFile("xcrun", ["lipo", "-archs", stagedBinary], { encoding: "utf8" })
      .trim()
      .split(/\s+/)
      .sort();
    if (archs.length !== 2 || archs[0] !== "arm64" || archs[1] !== "x86_64") {
      throw new Error("helper must contain arm64 and x86_64 architectures");
    }

    execFile("codesign", ["--verify", "--strict", stagedBinary], { stdio: "pipe" });
    const version = execFile(stagedBinary, ["--version"], { encoding: "utf8" }).trim();
    if (version !== expectedVersion) {
      throw new Error(`helper version must be ${expectedVersion}`);
    }
    return { archs, version, bytes: stagedBytes };
  } finally {
    rmSync(stagingDirectory, { force: true, recursive: true });
  }
}
