# Lovart Codex Plugin

This extracted plugin is the local `lovart-codex` marketplace. It uses Lovart's official Agent Skill and runs with Codex. The archive contains everything needed for the steps below.

## Privacy first

Create your AK/SK pair in Lovart's **OpenClaw / AK-SK Management** dialog. Enter both values only in the local password-style window opened by `$lovart`; never paste them into chat, Git, `.mcp.json`, examples, shell commands, or GitHub Actions secrets. The plugin never returns credential values to chat.

- macOS stores the pair in this Mac's non-synchronizing, non-migrating login Keychain.
- Windows stores the pair as user-scoped environment variables.

## Install an extracted release

### macOS

Download `lovart-codex-plugin-v0.2.0-macos-universal.zip` and its adjacent `.sha256` sidecar, then run:

```bash
cd /absolute/path/to/downloads
shasum -a 256 -c lovart-codex-plugin-v0.2.0-macos-universal.zip.sha256
unzip lovart-codex-plugin-v0.2.0-macos-universal.zip
codex plugin marketplace add /absolute/path/to/downloads/lovart-codex-plugin
codex plugin add lovart@lovart-codex
codex plugin list --marketplace lovart-codex --available --json
```

### Windows (PowerShell)

Download `lovart-codex-plugin-v0.2.0-windows.zip` and its adjacent `.sha256` sidecar, then run:

```powershell
Set-Location 'C:\absolute\path\to\downloads'
if ((Get-FileHash '.\lovart-codex-plugin-v0.2.0-windows.zip' -Algorithm SHA256).Hash.ToLower() -ne (Get-Content '.\lovart-codex-plugin-v0.2.0-windows.zip.sha256').Split(' ')[0].ToLower()) { throw 'Checksum mismatch' }
Expand-Archive '.\lovart-codex-plugin-v0.2.0-windows.zip' -DestinationPath '.\lovart-codex-plugin-v0.2.0' -Force
codex plugin marketplace add 'C:\absolute\path\to\downloads\lovart-codex-plugin-v0.2.0\lovart-codex-plugin'
codex plugin add lovart@lovart-codex
codex plugin list --marketplace lovart-codex --available --json
```

Add the extracted `lovart-codex-plugin` directory, not the ZIP file itself.

## Public Git marketplace

After the public release branch exists, either platform can install it with:

```bash
codex plugin marketplace add xiongrubing335100-beep/lovart-codex-plugin --ref codex/v0.2-cross-platform-release
codex plugin add lovart@lovart-codex
```

## Configure and verify locally

In a Codex chat, invoke `$lovart` and ask it to open the local Lovart credential setup window. Enter both values there and save. Then ask `$lovart` to call the read-only `lovart_config` tool. It reports local Lovart state without exposing keys. Do not use a generation, upload, project-creation, or confirmation request as an installation check.

## Update

For a Git marketplace installation:

```bash
codex plugin marketplace upgrade lovart-codex
codex plugin list --marketplace lovart-codex --available --json
```

For an extracted archive installation, checksum-verify and extract the newer matching platform archive to a new directory, then replace the source and reinstall:

```bash
codex plugin remove lovart@lovart-codex
codex plugin marketplace remove lovart-codex
codex plugin marketplace add /absolute/path/to/new/lovart-codex-plugin
codex plugin add lovart@lovart-codex
```

In Windows PowerShell, use the same final two commands with an absolute Windows path such as:

```powershell
codex plugin marketplace add 'C:\absolute\path\to\new\lovart-codex-plugin'
codex plugin add lovart@lovart-codex
```

## Uninstall and remove local credentials

```bash
codex plugin remove lovart@lovart-codex
codex plugin marketplace remove lovart-codex
```

Plugin removal does not erase operating-system credentials. On macOS, open **Keychain Access**, select the **login** keychain, find the generic-password item whose service is `com.lovart.codex.local`, and delete it; its account is your numeric macOS user ID (the output of `id -u`). On Windows, delete `LOVART_ACCESS_KEY` and `LOVART_SECRET_KEY` through Windows Environment Variables. Do not put either credential into a shell command or configuration file.
