import assert from "node:assert/strict";
import { getResumeDecision } from "./server.js";
import type { SessionEntry } from "./session.js";
import type { OpenAIMessage } from "./adapter.js";

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

function makeSession(overrides: Partial<SessionEntry> = {}): SessionEntry {
  return {
    sessionId: "123e4567-e89b-12d3-a456-426614174000",
    accountName: "acct1",
    toolCallIds: new Set(),
    lastMessageCount: 0,
    messageSnapshot: [],
    createdAt: Date.now(),
    lastUsedAt: Date.now(),
    busy: false,
    queue: [],
    ...overrides,
  };
}

console.log("Resume decision tests\n");

test("returns new_session when session is not resumable", () => {
  const decision = getResumeDecision(
    makeSession(),
    [{ role: "user", content: "Hello" }],
    false,
    false
  );
  assert.equal(decision, "new_session");
});

test("returns account_changed before prefix checks", () => {
  const decision = getResumeDecision(
    makeSession({ messageSnapshot: ['{"role":"user","content":"Hello"}'] }),
    [{ role: "user", content: "Hello" }, { role: "assistant", content: "Hi" }],
    true,
    true
  );
  assert.equal(decision, "account_changed");
});

test("returns prefix_mismatch when transcript changed", () => {
  const session = makeSession({
    messageSnapshot: ['{"content":"Hello","role":"user"}'],
  });
  const messages: OpenAIMessage[] = [
    { role: "user", content: "Changed" },
    { role: "assistant", content: "Hi" },
  ];
  assert.equal(getResumeDecision(session, messages, false, true), "prefix_mismatch");
});

test("returns no_growth when transcript is unchanged", () => {
  const messages: OpenAIMessage[] = [{ role: "user", content: "Hello" }];
  const session = makeSession({
    messageSnapshot: ['{"content":"Hello","role":"user"}'],
  });
  assert.equal(getResumeDecision(session, messages, false, true), "no_growth");
});

test("returns resumed for append-only transcript growth", () => {
  const messages: OpenAIMessage[] = [
    { role: "user", content: "Hello" },
    { role: "assistant", content: "Hi" },
  ];
  const session = makeSession({
    messageSnapshot: ['{"content":"Hello","role":"user"}'],
  });
  assert.equal(getResumeDecision(session, messages, false, true), "resumed");
});

console.log("");
