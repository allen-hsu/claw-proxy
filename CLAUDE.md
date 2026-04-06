# CLAUDE.md

## Project Overview

claw-proxy is a minimal OpenAI-compatible HTTP proxy that routes requests to Claude via the `claude -p` CLI (headless mode), using Claude Max subscription auth. It supports round-robin rotation across multiple accounts.

## Architecture

```
Request Flow:
  Client (OpenAI format)
    → Express server (server.ts)
    → AccountRouter picks next account (router.ts)
    → ClaudeProcess spawns `claude -p` with CLAUDE_CODE_OAUTH_TOKEN (subprocess.ts)
    → NDJSON stream parsed → converted to OpenAI SSE format (adapter.ts)
    → Response streamed back to client
```

### Key Files

- `src/index.ts` — Entry point. Loads config, starts Express server, handles `--setup` flag.
- `src/config.ts` — Reads/writes `~/.claw-proxy/config.json`. Supports `PORT`/`HOST` env var overrides.
- `src/server.ts` — Express app with `/v1/chat/completions` (streaming + sync), `/v1/models`, `/health`. Auth middleware checks bearer token.
- `src/router.ts` — `AccountRouter` class. Round-robin rotation with cooldown support. `acquire()` picks next available account, `release()` frees it, `cooldown()` temporarily disables an account.
- `src/subprocess.ts` — `ClaudeProcess` extends EventEmitter. Spawns `claude --print - --output-format stream-json --model <model>` with `CLAUDE_CODE_OAUTH_TOKEN` env var. Parses NDJSON, emits `delta`/`result`/`error`/`close` events. Handles timeout and abort signal.
- `src/adapter.ts` — Format conversion. `messagesToPrompt()` converts OpenAI messages to a single prompt string with `<system>` and `<previous_response>` XML tags. `streamChunk()` / `completionResponse()` produce OpenAI format output. `resolveModel()` maps model IDs via `MODEL_MAP`.

### Auth Mechanism

- Each account has an `oauthToken` from `claude setup-token` (valid 1 year)
- Passed to subprocess as `CLAUDE_CODE_OAUTH_TOKEN` env var
- Fallback: `configDir` (path to a dir where `claude auth login` was run, uses `CLAUDE_CONFIG_DIR`)

### Model Mapping

`MODEL_MAP` in adapter.ts maps incoming model IDs to Claude CLI model aliases:
- `claude-sonnet-4` / `openai/claude-sonnet-4` → `sonnet`
- `claude-opus-4` / `openai/claude-opus-4` → `opus`
- `claude-haiku-4` / `openai/claude-haiku-4` → `haiku`
- Full model names like `claude-sonnet-4-5` pass through directly
- Unknown models fall back to `config.defaultModel` (default: `sonnet`)

## Build & Run

```bash
npm install
npm run build   # tsc → dist/
npm start       # node dist/index.js
```

## Docker

```bash
docker compose up -d --build
```

- Config: `./data/config.json` mounted read-only to `/root/.claw-proxy/`
- Dockerfile sets `HOST=0.0.0.0` so the container accepts external connections
- `docker-compose.yml` joins `clawhuddle-net` as an external network (if present)

## Integration

Any OpenAI-compatible client can use claw-proxy by setting a custom base URL and using the bearer token as an API key. For OpenClaw specifically, register a custom provider in `openclaw.json` with `api: "openai-completions"` pointing to claw-proxy's `/v1` endpoint.

## Testing

```bash
# Health check
curl http://127.0.0.1:3456/health

# Streaming request
curl http://127.0.0.1:3456/v1/chat/completions \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{"model":"claude-sonnet-4","messages":[{"role":"user","content":"hi"}],"stream":true}'
```

## Conventions

- TypeScript with strict mode, ES modules (`"type": "module"`)
- Minimal dependencies (express + uuid only)
- No test framework set up yet
- Config file has `0600` permissions for security
- Bearer token auto-generated on first run
