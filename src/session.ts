import { v4 as uuid } from "uuid";
import fs from "fs";
import path from "path";
import os from "os";

export interface SessionEntry {
  sessionId: string;
  accountName: string;
  toolCallIds: Set<string>;
  lastMessageCount: number;
  createdAt: number;
  lastUsedAt: number;
  /** Whether a claude process is currently using this session */
  busy: boolean;
  /** Queued requests waiting for this session to become free */
  queue: Array<{ resolve: () => void }>;
}

/**
 * Manages Claude CLI sessions for prompt caching.
 * Sessions are bound to accounts — if the account changes, the session is invalidated.
 */
export class SessionManager {
  private sessionsByUser = new Map<string, SessionEntry>();
  private toolCallIdToUser = new Map<string, string>();

  /** Get an existing session for this user, or null if none/invalid. */
  getSession(userId: string, accountName: string): SessionEntry | null {
    const session = this.sessionsByUser.get(userId);
    if (!session) return null;

    // Session must be on the same account
    if (session.accountName !== accountName) {
      this.invalidateSession(userId);
      return null;
    }

    return session;
  }

  /** Look up a session by tool_call_id (for tool loop continuations). */
  getSessionByToolCallId(toolCallId: string): SessionEntry | null {
    const userId = this.toolCallIdToUser.get(toolCallId);
    if (!userId) return null;
    return this.sessionsByUser.get(userId) ?? null;
  }

  /** Create a new session bound to an account. */
  createSession(userId: string, accountName: string): SessionEntry {
    // Clean up old session if any
    this.invalidateSession(userId);

    const session: SessionEntry = {
      sessionId: uuid(),
      accountName,
      toolCallIds: new Set(),
      lastMessageCount: 0,
      createdAt: Date.now(),
      lastUsedAt: Date.now(),
      busy: false,
      queue: [],
    };

    this.sessionsByUser.set(userId, session);
    return session;
  }

  /**
   * Lock a session before spawning a claude process.
   * If the session is busy, waits in queue until it's free.
   */
  async lock(userId: string): Promise<void> {
    const session = this.sessionsByUser.get(userId);
    if (!session) return;

    if (!session.busy) {
      session.busy = true;
      return;
    }

    // Session is busy — wait in queue
    await new Promise<void>((resolve) => {
      session.queue.push({ resolve });
    });
    session.busy = true;
  }

  /**
   * Unlock a session after the claude process finishes.
   * Wakes up the next queued request if any.
   */
  unlock(userId: string): void {
    const session = this.sessionsByUser.get(userId);
    if (!session) return;

    const next = session.queue.shift();
    if (next) {
      // Hand off to next waiter (keep busy=true)
      next.resolve();
    } else {
      session.busy = false;
    }
  }

  /** Update session after a successful response. */
  updateSession(
    userId: string,
    toolCallIds: string[],
    messageCount: number
  ): void {
    const session = this.sessionsByUser.get(userId);
    if (!session) return;

    // Clear old tool_call_id mappings
    for (const oldId of session.toolCallIds) {
      this.toolCallIdToUser.delete(oldId);
    }

    // Set new tool_call_id mappings
    session.toolCallIds = new Set(toolCallIds);
    for (const id of toolCallIds) {
      this.toolCallIdToUser.set(id, userId);
    }

    session.lastMessageCount = messageCount;
    session.lastUsedAt = Date.now();
  }

  /** Invalidate and remove a session. Wakes queued waiters (they'll create new sessions). */
  invalidateSession(userId: string): void {
    const session = this.sessionsByUser.get(userId);
    if (!session) return;

    // Clean up tool_call_id mappings
    for (const id of session.toolCallIds) {
      this.toolCallIdToUser.delete(id);
    }

    // Wake all queued waiters — they'll find no session and create a new one
    for (const waiter of session.queue) {
      waiter.resolve();
    }

    this.sessionsByUser.delete(userId);
  }

  /** Clean up old sessions. */
  cleanup(maxAgeMs: number): { deleted: number; remaining: number } {
    const now = Date.now();
    let deleted = 0;

    for (const [userId, session] of this.sessionsByUser) {
      if (now - session.lastUsedAt > maxAgeMs) {
        this.invalidateSession(userId);
        deleted++;
      }
    }

    return { deleted, remaining: this.sessionsByUser.size };
  }

  /** Get status for health endpoint. */
  status(): { active: number; users: string[] } {
    return {
      active: this.sessionsByUser.size,
      users: Array.from(this.sessionsByUser.keys()),
    };
  }
}
