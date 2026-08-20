# Install Lovart on Windows

## Before you begin

Use the current Codex desktop/CLI installation. You will need a Lovart AK/SK pair created in Lovart's **OpenClaw / AK-SK Management** dialog. Never paste either value into chat, Git, `.mcp.json`, documentation/examples, or GitHub Actions secrets: enter them only in the local setup window.

Run the following commands in PowerShell.

## Install from the public Git marketplace

```powershell
codex plugin marketplace add xiongrubing335100-beep/lovart-codex-plugin --ref codex/v0.2-cross-platform-release
codex plugin add lovart@lovart-codex
codex plugin list --marketplace lovart-codex --available --json
```

## Install from a Windows Release archive

1. Download `lovart-codex-plugin-v0.2.0-windows.zip` and its `.sha256` sidecar from the Release.
2. Verify the download and extract it; replace the path below with your actual download directory.

```powershell
Set-Location 'C:\absolute\path\to\downloads'
if ((Get-FileHash '.\lovart-codex-plugin-v0.2.0-windows.zip' -Algorithm SHA256).Hash.ToLower() -ne (Get-Content '.\lovart-codex-plugin-v0.2.0-windows.zip.sha256').Split(' ')[0].ToLower()) { throw 'Checksum mismatch' }
Expand-Archive '.\lovart-codex-plugin-v0.2.0-windows.zip' -DestinationPath '.\lovart-codex-plugin-v0.2.0' -Force
codex plugin marketplace add 'C:\absolute\path\to\downloads\lovart-codex-plugin-v0.2.0\lovart-codex-plugin'
codex plugin add lovart@lovart-codex
codex plugin list --marketplace lovart-codex --available --json
```

Add the extracted `lovart-codex-plugin` directory, never the ZIP file itself.

## Configure and verify locally

In a Codex chat, invoke `$lovart` and ask it to open the local Lovart credential setup window. Enter both values in that password-style window and save. Windows writes the pair only as user-scoped environment variables, and the plugin reads the current values for each Lovart operation; the values are never returned to chat.

Then ask `$lovart` to call `lovart_config`. This is the read-only local-state check and does not expose credentials. Do not test installation with a Lovart generation, upload, project-creation, or confirmation request.

## Update

For a Git marketplace installation:

```powershell
codex plugin marketplace upgrade lovart-codex
codex plugin list --marketplace lovart-codex --available --json
```

For an archive installation, download and checksum-verify the newer Windows archive, extract it to a new directory, then replace the marketplace source:

```powershell
codex plugin remove lovart@lovart-codex
codex plugin marketplace remove lovart-codex
codex plugin marketplace add 'C:\absolute\path\to\new\lovart-codex-plugin'
codex plugin add lovart@lovart-codex
```

## Uninstall

```powershell
codex plugin remove lovart@lovart-codex
codex plugin marketplace remove lovart-codex
```

Plugin removal does not remove the two user-scoped credential variables. If you no longer want them retained, delete `LOVART_ACCESS_KEY` and `LOVART_SECRET_KEY` using Windows Environment Variables. Never put their values in a shell command or configuration file.
