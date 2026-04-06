import assert from "node:assert/strict";
import type { Request } from "express";
import { resolveSessionKey } from "./server.js";
import type { OpenAIRequest } from "./adapter.js";

function makeRequest(headers: Record<string, string | undefined>, ip = "127.0.0.1"): Request {
  return {
    ip,
    header(name: string) {
      return headers[name.toLowerCase()];
    },
  } as Request;
}

function makeBody(messages: OpenAIRequest["messages"], user?: string): OpenAIRequest {
  return {
    model: "claude-opus-4-6",
    messages,
    user,
  };
}

function test(name: string, fn: () => void) {
  try {
    fn();
    console.log(`  PASS: ${name}`);
  } catch (e: any) {
    console.error(`  FAIL: ${name}`);
    console.error(`    ${e.message}`);
    process.exitCode = 1;
  }
}

console.log("Session key tests\n");

test("prefers body.user when provided", () => {
  const key = resolveSessionKey(
    makeRequest({ "x-session-id": "header-123" }, "10.0.0.1"),
    makeBody([{ role: "user", content: "Hello" }], "chat-123")
  );
  assert.equal(key, "user:chat-123");
});

test("uses session header before IP fallback", () => {
  const key = resolveSessionKey(
    makeRequest({ "x-session-id": "sess-abc" }, "10.0.0.1"),
    makeBody([{ role: "user", content: "Hello" }])
  );
  assert.equal(key, "header:x-session-id:sess-abc");
});

test("same conversation on same IP gets stable fallback key", () => {
  const req = makeRequest({}, "10.0.0.1");
  const body = makeBody([
    { role: "system", content: "You are helpful." },
    { role: "user", content: "Please review this repo." },
    { role: "assistant", content: "Sure." },
  ]);

  const key1 = resolveSessionKey(req, body);
  const key2 = resolveSessionKey(req, body);
  assert.equal(key1, key2);
});

test("different conversations on same IP get different fallback keys", () => {
  const req = makeRequest({}, "10.0.0.1");
  const key1 = resolveSessionKey(req, makeBody([{ role: "user", content: "Conversation A" }]));
  const key2 = resolveSessionKey(req, makeBody([{ role: "user", content: "Conversation B" }]));
  assert.notEqual(key1, key2);
});

console.log("");
