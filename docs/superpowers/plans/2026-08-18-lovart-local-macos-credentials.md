# Lovart Local-Only macOS Credentials Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the current Mac's local Codex/Lovart plugin remember AK/SK across Codex and Mac restarts without syncing, migrating, logging, or storing them in plaintext.

**Architecture:** A fixed, universal Swift helper owns a single `ThisDeviceOnly` login-Keychain item and rejects callers whose ancestor chain is not signed local Codex. The Node MCP installs that helper at a stable per-user path, calls it for configuration and immediately before each Lovart subprocess, and injects the returned pair only into that subprocess environment.

**Tech Stack:** Swift 6, AppKit, Security.framework, libproc, Swift Testing/XCTest, Node.js ESM, `node:test`, macOS `lipo`, ad-hoc `codesign`, Codex local plugins/MCP.

## Global Constraints

- Persist credentials only on the current Mac; set `kSecAttrSynchronizable` to false and `kSecAttrAccessible` to `kSecAttrAccessibleWhenUnlockedThisDeviceOnly`.
- Store one atomic Keychain payload under service `com.lovart.codex.local` and account equal to the current numeric macOS user ID.
- Trust only an ancestor signed with Team identifier `2DC432GLL2` and identifier `com.openai.codex` or `codex`; do not trust path or CDHash alone.
- Install helper protocol v1 at `~/Library/Application Support/Lovart Codex/credential-helper/v1/lovart-credential-helper`; keep the parent directory and executable owner-only.
- Never place AK/SK in chat, MCP responses, logs, manifests, config files, shell history, plaintext files, `launchctl`, shell profiles, or global environment variables.
- On macOS do not fall back to the old `security` CLI, AppleScript Keychain storage, process environment, or plaintext storage.
- Configuration cancellation and invalid input must preserve the previous atomic Keychain payload.
- Read credentials once per Lovart operation and discard the Node reference after constructing the Python child environment.
- Preserve current Windows user-environment behavior and current Linux explicit process-environment behavior.
- The helper must be universal for `arm64` and `x86_64`, ad-hoc signed, hash-verified before installation, and not automatically replaced within protocol v1.

---

## File Map

- `macos-helper/Package.swift`: Swift package definition for core library, executable, and tests.
- `macos-helper/Sources/LovartCredentialCore/CredentialModels.swift`: credential payload, helper response, stable error codes, and protocols.
- `macos-helper/Sources/LovartCredentialCore/KeychainStore.swift`: Security.framework add/update/read/status behavior.
- `macos-helper/Sources/LovartCredentialCore/CallerValidator.swift`: parent-process traversal and Codex signature validation.
- `macos-helper/Sources/LovartCredentialCore/HelperCommandRunner.swift`: configure/read/status orchestration without UI or process globals.
- `macos-helper/Sources/LovartCredentialHelper/CredentialDialog.swift`: AppKit secure-entry window.
- `macos-helper/Sources/LovartCredentialHelper/main.swift`: CLI parsing, production dependency wiring, JSON output, and exit codes.
- `macos-helper/Tests/LovartCredentialCoreTests/KeychainStoreTests.swift`: atomic storage and attribute tests.
- `macos-helper/Tests/LovartCredentialCoreTests/RealKeychainSmokeTests.swift`: opt-in isolated dummy-item smoke test with guaranteed cleanup.
- `macos-helper/Tests/LovartCredentialCoreTests/CallerValidatorTests.swift`: trusted/untrusted ancestor tests.
- `macos-helper/Tests/LovartCredentialCoreTests/HelperCommandRunnerTests.swift`: configure/read/cancel/error redaction tests.
- `scripts/build-macos-credential-helper.sh`: reproducible two-architecture build, `lipo`, signing, and SHA-256 generation.
- `bin/macos/lovart-credential-helper`: canonical universal helper artifact.
- `bin/macos/lovart-credential-helper.sha256`: canonical artifact hash.
- `test/macos-helper-packaging.test.js`: architecture, signature, and hash assertions.
- `src/macos-credential-helper.js`: stable installation, integrity checks, invocation, and typed Node errors.
- `test/macos-credential-helper.test.js`: Node installer/invoker tests.
- `src/lovart-credentials.js`: platform configuration routing.
- `src/lovart-cli.js`: per-request helper read and Lovart child environment injection.
- `src/index.js`: public tool copy and error response behavior.
- `test/lovart-credentials.test.js`: configuration routing and secret-redaction tests.
- `test/lovart-cli.test.js`: per-request resolution and platform-regression tests.
- `README.md`: macOS one-time setup and security boundary.
- `plugin-build/lovart/**`: tracked distributable mirror of runtime, tests, helper artifacts, README, and skill.
- `../lovart-local-marketplace/plugins/lovart/**`: locally installed marketplace mirror.

---

### Task 1: Swift credential model and local-only Keychain store

**Files:**
- Create: `macos-helper/Package.swift`
- Create: `macos-helper/Sources/LovartCredentialCore/CredentialModels.swift`
- Create: `macos-helper/Sources/LovartCredentialCore/KeychainStore.swift`
- Create: `macos-helper/Tests/LovartCredentialCoreTests/KeychainStoreTests.swift`

