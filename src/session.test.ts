import assert from "node:assert/strict";
import { SessionManager, type SessionHandle } from "./session.js";

async function test(name: string, fn: () => Promise<void>) {
  try {
    await fn();
    console.log(`  PASS: ${name}`);
  } catch (e: any) {
    console.error(`  FAIL: ${name}`);
    console.error(`    ${e.message}`);
    process.exitCode = 1;
  }
}

async function run() {
  console.log("SessionManager tests\n");

  await test("acquireSession creates new session on first call", async () => {
    const sm = new SessionManager();
    const h = await sm.acquireSession("user1");
    assert.ok(h.session.sessionId);
    assert.equal(h.isResume, false);
    assert.equal(h.session.busy, true);
    h.release();
  });

  await test("acquireSession returns isResume=true after update", async () => {
    const sm = new SessionManager();
    const h1 = await sm.acquireSession("user1");
    h1.session.accountName = "acct1";
    sm.updateSession("user1", ["tc1"], 5);
    h1.release();

    const h2 = await sm.acquireSession("user1");
    assert.equal(h2.isResume, true);
    assert.equal(h2.session.sessionId, h1.session.sessionId);
    h2.release();
  });

  await test("acquireSession queues when busy", async () => {
    const sm = new SessionManager();
    const h1 = await sm.acquireSession("user1");

    let h2Resolved = false;
    const h2Promise = sm.acquireSession("user1").then((h) => {
      h2Resolved = true;
      return h;
    });

    // h2 should be waiting
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(h2Resolved, false);

    // Release h1 — h2 should wake up
    h1.release();
    const h2 = await h2Promise;
    assert.equal(h2Resolved, true);
    assert.equal(h2.session.sessionId, h1.session.sessionId);
    h2.release();
  });

  await test("release is one-shot (safe to call twice)", async () => {
    const sm = new SessionManager();
    const h1 = await sm.acquireSession("user1");

    // Queue two waiters
    const p2 = sm.acquireSession("user1");
    const p3 = sm.acquireSession("user1");

    // Double release should only wake one
    h1.release();
    h1.release(); // no-op

    const h2 = await p2;
    // h3 should still be waiting
    let h3Resolved = false;
    p3.then(() => { h3Resolved = true; });
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(h3Resolved, false);

    h2.release();
    const h3 = await p3;
    h3.release();
  });

  await test("invalidateSession wakes all waiters with fresh sessions", async () => {
    const sm = new SessionManager();
    const h1 = await sm.acquireSession("user1");
    const originalId = h1.session.sessionId;

    const p2 = sm.acquireSession("user1");

    // Invalidate — should wake p2
    sm.invalidateSession("user1");
    const h2 = await p2;

    // h2 should have a different session ID
    assert.notEqual(h2.session.sessionId, originalId);
    assert.equal(h2.isResume, false);
    h2.release();
  });

  await test("concurrent first requests serialize correctly", async () => {
    const sm = new SessionManager();

    // First acquire gets the session immediately
    const h1 = await sm.acquireSession("user1");

    // Second acquire queues — verify it gets same session after release
    let h2: SessionHandle | null = null;
    const p2 = sm.acquireSession("user1").then((h) => { h2 = h; return h; });

    await new Promise((r) => setTimeout(r, 10));
    assert.equal(h2, null); // still waiting

    h1.release();
    await p2;

    assert.notEqual(h2, null);
    const h2Val = h2 as unknown as SessionHandle;
    assert.equal(h2Val.session.sessionId, h1.session.sessionId);
    h2Val.release();
  });

  console.log("");
}

run();
