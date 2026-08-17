---
name: lovart
description: Generate or edit images, videos, audio, music, and 3D assets with Lovart. Use when the user invokes $lovart, explicitly asks to use Lovart, or asks for Lovart project and conversation management.
---

# Lovart

Use the Lovart MCP tools supplied by this plugin. Do not browse or automate the Lovart website except for the narrowly scoped project-page refresh described below.

## Invocation

When the user invokes `$lovart`, treat the text after it as their creation request. Also activate when the user says "用 Lovart", "Lovart 生图", "Lovart 生视频", or asks to continue a Lovart project.

## First call in a task

1. Call `lovart_config` to inspect the active project.
2. For a new deliverable, a new reference image, or a standalone creation request, keep the active project but omit `thread_id` so Lovart starts a new thread.
3. Reuse a thread only when the user explicitly asks to continue, revise, edit, upscale, or otherwise operate on an earlier Lovart result. Call `lovart_threads` only when that continuation needs a thread ID that `lovart_config` does not already provide.
4. If no active project exists, ask whether to use an existing project ID or create a new project.

## Generation

- Call `lovart_generate` for image, video, audio, music, 3D generation, and edits.
- Use the Lovart MCP first. If the MCP transport or adapter is unavailable, the only allowed fallback is the bundled official Lovart Agent Skill CLI, and it must still invoke Lovart's server-side Agent and tools.
- Keep size, aspect ratio, resolution, duration, frame rate, clarity, and upscale work inside Lovart. Never substitute local Codex processing such as Pillow, FFmpeg, ImageMagick, or another local generator.
- Pass the user's creation request as `prompt` without silently rewriting or expanding it.
- When the user supplies a local reference file, call `lovart_upload` first and pass the returned URL in `attachments`.
- When the user names a Lovart model, set `prefer_models`. Use `include_tools` only when the user requires a hard model/tool constraint.
- For upscaling, set `include_tools` to `["upscale_image"]` so Lovart does not regenerate the image.
- Use `reasoning_mode: "thinking"` for complex multi-asset or brand-system requests; otherwise use `fast`.

## Confirmation and delivery

- If `final_status` is `pending_confirmation`, show the estimated credit cost and ask the user for explicit confirmation. Never call `lovart_confirm` automatically.
- After confirmation, call `lovart_confirm` with the same thread ID.
- If a task times out, call `lovart_result` until it finishes.
- Return every current-run downloaded local image, video, or audio path to the user. Do not re-download or return historical artifacts from a reused thread.
- As soon as the current-run artifact has a valid local path, deliver it immediately. Do not delay the response for a project-page refresh, another thread scan, or redundant result/download calls.
- Also provide the Lovart canvas link when `project_id` is available: `https://www.lovart.ai/canvas?projectId={project_id}`.

## Optional refresh of an existing project page

- Refresh the Lovart canvas only when the user explicitly asks for a browser or canvas refresh. It is disabled by default and must never delay artifact delivery.
- After `final_status` is `done` and artifacts have been persisted, deliver the artifacts first. A requested refresh is best-effort follow-up work.
- For an explicitly requested refresh, use the available Chrome/browser-control capability to inspect existing tabs.
- Match only an already-open `https://www.lovart.ai/canvas?projectId={project_id}` tab whose `projectId` exactly equals the completed task's project ID.
- Reload that existing matching tab so the Lovart canvas fetches the newly generated artifacts.
- Attempt the refresh only once. If browser control errors or times out, skip the refresh and deliver the artifacts without retrying.
- Never open a new tab, never navigate an unrelated tab, and never refresh a different Lovart project.
- If no matching tab is open or browser control is unavailable, skip the refresh and tell the user. Do not create a replacement tab.
- Do not refresh for failed, aborted, timed-out, or `pending_confirmation` tasks.

## Billing mode

- "快速模式" or "使用积分" means call `lovart_set_billing_mode` with `fast`.
- "无限模式" or "排队免费" means call it with `unlimited`.
- Billing mode is persistent and separate from the per-thread reasoning mode.

## Credentials

Never ask the user to paste `LOVART_ACCESS_KEY` or `LOVART_SECRET_KEY` into chat or pass either secret as a tool argument.

On macOS, when the user asks to add, replace, update, or configure Lovart keys, always call `lovart_configure_credentials`. It opens a local password-style setup window that atomically stores both keys in this Mac's login Keychain. If a Lovart operation reports `not_configured`, tell the user that one local setup is required, then call `lovart_configure_credentials`; do not request secrets in chat. After setup, continue the task without restarting Codex.

On Windows, `lovart_configure_credentials` opens the user-scoped setup window. Linux reads credentials from the process environment.
