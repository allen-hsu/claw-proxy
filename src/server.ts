import { createHash } from "crypto";
import express, { type Request, type Response } from "express";
import type { Config } from "./config.js";
import { AccountRouter, type AccountState } from "./router.js";
import { ClaudeProcess, type CliAssistantMessage, type CliResultMessage } from "./subprocess.js";
import { SessionManager, type SessionEntry } from "./session.js";
import {
  type OpenAIRequest,
  type OpenAIMessage,
  type OpenAIToolDef,
  resolveModel,
  messagesToPrompt,
  buildResumePrompt,
  extractNewMessages,
  makeRequestId,
  streamChunk,
  completionResponse,
  parseToolCalls,
  parseStructuredToolCalls,
  snapshotMessages,
  isMessagePrefix,
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

export function isRateLimit(text: string): boolean {
  const lower = text.toLowerCase();
  return (
    lower.includes("rate_limit") ||
    lower.includes("rate limit") ||
    lower.includes("overloaded") ||
    lower.includes("too many requests") ||
    lower.includes("you've hit your limit") ||
    lower.includes("out of extra usage") ||
    lower.includes("usage limit") ||
    lower.includes("llm request rejected") ||
    (lower.includes("hit your limit") && lower.includes("resets"))
  );
}

function maxAttemptsFor(router: AccountRouter): number {
  return Math.max(MAX_RETRIES, router.status().length);
}

const SESSION_CLEANUP_INTERVAL_MS = 60_000;
const SESSION_MAX_AGE_MS = 30 * 60 * 1000; // 30 minutes
const SESSION_HEADER_CANDIDATES = [
  "x-openclaw-session-key",
  "x-session-id",
  "x-conversation-id",
  "x-thread-id",
  "openai-conversation-id",
] as const;

export interface SessionIdentityInfo {
  key: string;
  source: "user" | "header" | "metadata" | "fallback";
  detail: string;
}

function isTrustedLocalFallback(identity: SessionIdentityInfo): boolean {
  if (identity.source !== "fallback") return false;
  return (
    identity.key.startsWith("ip:127.0.0.1:") ||
    identity.key.startsWith("ip:::1:") ||
    identity.key.startsWith("ip:::ffff:127.0.0.1:")
  );
}

export function identityAllowsResume(identity: SessionIdentityInfo): boolean {
  return identity.source === "metadata" || isTrustedLocalFallback(identity);
}

export type ResumeDecisionReason =
  | "new_session"
  | "resumed"
  | "account_changed"
  | "empty_snapshot"
  | "prefix_mismatch"
  | "no_growth";

export type PrimaryKeyResumeMode = "resume" | "noop" | "rebuild" | "skip";

function firstTextBlock(msg: OpenAIMessage): string {
  if (typeof msg.content === "string") return msg.content;
  if (!Array.isArray(msg.content)) return "";
  return msg.content
    .filter((part) => part.type === "text" && part.text)
    .map((part) => part.text!)
    .join("\n");
}

function shortText(text: string, maxLen: number = 120): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxLen) return normalized;
  return `${normalized.slice(0, maxLen)}...`;
}

function snapshotTail(snapshot: SessionEntry["messageSnapshot"], count: number = 2): string {
  if (snapshot.length === 0) return "(empty)";
  return snapshot
    .slice(-count)
    .map((line) => shortText(line, 140))
    .join(" || ");
}

function messagesTail(messages: OpenAIMessage[], count: number = 2): string {
  if (messages.length === 0) return "(empty)";
  return messages
    .slice(-count)
    .map((msg) => `${msg.role}:${shortText(firstTextBlock(msg), 140)}`)
    .join(" || ");
}

function isEmptySessionEntry(session: SessionEntry): boolean {
  return session.lastMessageCount === 0 && session.messageSnapshot.length === 0;
}

