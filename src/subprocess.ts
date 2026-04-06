import { spawn, type ChildProcess } from "child_process";
import { EventEmitter } from "events";

export interface SpawnOptions {
  /** OAuth token from `claude setup-token` (preferred) */
  oauthToken?: string;
  /** Fallback: config dir with `claude auth login` credentials */
  configDir?: string;
  model: string;
  timeoutMs: number;
  signal?: AbortSignal;
  /** Create/use a named session (first request) */
  sessionId?: string;
  /** Resume an existing session (subsequent requests) */
  resumeId?: string;
  /** Use stream-json input format (required for image support) */
  streamJsonInput?: boolean;
}

export interface CliAssistantMessage {
  type: "assistant";
  message: {
    model: string;
    content: Array<{ type: string; text?: string }>;
    stop_reason: string | null;
    usage: {
      input_tokens: number;
      output_tokens: number;
      cache_creation_input_tokens?: number;
      cache_read_input_tokens?: number;
    };
  };
}

export interface CliResultMessage {
  type: "result";
  subtype: string;
  is_error: boolean;
  result: string;
  duration_ms: number;
  total_cost_usd: number;
  usage: {
    input_tokens: number;
    output_tokens: number;
  };
}

export interface CliStreamEvent {
  type: "stream_event";
  event: {
    type: string;
    delta?: { type: string; text: string };
  };
}

const VERBOSE = process.env.CLAW_PROXY_VERBOSE === "1" || process.env.DEBUG === "1";

/**
 * Spawns `claude -p` and emits parsed streaming events.
 *
 * Events:
 *   "delta"   — text chunk (string)
 *   "result"  — final CliResultMessage
 *   "error"   — Error
 *   "close"   — exit code
 */
export class ClaudeProcess extends EventEmitter {
  private proc: ChildProcess | null = null;
  private timer: NodeJS.Timeout | null = null;
  private killed = false;
  private buffer = "";

  start(prompt: string, options: SpawnOptions): void {
    const args: string[] = [];

    // Session management: --resume or --session-id
    if (options.resumeId) {
      args.push("--resume", options.resumeId);
    } else if (options.sessionId) {
      args.push("--session-id", options.sessionId);
    }

    args.push(
      "--print",
      "-",
      "--output-format",
      "stream-json",
      "--verbose",
      "--model",
      options.model,
      "--max-turns",
      "1",
      "--tools",
      "",
      "--mcp-config",
      '{"mcpServers":{}}',
      "--strict-mcp-config",
      "--system-prompt",
      "",
    );

    if (options.streamJsonInput) {
      args.push("--input-format", "stream-json");
    }

    const env: Record<string, string | undefined> = { ...process.env };

    // Prefer OAuth token (from `claude setup-token`), fall back to config dir
    if (options.oauthToken) {
      env.CLAUDE_CODE_OAUTH_TOKEN = options.oauthToken;
    } else if (options.configDir) {
      env.CLAUDE_CONFIG_DIR = options.configDir;
    }

    this.proc = spawn("claude", args, {
      env,
      stdio: ["pipe", "pipe", "pipe"],
    });

    // Suppress EPIPE if process dies before we finish writing
    this.proc.stdin!.on("error", () => {});

    // Feed prompt via stdin
    this.proc.stdin!.write(prompt);
    this.proc.stdin!.end();

    // Parse NDJSON from stdout
    this.proc.stdout!.on("data", (chunk: Buffer) => {
      this.resetTimeout(options.timeoutMs);
      const text = chunk.toString();
      if (VERBOSE) {
        console.log(`[Claude stdout] ${text.slice(0, 200)}${text.length > 200 ? "..." : ""}`);
      }
      this.buffer += text;
      this.parseBuffer();
    });

    this.proc.stderr!.on("data", (chunk: Buffer) => {
      const text = chunk.toString().trim();
      if (text) console.error(`[Claude stderr] ${text}`);
    });

    this.proc.on("error", (err) => {
      console.error(`[Claude] process error: ${err.message}`);
      this.cleanup();
      this.emit("error", err);
    });

    this.proc.on("close", (code) => {
      console.log(`[Claude] process closed with code ${code}`);
      this.cleanup();
      this.emit("close", code);
    });

    // Abort signal support (client disconnect)
    if (options.signal) {
      options.signal.addEventListener("abort", () => this.kill(), { once: true });
    }

    this.resetTimeout(options.timeoutMs);
  }

  kill(): void {
    if (this.killed) return;
    this.killed = true;
    this.cleanup();
    if (this.proc && !this.proc.killed) {
      this.proc.kill("SIGTERM");
    }
  }

  private resetTimeout(ms: number): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      console.error("[Claude] Process timed out");
      this.kill();
    }, ms);
  }

  private cleanup(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  private parseBuffer(): void {
    const lines = this.buffer.split("\n");
    // Keep the last incomplete line in buffer
    this.buffer = lines.pop() ?? "";

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      let parsed: any;
      try {
        parsed = JSON.parse(trimmed);
      } catch {
        continue; // skip non-JSON lines
      }

      if (parsed.type === "stream_event") {
        const delta = parsed.event?.delta;
        if (delta?.type === "text_delta" && delta.text) {
          this.emit("delta", delta.text);
        }
      } else if (parsed.type === "assistant") {
        // Don't emit delta here — text was already streamed via stream_event deltas
        this.emit("assistant", parsed as CliAssistantMessage);
      } else if (parsed.type === "rate_limit_event") {
        const info = parsed.rate_limit_info;
        if (info) {
          this.emit("rate_limit", info);
        }
      } else if (parsed.type === "result") {
        // Log usage details including cache stats
        const u = parsed.usage;
        if (u) {
          const cacheCreate = u.cache_creation_input_tokens ?? 0;
          const cacheRead = u.cache_read_input_tokens ?? 0;
          const input = u.input_tokens ?? 0;
          const output = u.output_tokens ?? 0;
          const cachePercent = input > 0 ? Math.round((cacheRead / (input + cacheRead + cacheCreate)) * 100) : 0;
          console.log(
            `[Claude usage] input=${input} output=${output} cache_create=${cacheCreate} cache_read=${cacheRead} (${cachePercent}% cached) duration=${parsed.duration_ms}ms`
          );
        }
        this.emit("result", parsed as CliResultMessage);
      }
    }
  }
}
