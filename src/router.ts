import type { AccountConfig } from "./config.js";

export interface AccountState {
  account: AccountConfig;
  cooldownUntil: number; // timestamp, 0 = available
  activeRequests: number;
}

/**
 * Account rotator with sticky sessions.
 *
 * First request from a user gets assigned an account (round-robin).
 * Subsequent requests from the same user stick to the same account.
 * If the sticky account is in cooldown, falls back to the next available one.
 */
export class AccountRouter {
  private states: AccountState[];
  private nextIndex = 0;
  /** Maps user/session ID → account name for sticky routing */
  private sticky = new Map<string, string>();

  constructor(accounts: AccountConfig[]) {
    this.states = accounts.map((account) => ({
      account,
      cooldownUntil: 0,
      activeRequests: 0,
    }));
  }

  /** Pick an account for the given user. Sticky if possible, round-robin otherwise. */
  acquire(userId?: string): AccountState | null {
    const now = Date.now();

    // Try sticky account first
    if (userId) {
      const stickyName = this.sticky.get(userId);
      if (stickyName) {
        const state = this.states.find((s) => s.account.name === stickyName);
        if (state && state.cooldownUntil <= now) {
          state.activeRequests++;
          return state;
        }
        // Sticky account in cooldown — fall through to round-robin
      }
    }

    // Round-robin: pick next available
    const len = this.states.length;
    for (let i = 0; i < len; i++) {
      const idx = (this.nextIndex + i) % len;
      const state = this.states[idx];
      if (state.cooldownUntil <= now) {
        this.nextIndex = (idx + 1) % len;
        state.activeRequests++;
        // Bind this user to this account
        if (userId) {
          this.sticky.set(userId, state.account.name);
        }
        return state;
      }
    }

    // All in cooldown — return null, let caller handle (503 or retry later)
    return null;
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
    for (const [userId, name] of this.sticky) {
      if (name === state.account.name) {
        this.sticky.delete(userId);
      }
    }
  }

  status(): Array<{ name: string; active: number; cooldown: boolean; stickyUsers: number }> {
    const now = Date.now();
    return this.states.map((s) => {
      let stickyUsers = 0;
      for (const name of this.sticky.values()) {
        if (name === s.account.name) stickyUsers++;
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
