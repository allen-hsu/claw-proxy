import { v4 as uuid } from "uuid";

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

export interface SessionHandle {
  session: SessionEntry;
  isResume: boolean;
  /** Call exactly once when the claude process finishes (success, error, or disconnect). */
  release: () => void;
}

/**
 * Manages Claude CLI sessions with built-in locking.
 *
 * acquireSession() is the single entry point:
 * - Creates a session if none exists for the user
 * - Waits in queue if the session is busy
 * - Returns a handle with a one-shot release()
 */
export class SessionManager {
  private sessionsByUser = new Map<string, SessionEntry>();
  private toolCallIdToUser = new Map<string, string>();

  /**
   * Acquire exclusive access to a session for this user.
   * Creates a new session if none exists. Waits if the session is busy.
   * Returns a handle with session info and a one-shot release().
   */
  async acquireSession(userId: string): Promise<SessionHandle> {
    let session = this.sessionsByUser.get(userId);
    let isResume = false;

    if (!session) {
      // Create new session — automatically locked (busy=true)
      session = {
        sessionId: uuid(),
        accountName: "",
        toolCallIds: new Set(),
        lastMessageCount: 0,
        createdAt: Date.now(),
        lastUsedAt: Date.now(),
        busy: true,
        queue: [],
      };
      this.sessionsByUser.set(userId, session);
      isResume = false;
    } else if (!session.busy) {
      // Session exists and is free — lock it
      session.busy = true;
      isResume = session.lastMessageCount > 0;
    } else {
      // Session is busy — wait in queue
      await new Promise<void>((resolve) => {
        session!.queue.push({ resolve });
      });
      // Re-fetch session — it may have been invalidated while we waited
      session = this.sessionsByUser.get(userId);
      if (!session) {
        // Was invalidated — create fresh
        session = {
          sessionId: uuid(),
          accountName: "",
          toolCallIds: new Set(),
          lastMessageCount: 0,
          createdAt: Date.now(),
          lastUsedAt: Date.now(),
          busy: true,
          queue: [],
        };
        this.sessionsByUser.set(userId, session);
        isResume = false;
      } else {
        session.busy = true;
        isResume = session.lastMessageCount > 0;
      }
    }

    session.lastUsedAt = Date.now();

    // One-shot release to prevent double-unlock
    let released = false;
    const capturedSession = session;
    const release = () => {
      if (released) return;
      released = true;
      const next = capturedSession.queue.shift();
      if (next) {
        // Hand off to next waiter (keep busy=true)
        next.resolve();
      } else {
        capturedSession.busy = false;
      }
    };

    return { session, isResume, release };
  }

  /** Look up a session by tool_call_id (for tool loop continuations). */
  getSessionByToolCallId(toolCallId: string): SessionEntry | null {
    const userId = this.toolCallIdToUser.get(toolCallId);
    if (!userId) return null;
    return this.sessionsByUser.get(userId) ?? null;
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

    // Wake all queued waiters — they'll find no session in acquireSession and create new
    const waiters = session.queue.splice(0);
    this.sessionsByUser.delete(userId);
    for (const waiter of waiters) {
      waiter.resolve();
    }
  }

  /** Clean up old sessions (only idle ones). */
  cleanup(maxAgeMs: number): { deleted: number; remaining: number } {
    const now = Date.now();
    let deleted = 0;

    for (const [userId, session] of this.sessionsByUser) {
      if (!session.busy && now - session.lastUsedAt > maxAgeMs) {
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
