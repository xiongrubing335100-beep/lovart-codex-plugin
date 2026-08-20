# Lovart Codex Plugin

Use Lovart from Codex to generate and edit images, video, audio, and 3D assets through Lovart's official Agent Skill. The plugin is local and does not use browser automation.

## Install

Choose one supported route, then use the platform guide for credential setup and removal:

- macOS: [installation guide](docs/install-macos.md)
- Windows: [installation guide](docs/install-windows.md)

### Public Git marketplace

After the `codex/v0.2-cross-platform-release` branch is public:

```bash
codex plugin marketplace add xiongrubing335100-beep/lovart-codex-plugin --ref codex/v0.2-cross-platform-release
codex plugin add lovart@lovart-codex
codex plugin list --marketplace lovart-codex --available --json
```

Update a Git installation with:

```bash
codex plugin marketplace upgrade lovart-codex
```

### Extracted release archive

Download the matching Release ZIP, verify its adjacent `.sha256` sidecar, extract it, then add the extracted directory — not the ZIP:

```bash
codex plugin marketplace add /absolute/path/to/lovart-codex-plugin
codex plugin add lovart@lovart-codex
codex plugin list --marketplace lovart-codex --available --json
```

For an archive update, verify and extract the newer matching archive to a new directory, remove the existing marketplace, and add the new extracted directory. The platform guides provide exact commands.

## Credentials and privacy

Create a Lovart AK/SK pair in Lovart's **OpenClaw / AK-SK Management** dialog. Enter both values only in the plugin's local password-style setup window. Never paste them into chat, commit them to Git, put them in `.mcp.json`, include them in documentation/examples, or add them to GitHub Actions secrets.

The plugin never returns credential values to Codex. On macOS the pair is stored only in this Mac's non-synchronizing, non-migrating login Keychain. On Windows it is stored as user-scoped environment variables.

## First-use check

In a Codex chat, invoke `$lovart` and ask it to open the local Lovart credential setup window. Save the pair there, then ask it to run the read-only `lovart_config` tool. Its response can show local Lovart state but never credential values. Do not use a generation, upload, project-creation, or confirmation tool as an installation check.

## Uninstall

```bash
codex plugin remove lovart@lovart-codex
codex plugin marketplace remove lovart-codex
```

On macOS, plugin removal does not erase the local Keychain pair. To delete it, use Keychain Access to remove the login-Keychain item whose service is `com.lovart.codex.local` (its account is your numeric macOS user ID, for example the output of `id -u`). On Windows, remove the two user environment variables through Windows Environment Variables if needed. Deleting a downloaded archive does not delete either local credential store.

## Safety behavior

`lovart_generate` can return `pending_confirmation` for high-cost operations such as premium video generation. Review the displayed credit cost and explicitly approve it before using `lovart_confirm`.