**Interfaces:**
- Produces: `LovartCredentials(accessKey:secretKey:)`, `HelperErrorCode`, `CredentialStoring`, `SecurityCalling`, `SystemKeychainStore`.
- Produces: `SystemKeychainStore(service:account:security:)`, `save(_:) throws`, `load() throws -> LovartCredentials`, and `status() throws -> CredentialStatus`; `service` defaults to `com.lovart.codex.local`.
- Consumes: Security.framework constants and the current numeric UID from `getuid()`.

- [ ] **Step 1: Add the Swift package skeleton**

```swift
// macos-helper/Package.swift
// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "LovartCredentialHelper",
    platforms: [.macOS(.v13)],
    products: [
        .library(name: "LovartCredentialCore", targets: ["LovartCredentialCore"]),
        .executable(name: "lovart-credential-helper", targets: ["LovartCredentialHelper"]),
    ],
    targets: [
        .target(
            name: "LovartCredentialCore",
            linkerSettings: [.linkedFramework("Security")]
        ),
        .executableTarget(
            name: "LovartCredentialHelper",
            dependencies: ["LovartCredentialCore"],
            linkerSettings: [.linkedFramework("AppKit"), .linkedFramework("Security")]
        ),
        .testTarget(
            name: "LovartCredentialCoreTests",
            dependencies: ["LovartCredentialCore"]
        ),
    ]
)
```

- [ ] **Step 2: Write failing Keychain tests**

Define a `RecordingSecurityClient` that records add, update, and copy dictionaries. Add tests with these exact assertions:

```swift
@Test func saveAddsOneLocalOnlyAtomicPayload() throws {
    let security = RecordingSecurityClient(addStatus: errSecSuccess)
    let store = SystemKeychainStore(account: "501", security: security)

    try store.save(LovartCredentials(accessKey: "ak-test", secretKey: "sk-test"))

    #expect(security.added.count == 1)
    let attributes = security.added[0]
    #expect(attributes[kSecAttrService as String] as? String == "com.lovart.codex.local")
    #expect(attributes[kSecAttrAccount as String] as? String == "501")
    #expect(attributes[kSecAttrSynchronizable as String] as? Bool == false)
    #expect(
        attributes[kSecAttrAccessible as String] as? String
            == (kSecAttrAccessibleWhenUnlockedThisDeviceOnly as String)
    )
    let data = try #require(attributes[kSecValueData as String] as? Data)
    #expect(try JSONDecoder().decode(LovartCredentials.self, from: data)
        == LovartCredentials(accessKey: "ak-test", secretKey: "sk-test"))
}

@Test func duplicateSaveUpdatesOneCombinedValue() throws {
    let security = RecordingSecurityClient(addStatus: errSecDuplicateItem)
    let store = SystemKeychainStore(account: "501", security: security)

    try store.save(LovartCredentials(accessKey: "ak-new", secretKey: "sk-new"))

    #expect(security.updated.count == 1)
    #expect(security.deleted.isEmpty)
}

@Test func loadMapsMissingAndLockedStatuses() {
    #expect(throws: HelperFailure.notConfigured) {
        try SystemKeychainStore(
            account: "501",
            security: RecordingSecurityClient(copyStatus: errSecItemNotFound)
        ).load()
    }
    #expect(throws: HelperFailure.keychainLocked) {
        try SystemKeychainStore(
            account: "501",
            security: RecordingSecurityClient(copyStatus: errSecInteractionNotAllowed)
        ).load()
    }
}

@Test func statusReportsNonSynchronizingThisDeviceOnlyAttributes() throws {
    let security = RecordingSecurityClient(
        copyStatus: errSecSuccess,
        copyResult: [
            kSecAttrSynchronizable as String: false,
            kSecAttrAccessible as String: kSecAttrAccessibleWhenUnlockedThisDeviceOnly,
        ]
    )
    let status = try SystemKeychainStore(account: "501", security: security).status()
    #expect(status == CredentialStatus(
        configured: true,
        synchronizable: false,
        accessibility: "when_unlocked_this_device_only"
    ))
}
```

- [ ] **Step 3: Run the focused tests and confirm RED**

Run:

```bash
swift test --package-path macos-helper --filter KeychainStoreTests
```

Expected: compilation fails because the credential types and store do not exist.

- [ ] **Step 4: Implement the model and Security client boundary**

Use these exact public types in `CredentialModels.swift`:

```swift
import Foundation

public struct LovartCredentials: Codable, Equatable, Sendable {
    public let accessKey: String
    public let secretKey: String

    public init(accessKey: String, secretKey: String) {
        self.accessKey = accessKey
        self.secretKey = secretKey
    }

    public var isValid: Bool {
        !accessKey.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            && !secretKey.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }
}

public enum HelperErrorCode: String, Codable, Sendable {
    case notConfigured = "not_configured"
    case cancelled
    case keychainLocked = "keychain_locked"
    case callerNotTrusted = "caller_not_trusted"
    case helperMissingOrInvalid = "helper_missing_or_invalid"
    case keychainWriteFailed = "keychain_write_failed"
    case keychainReadFailed = "keychain_read_failed"
    case invalidPayload = "invalid_payload"
}

public enum HelperFailure: Error, Equatable {
    case notConfigured
    case keychainLocked
    case invalidPayload
    case keychainWriteFailed(OSStatus)
    case keychainReadFailed(OSStatus)
}

public struct CredentialStatus: Codable, Equatable, Sendable {
    public let configured: Bool
    public let synchronizable: Bool
    public let accessibility: String
}

public protocol CredentialStoring {
    func save(_ credentials: LovartCredentials) throws
    func load() throws -> LovartCredentials
    func status() throws -> CredentialStatus
}
```

