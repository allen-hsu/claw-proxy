import { v4 as uuid } from "uuid";
import type { CliResultMessage } from "./subprocess.js";

// --- Request: OpenAI -> Claude CLI prompt ---

export interface OpenAIMessage {
  role: "system" | "developer" | "user" | "assistant";
  content: string | Array<{ type: string; text?: string }> | null;
}

export interface OpenAIRequest {
  model: string;
  messages: OpenAIMessage[];
  stream?: boolean;
  temperature?: number;
  max_tokens?: number;
}

const MODEL_MAP: Record<string, string> = {
  "claude-opus-4": "opus",
  "claude-opus-4-6": "claude-opus-4-6",
  "claude-sonnet-4": "sonnet",
  "claude-sonnet-4-5": "claude-sonnet-4-5",
  "claude-sonnet-4-6": "claude-sonnet-4-6",
  "claude-haiku-4": "haiku",
  "claude-haiku-4-5": "claude-haiku-4-5",
  // Allow with openai/ prefix (common in clients)
  "openai/claude-opus-4": "opus",
  "openai/claude-sonnet-4": "sonnet",
  "openai/claude-haiku-4": "haiku",
};

export function resolveModel(model: string, defaultModel: string): string {
  return MODEL_MAP[model] ?? defaultModel;
}

function extractText(content: OpenAIMessage["content"]): string {
  if (typeof content === "string") return content;
  if (!content) return "";
  return content
    .filter((p) => p.type === "text" && p.text)
    .map((p) => p.text!)
    .join("\n");
}

export function messagesToPrompt(messages: OpenAIMessage[]): string {
  const parts: string[] = [];

  for (const msg of messages) {
    const text = extractText(msg.content);
    if (!text) continue;

    switch (msg.role) {
      case "system":
      case "developer":
        parts.push(`<system>\n${text}\n</system>`);
        break;
      case "user":
        parts.push(text);
        break;
      case "assistant":
        parts.push(`<previous_response>\n${text}\n</previous_response>`);
        break;
    }
  }

  return parts.join("\n\n");
}

// --- Response: Claude CLI -> OpenAI format ---

export function makeRequestId(): string {
  return uuid().replace(/-/g, "").slice(0, 24);
}

export function streamChunk(
  requestId: string,
  model: string,
  content: string | null,
  finishReason: "stop" | null = null,
  isFirst = false
): string {
  const chunk = {
    id: `chatcmpl-${requestId}`,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [
      {
        index: 0,
        delta: {
          ...(isFirst ? { role: "assistant" as const } : {}),
          ...(content !== null ? { content } : {}),
        },
        finish_reason: finishReason,
      },
    ],
  };
  return `data: ${JSON.stringify(chunk)}\n\n`;
}

export function completionResponse(
  requestId: string,
  model: string,
  result: CliResultMessage
): object {
  return {
    id: `chatcmpl-${requestId}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [
      {
        index: 0,
        message: { role: "assistant", content: result.result ?? "" },
        finish_reason: "stop",
      },
    ],
    usage: {
      prompt_tokens: result.usage?.input_tokens ?? 0,
      completion_tokens: result.usage?.output_tokens ?? 0,
      total_tokens:
        (result.usage?.input_tokens ?? 0) +
        (result.usage?.output_tokens ?? 0),
    },
  };
}