function extractConversationMetadata(messages: OpenAIMessage[]): {
  conversationLabel?: string;
  senderId?: string;
  rawJson?: string;
} {
  const marker = "Conversation info (untrusted metadata):";

  for (const msg of messages) {
    if (msg.role !== "user") continue;
    const text = firstTextBlock(msg);
    const markerIndex = text.indexOf(marker);
    if (markerIndex === -1) continue;

    const jsonFenceStart = text.indexOf("```json", markerIndex);
    const jsonFenceEnd = jsonFenceStart === -1 ? -1 : text.indexOf("```", jsonFenceStart + 7);
    if (jsonFenceStart === -1 || jsonFenceEnd === -1) continue;

    const rawJson = text.slice(jsonFenceStart + 7, jsonFenceEnd).trim();
    try {
      const parsed = JSON.parse(rawJson) as Record<string, unknown>;
      const conversationLabel =
        typeof parsed.conversation_label === "string" && parsed.conversation_label.trim()
          ? parsed.conversation_label.trim()
          : undefined;
      const senderId =
        typeof parsed.sender_id === "string" && parsed.sender_id.trim()
          ? parsed.sender_id.trim()
          : typeof parsed.sender_id === "number"
            ? String(parsed.sender_id)
            : undefined;
      return { conversationLabel, senderId, rawJson };
    } catch {
      return { rawJson };
    }
  }

  return {};
}

function extractAgentName(messages: OpenAIMessage[]): string | undefined {
  const namePatterns = [
    /\*\*Name:\*\*\s*([^\n]+)/i,
    /^Name:\s*([^\n]+)/im,
  ];

  for (const msg of messages) {
    if (msg.role !== "system" && msg.role !== "developer") continue;
    const text = firstTextBlock(msg);
    for (const pattern of namePatterns) {
      const match = text.match(pattern);
      if (match?.[1]?.trim()) {
        return match[1].trim();
      }
    }
  }

  return undefined;
}

function makeConversationFingerprint(messages: OpenAIMessage[]): { fingerprint: string; seedParts: string[] } {
  const seedParts: string[] = [];

  for (const msg of messages) {
    if (msg.role === "tool") continue;
    const text = firstTextBlock(msg).trim();
    if (!text) continue;
    seedParts.push(`${msg.role}:${text.slice(0, 500)}`);
    if (seedParts.length >= 3) break;
  }

  const seed = seedParts.join("\n---\n");
  if (!seed) return { fingerprint: "anonymous", seedParts };

  return {
    fingerprint: createHash("sha1").update(seed).digest("hex").slice(0, 16),
    seedParts,
  };
}

export function inspectSessionIdentity(req: Request, body: OpenAIRequest): SessionIdentityInfo {
  const incomingHeaders = Object.fromEntries(
    SESSION_HEADER_CANDIDATES.map((header) => [header, req.header(header)?.trim() || ""])
  );
  const explicitUser = typeof body.user === "string" ? body.user.trim() : "";
  console.log(
    `[Identity] ip=${req.ip || "unknown"} | user=${explicitUser || "(empty)"} | headers=${JSON.stringify(incomingHeaders)}`
  );

  const { fingerprint, seedParts } = makeConversationFingerprint(body.messages ?? []);
  console.log(
    `[Fingerprint] messages=${body.messages?.length ?? 0} | seed_parts=${seedParts.length} | seed=${JSON.stringify(seedParts.map((part) => shortText(part, 180)))} | fingerprint=${fingerprint}`
  );

  const metadata = extractConversationMetadata(body.messages ?? []);
  const agentName = extractAgentName(body.messages ?? []);
  if (metadata.rawJson) {
    console.log(
      `[Metadata] conversation_label=${metadata.conversationLabel || "(empty)"} | sender_id=${metadata.senderId || "(empty)"} | agent=${agentName || "(empty)"}`
    );
  }

  if (metadata.conversationLabel) {
    const resolvedAgent = agentName || "unknown";
    const identity: SessionIdentityInfo = {
      key: `meta:${metadata.conversationLabel}::agent:${resolvedAgent}`,
      source: "metadata",
      detail: `conversation_label=${metadata.conversationLabel} agent=${resolvedAgent}`,
    };
    console.log(
      `[IdentitySelected] source=${identity.source} | key=${identity.key} | detail=${identity.detail}`
    );
    return identity;
  }

  const ip = req.ip || "unknown";
  const identity: SessionIdentityInfo = {
    key: `ip:${ip}:fp:${fingerprint}`,
    source: "fallback",
    detail: `ip=${ip} fingerprint=${fingerprint}`,
  };
  console.log(
    `[IdentitySelected] source=${identity.source} | key=${identity.key} | detail=${identity.detail}`
  );
  return identity;
}

export function resolveSessionKey(req: Request, body: OpenAIRequest): string {
  return inspectSessionIdentity(req, body).key;
}

