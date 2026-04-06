import express, { type Request, type Response } from "express";
import type { Config } from "./config.js";
import { AccountRouter, type AccountState } from "./router.js";
import { ClaudeProcess, type CliResultMessage } from "./subprocess.js";
import {
  type OpenAIRequest,
  resolveModel,
  messagesToPrompt,
  makeRequestId,
  streamChunk,
  completionResponse,
  parseToolCalls,
} from "./adapter.js";

const MAX_RETRIES = 3;
const AUTH_COOLDOWN_MS = 300_000; // 5 minutes
const RATE_COOLDOWN_MS = 60_000;  // 1 minute
const EXIT_COOLDOWN_MS = 30_000;  // 30 seconds

function isAuthError(text: string): boolean {
  const lower = text.toLowerCase();
  return (
    lower.includes("authentication_error") ||
    lower.includes("unauthorized") ||
    lower.includes("invalid token") ||
    lower.includes("token expired") ||
    lower.includes("not authenticated") ||
    lower.includes("auth") && lower.includes("error")
  );
}

function isRateLimit(text: string): boolean {
  const lower = text.toLowerCase();
  return lower.includes("rate") || lower.includes("limit") || lower.includes("overloaded");
}

export function createServer(config: Config) {
  const app = express();
  const router = new AccountRouter(config.accounts);

  // Middleware
  app.use(express.json({ limit: "4mb" }));

  // Auth middleware
  app.use("/v1", (req, res, next) => {
    if (!config.bearerToken) return next();
    const auth = req.headers.authorization;
    if (auth !== `Bearer ${config.bearerToken}`) {
      res.status(401).json({ error: { message: "Unauthorized", type: "auth_error" } });
      return;
    }
    next();
  });

  // Health
  app.get("/health", (_req, res) => {
    res.json({
      status: "ok",
      accounts: router.status(),
      timestamp: new Date().toISOString(),
    });
  });

  // Models
  app.get("/v1/models", (_req, res) => {
    res.json({
      object: "list",
      data: [
        { id: "claude-opus-4", object: "model", owned_by: "anthropic" },
        { id: "claude-sonnet-4", object: "model", owned_by: "anthropic" },
        { id: "claude-haiku-4", object: "model", owned_by: "anthropic" },
      ],
    });
  });

  // Chat completions
  app.post("/v1/chat/completions", (req: Request, res: Response) => {
    const body = req.body as OpenAIRequest;

    if (!body.messages?.length) {
      res.status(400).json({
        error: { message: "messages is required and must be non-empty", type: "invalid_request" },
      });
      return;
    }

    const requestId = makeRequestId();
    const model = resolveModel(body.model, config.defaultModel);
    const prompt = messagesToPrompt(body.messages, body.tools);

    // Use "user" field from OpenAI request for sticky routing
    const userId = body.user || req.ip || "default";

    console.log(
      `[${requestId}] ${body.stream ? "stream" : "sync"} | model=${model} | user=${userId} | messages=${body.messages.length} | prompt_len=${prompt.length}`
    );

    if (body.stream) {
      handleStreamWithRetry(res, requestId, model, prompt, config, router, 0, userId);
    } else {
      handleSyncWithRetry(res, requestId, model, prompt, config, router, 0, userId);
    }
  });

  // 404
  app.use((_req, res) => {
    res.status(404).json({ error: { message: "Not found", type: "not_found" } });
  });

  return app;
}

// --- Streaming with retry ---

