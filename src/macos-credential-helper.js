import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  constants as fsConstants,
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
} from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { verifyMacOSCredentialHelper } from "../scripts/verify-macos-credential-helper.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const defaultProjectRoot = path.resolve(here, "..");
const manifestPattern = /^[0-9a-f]{64}\n$/;
const maximumHelperResponseBytes = 16 * 1024;
const helperErrorMessages = Object.freeze({
  not_configured: "Lovart credentials are not configured on this Mac. Run Lovart credential setup.",
  cancelled: "Lovart credential setup was cancelled.",
  keychain_locked: "Unlock this Mac's login Keychain and try again.",
  caller_not_trusted: "Lovart credential access is available only from trusted local Codex.",
  helper_missing_or_invalid: "Lovart credential helper is missing or invalid. Repair or reinstall the Lovart plugin.",
  keychain_write_failed: "Lovart could not save credentials to the login Keychain.",
  keychain_read_failed: "Lovart could not read credentials from the login Keychain.",
  invalid_payload: "Lovart credential helper returned an invalid response.",
});

const knownHelperErrorCodes = new Set(Object.keys(helperErrorMessages));

export const helperProtocolVersion = "1";
export const helperRelativeInstallPath = path.join(
  "Library",
  "Application Support",
  "Lovart Codex",
  "credential-helper",
  helperProtocolVersion,
  "lovart-credential-helper",
);

export class MacOSCredentialError extends Error {
  constructor(code, { osStatus } = {}) {
    super(helperErrorMessages[code] || helperErrorMessages.invalid_payload);
    this.name = "MacOSCredentialError";
    this.code = knownHelperErrorCodes.has(code) ? code : "invalid_payload";
    if (Number.isInteger(osStatus)) this.osStatus = osStatus;
  }
}

function helperInvalid() {
  return new MacOSCredentialError("helper_missing_or_invalid");
}

function invalidPayload() {
  return new MacOSCredentialError("invalid_payload");
}

function expectedHashFromManifest(manifest) {
  const content = readFileSync(manifest, "utf8");
  if (!manifestPattern.test(content)) throw helperInvalid();
  return content.slice(0, -1);
}