In `KeychainStore.swift`, define `typealias SecurityAttributes = [String: Any]`, inject a `SecurityCalling` protocol, and implement `SystemSecurityClient` as thin wrappers around `SecItemAdd`, `SecItemUpdate`, and `SecItemCopyMatching`. Build add attributes with exactly:

```swift
[
    kSecClass as String: kSecClassGenericPassword,
    kSecAttrService as String: "com.lovart.codex.local",
    kSecAttrAccount as String: account,
    kSecAttrSynchronizable as String: false,
    kSecAttrAccessible as String: kSecAttrAccessibleWhenUnlockedThisDeviceOnly,
    kSecValueData as String: encodedCredentials,
]
```

On `errSecDuplicateItem`, call `SecItemUpdate` with only the combined `kSecValueData` value. Never delete before updating. Map `errSecItemNotFound` to `.notConfigured` and `errSecInteractionNotAllowed` or `errSecAuthFailed` to `.keychainLocked`; preserve only the numeric OSStatus for other errors.

- [ ] **Step 5: Run the focused and full Swift tests**

Run:

```bash
swift test --package-path macos-helper --filter KeychainStoreTests
swift test --package-path macos-helper
```

Expected: all tests pass and no test output contains `ak-test` or `sk-test` outside assertion source locations.

- [ ] **Step 6: Add an opt-in real-Keychain smoke test with dummy values**

Create `RealKeychainSmokeTests.swift`. Gate it so normal test runs skip it, use a UUID-suffixed service, and delete the item in `defer`:

```swift
@Test(.enabled(if: ProcessInfo.processInfo.environment["LOVART_RUN_KEYCHAIN_SMOKE"] == "1"))
func realKeychainRoundTripUsesIsolatedLocalOnlyItem() throws {
    let service = "com.lovart.codex.local.test.\(UUID().uuidString)"
    let account = String(getuid())
    defer {
        SecItemDelete([
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
        ] as CFDictionary)
    }

    let store = SystemKeychainStore(service: service, account: account)
    let dummy = LovartCredentials(accessKey: "ak-dummy-smoke", secretKey: "sk-dummy-smoke")
    try store.save(dummy)
    #expect(try store.load() == dummy)
    #expect(try store.status() == CredentialStatus(
        configured: true,
        synchronizable: false,
        accessibility: "when_unlocked_this_device_only"
    ))
}
```

Do not print the dummy payload. The production service name must not appear in the add/delete query used by this test.

- [ ] **Step 7: Run the opt-in smoke test once**

Run:

```bash
LOVART_RUN_KEYCHAIN_SMOKE=1 swift test --package-path macos-helper \
  --filter realKeychainRoundTripUsesIsolatedLocalOnlyItem
```

Expected: the isolated add/read/status/delete cycle passes, and a second run also passes because the first item was removed.

- [ ] **Step 8: Commit the Keychain core**

```bash
git add macos-helper/Package.swift macos-helper/Sources/LovartCredentialCore macos-helper/Tests/LovartCredentialCoreTests/KeychainStoreTests.swift macos-helper/Tests/LovartCredentialCoreTests/RealKeychainSmokeTests.swift
git commit -m "feat: add local-only Lovart Keychain store"
```

---

### Task 2: Trusted caller validation, native dialog, and helper commands

**Files:**
- Create: `macos-helper/Sources/LovartCredentialCore/CallerValidator.swift`
- Create: `macos-helper/Sources/LovartCredentialCore/HelperCommandRunner.swift`
- Create: `macos-helper/Sources/LovartCredentialHelper/CredentialDialog.swift`
- Create: `macos-helper/Sources/LovartCredentialHelper/main.swift`
- Create: `macos-helper/Tests/LovartCredentialCoreTests/CallerValidatorTests.swift`
- Create: `macos-helper/Tests/LovartCredentialCoreTests/HelperCommandRunnerTests.swift`

**Interfaces:**
- Consumes: `CredentialStoring`, `LovartCredentials`, `CredentialStatus`, and `HelperErrorCode` from Task 1.
- Produces: `CodeSignatureIdentity`, `ProcessInspecting`, `CallerValidating`, `CallerValidator`, `CredentialPrompting`, `HelperCommand`, `HelperResponse`, and `HelperCommandRunner.run(_:)`.
- CLI commands: `configure`, `read`, `status`, and `--version`; protocol version is exactly `1`.

- [ ] **Step 1: Write failing caller-validation tests**

```swift
@Test func trustsOpenAICodexAncestor() throws {
    let processes = FakeProcessInspector(
        parents: [700: 600, 600: 500, 500: 1],
        identities: [
            700: .unsigned,
            600: CodeSignatureIdentity(identifier: "codex", teamIdentifier: "2DC432GLL2"),
        ]
    )
    #expect(try CallerValidator(processes: processes).isTrusted(startingAt: 700))
}

@Test func rejectsWrongTeamPathMatchAndInspectionFailure() throws {
    let wrongTeam = FakeProcessInspector(
        parents: [700: 600, 600: 1],
        identities: [
            600: CodeSignatureIdentity(identifier: "codex", teamIdentifier: "OTHERTEAM")
        ]
    )
    #expect(try !CallerValidator(processes: wrongTeam).isTrusted(startingAt: 700))
    #expect(throws: ProcessInspectionError.self) {
        try CallerValidator(processes: .failing).isTrusted(startingAt: 700)
    }
}
```

