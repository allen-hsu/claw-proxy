import express, { type Request, type Response } from "express";
import type { Config } from "./config.js";
import { AccountRouter, type AccountState } from "./router.js";
import { ClaudeProcess, type CliResultMessage } from "./subprocess.js";
import { SessionManager } from "./session.js";
import {
  type OpenAIRequest,
  type OpenAIMessage,
  type OpenAIToolDef,
  resolveModel,
  messagesToPrompt,
  extractNewMessages,
  makeRequestId,
  streamChunk,
  completionResponse,
  parseToolCalls,
} from "./adapter.js";

const MAX_RETRIES = 3;
const AUTH_COOLDOWN_MS = 300_000; // 5 minutes
const RATE_COOLDOWN_MS = 60_000;  // 1 minute (fallback)
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
  return lower.includes("rate_limit") || lower.includes("rate limit") || lower.includes("overloaded") || lower.includes("too many requests");
}

const SESSION_CLEANUP_INTERVAL_MS = 60_000;
const SESSION_MAX_AGE_MS = 30 * 60 * 1000; // 30 minutes

export function createServer(config: Config) {
  const app = express();
  const router = new AccountRouter(config.accounts);
  const sessions = new SessionManager();

  // Periodic session cleanup
  setInterval(() => {
    const result = sessions.cleanup(SESSION_MAX_AGE_MS);
    if (result.deleted > 0) {
      console.log(`[Sessions] Cleaned up ${result.deleted} expired sessions, ${result.remaining} remaining`);
    }
  }, SESSION_CLEANUP_INTERVAL_MS);

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

  // Health — requires auth to prevent info leak (account names, user IDs)
  app.get("/health", (req, res) => {
    if (config.bearerToken) {
      const auth = req.headers.authorization;
      if (auth !== `Bearer ${config.bearerToken}`) {
        res.json({ status: "ok", timestamp: new Date().toISOString() });
        return;
      }
    }
    res.json({
      status: "ok",
      accounts: router.status(),
      sessions: sessions.status(),
      timestamp: new Date().toISOString(),
    });
  });

  // Models
  app.get("/v1/models", (_req, res) => {
    res.json({
      object: "list",
      data: [
        { id: "claude-opus-4", object: "model", owned_by: "anthropic" },
        { id: "claude-opus-4-6", object: "model", owned_by: "anthropic" },
        { id: "claude-sonnet-4", object: "model", owned_by: "anthropic" },
        { id: "claude-sonnet-4-5", object: "model", owned_by: "anthropic" },
        { id: "claude-sonnet-4-6", object: "model", owned_by: "anthropic" },
        { id: "claude-haiku-4", object: "model", owned_by: "anthropic" },
        { id: "claude-haiku-4-5", object: "model", owned_by: "anthropic" },
      ],
    });
  });

  // Chat completions
  app.post("/v1/chat/completions", async (req: Request, res: Response) => {
    const body = req.body as OpenAIRequest;

    if (!body.messages?.length) {
      res.status(400).json({
        error: { message: "messages is required and must be non-empty", type: "invalid_request" },
      });
      return;
    }

    const requestId = makeRequestId();
    const model = resolveModel(body.model, config.defaultModel);
    const userId = body.user || req.ip || "default";

    console.log(
      `[${requestId}] ${body.stream ? "stream" : "sync"} | model=${model} | user=${userId} | messages=${body.messages.length}`
    );

    if (body.stream) {
      await handleStreamWithRetry(res, requestId, model, body.messages, body.tools, config, router, sessions, 0, userId);
    } else {
      await handleSyncWithRetry(res, requestId, model, body.messages, body.tools, config, router, sessions, 0, userId);
    }
  });

  // 404
  app.use((_req, res) => {
    res.status(404).json({ error: { message: "Not found", type: "not_found" } });
  });

  return app;
}

// --- Streaming with retry ---

