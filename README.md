# SE-AiProxy

**One multi-account, multi-provider AI gateway for OpenAI Codex and Claude Code.**

SE-AiProxy puts all of your AI providers behind two standard endpoints, one speaking the OpenAI protocol and one speaking the Anthropic protocol. Accounts are pooled, load-balanced and failed over automatically, so a rate-limited or expired account never stops a running task.

- **Version:** 1.0.0
- **Platforms:** Windows, macOS, Linux (including ARM boards such as Raspberry Pi and Banana Pi)
- **Developed by:** [shirazelectronic](https://shirazelectronic.ir)

For a detailed technical description of every component, see [FEATURES.md](FEATURES.md).

---

## Supported providers

| Provider | Type |
|---|---|
| OpenAI (official API) | API key |
| Anthropic (official API) | API key |
| DeepSeek | Web chat account or API key |
| Kimi | Web chat account |
| Google Gemini | API key |
| OpenRouter, Groq, NVIDIA NIM | API key |
| Any OpenAI-compatible service | API key + base URL |

## Supported clients

| Client | Endpoint |
|---|---|
| OpenAI Codex CLI and Codex desktop app | `http://<host>:18789/openai/v1` (Responses API) |
| Any OpenAI Chat Completions client | `http://<host>:18789/openai/v1/chat/completions` |
| Claude Code CLI | `http://<host>:18789` |
| Claude desktop app (Gateway) | `https://<host>:18790/anthropic` (TLS) |

---

## Key features

- **Account pooling:** add several accounts per provider. Requests are spread across idle accounts, and a failing account is replaced mid-task without losing progress.
- **Automatic failover:** rate limits, `429`/`529 overloaded` replies and expired sessions put an account on cooldown and move the conversation to the next healthy one.
- **Protocol translation:** Responses API, Chat Completions and Anthropic Messages are translated in both directions, including tool calls, images, reasoning and streaming.
- **Tool calling for web models:** text-based tool calls from web chat models are parsed into the native Codex tools (`exec_command`, `apply_patch`, `write_stdin`, `view_image`).
- **Large context:** up to 1M tokens for Claude Code via the `[1m]` model suffix.
- **Web dashboard:** manage accounts, API keys, proxy keys and settings, and write the Codex configuration with one click.
- **TLS out of the box:** a self-signed certificate is generated with every local IP address in its SAN list, and can be downloaded from `/server.crt`.
- **Lightweight:** about 35 MB of RAM, suitable for single-board computers.

---

## Installation

Requires **Node.js 18 or newer**.

```bash
git clone https://github.com/shirazelec/SE-AiProxy.git
cd SE-AiProxy
npm install
npm start
```

Or use the platform scripts:

| Platform | Start | Install as a service |
|---|---|---|
| Linux | `bash linux/start.sh` | `bash linux/install-service.sh` (systemd service `se-aiproxy`) |
| macOS | double-click `macos/start.command` | `bash macos/install.sh` |
| Windows | double-click `windows/start.bat` | `windows/install.bat` |

### Configuration

Copy `.env.example` to `.env` to change the defaults:

| Variable | Default | Description |
|---|---|---|
| `PORT` | `18789` | HTTP port for the dashboard and API |
| `HOST` | `127.0.0.1` | Bind address. Use `0.0.0.0` to serve your LAN |
| `ADMIN_KEY` | auto-generated | Required for dashboard access from other machines |
| `ALLOWED_HOSTS` | empty | Extra hostnames the dashboard may be opened under |

Runtime data (accounts, keys, settings) is stored in `data/config.json`, which is not tracked by git.

---

## Getting started

1. Open the dashboard at **http://localhost:18789**.
2. Click **Add account**, choose a provider and enter its API key or sign-in token. For DeepSeek and Kimi web accounts, add **at least 4 accounts**: their web chat enforces strict short-term rate limits, and a larger pool keeps requests flowing.
3. On the **Access keys** tab, copy the proxy key. Clients use it as their API key.
4. Connect your clients as shown below.

In the examples, replace `<host>` with the proxy's address (`127.0.0.1` locally, or its LAN IP) and `<proxy-key>` with your proxy key.

---

## Connecting clients

### OpenAI Codex (CLI and desktop app)

The quickest way is the **Connect → Write to this machine** button in the dashboard. To set up another machine:

```bash
# Linux / macOS
curl -fsSL http://<host>:18789/api/codex-setup.sh | bash
```

```powershell
# Windows (PowerShell)
irm http://<host>:18789/api/codex-setup.ps1 | iex
```

Or edit `~/.codex/config.toml` by hand:

```toml
model = "se-aiproxy-reasoner"   # or "se-aiproxy" for faster replies
model_provider = "se_aiproxy"
model_context_window = 1048576
model_auto_compact_token_limit = 400000

[model_providers.se_aiproxy]
name = "SE-AiProxy"
base_url = "http://<host>:18789/openai/v1"
wire_api = "responses"
env_key = "CODEX_PROXY_KEY"
```

and set `CODEX_PROXY_KEY` to your proxy key.

### Claude Code CLI

```bash
export ANTHROPIC_BASE_URL="http://<host>:18789"
export ANTHROPIC_API_KEY="<proxy-key>"
export ANTHROPIC_MODEL="sonnet[1m]"
export CLAUDE_CODE_MAX_CONTEXT_TOKENS=1048576
claude
```

On Windows PowerShell, set the same variables with `$env:NAME="value"`.

### Claude desktop app (Gateway)

1. Trust the proxy's certificate (one-time):

   ```bash
   # Linux
   sudo curl -k -o /usr/local/share/ca-certificates/se-aiproxy.crt https://<host>:18790/server.crt
   sudo update-ca-certificates

   # macOS
   curl -k -o server.crt https://<host>:18790/server.crt
   sudo security add-trusted-cert -d -r trustRoot -k /Library/Keychains/System.keychain server.crt
   ```

   ```powershell
   # Windows (PowerShell)
   curl.exe -k -o server.crt https://<host>:18790/server.crt
   Import-Certificate -FilePath .\server.crt -CertStoreLocation Cert:\CurrentUser\Root
   ```

2. In the Claude desktop app, open **Settings → Developer → Gateway settings** and set:

   | Field | Value |
   |---|---|
   | Credential kind | Static API key |
   | Gateway base URL | `https://<host>:18790/anthropic` |
   | Gateway API key | `<proxy-key>` |
   | Gateway auth scheme | `bearer` |
   | Stream idle timeout | `300` |

3. Click **Test connection**.

---

## API endpoints

| Endpoint | Purpose |
|---|---|
| `POST /openai/v1/responses` | OpenAI Responses API (Codex) |
| `POST /openai/v1/chat/completions` | OpenAI Chat Completions |
| `POST /anthropic/v1/messages` | Anthropic Messages API (Claude Code, Claude desktop) |
| `GET /openai/v1/models`, `GET /anthropic/v1/models` | Available models |
| `GET /health` | Service health and account status |
| `GET /server.crt` | The proxy's TLS certificate |
| `/api/*` | Dashboard management API (admin key required from remote machines) |

---

## Troubleshooting

**`approval_policy = "untrusted" is no longer supported` in Codex**
Remove the `approval_policy = "untrusted"` line from `~/.codex/config.toml`.

**`ERR_CERT_AUTHORITY_INVALID` in the Claude Gateway**
Install the certificate as shown above, or use the plain HTTP endpoint `http://<host>:18789/anthropic` on a trusted local network.

**Requests time out or fail with "messages sent too frequently"**
A single web account has hit its rate limit. Add more accounts in the dashboard so requests can be spread across them.

**Claude desktop asks for the Virtual Machine Platform on Windows**
Run the following in an administrator PowerShell, then reboot:

```powershell
dism.exe /online /enable-feature /featurename:VirtualMachinePlatform /all /norestart
```

---

## Development

```bash
npm run dev       # start with auto-reload
npm test          # run the test suite
npm run release   # build the release zip
```

---

Developed by **shirazelectronic** · [shirazelectronic.ir](https://shirazelectronic.ir)
