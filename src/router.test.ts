import assert from "node:assert/strict";
import { AccountRouter } from "./router.js";

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

console.log("Router tests\n");

test("unavailableInfo reports empty when no accounts exist", () => {
  const router = new AccountRouter([]);
  assert.deepEqual(router.unavailableInfo(), { reason: "empty", retryAfterMs: 0 });
});

test("unavailableInfo reports cooldown with retry delay when all accounts are limited", () => {
  const router = new AccountRouter([
    { name: "a1", oauthToken: "t1" },
    { name: "a2", oauthToken: "t2" },
  ]);

  const a1 = router.acquire("u1");
  assert.ok(a1);
  router.cooldown(a1!, 10_000);

  const a2 = router.acquire("u2");
  assert.ok(a2);
  router.cooldown(a2!, 5_000);

  const info = router.unavailableInfo();
  assert.equal(info.reason, "cooldown");
  assert.ok(info.retryAfterMs > 0);
  assert.ok(info.retryAfterMs <= 5_000);
});

console.log("");