function handleStreamWithRetry(
  res: Response,
  requestId: string,
  model: string,
  prompt: string,
  config: Config,
  router: AccountRouter,
  attempt: number,
  userId?: string
): void {
  const account = router.acquire(userId);
  if (!account) {
    res.status(503).json({
      error: { message: "No accounts available", type: "server_error" },
    });
    return;
  }

  console.log(
    `[${requestId}] attempt=${attempt + 1} | account=${account.account.name}`
  );

  // Only set headers on first attempt
  if (attempt === 0) {
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.flushHeaders();
  }

  const abort = new AbortController();
  const proc = new ClaudeProcess();
  let gotResult = false;
  let fullText = "";

  // Client disconnect
  res.on("close", () => {
    abort.abort();
    proc.kill();
    router.release(account);
  });

  proc.on("delta", (text: string) => {
    fullText += text;
  });

  proc.on("result", (result: CliResultMessage) => {
    gotResult = true;
    const resultText = result.result || "";

    // Check for retryable errors
    if (result.is_error && attempt < MAX_RETRIES - 1) {
      if (isAuthError(resultText)) {
        console.error(`[${requestId}] Auth error on ${account.account.name}, retrying...`);
        router.cooldown(account, AUTH_COOLDOWN_MS);
        router.release(account);
        handleStreamWithRetry(res, requestId, model, prompt, config, router, attempt + 1, userId);
        return;
      }
      if (isRateLimit(resultText)) {
        console.error(`[${requestId}] Rate limit on ${account.account.name}, retrying...`);
        router.cooldown(account, RATE_COOLDOWN_MS);
        router.release(account);
        handleStreamWithRetry(res, requestId, model, prompt, config, router, attempt + 1, userId);
        return;
      }
    }

    // Non-retryable error or last attempt — cooldown and respond
    if (result.is_error) {
      if (isAuthError(resultText)) router.cooldown(account, AUTH_COOLDOWN_MS);
      else if (isRateLimit(resultText)) router.cooldown(account, RATE_COOLDOWN_MS);
    }

    // Build response
    const responseText = fullText || resultText;
    const { cleanText, toolCalls } = parseToolCalls(responseText);

    if (toolCalls.length > 0) {
      console.log(
        `[${requestId}] → tool_calls: [${toolCalls.map((tc) => tc.function.name).join(", ")}]`
      );
      if (cleanText) {
        res.write(streamChunk(requestId, model, cleanText, null, true));
      }
      res.write(streamChunk(requestId, model, null, null, !cleanText, toolCalls));
      res.write(streamChunk(requestId, model, null, "tool_calls"));
    } else {
      res.write(streamChunk(requestId, model, cleanText, null, true));
      res.write(streamChunk(requestId, model, null, "stop"));
    }

    res.write("data: [DONE]\n\n");
    res.end();
    router.release(account);
  });

  proc.on("error", (err: Error) => {
    console.error(`[${requestId}] Error: ${err.message}`);

    // Retry on process errors (e.g. CLI crash)
    if (attempt < MAX_RETRIES - 1) {
      router.cooldown(account, EXIT_COOLDOWN_MS);
      router.release(account);
      handleStreamWithRetry(res, requestId, model, prompt, config, router, attempt + 1, userId);
      return;
    }

    if (!res.writableEnded) {
      res.write(
        `data: ${JSON.stringify({ error: { message: "Internal error", type: "server_error" } })}\n\n`
      );
      res.write("data: [DONE]\n\n");
      res.end();
    }
    router.release(account);
  });

  proc.on("close", (code: number) => {
    if (!gotResult) {
      // Non-zero exit without a result — retry
      if (code !== 0 && attempt < MAX_RETRIES - 1) {
        console.error(`[${requestId}] Process exited ${code} on ${account.account.name}, retrying...`);
        router.cooldown(account, EXIT_COOLDOWN_MS);
        router.release(account);
        handleStreamWithRetry(res, requestId, model, prompt, config, router, attempt + 1, userId);
        return;
      }

      if (code !== 0) router.cooldown(account, EXIT_COOLDOWN_MS);
      if (!res.writableEnded) {
        res.write("data: [DONE]\n\n");
        res.end();
      }
      router.release(account);
    }
  });

  proc.start(prompt, {
    oauthToken: account.account.oauthToken,
    configDir: account.account.configDir,
    model,
    timeoutMs: config.timeoutMs,
    signal: abort.signal,
  });
}

// --- Sync with retry ---

function handleSyncWithRetry(
  res: Response,
  requestId: string,
  model: string,
  prompt: string,
  config: Config,
  router: AccountRouter,
  attempt: number,
  userId?: string
): void {
  const account = router.acquire(userId);
  if (!account) {
    res.status(503).json({
      error: { message: "No accounts available", type: "server_error" },
    });
    return;
  }

  console.log(
    `[${requestId}] attempt=${attempt + 1} | account=${account.account.name}`
  );

  const proc = new ClaudeProcess();
  let fullText = "";
  let gotResult = false;

  proc.on("delta", (text: string) => {
    fullText += text;
  });

  proc.on("result", (result: CliResultMessage) => {
    gotResult = true;
    const resultText = result.result || "";

    // Check for retryable errors
    if (result.is_error && attempt < MAX_RETRIES - 1) {
      if (isAuthError(resultText)) {
        console.error(`[${requestId}] Auth error on ${account.account.name}, retrying...`);
        router.cooldown(account, AUTH_COOLDOWN_MS);
        router.release(account);
        handleSyncWithRetry(res, requestId, model, prompt, config, router, attempt + 1, userId);
        return;
      }
      if (isRateLimit(resultText)) {
        console.error(`[${requestId}] Rate limit on ${account.account.name}, retrying...`);
        router.cooldown(account, RATE_COOLDOWN_MS);
        router.release(account);
        handleSyncWithRetry(res, requestId, model, prompt, config, router, attempt + 1, userId);
        return;
      }
    }

    // Non-retryable or last attempt
    if (result.is_error) {
      if (isAuthError(resultText)) router.cooldown(account, AUTH_COOLDOWN_MS);
      else if (isRateLimit(resultText)) router.cooldown(account, RATE_COOLDOWN_MS);
      res.status(500).json({
        error: { message: "Claude request failed", type: "server_error" },
      });
    } else {
      res.json(completionResponse(requestId, model, result));
    }
    router.release(account);
  });

  proc.on("error", (err: Error) => {
    console.error(`[${requestId}] Error: ${err.message}`);

    if (attempt < MAX_RETRIES - 1) {
      router.cooldown(account, EXIT_COOLDOWN_MS);
      router.release(account);
      handleSyncWithRetry(res, requestId, model, prompt, config, router, attempt + 1, userId);
      return;
    }

    if (!res.headersSent) {
      res.status(500).json({
        error: { message: "Internal error", type: "server_error" },
      });
    }
    router.release(account);
  });

  proc.on("close", (code: number) => {
    if (!gotResult) {
      if (code !== 0 && attempt < MAX_RETRIES - 1) {
        console.error(`[${requestId}] Process exited ${code} on ${account.account.name}, retrying...`);
        router.cooldown(account, EXIT_COOLDOWN_MS);
        router.release(account);
        handleSyncWithRetry(res, requestId, model, prompt, config, router, attempt + 1, userId);
        return;
      }

      if (code !== 0) router.cooldown(account, EXIT_COOLDOWN_MS);
      if (!res.headersSent) {
        res.status(500).json({
          error: { message: `Process exited with code ${code}`, type: "server_error" },
        });
      }
      router.release(account);
    }
  });

  proc.start(prompt, {
    oauthToken: account.account.oauthToken,
    configDir: account.account.configDir,
    model,
    timeoutMs: config.timeoutMs,
  });
}
