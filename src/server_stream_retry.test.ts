import assert from "node:assert/strict";
import type { Response } from "express";
import { AccountRouter } from "./router.js";
import { beginSse, sendAccountUnavailableResponse } from "./server.js";

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

function makeResponse(): Response & {
  writes: string[];
  ended: boolean;
  statusCode?: number;
  jsonBody?: unknown;
} {
  const res: any = {
    headersSent: false,
    writableEnded: false,
    writes: [],
    ended: false,
    setHeader(name: string, value: string) {
      if (this.headersSent) {
        throw new Error(`headers already sent: ${name}`);
      }
      this[name] = value;
      return this;
    },
    flushHeaders() {
      this.headersSent = true;
    },
    write(chunk: string) {
      this.writes.push(chunk);
      return true;
    },
    end() {
      this.writableEnded = true;
      this.ended = true;
      return this;
    },
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(body: unknown) {
      this.jsonBody = body;
      this.writableEnded = true;
      return this;
    },
  };
  return res as Response & {
    writes: string[];
    ended: boolean;
    statusCode?: number;
    jsonBody?: unknown;
  };
}

console.log("Stream retry response tests\n");

test("beginSse is safe to call after headers were already sent", () => {
  const res = makeResponse();
  beginSse(res);
  assert.equal(res.headersSent, true);

  beginSse(res);
  assert.equal(res.headersSent, true);
});

test("cooldown stream response writes SSE payload even after headers were sent", () => {
  const router = new AccountRouter([{ name: "acct1", oauthToken: "token" }]);
  const account = router.acquire("user-1");
  assert.ok(account);
  router.cooldown(account, 10_000);
  router.release(account);

  const res = makeResponse();
  beginSse(res);

  sendAccountUnavailableResponse(res, router, true);

  assert.equal(res.ended, true);
  assert.equal(res.statusCode, undefined);
  assert.equal(res.writes.length, 2);
  assert.match(res.writes[0], /all_accounts_rate_limited/);
  assert.equal(res.writes[1], "data: [DONE]\n\n");
});

console.log("");
