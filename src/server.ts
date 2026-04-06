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
    const account = router.acquire();

    if (!account) {
      res.status(503).json({
        error: { message: "No accounts available", type: "server_error" },
      });
      return;
    }

    console.log(
      `[${requestId}] ${body.stream ? "stream" : "sync"} | model=${model} | account=${account.account.name} | messages=${body.messages.length} | prompt_len=${prompt.length}`
    );

    if (body.stream) {
      handleStream(res, requestId, model, prompt, account, config, router);
    } else {
      handleSync(res, requestId, model, prompt, account, config, router);
    }
  });

  // 404
  app.use((_req, res) => {
    res.status(404).json({ error: { message: "Not found", type: "not_found" } });
  });

  return app;
}

function handleStream(
  res: Response,
  requestId: string,
  model: string,
  prompt: string,
  account: AccountState,
  config: Config,
  router: AccountRouter
): void {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();

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

  // Collect full text — we need to parse tool_calls at the end
  proc.on("delta", (text: string) => {
    fullText += text;
  });

  proc.on("result", (result: CliResultMessage) => {
    gotResult = true;
    if (result.is_error) {
      if (result.result?.includes("rate") || result.result?.includes("limit")) {
        router.cooldown(account);
      }
    }

    // Use result text if we didn't collect deltas
    const responseText = fullText || result.result || "";
    const { cleanText, toolCalls } = parseToolCalls(responseText);

    if (toolCalls.length > 0) {
      console.log(
        `[${requestId}] → tool_calls: [${toolCalls.map((tc) => tc.function.name).join(", ")}]`
      );
      // Send text before tool calls if any
      if (cleanText) {
        res.write(streamChunk(requestId, model, cleanText, null, true));
      }
      // Send tool_calls
      res.write(
        streamChunk(requestId, model, null, null, !cleanText, toolCalls)
      );
      // Send finish with tool_calls reason
      res.write(streamChunk(requestId, model, null, "tool_calls"));
    } else {
      // Normal text response — send as single chunk
      res.write(streamChunk(requestId, model, cleanText, null, true));
      res.write(streamChunk(requestId, model, null, "stop"));
    }

    res.write("data: [DONE]\n\n");
    res.end();
    router.release(account);
  });

  proc.on("error", (err: Error) => {
    console.error(`[${requestId}] Error: ${err.message}`);
    if (!res.writableEnded) {
      res.write(
        `data: ${JSON.stringify({ error: { message: "Internal error", type: "server_error" } })}\n\n`
      );
    }
    res.write("data: [DONE]\n\n");
    res.end();
    router.release(account);
  });

  proc.on("close", (code: number) => {
    if (!gotResult) {
      if (code !== 0) {
        console.error(`[${requestId}] Process exited with code ${code}`);
        router.cooldown(account, 30_000);
      }
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

function handleSync(
  res: Response,
  requestId: string,
  model: string,
  prompt: string,
  account: AccountState,
  config: Config,
  router: AccountRouter
): void {
  const proc = new ClaudeProcess();
  let fullText = "";

  proc.on("delta", (text: string) => {
    fullText += text;
  });

  proc.on("result", (result: CliResultMessage) => {
    if (result.is_error) {
      if (result.result?.includes("rate") || result.result?.includes("limit")) {
        router.cooldown(account);
      }
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
    res.status(500).json({
      error: { message: "Internal error", type: "server_error" },
    });
    router.release(account);
  });

  proc.on("close", (code: number) => {
    if (code !== 0 && !res.headersSent) {
      router.cooldown(account, 30_000);
      res.status(500).json({
        error: { message: `Process exited with code ${code}`, type: "server_error" },
      });
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