- [ ] **Step 2: Write failing command-runner tests**

Cover configure success, configure cancellation, invalid pair preservation, read success, status without secrets, and untrusted denial:

```swift
@Test func cancelledConfigureDoesNotWrite() throws {
    let store = RecordingCredentialStore(existing: .fixture)
    let runner = HelperCommandRunner(
        caller: AlwaysTrustedCaller(),
        store: store,
        prompt: FixedPrompt(result: .cancelled)
    )

    let response = try runner.run(.configure)

    #expect(response.status == "cancelled")
    #expect(response.errorCode == .cancelled)
    #expect(store.saved.isEmpty)
    #expect(store.current == .fixture)
}

@Test func configureResponseNeverContainsCredentials() throws {
    let runner = HelperCommandRunner(
        caller: AlwaysTrustedCaller(),
        store: RecordingCredentialStore(),
        prompt: FixedPrompt(result: .credentials(.fixture))
    )
    let data = try JSONEncoder().encode(runner.run(.configure))
    let text = try #require(String(data: data, encoding: .utf8))
    #expect(!text.contains("ak-fixture"))
    #expect(!text.contains("sk-fixture"))
}

@Test func readReturnsCredentialsOnlyForTrustedCaller() throws {
    let trusted = HelperCommandRunner(
        caller: AlwaysTrustedCaller(),
        store: RecordingCredentialStore(existing: .fixture),
        prompt: FixedPrompt(result: .cancelled)
    )
    #expect(try trusted.run(.read).credentials == .fixture)

    let denied = HelperCommandRunner(
        caller: NeverTrustedCaller(),
        store: RecordingCredentialStore(existing: .fixture),
        prompt: FixedPrompt(result: .cancelled)
    )
    #expect(try denied.run(.read).errorCode == .callerNotTrusted)
}
```

- [ ] **Step 3: Run the focused tests and confirm RED**

Run:

```bash
swift test --package-path macos-helper --filter CallerValidatorTests
swift test --package-path macos-helper --filter HelperCommandRunnerTests
```

Expected: compilation fails because the validator and command runner do not exist.

- [ ] **Step 4: Implement process-chain signature validation**

Use these exact identities and traversal behavior:

```swift
public struct CodeSignatureIdentity: Equatable, Sendable {
    public let identifier: String
    public let teamIdentifier: String
    public static let unsigned = CodeSignatureIdentity(identifier: "", teamIdentifier: "")
}

public protocol ProcessInspecting {
    func parentPID(of pid: pid_t) throws -> pid_t
    func signatureIdentity(of pid: pid_t) throws -> CodeSignatureIdentity
}

public struct CallerValidator: CallerValidating {
    private static let team = "2DC432GLL2"
    private static let identifiers = Set(["com.openai.codex", "codex"])

    public func isTrusted(startingAt pid: pid_t) throws -> Bool {
        var current = pid
        var visited = Set<pid_t>()
        while current > 1 && visited.insert(current).inserted {
            let identity = try processes.signatureIdentity(of: current)
            if identity.teamIdentifier == Self.team
                && Self.identifiers.contains(identity.identifier) {
                return true
            }
            current = try processes.parentPID(of: current)
        }
        return false
    }
}
```

Implement production parent lookup with `proc_pidinfo(..., PROC_PIDTBSDINFO, ...)` and `pbi_ppid`. Implement signature lookup with `SecCodeCopyGuestWithAttributes` using `kSecGuestAttributePid`, then `SecCodeCopySigningInformation`; read `kSecCodeInfoIdentifier` and `kSecCodeInfoTeamIdentifier`. Missing signatures return `.unsigned`; inability to inspect the chain throws and fails closed.

- [ ] **Step 5: Implement the command runner and stable JSON protocol**

Use these exact shapes:

```swift
public enum HelperCommand: String, Sendable {
    case configure
    case read
    case status
}

public struct HelperResponse: Codable, Sendable {
    public let status: String
    public let configured: Bool?
    public let errorCode: HelperErrorCode?
    public let osStatus: Int32?
    public let credentials: LovartCredentials?
    public let credentialStatus: CredentialStatus?
}
```

`HelperCommandRunner.run(_:)` first checks `caller.isTrusted()`. Configure invokes `CredentialPrompting`, rejects an invalid pair before `store.save`, and returns no credentials. Read returns credentials only on success. Status returns only `CredentialStatus`. Map every `HelperFailure` to its stable error code and never use `String(describing: credentials)` in an error.

- [ ] **Step 6: Implement the native secure-entry dialog and executable**

`CredentialDialog.swift` must create one `NSWindow` containing labeled AK and SK `NSSecureTextField` controls plus Cancel and Save buttons. Activate it with:

```swift
NSApplication.shared.setActivationPolicy(.accessory)
NSApplication.shared.activate(ignoringOtherApps: true)
```

Return `.cancelled` without touching the store, and keep the window open with an inline error when either trimmed field is empty. Do not prefill existing credentials.

`main.swift` must:

