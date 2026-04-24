import type { MessageSnapshot } from "./adapter.js";
import { v4 as uuid } from "uuid";

export interface SessionEntry {
  sessionId: string;
  accountName: string;
  identitySource?: "user" | "header" | "metadata" | "fallback";
  allowResume?: boolean;
  toolCallIds: Set<string>;
  lastMessageCount: number;
  messageSnapshot: MessageSnapshot;
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
        identitySource: undefined,
        allowResume: undefined,
        toolCallIds: new Set(),
        lastMessageCount: 0,
        messageSnapshot: [],
        createdAt: Date.now(),
        lastUsedAt: Date.now(),
        busy: true,
        queue: [],
      };
      this.sessionsByUser.set(userId, session);
      isResume = false;
      console.log(`[Sessions] acquire new key=${userId} session=${session.sessionId.slice(0, 8)} queue=0`);
    } else if (!session.busy) {
      // Session exists and is free — lock it
      session.busy = true;
      isResume = session.lastMessageCount > 0;
      console.log(
        `[Sessions] acquire existing key=${userId} session=${session.sessionId.slice(0, 8)} resume=${isResume ? "yes" : "no"} queue=${session.queue.length}`
      );
    } else {
      // Session is busy — wait in queue
      console.log(
        `[Sessions] acquire queued key=${userId} session=${session.sessionId.slice(0, 8)} queue_before=${session.queue.length}`
      );
      await new Promise<void>((resolve) => {
        session!.queue.push({ resolve });
      });
      // Re-fetch and check — if busy, re-queue (loop)
      while (true) {
        session = this.sessionsByUser.get(userId);
        if (!session) {
          // Was invalidated — create fresh
          session = {
            sessionId: uuid(),
            accountName: "",
            identitySource: undefined,
            allowResume: undefined,
            toolCallIds: new Set(),
            lastMessageCount: 0,
            messageSnapshot: [],
            createdAt: Date.now(),
            lastUsedAt: Date.now(),
            busy: true,
            queue: [],
          };
          this.sessionsByUser.set(userId, session);
          isResume = false;
          console.log(`[Sessions] acquire recreated key=${userId} session=${session.sessionId.slice(0, 8)} after_invalidate`);
          break;
        } else if (!session.busy) {
          session.busy = true;
          isResume = session.lastMessageCount > 0;
          console.log(
            `[Sessions] acquire wake key=${userId} session=${session.sessionId.slice(0, 8)} resume=${isResume ? "yes" : "no"} queue=${session.queue.length}`
          );
          break;
        } else {
          // Still busy — re-queue
          console.log(
            `[Sessions] acquire requeue key=${userId} session=${session.sessionId.slice(0, 8)} queue_before=${session.queue.length}`
          );
          await new Promise<void>((resolve) => {
            session!.queue.push({ resolve });
          });
        }
      }
    }

    session.lastUsedAt = Date.now();

    // One-shot release to prevent double-unlock
    let released = false;
    const capturedSession = session;
    const release = () => {
      if (released) return;
      released = true;
      capturedSession.busy = false;
      console.log(
        `[Sessions] release key=${userId} session=${capturedSession.sessionId.slice(0, 8)} next_queue=${capturedSession.queue.length}`
      );
      const next = capturedSession.queue.shift();
      if (next) {
        // Wake next waiter — it will set busy=true in the acquire loop
        next.resolve();
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
    messageCount: number,
    messageSnapshot: MessageSnapshot
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
    session.messageSnapshot = [...messageSnapshot];
    session.lastUsedAt = Date.now();
    console.log(
      `[Sessions] update key=${userId} session=${session.sessionId.slice(0, 8)} messages=${messageCount} tool_calls=${toolCallIds.length} snapshot_len=${messageSnapshot.length}`
    );
  }

  updateMetadata(
    userId: string,
    metadata: { identitySource: "user" | "header" | "metadata" | "fallback"; allowResume: boolean }
  ): void {
    const session = this.sessionsByUser.get(userId);
    if (!session) return;
    session.identitySource = metadata.identitySource;
    session.allowResume = metadata.allowResume;
    session.lastUsedAt = Date.now();
    console.log(
      `[Sessions] metadata key=${userId} session=${session.sessionId.slice(0, 8)} identity=${metadata.identitySource} allow_resume=${metadata.allowResume ? "on" : "off"} account=${session.accountName || "(unset)"}`
    );
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
    console.log(
      `[Sessions] invalidate key=${userId} session=${session.sessionId.slice(0, 8)} waiters=${waiters.length} tool_calls=${session.toolCallIds.size}`
    );
    for (const waiter of waiters) {
      waiter.resolve();
    }
  }

  /** Clean up old sessions (only idle ones). */
  cleanup(maxAgeMs: number): { deleted: number; remaining: number } {
    const now = Date.now();
    const toDelete: string[] = [];

    for (const [userId, session] of this.sessionsByUser) {
      if (!session.busy && now - session.lastUsedAt > maxAgeMs) {
        toDelete.push(userId);
      }
    }

    for (const userId of toDelete) {
      this.invalidateSession(userId);
    }

    return { deleted: toDelete.length, remaining: this.sessionsByUser.size };
  }

  /** Get status for health endpoint. */
  status(): {
    active: number;
    users: string[];
    entries: Array<{
      key: string;
      sessionId: string;
      busy: boolean;
      accountName: string;
      identitySource?: "user" | "header" | "metadata" | "fallback";
      allowResume?: boolean;
      lastUsedAt: number;
    }>;
  } {
    return {
      active: this.sessionsByUser.size,
      users: Array.from(this.sessionsByUser.keys()),
      entries: Array.from(this.sessionsByUser.entries()).map(([key, session]) => ({
        key,
        sessionId: session.sessionId,
        busy: session.busy,
        accountName: session.accountName,
        identitySource: session.identitySource,
        allowResume: session.allowResume,
        lastUsedAt: session.lastUsedAt,
      })),
    };
  }
}
