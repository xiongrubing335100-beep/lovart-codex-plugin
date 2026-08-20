# Install Lovart on macOS

## Before you begin

Use the current Codex desktop/CLI installation. You will need a Lovart AK/SK pair created in Lovart's **OpenClaw / AK-SK Management** dialog. Never paste either value into chat, Git, `.mcp.json`, documentation/examples, or GitHub Actions secrets: enter them only in the local setup window.

## Install from the public Git marketplace

```bash
codex plugin marketplace add xiongrubing335100-beep/lovart-codex-plugin --ref codex/v0.2-cross-platform-release
codex plugin add lovart@lovart-codex
codex plugin list --marketplace lovart-codex --available --json
```

## Install from a macOS Release archive

1. Download `lovart-codex-plugin-v0.2.0-macos-universal.zip` and its `.sha256` sidecar from the Release.
2. Verify the download, then extract it. Replace the paths below with your actual download location.

```bash
cd /absolute/path/to/downloads
shasum -a 256 -c lovart-codex-plugin-v0.2.0-macos-universal.zip.sha256
unzip lovart-codex-plugin-v0.2.0-macos-universal.zip
codex plugin marketplace add /absolute/path/to/downloads/lovart-codex-plugin
codex plugin add lovart@lovart-codex
codex plugin list --marketplace lovart-codex --available --json
```

Do not add the ZIP file itself: add the extracted `lovart-codex-plugin` directory.

## Configure and verify locally

In a Codex chat, invoke `$lovart` and ask it to open the local Lovart credential setup window. Enter both values in that password-style window and save. The plugin stores them only in this Mac's login Keychain with synchronization and migration disabled; it never returns the values to chat.

Then ask `$lovart` to call `lovart_config`. This is the read-only local-state check and does not expose credentials. Do not test installation with a Lovart generation, upload, project-creation, or confirmation request.

## Update

For a Git marketplace installation:

```bash
codex plugin marketplace upgrade lovart-codex
codex plugin list --marketplace lovart-codex --available --json
```

For an archive installation, download and checksum-verify the newer macOS archive, extract it to a new directory, then replace the marketplace source:

```bash
codex plugin remove lovart@lovart-codex
codex plugin marketplace remove lovart-codex
codex plugin marketplace add /absolute/path/to/new/lovart-codex-plugin
codex plugin add lovart@lovart-codex
```

## Uninstall

```bash
codex plugin remove lovart@lovart-codex
codex plugin marketplace remove lovart-codex
```

Plugin removal does not remove the local Keychain pair. If you no longer want it, open **Keychain Access**, select the **login** keychain, find the generic-password item whose service is `com.lovart.codex.local`, and delete that item. Its account is your numeric macOS user ID (the output of `id -u`). Never paste either credential into a shell command or configuration file.
