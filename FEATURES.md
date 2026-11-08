# SE-AiProxy: Features and Technical Overview

Version 1.0.0 · developed by [shirazelectronic](https://shirazelectronic.ir)

## Contents

1. [Overview](#1-overview)
2. [Architecture and protocols](#2-architecture-and-protocols)
3. [Multi-account pool](#3-multi-account-pool)
4. [Tool calling and parser](#4-tool-calling-and-parser)
5. [Turn supervisor](#5-turn-supervisor)
6. [Workspace directives](#6-workspace-directives)
7. [Prompt optimizer and language mirroring](#7-prompt-optimizer-and-language-mirroring)
8. [Vision](#8-vision)
9. [Web dashboard and Codex auto-configuration](#9-web-dashboard-and-codex-auto-configuration)
10. [Deployment on ARM and Linux boards](#10-deployment-on-arm-and-linux-boards)

---

## 1. Overview

SE-AiProxy is a lightweight gateway that connects AI providers (official OpenAI and Anthropic APIs, DeepSeek web and API, Kimi, Gemini, OpenRouter, Groq, NVIDIA NIM and any OpenAI-compatible service) to the standard OpenAI and Anthropic interfaces used by Codex CLI, the Codex desktop app, Claude Code and the Claude desktop app.

Main benefits:

- Use reasoning models such as DeepSeek-R1 from Codex and Claude Code, including through web chat accounts.
- DeepSeek web proof-of-work challenges are solved automatically with a native WebAssembly solver (`@rezaparsian/deepseek-pow-solver`).
- Long development sessions survive rate limits and expired accounts through automatic failover.

---

## 2. Architecture and protocols

| Endpoint | Used by | Protocol |
| :--- | :--- | :--- |
| `/openai/v1/responses` | Codex CLI, Codex desktop | OpenAI Responses API with server-sent events |
| `/openai/v1/chat/completions` | Any OpenAI-compatible client | OpenAI Chat Completions |
| `/anthropic/v1/messages` | Claude Code, Claude desktop | Anthropic Messages API (HTTP on 18789, HTTPS on 18790) |
| `/openai/v1/models`, `/anthropic/v1/models` | All clients | Model list |
| `/health` | Monitoring | Service status, version and account health |
| `/api/*` | Web dashboard | Internal REST management API |

- **Thread continuity:** an LRU cache (`BoundedCache`) keeps context between turns, keyed by `prompt_cache_key` and `thread_id`.
- **History budgeting:** long conversations are compacted automatically to avoid context overflow.
- **Stream keepalive:** SSE heartbeat comments are sent during long generations so clients do not hit their idle timeout.
- **Internal tag scrubbing:** internal model tokens such as `<ds_small_trigger>` are removed before output reaches the client.

---

## 3. Multi-account pool

Accounts are managed by `tokenPool.js`:

- **Failover without losing the session:** when an account hits a rate limit, a conversation-length limit or expires mid-task, the conversation moves to the next healthy account immediately. The running Codex or Claude Code task continues.
- **Automatic recovery:** rate-limited accounts go on a cooldown and return to the pool when it ends.
- **Concurrency-aware balancing:** in-flight requests are tracked per account, so new requests are routed to idle accounts while another account is busy with a long turn.
- **Multiple keys per account:** API accounts can hold several keys; a failing key is replaced by the next one.
- **Live key testing:** keys are tested before they are added, and each provider's model list can be loaded from the dashboard.

---

## 4. Tool calling and parser

Web chat models return plain text. The parser converts it into structured Codex tool calls:

1. **Native Codex tools:**
   - Shell commands: `exec_command`
   - Code patches: `apply_patch` (both free-form and parameter formats)
   - Interactive terminal input: `write_stdin`
   - Images: `view_image`
2. **Embedded patch conversion:** if the model tries to apply a patch through a shell command, the proxy intercepts it and turns it into a safe `apply_patch` call.
3. **Tag shield:** malformed or leaked tool tags in other scripts are hidden before output reaches the user, including:
   - Japanese katakana tags: `<コール>`, `<ツール>`
   - Chinese tags: `<调用>`, `<工具>`
   - Invented or abbreviated tags: `<inv_calls>`, `<inv>`, `<call_tool>`, `<tool_call>`, `<use_tool>`
   - Full-width Unicode brackets: `＜コール＞`, `＜call_tool＞`

---

## 5. Turn supervisor

A second, faster model watches each turn to catch incomplete agent behaviour:

- **Announce-and-stop:** if the model says it is about to do something but sends no tool call, the supervisor prompts it to carry on so the task does not stall.
- **Recovery after errors:** if a command fails and the model stops, the supervisor asks it to fix the error.
- **Question detection (`ASK_USER_CUE`):** when the model is genuinely asking the user a question or offering options, the supervisor ends the turn and hands control back to the user.

Detection works for both English and Persian model output.

---

## 6. Workspace directives

The system prompt (`WORKSPACE_DIRECTIVE`) includes rules that keep agents focused:

- **Architecture freeze:** the model may not redesign code, add layers or change the core architecture on its own. Changes are made as targeted fixes to lines with a proven bug.
- **Collaboration on major changes:** before large changes or new modules, the model must stop and present options with their pros and cons.
- **Workspace hygiene:** temporary scripts, probes and dump files created during a task are deleted before the turn ends.

---

## 7. Prompt optimizer and language mirroring

- **Prompt optimizer (`promptOptimizer.js`):** informal user requests are rewritten into concise technical instructions for the model.
- **Language mirroring:** the model replies in the language the user wrote in.

---

## 8. Vision

Screenshots, circuit boards, diagrams and UI images can be analysed through the `view_image` tool. Results are cached by image hash, so the same image is never analysed twice.

---

## 9. Web dashboard and Codex auto-configuration

- **Dashboard** on port `18789`: account health, quotas, access keys, logs and settings.
- **One-click Codex setup:** writes `~/.codex/config.toml` and `~/.codex/.env` on the machine running the proxy. Setup scripts for other machines are served at `/api/codex-setup.sh` and `/api/codex-setup.ps1`.

---

## 10. Deployment on ARM and Linux boards

- **Low footprint:** about 35 MB of RAM, suitable for boards such as Banana Pi M2+ and Raspberry Pi.
- **Deployment script (`scripts/deploy-banana.py`):** packages the project, copies it over SSH and installs it as a systemd service.
- **Platform scripts:** install and start scripts for Windows, macOS and Linux.
- **Release build:** `npm run release` produces `SE-AiProxy-v<version>.zip`.
