# claw-proxy

Minimal OpenAI-compatible proxy for Claude Max subscriptions with multi-account rotation.

Accepts `/v1/chat/completions` requests in OpenAI format, rotates between multiple Claude Max accounts, and forwards them through `claude -p` (headless CLI). No API keys needed — uses your subscription directly.

```
Your App → claw-proxy (OpenAI format) → claude -p → Anthropic (subscription)
```

## Quick Start

```bash
git clone https://github.com/allen-hsu/claw-proxy.git
cd claw-proxy
npm install && npm run build

# First run generates ~/.claw-proxy/config.json with a random bearer token.
# The server will exit until you replace the placeholder account tokens.
npm start
```

## Setup Accounts

Generate a long-lived OAuth token for each Claude Max account:

```bash
claude setup-token
# Opens browser → log in → copy the token (valid for 1 year)
```

Paste tokens into `~/.claw-proxy/config.json`:

```json
{
  "port": 3456,
  "host": "127.0.0.1",
  "bearerToken": "auto-generated-on-first-run",
  "accounts": [
    { "name": "account-1", "oauthToken": "<token from account A>" },
    { "name": "account-2", "oauthToken": "<token from account B>" },
    { "name": "account-3", "oauthToken": "<token from account C>" }
  ],
  "timeoutMs": 900000,
  "defaultModel": "sonnet"
}
```

`oauthToken` is the default. You can also use `configDir` for an account if you want the proxy to reuse an existing Claude CLI login directory instead of a long-lived token:

```json
{
  "accounts": [
    { "name": "account-1", "oauthToken": "<token from account A>" },
    { "name": "account-2", "configDir": "/path/to/claude-config-dir" }
  ]
}
```

Test:

```bash
curl http://127.0.0.1:3456/v1/chat/completions \
  -H "Authorization: Bearer <your-bearer-token>" \
  -H "Content-Type: application/json" \
  -d '{"model":"claude-sonnet-4","messages":[{"role":"user","content":"Hello"}],"stream":true}'
```

## Usage with OpenClaw

Add a custom provider to your `openclaw.json`:

```json
{
  "models": {
    "providers": {
      "claw": {
        "baseUrl": "http://localhost:3456/v1",
        "apiKey": "<your-bearer-token>",
        "api": "openai-completions",
        "models": [
          {
            "id": "claude-opus-4-6",
            "name": "Claude Opus 4.6",
            "reasoning": true,
            "input": ["text"],
            "cost": { "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0 },
            "contextWindow": 1000000,
            "maxTokens": 32000
          },
          {
            "id": "claude-sonnet-4-6",
            "name": "Claude Sonnet 4.6",
            "reasoning": true,
            "input": ["text"],
            "cost": { "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0 },
            "contextWindow": 1000000,
            "maxTokens": 32000
          }
        ]
      }
    }
  },
  "agents": {
    "defaults": {
      "model": { "primary": "claw/claude-opus-4-6" }
    }
  }
}
```

The `cost` is set to `0` since requests go through your Claude Max subscription.

## Usage with Any OpenAI-Compatible Client

Any tool that supports custom OpenAI endpoints works (Continue.dev, TypingMind, etc.):

```
Base URL:  http://127.0.0.1:3456/v1
API Key:   <your-bearer-token>
Model:     claude-sonnet-4
```

For best prompt-cache reuse, send a stable conversation identifier in either the OpenAI `user` field or a header like `X-Session-Id`. If neither is provided, the proxy falls back to an IP + conversation fingerprint heuristic.

## Available Models

| Model ID | Maps To |
|----------|---------|
| `claude-sonnet-4` | Claude Sonnet 4 |
| `claude-opus-4` | Claude Opus 4 |
| `claude-haiku-4` | Claude Haiku 4 |
| `claude-haiku-4-5` | Claude Haiku 4.5 |
| `claude-sonnet-4-5` | Claude Sonnet 4.5 |
| `claude-sonnet-4-6` | Claude Sonnet 4.6 |
| `claude-opus-4-6` | Claude Opus 4.6 |

Models can also be prefixed with `openai/` (e.g. `openai/claude-sonnet-4`) for OpenClaw routing.

## Account Rotation

Accounts use a fill-first strategy, not round-robin. The proxy keeps sending traffic to the first available account to maximize prompt-cache reuse, and only moves to the next account when the current one is in cooldown.

When an account hits a rate limit or usage cap, it is automatically cooled down and skipped until another account is available.

```bash
# Check account status
curl http://127.0.0.1:3456/health -H "Authorization: Bearer <token>"
```

## Deployment

### Docker

```bash
mkdir -p data
# Create data/config.json with your tokens (see Setup Accounts above)
docker compose up -d --build
```

Config is mounted from `./data/config.json`. Set `host` to `"0.0.0.0"` in config for Docker.

### systemd (Linux)

```bash
sudo cp claw-proxy.service /etc/systemd/system/claw-proxy@.service
sudo systemctl daemon-reload
sudo systemctl enable claw-proxy@$USER
sudo systemctl start claw-proxy@$USER
```

## Configuration Reference

`~/.claw-proxy/config.json` (or `./data/config.json` for Docker):

| Field | Default | Description |
|-------|---------|-------------|
| `port` | `3456` | Server port. Override with `PORT` env var. |
| `host` | `127.0.0.1` | Bind address. Override with `HOST` env var. Use `0.0.0.0` in Docker. |
| `bearerToken` | auto-generated | API key for authenticating requests to the proxy. |
| `accounts` | — | Array of accounts. Each account must provide either `{ name, oauthToken }` or `{ name, configDir }`. |
| `timeoutMs` | `900000` | Max time per request (15 min). |
| `defaultModel` | `sonnet` | Fallback model when the requested model is not in the map. |

## Security

- Binds to `127.0.0.1` by default (localhost only)
- Bearer token required for all `/v1` endpoints
- No CORS headers (not a browser-facing service)
- Uses `spawn()` not `exec()` — no command injection
- No telemetry, no external calls, no credential logging
- Tokens stored in config.json with `0600` permissions

## Architecture

```
src/
├── index.ts        # Entry point — start server or --setup
├── config.ts       # ~/.claw-proxy/config.json management
├── server.ts       # Express — /v1/chat/completions, /health, /v1/models
├── router.ts       # Fill-first account routing + cooldown
├── subprocess.ts   # spawn claude -p + NDJSON stream parser
└── adapter.ts      # OpenAI ↔ Claude CLI format conversion
```

~450 lines of TypeScript. Dependencies: `express`, `uuid`.

## License

MIT
