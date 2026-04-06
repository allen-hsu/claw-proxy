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

  // --- New tests from code review ---

  await test("multiple waiters after invalidation — only one holds lock at a time", async () => {
    const sm = new SessionManager();
    const h1 = await sm.acquireSession("user1");

    // Queue two waiters
    const p2 = sm.acquireSession("user1");
    const p3 = sm.acquireSession("user1");

    // Invalidate — wakes both waiters
    sm.invalidateSession("user1");

    // First waiter gets the lock
    const h2 = await p2;
    assert.equal(h2.session.busy, true);

    // Second waiter should still be waiting (session is busy)
    let h3Resolved = false;
    p3.then(() => { h3Resolved = true; });
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(h3Resolved, false, "Third waiter should not have resolved while second holds lock");

    // Release h2 — h3 should wake up
    h2.release();
    const h3 = await p3;
    assert.equal(h3.session.busy, true);
    h3.release();
  });

  await test("cleanup skips busy sessions", async () => {
    const sm = new SessionManager();

    // Create two sessions
    const h1 = await sm.acquireSession("user1");
    h1.release();
    const h2 = await sm.acquireSession("user2");
    // user2 session is still busy (not released)

    // Access via status to verify both exist
    assert.equal(sm.status().active, 2);

    // Wait a bit so sessions age past maxAge
    await new Promise((r) => setTimeout(r, 15));

    // Cleanup with maxAge=5ms should only delete idle sessions
    const result = sm.cleanup(5);
    assert.equal(result.deleted, 1, "Should delete only the idle session");
    assert.equal(result.remaining, 1, "Busy session should remain");

    // The remaining session should be user2's
    const status = sm.status();
    assert.equal(status.users.length, 1);
    assert.equal(status.users[0], "user2");

    h2.release();
  });

  await test("updateSession maps and unmaps tool call IDs", async () => {
    const sm = new SessionManager();
    const h1 = await sm.acquireSession("user1");

    // Update with some tool call IDs
    sm.updateSession("user1", ["tc1", "tc2"], 3);

    // Should be able to look up by tool call ID
    const found1 = sm.getSessionByToolCallId("tc1");
    assert.ok(found1, "tc1 should map to a session");
    assert.equal(found1!.sessionId, h1.session.sessionId);

    const found2 = sm.getSessionByToolCallId("tc2");
    assert.ok(found2, "tc2 should map to a session");

    // Update again with new IDs — old ones should be unmapped
    sm.updateSession("user1", ["tc3"], 5);

    const oldLookup = sm.getSessionByToolCallId("tc1");
    assert.equal(oldLookup, null, "tc1 should be unmapped after update");

    const newLookup = sm.getSessionByToolCallId("tc3");
    assert.ok(newLookup, "tc3 should map to a session");
    assert.equal(newLookup!.sessionId, h1.session.sessionId);

    h1.release();
  });

  await test("getSessionByToolCallId returns null for unknown IDs", async () => {
    const sm = new SessionManager();
    const result = sm.getSessionByToolCallId("nonexistent");
    assert.equal(result, null);
  });

  console.log("");
}

run();
