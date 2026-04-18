import type { AccountConfig } from "./config.js";

export interface AccountState {
  account: AccountConfig;
  cooldownUntil: number; // timestamp, 0 = available
  activeRequests: number;
}

export interface RouterUnavailableInfo {
  reason: "cooldown" | "empty";
  retryAfterMs: number;
}

/**
 * Fill-first account router with sticky sessions.
 *
 * Uses the first available account until it hits rate limits (cooldown),
 * then moves to the next. Maximizes prompt cache reuse per account.
 * Sticky bindings keep the same conversation on the same account.
 */
export class AccountRouter {
  private states: AccountState[];
  /** Maps user/session ID → account name + timestamp for sticky routing */
  private sticky = new Map<string, { name: string; at: number }>();
  private static readonly STICKY_TTL_MS = 30 * 60 * 1000; // 30 minutes
  private static readonly STICKY_MAX_SIZE = 1000;

  constructor(accounts: AccountConfig[]) {
    this.states = accounts.map((account) => ({
      account,
      cooldownUntil: 0,
      activeRequests: 0,
    }));
  }

  /** Pick an account for the given user. Sticky first, then fill-first (not round-robin). */
  acquire(userId?: string): AccountState | null {
    const now = Date.now();

    // Prune expired sticky entries
    this.pruneSticky(now);

    // Try sticky account first
    if (userId) {
      const stickyEntry = this.sticky.get(userId);
      if (stickyEntry) {
        const state = this.states.find((s) => s.account.name === stickyEntry.name);
        if (state && state.cooldownUntil <= now) {
          state.activeRequests++;
          stickyEntry.at = now;
          return state;
        }
        // Sticky account in cooldown — fall through to fill-first
      }
    }

    // Fill-first: always pick the first non-cooldown account
    // Only moves to the next when the current one is rate-limited
    for (const state of this.states) {
      if (state.cooldownUntil <= now) {
        state.activeRequests++;
        if (userId) {
          this.sticky.set(userId, { name: state.account.name, at: now });
        }
        return state;
      }
    }

    // All in cooldown — return null
    return null;
  }

  unavailableInfo(): RouterUnavailableInfo {
    const now = Date.now();

    if (this.states.length === 0) {
      return { reason: "empty", retryAfterMs: 0 };
    }

    const cooldownStates = this.states.filter((state) => state.cooldownUntil > now);
    if (cooldownStates.length === this.states.length) {
      const soonestReadyAt = Math.min(...cooldownStates.map((state) => state.cooldownUntil));
      return {
        reason: "cooldown",
        retryAfterMs: Math.max(0, soonestReadyAt - now),
      };
    }

    return { reason: "empty", retryAfterMs: 0 };
  }

  /** Remove sticky entries older than TTL or enforce max size. */
  private pruneSticky(now: number): void {
    // Remove expired entries
    for (const [userId, entry] of this.sticky) {
      if (now - entry.at > AccountRouter.STICKY_TTL_MS) {
        this.sticky.delete(userId);
      }
    }
    // If still over max size, evict oldest entries
    if (this.sticky.size > AccountRouter.STICKY_MAX_SIZE) {
      const sorted = [...this.sticky.entries()].sort((a, b) => a[1].at - b[1].at);
      const toRemove = sorted.slice(0, this.sticky.size - AccountRouter.STICKY_MAX_SIZE);
      for (const [userId] of toRemove) {
        this.sticky.delete(userId);
      }
    }
  }

  /** Release an account after request completes. */
  release(state: AccountState): void {
    state.activeRequests = Math.max(0, state.activeRequests - 1);
  }

  /** Put an account in cooldown. Clears sticky bindings pointing to it. */
  cooldown(state: AccountState, durationMs: number = 60_000): void {
    state.cooldownUntil = Date.now() + durationMs;
    console.log(
      `[Router] ${state.account.name} cooled down for ${durationMs / 1000}s`
    );

    // Clear sticky bindings so affected users get re-routed
    for (const [userId, entry] of this.sticky) {
      if (entry.name === state.account.name) {
        this.sticky.delete(userId);
      }
    }
  }

  status(): Array<{ name: string; active: number; cooldown: boolean; stickyUsers: number }> {
    const now = Date.now();
    return this.states.map((s) => {
      let stickyUsers = 0;
      for (const entry of this.sticky.values()) {
        if (entry.name === s.account.name) stickyUsers++;
      }
      return {
        name: s.account.name,
        active: s.activeRequests,
        cooldown: s.cooldownUntil > now,
        stickyUsers,
      };
    });
  }
}
