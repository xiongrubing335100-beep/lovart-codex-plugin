# Lovart Local-Only macOS Credentials Design

Date: 2026-08-18
Status: Approved design, pending written-spec review

## Context

The Lovart MCP requires `LOVART_ACCESS_KEY` and `LOVART_SECRET_KEY`. The current macOS flow keeps both values only in the running MCP process, so the user must enter them again after a Codex or Mac restart. An earlier attempt to use the `security` command-line tool was unreliable inside the Codex-launched process and could not consistently read the login Keychain.

The user wants one-time entry with this boundary:

- credentials remain on the current Mac;
- credentials are available only to the local Codex/Lovart integration;
- credentials do not sync through iCloud Keychain or migrate to another Mac;
- one initial macOS authorization prompt is acceptable;
- replacing the Lovart keys remains an explicit user action.

OpenAI plugin guidance says remote-service credentials should not be embedded in a plugin archive, manifest, instructions, or defaults. OAuth is preferred when the service provides it. Lovart currently exposes AK/SK credentials rather than an OAuth flow, so this design uses an explicit local secure-storage mechanism. See [Replace Claude `userConfig`](https://developers.openai.com/plugins/guides/submit-claude-plugin#replace-claude-userconfig).

## Goals

1. Ask for AK/SK once on the current Mac and reuse them after Codex and Mac restarts.
2. Prevent iCloud synchronization and device migration.
3. Restrict normal access to the Lovart credential helper when it is invoked from a trusted local Codex process chain.
4. Keep secrets out of chat, MCP tool results, logs, manifests, config files, shell history, and global environment variables.
5. Allow atomic key replacement without restarting Codex.
6. Preserve existing Windows behavior and Linux environment-variable behavior.

## Non-goals and limits

- This does not protect against root, an administrator deliberately inspecting the current account, kernel compromise, or malware already executing with equivalent control over the current user session.
- This does not add Lovart OAuth because Lovart does not currently expose a suitable OAuth flow for this integration.
- This does not synchronize credentials between Macs or Codex installations.
- JavaScript and Python runtimes cannot guarantee immediate zeroization of every transient in-memory copy. The implementation minimizes lifetime and never intentionally caches the values.

## Chosen architecture

### Components

1. **Native credential helper**
   - A small Swift executable using AppKit and Security.framework.
   - Distributed as a universal `arm64` and `x86_64` binary.
   - Installed at a fixed path under `~/Library/Application Support/Lovart Codex/` with a `0700` parent directory and executable permissions limited to the current user.
   - Installed only when absent. Ordinary plugin updates reuse the byte-identical helper so its Keychain application identity remains stable.

2. **Node MCP adapter**
   - Installs or locates the fixed helper during MCP startup.
   - Calls the helper for configuration and per-request reads.
   - Injects credentials only into the environment of the current Lovart Python child process.
   - Does not retain credentials after launching that child.

3. **macOS login Keychain item**
   - One generic-password item stores an encoded object containing both AK and SK so replacement is atomic.
   - Service: `com.lovart.codex.local`.
   - Account: the current numeric macOS user ID.
   - `kSecAttrSynchronizable` is explicitly false.
   - `kSecAttrAccessible` is `kSecAttrAccessibleWhenUnlockedThisDeviceOnly`.
   - The item is created and read by the fixed helper, allowing macOS to bind normal Keychain access to that helper identity.

### Trusted caller check

Before configuration or reading, the helper walks its parent process chain and validates code signatures with Security.framework. It accepts a chain only when it contains a Codex host signed with:

- Team identifier: `2DC432GLL2`; and
- identifier: `com.openai.codex` or `codex`.

The helper does not pin a CDHash, because valid Codex updates change the executable hash. It does not trust a filesystem path without a valid signature. Failure to inspect or validate the process chain fails closed.

This check prevents an ordinary unrelated application from invoking the helper directly. It is not intended to defend against root or a compromised local Codex process.

## Workflows

### First-time configuration

1. The user invokes `lovart_configure_credentials`.
2. The MCP launches the fixed helper in configure mode.
3. The helper activates a native window with two `NSSecureTextField` inputs for AK and SK.
4. The helper validates that both trimmed values are non-empty before changing Keychain state.
5. The helper performs a single add-or-update operation for the combined Keychain payload.
6. macOS may display its one-time authorization prompt.
7. The helper returns only `{ configured: true }` or a typed cancellation/error result.
8. For immediate use in the current MCP session, the helper supplies the newly entered pair through its private captured stdout pipe. The MCP updates only its own process environment; it does not return the values through MCP.

### Normal Lovart request

1. Immediately before spawning Lovart's Python client, the MCP invokes the helper in read mode.
2. The helper validates the trusted Codex ancestor and reads the local-only Keychain item.
3. The helper writes a minimal JSON object to the private stdout pipe captured by the MCP.
4. The MCP parses it, constructs the Lovart child environment, and spawns the Python process.
5. The MCP drops references to the credential object after the child is launched and never logs or returns it.

The helper is called per Lovart operation instead of caching secrets for the life of the MCP. This also makes a replaced key effective on the next operation.

### Replace credentials

The user invokes the same `lovart_configure_credentials` tool. Both fields must be supplied. The helper updates the single combined Keychain item atomically. Cancellation or validation failure leaves the old item unchanged. The next Lovart operation uses the new pair without a Codex restart.

### Plugin update

The fixed helper is reused when its protocol version is compatible. A future helper replacement is allowed only for an explicit security or compatibility migration. Such a migration may require one new macOS authorization; it must not silently fall back to plaintext storage.

## Error handling

Errors are returned as stable categories without commands, secret values, or raw payloads:

- `not_configured`: ask the user to run the credential setup tool;
- `cancelled`: preserve the previous credential item;
- `keychain_locked`: ask the user to unlock this Mac's login Keychain and retry;
- `caller_not_trusted`: deny access and report that the helper was not launched by trusted local Codex;
- `helper_missing_or_invalid`: refuse to read credentials and ask for plugin repair/reinstall;
- `keychain_write_failed` or `keychain_read_failed`: provide a short actionable message and the non-secret OSStatus code;
- `invalid_payload`: reject partial or malformed credentials without modifying the old item.

On macOS there is no fallback to a plaintext file, plugin configuration, `launchctl`, shell profile, global environment variable, or chat input.

## Packaging and installation

- Build the Swift helper separately for `arm64-apple-macos` and `x86_64-apple-macos`, then combine with `lipo`.
- Ad-hoc sign the final universal binary and verify it with `codesign --verify --strict`.
- Record the helper SHA-256 in the plugin build. Installation verifies the bundled hash before copying.
- Use an atomic temporary-file-and-rename installation into the fixed Application Support location.
- Never replace an existing compatible helper automatically.
- Keep the helper source and reproducible build script in the repository; include the verified binary in the plugin build and local marketplace package.

## Code boundaries

- `macos-helper/`: Swift source, Security.framework wrapper, AppKit dialog, caller validation, and helper tests.
- `scripts/build-macos-credential-helper.sh`: reproducible universal build, signing, and hash generation.
- `src/macos-credential-helper.js`: helper installation, invocation, result parsing, and typed errors.
- `src/lovart-credentials.js`: platform routing and configuration behavior.
- `src/lovart-cli.js`: per-operation credential resolution and child-environment injection.
- `src/index.js`: unchanged public MCP tool name; updated descriptions only.

Windows continues to use its current user-scoped setup flow. Linux continues to use explicit process environment variables.

## Testing strategy

### Swift unit tests

- add, read, and atomic update through an injected Keychain interface;
- cancellation and invalid input preserve the prior value;
- local-only and non-synchronizable attributes are applied;
- locked-Keychain and OSStatus errors map to stable categories;
- trusted and untrusted process-chain results through an injected signature verifier;
- configure/read responses never include secrets in error text or logs.

### Node unit tests

- macOS routes to the fixed helper and never to `security`, AppleScript storage, `launchctl`, or a plaintext file;
- helper install verifies its hash and preserves an existing compatible helper;
- missing, invalid, cancelled, and locked results are actionable;
- per-request reads override stale in-process values;
- secrets are present only in the Lovart child environment and absent from MCP responses and logs;
- Windows and Linux behavior is unchanged.

### Packaging and integration tests

- verify universal architectures with `lipo -archs`;
- verify the helper signature and bundled SHA-256;
- install the local marketplace plugin into a fresh versioned Codex cache;
- confirm MCP tool discovery and `lovart_config` still work;
- perform a manual dummy-key smoke test on macOS: configure, restart Codex, read successfully, replace, cancel, lock/unlock Keychain, and confirm no iCloud-synchronizable attribute.

Real Keychain smoke tests use dummy values and remove their test-only service item afterward. Automated tests do not use production Lovart credentials.

## Migration

1. Leave any existing manually created `com.lovart.codex` items untouched; do not read, overwrite, or delete them automatically.
2. On the first invocation after upgrade, no credential exists under `com.lovart.codex.local`, so the tool requests one final explicit setup.
3. After that successful setup, Codex and Mac restarts reuse the local-only item.
4. Remove the old macOS `security` CLI and AppleScript Keychain code paths from active runtime routing. Retain no automatic plaintext fallback.

## Acceptance criteria

- The user enters AK/SK once and can use Lovart after restarting Codex and after restarting the same Mac without entering them again.
- The Keychain item has `ThisDeviceOnly` accessibility and synchronization disabled.
- Another Mac cannot receive or migrate the item through iCloud Keychain.
- An ordinary unrelated local application calling the helper is rejected.
- Replacing both keys takes effect on the next Lovart operation without restarting Codex.
- Cancelling replacement preserves the previous pair.
- No credential appears in chat, MCP results, logs, manifests, config files, global environment variables, or shell history.
- The installed plugin passes unit, packaging, and MCP integration tests on macOS; existing Windows and Linux tests remain green.