export function getResumeDecision(
  session: SessionEntry,
  messages: OpenAIMessage[],
  accountChanged: boolean,
  isResume: boolean
): ResumeDecisionReason {
  if (!isResume) return "new_session";
  if (accountChanged) return "account_changed";
  if (session.messageSnapshot.length === 0) return "empty_snapshot";
  if (!isMessagePrefix(session.messageSnapshot, messages)) return "prefix_mismatch";
  if (session.messageSnapshot.length >= messages.length) return "no_growth";
  return "resumed";
}

export function getPrimaryKeyResumeMode(
  session: SessionEntry,
  messages: OpenAIMessage[],
  identitySource: SessionIdentityInfo["source"],
  accountChanged: boolean,
  isResume: boolean
): { mode: PrimaryKeyResumeMode; prompt: string | null } {
  if (identitySource !== "metadata" || !isResume || accountChanged || session.lastMessageCount === 0) {
    return { mode: "skip", prompt: null };
  }
  if (messages.length > session.lastMessageCount) {
    const prompt = extractNewMessages(messages, session.lastMessageCount);
    return { mode: prompt ? "resume" : "skip", prompt: prompt || null };
  }
  if (messages.length === session.lastMessageCount) {
    return { mode: "noop", prompt: null };
  }
  return { mode: "rebuild", prompt: null };
}

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
    console.log(
      `[RequestIn] method=${req.method} | path=${req.path} | ip=${req.ip || "unknown"} | stream=${Boolean(body?.stream)} | model=${typeof body?.model === "string" ? body.model : "(missing)"} | messages=${Array.isArray(body?.messages) ? body.messages.length : 0} | tools=${Array.isArray(body?.tools) ? body.tools.length : 0}`
    );

    if (!body.messages?.length) {
      console.log("[RequestReject] reason=missing_messages");
      res.status(400).json({
        error: { message: "messages is required and must be non-empty", type: "invalid_request" },
      });
      return;
    }

    const requestId = makeRequestId();
    const model = resolveModel(body.model, config.defaultModel);
    const identity = inspectSessionIdentity(req, body);
    const userId = identity.key;
    const allowResume = identityAllowsResume(identity);

    console.log(
      `[${requestId}] ${body.stream ? "stream" : "sync"} | model=${model} | sessionKey=${userId} | identity=${identity.source}:${identity.detail} | resume=${allowResume ? "on" : "off"} | messages=${body.messages.length}`
    );
    console.log(
      `[${requestId}] identity_debug | ip=${req.ip || "unknown"} | body.user=${typeof body.user === "string" && body.user.trim() ? body.user.trim() : "(empty)"} | headers=${JSON.stringify(
        Object.fromEntries(
          SESSION_HEADER_CANDIDATES.map((header) => [header, req.header(header)?.trim() || ""])
        )
      )}`
    );

    if (body.stream) {
      await handleStreamWithRetry(
        res,
        requestId,
        model,
        body.messages,
        body.tools,
        config,
        router,
        sessions,
        0,
        userId,
        allowResume,
        identity.source
      );
    } else {
      await handleSyncWithRetry(
        res,
        requestId,
        model,
        body.messages,
        body.tools,
        config,
        router,
        sessions,
        0,
        userId,
        allowResume,
        identity.source
      );
    }
  });

  // 404
  app.use((_req, res) => {
    res.status(404).json({ error: { message: "Not found", type: "not_found" } });
  });

  return app;
}

export function beginSse(res: Response): void {
  if (res.headersSent) return;
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();
}