async function handleStreamWithRetry(
  res: Response,
  requestId: string,
  model: string,
  messages: OpenAIMessage[],
  tools: OpenAIToolDef[] | undefined,
  config: Config,
  router: AccountRouter,
  sessions: SessionManager,
  attempt: number,
  userId: string
): Promise<void> {
  // 1. Acquire session lock first (may wait if session is busy)
  let handle = await sessions.acquireSession(userId);

  // 2. Now acquire account (after lock, so activeRequests is accurate)
  const maybeAccount = router.acquire(userId);
  if (!maybeAccount) {
    handle.release();
    if (!res.headersSent) {
      res.status(503).json({
        error: { message: "No accounts available", type: "server_error" },
      });
    }
    return;
  }
  const account = maybeAccount;

  // If account changed (e.g. after cooldown re-route), session can't be resumed
  const accountChanged = handle.session.accountName !== "" && handle.session.accountName !== account.account.name;
  if (accountChanged) {
    // Invalidate old session, create fresh one for this account
    sessions.invalidateSession(userId);
    handle = await sessions.acquireSession(userId);
  }
  handle.session.accountName = account.account.name;

  // Decide resume vs new
  const canResume = handle.isResume && !accountChanged && handle.session.lastMessageCount < messages.length;
  let prompt: string;
  let spawnSessionId: string | undefined;
  let spawnResumeId: string | undefined;

  if (canResume) {
    spawnResumeId = handle.session.sessionId;
    prompt = extractNewMessages(messages, handle.session.lastMessageCount);
    if (!prompt) {
      spawnResumeId = undefined;
      spawnSessionId = handle.session.sessionId;
      prompt = messagesToPrompt(messages, tools);
    }
    console.log(
      `[${requestId}] attempt=${attempt + 1} | account=${account.account.name} | RESUME session=${handle.session.sessionId.slice(0, 8)} | delta_len=${prompt.length}`
    );
  } else {
    spawnSessionId = handle.session.sessionId;
    prompt = messagesToPrompt(messages, tools);
    console.log(
      `[${requestId}] attempt=${attempt + 1} | account=${account.account.name} | NEW session=${handle.session.sessionId.slice(0, 8)} | prompt_len=${prompt.length}`
    );
  }

  // Only set headers on first attempt
  if (attempt === 0) {
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.flushHeaders();
  }

  const abort = new AbortController();
  const proc = new ClaudeProcess();
  let done = false;
  let fullText = "";
  let rateLimitResetsAt = 0;

  function cleanup() {
    if (done) return;
    done = true;
    handle.release();
    router.release(account);
  }

  // Client disconnect
  res.on("close", () => {
    abort.abort();
    proc.kill();
    sessions.invalidateSession(userId);
    cleanup();
  });

  proc.on("delta", (text: string) => {
    fullText += text;
  });

  proc.on("rate_limit", (info: { status: string; resetsAt?: number }) => {
    if (info.resetsAt) rateLimitResetsAt = info.resetsAt;
    if (info.status === "rejected") {
      const cooldownMs = rateLimitResetsAt
        ? Math.max(rateLimitResetsAt * 1000 - Date.now(), RATE_COOLDOWN_MS)
        : RATE_COOLDOWN_MS;
      console.log(`[${requestId}] Rate limit rejected on ${account.account.name}, cooldown ${Math.round(cooldownMs / 1000)}s`);
      router.cooldown(account, cooldownMs);
    }
  });

  proc.on("result", (result: CliResultMessage) => {
    const resultText = result.result || "";
    const rateCooldownMs = rateLimitResetsAt
      ? Math.max(rateLimitResetsAt * 1000 - Date.now(), RATE_COOLDOWN_MS)
      : RATE_COOLDOWN_MS;

    // Retryable errors
    if (result.is_error && attempt < MAX_RETRIES - 1) {
      if (isAuthError(resultText)) {
        console.error(`[${requestId}] Auth error on ${account.account.name}, retrying...`);
        sessions.invalidateSession(userId);
        router.cooldown(account, AUTH_COOLDOWN_MS);
        cleanup();
        handleStreamWithRetry(res, requestId, model, messages, tools, config, router, sessions, attempt + 1, userId).catch((err) => {
          console.error(`[${requestId}] Retry failed: ${err.message}`);
          if (!res.writableEnded) { res.write("data: [DONE]\n\n"); res.end(); }
        });
        return;
      }
      if (isRateLimit(resultText)) {
        console.error(`[${requestId}] Rate limit on ${account.account.name}, retrying...`);
        sessions.invalidateSession(userId);
        router.cooldown(account, rateCooldownMs);
        cleanup();
        handleStreamWithRetry(res, requestId, model, messages, tools, config, router, sessions, attempt + 1, userId).catch((err) => {
          console.error(`[${requestId}] Retry failed: ${err.message}`);
          if (!res.writableEnded) { res.write("data: [DONE]\n\n"); res.end(); }
        });
        return;
      }
    }

    if (result.is_error) {
      if (isAuthError(resultText)) router.cooldown(account, AUTH_COOLDOWN_MS);
      else if (isRateLimit(resultText)) router.cooldown(account, rateCooldownMs);
    }

    const responseText = fullText || resultText;
    const { cleanText, toolCalls } = parseToolCalls(responseText);

    if (!result.is_error) {
      sessions.updateSession(userId, toolCalls.map((tc) => tc.id), messages.length);
    }

    if (toolCalls.length > 0) {
      console.log(`[${requestId}] → tool_calls: [${toolCalls.map((tc) => tc.function.name).join(", ")}]`);
      if (cleanText) res.write(streamChunk(requestId, model, cleanText, null, true));
      res.write(streamChunk(requestId, model, null, null, !cleanText, toolCalls));
      res.write(streamChunk(requestId, model, null, "tool_calls"));
    } else {
      res.write(streamChunk(requestId, model, cleanText, null, true));
      res.write(streamChunk(requestId, model, null, "stop"));
    }

    res.write("data: [DONE]\n\n");
    res.end();
    cleanup();
  });

  proc.on("error", (err: Error) => {
    console.error(`[${requestId}] Error: ${err.message}`);
    if (attempt < MAX_RETRIES - 1) {
      sessions.invalidateSession(userId);
      router.cooldown(account, EXIT_COOLDOWN_MS);
      cleanup();
      handleStreamWithRetry(res, requestId, model, messages, tools, config, router, sessions, attempt + 1, userId).catch((err) => {
        console.error(`[${requestId}] Retry failed: ${err.message}`);
        if (!res.writableEnded) { res.write("data: [DONE]\n\n"); res.end(); }
      });
      return;
    }
    if (!res.writableEnded) {
      res.write(`data: ${JSON.stringify({ error: { message: "Internal error", type: "server_error" } })}\n\n`);
      res.write("data: [DONE]\n\n");
      res.end();
    }
    cleanup();
  });

  proc.on("close", (code: number) => {
    if (!done) {
      if (code !== 0 && attempt < MAX_RETRIES - 1) {
        console.error(`[${requestId}] Process exited ${code} on ${account.account.name}, retrying...`);
        sessions.invalidateSession(userId);
        router.cooldown(account, EXIT_COOLDOWN_MS);
        cleanup();
        handleStreamWithRetry(res, requestId, model, messages, tools, config, router, sessions, attempt + 1, userId).catch((err) => {
          console.error(`[${requestId}] Retry failed: ${err.message}`);
          if (!res.writableEnded) { res.write("data: [DONE]\n\n"); res.end(); }
        });
        return;
      }
      if (code !== 0) {
        sessions.invalidateSession(userId);
        router.cooldown(account, EXIT_COOLDOWN_MS);
      }
      if (!res.writableEnded) {
        res.write("data: [DONE]\n\n");
        res.end();
      }
      cleanup();
    }
  });

  proc.start(prompt, {
    oauthToken: account.account.oauthToken,
    configDir: account.account.configDir,
    model,
    timeoutMs: config.timeoutMs,
    signal: abort.signal,
    sessionId: spawnSessionId,
    resumeId: spawnResumeId,
  });
}

