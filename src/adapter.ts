import { v4 as uuid } from "uuid";
import type { CliResultMessage } from "./subprocess.js";

// --- Request: OpenAI -> Claude CLI prompt ---

export interface OpenAIMessage {
  role: "system" | "developer" | "user" | "assistant" | "tool";
  content: string | Array<{ type: string; text?: string }> | null;
  tool_calls?: Array<{
    id: string;
    type: "function";
    function: { name: string; arguments: string };
  }>;
  tool_call_id?: string;
  name?: string;
}

export interface OpenAIToolDef {
  type: "function";
  function: {
    name: string;
    description?: string;
    parameters?: object;
  };
}

export interface OpenAIRequest {
  model: string;
  messages: OpenAIMessage[];
  tools?: OpenAIToolDef[];
  stream?: boolean;
  temperature?: number;
  max_tokens?: number;
  user?: string;
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

// --- Gateway-internal tools that should not be listed ---
const GATEWAY_BLOCKED = new Set(["sessions_send", "sessions_spawn", "gateway"]);

export function buildToolInstructions(tools: OpenAIToolDef[]): string {
  if (!tools || tools.length === 0) return "";

  const lines = [
    "",
    "---",
    "",
    "## Tool Calling Protocol",
    "",
    "When you need to use a tool, output EXACTLY this format and then STOP:",
    "",
    "<tool_call>",
    '{"name": "tool_name", "arguments": {"key": "value"}}',
    "</tool_call>",
    "",
    "You may request multiple tools at once:",
    "",
    "<tool_call>",
    '{"name": "web_search", "arguments": {"query": "bitcoin price"}}',
    "</tool_call>",
    "<tool_call>",
    '{"name": "memory_search", "arguments": {"query": "user preferences"}}',
    "</tool_call>",
    "",
    "CRITICAL RULES:",
    "- Do NOT execute tools yourself. Do NOT use Bash, Read, Write, Edit, WebSearch, WebFetch, Glob, Grep, or any native tools.",
    "- Output <tool_call> blocks and STOP. The orchestrator will execute them and provide results.",
    "- If you do not need any tools, just respond with your answer directly.",
    "- The conversation may already contain tool results from previous turns — use them, do not re-request.",
    "",
    "Available tools:",
  ];

  for (const tool of tools) {
    const name = tool.function?.name;
    if (!name || GATEWAY_BLOCKED.has(name)) continue;
    const desc = tool.function?.description || "";
    lines.push(`- **${name}**: ${desc}`);
  }

  return lines.join("\n");
}

export function messagesToPrompt(
  messages: OpenAIMessage[],
  tools?: OpenAIToolDef[]
): string {
  const systemParts: string[] = [];
  const conversationParts: string[] = [];

  for (const msg of messages) {
    const text = extractText(msg.content);

    switch (msg.role) {
      case "system":
      case "developer":
        if (text) systemParts.push(text);
        break;
      case "user":
        if (text) conversationParts.push(`User: ${text}`);
        break;
      case "assistant": {
        const parts: string[] = [];
        if (text) parts.push(text);
        // Include tool_calls so Claude sees what was previously requested
        if (Array.isArray(msg.tool_calls)) {
          for (const tc of msg.tool_calls) {
            const fn = tc.function;
            parts.push(
              `<tool_call>\n{"name": "${fn.name}", "arguments": ${fn.arguments || "{}"}}\n</tool_call>`
            );
          }
        }
        if (parts.length > 0) {
          conversationParts.push(
            `<previous_response>\n${parts.join("\n")}\n</previous_response>`
          );
        }
        break;
      }
      case "tool": {
        const toolName = msg.name || "";
        const toolId = msg.tool_call_id || "";
        if (text) {
          conversationParts.push(
            `<tool_result name="${toolName}" tool_call_id="${toolId}">\n${text}\n</tool_result>`
          );
        }
        break;
      }
    }
  }

  // Build system prompt with tool instructions
  const toolInstructions = buildToolInstructions(tools ?? []);
  const systemPrompt = systemParts.join("\n\n") + toolInstructions;

  const allParts: string[] = [];
  if (systemPrompt) {
    allParts.push(`<system>\n${systemPrompt}\n</system>`);
  }
  allParts.push(...conversationParts);

  return allParts.join("\n\n");
}

// --- Extract new messages for --resume mode ---

/**
 * Extract only new messages since the last session update.
 * Used with --resume to avoid re-sending the full conversation history.
 */
export function extractNewMessages(
  messages: OpenAIMessage[],
  lastMessageCount: number
): string {
  const newMessages = messages.slice(lastMessageCount);
  if (newMessages.length === 0) return "";

  const parts: string[] = [];

  for (const msg of newMessages) {
    const text = extractText(msg.content);

    switch (msg.role) {
      case "user":
        if (text) parts.push(`User: ${text}`);
        break;
      case "assistant": {
        const aParts: string[] = [];
        if (text) aParts.push(text);
        if (Array.isArray(msg.tool_calls)) {
          for (const tc of msg.tool_calls) {
            const fn = tc.function;
            aParts.push(
              `<tool_call>\n{"name": "${fn.name}", "arguments": ${fn.arguments || "{}"}}\n</tool_call>`
            );
          }
        }
        if (aParts.length > 0) {
          parts.push(
            `<previous_response>\n${aParts.join("\n")}\n</previous_response>`
          );
        }
        break;
      }
      case "tool": {
        const toolName = msg.name || "";
        const toolId = msg.tool_call_id || "";
        if (text) {
          parts.push(
            `<tool_result name="${toolName}" tool_call_id="${toolId}">\n${text}\n</tool_result>`
          );
        }
        break;
      }
      // Skip system/developer — session already has them
    }
  }

  return parts.join("\n\n");
}

// --- Parse <tool_call> blocks from Claude's response ---

export interface ParsedToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export function parseToolCalls(text: string): {
  cleanText: string;
  toolCalls: ParsedToolCall[];
} {
  const regex = /<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/g;
  const toolCalls: ParsedToolCall[] = [];
  let match: RegExpExecArray | null;

  while ((match = regex.exec(text)) !== null) {
    try {
      const parsed = JSON.parse(match[1]);
      toolCalls.push({
        id: `call_${uuid().replace(/-/g, "").slice(0, 24)}`,
        type: "function",
        function: {
          name: parsed.name,
          arguments:
            typeof parsed.arguments === "string"
              ? parsed.arguments
              : JSON.stringify(parsed.arguments ?? {}),
        },
      });
    } catch {
      // skip malformed tool calls
    }
  }

  const cleanText = text.replace(/<tool_call>[\s\S]*?<\/tool_call>/g, "").trim();

  return { cleanText, toolCalls };
}

// --- Response: Claude CLI -> OpenAI format ---

export function makeRequestId(): string {
  return uuid().replace(/-/g, "").slice(0, 24);
}

export function streamChunk(
  requestId: string,
  model: string,
  content: string | null,
  finishReason: "stop" | "tool_calls" | null = null,
  isFirst = false,
  toolCalls?: ParsedToolCall[]
): string {
  const delta: Record<string, unknown> = {};
  if (isFirst) delta.role = "assistant";
  if (content !== null) delta.content = content;
  if (toolCalls?.length) {
    delta.tool_calls = toolCalls.map((tc, i) => ({
      index: i,
      id: tc.id,
      type: "function",
      function: { name: tc.function.name, arguments: tc.function.arguments },
    }));
  }

  const chunk = {
    id: `chatcmpl-${requestId}`,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [
      {
        index: 0,
        delta,
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
  const { cleanText, toolCalls } = parseToolCalls(result.result ?? "");
  const finishReason = toolCalls.length > 0 ? "tool_calls" : "stop";

  const message: Record<string, unknown> = {
    role: "assistant",
    content: cleanText || (toolCalls.length > 0 ? null : ""),
  };
  if (toolCalls.length > 0) {
    message.tool_calls = toolCalls;
  }

  return {
    id: `chatcmpl-${requestId}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [
      {
        index: 0,
        message,
        finish_reason: finishReason,
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