export function sendAccountUnavailableResponse(
  res: Response,
  router: AccountRouter,
  stream: boolean
): void {
  const unavailable = router.unavailableInfo();

  if (unavailable.reason === "cooldown") {
    const retryAfterSeconds = Math.max(1, Math.ceil(unavailable.retryAfterMs / 1000));
    const payload = {
      error: {
        message: "All Claude accounts are temporarily rate-limited. Please retry later.",
        type: "all_accounts_rate_limited",
      },
      retry_after_seconds: retryAfterSeconds,
    };

    if (!res.headersSent) {
      res.setHeader("Retry-After", String(retryAfterSeconds));
    }

    if (stream) {
      beginSse(res);
      res.write(`data: ${JSON.stringify(payload)}\n\n`);
      res.write("data: [DONE]\n\n");
      res.end();
      return;
    }

    res.status(429).json(payload);
    return;
  }

  const payload = {
    error: {
      message: "No Claude accounts are configured or available.",
      type: "server_error",
    },
  };

  if (stream) {
    beginSse(res);
    res.write(`data: ${JSON.stringify(payload)}\n\n`);
    res.write("data: [DONE]\n\n");
    res.end();
    return;
  }

  res.status(503).json(payload);
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
  userId: string,
  allowResume: boolean,
  identitySource: SessionIdentityInfo["source"]
): Promise<void> {
  const maxAttempts = maxAttemptsFor(router);
  // 1. Acquire session lock first (may wait if session is busy)
  let handle = await sessions.acquireSession(userId);

  // 2. Now acquire account (after lock, so activeRequests is accurate)
  const maybeAccount = router.acquire(userId);
  if (!maybeAccount) {
    const shouldInvalidateEmptySession = isEmptySessionEntry(handle.session);
    handle.release();
    if (shouldInvalidateEmptySession) {
      console.log(`[${requestId}] dropping_empty_session_on_unavailable key=${userId} session=${handle.session.sessionId.slice(0, 8)}`);
      sessions.invalidateSession(userId);
    }
    console.log(`[${requestId}] account_unavailable stream=yes key=${userId}`);
    sendAccountUnavailableResponse(res, router, true);
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
  sessions.updateMetadata(userId, { identitySource, allowResume });

  // Decide resume vs new
  const primaryKeyResume = getPrimaryKeyResumeMode(
    handle.session,
    messages,
    identitySource,
    accountChanged,
    allowResume && handle.isResume
  );
  const resumeDecision = getResumeDecision(
    handle.session,
    messages,
    accountChanged,
    allowResume && handle.isResume
  );
  console.log(
    `[${requestId}] resume_check | is_resume_candidate=${allowResume && handle.isResume ? "yes" : "no"} | account_changed=${accountChanged} | prev_snapshot_len=${handle.session.messageSnapshot.length} | incoming_messages_len=${messages.length} | prefix_match=${isMessagePrefix(handle.session.messageSnapshot, messages)} | primary_mode=${primaryKeyResume.mode} | snapshot_tail=${snapshotTail(handle.session.messageSnapshot)} | incoming_tail=${messagesTail(messages)}`
  );
  const resumePrompt = primaryKeyResume.mode === "resume"
    ? primaryKeyResume.prompt
    : resumeDecision === "resumed"
      ? buildResumePrompt(messages, handle.session.messageSnapshot)
      : null;
  const canResume = resumePrompt !== null;
  let prompt: string;
  let spawnSessionId: string | undefined;
  let spawnResumeId: string | undefined;

  if (primaryKeyResume.mode === "noop") {
    console.log(`[${requestId}] attempt=${attempt + 1} | account=${account.account.name} | NOOP same_primary_key`);
    cleanup();
    beginSse(res);
    res.write(streamChunk(requestId, model, "", "stop", true));
    res.write("data: [DONE]\n\n");
    res.end();
    return;
  }

  if (canResume) {
    spawnResumeId = handle.session.sessionId;
    prompt = resumePrompt;
    console.log(
      `[${requestId}] attempt=${attempt + 1} | account=${account.account.name} | RESUME session=${handle.session.sessionId.slice(0, 8)} | delta_len=${prompt.length}`
    );
  } else {
    if (handle.isResume) {
      console.log(
        `[${requestId}] attempt=${attempt + 1} | account=${account.account.name} | resume_rejected=${resumeDecision} | prev_messages=${handle.session.messageSnapshot.length} | messages=${messages.length}`
      );
    }
    // Session was used before but can't resume — create fresh session ID
    if (
      (identitySource === "metadata" && primaryKeyResume.mode === "rebuild" && handle.session.lastMessageCount > 0) ||
      (identitySource !== "metadata" && handle.session.lastMessageCount > 0)
    ) {
      sessions.invalidateSession(userId);
      handle = await sessions.acquireSession(userId);
      handle.session.accountName = account.account.name;
      sessions.updateMetadata(userId, { identitySource, allowResume });
    }
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
  let structuredToolCalls: ReturnType<typeof parseStructuredToolCalls> = [];
  let rateLimitResetsAt = 0;
  let sessionCollision = false;

  function cleanup() {
    if (done) return;
    done = true;
    handle.release();
    router.release(account);
  }

  // Client disconnect — only invalidate if we didn't finish normally
  // (res.end() also fires "close", but cleanup() will have set done=true by then)
  res.on("close", () => {
    if (!done) {
      // Premature disconnect — kill process and invalidate session
      abort.abort();
      proc.kill();
      sessions.invalidateSession(userId);
      cleanup();
    }
  });

  proc.on("delta", (text: string) => {
    fullText += text;
  });

  // Capture filtered text from assistant message (thinking blocks already removed in subprocess)
  proc.on("assistant", (msg: CliAssistantMessage) => {
    structuredToolCalls = parseStructuredToolCalls(msg.message?.content as any);
    if (!fullText && Array.isArray(msg.message?.content)) {
      fullText = msg.message.content
        .filter((b) => b.type === "text" && b.text)
        .map((b) => b.text!)
        .join("\n");
    }
  });

  proc.on("session_collision", () => {
    sessionCollision = true;
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
    const responseText = fullText || resultText;
    const rateLimited = isRateLimit(responseText);

    // Retryable errors
    if (result.is_error && attempt < maxAttempts - 1) {
      if (isAuthError(resultText)) {
        console.error(`[${requestId}] Auth error on ${account.account.name}, retrying attempt=${attempt + 2}/${maxAttempts}...`);
        sessions.invalidateSession(userId);
        router.cooldown(account, AUTH_COOLDOWN_MS);
        cleanup();
        handleStreamWithRetry(res, requestId, model, messages, tools, config, router, sessions, attempt + 1, userId, allowResume, identitySource).catch((err) => {
          console.error(`[${requestId}] Retry failed: ${err.message}`);
          if (!res.writableEnded) { beginSse(res); res.write("data: [DONE]\n\n"); res.end(); }
        });
        return;
      }
      if (isRateLimit(resultText)) {
        console.error(`[${requestId}] Rate limit on ${account.account.name}, retrying attempt=${attempt + 2}/${maxAttempts}...`);
        sessions.invalidateSession(userId);
        router.cooldown(account, rateCooldownMs);
        cleanup();
        handleStreamWithRetry(res, requestId, model, messages, tools, config, router, sessions, attempt + 1, userId, allowResume, identitySource).catch((err) => {
          console.error(`[${requestId}] Retry failed: ${err.message}`);
          if (!res.writableEnded) { beginSse(res); res.write("data: [DONE]\n\n"); res.end(); }
        });
        return;
      }
    }

    // Claude can sometimes surface usage-cap/rate-limit text without marking
    // the final result as an error. Treat that as retryable too so the current
    // request moves to the next account instead of returning the raw rejection.
    if (rateLimited && attempt < maxAttempts - 1) {
      console.error(`[${requestId}] Rate limit text on ${account.account.name}, retrying attempt=${attempt + 2}/${maxAttempts}...`);
      sessions.invalidateSession(userId);
      router.cooldown(account, rateCooldownMs);
      cleanup();
      handleStreamWithRetry(
        res,
        requestId,
        model,
        messages,
        tools,
        config,
        router,
        sessions,
        attempt + 1,
        userId,
        allowResume,
        identitySource
      ).catch((err) => {
        console.error(`[${requestId}] Retry failed: ${err.message}`);
        if (!res.writableEnded) { beginSse(res); res.write("data: [DONE]\n\n"); res.end(); }
      });
      return;
    }

    if (rateLimited) {
      console.error(`[${requestId}] Rate limit text on ${account.account.name}, no retries left (attempt=${attempt + 1}/${maxAttempts})`);
    }

    if (result.is_error) {
      if (isAuthError(resultText)) router.cooldown(account, AUTH_COOLDOWN_MS);
      else if (rateLimited) router.cooldown(account, rateCooldownMs);
    }
    const parsed = parseToolCalls(responseText);
    const toolCalls = parsed.toolCalls.length > 0 ? parsed.toolCalls : structuredToolCalls;
    const cleanText = parsed.cleanText;

    if (!result.is_error) {
      sessions.updateSession(
        userId,
        toolCalls.map((tc) => tc.id),
        messages.length,
        snapshotMessages(messages)
      );
    }

    if (toolCalls.length > 0) {
      beginSse(res);
      console.log(`[${requestId}] → tool_calls: [${toolCalls.map((tc) => tc.function.name).join(", ")}]`);
      if (cleanText) res.write(streamChunk(requestId, model, cleanText, null, true));
      res.write(streamChunk(requestId, model, null, null, !cleanText, toolCalls));
      res.write(streamChunk(requestId, model, null, "tool_calls"));
    } else {
      beginSse(res);
      res.write(streamChunk(requestId, model, cleanText, null, true));
      res.write(streamChunk(requestId, model, null, "stop"));
    }

    cleanup();  // Mark done BEFORE res.end() to prevent close handler from invalidating session
    res.write("data: [DONE]\n\n");
    res.end();
  });

  proc.on("error", (err: Error) => {
    console.error(`[${requestId}] Error: ${err.message}`);
    if (attempt < maxAttempts - 1) {
      sessions.invalidateSession(userId);
      router.cooldown(account, EXIT_COOLDOWN_MS);
      cleanup();
      handleStreamWithRetry(res, requestId, model, messages, tools, config, router, sessions, attempt + 1, userId, allowResume, identitySource).catch((err) => {
        console.error(`[${requestId}] Retry failed: ${err.message}`);
        if (!res.writableEnded) { beginSse(res); res.write("data: [DONE]\n\n"); res.end(); }
      });
      return;
    }
    console.error(`[${requestId}] Error with no retries left (attempt=${attempt + 1}/${maxAttempts})`);
    cleanup();
    if (!res.writableEnded) {
      beginSse(res);
      res.write(`data: ${JSON.stringify({ error: { message: "Internal error", type: "server_error" } })}\n\n`);
      res.write("data: [DONE]\n\n");
      res.end();
    }
  });

  proc.on("close", (code: number) => {
    if (!done) {
      if (code !== 0 && attempt < maxAttempts - 1) {
        sessions.invalidateSession(userId);
        if (sessionCollision) {
          // Session collision is not an account health issue — retry without cooldown
          console.error(`[${requestId}] Session collision on ${account.account.name}, retrying attempt=${attempt + 2}/${maxAttempts} with fresh session...`);
        } else {
          console.error(`[${requestId}] Process exited ${code} on ${account.account.name}, retrying attempt=${attempt + 2}/${maxAttempts}...`);
          router.cooldown(account, EXIT_COOLDOWN_MS);
        }
        cleanup();
        handleStreamWithRetry(res, requestId, model, messages, tools, config, router, sessions, attempt + 1, userId, allowResume, identitySource).catch((err) => {
          console.error(`[${requestId}] Retry failed: ${err.message}`);
          if (!res.writableEnded) { beginSse(res); res.write("data: [DONE]\n\n"); res.end(); }
        });
        return;
      }
      if (code !== 0) {
        console.error(`[${requestId}] Process exited ${code} on ${account.account.name}, no retries left (attempt=${attempt + 1}/${maxAttempts})`);
        sessions.invalidateSession(userId);
        if (!sessionCollision) router.cooldown(account, EXIT_COOLDOWN_MS);
      }
      cleanup();
      if (!res.writableEnded) {
        beginSse(res);
        res.write("data: [DONE]\n\n");
        res.end();
      }
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
  userId: string,
  allowResume: boolean,
  identitySource: SessionIdentityInfo["source"]
): Promise<void> {
  const maxAttempts = maxAttemptsFor(router);
  let handle = await sessions.acquireSession(userId);

  const maybeAccount = router.acquire(userId);
  if (!maybeAccount) {
    const shouldInvalidateEmptySession = isEmptySessionEntry(handle.session);
    handle.release();
    if (shouldInvalidateEmptySession) {
      console.log(`[${requestId}] dropping_empty_session_on_unavailable key=${userId} session=${handle.session.sessionId.slice(0, 8)}`);
      sessions.invalidateSession(userId);
    }
    console.log(`[${requestId}] account_unavailable stream=no key=${userId}`);
    sendAccountUnavailableResponse(res, router, false);
    return;
  }
  const account = maybeAccount;

  const accountChanged = handle.session.accountName !== "" && handle.session.accountName !== account.account.name;
  if (accountChanged) {
    sessions.invalidateSession(userId);
    handle = await sessions.acquireSession(userId);
  }
  handle.session.accountName = account.account.name;
  sessions.updateMetadata(userId, { identitySource, allowResume });

  const resumeDecision = getResumeDecision(
    handle.session,
    messages,
    accountChanged,
    allowResume && handle.isResume
  );
  const primaryKeyResume = getPrimaryKeyResumeMode(
    handle.session,
    messages,
    identitySource,
    accountChanged,
    allowResume && handle.isResume
  );
  console.log(
    `[${requestId}] resume_check | is_resume_candidate=${allowResume && handle.isResume ? "yes" : "no"} | account_changed=${accountChanged} | prev_snapshot_len=${handle.session.messageSnapshot.length} | incoming_messages_len=${messages.length} | prefix_match=${isMessagePrefix(handle.session.messageSnapshot, messages)} | primary_mode=${primaryKeyResume.mode} | snapshot_tail=${snapshotTail(handle.session.messageSnapshot)} | incoming_tail=${messagesTail(messages)}`
  );
  const resumePrompt = primaryKeyResume.mode === "resume"
    ? primaryKeyResume.prompt
    : resumeDecision === "resumed"
      ? buildResumePrompt(messages, handle.session.messageSnapshot)
      : null;
  const canResume = resumePrompt !== null;
  let prompt: string;
  let spawnSessionId: string | undefined;
  let spawnResumeId: string | undefined;

  if (primaryKeyResume.mode === "noop") {
    console.log(`[${requestId}] attempt=${attempt + 1} | account=${account.account.name} | NOOP same_primary_key`);
    cleanup();
    if (!res.headersSent) {
      res.json(
        completionResponse(requestId, model, {
          type: "result",
          subtype: "noop",
          is_error: false,
          result: "",
          duration_ms: 0,
          total_cost_usd: 0,
          usage: { input_tokens: 0, output_tokens: 0 },
        })
      );
    }
    return;
  }

  if (canResume) {
    spawnResumeId = handle.session.sessionId;
    prompt = resumePrompt;
    console.log(
      `[${requestId}] attempt=${attempt + 1} | account=${account.account.name} | RESUME session=${handle.session.sessionId.slice(0, 8)} | delta_len=${prompt.length}`
    );
  } else {
    if (handle.isResume) {
      console.log(
        `[${requestId}] attempt=${attempt + 1} | account=${account.account.name} | resume_rejected=${resumeDecision} | prev_messages=${handle.session.messageSnapshot.length} | messages=${messages.length}`
      );
    }
    // Session was used before but can't resume — create fresh session ID
    if (
      (identitySource === "metadata" && primaryKeyResume.mode === "rebuild" && handle.session.lastMessageCount > 0) ||
      (identitySource !== "metadata" && handle.session.lastMessageCount > 0)
    ) {
      sessions.invalidateSession(userId);
      handle = await sessions.acquireSession(userId);
      handle.session.accountName = account.account.name;
      sessions.updateMetadata(userId, { identitySource, allowResume });
    }
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
  let structuredToolCalls: ReturnType<typeof parseStructuredToolCalls> = [];
  let rateLimitResetsAt = 0;
  let sessionCollision = false;

  function cleanup() {
    if (done) return;
    done = true;
    handle.release();
    router.release(account);
  }

  // Client disconnect — only invalidate if we didn't finish normally
  // (res.end() also fires "close", but cleanup() will have set done=true by then)
  res.on("close", () => {
    if (!done) {
      // Premature disconnect — kill process and invalidate session
      abort.abort();
      proc.kill();
      sessions.invalidateSession(userId);
      cleanup();
    }
  });

  proc.on("delta", (text: string) => {
    fullText += text;
  });

  // Capture filtered text from assistant message (thinking blocks already removed in subprocess)
  proc.on("assistant", (msg: CliAssistantMessage) => {
    structuredToolCalls = parseStructuredToolCalls(msg.message?.content as any);
    if (!fullText && Array.isArray(msg.message?.content)) {
      fullText = msg.message.content
        .filter((b) => b.type === "text" && b.text)
        .map((b) => b.text!)
        .join("\n");
    }
  });

  proc.on("session_collision", () => {
    sessionCollision = true;
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
    const responseText = fullText || resultText;
    const rateLimited = isRateLimit(responseText);

    if (result.is_error && attempt < maxAttempts - 1) {
      if (isAuthError(resultText)) {
        console.error(`[${requestId}] Auth error on ${account.account.name}, retrying attempt=${attempt + 2}/${maxAttempts}...`);
        sessions.invalidateSession(userId);
        router.cooldown(account, AUTH_COOLDOWN_MS);
        cleanup();
        handleSyncWithRetry(res, requestId, model, messages, tools, config, router, sessions, attempt + 1, userId, allowResume, identitySource).catch((err) => {
          console.error(`[${requestId}] Retry failed: ${err.message}`);
          if (!res.headersSent) { res.status(500).json({ error: { message: "Retry failed", type: "server_error" } }); }
        });
        return;
      }
      if (isRateLimit(resultText)) {
        console.error(`[${requestId}] Rate limit on ${account.account.name}, retrying attempt=${attempt + 2}/${maxAttempts}...`);
        sessions.invalidateSession(userId);
        router.cooldown(account, rateCooldownMs);
        cleanup();
        handleSyncWithRetry(res, requestId, model, messages, tools, config, router, sessions, attempt + 1, userId, allowResume, identitySource).catch((err) => {
          console.error(`[${requestId}] Retry failed: ${err.message}`);
          if (!res.headersSent) { res.status(500).json({ error: { message: "Retry failed", type: "server_error" } }); }
        });
        return;
      }
    }

    if (rateLimited && attempt < maxAttempts - 1) {
      console.error(`[${requestId}] Rate limit text on ${account.account.name}, retrying attempt=${attempt + 2}/${maxAttempts}...`);
      sessions.invalidateSession(userId);
      router.cooldown(account, rateCooldownMs);
      cleanup();
      handleSyncWithRetry(
        res,
        requestId,
        model,
        messages,
        tools,
        config,
        router,
        sessions,
        attempt + 1,
        userId,
        allowResume,
        identitySource
      ).catch((err) => {
        console.error(`[${requestId}] Retry failed: ${err.message}`);
        if (!res.headersSent) { res.status(500).json({ error: { message: "Retry failed", type: "server_error" } }); }
      });
      return;
    }

    if (rateLimited) {
      console.error(`[${requestId}] Rate limit text on ${account.account.name}, no retries left (attempt=${attempt + 1}/${maxAttempts})`);
    }

    if (result.is_error) {
      if (isAuthError(resultText)) router.cooldown(account, AUTH_COOLDOWN_MS);
      else if (rateLimited) router.cooldown(account, rateCooldownMs);
    } else {
      // Prefer filtered text (thinking stripped) over result.result
      if (fullText) result.result = fullText;
      const parsed = parseToolCalls(result.result ?? "");
      const toolCalls = parsed.toolCalls.length > 0 ? parsed.toolCalls : structuredToolCalls;
      sessions.updateSession(
        userId,
        toolCalls.map((tc) => tc.id),
        messages.length,
        snapshotMessages(messages)
      );
    }
    cleanup();  // Mark done BEFORE sending response to prevent close handler from invalidating session
    if (result.is_error) {
      if (!res.headersSent) {
        res.status(500).json({ error: { message: "Claude request failed", type: "server_error" } });
      }
    } else {
      if (!res.headersSent) {
        res.json(completionResponse(requestId, model, result));
      }
    }
  });

  proc.on("error", (err: Error) => {
    console.error(`[${requestId}] Error: ${err.message}`);
    if (attempt < maxAttempts - 1) {
      sessions.invalidateSession(userId);
      router.cooldown(account, EXIT_COOLDOWN_MS);
      cleanup();
      handleSyncWithRetry(res, requestId, model, messages, tools, config, router, sessions, attempt + 1, userId, allowResume, identitySource).catch((err) => {
        console.error(`[${requestId}] Retry failed: ${err.message}`);
        if (!res.headersSent) { res.status(500).json({ error: { message: "Retry failed", type: "server_error" } }); }
      });
      return;
    }
    console.error(`[${requestId}] Error with no retries left (attempt=${attempt + 1}/${maxAttempts})`);
    cleanup();
    if (!res.headersSent) {
      res.status(500).json({ error: { message: "Internal error", type: "server_error" } });
    }
  });

  proc.on("close", (code: number) => {
    if (!done) {
      if (code !== 0 && attempt < maxAttempts - 1) {
        sessions.invalidateSession(userId);
        if (sessionCollision) {
          console.error(`[${requestId}] Session collision on ${account.account.name}, retrying attempt=${attempt + 2}/${maxAttempts} with fresh session...`);
        } else {
          console.error(`[${requestId}] Process exited ${code} on ${account.account.name}, retrying attempt=${attempt + 2}/${maxAttempts}...`);
          router.cooldown(account, EXIT_COOLDOWN_MS);
        }
        cleanup();
        handleSyncWithRetry(res, requestId, model, messages, tools, config, router, sessions, attempt + 1, userId, allowResume, identitySource).catch((err) => {
          console.error(`[${requestId}] Retry failed: ${err.message}`);
          if (!res.headersSent) { res.status(500).json({ error: { message: "Retry failed", type: "server_error" } }); }
        });
        return;
      }
      if (code !== 0) {
        console.error(`[${requestId}] Process exited ${code} on ${account.account.name}, no retries left (attempt=${attempt + 1}/${maxAttempts})`);
        sessions.invalidateSession(userId);
        if (!sessionCollision) router.cooldown(account, EXIT_COOLDOWN_MS);
      }
      cleanup();
      if (!res.headersSent) {
        res.status(500).json({ error: { message: `Process exited with code ${code}`, type: "server_error" } });
      }
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