```swift
let argument = CommandLine.arguments.dropFirst().first
if argument == "--version" {
    print("1")
    exit(EXIT_SUCCESS)
}

guard let raw = argument, let command = HelperCommand(rawValue: raw) else {
    emit(HelperResponse.invalidPayload())
    exit(EXIT_FAILURE)
}

let runner = HelperCommandRunner.production(parentPID: getppid())
let response = runner.run(command)
emit(response)
exit(response.status == "error" ? EXIT_FAILURE : EXIT_SUCCESS)
```

Write exactly one compact JSON object to stdout. Keep stderr empty for expected failures. The `read` command's stdout is a private MCP pipe and is the only helper response allowed to contain credentials.

- [ ] **Step 7: Run all Swift tests**

Run:

```bash
swift test --package-path macos-helper
```

Expected: all Keychain, validation, command, cancellation, and redaction tests pass.

- [ ] **Step 8: Commit the helper behavior**

```bash
git add macos-helper
git commit -m "feat: add trusted macOS Lovart credential helper"
```

---

### Task 3: Universal helper build, signing, and packaging verification

**Files:**
- Create: `scripts/build-macos-credential-helper.sh`
- Create: `bin/macos/lovart-credential-helper`
- Create: `bin/macos/lovart-credential-helper.sha256`
- Create: `test/macos-helper-packaging.test.js`

**Interfaces:**
- Consumes: Swift executable product `lovart-credential-helper` from Task 2.
- Produces: a universal ad-hoc-signed binary and a lowercase 64-character SHA-256 file used by Node installer code.

- [ ] **Step 1: Write the failing packaging test**

```js
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
  const archs = execFileSync("xcrun", ["lipo", "-archs", binary], { encoding: "utf8" })
    .trim()
    .split(/\s+/)
    .sort();

  assert.deepEqual(archs, ["arm64", "x86_64"]);
  assert.equal(actual, expected);
  execFileSync("codesign", ["--verify", "--strict", binary], { stdio: "pipe" });
});
```

- [ ] **Step 2: Run the packaging test and confirm RED**

Run:

```bash
node --test --test-isolation=none test/macos-helper-packaging.test.js
```

Expected: failure because the binary and hash do not exist.

- [ ] **Step 3: Add the reproducible universal build script**

The script must use exact target triples and obtain each output directory from SwiftPM rather than assuming it:

```bash
#!/bin/bash
set -euo pipefail

project_root="$(cd "$(dirname "$0")/.." && pwd)"
package_path="$project_root/macos-helper"
output_dir="$project_root/bin/macos"
arm_scratch="$package_path/.build/arm64"
x86_scratch="$package_path/.build/x86_64"

mkdir -p "$output_dir"

swift build --package-path "$package_path" --configuration release \
  --triple arm64-apple-macosx13.0 --scratch-path "$arm_scratch" \
  --product lovart-credential-helper
swift build --package-path "$package_path" --configuration release \
  --triple x86_64-apple-macosx13.0 --scratch-path "$x86_scratch" \
  --product lovart-credential-helper

arm_bin="$(swift build --package-path "$package_path" --configuration release \
  --triple arm64-apple-macosx13.0 --scratch-path "$arm_scratch" --show-bin-path)"
x86_bin="$(swift build --package-path "$package_path" --configuration release \
  --triple x86_64-apple-macosx13.0 --scratch-path "$x86_scratch" --show-bin-path)"
output="$output_dir/lovart-credential-helper"

xcrun lipo -create \
  "$arm_bin/lovart-credential-helper" \
  "$x86_bin/lovart-credential-helper" \
  -output "$output"
codesign --force --sign - "$output"
chmod 700 "$output"
shasum -a 256 "$output" | awk '{print $1}' > "$output.sha256"
```

- [ ] **Step 4: Build and verify the artifact**

Run:

```bash
chmod +x scripts/build-macos-credential-helper.sh
scripts/build-macos-credential-helper.sh
node --test --test-isolation=none test/macos-helper-packaging.test.js
```

Expected: Swift builds both targets, `lipo` reports `arm64 x86_64`, signature verification succeeds, and the test passes.

- [ ] **Step 5: Commit source, build script, binary, hash, and test**

```bash
git add scripts/build-macos-credential-helper.sh bin/macos test/macos-helper-packaging.test.js
git commit -m "build: package universal Lovart credential helper"
```

---

### Task 4: Node helper installation and invocation

**Files:**
- Create: `src/macos-credential-helper.js`
- Create: `test/macos-credential-helper.test.js`

**Interfaces:**
- Consumes: `bin/macos/lovart-credential-helper`, its `.sha256` file, and helper JSON protocol v1.
- Produces: `installMacOSCredentialHelper(options) -> string`, `configureMacOSCredentials(options) -> object`, `readMacOSCredentials(options) -> { accessKey, secretKey }`, and `getMacOSCredentialStatus(options) -> object`.
- Produces: `MacOSCredentialError` with stable `code` and optional non-secret `osStatus`.

- [ ] **Step 1: Write failing installer tests**

Use a test-owned temporary home and dummy executable bytes:

```js
test("installs a verified helper atomically with owner-only permissions", () => {
  const fixture = createHelperFixture();
  const installed = installMacOSCredentialHelper({
    projectRoot: fixture.projectRoot,
    homeDir: fixture.homeDir,
  });

  assert.equal(installed, path.join(
    fixture.homeDir,
    "Library/Application Support/Lovart Codex/credential-helper/v1/lovart-credential-helper",
  ));
  assert.equal(statSync(path.dirname(installed)).mode & 0o777, 0o700);
  assert.equal(statSync(installed).mode & 0o777, 0o700);
  assert.deepEqual(readFileSync(installed), fixture.binaryBytes);
});

test("preserves a valid v1 helper and rejects a changed one", () => {
  const fixture = createHelperFixture();
  const installed = installMacOSCredentialHelper(fixture);
  const firstMtime = statSync(installed).mtimeMs;
  assert.equal(installMacOSCredentialHelper(fixture), installed);
  assert.equal(statSync(installed).mtimeMs, firstMtime);

  writeFileSync(installed, "tampered");
  assert.throws(
    () => installMacOSCredentialHelper(fixture),
    (error) => error.code === "helper_missing_or_invalid",
  );
});
```

- [ ] **Step 2: Write failing invocation and redaction tests**

```js
test("configure returns status without credentials", () => {
  const result = configureMacOSCredentials({
    helperPath: "/fixture/helper",
    run: () => JSON.stringify({ status: "ok", configured: true }),
  });
  assert.deepEqual(result, { configured: true, message: "Lovart credentials saved on this Mac." });
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
      run: () => { throw Object.assign(new Error("failed"), { stdout: "ak-private sk-private" }); },
    }),
    (error) => !error.message.includes("ak-private") && !error.message.includes("sk-private"),
  );
});
```

- [ ] **Step 3: Run focused tests and confirm RED**

Run:

```bash
node --test --test-isolation=none test/macos-credential-helper.test.js
```

Expected: failure because `src/macos-credential-helper.js` does not exist.

- [ ] **Step 4: Implement atomic installation and integrity checks**

Set these exact constants:

```js
export const helperProtocolVersion = "1";
export const helperRelativeInstallPath = path.join(
  "Library",
  "Application Support",
  "Lovart Codex",
  "credential-helper",
  helperProtocolVersion,
  "lovart-credential-helper",
);
```

`installMacOSCredentialHelper` must:

1. read the expected lowercase hash from `bin/macos/lovart-credential-helper.sha256`;
2. verify the bundled binary before copying;
3. create the v1 directory with mode `0700`;
4. if the destination exists, verify it and return it without replacing or touching mtime;
5. otherwise copy to a unique file in the same directory, `chmod 0700`, verify the copy, and `renameSync` atomically;
6. remove only the test-owned or function-created temporary file after an error;
7. throw `MacOSCredentialError("helper_missing_or_invalid")` without paths containing usernames or raw child output.

- [ ] **Step 5: Implement helper protocol parsing**

All calls use:

```js
run(helperPath, [command], {
  encoding: "utf8",
  stdio: ["ignore", "pipe", "pipe"],
  timeout: 30_000,
});
```

Parse one JSON object. Configure accepts only `{ status: "ok", configured: true }` or cancellation/error. Read accepts only non-empty `credentials.accessKey` and `credentials.secretKey`. Status never accepts a credentials property. Convert typed helper errors to user-facing messages in a fixed lookup table; never concatenate stdout, stderr, command arguments, or credential fields into an exception.

- [ ] **Step 6: Run focused and existing Node tests**

Run:

```bash
node --test --test-isolation=none test/macos-credential-helper.test.js
node --test --test-isolation=none
```

Expected: new tests pass and the existing suite remains green.

- [ ] **Step 7: Commit the Node helper adapter**

```bash
git add src/macos-credential-helper.js test/macos-credential-helper.test.js
git commit -m "feat: install and invoke Lovart macOS credential helper"
```

---

### Task 5: Route macOS configuration and per-request reads through the helper

**Files:**
- Modify: `src/lovart-credentials.js:1-109`
- Modify: `src/lovart-cli.js:1-96`
- Modify: `src/index.js:108-117`
- Modify: `test/lovart-credentials.test.js`
- Modify: `test/lovart-cli.test.js`
- Delete: `scripts/configure-lovart-credentials.applescript`

**Interfaces:**
- Consumes: `configureMacOSCredentials` and `readMacOSCredentials` from Task 4.
- Preserves: `configureCredentialsForPlatform`, `resolveLovartEnv`, `resolveLovartChildEnv`, and public MCP tool `lovart_configure_credentials`.
- Changes: macOS `resolveLovartEnv` receives a pair from one helper read per invocation; Windows continues to refresh user variables; Linux returns the supplied process environment.

- [ ] **Step 1: Replace obsolete macOS tests with failing helper-routing tests**

Delete tests that assert `security find-generic-password`, AppleScript storage, or session-only JXA prompts. Add:

```js
test("routes macOS configuration to the local-only helper", () => {
  const calls = [];
  const result = configureCredentialsForPlatform({
    platform: "darwin",
    projectRoot: "/plugin",
    configureMacCredentials: (options) => {
      calls.push(options);
      return { configured: true, message: "Lovart credentials saved on this Mac." };
    },
  });

  assert.equal(result.configured, true);
  assert.deepEqual(calls, [{ projectRoot: "/plugin" }]);
  assert.equal(JSON.stringify(result).includes("LOVART_ACCESS_KEY"), false);
});

test("reads latest macOS helper credentials for each Lovart child", () => {
  let pair = { accessKey: "ak-one", secretKey: "sk-one" };
  const readMacCredentials = () => pair;
  assert.equal(resolveLovartEnv({}, { platform: "darwin", readMacCredentials }).LOVART_ACCESS_KEY, "ak-one");

  pair = { accessKey: "ak-two", secretKey: "sk-two" };
  assert.equal(resolveLovartEnv({}, { platform: "darwin", readMacCredentials }).LOVART_ACCESS_KEY, "ak-two");
});

test("macOS ignores stale process credentials", () => {
  const resolved = resolveLovartEnv(
    { LOVART_ACCESS_KEY: "stale-ak", LOVART_SECRET_KEY: "stale-sk" },
    {
      platform: "darwin",
      readMacCredentials: () => ({ accessKey: "keychain-ak", secretKey: "keychain-sk" }),
    },
  );
  assert.equal(resolved.LOVART_ACCESS_KEY, "keychain-ak");
  assert.equal(resolved.LOVART_SECRET_KEY, "keychain-sk");
});
```

- [ ] **Step 2: Run focused tests and confirm RED**

Run:

```bash
node --test --test-isolation=none test/lovart-credentials.test.js test/lovart-cli.test.js
```

Expected: helper-routing assertions fail because runtime code still uses JXA and `security`.

- [ ] **Step 3: Simplify `lovart-credentials.js` platform routing**

Import `configureMacOSCredentials`. Remove `macOSSessionPromptSource`, `readMacOSKeychainVariable`, `configureMacOSSessionCredentials`, and the macOS branch in `openCredentialSetup`. Preserve Windows PowerShell behavior.

Use this routing shape:

```js
export function configureCredentialsForPlatform({
  platform = process.platform,
  projectRoot,
  configureMacCredentials = configureMacOSCredentials,
  spawnProcess = spawn,
  systemRoot = process.env.SystemRoot || "C:\\Windows",
} = {}) {
  if (platform === "darwin") {
    return configureMacCredentials({ projectRoot });
  }
  return openCredentialSetup({ platform, projectRoot, spawnProcess, systemRoot });
}
```

- [ ] **Step 4: Read the helper once per macOS Lovart operation**

Import `readMacOSCredentials` in `lovart-cli.js`. Replace `readMacVariable` with an injected pair reader:

```js
export function resolveLovartEnv(
  env = process.env,
  {
    platform = process.platform,
    readUserVariable = readWindowsUserVariable,
    readMacCredentials = () => readMacOSCredentials({ projectRoot }),
  } = {},
) {
  const resolved = { ...env };
  if (platform === "darwin") {
    const { accessKey, secretKey } = readMacCredentials();
    resolved.LOVART_ACCESS_KEY = accessKey;
    resolved.LOVART_SECRET_KEY = secretKey;
    return resolved;
  }
  if (platform === "win32") {
    for (const name of ["LOVART_ACCESS_KEY", "LOVART_SECRET_KEY"]) {
      const value = readUserVariable(name);
      if (value) resolved[name] = value;
    }
  }
  return resolved;
}
```

Do not catch `MacOSCredentialError` inside environment resolution; let the MCP return the helper's fixed actionable message. After `spawn` returns, clear local credential-object references; do not mutate the long-lived `process.env` on macOS.

- [ ] **Step 5: Update the MCP tool description and delete AppleScript storage**

Set the tool description to:

```text
Open the local macOS or Windows credential setup. On macOS, AK/SK are stored only in this Mac's non-synchronizing login Keychain and reused after restarts. Keys are never returned to chat.
```

Delete `scripts/configure-lovart-credentials.applescript`. No runtime file may invoke it.

- [ ] **Step 6: Run focused and full tests**

Run:

```bash
node --test --test-isolation=none test/lovart-credentials.test.js test/lovart-cli.test.js
node --test --test-isolation=none
```

Expected: helper routing, per-request freshness, redaction, MCP discovery, Windows, and Linux tests all pass.

- [ ] **Step 7: Commit runtime integration**

```bash
git add src test scripts/configure-lovart-credentials.applescript
git commit -m "feat: persist Lovart macOS credentials locally"
```

---

### Task 6: Update docs, distributable plugin, and local marketplace

**Files:**
- Modify: `README.md`
- Modify: `plugin-build/lovart/README.md`
- Modify: `plugin-build/lovart/.codex-plugin/plugin.json`
- Modify: `plugin-build/lovart/skills/lovart/SKILL.md`
- Create/modify/delete under `plugin-build/lovart/` to mirror Tasks 1-5 runtime, helper artifact, tests, and AppleScript removal.
- Create/modify/delete under `../lovart-local-marketplace/plugins/lovart/` to mirror the completed distributable.

**Interfaces:**
- Consumes: all passing canonical runtime and packaging outputs from Tasks 1-5.
- Produces: plugin version `0.1.0+codex.20260818.localkeychain1` in both distributable and marketplace manifests.
- Produces: installed cache with real npm-style dependency directories, not stripped pnpm symlink dependencies.

- [ ] **Step 1: Update user-facing documentation and skill instructions**

Replace the macOS README credential paragraph with:

```markdown
On macOS, ask the plugin to “更换密钥”. A native password-style window stores AK/SK in this Mac's login Keychain with synchronization and migration disabled. The local Codex/Lovart helper reads the pair for each Lovart operation, so Codex and Mac restarts do not require re-entry. Running setup again atomically replaces both values. Windows continues to use the user-scoped setup window; Linux continues to use the process environment.
```

