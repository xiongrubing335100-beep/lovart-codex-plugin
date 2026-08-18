import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  constants as fsConstants,
  fchmodSync,
  fstatSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { verifyMacOSCredentialHelper } from "../scripts/verify-macos-credential-helper.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const defaultProjectRoot = path.resolve(here, "..");
const manifestPattern = /^[0-9a-f]{64}\n$/;
const maximumHelperResponseBytes = 16 * 1024;
const minimumInt32 = -(2 ** 31);
const maximumInt32 = (2 ** 31) - 1;
const trustedPreviousHelperHashes = Object.freeze([
  "f254b328a2c1fbf4665c3733173539b3620e88a0f047d8fc52bc17f9e6531b25",
]);
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
    if (isInt32(osStatus)) this.osStatus = osStatus;
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

function sameInode(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}

function isInt32(value) {
  return Number.isSafeInteger(value) && value >= minimumInt32 && value <= maximumInt32;
}

function requireNoFollow() {
  if (!Number.isInteger(fsConstants.O_NOFOLLOW)) throw helperInvalid();
}

function inspectInstalledHelper(file, expectedIdentity) {
  requireNoFollow();
  const named = lstatSync(file);
  if (!named.isFile() || named.isSymbolicLink()) throw helperInvalid();
  if (expectedIdentity && !sameInode(named, expectedIdentity)) throw helperInvalid();

  const descriptor = openSync(file, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  try {
    const opened = fstatSync(descriptor);
    if (!opened.isFile() || !sameInode(named, opened) || (expectedIdentity && !sameInode(opened, expectedIdentity))) {
      throw helperInvalid();
    }
    const bytes = readFileSync(descriptor);
    const afterRead = fstatSync(descriptor);
    const current = lstatSync(file);
    if (!sameInode(opened, afterRead) || !sameInode(opened, current)) throw helperInvalid();
    return {
      hash: createHash("sha256").update(bytes).digest("hex"),
      identity: opened,
    };
  } finally {
    closeSync(descriptor);
  }
}

function readValidatedRegularFile(file, expectedHash, expectedIdentity) {
  requireNoFollow();
  const named = lstatSync(file);
  if (!named.isFile() || named.isSymbolicLink()) throw helperInvalid();
  if (expectedIdentity && !sameInode(named, expectedIdentity)) throw helperInvalid();

  const descriptor = openSync(file, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  try {
    const opened = fstatSync(descriptor);
    if (!opened.isFile() || !sameInode(named, opened) || (expectedIdentity && !sameInode(opened, expectedIdentity))) {
      throw helperInvalid();
    }
    const bytes = readFileSync(descriptor);
    const afterRead = fstatSync(descriptor);
    const current = lstatSync(file);
    if (!sameInode(opened, afterRead) || !sameInode(opened, current)) throw helperInvalid();
    if (createHash("sha256").update(bytes).digest("hex") !== expectedHash) throw helperInvalid();
    return { bytes, identity: opened };
  } finally {
    closeSync(descriptor);
  }
}

function validateInstalledHelper(file, expectedHash, expectedIdentity) {
  requireNoFollow();
  const named = lstatSync(file);
  if (!named.isFile() || named.isSymbolicLink()) throw helperInvalid();
  if (expectedIdentity && !sameInode(named, expectedIdentity)) throw helperInvalid();

  const descriptor = openSync(file, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  try {
    const opened = fstatSync(descriptor);
    if (!opened.isFile() || !sameInode(named, opened) || (expectedIdentity && !sameInode(opened, expectedIdentity))) {
      throw helperInvalid();
    }
    const bytes = readFileSync(descriptor);
    if (createHash("sha256").update(bytes).digest("hex") !== expectedHash) throw helperInvalid();
    fchmodSync(descriptor, 0o700);
    const secured = fstatSync(descriptor);
    const current = lstatSync(file);
    if (!sameInode(opened, secured) || !sameInode(opened, current) || (secured.mode & 0o777) !== 0o700) {
      throw helperInvalid();
    }
    return opened;
  } finally {
    closeSync(descriptor);
  }
}

function ensureSafeInstallDirectory(homeDir) {
  requireNoFollow();
  const components = ["Library", "Application Support", "Lovart Codex", "credential-helper", helperProtocolVersion];
  try {
    lstatSync(homeDir);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    mkdirSync(homeDir, { recursive: true, mode: 0o700 });
  }
  const home = lstatSync(homeDir);
  if (!home.isDirectory() || home.isSymbolicLink()) throw helperInvalid();
  const homeDescriptor = openSync(
    homeDir,
    fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW,
  );
  try {
    if (!sameInode(home, fstatSync(homeDescriptor))) throw helperInvalid();
  } finally {
    closeSync(homeDescriptor);
  }
  let current = homeDir;

  for (const [index, component] of components.entries()) {
    const next = path.join(current, component);
    try {
      lstatSync(next);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
      mkdirSync(next, { mode: 0o700 });
    }
    const named = lstatSync(next);
    if (!named.isDirectory() || named.isSymbolicLink()) throw helperInvalid();
    const descriptor = openSync(next, fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW);
    try {
      const opened = fstatSync(descriptor);
      if (!opened.isDirectory() || !sameInode(named, opened)) throw helperInvalid();
      if (index >= 2) {
        fchmodSync(descriptor, 0o700);
        if ((fstatSync(descriptor).mode & 0o777) !== 0o700) throw helperInvalid();
      }
    } finally {
      closeSync(descriptor);
    }
    current = next;
  }
  return current;
}

function destinationExists(file) {
  try {
    lstatSync(file);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

function removeOwnedTemporary(file, identity) {
  try {
    if (sameInode(lstatSync(file), identity)) unlinkSync(file);
  } catch {
    // Do not remove an entry that was swapped after this function created it.
  }
}

function createPrivateTemporary(directory, basename, bytes, randomId) {
  requireNoFollow();
  const file = path.join(directory, `.${basename}.${process.pid}.${randomId()}.tmp`);
  let descriptor;
  try {
    descriptor = openSync(
      file,
      fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW,
      0o700,
    );
  } catch {
    throw helperInvalid();
  }

  try {
    writeFileSync(descriptor, bytes);
    fchmodSync(descriptor, 0o700);
    fsyncSync(descriptor);
    const identity = fstatSync(descriptor);
    if (!identity.isFile() || (identity.mode & 0o777) !== 0o700) throw helperInvalid();
    return { file, identity };
  } catch (error) {
    const identity = fstatSync(descriptor);
    closeSync(descriptor);
    removeOwnedTemporary(file, identity);
    throw error;
  } finally {
    if (descriptor !== undefined) {
      try {
        closeSync(descriptor);
      } catch {
        // The error path already closed the descriptor before cleanup.
      }
    }
  }
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
  randomId = randomUUID,
  beforePublish,
} = {}) {
  const bundledHelper = path.join(projectRoot, "bin", "macos", "lovart-credential-helper");
  const manifest = `${bundledHelper}.sha256`;
  let temporary;
  let installedPredecessor;

  try {
    const expectedHash = expectedHashFromManifest(manifest);
    const verification = verifyHelper({
      binary: bundledHelper,
      manifest,
      expectedVersion: helperProtocolVersion,
    });
    if (!Buffer.isBuffer(verification?.bytes)) throw helperInvalid();
    if (createHash("sha256").update(verification.bytes).digest("hex") !== expectedHash) throw helperInvalid();

    const installedHelper = path.join(homeDir, helperRelativeInstallPath);
    const installDirectory = ensureSafeInstallDirectory(homeDir);

    if (destinationExists(installedHelper)) {
      const installed = inspectInstalledHelper(installedHelper);
      if (installed.hash === expectedHash) {
        validateInstalledHelper(installedHelper, expectedHash, installed.identity);
        return installedHelper;
      }
      if (!trustedPreviousHelperHashes.includes(installed.hash)) throw helperInvalid();
      installedPredecessor = installed;
    }

    temporary = createPrivateTemporary(
      installDirectory,
      path.basename(installedHelper),
      verification.bytes,
      randomId,
    );
    readValidatedRegularFile(temporary.file, expectedHash, temporary.identity);

    beforePublish?.({ temporaryFile: temporary.file, installedHelper });

    if (installedPredecessor) {
      const current = inspectInstalledHelper(installedHelper);
      if (current.hash === expectedHash) {
        validateInstalledHelper(installedHelper, expectedHash, current.identity);
        return installedHelper;
      }
      if (
        !sameInode(current.identity, installedPredecessor.identity) ||
        current.hash !== installedPredecessor.hash ||
        !trustedPreviousHelperHashes.includes(current.hash)
      ) {
        throw helperInvalid();
      }

      renameSync(temporary.file, installedHelper);
      validateInstalledHelper(installedHelper, expectedHash, temporary.identity);
      return installedHelper;
    }

    try {
      linkSync(temporary.file, installedHelper);
      validateInstalledHelper(installedHelper, expectedHash, temporary.identity);
      return installedHelper;
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      validateInstalledHelper(installedHelper, expectedHash);
      return installedHelper;
    }
  } catch (error) {
    if (error instanceof MacOSCredentialError) throw error;
    throw helperInvalid();
  } finally {
    if (temporary) removeOwnedTemporary(temporary.file, temporary.identity);
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
      ...(command === "configure" ? {} : { timeout: 30_000 }),
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
    (Object.hasOwn(response, "osStatus") && !isInt32(response.osStatus))
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
