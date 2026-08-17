# Lovart MCP

Local MCP adapter for [Lovart's official Agent Skill](https://github.com/lovartai/lovart-skill). It lets Codex generate and edit images, videos, audio, and 3D assets without browser automation. The vendored Skill remains under its upstream MIT license.

## Credentials

Create credentials in Lovart's **OpenClaw / AK-SK Management** dialog, then expose both values to the MCP process:

```powershell
$env:LOVART_ACCESS_KEY = "ak_xxx"
$env:LOVART_SECRET_KEY = "sk_xxx"
```

The MCP never accepts credentials as tool arguments and does not save them. Lovart's official Python client reads them from the process environment.

On Windows, run `scripts/configure-lovart-credentials.ps1` for a password-style setup window. The MCP reads the latest saved user-level values before every Lovart call, so replacing a key does not require restarting Codex.

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
