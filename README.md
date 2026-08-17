# Lovart MCP

Local MCP adapter for [Lovart's official Agent Skill](https://github.com/lovartai/lovart-skill). It lets Codex generate and edit images, videos, audio, and 3D assets without browser automation. The vendored Skill remains under its upstream MIT license.

## Credentials

Create credentials in Lovart's **OpenClaw / AK-SK Management** dialog, then expose both values to the MCP process:

```powershell
$env:LOVART_ACCESS_KEY = "ak_xxx"
$env:LOVART_SECRET_KEY = "sk_xxx"
```

Credentials are never stored in chat, configuration, or plugin files; users must never paste AK/SK into chat. On macOS, the native helper stores the pair only in this Mac's non-synchronizing, non-migrating login Keychain. Lovart's official Python client receives them from the process environment.

On macOS, ask the plugin to “更换密钥”. A native password-style window stores AK/SK in this Mac's login Keychain with synchronization and migration disabled. The local Codex/Lovart helper reads the pair for each Lovart operation, so Codex and Mac restarts do not require re-entry. Running setup again atomically replaces both values. Windows continues to use the user-scoped setup window; Linux continues to use the process environment.

## Run

```powershell
npm.cmd install
npm.cmd start
```

Default downloaded artifact directory: `downloads/`.

Optional environment variables:

- `LOVART_OUTPUT_DIR`: artifact download directory
- `LOVART_PYTHON`: Python executable (`py` on Windows by default)
- `LOVART_SKILL_SCRIPT`: path to the official `agent_skill.py`

## Codex MCP configuration

Register this command as a stdio MCP server:

```json
{
  "command": "node",
  "args": ["C:\\Users\\Amoiz\\Documents\\ChatGPT\\New project\\src\\index.js"],
  "env": {
    "LOVART_ACCESS_KEY": "ak_xxx",
    "LOVART_SECRET_KEY": "sk_xxx"
  }
}
```

For safer long-term use, set the variables in the MCP host environment instead of keeping secrets in a checked-in configuration file.

## Safety behavior

`lovart_generate` can return `pending_confirmation` for high-cost operations such as premium video generation. The caller must show the estimated credit cost and obtain explicit user confirmation before calling `lovart_confirm`.
