import assert from "node:assert/strict";
import type { Request } from "express";
import { identityAllowsResume, inspectSessionIdentity, resolveSessionKey } from "./server.js";
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

test("falls back when only header is provided", () => {
  const key = resolveSessionKey(
    makeRequest({ "x-openclaw-session-key": "agent:main:chat:123" }, "10.0.0.1"),
    makeBody([{ role: "user", content: "Hello" }], "agent-123")
  );
  assert.match(key, /^ip:10\.0\.0\.1:fp:[a-f0-9]{16}$/);
});

test("falls back when only body.user is provided", () => {
  const key = resolveSessionKey(
    makeRequest({ "x-session-id": "header-123" }, "10.0.0.1"),
    makeBody([{ role: "user", content: "Hello" }], "chat-123")
  );
  assert.match(key, /^ip:10\.0\.0\.1:fp:[a-f0-9]{16}$/);
});

test("uses metadata key when conversation metadata is present", () => {
  const key = resolveSessionKey(
    makeRequest({ "x-session-id": "sess-abc" }, "127.0.0.1"),
    makeBody([
      { role: "system", content: "**Name:** helper-bot" },
      {
        role: "user",
        content:
          'Conversation info (untrusted metadata):\n```json\n{"conversation_label":"dm:allen","sender_id":"123"}\n```',
      },
    ])
  );
  assert.equal(key, "meta:dm:allen::agent:helper-bot");
});

test("falls back even when body.user is present if metadata is absent", () => {
  const key = resolveSessionKey(
    makeRequest({}, "10.0.0.1"),
    makeBody([{ role: "user", content: "Hello" }], "chat-123")
  );
  assert.match(key, /^ip:10\.0\.0\.1:fp:[a-f0-9]{16}$/);
});

test("different fallback conversations still get different keys", () => {
  const req = makeRequest({}, "10.0.0.1");
  const key1 = resolveSessionKey(req, makeBody([{ role: "user", content: "Conversation A" }], "agent-123"));
  const key2 = resolveSessionKey(req, makeBody([{ role: "user", content: "Conversation B" }], "agent-123"));
  assert.notEqual(key1, key2);
});

test("prefers conversation metadata over body.user when present", () => {
  const key = resolveSessionKey(
    makeRequest({}, "127.0.0.1"),
    makeBody([
      { role: "system", content: "**Name:** helper-bot" },
      {
        role: "user",
        content:
          'Conversation info (untrusted metadata):\n```json\n{"conversation_label":"dm:allen","sender_id":"123"}\n```',
      },
    ], "agent-123")
  );
  assert.equal(key, "meta:dm:allen::agent:helper-bot");
});

test("uses unknown agent when metadata exists but name is missing", () => {
  const key = resolveSessionKey(
    makeRequest({}, "127.0.0.1"),
    makeBody([
      {
        role: "user",
        content:
          'Conversation info (untrusted metadata):\n```json\n{"conversation_label":"dm:allen","sender_id":"123"}\n```',
      },
    ])
  );
  assert.equal(key, "meta:dm:allen::agent:unknown");
});

test("metadata key stays stable even when later assistant content changes", () => {
  const req = makeRequest({}, "127.0.0.1");
  const base = [
    { role: "system", content: "**Name:** helper-bot" },
    {
      role: "user",
      content:
        'Conversation info (untrusted metadata):\n```json\n{"conversation_label":"dm:allen","sender_id":"123"}\n```',
    },
  ] as OpenAIRequest["messages"];

  const key1 = resolveSessionKey(req, makeBody(base));
  const key2 = resolveSessionKey(
    req,
    makeBody([...base, { role: "assistant", content: "NO_REPLY" }, { role: "user", content: "next turn" }])
  );
  assert.equal(key1, key2);
});

test("identity inspection reports fallback source details", () => {
  const identity = inspectSessionIdentity(
    makeRequest({}, "10.0.0.9"),
    makeBody([{ role: "user", content: "Conversation A" }])
  );
  assert.equal(identity.source, "fallback");
  assert.match(identity.detail, /ip=10\.0\.0\.9 fingerprint=/);
});

test("identity inspection reports metadata source details", () => {
  const identity = inspectSessionIdentity(
    makeRequest({}, "127.0.0.1"),
    makeBody([
      { role: "developer", content: "**Name:** helper-bot" },
      {
        role: "user",
        content:
          'Conversation info (untrusted metadata):\n```json\n{"conversation_label":"dm:allen","sender_id":"123"}\n```',
      },
    ])
  );
  assert.equal(identity.source, "metadata");
  assert.match(identity.detail, /conversation_label=dm:allen/);
});

test("resume is disabled for explicit session headers without metadata", () => {
  const identity = inspectSessionIdentity(
    makeRequest({ "x-openclaw-session-key": "agent:main:chat:123" }, "10.0.0.1"),
    makeBody([{ role: "user", content: "Hello" }], "agent-123")
  );
  assert.equal(identityAllowsResume(identity), false);
});

test("resume is disabled for body.user identities without metadata", () => {
  const identity = inspectSessionIdentity(
    makeRequest({}, "10.0.0.1"),
    makeBody([{ role: "user", content: "Hello" }], "agent-123")
  );
  assert.equal(identityAllowsResume(identity), false);
});

test("resume is allowed for metadata identities", () => {
  const identity = inspectSessionIdentity(
    makeRequest({}, "127.0.0.1"),
    makeBody([
      { role: "system", content: "**Name:** helper-bot" },
      {
        role: "user",
        content:
          'Conversation info (untrusted metadata):\n```json\n{"conversation_label":"dm:allen","sender_id":"123"}\n```',
      },
    ])
  );
  assert.equal(identityAllowsResume(identity), true);
});

test("resume stays disabled for fallback identities", () => {
  const identity = inspectSessionIdentity(
    makeRequest({}, "10.0.0.1"),
    makeBody([{ role: "user", content: "Hello" }])
  );
  assert.equal(identityAllowsResume(identity), false);
});

test("resume is allowed for localhost fallback identities", () => {
  const identity = inspectSessionIdentity(
    makeRequest({}, "127.0.0.1"),
    makeBody([{ role: "user", content: "Hello" }])
  );
  assert.equal(identityAllowsResume(identity), true);
});

test("resume is allowed for ipv6 localhost fallback identities", () => {
  const identity = inspectSessionIdentity(
    makeRequest({}, "::1"),
    makeBody([{ role: "user", content: "Hello" }])
  );
  assert.equal(identityAllowsResume(identity), true);
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