// --- Sync with retry ---

async function handleSyncWithRetry(
  res: Response,
  requestId: string,
  model: string,
  messages: OpenAIMessage[],
  tools: OpenAIToolDef[] | undefined,
  config: Config,
  router: AccountRouter,
  sessions: SessionManager,
  attempt: number,
  userId: string
): Promise<void> {
  let handle = await sessions.acquireSession(userId);

  const maybeAccount = router.acquire(userId);
  if (!maybeAccount) {
    handle.release();
    if (!res.headersSent) {
      res.status(503).json({
        error: { message: "No accounts available", type: "server_error" },
      });
    }
    return;
  }
  const account = maybeAccount;

  const accountChanged = handle.session.accountName !== "" && handle.session.accountName !== account.account.name;
  if (accountChanged) {
    sessions.invalidateSession(userId);
    handle = await sessions.acquireSession(userId);
  }
  handle.session.accountName = account.account.name;

  const canResume = handle.isResume && !accountChanged && handle.session.lastMessageCount < messages.length;
  let prompt: string;
  let spawnSessionId: string | undefined;
  let spawnResumeId: string | undefined;

  if (canResume) {
    spawnResumeId = handle.session.sessionId;
    prompt = extractNewMessages(messages, handle.session.lastMessageCount);
    if (!prompt) {
      spawnResumeId = undefined;
      spawnSessionId = handle.session.sessionId;
      prompt = messagesToPrompt(messages, tools);
    }
    console.log(
      `[${requestId}] attempt=${attempt + 1} | account=${account.account.name} | RESUME session=${handle.session.sessionId.slice(0, 8)} | delta_len=${prompt.length}`
    );
  } else {
    spawnSessionId = handle.session.sessionId;
    prompt = messagesToPrompt(messages, tools);
    console.log(
      `[${requestId}] attempt=${attempt + 1} | account=${account.account.name} | NEW session=${handle.session.sessionId.slice(0, 8)} | prompt_len=${prompt.length}`
    );
  }

  const abort = new AbortController();
  const proc = new ClaudeProcess();
  let done = false;
  let fullText = "";
  let rateLimitResetsAt = 0;

  function cleanup() {
    if (done) return;
    done = true;
    handle.release();
    router.release(account);
  }

  // Client disconnect
  res.on("close", () => {
    abort.abort();
    proc.kill();
    sessions.invalidateSession(userId);
    cleanup();
  });

  proc.on("delta", (text: string) => {
    fullText += text;
  });

  proc.on("rate_limit", (info: { status: string; resetsAt?: number }) => {
    if (info.resetsAt) rateLimitResetsAt = info.resetsAt;
    if (info.status === "rejected") {
      const cooldownMs = rateLimitResetsAt
        ? Math.max(rateLimitResetsAt * 1000 - Date.now(), RATE_COOLDOWN_MS)
        : RATE_COOLDOWN_MS;
      console.log(`[${requestId}] Rate limit rejected on ${account.account.name}, cooldown ${Math.round(cooldownMs / 1000)}s`);
      router.cooldown(account, cooldownMs);
    }
  });

  proc.on("result", (result: CliResultMessage) => {
    const resultText = result.result || "";
    const rateCooldownMs = rateLimitResetsAt
      ? Math.max(rateLimitResetsAt * 1000 - Date.now(), RATE_COOLDOWN_MS)
      : RATE_COOLDOWN_MS;

    if (result.is_error && attempt < MAX_RETRIES - 1) {
      if (isAuthError(resultText)) {
        console.error(`[${requestId}] Auth error on ${account.account.name}, retrying...`);
        sessions.invalidateSession(userId);
        router.cooldown(account, AUTH_COOLDOWN_MS);
        cleanup();
        handleSyncWithRetry(res, requestId, model, messages, tools, config, router, sessions, attempt + 1, userId).catch((err) => {
          console.error(`[${requestId}] Retry failed: ${err.message}`);
          if (!res.headersSent) { res.status(500).json({ error: { message: "Retry failed", type: "server_error" } }); }
        });
        return;
      }
      if (isRateLimit(resultText)) {
        console.error(`[${requestId}] Rate limit on ${account.account.name}, retrying...`);
        sessions.invalidateSession(userId);
        router.cooldown(account, rateCooldownMs);
        cleanup();
        handleSyncWithRetry(res, requestId, model, messages, tools, config, router, sessions, attempt + 1, userId).catch((err) => {
          console.error(`[${requestId}] Retry failed: ${err.message}`);
          if (!res.headersSent) { res.status(500).json({ error: { message: "Retry failed", type: "server_error" } }); }
        });
        return;
      }
    }

    if (result.is_error) {
      if (isAuthError(resultText)) router.cooldown(account, AUTH_COOLDOWN_MS);
      else if (isRateLimit(resultText)) router.cooldown(account, rateCooldownMs);
      if (!res.headersSent) {
        res.status(500).json({ error: { message: "Claude request failed", type: "server_error" } });
      }
    } else {
      const { toolCalls } = parseToolCalls(result.result ?? "");
      sessions.updateSession(userId, toolCalls.map((tc) => tc.id), messages.length);
      if (!res.headersSent) {
        res.json(completionResponse(requestId, model, result));
      }
    }
    cleanup();
  });

  proc.on("error", (err: Error) => {
    console.error(`[${requestId}] Error: ${err.message}`);
    if (attempt < MAX_RETRIES - 1) {
      sessions.invalidateSession(userId);
      router.cooldown(account, EXIT_COOLDOWN_MS);
      cleanup();
      handleSyncWithRetry(res, requestId, model, messages, tools, config, router, sessions, attempt + 1, userId).catch((err) => {
        console.error(`[${requestId}] Retry failed: ${err.message}`);
        if (!res.headersSent) { res.status(500).json({ error: { message: "Retry failed", type: "server_error" } }); }
      });
      return;
    }
    if (!res.headersSent) {
      res.status(500).json({ error: { message: "Internal error", type: "server_error" } });
    }
    cleanup();
  });

  proc.on("close", (code: number) => {
    if (!done) {
      if (code !== 0 && attempt < MAX_RETRIES - 1) {
        console.error(`[${requestId}] Process exited ${code} on ${account.account.name}, retrying...`);
        sessions.invalidateSession(userId);
        router.cooldown(account, EXIT_COOLDOWN_MS);
        cleanup();
        handleSyncWithRetry(res, requestId, model, messages, tools, config, router, sessions, attempt + 1, userId).catch((err) => {
          console.error(`[${requestId}] Retry failed: ${err.message}`);
          if (!res.headersSent) { res.status(500).json({ error: { message: "Retry failed", type: "server_error" } }); }
        });
        return;
      }
      if (code !== 0) {
        sessions.invalidateSession(userId);
        router.cooldown(account, EXIT_COOLDOWN_MS);
      }
      if (!res.headersSent) {
        res.status(500).json({ error: { message: `Process exited with code ${code}`, type: "server_error" } });
      }
      cleanup();
    }
  });

  proc.start(prompt, {
    oauthToken: account.account.oauthToken,
    configDir: account.account.configDir,
    model,
    timeoutMs: config.timeoutMs,
    signal: abort.signal,
    sessionId: spawnSessionId,
    resumeId: spawnResumeId,
  });
}