Update the Lovart skill Credentials section so macOS key changes always call `lovart_configure_credentials`, never ask for secrets in chat, and explain that `not_configured` requires one local setup.

- [ ] **Step 2: Mirror canonical files into `plugin-build/lovart`**

Copy these exact paths while preserving executable modes:

```text
bin/macos/lovart-credential-helper
bin/macos/lovart-credential-helper.sha256
src/index.js
src/lovart-cli.js
src/lovart-credentials.js
src/macos-credential-helper.js
test/lovart-cli.test.js
test/lovart-credentials.test.js
test/macos-credential-helper.test.js
test/macos-helper-packaging.test.js
```

Delete `plugin-build/lovart/scripts/configure-lovart-credentials.applescript`. Set manifest version exactly to `0.1.0+codex.20260818.localkeychain1`.

- [ ] **Step 3: Run canonical and distributable tests**

Run:

```bash
node --test --test-isolation=none
cd plugin-build/lovart
node --test --test-isolation=none
```

Expected: canonical suite discovers both canonical and distributable tests; direct distributable suite passes independently.

- [ ] **Step 4: Commit the distributable update**

```bash
git add README.md plugin-build/lovart
git commit -m "chore: publish local-only macOS credential build"
```

- [ ] **Step 5: Mirror the distributable into the local marketplace**

Copy the tracked distributable files into `../lovart-local-marketplace/plugins/lovart/`, including the helper binary/hash, updated skill, README, runtime, tests, and manifest. Delete the marketplace AppleScript. Do not copy `.git`, downloads, test state, or Swift build scratch directories.

Recreate portable dependencies with real directories:

```bash
cd ../lovart-local-marketplace/plugins/lovart
pnpm --config.node-linker=hoisted install --force --lockfile=false
node --test --test-isolation=none
```

Expected: all marketplace tests pass and `stat -f '%HT' node_modules/@modelcontextprotocol/sdk` reports `Directory`.

- [ ] **Step 6: Install the updated local plugin**

Run:

```bash
codex plugin add lovart@lovart-local --json
```

Expected: JSON reports version `0.1.0+codex.20260818.localkeychain1` and a new versioned installed cache path.

- [ ] **Step 7: Verify the installed cache**

In the reported cache path, run:

```bash
env LOVART_OUTPUT_DIR=/private/tmp/lovart-plugin-local-keychain-verification \
  node --test --test-isolation=none
```

Expected: the complete installed-cache suite passes, including MCP tool discovery and helper packaging verification.

---

### Task 7: Real macOS smoke test and completion audit

**Files:**
- Modify only if verification finds a defect: the smallest owning file from Tasks 1-6 plus its focused test.
- Inspect: `docs/superpowers/specs/2026-08-18-lovart-local-macos-credentials-design.md`

**Interfaces:**
- Consumes: installed plugin version `0.1.0+codex.20260818.localkeychain1`.
- Produces: evidence that one-time entry survives a local Codex restart and is non-synchronizing.

- [ ] **Step 1: Run static completion checks**

Run:

```bash
git diff --check
git status --short
rg -n "security.*find-generic-password|configure-lovart-credentials\.applescript|launchctl setenv" \
  src plugin-build/lovart/src plugin-build/lovart/scripts README.md plugin-build/lovart/README.md
```

Expected: no whitespace errors, no unexpected worktree changes, and no active macOS legacy/fallback credential path.

- [ ] **Step 2: Perform first-time real setup without exposing credentials**

In a fresh Codex task, invoke `lovart_configure_credentials`. Ask the user to type the real AK and SK only into the native secure window. Confirm the MCP response contains only configured status and no credential fields.

- [ ] **Step 3: Verify authenticated use before restart**

Call the read-only Lovart billing-mode query or project-list tool. Expected: the request authenticates successfully without another key prompt. Do not generate paid media for this verification.

- [ ] **Step 4: Verify same-Mac persistence**

Ask the user to restart Codex once, open a fresh task, and call the same read-only Lovart query. Expected: it authenticates without asking for AK/SK.

- [ ] **Step 5: Verify local-only Keychain attributes without printing the secret**

Invoke the helper `status` command through the MCP's internal diagnostic path. Expected JSON:

```json
{
  "status": "ok",
  "credentialStatus": {
    "configured": true,
    "synchronizable": false,
    "accessibility": "when_unlocked_this_device_only"
  }
}
```

Do not call helper `read` from a terminal or print its stdout.

- [ ] **Step 6: Verify replacement cancellation preserves the current pair**

Invoke credential configuration, cancel the native window, then repeat the read-only Lovart query. Expected: cancellation is reported and the existing credentials still authenticate.

- [ ] **Step 7: Run final automated verification**

Run:

```bash
swift test --package-path macos-helper
LOVART_RUN_KEYCHAIN_SMOKE=1 swift test --package-path macos-helper \
  --filter realKeychainRoundTripUsesIsolatedLocalOnlyItem
node --test --test-isolation=none
cd plugin-build/lovart
node --test --test-isolation=none
```

Expected: every Swift, Node, packaging, MCP integration, Windows-regression, and Linux-regression test passes.

- [ ] **Step 8: Record final repository state**

Run:

```bash
git status --short
git log -8 --oneline
```

Expected: canonical repository is clean. Report the installed plugin version, test totals, relevant commits, the one-time local-only behavior, and the explicit root/compromised-account security limit to the user.
