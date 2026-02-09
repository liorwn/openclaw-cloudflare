# OpenClaw on Cloudflare Workers

Deploy your own [OpenClaw](https://github.com/openclaw/openclaw) personal AI assistant on [Cloudflare Workers](https://developers.cloudflare.com/sandbox/) — the easy way.

![openclaw logo](./assets/logo.png)

This project is based on [Moltworker](https://github.com/cloudflare/moltworker), Cloudflare's official reference implementation for running OpenClaw in a Sandbox container. Moltworker works, but getting it deployed smoothly is another story — between Cloudflare Access configuration, CDP endpoint bypass rules, secret naming conventions, container lifecycle quirks, and R2 storage setup, there are a lot of places where things can quietly break.

This template exists to save you from all of that. It packages the same battle-tested infrastructure into a streamlined experience: an interactive setup script that handles secrets, buckets, and deployment in one pass, sensible defaults that just work, and documentation that covers the gotchas we hit so you don't have to.

> **Experimental:** This is a community template, not an official Cloudflare project. OpenClaw in Cloudflare Sandbox is still experimental and may break without notice. Use at your own risk.

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/liorwn/openclaw-cloudflare)

## Quick Start with Setup Script

The fastest way to get started. The setup script walks you through everything interactively:

```bash
git clone https://github.com/liorwn/openclaw-cloudflare.git
cd openclaw-cloudflare
bash setup.sh
```

The script will:
- Check prerequisites (Node.js >= 22, npm, openssl)
- Authenticate with Cloudflare (with multi-account selection if needed)
- Name your bot and create an R2 bucket
- Configure your AI provider (Anthropic, OpenAI, or AI Gateway)
- Auto-generate security tokens (gateway token + CDP secret)
- Set up Cloudflare Access (required for the bot to function)
- Optionally set up Telegram, Discord, or Slack
- Install dependencies and deploy

## Requirements

- [Workers Paid plan](https://www.cloudflare.com/plans/developer-platform/) ($5 USD/month) — required for Cloudflare Sandbox containers
- [Anthropic API key](https://console.anthropic.com/) — for Claude access, or you can use AI Gateway's [Unified Billing](https://developers.cloudflare.com/ai-gateway/features/unified-billing/)

The following Cloudflare features used by this project have free tiers:
- Cloudflare Access (authentication)
- Browser Rendering (for browser navigation)
- AI Gateway (optional, for API routing/analytics)
- R2 Storage (optional, for persistence)

## Container Cost Estimate

This project uses a `standard-1` Cloudflare Container instance (1/2 vCPU, 4 GiB memory, 8 GB disk). Below are approximate monthly costs assuming the container runs 24/7, based on [Cloudflare Containers pricing](https://developers.cloudflare.com/containers/pricing/):

| Resource | Provisioned | Monthly Usage | Included Free | Overage | Approx. Cost |
|----------|-------------|---------------|---------------|---------|--------------|
| Memory | 4 GiB | 2,920 GiB-hrs | 25 GiB-hrs | 2,895 GiB-hrs | ~$26/mo |
| CPU (at ~10% utilization) | 1/2 vCPU | ~2,190 vCPU-min | 375 vCPU-min | ~1,815 vCPU-min | ~$2/mo |
| Disk | 8 GB | 5,840 GB-hrs | 200 GB-hrs | 5,640 GB-hrs | ~$1.50/mo |
| Workers Paid plan | | | | | $5/mo |
| **Total** | | | | | **~$34.50/mo** |

Notes:
- CPU is billed on **active usage only**, not provisioned capacity. The 10% utilization estimate is a rough baseline for a lightly-used personal assistant; your actual cost will vary with usage.
- Memory and disk are billed on **provisioned capacity** for the full time the container is running.
- To reduce costs, configure `SANDBOX_SLEEP_AFTER` (e.g., `10m`) so the container sleeps when idle. A container that only runs 4 hours/day would cost roughly ~$5-6/mo in compute on top of the $5 plan fee.
- Network egress, Workers/Durable Objects requests, and logs are additional but typically minimal for personal use.
- See the [instance types table](https://developers.cloudflare.com/containers/pricing/) for other options (e.g., `lite` at 256 MiB/$0.50/mo memory or `standard-4` at 12 GiB for heavier workloads).

## What is OpenClaw?

[OpenClaw](https://github.com/openclaw/openclaw) (formerly Moltbot, formerly Clawdbot) is a personal AI assistant with a gateway architecture that connects to multiple chat platforms. Key features:

- **Control UI** - Web-based chat interface at the gateway
- **Multi-channel support** - Telegram, Discord, Slack
- **Device pairing** - Secure DM authentication requiring explicit approval
- **Persistent conversations** - Chat history and context across sessions
- **Agent runtime** - Extensible AI capabilities with workspace and skills

This project packages OpenClaw to run in a [Cloudflare Sandbox](https://developers.cloudflare.com/sandbox/) container, providing a fully managed, always-on deployment without needing to self-host. Optional R2 storage enables persistence across container restarts.

## Architecture

![architecture](./assets/architecture.png)

## Manual Setup (Without Script)

If you prefer to set things up manually:

> **Multiple Cloudflare accounts?** If you have more than one Cloudflare account, add `account_id` to `wrangler.jsonc` (top level) so wrangler knows which account to use. You can find your Account ID in the Cloudflare dashboard.

### 1. Clone and deploy

```bash
git clone https://github.com/liorwn/openclaw-cloudflare.git
cd openclaw-cloudflare
npm install
npm run deploy
```

> **Note:** The first deploy may timeout while pushing the container image. Just retry `npm run deploy` — the image is cached after the first push.

### 2. Set secrets

```bash
# Set your API key (direct Anthropic access)
npx wrangler secret put ANTHROPIC_API_KEY

# Or use Cloudflare AI Gateway instead (see "Optional: Cloudflare AI Gateway" below)
# npx wrangler secret put CLOUDFLARE_AI_GATEWAY_API_KEY
# npx wrangler secret put CF_AI_GATEWAY_ACCOUNT_ID
# npx wrangler secret put CF_AI_GATEWAY_GATEWAY_ID

# Generate and set a gateway token (required — auto-injected by the worker)
export MOLTBOT_GATEWAY_TOKEN=$(openssl rand -hex 32)
echo "$MOLTBOT_GATEWAY_TOKEN" | npx wrangler secret put MOLTBOT_GATEWAY_TOKEN
```

### 3. Set up Cloudflare Access (required)

> **If you followed `setup.sh`, this is already done.** Skip to step 4.

Cloudflare Access is **required** for the bot to function — without it, admin routes return 503 errors and device pairing won't work.

1. Go to Workers & Pages dashboard → select your worker → Settings
2. Under Domains & Routes, click `...` on the workers.dev row → **Enable Cloudflare Access**
3. In Zero Trust → Access → Applications, configure who can access (email allow list, Google, GitHub, etc.)
4. Copy the **Application Audience (AUD)** tag from the Access application settings

Then set the secrets:

```bash
# Your Cloudflare Access team domain (e.g., "myteam.cloudflareaccess.com")
# Find it in Zero Trust dashboard → Settings → Custom Pages
npx wrangler secret put CF_ACCESS_TEAM_DOMAIN

# The Application Audience (AUD) tag from your Access application
npx wrangler secret put CF_ACCESS_AUD
```

### 4. Redeploy

```bash
npm run deploy
```

After deploying, visit your worker URL:

```
https://my-openclaw-bot.your-subdomain.workers.dev/
```

You'll be prompted to authenticate via Cloudflare Access. Once authenticated, the gateway token is injected automatically — no need to pass `?token=` manually.

Replace `my-openclaw-bot` with your actual worker name.

**Note:** The first request may take 1-2 minutes while the container starts.

You'll also likely want to [enable R2 storage](#persistent-storage-r2) so your paired devices and conversation history persist across container restarts (optional but recommended).

## Setting Up the Admin UI

> **Already done?** If you followed `setup.sh` or the manual setup steps above, Cloudflare Access is already configured. The steps below are a detailed reference.

To use the admin UI at `/_admin/` for device management, you need to:
1. Enable Cloudflare Access on your worker
2. Set the Access secrets so the worker can validate JWTs

### 1. Enable Cloudflare Access on workers.dev

The easiest way to protect your worker is using the built-in Cloudflare Access integration for workers.dev:

1. Go to the [Workers & Pages dashboard](https://dash.cloudflare.com/?to=/:account/workers-and-pages)
2. Select your Worker (e.g., `my-openclaw-bot`)
3. In **Settings**, under **Domains & Routes**, in the `workers.dev` row, click the meatballs menu (`...`)
4. Click **Enable Cloudflare Access**
5. Copy the values shown in the dialog (you'll need the AUD tag later). **Note:** The "Manage Cloudflare Access" link in the dialog may 404 — ignore it.
6. To configure who can access, go to **Zero Trust** in the Cloudflare dashboard sidebar → **Access** → **Applications**, and find your worker's application:
   - Add your email address to the allow list
   - Or configure other identity providers (Google, GitHub, etc.)
7. Copy the **Application Audience (AUD)** tag from the Access application settings. This will be your `CF_ACCESS_AUD` in Step 2 below

### 2. Set Access Secrets

After enabling Cloudflare Access, set the secrets so the worker can validate JWTs:

```bash
# Your Cloudflare Access team domain (e.g., "myteam.cloudflareaccess.com")
npx wrangler secret put CF_ACCESS_TEAM_DOMAIN

# The Application Audience (AUD) tag from your Access application that you copied in the step above
npx wrangler secret put CF_ACCESS_AUD
```

You can find your team domain in the [Zero Trust Dashboard](https://one.dash.cloudflare.com/) under **Settings** > **Custom Pages** (it's the subdomain before `.cloudflareaccess.com`).

### 3. Redeploy

```bash
npm run deploy
```

Now visit `/_admin/` and you'll be prompted to authenticate via Cloudflare Access before accessing the admin UI.

### Alternative: Manual Access Application

If you prefer more control, you can manually create an Access application:

1. Go to [Cloudflare Zero Trust Dashboard](https://one.dash.cloudflare.com/)
2. Navigate to **Access** > **Applications**
3. Create a new **Self-hosted** application
4. Set the application domain to your Worker URL (e.g., `my-openclaw-bot.your-subdomain.workers.dev`)
5. Add paths to protect: `/_admin/*`, `/api/*`, `/debug/*`
6. Configure your desired identity providers (e.g., email OTP, Google, GitHub)
7. Copy the **Application Audience (AUD)** tag and set the secrets as shown above

### Local Development

For local development, create a `.dev.vars` file with:

```bash
DEV_MODE=true               # Skip Cloudflare Access auth + bypass device pairing
DEBUG_ROUTES=true           # Enable /debug/* routes (optional)
```

## Cloudflare Access CDP Bypass

**This is critical for browser automation to work.** If you have Cloudflare Access enabled on your worker, the `/cdp` path will be blocked by default — the container itself cannot pass the Access authentication check when connecting back to the worker's `/cdp` endpoint.

You must create a **separate Access application** that bypasses authentication for the `/cdp` path:

1. Go to [Cloudflare Zero Trust Dashboard](https://one.dash.cloudflare.com/) → **Access** → **Applications**
2. Click **Add an application** → **Self-hosted**
3. Configure the application:
   - **Application name:** `<your-bot-name> CDP Bypass`
   - **Session duration:** 24 hours (or your preference)
   - **Application domain:** `<your-bot-name>.<your-subdomain>.workers.dev`
   - **Path:** `cdp`
4. Add an **Allow** policy:
   - **Policy name:** `Service Auth Bypass`
   - **Include:** `Everyone`
   - **Set the action to:** `Bypass`
5. Save the application

**Why this is needed:** When OpenClaw runs inside the Cloudflare Sandbox container and needs to use browser automation, it makes requests back to the worker's `/cdp` endpoint. Cloudflare Access intercepts these requests and blocks them because the container doesn't have Access credentials. The bypass application creates an exception for the `/cdp` path specifically.

The `/cdp` endpoint is still protected by the `CDP_SECRET` query parameter, so unauthenticated access without the secret will be rejected by the worker itself.

## Authentication

### How It Works

This deployment uses two authentication layers:

1. **Cloudflare Access** — Protects all routes. Users must authenticate (email OTP, Google, GitHub, etc.) before reaching the worker.
2. **Gateway Token** — A shared secret between the worker and the container. The worker injects the token into requests automatically after CF Access auth succeeds, so you never need to pass `?token=` manually.

For the **web UI (Control UI)**, device pairing is bypassed — Cloudflare Access is the security boundary. Once you pass CF Access auth, you're in.

### Device Pairing (Chat Channels)

Device pairing applies to **chat channel DMs** (Telegram, Discord, Slack), not the web UI:

1. A device sends a DM to the bot
2. The connection is held pending until approved
3. An admin approves the device via `/_admin/`
4. The device is now paired and can DM freely

This prevents unauthorized users from chatting with your bot via public channels.

### Gateway Token

The gateway token (`MOLTBOT_GATEWAY_TOKEN`) is auto-generated by `setup.sh` and stored as a wrangler secret. The worker injects it into all proxied requests server-side — you don't need to manage or pass it manually.

For local development only, set `DEV_MODE=true` in `.dev.vars` to skip Cloudflare Access authentication entirely.

## Persistent Storage (R2)

By default, OpenClaw data (configs, paired devices, conversation history) is lost when the container restarts. To enable persistent storage across sessions, configure R2:

### 1. Create R2 API Token

1. Go to the [R2 API Tokens page](https://dash.cloudflare.com/?to=/:account/r2/api-tokens) in the Cloudflare Dashboard
2. Click **Create API Token**
3. Set permissions to **Object Read & Write**
4. Select your bot's data bucket (e.g., `my-openclaw-data`), or **Apply to all buckets**
5. Click **Create API Token**
6. Copy the **Access Key ID** and **Secret Access Key**

### 2. Set Secrets

```bash
# R2 Access Key ID
npx wrangler secret put R2_ACCESS_KEY_ID

# R2 Secret Access Key
npx wrangler secret put R2_SECRET_ACCESS_KEY

# Your Cloudflare Account ID
npx wrangler secret put CF_ACCOUNT_ID
```

To find your Account ID: Go to the [Cloudflare Dashboard](https://dash.cloudflare.com/), click the three dots menu next to your account name, and select "Copy Account ID".

### How It Works

R2 storage uses a backup/restore approach for simplicity:

**On container startup:**
- If R2 is mounted and contains backup data, it's restored to the OpenClaw config directory
- OpenClaw uses its default paths (no special configuration needed)

**During operation:**
- A cron job runs every 5 minutes to sync the OpenClaw config to R2
- You can also trigger a manual backup from the admin UI at `/_admin/`

**In the admin UI:**
- When R2 is configured, you'll see "Last backup: [timestamp]"
- Click "Backup Now" to trigger an immediate sync

Without R2 credentials, OpenClaw still works but uses ephemeral storage (data lost on container restart).

## Container Lifecycle

By default, the sandbox container stays alive indefinitely (`SANDBOX_SLEEP_AFTER=never`). This is recommended because cold starts take 1-2 minutes.

To reduce costs for infrequently used deployments, you can configure the container to sleep after a period of inactivity:

```bash
npx wrangler secret put SANDBOX_SLEEP_AFTER
# Enter: 10m (or 1h, 30m, etc.)
```

When the container sleeps, the next request will trigger a cold start. If you have R2 storage configured, your paired devices and data will persist across restarts.

## Admin UI

![admin ui](./assets/adminui.png)

Access the admin UI at `/_admin/` to:
- **R2 Storage Status** - Shows if R2 is configured, last backup time, and a "Backup Now" button
- **Restart Gateway** - Kill and restart the OpenClaw gateway process
- **Device Pairing** - View pending requests, approve devices individually or all at once, view paired devices

The admin UI requires Cloudflare Access authentication (or `DEV_MODE=true` for local development).

## Debug Endpoints

Debug endpoints are available at `/debug/*` when enabled (requires `DEBUG_ROUTES=true` and Cloudflare Access):

- `GET /debug/processes` - List all container processes
- `GET /debug/logs?id=<process_id>` - Get logs for a specific process
- `GET /debug/version` - Get container and OpenClaw version info

## Customizing Your Bot

OpenClaw's personality and behavior are configured through markdown files in the `seed-workspace/` directory. These files are copied into the container on build and serve as the initial state for your bot.

### Workspace Files

| File | Purpose |
|------|---------|
| `AGENTS.md` | Core agent instructions — how the bot operates, memory management, safety rules |
| `IDENTITY.md` | Bot personality, name, and communication style |
| `USER.md` | Information about you (the human) — helps the bot personalize interactions |
| `MEMORY.md` | Long-term memory — the bot updates this over time with significant events |
| `HEARTBEAT.md` | Periodic check-in tasks — what the bot does during heartbeat polls |
| `TOOLS.md` | Tool configuration notes — document integrations and service configs |

### Adding Skills

Skills are placed in `skills/` and copied into the container. Each skill has a `SKILL.md` describing its capabilities and `scripts/` with executable tools.

The included `cloudflare-browser` skill provides browser automation via the CDP shim. To add your own skills, create a new directory under `skills/` with a `SKILL.md` and any scripts.

### Redeploying After Changes

After modifying seed-workspace files or skills:

```bash
# Update the cache bust comment in Dockerfile (any change triggers rebuild)
# Then redeploy:
npm run deploy
```

**Note:** If R2 persistent storage is configured, the bot's existing workspace data takes precedence over seed files. To force a fresh start, clear the R2 backup or temporarily disable R2 credentials.

## Optional: Chat Channels

### Telegram

```bash
npx wrangler secret put TELEGRAM_BOT_TOKEN
npm run deploy
```

### Discord

```bash
npx wrangler secret put DISCORD_BOT_TOKEN
npm run deploy
```

### Slack

```bash
npx wrangler secret put SLACK_BOT_TOKEN
npx wrangler secret put SLACK_APP_TOKEN
npm run deploy
```

## Optional: Browser Automation (CDP)

This worker includes a Chrome DevTools Protocol (CDP) shim that enables browser automation capabilities. This allows OpenClaw to control a headless browser for tasks like web scraping, screenshots, and automated testing.

### Setup

1. Set a shared secret for authentication:

```bash
npx wrangler secret put CDP_SECRET
# Enter a secure random string (setup.sh generates this automatically)
```

2. Set your worker's public URL:

```bash
npx wrangler secret put WORKER_URL
# Enter: https://my-openclaw-bot.your-subdomain.workers.dev
```

3. **Create a Cloudflare Access bypass for `/cdp`** — see [Cloudflare Access CDP Bypass](#cloudflare-access-cdp-bypass) above.

4. Redeploy:

```bash
npm run deploy
```

### Endpoints

| Endpoint | Description |
|----------|-------------|
| `GET /cdp/json/version` | Browser version information |
| `GET /cdp/json/list` | List available browser targets |
| `GET /cdp/json/new` | Create a new browser target |
| `WS /cdp/devtools/browser/{id}` | WebSocket connection for CDP commands |

All endpoints require authentication via the `?secret=<CDP_SECRET>` query parameter.

## Built-in Skills

The container includes pre-installed skills in `/root/clawd/skills/`:

### cloudflare-browser

Browser automation via the CDP shim. Requires `CDP_SECRET` and `WORKER_URL` to be set (see [Browser Automation](#optional-browser-automation-cdp) above).

**Scripts:**
- `screenshot.js` - Capture a screenshot of a URL
- `video.js` - Create a video from multiple URLs
- `cdp-client.js` - Reusable CDP client library

**Usage:**
```bash
# Screenshot
node /root/clawd/skills/cloudflare-browser/scripts/screenshot.js https://example.com output.png

# Video from multiple URLs
node /root/clawd/skills/cloudflare-browser/scripts/video.js "https://site1.com,https://site2.com" output.mp4 --scroll
```

See `skills/cloudflare-browser/SKILL.md` for full documentation.

## Optional: Cloudflare AI Gateway

You can route API requests through [Cloudflare AI Gateway](https://developers.cloudflare.com/ai-gateway/) for caching, rate limiting, analytics, and cost tracking. OpenClaw has native support for Cloudflare AI Gateway as a first-class provider.

AI Gateway acts as a proxy between OpenClaw and your AI provider (e.g., Anthropic). Requests are sent to `https://gateway.ai.cloudflare.com/v1/{account_id}/{gateway_id}/anthropic` instead of directly to `api.anthropic.com`, giving you Cloudflare's analytics, caching, and rate limiting. You still need a provider API key (e.g., your Anthropic API key) — the gateway forwards it to the upstream provider.

### Setup

1. Create an AI Gateway in the [AI Gateway section](https://dash.cloudflare.com/?to=/:account/ai/ai-gateway/create-gateway) of the Cloudflare Dashboard.
2. Set the three required secrets:

```bash
# Your AI provider's API key (e.g., your Anthropic API key).
# This is passed through the gateway to the upstream provider.
npx wrangler secret put CLOUDFLARE_AI_GATEWAY_API_KEY

# Your Cloudflare account ID
npx wrangler secret put CF_AI_GATEWAY_ACCOUNT_ID

# Your AI Gateway ID (from the gateway overview page)
npx wrangler secret put CF_AI_GATEWAY_GATEWAY_ID
```

All three are required. OpenClaw constructs the gateway URL from the account ID and gateway ID, and passes the API key to the upstream provider through the gateway.

3. Redeploy:

```bash
npm run deploy
```

When Cloudflare AI Gateway is configured, it takes precedence over direct `ANTHROPIC_API_KEY` or `OPENAI_API_KEY`.

### Choosing a Model

By default, AI Gateway uses Anthropic's Claude Sonnet 4.5. To use a different model or provider, set `CF_AI_GATEWAY_MODEL` with the format `provider/model-id`:

```bash
npx wrangler secret put CF_AI_GATEWAY_MODEL
# Enter: workers-ai/@cf/meta/llama-3.3-70b-instruct-fp8-fast
```

This works with any [AI Gateway provider](https://developers.cloudflare.com/ai-gateway/usage/providers/):

| Provider | Example `CF_AI_GATEWAY_MODEL` value | API key is... |
|----------|-------------------------------------|---------------|
| Workers AI | `workers-ai/@cf/meta/llama-3.3-70b-instruct-fp8-fast` | Cloudflare API token |
| OpenAI | `openai/gpt-4o` | OpenAI API key |
| Anthropic | `anthropic/claude-sonnet-4-5` | Anthropic API key |
| Groq | `groq/llama-3.3-70b` | Groq API key |

**Note:** `CLOUDFLARE_AI_GATEWAY_API_KEY` must match the provider you're using — it's your provider's API key, forwarded through the gateway. You can only use one provider at a time through the gateway. For multiple providers, use direct keys (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`) alongside the gateway config.

#### Workers AI with Unified Billing

With [Unified Billing](https://developers.cloudflare.com/ai-gateway/features/unified-billing/), you can use Workers AI models without a separate provider API key — Cloudflare bills you directly. Set `CLOUDFLARE_AI_GATEWAY_API_KEY` to your [AI Gateway authentication token](https://developers.cloudflare.com/ai-gateway/configuration/authentication/) (the `cf-aig-authorization` token).

### Legacy AI Gateway Configuration

The previous `AI_GATEWAY_API_KEY` + `AI_GATEWAY_BASE_URL` approach is still supported for backward compatibility but is deprecated in favor of the native configuration above.

## All Secrets Reference

| Secret | Required | Description |
|--------|----------|-------------|
| `CLOUDFLARE_AI_GATEWAY_API_KEY` | Yes* | Your AI provider's API key, passed through the gateway (e.g., your Anthropic API key). Requires `CF_AI_GATEWAY_ACCOUNT_ID` and `CF_AI_GATEWAY_GATEWAY_ID` |
| `CF_AI_GATEWAY_ACCOUNT_ID` | Yes* | Your Cloudflare account ID (used to construct the gateway URL) |
| `CF_AI_GATEWAY_GATEWAY_ID` | Yes* | Your AI Gateway ID (used to construct the gateway URL) |
| `CF_AI_GATEWAY_MODEL` | No | Override default model: `provider/model-id` (e.g. `workers-ai/@cf/meta/llama-3.3-70b-instruct-fp8-fast`). See [Choosing a Model](#choosing-a-model) |
| `ANTHROPIC_API_KEY` | Yes* | Direct Anthropic API key (alternative to AI Gateway) |
| `ANTHROPIC_BASE_URL` | No | Direct Anthropic API base URL |
| `OPENAI_API_KEY` | No | OpenAI API key (alternative provider) |
| `AI_GATEWAY_API_KEY` | No | Legacy AI Gateway API key (deprecated, use `CLOUDFLARE_AI_GATEWAY_API_KEY` instead) |
| `AI_GATEWAY_BASE_URL` | No | Legacy AI Gateway endpoint URL (deprecated) |
| `CF_ACCESS_TEAM_DOMAIN` | Yes* | Cloudflare Access team domain (required for admin UI) |
| `CF_ACCESS_AUD` | Yes* | Cloudflare Access application audience (required for admin UI) |
| `MOLTBOT_GATEWAY_TOKEN` | Yes | Gateway token for authentication (auto-injected by worker after CF Access auth) |
| `DEV_MODE` | No | Set to `true` to skip CF Access auth + device pairing (local dev only) |
| `DEBUG_ROUTES` | No | Set to `true` to enable `/debug/*` routes |
| `SANDBOX_SLEEP_AFTER` | No | Container sleep timeout: `never` (default) or duration like `10m`, `1h` |
| `R2_ACCESS_KEY_ID` | No | R2 access key for persistent storage |
| `R2_SECRET_ACCESS_KEY` | No | R2 secret key for persistent storage |
| `CF_ACCOUNT_ID` | No | Cloudflare account ID (required for R2 storage) |
| `TELEGRAM_BOT_TOKEN` | No | Telegram bot token |
| `TELEGRAM_DM_POLICY` | No | Telegram DM policy: `pairing` (default) or `open` |
| `DISCORD_BOT_TOKEN` | No | Discord bot token |
| `DISCORD_DM_POLICY` | No | Discord DM policy: `pairing` (default) or `open` |
| `SLACK_BOT_TOKEN` | No | Slack bot token |
| `SLACK_APP_TOKEN` | No | Slack app token |
| `CDP_SECRET` | No | Shared secret for CDP endpoint authentication (see [Browser Automation](#optional-browser-automation-cdp)) |
| `WORKER_URL` | No | Public URL of the worker (required for CDP) |
| `BRAVE_API_KEY` | No | Brave Search API key |

## Security Considerations

### Authentication Layers

OpenClaw in Cloudflare Sandbox uses multiple authentication layers:

1. **Cloudflare Access** — Protects all routes. Only authenticated users can access the Control UI, admin UI, and API endpoints.

2. **Gateway Token** — Shared secret between the worker and the container, injected automatically into proxied requests. Users never need to handle this directly.

3. **Device Pairing** — Applies to chat channel DMs (Telegram, Discord, Slack). Each device must be explicitly approved via the admin UI before it can DM the bot. The web UI bypasses pairing since Cloudflare Access provides the authentication layer.

## Troubleshooting

**First deploy times out:** The initial container image push can be slow. Retry `npm run deploy` — the image is cached after the first push.

**`npm run dev` fails with an `Unauthorized` error:** You need to enable Cloudflare Containers in the [Containers dashboard](https://dash.cloudflare.com/?to=/:account/workers/containers)

**Gateway fails to start:** Check `npx wrangler secret list` and `npx wrangler tail`

**Config changes not working:** Edit the `# Build cache bust:` comment in `Dockerfile` and redeploy

**Slow first request:** Cold starts take 1-2 minutes. Subsequent requests are faster.

**R2 not mounting:** Check that all three R2 secrets are set (`R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `CF_ACCOUNT_ID`). Note: R2 mounting only works in production, not with `wrangler dev`.

**Access denied on admin routes:** Ensure `CF_ACCESS_TEAM_DOMAIN` and `CF_ACCESS_AUD` are set, and that your Cloudflare Access application is configured correctly.

**Browser automation returns "Access denied":** You need to create a Cloudflare Access bypass for the `/cdp` path. See [Cloudflare Access CDP Bypass](#cloudflare-access-cdp-bypass).

**Devices not appearing in admin UI:** Device list commands take 10-15 seconds due to WebSocket connection overhead. Wait and refresh.

**WebSocket issues in local development:** `wrangler dev` has known limitations with WebSocket proxying through the sandbox. HTTP requests work but WebSocket connections may fail. Deploy to Cloudflare for full functionality.

## Known Issues

### Windows: Gateway fails to start with exit code 126 (permission denied)

On Windows, Git may check out shell scripts with CRLF line endings instead of LF. This causes `start-openclaw.sh` to fail with exit code 126 inside the Linux container. Ensure your repository uses LF line endings — configure Git with `git config --global core.autocrlf input` or add a `.gitattributes` file with `* text=auto eol=lf`. See [#64](https://github.com/cloudflare/moltworker/issues/64) for details.

## Links

- [OpenClaw](https://github.com/openclaw/openclaw)
- [OpenClaw Docs](https://docs.openclaw.ai/)
- [Cloudflare Sandbox Docs](https://developers.cloudflare.com/sandbox/)
- [Cloudflare Access Docs](https://developers.cloudflare.com/cloudflare-one/policies/access/)