function sha256(file) {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

function hasExpectedHash(file, expectedHash) {
  try {
    return sha256(file) === expectedHash;
  } catch {
    return false;
  }
}

function ensurePrivateDirectory(directory) {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  chmodSync(directory, 0o700);
  if ((statSync(directory).mode & 0o777) !== 0o700) throw helperInvalid();
}

/**
 * Installs the verified, packaged v1 helper at its fixed user-local path.
 * Test callers may inject verifyHelper to avoid running macOS signing tools on
 * disposable fixture bytes; production uses Task 3's full verifier.
 */
export function installMacOSCredentialHelper({
  projectRoot = defaultProjectRoot,
  homeDir = homedir(),
  verifyHelper = verifyMacOSCredentialHelper,
} = {}) {
  const bundledHelper = path.join(projectRoot, "bin", "macos", "lovart-credential-helper");
  const manifest = `${bundledHelper}.sha256`;
  let temporaryFile;

  try {
    const expectedHash = expectedHashFromManifest(manifest);
    if (!hasExpectedHash(bundledHelper, expectedHash)) throw helperInvalid();

    // This verifies the packaged universal binary's signature, architectures,
    // and protocol version without ever executing the checkout copy directly.
    verifyHelper({
      binary: bundledHelper,
      manifest,
      expectedVersion: helperProtocolVersion,
    });

    const installedHelper = path.join(homeDir, helperRelativeInstallPath);
    const installDirectory = path.dirname(installedHelper);
    ensurePrivateDirectory(installDirectory);

    if (existsSync(installedHelper)) {
      if (!hasExpectedHash(installedHelper, expectedHash)) throw helperInvalid();
      chmodSync(installedHelper, 0o700);
      if ((statSync(installedHelper).mode & 0o777) !== 0o700) throw helperInvalid();
      return installedHelper;
    }

    temporaryFile = path.join(
      installDirectory,
      `.${path.basename(installedHelper)}.${process.pid}.${randomUUID()}.tmp`,
    );
    copyFileSync(bundledHelper, temporaryFile, fsConstants.COPYFILE_EXCL);
    chmodSync(temporaryFile, 0o700);
    if ((statSync(temporaryFile).mode & 0o777) !== 0o700 || !hasExpectedHash(temporaryFile, expectedHash)) {
      throw helperInvalid();
    }

    // Do not replace a helper another process installed while this copy was in
    // progress. It must independently match the same pinned bytes.
    if (existsSync(installedHelper)) {
      if (!hasExpectedHash(installedHelper, expectedHash)) throw helperInvalid();
      chmodSync(installedHelper, 0o700);
      return installedHelper;
    }

    renameSync(temporaryFile, installedHelper);
    temporaryFile = undefined;
    return installedHelper;
  } catch (error) {
    if (error instanceof MacOSCredentialError) throw error;
    throw helperInvalid();
  } finally {
    if (temporaryFile) {
      try {
        unlinkSync(temporaryFile);
      } catch {
        // The unique file was either never created or has already been removed.
      }
    }
  }
}

function parseOneHelperResponse(output) {
  const text = String(output ?? "");
  if (!text || Buffer.byteLength(text, "utf8") > maximumHelperResponseBytes) throw invalidPayload();

  // The executable writes one compact JSON object and one optional final LF.
  const responseText = text.endsWith("\n") ? text.slice(0, -1) : text;
  if (!responseText || responseText.includes("\n") || responseText !== responseText.trim()) {
    throw invalidPayload();
  }

  let response;
  try {
    response = JSON.parse(responseText);
  } catch {
    throw invalidPayload();
  }
  if (!isPlainObject(response)) throw invalidPayload();
  return response;
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasOnlyKeys(value, allowedKeys) {
  return Object.keys(value).every((key) => allowedKeys.includes(key));
}

function invokeHelper({ helperPath, command, run }) {
  try {
    return parseOneHelperResponse(run(helperPath, [command], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 30_000,
    }));
  } catch (error) {
    if (error instanceof MacOSCredentialError) throw error;

    // execFileSync supplies stdout when the helper deliberately exits nonzero
    // after emitting a typed JSON failure. Parse it privately, never log it.
    if (error && Object.hasOwn(error, "stdout")) {
      try {
        return parseOneHelperResponse(error.stdout);
      } catch {
        // A malformed or absent response is intentionally indistinguishable
        // from an unavailable helper to avoid exposing child-process details.
      }
    }
    throw helperInvalid();
  }
}

function throwTypedHelperFailure(response) {
  if (
    response.status !== "error" ||
    !hasOnlyKeys(response, ["status", "configured", "errorCode", "osStatus"]) ||
    typeof response.errorCode !== "string" ||
    !knownHelperErrorCodes.has(response.errorCode) ||
    (Object.hasOwn(response, "configured") && typeof response.configured !== "boolean") ||
    (Object.hasOwn(response, "osStatus") && !Number.isInteger(response.osStatus))
  ) {
    throw invalidPayload();
  }
  throw new MacOSCredentialError(response.errorCode, { osStatus: response.osStatus });
}

function throwIfHelperError(response) {
  if (response.status === "error") throwTypedHelperFailure(response);
}

export function configureMacOSCredentials({
  helperPath,
  run = execFileSync,
} = {}) {
  const response = invokeHelper({ helperPath, command: "configure", run });
  throwIfHelperError(response);

  if (
    response.status === "cancelled" &&
    response.errorCode === "cancelled" &&
    hasOnlyKeys(response, ["status", "errorCode"])
  ) {
    return { configured: false, message: helperErrorMessages.cancelled };
  }
  if (
    response.status !== "ok" ||
    response.configured !== true ||
    !hasOnlyKeys(response, ["status", "configured"])
  ) {
    throw invalidPayload();
  }
  return { configured: true, message: "Lovart credentials saved on this Mac." };
}

export function readMacOSCredentials({
  helperPath,
  run = execFileSync,
} = {}) {
  const response = invokeHelper({ helperPath, command: "read", run });
  throwIfHelperError(response);

  if (
    response.status !== "ok" ||
    !hasOnlyKeys(response, ["status", "configured", "credentials"]) ||
    (Object.hasOwn(response, "configured") && typeof response.configured !== "boolean") ||
    !isPlainObject(response.credentials) ||
    !hasOnlyKeys(response.credentials, ["accessKey", "secretKey"]) ||
    typeof response.credentials.accessKey !== "string" ||
    typeof response.credentials.secretKey !== "string" ||
    !response.credentials.accessKey.trim() ||
    !response.credentials.secretKey.trim()
  ) {
    throw invalidPayload();
  }

  return {
    accessKey: response.credentials.accessKey,
    secretKey: response.credentials.secretKey,
  };
}

export function getMacOSCredentialStatus({
  helperPath,
  run = execFileSync,
} = {}) {
  const response = invokeHelper({ helperPath, command: "status", run });
  throwIfHelperError(response);

  if (
    response.status !== "ok" ||
    !hasOnlyKeys(response, ["status", "credentialStatus"]) ||
    !isPlainObject(response.credentialStatus) ||
    !hasOnlyKeys(response.credentialStatus, ["configured", "synchronizable", "accessibility"]) ||
    typeof response.credentialStatus.configured !== "boolean" ||
    typeof response.credentialStatus.synchronizable !== "boolean" ||
    typeof response.credentialStatus.accessibility !== "string"
  ) {
    throw invalidPayload();
  }

  return { ...response.credentialStatus };
}
