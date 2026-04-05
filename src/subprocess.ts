import { spawn, type ChildProcess } from "child_process";
import { EventEmitter } from "events";

export interface SpawnOptions {
  configDir: string;
  model: string;
  timeoutMs: number;
  signal?: AbortSignal;
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
    const args = [
      "--print",
      "-",
      "--output-format",
      "stream-json",
      "--verbose",
      "--model",
      options.model,
      "--max-turns",
      "1",
    ];

    this.proc = spawn("claude", args, {
      env: {
        ...process.env,
        CLAUDE_CONFIG_DIR: options.configDir,
      },
      stdio: ["pipe", "pipe", "pipe"],
    });

    // Feed prompt via stdin
    this.proc.stdin!.write(prompt);
    this.proc.stdin!.end();

    // Parse NDJSON from stdout
    this.proc.stdout!.on("data", (chunk: Buffer) => {
      this.resetTimeout(options.timeoutMs);
      this.buffer += chunk.toString();
      this.parseBuffer();
    });

    this.proc.stderr!.on("data", (chunk: Buffer) => {
      const text = chunk.toString().trim();
      if (text) console.error(`[Claude stderr] ${text}`);
    });

    this.proc.on("error", (err) => {
      this.cleanup();
      this.emit("error", err);
    });

    this.proc.on("close", (code) => {
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
        this.emit("assistant", parsed as CliAssistantMessage);
      } else if (parsed.type === "result") {
        this.emit("result", parsed as CliResultMessage);
      }
    }
  }
}
