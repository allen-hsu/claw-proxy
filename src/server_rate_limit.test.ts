import assert from "node:assert/strict";
import { incomingAssistantRateLimitCooldownMs, isRateLimit } from "./server.js";

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

console.log("Rate limit detection tests\n");

test("detects canonical rate_limit text", () => {
  assert.equal(isRateLimit("API returned rate_limit error"), true);
});

test("detects hit your limit reset message", () => {
  assert.equal(isRateLimit("You've hit your limit · resets 3am (Asia/Taipei)"), true);
});

test("detects out of extra usage message", () => {
  assert.equal(
    isRateLimit("LLM request rejected: You're out of extra usage. Add more at claude.ai/settings/usage and keep going."),
    true
  );
});

test("does not classify generic auth failures as rate limits", () => {
  assert.equal(isRateLimit("Unauthorized: invalid token"), false);
});

test("detects recent assistant rate limit transcript", () => {
  const cooldownMs = incomingAssistantRateLimitCooldownMs(
    [
      { role: "user", content: "hello" },
      { role: "assistant", content: "You've hit your limit · resets 3:20am (Asia/Taipei)" },
    ],
    Date.UTC(2026, 4, 10, 18, 0)
  );

  assert.equal(cooldownMs, 80 * 60 * 1000);
});

test("ignores older assistant rate limit transcript", () => {
  const cooldownMs = incomingAssistantRateLimitCooldownMs([
    { role: "assistant", content: "You've hit your limit · resets 3:20am (Asia/Taipei)" },
    { role: "user", content: "next" },
    { role: "assistant", content: "ok" },
    { role: "user", content: "next" },
    { role: "assistant", content: "ok" },
  ]);

  assert.equal(cooldownMs, null);
});

console.log("");
